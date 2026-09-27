'use strict';
/**
 * REST 接口实现。所有返回统一为 { ok, data } / { ok:false, error }。
 *
 * 路由总表：
 *   GET  /api/status                     运行状态（代理/DNS/父项目/图片缓存/上游页缓存）
 *   GET  /api/filters                    筛选器元数据（排序项、标签分组、时间窗、每页档位）
 *   GET  /api/browse                     浏览/搜索/筛选/排序/分页（pageSize 30/60/100）
 *   GET  /api/item?id=                   作品详情（含作者昵称、星级评分、我是否已订阅/已收藏）
 *   POST /api/item/subscribe             订阅 / 取消订阅  { id, action: 'sub'|'unsub', withDependents? }
 *   POST /api/item/favorite              收藏 / 取消收藏  { id, action: 'fav'|'unfav' }
 *   POST /api/item/vote                  点赞 / 点踩    { id, action: 'up'|'down' }
 *   GET  /api/details?ids=a,b,c          批量补详情（公开 API，不需要登录）
 *   GET  /api/author?id=                 作者信息 + 该作者作品（相关壁纸）
 *   GET  /api/subscribed-ids             已订阅 id 集合（给卡片打角标，会翻完所有页）
 *   GET  /api/deps?id=                   依赖关系（父链 + 依赖它的子孙；数据源 = 本地 project.json）
 *   POST /api/item/deps-followup         订阅后补订父链  { id }
 *   GET  /api/we/state                   Wallpaper Engine 状态（安装目录 / 是否在跑 / 当前使用中的作品）
 *   POST /api/we/apply                   把某个作品设为桌面壁纸（WE 官方 CLI openWallpaper）
 *   GET  /api/session                    登录态
 *   POST /api/session                    注入 Cookie / API key
 *   DELETE /api/session                  清除运行时登录态
 *   POST /api/session/verify             真实校验登录态
 *   POST /api/session/pull-parent        从父项目后端拉 Cookie
 *   GET  /img?u=<url>                    图片代理（绕过防盗链 + 走代理）
 *
 * 所有读接口都校验 HTTP 方法（非允许方法 → 405），写接口只接受 POST。
 */

const crypto = require('crypto');
const httpClient = require('./lib/httpClient');
const dnsResolve = require('./lib/dnsResolve');
const pageStore = require('./lib/pageStore');
const settings = require('./lib/settings');
const session = require('./lib/session');
const steamApi = require('./lib/steamApi');
const steamWebApi = require('./lib/steamWebApi');
const wallpaperEngine = require('./lib/wallpaperEngine');
const dependencies = require('./lib/dependencies');
const sc = require('./lib/steamCommunity');
const { ok, fail, HttpError, clampInt, APP_ID } = require('./lib/util');

// 版本号：本文件在 <项目>/server/routes.js，package.json 在上一级
let VERSION = '1.0.0';
try {
  VERSION = require('../package.json').version || VERSION;
} catch (e) {
  /* 打包场景下读不到就用默认值 */
}

const STARTED_AT = Date.now();

/* ------------------------------ 图片代理 ------------------------------ */
/**
 * 为什么需要图片代理：
 *  Steam 的预览图（images.steamusercontent.com）在部分网络下直连不通，
 *  而且放到 <img src> 里由浏览器直连就绕不开系统 DNS 污染。
 *  走服务端转发既能复用同一个代理出口，也能顺带加个短缓存。
 *
 *  缓存在**内存**里（LRU，默认 128MB 上限），不落盘 —— 需求明确不引入数据库/磁盘缓存。
 */
const IMAGE_CACHE = new Map();
const IMAGE_CACHE_MAX_BYTES = 128 * 1024 * 1024;
const IMAGE_CACHE_MAX_ITEMS = 400;
const IMAGE_CONCURRENCY = 4;   // 同时最多几个图片请求（给 API 留出上游带宽；图片晚点无所谓）
let imageCacheBytes = 0;
let imageActive = 0;
let apiActive = 0;             // 正在处理的 /api 请求数（图片闸门据此给 API 让路）
const imageQueue = [];
const imageStats = { hits: 0, misses: 0, bytes: 0, errors: 0, queued: 0 };

/** 简单的并发闸门 */
async function imageGate() {
  /*
   * 给 API 让路：列表/详情/订阅这些接口才是用户看得见的部分，图片晚几百毫秒无所谓。
   * 之前 30 张预览图会同时占住 6 个名额、每个又慢又要走代理，把 /api/browse 拖成
   * "转圈十几秒"（用户实测：订阅接口 9 秒、列表一直挂起）。
   * 等待上限 3 秒：API 一直忙也不能把图片饿死。
   */
  const t0 = Date.now();
  while (apiActive > 0 && Date.now() - t0 < 3000) {
    await new Promise((r) => setTimeout(r, 120));
  }
  return new Promise((resolve) => {
    if (imageActive < IMAGE_CONCURRENCY) {
      imageActive++;
      return resolve();
    }
    imageStats.queued++;
    imageQueue.push(resolve);
  });
}

function imageRelease() {
  const next = imageQueue.shift();
  if (next) return next(); // 名额直接转交，imageActive 不变
  imageActive--;
}

function imageCacheGet(key) {
  const hit = IMAGE_CACHE.get(key);
  if (!hit) return null;
  // LRU：命中后移到末尾
  IMAGE_CACHE.delete(key);
  IMAGE_CACHE.set(key, hit);
  imageStats.hits++;
  return hit;
}

