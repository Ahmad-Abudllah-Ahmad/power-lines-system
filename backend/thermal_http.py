"""HTTP handlers for DJI thermal analysis (health, ROI, CSV, batch)."""

import asyncio
import base64
import hashlib
import io
import json
import math
from typing import Any, Optional

import numpy as np
from fastapi import UploadFile, HTTPException
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.responses import Response
from PIL import Image

import thermal_analyzer as ta
import thermal_processor as tp
from thermal_job_store import thermal_jobs, new_thermal_job
from thermal_image_worker import thermal_image_worker


def _init_sdk_if_possible() -> tuple[bool, str]:
    if tp.is_initialized():
        return True, "SDK already initialized."
    return tp.init_sdk()


def _image_to_base64_png(arr: np.ndarray) -> str:
    img = Image.fromarray(arr.astype(np.uint8))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("utf-8")


def _json_safe(value: Any) -> Any:
    """Recursively coerce ROI payloads for json.dumps(..., allow_nan=False) (avoids HTTP 500)."""
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value
    if isinstance(value, np.generic):
        return _json_safe(value.item())
    if isinstance(value, int):
        return int(value)
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {str(k): _json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(v) for v in value]
    return str(value)


def _roi_response_bytes(payload: dict[str, Any]) -> bytes:
    safe = _json_safe(payload)
    return json.dumps(safe, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode("utf-8")


def _sanitize_analysis_response(result: dict) -> dict:
    cleaned = dict(result)
    cleaned.pop("warnings", None)
    dist = cleaned.get("distance_meters")
    if isinstance(dist, dict):
        dist = dict(dist)
        dist.pop("assumptions", None)
        cleaned["distance_meters"] = dist
    return cleaned


async def thermal_health() -> dict:
    sdk_ok, sdk_msg = _init_sdk_if_possible()
    return {"ok": True, "sdk_initialized": sdk_ok, "sdk_message": sdk_msg}


async def analyze_image(
    image: UploadFile,
    object_type: Optional[str] = None,
    real_world_size_meters: Optional[float] = None,
    object_pixel_size: Optional[float] = None,
) -> JSONResponse:
    image_bytes = await image.read()
    if not image_bytes:
        raise HTTPException(status_code=400, detail="Empty image upload.")

    sdk_ok, _ = _init_sdk_if_possible()
    object_info = {
        "object_type": object_type or None,
        "real_world_size_meters": real_world_size_meters,
        "object_pixel_size": object_pixel_size,
    }
    result = ta.analyze(
        image_bytes,
        object_info=object_info,
        thermal_data_available=sdk_ok,
    )
    return JSONResponse(_sanitize_analysis_response(result))


async def roi_stats(
    image: UploadFile,
    x1: int, y1: int, x2: int, y2: int,
    unit: str = "Celsius",
) -> JSONResponse:
    image_bytes = await image.read()
    if not image_bytes:
        raise HTTPException(status_code=400, detail="Empty image upload.")

    sdk_ok, sdk_msg = _init_sdk_if_possible()
    if not sdk_ok:
        raise HTTPException(status_code=503, detail=f"DJI SDK unavailable: {sdk_msg}")

    try:
        temp_map_c = tp.extract_temperature_map(image_bytes, dtype="float32")
        temp_map = tp.convert_temp_map(temp_map_c, unit)
        h, w = temp_map.shape
        if x1 < 0 or y1 < 0 or x2 > w or y2 > h or x2 <= x1 or y2 <= y1:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Invalid ROI coordinates (thermal map {w}x{h}, "
                    f"got x1={x1}, y1={y1}, x2={x2}, y2={y2})."
                ),
            )
        stats = tp.get_roi_stats(temp_map, x1, y1, x2, y2)
        payload = {
            "unit": unit,
            "roi": {"x1": x1, "y1": y1, "x2": x2, "y2": y2},
            "stats": stats,
        }
        return Response(content=_roi_response_bytes(payload), media_type="application/json")
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Processing error: {str(e)}") from e


