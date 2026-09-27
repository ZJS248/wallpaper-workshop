'use strict';
/**
 * 验证「同类目 OR、跨类目 AND」筛选语义（用户报的 bug：勾 6 个分辨率一条都不出）。
 * 直接打本地接口，模拟前端会发出的查询串。
 */
const http = require('http');

function get(path) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: 9391, path, timeout: 180000 }, (res) => {
        const c = [];
        res.on('data', (d) => c.push(d));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(c).toString('utf8')));
          } catch (e) {
            reject(new Error('非 JSON：' + Buffer.concat(c).toString('utf8').slice(0, 200)));
          }
        });
      })
      .on('error', reject)
      .on('timeout', function () {
        this.destroy(new Error('timeout'));
      });
  });
}

const RES6 = [
  '2560 x 1440', '3840 x 2160', 'Portrait 2160 x 3840',
  'Ultrawide 3440 x 1440', 'Dual 5120 x 1440', 'Dual 7680 x 2160',
];

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  console.log((cond ? '  \u2713 ' : '  \u2717 ') + name + (extra ? '  \u2014 ' + extra : ''));
  cond ? pass++ : fail++;
}

(async () => {
  console.log('【1】用户实际点法：分辨率勾 6 个（组内 OR）');
  const q1 = 'g=' + encodeURIComponent('resolution:' + RES6.join(','));
  const r1 = await get('/api/browse?sort=trend&days=7&pageSize=24&' + q1);
  const d1 = r1.data || r1;
  check('有结果（不再是 0）', d1.ok && d1.items.length > 0, '总数≈' + d1.totalCount + ' 本页 ' + d1.items.length + ' 条');
  const res6 = d1.items.filter((i) => RES6.some((t) => i.tags.includes(t))).length;
  check('每一条都属于这 6 个分辨率之一', res6 === d1.items.length, res6 + '/' + d1.items.length);
  const hit = {};
  d1.items.forEach((i) => RES6.forEach((t) => { if (i.tags.includes(t)) hit[t] = (hit[t] || 0) + 1; }));
  console.log('    命中分布：' + JSON.stringify(hit));
  check('命中的分辨率不止一种（确实是 OR）', Object.keys(hit).length > 1, Object.keys(hit).length + ' 种');

  console.log('\n【2】跨类目 AND：分辨率 6 个 + 类型 Scene');
  const q2 = 'g=' + encodeURIComponent('resolution:' + RES6.join(',')) + '&g=' + encodeURIComponent('type:Scene');
  const r2 = await get('/api/browse?sort=trend&days=7&pageSize=24&' + q2);
  const d2 = r2.data || r2;
  check('有结果', d2.ok && d2.items.length > 0, '总数≈' + d2.totalCount + ' 本页 ' + d2.items.length + ' 条');
  const bad2 = d2.items.filter((i) => !i.tags.includes('Scene') || !RES6.some((t) => i.tags.includes(t)));
  check('每条都同时满足两个类目', bad2.length === 0, bad2.length ? bad2.map((i) => i.tags.join('/')).join(' | ').slice(0, 200) : 'OK');
  check('多路合并被记录', d2.merged === true, 'mergeRequests=' + d2.mergeRequests + ' 耗时=' + d2.elapsedMs + 'ms');

  console.log('\n【3】单个分辨率（对照：应当与直接查一致）');
  const r3 = await get('/api/browse?sort=trend&days=7&pageSize=5&g=' + encodeURIComponent('resolution:3840 x 2160'));
  const d3 = r3.data || r3;
  check('有结果', d3.ok && d3.items.length > 0, '总数=' + d3.totalCount + '（此前实测 571,876）');
  check('是单请求路径', d3.merged === false, 'mergeRequests=' + d3.mergeRequests);

  console.log('\n【4】单选类目 + 多选类目：类型 Scene + 分辨率 2 个');
  const r4 = await get(
    '/api/browse?sort=trend&days=7&pageSize=10&g=' + encodeURIComponent('type:Scene') +
    '&g=' + encodeURIComponent('resolution:3840 x 2160,2560 x 1440')
  );
  const d4 = r4.data || r4;
  check('有结果', d4.ok && d4.items.length > 0, '总数≈' + d4.totalCount + ' 本页 ' + d4.items.length);
  const bad4 = d4.items.filter((i) => !i.tags.includes('Scene') || !(i.tags.includes('3840 x 2160') || i.tags.includes('2560 x 1440')));
  check('语义正确', bad4.length === 0, bad4.length ? bad4.length + ' 条不符合' : 'OK');

  console.log('\n【5】翻页是否稳定（第二次应当命中缓存且内容一致）');
  const r5a = await get('/api/browse?sort=trend&days=7&pageSize=24&page=1&' + q1);
  const r5b = await get('/api/browse?sort=trend&days=7&pageSize=24&page=1&' + q1);
  const idsA = (r5a.data || r5a).items.map((i) => i.id).join(',');
  const idsB = (r5b.data || r5b).items.map((i) => i.id).join(',');
  check('同参数结果一致', idsA === idsB, '');
  check('第二次命中缓存', (r5b.data || r5b).cached === true, '耗时=' + (r5b.data || r5b).elapsedMs + 'ms（首次 ' + (r5a.data || r5a).elapsedMs + 'ms）');

  console.log('\n================ 筛选语义自检：' + pass + ' 通过 / ' + fail + ' 失败 ================');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('异常：' + (e && e.stack ? e.stack : e));
  process.exit(2);
});