function imageCacheSet(key, buf, type) {
  if (buf.length > 8 * 1024 * 1024) return; // 太大的不缓存
  while (
    (imageCacheBytes + buf.length > IMAGE_CACHE_MAX_BYTES || IMAGE_CACHE.size >= IMAGE_CACHE_MAX_ITEMS) &&
    IMAGE_CACHE.size
  ) {
    const oldest = IMAGE_CACHE.keys().next().value;
    const v = IMAGE_CACHE.get(oldest);
    IMAGE_CACHE.delete(oldest);
    imageCacheBytes -= v ? v.buf.length : 0;
  }
  IMAGE_CACHE.set(key, { buf, type, at: Date.now() });
  imageCacheBytes += buf.length;
}

const ALLOWED_IMAGE_HOSTS = [
  'steamusercontent.com',
  'steamstatic.com',
  'akamai.steamstatic.com',
  'steamcommunity.com',
  'steampowered.com',
  'steamuserimages-a.akamaihd.net',
];

function isAllowedImageHost(host) {
  const h = String(host || '').toLowerCase();
  return ALLOWED_IMAGE_HOSTS.some((suffix) => h === suffix || h.endsWith('.' + suffix));
}

/** 图片失败时的兜底：1x1 透明 GIF，避免前端一直转圈或显示裂图 */
const FALLBACK_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

function sendFallbackImage(res, cacheState) {
  res.writeHead(200, {
    'Content-Type': 'image/gif',
    'Content-Length': FALLBACK_GIF.length,
    // 失败也让它缓存一小会儿，别让同一张坏图被反复重试
    'Cache-Control': 'public, max-age=300',
    'X-Cache': cacheState || 'FALLBACK',
  });
  res.end(FALLBACK_GIF);
}

async function handleImage(req, res, url) {
  const target = url.searchParams.get('u');
  if (!target) throw new HttpError('缺少 u 参数', 400);
  let parsed;
  try {
    parsed = new URL(target);
  } catch (e) {
    throw new HttpError('u 不是合法 URL', 400);
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new HttpError('只支持 http/https', 400);
  if (!isAllowedImageHost(parsed.hostname)) {
    throw new HttpError('不允许代理该域名：' + parsed.hostname, 403);
  }

  const cacheKey = target;
  const hit = imageCacheGet(cacheKey);
  if (hit) {
    res.writeHead(200, {
      'Content-Type': hit.type,
      'Content-Length': hit.buf.length,
      'Cache-Control': 'public, max-age=86400',
      'X-Cache': 'HIT',
    });
    res.end(hit.buf);
    return;
  }

  imageStats.misses++;
  const ctx = session.currentContext();
  await imageGate();
  let r = null;
  let netErr = '';
  try {
    r = await httpClient.getText(parsed.toString(), {
      proxy: ctx.proxy,
      timeout: 20000,
      // 图片**不走**社区页那套限流：一屏几十张图，按 800ms 串行会把首屏拖到几十秒。
      // 图片来自 CDN（images.steamusercontent.com），本来也不受社区页的限流约束；
      // 这里改用 IMAGE_CONCURRENCY 个并发 + 内存缓存来控制压力。
      noLimit: true,
      headers: { Accept: 'image/*,*/*;q=0.8', Referer: 'https://steamcommunity.com/' },
    });
  } catch (e) {
    // 网络层异常（超时 / TLS 中断）不能让整张图变 500：
    // 前端只会看到一个失败的 <img>，而控制台会刷错误。统一回占位图。
    netErr = e.message || String(e);
  } finally {
    imageRelease();
  }

  if (!r || r.status !== 200) {
    imageStats.errors++;
    console.log('[img] 取图失败' + (netErr ? '（' + netErr + '）' : '（HTTP ' + (r && r.status) + '）') + '：' + parsed.hostname);
    return sendFallbackImage(res);
  }

  // 必须用 r.buffer（原始字节）而不是 r.body（UTF-8 文本）：图片是二进制
  const buf = r.buffer || Buffer.from(r.body, 'utf8');
  if (!buf.length) {
    imageStats.errors++;
    return sendFallbackImage(res);
  }
  const type = String(r.headers['content-type'] || 'image/jpeg').split(';')[0];
  imageCacheSet(cacheKey, buf, type);
  imageStats.bytes += buf.length;
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': buf.length,
    'Cache-Control': 'public, max-age=86400',
    'X-Cache': 'MISS',
  });
  res.end(buf);
}

/* ------------------------------ 业务接口 ------------------------------ */

async function apiStatus() {
  const cfg = settings.getConfig();
  const ctx = session.currentContext();

  return {
    appId: APP_ID,
    app: appInfoCache,
    version: VERSION,
    uptimeMs: Date.now() - STARTED_AT,
    node: process.version,
    proxy: cfg.proxy || '',
    proxySource: cfg.proxySource || 'direct',
    parentDetected: !!cfg.parent && !!cfg.parent.found,
    parentDir: (cfg.parent && cfg.parent.dir) || '',
    parentApiBase: cfg.parentApiBase || '',
    dns: dnsDiagCache || null,
    imageCache: {
      items: IMAGE_CACHE.size,
      bytes: imageCacheBytes,
      hits: imageStats.hits,
      misses: imageStats.misses,
      errors: imageStats.errors,
      active: imageActive,
      queued: imageStats.queued,
    },
    rateLimit: { minGapMs: httpClient.MIN_GAP_MS },
    // 上游页缓存：每页 60/100 是拿多个"上游 30 条页"拼出来的，命中率直接决定翻页快慢
    pageCache: pageStore.cacheInfo(),
    session: session.sessionStatus(),
  };
}

