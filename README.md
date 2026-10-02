# wallpaper-workshop（Wallpaper Engine 创意工坊 · 网页版）

把 Wallpaper Engine（Steam App `431960`）的**创意工坊**搬到网页上：浏览 / 搜索 / 多维筛选 /
按 最热门（今日·本周·本月·本年）·最近·评分最高·订阅最多·最近更新 排序 / 每页 30·60·100 /
作品详情（含星级评分） / 订阅·取消订阅 / 收藏 / 「相关壁纸（该作者的创意工坊）」。

> **范围**：本项目**只做创意工坊**。
> 「我的收藏」没有列表视图 —— 它走的是个人创意工坊页，与创意工坊主链路是两套分页语义
> （`numperpage` 只有 30 生效），维护成本高而价值低。收藏**动作**保留（卡片与详情面板上的按钮）。
>
> 「我的订阅」**有一个**列表视图（顶部的「已订阅」）。注意它跟上面那种"个人创意工坊页"
> 不是一回事：**以 Steam 的订阅清单为准**，本地创意工坊目录只补充「订阅时间 / 是否已下载」。
> 所以没装 Wallpaper Engine、或从没下载过工坊内容的机器也能正常用 ——
> 列表照常出，只是少了那两个字段（页面上会用一条提示说明）。
> 卡片上的「已订阅」角标同样保留。

- **零依赖**：后端只用 Node 内置模块，`node server.js` 直接跑，不需要 `npm install`。
- **无数据库、无磁盘缓存**：需求明确不引入数据库；只在**进程内存**里做少量必要缓存
  （图片 LRU、上游页 LRU、标签表、合并结果），重启即清空。
- **可独立运行，也可接入父项目**（`wallpaper-manager`）：
  独立运行时自己在设置页登录；接入后自动从宿主页面取 Cookie。
- 与本项目并列的 `wallpaper-manager` **完全独立**，只**只读**借用它的
  代理配置与 Steam Cookie（不改它的任何文件）。

---

## 1. 快速开始

```bash
cd wallpaper-workshop
node server.js                 # 默认 0.0.0.0:9391
# 或指定端口
node server.js 9400            # 等价于 WW_PORT=9400 node server.js
```

打开 <http://localhost:9391/>。

**不需要登录**就能用：浏览、排序、标签筛选、搜索、分页、详情（含评分与作者昵称）、
相关壁纸、图片代理。只有 **订阅 / 取消订阅 / 收藏 / 点赞点踩** 需要 Steam 登录态。

一键全量自检（服务需已在跑）：

```bash
bash scripts/verify-all.sh
```

### 桌面应用（Electron，可开机自启动）

后端本身还是上面那个零依赖的 Node 服务，桌面壳只负责"把它拉起来 + 开窗口 + 托盘"。

```bash
cd wallpaper-workshop
npm install            # 只装 electron / electron-builder（devDependencies）
npm run electron       # 桌面窗口（后端在本进程里起，已在跑则直接复用）
npm run dist           # 打出 Windows 安装包（NSIS）+ 免安装版 → dist/
npm run dist:dir       # 只出 win-unpacked 目录，便于本地直接跑
```

桌面壳的行为：

- **去掉原生标题栏**：页面顶栏直接当标题栏用（`titleBarStyle: 'hidden'` + `titleBarOverlay`），
  窗口按钮仍由系统绘制。少一层标题栏，纵向多出约 30px。
- **开机自启动**：首次运行默认打开（`app.setLoginItemSettings`），
  自启的实例带 `--hidden`，只在托盘静默驻留、不弹窗。
  托盘右键或**设置 → 桌面**里可以勾掉。
- **关窗口 ≠ 退出**：点关闭只是收进托盘，托盘菜单里才有"退出"。
- **配置写到 userData**：打包后项目目录在只读的 `app.asar` 里，
  桌面壳会把 `WW_CONFIG_DIR` 指到 `%APPDATA%/wallpaper-workshop/config`，
  所以"保存设置 / 记住登录态"照常可用。
- 页面里用 `window.WWDesktop` 判断自己是不是跑在桌面壳里（浏览器访问时不存在，
  设置抽屉里的"桌面"分区会自动隐藏）。

图标由一个零依赖脚本生成（自带光栅器 + PNG 编码器，不装任何图像库）：

```bash
npm run icons      # 重新生成 electron/icon.png (256) 与 electron/tray.png (64)
```

改图标请改 `scripts/make-icons.js` 里的 `drawIcon()`，不要手工替换 PNG ——
`main.js` 内嵌了一份托盘图标的 base64 兜底（打包后 asar 读不到文件），
脚本跑完会把该粘回去的值打印出来，末尾还会断言它与 `tray.png` 一致。

---

## 2. 目录结构

```
wallpaper-workshop/
├── index.html                  唯一页面（Vue 2.6 全局构建，无 SFC、无构建步骤）
├── host-demo.html              ★ 接入示例：演示父页面怎么把 Cookie/命令交给本应用
├── diagnose.html               诊断页：把 JS 报错写进 DOM，便于无头浏览器读取
├── server.js                   入口转发（等价于 server/server.js）
├── electron/
│   ├── main.js                 桌面壳：拉起后端 + 窗口 + 托盘 + 开机自启动
│   ├── preload.js              contextBridge 暴露 window.WWDesktop（自启动开关等）
│   └── tray.png / icon.png     托盘与安装包图标（由 scripts/make-icons.js 生成）
├── server/
│   ├── server.js               HTTP 服务：路由分发 + 静态托管 + 兜底错误处理
│   ├── routes.js               REST 接口实现 + 图片代理（含并发闸门与 LRU）
│   └── lib/
│       ├── settings.js         配置 + 父项目探测（代理 / Cookie / 父后端地址）
│       ├── httpClient.js       零依赖 HTTP 客户端（CONNECT 隧道代理 + 限流重试 + 二进制）
│       ├── dnsResolve.js       DNS：优先 DoH，绕开被污染的系统 DNS
│       ├── steamCommunity.js   社区页面抓取与解析（浏览页 SSR / 详情页 HTML）
│       ├── authorPage.js       个人创意工坊页解析（作者作品）
│       ├── pageStore.js        ★ 分页组装层：上游恒 30 条/页 → 每页 30/60/100 + 上游页 LRU
│       ├── steamApi.js         业务层：排序/筛选/搜索/详情/订阅/收藏/相关壁纸
│       ├── steamWebApi.js      官方 API：GetPlayerSummaries（可选 API key）
│       ├── session.js          登录态（内存态，三级来源）
│       └── util.js             小工具
├── src/
│   ├── app.js                  Vue 根实例：状态、加载、订阅/收藏、宿主消息
│   │                           ★ 筛选/排序/分页会存 localStorage（键 ww.state.v1）
│   ├── api.js                  接口封装（挂 window.api）
│   ├── util.js                 格式化 / 占位图 / 父窗口通信（挂 window.WW）
│   ├── app.css                 全部样式（设计令牌集中在文件开头的 :root）
│   ├── host-bridge.js          宿主接入桥（postMessage + qiankun 生命周期钩子）
│   └── components/
│       ├── wp-card.js          卡片
│       ├── filter-panel.js     左侧筛选器
│       ├── detail-pane.js      右侧详情面板
│       ├── context-menu.js     卡片右键菜单
│       └── settings-drawer.js  设置 / 登录抽屉（分区手风琴）
├── public/vendor/vue.min.js    离线依赖（不走 CDN）
├── config/settings.json        本项目配置（可选，默认不存在）
└── scripts/                    自检与调试脚本（见第 8 节）
```

### 2.1 界面与文案约定

这套 UI 重做过一轮，约定如下，改代码前先看这几条。

**结构**

- 顶栏（`.titlebar`）在桌面壳里**就是窗口标题栏**（`titleBarStyle: 'hidden'` + `titleBarOverlay`），
  整条是拖拽区，右上角 148px 留给系统窗口按钮。浏览器直接访问时 `<html>` 上没有 `.desktop`，
  CSS 就不会留那条空隙 —— 判定逻辑在 `index.html` 的 `<head>` 里同步完成，不会闪。
- 顶栏只有三样东西：品牌、**发现 / 已订阅** 两个视图、登录态药丸 + 设置齿轮。
  代理/直连这种技术状态**不进顶栏**，放在设置 · 网络里。
- 左侧筛选栏可折叠（`filtersCollapsed`）：宽度用 `grid-template-columns` 收到 0，
  收起后网格接管整行。**不能改成 `display:none`** —— 那样里面的复选框会丢状态，
  展开时得重新拉一遍。折叠按钮在筛选栏右边缘，折叠后停在左上角。
- 工具条只有：搜索、结果计数、「N 条说明」、排序 / 每页条数两个下拉。
  **排序和时间窗合成一个下拉**：`最热门 · 今日 / 本周 / 本月 / 本年`、`最近`、`评分最高`…
  平铺在一个列表里（对齐 Wallpaper Engine），不再是"先选最热门、再选时间窗"的二级联动。
  `app.js` 的 `sortOptionsFlat` / `sortValue` / `onSortChange` 负责编解码
  （value 形如 `trend:7`，普通排序就是纯 key）。
- 「隐藏成人内容」**只出现在筛选面板**（原来工具条里还有一份重复的复选框，已删）。
  复选框的勾选态由 `input:checked + .box` 决定，**不要**靠外层加 `.on` 类 ——
  之前有一批（开机自启 / 明文显示 / 记住登录状态）漏了 `:class="{on:…}"`，
  状态药丸写着"已开启"而勾选框是空的。
- 卡片**整块都是预览图**（默认 300px 宽），标题/评分/操作全部压在悬停浮层里，
  和 Wallpaper Engine 一致。类型角标（场景/视频/网页…）各有一个颜色，方便扫列表。
- 分页条 `position: sticky` 贴底，不用滚到最下面才找得到翻页按钮；
  Toast 因此挪到**顶部居中**，否则会盖住分页条。
- 提示条**同一时刻只显示一条**，优先级 `错误 > 慢 > 搜索说明 > 页数上限 > 合并说明 > 订阅状态`，
  其余收进工具条的「N 条说明」浮层。实现见 `app.js` 的 `noticeList` / `activeNote` / `extraNotes`。
- 设置抽屉是**分区手风琴**（账号 / 网络 / 桌面 / 高级），一次只展开一个，
  每个分区头部右侧直接显示状态药丸。原始 DNS、父项目路径、事件日志都在默认折叠的「高级」里。
  **打开时展开哪个分区会被记住**（`ww.settings.section`），默认是「账号」。
- 筛选栏的折叠状态存在 `ww.filters.collapsed`，刷新后保持。

