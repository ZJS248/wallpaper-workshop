#!/usr/bin/env node
'use strict';

/**
 * 启动「目录版」桌面应用：
 *   %LOCALAPPDATA%\WallpaperWorkshop\app\WallpaperWorkshop.exe
 * （用 `npm run app:path` 查当前路径；可用 WW_APP_DIR / WW_OUT_DIR 换位置）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 它解决四个问题
 * ─────────────────────────────────────────────────────────────────────
 *
 * 1. **SmartScreen 弹窗**
 *    exe 没有数字签名。双击走的是「资源管理器 → ShellExecute」这条路，
 *    Windows 会弹「Windows 已保护你的电脑 / 发布者未知」，每次都要点「仍要运行」。
 *    本脚本用 child_process.spawn → CreateProcess，**不经过 shell**，
 *    所以不会触发那个弹窗。
 *
 * 2. **失败信息看不见**
 *    双击失败就是一句没头没尾的弹窗。本脚本会读
 *    %APPDATA%\wallpaper-workshop\desktop.log，把本次启动新写进去的行打出来。
 *
 * 3. **GPU 子进程起不来导致整个应用自杀（本机真出现过）**
 *    症状：双击后什么都没发生；事件查看器里一条
 *    「错误模块: WallpaperWorkshop.exe，异常代码: 0x80000003」。
 *    根因是 Chromium 的 GPU 子进程连续启动失败，超过上限后主进程主动 int3 自杀。
 *    代码里那套 `disableHardwareAcceleration()` + commandLine 开关就是为了绕它，
 *    但**不同机器需要的开关不一样**。所以这里做**自动降级重试**：
 *    逐个配置试，直到 desktop.log 里出现 `window` 那一行（= 窗口建出来了）为止。
 *
 * 4. **游戏++（GamePP）的全局 Vulkan 层（2026-09-30 定位到的真凶）**
 *    游戏++ 往 HKLM 注册了一个全局 Vulkan 隐式层：
 *      C:\ProgramData\GamePPSdk\<版本>\vulkan\GPP_VKLayer64.json
 *    隐式层会被**任何创建 Vulkan 实例的进程自动加载**，Chromium 的 GPU 子进程
 *    正好会枚举 Vulkan 设备 —— 层一挂，GPU 子进程就死，主进程随即自杀。
 *    这就是上面第 3 条那个"GPU 起不来"的来源。
 *
 *    修法：给子进程设 `DISABLE_GAMEPP_LAYER=1`（游戏++ 自己在层描述文件里
 *    声明的 `disable_environment`，按 Vulkan 加载器规范会让加载器跳过该层）。
 *    本脚本每一档都会带上它；main.js 里也设了一份，双保险。
 *
 *    想保留这层（让游戏++ 悬浮窗盖在本应用上）：WW_KEEP_GAMEPP_LAYER=1。
 *
 * 5. **一堆关不掉的黑窗口（2026-10-01 定位）**
 *    早期用 `--enable-logging` 这个**命令行开关**来抓 Chromium 的日志。
 *    实测发现：Chromium 在 Windows 上一看到这个开关，就会
 *    **给主进程和每一个子进程各分配一个控制台窗口**
 *    （进程树里表现为每个子进程下挂一个 conhost.exe，窗口标题是 exe 路径）。
 *    于是打开一次应用，桌面上就多出几个关不掉的黑窗口。
 *
 *    实测数据（同一份产物，只改启动参数）：
 *      args=["--enable-logging"]   → 3 个应用进程，挂 2 个 conhost  ❌
 *      args=[]（什么都不加）        → 3 个应用进程，挂 0 个 conhost  ✅
 *      detached / windowsHide      → 与黑窗口无关，别在这上面找原因
 *
 *    正解：改用**环境变量** `ELECTRON_ENABLE_LOGGING=1`。
 *    抓到的 stderr 字节数几乎完全一样（1320 vs 1322，差的是 PID 位数），
 *    但**一个控制台窗口都不弹**。所以本脚本不再传 `--enable-logging`。
 *
 *    需要"最大程度地啰嗦"（比如深挖 Chromium 内部的 FATAL）时用 WW_DEBUG=1，
 *    那时会额外把 `--enable-logging` 加回去 —— 黑窗口也就忍了。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 用法
 * ─────────────────────────────────────────────────────────────────────
 *
 *   npm run desktop                 启动（自动重试；启动后脚本自己退出）
 *   npm run desktop -- --wait       启动后跟随 desktop.log
 *   npm run desktop -- --only=2     只试第 2 套配置，不做降级
 *
 *   WW_DEBUG=1                      额外开 --enable-logging（会弹控制台窗口）
 *   WW_NO_LOG=1                     完全不抓子进程 stderr
 *
 * 为什么不用 Setup 安装版：这个项目要经常改。安装版每次改完都得卸载重装；
 * 目录版是同一份产物，但**不需要安装**，重新构建直接覆盖即可。
 * 重新构建用 `npm run dist:dir`（只出目录版，不跑 NSIS，快很多）。
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');

const { APP_NAME, resolveOutDir } = require('./lib/app-dir');
const { probeExecutable, ensureDirRunnable } = require('./lib/exec-probe');

const ROOT = path.resolve(__dirname, '..');
/** WW_APP_DIR 可以指向别的目录（比如把产物复制出去单独测），平时不用设 */
const APP_DIR = process.env.WW_APP_DIR
  ? path.resolve(process.env.WW_APP_DIR)
  : resolveOutDir();
