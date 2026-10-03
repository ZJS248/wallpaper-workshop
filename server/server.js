'use strict';
/**
 * wallpaper-workshop 服务端入口。
 *
 * 零依赖：只用 Node 内置模块，`node server.js` 直接就能跑。
 *   node server.js                  默认 0.0.0.0:9391
 *   node server.js 9400             指定端口
 *   WW_PORT=9400 WW_PROXY= node server.js
 *
 * 同时承担两件事：
 *   1. /api/*  业务接口（Steam 创意工坊的浏览/搜索/订阅/收藏）
 *   2. 静态托管前端（无构建步骤，源码目录就能被直接托管）
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const settings = require('./lib/settings');
const routes = require('./routes');
const session = require('./lib/session');
const frontLog = require('./lib/frontLog');
const httpClient = require('./lib/httpClient');
const { HttpError } = require('./lib/util');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const CONFIG_DIR = path.join(ROOT, 'config');

// 静态托管的两个根：项目根（index.html / src/）与 public/（vendor/ 离线依赖）
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

// 请求体解析在 routes.js 里（readJsonBody），这里不再重复实现：
// 之前这里导出一个 readJson(req)，却在 routes.handle 里以参数名 readJson 遮蔽，
// 调用时漏传 req，直接 500。收进 routes 模块可以避免这类"同名遮蔽"问题。

/** 静态文件服务（带 SPA 兜底） */
function serveStatic(req, res, pathname) {
  // 双保险：万一响应已经发出去（接口报错后又被走到这里），绝不能再写头，
  // 否则 ERR_HTTP_HEADERS_SENT 会直接崩掉进程。
  if (res.headersSent || res.writableEnded) return;

  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';

  const bases = [ROOT, PUBLIC_DIR];
  const candidates = bases.map((b) => path.join(b, rel));
  const allowed = candidates.filter((p) => p.startsWith(ROOT));

  const tryNext = (i) => {
    if (i >= allowed.length) {
      // SPA 兜底
      const idx = path.join(ROOT, 'index.html');
      return fs.readFile(idx, (e, buf) => {
        if (e) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          return res.end('404 not found');
        }
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
        res.end(buf);
      });
    }
    const p = allowed[i];
    fs.stat(p, (err, st) => {
      if (err || !st.isFile()) return tryNext(i + 1);
      const ext = path.extname(p).toLowerCase();
      // 配置目录不对外（可能含 Cookie）
      if (p.startsWith(CONFIG_DIR)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('403 forbidden');
      }
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Length': st.size,
        'Cache-Control': ext === '.html' ? 'no-cache' : 'no-cache',
      });
      fs.createReadStream(p).pipe(res);
    });
  };
  tryNext(0);
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  let url;
  try {
    url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  } catch (e) {
    res.writeHead(400);
    return res.end('bad request');
  }
  const pathname = url.pathname;

  // 简单的访问日志（只记接口，静态资源不刷屏）
  const shouldLog = pathname.startsWith('/api/') || pathname === '/img';

  /*
   * 图片代理跑在哪个端口，页面需要知道才能拼出 <img> 的地址。
   * 这里按**请求自己的 Host** 生成，而不是写死 127.0.0.1：
   * 通过局域网 IP 访问时（host 0.0.0.0），图片也必须用同一个 IP 才不会被浏览器拦。
   */
  if (pathname === '/imgbase.js') {
    const host = String(req.headers.host || '').split(':')[0] || '127.0.0.1';
    const body = 'window.WW_IMG_BASE=' + JSON.stringify(imgPort ? 'http://' + host + ':' + imgPort : '') + ';';
    res.writeHead(200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-cache',
    });
    return res.end(body);
  }

  try {
    // 注意：静态分支必须放在 try 里面，并且用 `return` 收尾。
    // 曾经的写法是 `if (!handled) serveStatic(...)` —— serveStatic 是异步的，
    // 一旦一个请求先走了 /api 报错、又被继续走到静态分支，就会
    // ERR_HTTP_HEADERS_SENT 把整个进程带崩（踩过）。
    const handled = await routes.handle({ req, res, url, pathname });
    if (!handled) {
      serveStatic(req, res, pathname);
      return;
    }
  } catch (e) {
    const status = e instanceof require('./lib/util').HttpError ? e.status : 500;
    if (!res.headersSent) {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: e.message || String(e) }));
    } else if (!res.writableEnded) {
      res.end();
    }
    if (status >= 500) console.error('[error]', pathname, e.stack || e.message);
  } finally {
    if (shouldLog) {
      const ms = Date.now() - started;
      /*
       * 慢接口顺手把上游明细汇总出来。
       *
       * 只打"接口 6800ms"是查不下去的 —— 得知道是**打了很多次上游**、
       * 还是**某一次特别慢**、还是**被限流闸门排队**。httpClient 会把最近的
       * 上游请求记在环形缓冲里，这里按本请求的时间窗汇总：
       *   次数多但每次都快   → 是请求次数问题（分批/重复取），不是网络
       *   排队占比高         → 被 MIN_GAP_MS 挡住了，调限流或减少请求数
       *   网络占比高+次数少   → 真的网络/代理慢
       */
      let sum = '';
      if (ms > 1500) {
        try {
          sum = httpClient.summarizeSince(started);
        } catch (e) {
          /* 汇总失败不影响日志 */
        }
      }
      console.log(
        '[api] ' + (req.method || 'GET') + ' ' + pathname + (url.search || '') + '  ' + ms + 'ms' +
          (sum ? '\n       ↳ ' + sum : '')
      );
    }
  }
});

