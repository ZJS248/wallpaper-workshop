'use strict';
/**
 * Steam Web API 官方接口封装（api.steampowered.com）。
 *
 * 这里只放**「社区页面拿不到、又确实需要」**的接口，避免重复劳动：
 *  - ISteamUser/GetPlayerSummaries：把 creator 的 steamID64 换成昵称 + 头像。
 *    浏览页只给数字 steamID，不给昵称；没有 kind 的话"相关壁纸（同作者）"
 *    只能显示一串数字。这个接口需要 API key（免费，https://steamcommunity.com/dev/apikey）。
 *
 * 关于 key 的策略：**可选**。
 *  没有 key → 作者名退化成 steamID 显示，其它功能全部照常。
 *  有 key   → 列表页顺手补上作者昵称+头像（一次请求最多 100 个）。
 * 不把 key 做成硬依赖，是为了让项目"拿到就能跑"。
 */

const httpClient = require('./httpClient');
const { APP_ID } = require('./util');

const API = 'https://api.steampowered.com';

/** 进程内短缓存：steamID -> {name, avatar, profileUrl}，10 分钟 */
const SUMMARY_CACHE = new Map();
const SUMMARY_TTL = 10 * 60 * 1000;

function cacheGet(id) {
  const hit = SUMMARY_CACHE.get(id);
  if (!hit) return null;
  if (Date.now() - hit.at > SUMMARY_TTL) {
    SUMMARY_CACHE.delete(id);
    return null;
  }
  return hit.value;
}

function cacheSet(id, value) {
  SUMMARY_CACHE.set(id, { at: Date.now(), value });
}

/** 校验 API key 是否可用（顺便把结果缓存起来，避免每次问） */
let keyState = { key: '', ok: null, checkedAt: 0, reason: '' };

async function verifyKey(key, ctx) {
  if (!key) return { ok: false, reason: '未配置 API key' };
  if (keyState.key === key && keyState.checkedAt && Date.now() - keyState.checkedAt < 10 * 60 * 1000) {
    return { ok: keyState.ok, reason: keyState.reason };
  }
  const res = await httpClient.getText(
    API + '/ISteamWebAPIUtil/GetServerInfo/v1/',
    { proxy: (ctx || {}).proxy, timeout: 15000 }
  );
  const ok = res.status === 200;
  keyState = { key, ok, checkedAt: Date.now(), reason: ok ? '' : 'HTTP ' + res.status };
  return { ok, reason: keyState.reason };
}

/**
 * 批量取玩家摘要。
 * @param {string[]} steamIds
 * @param {object} ctx { proxy, timeout }
 * @returns {Promise<{ok:boolean, players:object, reason?:string}>} players 以 steamID 为键
 */
async function getPlayerSummaries(steamIds, ctx) {
  const ids = Array.from(new Set((steamIds || []).map((x) => String(x).replace(/[^0-9]/g, '')).filter(Boolean)));
  const players = {};
  if (!ids.length) return { ok: true, players };

  const missing = [];
  ids.forEach((id) => {
    const hit = cacheGet(id);
    if (hit) players[id] = hit;
    else missing.push(id);
  });
  if (!missing.length) return { ok: true, players, cached: true };

  const key = ((ctx || {}).apiKey || '').trim();
  if (!key) {
    return {
      ok: false,
      needKey: true,
      reason: '未配置 Steam Web API key，无法把作者 steamID 换成昵称（在设置里填一个免费的 key 即可）',
      players,
    };
  }

  // 一次最多 100 个
  for (let i = 0; i < missing.length; i += 100) {
    const batch = missing.slice(i, i + 100);
    const res = await httpClient.getText(
      API +
        '/ISteamUser/GetPlayerSummaries/v2/?' +
        new URLSearchParams({ key, steamids: batch.join(',') }).toString(),
      { proxy: (ctx || {}).proxy, timeout: (ctx || {}).timeout || 20000 }
    );
    if (res.status !== 200) {
      return { ok: false, reason: 'Steam Web API HTTP ' + res.status, players };
    }
    let json;
    try {
      json = JSON.parse(res.body);
    } catch (e) {
      return { ok: false, reason: 'Steam Web API 返回非 JSON', players };
    }
    const list = (json.response && json.response.players) || [];
    list.forEach((p) => {
      const value = {
        steamId: p.steamid,
        name: p.personaname || '',
        avatar: p.avatarfull || p.avatarmedium || p.avatar || '',
        profileUrl: p.profileurl || '',
        state: p.personastate,
      };
      players[p.steamid] = value;
      cacheSet(p.steamid, value);
    });
    // 没返回的也缓存成空，避免每次都重试
    batch.forEach((id) => {
      if (!players[id]) cacheSet(id, { steamId: id, name: '', avatar: '', profileUrl: '' });
    });
  }
  return { ok: true, players };
}

