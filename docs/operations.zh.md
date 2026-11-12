# 运维手册

> [English](operations.md) · **中文**

## 配置（`cavil-loop.config`）

放在 host project 根，已自动加 `.gitignore`。

```bash
# GitHub
REPO="myorg/myrepo"

# 路径
PROJECT_ROOT="$HOME/github/myproject"
WORKTREE_BASE="$HOME/github/worktree/myproject"
STATE_DIR="$HOME/.local/state/cavil-loop/myproject"

# 日志：默认 info；debug 额外记录优先级读取、greedy 跳过及 review 轮次用尽明细。
LOG_LEVEL="info"

# 命名规范
TMUX_PREFIX="myproject"          # tmux session: myproject-issue42
BRANCH_PREFIX="feature/issue-"   # branch: feature/issue-42
SESSION_NAME_PREFIX="issue"      # Claude session name: issue42

# Label
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_AGENT_FABLE="pending/agent/fable"
FABLE_WORKER_AGENT="claude"
FABLE_MODEL="fable"
LABEL_PENDING_HUMAN="pending/human"
LABEL_AGENT_DOING="doing/agent"
LABEL_PENDING_PR="pending/PR"
LABEL_DONE="Done"

# Worker 选择
WORKER_AGENT="claude"           # 普通任务；默认值
WORKER_MODEL=""                 # 可选，只覆盖普通任务的模型
REVIEW_WORKER_AGENT="codex"     # 独立 review；仅启用 review 关卡时使用
REVIEW_MODEL=""                 # 可选，只覆盖 review 的模型

# 安装命令（worktree 创建后跑）
WORKTREE_SETUP_CMD="npm ci || npm install"
# 例子：
#   uv:     "uv sync"
#   Cargo:  "cargo fetch"
#   pip:    "pip install -r requirements.txt"
#   Make:   "make setup"
#   none:   ":"

# 要复制到 worktree 的 gitignored 文件
COPY_TO_WORKTREE=".env"

# Worker 身份（commit author）
WORKTREE_GIT_USER_NAME=""        # 空 = 用 global ~/.gitconfig
WORKTREE_GIT_USER_EMAIL=""

# Claude Code 启动 flag
CLAUDE_EXTRA_FLAGS="--dangerously-skip-permissions"

# 传给 worker 的 env（tmux 默认不继承）
WORKER_PASS_ENV="GH_TOKEN"

# 第二把 GitHub 身份：GH_TOKEN 只管轮询 / 读，这一把管所有写（翻 label、daemon
# 的告警 issue、合并后复盘的 push，以及交给 worker 的那把）。留空 = 复用
# GH_TOKEN，也就是现在的单账号行为。本文件装着 token 时保持 0600。
# WRITE_GH_TOKEN=""

# Merge 后 daemon 自动 cleanup（worktree + tmux）
AUTO_CLEANUP_ON_MERGE="true"

# 等你审（pending/human）的 PR 和目标分支冲突了（GitHub#86）。只在目标分支或 PR
# 自己有新提交时才查。N 天内有更新 → 发一条评论 + 改回 pending/agent 让 worker 解；
# 更久没动 / 外部仓库 → 只发一条提醒，标签不动。设 0 = 只提醒、从不自动解。
PENDING_HUMAN_CONFLICT_CHECK="true"
PENDING_HUMAN_CONFLICT_AUTOFIX_DAYS=2

# 项目级 cleanup hook（解端口、撤 tunnel、推 metric）
CLEANUP_HOOK=".agents/skills/cavil-loop/cleanup-hook.sh"

# 节奏
MAX_CONCURRENT_WORKERS=1

# 闹钟多久把 poller 叫醒一次。setup.sh 会把它写进 systemd timer drop-in / launchd
# plist，所以改完要重跑一次 setup.sh 才生效。
POLL_INTERVAL_SECS=60

# 空闲退避阶梯：`<安静了多少秒>:<用多大间隔轮询>`，逗号分隔。按**安静了多久**分档。
# 留空 = 整个特性关闭（空闲退避和故障退避一起关）。
POLL_BACKOFF_LADDER="86400:300,259200:600,604800:1800"
# 心跳：距上次成功读到 GitHub 超过这么久就无条件跑一次完整轮询，不管退到哪一档。
POLL_FORCE_SYNC_SECS=1800
# 空闲时的轻量检查（GitHub#252）：退避中每 tick 先发一次不占主额度的条件请求，仓库变了
# 就提前完整跑一轮。写 false 关掉。开着时完整检查最长间隔封顶下面这个值。
POLL_IDLE_PROBE=true
POLL_IDLE_PROBE_MAX_SECS=600
# 读不到 GitHub 时单独一套阶梯（从 POLL_INTERVAL_SECS 起步、每多失败一次翻倍、封顶在
# 这个值），且**不推进安静
# 计时**：「读不到」不等于「没活干」。
POLL_FAIL_BACKOFF_MAX_SECS=1800
# 给 timer 抖动留的余量，免得 60 秒那档被抖成 120 秒。
POLL_DUE_SLACK_SECS=10

# 一条活连续派工失败这么多次就放弃：摘掉触发 label、转 pending/human。
# 派工失败本身什么都不改，所以没有上限的话下一轮会原样再来、直到天荒地老
# （2026-09-18 实测：2 小时 24 分重派 270 次，直到 GitHub 把 bot 账号封停）。
# 计数在 $STATE_DIR/dispatch-fail/，成功和升级转人工时都会清零。
DISPATCH_MAX_RETRIES=3
# self-heal 那边同理：tmux session 死掉的 worker 最多自动重派几次，超了转 pending/human。
SELFHEAL_MAX_RETRIES=3

# 本地 base 落后 origin 这么多 commit 就开 issue 提醒（跟上后自动关）；默认 0 = 关
# 只有人真的上手干活的那个 checkout 才会卡住，所以是 opt-in；要开推荐设 20
CHECKOUT_STALE_ALERT_COMMITS=0

# 本配置缺某个「不写就关、模板里开着」的新功能那一行时，开一条挂 pending/human 的提示 issue，
# 写明要加哪一行；false = 只写轮询日志（GitHub#289，见下文「升级不会自动补上的新配置」）
CONFIG_NOTICE_ISSUE=true

# 1 = PR 分支被本项目自己的主 checkout 占着、且它干净、没有进行中的操作、与 PR 最新提交
# 完全一致时，把它切回 BASE_BRANCH 继续派工（会在 PR 上留言）。默认 0 = 关：它放宽了
# 「daemon 不碰你的工作区」
AUTO_RELEASE_MAIN_CHECKOUT=0

# 派工口径：label = 只捡打了 pending/agent 的；greedy = 开着的都干，除非被挡工 label 挡住
DISPATCH_MODE="label"
GREEDY_SKIP_LABELS=""            # greedy 下额外的挡工 label（逗号分隔，追加在内置五个之后）
GREEDY_SCAN_LIMIT=100

# 第一排序键从哪儿来：label = priority/p* 标签；project = GitHub 的 Priority 字段；both = 前者优先、缺了回落标签
PRIORITY_SOURCE="label"
PROJECT_PRIORITY_FIELD="Priority"
PROJECT_NUMBER=""                # 留空 = 本仓库关联的第一个看板；看板在别处就填编号
PROJECT_OWNER=""                 # 看板 owner 跟仓库 owner 不同时才填
PROJECT_GH_TOKEN=""              # 只用于读看板的 token；留空 = 复用 GH_TOKEN
AUTO_ADD_PROJECTS=""             # 把本仓库 issue / PR 加进这些 Project（"myorg/4 myorg/11"）；留空 = 关闭
# WRITE_GH_TOKEN=""              # 所有**写**用的 token；留空 = 复用 GH_TOKEN
```

完整字段见 [`cavil-loop.config.example`](../cavil-loop.config.example)。

## Codex token 折算参考价值

