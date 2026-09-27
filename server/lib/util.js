'use strict';
/**
 * 通用小工具：JSON 响应、错误包装、时间格式化、URL 查询串拼装。
 * 目标：零依赖（只用 Node 内置模块），因此在没有 npm install 的环境也能直接跑。
 */

/** Steam 创意工坊应用 ID —— Wallpaper Engine */
const APP_ID = '431960';

/** 统一的响应格式：{ ok, data } / { ok:false, error } */
function ok(res, data, status) {
  const body = JSON.stringify({ ok: true, data });
  res.writeHead(status || 200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function fail(res, message, status, extra) {
  const body = JSON.stringify(Object.assign({ ok: false, error: String(message || 'unknown error') }, extra || {}));
  res.writeHead(status || 500, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/** 抛给上层统一转成 HTTP 错误 */
class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'HttpError';
    this.status = status || 500;
  }
}

/**
 * 拼查询串。值为 undefined / null / '' 的项直接跳过；
 * 数组按 key 重复展开（Steam 的 requiredtags[] 就是这个形式，例如
 * `requiredtags%5B%5D=Anime&requiredtags%5B%5D=3840+x+2160`）。
 */
function qs(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) {
      for (const item of v) {
        if (item === undefined || item === null || item === '') continue;
        sp.append(k, String(item));
      }
    } else {
      sp.append(k, String(v));
    }
  }
  return sp.toString();
}

/** 把任意输入收敛成整数，越界时夹到 [min,max]，非法则返回 fallback */
function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 只允许白名单里的值，否则用 fallback（防止把任意参数透传给 Steam） */
function pickOne(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function nowMs() {
  return Date.now();
}

/** 人类可读的剩余时间，用于登录态展示 */
function humanRemain(ms) {
  if (!ms || ms <= 0) return '已过期';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return d + ' 天 ' + h + ' 小时';
  if (h > 0) return h + ' 小时 ' + m + ' 分钟';
  return m + ' 分钟';
}

module.exports = { APP_ID, ok, fail, HttpError, qs, clampInt, pickOne, nowMs, humanRemain };