/**
 * /api/status 需要的两项"贵"信息（DNS 诊断、商店应用信息）放到后台刷新，
 * **不阻塞** /api/status 的返回。
 *
 * 为什么重要：社区页是全局 1200ms 限流的，如果 status 里同步去打这些请求，
 * 首屏的 /api/browse 就会排在它们后面，表现为"打开页面要等两三秒才出图"。
 * 反正前端拿到 null 也只是暂时不显示，下一轮刷新就有了。
 */
let dnsDiagCache = null;
let dnsDiagAt = 0;
let appInfoCache = null;
let appInfoAt = 0;
let refreshing = false;

async function refreshStatusExtras() {
  if (refreshing) return;
  const now = Date.now();
  const needDns = now - dnsDiagAt > 5 * 60 * 1000;
  const needApp = now - appInfoAt > 30 * 60 * 1000;
  if (!needDns && !needApp) return;

  refreshing = true;
  const ctx = session.currentContext();
  try {
    if (needDns) {
      dnsDiagAt = now;
      try {
        dnsDiagCache = await dnsResolve.diagnose('steamcommunity.com', ctx.proxy);
      } catch (e) {
        dnsDiagCache = { error: e.message };
      }
    }
    if (needApp) {
      appInfoAt = now;
      try {
        const r = await steamWebApi.getAppInfo(ctx);
        if (r.ok && r.data) appInfoCache = { name: r.data.name, header: r.data.header_image, type: r.data.type };
      } catch (e) {
        /* 商店接口不通不影响 */
      }
    }
  } finally {
    refreshing = false;
  }
}

/** 后台预热（服务启动后延迟一点跑，别和首屏请求抢） */
function warmupStatusExtras() {
  setTimeout(() => {
    refreshStatusExtras().catch(() => undefined);
  }, 4000);
}

/** /api/status 被打开时，顺手触发一次后台刷新（不 await） */
function kickStatusRefresh() {
  refreshStatusExtras().catch(() => undefined);
}

