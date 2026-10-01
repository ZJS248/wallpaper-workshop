#!/usr/bin/env node
'use strict';

/**
 * 完整性标签（Mandatory Integrity Label）体检 / 修复。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 症状（要跑 exe 的目录被打了 Low）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   - 双击 exe 没反应 / 秒退，**没有 stderr、没有日志、没有转储**
 *   - 安装包报 `NSIS Error: Error writing temporary file`
 *   - Electron 应用起不来，但"任务栏里其实有进程"
 *   - **换个目录就好了** —— 这是最典型的特征
 *
 * 根因：目录的**强制完整性标签**被设成 `Low`，放进去的 exe 自动继承 Low
 *       → 以低完整性进程运行 → 一启动就失败。
 *
 * 为什么难查：标签在 **SACL** 里，ACL 查看器看不到（读它需要 SeSecurityPrivilege），
 *             **只有 `icacls` 能读**。所以"查权限"永远查不出问题。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 🔴🔴 「Low 是沙箱工作区的正常态、改了会把沙箱弄坏」—— 这个说法是错的
 *      （2026-10-01 二次更正，以 DSH 自己的代码和实测为准）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   2026-10-01 我一度写下这样的结论：
 *     「ACL 沙箱（DSH 等）用低完整性令牌跑命令，按 no-write-up，工作区必须是 Low，
 *       改成 Medium 就会把沙箱弄坏。」
 *
 *   **这个结论是错的。证据（全部可复现）：**
 *
 *   1. 用 DSH 自己的 `AclSandbox`
 *      （`@deepseek-ai/dsh-sandbox-windows-acl`，node_modules 里就有）实测：
 *      受限子进程往 **Low / Medium / 无标签** 三种工作区写文件，**三次全部成功**
 *      （`WRITE_OK`，退出码 0）。
 *   2. DSH 的 Windows 沙箱机制是 **`WRITE_RESTRICTED` 受限令牌 +
 *      由工作区路径确定性派生的能力 SID（`S-1-4-x-y`）的 DACL 授权**，
 *      **完全不碰完整性标签**：
 *        - `dsh-sandbox-windows-acl/lib/types-*.js` 里 `integrity` 出现 **0 次**；
 *        - 整个 `@deepseek-ai/*` 包树里 **`S-1-16-*` 一个都没有**；
 *        - 唯一的 `SetTokenInformation` 调用是 `TokenDefaultDacl`（不是 TokenIntegrityLevel）。
 *      官方中文 README（`dsh-sandbox-windows-acl/README.zh.md`）通篇也只讲 ACL 与受限令牌。
 *   3. 反证：`Desktop\video` 是 **Medium**，DSH 的工作区 ACE
 *      `S-1-4-116767578-204116286:(OI)(CI)(W,D,DC)` 照样在、照样生效
 *      —— 用 DSH 自己的 `workspaceWriteSid('C:\Users\ZJS248\Desktop\video')`
 *      能算出这个 SID，与 ACL 里那条逐字符相同。
 *
 *   → **`Low` 对沙箱工作区既不是必需的，也不是沙箱打的。**
 *
 *   那 `Low` 还有没有害？**有，但只对"要跑 exe 的目录"有害**：
 *   新放进去的 exe 会继承 Low → 以低完整性进程运行 → 一启动就失败（见上面症状）。
 *
 *   所以本脚本的策略不变，但**理由变了**：
 *     | 目录类型                        | 怎么办                                  |
 *     | ------------------------------- | --------------------------------------- |
 *     | 含 exe/dll 的 Low 目录          | **修成 Medium** —— 真的有害             |
 *     | 纯数据目录的 Low                | **跳过** —— 不是"沙箱需要它"，而是      |
 *     |                                 | 它对纯数据无害，没必要去动别人的 ACL    |
 *
 *   ⚠️ 保留 2026-10-01 的翻车记录，当作"别急着下结论"的教训：
 *      我把 4 个目录一起改成 Medium 后，DSH 报过一次「工作区不可写」，
 *      我就认定是标签造成的。**实际不是**：
 *        - 失败的那 2 个 `.lrc` 与同目录正常文件的 ACL **逐条完全相同**
 *          （都带 DSH 的 `(W,D,DC)` 授权和 `ZJS248:(F)`）；
 *        - 而且后来 **11:37 就写成功了**（20385 → 20386 字节，补上了换行）；
 *        - 那是**瞬时文件占用**（子代理/工作流进程还握着句柄），不是权限。
 *      真正的教训：**先做对照实验（改前/改后、失败对象/正常对象），再下结论。**
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 用法
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   npm run fix:integrity               扫描桌面 + 项目所在目录树（只改含 exe 的）
 *   npm run fix:integrity -- --dry      只扫描不修改
 *   npm run fix:integrity -- <目录>…    只处理指定目录
 *   npm run fix:integrity -- --force    连"没有 exe 的目录"也一起改（不必需；纯数据目录的 Low 无害）
 *   npm run fix:integrity -- --deep     连同子项一起强制重设（慢，一般不需要）
 *   npm run fix:integrity -- --restore  把含 exe 的目录改回 Low（一般用不到）
 *
 * 说明：
 *   - Medium 是 Windows 对用户数据的**默认**级别，所以这是"恢复原状"，不是放宽权限。
 *   - 子项靠可继承 ACE 自动跟随，**一般不用 --deep**。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { getIntegrityLevel, fixIntegrity } = require('./lib/exec-probe');

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const DEEP = argv.includes('--deep');
const FORCE = argv.includes('--force');
const RESTORE = argv.includes('--restore');
const TARGET_LEVEL = RESTORE ? 'L' : 'M';
const TARGET_NAME = RESTORE ? 'Low' : 'Medium';
const explicit = argv.filter((a) => !a.startsWith('--'));

const PROJECT_DIR = path.resolve(__dirname, '..');
const HOME = os.homedir();

function line(s) { process.stdout.write(s + '\n'); }

function safeReaddir(dir) {
  try { return fs.readdirSync(dir); } catch (e) { return []; }
}

/**
 * 目录里有没有可执行文件（exe / dll / com / scr / msi）。
 * 只用来"分类"，所以找到几个就够 —— 有早退和上限，不会扫穿整个盘。
 */
