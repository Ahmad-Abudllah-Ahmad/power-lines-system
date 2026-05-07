echo "=== ultralytics/fastapi/uvicorn versions ==="
python - <<'PY'
mods = ["ultralytics","fastapi","uvicorn","torch"]
import importlib
for m in mods:
    try:
        x = importlib.import_module(m)
        print(m, getattr(x,"__version__","?"))
    except Exception as e:
        print(m, "MISSING", e)
PY
echo "=== ports ==="
ss -tlnp 2>/dev/null | grep -E ':(6006|8000|8001|8888)' || true
echo "=== weights ==="
ls -lah /workspace/project/runs/obb/yolo11x_obb_dota_20260426_060214/weights/best.pt
echo "=== gpu ==="
nvidia-smi -L | head -2
echo "=== existing servers ==="
ps -eo pid,cmd | grep -E '(uvicorn|tensorboard|jupyter|fastapi|inference_server)' | grep -v grep || true
