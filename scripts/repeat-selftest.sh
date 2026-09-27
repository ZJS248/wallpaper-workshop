#!/usr/bin/env bash
# 反复跑后端自检，确认在"前一个自检刚打完 Steam"的情况下也稳定
cd "$(dirname "$0")/.." || exit 1
N="${1:-3}"
fails=0
for i in $(seq 1 "$N"); do
  echo "===== 第 $i 次 ====="
  out=$(node scripts/selftest.js 2>&1)
  echo "$out" | tail -1
  if echo "$out" | grep -q '0 失败'; then
    : # ok
  else
    fails=$((fails+1))
    echo "$out" | grep -E '✗' || true
  fi
  sleep 5
done
echo ""
echo "结果：$N 次里 $fails 次有失败"
exit "$fails"
