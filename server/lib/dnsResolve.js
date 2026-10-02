'use strict';
/**
 * DNS 解析工具。
 *
 * 为什么需要这个文件：本机对 `steamcommunity.com` 的**系统 DNS 是被污染的**。
 * 实测 `Resolve-DnsName steamcommunity.com` 返回 `157.240.16.50`（Facebook 的地址段）
 * 以及 `192.5.6.30`（本该返回 NXDOMAIN 时却返回了根域名服务器地址，典型的劫持特征）。
 *
 * 后果：不配置代理直连时，Node 会把请求发到错误的主机，
 * 表现是"HTTP 200，但内容完全对不上"这种最难查的故障。
 *
 * ────────────────────────────────────────────────────────────────────
 * ⚠️ 2026-10-02 追加：**DoH 并没有自动解决问题，旧实现本身有 bug**。
 *
 * 旧代码把 AliDNS 排在端点列表第一位，并且"拿到第一个非空结果就采用"。
 * 实测（本机，2026-10-02）：
 *     AliDNS 直连        → 67.228.235.93   ← SoftLayer 段，与 Steam 无关，**污染**
 *     Cloudflare 直连    → 无响应（被墙）
 *     Cloudflare 经代理  → 23.45.136.230   ← Akamai，真实
 *     Google     经代理  → 23.37.16.240    ← Akamai，真实
 * 也就是说 AliDNS 对这类域名同样返回被污染的答案，而它"有结果"，
 * 于是 Cloudflare / Google 永远不会被尝试，污染地址被缓存下来拿去建连 ——
 * 用户侧表现就是"请求一直挂着、不报错、也不出图"。
 * （顺带：某次实测 DoH 给出 `104.244.43.35`，那是 X/Twitter 的地址段，同样是污染。）
 *
 * 现在的策略是三件事：
 *   1. **并发问所有 DoH 端点**，不再依赖端点顺序；
 *   2. **逐条过滤已知污染地址段**（POISON_CIDRS）与非法地址（BOGUS_CIDRS），
 *      污染答案直接丢弃，绝不缓存、绝不拿去连接；
 *   3. **优先信任"经代理问到"的答案** —— 查询本身走隧道出了墙，结果可信；
 *      直连问到的只作兜底（非墙内网络下直连 Cloudflare 依然是好答案）。
 *
 * 如果所有来源都给不出干净答案，就**明确报错**而不是硬连。
 * "连到错误主机却 HTTP 200" 是最难排查的一类故障，宁可失败得清清楚楚。
 *
 * 处理分两层：
 *  1. **走代理时**：CONNECT 里传域名，让代理端解析 —— 天然绕开本机污染（首选）。
 *  2. **直连时**：这里实现的 DNS-over-HTTPS 解析 + 污染过滤，绕开本机 DNS。
 * 缓存 10 分钟；失败**不**回退到被污染的系统 DNS（回退等于把错误答案当正确答案）。
 */

const https = require('https');
const dns = require('dns');
const tls = require('tls');
const { URL } = require('url');

/**
 * DoH 端点。
 *
 * ⚠️ 两个关键点：
 *
 * 1. 这里的**顺序不再代表优先级**（旧实现按顺序取第一个非空结果，那正是 bug 来源）。
 *    现在是全部并发问一遍再挑。
 *
 * 2. **`trusted` 描述的是"解析器自己在哪"，不是"我们怎么连到它"** —— 这点踩过坑：
 *    一开始按"查询是否经代理"划分可信度，以为走了隧道就安全。实测不成立：
 *        AliDNS 经代理 → 103.246.246.144   ← 仍是错的
 *        Cloudflare 经代理 → 23.37.16.240  ← 对
 *        Google 经代理 → 23.37.16.240      ← 对
 *    原因是**污染发生在 AliDNS 自己的递归解析器内部**（它在墙内去问权威服务器时被污染），
 *    而不是发生在我们到 AliDNS 的那段链路上。把查询走代理并不能修好它。
 *    所以判据只能是"解析器本身是否在墙外"：
 *      - Cloudflare / Google：墙外递归，答案可信 → trusted
 *      - AliDNS：墙内递归，对被墙域名会返回污染答案 → 仅作兜底
 *    这样"非墙内网络的用户"依然能正常用（直连 Cloudflare/Google 即可），
 *    而"墙内且没配代理"的用户会拿到明确的报错，而不是被悄悄导向错误主机。
 */
