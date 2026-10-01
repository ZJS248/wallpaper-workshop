#!/usr/bin/env node
'use strict';

/**
 * 探测「某个目录里能不能执行 exe」。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么需要这个
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 2026-10-01 排查"双击没反应"时踩到的坑：
 * 产物本身完全正常，但**它所在的目录跑不了程序**。
 * 表现是：进程被创建 → 立刻退出 → 退出码 1 或 0x80000003 →
 * **没有 stderr、没有日志、没有崩溃转储、事件查看器里也没有记录**。
 *
 * 这种情况太像"应用崩了"，于是所有排查方向（代码、依赖、GPU、注入）
 * 都是错的，能白白烧掉几小时。
 *
 * 判据其实非常简单：**拿一个系统自带的、绝对没问题的小工具，
 * 复制到这个目录里跑一下。跑不起来 → 就是这个目录的问题，跟应用无关。**
 *
 * 用 `hostname.exe`（System32 自带，无参数，能跑就必打印主机名并退出 0）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 当天晚些时候找到的真正原因：**目录的完整性标签被设成了 Low**
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 不是权限、不是 ACL、不是杀软、不是目录策略 —— 是 SACL 里的强制完整性标签。
 * 详见下面 `getIntegrityLevel()` 的注释，以及 `npm run fix:integrity`。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SYS32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');

/**
 * 探针程序。挑选标准（2026-10-01 修订）：
 *
 *   1. 系统自带（不依赖任何第三方）
 *   2. **无参数**（不依赖当前目录、不依赖 PATH 搜索）
 *   3. 输出确定、退出码确定
 *
 * ⚠️ 早期版本用的是 `where.exe <自己>`，**有假阴性**：
 *    `where` 的退出码 1 只表示"没在 当前目录+PATH 里找到这个名字"，
 *    跟"这个目录禁止执行 exe"没有必然关系。实测在同一个目录下：
 *      hostname.exe（无参）        -> exit=1，无输出     ← 真的跑不起来
 *      where.exe <相对名>          -> exit=1，无输出
 *      where.exe <绝对路径>        -> exit=1，无输出
 *    而在正常目录下 `where.exe <相对名>` 会因为"当前目录里有这个文件"而 exit=0，
 *    看起来像"通过了"，其实测的是别的东西。
 *
 *    换成 `hostname.exe` 后语义才干净：**能跑就必定打印主机名并 exit 0。**
 */
const PROBES = [
  { src: path.join(SYS32, 'hostname.exe'), args: () => [] },
  { src: path.join(SYS32, 'whoami.exe'), args: () => [] },
];

const PROBE_NAME = '__ww_probe__.exe';

/** 同步小睡（探针删除重试要用；Node 里没有同步 sleep，只能自旋） */
function sleepSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* 自旋 */ }
}

/**
 * 删除探针文件，**带重试**。
 *
 * 为什么要重试：刚执行过的 exe，句柄可能还没被系统完全释放，
 * 或者杀软正在做实时扫描短暂持有它 —— 这时 `rmSync` 会抛 EPERM。
 * 早期版本把异常直接吞掉，结果**探针残留在产物目录里**
 * （实测在 `%LOCALAPPDATA%\WallpaperWorkshop\app\__ww_probe__.exe` 见到过）。
 */
function removeProbe(target) {
  for (let i = 0; i < 6; i++) {
    try {
      fs.rmSync(target, { force: true });
      return true;
    } catch (e) {
      sleepSync(60);
    }
  }
  return !fs.existsSync(target);
}

