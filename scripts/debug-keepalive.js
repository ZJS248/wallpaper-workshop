'use strict';
/**
 * 测"复用同一条 CONNECT 隧道"能省多少时间。
 * 现在的实现每个请求都重新 CONNECT + TLS 握手（约 0.5~1s 的固定开销），
 * 如果复用好，串行合并的总耗时会明显下降。
 */
const http = require('http');
const https = require('https');
const tls = require('tls');
const { URL } = require('url');
const settings = require('../server/lib/settings');

const PROXY = settings.loadSettings().proxy;
const HOST = 'steamcommunity.com';
const PATH_ = '/workshop/browse/?appid=431960&numperpage=30&p=1&browsesort=trend&days=7';

function connectTunnel() {
  return new Promise((resolve, reject) => {
    const p = new URL(PROXY);
    const req = http.request({
      host: p.hostname,
      port: Number(p.port) || 80,
      method: 'CONNECT',
      path: HOST + ':443',
      headers: { Host: HOST + ':443' },
    });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) return reject(new Error('CONNECT ' + res.statusCode));
      const t = tls.connect({ socket, servername: HOST, rejectUnauthorized: false }, () => resolve(t));
      t.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

function requestOn(socket, agent) {
  return new Promise((resolve, reject) => {
    const opts = {
      method: 'GET',
      path: PATH_,
      headers: { Host: HOST, 'User-Agent': 'Mozilla/5.0', Accept: 'text/html', Connection: 'keep-alive' },
      timeout: 30000,
    };
    if (socket) opts.createConnection = () => socket;
    if (agent) opts.agent = agent;
    const req = https.request = require('http').request; // 隧道路径：明文 HTTP over TLS socket
    const r = (socket ? require('http') : https).request(opts, (res) => {
      const c = [];
      res.on('data', (d) => c.push(d));
      res.on('end', () => resolve({ status: res.statusCode, len: Buffer.concat(c).length }));
    });
    r.on('error', reject);
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.end();
  });
}

(async () => {
  console.log('=== A) 每次新建隧道（当前实现）===');
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now();
    const sock = await connectTunnel();
    await requestOn(sock);
    sock.destroy();
    console.log('  第 ' + (i + 1) + ' 次：' + (Date.now() - t0) + 'ms（含握手）');
  }

  console.log('\n=== B) 复用同一条隧道 ===');
  const sock = await connectTunnel();
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now();
    await requestOn(sock);
    console.log('  第 ' + (i + 1) + ' 次：' + (Date.now() - t0) + 'ms');
  }
  sock.destroy();
})().catch((e) => {
  console.error('失败：' + e.message);
  process.exit(1);
});
