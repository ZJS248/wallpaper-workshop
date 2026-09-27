'use strict';
/** 调试：把两种视图的"一个条目"完整结构打印出来，好写准正则 */
const fs = require('fs');
const path = require('path');

function show(label, file, marker, span) {
  const p = path.join(__dirname, '..', 'config', file);
  if (!fs.existsSync(p)) {
    console.log('(缺样本 ' + file + ')');
    return;
  }
  const html = fs.readFileSync(p, 'utf8');
  const i = html.indexOf(marker);
  console.log('\n========== ' + label + ' ==========');
  console.log('marker "' + marker + '" @ ' + i);
  if (i < 0) return;
  const seg = html.slice(Math.max(0, i - 80), i + (span || 2000));
  // 给标签加换行，方便看层级
  console.log(seg.replace(/></g, '>\n<'));
}

show('订阅视图（第一个条目）', 'shots/myworkshopfiles.html', 'workshopItemSubscription', 2200);
show('公开作品视图（第一个条目）', 'debug-author.html', 'class="workshopItem"', 1800);
