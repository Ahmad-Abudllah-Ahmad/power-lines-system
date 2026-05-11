"""
Detection backend server (port 8000).
Uses YOLO + SAHI sliced inference with weights under backend/models/.
Provides batch upload, per-image detection, Socket.IO progress, and results.

GPU pipeline: FP16, multi-scale inference (640+1280), batched, CUDA-pinned,
parallel video workers, threaded read/annotate/write architecture.
"""

import asyncio
import io
import json
import os
import sys
import time
import uuid
import threading
import queue
import shutil
import traceback
from pathlib import Path
from typing import Optional

# Sibling modules (thermal_http, thermal_image_worker, …) live in this folder. When the app is
# loaded as `detection_server.server` (e.g. uvicorn from repo root), sys.path may not include
# this directory and `import thermal_http` would fail — thermal routes would never register → 404.
_DETECTION_SERVER_DIR = Path(__file__).resolve().parent
if str(_DETECTION_SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(_DETECTION_SERVER_DIR))

from thermal_job_store import thermal_jobs as _thermal_jobs_dict
from map_geo import azerbaijan_dot_from_id
from image_gps import apply_batch_map_gps_to_job, exif_gps_from_bytes, file_gps_for_job

from concurrent.futures import ThreadPoolExecutor

import cv2
import numpy as np
from PIL import Image
from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Body
from fastapi.responses import FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
import socketio
import uvicorn

# ---------------------------------------------------------------------------
# Paths & constants
# ---------------------------------------------------------------------------
# Local mirror of RunPod training output (canonical pod path documented in description).
_DOTA_WEIGHTS_FILE = (
    _DETECTION_SERVER_DIR
    / "models"
    / "yolo11x_obb_dota_20260426_060214"
    / "weights"
    / "best.pt"
)

AVAILABLE_MODELS: dict[str, dict] = {
    "dota_1000ep_best": {
        "id": "dota_1000ep_best",
        "title": "DOTA 1000ep · YOLO11x OBB (RunPod H200)",
        "path": str(_DOTA_WEIGHTS_FILE),
        "description": (
            "Pod weights path: /workspace/project/runs/obb/yolo11x_obb_dota_20260426_060214/weights/best.pt"
        ),
    },
}

WEIGHTS_PATH = Path(AVAILABLE_MODELS["dota_1000ep_best"]["path"])
RESULTS_DIR = Path(__file__).parent / "results"
RESULTS_DIR.mkdir(exist_ok=True)

# HTTP listen port (override when 8000 is already in use, e.g. `set PORT=8001`)
SERVER_PORT = int(os.environ.get("PORT", "8001"))

GPU_BATCH = 32          # frames per YOLO batch on CUDA (lower if CUDA OOM; uses FP16 when USE_HALF)
READ_AHEAD = 128        # decode-ahead queue so GPU batches stay full during video
ANNOTATE_THREADS = 4    # CPU threads for drawing bboxes

# ---------------------------------------------------------------------------
# GPU detection & CUDA setup
# ---------------------------------------------------------------------------
def _select_device() -> str:
    import torch
    if torch.cuda.is_available():
        torch.cuda.init()
        name = torch.cuda.get_device_name(0)
        vram = torch.cuda.get_device_properties(0).total_memory / (1024**3)
        print(f"[GPU] {name} | {vram:.1f} GB VRAM | CUDA {torch.version.cuda}")
        torch.backends.cudnn.benchmark = True
        torch.backends.cuda.matmul.allow_tf32 = True
        torch.backends.cudnn.allow_tf32 = True
        try:
            torch.set_float32_matmul_precision("high")
        except Exception:
            pass
        return "0"
    print("[WARN] CUDA not available, using CPU")
    return "cpu"

DEVICE = _select_device()
USE_HALF = DEVICE != "cpu"


def _yolo_predict_kw() -> dict:
    """Extra Ultralytics predict args: FP16 on CUDA (Tensor Cores), no change on CPU."""
    return {"half": True} if USE_HALF else {}


# ---------------------------------------------------------------------------
# Socket.IO
# ---------------------------------------------------------------------------
sio = socketio.AsyncServer(async_mode="asgi", cors_allowed_origins="*")

# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------
app = FastAPI(title="Detection Server")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

socket_app = socketio.ASGIApp(sio, other_asgi_app=app, socketio_path="/socket.io")

import thermal_image_worker as _thermal_image_worker
_thermal_image_worker.configure_thermal_worker(sio, RESULTS_DIR)

import thermal_http as _thermal_http

# ---------------------------------------------------------------------------
# Thread pools
# ---------------------------------------------------------------------------
_annotate_pool = ThreadPoolExecutor(max_workers=ANNOTATE_THREADS, thread_name_prefix="ann")

# ---------------------------------------------------------------------------
# Model (lazy-loaded, switchable, pinned to GPU, warmed up)
# ---------------------------------------------------------------------------
_model = None
_model_lock = threading.Lock()
_model_path: str = str(WEIGHTS_PATH)
_sahi_det_model = None
_sahi_lock = threading.Lock()


def _load_model(weights_path: str):
    """Load a YOLO model, pin to GPU, and warmup."""
    from ultralytics import YOLO
    import torch
    print(f"[INFO] Loading YOLO model from {weights_path} ...")
    model = YOLO(weights_path)
    if DEVICE != "cpu":
        dev = torch.device(f"cuda:{DEVICE}")
        model.to(dev)
        dummy = [np.zeros((640, 640, 3), dtype=np.uint8)] * 4
        model.predict(dummy, imgsz=640, device=DEVICE, verbose=False, **_yolo_predict_kw())
        torch.cuda.synchronize()
        vram_used = torch.cuda.memory_allocated(0) / (1024**3)
        print(f"[GPU] Model pinned + warmed up | VRAM: {vram_used:.2f} GB")
    print(f"[INFO] Model loaded. {len(model.names)} classes")
    return model


def get_model():
    global _model
    if _model is None:
        with _model_lock:
            if _model is None:
                _model = _load_model(_model_path)
    return _model


def switch_model(model_id: str):
    """Switch the active YOLO model. Clears caches so next call loads the new weights."""
    global _model, _sahi_det_model, _model_path, WEIGHTS_PATH
    info = AVAILABLE_MODELS.get(model_id)
    if not info:
        raise ValueError(f"Unknown model: {model_id}")
    with _model_lock:
        with _sahi_lock:
            _model_path = info["path"]
            WEIGHTS_PATH = Path(_model_path)
            if _model is not None:
                del _model
            _model = None
            _sahi_det_model = None
            if DEVICE != "cpu":
                import torch
                torch.cuda.empty_cache()
    print(f"[INFO] Switched active model to {model_id} ({info['title']})")


def get_sahi_model(confidence: float = 0.25):
    """Cached SAHI AutoDetectionModel wrapper — avoids re-creating every call."""
    global _sahi_det_model
    sahi_device = f"cuda:{DEVICE}" if DEVICE != "cpu" else "cpu"
    if _sahi_det_model is None or abs(_sahi_det_model._confidence - confidence) > 0.001:
        with _sahi_lock:
            from sahi import AutoDetectionModel
            model = get_model()
            _sahi_det_model = AutoDetectionModel.from_pretrained(
                model_type="ultralytics",
                model=model,
                confidence_threshold=confidence,
                device=sahi_device,
            )
            _sahi_det_model._confidence = confidence
    return _sahi_det_model


# ---------------------------------------------------------------------------
# Job store (in-memory; fine for single-server use)
# ---------------------------------------------------------------------------
jobs: dict[str, dict] = {}


def _new_job(
    total: int,
    confidence: float,
    slice_size: int,
    overlap: float,
    source: str = "rgb",
    full_imgsz: int = 1280,
    nms_iou: float = 0.5,
    sahi_tiled: bool = True,
) -> dict:
    job_id = uuid.uuid4().hex[:12]
    job = {
        "job_id": job_id,
        "total": total,
        "confidence": confidence,
        "slice_size": slice_size,
        "overlap": overlap,
        "full_imgsz": full_imgsz,
        "nms_iou": nms_iou,
        "sahi_tiled": sahi_tiled,
        "source": source,
        "files": {},          # file_id -> {filename, status, ...}
        "results": [],        # finished results
        "completed": 0,
        "status": "active",
        "cancel_requested": False,
        "created_at": time.time(),
        "map_gps": azerbaijan_dot_from_id(job_id),
    }
    jobs[job_id] = job
    return job


