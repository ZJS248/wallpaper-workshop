'use strict';
/**
 * 每页条数 / 时间窗 / 预览尺寸的 UI 自检（CDP，无头 Chrome 真实点击）。
 *
 * 对应本轮需求与测试报告：
 *   - 每页数量 12/24/30 无效（BUG-01）→ 现在 30 / 60 / 100，且真的渲染对应张数
 *   - 「最热门」的时间范围 → 今日 / 本周 / 本月 / 本年
 *   - 卡片预览图偏小 → 宽高各 +50%（252px 栅格 / 详情面板 522px）
 *   - 评分恒为 0 星（BUG-03）→ 详情面板要出现实心星与评价数
 *   - 「我的订阅 / 我的收藏」→ 顶栏不再有这两个 Tab
 *   - 隐藏 18+（对齐 WE 默认不展示成人内容）
 *
 * 用法：node scripts/cdp-pagesize-check.js [url]
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const URL_ = process.argv[2] || 'http://127.0.0.1:9391/';
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => fs.existsSync(p));
const PORT = 9621;
const OUT = path.join(__dirname, '..', 'config', 'shots');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-ps-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  console.log((cond ? '  \u2713 ' : '  \u2717 ') + name + (extra ? '  \u2014 ' + extra : ''));
  cond ? pass++ : fail++;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + dir, '--window-size=1920,1080', 'about:blank',
  ], { stdio: 'ignore' });

  let wsUrl = null;
  for (let i = 0; i < 60 && !wsUrl; i++) {
    await sleep(250);
    try { wsUrl = (await (await fetch('http://127.0.0.1:' + PORT + '/json/version')).json()).webSocketDebuggerUrl; } catch (e) {}
  }
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map();
  const jsErrors = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') {
      jsErrors.push((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text);
    }
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
  };
  const send = (m, p, s) => new Promise((resolve, reject) => {
    const myId = ++id; const pl = { id: myId, method: m, params: p || {} }; if (s) pl.sessionId = s;
    ws.send(JSON.stringify(pl)); pending.set(myId, { resolve, reject });
    setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); reject(new Error('timeout ' + m)); } }, 180000);
  });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval');
    return r.result.value;
  };
  const waitFor = async (expr, ms, label) => {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 60000)) { try { if (await ev(expr)) return true; } catch (e) {} await sleep(300); }
    throw new Error('timeout ' + (label || expr));
  };
  const shot = async (n) => {
    const r = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
    fs.writeFileSync(path.join(OUT, n), Buffer.from(r.data, 'base64'));
  };
  /**
   * 等一次"真正的重新加载"结束。
   *
   * 不能只等 `!loading && 有卡片` —— 改筛选之后有 450ms 防抖，
   * 这期间 loading 还是 false、items 还是上一轮的结果，
   * 于是会**在请求发出之前**就判成"加载完成"，后面全部读到旧值（踩过）。
   * 所以先记下 requestSeq，再等它变大且 loading 落下。
   */
  const waitReload = async (want) => {
    const before = await ev(`document.getElementById('app').__vue__.requestSeq`);
    for (let i = 0; i < 240; i++) {
      await sleep(300);
      const st = await ev(`(() => {
        const v = document.getElementById('app').__vue__;
        return { seq: v.requestSeq, loading: v.loading, n: v.items.length, err: v.error };
      })()`);
      if (st.seq > before && !st.loading) {
        if (want && !want(st)) continue;
        return st;
      }
    }
    return { seq: -1, loading: false, n: -1, err: 'timeout' };
  };
  /**
   * 执行一段"会触发重新加载"的表达式并等它加载完。
   *
   * 上游（经本地代理打 Steam）偶发 TLS 握手失败 —— 这时界面会**保留旧结果**
   * 并在顶部挂一条错误横幅（这正是产品行为）。直接断言就会误判成"功能没生效"，
   * 所以见到 error 就再操作一次。
   */
  const applyAndWait = async (expr, want, tries) => {
    const n = tries || 3;
    let st = null;
    for (let i = 0; i < n; i++) {
      await ev(expr);
      st = await waitReload(want);
      if (st && !st.err) return st;
      console.log('  · 上游抖动，重试第 ' + (i + 2) + ' 次（' + (st && st.err) + '）');
      await sleep(1200);
    }
    return st;
  };
  const setPageSize = (n) =>
    applyAndWait(
      `(() => {
        const sel = [...document.querySelectorAll('.toolbar-right select')].find(function (s) {
          return [...s.options].some(function (o) { return /\\/ 页$/.test(o.textContent); });
        });
        sel.value = '${n}';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      })()`,
      (s) => s.n === n
    );

  await send('Page.navigate', { url: URL_ }, sessionId);
  await waitFor('document.querySelectorAll(".card").length > 0', 90000, '首屏');
  console.log('首屏 OK\n');

  /* ---------------- 顶栏：不再有订阅/收藏 Tab ---------------- */
  console.log('[顶栏导航]');
  const tabs = await ev(`[...document.querySelectorAll('.tabs .tab')].map(function (b) { return b.textContent.trim(); })`);
  check('没有「我的订阅」Tab', tabs.indexOf('我的订阅') < 0, JSON.stringify(tabs));
  check('没有「我的收藏」Tab', tabs.indexOf('我的收藏') < 0, JSON.stringify(tabs));
  check('有「创意工坊」Tab', tabs.indexOf('创意工坊') >= 0, JSON.stringify(tabs));

  /* ---------------- 每页条数 ---------------- */
  console.log('\n[每页条数 30 / 60 / 100]');
  const sizeOpts = await ev(`[...document.querySelectorAll('.toolbar-right select')].map(function (s) {
    return { opts: [...s.options].map(function (o) { return o.value + ':' + o.textContent.trim(); }) };
  })`);
  const psOpts = (sizeOpts.find((s) => s.opts.some((o) => /\/ 页$/.test(o))) || {}).opts || [];
  check('每页下拉是 30 / 60 / 100', psOpts.join(',') === '30:30 / 页,60:60 / 页,100:100 / 页', psOpts.join(','));
  check('默认每页 30（对应上游原生页大小）', (await ev(`document.getElementById('app').__vue__.filters.pageSize`)) === 30, '');

  for (const n of [60, 100]) {
    const st = await setPageSize(n);
    const cards = await ev(`document.querySelectorAll('.grid .card').length`);
    check('选「' + n + ' / 页」后渲染 ' + n + ' 张卡片', cards === n && st.n === n, '卡片 ' + cards + ' / items ' + st.n);
  }
  // 回到 30
  const back30 = await setPageSize(30);
  check('切回 30 / 页 后渲染 30 张', back30.n === 30, 'items ' + back30.n);

  /* ---------------- 时间窗 ---------------- */
  console.log('\n[「最热门」的时间范围]');
  const dayOpts = await ev(`(() => {
    const sel = [...document.querySelectorAll('.toolbar-right select')].find(function (s) {
      return [...s.options].some(function (o) { return o.textContent.trim() === '今日'; });
    });
    return sel ? [...sel.options].map(function (o) { return o.textContent.trim(); }) : null;
  })()`);
  check('时间窗是 今日/本周/本月/本年',
    JSON.stringify(dayOpts) === JSON.stringify(['今日', '本周', '本月', '本年']), JSON.stringify(dayOpts));

  const firstOf = () => ev(`(() => { const v = document.getElementById('app').__vue__; return v.items.length ? v.items[0].id : ''; })()`);
  const setDays = async (v) => {
    await applyAndWait(
      `(() => {
        const sel = [...document.querySelectorAll('.toolbar-right select')].find(function (s) {
          return [...s.options].some(function (o) { return o.textContent.trim() === '今日'; });
        });
        sel.value = '${v}';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      })()`
    );
    return firstOf();
  };
  const today = await setDays(1);
  const year = await setDays(365);
  check('切到「今日」有结果', !!today, String(today));
  check('切到「本年」有结果', !!year, String(year));
  check('今日与本年不是同一批作品', today !== year, today + ' vs ' + year);  const daysState = await ev(`document.getElementById('app').__vue__.filters.days`);
  check('filters.days 已更新为 365', daysState === 365, String(daysState));
  await setDays(7);

  /* ---------------- 卡片 / 详情预览尺寸 ---------------- */
  console.log('\n[预览图尺寸（+50%）]');
  const gridCss = await ev(`(() => {
    const el = document.querySelector('.grid');
    return getComputedStyle(el).gridTemplateColumns;
  })()`);
  const cardRect = await ev(`(() => {
    const c = document.querySelector('.grid .card');
    const t = c.querySelector('.card-thumb');
    const r = c.getBoundingClientRect();
    const tr = t.getBoundingClientRect();
    return { cardW: Math.round(r.width), thumbW: Math.round(tr.width), thumbH: Math.round(tr.height) };
  })()`);
  console.log('  栅格：' + gridCss);
  console.log('  卡片：' + JSON.stringify(cardRect));
  // 旧值：栅格 minmax(168px,1fr)，1920 宽下实测约 176px；现在 minmax(252px,1fr)
  check('卡片宽度 ≥ 250（原来约 176）', cardRect.cardW >= 250, cardRect.cardW + 'px');
  check('预览图高度 ≥ 140（原来约 99）', cardRect.thumbH >= 140, cardRect.thumbH + 'px');
  check('预览图仍然保持 16:9', Math.abs(cardRect.thumbW / cardRect.thumbH - 16 / 9) < 0.05,
    (cardRect.thumbW / cardRect.thumbH).toFixed(3));

  /* ---------------- 详情面板 ---------------- */
  console.log('\n[详情面板：尺寸 / 评分 / 作者]');
  await ev(`document.querySelector('.grid .card').click()`);
  try {
    await waitFor(`(() => { const v = document.getElementById('app').__vue__; return v.detail && v.detail.item; })()`, 120000, '详情');
  } catch (e) {
    const diag = await ev(`(() => {
      const v = document.getElementById('app').__vue__;
      return { selected: v.selected && v.selected.id, loading: v.detailLoading, error: v.detailError, hasDetail: !!v.detail };
    })()`);
    check('详情加载成功', false, JSON.stringify(diag));
    throw e;
  }
  const detailRect = await ev(`(() => {
    const d = document.querySelector('.detail');
    const p = d.querySelector('.detail-preview');
    const r = p.getBoundingClientRect();
    return { paneW: Math.round(d.getBoundingClientRect().width), prevW: Math.round(r.width), prevH: Math.round(r.height) };
  })()`);
  console.log('  详情：' + JSON.stringify(detailRect));
  check('详情面板宽度 ≥ 500（原来 348）', detailRect.paneW >= 500, detailRect.paneW + 'px');
  check('详情预览图宽 ≥ 470、高 ≥ 260', detailRect.prevW >= 470 && detailRect.prevH >= 260,
    detailRect.prevW + '×' + detailRect.prevH);

  const rating = await ev(`(() => {
    const v = document.getElementById('app').__vue__;
    const lit = document.querySelectorAll('.detail-rating .stars span.lit').length;
    return {
      lit: lit,
      label: (document.querySelector('.detail-rating .rating-label') || {}).textContent || '',
      votes: (document.querySelector('.detail-rating .rating-votes') || {}).textContent || '',
      starRating: v.detail.item.starRating,
      totalVotes: v.detail.item.totalVotes,
    };
  })()`);
  console.log('  评分：' + JSON.stringify(rating));
  check('星级不是 0 颗全灭（BUG-03）', rating.lit > 0, rating.lit + ' 颗实心');
  check('显示评价数', Number(rating.totalVotes) > 0, rating.votes.trim());
  check('显示评分文案（不是"评价数不足"）', rating.label.trim() !== '评价数不足', rating.label.trim());

  const authorName = await ev(`(document.querySelector('.detail-author .author-name') || {}).textContent || ''`);
  check('作者昵称不是"作者 xxxxxx"这种 ID 兜底（BUG-12）', !/^作者\s*\d+$/.test(authorName.trim()), authorName.trim());

  const moreHasCopy = await ev(`(() => {
    const btn = [...document.querySelectorAll('.detail-actions .act')].find(function (b) { return b.textContent.trim() === '≡'; });
    if (!btn) return 'no-btn';
    btn.click();
    return new Promise(function (r) {
      setTimeout(function () {
        r([...document.querySelectorAll('.detail-more .more-item')].map(function (b) { return b.textContent.trim(); }).join('|'));
      }, 120);
    });
  })()`);
  check('「更多」菜单里有"复制作品链接"', /复制作品链接/.test(String(moreHasCopy)), String(moreHasCopy).slice(0, 80));
  await ev(`(() => { const btn = [...document.querySelectorAll('.detail-actions .act')].find(function (b) { return b.textContent.trim() === '≡'; }); if (btn) btn.click(); })()`);

  /* ---------------- 隐藏 18+ ---------------- */
  console.log('\n[隐藏 18+ / 成人内容门控]');
  const matureState = await ev(`(() => {
    const v = document.getElementById('app').__vue__;
    return { hide: v.filters.hideMature, matureInList: v.items.filter(function (i) { return i.ageRating === 'Mature'; }).length, n: v.items.length };
  })()`);
  check('默认隐藏成人内容（对齐 WE）', matureState.hide === true, String(matureState.hide));
  check('默认列表里没有 Mature 作品', matureState.matureInList === 0, matureState.matureInList + ' / ' + matureState.n);

  // 取消勾选后应当能看到 Mature
  const matureOn = await applyAndWait(
    `(() => { const el = document.querySelector('.toolbar-right .chk'); if (el) el.click(); })()`
  );
  const matureCount = await ev(`document.getElementById('app').__vue__.items.filter(function (i) { return i.ageRating === 'Mature'; }).length`);
  check('取消后能出现 Mature 作品', matureCount > 0, matureCount + ' 条（本页 ' + matureOn.n + ' 条）');
  const hideState = await ev(`document.getElementById('app').__vue__.filters.hideMature`);
  check('取消后 filters.hideMature = false', hideState === false, String(hideState));
  // 勾回来（还原初始状态）
  const matureOff = await applyAndWait(
    `(() => { const el = document.querySelector('.toolbar-right .chk'); if (el) el.click(); })()`
  );
  const matureBack = await ev(`document.getElementById('app').__vue__.items.filter(function (i) { return i.ageRating === 'Mature'; }).length`);
  check('重新勾上后 Mature 又没了', matureBack === 0, matureBack + ' 条（本页 ' + matureOff.n + ' 条）');

  await shot('11-pagesize-and-scale.png');
  console.log('\n截图：config/shots/11-pagesize-and-scale.png');

  check('页面没有 JS 运行时异常', jsErrors.length === 0, jsErrors.slice(0, 2).join(' | '));

  console.log('\n================ 每页条数 / 尺寸 / 评分 自检：' + pass + ' 通过 / ' + fail + ' 失败 ================');
  ws.close();
  chrome.kill();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('异常：' + (e && e.stack ? e.stack : e));
  process.exit(2);
});
