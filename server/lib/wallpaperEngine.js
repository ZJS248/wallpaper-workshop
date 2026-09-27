'use strict';
/**
 * Wallpaper Engine 控制（官方 CLI 通道）。
 * 文档：https://help.wallpaperengine.io/zh/functionality/cli.html
 *
 *   wallpaper32.exe -control openWallpaper -file <project.json 路径> -monitor 0   ← 设为桌面壁纸（热切换，静默）
 *   wallpaper32.exe -control getWallpaper  -monitor 0                            ← 读当前壁纸（旧版本不支持，回落 config.json）
 *
 * 两个实测坑（都是父项目 HTML-website 踩过、这里照搬结论）：
 *   1. 必须把命令发给**正在运行的那个** exe（32 位版还是 64 位版取决于用户），发错会拉起第二个实例。
 *   2. WE 命令行按 ANSI 解析 argv，**中文路径会乱码**导致黑屏；所以非 ASCII 路径先建一个
 *      纯 ASCII 的 junction 镜像再传进去。
 *
 * 零依赖：只用 node 内置模块（fs / path / child_process），和本项目其它部分一致。
 */

const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const os = require('os');
const httpClient = require('./httpClient');

/* ------------------------------ 路径探测 ------------------------------ */

const WE_DIR_CANDIDATES = [
  'E:/SteamLibrary/steamapps/common/wallpaper_engine',
  'C:/Program Files (x86)/Steam/steamapps/common/wallpaper_engine',
  'C:/SteamLibrary/steamapps/common/wallpaper_engine',
  'D:/SteamLibrary/steamapps/common/wallpaper_engine',
  'F:/SteamLibrary/steamapps/common/wallpaper_engine',
];

const WS_DIR_CANDIDATES = [
  'E:/SteamLibrary/steamapps/workshop/content/431960',
  'C:/Program Files (x86)/Steam/steamapps/workshop/content/431960',
  'C:/SteamLibrary/steamapps/workshop/content/431960',
  'D:/SteamLibrary/steamapps/workshop/content/431960',
  'F:/SteamLibrary/steamapps/workshop/content/431960',
];

function looksLikeWeDir(dir) {
  try {
    return (
      !!dir &&
      fs.existsSync(path.join(dir, 'config.json')) &&
      (fs.existsSync(path.join(dir, 'wallpaper32.exe')) || fs.existsSync(path.join(dir, 'wallpaper64.exe')))
    );
  } catch (e) {
    return false;
  }
}

function looksLikeWsDir(dir) {
  try {
    return !!dir && fs.existsSync(dir);
  } catch (e) {
    return false;
  }
}

/** WE 安装目录：显式配置 → 候选路径 → 从 workshop 目录反推 */
function detectWeDir(explicit) {
  if (looksLikeWeDir(explicit)) return explicit;
  for (const c of WE_DIR_CANDIDATES) if (looksLikeWeDir(c)) return c;
  return '';
}

/** 创意工坊内容目录：显式配置 → 候选路径 */
function detectWsDir(explicit) {
  if (looksLikeWsDir(explicit)) return explicit;
  for (const c of WS_DIR_CANDIDATES) if (looksLikeWsDir(c)) return c;
  return '';
}

/* ------------------------------ CLI 通道 ------------------------------ */

/**
 * 正在运行的 WE 进程列表。
 *
 * 为什么要两种办法：`tasklist` 在受限账号 / 沙箱里会直接"错误: 拒绝访问"（实测），
 * 那时**不能据此判定"WE 没在运行"**（用户报过："后台明明运行着"）。
 * PowerShell 的 Get-Process 在同一环境下是好的，所以：
 *   tasklist 成功 → 以它为准（快）
 *   tasklist 被拒 → 用 PowerShell 再看一次
 *   两种都失败 → known=false（"探测不到"，不是"没运行"）
 */
let procCache = { at: 0, names: [], known: false, method: '' };

