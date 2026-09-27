'use strict';
/**
 * 分页组装回归测试（对应测试报告 BUG-01 / BUG-02 / BUG-16 / OBS-6）。
 *
 * 验证：
 *  1. 每页 30 / 60 / 100 都真的返回对应条数（上游恒 30 条/页，靠 pageStore 拼）
 *  2. 相邻页不重叠、不跳号
 *  3. totalPages 与"可达条目数"自洽（Steam 深翻页硬顶 1000 页 ≈ 3 万条）
 *  4. 越界页码不 5xx，并收敛到最后一页
 *  5. trend 的 4 个时间窗（今日/本周/本月/本年）都能返回且结果集确实不同
 *  6. 同组 OR + 跨组 AND 在每页 100 条下仍然成立，且请求数不随 pageSize 放大
 *  7. 作者页每页条数正确（旧实现"按 24 算页数、实际每页 10 条"）
 *
 * 用法：node scripts/test-paging.js [base]
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

async function get(path) {
  const r = await fetch(BASE + path);
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (e) {
    /* 下面统一报错 */
  }
  return { status: r.status, json, text };
}

async function browse(qs) {
  const r = await get('/api/browse?' + qs);
  return (r.json && (r.json.data || r.json)) || {};
}

const idsOf = (d) => (d.items || []).map((i) => i.id);

