'use strict';
/** 调试：打印配置探测结果（父项目、代理、Cookie 来源） */
const settings = require('../server/lib/settings');
const sc = require('../server/lib/steamCommunity');

const parent = settings.readParentSettings();
console.log('父项目探测：', parent.found ? parent.dir : '(没找到)');
console.log('  父项目 cookie 长度 ：', (parent.cookie || '').length);
console.log('  父项目 刷新令牌长度 ：', (parent.refreshToken || '').length);
console.log('  父项目 steamid     ：', parent.steamid || '(无)');
console.log('  父项目 httpsProxy  ：', parent.httpsProxy || parent.httpProxy || '(无)');

const dsh = settings.readDshProxyConf();
console.log('dsh 代理配置：', JSON.stringify(dsh));

const cfg = settings.loadSettings();
console.log('\n最终配置：');
console.log('  proxy        =', cfg.proxy || '(直连)', '来源:', cfg.proxySource);
console.log('  cookie 长度   =', (cfg.cookie || '').length, '来源:', cfg.cookieSource);
console.log('  refreshToken =', (cfg.refreshToken || '').length ? '有' : '无');
console.log('  fetchDetail 用的是同一个 cookie：', cfg.cookie === parent.cookie ? '是' : '否');
const jwt = sc.parseSteamJwt(cfg.cookie);
if (jwt.present) {
  console.log('  JWT exp      =', jwt.exp ? new Date(jwt.exp).toLocaleString('zh-CN') : '?');
  console.log('  JWT 绑定 IP   =', jwt.ipSubject || '?');
  console.log('  JWT 剩余      =', jwt.exp ? Math.round((jwt.exp - Date.now()) / 3600000) + ' 小时' : '?');
} else {
  console.log('  JWT          = 无 steamLoginSecure');
}
