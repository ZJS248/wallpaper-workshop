'use strict';
/**
 * 复现用户的原始操作：在分辨率里勾 6 个 → 应当出结果（而不是"没有符合条件的作品"）。
 * 用 CDP 真实点击，验证前端 + 后端整条链路。
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
const PORT = 9620;
const OUT = path.join(__dirname, '..', 'config', 'shots');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-res-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const WANT = [
  '2560 x 1440', '3840 x 2160', 'Portrait 2160 x 3840',
  'Ultrawide 3440 x 1440', 'Dual 5120 x 1440', 'Dual 7680 x 2160',
];

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
    '--user-data-dir=' + dir, '--window-size=1600,900', 'about:blank',
  ], { stdio: 'ignore' });

  let wsUrl = null;
  for (let i = 0; i < 60 && !wsUrl; i++) {
    await sleep(250);
    try { wsUrl = (await (await fetch('http://127.0.0.1:' + PORT + '/json/version')).json()).webSocketDebuggerUrl; } catch (e) {}
  }
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } };
  const send = (m, p, s) => new Promise((resolve, reject) => {
    const myId = ++id; const pl = { id: myId, method: m, params: p || {} }; if (s) pl.sessionId = s;
    ws.send(JSON.stringify(pl)); pending.set(myId, { resolve, reject });
    setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); reject(new Error('timeout ' + m)); } }, 120000);
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

  await send('Page.navigate', { url: URL_ }, sessionId);
  await waitFor('document.querySelectorAll(".card").length > 0', 60000, '首屏');
  console.log('首屏 OK\n');

  console.log('[勾选 6 个分辨率]');
  /*
   * 按 `.fitem[data-tag]` 找，不要按可见文字找。
   *
   * 分辨率标签是有中文名的（`3840 x 2160` 显示成「3840 x 2160 - 4K」、
   * `Dual 5120 x 1440` 显示成「5120 x 1440」），而且该组 showRaw=false 不渲染原文，
   * 所以拿可见文字和 Steam 原始 tag 比对本来就对不上（以前这条断言一直匹配不到，
   * 6 个里只能中 1 个）。`data-tag` 上放的是权威的原始 tag，匹配它才准。
   */
  const clicked = await ev(`(() => {
    const done = [];
    ${JSON.stringify(WANT)}.forEach(function (tag) {
      const el = document.querySelector('.fgroup .fitem[data-tag="' + tag.replace(/"/g, '\\\\"') + '"]');
      if (el) { el.querySelector('input').click(); done.push(tag); }
    });
    return done;
  })()`);
  console.log('  实际勾上：' + JSON.stringify(clicked));
  check('6 个分辨率都勾上了', clicked.length === 6, clicked.length + '/6');

  // 等结果真的变化。
  // 注意：不能只等"有卡片"——点击前就已经有 30 张旧卡片了（未筛选的全站列表），
  // 那样会在筛选还没生效时就提前通过。这里等的是 lastResult.merged 出现
  // （只有合并查询才会有），以及计数文案发生变化。
  const totalBefore = await ev(`document.querySelector('.result-count') ? document.querySelector('.result-count').textContent.trim() : ''`);
  let total = totalBefore;
  let cards = 0;
  let merged = false;
  for (let i = 0; i < 160; i++) {
    await sleep(500);
    const st = await ev(`(() => {
      const v = document.getElementById('app').__vue__;
      return {
        cards: document.querySelectorAll('.card').length,
        total: document.querySelector('.result-count') ? document.querySelector('.result-count').textContent.trim() : '',
        merged: !!(v.lastResult && v.lastResult.merged),
        loading: v.loading,
      };
    })()`);
    cards = st.cards;
    total = st.total;
    merged = st.merged;
    if (merged && total !== totalBefore && cards > 0 && !st.loading) break;
  }
  console.log('  计数文案：' + totalBefore + ' → ' + total);
  const RES_ONLY_COUNT = total;   // "只勾 6 个分辨率"时的计数，叠类型后必须变
  check('出现了合并查询（说明按值拆分了）', merged, '');
  check('出现作品卡片（不再是空态）', cards > 0, cards + ' 张');
  check('计数发生变化', total !== totalBefore, totalBefore + ' → ' + total);
  check('没有显示"没有符合条件的作品"', !(await ev(`!!document.querySelector('.empty')`)), '');

  // 注意：.chip.muted 是"已屏蔽作者 / 排除项"那几枚，不算"已选标签"
  const chipCount = await ev(`document.querySelectorAll('.active-chips .chip:not(.muted)').length`);
  check('已选标签条显示 6 个', chipCount === 6, chipCount + ' 个');

  // 合并说明收进了「统一提示条 / N 条说明」浮层：
  // 同一时刻提示条只显示优先级最高的一条（这里"页数上限"更高），
  // 所以要先点开「N 条说明」浮层，再看合并说明在不在里面。
  await ev(`(() => { const c = document.querySelector('.note-chip'); if (c) c.click(); })()`);
  await sleep(400);
  const mergeNote = await ev(`(() => {
    const vm = document.getElementById('app').__vue__;
    const mi = vm.mergeInfo;
    const pop = document.querySelector('.note-pop');
    return {
      text: mi ? mi.text : '',
      inNotice: /已合并\\s*\\d+\\s*路/.test(document.querySelector('.notice') ? document.querySelector('.notice').textContent : ''),
      inPopover: !!(pop && /已合并\\s*\\d+\\s*路/.test(pop.textContent)),
    };
  })()`);
  check('显示"已合并 N 路"说明', /已合并\s*\d+\s*路/.test(mergeNote.text) && (mergeNote.inNotice || mergeNote.inPopover), JSON.stringify(mergeNote));
  await ev(`(() => { const c = document.querySelector('.note-chip'); if (c) c.click(); })()`);
  await sleep(300);

  // 校验卡片的分辨率确实只落在这 6 个里
  const tagsOfCards = await ev(`(() => {
    const vm = document.getElementById('app').__vue__;
    return vm.items.map(function (i) { return i.resolution || ''; });
  })()`);
  const bad = tagsOfCards.filter((t) => WANT.indexOf(t) < 0);
  check('卡片分辨率都属于这 6 个', bad.length === 0, bad.length ? bad.join(' | ') : tagsOfCards.length + ' 张全部命中');

  // 再叠一个类型：应当仍然有结果，且类型为 Scene
  console.log('\n[再叠一个类型 = Scene]');
  // 注意：类型标签是有中文译名的（Scene 显示成「场景」），所以同样按 data-tag 找。
  const typeClicked = await ev(`(() => {
    const el = document.querySelector('.fgroup .fitem[data-tag="Scene"]');
    if (!el) return 'not-found';
    el.querySelector('input').click();
    return 'clicked';
  })()`);
  check('点到「场景」(Scene) 类型', typeClicked === 'clicked', typeClicked);
  await sleep(1200);
  /*
   * 等"类型=场景"这一轮的查询真的回来。
   *
   * 早先这里等的是 `mergeRequests === 上一轮的数`，但叠加单选类目**不会**改变路数
   * （分辨率 6 路 × 类型并入 AND = 仍是 6 路），所以那个条件要么永远不满足、
   * 要么立刻满足拿旧结果，两种都是错的。直接等被断言的属性本身：
   * 不在 loading、筛选条件里两类都在、且当前列表每一张都带 Scene 标签。
   */
  let waited = 0;
  let typeReqs = 0;
  for (let i = 0; i < 240; i++) {
    await sleep(500);
    waited = (i + 1) * 0.5;
    const st = await ev(`(() => {
      const v = document.getElementById('app').__vue__;
      return {
        g: JSON.stringify(v.filters.tagGroups),
        loading: v.loading,
        requests: (v.lastResult && v.lastResult.mergeRequests) || 0,
        count: document.querySelector('.result-count') ? document.querySelector('.result-count').textContent.trim() : ''
      };
    })()`);
    typeReqs = st.requests;
    // 等这一轮真的回来：不在 loading，且计数已经不再等于"只有分辨率"时的那个数
    if (/resolution/.test(st.g) && /type/.test(st.g) && !st.loading && st.count && st.count !== RES_ONLY_COUNT) break;
  }
  console.log('  等待类型查询：' + waited + ' 秒（mergeRequests=' + typeReqs + '）');
  const after = await ev(`(() => {
    const vm = document.getElementById('app').__vue__;
    return {
      cards: document.querySelectorAll('.card').length,
      groups: vm.filters.tagGroups,
      types: [...new Set(vm.items.map(function (i) { return i.wallpaperType; }))],
      resolutions: [...new Set(vm.items.map(function (i) { return i.resolution; }))],
      count: document.querySelector('.result-count') ? document.querySelector('.result-count').textContent.trim() : '',
      loading: vm.loading
    };
  })()`);
  check('叠加类型后仍有结果', after.cards > 0, after.count + ' / ' + after.cards + ' 张');
  /*
   * 这里只断言界面能保证的事：筛选条件确实叠加上了、结果随之收窄、列表没有变空。
   *
   * 两条**故意没有**断言的东西（都不是界面的责任，说明一下免得以后有人再踩）：
   *
   *  1. "每条结果的 wallpaperType 都等于 Scene" —— 不成立。本项目把 Steam 的 Type 组
   *     （Scene/Video/Web）和 Category 组（Wallpaper/Preset）并进了同一个"类型"面板，
   *     而 Steam 允许一张作品同时带 Scene 标签和 Wallpaper 类目（实测 id=1829101111
   *     就是这种）。筛选约束的是标签，界面显示的是类型字段，两者本来就不是一回事。
   *
   *  2. "每条结果的 tags 数组里都有 Scene" —— 也不可靠。列表接口（浏览页 SSR）返回的
   *     tags 是一个**不完整**的子集：id=3807861954 详情页的 tags 含 Scene，列表里却没有。
   *     标签完整性属于上游数据的问题，界面拿到的就是这些。
   */
  const gApplied = /resolution/.test(JSON.stringify(after.groups)) && /type/.test(JSON.stringify(after.groups));
  check('筛选条件同时包含分辨率与类型', gApplied, JSON.stringify(after.groups));
  check('叠加类型后结果收窄', after.count && after.count !== RES_ONLY_COUNT, after.count + '（原来 ' + RES_ONLY_COUNT + '）');
  check('分辨率仍限定在这 6 个内', after.resolutions.every((t) => WANT.indexOf(t) >= 0), after.resolutions.join(' | '));

  await shot('10-resolution-or.png');
  console.log('\n截图：config/shots/10-resolution-or.png');

  console.log('\n================ 分辨率 OR 修复自检：' + pass + ' 通过 / ' + fail + ' 失败 ================');
  ws.close();
  chrome.kill();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('异常：' + (e && e.stack ? e.stack : e));
  process.exit(2);
});
