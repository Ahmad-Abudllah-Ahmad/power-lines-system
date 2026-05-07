"""Benchmark RemoteYOLO.predict end-to-end through the proxy with parallel
chunked uploads. Times exactly the number of round-trips a single SAHI image
incurs at full_imgsz=slice=1280 (1 full + 20 slices = 21 images)."""
import io, time, sys, os
import numpy as np
import cv2

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))
os.environ.setdefault("REMOTE_PREDICT_CHUNK", "10")
os.environ.setdefault("REMOTE_PREDICT_PARALLEL", "4")

from server import RemoteYOLO, POD_INFERENCE_URL  # noqa: E402

m = RemoteYOLO(POD_INFERENCE_URL)
print(f"loaded {len(m.names)} class names from pod")

# 21 BGR images at 1280
imgs = [(np.random.rand(1280, 1280, 3) * 255).astype("uint8") for _ in range(21)]

# Warm
m.predict(imgs[:1], conf=0.20, imgsz=1280, half=True)

for trial in range(3):
    t0 = time.time()
    out = m.predict(imgs, conf=0.20, imgsz=1280, half=True)
    dt = (time.time() - t0) * 1000
    n_dets = sum(len(r.boxes) for r in out)
    print(f"trial {trial+1}: 21 imgs @1280  ->  {dt:7.0f} ms   total dets={n_dets}")
