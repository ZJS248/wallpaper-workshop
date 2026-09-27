'use strict';
/**
 * 调试图片代理：直连 CDN 看返回什么，以及 /img 代理是否正常。
 * Akamai 会按 Referer / User-Agent 返回占位图，这里把几种组合都打出来。
 */
const path = require('path');
const fs = require('fs');
const settings = require('../server/lib/settings');
const httpClient = require('../server/lib/httpClient');

const SAMPLE =
  process.argv[2] ||
  'https://images.steamusercontent.com/ugc/14542344382741570878/0ABB17ADC57DB1D34EA7929FB37ECD66B89D77DD/';

(async () => {
  const cfg = settings.loadSettings();
  const variants = [
    { name: '无额外头', headers: {} },
    { name: '带 Referer', headers: { Referer: 'https://steamcommunity.com/' } },
    { name: '带 Referer+UA', headers: { Referer: 'https://steamcommunity.com/', 'User-Agent': httpClient.DEFAULT_UA } },
    { name: 'steamReferer', headers: { Referer: 'https://steamcommunity.com/sharedfiles/filedetails/' } },
  ];

  const outDir = path.join(__dirname, '..', 'config', 'shots');
  fs.mkdirSync(outDir, { recursive: true });

  for (const v of variants) {
    try {
      const r = await httpClient.getText(SAMPLE, {
        proxy: cfg.proxy,
        timeout: 20000,
        noLimit: true,
        headers: Object.assign({ Accept: 'image/*,*/*;q=0.8' }, v.headers),
      });
      const len = Buffer.byteLength(r.body, 'utf8');
      const type = r.headers['content-type'];
      const disposition = r.headers['content-disposition'] || '';
      console.log(
        v.name.padEnd(16),
        'HTTP ' + r.status,
        String(len).padStart(8) + 'B',
        String(type).padEnd(12),
        disposition ? 'disp=' + disposition : ''
      );
      const safe = v.name.replace(/[^\w]/g, '_');
      fs.writeFileSync(path.join(outDir, 'img-' + safe + '.bin'), Buffer.from(r.body, 'utf8'));
    } catch (e) {
      console.log(v.name.padEnd(16), 'ERR ' + e.message);
    }
  }

  console.log('\n--- 通过本地 /img 代理 ---');
  const proxied = 'http://127.0.0.1:9391/img?u=' + encodeURIComponent(SAMPLE);
  const r2 = await httpClient.getText(proxied, { proxy: '', timeout: 20000, noLimit: true });
  console.log('HTTP', r2.status, '长度', Buffer.byteLength(r2.body, 'utf8'), 'X-Cache', r2.headers['x-cache'], 'type', r2.headers['content-type']);

  // 再取一次看缓存命中
  const r3 = await httpClient.getText(proxied, { proxy: '', timeout: 20000, noLimit: true });
  console.log('第二次 HTTP', r3.status, 'X-Cache', r3.headers['x-cache']);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
