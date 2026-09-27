/**
 * 主应用。
 *
 * 布局对齐 WE 客户端的「创意工坊」页：
 *   ┌──────────────────────── 顶栏：标签页 + 状态/设置 ───────────────────────┐
 *   ├──────────────┬──────────────────────────────────┬──────────────────────┤
 *   │ 筛选器        │ 搜索 + 排序 + 网格 + 分页          │ 详情面板              │
 *   └──────────────┴──────────────────────────────────┴──────────────────────┘
 *
 * 视图模式（mode）：
 *   browse  — 创意工坊列表（排序 / 筛选 / 搜索）
 *   author  — 某作者的全部作品（"相关壁纸"跳转到这里）
 *
 * ⚠️ 范围：本项目**只做创意工坊**。「我的订阅 / 我的收藏」两个列表视图已按需求移除
 * —— 它们与创意工坊主链路是两套分页语义（个人创意工坊页的 numperpage 只有 30 生效），
 * 维护成本高而价值低。订阅 / 收藏这两个**动作**仍然保留（卡片和详情面板上的按钮），
 * 「已订阅」角标也保留（订阅集合会翻完所有页，不再只覆盖前 30 条）。
 */

/** 排序项的中文名（提示文案用） */
const SORT_LABEL = {
  trend: '最热门',
  mostrecent: '最近',
  toprated: '评分最高',
  mostsubscribed: '订阅最多',
  lastupdated: '最近更新',
};

/** 兜底的时间窗（正常情况下用后端 /api/filters 给的带标签版本） */
const DEFAULT_DAY_OPTIONS = [
  { value: 1, label: '今日' },
  { value: 7, label: '本周' },
  { value: 30, label: '本月' },
  { value: 365, label: '本年' },
];

/** 兜底的每页档位 */
const DEFAULT_PAGE_SIZES = [30, 60, 100];

/**
 * 列表/详情请求失败后自动重试的次数。
 * 上游（经代理访问 Steam）握手失败很常见，实测 3 分钟内会出现 6 次以上
 * 「Client network socket disconnected before secure TLS connection was established」。
 * 这种抖动重试一次基本就好，没必要让用户自己点。
 */
const AUTO_RETRY = 2;

/**
 * 筛选/排序/分页状态的本地持久化。
 *
 * 之前刷新一次页面所有选择就没了（用户明确提过），所以整包存 localStorage：
 * 排序、时间窗、每页条数、页码、搜索词、各类目已选标签、排除标签、隐藏 18+。
 * 读取时只做"形状"校验，真正的合法性（标签是否还存在）等 /api/filters 回来再裁。
 */
const STATE_KEY = 'ww.state.v1';
/** 本地"屏蔽该作者"名单（右键菜单 → 报告和阻止 → 屏蔽该作者） */
const BLOCK_KEY = 'ww.blocked.v1';
const CHIP_LIMIT = 6;

function loadSavedState() {
  try {
    const raw = window.localStorage.getItem(STATE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    return s && typeof s === 'object' ? s : null;
  } catch (e) {
    return null; // 隐私模式/损坏的 JSON：静默降级
  }
}

function saveState(state) {
  try {
    window.localStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch (e) {
    /* 写不进去就算了，不影响主流程 */
  }
}

/** 把存下来的 filters 洗一遍：只接受已知字段与合法类型 */
function sanitizeFilters(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const arr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x) : []);
  const tagGroups = {};
  if (src.tagGroups && typeof src.tagGroups === 'object') {
    Object.keys(src.tagGroups).forEach((k) => {
      const vals = arr(src.tagGroups[k]);
      if (vals.length) tagGroups[k] = vals;
    });
  }
  const days = Number(src.days);
  const pageSize = Number(src.pageSize);
  return {
    sort: typeof src.sort === 'string' && src.sort ? src.sort : 'trend',
    days: [1, 7, 30, 365].indexOf(days) >= 0 ? days : 7,
    search: typeof src.search === 'string' ? src.search : '',
    tagGroups: tagGroups,
    exclude: arr(src.exclude),
    hideMature: src.hideMature === undefined ? true : !!src.hideMature,
    page: Number.isFinite(Number(src.page)) && Number(src.page) > 0 ? Math.floor(Number(src.page)) : 1,
    pageSize: [30, 60, 100].indexOf(pageSize) >= 0 ? pageSize : 30,
  };
}

const SAVED = loadSavedState();
const SAVED_FILTERS = sanitizeFilters(SAVED && SAVED.filters);

