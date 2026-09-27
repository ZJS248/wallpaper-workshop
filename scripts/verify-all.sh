#!/usr/bin/env bash
# ============================================================================
# 一键全量自检
#
#   bash scripts/verify-all.sh
#
# 覆盖：
#   1. 语法检查（前后端所有 js）
#   2. 静态资源可达性
#   3. 离线解析器单测（用真实抓下来的 HTML 样本，不联网）
#   4. 分页组装回归（每页 30/60/100、时间窗、合并请求数、作者页）
#   5. 后端业务自检（真实打 Steam：排序/筛选/搜索/详情/作者）
#   6. 筛选契约回归（报告 BUG-03/04/07/11/13/14 等）
#   7. 浏览器渲染自检（无头 Chrome：Vue 挂载、卡片、图片、无 JS 报错）
#   8. 浏览器交互自检（CDP：点卡片/详情/相关壁纸/排序/筛选/搜索/分页/设置）
#   9. 分辨率多选修复复现（CDP）
#  10. 分页与每页条数 UI（CDP）
#  11. 宿主接入自检（iframe + postMessage 传 Cookie 与命令）
#
# 前置：服务已在 9391 跑着（node server.js）
# ============================================================================
cd "$(dirname "$0")/.." || exit 1

BASE="${WW_BASE:-http://127.0.0.1:9391}"
FAILED=0
declare -a RESULTS

step() {
  local name="$1"; shift
  echo ""
  echo "############################################################"
  echo "# $name"
  echo "############################################################"
  if "$@"; then
    RESULTS+=("OK    $name")
  else
    RESULTS+=("FAIL  $name")
    FAILED=$((FAILED + 1))
  fi
}

# ---- 0. 确认服务在跑 ----
if ! curl -s -o /dev/null --max-time 5 "$BASE/api/session"; then
  echo "服务没在 $BASE 上跑。先执行： node server.js"
  exit 2
fi

# 清掉上一次自检可能留下的运行时登录态（例如宿主接入自检注入的假 Cookie），
# 让每一次全量自检都从"配置文件里的真实登录态"开始，避免相互污染。
curl -s -X DELETE "$BASE/api/session" > /dev/null

step "1. 语法与静态资源" bash scripts/check-frontend.sh
step "2. 离线解析器单测" node scripts/test-parser-offline.js
step "3. 筛选语义（同类目 OR / 跨类目 AND）" node scripts/test-filter-semantics.js
step "4. 分页组装（30/60/100 + 时间窗 + 合并请求数）" node scripts/test-paging.js
step "5. 后端业务自检（真实打 Steam）" node scripts/selftest.js
step "6. 修复项契约回归（评分/作者/分页/方法校验）" node scripts/test-report-fixes.js
step "7. 浏览器渲染自检" node scripts/browser-check.js
step "8. 浏览器交互自检（CDP）" node scripts/cdp-check.js
step "9. 分辨率多选修复复现（CDP）" node scripts/cdp-resolution-check.js
step "10. 每页条数与时间窗 UI（CDP）" node scripts/cdp-pagesize-check.js
step "11. 宿主接入自检（iframe + postMessage）" node scripts/cdp-host-check.js

# 收尾再清一次，保证服务回到"真实登录态"
curl -s -X DELETE "$BASE/api/session" > /dev/null

echo ""
echo "============================================================"
echo "                 全量自检汇总"
echo "============================================================"
for r in "${RESULTS[@]}"; do echo "  $r"; done
echo ""
if [ "$FAILED" -eq 0 ]; then
  echo "  → 全部通过 ✓"
else
  echo "  → $FAILED 项失败 ✗"
fi
exit "$FAILED"
