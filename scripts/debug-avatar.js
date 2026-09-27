'use strict';
/** 排查作者头像为什么取不到。用法：node scripts/debug-avatar.js 884307090 */
const { getText } = require('../server/lib/httpClient');
const sc = require('../server/lib/steamCommunity');
const settings = require('../server/lib/settings');
const session = require('../server/lib/session');

(async function main() {
  const cfg = settings.getConfig();
  const ctx = session.currentContext();
  for (const id of process.argv.slice(2).length ? process.argv.slice(2) : ['884307090']) {
    const r = await getText(sc.COMMUNITY + '/sharedfiles/filedetails/?id=' + id, {
      cookie: ctx.cookie,
      proxy: cfg.proxy,
      timeout: 30000,
      noLimit: true,
    });
    const html = r.body || '';
    console.log('\n===== ' + id + ' =====');
    const parsed = sc.parseDetailHtml(html, id, 'x', []);
    console.log('breadcrumb author =', JSON.stringify(parsed.author));

    const re = /<div class="friendBlock(?:\s[^"]*)?"/g;
    let m;
    let n = 0;
    while ((m = re.exec(html)) && n < 5) {
      n++;
      const seg = html.slice(m.index, m.index + 1400);
      const segLink = (seg.match(/href="(https:\/\/steamcommunity\.com\/(?:profiles|id)\/[^"]+)"/) || [])[1] || '';
      const img = (seg.match(/<img[^>]+src="(https:\/\/avatars\.[^"]+)"/) || [])[1] || '';
      console.log('  friendBlock #' + n + ' @' + m.index);
      console.log('     link = ' + segLink);
      console.log('     img  = ' + img);
      console.log('     head = ' + seg.slice(0, 160).replace(/\s+/g, ' '));
    }
    if (!n) {
      console.log('  (新版正则没有 friendBlock) —— 打印 friendBlockContent 之前的原文：');
      const at = html.indexOf('friendBlock');
      console.log('  @' + at + ' :: ' + html.slice(Math.max(0, at - 300), at + 300).replace(/\s+/g, ' '));
    }
  }
})().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