def _gps_for_map(job: dict, jid: str) -> dict:
    g = job.get("map_gps")
    if isinstance(g, dict) and g.get("lat") is not None and g.get("lng") is not None:
        return {"lat": float(g["lat"]), "lng": float(g["lng"])}
    return azerbaijan_dot_from_id(jid)


# ---------------------------------------------------------------------------
# Ultralytics result parsing (detect vs OBB)
# ---------------------------------------------------------------------------
def _result_pred(r):
    """Oriented-detection models populate ``r.obb``; standard detection uses ``r.boxes``."""
    obb = getattr(r, "obb", None)
    if obb is not None:
        return obb
    return getattr(r, "boxes", None)


# Bottom-right DJI-style telemetry OSD (red strip / white text) — mask for inference + drop boxes
# centered inside this rect so the model does not false-detect on overlay graphics.
_DJI_OSD_EXCLUDE_WIDTH_FRAC = 0.38
_DJI_OSD_EXCLUDE_HEIGHT_FRAC = 0.16
_YOLO_PAD_BGR = (114, 114, 114)


def _dji_osd_exclusion_xyxy(w: int, h: int) -> tuple[int, int, int, int]:
    """Pixel bbox (x1, y1, x2, y2) inclusive for the bottom-right OSD strip."""
    if w <= 0 or h <= 0:
        return (0, 0, 0, 0)
    x1 = max(0, int(round(w * (1.0 - _DJI_OSD_EXCLUDE_WIDTH_FRAC))))
    y1 = max(0, int(round(h * (1.0 - _DJI_OSD_EXCLUDE_HEIGHT_FRAC))))
    x2, y2 = w - 1, h - 1
    if x2 < x1:
        x2 = x1
    if y2 < y1:
        y2 = y1
    return (x1, y1, x2, y2)


def _prepare_image_for_detection(img: np.ndarray) -> np.ndarray:
    """BGR copy of ``img`` with the bottom-right OSD region filled (YOLO letterbox grey)."""
    out = img.copy()
    h, w = out.shape[:2]
    x1, y1, x2, y2 = _dji_osd_exclusion_xyxy(w, h)
    cv2.rectangle(out, (x1, y1), (x2, y2), _YOLO_PAD_BGR, thickness=-1)
    return out


def _filter_dets_dji_osd_exclusion(dets: list[dict], img_w: int, img_h: int) -> list[dict]:
    """Remove detections whose box center lies inside the bottom-right OSD exclusion zone."""
    if not dets:
        return dets
    ox1, oy1, ox2, oy2 = _dji_osd_exclusion_xyxy(img_w, img_h)
    kept: list[dict] = []
    for d in dets:
        bx1, by1, bx2, by2 = d["bbox"]
        cx = (bx1 + bx2) * 0.5
        cy = (by1 + by2) * 0.5
        if ox1 <= cx <= ox2 and oy1 <= cy <= oy2:
            continue
        kept.append(d)
    return kept


# ---------------------------------------------------------------------------
# SAHI sliced inference
# ---------------------------------------------------------------------------
def run_sahi_detection(
    img: np.ndarray,
    confidence: float = 0.25,
    slice_size: int = 640,
    overlap: float = 0.2,
    job_id: str = "",
    file_id: str = "",
    loop: Optional[asyncio.AbstractEventLoop] = None,
    full_imgsz: int = 1280,
    nms_iou: float = 0.5,
    sahi_tiled: bool = True,
):
    """Run YOLO full-image + optional GPU-batched tiled slices on a single image."""
    model = get_model()

    def _emit_progress(current: int, total_steps: int, pct: int):
        if loop and job_id:
            asyncio.run_coroutine_threadsafe(
                sio.emit("detection_progress", {
                    "job_id": job_id,
                    "file_id": file_id,
                    "current": current,
                    "total_steps": total_steps,
                    "percent": pct,
                }),
                loop,
            )

    total_steps = 2 if sahi_tiled else 1

    infer_img = _prepare_image_for_detection(img)

    # Full-image pass on GPU (FP16 on CUDA via half= — same path as batched video)
    _emit_progress(0, total_steps, 5)
    full_results = model.predict(
        infer_img, conf=confidence, device=DEVICE, imgsz=full_imgsz, verbose=False, **_yolo_predict_kw()
    )
    full_dets = []
    for r in full_results:
        pred = _result_pred(r)
        if pred is None:
            continue
        for box in pred:
            cls_id = int(box.cls[0])
            full_dets.append({
                "bbox": box.xyxy[0].tolist(),
                "confidence": float(box.conf[0]),
                "class_id": cls_id,
                "class_name": model.names.get(cls_id, str(cls_id)),
                "source": "full",
            })
    _emit_progress(1, total_steps, 40 if sahi_tiled else 85)

    sahi_dets: list[dict] = []
    if sahi_tiled:
        # GPU-batched sliced prediction (all slices sent to GPU in batches instead of one-by-one)
        img_h, img_w = infer_img.shape[:2]
        step_h = max(1, int(slice_size * (1 - overlap)))
        step_w = max(1, int(slice_size * (1 - overlap)))

        slices: list[np.ndarray] = []
        offsets: list[tuple[int, int]] = []
        for y in range(0, img_h, step_h):
            for x in range(0, img_w, step_w):
                y2 = min(y + slice_size, img_h)
                x2 = min(x + slice_size, img_w)
                slices.append(infer_img[y:y2, x:x2])
                offsets.append((x, y))

        for b_start in range(0, len(slices), GPU_BATCH):
            b_slices = slices[b_start : b_start + GPU_BATCH]
            b_offsets = offsets[b_start : b_start + GPU_BATCH]
            results = model.predict(
                b_slices, conf=confidence, device=DEVICE,
                imgsz=slice_size, verbose=False, **_yolo_predict_kw(),
            )
            for r, (x_off, y_off) in zip(results, b_offsets):
                pred = _result_pred(r)
                if pred is None:
                    continue
                for box in pred:
                    cls_id = int(box.cls[0])
                    bx1, by1, bx2, by2 = box.xyxy[0].tolist()
                    sahi_dets.append({
                        "bbox": [bx1 + x_off, by1 + y_off, bx2 + x_off, by2 + y_off],
                        "confidence": float(box.conf[0]),
                        "class_id": cls_id,
                        "class_name": model.names.get(cls_id, str(cls_id)),
                        "source": "sahi",
                    })

        _emit_progress(2, total_steps, 85)

    all_dets = full_dets + sahi_dets
    if len(all_dets) > 0:
        all_dets = _nms_merge(all_dets, iou_threshold=nms_iou)

    ih, iw = img.shape[:2]
    all_dets = _filter_dets_dji_osd_exclusion(all_dets, iw, ih)

    return all_dets


def _nms_merge(dets: list[dict], iou_threshold: float = 0.5) -> list[dict]:
    """Simple NMS merge across detections from different sources."""
    if not dets:
        return dets

    boxes = np.array([d["bbox"] for d in dets], dtype=np.float32)
    scores = np.array([d["confidence"] for d in dets], dtype=np.float32)

    indices = cv2.dnn.NMSBoxes(
        bboxes=[[b[0], b[1], b[2] - b[0], b[3] - b[1]] for b in boxes],
        scores=scores.tolist(),
        score_threshold=0.01,
        nms_threshold=iou_threshold,
    )
    if len(indices) == 0:
        return []
    keep = indices.flatten().tolist()
    return [dets[i] for i in keep]


# ---------------------------------------------------------------------------
# Annotate image with bounding boxes (in-place for video speed)
# ---------------------------------------------------------------------------
COLORS = [
    (0, 255, 255), (255, 0, 255), (0, 255, 0), (255, 255, 0),
    (255, 128, 0), (128, 0, 255), (0, 128, 255), (255, 0, 128),
]

_BBOX_SIZE_FILTER_EXEMPT = frozenset(
    ("vegetation_encroachment", "tower_structural_corrosion", "simple_corrosion", "breakage_of_angle_braces", "bird_nest")
)

# Mirrors frontend SIDEBAR_COMPONENT_CLASS_KEYS — these draw GREEN; everything else draws RED.
_COMPONENT_CLASS_KEYS = frozenset((
    "insulator",
    "foundation_pedestal",
    "bolted_connection",
    "conductor",
    "vibration_damper",
    "suspension_clamp",
    "yoke_plate",
    "transmission_corridor",
    "angle_brace",
    "cross_arm",
    "two_glass",
))
_COMPONENT_BGR = (0, 255, 0)
_DEFECT_BGR = (0, 0, 255)


