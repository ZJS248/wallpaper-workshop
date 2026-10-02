'use strict';
/**
 * 用 Vue 2 完整版自带的编译器校验各组件的模板是否合法。
 *
 * 为什么需要：模板是写在 JS 的反引号字符串里的，`node --check` 只能保证
 * JS 语法没错，**看不出模板结构错**（标签没闭合、v-if/v-else 链断裂等）。
 * Vue 的编译器正好能把这类问题抓出来，而且不需要浏览器。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// 极简 DOM 垫片：只要让 vue.min.js 能加载即可，编译模板并不真的需要 DOM。
// 注意 window 上也要挂一份 navigator/location —— vue.min.js 读的是 window.navigator。
const el = () => ({
  style: {},
  setAttribute() {},
  appendChild() {},
  removeChild() {},
  addEventListener() {},
  removeEventListener() {},
});
const nav = { userAgent: 'node' };
const loc = { href: 'http://localhost/' };
const win = {
  document: { createElement: el, addEventListener() {}, documentElement: el() },
  navigator: nav,
  location: loc,
  addEventListener() {},
  removeEventListener() {},
};
global.window = win;
global.document = win.document;
global.location = loc;
// Node 18+ 自带只读的 navigator，直接赋值会抛 TypeError，所以这里容错
try {
  Object.defineProperty(global, 'navigator', { value: nav, configurable: true, writable: true });
} catch (e) {
  /* 拿不到就算了，Vue 编译模板用不到它 */
}

/*
 * vue.min.js 是 UMD 包：在 Node 里它走 `module.exports` 分支，
 * **不会**挂到 window.Vue 上（浏览器里才挂）。所以这里直接 require，
 * 而不是 eval —— 之前用 eval 拿不到 Vue.compile 就是这个原因。
 */
const Vue = require(path.join(ROOT, 'public/vendor/vue.min.js'));
if (!Vue || typeof Vue.compile !== 'function') {
  console.error('拿不到 Vue.compile（vue.min.js 不是完整版？）');
  process.exit(1);
}

const files = [
  'src/components/detail-pane.js',
  'src/components/wp-card.js',
  'src/components/filter-panel.js',
  'src/components/settings-drawer.js',
  'src/components/context-menu.js',
];

let bad = 0;
for (const f of files) {
  const full = path.join(ROOT, f);
  if (!fs.existsSync(full)) continue;
  const src = fs.readFileSync(full, 'utf8');
  const m = src.match(/template:\s*`([\s\S]*?)`\s*,\s*\n\s*\}\);/);
  if (!m) {
    console.log('  ? 未能提取模板（跳过）: ' + f);
    continue;
  }
  try {
    Vue.compile(m[1]);
    console.log('  \u2713 模板编译通过: ' + f);
  } catch (e) {
    bad++;
    console.log('  \u2717 模板编译失败: ' + f + '  ->  ' + e.message);
  }
}
console.log(bad ? '\n有 ' + bad + ' 个模板不合法' : '\n全部模板合法');
process.exit(bad ? 1 : 0);
