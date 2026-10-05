'use strict';
/**
 * 零依赖 HTTP 客户端（node:http / node:https / node:tls）。
 *
 * 为什么要自己写而不用内置 fetch？
 *  - Node 24 的 fetch（undici）不支持通过 HTTP 代理发请求，除非开 `NODE_USE_ENV_PROXY=1`
 *    （实验性）或 `--use-env-proxy`。那种方式没法在代码里按请求切换代理，
 *    而本项目既要"读父项目的代理配置"，又要能在配置坏掉时回退直连，所以自己实现。
 *  - 顺带解决一个实测坑：部分网络下 Node 直连 steamcommunity.com 会 TLS 挂住，
 *    走代理（CONNECT 隧道）反而稳定。curl / WinHTTP 直连正常，是 Node 侧的差异。
 *
 * 支持：
 *  - HTTP / HTTPS
 *  - HTTP 代理（https 目标走 CONNECT 隧道，http 目标走绝对 URI 转发）
 *  - 超时、重定向跟随、gzip/deflate/br 解压
 *  - 返回 Set-Cookie 原始数组（登录态续期要用）
 */

const http = require('http');
const https = require('https');
const tls = require('tls');
const zlib = require('zlib');
const { URL } = require('url');
const dnsResolve = require('./dnsResolve');

const DEFAULT_TIMEOUT = 30000;
const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function decompress(buf, encoding) {
  try {
    if (encoding === 'gzip') return zlib.gunzipSync(buf);
    if (encoding === 'deflate') return zlib.inflateSync(buf);
    if (encoding === 'br') return zlib.brotliDecompressSync(buf);
  } catch (e) {
    /* 解压失败就按原文返回，交给上层报错 */
  }
  return buf;
}

/**
 * 在已建立的 socket 上向代理发 CONNECT，拿到隧道后返回该 socket。
 * 只有 https 目标需要这一步。
 */
/**
 * 在已建立的 socket 上向代理发 CONNECT，拿到隧道后返回该 socket。
 * 只有 https 目标需要这一步。
 *
 * ⚠️ 关键点：CONNECT 的 path 必须是**域名**，不能是本地解析出来的 IP。
 * 本机系统 DNS 对 steamcommunity.com 是**被污染的**（实测解析到 65.49.68.152
 * 这种跟 Steam 无关的地址，还有个应返回 NXDOMAIN 却被返回的 192.5.6.30 根域名服务器地址）。
 * 一旦先本地解析、再把 IP 塞进 CONNECT，代理就会去连那个错误地址，
 * 表现为"HTTP 200 但页面是通用 app hub / 无关内容"。
 * 传域名则让**代理端**去解析，绕开本机污染。
 */
function connectViaProxy(proxy, targetHost, targetPort, timeout) {
  return new Promise((resolve, reject) => {
    const proxyUrl = new URL(proxy);
    const proxyPort = Number(proxyUrl.port) || (proxyUrl.protocol === 'https:' ? 443 : 80);

    const req = http.request({
      host: proxyUrl.hostname,
      port: proxyPort,
      method: 'CONNECT',
      path: targetHost + ':' + targetPort,
      headers: { Host: targetHost + ':' + targetPort, 'Proxy-Connection': 'keep-alive' },
      timeout,
    });

    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return reject(new Error('代理 CONNECT 失败：HTTP ' + res.statusCode + '（代理无法解析或连不上 ' + targetHost + '）'));
      }
      resolve(socket);
    });
    req.on('timeout', () => req.destroy(new Error('代理 CONNECT 超时')));
    req.on('error', reject);
    req.end();
  });
}

/**
 * 发一个请求（**优先用 requestLimited**，它带限流与重试）。
 * @param {string} url
 * @param {object} [options]
 * @param {string} [options.method]
 * @param {object} [options.headers]
 * @param {string|Buffer} [options.body]
 * @param {string} [options.proxy]        形如 http://127.0.0.1:7890，空串表示直连
 * @param {number} [options.timeout]
 * @param {number} [options.maxRedirects]
 * @returns {Promise<{status:number, headers:object, body:string, setCookies:string[], url:string, redirects:number}>}
 */
