'use strict';
/**
 * 无头 Chrome 渲染自检：
 *   1. 打开页面，等列表加载完
 *   2. 抓取控制台报错 / 失败请求
 *   3. 断言关键 DOM（卡片数、筛选器、详情面板）
 *   4. 截图存到 config/shots/
 *
 * 用法： node scripts/browser-check.js [url]
 * 依赖： 系统里有 Chrome（不走 CDP 库，直接用 --dump-dom / --screenshot）
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const URL_ = process.argv[2] || 'http://127.0.0.1:9391/';
const OUT = path.join(__dirname, '..', 'config', 'shots');
fs.mkdirSync(OUT, { recursive: true });

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];

const chrome = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
if (!chrome) {
  console.error('找不到 Chrome/Edge，跳过浏览器自检');
  process.exit(0);
}
console.log('浏览器：' + chrome);

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-chrome-'));

function run(args, timeout) {
  return execFileSync(chrome, args, {
    encoding: 'utf8',
    timeout: timeout || 90000,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const common = [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--user-data-dir=' + profile,
  '--window-size=1600,900',
  '--virtual-time-budget=15000',
];

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('  \u2713 ' + name + (extra ? '  \u2014 ' + extra : ''));
  else {
    failures++;
    console.log('  \u2717 ' + name + (extra ? '  \u2014 ' + extra : ''));
  }
}

(async () => {
  // ---- 1. 初始渲染 ----
  console.log('\n[1] 首屏渲染');
  const dom = run(common.concat(['--dump-dom', URL_]));
  fs.writeFileSync(path.join(OUT, 'dom-initial.html'), dom, 'utf8');

  check('页面有 #app', dom.includes('id="app"'));
  check('Vue 已挂载（v-cloak 已移除）', !/<div id="app"[^>]*v-cloak/.test(dom), '');
  // 注意：Vue 会给元素加 data-v-xxxx，class 属性会变成 class="card" 或 class="card active"…
  const cardCount = (dom.match(/class="card[^"]*"/g) || []).length;
  check('渲染出卡片', cardCount > 0, cardCount + ' 张卡片');
  const hasFilters = dom.includes('class="fgroup') && dom.includes('年龄分级') && dom.includes('分辨率');
  check('筛选器渲染', hasFilters, '');
  check('排序下拉有「评分最高」', dom.includes('评分最高'), '');
  check('详情面板空态', dom.includes('选择一张壁纸查看详情'), '');
  // 图片是 loading="lazy"，首屏只解析出一部分，所以断言"至少有一批"而不是全部
  const imgProxied = (dom.match(/\/img\?u=/g) || []).length;
  check('预览图走后端代理', imgProxied > 0, imgProxied + ' 个 /img?u= 图片（其余懒加载）');
  check('卡片带类型角标（中文）', dom.includes('badge-type'), '');
  check('顶栏状态显示', /已登录|未登录|登录态失效/.test(dom), '');
  check('没有残留的 Vue 花括号表达式', !/\{\{\s*\w+\./.test(dom), '');

  // ---- 2. 截图 ----
  console.log('\n[2] 截图');
  run(common.concat(['--screenshot=' + path.join(OUT, '01-workshop.png'), URL_]));
  check('已保存 01-workshop.png', fs.existsSync(path.join(OUT, '01-workshop.png')));

  // ---- 3. 带 hash/查询的交互路由（点开某张壁纸的链接不可用，这里验证 URL 参数化的搜索） ----
  console.log('\n[3] 搜索渲染');
  const dom2 = run(common.concat(['--dump-dom', URL_ + '?q=' + encodeURIComponent('初音')]));
  check('搜索页仍能渲染', dom2.includes('id="app"'));

  // ---- 4. 控制台报错 ----
  console.log('\n[4] 控制台与网络错误');
  const logFile = path.join(OUT, 'chrome-log.txt');
  let log = '';
  try {
    log = execFileSync(chrome, common.concat(['--enable-logging=stderr', '--v=0', '--dump-dom', URL_]), {
      encoding: 'utf8',
      timeout: 90000,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    log = (e.stdout || '') + (e.stderr || '');
  }
  fs.writeFileSync(logFile, log, 'utf8');
  const badLines = String(log)
    .split(/\r?\n/)
    .filter((l) => /SEVERE|Uncaught|ERROR:.*(javascript|console)|Failed to load resource/i.test(l));
  check('没有 JS 错误 / 资源加载失败', badLines.length === 0, badLines.slice(0, 6).join(' | ') || '无');

  console.log('\n================ 浏览器自检：' + (failures ? failures + ' 项失败' : '全部通过') + ' ================');
  console.log('截图与 DOM 快照目录：' + OUT);
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('浏览器自检异常：', e && e.message ? e.message : e);
  process.exit(2);
});
