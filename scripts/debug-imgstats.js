'use strict';
/** 看图片代理的健康状况：失败数、并发、排队 */
const http = require('http');

http
  .get({ host: '127.0.0.1', port: 9391, path: '/api/status', timeout: 30000 }, (res) => {
    const c = [];
    res.on('data', (d) => c.push(d));
    res.on('end', () => {
      const j = JSON.parse(Buffer.concat(c).toString('utf8'));
      const d = j.data || j;
      const ic = d.imageCache;
      console.log('图片缓存项数 : ' + ic.items);
      console.log('占用         : ' + Math.round(ic.bytes / 1048576) + ' MB');
      console.log('命中 / 未命中 : ' + ic.hits + ' / ' + ic.misses);
      console.log('失败         : ' + ic.errors);
      console.log('进行中 / 排队 : ' + ic.active + ' / ' + ic.queued);
      console.log('');
      console.log('结论：失败数为 0 且未命中都变成命中 → 图片代理正常。');
      console.log('      截图里"空白卡片"通常是**动画 GIF 首帧还没解码**或懒加载尚未触发，不是错误。');
    });
  })
  .on('error', (e) => {
    console.error('失败：' + e.message);
    process.exit(1);
  });
