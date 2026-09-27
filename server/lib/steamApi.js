'use strict';
/**
 * Steam 创意工坊「业务层」：把前端的筛选条件翻译成 Steam 请求，并把结果归一化。
 *
 * 数据来源分工（都实测过）：
 *  ┌─────────────────────────────────────────────┬──────────────────────────────────────┐
 *  │ 社区浏览页 steamcommunity.com/workshop/browse │ 列表 / 排序 / 筛选 / 搜索            │
 *  ├─────────────────────────────────────────────┼──────────────────────────────────────┤
 *  │ 社区收藏接口 /sharedfiles/favorite           │ 收藏 / 取消收藏（Cookie + sessionid） │
 *  │ 社区订阅接口 /sharedfiles/{un,}subscribe     │ 订阅 / 取消订阅                      │
 *  ├─────────────────────────────────────────────┼──────────────────────────────────────┤
 *  │ 作品详情页 /sharedfiles/filedetails/         │ 作者面包屑昵称 / 星级评分 / 截图      │
 *  ├─────────────────────────────────────────────┼──────────────────────────────────────┤
 *  │ ISteamRemoteStorage/GetPublishedFileDetails  │ 批量补详情（公开、无需登录、无 key）  │
 *  ├─────────────────────────────────────────────┼──────────────────────────────────────┤
 *  │ ISteamUser/GetPlayerSummaries                │ 作者昵称 / 头像（需要 key，可选）     │
 *  └─────────────────────────────────────────────┴──────────────────────────────────────┘
 *
 * 明确不用 IPublishedFileService/QueryFiles：它强制要求 API key（无 key 时 403），
 * 而社区浏览页能覆盖同样的排序/筛选，所以没必要引入 key。
 *
 * 范围说明：本项目**只做创意工坊**。原来的「我的订阅 / 我的收藏」两个列表视图
 * （走个人创意工坊页 browsefilter=myfavorites）已经移除 —— 它们与创意工坊主链路
 * 是两套分页语义，维护成本高而价值低。订阅 / 收藏这两个**动作**仍然保留
 * （卡片和详情面板上的按钮），因为那是创意工坊的一部分。
 */

const httpClient = require('./httpClient');
const sc = require('./steamCommunity');
const webApi = require('./steamWebApi');
const authorPage = require('./authorPage');
const pageStore = require('./pageStore');
const { APP_ID, qs, clampInt } = require('./util');

const COMMUNITY = sc.COMMUNITY;
const MAX_PAGE = pageStore.MAX_UPSTREAM_PAGE;   // Steam 硬顶：深翻页最多到 1000 页
const MIN_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 100;                      // 界面上限（30 / 60 / 100）
const DEFAULT_PAGE_SIZE = 30;
const PAGE_SIZE_OPTIONS = [30, 60, 100];

/**
 * trend 的时间窗。WE 客户端是「今日 / 本周 / 本月 / 本年」，对齐之。
 * 实测：`days` 对 trend 结果**确实生效**（days=1 与 days=365 的首页 30 条交集为 0），
 * 但上游回给我们的 `total_count` 是全站投稿量、不随时间窗变化 —— 所以 trend 下
 * totalCount 一律标记为"约"。
 */
const DAY_RANGES = [
  { value: 1, label: '今日' },
  { value: 7, label: '本周' },
  { value: 30, label: '本月' },
  { value: 365, label: '本年' },
];
const DEFAULT_DAYS = 7;

function clampDays(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_DAYS;
  return Math.max(1, Math.min(365, Math.round(n)));
}

/** 把任意 pageSize 收拢到允许的档位（30 / 60 / 100） */
function normalizePageSize(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return DEFAULT_PAGE_SIZE;
  if (n <= MIN_PAGE_SIZE) return MIN_PAGE_SIZE;
  return Math.min(MAX_PAGE_SIZE, n);
}

/** 排序方式 → Steam 的 browsesort 取值 */
const SORTS = {
  trend: { label: '最热门', browseSort: 'trend', needDays: true },
  mostrecent: { label: '最近', browseSort: 'mostrecent' },
  toprated: { label: '评分最高', browseSort: 'toprated' },
  mostsubscribed: {
    label: '订阅最多',
    browseSort: 'totaluniquesubscribers',
    // 实测：这个排序的键是**累计订阅**（lifetime_subscriptions），
    // 而卡片上展示的是当前订阅数，两者不是一回事，所以标签里写清楚。
    hint: '按累计订阅数排',
  },
  lastupdated: { label: '最近更新', browseSort: 'lastupdated' },
};

/**
 * Wallpaper Engine（appid 431960）的标签体系。
 *
 * 这份表不是猜的：浏览页的 SSR 里带一份完整的筛选器定义
 * （`declaredTags`：Type / Age Rating / Genre / Resolution / Category /
 *   Miscellaneous / Languages / #SharedFiles_GameGuides），
 * 本文件按它的**分组、取值、顺序**对齐，中文名对齐 WE 客户端的显示名。
 *
 * 与旧表的差异（用户报的"标签个数对不上 / 选项匹配不上"就是这些）：
 *   - 「常规壁纸(Wallpaper) / 预设(Preset)」在 Steam 里属于 **Category**，
 *     不是 Type；客户端把它们并进"类型"面板，所以这里也并进 type 组。
 *   - 「应用(Application)」客户端不展示（几乎没人投稿这一类），不再放进 type。
 *   - 旧的 content 组把 Genre + Miscellaneous 混在一起（31 个，还多了一个
 *     Steam 已经不存在的 Tutorial），现在拆成：
 *       content = Genre（25 个，与客户端"标签"面板完全一致）
 *       feature = Miscellaneous（10 个）
 *   - 分辨率按客户端的宽屏/超宽屏/双显示器/三显示器/竖屏/其它分类成 subgroups。
 */
const TAG_GROUPS = [
  {
    key: 'type',
    label: '类型',
    tags: ['Scene', 'Video', 'Web', 'Wallpaper', 'Preset'],
  },
  {
    key: 'age',
    label: '年龄分级',
    tags: ['Everyone', 'Questionable', 'Mature'],
  },
  {
    key: 'resolution',
    label: '分辨率',
    // subgroups 只影响"筛选面板怎么分组显示"，查询语义仍是一整组（组内 OR）
    subgroups: [
      {
        label: '宽屏',
        tags: ['Standard Definition', '1280 x 720', '1366 x 768', '1920 x 1080', '2560 x 1440', '3840 x 2160'],
      },
      {
        label: '超宽屏',
        tags: ['Ultrawide Standard Definition', 'Ultrawide 2560 x 1080', 'Ultrawide 3440 x 1440'],
      },
      {
        label: '双显示器',
        tags: ['Dual Standard Definition', 'Dual 3840 x 1080', 'Dual 5120 x 1440', 'Dual 7680 x 2160'],
      },
      {
        label: '三显示器',
        tags: [
          'Triple Standard Definition', 'Triple 4096 x 768', 'Triple 5760 x 1080',
          'Triple 7680 x 1440', 'Triple 11520 x 2160',
        ],
      },
      {
        label: '竖屏',
        tags: [
          'Portrait Standard Definition', 'Portrait 720 x 1280', 'Portrait 1080 x 1920',
          'Portrait 1440 x 2560', 'Portrait 2160 x 3840',
        ],
      },
      {
        label: '其它',
        tags: ['Dynamic resolution', 'Other resolution'],
      },
    ],
  },
  {
    key: 'content',
    label: '标签',
    // = Steam 的 Genre 组（客户端"标签"面板就是它）
    tags: [
      'Abstract', 'Animal', 'Anime', 'Cartoon', 'CGI', 'Cyberpunk', 'Fantasy', 'Game', 'Girls',
      'Guys', 'Landscape', 'Medieval', 'Memes', 'MMD', 'Music', 'Nature', 'Pixel art', 'Relaxing',
      'Retro', 'Sci-Fi', 'Sports', 'Technology', 'Television', 'Vehicle', 'Unspecified',
    ],
  },
  {
    key: 'feature',
    label: '特性',
    // = Steam 的 Miscellaneous 组
    tags: [
      'Approved', 'Audio responsive', '3D', 'Customizable', 'Puppet Warp', 'HDR',
      'Media Integration', 'User Shortcut', 'Video Texture', 'Asset Pack',
    ],
  },
];

/** 分辨率组展开成扁平的 tags（subgroups 只是为了显示分组） */
TAG_GROUPS.forEach((g) => {
  if (g.subgroups && !g.tags) g.tags = g.subgroups.reduce((acc, s) => acc.concat(s.tags), []);
});

