'use strict';
/**
 * wallpaper-workshop 的桌面壳（Electron）。
 *
 * 设计取向：**后端仍然是那个零依赖的 Node 服务**，桌面壳只负责三件事：
 *   1. 启动时把后端拉起来（后端已经在本机跑着就直接复用，不重复占端口）
 *   2. 开一个 BrowserWindow 指向 http://127.0.0.1:<port>/
 *   3. 托盘 + 开机自启动（app.setLoginItemSettings）
 *
 * 为什么后端跑在本进程里而不是 spawn 一个 node 子进程：
 * 打包后代码在 app.asar 里，普通 node 子进程读不到 asar（Electron 自己
 * patch 过 fs 才行）。server.js 只用 Node 内置模块，require 进来即可。
 *
 * 配置落盘位置：打包后项目目录只读，所以把 WW_CONFIG_DIR 指到 userData，
 * 让"保存设置 / 记住 Cookie"在安装版里照常可用（见 server/lib/settings.js）。
 */

const path = require('path');
const fs = require('fs');
const http = require('http');

/*
 * ⚠️ 信标：在 require('electron') **之前**落一笔。
 *
 * 为什么放这么靠前：进程有可能卡在 Chromium 的原生初始化里，或者被外部
 * （杀软 / 注入器）静默终止 —— 这两种情况下后面所有日志都写不出来，
 * 现象就是"双击没反应、日志里连 boot 都没有"，无从下手。
 *
 * 有了这一笔就能把三种情况分开：
 *   有 beacon、没有 boot   → 死在 require('electron') 或 Chromium 初始化
 *   有 boot、没有 window   → 死在 Electron ready 之后、窗口建出来之前
 *   连 beacon 都没有       → JS 根本没开始跑（进程在 native 层就被干掉了）
 *
 * 这里刻意**不依赖 electron 模块**，所以路径只能自己拼。
 * 与下面 LOG_FILE 用的是同一个目录（%APPDATA%\wallpaper-workshop）；
 * 万一将来 app.getName() 变了导致两个文件不一致，以 beacon 文件为准，
 * 因为它是唯一在"最早期"能写出来的东西。
 */
try {
  const beaconDir = path.join(process.env.APPDATA || path.join(
    process.env.USERPROFILE || '', 'AppData', 'Roaming'), 'wallpaper-workshop');
  fs.mkdirSync(beaconDir, { recursive: true });
  fs.appendFileSync(path.join(beaconDir, 'desktop.log'),
    '[' + new Date().toISOString() + '] beacon  main.js 已开始执行' +
    ' pid=' + process.pid +
    ' argv=' + JSON.stringify(process.argv.slice(1)) + '\n', 'utf8');
} catch (e) {
  /* 信标失败绝不能影响启动 */
}

const { app, BrowserWindow, Tray, Menu, shell, ipcMain, nativeImage } = require('electron');

const PROJECT = path.resolve(__dirname, '..');

