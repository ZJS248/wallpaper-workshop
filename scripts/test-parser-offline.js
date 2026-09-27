'use strict';
/**
 * 个人创意工坊页解析器单测（**完全离线**，用内联 HTML 片段）。
 *
 * 为什么要单独测这个：
 *  个人页有**两种完全不同的列表结构**，而且很容易只测到其中一种：
 *    A) browsefilter=mysubscriptions / myfavorites → `workshopItemSubscription` 块
 *       （注意：id 属性在 class **之后**，标题在 workshopItemSubscriptionDetails **之后**）
 *    B) 作者公开作品（默认 section）→ `workshopItem` + `class="ugc"` 块
 *  曾经踩过的坑：按 `class="workshopItemSubscription" ... class="workshopItemSubscriptionDetails"`
 *  切一段来解析，结果标题永远取不到（实测 10 条里 0 条有标题），因为标题在细节块之后。
 *  所以这里把两种结构都做成固定样本，改解析器时能立刻发现回归。
 */

const authorPage = require('../server/lib/authorPage');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  console.log((cond ? '  \u2713 ' : '  \u2717 ') + name + (extra ? '  \u2014 ' + extra : ''));
  cond ? pass++ : fail++;
}

/* ---------------- 样本 A：订阅 / 收藏视图 ---------------- */
const HTML_SUBS = `
<html><body>
<form method="POST" name="PublishedFileUnsubscribe" action="https://steamcommunity.com/sharedfiles/unsubscribe">
  <input type="hidden" name="sessionid" value="abc123">
</form>
<div data-panel="{&quot;type&quot;:&quot;PanelGroup&quot;}" class="workshopItemSubscription" id="Subscription3807671971">
  <img src="https://images.steamusercontent.com/ugc/15613894782026851914/AAA/?imw=100&imh=100&ima=fit&impolicy=Letterbox&imcolor=%23000000&letterbox=true" class="backgroundImg" />
  <div class="itemContents">
    <div class="workshopItemPreviewHolderFloatLeft">
      <a href="https://steamcommunity.com/sharedfiles/filedetails/?id=3807671971">
        <div class="workshopItemPreviewHolder">
          <img class="workshopItemPreviewImage" src="https://images.steamusercontent.com/ugc/15613894782026851914/AAA/?imw=100&letterbox=true"/>
        </div>
      </a>
    </div>
    <div class="workshopItemSubscriptionDetails">
      <a href="https://steamcommunity.com/sharedfiles/filedetails/?id=3807671971">
        <div class="workshopItemTitle">Happy Mid Autumn Festival! [CPK!] (Audio Responsive)</div>
      </a>
      <div class="workshopItemApp">Wallpaper Engine</div>
      <div class="workshopItemDate">订阅时间 9 月 25 日 下午 3:16</div>
    </div>
    <div class="subscriptionControls"><span class="action_wait"></span></div>
  </div>
</div>
<div data-panel="{&quot;type&quot;:&quot;PanelGroup&quot;}" class="workshopItemSubscription" id="Subscription3807664331">
  <img src="https://images.steamusercontent.com/ugc/999/BBB/?imw=100&imh=100&letterbox=true" class="backgroundImg" />
  <div class="itemContents">
    <div class="workshopItemSubscriptionDetails">
      <a href="https://steamcommunity.com/sharedfiles/filedetails/?id=3807664331">
        <div class="workshopItemTitle">Ellen Joe【ZZZ】</div>
      </a>
    </div>
  </div>
</div>
<div class="workshopBrowsePagingInfo">正在显示第 1 - 10 项，共 180 项条目</div>
</body></html>
`;

/* ---------------- 样本 B：作者公开作品视图 ---------------- */
const HTML_WORKS = `
<html><body>
<div class="workshopBrowseItems">
  <div data-panel="{&quot;type&quot;:&quot;PanelGroup&quot;}" class="workshopItem">
    <a href="https://steamcommunity.com/sharedfiles/filedetails/?id=3652174311" class="ugc" data-appid="431960" data-publishedfileid="3652174311">
      <div id="sharedfile_3652174311" class="workshopItemPreviewHolder ">
        <img class="workshopItemPreviewImage " src="https://images.steamusercontent.com/ugc/14838931263772175061/CCC/?imw=200&imh=200&ima=fit&impolicy=Letterbox&letterbox=true">
        <div class="workshopItemSubscriptionControls aspectratio_square"><span class="action_wait"></span></div>
      </div>
    </a>
    <img class="workshop_checkmark" src="x.png" style="display: none;">
    <img class="fileRating" src="y.png" />
    <a data-panel="{&quot;focusable&quot;:false}" href="https://steamcommunity.com/sharedfiles/filedetails/?id=3652174311" class="item_link">
      <div class="workshopItemTitle ellipsis">《忘却前夜:Morimens》4K丨奥尔拉-HORLA-灰烬玫瑰</div>
    </a>
    <div class="workshopItemApp">Wallpaper Engine</div>
  </div>
  <div data-panel="{&quot;type&quot;:&quot;PanelGroup&quot;}" class="workshopItem">
    <a href="https://steamcommunity.com/sharedfiles/filedetails/?id=3652163154" class="ugc" data-publishedfileid="3652163154">
      <div class="workshopItemPreviewHolder">
        <img class="workshopItemPreviewImage" src="https://images.steamusercontent.com/ugc/111/DDD/?imw=200&letterbox=true">
      </div>
    </a>
    <a href="https://steamcommunity.com/sharedfiles/filedetails/?id=3652163154" class="item_link">
      <div class="workshopItemTitle ellipsis">忘却前夜:Morimens丨环行·拉蒙娜-RAMONA-幻梦假日</div>
    </a>
  </div>
</div>
<div class="workshopBrowsePagingInfo">正在显示第 1 - 9 项，共 56 项条目</div>
</body></html>
`;

