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
- **轮次上限**（`REVIEW_MAX_ROUNDS`，默认 3）唯一的作用是防两个 agent 互相打回烧 API，
  所以**人显式要的 review 不受它约束**：人手动挂 review 标签 → 无视上限；人留了评论 →
  计数从那条评论之后重算、自然归零。判定靠比对 actor 与 `gh api user` 的账号，
  不需要揣摩评论文字的意图。轮次不存 state.json，数的是 issue/PR 上「最近一次人工动作
  之后」的 `<!-- codex-review-round -->` 标记：看板上看得见、state 丢了不会重置
- **打回必须用默认的 `pending/agent`**，不是 review label 自己——模板里用
  `${LABEL_PENDING_AGENT_DEFAULT}` 占位符拿这个值。用错就是死循环
- self-heal 靠 `state.json` 的 `worker_trigger_labels` 把死掉的 session 送回**原来那条队列**；
  只按 model 反推做不到这点（review 关卡换的是 agent 不是 model）

留空 = 完全关闭，行为与从前一致。

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
| `${LABEL_REVIEW_OR_HUMAN}` | **产出后该翻到哪**：启用 review 关卡时 = `pending/review`，未启用时自动退化成 `pending/human`。模板一律用它，别直接写 `${LABEL_PENDING_REVIEW}`——没配置时那个渲染成空串，活会丢掉 `doing/agent` 又拿不到任何 pending 标签，从看板上彻底消失 |
| `${PREVIEW_URL_HOST}` | 本机对外提供 PR 预览的主机名。**别在模板里硬写主机名**——同一份模板会在所有盯这个仓库的机器上跑，写死的主机会把审阅者指到一台根本没有这些文件的机器 |
| `${REVIEW_ASSET_BASE_URL}` | review 截图的公网 base URL（funnel 那个 path），取自 `WEEKLY_REPORT_ASSET_ROOT_URL`。同理：截图落在哪台机器上，URL 就得指哪台 |
| `${LABEL_PENDING_AGENT_DEFAULT}` | 默认的 `pending/agent`。review 模板打回时必须用它——`${LABEL_PENDING_AGENT}` 是**触发**标签，在 review 关卡里拿它打回等于打回自己，死循环 |
| `${OUTPUT_LANGUAGE}` | ISO 639-1 代码，控制 worker 写回 GitHub 的语言（从 `cavil-loop.config` 读，默认 `en`） |

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

## 升级到 webhook（即时触发）

轮询有最坏 1 分钟延迟。要即时：

1. tailscale funnel / cloudflare tunnel 把本机 `<port>` 开公网
2. 跑 [`webhook`](https://github.com/adnanh/webhook) 这种小 listener 订阅 GitHub `issue_comment` + `labeled` 事件
3. listener 收到 → 直接跑 `agent-poll.sh`（poll 本身按 label 过滤 + state.json 去重，safe to retrigger）
4. 保留 systemd timer / launchd LaunchAgent 当兜底

## 自定义 worker（不是 Claude Code）

Worker 切换走一层薄的 **driver 抽象**，不需要 fork。普通任务默认使用 `WORKER_AGENT=claude`；`WORKER_MODEL` 只覆盖普通任务的模型。启用可选 review 关卡后，review 独立使用 `REVIEW_WORKER_AGENT=codex` 和 `REVIEW_MODEL`；模型留空时由对应 driver 使用自己的当前默认值。内置：`claude`、`opencode`、`codex`、`cursor`。想加自家 agent，往 `scripts/drivers/<name>.sh` 加（或放项目级 `<host>/.agents/skills/cavil-loop/drivers/<name>.sh`） — 5 个函数的接口契约和模板见 [drivers.zh.md](drivers.zh.md)。

## 故障排查

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

### Worker session 卡在权限弹窗

确认 `cavil-loop.config` 里 `CLAUDE_EXTRA_FLAGS="--dangerously-skip-permissions"`。本机受信任环境下强烈推荐。

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
转 `pending/human`：

```bash
git worktree list                 # 找出占用者
git worktree remove <占用者目录>   # 腾出分支，然后重新标 pending/agent
```

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

分页采集关联 issue、普通评论、review、行内评论。Claude（`RETROSPECTIVE_MODEL=sonnet`）没有工具或 MCP 权限。固定发布程序只提交 `docs/retrospectives/pr-N.md` 和 `.agents/skills/cavil-loop/prompts/lessons.md` 到**来源项目自己的仓库** `origin/$BASE_BRANCH`（默认 main），使用隔离 worktree、仅 fast-forward 推送。项目经验从该项目远端读取，只加载进该项目的 prompt，位于项目增量要求之前。

公开 cavil 仓库的 `prompts/lessons.md` 只保留经过独立审查、脱离项目也成立的公开流程原则。自动发布程序不会向 cavil 写入生成的项目内容、标识、链接或复盘。通用改进候选先保存在项目报告中，另行去项目化审查后才能公开。证据保存在来源项目和本机状态目录。

项目经验是一本按 PR 计次的错题本（格式与校验见 `scripts/retrospective_lessons.py`）：每条规则有永久编号 `L<n>`，所在段落（`硬规则` / `待确认` / `观察中`）就是它的状态，`Seen N×` 列出出现过它的不同 PR。模型每次只能给规则追加**本次 PR** 的一次出现，并且必须附上本次采集到的某条评论 / review 的链接作为证据；已有规则的「规则」「适用」字段、编号和旧的出现记录都不能改，含义不同只能新开一条从 1 次起算。在 3 个不同 PR 里出现的规则由程序要求升级：`RETROSPECTIVE_PROMOTION=auto`（默认）直接进 `硬规则`，`confirm` 只进 `待确认`、由人手改文件挪进 `硬规则`。违反任何一条，整份输出作废。自审与交叉 review 模板要求逐条核对 `硬规则`。项目里的 lessons.md 还是旧格式时，复盘在调模型之前就跳过、不计失败次数，一小时后再查，等项目迁移完自动补上。

本机所有项目最多同时一个复盘，模型超时 30 分钟，失败一小时后重试，同一个 PR 连续失败 3 次就停下（任务状态记为 `failed`，原因在日志里），需人处理后把任务文件的 `status` 改回 `pending`。项目远端报告作为完成标记。状态、证据、重试信息位于 `$STATE_DIR/retrospective.log` 和 `$STATE_DIR/retrospectives/`。设为 `POST_MERGE_RETROSPECTIVE=false` 暂停并保留队列。需要 Python 3、支持 safe mode/结构化输出的 Claude CLI 和来源项目推送权限。不修改旧评论或业务 worker 标签。
