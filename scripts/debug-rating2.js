'use strict';
/**
 * 排查 BUG-03：评分数据到底藏在哪。
 *  1) 详情页 HTML 里跟 rating / vote 有关的片段
 *  2) 浏览页 SSR 里单个结果的字段清单（有没有 rating 字段）
 * 用法：node scripts/debug-rating2.js [id]
 */
const { getText } = require('../server/lib/httpClient');
const sc = require('../server/lib/steamCommunity');
const settings = require('../server/lib/settings');
const session = require('../server/lib/session');

const ID = process.argv[2] || '884307090';

function snippets(html, re, label, before, after, max) {
  console.log('\n===== ' + label + ' =====');
  let m;
  let n = 0;
  const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  while ((m = r.exec(html)) && n < (max || 6)) {
    n++;
    const s = Math.max(0, m.index - (before || 120));
    const e = Math.min(html.length, m.index + m[0].length + (after || 220));
    console.log('--- @' + m.index + ' ---');
    console.log(html.slice(s, e).replace(/\s+/g, ' '));
  }
  if (!n) console.log('(无命中)');
}

(async function main() {
  const cfg = settings.getConfig();
  const ctx = session.currentContext();
  console.log('proxy =', cfg.proxy || '(direct)', ' id =', ID);

  const url = sc.COMMUNITY + '/sharedfiles/filedetails/?id=' + ID;
  const res = await getText(url, { cookie: ctx.cookie, proxy: ctx.proxy, timeout: 30000 });
  const html = res.body || '';
  console.log('详情页 HTTP', res.status, 'bytes', html.length);

  snippets(html, /ratingSection/i, 'ratingSection');
  snippets(html, /class="[^"]*rating[^"]*"/i, 'class=*rating*');
  snippets(html, /numRatings|num_ratings|totalVotes|total_votes|star_rating/i, 'numRatings/totalVotes');
  snippets(html, /RateUp|RateDown|rateup|ratedown/i, 'RateUp/RateDown');
  snippets(html, /favoriteCount|FavoriteCount/i, 'favoriteCount');
  console.log('\n===== 统计表原文 =====');
  const stats = html.match(/<table[^>]*class="[^"]*stats_table[^"]*"[\s\S]{0,1200}?<\/table>/i);
  console.log(stats ? stats[0].replace(/\s+/g, ' ').slice(0, 1200) : '(没有 stats_table)');
  console.log('\n===== 评分相关 div 块 =====');
  const blocks = html.match(/<div[^>]*class="[^"]*(?:rating|Rating)[^"]*"[\s\S]{0,600}?<\/div>/g) || [];
  blocks.slice(0, 5).forEach((b) => console.log('--- ' + b.replace(/\s+/g, ' ').slice(0, 500)));

  // ---- 浏览页 SSR 里单条结果的字段 ----
  console.log('\n\n===== 浏览页 SSR 单条结果字段 =====');
  const burl =
    sc.COMMUNITY + '/workshop/browse/?appid=431960&p=1&numperpage=30&l=schinese&browsesort=trend&days=7';
  const bres = await getText(burl, { proxy: cfg.proxy, timeout: 30000, noLimit: true });
  const ssr = sc.collectSsrValues(bres.body || '');
  const { data } = sc.extractBrowse(ssr);
  if (data && data.results && data.results[0]) {
    console.log('单条结果字段：', Object.keys(data.results[0]).join(', '));
    console.log('\n分值相关字段值：');
    Object.keys(data.results[0])
      .filter((k) => /vote|rating|score|star|comment|favorite/i.test(k))
      .forEach((k) => console.log('   ', k, '=', JSON.stringify(data.results[0][k])));
    console.log('\n样本 raw：');
    console.log(JSON.stringify(data.results[0], null, 1).slice(0, 2500));
  } else {
    console.log('浏览页没解出结果');
  }
})().catch((e) => {
  console.error('失败：', e.stack || e.message);
  process.exit(1);
});
