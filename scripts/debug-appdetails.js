'use strict';
/** 看商店接口对一个"工具类"应用（Wallpaper Engine）到底返回什么 */
const settings = require('../server/lib/settings');
const httpClient = require('../server/lib/httpClient');

(async () => {
  const cfg = settings.loadSettings();
  const url = 'https://store.steampowered.com/api/appdetails?appids=431960&l=schinese';
  const r = await httpClient.getText(url, { proxy: cfg.proxy, noLimit: true, timeout: 20000 });
  console.log('HTTP ' + r.status + '  长度 ' + (r.buffer ? r.buffer.length : 0));
  console.log(r.body.slice(0, 700));
})().catch((e) => {
  console.error('失败：' + e.message);
  process.exit(1);
});
