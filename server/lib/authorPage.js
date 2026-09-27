'use strict';
/**
 * 「个人创意工坊页」解析器：/profiles/<steamID64>/myworkshopfiles/?appid=431960
 *
 * 这个页面承担两件事，代码结构完全一样，只是查询参数不同：
 *   1. **作者的公开作品**（`section=readytouseitems`，默认）→「相关壁纸 / 同作者所有壁纸」
 *      为什么不能用 /workshop/browse/?creatorid=xxx：实测那个参数**被 Steam 忽略**，
 *      带上它仍然返回全站结果（total 3,215,346）。
 *   2. **我的订阅 / 我的收藏**（`browsefilter=mysubscriptions` / `myfavorites`）
 *      为什么不能用 /workshop/browse/?browsefilter=mysubscriptions：同样被忽略
 *      （total 仍是全站的 3,215,346）。只有个人页上的 browsefilter 才真的生效
 *      （实测返回「共 180 项条目」这种正确数字）。
 *
 * 页面结构（经典服务端渲染，没有 window.SSR，所以只能抓 HTML）：
 *   <div class="workshopBrowseItems">
 *     <div class="workshopItem">
 *       <a href=".../sharedfiles/filedetails/?id=3652174311" class="ugc" data-publishedfileid="3652174311">
 *         <img class="workshopItemPreviewImage" src="...">
 *         <div class="workshopItemTitle">标题</div>
 *     ...
 *   <div class="workshopBrowsePagingInfo">正在显示第 1 - 10 项，共 180 项条目</div>
 */

const { getText } = require('./httpClient');
const { COMMUNITY, decodeEntities } = require('./steamCommunity');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 一页最多能拿多少（实测 30 正常；再大 Steam 会自行截断） */
const MAX_PAGE_SIZE = 30;

/**
 * 上游页大小。**必须恒为 30**。
 *
 * 实测（scripts/debug-upstream-matrix.js）：
 *   numperpage=10 → 10 条；=24 → **10 条**；=30 → 30 条；=60 → **10 条**
 * 也就是说除了 30 以外的任何取值都会退化成 10 条/页。
 * 旧实现直接把调用方给的 pageSize 塞进 numperpage，界面默认 24，
 * 于是"按 24 算页数、实际每页 10 条" —— 380 个收藏只能翻到 160 个，
 * 剩下 220 条在任何页码上都点不到（测试报告 BUG-02，功能不可用级别）。
 * 现在恒传 30，并让上层用 pageStore 去拼页满足 60/100。
 */
const UPSTREAM_PAGE_SIZE = 30;

/** 页面支持的"我要看谁的什么" */
const SCOPES = {
  works: { label: '全部作品', param: null },                       // section=readytouseitems（默认）
  subscriptions: { label: '我的订阅', param: 'subscriptions' },     // browsefilter=mysubscriptions
  favorites: { label: '我的收藏', param: 'favorites' },             // browsefilter=myfavorites
};

/**
 * 解析个人创意工坊页的 HTML。
 *
 * 页面有**两种列表结构**（实测），必须都支持：
 *
 * A) 「我的订阅 / 我的收藏」视图（browsefilter=myworkshopsubscriptions…）——
 *    每项是一个 `workshopItemSubscription` 块，标题单独一行：
 *      <div class="workshopItemSubscription" id="Subscription3807671971">
 *        <img class="backgroundImg" src="...">
 *        <div class="itemContents">
 *          <a href=".../sharedfiles/filedetails/?id=3807671971">
 *            <div class="workshopItemPreviewHolder">
 *              <img class="workshopItemPreviewImage" src=".../?imw=100&imh=100...">
 *        <div class="workshopItemSubscriptionDetails">
 *          <a href=".../sharedfiles/filedetails/?id=3807671971">
 *            <div class="workshopItemTitle">标题</div>
 *
 * B) 「作者公开作品」视图（默认 section）——
 *      <div class="workshopBrowseItems">
 *        <div class="workshopItem">
 *          <a class="ugc" data-publishedfileid="3652174311" href="...?id=3652174311">
 *            <img class="workshopItemPreviewImage" src="...">
 *            <div class="workshopItemTitle">标题</div>
 *
 * 注意：这里**不能**依赖 `<div class="workshopBrowseItems">` 这个容器 ——
 * 订阅视图里根本没有它（实测次数 0），只有 workshopItemSubscription。
 */
