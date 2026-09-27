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
  // 注意：标签行里 .fitem-raw 只在"译名 ≠ 原文"时才渲染（分辨率标签没译名，所以没有它）。
  // 按 .fitem-text 的可见文字来找才是稳的。
  const clicked = await ev(`(() => {
    const items = [...document.querySelectorAll('.fgroup .fitem')];
    const done = [];
    ${JSON.stringify(WANT)}.forEach(function (tag) {
      const el = items.find(function (b) {
        const t = b.querySelector('.fitem-text');
        return t && t.textContent.trim() === tag;
      });
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
  const totalBefore = await ev(`document.querySelector('.count') ? document.querySelector('.count').textContent.trim() : ''`);
  let total = totalBefore;
  let cards = 0;
  let merged = false;
  for (let i = 0; i < 160; i++) {
    await sleep(500);
    const st = await ev(`(() => {
      const v = document.getElementById('app').__vue__;
      return {
        cards: document.querySelectorAll('.card').length,
        total: document.querySelector('.count') ? document.querySelector('.count').textContent.trim() : '',
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
  check('出现了合并查询（说明按值拆分了）', merged, '');
  check('出现作品卡片（不再是空态）', cards > 0, cards + ' 张');
  check('计数发生变化', total !== totalBefore, totalBefore + ' → ' + total);
  check('没有显示"没有符合条件的作品"', !(await ev(`!!document.querySelector('.empty')`)), '');

  // 注意：.chip.fixed 是工具条「隐藏 18+」自动加的那个 chip，不算"已选标签"
  const chipCount = await ev(`document.querySelectorAll('.active-chips .chip:not(.fixed)').length`);
  check('已选标签条显示 6 个', chipCount === 6, chipCount + ' 个');

  const mergeNote = await ev(`document.querySelector('.merge-note') ? document.querySelector('.merge-note').textContent.trim() : ''`);
  check('显示"已合并 N 路"说明', /已合并\s*\d+\s*路/.test(mergeNote), mergeNote);

  // 校验卡片的分辨率确实只落在这 6 个里
  const tagsOfCards = await ev(`(() => {
    const vm = document.getElementById('app').__vue__;
    return vm.items.map(function (i) { return i.resolution || ''; });
  })()`);
  const bad = tagsOfCards.filter((t) => WANT.indexOf(t) < 0);
  check('卡片分辨率都属于这 6 个', bad.length === 0, bad.length ? bad.join(' | ') : tagsOfCards.length + ' 张全部命中');

  // 再叠一个类型：应当仍然有结果，且类型为 Scene
  console.log('\n[再叠一个类型 = Scene]');
  // 注意：类型标签**没有中文译名**（只有"标签"类目里的内容标签才有），
  // 界面上显示的就是 "Scene"。之前按"场景"找当然是点不到。
  const typeClicked = await ev(`(() => {
    const items = [...document.querySelectorAll('.fgroup .fitem')];
    const el = items.find(function (b) {
      const t = b.querySelector('.fitem-text');
      return t && t.textContent.trim() === 'Scene';
    });
    if (!el) return 'not-found';
    el.querySelector('input').click();
    return 'clicked';
  })()`);
  check('点到「Scene」类型', typeClicked === 'clicked', typeClicked);
  await sleep(1200);
  // 等"类型=Scene"这一步的查询也回来（同样不能只看"有卡片"——上一轮的结果还在）
  const beforeType = await ev(`(() => { const v = document.getElementById('app').__vue__; return (v.lastResult && v.lastResult.mergeRequests) || 0; })()`);
  for (let i = 0; i < 160; i++) {
    await sleep(500);
    const st = await ev(`(() => {
      const v = document.getElementById('app').__vue__;
      const g = JSON.stringify(v.filters.tagGroups);
      return { g: g, loading: v.loading, requests: (v.lastResult && v.lastResult.mergeRequests) || 0, items: v.items.length };
    })()`);
    const hasBoth = /resolution/.test(st.g) && /type/.test(st.g);
    // 等"类型组的请求数"和分辨率那轮的 6 路一致（说明这一轮也回来了），且不在 loading
    if (hasBoth && !st.loading && st.items > 0 && st.requests === beforeType) break;  }
  const after = await ev(`(() => {
    const vm = document.getElementById('app').__vue__;
    return {
      cards: document.querySelectorAll('.card').length,
      groups: vm.filters.tagGroups,
      types: [...new Set(vm.items.map(function (i) { return i.wallpaperType; }))],
      resolutions: [...new Set(vm.items.map(function (i) { return i.resolution; }))],
      count: document.querySelector('.count') ? document.querySelector('.count').textContent.trim() : '',
      loading: vm.loading
    };
  })()`);
  check('叠加类型后仍有结果', after.cards > 0, after.count + ' / ' + after.cards + ' 张');
  check('类型筛选生效（只有场景）', after.types.length > 0 && after.types.every((t) => t === 'Scene'), JSON.stringify(after.types));
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