async function apiBrowse(url) {
  const q = url.searchParams;
  const csv = (name) =>
    String(q.get(name) || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

  // 多选类目：`g=类型:Scene,Video&g=分辨率:3840 x 2160,2560 x 1440`
  // 组内 OR、组间 AND —— 这是 WE 客户端的筛选语义。
  // （不能简单地把所有标签丢进 requiredtags 然后 match_all_tags=1：
  //   一张壁纸只能有一个分辨率标签，那样"勾了 2K 和 4K"必然是 0 条。）
  const orGroups = q
    .getAll('g')
    .map((s) =>
      String(s)
        .split(':')
        .slice(1)
        .join(':')
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
    )
    .filter((g) => g.length);

  const params = {
    sort: q.get('sort') || 'trend',
    // 时间窗：今日 / 本周 / 本月 / 本年
    days: steamApi.clampDays(q.get('days')),
    search: q.get('search') || '',
    // tags 只用于"没有类目信息"的兼容调用；正常走 orGroups
    tags: csv('tags'),
    orGroups: orGroups,
    excludedTags: csv('exclude'),
    page: clampInt(q.get('page'), 1, steamApi.MAX_PAGE, 1),
    // 30 / 60 / 100；上游恒 30 条/页，多出来的由 pageStore 拼页
    pageSize: steamApi.normalizePageSize(q.get('pageSize')),
  };

  const ctx = session.currentContext();
  const t0 = Date.now();
  const res = await steamApi.queryWorkshop(params, ctx);
  if (!res.ok) {
    return { ok: false, error: res.reason };
  }
  return Object.assign({ ok: true }, res, {
    query: params,
    elapsedMs: Date.now() - t0,
  });
}

async function apiItem(url) {
  const id = String(url.searchParams.get('id') || '').replace(/[^0-9]/g, '');
  if (!id) throw new HttpError('缺少 id 参数', 400);
  const ctx = session.currentContext();

  // 作者昵称/头像的"提示值"：浏览页的 PlayerLinkDetails 本来就给了（免费且准确），
  // 前端点开卡片时顺手带过来，省掉一次 Steam 请求，也兜住详情页被精简的情况。
  const hints = {
    name: String(url.searchParams.get('name') || ''),
    avatar: String(url.searchParams.get('avatar') || ''),
    creator: String(url.searchParams.get('creator') || ''),
  };

  const res = await steamApi.getItemDetail({ id }, ctx);

  // 详情真的取不到时要**如实失败**。旧实现返回 ok:true + item:null，
  // 前端把 item 为假值当成"还没选中"，于是显示「从左侧点选一张壁纸」这种
  // 静默空态，用户根本不知道是网络问题还是作品不存在（测试报告 BUG-07）。
  if (!res.ok) {
    return {
      ok: false,
      error: res.reason || '详情获取失败',
      notFound: !!res.notFound,
      retryable: res.retryable !== false,
      id: id,
    };
  }

  // 用提示值补齐作者信息（详情页解析失败的字段才补，不覆盖真实解析结果）
  const author = Object.assign({}, res.author);
  if (!author.name) author.name = hints.name || '';
  if (!author.avatar) author.avatar = hints.avatar || '';
  if (!author.steamId) author.steamId = hints.creator || (res.item && res.item.creator) || '';
  const item = res.item
    ? Object.assign({}, res.item, {
        creatorName: res.item.creatorName || author.name || '',
        creatorAvatar: res.item.creatorAvatar || author.avatar || '',
      })
    : res.item;

  const creatorId = author.steamId || (item && item.creator) || '';

  /**
   * 「相关壁纸」**不在这里同步拉**。
   *
   * 它的数据源是作者的个人创意工坊页（一次社区请求 + 一次公开 API）。
   * 早期把它塞在 /api/item 里同步做完，结果是"点一张壁纸要等十几秒才出详情"；
   * 上游一抖动（个人页返回精简页 / 握手失败要重试）还能拖到一两分钟
   * （实测 172 秒，因为两层重试相乘）。
   * 现在只把 creatorId 交给前端，让它并发去调 /api/author —— 详情立刻显示，
   * 相关壁纸晚一两秒自己填进来。
   *
   * 为了兼容脚本 / 宿主，`related` 字段仍然存在，但默认是 null；
   * 传 `?related=1` 才会同步带上。
   */
  let related = null;
  if (url.searchParams.get('related') === '1' && creatorId) {
    try {
      const r = await steamApi.getWorksByCreator(creatorId, { page: 1, pageSize: 30 }, ctx);
      if (r.ok) {
        related = {
          creator: { steamId: creatorId, name: author.name || '', avatar: author.avatar || '' },
          totalCount: r.total,
          totalPages: r.totalPages,
          items: (r.items || []).filter((i) => i.id !== id),
        };
      } else {
        related = { error: r.reason, creator: { steamId: creatorId } };
      }
    } catch (e) {
      related = { error: e.message, creator: { steamId: creatorId } };
    }
  }

  return Object.assign({ ok: true }, res, {
    item,
    author,
    creatorId,
    related,
    session: session.sessionStatus(),
  });
}

async function apiSubscribe(body) {
  const id = String((body && body.id) || '').replace(/[^0-9]/g, '');
  if (!id) throw new HttpError('缺少 id', 400);
  const action = (body && body.action) || 'sub';
  const ctx = session.currentContext();

  /*
   * 取消订阅 + 依赖连锁：WE 里"父壁纸被退订，依赖它的子壁纸会被一起退订"
   * （wallpaper-manager 的 collectDependents 就是这么做的：BFS 反查"谁依赖我"，含间接）。
   * 顺序也照它：**先子孙、后父**。
   */
  if (action === 'unsub' && body && body.withDependents) {
    const cfg = settings.getConfig();
    const local = wallpaperEngine.listSubscribed(cfg.wsDir);
    const index = dependencies.buildIndex(cfg.wsDir, local.map((x) => String(x.id)));
    const dependents = dependencies.dependentList(index, id);
    const removed = [];
    const failed = [];
    for (const did of dependents) {
      const r = await steamApi.unsubscribe(String(did), ctx);
      if (r && r.ok) { removed.push(String(did)); subsCachePatch(String(did), false); }
      else failed.push({ id: String(did), reason: (r && r.reason) || '失败' });
    }
    const r0 = await steamApi.unsubscribe(id, ctx);
    if (r0 && r0.ok) { removed.push(id); subsCachePatch(id, false); }
    dependencies.clearCache(); // 项目文件夹会随退订消失，依赖索引立刻作废
    session.logEvent('subscribe', id + ' unsub(+依赖 ' + dependents.length + ') -> ' + (r0 && r0.ok ? '成功' : '失败'));
    return {
      ok: !!(r0 && r0.ok),
      reason: r0 && r0.ok ? '' : (r0 && r0.reason) || '取消订阅失败',
      removed: removed,
      failed: failed,
      dependents: dependents,
    };
  }

  const res = action === 'unsub' ? await steamApi.unsubscribe(id, ctx) : await steamApi.subscribe(id, ctx);
  // 角标用的订阅集合缓存增量更新，不用等 5 分钟或下次全量刷新
  if (res && res.ok) {
    subsCachePatch(id, action !== 'unsub');
    dependencies.clearCache(); // 依赖索引按"本地有哪些项目"算，订阅状态变了就该重算
  }
  session.logEvent('subscribe', id + ' ' + action + ' -> ' + (res.ok ? '成功' : res.reason));
  return res;
}

async function apiFavorite(body) {
  const id = String((body && body.id) || '').replace(/[^0-9]/g, '');
  if (!id) throw new HttpError('缺少 id', 400);
  const action = (body && body.action) || 'fav';
  const ctx = session.currentContext();
  const res = action === 'unfav' ? await steamApi.unfavorite(id, ctx) : await steamApi.favorite(id, ctx);
  session.logEvent('favorite', id + ' ' + action + ' -> ' + (res.ok ? '成功' : res.reason));
  return res;
}

async function apiVote(body) {
  const id = String((body && body.id) || '').replace(/[^0-9]/g, '');
  if (!id) throw new HttpError('缺少 id', 400);
  const up = ((body && body.action) || 'up') !== 'down';
  const ctx = session.currentContext();
  return steamApi.vote(id, up, ctx);
}

async function apiDetails(url) {
  const ids = String(url.searchParams.get('ids') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!ids.length) throw new HttpError('缺少 ids 参数', 400);
  const ctx = session.currentContext();
  return steamApi.getDetails(ids, ctx);
}

/* ------------------------------ Wallpaper Engine 控制 ------------------------------ */

/**
 * 依赖关系（对齐 wallpaper-manager 的语义）：
 *   向上 = 父链（project.json 的 dependency）→ 订阅时要一起订阅；
 *   向下 = 依赖它的子孙（children 数组 + 反向 dependency，含间接）→ 退订时要一起退订。
 * 依赖信息只能从**本地已下载**的 project.json 读，所以只对本地已有的项目有效。
 */
async function apiDeps(url) {
  const cfg = settings.getConfig();
  const id = String(url.searchParams.get('id') || '').replace(/[^0-9]/g, '');
  if (!id) throw new HttpError('缺少 id', 400);
  const local = wallpaperEngine.listSubscribed(cfg.wsDir);
  const ids = local.map((x) => String(x.id));
  const index = dependencies.buildIndex(cfg.wsDir, ids);
  const parent = dependencies.readDependency(cfg.wsDir, id) || '';
  const dependents = dependencies.dependentList(index, id);
  const chain = dependencies.dependencyChain(cfg.wsDir, id);
  // 标题：复用已订阅列表的元数据缓存（点一下依赖警告不该再打一次 Steam）
  const map = await loadSubscribedMeta(cfg.wsDir, ids.concat(chain));
  const brief = (x) => ({ id: x, title: (map.get(String(x)) || {}).title || '', installed: ids.indexOf(String(x)) >= 0 });
  return {
    ok: true,
    id: id,
    dependency: parent,
    dependencyChain: chain,
    dependencyBrief: chain.map(brief),
    dependents: dependents.map(brief),
    hasRelations: !!(parent || dependents.length),
  };
}

/**
 * 订阅后的"依赖补订"：项目刚订阅时文件还没下来，读不到 dependency，
 * 所以前端会隔几秒调一次这里；一旦本地有了 project.json 且父壁纸未订阅，就补订父链。
 */
async function apiDepsFollowup(body) {
  const cfg = settings.getConfig();
  const id = String((body && body.id) || '').replace(/[^0-9]/g, '');
  if (!id) throw new HttpError('缺少 id', 400);
  const chain = dependencies.dependencyChain(cfg.wsDir, id);
  if (!chain.length) return { ok: true, added: [], pending: false };
  const sub = await apiSubscribedIds();
  const subscribed = new Set((sub.ids || []).map(String));
  const added = [];
  const ctx = session.currentContext();
  // 父先子后：先订最上面的祖先
  for (const pid of chain.slice().reverse()) {
    if (subscribed.has(String(pid))) continue;
    const r = await steamApi.subscribe(String(pid), ctx);
    if (r && r.ok) {
      added.push(pid);
      subscribed.add(String(pid));
      session.logEvent('subscribe', pid + ' sub (依赖补订，子项 ' + id + ')');
    }
  }
  if (added.length) subsCache = { at: 0, value: null, idSet: null, failTtl: false, failAt: 0 };
  return { ok: true, added: added, dependencyChain: chain, pending: false };
}

/**
 * 已订阅项目清单（本地库口径）。
 *
 * 数据来源与 wallpaper-manager 一致：扫 <wsDir> 下的项目文件夹，
 *   - 「订阅时间」= 文件夹创建时间（真实下载/订阅时刻），拿不到则用 ACF 的 timeupdated
 *   - 元数据（标题/预览/文件大小/标签）走公开的 GetPublishedFileDetails，进程内缓存 5 分钟
 * 好处：不需要登录、不受 Steam 订阅页限流影响，毫秒级出列表。
 */
const SUB_META_TTL_MS = 5 * 60 * 1000;
let subMetaCache = { at: 0, wsDir: '', map: null };

async function loadSubscribedMeta(wsDir, ids) {
  if (subMetaCache.map && subMetaCache.wsDir === wsDir && Date.now() - subMetaCache.at < SUB_META_TTL_MS) {
    return subMetaCache.map;
  }
  const ctx = session.currentContext();
  const map = new Map();
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    try {
      const r = await steamApi.getDetails(chunk, ctx);
      (r.items || []).forEach((it) => map.set(String(it.id), it));
    } catch (e) {
      /* 某一段失败就用已有的 */
    }
  }
  if (map.size) subMetaCache = { at: Date.now(), wsDir: wsDir, map: map };
  return map;
}

