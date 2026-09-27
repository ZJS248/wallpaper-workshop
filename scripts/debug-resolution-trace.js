'use strict';
/** 追踪：连点 6 个分辨率后，前端到底发了什么请求、后端回了什么 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const URL_ = process.argv[2] || 'http://127.0.0.1:9391/';
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => fs.existsSync(p));
const PORT = 9630;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-tr-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const WANT = ['2560 x 1440', '3840 x 2160', 'Portrait 2160 x 3840', 'Ultrawide 3440 x 1440', 'Dual 5120 x 1440', 'Dual 7680 x 2160'];

(async () => {
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

  await send('Page.navigate', { url: URL_ }, sessionId);
  await waitFor('document.querySelectorAll(".card").length > 0', 60000, '首屏');

  await ev(`(() => {
    window.__trace = [];
    const of = window.fetch;
    window.fetch = function (u) {
      const s = String(u);
      if (s.includes('/api/browse')) window.__trace.push('REQ ' + s);
      return of.apply(this, arguments).then(function (r) {
        if (s.includes('/api/browse')) {
          r.clone().json().then(function (j) {
            const d = j.data || j;
            window.__trace.push('  RES ok=' + d.ok + ' total=' + d.totalCount + ' items=' + (d.items || []).length + ' merged=' + d.merged +
              ' groups=' + JSON.stringify(d.query && d.query.orGroups));
          }).catch(function () {});
        }
        return r;
      });
    };
    const vm = document.getElementById('app').__vue__;
    window.__vm = vm;
    const origLoad = vm.loadList;
    vm.loadList = function () {
      window.__trace.push('CALL loadList  filters.tagGroups=' + JSON.stringify(vm.filters.tagGroups));
      return origLoad.apply(vm, arguments);
    };
    return 'ok';
  })()`);

  console.log('勾 6 个分辨率…');
  const clicked = await ev(`(() => {
    const items = [...document.querySelectorAll('.fgroup .fitem')];
    const done = [];
    ${JSON.stringify(WANT)}.forEach(function (tag) {
      const el = items.find(function (b) { const t = b.querySelector('.fitem-text'); return t && t.textContent.trim() === tag; });
      if (el) { el.querySelector('input').click(); done.push(tag); }
    });
    return done;
  })()`);
  console.log('  勾上 ' + clicked.length + ' 个');

  await sleep(12000);
  console.log('\n=== 追踪 ===');
  (await ev('window.__trace')).forEach((t) => console.log('  ' + t));

  const st = await ev(`(() => { const v = window.__vm; return {
    tagGroups: v.filters.tagGroups, total: v.totalCount, items: v.items.length,
    merged: v.lastResult && v.lastResult.merged, loading: v.loading, error: v.error
  }; })()`);
  console.log('\n=== 最终状态 ===');
  console.log(JSON.stringify(st, null, 2));

  ws.close(); chrome.kill(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
