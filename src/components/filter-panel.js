/**
 * 左侧筛选面板。
 *
 * 结构：头部（标题 + 问号说明 + 重置） → 已筛选条 → 可滚动的分组列表。
 * 分组仍是 类型 / 年龄分级 / 分辨率 / 标签 / 特性，每组可折叠、可搜索。
 *
 * 「隐藏成人内容」只在这里出现一次（原来工具条里还有一份重复的复选框）。
 * 「排除标签」用可搜索的弹层，替代原来 40+ 项的原生下拉。
 *
 * 原本常驻在面板里的 OR/AND 说明段落、筛选器设置表头、标签来源统计都是
 * 开发期信息或大段文字，收进 `?` 弹层或直接删掉。
 *
 * ⚠️ filter-group 的「本地选中集」实现（修 BUG：连点复选框互相覆盖）逐字保留。
 */

/** 可折叠分组 */
Vue.component('filter-group', {
  props: {
    title: { type: String, required: true },
    selected: { type: Array, default: () => [] },
    all: { type: Array, default: () => [] },
    collapsedDefault: { type: Boolean, default: false },
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
    /** 复选框行高 28px，超过一屏才需要"全部/清空/搜索"这排工具 */
    showTools() {
      return this.all.length > 8;
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
      this.$emit('change', this.local);
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
      <button class="fgroup-head" :aria-expanded="String(!collapsed)" @click="collapsed = !collapsed">
        <svg class="ic caret" :class="{ collapsed: collapsed }"><use href="#i-chev-down"></use></svg>
        <span class="fgroup-title">{{ title }}</span>
        <span v-if="local.length" class="fgroup-count">{{ local.length }}</span>
        <span v-if="local.length" class="fgroup-clear" @click.stop="selectNone">清除</span>
      </button>
      <div v-show="!collapsed" class="fgroup-body">
        <div class="fgroup-tools" v-if="showTools">
          <a @click="selectAll" :class="{ disabled: allSelected }">全选</a>
          <a @click="selectNone" :class="{ disabled: !local.length }">清空</a>
          <input v-model="keyword" class="fgroup-search" type="text" placeholder="筛选选项"
                 aria-label="在本组内搜索" @click.stop>
        </div>
        <template v-for="(sg, si) in visibleGroups">
          <div v-if="sg.label" :key="'h' + si" class="fsub-head">
            <span class="fsub-title">{{ sg.label }}</span>
            <span v-if="sg.selCount" class="fsub-count">{{ sg.selCount }}</span>
            <a class="fsub-act" :class="{ disabled: sg.selCount === sg.tags.length }"
               @click.stop="selectAllOf(sg.tags)">全选</a>
            <a class="fsub-act" :class="{ disabled: !sg.selCount }"
               @click.stop="selectNoneOf(sg.tags)">无</a>
          </div>
          <label v-for="t in sg.tags" :key="t" class="fitem" :class="{ on: isOn(t) }" :data-tag="t">
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
  data() {
    return { helpOpen: false, excludeOpen: false, excludeKey: '' };
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
    /** 参与查询的已选标签数（整组全选 = 不筛，不计入，和顶部 chips 的口径一致） */
    activeCount() {
      const g = this.tagGroups;
      let n = 0;
      Object.keys(g).forEach((k) => {
        const vals = g[k] || [];
        if (!vals.length) return;
        const def = this.groups.find((x) => x.key === k);
        const full = def && def.tags && vals.length >= def.tags.length &&
          def.tags.every((t) => vals.indexOf(t) >= 0);
        if (!full) n += vals.length;
      });
      return n + (this.value.exclude || []).length;
    },
    /** 排除标签弹层里可选项（已排除的不再重复出现） */
    excludeOptions() {
      const all = this.contentTags.concat(this.ageTags).concat(this.resTags);
      const cur = this.value.exclude || [];
      const k = (this.excludeKey || '').toLowerCase();
      return all.filter((t) => {
        if (cur.indexOf(t) >= 0) return false;
        if (!k) return true;
        return t.toLowerCase().includes(k) || String(tagLabel(t)).toLowerCase().includes(k);
      });
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
    addExclude(tag) {
      if (!tag) return;
      this.update({ exclude: (this.value.exclude || []).concat([tag]) });
      this.excludeKey = '';
    },
    removeExclude(tag) {
      this.update({ exclude: (this.value.exclude || []).filter((x) => x !== tag) });
    },
    reset() {
      this.$emit('reset');
    },
  },
  template: `
    <aside class="filters">
      <div class="filters-head">
        <h2 class="filters-title">筛选</h2>
        <button class="help-dot" :class="{ on: helpOpen }" title="筛选规则说明"
                aria-label="筛选规则说明" @click="helpOpen = !helpOpen">?</button>
        <button class="btn ghost sm" @click="reset" :disabled="loading">重置</button>
      </div>

      <div class="filter-help" v-if="helpOpen">
        同一类目里选多个 = <b>满足其中之一</b>（例如同时勾 2K 和 4K）；<br>
        不同类目之间 = <b>同时满足</b>（例如"场景"且"4K"）。
      </div>

      <button v-if="activeCount" class="filter-active" @click="reset">
        已筛选 {{ activeCount }} 项
        <svg class="ic tiny"><use href="#i-x"></use></svg>
      </button>

      <div class="filter-scroll">
        <!-- 仅显示：隐藏成人内容。工具条里原来还有一份重复的复选框，已去掉。 -->
        <div class="fgroup">
          <div class="fgroup-body">
            <label class="fitem" :class="{ on: value.hideMature }" title="不显示 18+ 分级的内容"
                   data-filter="hideMature">
              <input type="checkbox" :checked="!!value.hideMature" @change="update({ hideMature: !value.hideMature })">
              <span class="box"></span>
              <span class="fitem-text">隐藏成人内容</span>
            </label>
          </div>
        </div>

        <filter-group title="类型" :show-raw="false"
                      :all="typeTags" :selected="tagGroups.type || []"
                      @change="v => setGroup('type', v)"></filter-group>

        <filter-group title="年龄分级" :show-raw="false"
                      :all="ageTags" :selected="tagGroups.age || []"
                      @change="v => setGroup('age', v)"></filter-group>

        <filter-group title="分辨率"
                      :all="resTags" :subgroups="resSubgroups" :show-raw="false"
                      :selected="tagGroups.resolution || []"
                      @change="v => setGroup('resolution', v)"></filter-group>

        <filter-group title="标签"
                      :all="contentTags" :selected="tagGroups.content || []"
                      @change="v => setGroup('content', v)"></filter-group>

        <filter-group v-if="featureTags.length" title="特性" :show-raw="false"
                      :all="featureTags" :selected="tagGroups.feature || []"
                      @change="v => setGroup('feature', v)"></filter-group>

        <div class="fgroup">
          <div class="fgroup-head static">
            <svg class="ic caret" style="opacity:0"><use href="#i-chev-down"></use></svg>
            <span class="fgroup-title">排除</span>
            <span v-if="(value.exclude || []).length" class="fgroup-count">{{ value.exclude.length }}</span>
          </div>
          <div class="fgroup-body fselect-wrap">
            <div class="chips" v-if="(value.exclude || []).length">
              <span v-for="t in value.exclude" :key="t" class="chip muted" @click="removeExclude(t)">
                {{ tagLabel(t) }}<svg class="ic xs"><use href="#i-x"></use></svg>
              </span>
            </div>
            <button class="btn sm" style="width:100%;margin-top:6px" @click="excludeOpen = !excludeOpen">
              <svg class="ic"><use href="#i-plus"></use></svg>{{ excludeOpen ? '收起' : '添加排除项' }}
            </button>
            <div class="exclude-pop" v-if="excludeOpen">
              <input type="text" v-model="excludeKey" placeholder="搜索标签" aria-label="搜索要排除的标签"
                     @click.stop>
              <div class="exclude-list" @click.stop>
                <div v-for="t in excludeOptions" :key="t" class="exclude-opt" @click="addExclude(t)">
                  <span class="fitem-text">{{ tagLabel(t) }}</span>
                </div>
                <div v-if="!excludeOptions.length" class="fgroup-empty">没有匹配项</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </aside>
  `,
});
