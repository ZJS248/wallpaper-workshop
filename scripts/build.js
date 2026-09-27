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

// stdio: 'inherit' —— 直接继承终端，app-builder 的实时进度才能刷出来
const result = spawnSync(process.execPath, [require.resolve('electron-builder/out/cli/cli.js'), ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);
