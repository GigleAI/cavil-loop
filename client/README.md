# Cavil Loop 客户端

`client/` 是一个本地桌面客户端（Tauri：界面 TypeScript + React，后台 Rust），把多个 GitHub Project 看板和仓库合进一个视图。它只和 `api.github.com` / `github.com` 通信（唯一的例外是头像图片，从 GitHub 的头像地址 `avatars.githubusercontent.com` 加载，#155），和 daemon 没有任何交互，也不读 daemon 的配置。设计与拆分见 GigleAI/cavil-loop#135，本目录的第一块是 #136（骨架），#138 加上了查看与修改，#137 加上了搜索筛选与表格视图，#151 把外壳从 Electron 换成 Tauri（安装包从 134 / 139.5 MB 降下来），并把 GitHub 凭据整段收进 Rust 后台，#155 加上了头像、详情折叠与浮动、PR 跟在关联 issue 下面、⌘+ / ⌘- 缩放。

## 目录

```
src/
  shared/    类型、来源地址解析、界面 API 约定（ipc.ts）、搜索筛选（filter.ts）、视图设置与导入（viewSettings.ts / viewImport.ts）
  data/      GitHub 请求、同步、去重、看板分列（board.ts）、表格分组（table.ts）、两者共用的排序（sort.ts）；
             actions.ts 每种修改一个函数，detail.ts 详情（评论倒序），itemRefresh.ts 改完后重读一条
  app/       controller.ts 应用逻辑（同步轮次、设置、修改、详情），跑在窗口里，不碰凭据；localApi.ts 把它包成 window.cavil
  backend/   窗口到后台的唯一通道：backend.ts 命令约定 + 代发请求；tauri.ts 走 Tauri 的 IPC；testBridge.ts 只进界面测试的构建
  renderer/  React 界面；main.tsx 启动
src-tauri/   Tauri 外壳（Rust）
  src/main.rs           只做接线：一个 IPC 命令 backend、窗口不导航、GitHub 链接交给系统浏览器
  crates/core/          后台本体：登录（设备授权）、续期、凭据队列、可信名单、退出（engine.rs）、钥匙串（platform.rs）、
                        本地存储（store.rs，SQLite，表结构和 Electron 版相同）、代发请求只放行 GitHub 接口（http.rs）、命令表（api.rs）
  crates/harness/       测试专用：把后台本体接到 stdin/stdout，单元测试和界面测试都驱动它（发布的 App 里没有）
  tauri.conf.json       窗口的 Content-Security-Policy、打包设置
test/
  unit/        vitest：数据层 + controller，对着本地假 GitHub 走真 HTTP；后台是真实的 Rust 子进程（test/support/harness.ts）
  support/     测试用的凭据存储（可以卡住、失败）、SQLite 读写、凭据格式——用来预置和核对磁盘状态
  e2e/         Playwright 在 WebKit 里驱动真实窗口（bridge.ts：窗口经本机回环桥接到真实后台）
  fake-github/ 假 GitHub：GraphQL、REST（带分页）、OAuth 设备授权，可注入失败 / 断网 / 凭据撤销；
               writes.ts 是可写的一面（标签、里程碑、评论、看板字段、合并 / 关闭、新建 issue），digest() 判断「GitHub 上什么都没改」
  fixtures/    从 cavil project（GigleAI #11）录下来的真实接口返回，已脱敏；record.mjs 可重录
               cavil-project-11.filters.json：同一次录制里 GitHub 服务端筛选对每条查询的结果，搜索框按它逐条对拍
  mutation/    负对照
scripts/
  build.mjs             构建窗口 dist/renderer（--test-bridge：界面测试用的 dist/renderer-test）
  make-dmg.mjs          把 Tauri 打出的 .app 做成 dmg（dmgbuild，dmg-settings.py 是窗口布局）
  size-gate.mjs         安装包体积门槛：每个 dmg ≤ 20 MB（1 MB = 1,000,000 字节），目标 ≤ 10 MB
  mac-open-check.sh     CI 的 Mac 机器上：dmg 窗口内容 + 冒烟 + 第一次打开步骤的实测
  release-command.mjs   放行命令只在这里定义一次；网页 / txt / 背景源文件 / 发版说明里的副本由 test/unit/dmg.test.ts 逐字对拍
  render-dmg-background.cjs  把 build/dmg-background.html 渲染成 dmg 窗口背景图（改了 HTML 后手动重跑，产物入库）
  icon.mjs              App 图标：`node scripts/icon.mjs build` 从 build/icon-source.png 生成 build/icon.png；`check-app` 在 CI 的 Mac 机器上核对打出的 App 用的确实是它
build/
  dmg-background.html / background.png / background@2x.png   dmg 窗口背景（写着两种放行办法）
  打不开时看这里.txt     放进 dmg 的说明，命令可以直接复制
  复制放行命令.html      放进 dmg 的小网页：双击用浏览器打开，点「复制」拿到放行命令（纯静态、无外部资源）
  icon-source.png       App 图标原图（维护者在 #144 给的图，原样像素，不要改）
  icon.png              App 图标（生成物，入库）：原图去掉黑边、按苹果图标网格缩到 824px 居中在 1024 透明画布上；tauri.conf.json 的 bundle.icon 指向它
```

