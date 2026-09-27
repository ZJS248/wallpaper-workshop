'use strict';
/**
 * DNS 解析工具。
 *
 * 为什么需要这个文件：本机对 `steamcommunity.com` 的**系统 DNS 是被污染的**。
 * 实测 `Resolve-DnsName steamcommunity.com` 会返回 `65.49.68.152`（与 Steam 无关）
 * 以及 `192.5.6.30`（本该返回 NXDOMAIN 时却返回了根域名服务器地址，典型的 DNS 劫持特征）。
 *
 * 后果：不配置代理直连时，Node 会把请求发到错误的主机，
 * 表现是"HTTP 200，但内容完全对不上"这种最难查的故障。
 *
 * 处理分两层：
 *  1. **走代理时**：CONNECT 里传域名，让代理端解析 —— 天然绕开本机污染（首选）。
 *  2. **直连时**：这里实现的 DNS-over-HTTPS 解析，绕开本机 DNS。
 * 缓存 10 分钟，失败自动回退系统 DNS，不会把整个应用卡死。
 */

const https = require('https');
const dns = require('dns');
const { URL } = require('url');

const DOH_ENDPOINTS = [
  'https://223.5.5.5/resolve',       // AliDNS（国内可达，返回标准 JSON）
  'https://1.1.1.1/dns-query',       // Cloudflare
  'https://dns.google/resolve',      // Google
];

const CACHE = new Map();
const TTL_MS = 10 * 60 * 1000;
const DOH_TIMEOUT = 6000;

function cacheGet(host) {
  const hit = CACHE.get(host);
  if (!hit) return null;
  if (Date.now() - hit.at > TTL_MS) {
    CACHE.delete(host);
    return null;
  }
  return hit.addresses;
}

function cacheSet(host, addresses) {
  CACHE.set(host, { at: Date.now(), addresses });
}

/** 请求单个 DoH 端点，返回 A/AAAA 地址数组 */
function dohQuery(endpoint, host, proxy) {
  return new Promise((resolve) => {
    let mod = https;
    let req;
    const url = endpoint + '?name=' + encodeURIComponent(host) + '&type=A';

    const onBody = (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          const json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const addrs = (json.Answer || [])
            .filter((a) => a.type === 1 || a.type === 28)
            .map((a) => a.data)
            .filter(Boolean);
          resolve(addrs);
        } catch (e) {
          resolve([]);
        }
      });
      res.on('error', () => resolve([]));
    };

    // DoH 端点本身是 IP，直连即可；但网络受限时也允许过代理
    if (proxy) {
      const http = require('http');
      const tls = require('tls');
      const p = new URL(proxy);
      const u = new URL(url);
      const creq = http.request({
        host: p.hostname,
        port: Number(p.port) || 80,
        method: 'CONNECT',
        path: u.hostname + ':443',
        headers: { Host: u.hostname + ':443' },
        timeout: DOH_TIMEOUT,
      });
      creq.on('connect', (res, socket) => {
        if (res.statusCode !== 200) {
          socket.destroy();
          return resolve([]);
        }
        const t = tls.connect({ socket, servername: u.hostname, rejectUnauthorized: false }, () => {          const r = https.request(
            {
              createConnection: () => t,
              method: 'GET',
              path: u.pathname + u.search,
              headers: { Host: u.hostname, Accept: 'application/dns-json' },
              timeout: DOH_TIMEOUT,
            },
            onBody
          );
          r.on('error', () => resolve([]));
          r.on('timeout', () => r.destroy());
          r.end();
        });
        t.on('error', () => resolve([]));
      });
      creq.on('error', () => resolve([]));
      creq.on('timeout', () => creq.destroy());
      creq.end();
      return;
    }

    req = https.request(
      url,
      {
        method: 'GET',
        headers: {
          Host: new URL(url).hostname,
          Accept: 'application/dns-json',
          'User-Agent': 'wallpaper-workshop/1.0',
        },
        timeout: DOH_TIMEOUT,
        rejectUnauthorized: false,
        // DoH 端点用的是 IP（223.5.5.5 等）。给 IP 设 servername 会触发
        // DEP0123（RFC 6066 不允许），所以这里显式留空。
        servername: /^\d+\.\d+\.\d+\.\d+$/.test(new URL(url).hostname) ? '' : undefined,
      },
      onBody
    );
    req.on('error', () => resolve([]));
    req.on('timeout', () => {
      req.destroy();
      resolve([]);
    });
    req.end();
  });
}

/** 依次尝试所有 DoH 端点 */
async function resolveViaDoh(host, proxy) {
  const cached = cacheGet(host);
  if (cached) return cached;
  for (const ep of DOH_ENDPOINTS) {
    const addrs = await dohQuery(ep, host, proxy);
    if (addrs.length) {
      cacheSet(host, addrs);
      return addrs;
    }
  }
  return [];
}

/** 系统 DNS 兜底 */
function resolveSystem(host) {
  return new Promise((resolve) => {
    dns.lookup(host, { all: true }, (err, records) => {
      if (err || !records || !records.length) return resolve([]);
      resolve(records.map((r) => r.address));
    });
  });
}

let dohStats = { dohHits: 0, systemFallbacks: 0, lastHost: '', lastAddresses: [], lastSource: '' };

/**
 * 解析主机名。优先 DoH，失败回退系统 DNS。
 * @returns {Promise<string[]>}
 */
async function resolveHost(host, proxy) {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return [host];
  const addrs = await resolveViaDoh(host, proxy);
  if (addrs.length) {
    dohStats.dohHits++;
    dohStats.lastHost = host;
    dohStats.lastAddresses = addrs;
    dohStats.lastSource = 'doh';
    return addrs;
  }
  const sys = await resolveSystem(host);
  dohStats.systemFallbacks++;
  dohStats.lastHost = host;
  dohStats.lastAddresses = sys;
  dohStats.lastSource = 'system(可能被污染)';
  return sys;
}

/**
 * 给 http/https 的 request options 生成一个 lookup 函数，
 * 顺序试遍 DoH 解析出来的地址（第一个不通就试下一个）。
 */
function makeLookup(host, proxy) {
  return (hostname, options, callback) => {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    resolveHost(hostname, proxy)
      .then((addrs) => {
        if (!addrs.length) {
          return callback(new Error('DoH 与系统 DNS 都无法解析 ' + hostname));
        }
        const wantV6 = options && options.family === 6;
        const filtered = addrs.filter((a) => (wantV6 ? a.includes(':') : !a.includes(':')));
        const list = filtered.length ? filtered : addrs;
        if (options && options.all) return callback(null, list.map((a) => ({ address: a, family: a.includes(':') ? 6 : 4 })));
        callback(null, list[0], list[0].includes(':') ? 6 : 4);
      })
      .catch((e) => callback(e));
  };
}

/** 探测：给 /api/status 用，让用户能看到本机 DNS 是否被污染 */
async function diagnose(host, proxy) {
  const system = await resolveSystem(host);
  const doh = await resolveViaDoh(host, proxy);
  const same = system.length && doh.length && system[0] === doh[0];
  return {
    host,
    system,
    doh,
    match: !!same,
    poisoned: !!(doh.length && system.length && !system.some((s) => doh.includes(s))),
  };
}

function stats() {
  return Object.assign({}, dohStats);
}

module.exports = { resolveHost, makeLookup, diagnose, stats, DOH_ENDPOINTS };
