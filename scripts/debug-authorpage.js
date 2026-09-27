'use strict';
/** 调试：作者作品页（myworkshopfiles）的页面结构 */
const fs = require('fs');
const path = require('path');
const settings = require('../server/lib/settings');
const httpClient = require('../server/lib/httpClient');
const sc = require('../server/lib/steamCommunity');

const CREATOR = process.argv[2] || '76561199207268259';
const URL_ = 'https://steamcommunity.com/profiles/' + CREATOR + '/myworkshopfiles/?appid=431960&numperpage=10&p=1';

(async () => {
  const cfg = settings.loadSettings();
  const r = await httpClient.getText(URL_, { cookie: cfg.cookie, proxy: cfg.proxy });
  const html = r.body;
  fs.writeFileSync(path.join(__dirname, '..', 'config', 'debug-author.html'), html, 'utf8');
  console.log('HTTP', r.status, '长度', html.length);
  console.log('含 window.SSR      :', html.includes('window.SSR'));
  console.log('含 publishedfileid :', (html.match(/publishedfileid/g) || []).length);
  console.log('含 workshopItem    :', (html.match(/workshopItem/g) || []).length);
  console.log('含 sharedfiles     :', (html.match(/sharedfiles/g) || []).length);
  console.log('含 total_count     :', html.includes('total_count'));
  console.log('含 creatorid       :', html.includes('creatorid'));

  const ssr = sc.collectSsrValues(html);
  console.log('SSR 字段:', Object.keys(ssr).join(', ') || '(无)');

  for (const k of ['workshopItem', 'sharedfiles/filedetails/?id=', 'myworkshopfiles', 'pagebtn', 'workshopBrowseItems', 'searchResults']) {
    const i = html.indexOf(k);
    console.log('\n### ' + k + ' @ ' + i);
    if (i >= 0) console.log(html.slice(Math.max(0, i - 150), i + 500).replace(/\s+/g, ' '));
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