def annotate_image(img: np.ndarray, dets: list[dict], copy: bool = True) -> np.ndarray:
    """Draw bounding boxes. Set copy=False for video frames (faster, in-place)."""
    canvas = img.copy() if copy else img
    font_scale = 0.5 if copy else 0.7
    font_thickness = 1 if copy else 2
    model = get_model()
    names = getattr(model, "names", None) or {}

    def _visual_cls_key(det: dict) -> str:
        """True YOLO class (video may remap ``class_name`` only; ``class_id`` stays)."""
        try:
            cid = int(det.get("class_id", -1))
            if cid >= 0 and isinstance(names, dict):
                raw = names.get(cid)
                if raw is None:
                    raw = names.get(str(cid))
                if raw is not None:
                    return str(raw).strip().lower().replace("-", "_").replace(" ", "_")
        except Exception:
            pass
        return str(det.get("class_name") or "").strip().lower().replace("-", "_").replace(" ", "_")

    foreign_object_count = (
        sum(1 for d in dets if _visual_cls_key(d) == "foreign_object")
        if copy
        else 0
    )
    img_h, img_w = canvas.shape[:2]
    img_area = max(img_w * img_h, 1)
    for det in dets:
        x1, y1, x2, y2 = int(det["bbox"][0]), int(det["bbox"][1]), int(det["bbox"][2]), int(det["bbox"][3])
        class_name = str(det.get("class_name") or "").strip()
        vk = _visual_cls_key(det)
        if vk not in _BBOX_SIZE_FILTER_EXEMPT and copy:
            bw = abs(x2 - x1)
            bh = abs(y2 - y1)
            area_ratio = (bw * bh) / img_area
            if area_ratio > 0.003 and bh < bw * 3:
                continue
        color = _COMPONENT_BGR if vk in _COMPONENT_CLASS_KEYS else _DEFECT_BGR
        cv2.rectangle(canvas, (x1, y1), (x2, y2), color, 2)
        if copy and foreign_object_count > 3 and vk == "foreign_object":
            class_name = "bolt_rust"
        label = class_name or "Defect"
        (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, font_scale, font_thickness)
        label_y1 = max(0, y1 - th - 6)
        label_y2 = max(0, y1)
        cv2.rectangle(canvas, (x1, label_y1), (x1 + tw + 4, label_y2), color, -1)
        cv2.putText(canvas, label, (x1 + 2, max(0, y1 - 4)), cv2.FONT_HERSHEY_SIMPLEX, font_scale, (0, 0, 0), font_thickness)
    return canvas


# ---------------------------------------------------------------------------
# Process a single file (runs in thread pool)
# ---------------------------------------------------------------------------
def process_file(job_id: str, file_id: str, img_bytes: bytes, filename: str,
                 confidence: float, slice_size: int, overlap: float,
                 full_imgsz: int, nms_iou: float, sahi_tiled: bool,
                 loop: asyncio.AbstractEventLoop):
    """Process one image: detect, annotate, save thumb+annotated, return result dict."""
    t0 = time.time()

    # Decode image
    arr = np.frombuffer(img_bytes, np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        return {"file_id": file_id, "filename": filename, "error": "Cannot decode image"}

    # Emit start
    asyncio.run_coroutine_threadsafe(
        sio.emit("detection_start", {"job_id": job_id, "file_id": file_id, "filename": filename}),
        loop,
    )

    # Run detection
    dets = run_sahi_detection(
        img, confidence, slice_size, overlap, job_id, file_id, loop,
        full_imgsz=full_imgsz, nms_iou=nms_iou, sahi_tiled=sahi_tiled,
    )
    for d in dets:
        raw = str(d.get("class_name") or "").strip().lower().replace("-", " ").replace("_", " ")
        if raw == "bolted connection missing nut":
            d["class_name"] = "insulator"

    breakage_count = sum(
        1 for d in dets
        if str(d.get("class_name") or "").strip().lower().replace("-", "_").replace(" ", "_")
        == "breakage_of_angle_braces"
    )
    if breakage_count > 1:
        for d in dets:
            if (str(d.get("class_name") or "").strip().lower().replace("-", "_").replace(" ", "_")
                    == "breakage_of_angle_braces"):
                d["class_name"] = "insulator"

    # Create output dir
    job_dir = RESULTS_DIR / job_id
    job_dir.mkdir(exist_ok=True)

    # Save thumbnail (original resized)
    thumb_path = job_dir / f"{file_id}_thumb.jpg"
    h, w = img.shape[:2]
    scale = min(640 / w, 640 / h, 1.0)
    thumb = cv2.resize(img, (int(w * scale), int(h * scale)))
    cv2.imwrite(str(thumb_path), thumb, [cv2.IMWRITE_JPEG_QUALITY, 85])

    # Save clean full-resolution original (no annotations) for filtered preview
    clean_path = job_dir / f"{file_id}_clean.jpg"
    cv2.imwrite(str(clean_path), img, [cv2.IMWRITE_JPEG_QUALITY, 90])

    # Save annotated
    annotated = annotate_image(img, dets)
    ann_path = job_dir / f"{file_id}_annotated.jpg"
    cv2.imwrite(str(ann_path), annotated, [cv2.IMWRITE_JPEG_QUALITY, 90])

    elapsed_ms = (time.time() - t0) * 1000
    confs = [d["confidence"] for d in dets]

    stats = {
        "total_defects": len(dets),
        "avg_confidence": float(np.mean(confs)) if confs else 0,
        "max_confidence": float(max(confs)) if confs else 0,
        "min_confidence": float(min(confs)) if confs else 0,
        "processing_time_ms": round(elapsed_ms),
    }

    return {
        "file_id": file_id,
        "filename": filename,
        "thumb_url": f"/results/{job_id}/{file_id}_thumb.jpg",
        "annotated_url": f"/results/{job_id}/{file_id}_annotated.jpg",
        "clean_url": f"/results/{job_id}/{file_id}_clean.jpg",
        "image_width": int(w),
        "image_height": int(h),
        "detections": dets,
        "stats": stats,
    }


# ---------------------------------------------------------------------------
# Background worker: processes queued files for a job
# ---------------------------------------------------------------------------
async def _worker(job_id: str):
    """Process files as they arrive for this job."""
    job = jobs.get(job_id)
    if not job:
        return

    loop = asyncio.get_event_loop()

    while True:
        if job.get("cancel_requested"):
            for fid, fdata in job["files"].items():
                if fdata["status"] == "pending":
                    fdata["status"] = "error"
                    fdata["error"] = "Cancelled by user"
                    job["completed"] += 1
                    fdata.pop("bytes", None)
                    await sio.emit("detection_result", {
                        "job_id": job_id,
                        "file_id": fid,
                        "filename": fdata["filename"],
                        "error": "Cancelled by user",
                        "completed": job["completed"],
                        "total": job["total"],
                    })
            break

        # Find next unprocessed file
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
                process_file,
                job_id, fid, fdata["bytes"], fdata["filename"],
                job["confidence"], job["slice_size"], job["overlap"],
                job.get("full_imgsz", 1280),
                job.get("nms_iou", 0.5),
                job.get("sahi_tiled", True),
                loop,
            )

            if "error" in result:
                fdata["status"] = "error"
                fdata["error"] = result["error"]
                job["completed"] += 1
                await sio.emit("detection_result", {
                    "job_id": job_id, "file_id": fid, "filename": fdata["filename"],
                    "error": result["error"], "completed": job["completed"], "total": job["total"],
                })
            else:
                fdata["status"] = "done"
                job["results"].append(result)
                job["completed"] += 1

                await sio.emit("detection_result", {
                    "job_id": job_id,
                    **result,
                    "completed": job["completed"],
                    "total": job["total"],
                })

        except Exception as e:
            fdata["status"] = "error"
            fdata["error"] = str(e)
            job["completed"] += 1
            await sio.emit("detection_result", {
                "job_id": job_id, "file_id": fid, "filename": fdata["filename"],
                "error": str(e), "completed": job["completed"], "total": job["total"],
            })
        finally:
            fdata.pop("bytes", None)

    if job.get("cancel_requested"):
        job["status"] = "cancelled"
        await sio.emit("detection_batch_cancelled", {
            "job_id": job_id,
            "completed": job["completed"],
            "total": job["total"],
        })
    else:
        job["status"] = "complete"
        total_defects = sum(r["stats"]["total_defects"] for r in job["results"])
        await sio.emit("detection_batch_complete", {
            "job_id": job_id,
            "total_files": len(job["results"]),
            "total_defects": total_defects,
        })


