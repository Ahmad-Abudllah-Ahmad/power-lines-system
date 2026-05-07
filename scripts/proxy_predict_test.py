"""Time a real /predict round-trip through the RunPod HTTPS proxy so we can see
whether the proxy is reliably under 100s (Cloudflare 524 limit)."""
import io, os, time, requests
import numpy as np
from PIL import Image

_BASE = os.environ.get(
    "POD_INFERENCE_URL",
    "https://ycfjp6tp0zl9xf-64410b2b-6006.proxy.runpod.net",
).rstrip("/")
URL = f"{_BASE}/predict"

def make(w, h):
    img = (np.random.rand(h, w, 3) * 255).astype("uint8")
    buf = io.BytesIO()
    Image.fromarray(img).save(buf, format="JPEG", quality=85)
    return buf.getvalue()

def call(n_imgs, hw, imgsz):
    data = make(*hw)
    files = [("files", (f"a{i}.jpg", data, "image/jpeg")) for i in range(n_imgs)]
    t = time.time()
    r = requests.post(URL, files=files, data={"conf":"0.20","imgsz":str(imgsz),"half":"1"}, timeout=120)
    dt = (time.time()-t)*1000
    print(f"n={n_imgs} hw={hw} imgsz={imgsz}  -> {dt:6.0f} ms  status={r.status_code}")

# Warm
call(1, (1280,1280), 1280)
# Realistic single full image
call(1, (3024,4032), 1280)
# Worst-case: full image + 9 slices in one batch (matches the new fast-path)
call(10, (1280,1280), 1280)
# What the SAHI pass alone might send
call(20, (1280,1280), 1280)
