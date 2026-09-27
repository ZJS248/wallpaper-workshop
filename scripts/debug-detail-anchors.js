'use strict';
/**
 * 为解析器改造做取证：详情页里「作者」与「评分」两块的稳定锚点。
 * 用法：node scripts/debug-detail-anchors.js [id]
 */
const { getText } = require('../server/lib/httpClient');
const sc = require('../server/lib/steamCommunity');
const settings = require('../server/lib/settings');
const session = require('../server/lib/session');

const IDS = process.argv.slice(2).length ? process.argv.slice(2) : ['884307090', '2358176341', '3792661570'];

function show(html, re, label, max) {
  const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let m;
  let n = 0;
  console.log('\n--- ' + label + ' ---');
  while ((m = r.exec(html)) && n < (max || 4)) {
    n++;
    console.log('@' + m.index + ' :: ' + html.slice(m.index, m.index + 420).replace(/\s+/g, ' '));
  }
  if (!n) console.log('(无命中)');
}

(async function main() {
  const cfg = settings.getConfig();
  const ctx = session.currentContext();
  for (const id of IDS) {
    console.log('\n================ ' + id + ' ================');
    const r = await getText(sc.COMMUNITY + '/sharedfiles/filedetails/?id=' + id, {
      cookie: ctx.cookie,
      proxy: cfg.proxy,
      timeout: 30000,
      noLimit: true,
    });
    const html = r.body || '';
    console.log('bytes', html.length, 'isDetail', /SubscribeItemBtn|workshopItemTitle/.test(html));
    show(html, /workshopItemAuthorName/, 'workshopItemAuthorName');
    show(html, /class="[^"]*friendBlock[^"]*"/, 'friendBlock');
    show(html, /的创意工坊|'s Workshop/, '面包屑');
    show(html, /<div class="ratingSection">[\s\S]{0,400}?<\/div>\s*<\/div>/, 'ratingSection 完整块');
    show(html, /numRatings/, 'numRatings');
    show(html, /详情页里出现的 4-star|not enough|评价数不足|No ratings yet/i, '评分文案', 2);
    show(html, /detailsStatRight/, 'detailsStatRight', 4);
  }
})().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