### 2.2 分页的两个坑（都踩过，改代码前先看）

**① 翻到第 7 页却没有页码按钮**

旧写法是「先铺 1~6，只有 `cur > 7` 才把当前页塞进按钮列表」，于是 `cur === 7` 时
当前页既不显示也不高亮（而且根本点不到，用户只能一直按 `›`）。
现在改成**始终围绕当前页开一个窗口**（左右各一页，贴到边界时自动补位），
永远保证当前页可见、可点、可高亮。见 `app.js` 的 `pageButtons`。

**② 同一张壁纸出现在第 2 页和第 7 页**

> 先纠正一个容易搞错的判断：这不是"榜单实时挪位"（实时榜单只影响「最热门」，
> 而且相邻页 2~5 条的抖动是**允许**的）。用户是在「最近」排序下遇到的，
> 那是个按发布时间倒序的稳定列表，挪位解释不了跨 5 页的重复。

真正的根因在**归并策略在中途换了算法**。勾了多值类目（组内 OR）时，列表要拆成多路
再合并；旧实现按"页码深浅"在两种算法之间切换：

| 页码 | 旧实现 | 每路取什么 | 合并方式 |
|---|---|---|---|
| ≤ 4 | `sorted` | 前 `page*pageSize` 条 | **按排序键 k 路归并** |
| > 4 | `approx` | `[(page-1)*prefix, page*prefix)` 的**下标窗口** | **轮询 interleave** |

这不是"顺序近似"，是**换了数据集**：第 5 页往后每路取的是下标窗口，
和前 4 页的"每路前 N 条"毫无关系，两边必然交叉。
实测（最近 + 勾 6 个分辨率，每页 30，翻 1→10 页）：

```
页  策略      每路取数  跨页重复
1-4 sorted    30/60/90/120    0 条
5   approx          5       10 条
6   approx          5       10 条
7   approx          5       10 条
...
两页交叉明细：page2 ∩ page7 = 5 条   (sorted vs approx)
累计 300 个格子里只有 255 个不重复作品，**每一处重复都是 sorted × approx**
```

所以「第 2 页（sorted）和第 7 页（approx）」撞车就是这么来的。
（`scripts/test-paging.js` 一直没发现，是因为它只比较第 1↔2 页 —— 两页都在 sorted 区。）

**修法**：只要排序有归并键，就**始终**从同一条有序列表里切页。这条列表按需增长，
每路的前缀整段重取（`pageStore` 的 LRU 保证各页看到的是同一批对象），所以结果确定，
任意两页不可能交叉。实现见 `steamApi.js` 的 `buildMergeOrder` / `MERGE_STATES`。

范围说明（重要，别过度承诺）：

- **无多选类目**（最常见）：也走同一套"冻结前缀"，`最近`/`最近更新`/`最热门` 都已验证 0 重复。
- **多选类目 + 位置键**（`最近`、`最近更新`、`订阅最多`）：0 重复。
- **多选类目 + 非位置键**（`评分最高`）：**仍有交叉**。它的键是星级，Steam 真实排序另有
  加权、我们拿不到，所以"全局第 N 名"会随着挖得更深而真的改变 —— 第 2 页的一条
  到第 7 页可能确实该排在第 7 页。要彻底消除得把整个结果集（最多 3 万条）物化下来，
  代价与收益不成比例。这类情况由前端的跨页去重兜底（见下），并如实告知用户隐藏了几条。

### 2.3 前端跨页去重（兜底）

`app.js` 的 `seenIds` / `applyPageDedup`：向前翻页时记住已出现的 id，后面再出现就跳过。
三条约束：

- **只在向前翻时生效**。往回翻要清空记录，否则回到第 2 页会整页空白。
- 换筛选/排序/搜索时清空（那是另一个结果集）。
- 宁可这一页少几条，也不要同一张壁纸出现两次；被跳过的条数显示在分页条旁边
  （`dupNote`），不藏着。

在 2.2 的「评分最高」那种后端本身就会交叉的情况下，它把可见的重复清成 0
（代价是该页少几张卡，并明确写出"已隐藏 N 个前面出现过的"）。

### 2.4 依赖项（必需物品）—— 订阅前必须提示

Steam 创意工坊里"预设/场景依赖另一个壁纸"很常见。**只订阅依赖项的话，壁纸在
Wallpaper Engine 里根本加载不出来**，而本项目以前一声不吭，用户订完才发现用不了
（用户实测：订了「德克萨斯-Texas」，它依赖 `[4K]Audio Visualizer v0.6.6`）。

数据在**创意工坊详情页 HTML** 里：

```html
<div class="rightSectionTopTitle condensed">必需物品</div>
<div class="requiredItemsContainer" id="RequiredItems">
  <a href="…/workshop/filedetails/?id=921617616" data-subscribed="0">
    <div class="requiredItem"> [4K]Audio Visualizer v0.6.6(音频可视化) </div>
  </a>
</div>
```

`parseDetailHtml` 解析出 `requiredItems`，`data-subscribed` 直接给出"你订了没"。

⚠️ **只有详情页 HTML 有这个块**：浏览页 SSR 不返回，公开的
`ISteamRemoteStorage/GetPublishedFileDetails` 也不返回（实测 `children` 字段是 `undefined`）。
所以从卡片直接订阅时要现场拉一次 `/api/item` 查，结果按 id 缓存 5 分钟
（`app.js` 的 `requiredItemsOf`）；**查不到时静默放行**，不能当成"没有依赖"。

界面行为（对齐 Steam / WE 客户端）：详情面板里列出还缺哪几个依赖；
点「订阅」时弹窗问"要一起订阅吗"，确认就把依赖一并订上。

**样式**

- 颜色、字号、间距、圆角、阴影、动效全部是 `src/app.css` 开头 `:root` 里的变量。
  **新增样式请用这些变量**，不要写死十六进制色值，也不要用分数像素（原来的 `11.5px` / `12.5px`
  之类已经全部收进 `--fs-*` 阶梯）。
- 图标**只用内联 SVG sprite**（`index.html` 顶部的 `<symbol>`，用
  `<svg class="ic"><use href="#i-xxx"></use></svg>`）。不要引入图标字体或 emoji ——
  emoji 在不同 Windows 环境下字形不一致，截图中会明显穿帮。
  需要新图标时在 sprite 里加一个 `<symbol>`，stroke 风格与现有的一致。
- 卡片**没有**独立的信息区：`.card-overlay` 默认 `opacity: 0`，
  靠 `.card:hover` / `.card:focus-within` 升起来。别再加固定高度的 footer ——
  那样预览图就小回去了（用户明确要求"主要展示预览图"）。
- 复选框：勾选态走 `input:checked + .box`，不要用 `.on` 类。

**文案**

- 界面上**只说结论**。需要解释的（为什么慢、为什么总数不准、归并是什么口径）一律放
  `title` / tooltip，或收进折叠区。不要把三句话的段落常驻在界面上。
- 一句话里不要出现"上游""归并""限流"这类内部术语；要说人话
  （例：不说"上游响应有点慢"，说"Steam 响应较慢"）。
- 加新提示时，优先加进 `app.js` 的 `noticeList`（自动参与优先级排序与折叠），
  而不是自己往模板里插一条 `.notice`。

---

## 3. 用到了哪些 Steam 接口（都实测过）

> 先说结论：**没有用 `IPublishedFileService/QueryFiles`**。
> 它强制要求 API key（无 key 直接 403），而下面的社区入口能覆盖同样的排序/筛选，
> 所以没必要引入 key。

| 用途 | 接口 | 是否需要登录 | 备注 |
|---|---|---|---|
| 列表 / 排序 / 标签筛选 / 搜索 / 分页 | `steamcommunity.com/workshop/browse/` | 否 | 新版 SSR 页面，数据在 `window.SSR.renderContext.queryData`；**每条结果自带 `star_rating` / `total_votes`** |
| 该作者的创意工坊（相关壁纸 / 作者页） | `steamcommunity.com/profiles/<id>/myworkshopfiles/` | 否 | ⚠️ 浏览页的 `creatorid` 参数**被忽略**，必须走个人页 |
| 我的订阅（只为卡片角标取 id 集合） | `steamcommunity.com/profiles/<我>/myworkshopfiles/?browsefilter=mysubscriptions` | **是** | ⚠️ 浏览页的 `browsefilter` 参数**也被忽略** |
| 作品详情（描述/文件大小/时间） | `api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/` | 否 | 公开接口，无 key，40~100 个/批。⚠️ **不含评分字段**（见下） |
| 作品详情（**星级评分** / 作者昵称 / 订阅按钮态） | `steamcommunity.com/sharedfiles/filedetails/?id=` | 否（登录后才有按钮态） | 经典 HTML 页面 |
| 订阅 / 取消订阅 | `POST /sharedfiles/subscribe`、`/sharedfiles/unsubscribe` | **是** | 表单 `{id, appid, sessionid}` |
| 收藏 / 取消收藏 | `POST /sharedfiles/favorite`、`/sharedfiles/unfavorite` | **是** | 同上 |
| 点赞 / 点踩 | `POST /sharedfiles/voteup`、`/sharedfiles/votedown` | **是** | 同上 |
| 作者昵称 / 头像 | 无需单独请求 | 否 | **浏览页自带的** `PlayerLinkDetails` 里就有（见下） |
| 作者昵称 / 头像（兜底） | `ISteamUser/GetPlayerSummaries/v2/` | 否 | **可选** API key；只有在页面数据缺昵称时才需要 |

### 评分数据在哪（踩过的坑）

详情页的评分一度恒显示「0 星 + 评价数不足」。逐一排查后确认：

| 来源 | 有没有评分 |
|---|---|
| `ISteamRemoteStorage/GetPublishedFileDetails` | **没有**。6 个样本的返回键只有固定的 26 个（`publishedfileid` … `tags`），既没有 `star_rating` 也没有 `vote_data` |
| 浏览页 SSR 的单条结果 | **有**：`star_rating: 4`、`total_votes: 53` |
| 详情页 HTML | **有**：`<div class="ratingSection"><div class="fileRatingDetails"><img src=".../5-star_large.png"></div><div class="numRatings">126,787 个评价</div></div>` —— 星级就写在图片文件名里（3 星作品是 `3-star_large.png`） |

所以现在是：**列表用 SSR 的字段，详情抓 HTML 的 `ratingSection`**，两边互补。
`star_rating = -1` 表示 Steam 认为「评价数不足」，界面照此显示。

### 作者昵称与头像（免费，不用 API key）

浏览页的 React Query 缓存里，**每个作者都有一条**：

