/**
 * 左侧筛选器：对齐 WE 创意工坊截图的结构
 *   重置过滤器 / 筛选器设置 两个大按钮
 *   仅显示（快捷开关：隐藏成人内容）
 *   类型 / 年龄分级 / 分辨率 / 标签（可折叠分组，带全选·无）
 *
 * 原来的「只看已订阅」已移除：它是**纯前端过滤当前页**（测试报告 BUG-06，
 * 浏览态勾上后永远是空的），而"只看已订阅"本质上等于切到订阅列表 ——
 * 本项目的范围就是创意工坊列表，不做订阅/收藏列表视图。
 */

/** 可折叠分组 */
Vue.component('filter-group', {
  props: {
    title: { type: String, required: true },
    selected: { type: Array, default: () => [] },
    all: { type: Array, default: () => [] },
    collapsedDefault: { type: Boolean, default: false },
    icon: { type: String, default: '▸' },
    /**
     * 可选的二级分组（分辨率用）：[{ label: '宽屏', tags: [...] }, …]
     * 只是显示分组，选中集仍然是整个组（组内 OR）——与客户端的
     * "宽屏/超宽屏/双显示器/…"一致，每个子组还带自己的 全部/无。
     */
    subgroups: { type: Array, default: null },
    /** 是否在中文名后面带上英文原名（分辨率不需要，分组标题已说明） */
    showRaw: { type: Boolean, default: true },
  },
  data() {
    return {
      collapsed: this.collapsedDefault,
      keyword: '',
      /**
       * 本地选中集。
       *
       * 为什么不能直接用 prop 做"加一个/减一个"：v-model 是单向数据流，
       * 父组件的更新要等下一个 tick 才回来。用户在一帧里连点 6 个复选框时，
       * 每次事件读到的 this.selected 都还是**同一个旧快照**，
       * 于是 6 次"加一个"互相覆盖，最终只有最后一个生效
       * —— 表现就是"勾了 6 个分辨率，实际只筛了 1 个"（真实踩过）。
       * 所以本地维护一份，点一下立刻改本地并整体 emit。
       */
      local: (this.selected || []).slice(),
    };
  },
  watch: {
    selected(v) {
      // 父级的权威状态变了（重置、点详情标签、URL 恢复…）就同步本地
      const next = (v || []).slice();
      if (next.join('\u0000') !== this.local.join('\u0000')) this.local = next;
    },
  },
  computed: {
    /**
     * 按关键字过滤后的分组列表。有 subgroups 时按子组切；否则整组当成一个匿名子组，
     * 渲染时不会输出子组标题。
     */
    visibleGroups() {
      const src = this.subgroups && this.subgroups.length ? this.subgroups : [{ label: '', tags: this.all }];
      const k = (this.keyword || '').toLowerCase();
      return src
        .map((sg) => {
          const tags = (sg.tags || []).filter(
            (t) => !k || t.toLowerCase().includes(k) || String(tagLabel(t)).toLowerCase().includes(k)
          );
          return {
            label: sg.label || '',
            tags: tags,
            selCount: tags.filter((t) => this.local.indexOf(t) >= 0).length,
          };
        })
        .filter((sg) => sg.tags.length);
    },
    allSelected() {
      return this.all.length > 0 && this.local.length === this.all.length;
    },
  },
  methods: {
    toggle(tag) {
      const next = this.local.slice();
      const i = next.indexOf(tag);
      if (i >= 0) next.splice(i, 1);
      else next.push(tag);
      this.local = next;
      this.$emit('change', next);
    },
    selectAll() {
      this.local = this.all.slice();
      this.$emit('change', this.local);
    },
    selectNone() {
      this.local = [];
      this.$emit('change', []);
    },
    /** 子组的"全部"：把这些值并进当前选中集 */
    selectAllOf(tags) {
      const next = this.local.slice();
      (tags || []).forEach((t) => {
        if (next.indexOf(t) < 0) next.push(t);
      });
      this.local = next;
      this.$emit('change', next);
    },
    /** 子组的"无"：把这些值从选中集里摘掉 */
    selectNoneOf(tags) {
      const next = this.local.filter((t) => (tags || []).indexOf(t) < 0);
      this.local = next;
      this.$emit('change', next);
    },
    isOn(tag) {
      return this.local.indexOf(tag) >= 0;
    },
  },
  template: `
    <div class="fgroup">
      <div class="fgroup-head" @click="collapsed = !collapsed">
        <span class="caret" :class="{ collapsed: collapsed }">▾</span>
        <span class="fgroup-title">{{ title }}</span>
        <span v-if="local.length" class="fgroup-count">{{ local.length }}</span>
      </div>
      <div v-show="!collapsed" class="fgroup-body">
        <div class="fgroup-tools">
          <a @click="selectAll" :class="{ disabled: allSelected }">全部</a>
          <span class="sep">|</span>
          <a @click="selectNone" :class="{ disabled: !local.length }">清空</a>
          <input v-if="all.length > 12" v-model="keyword" class="fgroup-search" placeholder="过滤…" @click.stop>
        </div>
        <template v-for="(sg, si) in visibleGroups">
          <div v-if="sg.label" :key="'h' + si" class="fsub-head">
            <span class="fsub-title">{{ sg.label }}</span>
            <span v-if="sg.selCount" class="fsub-count">{{ sg.selCount }}</span>
            <a class="fsub-act" :class="{ disabled: sg.selCount === sg.tags.length }"
               @click.stop="selectAllOf(sg.tags)">全部</a>
            <a class="fsub-act" :class="{ disabled: !sg.selCount }"
               @click.stop="selectNoneOf(sg.tags)">无</a>
          </div>
          <label v-for="t in sg.tags" :key="t" class="fitem" :class="{ on: isOn(t) }">
            <input type="checkbox" :checked="isOn(t)" @change="toggle(t)">
            <span class="box"></span>
            <span class="fitem-text">{{ tagLabel(t) }}</span>
            <span v-if="showRaw && tagLabel(t) !== t" class="fitem-raw">{{ t }}</span>
          </label>
        </template>
        <div v-if="!visibleGroups.length" class="fgroup-empty">没有匹配项</div>
      </div>
    </div>
  `,
});

