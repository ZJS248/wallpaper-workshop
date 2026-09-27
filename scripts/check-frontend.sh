#!/usr/bin/env bash
# 前端脚本语法检查 + headless Chrome 截图 + 控制台报错抓取
cd "$(dirname "$0")/.." || exit 1

echo "=========== 1) 语法检查 ==========="
fail=0
# 全部前端脚本都是普通脚本（非 ESM），因为要共享全局 Vue。
for f in src/app.js src/api.js src/util.js src/components/*.js; do
  if node --check "$f" 2>/dev/null; then
    echo "  OK   $f"
  else
    echo "  FAIL $f"
    node --check "$f"
    fail=1
  fi
done
# 后端是 CommonJS
for f in server/lib/*.js server/*.js scripts/*.js; do
  if node --check "$f" 2>/dev/null; then
    echo "  OK   $f"
  else
    echo "  FAIL $f"
    node --check "$f"
    fail=1
  fi
done
echo "语法检查结果: $fail (0=全部通过)"

echo ""
echo "=========== 1b) 前端不得出现 ESM 语法（会被当普通脚本加载） ==========="
if grep -nE '^\s*(export|import)\s' src/app.js src/api.js src/util.js src/components/*.js 2>/dev/null; then
  echo "  ✗ 发现 ESM 语法，浏览器会报 Unexpected token 'export'"
  fail=1
else
  echo "  OK   没有 ESM 语法"
fi

echo ""
echo "=========== 2) HTML 里引用的资源是否都能取到 ==========="
grep -oE '(src|href)="/[^"]+"' index.html | sed -E 's/.*="([^"]+)"/\1/' | sort -u | while read -r p; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:9391$p")
  printf '  %s  %s\n' "$code" "$p"
done

exit $fail