# ---------------------------------------------------------------------------
# Socket.IO events
# ---------------------------------------------------------------------------
@sio.event
async def connect(sid, environ):
    pass


@sio.event
async def subscribe_job(sid, data):
    job_id = data.get("job_id", "")
    if job_id:
        await sio.enter_room(sid, job_id)


@sio.event
async def subscribe_thermal_job(sid, data):
    job_id = data.get("job_id", "")
    if job_id:
        await sio.enter_room(sid, job_id)


@sio.event
async def disconnect(sid):
    pass


# ---------------------------------------------------------------------------
# API endpoints
# ---------------------------------------------------------------------------
@app.get("/api/models")
async def list_models():
    """Return available model weights for the frontend dropdown."""
    active_id = None
    for mid, info in AVAILABLE_MODELS.items():
        if info["path"] == _model_path:
            active_id = mid
            break
    return {
        "models": list(AVAILABLE_MODELS.values()),
        "active": active_id,
    }


@app.get("/api/detection/class_names")
async def detection_class_names():
    """YOLO class labels for UI filters (order matches class_id)."""
    try:
        model = get_model()
        names = getattr(model, "names", None)
        if isinstance(names, dict):
            return {"class_names": [str(v) for v in names.values()]}
        if isinstance(names, (list, tuple)):
            return {"class_names": [str(x) for x in names]}
    except Exception:
        pass
    return {"class_names": []}


@app.post("/api/models/active")
async def set_active_model(payload: dict):
    """Switch the active detection model."""
    model_id = payload.get("model_id", "")
    if model_id not in AVAILABLE_MODELS:
        raise HTTPException(400, f"Unknown model_id: {model_id}")
    switch_model(model_id)
    threading.Thread(target=get_model, daemon=True).start()
    return {"active": model_id, "title": AVAILABLE_MODELS[model_id]["title"]}


@app.post("/api/uploads/batch/start")
async def batch_start(payload: dict):
    total = payload.get("total", 0)
    if total <= 0:
        raise HTTPException(400, "total must be > 0")

    model_id = payload.get("model_id")
    if model_id and model_id in AVAILABLE_MODELS and AVAILABLE_MODELS[model_id]["path"] != _model_path:
        switch_model(model_id)

    confidence = float(payload.get("det_confidence", 0.25))
    slice_size = int(payload.get("det_slice_size", 1280))
    overlap = float(payload.get("det_overlap", 0.25))
    full_imgsz = int(payload.get("det_full_imgsz", 1280))
    nms_iou = float(payload.get("det_nms_iou", 0.5))
    sahi_tiled = bool(payload.get("det_sahi_tiled", True))
    source = payload.get("source", "rgb")

    job = _new_job(
        total, confidence, slice_size, overlap, source=source,
        full_imgsz=full_imgsz, nms_iou=nms_iou, sahi_tiled=sahi_tiled,
    )

    threading.Thread(target=get_model, daemon=True).start()

    # Start worker
    asyncio.create_task(_worker(job["job_id"]))

    return {"job_id": job["job_id"]}


@app.post("/api/uploads/batch/cancel/{job_id}")
async def cancel_batch(job_id: str):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    if job["status"] in ("complete", "cancelled"):
        return {"job_id": job_id, "status": job["status"]}
    job["cancel_requested"] = True
    job["status"] = "cancelling"
    return {"job_id": job_id, "status": "cancelling"}


@app.post("/api/uploads/file")
async def upload_file(job_id: str = Form(...), file: UploadFile = File(...)):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    if job.get("cancel_requested") or job.get("status") == "cancelled":
        raise HTTPException(409, "Job was cancelled")

    file_id = uuid.uuid4().hex[:10]
    img_bytes = await file.read()

    gps_meta = exif_gps_from_bytes(img_bytes)
    job["files"][file_id] = {
        "filename": file.filename or f"image_{file_id}.jpg",
        "status": "pending",
        "bytes": img_bytes,
        "gps": file_gps_for_job(gps_meta),
    }
    apply_batch_map_gps_to_job(job)
    # Auto-expand total when user adds more images to a running job
    job["total"] = max(job["total"], len(job["files"]))

    # Restart worker if job was already marked complete
    if job["status"] == "complete":
        job["status"] = "active"
        asyncio.create_task(_worker(job["job_id"]))

    await sio.emit("detection_queued", {
        "job_id": job_id,
        "file_id": file_id,
        "filename": file.filename,
    })

    return {"file_id": file_id, "status": "queued"}


@app.get("/api/detection/results/{job_id}")
async def get_results(job_id: str):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found")

    file_statuses = {}
    for fid, fdata in job["files"].items():
        if fdata["status"] == "error":
            file_statuses[fid] = {
                "status": "error",
                "filename": fdata.get("filename", ""),
                "error": fdata.get("error", "Processing failed"),
            }

    return {
        "job_id": job_id,
        "status": job["status"],
        "total": job["total"],
        "completed": job["completed"],
        "results": job["results"],
        "file_statuses": file_statuses,
    }


@app.get("/results/{job_id}/{filename}")
async def serve_result_file(job_id: str, filename: str):
    fpath = RESULTS_DIR / job_id / filename
    if not fpath.exists():
        raise HTTPException(404, "File not found")
    media = (
        "application/json" if filename.endswith(".json")
        else "image/jpeg" if filename.endswith(".jpg")
        else "video/mp4" if filename.endswith(".mp4")
        else "application/octet-stream"
    )
    return FileResponse(str(fpath), media_type=media)


# ---------------------------------------------------------------------------
# Video processing — whole-video pipeline
# ---------------------------------------------------------------------------
video_jobs: dict[str, dict] = {}


def _get_ffmpeg_exe() -> str:
    """Get ffmpeg binary path from imageio_ffmpeg."""
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return "ffmpeg"


def _reencode_to_h264(src: str, dst: str, fps: float) -> bool:
    """Re-encode mp4v to H.264 for browser playback. Try NVENC first, fallback to libx264."""
    import subprocess
    ffmpeg = _get_ffmpeg_exe()
    for encoder in ("h264_nvenc", "libx264"):
        cmd = [
            ffmpeg, "-y", "-i", src,
            "-c:v", encoder, "-preset", "fast",
            "-movflags", "+faststart",
            "-pix_fmt", "yuv420p",
            "-r", str(round(fps)),
            dst,
        ]
        try:
            r = subprocess.run(cmd, capture_output=True, timeout=600)
            if r.returncode == 0 and os.path.exists(dst) and os.path.getsize(dst) > 0:
                print(f"[INFO] Re-encoded with {encoder}")
                return True
        except Exception:
            continue
    return False


_VIDEO_LABEL_REMAP = {
    "bolted_connection_missing_nut": "insulator",
    "bolted connection missing nut": "insulator",
    "foreign_object": "bolt_rust",
    "foreign object": "bolt_rust",
}

def _remap_video_labels(per_frame: list[list[dict]]) -> None:
    """In-place rename class labels for video detections only."""
    for dets in per_frame:
        for d in dets:
            raw = str(d.get("class_name") or "").strip()
            mapped = _VIDEO_LABEL_REMAP.get(raw) or _VIDEO_LABEL_REMAP.get(raw.lower().replace("-", "_"))
            if mapped:
                d["class_name"] = mapped

def _open_video_capture(path: str) -> cv2.VideoCapture:
    """Open video with hardware-accelerated decode (NVDEC / D3D11VA / DXVA) when available."""
    _hw_prop = getattr(cv2, "CAP_PROP_HW_ACCELERATION", None)
    _hw_any = getattr(cv2, "VIDEO_ACCELERATION_ANY", None)
    if _hw_prop is not None and _hw_any is not None:
        try:
            cap = cv2.VideoCapture(path, cv2.CAP_FFMPEG, [int(_hw_prop), int(_hw_any)])
            if cap.isOpened():
                return cap
        except Exception:
            pass
    return cv2.VideoCapture(path)


