'use strict';
/**
 * 校验 /img 代理返回的字节是不是合法图片（魔数 + 尺寸）。
 * 只看"长度"会被骗：二进制被 utf8 破坏后长度依然很大，但浏览器渲染不出来。
 */
const settings = require('../server/lib/settings');
const httpClient = require('../server/lib/httpClient');

const IDS = process.argv.slice(2);

const SIGS = [
  { name: 'JPEG', test: (b) => b[0] === 0xff && b[1] === 0xd8 },
  { name: 'PNG', test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { name: 'GIF', test: (b) => b.slice(0, 3).toString('latin1') === 'GIF' },
  { name: 'WEBP', test: (b) => b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP' },
];

function sniff(buf) {
  for (const s of SIGS) if (s.test(buf)) return s.name;
  return 'UNKNOWN(' + buf.slice(0, 8).toString('hex') + ')';
}

/** 从 PNG / GIF 头部读宽高 */
function size(buf) {
  try {
    if (sniff(buf) === 'PNG') return buf.readUInt32BE(16) + 'x' + buf.readUInt32BE(20);
    if (sniff(buf) === 'GIF') return buf.readUInt16LE(6) + 'x' + buf.readUInt16LE(8);
  } catch (e) {
    /* ignore */
  }
  return '?';
}

(async () => {
  const cfg = settings.loadSettings();
  let ids = IDS;
  if (!ids.length) {
    const api = require('../server/lib/steamApi');
    const ctx = { cookie: cfg.cookie, proxy: cfg.proxy };
    const r = await api.queryWorkshop({ sort: 'trend', days: 7, page: 1, pageSize: 6 }, ctx);
    ids = (r.items || []).map((i) => i.id);
    console.log('用 trend 前 6 条做样本：' + ids.join(', '));
    var items = r.items;
  }

  let bad = 0;
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    let url = items && items[i] ? items[i].previewUrl : null;
    if (!url) {
      const d = await require('../server/lib/steamApi').getDetails([id], { proxy: cfg.proxy });
      url = d.items[0] && d.items[0].previewUrl;
    }
    if (!url) {
      console.log(id, '拿不到预览图地址');
      bad++;
      continue;
    }
    const proxied = 'http://127.0.0.1:9391/img?u=' + encodeURIComponent(url);
    const r = await httpClient.getText(proxied, { proxy: '', timeout: 25000, noLimit: true });
    const buf = r.buffer || Buffer.from(r.body, 'utf8');
    const kind = sniff(buf);
    const ok = kind !== 'UNKNOWN' && !kind.startsWith('UNKNOWN');
    if (!ok) bad++;
    console.log(
      (ok ? '  ✓ ' : '  ✗ ') + id.padEnd(12),
      String(buf.length).padStart(9) + 'B',
      kind.padEnd(8),
      size(buf).padEnd(11),
      String(r.headers['content-type'] || '').padEnd(10),
      'X-Cache=' + (r.headers['x-cache'] || '-')
    );
  }
  console.log('\n不合法的图片数: ' + bad + (bad ? '  ← 有问题' : '  ← 全部正常'));
  process.exit(bad ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(2);
});