/**
 * 异步执行一个命令（**绝不能用 spawnSync**）。
 *
 * 血泪教训：`/api/we/state` 里原来是 spawnSync —— 它会阻塞 Node 的整个事件循环。
 * 这里一次要跑 PowerShell（启动 2~8 秒），于是每次查状态都把服务器**冻住 8 秒**：
 * 列表、筛选、订阅接口全排在它后面，用户看到的就是"browse 1.8 分钟还没出来"。
 */
function execFileAsync(cmd, args, opts) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    let child;
    try {
      child = cp.execFile(cmd, args, Object.assign({ windowsHide: true, encoding: 'utf8' }, opts || {}),
        (err, stdout, stderr) => {
          finish({ status: err ? (err.code === undefined ? 1 : err.code) : 0, stdout: stdout || '', stderr: stderr || '', error: err || null });
        });
    } catch (e) {
      return finish({ status: 1, stdout: '', stderr: '', error: e });
    }
    if (opts && opts.timeoutMs) {
      setTimeout(() => {
        if (!done && child) {
          try { child.kill(); } catch (e) { /* ignore */ }
          finish({ status: 1, stdout: '', stderr: '', error: new Error('timeout') });
        }
      }, opts.timeoutMs + 500);
    }
  });
}

/** 进程探测的缓存时长：状态接口会频繁调用，20 秒内复用同一份结果 */
const PROC_CACHE_MS = 20 * 1000;

async function listWeProcesses() {
  if (procCache.at && Date.now() - procCache.at < PROC_CACHE_MS) return procCache;
  const found = new Set();
  let known = false;
  let method = '';
  const addName = (n) => {
    const name = String(n || '').trim().toLowerCase();
    if (/^wallpaper32(\.exe)?$/.test(name)) found.add('wallpaper32.exe');
    if (/^wallpaper64(\.exe)?$/.test(name)) found.add('wallpaper64.exe');
  };

  try {
    const r = await execFileAsync('tasklist', ['/FO', 'CSV', '/NH'], { timeout: 8000 });
    const out = String(r.stdout || '');
    if (r.status === 0 && out.trim()) {
      known = true;
      method = 'tasklist';
      out.split(/\r?\n/).forEach((line) => {
        const m = line.match(/^"([^"]+)"/);
        if (m) addName(m[1]);
      });
    }
  } catch (e) {
    /* 试下一种 */
  }

  if (!known) {
    try {
      const r = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command',
          "Get-Process -Name 'wallpaper*' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty ProcessName"],
        { timeout: 15000 }
      );
      if (r.status === 0) {
        // 退出码 0 说明"能枚举"：没有匹配时输出为空 = 确实没在运行
        known = true;
        method = 'powershell';
        String(r.stdout || '').split(/\r?\n/).forEach(addName);
      }
    } catch (e) {
      /* 都失败 */
    }
  }

  procCache = { at: Date.now(), names: Array.from(found), known: known, method: method };
  return procCache;
}

/** 正在运行的 WE 主进程名（必须发给它，否则会拉起第二个实例） */
async function detectRunningExe() {
  const info = await listWeProcesses();
  if (info.names.indexOf('wallpaper32.exe') >= 0) return 'wallpaper32.exe';
  if (info.names.indexOf('wallpaper64.exe') >= 0) return 'wallpaper64.exe';
  return null;
}

/** 猜一个 exe（探测不到进程时的兜底：优先 64 位） */
function guessExe(weDir) {
  return fs.existsSync(path.join(weDir, 'wallpaper64.exe')) ? 'wallpaper64.exe' : 'wallpaper32.exe';
}

/**
 * 通过**父项目后端**设置壁纸（HTML-website 的 /wallpaper/api/we/set-wallpaper）。
 *
 * 为什么需要这条兜底：我们和父项目用的是同一套 CLI 实现，但"谁来 spawn 那个进程"很关键。
 * 本项目自己（尤其跑在受限沙箱里时）发命令会撞 CEF 单实例锁（Lock file can not be created!
 * Error code: 5），而父项目后端跑在正常用户上下文里，同一条命令是成功的
 * （实测：POST http://127.0.0.1:8897/wallpaper/api/we/set-wallpaper → ok:true）。
 * 所以 CLI 失败时，转交父项目后端再试一次。
 */