function findExecutables(dir, maxExamples) {
  const want = maxExamples || 3;
  const found = [];
  let visited = 0;
  const LIMIT = 40000;
  const stack = [dir];

  while (stack.length) {
    const cur = stack.pop();
    let names;
    try { names = fs.readdirSync(cur, { withFileTypes: true }); } catch (e) { continue; }
    for (const ent of names) {
      if (++visited > LIMIT) return { hit: found.length > 0, found, truncated: true };
      const p = path.join(cur, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === '$RECYCLE.BIN' || ent.name === 'System Volume Information') continue;
        stack.push(p);
      } else if (/\.(exe|dll|com|scr|msi)$/i.test(ent.name)) {
        found.push(p);
        if (found.length >= want) return { hit: true, found, truncated: false };
      }
    }
  }
  return { hit: found.length > 0, found, truncated: false };
}

/** 这个目录是不是某个 ACL 沙箱登记过的工作区？ */
function findSandboxOwner(dir) {
  const owners = [];
  const norm = (s) => String(s).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  const me = norm(dir);

  // DSH（DeepSeek Harness）：把路径编码成 sessions 目录名，形如
  //   --C-Users-ZJS248-Desktop-YAO--              （ASCII 部分：\ → -）
  //   --C-Users-ZJS248-Desktop-~6587~6863--       （非 ASCII：~XXXX~ = UTF-16 码元，大写十六进制）
  // 反向解码有歧义（目录名里本来就有 -），所以改用**正向编码后精确比对**。
  try {
    const enc = (p) => {
      let mid = norm(p).split('').map((ch) => {
        const c = ch.charCodeAt(0);
        if (c === 0x5c || c === 0x3a) return '-';   // \ 和 : 都变成 -
        if (c > 0x7e || c < 0x20) return '~' + c.toString(16).toUpperCase().padStart(4, '0') + '~';
        return ch;
      }).join('');
      mid = mid.replace(/-+/g, '-');                 // 盘符后的 ":\" 会连出两个 -，压成一个
      return '--' + mid + '--';
    };
    const want = enc(me);
    for (const name of safeReaddir(path.join(HOME, '.dsh', 'sessions'))) {
      if (name.toLowerCase() === want) { owners.push('DSH'); break; }
    }
  } catch (e) { /* 没装 DSH */ }

  // Codex（它只授 DACL、不打标签，但登记过的目录同样值得提示）
  try {
    const f = path.join(HOME, '.codex', 'cap_sid');
    const s = fs.readFileSync(f, 'utf8');
    const re = /"([A-Za-z]:[\\/][^"]{2,200})"/g;
    let m;
    while ((m = re.exec(s))) {
      if (norm(m[1]) === me) { owners.push('Codex'); break; }
    }
  } catch (e) { /* 没装 Codex */ }

  return owners;
}

