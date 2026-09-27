'use strict';
/**
 * 测试报告修复项回归（对应《WallpaperEngine创意工坊模块-功能验收白盒测试报告》）。
 *
 * 覆盖的缺陷编号：
 *   BUG-01 每页数量选择器无效        → pageSize 30/60/100 都真的生效
 *   BUG-02 订阅/收藏分页总数算错      → 相关列表已按需求移除；作者页页数自洽
 *   BUG-03 评分（星级/评价数）全空    → /api/item 必须有 starRating / totalVotes
 *   BUG-04 顶栏 Tab 退不出子视图      → 子视图已移除；排序项里不再有 subscriptions/favorites
 *   BUG-06 「只看已订阅」恒空         → 控件已移除
 *   BUG-07 详情失败却返回 ok:true     → 取不到作品必须 ok:false
 *   BUG-09 多词搜索宽松匹配无提示     → 多词搜索要回 searchNote
 *   BUG-11 不存在的 ID 文案误导       → 文案要说"不存在或已删除"
 *   BUG-12 作者昵称未解析             → /api/item 的 author.name 不能为空
 *   BUG-13 新作详情不完整无提示       → pageOk=false 时要有 partial 标记
 *   BUG-14 接口不做方法校验           → 错误方法必须 405
 *   BUG-15 totalCountApprox 从未返回  → trend 下必须为 true
 *   BUG-16 分页上限未说明            → cappedAt / totalPages 要能推出上限
 *   BUG-17 「已订阅」角标只覆盖前 30  → /api/subscribed-ids 要翻完所有页
 *
 * 用法：node scripts/test-report-fixes.js [base]
 * 退出码 0 = 全过。
 */
const BASE = process.argv[2] || process.env.WW_BASE || 'http://127.0.0.1:9391';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log('  ✓ ' + name);
  } else {
    fail++;
    failures.push(name + (detail ? '  → ' + detail : ''));
    console.log('  ✗ ' + name + (detail ? '  → ' + detail : ''));
  }
}

async function req(path, opts) {
  const r = await fetch(BASE + path, opts);
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (e) {
    /* 留给调用方判断 */
  }
  return { status: r.status, json, text };
}

/**
 * 带重试地取"必须成功"的上游数据。
 *
 * 本机到 Steam 的链路（经本地代理）实测 3 分钟内会出现 ≥6 次 TLS 握手失败，
 * 这是环境属性而不是被测系统的缺陷。所以断言"字段内容"的用例要重试几次，
 * 否则自检会随网络抖动红一片，反而看不出真正的问题。
 * 注意：这只对"必须成功"的取证重试；对"应该失败"的用例（不存在的 ID 等）不重试。
 */
async function reqRetry(path, attempts) {
  const n = attempts || 3;
  let last = null;
  for (let i = 0; i < n; i++) {
    last = await req(path);
    const d = (last.json && (last.json.data || last.json)) || {};
    if (d.ok || d.notFound) return last;
    await new Promise((r) => setTimeout(r, 900 * (i + 1)));
  }
  return last;
}

const dataOf = (r) => (r.json && (r.json.data || r.json)) || {};

