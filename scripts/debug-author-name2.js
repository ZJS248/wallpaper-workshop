'use strict';
/**
 * 详情页「作者昵称」取证：面包屑到底长什么样（BUG-12）。
 * 用法：node scripts/debug-author-name2.js 884307090
 */
const { getText } = require('../server/lib/httpClient');
const sc = require('../server/lib/steamCommunity');
const settings = require('../server/lib/settings');
const session = require('../server/lib/session');

(async function main() {
  const cfg = settings.getConfig();
  const ctx = session.currentContext();
  for (const id of process.argv.slice(2).length ? process.argv.slice(2) : ['884307090']) {
    const r = await getText(sc.COMMUNITY + '/sharedfiles/filedetails/?id=' + id, {
      cookie: ctx.cookie,
      proxy: cfg.proxy,
      timeout: 30000,
      noLimit: true,
    });
    const html = r.body || '';
    console.log('\n===== ' + id + ' =====');
    const idx = html.indexOf('的创意工坊');
    console.log('— 面包屑上下文（匹配点前 420 字符）—');
    console.log(html.slice(Math.max(0, idx - 420), idx + 40).replace(/\s+/g, ' '));
    console.log('\n— 所有 myworkshopfiles 链接 —');
    const links = html.match(/href="[^"]*myworkshopfiles[^"]*"/g) || [];
    Array.from(new Set(links)).slice(0, 6).forEach((l) => console.log('   ' + l));
    console.log('\n— 我的正则测试 —');
    const bm = html.match(
      /<a[^>]+href="https:\/\/steamcommunity\.com\/profiles\/(\d{17})\/myworkshopfiles\/[^"]*"[^>]*>([\s\S]{0,120}?)<\/a>/
    );
    console.log('   profiles 版面包屑：', bm ? JSON.stringify({ id: bm[1], name: sc.decodeEntities(bm[2].replace(/<[^>]*>/g, '')) }) : 'null');
    const bm2 = html.match(/href="(https:\/\/steamcommunity\.com\/(?:id|profiles)\/[^"/]+)\/myworkshopfiles\//);
    console.log('   宽松版：', bm2 ? bm2[1] : 'null');
    // 面包屑的完整 a 标签
    const around = html.slice(Math.max(0, idx - 300), idx + 40);
    const a = around.match(/<a [^>]*>[\s\S]*$/);
    console.log('   面包屑 a 标签原文：', a ? a[0].replace(/\s+/g, ' ') : '(没找到)');
  }
})().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
