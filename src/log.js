'use strict';
/**
 * 前端日志：把关键事件攒成小批，POST 到后端落盘。
 *
 * 为什么需要：用户报"翻到第 5 页突然卡住了"，但 `desktop.log` 里只有 Electron 的
 * 启动事件、接口日志只打在终端（打包成 exe 后看不见），于是"点了什么、哪一发请求
 * 慢、图片多久加载完、有没有 JS 报错"全都查不到，只能靠猜。这个模块补上这一段。
 *
 * 记录四类：
 *   act   用户操作（点了哪个按钮、翻到第几页）
 *   api   接口请求 → 返回的耗时与结果
 *   img   某一页的预览图全部加载完的耗时
 *   err   JS 报错 / Promise 未捕获异常
 *   stall 主线程卡顿（见下面的心跳检测）—— 专门用来抓"界面突然没反应"
 *
 * 原则：**日志绝不能影响主流程**。所有对外接口都 try/catch 包住，
 * 发送失败就丢弃，不重试、不阻塞、不抛错。
 */
(function (root) {
  var QUEUE = [];
  var FLUSH_MS = 1500;
  var MAX_QUEUE = 120;
  var timer = null;
  var sid = Math.random().toString(36).slice(2, 7); // 一次会话的短 id，便于把行归组

  function fmt(text) {
    return sid + ' ' + text;
  }

  function schedule() {
    if (timer) return;
    timer = setTimeout(flush, FLUSH_MS);
  }

  function flush() {
    timer = null;
    if (!QUEUE.length) return;
    var lines = QUEUE;
    QUEUE = [];
    try {
      // keepalive 让页面关闭时也尽量发出去
      fetch('/api/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lines: lines }),
        keepalive: true,
      }).catch(function () {
        /* 发不出去就算了，日志不能反过来拖累应用 */
      });
    } catch (e) {
      /* 同上 */
    }
  }

  function push(text) {
    try {
      QUEUE.push(fmt(text));
      // 报错不排队，立刻发（否则出错后页面可能就没了）
      if (text.indexOf('[err]') === 0 || text.indexOf('[stall]') === 0) {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        flush();
        return;
      }
      if (QUEUE.length >= MAX_QUEUE) {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        flush();
      } else {
        schedule();
      }
    } catch (e) {
      /* 同上 */
    }
  }

  var WLog = {
    /** 用户操作。detail 随意，会 JSON 化 */
    act: function (name, detail) {
      try {
        push('[act] ' + name + (detail === undefined ? '' : ' ' + short(detail)));
      } catch (e) {}
    },
    /** 接口耗时。ok=false 时带上原因 */
    api: function (url, ms, okFlag, note) {
      try {
        push('[api] ' + (okFlag ? 'ok  ' : 'FAIL') + ' ' + Math.round(ms) + 'ms  ' + url +
          (note ? '  ' + String(note).slice(0, 200) : ''));
      } catch (e) {}
    },
    /** 一页预览图全部加载完（或超时）的耗时 */
    img: function (page, total, loaded, ms, timedOut) {
      try {
        push('[img] page=' + page + ' ' + loaded + '/' + total + ' 张，用时 ' + Math.round(ms) + 'ms' +
          (timedOut ? '（超时，仍有未加载）' : ''));
      } catch (e) {}
    },
    /** JS 报错 */
    err: function (msg, stack) {
      try {
        push('[err] ' + String(msg).slice(0, 300) + (stack ? '  @ ' + String(stack).split('\n')[1] : ''));
      } catch (e) {}
    },
    info: function (text) {
      try {
        push('[info] ' + text);
      } catch (e) {}
    },
    /** 立即把队列发出去（页面要关了 / 要抓现场时用） */
    flush: flush,
  };

  function short(v) {
    try {
      var s = typeof v === 'string' ? v : JSON.stringify(v);
      return s.length > 200 ? s.slice(0, 200) + '…' : s;
    } catch (e) {
      return String(v);
    }
  }

  /* ---------------- 全局错误捕获 ---------------- */

  root.addEventListener('error', function (e) {
    // 资源加载失败（img/script）也会走这里，但没有 message，过滤掉免得刷屏
    if (!e || !e.message) return;
    WLog.err(e.message, e.error && e.error.stack);
  });

  root.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    WLog.err('未捕获的 Promise 异常: ' + ((r && (r.message || r)) || '未知'), r && r.stack);
  });

  /*
   * 主线程卡顿检测 —— 专门用来抓"界面突然没反应"。
   *
   * 原理：setInterval 的间隔是"最早"不是"恰好"。如果主线程被一段同步代码
   * （死循环、超大循环、巨型 JSON 解析）占住，回调就会**晚到**。
   * 晚到多少，就说明主线程被卡了多久。这是纯前端能拿到的最直接的"卡死"证据。
   * 阈值 400ms：正常渲染抖动不会到这个量级，到了就是真的卡。
   */
  (function watchStall() {
    var last = Date.now();
    var INTERVAL = 1000;
    setInterval(function () {
      var now = Date.now();
      var late = now - last - INTERVAL;
      last = now;
      if (late > 400) {
        WLog.info('[stall] 主线程卡了约 ' + Math.round(late) + 'ms');
      }
    }, INTERVAL);
  })();

  // 页面要关了，把剩下的日志尽量送出去
  root.addEventListener('pagehide', function () {
    WLog.flush();
  });

  root.WLog = WLog;
})(window);