## 开发

要装 Rust（`rustup`）。单元测试和界面测试会先 `cargo build -p cavil-harness`，把真实后台当子进程驱动。

```bash
cd client
npm ci
npm run test:rust              # 后台的 Rust 单元测试
npm test                       # 单元测试（真实后台子进程），末尾打印「负对照：跳过 N 项」
npm run test:mutation          # 负对照（MUTATION=1）：先跑未改动的基线，再逐项改坏一处（含 Rust 后台），指定的断言必须失败
npm run typecheck
npm run test:e2e               # 界面测试（WebKit；WebKit 起不来的机器加 CAVIL_E2E_ENGINE=chromium）
npm start                      # tauri dev：本机跑起来（Linux 要装 libwebkit2gtk-4.1-dev；凭据只在内存里，退出即忘）
npm run dist:mac               # Mac 上：打 .app 和 dmg（要 dmgbuild：pip install dmgbuild）
```

## 规则（改代码前读）

- **GitHub 是唯一数据源**：缓存只从 GitHub 往下写。一个来源要么整个读成功、整条覆盖本地，要么沿用上一轮——任何一页失败都不能把半份结果写进去，否则「读失败」会看起来像「条目消失」。
- **缓存只属于一个账号**：退出登录清空缓存；启动时凭据和上次读缓存用的不是同一把（只比对哈希），在 GitHub 确认账号前一律不显示旧缓存；一轮同步发出后有人退出 / 换账号，这一轮整个作废；来源在同步途中被删除（或删了又加）时，这一轮对它的结果不写入。
- **登录要么完整成功，要么什么都不留**：凭据只在登录最后一步写入，所有写入 / 删除在一条队列里依次执行；写完立刻核对这次登录是否已被取消、退出或被更新的登录取代，是就在同一步里删掉，不会误删排在后面的新凭据。
- **去重按条目本身**（`仓库#编号`），不按来源。迭代、状态属于各个 Project：两个 Project 值不同，同一条目在两列各出现一次；里程碑属于仓库。
- **凭据只在 Rust 后台**（#151）：登录、续期、凭据写入队列、可信名单、退出全在 `src-tauri/crates/core`，只有这一份实现。窗口里的应用逻辑只拿到「未登录 / 等待授权（短码、网址）/ 已登录（账号、会话编号）」，要发 GitHub 请求就交给后台代发——后台加上凭据，只放行 `api.github.com`（地址按解析结果比，不按前缀），窗口自己带的 `Authorization` 头被丢掉，会话结束后一律拒绝。描述凭据的几项设置（可信名单、缓存绑定的凭据、缓存所属账号、登录时的 Client ID）窗口既读不到也写不了。`test/unit/backend-boundary.test.ts` 把一次完整的登录、同步、修改、续期、退出里所有跨过边界的命令和回答扫一遍，里面不许出现任何令牌。钥匙串写入走 `security -i` 的标准输入，不进命令行参数（和 Electron 版同一个钥匙串条目，升级不用重新登录）。
- **测试模式**（`CAVIL_CLIENT_TEST_MODE=1`）只给自动测试用：可以把 GitHub 地址换成本机回环地址的假服务，换成别的主机会直接报错（判断在 `src-tauri/crates/core/src/platform.rs` 的 `select`）。
- 只和 `github.com` 通信（头像图片例外：`avatars.githubusercontent.com`，只用来加载图片，不带凭据）；外链一律用系统浏览器打开，且只放行 GitHub 的地址。

