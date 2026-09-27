'use strict';
/** 检查商店接口（应用信息）是否可用 —— /api/status 里的 app 字段靠它 */
const settings = require('../server/lib/settings');
const webApi = require('../server/lib/steamWebApi');

(async () => {
  const cfg = settings.loadSettings();
  console.log('proxy = ' + (cfg.proxy || '(直连)'));
  const r = await webApi.getAppInfo({ proxy: cfg.proxy });
  console.log('ok     = ' + r.ok);
  console.log('reason = ' + (r.reason || '无'));
  if (r.data) {
    console.log('name   = ' + r.data.name);
    console.log('type   = ' + r.data.type);
    console.log('header = ' + String(r.data.header_image || '').slice(0, 90));
  } else {
    console.log('data   = (无)');
  }
})().catch((e) => {
  console.error('失败：' + e.message);
  process.exit(1);
});
