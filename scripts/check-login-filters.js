'use strict';
/**
 * 验证"我的订阅 / 我的收藏"过滤器是否真的生效，以及订阅/取消订阅接口的行为。
 *
 * 背景：本机保存的 Cookie 的 steamLoginSecure JWT 绑定在另一个 IP 上
 * （见 JWT 的 ip_subject），Steam 会拒绝对这类会话做写操作，
 * 所以这里要区分清楚"过滤器没生效"和"登录态被 Steam 拒绝"两种情况。
 */
const settings = require('../server/lib/settings');
const api = require('../server/lib/steamApi');
const sc = require('../server/lib/steamCommunity');
const session = require('../server/lib/session');

const ALL_SORTS = ['mostrecent', 'trend', 'toprated', 'subscriptions', 'favorites'];

(async () => {
  const cfg = settings.loadSettings();
  const ctx = { cookie: cfg.cookie, proxy: cfg.proxy, apiKey: cfg.apiKey, language: cfg.language };
  const jwt = sc.parseSteamJwt(ctx.cookie);
  console.log('登录态：' + (jwt.present ? 'JWT 绑定 IP=' + jwt.ipSubject + '，' + Math.round((jwt.exp - Date.now()) / 3600000) + ' 小时后过期' : '无'));
  console.log('要能看到 Steam 才能判定 IP 是否一致（本机出口 IP 见 /api/status 的 proxy）\n');

  const results = {};
  for (const sort of ALL_SORTS) {
    const r = await api.queryWorkshop({ sort, page: 1, pageSize: 10 }, ctx);
    results[sort] = r.ok ? r.totalCount : 'FAIL:' + r.reason;
    console.log(
      sort.padEnd(14) +
        (r.ok
          ? ' total=' + String(r.totalCount).padStart(9) + '  首条：' + (r.items[0] ? r.items[0].title.slice(0, 30) : '-') +
            '  serverQuery=' + JSON.stringify(r.serverQuery && (r.serverQuery.browse_filter || r.serverQuery.browse_sort || r.serverQuery.section || null))
          : ' FAIL ' + r.reason)
    );
  }

  console.log('\n--- 判定 ---');
  const all = results.mostrecent;
  const subs = results.subscriptions;
  const favs = results.favorites;
  if (subs === all || favs === all) {
    console.log('✗ browsefilter 没生效（总数与 mostrecent 相同）');
    console.log('  可能原因：登录态被 Steam 判定为无效，于是忽略了 mysubscriptions/myfavorites 过滤');
  } else {
    console.log('✓ 过滤器生效：mostrecent=' + all + ' subscriptions=' + subs + ' favorites=' + favs);
  }

  console.log('\n--- 订阅接口探测（会真的给 Steam 发一次 subscribe） ---');
  const target = results.mostrecent && (await api.queryWorkshop({ sort: 'trend', days: 7, page: 1, pageSize: 1 }, ctx));
  const id = target.ok && target.items[0] ? target.items[0].id : '3651550354';
  const acq = await api.acquireSession(ctx, id);
  console.log('取得 sessionid：' + (acq.sessionId ? acq.sessionId.slice(0, 8) + '…' : '(失败)'));
  // 先订阅再取消，尽量不改变现状
  const sub = await api.subscribe(id, ctx);
  console.log('subscribe(' + id + ') -> ' + (sub.ok ? '成功' : '失败：' + sub.reason));
  if (sub.ok) {
    const un = await api.unsubscribe(id, ctx);
    console.log('unsubscribe(' + id + ') -> ' + (un.ok ? '成功（已复原）' : '失败：' + un.reason));
  }

  console.log('\n--- 会话事件 ---');
  session.events()
    .slice(0, 8)
    .forEach((e) => console.log('  ' + new Date(e.at).toLocaleTimeString('zh-CN') + ' ' + e.type + ' ' + e.detail));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
