#!/usr/bin/env bash
# 连打 N 次浏览页，统计有多快会触发限流/精简页。
# 用来给 httpClient 的 MIN_GAP_MS 定一个靠谱的值。
cd "$(dirname "$0")/.." || exit 1
N="${1:-25}"
GAP_MS="${2:-1200}"
GAP_S=$(awk "BEGIN{printf \"%.3f\", $GAP_MS/1000}")

echo "间隔 ${GAP_MS}ms，连续 $N 次 /api/browse"
echo ""

ok=0; deg=0; err=0
for i in $(seq 1 "$N"); do
  body=$(curl -s --max-time 60 "http://127.0.0.1:9391/api/browse?sort=trend&days=7&page=$i&pageSize=24")
  if echo "$body" | grep -q '"ok":true,"data":{"ok":true'; then
    total=$(echo "$body" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);console.log((j.data.items||[]).length+' 条')}catch(e){console.log('?')}});")
    printf '  %2d  OK    %s\n' "$i" "$total"
    ok=$((ok+1))
  else
    reason=$(echo "$body" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);console.log(j.error||j.data.error||'未知')}catch(e){console.log('非 JSON')}});")
    printf '  %2d  FAIL  %s\n' "$i" "$reason"
    if echo "$reason" | grep -q '精简页'; then deg=$((deg+1)); else err=$((err+1)); fi
  fi
  sleep "$GAP_S"
done

echo ""
echo "结果：成功 $ok / 精简页 $deg / 其它错误 $err（共 $N）"
