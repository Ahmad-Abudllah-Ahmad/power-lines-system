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
# Remote inference: weights live on the RunPod pod (no local download).
# The pod runs scripts/pod_inference_server.py on port 6006 (exposed via runpod proxy).
# Default host must match the pod "HTTP Service" URL for port 6006 (see RunPod Connect).
POD_INFERENCE_URL = os.environ.get(
    "POD_INFERENCE_URL",
    "https://ycfjp6tp0zl9xf-64410b2b-6006.proxy.runpod.net",
).rstrip("/")
POD_REMOTE_WEIGHTS = (
    "/workspace/project/runs/obb/yolo11x_obb_dota_20260426_060214/weights/best.pt"
)

AVAILABLE_MODELS: dict[str, dict] = {
    "dota_1000ep_best": {
        "id": "dota_1000ep_best",
        "title": "DOTA 1000ep · YOLO11x OBB (RunPod H200)",
        "path": POD_REMOTE_WEIGHTS,
        "description": f"YOLO inference on RunPod GPU · {POD_INFERENCE_URL}",
    },
}

WEIGHTS_PATH = Path(POD_REMOTE_WEIGHTS)
RESULTS_DIR = Path(__file__).parent / "results"
RESULTS_DIR.mkdir(exist_ok=True)

# HTTP listen port (override when 8000 is already in use, e.g. `set PORT=8001`)
SERVER_PORT = int(os.environ.get("PORT", "8001"))

# Larger batches = fewer HTTP round-trips to RunPod (major latency win for remote YOLO).
GPU_BATCH = int(os.environ.get("GPU_BATCH", "56"))
READ_AHEAD = 128        # decode-ahead queue so GPU batches stay full during video
ANNOTATE_THREADS = 4    # CPU threads for drawing bboxes

# ---------------------------------------------------------------------------
# GPU detection & CUDA setup
# ---------------------------------------------------------------------------
def _select_device() -> str:
    """Local device selection. With RemoteYOLO inference happens on the pod (always GPU);
    the local 'device' flag only controls whether we ask the pod to run in FP16."""
    try:
        import torch  # noqa: F401
        if torch.cuda.is_available():
            torch.cuda.init()
            name = torch.cuda.get_device_name(0)
            vram = torch.cuda.get_device_properties(0).total_memory / (1024**3)
            print(f"[GPU-local] {name} | {vram:.1f} GB VRAM | CUDA {torch.version.cuda}")
            return "0"
    except Exception as e:
        print(f"[INFO] Local torch unavailable ({e}); inference runs entirely on RunPod.")
    print("[INFO] Using CPU locally (remote inference on pod still uses GPU).")
    return "cpu"

DEVICE = _select_device()
# Pod has H200 GPU — always request FP16 from the remote model.
USE_HALF = True


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


class _TensorList(list):
    """list with a .tolist() method so call sites doing `box.xyxy[0].tolist()` work."""
    def tolist(self):
        return list(self)


class _RemoteBox:
    """Mimics ultralytics box[i] interface: .cls/.xyxy/.conf are tensor-like with [0]."""
    __slots__ = ("cls", "xyxy", "conf")

    def __init__(self, cls_id: int, xyxy: list[float], conf: float):
        self.cls = (cls_id,)
        self.xyxy = (_TensorList(xyxy),)
        self.conf = (conf,)


class _RemoteBoxes:
    """Iterable + len() over a list of _RemoteBox; mirrors ultralytics result.boxes."""
    __slots__ = ("_boxes",)

    def __init__(self, boxes: list[_RemoteBox]):
        self._boxes = boxes

    def __iter__(self):
        return iter(self._boxes)

    def __len__(self):
        return len(self._boxes)


class _RemoteResult:
    """Mimics ultralytics result with `.boxes`."""
    __slots__ = ("boxes",)

    def __init__(self, boxes: _RemoteBoxes):
        self.boxes = boxes