### 查看与修改（#138）

- **修改直接发给 GitHub，成功后立即重读那一条**：只替换缓存里那一条（所在的每个来源各一份，同样受「退出 / 换账号 / 来源被删」的保护）；同步正在进行时再补一轮。重读失败不影响修改本身，界面会说明，下一轮同步补上。离线时所有修改入口变灰，不排队、不重试。
- **标签只发「加这个 / 删这个」**（`POST …/labels {labels:[一个]}`、`DELETE …/labels/<名字>`），从不整份覆盖——整份覆盖会把别人刚加的标签冲掉（负对照守着）。
- **合并一定带上看到的提交**（`sha`）：期间被推了新提交，GitHub 回 409，界面说「请刷新」，什么都不合；合并方式只列仓库允许的；不提供绕过分支保护的管理员合并。关闭 PR 先关、关成功才发附带的评论。
- **里程碑**改的是这一条所在仓库里同名的那个；没有就拒绝并说明，什么都不发，不新建。
- **迭代 / 状态**只改那张卡所在 Project 的值，用那个 Project 自己的字段和选项 id；拖卡时卡上有两个 Project 就两个都改，其中一个没有目标迭代就整次拒绝。「未加入看板」的卡拖进迭代列先问「加入看板 X 并设为这个迭代？」。GitHub 说这个账号不能改某个 Project（`viewerCanUpdate`）时，那个 Project 的入口变灰并说明，标签 / 里程碑照常可改。
- **详情**每次打开都从 GitHub 现读（不缓存），评论、评审、每个评审下的逐行评论全部分页读完（任何一页失败就整次报错，不显示半份讨论）；最新在上，正文最老所以在最下，逐行评论挂在所属评审下面。默认只展开最新一条（没有评论时就是正文），其余折成一行（作者、时间、开头约 80 字），点一下展开，面板上有「全部展开 / 全部收起」（#155；折叠用浏览器自带的 `<details>`，隔离框里不跑脚本）。GitHub 渲染好的 HTML 放在 `sandbox` 隔离框里（不能跑脚本、不能导航，有自己的 CSP），链接用系统浏览器打开。
- **详情顶部的类型徽章**（#172，`src/renderer/KindBadge.tsx`）：issue 和 PR 靠图标形状（圆圈带点 / 分支）和全称（「Issue」/「Pull Request」）区分，底色是 GitHub 的状态色。类型和状态取自看板里的这一条，打开就有；「草稿」只有详情接口里有，所以只在详情读完、且这一条仍开着时才变灰写「草稿」，已关闭、已合并优先；详情读取失败时徽章照常按类型和状态显示。图标是内联 SVG，不加载任何外部资源。
- **状态配色跟 GitHub 一致**（PR #174 复审时维护者要求）：开着 = 绿；PR 关闭未合并 = 红；PR 已合并、issue 按「已完成」关闭（或没记关闭原因）= 紫；草稿 PR、issue 按「不计划 / 重复」关闭 = 灰（徽章文字补「（不计划）」「（重复）」）。哪种情况用哪种颜色只在 `src/shared/stateTone.ts` 一处判断，详情徽章、看板卡片、表格行都用它；色值是 GitHub 设计系统 Primer 的状态色（浅色 / 深色各一套，在 `styles.css` 的 `--state-*`）。关闭原因和草稿标记三条读取路径都读：Project（GraphQL `stateReason` / `isDraft`）、仓库列表（REST `state_reason` / `draft`）、改完后的单条重读，所以草稿 PR 在徽章、卡片、表格里都是灰色；徽章优先用详情现读的草稿标记（更新），详情没读到时用看板读到的。
- **详情面板按「这一次打开」认回应**（`src/renderer/openSession.ts`，四种异步调用——读详情、读仓库候选、预览、修改——都走它）：每次打开一条（换到别的再回来、关掉再开都算新的一次）是一个新面板，上一次打开发出的回应一律不进新面板；同一次打开里，同类的新调用作废旧的（改完后的重读胜过慢的刷新，改了字后旧文字的预览不显示）。修改晚到时，结果显示在看板顶部（带编号），不动新面板的草稿、忙碌状态和对话框。负对照里有真实界面的项（`runner: 'e2e'`），`MUTATION=1` 时自动构建并驱动真实窗口（WebKit + 真实后台）。
- **图片只从 `github.com` / `api.github.com` 加载**，外加头像地址 `avatars.githubusercontent.com`（#155，维护者选的：只为头像放开这一个地址；页面和隔离框各自的 CSP；页面的写在 `src-tauri/tauri.conf.json`，地址由 `src/shared/avatar.ts` 一处生成）。Electron 版还有第二层「主进程拦掉窗口发往其他主机的一切请求」，Tauri 用系统网页引擎，没有这一层（#151 方案里写明的取舍）；补偿是凭据从不进窗口，窗口即使被塞进别的内容也拿不到凭据去别处用。GitHub 把大多数图片改写成 `camo.githubusercontent.com` 或附件地址，这些不加载，那一条下面会写「有 N 张图片…没有加载，点『在网页上看』」。
- **交回 agent** = 加 `pending/agent`、摘 `pending/human`（先加后摘：第二步失败也不会两个都没有）；标签名在设置里改，要和 daemon 配置一致。
- 被拒时界面照实显示原因（含 GitHub 的原话），GitHub 上什么都不改；测试对每种被拒情况核对假 GitHub 的 `digest()` 前后相同。
- 缓存格式升到第 2 版（多存了写入要用的各种 id），#137 再升到第 3 版（多存了作者、父 issue、子 issue 进度、关联 PR、网页视图）：升级后第一次启动会丢掉旧缓存、重新同步一次。

