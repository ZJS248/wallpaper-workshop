'use strict';
/** 调试：个人页 browsefilter=mysubscriptions 的 HTML 结构 */
const fs = require('fs');
const path = require('path');
const settings = require('../server/lib/settings');
const httpClient = require('../server/lib/httpClient');
const sc = require('../server/lib/steamCommunity');

const STEAMID = process.argv[2] || '76561198374255138';
const URL_ =
  'https://steamcommunity.com/profiles/' + STEAMID + '/myworkshopfiles/?appid=431960&browsefilter=mysubscriptions&numperpage=10&p=1';

(async () => {
  const cfg = settings.loadSettings();
  const r = await httpClient.getText(URL_, { cookie: cfg.cookie, proxy: cfg.proxy });
  const html = r.body;
  const out = path.join(__dirname, '..', 'config', 'shots', 'myworkshopfiles.html');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html, 'utf8');
  console.log('HTTP', r.status, '长度', html.length);
  console.log('已保存到 ' + out);

  for (const k of [
    'workshopBrowseItems', 'workshopItem', 'class="ugc"', 'data-publishedfileid',
    'publishedfileid', 'workshopBrowsePagingInfo', 'sharedfiles/filedetails/?id=',
    'workshopItemTitle', 'myworkshopfiles', 'browsefilter', 'No items', '没有',
  ]) {
    console.log('  ' + k.padEnd(28) + ' 次数=' + (html.split(k).length - 1));
  }

  const i = html.indexOf('workshopBrowseItems');
  if (i >= 0) {
    console.log('\n--- workshopBrowseItems 之后 1600 字节 ---');
    console.log(html.slice(i, i + 1600).replace(/\s+/g, ' '));
  } else {
    const j = html.indexOf('BrowseItems');
    console.log('\nBrowseItems idx=' + j);
    const k = html.indexOf('workshopItem');
    console.log('workshopItem idx=' + k);
    if (k >= 0) console.log(html.slice(Math.max(0, k - 400), k + 1200).replace(/\s+/g, ' '));
  }

  const p = html.match(/workshopBrowsePagingInfo[^>]*>([\s\S]{0,150}?)</);
  console.log('\n分页信息: ' + (p ? p[1].replace(/\s+/g, ' ').trim() : '(无)'));

  const parsed = require('../server/lib/authorPage').parseAuthorWorksHtml(html, STEAMID, 1, 10);
  console.log('解析结果: ok=' + parsed.ok + ' items=' + parsed.items.length + ' total=' + parsed.total);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
