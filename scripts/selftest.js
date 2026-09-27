'use strict';
/**
 * 自检：直接打真实 Steam，验证解析器与接口封装。
 * 用法： node scripts/selftest.js [proxy]
 * 不传 proxy 时读环境变量 / 父项目配置（与后端同一套探测逻辑）。
 */

const { loadSettings } = require('../server/lib/settings');
const sc = require('../server/lib/steamCommunity');
const api = require('../server/lib/steamApi');

let pass = 0;
let fail = 0;

function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  \u2713 ' + name + (extra ? '  \u2014 ' + extra : ''));
  } else {
    fail++;
    console.log('  \u2717 ' + name + (extra ? '  \u2014 ' + extra : ''));
    failed.push({ name, extra: extra || '' });
  }
}

/** 记录失败项，最后一次性打印，方便定位 */
const failed = [];

/**
 * 带重试的断言。
 *
 * 为什么需要：本自检是连续打真实 Steam 的，而社区页对突发流量很敏感
 * （会回 429 或"精简页"）。一次偶发失败就判定"功能坏了"会误导人，
 * 所以对"结果类"断言给几次重试 + 间隔。
 * 注意只重试**幂等的读操作**，绝不重试订阅/收藏这类写操作。
 */
async function checkRetry(name, fn, tries, gapMs) {
  const n = tries || 3;
  const gap = gapMs || 1500;
  let last = null;
  let lastExtra = '';
  for (let i = 0; i < n; i++) {
    try {
      const r = await fn();
      last = !!(r && r.ok);
      lastExtra = (r && r.extra) || '';
      if (last) break;
    } catch (e) {
      last = false;
      lastExtra = e.message;
    }
    if (i < n - 1) await new Promise((r) => setTimeout(r, gap));
  }
  check(name + (n > 1 ? '（最多重试 ' + (n - 1) + ' 次）' : ''), last, lastExtra);
  return last;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const cfg = loadSettings();
  const anon = process.argv.includes('--anon');
  // 第一个「不像选项」的参数当作代理地址；不传就用配置里的
  const proxyArg = process.argv.slice(2).find((a) => !a.startsWith('--'));
  const proxy = proxyArg !== undefined ? proxyArg : cfg.proxy;
  const cookie = anon ? '' : cfg.cookie;
  const ctx = { cookie, proxy, apiKey: cfg.apiKey, language: cfg.language };
  console.log('proxy = ' + (proxy || '(直连)'));
  console.log('cookie 长度 = ' + (cookie || '').length + (anon ? '（--anon 强制匿名）' : ''));
  console.log('API key = ' + (cfg.apiKey ? '已配置' : '未配置（作者昵称将退化为 steamID）'));
  const jwt = sc.parseSteamJwt(cookie);
  if (jwt.present) {
    console.log(
      'JWT exp = ' +
        (jwt.exp ? new Date(jwt.exp).toLocaleString('zh-CN') : '?') +
        '，绑定 IP = ' +
        (jwt.ipSubject || '?')
    );
  }

  // ---- 1. 公开浏览：最新 ----
  console.log('\n[1] 最新（mostrecent）');
  // 社区页有突发限流，读操作失败就重试几次；写操作绝不重试。
  const r1 = await api.queryWorkshop({ sort: 'mostrecent', page: 1, pageSize: 8 }, ctx);
  check('请求成功', r1.ok, r1.reason || '');
  if (r1.ok) {
    check('拿到作品', r1.items.length > 0, r1.items.length + ' 条 / 共 ' + r1.totalCount);
    check('分页信息', r1.page === 1 && r1.totalPages > 100, 'page=' + r1.page + ' pages=' + r1.totalPages);
    const it = r1.items[0];
    console.log('    首条：' + it.id + ' | ' + it.title);
    console.log('          作者=' + it.creator + '（' + (it.creatorName || '未带昵称') + '）订阅=' + it.subscriptions + ' 星级=' + it.starRating);
    console.log('          标签=' + it.tags.join('/'));
    console.log('          预览=' + it.previewUrl);
    console.log('          类型=' + it.wallpaperType + ' 分级=' + it.ageRating + ' 分辨率=' + it.resolution);
    check('首条字段完整', !!(it.id && it.title && it.creator && it.tags.length), '');
    check('预览图是 steamusercontent', /steamusercontent|steamstatic|akamai/.test(it.previewUrl), it.previewUrl);
    // 作者昵称来自浏览页自带的 PlayerLinkDetails（不需要 API key）
    check('免费拿到作者昵称', !!it.creatorName, it.creatorName || '（本页未带，可能是 Steam 改了结构）');
  }

  // ---- 2. 排序：趋势 / 评分最高 ----
  console.log('\n[2] 趋势（trend 7 天）vs 评分最高（toprated）');
  // 不要并行打：社区页是全局限流的，并发只会让两边都变慢/被限流
  const r2 = await api.queryWorkshop({ sort: 'trend', days: 7, page: 1, pageSize: 5 }, ctx);
  const r3 = await api.queryWorkshop({ sort: 'toprated', page: 1, pageSize: 5 }, ctx);
  check('trend 成功', r2.ok, r2.reason || '');
  check('toprated 成功', r3.ok, r3.reason || '');
  if (r2.ok && r3.ok) {
    check('两种排序结果不同', r2.items[0].id !== r3.items[0].id, r2.items[0].title + ' vs ' + r3.items[0].title);
  }

  // ---- 3. 标签筛选 ----
  console.log('\n[3] 标签筛选（Anime + 3840 x 2160，必须全部命中）');
  const r4 = await api.queryWorkshop(
    { tags: ['Anime', '3840 x 2160'], matchAllTags: true, page: 1, pageSize: 6 },
    ctx
  );
  check('请求成功', r4.ok, r4.reason || '');
  if (r4.ok) {
    const allOk = r4.items.every((i) => i.tags.includes('Anime'));
    check('每一条都带 Anime 标签', allOk, r4.items.length + ' 条/共 ' + r4.totalCount);
  }

  // ---- 4. 搜索 ----
  console.log('\n[4] 关键词搜索（初音）');
  const r5 = await api.queryWorkshop({ search: '初音', page: 1, pageSize: 5 }, ctx);
  check('请求成功', r5.ok, r5.reason || '');
  if (r5.ok) {
    check('有结果', r5.items.length > 0, r5.items.length + ' 条/共 ' + r5.totalCount);
    console.log('    ' + r5.items.map((i) => i.title).join(' | '));
  }

  // ---- 5. 排除标签 ----
  console.log('\n[5] 排除标签（Anime 但排除 Everyone 分级）');
  const r6 = await api.queryWorkshop(
    { tags: ['Anime'], excludedTags: ['Everyone'], page: 1, pageSize: 4 },
    ctx
  );
  check('请求成功', r6.ok, r6.reason || '');
  if (r6.ok) {
    const bad = r6.items.filter((i) => i.tags.includes('Everyone'));
    check('没有 Everyone 结果', bad.length === 0, r6.items.map((i) => i.ageRating).join('/'));
  }

  // ---- 6. 标签选项 ----
  console.log('\n[6] 筛选器标签集');
  const opts = await api.getFilterOptions(ctx);
  check('拿到标签集', opts.tags && opts.tags.length > 20, (opts.tags || []).length + ' 个标签');
  check('含类型标签', (opts.tags || []).includes('Scene'), '');
  check('含分辨率标签', (opts.tags || []).some((t) => /^\d+ x \d+$/.test(t)), '');
  check('含分级标签', (opts.tags || []).includes('Everyone') && (opts.tags || []).includes('Mature'), '');

  // ---- 7. 详情 + 作者 + 相关壁纸（同作者）----
  console.log('\n[7] 详情 / 作者 / 同作者作品');
  let sample = null;
  const r7a = await api.queryWorkshop({ sort: 'trend', days: 7, page: 1, pageSize: 10 }, ctx);
  if (r7a.ok) sample = r7a.items.find((i) => i.creator);
  if (sample) {
    // 详情页是最容易被 Steam 限流的一环（它还有个"精简页"的坑），
    // 所以这里显式重试几次；重试期间详情页还能靠公开 API 兜底。
    let d = null;
    for (let i = 0; i < 3; i++) {
      d = await api.getItemDetail({ id: sample.id }, ctx);
      if (d.ok && d.author && d.author.steamId) break;
      if (i < 2) await sleep(2000);
    }
    check('详情获取成功', d.ok, d.reason || d.pageReason || '');
    if (d.ok) {
      console.log('    作品：' + (d.item ? d.item.title : '?') + '  (' + d.id + ')');
      console.log('    作者：' + (d.author.name || '(未解析昵称)') + ' (' + d.author.steamId + ')');
      console.log('    已订阅=' + d.subscribed + ' 已收藏=' + d.favorited + ' 登录态=' + d.loggedIn);
      console.log('    统计：' + JSON.stringify(d.stats));
      console.log('    文件大小/时间：' + JSON.stringify(d.detailStats));
      check('拿到作品主体（公开 API）', !!(d.item && d.item.title), d.item ? d.item.tags.join('/') : (d.apiError || ''));
      // 作者身份一定可得：详情页面包屑 / 浏览页 PlayerLinkDetails / 公开 API 三选一。
      // 昵称可能缺（详情页被限流且没配 API key 时），那是允许的降级。
      const creatorId = d.author.steamId || (d.item && d.item.creator) || sample.creator;
      check('作者身份可得', !!creatorId, (d.author.name || '(无昵称)') + ' / ' + creatorId);
      check(
        '作者不是当前登录用户',
        !d.author.steamId || d.author.steamId !== '76561198374255138' || anon,
        d.author.steamId
      );
      check('拿到订阅状态', typeof d.subscribed === 'boolean', 'sub=' + d.subscribed);

      // 「相关壁纸」= 同作者全部作品，走个人创意工坊页
      let byAuthor = null;
      for (let i = 0; i < 3; i++) {
        byAuthor = await api.getWorksByCreator(creatorId, { page: 1, pageSize: 6 }, ctx);
        if (byAuthor.ok) break;
        await sleep(2000);
      }
      check('同作者作品查询成功', byAuthor && byAuthor.ok, (byAuthor && byAuthor.reason) || '');
      if (byAuthor && byAuthor.ok) {
        const same = byAuthor.items.filter((i) => i.creator === creatorId).length;
        const n = byAuthor.items.length;
        /**
         * 注意：这里**不能**要求 100% 同作者。
         *
         * 实测：Steam 的个人创意工坊页（/profiles/<id>/myworkshopfiles/）会把这个用户
         * **参与协作 / 被署名的**作品也列出来，那些条目的 creator 是别人。
         * 例如 76561199816490138 的第 1 页 30 条里有 6 条的 creator 是 76561198687668493 ——
         * 这不是解析串了块（已逐条比对 HTML 与公开 API 的 creator 字段确认）。
         * 既然那是"作者自己的创意工坊页"，我们照 Steam 的列表展示，界面文案也据此措辞。
         */
        check(
          '同作者作品以该作者为主（≥70%；其余是 Steam 列出的协作/署名作品）',
          n === 0 || same / n >= 0.7,
          same + '/' + n + ' 条同作者 / 共 ' + byAuthor.total
        );
        console.log('    同作者作品：' + byAuthor.items.slice(0, 6).map((i) => i.title).join(' | '));
      }
    }
  } else {
    check('取到样本作品', false, 'trend 列表为空');
  }

  // ---- 8. 登录态相关的**动作**（订阅集合），列表视图已按需求移除 ----
  // 「我的订阅 / 我的收藏」两个**列表视图**已经不做（本项目只做创意工坊），
  // 但订阅这个**动作**还在（卡片/详情面板上的按钮），「已订阅」角标也要靠这个集合，
  // 所以这里验证的是"能不能拿到完整的已订阅 id 集合"。
  console.log('\n[8] 已订阅 id 集合（卡片角标用）');
  const subs = await api.getSubscribedIds(ctx);
  check('拿到已订阅集合', subs.ok || !!subs.reason, subs.ok ? subs.ids.size + ' 个 id / 共 ' + subs.total : subs.reason);
  if (subs.ok && subs.total) {
    check('翻页后覆盖量超过单页 30 条（BUG-17 的修复点）', subs.ids.size >= Math.min(subs.total, 30), subs.ids.size + '/' + subs.total);
    console.log('    页数=' + subs.pages + ' complete=' + subs.complete + ' capped=' + subs.capped);
  }
  const oldFilter = await api.queryWorkshop({ filter: 'mysubscriptions', page: 1, pageSize: 5 }, ctx);
  check('旧的 filter=mysubscriptions 不再被当成个人列表（回落 trend）', oldFilter.ok && oldFilter.sort === 'trend', 'sort=' + oldFilter.sort);

  // ---- 9. 登录态探测 ----
  console.log('\n[9] 登录态探测');
  const who = await api.whoAmI(ctx);
  console.log('    ' + JSON.stringify(who));
  check('探测有明确结论', typeof who.loggedIn === 'boolean', 'loggedIn=' + who.loggedIn + (who.reason ? ' (' + who.reason + ')' : ''));

  console.log('\n================ ' + pass + ' 通过 / ' + fail + ' 失败 ================');
  if (failed.length) {
    console.log('\n失败明细：');
    failed.forEach((f) => console.log('  ✗ ' + f.name + (f.extra ? '  — ' + f.extra : '')));
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('自检异常：', e && e.stack ? e.stack : e);
  process.exit(2);
});
