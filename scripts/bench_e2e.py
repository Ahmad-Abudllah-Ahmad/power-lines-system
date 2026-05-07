"""End-to-end timing: post a realistic image to /api/uploads/batch/start
and measure time-to-first-result. Uses the same defaults the UI sends
(conf=0.20, slice=1280, overlap=0.25, nms=0.10, full_imgsz=1280, sahi on).
"""
import io, json, time, sys
import urllib.request
import urllib.error
import numpy as np
import socketio
from PIL import Image

BASE = "http://127.0.0.1:8001"

def main():
    # 4032x3024 random image -> JPEG ~3-4 MB (realistic camera size)
    img = (np.random.rand(3024, 4032, 3) * 255).astype("uint8")
    buf = io.BytesIO()
    Image.fromarray(img).save(buf, format="JPEG", quality=88)
    raw = buf.getvalue()

    # 1) start a batch
    payload = {
        "total": 1,
        "model_id": "dota_1000ep_best",
        "det_confidence": 0.20,
        "det_slice_size": 1280,
        "det_overlap": 0.25,
        "det_nms_iou": 0.10,
        "det_full_imgsz": 1280,
        "det_sahi_tiled": True,
    }
    req = urllib.request.Request(
        f"{BASE}/api/uploads/batch/start",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        body = json.loads(r.read())
    job_id = body["job_id"]
    print(f"job_id = {job_id}")

    # 2) attach socket.io BEFORE uploading so we don't miss the result
    sio = socketio.Client(reconnection=False)
    got = {}

    @sio.on("detection_result")
    def _on_result(data):
        if data.get("job_id") == job_id:
            got["t"] = time.time()
            got["data"] = data
    @sio.on("detection_progress")
    def _on_prog(data):
        if data.get("job_id") == job_id:
            print(f"  progress: {data.get('percent')}%")

    sio.connect(BASE, wait_timeout=10)

    # 3) upload the file
    boundary = "----azeri" + str(int(time.time()))
    body_b = (
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"job_id\"\r\n\r\n{job_id}\r\n"
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"bench.jpg\"\r\n"
        f"Content-Type: image/jpeg\r\n\r\n"
    ).encode() + raw + f"\r\n--{boundary}--\r\n".encode()

    t_start = time.time()
    req2 = urllib.request.Request(
        f"{BASE}/api/uploads/file",
        data=body_b,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    with urllib.request.urlopen(req2, timeout=60) as r:
        _ = r.read()
    t_uploaded = time.time()
    print(f"upload accepted in {(t_uploaded-t_start)*1000:.0f} ms")

    # 4) wait for detection_result
    deadline = time.time() + 90
    while not got and time.time() < deadline:
        sio.sleep(0.05)
    if not got:
        print("TIMEOUT: no result in 90s", file=sys.stderr)
        sio.disconnect()
        sys.exit(2)

    dt = (got["t"] - t_start) * 1000
    n = len(got["data"].get("detections") or [])
    stats = got["data"].get("stats") or {}
    print(f"\n>>> e2e time-to-result: {dt:.0f} ms")
    print(f">>> server processing_time_ms: {stats.get('processing_time_ms')}")
    print(f">>> detections: {n}")
    sio.disconnect()

if __name__ == "__main__":
    main()