/** 所有"合法的"筛选值（组内全集），用来判断"某组是否等于没筛" */
function allTagsOfGroupKey(key) {
  const g = TAG_GROUPS.find((x) => x.key === key);
  return g ? g.tags.slice() : [];
}

/**
 * 某一组的选中值是否覆盖了该组全集。
 *
 * 语义上"全选" = 不筛（每张壁纸都属于其中之一），但如果不识别这种情况，
 * 后端会按"组内 OR"拆成 N 路请求 —— 全选 25 个标签就是 25 路，
 * 又慢又容易被 Steam 限流。所以这里直接把它当空组丢掉。
 */
function isFullGroupSelection(values) {
  const vals = (values || []).filter(Boolean);
  if (!vals.length) return false;
  const group = TAG_GROUPS.find((g) => g.tags && g.tags.every((t) => vals.indexOf(t) >= 0));
  return !!(group && group.tags.length === vals.length);
}

/** 只暴露给前端的排序项（顺序即 UI 顺序） */
const SORT_OPTIONS = Object.entries(SORTS).map(([key, v]) => ({
  key,
  label: v.label,
  hint: v.hint || '',
  needsLogin: false,
}));

/**
 * 拼浏览页 URL。
 * 关键参数：
 *  - browsesort=trend 时 days 才是"最近 N 天"，支持 1/7/30/365（今日/本周/本月/本年）
 *  - `numperpage` **上游完全忽略**（实测 10/24/30/48/60/100 一律返回 30 条），
 *    所以这里恒传 30，真正的"每页 30/60/100"由 pageStore 拼多个上游页实现。
 *  - `requiredtags[]` 的语义**永远是 AND**（实测：多个 requiredtags 时
 *    match_all_tags 传 1 / 0 / true / false / 不传，结果都是 0 条），
 *    所以"组内 OR"没法用参数表达，只能拆成多路请求再合并，
 *    见 queryWorkshop 里的说明。
 */
function buildBrowseUrl(params) {
  const sort = SORTS[params.sort] || SORTS.trend;
  const page = clampInt(params.page, 1, MAX_PAGE, 1);

  const q = {
    appid: APP_ID,
    p: page,
    // 恒 30：上游只认这个值（作者页甚至连 30 以外都会退化成 10 条）
    numperpage: pageStore.UPSTREAM_PAGE_SIZE,
    l: params.language || 'schinese',
  };

  if (sort.browseSort) q.browsesort = sort.browseSort;
  if (sort.needDays) q.days = clampDays(params.days);

  if (params.search) q.searchtext = String(params.search).slice(0, 200);

  const tags = (params.tags || []).filter(Boolean);
  if (tags.length) {
    q['requiredtags[]'] = tags;
    // 语义上就是 AND；显式带上只是为了让 URL 自解释（值不影响结果）
    q.match_all_tags = 1;
  }
  const excluded = (params.excludedTags || []).filter(Boolean);
  if (excluded.length) q['excludedtags[]'] = excluded;

  return COMMUNITY + '/workshop/browse/?' + qs(q);
}

/* ------------------------------------------------------------------ *
 * 同类目 OR、跨类目 AND
 *
 * 背景（真实 bug）：分辨率分组里勾了 2560x1440 + 3840x2160 + … 之后一条都出不来。
 * 根因：`requiredtags[]` 的语义是 **A 且 B 且 …**，而一张壁纸只可能带一个分辨率标签
 * → 逻辑上必然 0 条。
 *
 * 需要的是 WE 客户端那种：
 *   同组内 OR : 分辨率 ∈ {2560x1440, 3840x2160, …}
 *   跨组间 AND: 且 类型 = Scene 且 分级 = Everyone
 *
 * 但社区浏览页**没有**任何"标签分组"参数（实测 taggroups / tags[] 被忽略，
 * match_all_tags 也改不了 AND 语义）。所以只能拆：
 *   - 每个单选类目 → 一条 requiredtags[]（AND）
 *   - 每个多选类目的每个值 → 各发一次请求，然后**轮询合并**
 * 请求数 = 值的总数（不是笛卡尔积），并发 4 路。
 *
 * 为了不让"只勾 2 个分辨率"也要等两轮，合并结果做了 60s 的进程内缓存，
 * 同一组条件翻页时直接命中。
 * ------------------------------------------------------------------ */

/** 合并结果的进程内短缓存：翻页/切排序回退时不用重新合并 */
const MERGE_CACHE = new Map();
const MERGE_TTL_MS = 60 * 1000;
const MERGE_CACHE_MAX = 24;

function mergeCacheGet(key) {
  const hit = MERGE_CACHE.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > MERGE_TTL_MS) {
    MERGE_CACHE.delete(key);
    return null;
  }
  MERGE_CACHE.delete(key);
  MERGE_CACHE.set(key, hit); // LRU
  return hit.value;
}

function mergeCacheSet(key, value) {
  while (MERGE_CACHE.size >= MERGE_CACHE_MAX) {
    MERGE_CACHE.delete(MERGE_CACHE.keys().next().value);
  }
  MERGE_CACHE.set(key, { at: Date.now(), value });
}

/** 合并查询的并发上限（实测并发 8 也不会被限流，但留点余量） */
const MERGE_CONCURRENCY = 12;   // = MERGE_MAX_VALUES：9~12 路一波打完，少一个上游来回（本地代理慢时省 5 秒）
/** 合并路数上限：超过就截断并告知前端（避免"全选 24 个分辨率"打出 24 个请求） */
const MERGE_MAX_VALUES = 12;
/**
 * 归并查询时，每条路最多取几个上游页。
 *
 * 要保证"全局第 N 条"正确，每条路就得取前 N 条；N 越大请求越多。
 * 3 页 = 每路最多 90 条 → 每页 30 条时前 3 页顺序与原站完全一致；
 * 再深的页退回轮询合并（结果仍然正确、顺序近似），并发上限由 MERGE_CONCURRENCY 兜住。
 */
const MERGE_SORTED_MAX_UPSTREAM_PAGES = 4;
/** 组装一个"每页 N 条"的页时，最多并发打几个上游页 */
const ASSEMBLE_CONCURRENCY = 4;
/** GetPublishedFileDetails 的重试次数（noLimit 链路没有内置重试） */
const API_RETRY = 2;

const mapLimit = pageStore.mapLimit;

/**
 * 每种排序对应的"归并键"（越大越靠前）。
 *
 * 只有能从结果字段里还原出排序依据的排序方式才能归并；`trend`（最热门）
 * 用的是 Steam 自己的热度分，结果里没有对应字段，所以它没有键 → 退回轮询。
 */
const MERGE_KEYS = {
  // exact: 这个键就是 Steam 的排序依据（归并后与原站完全同序）
  mostrecent: { exact: true, key: (it) => Number(it.timeCreated) || 0 },
  lastupdated: { exact: true, key: (it) => Number(it.timeUpdated) || Number(it.timeCreated) || 0 },
  mostsubscribed: { exact: true, key: (it) => Number(it.lifetimeSubscriptions || it.subscriptions) || 0 },
  // 评分最高：Steam 内部有它自己的加权（星级 + 评价数的置信区间），结果字段里没有，
  // 只能按"星级 → 评价数"近似归并（实测 30 条里约 27 条位置一致）
  toprated: { exact: false, key: (it) => Number(it.starRating) || 0 },
};

/**
 * k 路归并：把每条路各自的"前 N 条"按排序键合成一个全局有序列表，再切出当前页。
 *
 * 为什么这样能对上原站：每条路本身已是该排序下的有序序列，
 * 全局前 N 条不可能从任何一路取超过 N 条 —— 所以每路取前 N 条再归并，
 * 得到的顺序和"一个真的能表达组内 OR 的接口"返回的顺序一致。
 */
function mergeBySortKey(slices, keyOf, page, pageSize) {
  const seen = new Set();
  const all = [];
  slices.forEach((s) =>
    (s || []).forEach((it) => {
      if (!it || it.id === undefined || seen.has(it.id)) return;
      seen.add(it.id);
      all.push(it);
    })
  );
  all.sort((a, b) => {
    const d = keyOf(b) - keyOf(a);
    if (d) return d;
    // 次级键：评价数 → 订阅数 → id，保证同一键值下顺序稳定（翻页不会跳）
    const dv = (Number(b.totalVotes) || 0) - (Number(a.totalVotes) || 0);
    if (dv) return dv;
    const ds = (Number(b.subscriptions) || 0) - (Number(a.subscriptions) || 0);
    if (ds) return ds;
    return String(b.id).localeCompare(String(a.id));
  });
  const from = (page - 1) * pageSize;
  return all.slice(from, from + pageSize);
}