/*
 * ═══════════════════════════════════════════════════════════════════════════
 * 屏蔽游戏++（GamePP）注册的全局 Vulkan 层 —— 这是"双击没反应"的真凶
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ⚠️ 位置有讲究：必须在**写 boot 日志之前、在任何子进程被拉起来之前**执行。
 *    所以它放在文件最靠上的位置，别往下挪。
 *
 * 【怎么查出来的】
 *
 * 崩溃转储（%LOCALAPPDATA%\CrashDumps）里，两种产物是两种死法：
 *
 *   便携版 WallpaperWorkshop 1.0.0.exe  →  0xC0000005，故障模块 GPP32.dll
 *                                          （模块内偏移 0x5F3B8，四次一字不差）
 *   目录版 WallpaperWorkshop.exe        →  0x80000003，故障模块是它自己
 *                                          （模块内偏移 0x19C58D9）
 *
 * 0x80000003 = STATUS_BREAKPOINT，是 Chromium 的 IMMEDIATE_CRASH()（一条 int3）。
 * 它只在一种情况下走这条路：GPU 子进程连续起不来，Chromium 连试 9 次后
 * 打出 `FATAL:gpu_data_manager_impl_private.cc(431)] GPU process isn't usable.`
 * 然后**主动结束整个进程**。所以目录版不是被注入打崩的（转储里 71 个模块
 * 全是系统目录 + 自己 + ffmpeg.dll），是 Chromium 自己不想活了。
 *
 * 【那 GPU 子进程为什么起不来】
 *
 * 游戏++ 在注册表里挂了一个**全局** Vulkan 隐式层：
 *
 *   HKLM\SOFTWARE\Khronos\Vulkan\ImplicitLayers
 *     -> C:\ProgramData\GamePPSdk\<版本>\vulkan\GPP_VKLayer64.json
 *
 * 隐式层（implicit layer）的规矩是：**任何进程只要创建 Vulkan 实例，加载器
 * 就自动把 .dll 塞进去**，不需要目标程序配合、也没法用代码拒绝。
 * Chromium 的 GPU 子进程为了收集显卡信息会枚举 Vulkan 设备，正好撞上它 ——
 * 层一挂，GPU 子进程就死，主进程随后自杀。
 *
 * 时间线也对得上：GamePPSDK 的 data 目录（overlaydata_x64/x86.data，
 * 也就是"游戏内悬浮窗"的数据）是 **2026-09-30 17:49:31** 落盘的，
 * 而用户是 Sep 28 / Sep 29 18:00 还能正常打开、Sep 30 23:14 就起不来了。
 * 悬浮窗一武装，注入就开始了。
 *
 * 【为什么以前能用】
 *
 * 因为以前没被注入。不是代码写坏了，是这台机器上多了一个"见进程就钻"的
 * 全局钩子。同一份 exe 拷到没装游戏++ 的机器上照样跑。
 *
 * 【修法】
 *
 * 游戏++ 自己在层描述文件里留了开关：
 *     "disable_environment": { "DISABLE_GAMEPP_LAYER": "1" }
 * 按 Vulkan 加载器规范，这个环境变量一旦等于该值，加载器就跳过这个层。
 * 这里在**子进程被拉起来之前**设好，GPU / 渲染子进程会继承过去。
 *
 * 只影响本应用自己的进程树，不动系统、不影响游戏++ 对其他程序生效。
 *
 * 想留着这层（比如你就是想让悬浮窗盖在本应用上）：WW_KEEP_GAMEPP_LAYER=1 启动。
 * ═══════════════════════════════════════════════════════════════════════════
 */
if (process.env.WW_KEEP_GAMEPP_LAYER !== '1') {
  process.env.DISABLE_GAMEPP_LAYER = '1';
}

/**
 * 打包后没有控制台，一旦在启动早期出问题，表现就是"双击没反应、什么都没有"。
 * 所以把关键节点和未捕获异常同时落一份到 userData/desktop.log，
 * 事后至少能看出"Electron 到底起没起来、卡在哪一步"。
 *
 * ⚠️ 这份日志抓不到**进程级崩溃**（比如被第三方 overlay 注入的 DLL 打崩）。
 * 那种情况桌面壳根本没机会执行任何代码，只能去 Windows 事件查看器看
 * "应用程序错误"（它会给出故障模块名和路径，是定位这类问题最快的入口）。
 */
const LOG_FILE = path.join(app.getPath('userData'), 'desktop.log');
const LOG_MAX = 256 * 1024;

function logToFile(tag, detail) {
  try {
    const text = detail instanceof Error ? detail.stack || detail.message : String(detail);
    try {
      if (fs.statSync(LOG_FILE).size > LOG_MAX) fs.writeFileSync(LOG_FILE, '', 'utf8');
    } catch (e) { /* 文件还不存在，正常 */ }
    fs.appendFileSync(LOG_FILE, '[' + new Date().toISOString() + '] ' + tag + '  ' + text + '\n', 'utf8');
  } catch (e) {
    /* 日志本身出问题绝不能影响主流程 */
  }
}

process.on('uncaughtException', (e) => logToFile('uncaughtException', e));
process.on('unhandledRejection', (e) => logToFile('unhandledRejection', e));

