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
const { app, BrowserWindow, Tray, Menu, shell, ipcMain, nativeImage } = require('electron');

const PROJECT = path.resolve(__dirname, '..');
/**
 * 托盘图标的 base64 兜底。
 *
 * 打包后 electron/ 在 app.asar 里，而 `nativeImage.createFromPath` **不支持 asar 路径**
 * （它不走 Electron patch 过的 fs），直接用文件路径会得到一张空图 —— 表现是托盘没图标。
 * 所以：先试文件（开发态），失败或为空就用内嵌这份 64×64 PNG。
 */
const TRAY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAABGElEQVR4nO3bS07DMBhF4ZujzGFNsB1YDWwH1lRWAFJHVZWA86qxT79JlMiO/2s7k0hO7tyGJY0fXj6+04Cv9+fiXENPwddMxNBj8CUTQe/h/8rC0g6tmstEacMeTGUjclhWfy4jkcO0+lNZiRyRI3JEjsgROSJH5MatLzi9PZ2vj6+fxW33VDLuYTvgdECgW9dArYH3tKWW8T8UUdO457fX4iQQuXFtxxZXewqRI3JEjsgROSJH5IgckSNyRI7IETkiR+So9Td2T1tqodbAe9law1i7gNqIHJEjckSOyBE5IkfkWHPMpHWXWYkclzeGXXCdkchx/aDnXTCVjdKGrZvLxNIOLfoty1DyAu3ByVYnoqfde5eD/QDfg1ZDPnlIkAAAAABJRU5ErkJggg==';
const PORT = Number(process.env.WW_PORT || 9391);
const BASE = 'http://127.0.0.1:' + PORT;
/** 登录时自启的实例带 --hidden：只驻留托盘，不弹窗打扰 */
const START_HIDDEN = process.argv.indexOf('--hidden') >= 0;

// 必须在 require 后端之前设置：配置目录（打包后 asar 只读）
process.env.WW_CONFIG_DIR = process.env.WW_CONFIG_DIR || path.join(app.getPath('userData'), 'config');

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

function isAutoLaunchOn() {
  try {
    return !!app.getLoginItemSettings({ path: process.execPath, args: loginArgs() }).openAtLogin;
  } catch (e) {
    return false;
  }
}

function setAutoLaunch(on) {
  app.setLoginItemSettings({ openAtLogin: !!on, path: process.execPath, args: loginArgs() });
  writePrefs({ autoLaunch: !!on, autoLaunchSet: true });
  return isAutoLaunchOn();
}

/** 首次运行时默认打开开机自启动（用户可在托盘/设置里关掉） */
function initAutoLaunch() {
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
    minWidth: 720,
    minHeight: 520,
    title: '创意工坊 · Wallpaper Engine',
    backgroundColor: '#0e1621',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  win.loadURL(BASE + '/');

  win.once('ready-to-show', () => {
    if (!START_HIDDEN) win.show();
  });

  // 点关闭 = 收进托盘（托盘菜单里才能真正退出）
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
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
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: '打开创意工坊', click: showWindow },
    { type: 'separator' },
    {
      label: '开机自启动',
      type: 'checkbox',
      checked: isAutoLaunchOn(),
      click: (item) => {
        setAutoLaunch(item.checked);
        refreshTray();
      },
    },
    { label: '打开数据目录', click: () => shell.openPath(app.getPath('userData')) },
    { label: '重新加载页面', click: () => win && !win.isDestroyed() && win.webContents.reload() },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } },
  ]);
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
  tray.setToolTip('创意工坊 · Wallpaper Engine');
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

// 第二个实例：把已有窗口叫出来，不重复开
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);

  app.whenReady().then(async () => {
    try {
      await ensureBackend();
    } catch (e) {
      // 后端起不来也要给用户一个能看懂的窗口（页面里会显示接口失败）
      console.error('[desktop] 后端启动失败：' + (e && e.message));
    }
    initAutoLaunch();
    createWindow();
    createTray();
  });

  app.on('activate', showWindow);

  // 托盘常驻：关掉窗口不退出进程（这是"开机静默驻留"的前提）
  app.on('window-all-closed', () => {});

  app.on('before-quit', () => {
    quitting = true;
  });
}