```
queryKey = ["PlayerLinkDetails", "76561198166819349"]
state.data.public_data = {
  steamid, persona_name: "XianRen",
  sha_digest_avatar: { _t: 0, v: [20 个字节] },   // sha1 hash
  visibility_state, profile_state, ...
}
```

头像是 SHA1 的原始字节，按 Steam 的约定拼出来即可：

```
https://avatars.akamai.steamstatic.com/<sha1hex>_medium.jpg
```

（`sha1` 全 0 表示没有自定义头像。）

详情页里的昵称从**面包屑**取，头像从**作者卡片（friendBlock）**取，两处都有坑，见第 7 节。

### 排序参数对照

| 界面 | Steam 参数 |
|---|---|
| 最热门 | `browsesort=trend&days=1｜7｜30｜365`（今日 / 本周 / 本月 / 本年） |
| 最近 | `browsesort=mostrecent` |
| 评分最高 | `browsesort=toprated` |
| 订阅最多 | `browsesort=totaluniquesubscribers`（⚠️ 排序键是**累计**订阅，卡片上显示的是**当前**订阅） |
| 最近更新 | `browsesort=lastupdated` |

`days` 实测**确实生效**：`days=1` 与 `days=365` 的首页 30 条**交集为 0**。
但上游回给我们的 `total_count` 是全站投稿量、**不随时间窗变化**，
所以「最热门」下的总数一律标成「共 N（约）个作品」，悬停有解释。

### 每页 30 / 60 / 100 是怎么做到的

实测 `numperpage` 的行为：

| 上游路径 | `numperpage=10` | `=24` | `=30` | `=48/60/100` |
|---|---|---|---|---|
| `/workshop/browse/` | 30 条 | 30 条 | 30 条 | **30 条（完全忽略这个参数）** |
| `/profiles/<id>/myworkshopfiles/` | 10 条 | **10 条** | **30 条** | **10 条** |

也就是说：**浏览页恒 30 条/页，个人页只有 30 才生效**。
所以「每页 60 / 100」只能在上层做 —— 这就是 `server/lib/pageStore.js`：

1. 按 `pageSize` 算出需要哪些"上游页"（30 条一页），并发取回来（并发 4，绕开 1200ms 闸门）；
2. 按 id 去重后拼起来，再按全局下标切片；
3. 上游页做 **3 分钟 LRU**（160 页 / 96MB 估算上限），翻页时相邻页大量复用；
4. 一页不足数就**再补一个上游页**（最多 3 轮）——
   因为「最热门」是实时榜单，两次请求之间会挪位，去重后可能只有 59 条。

顺带修掉两处历史错误：
- 旧实现拿 `ceil(total_count / pageSize)` 当总页数 → 321 万会算出 10 万页，
  而 Steam 深翻页硬顶 **1000 页 ≈ 3 万条**。现在先和 3 万取小再算页数，
  界面上还会显式提示这个上限。
- 作者页原来把调用方给的 `pageSize`（界面默认 24）直接塞进 `numperpage`，
  上游退化成 10 条/页，于是「按 24 算页数、实际每页 10 条」，大量条目翻不到。

### 筛选参数

- `requiredtags[]=<tag>` —— 语义**永远是 AND**。
  ⚠️ 实测：多个 `requiredtags[]` 时，`match_all_tags` 传 `1` / `0` / `true` / `false` /
  不传，结果**都是 0 条**；`taggroups[...]`、`tags[]`（老写法）也被完全忽略。
  也就是说社区浏览页**没有**任何"同类目任选其一"的表达方式。
- `excludedtags[]=<tag>` 排除标签（「隐藏 18+」就是自动加上一个 `Mature`）
- `searchtext=<关键词>` 搜索

### 同类目 OR、跨类目 AND 是怎么实现的

WE 客户端的筛选语义是：

```
同组内 OR : 分辨率 ∈ {2560x1440, 3840x2160, …}
跨组间 AND: 且 类型 = Scene 且 分级 = Everyone
```

而 Steam 只给 AND，所以「勾了 2K + 4K」如果用一条查询必然是 0 条
（一张壁纸只可能带一个分辨率标签）。本项目的处理：

1. **每个单选类目** → 一条 `requiredtags[]`
2. **每个多选类目的每个值** → 各发一次请求，然后**按当前排序做 k 路归并**
3. 合并结果做 **60 秒进程内缓存**，同一组条件翻页时直接命中

归并的方式（`mergeMode`）：

| 排序 | 归并方式 | 顺序是否与客户端一致 |
|---|---|---|
| 最近 / 最近更新 / 订阅最多 | 按 `timeCreated` / `timeUpdated` / 累计订阅做 k 路归并 | **完全一致**（实测 page1 30/30 同位同序） |
| 评分最高 | 按"星级 → 评价数"归并 | 近似（Steam 的内部加权不公开，实测约 27/30） |
| 最热门 | 没有可比的数值键 → 保持按路轮询 | 顺序不同（结果都在） |
| 深翻页（每路要超过 4 个上游页） | 退回轮询 | 近似，界面上会标注 |

**为什么能完全一致**：每条路本身已经是该排序下的有序序列，而全局前 N 条不可能从
任何一路取超过 N 条 —— 所以每路取前 N 条（N = `page × pageSize`）再归并、切片，
得到的就是"如果 Steam 支持同类目任选其一"会返回的那个顺序。

代价是请求数随页数增长（每页每路 1 个上游页），所以每路最多取
`MERGE_SORTED_MAX_UPSTREAM_PAGES = 4` 个上游页（30/页 时前 4 页、100/页 时第 1 页完全一致），
再深就退回轮询合并。归并查询会绕开全局限流闸门（否则 9 路会被串成 9×1.2 秒），
并发由 `MERGE_CONCURRENCY = 8` 控制。

实测：勾 9 个分辨率（含竖屏 + 动态/其它）→ 9 路并发 → **约 4.3 秒**出结果，
page1 与"理想归并"逐条一致（30/30 同位同序）。路数上限 12，超过会截断并在界面上提示。

界面上有「已合并 N 路」的小字说明，悬停有解释 —— 免得用户以为只是卡住了。

### 卡片角标与「隐藏 18+」

- 角标排布对齐 WE 客户端：**左下角 = 磁盘占用（+ 分辨率）**，**右下角 = 类型**。
  大小来自 `GET /api/details?ids=…`（`ISteamRemoteStorage/GetPublishedFileDetails`，
  公开接口、不需要登录，一次最多 100 个 id），由前端在列表加载后批量补，
  拿不到就只是不显示这个角标。
- 「隐藏 18+」= 给上游加 `excludedtags[]=Mature`。**勾了「限制级/成人级（R-18）」会自动关掉它**
  （反向同理：打开"隐藏 18+"会把成人级从年龄分级里摘掉）。否则就是"要成人内容又排除成人内容"，
  表现是**客户端里相邻的作品在网页版整批消失**——用户报的"两个壁纸中间少了很多"就是这条。
- 年龄分级只勾非成人档（G / PG-13）时，后端把它等价成 `excludedtags[]=Mature`：
  一条查询搞定，不必拆成 2 路 OR（勾了成人级则反过来保证排除表里没有 Mature）。

### 卡片右键菜单

对齐 WE 客户端的右键菜单：`订阅 / 添加到收藏` ── `在创意工坊中打开 / 相关壁纸 ▸ / 报告和阻止 ▸（红）` ── `查看 ▸`。

| 菜单项 | 行为 |
|---|---|
| 订阅 / 取消订阅、添加到收藏 / 取消收藏 | 与卡片按钮同一套动作（需要登录） |
| 在创意工坊中打开 | 打开 Steam 作品页 |
| 相关壁纸 ▸ | 该作者的全部作品 / 在 Steam 打开该作者的创意工坊 / **只看这个分辨率** / 在右侧打开详情 |
| 报告和阻止 ▸ | 在 Steam 中举报（打开作品页，举报入口在 Steam 页面里）/ **屏蔽该作者（本地隐藏）** / 复制作品 ID |
| 查看 ▸ | 在右侧打开详情 / 复制作品链接 / 在浏览器里打开 Steam 页面 |

- 「屏蔽该作者」只存本地（`ww.blocked.v1`）：网格立刻过滤掉他的作品，顶部出现
  「已屏蔽 N 位作者（本页隐藏 M 个）」小条，点一下清空。
- 菜单自身：贴边自动收进窗口；右边放不下时子菜单翻到左边；
  Esc / 点击别处 / 页面滚动都会关掉；卡片上是 `contextmenu.prevent`，不会弹出浏览器原生菜单。

### 订阅状态与「设为使用中」

**状态要"不悬停也看得见"**（之前只有悬停时按钮文案才变，扫列表分不出哪些订过）：

- 卡片左上角：`✓ 已订阅`（绿）、`▶ 使用中`（蓝）两个实色角标；
- 卡片底部信息行再加一枚状态标签（`✓ 已订阅` / `▶ 使用中`）；
- 悬停按钮文案：`✓ 已订阅（点击取消）`；详情面板上的主按钮同样。

**设为使用中**（调用 Wallpaper Engine 官方 CLI）：

```
GET  /api/we/state      → { available, running, weDir, wsDir, currentIds: [...], monitors: [...] }
POST /api/we/apply      → { id, monitor? }        # 后端执行 openWallpaper
```

- 命令：`wallpaper32.exe -control openWallpaper -file <project.json> -monitor 0`
  （必须发给**正在运行的**那个 exe，32/64 位发错会拉起第二个实例；
  非 ASCII 路径先建 junction 镜像再传，WE 的 argv 按 ANSI 解析，中文会乱码）
- 入口有三处：卡片悬停的 `▶`、详情面板的 `▶`、右键菜单「设为使用中」；
  当前桌面正在用的那张会显示 `▶ 使用中`，并且按钮变成"重新应用"。
- 路径从哪来：本项目 `config/settings.json` 的 `weDir` / `wsDir` →
  环境变量 `WW_WE_DIR` / `WW_WS_DIR` → **只读借用父项目**
  `HTML-website/config/wallpaper/settings.json` 里的 `wallpaperEngineDir` / `wsDir` →
  常见 Steam 库路径探测。
- 失败会如实说明原因：WE 没在运行 / 订阅还没下载完（本地没有该 id 的目录）/
  目录里没有 project.json 与场景文件。

### 为什么"列表一直转圈、一张都不显示"（已修）

实测踩到两个，都会表现成"接口转圈 + 网格空白"：

