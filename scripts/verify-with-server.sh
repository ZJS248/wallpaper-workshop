#!/usr/bin/env bash
# ============================================================================
# 一次性把「起服务 → 跑全量自检 → 收服务」做完。
#
# 为什么需要它：在本机的工具环境里，一个命令的子进程会随该命令结束被回收，
# 所以"先起服务、再另开一条命令跑自检"是跑不通的（服务会被杀掉，
# 自检里全是 ERR_CONNECTION_REFUSED）。这个脚本把三件事放在同一个进程生命周期里。
#
#   bash scripts/verify-with-server.sh [轮数]
#
# 若 9391 上已经有服务在跑，就直接复用它（不会重复起、也不会去杀别人的进程）。
# ============================================================================
set -u
cd "$(dirname "$0")/.." || exit 1

ROUNDS="${1:-1}"
BASE="http://127.0.0.1:9391"
LOG="config/shots/verify-with-server.log"
mkdir -p config/shots

started=0
if curl -s -o /dev/null --max-time 3 "$BASE/api/session"; then
  echo "复用已经在跑的服务（$BASE）"
else
  echo "启动服务： node server.js"
  node server.js > "$LOG" 2>&1 &
  SERVER_PID=$!
  started=1
  for i in $(seq 1 40); do
    if curl -s -o /dev/null --max-time 2 "$BASE/api/session"; then break; fi
    sleep 0.5
  done
  if ! curl -s -o /dev/null --max-time 3 "$BASE/api/session"; then
    echo "服务没能起来，日志："
    tail -30 "$LOG"
    exit 2
  fi
  echo "服务已就绪（pid $SERVER_PID）"
fi

cleanup() {
  if [ "$started" = "1" ] && [ -n "${SERVER_PID:-}" ]; then
    kill "$SERVER_PID" 2>/dev/null
    wait "$SERVER_PID" 2>/dev/null
    echo "已停止服务（pid $SERVER_PID）"
  fi
}
trap cleanup EXIT

status=0
bash scripts/repeat-verify.sh "$ROUNDS" || status=$?
exit "$status"
