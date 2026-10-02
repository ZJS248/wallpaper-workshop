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
/** 筛选栏折叠状态（刷新/重开页面后要保持用户上次的习惯） */
const FILTERS_KEY = 'ww.filters.collapsed';
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

/** 筛选栏是否折叠 —— 存起来，刷新/重开页面后保持用户上次的习惯 */
function loadFiltersCollapsed() {
  try {
    return window.localStorage.getItem(FILTERS_KEY) === '1';
  } catch (e) {
    return false;
  }
}

new Vue({
  el: '#app',

  data() {
    return {
      // 视图
      mode: 'browse',
      authorView: null,
      /** 左侧筛选栏是否折叠（折叠后宽度收到 0，网格接管整行） */
      filtersCollapsed: loadFiltersCollapsed(),

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
      /** 设置抽屉当前要展开的分区（顶栏的登录药丸点「设置」时直接落到账号） */
      settingsSection: '',
      /** 工具条「N 条说明」浮层是否展开 */
      notesOpen: false,

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
        /** 后端的补充说明（如"没找到本地创意工坊目录"）——不是错误，列表照常可用 */
        note: '',
      },
      subsSearchInput: '',
      /** 本地屏蔽的作者 steamId 列表 */
      blockedCreators: loadBlocked(),
      /**
       * 「最热门」跨页去重。
       *
       * 问题：trend 是 Steam 的**实时榜单**，两次请求之间名次会挪。
       * 后端每翻一页都是按当下榜单重新取上游页，所以同一张壁纸可能同时落在
       * 第 2 页和第 7 页（用户实测：沃雅妮莎这一张两张页都有）。
       *
       * 做法：向前翻页时记住已经出现过的 id，后面的页里再出现就跳过。
       * 注意三点：
       *  - 只在**向前**翻时生效。往回翻要清空记录，否则回到第 2 页会整页空白。
       *  - 换筛选/排序/搜索时清空（那是另一个结果集）。
       *  - 宁可这一页少几条，也不要同一张壁纸出现两次 —— 用户明确反馈过这个。
       * 跳过的条数会显示在分页条旁边，不藏着。
       */
      seenIds: Object.create(null),
      /** 本页被去重掉的条数（本页 items 的前 droppedDupes 条是重复的） */
      droppedDupes: 0,
      /** 磁盘占用：{ [id]: bytes } —— 由 /api/details 批量补，卡片左下角显示 */
      fileSizes: {},
      busyIds: {},
      /** 确认弹窗（目前只有一种：订阅前问要不要连依赖一起订） */
      confirm: null,
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
    /**
     * 排序下拉的完整选项。
     *
     * 原来是最热门要再选一个"时间窗"下拉（今日/本周/本月/本年），两个控件
     * 才能表达一个排序，还得先切到最热门第二个才可用 —— Wallpaper Engine 是
     * 直接把「最热门（今年/本月/本周/今日）」平铺在同一个列表里的，
     * 这里对齐：value 形如 `trend:7`，普通排序就是 `recent` 这样的纯 key。
     */
    sortOptionsFlat() {
      const out = [];
      (this.sortOptions || []).forEach((o) => {
        if (o.key === 'trend') {
          (this.daysOptions || []).forEach((d) => {
            out.push({ value: 'trend:' + d.value, label: '最热门 · ' + d.label, hint: o.hint || '' });
          });
        } else {
          out.push({ value: o.key, label: o.label, hint: o.hint || '' });
        }
      });
      return out;
    },
    /** 当前排序对应的下拉 value（最热门要带上时间窗） */
    sortValue() {
      return this.filters.sort === 'trend' ? 'trend:' + this.filters.days : this.filters.sort;
    },
    sortHint() {
      const s = this.currentSort;
      if (!s) return '';
      if (s.key === 'mostsubscribed') {
        return '按累计订阅数排序（卡片上显示的是当前订阅数，两者可能不同）';
      }
      return s.hint || '';
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
        return '登录已失效：' + (this.session.invalidReason || 'Cookie 失效') +
          '\n订阅 / 收藏 / 评价会失败，点这里去重新登录。';
      }
      if (this.loginState === 'ok') return '已登录：' + ((this.session && this.session.steamId) || '');
      return '未登录（浏览 / 搜索 / 筛选 / 详情都不受影响）';
    },
    /**
     * 分页按钮：首页 + 当前页窗口（左右各一页）+ 末页，省略号连接。
     *
     * 旧写法是「先铺 1~6，cur>7 才把 cur 塞进去」，于是 cur=7 时当前页既没显示
     * 也没高亮（用户报的就是这个），而且 7 根本点不到。这里改成始终围绕当前页开窗口。
     */
    pageButtons() {
      const total = Math.min(this.totalPages || 1, 1000);
      const cur = Math.min(Math.max(1, this.page || 1), total);
      const out = [];
      const push = (v) => {
        if (v >= 1 && v <= total && out.indexOf(v) < 0) out.push(v);
      };
      const gap = () => {
        if (out.length && out[out.length - 1] !== '…') out.push('…');
      };

      // 页数不多时直接全列
      if (total <= 9) {
        for (let i = 1; i <= total; i++) push(i);
        return out;
      }

      // 当前页左右各一页；贴到边界时往里补，保证窗口一直是 3 个
      const win = [cur - 1, cur, cur + 1].filter((v) => v >= 1 && v <= total);
      if (win[0] <= 2) while (win.length < 3) win.push(win[win.length - 1] + 1);
      if (win[win.length - 1] >= total - 1) while (win.length < 3) win.unshift(win[0] - 1);
      const lo = win[0];
      const hi = win[win.length - 1];

      push(1);
      if (lo > 2) gap();
      for (let i = lo; i <= hi; i++) push(i);
      if (hi < total - 1) gap();
      push(total);
      return out;
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
     * 总数的说明文案（有的话在计数旁显示一个 ⓘ，全文进 tooltip）。
     * 「最热门」下 Steam 回给我们的 total_count 是**全站投稿量**，不随时间窗变化，
     * 所以只能说"约"；多路合并时各路相加只是上界，同样只能"约"。
     */
    countNote() {
      const r = this.lastResult;
      if (!r) return '';
      return r.totalCountNote || (r.totalCountApprox ? '这个总数只是参考值，Steam 在热门榜下不返回精确数量。' : '');
    },
    /** 深翻页上限说明：Steam 浏览页的硬顶（每页 30 条时 1000 页 ≈ 3 万条） */
    pageCapNote() {
      const r = this.lastResult;
      if (!r || !r.cappedAt) return '';
      if (!this.totalPages || this.totalPages < 1000) return '';
      return (
        'Steam 的浏览页最多翻到第 1000 页（约 ' + this.fmtCount(r.cappedAt) + ' 条），' +
        '再往后上游就没有数据了。想看得更远，请用时间窗、标签或搜索缩小范围。'
      );
    },
    searchNote() {
      return (this.lastResult && this.lastResult.searchNote) || '';
    },
    /**
     * 翻过可浏览深度时的说明（后端算好给的，见 steamApi 的 deepPageNote）。
     *
     * 无多选类目 / 多选+位置键这两条路径要先凑一份"冻结前缀"再切页，
     * 前缀有上限，超过之后切出来就是空的 —— 以前只显示"没有符合条件的作品"，
     * 会让人以为是筛选的问题。这里把真实原因显示出来。
     */
    pageNote() {
      return (this.lastResult && this.lastResult.pageNote) || '';
    },

    /**
     * 加载超过 6 秒时给的提示：上游（Steam / 本地代理）偶尔会限流，
     * 卡在骨架屏上什么也不说会让人以为坏了。
     */
    slowHint() {
      if (!this.loading || !this.loadingSince) return '';
      const ms = (this.nowTick || Date.now()) - this.loadingSince;
      if (ms < 6000) return '';
      return 'Steam 响应较慢，已等待 ' + Math.round(ms / 1000) + ' 秒';
    },

    /**
     * 合并查询的说明文案。
     * 「同类目多选 = 或」在 Steam 侧没法用参数表达，是靠拆成多路请求合并出来的，
     * 所以这里告诉用户"合并了几路"，详细的归并口径放进 tooltip。
     */
    mergeInfo() {
      const r = this.lastResult;
      if (!r || !r.merged) return null;
      const mode = r.mergeMode || 'roundrobin';
      const sortName = r.sortLabel || '当前排序';
      // 「同类目多选 = 或」在 Steam 侧没有参数能表达，只能按值拆路再合并；
      // 合并方式决定顺序是否与原站一致，完整解释进 title（用户就是被这个坑过）。
      const head = '已合并 ' + r.mergeRequests + ' 路';
      const notes = {
        sorted: {
          text: head,
          title:
            '同类目里选多个 = 满足其中一个，Steam 没有对应参数，所以按值拆成 ' +
            r.mergeRequests + ' 次查询，再按「' + sortName + '」重新归并 —— ' +
            '第 1 页就是全局最新的 ' + (r.pageSize || 30) + ' 条，和 Wallpaper Engine 客户端一致。',
        },
        approx: {
          text: head + '（顺序近似）',
          title:
            '要保证顺序完全一致，每一路都要取到第 ' + r.page + ' 页，请求量会随页数放大；' +
            '所以从第 ' + (r.mergePerRoutePages || 4) + ' 页之后改成轮询合并：结果都在，顺序近似。',
        },
        sorted_approx: {
          text: head + '（顺序近似）',
          title:
            '「评分最高」的排序在 Steam 内部有它自己的加权（星级 + 评价数的置信区间），' +
            '结果里拿不到这个分值，只能按"星级 → 评价数"近似归并 —— ' +
            '实测前 30 条里约 27 条位置与客户端一致。',
        },
        roundrobin: {
          text: head + '（按路轮询）',
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

    /* ------------------------------------------------------------------
     * 统一提示条
     *
     * 以前是"错误横幅 / 搜索说明 / 页数上限 / 慢速提示 / 订阅角标"各自占一条，
     * 顶部经常叠三四段文字。现在收成一份按优先级排序的列表：
     * **同一时刻只显示第一条**，其余进工具条的「N 条说明」浮层。
     * 每条都只有一句话，长解释进 title。
     * ------------------------------------------------------------------ */
    noticeList() {
      const out = [];
      if (this.error) {
        out.push({
          key: 'error', kind: 'error', icon: 'alert',
          text: '加载失败：' + this.shorten(this.error, 60),
          title: this.items.length
            ? '下面是第 ' + this.staleFrom + ' 页的旧结果，' + this.error
            : this.error,
          action: 'retry', actionLabel: '重试',
        });
      }
      if (this.slowHint) {
        out.push({
          key: 'slow', kind: 'info', icon: 'refresh',
          text: this.slowHint,
          title: 'Steam 偶尔会限流。可以继续等，也可以取消这次加载。',
          action: 'cancel', actionLabel: '取消',
        });
      }
      if (this.searchNote && !this.dismissedNotes.search) {
        out.push({
          key: 'search', kind: 'info', icon: 'search',
          text: this.shorten(this.searchNote, 70),
          title: this.searchNote,
          dismissible: true,
        });
      }
      if (this.pageCapNote && !this.dismissedNotes.cap) {
        out.push({
          key: 'cap', kind: 'info', icon: 'info',
          text: '最多翻到第 1000 页（约 3 万条）',
          title: this.pageCapNote,
          dismissible: true,
        });
      }
      if (this.mergeInfo) {
        out.push({
          key: 'merge', kind: 'info', icon: 'layers',
          text: this.mergeInfo.text,
          title: this.mergeInfo.title,
        });
      }
      if (this.subsError) {
        out.push({
          key: 'subs', kind: 'warn', icon: 'alert',
          text: '订阅状态取不到，先按本地记录显示',
          title: this.subsError,
          action: 'settings', actionLabel: '去登录',
        });
      }
      return out;
    },
    /** 当前显示的那一条 */
    activeNote() {
      return this.noticeList[0] || null;
    },
    /** 被压下去、进「N 条说明」浮层的那些 */
    extraNotes() {
      return this.noticeList.slice(1);
    },
    /**
     * 去重说明（分页条旁边显示）。
     * items 在 applyPageDedup 里就已经是去重后的了，这里只负责把条数说出来，
     * 不藏着掖着。
     */
    dupNote() {
      if (!this.droppedDupes) return '';
      return '已隐藏 ' + this.droppedDupes + ' 个前面出现过的';
    },
    /**
     * 整屏加载遮罩。
     *
     * 只在"**页面上还没有任何内容可显示**"时盖：首屏、或者空结果切到别处重新加载。
     * 翻页 / 改筛选时已经有旧内容了，就别盖 —— 上游一抖不至于把用户正在看的东西抹掉。
     */
    bootLoading() {
      if (!this.loading) return false;
      if (this.mode === 'subscribed') return !this.subs.items.length;
      return !this.items.length && !this.visibleItems.length;
    },
    /** 遮罩上的第二行字：超过几秒就说"慢"，免得看着像卡死 */
    bootHint() {
      if (!this.loadingSince) return '正在连接 Steam…';
      const s = Math.max(0, Math.round(((this.nowTick || Date.now()) - this.loadingSince) / 1000));
      if (s < 4) return '正在连接 Steam…';
      return 'Steam 响应有点慢（已等待 ' + s + ' 秒）';
    },
  },

  /**
   * 非响应式内部状态：AbortController 与防抖函数都不该进 Vue 的响应式系统
   * （Vue 2 会深度遍历 data，把 AbortController 包成 observed 对象，属于白白开销）。
   */
  /*
   * 在途请求按用途**分开三个槽位**。
   *
   * ⚠️ 原来只有一个 `_inflight`，列表和详情都往里放，于是互相误伤：
   *   - 翻页会顺带掐掉在途的**详情**请求 → 详情面板静默退回"选择一张壁纸查看详情"；
   *   - 在详情面板里点"相关壁纸"会掐掉在途的**列表**请求
   *     （网格加载时虽然 .grid.dim 有 pointer-events:none 挡住了卡片，
   *      但详情面板里的相关缩略图仍可点，这条路径是通的）。
   * 分开之后各取消各的，互不影响。
   */
  _inflight: null,        // 浏览 / 作者列表
  _inflightDetail: null,  // 作品详情
  _inflightSubs: null,    // 已订阅清单
  /** 已订阅清单自己的序号（不复用 requestSeq，免得干扰列表的 loading 生命周期） */
  _subsSeq: 0,
  _debouncedSearch: null,
  _debouncedReload: null,
  /** 已经问过"大小"的 id → 时间戳（非响应式；失败过的不在 5 分钟内反复问） */
  _sizeTried: null,
  /** 依赖项（必需物品）查询结果：id → { at, items } */
  _requiredCache: null,
      /** 订阅 id 集合是否已经**成功**拉过一次（它慢，放在列表之后拉） */
      _subsLoaded: false,
      /** 订阅 id 集合是否正在拉（防重入：这个接口要翻完所有订阅，5~10 秒） */
      _subsLoading: false,
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
    /** 筛选栏折叠状态也要记住（刷新后保持用户上次的习惯） */
    filtersCollapsed(v) {
      try {
        window.localStorage.setItem(FILTERS_KEY, v ? '1' : '0');
      } catch (e) {
        /* 隐私模式写不进去就算了 */
      }
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
    document.addEventListener('keydown', this.onKey);
  },

  beforeDestroy() {
    window.removeEventListener('message', this.onHostMessage);
    document.removeEventListener('keydown', this.onKey);
    if (this._weTimer) clearInterval(this._weTimer);
    if (this._tickTimer) clearInterval(this._tickTimer);
  },

  methods: {
    /**
     * Esc 依次关闭最上层的浮层：详情 → 右键菜单 → 设置抽屉。
     * 右键菜单自己已经监听 document 上的 Esc（它挂在 body 之外），
     * 这里只处理剩下的两层，避免同一个 Esc 被处理两次。
     */
    onKey(e) {
      if (e.key !== 'Escape') return;
      if (this.confirm) { this.onConfirmCancel(); return; }
      if (this.notesOpen) { this.notesOpen = false; return; }
      if (this.selected) { this.closeDetail(); }
    },
    /** 打开设置抽屉；section 为空时由抽屉自己挑（未登录 → 账号） */
    openSettings(section) {
      this.settingsSection = section || '';
      this.settingsOpen = true;
    },
    /** 统一提示条上的操作按钮 */
    onNoticeAction(note) {
      if (!note || !note.action) return;
      if (note.action === 'retry') this.retryNow();
      else if (note.action === 'cancel') this.cancelLoad();
      else if (note.action === 'settings') this.openSettings('account');
    },
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
          this.showToast('登录已失效：' + (this.session.invalidReason || 'Cookie 过期') + '，订阅和收藏会失败', 'error');
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
        this.showToast('还没找到 Wallpaper Engine 安装目录', 'error');
        return;
      }
      if (!this.isInstalledId(id)) {
        this.showToast('这个壁纸还没下载到本地，先订阅并等 Steam 下完', 'warn');
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
          const go = window.confirm(e.message + '\n\n要直接试一次吗？可能会顺带启动 Wallpaper Engine。');
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
      // 防重入：要翻完用户所有订阅（5~10 秒），并发重复调没有意义
      if (this._subsLoading) return;
      this._subsLoading = true;
      try {
        const r = await api.subscribedIds();
        const map = {};
        (r.ids || []).forEach((id) => {
          map[id] = true;
        });
        this.subscribedIds = map;
        this.subsError = '';
        this.subsListOk = true;
        /*
         * ⚠️ 只有**成功**才算"拉过了"。
         *
         * 踩过的坑：原来这个标记是在**发起请求之前**就置 true 的，而且全代码没有
         * 任何地方把它重置。于是"未登录时打开页面 → 标记已加载 → 请求抛错 →
         * 用户登录 → 守卫看到标记还是 true，永远不会再拉一次"，
         * 表现就是**已登录但订阅角标一直不出来**（用户报的）。
         * 现在失败时保持 false，下次加载列表会再试；登录态变化时也会显式重置。
         */
        this._subsLoaded = true;
        // 订阅数超过后端一次能翻完的量时，角标不可能全覆盖，如实说明
        if (r.capped) {
          this.showToast(
            '订阅较多（' + this.fmtCount(r.total) + ' 个），已订阅角标只覆盖了前 ' +
              this.fmtCount(Object.keys(map).length) + ' 个',
            'warn'
          );
        }
      } catch (e) {
        // 取不到角标不致命，但要让用户知道原因（多半是 Steam 登录态过期了）
        this.subsError = e.message || '订阅角标取不到';
        // 拿不到 Steam 的订阅集合就**别把它当成"已确认没有订阅"** ——
        // 置 false 让 isSubscribedId 回退到本地库判断，否则所有角标都会消失。
        this.subsListOk = false;
        this._subsLoaded = false;
        if (!this._subsWarned) {
          this._subsWarned = true;
          this.showToast('订阅状态取不到（登录态可能已过期）', 'warn');
        }
      } finally {
        this._subsLoading = false;
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
    /**
     * 落地一页列表，顺带做"跨页去重"。
     *
     * 往回翻 / 跳到更小的页 / 换筛选时清空 seenIds（否则回到旧页会整页空白）；
     * 向前翻时把本页里"前面已经出现过"的条目从前面截掉。
     */
    applyPageDedup(page, items) {
      const prev = this.page || 1;
      const cur = Number(page) || prev;
      // 往回翻或者换了结果集 → 重新开始记
      if (cur <= prev || cur === 1) this.seenIds = Object.create(null);
      let drop = 0;
      const rest = [];
      for (const it of items) {
        if (this.seenIds[it.id]) { drop++; continue; }
        this.seenIds[it.id] = true;
        rest.push(it);
      }
      this.items = rest;
      this.droppedDupes = drop;
    },
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
      const ac = this._newInflight('_inflight');
      try {
        // 整组全选的类目（类型/年龄/标签 全勾）在语义上等于不筛，后端也会丢，
        // 这里先剔掉 —— 否则 URL 会挂上 40 多个值，白让上游多跑一趟。
        const filters = Object.assign({}, this.filters, { tagGroups: this.effectiveTagGroups });
        const data = await api.browse(filters, ac ? ac.signal : undefined);
        if (seq !== this.requestSeq) return;
        this.lastResult = data;
        this.applyPageDedup(data.page || this.filters.page, data.items || []);
        this.loadFileSizes(this.items);
        // 订阅角标（要翻完用户所有订阅，5~10 秒）放到列表出来之后再拉，
        // 免得它跟列表抢上游带宽 —— 这就是"订阅接口 9 秒、列表一直转圈"的成因。
        if (!this._subsLoaded) {
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

    /**
     * 取消某一类在途请求。
     *
     * @param {string} [slot] 槽位名：'_inflight'（列表，默认）/ '_inflightDetail' /
     *                        '_inflightSubs'。省略即取消"列表"那一发，兼容旧调用点。
     */
    abortInflight(slot) {
      const key = slot || '_inflight';
      const ac = this[key];
      if (ac && typeof ac.abort === 'function') {
        try {
          ac.abort();
        } catch (e) {
          /* 忽略 */
        }
      }
      this[key] = null;
    },

    /** 造一个 AbortController 并占住指定槽位（浏览器不支持时返回 null，逻辑照常跑） */
    _newInflight(slot) {
      this.abortInflight(slot);
      const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
      this[slot] = ac;
      return ac;
    },

    /**
     * 关闭详情面板。
     *
     * ⚠️ 以前各处关闭都只写 `selected = null`，**不取消在途请求**。
     * 详情那一发（/api/item）在低配机器 + 代理下要好几秒，用户等不及点关闭时：
     *  - 它会继续跑完，白占 Steam 的限流额度（同 host 每 1200ms 才放一个请求），
     *    连带把随后的列表/详情请求往后挤；
     *  - `detailLoading` 会**一直停在 true**（selectItem 的 finally 里有
     *    `if (this.selected && this.selected.id === id)` 守卫，关闭后不再成立）。
     * 所以关闭统一走这里：取消详情请求 → 清选中态 → 复位加载与错误标记。
     *
     * 注意只取消**详情**那一发，不碰列表 —— 关掉详情不该影响正在翻的页。
     */
    closeDetail() {
      this.abortInflight('_inflightDetail');
      this.selected = null;
      this.detail = null;
      this.related = null;
      this.detailLoading = false;
      this.detailError = '';
      this.detailNotFound = false;
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
      // 作者页也是"列表"那一类：切过来就该掐掉上一发（可能是全站浏览的请求），
      // 否则它跑完还占着限流额度，把作者页往后挤。
      const ac = this._newInflight('_inflight');
      try {
        const data = await api.author(
          this.authorView.steamId,
          this.filters.page,
          this.filters.pageSize,
          this.authorView,
          ac ? ac.signal : undefined
        );
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
        // 用户主动取消（cancelLoad）不该被当成错误弹出来
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
        this.showToast('已关掉「隐藏成人内容」', 'warn');
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

    /**
     * 排序下拉一次搞定：普通排序是纯 key，最热门带时间窗（`trend:7`）。
     * 时间窗那个独立下拉已经删掉了（见 sortOptionsFlat 的说明）。
     */
    onSortChange(e) {
      const raw = String(e.target.value || '');
      const i = raw.indexOf(':');
      if (i > 0) {
        this.applyFilters({ sort: raw.slice(0, i), days: Number(raw.slice(i + 1)) || 7 });
      } else {
        this.applyFilters({ sort: raw });
      }
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

    // 注：原来的 onDaysChange 已删 —— 时间窗合进了排序下拉（见 onSortChange）

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

    /**
     * 列表的滚动容器。
     *
     * ⚠️ 是外层 `.content`（`overflow-y:auto`），**不是** `.grid`。
     * `.grid` 只是 `display:grid`，没有任何 overflow —— 对它设 scrollTop 是**空操作**。
     *
     * 这里踩过坑：`scrollToTop()` 原本拿的是 `$refs.gridScroll`（那个 ref 挂在 .grid 上），
     * 于是翻页**根本不回到顶部**；而 `getScrollTop/setScrollTop` 拿的是
     * `document.querySelector('.content')`，是对的。两个口径不一致，
     * 结果「创意工坊」和「已订阅」两个视图翻页都不重置滚动条（用户报的），
     * 并且"从作者页返回时恢复滚动位置"也一直恢复成 0。现在统一走这里。
     *
     * 同一时刻只会渲染一个 `.content`（浏览 / 已订阅 是 v-if / v-else）。
     */
    scrollEl() {
      return this.$refs.content || document.querySelector('.content') || null;
    },

    scrollToTop() {
      const el = this.scrollEl();
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
          this.showToast('已打开 Steam 页面，点右侧「举报」即可', 'warn');
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
        this.showToast('已屏蔽该作者', 'warn');
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
      this.closeDetail();
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

    /** 列表滚动位置（作者页返回时用来还原） */
    getScrollTop() {
      const el = this.scrollEl();
      return el ? el.scrollTop : 0;
    },
    setScrollTop(top) {
      const el = this.scrollEl();
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
      // 详情请求也要能取消：快速连点不同卡片时，旧的详情请求会占限流额度。
      // 只取消上一发**详情**，不碰列表 —— 否则在详情面板里点"相关壁纸"
      // 会把正在翻的那一页掐掉（旧实现共用一个槽位，就是这个毛病）。
      const ac = this._newInflight('_inflightDetail');
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
      this.closeDetail();
      this.selectItem(it);
    },

    markBusy(id, on) {
      const next = Object.assign({}, this.busyIds);
      if (on) next[id] = true;
      else delete next[id];
      this.busyIds = next;
    },

    /**
     * 取一件作品的「必需物品」（它依赖的其它创意工坊项目）。
     *
     * 只有详情页 HTML 里有这个信息（浏览页 SSR 和公开的 GetPublishedFileDetails 都不给），
     * 所以：
     *  - 详情面板已经打开 → 直接用 `detail.requiredItems`，不额外请求；
     *  - 从卡片直接订阅 → 现场拉一次 `/api/item` 查，结果按 id 缓存 5 分钟。
     *
     * 查不到（网络失败 / 页面被限流）时返回 null —— 意思是"不知道"，
     * 不是"没有依赖"，调用方要按 null 静默放行，不能当成没有。
     */
    async requiredItemsOf(item) {
      const id = item && item.id;
      if (!id) return null;
      if (this.detail && this.detail.id === id && Array.isArray(this.detail.requiredItems)) {
        return this.detail.requiredItems;
      }
      const hit = this._requiredCache && this._requiredCache[id];
      if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.items;
      try {
        const r = await api.item(id);
        const items = Array.isArray(r.requiredItems) ? r.requiredItems : [];
        this._requiredCache = Object.assign({}, this._requiredCache, { [id]: { at: Date.now(), items } });
        return items;
      } catch (e) {
        // 查不到依赖不算失败：宁可漏一次提示，也不要拦住用户订阅
        return null;
      }
    },

    /**
     * 订阅/取消订阅。
     *
     * 「必需物品」是这次加的重点：预设/场景经常依赖另一个壁纸，只订它是**加载不出来**的
     * （用户踩过：订了「德克萨斯-Texas」结果用不了，也不知道为什么）。
     * 所以订阅前先查依赖，有没订的就问一句"要不要一起订"，和 Steam 客户端一致。
     */
    async doSubscribe(item, opts) {
      const id = item && item.id;
      if (!id) return;
      if (!this.loggedIn) {
        this.openSettings('account');
        this.showToast('需要登录 Steam 才能订阅', 'warn');
        return;
      }
      // 用"Steam 订阅 ∪ 本地库"判断当前状态，否则 Cookie 失效时会把已订阅的当成未订阅
      const willSub = !this.isSubscribedId(id);
      if (!willSub) return this.runSubscribe(item, false, []);

      // 订阅前查依赖
      const deps = await this.requiredItemsOf(item);
      const missing = (deps || []).filter((d) => !d.subscribed && !this.isSubscribedId(d.id));
      if (!missing.length) return this.runSubscribe(item, true, []);

      // 有没订的依赖 → 弹窗问（确认/取消分别走 onConfirmDeps / onConfirmCancel）
      this.confirm = {
        kind: 'deps',
        item: item,
        deps: missing,
      };
    },

    /** 确认弹窗：一起订阅 */
    async onConfirmDeps() {
      const c = this.confirm;
      this.confirm = null;
      if (!c) return;
      await this.runSubscribe(c.item, true, c.deps);
    },

    /** 确认弹窗：仍然只订阅这一个（会提示它是加载不出来的） */
    async onConfirmDepsSkip() {
      const c = this.confirm;
      this.confirm = null;
      if (!c) return;
      await this.runSubscribe(c.item, true, []);
      this.showToast('缺少依赖的壁纸，Wallpaper Engine 里可能加载不出来', 'warn');
    },

    onConfirmCancel() {
      this.confirm = null;
    },

    /** 真正打 Steam 的订阅请求；deps 里的依赖项一并订阅 */
    async runSubscribe(item, willSub, deps) {
      const id = item && item.id;
      if (!id) return;
      this.markBusy(id, true);
      try {
        const r = await api.subscribe(id, willSub ? 'sub' : 'unsub');
        if (r.ok) {
          const next = Object.assign({}, this.subscribedIds);
          if (willSub) next[id] = true;
          else delete next[id];
          // 依赖项也标记成已订阅，免得重复提示
          (deps || []).forEach((d) => { next[d.id] = true; });
          this.subscribedIds = next;
          let extra = 0;
          for (const d of deps || []) {
            try {
              const rr = await api.subscribe(d.id, 'sub');
              if (rr.ok) extra++;
            } catch (e) {
              /* 依赖项订阅失败不阻断主流程，最后统一提示 */
            }
          }
          if (willSub) {
            this.showToast(
              extra > 0
                ? '已订阅，连同 ' + extra + ' 个依赖一起'
                : '已订阅（Steam 会开始下载）',
              'ok'
            );
          } else {
            this.showToast('已取消订阅', 'ok');
          }
          this.patchItemStat(id, 'subscriptions', willSub ? 1 : -1);
          if (willSub) this.patchItemStat(id, 'lifetimeSubscriptions', 1);
          notifyHost({ event: 'subscribe', id, subscribed: willSub });
          // 已订阅视图开着的话，顺手刷新
          if (this.mode === 'subscribed' && !willSub) this.loadSubscribed(true);
        } else {
          this.showToast(r.reason || '操作失败', 'error');
          if (r.needLogin) this.openSettings('account');
        }
      } catch (e) {
        this.showToast('订阅失败：' + e.message, 'error');
        if (e.needLogin) {
          this.loadSession();
          this.openSettings('account');
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
      /*
       * 登录态变了 → 「已订阅」角标集合必须重拉。
       *
       * 那个集合依赖登录态（未登录时后端回 ok:false，前端直接失败退出），
       * 而 _subsLoaded 是"已经成功拉过一次"的守卫 —— 如果不在登录态变化时清掉，
       * loadList 里的守卫会一直跳过它，于是"登录了但订阅角标始终不出来"。
       * 顺手把"提示过一次"也清掉，让新的失败还能再提示一次。
       */
      this._subsLoaded = false;
      this._subsWarned = false;
      this.loadList({ force: true });
      // 不依赖 loadList 是否成功：角标本身也要拉一次（有防重入，不会重复请求）
      this.loadSubscribedIds();
      /*
       * 顺带把「我的订阅」列表也重拉一次。
       *
       * 那份列表要先爬 Steam 的订阅页才能拿到准确的订阅集合，
       * 而那一步依赖登录态 —— 旧 Cookie 过期时后端会静默退回本地库
       * （source='local'）。用户重新登录之后如果不重拉，界面上会一直挂着
       * 「Steam 列表不可用」，看着像没登上（用户报的）。
       * 这次重拉要绕过后端缓存，所以传 fresh=1。
       */
      const degraded = !!this.subs.source && this.subs.source !== 'steam';
      if (this.mode === 'subscribed' || (degraded && this.loggedIn)) {
        this.loadSubscribed(true);
      }
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
      this.closeDetail();
      this.detail = null;
      this.related = null;
      this.loadSubscribed();
    },

    async loadSubscribed(fresh) {
      /*
       * 已订阅清单也是"列表"那一类，同样要能取消、也要防过期响应。
       *
       * 旧实现三样都没有：不接 AbortController、没有序号守卫。
       * 于是快速在「创意工坊 ↔ 已订阅」之间来回切、或在已订阅页快速翻页时，
       * 慢的那一发会**后到**，把界面上更新的结果覆盖掉（典型的竞态）。
       * 这里用自己的序号（不复用 requestSeq），避免干扰浏览列表的 loading 生命周期。
       *
       * ⚠️ 序号必须这样算，不能写 `++this._subsSeq`。
       * **Vue 2 不会把 data 里下划线开头的属性挂到实例上**（避免与内部属性冲突），
       * 所以 `_subsSeq: 0` 这个初始值是**拿不到**的 —— `this._subsSeq` 是 undefined，
       * `++undefined` 得到 NaN，而 `NaN !== NaN` 恒为真，
       * 于是响应回来后会被下面的"过期守卫"全部挡掉：
       * 数据丢弃、`loading` 永远停在 true。
       * 症状就是「接口明明 200 返回了数据，界面上却一直转圈、0 个」。
       */
      const seq = (this._subsSeq || 0) + 1;
      this._subsSeq = seq;
      const ac = this._newInflight('_inflightSubs');
      this.subs.loading = true;
      this.subs.error = '';
      try {
        const r = await api.subscribed(
          {
            page: this.subs.page,
            pageSize: this.subs.pageSize,
            search: this.subs.search,
            sort: this.subs.sort,
            fresh: !!fresh,
          },
          ac ? ac.signal : undefined
        );
        if (seq !== this._subsSeq) return;
        this.subs.items = r.items || [];
        this.subs.totalCount = r.totalCount || 0;
        this.subs.totalPages = r.totalPages || 1;
        this.subs.page = r.page || 1;
        this.subs.wsDir = r.wsDir || '';
        this.subs.source = r.source || '';
        this.subs.staleLocalCount = r.staleLocalCount || 0;
        this.subs.note = r.note || '';
        // 列表以 Steam 为准时，顺手把"已订阅"角标也同步过来（取消订阅能立刻反映）
        if (r.source === 'steam') this.loadSubscribedIds();
      } catch (e) {
        if (seq !== this._subsSeq) return;
        if (e && e.name === 'AbortError') return;
        this.subs.error = e.message || String(e);
      } finally {
        if (seq === this._subsSeq) {
          this.subs.loading = false;
          this._inflightSubs = null;
        }
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