1. **Steam 用 302 把请求重定向到同一个 URL 来种匿名 Cookie**。旧 httpClient 跟随时
   不带响应里的 `Set-Cookie`，于是一直 302 到上限，最后返回一个 **0 字节的 302**，
   上层只能报"Steam 没有返回数据"。现在跨跳维护一个 Cookie 罐（`parseCookieHeader` /
   `mergeSetCookies`）：同一个 URL 从 `302 / 0 B` 变成 `200 / 684 KB`。
2. **订阅角标那条链路**（`/api/subscribed-ids` 要翻完用户所有订阅，实测 5~10 秒）
   以前每次刷新都全量爬一次，还会跟真正要显示的列表抢上游带宽。现在：
   - 结果缓存 5 分钟，订阅/退订时**增量**更新缓存，失败也缓存 60 秒；
   - 前端**等列表出来之后**才去拉角标；
   - 同参数的并发请求合并成一次上游查询（客户端重试不再按倍数打上游）；
   - 图片给 API 让路（并发 6→4；有 /api 请求在途时图片先等，最多等 3 秒）；
   - 归并并发 8→12：9~12 路一波打完，少一个上游来回（本地代理慢时差 3 秒）。

3. **浏览器每 origin 只给 6 条连接，图片把接口全堵住了**（`/api/subscribed` 实测 16.97 秒）
   上面那些都在解决"抢上游带宽"，但用户实测发现慢的**主因根本不在 Steam**。
   DevTools 计时拆开看：

   | 阶段 | 耗时 |
   |---|---|
   | 队列 | 1.52 ms |
   | **Connection start / 已停止** | **10.92 s** |
   | 已发送请求 | 0.15 ms |
   | 正在等待服务器响应 | 6.05 s |
   | 总计 | 16.97 s |

   64% 的时间花在**请求根本没发出去**上。原因：项目是纯 HTTP/1.1（`http.createServer`，
   没有 HTTPS 就用不上 HTTP/2 多路复用），而一屏 30 张预览图全部走同源的 `/img?u=…`，
   Chromium 对每个 `host:port` 只开 6 条并发连接 —— 6 条瞬间占满，接口请求排在后面
   拿不到 socket。服务端日志能佐证：那段时间里 `/api/status` 只记了 **1ms**，
   说明**服务端根本没见过这个请求**（和你截图里"已发送请求 0.15ms"是一致的）。

   ⚠️ 服务端的 `imageGate` **缓解不了这个**：它是在请求已经被 accept 之后才 await 的，
   图片请求占着浏览器那条 socket，服务端却既不响应也不干活、只是挂进队列干等 ——
   队列从浏览器搬到了服务端，一个 socket 都没省下来。

   现在：**图片代理单独跑在 `端口+1` 上**（`server/server.js` 的 `imgServer`），
   页面用 `<script src="/imgbase.js">` 读回端口（`src/util.js` 的 `imgSrc`），
   图片和接口各拿各的 6 条连接。独立端口起不来时 `WW_IMG_BASE` 是空串、自动退回同源，
   行为与改动前一致 —— 只是慢，不会坏。

   实测（`scripts/bench-img-block.js`，用 `maxSockets:6` 精确模拟浏览器的限制）：
   30 张图 + 1 个接口同时发出，接口耗时 **15158 ms → 4 ms**。

4. **`/api/subscribed` 与 `/api/subscribed-ids` 各爬了一遍**（同一个坑，第二次踩）
   `/api/subscribed-ids` 路由里套了 `dedupe('subs', …)`，但 `apiSubscribed` 是
   **直接调** `apiSubscribedIds()` 的 —— 两个接口同时触发时，同一份订阅列表被完整爬两遍，
   还各自再跑一遍元数据补全，两份都在 noLimit 上并发打 Steam，只会让彼此都更慢。
   现在两边共用 `dedupe('subs', …)`，`/api/subscribed` 自身也套了 `dedupe`。
   实测（`scripts/bench-subs-dedupe.js`）：爬取途中进来的第二个请求 **6792 ms → 2890 ms**。

5. 顺带修掉的两处：元数据补全从 for + await 串行改成 3 路并行（>100 订阅省 1~2 秒）；
   `subMetaCache` 改为**按缺失的 id 增量补** —— 旧写法命中缓存就整份返回，
   5 分钟内新订阅的作品不在 map 里，界面会显示「(未能读取标题)」。

另外前端不再把"整组全选"的类目塞进 URL（类型 5 + 年龄 3 + 标签 25 = 33 个值纯属白打）。

实测（同一台机器、同一个本地代理）：首屏 30 张 **4.8 秒**；"标签全选 + 分辨率 9 个"
这种重筛选 **7.1 秒**（改之前是 150 秒还没出结果）。加载超过 6 秒界面会给一句
"上游响应有点慢…"和一个「取消这次加载」按钮。

> 订阅角标还有一类失效：Steam Cookie 过期后，`myworkshopfiles` 页面会返回登录墙，
> 解析不到任何作品。这时界面会在工具条上显示「Steam 订阅列表取不到（登录态过期？），
> 角标已改用本地库」，并在设置里重新登录（粘贴新 Cookie）后恢复。

### 订阅状态与「设为使用中」的判定（本地库兜底）

订阅角标原来完全依赖 Steam 的订阅列表接口（`/api/subscribed-ids`），它要翻完用户
所有订阅、而且 Cookie 一过期就整条失败 —— 表现就是"客户端明明显示已订阅，
我们这边看不出任何区别"。现在改成 **Steam 订阅列表 ∪ 本地创意工坊库**：

- `GET /api/we/state` 额外返回 `installed`（`steamapps/workshop/content/431960/<id>/`
  目录存在的）与 `localSubscribed`（`appworkshop_431960.acf` 里的条目）。
- 前端 `isSubscribedId(id)` = Steam 列表 ∪ 本地库；`canApplyId(id)` = 装了 WE ∧ 本地已下载。
- 所以：**已下载过的作品一定显示「✓ 已订阅」**（不看 Cookie）；工具条上的提示也改成
  「Steam 订阅列表取不到（登录态过期？），角标已改用本地库」。
- **「设为使用中」只对本地已下载的作品开放** —— 没订阅/没下载完的作品根本没有本地文件，
  按钮显示为禁用，悬停提示"还不能设为使用中：这个壁纸没订阅或还没下载到本地"，
  右键菜单里那条也会变成"设为使用中（需先订阅并下载）"。

### 失败必须"说出来"：接口封装与登录态显示（已修）

用户实测：`POST /api/item/subscribe` 请求体里明明是 `data.ok = false`（Steam 401），
**界面却什么都不报，右上角还显示"已登录"**。两个原因：

1. **信封被包错**：写接口失败时返回的是 `{ ok:false, reason }`，而路由层只把
   `result.ok === false && result.error` 当失败 —— 带 `reason` 的那种被判成成功，
   又被外层包了一层 `{ ok:true, data:{ ok:false, … } }`，前端于是当成成功。
   现在：**内层 ok:false 一律按失败返回**（`reason` 归一化成 `error`，`needLogin` → HTTP 401），
   `api.js` 也会把内层失败抛成异常，调用方想忽略都难。
2. **登录态只看"有没有 Cookie"**：过期 Cookie 也是"有 Cookie"，顶栏就一直显示"已登录"。
   现在 `sessionStatus()` 带 `invalid / invalidReason / verifiedAt`：
   - 写操作被 Steam 拒绝（401）→ `markInvalid()`，顶栏立刻变成红色的**「登录态失效」**并给出原因；
   - 页面加载时后台做一次真实校验（后端 3 分钟缓存），不等用户点订阅才发现；
   - 订阅/收藏/评分失败且 `needLogin` 时：弹错误提示 + 自动打开设置抽屉 + 刷新登录态显示。

实测：过期 Cookie 下点"订阅" → 顶栏显示「登录态失效｜登录态被 Steam 拒绝：登录态已过期
（steamLoginSecure 的 JWT 于 2026/9/26 16:24:59 到期）」，并提示"订阅需要登录，请先在设置里登录 Steam"。

### 「设为使用中」报"WE 没在运行"但其实开着（已修）

两个原因叠在一起：

1. **进程探测不可靠**：原来只用 `tasklist`，它在受限账号/沙箱里会直接
   "错误: 拒绝访问"，返回码非 0 —— 而我们把它当成了"WE 没运行"。
   现在按 `tasklist → PowerShell Get-Process` 依次探测，并且把"枚举失败（unknown）"
   和"确实没运行（false）"分开：`/api/we/state` 的 `running` 可能是 `null`（探测不到），
   这种情况会提示"探测不到 WE 进程（本机枚举进程被拒绝访问）"，
   用户确认后可以按 `force` 直接发命令（64 → 32 位顺序试）。
   实测本机：`tasklist` 被拒，但 `powershell Get-Process` 能看到 `wallpaper32` ✓。
2. **命令进程超时 ≠ 没生效**：WE 是 GUI 程序，`wallpaper32.exe -control openWallpaper …`
   有时不按时退出，旧的 25 秒 `spawnSync` 超时会被当成失败
   （`发送命令失败：spawnSync … ETIMEDOUT`）。现在命令超时缩到 8 秒，
   发完命令后**回读 `config.json` 复核**：确认显示器上确实是这张就报成功。

实测：`POST /api/we/apply` → 8.4 秒返回
`{"ok":true,"verified":true,"message":"已设为桌面壁纸"}`（命令没回执，但 config 已确认生效）。

### 接口"1.8 分钟都出不来"：`spawnSync` 把整个事件循环堵死了（已修）

用户实测：`/api/browse` 1.8 分钟、`/api/we/state` 8.4 秒、`/api/filters` 一直挂起。
根因是**我自己引入的**：`/api/we/state` 里用 `child_process.spawnSync` 探测进程
（先 tasklist、再 PowerShell、还要试跑 wallpaper32.exe），**同步调用会阻塞 Node 的整个
事件循环** —— 每次查状态都把服务器冻住 8 秒，列表/筛选/订阅全排在它后面。

修法：

1. `wallpaperEngine.js` 里**所有** `spawnSync` 换成异步 `execFile`（新加的 `execFileAsync`）。
2. `/api/we/state` 只读 `config.json`（WE 切换后会写盘，足够准），
   `-control getWallpaper` 那种"再拉起一次 WE 进程"的实时查询改成显式 `{ live: true }` 才用。
3. 进程探测缓存 20 秒、本地库（目录 + acf）缓存 30 秒，状态接口基本是 0 开销。
4. `/api/filters` 的"顺手拿一页统计真实标签"改成**后台 fire-and-forget**：
   内置标签表已经和 Steam 对齐，这次请求只是防 Steam 以后新增标签，
   以前它是 await 的，进页面时和列表抢上游带宽（实测 16.7 秒）。

实测（浏览器侧 performance 计时，首屏）：

