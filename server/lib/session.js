'use strict';
/**
 * 会话管理：**内存态，不落盘、不进数据库**。
 *
 * 为什么可以只在内存里：
 *  - 浏览 / 搜索 / 筛选 / 排序 / 详情 / 相关壁纸全部是匿名可用的，不需要会话。
 *  - 只有「订阅 / 取消订阅 / 收藏 / 我的订阅 / 我的收藏」需要登录态，
 *    而登录态本来就是 Steam 那边的短期凭证（steamLoginSecure 的 JWT 约 24h）。
 *    进程重启后重新登录一次即可，比"把凭证写到磁盘上"更安全也更简单。
 *
 * 三级来源，优先级从高到低（后两者是"接入父项目"的加成）：
 *   1. 运行时注入：设置页粘贴 Cookie，或父页面（wallpaper-manager）通过 postMessage 推过来
 *   2. 环境变量：WW_COOKIE / WW_REFRESH_TOKEN
 *   3. 配置文件：./config/settings.json（独立运行时可在设置页保存）
 *   4. 父项目只读借用：HTML-website/config/wallpaper/settings.json 里的 steamCookies
 */

const { getConfig, patchConfig, saveSettings } = require('./settings');
const steamApi = require('./steamApi');
const sc = require('./steamCommunity');

/** 运行时覆盖（内存）：{ cookie, refreshToken, apiKey, source, updatedAt } */
const runtime = {
  cookie: '',
  refreshToken: '',
  apiKey: '',
  source: '',
  updatedAt: 0,
  /** 被 Steam 明确拒绝的记录 { at, reason }（顶栏据此显示"登录态失效"） */
  invalid: null,
  /** 最近一次真实校验结果 { at, loggedIn, reason }（自动校验用它做缓存，避免每次刷新都打 Steam） */
  lastVerify: null,
  /** 当前这份登录态是否已经落到磁盘（顶栏/设置页据此提示"重启会不会丢"） */
  persisted: false,
};

const eventLog = [];   // 最近若干条会话事件，供设置页排查
const MAX_LOG = 40;

function logEvent(type, detail) {
  eventLog.unshift({ at: Date.now(), type, detail: String(detail || '') });
  if (eventLog.length > MAX_LOG) eventLog.length = MAX_LOG;
}

/** 登录态被拒（写操作 401 / 校验不通过） */
function markInvalid(reason) {
  runtime.invalid = { at: Date.now(), reason: String(reason || '登录态失效') };
  logEvent('invalid', runtime.invalid.reason);
}

/** 登录态确认可用 */
function markValid() {
  if (runtime.invalid) logEvent('valid', '登录态恢复可用');
  runtime.invalid = null;
}

/** 组装当前生效的上下文（给 steamApi 用） */
function currentContext() {
  const cfg = getConfig();
  const cookie = runtime.cookie || cfg.cookie || '';
  const source = runtime.cookie ? runtime.source || 'runtime' : cfg.cookieSource || 'none';
  return {
    cookie,
    cookieSource: source,
    refreshToken: runtime.refreshToken || cfg.refreshToken || '',
    apiKey: runtime.apiKey || cfg.apiKey || '',
    proxy: cfg.proxy,
    language: cfg.language,
    timeout: cfg.timeout,
    parentApiBase: cfg.parentApiBase,
  };
}

/** 从父项目后端拉一次 Cookie（父项目自己会做刷新令牌续期，所以它的最新） */
async function pullCookieFromParent() {
  const cfg = getConfig();
  const base = cfg.parentApiBase;
  if (!base) return { ok: false, reason: '未探测到父项目后端（默认 http://127.0.0.1:8897）' };
  const httpClient = require('./httpClient');
  try {
    const res = await httpClient.getText(base + '/wallpaper/api/settings', { proxy: '', timeout: 6000 });
    if (res.status !== 200) return { ok: false, reason: '父项目 /wallpaper/api/settings 返回 HTTP ' + res.status };
    const json = JSON.parse(res.body);
    const data = json && (json.data || json);
    const cookie = (data && (data.steamCookies || data.cookie)) || '';
    if (!cookie) return { ok: false, reason: '父项目里没有已保存的 Steam Cookie' };
    runtime.cookie = cookie;
    runtime.source = 'parent-api';
    runtime.updatedAt = Date.now();
    if (data.steamRefreshToken) runtime.refreshToken = data.steamRefreshToken;
    logEvent('pull-parent', '从父项目后端取得 Cookie（' + cookie.length + ' 字节）');
    return { ok: true, length: cookie.length };
  } catch (e) {
    return { ok: false, reason: '请求父项目失败：' + e.message };
  }
}

/**
 * 设置 / 注入 Cookie。
 * @param {object} input { cookie, refreshToken, apiKey, persist }
 */