const EXE = path.join(APP_DIR, APP_NAME + '.exe');
const PORT = Number(process.env.WW_PORT || 9391);

/*
 * 桌面壳把日志写在 app.getPath('userData')，即 %APPDATA%\wallpaper-workshop\。
 * 注意 APPDATA 在部分 shell（Git Bash）里是**没有导出**的，
 * 所以不能只靠它，必须留一个 homedir 兜底 —— 否则会静默读错路径、
 * 把"读不到日志"误报成"启动没有任何输出"。
 */
const ROAMING = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const LOG = path.join(ROAMING, 'wallpaper-workshop', 'desktop.log');

/*
 * 子进程的 stdout/stderr 落盘。
 *
 * ⚠️ 这个文件是"静默死亡"的唯一线索，别把它去掉。
 *
 * 桌面壳是托盘应用，没有控制台，Chromium 的那些关键报错
 * （`GPU process isn't usable. Goodbye.`、`FATAL:...`）全部走 stderr。
 * 之前这里用的是 `stdio: 'ignore'`，等于把最值钱的信息扔进了 NUL ——
 * 表现就是"进程被创建了、没崩、没日志、什么都没有"，完全无从下手。
 */
const LAUNCH_LOG = path.join(ROAMING, 'wallpaper-workshop', 'desktop-launch.log');

const argv = process.argv.slice(2);
const WAIT_LOG = argv.indexOf('--wait') >= 0;
const onlyArg = argv.find((a) => a.indexOf('--only=') === 0);
const ONLY = onlyArg ? Number(onlyArg.split('=')[1]) : 0;

/* ------------------------------ 降级阶梯 ------------------------------ */

/*
 * 每一档都会额外带上这个环境变量（见文件头第 4 条）。
 * 它是 GamePP 那个 Vulkan 层自己的关闭开关，不带的话本机上大概率还是起不来。
 */
const BASE_ENV = { DISABLE_GAMEPP_LAYER: '1' };

/*
 * ═══════════════════════════════════════════════════════════════════════════
 * 必须先清掉的环境变量 —— 不清的话子进程会"静默秒退"
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 血泪教训：启动器如果用 `Object.assign({}, process.env, ...)` 把父进程的
 * 整个环境原样传给子进程，那么**父进程被谁拉起来的**就会影响子进程。
 *
 * 实测（本机复现）：
 *   终端里有 NODE_OPTIONS=--require=...（各种 CLI 工具、AI 助手、nvm 都会注入）
 *   → Electron 退化成**纯 Node 模式**
 *   → 它不认 `--enable-logging`，报 `xxx.exe: bad option: --enable-logging`
 *   → **退出码 9、零日志、零崩溃转储**
 *   → 现象就是"双击没反应、日志里连 boot 都没有"，极难定位
 *
 * `ELECTRON_RUN_AS_NODE` 是 Electron 官方的"以 Node 模式运行"开关，
 * 单独设它就 100% 复现上面那条报错。某些 CLI 的 shim 会顺手把它设上。
 *
 * 所以这里显式删掉，让子进程回到"干净 Electron"的状态。
 * 删掉的变量会打印出来 —— 以后再见"秒退"就能一眼看出是不是又中招了。
 */
