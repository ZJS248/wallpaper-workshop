'use strict';
/** 测单次浏览请求的真实墙钟耗时，用来估算"OR 合并"的代价 */
const settings = require('../server/lib/settings');
const sc = require('../server/lib/steamCommunity');

(async () => {
  const cfg = settings.loadSettings();
  const url = 'https://steamcommunity.com/workshop/browse/?appid=431960&numperpage=30&p=1&browsesort=trend&days=7';
  const times = [];
  for (let i = 0; i < 4; i++) {
    const t0 = Date.now();
    const r = await sc.fetchBrowse({ url, cookie: cfg.cookie, proxy: cfg.proxy });
    const dt = Date.now() - t0;
    times.push(dt);
    console.log('第 ' + (i + 1) + ' 次：' + dt + 'ms  ok=' + r.ok + ' 条数=' + r.items.length);
  }
  const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
  console.log('\n平均 ' + avg + 'ms/请求');
  console.log('串行 3 个 OR 值 ≈ ' + avg * 3 + 'ms');
  console.log('串行 6 个 OR 值 ≈ ' + avg * 6 + 'ms');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