async function rawRequest(url, options) {
  const opts = options || {};
  const maxRedirects = opts.maxRedirects === undefined ? 5 : opts.maxRedirects;
  const timeout = opts.timeout || DEFAULT_TIMEOUT;

  let current = url;
  let method = (opts.method || 'GET').toUpperCase();
  let body = opts.body;
  let redirects = 0;

  /*
   * 跨跳 Cookie 罐。
   *
   * 为什么必须有：Steam 会用 302 把请求"重定向到同一个 URL"来种匿名 Cookie
   * （steamCountry / sessionid 之类）。旧实现跟随时不带上响应里的 Set-Cookie，
   * 于是每次跳转都还是 302 —— 跟满 5 次后返回一个空 body 的 302，
   * 上层只能报"Steam 没有返回数据"，表现为**列表一直转圈、一张图都不出**。
   */
  const jar = parseCookieHeader(opts.headers && opts.headers.cookie);
  const headers = Object.assign({}, opts.headers || {});

  for (;;) {
    if (Object.keys(jar).length) headers.cookie = cookieHeaderOf(jar);
    const res = await once(current, method, body, headers, opts.proxy || '', timeout);
    mergeSetCookies(jar, res.headers['set-cookie']);

    const location = res.headers.location;
    const isRedirect = res.status >= 300 && res.status < 400 && location && redirects < maxRedirects;
    if (!isRedirect) {
      res.url = current;
      res.redirects = redirects;
      return res;
    }
    redirects += 1;
    current = new URL(location, current).toString();
    // 303 以及 301/302 下的 POST 按浏览器行为降级成 GET
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
      method = 'GET';
      body = undefined;
    }
  }
}

/** Cookie 头 → { name: value } */
function parseCookieHeader(s) {
  const out = {};
  String(s || '')
    .split(';')
    .forEach((kv) => {
      const i = kv.indexOf('=');
      if (i > 0) out[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
    });
  return out;
}

function cookieHeaderOf(jar) {
  return Object.keys(jar)
    .map((k) => k + '=' + jar[k])
    .join('; ');
}

/** 把 Set-Cookie 合并进罐子（只取 name=value；过期/空值 = 删除） */
function mergeSetCookies(jar, setCookies) {
  (setCookies || []).forEach((line) => {
    const first = String(line).split(';')[0];
    const i = first.indexOf('=');
    if (i <= 0) return;
    const name = first.slice(0, i).trim();
    const val = first.slice(i + 1).trim();
    if (!name) return;
    if (!val || /expires=thu, 01 jan 1970/i.test(String(line))) delete jar[name];
    else jar[name] = val;
  });
}

/** 单次请求（不跟重定向） */
function once(url, method, body, headers, proxy, timeout) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch (e) {
      return reject(new Error('非法 URL：' + url));
    }

    const isHttps = target.protocol === 'https:';
    const port = Number(target.port) || (isHttps ? 443 : 80);

    const finalHeaders = Object.assign(
      {
        'User-Agent': DEFAULT_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
      },
      headers || {}
    );
    // Host 必须显式给：CONNECT 隧道那条路径用了 createConnection，
    // Node 无从推断 host，不带 Host 头时 Akamai 会直接回 400 "Invalid URL"（踩过）。
    if (!finalHeaders.Host && !finalHeaders.host) {
      finalHeaders.Host = target.host;
    }
    if (body !== undefined && body !== null && finalHeaders['Content-Length'] === undefined) {
      finalHeaders['Content-Length'] = Buffer.byteLength(body);
    }

    const collect = (stream, base) => {
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => {
        const rawBuf = decompress(Buffer.concat(chunks), base.encoding);
        resolve({
          status: base.status,
          headers: base.headers,
          setCookies: base.setCookies,
          // body 是 UTF-8 文本；buffer 是原始字节。
          // 图片等二进制内容**必须**用 buffer —— 早期把二进制当 utf8 转字符串，
          // 字节被替换字符破坏，浏览器拿到的是坏图（表现为"图片全部显示占位"）。
          body: rawBuf.toString('utf8'),
          buffer: rawBuf,
        });
      });
      stream.on('error', reject);
    };

    const onResponse = (res) => {
      let enc = String(res.headers['content-encoding'] || '').toLowerCase();
      collect(res, {
        status: res.statusCode,
        headers: res.headers,
        setCookies: res.headers['set-cookie'] || [],
        encoding: enc,
      });
    };

    if (!proxy) {
      // 直连。用自定义 lookup 走 DoH —— 本机系统 DNS 对部分 Steam 域名是被污染的，
      // 直接 dns.lookup 会连到错误主机（HTTP 200 但内容是无关页面）。
      const mod = isHttps ? https : http;
      const req = mod.request(
        {
          host: target.hostname,
          port,
          method,
          path: target.pathname + target.search,
          headers: finalHeaders,
          timeout,
          lookup: dnsResolve.makeLookup(target.hostname, ''),
        },
        onResponse
      );
      req.on('timeout', () => req.destroy(new Error('请求超时（' + timeout + 'ms）：' + target.hostname)));
      req.on('error', reject);
      if (body !== undefined && body !== null) req.write(body);
      req.end();
      return;
    }

    if (!isHttps) {
      // 明文目标：直接让代理转发绝对 URI
      const proxyUrl = new URL(proxy);
      const req = http.request(
        {
          host: proxyUrl.hostname,
          port: Number(proxyUrl.port) || 80,
          method,
          path: target.toString(),
          headers: finalHeaders,
          timeout,
        },
        onResponse
      );
      req.on('timeout', () => req.destroy(new Error('请求超时（' + timeout + 'ms）')));
      req.on('error', reject);
      if (body !== undefined && body !== null) req.write(body);
      req.end();
      return;
    }

    // https 目标：CONNECT 隧道 + 在隧道 socket 上做 TLS
    connectViaProxy(proxy, target.hostname, port, timeout)
      .then((socket) => {
        socket.setTimeout(timeout, () => socket.destroy(new Error('TLS 阶段超时')));
        const tlsSocket = tls.connect(
          { socket, servername: target.hostname, rejectUnauthorized: false },
          () => {
            tlsSocket.setTimeout(0);
            // 注意：这里必须用 http.request（明文 HTTP 语义）跑在已建立的 TLS socket 上，
            // 并且 Host 头已经在上面的 finalHeaders 里显式设好。
            // 试过 https.request + createConnection，会 socket hang up（Agent 会再折腾一次握手）。
            const req = http.request(
              {
                createConnection: () => tlsSocket,
                method,
                path: target.pathname + target.search,
                headers: finalHeaders,
                timeout,
              },
              onResponse
            );
            req.on('timeout', () => req.destroy(new Error('请求超时（' + timeout + 'ms）')));
            req.on('error', reject);
            if (body !== undefined && body !== null) req.write(body);
            req.end();
          }
        );
        tlsSocket.on('error', reject);
      })
      .catch(reject);
  });
}