const HOSTILE_ENV = [
  'NODE_OPTIONS',           // 打包版 Electron 本来就不支持，某些 shim 还会借此改成 Node 模式
  'ELECTRON_RUN_AS_NODE',   // 一设就变纯 Node，最致命的一个
  'ELECTRON_NO_ATTACH_CONSOLE',
  'ELECTRON_FORCE_WINDOW_MENU_BAR',
  'ELECTRON_ENABLE_STACK_DUMPING',
  // 父进程传进来的先清掉 —— 下面 buildChildEnv 会按我们的需要自己设一个。
  // （不是因为它有害，而是因为"子进程环境由启动器说了算"这条原则。）
  'ELECTRON_ENABLE_LOGGING',
];

/*
 * 日志开关的取值：
 *   'env'  （默认）用 ELECTRON_ENABLE_LOGGING=1 —— 有日志，**不弹黑窗口**
 *   'cli'  （WW_DEBUG=1）额外加命令行 --enable-logging —— 日志最全，但会弹黑窗口
 *   'off'  （WW_NO_LOG=1）完全不抓
 *
 * 为什么默认不用命令行开关，见文件顶部第 5 条（实测数据）。
 */
const LOG_MODE = process.env.WW_NO_LOG === '1'
  ? 'off'
  : (process.env.WW_DEBUG === '1' ? 'cli' : 'env');

/** 当前进程环境里有哪些污染变量（进降级循环之前先报一次，见 main） */
function hostilePresent() {
  return HOSTILE_ENV.filter((k) => process.env[k] !== undefined);
}

/** 返回一份干净的子进程环境，并报告清掉了哪些 */
function buildChildEnv(attemptEnv) {
  const env = Object.assign({}, process.env, BASE_ENV, attemptEnv);
  const removed = [];
  for (const k of HOSTILE_ENV) {
    if (env[k] !== undefined) {
      delete env[k];
      removed.push(k);
    }
  }
  // 日志：用环境变量而不是命令行开关，避免 Chromium 给每个进程都开一个控制台窗口
  if (LOG_MODE !== 'off') env.ELECTRON_ENABLE_LOGGING = '1';
  return { env, removed };
}

/*
 * 顺序有讲究：从"最接近当前构建的默认行为"开始，逐步放宽。
 *
 * 第 1 档就是当前构建的行为（main.js 里已经会设 DISABLE_GAMEPP_LAYER，
 * 这里再设一次是为了让**没重新构建的旧 exe** 也能沾上光）。
 * 后面几档是在"换了显卡驱动""游戏++ 换了版本"之类的变数下留的退路。
 */
const ATTEMPTS = [
  {
    name: '屏蔽游戏++悬浮窗层 + 关硬件加速 + --disable-gpu-sandbox（推荐）',
    args: [],
    env: {},
  },
  {
    name: '屏蔽游戏++悬浮窗层 + GPU 进程放进主进程（--in-process-gpu）',
    args: ['--in-process-gpu'],
    env: {},
  },
  {
    name: '屏蔽游戏++悬浮窗层 + 打开硬件加速（WW_HW_ACCEL=1）',
    args: [],
    env: { WW_HW_ACCEL: '1' },
  },
  {
    name: '屏蔽游戏++悬浮窗层 + 打开硬件加速 + 恢复 GPU 沙箱（最接近默认 Electron）',
    args: [],
    env: { WW_HW_ACCEL: '1', WW_GPU_SANDBOX: '1' },
  },
  {
    name: '彻底不碰 GPU（--disable-gpu --disable-gpu-compositing，纯软件渲染）',
    args: ['--disable-gpu', '--disable-gpu-compositing'],
    env: {},
  },
];

/**
 * 找一找这台机器上有没有装游戏++、并且注册了全局 Vulkan 层。
 *
 * 只查文件系统，不碰注册表 —— 注册表那条路要 reg.exe，
 * 在受限环境里不一定能跑，而文件在不在是同等有效的证据。
 */
