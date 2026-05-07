tail -25 /workspace/inference_server.log
echo '---procs---'
ps -eo etime,pcpu,pmem,cmd | grep inference_server.py | grep -v grep
echo '---gpu---'
nvidia-smi --query-gpu=utilization.gpu,memory.used --format=csv,noheader