/**
 * 轮询合并多路子查询。
 *
 * 语义：合并后的第 N 页 = 每路各取**一段**，然后轮流取一条。
 * 关键改进（原来会随 pageSize 放大请求数）：
 *   - 每路在一页里大约只贡献 pageSize / 路数 条，所以只需要取
 *     `prefix = ceil(pageSize / 路数)` 条就够拼满一页；
 *   - 于是"每页 100 条 × 6 路"的请求数仍然是 6（不是 24），
 *     与"每页 30 条 × 6 路"完全一样。
 *   - 每路取的是 [ (page-1)*prefix, page*prefix ) 这一段，
 *     所以分页顺序是稳定的，第 N 页与第 N+1 页不会重叠也不会漏。
 */
function interleave(slices, pageSize) {
  const seen = new Set();
  const out = [];
  const maxLen = slices.reduce((a, s) => Math.max(a, s.length), 0);
  for (let i = 0; i < maxLen && out.length < pageSize; i++) {
    for (const s of slices) {
      const it = s[i];
      if (!it || seen.has(it.id)) continue;
      seen.add(it.id);
      out.push(it);
      if (out.length >= pageSize) break;
    }
  }
  return out;
}

/**
 * 查询创意工坊列表。
 * @param {object} params
 * @param {string} [params.sort]       SORTS 的 key，默认 trend
 * @param {number} [params.days]       仅 sort=trend 有效，1 / 7 / 30 / 365
 * @param {string} [params.search]
 * @param {string[]} [params.tags]     单选类目的标签（彼此 AND）
 * @param {string[][]} [params.orGroups] 多选类目：组内 OR，组间 AND
 * @param {string[]} [params.excludedTags]
 * @param {number} [params.page]       从 1 开始
 * @param {number} [params.pageSize]   30 / 60 / 100（上游恒 30，多出来的由 pageStore 拼页）
 * @param {object} ctx { cookie, proxy, language }
 */
async function queryWorkshop(params, ctx) {
  params = params || {};
  ctx = ctx || {};
  let sort = params.sort;
  if (!sort || !SORTS[sort]) sort = 'trend';

  const pageSize = normalizePageSize(params.pageSize);
  const common = {
    sort,
    days: clampDays(params.days),
    pageSize: pageSize,
    search: params.search,
    excludedTags: params.excludedTags,
    language: ctx.language || params.language,
  };
  const fetchCtx = {
    cookie: ctx.cookie,
    proxy: ctx.proxy,
    language: ctx.language || params.language,
    timeout: ctx.timeout,
  };

  /*
   * 清掉空组（用户点了又取消会留下空数组）；单值组等价于 AND，并进 andTags 更省请求。
   *
   * 另外要把「全选某一组」也丢掉：全选 = 每张壁纸都命中其中之一 = 等于没筛，
   * 但不识别的话会按"组内 OR"拆成 N 路请求（标签组全选就是 25 路），
   * 又慢又容易被上游限流 —— 用户看到的"查询条件太长"就有这一份。
   */
  const groupsIn = (params.orGroups || []).map((g) => (g || []).filter(Boolean)).filter((g) => g.length);
  const rawGroups = groupsIn.filter((g) => !isFullGroupSelection(g));
  const droppedFullGroups = groupsIn.length - rawGroups.length;

  /*
   * 年龄分级只有三个互斥档（Everyone / Questionable / Mature），所以它能被
   * "排除标签"表达得更省，也必须和排除标签保持一致：
   *
   *   1. 只勾了非成人档（G / PG-13）→ 等价于 excludedtags[]=Mature，
   *      一条查询搞定；不识别的话会按"组内 OR"拆成 2 路（慢一倍）。
   *   2. 勾了成人档（R-18）→ 绝不能再带 excludedtags[]=Mature，否则必然 0 条。
   *      界面上勾"成人级"会自动关掉工具条的"隐藏 18+"，这里是后端兜底。
   */
  const AGE_TAGS_ALL = ['Everyone', 'Questionable', 'Mature'];
  let excludedFinal = (params.excludedTags || []).filter(Boolean);
  const ageGroup = groupsIn.find((g) => g.some((t) => AGE_TAGS_ALL.indexOf(t) >= 0));
  if (ageGroup) {
    if (ageGroup.indexOf('Mature') >= 0) {
      excludedFinal = excludedFinal.filter((t) => t !== 'Mature');
    } else {
      if (excludedFinal.indexOf('Mature') < 0) excludedFinal.push('Mature');
      const i = rawGroups.indexOf(ageGroup);
      if (i >= 0) rawGroups.splice(i, 1);
    }
  }
  common.excludedTags = excludedFinal;

  const andTagsAll = (params.tags || []).filter(Boolean).slice();
  const orValues = [];
  rawGroups.forEach((g) => {
    if (g.length === 1) andTagsAll.push(g[0]);
    else g.forEach((v) => orValues.push(v));
  });

  // 页码先按"最多能翻到多少条"粗夹一次，避免用户直接改 URL 打到第 10 万页
  const page = Math.max(1, clampInt(params.page, 1, MAX_PAGE, 1));

  // 缓存键：同一组筛选条件在翻页时直接命中，不用重新合并
  const cacheKey = JSON.stringify([
    sort,
    common.days,
    page,
    pageSize,
    common.search || '',
    andTagsAll.slice().sort(),
    orValues.slice().sort(),
    (common.excludedTags || []).slice().sort(),
  ]);
  const cached = mergeCacheGet(cacheKey);
  if (cached) return Object.assign({}, cached, { cached: true });

  /**
   * 跑一路子查询：取出全局下标 [startIndex, startIndex+count) 的条目。
   *
   * 注意这里不再"一次请求 = 一页"：上游页大小恒为 30，而 pageSize 可能是 60/100，
   * 所以交给 pageStore 去拼若干个上游页再切片。多页时绕开限流闸门
   * （由 mapLimit 控并发），单页时仍然走限流闸门，行为与从前一致。
   */
  const runQuery = async (tags, startIndex, count, opts2) => {
    const r = await pageStore.assemble({
      startIndex: startIndex,
      count: count,
      concurrency: ASSEMBLE_CONCURRENCY,
      makeUrl: (upstreamPage) =>
        buildBrowseUrl(
          Object.assign({}, common, { page: upstreamPage, tags: tags, language: common.language })
        ),
      fetchOne: async (url, upstreamPage, info) => {
        const res = await sc.fetchBrowse(
          Object.assign({}, fetchCtx, {
            url: url,
            // 只要这一发请求需要拼 2 个以上上游页，就绕开限流闸门
            // （否则 4 页排队要等 5 秒）；单页时保持原样走限流。
            //
            // 归并查询（多选类目的每一路）也必须绕开：那种情况下本来就并发打 N 路，
            // 全局闸门会把 9 路串成 9×1200ms 的排队（实测 19 秒）。
            // 并发量由 MERGE_CONCURRENCY / ASSEMBLE_CONCURRENCY 控制。
            noLimit: (info && info.pageCount > 1) || !!(opts2 && opts2.noLimit) || false,
          })
        );
        return res;
      },
    });
    return r;
  };

  const baseStart = (page - 1) * pageSize;

  // ---- 情况 1：没有多选类目（每个类目只勾了一个）→ 一条查询链搞定 ----
  if (!orValues.length) {
    const res = await runQuery(andTagsAll, baseStart, pageSize);
    const built = buildResult(res, {
      sort: sort,
      days: common.days,
      page: page,
      pageSize: pageSize,
      search: common.search,
      requests: res.upstreamPages || 1,
      droppedFullGroups: droppedFullGroups,
    });
    if (built.ok) mergeCacheSet(cacheKey, built);
    return built;
  }

  // ---- 情况 2：有多选类目 → 每个值各跑一路，再归并 ----
  // 不能合成一次请求：requiredtags[] 是 AND，勾了 2K+4K 必然 0 条（实测确认）。
  // 路数有上限：全选分辨率就是 24 路，没必要也扛不住；截断并告知前端。
  const values = orValues.slice(0, MERGE_MAX_VALUES);
  const truncated = orValues.length > values.length;

  /*
   * 两种合并方式：
   *
   *  1) sorted（默认，也是"和 WE 客户端一致"的那种）
   *     按当前排序的键做 **k 路归并**：要拿全局第 (page-1)*pageSize+1 … page*pageSize 条，
   *     每条路取自己前 page*pageSize 条就够（全局前 N 条不可能从任何一路取超过 N 条），
   *     再按排序键归并、切片。这样"最近"的第一页就是全站最新的 30 条，
   *     与客户端/原站一致（旧实现按 pageSize/路数 各取一小段再轮询，
   *     会把很旧的作品塞进第一页 —— 用户报的"结果和排序不一样"就是这个）。
   *
   *     代价：每页每路要 page*pageSize/30 个上游页；太深的页会把请求数放大到不可用，
   *     所以有 MERGE_SORTED_MAX_UPSTREAM_PAGES 上限，超了退回轮询（并标记 mergeMode=approx）。
   *
   *  2) roundrobin（最热门 / 深翻页）
   *     trend 没有可比的数值键（Steam 不公开热度分），只能维持"每路取一小段再轮流取"。
   */
  const mergeKey = MERGE_KEYS[sort] || null;
  const keyOf = mergeKey ? mergeKey.key : null;
  const needPerRoute = page * pageSize;
  const perRoutePages = Math.max(1, Math.ceil(needPerRoute / pageStore.UPSTREAM_PAGE_SIZE));
  const exact = !!keyOf && perRoutePages <= MERGE_SORTED_MAX_UPSTREAM_PAGES;

  const prefix = Math.max(1, Math.ceil(pageSize / values.length));
  const perStart = exact ? 0 : (page - 1) * prefix;
  const perCount = exact ? needPerRoute : prefix;

  const results = await mapLimit(values, MERGE_CONCURRENCY, (v) =>
    runQuery(andTagsAll.concat([v]), perStart, perCount, { noLimit: true })
  );

  const okResults = results.filter((r) => r && r.ok);
  if (!okResults.length) {
    const first = results.find(Boolean) || {};
    return { ok: false, reason: first.reason || '合并查询全部失败', items: [] };
  }

  // 复查：每个结果项必须命中**每一个**多选类目组里的至少一个值
  const slices = okResults.map((r) =>
    (r.items || []).filter((it) => rawGroups.every((g) => g.some((t) => (it.tags || []).includes(t))))
  );
  const totalSum = okResults.reduce((a, r) => a + (r.totalCount || 0), 0);
  // 只有一个多选类目时，各路结果天然互斥（每个值只属于一个类目），总数是准确的；
  // 多个多选类目时各路之间可能有重复项，相加只是上界。
  const multiGroup = rawGroups.filter((g) => g.length > 1).length > 1;

  const mergedItems = exact ? mergeBySortKey(slices, keyOf, page, pageSize) : interleave(slices, pageSize);

  const built = {
    ok: true,
    url: okResults[0].urls && okResults[0].urls[0],
    urls: okResults.reduce((a, r) => a.concat(r.urls || []), []),
    sort: sort,
    sortLabel: SORTS[sort] ? SORTS[sort].label : sort,
    page: page,
    pageSize: pageSize,
    totalCount: totalSum,
    // trend 的 total_count 上游给的是全站投稿量（不随时间窗变化），只能当"约"
    totalCountApprox: multiGroup || sort === 'trend',
    totalCountNote: totalCountNote(sort, multiGroup),
    totalPages: pageStore.totalPagesFor(totalSum, pageSize),
    cappedAt: pageStore.MAX_ITEMS,
    merged: true,
    // sorted = 与客户端同序；approx = 深翻页退化成轮询；roundrobin = 最热门（无法归并）
    mergeMode: exact ? (mergeKey.exact ? 'sorted' : 'sorted_approx') : keyOf ? 'approx' : 'roundrobin',
    mergePerRoute: perCount,
    mergePerRoutePages: perRoutePages,
    droppedFullGroups: droppedFullGroups,
    mergeRequests: okResults.length,
    mergeUpstreamPages: okResults.reduce((a, r) => a + (r.upstreamPages || 0), 0),
    mergedGroups: rawGroups,
    mergedValues: values,
    mergeTruncated: truncated,
    mergeMaxValues: MERGE_MAX_VALUES,
    mergePrefix: prefix,
    serverQuery: okResults[0].serverQuery || null,
    searchNote: searchNote(common.search),
    items: mergedItems,
  };
  mergeCacheSet(cacheKey, built);
  return built;
}