const DOH_ENDPOINTS = [
  { name: 'Cloudflare', url: 'https://1.1.1.1/dns-query', trusted: true },
  { name: 'Google', url: 'https://dns.google/resolve', trusted: true },
  // 墙内递归解析器：对非墙内域名是好用的兜底，对被墙域名不可信
  { name: 'AliDNS', url: 'https://223.5.5.5/resolve', trusted: false },
];

/**
 * 已知的"污染落点"地址段 —— 出现在这里说明答案是被劫持的，直接丢弃。
 *
 * ⚠️ 定位：这是一层**廉价的预过滤**，不是正确性的保证。
 * 原因：污染答案每次都在换。同一台机器上实测到的被污染返回值就有
 * `157.240.16.50` / `66.220.146.94`（Facebook）、`202.160.128.40`（Yahoo）、
 * `67.228.235.93` / `208.101.21.43`（SoftLayer）、`103.246.246.144`……
 * 段位各不相同，靠枚举 IP 段永远追不上。
 * 真正的判据是「解析器在不在墙外」（见 DOH_ENDPOINTS）与
 * 「该 IP 是否真的持有该域名的证书」（见 verifyHost）。
 * 这里提前挡掉已知的，只是为了少做几次无意义的证书探测。
 *
 * 这份表只用于**丢弃**答案，不会用来"猜"正确 IP。
 */
const POISON_CIDRS = [
  // Meta / Facebook（实测系统 DNS 回过 157.240.16.50、66.220.146.94 与一段 IPv6）
  '157.240.0.0/16',
  '66.220.0.0/16',
  '31.13.0.0/16',
  '179.60.192.0/22',
  '185.60.216.0/22',
  '2a03:2880::/32',
  // X / Twitter
  '104.244.42.0/24',
  '104.244.43.0/24',
  // Yahoo（实测 AliDNS 回过 202.160.128.40）
  '202.160.128.0/18',
  // SoftLayer / IBM —— 长期被当作污染落点
  // （实测：AliDNS 回过 67.228.235.93，系统 DNS 回过 208.101.21.43）
  '67.228.0.0/16',
  '208.101.0.0/16',
  // 根域名服务器地址（劫持签名）
  '192.5.6.30/32',
  // 历年观察到的污染落点
  '8.7.198.0/24',
  '46.82.174.0/24',
  '78.16.49.0/24',
  '93.46.8.0/24',
  '65.49.68.0/24',
  '37.61.54.0/24',
  '59.24.3.0/24',
  '203.98.7.0/24',
  '4.36.66.0/24',
  '159.106.121.0/24',
];

/**
 * 对**公网域名**来说不可能合法的地址。
 * 解析公网域名却拿到这些，同样是劫持/中间盒的特征（例如返回 0.0.0.0 或内网地址）。
 */
const BOGUS_CIDRS = [
  '0.0.0.0/8',
  '127.0.0.0/8',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '169.254.0.0/16',
  '224.0.0.0/4',
  '240.0.0.0/4',
  '::/128',
  '::1/128',
  'fc00::/7',
  'fe80::/10',
  // Teredo 隧道前缀（实测系统 DNS 对被污染域名回过 2001::a88f:abba 这种）
  '2001::/32',
];

/* ----------------------------- IP / CIDR 工具 ----------------------------- */

function ipv4ToInt(ip) {
  const parts = String(ip).split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const s of parts) {
    if (!/^\d{1,3}$/.test(s)) return null;
    const v = Number(s);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

/** IPv6 → BigInt（支持 `::` 压缩与 `::ffff:1.2.3.4` 形式） */
function ipv6ToBigInt(ip) {
  let s = String(ip);
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);

  const halves = s.split('::');
  if (halves.length > 2) return null;

  const expand = (arr) => {
    const out = [];
    for (const seg of arr) {
      if (seg === '') return null;
      if (seg.includes('.')) {
        const v4 = ipv4ToInt(seg);
        if (v4 === null) return null;
        out.push((v4 >>> 16) & 0xffff, v4 & 0xffff);
      } else {
        if (!/^[0-9a-fA-F]{1,4}$/.test(seg)) return null;
        out.push(parseInt(seg, 16));
      }
    }
    return out;
  };

  const head = expand(halves[0] ? halves[0].split(':') : []);
  const tail = halves.length === 2 ? expand(halves[1] ? halves[1].split(':') : []) : [];
  if (!head || !tail) return null;

  let groups;
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    groups = head.concat(new Array(fill).fill(0), tail);
  } else {
    if (head.length !== 8) return null;
    groups = head;
  }

  let n = 0n;
  for (const g of groups) n = (n << 16n) | BigInt(g);
  return n;
}

