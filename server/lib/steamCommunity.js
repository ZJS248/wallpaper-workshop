'use strict';
/**
 * Steam 社区创意工坊页面解析器。
 *
 * 为什么不用 api.steampowered.com/IPublishedFileService/QueryFiles？
 *  - 实测它**强制要求 API key**（无 key 时 403），本项目不引入 key，避免多一个凭证。
 *  - 社区页面（steamcommunity.com/workshop/browse）是老牌稳定入口，且**天然支持
 *    "我的订阅 / 我的收藏" 这类需要登录的过滤器**，正好覆盖需求。
 *
 * 页面形式（2026 实测）：Steam 已改成 SSR，**不再有 `?xml=1` 的旧接口**。
 * 数据在三个位置，按优先级尝试：
 *   1. `window.SSR.renderContext=JSON.parse("<double-escaped>")` → `.queryData`（再 JSON.parse 一次）
 *      → `{ mutations, queries: [{ queryKey, state:{ data:{ eresult, current_page, total_pages,
 *         total_count, results:[...] } } }] }`  ← 首选，字段最全
 *   2. `window.SSR.loaderData = ["<json>", ...]`
 *   3. body 里带 nonce 的 `<script>` 同样挂着 `window.SSR.*`
 * 三个位置都拿不到时就报一个"能看出发生了什么"的错（例如被登录墙拦了）。
 *
 * 解析要点 / 踩坑：
 *  - 必须用**括号配对 + 字符串感知**的扫描器，不能用正则：
 *    renderContext 里有 `setOwnedApps`（用户拥有的全部 appid，上万个），
 *    贪心/懒惰正则都会截断。
 *  - 字符串字面量里的 `\\\"` 不能被当成字符串结束，所以扫描器要处理转义。
 *  - 抽取出的是「JS 字符串字面量」，用 JSON.parse 解一次得到「里面那层 JSON 文本」，
 *    再 JSON.parse 一次才是对象。renderContext.queryData 又要再解一次 —— 一共三层。
 */

const { getText } = require('./httpClient');
const { APP_ID } = require('./util');

const COMMUNITY = 'https://steamcommunity.com';

/** 从 open 位置开始做括号配对，返回完整的 {...} 子串（字符串/转义感知） */
function matchBalanced(text, open) {
  if (text[open] !== '{' && text[open] !== '[') return null;
  let stack = [];
  let inStr = false;
  let esc = false;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (ch === '\\') {
      esc = true;
      continue;
    }
    if (inStr) {
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') {
      const want = ch === '}' ? '{' : '[';
      if (stack.pop() !== want) return null;
      if (stack.length === 0) return text.slice(open, i + 1);
    }
  }
  return null;
}

/** 把"被多轮转义过的 JSON 文本"解成对象，最多剥 6 层 */
function decodeLoose(raw) {
  let cur = raw;
  for (let depth = 0; depth < 6; depth++) {
    if (typeof cur !== 'string') return cur;
    // 每轮先试直接 parse；失败再把剩下的转义拆掉继续
    try {
      return JSON.parse(cur);
    } catch (e) {
      /* 继续剥壳 */
    }
    const next = cur.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    if (next === cur) {
      try {
        return JSON.parse(cur);
      } catch (e) {
        return null;
      }
    }
    cur = next;
  }
  return typeof cur === 'string' ? null : cur;
}

/** 收集页面里所有 `window.SSR.xxx = <value>` / `window.SSR.xxx=JSON.parse("...")` 的取值 */
function collectSsrValues(html) {
  const values = {};
  const re = /window\.SSR\.([A-Za-z0-9_]+)\s*=\s*/g;
  let m;
  while ((m = re.exec(html))) {
    const key = m[1];
    const at = m.index + m[0].length;
    if (values[key] !== undefined) continue;
    if (html.startsWith('JSON.parse(', at)) {
      const q = html.indexOf('"', at);
      if (q < 0) continue;
      // 字符串字面量：找收尾引号（跳过转义）
      let esc = false;
      let end = -1;
      for (let i = q + 1; i < html.length; i++) {
        const ch = html[i];
        if (esc) {
          esc = false;
          continue;
        }
        if (ch === '\\') {
          esc = true;
          continue;
        }
        if (ch === '"') {
          end = i;
          break;
        }
      }
      if (end < 0) continue;
      try {
        // 注意：Steam 把一整串 JSON 文本当成 JS 字符串塞进 JSON.parse 里，
        // 所以这里解出来还是个「字符串」，必须再走一次 decodeLoose 才是对象。
        values[key] = decodeLoose(JSON.parse(html.slice(q, end + 1)));
      } catch (e) {
        /* 单个字段失败不影响其它 */
      }
      continue;
    }
    if (html[at] === '[') {
      const raw = matchBalanced(html, at);
      if (raw) {
        try {
          values[key] = JSON.parse(raw);
        } catch (e) {
          /* 忽略 */
        }
      }
      continue;
    }
    if (html[at] === '{') {
      const raw = matchBalanced(html, at);
      if (raw) {
        try {
          values[key] = JSON.parse(raw);
        } catch (e) {
          /* 忽略 */
        }
      }
    }
  }
  return values;
}

/** 判断一个对象是不是「工坊列表页数据」 */
function looksLikeBrowseData(node) {
  return (
    node &&
    typeof node === 'object' &&
    Array.isArray(node.results) &&
    ('total_count' in node || 'current_page' in node)
  );
}

