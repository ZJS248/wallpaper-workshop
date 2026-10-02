'use strict';
/**
 * 配置与「父项目接入」探测。
 *
 * 设计原则：**独立运行优先，父项目信息只做加成**。
 *  - 独立运行：没有父项目也能用（浏览/搜索/详情全都不需要登录；订阅类操作走自己的登录）。
 *  - 接入后：从父项目（wallpaper-manager / HTML-website）借两样东西：
 *      1) 代理配置 —— 父项目本来就要科学上网才能连 Steam，复用它的探测结果最省事
 *      2) Steam Cookie —— 父项目已登录过 Steam，直接拿来用
 *    两者都是"能读到就用，读不到就算了"。
 *
 * 这里**只读不写**父项目的任何文件。
 * 运行时（浏览器里）的 Cookie 走 /api/session/*，优先级高于这里的磁盘 Cookie。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// 本文件在 <项目>/server/lib/settings.js：上两级是项目根，再上一级才是 workspace 根
const PROJECT = path.resolve(__dirname, '..', '..');
const ROOT = path.resolve(PROJECT, '..');

/** 父项目的候选根目录（与本项目同级；顺序即优先级） */
const PARENT_CANDIDATES = [
  path.join(ROOT, 'HTML-website'),
  path.join(ROOT, 'wallpaper-manager'),
];

const DEFAULTS = {
  host: '0.0.0.0',
  port: 9391,
  proxy: '',            // 空 = 直连
  proxyAuto: true,      // 自动从父项目 / dsh 代理配置探测
  cookie: '',           // Steam Cookie（独立运行时可由 /api/session/cookie 注入）
  refreshToken: '',     // steam-session 刷新令牌（可自动续期）
  apiKey: '',           // Steam Web API key（可选，只用于把作者 steamID 换成昵称）
  language: 'schinese',
  timeout: 30000,
  parentApiBase: '',    // 父项目后端地址，例如 http://127.0.0.1:8897
  // Wallpaper Engine 相关路径（"设为使用中"要用）：留空则自动探测 + 只读借用父项目配置
  weDir: '',            // WE 安装目录（含 wallpaper32.exe / config.json）
  wsDir: '',            // 创意工坊内容目录（steamapps/workshop/content/431960）
};

/**
 * 配置文件位置。
 *
 * 默认写在 <项目>/config/settings.json（独立运行时的老行为，行为不变）。
 * 打包成 Electron 后项目目录在 app.asar 里 —— 那是**只读**的，
 * 所以桌面端会在启动时把 WW_CONFIG_DIR 指到 userData 目录，
 * 让"保存设置 / 记住登录态"照常可用。
 */
const CONFIG_DIR = process.env.WW_CONFIG_DIR
  ? path.resolve(process.env.WW_CONFIG_DIR)
  : path.join(PROJECT, 'config');
const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');

/** 读 ~/.dsh/dsh-proxy-win.conf（与父项目相同的约定） */
function readDshProxyConf() {
  const confPath = path.join(os.homedir(), '.dsh', 'dsh-proxy-win.conf');
  const out = { enabled: false, httpsProxy: '', httpProxy: '', noProxy: '' };
  try {
    const lines = fs.readFileSync(confPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (!m) continue;
      const k = m[1];
      const v = m[2].trim();
      if (k === 'PROXY_ENABLED') out.enabled = v === '1';
      else if (k === 'HTTPS_PROXY') out.httpsProxy = v;
      else if (k === 'HTTP_PROXY') out.httpProxy = v;
      else if (k === 'NO_PROXY') out.noProxy = v;
    }
  } catch (e) {
    /* 没有该文件就直连 */
  }
  return out;
}

/** 从父项目的 config/wallpaper/settings.json 里读代理与 Cookie */
function readParentSettings() {
  const out = {
    found: false, dir: '', httpProxy: '', httpsProxy: '', cookie: '', refreshToken: '', steamid: '',
    weDir: '', wsDir: '',
  };
  for (const dir of PARENT_CANDIDATES) {
    const file = path.join(dir, 'config', 'wallpaper', 'settings.json');
    try {
      if (!fs.existsSync(file)) continue;
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      out.found = true;
      out.dir = dir;
      out.httpProxy = j.httpProxy || '';
      out.httpsProxy = j.httpsProxy || '';
      out.cookie = j.steamCookies || '';
      out.refreshToken = j.steamRefreshToken || '';
      out.steamid = j.steamid || '';
      // 父项目本来就有这两个路径（它的"设为桌面壁纸"要用），只读借用
      out.weDir = j.wallpaperEngineDir || '';
      out.wsDir = j.wsDir || '';
      return out;
    } catch (e) {
      /* 试下一个 */
    }
  }
  return out;
}