class RemoteYOLO:
    """Tiny shim that proxies `.predict(...)` to the RunPod pod's HTTP inference server.

    Returns objects that quack like Ultralytics results so the rest of `server.py`
    (run_sahi_detection / _batch_detect) keeps working unchanged.
    """

    def __init__(self, endpoint_url: str, weights_path: str = ""):
        import requests
        from requests.adapters import HTTPAdapter
        self._requests = requests
        self.endpoint = endpoint_url.rstrip("/")
        self.weights_path = weights_path
        self.names = self._fetch_names()
        # Bigger connection pool so parallel chunk uploads don't queue.
        self._session = requests.Session()
        adapter = HTTPAdapter(pool_connections=16, pool_maxsize=16, max_retries=0)
        self._session.mount("https://", adapter)
        self._session.mount("http://", adapter)
        # Worker pool for fan-out chunked uploads (env-tunable).
        max_workers = max(1, int(os.environ.get("REMOTE_PREDICT_PARALLEL", "4")))
        self._chunk_pool = ThreadPoolExecutor(
            max_workers=max_workers, thread_name_prefix="podchunk"
        )

    def _fetch_names(self) -> dict:
        try:
            r = self._requests.get(f"{self.endpoint}/names", timeout=30)
            r.raise_for_status()
            data = r.json()
            return {int(k): str(v) for k, v in data.items()}
        except Exception as e:
            print(f"[WARN] Could not fetch class names from {self.endpoint}: {e}")
            return {}

    def to(self, _device):
        return self

    def predict(self, source, conf: float = 0.20, imgsz: int = 1280,
                device=None, verbose: bool = False, half: bool = False, **_kw):
        # Normalize input to a list of np.ndarray (BGR) and JPEG-encode once
        imgs = source if isinstance(source, (list, tuple)) else [source]
        encoded: list[bytes] = []
        for img in imgs:
            if not isinstance(img, np.ndarray):
                raise TypeError(f"RemoteYOLO.predict expects numpy arrays, got {type(img)}")
            ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 78])
            if not ok:
                raise RuntimeError("JPEG encode failed for remote inference")
            encoded.append(buf.tobytes())

        data_form = {"conf": str(conf), "imgsz": str(imgsz), "half": "1" if half else "0"}

        # The RunPod HTTPS proxy (Cloudflare-fronted) is unreliable for large
        # multipart bodies — big requests randomly fail with 502/524 even though
        # the pod itself is idle. We split the request into proxy-friendly chunks
        # and merge results. Detection / model behavior is unchanged: each chunk
        # uses the exact same conf/imgsz/half on the same model.
        CHUNK = max(1, int(os.environ.get("REMOTE_PREDICT_CHUNK", "10")))

        # Build chunk index list and POST chunks in parallel — the pod GPU can
        # service overlapping requests, and parallel uploads hide the proxy
        # round-trip behind GPU work for the next chunk. Order is preserved by
        # index so results are merged in the same order as `imgs`.
        chunk_starts = list(range(0, len(encoded), CHUNK))
        chunk_results: list[list[list[dict]]] = [[] for _ in chunk_starts]

        def _do_chunk(idx: int, ci: int):
            chunk_bytes = encoded[ci : ci + CHUNK]
            body = self._post_chunk_with_retry(chunk_bytes, data_form, ci)
            chunk_results[idx] = body.get("detections") or []

        if len(chunk_starts) <= 1:
            for idx, ci in enumerate(chunk_starts):
                _do_chunk(idx, ci)
        else:
            futs = [
                self._chunk_pool.submit(_do_chunk, idx, ci)
                for idx, ci in enumerate(chunk_starts)
            ]
            for f in futs:
                f.result()  # propagate exceptions

        all_per_image: list[list[dict]] = []
        for per_chunk in chunk_results:
            all_per_image.extend(per_chunk)

        results: list[_RemoteResult] = []
        for dets in all_per_image:
            boxes = [_RemoteBox(int(d["cls"]), list(d["xyxy"]), float(d["conf"])) for d in dets]
            results.append(_RemoteResult(_RemoteBoxes(boxes)))
        while len(results) < len(imgs):
            results.append(_RemoteResult(_RemoteBoxes([])))
        return results

    def _post_chunk_with_retry(self, chunk_bytes: list[bytes], data_form: dict, base_idx: int) -> dict:
        """POST one chunk to /predict with retries on transient proxy errors.

        Retries cover Cloudflare-style transient statuses (502/503/504/520-524)
        as well as connection / read timeouts. Idempotent: same payload, same
        params — pure transport-layer resiliency.
        """
        TRANSIENT_STATUSES = {408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524}
        max_attempts = max(1, int(os.environ.get("REMOTE_PREDICT_RETRIES", "8")))
        last_err: Exception | None = None
        for attempt in range(1, max_attempts + 1):
            try:
                files = [
                    ("files", (f"img_{base_idx + i}.jpg", b, "image/jpeg"))
                    for i, b in enumerate(chunk_bytes)
                ]
                r = self._session.post(
                    f"{self.endpoint}/predict",
                    files=files, data=data_form, timeout=(15, 75),  # (connect, read)
                )
                if r.status_code in TRANSIENT_STATUSES:
                    raise RuntimeError(f"transient {r.status_code} from pod proxy")
                r.raise_for_status()
                return r.json()
            except (self._requests.exceptions.Timeout,
                    self._requests.exceptions.ConnectionError) as e:
                last_err = e
            except Exception as e:
                if ("transient" not in str(e)
                        and not isinstance(e, self._requests.exceptions.RequestException)):
                    raise
                last_err = e
            if attempt < max_attempts:
                wait = min(2 ** min(attempt, 4), 12)  # 2, 4, 8, 12, 12, 12, ...
                print(f"[WARN] pod /predict chunk@{base_idx} attempt {attempt} failed ({last_err}); retrying in {wait}s")
                time.sleep(wait)
        raise RuntimeError(f"pod /predict chunk@{base_idx} failed after {max_attempts} attempts: {last_err}")


