#!/usr/bin/env bash
# 验证"运行时注入 Cookie"这条路真的覆盖了配置文件里的值
BASE="${1:-http://127.0.0.1:9391}"
FAKE='sessionid=hostdemo123456; steamLoginSecure=76561198374255138||fake.jwt.token.for.test'

echo "FAKE 长度: ${#FAKE}"
echo ""
echo "--- 注入前 ---"
curl -s "$BASE/api/session" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);const d=j.data||j;console.log('source='+d.source+' cookieLength='+d.cookieLength);});"

echo ""
echo "--- POST 注入 ---"
curl -s -X POST "$BASE/api/session" -H 'Content-Type: application/json' \
  --data-binary "$(node -e "console.log(JSON.stringify({cookie: process.argv[1]}))" "$FAKE")" \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);const d=j.data||j;console.log('source='+d.source+' cookieLength='+d.cookieLength);});"

echo ""
echo "--- 注入后 ---"
curl -s "$BASE/api/session" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);const d=j.data||j;console.log('source='+d.source+' cookieLength='+d.cookieLength);});"

echo ""
echo "--- 清除后（应回落到父项目文件）---"
curl -s -X DELETE "$BASE/api/session" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);const d=j.data||j;console.log('source='+d.source+' cookieLength='+d.cookieLength);});"
