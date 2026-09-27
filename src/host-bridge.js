/**
 * 宿主接入桥（iframe 为主，qiankun 生命周期钩子为辅）。
 *
 * ────────────────────────────────────────────────────────────────
 * 一、iframe 方式（**推荐**，也是父项目现在就能用的方式）
 *
 *   父页面：
 *     <iframe src="http://127.0.0.1:9391/" id="ww"></iframe>
 *
 *     // 1) 子页面加载后会来问登录态；
 *     //    父页面把当前浏览器的 Steam Cookie 交给它（不解 HttpOnly，只传普通 Cookie 串）
 *     window.addEventListener('message', (e) => {
 *       if (e.data && e.data.type === 'wallpaper-workshop:hello') {
 *         e.source.postMessage({
 *           type: 'wallpaper-workshop:session',
 *           cookie: 我的SteamCookie串,        // 必填
 *           steamId: '76561198...',         // 可选
 *           refreshToken: '',               // 可选
 *         }, '*');
 *       }
 *     });
 *
 *     // 2) 可选：监听子页面的状态变化
 *     window.addEventListener('message', (e) => {
 *       if (e.data && e.data.type === 'wallpaper-workshop:state') console.log(e.data);
 *     });
 *
 *     // 3) 可选：命令子页面
 *     iframe.contentWindow.postMessage({ type: 'wallpaper-workshop:command', command: 'search', value: '初音' }, '*');
 *
 *   为什么走"父子传 Cookie"而不是让后端读父项目文件：
 *    - Steam 的登录态校验**绑定签发时的出口 IP**（见 JWT 里的 ip_subject）。
 *      父项目文件里存的是"上次登录时"的 Cookie，如果那次的出口 IP 与现在不同，
 *      写操作会被 Steam 拒绝（HTTP 401）。而**浏览器里正在用的 Cookie 一定是当前有效的**。
 *    - 所以直接取浏览器里的那份，最稳。
 *
 * ────────────────────────────────────────────────────────────────
 * 二、qiankun 方式（预留钩子，需要父项目配合改造）
 *
 *   本项目**没有构建步骤**（脚本用绝对路径 /src/*.js 加载），所以不适合直接当
 *   qiankun 子应用（qiankun 要求子应用资源能被 publicPath 重写）。
 *   真要用 qiankun，两条路：
 *     A) 用 iframe 容器包一层（qiankun 官方也支持），本项目不用改；
 *     B) 给本项目加一层打包（Vite）并把资源路径改成相对路径 + 注入运行时 publicPath。
 *   这里先把 qiankun 的 bootstrap/mount/unmount 钩子挂好，
 *   父项目无论走哪条路都不会因为"找不到生命周期"而报错。
 */

(function (global) {
  'use strict';

  const HELLO = 'wallpaper-workshop:hello';
  const SESSION = 'wallpaper-workshop:session';
  const STATE = 'wallpaper-workshop:state';
  const COMMAND = 'wallpaper-workshop:command';

  let mounted = false;
  let lastSessionAt = 0;

  /** 宿主信息 */
  function host() {
    return global.WW && global.WW.detectHost ? global.WW.detectHost() : { embedded: false, kind: 'standalone' };
  }

  /**
   * 监听宿主推来的登录态，并主动问一次。
   * @param {object} vm Vue 实例（提供 setSession 的能力由调用方通过 onSession 回调注入）
   * @param {object} handlers { onSession(session), onCommand(command) }
   */
  function attach(handlers) {
    const h = handlers || {};

    global.addEventListener('message', function (ev) {
      const d = ev && ev.data;
      if (!d || typeof d !== 'object') return;

      if (d.type === SESSION || d.type === 'steam-cookie' || d.type === 'session') {
        const cookie = d.cookie || d.steamCookies || '';
        if (!cookie) return;
        lastSessionAt = Date.now();
        if (h.onSession) {
          h.onSession({
            cookie: cookie,
            steamId: d.steamId || '',
            refreshToken: d.refreshToken || '',
            source: 'parent-message',
          });
        }
        return;
      }

      if (d.type === COMMAND && h.onCommand) {
        h.onCommand(d.command, d.value);
      }
    });

    // 主动问一次（父页面可能没意识到我们在等）
    const info = host();
    if (info.embedded) {
      try {
        info.parent.postMessage({ type: HELLO, need: ['steamCookie'], from: location.origin }, '*');
      } catch (e) {
        /* 跨域受限就等宿主自己推 */
      }
    }
  }

  /** 通知宿主状态变化 */
  function notify(payload) {
    const info = host();
    if (!info.embedded) return;
    try {
      info.parent.postMessage(Object.assign({ type: STATE }, payload), '*');
    } catch (e) {
      /* 忽略 */
    }
  }

  /** 宿主信息快照（设置页展示用） */
  function info() {
    const h = host();
    return {
      embedded: h.embedded,
      kind: h.kind,
      origin: location.origin,
      href: location.href,
      lastSessionAt: lastSessionAt,
      qiankun: !!global.__POWERED_BY_QIANKUN__,
    };
  }

  /* ---------------------- qiankun 生命周期钩子 ---------------------- */

  function bootstrap() {
    return Promise.resolve();
  }

  /**
   * qiankun mount：本项目是"自动挂载"的（app.js 里直接 new Vue({el:'#app'})），
   * 所以 mount 只做标记与唤醒，不重复创建实例。
   */
  function mount(props) {
    mounted = true;
    if (props && typeof props.onGlobalStateChange === 'function') {
      try {
        props.onGlobalStateChange(function (state) {
          if (state && (state.steamCookie || state.cookie)) {
            const cookie = state.steamCookie || state.cookie;
            global.dispatchEvent(new MessageEvent('message', { data: { type: SESSION, cookie: cookie } }));
          }
        }, true);
      } catch (e) {
        /* 忽略 */
      }
    }
    // qiankun 下 DOM 容器不是 #app，交给宿主把 innerHTML 塞进容器后再由 app.js 挂载；
    // 这里只负责把状态标记好，供 app.js 读取。
    global.__WW_MOUNTED__ = true;
    return Promise.resolve();
  }

  function unmount() {
    mounted = false;
    return Promise.resolve();
  }

  function update() {
    return Promise.resolve();
  }

  global.WWHost = { attach: attach, notify: notify, info: info, host: host };
  global.__WW_HOST__ = { bootstrap: bootstrap, mount: mount, unmount: unmount, update: update, mounted: function () { return mounted; } };
})(window);
