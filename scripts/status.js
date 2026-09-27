'use strict';
/** 打印当前运行状态摘要（给人看的） */
const http = require('http');

function get(path) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: 9391, path, timeout: 30000 }, (res) => {
        const c = [];
        res.on('data', (d) => c.push(d));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(c).toString('utf8')));
          } catch (e) {
            reject(new Error('非 JSON'));
          }
        });
      })
      .on('error', reject);
  });
}

(async () => {
  const raw = await get('/api/status');
  const d = raw.data || raw;
  const dns = d.dns;
  console.log('应用      : ' + ((d.app && d.app.name) || '-') + '  (appid ' + d.appId + ')');
  console.log('版本/运行 : v' + d.version + '  ' + Math.round(d.uptimeMs / 1000) + 's  Node ' + d.node);
  console.log('代理      : ' + (d.proxy || '直连') + '   来源=' + d.proxySource);
  console.log(
    'DNS       : ' +
      (dns ? (dns.poisoned ? '检测到污染 → 已用 DoH 绕过' : '正常') : '诊断中') +
      (dns && dns.doh && dns.doh.length ? '   DoH=' + dns.doh.join(',') : '')
  );
  console.log(
    '登录态    : ' +
      (d.session.hasCookie
        ? d.session.cookieLength + ' 字节，来源 ' + d.session.sourceLabel + '，SteamID ' + (d.session.steamId || '-')
        : '未登录（浏览不受影响）')
  );
  console.log('父项目    : ' + (d.parentDetected ? d.parentDir : '未探测到') + '   父后端 ' + (d.parentApiBase || '-'));
  console.log(
    '图片缓存  : ' +
      d.imageCache.items +
      ' 项 / ' +
      Math.round(d.imageCache.bytes / 1048576) +
      ' MB   命中 ' +
      d.imageCache.hits +
      ' 次 / 未命中 ' +
      d.imageCache.misses +
      ' 次   失败 ' +
      d.imageCache.errors
  );
  console.log('限流间隔  : ' + d.rateLimit.minGapMs + 'ms（同一 host 串行）');
})().catch((e) => {
  console.error('读取状态失败：' + e.message);
  process.exit(1);
});