/**
 * GET 一个页面/接口，返回文本。
 * @param {string} url
 * @param {object} opts { cookie, proxy, timeout, headers, maxRedirects }
 */
async function getText(url, opts) {
  opts = opts || {};
  const headers = Object.assign({}, opts.headers || {});
  if (opts.cookie) headers.Cookie = opts.cookie;
  /*
   * ⚠️ 这里**统一走 requestLimited**，不要写成 `opts.noLimit ? rawRequest : requestLimited`。
   * 那样写会绕过 requestLimited 里的计时与上游记录 —— 而浏览/详情这些主力接口
   * 全都带 noLimit，于是"上游为什么慢"一条都记不到（踩过）。
   * noLimit 的语义由 requestLimited 内部处理：跳过限流闸门，但照常记账。
   */
  const res = await requestLimited(url, {
    method: 'GET',
    headers,
    proxy: opts.proxy,
    timeout: opts.timeout,
    maxRedirects: opts.maxRedirects,
    noLimit: opts.noLimit,
  });
  return res;
}

/** POST 表单（Steam 的订阅/收藏接口都是 application/x-www-form-urlencoded + sessionid） */
async function postForm(url, form, opts) {
  opts = opts || {};
  const body = new URLSearchParams(form || {}).toString();
  const headers = Object.assign(
    {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      Origin: new URL(url).origin,
      Referer: opts.referer || url,
    },
    opts.headers || {}
  );
  if (opts.cookie) headers.Cookie = opts.cookie;
  return rawRequest(url, {
    method: 'POST',
    headers,
    body,
    proxy: opts.proxy,
    timeout: opts.timeout,
    maxRedirects: opts.maxRedirects,
  });
}

/** POST JSON */
async function postJson(url, payload, opts) {
  opts = opts || {};
  const body = JSON.stringify(payload || {});
  const headers = Object.assign(
    { 'Content-Type': 'application/json; charset=utf-8' },
    opts.headers || {}
  );
  if (opts.cookie) headers.Cookie = opts.cookie;
  return rawRequest(url, { method: 'POST', headers, body, proxy: opts.proxy, timeout: opts.timeout });
}

