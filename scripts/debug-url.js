'use strict';
/** 调试：打印生成的浏览页 URL，并用 --fetch 真实请求一次看状态码 */
const path = require('path');
const api = require('../server/lib/steamApi');
const settings = require('../server/lib/settings');
const sc = require('../server/lib/steamCommunity');

const cfg = settings.loadSettings();
console.log('proxy      =', cfg.proxy || '(直连)', '来源:', cfg.proxySource);
console.log('cookie长度 =', (cfg.cookie || '').length, '来源:', cfg.cookieSource);

const cases = [
  { name: '最新', p: { sort: 'mostrecent', page: 1, pageSize: 8 } },
  { name: '趋势7天', p: { sort: 'trend', days: 7, page: 1, pageSize: 5 } },
  { name: '评分最高', p: { sort: 'toprated', page: 1, pageSize: 5 } },
  { name: '多标签', p: { tags: ['Anime', '3840 x 2160'], matchAllTags: true, page: 1, pageSize: 6 } },
  { name: '搜索', p: { search: '初音', page: 1, pageSize: 5 } },
  { name: '我的订阅', p: { filter: 'mysubscriptions', page: 1, pageSize: 5 } },
];

(async () => {
  for (const c of cases) {
    const url = api.buildBrowseUrl(c.p);
    console.log('\n=== ' + c.name + '\n' + url);
    if (process.argv.includes('--fetch')) {
      const r = await sc.fetchBrowse({ url, cookie: cfg.cookie, proxy: cfg.proxy });
      console.log(
        '    -> ok=' + r.ok + ' status=' + (r.status || 200) + (r.ok ? ' 条数=' + r.items.length + ' 共=' + r.totalCount : ' 原因=' + r.reason)
      );
    }
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