logToFile('boot', 'argv=' + JSON.stringify(process.argv.slice(1)) +
  ' packaged=' + app.isPackaged +
  ' hwAccel=' + (process.env.WW_HW_ACCEL === '1') +
  ' gameppLayer=' + (process.env.DISABLE_GAMEPP_LAYER === '1' ? 'blocked' : 'allowed') +
  ' execPath=' + process.execPath);

/*
 * 把 TEMP 也记一笔。
 *
 * 便携版的自解压壳（NSIS）和 Electron 自己都要写 TEMP，而 TEMP 出问题时的
 * 表现是"双击后什么都没有"或者一句没头没尾的
 * "Error writing temporary file. Make sure your temp folder is valid."——
 * 事后完全猜不到根因。留一条日志，至少能立刻排除或坐实 TEMP 这条线。
 */
try {
  const tmpDir = app.getPath('temp');
  fs.accessSync(tmpDir, fs.constants.W_OK);
  logToFile('env', 'temp=' + tmpDir + '（可写）');
} catch (e) {
  logToFile('env', 'temp 不可用：' + (e && e.message));
}

/*
 * 子进程 / 渲染进程被杀掉时，窗口会变成一片白、或者干脆没有内容，
 * 用户描述通常是"起来了但没反应"。
 *
 * 这两种"没反应"完全不是一个原因，而它们唯一的区分证据就是这两条事件：
 *   render-process-gone  → 页面渲染进程挂了（窗口在，内容是白的）
 *   child-process-gone   → GPU / utility 子进程挂了
 * 没有日志的话，只能靠猜。
 */
app.on('child-process-gone', (event, details) => {
  logToFile('child-process-gone',
    details.type + ' reason=' + details.reason + ' exitCode=' + details.exitCode);
});
app.on('render-process-gone', (event, webContents, details) => {
  logToFile('render-process-gone',
    'reason=' + details.reason + ' exitCode=' + details.exitCode);
});

/**
 * 托盘图标的 base64 兜底。
 *
 * 打包后 electron/ 在 app.asar 里，而 `nativeImage.createFromPath` **不支持 asar 路径**
 * （它不走 Electron patch 过的 fs），直接用文件路径会得到一张空图 —— 表现是托盘没图标。
 * 所以：先试文件（开发态），失败或为空就用内嵌这份 64×64 PNG。
 *
 * 这份 base64 由 `node scripts/make-icons.js` 生成，与 electron/tray.png 同源。
 */
const TRAY_PNG_BASE64 =
  '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';
const PORT = Number(process.env.WW_PORT || 9391);
const BASE = 'http://127.0.0.1:' + PORT;
/** 登录时自启的实例带 --hidden：只驻留托盘，不弹窗打扰 */
const START_HIDDEN = process.argv.indexOf('--hidden') >= 0;

/* 游戏++ 的 Vulkan 层屏蔽在文件顶部（必须在写 boot 日志之前执行），别在这里重复。 */

/*
 * 关掉硬件加速 —— 不关的话这个应用在部分机器上**根本起不来**。
 *
 * 症状（用户实测，启动日志实证）：
 *     ERROR:gpu_process_host.cc(951)] GPU process launch failed: error_code=18
 *     WARNING:gpu_process_host.cc(1327)] The GPU process has crashed 1..9 time(s)
 *     FATAL:gpu_data_manager_impl_private.cc(431)] GPU process isn't usable. Goodbye.
 *
 * 关键在于这条 FATAL：GPU 子进程起不来时，Electron 连试 9 次就**主动结束整个进程**。
 * 表现是双击后**什么都没发生**——没有窗口、没有托盘、没有报错，
 * 因为托盘应用没有控制台，stderr 默认谁也看不见（要复现得这样跑：
 * `.\xxx.exe --enable-logging 2>&1 | Tee-Object 启动日志.txt`）。
 *
 * 注意后端是好的：同一份日志里 `前端 / 接口 : http://localhost:9391/` 已经打出来了，
 * 是 GPU 挂掉之后才自杀的。所以别再去查后端。
 *
 * 为什么 GPU 起不来：**游戏++ 的全局 Vulkan 层**（见上面那段，2026-09-30 定位）。
 * 关硬件加速能让 Chromium 不再真去用 GPU，但不保证它不去**枚举** Vulkan 设备，
 * 所以单靠这一句在装了游戏++ 的机器上仍然会崩 —— 真正管用的是上面的
 * DISABLE_GAMEPP_LAYER=1，这一句留着当第二道保险。
 * 对一个刷壁纸缩略图的界面，软件渲染完全够用。
 *
 * 想临时开回硬件加速（比如换了驱动之后想试试）：WW_HW_ACCEL=1 启动即可。
 */