async function setWallpaperViaParentApi(base, id, monitor, proxy) {
  if (!base) return { ok: false, error: '没有探测到父项目后端' };
  const url = String(base).replace(/\/+$/, '') + '/wallpaper/api/we/set-wallpaper';
  try {
    const r = await httpClient.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: String(id), monitor: Number(monitor) || 0 }),
      timeout: 30000,
      proxy: proxy || '',
      noLimit: true,
    });
    let json = null;
    try { json = JSON.parse(r.body || ''); } catch (e) { /* 非 JSON */ }
    if (r.status === 200 && json && json.ok !== false) {
      return { ok: true, message: (json && json.message) || '已设为桌面壁纸（经父项目后端）', viaParent: true };
    }
    return { ok: false, error: (json && (json.message || json.error)) || ('父项目后端返回 HTTP ' + r.status) };
  } catch (e) {
    return { ok: false, error: '请求父项目后端失败：' + e.message };
  }
}

async function sendControl(weDir, args, opts) {
  const dry = !!(opts && opts.dryRun);
  const exe = dry
    ? guessExe(weDir)
    : (opts && opts.exe) || (await detectRunningExe());
  if (!exe) {
    const info = await listWeProcesses();
    if (!info.known) {
      // 枚举进程本身失败 —— 不能说"没在运行"，只能如实说"探测不到"
      return {
        ok: false,
        needForce: true,
        error: '探测不到 Wallpaper Engine 进程（本机枚举进程被拒绝访问）。如果它确实开着，可以让程序按 64/32 位顺序直接试一次。',
      };
    }
    return { ok: false, error: 'Wallpaper Engine 没在运行，先在 Steam 里启动它' };
  }
  const exePath = path.join(weDir, exe);
  const argv = ['-control'].concat(args);
  if (dry) return { ok: true, dryRun: true, cmd: exePath + ' ' + argv.join(' ') };
  // 异步执行（绝不 spawnSync）：WE 是 GUI 程序，常常不回执，超时就当"已发送"由上层复核
  const r = await execFileAsync(exePath, argv, { timeout: (opts && opts.timeoutMs) || 8000 });
  if (r.error) {
    if (r.error.message === 'timeout') return { ok: false, timeout: true, error: '命令进程没在超时内退出' };
    return { ok: false, error: '发送命令失败：' + r.error.message };
  }
  if (r.status !== 0) {
    const errText = String(r.stderr || '') + String(r.stdout || '');
    /*
     * CEF 单实例锁失败：说明这次启动的是一个"新实例"，它没能把命令交给正在运行的那个
     * （报错原文：Lock file can not be created! Error code: 5 / Failed to create a ProcessSingleton）。
     * 常见原因是权限/隔离不同（受限进程、以管理员运行的 WE、或本项目跑在沙箱里）。
     * 这种情况要给出可操作的建议，而不是把 CEF 的堆栈原样丢给用户。
     */
    if (/process_singleton|ProcessSingleton|profile corruption|CefCurrentlyOn/i.test(errText)) {
      return {
        ok: false,
        cefBlocked: true,
        error: '命令行没能把命令交给正在运行的 Wallpaper Engine（CEF 单实例锁创建失败：这次启动的进程权限/环境与正在运行的 WE 不一致）。' +
          '把本服务放在你自己的终端里运行（或直接用打包后的桌面版）再点一次即可；WE 侧不用改任何设置。',
      };
    }
    return {
      ok: false,
      error: 'WE 命令失败（退出码 ' + r.status + '）' + (errText.trim() ? '：' + errText.trim().split('\n')[0].slice(0, 140) : ''),
    };
  }
  return { ok: true, stdout: String(r.stdout || '').trim() };
}