| 接口 | 修之前 | 修之后 |
|---|---|---|
| `/api/filters` | 挂起（16.7 秒） | **2 ms** |
| `/api/we/state` | 8.4 秒 | **8 ms** |
| `/api/browse`（默认最热门） | — | **2.9 秒**（上游下限） |
| `/api/browse`（标签+9 个分辨率，12 路归并） | 1.8 分钟 | **4.6 秒** |

首屏 30 张图 **3.6 秒**出齐。

### 登录态为什么会"老是退出"（已修）

用户反馈：粘了 Cookie，界面上也显示"登录态有效"，但过一会儿又要重新登录。

两点要说清：

1. **Cookie 不是给浏览器用的**。它是后端拿去跟 Steam 发订阅/收藏请求的凭证，
   浏览器的 Cookie 里**不应该**有它（我们也没用它做会话）—— 这是有意设计，
   不是"忘记写进浏览器"。设置页里那段提示写的就是这个意思。
2. 真正的原因是**默认只存内存**：不勾"写入 config/settings.json"的话，
   服务一重启（我每次改代码重启 dev server 也算）登录态就没了，
   体感就是"老是退出登录"，而每次都要重新粘一遍。

现在：

- 设置抽屉里的「写入 config/settings.json」**默认勾上**，标签也写清楚了
  （勾了重启不用重粘；不勾只在内存里）；
- 登录态那一段直接显示**存在哪**：`来源：手动粘贴/父项目文件　已写入磁盘（重启不用重粘）`
  或 `仅内存（服务重启就失效）` —— 一眼能看出重启会不会丢；
- `POST /api/session {persist:true}` 落盘的是"当前生效的那份"（运行时注入优先），
  所以即使不带 cookie 只发这个请求，也能把正在用的凭证存下来。

> 注意：Steam 自己的 `steamLoginSecure` 是约 24 小时的 JWT（设置页会显示到期时间），
> 到期必须重新粘一次 —— 这一步谁也绕不过去。落盘只是保证"服务重启"不会让你重粘。

### 作者页的三个坑（已修）

1. **资料"私密"的作者看不到作品**。Steam 对这种作者只返回个人主页 + 一句
   「此个人资料是私密的。」（实测：页面 30 KB、0 个 workshopItem、含 `profile_private_info`）。
   WE 客户端仍能列出他的 70 多个作品，是因为客户端走 Steam 客户端自己的通道，
   不是社区浏览页。现在解析器认出这个标记后会明说这一点，而不是含糊地报
   "页面结构不认识"。
2. **"作者没有公开作品"被误判成加载失败**：Steam 对"一个公开作品都没有"的作者返回的是
   正常个人页 + 空列表（没有 `workshopItem`/`workshopBrowseItems` 标记），
   以前会被当成"页面结构不认识"，界面挂一条红色横幅。现在识别为**空列表**
   （`ok:true, items:[]`），界面显示"该作者没有公开的创意工坊作品"。
3. **从作者页返回不再重置排序**。以前「← 返回创意工坊」和顶栏「创意工坊」共用
   `backToBrowse()`，会把排序复位成"最热门"（那是为了修 BUG-04 的"点了没反应"）。
   现在进作者页前会记一份浏览态快照（筛选 / 排序 / 页码 / 滚动位置），返回时还原：
   实测 `sort=mostrecent, page=2` → 进作者页 → 返回后仍是 `mostrecent, page=2`；
   只有点顶栏标签（没有快照）时才回到默认态。

### 「设为使用中」报 CEF 单实例锁失败（已给出准确文案）

用户实测报错里带这段：

```
[ERROR:process_singleton_win.cc:421] Lock file can not be created! Error code: 5
[ERROR:chrome_main_delegate.cc:514] Failed to create a ProcessSingleton for your profile directory
[FATAL:cefengine.cpp:2257] Check failed: CefCurrentlyOn(TID_UI)
```

含义：这次 `wallpaper32.exe -control openWallpaper …` 启动的是一个**新实例**，
它没能把命令交给正在运行的那个 WE（CEF 的单实例锁文件建不出来，错误码 5 = 拒绝访问）。
常见原因是权限/环境不一致 —— 本项目当时跑在受限沙箱里，子进程对 WE 安装目录
（`E:\SteamLibrary\...`，对沙箱只读）写不了锁文件。

现在这种失败会给出可操作的提示（"把本服务放在你自己的终端里运行，或直接用桌面版"），
而不是把 CEF 的堆栈原样丢出来；同时命令进程超时/没回执时会**回读 `config.json` 复核**，
真切换成功就一定报成功。

**更进一步：失败时转交父项目后端。** 本项目与 `wallpaper-manager`（父项目后端 8897）
用的是同一套 CLI 实现；差别只在"谁去 spawn 那个进程" —— 父项目跑在正常用户上下文里，
同一条命令是成功的（实测 `POST http://127.0.0.1:8897/wallpaper/api/we/set-wallpaper`
→ `{"ok":true,"message":"已设为桌面壁纸（WE 热切换）","method":"hot"}`）。
所以现在：本项目自己发命令失败（CEF 锁 / 权限 / 超时）时，会自动 POST 父项目后端再试一次，
成功后返回"（本项目进程发不了 WE 命令，已转交父项目后端）"。

### 私密资料作者：为什么网页端拿不到、要怎么才能拿到

用户报的现象：作者 鱼见见见见（`76561198839809612`）在 WE 客户端里有 70 多个作品，
网页版却一个都列不出来。实测结论：

| 入口 | 结果 |
|---|---|
| `/profiles/<id>/myworkshopfiles/?appid=431960`（html） | 30 KB，0 条，页面写着「此个人资料是私密的。」 |
| 同一个 URL 加 `xml=1` | 同上（48 KB，0 条） |
| 加 `rss=1` | 同上 |
| `/profiles/<id>/workshopitems/` | 同上 |
| 浏览页 `&creatorid=<id>` / `&creator=<id>` | 参数被忽略（total 与无过滤完全一样，该作者 0 条） |
| **`IPublishedFileService/GetUserFiles`（带 key）** | 网页端唯一对等通道 |
| 同一个接口不带 key | `401 Unauthorized … Please verify your key= parameter` |

WE 客户端能列出来，是因为它走 **Steam 客户端自己的已认证通道**（客户端 IPC / 内部 web API），
不需要 key；普通网页端没有这条通道。

所以本项目现在：**配了 `apiKey` 就优先用 `GetUserFiles` 列作者作品**（能覆盖这种私密资料），
拿不到再回落社区页；没配 key 时行为与之前完全一致（实测：假 key → 401 → 自动回落，
正常作者照旧、私密作者给出准确文案）。key 在设置页填：`steamcommunity.com/dev/apikey` 免费申请。

---

## 4. 独立运行时的登录

三种方式，优先级从高到低：

1. **设置页粘贴 Cookie**（推荐）
   浏览器登录 steamcommunity.com → F12 → Network → 任意请求 → 复制 `Cookie` 请求头 → 粘进设置页。
   默认只放后端内存，不落盘；勾选"写入 config/settings.json"才会持久化。
2. **环境变量**：`WW_COOKIE='sessionid=...; steamLoginSecure=...' node server.js`
3. **什么都不做**：自动只读借用父项目
   `../HTML-website/config/wallpaper/settings.json` 里的 `steamCookies`（如果有）。

### ⚠️ 关于"登录态为什么会失效"（很重要的一个坑）

`steamLoginSecure` 是 **约 24 小时的短期 JWT**，而且**绑定了签发时的出口 IP**：

```
"ip_subject": "61.224.94.195", "ip_confirmer": "61.224.94.195"
```

如果后端出口 IP 与这个不一致（例如浏览器直连、后端走代理），
**写操作（订阅/收藏）会被 Steam 拒绝（HTTP 401）**，而读取仍然正常 ——
表现就是"能看能搜，但一订阅就失败"。

所以本项目的推荐做法是：**让父页面把浏览器里正在用的 Cookie 交给子页面**
（见下一节）。那份 Cookie 一定是当前有效的，不受"上次登录时 IP 与现在不同"的影响。

设置页会显式显示"这个登录态由 IP xxx 签发"来提醒这一点。

---

## 5. 接入父项目（wallpaper-manager）

### 5.1 推荐：iframe + postMessage

父页面只需要三段代码（完整可运行示例见 `host-demo.html`）：

```html
<iframe id="ww" src="http://127.0.0.1:9391/"></iframe>

<script>
// 1) 子页面加载后会来问登录态，父页面把浏览器里的 Steam Cookie 交给它
window.addEventListener('message', (e) => {
  const d = e.data;
  if (!d || d.type !== 'wallpaper-workshop:hello') return;

  // 父项目里这份 Cookie 可以来自「用户当前浏览器」或父项目已保存的那份
  const cookie = getSteamCookie();               // 形如 'sessionid=...; steamLoginSecure=...'
  e.source.postMessage({
    type: 'wallpaper-workshop:session',
    cookie,                                       // 必填
    steamId: '76561198...',                       // 可选
    refreshToken: '',                             // 可选
  }, '*');
});

// 2) 可选：监听子页面状态（订阅/收藏成功后会推）
window.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'wallpaper-workshop:state') console.log(e.data);
});

// 3) 可选：向子页面下命令
iframe.contentWindow.postMessage(
  { type: 'wallpaper-workshop:command', command: 'search', value: '初音' }, '*');
//   command: 'search' | 'reset'
</script>
```

消息协议：

| 方向 | type | 载荷 |
|---|---|---|
| 子 → 父 | `wallpaper-workshop:hello` | `{ need: ['steamCookie'], from }` |
| 父 → 子 | `wallpaper-workshop:session` | `{ cookie, steamId?, refreshToken? }` |
| 父 → 子 | `wallpaper-workshop:command` | `{ command, value? }` |
| 子 → 父 | `wallpaper-workshop:state` | `{ event, id, subscribed? / favorited? }` |

（为了兼容，父 → 子的 `{ type:'steam-cookie', cookie }` 和 `{ type:'session', cookie }` 也认。）

**为什么不让后端直接读父项目的 Cookie 文件？**
因为那是"上次登录时"的 Cookie，IP 可能已经变了（见上一节的坑）。
也仍然支持"从父项目后端拉"（设置页有按钮，走 `GET /wallpaper/api/settings`），
但它继承同样的 IP 限制，所以只作为兜底。

### 5.2 qiankun

本项目**没有构建步骤**（脚本用绝对路径 `/src/*.js` 加载），
所以不适合直接当 qiankun 子应用（qiankun 要求资源路径能被 `publicPath` 重写）。两条路：

