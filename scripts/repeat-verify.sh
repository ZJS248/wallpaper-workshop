#!/usr/bin/env bash
# 连续跑 N 轮全量自检（默认 2 轮），确认没有偶发/互相污染。
# 用法：bash scripts/repeat-verify.sh [轮数]
set -u
cd "$(dirname "$0")/.." || exit 1
ROUNDS="${1:-2}"
bad=0
for i in $(seq 1 "$ROUNDS"); do
  echo ""
  echo "==================== 第 $i / $ROUNDS 轮 ===================="
  if bash scripts/verify-all.sh > "config/shots/verify-round-$i.log" 2>&1; then
    echo "第 $i 轮：全部通过 ✓"
    grep -E '^  (OK|FAIL)' "config/shots/verify-round-$i.log" | sed 's/^/    /'
  else
    echo "第 $i 轮：有失败 ✗  —— 明细见 config/shots/verify-round-$i.log"
    grep -E '^  (OK|FAIL)' "config/shots/verify-round-$i.log" | sed 's/^/    /'
    grep -E '^\s+✗' "config/shots/verify-round-$i.log" | sed 's/^/      /'
    bad=$((bad + 1))
  fi
done
echo ""
if [ "$bad" -eq 0 ]; then
  echo "全部 $ROUNDS 轮通过 ✓"
else
  echo "$bad / $ROUNDS 轮有失败 ✗"
fi
exit "$bad"