def _batch_detect(
    model, frames: list[np.ndarray], confidence: float, imgsz: int = 1280
) -> list[list[dict]]:
    """Run YOLO on a batch of frames (single GPU call)."""
    infer_frames = [_prepare_image_for_detection(f) for f in frames]
    results = model.predict(
        infer_frames, conf=confidence, device=DEVICE,
        imgsz=imgsz, verbose=False, **_yolo_predict_kw(),
    )
    per_frame: list[list[dict]] = []
    for r, fr in zip(results, frames):
        dets = []
        pred = _result_pred(r)
        if pred is not None:
            for box in pred:
                cls_id = int(box.cls[0])
                dets.append({
                    "bbox": box.xyxy[0].tolist(),
                    "confidence": float(box.conf[0]),
                    "class_id": cls_id,
                    "class_name": model.names.get(cls_id, str(cls_id)),
                })
        fh, fw = fr.shape[:2]
        per_frame.append(_filter_dets_dji_osd_exclusion(dets, fw, fh))
    return per_frame


def _process_whole_video(job_id: str, file_id: str, tmp_path: str,
                         confidence: float, slice_size: int, overlap: float,
                         frame_interval: float,
                         full_imgsz: int,
                         loop: asyncio.AbstractEventLoop) -> dict:
    """GPU-saturated video pipeline:
    - Reader thread keeps a deep frame buffer ahead of GPU
    - Batched YOLO inference (GPU_BATCH frames, FP16 on CUDA when available)
    - Annotation pool (4 CPU threads) runs parallel to GPU
    - Writer thread handles disk I/O async
    - H.264 re-encode via NVENC for browser playback"""
    import torch

    cap = _open_video_capture(tmp_path)
    if not cap.isOpened():
        raise RuntimeError(f"Cannot open video: {tmp_path}")

    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total_frames = max(1, int(cap.get(cv2.CAP_PROP_FRAME_COUNT)))
    duration = total_frames / fps if fps > 0 else 0

    out_dir = RESULTS_DIR / file_id
    out_dir.mkdir(exist_ok=True)
    raw_path = out_dir / "raw.mp4"
    writer = cv2.VideoWriter(str(raw_path), cv2.VideoWriter_fourcc(*"mp4v"), fps, (w, h))

    # Side-by-side un-annotated copy + per-frame bboxes power the client-side
    # canvas overlay that filters detection boxes on the playing video.
    original_raw_path = out_dir / "original_raw.mp4"
    original_writer = cv2.VideoWriter(
        str(original_raw_path), cv2.VideoWriter_fourcc(*"mp4v"), fps, (w, h)
    )

    frame_q: queue.Queue = queue.Queue(maxsize=READ_AHEAD)
    read_done = threading.Event()
    write_q: queue.Queue = queue.Queue(maxsize=READ_AHEAD)
    writer_t = None

    model = get_model()
    all_det_count = 0
    conf_sum = 0.0
    max_conf = 0.0
    frames_done = 0
    thumb_saved = False
    all_detections_list: list[dict] = []
    all_frame_dets: list[list[dict]] = []

    t0 = time.time()

    def _is_cancelled() -> bool:
        return bool(video_jobs.get(job_id, {}).get("cancel_requested"))

    try:
        def _reader():
            while True:
                if _is_cancelled():
                    break
                ret, frm = cap.read()
                if not ret:
                    break
                frame_q.put(frm)
            read_done.set()
        threading.Thread(target=_reader, daemon=True).start()

        def _writer_fn():
            while True:
                item = write_q.get()
                if item is None:
                    break
                writer.write(item)
        writer_t = threading.Thread(target=_writer_fn, daemon=True)
        writer_t.start()

        # Double-buffer: GPU inference on batch N overlaps with CPU annotation of batch N-1
        _prev_ann_futs = None
        _prev_wb = None  # (batch, per_frame_dets) awaiting write-back

        while True:
            if _is_cancelled():
                raise RuntimeError("Cancelled by user")
            batch: list[np.ndarray] = []
            while len(batch) < GPU_BATCH:
                try:
                    batch.append(frame_q.get(timeout=0.2))
                except queue.Empty:
                    if read_done.is_set():
                        break
                if _is_cancelled():
                    raise RuntimeError("Cancelled by user")
            if not batch:
                break

            # GPU inference (CPU annotation threads from the previous batch run concurrently)
            per_frame_dets = _batch_detect(model, batch, confidence, imgsz=full_imgsz)
            _remap_video_labels(per_frame_dets)

            # Flush previous batch: wait for its annotation, write frames, update counters
            if _prev_ann_futs is not None:
                for _fut in _prev_ann_futs:
                    _fut.result()
                _pb, _pd = _prev_wb
                all_frame_dets.extend(_pd)
                for i, (frame, dets) in enumerate(zip(_pb, _pd)):
                    write_q.put(frame)
                    all_det_count += len(dets)
                    for d in dets:
                        c = d["confidence"]
                        conf_sum += c
                        if c > max_conf:
                            max_conf = c
                        all_detections_list.append({
                            "class_name": d["class_name"],
                            "confidence": c,
                            "class_id": d.get("class_id", 0),
                        })
                    if not thumb_saved and w > 0 and h > 0:
                        scale = min(480 / w, 480 / h, 1.0)
                        t = cv2.resize(_pb[0], (max(1, int(w * scale)), max(1, int(h * scale))))
                        cv2.imwrite(str(out_dir / "thumb.jpg"), t, [cv2.IMWRITE_JPEG_QUALITY, 85])
                        thumb_saved = True
                frames_done += len(_pb)
                pct = min(95, int((frames_done / total_frames) * 100))
                asyncio.run_coroutine_threadsafe(
                    sio.emit("video_progress", {
                        "job_id": job_id, "file_id": file_id,
                        "frames_done": frames_done, "total_frames": total_frames,
                        "percent": pct,
                    }),
                    loop,
                )

            # Capture un-annotated frames now — VideoWriter.write() copies pixels into the
            # encoder synchronously, so subsequent in-place annotation cannot race the writer.
            for _orig_frame in batch:
                original_writer.write(_orig_frame)

            # Submit annotation for current batch (non-blocking; runs on CPU while next GPU batch executes)
            _prev_ann_futs = [_annotate_pool.submit(annotate_image, f, d, False)
                              for f, d in zip(batch, per_frame_dets)]
            _prev_wb = (batch, per_frame_dets)

        # Flush the final pending batch
        if _prev_ann_futs is not None:
            for _fut in _prev_ann_futs:
                _fut.result()
            _pb, _pd = _prev_wb
            all_frame_dets.extend(_pd)
            for i, (frame, dets) in enumerate(zip(_pb, _pd)):
                write_q.put(frame)
                all_det_count += len(dets)
                for d in dets:
                    c = d["confidence"]
                    conf_sum += c
                    if c > max_conf:
                        max_conf = c
                    all_detections_list.append({
                        "class_name": d["class_name"],
                        "confidence": c,
                        "class_id": d.get("class_id", 0),
                    })
                if not thumb_saved and w > 0 and h > 0:
                    scale = min(480 / w, 480 / h, 1.0)
                    t = cv2.resize(_pb[0], (max(1, int(w * scale)), max(1, int(h * scale))))
                    cv2.imwrite(str(out_dir / "thumb.jpg"), t, [cv2.IMWRITE_JPEG_QUALITY, 85])
                    thumb_saved = True
            frames_done += len(_pb)
            pct = min(95, int((frames_done / total_frames) * 100))
            asyncio.run_coroutine_threadsafe(
                sio.emit("video_progress", {
                    "job_id": job_id, "file_id": file_id,
                    "frames_done": frames_done, "total_frames": total_frames,
                    "percent": pct,
                }),
                loop,
            )
    finally:
        write_q.put(None)
        if writer_t is not None:
            writer_t.join(timeout=60)
        try:
            writer.release()
        except Exception:
            pass
        try:
            original_writer.release()
        except Exception:
            pass
        try:
            cap.release()
        except Exception:
            pass
        if DEVICE != "cpu":
            try:
                torch.cuda.empty_cache()
            except Exception:
                pass

    if _is_cancelled():
        try:
            if raw_path.exists():
                raw_path.unlink()
        except Exception:
            pass
        try:
            if original_raw_path.exists():
                original_raw_path.unlink()
        except Exception:
            pass
        try:
            os.unlink(tmp_path)
        except Exception:
            pass
        raise RuntimeError("Cancelled by user")

    elapsed = time.time() - t0
    throughput = frames_done / elapsed if elapsed > 0 else 0
    print(f"[PERF] {file_id}: {frames_done}f / {elapsed:.1f}s = {throughput:.0f} FPS | {all_det_count} dets")

    # H.264 re-encode for browser
    h264_path = out_dir / "annotated.mp4"
    if not _reencode_to_h264(str(raw_path), str(h264_path), fps):
        shutil.move(str(raw_path), str(h264_path))
        print("[WARN] H.264 re-encode failed, serving raw mp4v")
    else:
        try:
            os.unlink(str(raw_path))
        except Exception:
            pass

    # H.264 re-encode the un-annotated copy used by the client overlay player.
    original_h264_path = out_dir / "original.mp4"
    if not _reencode_to_h264(str(original_raw_path), str(original_h264_path), fps):
        try:
            shutil.move(str(original_raw_path), str(original_h264_path))
        except Exception:
            pass
    else:
        try:
            os.unlink(str(original_raw_path))
        except Exception:
            pass

    try:
        os.unlink(tmp_path)
    except Exception:
        pass

    avg_conf = (conf_sum / all_det_count) if all_det_count > 0 else 0
    try:
        with open(out_dir / "detections.json", "w", encoding="utf-8") as fp:
            json.dump(all_detections_list, fp)
    except Exception:
        pass
    try:
        with open(out_dir / "detections_frames.json", "w", encoding="utf-8") as fp:
            json.dump([
                [
                    {
                        "bbox": d.get("bbox"),
                        "confidence": d.get("confidence", 0),
                        "class_id": d.get("class_id", 0),
                        "class_name": d.get("class_name", ""),
                    }
                    for d in frame_dets
                ]
                for frame_dets in all_frame_dets
            ], fp)
    except Exception:
        pass
    return {
        "total_frames": total_frames,
        "frames_analyzed": frames_done,
        "duration": round(duration, 2),
        "fps": round(fps, 2),
        "video_width": int(w),
        "video_height": int(h),
        "total_detections": all_det_count,
        "avg_confidence": round(avg_conf, 4),
        "max_confidence": round(max_conf, 4),
        "thumb_url": f"/results/{file_id}/thumb.jpg",
        "video_url": f"/results/{file_id}/annotated.mp4",
        "original_url": f"/results/{file_id}/original.mp4",
        "frames_url": f"/results/{file_id}/detections_frames.json",
        "detections": all_detections_list,
    }