if (process.env.WW_HW_ACCEL !== '1') {
  app.disableHardwareAcceleration();
}

/*
 * 再兜一层：光关硬件加速**挡不住** GPU 子进程被拉起。
 *
 * 实测（Windows 11 / Electron 26.6.10，打包版）：即使 disableHardwareAcceleration()
 * 已经生效（启动日志里 hwAccel=false），GPU 子进程依然会被拉起来，然后连续崩 6 次：
 *     ERROR:gpu_process_host.cc(957)] GPU process exited unexpectedly: exit_code=1
 *     WARNING:gpu_process_host.cc(1327)] The GPU process has crashed 1..6 time(s)
 *     FATAL:gpu_data_manager_impl_private.cc(431)] GPU process isn't usable. Goodbye.
 * 最后那条 FATAL 走的是 IMMEDIATE_CRASH()（int3），**整个进程当场结束**——
 * 表现就是双击后什么都没有；在 Windows 事件查看器里则是一条
 * "错误模块: WallpaperWorkshop.exe，异常代码: 0x80000003"。
 *
 * 三个开关都能绕过，这里选**最保守**的一个：
 *   --disable-gpu-sandbox  ← 采用。只去掉 GPU 进程的沙箱，渲染进程沙箱保持开启。
 *   --in-process-gpu        把 GPU 挪进主进程，Electron 不官方支持，且 GPU 卡住会拖死整个应用。
 *   --no-sandbox            连渲染进程沙箱一起关掉，太激进。
 *
 * 取舍说明：本应用只加载 http://127.0.0.1:<PORT> 的本地内容，外链一律交给系统浏览器
 * （见下面的 will-navigate / setWindowOpenHandler），GPU 进程不接触不可信网页内容，
 * 所以这个放宽是安全的。
 *
 * 想关掉：WW_GPU_SANDBOX=1 启动。
 */
if (process.env.WW_GPU_SANDBOX !== '1') {
  app.commandLine.appendSwitch('disable-gpu-sandbox');
}

// 必须在 require 后端之前设置：配置目录（打包后 asar 只读）
process.env.WW_CONFIG_DIR = process.env.WW_CONFIG_DIR || path.join(app.getPath('userData'), 'config');

/*
 * 桌面壳只连本机 —— 把后端绑到 127.0.0.1。
 *
 * 后端的默认 host 是 0.0.0.0（见 server/lib/settings.js:31），那是给**网页版**
 * （`node server.js`，可能要从手机/局域网访问）留的。但桌面壳不一样：
 * 窗口被 will-navigate 锁死在 http://127.0.0.1:<PORT>，永远只走本机。
 *
 * 绑 0.0.0.0 在这个场景下的唯一实际后果，是 Windows 防火墙每次都要问一遍
 * "是否允许访问网络"。便携版更糟：它每次解压到**新的随机 Temp 路径**，
 * 防火墙按程序路径记规则，所以是"每次启动都弹"。
 *
 * 想改回全网卡（比如想让桌面壳顺带对外提供局域网访问）：WW_HOST=0.0.0.0 启动。
 */
process.env.WW_HOST = process.env.WW_HOST || '127.0.0.1';