### 头像、浮动详情、PR 跟在 issue 下面、缩放（#155）

- **头像**：卡片（作者、负责人）、表格（作者、负责人两列）、详情（作者、负责人、讨论里每条的作者）都在名字前放头像，按登录名从 `avatars.githubusercontent.com` 取（不改查询、不改缓存）。已删除的账号、图片加载不出时显示首字母；隔离框里没有脚本，首字母垫在图片下面。
- **详情浮在看板上**：贴右、从搜索栏下方到底，看板宽度不变；左边缘可拖动改宽度（最窄 360px，窗口左边总留 120px 看板），宽度存进视图设置，关掉再开、重开 App 都保持；窗口变窄时自动收窄，变宽恢复。Esc 关掉（正在输入回复、或有对话框时不关）；点过讨论之后键盘在讨论框里，Esc 传不到外面，要先点一下讨论以外的地方（面板空白处、标题）再按 Esc，或直接点「关闭」——讨论框保持隔离、不跑脚本，维护者在 PR #171 选的。
- **PR 跟在关联 issue 下面**（视图设置里的开关，默认开，看板和表格都生效；规则只有一份：`src/data/prNest.ts`）：关联关系是 issue 侧栏的「关联 PR」（会关掉这个 issue 的 PR）。只在同一列 / 同一组里归在一起，PR 缩进一格带「↳」；排序是「更新时间」时，这一对按两者里更晚的那个排，其他排序按 issue 的位置；一个 PR 关联同列几个 issue 只跟在排得最前的那个下面；一个 issue 有几个 PR 时按更新时间从新到旧；分泳道时 PR 跟进 issue 的泳道；表格同时缩进子 issue 时，PR 排在子 issue 前面。只从仓库来源读到的 issue 不知道关联 PR（表格里那格显示「—」），它们不归组。
- **缩放**：macOS 菜单「缩放」里的放大 ⌘= / 缩小 ⌘- / 实际大小 ⌘0，档位 50%–200%，整个窗口（包括详情里的讨论）一起缩放；档位存在后台本地存储（`src-tauri/crates/core/src/zoom.rs`），重开 App 恢复。菜单快捷键只在 macOS 上有（其他平台的构建只用于测试）。