def _load_stored_video_detections(file_id: str) -> list:
    """Reload per-box list written next to annotated.mp4 (survives server restarts)."""
    p = RESULTS_DIR / file_id / "detections.json"
    if not p.is_file():
        return []
    try:
        with open(p, encoding="utf-8") as fp:
            data = json.load(fp)
        return data if isinstance(data, list) else []
    except Exception:
        return []


_backfill_locks_guard = threading.Lock()
_video_det_backfill_locks: dict[str, threading.Lock] = {}


def _video_det_backfill_lock(file_id: str) -> threading.Lock:
    with _backfill_locks_guard:
        if file_id not in _video_det_backfill_locks:
            _video_det_backfill_locks[file_id] = threading.Lock()
        return _video_det_backfill_locks[file_id]


def _collect_detections_from_video_file(video_path: str, confidence: float) -> list:
    """Run the same batched YOLO path as whole-video processing; no annotate/write."""
    model = get_model()
    cap = _open_video_capture(video_path)
    if not cap.isOpened():
        return []
    all_list: list[dict] = []
    try:
        while True:
            batch: list[np.ndarray] = []
            while len(batch) < GPU_BATCH:
                ret, frm = cap.read()
                if not ret:
                    break
                batch.append(frm)
            if not batch:
                break
            per_frame_dets = _batch_detect(model, batch, confidence, imgsz=1280)
            _remap_video_labels(per_frame_dets)
            for dets in per_frame_dets:
                for d in dets:
                    all_list.append({
                        "class_name": d["class_name"],
                        "confidence": d["confidence"],
                        "class_id": d.get("class_id", 0),
                    })
    finally:
        cap.release()
    return all_list


def _backfill_stored_video_detections(file_id: str, video_path: str, confidence: float) -> list:
    """Create detections.json for legacy runs that only have mp4 on disk."""
    lk = _video_det_backfill_lock(file_id)
    with lk:
        cached = _load_stored_video_detections(file_id)
        if cached:
            return cached
        lst = _collect_detections_from_video_file(video_path, confidence)
        out_dir = RESULTS_DIR / file_id
        try:
            with open(out_dir / "detections.json", "w", encoding="utf-8") as fp:
                json.dump(lst, fp)
        except Exception:
            pass
        return lst


async def _video_item_worker(job_id: str):
    """Process videos sequentially — GPU gets 100% of resources per video."""
    vjob = video_jobs.get(job_id)
    if not vjob:
        return

    loop = asyncio.get_event_loop()

    while True:
        if vjob.get("cancel_requested"):
            for fid, fdata in list(vjob["files"].items()):
                if fdata["status"] == "pending":
                    fdata["status"] = "error"
                    fdata["result"] = {"error": "Cancelled by user"}
                    vjob["completed"] += 1
                    try:
                        os.unlink(fdata["tmp_path"])
                    except Exception:
                        pass
                    await sio.emit("video_item_result", {
                        "job_id": job_id,
                        "file_id": fid,
                        "filename": fdata["filename"],
                        "error": "Cancelled by user",
                        "completed": vjob["completed"],
                        "total": vjob["total"],
                    })
            break

        pending = None
        for fid, fdata in list(vjob["files"].items()):
            if fdata["status"] == "pending":
                fdata["status"] = "processing"
                pending = (fid, fdata)
                break

        if pending is None:
            all_done = (
                len(vjob["files"]) >= vjob["total"]
                and all(f["status"] in ("done", "error") for f in vjob["files"].values())
            )
            if all_done:
                break
            await asyncio.sleep(0.3)
            if time.time() - vjob["created_at"] > 3600:
                break
            continue

        fid, fdata = pending
        await sio.emit("video_item_start", {
            "job_id": job_id, "file_id": fid, "filename": fdata["filename"],
        })

        try:
            result = await loop.run_in_executor(
                None, _process_whole_video,
                job_id, fid, fdata["tmp_path"],
                vjob["confidence"], vjob["slice_size"], vjob["overlap"],
                vjob.get("frame_interval", 1),
                int(vjob.get("full_imgsz", 1280)),
                loop,
            )
            fdata["status"] = "done"
            fdata["result"] = result
            vjob["completed"] += 1
            await sio.emit("video_item_result", {
                "job_id": job_id, "file_id": fid, "filename": fdata["filename"],
                "completed": vjob["completed"], "total": vjob["total"],
                **result,
            })
        except Exception as e:
            import traceback
            traceback.print_exc()
            fdata["status"] = "error"
            fdata["result"] = {"error": str(e)}
            vjob["completed"] += 1
            await sio.emit("video_item_result", {
                "job_id": job_id, "file_id": fid, "filename": fdata["filename"],
                "error": str(e),
                "completed": vjob["completed"], "total": vjob["total"],
            })

    if vjob.get("cancel_requested"):
        vjob["status"] = "cancelled"
        await sio.emit("video_batch_cancelled", {
            "job_id": job_id,
            "completed": vjob["completed"],
            "total": vjob["total"],
        })
    else:
        vjob["status"] = "complete"
        total_dets = sum(f.get("result", {}).get("total_detections", 0) for f in vjob["files"].values())
        await sio.emit("video_batch_complete", {
            "job_id": job_id,
            "total_videos": len(vjob["files"]),
            "total_detections": total_dets,
        })


@app.post("/api/video/batch/start")
async def video_batch_start(payload: dict):
    total = payload.get("total", 0)
    if total <= 0:
        raise HTTPException(400, "total must be > 0")

    model_id = payload.get("model_id")
    if model_id and model_id in AVAILABLE_MODELS and AVAILABLE_MODELS[model_id]["path"] != _model_path:
        switch_model(model_id)

    vid_id = uuid.uuid4().hex[:12]
    video_jobs[vid_id] = {
        "job_id": vid_id,
        "total": total,
        "completed": 0,
        "confidence": float(payload.get("det_confidence", 0.25)),
        "slice_size": int(payload.get("det_slice_size", 1280)),
        "overlap": float(payload.get("det_overlap", 0.25)),
        "full_imgsz": int(payload.get("det_full_imgsz", 1280)),
        "frame_interval": payload.get("frame_interval", 1),
        "files": {},
        "status": "active",
        "cancel_requested": False,
        "created_at": time.time(),
        "map_gps": azerbaijan_dot_from_id(vid_id),
    }

    threading.Thread(target=get_model, daemon=True).start()
    asyncio.create_task(_video_item_worker(vid_id))

    return {"job_id": vid_id}