/** 在任意嵌套结构里找第一个满足条件的节点 */
function deepFind(node, pred, depth) {
  depth = depth || 0;
  if (depth > 30 || node === null || node === undefined) return null;
  if (Array.isArray(node)) {
    for (const v of node) {
      const hit = deepFind(v, pred, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof node === 'object') {
    if (pred(node)) return node;
    for (const k of Object.keys(node)) {
      const hit = deepFind(node[k], pred, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

/** 从 SSR 变量集合里挖出列表数据 + 服务端回显的查询条件 */
function extractBrowse(ssrValues) {
  let data = null;
  let serverQuery = null;

  // 首选 renderContext.queryData（React Query 的序列化结果）
  const rc = ssrValues.renderContext;
  if (rc && typeof rc === 'object') {
    serverQuery = deepFind(
      rc,
      (n) => n && typeof n === 'object' && ('browse_sort' in n || 'num_per_page' in n || 'trend_days' in n)
    );
    let qd = rc.queryData;
    if (typeof qd === 'string') {
      qd = decodeLoose(qd);
    }
    if (qd && Array.isArray(qd.queries)) {
      for (const q of qd.queries) {
        const d = q && q.state && q.state.data;
        if (looksLikeBrowseData(d)) {
          data = d;
          break;
        }
      }
    }
    if (!data) {
      data = deepFind(rc, looksLikeBrowseData);
    }
  }

  // 回退：loaderData 或其他 SSR 字段
  if (!data) {
    for (const key of Object.keys(ssrValues)) {
      if (key === 'renderContext') continue;
      let v = ssrValues[key];
      if (typeof v === 'string') v = decodeLoose(v);
      if (!v) continue;
      const hit = deepFind(v, looksLikeBrowseData);
      if (hit) {
        data = hit;
        if (!serverQuery) {
          serverQuery = deepFind(
            v,
            (n) => n && typeof n === 'object' && ('browse_sort' in n || 'num_per_page' in n)
          );
        }
        break;
      }
      if (Array.isArray(v)) {
        for (const entry of v) {
          if (typeof entry !== 'string') continue;
          const parsed = decodeLoose(entry);
          const h2 = parsed ? deepFind(parsed, looksLikeBrowseData) : null;
          if (h2) {
            data = h2;
            break;
          }
        }
        if (data) break;
      }
    }
  }

  return { data, serverQuery };
}

/** 页面里有没有登录墙特征 */
function looksLoggedOut(html) {
  return (
    /id="login_form"|action="https:\/\/steamcommunity\.com\/login\/doLogin|Please sign in|请登录/.test(html) ||
    (!html.includes('window.SSR.renderContext') && /steamcommunity\.com\/login\/home/.test(html))
  );
}

/** 字节数组 → sha1 十六进制（Steam 用 {"_t":0,"v":[...]} 传 hash） */
function sha1HexFromBytes(bytes) {
  if (!Array.isArray(bytes) || bytes.length !== 20) return '';
  return bytes.map((b) => (b & 0xff).toString(16).padStart(2, '0')).join('');
}

/**
 * 从浏览页的 SSR 数据里抽「作者档案」。
 *
 * 好消息：**这个页面本来就带作者信息**，不需要额外的 API key，也不需要多发请求。
 * React Query 缓存里每个作者一条
 *   queryKey=["PlayerLinkDetails","<steamID64>"]
 *   state.data.public_data = { steamid, persona_name, sha_digest_avatar:{_t,v:[20 字节]},
 *                              visibility_state, profile_state, ... }
 * 头像按 Steam 的约定拼：
 *   https://avatars.akamai.steamstatic.com/<sha1hex>_medium.jpg
 *
 * @returns {Object<string, {name:string, avatar:string, profileUrl:string}>} 以 steamID 为键
 */
function extractPlayerLinks(ssrValues) {
  const out = {};
  const rc = ssrValues && ssrValues.renderContext;
  if (!rc || typeof rc.queryData !== 'string') return out;
  const qd = decodeLoose(rc.queryData);
  if (!qd || !Array.isArray(qd.queries)) return out;

  for (const q of qd.queries) {
    const key = q && q.queryKey;
    if (!Array.isArray(key) || key[0] !== 'PlayerLinkDetails') continue;
    const sid = String(key[1] || '');
    if (!/^\d{17}$/.test(sid)) continue;
    const pub = (q.state && q.state.data && q.state.data.public_data) || {};
    const hashBytes = pub.sha_digest_avatar && pub.sha_digest_avatar.v;
    const hex = sha1HexFromBytes(hashBytes);
    out[sid] = {
      steamId: sid,
      name: pub.persona_name || '',
      // SHA 为全 0 表示"没有自定义头像"，此时用默认占位
      avatar: hex && hex !== '0000000000000000000000000000000000000000'
        ? 'https://avatars.akamai.steamstatic.com/' + hex + '_medium.jpg'
        : '',
      profileUrl: pub.profile_url || 'https://steamcommunity.com/profiles/' + sid,
    };
  }
  return out;
}

/**
 * 把一个原始结果项归一化成前端好用的形状。
 * 注意：Steam 的 subscriptions / favorited 是**当前快照值**，
 * lifetime_subscriptions 是历史累计值；列表页只给前者时不要拿来当"总订阅"。
 */
function normalizeItem(raw) {
  if (!raw) return null;
  const tags = Array.isArray(raw.tags)
    ? raw.tags.map((t) => (typeof t === 'string' ? t : t && (t.tag || t.display_name))).filter(Boolean)
    : [];
  const previews = Array.isArray(raw.previews)
    ? raw.previews
        .map((p) => ({
          url: p && (p.url || p.preview_url),
          type: p && p.preview_type !== undefined ? Number(p.preview_type) : null,
        }))
        .filter((p) => p.url)
    : [];

  const fileSize = Number(raw.file_size);
  const votesUp = raw.vote_data ? Number(raw.vote_data.votes_up) : NaN;
  const votesDown = raw.vote_data ? Number(raw.vote_data.votes_down) : NaN;

  return {
    id: String(raw.publishedfileid || raw.id || ''),
    title: raw.title || '(无标题)',
    description: raw.short_description || raw.file_description || '',
    creator: String(raw.creator || ''),
    previewUrl: raw.preview_url || (previews[0] && previews[0].url) || '',
    previews,
    tags,
    fileName: raw.filename || '',
    fileSize: Number.isFinite(fileSize) ? fileSize : null,
    timeCreated: Number(raw.time_created) || null,
    timeUpdated: Number(raw.time_updated) || null,
    // 订阅 / 收藏 / 浏览 / 评分
    subscriptions: Number(raw.subscriptions) || 0,
    lifetimeSubscriptions: Number(raw.lifetime_subscriptions) || 0,
    favorited: Number(raw.favorited) || 0,
    lifetimeFavorited: Number(raw.lifetime_favorited) || 0,
    views: Number(raw.views) || 0,
    comments: Number(raw.num_comments_public) || 0,
    starRating: raw.star_rating === undefined || raw.star_rating === null ? null : Number(raw.star_rating),
    totalVotes: Number(raw.total_votes) || 0,
    votesUp: Number.isFinite(votesUp) ? votesUp : null,
    votesDown: Number.isFinite(votesDown) ? votesDown : null,
    // 类型标签（从 tags 里拆出来，方便卡片角标）
    wallpaperType: pickTypeTag(tags),
    ageRating: pickAgeTag(tags),
    resolution: pickResolutionTag(tags),
    isCollection: Number(raw.file_type) === 2,
    /**
     * 依赖的子项目（"这个壁纸需要另一个壁纸"）。
     *
     * Steam 的创意工坊里"预设/场景依赖另一个壁纸"很常见：只订阅依赖项的话，
     * 到了 Wallpaper Engine 里是加载不出来的（用户就遇到过：订阅了
     * 「德克萨斯-Texas」，结果根本用不了）。客户端订阅时会弹窗问要不要一起订，
     * 我们要在界面上做同样的提示，所以把 `children` 带出来。
     *
     * 只有 GetPublishedFileDetails 会返回这个字段（浏览页 SSR 不返回），
     * 所以 `item.children` 可能是 undefined —— 那是"确认没有依赖"，不是"没查"。
     */
    children: Array.isArray(raw.children)
      ? raw.children
          .filter((c) => c && c.publishedfileid)
          .map((c) => ({
            id: String(c.publishedfileid),
            title: c.title || '(无标题)',
            previewUrl: c.preview_url || '',
          }))
      : undefined,
    raw,
  };
}

/**
 * 卡片上的"类型"角标取值。Steam 的 Type 组是 Scene/Video/Web/Application，
 * Category 组里的 Wallpaper（常规壁纸）/ Preset（预设）在客户端里也算类型，
 * 所以一并认出来 —— 否则静态壁纸的卡片上就没有类型角标。
 */
const TYPE_TAGS = ['Scene', 'Video', 'Web', 'Wallpaper', 'Preset', 'Application'];
const AGE_TAGS = ['Everyone', 'Questionable', 'Mature'];

function pickTypeTag(tags) {
  return tags.find((t) => TYPE_TAGS.some((x) => x.toLowerCase() === String(t).toLowerCase())) || '';
}
function pickAgeTag(tags) {
  return tags.find((t) => AGE_TAGS.some((x) => x.toLowerCase() === String(t).toLowerCase())) || '';
}
function pickResolutionTag(tags) {
  return (
    tags.find((t) =>
      /^(Ultrawide |Portrait |Dual |Triple |Dual-|Triple-)?\d+\s*x\s*\d+$/i.test(String(t).trim())
    ) ||
    tags.find((t) => /resolution|definition/i.test(String(t))) ||
    ''
  );
}

/**
 * 抓并解析一个创意工坊浏览页。
 *
 * 失败会重试：实测 Steam 会**间歇性**返回"精简页"（HTTP 200，但没有 window.SSR，
 * 也就没有列表数据），同一 URL 稍后再打就好了。这里做两级重试：
 *   1. 直接重试同一 URL（间隔 900ms）
 *   2. 换一种 URL 形式（加/去 `l=` 语言参数）再试
 * 不重试的话，用户侧的表现就是"点一下筛选没反应，过一会才好"。
 */
async function fetchBrowse(opts) {
  const variants = [opts.url];
  try {
    const u = new URL(opts.url);
    if (u.searchParams.has('l')) {
      const noLang = new URL(opts.url);
      noLang.searchParams.delete('l');
      variants.push(noLang.toString());
    } else {
      const withLang = new URL(opts.url);
      withLang.searchParams.set('l', opts.language || 'schinese');
      variants.push(withLang.toString());
    }
  } catch (e) {
    /* URL 不合法就不再造变体 */
  }

  let last = null;
  let attempts = 0;

  for (let round = 0; round < 2; round++) {
    for (const url of variants) {
      attempts++;
      /**
       * ⚠️ 这里必须 try/catch。
       *
       * `getText` 在网络层失败时是 **reject**（例如经本地代理打 Steam 时很常见的
       * "Client network socket disconnected before secure TLS connection was established"）。
       * 早期没有包 try/catch，于是一次握手失败就直接把整个 fetchBrowse 抛出去，
       * **连"换一种 URL 形式再试一次"的机会都没有** —— 表现就是"偶尔刷新一下列表就报错"。
       */
      let res;
      try {
        res = await getText(url, {
          cookie: opts.cookie,
          proxy: opts.proxy,
          timeout: opts.timeout || 30000,
          // 合并查询（同类目 OR 的拆解请求）与多页组装由上层按并发数控制，
          // 必须绕开"同 host 每 1200ms 一个请求"的闸门，否则 6 路合并要等 13 秒。
          // 实测并发 4~8 路打浏览页不会被限流（约 3.1~3.4 秒全部返回）。
          noLimit: !!opts.noLimit,
        });
      } catch (e) {
        last = {
          ok: false,
          reason: '访问 Steam 失败：' + (e.message || String(e)),
          networkError: true,
          items: [],
          url,
          attempts,
        };
        await new Promise((r) => setTimeout(r, 700));
        continue;
      }

      if (res.status !== 200) {
        const reason =
          res.status === 429
            ? 'Steam 限流了（HTTP 429）：这一页刚被访问得太频繁，等 1 分钟左右再试'
            : 'Steam 返回 HTTP ' + res.status;
        last = { ok: false, reason: reason, status: res.status, items: [], url };
        // 429 直接放弃，别再试语言变体（只会加重限流）
        if (res.status === 429) return last;
        continue;
      }

      const html = res.body;
      const ssr = collectSsrValues(html);
      const { data, serverQuery } = extractBrowse(ssr);

      if (data) {
        const rawItems = Array.isArray(data.results) ? data.results : [];
        // 顺手把作者昵称/头像补上：浏览页本来就带 PlayerLinkDetails，零额外请求
        const players = extractPlayerLinks(ssr);
        const items = rawItems.map(normalizeItem).filter(Boolean).map((it) => {
          const p = players[it.creator];
          if (!p) return it;
          return Object.assign({}, it, {
            creatorName: p.name || '',
            creatorAvatar: p.avatar || '',
            creatorProfileUrl: p.profileUrl || '',
          });
        });
        return {
          ok: true,
          url,
          attempts,
          page: Number(data.current_page) || 1,
          totalPages: Number(data.total_pages) || 0,
          totalCount: Number(data.total_count) || 0,
          // 总数被 Steam 硬顶在 1000 页
          cappedAt: 1000,
          serverQuery: serverQuery || null,
          playerCount: Object.keys(players).length,
          items,
        };
      }

      last = {
        ok: false,
        reason: looksLoggedOut(html)
          ? '未登录或登录态已失效：Steam 返回了登录页（"我的订阅 / 我的收藏" 必须登录）'
          : '未能从 Steam 页面中解析出作品列表（Steam 可能返回了精简页，稍后重试）',
        status: 200,
        items: [],
        url,
        attempts,
        htmlLength: html.length,
      };

      // 精简页：等一下再换一种形式试
      await new Promise((r) => setTimeout(r, 900));
    }
  }

  if (last) last.attempts = attempts;
  return last || { ok: false, reason: '未知错误', items: [] };
}

/**
 * 抓作品详情页，并抽一些列表页给不了的字段：
 *  - 作者昵称与头像
 *  - 描述正文（BBCode/HTML）
 *  - 当前登录用户是否已订阅 / 已收藏（看按钮的 toggled 类）
 *  - 可用标签（右栏 workshopTags）
 */
async function fetchDetail(opts) {
  const id = String(opts.id || '').replace(/[^0-9]/g, '');
  if (!id) return { ok: false, reason: '缺少作品 id' };
  const language = opts.language || 'schinese';

  // 同一个 id 用两种 URL 形式各试一次。
  // 实测：多条查询参数（?id=..&l=..）有时会被 Steam 回成"精简页"
  // （HTTP 200 但没有详情锚点），而单参数 ?id=.. 正常。两种都试能显著提高成功率。
  const variants = [
    COMMUNITY + '/sharedfiles/filedetails/?id=' + id,
    COMMUNITY + '/sharedfiles/filedetails/?id=' + id + '&l=' + encodeURIComponent(language),
  ];

  let last = null;
  // 最多 3 次（两种 URL 形式交替）。详情页也会间歇性返回"精简页"
  // （HTTP 200 但没有 SubscribeItemBtn / workshopItemTitle 这些锚点），
  // 换一种 URL 形式再试能明显提高成功率；但**不无限试** ——
  // 每次要 1~3 秒，试太多用户就是在看转圈。
  const plan = [variants[0], variants[1 % variants.length], variants[0]];
  for (let i = 0; i < plan.length; i++) {
    const url = plan[i];
    // 同 fetchBrowse：网络层异常必须自己兜住，否则一次 TLS 抖动就让整个详情失败，
    // 连"换一种 URL 形式再试"都走不到。
    let res;
    try {
      res = await getText(url, { cookie: opts.cookie, proxy: opts.proxy, timeout: opts.timeout || 30000 });
    } catch (e) {
      last = { ok: false, reason: '访问 Steam 失败：' + (e.message || String(e)), networkError: true, url };
      if (i < plan.length - 1) await new Promise((r) => setTimeout(r, 700));
      continue;
    }
    if (res.status !== 200) {
      /*
       * 429 要单独说清楚：加了上游冷却之后它会**立刻**返回（不再重试几十秒），
       * 所以文案得能指导用户下一步 —— 不然突然弹个失败比转圈更让人困惑。
       */
      const reason =
        res.status === 429
          ? 'Steam 限流了（HTTP 429）：这个页面刚被访问得太频繁，等 1 分钟左右再点一次'
          : 'Steam 返回 HTTP ' + res.status;
      last = { ok: false, reason: reason, status: res.status, url };
      // 429 直接放弃，别再试后面的语言/URL 变体（只会加重限流）
      if (res.status === 429) return last;
      continue;
    }
    const parsed = parseDetailHtml(res.body, id, url, res.setCookies);
    if (parsed.ok) return parsed;
    last = parsed;
    // 永久不存在的错误页：再试也是白试，直接返回
    if (parsed.notFound) return parsed;
    // 精简页：等一下再换一种形式试
    if (parsed.degraded && i < plan.length - 1) await new Promise((r) => setTimeout(r, 900));
  }
  return last || { ok: false, reason: '详情页获取失败' };
}

/** 把详情页 HTML 解析成结构化结果 */
function parseDetailHtml(html, id, url, setCookies) {
  // 详情页的结构和浏览页**完全不同**：它是经典服务端渲染 HTML，
  // 没有 window.SSR、没有 React Query 缓存（实测 SSR 字段为 0 个）。
  // 所以这里走 HTML 抓取，作品主体字段（标题/标签/作者）再用公开 API 补。
  const isDetailPage = /SubscribeItemBtn|workshopItemTitle|FavoriteItemBtn/.test(html);
  const pageTitle = (html.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
  if (!isDetailPage) {
    /**
     * Steam 对"不存在 / 无权限 / 被限流"的 id 都会回 200 + 非详情页，但**两种要分开**：
     *
     *  a) **永久不存在**：标题是 `Steam 社区 :: 错误`，页面里有 `<div class="error_ctn">`
     *     → 重试没有意义，而且它本身就是"作品不存在"的权威依据
     *       （比再问一次公开 API 还快）。
     *  b) **精简页**：标题正常（就是 app 的名字），只是缺了详情锚点
     *     → 上游抖动，值得换一种 URL 形式重试。
     *
     * 早期把两者混为一谈，于是"作品不存在"也要重试 4 次、每次 1~3 秒 ——
     * 用户侧就是"点了一个不存在的作品，转圈十几秒"。
     */
    const notFound = /::\s*(错误|Error)/i.test(pageTitle) || /class="error_ctn"/.test(html);
    return {
      ok: false,
      notFound: notFound,
      reason: notFound
        ? '作品不存在或已被删除（Steam 返回了错误页）'
        : 'Steam 返回了非详情页（可能被限流）。稍后重试，或换一个网络出口（代理节点）。',
      degraded: !notFound,
      pageTitle,
      id,
      url,
      item: null,
      author: { steamId: '', name: '', avatar: '', url: '' },
      loggedIn: false,
      subscribed: false,
      favorited: false,
      tagOptions: [],
      rating: null,
      collections: 0,
      sessionId: '',
      setCookies: setCookies || [],
      htmlLength: html.length,
    };
  }

  const pick = (re) => {
    const m = html.match(re);
    return m ? decodeEntities(m[1]).trim() : '';
  };

  const title = pick(/<div class="workshopItemTitle">([\s\S]{0,300}?)<\/div>/);

  /**
   * 作者：面包屑里的 "XXX 的创意工坊"。
   *
   * ⚠️ 这里踩过一个真实的坑（测试报告 BUG-12：作者昵称全程为空）：
   *   面包屑里的链接**是 /id/<个性域名>/myworkshopfiles/，不是 /profiles/<steamID64>/**，
   *   只有一部分作者才用数字 profile 链接。原来的正则写死了 `/profiles/(\d{17})/`，
   *   于是绝大多数作品都匹配不到 → name/url 全空，界面只能显示"作者 490138"这种 ID 尾巴。
   *   现在两种写法都接受，steamID64 依旧从公开 API 的 creator 字段拿（更权威）。
   */
  const author = { steamId: '', name: '', avatar: '', url: '' };
  const bm = html.match(
    /<a[^>]+href="(https:\/\/steamcommunity\.com\/(?:profiles\/\d{17}|id\/[^"\/]+)\/myworkshopfiles\/[^"]*)"[^>]*>([\s\S]{0,160}?)<\/a>/
  );
  if (bm) {
    author.url = bm[1].replace(/\/myworkshopfiles\/.*$/, '');
    const pid = author.url.match(/profiles\/(\d{17})/);
    if (pid) author.steamId = pid[1];
    author.name = decodeEntities(bm[2].replace(/<[^>]*>/g, ''))
      .replace(/\s*的创意工坊\s*$/, '')
      .replace(/'s Workshop$/, '')
      .trim();
  }
  if (!author.steamId || !author.name) {
    // ⚠️ 两个坑叠在一起：
    //  1. `class` 不是标签的第一个属性 —— 实际是
    //     `<div data-panel="{...}" class="friendBlock persona offline" data-miniprofile="...">`，
    //     所以不能用 `<div class="friendBlock` 起手，必须允许前面还有别的属性。
    //  2. 写成 `class="friendBlock[^"]*"` 会**误中内部的
    //     `class="friendBlockContent"`**（"Content" 也被 [^"]* 吃掉了），
    //     而那个 div 里既没有资料链接也没有头像。
    const fb = html.match(
      /<div[^>]{0,300}class="friendBlock(?:\s[^"]*)?"[\s\S]{0,900}?<div class="friendBlockContent">([\s\S]{0,200}?)<\/div>/
    );
    if (fb) {
      const seg = fb[0];
      const link = seg.match(/href="https:\/\/steamcommunity\.com\/(?:profiles|id)\/[^"]+"/);
      if (link) {
        author.url = author.url || link[0].replace(/^href="|"$/g, '');
        const pid = author.url.match(/profiles\/(\d+)/);
        if (pid) author.steamId = author.steamId || pid[1];
      }
      if (!author.name) {
        author.name = decodeEntities(fb[1].split('<br')[0].replace(/<[^>]*>/g, '')).trim();
      }
    }
  }

  /**
   * 头像：**只能从"作者卡片"（friendBlock）里取，绝不能扫全页第一个 playerAvatar**。
   *
   * 踩过的坑：详情页顶部的那个 playerAvatar 是**当前登录用户**的头像
   * （导航栏里的自己），所以按下标取第一个的结果是"每个作品的作者头像都长得一样"，
   * 而且那根本不是你。实测两个不同作者的详情页拿到的是同一张
   * `54770f8e…_full.jpg`，一眼假。
   * 这里的做法是：定位作者卡片那一块，并且要求它自己的资料链接和作者对得上，
   * 对不上就宁可不给头像（前端会显示 👤 占位），也不显示错的。
   */
  const fbStart = html.search(/<div[^>]{0,300}class="friendBlock(?:\s[^"]*)?"/);
  if (fbStart >= 0) {
    const seg = html.slice(fbStart, fbStart + 1400);
    const segLink = (seg.match(/href="(https:\/\/steamcommunity\.com\/(?:profiles|id)\/[^"]+)"/) || [])[1] || '';
    const matchesAuthor =
      segLink &&
      (segLink === author.url ||
        (author.steamId && segLink.indexOf('/profiles/' + author.steamId) === 0) ||
        (author.url && segLink.indexOf(author.url) === 0));
    if (matchesAuthor) {
      const av = seg.match(/<img[^>]+src="(https:\/\/avatars\.[^"]+)"/);
      if (av) author.avatar = av[1];
    }
  }

  // 订阅 / 收藏状态：按钮带 toggled + 对应 option 带 selected
  const subscribed =
    /id="SubscribeItemOptionSubscribed"[^>]*class="[^"]*\bselected\b/.test(html) ||
    /id="SubscribeItemBtn"[^>]*class="[^"]*\btoggled\b/.test(html);
  const favorited =
    /id="FavoriteItemOptionFavorited"[^>]*class="[^"]*\bselected\b/.test(html) ||
    /id="FavoriteItemBtn"[^>]*class="[^"]*\btoggled\b/.test(html);

  // 统计表：不重复访客数 / 当前订阅者 / 当前收藏人数
  const stats = {};
  const statRe = /<tr>\s*<td>([^<]*)<\/td>\s*<td>([^<]*)<\/td>\s*<\/tr>/g;
  let sm;
  while ((sm = statRe.exec(html))) {
    const value = decodeEntities(sm[1]).trim();
    const label = decodeEntities(sm[2]).trim();
    if (label) stats[label] = value;
  }

  // 右栏其余字段：文件大小 / 发表于
  const detailStats = [];
  const dsRe = /<div class="detailsStatRight">([\s\S]{0,200}?)<\/div>/g;
  let dm;
  while ((dm = dsRe.exec(html))) detailStats.push(decodeEntities(dm[1]).replace(/<[^>]*>/g, '').trim());

  // 评分文案（"评价数不足" / "好评如潮" 之类）
  const ratingText = pick(/<div class="ratingSection">[\s\S]{0,400}?<\/div>\s*([^<]{1,40}?)\s*<\/div>/);

  /**
   * 评分（星级 + 评价数）—— **唯一拿得到它的地方**。
   *
   * 排查过程（测试报告 BUG-03：详情恒显示 0 星 +「评价数不足」）：
   *   - ISteamRemoteStorage/GetPublishedFileDetails 的返回里**根本没有**
   *     star_rating / total_votes / vote_data（6 个样本逐一验证，只有 26 个固定键）；
   *   - 但是**浏览页的 SSR 结果里有** `star_rating: 4, total_votes: 53`；
   *   - 详情页 HTML 里则是这段：
   *       <div class="ratingSection">
   *         <div class="fileRatingDetails"><img src=".../5-star_large.png?v=2" /></div>
   *         <div class="numRatings">126,787 个评价</div>
   *       </div>
   *     星级就写在图片文件名里（实测 3 星作品就是 `3-star_large.png`）。
   * 所以详情走 HTML 抓，列表走 SSR，两边互补。
   */
  let rating = null;
  const ratingImg = html.match(/class="fileRatingDetails"[\s\S]{0,300}?<img[^>]+src="([^"]+)"/);
  const numRatingsRaw = (html.match(/<div class="numRatings">([\s\S]{0,80}?)<\/div>/) || [])[1] || '';
  if (ratingImg || numRatingsRaw) {
    const starM = String(ratingImg ? ratingImg[1] : '').match(/(\d+(?:[.,]\d+)?)-star/i);
    // -1 表示"评价数不足"，与浏览页 SSR 的约定一致，前端已有对应文案
    const stars = starM ? Number(String(starM[1]).replace(',', '.')) : -1;
    const numM = decodeEntities(numRatingsRaw).replace(/[,\s]/g, '').match(/\d+/);
    rating = {
      stars: stars,
      count: numM ? Number(numM[0]) : 0,
      // Steam 用的是 0~5 的星级，这里给个可直接显示的文案兜底
      label: stars < 0 ? '评价数不足' : stars >= 4.5 ? '好评如潮' : stars >= 4 ? '特别好评' : stars >= 3 ? '好评' : stars >= 2 ? '褒贬不一' : '差评',
    };
  }

  // 收录该作品的合集数量（"查看所有 55,344 个合集"）
  let collections = 0;
  const colM = html.match(/parentCollectionsNumOthers[^>]*>[\s\S]{0,240}?<a[^>]*>\s*([\d,]+)\s*(?:个合集|collections)/i);
  if (colM) collections = Number(String(colM[1]).replace(/,/g, '')) || 0;

  // 标签集（右栏 workshopTags）
  const tagOptions = extractTagOptions(html);

  /**
   * 「必需物品」—— 这件物品依赖的其它创意工坊项目。
   *
   * 页面结构（实测 id=3809945294「德克萨斯-Texas」）：
   *   <div class="rightSectionTopTitle condensed">必需物品</div>
   *   <div class="rightSectionMinorText">这件物品需要以下所有其它物品</div>
   *   <div class="requiredItemsContainer" id="RequiredItems">
   *     <a href="…/workshop/filedetails/?id=921617616" data-subscribed="0">
   *       <div class="requiredItem"> [4K]Audio Visualizer v0.6.6(音频可视化) </div>
   *     </a>
   *   </div>
   *
   * `data-subscribed="1"` 表示当前用户已经订了 —— 正好用来只提示"还缺哪些"。
   *
   * 为什么必须做：只订阅依赖项的话，壁纸在 Wallpaper Engine 里根本加载不出来
   * （用户踩过：订阅了「德克萨斯-Texas」，结果用不了，还不知道为什么）。
   * Steam 客户端订阅这类物品时会弹窗问要不要一起订，我们要做同样的事。
   *
   * 注意：只有**详情页 HTML** 有这个块，浏览页 SSR 和公开的
   * GetPublishedFileDetails 都不返回（后者只给 `children` 字段，而实测是 undefined）。
   */
  const requiredItems = [];
  const reqRe = /<a[^>]*href="[^"]*filedetails\/\?id=(\d+)"[^>]*data-subscribed="(\d)"[^>]*>\s*<div class="requiredItem">([\s\S]{0,300}?)<\/div>/g;
  let rm;
  while ((rm = reqRe.exec(html))) {
    requiredItems.push({
      id: rm[1],
      title: decodeEntities(rm[3].replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim(),
      subscribed: rm[2] === '1',
    });
  }

  // 大图与截图
  const screenshots = [];
  const scRe = /href="(https:\/\/images\.steamusercontent\.com\/ugc\/[^"]+)"/g;
  let scm;
  while ((scm = scRe.exec(html))) {
    if (!screenshots.includes(scm[1])) screenshots.push(scm[1]);
  }

  return {
    ok: true,
    reason: '',
    degraded: false,
    pageTitle,
    id,
    url,
    title,
    author,
    loggedIn: /g_sessionID\s*=\s*"/.test(html),
    subscribed,
    favorited,
    sessionId: (html.match(/g_sessionID\s*=\s*"([^"]+)"/) || [])[1] || '',
    stats,
    detailStats,
    ratingText,
    rating,
    collections,
    tagOptions,
    requiredItems,
    screenshots: screenshots.slice(0, 12),
    // 详情页本体字段有限，主体（标签/文件大小/时间）由公开 API 补齐
    item: null,
    setCookies: setCookies || [],
    htmlLength: html.length,
  };
}

