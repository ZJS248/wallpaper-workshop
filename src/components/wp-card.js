/**
 * 壁纸卡片：对应 WE 创意工坊里的一格。
 * 结构参考截图：预览图 + 底部标题条（半透明黑底）+ 左上角类型/分级角标，
 * 悬停时显示订阅 / 收藏 / 详情按钮。
 */
Vue.component('wp-card', {
  props: {
    item: { type: Object, required: true },
    active: { type: Boolean, default: false },
    subscribed: { type: Boolean, default: false },
    favorited: { type: Boolean, default: false },
    busy: { type: Boolean, default: false },
    /** 磁盘占用（字节）。由 /api/details 批量补，拿不到就不显示这个角标 */
    size: { type: Number, default: 0 },
    /** 当前桌面正在使用这个壁纸（WE 的"使用中"） */
    current: { type: Boolean, default: false },
    /** 本机能不能设置使用中（找到 WE 安装目录 + 本地库） */
    canApply: { type: Boolean, default: false },
    /** 附注（已订阅视图用来显示"订阅时间"），不传就不显示 */
    note: { type: String, default: '' },
  },
  data() {
    return { imgFailed: false, hover: false };
  },
  computed: {
    src() {
      if (this.imgFailed) return PLACEHOLDER;
      return imgSrc(this.item.previewUrl) || PLACEHOLDER;
    },
    ageClass() {
      const a = this.item.ageRating;
      if (a === 'Mature') return 'age-mature';
      if (a === 'Questionable') return 'age-questionable';
      return 'age-everyone';
    },
    resBadge() {
      return shortResolution(this.item.resolution);
    },
    sizeBadge() {
      const b = Number(this.size) || Number(this.item.fileSize) || 0;
      return b > 0 ? formatSize(b) : '';
    },
    subsText() {
      return formatCount(this.item.subscriptions);
    },
    /**
     * 评分。浏览页 SSR 里每个结果都带 `star_rating`（0~5，-1 表示评价数不足）
     * 与 `total_votes`，所以卡片上能直接显示，无需额外请求。
     */
    rating() {
      const r = Number(this.item.starRating);
      if (!Number.isFinite(r) || r < 0) return null;
      return { stars: r, text: (Math.round(r * 10) / 10).toFixed(1) };
    },
    voteText() {
      const n = Number(this.item.totalVotes);
      return n > 0 ? formatCount(n) : '';
    },
    title() {
      return this.item.title || '(无标题)';
    },
  },
  methods: {
    onImgError() {
      this.imgFailed = true;
    },
    pick() {
      this.$emit('pick', this.item);
    },
    onSubscribe(ev) {
      ev.stopPropagation();
      this.$emit('subscribe', this.item);
    },
    onFavorite(ev) {
      ev.stopPropagation();
      this.$emit('favorite', this.item);
    },
    onSteam(ev) {
      ev.stopPropagation();
      openOnSteam(this.item.id);
    },
    onApply(ev) {
      ev.stopPropagation();
      this.$emit('apply', this.item);
    },
    /** 右键 → 交给根组件弹菜单（菜单本体在 index.html 的 <context-menu> 上） */
    onContextMenu(ev) {
      this.$emit('menu', { item: this.item, x: ev.clientX, y: ev.clientY });
    },
  },
  template: `
    <div class="card" :class="{ active: active }"
         @click="pick" @mouseenter="hover = true" @mouseleave="hover = false"
         @contextmenu.prevent="onContextMenu">
      <div class="card-thumb">
        <img :src="src" :alt="title" loading="lazy" @error="onImgError">
        <!--
          订阅 / 使用中这两个状态必须"不悬停也看得见"：
          以前只有鼠标滑上去按钮文案才变，扫一眼分不出哪些已经订阅了。
        -->
        <span v-if="subscribed" class="badge badge-sub" title="已订阅（Steam 已加入订阅）">✓ 已订阅</span>
        <span v-if="current" class="badge badge-current" title="当前桌面正在使用">▶ 使用中</span>
        <!--
          角标排布对齐 WE 客户端：左下角是"大小"（磁盘占用），右下角是"类型"；
          分辨率跟在大小后面，方便按分辨率筛选时一眼确认。
        -->
        <div class="card-badges-left">
          <span v-if="sizeBadge" class="badge badge-size" :title="'磁盘占用 ' + sizeBadge">{{ sizeBadge }}</span>
          <span v-if="resBadge" class="badge badge-res" :title="item.resolution">{{ resBadge }}</span>
        </div>
        <span v-if="item.wallpaperType" class="badge badge-type">{{ typeLabel(item.wallpaperType) }}</span>
        <span v-if="item.ageRating && item.ageRating !== 'Everyone'" class="badge badge-age" :class="ageClass">
          {{ item.ageRating === 'Mature' ? '18+' : '17+' }}
        </span>
        <div v-if="hover" class="card-actions" @click.stop>
          <button class="mini-btn" :class="{ on: subscribed }" :disabled="busy"
                  :title="subscribed ? '取消订阅' : '订阅'" @click="onSubscribe">
            {{ subscribed ? '✓ 已订阅（点击取消）' : '订阅' }}
          </button>
          <button class="mini-btn icon" :class="{ on: favorited }" :disabled="busy"
                  :title="favorited ? '取消收藏' : '收藏'" @click="onFavorite">♥</button>
          <button class="mini-btn icon" :class="{ on: current }" :disabled="busy || !canApply"
                  :title="canApply
                    ? (current ? '当前使用中（点击重新应用）' : '设为使用中（应用为桌面壁纸）')
                    : '还不能设为使用中：这个壁纸没订阅或还没下载到本地'"
                  @click="onApply">▶</button>
          <button class="mini-btn icon" title="在 Steam 中打开" @click="onSteam">↗</button>
        </div>
      </div>
      <div class="card-title">{{ title }}</div>
      <div class="card-meta">
        <span class="cm" v-if="rating" :title="'评分 ' + rating.text + ' / 5' + (voteText ? '（' + voteText + ' 个评价）' : '')">
          <span class="cm-star">★</span>{{ rating.text }}
        </span>
        <span class="cm dim" v-else title="Steam 认为评价数不足，暂不给星级">暂无评分</span>
        <span class="cm cm-sub" v-if="item.subscriptions" :title="item.subscriptions + ' 个当前订阅'">
          {{ subsText }} 订阅
        </span>
        <!-- 列表里一眼可见的状态标签（徽标之外再给一条，扫列表时更清楚） -->
        <span class="cm cm-state on" v-if="current" title="当前桌面正在使用">▶ 使用中</span>
        <span class="cm cm-state sub" v-else-if="subscribed" title="已订阅">✓ 已订阅</span>
        <span class="cm dim" v-if="note" :title="'订阅时间 ' + note">📥 {{ note }}</span>
      </div>
    </div>
  `,
});