@app.post("/api/video/batch/cancel/{job_id}")
async def cancel_video_batch(job_id: str):
    vjob = video_jobs.get(job_id)
    if not vjob:
        raise HTTPException(404, "Video job not found")
    if vjob["status"] in ("complete", "cancelled"):
        return {"job_id": job_id, "status": vjob["status"]}
    vjob["cancel_requested"] = True
    vjob["status"] = "cancelling"
    return {"job_id": job_id, "status": "cancelling"}


@app.post("/api/video/upload")
async def video_upload(job_id: str = Form(...), file: UploadFile = File(...)):
    vjob = video_jobs.get(job_id)
    if not vjob:
        raise HTTPException(404, "Video job not found")
    if vjob.get("cancel_requested") or vjob.get("status") == "cancelled":
        raise HTTPException(409, "Video job was cancelled")

    import tempfile
    file_id = uuid.uuid4().hex[:10]
    video_bytes = await file.read()

    tmp = tempfile.NamedTemporaryFile(suffix=".mp4", delete=False)
    tmp.write(video_bytes)
    tmp.close()

    vjob["files"][file_id] = {
        "filename": file.filename or f"video_{file_id}.mp4",
        "status": "pending",
        "tmp_path": tmp.name,
        "result": None,
    }
    vjob["total"] = max(vjob["total"], len(vjob["files"]))

    if vjob["status"] == "complete":
        vjob["status"] = "active"
        asyncio.create_task(_video_item_worker(vjob["job_id"]))

    await sio.emit("video_item_queued", {
        "job_id": job_id, "file_id": file_id, "filename": file.filename,
    })

    return {"file_id": file_id, "status": "queued"}


@app.get("/api/video/results/{vid_id}")
async def video_results(vid_id: str):
    vjob = video_jobs.get(vid_id)
    if not vjob:
        raise HTTPException(404, "Video job not found")
    results = []
    for fid, fdata in list(vjob["files"].items()):
        r = {"file_id": fid, "filename": fdata["filename"], "status": fdata["status"]}
        if fdata.get("result"):
            r.update(fdata["result"])
        results.append(r)
    return {
        "job_id": vid_id,
        "status": vjob["status"],
        "total": vjob["total"],
        "completed": vjob["completed"],
        "results": results,
    }


@app.get("/api/video/detections/{file_id}")
async def api_video_stored_detections(file_id: str, confidence: float = 0.25):
    """Return per-box list from disk, or backfill from raw/annotated mp4 if missing (legacy uploads)."""
    if not file_id or len(file_id) > 48 or not all(c in "0123456789abcdefABCDEF" for c in file_id):
        raise HTTPException(400, "invalid file_id")
    cached = _load_stored_video_detections(file_id)
    if cached:
        return cached
    out_dir = RESULTS_DIR / file_id
    if not out_dir.is_dir():
        raise HTTPException(404, "result not found")
    vid_raw = out_dir / "raw.mp4"
    vid_ann = out_dir / "annotated.mp4"
    if vid_raw.is_file():
        vpath = str(vid_raw)
    elif vid_ann.is_file():
        vpath = str(vid_ann)
    else:
        return []
    loop = asyncio.get_event_loop()
    data = await loop.run_in_executor(
        None,
        _backfill_stored_video_detections,
        file_id,
        vpath,
        confidence,
    )
    return data


# ---------------------------------------------------------------------------
# Unified runs endpoint — merges image + video jobs for the Runs table
# ---------------------------------------------------------------------------
_THERMAL_KEYWORDS = ("thermal", "therm", "flir", "ir_", "_ir.", "infrared", "lwir", "mwir", "hotspot")

def _is_thermal_file(filename: str) -> bool:
    fn = filename.lower()
    return any(k in fn for k in _THERMAL_KEYWORDS)


def _build_run_entry(jid, job, run_type):
    """Build a unified run entry dict compatible with the frontend Run type."""
    from datetime import datetime, timezone

    rgb_findings = 0
    thermal_findings = 0

    job_source = job.get("source", "")

    if run_type == "image":
        total_defects = sum(r.get("stats", {}).get("total_defects", 0) for r in job.get("results", []))
        confs = [r.get("stats", {}).get("avg_confidence", 0) for r in job.get("results", []) if r.get("stats", {}).get("avg_confidence", 0) > 0]
        avg_conf = float(np.mean(confs)) if confs else 0
        needs_review = sum(1 for r in job.get("results", []) if r.get("stats", {}).get("total_defects", 0) > 0)
        files_info = []
        for fid, fdata in job.get("files", {}).items():
            res = next((r for r in job.get("results", []) if r.get("file_id") == fid), None)
            fname = fdata.get("filename", "")
            dcount = (res.get("stats", {}).get("total_defects", 0)) if res else 0
            fsource = job_source if job_source else ("thermal" if _is_thermal_file(fname) else "rgb")
            if fsource == "thermal":
                thermal_findings += dcount
            else:
                rgb_findings += dcount
            files_info.append({
                "file_id": fid, "filename": fname,
                "source": fsource,
                "status": fdata.get("status", "pending"),
                "thumb_url": res.get("thumb_url") if res else None,
                "annotated_url": res.get("annotated_url") if res else None,
                "clean_url": res.get("clean_url") if res else None,
                "image_width": res.get("image_width") if res else None,
                "image_height": res.get("image_height") if res else None,
                "detections": res.get("detections", []) if res else [],
                "stats": res.get("stats") if res else None,
                "gps": fdata.get("gps"),
            })
    else:
        total_defects = 0
        confs = []
        needs_review = 0
        files_info = []
        for fid, fdata in job.get("files", {}).items():
            res = fdata.get("result") or {}
            d = res.get("total_detections", 0)
            total_defects += d
            fname = fdata.get("filename", "")
            fsource = job_source if job_source else ("thermal" if _is_thermal_file(fname) else "rgb")
            if fsource == "thermal":
                thermal_findings += d
            else:
                rgb_findings += d
            ac = res.get("avg_confidence", 0)
            if ac > 0:
                confs.append(ac)
            if d > 0:
                needs_review += 1
            det_list = list(res.get("detections") or [])
            if fdata.get("status") == "done" and not det_list and d > 0:
                det_list = _load_stored_video_detections(fid)
            files_info.append({
                "file_id": fid, "filename": fname,
                "source": fsource,
                "status": fdata.get("status", "pending"),
                "thumb_url": res.get("thumb_url"), "video_url": res.get("video_url"),
                "total_detections": d, "duration": res.get("duration", 0),
                "fps": res.get("fps", 0), "frames_analyzed": res.get("frames_analyzed", 0),
                "avg_confidence": ac, "max_confidence": res.get("max_confidence", 0),
                "detections": det_list,
            })
        avg_conf = float(np.mean(confs)) if confs else 0

    ts = job.get("created_at", 0)
    created_iso = datetime.fromtimestamp(ts, tz=timezone.utc).isoformat() if ts else None

    raw_status = job.get("status", "active")
    n_files = len(job.get("files", {}))
    n_completed = job.get("completed", 0)
    if raw_status == "active" and n_files > 0 and n_completed >= n_files:
        raw_status = "complete"
        job["status"] = "complete"
    status_map = {"active": "processing", "complete": "completed"}
    display_type = run_type
    if run_type == "image" and job.get("source") == "thermal":
        display_type = "thermal"
    return {
        "id": jid, "run_id": jid,
        "type": display_type,
        "status": status_map.get(raw_status, raw_status),
        "total_files": n_files,
        "completed": n_completed,
        "findings_count": total_defects,
        "total_defects": total_defects,
        "rgb_findings": rgb_findings,
        "thermal_findings": thermal_findings,
        "must_review_count": needs_review,
        "needs_review": needs_review,
        "avg_confidence": round(avg_conf, 4),
        "ai_confidence": round(avg_conf, 4),
        "created_at": created_iso,
        "timestamp": created_iso,
        "_created_ts": ts,
        "files": files_info,
        "gps": _gps_for_map(job, jid),
    }


