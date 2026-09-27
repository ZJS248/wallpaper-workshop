'use strict';
/** 看 PlayerLinkDetails 里到底有哪些字段（能不能直接拿到昵称/头像） */
const settings = require('../server/lib/settings');
const sc = require('../server/lib/steamCommunity');
const httpClient = require('../server/lib/httpClient');

(async () => {
  const cfg = settings.loadSettings();
  const url =
    'https://steamcommunity.com/workshop/browse/?appid=431960&browsesort=trend&days=7&numperpage=10&p=1&l=schinese';
  const r = await httpClient.getText(url, { cookie: cfg.cookie, proxy: cfg.proxy });
  const ssr = sc.collectSsrValues(r.body);
  const qd = sc.decodeLoose(ssr.renderContext.queryData);

  const hits = (qd.queries || []).filter((q) => q.queryKey && q.queryKey[0] === 'PlayerLinkDetails');
  console.log('PlayerLinkDetails 条数: ' + hits.length);

  const first = hits[0];
  console.log('\n=== 原始结构 ===');
  console.log(JSON.stringify(first.state.data, null, 2).slice(0, 1600));

  console.log('\n=== 全部作者摘要 ===');
  hits.slice(0, 12).forEach((q) => {
    const sid = q.queryKey[1];
    const d = q.state.data || {};
    const pub = d.public_data || {};
    console.log(
      '  ' +
        sid +
        '  name=' +
        JSON.stringify(pub.persona_name || pub.personaname || '(无)') +
        '  avatar=' +
        String(pub.avatar_url || pub.avatar || pub.avatar_hash || '(无)').slice(0, 70) +
        '  keys=' +
        Object.keys(pub).join(',')
    );
  });
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
