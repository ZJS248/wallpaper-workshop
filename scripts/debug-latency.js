'use strict';
/**
 * 拆分请求的耗时到底花在哪：TLS/代理握手 vs 页面传输。
 * 直接走 httpClient（带隧道），统计每个阶段。
 */
const settings = require('../server/lib/settings');
const httpClient = require('../server/lib/httpClient');

const cfg = settings.loadSettings();
const URLS = [
  'https://steamcommunity.com/workshop/browse/?appid=431960&numperpage=30&p=1&browsesort=trend&days=7&requiredtags%5B%5D=3840+x+2160',
  'https://steamcommunity.com/workshop/browse/?appid=431960&numperpage=30&p=1&browsesort=trend&days=7&requiredtags%5B%5D=2560+x+1440',
  'https://steamcommunity.com/workshop/browse/?appid=431960&numperpage=30&p=1&browsesort=trend&days=7&requiredtags%5B%5D=1920+x+1080',
  'https://steamcommunity.com/workshop/browse/?appid=431960&numperpage=30&p=1&browsesort=trend&days=7&requiredtags%5B%5D=1366+x+768',
];

(async () => {
  console.log('=== 串行 4 个（每个都新建隧道）===');
  let t0 = Date.now();
  for (const u of URLS) {
    const t = Date.now();
    const r = await httpClient.getText(u, { proxy: cfg.proxy, timeout: 30000 });
    console.log('  ' + (Date.now() - t) + 'ms  ' + Math.round((r.buffer || Buffer.alloc(0)).length / 1024) + 'KB  HTTP ' + r.status);
  }
  console.log('  合计 ' + (Date.now() - t0) + 'ms');

  console.log('\n=== 并发 4 个（noLimit）===');
  t0 = Date.now();
  const rs = await Promise.all(
    URLS.map((u) => httpClient.getText(u, { proxy: cfg.proxy, timeout: 40000, noLimit: true }))
  );
  console.log('  合计 ' + (Date.now() - t0) + 'ms  （各 ' + rs.map((r) => Math.round((r.buffer || Buffer.alloc(0)).length / 1024) + 'KB').join(' / ') + '）');

  console.log('\n=== 并发 8 个（noLimit）===');
  t0 = Date.now();
  const many = [];
  for (let i = 0; i < 2; i++) URLS.forEach((u) => many.push(u + '&p=' + (i + 1)));
  await Promise.all(many.map((u) => httpClient.getText(u, { proxy: cfg.proxy, timeout: 40000, noLimit: true })));
  console.log('  合计 ' + (Date.now() - t0) + 'ms');

  console.log('\n=== 同一页面连打 3 次（看是否被 CDN/代理缓存加速）===');
  for (let i = 0; i < 3; i++) {
    const t = Date.now();
    const r = await httpClient.getText(URLS[0], { proxy: cfg.proxy, timeout: 30000, noLimit: true });
    console.log('  ' + (Date.now() - t) + 'ms  ' + Math.round((r.buffer || Buffer.alloc(0)).length / 1024) + 'KB');
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