let win = null;
let tray = null;
let quitting = false;
let backendReady = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 探测 127.0.0.1:<port> 上是不是已经有一个能用的后端 */
function probe() {
  return new Promise((resolve) => {
    const req = http.get(BASE + '/api/status', { timeout: 1200 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try {
          resolve(!!JSON.parse(body).ok);
        } catch (e) {
          resolve(false);
        }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/** 确保后端在跑；返回是否由本进程启动 */
async function ensureBackend() {
  if (await probe()) return false;
  // 后端入口：零依赖，只需要 Node 内置模块
  require(path.join(PROJECT, 'server.js'));
  for (let i = 0; i < 80; i++) {
    if (await probe()) { backendReady = true; return true; }
    await sleep(250);
  }
  throw new Error('后端在 20 秒内没有就绪（端口 ' + PORT + '）');
}

/* ------------------------------ 开机自启动 ------------------------------ */

const prefsFile = () => path.join(app.getPath('userData'), 'desktop.json');

function readPrefs() {
  try {
    return JSON.parse(fs.readFileSync(prefsFile(), 'utf8')) || {};
  } catch (e) {
    return {};
  }
}

function writePrefs(patch) {
  const next = Object.assign(readPrefs(), patch);
  try {
    fs.mkdirSync(path.dirname(prefsFile()), { recursive: true });
    fs.writeFileSync(prefsFile(), JSON.stringify(next, null, 2), 'utf8');
  } catch (e) {
    /* 写不进去不影响运行 */
  }
  return next;
}

/** 开发态（electron .）需要把项目路径作为参数带上，打包态不用 */
function loginArgs() {
  return app.isPackaged ? ['--hidden'] : [PROJECT, '--hidden'];
}

/**
 * 便携版（portable）跑起来了吗？
 *
 * electron-builder 的 portable 目标是个自解压壳：**每次运行都解压到一个新的随机 Temp 目录**
 * 再执行里面的 exe，退出时那个目录会被删掉。
 * 所以 `process.execPath` 指向一个**下次开机肯定不存在**的路径 ——
 * 拿它去注册开机自启，写进注册表的必然是死链。
 *
 * 这不是推测，本机就残留过这么一条：
 *   HKCU\...\Run\com.zjs248.wallpaperworkshop
 *     = C:\Users\ZJS248\AppData\Local\Temp\3JztVAgD4LzxgYZjSZTro7MQ4Si\WallpaperWorkshop.exe --hidden
 * 那个 Temp 目录早已不存在，每次开机都在跑一条无效启动项。
 */
function isPortableRun() {
  if (!app.isPackaged) return false;
  try {
    const exe = path.resolve(process.execPath).toLowerCase();
    const tmp = path.resolve(require('os').tmpdir()).toLowerCase();
    return exe.indexOf(tmp + path.sep) === 0;
  } catch (e) {
    return false;
  }
}

function isAutoLaunchOn() {
  try {
    return !!app.getLoginItemSettings({ path: process.execPath, args: loginArgs() }).openAtLogin;
  } catch (e) {
    return false;
  }
}

function setAutoLaunch(on) {
  if (on && isPortableRun()) {
    /*
     * 便携版拒绝开启。注意这里**故意不写 autoLaunchSet**：
     * 那个标记是"用户表过态"的意思，如果便携版把它写进去，
     * 用户之后装安装版时就会被当成"用户已关掉自启"，反而不会自动打开。
     */
    logToFile('autolaunch', '便携版运行（exe 在临时目录），忽略开机自启设置');
    return false;
  }
  app.setLoginItemSettings({ openAtLogin: !!on, path: process.execPath, args: loginArgs() });
  writePrefs({ autoLaunch: !!on, autoLaunchSet: true });
  return isAutoLaunchOn();
}

/** 首次运行时默认打开开机自启动（用户可在托盘/设置里关掉） */
function initAutoLaunch() {
  if (isPortableRun()) return; // 便携版不支持，见 isPortableRun 的注释
  const prefs = readPrefs();
  if (!prefs.autoLaunchSet) {
    setAutoLaunch(true);
    return;
  }
  // 用户手动改过：以系统里的实际状态为准，不覆盖
}

/* ------------------------------ 窗口 / 托盘 ------------------------------ */

function createWindow() {
  win = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 860,
    minHeight: 580,
    title: '创意工坊',
    backgroundColor: '#0f151c',
    autoHideMenuBar: true,
    show: false,
    /*
     * 去掉原生标题栏：页面里的顶栏就是窗口标题栏。
     *
     * 之前是「原生标题栏 + 页面顶栏」两层头，垂直空间白扔 30 多 px，
     * 而且两者的标题文字重复。这里用 titleBarStyle:'hidden' 让页面顶栏顶到最上面，
     * 再用 titleBarOverlay 把**系统窗口按钮**（最小化/最大化/关闭）画在我们顶栏的右上角 ——
     * 按钮仍然由系统绘制与处理命中测试，我们不需要自绘拖拽区与按钮。
     *
     * 页面侧配合：<html class="desktop"> 时 .titlebar 预留 148px 的按钮区。
     */
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0b1016', symbolColor: '#c6d0da', height: 40 },
    icon: path.join(PROJECT, 'electron', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  win.loadURL(BASE + '/');

  /*
   * ⚠️ 这里有个很坑的脆弱点，别把兜底删掉。
   *
   * 窗口是**等 `ready-to-show` 才 show()** 的。而 `ready-to-show` 只在
   * 页面首帧准备好之后才触发 —— 如果页面压根没加载出来（后端没起来、
   * 端口被占、渲染进程被杀…），这个事件**永远不触发**，
   * 于是窗口永远不出现，托盘图标却已经建好了。
   *
   * 用户看到的就是："双击了，没报错，也没反应，任务管理器里好像有东西又好像没有。"
   * 和"进程崩溃"的表现几乎一样，但原因完全不同。
   *
   * 所以加一个超时兜底：8 秒还没 show 就强制显示。
   * 哪怕页面是空白的，至少用户能看到一个窗口 —— 有窗口才能看到错误提示。
   */
  const showFallback = setTimeout(() => {
    if (START_HIDDEN) return;
    if (!win || win.isDestroyed() || win.isVisible()) return;
    logToFile('window-show-fallback',
      'ready-to-show 在 8 秒内没有触发，兜底显示窗口（页面可能是空白的）');
    win.show();
  }, 8000);

  win.once('ready-to-show', () => {
    clearTimeout(showFallback);
    if (!START_HIDDEN) win.show();
    logToFile('window-shown',
      'ready-to-show 触发，START_HIDDEN=' + START_HIDDEN +
      ' visible=' + win.isVisible() + ' minimized=' + win.isMinimized());
  });

  /*
   * 页面加载失败（后端还没起来、端口被占、白屏…）以前是彻底静默的：
   * 窗口在，内容空白，用户只会说"没反应"。记下错误码和 URL。
   */
  win.webContents.on('did-fail-load', (e, code, desc, url) => {
    logToFile('did-fail-load', 'code=' + code + ' desc=' + desc + ' url=' + url);
  });

  /*
   * 正向信号：页面**成功**加载完了。
   * 有了它才能把"页面是好的"和"页面根本没出来"分开 ——
   * 只看 did-fail-load 是分不出来的（成功时它什么都不写）。
   */
  win.webContents.on('did-finish-load', () => {
    logToFile('did-finish-load', '页面加载完成 ' + BASE + '/');
  });

  // 点关闭 = 收进托盘（托盘菜单里才能真正退出）
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });

  /*
   * 桌面壳不该变成浏览器：窗口内只允许停留在本地 origin，
   * 任何外链（Steam 页面、举报页…）一律交给系统浏览器。
   */
  win.webContents.on('will-navigate', (e, url) => {
    if (url.indexOf(BASE) !== 0) {
      e.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    }
  });

  // 外链一律走系统浏览器，别把桌面窗口变成浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url) && url.indexOf(BASE) !== 0) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });
}

function showWindow() {
  if (!win || win.isDestroyed()) {
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  /*
   * 第二个实例（双击 exe、点快捷方式）走的是 second-instance → showWindow。
   * 如果窗口本来就在托盘里、或者刚被叫出来时焦点被别的窗口抢走，
   * 光 show+focus 用户可能完全没察觉 —— 表现就是"双击了但好像没反应"。
   * 闪一下任务栏图标，给个明确的"我在这儿"。
   */
  try {
    win.flashFrame(true);
    setTimeout(() => {
      if (win && !win.isDestroyed()) win.flashFrame(false);
    }, 2500);
  } catch (e) {
    /* 个别 shell 上 flashFrame 可能不支持，不影响主流程 */
  }
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: '打开创意工坊', click: showWindow },
    { type: 'separator' },
    {
      // 便携版每次运行路径都不一样，注册了也是死链 —— 直接置灰并说明原因
      label: isPortableRun() ? '开机自启动（便携版不支持）' : '开机自启动',
      type: 'checkbox',
      enabled: !isPortableRun(),
      checked: isAutoLaunchOn(),
      click: (item) => {
        setAutoLaunch(item.checked);
        refreshTray();
      },
    },
    { label: '打开数据目录', click: () => shell.openPath(app.getPath('userData')) },
    { label: '重新加载页面', click: () => win && !win.isDestroyed() && win.webContents.reload() },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } },  ]);
}