async function apiSubscribed(url) {
  const cfg = settings.getConfig();
  if (!cfg.wsDir) {
    return { ok: false, error: '没找到创意工坊内容目录（steamapps/workshop/content/431960）', items: [], totalCount: 0 };
  }
  // 用户点「刷新」= 强制重新读盘 + 重新拉 Steam 订阅列表（不走任何缓存）
  if (url.searchParams.get('fresh') === '1') {
    wallpaperEngine.clearLocalCaches();
    subsCache = { at: 0, value: null, idSet: null, failTtl: false, failAt: 0 };
  }

  /*
   * 列表口径：**以 Steam 的订阅列表为准**，本地库只提供"订阅时间 / 是否已下载"。
   *
   * 为什么必须这样：取消订阅后 Steam 不会立刻删本地文件夹（WE 也留着），
   * 只看文件夹的话，取消订阅了十几分钟还显示"已订阅"（用户实测报的）。
   * 取不到 Steam 列表（没登录 / Cookie 过期）才退回本地库，保证离线也能用。
   */
  const local = wallpaperEngine.listSubscribed(cfg.wsDir);
  const localMap = new Map(local.map((x) => [String(x.id), x]));
  let steamIds = null;
  try {
    const r = await apiSubscribedIds();
    if (r && r.ok && Array.isArray(r.ids)) steamIds = r.ids.map(String);
  } catch (e) {
    /* 退回本地库 */
  }
  const ids = steamIds || local.map((x) => String(x.id));
  const staleLocal = steamIds ? local.filter((x) => steamIds.indexOf(String(x.id)) < 0).length : 0;

  const map = await loadSubscribedMeta(cfg.wsDir, ids);
  let items = ids.map((id) => {
    const loc = localMap.get(id);
    const meta = map.get(String(id)) || {};
    return Object.assign({}, meta, {
      id: String(id),
      title: meta.title || '(未能读取标题)',
      // 没有本地文件夹 = 订阅了但还没下载完 → 仍在列表里，但不能设为使用中
      installed: !!loc,
      subscribedAt: loc ? loc.subscribedAt : 0,
      fileSize: Number(meta.fileSize) || (loc && loc.size) || 0,
    });
  });

  const search = String(url.searchParams.get('search') || '').trim().toLowerCase();
  if (search) {
    items = items.filter(
      (i) =>
        String(i.title || '').toLowerCase().indexOf(search) >= 0 ||
        String(i.creatorName || '').toLowerCase().indexOf(search) >= 0
    );
  }
  const sort = url.searchParams.get('sort') || 'time_desc';
  if (sort === 'time_asc') items.sort((a, b) => a.subscribedAt - b.subscribedAt);
  else if (sort === 'title') items.sort((a, b) => String(a.title).localeCompare(String(b.title), 'zh'));
  else items.sort((a, b) => b.subscribedAt - a.subscribedAt);

  const pageSize = steamApi.normalizePageSize(url.searchParams.get('pageSize'));
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = clampInt(url.searchParams.get('page'), 1, totalPages, 1);
  return {
    ok: true,
    items: items.slice((page - 1) * pageSize, page * pageSize),
    totalCount: total,
    totalPages: totalPages,
    page: page,
    pageSize: pageSize,
    wsDir: cfg.wsDir,
    // 从 Steam 列表为准；如果本地还留着一批已取消订阅的文件夹，把数量告诉前端
    source: steamIds ? 'steam' : 'local',
    staleLocalCount: staleLocal,
  };
}