Vue.component('filter-panel', {
  props: {
    meta: { type: Object, default: null },
    value: { type: Object, required: true },
    loading: { type: Boolean, default: false },
  },
  computed: {
    groups() {
      return (this.meta && this.meta.groups) || [];
    },
    typeTags() {
      const g = this.groups.find((x) => x.key === 'type');
      return g ? g.tags : [];
    },
    ageTags() {
      const g = this.groups.find((x) => x.key === 'age');
      return g ? g.tags : [];
    },
    resTags() {
      const g = this.groups.find((x) => x.key === 'resolution');
      return g ? g.tags : [];
    },
    /** 分辨率的二级分组（宽屏 / 超宽屏 / 双显示器 / 三显示器 / 竖屏 / 其它） */
    resSubgroups() {
      const g = this.groups.find((x) => x.key === 'resolution');
      return (g && g.subgroups) || null;
    },
    contentTags() {
      const g = this.groups.find((x) => x.key === 'content');
      return g ? g.tags : [];
    },
    /** 特性（Steam 的 Miscellaneous：已通过 / 音频响应 / 可自定义 / 视频纹理 …） */
    featureTags() {
      const g = this.groups.find((x) => x.key === 'feature');
      return g ? g.tags : [];
    },
    /** 当前选中的标签（按类目分组）：{ type: [...], resolution: [...], ... } */
    tagGroups() {
      return this.value.tagGroups || {};
    },
    /** 某类目已选几个 */
    countOf() {
      const g = this.tagGroups;
      return (key) => (g[key] || []).length;
    },
    /** 全部已选（扁平，用于"已选标签"条） */
    allSelected() {
      const g = this.tagGroups;
      return Object.keys(g).reduce((acc, k) => acc.concat(g[k] || []), []);
    },
  },
  methods: {
    update(patch) {
      this.$emit('input', Object.assign({}, this.value, patch));
    },
    /** 某一个类目的选中集合变化 */
    setGroup(key, values) {
      const next = Object.assign({}, this.tagGroups);
      if (values && values.length) next[key] = values;
      else delete next[key];
      this.update({ tagGroups: next });
    },
    reset() {
      this.$emit('reset');
    },
  },
  template: `
    <aside class="filters">
      <button class="fbtn primary" @click="reset" :disabled="loading">
        <span class="fbtn-ico">↺</span> 重置过滤器
      </button>

      <div class="fpanel">
        <div class="fpanel-head"><span class="fbtn-ico">⚙</span> 筛选器设置</div>

        <div class="fgroup">
          <div class="fgroup-head static"><span class="fgroup-title">仅显示</span></div>
          <div class="fgroup-body">
            <label class="fitem" :class="{ on: value.hideMature }" title="Wallpaper Engine 客户端默认不展示成人内容，这里对齐">
              <input type="checkbox" :checked="!!value.hideMature" @change="update({ hideMature: !value.hideMature })">
              <span class="box"></span>
              <span class="fitem-text">隐藏成人内容（18+）</span>
            </label>
            <div class="fhint">
              同一类目里选多个 = <b>满足其中一个</b>（例如同时勾 2K 和 4K）；<br>
              不同类目之间 = <b>同时满足</b>（例如"场景"且"2K"）。
            </div>
          </div>
        </div>

        <filter-group title="类型" icon="🎬" :show-raw="false"
                      :all="typeTags" :selected="tagGroups.type || []"
                      @change="v => setGroup('type', v)"></filter-group>

        <filter-group title="年龄分级" icon="🔞" :show-raw="false"
                      :all="ageTags" :selected="tagGroups.age || []"
                      @change="v => setGroup('age', v)"></filter-group>

        <filter-group title="分辨率" icon="🖥"
                      :all="resTags" :subgroups="resSubgroups" :show-raw="false"
                      :selected="tagGroups.resolution || []"
                      @change="v => setGroup('resolution', v)"></filter-group>

        <filter-group title="标签" icon="🏷"
                      :all="contentTags" :selected="tagGroups.content || []"
                      @change="v => setGroup('content', v)"></filter-group>

        <filter-group v-if="featureTags.length" title="特性" icon="✨" :show-raw="false"
                      :all="featureTags" :selected="tagGroups.feature || []"
                      @change="v => setGroup('feature', v)"></filter-group>

        <div class="fgroup">
          <div class="fgroup-head static"><span class="fgroup-title">排除标签</span></div>
          <div class="fgroup-body">
            <div class="chips" v-if="(value.exclude || []).length">
              <span v-for="t in value.exclude" :key="t" class="chip" @click="update({ exclude: value.exclude.filter(x => x !== t) })">
                {{ tagLabel(t) }} ✕
              </span>
            </div>
            <select class="fselect" @change="e => { if (e.target.value) { update({ exclude: (value.exclude || []).concat([e.target.value]) }); e.target.value = ''; } }">
              <option value="">+ 添加排除标签</option>
              <option v-for="t in contentTags.concat(ageTags).concat(resTags)" :key="t" :value="t">{{ tagLabel(t) }}</option>
            </select>
          </div>
        </div>
      </div>

      <div class="fmeta" v-if="meta">
        标签来源：{{ meta.tagSource === 'steam' ? 'Steam 实时' : '内置表' }} · 共 {{ (meta.tags || []).length }} 个标签
      </div>
    </aside>
  `,
});