/** 总数为什么只能标"约"的解释（前端 tooltip 用） */
function totalCountNote(sort, multiGroup) {
  const parts = [];
  if (sort === 'trend') {
    parts.push('Steam 在"最热门"下回给我们的总数是全站投稿量，不随今日/本周/本月/本年变化，所以只能当参考');
  }
  if (multiGroup) {
    parts.push('你在多个类目里都选了多个值，各路结果之间可能有重复，相加只是上界');
  }
  return parts.join('；');
}

/**
 * 多词搜索的提示。
 *
 * 实测：`searchtext` 是 Steam 侧的**宽松多词匹配** ——
 * 搜 `zzzznosuchwallpaperxyz` 得 0 条，但搜 `zzzz-no-such-wallpaper-xyz`
 * 会得到 23 万条（因为命中了 `wallpaper` 这个高频词）。这不是本项目的 bug，
 * 但用户看到"搜一个不存在的长串却有 23 万结果"会以为坏了，所以显式提示。
 */
function searchNote(search) {
  const s = String(search || '').trim();
  if (!s) return '';
  const parts = s.split(/[\s\-_,]+/).filter(Boolean);
  if (parts.length <= 1) return '';
  return '「' + s + '」被拆成 ' + parts.length + ' 个词做宽松匹配，任一命中即算，所以结果可能明显偏多；要精确匹配请用单个词。';
}

/** 把一次组装结果整理成统一返回结构 */
function buildResult(res, meta) {
  if (!res.ok) {
    return {
      ok: false,
      reason: res.reason,
      urls: res.urls || [],
      status: res.status,
      failedPages: res.failedPages || 0,
      items: [],
    };
  }
  const pageSize = meta.pageSize || DEFAULT_PAGE_SIZE;
  const totalCount = res.totalCount || 0;
  // 页码要夹到"真的有数据"的范围：Steam 深翻页硬顶 1000 页（约 3 万条），
  // 拿 321 万去除 pageSize 会给出 10 万页这种点不动的页码。
  const totalPages = pageStore.totalPagesFor(totalCount, pageSize);
  const page = Math.max(1, Math.min(meta.page, totalPages));
  return {
    ok: true,
    url: (res.urls && res.urls[0]) || res.url,
    urls: res.urls || [],
    sort: meta.sort,
    sortLabel: SORTS[meta.sort] ? SORTS[meta.sort].label : meta.sort,
    days: meta.days,
    page: page,
    pageSize: pageSize,
    totalPages: totalPages,
    totalCount: totalCount,
    totalCountApprox: meta.sort === 'trend',
    totalCountNote: totalCountNote(meta.sort, false),
    cappedAt: pageStore.MAX_ITEMS,
    serverQuery: res.serverQuery || null,
    merged: false,
    // 被判定为"全选 = 不筛"而丢掉的类目数（前端据此解释为什么没有多打请求）
    droppedFullGroups: meta.droppedFullGroups || 0,
    mergeRequests: meta.requests || 1,
    mergeUpstreamPages: res.upstreamPages || 0,
    failedPages: res.failedPages || 0,
    searchNote: searchNote(meta.search),
    items: res.items || [],
  };
}

/**
 * 批量补详情：ISteamRemoteStorage/GetPublishedFileDetails
 * 公开接口、无需登录、不需要 key —— 一次最多 100 个 id（实测 40/批很稳）。
 * 用途：把浏览页缺失的字段（完整描述、文件名、投票明细）补齐。
 *
 * ⚠️ 实测它返回的键是**固定的那 26 个**，**不含 star_rating / vote_data** ——
 * 所以星级评分只能从详情页 HTML 抓（见 parseDetailHtml 里的 rating 部分）。
 */
