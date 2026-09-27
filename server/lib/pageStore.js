'use strict';
/**
 * 分页组装层：把 Steam「上游固定 30 条/页」硬编码成"客户端想要多少条就多少条"。
 *
 * 为什么必须有这一层（实测结论，见 scripts/debug-upstream-matrix.js）：
 *   - `/workshop/browse/` **完全忽略 `numperpage`**：传 10 / 24 / 30 / 48 / 60 / 100
 *     都一样返回 30 条；不传也是 30 条。即上游页大小恒为 30。
 *   - `/profiles/<id>/myworkshopfiles/`（作者页）更挑：只有 `numperpage=30` 才给 30 条，
 *     其它取值一律退化成 10 条/页。
 *
 * 于是"每页 60 / 100"这种需求只能在上层做：把上游的若干页拼起来再切片。
 * 这一层同时提供**上游页缓存**，因为：
 *   - 每页 100 条 = 4 个上游请求（约 680KB × 4），翻页时相邻页会复用同一批上游页；
 *   - 没有缓存的话"下一页"会把上一页的 4 个请求重打一遍，既慢又浪费 Steam 的限流额度。
 *
 * 容量上限：Steam 深翻页硬顶 1000 页 → 最多 30,000 条可达。总页数按这个上限收敛，
 * 而不是拿一个够不着的 total_count 去除（那会给出 10 万页这种点不动的页码）。
 */

/** 上游固定页大小（实测：browse 恒 30，作者页只有 30 生效） */
const UPSTREAM_PAGE_SIZE = 30;
/** Steam 深翻页硬顶 */
const MAX_UPSTREAM_PAGE = 1000;
/** 实际可达的最大条目数 */
const MAX_ITEMS = UPSTREAM_PAGE_SIZE * MAX_UPSTREAM_PAGE;

/* ------------------------------ 上游页缓存 ------------------------------ */

const TTL_MS = 3 * 60 * 1000;
const MAX_ENTRIES = 160;
const MAX_BYTES = 96 * 1024 * 1024; // 估算上限（按条目数 × 约 2KB 估）
/** 一页不足数时最多再补几个上游页（见 assemble 里的说明） */
const MAX_TOPUP_ROUNDS = 3;
/**
 * 单个上游页取失败时再试几次。
 *
 * ⚠️ 这个次数和"调用方内部自己的重试次数"是**相乘**关系，必须一起看：
 * 早期 `fetchProfileWorks` 内部会试 4 次（2 轮 × 2 种 URL 形式），
 * pageStore 又重试 3 次，再叠上"补页 3 轮"——最坏情况一个请求要打 **36 次**上游。
 * 实测 `/api/author` 因此要 170 秒。
 * 现在调用方用 `attempts: 1`（内部只打一次），重试统一由这里做，最多 2 次。
 */
const PAGE_FETCH_RETRY = 1;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const CACHE = new Map(); // url -> { at, value, bytes }
let cacheBytes = 0;
const stats = { hits: 0, misses: 0, evictions: 0, fetches: 0, errors: 0 };

/** 粗略估算一页的常驻内存（条目对象本身，不含 raw 的重复引用） */
function estimateBytes(page) {
  const n = (page && page.items && page.items.length) || 0;
  return n * 2048 + 512;
}

function cacheGet(url) {
  const hit = CACHE.get(url);
  if (!hit) {
    stats.misses++;
    return null;
  }
  if (Date.now() - hit.at > TTL_MS) {
    CACHE.delete(url);
    cacheBytes -= hit.bytes;
    stats.misses++;
    return null;
  }
  CACHE.delete(url);
  CACHE.set(url, hit); // LRU：命中后移到末尾
  stats.hits++;
  return hit.value;
}

function cacheSet(url, value) {
  const bytes = estimateBytes(value);
  const old = CACHE.get(url);
  if (old) {
    CACHE.delete(url);
    cacheBytes -= old.bytes;
  }
  CACHE.set(url, { at: Date.now(), value, bytes });
  cacheBytes += bytes;
  while ((CACHE.size > MAX_ENTRIES || cacheBytes > MAX_BYTES) && CACHE.size > 1) {
    const oldest = CACHE.keys().next().value;
    const v = CACHE.get(oldest);
    CACHE.delete(oldest);
    cacheBytes -= v ? v.bytes : 0;
    stats.evictions++;
  }
}

function cacheClear() {
  CACHE.clear();
  cacheBytes = 0;
}

function cacheInfo() {
  return {
    entries: CACHE.size,
    bytes: cacheBytes,
    hits: stats.hits,
    misses: stats.misses,
    evictions: stats.evictions,
    fetches: stats.fetches,
    errors: stats.errors,
    upstreamPageSize: UPSTREAM_PAGE_SIZE,
    maxUpstreamPage: MAX_UPSTREAM_PAGE,
    maxItems: MAX_ITEMS,
  };
}

/* ------------------------------ 并发工具 ------------------------------ */