function refreshTray() {
  if (tray) tray.setContextMenu(buildTrayMenu());
}

function createTray() {
  const iconPath = path.join(PROJECT, 'electron', 'tray.png');
  let img = nativeImage.createEmpty();
  try {
    if (fs.existsSync(iconPath)) img = nativeImage.createFromPath(iconPath);
  } catch (e) {
    /* 打包后在 asar 里读不到 → 用下面内嵌的那份 */
  }
  if (img.isEmpty()) img = nativeImage.createFromDataURL('data:image/png;base64,' + TRAY_PNG_BASE64);
  tray = new Tray(img);
  tray.setToolTip('创意工坊');
  tray.on('click', showWindow);
  refreshTray();
  tray.setContextMenu(buildTrayMenu());
}

/* ------------------------------ IPC（给页面用） ------------------------------ */

ipcMain.handle('ww:get-auto-launch', () => isAutoLaunchOn());
ipcMain.handle('ww:set-auto-launch', (e, on) => setAutoLaunch(!!on));
ipcMain.handle('ww:hide-to-tray', () => {
  if (win && !win.isDestroyed()) win.hide();
  return true;
});
ipcMain.handle('ww:open-data-dir', () => shell.openPath(app.getPath('userData')));
ipcMain.handle('ww:info', () => ({
  isDesktop: true,
  port: PORT,
  packaged: app.isPackaged,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
}));