## 搜索、筛选和表格视图（#137）

**搜索框**在客户端本地、对缓存数据筛，写法沿用 GitHub 网页（`src/shared/filter.ts`，打字即出结果，停手 0.3 秒后存进视图设置）：

| 写法 | 说明 |
|---|---|
| 文字 | 匹配标题、编号（`135` / `#135`）、标签名；不分大小写；中文词中间也能搜到（GitHub 按空格和标点切词，「看板客户端」里的「客户端」它搜不到） |
| `label:` `status:` `milestone:` `assignee:` `author:` `repo:` `iteration:` | 值完全相等、不分大小写；`repo:` 要写 `组织/仓库名` |
| `iteration:@current` / `@next` / `@previous`，`assignee:@me` / `author:@me` | 迭代按各自 Project 的期次算 |
| `no:` / `has:` 加 `label` `assignee` `milestone` `iteration` `status` | |
| `is:open` `closed`（含已合并的 PR，和 GitHub 一样）`merged` `issue` `pr` | |
| `project:` | 本客户端新增：按来源 Project 的标题、编号或网址筛 |
| `-` 取反、逗号「或」、引号包住带空格的值 | 同一字段写两次是「且」 |

不支持的写法（正文 / 评论、日期比较、`reason:`、自定义字段——包括中文字段名 `优先级:高` 和带引号的 `"Start date":…`、`sort:`、文字前加 `-`、`is:draft` 这类不认识的值……）一律在黄条里点名、忽略，结果可能比网页多，**绝不会因为一个不认识的词变成「0 条」**（GitHub 自己对不认识的写法会静默返回 0 条，`-文字` 也是）。某个来源这次没读全时，筛选上方也有一行黄条。

看板上的黄条（不支持的写法、筛选可能不全、离线、同步不完整、同步问题）右侧都有「×」，点了只收起那一条。按「问题本身」记，不按文字记：只是时间过去（「1 分钟前」变「5 分钟前」）、在看板和设置页之间来回切，都保持收起；失败的来源或原因变了、问题恢复后又出现、取消筛选后再筛选，都会重新出现。只记在本次运行里，重开 App 后仍存在的问题照常显示。

`author:` GitHub 的 Project 筛选并不支持（录制时 `author:x` 和 `-author:x` 都返回 0 条），本客户端按条目的作者筛。

**和 GitHub 对拍**：`record.mjs` 录看板数据的同一次运行里，用 GitHub 的服务端筛选（`items(query:)`）跑一遍约 50 条查询，`test/unit/filter-parity.test.ts` 要求客户端对每条筛出完全相同的条目。只有两类预期不同、单独断言：中文词中间（客户端更全）和 `author:`（GitHub 不支持）。

**表格视图**和看板并存，工具栏右侧切换。排序是两种布局共用的：看板每一列里卡片的顺序、表格里行的顺序都按它（导入的「按更新时间从新到旧」在看板上同样生效）。表格的「视图设置」里还能改：分组（迭代 / 状态 / 里程碑 / 仓库 / 不分组）、排序（含「Project 里的顺序」）、显示哪些列、左侧按仓库切片、子 issue 缩进在父 issue 下。一个条目在两个 Project 里迭代或状态不同时，在两组里各出现一次（和看板一样）。子 issue 只在父 issue 也在同一组里时才缩进。

**导入网页视图**：添加 Project 时，第一次完整读到它之后导入它网页上存的一个视图（贴的网址带 `/views/N` 就导那个，没带就导第一个）：布局、分组、排序、列、筛选。只导入一次——之后网页上改了视图不会跟着变；导入前用户已经动过的设置以用户为准；删掉再加这个 Project 会重新导入。做不到的部分（自定义字段分组 / 排序 / 列、路线图布局、多级排序）在视图顶部列出来。GitHub 的接口不返回「按仓库切片」和「显示层级」两个开关，导入时都设成开。仓库来源（REST）读不到「关联 PR」，那一格显示「—」。

