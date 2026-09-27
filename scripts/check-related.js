'use strict';
/**
 * 检查「相关壁纸」的数据是否完整。
 *
 * 注意：相关壁纸现在**不在 /api/item 里同步返回**了（它要另外打一次作者个人创意工坊页，
 * 塞在详情里会让详情面板迟迟不显示）。前端是并发去调 /api/author 的。
 * 所以这里两条都测：
 *   1. /api/item           → 应当立刻返回，且 related 为 null、creatorId 有值
 *   2. /api/item?related=1 → 兼容路径，应当带上 related
 *   3. /api/author         → 前端真正使用的那个接口
 */
const http = require('http');

function get(path) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: 9391, path, timeout: 180000 }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (e) {
            reject(new Error('非 JSON：' + Buffer.concat(chunks).toString('utf8').slice(0, 200)));
          }
        });
      })
      .on('error', reject)
      .on('timeout', function () {
        this.destroy(new Error('timeout'));
      });
  });
}

(async () => {
  // 先拿一个真实 id
  const list = await get('/api/browse?sort=trend&days=7&page=1&pageSize=5');
  const data = list.data || list;
  const first = data.items && data.items[0];
  if (!first) {
    console.log('列表为空，无法继续');
    process.exit(1);
  }
  console.log('样本作品：' + first.id + '  ' + first.title);

  const t0 = Date.now();
  const raw = await get('/api/item?id=' + first.id);
  const itemMs = Date.now() - t0;
  const d = raw.data || raw;

  console.log('\n--- /api/item（应当很快、related=null） ---');
  console.log('耗时          : ' + itemMs + ' ms');
  console.log('ok            : ' + d.ok);
  console.log('item.title    : ' + (d.item && d.item.title));
  console.log('creatorId     : ' + d.creatorId);
  console.log('author        : ' + JSON.stringify(d.author));
  console.log('pageOk        : ' + d.pageOk);
  console.log('apiError      : ' + (d.apiError || '无'));
  console.log('related       : ' + JSON.stringify(d.related));

  const creator = d.creatorId || (d.author && d.author.steamId);
  if (!creator) {
    console.log('\n✗ 拿不到 creatorId，无法继续查相关壁纸');
    process.exit(1);
  }
  if (itemMs > 20000) {
    console.log('\n✗ /api/item 超过 20 秒 —— 相关壁纸可能又被塞回关键路径了');
    process.exit(1);
  }

  console.log('\n--- /api/author（前端真正用的接口） ---');
  const t1 = Date.now();
  const au = await get('/api/author?id=' + creator + '&page=1&pageSize=30');
  const a = au.data || au;
  console.log('耗时          : ' + (Date.now() - t1) + ' ms');
  console.log('ok            : ' + a.ok + (a.error ? '  error=' + a.error : ''));
  console.log('creator       : ' + JSON.stringify(a.creator));
  console.log('totalCount    : ' + a.totalCount);
  console.log('items         : ' + (a.items || []).length);
  (a.items || []).slice(0, 5).forEach((i) => console.log('    ' + i.id + '  ' + String(i.title).slice(0, 46)));

  console.log('\n--- /api/item?related=1（兼容路径） ---');
  const raw2 = await get('/api/item?id=' + first.id + '&related=1');
  const d2 = raw2.data || raw2;
  const r = d2.related;
  if (!r) {
    console.log('related       : null  ← 兼容路径没返回相关壁纸');
    process.exit(1);
  }
  console.log('related.error : ' + (r.error || '无'));
  console.log('related.total : ' + r.totalCount);
  console.log('related.items : ' + (r.items || []).length);
})().catch((e) => {
  console.error('失败：' + e.message);
  process.exit(2);
});