/** 有限并发地跑一组任务（Steam 同一时刻吃太多并发会开始回精简页） */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = new Array(Math.max(1, Math.min(limit, items.length))).fill(0).map(async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/* ------------------------------ 组装 ------------------------------ */

/** 第 index 条落在第几个上游页（1 基） */
function upstreamPageOf(index) {
  return Math.floor(index / UPSTREAM_PAGE_SIZE) + 1;
}

/**
 * 组装任意区间 [startIndex, startIndex + count) 的条目。
 *
 * @param {object} o
 * @param {(upstreamPage:number)=>string} o.makeUrl 生成第 N 个上游页的 URL
 * @param {number} o.startIndex 起始下标（0 基，按上游顺序的全局下标）
 * @param {number} o.count      想要多少条
 * @param {(url:string, upstreamPage:number, info:{index:number,pageCount:number})=>Promise<object>} o.fetchOne
 *        返回 { ok, items, totalCount, totalPages, url, reason }（失败时 ok:false）
 * @param {number} [o.maxUpstreamPage] 默认 1000
 * @param {number} [o.concurrency]     默认 4
 * @returns {Promise<{ok:boolean, items:Array, urls:string[], totalCount:number,
 *                    totalPages:number, fetchedPages:number, failedPages:number,
 *                    reason:string, capped:boolean, first:object|null}>}
 */
async function assemble(o) {
  const startIndex = Math.max(0, Number(o.startIndex) || 0);
  const count = Math.max(0, Number(o.count) || 0);
  const maxPage = Math.min(MAX_UPSTREAM_PAGE, Number(o.maxUpstreamPage) || MAX_UPSTREAM_PAGE);
  const concurrency = Math.max(1, Number(o.concurrency) || 4);

  if (!count) {
    return {
      ok: true, items: [], urls: [], totalCount: 0, totalPages: 0,
      fetchedPages: 0, failedPages: 0, reason: '', capped: false, first: null,
    };
  }

  const firstPage = upstreamPageOf(startIndex);
  if (firstPage > maxPage) {
    return {
      ok: true, items: [], urls: [], totalCount: 0, totalPages: maxPage,
      fetchedPages: 0, failedPages: 0, capped: true, first: null,
      reason: 'Steam 最多只允许翻到第 ' + maxPage + ' 页（约 ' + MAX_ITEMS + ' 条），再往后没有数据了',
    };
  }

  const wantLast = Math.min(upstreamPageOf(startIndex + count - 1), maxPage);
  // 这一发请求需要几个上游页（决定要不要绕开限流闸门：只取 1 页就老实排队）
  const pageCount = wantLast - firstPage + 1;

  /** 计划要取的上游页（升序）；补页时往后追加 */
  const plan = [];
  for (let p = firstPage; p <= wantLast; p++) plan.push(p);

  const results = [];      // 与 plan 一一对应
  const okFlags = [];

  const loadPage = async (p) => {
    const url = o.makeUrl(p);
    const cached = cacheGet(url);
    if (cached) return cached;
    stats.fetches++;

    /**
     * 失败重试。经本地代理访问 Steam 时，"Client network socket disconnected before
     * secure TLS connection was established" 这类握手失败很常见（实测 3 分钟内 ≥6 次），
     * 而且**重试一次基本就好**。不重试的话，用户侧的表现是"翻个页就报错了"。
     */
    let r = null;
    for (let attempt = 0; attempt <= PAGE_FETCH_RETRY; attempt++) {
      try {
        // 第三个参数告诉调用方"一共几个上游页"，好让它决定是否绕开
        // "同 host 每 1200ms 一个请求"的限流闸门：只取 1 页走限流（和以前一样），
        // 要拼 2 页以上就绕开，否则 4 页排队就是 5 秒起步。
        r = await o.fetchOne(url, p, { pageCount: pageCount });
      } catch (e) {
        stats.errors++;
        r = { ok: false, reason: e.message || String(e), items: [], url, page: p, networkError: true };
      }
      if (r && r.ok) break;
      if (attempt < PAGE_FETCH_RETRY) await sleep(500 * (attempt + 1));
    }

    // 失败页不缓存：上游抖动很常见，缓存住会让"重试"也拿不到数据
    if (r && r.ok) cacheSet(url, r);
    return r;
  };

  /**
   * 把 plan 里还没取的页拉下来。
   *
   * 为什么要"补页"（TOPUP_ROUNDS）：
   *  - trend 是**实时榜单**，两次请求之间榜单会挪位，于是相邻上游页可能出现
   *    重复条目（我们用 id 去重）或者少条目；
   *  - 去重之后一页就可能不足数（实测 pageSize=60 只回来 59 条）。
   * 所以只要不够数、后面还有页，就再补一页，最多补 MAX_TOPUP_ROUNDS 页。
   */
  const pullMissing = async () => {
    const batch = plan.slice(results.length);
    if (!batch.length) return;
    const fresh = await mapLimit(batch, concurrency, loadPage);
    fresh.forEach((r) => {
      results.push(r);
      okFlags.push(!!(r && r.ok));
    });
  };

  await pullMissing();

  /** 把已取到的页按顺序拼起来（id 去重）再切片 */
  const buildSlice = () => {
    let firstOkIdx = -1;
    for (let i = 0; i < results.length; i++) {
      if (results[i] && results[i].ok && Array.isArray(results[i].items) && results[i].items.length) {
        firstOkIdx = i;
        break;
      }
    }
    if (firstOkIdx < 0) return { items: [], head: null };

    // 合并必须以"第一个成功的页"为起点，否则下标会错位
    const merged = [];
    const seen = new Set();
    for (let i = firstOkIdx; i < results.length; i++) {
      const r = results[i];
      if (!r || !r.ok || !Array.isArray(r.items)) continue;
      for (const it of r.items) {
        if (!it || seen.has(it.id)) continue;
        seen.add(it.id);
        merged.push(it);
      }
    }
    const offset = (plan[firstOkIdx] - 1) * UPSTREAM_PAGE_SIZE;
    const from = Math.max(0, startIndex - offset);
    return { items: merged.slice(from, from + count), head: results[firstOkIdx] };
  };

  let built = buildSlice();

  if (!built.head) {
    const bad = results.find(Boolean) || {};
    return {
      ok: false,
      reason: bad.reason || 'Steam 没有返回数据',
      items: [],
      urls: results.map((r) => (r && r.url) || ''),
      totalCount: 0,
      totalPages: 0,
      fetchedPages: 0,
      failedPages: results.length,
      capped: false,
      first: bad,
    };
  }

  for (let round = 0; round < MAX_TOPUP_ROUNDS && built.items.length < count; round++) {
    const lastPlanned = plan[plan.length - 1];
    if (lastPlanned >= maxPage) break;

    /**
     * 什么时候才继续往后补页？
     *
     * 只有两个可靠的"列表到头了"信号：
     *  1. 最后一页**一条都没有**；
     *  2. 已经读掉的上游条目数 ≥ 上游报的总数。
     *
     * ⚠️ 不能用"这一页不满 30 条"当信号 —— 浏览页（尤其「最热门」这个实时榜单）
     * 完全可能返回 29 条，那样会误判成"到头了"，结果 pageSize=60 只回来 59 条（实测踩过）。
     * 也不能只看"补出来的条目够不够"就一路补 —— 作者页只有 1 个作品时，
     * 那会补到第 4 页，每页一次网络往返（早期 /api/author 就是这么跑到 170 秒的）。
     */
    const lastRes = results[results.length - 1];
    const lastLen = (lastRes && lastRes.ok && Array.isArray(lastRes.items)) ? lastRes.items.length : 0;
    if (lastLen === 0) break;

    const consumed = results.reduce(
      (a, r) => a + ((r && r.ok && Array.isArray(r.items)) ? r.items.length : 0),
      0
    );
    const totalCount = Number((built.head && built.head.totalCount) || 0);
    const reachedTotal = totalCount > 0 && (plan[0] - 1) * UPSTREAM_PAGE_SIZE + consumed >= totalCount;
    if (reachedTotal) break;

    plan.push(lastPlanned + 1);
    await pullMissing();
    built = buildSlice();
  }

  const head = built.head;
  const okCount = okFlags.filter(Boolean).length;

  return {
    ok: true,
    reason: '',
    items: built.items,
    urls: results.map((r) => (r && r.url) || ''),
    totalCount: Number(head.totalCount) || 0,
    totalPages: Number(head.totalPages) || 0,
    playerCount: head.playerCount,
    serverQuery: head.serverQuery || null,
    fetchedPages: okCount,
    failedPages: results.length - okCount,
    // 本次组装涉及的上游页数（缓存命中时不产生网络请求）
    upstreamPages: plan.length,
    short: built.items.length < count,
    capped: false,
    first: head,
  };
}

/**
 * 由一个 total_count 推出"界面上可点的总页数"。
 *
 * 关键：不能直接 ceil(totalCount / pageSize) —— Steam 深翻页硬顶 1000 页，
 * 也就是最多 30,000 条可达。拿 321 万去除会得出 10 万页，用户点过去只有空页。
 * 所以先和 MAX_ITEMS 取小，再算页数。
 */
function totalPagesFor(totalCount, pageSize) {
  const ps = Math.max(1, Number(pageSize) || UPSTREAM_PAGE_SIZE);
  const reachable = Math.min(Number(totalCount) || 0, MAX_ITEMS);
  return Math.max(1, Math.ceil(reachable / ps));
}

/** 把页码夹到"真的有数据"的范围内 */
function clampPage(page, pageSize, totalCount) {
  const pages = totalPagesFor(totalCount, pageSize);
  return Math.max(1, Math.min(Number(page) || 1, pages));
}

module.exports = {
  UPSTREAM_PAGE_SIZE,
  MAX_UPSTREAM_PAGE,
  MAX_ITEMS,
  assemble,
  mapLimit,
  totalPagesFor,
  clampPage,
  upstreamPageOf,
  cacheInfo,
  cacheClear,
  estimateBytes,
};
