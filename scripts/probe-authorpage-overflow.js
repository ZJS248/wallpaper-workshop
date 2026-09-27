'use strict';
/**
 * 看"翻过头的作者页"长什么样（决定能不能把它当成终止条件）。
 * 用法：node scripts/probe-authorpage-overflow.js 76561198866437317
 */
const { getText } = require('../server/lib/httpClient');
const authorPage = require('../server/lib/authorPage');
const settings = require('../server/lib/settings');
const session = require('../server/lib/session');

(async function main() {
  const cfg = settings.getConfig();
  const ctx = session.currentContext();
  const id = process.argv[2] || '76561198866437317';

  for (const p of [1, 2, 3, 40]) {
    const url = authorPage.buildProfileUrl(id, { scope: 'works', page: p, appId: '431960' });
    const t = Date.now();
    try {
      const r = await getText(url, { cookie: ctx.cookie, proxy: cfg.proxy, timeout: 30000, noLimit: true });
      const html = r.body || '';
      const parsed = authorPage.parseAuthorWorksHtml(html, id, p, 30);
      const info = (html.match(/class="workshopBrowsePagingInfo"[^>]*>([\s\S]{0,200}?)<\/div>/) || [])[1] || '';
      const empties = (html.match(/noItemsFound|没有找到|没有项目|暂时没有/gi) || []).length;
      console.log(
        'p=' + p + '  ' + String(Date.now() - t).padStart(6) + ' ms  HTTP ' + r.status +
        '  bytes=' + html.length +
        '  recognized=' + parsed.recognized + ' items=' + parsed.items.length + ' total=' + parsed.total +
        '  空态提示=' + empties
      );
      console.log('    分页信息：' + info.replace(/\s+/g, ' ').slice(0, 120));
    } catch (e) {
      console.log('p=' + p + '  ' + (Date.now() - t) + ' ms  ERR ' + e.message);
    }
  }
})().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