/**
 * 同一发查询的并发合并。
 *
 * 前端在慢的时候会自动重试，用户也可能连点几次 —— 同一个 URL 会同时在途 2~4 份，
 * 上游被按倍数打，越重试越慢（实测同一条 browse 连续出现 4 次 100~150 秒的请求）。
 * 这里让"同 key 的并发请求共用一次上游查询"，结果对每个调用方都照常返回。
 */
const inflightApis = new Map();

function dedupe(key, fn) {
  const hit = inflightApis.get(key);
  if (hit) return hit;
  const p = Promise.resolve()
    .then(fn)
    .finally(() => inflightApis.delete(key));
  inflightApis.set(key, p);
  return p;
}

/** 当前使用中的壁纸 / 路径探测结果（前端用来显示「使用中」角标） */
async function apiWeState() {
  const cfg = settings.getConfig();
  // status() 是异步的（进程探测走 execFile，不能再阻塞事件循环）—— 这里必须 await，
  // 忘了 await 的话 Object.assign 会拿一个 Promise，接口就返回空对象，
  // 前端拿不到本地库 → 已订阅/使用中角标全失效（用户实测报过）。
  const st = await wallpaperEngine.status({ weDir: cfg.weDir, wsDir: cfg.wsDir });
  return Object.assign({ ok: true }, st);
}

/**
 * 把某个作品设为桌面壁纸（使用中）。
 * 走 WE 官方 CLI：`wallpaper32.exe -control openWallpaper -file <project.json> -monitor N`
 * 前提：本机已安装 WE、WE 正在运行、该壁纸已经在本地（订阅后 Steam 下载完）。
 */
async function apiWeApply(body) {
  const cfg = settings.getConfig();
  const id = String((body && body.id) || '').replace(/[^0-9]/g, '');
  if (!id) throw new HttpError('缺少 id', 400);
  const monitor = Number.isInteger(body && body.monitor) ? body.monitor : 0;
  // dryRun 只回显将要执行的命令（自检/排错用，不动桌面）
  const dryRun = !!(body && body.dryRun);
  // force：探测不到 WE 进程（枚举被拒）时，允许按 64/32 位顺序直接试一次
  const force = !!(body && body.force);
  const r = await wallpaperEngine.setWallpaper({
    weDir: cfg.weDir,
    wsDir: cfg.wsDir,
    id: id,
    monitor: monitor,
    dryRun: dryRun,
    force: force,
    // CLI 发不出去时转交父项目后端（它的进程在正常用户上下文里，实测能把命令交给 WE）
    parentApiBase: cfg.parentApiBase,
    proxy: cfg.proxy,
  });
  if (!r.ok) return { ok: false, error: r.error };
  session.logEvent('apply', id + ' monitor=' + monitor + (dryRun ? ' (dry)' : ''));
  return Object.assign({ ok: true, id: id }, r);
}

