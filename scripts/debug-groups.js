'use strict';
/** 调试：g= 参数到底被解析成了什么 */
const { URL } = require('url');

const qs = 'sort=trend&days=7&pageSize=24&g=' + encodeURIComponent('resolution:3840 x 2160,2560 x 1440');
const u = new URL('http://x/api/browse?' + qs);
console.log('查询串: ' + u.search);
console.log('getAll(g) = ' + JSON.stringify(u.searchParams.getAll('g')));

const orGroups = u.searchParams
  .getAll('g')
  .map((s) =>
    String(s)
      .split(':')
      .slice(1)
      .join(':')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)
  )
  .filter((g) => g.length);

console.log('解析出的 orGroups = ' + JSON.stringify(orGroups));
console.log('');
console.log('>>> 注意：URLSearchParams 会把 "+" 解码成空格。');
console.log('    "3840 x 2160" 里没有 +，但如果标签里真的带 + 号（如 "3840+x+2160"），');
console.log('    append 时加号必须转义成 %2B，否则会被解码成空格。');
console.log('    这里先确认分隔符与冒号没有被误伤。');