async function getDetails(ids, ctx) {
  ctx = ctx || {};
  const list = (Array.isArray(ids) ? ids : [ids])
    .map((x) => String(x).replace(/[^0-9]/g, ''))
    .filter(Boolean)
    .slice(0, 100);
  if (!list.length) return { ok: false, reason: '没有有效的 id', items: [] };

  const form = { itemcount: list.length };
  list.forEach((id, i) => {
    form['publishedfileids[' + i + ']'] = id;
  });

  /**
   * 重试：这条链路是 noLimit 的（api.steampowered.com 与社区页不是同一套限流），
   * 也就享受不到 requestLimited 的重试保护。而它一旦失败，
   * 详情页的主体字段（描述 / 大小 / 时间）就全没了，值得重试两次。
   */
  let res = null;
  let lastErr = '';
  for (let attempt = 0; attempt <= API_RETRY; attempt++) {
    try {
      res = await httpClient.postApiForm(
        'https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/',
        form,
        { proxy: ctx.proxy, timeout: ctx.timeout || 30000, noLimit: true }
      );
    } catch (e) {
      res = null;
      lastErr = e.message || String(e);
    }
    if (res && res.status === 200) break;
    if (attempt < API_RETRY) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
  }

  if (!res) return { ok: false, reason: '访问 Steam API 失败：' + lastErr, items: [] };
  if (res.status !== 200) return { ok: false, reason: 'Steam API HTTP ' + res.status, items: [] };
  let json;
  try {
    json = JSON.parse(res.body);
  } catch (e) {
    return { ok: false, reason: 'Steam API 返回非 JSON', items: [] };
  }
  const arr = (json.response && json.response.publishedfiledetails) || [];
  const items = arr
    .filter((d) => Number(d.result) === 1)
    .map((d) => {
      const norm = sc.normalizeItem({
        publishedfileid: d.publishedfileid,
        title: d.title,
        short_description: d.description,
        creator: d.creator,
        preview_url: d.preview_url,
        tags: d.tags,
        filename: d.filename,
        file_size: d.file_size,
        time_created: d.time_created,
        time_updated: d.time_updated,
        subscriptions: d.subscriptions,
        lifetime_subscriptions: d.lifetime_subscriptions,
        favorited: d.favorited,
        lifetime_favorited: d.lifetime_favorited,
        views: d.views,
        num_comments_public: d.num_comments_public,
        star_rating: d.star_rating,
        total_votes: d.total_votes,
        vote_data: d.vote_data,
        file_type: d.file_type,
        previews: (d.previews || []).map((p) => ({
          url: p.url,
          preview_type: p.preview_type,
        })),
      });
      return norm;
    });
  const missing = arr.filter((d) => Number(d.result) !== 1).map((d) => String(d.publishedfileid));
  return { ok: true, items, missing };
}

/**
 * 单条详情。
 * 三个来源拼起来用：
 *  1. 社区详情页（经典 HTML）→ 作者昵称（面包屑）、**星级评分**、我是否已订阅/已收藏、
 *     统计表、截图、标签集
 *  2. 公开 API GetPublishedFileDetails → 完整描述、文件大小、创建/更新时间
 *     （⚠️ 它**不含** star_rating / vote_data —— 实测全部 6 个样本都没有这两个键，
 *      所以评分只能从详情页 HTML 抓）
 *  3. 浏览页 SSR（仅列表场景）→ star_rating / total_votes
 * 单独任何一个都不够：详情页没有完整描述与时间戳；API 不知道"我订阅了没"，也没有评分。
 */
async function getItemDetail(opts, ctx) {
  ctx = ctx || {};
  const id = String(opts.id || '').replace(/[^0-9]/g, '');
  if (!id) return { ok: false, reason: '缺少作品 id', notFound: false };

  const d = await sc.fetchDetail({
    id,
    cookie: ctx.cookie,
    proxy: ctx.proxy,
    language: ctx.language,
    timeout: ctx.timeout,
  });

  // 用公开 API 补主体字段（不需要登录，不受详情页限流影响）
  let apiItem = null;
  let apiError = '';
  // 两种情况都算"作品不存在"：详情页回了 Steam 的错误页，或公开 API 说没有这个 id
  let notFound = !!d.notFound;
  try {
    const r = await getDetails([id], ctx);
    if (r.ok && r.items.length) apiItem = r.items[0];
    else if (r.missing && r.missing.length) notFound = true;
    else apiError = r.reason || '未取到详情';
  } catch (e) {
    apiError = e.message;
  }

  // 合并：API 是主体，详情页覆盖/补充只有它才有的字段
  let item = apiItem;
  if (item && d.author && d.author.name) {
    item = Object.assign({}, item, {
      creatorName: d.author.name,
      creatorAvatar: d.author.avatar,
      creatorProfileUrl: d.author.url,
    });
  }
  if (item && d.title && !item.title) item.title = d.title;

  // 详情页统计表里的实时数字比 API 的缓存值新，用页面的覆盖
  if (item && d.stats) {
    const num = (s) => {
      const m = String(s || '').replace(/[,\s]/g, '').match(/\d+/);
      return m ? Number(m[0]) : null;
    };
    const subs = num(d.stats['当前订阅者']);
    const favs = num(d.stats['当前收藏人数']);
    const views = num(d.stats['不重复访客数']);
    if (subs !== null) item.subscriptions = subs;
    if (favs !== null) item.favorited = favs;
    if (views !== null) item.views = views;
  }

  // 评分：详情页的 ratingSection（<img src=".../4-star_large.png"> + <div class="numRatings">）
  // 是唯一拿得到星级的来源，见 parseDetailHtml。API 那条路没有这个数据。
  if (item && d.rating) {
    const patch = { starRating: d.rating.stars, totalVotes: d.rating.count };
    if (d.rating.label) patch.ratingText = d.rating.label;
    item = Object.assign({}, item, patch);
  }
  if (item && d.collections) item.collections = d.collections;

  if (item && ctx.apiKey && item.creator && !item.creatorName) {
    try {
      const r = await webApi.getPlayerSummaries([item.creator], ctx);
      const p = r.players && r.players[item.creator];
      if (p && p.name) {
        item = Object.assign({}, item, {
          creatorName: p.name,
          creatorAvatar: p.avatar,
          creatorProfileUrl: p.profileUrl,
        });
      }
    } catch (e) {
      /* 补不上不影响详情 */
    }
  }

  // 详情页拿不到作品主体、API 也拿不到时，才算真的失败。
  //
  // 旧实现在这种情况下仍然返回 ok:true + item:null，前端 detail-pane 把
  // item 为假值一律当成"还没选中"，于是用户看到的是「从左侧点选一张壁纸」这种
  // **静默空态**，完全无从判断是网络问题还是作品不存在（测试报告 BUG-07）。
  // 现在分成两种明确的失败：
  //   - notFound：Steam 明确说没有这个作品 → 作品不存在/已删除
  //   - 其它 → 上游失败，可重试
  if (!item) {
    const why = notFound
      ? '作品 ' + id + ' 不存在或已被删除'
      : d.reason || apiError || 'Steam 没有返回该作品的信息（可能被限流，稍后重试）';
    return {
      ok: false,
      notFound: notFound,
      retryable: !notFound,
      reason: why,
      id,
      url: d.url,
      item: null,
      apiError,
      pageOk: !!d.ok,
      pageReason: d.reason || '',
    };
  }

  return {
    ok: true,
    id,
    url: d.url,
    item,
    // 详情页专有
    pageOk: !!d.ok,
    pageReason: d.reason || '',
    // 详情页抓失败、只剩公开 API 的字段时，明确标记"信息不全"，
    // 让前端给出提示而不是让用户以为这个作品就这么点内容（BUG-13）。
    partial: !d.ok,
    partialReason: d.ok
      ? ''
      : 'Steam 的详情页这次没解析成功（它间歇性会返回精简页），所以只显示了公开接口能给的信息（描述、大小、时间、标签）。图片与作者信息可能缺失。',
    // 作者：昵称用详情页面包屑（准确），头像优先用 PlayerLinkDetails 里按 creator 精确取到的那张。
    // 详情页的 avatar 是正则从页面上"第一个 playerAvatar"抓的，页面被精简时会抓到当前登录用户，
    // 所以它只作为最后兜底。
    author: Object.assign({}, d.author || {}, {
      steamId: (d.author && d.author.steamId) || (item && item.creator) || '',
      name: (d.author && d.author.name) || (item && item.creatorName) || '',
      avatar: (item && item.creatorAvatar) || (d.author && d.author.avatar) || '',
    }),
    loggedIn: !!d.loggedIn,
    subscribed: !!d.subscribed,
    favorited: !!d.favorited,
    stats: d.stats || {},
    detailStats: d.detailStats || [],
    // 评分文案优先用详情页解析出来的（"好评如潮"这类），没有再让前端按星级推
    ratingText: (d.rating && d.rating.label) || d.ratingText || '',
    rating: d.rating || null,
    collections: d.collections || 0,
    tagOptions: d.tagOptions || [],
    screenshots: d.screenshots || [],
    sessionId: d.sessionId || '',
    apiError,
  };
}

