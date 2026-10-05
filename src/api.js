/**
 * 后端接口封装。
 *
 * 加载方式：普通 `<script defer>`（非 ES module），所以挂在 window.WW.api 上，
 * 并在末尾暴露全局 `api` / `imgSrc`，方便组件直接使用。
 * 所有接口统一返回 { ok:true, data } 或 { ok:false, error }，
 * 这里把 ok:false 也转成 reject，调用方只要 try/catch 就够了。
 */
(function (global) {
  'use strict';

  const BASE = '';

  /*
   * 所有接口都从这里过一道，顺便记耗时。
   *
   * 目的：用户报"翻到第 5 页卡住了"时，能一眼看出是**哪一发请求慢/失败**，
   * 还是接口早就回来了、卡在别处。没有这层就只能靠猜。
   *
   * 高频轮询（/api/we/state 之类）不记，否则日志会被刷满、真正有用的行被淹掉。
   */
  const LOG_SKIP = ['/api/we/state', '/api/log', '/api/favicon'];
  function loggable(path) {
    for (const p of LOG_SKIP) if (path.indexOf(p) === 0) return false;
    return true;
  }

  /**
   * 写操作（订阅/收藏/评分）的超时。
   *
   * 读接口可以慢慢等（详情页本来就可能十几秒），但写操作必须有个上限：
   * 上游被 Steam 限流时，后端会重试到几十秒，而前端 fetch **默认没有超时** ——
   * 表现就是按钮一直停在"处理中…"，用户以为程序挂了（实测就是这个问题）。
   * 正常情况下这几秒就回来了，45 秒是很宽松的天花板。
   */
  const WRITE_TIMEOUT_MS = 45000;

  async function request(path, options) {
    const opts = options || {};
    const t0 = Date.now();
    const trace = {};
    // 可选超时（见 WRITE_TIMEOUT_MS）。要能和调用方自己的 signal 共存：
    // 任一先触发都取消这一发。
    let timer = null;
    let timedOut = false;
    let merged = opts;
    if (opts.timeoutMs && typeof AbortController === 'function') {
      const ac = new AbortController();
      const outer = opts.signal;
      if (outer) {
        if (outer.aborted) ac.abort();
        else outer.addEventListener('abort', () => ac.abort(), { once: true });
      }
      timer = setTimeout(() => {
        timedOut = true;
        ac.abort();
      }, opts.timeoutMs);
      merged = Object.assign({}, opts, { signal: ac.signal });
    }
    try {
      const out = await requestInner(path, merged, trace);
      if (window.WLog && loggable(path)) WLog.api(path, Date.now() - t0, true, '', trace.serverMs);
      return out;
    } catch (e) {
      // 超时要报出来（不然又变成"点了没反应"），它和"用户主动取消"是两回事
      if (timedOut) {
        const err = new Error('请求超时（超过 ' + Math.round(opts.timeoutMs / 1000) + ' 秒没响应）');
        err.status = 0;
        err.timeout = true;
        if (window.WLog && loggable(path)) WLog.api(path, Date.now() - t0, false, err.message, trace.serverMs);
        throw err;
      }
      // 主动取消不算失败（翻页/切筛选本来就会取消上一发），记了只会误导
      const aborted = e && e.name === 'AbortError';
      if (window.WLog && loggable(path) && !aborted) {
        WLog.api(path, Date.now() - t0, false, (e && e.message) || String(e), trace.serverMs);
      }
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function requestInner(path, options, trace) {
    const opts = options || {};
    const res = await fetch(BASE + path, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    });
    // 服务端自己处理用了多久（routes.js 回的 X-Api-Ms）。
    // 和前端的总耗时一对比，就能分清"服务端慢"还是"传输慢"。
    if (trace) trace.serverMs = res.headers.get('X-Api-Ms');

    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      const err = new Error('接口返回非 JSON（HTTP ' + res.status + '）：' + text.slice(0, 160));
      err.status = res.status;
      throw err;
    }

    // 统一结构：{ ok, data }
    if (json && typeof json === 'object' && 'ok' in json && 'data' in json) {
      if (!json.ok) {
        const err = new Error(json.error || '接口失败');
        err.status = res.status;
        throw err;
      }
      const data = json.data;
      /*
       * 内层也可能带业务失败（例如写接口返回 { ok:false, reason }）。
       *
       * 这里必须抛出去：以前直接把 data 返回，调用方看到 ok:false 却走了成功分支
       * （或者根本没判断）—— 用户报的"接口明明返回未登录，界面什么都不报、
       * 右上角还显示已登录"就是这么来的。
       */
      if (data && typeof data === 'object' && data.ok === false) {
        const err = new Error(data.error || data.reason || '接口失败');
        err.status = res.status;
        err.needLogin = !!data.needLogin;
        err.notFound = !!data.notFound;
        throw err;
      }
      return data;
    }
    // 业务失败：{ ok:false, error, needLogin?, notFound?, retryable? }
    if (json && json.ok === false) {
      const err = new Error(json.error || '接口失败');
      err.status = res.status;
      err.needLogin = !!json.needLogin;
      err.notFound = !!json.notFound;
      err.retryable = json.retryable !== false;
      err.needForce = !!json.needForce;
      throw err;
    }
    return json;
  }

  /**
   * 把筛选状态序列化成查询串。
   *
   * 重点：标签要按**类目分组**发出去。
   * 之前是把所有标签平铺成 `tags=A,B,C`，后端再用 `match_all_tags=1`
   * （即 "A 且 B 且 C"）—— 于是一旦在分辨率里勾了 2K 和 4K 就必然 0 条，
   * 因为一张壁纸只会带一个分辨率标签。
   * 现在按 WE 的语义发：组内 OR、组间 AND。
   */
  function toQuery(state) {
    const sp = new URLSearchParams();
    sp.set('sort', state.sort);
    // 时间窗只在「最热门」下有意义：今日 / 本周 / 本月 / 本年
    if (state.sort === 'trend') sp.set('days', String(state.days));
    if (state.search) sp.set('search', state.search);

    const groups = state.tagGroups || {};
    Object.keys(groups).forEach((key) => {
      const vals = (groups[key] || []).filter(Boolean);
      if (vals.length) sp.append('g', key + ':' + vals.join(','));
    });
    // 兜底：没有分组信息时按老方式发（会被后端当成"单选类目 AND"）
    if (!Object.keys(groups).length && state.tags && state.tags.length) {
      sp.set('tags', state.tags.join(','));
    }

    // 排除标签 = 用户显式加的 + 「隐藏 18+」自动加上的 Mature
    const exclude = (state.exclude || []).slice();
    if (state.hideMature && exclude.indexOf('Mature') < 0) exclude.push('Mature');
    if (exclude.length) sp.set('exclude', exclude.join(','));

    sp.set('page', String(state.page));
    sp.set('pageSize', String(state.pageSize));
    return sp.toString();
  }

  const api = {
    status: function () {
      return request('/api/status');
    },
    filters: function () {
      return request('/api/filters');
    },
    browse: function (state, signal) {
      return request('/api/browse?' + toQuery(state), { signal: signal });
    },
    /**
     * 作品详情。
     * @param {string} id
     * @param {AbortSignal} [signal]
     * @param {{name?:string,avatar?:string,creator?:string}} [hints]
     *        卡片上已知的作者昵称/头像。浏览页的 PlayerLinkDetails 本来就给了，
     *        带过去可以省一次 Steam 请求，也能兜住详情页被精简的情况。
     */
    item: function (id, signal, hints) {
      const sp = new URLSearchParams({ id: String(id) });
      if (hints) {
        if (hints.name) sp.set('name', hints.name);
        if (hints.avatar) sp.set('avatar', hints.avatar);
        if (hints.creator) sp.set('creator', hints.creator);
      }
      return request('/api/item?' + sp.toString(), { signal: signal });
    },
    details: function (ids) {
      return request('/api/details?ids=' + encodeURIComponent(ids.join(',')));
    },
    /** Wallpaper Engine 状态：安装目录 / 是否在跑 / 当前使用中的作品 id */
    weState: function () {
      return request('/api/we/state');
    },
    /** 设为使用中（后端走 WE 官方 CLI openWallpaper） */
    weApply: function (id, monitor, force) {
      return request('/api/we/apply', {
        method: 'POST',
        body: { id: String(id), monitor: Number(monitor) || 0, force: !!force },
      });
    },
    /**
     * 已订阅项目清单（本地库口径：订阅时间 / 搜索 / 排序 / 分页）
     * @param {AbortSignal} [signal] 切换视图 / 快速翻页时用来取消上一发
     */
    subscribed: function (opts, signal) {
      const o = opts || {};
      const sp = [];
      if (o.page) sp.push('page=' + o.page);
      if (o.pageSize) sp.push('pageSize=' + o.pageSize);
      if (o.search) sp.push('search=' + encodeURIComponent(o.search));
      if (o.sort) sp.push('sort=' + encodeURIComponent(o.sort));
      // fresh=1：绕过服务端缓存，重新读盘 + 重新拉 Steam 订阅列表（「刷新」按钮用）
      if (o.fresh) sp.push('fresh=1');
      return request('/api/subscribed' + (sp.length ? '?' + sp.join('&') : ''), { signal: signal });
    },
    author: function (id, page, pageSize, creator, signal) {
      // 把已知的作者昵称/头像一起带上：浏览页的 PlayerLinkDetails 本来就给了，
      // 这样后端不用再为"取个名字"多打一次 Steam（个人页本身不含作者昵称）。
      const sp = new URLSearchParams({
        id: String(id),
        page: String(page || 1),
        pageSize: String(pageSize || 24),
      });
      if (creator && creator.name) sp.set('name', creator.name);
      if (creator && creator.avatar) sp.set('avatar', creator.avatar);
      return request('/api/author?' + sp.toString(), { signal: signal });
    },
    subscribedIds: function () {
      return request('/api/subscribed-ids');
    },

    subscribe: function (id, action) {
      return request('/api/item/subscribe', {
        method: 'POST',
        body: { id: id, action: action },
        timeoutMs: WRITE_TIMEOUT_MS,
      });
    },
    favorite: function (id, action) {
      return request('/api/item/favorite', {
        method: 'POST',
        body: { id: id, action: action },
        timeoutMs: WRITE_TIMEOUT_MS,
      });
    },
    vote: function (id, action) {
      return request('/api/item/vote', {
        method: 'POST',
        body: { id: id, action: action },
        timeoutMs: WRITE_TIMEOUT_MS,
      });
    },

    session: function () {
      return request('/api/session');
    },
    setSession: function (payload) {
      return request('/api/session', { method: 'POST', body: payload });
    },
    clearSession: function () {
      return request('/api/session', { method: 'DELETE' });
    },
    verifySession: function (force) {
      return request('/api/session/verify', { method: 'POST', body: { force: !!force } });
    },
    pullParent: function () {
      return request('/api/session/pull-parent', { method: 'POST', body: {} });
    },
    sessionEvents: function () {
      return request('/api/session/events');
    },
  };

  global.WW = global.WW || {};
  global.WW.api = api;
  global.api = api;
})(window);
