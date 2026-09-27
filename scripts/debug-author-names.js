'use strict';
/**
 * 检查浏览页的 SSR 数据里有没有"作者昵称"这类免费信息。
 * 如果有，就不必依赖可选的 Steam Web API key 了。
 */
const settings = require('../server/lib/settings');
const sc = require('../server/lib/steamCommunity');
const httpClient = require('../server/lib/httpClient');

(async () => {
  const cfg = settings.loadSettings();
  const url =
    'https://steamcommunity.com/workshop/browse/?appid=431960&browsesort=trend&days=7&numperpage=10&p=1&l=schinese';
  const r = await httpClient.getText(url, { cookie: cfg.cookie, proxy: cfg.proxy });
  const ssr = sc.collectSsrValues(r.body);

  const rc = ssr.renderContext;
  if (!rc || typeof rc.queryData !== 'string') {
    console.log('没有 renderContext.queryData');
    return;
  }
  const qd = sc.decodeLoose(rc.queryData);

  console.log('=== queryData 里的所有 queryKey ===');
  (qd.queries || []).forEach((q, i) => {
    const d = q.state && q.state.data;
    const shape = d == null ? 'null' : Array.isArray(d) ? 'array(' + d.length + ')' : typeof d === 'object' ? Object.keys(d).slice(0, 5).join(',') : typeof d;
    console.log('  [' + i + '] ' + JSON.stringify(q.queryKey).slice(0, 76) + '   -> ' + shape);
  });

  console.log('\n=== 找形如 {steamid: {name/avatar}} 的字典 ===');
  function scan(node, path, depth) {
    if (!node || typeof node !== 'object' || depth > 6) return;
    if (Array.isArray(node)) {
      node.slice(0, 3).forEach((v, i) => scan(v, path + '[' + i + ']', depth + 1));
      return;
    }
    const keys = Object.keys(node);
    const looksLikePeople =
      keys.length > 0 &&
      keys.every((k) => /^\d{17}$/.test(k)) &&
      keys.length <= 200;
    if (looksLikePeople) {
      const sampleKey = keys[0];
      console.log('  ★ ' + path + '  → ' + keys.length + ' 个人，样本：');
      console.log('     ' + JSON.stringify(node[sampleKey]).slice(0, 300));
      return;
    }
    keys.slice(0, 25).forEach((k) => scan(node[k], path + '.' + k, depth + 1));
  }
  scan(qd, 'queryData', 0);

  console.log('\n=== 列表首条的字段（看有没有 name 类字段）===');
  const { data } = sc.extractBrowse(ssr);
  if (data && data.results && data.results[0]) {
    console.log(Object.keys(data.results[0]).join(', '));
    const it = data.results[0];
    console.log('creator=' + it.creator + ' title=' + it.title);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
