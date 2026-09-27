'use strict';
/**
 * 找出"同类目内 OR、跨类目 AND"该怎么表达。
 *
 * 背景（用户报的 bug）：分辨率分组里勾了 6 个 → 一条都出不来。
 * 因为一张壁纸只可能带**一个**分辨率标签，而当前请求是
 * `requiredtags[]=2560 x 1440&requiredtags[]=3840 x 2160&…&match_all_tags=1`
 * → "必须同时命中 6 个" → 逻辑上必然 0 条。
 *
 * 要支持的语义是 WE 那种：
 *   同组内 OR：（2560x1440 或 3840x2160 或 …）
 *   跨组 AND：（分辨率 ∈ 上面那组）且（类型 = Scene）且（分级 = Everyone）
 *
 * 候选参数形式，逐个实测：
 *   A) taggroups[0][tags][]=…  （QueryFiles 有这个参数，但社区页大概率不认）
 *   B) tags[]=…（老式写法）
 *   C) requiredtags[] 但 match_all_tags=0 → 变"命中任意一个"（跨类目也 OR，不对但先测）
 */

const settings = require('../server/lib/settings');
const sc = require('../server/lib/steamCommunity');

const RES = ['2560 x 1440', '3840 x 2160', 'Ultrawide 3440 x 1440'];
const TYPE = ['Scene'];

const cases = {
  '基线：不带标签':
    'https://steamcommunity.com/workshop/browse/?appid=431960&numperpage=10&p=1',
  '当前实现（全部 AND，6 个分辨率）':
    'https://steamcommunity.com/workshop/browse/?appid=431960&numperpage=10&p=1&match_all_tags=1' +
    '&requiredtags%5B%5D=2560+x+1440&requiredtags%5B%5D=3840+x+2160&requiredtags%5B%5D=Portrait+2160+x+3840' +
    '&requiredtags%5B%5D=Ultrawide+3440+x+1440&requiredtags%5B%5D=Dual+5120+x+1440&requiredtags%5B%5D=Dual+7680+x+2160',
  'C) requiredtags 多个 + match_all_tags=0（跨类目也 OR）':
    'https://steamcommunity.com/workshop/browse/?appid=431960&numperpage=10&p=1&match_all_tags=0' +
    '&requiredtags%5B%5D=2560+x+1440&requiredtags%5B%5D=3840+x+2160&requiredtags%5B%5D=Ultrawide+3440+x+1440',
  'B) tags[] 多个（老式写法）':
    'https://steamcommunity.com/workshop/browse/?appid=431960&numperpage=10&p=1' +
    '&tags%5B%5D=2560+x+1440&tags%5B%5D=3840+x+2160&tags%5B%5D=Ultrawide+3440+x+1440',
  'A) taggroups[0][tags][]=…':
    'https://steamcommunity.com/workshop/browse/?appid=431960&numperpage=10&p=1' +
    '&taggroups%5B0%5D%5Btags%5D%5B%5D=2560+x+1440&taggroups%5B0%5D%5Btags%5D%5B%5D=3840+x+2160' +
    '&taggroups%5B0%5D%5Btags%5D%5B%5D=Ultrawide+3440+x+1440',
  'A2) taggroups 两组（分辨率 OR + 类型 AND）':
    'https://steamcommunity.com/workshop/browse/?appid=431960&numperpage=10&p=1' +
    '&taggroups%5B0%5D%5Btags%5D%5B%5D=2560+x+1440&taggroups%5B0%5D%5Btags%5D%5B%5D=3840+x+2160' +
    '&taggroups%5B1%5D%5Btags%5D%5B%5D=Scene',
  'D) 单分辨率 + 类型（对照：应当有结果）':
    'https://steamcommunity.com/workshop/browse/?appid=431960&numperpage=10&p=1&match_all_tags=1' +
    '&requiredtags%5B%5D=3840+x+2160&requiredtags%5B%5D=Scene',
};

(async () => {
  const cfg = settings.loadSettings();
  for (const [name, url] of Object.entries(cases)) {
    const r = await sc.fetchBrowse({ url, cookie: cfg.cookie, proxy: cfg.proxy });
    if (!r.ok) {
      console.log('### ' + name + '\n    FAIL  ' + r.reason);
      continue;
    }
    const tagHist = {};
    r.items.forEach((i) => i.tags.forEach((t) => (tagHist[t] = (tagHist[t] || 0) + 1)));
    const resTags = Object.keys(tagHist).filter((t) => /\d+\s*x\s*\d+|resolution/i.test(t));
    console.log(
      '### ' + name +
        '\n    total=' + String(r.totalCount).padStart(9) +
        '  本页=' + r.items.length +
        '  本页出现的分辨率=' + (resTags.join(' / ') || '(无)')
    );
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
