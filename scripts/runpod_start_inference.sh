#!/usr/bin/env bash
# Run on the pod (e.g. Web Terminal or SSH). Frees TCP 6006 if another demo grabbed it, then starts
# the FastAPI server from /workspace/inference_server.py (synced from repo scripts/pod_inference_server.py).
set -euo pipefail
pkill -f '/workspace/inference_server.py' 2>/dev/null || true
for pid in $(ss -tlnp 2>/dev/null | grep ':6006' | sed -n 's/.*pid=\([0-9]*\).*/\1/p'); do
  kill -9 "$pid" 2>/dev/null || true
done
fuser -k 6006/tcp 2>/dev/null || true
sleep 2
cd /workspace
export PORT="${PORT:-6006}"
nohup python3 -u inference_server.py >> inference_server.log 2>&1 &
echo "Started inference PID=$! (PORT=$PORT). Tail: tail -f /workspace/inference_server.log"