/** ip 是否落在 cidr 内 */
function matchCidr(ip, cidr) {
  const slash = String(cidr).indexOf('/');
  if (slash < 0) return false;
  const net = cidr.slice(0, slash);
  const bits = Number(cidr.slice(slash + 1));
  if (!Number.isFinite(bits)) return false;

  if (String(ip).includes(':') || net.includes(':')) {
    const a = ipv6ToBigInt(ip);
    const b = ipv6ToBigInt(net);
    if (a === null || b === null) return false;
    if (bits <= 0) return true;
    if (bits > 128) return false;
    const shift = BigInt(128 - bits);
    return a >> shift === b >> shift;
  }

  const a = ipv4ToInt(ip);
  const b = ipv4ToInt(net);
  if (a === null || b === null) return false;
  if (bits <= 0) return true;
  if (bits > 32) return false;
  const mask = bits === 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0;
  return ((a & mask) >>> 0) === ((b & mask) >>> 0);
}

/** 这个地址是不是"已知污染落点"或"对公网域名不可能合法" */
function isPoisoned(ip) {
  const s = String(ip || '');
  if (!s) return true;
  if (!/^[0-9a-fA-F:.]+$/.test(s)) return true;
  for (const c of POISON_CIDRS) if (matchCidr(s, c)) return true;
  for (const c of BOGUS_CIDRS) if (matchCidr(s, c)) return true;
  return false;
}

/** 过滤掉污染地址（保留原顺序、去重） */
function filterClean(addrs) {
  const out = [];
  for (const a of addrs || []) {
    if (isPoisoned(a)) continue;
    if (!out.includes(a)) out.push(a);
  }
  return out;
}

/* -------------------------------- 缓存 -------------------------------- */

const CACHE = new Map();
const TTL_MS = 10 * 60 * 1000;
const DOH_TIMEOUT = 4000;

/**
 * "整条解析链都失败"的短缓存。
 *
 * 为什么需要：失败路径要等 DoH 超时 + 证书探测，一次 5~7 秒。
 * 没有这个缓存的话，配置错误的状态下**每个请求都要重新等一遍**，
 * 前端表现就是"一直在转圈"——正是要修的那个观感。
 * 缓存 60 秒即可：够挡住连续请求，又不至于在网络恢复后长时间卡住。
 */
const FAIL_CACHE = new Map();
const FAIL_TTL_MS = 60 * 1000;

/** 证书校验：单次握手的等待上限、最多探测几个候选、以及"域名@IP"级别的结果缓存 */
const VERIFY_TIMEOUT = 3000;
const VERIFY_MAX_CANDIDATES = 4;
const VERIFY_TTL_MS = 5 * 60 * 1000;
const VERIFY_CACHE = new Map();

function cacheGet(key) {
  const hit = CACHE.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > TTL_MS) {
    CACHE.delete(key);
    return null;
  }
  return hit.addresses;
}

function cacheSet(key, addresses) {
  CACHE.set(key, { at: Date.now(), addresses });
}

/* ------------------------------ DoH 查询 ------------------------------ */