/**
 * 从详情页抽作者信息。
 *
 * ⚠️ 已废弃（保留仅供脚本调试参考）：现在 `parseDetailHtml` 自己解析作者，
 * 而且这里的第 3 条兜底用的是**全页第一个 playerAvatar** —— 那是当前登录用户的头像，
 * 会把「作者头像」显示成你自己的头像（实测两个不同作者拿到同一张图）。
 * 不要在业务代码里调用它。
 */
function extractAuthor(html, item) {
  const out = { steamId: '', name: '', avatar: '', url: '' };
  const wantId = String((item && item.creator) || '').replace(/[^0-9]/g, '');

  // 1) 精确匹配：作者块的 href 指向 creator
  if (wantId) {
    const re = new RegExp(
      'href="https://steamcommunity\\.com/profiles/' + wantId + '"[^>]*>([^<]{1,80})</a>',
      'g'
    );
    let m;
    while ((m = re.exec(html))) {
      const name = decodeEntities(m[1]).trim();
      // 排除"查看您的个人资料"这类当前用户自己的链接文案
      if (name && !/个人资料|Your Profile|查看您/.test(name)) {
        out.steamId = wantId;
        out.name = name;
        break;
      }
    }
    if (!out.name) {
      // 作者名有时在同一块的 <br> 前
      const re2 = new RegExp(
        'profiles/' + wantId + '"[\\s\\S]{0,400}?([^<>{}"]{1,60}?)\\s*<br'
      );
      const m2 = html.match(re2);
      if (m2) out.name = decodeEntities(m2[1]).trim();
    }
    if (out.steamId) {
      out.url = 'https://steamcommunity.com/profiles/' + wantId;
      const idx = html.indexOf('profiles/' + wantId);
      const near = html.slice(Math.max(0, idx - 600), idx + 600);
      const av = near.match(/<img[^>]+src="(https:\/\/avatars\.[^"]+)"/);
      if (av) out.avatar = av[1];
    }
  }

  // 2) 作者块（老式页面结构）
  if (!out.steamId) {
    const block = html.match(
      /<div class="friendBlock[^"]*"[\s\S]{0,800}?<div class="friendBlockContent">([\s\S]{0,200}?)<\/div>/
    );
    if (block) {
      const seg = block[0];
      const link = seg.match(/href="(https:\/\/steamcommunity\.com\/(?:profiles|id)\/[^"]+)"/);
      if (link) {
        out.url = link[1];
        const pid = out.url.match(/profiles\/(\d+)/);
        if (pid) out.steamId = pid[1];
      }
      const name = block[1].split('<br')[0].replace(/<[^>]*>/g, '').trim();
      if (name) out.name = decodeEntities(name);
      if (!out.avatar) {
        const av = seg.match(/<img[^>]+src="([^"]+)"/);
        if (av) out.avatar = av[1];
      }
    }
  }

  // 3) 兜底：mini profile 块 + 文案里的作者名
  if (!out.steamId) {
    const m = html.match(/data-miniprofile="\d+"[^>]*>([^<]{1,60})<\/a>[\s\S]{0,300}?profiles\/(\d{17})/);
    if (m) {
      out.name = decodeEntities(m[1]).trim();
      out.steamId = m[2];
      out.url = 'https://steamcommunity.com/profiles/' + m[2];
    }
  }
  if (!out.name) {
    const n3 = html.match(/查看所有由\s*([^和<]{1,60}?)\s*(?:和其他人)?创建的/);
    if (n3) out.name = decodeEntities(n3[1]).trim();
  }
  if (!out.avatar) {
    // 见函数头注释：这一条会把作者头像取成当前登录用户的头像，仅作调试参考
    const av = html.match(/class="playerAvatar[^"]*"[\s\S]{0,200}?<img[^>]+src="([^"]+)"/);
    if (av) out.avatar = av[1];
  }
  return out;
}

