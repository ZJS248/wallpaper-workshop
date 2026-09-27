'use strict';
/**
 * 打本地接口看现状（排查用）。
 * 用法：node scripts/probe-api.js item 884307090
 *       node scripts/probe-api.js browse
 *       node scripts/probe-api.js filters
 */
const BASE = process.env.WW_BASE || 'http://127.0.0.1:9391';

async function get(path) {
  const r = await fetch(BASE + path);
  const t = await r.text();
  try {
    return JSON.parse(t);
  } catch (e) {
    return { raw: t.slice(0, 500) };
  }
}

(async function main() {
  const what = process.argv[2] || 'item';
  if (what === 'item') {
    const j = await get('/api/item?id=' + (process.argv[3] || '884307090'));
    const d = j.data || j;
    console.log('ok            =', d.ok);
    console.log('pageOk        =', d.pageOk, ' reason =', d.pageReason);
    console.log('author        =', JSON.stringify(d.author));
    console.log('item.creatorName  =', d.item && d.item.creatorName);
    console.log('item.creatorAvatar=', d.item && d.item.creatorAvatar);
    console.log('item.starRating   =', d.item && d.item.starRating, ' totalVotes =', d.item && d.item.totalVotes);
    console.log('ratingText    =', JSON.stringify(d.ratingText));
    console.log('stats         =', JSON.stringify(d.stats));
    console.log('detailStats   =', JSON.stringify(d.detailStats));
    console.log('related.total =', d.related && d.related.totalCount, ' items =', d.related && (d.related.items || []).length);
  } else if (what === 'browse') {
    const qs = process.argv.slice(3).join('&') || 'sort=trend&days=7&page=1&pageSize=30';
    const j = await get('/api/browse?' + qs);
    const d = j.data || j;
    console.log('ok=', d.ok, ' items=', (d.items || []).length, ' total=', d.totalCount, ' totalPages=', d.totalPages, ' page=', d.page, ' pageSize=', d.pageSize);
    console.log('totalCountApprox=', d.totalCountApprox, ' merged=', d.merged, ' mergeRequests=', d.mergeRequests, ' elapsedMs=', d.elapsedMs);
    console.log('url=', d.url);
    console.log('first5=', (d.items || []).slice(0, 5).map((i) => i.id + '(' + i.resolution + ',' + i.starRating + '/' + i.totalVotes + ')').join(' '));
  } else if (what === 'filters') {
    const j = await get('/api/filters');
    const d = j.data || j;
    console.log('sorts=', JSON.stringify(d.sorts));
    console.log('daysOptions=', JSON.stringify(d.daysOptions));
    console.log('groups=', (d.groups || []).map((g) => g.key + ':' + g.tags.length).join(', '));
  } else if (what === 'status') {
    const j = await get('/api/status');
    const d = j.data || j;
    console.log(JSON.stringify(d, null, 1).slice(0, 1800));
  } else if (what === 'raw') {
    const j = await get('/api/' + process.argv.slice(3).join('/'));
    console.log(JSON.stringify(j, null, 1).slice(0, 3000));
  }
})().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