- **A（推荐、零改动）**：用 iframe 容器包一层，qiankun 官方也支持这种"iframe 微应用"。
- **B**：给本项目加一层 Vite 打包，把资源改成相对路径。
  届时 `window.__WW_HOST__` 上已经准备好了 `bootstrap / mount / unmount / update` 四个钩子，
  不用再补。

---

## 6. 配置

优先级：**环境变量 > `config/settings.json` > 自动探测**。

| 环境变量 | 说明 | 默认 |
|---|---|---|
| `WW_PORT` | 监听端口 | `9391` |
| `WW_HOST` | 监听地址 | `0.0.0.0` |
| `WW_PROXY` | HTTP 代理。**设成空字符串 = 强制直连，不再自动探测** | 自动（见下） |
| `WW_COOKIE` | Steam Cookie | 自动（父项目文件 → 空） |
| `WW_REFRESH_TOKEN` | steam-session 刷新令牌（可自动续期） | 空 |
| `WW_STEAM_API_KEY` | Steam Web API key（只为把作者 steamID 换成昵称） | 空 |

**代理的自动探测顺序**（前一条拿到就不再往后走）：

1. `WW_PROXY` 环境变量（**出现即生效，哪怕是空串** —— 空串代表"我要直连"）
2. `config/settings.json` 里的 `proxy`
3. `HTTPS_PROXY` / `HTTP_PROXY` 环境变量
4. 父项目 `HTML-website/config/wallpaper/settings.json` 的 `httpsProxy` / `httpProxy`
5. `~/.dsh/dsh-proxy-win.conf`
6. **本机常见代理端口探测**：`7890 / 7891 / 7897 / 7899 / 10808 / 10809 / 1080 / 8889 / 2080 / 20171`
   （Clash / Mihomo / v2ray 之类的默认值；`proxySource` 会标成 `local-probe`）
7. 都不成立 → 直连

第 6 条是后补的。之前只有 1~5，本机没装 dsh、也没有父项目时就直接回退直连 ——
于是"Clash 明明在 7890 跑着，应用却直连 + 撞上 DNS 污染"，表现为一直转圈、不报错。

> 探测不只是"端口能不能连上"：任何监听端口都能完成 TCP 握手，
> 会把无关服务误判成代理。这里会**真的发一个绝对 URI 形式的 GET**
> （HTTP 代理专有的请求形态），拿到响应才算数。

`config/settings.json`（可选，运行时会自动创建/更新）：

```json
{
  "port": 9391,
  "proxy": "http://127.0.0.1:7890",
  "cookie": "",
  "refreshToken": "",
  "apiKey": "",
  "language": "schinese",
  "timeout": 30000
}
```

---

## 7. 实现要点 / 踩过的坑

这些是开发过程中真实踩到并且**已经修掉**的问题，记下来避免以后重犯。

### 7.1 网络层

- **系统 DNS 被污染**。本机 `steamcommunity.com` 解析到 `157.240.16.50` / `66.220.146.94`
  这种 Facebook 的地址（还有一个本该 NXDOMAIN 却返回的 `192.5.6.30` 根域名服务器地址）。
  后果是"HTTP 200 但内容是无关页面"，非常难查。
  处理：走代理时 **CONNECT 里传域名**（让代理端解析）；直连时用 **DoH** 解析。
  `GET /api/status` 会给出 `dns.poisoned` 判定，设置页也会显示。

- **⚠️ DoH 曾经"看起来修好了、其实没有"**（2026-10-02 修）。
  旧实现把 AliDNS 排在端点列表第一位，并且**拿到第一个非空结果就采用**。
  实测 AliDNS 对这类域名同样返回被污染的答案，而它"有结果"，
  于是 Cloudflare / Google 永远不会被尝试，污染地址被缓存下来直接拿去建连 ——
  用户侧就是"请求一直挂着、不报错、也不出图"。实测对照：

  | 解析器 | 返回 | 判定 |
  |---|---|---|
  | 系统 DNS | `157.240.16.50` / `66.220.146.94` | 污染（Facebook 段） |
  | AliDNS（直连） | `67.228.235.93` | 污染（SoftLayer 段） |
  | AliDNS（经代理） | `103.246.246.144` | **仍然污染** |
  | Cloudflare（经代理） | `23.37.16.240` | 真实（Akamai） |
  | Google（经代理） | `23.37.16.240` | 真实（Akamai） |

  关键结论：**把 DoH 查询走代理并不能修好 AliDNS** —— 污染发生在它自己的递归解析器内部，
  而不是我们到它的那段链路上。所以判据只能是"**解析器本身在不在墙外**"。

  现在 `dnsResolve.js` 的做法：
  1. **并发问所有端点**，只采用 `trusted`（墙外）解析器的答案；
  2. 已知污染地址段（Facebook / Yahoo / SoftLayer / 根服务器等）直接丢弃；
  3. 拿不到可信答案时，用系统 DNS 的候选地址做 **TLS 证书校验** ——
     拿候选 IP 当目标、用目标域名做 SNI 握手，证书过不了就说明这个 IP 根本不是该域名。
     这是唯一无法被伪造的判据（污染答案的 IP 段位每次都在换，靠枚举 IP 段追不上）；
  4. 仍然拿不到 → **明确报错**，绝不硬连。错误信息直接告诉用户去配代理。

  另外两点：抢到可信答案就立刻返回（不等被墙的端点挂到超时）；
  失败结果缓存 60 秒，避免配置错误时每个请求都重等一遍。

- **墙内直连是救不回来的**。实测即使 DNS 解析正确，直连真实 Akamai IP
  也会被 `ECONNRESET`（封锁同时作用于 SNI，不只是 DNS）。所以这类网络下
  **必须走代理**，DNS 修复的意义在于"快速失败并说清原因"，而不是"让直连能用"。
- **CONNECT 隧道必须显式带 `Host` 头**，否则 Akamai 直接回
  `400 Invalid URL`（页面里连 `window.SSR` 都没有）。
- **`https.request` + `createConnection` 会 socket hang up**：Agent 会再折腾一次握手。
  正确做法是 `tls.connect` 建立 TLS，再用明文的 `http.request` 跑在上面。
- **图片必须按二进制处理**。早期 `body` 统一 `toString('utf8')`，
  JPEG/GIF 的字节被替换字符破坏 → 浏览器全显示占位图。
  现在 `rawRequest` 同时返回 `body`（文本）与 `buffer`（原始字节），图片走 `buffer`。
- **社区页限流**。实测连续快速请求后 Steam 会回 **429** 或"精简页"
  （HTTP 200 但没有 `window.SSR`）。处理：
  - 同一 host 串行 + 最小间隔 1200ms（占位要在**同步阶段**完成，否则并发请求全都读到旧时间戳，限流形同虚设）
  - 429/403/503 指数退避重试（尊重 `Retry-After`）
  - 浏览页拿到精简页时**换一种 URL 形式重试**（加/去 `l=` 语言参数）
  - 图片**不走**社区页那套限流，改用 6 并发 + 内存 LRU（否则一屏 30 张图要等几十秒）
- **别让 `/api/status` 挡在首屏前面**。它要查 DNS 与商店信息，属于"贵"请求；
  现在改成后台刷新，接口立即返回（拿不到就先给 `null`）。

### 7.2 Steam 页面解析

- **浏览页是 SSR + React Query**，数据藏在
  `window.SSR.renderContext`（一个 `JSON.parse("…")` 的双层转义字符串）里的 `queryData`，
  再 `JSON.parse` 一次才拿到 `{ queries: [{ queryKey, state.data.results }] }`。
  必须用**括号配对 + 字符串感知**的扫描器提取，正则一定会被
  `setOwnedApps`（用户拥有的全部 appid，上万个）截断。
- **作者昵称/头像就在同一个缓存里**（`PlayerLinkDetails` 查询），不用额外请求、
  不用 API key（见第 3 节）。
- **详情页里的作者昵称只有面包屑里有，而面包屑用的是 `/id/<个性域名>/`**：
  `<a href="https://steamcommunity.com/id/crazyforme/myworkshopfiles/?appid=431960">来杀我呀~ 的创意工坊</a>`。
  原来的正则写死了 `/profiles/(\d{17})/myworkshopfiles/`，于是**绝大多数作品的作者昵称都是空的**，
  界面只能显示「作者 490138」这种 ID 尾巴。现在 `/id/` 和 `/profiles/` 都接受，
  steamID64 一律以公开 API 的 `creator` 字段为准。
- **详情页的头像绝不能扫"页面第一个 `playerAvatar`"**：那是**导航栏里当前登录用户**的头像，
  于是每个作品的"作者头像"都长一样、而且根本不是作者（实测两个不同作者拿到同一张
  `54770f8e…_full.jpg`）。现在只在**作者卡片 `friendBlock`** 里取，
  并且要求它的资料链接和作者对得上；对不上就留空让前端显示 👤 占位。
- **`friendBlock` 的正则有两个坑**（合起来会让头像恒为空）：
  1. `class` **不是标签的第一个属性** —— 实际是
     `<div data-panel="{…}" class="friendBlock persona offline" data-miniprofile="…">`，
     所以不能用 `<div class="friendBlock` 起手；
  2. 写成 `class="friendBlock[^"]*"` 会**误中内部的 `class="friendBlockContent"`**
     （"Content" 也被 `[^"]*` 吃掉了），而那个 div 里既没有链接也没有头像。
  正确写法：`/<div[^>]{0,300}class="friendBlock(?:\s[^"]*)?"/`。
- **个人页的"空页"要算成功**。翻到最后一页之后 Steam 会返回一个**正常但空**的列表页；
  如果判成 `ok:false`，"每页 100 条"在只有 50 个作品时就会因为第 2~4 页为空
  而被当成"解析失败"，整页只剩第 1 页的 30 条。所以解析器区分
  「页面认出来了」（`ok`）与「页面上一条都没有」（`items` 为空）。
- **`creatorid` 与 `browsefilter` 都被浏览页忽略**（实测带上 `creatorid` 后总数仍是全站的 321 万）。
  「相关壁纸」与"取订阅 id 集合"必须走个人页 `myworkshopfiles`。
- **个人页有两种列表结构**，都要支持（前者用于订阅 id 集合，后者用于作者作品）：
  - 订阅视图：`workshopItemSubscription` 块（**id 在 class 之后**，**标题在
    `workshopItemSubscriptionDetails` 之后** —— 按"从头匹配到细节块"的正则永远取不到标题）
  - 作者作品视图：`workshopItem` + `class="ugc"`（**标题在 `</a>` 之后**）
  改成"先按标记切块、块内再各自找字段"就稳了。回归测试见
  `scripts/test-parser-offline.js`。
