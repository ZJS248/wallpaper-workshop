'use strict';
/**
 * 深挖两件事：
 *  1) trend 的 days 到底有没有影响结果（比较 id 列表 + 看 SSR 回显的 serverQuery.trend_days）
 *  2) 低评分作品的 star 图片文件名形态（找 numRatings 很小 / star 非 5 的样本）
 *  3) 3807151772 详情页重试（BUG-13 是否稳定复现）
 * 用法：node scripts/debug-days-effect.js
 */
const { getText } = require('../server/lib/httpClient');
const sc = require('../server/lib/steamCommunity');
const settings = require('../server/lib/settings');
const session = require('../server/lib/session');

const C = sc.COMMUNITY;

async function trendIds(days, proxy) {
  const url = C + '/workshop/browse/?appid=431960&p=1&numperpage=30&l=schinese&browsesort=trend&days=' + days;
  const r = await getText(url, { proxy, timeout: 30000, noLimit: true });
  const ssr = sc.collectSsrValues(r.body || '');
  const { data, serverQuery } = sc.extractBrowse(ssr);
  const ids = data ? (data.results || []).map((x) => x.publishedfileid) : [];
  return { days, url, ids, serverQuery, ratings: data ? (data.results || []).map((x) => x.star_rating + '/' + x.total_votes) : [] };
}

/** 通过 top-rated 反向找低分作品：用 browsesort=toprated 的最后几页不如直接搜 numratings 少的 */
async function ratingShape(id, proxy, cookie) {
  const r = await getText(C + '/sharedfiles/filedetails/?id=' + id, { cookie, proxy, timeout: 30000, noLimit: true });
  const html = r.body || '';
  const img = (html.match(/fileRatingDetails"><img src="([^"]+)"/) || [])[1] || '';
  const num = (html.match(/<div class="numRatings">([^<]*)<\/div>/) || [])[1] || '';
  const isDetail = /SubscribeItemBtn|workshopItemTitle/.test(html);
  const txt = (html.match(/<div class="ratingSection">([\s\S]{0,500}?)<\/div>\s*<\/div>\s*<\/div>/) || [])[1] || '';
  return { id, isDetail, star: img.replace(/^.*\//, ''), num: num.trim(), txt: txt.replace(/\s+/g, ' ').slice(0, 160) };
}

(async function main() {
  const cfg = settings.getConfig();
  const ctx = session.currentContext();
  const proxy = cfg.proxy;
  console.log('proxy =', proxy || '(direct)\n');

  console.log('===== 1. days 对结果的影响 =====');
  const a = await trendIds(1, proxy);
  const b = await trendIds(365, proxy);
  const c = await trendIds(7, proxy);
  const setA = new Set(a.ids);
  const setB = new Set(b.ids);
  const inter = a.ids.filter((x) => setB.has(x));
  console.log('days=1   前 6 个 id:', a.ids.slice(0, 6).join(','));
  console.log('days=7   前 6 个 id:', c.ids.slice(0, 6).join(','));
  console.log('days=365 前 6 个 id:', b.ids.slice(0, 6).join(','));
  console.log('days=1 与 days=365 交集:', inter.length, '/ 30');
  console.log('days=1  serverQuery:', JSON.stringify(a.serverQuery));
  console.log('days=365 serverQuery:', JSON.stringify(b.serverQuery));
  console.log('days=1   评分样本:', a.ratings.slice(0, 8).join('  '));

  console.log('\n===== 2. 低评分样本（从最老/订阅最少的分页里捞） =====');
  const probe = [
    'https://steamcommunity.com/workshop/browse/?appid=431960&browsesort=mostrecent&p=1000&numperpage=30&l=schinese',
  ];
  for (const u of probe) {
    const r = await getText(u, { proxy, timeout: 30000, noLimit: true });
    const { data } = sc.extractBrowse(sc.collectSsrValues(r.body || ''));
    const list = data ? data.results || [] : [];
    const low = list.filter((x) => Number(x.star_rating) > 0 && Number(x.star_rating) < 4).slice(0, 3);
    const zero = list.filter((x) => !x.star_rating).slice(0, 3);
    console.log('  本页', list.length, '条；低分(<4且>0)', low.length, '；无评分', zero.length);
    console.log('  低分样本:', low.map((x) => x.publishedfileid + '=' + x.star_rating + '/' + x.total_votes).join(' '));
    console.log('  无评分样本:', zero.map((x) => x.publishedfileid).join(' '));
    for (const x of low.slice(0, 2)) {
      const s = await ratingShape(x.publishedfileid, proxy, ctx.cookie);
      console.log('   →', JSON.stringify(s));
    }
    for (const x of zero.slice(0, 2)) {
      const s = await ratingShape(x.publishedfileid, proxy, ctx.cookie);
      console.log('   →', JSON.stringify(s));
    }
  }

  console.log('\n===== 3. 3807151772 详情页重试 3 次 =====');
  for (let i = 0; i < 3; i++) {
    const s = await ratingShape('3807151772', proxy, ctx.cookie);
    console.log('  第' + (i + 1) + '次', JSON.stringify(s));
  }
})().catch((e) => {
  console.error('失败：', e.stack || e.message);
  process.exit(1);
});