function detectGamePP() {
  const programData = path.join(process.env.ProgramData || 'C:\\ProgramData', 'GamePPSdk');
  const local = path.join(process.env.LOCALAPPDATA || '', 'GamePPSDK');
  const hits = [];
  for (const [root, registered] of [[programData, true], [local, false]]) {
    let versions = [];
    try {
      versions = fs.readdirSync(root);
    } catch (e) {
      continue;
    }
    for (const v of versions) {
      const json = path.join(root, v, 'vulkan', 'GPP_VKLayer64.json');
      if (fs.existsSync(json)) hits.push({ json, registered });
    }
  }
  return hits;
}

/** desktop.log 里出现这一行 = 窗口与托盘都建好了 = 启动成功 */
const SUCCESS_MARKER = '] window ';
const PER_ATTEMPT_TIMEOUT = 12000;

/* ------------------------------ 工具 ------------------------------ */

function die(msg) {
  console.error('\n  [x] ' + msg + '\n');
  process.exit(1);
}

if (process.platform !== 'win32') die('这个脚本只用于 Windows。');
if (!fs.existsSync(EXE)) {
  die('找不到：' + EXE + '\n' +
    '\n      先构建一次（只出目录版，不跑 NSIS，快很多）：' +
    '\n          npm run dist:dir\n');
}

function logSize() {
  try {
    return fs.statSync(LOG).size;
  } catch (e) {
    return 0;
  }
}

/** 按**字节**偏移读新增内容（日志里有中文，不能按字符下标切） */
function readFrom(byteOffset) {
  try {
    return fs.readFileSync(LOG).slice(byteOffset).toString('utf8');
  } catch (e) {
    return '';
  }
}

function probePort(port, timeout) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/api/status', timeout: timeout || 1500 },
      (res) => { res.resume(); resolve(res.statusCode || 0); }
    );
    req.on('error', () => resolve(0));
    req.on('timeout', () => { req.destroy(); resolve(0); });
  });
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return false; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 把所有本应用的进程干掉，避免上一次尝试的单实例锁挡住下一次 */
function killAll() {
  try {
    spawnSync('taskkill', ['/IM', APP_NAME + '.exe', '/F', '/T'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } catch (e) { /* 没有进程时 taskkill 会返回非 0，忽略 */ }
}

/** 读子进程的 stdout/stderr（可能很大，只留尾部） */
function readLaunchLog(maxBytes) {
  try {
    const buf = fs.readFileSync(LAUNCH_LOG);
    const tail = buf.slice(Math.max(0, buf.length - (maxBytes || 4000)));
    return tail.toString('utf8').trim();
  } catch (e) {
    return '';
  }
}

/**
 * 轮询日志，直到出现成功标记、进程死掉、或超时。
 *
 * `isDead` 是让失败路径变快的：进程都退出了还硬等 12 秒没意义。
 * 但退出后要多给 800ms —— 日志是同步写盘，stderr 可能还在管道里。
 */
async function waitForMarker(fromBytes, timeoutMs, isDead) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (readFrom(fromBytes).indexOf(SUCCESS_MARKER) >= 0) return true;
    if (isDead && isDead()) {
      await sleep(800);
      return readFrom(fromBytes).indexOf(SUCCESS_MARKER) >= 0;
    }
    await sleep(400);
  }
  return readFrom(fromBytes).indexOf(SUCCESS_MARKER) >= 0;
}

/* ------------------------------ 主流程 ------------------------------ */

