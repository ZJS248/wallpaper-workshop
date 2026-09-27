#!/usr/bin/env bash
# 冒烟：确认各测试脚本在没有"上次留下的样本文件"时也能独立跑通
cd "$(dirname "$0")/.." || exit 1

echo "--- config 目录当前内容 ---"
ls -A config/ 2>/dev/null || echo "(空)"

echo ""
echo "--- 离线解析器单测（不依赖任何样本文件）---"
node scripts/test-parser-offline.js > /dev/null 2>&1
echo "exit=$? （0 = 通过）"

echo ""
echo "--- 浏览器渲染自检（会自己创建 config/shots）---"
node scripts/browser-check.js 2>&1 | tail -3
