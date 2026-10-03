'use strict';
/**
 * 前端日志落盘。
 *
 * 为什么需要：用户报"卡住了"时，`desktop.log` 里只有 Electron 的启动事件，
 * 接口日志只打在终端 —— 打包成 exe 之后用户根本看不到，于是
 * "点了什么、哪一发请求慢、图片多久才加载完、有没有 JS 报错"全都查不到，
 * 只能靠猜。这里让前端把关键事件攒成小批 POST 上来，追加到文件。
 *
 * 落盘位置：`<配置目录>/frontend-YYYY-MM-DD.log`
 * （桌面端默认是 `%APPDATA%/wallpaper-workshop/config/`）。
 *
 * 清理策略（两条一起兜，避免长期挂着把磁盘写满）：
 *   1. **保留 7 天**：按天分文件，超过 7 天的整份删掉。
 *   2. **总量上限 20MB**：万一某天日志异常暴涨，从最旧的开始丢到限额以内。
 * 单份文件再设 4MB 上限，超了就轮转成 `.1`（只留一代）。
 * 清理动作有节流（每小时最多扫一次），不会每次写日志都去遍历目录。
 */
const fs = require('fs');
const path = require('path');

const RETENTION_DAYS = 7;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

const CONFIG_DIR = process.env.WW_CONFIG_DIR
  ? path.resolve(process.env.WW_CONFIG_DIR)
  : path.resolve(__dirname, '../../config');

const PREFIX = 'frontend-';

function ymd(d) {
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function fileFor(d) {
  return path.join(CONFIG_DIR, PREFIX + ymd(d || new Date()) + '.log');
}

function sizeOf(file) {
  try {
    return fs.statSync(file).size;
  } catch (e) {
    return 0;
  }
}

/** 列出所有日志文件，按日期从旧到新 */
function listLogs() {
  try {
    return fs
      .readdirSync(CONFIG_DIR)
      .filter((n) => n.indexOf(PREFIX) === 0 && n.slice(-4) === '.log')
      .sort()
      .map((n) => path.join(CONFIG_DIR, n));
  } catch (e) {
    return [];
  }
}

let lastSweep = 0;

/**
 * 清理：先按保留期删旧的，再按总量上限从最旧的开始丢。
 * 节流到每小时一次 —— 日志写入是高频动作，不能每次都去遍历目录。
 */
function sweep(force) {
  const now = Date.now();
  if (!force && now - lastSweep < SWEEP_INTERVAL_MS) return { skipped: true };
  lastSweep = now;

  const removed = [];
  const cutoff = now - RETENTION_DAYS * 24 * 60 * 60 * 1000;

  for (const f of listLogs()) {
    const base = path.basename(f).slice(PREFIX.length, -4);
    const t = Date.parse(base + 'T00:00:00');
    if (!isNaN(t) && t < cutoff) {
      try {
        fs.unlinkSync(f);
        removed.push(path.basename(f));
      } catch (e) {
        /* 删不掉就算了 */
      }
    }
  }

  // 总量兜底：还超就从最旧的继续丢
  let files = listLogs();
  let total = files.reduce((a, f) => a + sizeOf(f), 0);
  let i = 0;
  while (total > MAX_TOTAL_BYTES && i < files.length - 1) {
    const f = files[i++];
    const s = sizeOf(f);
    try {
      fs.unlinkSync(f);
      total -= s;
      removed.push(path.basename(f));
    } catch (e) {
      break;
    }
  }

  return { removed: removed, totalBytes: total };
}

/**
 * 追加若干行。lines 里每项是**前端已经格式化好的字符串**，
 * 这里只加时间戳，避免两端各写一套格式化逻辑。
 *
 * 同时打到控制台（`[前端]` 前缀）：`node server.js` 时用户能直接在窗口里看到，
 * 不用去翻文件。打包版看不到 stdout，靠 electron/main.js 把 console 兜住写进
 * desktop.log —— 那条路见那边的注释。
 */
function append(lines) {
  if (!Array.isArray(lines) || !lines.length) return { ok: true, written: 0 };
  // 一次别写太多：前端批量上报最多也就几十行，超过就是有人在刷
  const list = lines.slice(0, 200).map((l) => String(l).slice(0, 800));
  const file = fileFor();
  const stamp = new Date().toISOString();
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    if (sizeOf(file) > MAX_FILE_BYTES) {
      try {
        fs.renameSync(file, file + '.1');
      } catch (e) {
        /* 轮转失败不能影响主流程 */
      }
    }
    const text = list.map((l) => '[' + stamp + '] ' + l).join('\n') + '\n';
    fs.appendFileSync(file, text);
    sweep(); // 内部有节流，通常什么都不做
  } catch (e) {
    /* 写文件失败也要继续往下打控制台 */
  }
  for (const l of list) {
    try {
      console.log('  [前端] ' + l);
    } catch (e) {
      /* 忽略 */
    }
  }
  return { ok: true, written: list.length, file: path.basename(file) };
}

/** 读回最后 n 行（跨当天/昨天的文件一起读，方便排查） */
function readTail(n) {
  const want = Math.max(1, Math.min(Number(n) || 200, 2000));
  const files = listLogs();
  if (!files.length) return { ok: true, files: [], total: 0, lines: [], note: '还没有日志' };
  const all = [];
  // 从最新往前读，够数就停
  for (let i = files.length - 1; i >= 0 && all.length < want; i--) {
    try {
      const part = fs.readFileSync(files[i], 'utf8').split('\n').filter(Boolean);
      all.unshift.apply(all, part);
    } catch (e) {
      /* 单个文件读不了就跳过 */
    }
  }
  return {
    ok: true,
    dir: CONFIG_DIR,
    retentionDays: RETENTION_DAYS,
    files: files.map((f) => path.basename(f)),
    total: all.length,
    lines: all.slice(-want),
  };
}

module.exports = { append, readTail, sweep, LOG_DIR: CONFIG_DIR, RETENTION_DAYS, MAX_TOTAL_BYTES };