/**
 * 读取目录/文件的「强制完整性标签」（Mandatory Integrity Label）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 2026-10-01 最终定位到的根因
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 目录被打上 `Low` 完整性标签后：
 *   - 放进去的 exe **会自动继承 Low 标签**（`(OI)(CI)` 可继承）
 *   - 执行这种 exe 时，Windows 按"取父子二者中较低者"的规则，
 *     让它以**低完整性进程**运行 → 一启动就失败
 *   - 表现：**退出码 1、零输出、零 stderr、零日志、零转储、事件查看器也没记录**
 *
 * 跟"应用崩了"长得一模一样，能把人往代码/依赖/显卡/注入的方向带偏几小时。
 *
 * ⚠️ 这个标签**用 ACL 查看器看不出来**：它存在 SACL 里，读它需要
 *    `SeSecurityPrivilege`（.NET 的 `DirectorySecurity` 构造会直接抛错）。
 *    **只有 `icacls` 能读**。这就是为什么查了半天 ACL 都查不出所以然。
 *
 * 已知来源：**具体是哪个软件，仍然查不出来**；但**机制上只有两条路径**（2026-10-01 查证）。
 *
 *   微软官方（Event 1037 / Event 1047 文档）原文：
 *     "the integrity mechanism **automatically assigns Low integrity mandatory labels
 *      to securable objects, files, or other objects created by Low integrity-level
 *      processes**."
 *   → **低完整性进程创建的文件/目录，会被自动标成 Low。**
 *
 *   所以 `Low` 只有两种来路：
 *     ① **显式设置** —— `icacls /setintegritylevel Low`，或 `SetNamedSecurityInfo` +
 *        `LABEL_SECURITY_INFORMATION`（需要对象所有者的隐式 WRITE_OWNER，或 SeSecurityPrivilege）；
 *     ② **被一个低完整性进程创建** —— 含"从 `Low` 目录**同卷 move** 过来"
 *        （同卷 move 保留 SACL；跨卷 move 等于复制+删除，新对象会重新继承目标目录的标签）。
 *
 *   已知会以 Low 运行的常见东西：IE 保护模式（LoRIE）、Chromium 的渲染进程
 *   （Chromium 沙箱先给 Low、启动后再降到 Untrusted）、各类"沙箱 / 隔离"软件。
 *   ⚠️ 网上**没有**"哪个软件会给普通目录打 Low"的公开清单 —— 微软文档、
 *      SuperUser / StackOverflow、HackTricks 都只有机制说明，没有案例库。
 *
 *   本地也没抓到：审计日志里 `setintegritylevel` 只出现在 2026-10-01 我自己的会话，
 *   而且我对 YAO/CAO 只用过 `M`、**从没设过 `L`**。
 *
 *   - ❌ 曾经的结论「是 DSH 的 ACL 沙箱打的」**已被证伪**：DSH 的 Windows 沙箱
 *     是 **`WRITE_RESTRICTED` 受限令牌 + 路径派生的能力 SID（`S-1-4-x-y`）的
 *     DACL 授权**，**完全不碰完整性标签** —— 它的实现里 `integrity` 出现 0 次，
 *     整个 `@deepseek-ai/*` 包树里没有任何 `S-1-16-*`。
 *     而且用 DSH 自己的 `AclSandbox` 实测，受限子进程往 **Low / Medium / 无标签**
 *     三种目录写文件**全部成功**。**所以 `Low` 既不是它打的，也不是它需要的。**
 *   - ❌ 「是 Codex 打的」也**从未有过证据**（它只授 DACL）。
 *   - ✅ 能确定的只有 ACL 指纹：`S-1-4-<数字>` 是 **DSH 的工作区写授权**
 *     （用 DSH 自己的 `workspaceWriteSid(路径)` 能算出同一个 SID）。
 *   - 也就是说：**指纹能证明"DSH 在这个目录上授过写"，但证明不了"Low 是谁打的"。**
 *
 * 🛡️ **既然抓不到来源，就别指望抓** —— 改成"**发现即自动修复**"：
 *    见下面的 `ensureDirRunnable()`，构建完 / 启动前调一次，中招也能自己好。
 *
 * 🔴 `Low` 的真实影响（实测）：**只对"要跑 exe 的目录"有害**。
 *    读、写、建目录都正常；只有放进去的 exe 会继承 Low → 以低完整性运行 → 起不来。
 *    所以 `npm run fix:integrity` 只修"里面有 exe/dll"的目录；纯数据目录跳过
 *    （理由是"改了也没意义"，不是"沙箱需要 Low"）。
 *
 * @param {string} target 目录或文件
 * @returns {{level: string|null, flags: string, inherited: boolean, low: boolean, raw: string|null}}
 */