/**
 * 详情页之外的补充：「相关壁纸（同作者的全部作品）」。
 *
 * ⚠️ 不能用 /workshop/browse/?creatorid=xxx —— 实测 Steam **忽略 creatorid**，
 * 带不带都是全站结果。必须走作者作品页 /profiles/<steamID64>/myworkshopfiles/。
 *
 * 作者页同样是"上游固定 30 条/页"（而且只有 numperpage=30 生效，其它值退化成 10 条），
 * 所以这里也叠一层 pageStore 组装，支持每页 30/60/100。
 * 旧的 `totalPages = ceil(total / pageSize)` 是把 10 条/页当成 pageSize 算的，
 * 于是"每页 24 条、只回来 9 条、却给 8 页"（测试报告 OBS-6），一并修掉。
 */
/** 作者页的昵称/头像提示（浏览页顺手带过来的，不额外请求） */
function attachCreatorHints(items, hints) {
  if (!hints) return items;
  (items || []).forEach((it) => {
    if (!it) return;
    if (!it.creatorName && hints.name) it.creatorName = hints.name;
    if (!it.creatorAvatar && hints.avatar) it.creatorAvatar = hints.avatar;
  });
  return items;
}

/**
 * Steam Web API：列出某个用户的创意工坊作品。
 *   GET https://api.steampowered.com/IPublishedFileService/GetUserFiles/v1/
 *       ?key=…&steamid=…&appid=431960&numperpage=30&p=1
 *
 * 必须带 key —— 不带直接 401（实测原文：Access is denied. Please verify your key= parameter）。
 * 对"资料设为私密"的作者，社区页一条都看不到（html/xml/rss/workshopitems 全被挡），
 * 这条带 key 的 Web API 是网页端唯一对等的通道。key 在设置页里填
 * （steamcommunity.com/dev/apikey 免费申请）。
 */
async function getWorksViaWebApi(creatorId, o, ctx) {
  const key = (ctx && ctx.apiKey) || '';
  if (!key) return { ok: false, reason: '未配置 Steam Web API key' };
  const size = Math.max(1, Math.min(100, Number(o.pageSize) || 30));
  const url =
    'https://api.steampowered.com/IPublishedFileService/GetUserFiles/v1/' +
    '?key=' + encodeURIComponent(key) +
    '&steamid=' + encodeURIComponent(creatorId) +
    '&appid=' + APP_ID +
    '&numperpage=' + size +
    '&p=' + (Number(o.page) || 1) +
    // 0 = RankedByVote：与社区作者页默认的 "score" 最接近
    '&sortmethod=0' +
    '&return_tags=1&return_previews=1&return_short_description=1&return_vote_data=1&return_kv_tags=1';
  let res;
  try {
    res = await httpClient.getText(url, { proxy: ctx.proxy, timeout: ctx.timeout || 30000, noLimit: true });
  } catch (e) {
    return { ok: false, reason: 'Web API 请求失败：' + e.message };
  }
  if (res.status !== 200) return { ok: false, reason: 'Web API HTTP ' + res.status };
  let json = null;
  try {
    json = JSON.parse(res.body || '{}');
  } catch (e) {
    return { ok: false, reason: 'Web API 返回非 JSON' };
  }
  const resp = (json && json.response) || {};
  const raw = Array.isArray(resp.publishedfiledetails) ? resp.publishedfiledetails : [];
  const items = raw
    .map((d) =>
      sc.normalizeItem({
        publishedfileid: d.publishedfileid,
        title: d.title,
        short_description: d.short_description,
        creator: d.creator,
        preview_url: d.preview_url,
        tags: d.tags,
        filename: d.filename,
        file_size: d.file_size,
        time_created: d.time_created,
        time_updated: d.time_updated,
        subscriptions: d.subscriptions,
        lifetime_subscriptions: d.lifetime_subscriptions,
        favorited: d.favorited,
        views: d.views,
        num_comments: d.num_comments,
        vote_data: d.vote_data,
      })
    )
    .filter(Boolean);
  return { ok: true, items: items, total: Number(resp.total) || items.length };
}

async function getWorksByCreator(creatorId, opts, ctx) {
  opts = opts || {};
  ctx = ctx || {};
  const pageSize = normalizePageSize(opts.pageSize || 30);
  const page = Math.max(1, parseInt(opts.page, 10) || 1);

  /*
   * 优先走 Steam Web API（IPublishedFileService/GetUserFiles，需要 key）。
   *
   * 为什么：作者把 Steam 资料设为「私密」时，社区浏览页只会返回"此个人资料是私密的。"，
   * 一条作品都拿不到（实测：html / xml=1 / rss=1 / workshopitems 四种入口全被挡）。
   * WE 客户端还能列出他的作品，因为它走 Steam 客户端自己的已认证通道；
   * 网页端唯一对等的公开通道就是这条带 key 的 Web API。
   * 没配 key、或这条接口没返回东西 → 回落社区页（老行为，普通作者照旧）。
   */
  if (ctx.apiKey) {
    const viaApi = await getWorksViaWebApi(creatorId, { page: page, pageSize: pageSize }, ctx);
    if (viaApi.ok && viaApi.items.length) {
      attachCreatorHints(viaApi.items, opts.hints);
      return {
        ok: true,
        source: 'webapi',
        items: viaApi.items,
        total: viaApi.total,
        page: page,
        pageSize: pageSize,
        totalPages: pageStore.totalPagesFor(viaApi.total, pageSize),
        url: '',
        urls: [],
        failedPages: 0,
      };
    }
  }

  const assembled = await pageStore.assemble({
    startIndex: (page - 1) * pageSize,
    count: pageSize,
    concurrency: ASSEMBLE_CONCURRENCY,
    makeUrl: (upstreamPage) => authorPage.buildProfileUrl(creatorId, { scope: 'works', page: upstreamPage, appId: APP_ID }),
    fetchOne: async (url, upstreamPage) => {
      const r = await authorPage.fetchProfileWorks(creatorId, {
        scope: 'works',
        page: upstreamPage,
        cookie: ctx.cookie,
        proxy: ctx.proxy,
        timeout: ctx.timeout,
        appId: APP_ID,
        noLimit: true,
        // 重试统一由 pageStore 负责，这里只打一次 —— 两层各自重试会相乘
        attempts: 1,
      });
      // 字段名对齐 pageStore 的约定（作者页解析器用的是 total / upstreamPages）
      return {
        ok: r.ok,
        reason: r.reason,
        items: r.items || [],
        totalCount: r.total || 0,
        totalPages: r.upstreamPages || 0,
        url: r.url || url,
        // 解析器的这两个标记要透传上来：privateProfile 用来给用户一个准确的说明，
        // recognized 用来区分"页面认出来了但确实没有条目"和"页面结构不认识"。
        recognized: !!r.recognized,
        privateProfile: !!r.privateProfile,
      };
    },
  });

  if (!assembled.ok) {
    /*
     * "页面认出来了、但确实一条都没有"不是错误。
     *
     * pageStore 判断 ok 的依据是"有没有取到条目"，所以作者一个公开作品都没有时
     * （Steam 返回正常个人页 + 空列表）会走到这里。以前直接把 ok:false 抛上去，
     * 前端显示红色横幅"加载失败：没有解析到作品（页面结构不认识…）" —— 实测作者
     * 鱼见见见见 共 0 个就是这么来的。这里改成空列表 + empty 标记。
     */
    const first = assembled.first || {};
    // 资料"私密"的作者：明确告诉前端，界面文案要具体（不要说成"页面结构不认识"）
    if (first.privateProfile) {
      return {
        ok: false,
        privateProfile: true,
        reason: first.reason,
        items: [],
        total: 0,
        totalPages: 0,
        url: first.query || '',
        urls: first.query ? [first.query] : [],
      };
    }
    if (first.ok && first.recognized) {
      return {
        ok: true,
        empty: true,
        items: [],
        total: first.total || 0,
        totalPages: 0,
        url: first.url || '',
        urls: first.url ? [first.url] : [],
        reason: '',
      };
    }
    return assembled;
  }

  let items = assembled.items || [];
  const total = assembled.totalCount || 0;

  // 作者作品页只给 id / 标题 / 缩略图，用公开 API 补全标签、订阅数、时间等（一次最多 100 个）
  try {
    const detail = await getDetails(items.map((i) => i.id), ctx);
    if (detail.ok && detail.items.length) {
      const byId = new Map(detail.items.map((d) => [d.id, d]));
      items = items.map((raw) => {
        const d = byId.get(raw.id);
        if (!d) return raw;
        // 详情里的 creator 更权威；标题以详情为准（作者页会做截断）
        return Object.assign({}, raw, d, { title: d.title || raw.title, previewUrl: raw.previewUrl || d.previewUrl });
      });
    }
  } catch (e) {
    /* 补不上就返回作者页的原始信息，不影响列表展示 */
  }

  return {
    ok: true,
    url: (assembled.urls && assembled.urls[0]) || '',
    urls: assembled.urls,
    items: items,
    total: total,
    page: page,
    pageSize: pageSize,
    totalPages: pageStore.totalPagesFor(total, pageSize),
    failedPages: assembled.failedPages || 0,
  };
}