/** POST 表单到 Steam Web API（api.steampowered.com 用表单而不是 JSON） */
async function postApiForm(url, form, opts) {
  opts = opts || {};
  const body = new URLSearchParams(form || {}).toString();
  const headers = Object.assign(
    { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    opts.headers || {}
  );
  return (opts.noLimit ? rawRequest : requestLimited)(url, {
    method: 'POST',
    headers,
    body,
    proxy: opts.proxy,
    timeout: opts.timeout,
  });
}

/* ------------------------------------------------------------------ *
 * 限流保护
 *
 * Steam 社区页对同一 IP 的突发请求很敏感：实测连打十几个请求后
 * 详情页就开始回 429。这里按 host 串行化 + 最小间隔，遇到 429/503
 * 时按 Retry-After 退避重试。创意工坊的浏览页本来就是"一页一个请求"，
 * 串行不会拖慢体验，但能避免"用着用着突然全挂"。
 * ------------------------------------------------------------------ */

const HOST_STATE = new Map(); // host -> { chain: Promise, slot: number(下一次可发时刻) }
const MIN_GAP_MS = 1200;      // 同一 host 两次请求的最小间隔
const MAX_RETRY = 4;

/*
 * 429 熔断（冷却）。
 *
 * 没有它的时候，一次临时限流会被**成倍放大**：每个调用方都各自重试 5 次，
 * 而且这些重试还要串行过闸门。实测用户点了一次订阅（前置的详情页被限流），
 * 日志里就留下 12 条 429、实际打了 60 次上游请求 —— 限流不但没缓解，
 * 反而因为我们自己的重试持续得更久（越重试越 429）。
 *
 * 所以：某个资源一旦回 429，接下来 COOLDOWN_MS 内直接快速失败，
 * **不再发请求**。反正这几秒里再打大概率还是 429。
 */
const COOLDOWN_MS = 60 * 1000;
const COOLDOWN = new Map(); // coolKey(url) -> 可以再请求的时刻

/**
 * 冷却键。带不带 `l=schinese` 要算同一个资源 —— 实测 Steam 对
 * `filedetails/?id=X` 和 `filedetails/?id=X&l=schinese` 是同一个限流桶，
 * 用完整 URL 当键会让两条冷却互相独立，白白多挨一轮 429。
 */
function coolKey(url) {
  try {
    const u = new URL(url);
    const params = [];
    u.searchParams.forEach((v, k) => {
      if (k !== 'l') params.push(k + '=' + v);
    });
    params.sort();
    return u.host + u.pathname + (params.length ? '?' + params.join('&') : '');
  } catch (e) {
    return String(url);
  }
}

/** 给日志用的短 URL */
function shortUrl(url) {
  try {
    const u = new URL(url);
    return u.host + u.pathname + (u.search ? u.search.slice(0, 60) : '');
  } catch (e) {
    return String(url);
  }
}

/** 把某个资源标记为"冷却中"。ms 为 0 时用默认时长 */
function markCooldown(url, ms) {
  const key = coolKey(url);
  COOLDOWN.set(key, Date.now() + (ms > 0 ? ms : COOLDOWN_MS));
  // 顺手清理过期的，别让这个 Map 无限长（正常也就几十个键）
  if (COOLDOWN.size > 500) {
    const now = Date.now();
    COOLDOWN.forEach((until, k) => {
      if (until <= now) COOLDOWN.delete(k);
    });
  }
}

/** 还剩多少毫秒冷却，0 表示可以正常请求 */
function coolingLeft(url) {
  const until = COOLDOWN.get(coolKey(url)) || 0;
  return until > Date.now() ? until - Date.now() : 0;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 串行化 + 限速地执行一个请求函数。
 *
 * 关键点：**占位（reserve）要在同步阶段完成**。
 * 早期写法是"等轮到自己时才去读 st.last"，结果同一 tick 里发起的多个请求
 * 都会读到同一个 st.last、算出 0 等待，限流直接失效（实测 detail 列表
 * 并发三连之后 Steam 就开始回 429）。改成先预约时间片、再异步等待。
 *
 * 间隔取 1200ms 而不是更短：连续快速切换筛选（点标签→再搜索→再翻页）时，
 * 800ms 仍然会被 Steam 判定为异常流量并回 429/精简页，表现是"点了没反应，
 * 过一会儿才刷新"。宁可慢一点，也不要出现"看起来卡住"。
 */
function withHostLimit(host, fn, trace) {
  const st = HOST_STATE.get(host) || { chain: Promise.resolve(), slot: 0 };
  const startAt = Math.max(Date.now(), st.slot);
  st.slot = startAt + MIN_GAP_MS; // 立刻占位，后面的请求自动排队
  HOST_STATE.set(host, st);

  const run = st.chain.then(async () => {
    const wait = startAt - Date.now();
    if (wait > 0) {
      // 记进 trace：这段是"被限流闸门排队"，不是网络慢 —— 两者要分开算
      if (trace) trace.queue += wait;
      await sleep(wait);
    }
    return fn();
  });
  // 链上任何一环失败都不能把后续请求带崩
  st.chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/**
 * 上游请求耗时明细。
 *
 * 为什么要把三段分开：用户看到"接口 67 秒"，第一反应是"网慢"，
 * 但实际可能是**限流排队**（同 host 每 1.2 秒才放一个）或**重试退避**
 * （429/403 之后等 0.9→1.8→3.6 秒）。三者都表现为"慢"，
 * 处理方向却完全不同：排队要调限流参数，退避要查是不是被 Steam 限了，
 * 真网络慢才去查代理/DNS。日志里不拆开，就只能靠猜。
 *
 * 只记**慢的（>1.5 秒）和失败的**，快的成功请求不记 —— 否则一页几十张图
 * 会把真正有用的行淹掉。
 */
const UPSTREAM_SLOW_MS = 1500;

/*
 * 最近的上游请求记录（环形缓冲）。
 *
 * 为什么需要：单次上游请求可能都不慢，但一个接口里**打了很多次** ——
 * 比如 /api/details 要分批取详情，总耗时 6.8 秒，而每次上游只要 800ms。
 * 只看"慢请求"日志会一片空白，看不出为什么慢。routes.js 会在接口慢时
 * 用 recentSince() 把这段时间内的上游请求汇总成一行。
 */
const RECENT_MAX = 80;
const RECENT = [];
function recordUpstream(e) {
  RECENT.push(e);
  while (RECENT.length > RECENT_MAX) RECENT.shift();
}
/** 取 t0 之后发生的上游请求（给 routes.js 做接口级汇总用） */
function recentSince(t0) {
  const out = [];
  for (let i = RECENT.length - 1; i >= 0; i--) {
    if (RECENT[i].at < t0) break;
    out.push(RECENT[i]);
  }
  return out;
}

function logUpstream(t, url, total, res) {
  const status = (res && res.status) || 0;
  const failed = !res || status >= 400;
  const short = shortUrl(url);
  recordUpstream({
    at: Date.now(),
    ms: total,
    queue: t.queue,
    net: t.net,
    retry: t.retry,
    attempts: t.attempts,
    status: status,
    failed: failed,
    url: short,
  });
  if (!failed && total < UPSTREAM_SLOW_MS) return;
  const parts = ['排队 ' + Math.round(t.queue), '网络 ' + Math.round(t.net)];
  if (t.retry) parts.push('重试退避 ' + Math.round(t.retry));
  console.log(
    '[upstream] ' + (failed ? 'FAIL ' : '慢   ') + Math.round(total) + 'ms  (' + parts.join(' / ') + ')' +
      '  x' + t.attempts + (status ? '  HTTP ' + status : '') + '  ' + short
  );
}

/**
 * 把一段时间内的上游请求汇总成一行 —— 接口慢的时候调，回答"为什么慢"。
 * 三种典型结论：
 *   次数多但每次都快      → 是"请求次数"问题（分批/重复取），不是网络
 *   排队占比高            → 被限流闸门挡住了，调 MIN_GAP_MS 或减少请求数
 *   网络占比高 + 次数少    → 真的网络/代理慢
 */
function summarizeSince(t0) {
  const list = recentSince(t0);
  if (!list.length) return '';
  let ms = 0;
  let queue = 0;
  let net = 0;
  let retry = 0;
  let failed = 0;
  let slowest = 0;
  for (const r of list) {
    ms += r.ms;
    queue += r.queue;
    net += r.net;
    retry += r.retry;
    if (r.failed) failed++;
    if (r.ms > slowest) slowest = r.ms;
  }
  const parts = ['上游 ' + list.length + ' 次', '合计 ' + Math.round(ms) + 'ms'];
  const detail = ['排队 ' + Math.round(queue), '网络 ' + Math.round(net)];
  if (retry) detail.push('重试退避 ' + Math.round(retry));
  parts.push('（' + detail.join(' / ') + '）');
  parts.push('最慢 ' + Math.round(slowest) + 'ms');
  if (failed) parts.push('失败 ' + failed + ' 次');
  return parts.join('  ');
}

/**
 * 带限流与重试的 request 包装。所有上层调用都应该走这个。
 */
async function requestLimited(url, options) {
  const opts = options || {};
  let host;
  try {
    host = new URL(url).host;
  } catch (e) {
    return rawRequest(url, opts);
  }
  /*
   * 冷却中：直接快速失败，不发请求（见 COOLDOWN_MS 的说明）。
   *
   * ⚠️ 这个检查必须在 noLimit 分支**之前**：浏览页/详情页走的都是 noLimit，
   * 放到后面等于对主要路径完全没生效（第一版就踩了这个坑，一测就发现
   * 冷却期间还是真去打网络了）。
   */
  const cool = coolingLeft(url);
  if (cool > 0) {
    console.log('[upstream] 冷却中（' + Math.ceil(cool / 1000) + 's 后重试，本次不发请求）  ' + shortUrl(url));
    return { status: 429, headers: {}, body: '', cooled: true, url: url };
  }

  if (opts.noLimit) {
    // 不走闸门也要记（图片走的就是这条路），否则"图片为什么慢"没数据
    const t = { queue: 0, retry: 0, net: 0, attempts: 1, status: 0 };
    const t0 = Date.now();
    const n0 = Date.now();
    const res = await rawRequest(url, opts);
    t.net = Date.now() - n0;
    t.status = res && res.status;
    if (res && res.status === 429) markCooldown(url);
    logUpstream(t, url, Date.now() - t0, res);
    return res;
  }

  const t = { queue: 0, retry: 0, net: 0, attempts: 0, status: 0 };
  const t0 = Date.now();
  let lastRes = null;
  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    const res = await withHostLimit(
      host,
      async () => {
        const n0 = Date.now();
        const r = await rawRequest(url, opts);
        t.net += Date.now() - n0;
        t.attempts++;
        t.status = r && r.status;
        return r;
      },
      t
    );
    lastRes = res;
    /*
     * 429 = Steam 明确说"别打了"。**立刻停止重试 + 进冷却**。
     *
     * 实测（2026-10-05 用户点订阅）：一个详情页被 429 后，我们按老逻辑
     * 又重试了 5 次 × 多个调用方，日志里留下 12 条 429、实际打了 60 次请求 ——
     * 限流不但没缓解，反而被我们自己的重试拖得更久。重试在这里是纯放大。
     * 有 Retry-After 就按它冷却，没有就用默认值。
     */
    if (res && res.status === 429) {
      const ra = res.headers && res.headers['retry-after'];
      const raSec = ra && /^\d+$/.test(String(ra).trim()) ? parseInt(ra, 10) : 0;
      markCooldown(url, raSec ? Math.min(raSec * 1000, 5 * 60 * 1000) : 0);
      break;
    }
    // 502/503/403 是"服务端打嗝"，重试有意义（403 有时是 Akamai 的软封）
    const retryable = res.status === 503 || res.status === 502 || res.status === 403;
    if (!retryable || attempt === MAX_RETRY) break;
    // Retry-After 优先，否则指数退避
    let waitMs = Math.min(8000, 900 * Math.pow(2, attempt));
    const ra = res.headers && res.headers['retry-after'];
    if (ra && /^\d+$/.test(String(ra).trim())) waitMs = Math.min(15000, parseInt(ra, 10) * 1000);
    t.retry += waitMs;
    await sleep(waitMs);
  }
  logUpstream(t, url, Date.now() - t0, lastRes);
  return lastRes;
}

module.exports = {
  request: requestLimited,
  rawRequest,
  requestLimited,
  once,
  getText,
  postForm,
  postJson,
  postApiForm,
  summarizeSince,
  DEFAULT_UA,
  MIN_GAP_MS,
  COOLDOWN_MS,
  // 冷却状态：给自检/排查用（"这个 URL 是不是还在冷却"）
  coolingLeft,
  markCooldown,
};