/** 端口是否已被占用（不能只探测一次，父项目可能后启动） */
function probeParentApi(candidates) {
  const http = require('http');
  return new Promise((resolve) => {
    let pending = candidates.length;
    if (!pending) return resolve('');
    let done = false;
    for (const base of candidates) {
      let url;
      try {
        url = new URL('/wallpaper/api/settings', base);
      } catch (e) {
        if (--pending === 0 && !done) resolve('');
        continue;
      }
      const req = http.get(
        { host: url.hostname, port: url.port, path: url.pathname, timeout: 1200 },
        (res) => {
          res.resume();
          if (!done && res.statusCode >= 200 && res.statusCode < 500) {
            done = true;
            resolve(base);
          } else if (--pending === 0 && !done) resolve('');
        }
      );
      req.on('timeout', () => {
        req.destroy();
        if (--pending === 0 && !done) resolve('');
      });
      req.on('error', () => {
        if (--pending === 0 && !done) resolve('');
      });
    }
  });
}

function normalizeProxy(v) {
  if (!v) return '';
  const s = String(v).trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  return 'http://' + s;
}

let _cache = null;

/** 同步加载配置（不做端口探测，探测结果由 initAsync 补上） */
function loadSettings() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch (e) {
    /* 首次运行 */
  }
  const cfg = Object.assign({}, DEFAULTS, saved);

  // 环境变量覆盖（部署时最方便）
  if (process.env.WW_PORT) cfg.port = parseInt(process.env.WW_PORT, 10) || cfg.port;
  if (process.env.WW_HOST) cfg.host = process.env.WW_HOST;
  if (process.env.WW_PROXY !== undefined) cfg.proxy = process.env.WW_PROXY;
  if (process.env.WW_COOKIE) cfg.cookie = process.env.WW_COOKIE;
  if (process.env.WW_REFRESH_TOKEN) cfg.refreshToken = process.env.WW_REFRESH_TOKEN;
  if (process.env.WW_STEAM_API_KEY) cfg.apiKey = process.env.WW_STEAM_API_KEY;

  // 代理：显式配置 > 环境变量 > 父项目 > dsh 代理配置
  //
  // ⚠️ WW_PROXY 一旦出现（哪怕是空串）就以它为准。
  // 旧实现只看 `if (!cfg.proxy)`，于是 `WW_PROXY=` 这种"我要直连"的明确表态
  // 会被后面的自动探测覆盖掉 —— 用户说直连，程序却偷偷捡了个代理。
  const wwProxyExplicit = process.env.WW_PROXY !== undefined;

  if (!cfg.proxy) {
    const envProxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY;
    if (envProxy) {
      cfg.proxy = normalizeProxy(envProxy);
      cfg.proxySource = 'env';
    } else if (wwProxyExplicit) {
      cfg.proxySource = 'direct';
    } else {
      const parent = readParentSettings();
      const dsh = readDshProxyConf();
      const candidate =
        (parent.found && (parent.httpsProxy || parent.httpProxy)) ||
        (dsh.enabled ? dsh.httpsProxy || dsh.httpProxy : '');
      if (candidate && cfg.proxyAuto) {
        cfg.proxy = normalizeProxy(candidate);
        cfg.proxySource = parent.found && (parent.httpsProxy || parent.httpProxy) ? 'parent' : 'dsh';
      } else {
        cfg.proxySource = 'direct';
      }
    }
  } else {
    cfg.proxy = normalizeProxy(cfg.proxy);
    cfg.proxySource = 'settings';
  }

  /**
   * 用户是否**明确**指定过出口（代理或直连）。
   * 供 initAsync 判断要不要再去做"本机代理端口探测" —— 用户说了算的事不替他改。
   */
  cfg.proxyExplicit = wwProxyExplicit || cfg.proxySource === 'settings' || cfg.proxySource === 'env';

  // Cookie：本项目配置 > 父项目（只读借用）
  let cookieSource = cfg.cookie ? 'settings' : '';
  if (!cfg.cookie) {
    const parent = readParentSettings();
    if (parent.cookie) {
      cfg.cookie = parent.cookie;
      cookieSource = 'parent';
      if (!cfg.refreshToken && parent.refreshToken) cfg.refreshToken = parent.refreshToken;
    }
  }
  cfg.cookieSource = cookieSource || 'none';
  cfg.parent = readParentSettings();

  // Wallpaper Engine / 创意工坊内容目录：本项目配置 > 环境变量 > 父项目配置（只读借用）
  const we = require('./wallpaperEngine');
  if (!cfg.weDir && process.env.WW_WE_DIR) cfg.weDir = process.env.WW_WE_DIR;
  if (!cfg.weDir && cfg.parent.weDir) cfg.weDir = cfg.parent.weDir;
  cfg.weDir = we.detectWeDir(cfg.weDir);
  if (!cfg.wsDir && process.env.WW_WS_DIR) cfg.wsDir = process.env.WW_WS_DIR;
  if (!cfg.wsDir && cfg.parent.wsDir) cfg.wsDir = cfg.parent.wsDir;
  cfg.wsDir = we.detectWsDir(cfg.wsDir);

  return cfg;
}