async function apiAuthor(url) {
  const id = String(url.searchParams.get('id') || '').replace(/[^0-9]/g, '');
  if (!id) throw new HttpError('缺少 id（steamID64）', 400);
  const pageSize = steamApi.normalizePageSize(url.searchParams.get('pageSize'));
  const page = clampInt(url.searchParams.get('page'), 1, steamApi.MAX_PAGE, 1);
  const ctx = session.currentContext();

  // 昵称/头像：优先用调用方带过来的（浏览页本来就给了 PlayerLinkDetails，免费且最准）。
  // 只有调用方没带、而且配了 API key 时，才回退去打官方接口。
  const hintName = String(url.searchParams.get('name') || '');
  const hintAvatar = String(url.searchParams.get('avatar') || '');
  let creator = {
    steamId: id,
    name: hintName,
    avatar: hintAvatar,
    profileUrl: 'https://steamcommunity.com/profiles/' + id,
  };
  if (!creator.name && ctx.apiKey) {
    try {
      const r = await steamWebApi.getPlayerSummaries([id], ctx);
      const p = (r.players && r.players[id]) || null;
      if (p && p.name) {
        creator = { steamId: id, name: p.name, avatar: p.avatar || '', profileUrl: p.profileUrl || creator.profileUrl };
      }
    } catch (e) {
      /* 拿不到就显示 steamID */
    }
  }

  const works = await steamApi.getWorksByCreator(id, { page, pageSize }, ctx);
  return {
    ok: works.ok,
    error: works.ok ? '' : works.reason,
    privateProfile: !!works.privateProfile,
    creator,
    totalCount: works.total || 0,
    totalPages: works.totalPages || 0,
    page: works.page || page,
    pageSize: works.pageSize || pageSize,
    failedPages: works.failedPages || 0,
    items: works.items || [],
    sourceUrl: works.url || '',
    workshopUrl: 'https://steamcommunity.com/profiles/' + id + '/myworkshopfiles/?appid=' + APP_ID,
  };
}

async function apiSubscribedIds() {
  // 5 分钟内直接回缓存（见上面 subsCache 的说明）
  if (subsCache.value && Date.now() - subsCache.at < SUBS_TTL_MS) {
    return Object.assign({}, subsCache.value, { cached: true });
  }
  // 刚失败过（60 秒内）：直接回上次的失败，别再爬登录墙
  if (subsCache.failTtl && Date.now() - subsCache.failAt < 60 * 1000) {
    return Object.assign({}, subsCache.failValue, { cached: true });
  }
  // 失败的缓存短一些（60 秒）：Cookie 过期时没必要每次刷新都去爬一遍登录墙
  const ctx = session.currentContext();
  const r = await steamApi.getSubscribedIds(ctx);
  const out = {
    ok: r.ok,
    error: r.ok ? '' : r.reason,
    ids: Array.from(r.ids || []),
    total: r.total || 0,
    // 订阅很多时后端不会无限翻页，如实把"覆盖了多少 / 是不是全了"告诉前端，
    // 免得角标看起来"时有时无"（测试报告 BUG-17 的现象之一）。
    pages: r.pages || 0,
    complete: !!r.complete,
    capped: !!r.capped,
  };
  if (out.ok) {
    subsCache = { at: Date.now(), value: out, idSet: new Set(out.ids), failTtl: false, failAt: 0 };
  } else {
    subsCache = { at: 0, value: null, idSet: null, failTtl: true, failAt: Date.now(), failValue: out };
  }
  return out;
}

/*
 * 「已订阅 id 集合」的短缓存 + 并发合并。
 *
 * 为什么必须加：这个接口要把用户的订阅**逐页翻完**（190 个订阅 = 7 个上游页），
 * 实测 5~10 秒。而前端每次刷新页面都会调它 —— 白等一次不说，那 7 个上游请求
 * 还会跟真正要显示的列表抢上游带宽，表现为"订阅接口 9 秒、列表一直转圈"。
 *
 * 现在：5 分钟内直接回缓存；订阅/退订时增量更新缓存，角标立刻对得上。
 */
const SUBS_TTL_MS = 5 * 60 * 1000;
let subsCache = { at: 0, value: null, idSet: null };

/** 订阅/退订成功后增量改缓存，不用等下次全量刷新 */
function subsCachePatch(id, subscribe) {
  try {
    if (!subsCache.value || !subsCache.idSet) return;
    const ids = subsCache.idSet;
    if (subscribe) ids.add(String(id));
    else ids.delete(String(id));
    subsCache.value.ids = Array.from(ids);
    subsCache.value.total = Math.max(subsCache.value.ids.length, subsCache.value.total || 0);
  } catch (e) {
    /* 缓存更新失败无所谓，下次全量刷 */
  }
}

/* ------------------------------ 请求体 ------------------------------ */

/**
 * 读取并解析 JSON 请求体。
 *
 * 这里**自己读**，不接收外部传进来的 readJson 函数：
 * 之前是 `routes.handle({ ..., readJson })` 然后在里面写 `await readJson()`，
 * 参数名把函数名遮蔽了 → 调用时丢掉了 req → 报
 * "Cannot read properties of undefined (reading 'on')"。
 * 这种"同名参数遮蔽"的坑很难一眼看出来，干脆收进本模块，接口也少一个。
 */
function readJsonBody(req, limit) {
  const max = limit || 2 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        reject(new HttpError('请求体过大', 413));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new HttpError('请求体不是合法 JSON', 400));
      }
    });
    req.on('error', reject);
  });
}

/* ------------------------------ 分发 ------------------------------ */