function parseAuthorWorksHtml(html, creatorId, page, pageSize) {
  const items = [];
  const seen = new Set();

  /**
   * 去掉 CDN 的 Letterbox 缩略参数，拿原图（前端还会自己再走图片代理）。
   *
   * 页面上的缩略图 URL 形如
   *   https://images.steamusercontent.com/ugc/<a>/<b>/?imw=100&imh=100&ima=fit&impolicy=Letterbox&...
   * 参数顺序不固定（有的是 `?imw=100&letterbox=true`），所以不能只匹配一种写法：
   * 直接用"路径最后一段为空的查询串"整体砍掉即可。
   */
  function bigImage(u) {
    if (!u) return '';
    return decodeEntities(u).replace(/\?.*$/, '');
  }

  function push2(id, rawTitle, rawImg) {
    if (!id || seen.has(id)) return;
    seen.add(id);
    items.push({
      id: String(id),
      title: rawTitle ? decodeEntities(String(rawTitle).replace(/<[^>]*>/g, '')).trim() : '',
      previewUrl: bigImage(rawImg),
      creator: creatorId,
      subscriptions: 0,
      tags: [],
    });
  }

  /**
   * 按"块"切分再逐块解析，比写一个从头匹配到尾的大正则稳得多。
   * 之前用 `class="workshopItemSubscription"...class="workshopItemSubscriptionDetails"`
   * 作为一段，结果标题（在细节块**之后**）永远取不到 —— 实测 10 条里 0 条有标题。
   * 改成：先切块，块内再各自找 id / 标题 / 图。
   */
  function blocksBy(marker, maxLen) {
    const parts = html.split(marker);
    const out = [];
    for (let i = 1; i < parts.length; i++) out.push(parts[i].slice(0, maxLen || 4000));
    return out;
  }

  // --- A) 订阅 / 收藏视图：<div ... class="workshopItemSubscription" id="Subscription3807671971">
  blocksBy('class="workshopItemSubscription"', 4000).forEach((blk) => {
    const id = (blk.match(/^\s*id="Subscription(\d+)"/) || [])[1];
    if (!id) return;
    // 块内第一个 workshopItemTitle 就是该项标题
    const title = (blk.match(/class="workshopItemTitle[^"]*"[^>]*>([\s\S]{0,300}?)<\/div>/) || [])[1];
    const img =
      (blk.match(/<img[^>]+class="[^"]*backgroundImg[^"]*"[^>]+src="([^"]+)"/) || [])[1] ||
      (blk.match(/<img[^>]+class="[^"]*workshopItemPreviewImage[^"]*"[^>]+src="([^"]+)"/) || [])[1];
    push2(id, title, img);
  });

  // --- B) 公开作品视图：<div ... class="workshopItem"> ... data-publishedfileid="..."
  if (!items.length) {
    blocksBy('class="workshopItem"', 4000).forEach((blk) => {
      const id = (blk.match(/data-publishedfileid="(\d+)"/) || blk.match(/sharedfiles\/filedetails\/\?id=(\d+)/) || [])[1];
      if (!id) return;
      const title = (blk.match(/class="workshopItemTitle[^"]*"[^>]*>([\s\S]{0,300}?)<\/div>/) || [])[1];
      const img = (blk.match(/<img[^>]+class="[^"]*workshopItemPreviewImage[^"]*"[^>]+src="([^"]+)"/) || [])[1];
      push2(id, title, img);
    });
  }

  // --- C) 兜底：只有 sharedfiles 链接的页面 ---
  if (!items.length) {
    const reAny =
      /sharedfiles\/filedetails\/\?id=(\d+)"([\s\S]{0,1500}?class="workshopItemTitle[^"]*"[^>]*>[\s\S]{0,300}?<\/div>)/g;
    let m;
    while ((m = reAny.exec(html))) push2(m[1], (m[2].match(/class="workshopItemTitle[^"]*"[^>]*>([\s\S]{0,300}?)<\/div>/) || [])[1], '');
  }

  // 分页信息："正在显示第 1 - 10 项，共 180 项条目" / "Showing 1-10 of 180 entries"
  let total = 0;
  const pi = html.match(/class="workshopBrowsePagingInfo"[^>]*>([\s\S]{0,220}?)<\/div>/);
  if (pi) {
    const nums = decodeEntities(pi[1]).match(/([\d,]+)/g);
    if (nums && nums.length) total = Number(String(nums[nums.length - 1]).replace(/,/g, '')) || 0;
  }

  /**
   * 「页面认出来了」≠「页面上有条目」。
   *
   * 这个区分很关键：翻到最后一页之后 Steam 会返回一个**正常但空**的列表页。
   * 如果把它当成 ok:false（旧行为），那么"每页 100 条"在只有 50 个作品时
   * 会因为第 2~4 页为空而被判成"解析失败"，整个组装结果只剩第 1 页的 30 条。
   */
  const recognized =
    items.length > 0 ||
    total > 0 ||
    /workshopBrowseItems|workshopItemSubscription|workshopBrowsePagingInfo|workshopItemTitle/.test(html) ||
    /*
     * "这个作者一个公开作品都没有"时，Steam 返回的是**正常的个人页 + 空列表**
     * （只有 56 KB，没有 workshopItem/workshopBrowseItems，只有页面骨架）。
     * 上面那串标记全不命中，于是被误判成"页面结构不认识" —— 用户看到的是一条红色
     * "加载失败：没有解析到作品"（实测：作者 鱼见见见见、共 0 个）。
     * 这里补上个人页骨架的标记，并且排除登录墙页面。
     */
    (/mainContents_sharedfiles|sharedFilesQueryParams|sharedfiles_header_ctn/.test(html) &&
      !/steam\/login|LoginPage|loginform|Sign In/i.test(html));

  /**
   * 资料设为"私密"的作者：Steam 不会给你看他的"创意工坊物品"标签页，
   * 只返回个人主页 + 一句「此个人资料是私密的。」
   *
   * 实测（作者 鱼见见见见 / 76561198839809612）：页面 30 KB、0 个 workshopItem、
   * 只有 profile_private_info 那块。WE 客户端还能列出他 70 多个作品，是因为客户端走的是
   * Steam 客户端自己的通道（不是社区浏览页），网页端拿不到 —— 这一点必须如实告诉用户，
   * 而不是含糊地说"页面结构不认识"。
   */
  const privateProfile = /此个人资料是私密的|This profile is private|profile_private_info/.test(html);
  if (privateProfile && !items.length) {
    return {
      ok: false,
      privateProfile: true,
      recognized: false,
      reason: '该作者的 Steam 个人资料设为「私密」，网页端看不到他的创意工坊物品（WE 客户端能看到，是因为它走客户端自己的通道）。',
      items: [],
      total: 0,
      upstreamPages: 0,
    };
  }

  return {
    ok: recognized,
    recognized: recognized,
    reason: items.length
      ? ''
      : recognized
        ? '这一页没有条目（已经翻到末尾，或该作者没有公开作品）'
        : '没有解析到作品（页面结构不认识：可能未登录、被限流，或 Steam 改了页面结构）',
    items,
    total,
    // page 是**上游页号**（每页恒 30 条）；"每页 60/100"由上层组装
    page: page || 1,
    upstreamPageSize: UPSTREAM_PAGE_SIZE,
    upstreamPages: total ? Math.ceil(total / UPSTREAM_PAGE_SIZE) : 1,
  };
}

/**
 * 拼个人创意工坊页 URL。
 * @param {string} profileId steamID64
 * @param {object} opts { scope: 'works'|'subscriptions'|'favorites', page, appId }
 */
function buildProfileUrl(profileId, opts) {
  opts = opts || {};
  const scope = SCOPES[opts.scope] ? opts.scope : 'works';
  const page = Math.max(1, parseInt(opts.page, 10) || 1);
  const params = {
    appid: opts.appId || '431960',
    numperpage: String(UPSTREAM_PAGE_SIZE),
    p: String(page),
  };
  if (scope === 'subscriptions') params.browsefilter = 'mysubscriptions';
  if (scope === 'favorites') params.browsefilter = 'myfavorites';
  return COMMUNITY + '/profiles/' + String(profileId).replace(/[^0-9]/g, '') + '/myworkshopfiles/?' + new URLSearchParams(params).toString();
}

/**
 * 拉取某个人的创意工坊列表（作者公开作品 / 我的订阅 / 我的收藏）。
 *
 * ⚠️ `page` 是**上游页号**（每页恒 30 条）。要"每页 60/100"请用
 * steamApi.getWorksByCreator，它在本函数之上叠 pageStore.assemble。
 *
 * 失败会重试，理由与浏览页一样（实测）：
 *  - Steam 会**间歇性返回"精简页"**：HTTP 200，但没有 `workshopItem` /
 *    `workshopBrowsePagingInfo` 这些锚点，一条都解析不出来；
 *  - 经本地代理打 Steam 时 TCP/TLS 握手失败也很常见。
 * 处理方式：换一种 URL 形式（加/去 `l=` 语言参数）再来一轮，网络异常也继续下一轮
 * （早期没兜住异常，一次握手失败就直接把整个请求抛出去，连重试机会都没有）。
 *
 * ⚠️ `opts.attempts` 控制**内部**最多打几次（默认 4 = 2 轮 × 2 种 URL 形式）。
 * 被 pageStore 调用时必须传 1 —— 那层自己会重试，
 * 两层重试相乘会把一次请求放大几十倍（实测 `/api/author` 因此要 170 秒）。
 *
 * @param {string} profileId steamID64
 * @param {object} opts { scope, page, cookie, proxy, timeout, attempts }
 */
async function fetchProfileWorks(profileId, opts) {
  opts = opts || {};
  const id = String(profileId || '').replace(/[^0-9]/g, '');
  if (!id) return { ok: false, reason: '缺少 steamID64', items: [], total: 0 };

  const scope = SCOPES[opts.scope] ? opts.scope : 'works';
  const page = Math.max(1, parseInt(opts.page, 10) || 1);
  const url = buildProfileUrl(id, { scope: scope, page: page, appId: opts.appId });

  const variants = [url];
  try {
    const u = new URL(url);
    const alt = new URL(url);
    if (u.searchParams.has('l')) alt.searchParams.delete('l');
    else alt.searchParams.set('l', opts.language || 'schinese');
    variants.push(alt.toString());
  } catch (e) {
    /* URL 不合法就不再造变体 */
  }

  // 默认 4 次（2 轮 × 2 种形式，交替）；pageStore 调用时传 1
  const maxAttempts = Math.max(1, Math.min(4, Number(opts.attempts) || 4));
  const plan = [];
  for (let i = 0; i < maxAttempts; i++) plan.push(variants[i % variants.length]);

  let last = null;
  for (let i = 0; i < plan.length; i++) {
    const v = plan[i];
    let res;
    try {
      res = await getText(v, {
        cookie: opts.cookie,
        proxy: opts.proxy,
        timeout: opts.timeout || 30000,
        // 作者页没有"每 1200ms 一个请求"的必要：翻作者作品时会并发取几页，
        // 走限流闸门会把 3 页拖成 5 秒。与浏览页的合并查询同样的取舍。
        noLimit: !!opts.noLimit,
      });
    } catch (e) {
      last = {
        ok: false,
        reason: '访问 Steam 失败：' + (e.message || String(e)),
        networkError: true,
        items: [],
        total: 0,
        url: v,
        scope,
        attempts: i + 1,
      };
      if (i < plan.length - 1) await sleep(700);
      continue;
    }

    if (res.status !== 200) {
      last = { ok: false, reason: 'Steam 返回 HTTP ' + res.status, items: [], total: 0, url: v, scope, attempts: i + 1 };
      continue;
    }

    const parsed = parseAuthorWorksHtml(res.body, id, page, UPSTREAM_PAGE_SIZE);
    const full = Object.assign(parsed, { url: v, scope, htmlLength: res.body.length, attempts: i + 1 });
    // 「认出来了」就返回（哪怕这一页是空的 —— 翻到末尾是正常情况）
    if (parsed.recognized) return full;
    last = Object.assign(full, { degraded: true });
    // 精简页：等一下再换一种 URL 形式试
    if (i < plan.length - 1) await sleep(900);
  }
  return last || { ok: false, reason: '个人创意工坊页获取失败', items: [], total: 0, url, scope };
}

/** 兼容旧名字：只拉公开作品 */
async function fetchAuthorWorks(creatorId, opts) {
  return fetchProfileWorks(creatorId, Object.assign({}, opts, { scope: 'works' }));
}

module.exports = {
  fetchProfileWorks,
  fetchAuthorWorks,
  parseAuthorWorksHtml,
  buildProfileUrl,
  SCOPES,
  MAX_PAGE_SIZE,
  UPSTREAM_PAGE_SIZE,
};