function loadBlocked() {
  try {
    const raw = window.localStorage.getItem(BLOCK_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string' && x) : [];
  } catch (e) {
    return [];
  }
}

function saveBlocked(list) {
  try {
    window.localStorage.setItem(BLOCK_KEY, JSON.stringify(list));
  } catch (e) {
    /* 写不进去不影响当前会话 */
  }
}

new Vue({
  el: '#app',

  data() {
    return {
      // 视图
      mode: 'browse',
      authorView: null,

      // 筛选状态（会整包发给后端）
      // tagGroups 按**类目**保存已选标签：组内 OR、组间 AND
      //   { type: ['Scene'], resolution: ['3840 x 2160', '2560 x 1440'] }
      // 初值来自 localStorage（上次的筛选/排序/分页），没有存过就是下面这套默认值
      filters: SAVED_FILTERS,
      searchInput: SAVED_FILTERS.search,
      /** 顶部"已选标签"条是否展开（默认只显示前几个，避免一大片标签把工具条撑满） */
      chipsExpanded: false,

      // 数据
      meta: null,
      items: [],
      totalCount: 0,
      totalCountApprox: false,
      totalPages: 0,
      page: 1,
      loading: false,
      error: '',
      /** 这一轮加载是什么时候开始的 / 每秒刷新的计时（用于"上游有点慢"提示） */
      loadingSince: 0,
      nowTick: 0,
      lastResult: null,
      /** 上次成功结果的页码，出错时用来提示"下面还是第 N 页的旧数据" */
      staleFrom: 0,
      /** 自动重试计数（指数退避，最多 AUTO_RETRY 次） */
      retryCount: 0,
      retryTimer: null,
      /** 可关闭的提示条（多词搜索、页数上限等） */
      dismissedNotes: {},

      // 详情
      selected: null,
      detail: null,
      detailLoading: false,
      detailError: '',
      detailNotFound: false,
      /**
       * 「相关壁纸」单独一份状态。
       * 它的数据源是作者的个人创意工坊页，比详情本身慢得多，所以**并发去拉**，
       * 拿到了再填进面板 —— 否则点一张壁纸要等十几秒才出内容。
       */
      related: null,
      relatedLoading: false,
      relatedError: '',

      // 会话
      status: null,
      session: null,
      /**
       * Wallpaper Engine 状态（"设为使用中"用）。
       *   available  = 找到 WE 安装目录 + 创意工坊内容目录
       *   running    = WE 进程正在跑（CLI 命令必须有接收方）
       *   currentIds = 当前桌面上正在使用的作品 id 列表（按显示器）
       */
      we: {
        available: false, running: false, currentIds: [], weDir: '', wsDir: '', error: '',
        /** 本地创意工坊库：已下载（能设为使用中）与已订阅（acf） */
        installed: [], localSubscribed: [],
      },
      host: detectHost(),
      settingsOpen: false,

      // 交互
      subscribedIds: {},
      /** 订阅角标链路失败的原因（空 = 正常） */
      subsError: '',
      /** Steam 订阅列表是否拿到了（拿到了就以它为准判断"已订阅"） */
      subsListOk: false,
      favoriteIds: {},
      /** 右键菜单状态：{ open, x, y, item } */
      menu: { open: false, x: 0, y: 0, item: null },
      /**
       * 「已订阅」视图（本地库口径，见 /api/subscribed）。
       * 订阅时间来自项目文件夹创建时间，所以不需要登录、也不受 Steam 订阅页限流影响。
       */
      subs: {
        items: [], totalCount: 0, totalPages: 1, page: 1, pageSize: 30,
        search: '', sort: 'time_desc', loading: false, error: '', wsDir: '',
        /** 'steam' = 以 Steam 订阅列表为准；'local' = 退回本地库 */
        source: '', staleLocalCount: 0,
      },
      subsSearchInput: '',
      /** 本地屏蔽的作者 steamId 列表 */
      blockedCreators: loadBlocked(),
      /** 磁盘占用：{ [id]: bytes } —— 由 /api/details 批量补，卡片左下角显示 */
      fileSizes: {},
      busyIds: {},
      toast: null,
      toastTimer: null,
      requestSeq: 0,
    };
  },

  computed: {
    /** 每页条数：30 / 60 / 100（上游恒 30 条/页，多出来的由后端拼页实现） */
    pageSizeOptions() {
      return (this.meta && this.meta.pageSizeOptions) || DEFAULT_PAGE_SIZES;
    },
    sortOptions() {
      return (this.meta && this.meta.sorts) || [];
    },
    /**
     * 「最热门」的时间窗：今日 / 本周 / 本月 / 本年（对齐 WE 客户端）。
     * 后端给的是 [{value,label}]；这里兼容旧的纯数字数组。
     */
    daysOptions() {
      const raw = (this.meta && this.meta.daysOptions) || DEFAULT_DAY_OPTIONS;
      return raw.map((d) => (typeof d === 'object' ? d : { value: d, label: '最近 ' + d + ' 天' }));
    },
    currentSort() {
      return this.sortOptions.find((s) => s.key === this.filters.sort) || null;
    },
    /** 排序项自带的使用说明（例如"订阅最多"按的是累计订阅） */
    sortHint() {
      const s = this.currentSort;
      if (!s) return '';
      const parts = [];
      if (s.hint) parts.push(s.hint);
      if (s.key === 'mostsubscribed') {
        parts.push('卡片上显示的是当前订阅数，两者可能对不上，这是 Steam 的排序键决定的');
      }
      return parts.join('；');
    },
    loggedIn() {
      // 有 Cookie ≠ 登录态可用：Cookie 过期时 Steam 会拒绝写操作（401）。
      // 被拒过一次（session.invalid）就不再显示"已登录"，避免误导。
      return !!(this.session && this.session.hasCookie && !this.session.invalid);
    },
    /** 顶栏登录态的三种状态 */
    loginState() {
      if (!this.session || !this.session.hasCookie) return 'none';
      return this.session.invalid ? 'invalid' : 'ok';
    },
    loginText() {
      if (this.loginState === 'invalid') return '登录态失效';
      return this.loginState === 'ok' ? '已登录' : '未登录';
    },
    loginTitle() {
      if (this.loginState === 'invalid') {
        return '登录态被 Steam 拒绝：' + (this.session.invalidReason || 'Cookie 失效') +
          '\n订阅 / 收藏 / 点赞点踩会失败，去「设置」里重新登录（粘贴新 Cookie）即可恢复。';
      }
      if (this.loginState === 'ok') return '已登录：' + ((this.session && this.session.steamId) || '');
      return '未登录（浏览 / 搜索 / 筛选 / 详情都不受影响）';
    },
    /** 分页按钮：1 2 3 4 5 … 1000，对齐 WE 的样式 */
    pageButtons() {
      const total = Math.min(this.totalPages || 1, 1000);
      const cur = this.page;
      const out = [];
      const push = (v) => {
        if (v >= 1 && v <= total && out.indexOf(v) < 0) out.push(v);
      };
      [1, 2, 3, 4, 5, 6].forEach(push);
      if (cur > 7) {
        out.push('…');
        out.push(cur - 1);
        out.push(cur);
        out.push(cur + 1);
      }
      out.push('…');
      push(total);
      return out.slice(0, 14);
    },
    /** 已订阅视图的分页按钮（样式同主列表，用自己的页码） */
    subsPageButtons() {
      const total = Math.max(1, this.subs.totalPages || 1);
      const cur = Math.max(1, this.subs.page || 1);
      const out = [];
      const push = (v) => {
        if (v >= 1 && v <= total && out.indexOf(v) < 0) out.push(v);
      };
      if (total <= 7) {
        for (let i = 1; i <= total; i++) out.push(i);
        return out;
      }
      [1, 2].forEach(push);
      if (cur > 3) out.push('…');
      push(cur);
      if (cur < total - 1) out.push('…');
      push(total);
      return out;
    },

    /** 已选标签（扁平），用于"已选标签"条 */
    activeTagChips() {
      const g = this.filters.tagGroups || {};
      return Object.keys(g).reduce((acc, k) => acc.concat(g[k] || []), []);
    },
    /** 屏蔽名单 → 便于模板里 O(1) 判断 */
    /**
     * 真正要发给后端的筛选：剔除"整组全选"的类目。
     * 后端也会丢（isFullGroupSelection），这里是为了不发一段毫无意义的长 URL。
     */
    effectiveTagGroups() {
      const g = this.filters.tagGroups || {};
      const out = {};
      Object.keys(g).forEach((k) => {
        const vals = (g[k] || []).filter(Boolean);
        if (vals.length && !this.isGroupFull(k)) out[k] = vals;
      });
      return out;
    },
    blockedIds() {
      const m = {};
      (this.blockedCreators || []).forEach((id) => {
        m[id] = true;
      });
      return m;
    },
    /** 网格真正渲染的条目：本地屏蔽的作者不出现在列表里 */
    visibleItems() {
      if (!(this.blockedCreators || []).length) return this.items;
      const blocked = this.blockedIds;
      return this.items.filter((it) => !blocked[it.creator]);
    },
    blockedOnPage() {
      return this.items.length - this.visibleItems.length;
    },
    /** 顶部标签条默认只铺前 CHIP_LIMIT 个，剩下的点"还有 N 个"再看 */
    /**
     * 顶部标签条按**类目**分组显示。
     *
     * 语义是"同类目内满足任一、跨类目同时满足"，所以平铺成一条
     * "满足任一（42）"是错的 —— 42 个里既有类型又有分辨率，跨类目是 AND。
     */
    chipGroups() {
      const sel = this.filters.tagGroups || {};
      const groups = (this.meta && this.meta.groups) || [];
      const out = groups
        .filter((g) => (sel[g.key] || []).length)
        .map((g) => ({ key: g.key, label: g.label, tags: sel[g.key].slice(), full: this.isGroupFull(g.key) }));
      // meta 还没回来时的兜底：至少别把已选值弄丢
      Object.keys(sel).forEach((k) => {
        if (out.some((x) => x.key === k) || !(sel[k] || []).length) return;
        out.push({ key: k, label: k, tags: sel[k].slice(), full: false });
      });
      return out;
    },
    visibleChipGroups() {
      const all = this.chipGroups;
      if (this.chipsExpanded) return all;
      let left = CHIP_LIMIT;
      return all
        .map((g) => {
          // 整组全选只渲染一个"全选（不筛）"小块，**不占**标签额度 ——
          // 否则"类型/年龄/标签全选"会把额度吃光，分辨率那 9 个值一个都显示不出来。
          if (g.full) return Object.assign({}, g, { tags: [], clipped: false });
          const tags = g.tags.slice(0, Math.max(0, left));
          left -= tags.length;
          return Object.assign({}, g, { tags: tags, clipped: tags.length < g.tags.length });
        })
        .filter((g) => g.tags.length || g.full);
    },
    /** 真正参与查询的已选标签数（整组全选 = 不筛，不计入） */
    effectiveChipCount() {
      return this.chipGroups.reduce((a, g) => a + (g.full ? 0 : g.tags.length), 0);
    },
    hiddenChipCount() {
      const shown = this.visibleChipGroups.reduce((a, g) => a + g.tags.length, 0);
      const n = this.effectiveChipCount - shown;
      return n > 0 ? n : 0;
    },
    /** 某个类目的选中集是否等于该类的全集（= 等于没筛） */
    isGroupFull() {
      const groups = (this.meta && this.meta.groups) || [];
      return (key) => {
        const g = groups.find((x) => x.key === key);
        const sel = (this.filters.tagGroups || {})[key] || [];
        return !!(g && g.tags.length && sel.length >= g.tags.length && g.tags.every((t) => sel.indexOf(t) >= 0));
      };
    },
    hasAnyFilter() {
      const g = this.filters.tagGroups || {};
      // "整组全选"在后端等于不筛（见 steamApi.isFullGroupSelection），这里也别报"已筛选"
      const anyEffectiveTag = Object.keys(g).some((k) => (g[k] || []).length && !this.isGroupFull(k));
      return (
        this.filters.search ||
        anyEffectiveTag ||
        this.filters.exclude.length ||
        this.filters.sort !== 'trend'
      );
    },

    /**
     * 总数的说明文案（有的话显示成可 hover 的小问号）。
     * 「最热门」下 Steam 回给我们的 total_count 是**全站投稿量**，不随时间窗变化，
     * 所以只能说"约"；多路合并时各路相加只是上界，同样只能"约"。
     */
    countNote() {
      const r = this.lastResult;
      if (!r) return '';
      return r.totalCountNote || (r.totalCountApprox ? '这个总数只是参考值。' : '');
    },
    /** 深翻页上限说明：Steam 只允许翻到第 1000 页（约 3 万条） */
    pageCapNote() {
      const r = this.lastResult;
      if (!r || !r.cappedAt) return '';
      if (!this.totalPages || this.totalPages < 1000) return '';
      return (
        'Steam 对创意工坊的深翻页有硬顶：最多翻到第 1000 页，也就是约 ' +
        this.fmtCount(r.cappedAt) +
        ' 条。所以"共 300 多万"并不代表都能翻到，靠筛选缩小范围更实际。'
      );
    },
    searchNote() {
      return (this.lastResult && this.lastResult.searchNote) || '';
    },

    /**
     * 加载超过 6 秒时给的提示：上游（Steam / 本地代理）偶尔会限流，
     * 卡在骨架屏上什么也不说会让人以为坏了。
     */
    slowHint() {
      if (!this.loading || !this.loadingSince) return '';
      const ms = (this.nowTick || Date.now()) - this.loadingSince;
      if (ms < 6000) return '';
      return '上游响应有点慢（已等待 ' + Math.round(ms / 1000) + ' 秒，Steam 偶尔会限流）…';
    },

    /**
     * 合并查询的说明文案。
     * 「同类目多选 = 或」在 Steam 侧没法用参数表达，是靠拆成多路请求合并出来的，
     * 所以这里显式告诉用户"这次查询合并了几路 / 是否被截断"，避免以为卡住了。
     */
    mergeInfo() {
      const r = this.lastResult;
      if (!r || !r.merged) return null;
      const mode = r.mergeMode || 'roundrobin';
      const sortName = r.sortLabel || '当前排序';
      // 「同类目多选 = 或」在 Steam 侧没有参数能表达，只能按值拆路再合并；
      // 合并方式决定顺序是否与原站一致，这里必须说清楚（用户就是被这个坑过）。
      const head = '已合并 ' + r.mergeRequests + ' 路';
      const notes = {
        sorted: {
          text: head + '（按' + sortName + '归并，顺序与原站一致）',
          title:
            '同类目里选多个 = 满足其中一个，Steam 没有对应参数，所以按值拆成 ' +
            r.mergeRequests + ' 次查询，再按「' + sortName + '」重新归并 —— ' +
            '第 1 页就是全局最新的 ' + (r.pageSize || 30) + ' 条，和 Wallpaper Engine 客户端一致。',
        },
        approx: {
          text: head + '（翻得太深，顺序为近似）',
          title:
            '要保证顺序完全一致，每一路都要取到第 ' + r.page + ' 页，请求量会随页数放大；' +
            '所以从第 ' + (r.mergePerRoutePages || 4) + ' 页之后改成轮询合并：结果都在，顺序近似。',
        },
        sorted_approx: {
          text: head + '（按评分归并，顺序近似）',
          title:
            '「评分最高」的排序在 Steam 内部有它自己的加权（星级 + 评价数的置信区间），' +
            '结果里拿不到这个分值，只能按"星级 → 评价数"近似归并 —— ' +
            '实测前 30 条里约 27 条位置与客户端一致。',
        },
        roundrobin: {
          text: head + '（最热门无法归并，按路轮询）',
          title:
            '「最热门」用的是 Steam 自己的热度分，结果字段里没有对应的数值，' +
            '没法像"最近/评分最高"那样重新归并，所以保持按路轮询的顺序。',
        },
      };
      const note = notes[mode] || notes.roundrobin;
      if (r.mergeTruncated) {
        return {
          text: head + '（最多 ' + r.mergeMaxValues + ' 个值）',
          title:
            '你选的标签值太多，只取了前 ' + r.mergeMaxValues + ' 个。' +
            'Steam 不支持"同类目任选其一"的查询，只能按值逐个查再合并，所以做了上限。',
        };
      }
      return note;
    },
  },

  /**
   * 非响应式内部状态：AbortController 与防抖函数都不该进 Vue 的响应式系统
   * （Vue 2 会深度遍历 data，把 AbortController 包成 observed 对象，属于白白开销）。
   */
  _inflight: null,
  _debouncedSearch: null,
  _debouncedReload: null,
  /** 已经问过"大小"的 id → 时间戳（非响应式；失败过的不在 5 分钟内反复问） */
  _sizeTried: null,
      /** 订阅 id 集合是否已经拉过一次（它慢，放在列表之后拉） */
      _subsLoaded: false,
      /** 订阅角标取不到时提示过一次 */
      _subsWarned: false,
      /** 登录态失效提示过一次 */
      _invalidWarned: false,
  /** 加载计时器（只在 loading 时每秒更新 nowTick） */
  _tickTimer: null,

  /**
   * 筛选状态一变就落 localStorage（含排序 / 时间窗 / 每页 / 页码 / 搜索词 /
   * 已选标签 / 排除标签 / 隐藏 18+），刷新后原样恢复。
   */
  watch: {
    filters: {
      deep: true,
      handler() {
        this.persistState();
      },
    },
    page() {
      this.persistState();
    },
  },

    created() {
      this.loadMeta();
      this.loadStatus();
      this.loadSession();
      this.loadWeState();
      this.loadList();
      this.tryParentCookie();
      // "使用中"会随着用户在 WE 客户端里切换而变，隔一会儿对一次表；
      // 页面在后台时不用查（读 config.json + tasklist，没必要空转）。
      this._weTimer = setInterval(() => {
        if (!document.hidden) this.loadWeState();
      }, 90000);
    // 搜索框自动搜索（打字防抖 600ms）：不用每次点按钮，
    // 也避免"点一下按钮 = 一次新请求"，把 Steam 的限流额度省下来。
    this._debouncedSearch = debounce(() => {
      if (this.searchInput.trim() !== this.filters.search) this.submitSearch();
    }, 600);
    // 筛选变化的防抖（连点多个复选框时只发一次请求，见 applyFilters 注释）
    this._debouncedReload = debounce(() => this.loadList(), 450);

    // 宿主接入桥：iframe 场景由父页面推 Cookie / 下发命令；qiankun 场景走全局状态
    const self = this;
    WWHost.attach({
      onSession(session) {
        self.applyHostSession(session);
      },
      onCommand(command, value) {
        if (command === 'reset') self.resetFilters();
        if (command === 'search' && typeof value === 'string') {
          self.searchInput = value;
          self.submitSearch();
        }
      },
    });

    window.addEventListener('message', this.onHostMessage);
  },

  beforeDestroy() {
    window.removeEventListener('message', this.onHostMessage);
    if (this._weTimer) clearInterval(this._weTimer);
    if (this._tickTimer) clearInterval(this._tickTimer);
  },

  methods: {
    fmtCount: formatCount,
    typeLabel: typeLabel,
    tagLabel: tagLabel,
    formatSize: formatSize,
    formatDate: formatDate,
    shorten(s, n) {
      const t = String(s || '');
      return t.length > (n || 40) ? t.slice(0, n || 40) + '…' : t;
    },
    openOnSteam: openOnSteam,

    /** 搜索框输入：防抖后自动搜 */
    onSearchInput() {
      if (this._debouncedSearch) this._debouncedSearch();
    },

    /* ------------------------------ 加载 ------------------------------ */

    async loadMeta() {
      try {
        this.meta = await api.filters();
        this.pruneSavedFilters();
      } catch (e) {
        this.meta = null;
      }
    },

    /** 把本地存下来的筛选值里"已经不存在的标签"裁掉（Steam 改过标签表就要靠它兜底） */
    pruneSavedFilters() {
      const groups = (this.meta && this.meta.groups) || [];
      if (!groups.length) return;
      const known = new Set(groups.reduce((acc, g) => acc.concat(g.tags || []), []));
      const next = {};
      let changed = false;
      Object.keys(this.filters.tagGroups || {}).forEach((k) => {
        const vals = (this.filters.tagGroups[k] || []).filter((t) => known.has(t));
        if (vals.length) next[k] = vals;
        if (vals.length !== (this.filters.tagGroups[k] || []).length) changed = true;
      });
      const exclude = (this.filters.exclude || []).filter((t) => known.has(t) || t === 'Mature');
      if (exclude.length !== (this.filters.exclude || []).length) changed = true;
      if (changed) {
        this.filters = Object.assign({}, this.filters, { tagGroups: next, exclude: exclude });
      }
    },

    /** 落盘：整包筛选状态（刷新后恢复用） */
    persistState() {
      saveState({ v: 1, at: Date.now(), filters: this.filters });
    },

    /**
     * 批量补"磁盘占用"。
     *
     * 用 /api/details（ISteamRemoteStorage/GetPublishedFileDetails）：
     * 公开接口、不需要登录、一次能带 100 个 id，正好覆盖一页（30/60/100）。
     * 拿不到就只是不显示角标，不影响列表。
     */
    async loadFileSizes(items) {
      if (!this._sizeTried) this._sizeTried = new Map();
      const now = Date.now();
      const ids = [];
      (items || []).forEach((it) => {
        const id = it && it.id ? String(it.id) : '';
        if (!id || this.fileSizes[id]) return;
        const tried = this._sizeTried.get(id) || 0;
        if (now - tried < 5 * 60 * 1000) return;
        if (ids.indexOf(id) < 0) ids.push(id);
      });
      if (!ids.length) return;
      ids.forEach((id) => this._sizeTried.set(id, now));
      try {
        const r = await api.details(ids.slice(0, 100));
        const next = Object.assign({}, this.fileSizes);
        let changed = false;
        (r.items || []).forEach((it) => {
          const size = Number(it && it.fileSize) || 0;
          if (it && it.id && size > 0 && next[it.id] !== size) {
            next[it.id] = size;
            changed = true;
          }
        });
        if (changed) this.fileSizes = next;
      } catch (e) {
        /* 大小只影响角标，失败静默 */
      }
    },

    /** 顶部标签条：一键清空所有已选标签 */
    clearTagChips() {
      this.chipsExpanded = false;
      this.onFilterInput(Object.assign({}, this.filters, { tagGroups: {} }));
    },

    /** 只清掉某一个类目的已选值（顶部标签条上的"全选（不筛）"点这里） */
    clearGroup(key) {
      const g = Object.assign({}, this.filters.tagGroups);
      delete g[key];
      this.onFilterInput(Object.assign({}, this.filters, { tagGroups: g }));
    },

    /** 从某个类目里摘掉一个值（顶部标签条点 ✕） */
    removeTagIn(key, tag) {
      const g = Object.assign({}, this.filters.tagGroups);
      const vals = (g[key] || []).filter((x) => x !== tag);
      if (vals.length) g[key] = vals;
      else delete g[key];
      this.onFilterInput(Object.assign({}, this.filters, { tagGroups: g }));
    },

    async loadStatus() {
      try {
        this.status = await api.status();
      } catch (e) {
        this.status = null;
      }
    },

    async loadSession() {
      try {
        this.session = await api.session();
        if (this.session && this.session.invalid && !this._invalidWarned) {
          this._invalidWarned = true;
          this.showToast('登录态已被 Steam 拒绝：' + (this.session.invalidReason || '') + '（订阅/收藏会失败，去设置里重新登录）', 'error');
        }
        // 有 Cookie 但还没校验过（或校验结果过期）→ 后台真校验一次，
        // 免得"右上角显示已登录、一点订阅才报 401"。后端对结果有 3 分钟缓存。
        if (this.session && this.session.hasCookie &&
            Date.now() - (this.session.verifiedAt || 0) > 3 * 60 * 1000) {
          this.verifyQuietly();
        }
      } catch (e) {
        this.session = null;
      }
    },

    /** 后台校验登录态（不打扰用户，只在发现失效时更新状态并提示一次） */
    async verifyQuietly() {
      try {
        const r = await api.verifySession();
        if (!r.loggedIn) {
          await this.loadSession();
        } else if (this.session && this.session.invalid) {
          await this.loadSession();
        }
      } catch (e) {
        /* 校验失败不影响浏览 */
      }
    },

    /** Wallpaper Engine / 本地库状态（"使用中"角标与"设为使用中"按钮依赖它） */
    async loadWeState() {
      try {
        const r = await api.weState();
        this.we = {
          available: !!r.available,
          running: !!r.running,
          currentIds: r.currentIds || [],
          weDir: r.weDir || '',
          wsDir: r.wsDir || '',
          error: r.error || '',
          monitors: r.monitors || [],
          installed: r.installed || [],
          localSubscribed: r.localSubscribed || [],
        };
      } catch (e) {
        this.we = Object.assign({}, this.we, { available: false, error: e.message });
      }
    },

    /** 这个作品是不是当前正在使用的桌面壁纸 */
    isCurrentWallpaper(id) {
      return !!(id && (this.we.currentIds || []).indexOf(String(id)) >= 0);
    },

    /**
     * "已订阅"的判定：Steam 订阅列表 ∪ 本地库。
     *
     * 为什么要并本地库：Steam 那份订阅列表要翻完用户所有订阅（慢），而且 Cookie 一过期就
     * 整条链路失败 —— 表现就是"客户端明明显示已订阅，我们这边看不出任何区别"。
     * 本地已下载的作品必然已订阅，直接用目录/acf 判定最快也最准。
     */
    isSubscribedId(id) {
      if (!id) return false;
      const key = String(id);
      // Steam 订阅列表拿到了就以它为准 —— 取消订阅后 Steam 不会立刻删本地文件，
      // 只看本地库会一直显示"已订阅"（用户实测报过）。
      if (this.subsListOk) return !!this.subscribedIds[key];
      if (this.subscribedIds[key]) return true;
      return (this.we.localSubscribed || []).indexOf(key) >= 0 || this.isInstalledId(key);
    },

    /** 本地已下载（WE 才加载得动它 → 才能"设为使用中"） */
    isInstalledId(id) {
      return !!(id && (this.we.installed || []).indexOf(String(id)) >= 0);
    },

    /** 能不能把这个作品设为使用中：装了 WE + 本地有文件 */
    canApplyId(id) {
      return !!(this.we.available && this.isInstalledId(id));
    },

    /**
     * 设为使用中：走后端 → WE 官方 CLI（openWallpaper）。
     * 失败原因基本都是可预期的（WE 没开 / 订阅还没下载完），直接如实告诉用户。
     */
    async applyWallpaper(item) {
      const id = item && item.id;
      if (!id) return;
      if (!this.we.available) {
        this.showToast('没找到 Wallpaper Engine 安装目录，没法设置使用中', 'error');
        return;
      }
      if (!this.isInstalledId(id)) {
        this.showToast('这个壁纸还没订阅/没下载到本地，WE 加载不了它（先订阅并等 Steam 下完）', 'warn');
        return;
      }
      this.markBusy(id, true);
      try {
        const r = await api.weApply(id);
        this.showToast(r.message || '已设为桌面壁纸', 'ok');
        await this.loadWeState();
        notifyHost({ event: 'apply', id: id });
      } catch (e) {
        // 本机枚举进程被拒 → 问一句再直接试（用户明确点了"设为使用中"，多半 WE 就是开着的）
        if (e.needForce) {
          const go = window.confirm(e.message + '\n\n要直接按 64/32 位顺序尝试一次吗？（如果 WE 真的没开，会顺带把它启动起来）');
          if (go) {
            try {
              const r2 = await api.weApply(id, 0, true);
              this.showToast(r2.message || '已设为桌面壁纸', 'ok');
              await this.loadWeState();
              return;
            } catch (e2) {
              this.showToast('设为使用中失败：' + e2.message, 'error');
              return;
            }
          }
          return;
        }
        this.showToast('设为使用中失败：' + e.message, 'error');
      } finally {
        this.markBusy(id, false);
      }
    },

    async loadSubscribedIds() {
      try {
        const r = await api.subscribedIds();
        const map = {};
        (r.ids || []).forEach((id) => {
          map[id] = true;
        });
        this.subscribedIds = map;
        this.subsError = '';
        this.subsListOk = true;
        // 订阅数超过后端一次能翻完的量时，角标不可能全覆盖，如实说明
        if (r.capped) {
          this.showToast(
            '你的订阅较多（' + this.fmtCount(r.total) + ' 个），角标只覆盖了前 ' + this.fmtCount(Object.keys(map).length) + ' 个',
            'warn'
          );
        }
      } catch (e) {
        // 取不到角标不致命，但要让用户知道原因（多半是 Steam 登录态过期了）
        this.subsError = e.message || '订阅角标取不到';
        if (!this._subsWarned) {
          this._subsWarned = true;
          this.showToast('订阅角标取不到（登录态可能已过期）：' + this.subsError, 'warn');
        }
      }
    },

    /**
     * 拉列表。seq 用来丢弃过期响应（快速切筛选时）；同时 abort 掉上一发在途请求。
     *
     * 出错时的行为（测试报告 BUG-08：上游一抖，整个网格和分页条全没了）：
     *   - **保留上一次成功的结果**，只在上面挂一条错误横幅 —— 上下文不丢；
     *   - 自动重试 2 次（1.5s / 4s 退避），因为社区页的握手失败大多是瞬时的；
     *   - 重试期间横幅上显示"正在自动重试"。
     */
    async loadList(opts) {
      const force = opts && opts.force;
      if (this.mode === 'author' && this.authorView) return this.loadAuthor(force);

      this.loading = true;
      this.loadingSince = Date.now();
      if (!this._tickTimer) {
        this._tickTimer = setInterval(() => {
          if (this.loading) this.nowTick = Date.now();
        }, 1000);
      }
      this.error = '';
      const seq = ++this.requestSeq;
      this.abortInflight();
      const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
      this._inflight = ac;
      try {
        // 整组全选的类目（类型/年龄/标签 全勾）在语义上等于不筛，后端也会丢，
        // 这里先剔掉 —— 否则 URL 会挂上 40 多个值，白让上游多跑一趟。
        const filters = Object.assign({}, this.filters, { tagGroups: this.effectiveTagGroups });
        const data = await api.browse(filters, ac ? ac.signal : undefined);
        if (seq !== this.requestSeq) return;
        this.lastResult = data;
        this.items = data.items || [];
        this.loadFileSizes(this.items);
        // 订阅角标（要翻完用户所有订阅，5~10 秒）放到列表出来之后再拉，
        // 免得它跟列表抢上游带宽 —— 这就是"订阅接口 9 秒、列表一直转圈"的成因。
        if (!this._subsLoaded) {
          this._subsLoaded = true;
          this.loadSubscribedIds();
        }
        this.totalCount = data.totalCount || 0;
        this.totalCountApprox = !!data.totalCountApprox;
        this.totalPages = data.totalPages || 0;
        this.page = data.page || this.filters.page;
        this.staleFrom = 0;
        this.retryCount = 0;
        this.clearRetry();
      } catch (e) {
        if (seq !== this.requestSeq) return;
        if (e && e.name === 'AbortError') return;
        this.error = e.message || String(e);
        if (this.items.length) this.staleFrom = this.page;
        this.scheduleRetry();
      } finally {
        if (seq === this.requestSeq) {
          this.loading = false;
          this._inflight = null;
        }
      }
    },

    /** 上游抖动时自动重试（最多 AUTO_RETRY 次，1.5s → 4s 退避） */
    scheduleRetry() {
      if (this.retryCount >= AUTO_RETRY) return;
      this.clearRetry();
      // 退避拉长一点：上游一慢就是真慢（限流/代理抖动），马上重试只会更糟
      const wait = this.retryCount === 0 ? 2500 : 6000;
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        if (!this.error) return;
        this.retryCount++;
        this.loadList();
      }, wait);
    },

    clearRetry() {
      if (this.retryTimer) {
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
      }
    },

    /** 用户手动取消这一轮加载（上游卡住时别让他只能刷新页面） */
    cancelLoad() {
      this.abortInflight();
      this.clearRetry();
      this.retryCount = 0;
      this.loading = false;
      this.loadingSince = 0;
      this.showToast('已取消这次加载', 'warn');
    },

    /** 手动重试：把自动重试计数清掉再来一轮 */
    retryNow() {
      this.clearRetry();
      this.retryCount = 0;
      this.loadList();
    },

    /** 取消上一发在途请求：切筛选时旧结果已经没用了，留着只会占 Steam 的限流额度 */
    abortInflight() {
      if (this._inflight && typeof this._inflight.abort === 'function') {
        try {
          this._inflight.abort();
        } catch (e) {
          /* 忽略 */
        }
      }
      this._inflight = null;
    },

    async loadAuthor(force) {
      if (!this.authorView) return;
      this.loading = true;
      this.error = '';
      // 立刻先把总数清掉：作者个人页返回的是该作者的作品数，
      // 而切换瞬间界面上还是上一次（可能是全站的 321 万）的旧值，
      // 会闪出一个明显错的数字。等新数据回来再填。
      this.totalCount = 0;
      this.totalPages = 0;
      const seq = ++this.requestSeq;
      try {
        const data = await api.author(this.authorView.steamId, this.filters.page, this.filters.pageSize, this.authorView);
        if (seq !== this.requestSeq) return;
        this.items = data.items || [];
        this.loadFileSizes(this.items);
        this.totalCount = data.totalCount || 0;
        this.totalPages = data.totalPages || 0;
        this.page = data.page || 1;
        this.lastResult = null;
        this.staleFrom = 0;
        // 作者名/头像也补上（优先用详情页解析出来的昵称，不需要 API key）
        if (data.creator && (data.creator.name || data.creator.avatar)) {
          this.authorView = Object.assign({}, this.authorView, {
            name: data.creator.name || this.authorView.name,
            avatar: data.creator.avatar || this.authorView.avatar,
          });
        }
      } catch (e) {
        if (seq !== this.requestSeq) return;
        this.error = e.message || String(e);
        if (this.items.length) this.staleFrom = this.page;
        this.scheduleRetry();
      } finally {
        if (seq === this.requestSeq) this.loading = false;
      }
    },

    /* ------------------------------ 筛选操作 ------------------------------ */

    /**
     * 筛选变化后刷新列表。
     *
     * 必须**防抖**：用户连点 6 个分辨率的复选框时，如果每点一下就发一次请求，
     * 后一次会 abort 掉前一次，最后只用"最后一格"的状态去查 —— 结果就是
     * "勾了 6 个，画面却像只勾了 1 个"。防抖后这一串点击只发一次请求，
     * 用的是最终完整状态。
     */
    applyFilters(patch, resetPage) {
      this.filters = Object.assign({}, this.filters, patch);
      if (resetPage !== false) this.filters.page = 1;
      if (this._debouncedReload) {
        this._debouncedReload();
      } else {
        this.loadList();
      }
    },

    onFilterInput(next) {
      // 来自筛选面板的整包更新
      const f = Object.assign({}, next, { page: 1 });
      /*
       * 年龄分级里勾了「限制级/成人级（R-18）」就说明用户要看成人内容，
       * 这时候还挂着"隐藏 18+"（= 给上游加 excludedtags[]=Mature）只会
       * 让结果莫名少一大截 —— 实测客户端里相邻的作品在我们这边整批消失。
       * 所以这里自动把开关关掉（后端也做了兜底）。
       */
      const age = (f.tagGroups && f.tagGroups.age) || [];
      if (age.indexOf('Mature') >= 0 && f.hideMature) {
        f.hideMature = false;
        this.showToast('已勾选「限制级/成人级」→ 自动关闭「隐藏 18+」', 'warn');
      }
      this.filters = f;
      if (this._debouncedReload) {
        this._debouncedReload();
      } else {
        this.loadList();
      }
    },

    resetFilters() {
      this.filters = {
        sort: 'trend',
        days: this.filters.days || 7,
        search: '',
        tagGroups: {},
        exclude: [],
        hideMature: this.filters.hideMature,
        page: 1,
        pageSize: this.filters.pageSize,
      };
      this.searchInput = '';
      this.chipsExpanded = false;
      this.retryNow();
    },

    submitSearch() {
      const q = this.searchInput.trim();
      if (q === this.filters.search) {
        // 内容没变就不重复发请求
        return;
      }
      this.applyFilters({ search: q });
    },

    clearSearch() {
      this.searchInput = '';
      this.applyFilters({ search: '' });
    },

    onSortChange(e) {
      const sort = e.target.value;
      const patch = { sort };
      if (sort === 'trend') patch.days = this.filters.days || 7;
      this.applyFilters(patch);
    },

    /** 移除一个已选标签（跨所有类目找） */
    removeTag(tag) {
      const g = Object.assign({}, this.filters.tagGroups);
      Object.keys(g).forEach((k) => {
        g[k] = (g[k] || []).filter((x) => x !== tag);
        if (!g[k].length) delete g[k];
      });
      this.onFilterInput(Object.assign({}, this.filters, { tagGroups: g }));
    },

    /** 点详情里的标签 → 归到它所属的类目并加上（归不到就放进"标签"组） */
    onTagClick(tag) {
      if (this.mode !== 'browse') {
        this.mode = 'browse';
        this.authorView = null;
      }
      const key = this.groupKeyOfTag(tag);
      const g = Object.assign({}, this.filters.tagGroups);
      const cur = (g[key] || []).slice();
      if (cur.indexOf(tag) < 0) cur.push(tag);
      g[key] = cur;
      this.applyFilters({ tagGroups: g });
    },

    /** 标签属于哪个类目（依据后端给的 groups 元数据） */
    groupKeyOfTag(tag) {
      const groups = (this.meta && this.meta.groups) || [];
      const hit = groups.find((x) => (x.tags || []).indexOf(tag) >= 0);
      return hit ? hit.key : 'content';
    },

    /** 移除一个排除标签 */
    removeExclude(tag) {
      this.onFilterInput(Object.assign({}, this.filters, { exclude: this.filters.exclude.filter((x) => x !== tag) }));
    },

    /** 隐藏 18+（Mature）开关；等价于往排除标签里加减一个 Mature */
    toggleMature() {
      const on = !this.filters.hideMature;
      const patch = { hideMature: on };
      // 打开"隐藏 18+"时把年龄分级里的「成人级」摘掉，避免"要 A 又不要 A"（必然 0 条）
      if (on) {
        const g = Object.assign({}, this.filters.tagGroups);
        if (g.age && g.age.indexOf('Mature') >= 0) {
          const rest = g.age.filter((x) => x !== 'Mature');
          if (rest.length) g.age = rest;
          else delete g.age;
          patch.tagGroups = g;
        }
      }
      this.applyFilters(patch);
    },

    onDaysChange(e) {
      this.applyFilters({ days: Number(e.target.value) });
    },

    onPageSizeChange(e) {
      this.applyFilters({ pageSize: Number(e.target.value) });
    },

    goPage(p) {
      if (p === '…' || p === this.page) return;
      this.filters.page = p;
      this.loadList();
      this.scrollToTop();
    },

    prevPage() {
      if (this.page > 1) this.goPage(this.page - 1);
    },

    nextPage() {
      if (this.page < this.totalPages) this.goPage(this.page + 1);
    },

    scrollToTop() {
      const el = this.$refs.gridScroll;
      if (el) el.scrollTop = 0;
    },

    /** 复制作品链接（Steam 创意工坊的规范地址） */
    copyLink(item) {
      const id = item && item.id;
      if (!id) return;
      const url = 'https://steamcommunity.com/sharedfiles/filedetails/?id=' + id;
      const done = () => this.showToast('已复制链接：' + url, 'ok');
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(url).then(done, () => this.fallbackCopy(url, done));
          return;
        }
      } catch (e) {
        /* 落到下面的兜底 */
      }
      this.fallbackCopy(url, done);
    },

    /* ------------------------------ 右键菜单 ------------------------------ */

    /** 卡片右键 → 打开菜单 */
    openCardMenu(payload) {
      if (!payload || !payload.item) return;
      this.menu = { open: true, x: payload.x || 0, y: payload.y || 0, item: payload.item };
    },

    closeCardMenu() {
      if (this.menu.open) this.menu = Object.assign({}, this.menu, { open: false });
    },

    /** 菜单里点到的每一项（菜单只负责 UI，动作都在这儿） */
    onMenuAction(key) {
      const it = this.menu.item;
      this.closeCardMenu();
      if (!it || !it.id) return;
      switch (key) {
        case 'sub':
          this.doSubscribe(it);
          break;
        case 'fav':
          this.doFavorite(it);
          break;
        case 'apply':
          this.applyWallpaper(it);
          break;
        case 'workshop':
        case 'steam-page':
          openOnSteam(it.id);
          break;
        case 'detail':
          this.selectItem(it);
          break;
        case 'author-all':
          this.gotoAuthor({ steamId: it.creator, name: it.creatorName });
          break;
        case 'author-steam':
          if (it.creator) {
            window.open(
              'https://steamcommunity.com/profiles/' + it.creator + '/myworkshopfiles/?appid=431960',
              '_blank',
              'noopener'
            );
          }
          break;
        case 'same-res':
          this.filterByTag('resolution', it.resolution);
          break;
        case 'report':
          // Steam 的举报入口在作品页面里，这里只能把页面打开并说明一句
          openOnSteam(it.id);
          this.showToast('已打开 Steam 页面：举报 / 屏蔽在页面右侧的「举报」里', 'warn');
          break;
        case 'copy-link':
          this.copyLink(it);
          break;
        case 'copy-id':
          this.copyText(String(it.id), '已复制作品 ID：' + it.id);
          break;
        case 'block-author':
          this.toggleBlockCreator(it);
          break;
        default:
          break;
      }
    },

    /** "只看这个分辨率"：把该值写进分辨率类目（组内 OR 只留它一个） */
    filterByTag(groupKey, tag) {
      if (!tag) return;
      const g = Object.assign({}, this.filters.tagGroups);
      g[groupKey] = [tag];
      if (this.mode !== 'browse') {
        this.mode = 'browse';
        this.authorView = null;
      }
      this.chipsExpanded = true;
      this.applyFilters({ tagGroups: g, page: 1 });
      this.showToast('已按「' + tagLabel(tag) + '」筛选', 'ok');
    },

    /** 屏蔽 / 取消屏蔽某位作者（只存在本地，用来过滤列表） */
    toggleBlockCreator(item) {
      const id = item && item.creator;
      if (!id) return;
      const list = (this.blockedCreators || []).slice();
      const i = list.indexOf(id);
      if (i >= 0) {
        list.splice(i, 1);
        this.showToast('已取消屏蔽该作者', 'ok');
      } else {
        list.push(id);
        this.showToast('已屏蔽该作者，本页作品已隐藏（本地生效）', 'warn');
      }
      this.blockedCreators = list;
      saveBlocked(list);
    },

    clearBlockedCreators() {
      this.blockedCreators = [];
      saveBlocked([]);
      this.showToast('已清空屏蔽名单', 'ok');
    },

    /** 复制任意文本（用同一套剪贴板兜底） */
    copyText(text, msg) {
      const done = () => this.showToast(msg || ('已复制：' + text), 'ok');
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done, () => this.fallbackCopy(text, done));
          return;
        }
      } catch (e) {
        /* 落到兜底 */
      }
      this.fallbackCopy(text, done);
    },

    /** 剪贴板 API 在非 https / 无权限时会失败，用 textarea + execCommand 兜底 */
    fallbackCopy(text, done) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        done();
      } catch (e) {
        this.showToast('复制失败，请手动复制：' + text, 'warn');
      }
    },

    /** 关闭某条可关闭的提示（多词搜索、页数上限） */
    dismissNote(key) {
      this.dismissedNotes = Object.assign({}, this.dismissedNotes, { [key]: true });
    },

    /** 点作者 → 切到作者视图（"相关壁纸"跳转） */
    gotoAuthor(payload) {
      // payload 可能来自详情面板（author 对象），也可能只带了 steamId；
      // 顺手从当前详情里补上昵称/头像，这样作者页不用再多打一次 Steam 取名字。
      const item = (this.detail && this.detail.item) || this.selected || {};
      // 进作者页之前把浏览态记下来：返回时要"原来什么样就什么样"
      // （排序 / 页码 / 筛选 / 滚动位置），而不是被重置成默认的"最热门"。
      if (this.mode === 'browse') {
        this.snapshotBrowseState();
      }
      this.mode = 'author';
      this.authorView = {
        steamId: payload.steamId || item.creator || '',
        name: payload.name || item.creatorName || '',
        avatar: payload.avatar || item.creatorAvatar || '',
      };
      this.filters.page = 1;
      this.selected = null;
      this.detail = null;
      this.loadAuthor();
    },

    backToBrowse() {
      this.mode = 'browse';
      this.authorView = null;
      /*
       * 从作者页返回：**恢复进作者页之前的浏览态**（用户报："返回创意工坊结果排序变成最热门"）。
       *
       * 之前这里无条件把排序复位成 trend —— 那是为了让顶栏的「创意工坊」标签能"回到默认浏览态"
       * （测试报告 BUG-04 的场景：没有任何反应）。但作者页的「← 返回创意工坊」用同一个方法，
       * 于是把用户原本的排序/页码吃掉了。
       * 现在：有快照就还原快照；没有快照（点的是顶栏标签）才复位成默认。
       */
      const snap = this._browseSnapshot;
      this._browseSnapshot = null;
      if (snap && snap.filters) {
        this.filters = JSON.parse(JSON.stringify(snap.filters));
        this.searchInput = this.filters.search || '';
        this.loadList();
        this.$nextTick(() => this.setScrollTop(snap.scrollTop || 0));
        return;
      }
      this.filters.page = 1;
      if (this.filters.sort !== 'trend') {
        this.applyFilters({ sort: 'trend', days: this.filters.days || 7 });
        return;
      }
      this.loadList();
    },

    /** 列表滚动容器（作者页返回时用来还原位置） */
    getScrollTop() {
      const el = this.$refs.content || document.querySelector('.content');
      return el ? el.scrollTop : 0;
    },
    setScrollTop(top) {
      const el = this.$refs.content || document.querySelector('.content');
      if (el) el.scrollTop = top;
    },

    /* ---------------------------- 详情与订阅 ---------------------------- */

    async selectItem(item) {
      if (!item || !item.id) return;
      if (this.selected && this.selected.id === item.id) return;
      this.selected = item;
      this.detail = null;
      this.detailError = '';
      this.detailNotFound = false;
      this.related = null;
      this.relatedError = '';
      this.relatedLoading = false;
      this.detailLoading = true;
      // 详情请求也要能取消：快速连点不同卡片时，旧的详情请求会占限流额度
      this.abortInflight();
      const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
      this._inflight = ac;
      const id = item.id;
      const hints = {
        name: item.creatorName || '',
        avatar: item.creatorAvatar || '',
        creator: item.creator || '',
      };
      try {
        // 把卡片上已知的作者昵称/头像带过去：浏览页的 PlayerLinkDetails 本来就给了，
        // 省一次 Steam 请求，也兜住"详情页被精简"的情况。
        const data = await api.item(id, ac ? ac.signal : undefined, hints);
        if (!this.selected || this.selected.id !== id) return;
        this.detail = data;
        // 详情里的文件大小顺手填进卡片映射，省一次 /api/details
        if (data && data.item && Number(data.item.fileSize) > 0) {
          const next = Object.assign({}, this.fileSizes);
          next[id] = Number(data.item.fileSize);
          this.fileSizes = next;
        }
        // 详情一拿到就立刻去拉相关壁纸（不阻塞详情的显示）
        this.loadRelated(id, data.creatorId || (data.author && data.author.steamId) || item.creator, {
          name: (data.author && data.author.name) || hints.name,
          avatar: (data.author && data.author.avatar) || hints.avatar,
        });
      } catch (e) {
        if (e && e.name === 'AbortError') return;
        if (!this.selected || this.selected.id !== id) return;
        this.detailError = e.message || String(e);
        this.detailNotFound = !!(e && e.notFound);
        // 详情都失败了，但"相关壁纸"仍然可以独立去拉（只要知道作者）
        if (!this.detailNotFound && item.creator) {
          this.loadRelated(id, item.creator, hints);
        }
      } finally {
        if (this.selected && this.selected.id === id) this.detailLoading = false;
      }
    },

    /**
     * 拉「相关壁纸」= 该作者的创意工坊页（走 /api/author）。
     *
     * 单独一个请求是有意的：它比详情慢得多，塞进 /api/item 会让详情面板
     * 迟迟不显示（实测最坏 170 秒）。这里并发拉，拿到了再填。
     */
    async loadRelated(id, creatorId, hints) {
      if (!creatorId) return;
      if (!this.selected || this.selected.id !== id) return;
      this.relatedLoading = true;
      this.relatedError = '';
      try {
        const data = await api.author(creatorId, 1, 30, hints);
        if (!this.selected || this.selected.id !== id) return;
        this.related = {
          creator: data.creator || { steamId: creatorId },
          totalCount: data.totalCount || 0,
          totalPages: data.totalPages || 0,
          items: (data.items || []).filter((i) => i.id !== id),
        };
      } catch (e) {
        if (!this.selected || this.selected.id !== id) return;
        this.relatedError = e.message || String(e);
      } finally {
        if (this.selected && this.selected.id === id) this.relatedLoading = false;
      }
    },

    reloadDetail() {
      const it = this.selected;
      this.selected = null;
      this.selectItem(it);
    },

    markBusy(id, on) {
      const next = Object.assign({}, this.busyIds);
      if (on) next[id] = true;
      else delete next[id];
      this.busyIds = next;
    },

    async doSubscribe(item) {
      const id = item && item.id;
      if (!id) return;
      if (!this.loggedIn) {
        this.settingsOpen = true;
        this.showToast('订阅需要登录，请先在设置里登录 Steam', 'warn');
        return;
      }
      // 用"Steam 订阅 ∪ 本地库"判断当前状态，否则 Cookie 失效时会把已订阅的当成未订阅
      const willSub = !this.isSubscribedId(id);
      this.markBusy(id, true);
      try {
        const r = await api.subscribe(id, willSub ? 'sub' : 'unsub');
        if (r.ok) {
          const next = Object.assign({}, this.subscribedIds);
          if (willSub) next[id] = true;
          else delete next[id];
          this.subscribedIds = next;
          this.showToast(willSub ? '已订阅（Steam 会开始下载）' : '已取消订阅', 'ok');
          this.patchItemStat(id, 'subscriptions', willSub ? 1 : -1);
          // 订阅后 Steam 的"累计订阅"也会 +1
          if (willSub) this.patchItemStat(id, 'lifetimeSubscriptions', 1);
          notifyHost({ event: 'subscribe', id, subscribed: willSub });
          // 已订阅视图开着的话，顺手刷新
          if (this.mode === 'subscribed' && !willSub) this.loadSubscribed(true);
        } else {
          this.showToast(r.reason || '操作失败', 'error');
          if (r.needLogin) this.settingsOpen = true;
        }
      } catch (e) {
        this.showToast('订阅失败：' + e.message, 'error');
        if (e.needLogin) {
          this.loadSession();
          this.settingsOpen = true;
        }
      } finally {
        this.markBusy(id, false);
      }
    },

    async doFavorite(item) {
      const id = item && item.id;
      if (!id) return;
      if (!this.loggedIn) {
        this.settingsOpen = true;
        this.showToast('收藏需要登录，请先在设置里登录 Steam', 'warn');
        return;
      }
      const willFav = !this.favoriteIds[id];
      this.markBusy(id, true);
      try {
        const r = await api.favorite(id, willFav ? 'fav' : 'unfav');
        if (r.ok) {
          const next = Object.assign({}, this.favoriteIds);
          if (willFav) next[id] = true;
          else delete next[id];
          this.favoriteIds = next;
          // 收藏后详情页的按钮态也要跟着变
          if (this.detail && this.detail.id === id) this.detail.favorited = willFav;
          this.showToast(willFav ? '已收藏' : '已取消收藏', 'ok');
          this.patchItemStat(id, 'favorited', willFav ? 1 : -1);
          notifyHost({ event: 'favorite', id, favorited: willFav });
        } else {
          this.showToast(r.reason || '操作失败', 'error');
          if (r.needLogin) this.settingsOpen = true;
        }
      } catch (e) {
        this.showToast('收藏失败：' + e.message, 'error');
        if (e.needLogin) {
          this.loadSession();
          this.settingsOpen = true;
        }
      } finally {
        this.markBusy(id, false);
      }
    },

    async doVote(payload) {
      const id = payload.item && payload.item.id;
      if (!id) return;
      if (!this.loggedIn) {
        this.settingsOpen = true;
        this.showToast('评分需要登录', 'warn');
        return;
      }
      this.markBusy(id, true);
      try {
        const r = await api.vote(id, payload.action);
        this.showToast(r.ok ? '已提交评价' : r.reason || '评分失败', r.ok ? 'ok' : 'error');
      } catch (e) {
        this.showToast('评分失败：' + e.message, 'error');
        if (e.needLogin) {
          this.loadSession();
          this.settingsOpen = true;
        }
      } finally {
        this.markBusy(id, false);
      }
    },

    /**
     * 本地微调统计数字，避免整页刷新。
     *
     * 注意要同时改三处：网格里的卡片、selected（详情面板的标题区）、
     * 以及 `detail.item`（详情面板底部的"订阅 / 收藏 / 累计订阅"三个数字块）。
     * 只改前两处的话，订阅成功了详情面板底部还是旧数字（测试报告 OBS-7）。
     */
    patchItemStat(id, key, delta) {
      const bump = (o) => {
        const next = Object.assign({}, o);
        next[key] = Math.max(0, (Number(o[key]) || 0) + delta);
        return next;
      };
      this.items = this.items.map((i) => (i.id === id ? bump(i) : i));
      if (this.selected && this.selected.id === id) this.selected = bump(this.selected);
      if (this.detail && this.detail.item && this.detail.item.id === id) {
        this.detail = Object.assign({}, this.detail, { item: bump(this.detail.item) });
      }
    },

    /* ------------------------------ 会话 ------------------------------ */

    async tryParentCookie() {
      if (!this.host.embedded) return;
      const r = await requestParentCookie(2000);
      if (r.ok && r.cookie) await this.applyHostSession(r);
    },

    /**
     * 应用宿主（父页面 / qiankun / 手动）给的登录态。
     * 走同一个入口，保证"父页面推送"和"主动索取"两条路行为一致。
     */
    async applyHostSession(session) {
      if (!session || !session.cookie) return;
      try {
        await api.setSession({
          cookie: session.cookie,
          refreshToken: session.refreshToken || '',
          source: session.source || 'parent-message',
        });
        await this.loadSession();
        this.showToast('已从宿主页面取得登录态', 'ok');
      } catch (e) {
        /* 静默失败：独立运行也能用 */
      }
    },

    onHostMessage(ev) {
      const d = ev && ev.data;
      if (!d || typeof d !== 'object') return;
      if (d.type === 'wallpaper-workshop:session' || d.type === 'steam-cookie' || d.type === 'session') {
        const cookie = d.cookie || d.steamCookies || '';
        if (cookie) {
          api
            .setSession({ cookie, refreshToken: d.refreshToken || '', source: 'parent-message' })
            .then(() => this.loadSession())
            .then(() => this.showToast('宿主页面推送了新的登录态', 'ok'))
            .catch(() => undefined);
        }
      }
      // 宿主可以要求切换筛选/搜索
      if (d.type === 'wallpaper-workshop:command' && d.command) {
        if (d.command === 'reset') this.resetFilters();
        if (d.command === 'search' && typeof d.value === 'string') {
          this.searchInput = d.value;
          this.submitSearch();
        }
      }
    },

    async onSessionChanged() {
      await this.loadSession();
      await this.loadStatus();
      this.loadList({ force: true });
    },

    /** 记一份浏览态（筛选 / 排序 / 页码 / 滚动位置），返回时还原 */
    snapshotBrowseState() {
      this._browseSnapshot = {
        filters: JSON.parse(JSON.stringify(this.filters)),
        scrollTop: this.getScrollTop(),
      };
    },

    /* ------------------------------ 已订阅（本地库口径） ------------------------------ */

    /** 切到「已订阅」标签：列表来自本地创意工坊库（订阅时间 = 项目文件夹创建时间） */
    openSubscribed() {
      if (this.mode === 'browse') this.snapshotBrowseState();
      this.mode = 'subscribed';
      this.selected = null;
      this.detail = null;
      this.related = null;
      this.loadSubscribed();
    },

    async loadSubscribed(fresh) {
      this.subs.loading = true;
      this.subs.error = '';
      try {
        const r = await api.subscribed({
          page: this.subs.page,
          pageSize: this.subs.pageSize,
          search: this.subs.search,
          sort: this.subs.sort,
          fresh: !!fresh,
        });
        this.subs.items = r.items || [];
        this.subs.totalCount = r.totalCount || 0;
        this.subs.totalPages = r.totalPages || 1;
        this.subs.page = r.page || 1;
        this.subs.wsDir = r.wsDir || '';
        this.subs.source = r.source || '';
        this.subs.staleLocalCount = r.staleLocalCount || 0;
        // 列表以 Steam 为准时，顺手把"已订阅"角标也同步过来（取消订阅能立刻反映）
        if (r.source === 'steam') this.loadSubscribedIds();
      } catch (e) {
        this.subs.error = e.message || String(e);
      } finally {
        this.subs.loading = false;
      }
    },

    onSubsSearchInput() {
      if (!this._debouncedSubs) {
        this._debouncedSubs = debounce(() => {
          const q = this.subsSearchInput.trim();
          if (q === this.subs.search) return;
          this.subs.search = q;
          this.subs.page = 1;
          this.loadSubscribed();
        }, 350);
      }
      this._debouncedSubs();
    },

    clearSubsSearch() {
      this.subsSearchInput = '';
      this.subs.search = '';
      this.subs.page = 1;
      this.loadSubscribed();
    },

    onSubsSortChange(e) {
      this.subs.sort = e.target.value;
      this.subs.page = 1;
      this.loadSubscribed();
    },

    subsGoPage(p) {
      if (p === '…' || p === this.subs.page) return;
      this.subs.page = p;
      this.loadSubscribed();
      this.scrollToTop();
    },

    /** 订阅时间显示成短日期（列表里够用） */
    shortDate(ms) {
      const n = Number(ms);
      if (!n) return '';
      const d = new Date(n);
      const now = new Date();
      const md = d.getMonth() + 1 + '月' + d.getDate() + '日';
      return d.getFullYear() === now.getFullYear() ? md : d.getFullYear() + '年' + md;
    },

    /* ------------------------------ 提示 ------------------------------ */

    showToast(text, type) {
      this.toast = { text, type: type || 'info' };
      clearTimeout(this.toastTimer);
      this.toastTimer = setTimeout(() => {
        this.toast = null;
      }, 4200);
    },
  },
});