/* ---------------- 样本 C：空列表 ---------------- */
const HTML_EMPTY = '<html><body><div class="workshopBrowsePagingInfo">没有找到任何项目</div></body></html>';

console.log('【A】订阅 / 收藏视图');
{
  const r = authorPage.parseAuthorWorksHtml(HTML_SUBS, '76561198374255138', 1, 10);
  check('解析成功', r.ok, r.reason || '');
  check('条目数正确', r.items.length === 2, r.items.length + ' 条');
  check('总数正确', r.total === 180, 'total=' + r.total);
  // 上游页大小恒为 30（实测只有 numperpage=30 生效，其它值退化成 10 条/页），
  // 所以解析器报的是"上游页数"；"每页 60/100"由 pageStore 在上层拼页。
  check('上游页数正确（180 / 30 = 6）', r.upstreamPages === 6, 'upstreamPages=' + r.upstreamPages);
  check('上游页大小是 30', r.upstreamPageSize === 30, String(r.upstreamPageSize));
  check('id 正确', r.items[0].id === '3807671971' && r.items[1].id === '3807664331', r.items.map((i) => i.id).join(','));
  check('标题取到了（关键回归点）', r.items[0].title === 'Happy Mid Autumn Festival! [CPK!] (Audio Responsive)', JSON.stringify(r.items[0].title));
  check('第二条标题也在', r.items[1].title === 'Ellen Joe【ZZZ】', JSON.stringify(r.items[1].title));
  check('缩略图取到了', /steamusercontent/.test(r.items[0].previewUrl), r.items[0].previewUrl.slice(0, 60));
  check('缩略图去掉了 Letterbox 参数', !/letterbox|imw=/.test(r.items[0].previewUrl), r.items[0].previewUrl.slice(-40));
  check('creator 被写入', r.items.every((i) => i.creator === '76561198374255138'), '');
}

console.log('\n【B】作者公开作品视图');
{
  const r = authorPage.parseAuthorWorksHtml(HTML_WORKS, '76561199207268259', 1, 10);
  check('解析成功', r.ok, r.reason || '');
  check('条目数正确', r.items.length === 2, r.items.length + ' 条');
  check('总数正确', r.total === 56, 'total=' + r.total);
  check('id 正确', r.items[0].id === '3652174311', r.items[0].id);
  check('标题取到了（标题在 </a> 之后）', r.items[0].title === '《忘却前夜:Morimens》4K丨奥尔拉-HORLA-灰烬玫瑰', JSON.stringify(r.items[0].title));
  check('第二条标题也在', /RAMONA/.test(r.items[1].title), JSON.stringify(r.items[1].title));
  check('缩略图取到了', /steamusercontent/.test(r.items[0].previewUrl), '');
}

console.log('\n【C】空列表');
{
  const r = authorPage.parseAuthorWorksHtml(HTML_EMPTY, '76561198374255138', 1, 10);
  /**
   * 语义变化（有意为之）：空页现在算 **ok:true**。
   *
   * 原因：翻到最后一页之后 Steam 会返回一个"正常但空"的列表页。
   * 如果判成 ok:false，"每页 100 条"在只有 50 个作品时就会因为
   * 第 2~4 页为空而被当成"解析失败"，整页只剩第 1 页的 30 条。
   * 所以解析器区分「页面认出来了」（ok）与「页面上一条目都没有」（items 为空）。
   */
  check('空页算成功（页面认出来了，只是没有条目）', r.ok === true, 'ok=' + r.ok);
  check('recognized 标记为真', r.recognized === true, String(r.recognized));
  check('给出可读原因', /没有条目|翻到末尾/.test(r.reason), r.reason);
  check('items 为空数组', Array.isArray(r.items) && r.items.length === 0, '');
}

console.log('\n【C2】完全不认识的页面才报失败');
{
  const r = authorPage.parseAuthorWorksHtml('<html><body>hello</body></html>', '76561198374255138', 1, 10);
  check('不认识的页面 ok:false', r.ok === false, 'ok=' + r.ok);
  check('原因说"没有解析到作品"', /没有解析到作品/.test(r.reason), r.reason);
}

console.log('\n【D】去重与健壮性');
{
  const dup = HTML_WORKS + HTML_WORKS; // 同一批内容拼接
  const r = authorPage.parseAuthorWorksHtml(dup, '76561199207268259', 1, 10);
  check('重复内容被去重', r.items.length === 2, r.items.length + ' 条（期望 2）');
  const weird = '<html><body><div class="workshopItemSubscription" id="Subscription123">没有标题也没有图</div></body></html>';
  const r2 = authorPage.parseAuthorWorksHtml(weird, '1', 1, 10);
  check('字段缺失也不崩', r2.items.length === 1 && r2.items[0].id === '123', JSON.stringify(r2.items[0] || null));
}

console.log('\n个人页解析器单测：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
