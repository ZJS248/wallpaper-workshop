'use strict';
/** 调试：把接口回显的 query 打出来，确认 orGroups 有没有传到后端 */
const http = require('http');

function get(path) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: 9391, path, timeout: 120000 }, (res) => {
        const c = [];
        res.on('data', (d) => c.push(d));
        res.on('end', () => resolve(JSON.parse(Buffer.concat(c).toString('utf8'))));
      })
      .on('error', reject);
  });
}

(async () => {
  const cases = [
    ['2 个分辨率', 'g=' + encodeURIComponent('resolution:3840 x 2160,2560 x 1440')],
    ['6 个分辨率', 'g=' + encodeURIComponent('resolution:2560 x 1440,3840 x 2160,Ultrawide 3440 x 1440,1920 x 1080,1366 x 768,Dual 5120 x 1440')],
    ['2 分辨率 + 1 类型', 'g=' + encodeURIComponent('resolution:3840 x 2160,2560 x 1440') + '&g=' + encodeURIComponent('type:Scene')],
  ];
  for (const [name, q] of cases) {
    const raw = await get('/api/browse?sort=trend&days=7&pageSize=5&' + q);
    const d = raw.data || raw;
    console.log('### ' + name);
    console.log('    ok=' + d.ok + ' total=' + d.totalCount + ' items=' + (d.items || []).length +
      ' merged=' + d.merged + ' requests=' + d.mergeRequests);
    console.log('    回显 query = ' + JSON.stringify(d.query));
    if (d.error) console.log('    error = ' + d.error);
    console.log('');
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
