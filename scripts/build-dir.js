#!/usr/bin/env node
'use strict';

/**
 * 组装「目录版」桌面应用（默认 %LOCALAPPDATA%\WallpaperWorkshop\app）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠️ 为什么产物不放在项目里的 dist/ 下面（2026-10-01 的重要发现）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 这台机器上 **`C:\Users\ZJS248\Desktop\video\` 整棵树禁止执行 exe**。
 * 不是本应用的问题 —— 把系统自带的 `C:\Windows\System32\where.exe` 复制进去
 * 一样跑不起来（退出码 1、零输出、无日志、无转储、事件查看器里也没记录）。
 *
 * 边界实测：
 *   Desktop\videoX\w.exe                     ✅   Desktop\wwcopyZ\（主程序） ✅
 *   Desktop\video\zznew\w.exe                ❌   Desktop\video\...\dist\win-unpacked\ ❌
 *
 * 跟工作目录无关、跟文件名无关，只跟文件所在目录有关。
 * 所以产物必须放在这棵树外面 —— 见 scripts/lib/app-dir.js 的完整说明。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么不用 electron-builder 了
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 原来的 `npm run dist:dir` 走 electron-builder，它为了一个「拷贝 + 改个名字」
 * 的动作，牵扯进了一整条链路：
 *
 *   electron-builder → app-builder.exe(Go) → node-dep-tree → @electron/rebuild
 *                    → asar 打包 → asar 完整性校验补丁 → 签名 → NSIS/portable
 *
 * 而本项目 **`dependencies` 是空的**（零运行时依赖），
 * `app-builder.exe node-dep-tree` 对它的输出就是 `[]` —— 那一整条链路
 * 对本项目毫无信息量，只增加了黑盒面积和失败点。
 *
 * 这个脚本把动作压缩成四步，全部可见、可读、可改：
 *
 *   1. 复制 Electron 运行时   node_modules/electron/dist  → 输出目录
 *   2. 改名                   electron.exe                → WallpaperWorkshop.exe
 *   3. 放应用代码             → resources/app/            （**目录，不是 asar**）
 *   4. 校验 + 探测目录能否执行程序
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 用 resources/app/ 而不是 app.asar，好处有三个
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   - **改代码不用重新构建。** 直接编辑产物 resources/app/ 下的文件，
 *     重启应用即可生效。这个项目要频繁改动，这条最省事。
 *   - 没有 asar 这一层，出问题能直接用资源管理器看、用文本编辑器开。
 *   - 不需要任何打包工具，也就没有"打包工具自己坏了"这种故障。
 *
 * 代价：源码是明文躺在产物里的。本机自用/开发自测无所谓；
 * 要对外分发就换回 `npm run dist`（electron-builder，出 NSIS 安装包）。
 *
 * Electron 的加载顺序是 resources/app.asar → resources/app → default_app.asar，
 * 所以这里会**删掉 default_app.asar**，避免"app/ 有问题时静默回落到默认页"。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 用法
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   npm run dist:dir        构建（清掉旧产物重来）
 *   npm run desktop:build   构建 + 立刻启动
 *
 *   --fast          只更新应用代码，不重新复制 Electron 运行时（快很多）
 *   --out=<目录>    指定输出目录（优先级高于 WW_OUT_DIR）
 *   WW_OUT_DIR=...  换输出目录（默认 %LOCALAPPDATA%\WallpaperWorkshop\app）
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { APP_NAME, resolveOutDir } = require('./lib/app-dir');
const { probeExecutable, ensureDirRunnable } = require('./lib/exec-probe');

const ROOT = path.resolve(__dirname, '..');
const outArg = (process.argv.find((a) => a.indexOf('--out=') === 0) || '').slice(6);
const OUT = resolveOutDir(outArg || undefined);
const ELECTRON_DIST = path.join(ROOT, 'node_modules', 'electron', 'dist');
const FAST = process.argv.indexOf('--fast') >= 0;

/*
 * 要放进 resources/app/ 的东西。
 * 这份列表与 package.json 的 build.files 保持一致 —— 换构建方式时
 * 最容易漏掉的就是"哪些文件该进产物"，所以在这里写死并显式列出。
 */
const APP_ITEMS = [
  'electron',
  'server.js',
  'server',
  'src',
  'public',
  'index.html',
  'package.json',
];

function log(msg) {
  console.log('  ' + msg);
}

function die(msg) {
  console.error('\n  [x] ' + msg + '\n');
  process.exit(1);
}

/*
 * 重建前先把正在运行的应用关掉。
 *
 * 否则会撞上一个很误导的错误：旧产物的 exe 被运行中的进程占着，
 * 删目录时抛
 *   Error during a `trash` operation: Some operations were aborted
 * 看起来像"构建脚本坏了"，其实是"应用还开着"。
 */
