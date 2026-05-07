echo '--- proc ---'
ps -eo pid,etime,cmd | grep inference_server.py | grep -v grep || echo 'NOT RUNNING'
echo '--- log tail ---'
tail -40 /workspace/inference_server.log
echo '--- port ---'
ss -tlnp 2>/dev/null | grep -E ':(6006)' || echo 'port 6006 NOT listening'
echo '--- localhost test ---'
curl -fsS --max-time 5 http://127.0.0.1:6006/ || echo 'curl failed'
