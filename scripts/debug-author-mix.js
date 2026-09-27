'use strict';
/**
 * 排查「同作者作品」里混进了别人的作品。
 * 用法：node scripts/debug-author-mix.js 76561199816490138
 */
const authorPage = require('../server/lib/authorPage');
const steamApi = require('../server/lib/steamApi');
const settings = require('../server/lib/settings');
const session = require('../server/lib/session');

(async function main() {
  const cfg = settings.getConfig();
  const ctx = session.currentContext();
  const id = process.argv[2] || '76561199816490138';

  const raw = await authorPage.fetchProfileWorks(id, {
    scope: 'works',
    page: 1,
    cookie: ctx.cookie,
    proxy: cfg.proxy,
    timeout: 30000,
    noLimit: true,
  });
  console.log('作者页：ok=%s items=%d total=%d', raw.ok, raw.items.length, raw.total);
  console.log('URL:', raw.url);

  const detail = await steamApi.getDetails(raw.items.map((i) => i.id), ctx);
  const byId = new Map((detail.items || []).map((d) => [d.id, d]));
  console.log('\nid                 页内 creator(解析写死的)  API 的真实 creator    是否一致  标题');
  raw.items.forEach((it) => {
    const d = byId.get(it.id);
    const real = d ? d.creator : '(API 无此条)';
    const same = !d || real === id;
    console.log(
      '%s  %s  %s  %s  %s',
      it.id,
      String(it.creator).padEnd(20),
      String(real).padEnd(20),
      same ? '  ✓   ' : '  ✗   ',
      String(it.title || d && d.title || '').slice(0, 40)
    );
  });
  const badIds = raw.items.filter((it) => byId.has(it.id) && byId.get(it.id).creator !== id).map((it) => it.id);
  console.log('\n不属于该作者的 id：', badIds.join(', ') || '(无)');

  // 这些 id 是不是"合集"(file_type=2)？
  badIds.slice(0, 8).forEach((bid) => {
    const d = byId.get(bid);
    console.log('  %s  file_type=%s  creator=%s  title=%s', bid, d.raw && d.raw.file_type, d.creator, String(d.title).slice(0, 30));
  });

  // 对照：直接看该 profile 的 HTML 里这些 id 出现在什么上下文
  console.log('\n--- 作者页 HTML 里第一个"别人的" id 的上下文 ---');
  const { getText } = require('../server/lib/httpClient');
  const r = await getText(raw.url, { cookie: ctx.cookie, proxy: cfg.proxy, timeout: 30000, noLimit: true });
  const html = r.body || '';
  if (badIds.length) {
    const at = html.indexOf(badIds[0]);
    console.log(at < 0 ? '(HTML 里找不到该 id —— 说明是解析器串了块)' : html.slice(Math.max(0, at - 700), at + 300).replace(/\s+/g, ' '));
  }
  // 页面里有没有"合集/收藏"之类的分区标题
  const sections = html.match(/class="workshopBrowsePagingInfo"[^>]*>[\s\S]{0,200}?<\/div>/g) || [];
  sections.slice(0, 3).forEach((s) => console.log('分页信息：' + s.replace(/\s+/g, ' ').slice(0, 160)));
  const empties = html.match(/noItemsFound|没有找到|没有项目/g) || [];
  console.log('页面里的"没有项目"提示次数：', empties.length);
})().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