/**
 * 筛选器选项。
 *
 * 标签集用**进程内短缓存**：第一次进页面时顺手拿一页列表统计出真实标签，
 * 之后 10 分钟内直接复用，不再打网络。
 *
 * 这里有意不做"每次请求都去重算"：社区页是全局限流的（800ms/请求），
 * 每次进页面都多打一发列表请求，会把真正要用的筛选请求往后挤，
 * 表现为"点了标签要等好几秒才刷新"。
 */
const TAG_CACHE_MS = 10 * 60 * 1000;
let tagCache = { at: 0, tags: null };
/** 后台标签刷新是否在跑（避免并发重复请求） */
let tagFetching = false;

async function getFilterOptions(ctx) {
  ctx = ctx || {};
  // subgroups 只给前端做"宽屏 / 超宽屏 / 双显示器 / …"的显示分组，
  // 查询时这一整组仍然是一个"组内 OR"。
  const groups = TAG_GROUPS.map((g) => ({
    key: g.key,
    label: g.label,
    tags: g.tags.slice(),
    subgroups: g.subgroups ? g.subgroups.map((s) => ({ label: s.label, tags: s.tags.slice() })) : undefined,
  }));
  let live = tagCache.tags;

  /*
   * 标签兜底刷新：**后台跑，不阻塞这次请求**。
   *
   * 内置表已经和 Steam 的 declaredTags 对齐（Type/Age/Genre/Resolution/Misc），
   * 所以这个"顺手拿一页统计真实标签"的请求只是防 Steam 以后新增标签。
   * 以前它是 await 的：进页面时它会跟真正的列表抢上游带宽，
   * 实测 /api/filters 要 16 秒 —— 用户看到的就是"filters 一直挂起"。
   */
  if (!live && ctx.live !== false && Date.now() - tagCache.at > TAG_CACHE_MS && !tagFetching) {
    tagFetching = true;
    queryWorkshop({ sort: 'trend', days: 7, page: 1, pageSize: 30 }, ctx)
      .then((r) => {
        if (r && r.ok) {
          const set = new Set();
          r.items.forEach((i) => i.tags.forEach((t) => set.add(t)));
          if (set.size > 10) tagCache = { at: Date.now(), tags: Array.from(set) };
        }
      })
      .catch(() => { /* 用内置表 */ })
      .then(() => {
        tagFetching = false;
      });
  }

  if (live) {
    const known = new Set(groups.reduce((acc, g) => acc.concat(g.tags), []));
    // 内置表已对齐 Steam 的 declaredTags；这里只兜底"Steam 以后新增了标签"的情况，
    // 兜底项挂在末尾，不再重排（旧实现会 sort 一遍，顺序和客户端对不上）。
    const extra = live.filter((t) => !known.has(t)).sort((a, b) => a.localeCompare(b));
    if (extra.length) {
      const content = groups.find((g) => g.key === 'content');
      content.tags = Array.from(new Set(content.tags.concat(extra)));
    }
  }

  return {
    ok: true,
    appId: APP_ID,
    sorts: SORT_OPTIONS,
    // 「最热门」的时间窗：今日 / 本周 / 本月 / 本年（对齐 WE 客户端）
    daysOptions: DAY_RANGES.map((d) => ({ value: d.value, label: d.label })),
    defaultDays: DEFAULT_DAYS,
    pageSizeOptions: PAGE_SIZE_OPTIONS.slice(),
    defaultPageSize: DEFAULT_PAGE_SIZE,
    // Steam 深翻页硬顶，界面上要说明"最多能翻到第几页"
    maxItems: pageStore.MAX_ITEMS,
    maxUpstreamPage: pageStore.MAX_UPSTREAM_PAGE,
    groups,
    tagSource: live ? 'steam' : 'static',
    tags: Array.from(new Set(groups.reduce((acc, g) => acc.concat(g.tags), []))),
  };
}

/**
 * 登录态探测：抓一次只有登录后才看得到的个人创意工坊页，看是否被登录墙拦住。
 * 比"字符串里有没有 sessionid=" 可靠得多（旧项目踩过这个坑：过期 Cookie 也看着像有效）。
 *
 * 注意：这里不再借用「我的订阅」列表视图（已移除），改成直接请求
 * /profiles/<自己>/myworkshopfiles/?browsefilter=mysubscriptions 这一个页面 ——
 * 它只服务于"这个 Cookie 还能不能用"的判断，与列表功能无关。
 */
async function whoAmI(ctx) {
  ctx = ctx || {};
  const cookie = ctx.cookie || '';
  if (!cookie) return { loggedIn: false, reason: '没有 Cookie' };

  const jwt = sc.parseSteamJwt(cookie);
  const now = Date.now();
  if (jwt.present && jwt.exp && jwt.exp <= now) {
    return {
      loggedIn: false,
      steamId: jwt.steamId,
      expired: true,
      expiresAt: jwt.exp,
      reason: '登录态已过期（steamLoginSecure 的 JWT 于 ' + new Date(jwt.exp).toLocaleString('zh-CN') + ' 到期）',
    };
  }

  try {
    const r = await authorPage.fetchProfileWorks(jwt.steamId, {
      scope: 'subscriptions',
      page: 1,
      cookie: cookie,
      proxy: ctx.proxy,
      timeout: ctx.timeout,
      appId: APP_ID,
      noLimit: true,
      attempts: 1,
    });
    if (r.ok) {
      return {
        loggedIn: true,
        steamId: jwt.steamId || '',
        expiresAt: jwt.exp || 0,
        source: ctx.cookieSource || 'runtime',
        subscriptions: r.total || 0,
      };
    }
    return {
      loggedIn: false,
      steamId: jwt.steamId || '',
      expiresAt: jwt.exp || 0,
      expired: !!(jwt.exp && jwt.exp <= now),
      reason: r.reason || '无法访问个人创意工坊页',
    };
  } catch (e) {
    return { loggedIn: false, reason: '探测失败：' + e.message };
  }
}

/**
 * 取一个"当下有效"的 sessionid。
 * 关键：Cookie 里的 sessionid 可能过期或者干脆没有，但 Steam 每次 GET 页面都会下发新的，
 * 页面里的 g_sessionID 与之一致 —— 所以先 GET 一次详情页拿新鲜的，再用它发写操作。
 * 这是订阅/收藏接口不返回 401 的关键。
 */
async function acquireSession(ctx, itemId) {
  const detail = await sc.fetchDetail({
    id: itemId || '0',
    cookie: ctx.cookie,
    proxy: ctx.proxy,
    language: ctx.language,
  });
  const sessionId = detail.sessionId || sc.extractSessionId(ctx.cookie);
  let cookie = ctx.cookie || '';

  // 用响应里的 Set-Cookie 把 sessionid 覆盖成新鲜值
  if (detail.setCookies && detail.setCookies.length) {
    const fresh = detail.setCookies
      .map((c) => String(c).split(';')[0])
      .filter(Boolean);
    const map = new Map();
    String(cookie || '')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((kv) => {
        const i = kv.indexOf('=');
        if (i > 0) map.set(kv.slice(0, i), kv.slice(i + 1));
      });
    fresh.forEach((kv) => {
      const i = kv.indexOf('=');
      if (i > 0) map.set(kv.slice(0, i), kv.slice(i + 1));
    });
    cookie = Array.from(map.entries())
      .map(([k, v]) => k + '=' + v)
      .join('; ');
  }
  if (sessionId && !/sessionid=/.test(cookie)) {
    cookie = (cookie ? cookie + '; ' : '') + 'sessionid=' + sessionId;
  } else if (sessionId) {
    cookie = cookie.replace(/sessionid=[^;]*/, 'sessionid=' + sessionId);
  }
  return { sessionId, cookie };
}

