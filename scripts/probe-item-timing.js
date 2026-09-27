'use strict';
/**
 * 给 /api/item 计时（排查"详情面板好久不出来"）。
 * 用法：node scripts/probe-item-timing.js [id...]
 */
const BASE = process.env.WW_BASE || 'http://127.0.0.1:9391';
const IDS = process.argv.slice(2).length ? process.argv.slice(2) : ['3804689861', '884307090', '2358176341'];

(async function main() {
  for (const id of IDS) {
    const t = Date.now();
    try {
      const r = await fetch(BASE + '/api/item?id=' + id);
      const j = await r.json();
      const d = j.data || j;
      console.log(
        id + '  ' + String(Date.now() - t).padStart(6) + ' ms  ok=' + d.ok +
        '  partial=' + !!d.partial +
        '  title=' + JSON.stringify((d.item && d.item.title || '').slice(0, 30)) +
        '  related=' + (d.related && d.related.totalCount) +
        (d.error ? '  error=' + d.error : '')
      );
    } catch (e) {
      console.log(id + '  ' + (Date.now() - t) + ' ms  ERR ' + e.message);
    }
  }
})().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