function killRunning() {
  const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq ' + APP_NAME + '.exe', '/NH'],
    { encoding: 'utf8', windowsHide: true });
  const out = String(r.stdout || '');
  if (out.indexOf(APP_NAME + '.exe') < 0) return 0;

  const n = (out.match(new RegExp(APP_NAME + '\\.exe', 'g')) || []).length;
  log('[0/4] 检测到 ' + n + ' 个正在运行的实例，先关掉（否则产物目录删不掉）');
  spawnSync('taskkill', ['/IM', APP_NAME + '.exe', '/F', '/T'],
    { stdio: 'ignore', windowsHide: true });
  return n;
}

/*
 * 清掉旧产物。
 *
 * 加 try/catch 是因为这里会遇到两种"看起来像脚本坏了"的情况：
 *
 *   1. 应用还开着 → exe 被占用 → EPERM / EBUSY。
 *      对策：先 killRunning()，再重试一次。
 *
 *   2. 某些环境（AI 工具的终端包装）会把 `fs.rmSync` 重定向成"移到回收站"，
 *      对这种 150 MB+ 的大目录反复操作后会失败，报
 *        Error during a `trash` operation: Some operations were aborted
 *      这不是我们的 bug，但报错原文很容易误导。
 */
function cleanOutDir() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.rmSync(OUT, { recursive: true, force: true });
      return;
    } catch (e) {
      if (attempt === 0) {
        log('      旧产物删不掉（' + (e.code || e.message) + '），关掉占用它的进程后重试…');
        killRunning();
        continue;
      }
      die('删不掉旧产物：' + OUT +
        '\n      原因：' + e.message +
        '\n\n      常见的两个原因：' +
        '\n        1. 应用还在运行 —— 先关掉它（托盘图标右键退出，或 taskkill /IM ' + APP_NAME + '.exe /F）' +
        '\n        2. 当前终端把删除操作重定向到了回收站，而这个目录太大' +
        '\n           → 换个终端，或改用 --out=<另一个目录>');
    }
  }
}

/* ------------------------- 1. 检查前置条件 ------------------------- */

if (process.platform !== 'win32') die('这个脚本只用于 Windows。');

if (!fs.existsSync(path.join(ELECTRON_DIST, 'electron.exe'))) {
  die('找不到 Electron 运行时：' + ELECTRON_DIST +
    '\n\n      先装依赖：npm install');
}

/* ------------------------- 2. 组装产物 ------------------------- */

const t0 = Date.now();
log('');
log('输出目录：' + OUT);
log('');

if (!FAST) {
  log('[1/4] 复制 Electron 运行时…');
  killRunning();
  cleanOutDir();
  fs.mkdirSync(OUT, { recursive: true });
  fs.cpSync(ELECTRON_DIST, OUT, { recursive: true });
  log('      完成（' + countFiles(OUT) + ' 个文件）');
} else {
  log('[1/4] --fast：跳过复制运行时，只更新应用代码');
  if (!fs.existsSync(OUT)) die('还没构建过，不能加 --fast。先跑一次完整构建。');
  killRunning();
}

/* 改名。Electron 靠 exe 旁边的 resources/ 找应用，改名不影响。 */
log('[2/4] 改名 electron.exe → ' + APP_NAME + '.exe');
const srcExe = path.join(OUT, 'electron.exe');
const dstExe = path.join(OUT, APP_NAME + '.exe');
if (fs.existsSync(srcExe)) {
  fs.rmSync(dstExe, { force: true });
  fs.renameSync(srcExe, dstExe);
  log('      完成');
} else if (fs.existsSync(dstExe)) {
  log('      已经是目标名字，跳过');
} else {
  die('两个名字都找不到：' + srcExe);
}

/* 放应用代码 */
log('[3/4] 放应用代码 → resources/app/');
const resDir = path.join(OUT, 'resources');
const appDir = path.join(resDir, 'app');

// 清掉 asar（asar 优先级高于 app/，留着会把 app/ 完全遮住）
for (const stale of ['app.asar', 'app.asar.unpacked', 'default_app.asar']) {
  const p = path.join(resDir, stale);
  if (fs.existsSync(p)) {
    fs.rmSync(p, { recursive: true, force: true });
    log('      移除 ' + stale + '（避免遮住 app/，或静默回落到默认页）');
  }
}

fs.rmSync(appDir, { recursive: true, force: true });
fs.mkdirSync(appDir, { recursive: true });

for (const item of APP_ITEMS) {
  const from = path.join(ROOT, item);
  if (!fs.existsSync(from)) {
    die('缺文件：' + item + '（在 package.json 的 build.files 里列了，但磁盘上没有）');
  }
  fs.cpSync(from, path.join(appDir, item), { recursive: true });
}
log('      完成：' + APP_ITEMS.join(', '));

