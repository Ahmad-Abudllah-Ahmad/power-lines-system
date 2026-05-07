echo '=== gpu ==='
nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader
echo '=== proc ==='
ps -eo pid,etime,pcpu,pmem,cmd | grep inference_server.py | grep -v grep || echo 'NOT RUNNING'
echo '=== port 6006 listening ==='
ss -tlnp 2>/dev/null | grep ':6006' || echo 'port NOT listening'
echo '=== local /predict timing (no proxy) ==='
python - <<'PY'
import time, requests, io
import numpy as np
from PIL import Image
img = (np.random.rand(1280,1280,3)*255).astype('uint8')
buf = io.BytesIO(); Image.fromarray(img).save(buf, format='JPEG', quality=78)
data = buf.getvalue()
files = [('files', (f'a{i}.jpg', data, 'image/jpeg')) for i in range(21)]  # full + slices like prod
t0 = time.time()
r = requests.post('http://127.0.0.1:6006/predict', files=files, data={'conf':'0.20','imgsz':'1280','half':'1'}, timeout=120)
dt = (time.time()-t0)*1000
print(f"21-image batch (1280) on pod-localhost -> {dt:.0f} ms  status={r.status_code}")
PY
echo '=== last 15 log lines ==='
tail -15 /workspace/inference_server.log
