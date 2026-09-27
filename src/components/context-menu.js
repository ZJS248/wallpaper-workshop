/**
 * 卡片右键菜单（对齐 WE 客户端的右键菜单）。
 *
 * 结构（与客户端一致）：
 *   订阅 / 添加到收藏
 *   ───────────
 *   在创意工坊中打开
 *   相关壁纸 ▸
 *   报告和阻止 ▸   （红色）
 *   ───────────
 *   查看 ▸
 *
 * 组件只负责"长什么样、点到了哪一项"（emit('action', key)），
 * 具体动作全部交给 app.js —— 因为订阅/收藏的状态与请求都在那边。
 */
Vue.component('context-menu', {
  props: {
    open: { type: Boolean, default: false },
    x: { type: Number, default: 0 },
    y: { type: Number, default: 0 },
    item: { type: Object, default: null },
    subscribed: { type: Boolean, default: false },
    favorited: { type: Boolean, default: false },
    /** 这个作品是不是当前桌面正在用的（WE 的"使用中"） */
    current: { type: Boolean, default: false },
    /** 本机是否具备"设为使用中"的条件（找到 WE + 本地库） */
    canApply: { type: Boolean, default: false },
    busy: { type: Boolean, default: false },
    creatorBlocked: { type: Boolean, default: false },
  },
  data() {
    return { sub: '', pos: { left: 0, top: 0 }, flipSub: false };
  },
  computed: {
    entries() {
      const it = this.item || {};
      const hasId = !!it.id;
      return [
        {
          key: 'sub', icon: '⤓', label: this.subscribed ? '取消订阅' : '订阅',
          disabled: !hasId || this.busy,
        },
        {
          key: 'fav', icon: this.favorited ? '♥' : '♡',
          label: this.favorited ? '取消收藏' : '添加到收藏',
          disabled: !hasId || this.busy,
        },
        {
          key: 'apply', icon: '▶',
          label: this.current
            ? '当前使用中（重新应用）'
            : (this.canApply ? '设为使用中' : '设为使用中（需先订阅并下载）'),
          disabled: !hasId || this.busy || !this.canApply,
        },
        { sep: true },
        { key: 'workshop', icon: '🌐', label: '在创意工坊中打开', disabled: !hasId },
        {
          key: 'related', label: '相关壁纸', submenu: [
            { key: 'author-all', label: '该作者的全部作品', disabled: !it.creator },
            { key: 'author-steam', label: '在 Steam 里打开该作者的创意工坊', disabled: !it.creator },
            { key: 'same-res', label: it.resolution ? ('只看 ' + tagLabel(it.resolution)) : '只看这个分辨率', disabled: !it.resolution },
            { key: 'detail', label: '在右侧打开详情', disabled: !hasId },
          ],
        },
        {
          key: 'block', label: '报告和阻止', danger: true, submenu: [
            { key: 'report', label: '在 Steam 中举报这个作品', disabled: !hasId },
            {
              key: 'block-author',
              label: this.creatorBlocked ? '取消屏蔽该作者' : '屏蔽该作者（本地隐藏）',
              danger: !this.creatorBlocked,
              disabled: !it.creator,
            },
            { key: 'copy-id', label: '复制作品 ID', disabled: !hasId },
          ],
        },
        { sep: true },
        {
          key: 'view', label: '查看', submenu: [
            { key: 'detail', label: '在右侧打开详情', disabled: !hasId },
            { key: 'copy-link', label: '复制作品链接', disabled: !hasId },
            { key: 'steam-page', label: '在浏览器里打开 Steam 页面', disabled: !hasId },
          ],
        },
      ];
    },
  },
  watch: {
    open(v) {
      if (v) {
        this.sub = '';
        this.$nextTick(this.place);
        document.addEventListener('mousedown', this.onDocDown, true);
        document.addEventListener('keydown', this.onKey);
        window.addEventListener('scroll', this.closeNow, true);
        window.addEventListener('resize', this.closeNow);
      } else {
        document.removeEventListener('mousedown', this.onDocDown, true);
        document.removeEventListener('keydown', this.onKey);
        window.removeEventListener('scroll', this.closeNow, true);
        window.removeEventListener('resize', this.closeNow);
      }
    },
  },
  beforeDestroy() {
    document.removeEventListener('mousedown', this.onDocDown, true);
    document.removeEventListener('keydown', this.onKey);
    window.removeEventListener('scroll', this.closeNow, true);
    window.removeEventListener('resize', this.closeNow);
  },
  methods: {
    /** 贴边收进去：菜单不能被窗口右边/下边切掉 */
    place() {
      const el = this.$el;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const pad = 6;
      const left = Math.max(pad, Math.min(this.x, window.innerWidth - r.width - pad));
      const top = Math.max(pad, Math.min(this.y, window.innerHeight - r.height - pad));
      this.pos = { left: left, top: top };
      // 子菜单默认向右展开；右边放不下就翻到左边
      this.flipSub = left + r.width + 190 > window.innerWidth;
    },
    onDocDown(e) {
      if (this.$el && !this.$el.contains(e.target)) this.$emit('close');
    },
    onKey(e) {
      if (e.key === 'Escape') this.$emit('close');
    },
    closeNow() {
      this.$emit('close');
    },
    onRow(entry) {
      if (entry.sep || entry.disabled) return;
      if (entry.submenu) {
        this.sub = this.sub === entry.key ? '' : entry.key;
        return;
      }
      this.$emit('action', entry.key);
    },
    onSub(sub) {
      if (sub.disabled) return;
      this.$emit('action', sub.key);
    },
    openSub(key) {
      this.sub = key;
    },
    closeSub() {
      this.sub = '';
    },
  },
  template: `
    <transition name="cmenu">
      <div v-if="open" class="cmenu" :style="{ left: pos.left + 'px', top: pos.top + 'px' }"
           @contextmenu.prevent>
        <template v-for="(e, i) in entries">
          <div v-if="e.sep" :key="'s' + i" class="cmenu-sep"></div>
          <div v-else :key="e.key + i" class="cmenu-row"
               :class="{ danger: e.danger, disabled: e.disabled, on: sub === e.key }"
               @click="onRow(e)" @mouseenter="e.submenu ? openSub(e.key) : closeSub()">
            <span class="cmenu-ico">{{ e.icon || '' }}</span>
            <span class="cmenu-label">{{ e.label }}</span>
            <span v-if="e.submenu" class="cmenu-arrow">›</span>
            <div v-if="e.submenu && sub === e.key" class="cmenu-sub"
                 :class="{ flip: flipSub }">
              <div v-for="(s, j) in e.submenu" :key="s.key + j" class="cmenu-row"
                   :class="{ danger: s.danger, disabled: s.disabled }" @click.stop="onSub(s)">
                <span class="cmenu-label">{{ s.label }}</span>
              </div>
            </div>
          </div>
        </template>
      </div>
    </transition>
  `,
});