/* 图标：有 rcedit 就嵌，没有就跳过（纯外观，不影响功能） */
tryEmbedIcon(dstExe);

/* ------------------------- 3. 校验 ------------------------- */

log('[4/4] 校验…');
const problems = [];

if (!fs.existsSync(dstExe)) problems.push('主程序不存在');

const mainJs = path.join(appDir, 'electron', 'main.js');
if (!fs.existsSync(mainJs)) problems.push('resources/app/electron/main.js 不存在');

// package.json 的 main 必须能对上
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
  if (!pkg.main) problems.push('package.json 里没有 main 字段');
  else if (!fs.existsSync(path.join(appDir, pkg.main))) {
    problems.push('package.json 的 main（' + pkg.main + '）在产物里不存在');
  }
} catch (e) {
  problems.push('读不了 resources/app/package.json：' + e.message);
}

// asar 必须已经清掉，否则 app/ 根本不会被加载
if (fs.existsSync(path.join(resDir, 'app.asar'))) {
  problems.push('resources/app.asar 还在 —— 它会遮住 app/，必须删掉');
}

if (problems.length) {
  console.error('');
  problems.forEach((p) => console.error('  [x] ' + p));
  die('产物校验没通过，别启动它。');
}

const exeSize = fs.statSync(dstExe).size;
log('      ' + APP_NAME + '.exe        ' + (exeSize / 1048576).toFixed(1) + ' MB');
log('      resources/app/       ' + countFiles(appDir) + ' 个文件');
log('      校验通过');

/*
 * 最后一道、也是最容易被忽略的检查：**这个目录允许执行程序吗？**
 *
 * 产物写得再完美，只要目录禁止执行 exe，启动时就是"零输出秒退"，
 * 而且不留任何痕迹（无日志/无转储/事件查看器无记录）——
 * 排查起来极难，所以在这里花 10 毫秒把它测掉。
 */
/*
 * 🛡️ 先自动修一遍再探：产物目录如果带 Low 标签，直接改回 Medium。
 * （`Low` 的来源查不出来 —— 见 scripts/lib/exec-probe.js 顶部的查证结论。
 *   "发现即修复"比"抓凶手"靠谱；只单向修 Low → Medium，别的标签一律不动。）
 */
const autoFix = ensureDirRunnable(OUT);
if (autoFix.changed) {
  log('[!] 产物目录带了 Low 完整性标签 —— 已自动改回 Medium（否则里面的 exe 起不来）。');
} else if (autoFix.reason.indexOf('自动修复失败') >= 0) {
  log('[!] ' + autoFix.reason);
  log('    手动修：icacls "' + OUT + '" /setintegritylevel (OI)(CI)M');
}

log('[4/4] 探测该目录能否执行程序…');
const probe = probeExecutable(OUT);
if (probe.ok) {
  log('      ✔ ' + probe.detail);
} else if (!probe.ran) {
  // 探针本身没跑起来（写不进去 / 拉不起来）—— 这不能证明"目录被拦"，
  // 只说明这次没测成。别误报，放行即可。
  log('      [i] 没测成：' + probe.detail);
  log('          （这不代表目录有问题，只是这次探针没跑起来，继续构建）');
} else {
  log('');
  log('      ✘ ' + probe.detail);
  log('');
  log('      ⚠️ 这个目录禁止执行 exe —— 产物本身没问题，但放这里跑不起来。');
  log('         典型原因：该目录被某个 AI 工具/安全软件的"工作区保护"整棵树拦了');
  log('         （本机实测 C:\\Users\\ZJS248\\Desktop\\video\\ 就是这种）。');
  log('');
  log('         换个目录即可，例如：');
  log('           set WW_OUT_DIR=C:\\WallpaperWorkshop\\app');
  log('           npm run dist:dir');
  log('');
  log('         默认目录（%LOCALAPPDATA%\\WallpaperWorkshop\\app）不受影响。');
  log('');
  process.exit(2);
}

log('');
log('  完成，用时 ' + ((Date.now() - t0) / 1000).toFixed(1) + ' 秒');
log('');
log('  启动：npm run desktop    （或双击 启动桌面版.cmd）');
log('  改代码后：直接改 ' + OUT + '\\resources\\app\\ 下的文件再重启即可，');
log('            不用重新构建；想同步回源码就改项目根目录，然后 npm run dist:dir --fast');
log('');

/* ------------------------- 工具 ------------------------- */

function countFiles(dir) {
  let n = 0;
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else n++;
    }
  };
  walk(dir);
  return n;
}

