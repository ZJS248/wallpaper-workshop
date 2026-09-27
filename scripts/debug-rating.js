'use strict';
/**
 * 排查 BUG-03（评分全空）：确认 GetPublishedFileDetails 是否真的返回 vote_data，
 * 以及 browse 页里是否有 rating 字段可用。
 *
 * 用法：node scripts/debug-rating.js
 */
const httpClient = require('../server/lib/httpClient');
const settings = require('../server/lib/settings');
const session = require('../server/lib/session');

const IDS = ['884307090', '1081733658', '2358176341', '2447928310', '2794098047', '3807151772'];

(async function main() {
  const cfg = settings.getConfig();
  const ctx = session.currentContext();
  console.log('proxy =', cfg.proxy || '(direct)');

  const form = { itemcount: IDS.length };
  IDS.forEach((id, i) => {
    form['publishedfileids[' + i + ']'] = id;
  });

  const res = await httpClient.postApiForm(
    'https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/',
    form,
    { proxy: ctx.proxy, timeout: 30000, noLimit: true }
  );
  console.log('HTTP', res.status, 'bytes', (res.body || '').length);
  let json;
  try {
    json = JSON.parse(res.body);
  } catch (e) {
    console.log('非 JSON：', String(res.body).slice(0, 300));
    return;
  }
  const arr = (json.response && json.response.publishedfiledetails) || [];
  console.log('返回', arr.length, '条');
  arr.forEach((d) => {
    console.log('---', d.publishedfileid, 'result=', d.result);
    console.log('    title      :', String(d.title || '').slice(0, 40));
    console.log('    vote_data  :', JSON.stringify(d.vote_data));
    console.log('    star_rating:', d.star_rating, ' total_votes:', d.total_votes);
    console.log('    num_comments_public:', d.num_comments_public);
    const keys = Object.keys(d).filter((k) => /vote|rating|score|comment/i.test(k));
    console.log('    相关键     :', keys.join(', '));
    console.log('    全部键     :', Object.keys(d).join(', '));
  });
})().catch((e) => {
  console.error('失败：', e.stack || e.message);
  process.exit(1);
});