function getIntegrityLevel(target) {
  let out = '';
  try {
    out = String(spawnSync('icacls', [target], { encoding: 'utf8', windowsHide: true }).stdout || '');
  } catch (e) {
    return { level: null, flags: '', inherited: false, low: false, raw: null };
  }
  const line = out.split(/\r?\n/).find((l) => /Mandatory Label/i.test(l));
  if (!line) {
    // 没有标签 = 继承默认（对用户数据就是 Medium），属于正常状态
    return { level: null, flags: '', inherited: false, low: false, raw: null };
  }
  const m = line.match(/(Untrusted|Low|Medium|High|System)\s+Mandatory Level\s*:\s*(.*)$/i);
  if (!m) return { level: null, flags: '', inherited: false, low: false, raw: line.trim() };
  const flags = (m[2] || '').trim();
  const level = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
  return { level, flags, inherited: /\(I\)/i.test(flags), low: /^low$/i.test(level), raw: line.trim() };
}

/**
 * 把目录（及其子项，靠可继承 ACE 自动传播）的完整性标签改回 **Medium**。
 *
 * Medium 就是 Windows 对用户数据的默认级别，所以这是"恢复原状"，不是"放宽权限"。
 * 想回滚：把 M 换成 L 再跑一次即可。
 *
 * @param {string} dir
 * @param {string} [level] 'M'（默认，恢复原状）| 'L'（回滚成沙箱状态）| 'H'
 * @returns {{ok: boolean, code: number|null, out: string}}
 */
function fixIntegrity(dir, level) {
  const r = spawnSync('icacls', [dir, '/setintegritylevel', '(OI)(CI)' + (level || 'M')],
    { encoding: 'utf8', windowsHide: true });
  return {
    ok: r.status === 0,
    code: r.status,
    out: String((r.stdout || '') + (r.stderr || '')).trim(),
  };
}

/**
 * @param {string} dir 要测试的目录
 * @returns {{ok: boolean, ran: boolean, code: number|null, detail: string, integrity?: object}}
 *   ran=true 表示探针**确实跑起来了**（此时 code 才有意义）
 */
