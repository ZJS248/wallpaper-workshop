'use strict';
/** 调试：找出"按作者查全部作品"真正可用的 URL */
const settings = require('../server/lib/settings');
const sc = require('../server/lib/steamCommunity');

const CREATOR = process.argv[2] || '76561199207268259';

const cases = {
  'browse + creatorid': 'https://steamcommunity.com/workshop/browse/?appid=431960&browsesort=mostrecent&creatorid=' + CREATOR + '&numperpage=10&p=1',
  'browse + creatorid + section': 'https://steamcommunity.com/workshop/browse/?appid=431960&browsesort=mostrecent&section=readytouseitems&creatorid=' + CREATOR + '&numperpage=10&p=1',
  'myworkshopfiles': 'https://steamcommunity.com/profiles/' + CREATOR + '/myworkshopfiles/?appid=431960&numperpage=10&p=1',
  'myworkshopfiles + sort': 'https://steamcommunity.com/profiles/' + CREATOR + '/myworkshopfiles/?appid=431960&browsesort=mostrecent&numperpage=10&p=1',
  'myworkshopfiles + section': 'https://steamcommunity.com/profiles/' + CREATOR + '/myworkshopfiles/?appid=431960&section=readytouseitems&numperpage=10&p=1',
  'browse + searchtext=creator': 'https://steamcommunity.com/workshop/browse/?appid=431960&searchtext=&creatorid=' + CREATOR + '&numperpage=10&p=1',
};

(async () => {
  const cfg = settings.loadSettings();
  for (const [name, url] of Object.entries(cases)) {
    try {
      const r = await sc.fetchBrowse({ url, cookie: cfg.cookie, proxy: cfg.proxy });
      if (!r.ok) {
        console.log('### ' + name.padEnd(30) + ' FAIL  ' + r.reason);
        continue;
      }
      const allSame = r.items.length > 0 && r.items.every((i) => i.creator === CREATOR);
      console.log(
        '### ' +
          name.padEnd(30) +
          ' total=' + String(r.totalCount).padStart(8) +
          ' 本页=' + r.items.length +
          ' 全是该作者=' + (allSame ? '是' : '否') +
          ' | ' + r.items.slice(0, 3).map((i) => i.title.slice(0, 18)).join(' / ')
      );
    } catch (e) {
      console.log('### ' + name.padEnd(30) + ' ERR  ' + e.message);
    }
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
