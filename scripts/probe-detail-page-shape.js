'use strict';
/** 看"非详情页"的形态，判断它是暂时的精简页还是永久错误页。 */
const { getText } = require('../server/lib/httpClient');
const settings = require('../server/lib/settings');
const session = require('../server/lib/session');

(async function main() {
  const c = settings.getConfig();
  const ctx = session.currentContext();
  const ids = process.argv.slice(2).length ? process.argv.slice(2) : ['3807151772', '999999999999', '884307090'];
  for (const id of ids) {
    const t = Date.now();
    const r = await getText('https://steamcommunity.com/sharedfiles/filedetails/?id=' + id, {
      cookie: ctx.cookie,
      proxy: c.proxy,
      timeout: 30000,
      noLimit: true,
    });
    const h = r.body || '';
    console.log(
      id + '  HTTP ' + r.status + '  bytes ' + h.length + '  ' + (Date.now() - t) + ' ms' +
      '\n  title      : ' + ((h.match(/<title>([^<]*)<\/title>/) || [])[1] || '') +
      '\n  isDetail   : ' + /SubscribeItemBtn|workshopItemTitle/.test(h) +
      '\n  被移除     : ' + /该物品已被移除|has been removed/.test(h) +
      '\n  Error 页   : ' + /::\s*Error/.test(h) +
      '\n  error_ctn  : ' + /error_ctn|errorBox|Sorry/.test(h) +
      '\n  片段       : ' + h.slice(0, 0).length
    );
    const m = h.match(/<div class="error_ctn">[\s\S]{0,300}?<\/div>/);
    if (m) console.log('  error 块   : ' + m[0].replace(/\s+/g, ' ').slice(0, 200));
  }
})().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