async function tryOnce(attempt) {
  const before = logSize();

  // 每次尝试单独一份 stderr 捕获，免得几次的输出混在一起
  let outFd = null;
  try {
    outFd = fs.openSync(LAUNCH_LOG, 'w');
  } catch (e) { /* 打不开就退回忽略，不能让启动器自己挂掉 */ }

  const { env: childEnv, removed } = buildChildEnv(attempt.env);

  /*
   * 注意这里**默认不带 `--enable-logging`**。
   * 那个命令行开关会让 Chromium 给主进程和每个子进程各开一个控制台窗口
   * （桌面上多出一堆关不掉的黑窗口）。日志改由环境变量
   * `ELECTRON_ENABLE_LOGGING=1` 提供，内容一样多、但没有窗口。
   * 详见文件顶部第 5 条。WW_DEBUG=1 时才把命令行开关加回来。
   */
  const logArgs = LOG_MODE === 'cli' ? ['--enable-logging'] : [];

  let child;
  try {
    child = spawn(EXE, logArgs.concat(attempt.args), {
      cwd: APP_DIR,
      detached: true,
      stdio: outFd === null ? 'ignore' : ['ignore', outFd, outFd],
      env: childEnv,
      windowsHide: true,
    });
    /*
     * spawn 是异步的：CreateProcess 失败（被杀软拦、文件被占用、
     * 沙箱禁止执行…）不会在这里抛异常，而是走 'error' 事件。
     * 必须等它一下，否则会报"启动成功"其实压根没起来。
     */
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
  } catch (e) {
    if (outFd !== null) { try { fs.closeSync(outFd); } catch (_) {} }
    return { ok: false, reason: '拉起进程失败：' + (e && e.message), log: '', stderr: '' };
  }
  if (outFd !== null) { try { fs.closeSync(outFd); } catch (_) {} }
  child.unref();

  /*
   * 记录退出情况。这一条能把三种失败区分开：
   *   进程还活着但没出 window  → 卡住了
   *   退出了，退出码非 0        → 崩了（去 CrashDumps / 事件日志找）
   *   退出了，退出码 0 且没日志 → 被外部静默终止，或单实例锁挡掉
   */
  let exitInfo = null;
  child.once('exit', (code, signal) => { exitInfo = { code, signal }; });

  const ok = await waitForMarker(before, PER_ATTEMPT_TIMEOUT, () => exitInfo !== null);
  const newLog = readFrom(before).trim();
  const stderr = readLaunchLog();

  if (ok) return { ok: true, pid: child.pid, log: newLog, stderr: stderr };

  // 没等到 window → 判定这次配置不行，先清干净再进下一档
  killAll();
  await sleep(600);

  let reason;
  if (exitInfo) {
    reason = '进程退出了（退出码 ' + exitInfo.code +
      (exitInfo.signal ? '，信号 ' + exitInfo.signal : '') + '），没有出现 window 那一行';
  } else {
    reason = '12 秒内没有出现 window 那一行（进程还活着，像是卡住了）';
  }
  return { ok: false, reason: reason, log: newLog, stderr: stderr };
}

