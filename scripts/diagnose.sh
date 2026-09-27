#!/usr/bin/env bash
# 无头 Chrome 打开诊断页，把 <pre id="diag"> / <pre id="diag2"> 的内容读出来
cd "$(dirname "$0")/.." || exit 1
URL="${1:-http://127.0.0.1:9391/diagnose.html}"

CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
[ -f "$CHROME" ] || CHROME="/c/Program Files (x86)/Google/Chrome/Application/chrome.exe"
[ -f "$CHROME" ] || { echo "找不到 Chrome"; exit 0; }

PROFILE=$(mktemp -d)
OUT="config/shots/diagnose-dom.html"

"$CHROME" --headless=new --disable-gpu --no-first-run --no-default-browser-check \
  --user-data-dir="$PROFILE" --window-size=1600,900 --virtual-time-budget=20000 \
  --dump-dom "$URL" > "$OUT" 2>/dev/null

node - "$OUT" <<'NODE'
const fs = require('fs');
const html = fs.readFileSync(process.argv[2], 'utf8');
function grab(id) {
  const re = new RegExp('<pre id="' + id + '"[^>]*>([\\s\\S]*?)</pre>');
  const m = html.match(re);
  if (!m) return '(没有 ' + id + ')';
  return m[1]
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}
console.log('========== 脚本报错 ==========');
console.log(grab('diag') || '(无)');
console.log('\n========== 页面快照 ==========');
console.log(grab('diag2'));
NODE