/** 只读 config.json 拿当前每个显示器的壁纸（不 spawn 任何进程） */
function readCurrentFromConfig(weDir) {
  try {
    const cfg = readWeConfig(weDir);
    const user = userSection(cfg) || {};
    const swp = (user.general && user.general.wallpaperconfig && user.general.wallpaperconfig.selectedwallpapers) || {};
    const out = {};
    Object.keys(swp).forEach((k) => {
      const f = swp[k] && swp[k].file;
      if (typeof f === 'string') out[k] = { file: f, id: idFromFile(f) };
    });
    return out;
  } catch (e) {
    return null;
  }
}

/* ------------------------------ 读状态 ------------------------------ */

function readWeConfig(weDir) {
  const p = path.join(weDir, 'config.json');
  let raw = fs.readFileSync(p, 'utf8');
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  return JSON.parse(raw);
}

/** WE 的 config.json 里用户段：第一个非 '?' 开头、带 general 的键 */
function userSection(cfg) {
  for (const k of Object.keys(cfg)) {
    if (k.startsWith('?')) continue;
    if (cfg[k] && cfg[k].general) return cfg[k];
  }
  return null;
}

/** 从壁纸文件路径里抠出作品 id（workshop 目录就是用 id 命名的） */
function idFromFile(file) {
  const m = String(file || '').match(/[\\/]([^\\/]+)[\\/][^\\/]+\.(?:pkg|json|mp4|webm|gif|jpg|jpeg|png|webp|html)$/i);
  return m ? m[1] : null;
}

/**
 * 当前每个显示器的壁纸。
 *
 * ⚠️ 默认**只读 config.json**，不 spawn 任何进程：
 * WE 切换壁纸后会写盘，config 足够准；而 `-control getWallpaper` 要把 wallpaper 进程
 * 再拉起来一次（GUI 程序经常不回执），既慢又会阻塞 —— 这就是"查个状态要 8 秒"的元凶。
 * 需要"实时"值时显式传 { live: true }（目前没有调用方用它）。
 */
async function getCurrent(weDir, opts) {
  if (!weDir || !fs.existsSync(path.join(weDir, 'config.json'))) {
    return { ok: false, error: '没找到 WE 的 config.json（安装目录可能不对）', monitors: [] };
  }
  const monitors = [];
  try {
    const cfg = readWeConfig(weDir);
    const user = userSection(cfg) || {};
    const swp = (user.general && user.general.wallpaperconfig && user.general.wallpaperconfig.selectedwallpapers) || {};
    const keys = Object.keys(swp).filter((k) => /^Monitor\d+$/.test(k));
    const count = Math.max(1, keys.length);
    if (opts && opts.live) {
      for (let i = 0; i < count; i++) {
        const r = await sendControl(weDir, ['getWallpaper', '-monitor', String(i)]);
        if (r.ok && r.stdout) {
          monitors.push({ key: 'Monitor' + i, file: r.stdout, id: idFromFile(r.stdout), live: true });
        }
      }
    }
    if (!monitors.length) {
      for (const key of keys) {
        const f = swp[key] && swp[key].file;
        if (typeof f === 'string') monitors.push({ key: key, file: f, id: idFromFile(f), live: false });
      }
    }
  } catch (e) {
    return { ok: false, error: '解析 WE 配置失败：' + e.message, monitors: [] };
  }
  return { ok: true, monitors: monitors, weDir: weDir };
}

/* ------------------------------ 设为使用中 ------------------------------ */

/** 选 -file 参数：project.json（官方推荐）> scene.pkg/json > 媒体文件 > index.html */
function pickControlFile(dir) {
  let files = [];
  try {
    files = fs.readdirSync(dir);
  } catch (e) {
    return null;
  }
  if (files.includes('project.json')) return path.join(dir, 'project.json');
  const scene = files.find((f) => /^scene\.(pkg|json)$/i.test(f));
  if (scene) return path.join(dir, scene);
  const media = files.find((f) => /\.(mp4|webm|gif|jpg|jpeg|png|webp)$/i.test(f));
  if (media) return path.join(dir, media);
  if (files.includes('index.html')) return path.join(dir, 'index.html');
  return null;
}