/* ------------------------------ 图片代理（独立端口） ------------------------------ */
/*
 * 为什么图片要单独占一个端口
 * ---------------------------------------------------------------------------
 * 浏览器（Chromium / Electron）对 **HTTP/1.1 的每个 origin 只开 6 条并发连接**。
 * 本项目是纯 HTTP/1.1（`http.createServer`，没有 HTTPS，所以用不上 HTTP/2 多路复用），
 * 而一屏 30 张预览图全部走同源的 `/img?u=…` —— 6 条连接瞬间占满，
 * `/api/subscribed` 这种接口请求排在后面拿不到 socket。
 *
 * 实测症状（用户提供的 DevTools 截图）：
 *     Connection start / 已停止  10.92 秒   ← 请求根本没发出去
 *     已发送请求                 0.15 毫秒
 *     正在等待服务器响应          6.05 秒   ← 后端真实只花了 6 秒
 *     总计                      16.97 秒
 * 也就是说 64% 的时间耗在"排队等连接"，而 Steam 那边只背了 6 秒的锅。
 *
 * 注意：服务端那个 `imageGate`（routes.js）**并不能缓解这个问题**。
 * 它是在请求已经被 accept 之后才 await 的，图片请求占着浏览器那条 socket，
 * 服务端却既不响应也不干活，只是挂进队列干等 —— 队列从浏览器搬到了服务端，
 * 一个 socket 都没省下来。把 origin 真正拆开才是干净的解法。
 *
 * 拆开之后：图片和接口各拿各的 6 条连接，谁也挤不倒谁。
 * 独立端口起不来时（端口被占 / 权限问题）imgPort 置 0，前端自动退回同源 /img，
 * 行为与改动前完全一致 —— 只是慢，不会坏。
 */
let imgPort = 0;

const imgServer = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  } catch (e) {
    res.writeHead(400);
    return res.end('bad request');
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }
  if (url.pathname !== '/img') {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('这个端口只提供 /img');
  }
  try {
    await routes.handleImage(req, res, url);
  } catch (e) {
    if (!res.headersSent) {
      const status = e instanceof HttpError ? e.status : 500;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: e.message || String(e) }));
    } else if (!res.writableEnded) {
      res.end();
    }
    if (!(e instanceof HttpError)) console.error('[img-error]', url.search, e.stack || e.message);
  }
});

(async () => {
  const cfg = await settings.initAsync();
  const port = cfg.port;
  const host = cfg.host || '0.0.0.0';

  /*
   * 同步把 imgPort 置上（在 listen 回调之前），避免"端口其实起得来、
   * 但 /imgbase.js 已经先发过一版空值"的窗口期。
   * 起失败再由 error 事件置回 0，前端下次取到空串就退回同源。
   */
  imgPort = port + 1;
  imgServer.on('error', (e) => {
    imgPort = 0;
    console.warn('  图片代理独立端口 ' + (port + 1) + ' 启动失败（' + (e.code || e.message) + '），退回同源 /img');
  });
  /*
   * 启动时清一次前端日志（按保留期 7 天 + 总量 20MB）。
   * 放在这里而不是只靠写入时清理：用户可能开了几天才想起来看日志，
   * 期间前端一条都没上报的话，写入路径上的节流清理永远不触发。
   */
  try {
    const swept = frontLog.sweep(true);
    if (swept && swept.removed && swept.removed.length) {
      console.log('  日志清理    : 删除 ' + swept.removed.length + ' 个过期文件（保留 ' +
        frontLog.RETENTION_DAYS + ' 天）');
    }
  } catch (e) {
    /* 清理失败不能影响启动 */
  }

  imgServer.listen(imgPort, host);

  server.listen(port, host, () => {
    console.log('');
    console.log('  wallpaper-workshop  ·  Wallpaper Engine 创意工坊（网页版）');
    console.log('  ────────────────────────────────────────────────────────');
    console.log('  前端 / 接口 : http://localhost:' + port + '/');
    console.log('  图片代理    : 端口 ' + imgPort + '（与接口分开，避免互相抢浏览器那 6 条连接）');
    console.log('  应用 ID     : ' + require('./lib/util').APP_ID + '  (Wallpaper Engine)');
    console.log('  代理        : ' + (cfg.proxy || '(直连)') + '  来源: ' + (cfg.proxySource || 'direct'));
    console.log('  登录态      : ' + (cfg.cookie ? cfg.cookie.length + ' 字节，来源 ' + cfg.cookieSource : '未登录（浏览不受影响）'));
    console.log('  父项目      : ' + (cfg.parent && cfg.parent.found ? cfg.parent.dir : '未探测到'));
    console.log('  父项目后端  : ' + (cfg.parentApiBase || '未探测到（默认 http://127.0.0.1:8897）'));
    console.log('  前端日志    : ' + frontLog.LOG_DIR + '（按天分文件，保留 ' + frontLog.RETENTION_DAYS + ' 天）');
    console.log('                前端上报的行会实时打在下面（带 [前端] 前缀），也可以 GET /api/log?tail=200 读回');
    console.log('  自检        : node scripts/selftest.js');
    console.log('');
    session.logEvent(
      'boot',
      '端口 ' + port + '，代理 ' + (cfg.proxy || '直连') + '，登录态来源 ' + cfg.cookieSource
    );

    // 后台预热 /api/status 需要的 DNS 诊断与应用信息（不阻塞首屏）
    routes.warmupStatusExtras();
  });
})();

process.on('unhandledRejection', (e) => {
  console.error('[unhandledRejection]', e && e.stack ? e.stack : e);
});

// 最后一道防线：单个请求的异常不应该让整个服务下线。
process.on('uncaughtException', (e) => {
  console.error('[uncaughtException]', e && e.stack ? e.stack : e);
});