(async function main() {
  console.log('');
  console.log('  启动：' + EXE);
  console.log('  （绕开 ShellExecute，不会弹 SmartScreen）');
  console.log('');

  /*
   * ═══════════════════════════════════════════════════════════════════════
   * 先花 10 毫秒确认「这个目录里能不能跑程序」
   * ═══════════════════════════════════════════════════════════════════════
   *
   * 2026-10-01 踩到的大坑：产物完全正常，但所在的目录跑不了 exe。
   * 症状是"进程被创建 → 立刻退出 → 退出码 1 或 0x80000003"，
   * 而且**没有 stderr、没有日志、没有转储、事件查看器里也没有记录** ——
   * 看起来和应用崩溃一模一样，能把人往完全错误的方向带几个小时。
   *
   * 判据很简单：把系统自带的 hostname.exe 复制进来跑一下。
   * 它都跑不起来 → 就是这个目录的问题，跟应用一点关系都没有，5 档也不用试了。
   *
   * 当天最终定位到的原因是**目录的完整性标签被设成了 Low**
   * （**谁打的还没查出来** —— 曾经归因给 DSH 的 ACL 沙箱，但 2026-10-01 二次取证
   *   证伪了：DSH 的沙箱用受限令牌 + DACL 能力 SID，不碰完整性标签，
   *   实测它往 Low / Medium / 无标签目录都能写。详见 scripts/fix-integrity.js 顶部）。
   * ⚠️ 注意：Low 只对"要跑 exe 的目录"有害，只该修"里面有 exe/dll"的目录；
   *    `npm run fix:integrity` 会自动区分这两类。
   * 探针会自己把这个标签读出来并写进 detail，所以这里不再重复解释。
   */
  /*
   * 🛡️ 先自动修一遍再探：产物目录如果带 Low 标签，直接改回 Medium。
   *
   * `Low` 的来源查不出来（见 scripts/lib/exec-probe.js 顶部的查证结论：
   * 微软文档说"低完整性进程创建的对象会自动带 Low"，但**没有任何公开清单**
   * 说明是哪个软件干的），所以"**发现即修复**"比"抓凶手"靠谱得多。
   * 只做单向修复：Low → Medium；已经是 Medium / 无标签 / High 的一律不动。
   */
  const autoFix = ensureDirRunnable(APP_DIR);
  if (autoFix.changed) {
    console.log('  [!] 产物目录带了 Low 完整性标签 —— 已自动改回 Medium。');
    console.log('      带 Low 的话，里面的 exe 会以低完整性进程运行 → 一启动就失败，');
    console.log('      而且零 stderr / 零日志 / 零转储，看起来跟应用崩溃一模一样。');
    console.log('      （标签来源至今不明；详见启动失败诊断报告第十二节。）');
    console.log('');
  } else if (autoFix.reason.indexOf('自动修复失败') >= 0) {
    console.log('  [!] ' + autoFix.reason);
    console.log('      手动修：icacls "' + APP_DIR + '" /setintegritylevel (OI)(CI)M');
    console.log('');
  }

  const dirProbe = probeExecutable(APP_DIR);
  if (dirProbe.ran && !dirProbe.ok) {
    console.log('  [x] ' + dirProbe.detail);
    console.log('');
    console.log('      这个目录里跑不了 exe —— 产物本身没问题，但放这里起不来。');
    console.log('      别再去查代码/依赖/显卡/注入，那些都不是原因。');
    console.log('');
    if (dirProbe.integrity && dirProbe.integrity.low) {
      console.log('      一条命令就能修：');
      console.log('        npm run fix:integrity');
      console.log('');
    } else {
      console.log('      换个目录即可（默认目录不受影响）：');
      console.log('        set WW_OUT_DIR=C:\\WallpaperWorkshop\\app');
      console.log('        npm run dist:dir');
      console.log('');
    }
    process.exit(2);
  }
  if (!dirProbe.ok) {
    // 探针自己没跑起来（例如没权限往该目录写文件）——不能据此下结论，继续试
    console.log('  [i] 目录探测没做成：' + dirProbe.detail);
    console.log('');
  }

  const gamepp = detectGamePP();
  if (gamepp.length) {
    console.log('  [!] 检测到游戏++的全局 Vulkan 层：');
    gamepp.forEach((h) => console.log(
      '        ' + h.json + (h.registered ? '   ← 注册表登记的就是这一份' : '')));
    console.log('      它会被 Chromium 的 GPU 子进程自动加载，是"双击没反应"的已知原因。');
    console.log('      本次启动已设 DISABLE_GAMEPP_LAYER=1 把它屏蔽掉（只影响本应用）。');
    console.log('');
  } else {
    console.log('  [i] 没发现游戏++的 Vulkan 层。');
    console.log('');
  }

  const list = ONLY ? [ATTEMPTS[ONLY - 1]].filter(Boolean) : ATTEMPTS;
  if (!list.length) die('--only 取值 1..' + ATTEMPTS.length);

  /*
   * 污染变量要在**进降级循环之前**报出来。
   * 如果等 5 档全败才说"哦对了你的终端里有 NODE_OPTIONS"，
   * 那 60 秒就白等了 —— 而且那个报错长得完全不像环境问题。
   */
  const hostile = hostilePresent();
  if (hostile.length) {
    console.log('  [!] 你的终端里有会干扰 Electron 的环境变量，已从子进程里清掉：');
    hostile.forEach((k) => {
      const raw = String(process.env[k] || '');
      const shown = raw.length > 96 ? raw.slice(0, 93) + '...' : raw;
      console.log('        ' + k + (shown ? ' = ' + shown : ''));
    });
    console.log('      不清的话 Electron 会退化成纯 Node 模式：不认 --enable-logging，');
    console.log('      退出码 9、零日志、零崩溃转储 —— 表现就是"双击没反应"。');
    console.log('');
  }

  let last = null;
  let usedIndex = -1;

  for (let i = 0; i < list.length; i++) {
    const attempt = list[i];
    const label = ONLY ? attempt.name : '[' + (i + 1) + '/' + list.length + '] ' + attempt.name;
    console.log('  ' + label);

    const r = await tryOnce(attempt);
    last = r;

    if (r.log) {
      r.log.split(/\r?\n/).forEach((line) => console.log('        ' + line));
    }

    if (r.ok) {
      usedIndex = i;
      break;
    }

    console.log('        → 这一档不行：' + r.reason);
    if (r.stderr) {
      console.log('        ┌─ 子进程 stderr（关键线索，已存 ' + LAUNCH_LOG + '）');
      r.stderr.split(/\r?\n/).slice(-12).forEach((line) => {
        console.log('        │ ' + line);
      });
      console.log('        └─');
    }
    console.log('');
  }

  console.log('');

  if (usedIndex < 0) {
    const sawBoot = !!(last && last.log.indexOf('] boot ') >= 0);

    console.log('  [x] ' + list.length + ' 套配置都起不来。');
    console.log('');

    if (!sawBoot) {
      console.log('      ⚠️ 日志里连 `beacon` / `boot` 都没有 —— 进程被创建了，但没执行到 main.js。');
      console.log('');
      console.log('         先看子进程的 stderr（就是上面那段，完整内容在 desktop-launch.log）：');
      console.log('           有 `bad option:` 之类 + 退出码 9 → 环境变量污染（NODE_OPTIONS / ELECTRON_RUN_AS_NODE）');
      console.log('           什么都没有、退出码是 1 或 0x80000003 → 大概率是目录禁止执行（见下）');
      console.log('           （想让 stderr 更啰嗦：WW_DEBUG=1 重跑一次，会额外开 --enable-logging）');
      console.log('');
      console.log('         再确认这个目录能不能执行程序 —— 把系统自带的 where.exe 复制进去跑一下：');
      console.log('           copy "%SystemRoot%\\System32\\where.exe" "' + APP_DIR + '\\probe.exe"');
      console.log('           cd /d "' + APP_DIR + '" && probe.exe cmd.exe');
      console.log('         它都跑不起来 → 目录问题，换个目录（set WW_OUT_DIR=...）即可。');
      console.log('');
      console.log('         其他可能：');
      console.log('           1. 被杀软 / 注入器静默终止（不会有转储，事件日志里也没有记录）');
      console.log('           2. 单实例锁：托盘里已经有一个实例在跑');
      console.log('           3. exe 依赖的 DLL 加载失败');
      console.log('');
      console.log('         子进程的 stderr 完整内容在：' + LAUNCH_LOG);
    } else {
      console.log('      `boot` 有，但没到 `window` → 死在 Electron 初始化或后端启动阶段。');
      console.log('      上面那段日志就是断点位置。');
    }

    console.log('');
    console.log('      桌面日志：' + LOG);
    console.log('      事件日志：事件查看器 → Windows 日志 → 应用程序（找「应用程序错误」）');
    console.log('');
    process.exit(1);
  }

  const httpCode = await probePort(PORT);
  const win = list[usedIndex];

  console.log('  [√] 启动成功。');
  if (httpCode === 200) {
    console.log('      接口 http://127.0.0.1:' + PORT + '/api/status 返回 200。');
  } else {
    console.log('      进程活着，但接口返回 ' + httpCode + '，看日志里的 backend-failed。');
  }
  console.log('');
  console.log('      生效的配置：' + win.name);
  if (usedIndex === 0 && gamepp.length) {
    console.log('');
    console.log('      ✔ 第 1 档就过了，而且这台机器上确实装着游戏++的 Vulkan 层 ——');
    console.log('        基本可以确认"以前能开、现在开不了"就是它干的。');
  }
  if (usedIndex > 0 && !ONLY) {
    console.log('      ⚠️ 说明默认那套在这台机器上不行。想以后一次就中，');
    console.log('         把这一档的环境变量写进「启动桌面版.cmd」或 package.json 的脚本里。');
  }
  console.log('');
  console.log('  数据目录：' + path.dirname(LOG));
  console.log('');

  if (WAIT_LOG) {
    console.log('  ── 跟随日志（Ctrl+C 只停止跟随，不会关掉应用） ──');
    let cursor = logSize();
    setInterval(() => {
      const chunk = readFrom(cursor);
      if (chunk) {
        cursor += Buffer.byteLength(chunk, 'utf8');
        process.stdout.write(chunk);
      }
    }, 500);
    return;
  }

  process.exit(0);
})();