未设置 `CODEX_PRICES` 时，Codex 用量驱动使用
[内置价格表](../scripts/drivers/token-usage/codex-prices.json)。该表在
2026-10-19 对照官方模型页核过标准文本输入、缓存输入和输出标价，覆盖
[`gpt-6-astra`](https://developers.openai.com/api/docs/models/gpt-6-astra)、
[`gpt-6.1-sol`](https://developers.openai.com/api/docs/models/gpt-6.1-sol)、
[`gpt-6-sol`](https://developers.openai.com/api/docs/models/gpt-6-sol)、
[`gpt-6-luna`](https://developers.openai.com/api/docs/models/gpt-6-luna)、
[`gpt-5.6-sol`](https://developers.openai.com/api/docs/models/gpt-5.6-sol)、
[`gpt-5.6-terra`](https://developers.openai.com/api/docs/models/gpt-5.6-terra)、
[`gpt-5.6-luna`](https://developers.openai.com/api/docs/models/gpt-5.6-luna)、
[`gpt-5.3-codex`](https://developers.openai.com/api/docs/models/gpt-5.3-codex)、
[`gpt-5.2-codex`](https://developers.openai.com/api/docs/models/gpt-5.2-codex)、
[`gpt-5-codex`](https://developers.openai.com/api/docs/models/gpt-5-codex) 和
[`codex-mini-latest`](https://developers.openai.com/api/docs/models/codex-mini-latest)。
GPT-6 的四个型号与 GPT-5.6 的三个型号另配有官方列出的缓存写入单价；名字带 codex 的型号
官方未列缓存写入价，其缓存写入仍报缺价。
`gpt-5.6-sol` 目前是促销价，官方只保证至 2026-11-21；请在此之前复核该型号，
不要等 90 天过期提示（它来得更晚）。

部署者可按完整模型 ID 设置 `CODEX_PRICES` JSON，整表替换内置表；
[配置模板](../cavil-loop.config.example)有可直接复制的版本。设
`CODEX_PRICES='{}'` 可关闭估算。未知模型或缺少单价的 token 项仍报缺价。
旧的三个 `CODEX_PRICE_*_PER_M` 变量仍可为没有精确 `CODEX_PRICES`
条目的模型提供统一单价兜底；有精确模型条目时，精确条目优先。
若要从宿主配置覆盖，使用 `export CODEX_PRICES='...'`，并把
`CODEX_PRICES` 加入 `WORKER_PASS_ENV`；tmux 内的 worker 不会自动继承
未导出的配置变量。

美元金额是**按 API 公开标价折算的参考价值**，不是订阅账单或已核验的实际支出。
驱动无法识别长上下文与 Fast/Batch/Flex 档位，估算只取 Standard 标价。
内置表是静态的；超过 90 天，人读用量会提示复核。表里已有的模型不会在运行时刷新；
只有表里**没有**的模型会被自动补价（见下一节）。
周报分别披露内置公开参考价和部署者自填价；两者都未与账单独立交叉核验。

## 缺价自动补价

用量驱动（Claude / Codex 两侧）发现某个模型有用量却没有单价时，footer 照实写「金额未计」，
同时在 `~/.cache/cavil-loop/unpriced/` 下留一个空标记。驱动跑在 worker 里，**不联网**。
daemon 下一轮看到标记，运行 `scripts/drivers/token-usage/price_fetch.py`，下载：

| 来源 | 默认地址 |
|---|---|
| Anthropic 官方价目页（markdown 版） | `https://platform.claude.com/docs/en/about-claude/pricing.md` |
| OpenAI 官方价目页（markdown 版，只读 Standard 表） | `https://developers.openai.com/api/docs/pricing.md` |
| LiteLLM 社区价目表（GitHub 上的 JSON） | `https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json` |

只有官方页与 LiteLLM **一致**（两边都列出的每一项偏差 ≤ 10%）、各自通过合理性校验
（正数、≤ $1000/M、output ≥ input、缓存读 ≤ input）、且官方页上该模型只有一行时，才写进
`~/.cache/cavil-loop/fetched-prices.json`；只有一边列出的项照旧算缺价。此后两个驱动都按它计价，
footer 人读行多一句「（含自动联网获取的单价）」，金额单独记在 `fetched` 可信度桶里，一路带到周报。

- 只补缺：内置价和部署者配的 `CODEX_PRICES` 永远优先；显式设了 `CODEX_PRICES`（包括 `{}`）
  时 Codex 侧不补。
- 失败（下载失败、页面改版、两边对不上）连同原因写进 `poll.log`，6 小时后再试
  （`PRICE_FETCH_COOLDOWN_SECS`）。单次请求 15 秒超时（`PRICE_FETCH_TIMEOUT`），抓价失败不影响派工。
- 发现缺价的那一条评论仍写「金额未计」，下一轮之后的评论才带金额；已发出的 footer 不改写。
- 关闭：`PRICE_AUTO_FETCH=0`。三个地址可用 `PRICE_FETCH_ANTHROPIC_URL` /
  `PRICE_FETCH_OPENAI_URL` / `PRICE_FETCH_LITELLM_URL` 覆盖。
- 想让 daemon 立刻重试失败的模型，删 `~/.cache/cavil-loop/price-fetch-state.json`；
  想丢掉某个抓来的价，改或删 `fetched-prices.json`。

## 按模型派工的标签

使用 `pending/agent` 时沿用 worker CLI 的默认模型；使用
`pending/agent/fable` 时，本次派工会切到 Claude Code，并追加
`--model fable`（即 `FABLE_MODEL`，别名会解析成最新的 Fable 版本）。这个覆盖只作用于本次派工，不会修改项目默认 worker。
issue、PR、全新 session 和 resume session 都支持。

没有指定模型时，续接 Claude 会话也会显式带 `--model`：只跑 `claude --continue` /
`--resume <id>` 会沿用会话**当初**的模型，长期开着的 issue 就永远换不到新的默认模型。
daemon 直接问 Claude「现在新开一条会话会用哪个模型」：续接前在 worktree 里、带同一份
`CLAUDE_EXTRA_FLAGS` 跑一次 `claude -p --no-session-persistence --strict-mcp-config
--output-format stream-json`，从第一行 `system/init` 读出模型后立刻杀掉。探测时
`ANTHROPIC_BASE_URL` 指到本机不监听的端口，不会有 API 请求发出去。所以配置优先级
（环境变量、managed、`--settings`、git worktree 的本地配置、`--setting-sources`……）
用的是 Claude 自己那套，这里不复刻。补充：

- `CLAUDE_EXTRA_FLAGS` 里已有 `--model`，或拆不开（引号不配对）→ 不探测、不追加。
- 探测收到的参数必须跟 worker 从 bash 拿到的逐个相同。这串参数绝不 `eval`，
  用白名单拆词：只接受 bash 拆法确定的写法——不加引号的 `[A-Za-z0-9-_=+.,:/@%]`、
  单引号、不含 `$` / 反引号 / 反斜杠的双引号、词首的 `~` / `~/…`（展开成 `$HOME`）。
  引号外出现其他字符——`\`、`$`、反引号、通配符、花括号、`;&|<>()!#`、非词首的 `~`、
  `~user`——一律不探测、不追加（日志记一条）。测试里拿接受的写法跟 bash 自己的拆法逐个对比。
- 时限只用 bash 自带功能（不依赖 macOS 默认没有的 coreutils `timeout`）；探测进程
  不理 TERM 时，再等 2 秒补 KILL。
- 探测失败（`CLAUDE_MODEL_PROBE_TIMEOUT` 内没读到 `init`，默认 20 秒；找不到
  `claude`）→ 不追加，会话保持原模型，poll 日志里会记一条。
- 每次续接多 3–4 秒，项目的 `SessionStart` hook 会多跑一次（已用 touch 文件的 hook 实测）。如果你在 settings 里
  自己设了 `ANTHROPIC_BASE_URL`（或用 Bedrock / Vertex），探测的请求挡不住：读到
  `init` 就会被杀，但可能已经发出一个请求。

新评论到达时会话仍活着的，走注入 prompt，模型不变，直到这个会话重启。

daemon 会把选中的 worker 和模型记录在 tmux `@worker_agent` /
`@worker_model`，并把模型写入 `state.json`。如果现有 idle session 的 worker
或模型不同，会重启并以指定组合 resume；worker crash 后 self-heal 也会恢复到
同一个模型专用 pending 标签。

若两个 pending 标签同时存在，`pending/agent/fable` 优先。

## 并发满时的取工顺序

待派工的条目多于空闲 slot 时，daemon 把 issue 队列和 PR 队列**合成一个池**，按三个
键依次比较，再从头依次取工（`PRIORITY_LABELS` 配置，默认
`priority/p0,priority/p1,priority/p2`）：

| 键 | 规则 | 说明 |
|---|---|---|
| ① 优先级 label | 列表里越靠前越优先；**哪儿都没标的垫底**（排在所有标过的之后） | 平时什么都不用打，只在真着急时挂一个 `priority/p0` 插队 |
| ② 阶段 | review 打回 < 续作 < 全新 issue | 在飞的活上下文还热，先收尾更快腾出 slot；全新 issue 还没开始，晚一轮没有沉没成本 |
| ③ 等待时长 | `updatedAt` 早的先派 | 同优先级同阶段时，久等的先走 |

`PRIORITY_LABELS` 留空 = 关掉 ①，只按 ②③ 排。

排序只决定**顺序**，不改变取工条件：busy 的 session 照样不打断，并发上限照样卡，
label 语义完全不变。每轮排完的结果会整行写进 `poll.log`，并发满时谁插了谁的队一眼可见：

```
派工队列 4 项，按「优先级/阶段/等待」排：issue#755(p0,全新) PR#747(p2,review打回) issue#712(p2,全新)
```

一条目同时挂多个触发 label 时，仍按 `pending/agent/fable` → `pending/agent` →
`pending/review` 取第一个，与排序无关。

### 第一排序键换成 GitHub Project 的优先级字段

`PRIORITY_SOURCE` 决定键 ① 从哪儿读：

| 值 | 键 ① 来自 | 没有值的条目 |
|---|---|---|
| `label`（默认） | `PRIORITY_LABELS` 里的标签 | 等同最后一档 |
| `project` | 关联 Project (v2) 上的单选字段（默认叫 `Priority`） | 落最后一档，**不看 label** |
| `both` | Project 上设了就用它，没设的回落到 label | 两边都没有 → 最后一档 |

**档位顺序不用在配置里再抄一遍**——直接取该字段在 Project 里定义的选项顺序，
在看板上拖一下就改了。用哪个 Project 由 `PROJECT_NUMBER` 指定，留空 = 本仓库关联的第一个。

**GitHub 新版的 Priority 是 issue 级字段，不是看板字段**——虽然它在看板上显示成一列、
在看板的字段设置页（`/projects/N/settings/fields/<id>`）里也点得进去。判据是实测出来的：

| 读法 | 看到什么 |
|---|---|
| Projects API `field(name:"Priority")` | `ProjectV2SingleSelectField`，但 **options 为空**（databaseId 跟设置页 URL 一致，界面上却有 Urgent/High/Medium/Low） |
| Projects API 条目值 | 类型是 `ProjectV2ItemIssueFieldValue`，不是单选值 → `fieldValueByName` 取不到 |
| Issue API `issue.issueFieldValues` | ✅ 值和选项顺序都在这儿 |
| 对照：`Status`（真·看板自定义字段） | options 正常返回 `Backlog/Preparing/...` |

所以 daemon 先试 issue 原生字段，拿不到再试真·看板自定义单选字段。后者是有些项目在用的
老做法，而且**只有它能标到 PR 上**——PR 没有 issue 原生字段。用着原生字段时，PR 一律
回落到 label 排序。日志会写明这轮用的是哪一种。

**用哪个看板是这么定的**：

| `PROJECT_NUMBER` | 怎么找 | 要求看板跟仓库关联吗 |
|---|---|---|
| 有值 | 按 `<PROJECT_OWNER, 编号>` 直取（先按组织找，找不到再按个人找） | 不要求 |
| 留空 | 取**本仓库关联的** Project 里编号最小的那个 | 要求 |

编号就是看板 URL 的最后一段（`github.com/users/<你>/projects/7` → `7`）。
`PROJECT_OWNER` 默认取仓库 owner，**看板挂在别的 owner 名下时必须配**——个人看板装着
组织仓库的卡片是最常见的那种。自动挑那条路显式写了 `orderBy=NUMBER ASC`，不依赖 API
没有承诺的默认顺序（仓库挂两个看板时，靠默认顺序会变成「今天排这个明天排那个」且毫无迹象）。
每轮日志都会写明实际用的是哪个：`Project 优先级：读到 12 条（看板 7 board7，字段 Priority，source=both）`。

⚠️ **读 Project 需要额外权限，这是最容易卡住的一步**：Projects v2 只有 GraphQL 接口。

- classic PAT 必须勾 **`read:project`**（在 <https://github.com/settings/tokens> 上给现有 token 补勾即可，不用换 token）
- **个人名下**的 Project（`github.com/users/<你>/projects/N`，不是组织的）还要求这个账号
  是该 Project 的协作者——bot 账号默认不是
- 不想动 bot 的权限，就用 `PROJECT_GH_TOKEN` 单独塞一个只读看板的 token

任何一环读不到，daemon **只记一条警告并在本轮回落到 label 排序**，不会停下派工：

```
⚠️ Project 优先级读取失败，本轮回落到 label 排序：{"errors":[{"type":"INSUFFICIENT_SCOPES",...
```

看到这条就去补 scope；补好后下一轮日志会变成
`Project 优先级：读到 N 条（字段 Priority，source=both）`。

## 自动把 issue / PR 加进 GitHub Project（可选，**默认关闭**）

GitHub 免费版每个 Project 只能开 **1** 条「自动加入」规则，每条只盯 **1** 个仓库
（[官方说明](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/adding-items-automatically)）。
想让多个仓库汇总到同一个看板，在每个仓库自己的配置里写：

```bash
AUTO_ADD_PROJECTS="myorg/4 myorg/11"   # 「组织或用户名/编号」，空格或逗号分隔
```

组织 / 用户名和 GitHub 一样不分大小写：`MyOrg/4` 和 `myorg/4` 是同一个看板、共用一份同步进度，
改写法不会让它从头再来。

之后每轮守护程序把本仓库的条目补进这些 Project：

| 条目 | 加不加 |
|---|---|
| 开着的 issue / PR（不管多老） | 加 |
| 已关闭 / 已合并、**新建时间晚于**这个 Project 第一次开始同步（例：守护程序停机期间新建又关掉） | 加 |
| 开始同步前就已关闭，之后有人评论 | 不加 |
| 老条目被重新打开 | 加（它又是开着的了） |
| 已在看板里（含已归档卡片） | 不发写请求 |

只加不改：不改字段、不移除卡片。**它不记得谁被手动拿掉过**：已经同步过的看板看的是「上次同步
前 10 分钟之后有更新」的条目，所以手动拿掉的卡片在两种情况下会被加回：那个条目之后又有了新动静；
或者它本来就在这 10 分钟里更新过（这段重叠是为了不漏掉轮询进行中发生的更新）。更早的条目不会
动——新加的看板做首次全量时，也不会把它们塞回已经同步好的看板。**没有单个条目的排除办法**：关掉
条目不能让它不进看板——看板开始同步之后才新建的条目，关闭 / 合并后仍是候选（停机期间新建又关掉
的条目正是靠这一条补进来的）。从 `AUTO_ADD_PROJECTS` 里去掉某个看板，会停掉这个看板的**全部**
自动加入，不是只排除一个条目。

**权限**：读走 `PROJECT_GH_TOKEN`（没配用 `GH_TOKEN`）；加入是写操作，走 `WRITE_GH_TOKEN`
（没配用 `GH_TOKEN`），写身份需要 classic PAT 的 **`project`** 权限，或 fine-grained 对该
Project 的写权限。读身份看不见某个 Project 时，不往它写任何东西——否则每个条目都会显得
「不在里面」、每轮全量写一遍。

**出错怎么办**：配错的项（`foo`、不存在的编号）、读失败、写失败都只记**一行**警告（内容变了
才再记），下一轮重试；派工和清理不受影响，各 Project 互相独立：新加的看板首次全量读失败，
不会拖住已经同步好的看板。

```
⚠️ 自动加入 Project：myorg/11：写入失败（写身份需要能写这个 Project）：issue #12 加不进去：Resource not accessible by personal access token，同步时间不推进，下一轮重试
自动加入 Project：myorg/4 已加入 3 条
```

**状态**（`$STATE_DIR/project-auto-add.json`，每个 Project 一项，故意不放进 `state.json`）：
第一次开始同步的时间、首次全量是否完成、上次完整成功同步的时间。第一次开始同步的时间在第一次
尝试时写下、之后不变。删掉这个文件 = 所有 Project 从头开始（「新建时间晚于」的分界随之挪到现在）。
请求量：没什么改动时每轮多 1 次合并读取；多配一个 Project 不会翻倍。

## 交叉 review 关卡（可选，**默认关闭**）

不配 `LABEL_PENDING_REVIEW` 就完全不存在这一环——skill 自带的默认 prompt 模板里
一个字都没提 review，已有项目升级上来行为分毫不变。配了才启用：worker **产出代码**时不再直接翻 `pending/human`，而是翻到该
label；daemon 用 `REVIEW_WORKER_AGENT`（默认 `codex`）+ `prompts/review.template.md` 起一个
独立 session 把关。通过 → `pending/human`；不通过 → 带具体意见打回 `pending/agent`。

```
pending/agent ──claude──> 代码产出 or 设计方案? ──否──> pending/human（提问 / 受阻 / 安全停机）
                              │是
                              ▼
                        pending/review ──codex──> 通过 ──> pending/human
                              ▲                    │不通过
                              ├────────────────────┘（打回 pending/agent，claude 改完再来）
                              │
                              └── 轮次用尽 ──> pending/review + pending/human（daemon 停手，等人）
```

**「等人」有两种状态，靠标签组合区分：**

| 标签 | 含义 | 人该做什么 |
|---|---|---|
| 只有 `pending/human` | 审过了，产出可以验收 | 验收 / 合并 |
| `pending/review` + `pending/human` | 轮次烧光，两个 agent 没谈拢 | 看汇总评论，自己拍板 |

第二种状态下 **daemon 完全不派工**（不管它在队列里排第几，`poll.log` 会写明跳过原因）。
人手动摘掉 `pending/human` 就是说「按我说的接着审」：那次 `unlabeled` 事件会把 reviewer
的「最近一次人工动作」时间戳推到最新、轮次计数归零，下一轮恢复正常 review。

几个设计要点：

- **reviewer 拿的是全新上下文**，看产出而不是看实现者的自述——这才是第二双眼睛的价值
- **设计方案要不要也过复审，另有一个开关 `REVIEW_DESIGN_PROPOSALS`（默认 `false`，GitHub#102）**。
  关着时只有代码产出过复审，写完方案 / 修订方案直接翻 `pending/human`；设成 `true` 并且配了
  `LABEL_PENDING_REVIEW` 时，方案改翻复审标签，审过才到你面前。只设开关、没配复审标签时照样交人。
  澄清答复、提问不受它影响。项目自己在 `new-issue.extra.md` / `issue-comment.extra.md` 里写了
  「方案翻 `${LABEL_REVIEW_OR_HUMAN}`」的老做法，开关开或关都照常先审——追加要求排在通用模板之后、
  冲突时以它为准，而 `${LABEL_REVIEW_OR_HUMAN}` 的取值和这个开关无关。想从老做法换成开关：先合并部署
  新版本，再在每台跑这个项目的机器上打开开关，最后才删追加要求里那句；顺序反了，方案会有一段时间直接交人
- **拦「代码产出」和「设计方案」两类**，各用各的清单。设计方案审的是根因是否成立、
  Design 能否解决它、验收标准是否可验证——此时没有代码是正常的，reviewer 不该因此判不通过
  （实测踩过：codex 拿审代码的尺子去量一份只有方案的 issue，只能报「没有可 review 的实现」）
- **方案复审不通过 = 「改方案」，不是「去实现」**。打回落到 `pending/agent`，跟人说
  「方案 OK，开干」共用一条队列，所以 reviewer 必须在评论里写明是哪一种——否则下一轮
  worker 会直接去实现一份人从没确认过的方案
- **未勾选的选择题不是缺陷**。约定是勾 1 项 = 拍板、都不勾 = 走默认项、多勾 = 想再讨论，
  所以「人还没勾」本身就是一个决定。reviewer 把它读成「缺少人工确认」，打回的是本来
  已经可以走的活；它该审的是默认项选得对不对
- 其余纯文字出口（提问、反问、受阻停机、安全停机）仍直达 `pending/human`，
  否则「我有个问题想问你」也要白烧一次 review、还拖慢你被问到的速度
- **轮次上限**（`REVIEW_MAX_ROUNDS`，默认 6）唯一的作用是防两个 agent 互相打回烧 API，
  所以**人显式要的 review 不受它约束**：人手动挂 review 标签 → 无视上限；人留了评论 →
  计数从那条评论之后重算、自然归零。判定靠比对 actor 与 `gh api user` 的账号，
  不需要揣摩评论文字的意图。轮次不存 state.json，数的是 issue/PR 上「最近一次人工动作
  之后」的 `<!-- codex-review-round -->` 标记：看板上看得见、state 丢了不会重置
- **复审结论评论的标题第一个字就是结论**：通过写 `## ✅ …`，其余（退回、轮次用尽交人、
  与主干冲突、检查没跑成交人）一律 `## ❌ …`，手机通知列表里扫一眼就知道（GitHub#84）
- **打回必须用默认的 `pending/agent`**，不是 review label 自己——模板里用
  `${LABEL_PENDING_AGENT_DEFAULT}` 占位符拿这个值。用错就是死循环
- self-heal 靠 `state.json` 的 `worker_trigger_labels` 把死掉的 session 送回**原来那条队列**；
  只按 model 反推做不到这点（review 关卡换的是 agent 不是 model）

留空 = 完全关闭，行为与从前一致。

## 托管标签（可选，**默认关闭**）

GitHub#114。配 `LABEL_AUTOPILOT`（例如 `autopilot`），并且开着复审关卡 `LABEL_PENDING_REVIEW`
（必需），维护者就能给某个 **issue** 打上这个标签，把它从头交到尾。没打标签的 issue 一切照旧；
`LABEL_AUTOPILOT` 留空时，提示词、轮询的 GitHub 调用和 `state.json` 与以前逐字节一样（从没开过托管的项目；开过又关掉的，
daemon 会先把等合并的 PR 交给人，见下面「怎么整体关闭托管」）。

```
issue：autopilot ──> 写方案 ──> pending/review ──通过──> pending/agent ──> 写代码 + 开 PR
                                     │不通过（改方案）                               │
                                     └───────────────────────────────────────────────┘
PR：  pending/review ──通过 + 测试记录──> pending/merge ──daemon 检查──> 合并
                                               │ 检查没过 / 冲突 ──> 交回 worker
                                               └ 其他不对 ────────> pending/human
```

- **开工**：只打托管标签就行——挂着它、没有任何状态 / 触发标签的 issue，当作打了 `pending/agent`
  派工。它是「模式标签」不是触发标签：daemon 从不摘它，看板上一直看得见。
- **PR 上也挂一份**（GitHub#190）：托管 issue 开出绑定它的 PR 之后，daemon 把托管标签复制到这个 PR 上
  （每轮检查，写失败下一轮再补）——PR 列表上就看得出哪些 PR 会被自动合并，也能直接在 PR 上摘标签叫停。
  issue 上那个保留：它才是授权。PR 上这份由 loop 的写入账号打，**永远不算授权**：不触发接手、不引出
  「托管标签不生效」说明，worker 自己往 PR 上打也没用。补和收回都判两次，第二次紧挨着写、全部现读
  （PR 是否打开 / 已合并、最新提交、目标分支、来源仓库 / 分支名、绑定的 issue 和它的状态、两处的 `pending/human`、
  授权所依据的那次打标签，收回时还有副本那条打标签记录），任一项变了或读不到，本轮不写。授权明确不成立之后
  （issue 或 PR 上摘了标签、issue 关了、PR 不再绑定……）daemon 把**自己补的那份**收回；维护者亲手打在 PR 上的从不动。
  绑 issue 的 PR **没挂这个标签就不合并**：算一轮判不了，连续 `AUTOPILOT_UNKNOWN_MAX` 轮补不上就交人。只管本机负责的 PR
  （和合并那一步同一条规则）。关掉托管之后，已经补到 PR 上的标签不清理（不起任何作用，想摘就手动摘）。
- **方案**：照常写、照常发到 issue，选择题按默认项，一律送复审（不管 `REVIEW_DESIGN_PROPOSALS`）。
  方案复审通过后 issue 翻回 `pending/agent`，worker 直接开干。
- **拆成子 issue 也托管**（GitHub#233）：拆分计划和方案一样只过复审，复审通过后 worker 直接建子项。复审额外审
  「真需要拆吗」和「父 issue 还留着子项以外的活吗」（托管时收尾也要落成子项）。本工具拆出来的子项——GitHub 上真挂在
  父 issue 下、正文带指向父 issue 的拆分标记、由 loop 的写入账号建——**继承父 issue 的托管**：子项和它的 PR 上都不用挂
  托管标签，派工、接手、PR 补标签、合并前许可都把父 issue 当作第三处，和 issue / PR 两处用同一条判据（停止线取三处
  所有「摘掉」里最晚的一次，授权来自晚于停止线、维护者亲手打的那一次）。父 issue 摘标签、打 `pending/human`、关闭，
  整组子项一起停；只停一个子项就在那个子项上打 `pending/human`。读不到父 issue / 它的标签记录 = 判不了：本轮不派工、
  不写任何东西，下轮再判（不按普通流程派出去）。子项全部关闭后父 issue 翻 `pending/human`，由人关闭。
- **合并后 issue 留给人关**（GitHub#233）：托管 PR 的正文只写 `Refs #N`、不写关闭关键词，GitHub 合并时不会关 issue。
  合并后 daemon 在 issue 上发一条说明——外面一句话结论和「要人做什么」，背景 / 采用的方案 / 排除的方案和原因照搬
  worker 写在 PR 正文里的总结段（`<!-- autopilot-summary:begin -->` 到 `<!-- autopilot-summary:end -->`），合并依据折叠在
  最后——然后把 issue 翻 `pending/human`、摘 `pending/PR`。人看过满意就关闭（关成「已完成」照常自动打 `Done`），要返工就打
  `pending/agent`。合并之后、交接之前 issue 上已经挂了任何流程标签（派工、进行中、复审、等前置、等人……），说明新一轮已经
  开始，交接一个标签都不动、只补说明。交接每次写之前现读 issue，状态或标签集合变了本轮不写；读不到下轮再试，说明按标记去重。
  ⚠️ 正文还带关闭关键词的托管 PR（包括以前开的 `Closes #N` 写法）合并前会被交回 worker，只把那一处改成 `Refs #N`。
- **互通名单**（`TRUSTED_REPOS`，GitHub#233，默认空）：逗号分隔的 `owner/repo`。名单里的仓库 ① 可以当拆分子项的父 issue
  所在仓库：父 issue 上维护者亲手打的托管标签授权本仓库的子项，打标签的人在**两个仓库**都要有写权限；② 可以当等前置的
  前置所在仓库（见下面「等前置」）。跨仓库读不到（父 issue、标签记录、权限）一律判不了，本轮不写。名单外的仓库照旧不认。
- **在 PR 上打也行**（GitHub#128）：已经开好的 PR，维护者直接在 **PR** 上打托管标签，daemon 就接手——
  PR 除托管标签外只挂着 `pending/human`（且授权打在它之后），或一个流程标签都没有、PR 自己挂着托管标签时，
  翻到 `pending/review` 并在 PR 上说一句，之后走下面同样的复审 → 合并。PR 上的托管只管「复审 → 合并」这一段，
  不涉及方案阶段（方案阶段只看 issue）。授权也可以来自 issue：PR 摘标交人之后，维护者只在 issue 上重新亲手打托管，
  同样会接手。还挂着 `pending/agent` / `doing/agent` / `pending/review` / `pending/merge` 的 PR（哪怕同时挂着
  `pending/human`）一律不接手：那是正在进行的工作，下次派工自然带上托管规则。接手要读的东西连续
  `AUTOPILOT_UNKNOWN_MAX` 轮判不了（一轮的结论看这一轮最后一次判定，写前那次判不了也算），PR 交人（加 `pending/human`、
  留一条说明），只交一次。「要交人」先记成一条待办再动手；这个决定的唯一依据是「判不了」，所以每次动手前都用同一个接手判断现读重判：
  还判不了才接着做（加标签、留言，任一步失败或进程被杀下一轮接着做）；判得出结论了——维护者重新授权、PR 关闭 /
  合并 / 改绑别的 issue / 转进别的流程、issue 关闭——待办作废，不写它的任何东西，改按现在的结论走普通接手流程。
  唯一的例外是标签已经由 daemon 为这条待办加上、只差说明，这时把说明补完。继续做的两种情况都要求 issue / 分支 /
  来源和交人决定时一样；本地记过「标签已加」而 `pending/human` 已被人摘掉的，视为人已接过这件事：不补说明，
  在有确定结论之前也不再交人。
  PR 上的标签不被认可（不是维护者打的、PR 不合条件、issue 已关、打标签那一刻的正文不合条件）时在 PR 上说一次原因。
- **没绑 issue 的 PR**（GitHub#142）：跨仓库任务的配套 PR、不绑 issue 的 PR，维护者在 PR 上亲手打的托管标签本身就算授权，
  新开就打也算。daemon 把 PR 分三种：
  - **绑 issue**：来自本仓库、分支正好是 `BRANCH_PREFIX<N>`、正文只关闭 `#N`——照上面「在 PR 上打也行」那套，issue 和 PR 两处合起来判；
  - **以 PR 为准**：来自本仓库、正文里**一个**本仓库关闭关键词都没有——`#N`、`owner/repo#N`（本仓库名，不分大小写）、
    `https://github.com/owner/repo/issues/N`、`GH-N` 这些写法都算关闭本仓库；只引用的 `Refs #N`、关别的仓库的不算——
    授权和叫停都只看 PR：PR 上摘托管标签或打 `pending/human` 就叫停，任何 issue 上的标签都不借给它，分支名恰好和本仓库某个 issue 同号也不看那个 issue；
  - **不合条件**：其余的（写了关闭本仓库 issue 的关键词却没正常绑定、关闭写法有歧义、来自 fork）——不生效，PR 上说一次怎么改。

  以 PR 为准时还要求**打标签那一刻的 PR 正文**也是这一种：daemon 读 GitHub 保存的 PR 正文修改历史（GraphQL `userContentEdits`），
  取修改时间不晚于打标签时间的最新一版（同一秒的几版和它之前那一版都要合条件；两边都是 GitHub 的时间，不受本机时钟影响）。
  PR 刚开就打、同一秒、之后正文又改过：历史最早那一版的时间等于 PR 的创建时间，就认它是开 PR 时的正文；不等（更早的版本缺了）算查不到。
  所以「先因为正文关着某个 issue 被拒、之后正文被改掉」「绑着 issue 时打的标签、之后删掉 `Closes #N`」，那次打标签都不算，
  要维护者看过现在的 PR 再亲手打一次。那一版被从历史里删掉 → 不生效、请重打；历史读不到或分页读不全 → 判不了，本轮不写。
  daemon 本机不为此记任何东西，换机器、状态文件丢失都不影响。这类 PR 没有方案阶段，接手后从代码复审开始；接手、合并的说明都发在 PR 上。
- **外部需求机器人提的需求**（GitHub#162 起也能托管）：授权照上面同一套，看谁打的托管标签，不看需求是谁提的。
  提需求方的确认一步不省：方案复审通过后照常叫醒机器人、等提需求方确认；要先汇报的项目，提需求方认可 PR 最新提交后交复审，
  复审核对认可的提交、重跑测试再翻 `pending/merge`。两个功能都开时派工提示词多一段「外部需求机器人提的需求 + 托管」写清这些，
  见[对接外部需求机器人 → 托管标签](requester-bot.zh.md#托管标签)。等待标签被提前摘掉、之后没人打派工标签的条目，
  只挂托管标签也不自动开工、不被接手（[等待期间 daemon 怎么做](requester-bot.zh.md#等待期间-daemon-怎么做)）。
- **代码**：复审通过时 PR 翻 `LABEL_PENDING_MERGE`（`pending/merge`）而不是 `pending/human`，
  并在结论评论里留一行测试重跑的机器记录：`<!-- autopilot-review-pass head=<sha> passed=<n> failed=<n> -->`。
- **daemon 合并**（`PUT /pulls/N/merge`，带复审时的提交号，方式 `AUTOPILOT_MERGE_METHOD`，默认 `squash`）
  只在下表全部成立时进行；合并后在 issue 上（没绑 issue 的发在 PR 上）留「已自动合并」评论，之后的清理 / `Done` / 复盘照常：

| 检查 | 不成立 → |
|---|---|
| PR 来自本仓库，并且要么绑 issue（分支正好是 `BRANCH_PREFIX<N>`，正文只引用一个 `Refs #N`、没有关闭关键词；或正文只关闭 `#N`，逐行和整段两种读法一致），要么正文一个本仓库关闭关键词都没有（以 PR 为准，GitHub#142） | `pending/human` |
| 绑 issue 的 PR 正文里没有会让 GitHub 合并时关掉本仓库 issue 的关键词（GitHub#233：合并后 issue 留给人关） | 交回 worker 改成 `Refs #N` |
| 以 PR 为准时：授权只看 PR（下一行去掉 issue 那一处），而且打标签那一刻的 PR 正文（修改历史里那一版）也合上一行的条件 | `pending/human` |
| 授权：issue `#N` 或 PR 上**现在挂着**托管标签，那一处最后一次「加上托管标签」的操作人是 `User` 类型、有 `write` / `admin` 权限，且不是 loop 的写入账号、不是 `REQUESTER_BOT_ACCOUNT`；**并且这次加上晚于 issue 和 PR 两处所有的「摘掉」**（见下面「两处的标签怎么合起来算」） | `pending/human` |
| PR 自己挂着托管标签（绑 issue 的 PR 由 daemon 从 issue 复制过来，见上文；GitHub#190） | 本轮判不了（连续 `AUTOPILOT_UNKNOWN_MAX` 轮 → `pending/human`） |
| issue 和 PR 都没被打 `pending/human` | `pending/human`（PR 上的 `pending/human`：只摘 `pending/merge`） |
| PR 最新提交**和目标分支**都是派复审时记下的那一对（同一提交改投别的分支 = 另一份改动；旧版没记目标分支的记录算缺） | 回 `pending/review` 重审 |
| 复审的结论评论（写入账号、派复审之后发的）里有这个提交的测试记录，`failed=0`、`passed>0` | `pending/human` |
| 没改 `.github/`——配了 `AUTOPILOT_HUMAN_PATHS`（GitHub#337）时是没改清单里的任何文件，见下 | `pending/human` |
| 这个提交上的检查（check run / commit status）全部通过（一个都没有 = 只靠上一条记录） | 没过 → 交回 worker；超过 `AUTOPILOT_CHECKS_TIMEOUT_HOURS`（6）还没跑完 → `pending/human` |
| GitHub 判定可合并（无冲突） | 交回 worker |
| 合并前最后一刻，**同一个许可判断用现读的数据原样再跑一遍**——上面每一行都在内，包括复审的测试记录（评论可以被编辑、删除）和自动检查（变红、重跑中、原本没有又冒出来）；两次都判「可以合」、且是同一个 issue / 提交 / 目标分支才合 | 本轮不合、不记任何状态 |

- **读不到**（标签记录、权限、检查、文件、评论）：本轮不写任何东西；连续 `AUTOPILOT_UNKNOWN_MAX`（10）
  轮读不到才交人。「读不到」绝不当成「有授权」「通过」「无冲突」。
- **交回 worker** 按 PR 计次，上限沿用 `REVIEW_MAX_ROUNDS`。
- **叫停**：摘掉 issue 或 PR 上的托管标签，或在 issue / PR 上打 `pending/human`。检查之后、合并之前的叫停由
  合并前的重读拦住。
- **两处的标签怎么合起来算**（GitHub#128）：停止线 = issue 和 PR 两处所有「摘掉托管标签」里最晚的那一次。
  授权只来自一次**晚于停止线**、由维护者亲手打的「加上」，而且那一处现在还挂着。所以：
  - 在任一处摘掉 = 叫停；之后维护者在任一处亲手重新打上 = 恢复
  - 叫停之后 loop 账号、Bot、没写权限的人再打上，不算恢复，也不能借另一处叫停之前的旧授权复活
  - 没摘过时，worker 在 PR 上打的标签不影响 issue 上已有的授权（它不是授权，也不是叫停）
  - PR 上从没碰过托管标签时，结果和只看 issue 一样；每次判断多读一次 PR 的标签记录
  - 两处的先后按标签记录的时间比；比不出（缺时间）算判不了
  - 接手时和 PR 上的 `pending/human` 比先后，逐条看所有成立的授权：PR 上的按记录顺序比，issue 上的按时间比（同一秒不算在后）；
    只要有一条明确在后就接手，另一处同一秒的授权不会把它遮住
- **接手也判两次**：判定可接手后、写之前，同一个判断用现读的数据原样再跑一遍（issue 是否打开、需求来源、
  两处的叫停与授权记录，PR 的状态 / 提交 / 目标分支 / 来源 / 绑定都在内），结论或身份变了本轮不写。
  判过「不接手」的 PR 按 PR 更新时间 + 绑定的 issue 编号 + 该 issue 的更新时间记下，三样都没变就不重读
  （打 / 摘标签会刷新更新时间）；合并前许可不走这个缓存。
  ⚠️ 打标签的人在仓库里的**权限**变了不会刷新更新时间：被拒的 PR 要等 PR 或 issue 有任何变动才会重判。
- **剩下的窗口**只在「最后这次读」到「合并请求到达 GitHub」之间。合并请求带着复审的提交号，这段时间的新推送
  GitHub 会拒；这段时间检查变红则拦不住。要服务端兜底，把这些检查设成目标分支的「必须通过」（分支保护），daemon 不绕它。
- **GitHub 拒绝的**（分支保护要求人工批准、合并方式没开）交人——daemon 不绕仓库规则。
- **多机**：复审的提交号只记在派复审的那台机器上，`SELFHEAL_ONLY_OWN_WORKERS=true` 时另一台的**合并那一步**不碰这个 PR；
  但普通派工和复审不看归属，所以托管的仓库只该有一台机器在轮询（见下面「只在一台机器上跑这个仓库的轮询」）。
- **两个账号**：loop 的写入账号和维护者必须是两个账号，否则任何标签都算不上维护者打的（worker 和复审都用写入账号写 GitHub）。
- **本仓库会部署自己**：`GigleAI/cavil-loop` 的 `main` 合并后几分钟内就在 daemon 上生效，在这里开托管意味着
  自动合并的改动会无人经手地改掉正在运行的 daemon。要不要在本仓库开是单独的决定，合入这个功能本身不会打开它。

状态在 `state.json` 的 `autopilot` 下（`prs.<n>`：复审的提交、目标分支与时间、打回次数、连续读不到次数、开始等检查的时间、托管关掉后交接做到一半的记号 `off_handover`；
`notices` / `denied`：只说一次的评论、按 `updated_at` 记下的被拒 issue；`takeover` / `takeover_unknown` / `takeover_handoff`：判过「不接手」的 PR 及其缓存键（`denied` 和 `takeover` 的值都带判定规则版本，规则放宽后的升级里旧记录自动作废、按新规则重判一次）、接手阶段连续判不了的轮数、还没做完的交人待办；`mirror`：判过「不用补 / 不用收回托管标签」的 PR 及同样的缓存键，GitHub#190）。和 `requester_bot_done_queue` 一样
不进迁移循环，功能真做了事才出现。

### 合并前必须人过目的文件（`AUTOPILOT_HUMAN_PATHS`，GitHub#337）

有一类文件，改动本身不是「运行代码」，但会让代码在之后以维护者身份运行：CI 工作流、git hooks、agent 配置、
安装 / 构建 / 环境配置文件。配了 `AUTOPILOT_HUMAN_PATHS` 之后，托管 PR 只要碰到清单里的文件就不合并，
翻 `pending/human` 交人，说明里列出命中的文件。**留空或不写 = 和以前完全一样**（只拦 `.github/`，走的是
原来那段代码：GitHub 调用、state、评论都不变）。不配的项目没有任何变化，也不会为它开提示 issue。

开启：在项目配置里加一行，下一轮轮询生效：

<!-- autopilot-human-paths:examples:begin -->
```bash
AUTOPILOT_HUMAN_PATHS="default"
AUTOPILOT_HUMAN_PATHS="default /systemd/ /launchd/ /setup.sh"
AUTOPILOT_HUMAN_PATHS="default /scripts/ /prompts/ /systemd/ /launchd/ /setup.sh"
```
<!-- autopilot-human-paths:examples:end -->

- `default` 展开成内置清单：`/.github/` `.husky/` `.githooks/` `/.pre-commit-config.yaml` `/lefthook.yml`
  `.claude/` `.codex/` `.agents/` `.mcp.json` `.devcontainer/` `.vscode/` `package.json` `Makefile` `.envrc`。
  可以和别的条目混写（上面第二、三行）；不含 `default` 就只用写出来的条目。`/.github/` 始终在清单里。
- **条目怎么读**（空格或逗号分隔，和 `.gitignore` 的常用部分一致）：开头 `/` = 只认仓库根目录（`/setup.sh`
  不命中 `tools/setup.sh`）；开头没有 `/` = 任何深度（`package.json` 命中 `client/package.json`）；末尾 `/` =
  目录及其下所有文件；`*` 只在一段路径内通配。改名的文件新旧路径都拿来匹配。
- **读不懂的条目绝不跳过**：开头没有 `/` 却在中间含 `/`（`a/b.txt`）、含 `.` / `..` 段、有空段、`**`。这时本项目
  每一次托管合并都交人，说明里点名这个条目，直到配置改好。
- **文件列表必须读全**：GitHub 在 PR 上自报的改动文件数（`changed_files`）要和读到的条数相等。缺页（这个接口
  一个 PR 最多给 3000 个文件）、缺自报数、响应形状不对、请求失败都算「读不到」：本轮不合并、什么都不写，
  连续 `AUTOPILOT_UNKNOWN_MAX` 轮后交人。「读不到」绝不当成「没命中」。
- **交人前判两次**：命中（或条目读不懂）之后，整个合并许可用现读的数据原样再判一遍；结论、命中的文件、PR 的
  最新提交 / 目标分支 / 分支名 / 绑定的 issue 都没变才交人，否则本轮什么都不写。交人本身和托管其他交人一样，
  是「先发说明、再翻标签」。⚠️ 维护者恰好在这两次写入之间做的操作 daemon 看不到：PR 可能多挂一次
  `pending/human`、少一个 `pending/merge`。它不会导致合并。
- **只看路径，不看内容**：清单里的文件只要被改就算（`package.json` 里只升级依赖版本也算）。锁文件和
  `AGENTS.md` / `CLAUDE.md` 不在内置清单里，项目需要可以自己加。
- **关闭**：删掉这一行（或写成 `""`）。从下一轮起恢复原来的规则；已经交给人的 PR 仍在人手上。

### 只在一台机器上跑这个仓库的轮询

开托管前，确认**只有一台机器**在跑这个仓库的轮询。另一台只要还在跑，**不管它开没开托管**都可能领走托管条目的
复审和派工（普通派工不看托管开关，也不看活是哪台派的；只有合并那一步看归属）：它派的复审不带托管规则，
设计通过会交人、代码通过不会进自动合并，闭环就断了；它若也开着托管、又没开 `SELFHEAL_ONLY_OWN_WORKERS`，还会把
别家复审过的 PR 送回重审。

在**每台别的机器**上跑下面这段（`REPO=<仓库> bash host-check.sh`）。它按 daemon 自己的读法载入安装登记和项目配置
（干净环境、子进程、限时 10 秒、输出丢弃），读出 daemon 实际会用的仓库名和会话前缀——引号写法、重复赋值、变量拼写都
和 daemon 一致；确定是这个仓库后再看定时任务停没停、开机会不会自启、还有没有会话，以及还有没有工作目录在
这个项目 worktree 底下的进程（会话没了、进程还活着的 worker 也算在跑）。任何一样读不到都判 `UNKNOWN`。

| 最后一行 | 怎么做 |
|---|---|
| `HOST_VERDICT=STOPPED` | 那台不跑这个仓库，可以继续 |
| `HOST_VERDICT=RUNNING` | **先**停调度、**再**等会话跑完（不留「看着空闲、停之前又派出去」的空档）：Linux `systemctl --user disable --now cavil-loop-poll@<实例名>.timer`（改名前装的是 `coding-agent-poll@<实例名>.timer`）；macOS `launchctl bootout gui/$UID/dev.luosky.cavil-loop.<实例名>`。等它的会话自己结束——**不要杀**：别的机器不接手它派的活，杀了就卡在 `doing/agent`。重跑直到 `STOPPED` |
| `HOST_VERDICT=UNKNOWN` | 查不清，**不要开托管** |

它只认安装脚本装出来的轮询；用别的方式（自己写的定时任务等）跑过这个仓库的机器，同样按「查不清」处理。

<!-- autopilot-ops:host-check -->
```bash
# autopilot host check (GitHub#124). Run on every OTHER machine before turning autopilot on:
#   REPO=<owner/repo> bash host-check.sh
# Finds every poller instance installed on this machine for REPO and judges each one
# STOPPED / RUNNING / UNKNOWN. Only a last line of HOST_VERDICT=STOPPED means "this machine
# does not poll REPO". Anything it cannot read counts as UNKNOWN, never as "not installed".
REPO=${REPO:?set REPO=<owner/repo>}
verdict=STOPPED
bad() { echo "$1 $2"; case "$1" in UNKNOWN) verdict=UNKNOWN;; RUNNING) [ "$verdict" = UNKNOWN ] || verdict=RUNNING;; esac; }
found=0
for d in "$HOME/.config/cavil-loop" "$HOME/.config/coding-agent-work-loop"; do
  [ -e "$d" ] || continue
  [ -d "$d" ] && [ -r "$d" ] && [ -x "$d" ] || bad UNKNOWN "cannot read registry dir $d"
done
# Read an instance's repo and session prefix the way its daemon does: load the registry
# env file, then source the project config. Clean env, subprocess, 10 s limit, output dropped.
if command -v timeout >/dev/null 2>&1; then lim() { timeout 10 "$@"; }
elif command -v gtimeout >/dev/null 2>&1; then lim() { gtimeout 10 "$@"; }
else lim() { perl -e 'alarm 10; exec @ARGV or exit 127' "$@"; }   # macOS has perl, not timeout
fi
load_instance() {   # <registry file>  -> prints "repo\nprefix\nworktree base"
  lim env -i HOME="$HOME" PATH="$PATH" bash -c '
    set -a; . "$1" >/dev/null 2>&1 || exit 3; set +a
    [ -n "${CODING_AGENT_CONFIG:-}" ] && [ -r "$CODING_AGENT_CONFIG" ] || exit 4
    . "$CODING_AGENT_CONFIG" >/dev/null 2>&1 || exit 5
    printf "%s\n%s\n%s\n" "${REPO:-}" "${TMUX_PREFIX:-}" "${WORKTREE_BASE:-}"
  ' _ "$1" </dev/null 2>/dev/null
}
# Which of my processes work under $1 (a worktree base)? Prints "W <pid>" for each, "S <pid> <name>"
# for each one whose working directory cannot be read (setuid / setgid helpers such as sshd or
# gpg-agent) and none of whose parents works there either; fails if a process cannot be judged.
scan_procs() {
  local d p c pp n hit bad=0
  for d in /proc/[0-9]*; do
    [ -O "$d" ] || continue
    p=${d#/proc/}
    if c=$(readlink "$d/cwd" 2>/dev/null); then
      case "$c/" in "$1"/*) echo "W $p";; esac; continue
    fi
    [ -e "$d" ] || continue                                       # exited meanwhile
    hit=0; n=0; pp=$p
    while [ $n -lt 64 ]; do
      pp=$(sed 's/.*) [A-Za-z] //; s/ .*//' "/proc/$pp/stat" 2>/dev/null) || { [ -e "$d" ] && bad=1; break; }
      [ "$pp" -gt 1 ] 2>/dev/null || break
      c=$(readlink "/proc/$pp/cwd" 2>/dev/null) && case "$c/" in "$1"/*) hit=1; break;; esac
      n=$((n+1))
    done
    if [ $hit = 1 ]; then echo "W $p"; elif [ -e "$d" ]; then echo "S $p $(cat "$d/comm" 2>/dev/null)"; fi
  done
  return $bad
}
want=$(printf '%s' "$REPO" | tr 'A-Z' 'a-z')
for f in "$HOME"/.config/cavil-loop/*.conf "$HOME"/.config/coding-agent-work-loop/*.conf; do
  [ -e "$f" ] || continue
  key=$(basename "$f" .conf)
  if ! got=$(load_instance "$f"); then bad UNKNOWN "instance $key: loading its config failed (unreadable, syntax error or timeout)"; continue; fi
  repo=$(printf '%s\n' "$got" | sed -n 1p); prefix=$(printf '%s\n' "$got" | sed -n 2p); wt=$(printf '%s\n' "$got" | sed -n 3p); wt=${wt%/}
  [ -n "$repo" ] || { bad UNKNOWN "instance $key: no REPO after loading its config"; continue; }
  [ "$(printf '%s' "$repo" | tr 'A-Z' 'a-z')" = "$want" ] || continue   # definitely another repo
  found=$((found+1))
  [ -n "$prefix" ] || { bad UNKNOWN "instance $key: no TMUX_PREFIX after loading its config"; continue; }
  [ -n "$wt" ] || { bad UNKNOWN "instance $key: no WORKTREE_BASE after loading its config"; continue; }
  # 1) scheduler: running or enabled at boot = RUNNING; unreadable or unknown words = UNKNOWN
  if command -v systemctl >/dev/null 2>&1; then
    for u in "cavil-loop-poll@$key.timer" "cavil-loop-poll@$key.service" "coding-agent-poll@$key.timer" "coding-agent-poll@$key.service"; do
      if ! out=$(systemctl --user show -p LoadState,ActiveState,UnitFileState "$u" 2>&1); then bad UNKNOWN "instance $key: cannot query $u ($out)"; continue; fi
      ld=$(printf '%s\n' "$out" | sed -n 's/^LoadState=//p'); ac=$(printf '%s\n' "$out" | sed -n 's/^ActiveState=//p'); uf=$(printf '%s\n' "$out" | sed -n 's/^UnitFileState=//p')
      case "$ld" in not-found) continue;; loaded|masked) ;; *) bad UNKNOWN "instance $key: $u LoadState=$ld"; continue;; esac
      case "$ac" in inactive|failed) ;; active|activating|deactivating|reloading) bad RUNNING "instance $key: $u is running ($ac)";; *) bad UNKNOWN "instance $key: $u ActiveState=$ac";; esac
      case "$u" in *.timer)
        case "$uf" in disabled|masked) ;; enabled|enabled-runtime|linked|linked-runtime|static|indirect|generated|alias) bad RUNNING "instance $key: $u still starts at boot ($uf)";; *) bad UNKNOWN "instance $key: $u UnitFileState=$uf";; esac;;
      esac
    done
  elif command -v launchctl >/dev/null 2>&1; then
    for lb in "dev.luosky.cavil-loop.$key" "dev.luosky.coding-agent-work-loop.$key"; do
      out=$(launchctl print "gui/$(id -u)/$lb" 2>&1); rc=$?
      if [ $rc -eq 0 ]; then bad RUNNING "instance $key: launchd still has $lb loaded"
      elif printf '%s' "$out" | grep -qi 'could not find service'; then :
      else bad UNKNOWN "instance $key: cannot query $lb ($out)"; fi
    done
  else
    bad UNKNOWN "instance $key: neither systemctl nor launchctl found"
  fi
  # 2) sessions still running for this instance
  out=$(tmux ls -F '#{session_name}' 2>&1); rc=$?
  if [ $rc -eq 0 ]; then
    s=$(printf '%s\n' "$out" | awk -v p="$prefix-" 'index($0,p)==1' | tr '\n' ' ')
    [ -z "$s" ] || bad RUNNING "instance $key: sessions still running: $s"
  elif printf '%s' "$out" | grep -Eq 'no server running|error connecting to .*No such file'; then :
  else bad UNKNOWN "instance $key: cannot list tmux sessions ($out)"; fi
  # 3) worker processes left behind: a killed session does not end a process that ignores SIGHUP,
  #    so also look for any of my processes whose working directory is under WORKTREE_BASE
  if [ -d /proc/self ]; then
    if out=$(scan_procs "$wt"); then
      left=$(printf '%s\n' "$out" | awk '$1=="W"{printf " %s", $2}'); unk=""
    else left=""; unk=" (some process could not be judged)"; fi
  elif out=$(lsof -a -d cwd -u "$(id -u)" -Fpn 2>/dev/null); then   # macOS: no /proc
    left=$(printf '%s\n' "$out" | awk -v w="$wt/" '/^p/{p=substr($0,2)} /^n/{if (index(substr($0,2)"/",w)==1) printf " %s", p}'); unk=""
  else
    left=""; unk="(cannot list processes)"
  fi
  [ -z "$unk" ] || bad UNKNOWN "instance $key: cannot read the working directory of:$unk"
  [ -z "$left" ] || bad RUNNING "instance $key: processes still working under $wt (PIDs:$left)"
  echo "instance $key (session prefix $prefix) checked"
done
echo "instances=$found"
echo "HOST_VERDICT=$verdict"
```

### 怎么整体关闭托管

在配置里把 `LABEL_AUTOPILOT` 留空（`LABEL_AUTOPILOT=""`）或删掉那一行就行，不用停定时任务、不用跑别的。
下一轮起 daemon 自己收尾：

- 不再自动合并任何东西，新派出去的活也不再带托管规则；
- 本机托管过、还挂着 `LABEL_PENDING_MERGE` 等合并的 PR，翻成 `pending/human` 并在 PR 上留言说明。关掉之前就派出去、
  之后才跑完的复审若又翻出等合并，下一轮照样收；
- 排队中、正在跑的活不清空，照普通流程走完、交人；已完成的合并不撤回。

只认本机托管过的 PR（`state.json` 的 `autopilot.prs` 有记录）：别的项目恰好也有同名标签不受影响，从没开过托管的项目
一个 GitHub 调用都不多。写之前现读那个 PR（仍开着、没合并才动），读不到就下一轮再来。交接的最终状态是：有
`pending/human`、没有等合并标签、PR 上有一条交人说明。动 GitHub 之前先在 `state.json` 记下「正在交接」，
然后让标签收敛到目标、回读确认，发说明前先看 PR 上是不是已经有了（只发一条），全部确认后才清记号——中间任何
一步失败或进程被杀，下一轮靠这个记号找回这个 PR 接着做。

issue 上残留的托管标签在关着时不起作用，但**以后再打开托管，留着它的 issue 会立刻重新进入托管**，不想这样就摘掉。

## 等前置：`pending/blocked`（GitHub#157）

配了 `LABEL_PENDING_BLOCKED`（示例配置写的是 `pending/blocked`）后，worker 的活卡在**别的 issue / PR** 上——本仓库的，或互通名单里别的仓库的（GitHub#233 / #243）
——而不是卡在要人拍板时，登记前置、挂这个标签，不再翻 `pending/human`。daemon 每轮看挂着它的条目：

| 前置的情况 | daemon 做什么 |
|---|---|
| 全部完成（issue 以「已完成」关闭、PR 已合并） | 留一条说明，摘标签，加回标记里写的触发标签（默认 `pending/agent`），下一轮派工 |
| 有一个以别的方式收场（关成不做 / 重复 / 没写原因、PR 没合就关、读到 404） | 评论写明是哪个，翻 `pending/human` |
| 互通名单里别的仓库的前置读不到：404 / 410（不存在、已删除，或私有仓库轮询令牌无权读——GitHub 对后者也回 404），或不是限流的 403 | 评论写明是哪个、怎么给令牌加读权限，翻 `pending/human` |
| 找不到前置，或前置在互通名单（`TRUSTED_REPOS`）外的别的仓库 | 评论说明（含怎么把仓库加进名单），翻 `pending/human` |
| 还有没完成的 | 什么都不做 |
| 读不到 GitHub（报错、缺字段；别的仓库还包括限流、网络失败、5xx） | 什么都不做，下一轮再看——绝不当成「已完成」 |

**前置从哪来**（两处取并集）：issue 侧栏 Relationships 里的「Blocked by」（实测：GitHub 只接受 issue 当前置，
设 PR 报 422「Target issue may only be an issue」），以及最近一次摘掉这个标签之后、由 loop 写入账号或维护者
（`OWNER` / `MEMBER` / `COLLABORATOR`）发的最新一条隐藏标记 `<!-- agent-blocked-by: #12 OWNER/REPO#34 resume=pending/agent -->`。
`#12` 是本仓库，`OWNER/REPO#34` 是别的仓库，见下文（写成本仓库自己的全名、不论大小写，等同 `#12`）。
「之后」是严格晚于：GitHub 的时间只到秒，和摘标签同一秒的登记分不出先后，按上一轮的算、不认。
「等 #12」这种普通文字不认。`resume=` 必须是本项目配置的触发标签之一，否则用默认那个。

**别的仓库的前置**（GitHub#233）：配了互通名单 `TRUSTED_REPOS` 时，标记里可以写 `owner/repo#N`，「Blocked by」里那个仓库的
条目也认；daemon 读那个仓库里的状态，完成口径和本仓库一样。裸 `#N` 永远指本仓库，本仓库同号的条目不会触发它。名单外的
仓库交人，评论写明怎么把它加进名单——名单为空时所有 `owner/repo#N` 都走这条（GitHub#243 之前，名单外的 `owner/repo#N`
会被误读成本仓库的 `#N`）。别的仓库只用轮询身份读、daemon 从不往那边写；私有仓库要轮询令牌有读权限，否则它回 404，
条目交人、评论写明是哪个前置、令牌缺什么权限。⚠️ 托管合并后 issue 留给人关，所以等一个托管 issue 实际等的是**人验收
关闭它**；想在代码合并时就接着做，前置写那个 PR。

**交人之后怎么恢复等待**：daemon 的评论里写了步骤——改前置（「Blocked by」里去掉失败的那个、加上新的，等 PR 就发一条新登记），
**摘掉 `pending/human`**，重新挂 `pending/blocked`。`pending/human` 还在时 daemon 按叫停处理，永远不会自动继续。

**叫停**：加 `pending/human`（或任何流程标签——`doing/agent`、`pending/PR`、`pending/review`、触发标签……），daemon 就不碰它。
手动打触发标签照常派工，派工时摘掉 `pending/blocked`。greedy 兜底、self-heal、托管的「只挂托管标签就派」都跳过它。

**写之前**全部重读、再判一次；有任何不同（新前置、标签摘了又挂、加了 `pending/human`、前置被重开）本轮就不写。
进度记在 `state.json` 的 `blocked_resume`（只在功能开启时写），翻标签失败后重试不会重复评论；连续失败
`BLOCKED_MAX_TRIES` 次就放弃、记日志，条目留在 `pending/blocked` 上等人处理。

**时间**：有条目在等时，轮询间隔最长 `BLOCKED_RECHECK_SECS`（300 秒），前置完成后通常 7 分钟内接上。**第一次发现**
新挂上的条目仍按空闲退避：项目安静了一周时，手动挂上的标签最长约 30 分钟才被看到（worker 自己挂的，项目刚活跃过，
1 分钟内就看到）。`rm poll-pace.json` 立刻回到全速。「已合并」不等于「本机已部署」：前置是 loop 自身的改动时，
被叫回来的 worker 先核对本机部署版本再用。不支持：github.com 以外的前置、环形依赖检测（互相等的两条都一直等）。

## 外部需求机器人（可选，**默认关闭**）

另一个 AI 助手（有自己的 GitHub 账号）直接给项目提需求时，agent 提问 / 汇报不翻 `pending/human`，
而是跑叫醒脚本：挂 `LABEL_PENDING_REQUESTER_BOT`，确认挂上后调一次机器人的 webhook（issue、PR 一样；
不再指派、不再请求 review）。PR 合并或关闭未合并时，daemon 在机器人提的 issue 上留一条结果评论、
加等待标签、调 webhook。
五个配置项（`LABEL_PENDING_REQUESTER_BOT` / `REQUESTER_BOT_ACCOUNT` / `REQUESTER_BOT_ALLOWED_ACTORS` /
`REQUESTER_BOT_ORIGIN_MARKER` / `REQUESTER_BOT_REPORT_FIRST`）全部留空 = 关闭，行为逐字节不变。
webhook 另有三项（`REQUESTER_BOT_WEBHOOK_URL` / `_KEY_HEADER` / `_KEY`），地址留空 = 不发；配置文件必须是 600。
`REQUESTER_BOT_WAKE_ANY_ITEM="true"`（默认 false，GitHub#133）让不是机器人提的条目也能叫醒它，见
[requester-bot.zh.md](requester-bot.zh.md#维护者自己的条目可选)；合并 / 关闭通知照旧只发给机器人提的需求。
早期的名字（`LABEL_PENDING_RELAY`、`RELAY_*`）照样认；同一项新名字有值时用新名字。

运维上要知道的：

- 挂着等待标签的条目，greedy 兜底和 self-heal 都不碰；有人打了触发标签就照原流程派，派工时摘掉等待标签
- 没有等待超时。机器人一直没回音，`poll.log` 里不会有任何动静，要人自己看看板上挂着等待标签的条目
- 叫醒脚本走长期入口 `~/.agents/releases/cavil-loop/entrypoints/notify-requester-bot.sh`（发版切换时路径不失效；早期入口 `notify-relay.sh` 转发到它），
  每次叫醒在 `poll.log` 留一行 `notify-requester-bot #<编号>: …`；配了 webhook 时紧跟一行结果（`已通知 webhook（HTTP 200）` / `webhook 通知失败（…）` / `… 跳过`），不含地址和密钥
- 合并 / 关闭通知：没发成的记在 `state.json` 的 `requester_bot_done_queue`；发成一条 `poll.log` 有一行 `✅ 已把 PR #N 的结果…`，连续 30 轮失败放弃时有一行 ⚠️。它跑在合并后清理那一段里，`AUTO_CLEANUP_ON_MERGE=false` 时也一并不发
- 完整说明、退出码、证据规则和接入示例：[对接外部需求机器人](requester-bot.zh.md)

## 评论用量 footer

`COMMENT_FOOTER="on"` 时，交人评论末尾接一段由 `scripts/drivers/token-usage/comment-footer.sh`
整段生成的 footer：一行总览（它就是 `<details>` 的折叠标题）+ 最后一行给周报读的隐藏
`agent-metrics` 机器记录。

- **总览把总耗时按 AI / 测试 / 远端 CI / 其他的顺序拆开。**「其他」= 总 − AI − 测试 − 远端 CI，按显示出来的
  整秒相减，最小 0；测试和别的段有重叠（AI 在想、或在等远端 CI 时测试在后台跑）时记 0，细节里说明。
- **测试那段只在配了 `COMMENT_FOOTER_EXTRA_CMD` 且有话可说时出现**：`测试 4m 51s`（大于 0 秒），
  或 `测试未知`（命令回答 `test_secs=unknown`——跑过但说不出耗时，例如只有后台 / 未完成的运行；
  或命令失败、超时、第一行不对，这几种原因写在细节里）。命令回答 0 表示确认这轮没跑测试：总览
  不提测试，和没配命令的项目一样；机器记录照写 `test_secs=0`，周报仍分得清两者。拿不准有没有跑的
  命令要回答 `unknown`，不能回答 0。
- **skill 自带一个测试耗时命令**（GitHub#244）：`scripts/drivers/token-usage/test-time.sh`，和
  footer 脚本一样有长期入口，跑的永远是已合并、已部署的版本，worktree 里正在改的那份不会被执行。
  在本机配置里打开（带存在判断：合并到部署之间那几分钟入口还不在，footer 照样不报错）：
  ```bash
  COMMENT_FOOTER_EXTRA_CMD='f="$HOME/.agents/releases/cavil-loop/entrypoints/drivers/token-usage/test-time.sh"; if [ -e "$f" ]; then bash "$f"; else printf "test_secs=unknown\n- 测试统计命令尚未部署\n"; fi'
  ```
  检查：下一条交人评论的总览里出现 `测试 …`（或 `测试未知`，细节里写原因）。退回：把这一行清空。两栏：
  - **整套测试**——`tests/run.sh` 每次运行生成一个编号，在自己的输出里印 `cavil-test-run id=<编号>`
    （记账没写进去时后面加 ` log=failed`），并往 `${XDG_STATE_HOME:-~/.local/state}/cavil-loop/test-runs.jsonl`
    （`CAVIL_TEST_RUNS_LOG` 可改）追加带同一编号的开始行、结束行。会话里的命令和记录**只按这条命令
    自己输出里的编号**关联（前台看工具结果；Claude 放后台的命令看工具结果里写明的输出文件；codex
    看这条命令在它那个 `exec` 单元输出里的那一项，加上之后同一 `session_id` 的 `write_stdin` 轮询返回的输出——
    别的命令的输出一概不算，例如 `cat` 一份存下的日志），不按开始时刻接近——人在旁边手跑的、同一 agent 并发的另一次，都是另一次。
    两行都在、或只有结束行（结束行自带开始时刻）→ 实测计时；只有开始行 →「未记到结束」；印了编号
    但没有记录 →「没有记账」；读不到编号 →「无法关联」；记录里有、没有任何会话命令印出过 → 单独
    算一次、实测计时。嵌套运行（测试里再跑 `tests/run.sh`）不记账。
  - **单跑测试**——从 agent 自己的会话里认出的测试命令（`bash tests/<名字>.test.sh`、
    `bash test/tauri/mutations.sh`、`npm test` / `npm run test…`、`npx vitest`、`npx playwright test`、
    `cargo test`；引号和 here-doc 里的文字不算），按工具调用到工具结果计时，是整条命令的估算。
  - 回答：任何一栏读不了 → `unknown`；有实测部分 → 各段时间的并集（并行的同一秒只算一次；另有未计时的
    写进细节，所以是下限）；看到了运行、一秒都没计上 → `unknown`；两栏都读到、一次都没跑 → 0。
  - codex：`exec` 单元只有在通篇都是 `text(await tools.X({…}));` 语句、且每条语句恰好一项输出时，
    才把输出逐项配给命令；别的单元命令照样计（整套记「无法关联」、单跑不计时），输出不配给任何一条。
    带 JSON 参数的标准函数调用（`exec_command`、`shell`、`local_shell_call`）也认。命令文本解析不了
   （例如模板字符串）记「解析不了」，回答变 `unknown`，不会是 0。
  - 限制：包一层（`bash -c '…'`、自己的脚本）认不出来；放后台（Claude）或单元返回时还在跑（codex）的
    单跑只计次数；整套测试的输出写进了文件（`> log`）或别的原因读不到时，同一次可能算两遍——一次
    「无法关联」、一次按记录——次数多 1，秒数不多。
- **AI 时间是估算**（总览写「AI 约 …」）。每次模型请求从发出请求算到最后一段回复写进会话记录，
  几次请求同时覆盖的那一秒只算一次。偏差来源：含网络往返和排队等首字的时间；会话记录是写盘
  时刻，与真实收发差几毫秒到几秒；AI 在想的时候后台命令可能也在跑。这段说明不在每条评论里重复；
  算不出来时总览写「AI 时间未知」，细节里写原因。
- **远端 CI 是 agent 等 GitHub Actions 跑完的时间**（GitHub#293，总览写「远端 CI 约 …」），从 agent 自己的会话
  记录里认，不查 GitHub。不需要配置。
  - 认哪些命令（Claude 的 Bash、Monitor 调用；codex 的 `exec` 命令）：本身阻塞到运行结束的 `gh run watch …`、
    `gh pr checks … --watch`；或一个 `for` / `while` / `until` 循环，里面同时有 `sleep` 和远端 CI 状态查询
    （`gh run view` / `gh run list` / `gh pr checks`，或 `gh api` 访问 `…/actions/runs…`、`…/check-runs`、
    `…/check-suites`、`…/commits/<sha>/status`）。只认真正会执行的命令：按 shell 规则拆开，单引号里是文字，
    双引号和不带引号处的 `$( … )` / 反引号会执行；`echo gh run watch 1` 这种打印出来的文字、循环里 echo 的
    查询都不算。单次查询、`gh workflow run`、轮询 PR 评论 / 标签也不算。
  - 起止：开始 = 工具调用写进会话的时刻；结束 = 前台命令的工具结果、后台命令和 Monitor 的「后台任务结束」
    通知（Monitor 运行中的事件通知不算）、codex 命令自报的耗时或报出退出码那次轮询。
  - 合计 = 各条等待时段的并集，再扣掉与 AI 请求重合的部分（后台在等、agent 同时在干活的那段算 AI），所以
    不和 AI 重叠。细节逐条列出等的是哪个运行（只从认定为等待的那条 gh 命令里取，`gh run …` /
    `actions/runs/<编号>`，命令里用变量时找同一条命令里的赋值）或哪个 PR 的检查、起止和这一条自己的时长（不扣 AI，可以和 Actions 页面对），并写明几条
    重叠、扣了多少 AI 时间。
  - 没记到结束的（后台任务还没结束、通知缺失、codex 一直没报退出码）只计条数、不算进合计（细节里注明）；一条都没
    计上时总览写「远端 CI 未知」。上一轮派工里开始的等待不算。
  - 机器记录：`ci_wait_secs`（合计，毫秒精度）、`ci_waits`（条数）、`ci_wait_untimed`（没记到结束的条数）；
    没有等待时写 `ci_wait_secs=0.000 ci_waits=0 ci_wait_untimed=0`，一条都没计上时不写 `ci_wait_secs`。统计
    不出来（会话读不了、统计出错）时三个都不写，细节写「远端 CI 等待没统计到」和原因。周报目前不解析这三个
    字段。
  - 循环那一条要求查询和 `sleep` 在**同一个**循环里（外层循环里的也算）；`for` 头部的查询只执行一次，不算轮询。
  - 不算（拿不准时宁可留在「其他」，不把别的时间挪进「远端 CI」）：函数定义里的命令（定义不等于调用，调用也不去
    追）；整条放后台（`… &`）的命令；交给 `bash -c` / `sh -c` / `eval` / `xargs` / `ssh` / `sudo` 当字符串执行的、
    自己的脚本文件里的。
  - **数字是按命令推断的，可能偏多**（footer 细节标题写「按命令推断，可能偏多」；PR #302 维护者选定保留推断，
    不改用专用等待命令实测）。已知会多算的几种：一条命令里只要认出等待，整条命令的时长都算进远端 CI，等待之外
    的其他耗时操作一起算进去；等待写在没走的分支里（`if false; then gh run watch 1; fi; sleep 60`、
    `false && gh run watch 1; sleep 60`）时，后面那段时间也算进去；函数体里出现引号中的 `}`（`f() { echo '}';
    gh run watch 1; }`）会让函数体被当成已执行。多算多少取决于命令里掺了多少别的耗时操作，说不出上限。
  - 限制：上一条「不算」的写法里真在等的那段仍算「其他」；`&&` / `||` / `if` / `case` 分支里的等待按执行算（看不出
    分支走没走）；没记到结束的等待不算进合计；和本机测试的重叠扣不掉（测试只给总数），见上面「其他」记 0 的规则。

## Prompt 模板

一份 prompt = **base + 项目增量**。两个文件各自独立查找，都支持 `origin/<base>` 直读
（主 checkout stale 也拿得到最新版）：

| | 文件名 | 找不到时 |
|---|---|---|
| **base**（通用工作流） | `<name>.template.md` | 回落到 `<skill>/prompts/<name>.template.md` |
| **增量**（项目特有） | `<name>.extra.md` | 没有就只用 base |

两者都在项目的 `.agents/skills/cavil-loop/prompts/` 下（改名前建的项目用
`.agents/skills/coding-agent-work-loop/prompts/`，更老的 `.agents/skills/coding-agent-workflow/prompts/`
和 `.coding-agent/prompts/` 也仍兼容；同时存在时新名优先）。合成方式是**把增量追加在 base 之后**，中间插一句
「两者冲突时以这一段为准」——prompt 里后文天然覆盖前文，所以项目要推翻 base 的某条
约定，在自己文件里写清「本项目改成 X」就行，不用把整份抄过来改。

**优先写增量，别整份覆写。** 覆写的代价是**它从此拿不到 base 的任何更新，且没有任何
迹象**：实测 tutor 那三份覆写里，跟 base 相同的行只剩一半，base 后来加的规范（例如
「拍板问题要讲清上下文」）一条都没进去。只有当项目的工作流跟通用流程**结构上就不同**
（不同的阶段划分、不同的 label 语义）时才值得整份覆写。

```
project/.agents/skills/cavil-loop/prompts/
├── new-issue.extra.md      ← 推荐：只写本项目特有的（测试链、目录约定、验收口径…）
└── pr-comment.template.md  ← 仅在结构上就不同时才整份覆写
```

两个都放也行：项目的 `.template.md` 当 base，`.extra.md` 仍追加在后。
每次 dispatch 的日志会写明这轮是怎么拼的：
`prompt: base=new-issue.template.md + 增量=new-issue.extra.md（合成 214 行）`。

可用占位（`sed` 渲染）：

| 占位 | 含义 |
|------|------|
| `${ISSUE}` | issue 编号 |
| `${PR}` | PR 编号（仅 pr-comment） |
| `${REPO}` | 仓库 owner/repo |
| `${TITLE}` | issue 标题（仅 new-issue） |
| `${PARENT_ISSUE}` | 父 issue 编号（仅 `sub-issue.template.md`，见 [architecture.zh.md 闭环关系](architecture.zh.md#关于-pr↔issue-闭环关系-worker-在设计阶段就决定)） |
| `${WORKTREE}` | worktree 绝对路径 |
| `${BRANCH}` | branch 全名 |
| `${ISSUE_N}` | 从 branch 反推的 issue 编号（仅 pr-comment） |
| `${LABEL_PENDING_AGENT}` / `${LABEL_PENDING_HUMAN}` / `${LABEL_AGENT_DOING}` / `${LABEL_PENDING_PR}` | label 名 |
| `${LABEL_DESIGN_REVIEW_OR_HUMAN}` | **设计方案 / 修订方案写完翻到哪**：开了方案复审（`REVIEW_DESIGN_PROPOSALS=true` 且配了复审标签）时 = `pending/review`，否则 = `pending/human`。只用在方案出口；澄清答复、提问照旧写 `${LABEL_PENDING_HUMAN}` |
| `${DESIGN_REVIEW_NOTE}` | 开了方案复审时是一句「复审先审方案、打回是改方案」的说明，否则为空——关着时渲染结果和以前逐字一样 |
| `${LABEL_REVIEW_OR_HUMAN}` | **产出后该翻到哪**：启用 review 关卡时 = `pending/review`，未启用时自动退化成 `pending/human`。模板一律用它，别直接写 `${LABEL_PENDING_REVIEW}`——没配置时那个渲染成空串，活会丢掉 `doing/agent` 又拿不到任何 pending 标签，从看板上彻底消失 |
| `${PREVIEW_URL_HOST}` | 本机对外提供 PR 预览的主机名。**别在模板里硬写主机名**——同一份模板会在所有盯这个仓库的机器上跑，写死的主机会把审阅者指到一台根本没有这些文件的机器 |
| `${REVIEW_ASSET_BASE_URL}` | review 截图的公网 base URL（funnel 那个 path），取自 `WEEKLY_REPORT_ASSET_ROOT_URL`。同理：截图落在哪台机器上，URL 就得指哪台。工具自带的三份 worker 模板和复审模板也用它判断「本项目有没有配出图地址」：为空时，界面 / 样式选择题改用文字描述候选差异（GitHub#238） |
| `${LABEL_PENDING_AGENT_DEFAULT}` | 默认的 `pending/agent`。review 模板打回时必须用它——`${LABEL_PENDING_AGENT}` 是**触发**标签，在 review 关卡里拿它打回等于打回自己，死循环 |
| `${OUTPUT_LANGUAGE}` | ISO 639-1 代码，控制 worker 写回 GitHub 的语言（从 `cavil-loop.config` 读，默认 `en`） |
| `${COMMENT_FOOTER_CMD}` | 生成评论用量 footer 的完整命令（已带 agent、用量驱动、项目配置），模板只需再补 `--start "${TASK_START_TS}" --wt "${WORK_NUM}"`。输出整段 footer，原样接在评论末尾；项目测试耗时的接口见配置样例的 `COMMENT_FOOTER_EXTRA_CMD` |
| `${CONCURRENT_WORK}` | 其他进行中条目的清单，以及各自分支已改的文件（GitHub#340）。它在其余占位符**全部渲染完之后**才由 `concurrent_work_fill` 填入，而且只认独占一行的写法——清单是多行的，里面的标题是别人写的，不能过那一遍 `sed`。`ENABLE_CONCURRENT_WORK_HINT` 开着时，工具会把自带的一段（`prompts/concurrent-work.md`：清单 +「有重叠就写出来」的规则）追加到三份 worker 模板末尾，项目模板不用自己写。开关关着而项目模板里写了它 → 渲染成「没有开启」，不读任何东西。列表读不到时渲染成「未能读取」，绝不写成「没有」 |

## Cleanup hook（`CLEANUP_HOOK`）

`cleanup-issue.sh` 在「杀 worker session、删 worktree」**之前**调起项目级 hook，注入
`ISSUE` / `WORKTREE` / `BRANCH` / `REPO` / `PROJECT_ROOT` 五个 env。典型用途：回收预览
端口、解隧道路由、推指标。hook 非零退出不会中断 cleanup（只记一条警告）。

### 按 worktree 兜底，别按名字和端口号猜

写 hook 最容易犯的错，是假设 worker 只会开你约定的那一个 session、只会占你算得出的
那一个端口。实测反例（tutor，2026-07-29）：约定是 `<prefix>-issue<N>-server` +
端口 `4000+N`，而 worker 跑 e2e 时按需开了

```
<prefix>-issue695-e2e-be      PORT=5695
<prefix>-issue695-e2e-noauth  PORT=5696     ← 注意是 5000+696，连号段公式都对不上
```

两个后端鉴权配置不同，本来就没法复用同一个预览 server。结果 cleanup 一个都没清掉：
worktree 删了、进程还活着，变成 cwd 显示 `(deleted)` 的孤儿，最久的挂了 2 天 17 小时，
端口和内存一直被占着。

**名字约定总会有人不遵守，cwd 不会骗人。** 建议的兜底顺序：

1. 杀所有 `<prefix>-issue<N>-*` 前缀的辅助 session（末尾那个 `-` 不能省，否则
   `N=69` 会误伤 `<prefix>-issue695-server`），而不是只杀写死的那一个名字
2. 杀所有 cwd 落在 `$WORKTREE` 下的残留进程（`readlink /proc/<pid>/cwd`；worktree 已删时
   路径会带 ` (deleted)` 后缀，要一并认）
3. 端口从上一步那些进程**实际监听**的端口收集，而不是用公式算

按 cwd 批量杀进程有事故风险，三道闸建议照抄：

- **校验 `$WORKTREE` 形状**（例如必须匹配 `.../worktree/<project>/issue-<N>` 且编号与
  `$ISSUE` 一致），不符就只做按名字的清理。防 `$WORKTREE` 为空或为 `/` 时扫掉整机进程
- **排除自己 + 整条祖先链**，否则 hook 会把自己和 `cleanup-issue.sh` 一起杀了
- **别碰裸 session `<prefix>-issue<N>`**，那个归 `cleanup-issue.sh`，保持分工

参考实现见 tutor 项目的 `.agents/skills/coding-agent-work-loop/cleanup-hook.sh`（它是改名前建的项目，目录仍是旧名）。

## 按需 preview（socket 激活）

每个待验收的 issue 都要给审阅者一条可点的预览 URL。最直接的做法是 worker 起一个常驻
`tmux` session 跑 web server——但那意味着**每个 open 的 issue 都常驻一份内存**。实测某台
机器：10 个 `pending/PR` 的 issue，10 个 `node server/index.mjs`，共 ~930 MiB，其中
`#745` 空转了 11 天。这些进程不是泄漏（issue 确实还开着，清理链路也正常），它们只是
**在没人看的时候也活着**。

配了 `PREVIEW_EXEC` 就切成 systemd socket 激活，把「URL 常在」和「进程常驻」拆开：

```
tailscale serve :4791（或直接访问 127.0.0.1:4791）
        │
cavil-loop-preview@4791.socket        常驻监听，几乎不占内存
        │ 首次连接触发
cavil-loop-preview@4791.service       systemd-socket-proxyd，--exit-idle-time 到点自杀
        │ Requires
cavil-loop-preview-app@4791.service   你的 server，StopWhenUnneeded 跟着一起停
```

实测：冷启动 ~0.4s（外加 app 自身启动时间），热访问 0.01s，闲置到点后内存全部归还，
再访问自动拉回来。**不重新 build**——worktree 里的构建产物一直在。

```bash
bash scripts/preview-serve.sh 791          # 注册 + 起监听，打印 URL
bash scripts/preview-serve.sh 791 --warm   # 顺便立刻预热（验收前想省那 1 秒）
bash scripts/preview-serve.sh --list       # 本项目所有 preview 及其死活
bash scripts/preview-unserve.sh --issue 791  # 注销（cleanup hook 里调）
```

**只有真起来了才给地址。** 任何一步没成功（监听起不来、`--warm` 时 app 起不来、或预热请求经公开
端口拿不到 2xx/3xx），`preview-serve.sh` 非零退出、**不打印 URL**，并把那个单元最后 20 行日志打到
stderr。不带 `--warm` 时只确认监听已经起来——app 要等第一次访问才拉起，所以输出里会写明「尚未实际
访问验证」；交给人看之前想确认页面能打开，就带 `--warm`。预热请求的超时是 `PREVIEW_PROBE_TIMEOUT`
（默认 30 秒）。

### 端口归属：取模之后的同端口

配了 `PREVIEW_PORT_MODULO`（例：1000）时端口是 `BASE + issue % MODULO`，同余 issue 会算出
同一个端口（#40 与 #1040 都是 4040）。所以每个端口都有**主人**：`<port>.conf` 里的
「项目 + 完整 issue 号 + worktree」。规则只有一句——**谁都只动登记在自己名下的端口；
查不到登记就什么都不动**：

- `preview-serve.sh` 发现端口登记在别人名下（同余 issue 或别的项目）→ exit 2 并报出占用方，一个字节都不写
- `preview-unserve.sh --issue N` / `--port P --expect-issue N` 只注销主人三项全等的登记；
  没登记 → exit 0 不动；主人不符 → exit 3 不动。旧的裸端口调用 `preview-unserve.sh <port>`
  只作过渡兼容：预期主人取 cleanup hook 拿到的 `ISSUE` / `WORKTREE` env，缺了就拒绝
- 读登记 → 比对 → 写 conf / systemd / tailscale 全在同一把端口锁（`.port-<port>.lock`）里，
  注册与注销共用，并发注册恰好一个成功
- 没登记的遗留 tailscale 路由**不自动拆**：端口可能已被别的服务复用，按公式拆就是误伤。
  人工处理前先核对路由当前指向谁

守卫：`tests/preview-port-ownership.test.sh`。

### 三个必须知道的坑

**① app 拿到的是后端端口，不是公开端口。** 公开端口被 `.socket` 占着，app 再 bind 会
`EADDRINUSE`。`preview-run.sh` 注入的 `$PORT` = 公开端口 + `PREVIEW_BACKEND_OFFSET`。
所以 `PREVIEW_EXEC` 指向的进程**必须从 `$PORT` / `$HOST` 读监听参数**，端口写死的 app
接不进来。

**② conf 文件的值一律带双引号。** `~/.config/cavil-loop/preview/<port>.conf`
有两个读者：systemd 的 `EnvironmentFile=`（整行右侧都算 value，不加引号也对）和
`preview-run.sh` 的 bash `source`（不加引号，`PREVIEW_EXEC=node server/index.mjs` 会被
解析成「带临时环境变量执行 `server/index.mjs`」，exit 127）。`preview-serve.sh` 已经
处理好了，手改 conf 的时候别踩。

**③ 就绪门不能省。** `Type=exec` 只保证 execve 成功，不保证已经 `bind`。少了
`cavil-loop-preview-app@.service` 里那行 `ExecStartPost=preview-wait.sh`，proxy 会在
node 还没听上时就转发，**首次访问稳定 502**——而且 app 慢启动 300ms 就能踩到，本地手测
经常撞不上。

### app 起不来的时候

socket 会反复重触发，撞上 `TriggerLimitBurst` 后整个 socket 进 `failed` 且**不再接受
激活**——URL 静默变死，而 `systemctl start` 是 no-op，看状态看不出问题。诊断和恢复：

```bash
journalctl --user -u 'cavil-loop-preview-app@4791.service' -n 50
bash scripts/preview-serve.sh 791     # 内含 reset-failed，改完配置重跑就能恢复
```

### 跟 cleanup 的关系

`preview-serve.sh` 用的是 `systemctl start` 而不是 `enable`：preview 是随 issue 生灭的
临时物，不该在重启后自动复活（那时 worktree 多半已经被 `cleanup-issue.sh` 删了）。
issue close 时的注销由项目的 `CLEANUP_HOOK` 调 `preview-unserve.sh --issue "$ISSUE" --expect-worktree "$WORKTREE"` 完成
（**一定要带上 hook 拿到的实际 `WORKTREE`**：只传 `--issue` 时预期主人取配置推出来的路径，同号但不同路径的清理就能拆掉别人的登记；
`WORKTREE` 不可信时整个跳过注销，别退回默认路径）
——这一条要自己加进 hook，`cleanup-issue.sh` 不知道你有没有启用 preview。

## 文件结构

### Skill 目录（Linux 受管布局）

```
~/github/cavil-loop/        # 可选开发 checkout；部署器绝不修改
~/.agents/skills/cavil-loop -> ~/.agents/releases/cavil-loop/releases/<sha>/
~/.agents/releases/cavil-loop/
├── mirror.git/                         # 只做 fetch 的镜像
├── releases/<sha>/                     # 带 .inuse 租约的不可变文件树
├── entrypoints/                        # 不随 release 清理的持久启动器
├── .fetch.lock                         # 只串行化网络 fetch
├── .deploy.lock                        # 短暂的发布 / 选版 / 清理锁
├── .last-fetch                         # 共享 fetch 节流
└── deploy-state.json                   # 落后、成功与告警状态
~/.claude/skills/cavil-loop  -> ~/.agents/skills/cavil-loop
```

poll、token 用量 driver 和周报都从 `entrypoints/` 里的持久启动器进入。启动器不会随旧 release 被清理：它先取得共享部署锁、解析稳定软链并拿到目标 release 的 `.inuse` 租约，之后才打开版本内脚本。清理只有取得独占租约才删除旧 release；不会使用“超过 N 小时”或“保留最近 N 个”的猜测规则。可选共享覆盖放在 `~/.config/cavil-loop/deploy.conf`，字段见 `cavil-loop-deploy.conf.example`。

### Host project（接入后）

```
your-project/
├── .gitignore                          # +1 行：cavil-loop.config
├── cavil-loop.config                  # 配置（gitignored）
├── .agents/skills/cavil-loop/  # 可选：项目自定义 prompt + cleanup-hook
│   ├── prompts/
│   └── cleanup-hook.sh
└── ... your code ...
```

### 用户级状态文件

`<project-key>.conf` 是两个 OS 共享的环境变量单源真相——格式一样，只是不同调度器加载方式不一样。

```
~/.config/cavil-loop/
└── <project-key>.conf                  # KEY=VALUE env 文件；systemd 当 EnvironmentFile 读，launchd 用 `source` 内联加载

# 仅 Linux
~/.config/systemd/user/
├── cavil-loop-poll@.service          # symlink → skill 目录的模板
└── cavil-loop-poll@.timer            # symlink → skill 目录的模板

# 仅 macOS
~/Library/LaunchAgents/
└── dev.luosky.cavil-loop.<key>.plist   # 每个 project 生成一份（不是 symlink）
~/Library/Logs/cavil-loop/
└── <key>.out.log, <key>.err.log        # launchd 截获 daemon 的 stdout/stderr

~/.local/state/cavil-loop/<project>/
├── state.json                          # { "seen_comments": ..., "cleaned_prs": ... }
├── poll-pace.json                      # 空闲/故障退避状态；`rm` 掉 = 立刻回最快档
├── poll.log                            # 滚动日志
├── runlog/                             # 运行记录：每轮轮询一条 + 快照（GitHub#344）
├── poll.lock                           # flock
└── sessions/                           # 每个 worker tmux session 的 pane 日志
    └── <project>-issue<N>.log
```

## 按 OS 选调度器

`setup.sh` 用 `uname -s` 检测 OS，自动选对应调度器：

| OS | 调度器 | Unit / Plist | `setup.sh` 自动装？ |
|----|--------|--------------|---------------------|
| Linux | `systemd --user` timer | `~/.config/systemd/user/cavil-loop-poll@<key>.{service,timer}`（symlink 到 skill 模板）+ `cavil-loop-poll@<key>.timer.d/interval.conf`（按 `POLL_INTERVAL_SECS` 生成）| ✅ |
| macOS | `launchd` LaunchAgent | `~/Library/LaunchAgents/dev.luosky.cavil-loop.<key>.plist`（生成，非 symlink）| ✅ |
| 其他 | — | — | ❌ `exit 1`；见下方 [手动 cron 兜底](#手动-cron-兜底) |

两条路径都读同一份 `~/.config/cavil-loop/<key>.conf`。Linux 在持久 poll 入口前执行 `skill-deploy.sh`；网络 fetch 使用单独的非阻塞锁和超时，只有发布与清理才短暂持有部署锁，所以慢 fetch 不会挡住当前 release 的消费者，失败尝试也会进入共享节流。macOS 运行钉版本入口但不自动部署，plist 模板有改动要重跑 `setup.sh`。

tick 频率只是「最多多久打一次 GitHub」的上限：一整天没人碰的项目会在 `agent-poll.sh`
内部决定跳过大部分 tick（见[空闲与故障退避](architecture.zh.md#轮询节奏空闲退避与故障退避)）。
起一个进程只要几十毫秒，调用才是稀缺资源，所以 tick 本身保持便宜且频繁。

两个系统上驱动 timer 的都是 `POLL_INTERVAL_SECS`；Linux 端 `setup.sh` 把它写成本实例的
drop-in，而不是去改共享模板。手写的 `interval.conf` 永远不会被覆盖 —— `setup.sh` 会提示
一句然后放着不动。

### macOS 专属

- **Label**：`dev.luosky.cavil-loop.<key>`（必须和 plist 文件名一致）
- **加载方式**：`launchctl bootstrap gui/$UID <plist>`（modern 语法，macOS 10.10+）。`setup.sh` 会先 `bootout` 再 bootstrap，重跑幂等。
- **运行频率**：`StartInterval` 取自 `POLL_INTERVAL_SECS`（等价 systemd `OnUnitActiveSec`）。plist 是生成的不是 symlink，改了要重跑 `setup.sh`。
- **日志**：stdout/stderr → `~/Library/Logs/cavil-loop/<key>.{out,err}.log`。更深的 poll 日志仍在 `$STATE_DIR/poll.log`。
- **flock**：macOS 不自带，先 `brew install flock` 再跑 `setup.sh`。
- **登出 / 合盖**：user LaunchAgent 登录后常驻（即使锁屏也跑）；想"无登录、开机即跑"要装到 `/Library/LaunchDaemons/` —— `setup.sh` 故意不进这里（要 `sudo`，且和 Linux `--user` systemd 对称）。

## 用脚本安装、查状态、断开（GitHub#313）

下面四个入口给程序（桌面客户端，或人自己写的脚本）一个稳定的接口，调用方不用自己重写安装逻辑。都在 skill 目录里，对改名前的旧安装同样有效（新旧名字统一由 `scripts/_names.sh` 挑）。

| 脚本 | 做什么 | 会写东西吗 |
|---|---|---|
| `setup.sh --yes <host> [key]` | 和 `setup.sh` 一样，但最后不问 y/N，直接启用并启动后台任务。不带 `--yes` 时与从前逐字节一致 | 会（同 `setup.sh`） |
| `scripts/install-status.sh [--agent <名字>] [--project <目录>]` | 输出一个 JSON 对象，本机状态一次读全 | 不会 |
| `scripts/disconnect-project.sh <key>` | 停掉一个项目的后台任务、撤掉登记；保留项目配置和状态 | 会 |
| `scripts/launchd-refresh.sh <key>` | 只用于 macOS：模板变了之后换新一个项目的 launchd plist，先备份、失败就恢复 | 会 |

<!-- install-scripts-ops:begin -->
```bash
SKILL="$HOME/.agents/skills/cavil-loop"
git init -q "$HOME/github/myproject"
bash "$SKILL/setup.sh" --yes "$HOME/github/myproject"
bash "$SKILL/scripts/install-status.sh" | jq -r '.projects[] | "\(.key) \(.repo) \(.scheduler.state) deps=\(.deps.state)"'
bash "$SKILL/scripts/install-status.sh" --agent codex | jq -c '.agent_check | {agent, state, missing}'
bash "$SKILL/scripts/disconnect-project.sh" myproject
```
<!-- install-scripts-ops:end -->

上面几行依次是：不经 y/N 提问接上一个项目；列出每个已接项目的后台任务状态和依赖结论；接一个用 `codex` 的新项目前先查缺什么；再把它断开。`myproject` 是实例名（默认是目录名，即状态输出里的 `.projects[].key`）。

**状态输出**（`version: 1`）。顶层：`os`、`scheduler`（`systemd` / `launchd`）、`daemon`（`entry` 稳定 skill 入口、`target` 实际指向、`form` 安装形态——`managed` 受管 release / `checkout` 普通代码目录 / `directory` / `missing` / `dangling`、`version` release 的 sha 或代码目录的 `HEAD`）、`gh`（`installed`、`logged_in`）、`base_deps.missing`（每个项目都要的通用工具）、`bash`（`path` 轮询会用的 bash，和 `setup.sh` 同一个挑选函数；`major` 主版本；`ok` —— 4 及以上为 `true`，macOS 自带的 3.2 为 `false`，跑不了 daemon，要 `brew install bash`；读不出版本为 `null`）、`agent_check`（带 `--agent` 才有）、`project_check`（带 `--project <目录>` 才有：那个目录里已有的项目配置，按轮询一样的读法读——`config_state` 为 `none` / `ok` / `unreadable`，以及 `config`、`repo`、`worker_agent`；`setup.sh` 会沿用这份配置，所以接上后实际用的就是这两项）、`projects[]`。每个项目：`key`、`layout`（`new` / `legacy` = 改名前装的）、`env_file`、`host`、`config`、`config_state`（`ok` / `unreadable`）、`repo`、`state_dir`、`agents[]`、`deps`、`scheduler`、`last_poll`。

- `agents[]` 列出 worker agent、复审 agent（只在配了 `LABEL_PENDING_REVIEW` 时）和按标签选模型时用的 agent（`role: fable`，`required: false`——只有有人给条目打了那个标签才会起，所以没装 claude 的 codex 项目不会被报成缺依赖）。每项有 `bin`、`state`（`ok` / `missing` / `no_driver`）和 `missing`，用的是 `setup.sh` 同一个函数，两边结论不会不一致。`deps` 汇总必需的那几项：`ok` / `missing` / `unknown`（配置读不出或找不到 driver）。
- `scheduler.state` 是 `running` / `stopped` / `unknown`。只认已知状态词：读失败、空输出、不认识的词一律 `unknown`，绝不报 `stopped`；`raw` 是读到的原文。
- `last_poll` 取最近一次真读了 GitHub 的轮询（`poll-pace.json`），没有就取 `poll.log` 的修改时间；都没有为 `null`。
- 没有 `jq` 时拼不出完整状态：脚本只输出 `{version: 1, precheck: true, os, base_deps: {missing}}`（不靠 `jq` 查的通用工具），退出码 3；这时项目和后台任务状态一概读不到。

**断开**照[卸载某个 project](#卸载某个-project) 的步骤做：先读后台任务状态，读不到就什么都不动（退出 2）；停完读回确认（Linux 上还确认不再开机自启），确认不了就保留登记（退出 3）。退出 0 = 已断开，1 = 没有这个实例。最后一行固定是 `RESULT=<disconnected|not_found|unknown|failed>`。worker 的 tmux 会话不动。

**换新 launchd plist（macOS）。** plist 是生成的、不是软链，重跑 `setup.sh` 看到已存在就跳过。daemon 更新、模板变了之后，每个项目跑一次：

<!-- install-scripts-mac-ops:begin -->
```bash
SKILL="$HOME/.agents/skills/cavil-loop"
bash "$SKILL/scripts/launchd-refresh.sh" myproject
```
<!-- install-scripts-mac-ops:end -->

它用 `setup.sh` 同一个函数生成新 plist，`plutil -lint` 校验，和现有文件逐字比对——一样就 `RESULT=unchanged`。不一样：读任务状态（读不到就停，什么都不动）；已加载的先拿该项目的轮询锁（等当前这一轮结束，最多 `CAVIL_REFRESH_LOCK_WAIT` 秒，默认 300），bootout 并确认已卸载；把旧文件备份到 `$STATE_DIR/launchd-backup/`；原子换上新文件；原来已加载的就重新加载，并读回确认加载的是这个文件。加载失败就用备份恢复原文件和原状态。最后一行 `RESULT=` 是 `replaced` / `unchanged`（退出 0）、`unknown` / `lint_failed` / `lock_timeout`（退出 2，什么都没动）、`not_found` / `not_macos`（退出 1）、`failed`（退出 3，原文件和原状态已恢复——两者都读回确认过才报它）、`needs_human`（退出 4：恢复失败或确认不了——输出里有报错原文、原文件位置和手动恢复的命令，做过备份的话备份保留）。Linux 上单元文件是指向模板的软链，部署器自己重新加载，不适用这个脚本。

## 多 project 共存

skill 装一次，调度器模板装一次。每个 project 跑：

```bash
bash ~/.agents/skills/cavil-loop/setup.sh ~/github/projectA
bash ~/.agents/skills/cavil-loop/setup.sh ~/github/projectB
```

得到：

```
~/.config/cavil-loop/
├── projectA.conf
└── projectB.conf

# Linux
systemctl --user list-timers
  cavil-loop-poll@projectA.timer
  cavil-loop-poll@projectB.timer

# macOS
launchctl list | grep dev.luosky.cavil-loop
  dev.luosky.cavil-loop.projectA
  dev.luosky.cavil-loop.projectB
```

互不干扰、独立日志、独立 state。

## 升级、迁移、回退与开发模式

受管 **Linux** 每轮 poll 在明确的网络超时内 fetch 配置的 base 分支，完整解包不可变文件树后再原子替换稳定软链；断网、锁竞争或 fetch 失败都保留当前 release，fetch 进行时消费者仍可从当前 release 启动。升级是**自动**的，不需要也无法指定目标版本：跟的是 `CAVIL_DEPLOY_BRANCH`（默认 `main`）的最新 commit，与 GitHub Release / tag 无关，release 只是该 commit 的不可变快照 `releases/<sha>/`。全机共用 `CAVIL_DEPLOY_FETCH_INTERVAL`（默认 300 秒）的 fetch 节流，因此合入 base 分支后最迟约一个节流周期加一次 tick 生效。切换只影响之后启动的进程：已在运行的消费者持 `.inuse` 共享租约，继续跑自己那个 SHA。旧式 checkout 安装只通过显式动作迁移：

```bash
bash ~/.agents/skills/cavil-loop/setup.sh <host>
# 或在旧 checkout 中：
bash scripts/skill-deploy.sh --bootstrap --force
```

这样不会误接管维护者的开发软链。Linux 上单独执行 bootstrap 也会把已安装的 systemd 模板软链改指稳定受管 skill，并 reload user manager；它不会安装原本不存在的 unit，新装调度器仍应使用 `setup.sh`。稳定路径原本是实体目录时，会保留为带时间戳的 `.pre-managed.*` 备份。开发模式把稳定软链原子指向 `releases/` 外，日常部署会拒绝接管，直到再次显式 bootstrap。开发模式仍会从该 checkout 安装持久的 `entrypoints/`，因为调度器 unit 一律经由它启动。单独的 `3114f64` 没有这一步：恰好 pull 到该 commit 的 checkout 式安装会让 poller 每轮以 127 退出（`poll-entry.sh: No such file or directory`，只出现在 `journalctl --user -u coding-agent-poll@<key>`（那是改名前的安装），`poll.log` 里没有）；pull 到最新 commit 或执行 bootstrap 即可恢复。**回退目前没有持久做法**：部署成功后会立即清理所有没有活跃租约的旧 release，通常不留可回退的目标；即使某个旧 release 因仍有租约而暂时保留，手工把软链指回去也只维持到下一轮部署——部署器不比较新旧，只把软链对齐 base 分支 tip，因而会再次切到最新 commit。需要持续停在某个版本时，用开发模式脱管，或把 `CAVIL_DEPLOY_BRANCH` 指向一个停在该 commit 的分支。

| 变更 | 部署行为 |
|---|---|
| scripts、数据、prompt | 随稳定软链切换生效 |
| systemd `.service` / `.timer` | 自动执行 `systemctl --user daemon-reload` |
| systemd `.socket` / `.slice` 改了或删了 | 不自动应用；开一条带人工步骤的告警 |
| **新增** systemd 单元文件 | 不用处理——还没有任何机器装过它；不告警 |
| launchd plist 模板内容变了 | 不自动应用；要求重跑 `setup.sh` |
| launchd 模板新增 / 改名 / 删除 | 不用处理——已生成的 plist 不依赖模板文件；不告警 |

远端被确认持续领先超过配置阈值后，部署器在指定仓库最多开一条告警，追平后自动关闭这类落后告警。需要人工处理的调度告警（`.socket`、`.slice`、launchd 或 `daemon-reload` 失败）不会被下一次无变更部署误关；维护者处理完并关闭告警 issue 后，部署器才清除该状态。

**macOS** 仍手动升级。LaunchAgent plist 是 per-project、由 `setup.sh` 生成；模板变化后重跑：

```bash
launchctl bootout gui/$UID/dev.luosky.cavil-loop.<key> || true
rm ~/Library/LaunchAgents/dev.luosky.cavil-loop.<key>.plist
bash ~/.agents/skills/cavil-loop/setup.sh <host>
```

只有受管 Linux 会自动取得纯脚本更新。

### 升级不会自动补上的新配置

升级换的是代码，不动项目自己的 `cavil-loop.config`。新功能若是**配置里不写就关**、而 `cavil-loop.config.example` 里是开的（新装项目因此默认就有），老项目上它就一直关着，没有任何提示（GitHub#289：等前置标签 `pending/blocked` 在老项目上一直没开，维护者以为早已生效）。这类配置项在 [`scripts/config-notices.txt`](../scripts/config-notices.txt) 里登记为 `notice`；模板里其余每一项都登记为 `quiet` 并写明原因（不写时行为相同、必填项、示例值、权限参数）。

daemon 每轮把这些项和配置（加上 systemd 环境文件）实际设置的值对一遍。写成空值（如 `LABEL_PENDING_BLOCKED=""`）算「已决定不开」，不会被提示。每个缺项：

| 做什么 | 什么时候 |
|---|---|
| `poll.log` 里一行（`⚠️ 配置提示：本项目配置里没有 <KEY> …`） | 每项一次 |
| 在项目仓库开一条挂 `pending/human` 的 issue（不会被派工），写明每项做什么、要开照抄模板里哪一行、不开写什么 | 第一次出现缺项时；这条 issue 开着期间又出现的缺项，以评论追加在上面 |
| 关掉这条 issue | 列出的每一项都写进配置（开或不开）之后 |

人手动关掉这条 issue = 这一批不再提示，只有之后新出现的缺项才开新的。daemon 从不改配置。读不到这条 issue 或写失败时什么都不发，下一轮重来，「读不到」从不当成「已关」。只在调度器经 `poll-entry.sh` 起的轮询里运行：手动直接跑 `agent-poll.sh` 试跑、或在 worker 会话里跑，都不会开 issue。`CONFIG_NOTICE_ISSUE=false` 只留日志，不发任何 GitHub 调用。状态在 `$STATE_DIR/config-notice.json`，删掉它只意味着「重新判断一次」（最坏多开一条）。

不等 issue、直接看一个项目缺什么，在任意 shell 里跑（先改 `KEY`，别的什么都不用设）：

<!-- config-notice-ops:begin -->
```bash
KEY=myproject    # the instance name / 实例名: systemctl --user list-timers 'cavil-loop-poll@*'
ENV_FILE="$HOME/.config/cavil-loop/$KEY.conf"
[ -f "$ENV_FILE" ] || ENV_FILE="$HOME/.config/coding-agent-work-loop/$KEY.conf"   # installed before the rename / 改名前装的
CONF=$(sed -n 's/^CODING_AGENT_CONFIG=//p' "$ENV_FILE" | tr -d '"')
STATE_DIR=$(bash -c 'source "$1" >/dev/null 2>&1; printf %s "$STATE_DIR"' _ "$CONF")
echo "config: $CONF"
echo "state:  $STATE_DIR"
if [ -f "$STATE_DIR/config-notice.json" ]; then
    jq . "$STATE_DIR/config-notice.json"
else
    echo "no config-notice.json: nothing missing, or no scheduled poll of this version yet / 没有缺项，或新版本还没被调度器跑过"
fi
grep -s '配置提示' "$STATE_DIR/poll.log" | tail -5
```
<!-- config-notice-ops:end -->

怎么看：`logged` 是当前缺的项（每项在 `poll.log` 写过一次），`issued` 是已经写进提示 issue 的项，`issue` 是那条 issue 的号（`null` = 没有开着的）。把某一项写进配置后，下一轮调度轮询就把它从两个列表里去掉；全都补上后 `issue` 回到 `null`，那条 issue 被关掉。如果有人把提示 issue 转进了别的流程（摘掉 `pending/human`、或打上派工标签），daemon 就不再碰它、也不再跟踪（`poll.log` 里有一行 `已被转进别的流程`）。

往 `cavil-loop.config.example` 里加配置项时，要在同一个改动里登记进 `scripts/config-notices.txt`，否则 `tests/config-notice.test.sh` 红。只有「不写就关、模板里开」的才登记成 `notice`。

## 发版节奏

每轮迭代结束发一个版本（GitHub#80）。迭代按 cavil project 看板的 Iteration 字段：每轮 7 天、周一开始，和自然周对齐，所以不读看板，直接按日历触发：

- **何时**：`.github/workflows/release.yml` 的定时触发，**每天** 00:10 北京时间（16:10 UTC，GitHub#309）。周一那次发刚结束的那一周；其余六天发现这一周已发布，十几秒就结束——周一门禁没过时，修复合进 main 之后的第一次每天检查把这一周补发出来，名字和标题仍归那一周。GitHub 的定时任务高峰期会晚几分钟到几十分钟执行。
- **发哪一周**：「刚结束的那一周」= 运行开始时按北京时间算、最近一个已经过完的周日 D（北京时间周日 23:59 还是上一周，周一 00:00 起是这一周）。计划那步只算一次，门禁和打标签都用它定下的周、提交和 tag，跨过零点也不变。只补最近这一周：连续漏发两周以上时更早的周不单独出版本，它们的提交算进补发的这一版。
- **运行期间 main 又有合入时发哪个提交**：一次运行可能排在另一次 Release 运行后面等着（同一时间只跑一个），门禁又要跑几个小时，这期间 main 通常会有新提交（GitHub#329）。计划那步取它执行时 main 的最新提交——不是触发运行那一刻的提交；发版那步只给门禁测过的那个提交打 tag，不管 main 之后又走了多远。只有签出根本不在 main 历史上（分叉）才拒绝。在本机手动跑 `scripts/release.sh` 仍要求本地 main 与 `origin/main` 完全一致。
- **发什么**：tag 是 `release/vD.N`。Release 标题带上 tag 日期所在的周一～周日，例如 `release/v2026.10.25.1 · 迭代 2026-10-19 ~ 10-25`。计划那步（`scripts/release.sh --plan`）按顺序判断，命中第一条即定：
  1. main 最新提交上有 `release/v*` tag 还没有 Release 页面 → 门禁测这个提交，给这个 tag 补建页面，不打新 tag
  2. 刚结束那一周的 tag 里有没有页面的（取序号最大的那个）→ 门禁测**这个 tag 自己的提交**，给它补建页面，不打新 tag
  3. main 最新提交上的 tag 都有页面 → 不发，日志写「本轮无新提交」
  4. 这一周已有发布过的 tag：定时运行不发；手动发版给 main 最新提交打这一周的下一个序号
  5. 其余 → 给 main 最新提交打 `release/vD.1`
- **上次只推了 tag 也能补**：tag 已推但 Release 页面创建失败时，下一次运行（定时或手动发版）先补这个页面（上面第 1、2 条），排在「这一周已发布」之前。生成说明的起点是最近一个**有 Release 页面**的 tag，一直没补上页面的 tag（例如更早一周的）会被跳过，它的改动算进下一个 Release。查不到 Release 列表时整次运行失败，不猜。tag 直接读远端（签出里可能还留着远端已删的 tag），读不到同样整次失败；建页面前再核对远端 tag 仍指向受测提交，被删或被挪走就不建，`gh release create --verify-tag` 也不会替缺失的 tag 新建一个。
- **手动发版**：Actions 页面 → Release → Run workflow（选 main，不勾 `gate_only`），按上面同一张表走，只差第 4 条；勾 `gate_only` 只跑门禁，永远测 main 最新提交，不看这一周发没发，不打 tag 不建页面。或在本机 main 上跑 `bash scripts/release.sh`（交互确认，行为不变——用当天 UTC 日期，它不判断是否已发过）。
- **同一次运行里完成**：流程用内置令牌推的 tag 不会再触发流程，所以定时 / 手动运行在同一个 job 里接着生成 Release；人手推的 tag 仍由 tag 触发走后半段。不需要额外 secret。

Release 只是 changelog 和 `npx skills add` 的落点，**和受管安装的升级无关**：受管 Linux 跟的是 base 分支最新提交（见上一节）。

### 发版运行失败会自动开 issue（GitHub#285）

Release 的任何一次运行——定时、tag 推送、手动发版、手动「只跑门禁」（正文标「诊断运行」）——只要有任务失败，最后一个任务 `report failure` 就会写到一条 issue 上，失败不再只有打开 Actions 页面的人才看得到。被取消的运行不报告。

- **没有未关闭的同类 issue**：新建一条，标题 `Release 工作流运行失败（自动报告）`，带 `pending/agent`，daemon 照常派工。「同类」= 本仓库、未关闭、创建者 `github-actions[bot]`、正文含 `<!-- cavil-release-failure -->`、不是 PR。
- **已有一条未关闭**：在编号最小的那条下追加评论，**从不改它的标签**——它正在处理、等人、等前置，都原样保持。处理完就关掉它；下次失败会新建一条。
- **写了什么**：运行链接、触发方式、受测提交、每个任务的结果和失败步骤、门禁汇总里没通过的 shell 单位、客户端没按预期变红的条目。门禁通过、只有发版任务失败时写明失败在哪一步。
- **判断不了时**（issue 列表某一页或其中某一条读不全、查到之后到写入之间那条 issue 变了）一律不写，`report failure` 任务标红，看该任务日志。
- 新 issue 打的标签是仓库变量 `RELEASE_FAILURE_LABEL`（默认 `pending/agent`），必须和本仓库的派工标签一致。

<!-- release-failure-ops:begin -->
**任务标红并写着「issue #N 已建、派工标签没打上」**：issue 建好了，但 daemon 不会派工。之后的运行只会评论，不会补标签。手动打上，N 换成那句提示里的编号：

```bash
N=123
gh api -X POST "repos/GigleAI/cavil-loop/issues/$N/labels" -f 'labels[]=pending/agent'
gh api "repos/GigleAI/cavil-loop/issues/$N" --jq '[.labels[].name]'
```

看到最后一条命令打印的列表里有 `pending/agent` 即成功。第一条命令对标签报 404，说明仓库里没有这个标签：先建（`setup.sh` 会建），或者把 `RELEASE_FAILURE_LABEL` 设成本仓库的派工标签。无需回退：在 issue 页面的 Labels 里再摘掉，就恢复原样。

**停用**（之后每次运行都跳过这个任务）与**恢复**：

```bash
gh variable set RELEASE_FAILURE_REPORT --body off --repo GigleAI/cavil-loop
gh variable delete RELEASE_FAILURE_REPORT --repo GigleAI/cavil-loop
```

停用只跑第一行，恢复只跑第二行。核对：`gh variable list --repo GigleAI/cavil-loop` 停用期间显示 `RELEASE_FAILURE_REPORT off`，恢复后没有这一项。
<!-- release-failure-ops:end -->

## 改名前的安装

本项目原名 `coding-agent-work-loop`。新安装一律用 `cavil-loop`；改名前装好的机器在迁移之前
照旧用旧名字运行，迁移是自动的——见下面的[旧安装自动迁移](#旧安装自动迁移)。

| 东西 | 新安装 | 改名前的安装（继续认） |
|---|---|---|
| 技能入口 | `~/.agents/skills/cavil-loop`、`~/.claude/skills/cavil-loop` | `~/.agents/skills/coding-agent-work-loop` |
| 调用命令 | `/cavil-loop` | `/coding-agent-work-loop`（不保留别名） |
| 每个项目的环境文件、`deploy.conf`、预览登记 | `~/.config/cavil-loop/` | `~/.config/coding-agent-work-loop/` |
| 状态目录 | `~/.local/state/cavil-loop/<项目>/` | `~/.local/state/coding-agent-poll/<项目>/` |
| Linux 后台任务 | `cavil-loop-poll@` / `cavil-loop-weekly-report@` / `cavil-loop-preview*@` / `app-cavil\x2dloop\x2dpoll.slice` | `coding-agent-*` / `app-coding\x2dagent\x2dpoll.slice` |
| macOS 后台任务 / 日志 | `dev.luosky.cavil-loop.<key>`、`~/Library/Logs/cavil-loop/` | `dev.luosky.coding-agent-work-loop.<key>`、`~/Library/Logs/coding-agent-work-loop/` |
| 项目根目录的本地配置 | `cavil-loop.config` | `coding-agent.config` |
| 项目仓库里的指令覆盖目录（已提交） | `.agents/skills/cavil-loop/` | `.agents/skills/coding-agent-work-loop/`、`.agents/skills/coding-agent-workflow/`、`.coding-agent/` |

代码挑路径只有一条规则（`scripts/_names.sh`；`release-entry.sh` 内联了同一条）：
**新名字的在就用新的，否则旧名字的在就用旧的，都不在按新的建。** 两个都在时新的赢。

- `systemd/` 里的 `coding-agent-*` 旧单元文件**一个字节都不改**地保留：老机器上装的单元是指向
  这些确切路径的软链；改动 `.socket` / `.slice` 还会让每台机器都开一条「需要人工处理」的告警。
- `setup.sh` 只在状态目录里还没有 `state.json` 时才初始化。重跑它（任何安装都一样，包括刚把旧安装
  迁过来的那一次）会保留已有的已读评论记录和 worker 记录，不再按「现在打开的条目」整份重建。
- 对 `~/.config/coding-agent-work-loop/<key>.conf` 已存在的项目重跑 `setup.sh`，会先把它迁到新名字
  （见下），再按新安装往下走；项目正忙时这次不迁、继续沿用旧名字。绝不会在开着的旧定时任务旁边
  再装一套新名字的——两个轮询会抢同一批 issue。
- 项目里已有 `coding-agent.config` 就继续用这个文件名：项目的忽略规则写的是旧文件名，改名后的
  文件不再被忽略，可能被 worker 顺手提交进仓库。
- 一台机器上可能同时有新旧两个技能入口（旧项目认旧入口，新装的项目认新入口）。两者都指向
  `releases/` 时部署器一起切换，并且不会删除其中任何一个还指着的 release。
- 按需预览**跟着自己的登记走**，不看「这台机器装了哪套单元」：旧项目注册的预览在装上新单元
  之后仍然留在旧单元和旧登记目录上，直到被搬到新单元（见下「旧预览搬到新单元」）。认主、`--list`、
  注销两个目录都看，任一目录里被占的端口都算被占；新旧共用一把端口锁（机器上有旧单元或旧登记目录
  时用旧目录那把，所以旧登记搬空之后旧目录也不删）。单元启动时读的是它自己绑定的那份登记——新单元
  把路径传进来，旧单元读旧目录。全新注册、以及本机已装新单元时重注册自己名下的旧登记，都用新单元。
- 新旧 worker 落在不同的 slice 里，两类安装共存期间各有一份内存限额。新 slice 的名字按旧 slice
  同一条派生规则推出，还没在真机上看过。

### 旧安装自动迁移

`scripts/migrate-legacy.sh` 把一个旧项目迁到新名字。不用人去跑：

- **Linux**：**任何一个**项目的每一轮轮询（`poll-entry.sh`，在主轮询读配置之前）都会顺手把本机
  所有空闲的旧项目迁掉。所以它随部署生效——受管安装合并后约 10 分钟内。开发模式的机器（技能
  入口指向一个 checkout）要等那个 checkout 更新到包含它的版本。迁的正好是起这一轮的旧 timer
  所属的项目时，这一轮到此结束，迁移刚启用的新 timer 约 30 秒后跑下一轮。
- **macOS**：重跑一次 `setup.sh <host>`。它先迁移，再生成新的 LaunchAgent——plist 是生成出来的，
  后台轮询自己换不了。

**只迁空闲的项目。** 空闲 = 这个项目没有 worker 的 tmux 会话（`<TMUX_PREFIX>-<SESSION_NAME_PREFIX><N>`）、
周报没在生成、轮询锁没被占着。**先**拿轮询锁，持锁再看 worker 和周报：派工只发生在持有这把锁
的轮询里，所以从看完到搬目录之间不可能冒出新 worker（先看后拿锁的话，中间那一轮轮询可以派完工、
放掉锁）。正在跑的 worker 记住的是旧路径，在它底下搬状态目录，它下一次 `source _lib.sh` 就会在
旧位置建出一个空目录。忙的项目每轮都会再试，等待原因一小时最多记一次。周报不读状态目录，查它只是
为了不在它跑的时候换它的定时任务。

**项目迁到一半时，它的主轮询暂停。** 从第 1 步到最后，进度文件里写着这个项目的配置（`CFG=…`），
`poll-entry.sh` 看到就直接结束这一轮、不跑 `agent-poll.sh`。不然一轮轮询正好落在「状态目录已搬、
配置还没改」中间，就会在旧位置 mkdir 出空状态目录，用空状态把历史评论重新派一遍。下一轮（本项目
或任何一个项目的）接着迁。光看一眼进度文件不够——一轮轮询可能在迁移开始前看过、又恰好在目录搬走
前读了旧配置。所以本机还有旧安装时，`poll-entry.sh` 从这次检查一直到 `agent-poll.sh` 拿到本项目的
轮询锁，都持着全机迁移锁的**共享**一侧（拿到后立刻放掉，派出去的进程不会继承）；迁移要拿排他一侧
才能开始。所有需要人处理的情况（见下）都在第 1 步**之前**查完，所以只有确实迁得完
的项目才会暂停。迁移中途仍在旧位置冒出的空壳（没有 `state.json`、只有 `poll.log` / `poll.lock`）
认得出来：日志并进新目录后删掉。

按顺序做这些事（每一步都能重复执行；中途断了，下一次接着做完）：

| 步骤 | 做什么 | 旧的去哪了 |
|---|---|---|
| 1 | 记下旧 timer 原来开没开、在不在跑（`~/.config/cavil-loop/migration/<key>.inprogress`）；备份环境文件、项目配置、状态里的 `state.json` / `agent-sessions/` / `poll-pace.json` | 备份在 `~/.config/cavil-loop/migration/<key>-<时间>/`（0700） |
| 2 | 共享部分，只有第一个项目做：建 `~/.agents/skills/cavil-loop`，指向旧入口指的地方；`~/.claude/skills/coding-agent-work-loop` 换成 `cavil-loop`（不留别名）；搬 `deploy.conf`，里面写死的旧技能入口一并改掉 | `deploy.conf.migrated-<时间>` |
| 3 | Linux：装新单元模板的链接；本机的 slice drop-in 复制一份给新 slice | 旧 slice 和它的 drop-in 留着——迁移前起的 tmux server 还挂在它下面 |
| 4 | 搬状态目录（`~/.local/state/coding-agent-poll/<p>` → `~/.local/state/cavil-loop/<p>`，同盘一次改名）**并且**改写项目配置里写死的路径。改写后的配置先验证、再动目录 | 配置原文在备份里 |
| 5 | 写 `~/.config/cavil-loop/<key>.conf`（0600） | — |
| 6 | Linux：实例的 drop-in（轮询间隔）复制到新 timer 名下；新的轮询 / 周报 timer **只在旧的原来开着 / 在跑时**才启用 / 启动；**之后**才 `disable --now` 旧的（不停 service：迁移经常就跑在它这一轮里）。先新后旧：新 timer 开不起来时旧的还在跑，下一轮它自己再试；两个都开着的那段时间，两边的轮询都只会接着迁（进度文件在）、都不跑主轮询。macOS：`bootout` 旧 LaunchAgent | 旧 drop-in 和实例链接进备份；旧 plist 进备份 |
| 7 | 最后才把旧环境文件改名——它还在，下一次就会回来把没做完的做完 | `<key>.conf.migrated-<时间>` |

本机一个旧项目都不剩、**旧预览也都搬到了新单元**时，删掉旧的 `~/.agents/skills/coding-agent-work-loop`；
还经过它的单元链接（旧预览模板、旧 slice）先改走新入口——旧单元文件一个字节都没改。

#### 旧预览搬到新单元

旧预览单元文件里 `ExecStart` / `ExecStartPost` 写死的是 `%h/.agents/skills/coding-agent-work-loop/scripts/…`。
只改单元文件的软链救不了它：删掉旧入口之后，旧单元一启动就找不到脚本，预览全部 502（#75）。所以删
入口之前，`~/.config/coding-agent-work-loop/preview/` 下的每份登记都要搬到 `cavil-loop-preview*@<端口>`
上，端口和 URL 不变（tailscale 路由按端口绑，也不用动）。

谁来搬：旧项目全部迁完之后，每一轮轮询的迁移步骤都搬一次（失败的下一轮再来）；`preview-serve.sh`
在本机已装新单元、而自己名下的登记还在旧目录时，先搬再注册。两处是同一个函数
（`scripts/_preview_adopt.sh`），全程持端口锁。

一个端口的步骤（每步都可重复执行，中途在哪里断，下一次从头再跑只会做完剩下的）：

| 步骤 | 做什么 | 失败时 |
|---|---|---|
| ① | 第一次碰这个端口时，记下旧监听原本该不该开（在听 / 已 failed = 该开；没在听 = 不开），写进 `~/.config/cavil-loop/migration/preview-<端口>.listen`；已有记录不覆盖 | 什么都没动 |
| ② | 旧登记**复制**到新目录（新目录已有同主人的就不动） | 旧登记原样在 |
| ③ | 停掉并 `reset-failed` 旧的 socket / 代理 / app，确认三者都不在运行 | 两份登记都在，下一轮接着做 |
| ④ | 原本该开的，起新 socket 并确认它在听；原本不开的跳过 | 两份登记都在；旧入口还在时把旧 socket 拉回来 |
| ⑤ | 旧登记移进 `~/.config/cavil-loop/migration/preview-legacy/`（不删），清掉 ① 的记录 | — |

所以一个端口只会是三种状态：只有新目录有登记 = **完成**；新旧两份、主人相同 = **搬到一半**，下一轮
接着搬；新旧两份、主人不同 = **冲突**，两份都不动，`migrate.log` 里每小时记一次，等人决定留哪份。
还有搬到一半或冲突的端口时，旧技能入口不删——那些端口的旧单元还要靠它才起得来。

**一个端口「查不到状态」也算没搬完。** 用户服务管理器连不上时（`systemctl --user` 只报错、给不出
状态），这一步既不记原状、也不认定旧单元已停，登记和旧入口都原样留着，日志写明查不到，下一轮再来。

**处理冲突（人工）。** `preview-unserve.sh` 帮不上忙：两份登记里只要有一份不在调用方名下，它就整个
不动（退出 3）——这是有意的，不能放开。用 `scripts/preview-resolve-conflict.sh`。它在**同一把端口锁里**做完全部步骤，处理期间注册、注销、迁移碰这个端口
都会等；留下的那份**最后总是跑在新单元上**，所以选错了换回来也不依赖旧技能入口——全部冲突处理完后，
下一轮迁移就会删掉旧入口。

1. **看现状**（只读，不改任何东西）：
   ```bash
   bash ~/.agents/skills/cavil-loop/scripts/preview-resolve-conflict.sh 4050
   ```
   输出两份登记各自的主人（项目、issue 号、worktree）和新旧监听的状态。通常留 worktree 还在、issue 还开着的那份。
2. **留下一份**（`old` = 旧登记目录里那份，`new` = 新登记目录里那份）：
   ```bash
   bash ~/.agents/skills/cavil-loop/scripts/preview-resolve-conflict.sh 4050 --keep new
   ```
   它会：两份都备份到 `~/.config/cavil-loop/migration/preview-conflict-<端口>-<时间>/`（第一行输出
   「备份：…」就是这个目录，记下来）→ 停掉去掉那一侧的 socket / 代理 / app，确认都停了 → 把那份登记移进
   备份 → 留旧的话当场搬到新单元 → 确认新监听在听。看到 `✅` 算成功；任何一步失败都以 1 退出并说明
   卡在哪，停不下来时一个登记都不移走，修好后重跑同一条命令即可。
3. **检查**：打开这个预览地址，能看到页面。下一轮轮询（约 1 分钟）后，`migrate.log` 不再出现这个端口的冲突；
   所有冲突都处理完、旧预览都搬完的话，旧技能入口会被删掉——这是正常的。
4. **选错了**：换成上次移走的那一份（第 2 步打印的备份目录）：
   ```bash
   bash ~/.agents/skills/cavil-loop/scripts/preview-resolve-conflict.sh 4050 --swap ~/.config/cavil-loop/migration/preview-conflict-4050-<时间>
   ```
   它先核对这份备份就是这个端口这次处理的那份：备份里记的端口、要换上的登记里写的端口都得是这个端口，
   而且现在的登记要和处理时留下的那份一字不差。对不上就拒绝（以 2 退出），什么都不动——拿错了别的端口的
   备份、或者处理之后那个项目又重新注册过，都会挡在这里。核对通过后：把当前登记**复制**进备份，停掉新单元，
   在原位置一次性换上另一份（换的过程中登记一直在），再在**新单元**上起监听——旧入口已经删了也照样能用。
   中途失败就以 1 退出，修好后重跑同一条命令，它会从断的地方接着做。然后同第 3 步检查。备份目录里原有的
   文件一个都不改：`old.conf` / `new.conf` 是处理前的原样。

轮询入口调迁移的条件因此不止「还有旧项目的环境文件」：旧登记目录里还有登记、或者旧入口还在而新入口
也在，同样会调（`_names.sh` 的 `cavil_legacy_leftovers`）。三样都没有就不调。守卫：
`tests/preview-legacy-adopt.test.sh`。

故意不搬的：

- 项目自己的文件：`coding-agent.config` 不改名（项目的忽略规则写的是旧文件名），只改写里面的
  `STATE_DIR` 那一行（以及同一目录的其他写法）；备份绝不写进项目目录。仓库里已提交的覆盖目录不改名。
- `~/.local/state/coding-agent-poll/review-shots`：评论配图从这里经公网地址提供；新目录不存在时
  代码继续用它。
- 配置在 `~/.local/state/coding-agent-poll/<p>` 以外的状态目录：原地不动。

以下情况在动任何东西之前就停手等人（日志里带 ⛔，每轮都会再试，但一小时只记一次；期间旧安装照常轮询）：新旧两份环境文件都在、又不是
迁移留下的半成品（有人手动装过新的——可能两个 timer 都开着）；新旧两个状态目录都在；项目配置的
`STATE_DIR` 不是能机械改写的写法；新状态根目录在另一个磁盘分区。

开始迁之后仍然每次都失败的项目（比如 `systemctl` 每次都报错）会一直暂停，每次尝试都记一行 ❌。
macOS 上迁到一半时重跑 `setup.sh` 会接着迁完；这种状态下 setup 不会再按旧名字往下装。

日志：`~/.local/state/cavil-loop/migrate.log`（也在跑它的那个轮询的 journal 里，项目自己的 `poll.log`
里留一行）。要撤销，照备份目录手工恢复。

## 手动 cron 兜底

上面两种调度器不是硬要求；`agent-poll.sh` 无状态，任何调度器都能驱动。适用：

- 你在 `setup.sh` 不自动配的系统（BSD、不带 systemd 的 WSL、容器、……）
- 就不想 systemd / launchd

**cron**（任何 Unix）：

```cron
* * * * * CODING_AGENT_CONFIG=$HOME/myproject/cavil-loop.config bash $HOME/.agents/skills/cavil-loop/scripts/poll-entry.sh >> /tmp/cavil-loop-cron.log 2>&1
```

**Claude Code `/loop` skill**：起一个长 session 跑 `/loop 60s bash ~/.agents/skills/cavil-loop/scripts/poll-entry.sh`。优点：调度逻辑也能上下文感知；缺点：贵 + session 死了就停。

## 评论配图的公网入口：只放行图片和视频

评论配图要能被 GitHub 抓到，所以资产目录（`review-shots`）要经公网隧道对外。**不要把这个目录直接交给静态文件服务器**（例如把隧道直接指到目录）：它会列出每个子目录里的文件名，也会把目录里的任何文件原样交出去——worker 顺手放进去的日志、测试报告、登录状态文件就等于公开了。往每个目录里放一个 `index.html` 挡列表也不可靠：新建的子目录会漏，而且挡不住文件类型。

用自带的小服务（`scripts/public-assets/serve.mjs`）挡在隧道后面：

- 只监听 `127.0.0.1`；只响应 GET / HEAD
- 只交出扩展名是图片 / 视频（`png jpg jpeg gif webp avif svg mp4 webm mov`）、**而且开头的字节确实是那种格式**的文件；`svg` 另查内容像 SVG 且不含凭证样式
- 任何目录、其他类型、改了扩展名的文件、路径里有 `.` 开头的段、符号链接指到目录外：一律同一个 404，不带原因；原因在本机日志里（`journalctl --user -u cavil-loop-public-assets`）
- 支持分段请求（视频拖动需要）

启用（整机一份，不分项目）：

```bash
# 1. 写配置（端口自己挑一个没人用的）
cat > ~/.config/cavil-loop/public-assets.conf <<CONF
PUBLIC_ASSETS_ROOT=$HOME/.local/state/cavil-loop/review-shots
PUBLIC_ASSETS_PORT=<port>
PUBLIC_ASSETS_NODE=$(command -v node)
CONF
# 2. 装单元并起服务（这个单元 setup.sh 不装：它是按需启用的，整机一份）
ln -sfn ~/.agents/skills/cavil-loop/systemd/cavil-loop-public-assets.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now cavil-loop-public-assets.service
# 3. 把公网入口从「挂目录」改成「转发到这个端口」，对外路径保持不变，例如 tailscale：
#    tailscale serve --bg --https=<公网端口> --set-path /review-assets/ http://127.0.0.1:<port>
```

`PUBLIC_ASSETS_ROOT` 填实际在用的资产目录（旧安装是 `~/.local/state/coding-agent-poll/review-shots`）。对外路径前缀不是 `/review-assets/` 时加一行 `PUBLIC_ASSETS_PREFIX=`。

发图前自查用 `node scripts/public-assets/check.mjs <目录或文件>`：逐个报公网拿不拿得到，任何文件里有令牌 / 密钥样式就点名并以退出码 1 结束（三份工作说明模板里已写这一步，`publish-asset.sh` 发布前也会跑）。

不是图片 / 视频的附件（周报 PDF 等）不公开发布：`publish-asset.sh` 把它放进不公开的目录，项目配置里设了 `WEEKLY_REPORT_PRIVATE_ASSET_ROOT_URL`（只在内网可达的地址前缀，对应目录由 `WEEKLY_REPORT_PRIVATE_ASSET_ROOT` 指定，默认资产目录旁的 `private-assets/`）就给那个地址，没设就给本机路径。周报趋势图的矢量版留在本机（`WEEKLY_REPORT_VECTOR_DIR`，默认资产目录旁的 `weekly-report-vector/`），`topdf.mjs` 从本机读。

截图要带登录状态时，`scripts/review-screenshot.mjs --auth <文件>` 要求登录状态文件在被 git 忽略的路径里、且不在截图输出目录内，否则报错不截图；它改端口用的副本写在原件旁边（权限 600），结束、出错、被中断都会删掉。

## 升级到 webhook（即时触发）

轮询有最坏 1 分钟延迟。要即时：

1. tailscale funnel / cloudflare tunnel 把本机 `<port>` 开公网
2. 跑 [`webhook`](https://github.com/adnanh/webhook) 这种小 listener 订阅 GitHub `issue_comment` + `labeled` 事件
3. listener 收到 → 直接跑 `agent-poll.sh`（poll 本身按 label 过滤 + state.json 去重，safe to retrigger）
4. 保留 systemd timer / launchd LaunchAgent 当兜底

## 自定义 worker（不是 Claude Code）

Worker 切换走一层薄的 **driver 抽象**，不需要 fork。普通任务默认使用 `WORKER_AGENT=claude`；`WORKER_MODEL` 只覆盖普通任务的模型。启用可选 review 关卡后，review 独立使用 `REVIEW_WORKER_AGENT=codex` 和 `REVIEW_MODEL`；模型留空时由对应 driver 使用自己的当前默认值。内置：`claude`、`opencode`、`codex`、`cursor`。想加自家 agent，往 `scripts/drivers/<name>.sh` 加（或放项目级 `<host>/.agents/skills/cavil-loop/drivers/<name>.sh`） — 5 个函数的接口契约和模板见 [drivers.zh.md](drivers.zh.md)。

## 故障排查

### 最近几轮轮询都干了什么（运行记录，GitHub#344）

`poll.log` 里只有代码主动打的那些行，轮询进程的 stderr 又是指向 `/dev/null` 的。运行记录补上另一半：每一轮
轮询退出时自己写**一条记录**——开始 / 结束时间、耗时、结果、走到的最后一步、看到几个候选、派了几个工、发了
几次 GitHub 调用、其中几次失败。非零退出、读不到 GitHub、轻量检查超时或失败、某一步超过
`POLL_RUN_LOG_SLOW_SECS`、发现上一轮卡在锁上的那一轮，还会另存一份**快照**。`poll-entry.sh` 一进来就先写
一行「已启动」，所以「完全没跑起来」和「跑了没事做」分得开。

<!-- poll-history-ops:begin -->
```bash
KEY=myproject    # the instance name / 实例名: systemctl --user list-timers 'cavil-loop-poll@*'
ENV_FILE="$HOME/.config/cavil-loop/$KEY.conf"
[ -f "$ENV_FILE" ] || ENV_FILE="$HOME/.config/coding-agent-work-loop/$KEY.conf"   # installed before the rename / 改名前装的
CONF=$(sed -n 's/^CODING_AGENT_CONFIG=//p' "$ENV_FILE" | tr -d '"')
bash "$HOME/.agents/skills/cavil-loop/scripts/poll-history.sh" --config "$CONF" -n 20
```
<!-- poll-history-ops:end -->

它打印的内容：最近几轮的表格；有进度文件、没有正式记录的轮次；入口记录（启动了但没走到「配置加载完」，或
在那之前就退出了，带退出码）；最近一份快照，连同那一轮在 `poll.log` 里对应的那一段。`--json` 是同一份数据，
给机器读。

| 结果 | 含义 |
|---|---|
| `ok` | 正常跑完 |
| `pace-skip` | 被空闲 / 故障退避跳过（轻量检查的结果在单独一列） |
| `lock-busy` | 上一轮还没跑完；备注里写着占锁的是哪一轮、已经跑了多久 |
| `github-unreadable` | 读不到 GitHub，没派工就停了（有快照） |
| `error` | 非零退出（有快照，带脚本名和行号） |
| `early-exit` | 没走到最后就以 0 退出，走的是运行记录没有起名字的路径 |

读的时候要知道：

- **被直接杀掉的那一轮**（断电、内存不足被系统杀、`SIGKILL`）写不了记录，事后也没有谁替它补。它只留下进度
  文件，查看命令对照进程列表后把它显示成「未正常结束」，并写明停在哪一步。进程列表不可信时显示「判断不了」，
  不乱猜。进度文件只留最近 64 份。
- **GitHub 调用数**只算轮询进程自己发出的（含它的子 shell 和轻量检查那一次），不含派工脚本和 Python 辅助程序
  发的。`gh` 以非零退出就算一次失败；只有轻量检查那一次例外——回 `200` 或 `304` 算成功（真的 `gh` 对 `304`
  也是以 1 退出）。显示「未知」是那一轮的计数器没建成或读不回来——别当成 0；数字后面带 `+` 是数到了上限
  （一轮 20000 次调用），真实次数不少于这个数。
- **入口脚本自己都没被执行**（文件缺失、退出码 127）时，这里什么都记不下。查看命令这时会直接打印该看的
  `journalctl` 那一行。
- 快照里只有校验过的字段：脚本名、行号、函数名、步骤名、退出码、少量校验过的配置值、节奏状态里的数字字段、
  `poll.log` 的字节位置——没有源码行、没有命令输出、没有 issue 和评论的文字。同一原因、同一位置一小时内只留
  一份。
- 轮询的任何判断都不读这些文件。写失败、目录满了又腾不出位置，都只是少记一条。

文件在哪、各留多少（每个目录都是先腾出一个位置再新增，所以就算轮次接连在写到一半时被杀，数量也守得住；只有
恰好同一时刻在写的几轮才会短暂超出，每轮最多多一份）：

| 路径 | 内容 | 保留 |
|---|---|---|
| `$STATE_DIR/runlog/rounds/` | 每轮一条正式记录 | `POLL_RUN_LOG_ROUNDS`（1000） |
| `$STATE_DIR/runlog/snapshots/` | 快照 | `POLL_RUN_LOG_SNAPSHOTS`（20） |
| `$STATE_DIR/runlog/inflight/` | 进行中轮次的进度 | `POLL_RUN_LOG_INFLIGHT`（64） |
| `$STATE_DIR/runlog/acct/` | 平时是空的：每一轮在这里建一份计数用的文件，打开之后立刻删掉 | `POLL_RUN_LOG_INFLIGHT`（64） |
| `~/.local/state/cavil-loop/runlog/entry/` | 没走到「配置加载完」的那些轮询的入口记录（本机所有项目共用） | 200 |

关掉并删除已有记录（要再打开，把 `ENABLE_POLL_RUN_LOG=false` 那一行删掉；下一轮轮询会重新建目录）：

<!-- poll-history-off-ops:begin -->
```bash
KEY=myproject    # the instance name / 实例名: systemctl --user list-timers 'cavil-loop-poll@*'
ENV_FILE="$HOME/.config/cavil-loop/$KEY.conf"
[ -f "$ENV_FILE" ] || ENV_FILE="$HOME/.config/coding-agent-work-loop/$KEY.conf"   # installed before the rename / 改名前装的
CONF=$(sed -n 's/^CODING_AGENT_CONFIG=//p' "$ENV_FILE" | tr -d '"')
STATE_DIR=$(bash -c 'source "$1" >/dev/null 2>&1; printf %s "$STATE_DIR"' _ "$CONF")
[ -n "$STATE_DIR" ] || { echo "cannot read STATE_DIR from $CONF / 读不到 STATE_DIR"; exit 1; }
echo 'ENABLE_POLL_RUN_LOG=false' >> "$CONF"
rm -rf "$STATE_DIR/runlog"
echo "run log off, records removed: $STATE_DIR/runlog / 已关闭并删除记录"
```
<!-- poll-history-off-ops:end -->

### poll.log 变稀疏了，daemon 是不是死了

多半没死：一整天没人碰的项目会**故意**少轮询（`POLL_BACKOFF_LADDER`）。退避中的每个
tick 仍然写一行，写明现在在哪一档、还要等多久 —— 所以「安静」和「退避」在日志上是分
得开的：

```
[...] [myproj] 本轮跳过（已安静 3d4h，当前档位 10m0s，还差 7m12s）
```

按顺序查：

```bash
cat ~/.local/state/cavil-loop/<key>/poll-pace.json    # 现在哪一档、从什么时候开始安静
grep -c 'poll start' ~/.local/state/cavil-loop/<key>/poll.log   # 到目前为止真跑了几轮
rm ~/.local/state/cavil-loop/<key>/poll-pace.json     # 立刻回最快档
```

删这个文件永远是安全的：它只存节奏，不存「哪些评论看过了」那些游标（那些在
`state.json` 里）。而且不管它里面是什么，两条保证都成立：最长
`POLL_FORCE_SYNC_SECS` 一定会跑一次完整轮询；任何解析不出来、或者超出合法范围的状态
一律按「现在就该跑」处理，而不是「再等等」。想整个关掉就把 `POLL_BACKOFF_LADDER` 置空。

空闲轻量检查开着时（`POLL_IDLE_PROBE`，GitHub#252），跳过那行末尾带「；轻量检查：无变化」；
被它叫醒的那个 tick 记一行「轻量检查：仓库有变化 → 提前跑一轮」，或者写明为什么说不准
（「读不到 GitHub」「GitHub 回了 HTTP <n>」），说不准时同样照跑。打标签、评论（含代码行内评论）、
往 PR 推送提交、关闭 / 合并大约一个 tick 内就能看到；主干新提交、CI 结果看不到，等下一次完整检查（最长
`POLL_IDLE_PROBE_MAX_SECS`，默认 10 分钟）。删 `~/.local/state/cavil-loop/<key>/poll-probe.etag`
同样安全：下一次检查只是多跑一轮。

如果日志是**真**的一行都没有（连跳过那行也没有），那才是 daemon 真的停了，往下看。

### Timer / agent 起来了但 daemon 不跑

**Linux（systemd）**：

```bash
systemctl --user status cavil-loop-poll@<key>.timer
systemctl --user status cavil-loop-poll@<key>.service
journalctl --user -u cavil-loop-poll@<key>.service --since "10 min ago"
```

**macOS（launchd）**：

```bash
launchctl print "gui/$UID/dev.luosky.cavil-loop.<key>"
tail -50 ~/Library/Logs/cavil-loop/<key>.err.log
tail -50 ~/Library/Logs/cavil-loop/<key>.out.log
```

通用原因：
- `~/.config/cavil-loop/<key>.conf` 路径不对 → 编辑 conf
- `cavil-loop.config` 缺字段 → 看 `poll.log`
- `gh auth` 没登录 → `gh auth status`
- `claude` 不在调度器 `PATH` 里 → `~/.config/cavil-loop/<key>.conf` 里 `PATH=` 加上 `which claude` 的目录

macOS 专属：
- "Bootstrap failed: 5: Input/output error" → 之前的 load 还在。`launchctl bootout "gui/$UID/dev.luosky.cavil-loop.<key>"` 后重跑 setup。
- `<key>.err.log` 报 `flock: command not found` → `brew install flock`。

### 发新版后某个项目的定时任务消失了（`Unit to trigger vanished`）

**现象**：某个项目的 `poll.log` 停在最后一轮、没有任何报错；`systemctl --user list-timers` 里它的 NEXT 是 `-`，或者根本不在列表里；journal 里有

```
cavil-loop-poll@<key>.timer: Failed to open …/cavil-loop-poll@<key>.timer: No such file or directory
cavil-loop-poll@<key>.timer: Unit to trigger vanished.
```

**原因**（GitHub#109）：`systemctl --user enable` 会把模板链接解析到底，实例链接和 `timers.target.wants/` 里那条都直指某一个 `~/.agents/releases/cavil-loop/releases/<sha>/`，而不是稳定入口 `~/.agents/skills/cavil-loop/`。部署器一清理那一版，定时任务的单元文件就没了。

**自动修复**：`scripts/repair-unit-links.sh`。每一轮轮询（总是当前版本）、部署器清理旧版本之前、`setup.sh` 启用之后、旧安装迁移启用之后都会跑它。它把我们自己的链接（新名字和改名前的名字）改回稳定入口；改之前先写一个持久的「待重新加载」记号，`daemon-reload` 成功才清掉（所以重新加载失败了，下一轮哪怕没有链接要改也会再做）；记号清掉之后，才启动 systemd 报告为「已启用 + 失败、原因 `resources`」的定时任务——这正是 systemd 记录「运行中单元文件消失」的方式。你停掉的（`inactive`）、禁用的，一律不启动；状态查不到也不动。部署器也不会删除还有单元链接指进去的版本。限制：手动 `systemctl --user reset-failed` 之后这个记录就没了，不会替你启动；user manager 重启也会丢掉它（链接修好后，已启用的任务登录时本来就会起来）。

**什么时候要你动手**：只有一种情况——本修复部署之前，这台机器上**所有**项目的定时任务都已经停了，没有任何一轮轮询能来部署和执行它。

0. 先确认是不是这种情况：

   ```bash
   systemctl --user list-timers --all 'cavil-loop-*' 'coding-agent-*'
   U=~/.config/systemd/user
   for d in "$U" "$U"/*.wants "$U"/*.requires; do
       case "$d" in *'*'*) continue ;; esac
       [ -d "$d" ] && [ -r "$d" ] && [ -x "$d" ] || { echo "cannot read: $d"; continue; }
       for l in "$d"/*; do
           [ -L "$l" ] || continue
           case "$(basename "$l")" in cavil-loop-*|coding-agent-*) ;; *) continue ;; esac
           case "$(readlink "$l")" in */.agents/releases/cavil-loop/releases/*) echo "points into a release: $l" ;; esac
           [ -e "$l" ] || echo "broken: $l"
       done
   done
   ```

   有项目的 NEXT 是 `-`、有项目不在列表里，或者那段循环打印了任何一行，就往下做；都正常就到此为止。

1. 更新到含修复的版本（机器上只有改名前的入口时，`if` 那段会自动换成 `~/.agents/skills/coding-agent-work-loop`）：

   ```bash
   SKILL="$HOME/.agents/skills/cavil-loop"
   if [ ! -e "$SKILL" ] && [ ! -L "$SKILL" ]; then
       SKILL="$HOME/.agents/skills/coding-agent-work-loop"
   fi
   bash "$SKILL/scripts/skill-deploy.sh" --force
   test -f "$SKILL/scripts/repair-unit-links.sh" && echo "has the fix"
   ```

   `--force` 只跳过「5 分钟内只拉一次」的节流，不跳过锁：看到 `another instance is fetching; skip` 或 `a consumer or another publisher is active`，等 1 分钟再跑同一段，最多 3 次。看到 `development mode`：技能入口指向的是一份代码 checkout，部署器不管它——改为在那份 checkout 里 `git pull`。没打印 `has the fix` 就停下，把两条命令的完整输出贴出来。

2. 执行修复（逐条打印改了哪条链接、是否重新加载、启动了哪个任务；退出码非 0 就停下，贴出输出）：

   <!-- repair-unit-links:repair -->
   ```bash
   SKILL="$HOME/.agents/skills/cavil-loop"
   if [ ! -e "$SKILL" ] && [ ! -L "$SKILL" ]; then
       SKILL="$HOME/.agents/skills/coding-agent-work-loop"
   fi
   bash "$SKILL/scripts/repair-unit-links.sh"
   ```

3. 确认成功：循环没有任何输出，你希望运行的定时任务 NEXT 都有时间（你有意暂停的可以保持未运行）：

   <!-- repair-unit-links:check -->
   ```bash
   U=~/.config/systemd/user
   for d in "$U" "$U"/*.wants "$U"/*.requires; do
       case "$d" in *'*'*) continue ;; esac
       [ -d "$d" ] && [ -r "$d" ] && [ -x "$d" ] || { echo "cannot read: $d"; continue; }
       for l in "$d"/*; do
           [ -L "$l" ] || continue
           case "$(basename "$l")" in cavil-loop-*|coding-agent-*) ;; *) continue ;; esac
           case "$(readlink "$l")" in */.agents/releases/cavil-loop/releases/*) echo "points into a release: $l" ;; esac
           [ -e "$l" ] || echo "broken: $l"
       done
   done
   systemctl --user list-timers --all 'cavil-loop-*' 'coding-agent-*'
   ```

   （这里用 shell 循环而不是 `find`：`~/.config/systemd/user` 本身是软链接时，`find` 不会进去，里面有断链也一行不打印。进不去的目录——它本身或上层目录缺权限——会打印 `cannot read: …`，不会悄悄当成没问题；这一行同样不算成功。）

4. 第 1–3 步走不通时，逐个项目手工兜底。`KEY` 换成项目名（`~/.config/cavil-loop/` 下、改名前安装是 `~/.config/coding-agent-work-loop/` 下那个 `<项目名>.conf`）；改名前的任务用 `P=coding-agent`，周报任务用 `KIND=weekly-report` 单独再跑一次。只对你确实要运行的任务操作：

   <!-- repair-unit-links:fallback -->
   ```bash
   KEY=arktool
   P=cavil-loop
   KIND=poll
   SKILL="$HOME/.agents/skills/cavil-loop"
   if [ ! -e "$SKILL" ] && [ ! -L "$SKILL" ]; then
       SKILL="$HOME/.agents/skills/coding-agent-work-loop"
   fi
   S="$SKILL/systemd/$P-$KIND@.timer"
   U="$P-$KIND@$KEY.timer"
   if [ ! -f "$S" ]; then
       echo "template missing: $S"
   else
       (
           set -e
           cd "$HOME/.config/systemd/user"
           mkdir -p timers.target.wants
           ln -sfn "$S" "$U"
           ln -sfn "$S" "timers.target.wants/$U"
           systemctl --user daemon-reload
           systemctl --user restart "$U"
           systemctl --user list-timers --all "$U"
       )
   fi
   ```

   NEXT 有时间即恢复。任何一步报错就停下，贴出输出和 `systemctl --user status "$U"`。启动了不想跑的任务：`systemctl --user stop "$U"`（要登录后也不起来，再 `systemctl --user disable "$U"`）。

### Worker session 卡在权限弹窗

确认 `cavil-loop.config` 里 `CLAUDE_EXTRA_FLAGS="--dangerously-skip-permissions"`。本机受信任环境下强烈推荐。

### Worker 卡在目录信任确认框（「Quick safety check」/「Trust this folder?」）

GitHub#108 之后，daemon 每次起会话前都会先写信任记录、起完看一眼屏幕，所以这种情况应当表现为：这条活被翻回 `pending/human`，留言写明哪个 agent、哪个目录；`poll.log` 里有一行 `卡在 <agent> 的目录信任确认框上（工作目录 …，该补的信任记录：…）`，当时的屏幕存进了会话日志。

1. 先在 `poll.log` 里找那次派工前后以 `[trust]` 开头的行：等锁超时、「连续 3 次在写入前被别的进程改动」、配置文件读不懂，都会说明记录为什么没写进去。
2. 都没有，多半是 agent 改了判定规则。在 daemon 机器上进入留言里的那个目录手动跑一次 agent，选信任后退出，再把标签改回 `pending/agent`。然后看 agent 自己写的是哪一条（`~/.claude.json` 的 `projects`、`~/.codex/config.toml` 的 `[projects."…"]`），据此改那个 driver 的 `agent_trust_key`。

### Daemon 不停 re-dispatch 同一 PR

可能是 worker 没翻 label。检查 prompt 模板是否要求 worker 翻 label。或手动：
```bash
gh pr edit N --add-label pending/human --remove-label pending/agent
```

如果 worker 没回任何 comment 就完事，state.json 的 comment ID 不会推进，下次又会被当新评论。Prompt 应强制 worker 至少回一句评论。

### 同一条活每轮派工都失败

派工失败本身什么状态都不改 —— label 没翻、comment cursor 没动 —— 于是下一轮 poll 又把
它捡起来。这以前是个没有上限的循环，现在由 `DISPATCH_MAX_RETRIES`（默认 3）封顶，到
上限就摘掉触发 label、把这条活转 `pending/human`。原因直接在日志里 grep：

```bash
grep -E '派工失败|连续 .* 次派工失败' "$STATE_DIR/poll.log" | tail
```

失败原因写在 `poll.log` 里，**不需要**再去翻 `journalctl`。如果某行看着是空的或被截断，
那是 bug：派工路径上的每一个 `git` 调用都应该走 `run_git` helper，它会在失败时把命令的
完整输出逐行写进日志。

有一个成因值得单独记住，因为 git 对它是**无条件**拒绝的：**目标分支已经被另一个
worktree 签出。** 这时 `git fetch` 必然失败（哪怕根本没东西要更新），而紧随其后的
`git worktree add --force` 反倒会成功、建出**第二个**签出同一分支的 worktree —— 两个
worker 往同一个分支上提交。所以派工会在动手之前就拒绝，并把占用者路径写进日志、直接
转 `pending/human`。留言里写出占用者的真实目录、它现在的状态（有没有未提交改动、比 PR
领先 / 落后几个提交、有没有进行中的合并 / 变基），并按占用者种类给出能执行的命令：

```bash
# 占用者是主 checkout（你在那里开的分支并 push 了）：
git -C '<主 checkout>' switch main    # 腾出分支，然后重新标 pending/agent
# 占用者是附加 worktree：
git worktree remove '<占用者目录>'     # 腾出分支，然后重新标 pending/agent
```

主 checkout 不能 `git worktree remove`（`fatal: ... is a main working tree`）。项目是
git submodule 时，`git worktree list` 给主 checkout 报的是它的 gitdir
（`.../.git/modules/<名字>`），daemon 会先解析成真实工作目录再显示。配置
`AUTO_RELEASE_MAIN_CHECKOUT=1` 后，确定安全时 daemon 会自己执行这个 `switch`（条件见配置
模板），并在 PR 上留言说明。

计数文件在 `$STATE_DIR/dispatch-fail/`，第一次成功时清零、升级转人工时也清零 —— 所以
人工重标一次总能拿到完整的重试次数。要手工清某一条：
`rm -f "$STATE_DIR/dispatch-fail/pr-959"`。

### 调试一次 poll

```bash
CODING_AGENT_CONFIG=~/myproject/cavil-loop.config \
    bash ~/.agents/skills/cavil-loop/scripts/poll-entry.sh
tail -50 ~/.local/state/cavil-loop/myproject/poll.log
```

### 浏览存活的 worker session

先按 `Ctrl+b`，再按 `s`。列表保留 tmux 原生 `choose-tree` 布局，并在每个
worker session 行末追加 GitHub issue 标题：

```text
myproject-issue42: 1 windows | 优化首页加载性能
```

标题存放在 session-scoped tmux option `@desc` 中；issue/PR worker session
每次创建或复用时都会刷新。没有 `@desc` 的非 worker session 保持 tmux 原始显示。

### 回看已退出 session 的历史

tmux session 一旦 exit，原 pane 的 scrollback 就消失了。本项目用 `tmux pipe-pane` 把每个 worker session 的输出旁路到磁盘：

```bash
# 路径（默认值；可通过 SESSION_LOG_DIR 改）
$STATE_DIR/sessions/<TMUX_PREFIX>-issue<N>.log

# 快捷查日志
bash ~/.agents/skills/cavil-loop/scripts/session-log.sh 42        # 打印路径
bash ~/.agents/skills/cavil-loop/scripts/session-log.sh 42 -c     # cat
bash ~/.agents/skills/cavil-loop/scripts/session-log.sh 42 -f     # tail -F 跟随
```

日志是 append-only，同一 issue 重起 session 会续写到同一份；每次启动会插一行 `===== <iso-date> session=... opened =====` 当分隔符。

想让 Claude 本身续上对话（而不只是看历史），或 worktree 已被 auto-cleanup 删掉想找回会话，见 [persistence.md → 断点续写 SOP](persistence.zh.md#断点续写-sop)（列了 `--resume <id>` / `--from-pr <P>` / 重建 cwd / 直接读 jsonl 四条路径）。

### 紧急停所有 worker

**Linux**：

```bash
systemctl --user stop cavil-loop-poll@<key>.timer
tmux ls | grep "^<project>-issue[0-9]" | cut -d: -f1 | xargs -r -n1 tmux kill-session -t
```

**macOS**：

```bash
launchctl bootout "gui/$UID/dev.luosky.cavil-loop.<key>"
tmux ls | grep "^<project>-issue[0-9]" | cut -d: -f1 | xargs -n1 tmux kill-session -t
```

### 卸载某个 project

`bash ~/.agents/skills/cavil-loop/scripts/disconnect-project.sh <key>` 按系统做完下面的必做步骤（改名前的旧安装同样适用），后台任务状态读不到时什么都不删——见[用脚本安装、查状态、断开](#用脚本安装查状态断开github313)。手动做：

**Linux**：

```bash
KEY=<key>
systemctl --user disable --now cavil-loop-poll@$KEY.timer
rm ~/.config/cavil-loop/$KEY.conf
# 可选：rm <host>/cavil-loop.config（也可保留供下次接入）
# 可选：rm -r ~/.local/state/cavil-loop/<project>
```

**macOS**：

```bash
KEY=<key>
launchctl bootout "gui/$UID/dev.luosky.cavil-loop.$KEY"
rm ~/Library/LaunchAgents/dev.luosky.cavil-loop.$KEY.plist
rm ~/.config/cavil-loop/$KEY.conf
# 可选：rm <host>/cavil-loop.config
# 可选：rm -r ~/.local/state/cavil-loop/<project>
# 可选：rm ~/Library/Logs/cavil-loop/$KEY.*.log
```

## 合并后的对话复盘

`POST_MERGE_RETROSPECTIVE=true` 启用独立后台队列。首次运行记录启用时间，后续分页扫描更新过的 closed PR，只处理新合并项，不补跑历史、不处理未合并关闭项，也不依赖自动 cleanup。

分页采集关联 issue、普通评论、review、行内评论。Claude（`RETROSPECTIVE_MODEL=sonnet`）没有工具或 MCP 权限。固定发布程序只提交 `docs/retrospectives/pr-N.md` 和 `.agents/skills/cavil-loop/prompts/lessons.md`（配了项目命令时再加上它的改动，见下）到**来源项目自己的仓库** `origin/$BASE_BRANCH`（默认 main），使用隔离 worktree、仅 fast-forward 推送。项目经验从该项目远端读取，只加载进该项目的 prompt，位于项目增量要求之前。

公开 cavil 仓库的 `prompts/lessons.md` 只保留经过独立审查、脱离项目也成立的公开流程原则。自动发布程序不会向 cavil 写入生成的项目内容、标识、链接或复盘。通用改进候选先保存在项目报告中，另行去项目化审查后才能公开。证据保存在来源项目和本机状态目录。

项目经验是一本按 PR 计次的错题本（格式与校验见 `scripts/retrospective_lessons.py`）：每条规则有永久编号 `L<n>`，所在段落（`硬规则` / `待确认` / `观察中`）就是它的状态，`Seen N×` 列出出现过它的不同 PR。模型每次只能给规则追加**本次 PR** 的一次出现，并且必须附上本次采集到的某条评论 / review 的链接作为证据；已有规则的「规则」「适用」字段、编号和旧的出现记录都不能改，含义不同只能新开一条从 1 次起算。在 3 个不同 PR 里出现的规则由程序要求升级：`RETROSPECTIVE_PROMOTION=auto`（默认）直接进 `硬规则`，`confirm` 只进 `待确认`、由人手改文件挪进 `硬规则`。违反任何一条，整份输出作废。自审与交叉 review 模板要求逐条核对 `硬规则`。**派工说明里带的是裁过的版本（GitHub#208）**：计次格式的文件（有 `<!-- next-id: N -->` 这一行）只带开头说明，以及 `硬规则` / `待确认` 每条的编号、规则、适用、为什么；整段 `观察中`、每条的「这样做是对的」举例和 `Seen` 出现记录只留在文件里，末尾一句告诉 agent 去哪读。没有 `next-id` 行的文件（skill 自带的通用经验、手写的文件）原样带。文件本身不变，复盘照旧读写整份。项目里的 lessons.md 还是旧格式时，复盘在调模型之前就跳过、不计失败次数，一小时后再查，等项目迁移完自动补上。

**目录经验与只复盘哪些 PR（GitHub#152 / #168）。** 项目配置里的 `RETROSPECTIVE_DIRECTORY_LESSONS` 是一个总开关，**默认打开**。打开时，复盘只处理「开关在本机生效那一刻及之后」合并的 PR；更早合并、还在队列里等的 PR 会在任务文件里标成 `skipped`（保留，不删），**永远不会被复盘**：没有复盘报告，也不计入任何经验次数。被处理的 PR 都可以写经验文件末尾的 `## 目录经验` 段，文件里没有这一段时复盘会自己补上。关掉开关时照旧复盘队列里所有 PR，不写目录经验（已有的这一段一字不改：根本不交给模型）。关掉再打开会重新计时，关着期间合并、还在排队的 PR 同样被跳过。开关写成 `true` / `false` 以外的值，复盘在读写任何东西之前就报错停下。每一轮先把整个队列分类一遍（所有未结束的任务，不看排队位置和重试时间；主干上已经有报告的算完成；合并时间或主干上的报告读不出的任务原样留到下一轮），再最多复盘一个。开始时间按机器记在 `$STATE_DIR/retrospectives/directory-lessons.json`（不进 `cursor.json`）；换机器或文件丢了，就从那一刻重新计时。开关打开时这个文件读不出或写不进，整个队列这一轮暂停（日志写明文件位置）——因为判断不了哪些该跳过。目录经验的条目格式与前三段一样、共用 `next-id`，区别是每次记录写明发生在哪些目录：`- Seen 2×: #1460 <链接> [server/credits/] · #1471 <链接> [server/credits/ · server/usage/]`。目录相对仓库根、以 `/` 结尾；每条新记录至少写一个，且必须是合并后目录树里真实存在的目录（不许绝对路径、`..`、`.git`、指出仓库的链接）。旧条目和旧记录（包括目录）一字不改；同一 PR 在一条里只记一次；把流程经验原样抄进这一段会被拒；模型自己加这个标题会被拒。这一段不参与升级，条目不进不出。各目录的次数由项目自己从记录里筛；派工拼说明时跳过这一段，这些经验只经项目自己的各层目录说明到达 agent。24000 字的上限算的是除这一段以外的整份文件（不是派工说明里裁过的版本），这一段另有 24000 字上限。

**关掉开关却没记下来时。** 关掉开关会留下记录（时间文件写成「关」、或删掉、或在 `cursor.json` 里留一个标记——时间文件读不出时一律留标记，那个文件原样不动）。因为这个标记而记下的开始时间会记住是哪个标记，标记之后没清掉，下一轮也只是再清一次，不会当成又关过一次。如果这一轮三处都写不进去，队列暂停，`retrospective.log` 会写明原因和文件位置；之后如果没人处理就把开关改回打开，会沿用旧的开始时间，关着期间合并的 PR 可能被复盘并写上目录经验。要重新计时，按下面的顺序做（停下 → 留证据 → 重置 → 重启）：

<!-- retro-dir-recovery:begin -->
```bash
(
# Every step ends in "|| exit": nothing after a failed step runs.
# 1) This project's state directory: replace <project> with the project's key, the
#    directory name under ~/.local/state/cavil-loop/ (also the timer's instance name).
STATE_DIR="$HOME/.local/state/cavil-loop/<project>"
Q="$STATE_DIR/retrospectives"
TIMER="cavil-loop-poll@$(basename "$STATE_DIR").timer"
# 2) Stop this project's poller, then take the retrospective's scan lock and keep it
#    until this block ends: a retrospective already running finishes first, and one
#    started later (by a poll that was already under way) gives up while we hold it.
systemctl --user stop "$TIMER" || exit 1
exec 9>>"$Q/scan.lock" || exit 1
flock 9 || exit 1
# 3) Keep the evidence: copy the start-time file and the scan record (copy only).
ts=$(date -u +%Y%m%dT%H%M%SZ) || exit 1
if [ -e "$Q/directory-lessons.json" ]; then cp -p "$Q/directory-lessons.json" "$Q/directory-lessons.json.bak-$ts" || exit 1; fi
cp -p "$Q/cursor.json" "$Q/cursor.json.bak-$ts" || exit 1
# 4) Reset the start time: remove the start-time file only.
rm -f "$Q/directory-lessons.json" || exit 1
test ! -e "$Q/directory-lessons.json" || exit 1
# 5) Release the lock, then start the poller again.
exec 9>&- || exit 2
systemctl --user start "$TIMER" || exit 2
)
case $? in
0) echo "reset done" ;;
2) echo "reset done, but the poller did NOT start again: run  systemctl --user start cavil-loop-poll@<project>.timer" ;;
*) echo "reset FAILED: stopped at the step that printed the error above; no later step ran" ;;
esac
```
<!-- retro-dir-recovery:end -->

每一步只在上一步成功后才执行。怎样算成功：整段打印 `reset done`，之后 `retrospective.log` 里下一行是 `directory lessons on: handling PRs merged at or after <时间>`，时间晚于这次重置。第 2 步拿到的复盘扫描锁一直持有到第 4 步结束，备份和重置期间不会有复盘在跑。三种结果：`reset done`——全部完成。`reset done, but the poller did NOT start again`——重置已经完成（时间文件已删、备份保留），只是重启失败：照打印出的 `systemctl --user start` 命令再启动一次。`reset FAILED`——出错那一步之后都没执行，重置没有发生：停止那一步失败，轮询保持原状；之后的步骤失败，轮询保持停止，时间文件和 `cursor.json` 都没动（备份失败不会删任何东西）。修好原因（磁盘、权限——时间文件读不出时也备份不了）后，把整段重新执行一遍。改名前的老安装，定时器叫 `coding-agent-poll@<项目>.timer`。重置救不回已经按旧时间写进去的目录经验：在主干上看经验文件的 `git log -p`，找那段时间的 `docs: learn from` 提交，手工删掉写错的条目（人工编辑就是下一轮的新基线）。

**复盘后执行的项目命令（可选，GitHub#152）。** `POST_RETROSPECTIVE_PROJECT_CMD`（留空 = 关闭）在复盘的临时 checkout 根目录用 `bash -c` 执行，时机是报告和经验文件校验通过并写好之后、提交之前——比如把目录经验排名后写进各层 `AGENTS.md` 的脚本。它拿到 `RETROSPECTIVE_PR`、`RETROSPECTIVE_LESSONS_FILE`、`RETROSPECTIVE_REPORT_FILE`（相对仓库根的路径），限时 10 分钟。它改动或新建的文件和报告、经验文件进**同一个提交**，仓库忽略规则排除的文件除外——脚本留下多余文件是脚本的 bug，要修。非零退出、超时、改了校验过的报告或经验文件、自己提交，都算本次复盘失败：什么都不推、临时 checkout 删掉，按原有规则重试（一小时一次、共 3 次；每次重试都会重新调模型）。成功时日志记下输出末尾，失败时输出末尾进失败原因。临时 checkout 是从主干新取的，没有 `node_modules` 这类没提交的东西。**它按运行 daemon 的本机用户权限执行**：复盘自己用的 GitHub 令牌（`GH_TOKEN` / `GITHUB_TOKEN`）不传给它，但这不是隔离——本机已有的 `gh` 登录、git 凭据它仍然用得到，它绕开这个 checkout 直接推送也拦不住。只配置可信命令。

本机所有项目最多同时一个复盘（靠全机锁 `~/.local/state/cavil-loop/retrospective.lock`，与部署方式无关，GitHub#165），模型超时 30 分钟，失败一小时后重试，同一个 PR 连续失败 3 次就停下（任务状态记为 `failed`，原因在日志里），需人处理后把任务文件的 `status` 改回 `pending`。项目远端报告作为完成标记。状态、证据、重试信息位于 `$STATE_DIR/retrospective.log` 和 `$STATE_DIR/retrospectives/`。设为 `POST_MERGE_RETROSPECTIVE=false` 暂停并保留队列。需要 Python 3、支持 safe mode/结构化输出的 Claude CLI 和来源项目推送权限。不修改旧评论或业务 worker 标签。
