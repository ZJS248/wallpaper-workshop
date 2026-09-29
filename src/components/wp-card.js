/**
 * 壁纸卡片：对应 WE 创意工坊里的一格。
 *
 * 结构：
 *   缩略图（角标：左上=状态 / 右上=分级 / 左下=大小+分辨率 / 右下=类型）
 *   标题（单行截断）
 *   底部 34px —— 平时显示"评分 + 订阅数"，悬停时**原地**换成操作行。
 *   两者高度一致，所以悬停时栅格不跳动，浏览时视线也不会被顶走。
 *
 * ⚠️ 四个动作（订阅 / 收藏 / 设为使用中 / 在 Steam 打开）与原来的行为完全一致，
 * 这里只改了呈现方式。
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
    /** 不能设为使用中时的说明（例如"还没下载完"） */
    applyHint: { type: String, default: '' },
  },
  data() {
    return { imgFailed: false };
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
    ageText() {
      return this.item.ageRating === 'Mature' ? '18+' : '17+';
    },
    ageTitle() {
      return this.item.ageRating === 'Mature' ? '限制级（18+）' : '家长指导级（17+）';
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
     * 没有评分时只画一颗空星，不占用和真实评分同等的视觉权重。
     */
    rating() {
      const r = Number(this.item.starRating);
      if (!Number.isFinite(r) || r < 0) return null;
      return { stars: r, text: (Math.round(r * 10) / 10).toFixed(1) };
    },
    title() {
      return this.item.title || '(无标题)';
    },
    /** 类型角标配色：场景/视频/网页… 各一个颜色，扫列表时一眼能分出来 */
    typeClass() {
      const t = this.item.wallpaperType;
      if (t === 'Scene') return 't-scene';
      if (t === 'Video') return 't-video';
      if (t === 'Web') return 't-web';
      if (t === 'Wallpaper') return 't-wallpaper';
      if (t === 'Preset') return 't-preset';
      return '';
    },
    /** 「设为使用中」按钮的提示：能设 / 不能设 / 正在用，三种说法 */
    applyTitle() {
      if (this.current) return '当前正在使用，点击重新应用';
      if (this.canApply) return '设为桌面壁纸';
      return this.applyHint || '需要先订阅并下载到本地';
    },
  },
  methods: {
    onImgError() {
      this.imgFailed = true;
    },
    pick() {
      this.$emit('pick', this.item);
    },
    /** 键盘可达：卡片本身可聚焦，回车/空格等同于点击 */
    onKey(e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      this.pick();
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
    <div class="card" :class="{ active: active }" tabindex="0" role="button"
         :aria-label="title" :aria-pressed="String(!!active)"
         @click="pick" @keydown="onKey" @contextmenu.prevent="onContextMenu">
      <div class="card-thumb">
        <img :src="src" :alt="title" loading="lazy" @error="onImgError">

        <!--
          订阅 / 使用中必须"不悬停也看得见"：扫列表时一眼要能分出哪些已经订阅了。
          所以角标常驻，悬停出现的只是底部的操作行。
        -->
        <span v-if="subscribed" class="badge badge-sub" title="已订阅">已订阅</span>
        <span v-if="current" class="badge badge-current" title="当前桌面正在使用">使用中</span>
        <span v-if="item.ageRating && item.ageRating !== 'Everyone'" class="badge badge-age" :class="ageClass" :title="ageTitle">{{ ageText }}</span>

        <!-- 左下角：大小 + 分辨率；右下角：类型（对齐 WE 客户端的排布） -->
        <div class="card-badges-left" v-if="sizeBadge || resBadge">
          <span v-if="sizeBadge" class="badge" title="磁盘占用">{{ sizeBadge }}</span>
          <span v-if="resBadge" class="badge" :title="item.resolution">{{ resBadge }}</span>
        </div>
        <span v-if="item.wallpaperType" class="badge badge-type" :class="typeClass">{{ typeLabel(item.wallpaperType) }}</span>
      </div>

      <!--
        悬停浮层：默认完全不显示，鼠标滑上去才从底部升起。
        卡片平时就是一块干净的预览图（和 Wallpaper Engine 一致），
        标题、评分、订阅数和四个操作都在这里。
        已订阅/使用中这类状态不放浮层里 —— 它们常驻在左上角角标，不悬停也看得见。
      -->
      <div class="card-overlay">
        <div class="card-title" :title="title">{{ title }}</div>
        <div class="card-meta">
          <span class="cm cm-star" v-if="rating" :title="'评分 ' + rating.text + ' / 5'">
            <svg class="ic solid"><use href="#i-star"></use></svg>{{ rating.text }}
          </span>
          <span class="cm" v-else title="Steam 认为评价数不足，暂不给星级">—</span>
          <span class="cm cm-sub" v-if="item.subscriptions">{{ subsText }} 订阅</span>
          <span class="cm cm-state on" v-if="current">使用中</span>
          <span class="cm cm-state sub" v-else-if="subscribed">已订阅</span>
          <span class="cm cm-note" v-else-if="note" :title="'订阅于 ' + note">{{ note }}</span>
        </div>
        <div class="card-actions" @click.stop>
          <button class="btn sm" :class="{ on: subscribed }" :disabled="busy"
                  :title="subscribed ? '取消订阅' : '订阅'" @click="onSubscribe">
            {{ subscribed ? '已订阅' : '订阅' }}
          </button>
          <button class="btn icon sm" :class="{ on: favorited }" :disabled="busy"
                  :title="favorited ? '取消收藏' : '收藏'" :aria-label="favorited ? '取消收藏' : '收藏'"
                  @click="onFavorite">
            <svg class="ic" :class="{ solid: favorited }"><use href="#i-heart"></use></svg>
          </button>
          <button class="btn icon sm" :disabled="busy || !canApply"
                  :title="applyTitle" :aria-label="applyTitle" @click="onApply">
            <svg class="ic solid"><use href="#i-play"></use></svg>
          </button>
          <button class="btn icon sm" title="在 Steam 中打开" aria-label="在 Steam 中打开" @click="onSteam">
            <svg class="ic"><use href="#i-external"></use></svg>
          </button>
        </div>
      </div>
    </div>
  `,
});
