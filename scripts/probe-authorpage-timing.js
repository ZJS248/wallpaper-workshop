'use strict';
/**
 * 逐次打印作者页请求的耗时与结果，定位"/api/author 要 160 秒"。
 * 用法：node scripts/probe-authorpage-timing.js 76561198866437317
 */
const { getText } = require('../server/lib/httpClient');
const authorPage = require('../server/lib/authorPage');
const settings = require('../server/lib/settings');
const session = require('../server/lib/session');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async function main() {
  const cfg = settings.getConfig();
  const ctx = session.currentContext();
  const id = process.argv[2] || '76561198866437317';

  const url = authorPage.buildProfileUrl(id, { scope: 'works', page: 1, appId: '431960' });
  console.log('proxy =', cfg.proxy, '\nurl =', url, '\n');

  for (let i = 0; i < 4; i++) {
    const t = Date.now();
    try {
      const r = await getText(url, { cookie: ctx.cookie, proxy: cfg.proxy, timeout: 30000, noLimit: true });
      const parsed = authorPage.parseAuthorWorksHtml(r.body || '', id, 1, 30);
      console.log(
        '第 ' + (i + 1) + ' 次  ' + String(Date.now() - t).padStart(7) + ' ms  HTTP ' + r.status +
        '  bytes=' + String((r.body || '').length).padStart(7) +
        '  recognized=' + parsed.recognized + '  items=' + parsed.items.length + '  total=' + parsed.total
      );
    } catch (e) {
      console.log('第 ' + (i + 1) + ' 次  ' + String(Date.now() - t).padStart(7) + ' ms  ERR ' + e.message);
    }
    await sleep(500);
  }

  console.log('\n--- 走完整的 fetchProfileWorks（含重试） ---');
  const t2 = Date.now();
  const r2 = await authorPage.fetchProfileWorks(id, {
    scope: 'works',
    page: 1,
    cookie: ctx.cookie,
    proxy: cfg.proxy,
    timeout: 30000,
    noLimit: true,
  });
  console.log('fetchProfileWorks ' + (Date.now() - t2) + ' ms  ok=' + r2.ok + ' items=' + (r2.items || []).length + ' reason=' + (r2.reason || ''));
})().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