/** Steam 写操作返回体判定（它 HTTP 200 但 body 里可能是失败） */
function judgeWrite(status, body) {
  const text = String(body || '');
  if (status === 401) {
    return {
      ok: false,
      needLogin: true,
      reason: '登录态被 Steam 拒绝（HTTP 401）：Cookie 失效，或该 Cookie 的会话绑定了别的 IP。请重新登录一次。',
    };
  }
  if (status !== 200) return { ok: false, reason: 'Steam 返回 HTTP ' + status };
  if (/steam\/login|LoginPage|loginform|you must be logged|not logged in/i.test(text)) {
    return { ok: false, needLogin: true, reason: '登录态已失效，请重新登录' };
  }
  if (/please try again|rate limit/i.test(text)) {
    return { ok: false, reason: 'Steam 限流了，请稍后再试' };
  }
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (e) {
    /* 有些接口返回空体或 HTML 片段 */
  }
  if (json && json.success !== undefined && Number(json.success) !== 1) {
    return { ok: false, reason: 'Steam 返回失败：' + text.slice(0, 200) };
  }
  return { ok: true, raw: json || text.slice(0, 200) };
}

/** 订阅 / 取消订阅 */
async function setSubscription(id, subscribe, ctx) {
  const itemId = String(id).replace(/[^0-9]/g, '');
  if (!itemId) return { ok: false, reason: '缺少作品 id' };
  if (!ctx.cookie) return { ok: false, reason: '需要登录后才能订阅/取消订阅', needLogin: true };

  const { sessionId, cookie } = await acquireSession(ctx, itemId);
  if (!sessionId) return { ok: false, reason: '未能取得 sessionid，请重新登录', needLogin: true };

  const url = COMMUNITY + '/sharedfiles/' + (subscribe ? 'subscribe' : 'unsubscribe');
  const res = await httpClient.postForm(
    url,
    { id: itemId, appid: APP_ID, sessionid: sessionId },
    {
      cookie,
      proxy: ctx.proxy,
      referer: COMMUNITY + '/sharedfiles/filedetails/?id=' + itemId,
    }
  );
  const verdict = judgeWrite(res.status, res.body);
  if (!verdict.ok) return Object.assign({ ok: false, id: itemId }, verdict);
  return { ok: true, id: itemId, subscribed: !!subscribe, raw: verdict.raw };
}

async function subscribe(id, ctx) {
  return setSubscription(id, true, ctx);
}
async function unsubscribe(id, ctx) {
  return setSubscription(id, false, ctx);
}

/** 收藏 / 取消收藏（与订阅同一套 sessionid 机制） */
async function setFavorite(id, favorite, ctx) {
  const itemId = String(id).replace(/[^0-9]/g, '');
  if (!itemId) return { ok: false, reason: '缺少作品 id' };
  if (!ctx.cookie) return { ok: false, reason: '需要登录后才能收藏/取消收藏', needLogin: true };

  const { sessionId, cookie } = await acquireSession(ctx, itemId);
  if (!sessionId) return { ok: false, reason: '未能取得 sessionid，请重新登录', needLogin: true };

  const url = COMMUNITY + '/sharedfiles/' + (favorite ? 'favorite' : 'unfavorite');
  const res = await httpClient.postForm(
    url,
    { id: itemId, appid: APP_ID, sessionid: sessionId },
    { cookie, proxy: ctx.proxy, referer: COMMUNITY + '/sharedfiles/filedetails/?id=' + itemId }
  );
  const verdict = judgeWrite(res.status, res.body);
  if (!verdict.ok) return Object.assign({ ok: false, id: itemId }, verdict);
  return { ok: true, id: itemId, favorited: !!favorite, raw: verdict.raw };
}

async function favorite(id, ctx) {
  return setFavorite(id, true, ctx);
}
async function unfavorite(id, ctx) {
  return setFavorite(id, false, ctx);
}

/** 点赞 / 点踩（Steam 的"评分"） */
async function vote(id, up, ctx) {
  const itemId = String(id).replace(/[^0-9]/g, '');
  if (!itemId) return { ok: false, reason: '缺少作品 id' };
  if (!ctx.cookie) return { ok: false, reason: '需要登录后才能评分', needLogin: true };
  const { sessionId, cookie } = await acquireSession(ctx, itemId);
  const url = COMMUNITY + '/sharedfiles/' + (up ? 'voteup' : 'votedown');
  const res = await httpClient.postForm(
    url,
    { id: itemId, appid: APP_ID, sessionid: sessionId },
    { cookie, proxy: ctx.proxy, referer: COMMUNITY + '/sharedfiles/filedetails/?id=' + itemId }
  );
  const verdict = judgeWrite(res.status, res.body);
  if (!verdict.ok) return Object.assign({ ok: false, id: itemId }, verdict);
  return { ok: true, id: itemId, votedUp: !!up };
}

/**
 * 「已订阅 id 集合」，用于卡片上的「已订阅」角标。
 *
 * 走个人页的 browsefilter=mysubscriptions（浏览页那个参数无效）。
 *
 * 旧实现只取**第一页 30 个**，理由是省首屏时间。但测试报告 BUG-17 实测：
 * 订阅 185 条时，只有第 1~3 页的卡片有角标，第 4 页起全部没有
 * （角标集合与前 30 条之外的交集恒为 0）。用户会以为自己没订阅过、
 * 甚至重复点订阅。
 *
 * 现在改成**翻完所有页**，但：
 *   - 只在后台跑（调用方 await 的是 `background`，不是结果）；
 *   - 上游页大小只能 30（实测其它值退化成 10 条/页），所以用 30；
 *   - 页数上限 MAX_SUB_PAGES，订阅上千个的账号不会把 Steam 打爆；
 *   - 每页一个请求、并发 3，实测 7 页约 3 秒。
 */
const MAX_SUB_PAGES = 12;

async function getSubscribedIds(ctx) {
  const jwt = sc.parseSteamJwt(ctx.cookie);
  if (!jwt.steamId) return { ok: false, needLogin: true, reason: '未登录', ids: new Set(), total: 0 };

  const common = {
    scope: 'subscriptions',
    cookie: ctx.cookie,
    proxy: ctx.proxy,
    timeout: ctx.timeout,
    appId: APP_ID,
    noLimit: true,
    attempts: 1,
  };

  const first = await authorPage.fetchProfileWorks(jwt.steamId, Object.assign({}, common, { page: 1 }));
  if (!first.ok) return { ok: false, reason: first.reason, ids: new Set(), total: 0 };

  const ids = new Set(first.items.map((i) => i.id));
  const total = first.total || ids.size;
  const needPages = Math.min(MAX_SUB_PAGES, Math.ceil(total / pageStore.UPSTREAM_PAGE_SIZE));

  if (needPages > 1) {
    const rest = [];
    for (let p = 2; p <= needPages; p++) rest.push(p);
    const pages = await pageStore.mapLimit(rest, 3, (p) =>
      authorPage.fetchProfileWorks(jwt.steamId, Object.assign({}, common, { page: p }))
    );
    pages.forEach((r) => {
      if (r && r.ok) r.items.forEach((i) => ids.add(i.id));
    });
  }

  return {
    ok: true,
    ids: ids,
    total: total,
    pages: needPages,
    // 订阅超过 MAX_SUB_PAGES × 30 时角标不可能全覆盖，如实告诉前端
    complete: total <= ids.size,
    capped: needPages >= MAX_SUB_PAGES && ids.size < total,
  };
}

module.exports = {
  APP_ID,
  SORTS,
  SORT_OPTIONS,
  TAG_GROUPS,
  DAY_RANGES,
  PAGE_SIZE_OPTIONS,
  DEFAULT_PAGE_SIZE,
  DEFAULT_DAYS,
  MAX_PAGE,
  MIN_PAGE_SIZE,
  MAX_PAGE_SIZE,
  normalizePageSize,
  clampDays,
  buildBrowseUrl,
  queryWorkshop,
  getDetails,
  getItemDetail,
  getWorksByCreator,
  getFilterOptions,
  whoAmI,
  acquireSession,
  setSubscription,
  subscribe,
  unsubscribe,
  setFavorite,
  favorite,
  unfavorite,
  vote,
  getSubscribedIds,
};