- **作者页会列出"他参与协作 / 被署名"的作品**。实测某作者第 1 页 30 条里有 6 条的
  `creator` 是别人（逐条比对 HTML 与公开 API 确认，不是解析串了块）。
  所以「相关壁纸」的文案是"该作者的创意工坊"，而不是严格的"同作者"。
- **详情页与浏览页结构完全不同**：详情页是**经典服务端 HTML**，
  一个 `window.SSR` 字段都没有。所以详情走 HTML 抓取（标题、作者面包屑、评分区、
  统计表、订阅/收藏按钮态、标签集），主体字段用公开 API 补齐。
- **个人页不含作者昵称**（只有一个 `data-miniprofile`，还是当前登录用户的），
  所以"相关壁纸"视图的昵称要从别处带过去：前端把已知的 `creatorName/creatorAvatar`
  作为参数传给 `/api/author` 与 `/api/item`，后端就不用为"取个名字"多打一次 Steam。
- **`?xml=1` 这个老接口已经没了**，现在只返回 HTML。

### 7.3 分页（`pageStore.js`）

- **`numperpage` 上游基本不认**：浏览页恒 30 条/页，个人页只有 30 生效（其它值退化成 10）。
  "每页 60/100"必须自己拼上游页。
- **"最热门"是实时榜单，相邻页边界会抖**。两次请求之间榜单会挪位，
  于是拼页时可能出现重复条目（已按 id 去重）或少量缺口（已自动补页）。
  相邻页之间允许少量重叠（实测 2~5 条，与页大小有关），Steam 官网自己的分页也有同样现象。
- **失败页不缓存**：上游握手失败很常见（3 分钟内 6 次以上），
  把失败结果缓存住会让"重试"也拿不到数据。
- **"要拼几页"决定要不要绕开限流闸门**：只取 1 个上游页就走 1200ms 串行闸门，
  要拼 2 页以上就绕开（否则 4 页排队要等 5 秒）。并发上限 4。

### 7.3 登录与写操作

- **写操作需要新鲜的 `sessionid`**。Cookie 里的那个可能过期，甚至压根没有；
  但 Steam 每次 GET 页面都会下发新的，且页面里的 `g_sessionID` 与之一致。
  所以发写请求前先 GET 一次详情页，用响应里的 `Set-Cookie` 刷新会话。
- **Steam 写接口失败时可能返回 HTTP 200**，body 里是错误页。
  所以不能只看状态码，还要看 body 里有没有
  `steam/login`、`please try again`、`success != 1` 这些特征。
- **订阅/收藏按钮的三种状态都渲染在 HTML 里**，靠 `toggled` / `selected` 类名区分
  （`SubscribeItemOptionSubscribed` 带 `selected` = 已订阅）。

### 7.3 前端

- **不能用 ESM 语法**。组件要共享全局 `Vue`，所以脚本都是普通 `<script defer>`。
  一开始把 `util.js` / `api.js` 写成 `export`，浏览器报
  `Unexpected token 'export'`，随后一片 `ReferenceError`，页面全是 `{{ }}`。
  现在这两个文件用 IIFE 挂 `window.WW` / `window.api`，并额外把常用函数
  `declare` 成全局常量。（`scripts/check-frontend.sh` 会检查有没有 ESM 语法回归。）
- **必须用 `defer`**：`new Vue({el:'#app'})` 若同步执行，会在后面的组件脚本之前跑起来。
- **Vue 2.6.14（不是 2.7）**：只用了 options API，不依赖 `defineComponent` 等 2.7 特性。
- **`AbortController` 与防抖函数不要放进 `data()`**：Vue 2 会深度遍历 data，
  把 `AbortController` 包成 observed 对象纯属浪费。放在实例的非响应式属性上。
- **连点复选框必须防抖 + 本地状态**（这是"勾了 6 个分辨率却只筛出 1 个"的真正原因）：
  - 每次点击都发请求 → 后一发 `abort` 掉前一发 → 最后只用"最后一格"的状态查询
  - 每次点击都基于同一个**未更新的 prop 快照**做"加一个" → 6 次互相覆盖
  修法：`filter-group` 内部维护本地选中集（点一下立刻改本地并整体 emit），
  父组件对刷新做 450ms 防抖。这样一串点击只发一次请求、用的是完整状态。
- **搜索是防抖自动触发**（600ms），并取消上一发在途请求。
- **详情面板是覆盖式滑出**（不是固定列），这样未选中时网格能铺满、每行多放一张。
- **列表请求失败时必须保留上一次的结果**。旧实现一旦报错就 `items=[]` / `totalCount=0` /
  分页条消失，只剩一条红色横幅 —— 用户正在浏览的内容凭空没了，上下文全丢。
  现在改成「保留旧结果 + 顶部横幅 + 自动重试 2 次（1.5s / 4s 退避）」，
  横幅上会说明"下面仍然是第 N 页的旧数据"，也给「立即重试」按钮。
- **详情请求失败要如实报错**。旧实现返回 `ok:true` + `item:null`，
  详情面板把 `item` 为假值一律当成"还没选中"，于是显示「从左侧点选一张壁纸」这种
  **静默空态**，用户完全不知道是网络问题还是作品不存在。
  现在分开两种情况：`notFound`（作品不存在/已删除，不给重试按钮）与可重试的上游失败。
- **详情页解析不完整时要说明**。Steam 会间歇性给"精简页"（HTTP 200 但没有详情锚点），
  这时只有公开 API 的字段可用。详情面板会挂一条黄色提示说明"图片与作者信息可能缺失"，
  而不是让用户以为这个作品就这么点内容。
- **预览图尺寸**：栅格 `minmax(252px, 1fr)`（原来是 168px），详情面板 522px（原来 348px），
  即预览区域的宽高各放大约 50%；缩略图条 78×45。

### 7.5 服务端
- **不要用同名参数遮蔽函数名**。`routes.handle({ readJson })` 里写 `await readJson()`
  会丢掉 `req`，报 `Cannot read properties of undefined (reading 'on')`。
  现在请求体解析收进 `routes.js` 自己实现。
- **异步分支不能用 `if (!handled) serveStatic()` 收尾**：`serveStatic` 是异步的，
  接口报错后又被走到静态分支会 `ERR_HTTP_HEADERS_SENT` **把整个进程带崩**
  （真实发生过）。现在静态分支 `return` 收尾，并在 `serveStatic` 里加了
  `headersSent` 双保险，另外挂了 `uncaughtException` 兜底。

---

## 8. 自检脚本

| 脚本 | 作用 | 需要网络 |
|---|---|---|
| `bash scripts/verify-all.sh` | **一键跑全部**（下面 1~11） | 是 |
| `bash scripts/check-frontend.sh` | 语法检查 + ESM 回归检查 + 静态资源可达 | 否 |
| `bash scripts/check-syntax.sh` | 只做语法检查（前后端全部 js） | 否 |
| `node scripts/test-parser-offline.js` | 个人页解析器单测（内联真实结构样本） | 否 |
| `node scripts/test-filter-semantics.js` | 筛选语义：同类目 OR / 跨类目 AND | 是 |
| `node scripts/test-paging.js` | **分页组装**：30/60/100、时间窗、合并请求数、作者页 | 是 |
| `node scripts/selftest.js` | 后端业务：排序/筛选/搜索/详情/作者/订阅集合 | 是 |
| `node scripts/test-report-fixes.js` | **验收报告修复项回归**（BUG-01…BUG-17 的契约断言） | 是 |
| `node scripts/browser-check.js` | 无头 Chrome 渲染：Vue 挂载、卡片、图片、无 JS 报错 | 是 |
| `node scripts/cdp-check.js` | CDP 真实交互：点卡片/详情/相关壁纸/排序/筛选/搜索/分页/设置/Tab 复位 | 是 |
| `node scripts/cdp-resolution-check.js` | 复现并验证"勾 6 个分辨率"这条路径（前端+后端整链路） | 是 |
| `node scripts/cdp-pagesize-check.js` | **UI**：每页 30/60/100、今日~本年、预览 +50%、评分、隐藏 18+ | 是 |
| `node scripts/cdp-host-check.js` | 宿主接入：iframe + postMessage 传 Cookie 与命令 | 是 |

辅助调试脚本（排障用，不参与自检）：

| 脚本 | 作用 |
|---|---|
| `node scripts/probe-api.js [item\|browse\|filters\|status]` | 打本地接口并打印关键字段 |
| `node scripts/debug-upstream-matrix.js` | 上游行为矩阵：`days` 取值、`numperpage` 在两条路径上的表现、评分区形态 |
| `node scripts/debug-days-effect.js` | 证明 `days` 真的换了一批结果（而不是只改了个数字） |
| `node scripts/debug-rating.js` / `debug-rating2.js` | 找评分数据到底藏在哪个来源 |
| `node scripts/debug-detail-anchors.js [id]` | 打印详情页里作者 / 评分 / 统计区的原文锚点 |
| `node scripts/debug-avatar.js [id]` | 逐块打印 `friendBlock`，排查作者头像 |
| `node scripts/debug-author-mix.js [id]` | 逐条对比"作者页列出的"与"API 里的 creator" |
| `bash scripts/probe-ratelimit.sh [次数] [间隔ms]` | 连续打浏览页，看多快会触发限流/精简页（用来给限流间隔定值） |
| `bash scripts/repeat-selftest.sh [次数]` | 反复跑后端自检，确认不是"跑一次就坏"的偶发问题 |
| `bash scripts/smoke-selfcontained.sh` | 确认各测试脚本在没有历史样本文件时也能独立跑通 |
| `node scripts/check-related.js` | 检查 `/api/item` 的「相关壁纸」数据是否完整 |
| `node scripts/check-login-filters.js` | 对照"订阅集合是否真的过滤了"（不是全站总数） |
| `node scripts/check-image-bytes.js` | 校验 `/img` 返回的字节是不是**合法图片**（只看长度会被骗） |
| `node scripts/debug-config.js` | 打印配置探测结果（父项目 / 代理 / Cookie 来源 / JWT 绑定 IP） |
| `node scripts/debug-detail.js [id]` | 抓一个作品详情并打印解析结果 |
| `node scripts/check-templates.js` | 校验所有组件模板是否合法（模板写在 JS 反引号里，`node --check` 看不出结构错） |
| `node scripts/ui-smoke.js <baseUrl>` | **真实浏览器冒烟检查**：卡片是否渲染、缩略图有没有破图、`content-visibility` 是否生效、详情面板加载态能否关闭、有无 JS 报错。截图落在 `scripts/ui-shots/`。**需先 `npm i playwright-core`**；用系统已装的 Edge，不必下载 Chromium |
| `node scripts/debug-dns.js [host] [proxy]` | **DNS 排障**：各解析器分别回了什么、谁被判定污染、证书校验结果、最终采用了哪个地址 |
| `node scripts/debug-image.js` | 对比图片请求的几种头组合 |
| `node scripts/debug-url.js [--fetch]` | 打印生成的浏览页 URL（`--fetch` 会真打一次） |
| `node scripts/debug-author-names.js` | 看浏览页 SSR 里有哪些作者信息可用 |
| `node scripts/debug-playerlink.js` | 看 `PlayerLinkDetails` 的原始结构与头像 hash |
| `node scripts/debug-taggroups.js` | 实测 `taggroups` / `tags[]` / `match_all_tags` 哪种参数有效 |
| `node scripts/debug-matchall.js` | 证明 `requiredtags[]` 永远是 AND |
| `node scripts/debug-latency.js` | 拆分请求耗时（隧道握手 vs 页面传输）与并发表现 |
| `node scripts/debug-imgstats.js` | 看图片代理的健康状况（失败数 / 并发 / 排队） |
| `node scripts/debug-authorpage*.js` | 看个人创意工坊页的列表结构 |
| `node scripts/diagnose.sh` | 无头 Chrome 打开 `diagnose.html`，把 JS 报错与页面快照读出来 |
| `bash scripts/test-session-inject.sh` | 验证运行时注入 Cookie 是否覆盖了配置文件里的值 |