/**
 * 中文/非 ASCII 路径 → 纯 ASCII 的 junction 镜像。
 * WE 命令行按 ANSI 解析 argv，中文会乱码（实测写盘成了乱码字符 → 黑屏）。
 */
async function toAsciiPath(file) {
  if (/^[\x00-\x7f]+$/.test(file)) return file;
  try {
    const dir = path.dirname(file);
    const base = path.basename(file);
    const slug = 'wp_' + Buffer.from(dir, 'utf8').toString('hex').slice(0, 20);
    const roots = [path.join(path.parse(dir).root, 'we_control_mirror'), path.join(os.tmpdir(), 'we_control_mirror')];
    for (const mirrorRoot of roots) {
      try {
        fs.mkdirSync(mirrorRoot, { recursive: true });
        const link = path.join(mirrorRoot, slug);
        if (!fs.existsSync(link)) {
          const cmd = "New-Item -ItemType Junction -Path '" + link + "' -Target '" + dir + "' | Out-Null";
          const r = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', cmd], { timeout: 15000 });
          if (r.status !== 0) continue;
        }
        return path.join(link, base).replace(/\\/g, '/');
      } catch (e) {
        continue;
      }
    }
  } catch (e) {
    /* 退回原路径 */
  }
  return file;
}

/**
 * 设为桌面壁纸（使用中）。
 * @param {object} o { weDir, wsDir, id, monitor, dryRun }
 */
async function setWallpaper(o) {
  const weDir = o.weDir;
  const id = String(o.id || '').replace(/[^0-9]/g, '');
  if (!id) return { ok: false, error: '缺少作品 id' };
  if (!looksLikeWeDir(weDir)) return { ok: false, error: '没找到 Wallpaper Engine 安装目录' };
  const dir = path.join(o.wsDir || '', id);
  if (!o.wsDir || !fs.existsSync(dir)) {
    return {
      ok: false,
      error: '本地还没有这个壁纸的文件夹（订阅后要等 Steam 下载完），当前目录：' + (o.wsDir || '未配置'),
    };
  }
  const file = pickControlFile(dir);
  if (!file) return { ok: false, error: '这个壁纸目录里没有 project.json / scene 文件，WE 加载不了' };
  const mIdx = Number.isInteger(o.monitor) && o.monitor >= 0 ? o.monitor : 0;
  const args = ['openWallpaper', '-file', await toAsciiPath(file), '-monitor', String(mIdx)];
  let r = await sendControl(weDir, args, o);
  // 探测不到进程但用户确认"它就是开着" → 按 64/32 位顺序直接试一次
  if (!r.ok && r.needForce && o.force) {
    r = await sendControl(weDir, args, Object.assign({}, o, { exe: guessExe(weDir) }));
  }
  /*
   * 自己发命令失败（CEF 单实例锁 / 权限 / 超时）→ 转交父项目后端再试一次。
   * 同一套代码，父项目跑在正常用户上下文里就能成功（实测），这条兜底让我们即使跑在
   * 受限环境里也能把"设为使用中"办成。
   */
  if (!r.ok && o.parentApiBase) {
    const viaParent = await setWallpaperViaParentApi(o.parentApiBase, id, mIdx, o.proxy);
    if (viaParent.ok) {
      return {
        ok: true,
        verified: true,
        viaParent: true,
        file: file,
        monitor: mIdx,
        message: viaParent.message + '（本项目进程发不了 WE 命令，已转交父项目后端）',
      };
    }
    r = Object.assign({}, r, { parentError: viaParent.error });
  }
  /*
   * 复核：命令行进程超时（GUI 程序有时不乖乖退出）不等于没生效 ——
   * WE 切换成功会把结果写回 config.json，所以直接回读一次来判断。
   */
  let verified = false;
  for (let i = 0; i < 6 && !verified; i++) {
    const cur = readCurrentFromConfig(weDir);
    if (cur) {
      const key = 'Monitor' + mIdx;
      verified = !!(cur[key] && String(cur[key].id) === id) ||
        Object.keys(cur).some((k) => String(cur[k].id) === id && mIdx === 0);
    }
    if (!verified) await new Promise((res) => setTimeout(res, 500));
  }

  if (!r.ok) {
    if (verified) {
      return {
        ok: true,
        verified: true,
        file: file,
        monitor: mIdx,
        message: '已设为桌面壁纸',
      };
    }
    return r;
  }
  return {
    ok: true,
    dryRun: !!r.dryRun,
    verified: verified,
    note: verified ? '' : '命令已发送；WE 若没立即切换，稍等一下或重开一次',
    cmd: r.cmd || '',
    file: file,
    monitor: mIdx,
    message: '已设为桌面壁纸（WE 热切换，不需要重启）',
  };
}