/** 收集要检查的目录：项目自身 + 它的各级父目录（到用户主目录为止）+ 桌面的第一层子目录 */
function collectTargets() {
  if (explicit.length) return explicit.map((p) => path.resolve(p));

  const set = new Set();
  set.add(PROJECT_DIR);

  let cur = PROJECT_DIR;
  while (cur && cur !== HOME && cur !== path.dirname(cur)) {
    set.add(cur);
    cur = path.dirname(cur);
  }

  const desktop = path.join(HOME, 'Desktop');
  if (fs.existsSync(desktop)) {
    set.add(desktop);
    for (const name of safeReaddir(desktop)) {
      const p = path.join(desktop, name);
      try { if (fs.statSync(p).isDirectory()) set.add(p); } catch (e) { /* 跳过 */ }
    }
  }

  return [...set];
}

function main() {
  line('');
  line('  ┌─ 完整性标签体检 ' + (DRY ? '(只扫描，不修改)' : '(扫描 + 修复)'));
  line('  │  Medium = Windows 对用户数据的默认级别（exe 能跑）');
  line('  │  Low    = exe 全部跑不起来（对纯数据目录无害）');
  line('  └─ 用 icacls 读取（这个标签在 ACL 资源管理器里看不到）');
  line('');

  const targets = collectTargets();
  const needFix = [];
  const keepLow = [];
  const ok = [];
  const skipped = [];

  for (const dir of targets) {
    if (!fs.existsSync(dir)) { skipped.push(dir); continue; }
    const il = getIntegrityLevel(dir);

    // --restore：反向找"含 exe 但已经不是 Low"的目录，把它们改回 Low。
    // ⚠️ 不加这个分支的话 --restore 永远扫不到东西（它想要的目标恰好是 il.low === false）。
    if (RESTORE) {
      if (il.low) { ok.push({ dir, il }); continue; }
      const ex = findExecutables(dir, 3);
      if (ex.hit) needFix.push({ dir, il, ex, owners: findSandboxOwner(dir) });
      else ok.push({ dir, il });
      continue;
    }

    if (!il.low) { ok.push({ dir, il }); continue; }

    const ex = findExecutables(dir, 3);
    const owners = findSandboxOwner(dir);
    if (ex.hit) needFix.push({ dir, il, ex, owners });
    else keepLow.push({ dir, il, owners });
  }

  const checked = targets.length - skipped.length;

  // --force：把"没有 exe 的 Low 目录"也一起改（不必需；纯数据目录的 Low 无害）
  if (FORCE && keepLow.length) {
    for (const k of keepLow) {
      needFix.push({ dir: k.dir, il: k.il, ex: { found: [], truncated: false }, owners: k.owners, forced: true });
    }
    keepLow.length = 0;
  }

  // ── 情况 1：没有需要修的 ────────────────────────────────────────────────
  if (!needFix.length) {
    line('  ✔ 没有发现"需要修"的目录。共检查 ' + checked + ' 个。');
    line('');
    if (keepLow.length) {
      line('  ⚪ 其中 ' + keepLow.length + ' 个目录是 Low，但里面没有 exe/dll —— 保持原样：');
      for (const { dir, owners } of keepLow) {
        line('       ' + dir + (owners.length ? '   [' + owners.join(' / ') + ' 工作区]' : ''));
      }
      line('');
      line('     Low 对"不放 exe 的目录"是无害的（读、写、建目录都正常，');
      line('     只有放进去的 exe 会以低完整性运行、起不来）。');
      line('     所以这里**只是不动它**，避免无谓地改别人的 ACL ——');
      line('     不是因为"沙箱需要它"（那个说法已证伪，见文件顶部）。');
      line('     确实要改：加 --force。');
      line('');
    }
    line('    如果 exe 还是起不来，那就不是这个问题 —— 跑 `npm run desktop` 看它的判定。');
    line('');
    return 0;
  }

  // ── 情况 2：有需要修的 ──────────────────────────────────────────────────
  line(RESTORE
    ? '  🔴 发现 ' + needFix.length + ' 个目录**含 exe/dll 且当前不是 Low**（将改回 Low）：'
    : '  🔴 发现 ' + needFix.length + ' 个目录带 Low 标签，且**里面有 exe/dll**：');
  line('');
  for (const { dir, il, ex, owners } of needFix) {
    line('     ' + dir);
    line('        ' + il.raw + (il.inherited ? '   （继承而来）' : '   （显式设置）'));
    line('        里面的可执行文件（示例）：');
    for (const f of ex.found.slice(0, 3)) line('          ' + f);
    if (ex.truncated) line('          …（还有更多）');
    if (!ex.found.length) line('        ⚠️ 里面**没有** exe/dll —— 是 --force 强制改的，请确认你确实想这么做。');
    if (owners.length) line('        ℹ️ 这个目录也是 ' + owners.join(' / ') + ' 的工作区 ——');
    if (owners.length) line('           改成 Medium **不影响**那个沙箱（它的写权限靠 DACL 能力 SID，与完整性标签无关）。');
  }
  line('');
  line('     这些目录里的 exe 会继承 Low → 以低完整性进程运行 → 一启动就失败，');
  line('     而且零 stderr、零日志、零转储，看起来跟"应用崩了"一模一样。');
  line('');

  if (keepLow.length) {
    line('  ⚪ 另有 ' + keepLow.length + ' 个 Low 目录**里面没有 exe/dll，已跳过**（不改动）：');
    for (const { dir, owners } of keepLow) {
      line('       ' + dir + (owners.length ? '   [' + owners.join(' / ') + ' 工作区]' : ''));
    }
    line('     Low 对它们无害（读、写、建目录都正常）—— 所以**只是不动它**，');
    line('');
  }

  if (DRY) {
    line('  [--dry] 没有修改任何东西。去掉 --dry 即可修复（只改上面 🔴 那些）。');
    line('');
    return 0;
  }

  line('  正在修复（改成 ' + TARGET_NAME + '）…');
  line('');
  let fail = 0;
  for (const { dir } of needFix) {
    let r;
    if (DEEP) {
      const { spawnSync } = require('child_process');
      const s = spawnSync('icacls',
        [dir, '/setintegritylevel', '(OI)(CI)' + TARGET_LEVEL, '/T', '/C'],
        { encoding: 'utf8', windowsHide: true });
      r = { ok: s.status === 0, out: String((s.stdout || '') + (s.stderr || '')).trim() };
    } else {
      r = fixIntegrity(dir, TARGET_LEVEL);
    }
    const after = getIntegrityLevel(dir);
    const good = after.low === (RESTORE === true);
    line('     ' + (r.ok && good ? '✔' : '✘') + ' ' + dir);
    if (!r.ok || !good) {
      fail++;
      if (r.out) line('         ' + r.out.split('\n')[0]);
      line('         → 如果提示"拒绝访问"，用**管理员**身份开一个 cmd 再跑一次：');
      line('           icacls "' + dir + '" /setintegritylevel (OI)(CI)M');
    } else {
      line('         现在：' + (after.raw || '（无标签 = 默认 Medium）'));
    }
  }
  line('');

  if (fail) {
    line('  ' + fail + ' 个没改成。多数情况是权限不够 —— 用管理员 cmd 重跑上面的命令即可。');
  } else {
    line('  ✔ 全部处理完。现在可以双击 exe 试试了。');
    line('');
    line('  ℹ️ 标签**是谁打的、会不会复发，都还没有查出来** —— 别再归因给 DSH/Codex：');
    line('     DSH 的沙箱是受限令牌 + DACL 能力 SID（S-1-4-x-y），不碰完整性标签；');
    line('     Codex 只授 DACL，同样不写 SACL。（详见本文件顶部与第十二节报告。）');
    line('     本项目的产物目录已经在 %LOCALAPPDATA% 下（不在任何工作区树里）→ 免疫。');
  }
  line('');

  // 顺带确认项目自己的产物目录没事
  try {
    const { resolveOutDir } = require('./lib/app-dir');
    const out = resolveOutDir();
    const il = getIntegrityLevel(out);
    line('  产物目录：' + out);
    line('            ' + (il.low ? '🔴 仍然是 Low，需要修复' : '✔ ' + (il.raw || '无标签（默认 Medium）')));
    line('');
  } catch (e) { /* app-dir 不可用就算了 */ }

  return fail ? 1 : 0;
}

process.exit(main());
