"""Thermal batch worker — uses Socket.IO from detection server."""

import asyncio
import base64
import io
import time
from pathlib import Path

import numpy as np
from PIL import Image

import thermal_analyzer as ta
import thermal_processor as tp
from thermal_job_store import thermal_jobs

_sio = None
_RESULTS_DIR: Path | None = None


def configure_thermal_worker(sio, results_dir: Path) -> None:
    global _sio, _RESULTS_DIR
    _sio = sio
    _RESULTS_DIR = results_dir


def _image_to_base64_png(arr: np.ndarray) -> str:
    img = Image.fromarray(arr.astype(np.uint8))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("utf-8")


def _sanitize_analysis(result: dict) -> dict:
    cleaned = dict(result)
    cleaned.pop("warnings", None)
    dist = cleaned.get("distance_meters")
    if isinstance(dist, dict):
        dist = dict(dist)
        dist.pop("assumptions", None)
        cleaned["distance_meters"] = dist
    return cleaned


def process_thermal_file(
    job_id: str, file_id: str, img_bytes: bytes, filename: str,
    palette: int, unit: str, object_type: str | None,
    client_key: str | None,
    loop: asyncio.AbstractEventLoop,
) -> dict:
    t0 = time.time()

    sdk_ok, _ = tp.init_sdk() if not tp.is_initialized() else (True, "ok")

    if _sio is not None:
        asyncio.run_coroutine_threadsafe(
            _sio.emit(
                "thermal_start",
                {
                    "job_id": job_id,
                    "file_id": file_id,
                    "filename": filename,
                    "client_key": ("" if client_key is None else str(client_key).strip()),
                },
            ),
            loop,
        )

    object_info = {"object_type": object_type} if object_type else {}
    analysis = _sanitize_analysis(
        ta.analyze(img_bytes, object_info=object_info, thermal_data_available=sdk_ok)
    )

    thermal_image_b64 = None
    stats = None
    thermal_image_url = None
    thermal_rjpeg_url = None

    # Persist original R-JPEG bytes so /api/thermal/roi can use the same radiometric file as analysis.
    if _RESULTS_DIR is not None:
        job_dir = _RESULTS_DIR / job_id
        job_dir.mkdir(parents=True, exist_ok=True)
        rjpeg_path = job_dir / f"{file_id}_rjpeg.jpg"
        rjpeg_path.write_bytes(img_bytes)
        thermal_rjpeg_url = f"/results/{job_id}/{file_id}_rjpeg.jpg"

    if sdk_ok:
        try:
            temp_map_c = tp.extract_temperature_map(img_bytes, dtype="float32")
            thermal_rgb = tp.render_thermal_image(img_bytes, palette=palette)
            temp_map = tp.convert_temp_map(temp_map_c, unit)
            stats = tp.get_temperature_stats(temp_map)
            thermal_image_b64 = _image_to_base64_png(thermal_rgb)

            if _RESULTS_DIR is not None:
                job_dir = _RESULTS_DIR / job_id
                viz_path = job_dir / f"{file_id}_thermal.png"
                Image.fromarray(thermal_rgb.astype(np.uint8)).save(str(viz_path))
                thermal_image_url = f"/results/{job_id}/{file_id}_thermal.png"
        except Exception as exc:
            analysis["sdk_error"] = str(exc)

    elapsed_ms = (time.time() - t0) * 1000

    ck_str = "" if client_key is None else str(client_key).strip()
    return {
        "file_id": file_id,
        "filename": filename,
        "client_key": ck_str,
        "thermal_image_base64_png": thermal_image_b64,
        "thermal_image_url": thermal_image_url,
        "thermal_rjpeg_url": thermal_rjpeg_url,
        "stats": stats,
        "analysis": analysis,
        "unit": unit,
        "processing_time_ms": round(elapsed_ms),
    }


async def thermal_image_worker(job_id: str) -> None:
    job = thermal_jobs.get(job_id)
    if not job:
        return

    loop = asyncio.get_event_loop()

    while True:
        pending_file = None
        for fid, fdata in job["files"].items():
            if fdata["status"] == "pending":
                fdata["status"] = "processing"
                pending_file = (fid, fdata)
                break

        if pending_file is None:
            all_finished = (
                len(job["files"]) >= job["total"]
                and all(f["status"] in ("done", "error") for f in job["files"].values())
            )
            if all_finished:
                break
            await asyncio.sleep(0.3)
            if time.time() - job["created_at"] > 600:
                break
            continue

        fid, fdata = pending_file
        try:
            result = await loop.run_in_executor(
                None,
                process_thermal_file,
                job_id,
                fid,
                fdata["bytes"],
                fdata["filename"],
                job["palette"],
                job["unit"],
                job.get("object_type"),
                fdata.get("client_key"),
                loop,
            )

            fdata["status"] = "done"
            job["results"].append(result)
            job["completed"] += 1

            if _sio is not None:
                await _sio.emit("thermal_result", {
                    "job_id": job_id,
                    **result,
                    "completed": job["completed"],
                    "total": job["total"],
                })

            fdata.pop("bytes", None)

        except Exception as e:
            fdata["status"] = "error"
            job["completed"] += 1
            if _sio is not None:
                await _sio.emit("thermal_result", {
                    "job_id": job_id,
                    "file_id": fid,
                    "filename": fdata["filename"],
                    "client_key": ("" if fdata.get("client_key") is None else str(fdata.get("client_key")).strip()),
                    "error": str(e),
                    "completed": job["completed"],
                    "total": job["total"],
                })

    job["status"] = "complete"
    if _sio is not None:
        await _sio.emit("thermal_batch_complete", {
            "job_id": job_id,
            "total_files": len(job["results"]),
        })
