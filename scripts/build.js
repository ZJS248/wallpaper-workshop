#!/usr/bin/env node
'use strict';

/**
 * electron-builder 包装器：统一在这里指定下载源。
 *
 * 为什么需要它：electron-builder 默认从 GitHub Releases 拉 electron 运行时 zip，
 * 以及 nsis / winCodeSign 等工具链。直连 GitHub 经常在传输中被重置
 * （wsarecv: An existing connection was forcibly closed by the remote host）。
 * 这里的两个环境变量会被 electron 侧的 @electron/get（Go 版 app-builder）识别：
 *
 *   ELECTRON_MIRROR                  electron 运行时 zip
 *   ELECTRON_BUILDER_BINARIES_MIRROR nsis / nsis-resources / winCodeSign
 *
 * 已存在的同名环境变量优先，所以临时换源不用改代码：
 *   $env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'; npm run dist
 *
 * 用法：node scripts/build.js [electron-builder 的全部参数]
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const MIRRORS = {
  ELECTRON_MIRROR: 'https://cdn.npmmirror.com/binaries/electron/',
  ELECTRON_BUILDER_BINARIES_MIRROR: 'https://cdn.npmmirror.com/binaries/electron-builder-binaries/',
};

const env = { ...process.env };
for (const [key, fallback] of Object.entries(MIRRORS)) {
  if (!env[key]) {
    env[key] = fallback;
  }
  console.log(`  ${key}=${env[key]}`);
}

/*
 * 强制给构建一个 TEMP —— 这条是打包能不能成功的关键。
 *
 * 症状：`npm run dist` 前面全部正常（packaging 出了 dist\win-unpacked\*.exe），
 * 到 NSIS 那一步弹出模态框：
 *     NSIS Error
 *     Error writing temporary file. Make sure your temp folder is valid.
 * 然后 `Exit code: 2. Command failed: dist\WallpaperWorkshop Setup 1.0.0.exe`。
 *
 * ⚠️ 这里改过一次结论，别照着旧说法排查。
 *
 * 最初判断是"系统 TEMP 臃肿"（当时实测 105,447 个文件 / 14.7 GB，NSIS 解不开）。
 * **这个判断是错的**：把 TEMP 清到 1,519 个文件 / 0.31 GB 之后，用系统 TEMP
 * 打包**依然报同一个错**。
 *
 * 目前实测到的唯一规律，是 TEMP 的**位置**，不是它的状态：
 *     TEMP = <项目内>\.build-temp        → ✅ 成功
 *     TEMP = C:\Users\...\AppData\Local\Temp（已清理）→ ❌ 同一个弹窗
 *     TEMP = C:\wwprobe-temp（全新空目录，30MB 写入正常）→ ❌ 同一个弹窗
 * 也就是说只有**落在工作区里**的 TEMP 能过；写到工作区外的任何目录都不行
 * （哪怕那个目录是空的、且普通写 30MB 完全正常）。
 * 最可能是 DSH 的文件沙箱只放行工作区内的路径，而 NSIS 是 electron-builder
 * 拉起的**子进程**、不在这条豁免里。真正的成因还没定位到，先按"位置"这个
 * 已验证的规律绕开。
 *
 * 生命周期：**构建前清空 + 构建后整目录删除**，两头都管，中间不留痕。
 *   - 构建前清空：上一次如果被 Ctrl+C 掐死，finally 没机会跑，得先把残骸扫掉；
 *   - 构建后删除：NSIS 解包那几十 MB 不留在项目里。
 * 只清这一个目录，不碰用户的系统 TEMP —— 见下面 buildTempOwned 的注释。
 */
const BUILD_TEMP = path.join(__dirname, '..', '.build-temp');
/*
 * 只有真的把目录建出来、并且确实把 env.TEMP 改指过去，才允许收尾时删它。
 * 万一 mkdir 失败，env.TEMP 还是用户的系统 TEMP —— 这时候要是"顺手"
 * fs.rmSync(env.TEMP) 就会把人家整个临时目录删了。这个标志就是防这个的。
 */
let buildTempOwned = false;
try {
  fs.rmSync(BUILD_TEMP, { recursive: true, force: true });
  fs.mkdirSync(BUILD_TEMP, { recursive: true });
  env.TEMP = BUILD_TEMP;
  env.TMP = BUILD_TEMP;
  buildTempOwned = true;
  console.log(`  TEMP=${env.TEMP}（构建专用，结束即删）`);
} catch (e) {
  console.warn(`  建不了构建专用 TEMP，沿用系统 TEMP：${e.message}`);
}

/** 收尾：把构建专用 TEMP 整个删掉，不留目录 */
function cleanupBuildTemp() {
  if (!buildTempOwned) return; // 没接管过 TEMP，这里绝不能碰任何东西
  try {
    fs.rmSync(BUILD_TEMP, { recursive: true, force: true });
  } catch (e) {
    console.warn(`  构建临时目录没清掉（${BUILD_TEMP}）：${e.message}，下次构建前会再扫一遍`);
  }
}

// stdio: 'inherit' —— 直接继承终端，app-builder 的实时进度才能刷出来
let result;
try {
  result = spawnSync(process.execPath, [require.resolve('electron-builder/out/cli/cli.js'), ...process.argv.slice(2)], {
    stdio: 'inherit',
    env,
  });
} finally {
  // 成功、失败、异常都走到这里。Ctrl+C 掐不死（finally 不跑），那种情况
  // 靠上面"构建前清空"兜底。
  cleanupBuildTemp();
}

if (result.error) {
  console.error(result.error);
  process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);