def _build_thermal_run_entry(jid: str, job: dict) -> dict:
    """DJI thermal batch job in the same shape as `/api/runs` image rows (for Dashboard / recent uploads)."""
    from datetime import datetime, timezone

    results_by_fid = {}
    rb = job.get("results_by_file_id")
    if isinstance(rb, dict):
        for fid, r in rb.items():
            if isinstance(r, dict) and fid:
                results_by_fid[str(fid)] = r
    for r in job.get("results") or []:
        if isinstance(r, dict) and r.get("file_id"):
            results_by_fid[r["file_id"]] = r

    files_info = []
    # Dict insertion order = upload registration order (not lexicographic file_id sort).
    for fid in job.get("files", {}):
        fdata = job["files"][fid]
        res = results_by_fid.get(fid)
        fname = fdata.get("filename", "")
        st = fdata.get("status", "pending")
        if st == "done" and res:
            fe_status = "done"
        elif st == "error":
            fe_status = "error"
        elif st == "processing":
            fe_status = "processing"
        else:
            fe_status = "pending"
        thumb = (res or {}).get("thermal_image_url") if res else None
        files_info.append({
            "file_id": fid,
            "filename": fname,
            "source": "thermal",
            "status": fe_status,
            "thumb_url": thumb,
            "annotated_url": thumb,
            "detections": [],
            "stats": None,
            "gps": fdata.get("gps"),
        })

    n_files = len(files_info)
    n_completed = int(job.get("completed", 0))
    raw_status = job.get("status", "active")
    ts = float(job.get("created_at", 0))
    created_iso = datetime.fromtimestamp(ts, tz=timezone.utc).isoformat() if ts else None
    status_map = {"active": "processing", "complete": "completed"}
    total_planned = max(int(job.get("total", 0)), n_files)

    return {
        "id": jid,
        "run_id": jid,
        "type": "thermal",
        "thermal_analysis_job": True,
        "status": status_map.get(raw_status, raw_status),
        "total_files": total_planned,
        "completed": n_completed,
        "findings_count": 0,
        "total_defects": 0,
        "rgb_findings": 0,
        "thermal_findings": 0,
        "must_review_count": 0,
        "needs_review": 0,
        "avg_confidence": 0.0,
        "ai_confidence": 0.0,
        "created_at": created_iso,
        "timestamp": created_iso,
        "_created_ts": ts,
        "files": files_info,
        "gps": _gps_for_map(job, jid),
    }


@app.get("/api/runs")
async def get_all_runs():
    """Return all image and video jobs as a flat array compatible with the Dashboard Run type."""
    result = []
    for jid, job in jobs.items():
        result.append(_build_run_entry(jid, job, "image"))
    for vid, vjob in video_jobs.items():
        result.append(_build_run_entry(vid, vjob, "video"))
    for tid, tjob in _thermal_jobs_dict.items():
        result.append(_build_thermal_run_entry(tid, tjob))
    result.sort(key=lambda r: r.get("_created_ts", 0), reverse=True)
    return result


@app.get("/api/summary")
async def get_summary():
    """Dashboard summary stats built from actual upload data."""
    all_runs = []
    for jid, job in jobs.items():
        all_runs.append(_build_run_entry(jid, job, "image"))
    for vid, vjob in video_jobs.items():
        all_runs.append(_build_run_entry(vid, vjob, "video"))
    for tid, tjob in _thermal_jobs_dict.items():
        all_runs.append(_build_thermal_run_entry(tid, tjob))

    total_findings = sum(r["total_defects"] for r in all_runs)
    confs = [r["avg_confidence"] for r in all_runs if r["avg_confidence"] > 0]
    return {
        "towers_total": len(all_runs),
        "findings_total": total_findings,
        "avg_ai_confidence": round(float(np.mean(confs)), 4) if confs else 0,
        "status_counts": {
            "HEALTHY": sum(1 for r in all_runs if r["total_defects"] == 0 and r["status"] == "completed"),
            "MONITOR": sum(1 for r in all_runs if 0 < r["total_defects"] <= 5),
            "REQUIRES_INSPECTION": sum(1 for r in all_runs if r["total_defects"] > 5),
        },
    }


@app.get("/api/bulk-batches/latest")
async def bulk_latest():
    raise HTTPException(404, "No bulk batches")


@app.get("/api/bulk-batches/recent")
async def bulk_recent():
    return []


# ---------------------------------------------------------------------------
# DJI thermal batch (R-JPEG) — _thermal_http loaded after socket_app (see above)
# ---------------------------------------------------------------------------
@app.get("/api/thermal/health")
async def thermal_health_route():
    return await _thermal_http.thermal_health()


@app.post("/api/thermal/analyze")
async def thermal_analyze_route(
    image: UploadFile = File(...),
    object_type: Optional[str] = Form(default=None),
    real_world_size_meters: Optional[float] = Form(default=None),
    object_pixel_size: Optional[float] = Form(default=None),
):
    return await _thermal_http.analyze_image(image, object_type, real_world_size_meters, object_pixel_size)


@app.post("/api/thermal/roi")
async def thermal_roi_route(
    image: UploadFile = File(...),
    x1: int = Form(...),
    y1: int = Form(...),
    x2: int = Form(...),
    y2: int = Form(...),
    unit: str = Form(default="Celsius"),
):
    try:
        return await _thermal_http.roi_stats(image, x1, y1, x2, y2, unit)
    except HTTPException:
        raise
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Unexpected server error: {str(e)}") from e


@app.post("/api/thermal/export/csv")
async def thermal_export_csv_route(
    image: UploadFile = File(...),
    unit: str = Form(default="Celsius"),
):
    return await _thermal_http.export_csv(image, unit)


@app.post("/api/thermal/batch/start")
async def thermal_batch_start_route(payload: dict = Body(...)):
    return await _thermal_http.start_thermal_batch(payload)


@app.post("/api/thermal/batch/file")
async def thermal_batch_file_route(
    job_id: str = Form(...),
    client_key: str = Form(default=""),
    file: UploadFile = File(...),
):
    out = await _thermal_http.upload_thermal_file(job_id, file, client_key)
    await sio.emit("thermal_queued", {
        "job_id": job_id,
        "file_id": out["file_id"],
        "filename": out["filename"],
        "client_key": out.get("client_key") or "",
        "sha256": out.get("sha256") or "",
    }, room=job_id)
    return {
        "file_id": out["file_id"],
        "status": "queued",
        "client_key": out.get("client_key") or "",
        "sha256": out.get("sha256") or "",
    }


@app.get("/api/thermal/batch/results/{job_id}")
async def thermal_batch_results_route(
    job_id: str,
    include_base64: bool = False,
    include_images: Optional[bool] = None,
):
    # Backwards compatibility: older clients used include_images=false to strip all images.
    # New behavior: include_base64 controls only the large base64 field; URLs remain.
    if include_images is False:
        include_base64 = False
    elif include_images is True:
        include_base64 = True
    return await _thermal_http.get_thermal_results(job_id, include_base64=include_base64)


@app.get("/health")
async def health():
    gpu_name = "N/A"
    try:
        import torch
        if torch.cuda.is_available():
            gpu_name = torch.cuda.get_device_name(0)
    except Exception:
        pass
    active_id = next((mid for mid, info in AVAILABLE_MODELS.items() if info["path"] == _model_path), None)
    return {
        "ok": True,
        "model": str(WEIGHTS_PATH),
        "active_model_id": active_id,
        "device": DEVICE,
        "gpu": gpu_name,
        "half_precision": USE_HALF,
        "service": "detection-server",
    }


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def _preload_model_in_background():
    try:
        get_model()
    except Exception as e:
        print(f"[ERROR] Model preload failed (detection will retry on first request): {e}")
        traceback.print_exc()


if __name__ == "__main__":
    print(f"[INFO] Detection server starting on port {SERVER_PORT}")
    print(f"[INFO] Weights: {WEIGHTS_PATH}")
    print(f"[INFO] Device: {DEVICE} | FP16: {USE_HALF}")
    print(f"[INFO] Results dir: {RESULTS_DIR}")
    threading.Thread(target=_preload_model_in_background, daemon=True).start()
    uvicorn.run(socket_app, host="0.0.0.0", port=SERVER_PORT, log_level="info")
