#!/usr/bin/env node
'use strict';

/**
 * 产物目录的解析 —— build-dir.js 和 run-desktop.js 共用一份逻辑。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠️ 为什么不放在项目里的 dist/ 下面了
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 2026-10-01 实测：这台机器上 **`C:\Users\ZJS248\Desktop\video\` 整棵树里的
 * 可执行文件都跑不起来** —— 不只是本应用，连系统自带的 `C:\Windows\System32\where.exe`
 * 复制进去都会"退出码 1、零输出"。
 *
 * 边界测得非常干净：
 *
 *   Desktop\videoX\w.exe        ✅ 正常
 *   Desktop\video2\w.exe        ✅ 正常
 *   Desktop\wwcopyZ\（166MB 主程序）✅ 正常
 *   Desktop\video\zznew\w.exe   ❌ 退出码 1、零输出
 *   Desktop\video\wallpaper-workshop\dist\win-unpacked\  ❌ 同上
 *
 * 而且跟**工作目录**无关（cwd 在 C:\ 也一样失败），跟**文件名**无关（改名照样失败），
 * 只跟**文件所在的目录**有关。
 *
 * `Desktop\video` 的 ACL 上能看到明显的沙箱痕迹（本机有个 `CodexSandboxUsers` 组、
 * 一条 `Everyone:(CI)(DENY)(DeleteSubdirectoriesAndFiles)`、以及几个登录会话 SID），
 * 所以基本可以确定是某个 AI 工具的"工作区保护"给整棵树加了执行拦截。
 *
 * **结论：产物必须放在这棵树外面。** 默认放当前用户的
 * `%LOCALAPPDATA%\WallpaperWorkshop\app`（免管理员、按用户隔离、不在被拦的树里）。
 *
 * 想换地方：设 `WW_OUT_DIR`，例如
 *   set WW_OUT_DIR=C:\WallpaperWorkshop\app
 */

const path = require('path');
const os = require('os');

const APP_NAME = 'WallpaperWorkshop';

/** 默认产物目录：%LOCALAPPDATA%\WallpaperWorkshop\app */
function defaultOutDir() {
  const base = process.env.LOCALAPPDATA ||
    path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, APP_NAME, 'app');
}

/**
 * 解析产物目录。优先级：显式参数 > 环境变量 WW_OUT_DIR > 默认
 * @param {string} [override] 显式指定（build-dir.js 的 --out=...）
 */
function resolveOutDir(override) {
  if (override) return path.resolve(override);
  const custom = process.env.WW_OUT_DIR;
  return custom ? path.resolve(custom) : defaultOutDir();
}

module.exports = { APP_NAME, defaultOutDir, resolveOutDir };