function probeExecutable(dir) {
  if (!fs.existsSync(dir)) {
    return { ok: false, ran: false, code: null, detail: '目录不存在：' + dir };
  }

  const probe = PROBES.find((p) => fs.existsSync(p.src));
  if (!probe) {
    return { ok: false, ran: false, code: null, detail: '找不到可用的探针程序（hostname.exe / whoami.exe 都没有）' };
  }

  const target = path.join(dir, PROBE_NAME);
  removeProbe(target);   // 清掉上一次可能残留的探针

  try {
    fs.copyFileSync(probe.src, target);
  } catch (e) {
    return { ok: false, ran: false, code: null, detail: '往该目录写文件失败：' + e.message };
  }

  let r;
  try {
    r = spawnSync(target, probe.args(PROBE_NAME), {
      cwd: dir,
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
    });
  } catch (e) {
    r = { status: null, error: e };
  } finally {
    // 删不掉不影响判定，但会污染产物目录，所以重试几次
    removeProbe(target);
  }

  if (r.error) {
    return { ok: false, ran: false, code: null, detail: '拉不起来：' + r.error.message };
  }
  if (r.status !== 0) {
    /*
     * 跑不起来。先看完整性标签 —— 2026-10-01 实测这是**唯一**的根因，
     * 而且它用 ACL 查看器完全看不出来，所以必须主动去读。
     */
    const il = getIntegrityLevel(dir);
    let detail = '系统自带的 ' + path.basename(probe.src) + ' 在这个目录里都跑不起来（退出码 ' +
      r.status + '，输出为空）';
    if (il.low) {
      detail +=
        '\n        诊断：这个目录带 **Low 完整性标签**（' +
        (il.inherited ? '继承而来' : '显式设置') + '，' + il.flags + '）。' +
        '\n        放在里面的 exe 会自动继承 Low，于是以低完整性进程运行 → 一启动就失败，' +
        '\n        而且零 stderr、零日志、零转储，看起来跟应用崩溃一模一样。' +
        '\n        来源：**不明**。以前的结论"是 DSH 沙箱打的"已证伪 ——' +
        '\n              DSH 的沙箱是受限令牌 + DACL 能力 SID（S-1-4-x-y），不碰完整性标签，' +
        '\n              实测它往 Low / Medium / 无标签目录都能写。' +
        '\n              ACL 上的 S-1-4-<数字> 只能证明"DSH 在这个目录授过写"，不能证明 Low 是谁打的。' +
        '\n        修复：npm run fix:integrity' +
        '\n              或  icacls "' + dir + '" /setintegritylevel (OI)(CI)M' +
        '\n        ⚠️ 只需要改**里面有 exe 的目录**（Low 只对"跑 exe"有害；' +
        '\n           纯数据目录的 Low 读/写/建目录都正常，改了没意义）。' +
        '\n           fix:integrity 现在会自动区分这两类，直接跑它就行。';
    } else if (il.level) {
      detail += '\n        该目录的完整性标签：' + il.raw;
    } else {
      detail += '\n        该目录没有完整性标签（继承默认 = Medium），所以原因不是这个。';
    }
    return { ok: false, ran: true, code: r.status, detail, integrity: il };
  }
  if (!String(r.stdout || '').trim()) {
    return { ok: false, ran: true, code: r.status, detail: '跑起来了但没有任何输出，行为异常' };
  }
  return { ok: true, ran: true, code: 0, detail: '可以执行程序' };
}

/**
 * 确保一个目录里的 exe 能跑：**带 `Low` 标签就自动改回 `Medium`**。
 *
 * 为什么要有这个：`Low` 的来源查不出来（见文件顶部的查证结论），
 * 所以与其指望抓到"凶手"，不如**发现即修复**。
 * 构建完 / 启动前调一次，开销几毫秒，真中招了也能自己好。
 *
 * ⚠️ **只做单向修复**：`Low` → `Medium`（恢复 Windows 对用户数据的默认级别）。
 *    已经是 `Medium` / 无标签 / `High` 的**一律不动** —— 不去"纠正"别人的设置。
 * ⚠️ 目录不存在就直接返回，不报错。
 *
 * @param {string} dir
 * @returns {{changed: boolean, reason: string, before?: object, after?: object}}
 */
function ensureDirRunnable(dir) {
  if (!fs.existsSync(dir)) {
    return { changed: false, reason: '目录不存在，跳过' };
  }
  const before = getIntegrityLevel(dir);
  if (!before.low) {
    return {
      changed: false,
      reason: '标签正常（' + (before.raw || '无标签 = 默认 Medium') + '）',
      before,
    };
  }
  const r = fixIntegrity(dir, 'M');
  const after = getIntegrityLevel(dir);
  if (r.ok && !after.low) {
    return { changed: true, reason: '原本是 Low，已自动改回 Medium', before, after };
  }
  return {
    changed: false,
    reason: '检测到 Low，但自动修复失败：' + (r.out.split('\n')[0] || '未知原因'),
    before,
    after,
  };
}

module.exports = { probeExecutable, getIntegrityLevel, fixIntegrity, ensureDirRunnable };