function setSession(input) {
  input = input || {};
  if (typeof input.cookie === 'string') {
    runtime.cookie = input.cookie.trim();
    runtime.source = input.source || 'manual';
    runtime.updatedAt = Date.now();
    logEvent('set-cookie', (runtime.cookie ? '长度 ' + runtime.cookie.length : '清空') + '，来源 ' + runtime.source);
  }
  if (typeof input.refreshToken === 'string') runtime.refreshToken = input.refreshToken.trim();
  if (typeof input.apiKey === 'string') runtime.apiKey = input.apiKey.trim();

  if (input.persist) {
    // 落盘的是"当前生效的那份"（运行时注入优先），所以即使只传 {persist:true}
    // 也能把正在用的 Cookie 存下来 —— 前端现在默认就勾着这个选项。
    const patch = {};
    const cfgNow = getConfig();
    const effCookie = runtime.cookie || cfgNow.cookie || '';
    const effRefresh = runtime.refreshToken || cfgNow.refreshToken || '';
    const effKey = runtime.apiKey || cfgNow.apiKey || '';
    if (effCookie) patch.cookie = effCookie;
    if (effRefresh) patch.refreshToken = effRefresh;
    if (effKey) patch.apiKey = effKey;
    if (Object.keys(patch).length) saveSettings(patch);
    runtime.persisted = true;
    logEvent('persist', '登录态已写入 config/settings.json（重启不用重粘）');
  }
  return sessionStatus();
}

function clearSession() {
  runtime.cookie = '';
  runtime.refreshToken = '';
  runtime.source = '';
  runtime.updatedAt = Date.now();
  runtime.invalid = null;
  runtime.invalid = null;   // 新凭证：先别带着上次的"失效"标记
  logEvent('clear-cookie', '已清除运行时登录态');
  return sessionStatus();
}

/** 会话状态（给前端顶栏用） */
function sessionStatus() {
  const cfg = getConfig();
  const ctx = currentContext();
  const jwt = sc.parseSteamJwt(ctx.cookie);
  const now = Date.now();
  return {
    hasCookie: !!ctx.cookie,
    // 是否被 Steam 明确拒绝过（写操作 401 / 校验不通过）。顶栏据此显示"登录态失效"，
    // 不能只看 hasCookie —— 过期 Cookie 也是"有 Cookie"，那正是用户被误导的地方。
    invalid: !!runtime.invalid,
    invalidReason: (runtime.invalid && runtime.invalid.reason) || '',
    invalidAt: (runtime.invalid && runtime.invalid.at) || 0,
    verifiedAt: (runtime.lastVerify && runtime.lastVerify.at) || 0,
    verifyOk: !!(runtime.lastVerify && runtime.lastVerify.loggedIn),
    cookieLength: (ctx.cookie || '').length,
    source: ctx.cookieSource,
    sourceLabel: {
      runtime: '运行时注入',
      manual: '手动粘贴',
      'parent-message': '父页面推送',
      'parent-api': '父项目后端',
      parent: '父项目文件',
      settings: '本项目配置',
      env: '环境变量',
      none: '未登录',
    }[ctx.cookieSource] || ctx.cookieSource,
    steamId: jwt.steamId || cfg.parent && cfg.parent.steamid || '',
    expiresAt: jwt.exp || 0,
    expiresInMs: jwt.exp ? jwt.exp - now : 0,
    expired: !!(jwt.exp && jwt.exp <= now),
    ipSubject: jwt.ipSubject || '',
    hasRefreshToken: !!ctx.refreshToken,
    hasApiKey: !!ctx.apiKey,
    // 没有运行时注入的 Cookie 时，用的是磁盘上的（本项目配置 / 父项目文件）→ 也算"已落盘"
    persisted: !!(runtime.persisted || !runtime.cookie),
    proxy: cfg.proxy || '',
    proxySource: cfg.proxySource || 'direct',
    parentApiBase: cfg.parentApiBase || '',
    parentDetected: !!cfg.parent && !!cfg.parent.found,
    updatedAt: runtime.updatedAt,
  };
}

/** 登录态实际可用性（会真的打一次需要登录的接口） */
const VERIFY_CACHE_MS = 3 * 60 * 1000;

async function verifySession(opts) {
  const force = !!(opts && opts.force);
  if (!force && runtime.lastVerify && Date.now() - runtime.lastVerify.at < VERIFY_CACHE_MS) {
    return Object.assign({}, runtime.lastVerify, { cached: true, session: sessionStatus() });
  }
  const ctx = currentContext();
  const who = await steamApi.whoAmI(ctx);
  if (who && who.loggedIn) markValid();
  else markInvalid((who && who.reason) || '登录态无效');
  runtime.lastVerify = { at: Date.now(), loggedIn: !!(who && who.loggedIn), reason: (who && who.reason) || '' };
  logEvent('verify', who.loggedIn ? '登录态有效' : '登录态无效：' + (who.reason || ''));
  return Object.assign({}, who, { session: sessionStatus() });
}

module.exports = {
  currentContext,
  setSession,
  clearSession,
  sessionStatus,
  verifySession,
  pullCookieFromParent,
  logEvent,
  markInvalid,
  markValid,
  events: () => eventLog.slice(),
};