/* ------------------------------ 生命周期 ------------------------------ */

/*
 * Windows 任务栏的图标与分组靠 AppUserModelID 认，没有它会出现
 * "图标是 Electron 默认的、每开一个窗口多一个分组"。
 * 必须在 app ready 之前设置，所以放在生命周期之外。
 */
app.setAppUserModelId('com.zjs248.wallpaperworkshop');

// 第二个实例：把已有窗口叫出来，不重复开
if (!app.requestSingleInstanceLock()) {
  /*
   * 走到这里说明托盘里已经有一个实例（最常见的是开机自启那个 --hidden 的）。
   * 这是**预期行为**，但它的表现是"双击了完全没反应"，很容易被误判成崩溃 ——
   * 所以特意留一条日志，让以后能一眼分清"被单实例锁挡了"还是"真的崩了"。
   */
  logToFile('second-instance', '已有实例在运行，本次启动直接退出（预期行为，不是崩溃）');
  app.quit();
} else {
  app.on('second-instance', showWindow);

  app.whenReady().then(async () => {
    logToFile('ready', 'app ready，准备拉起后端');
    try {
      const started = await ensureBackend();
      logToFile('backend', started ? '由本进程启动，端口 ' + PORT : '复用已在运行的实例，端口 ' + PORT);
    } catch (e) {
      // 后端起不来也要给用户一个能看懂的窗口（页面里会显示接口失败）
      console.error('[desktop] 后端启动失败：' + (e && e.message));
      logToFile('backend-failed', e);
    }
    try {
      initAutoLaunch();
    } catch (e) {
      logToFile('autolaunch-failed', e);
    }
    createWindow();
    createTray();
    logToFile('window', '窗口与托盘已创建（START_HIDDEN=' + START_HIDDEN + '）');
  });

  app.on('activate', showWindow);

  // 托盘常驻：关掉窗口不退出进程（这是"开机静默驻留"的前提）
  app.on('window-all-closed', () => {});

  app.on('before-quit', () => {
    quitting = true;
  });
}