/**
 * 已订阅项目的清单（含"订阅时间"）。
 *
 * 「订阅时间」按 wallpaper-manager 的算法：**取该项目文件夹的创建时间**（birthtime）——
 * 那是真正下载/订阅的时刻，和 WE 客户端的"订阅日期"排序同源；
 * 拿不到（某些文件系统不记 birthtime）就用 ACF 里的 timeupdated 兜底。
 *
 * 为什么不用 Steam 订阅页的日期：那个页面要 Cookie 且每次都得爬 30 条/页，
 * 本地读目录是毫秒级、还不需要登录。
 */
function listSubscribed(wsDir) {
  const lib = listLocalLibrary(wsDir);
  const acfTimes = readAcfTimes(wsDir);          // { id: { timeupdated, size } }
  const out = [];
  lib.installed.forEach((id) => {
    let birth = 0;
    try {
      birth = fs.statSync(path.join(wsDir, id)).birthtimeMs || 0;
    } catch (e) {
      birth = 0;
    }
    const acf = acfTimes[id] || {};
    const timeMs = Math.round(birth) || (Number(acf.timeupdated) ? Number(acf.timeupdated) * 1000 : 0);
    out.push({
      id: id,
      subscribedAt: timeMs,
      // 新版 Steam 的 ACF 用 BytesDownloaded/BytesToDownload，老版才是 size
      size: Number(acf.BytesDownloaded || acf.BytesToDownload || acf.size) || 0,
      installed: true,
    });
  });
  return out;
}

/** 读 ACF 里每个项目的 timeupdated / size（失败就返回空表） */
let acfCache = { at: 0, dir: '', value: {} };
function readAcfTimes(wsDir) {
  if (!wsDir) return {};
  if (acfCache.dir === wsDir && Date.now() - acfCache.at < 30 * 1000) return acfCache.value;
  const out = {};
  try {
    // ACF 在 steamapps/workshop/ 下，而内容目录是 .../workshop/content/431960 → 往上两层
    const acf = path.join(path.dirname(path.dirname(wsDir)), 'appworkshop_431960.acf');
    if (fs.existsSync(acf)) {
      const text = fs.readFileSync(acf, 'utf8');
      const block = text.slice(text.indexOf('"WorkshopItemsInstalled"'));
      const re = /"(\d+)"\s*\{([^{}]*)\}/g;
      let m;
      while ((m = re.exec(block))) {
        const fields = {};
        const kv = /"([A-Za-z0-9_]+)"\s+"([^"]*)"/g;
        let f;
        while ((f = kv.exec(m[2]))) fields[f[1]] = f[2];
        out[m[1]] = fields;
      }
    }
  } catch (e) {
    /* 读不到就只用文件夹时间 */
  }
  acfCache = { at: Date.now(), dir: wsDir, value: out };
  return out;
}

/**
 * 本地创意工坊库。
 *
 *   installed  = <wsDir>/<id>/ 目录存在的（= 订阅并已下载完成，WE 才能加载它）
 *   subscribed = appworkshop_431960.acf 里的条目（订阅了但可能还没下载完）
 *
 * 这份数据的意义：
 *   1. 「设为使用中」只对 installed 里的作品开放 —— 没订阅/没下载的根本没有本地文件，
 *      以前按钮是亮的，点了才报错；
 *   2. 订阅角标（✓ 已订阅）在 Steam Cookie 失效时也照样能显示，不必等 /api/subscribed-ids。
 */