/** 请求单个 DoH 端点，返回 A/AAAA 地址数组 */
function dohQuery(endpoint, host, proxy) {
  return new Promise((resolve) => {
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
      // 端点是 IP（223.5.5.5 等）时不能设 servername：RFC 6066 不允许，
      // 会刷 DEP0123 警告。这里按需留空。
      const isIpHost = /^\d+\.\d+\.\d+\.\d+$/.test(u.hostname);
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
        const t = tls.connect(
          { socket, servername: isIpHost ? '' : u.hostname, rejectUnauthorized: false },
          () => {
            const r = https.request(
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
          }
        );
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

/**
 * 并发问所有 DoH 端点，过滤污染，**只采用可信端点的答案**。
 *
 * 只认 `trusted: true`（墙外解析器）的结果。墙内解析器（AliDNS）的返回
 * 只进 `lastProviders` 供诊断页展示，**绝不拿去建连** ——
 * 实测它每次回的垃圾地址都不一样，黑名单追不上，唯一可靠的判据是
 * "解析器本身在不在墙外"。
 *
 * 拿不到可信答案时返回 []，由 `resolveHost` 走证书校验兜底。
 *
 * @returns {Promise<string[]>} 干净的地址
 */
async function resolveViaDoh(host, proxy, opts) {
  /**
   * `waitAll`：等所有端点都返回再挑（诊断用）。
   * 日常解析走"抢答"（谁先给出可信答案就用谁），
   * 但诊断要看到**每一个**端点分别回了什么 —— 抢答模式下，
   * 慢的端点还没返回就返回了，诊断页会显示不全。
   */
  const waitAll = !!(opts && opts.waitAll);
  const key = host + '|' + (proxy ? 'proxy' : 'direct');
  if (!waitAll) {
    const cached = cacheGet(key);
    if (cached) return cached;
  }

  const settled = [];
  let winner = null;
  let announceWinner = null;
  const winnerReady = new Promise((r) => {
    announceWinner = r;
  });

  /**
   * 谁先给出**可信**答案就用谁，不等其它端点。
   *
   * 为什么必须这样：墙内直连时 Cloudflare / Google 是连不上的，
   * 它们会一直挂到 DOH_TIMEOUT 才返回空 —— 如果等 Promise.all，
   * 明明已经拿到可信答案也要陪着一起等满超时。
   * 这里改成"抢到就返回"，慢的端点在后台跑完，结果照样进 lastProviders 供诊断展示。
   */
  const tasks = DOH_ENDPOINTS.map(async (ep, i) => {
    let raw = [];
    try {
      raw = await dohQuery(ep.url, host, proxy);
    } catch (e) {
      raw = [];
    }
    const clean = filterClean(raw);
    const rec = {
      name: ep.name,
      trusted: !!ep.trusted,
      viaProxy: !!proxy,
      raw,
      addrs: clean,
      clean,
      poisoned: raw.filter(isPoisoned),
    };
    settled[i] = rec;
    lastProviders = settled.filter(Boolean);
    if (rec.trusted && rec.addrs.length && !winner) {
      winner = rec;
      announceWinner();
    }
    return rec;
  });

  await (waitAll ? Promise.all(tasks) : Promise.race([winnerReady, Promise.all(tasks)]));

  if (winner) {
    dohStats.lastProvider = winner.name;
    dohStats.lastTrusted = true;
    dohStats.lastViaProxy = winner.viaProxy;
    if (!waitAll) cacheSet(key, winner.addrs);
    return winner.addrs;
  }
  return [];
}

/**
 * 用 TLS 证书校验一个候选地址是不是**真的属于该域名**。
 *
 * 为什么需要：这是本文件里唯一"无法被伪造"的判据。
 * 污染答案的 IP 段位每次都换（Facebook / Yahoo / SoftLayer 都出现过），
 * 靠列举 IP 段永远追不上；但污染地址所在的机器**不可能持有目标域名的合法证书**。
 * 所以拿候选 IP 当目标、用目标域名做 SNI 发起 TLS，看证书能否通过校验，
 * 就能直接回答"这个 IP 是不是真的在提供该域名"。
 *
 * 代价是一次握手（约几十到几百毫秒），且只在"没有可信 DoH 答案"的兜底路径上发生，
 * 结果按域名+IP 缓存，不会反复探测。
 *
 * @returns {Promise<boolean>}
 */
function verifyHost(ip, host, timeout) {
  const key = host + '@' + ip;
  const cached = VERIFY_CACHE.get(key);
  // 带 TTL：网络环境会变（比如用户中途开了代理），不能把"上次不通"永久钉死
  if (cached && Date.now() - cached.at < VERIFY_TTL_MS) return Promise.resolve(cached.ok);

  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      VERIFY_CACHE.set(key, { at: Date.now(), ok: v });
      if (VERIFY_CACHE.size > 200) {
        // 简单淘汰：删掉最早插入的一条
        const first = VERIFY_CACHE.keys().next();
        if (!first.done) VERIFY_CACHE.delete(first.value);
      }
      resolve(v);
    };

    let socket;
    try {
      socket = tls.connect({
        host: ip,
        port: 443,
        servername: host,
        rejectUnauthorized: true,
        timeout: timeout || VERIFY_TIMEOUT,
      });
    } catch (e) {
      return finish(false);
    }

    // rejectUnauthorized:true 时，证书链或域名对不上会直接触发 error；
    // 能走到 secureConnect 且 authorized 为真，就说明这个 IP 确实在提供该域名。
    socket.on('secureConnect', () => {
      const ok = socket.authorized === true;
      socket.destroy();
      finish(ok);
    });
    socket.on('timeout', () => {
      socket.destroy();
      finish(false);
    });
    socket.on('error', () => {
      socket.destroy();
      finish(false);
    });
  });
}

/** 系统 DNS（结果同样要过污染过滤 —— 它才是最常被污染的那个） */
function resolveSystem(host) {
  return new Promise((resolve) => {
    dns.lookup(host, { all: true }, (err, records) => {
      if (err || !records || !records.length) return resolve([]);
      resolve(records.map((r) => r.address));
    });
  });
}

let dohStats = {
  dohHits: 0,
  systemFallbacks: 0,
  lastHost: '',
  lastAddresses: [],
  lastSource: '',
  lastProvider: '',
  lastTrusted: false,
  lastViaProxy: false,
};
let lastProviders = [];
let lastFailure = null;

/**
 * 解析主机名。三级策略，**每一级都以"结果可验证"为前提**：
 *
 *   1. **可信 DoH**（Cloudflare / Google，墙外递归）→ 直接采用
 *   2. 没有可信答案时，取系统 DNS 的候选地址，**逐个做 TLS 证书校验**，
 *      只放行真正持有该域名证书的地址
 *   3. 仍然拿不到 → 返回 []，由 `makeLookup` 抛出**能看懂的**错误
 *
 * ⚠️ 与旧实现的两处关键区别：
 *  - 旧代码 DoH 失败就无条件 `resolveSystem`，而系统 DNS 恰恰是被污染的那个 ——
 *    等于"查不到正确结果时改用错误结果"。现在系统 DNS 的答案必须过证书校验。
 *  - 旧代码拿到第一个非空 DoH 结果就用（且 AliDNS 排在首位），污染答案会被直接采信。
 *
 * @returns {Promise<string[]>}
 */
async function resolveHost(host, proxy) {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return [host];

  // 刚失败过就别再等一遍（见 FAIL_CACHE 的注释）
  const failKey = host + '|' + (proxy ? 'proxy' : 'direct');
  const failedAt = FAIL_CACHE.get(failKey);
  if (failedAt && Date.now() - failedAt < FAIL_TTL_MS) {
    dohStats.lastHost = host;
    dohStats.lastSource = 'fail-cache';
    return [];
  }

  // 1) 可信 DoH
  const addrs = await resolveViaDoh(host, proxy);
  if (addrs.length) {
    FAIL_CACHE.delete(failKey);
    dohStats.dohHits++;
    dohStats.lastHost = host;
    dohStats.lastAddresses = addrs;
    dohStats.lastSource = proxy ? 'doh(经代理)' : 'doh(直连)';
    return addrs;
  }

  // 2) 系统 DNS + 证书校验兜底
  //
  // 候选**并发**探测：串行的话 4 个候选最坏要等 4×3=12 秒，
  // 而这本来就已经是"失败路径"了，不该让用户为一次注定失败的解析等这么久。
  // 墙内直连的环境下这一步必然失败（真实 IP 也会被 RST），
  // 所以重点不是"救回来"，而是**快速失败并说清楚原因**。
  const sysRaw = await resolveSystem(host);
  const candidates = filterClean(sysRaw).slice(0, VERIFY_MAX_CANDIDATES);
  const verdicts = await Promise.all(candidates.map((ip) => verifyHost(ip, host)));
  const verified = candidates.filter((_, i) => verdicts[i]);
  if (verified.length) {
    FAIL_CACHE.delete(failKey);
    dohStats.systemFallbacks++;
    dohStats.lastHost = host;
    dohStats.lastAddresses = verified;
    dohStats.lastSource = 'system(已通过证书校验)';
    return verified;
  }

  // 3) 给不出可验证的答案 → 明确失败，绝不硬连
  FAIL_CACHE.set(failKey, Date.now());
  if (FAIL_CACHE.size > 200) {
    const first = FAIL_CACHE.keys().next();
    if (!first.done) FAIL_CACHE.delete(first.value);
  }
  lastFailure = {
    host,
    at: Date.now(),
    proxy: proxy || '',
    systemRaw: sysRaw,
    systemPoisoned: sysRaw.filter(isPoisoned),
    probed: candidates,
    rejected: candidates.filter((_, i) => !verdicts[i]),
    providers: lastProviders,
  };
  dohStats.lastHost = host;
  dohStats.lastAddresses = [];
  dohStats.lastSource = 'all-poisoned';
  return [];
}

/**
 * 给 http/https 的 request options 生成一个 lookup 函数，
 * 顺序试遍解析出来的地址（第一个不通就试下一个）。
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
          // 这里必须给出**能直接照着做**的提示：这是墙内直连最常见的死法。
          // 文案按实际情况区分，避免把"校验不过"笼统说成"全是污染地址"。
          const f = lastFailure && lastFailure.host === hostname ? lastFailure : null;
          let why;
          if (!f || !f.systemRaw.length) why = '系统 DNS 没有返回任何结果';
          else if (!f.probed.length) why = '解析结果全是已知的污染地址';
          else why = '解析结果既非已知污染地址，也无法建立可信的 TLS 连接（被阻断）';
          return callback(
            new Error(
              'DNS 解析失败：' + hostname + ' 的' + why + '，已全部丢弃。' +
                '请配置可用代理（设置 · 网络里的"出口"，或环境变量 WW_PROXY），否则无法连接该域名。'
            )
          );
        }
        const wantV6 = options && options.family === 6;
        const filtered = addrs.filter((a) => (wantV6 ? a.includes(':') : !a.includes(':')));
        const list = filtered.length ? filtered : addrs;
        if (options && options.all) {
          return callback(
            null,
            list.map((a) => ({ address: a, family: a.includes(':') ? 6 : 4 }))
          );
        }
        callback(null, list[0], list[0].includes(':') ? 6 : 4);
      })
      .catch((e) => callback(e));
  };
}

/**
 * 探测：给 /api/status 用，让用户能看到本机 DNS 是否被污染、
 * 以及每个 DoH 端点到底回了什么（哪个端点在撒谎一目了然）。
 *
 * 返回字段里 `system` / `doh` / `match` / `poisoned` 是**旧字段，保持不变**（前端在用）；
 * 其余为新增的诊断细节。
 */
async function diagnose(host, proxy) {
  const systemRaw = await resolveSystem(host);
  const systemClean = filterClean(systemRaw);
  const systemPoisoned = systemRaw.filter(isPoisoned);

  // 与真实解析路径保持一致：只取可信 DoH 端点的答案。
  // 这里用 waitAll：诊断要看到每个端点分别回了什么，不能被"抢答"截断。
  const doh = await resolveViaDoh(host, proxy, { waitAll: true });
  const providers = lastProviders;

  // 旧语义：系统答案与 DoH 答案对不上 = 系统被污染
  const match = !!(systemClean.length && doh.length && systemClean.some((s) => doh.includes(s)));
  const poisoned = !!(systemPoisoned.length && (!systemClean.length || !match));

  // 走代理时污染不影响使用：CONNECT 传域名、由代理端解析。
  const bypassed = !!proxy;

  let verdict;
  if (doh.length && match) verdict = '系统 DNS 正常，且与墙外 DoH 结果一致';
  else if (doh.length && bypassed) verdict = '系统 DNS 被污染，但当前走代理，解析由代理端完成，不受影响';
  else if (doh.length) verdict = '系统 DNS 被污染；已改用墙外 DoH 解析，可正常访问';
  else if (bypassed) verdict = '未能从墙外 DoH 取得结果（请检查代理是否可用）；当前走代理时解析由代理端完成';
  else
    verdict =
      '系统 DNS 被污染，且拿不到任何可验证的解析结果。' +
      '请配置可用代理（设置 · 网络里的"出口"，或环境变量 WW_PROXY）。';

  return {
    host,
    // —— 旧字段（前端在用，不要改名/删除）——
    system: systemRaw,
    doh,
    match,
    poisoned,
    // —— 新增诊断细节 ——
    systemClean,
    systemPoisoned,
    viaProxy: bypassed,
    bypassed,
    verdict,
    providers: providers.map((p) => ({
      name: p.name,
      trusted: p.trusted,
      viaProxy: p.viaProxy,
      raw: p.raw,
      clean: p.clean,
      poisoned: p.poisoned,
    })),
    failure: lastFailure && lastFailure.host === host ? lastFailure : null,
  };
}

function stats() {
  return Object.assign({}, dohStats);
}

module.exports = {
  resolveHost,
  makeLookup,
  diagnose,
  stats,
  DOH_ENDPOINTS,
  // 导出给测试脚本与排障工具用
  isPoisoned,
  filterClean,
  matchCidr,
  verifyHost,
  ipv4ToInt,
  ipv6ToBigInt,
  POISON_CIDRS,
  BOGUS_CIDRS,
};
