/**
 * 设置 / 登录抽屉。
 * 独立运行时靠它登录（粘贴 Cookie）；接入父项目后可以一键"从父项目取登录态"。
 */
Vue.component('settings-drawer', {
  props: {
    open: { type: Boolean, default: false },
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
       *
       * 默认**开**：只放内存的话，服务一重启（或我这边每次重启 dev server）就得重新粘一次，
       * 用户体感就是"老是退出登录"。勾上之后重启也不用再粘，直到 Steam 自己过期
       * （steamLoginSecure 的 JWT 本来就是 ~24 小时）。
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
    srcLabel() {
      const s = this.session || {};
      const where = s.persisted ? '已写入磁盘（重启不用重粘）' : '仅内存（服务重启就失效）';
      return (s.sourceLabel || '—') + '　' + where;
    },
    expiresText() {
      if (!this.session || !this.session.expiresAt) return '未知（Cookie 里没有可解析的 steamLoginSecure）';
      const ms = this.session.expiresInMs;
      if (ms <= 0) return '已过期（' + new Date(this.session.expiresAt).toLocaleString('zh-CN') + '）';
      return new Date(this.session.expiresAt).toLocaleString('zh-CN') + '（还剩 ' + humanRemain(ms) + '）';
    },
    ipWarning() {
      if (!this.session || !this.session.ipSubject) return '';
      return (
        '这个登录态由 IP ' + this.session.ipSubject + ' 签发。Steam 会校验签发 IP，' +
        '如果后端出口 IP 与它不一致（例如浏览器直连、后端走代理），订阅类操作会被 Steam 拒绝（HTTP 401）。' +
        '把浏览器的 Cookie 直接粘贴进来即可解决。'
      );
    },
  },
  watch: {
    open(v) {
      if (v) {
        this.message = '';
        this.refreshDesktop();
        this.loadEvents();
        // 打开时顺手做一次真实校验，避免"看起来登录了其实早就失效"
        this.verify(true);
      }
    },
  },
  methods: {
    humanRemain,
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
        this.say(this.autoLaunch ? '已开启开机自启动（登录后静默驻留托盘）' : '已关闭开机自启动', 'ok');
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
        this.say('已从父页面拿到 Cookie，点「保存并校验」应用它', 'ok');
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
        this.say('已清除运行时登录态（浏览/搜索不受影响）', 'info');
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
      <div class="drawer">
        <div class="drawer-head">
          <span>设置</span>
          <button class="close" @click="$emit('close')">✕</button>
        </div>

        <div class="drawer-body">
          <div v-if="message" class="msg" :class="messageType">{{ message }}</div>

          <!-- 只有跑在桌面壳里才出现（浏览器访问时 window.WWDesktop 不存在） -->
          <section class="dsec" v-if="isDesktop">
            <h3>桌面应用</h3>
            <table class="kv">
              <tr><td>运行方式</td><td>桌面壳（Electron {{ desktopVersion }}）</td></tr>
              <tr><td>本地端口</td><td>{{ desktopPort }}</td></tr>
            </table>
            <label class="fitem" style="margin:8px 0">
              <input type="checkbox" :checked="autoLaunch" :disabled="desktopBusy"
                     @change="setAutoLaunch($event.target.checked)">
              <span class="box"></span>
              <span class="fitem-text">开机自启动（登录后静默驻留托盘）</span>
            </label>
            <div class="btn-row">
              <button class="fbtn" @click="hideToTray">收进托盘</button>
              <button class="fbtn" @click="openDataDir">打开数据目录</button>
            </div>
            <div class="hint">
              关闭窗口不会退出应用：它继续驻留托盘，托盘菜单里可以"打开创意工坊 / 退出"。
              开机自启动默认打开，首次运行后可以在上面这个勾选框或托盘右键里关掉。
            </div>
          </section>

          <section class="dsec">
            <h3>登录态</h3>
            <table class="kv">
              <tr><td>状态</td><td>
                <span v-if="session && session.hasCookie" class="pill ok">已登录</span>
                <span v-else class="pill warn">未登录</span>
                <span class="dim">　来源：{{ srcLabel }}</span>
              </td></tr>
              <tr v-if="session && session.steamId"><td>SteamID</td><td>{{ session.steamId }}</td></tr>
              <tr v-if="session && session.hasCookie"><td>有效期</td><td>{{ expiresText }}</td></tr>
              <tr><td>刷新令牌</td><td>{{ session && session.hasRefreshToken ? '有（可自动续期）' : '无' }}</td></tr>
            </table>
            <div v-if="session && session.hasCookie && session.ipSubject" class="hint warn">{{ ipWarning }}</div>
            <div class="hint">
              浏览、搜索、筛选、排序、详情（含评分与作者昵称）、相关壁纸<b>都不需要登录</b>；
              只有<b>订阅 / 取消订阅 / 收藏 / 点赞点踩</b>需要。
              登录态只放在后端内存里，不写磁盘、不入库。
            </div>
          </section>

          <section class="dsec">
            <h3>网络</h3>
            <table class="kv">
              <tr><td>代理</td><td>{{ (status && status.proxy) || '（直连）' }} <span class="dim">来源 {{ status && status.proxySource }}</span></td></tr>
              <tr><td>本机 DNS</td><td>
                <span v-if="status && status.dns && status.dns.poisoned" class="pill warn">检测到污染</span>
                <span v-else class="pill ok">正常</span>
              </td></tr>
              <tr v-if="status && status.dns"><td>steamcommunity.com</td><td class="dim">
                系统解析 {{ (status.dns.system || []).join(', ') || '—' }}<br>
                DoH 解析 {{ (status.dns.doh || []).join(', ') || '—' }}
              </td></tr>
              <tr><td>父项目</td><td>{{ (status && status.parentDir) || '未探测到' }}</td></tr>
              <tr><td>父项目后端</td><td>{{ (status && status.parentApiBase) || '未探测到' }}</td></tr>
            </table>
          </section>

          <section class="dsec">
            <h3>接入父项目</h3>
            <div class="hint">
              宿主页面：<b>{{ host && host.embedded ? host.kind : '独立运行' }}</b>
            </div>
            <div class="btn-row">
              <button class="fbtn" :disabled="busy" @click="pullParent">从父项目后端取登录态</button>
              <button class="fbtn" :disabled="busy || !(host && host.embedded)" @click="askParent">
                向父页面索取 Cookie
              </button>
            </div>
          </section>

          <section class="dsec">
            <h3>手动填写</h3>
            <label class="field">
              <span>Steam Cookie</span>
              <textarea v-model="cookie" :type="showCookie ? 'text' : 'password'"
                        rows="4" placeholder="从浏览器 F12 复制 steamcommunity.com 的 Cookie（需含 sessionid 与 steamLoginSecure）"></textarea>
            </label>
            <label class="fitem" style="margin:4px 0 10px">
              <input type="checkbox" v-model="showCookie">
              <span class="box"></span><span class="fitem-text">明文显示 Cookie</span>
            </label>
            <label class="field">
              <span>Steam Web API key（可选，仅用于把作者 steamID 换成昵称）</span>
              <input v-model="apiKey" type="text" placeholder="留空则作者名显示为 steamID64">
            </label>
            <label class="fitem" style="margin:8px 0">
              <input type="checkbox" v-model="persist">
              <span class="box"></span>
              <span class="fitem-text">
                写入 config/settings.json（<b>建议勾上</b>：勾了以后服务重启不用重新粘贴；
                不勾只放内存，重启即失效）
              </span>
            </label>
            <div class="btn-row">
              <button class="fbtn primary" :disabled="busy" @click="save">保存并校验</button>
              <button class="fbtn" :disabled="busy" @click="clear">清除登录态</button>
            </div>
          </section>

          <section class="dsec" v-if="events.length">
            <h3>最近事件</h3>
            <div class="events">
              <div v-for="e in events" :key="e.at + e.type" class="event">
                <span class="dim">{{ new Date(e.at).toLocaleTimeString('zh-CN') }}</span>
                <b>{{ e.type }}</b> {{ e.detail }}
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  `,
});
