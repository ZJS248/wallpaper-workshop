'use strict';
/**
 * 用 Chrome DevTools Protocol 做真实交互自检。
 *
 * 为什么不装 puppeteer：本项目坚持零依赖。CDP 只需要 WebSocket，
 * 而 Node 24 自带全局 WebSocket，所以可以直接连。
 *
 * 覆盖的交互：
 *   1. 首屏加载 → 卡片渲染
 *   2. 点第一张卡片 → 详情面板打开、显示标题/作者/统计/相关壁纸
 *   3. 点作者 → 切到作者视图（"相关壁纸"跳转）
 *   4. 返回创意工坊 → 列表恢复
 *   5. 改排序（评分最高）→ 列表刷新且首条变化
 *   6. 加一个标签 → 总数变化
 *   7. 搜索 → 结果变化
 *   8. 分页 → 第 2 页内容不同
 *   9. 打开设置抽屉 → 显示登录态
 *  10. 全程收集 console 错误 / 失败请求
 *
 * 用法： node scripts/cdp-check.js
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const URL_ = process.argv[2] || 'http://127.0.0.1:9391/';
const OUT = path.join(__dirname, '..', 'config', 'shots');
fs.mkdirSync(OUT, { recursive: true });

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
].find((p) => fs.existsSync(p));

if (!CHROME) {
  console.log('找不到 Chrome，跳过 CDP 自检');
  process.exit(0);
}

const PORT = 9333 + Math.floor(Math.random() * 200);
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-cdp-'));

let pass = 0;
let fail = 0;
const consoleErrors = [];
const failedRequests = [];

function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  \u2713 ' + name + (extra ? '  \u2014 ' + extra : ''));
  } else {
    fail++;
    console.log('  \u2717 ' + name + (extra ? '  \u2014 ' + extra : ''));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--remote-debugging-port=' + PORT,
      '--user-data-dir=' + userDataDir,
      '--window-size=1600,900',
      'about:blank',
    ],
    { stdio: 'ignore' }
  );

  // 等 DevTools 端口起来
  let wsUrl = null;
  for (let i = 0; i < 60 && !wsUrl; i++) {
    await sleep(250);
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/json/version');
      const j = await r.json();
      wsUrl = j.webSocketDebuggerUrl;
    } catch (e) {
      /* 还没起来 */
    }
  }
  if (!wsUrl) throw new Error('Chrome DevTools 端口没起来');

  // 用 browser 级连接开一个 page target
  const browserWs = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    browserWs.onopen = res;
    browserWs.onerror = rej;
  });

  let msgId = 0;
  const pending = new Map();
  function send(method, params, sessionId) {
    const id = ++msgId;
    const payload = { id, method, params: params || {} };
    if (sessionId) payload.sessionId = sessionId;
    browserWs.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error('CDP 超时：' + method));
        }
      }, 45000);
    });
  }

  let sessionId = null;
  const events = [];
  browserWs.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message));
      else p.resolve(m.result);
      return;
    }
    if (m.method) events.push(m);
  };

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const attached = await send('Target.attachToTarget', { targetId, flatten: true });
  sessionId = attached.sessionId;

  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  await send('Network.enable', {}, sessionId);
  await send('Log.enable', {}, sessionId);

  // 收集错误
  const drainEvents = () => {
    for (const e of events.splice(0)) {
      if (e.method === 'Runtime.exceptionThrown') {
        const d = e.params.exceptionDetails || {};
        consoleErrors.push('EXCEPTION: ' + (d.exception && d.exception.description ? d.exception.description.split('\n')[0] : d.text));
      }
      if (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') {
        consoleErrors.push('CONSOLE: ' + (e.params.args || []).map((a) => a.value || a.description || '').join(' '));
      }
      if (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') {
        consoleErrors.push('LOG: ' + e.params.entry.text + ' ' + (e.params.entry.url || ''));
      }
      if (e.method === 'Network.loadingFailed') {
        failedRequests.push(e.params.errorText + ' ' + (e.params.type || ''));
      }
      if (e.method === 'Network.responseReceived') {
        const r = e.params.response;
        if (r.status >= 400 && !/favicon/.test(r.url)) failedRequests.push('HTTP ' + r.status + ' ' + r.url.slice(0, 100));
      }
    }
  };

  async function evaluate(expr) {
    const r = await send(
      'Runtime.evaluate',
      { expression: expr, returnByValue: true, awaitPromise: true },
      sessionId
    );
    if (r.exceptionDetails) {
      throw new Error('求值异常：' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description));
    }
    return r.result.value;
  }

  async function shot(name) {
    const r = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
    fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64'));
  }

  /** 等某个条件成立 */
  async function waitFor(expr, timeout, label) {
    const t0 = Date.now();
    while (Date.now() - t0 < (timeout || 30000)) {
      try {
        if (await evaluate(expr)) return true;
      } catch (e) {
        /* 继续等 */
      }
      await sleep(250);
    }
    throw new Error('等待超时：' + (label || expr));
  }

  console.log('浏览器：' + CHROME);
  console.log('页面：' + URL_);

  // ---------- 1. 首屏 ----------
  console.log('\n[1] 首屏加载');
  await send('Page.navigate', { url: URL_ }, sessionId);
  await waitFor('document.querySelectorAll(".card").length > 0', 45000, '卡片渲染');
  const firstTitle = await evaluate('document.querySelector(".card .card-title").textContent.trim()');
  const cardCount = await evaluate('document.querySelectorAll(".card").length');
  const totalText = await evaluate('document.querySelector(".count") ? document.querySelector(".count").textContent : ""');
  check('卡片已渲染', cardCount > 0, cardCount + ' 张，首条「' + firstTitle + '」');
  check('显示总数', /共.*个作品/.test(totalText), totalText);
  await shot('02-cdp-loaded.png');

  // ---------- 2. 点卡片 → 详情 ----------
  console.log('\n[2] 点开详情');
  /**
   * 详情要走"社区详情页 + 公开 API + 该作者的作品页"三跳，上游偶发 TLS 握手失败时
   * 会整体失败并显示错误态。这里给它 90 秒，并且**失败就再点一次**
   * （点第二次会走 reloadDetail，重新发一次请求）——
   * 否则一次网络抖动就会让整个 CDP 组红掉，掩盖真正的回归。
   */
  const openDetail = async () => {
    for (let i = 0; i < 3; i++) {
      await evaluate('document.querySelectorAll(".grid .card")[0].click()');
      try {
        await waitFor('!!document.querySelector(".detail-title")', 90000, '详情标题');
        return true;
      } catch (e) {
        const st = await evaluate(`(() => {
          const v = document.getElementById('app').__vue__;
          return { loading: v.detailLoading, error: v.detailError };
        })()`);
        console.log('  · 详情第 ' + (i + 1) + ' 次未出来（' + JSON.stringify(st) + '），重试');
        await sleep(1500);
      }
    }
    return false;
  };
  const detailOk = await openDetail();
  check('详情能打开（含上游抖动重试）', detailOk, detailOk ? '' : '三次都没出来');
  if (!detailOk) {
    await shot('02b-cdp-detail-fail.png');
    throw new Error('详情面板始终打不开，后续用例无法继续');
  }
  const dTitle = await evaluate('document.querySelector(".detail-title").textContent.trim()');
  const dAuthor = await evaluate('document.querySelector(".author-name") ? document.querySelector(".author-name").textContent.trim() : ""');
  const dStats = await evaluate('document.querySelectorAll(".metric-v").length');
  const dActions = await evaluate('document.querySelectorAll(".detail-actions .act").length');
  const dTags = await evaluate('document.querySelectorAll(".detail .chip").length');
  check('详情标题', !!dTitle, dTitle);
  check('详情作者', !!dAuthor, dAuthor);
  check('指标块（订阅/收藏/累计）', dStats === 3, dStats + ' 个');
  check('操作按钮', dActions >= 3, dActions + ' 个');
  check('标签渲染', dTags > 0, dTags + ' 个');

  // 相关壁纸是"该作者的创意工坊"，由前端**单独并发**去拉（/api/author）。
  // 注意：如果该作者只有这一个作品，相关列表**合理地**会是空的（去掉自己就没了），
  // 所以这里对比的是"后端返回了几个"和"前端渲染了几个"，而不是硬要求 > 0。
  let dRelated = 0;
  let backendRelated = -1;
  for (let i = 0; i < 90; i++) {
    await sleep(500);
    const r = await evaluate(`(() => {
      const vm = document.getElementById('app').__vue__;
      if (!vm) return { n: 0, total: -1, loading: false, err: 'no vm' };
      const rel = vm.related;
      return {
        n: rel && rel.items ? rel.items.length : 0,
        total: rel ? rel.totalCount : -1,
        loading: !!vm.relatedLoading,
        err: vm.relatedError || ''
      };
    })()`);
    backendRelated = r.total;
    dRelated = await evaluate('document.querySelectorAll(".related .card").length');
    if (r.err) break;
    if (!r.loading && r.total >= 0) break;   // 这一轮已经拉完了
  }
  if (backendRelated === 1) {
    check('相关壁纸（该作者仅此一个 → 合理为空）', dRelated === 0, '后端 total=1，前端渲染 ' + dRelated + ' 个');
  } else {
    check('相关壁纸（该作者的创意工坊）', dRelated > 0, '后端 total=' + backendRelated + '，前端渲染 ' + dRelated + ' 个');
  }
  await shot('03-cdp-detail.png');

  // ---------- 3. 相关壁纸 → 作者视图 ----------
  console.log('\n[3] 相关壁纸 → 作者作品');
  await evaluate('document.querySelector(".detail-author").click()');
  await waitFor('!!document.querySelector(".authorbar")', 45000, '作者视图');
  const authorBar = await evaluate('document.querySelector(".authorbar").textContent.replace(/\\s+/g, " ").trim()');
  const authorCards = await evaluate('document.querySelectorAll(".card").length');
  check('进入作者视图', !!authorBar, authorBar.slice(0, 70));
  check('作者作品已加载', authorCards > 0, authorCards + ' 个');
  await shot('04-cdp-author.png');

  // ---------- 4. 返回 ----------
  console.log('\n[4] 返回创意工坊');
  await evaluate('document.querySelector(".authorbar .fbtn").click()');
  await waitFor('!document.querySelector(".authorbar")', 30000, '回到列表');
  await waitFor('document.querySelectorAll(".card").length > 0', 45000, '列表恢复');
  check('返回后仍有卡片', (await evaluate('document.querySelectorAll(".card").length')) > 0);

  // ---------- 5. 排序 ----------
  console.log('\n[5] 排序切换');
  const before = await evaluate('document.querySelector(".card .card-title").textContent.trim()');
  await evaluate(`(() => {
    const sel = document.querySelectorAll('.toolbar-right .sel')[0];
    sel.value = 'toprated';
    sel.dispatchEvent(new Event('change'));
  })()`);
  await waitFor(`document.querySelector('.card .card-title').textContent.trim() !== ${JSON.stringify(before)}`, 45000, '排序生效');
  const after = await evaluate('document.querySelector(".card .card-title").textContent.trim()');
  check('排序切换后首条变化', before !== after, before + ' → ' + after);

  // ---------- 6. 标签筛选 ----------
  console.log('\n[6] 标签筛选');
  const totalBefore = await evaluate('document.querySelector(".count") ? document.querySelector(".count").textContent : ""');
  await evaluate(`(() => {
    const boxes = [...document.querySelectorAll('.fgroup .fitem')];
    const anime = boxes.find(b => b.textContent.includes('Anime'));
    if (anime) { anime.querySelector('input').click(); return true; }
    return false;
  })()`);
  // 等"总数真的变了"，不用固定 sleep（社区页有限流，慢的时候要等一会儿）
  let totalAfter = totalBefore;
  for (let i = 0; i < 60; i++) {
    await sleep(400);
    totalAfter = await evaluate('document.querySelector(".count") ? document.querySelector(".count").textContent : ""');
    if (totalAfter !== totalBefore) break;
  }
  const chipCount = await evaluate('document.querySelectorAll(".active-chips .chip").length');
  check('出现已选标签', chipCount > 0, chipCount + ' 个');
  check('总数发生变化', totalBefore !== totalAfter, totalBefore + ' → ' + totalAfter);
  await shot('05-cdp-filtered.png');

  // ---------- 7. 搜索 ----------
  console.log('\n[7] 搜索');
  const beforeSearch = await evaluate('document.querySelector(".card .card-title").textContent.trim()');
  await evaluate(`(() => {
    const i = document.querySelector('.search input');
    i.value = '初音';
    i.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('.search-go').click();
  })()`);
  let searchChanged = false;
  for (let i = 0; i < 60; i++) {
    await sleep(400);
    const t = await evaluate('document.querySelector(".card .card-title").textContent.trim()');
    if (t !== beforeSearch) { searchChanged = true; break; }
  }
  const titles = await evaluate('[...document.querySelectorAll(".card-title")].slice(0, 8).map(e => e.textContent.trim())');
  const searchTotal = await evaluate('document.querySelector(".count") ? document.querySelector(".count").textContent : ""');
  const hit = titles.some((t) => /初音|Miku|miku/.test(t));
  check('搜索触发刷新', searchChanged || hit, searchTotal);
  check('搜索结果与关键词相关', hit, titles.slice(0, 3).join(' / '));
  await shot('06-cdp-search.png');

  // ---------- 8. 分页 ----------
  console.log('\n[8] 分页');
  const p1 = await evaluate('document.querySelector(".card .card-title").textContent.trim()');
  await evaluate(`(() => {
    const btns = [...document.querySelectorAll('.pg')];
    const two = btns.find(b => b.textContent.trim() === '2');
    if (two) two.click();
  })()`);
  let p2 = p1;
  for (let i = 0; i < 60; i++) {
    await sleep(400);
    p2 = await evaluate('document.querySelector(".card .card-title").textContent.trim()');
    if (p2 !== p1) break;
  }
  const pageInfo = await evaluate('document.querySelector(".pg-info") ? document.querySelector(".pg-info").textContent : ""');
  check('翻页后内容变化', p1 !== p2, (pageInfo || '') + '　' + p1 + ' → ' + p2);

  // ---------- 9. 设置抽屉 ----------
  console.log('\n[9] 设置抽屉');
  await evaluate('document.querySelector(".topbar-right .icon-btn").click()');
  await waitFor('!!document.querySelector(".drawer")', 15000, '抽屉打开');
  const drawerText = await evaluate('document.querySelector(".drawer-body").textContent.replace(/\\s+/g, " ").trim().slice(0, 400)');
  check('抽屉显示登录态', /已登录|未登录/.test(drawerText), drawerText.slice(0, 110));
  check('抽屉显示网络信息', drawerText.includes('代理') || drawerText.includes('直连'), '');
  await shot('07-cdp-settings.png');
  await evaluate('document.querySelector(".drawer-head .close").click()');
  await sleep(400);

  // ---------- 10. 范围收敛：只做创意工坊 ----------
  // 「我的订阅 / 我的收藏」两个列表视图已按需求移除（它们与创意工坊主链路是两套
  // 分页语义，成本高价值低）。这里验证的是"顶栏确实没有它们"，以及
  // 「创意工坊」这个 Tab 真的能把排序复位（原来点了没反应 = 报告里的 BUG-04）。
  console.log('\n[10] 只做创意工坊：顶栏与 Tab 复位');
  await evaluate(`(() => {
    const i = document.querySelector('.search input');
    i.value = '';
    i.dispatchEvent(new Event('input', { bubbles: true }));
    const c = document.querySelector('.search-clear');
    if (c) c.click();
  })()`);
  await sleep(2500);

  const tabsNow = await evaluate(`[...document.querySelectorAll('.tabs .tab')].map(function (b) { return b.textContent.trim(); })`);
  check('顶栏没有「我的订阅」Tab', tabsNow.indexOf('我的订阅') < 0, JSON.stringify(tabsNow));
  check('顶栏没有「我的收藏」Tab', tabsNow.indexOf('我的收藏') < 0, JSON.stringify(tabsNow));
  check('顶栏保留「创意工坊」Tab', tabsNow.indexOf('创意工坊') >= 0, JSON.stringify(tabsNow));

  // 切到「最近更新」再点回「创意工坊」，排序必须复位成 trend
  await evaluate(`(() => {
    const sel = document.querySelector('.toolbar-right select');
    sel.value = 'lastupdated';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await sleep(3500);
  const sortBefore = await evaluate(`document.getElementById('app').__vue__.filters.sort`);
  check('已切到「最近更新」', sortBefore === 'lastupdated', sortBefore);
  await evaluate(`(() => {
    const t = [...document.querySelectorAll('.tabs .tab')].find(b => b.textContent.trim() === '创意工坊');
    if (t) t.click();
  })()`);
  await sleep(3500);
  const sortAfter = await evaluate(`document.getElementById('app').__vue__.filters.sort`);
  check('点「创意工坊」后排序复位为 trend（BUG-04）', sortAfter === 'trend', sortAfter);
  await shot('08-cdp-browse-only.png');

  // ---------- 11. 错误汇总 ----------
  console.log('\n[11] 运行期错误');
  drainEvents();
  const realErrors = consoleErrors.filter((e) => !/favicon|ERR_ABORTED/.test(e));
  check('没有 JS 异常', realErrors.length === 0, realErrors.slice(0, 4).join(' | ') || '无');
  const realFails = failedRequests.filter((f) => !/favicon|net::ERR_ABORTED/.test(f));
  check('没有失败请求', realFails.length === 0, realFails.slice(0, 4).join(' | ') || '无');

  console.log('\n================ CDP 自检：' + pass + ' 通过 / ' + fail + ' 失败 ================');
  console.log('截图目录：' + OUT);

  try {
    browserWs.close();
  } catch (e) {
    /* ignore */
  }
  chrome.kill();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error('\nCDP 自检异常：' + (e && e.stack ? e.stack : e));
  process.exit(2);
});