def _load_model(weights_path: str):
    """Connect to the RunPod inference server and return a RemoteYOLO shim."""
    print(f"[INFO] Connecting to remote YOLO at {POD_INFERENCE_URL} (weights={weights_path}) ...")
    model = RemoteYOLO(POD_INFERENCE_URL, weights_path=weights_path)
    print(f"[INFO] Remote model ready. {len(model.names)} classes")
    return model


def get_model():
    global _model
    if _model is None:
        with _model_lock:
            if _model is None:
                _model = _load_model(_model_path)
    return _model


def switch_model(model_id: str):
    """Switch the active model. With RemoteYOLO the only side effect is bumping the path label."""
    global _model, _sahi_det_model, _model_path, WEIGHTS_PATH
    info = AVAILABLE_MODELS.get(model_id)
    if not info:
        raise ValueError(f"Unknown model: {model_id}")
    with _model_lock:
        with _sahi_lock:
            _model_path = info["path"]
            WEIGHTS_PATH = Path(_model_path)
            _model = None
            _sahi_det_model = None
    print(f"[INFO] Switched active model to {model_id} ({info['title']})")


def get_sahi_model(confidence: float = 0.20):
    """Kept for API compatibility — returns the RemoteYOLO shim (the slicing logic in
    `run_sahi_detection` calls `model.predict(...)` directly, no SAHI runtime needed)."""
    return get_model()


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
    nms_iou: float = 0.10,
    full_imgsz: int = 1280,
    sahi_tiled: bool = True,
) -> dict:
    job_id = uuid.uuid4().hex[:12]
    job = {
        "job_id": job_id,
        "total": total,
        "confidence": confidence,
        "slice_size": slice_size,
        "overlap": overlap,
        "nms_iou": nms_iou,
        "full_imgsz": full_imgsz,
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
# SAHI sliced inference
# ---------------------------------------------------------------------------
def run_sahi_detection(
    img: np.ndarray,
    confidence: float = 0.20,
    slice_size: int = 1280,
    overlap: float = 0.25,
    job_id: str = "",
    file_id: str = "",
    loop: Optional[asyncio.AbstractEventLoop] = None,
):
    """Run YOLO full-image + GPU-batched sliced inference on a single image."""
    model = get_model()
    jb = jobs.get(job_id) if job_id else None
    nms_iou = float(jb.get("nms_iou", 0.10)) if jb else 0.10
    full_imgsz = int(jb.get("full_imgsz", 1280)) if jb else 1280
    use_tiling = bool(jb.get("sahi_tiled", True)) if jb else True

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

    _emit_progress(0, 2, 5)

    # If tiling is off, run only the full-image pass.
    if not use_tiling:
        full_results = model.predict(
            img, conf=confidence, imgsz=full_imgsz, device=DEVICE,
            verbose=False, **_yolo_predict_kw(),
        )
        full_dets = []
        for r in full_results:
            for box in r.boxes:
                cls_id = int(box.cls[0])
                full_dets.append({
                    "bbox": box.xyxy[0].tolist(),
                    "confidence": float(box.conf[0]),
                    "class_id": cls_id,
                    "class_name": model.names.get(cls_id, str(cls_id)),
                    "source": "full",
                })
        _emit_progress(2, 2, 85)
        if len(full_dets) > 0:
            full_dets = _nms_merge(full_dets, iou_threshold=nms_iou)
        return full_dets

    # Build slice grid
    img_h, img_w = img.shape[:2]
    step_h = max(1, int(slice_size * (1 - overlap)))
    step_w = max(1, int(slice_size * (1 - overlap)))

    slices: list[np.ndarray] = []
    offsets: list[tuple[int, int]] = []
    for y in range(0, img_h, step_h):
        for x in range(0, img_w, step_w):
            y2 = min(y + slice_size, img_h)
            x2 = min(x + slice_size, img_w)
            slices.append(img[y:y2, x:x2])
            offsets.append((x, y))

    full_dets: list[dict] = []
    sahi_dets: list[dict] = []

    # Fast path: when imgsz of the full pass equals the slice size, send the full image
    # and all slices in ONE remote batch (one HTTP round-trip + one batched GPU forward
    # pass instead of two). This is a pure-performance change — same model, same imgsz,
    # same conf — so detections are identical to the two-call path.
    if full_imgsz == slice_size and (1 + len(slices)) <= GPU_BATCH:
        combined = [img] + slices
        results = model.predict(
            combined, conf=confidence, device=DEVICE,
            imgsz=slice_size, verbose=False, **_yolo_predict_kw(),
        )
        if results:
            for box in results[0].boxes:
                cls_id = int(box.cls[0])
                full_dets.append({
                    "bbox": box.xyxy[0].tolist(),
                    "confidence": float(box.conf[0]),
                    "class_id": cls_id,
                    "class_name": model.names.get(cls_id, str(cls_id)),
                    "source": "full",
                })
            for r, (x_off, y_off) in zip(results[1:], offsets):
                for box in r.boxes:
                    cls_id = int(box.cls[0])
                    bx1, by1, bx2, by2 = box.xyxy[0].tolist()
                    sahi_dets.append({
                        "bbox": [bx1 + x_off, by1 + y_off, bx2 + x_off, by2 + y_off],
                        "confidence": float(box.conf[0]),
                        "class_id": cls_id,
                        "class_name": model.names.get(cls_id, str(cls_id)),
                        "source": "sahi",
                    })
    else:
        # Full-image pass
        full_results = model.predict(
            img, conf=confidence, imgsz=full_imgsz, device=DEVICE,
            verbose=False, **_yolo_predict_kw(),
        )
        for r in full_results:
            for box in r.boxes:
                cls_id = int(box.cls[0])
                full_dets.append({
                    "bbox": box.xyxy[0].tolist(),
                    "confidence": float(box.conf[0]),
                    "class_id": cls_id,
                    "class_name": model.names.get(cls_id, str(cls_id)),
                    "source": "full",
                })
        _emit_progress(1, 2, 40)

        # GPU-batched sliced prediction
        for b_start in range(0, len(slices), GPU_BATCH):
            b_slices = slices[b_start : b_start + GPU_BATCH]
            b_offsets = offsets[b_start : b_start + GPU_BATCH]
            results = model.predict(
                b_slices, conf=confidence, device=DEVICE,
                imgsz=slice_size, verbose=False, **_yolo_predict_kw(),
            )
            for r, (x_off, y_off) in zip(results, b_offsets):
                for box in r.boxes:
                    cls_id = int(box.cls[0])
                    bx1, by1, bx2, by2 = box.xyxy[0].tolist()
                    sahi_dets.append({
                        "bbox": [bx1 + x_off, by1 + y_off, bx2 + x_off, by2 + y_off],
                        "confidence": float(box.conf[0]),
                        "class_id": cls_id,
                        "class_name": model.names.get(cls_id, str(cls_id)),
                        "source": "sahi",
                    })

    _emit_progress(2, 2, 85)

    all_dets = full_dets + sahi_dets
    if len(all_dets) > 0:
        all_dets = _nms_merge(all_dets, iou_threshold=nms_iou)

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
# Two-tone scheme: components → green, defects → red. The 10 component class
# names below come from the model's class taxonomy. Anything not in this set is
# treated as a defect.
COMPONENT_CLASSES: frozenset[str] = frozenset({
    "conductor",
    "bolted_connection",
    "foreign_object",
    "foundation_pedestal",
    "insulator",
    "suspension_clamp",
    "transmission_corridor",
    "two_glass",
    "vibration_damper",
    "yoke_plate",
})

# OpenCV uses BGR.
COMPONENT_COLOR_BGR = (0, 200, 0)   # green
DEFECT_COLOR_BGR    = (0, 0, 220)   # red


def _normalize_class_name(name: str) -> str:
    return name.strip().lower().replace("-", "_").replace(" ", "_")


def _color_for_class(class_name: str) -> tuple[int, int, int]:
    return (
        COMPONENT_COLOR_BGR
        if _normalize_class_name(class_name) in COMPONENT_CLASSES
        else DEFECT_COLOR_BGR
    )


def annotate_image(img: np.ndarray, dets: list[dict], copy: bool = True) -> np.ndarray:
    """Draw bounding boxes. Set copy=False for video frames (faster, in-place).

    Components are drawn in green, defects in red.
    """
    canvas = img.copy() if copy else img
    font_scale = 0.5 if copy else 0.7
    font_thickness = 1 if copy else 2
    for det in dets:
        x1, y1, x2, y2 = int(det["bbox"][0]), int(det["bbox"][1]), int(det["bbox"][2]), int(det["bbox"][3])
        class_name = str(det.get("class_name") or "").strip()
        color = _color_for_class(class_name)
        cv2.rectangle(canvas, (x1, y1), (x2, y2), color, 2)
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
def _decode_image_bytes(img_bytes: bytes) -> Optional[np.ndarray]:
    """Decode JPEG/PNG via OpenCV; fall back to PIL for HEIC/EXIF-quirky / partial files.

    Returns BGR numpy or None if both decoders fail.
    """
    if not img_bytes:
        return None
    arr = np.frombuffer(img_bytes, np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is not None:
        return img
    # Fallback: PIL handles HEIC (with pillow-heif if installed), unusual EXIF,
    # progressive JPEGs cv2 occasionally rejects, etc.
    try:
        with Image.open(io.BytesIO(img_bytes)) as pim:
            pim = pim.convert("RGB")
            rgb = np.asarray(pim)
        return cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    except Exception:
        return None


def process_file(job_id: str, file_id: str, img_bytes: bytes, filename: str,
                 confidence: float, slice_size: int, overlap: float,
                 loop: asyncio.AbstractEventLoop):
    """Process one image: detect, annotate, save thumb+annotated, return result dict."""
    t0 = time.time()

    img = _decode_image_bytes(img_bytes)
    if img is None:
        return {"file_id": file_id, "filename": filename, "error": "Cannot decode image"}

    # Emit start
    asyncio.run_coroutine_threadsafe(
        sio.emit("detection_start", {"job_id": job_id, "file_id": file_id, "filename": filename}),
        loop,
    )

    # Run detection
    dets = run_sahi_detection(img, confidence, slice_size, overlap, job_id, file_id, loop)

    # Create output dir
    job_dir = RESULTS_DIR / job_id
    job_dir.mkdir(exist_ok=True)

    # Annotate first (CPU work), then run all three JPEG writes in parallel via the
    # shared annotate pool — they're independent so total disk-write time drops to ~max
    # of the three instead of their sum.
    h, w = img.shape[:2]
    scale = min(640 / w, 640 / h, 1.0)
    thumb = cv2.resize(img, (int(w * scale), int(h * scale)))
    annotated = annotate_image(img, dets)

    thumb_path = job_dir / f"{file_id}_thumb.jpg"
    clean_path = job_dir / f"{file_id}_clean.jpg"
    ann_path   = job_dir / f"{file_id}_annotated.jpg"

    f1 = _annotate_pool.submit(cv2.imwrite, str(thumb_path), thumb, [cv2.IMWRITE_JPEG_QUALITY, 85])
    f2 = _annotate_pool.submit(cv2.imwrite, str(clean_path), img,   [cv2.IMWRITE_JPEG_QUALITY, 90])
    f3 = _annotate_pool.submit(cv2.imwrite, str(ann_path),   annotated, [cv2.IMWRITE_JPEG_QUALITY, 90])
    f1.result(); f2.result(); f3.result()

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
    """Process files as they arrive for this job.

    - Pipelined: up to MAX_INFLIGHT files are processed concurrently.
    - Robust on bulk batches: if a file fails because of a transient pod / proxy
      hiccup we re-queue it (up to MAX_FILE_ATTEMPTS) with backoff, so a 200–3000
      image job never loses files to short-lived 502/524s. Detection results
      are unchanged when a file finally succeeds — same model, same params.
    - Idle-based timeout instead of an absolute deadline so very large batches
      can run as long as they are making progress.
    """
    job = jobs.get(job_id)
    if not job:
        return

    loop = asyncio.get_event_loop()
    MAX_INFLIGHT = int(os.environ.get("MAX_INFLIGHT_FILES", "2"))
    MAX_FILE_ATTEMPTS = max(1, int(os.environ.get("MAX_FILE_ATTEMPTS", "4")))
    IDLE_TIMEOUT_SEC = max(60, int(os.environ.get("WORKER_IDLE_TIMEOUT_SEC", "1800")))  # 30 min

    last_progress_ts = time.time()

    # Errors we know are NOT recoverable by retrying — fail immediately so we
    # don't waste 4 attempts on the same broken input. Everything else is
    # treated as transient and re-queued (network blips, proxy 5xx, GPU OOM
    # spikes, RunPod restarts, etc) so a 200–3000 image batch never drops a
    # file to a one-off hiccup.
    PERMANENT_ERROR_NEEDLES = (
        "cannot decode image",
        "expects numpy arrays",
        "job not found",
        "weights file not found",
        "no such file or directory",
    )

    def _is_transient(err_text: str) -> bool:
        if not err_text:
            return True  # unknown -> retry
        e = err_text.lower()
        if any(n in e for n in PERMANENT_ERROR_NEEDLES):
            return False
        return True

    async def _emit_result(fid: str, fdata: dict, result: dict):
        fdata["status"] = "done"
        job["results"].append(result)
        job["completed"] += 1
        await sio.emit("detection_result", {
            "job_id": job_id,
            **result,
            "completed": job["completed"],
            "total": job["total"],
        })

    async def _emit_failure(fid: str, fdata: dict, err: str):
        fdata["status"] = "error"
        fdata["error"] = err
        job["completed"] += 1
        await sio.emit("detection_result", {
            "job_id": job_id, "file_id": fid, "filename": fdata["filename"],
            "error": err, "completed": job["completed"], "total": job["total"],
        })

    async def _handle_one(fid: str, fdata: dict):
        nonlocal last_progress_ts
        try:
            result = await loop.run_in_executor(
                None,
                process_file,
                job_id, fid, fdata["bytes"], fdata["filename"],
                job["confidence"], job["slice_size"], job["overlap"],
                loop,
            )

            if "error" in result:
                err_text = str(result["error"])
                attempts = int(fdata.get("attempts", 0)) + 1
                if _is_transient(err_text) and attempts < MAX_FILE_ATTEMPTS:
                    fdata["attempts"] = attempts
                    fdata["status"] = "pending"
                    fdata["next_retry_at"] = time.time() + min(2 ** attempts, 16)
                    print(f"[WARN] file {fdata['filename']} attempt {attempts} failed ({err_text}); requeueing")
                else:
                    await _emit_failure(fid, fdata, err_text)
            else:
                await _emit_result(fid, fdata, result)
            last_progress_ts = time.time()

        except Exception as e:
            err_text = str(e)
            attempts = int(fdata.get("attempts", 0)) + 1
            if _is_transient(err_text) and attempts < MAX_FILE_ATTEMPTS:
                fdata["attempts"] = attempts
                fdata["status"] = "pending"
                fdata["next_retry_at"] = time.time() + min(2 ** attempts, 16)
                print(f"[WARN] file {fdata['filename']} attempt {attempts} raised ({err_text}); requeueing")
            else:
                await _emit_failure(fid, fdata, err_text)
            last_progress_ts = time.time()
        finally:
            # Only drop the upload bytes when we're not going to retry this file.
            if fdata.get("status") != "pending":
                fdata.pop("bytes", None)

    inflight: set[asyncio.Task] = set()

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
            if inflight:
                await asyncio.gather(*inflight, return_exceptions=True)
            break

        # Fill up to MAX_INFLIGHT, skipping files whose backoff hasn't elapsed yet.
        now = time.time()
        while len(inflight) < MAX_INFLIGHT:
            picked = None
            for fid, fdata in job["files"].items():
                if fdata["status"] != "pending":
                    continue
                if fdata.get("next_retry_at", 0) > now:
                    continue
                fdata["status"] = "processing"
                picked = (fid, fdata)
                break
            if picked is None:
                break
            t = asyncio.create_task(_handle_one(picked[0], picked[1]))
            inflight.add(t)

        if not inflight:
            all_finished = (
                len(job["files"]) >= job["total"]
                and all(f["status"] in ("done", "error") for f in job["files"].values())
            )
            if all_finished:
                break
            # Idle timeout based on no progress for IDLE_TIMEOUT_SEC, NOT on
            # job age — large batches must run as long as they keep finishing.
            if time.time() - last_progress_ts > IDLE_TIMEOUT_SEC:
                break
            await asyncio.sleep(0.2)
            continue

        done, _pending = await asyncio.wait(inflight, return_when=asyncio.FIRST_COMPLETED)
        inflight -= done

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

    confidence = payload.get("det_confidence", 0.20)
    slice_size = payload.get("det_slice_size", 1280)
    overlap = payload.get("det_overlap", 0.25)
    nms_iou = float(payload.get("det_nms_iou", 0.10))
    full_imgsz = int(payload.get("det_full_imgsz", 1280))
    sahi_tiled = bool(payload.get("det_sahi_tiled", True))
    source = payload.get("source", "rgb")

    job = _new_job(
        total, confidence, slice_size, overlap,
        source=source,
        nms_iou=nms_iou,
        full_imgsz=full_imgsz,
        sahi_tiled=sahi_tiled,
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


def _batch_detect(model, frames: list[np.ndarray], confidence: float, imgsz: int = 1280) -> list[list[dict]]:
    """Run YOLO on a batch of frames (single batched GPU call)."""
    results = model.predict(
        frames, conf=confidence, device=DEVICE,
        imgsz=imgsz, verbose=False, **_yolo_predict_kw(),
    )
    per_frame: list[list[dict]] = []
    for r in results:
        dets = []
        for box in r.boxes:
            cls_id = int(box.cls[0])
            dets.append({
                "bbox": box.xyxy[0].tolist(),
                "confidence": float(box.conf[0]),
                "class_id": cls_id,
                "class_name": model.names.get(cls_id, str(cls_id)),
            })
        per_frame.append(dets)
    return per_frame


def _process_whole_video(job_id: str, file_id: str, tmp_path: str,
                         confidence: float, slice_size: int, overlap: float,
                         frame_interval: float,
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
            per_frame_dets = _batch_detect(model, batch, confidence, slice_size)

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

    # Build un-annotated browser video directly from the original upload to avoid
    # per-frame duplicate writes during inference.
    original_h264_path = out_dir / "original.mp4"
    if not _reencode_to_h264(str(tmp_path), str(original_h264_path), fps):
        try:
            shutil.copyfile(str(tmp_path), str(original_h264_path))
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


def _collect_detections_from_video_file(video_path: str, confidence: float, imgsz: int = 1280) -> list:
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
            per_frame_dets = _batch_detect(model, batch, confidence, imgsz)
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


def _backfill_stored_video_detections(file_id: str, video_path: str, confidence: float, imgsz: int = 1280) -> list:
    """Create detections.json for legacy runs that only have mp4 on disk."""
    lk = _video_det_backfill_lock(file_id)
    with lk:
        cached = _load_stored_video_detections(file_id)
        if cached:
            return cached
        lst = _collect_detections_from_video_file(video_path, confidence, imgsz)
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
        "confidence": payload.get("det_confidence", 0.20),
        "slice_size": payload.get("det_slice_size", 1280),
        "overlap": payload.get("det_overlap", 0.25),
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
async def api_video_stored_detections(file_id: str, confidence: float = 0.20, imgsz: int = 1280):
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
        lambda: _backfill_stored_video_detections(file_id, vpath, confidence, imgsz),
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
                "original_url": res.get("original_url"),
                "frames_url": res.get("frames_url"),
                "video_width": res.get("video_width"),
                "video_height": res.get("video_height"),
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
        "remote_inference_url": POD_INFERENCE_URL,
        "remote_inference_role": "YOLO/SAHI forward runs on the RunPod pod GPU (port 6006); this process orchestrates I/O and batching.",
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