自检截图与 DOM 快照输出在 `config/shots/`。

---

## 9. 已知限制

- **深翻页上限 = Steam 的硬顶（1000 页 / 约 3 万条）**。
  - 前 40 页走**冻结前缀**（为的是让各页看到同一份数据、避免翻页交叉，
    见 `buildMergeOrder` 的注释）；超出 `MERGE_PREFIX_MAX_ITEMS = 1200` 之后
    **自动改用"直接取上游那一页"**，所以**不存在"翻到 40 页就到头"这回事**。
  - 为什么能这么改：实测上游是 **O(1)** 的 —— 第 50 / 100 / 200 / 400 / 800 / 1000 页
    都只要约 2.5 秒、每页稳定 30 条。而冻结前缀是 O(N)（翻第 100 页要先抓 100 个上游页，
    实测第 39 页要 20 秒）。所以深页直接取页既翻得动、又快。
  - 代价是深页之间可能有少量重叠，靠前端跨页去重兜底（`applyPageDedup`）；
    多选类目那条路径一直就是这么做的。
  - 连续翻页本来就很快（每页只多取一个上游页），再配合后台预取下一页基本无等待。
- **「最热门」的总数只是参考**：Steam 在这个排序下回给我们的 `total_count`
  是全站投稿量，不随今日/本周/本月/本年变化，所以界面标成「共 N（约）个作品」。
- **每页 100 条比较贵**：一次要拼 4 个上游页（约 2.7MB、2~4 秒）。
  相邻页有 3 分钟的上游页缓存，所以连续翻页会快很多。
- **实时榜单的相邻页边界可能有少量重叠**（实测 2~5 条）。
  「最热门」是实时榜单，两次请求之间 Steam 会挪位，Steam 官网自身也有同样现象。
- **上游 TLS 握手失败很常见**（经本地代理打 Steam，实测 3 分钟内 ≥6 次
  `Client network socket disconnected before secure TLS connection was established`）。
  已加三层防护：浏览页/详情页"换一种 URL 形式再试"+ 网络异常也继续下一轮、
  上游页取失败自动重试 2 次（0.5s/1s）、公开 API 重试 2 次；
  前端再叠"保留旧结果 + 自动重试 2 次"。仍失败时会如实报错而不是假装成功。
- **多词搜索是 Steam 侧的宽松匹配**：搜 `zzzz-no-such-wallpaper-xyz` 会回来 23 万条
  （命中了 `wallpaper` 这个高频词）。这不是本项目能改的，所以界面上会给出提示条
  说明"被拆成 N 个词做宽松匹配，要精确匹配请用单个词"。
- **订阅类操作受"登录态绑定 IP"限制**（见 4.1）。独立运行 + 后端走代理时，
  粘贴浏览器 Cookie 也未必能订阅成功 —— 这时用"父页面推送 Cookie"最稳。
- **作者昵称不需要 API key**（详情页面包屑 + 浏览页 PlayerLinkDetails 都能给）。
  `WW_STEAM_API_KEY` 只在"页面数据缺昵称"时才用得上（例如 Steam 改版）。
- **`/api/subscribed-ids` 只为角标服务**：会翻完订阅列表的所有页（上限 12 页 = 360 个），
  订阅更多的账号角标不可能全覆盖，接口会返回 `capped: true`，界面会提示。
- **不含"设为桌面壁纸"**：那是 `wallpaper-manager` 的能力（调用 WE 的
  `-control openWallpaper`），本项目只做创意工坊的浏览与订阅管理。
- **缩略图按原图传输**：WE 的预览图很多是 1~2MB 的动图 GIF，
  Steam CDN 对这类图**不响应 `imw/imh` 缩放**（实测 320x180 反而更大），
  所以只能原图 + 内存 LRU + `loading="lazy"`。
  有些卡片看起来是黑块，那是动图首帧还没解码，不是加载失败。
- **没有数据库/落盘缓存**（按需求）。因此重启后：图片缓存与上游页缓存清空、
  「已订阅」角标需要重新拉一次、运行时注入的 Cookie 失效
  （配置文件里的那份不受影响）。

---

## 10. 与 wallpaper-manager 的边界

| | wallpaper-manager | wallpaper-workshop（本项目） |
|---|---|---|
| 定位 | 本地壁纸库**管理**（订阅/本地/自建/备份/回收站、批量重命名、属性编辑、设为桌面） | 创意工坊**浏览与订阅** |
| 后端 | `HTML-website`（Express，8897） | 本项目自带（零依赖，9391） |
| 数据 | 扫描本地 `project.json`、维护 history/store | 全部来自 Steam，**不落盘** |
| 关系 | — | **完全独立**；只**只读**借用父项目的代理配置与 Cookie，不改父项目任何文件 |

两者可以各自单独跑，也可以把本项目作为子应用嵌进 `wallpaper-manager`。

---

## 11. 对照验收报告的修复情况

依据《WallpaperEngine创意工坊模块-功能验收白盒测试报告》逐条处理。
`node scripts/test-report-fixes.js` 会对下表的每一项做断言。

| 编号 | 现象 | 处理 |
|---|---|---|
| BUG-01【高】 | 每页数量 12/24/30 无效，恒 30 条 | **修**：改成 30/60/100，由 `pageStore` 拼上游页真正实现 |
| BUG-02【高】 | 订阅/收藏分页总数算错，大量条目不可达 | **范围外**：两个列表视图已按需求移除；同源的作者页页数问题已修（恒 `numperpage=30` + 组装） |
| BUG-03【高】 | 评分（星级/评价数）全程为空 | **修**：详情从详情页 `ratingSection` 抓星级与评价数；列表用 SSR 的 `star_rating`。卡片与详情都显示 |
| BUG-04【中】 | 顶栏 Tab 无法退出订阅/收藏视图 | **修**：`backToBrowse()` 会复位排序；两个 Tab 本身已移除 |
| BUG-05【中】 | 收藏状态不加载 | **部分**：收藏这个动作保留（本地状态即时更新）；不再维护全局收藏集合（列表视图已移除） |
| BUG-06【中】 | 「只看已订阅」浏览态恒空 | **修**：移除该控件（它只是"前端过滤当前页"，语义上等于切换到订阅列表） |
| BUG-07【中】 | 详情部分失败却返回 `ok:true` + 静默空态 | **修**：拿不到作品就 `ok:false`，前端区分"不存在"与"可重试的上游失败" |
| BUG-08【中】 | 上游抖动时列表被清空、分页条消失 | **修**：错误时保留上一次结果 + 顶部横幅 + 自动重试 2 次（1.5s/4s 退避） |
| BUG-09【中】 | 多词搜索返回大量无关结果且无提示 | **解释**：属 Steam 上游语义，界面上加提示条说明是宽松多词匹配 |
| BUG-10【低】 | 订阅/收藏下搜索被静默忽略 | **范围外**：视图已移除 |
| BUG-11【低】 | 不存在的作品 ID 文案误导 | **修**：区分"作品不存在或已删除"与"上游失败" |
| BUG-12【低】 | 作者昵称未解析 | **修**：面包屑接受 `/id/<个性域名>/`（原来只认 `/profiles/<17位>/`）；顺带修掉"作者头像取成当前登录用户"的问题 |
| BUG-13【低】 | 新作详情解析不完整且无提示 | **修**：`pageOk=false` 时返回 `partial` + 说明，详情面板显示黄色提示条 |
| BUG-14【低】 | 接口未做 HTTP 方法校验 | **修**：所有读接口非允许方法 → 405 |
| BUG-15【提示】 | `totalCountApprox` 从未返回 | **修**：trend 排序（总数不随时间窗变化）与多路合并时返回 `true`，界面显示「（约）」并带解释 |
| BUG-16【提示】 | 分页上限 1000 页未说明 | **修**：`totalPages` 按 30,000 条可达上限收敛，界面给出说明条 |
| BUG-17【中】 | 「已订阅」角标只覆盖前 30 条 | **修**：`/api/subscribed-ids` 翻完所有页（上限 12 页），并回报 `complete` / `capped` |
| OBS-2 | 「订阅最多」排序键与展示字段不一致 | **修**：排序项带说明（按累计订阅排），卡片上显示的是当前订阅数 |
| OBS-4 | 成人内容默认直出 | **修**：工具条加「隐藏 18+」开关，**默认勾选**（对齐 WE 客户端）；取消即可看全部 |
| OBS-6 | 作者页每页仅 9 条、页数按 24 算 | **修**：恒 `numperpage=30` + 组装，页数与条数自洽 |
| OBS-7 | 订阅后详情面板订阅数不即时刷新 | **修**：详情面板的订阅/收藏数会本地即时 ±1 |
| #30 缺失 | 分享 / 复制链接 | **补**：详情「更多」菜单里有「复制作品链接」 |

仍**未做**（属宿主职责或明确超范围）：
动态视频预览、合集分组 UI、更新说明、语言切换、键盘快捷键。
（「应用为桌面壁纸」后来补上了：见 `/api/we/apply`；下载状态用本地库 + 右键菜单的
「屏蔽该作者」等一起做了。）另：项目范围为**创意工坊**，「我的订阅 / 我的收藏」列表视图不做。
