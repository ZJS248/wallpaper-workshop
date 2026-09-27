'use strict';
/** 追踪：勾完 6 个分辨率后，再点一次「场景」，看请求与返回 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const URL_ = process.argv[2] || 'http://127.0.0.1:9391/';
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));
const PORT = 9640;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-tr2-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WANT = ['2560 x 1440', '3840 x 2160', 'Portrait 2160 x 3840', 'Ultrawide 3440 x 1440', 'Dual 5120 x 1440', 'Dual 7680 x 2160'];

(async () => {
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + dir, '--window-size=1600,900', 'about:blank'], { stdio: 'ignore' });
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
  const waitFor = async (expr, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 60000)) { try { if (await ev(expr)) return true; } catch (e) {} await sleep(300); }
    throw new Error('timeout ' + expr);
  };

  await send('Page.navigate', { url: URL_ }, sessionId);
  await waitFor('document.querySelectorAll(".card").length > 0', 60000);

  await ev(`(() => {
    window.__t = [];
    const of = window.fetch;
    window.fetch = function (u) {
      const s = String(u);
      if (s.includes('/api/browse')) {
        window.__t.push('REQ ' + s.slice(0, 200));
        return of.apply(this, arguments).then(function (r) {
          r.clone().json().then(function (j) {
            const d = j.data || j;
            window.__t.push('  RES total=' + d.totalCount + ' items=' + (d.items || []).length +
              ' merged=' + d.merged + ' reqs=' + d.mergeRequests +
              ' types=' + JSON.stringify([...new Set((d.items || []).map(function (i) { return i.wallpaperType; }))]) +
              ' res=' + JSON.stringify([...new Set((d.items || []).map(function (i) { return i.resolution; }))]));
          }).catch(function () {});
          return r;
        });
      }
      return of.apply(this, arguments);
    };
    window.__vm = document.getElementById('app').__vue__;
    return 'ok';
  })()`);

  console.log('--- 勾 6 个分辨率 ---');
  await ev(`(() => {
    const items = [...document.querySelectorAll('.fgroup .fitem')];
    ${JSON.stringify(WANT)}.forEach(function (tag) {
      const el = items.find(function (b) { const t = b.querySelector('.fitem-text'); return t && t.textContent.trim() === tag; });
      if (el) el.querySelector('input').click();
    });
  })()`);
  await sleep(10000);
  console.log((await ev('window.__t')).join('\n'));

  console.log('\n--- 再点「场景」---');
  await ev(`window.__t.length = 0`);
  const hit = await ev(`(() => {
    const items = [...document.querySelectorAll('.fgroup .fitem')];
    const el = items.find(function (b) { const t = b.querySelector('.fitem-text'); return t && t.textContent.trim() === '场景'; });
    if (!el) return 'not-found:' + items.slice(0, 5).map(function (b) { return b.textContent.trim(); }).join('|');
    el.querySelector('input').click();
    return 'clicked';
  })()`);
  console.log('点击结果: ' + hit);
  await sleep(12000);
  console.log((await ev('window.__t')).join('\n'));

  console.log('\n最终 vm: ' + JSON.stringify(await ev(`(() => { const v = window.__vm; return {
    groups: v.filters.tagGroups,
    total: v.totalCount,
    types: [...new Set(v.items.map(function (i) { return i.wallpaperType; }))],
    resolutions: [...new Set(v.items.map(function (i) { return i.resolution; }))],
    merged: v.lastResult && v.lastResult.merged,
    reqs: v.lastResult && v.lastResult.mergeRequests
  }; })()`), null, 2));

  ws.close(); chrome.kill(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