/**
 * 给一批作品补上作者昵称 / 头像。
 *
 * ⚠️ 通常**不需要调用它**：浏览页的 SSR 数据里本来就带 `PlayerLinkDetails`
 * （每个作者的 persona_name + 头像 hash），`steamCommunity.fetchBrowse`
 * 已经免费把它们填进 `creatorName` / `creatorAvatar` / `creatorProfileUrl` 了。
 *
 * 这个函数是给"拿不到那种数据"的场景兜底的（例如个人页解析出来的作品、
 * 或将来 Steam 改版把 PlayerLinkDetails 去掉）。有 key 就用，没有就原样返回。
 */
async function enrichAuthors(items, ctx) {
  const list = Array.isArray(items) ? items : [];
  // 已经都有昵称就不用再打接口了
  const ids = list.filter((i) => i && i.creator && !i.creatorName).map((i) => i.creator);
  if (!ids.length) return { items: list, enriched: false, skipped: true };

  let res;
  try {
    res = await getPlayerSummaries(ids, ctx);
  } catch (e) {
    return { items: list, enriched: false, reason: '获取作者信息失败：' + e.message };
  }
  if (!res.ok) return { items: list, enriched: false, reason: res.reason, needKey: !!res.needKey };

  const players = res.players;
  const out = list.map((it) => {
    if (!it || !it.creator || it.creatorName) return it;
    const p = players[it.creator];
    if (!p || !p.name) return it;
    return Object.assign({}, it, {
      creatorName: p.name,
      creatorAvatar: p.avatar || it.creatorAvatar || '',
      creatorProfileUrl: p.profileUrl || 'https://steamcommunity.com/profiles/' + it.creator,
    });
  });
  return { items: out, enriched: true };
}

/**
 * 应用信息（可选，用来在设置页显示应用名）。
 *
 * ⚠️ 坑：store 的 appdetails 返回的**外层 key 不一定是请求的 appid**。
 * 实测请求 `appids=431960`（Wallpaper Engine），返回的却是
 *   {"1790230": {"success": true, "data": {"steam_appid": 431960, "name": "Wallpaper Engine：壁纸引擎", ...}}}
 * —— 外层用了它捆绑的 DLC 的 appid。只按 431960 取会永远拿不到，
 * 所以这里按 **data.steam_appid** 反查。
 */
async function getAppInfo(ctx) {
  const res = await httpClient.getText(
    'https://store.steampowered.com/api/appdetails?appids=' + APP_ID + '&l=schinese',
    { proxy: (ctx || {}).proxy, timeout: 20000, noLimit: true }
  );
  if (res.status !== 200) return { ok: false, reason: 'HTTP ' + res.status };
  let j;
  try {
    j = JSON.parse(res.body);
  } catch (e) {
    return { ok: false, reason: '解析失败' };
  }

  // 先按请求的 appid 找，找不到就按 data.steam_appid 反查
  let entry = j[APP_ID];
  if (!entry || !entry.success) {
    for (const k of Object.keys(j || {})) {
      const e = j[k];
      if (e && e.success && e.data && String(e.data.steam_appid) === APP_ID) {
        entry = e;
        break;
      }
    }
  }
  if (!entry || !entry.success) return { ok: false, reason: '商店未返回该应用的信息' };
  return { ok: true, data: entry.data };
}

module.exports = { API, getPlayerSummaries, enrichAuthors, verifyKey, getAppInfo };