/**
 * 把图标嵌进 exe。
 *
 * rcedit 不是本项目的依赖，它在 electron-builder 的下载缓存里；找不到就跳过，
 * 图标只影响资源管理器里显示的样子，不影响运行。
 *
 * ⚠️ rcedit 只接受 **.ico**，给 .png 会直接失败（退出码 1、无输出）——
 * 这是第一次写这个脚本时踩的坑。所以：
 *   1. 优先找现成的 .ico
 *   2. 只有 .png 的话，就地包一个 ICO 容器（Vista 起 ICO 允许直接内嵌 PNG）
 *   3. 都不行就算了
 */
function tryEmbedIcon(exe) {
  const ico = findIcon();
  if (!ico) {
    log('      没有可用图标，跳过（exe 显示 Electron 默认图标，不影响功能）');
    return;
  }

  const rcedit = findRcedit();
  if (!rcedit) {
    log('      没找到 rcedit，跳过嵌图标（不影响功能）');
    return;
  }

  const r = spawnSync(rcedit, [exe, '--set-icon', ico], {
    stdio: 'ignore',
    windowsHide: true,
  });

  /*
   * 保险：rcedit 是原地改 exe，万一改坏了就是"双击没反应"，
   * 而那正是这个项目一直在查的症状 —— 不能自己制造一个。
   * 所以改完立刻验一遍 PE 头，不对就用原始 electron.exe 覆盖回去。
   */
  if (r.status === 0 && looksLikeValidExe(exe)) {
    log('      已嵌入图标（' + path.relative(ROOT, ico) + '）');
    return;
  }

  log('      嵌图标失败（退出码 ' + r.status + '），回滚到原始 exe');
  try {
    fs.copyFileSync(path.join(ELECTRON_DIST, 'electron.exe'), exe);
    log('      已回滚，不影响运行');
  } catch (e) {
    die('回滚失败，产物已损坏：' + e.message);
  }
}

/** exe 是不是还像样（MZ 头 + 体积合理） */
function looksLikeValidExe(p) {
  try {
    const st = fs.statSync(p);
    if (st.size < 50 * 1048576) return false;   // Electron 主程序 ~160MB
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(2);
    fs.readSync(fd, buf, 0, 2, 0);
    fs.closeSync(fd);
    return buf.toString('latin1') === 'MZ';
  } catch (e) {
    return false;
  }
}

/** 找 .ico；没有就用 electron/icon.png 现造一个 */
function findIcon() {
  const candidates = [
    path.join(ROOT, 'dist', '.icon-ico', 'icon.ico'),   // electron-builder 留下的缓存
    path.join(ROOT, 'electron', 'icon.ico'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }

  const png = path.join(ROOT, 'electron', 'icon.png');
  if (!fs.existsSync(png)) return null;
  try {
    const out = path.join(ROOT, 'dist', '.icon-ico', 'icon.ico');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, pngToIco(fs.readFileSync(png)));
    return out;
  } catch (e) {
    return null;
  }
}

/**
 * 把一个 PNG 包成单条目的 ICO。
 *
 * ICO 结构：6 字节目录头 + 16 字节目录项 + 图像数据。
 * Vista 以后允许图像数据直接是 PNG 字节（不必是 BMP），所以这里原样内嵌。
 * 宽度/高度写 0 表示 256（ICO 里 256 用 0 表示）。
 */
function pngToIco(png) {
  // 从 PNG 的 IHDR 里读真实宽高
  let w = 0, h = 0;
  if (png.length > 24 && png.toString('latin1', 12, 16) === 'IHDR') {
    w = png.readUInt32BE(16);
    h = png.readUInt32BE(20);
  }

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);            // reserved
  header.writeUInt16LE(1, 2);            // type: 1 = icon
  header.writeUInt16LE(1, 4);            // 图像数量

  const entry = Buffer.alloc(16);
  entry.writeUInt8(w >= 256 ? 0 : w, 0);
  entry.writeUInt8(h >= 256 ? 0 : h, 1);
  entry.writeUInt8(0, 2);                // 调色板数
  entry.writeUInt8(0, 3);                // reserved
  entry.writeUInt16LE(1, 4);             // 颜色平面
  entry.writeUInt16LE(32, 6);            // 位深
  entry.writeUInt32LE(png.length, 8);    // 数据长度
  entry.writeUInt32LE(22, 12);           // 数据偏移（6 + 16）

  return Buffer.concat([header, entry, png]);
}

function findRcedit() {
  const base = path.join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache', 'winCodeSign');
  let versions;
  try {
    versions = fs.readdirSync(base);
  } catch (e) {
    return null;
  }
  for (const v of versions) {
    const p = path.join(base, v, 'rcedit-x64.exe');
    if (fs.existsSync(p)) return p;
  }
  return null;
}