## 登录用的 GitHub 应用

浏览器授权走 GitHub 的设备授权流程（App 显示短码，浏览器里输入、同意）。登录页和设置页都有「登录方式」二选一：**默认 OAuth 应用**（已内置），用户想用时可选 **GitHub App**（预览，维护者 2026-11-05 在 #140 定：第一版先把 OAuth 做完整，GitHub App 以后再完整支持）。选项旁的小字链接「两种有什么区别？」打开一页说明（纯本地文字）。说明页、选项下的权限说明和登录前的 Client ID 核对都来自 `src/shared/appKind.ts` 一处：只说能确定的事——OAuth 应用申请的 scope 是本客户端定的，可以写明；GitHub App 的权限由那个 App 登记时决定、登录请求收窄不了，所以不承诺「碰不到代码」；令牌过不过期是各自应用的设置，不按登录方式一刀切。Client ID 和所选方式对不上（GitHub App 的 ID 以 `Iv` 开头，OAuth 应用的不是）时，输入框当场提示、不让保存，登录也直接拒绝、不联系 GitHub。登录代码本身不区分两种：

| | OAuth 应用（默认，已内置） | GitHub App（可选，预览） |
|---|---|---|
| 权限 | 本客户端整块申请：`repo`（含代码与设置）、`read:org`、`project` | 由 App 登记时逐项勾选（下面「建 GitHub App」推荐只勾 Issues、Pull requests、Projects 读写 + 仓库基本信息只读）；登录时收窄不了，以授权页为准 |
| 令牌 | 看应用设置：开了令牌过期就带续期令牌，没开就不过期 | 看 App 设置：默认 8 小时过期、带续期令牌（约 6 个月），建 App 时可关；GitHub 每次续期都换一个新的续期令牌 |
| 能看到的 | 账号能看到的、申请范围内的 | 账号能看到的、App 权限允许的、App 装到的仓库，三者交集 |
| 这一版 | 内置 Client ID，直接登录 | 没有内置的 App：要填自己建的 GitHub App 的 Client ID；还没做的：内置 App、引导组织安装、提示「哪些仓库没装到」 |

客户端会在令牌到期前 5 分钟自动续期，GitHub 说 401 时也先续期重试一次。续期只在一处进行，同一时刻最多一次（续期令牌用过即作废）。续期的结果只有这几种（`src-tauri/crates/core/src/engine.rs` 的 `ensure_fresh` 注释里逐条列着）：

| 续期遇到的 | 结果 |
|---|---|
| 连不上、超时、HTTP 5xx / 429（不管正文写什么） | 暂时不可用：登录、凭据、缓存都保留，下一轮再试 |
| GitHub 回 `bad_refresh_token`（续期令牌错误或过期） | 回登录页并说明原因 |
| 其他错误、回应无法解析、没有新令牌 | 不能证明凭据失效：保留一切，顶部提示，下一轮再试 |
| 拿到新令牌但写钥匙串失败 | GitHub 已作废旧续期令牌，所以新令牌留在内存里继续用、顶部提示，之后每轮重试保存；保存成功前退出 App，下次要重新登录 |
| 续期途中退出登录 / 换账号 | 退出、新登录优先，这次续期什么都不留 |

任何情况下续期都不会抛出没人处理的错误（有真实子进程测试守着）。

**启动时只用「可信」的凭据**：本地数据库里记着一份可信名单（只存凭据的哈希，写入是同步落盘的）。启动时钥匙串里的凭据不在名单上，就不用它登录，回登录页并把它删掉。名单只在这几处改：

