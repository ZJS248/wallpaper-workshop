'use strict';
/**
 * 统计"同类目 OR"实际会拆成多少次请求 —— 决定合并策略怎么做。
 * 现实里用户通常是"几类各选一点"，不是"分辨率全选 24 个"。
 */
const RES = [
  'Standard Definition', '1280 x 720', '1366 x 768', '1920 x 1080', '2560 x 1440', '3840 x 2160',
  'Portrait Standard Definition', 'Portrait 720 x 1280', 'Portrait 1080 x 1920',
  'Portrait 1440 x 2560', 'Portrait 2160 x 3840',
  'Ultrawide 2560 x 1080', 'Ultrawide 3440 x 1440',
  'Dual Standard Definition', 'Dual 3840 x 1080', 'Dual 5120 x 1440', 'Dual 7680 x 2160',
  'Triple Standard Definition', 'Triple 4096 x 768', 'Triple 5760 x 1080', 'Triple 7680 x 1440',
  'Triple 11520 x 2160',
  'Dynamic resolution', 'Other resolution',
];

/** 给一个"全选"的极端值算一下代价 */
function cost(label, groups) {
  const width = groups.reduce((a, g) => a * Math.max(1, g.length), 1);
  const ands = groups.length;
  console.log(
    '  ' + label.padEnd(30) +
      ' 组数=' + String(ands).padStart(2) +
      '  OR 组合=' + String(width).padStart(6) +
      '  单页请求数=' + String(width).padStart(6) +
      '  单页耗时≈' + String((width * 1.2).toFixed(1)).padStart(7) + 's'
  );
  return width;
}

console.log('现实场景（按 1200ms/请求 的限流估算）：');
cost('1 个分辨率', [['3840 x 2160']]);
cost('3 个分辨率', [RES.slice(4, 7)]);
cost('3 分辨率 + 1 类型', [RES.slice(4, 7), ['Scene']]);
cost('3 分辨率 + 3 分级', [RES.slice(4, 7), ['Everyone', 'Questionable', 'Mature']]);
cost('5 分辨率 + 1 类型 + 3 分级', [RES.slice(4, 9), ['Scene'], ['Everyone', 'Questionable', 'Mature']]);
cost('分辨率全选 24 个', [RES]);
cost('分辨率全选 + 类型全选 + 分级全选', [RES, ['Scene', 'Video', 'Web'], ['Everyone', 'Questionable', 'Mature']]);

console.log('\n结论：把所有组都按"组合展开"是不可行的（全选就是 216 次请求）。');
console.log('可行做法：**逐值轮询合并**（每个值各取一页，轮流取，直到凑够一页），');
console.log('这样第 N 页的请求数仍然是"值的个数"，而不是组合数。');