/**
 * 处理 /api/* 与 /img。
 * @returns {Promise<boolean>} true 表示已处理
 */
async function handle(ctx) {
  const { req, res, url, pathname } = ctx;
  const readJson = () => readJsonBody(req);

  if (pathname === '/img') {
    await handleImage(req, res, url);
    return true;
  }

  if (!pathname.startsWith('/api/')) return false;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return true;
  }

  const method = req.method || 'GET';

  /**
   * HTTP 方法校验。
   *
   * 旧实现只对写接口做了校验，读接口完全不管 —— 测试报告 BUG-14 实测
   * `POST /api/browse` 返回 HTTP 200 + ok:true。虽然前端不会这么发，
   * 但"接口接受任意方法"会让缓存/代理/调试工具产生误判，所以统一拒绝。
   */
  const needMethod = (allow) => {
    if (allow.indexOf(method) < 0) {
      throw new HttpError('该接口只接受 ' + allow.join(' / ') + '，收到 ' + method, 405);
    }
  };

  let result;
  // /api 请求期间把"图片让路"的开关打开（见 imageGate 的说明）
  apiActive++;
  try {
  switch (pathname) {
    case '/api/status':
      needMethod(['GET']);
      // 顺手触发后台刷新 DNS/应用信息，但不等它
      kickStatusRefresh();
      result = await apiStatus();
      break;
    case '/api/filters':
      needMethod(['GET']);
      result = await steamApi.getFilterOptions(session.currentContext());
      break;
    case '/api/browse':
      needMethod(['GET']);
      result = await dedupe('browse:' + url.search, () => apiBrowse(url));
      break;
    case '/api/item':
      needMethod(['GET']);
      result = await dedupe('item:' + url.search, () => apiItem(url));
      break;
    case '/api/details':
      needMethod(['GET']);
      result = await apiDetails(url);
      break;
    case '/api/author':
      needMethod(['GET']);
      result = await apiAuthor(url);
      break;
    case '/api/subscribed-ids':
      needMethod(['GET']);
      result = await dedupe('subs', () => apiSubscribedIds());
      break;

    // Wallpaper Engine 控制（"当前使用中" / "设为使用中"）
    case '/api/we/state':
      needMethod(['GET']);
      result = await apiWeState();
      break;
    case '/api/we/apply':
      needMethod(['POST']);
      result = await apiWeApply(await readJson());
      break;

    // 已订阅项目清单（本地库口径：订阅时间 / 搜索 / 排序 / 分页）
    case '/api/subscribed':
      needMethod(['GET']);
      result = await apiSubscribed(url);
      break;

    // 依赖关系（父链 / 依赖它的子孙）+ 订阅后的依赖补订
    case '/api/deps':
      needMethod(['GET']);
      result = await apiDeps(url);
      break;
    case '/api/item/deps-followup':
      needMethod(['POST']);
      result = await apiDepsFollowup(await readJson());
      break;

    case '/api/item/subscribe':
      needMethod(['POST']);
      result = await apiSubscribe(await readJson());
      break;
    case '/api/item/favorite':
      needMethod(['POST']);
      result = await apiFavorite(await readJson());
      break;
    case '/api/item/vote':
      needMethod(['POST']);
      result = await apiVote(await readJson());
      break;

    case '/api/session':
      needMethod(['GET', 'POST', 'DELETE']);
      if (method === 'GET') result = Object.assign({ ok: true }, session.sessionStatus());
      else if (method === 'POST') result = Object.assign({ ok: true }, session.setSession(await readJson()));
      else result = Object.assign({ ok: true }, session.clearSession());
      break;
    case '/api/session/verify':
      needMethod(['POST', 'GET']);
      // body 里可以带 { force: true } 强制真校验（设置抽屉点"校验"时就是这么调的）
      result = await session.verifySession(method === 'POST' ? await readJson() : {});
      break;
    case '/api/session/pull-parent':
      needMethod(['POST']);
      result = await session.pullCookieFromParent();
      break;
    case '/api/session/events':
      needMethod(['GET']);
      result = { ok: true, events: session.events() };
      break;

    default:
      throw new HttpError('未知接口：' + pathname, 404);
  }
  } finally {
    apiActive--;
  }

  /*
   * 业务失败：HTTP 200 + ok:false（未登录则 401），让前端统一处理。
   *
   * ⚠️ 这里曾经判断 `result.error` 才当失败 —— 而写接口（订阅/收藏/点踩）失败时
   * 返回的是 `reason` 字段，于是被判成"成功"，外层又包一层 { ok:true, data:{ ok:false,… } }，
   * 前端于是认为请求成功了：**界面上什么都不报，右上角还显示已登录**（用户实测报的）。
   * 现在只要内层 ok:false 一律按失败返回，并把 reason 归一化成 error。
   */
  if (result && result.ok === false) {
    const body0 = Object.assign({}, result);
    if (!body0.error && body0.reason) body0.error = body0.reason;
    const status = body0.needLogin ? 401 : 200;
    // 登录态被拒 → 记下来，顶栏要立刻显示"登录态失效"，而不是继续显示"已登录"
    if (body0.needLogin) session.markInvalid(body0.error || '登录态失效');
    const body = JSON.stringify(body0);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    });
    res.end(body);
    return true;
  }
  res.setHeader('Access-Control-Allow-Origin', '*');
  return ok(res, result);
}

module.exports = { handle, isAllowedImageHost, imageStats, IMAGE_CACHE, warmupStatusExtras };