(async function main() {
  console.log('BASE = ' + BASE + '\n');

  /* ---------------- 1. 每页条数 ---------------- */
  console.log('[1] 每页条数 30 / 60 / 100');
  const p30 = await browse('sort=trend&days=7&page=1&pageSize=30');
  const p60 = await browse('sort=trend&days=7&page=1&pageSize=60');
  const p100 = await browse('sort=trend&days=7&page=1&pageSize=100');
  check('pageSize=30 → 30 条', (p30.items || []).length === 30, '实际 ' + (p30.items || []).length);
  check('pageSize=60 → 60 条', (p60.items || []).length === 60, '实际 ' + (p60.items || []).length);
  check('pageSize=100 → 100 条', (p100.items || []).length === 100, '实际 ' + (p100.items || []).length);
  check('响应回显 pageSize 正确', p30.pageSize === 30 && p60.pageSize === 60 && p100.pageSize === 100,
    [p30.pageSize, p60.pageSize, p100.pageSize].join('/'));
  check('pageSize=100 至少拼了 4 个上游页', (p100.mergeUpstreamPages || 0) >= 4, 'upstreamPages=' + p100.mergeUpstreamPages);

  /* ---------------- 2. 翻页不重叠 ---------------- */
  console.log('\n[2] 相邻页不重叠（pageSize=100）');
  const q100a = await browse('sort=trend&days=7&page=1&pageSize=100');
  const q100b = await browse('sort=trend&days=7&page=2&pageSize=100');
  const ids1 = idsOf(q100a);
  const ids2 = idsOf(q100b);
  check('单页内没有重复条目', new Set(ids1).size === ids1.length, ids1.length + ' 条里 ' + (ids1.length - new Set(ids1).size) + ' 条重复');
  const a = new Set(ids1);
  const overlap = ids2.filter((x) => a.has(x));
  /**
   * 「最热门」是**实时榜单**：两次请求之间 Steam 会挪位，所以相邻页边界上必然
   * 会有少量重叠（Steam 官网自己的分页也一样，实测 2~5 条）。
   * 这里只要求"不是成片重复" —— 上限取 max(5, 页大小的 10%)。
   */
  const overlapLimit = Math.max(5, Math.ceil(ids2.length * 0.1));
  check('第 1 / 2 页交集 ≤ ' + overlapLimit + '（实时榜单允许边界抖动）', overlap.length <= overlapLimit,
    '重叠 ' + overlap.length + ' 条');
  check('第 2 页返回 100 条', ids2.length === 100, '实际 ' + ids2.length);

  // 与"把同一区间拆成 30 条一气读完"的结果对比：前 30 条应当一致
  const first30 = await browse('sort=trend&days=7&page=1&pageSize=30');
  check('pageSize=30 与 pageSize=100 的前 30 条一致',
    JSON.stringify(idsOf(first30)) === JSON.stringify(ids1.slice(0, 30)));

  /* ---------------- 3. totalPages 自洽 ---------------- */
  console.log('\n[3] totalPages 与可达上限自洽');
  const expect100 = Math.ceil(Math.min(p100.totalCount, 30000) / 100);
  check('pageSize=100 → totalPages=' + expect100, p100.totalPages === expect100, '实际 ' + p100.totalPages);
  check('pageSize=30 → totalPages=1000（Steam 硬顶）', p30.totalPages === 1000, '实际 ' + p30.totalPages);
  check('总数的“约”标记已生效（trend 的总量不随时间窗变化）', p30.totalCountApprox === true);
  check('cappedAt 暴露可达上限', p100.cappedAt === 30000, '实际 ' + p100.cappedAt);

  /* ---------------- 4. 越界页码 ---------------- */
  console.log('\n[4] 越界页码');
  const big = await get('/api/browse?sort=trend&days=7&page=100000&pageSize=30');
  check('page=100000 不 5xx', big.status === 200, 'HTTP ' + big.status);
  const bigD = (big.json && (big.json.data || big.json)) || {};
  check('page 被夹到最后一页', bigD.page === 1000, '实际 ' + bigD.page);

  /* ---------------- 5. 时间窗 ---------------- */
  console.log('\n[5] trend 时间窗 今日 / 本周 / 本月 / 本年');
  const windows = {};
  for (const d of [1, 7, 30, 365]) {
    const r = await browse('sort=trend&days=' + d + '&page=1&pageSize=30');
    windows[d] = idsOf(r);
    check('days=' + d + ' 返回 30 条', windows[d].length === 30, '实际 ' + windows[d].length);
  }
  const w1 = new Set(windows[1]);
  const diff365 = windows[365].filter((x) => !w1.has(x)).length;
  check('今日 与 本年 的结果集明显不同', diff365 >= 25, '只有 ' + diff365 + '/30 不同');
  const diff30 = windows[30].filter((x) => !w1.has(x)).length;
  check('今日 与 本月 的结果集不同', diff30 >= 10, '只有 ' + diff30 + '/30 不同');

  /* ---------------- 6. 合并 + 每页 100 ---------------- */
  console.log('\n[6] 同组 OR / 跨组 AND 在每页 100 条下');
  const RES = ['2560 x 1440', '3840 x 2160', 'Portrait 2160 x 3840'];
  const gq = 'sort=trend&days=7&page=1&pageSize=100&g=' +
    encodeURIComponent('分辨率:' + RES.join(',')) +
    '&g=' + encodeURIComponent('类型:Scene');
  const merged = await browse(gq);
  check('合并查询返回 100 条', (merged.items || []).length === 100, '实际 ' + (merged.items || []).length);
  check('mergeRequests = 3（按值拆 3 路）', merged.mergeRequests === 3, '实际 ' + merged.mergeRequests);
  // 关键不变量：请求数 = 路数 × ceil(ceil(pageSize / 路数) / 30)，
  // 而不是 "路数 × ceil(pageSize / 30)"。3 路 × 每页 100 条：
  //   前缀算法 → 每路只要 34 条 = 2 个上游页 → 共 6 个请求
  //   朴素做法 → 每路要 100 条 = 4 个上游页 → 共 12 个请求
  const naive = 3 * Math.ceil(100 / 30);
  check('每页 100 条没有把请求数放大到 ' + naive + ' 个',
    (merged.mergeUpstreamPages || 0) === 6, '实际 ' + merged.mergeUpstreamPages);
  const badRes = (merged.items || []).filter((i) => !RES.some((t) => (i.tags || []).includes(t)));
  const badType = (merged.items || []).filter((i) => !(i.tags || []).includes('Scene'));
  check('每一条都命中所选分辨率之一（组内 OR）', badRes.length === 0, badRes.length + ' 条不命中');
  check('每一条都是 Scene（跨组 AND）', badType.length === 0, badType.length + ' 条不是 Scene');
  check('多路合并时总数标为“约”', merged.totalCountApprox === true);

  // 合并的第 2 页与第 1 页不重叠
  const merged2 = await browse(gq.replace('page=1', 'page=2'));
  const mset = new Set(idsOf(merged));
  const mOverlap = idsOf(merged2).filter((x) => mset.has(x));
  const mLimit = Math.max(5, Math.ceil(idsOf(merged).length * 0.1));
  check('合并查询第 1 / 2 页交集 ≤ ' + mLimit, mOverlap.length <= mLimit, '重叠 ' + mOverlap.length);

  /* ---------------- 7. 作者页 ---------------- */
  console.log('\n[7] 作者页每页条数');
  const creatorId = (p30.items && p30.items[0] && p30.items[0].creator) || '';
  if (creatorId) {
    const au = await get('/api/author?id=' + creatorId + '&page=1&pageSize=30');
    const aud = (au.json && (au.json.data || au.json)) || {};
    check('作者页返回体 ok', aud.ok === true, JSON.stringify(aud.error || ''));
    check('作者页 pageSize 回显 30', aud.pageSize === 30, '实际 ' + aud.pageSize);
    if (aud.totalCount) {
      const expect = Math.ceil(Math.min(aud.totalCount, 30000) / 30);
      check('作者页 totalPages 与每页 30 条自洽', aud.totalPages === expect,
        'totalCount=' + aud.totalCount + ' totalPages=' + aud.totalPages + ' 期望 ' + expect);
    } else {
      console.log('  · 该作者作品数为 0，跳过页数自洽检查');
    }
  } else {
    console.log('  · 取不到 creator，跳过');
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
