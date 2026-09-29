/**
 * 右侧详情面板：点开一张壁纸后显示的信息区。
 *
 * 结构：粘性头部（标题 + 关闭） → 预览图 → 缩略图条 → 作者 → 操作 → 统计条
 *       → 描述（可展开） → 标签 → 技术信息（折叠） → 相关壁纸（折叠 + 行卡）
 *
 * 注意「相关壁纸」的**数据来源是另一个请求**（作者的个人创意工坊页），
 * 由父组件并发拉取后通过 props 传进来；这里只负责渲染 + 加载态 + 失败态。
 */
Vue.component('detail-pane', {
  props: {
    detail: { type: Object, default: null },
    loading: { type: Boolean, default: false },
    error: { type: String, default: '' },
    notFound: { type: Boolean, default: false },
    related: { type: Object, default: null },
    relatedLoading: { type: Boolean, default: false },
    relatedError: { type: String, default: '' },
    busy: { type: Boolean, default: false },
    subscribed: { type: Boolean, default: false },
    favorited: { type: Boolean, default: false },
    /** 当前桌面是否正在使用这个作品 / 本机能不能设置使用中 */
    current: { type: Boolean, default: false },
    canApply: { type: Boolean, default: false },
    embedded: { type: Boolean, default: false },
  },
  data() {
    return {
      showMore: false,
      previewIndex: 0,
      previewFailed: false,
      descOpen: false,
      techOpen: false,
      relatedOpen: false,
    };
  },
  computed: {
    item() {
      return this.detail && this.detail.item ? this.detail.item : null;
    },
    author() {
      return (this.detail && this.detail.author) || { steamId: '', name: '', avatar: '' };
    },
    authorName() {
      return this.author.name || (this.item && this.item.creatorName) || '';
    },
    authorId() {
      return this.author.steamId || (this.item && this.item.creator) || '';
    },
    gallery() {
      if (!this.item) return [];
      const list = [];
      if (this.item.previewUrl) list.push(this.item.previewUrl);
      (this.item.previews || []).forEach((p) => {
        if (p && p.url && list.indexOf(p.url) < 0) list.push(p.url);
      });
      (this.detail && this.detail.screenshots ? this.detail.screenshots : []).forEach((u) => {
        if (u && list.indexOf(u) < 0) list.push(u);
      });
      return list;
    },
    mainImage() {
      if (this.previewFailed) return PLACEHOLDER;
      const u = this.gallery[this.previewIndex] || (this.item && this.item.previewUrl);
      return u ? imgSrc(u) : PLACEHOLDER;
    },
    stars() {
      const r = this.item ? Number(this.item.starRating) : NaN;
      if (!Number.isFinite(r) || r < 0) return 0;
      return Math.max(1, Math.min(5, Math.round(r)));
    },
    /** 精确到一位小数的星级（Steam 回的是 0~5 的整数或 .5 档） */
    starText() {
      const r = this.item ? Number(this.item.starRating) : NaN;
      if (!Number.isFinite(r) || r < 0) return '';
      return (Math.round(r * 10) / 10).toFixed(1);
    },
    ratingLabel() {
      if (this.detail && this.detail.ratingText) return this.detail.ratingText;
      const r = this.item ? Number(this.item.starRating) : NaN;
      if (!Number.isFinite(r) || r < 0) return '评价数不足';
      if (r >= 4.5) return '好评如潮';
      if (r >= 4) return '特别好评';
      if (r >= 3) return '好评';
      if (r >= 2) return '褒贬不一';
      return '差评';
    },
    /** 详情页这次没解析成功、只剩公开接口字段时的提示（BUG-13） */
    partialReason() {
      return (this.detail && this.detail.partial && this.detail.partialReason) || '';
    },
    collectionsText() {
      const n = Number(this.item && this.item.collections) || 0;
      return n > 0 ? formatCount(n) : '';
    },
    tags() {
      return (this.item && this.item.tags) || [];
    },
    relatedItems() {
      return (this.related && this.related.items) || [];
    },
    /** 相关壁纸数量文案：Steam 上有些高产作者有上千个作品，只显示个概数 */
    relatedCount() {
      const n = Number(this.related && this.related.totalCount) || 0;
      return n > 999 ? formatCount(n) : String(n);
    },
    /** 「设为使用中」按钮的提示：能设 / 不能设 / 正在用 */
    applyTitle() {
      if (this.current) return '当前正在使用，点击重新应用';
      if (this.canApply) return '设为桌面壁纸';
      return '需要先订阅并下载到本地';
    },
    /**
     * 「必需物品」：这件壁纸依赖的其它创意工坊项目。
     * 只订阅它是**加载不出来**的，所以订阅前要提示（对齐客户端）。
     */
    requiredItems() {
      return (this.detail && this.detail.requiredItems) || [];
    },
    /** 还没订的依赖项（data-subscribed 标记的） */
    missingDeps() {
      return this.requiredItems.filter((d) => !d.subscribed);
    },
  },
  watch: {
    'detail.id'() {
      this.previewIndex = 0;
      this.previewFailed = false;
      this.showMore = false;
      this.descOpen = false;
      this.techOpen = false;
      this.relatedOpen = false;
    },
  },
  methods: {
    fmtSize: formatSize,
    fmtDate: formatDate,
    ago: timeAgo,
    fmtCount: formatCount,
    typeLabel: typeLabel,
    ageLabel: ageLabel,
    tagLabel: tagLabel,
    shortRes: shortResolution,
    imgSrc,
    /** 缩略图条里点坏的图 → 用占位图（不重置整个预览） */
    onImgError(ev) {
      ev.target.src = PLACEHOLDER;
    },
    onPreviewError() {
      this.previewFailed = true;
    },
    subscribe() {
      this.$emit('subscribe', this.item);
    },
    favorite() {
      this.$emit('favorite', this.item);
    },
    vote(action) {
      this.$emit('vote', { item: this.item, action });
    },
    openSteam() {
      openOnSteam(this.item.id);
    },
    /** 复制链接：交给 app 统一处理（clipboard API + execCommand 兜底 + toast） */
    copyLink() {
      this.$emit('copy', this.item);
    },
    gotoAuthor() {
      if (this.authorId) this.$emit('author', { steamId: this.authorId, name: this.authorName });
    },
    pickRelated(it) {
      this.$emit('pick', it);
    },
    setPreview(i) {
      this.previewIndex = i;
      this.previewFailed = false;
    },
  },
  template: `
    <aside class="detail">
      <div v-if="loading" class="detail-loading">
        <div class="spinner"></div>
        <div>正在读取作品信息…</div>
      </div>

      <div v-else-if="error" class="detail-error">
        <div class="err-title">{{ notFound ? '找不到这个作品' : '无法显示详情' }}</div>
        <div class="err-msg">{{ error }}</div>
        <button class="btn" v-if="!notFound" @click="$emit('reload')">重试</button>
      </div>

      <div v-else-if="!item" class="detail-empty">
        <svg class="ic" style="width:36px;height:36px;stroke-width:1.4;color:var(--line-2)"><use href="#i-image"></use></svg>
        <div>选择一张壁纸查看详情</div>
      </div>

      <template v-else>
        <!-- 粘性头部：滚动时标题和关闭按钮始终在 -->
        <div class="detail-head">
          <h2 :title="item.title">{{ item.title }}</h2>
          <button class="btn icon" title="关闭" aria-label="关闭详情" @click="$emit('close')">
            <svg class="ic"><use href="#i-x"></use></svg>
          </button>
        </div>

        <div class="detail-body">
          <div class="detail-preview">
            <img :src="mainImage" :alt="item.title" @error="onPreviewError">
          </div>
          <div v-if="gallery.length > 1" class="thumbs">
            <img v-for="(g, i) in gallery.slice(0, 8)" :key="g" :src="imgSrc(g)"
                 :class="{ on: i === previewIndex }" :alt="'预览图 ' + (i + 1)"
                 @click="setPreview(i)" loading="lazy" @error="onImgError">
          </div>

          <!-- 详情页解析不完整时明确说明，别让用户以为这个作品就这么点内容（BUG-13） -->
          <div v-if="partialReason" class="notice warn" style="margin-top:10px">
            <svg class="ic"><use href="#i-alert"></use></svg>
            <span class="notice-text" :title="partialReason">{{ partialReason }}</span>
          </div>

          <button class="detail-author" @click="gotoAuthor" :title="authorId ? '查看该作者的全部作品' : ''">
            <img v-if="author.avatar || item.creatorAvatar" class="avatar" alt=""
                 :src="imgSrc(author.avatar || item.creatorAvatar)">
            <span v-else class="avatar placeholder"><svg class="ic"><use href="#i-user"></use></svg></span>
            <span class="author-text">
              <span class="author-name">{{ authorName || '未知作者' }}</span>
              <span class="author-id">{{ authorId }}</span>
            </span>
            <span class="author-go">全部作品<svg class="ic tiny"><use href="#i-chev-right"></use></svg></span>
          </button>

          <!-- 星级：5 颗星 + Steam 的评价文案（"特别好评"这类），再跟一行紧凑统计 -->
          <div class="detail-rating">
            <span class="stars" :title="starText ? starText + ' / 5 星' : '评价数不足'"
                  :aria-label="starText ? '评分 ' + starText + ' / 5' : '暂无评分'">
              <svg v-for="n in 5" :key="n" class="ic" :class="{ lit: n <= stars }">
                <use href="#i-star"></use>
              </svg>
            </span>
            <span class="rating-label">{{ ratingLabel }}</span>
            <span class="rating-votes" v-if="item.totalVotes">{{ fmtCount(item.totalVotes) }} 个评价</span>
          </div>

          <div class="detail-stats">
            <span class="stat" v-if="item.subscriptions"><span class="stat-v">{{ fmtCount(item.subscriptions) }}</span><span class="stat-k">订阅</span></span>
            <span class="stat" v-if="item.favorited"><span class="stat-v">{{ fmtCount(item.favorited) }}</span><span class="stat-k">收藏</span></span>
            <span class="stat" v-if="item.views"><span class="stat-v">{{ fmtCount(item.views) }}</span><span class="stat-k">浏览</span></span>
            <span class="stat" v-if="item.fileSize"><span class="stat-v">{{ fmtSize(item.fileSize) }}</span><span class="stat-k">大小</span></span>
          </div>

          <!-- 依赖提示：有没订的依赖项时明确说清楚，否则用户会"订阅完却用不了" -->
          <div class="dep-note" v-if="missingDeps.length">
            <svg class="ic"><use href="#i-alert"></use></svg>
            <div>
              这个壁纸依赖下面 {{ missingDeps.length }} 个壁纸，<b>只订阅它是用不了的</b>：
              <ul class="dep-note-list">
                <li v-for="d in missingDeps" :key="d.id">{{ d.title }}</li>
              </ul>
              <span v-if="requiredItems.length > missingDeps.length" class="dim">
                （另有 {{ requiredItems.length - missingDeps.length }} 个依赖已订阅）
              </span>
            </div>
          </div>

          <div class="detail-actions">
            <button class="btn lg primary" :class="{ on: subscribed }" :disabled="busy" @click="subscribe">              {{ subscribed ? '已订阅（点击取消）' : '订阅' }}
            </button>
            <button class="btn icon lg" :class="{ on: favorited }" :disabled="busy"
                    :title="favorited ? '取消收藏' : '收藏'"
                    :aria-label="favorited ? '取消收藏' : '收藏'" @click="favorite">
              <svg class="ic" :class="{ solid: favorited }"><use href="#i-heart"></use></svg>
            </button>
            <button class="btn icon lg" :disabled="busy || !canApply"
                    :title="applyTitle" :aria-label="applyTitle" @click="$emit('apply', item)">
              <svg class="ic solid"><use href="#i-play"></use></svg>
            </button>
            <button class="btn icon lg" :class="{ on: showMore }" title="更多" aria-label="更多"
                    :aria-expanded="String(showMore)" @click="showMore = !showMore">
              <svg class="ic solid"><use href="#i-more"></use></svg>
            </button>
          </div>

          <div v-if="showMore" class="detail-more">
            <button class="more-item" @click="vote('up')">
              <svg class="ic"><use href="#i-thumb-up"></use></svg>好评
            </button>
            <button class="more-item" @click="vote('down')">
              <svg class="ic"><use href="#i-thumb-down"></use></svg>差评
            </button>
            <button class="more-item" @click="copyLink">
              <svg class="ic"><use href="#i-link"></use></svg>复制链接
            </button>
            <button class="more-item" @click="openSteam">
              <svg class="ic"><use href="#i-external"></use></svg>在 Steam 打开
            </button>
            <button class="more-item" v-if="authorId" @click="gotoAuthor">
              <svg class="ic"><use href="#i-user"></use></svg>该作者的全部作品
            </button>
          </div>

          <!-- 描述：3 行截断 + 展开。原来是 220px 的内嵌滚动条，很难用 -->
          <div class="detail-section" v-if="item.description">
            <div class="section-head">描述</div>
            <div class="desc" :class="{ clamp: !descOpen }">{{ item.description }}</div>
            <button v-if="item.description.length > 90" class="text-toggle" @click="descOpen = !descOpen">
              {{ descOpen ? '收起' : '展开' }}
            </button>
          </div>

          <div class="detail-section" v-if="tags.length">
            <div class="section-head">标签</div>
            <div class="chips">
              <span v-for="t in tags" :key="t" class="chip" @click="$emit('tag', t)">{{ tagLabel(t) }}</span>
            </div>
          </div>

          <div class="detail-section" v-if="item.resolution || item.ageRating || item.wallpaperType || collectionsText">
            <div class="section-head">规格</div>
            <table class="kv">
              <tr v-if="item.wallpaperType"><td>类型</td><td>{{ typeLabel(item.wallpaperType) }}</td></tr>
              <tr v-if="item.resolution"><td>分辨率</td><td>{{ shortRes(item.resolution) }}</td></tr>
              <tr v-if="item.ageRating"><td>分级</td><td>{{ ageLabel(item.ageRating) }}</td></tr>
              <tr v-if="collectionsText"><td>合集</td><td>{{ collectionsText }} 个</td></tr>
            </table>
          </div>

          <!-- 技术信息：作品 ID / 文件名这类普通用户用不到的东西收在这里 -->
          <div class="fold">
            <button class="fold-head" :aria-expanded="String(techOpen)" @click="techOpen = !techOpen">
              <svg class="ic caret" :class="{ collapsed: !techOpen }"><use href="#i-chev-down"></use></svg>
              <span class="fold-title">技术信息</span>
            </button>
            <div class="fold-body" v-show="techOpen">
              <table class="kv">
                <tr><td>作品 ID</td><td>{{ item.id }}</td></tr>
                <tr v-if="item.timeCreated"><td>发布</td><td>{{ fmtDate(item.timeCreated) }}（{{ ago(item.timeCreated) }}）</td></tr>
                <tr v-if="item.timeUpdated"><td>更新</td><td>{{ fmtDate(item.timeUpdated) }}</td></tr>
                <tr v-if="item.lifetimeSubscriptions"><td>累计订阅</td><td>{{ fmtCount(item.lifetimeSubscriptions) }}</td></tr>
                <tr v-if="item.fileName"><td>文件</td><td class="ellipsis" :title="item.fileName">{{ item.fileName }}</td></tr>
              </table>
            </div>
          </div>

          <!-- 相关壁纸：该作者的创意工坊。行卡 + "查看全部"CTA，比 2 列迷你卡好读 -->
          <div class="fold">
            <button class="fold-head" :aria-expanded="String(relatedOpen)" @click="relatedOpen = !relatedOpen">
              <svg class="ic caret" :class="{ collapsed: !relatedOpen }"><use href="#i-chev-down"></use></svg>
              <span class="fold-title">该作者的作品</span>
              <span class="fold-sub" v-if="relatedLoading">加载中…</span>
              <span class="fold-sub" v-else-if="related && related.totalCount">共 {{ relatedCount }} 个</span>
            </button>
            <div class="fold-body" v-show="relatedOpen">
              <div class="related-list" v-if="relatedItems.length">
                <button class="related-row" v-for="r in relatedItems.slice(0, 4)" :key="r.id" @click="pickRelated(r)">
                  <img class="related-thumb" :src="imgSrc(r.previewUrl)" :alt="r.title" loading="lazy" @error="onImgError">
                  <span class="related-info">
                    <span class="related-title" :title="r.title">{{ r.title }}</span>
                    <span class="related-meta" v-if="r.subscriptions">{{ fmtCount(r.subscriptions) }} 订阅</span>
                  </span>
                </button>
              </div>
              <div class="fgroup-empty" v-else-if="relatedLoading">正在读取该作者的创意工坊…</div>
              <div class="fgroup-empty" v-else-if="relatedError">这次没取到，点下面重试</div>
              <div class="fgroup-empty" v-else>该作者暂无其他公开作品</div>
              <button class="related-cta" v-if="authorId" @click="gotoAuthor">
                查看全部作品<svg class="ic tiny"><use href="#i-chev-right"></use></svg>
              </button>
            </div>
          </div>
        </div>
      </template>
    </aside>
  `,
});