/** 详情页右栏的标签选项（真实存在的标签集，用来渲染筛选器） */
function extractTagOptions(html) {
  const tags = [];
  const re = /<a[^>]+href="[^"]*workshop\/browse\/\?[^"]*requiredtags[^"]*"[^>]*>([^<]{1,60})<\/a>/g;
  let m;
  while ((m = re.exec(html))) {
    const t = decodeEntities(m[1]).trim();
    if (t && !tags.includes(t)) tags.push(t);
  }
  return tags;
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/** 解析 Cookie 串里的 sessionid */
function extractSessionId(cookieStr) {
  const m = String(cookieStr || '').match(/(?:^|;\s*)sessionid=([^;]*)/);
  return m ? m[1] : '';
}

/**
 * 解析 steamLoginSecure = "<steamid64>||<access_token JWT>"，取出过期时间等。
 * 这是 ~24h 的短期票，过期后必须要刷新令牌才能续。
 */
function parseSteamJwt(cookieStr) {
  const m = String(cookieStr || '').match(/(?:^|;\s*)steamLoginSecure=([^;]*)/);
  if (!m) return { present: false };
  let value = m[1];
  try {
    value = decodeURIComponent(value);
  } catch (e) {
    /* 原样使用 */
  }
  const parts = value.split('||');
  const steamId = parts[0] || '';
  const token = parts[1] || '';
  const seg = token.split('.')[1];
  if (!seg) return { present: true, steamId, token, exp: 0 };
  let b64 = seg.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  try {
    const payload = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    return {
      present: true,
      steamId,
      token,
      exp: (payload.exp || 0) * 1000,
      iat: (payload.iat || 0) * 1000,
      rtExp: (payload.rt_exp || 0) * 1000,
      oat: (payload.oat || 0) * 1000,
      ipSubject: payload.ip_subject || '',
      ipConfirmer: payload.ip_confirmer || '',
    };
  } catch (e) {
    return { present: true, steamId, token, exp: 0 };
  }
}

module.exports = {
  COMMUNITY,
  APP_ID,
  matchBalanced,
  decodeLoose,
  collectSsrValues,
  extractBrowse,
  extractPlayerLinks,
  normalizeItem,
  fetchBrowse,
  fetchDetail,
  parseDetailHtml,
  extractSessionId,
  parseSteamJwt,
  decodeEntities,
};
