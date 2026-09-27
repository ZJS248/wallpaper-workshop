#!/usr/bin/env bash
# 语法自检：所有后端 JS + 前端脚本（前端是普通脚本，用 node --check 也能查语法）
set -u
cd "$(dirname "$0")/.."
fail=0
for f in server.js server/server.js server/routes.js server/lib/*.js src/*.js src/components/*.js scripts/*.js; do
  if node --check "$f" 2>/tmp/ww-syntax.err; then
    echo "OK    $f"
  else
    echo "FAIL  $f"
    sed 's/^/        /' /tmp/ww-syntax.err
    fail=1
  fi
done
exit $fail
