'use strict';
/**
 * 给 GetPublishedFileDetails 与 getWorksByCreator 计时（定位 /api/author 162s）。
 * 用法：node scripts/probe-details-timing.js
 */
const steamApi = require('../server/lib/steamApi');
const settings = require('../server/lib/settings');
const session = require('../server/lib/session');

(async function main() {
  const cfg = settings.getConfig();
  const ctx = session.currentContext();
  console.log('proxy =', cfg.proxy, '\n');

  const ids = ['3804689861'];
  for (let i = 0; i < 3; i++) {
    const t = Date.now();
    try {
      const r = await steamApi.getDetails(ids, ctx);
      console.log('getDetails 第 ' + (i + 1) + ' 次  ' + String(Date.now() - t).padStart(7) + ' ms  ok=' + r.ok + ' n=' + (r.items || []).length + ' reason=' + (r.reason || ''));
    } catch (e) {
      console.log('getDetails 第 ' + (i + 1) + ' 次  ' + String(Date.now() - t).padStart(7) + ' ms  ERR ' + e.message);
    }
  }

  console.log('');
  for (let i = 0; i < 2; i++) {
    const t = Date.now();
    try {
      const r = await steamApi.getWorksByCreator('76561198866437317', { page: 1, pageSize: 30 }, ctx);
      console.log('getWorksByCreator 第 ' + (i + 1) + ' 次  ' + String(Date.now() - t).padStart(7) + ' ms  ok=' + r.ok + ' n=' + (r.items || []).length + ' total=' + r.total + ' reason=' + (r.reason || ''));
    } catch (e) {
      console.log('getWorksByCreator 第 ' + (i + 1) + ' 次  ' + String(Date.now() - t).padStart(7) + ' ms  ERR ' + e.message);
    }
  }
})().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