async def export_csv(image: UploadFile, unit: str = "Celsius") -> StreamingResponse:
    import csv
    from io import StringIO

    image_bytes = await image.read()
    if not image_bytes:
        raise HTTPException(status_code=400, detail="Empty image upload.")

    sdk_ok, sdk_msg = _init_sdk_if_possible()
    if not sdk_ok:
        raise HTTPException(status_code=503, detail=f"DJI SDK unavailable: {sdk_msg}")

    temp_map_c = tp.extract_temperature_map(image_bytes, dtype="float32")
    temp_map = tp.convert_temp_map(temp_map_c, unit)
    h, w = temp_map.shape
    col_name = f"temp_{unit.lower()}"
    sb = StringIO()
    writer = csv.writer(sb)
    writer.writerow(["row", "col", col_name])
    for i in range(h):
        for j in range(w):
            writer.writerow([i, j, float(temp_map[i, j])])
    csv_bytes = sb.getvalue().encode("utf-8")
    filename = f"{(image.filename or 'thermal').rsplit('.', 1)[0]}_temperatures.csv"
    return StreamingResponse(
        io.BytesIO(csv_bytes),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


async def start_thermal_batch(payload: dict) -> dict:
    total = payload.get("total", 0)
    if total <= 0:
        raise HTTPException(400, "total must be > 0")

    palette = int(payload.get("palette", 2))
    unit = payload.get("unit", "Celsius")
    object_type = payload.get("object_type") or None

    job = new_thermal_job(total, palette, unit, object_type)
    asyncio.create_task(thermal_image_worker(job["job_id"]))

    return {"job_id": job["job_id"]}


async def upload_thermal_file(job_id: str, file: UploadFile, client_key: str = "") -> dict:
    import uuid as uuid_mod

    job = thermal_jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Thermal job not found")

    file_id = uuid_mod.uuid4().hex[:10]
    fname = file.filename or f"thermal_{file_id}.jpg"
    img_bytes = await file.read()
    sha256 = hashlib.sha256(img_bytes).hexdigest() if img_bytes else ""
    ck = (client_key or "").strip()[:128] or None

    job["files"][file_id] = {
        "filename": fname,
        "status": "pending",
        "bytes": img_bytes,
        "client_key": ck,
        "sha256": sha256,
    }
    job["total"] = max(job["total"], len(job["files"]))

    if job["status"] == "complete":
        job["status"] = "active"
        asyncio.create_task(thermal_image_worker(job["job_id"]))

    return {"file_id": file_id, "status": "queued", "filename": fname, "client_key": ck or "", "sha256": sha256}


async def get_thermal_results(job_id: str, include_base64: bool = False) -> dict:
    job = thermal_jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Thermal job not found")

    results_by = job.get("results_by_file_id") or {}
    order = job.get("result_order") or []
    results = [results_by[fid] for fid in order if fid in results_by]
    if not results and results_by:
        for fid in job.get("files") or {}:
            if fid in results_by:
                results.append(results_by[fid])
    if not include_base64:
        results = [{**dict(r), "thermal_image_base64_png": None} for r in results]

    file_statuses: dict[str, dict] = {}
    for fid, fdata in (job.get("files") or {}).items():
        file_statuses[fid] = {
            "status": fdata.get("status", ""),
            "filename": fdata.get("filename", ""),
            "client_key": fdata.get("client_key") or "",
            "sha256": fdata.get("sha256") or "",
            **({"error": fdata.get("error")} if fdata.get("error") else {}),
        }

    return {
        "job_id": job_id,
        "status": job["status"],
        "total": job["total"],
        "completed": job["completed"],
        "palette": job.get("palette", 2),
        "unit": job.get("unit", "Celsius"),
        "object_type": job.get("object_type"),
        "results": results,
        "file_statuses": file_statuses,
    }
