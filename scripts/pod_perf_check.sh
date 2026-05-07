echo '=== gpu ==='
nvidia-smi --query-gpu=name,memory.total,memory.used,utilization.gpu --format=csv,noheader
echo '=== pod proc ==='
ps -eo pid,etime,pcpu,pmem,cmd | grep inference_server.py | grep -v grep || echo 'NOT RUNNING'
echo '=== last 30 log lines ==='
tail -30 /workspace/inference_server.log
echo '=== single-image timing (640) ==='
python - <<'PY'
import time, requests, io
import numpy as np
from PIL import Image
img = (np.random.rand(2000,3000,3)*255).astype('uint8')
buf = io.BytesIO()
Image.fromarray(img).save(buf, format='JPEG', quality=85)
data = buf.getvalue()
URL = 'http://127.0.0.1:6006/predict'
# warm
r = requests.post(URL, files={'files': ('a.jpg', data, 'image/jpeg')}, data={'conf':'0.20','imgsz':'640','half':'1'}, timeout=60)
# measure
t0=time.time(); r = requests.post(URL, files={'files': ('a.jpg', data, 'image/jpeg')}, data={'conf':'0.20','imgsz':'640','half':'1'}, timeout=60); dt=(time.time()-t0)*1000
print(f"imgsz=640 single  -> {dt:.0f} ms  status={r.status_code}")
t0=time.time(); r = requests.post(URL, files={'files': ('a.jpg', data, 'image/jpeg')}, data={'conf':'0.20','imgsz':'1280','half':'1'}, timeout=60); dt=(time.time()-t0)*1000
print(f"imgsz=1280 single -> {dt:.0f} ms  status={r.status_code}")
files = [('files', (f'a{i}.jpg', data, 'image/jpeg')) for i in range(8)]
t0=time.time(); r = requests.post(URL, files=files, data={'conf':'0.20','imgsz':'1280','half':'1'}, timeout=120); dt=(time.time()-t0)*1000
print(f"imgsz=1280 batch=8 -> {dt:.0f} ms total / {dt/8:.0f} ms/img  status={r.status_code}")
files = [('files', (f'a{i}.jpg', data, 'image/jpeg')) for i in range(32)]
t0=time.time(); r = requests.post(URL, files=files, data={'conf':'0.20','imgsz':'1280','half':'1'}, timeout=180); dt=(time.time()-t0)*1000
print(f"imgsz=1280 batch=32-> {dt:.0f} ms total / {dt/32:.0f} ms/img  status={r.status_code}")
PY
