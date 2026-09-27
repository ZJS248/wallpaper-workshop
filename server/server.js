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
      console.log(
        '[api] ' + (req.method || 'GET') + ' ' + pathname + (url.search || '') + '  ' + (Date.now() - started) + 'ms'
      );
    }
  }
});

(async () => {
  const cfg = await settings.initAsync();
  const port = cfg.port;
  const host = cfg.host || '0.0.0.0';

  server.listen(port, host, () => {
    console.log('');
    console.log('  wallpaper-workshop  ·  Wallpaper Engine 创意工坊（网页版）');
    console.log('  ────────────────────────────────────────────────────────');
    console.log('  前端 / 接口 : http://localhost:' + port + '/');
    console.log('  应用 ID     : ' + require('./lib/util').APP_ID + '  (Wallpaper Engine)');
    console.log('  代理        : ' + (cfg.proxy || '(直连)') + '  来源: ' + (cfg.proxySource || 'direct'));
    console.log('  登录态      : ' + (cfg.cookie ? cfg.cookie.length + ' 字节，来源 ' + cfg.cookieSource : '未登录（浏览不受影响）'));
    console.log('  父项目      : ' + (cfg.parent && cfg.parent.found ? cfg.parent.dir : '未探测到'));
    console.log('  父项目后端  : ' + (cfg.parentApiBase || '未探测到（默认 http://127.0.0.1:8897）'));
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
