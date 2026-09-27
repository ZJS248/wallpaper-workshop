'use strict';
/**
 * 调试：验证"系统 DNS 被污染"这一判断。
 * 用 https:// 域名（而不是 IP）走 CONNECT 隧道时，由代理端解析域名，
 * 应该能拿到真正的详情页。
 */
const http = require('http');
const https = require('https');
const tls = require('tls');
const { URL } = require('url');

const PROXY = 'http://127.0.0.1:7890';
const TARGET = 'https://steamcommunity.com/sharedfiles/filedetails/?id=' + (process.argv[2] || '3807151772');

function viaProxyTunnel(urlStr) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const p = new URL(PROXY);
    const req = http.request({
      host: p.hostname,
      port: Number(p.port) || 80,
      method: 'CONNECT',
      path: u.hostname + ':' + (u.port || 443),   // 注意：传域名，不传 IP
      headers: { Host: u.hostname + ':443' },
    });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) return reject(new Error('CONNECT ' + res.statusCode));
      const t = tls.connect({ socket, servername: u.hostname, rejectUnauthorized: false }, () => {
        const r = http.request(
          {
            createConnection: () => t,
            method: 'GET',
            path: u.pathname + u.search,
            headers: { Host: u.hostname, 'User-Agent': 'Mozilla/5.0', Accept: 'text/html' },
          },
          (resp) => {
            const chunks = [];
            resp.on('data', (c) => chunks.push(c));
            resp.on('end', () => resolve({ status: resp.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
          }
        );
        r.on('error', reject);
        r.end();
      });
      t.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  const r = await viaProxyTunnel(TARGET);
  console.log('HTTP', r.status, '长度', r.body.length);
  console.log('workshopItemTitle :', /workshopItemTitle/.test(r.body));
  console.log('SubscribeItemBtn  :', /SubscribeItemBtn/.test(r.body));
  console.log('页面标题          :', (r.body.match(/<title>([^<]*)<\/title>/) || [])[1]);
})().catch((e) => {
  console.error('失败:', e.message);
  process.exit(1);
});
