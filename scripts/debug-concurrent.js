'use strict';
/**
 * 并发打社区页会不会被限流？
 * 决定"同类目 OR 合并"能不能靠并发把延迟压下来。
 */
const settings = require('../server/lib/settings');
const sc = require('../server/lib/steamCommunity');

const RES = ['2560 x 1440', '3840 x 2160', 'Ultrawide 3440 x 1440', '1920 x 1080'];

function url(tag) {
  return (
    'https://steamcommunity.com/workshop/browse/?appid=431960&numperpage=30&p=1&browsesort=trend&days=7' +
    '&match_all_tags=1&requiredtags%5B%5D=' +
    encodeURIComponent(tag)
  );
}

(async () => {
  const cfg = settings.loadSettings();

  console.log('=== A) 并发 4 个（绕过社区页限流，noLimit 由 fetchBrowse 内部决定）===');
  let t0 = Date.now();
  const a = await Promise.all(
    RES.map((tag) => sc.fetchBrowse({ url: url(tag), cookie: cfg.cookie, proxy: cfg.proxy }))
  );
  console.log('  耗时 ' + (Date.now() - t0) + 'ms');
  a.forEach((r, i) => {
    console.log('  ' + RES[i].padEnd(22) + ' ok=' + r.ok + ' total=' + (r.totalCount || '-') + ' 条数=' + r.items.length + (r.ok ? '' : '  ' + r.reason));
  });

  console.log('\n=== B) 紧接着再来一轮并发 4（看会不会触发限流）===');
  t0 = Date.now();
  const b = await Promise.all(
    RES.map((tag) => sc.fetchBrowse({ url: url(tag), cookie: cfg.cookie, proxy: cfg.proxy }))
  );
  console.log('  耗时 ' + (Date.now() - t0) + 'ms');
  b.forEach((r, i) => {
    console.log('  ' + RES[i].padEnd(22) + ' ok=' + r.ok + ' total=' + (r.totalCount || '-') + (r.ok ? '' : '  ' + r.reason));
  });

  const merged = new Set();
  a.concat(b).forEach((r) => (r.items || []).forEach((it) => merged.add(it.id)));
  console.log('\n两轮合并去重后共 ' + merged.size + ' 个不同 id');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
