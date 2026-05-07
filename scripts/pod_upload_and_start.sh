cat > /workspace/inference_server.b64 <<'B64DATA_END_MARKER'
__BASE64_PLACEHOLDER__
B64DATA_END_MARKER
base64 -d /workspace/inference_server.b64 > /workspace/inference_server.py
rm /workspace/inference_server.b64
wc -l /workspace/inference_server.py
md5sum /workspace/inference_server.py
echo '--- (re)starting inference server on :6006 ---'
pkill -f 'inference_server.py' || true
pkill -f 'tensorboard' || true
sleep 1
cd /workspace
nohup python -u /workspace/inference_server.py > /workspace/inference_server.log 2>&1 &
echo "PID=$!"
sleep 2
echo '--- log so far ---'
tail -20 /workspace/inference_server.log || true
echo '--- listening ports ---'
ss -tlnp 2>/dev/null | grep -E ':(6006|8000)' || true
