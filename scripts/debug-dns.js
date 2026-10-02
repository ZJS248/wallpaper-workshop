'use strict';
/**
 * DNS 排障：看清 steamcommunity.com 到底被解析到了哪里、是谁在撒谎。
 *
 * 用法：
 *   node scripts/debug-dns.js                        # 用配置里的出口，查 steamcommunity.com
 *   node scripts/debug-dns.js steamcommunity.com     # 指定域名
 *   node scripts/debug-dns.js steamcommunity.com http://127.0.0.1:7890   # 临时指定代理
 *
 * 排查"连不上创意工坊"时的推荐顺序：
 *   1) 先看这里的「出口」是不是你期望的那条（直连 / 代理）；
 *   2) 再看每个解析器分别回了什么 —— 被污染的地址会标出来；
 *   3) 最后看「实际采用」的结果；如果为空，说明没有可信答案，
 *      此时**必须配代理**，直连是救不回来的（实测真实 IP 也会被 RST）。
 */

const settings = require('../server/lib/settings');
const dnsResolve = require('../server/lib/dnsResolve');

const host = process.argv[2] || 'steamcommunity.com';
const proxyArg = process.argv[3];

function line(char) {
  console.log(char.repeat(72));
}

function fmt(list) {
  return list && list.length ? list.join(', ') : '（无）';
}

async function main() {
  const cfg = await settings.initAsync();
  const proxy = proxyArg !== undefined ? proxyArg : cfg.proxy || '';

  line('=');
  console.log('域名 :', host);
  console.log('出口 :', proxy || '(直连)');
  console.log('来源 :', proxyArg !== undefined ? '命令行参数' : cfg.proxySource || 'direct');
  console.log('代理自动探测 :', cfg.proxyAuto === false ? '关闭' : '开启');
  console.log('显式指定出口 :', cfg.proxyExplicit ? '是（不再自动探测）' : '否');
  line('=');

  const diag = await dnsResolve.diagnose(host, proxy);

  console.log('\n【系统 DNS】');
  console.log('  返回    :', fmt(diag.system));
  if (diag.systemPoisoned.length) {
    console.log('  其中污染:', fmt(diag.systemPoisoned));
  }
  if (diag.systemClean.length) {
    console.log('  过滤后  :', fmt(diag.systemClean));
  }

  console.log('\n【DoH 各解析器】');
  console.log('  说明：Steam 走 Akamai，每次查询可能返回不同的边缘节点，');
  console.log('        所以这里与下面「实际采用」的地址不一致是正常的（都可用）。');
  if (!diag.providers.length) {
    console.log('  （无结果）');
  }
  for (const p of diag.providers) {
    const where = p.trusted ? '墙外解析' : '墙内解析';
    const via = p.viaProxy ? '经代理' : '直连';
    console.log('  ' + p.name.padEnd(11) + ' [' + where + '/' + via + ']');
    console.log('      原始返回:', fmt(p.raw));
    if (p.poisoned && p.poisoned.length) {
      console.log('      判定污染:', fmt(p.poisoned) + '   ← 已丢弃');
    }
    if (p.clean && p.clean.length) {
      console.log('      可用    :', fmt(p.clean));
    }
  }

  console.log('\n【证书校验】候选地址是否真的持有该域名的证书');
  console.log('  说明：校验失败有两种可能 —— 该 IP 根本不是这个域名（污染），');
  console.log('        或者它是对的但直连被阻断（墙内直连就是后者，实测报 ECONNRESET）。');
  const candidates = [];
  for (const ip of diag.systemClean || []) if (!candidates.includes(ip)) candidates.push(ip);
  for (const ip of diag.doh || []) if (!candidates.includes(ip)) candidates.push(ip);
  if (!candidates.length) {
    console.log('  （没有候选地址可校验）');
  }
  for (const ip of candidates.slice(0, 6)) {
    const ok = await dnsResolve.verifyHost(ip, host, 4000);
    const isChosen = (diag.doh || []).includes(ip);
    console.log(
      '  ' + ip.padEnd(24) + (ok ? '通过' : '不通过') + (isChosen ? '   ← 本次采用' : '')
    );
  }

  console.log('\n【实际采用】');
  const chosen = await dnsResolve.resolveHost(host, proxy);
  console.log('  地址  :', fmt(chosen));
  const st = dnsResolve.stats();
  console.log('  来源  :', st.lastSource || '—');
  if (st.lastProvider) {
    console.log('  解析器:', st.lastProvider + (st.lastTrusted ? '（墙外，可信）' : '（墙内，仅兜底）'));
  }

  console.log('\n【结论】');
  console.log('  ' + diag.verdict);

  if (!chosen.length) {
    console.log('\n  ⚠ 拿不到任何可验证的解析结果。');
    console.log('    墙内直连这类域名是救不回来的（实测真实 IP 也会被 RST），');
    console.log('    请在设置 · 网络里填"出口"，或设环境变量 WW_PROXY，然后重启。');
    process.exitCode = 1;
  } else if (proxy && diag.poisoned) {
    console.log('\n  ✓ 系统 DNS 有污染，但当前走代理，解析由代理端完成，不影响使用。');
  }
}

main().catch((e) => {
  console.error('排障脚本自身出错：', e && e.stack ? e.stack : e);
  process.exitCode = 2;
});
