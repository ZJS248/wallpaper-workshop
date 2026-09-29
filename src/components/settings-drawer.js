/**
 * 设置 / 登录抽屉。
 *
 * 结构：4 个分区的手风琴，**一次只展开一个**，每个分区头部右侧直接显示状态药丸 ——
 * 不展开也能一眼看完全部状态（已登录 / DNS 正常 / 已开机自启）。
 *
 *   账号  — 登录态、Steam 凭证、持久化
 *   网络  — 代理与 DNS 健康
 *   桌面  — 开机自启、托盘、数据目录（浏览器访问时整段隐藏）
 *   高级  — 原始 DNS 解析、父项目探测路径、事件日志
 *
 * 原来 6 个区块纵向堆叠、每段都带大段说明；现在常驻文字压到一行，
 * 解释性内容放到 title / 「高级」里。
 *
 * 打开时展开哪个分区会被记住（localStorage），下次直接落回原处。
 *
 * 独立运行时靠「账号」登录（粘贴 Cookie）；接入父项目后可一键取登录态。
 */

/** 记住上次展开的分区 */
const LAST_SECTION_KEY = 'ww.settings.section';

Vue.component('settings-drawer', {
  props: {
    open: { type: Boolean, default: false },
    /** 从外部指定要展开哪个分区（顶栏的登录药丸点「设置」时用） */
    section: { type: String, default: '' },
    status: { type: Object, default: null },
    session: { type: Object, default: null },
    host: { type: Object, default: null },
  },
  data() {
    return {
      cookie: '',
      apiKey: '',
      /**
       * 是否把 Cookie 落盘（config/settings.json）。
       * 默认**开**：只放内存的话服务一重启就得重新粘一次，体感就是"老是退出登录"。
       */
      persist: true,
      busy: false,
      message: '',
      messageType: 'info',
      events: [],
      showCookie: false,
      /** 桌面壳（Electron）信息；浏览器里访问时 window.WWDesktop 不存在 */
      desktopInfo: null,
      autoLaunch: false,
      desktopBusy: false,
      /** 一次只展开一个分区 */
      openKey: '',
    };
  },
  computed: {
    isDesktop() {
      return !!(typeof window !== 'undefined' && window.WWDesktop);
    },
    desktopVersion() {
      const v = this.desktopInfo && this.desktopInfo.versions;
      return (v && v.electron) || '—';
    },
    desktopPort() {
      return (this.desktopInfo && this.desktopInfo.port) || '—';
    },
    /** 可见分区（浏览器里没有「桌面」） */
    sections() {
      const list = [
        { key: 'account', title: '账号' },
        { key: 'network', title: '网络' },
        { key: 'desktop', title: '桌面' },
        { key: 'advanced', title: '高级' },
      ];
      return this.isDesktop ? list : list.filter((s) => s.key !== 'desktop');
    },
    /** 账号分区的状态药丸 */
    accountPill() {
      const s = this.session;
      if (!s || !s.hasCookie) return { text: '未登录', kind: 'neutral' };
      if (s.invalid) return { text: '已失效', kind: 'error' };
      return { text: '已登录', kind: 'ok' };
    },
    /** 网络分区：DNS 污染是最需要被一眼看到的问题 */
    networkPill() {
      const st = this.status;
      if (!st) return { text: '检测中', kind: 'neutral' };
      if (st.dns && st.dns.poisoned) return { text: 'DNS 异常', kind: 'error' };
      if (st.proxy) return { text: '走代理', kind: 'ok' };
      return { text: '正常', kind: 'ok' };
    },
    desktopPill() {
      return this.autoLaunch
        ? { text: '开机自启已开', kind: 'ok' }
        : { text: '开机自启已关', kind: 'neutral' };
    },
    srcLabel() {
      const s = this.session || {};
      return s.sourceLabel || '—';
    },
    persistedText() {
      const s = this.session || {};
      return s.persisted ? '已保存到磁盘' : '仅保存在内存';
    },
    expiresText() {
      if (!this.session || !this.session.expiresAt) return '未知';
      const ms = this.session.expiresInMs;
      if (ms <= 0) return '已过期';
      return humanRemain(ms) + '后过期';
    },
    ipWarning() {
      if (!this.session || !this.session.ipSubject) return '';
      return '这个登录态由 IP ' + this.session.ipSubject + ' 签发。' +
        '如果后端出口 IP 与它不一致，Steam 会拒绝订阅和收藏。';
    },
    ipTitle() {
      return 'Steam 会校验登录态的签发 IP。如果后端出口 IP 与它不一致（例如浏览器直连、' +
        '后端走代理），写操作会被拒绝（HTTP 401）。把浏览器里正在用的 Cookie 直接粘贴进来即可解决。';
    },
  },
  watch: {
    open(v) {
      if (v) {
        this.message = '';
        this.openKey = this.pickSection();
        this.$nextTick(() => {
          const el = this.$refs.panel;
          if (el) el.focus();
        });
        this.refreshDesktop();
        this.loadEvents();
        // 打开时顺手做一次真实校验，避免"看起来登录了其实早就失效"
        this.verify(true);
        document.addEventListener('keydown', this.onKey, true);
      } else {
        document.removeEventListener('keydown', this.onKey, true);
      }
    },
    /** 顶栏的登录药丸点了之后要能直接落到「账号」分区 */
    section(v) {
      if (this.open && v) this.openKey = v;
    },
  },
  beforeDestroy() {
    document.removeEventListener('keydown', this.onKey, true);
  },
  methods: {
    humanRemain,
    onKey(e) {
      if (e.key === 'Escape') this.$emit('close');
    },
    /**
     * 打开时展开哪个分区。
     * 优先用外部指定的（顶栏的登录药丸点了要直接落到「账号」），
     * 否则用**上次展开的那个**（localStorage），都没有就用「账号」。
     *
     * 之前这里是"没登录→账号，否则→网络"，等于每次打开都落到一个跟用户诉求
     * 无关的分区（用户反馈"为什么不应该是登录吗"）。
     */
    pickSection() {
      if (this.section && this.sections.some((s) => s.key === this.section)) return this.section;
      return this.lastSection();
    },
    toggle(key) {
      this.openKey = this.openKey === key ? '' : key;
      // 记住上次展开的是哪个，下次打开设置直接落回那里
      try {
        window.localStorage.setItem(LAST_SECTION_KEY, this.openKey || 'account');
      } catch (e) {
        /* 隐私模式写不进去就算了 */
      }
    },
    isOpen(key) {
      return this.openKey === key;
    },
    /** 读回上次展开的分区（没有记录就用「账号」） */
    lastSection() {
      try {
        const v = window.localStorage.getItem(LAST_SECTION_KEY);
        if (v && this.sections.some((s) => s.key === v)) return v;
      } catch (e) {
        /* 忽略 */
      }
      return 'account';
    },
    /** 读桌面壳状态（自启动开关 + 版本 + 端口） */
    async refreshDesktop() {
      if (!this.isDesktop) return;
      try {
        this.desktopInfo = await window.WWDesktop.info();
        this.autoLaunch = await window.WWDesktop.getAutoLaunch();
      } catch (e) {
        /* 桌面接口不可用就当普通浏览器 */
      }
    },
    async setAutoLaunch(on) {
      if (!this.isDesktop) return;
      this.desktopBusy = true;
      try {
        this.autoLaunch = await window.WWDesktop.setAutoLaunch(on);
        this.say(this.autoLaunch ? '已开启开机自启动' : '已关闭开机自启动', 'ok');
      } catch (e) {
        this.say('设置开机自启动失败：' + e.message, 'error');
      } finally {
        this.desktopBusy = false;
      }
    },
    async hideToTray() {
      if (!this.isDesktop) return;
      this.$emit('close');
      await window.WWDesktop.hideToTray();
    },
    async openDataDir() {
      if (!this.isDesktop) return;
      await window.WWDesktop.openDataDir();
    },
    async loadEvents() {
      try {
        const r = await api.sessionEvents();
        this.events = (r.events || []).slice(0, 12);
      } catch (e) {
        /* 忽略 */
      }
    },
    say(text, type) {
      this.message = text;
      this.messageType = type || 'info';
    },
    async save() {
      if (!this.cookie.trim() && !this.apiKey.trim()) {
        this.say('请先粘贴 Steam Cookie 或填写 API key', 'warn');
        return;
      }
      this.busy = true;
      try {
        await api.setSession({ cookie: this.cookie.trim(), apiKey: this.apiKey.trim(), persist: this.persist });
        this.say('已保存，正在校验…', 'info');
        this.$emit('changed');
        await this.verify(false);
      } catch (e) {
        this.say('保存失败：' + e.message, 'error');
      } finally {
        this.busy = false;
      }
    },
    async verify(silent) {
      this.busy = true;
      try {
        // 手动点"校验"就是要真校验（不要用后端的 3 分钟缓存）
        const r = await api.verifySession(true);
        if (r.loggedIn) this.say('登录态有效 ✓　SteamID ' + (r.steamId || '—'), 'ok');
        else if (!silent) this.say('登录态无效：' + (r.reason || '未知原因'), 'error');
        this.$emit('changed');
      } catch (e) {
        if (!silent) this.say('校验失败：' + e.message, 'error');
      } finally {
        this.busy = false;
      }
    },
    async pullParent() {
      this.busy = true;
      try {
        const r = await api.pullParent();
        if (r.ok) {
          this.say('已从父项目后端取得登录态（' + r.length + ' 字节）', 'ok');
          this.$emit('changed');
          await this.verify(false);
        } else {
          this.say('取不到：' + r.reason, 'warn');
        }
      } catch (e) {
        this.say('取不到：' + e.message, 'error');
      } finally {
        this.busy = false;
      }
    },
    async askParent() {
      const r = await requestParentCookie(2500);
      if (r.ok) {
        this.cookie = r.cookie;
        this.say('已拿到 Cookie，点「保存并校验」应用它', 'ok');
      } else {
        this.say('父页面没有返回登录态：' + r.reason, 'warn');
      }
    },
    async clear() {
      this.busy = true;
      try {
        await api.clearSession();
        this.cookie = '';
        this.apiKey = '';
        this.say('已清除登录态（浏览和搜索不受影响）', 'info');
        this.$emit('changed');
      } catch (e) {
        this.say('清除失败：' + e.message, 'error');
      } finally {
        this.busy = false;
      }
    },
  },
  template: `
    <div class="drawer-mask" v-if="open" @click.self="$emit('close')">
      <div class="drawer" role="dialog" aria-modal="true" aria-label="设置" tabindex="-1" ref="panel">
        <div class="drawer-head">
          设置
          <button class="btn icon" title="关闭" aria-label="关闭设置" @click="$emit('close')">
            <svg class="ic"><use href="#i-x"></use></svg>
          </button>
        </div>

        <div class="drawer-body">
          <div v-if="message" class="msg drawer-msg" :class="messageType">{{ message }}</div>

          <!-- ==================== 账号 ==================== -->
          <div class="acc">
            <button class="acc-head" :aria-expanded="String(isOpen('account'))" @click="toggle('account')">
              <svg class="ic caret" :class="{ collapsed: !isOpen('account') }"><use href="#i-chev-down"></use></svg>
              <span class="acc-title">账号</span>
              <span class="pill" :class="accountPill.kind">{{ accountPill.text }}</span>
            </button>
            <div class="acc-body" v-show="isOpen('account')">
              <table class="kv">
                <tr v-if="session && session.steamId"><td>SteamID</td><td>{{ session.steamId }}</td></tr>
                <tr v-if="session && session.hasCookie"><td>有效期</td><td>{{ expiresText }}</td></tr>
                <tr><td>来源</td><td>{{ srcLabel }}</td></tr>
                <tr><td>存储</td><td>{{ persistedText }}</td></tr>
              </table>
              <div class="hint warn" v-if="session && session.hasCookie && session.ipSubject" :title="ipTitle">
                {{ ipWarning }}
              </div>
              <div class="hint">
                浏览、搜索、筛选、排序、详情都<b>不需要登录</b>；只有<b>订阅、收藏、评价</b>需要。
              </div>

              <div class="btn-row" v-if="host && host.embedded">
                <button class="btn" :disabled="busy" @click="pullParent">从父项目后端取登录态</button>
                <button class="btn" :disabled="busy" @click="askParent">向父页面索取</button>
              </div>

              <div style="margin-top:12px">
                <label class="field">
                  <span class="field-label">Steam Cookie</span>
                  <textarea v-model="cookie" rows="4" spellcheck="false"
                            :placeholder="showCookie ? 'sessionid=…; steamLoginSecure=…' : '粘贴 steamcommunity.com 的 Cookie'"
                            @focus="showCookie = true"></textarea>
                  <span class="field-note">浏览器登录 steamcommunity.com → F12 → Network → 任意请求 → 复制 Cookie 请求头。需要含 sessionid 与 steamLoginSecure。</span>
                </label>
                <label class="fitem" style="margin:0 0 10px">
                  <input type="checkbox" v-model="showCookie">
                  <span class="box"></span><span class="fitem-text">明文显示</span>
                </label>
                <label class="field">
                  <span class="field-label">Steam Web API key<span class="dim"> · 可选</span></span>
                  <input v-model="apiKey" type="text" placeholder="留空则部分作者名显示为 steamID64">
                  <span class="field-note">用于把作者的 steamID 换成昵称，以及列出资料设为私密的用户。在 steamcommunity.com/dev/apikey 免费申请。</span>
                </label>
                <label class="fitem" style="margin:4px 0 0">
                  <input type="checkbox" v-model="persist">
                  <span class="box"></span>
                  <span class="fitem-text">记住登录状态</span>
                </label>
                <div class="field-note" style="margin-left:24px">存到配置文件，服务重启后仍有效；不勾只放内存，重启即失效。</div>

                <div class="btn-row">
                  <button class="btn primary" :disabled="busy" @click="save">保存并校验</button>
                  <button class="btn" :disabled="busy" @click="verify(false)">重新校验</button>
                  <button class="btn danger" :disabled="busy" @click="clear">清除登录态</button>
                </div>
              </div>
            </div>
          </div>

          <!-- ==================== 网络 ==================== -->
          <div class="acc">
            <button class="acc-head" :aria-expanded="String(isOpen('network'))" @click="toggle('network')">
              <svg class="ic caret" :class="{ collapsed: !isOpen('network') }"><use href="#i-chev-down"></use></svg>
              <span class="acc-title">网络</span>
              <span class="pill" :class="networkPill.kind">{{ networkPill.text }}</span>
            </button>
            <div class="acc-body" v-show="isOpen('network')">
              <table class="kv">
                <tr><td>出口</td><td>{{ (status && status.proxy) || '直连' }}</td></tr>
                <tr><td>DNS</td><td>
                  <span v-if="status && status.dns && status.dns.poisoned" class="pill error">检测到污染</span>
                  <span v-else class="pill ok">正常</span>
                </td></tr>
              </table>
              <div class="hint" v-if="status && status.dns && status.dns.poisoned">
                系统 DNS 把 steamcommunity.com 解析到了无关地址。程序已自动改用 DoH 解析，一般无需处理。
              </div>
            </div>
          </div>

          <!-- ==================== 桌面 ==================== -->
          <div class="acc" v-if="isDesktop">
            <button class="acc-head" :aria-expanded="String(isOpen('desktop'))" @click="toggle('desktop')">
              <svg class="ic caret" :class="{ collapsed: !isOpen('desktop') }"><use href="#i-chev-down"></use></svg>
              <span class="acc-title">桌面</span>
              <span class="pill" :class="desktopPill.kind">{{ desktopPill.text }}</span>
            </button>
            <div class="acc-body" v-show="isOpen('desktop')">
              <label class="fitem" style="margin:0 0 8px">
                <input type="checkbox" :checked="autoLaunch" :disabled="desktopBusy"
                       @change="setAutoLaunch($event.target.checked)">
                <span class="box"></span>
                <span class="fitem-text">开机自动启动（登录后静默驻留托盘）</span>
              </label>
              <div class="btn-row">
                <button class="btn" @click="hideToTray">收进托盘</button>
                <button class="btn" @click="openDataDir">打开数据目录</button>
              </div>
              <div class="hint">
                点窗口的关闭按钮只是收进托盘，不会退出；在托盘图标右键里才能真正退出。
              </div>
              <table class="kv" style="margin-top:8px">
                <tr><td>运行方式</td><td>桌面应用（Electron {{ desktopVersion }}）</td></tr>
                <tr><td>本地端口</td><td>{{ desktopPort }}</td></tr>
              </table>
            </div>
          </div>

          <!-- ==================== 高级 ==================== -->
          <div class="acc">
            <button class="acc-head" :aria-expanded="String(isOpen('advanced'))" @click="toggle('advanced')">
              <svg class="ic caret" :class="{ collapsed: !isOpen('advanced') }"><use href="#i-chev-down"></use></svg>
              <span class="acc-title">高级</span>
            </button>
            <div class="acc-body" v-show="isOpen('advanced')">
              <div class="section-head">宿主接入</div>
              <table class="kv">
                <tr><td>运行方式</td><td>{{ host && host.embedded ? host.kind : '独立运行' }}</td></tr>
                <tr><td>父项目</td><td class="ellipsis">{{ (status && status.parentDir) || '未探测到' }}</td></tr>
                <tr><td>父项目后端</td><td>{{ (status && status.parentApiBase) || '未探测到' }}</td></tr>
              </table>

              <div class="section-head" style="margin-top:12px">DNS 解析明细</div>
              <table class="kv" v-if="status && status.dns">
                <tr><td>系统</td><td class="dim">{{ (status.dns.system || []).join(', ') || '—' }}</td></tr>
                <tr><td>DoH</td><td class="dim">{{ (status.dns.doh || []).join(', ') || '—' }}</td></tr>
              </table>

              <div v-if="events.length">
                <div class="section-head" style="margin-top:12px">最近事件</div>
                <div class="events">
                  <div v-for="e in events" :key="e.at + e.type" class="event">
                    <span class="dim">{{ new Date(e.at).toLocaleTimeString('zh-CN') }}</span>
                    <b>{{ e.type }}</b> {{ e.detail }}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `,
});
