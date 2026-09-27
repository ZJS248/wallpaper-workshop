'use strict';
/**
 * 上游行为矩阵探测（为代码修改找依据）：
 *  A. trend 的 days 到底支持哪些值（1/7/30/365）
 *  B. browse 的 numperpage 到底能不能 >30（30/60/100/48/24）
 *  C. myworkshopfiles 的 numperpage 行为（报告中称只有 30 生效）
 *  D. 详情页评分区的几种形态（有评分 / 评价数不足 / 精简页）
 * 用法：node scripts/debug-upstream-matrix.js
 */
const { getText } = require('../server/lib/httpClient');
const sc = require('../server/lib/steamCommunity');
const settings = require('../server/lib/settings');
const session = require('../server/lib/session');

const C = sc.COMMUNITY;
const browse = (qs) => C + '/workshop/browse/?' + qs + '&l=schinese&appid=431960';

async function browseInfo(qs, proxy) {
  const url = browse(qs);
  try {
    const r = await getText(url, { proxy, timeout: 30000, noLimit: true });
    if (r.status !== 200) return { qs, status: r.status };
    const { data } = sc.extractBrowse(sc.collectSsrValues(r.body || ''));
    if (!data) return { qs, status: 200, parsed: false };
    return {
      qs,
      items: (data.results || []).length,
      total: data.total_count,
      totalPages: data.total_pages,
      page: data.current_page,
    };
  } catch (e) {
    return { qs, error: e.message };
  }
}

async function ratingShape(id, proxy, cookie) {
  const url = C + '/sharedfiles/filedetails/?id=' + id;
  try {
    const r = await getText(url, { cookie, proxy, timeout: 30000, noLimit: true });
    const html = r.body || '';
    const section = (html.match(/<div class="ratingSection">([\s\S]{0,400}?)<\/div>\s*<\/div>/) || [])[1] || '';
    const img = (html.match(/fileRatingDetails"><img src="([^"]+)"/) || [])[1] || '';
    const num = (html.match(/<div class="numRatings">([^<]*)<\/div>/) || [])[1] || '';
    return {
      id,
      status: r.status,
      isDetail: /SubscribeItemBtn|workshopItemTitle/.test(html),
      starImg: img.replace(/^.*\//, ''),
      numRatings: num.trim(),
      section: section.replace(/\s+/g, ' ').trim().slice(0, 200),
    };
  } catch (e) {
    return { id, error: e.message };
  }
}

(async function main() {
  const cfg = settings.getConfig();
  const ctx = session.currentContext();
  const proxy = cfg.proxy;
  console.log('proxy =', proxy || '(direct)\n');

  console.log('===== A. trend days =====');
  for (const d of [1, 3, 7, 30, 90, 365]) {
    const r = await browseInfo('browsesort=trend&days=' + d + '&numperpage=30&p=1', proxy);
    console.log('  days=' + String(d).padEnd(4), JSON.stringify(r));
  }

  console.log('\n===== B. browse numperpage =====');
  for (const n of [10, 24, 30, 48, 60, 100]) {
    const r = await browseInfo('browsesort=trend&days=7&numperpage=' + n + '&p=1', proxy);
    console.log('  numperpage=' + String(n).padEnd(4), JSON.stringify(r));
  }
  const noN = await browseInfo('browsesort=trend&days=7&p=1', proxy);
  console.log('  不带 numperpage  ', JSON.stringify(noN));
  const p2 = await browseInfo('browsesort=trend&days=7&numperpage=30&p=2', proxy);
  console.log('  p=2 numperpage=30', JSON.stringify(p2));

  console.log('\n===== C. myworkshopfiles numperpage =====');
  const jwt = sc.parseSteamJwt(ctx.cookie);
  if (jwt.steamId) {
    for (const n of [10, 24, 30, 60]) {
      const url =
        C + '/profiles/' + jwt.steamId + '/myworkshopfiles/?appid=431960&numperpage=' + n + '&p=1&browsefilter=mysubscriptions';
      try {
        const r = await getText(url, { cookie: ctx.cookie, proxy, timeout: 30000, noLimit: true });
        const html = r.body || '';
        const ids = new Set(
          (html.match(/sharedfiles\/filedetails\/\?id=(\d+)/g) || []).map((s) => s.replace(/\D/g, ''))
        );
        const tot = (html.match(/(\d[\d,]*)\s*个?结果|Showing\s+\d+\s*-\s*\d+\s+of\s+([\d,]+)/) || []).join('|');
        console.log('  numperpage=' + String(n).padEnd(4), 'blocks=', ids.size, 'totalHint=', tot || '-');
      } catch (e) {
        console.log('  numperpage=' + String(n).padEnd(4), 'ERR', e.message);
      }
    }
  } else {
    console.log('  (未登录，跳过)');
  }

  console.log('\n===== D. 详情页评分区形态 =====');
  for (const id of ['884307090', '3807151772', '2358176341', '1081733658']) {
    const r = await ratingShape(id, proxy, ctx.cookie);
    console.log('  ' + id, JSON.stringify(r));
  }
})().catch((e) => {
  console.error('失败：', e.stack || e.message);
  process.exit(1);
});
