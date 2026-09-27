/**
 * 小工具：格式化、占位图、父窗口通信。
 *
 * 加载方式说明：本项目**没有构建步骤**，脚本都是 `<script defer>` 普通脚本
 * （不是 ES module），因为组件要引用全局的 Vue。所以这里不用 export，
 * 而是挂到 window 上，并在文件末尾把常用函数 declare 成全局常量，
 * 这样各组件（wp-card.js / detail-pane.js / app.js）能直接引用 formatSize 等名字。
 * ——踩过：一开始写成 ESM 的 export，浏览器报
 *   "Uncaught SyntaxError: Unexpected token 'export'"，随后一片 ReferenceError。
 */
(function (global) {
  'use strict';

  /** 字节数 → 人类可读 */
  function formatSize(bytes) {
    const n = Number(bytes);
    if (!n || n <= 0) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(2) + ' MB';
    return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  }

  /** Unix 秒 → 本地日期时间 */
  function formatDate(sec) {
    if (!sec) return '—';
    const d = new Date(Number(sec) * 1000);
    if (isNaN(d.getTime())) return '—';
    const p = (x) => String(x).padStart(2, '0');
    return (
      d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
    );
  }

  /** "3 天前" 之类 */
  function timeAgo(sec) {
    if (!sec) return '';
    const diff = Date.now() / 1000 - Number(sec);
    if (diff < 60) return '刚刚';
    if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
    if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
    if (diff < 86400 * 30) return Math.floor(diff / 86400) + ' 天前';
    if (diff < 86400 * 365) return Math.floor(diff / (86400 * 30)) + ' 个月前';
    return Math.floor(diff / (86400 * 365)) + ' 年前';
  }

  /** 大数字缩写：3215326 → 321.5 万 */
  function formatCount(n) {
    const v = Number(n) || 0;
    if (v < 10000) return String(v);
    if (v < 100000000) return (v / 10000).toFixed(1).replace(/\.0$/, '') + ' 万';
    return (v / 100000000).toFixed(2).replace(/\.?0+$/, '') + ' 亿';
  }

  /** 剩余时间（登录态有效期用） */
  function humanRemain(ms) {
    if (!ms || ms <= 0) return '已过期';
    const s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d > 0) return d + ' 天 ' + h + ' 小时';
    if (h > 0) return h + ' 小时 ' + m + ' 分钟';
    return m + ' 分钟';
  }

  /** 分辨率标签 → 简短形态（卡片角标用；必须够短，否则会和左下角的类型角标撞在一起） */
  function shortResolution(tag) {
    if (!tag) return '';
    const m = String(tag).match(/(\d+\s*x\s*\d+)/);
    if (m) {
      const parts = m[1].split(/\s*x\s*/);
      const short = parts[0] + '×' + parts[1];
      // 竖屏用后缀 P（Portrait），比加中文"竖"短，避免角标串行
      if (/portrait/i.test(tag)) return short + 'P';
      if (/ultrawide/i.test(tag)) return short + 'U';
      if (/dual/i.test(tag)) return short + 'D';
      if (/triple/i.test(tag)) return short + 'T';
      return short;
    }
    if (/portrait/i.test(tag)) return '竖屏';
    if (/ultrawide/i.test(tag)) return '带鱼屏';
    if (/dual/i.test(tag)) return '双屏';
    if (/triple/i.test(tag)) return '三屏';
    if (/dynamic/i.test(tag)) return '动态';
    if (/other/i.test(tag)) return '其它';
    if (/standard/i.test(tag)) return '标清';
    return tag;
  }

  /**
   * 类型：对齐 WE 客户端的"类型"面板（场景/视频/网页/常规壁纸/预设）。
   * Steam 侧 常规壁纸(Wallpaper)、预设(Preset) 属于 Category 组，客户端把它们并进类型；
   * 应用(Application) 客户端不展示，这里只保留翻译，不做筛选项。
   */
  const TYPE_LABEL = {
    Scene: '场景', Video: '视频', Web: '网页', Wallpaper: '常规壁纸',
    Preset: '预设', Application: '应用',
  };
  function typeLabel(t) {
    return TYPE_LABEL[t] || t || '';
  }

  /** 年龄分级：对齐客户端的三个档（Steam 的 Everyone / Questionable / Mature） */
  const AGE_LABEL = {
    Everyone: '大众级（G）',
    Questionable: '家长指导级（PG-13）',
    Mature: '限制级/成人级（R-18）',
  };
  function ageLabel(a) {
    return AGE_LABEL[a] || a || '';
  }

  /**
   * 标签（Steam 的 Genre 组）+ 特性（Miscellaneous 组）英文 → 中文。
   * 名字按 WE 客户端的显示名逐条对齐（例如 Television = 电视节目、Vehicle = 汽车、
   * Unspecified = 未指定样式），不再用"影视/载具/未分类"这类对不上的旧译名。
   */
  const TAG_LABEL = {
    /* 标签（Genre） */
    Abstract: '抽象', Animal: '动物', Anime: '动漫', Cartoon: '卡通', CGI: 'CGI',
    Cyberpunk: '赛博朋克', Fantasy: '幻想', Game: '游戏', Girls: '女性', Guys: '男性',
    Landscape: '风景', Medieval: '中世纪', Memes: '网红事物',
    MMD: 'MMD (Miku-Miku Dance)', Music: '音乐', Nature: '自然', 'Pixel art': '像素艺术',
    Relaxing: '放松', Retro: '复古', 'Sci-Fi': '科幻', Sports: '运动', Technology: '科技',
    Television: '电视节目', Vehicle: '汽车', Unspecified: '未指定样式',
    /* 特性（Miscellaneous） */
    Approved: '已通过', 'Audio responsive': '音频响应', '3D': '3D', Customizable: '可自定义',
    'Puppet Warp': '木偶变形', HDR: 'HDR', 'Media Integration': '媒体集成',
    'User Shortcut': '用户快捷方式', 'Video Texture': '视频纹理', 'Asset Pack': '素材包',
    /* 兼容旧值（Steam 已改名或历史数据） */
    'Sci-fi': '科幻', 'No Animation': '静态', Tutorial: '教程',
  };

  /**
   * 分辨率英文 → 客户端里的显示名。
   * 纯数字档（2560 x 1440 等）保持原样，带前缀的档只留数字 —— 分组标题
   * （宽屏/超宽屏/双显示器/三显示器/竖屏）已经说明了是哪种。
   */
  const RES_LABEL = {
    'Standard Definition': '标清',
    '1920 x 1080': '1920 x 1080 - 全高清',
    '3840 x 2160': '3840 x 2160 - 4K',
    'Ultrawide Standard Definition': '超宽（标准）',
    'Ultrawide 2560 x 1080': '2560 x 1080',
    'Ultrawide 3440 x 1440': '3440 x 1440',
    'Dual Standard Definition': '双显示器（标准）',
    'Dual 3840 x 1080': '3840 x 1080',
    'Dual 5120 x 1440': '5120 x 1440',
    'Dual 7680 x 2160': '7680 x 2160',
    'Triple Standard Definition': '三显示器（标准）',
    'Triple 4096 x 768': '4096 x 768',
    'Triple 5760 x 1080': '5760 x 1080',
    'Triple 7680 x 1440': '7680 x 1440',
    'Triple 11520 x 2160': '11520 x 2160',
    'Portrait Standard Definition': '竖屏（标准）',
    'Portrait 720 x 1280': '720 x 1280',
    'Portrait 1080 x 1920': '1080 x 1920',
    'Portrait 1440 x 2560': '1440 x 2560',
    'Portrait 2160 x 3840': '2160 x 3840',
    'Dynamic resolution': '动态分辨率',
    'Other resolution': '其他分辨率',
  };

  function tagLabel(t) {
    return TAG_LABEL[t] || RES_LABEL[t] || TYPE_LABEL[t] || AGE_LABEL[t] || t;
  }

  /** 图片占位（加载失败/未加载时用，避免裂图） */
  const PLACEHOLDER =
    'data:image/svg+xml;utf8,' +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180">' +
        '<rect width="320" height="180" fill="#1b2838"/>' +
        '<text x="160" y="96" fill="#3d5a73" font-family="sans-serif" font-size="14" text-anchor="middle">暂无预览</text>' +
        '</svg>'
    );

  /** 图片走后端代理：绕开防盗链与本机 DNS 污染，并复用后端的内存缓存 */
  function imgSrc(url) {
    if (!url) return '';
    return '/img?u=' + encodeURIComponent(url);
  }

  /** 防抖 */
  function debounce(fn, wait) {
    let timer = null;
    return function () {
      const args = arguments;
      const self = this;
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(self, args), wait);
    };
  }

  /* ------------------------- 父窗口（宿主）通信 ------------------------- */

  /**
   * 探测自己是不是被嵌在父页面里（wallpaper-manager 用 iframe 接入）。
   * 独立运行时返回 { embedded:false }。
   */
  function detectHost() {
    const embedded = window.self !== window.top;
    if (!embedded) return { embedded: false, parent: null, kind: 'standalone' };
    let kind = 'iframe';
    try {
      if (window.__POWERED_BY_QIANKUN__) kind = 'qiankun';
    } catch (e) {
      /* 忽略 */
    }
    return { embedded: true, parent: window.parent, kind };
  }

  /**
   * 向父窗口索取 Steam Cookie。
   * 协议（与 wallpaper-manager 约定）：
   *   子 → 父 : { type: 'wallpaper-workshop:hello', need: ['steamCookie'] }
   *   父 → 子 : { type: 'wallpaper-workshop:session', cookie, steamId, refreshToken? }
   * 同时兼容父页面直接推 { type:'steam-cookie', cookie } / { type:'session', cookie }。
   */
  function requestParentCookie(timeoutMs) {
    return new Promise(function (resolve) {
      const host = detectHost();
      if (!host.embedded) return resolve({ ok: false, reason: '未嵌入父页面' });

      let settled = false;
      let timer = null;
      function done(v) {
        if (settled) return;
        settled = true;
        window.removeEventListener('message', onMessage);
        clearTimeout(timer);
        resolve(v);
      }
      function onMessage(ev) {
        const d = ev && ev.data;
        if (!d || typeof d !== 'object') return;
        const t = d.type || '';
        if (t !== 'wallpaper-workshop:session' && t !== 'steam-cookie' && t !== 'session') return;
        const cookie = d.cookie || d.steamCookies || (d.data && d.data.cookie) || '';
        if (!cookie) return;
        done({ ok: true, cookie: cookie, steamId: d.steamId || '', refreshToken: d.refreshToken || '', source: 'parent-message' });
      }
      timer = setTimeout(function () {
        done({ ok: false, reason: '父页面未在超时时间内返回登录态' });
      }, timeoutMs || 2500);
      window.addEventListener('message', onMessage);
      try {
        host.parent.postMessage({ type: 'wallpaper-workshop:hello', need: ['steamCookie'], from: location.origin }, '*');
      } catch (e) {
        done({ ok: false, reason: '无法与父页面通信：' + e.message });
      }
    });
  }

  /** 通知宿主当前状态变化（宿主可选监听） */
  function notifyHost(message) {
    const host = detectHost();
    if (!host.embedded) return;
    try {
      host.parent.postMessage(Object.assign({ type: 'wallpaper-workshop:state' }, message), '*');
    } catch (e) {
      /* 忽略 */
    }
  }

  /** 在 Steam 官方站点打开（作品 id 为空时打开创意工坊首页） */
  function openOnSteam(id) {
    const url = id
      ? 'https://steamcommunity.com/sharedfiles/filedetails/?id=' + encodeURIComponent(id)
      : 'https://steamcommunity.com/app/431960/workshop/';
    window.open(url, '_blank', 'noopener');
  }

  /* ------------------------------ 导出 ------------------------------ */
  const WW = {
    formatSize: formatSize,
    formatDate: formatDate,
    timeAgo: timeAgo,
    formatCount: formatCount,
    humanRemain: humanRemain,
    shortResolution: shortResolution,
    typeLabel: typeLabel,
    ageLabel: ageLabel,
    tagLabel: tagLabel,
    PLACEHOLDER: PLACEHOLDER,
    imgSrc: imgSrc,
    debounce: debounce,
    detectHost: detectHost,
    requestParentCookie: requestParentCookie,
    notifyHost: notifyHost,
    openOnSteam: openOnSteam,
  };

  global.WW = WW;

  // 关键：把常用函数暴露成**全局常量**，组件模板与 methods 里可以直接写 formatSize 等名字。
  global.formatSize = formatSize;
  global.formatDate = formatDate;
  global.timeAgo = timeAgo;
  global.formatCount = formatCount;
  global.humanRemain = humanRemain;
  global.shortResolution = shortResolution;
  global.typeLabel = typeLabel;
  global.ageLabel = ageLabel;
  global.tagLabel = tagLabel;
  global.PLACEHOLDER = PLACEHOLDER;
  global.imgSrc = imgSrc;
  global.debounce = debounce;
  global.detectHost = detectHost;
  global.requestParentCookie = requestParentCookie;
  global.notifyHost = notifyHost;
  global.openOnSteam = openOnSteam;
})(window);
