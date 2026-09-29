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
 *
 * 这份 base64 由 `node scripts/make-icons.js` 生成，与 electron/tray.png 同源。
 */
const TRAY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAHhklEQVR42uWb61OU5xnGn3+A3YWYRhvbEtN6qI6iRohpa0knPcz0Q6dN22n8kE5GNDad1hWD2iSNpjXWVE2jIApyiLDLMWE1khY1gXbiclBgEVHRACuKsMAeWfYAKlfnXmZf31cWnodqZ1f2nfl9YPe+nvd33TPAp4cxgSexbCw+sWxMm1Q+ZkgqhzmpHIhQzORIruTMHvRZVTqWvKp0rGZV2RgeSci9dCx52sVXltzVrCy5a3im5C5mAtSFOgmVX1F8J2FF8R3TiuI7mGFQp4QpyyfobycsL7rtWF50GzMUB3UMWX6ZblSzTDdqWqYfxYyGOupGJ/46LC0cMSwtHEV0MGJQlF9SMJK8pGAEUca9/w6Lj/lrFh/zI8qoCZRflO+LX/ShD1FJvi+eLczzahfmeRGlaNmCXI9hQa4HUYqBzc8ZNs/PGUaUYmbfPOrGdPhZhRcbT/siEnKbbh/2dPYQRHimwI33Gvwovzoa0ZAjuYr2YvOyXOCxOHcIBxr9KG8ffSQgV3IW6caeOuwEjw1VHpS3j0hktfixp94XUZCT3JGcRbqx+EwneBRcHEHZlXF2fOGFSCYckFvQk5xFMuwbhxzgETyU+EGRCyKZcEBucleRDPt6hh08Si/7JZ7XOyGSCQfkJncVybCvpdvAQ35oss4JkUw4IDe5q0iGzT1oBQ/5od8vdEAkMxlPZVjx7SzbtDK/+tiF9xs8WFc5NOUcucldRc5mTx4YBI+SSz6JNQV2iGRCEZ8+iLUGJ1IqXfhWphUv6O0BJptfdMSKtoHbkD/084+KHCHnyU3uKuLEvvrBAHgoFnDMBpFMKH5abMfGf7oC0BKymrw43OjByhxryPnam6MI9dASQs2Tm9xVxInN+Uc/eJS0+SS+96EVIpn7+aHOho2fOgP8ocoFQ7sPpzr9yG/xYvdZN+alDyjmF2YOYKqHzrv/HeQmdxXxYnPet4BHcZtX4rv5gxDJyEnMGcSrlU6JPJMHNddHApy85gv8nHbGpci8UGidcgG/KLNPeA+5yV1F3Njs/X3goVhA3iBEMkGWZ/Xj1UqHxJ6zbtSY/Qoqrowv4cUymyLr8t+ddAHzMywT3kVuclcRP/bEvl7wKL7okfhO3gBEMsT8dAteOWHHhpPjbDvjxKkO34QFEGWXvMgzDWN17r3z//gvR8jye41DId9HbnJXEUf2xN5b4KFYQG4/RDJz9/fileM2bPjEHuD3n9pRcdkbsnyQolYPDp1zY0F6n3TObw02XOwf/2N4w3kHb1U7J30nuSkWIODJvvL3HvAgsSDP5Vi480/uu4Vfl1mx/hObROGFYVSb/VPyWacvMLfrPy6IeN0PucldRTLs8fdugkdR67DEc0f7uPM/Lx7A+hM2iX1GF6q7fEKc7vAhv3kYr1XaIOImh9zkriIZ9vieG+AhP3R1dt+Usz8+ZkHKcatE2im7cPkgVV96kd/sxk8KLBDxC0JuigUIZNisv3WDR9GFYYnV2b2TziVl9SLl+KDEayetONnumfYCiMp2D3KahrA0owcijgS5yV1FMmzW7uvgUXTBLfFs1q2QMysye5BiGFRQ3DqM6i7v/8yJKx7sPevE3L3dEPEkN7mrSIbNetcMHooFHOmZ8P3T+7uRYhhQcKDWiepO7wNT3jaMN07bIOJJbooFCGTYY+92gYe+xS3x7JGbiu/m7buOlz/qx7qKe5DwwygfpLTVjd+UWLie5CZ3FenGHtvVCR76liGJpMM3pc9n7+7CSyV9ivK/OzGAqmueh7qAMx0eFJiGsCa7Z0pPcpO7inRjcX/tAA/FAjJvBD6bvbsTv9T3Yt3HFgUftbnxeafnoUNLyDrnxJIPrk/qSW5yV5FuLO4vHeChWMChbqyvsGDnZ1ZkNTgVlLUOoa7b93/j311e5Jx3YnPlwATIidwUCxDoxuLe+RI89CaXxNqSXrT0+iMScpO7inRjce9cAw/5oUkZZiza34nns7sjCnIiN+UC+N1Y3M6r4KE3OSUSM8wQyYSDxMAC7rmKZFjsjnbw0Dc7JRLTuyCSCQfkJncVybDYt6+Ah2IBBzshkgkH5KZYgECGxb59GTz0zQ6JxIMdEMmEA3KTu4pkWOyfL4GHrtkhkXigAyKZcEBucleRDIt9qw08jtbboGtyBNha2QuRTDggt6AnOYtkmObNi+CxVtcNXZNd4uAXg9hxyhJRkJPckZxFujHNm63gMWdnG/Z83q94QSRDruQs0o1p3rgAEebtuoQdVX3QNdojGnIkV9FeTPOnFkyHNelXsbbQHJGQ23T7MM32FrNmewuiFDNTbzcZ1NtNiFIMTL2tWave1owoRcvUW5vi1VubEKWM3yxTpzXWqNMaEWXUSPcF1Gnnk9Vp5xFlKK/TqV4/Z1C9fg5RgmHCnSHVlgaNakuDSbWlATMc6hj6DqFqS32CKrXeoUqtxwzFQR2nvDuoSq1LUKXWmVSpdZhhUKcEodujqs11GtXmWoNqcy1mCAbqNO07xDHa2uQYrbEmRmvEI0oNdXjgW+QxWmN8jNaojdlkNMRsMppjNp1FZEJuRkPAVWsUuj7/Xx9UCqTPESSNAAAAAElFTkSuQmCC';
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
