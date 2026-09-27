/**
 * 右侧详情面板：对应 WE 里点开一张壁纸后显示的信息区。
 * 包含：预览图、标题、作者、类型/分辨率/文件大小、评分、订阅/收藏、
 *       描述、标签，以及「相关壁纸（该作者的创意工坊）」——点作者名会跳到该作者的全部作品。
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
    return { showMore: false, previewIndex: 0, previewFailed: false };
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
    relatedCountText() {
      const n = Number(this.related && this.related.totalCount) || 0;
      if (n <= 999) return String(n);
      return formatCount(n);
    },
  },
  watch: {
    'detail.id'() {
      this.previewIndex = 0;
      this.previewFailed = false;
      this.showMore = false;
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
    onImgError() {
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
      <button class="detail-close" title="关闭" @click="$emit('close')">✕</button>

      <div v-if="loading" class="detail-loading">
        <div class="spinner"></div>
        <div>正在读取作品信息…</div>
      </div>

      <div v-else-if="error" class="detail-error">
        <div class="err-title">{{ notFound ? '找不到这个作品' : '无法显示详情' }}</div>
        <div class="err-msg">{{ error }}</div>
        <button class="fbtn" v-if="!notFound" @click="$emit('reload')">重试</button>
      </div>

      <div v-else-if="!item" class="detail-empty">
        <div class="empty-ico">🖼</div>
        <div>从左侧点选一张壁纸</div>
        <div class="empty-sub">这里会显示它的预览、作者、评分与订阅按钮</div>
      </div>

      <template v-else>
        <div class="detail-preview">
          <img :src="mainImage" :alt="item.title" @error="onImgError">
        </div>
        <div v-if="gallery.length > 1" class="thumbs">
          <img v-for="(g, i) in gallery.slice(0, 8)" :key="g" :src="imgSrc(g)"
               :class="{ on: i === previewIndex }" @click="setPreview(i)" loading="lazy">
        </div>

        <!-- 详情页解析不完整时明确说明，别让用户以为这个作品就这么点内容（BUG-13） -->
        <div v-if="partialReason" class="notebar warn" style="margin-top:8px">{{ partialReason }}</div>

        <h2 class="detail-title" :title="item.title">{{ item.title }}</h2>

        <div class="detail-author" @click="gotoAuthor" :title="authorId ? '查看该作者的全部作品' : ''">
          <img v-if="author.avatar || item.creatorAvatar" class="avatar"
               :src="imgSrc(author.avatar || item.creatorAvatar)">
          <div v-else class="avatar placeholder">👤</div>
          <div class="author-text">
            <div class="author-name">{{ authorName || ('作者 ' + (authorId ? authorId.slice(-6) : '未知')) }}</div>
            <div class="author-id">{{ authorId }}</div>
          </div>
          <span class="author-go">相关壁纸 ›</span>
        </div>

        <div class="detail-stats">
          <span v-if="item.fileSize">{{ fmtSize(item.fileSize) }}</span>
          <span v-if="item.resolution">{{ shortRes(item.resolution) }}</span>
          <span v-if="item.ageRating">{{ ageLabel(item.ageRating) }}</span>
          <span v-if="item.views">{{ fmtCount(item.views) }} 浏览</span>
          <span v-if="collectionsText" :title="'被收录进 ' + item.collections + ' 个合集'">{{ collectionsText }} 个合集</span>
        </div>

        <div class="detail-rating">
          <span class="stars" :title="starText ? starText + ' / 5 星' : ''">
            <span v-for="n in 5" :key="n" :class="{ lit: n <= stars }">★</span>
          </span>
          <span class="rating-label">{{ ratingLabel }}</span>
          <span class="rating-votes" v-if="item.totalVotes">{{ fmtCount(item.totalVotes) }} 个评价</span>
        </div>

        <div class="detail-metrics">
          <div class="metric">
            <div class="metric-v">{{ fmtCount(item.subscriptions) }}</div>
            <div class="metric-k">订阅</div>
          </div>
          <div class="metric">
            <div class="metric-v">{{ fmtCount(item.favorited) }}</div>
            <div class="metric-k">收藏</div>
          </div>
          <div class="metric">
            <div class="metric-v">{{ fmtCount(item.lifetimeSubscriptions || item.subscriptions) }}</div>
            <div class="metric-k">累计订阅</div>
          </div>
        </div>

        <div class="detail-actions">
          <button class="act primary" :class="{ on: subscribed }" :disabled="busy" @click="subscribe">
            {{ subscribed ? '✓ 已订阅（点击取消）' : '订阅' }}
          </button>
          <button class="act icon" :class="{ on: favorited }" :disabled="busy"
                  :title="favorited ? '取消收藏' : '收藏'" @click="favorite">♥</button>
          <button class="act icon" :class="{ on: current }" :disabled="busy || !canApply"
                  :title="canApply
                    ? (current ? '当前桌面正在使用（点击重新应用）' : '设为使用中（应用为桌面壁纸）')
                    : '还不能设为使用中：这个壁纸没订阅或还没下载到本地'"
                  @click="$emit('apply', item)">▶</button>
          <button class="act icon" :class="{ open: showMore }" title="更多" @click="showMore = !showMore">≡</button>
        </div>

        <div v-if="showMore" class="detail-more">
          <button class="more-item" @click="vote('up')"><span>👍</span> 点赞（给好评）</button>
          <button class="more-item" @click="vote('down')"><span>👎</span> 点踩（给差评）</button>
          <button class="more-item" @click="copyLink"><span>🔗</span> 复制作品链接</button>
          <button class="more-item" @click="openSteam"><span>↗</span> 在 Steam 里打开</button>
          <button class="more-item" @click="gotoAuthor" v-if="authorId"><span>👤</span> 该作者的全部作品</button>
        </div>

        <div class="detail-section" v-if="item.description">
          <div class="section-head">描述</div>
          <div class="desc">{{ item.description }}</div>
        </div>

        <div class="detail-section" v-if="tags.length">
          <div class="section-head">标签</div>
          <div class="chips">
            <span v-for="t in tags" :key="t" class="chip" @click="$emit('tag', t)">{{ tagLabel(t) }}</span>
          </div>
        </div>

        <div class="detail-section">
          <div class="section-head">信息</div>
          <table class="kv">
            <tr><td>作品 ID</td><td>{{ item.id }}</td></tr>
            <tr v-if="item.timeCreated"><td>发布时间</td><td>{{ fmtDate(item.timeCreated) }}（{{ ago(item.timeCreated) }}）</td></tr>
            <tr v-if="item.timeUpdated"><td>更新时间</td><td>{{ fmtDate(item.timeUpdated) }}</td></tr>
            <tr v-if="item.fileName"><td>文件</td><td class="ellipsis">{{ item.fileName }}</td></tr>
          </table>
        </div>

        <div class="detail-section">
          <div class="section-head">
            相关壁纸
            <span class="section-sub" v-if="related && related.totalCount"
                  title="来自该作者的创意工坊页；Steam 会把用户参与协作/被署名的作品也列在里面">
              该作者的创意工坊 · 共 {{ relatedCountText }} 个
            </span>
            <span class="section-sub" v-else-if="relatedLoading">加载中…</span>
            <a class="section-link" @click="gotoAuthor" v-if="authorId">查看全部 ›</a>
          </div>
          <div class="related" v-if="relatedItems.length">
            <wp-card v-for="r in relatedItems.slice(0, 12)" :key="r.id" :item="r"
                     @pick="pickRelated" @menu="$emit('menu', $event)"></wp-card>
          </div>
          <div class="dim" v-else-if="relatedLoading" style="font-size:11.5px">正在读取该作者的创意工坊…</div>
          <div class="dim" v-else-if="relatedError" style="font-size:11.5px">
            相关壁纸这次没取到（{{ relatedError }}），点「查看全部」可以再试。
          </div>
          <div class="dim" v-else style="font-size:11.5px">
            该作者目前只有这一个公开作品。
          </div>
        </div>
      </template>
    </aside>
  `,
});
