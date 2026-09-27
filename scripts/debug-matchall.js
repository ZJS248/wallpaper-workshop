'use strict';
/**
 * 精确测 match_all_tags 的语义与合法值。
 * 猜想：社区页只认 "match_all_tags=1" 这一种写法，
 * 传 0（或干脆不传）会被当成"非法参数"→ 直接 0 条。
 */
const settings = require('../server/lib/settings');
const sc = require('../server/lib/steamCommunity');

const BASE = 'https://steamcommunity.com/workshop/browse/?appid=431960&numperpage=10&p=1&browsesort=trend&days=7';
const TAGS = '&requiredtags%5B%5D=3840+x+2160&requiredtags%5B%5D=2560+x+1440';

const cases = {
  '两个分辨率 + match_all_tags=1（AND）': BASE + TAGS + '&match_all_tags=1',
  '两个分辨率 + match_all_tags=0': BASE + TAGS + '&match_all_tags=0',
  '两个分辨率 + 不传 match_all_tags': BASE + TAGS,
  '两个分辨率 + match_all_tags=true': BASE + TAGS + '&match_all_tags=true',
  '两个分辨率 + match_all_tags=false': BASE + TAGS + '&match_all_tags=false',
  '单个分辨率 + match_all_tags=1（对照）': BASE + '&requiredtags%5B%5D=3840+x+2160&match_all_tags=1',
  '单个分辨率 + match_all_tags=0（对照）': BASE + '&requiredtags%5B%5D=3840+x+2160&match_all_tags=0',
};

(async () => {
  const cfg = settings.loadSettings();
  for (const [name, url] of Object.entries(cases)) {
    const r = await sc.fetchBrowse({ url, cookie: cfg.cookie, proxy: cfg.proxy });
    console.log(
      '### ' + name.padEnd(38) +
        (r.ok ? '  total=' + String(r.totalCount).padStart(9) + ' 本页=' + r.items.length : '  FAIL ' + r.reason)
    );
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
