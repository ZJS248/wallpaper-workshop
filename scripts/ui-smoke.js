'use strict';
/**
 * 界面冒烟检查：用真实浏览器打开应用，验证渲染结果与关键交互。
 *
 * 为什么需要：模板写在 JS 的反引号字符串里，`node --check` 只查 JS 语法，
 * `scripts/check-templates.js` 只能查模板结构 —— 两者都**看不出运行时表现**：
 * 元素有没有真的渲染、CSS 有没有生效、点击有没有反应。这个脚本补上这一段。
 *
 * 依赖（**不在 package.json 里**，需要单独装一次）：
 *     npm i playwright-core
 * 本机已有 Edge，所以用它自带的浏览器即可，**不需要**再下 ~500MB 的 Chromium：
 * 脚本用 `channel: 'msedge'` 驱动系统 Edge。想用别的浏览器就改 CHANNEL。
 *
 * 用法：
 *     node server.js 9411            # 先起服务
 *     node scripts/ui-smoke.js http://127.0.0.1:9411
 * 截图落在 scripts/ui-shots/。
 */
const path = require('path');
const fs = require('fs');

const BASE = process.argv[2] || 'http://127.0.0.1:9391';
const OUT = path.join(__dirname, 'ui-shots');
const CHANNEL = process.env.UI_SMOKE_CHANNEL || 'msedge';

let chromium;
try {
  ({ chromium } = require('playwright-core'));
} catch (e) {
  console.error('缺少依赖 playwright-core。先装一次：npm i playwright-core');
  console.error('（本脚本用系统已装的 Edge，不需要下载 Chromium）');
  process.exit(2);
}

let pass = 0;
let fail = 0;
function check(ok, label, extra) {
  if (ok) pass++;
  else fail++;
  console.log((ok ? '  \u2713 ' : '  \u2717 ') + label + (extra ? '  — ' + extra : ''));
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  const browser = await chromium.launch({ channel: CHANNEL, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  console.log('目标：' + BASE);
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // 首屏要经代理抓 Steam，给足时间
  await page.waitForSelector('.card', { timeout: 90000 }).catch(() => {});
  const cards = await page.locator('.card').count();
  check(cards > 0, '列表渲染出卡片', cards + ' 张');

  // 图片是异步加载的，要等它加载完再判定，否则会把"还没加载"误判成"加载失败"
  await page.waitForTimeout(15000);
  const imgStat = await page.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll('.card-thumb img'));
    return {
      total: imgs.length,
      loaded: imgs.filter((i) => i.complete && i.naturalWidth > 0).length,
      broken: imgs.filter((i) => i.complete && i.naturalWidth === 0).length,
    };
  });
  check(imgStat.total > 0 && imgStat.broken === 0, '缩略图无破图',
    imgStat.loaded + '/' + imgStat.total + ' 已加载，' + imgStat.broken + ' 张失败');
  await page.screenshot({ path: path.join(OUT, '01-list.png') });

  // 卡片是否真的应用了"跳过屏外渲染"（这条只能在真实浏览器里验）
  const cv = await page
    .locator('.card')
    .first()
    .evaluate((el) => {
      const s = getComputedStyle(el);
      return { cv: s.contentVisibility, size: s.containIntrinsicSize };
    })
    .catch(() => null);
  check(!!cv && cv.cv === 'auto', '卡片 content-visibility 生效', cv ? JSON.stringify(cv) : '(取不到)');

  // 详情面板：**加载态下也必须能关闭**（曾经的 bug：加载/出错/空态都没有关闭按钮）
  await page.locator('.card').first().click();
  await page.waitForTimeout(400);
  const closeInLoading = await page.locator('.detail .detail-close').count();
  check(closeInLoading > 0, '详情加载中就有关闭按钮');
  await page.screenshot({ path: path.join(OUT, '02-detail-loading.png') });

  await page.waitForSelector('.detail-body', { timeout: 90000 }).catch(() => {});
  check((await page.locator('.detail .detail-close').count()) > 0, '详情加载完成后关闭按钮仍在');
  await page.screenshot({ path: path.join(OUT, '03-detail-loaded.png') });

  await page.locator('.detail .detail-close').first().click();
  await page.waitForTimeout(400);
  check((await page.locator('.detail-body').count()) === 0, '点关闭后面板确实收起');

  // 翻页要回到顶部。
  // 这里踩过坑：滚动容器是外层 `.content`（overflow-y:auto），**不是** `.grid`
  // （`.grid` 只是 display:grid，没有 overflow，对它设 scrollTop 是空操作）。
  // 曾经 scrollToTop() 拿的是挂在 .grid 上的 ref，于是翻页根本不回顶部。
  const scrollBox = await page.evaluate(() => {
    const c = document.querySelector('.content');
    return c ? { sh: c.scrollHeight, ch: c.clientHeight } : null;
  });
  if (scrollBox && scrollBox.sh > scrollBox.ch) {
    await page.evaluate(() => {
      document.querySelector('.content').scrollTop = document.querySelector('.content').scrollHeight;
    });
    await page.waitForTimeout(500);
    const before = await page.evaluate(() => document.querySelector('.content').scrollTop);
    const p2 = page.locator('.pg').filter({ hasText: /^2$/ }).first();
    if (await p2.count()) {
      await p2.click();
      await page.waitForTimeout(8000);
      const after = await page.evaluate(() => document.querySelector('.content').scrollTop);
      check(after < 50, '翻页后滚动条回到顶部', before + ' → ' + after);
    }
  } else {
    console.log('  - 内容不够长，跳过翻页滚动检查');
  }

  // 控制台不该有 JS 报错（favicon / 图片网络错误不算）
  const real = errors.filter((t) => !/favicon|net::ERR_/.test(t));
  check(real.length === 0, '无 JS 控制台错误', real.slice(0, 3).join(' | '));

  await browser.close();
  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项；截图目录：' + OUT);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('冒烟检查失败：' + (e && e.message ? e.message : e));
  process.exit(1);
});