function listLocalLibrary(wsDir) {
  const out = { installed: [], subscribed: [], wsDir: wsDir || '', error: '' };
  if (!wsDir) {
    out.error = '没找到创意工坊内容目录（steamapps/workshop/content/431960）';
    return out;
  }
  try {
    fs.readdirSync(wsDir, { withFileTypes: true }).forEach((e) => {
      if (e.isDirectory() && /^\d{6,}$/.test(e.name)) out.installed.push(e.name);
    });
  } catch (e) {
    out.error = '读取创意工坊目录失败：' + e.message;
    return out;
  }
  // ACF 在 workshop 目录的上一级：appworkshop_<appid>.acf，条目形如 "3808250076" { ... }
  try {
    // 路径：wsDir = steamapps/workshop/content/431960 → ACF 在 steamapps/workshop/ 下
    const acf = path.join(path.dirname(path.dirname(wsDir)), 'appworkshop_431960.acf');
    if (fs.existsSync(acf)) {
      const text = fs.readFileSync(acf, 'utf8');
      const re = /"(\d{9,})"\s*\{/g;
      const set = new Set(out.installed);
      let m;
      while ((m = re.exec(text))) {
        if (m[1] !== '431960') set.add(m[1]);
      }
      out.subscribed = Array.from(set);
    }
  } catch (e) {
    /* 读不到 acf 就只用目录列表 */
  }
  if (!out.subscribed.length) out.subscribed = out.installed.slice();
  return out;
}

/** 汇总状态给前端：路径 + 是否在跑 + 当前使用中的 id + 本地库 */
/** 本地库（目录 + acf）的缓存：读盘很快，但没必要每秒读 */
let localCache = { at: 0, wsDir: '', value: null };
const LOCAL_CACHE_MS = 30 * 1000;

function cachedLocalLibrary(wsDir) {
  if (localCache.value && localCache.wsDir === wsDir && Date.now() - localCache.at < LOCAL_CACHE_MS) {
    return localCache.value;
  }
  const v = listLocalLibrary(wsDir);
  localCache = { at: Date.now(), wsDir: wsDir, value: v };
  return v;
}

async function status(o) {
  const weDir = detectWeDir(o && o.weDir);
  const wsDir = detectWsDir(o && o.wsDir);
  const local = cachedLocalLibrary(wsDir);
  const proc = await listWeProcesses();
  const runningExe = proc.names.indexOf('wallpaper32.exe') >= 0
    ? 'wallpaper32.exe'
    : (proc.names.indexOf('wallpaper64.exe') >= 0 ? 'wallpaper64.exe' : null);
  // running: true=在跑 / false=确实没跑 / null=枚举不到（不是"没运行"）
  const running = runningExe ? true : (proc.known ? false : null);
  const cur = weDir
    ? (readCurrentFromConfig(weDir) || {})
    : {};
  const monitors = cur.monitors || [];
  const ids = Array.from(new Set(Object.keys(cur).map((k) => cur[k] && cur[k].id).filter(Boolean)));
  return {
    ok: !!weDir,
    weDir: weDir,
    wsDir: wsDir,
    running: running,
    runningExe: runningExe || '',
    detectMethod: proc.method,
    detectKnown: proc.known,
    available: !!(weDir && wsDir),
    monitors: Object.keys(cur).map((k) => ({ key: k, file: cur[k].file, id: cur[k].id, live: false })),
    currentIds: ids,
    installed: local.installed,
    localSubscribed: local.subscribed,
    localError: local.error,
    error: weDir ? '' : '没找到 Wallpaper Engine 安装目录（可在 config/settings.json 里配 weDir）',
  };
}

module.exports = {
  detectWeDir,
  detectWsDir,
  detectRunningExe,
  getCurrent,
  setWallpaper,
  status,
  listLocalLibrary,
  listSubscribed,
  readAcfTimes,
  pickControlFile,
  idFromFile,
};
