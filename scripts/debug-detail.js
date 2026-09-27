'use strict';
/** 调试：对比"带 l= 参数"和"不带"的详情页，并测试冷却后的恢复情况 */
const settings = require('../server/lib/settings');
const httpClient = require('../server/lib/httpClient');
const sc = require('../server/lib/steamCommunity');

const ID = process.argv[2] || '3807151772';

(async () => {
  const cfg = settings.loadSettings();
  const ctx = { proxy: cfg.proxy, cookie: cfg.cookie };
  const variants = [
    'https://steamcommunity.com/sharedfiles/filedetails/?id=' + ID,
    'https://steamcommunity.com/sharedfiles/filedetails/?id=' + ID + '&l=schinese',
    'https://steamcommunity.com/sharedfiles/filedetails/?id=' + ID + '&searchtext=',
  ];
  for (const u of variants) {
    const r = await httpClient.getText(u, ctx);
    const html = r.body;
    const hasTitle = /workshopItemTitle/.test(html);
    const hasSub = /SubscribeItemBtn/.test(html);
    const hasAuthor = /data-miniprofile="\d+"/.test(html);
    console.log(
      u.replace('https://steamcommunity.com', '')
        .padEnd(52),
      'HTTP ' + r.status,
      'len=' + String(html.length).padStart(6),
      'title=' + (hasTitle ? 'Y' : 'n'),
      'subBtn=' + (hasSub ? 'Y' : 'n'),
      'author=' + (hasAuthor ? 'Y' : 'n')
    );
    await new Promise((r2) => setTimeout(r2, 1500));
  }

  console.log('\n--- 解析 detail（走正常封装） ---');
  const d = await sc.fetchDetail({ id: ID, cookie: cfg.cookie, proxy: cfg.proxy });
  console.log('ok=' + d.ok, 'degraded=' + d.degraded, 'reason=' + (d.reason || ''));
  console.log('author=' + JSON.stringify(d.author));
  console.log('subscribed=' + d.subscribed, 'favorited=' + d.favorited, 'sessionId=' + (d.sessionId || '').slice(0, 8));
  if (d.item) console.log('item=' + d.item.title + ' | ' + d.item.creator);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