/**
 * 本机常见代理端口（Clash / Mihomo / v2ray / SS 之类客户端的默认值）。
 * 只探本机回环地址，不对外发探测包。
 */
const LOCAL_PROXY_PORTS = [7890, 7891, 7897, 7899, 10808, 10809, 1080, 8889, 2080, 20171];

/**
 * 探测某个端口上是不是一个**真的能用**的 HTTP 代理。
 *
 * 为什么不只看"端口能不能连上"：任何监听端口都能完成 TCP 握手，
 * 把无关服务误判成代理比不探测更糟（会把请求全导到一个莫名其妙的地方）。
 * 这里发一个**绝对 URI 形式**的 GET —— 这是 HTTP 代理专有的请求形态，
 * 普通 Web 服务器收到会当非法请求，只有代理才认得。拿到任何 HTTP 响应即判定为代理。
 *
 * @returns {Promise<number>} 可用则返回端口号，否则 0
 */
function probeProxyPort(port, timeout) {
  return new Promise((resolve) => {
    const http = require('http');
    let req;
    try {
      req = http.request({
        host: '127.0.0.1',
        port,
        method: 'GET',
        path: 'http://www.gstatic.com/generate_204',
        headers: { Host: 'www.gstatic.com' },
        timeout,
      });
    } catch (e) {
      return resolve(0);
    }
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try {
        req.destroy();
      } catch (e) {
        /* 已销毁 */
      }
      resolve(ok ? port : 0);
    };
    req.on('response', (res) => {
      res.resume();
      finish(true);
    });
    req.on('timeout', () => finish(false));
    req.on('error', () => finish(false));
    req.end();
  });
}

/**
 * 按常见端口并发探测本机代理，返回第一个可用的。
 *
 * 为什么需要这一步：旧版自动探测只看"父项目配置"和 `~/.dsh/dsh-proxy-win.conf`。
 * 实测这两者都不存在时就回退直连 —— 而用户机器上 Clash 明明在 7890 跑着，
 * 结果整个应用在"直连 + DNS 被污染"下彻底连不上，
 * 用户侧看到的是"列表一直转圈、也不报错"。
 *
 * @returns {Promise<{port:number, url:string}|null>}
 */
async function probeLocalProxy() {
  const hits = await Promise.all(LOCAL_PROXY_PORTS.map((p) => probeProxyPort(p, 1500)));
  const ports = hits.filter(Boolean).sort((a, b) => a - b);
  if (!ports.length) return null;
  return { port: ports[0], url: 'http://127.0.0.1:' + ports[0] };
}

/** 带端口探测的异步初始化（在 server 启动时调一次） */
async function initAsync() {
  const cfg = loadSettings();
  if (!cfg.parentApiBase) {
    const bases = PARENT_CANDIDATES.map((d) => 'http://127.0.0.1:8897');
    const found = await probeParentApi(Array.from(new Set(bases)));
    if (found) cfg.parentApiBase = found;
  }

  /*
   * 本机代理探测 —— 只在"确实没配代理、且用户没明确表态"时才做。
   * 放在这里而不是 loadSettings 里：loadSettings 是同步的，做不了网络探测。
   * 探测本身很快（并发 + 1.5s 上限），而且只有直连状态才会走这一步。
   */
  if (!cfg.proxy && cfg.proxyAuto !== false && !cfg.proxyExplicit) {
    const found = await probeLocalProxy();
    if (found) {
      cfg.proxy = found.url;
      cfg.proxySource = 'local-probe';
      console.log('[settings] 未配置代理，但探测到本机代理 ' + found.url + '，已自动启用');
    }
  }

  _cache = cfg;
  return cfg;
}

function getConfig() {
  if (!_cache) _cache = loadSettings();
  return _cache;
}

/** 运行时热更新（改代理 / 注入 Cookie 后不用重启） */
function patchConfig(patch) {
  const cfg = getConfig();
  Object.assign(cfg, patch || {});
  return cfg;
}

function saveSettings(patch) {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch (e) {
    /* ignore */
  }
  const next = Object.assign({}, saved, patch || {});
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

module.exports = {
  ROOT,
  PROJECT,
  SETTINGS_FILE,
  PARENT_CANDIDATES,
  LOCAL_PROXY_PORTS,
  DEFAULTS,
  loadSettings,
  initAsync,
  getConfig,
  patchConfig,
  saveSettings,
  readDshProxyConf,
  readParentSettings,
  probeLocalProxy,
  normalizeProxy,
};