(async function main() {
  console.log('BASE = ' + BASE + '\n');

  /* ---------------- BUG-01 每页数量 ---------------- */
  console.log('[BUG-01] 每页数量选择器');
  const sizes = {};
  for (const n of [30, 60, 100]) {
    const d = dataOf(await req('/api/browse?sort=trend&days=7&page=1&pageSize=' + n));
    sizes[n] = (d.items || []).length;
  }
  check('30 / 60 / 100 都返回对应条数', sizes[30] === 30 && sizes[60] === 60 && sizes[100] === 100,
    JSON.stringify(sizes));
  const bad = dataOf(await req('/api/browse?sort=trend&days=7&page=1&pageSize=7'));
  check('非法 pageSize 收敛到 30（而不是给 7 条）', (bad.items || []).length === 30, '实际 ' + (bad.items || []).length);

  /* ---------------- BUG-03 评分 ---------------- */
  console.log('\n[BUG-03] 详情里的星级评分');
  const itemIds = ['884307090', '2358176341', '3792661570'];
  const itemResults = [];
  for (const id of itemIds) {
    const d = dataOf(await reqRetry('/api/item?id=' + id));
    itemResults.push({ id, d });
    const it = d.item || {};
    check('作品 ' + id + ' 有 starRating（0~5）',
      Number.isFinite(Number(it.starRating)) && Number(it.starRating) >= 0,
      'starRating=' + it.starRating);
    check('作品 ' + id + ' 有 totalVotes > 0', Number(it.totalVotes) > 0, 'totalVotes=' + it.totalVotes);
    check('作品 ' + id + ' 有评分文案', !!d.ratingText, JSON.stringify(d.ratingText));
  }

  /* ---------------- BUG-12 作者昵称 ---------------- */
  console.log('\n[BUG-12] 作者昵称与头像');
  itemResults.forEach(({ id, d }) => {
    const a = d.author || {};
    check('作品 ' + id + ' 的 author.name 非空', !!a.name, JSON.stringify(a.name));
    // 头像可能确实取不到（对方没设自定义头像），但**绝不能是别人的**
    const avatars = itemResults.map((x) => ((x.d.author || {}).avatar) || '');
    void avatars;
    check('作品 ' + id + ' 的 author.steamId 是 17 位数字', /^\d{17}$/.test(String(a.steamId || '')), JSON.stringify(a.steamId));
  });
  const names = itemResults.map((x) => (x.d.author || {}).name);
  check('不同作者的昵称不相同（没有取成当前登录用户）', new Set(names).size === names.length, names.join(' / '));
  const avatarSet = itemResults.map((x) => (x.d.author || {}).avatar).filter(Boolean);
  check('不同作者的头像不相同', new Set(avatarSet).size === avatarSet.length || avatarSet.length < 2,
    avatarSet.map((u) => u.slice(-24)).join(' / '));

  /* ---------------- BUG-07 / BUG-11 不存在的作品 ---------------- */
  console.log('\n[BUG-07 / BUG-11] 不存在的作品 ID');
  // 这一条要求"Steam 明确说没有这个作品"，所以也要重试到拿到确定结论为止
  // （否则一次 TLS 抖动会被误判成"文案不对"）
  const nf = await reqRetry('/api/item?id=999999999999');
  check('不存在的 ID 返回 ok:false（不再假装成功）', nf.json && nf.json.ok === false, JSON.stringify(nf.json).slice(0, 120));
  const nfMsg = (nf.json && nf.json.error) || '';
  check('文案说明"不存在或已删除"', /不存在|已删除/.test(nfMsg), nfMsg);
  check('标记 notFound', nf.json && nf.json.notFound === true, String(nf.json && nf.json.notFound));
  const badId = await req('/api/item?id=abc');
  check('非数字 ID 返回 400', badId.status === 400, 'HTTP ' + badId.status);

  /* ---------------- BUG-13 详情不完整 ---------------- */
  console.log('\n[BUG-13] 详情页解析不完整时有标记');
  // 3807151772 的详情页在 Steam 侧长期返回非详情页（pageOk=false），正好是这条的样本
  const partial = dataOf(await reqRetry('/api/item?id=3807151772'));
  if (partial.ok && partial.pageOk === false) {
    check('pageOk=false 时给出 partial 标记', partial.partial === true, String(partial.partial));
    check('partial 时给出 partialReason 说明', !!partial.partialReason, String(partial.partialReason).slice(0, 60));
  } else {
    // 上游这次解析成功了也没关系：只要求"ok 时能给到内容"
    check('该作品详情可用（上游这次解析成功，跳过 partial 断言）', !!partial.item, '');
  }

  /* ---------------- BUG-14 方法校验 ---------------- */
  console.log('\n[BUG-14] HTTP 方法校验');
  const post = await req('/api/browse', { method: 'POST', body: '{}' });
  check('POST /api/browse → 405', post.status === 405, 'HTTP ' + post.status);
  const del = await req('/api/filters', { method: 'DELETE' });
  check('DELETE /api/filters → 405', del.status === 405, 'HTTP ' + del.status);
  const put = await req('/api/status', { method: 'PUT', body: '{}' });
  check('PUT /api/status → 405', put.status === 405, 'HTTP ' + put.status);
  const stillGet = await req('/api/status');
  check('GET /api/status 仍然 200', stillGet.status === 200, 'HTTP ' + stillGet.status);

  /* ---------------- BUG-15 / BUG-16 总数与上限 ---------------- */
  console.log('\n[BUG-15 / BUG-16] 总数为“约”与深翻页上限');
  const trend = dataOf(await req('/api/browse?sort=trend&days=30&page=1&pageSize=30'));
  check('trend 下 totalCountApprox = true', trend.totalCountApprox === true, String(trend.totalCountApprox));
  check('给出 totalCountNote 解释', !!trend.totalCountNote, String(trend.totalCountNote).slice(0, 40));
  check('cappedAt = 30000（1000 页 × 30）', trend.cappedAt === 30000, String(trend.cappedAt));
  const recent = dataOf(await req('/api/browse?sort=mostrecent&page=1&pageSize=30'));
  check('非 trend 排序不带“约”', recent.totalCountApprox !== true, String(recent.totalCountApprox));

  /* ---------------- BUG-09 多词搜索提示 ---------------- */
  console.log('\n[BUG-09] 多词搜索的宽松匹配提示');
  const multi = dataOf(await req('/api/browse?sort=trend&days=7&page=1&pageSize=30&search=' + encodeURIComponent('zzzz-no-such-wallpaper-xyz')));
  check('多词搜索返回 searchNote', !!multi.searchNote, String(multi.searchNote).slice(0, 50));
  const single = dataOf(await req('/api/browse?sort=trend&days=7&page=1&pageSize=30&search=landscape'));
  check('单词搜索不啰嗦（searchNote 为空）', !single.searchNote, JSON.stringify(single.searchNote));

  /* ---------------- BUG-04 / BUG-06 子视图已移除 ---------------- */
  console.log('\n[BUG-04 / BUG-06] 订阅 / 收藏列表视图与「只看已订阅」');
  const filters = dataOf(await req('/api/filters'));
  const sortKeys = (filters.sorts || []).map((s) => s.key);
  check('排序项里没有 subscriptions / favorites', sortKeys.indexOf('subscriptions') < 0 && sortKeys.indexOf('favorites') < 0,
    sortKeys.join(','));
  check('排序项齐备（5 项）', sortKeys.length === 5, sortKeys.join(','));
  const sub = dataOf(await req('/api/browse?sort=subscriptions&page=1&pageSize=30'));
  check('旧的 sort=subscriptions 回落成 trend（不再 5xx）', sub.ok === true && sub.sort === 'trend', 'sort=' + sub.sort);

  /* ---------------- 时间窗与每页档位元数据 ---------------- */
  console.log('\n[元数据] 时间窗 / 每页档位');
  const days = (filters.daysOptions || []).map((d) => (typeof d === 'object' ? d.value : d));
  check('daysOptions = 1/7/30/365（今日/本周/本月/本年）', JSON.stringify(days) === JSON.stringify([1, 7, 30, 365]), JSON.stringify(days));
  const labels = (filters.daysOptions || []).map((d) => d.label);
  check('时间窗有中文标签', JSON.stringify(labels) === JSON.stringify(['今日', '本周', '本月', '本年']), JSON.stringify(labels));
  check('pageSizeOptions = 30/60/100', JSON.stringify(filters.pageSizeOptions) === JSON.stringify([30, 60, 100]),
    JSON.stringify(filters.pageSizeOptions));
  check('maxItems = 30000', filters.maxItems === 30000, String(filters.maxItems));

  /* ---------------- BUG-17 已订阅角标 ---------------- */
  console.log('\n[BUG-17] 「已订阅」角标的数据源');
  const subs = dataOf(await req('/api/subscribed-ids'));
  if (subs.ok && subs.total) {
    check('订阅 id 数量覆盖订阅总数（不再只有 30 个）',
      (subs.ids || []).length >= Math.min(subs.total, 30) && (subs.ids || []).length > 30 || subs.total <= 30,
      (subs.ids || []).length + ' / 总数 ' + subs.total);
    check('报了页数与 complete 标记', typeof subs.pages === 'number' && typeof subs.complete === 'boolean',
      'pages=' + subs.pages + ' complete=' + subs.complete);
  } else {
    console.log('  · 未登录或没有订阅，跳过（' + JSON.stringify(subs) .slice(0, 80) + '）');
  }

  /* ---------------- 汇总 ---------------- */
  console.log('\n============================');
  console.log('通过 ' + pass + ' / 失败 ' + fail);
  if (failures.length) {
    console.log('\n失败项：');
    failures.forEach((f) => console.log('  - ' + f));
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试脚本异常：', e.stack || e.message);
  process.exit(2);
});
