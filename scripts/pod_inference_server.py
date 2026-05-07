"""
RunPod-side inference server for the Azeri Energy Dashboard.

Loads the OBB YOLOv11x DOTA model from /workspace/.../best.pt and exposes:
  GET  /          health
  GET  /names     class id -> name map
  POST /predict   multipart with one or more 'files' parts; runs YOLO and returns AABB detections

Returned detections (per image) shape:
  [ { "cls": int, "conf": float, "xyxy": [x1,y1,x2,y2] }, ... ]

OBB results are converted to axis-aligned outer rectangles so the existing
Azeri dashboard frontend (which draws axis-aligned boxes) continues to work
without any changes.
"""

from __future__ import annotations

import io
import os
import threading
from typing import List

import cv2
import numpy as np
import torch
import uvicorn
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import JSONResponse
from PIL import Image
from ultralytics import YOLO


WEIGHTS = os.environ.get(
    "YOLO_WEIGHTS",
    "/workspace/project/runs/obb/yolo11x_obb_dota_20260426_060214/weights/best.pt",
)
PORT = int(os.environ.get("PORT", "6006"))
DEVICE = "cuda:0" if torch.cuda.is_available() else "cpu"

# Prime CUDA/cuDNN before Ultralytics touches conv layers (avoids CUDNN_STATUS_NOT_INITIALIZED on some H200/driver combos).
if DEVICE != "cpu":
    try:
        torch.cuda.init()
        torch.cuda.set_device(0)
        _ = torch.zeros(1, device=DEVICE)
        _ = torch.randn(1, 3, 64, 64, device=DEVICE)
        torch.cuda.synchronize()
    except Exception as _e:
        print(f"[POD] CUDA prime failed: {_e}", flush=True)

if torch.cuda.is_available():
    # Warm benchmark after first successful conv (benchmark=True too early can worsen cuDNN init on some GPUs).
    torch.backends.cudnn.benchmark = False
    torch.backends.cuda.matmul.allow_tf32 = True
    torch.backends.cudnn.allow_tf32 = True
    try:
        torch.set_float32_matmul_precision("high")
    except Exception:
        pass

app = FastAPI(title="Pod Inference Server")

_model_lock = threading.Lock()
_model: YOLO | None = None
_names: dict[int, str] = {}


def _decode(blob: bytes) -> np.ndarray:
    """JPEG/PNG bytes -> BGR numpy (matches what the local backend feeds Ultralytics)."""
    arr = np.frombuffer(blob, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is not None:
        return img
    rgb = Image.open(io.BytesIO(blob)).convert("RGB")
    return np.array(rgb)[..., ::-1].copy()


def _result_to_aabb(r) -> list[dict]:
    """Ultralytics result -> list of axis-aligned dets, regardless of detect/OBB head."""
    out: list[dict] = []
    obb = getattr(r, "obb", None)
    if obb is not None and len(obb) > 0:
        polys = obb.xyxyxyxy.detach().cpu().numpy()
        confs = obb.conf.detach().cpu().numpy()
        clss = obb.cls.detach().cpu().numpy().astype(int)
        for i in range(len(polys)):
            xs = polys[i][:, 0]
            ys = polys[i][:, 1]
            out.append({
                "cls": int(clss[i]),
                "conf": float(confs[i]),
                "xyxy": [float(xs.min()), float(ys.min()), float(xs.max()), float(ys.max())],
            })
        return out
    boxes = getattr(r, "boxes", None)
    if boxes is not None and len(boxes) > 0:
        xyxy = boxes.xyxy.detach().cpu().numpy()
        confs = boxes.conf.detach().cpu().numpy()
        clss = boxes.cls.detach().cpu().numpy().astype(int)
        for i in range(len(xyxy)):
            out.append({
                "cls": int(clss[i]),
                "conf": float(confs[i]),
                "xyxy": [float(xyxy[i][0]), float(xyxy[i][1]), float(xyxy[i][2]), float(xyxy[i][3])],
            })
    return out


def get_model() -> YOLO:
    global _model, _names
    if _model is None:
        with _model_lock:
            if _model is None:
                print(f"[POD] Loading {WEIGHTS} on {DEVICE}", flush=True)
                m = YOLO(WEIGHTS)
                try:
                    m.fuse()
                except Exception as e:
                    print(f"[POD] fuse() skipped: {e}", flush=True)
                if DEVICE != "cpu":
                    m.to(DEVICE)
                    dummy = [np.zeros((640, 640, 3), dtype=np.uint8)]

                    def _warm() -> None:
                        with torch.inference_mode():
                            with torch.amp.autocast("cuda", dtype=torch.float16):
                                m.predict(dummy, imgsz=640, device=DEVICE, half=True, verbose=False)
                        torch.cuda.synchronize()

                    try:
                        _warm()
                    except RuntimeError as e:
                        es = str(e).lower()
                        if "cudnn" in es:
                            print("[POD] Warmup failed with cuDNN; using non-cudnn conv (still on GPU)", flush=True)
                            torch.backends.cudnn.enabled = False
                            torch.backends.cudnn.benchmark = False
                            _warm()
                        else:
                            raise
                    torch.backends.cudnn.benchmark = True
                names = m.names
                if isinstance(names, dict):
                    _names = {int(k): str(v) for k, v in names.items()}
                else:
                    _names = {int(i): str(n) for i, n in enumerate(names)}
                _model = m
                print(f"[POD] Model ready. {len(_names)} classes: {list(_names.values())[:8]}...", flush=True)
    return _model


@app.get("/")
def root():
    return {"ok": True, "service": "pod-inference", "device": DEVICE, "weights": WEIGHTS, "loaded": _model is not None}


@app.get("/names")
def names():
    get_model()
    return _names


@app.post("/predict")
async def predict(
    files: List[UploadFile] = File(...),
    conf: float = Form(0.25),
    imgsz: int = Form(640),
    half: int = Form(1),
):
    model = get_model()
    imgs = []
    for f in files:
        data = await f.read()
        imgs.append(_decode(data))
    half_flag = bool(int(half)) and DEVICE != "cpu"
    with torch.inference_mode():
        if half_flag:
            with torch.amp.autocast("cuda", dtype=torch.float16):
                results = model.predict(
                    imgs,
                    conf=float(conf),
                    imgsz=int(imgsz),
                    device=DEVICE,
                    half=True,
                    verbose=False,
                )
        else:
            results = model.predict(
                imgs,
                conf=float(conf),
                imgsz=int(imgsz),
                device=DEVICE,
                half=False,
                verbose=False,
            )
    out = [_result_to_aabb(r) for r in results]
    return JSONResponse({"detections": out, "count": len(out)})


if __name__ == "__main__":
    print(f"[POD] starting on 0.0.0.0:{PORT}", flush=True)
    get_model()
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="info")