| 时机 | 名单怎么变 | 为什么 |
|---|---|---|
| 退出登录（手动、续期被拒、续期令牌到期） | **第一步**清空，然后才切页面、才排队删钥匙串 | 删除排队中、进行中、失败、或进程直接被关掉，重启都不会用旧凭据 |
| 登录 | 写钥匙串前清空；写成功且这次登录没被取消，才加入新凭据 | 写到一半被关掉、或被取消，重启都不信它 |
| 续期 | 写钥匙串时同时信任新旧两份；写成功后只留新的 | 写到一半被关掉，重启用新的继续，不用重新登录 |
| 名单从没写过（这条规则之前的预览版留下的数据） | 当作空名单：不用钥匙串里那份，回登录页并删掉它 | 旧数据分不清「还登录着」和「退出了但没删掉」（只有最后一版预览会记「不得复用」，更早的什么都不记），所以一律不信。代价是装过预览版的人升级后要重新登录一次 |

退出时钥匙串删不掉，登录页会写明旧凭据可能还在钥匙串里；它已不在名单上，下次启动会再试着删。两进程测试（`test/unit/crash-restart.test.ts`）在每个时刻结束第一个进程，再用同一份磁盘数据启动第二个进程核对。

内置的 Client ID 在 `src/shared/config.ts`：OAuth 应用是 `DEFAULT_OAUTH_CLIENT_ID`，GitHub App 是 `DEFAULT_GITHUB_APP_CLIENT_ID`（目前为空）。Client ID 不是秘密。两种方式各存各的覆盖值（`oauthClientId` / `githubAppClientId`），在登录页或设置页「改 Client ID」里改；选了 GitHub App 而没有 Client ID 时，登录直接说明要填什么，不会联系 GitHub。预览版只有一格 Client ID：里面存的是 GitHub App 的 ID（`Iv` 开头）时，升级后自动归到 GitHub App 那一格并保持选 GitHub App。续期时用的是登录那一刻的 Client ID，之后改登录方式或 Client ID 都不影响已登录的令牌（有测试）。

### 建 GitHub App 的逐项设置

1. 在 GigleAI 组织页「Settings → Developer settings → GitHub Apps → New GitHub App」新建（建在组织下，组织的 Project 才能授权给它）。
2. **GitHub App name**：`Cavil Loop`；**Homepage URL**：`https://github.com/GigleAI/cavil-loop`。
3. **Identifying and authorizing users**：勾 **Expire user authorization tokens**（默认已勾）；**Callback URL** 留空也行（设备授权用不到）；不勾「Request user authorization (OAuth) during installation」。
4. 勾 **Enable Device Flow**。
5. **Webhook**：取消勾选 **Active**（客户端不需要回调）。
6. **Permissions**：
   - Repository permissions：**Issues** = Read and write；**Pull requests** = Read and write；**Metadata** = Read-only（必选）。其余保持 No access。
   - Organization permissions：**Projects** = Read and write。其余保持 No access。
   - Account permissions：全部 No access。
7. **Where can this GitHub App be installed?**：Only on this account。点 **Create GitHub App**。
8. 不需要生成 Client secret，也不需要 Private key。
9. 在 App 页面左侧 **Install App** → 安装到 GigleAI → 选 All repositories 或要看的那几个仓库。
10. 把 App 页面上的 **Client ID**（形如 `Iv23li…`）写进 `DEFAULT_GITHUB_APP_CLIENT_ID`，或先在登录页选「GitHub App」、把它填进 Client ID 框试用。

要在客户端里**合并 PR**，按 GitHub 文档 App 还要 **Contents** = Read and write（上面没勾；OAuth 应用的 `repo` 已含这项）。不加的话，其他操作照常，合并会被 GitHub 拒绝、界面照实显示原因。

## 发版

改 `package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml` 的 `version`（三处一致）→ 合入 main → 打标签 `client/vX.Y.Z` 并推送。`.github/workflows/client.yml` 会在两台 Mac 上各打一个 dmg（`tauri build --bundles app` + `scripts/make-dmg.mjs`）、过体积门槛（`scripts/size-gate.mjs`：每个 ≤ 20 MB）、跑 `scripts/mac-open-check.sh`，通过后建 Release（说明取自 `RELEASE_NOTES.md`，不标成 Latest，daemon 的每周发版不受影响）。
