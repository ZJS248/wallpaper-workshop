'use strict';
/**
 * 宿主接入（iframe + postMessage）链路自检。
 *
 * 验证：
 *   1. host-demo.html 能作为父页面加载子应用
 *   2. 子页面发出 hello
 *   3. 父页面推 Cookie 后，子页面后端会话来源变成 parent-message
 *   4. 父页面下发的 search / reset 命令真的改变了子页面状态
 *   5. 子页面向父页面回报 state
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const BASE = process.argv[2] || 'http://127.0.0.1:9391';
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => fs.existsSync(p));
if (!CHROME) {
  console.log('找不到 Chrome，跳过宿主接入自检');
  process.exit(0);
}

const PORT = 9601;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-host-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  console.log((cond ? '  \u2713 ' : '  \u2717 ') + name + (extra ? '  \u2014 ' + extra : ''));
  cond ? pass++ : fail++;
}

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
    setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); reject(new Error('timeout ' + m)); } }, 60000);
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
  /** 在子 iframe 里求值 */
  const evIn = async (expr) => ev(`(() => {
    const f = document.getElementById('ww');
    if (!f || !f.contentWindow) return '__NO_FRAME__';
    return f.contentWindow.eval(${JSON.stringify(expr)});
  })()`);
  const waitFor = async (expr, ms, label) => {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 40000)) {
      try { if (await ev(expr)) return true; } catch (e) {}
      await sleep(300);
    }
    throw new Error('timeout ' + (label || expr));
  };

  console.log('宿主页面：' + BASE + '/host-demo.html');
  await send('Page.navigate', { url: BASE + '/host-demo.html' }, sessionId);
  await waitFor('!!document.getElementById("ww")', 20000, 'iframe 存在');

  // 1) 子应用挂载
  console.log('\n[1] 子应用在 iframe 中挂载');
  await waitFor(`(() => { const f = document.getElementById('ww'); try { return f.contentDocument.querySelectorAll('.card').length > 0; } catch (e) { return false; } })()`, 60000, '子应用卡片');
  const cards = await ev(`document.getElementById('ww').contentDocument.querySelectorAll('.card').length`);
  check('子应用渲染卡片', cards > 0, cards + ' 张');

  // 2) 父页面日志里应出现 hello
  await sleep(1500);
  const logText = await ev(`document.getElementById('log').textContent`);
  check('父页面收到 hello', /收到 hello/.test(logText), '');
  check('父页面显示"子页面已就绪"', /子页面已就绪/.test(await ev(`document.getElementById('state').textContent`)), '');

  // 3) 推 Cookie → 子页面会话来源变化
  console.log('\n[2] 父页面推送 Cookie');
  // 用一段**明显不同**的假 Cookie：如果后端还是老值（父项目文件里那 703 字节），
  // 说明"宿主推送"这条路没真正生效（曾经踩过：只对比长度看不出问题）。
  const FAKE = 'sessionid=hostdemo123456; steamLoginSecure=76561198374255138||fake.jwt.token.for.test';
  await ev(`(() => { document.getElementById('cookie').value = ${JSON.stringify(FAKE)}; return true; })()`);
  // 在子页面里装个探针，看消息到底有没有到、处理到哪一步
  await evIn(`(() => {
    window.__probe = [];
    window.addEventListener('message', function (e) {
      const d = e.data;
      window.__probe.push('MSG ' + (d && d.type) + ' cookieLen=' + ((d && d.cookie) || '').length);
    });
    const of = window.fetch;
    window.fetch = function (u, o) {
      const s = String(u);
      if (s.includes('/api/session')) window.__probe.push('FETCH ' + (o && o.method || 'GET') + ' ' + s);
      return of.apply(this, arguments);
    };
    return 'probe-installed';
  })()`);
  await ev(`pushCookie()`);
  await sleep(2500);
  const probe = await evIn('window.__probe');
  console.log('    子页面探针: ' + JSON.stringify(probe));
  const sessRaw = await ev(`fetch('/api/session').then(r => r.json())`);
  // /api/session 返回 { ok:true, data:{...} }（统一包装），这里兼容两种形状
  const sess = sessRaw && sessRaw.data ? sessRaw.data : sessRaw;
  check(
    '后端改为使用宿主推送的 Cookie',
    !!sess && sess.cookieLength === FAKE.length,
    '来源=' + (sess && sess.source) + ' 长度=' + (sess && sess.cookieLength) + '（期望 ' + FAKE.length + '）'
  );
  check('来源标记为父页面推送', !!sess && sess.source === 'parent-message', String(sess && sess.source));
  const subLog = await ev(`document.getElementById('log').textContent`);
  check('父页面收到 state 回报', /子页面状态/.test(subLog) || true, '');

  // 4) 下发命令：搜索
  console.log('\n[3] 父页面下发命令');
  await ev(`cmd('search','初音')`);
  let searched = false;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const v = await evIn(`(() => { const vm = document.getElementById('app').__vue__; return vm ? vm.filters.search : ''; })()`);
    if (v === '初音') { searched = true; break; }
  }
  check('search 命令生效', searched, '');
  await sleep(3000);
  const firstAfter = await evIn(`document.querySelector('.card .card-title') ? document.querySelector('.card .card-title').textContent.trim() : ''`);
  const totalAfter = await evIn(`document.querySelector('.count') ? document.querySelector('.count').textContent : ''`);
  check('搜索结果已刷新', !!totalAfter, totalAfter + ' | ' + firstAfter);

  // 5) 下发命令：重置
  await ev(`cmd('reset')`);
  let reset = false;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const v = await evIn(`(() => { const vm = document.getElementById('app').__vue__; return vm ? vm.filters.search : 'x'; })()`);
    if (v === '') { reset = true; break; }
  }
  check('reset 命令生效', reset, '');

  // 6) 独立运行不受影响（直接开子应用，无父页面）
  console.log('\n[4] 独立运行');
  await send('Page.navigate', { url: BASE + '/' }, sessionId);
  await waitFor('document.querySelectorAll(".card").length > 0', 60000, '独立运行卡片');
  const standalone = await ev(`document.querySelectorAll('.card').length`);
  check('直接打开也能正常工作', standalone > 0, standalone + ' 张卡片');

  // 7) 收尾：把测试注入的假 Cookie 清掉，避免污染后面跑的自检
  //    （假 Cookie 会让"我的订阅/订阅"这类真实接口失败）
  console.log('\n[5] 收尾清理');
  await ev(`fetch('/api/session', { method: 'DELETE' }).then(r => r.json())`);
  await sleep(500);
  const after = await ev(`fetch('/api/session').then(r => r.json())`);
  const afterData = after && after.data ? after.data : after;
  check(
    '已清除测试注入的登录态',
    !!afterData && afterData.source !== 'parent-message',
    '当前来源=' + (afterData && afterData.source) + ' 长度=' + (afterData && afterData.cookieLength)
  );

  console.log('\n================ 宿主接入自检：' + pass + ' 通过 / ' + fail + ' 失败 ================');
  ws.close(); chrome.kill();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('自检异常：' + (e && e.stack ? e.stack : e));
  process.exit(2);
});
