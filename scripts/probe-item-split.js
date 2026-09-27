'use strict';
/**
 * 拆分 /api/item 的耗时：详情页 / 公开 API / 相关壁纸（作者页）各自多久。
 * 用法：node scripts/probe-item-split.js [id]
 */
const BASE = process.env.WW_BASE || 'http://127.0.0.1:9391';

async function timeIt(label, path) {
  const t = Date.now();
  try {
    const r = await fetch(BASE + path);
    const j = await r.json();
    const d = j.data || j;
    const n = d.items ? d.items.length : d.item ? 1 : 0;
    console.log(
      '  ' + label.padEnd(22) + String(Date.now() - t).padStart(7) + ' ms   ok=' + d.ok +
      '  n=' + n + (d.error ? '  error=' + String(d.error).slice(0, 70) : '')
    );
    return d;
  } catch (e) {
    console.log('  ' + label.padEnd(22) + String(Date.now() - t).padStart(7) + ' ms   ERR ' + e.message);
    return null;
  }
}

(async function main() {
  const id = process.argv[2] || '3804689861';
  console.log('BASE = ' + BASE + '  id = ' + id + '\n');

  console.log('[1] /api/item（它内部还会自己拉相关壁纸）');
  const item = await timeIt('/api/item', '/api/item?id=' + id);
  const creator = (item && item.author && item.author.steamId) || (item && item.item && item.item.creator) || '';
  console.log('  creator = ' + creator);

  if (creator) {
    console.log('\n[2] /api/author（相关壁纸的数据源，单独计时）');
    await timeIt('/api/author p1', '/api/author?id=' + creator + '&page=1&pageSize=30');
    await timeIt('/api/author p1 again', '/api/author?id=' + creator + '&page=1&pageSize=30');
  }
})().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
