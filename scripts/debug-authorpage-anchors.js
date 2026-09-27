'use strict';
/** 看个人创意工坊页上有没有作者昵称/头像可用（给"同作者作品"补作者名） */
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'config', 'shots', 'myworkshopfiles.html');
if (!fs.existsSync(file)) {
  console.error('缺样本，先跑 node scripts/debug-myworkshopfiles.js');
  process.exit(2);
}
const h = fs.readFileSync(file, 'utf8');
console.log('页面长度 ' + h.length);

for (const k of [
  'data-miniprofile',
  'friendBlock',
  'persona',
  'workshopItemAuthor',
  'PlayerLinkDetails',
  'window.SSR',
  'avatar',
  'profiles/',
]) {
  console.log('  ' + k.padEnd(22) + ' 次数=' + (h.split(k).length - 1));
}

for (const k of ['data-miniprofile', 'friendBlock', 'avatar']) {
  const i = h.indexOf(k);
  console.log('\n=== ' + k + ' @ ' + i + ' ===');
  if (i >= 0) console.log(h.slice(Math.max(0, i - 320), i + 380).replace(/\s+/g, ' '));
}
