# 运维手册

> [English](operations.md) · **中文**

`setup.sh` 之后运维要用到的全在这里：`cavil-loop.config` 里的配置、每个可选功能（做什么、默认开不开、怎么开关）、跑 daemon 的命令、故障排查。每节开头先给结论；规则、边界情况和逐步命令在折叠块里，需要时点开。一个项目怎么接入自己的提示词和命令，见[编排](orchestration.zh.md)。

- **先配这些**：[配置（`cavil-loop.config`）](#配置cavil-loopconfig)
- **功能，每项一节**：[并发满时的取工顺序](#并发满时的取工顺序) · [按模型派工的标签](#按模型派工的标签) · [等前置：`pending/blocked`](#等前置pendingblocked) · [暂缓：`pending/later`](#暂缓pendinglater) · [自动把 issue / PR 加进 GitHub Project（可选，默认关闭）](#自动把-issue--pr-加进-github-project可选默认关闭) · [交叉 review 关卡（可选，默认关闭）](#交叉-review-关卡可选默认关闭) · [托管标签（可选，默认关闭）](#托管标签可选默认关闭) · [外部需求机器人（可选，默认关闭）](#外部需求机器人可选默认关闭) · [往返记录：agent 之间的来回写进同一条评论（`ENABLE_ROUND_LOG`）](#往返记录agent-之间的来回写进同一条评论enable_round_log) · [评论用量 footer](#评论用量-footer) · [Codex token 折算参考价值](#codex-token-折算参考价值) · [缺价自动补价](#缺价自动补价) · [agent 撞到用量上限：停派这个 agent，被打断的条目转人工](#agent-撞到用量上限停派这个-agent被打断的条目转人工) · [重测试排队（可选，默认关闭）](#重测试排队可选默认关闭) · [base 分支测试工作流失败自动报告（默认关闭）](#base-分支测试工作流失败自动报告默认关闭) · [GitHub 令牌脱敏](#github-令牌脱敏) · [合并后的对话复盘](#合并后的对话复盘) · [按需 preview（socket 激活）](#按需-previewsocket-激活) · [评论配图的公网入口：只放行图片和视频](#评论配图的公网入口只放行图片和视频) · [Prompt 模板](#prompt-模板) · [Cleanup hook（`CLEANUP_HOOK`）](#cleanup-hookcleanup_hook)
- **运行 daemon**：[文件结构](#文件结构) · [按 OS 选调度器](#按-os-选调度器) · [多 project 共存](#多-project-共存) · [用脚本安装、查状态、断开](#用脚本安装查状态断开) · [用脚本读 / 改一个项目的常用配置](#用脚本读--改一个项目的常用配置) · [给流程标签改名](#给流程标签改名) · [远程入口：让另一台电脑上的客户端看这台机器的 daemon](#远程入口让另一台电脑上的客户端看这台机器的-daemon) · [升级、迁移、回退与开发模式](#升级迁移回退与开发模式) · [改名前的安装](#改名前的安装) · [手动 cron 兜底](#手动-cron-兜底) · [升级到 webhook（即时触发）](#升级到-webhook即时触发) · [自定义 worker（不是 Claude Code）](#自定义-worker不是-claude-code) · [发版节奏](#发版节奏)
- **出问题时**：[故障排查](#故障排查)

## 配置（`cavil-loop.config`）

每个项目一份，放在 host project 根目录（`setup.sh` 生成并加进 `.gitignore`）。要让项目跑起来只需填几行：`REPO`、
几个路径（`PROJECT_ROOT`、`WORKTREE_BASE`、`STATE_DIR`）、`WORKTREE_SETUP_CMD` 和令牌；其余都有能用的默认值。带注释的完整字段见
[`cavil-loop.config.example`](../cavil-loop.config.example)。

<details><summary>一份带注释的典型配置</summary>

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
# GH_TOKEN（一个账号包办读写）。本文件装着 token 时保持 0600。
# WRITE_GH_TOKEN=""

# Merge 后 daemon 自动 cleanup（worktree + tmux）
AUTO_CLEANUP_ON_MERGE=true

# 等你审（pending/human）的 PR 和目标分支冲突了。只在目标分支或 PR
# 自己有新提交时才查。N 天内有更新 → 发一条评论 + 改回 pending/agent 让 worker 解；
# 更久没动 / 外部仓库 → 只发一条提醒，标签不动。设 0 = 只提醒、从不自动解。
PENDING_HUMAN_CONFLICT_CHECK=true
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
# 空闲时的轻量检查：退避中每 tick 先发一次不占主额度的条件请求，仓库变了
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
# 派工失败本身什么都不改，所以没有上限的话下一轮会原样再来、一直重派下去
# （bot 账号这样循环重派可能被 GitHub 封停）。
# 计数在 $STATE_DIR/dispatch-fail/，成功和升级转人工时都会清零。
DISPATCH_MAX_RETRIES=3
# self-heal 那边同理：tmux session 死掉的 worker 最多自动重派几次，超了转 pending/human。
SELFHEAL_MAX_RETRIES=3

# 条目挂着 doing/agent、会话还在却没人干活：agent 空闲、GitHub 和本地分支都没有
# 新动静，连续这么多秒算卡住 → 先往会话里催一次；再过 STEP_GAP 秒仍没动静 → 结束会话、翻回
# 原触发标签重派（最多 MAX_RESTARTS 次）；再卡住 → 留言并转 pending/human。
# 全程脚本判断，不调用大模型。留空或 0 = 关闭；配置里没有这一行也是关闭。
STUCK_WORKER_QUIET_SECS=1800
STUCK_WORKER_STEP_GAP_SECS=900
STUCK_WORKER_MAX_RESTARTS=1

# 本地 base 落后 origin 这么多 commit 就开 issue 提醒（跟上后自动关）；默认 0 = 关
# 只有人真的上手干活的那个 checkout 才会卡住，所以是 opt-in；要开推荐设 20
CHECKOUT_STALE_ALERT_COMMITS=0

# 1 = PR 分支被本项目自己的主 checkout 占着、且它干净、没有进行中的操作、与 PR 最新提交
# 完全一致时，把它切回 BASE_BRANCH 继续派工（会在 PR 上留言）。默认 0 = 关：它放宽了
# 「daemon 不碰你的工作区」
AUTO_RELEASE_MAIN_CHECKOUT=0

# 派工口径：label = 只捡打了 pending/agent 的；greedy = 开着的都干，除非被挡工 label 挡住
DISPATCH_MODE="label"
GREEDY_SKIP_LABELS=""            # greedy 下额外的挡工 label（逗号分隔，追加在内置五个之后）
LABEL_PENDING_LATER="pending/later"  # 暂缓：greedy / 托管都不自动捞它开工；没写这一行 = 开，写成空值 = 关闭
GREEDY_SCAN_LIMIT=100

# 第一排序键从哪儿来：label = priority/p* 标签；project = GitHub 的 Priority 字段；both = 前者优先、缺了回落标签
PRIORITY_SOURCE="label"
PROJECT_PRIORITY_FIELD="Priority"
PROJECT_NUMBER=""                # 留空 = 本仓库关联的第一个看板；看板在别处就填编号
PROJECT_OWNER=""                 # 看板 owner 跟仓库 owner 不同时才填
PROJECT_GH_TOKEN=""              # 只用于读看板的 token；留空 = 复用 GH_TOKEN
AUTO_ADD_PROJECTS=""             # 把本仓库 issue / PR 加进这些 Project（"myorg/4 myorg/11"）；留空 = 关闭
CI_FAILURE_REPORT_WORKFLOWS=""   # base 分支测试工作流失败自动报告（"tests.yml"）；留空 = 关闭
# WRITE_GH_TOKEN=""              # 所有**写**用的 token；留空 = 复用 GH_TOKEN
```

</details>

## 并发满时的取工顺序

待派工的条目多于空闲 slot 时，daemon 把 issue 和 PR **合成一个池**，依次按优先级 label、阶段、等待时长三个键排序取工。优先级
label 由 `PRIORITY_LABELS` 配置（默认 `priority/p0,priority/p1,priority/p2`）；留空就只按阶段和等待时长排。

<details><summary>三个排序键</summary>

| 键 | 规则 | 说明 |
|---|---|---|
| ① 优先级 label | 列表里越靠前越优先；**哪儿都没标的垫底**（排在所有标过的之后） | 平时什么都不用打，只在真着急时挂一个 `priority/p0` 插队 |
| ② 阶段 | review 打回 < 续作 < 全新 issue | 在飞的活上下文还热，先收尾更快腾出 slot；全新 issue 还没开始，晚一轮没有沉没成本 |
| ③ 等待时长 | `updatedAt` 早的先派 | 同优先级同阶段时，久等的先走 |

</details>

<details><summary>排序不改什么、日志长什么样</summary>

排序只决定**顺序**，不改变取工条件：busy 的 session 照样不打断，并发上限照样卡，label 语义完全不变。每轮排完的结果会整行写进
`poll.log`，并发满时谁插了谁的队一眼可见：

```
派工队列 4 项，按「优先级/阶段/等待」排：issue#A(p0,全新) PR#B(p2,review打回) issue#C(p2,全新)
```

一条目同时挂多个触发 label 时，仍按 `pending/agent/fable` → `pending/agent` → `pending/review` 取第一个，与排序无关。

</details>

### 第一排序键换成 GitHub Project 的优先级字段

`PRIORITY_SOURCE` 决定键 ① 从哪儿读：`label`（默认）、`project`（GitHub Project 上的 Priority 字段）或 `both`（字段设了就用，
没设回落到 label）。读 Project 需要 `read:project` 权限；看板读不到时，daemon 记一条警告、本轮回落到 label 排序。

<details><summary><code>PRIORITY_SOURCE</code> 的三个取值</summary>

| 值 | 键 ① 来自 | 没有值的条目 |
|---|---|---|
| `label`（默认） | `PRIORITY_LABELS` 里的标签 | 垫底，排在所有标过的之后 |
| `project` | issue 原生字段，没有再看 Project (v2) 上的单选字段（默认叫 `Priority`） | 垫底，**不看 label** |
| `both` | 优先级字段设了就用它，没设的回落到 label | 两边都没有 → 垫底 |

**档位顺序不用在配置里再抄一遍**——直接取该字段在 Project 里定义的选项顺序，在看板上拖一下就改了。用哪个 Project 由
`PROJECT_NUMBER` 指定，留空 = 本仓库关联的第一个。

</details>

<details><summary>为什么 PR 回落到 label：Priority 是 issue 字段</summary>

GitHub 的 Priority 是 **issue 级字段，不是看板字段**——虽然它在看板上显示成一列、在看板的字段设置页
（`/projects/N/settings/fields/<id>`）里也点得进去。实测结果：

| 读法 | 看到什么 |
|---|---|
| Projects API `field(name:"Priority")` | `ProjectV2SingleSelectField`，但 **options 为空**（databaseId 跟设置页 URL 一致，界面上却有 Urgent/High/Medium/Low） |
| Projects API 条目值 | 类型是 `ProjectV2ItemIssueFieldValue`，不是单选值 → `fieldValueByName` 取不到 |
| Issue API `issue.issueFieldValues` | ✅ 值和选项顺序都在这儿 |
| 对照：`Status`（真·看板自定义字段） | options 正常返回 `Backlog/Preparing/...` |

所以 daemon 先试 issue 原生字段，拿不到再试真·看板自定义单选字段。**只有后者能标到 PR 上**——PR 没有 issue 原生字段。
用着原生字段时，PR 一律回落到 label 排序。日志会写明这轮用的是哪一种。

</details>

<details><summary>用哪个看板</summary>

| `PROJECT_NUMBER` | 怎么找 | 要求看板跟仓库关联吗 |
|---|---|---|
| 有值 | 按 `<PROJECT_OWNER, 编号>` 直取（先按组织找，找不到再按个人找） | 不要求 |
| 留空 | 取**本仓库关联的** Project 里编号最小的那个 | 要求 |

编号就是看板 URL 的最后一段（`github.com/users/<你>/projects/7` → `7`）。`PROJECT_OWNER` 默认取仓库 owner，**看板挂在别的
owner 名下时必须配**——个人看板装着组织仓库的卡片是最常见的那种。自动挑那条路显式写了 `orderBy=NUMBER ASC`，不依赖 API
没有承诺的默认顺序（仓库挂两个看板时，靠默认顺序可能每轮换一个看板且毫无迹象）。每轮日志都会写明实际用的是哪个：
`Project 优先级：读到 12 条（看板 7 board7，字段 Priority，source=both）`。

</details>

<details><summary>⚠️ 读 Project 需要的权限</summary>

Projects v2 只有 GraphQL 接口。

- classic PAT 必须勾 **`read:project`**（在 <https://github.com/settings/tokens> 上给现有 token 补勾即可，不用换 token）
- **个人名下**的 Project（`github.com/users/<你>/projects/N`，不是组织的）还要求这个账号是该 Project 的协作者——bot 账号默认不是
- 不想动 bot 的权限，就用 `PROJECT_GH_TOKEN` 单独塞一个只读看板的 token

任何一环读不到，daemon **只记一条警告并在本轮回落到 label 排序**，不会停下派工：

```
⚠️ Project 优先级读取失败，本轮回落到 label 排序：{"errors":[{"type":"INSUFFICIENT_SCOPES",...
```

补好 scope 后下一轮日志会变成 `Project 优先级：读到 N 条（字段 Priority，source=both）`。

</details>

## 按模型派工的标签

`pending/agent` 用 worker CLI 的默认模型派工；`pending/agent/fable` 让本次派工切到 Claude Code，并追加 `--model fable`（即
`FABLE_MODEL`，别名会解析成最新的 Fable 版本）。这个覆盖只作用于本次派工，issue、PR、全新 session 和 resume session 都支持，
不改项目默认 worker。两个标签同时存在时 `pending/agent/fable` 优先。

<details><summary>续接 Claude 会话用哪个模型</summary>

没有指定模型时，续接 Claude 会话也会显式带 `--model`：只跑 `claude --continue` / `--resume <id>` 会沿用会话**当初**的模型，
长期开着的 issue 就永远换不到新的默认模型。daemon 直接问 Claude「现在新开一条会话会用哪个模型」：续接前在 worktree 里、带同一份
`CLAUDE_EXTRA_FLAGS` 跑一次 `claude -p --no-session-persistence --strict-mcp-config --output-format stream-json`，从第一行
`system/init` 读出模型后立刻杀掉。探测时 `ANTHROPIC_BASE_URL` 指到本机不监听的端口，不会有 API 请求发出去。所以配置优先级
（环境变量、managed、`--settings`、git worktree 的本地配置、`--setting-sources`……）用的是 Claude 自己那套，这里不复刻。

</details>

<details><summary>什么时候不追加模型、探测的代价</summary>

- `CLAUDE_EXTRA_FLAGS` 里已有 `--model`，或拆不开（引号不配对）→ 不探测、不追加。
- 探测收到的参数必须跟 worker 从 bash 拿到的逐个相同。这串参数绝不 `eval`，用白名单拆词：只接受 bash 拆法确定的写法——
  不加引号的 `[A-Za-z0-9-_=+.,:/@%]`、单引号、不含 `$` / 反引号 / 反斜杠的双引号、词首的 `~` / `~/…`（展开成 `$HOME`）。
  引号外出现其他字符——`\`、`$`、反引号、通配符、花括号、`;&|<>()!#`、非词首的 `~`、`~user`——一律不探测、不追加（日志记一条）。
  测试里拿接受的写法跟 bash 自己的拆法逐个对比。
- 时限只用 bash 自带功能（不依赖 macOS 默认没有的 coreutils `timeout`）；探测进程不理 TERM 时，再等 2 秒补 KILL。
- 探测失败（`CLAUDE_MODEL_PROBE_TIMEOUT` 内没读到 `init`，默认 20 秒；找不到 `claude`）→ 不追加，会话保持原模型，poll 日志里会记一条。
- 每次续接多 3–4 秒，项目的 `SessionStart` hook 会多跑一次。如果你在 settings 里自己设了 `ANTHROPIC_BASE_URL`（或用
  Bedrock / Vertex），探测的请求挡不住：读到 `init` 就会被杀，但可能已经发出一个请求。

</details>

<details><summary>活着的会话、重启与 self-heal</summary>

- 新评论到达时会话仍活着的，走注入 prompt，模型不变，直到这个会话重启。
- daemon 会把选中的 worker 和模型记录在 tmux `@worker_agent` / `@worker_model`，并把模型写入 `state.json`。如果现有 idle
  session 的 worker 或模型不同，会重启并以指定组合 resume。
- worker crash 后 self-heal 会恢复到同一个模型专用 pending 标签。

</details>

## 等前置：`pending/blocked`

worker 的活卡在**别的 issue / PR** 上（而不是卡在要人拍板）时，登记前置、挂 `pending/blocked`，不再翻
`pending/human`；前置全部完成后 daemon 把它放回队列。默认开启：配置里没有 `LABEL_PENDING_BLOCKED` 这一行
= 用 `pending/blocked`；写成空值（`LABEL_PENDING_BLOCKED=""`）= 关闭。

<details><summary>标签本身</summary>

仓库里还没有这个标签也能用——第一次挂上时 GitHub 会自动建出（灰色、无说明）；重跑 `setup.sh` 不会改已存在
标签的颜色，要改在仓库的 Labels 页面改。

</details>

<details><summary>daemon 每轮做什么</summary>

daemon 每轮看挂着这个标签的条目：

| 前置的情况 | daemon 做什么 |
|---|---|
| 全部完成（issue 以「已完成」关闭、PR 已合并） | 留一条说明，摘标签，加回标记里写的触发标签（默认 `pending/agent`），下一轮派工 |
| 有一个以别的方式收场（关成不做 / 重复 / 没写原因、PR 没合就关、读到 404） | 评论写明是哪个，翻 `pending/human` |
| 互通名单里别的仓库的前置读不到：404 / 410（不存在、已删除，或私有仓库轮询令牌无权读——GitHub 对后者也回 404），或不是限流的 403 | 评论写明是哪个、怎么给令牌加读权限，翻 `pending/human` |
| 找不到前置，或前置在互通名单（`TRUSTED_REPOS`）外的别的仓库 | 评论说明（含怎么把仓库加进名单），翻 `pending/human` |
| 还有没完成的 | 什么都不做 |
| 读不到 GitHub（报错、缺字段；别的仓库还包括限流、网络失败、5xx） | 什么都不做，下一轮再看——绝不当成「已完成」 |

</details>

<details><summary>前置从哪来</summary>

两处取并集：

- issue 侧栏 Relationships 里的「Blocked by」（GitHub 只接受 issue 当前置，设 PR 报 422「Target issue may
  only be an issue」）；
- 最近一次摘掉这个标签之后、由 loop 写入账号或维护者（`OWNER` / `MEMBER` / `COLLABORATOR`）发的最新一条隐藏标记
  `<!-- agent-blocked-by: #12 OWNER/REPO#N resume=pending/agent -->`。「之后」是严格晚于：GitHub 的时间只到秒，
  和摘标签同一秒的登记分不出先后，按上一轮的算、不认。

`#12` 是本仓库，`OWNER/REPO#N` 是别的仓库，见下文（写成本仓库自己的全名、不论大小写，等同 `#12`）。
「等 #12」这种普通文字不认。`resume=` 必须是本项目配置的触发标签之一，否则用默认那个。

挑哪条登记的规则在 `_lib.sh` 的 `blocked_mark_pick` 里；桌面客户端的依赖图按同一套规则读这条登记来画线（两边用
同一份样例对拍），只是客户端不知道 loop 写入账号是谁，只认 `OWNER` / `MEMBER` / `COLLABORATOR` 写的登记。客户端
设置里的「等前置的标签」要和这里的 `LABEL_PENDING_BLOCKED` 一致。

</details>

<details><summary>别的仓库的前置</summary>

配了互通名单 `TRUSTED_REPOS` 时，标记里可以写 `owner/repo#N`，「Blocked by」里那个仓库的条目也认；daemon 读那个
仓库里的状态，完成口径和本仓库一样。裸 `#N` 永远指本仓库，本仓库同号的条目不会触发它。名单外的仓库交人，评论
写明怎么把它加进名单——名单为空时所有 `owner/repo#N` 都走这条。别的仓库只用轮询身份读、daemon 从不往那边写；
私有仓库要轮询令牌有读权限，否则它回 404，条目交人、评论写明是哪个前置、令牌缺什么权限。

托管 PR 写 `Closes #N`，合并即关 issue，等一个托管 issue 就是等它合并；只有正文写 `Refs #N` 的托管 PR，issue
合并后留着、等人验收关闭，想在代码合并时就接着做，前置写那个 PR。

</details>

<details><summary>交人之后怎么恢复等待、怎么叫停</summary>

**交人之后怎么恢复等待**：daemon 的评论里写了步骤——改前置（「Blocked by」里去掉失败的那个、加上新的，等 PR
就发一条新登记），**摘掉 `pending/human`**，重新挂 `pending/blocked`。`pending/human` 还在时 daemon 按叫停处理，
永远不会自动继续。

**叫停**：加 `pending/human`（或任何流程标签——`doing/agent`、`pending/PR`、`pending/review`、触发标签……），
daemon 就不碰它。手动打触发标签照常派工，派工时摘掉 `pending/blocked`。greedy 兜底、self-heal、托管的「只挂托管
标签就派」都跳过它。

</details>

<details><summary>写之前的复核与重试</summary>

写之前全部重读、再判一次；有任何不同（新前置、标签摘了又挂、加了 `pending/human`、前置被重开）本轮就不写。
进度记在 `state.json` 的 `blocked_resume`（只在功能开启时写），翻标签失败后重试不会重复评论；连续失败
`BLOCKED_MAX_TRIES` 次就放弃、记日志，条目留在 `pending/blocked` 上等人处理。

</details>

<details><summary>时间与限制</summary>

有条目在等时，轮询间隔最长 `BLOCKED_RECHECK_SECS`（300 秒），前置完成后通常 7 分钟内接上。**第一次发现**新挂上
的条目仍按空闲退避：项目安静了一周时，手动挂上的标签最长约 30 分钟才被看到（worker 自己挂的，项目刚活跃过，
1 分钟内就看到）。`rm poll-pace.json` 立刻回到全速。

「已合并」不等于「本机已部署」：前置是 loop 自身的改动时，被叫回来的 worker 先核对本机部署版本再用。不支持：
github.com 以外的前置、环形依赖检测（互相等的两条都一直等）。

</details>

## 暂缓：`pending/later`

给人决定「暂时不做」的条目用：挂着它的条目 daemon 不会自己捞去开工，但打了派工标签照常派。默认开启：配置里
没有 `LABEL_PENDING_LATER` 这一行 = 用 `pending/later`；写成空值（`LABEL_PENDING_LATER=""`）= 关闭。重新开工时，
人摘掉 `pending/later` 就行（greedy 模式下一轮就收），或直接打 `pending/agent`；daemon 不会自己摘它。

<details><summary>daemon 怎么对待暂缓的条目</summary>

| 条目 | daemon 做什么 |
|---|---|
| 只挂着暂缓标签（greedy 模式下的兜底趟） | 跳过，不派工 |
| 挂着托管标签 + 暂缓标签（托管的「只挂托管标签就派」） | 跳过，不派工 |
| 挂着暂缓标签，又有人打了派工标签（`pending/agent` 等） | 照常派工——它只挡自动捞取，派工标签是明确的「开干」 |

它不是「等人处理」：客户端顶栏「等人处理 N」不数它；因为挂了标签，它也不再出现在客户端的「未处理」里。

</details>

<details><summary>建标签、找暂缓的条目</summary>

**建标签**：把这一行写进配置后重跑 `setup.sh`，它会按配置建标签；或在仓库的 Labels 页面手动新建。

**找暂缓的条目**：

| 想看什么 | GitHub 仓库 Issues 页面 | GitHub Project 视图 | 桌面客户端 |
|---|---|---|---|
| 暂缓的 | `label:pending/later` | `label:pending/later` | `label:pending/later` |
| 进行中、排除暂缓的 | `is:open -label:pending/later` | `is:open -label:pending/later` | `is:open -label:pending/later` |

</details>

## 自动把 issue / PR 加进 GitHub Project（可选，**默认关闭**）

每轮守护程序把本仓库的 issue 和 PR 补进你列出的 GitHub Project——GitHub 免费版每个 Project 只能开 **1** 条「自动加入」规则、
每条只盯 **1** 个仓库（[官方说明](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/adding-items-automatically)），
想让多个仓库汇总到同一个看板就用它。配置留空即关闭；要开就在每个仓库自己的配置里写：

```bash
AUTO_ADD_PROJECTS="myorg/4 myorg/11"   # 「组织或用户名/编号」，空格或逗号分隔
```

<details><summary>哪些条目会被加进去</summary>

| 条目 | 加不加 |
|---|---|
| 开着的 issue / PR（不管多老） | 加 |
| 已关闭 / 已合并、**新建时间晚于**这个 Project 第一次开始同步（例：守护程序停机期间新建又关掉） | 加 |
| 开始同步前就已关闭，之后有人评论 | 不加 |
| 老条目被重新打开 | 加（它又是开着的了） |
| 已在看板里（含已归档卡片） | 不发写请求 |

组织 / 用户名和 GitHub 一样不分大小写：`MyOrg/4` 和 `myorg/4` 是同一个看板、共用一份同步进度，改写法不会让它从头再来。

</details>

<details><summary>只加不删：手动拿掉的卡片可能被加回</summary>

只加不改：不改字段、不移除卡片。**它不记得谁被手动拿掉过**：已经同步过的看板看的是「上次同步前 10 分钟之后有更新」的条目，
所以手动拿掉的卡片在两种情况下会被加回：那个条目之后又有了新动静；或者它本来就在这 10 分钟里更新过（这段重叠是为了不漏掉
轮询进行中发生的更新）。更早的条目不会动——新加的看板做首次全量时，也不会把它们塞回已经同步好的看板。**没有单个条目的排除办法**：
关掉条目不能让它不进看板——看板开始同步之后才新建的条目，关闭 / 合并后仍是候选（停机期间新建又关掉的条目正是靠这一条补进来的）。
从 `AUTO_ADD_PROJECTS` 里去掉某个看板，会停掉这个看板的**全部**自动加入，不是只排除一个条目。

</details>

<details><summary>权限</summary>

读走 `PROJECT_GH_TOKEN`（没配用 `GH_TOKEN`）；加入是写操作，走 `WRITE_GH_TOKEN`（没配用 `GH_TOKEN`），写身份需要 classic PAT
的 **`project`** 权限，或 fine-grained 对该 Project 的写权限。读身份看不见某个 Project 时，不往它写任何东西——否则每个条目都会
显得「不在里面」、每轮全量写一遍。

</details>

<details><summary>出错处理、状态文件与请求量</summary>

配错的项（`foo`、不存在的编号）、读失败、写失败都只记**一行**警告（内容变了才再记），下一轮重试；派工和清理不受影响，各 Project
互相独立：新加的看板首次全量读失败，不会拖住已经同步好的看板。

```
⚠️ 自动加入 Project：myorg/11：写入失败（写身份需要能写这个 Project）：issue #12 加不进去：Resource not accessible by personal access token，同步时间不推进，下一轮重试
自动加入 Project：myorg/4 已加入 3 条
```

状态在 `$STATE_DIR/project-auto-add.json`（每个 Project 一项，故意不放进 `state.json`）：第一次开始同步的时间、首次全量是否完成、
上次完整成功同步的时间。第一次开始同步的时间在第一次尝试时写下、之后不变。删掉这个文件 = 所有 Project 从头开始（「新建时间晚于」
的分界随之挪到现在）。请求量：没什么改动时每轮多 1 次合并读取；多配一个 Project 不会翻倍。

</details>

## 交叉 review 关卡（可选，**默认关闭**）

worker 的代码先由另一个 agent 复审，再交到人手上。默认关闭：不配 `LABEL_PENDING_REVIEW` 就完全
不存在这一环，自带的 prompt 模板里一个字都不提 review。配了才启用：worker **产出代码**时不再直接翻
`pending/human`，而是翻到该 label；daemon 用 `REVIEW_WORKER_AGENT`（默认 `codex`）+
`prompts/review.template.md` 起一个独立 session 把关。通过 → `pending/human`；不通过 → 带具体意见
打回 `pending/agent`。留空即关闭。

<details><summary>流程图</summary>

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

</details>

<details><summary>「等人」有两种状态</summary>

靠标签组合区分：

| 标签 | 含义 | 人该做什么 |
|---|---|---|
| 只有 `pending/human` | 审过了，产出可以验收 | 验收 / 合并 |
| `pending/review` + `pending/human` | 轮次烧光，两个 agent 没谈拢 | 看汇总评论，自己拍板 |

第二种状态下 **daemon 完全不派工**（不管它在队列里排第几，`poll.log` 会写明跳过原因）。
人手动摘掉 `pending/human` 就是说「按我说的接着审」：那次 `unlabeled` 事件会把 reviewer
的「最近一次人工动作」时间戳推到最新、轮次计数归零，下一轮恢复正常 review。

</details>

<details><summary>设计方案也过复审：<code>REVIEW_DESIGN_PROPOSALS</code></summary>

设计方案要不要也过复审，另有一个开关 `REVIEW_DESIGN_PROPOSALS`（默认 `false`）。关着时只有代码产出
过复审，写完方案 / 修订方案直接翻 `pending/human`；设成 `true` 并且配了 `LABEL_PENDING_REVIEW` 时，
方案改翻复审标签，审过才到你面前。只设开关、没配复审标签时照样交人。澄清答复、提问不受它影响。

项目自己在 `new-issue.extra.md` / `issue-comment.extra.md` 里写了「方案翻 `${LABEL_REVIEW_OR_HUMAN}`」
的做法，开关开或关都照常先审——追加要求排在通用模板之后、冲突时以它为准，而
`${LABEL_REVIEW_OR_HUMAN}` 的取值和这个开关无关。想从这种做法换成开关：先部署带这个开关的版本，再在
每台跑这个项目的机器上打开开关，最后才删追加要求里那句；顺序反了，方案会有一段时间直接交人。

</details>

<details><summary>复审怎么审</summary>

- **reviewer 拿的是全新上下文**，看产出而不是看实现者的自述——这才是第二双眼睛的价值
- **拦「代码产出」和「设计方案」两类**，各用各的清单。设计方案审的是根因是否成立、
  Design 能否解决它、验收标准是否可验证——此时没有代码是正常的，reviewer 不该因此判不通过
  （拿审代码的尺子去量一份只有方案的 issue，只能报「没有可 review 的实现」）
- **方案复审不通过 = 「改方案」，不是「去实现」**。打回落到 `pending/agent`，跟人说
  「方案 OK，开干」共用一条队列，所以 reviewer 必须在评论里写明是哪一种——否则下一轮
  worker 会直接去实现一份人从没确认过的方案
- **未勾选的选择题不是缺陷**。约定是勾 1 项 = 拍板、都不勾 = 走默认项、多勾 = 想再讨论，
  所以「人还没勾」本身就是一个决定。reviewer 把它读成「缺少人工确认」，打回的是本来
  已经可以走的活；它该审的是默认项选得对不对
- 其余纯文字出口（提问、反问、受阻停机、安全停机）仍直达 `pending/human`，
  否则「我有个问题想问你」也要白烧一次 review、还拖慢你被问到的速度
- **复审结论评论的标题第一个字就是结论**：通过写 `## ✅ …`，其余（退回、轮次用尽交人、
  与主干冲突、检查没跑成交人）一律 `## ❌ …`，手机通知列表里扫一眼就知道

</details>

<details><summary>轮次上限：<code>REVIEW_MAX_ROUNDS</code></summary>

`REVIEW_MAX_ROUNDS`（默认 6）唯一的作用是防两个 agent 互相打回烧 API，所以**人显式要的 review 不受它
约束**：人手动挂 review 标签 → 无视上限；人留了评论 → 计数从那条评论之后重算、自然归零。判定靠比对
actor 与 `gh api user` 的账号，不需要揣摩评论文字的意图。轮次不存 state.json，数的是 issue/PR 上
「最近一次人工动作之后」的 `<!-- codex-review-round -->` 标记：看板上看得见、state 丢了不会重置。

</details>

<details><summary>标签与 self-heal</summary>

- **打回必须用默认的 `pending/agent`**，不是 review label 自己——模板里用
  `${LABEL_PENDING_AGENT_DEFAULT}` 占位符拿这个值。用错就是死循环
- self-heal 靠 `state.json` 的 `worker_trigger_labels` 把死掉的 session 送回**原来那条队列**；
  只按 model 反推做不到这点（review 关卡换的是 agent 不是 model）

</details>

### 复审收敛：首轮一次报全，之后只复核修复

复审第 1 轮把问题全部列出，第 2 轮起只核对这份清单和修复本身，不再从头审一遍。开了复审关卡就总是生效：
复审的说明里总会多这一段（`prompts/review-converge.md`，由拼 prompt 的公共步骤追加，整份替换了复审模板的
项目也收得到）。

<details><summary>全量轮、复核轮与判断顺序</summary>

- **全量轮**——最近一次人工动作之后的第 1 轮，或任何算不出基线的轮次：需求、diff（方案就是全文）、测试、
  文档一次过完，问题全部列出、编号（「问题 1」「问题 2」…，之后各轮沿用；不写 `#1`，GitHub 会把它链到 1 号 issue；
  之前用 `#N` 写的清单当作问题 N 照常核对）。
- **复核轮**——第 2 轮起、基线可用时：清单逐条核对（改好 / 没改好 / worker 给的不改理由成立否），**修复本身**
  里的新问题照常编号、可以打回，照拦关卡仍对整个 PR 照查。
- **每个问题一条判断顺序**，停在第一个给出结果的一步：① 照拦——检查有失败或被取消的行、与主干冲突、违反
  适用的硬规则、突破安全边界、会删 / 写坏数据（任何项目规则都不能降级）；② 定级——依次看项目的复审附加
  说明 → `REVIEW.md` → 工具默认分界（行为 / 数据 / 测试错 = 必须改；措辞、命名、可读性 = 建议），建议一律
  不打回，列进折叠块；③ 全量轮或落在修复范围内 → 打回；④ 复核轮在修复范围外迟到的「必须改」→ 普通条目
  写进「需要人注意」、不打回（人合并前决定）；托管条目打回——daemon 合并前没人看这条提醒。
  复审模板里本来就写明「判不通过」的条目（硬规则、拍板问题里出现代码名字、用「你」「我」指代参与方、交人评论的
  版式各项、冲突、方案审查各点）一律是「必须改」，不会被定成建议；worker 这一轮写的评论、方案和 PR 正文总在
  审查范围内，所以这些在第 ③ 步打回，走不到第 ④ 步。
- 轮次标记格式不变（周报按它认复审评论）；下一行是隐藏的基线标记，下一轮据此算修复范围（只认结论评论的
  第一、二行，别处引用的旧标记不算）：
  `<!-- review-baseline: code head=<sha> base=<分支> -->` 或
  `<!-- review-baseline: plan comment=<id> sha256=<指纹> -->`。

</details>

<details><summary>「修复本身」是哪些改动：<code>review-scope.sh</code></summary>

「修复本身」是哪些改动由 `scripts/review-scope.sh`（托管安装走 `entrypoints/review-scope.sh`，只读）算出。
它读派工账号最近一条复审结论里的基线，从上往下判、停在第一条命中的：

| # | 代码 | 输出 |
|---|---|---|
| 1 | 最近一次人工动作后的第 1 轮 | `full first-round` |
| 2 | 读评论 / 读 PR 失败 | `full read-failed` |
| 3 | 没有基线标记，或格式不符 | `full no-baseline` |
| 4 | PR 的目标分支与基线里的不同 | `full base-changed` |
| 5 | 拉取失败，或上轮审过的提交取不到 | `full baseline-missing` |
| 6 | 上轮审过的提交不是本轮提交的祖先（变基 / 强推） | `full history-rewritten` |
| 7 | 与目标分支的分叉点算不出 | `full read-failed` |
| 8 | 「上轮审过的提交 + 分叉点」合成时冲突（PR 本轮手工解决了与主干的冲突时也是） | `full merge-conflict` |
| 9 | 合成出别的错 | `full read-failed` |
| 10 | 合成的树与本轮提交比较失败 | `full read-failed` |
| 11 | 没有差异（只同步了主干，或没有新提交） | `scope 0` |
| 12 | 有差异 | `scope <文件数>` + 差异全文 |

合成的树是 `git merge-tree --write-tree <上轮审过的提交> <分叉点>`：上一轮复审看到的内容，加上此后主干带进来
的改动，所以单纯把 `main` 合进分支不算修复本身。

设计方案：第 1 轮、读不到评论、没有基线 → 全量；上一版方案评论被删（`deleted`）、此后被原地编辑过（`edited`）、
就是本轮这条（`same-comment`）、任一条不是派工账号自己发的（`not-own`）或不在本条 issue 下（`not-this-issue`）
→ 全量；否则 `scope` 加上一版到这一版的全文差异。命令只输出本条 issue 下派工账号自己发的文字（受保护的读取
命令对这类评论也是原样显示）；托管条目上别的内容仍只经受保护的读取命令读。方案模式还输出本轮这条评论的
`current sha256=<指纹>` 和全文，两者出自同一次读取——复审审的就是印出来的这份全文，指纹对应的就是复审看到的
版本；基线只经 `review-scope.sh fingerprint <id> --issue <N> --expect <这个指纹>` 写：审阅途中评论被改过就拒绝
（退出码 3），那一轮不写基线、下一轮全量。

托管条目又开了外部内容保护（`AUTOPILOT_OUTSIDER_GUARD`）时，本条的评论只经受保护的读取命令读，复审说明里
干脆不带方案模式：方案复审每轮全量，不写方案基线。代码模式在这类条目上也不读评论：复审从受保护读取命令的
输出里抄下自己上一条结论的第二行，用 `--baseline-mark '<那一行>'` 交给命令；受保护读取成功、但找不到这一行
（或格式不对），本轮全量；受保护读取本身失败不算「没有基线」，照外部内容保护的规则重试一次，仍失败就交人
并写明报错，不按全量继续审。其他条目上代码模式读评论列表只为找这一行，不把任何评论文字输出给复审。

指纹用 `sha256sum` 或 macOS 的 `shasum`（`scripts/_sha256.sh`，和配置指纹共用一份），两个都没有就是
`full read-failed`。没输出、退出码非 0、第一行认不出 → 一律按全量。

</details>

<details><summary>项目自己的复审标准：<code>REVIEW.md</code></summary>

项目可以在仓库根目录放一份 `REVIEW.md`，写本项目复审重点看什么、什么算必须改、什么只算建议、哪些不用提。
daemon 和读项目 prompt 文件一样从 `origin/<base>` 读它，结果分三种：

| 主干上的 `REVIEW.md` | 复审 prompt | worker prompt（新 issue、issue 回复、PR 回复、拆出来的子 issue） |
|---|---|---|
| 有 | 追加全文 | 各追加一句指向它 |
| 确认没有 | 什么都不加 | 什么都不加 |
| 读不到（远端引用不在、读目录出错、不是普通文件） | 写「REVIEW.md 未能读取：按全量复审，不放宽任何标准」 | 写「未能读取」 |

不回落去读主 checkout 里的本地副本。本仓库自己的 `REVIEW.md` 装的是测试证据的要求，`review.extra.md` 只留
评论怎么写。

</details>

## 托管标签（可选，**默认关闭**）

托管让维护者给某个 issue 打一个标签，就把它从方案、代码、复审到合并整个交出去：每一步由独立复审把关，固定条件都满足时
daemon 自动合并。默认关闭：配 `LABEL_AUTOPILOT`（例如 `autopilot`），同时开着它必需的复审关卡 `LABEL_PENDING_REVIEW`
即开启；把 `LABEL_AUTOPILOT` 留空即关闭（见[怎么整体关闭托管](#怎么整体关闭托管)）。没打标签的 issue 不受影响；从没开过
托管的项目，`LABEL_AUTOPILOT` 留空时一切照旧。

<details><summary>流程图</summary>

```
issue：autopilot ──> 写方案 ──> pending/review ──通过──> pending/agent ──> 写代码 + 开 PR
                                     │不通过（改方案）                               │
                                     └───────────────────────────────────────────────┘
PR：  pending/review ──通过 + 测试记录──> pending/merge ──daemon 检查──> 合并
                                               │ 检查没过 / 冲突 ──> 交回 worker
                                               └ 其他不对 ────────> pending/human
```

</details>

<details><summary>开工、方案阶段与代码阶段</summary>

- **开工**：只打托管标签就行——挂着它、没有任何状态 / 触发标签的 issue，当作打了 `pending/agent` 派工。它是「模式标签」
  不是触发标签：daemon 从不摘它，看板上一直看得见。
- **方案**：照常写、照常发到 issue，选择题按默认项，一律送复审（不管 `REVIEW_DESIGN_PROPOSALS`）。方案复审通过后 issue
  翻回 `pending/agent`，worker 直接开干。
- **代码**：复审通过时 PR 翻 `LABEL_PENDING_MERGE`（`pending/merge`）而不是 `pending/human`，并在结论评论里留一行测试重跑的
  机器记录：`<!-- autopilot-review-pass head=<sha> passed=<n> failed=<n> -->`。
- **交回 worker** 按 PR 计次，上限沿用 `REVIEW_MAX_ROUNDS`。
- **叫停**：摘掉 issue 或 PR 上的托管标签，或在 issue / PR 上打 `pending/human`。检查之后、合并之前的叫停由合并前的重读拦住。

</details>

<details><summary>PR 上也挂一份标签</summary>

托管 issue 开出绑定它的 PR 之后，daemon 把托管标签复制到这个 PR 上（每轮检查，写失败下一轮再补）。PR 列表上就看得出
哪些 PR 会被自动合并，也能直接在 PR 上摘标签叫停。issue 上那个保留：它才是授权。

- PR 上这份由 loop 的写入账号打，**永远不算授权**：不触发接手、不引出「托管标签不生效」说明，worker 自己往 PR 上打也没用。
- 补和收回都判两次，第二次紧挨着写、全部现读（PR 是否打开 / 已合并、最新提交、目标分支、来源仓库 / 分支名、绑定的 issue
  和它的状态、两处的 `pending/human`、授权所依据的那次打标签，收回时还有副本那条打标签记录），任一项变了或读不到，本轮不写。
- 授权明确不成立之后（issue 或 PR 上摘了标签、issue 关了、PR 不再绑定……）daemon 把**自己补的那份**收回；维护者亲手打在
  PR 上的从不动。
- 绑 issue 的 PR **没挂这个标签就不合并**：算一轮判不了，连续 `AUTOPILOT_UNKNOWN_MAX` 轮补不上就交人。
- 只管本机负责的 PR（和合并那一步同一条规则）。关掉托管之后，已经补到 PR 上的标签不清理（不起任何作用，想摘就手动摘）。

</details>

<details><summary>拆成子 issue</summary>

拆分计划和方案一样只过复审，复审通过后 worker 直接建子项。复审额外审「真需要拆吗」和「父 issue 还留着子项以外的活吗」
（托管时收尾也要落成子项）。

- 本工具拆出来的子项——GitHub 上真挂在父 issue 下、正文带指向父 issue 的拆分标记、由 loop 的写入账号建——**继承父 issue
  的托管**：子项和它的 PR 上都不用挂托管标签。
- 派工、接手、PR 补标签、合并前许可都把父 issue 当作第三处，和 issue / PR 两处用同一条判据（停止线取三处所有「摘掉」里
  最晚的一次，授权来自晚于停止线、维护者亲手打的那一次）。
- 父 issue 摘标签、打 `pending/human`、关闭，整组子项一起停；只停一个子项就在那个子项上打 `pending/human`。
- 读不到父 issue / 它的标签记录 = 判不了：本轮不派工、不写任何东西，下轮再判（不按普通流程派出去）。
- 子项全部关闭后父 issue 翻 `pending/human`，由人关闭。

</details>

<details><summary>合并之后：issue 关闭，挂 <code>pending/human</code> 提醒人看</summary>

托管 PR 的正文写 `Closes #N`，合进默认分支时 GitHub 关掉 issue，等它的下游条目（`pending/blocked`）随之开工。合并后 daemon
在 issue 上发一条说明——外面一句话结论和「要人做什么」，背景 / 采用的方案 / 排除的方案和原因照搬 worker 写在 PR 正文里的
总结段（`<!-- autopilot-summary:begin -->` 到 `<!-- autopilot-summary:end -->`），合并依据折叠在最后——然后给已关闭的
issue 打 `Done`、挂 `pending/human`、摘 `pending/PR` 等流程标签。

- **看过满意**：人**只摘掉 `pending/human`**（`Done` 留着；关闭之后挂上过、又被摘掉的提醒，daemon 按事件记录认出来，不会加回）。
- **要返工**：重开 issue → 摘掉 `Done` 和 `pending/human` → 打 `pending/agent`。
- 合并时 GitHub 还没关掉 issue 就下一轮再看；人在交接之前重开了 issue，按「issue 留着」那一套走（下一个折叠块）。
- 交接一次只写一个标签，每写一个之前现读 issue 和它的事件记录判定两次，写完一步回来，状态、标签集合、最后一次关闭和最后
  一次挂上 `pending/human` 的位置必须正好是「上一次 + daemon 刚写成的这一步」（事件只能多出 daemon 这一步自己的那一条），
  否则本轮停手；读不到下轮再试，说明按标记去重。

**关闭清扫留着关闭之后挂上的提醒。**「已关闭（已完成）的 issue 打 `Done`、摘掉流程标签」那一趟看 issue 的事件记录——
`pending/human` 最后一次「加上」排在最后一次「关闭」之后，就是关闭后的提醒，不摘；排在关闭之前的（人在 `pending/human`
状态下直接关掉）照常摘掉。

- 先后按事件在记录里的顺序比，不比时间（合并关 issue 和挂提醒常在同一秒）。
- 每个已完成关闭的 issue 都要读这份记录（挂不挂 `pending/human` 都一样）；记录读不到、缺编号、和现状对不上（没有关闭事件，
  或记录推出的状态——最后一次是关闭还是重开、提醒最后一次是加上还是摘掉——和现在读到的对不上），本轮不写、留队下轮再判。
- 清扫同样一次只写一个标签、每写一个之前判两次、写完一步核对依据：判定之后人重新挂了提醒或重开了 issue，本轮停手、不按
  旧结论接着写，这一轮里也不再碰这个 issue（同一轮后面的重试也不接手），下一轮从头再判——只要这一轮没收尾成功（读不到、
  对不上、写失败）都是这样。

**怎么找要看的条目：**

| 想看什么 | 仓库 Issues 页面 | GitHub Project 视图 |
|---|---|---|
| 要人看的（含合并后已关闭的） | `label:pending/human` | `label:pending/human`（不写 `is:open`） |
| 还在进行的 | `is:open` | `is:open` |
| 进行中 + 要人看的 | `is:issue (is:open OR (is:closed label:pending/human))` | 写不出（不支持跨条件的「或」和括号） |

桌面客户端搜索框的默认条件 `-Status:done -label:Done` 会藏掉这类已关闭、带 `Done` 的条目，要从顶栏「等人处理」进；Project
视图的筛选写了 `-Status:done` 时同理，另存一个只写 `label:pending/human` 的视图。

</details>

<details><summary>只引用 issue 的 PR：issue 留着</summary>

正文只写 `Refs #N`、不写关闭关键词的托管 PR 照合，GitHub 合并时不关 issue。daemon 发说明后把 issue 翻 `pending/human`、摘
`pending/PR`，人看过满意就关闭（关成「已完成」照常自动打 `Done`），要返工就打 `pending/agent`。合进的不是默认分支（GitHub
不会按关键词关 issue）的 `Closes #N` PR 也走这一套。

- 合并之后、交接之前 issue 上已经挂了任何流程标签（派工、进行中、复审、等前置、等人……），说明新一轮已经开始，交接一个
  标签都不动、只补说明。
- 交接每次写之前现读 issue，状态或标签集合变了本轮不写；读不到下轮再试，说明按标记去重。
- 维护者手动合并的托管 PR 不特殊处理：和普通 PR 一样，`Closes #N` 带关的 issue 打 `Done`。

</details>

<details><summary>互通名单（<code>TRUSTED_REPOS</code>）</summary>

`TRUSTED_REPOS` 默认空：逗号分隔的 `owner/repo`。名单里的仓库

1. 可以当拆分子项的父 issue 所在仓库：父 issue 上维护者亲手打的托管标签授权本仓库的子项，打标签的人在**两个仓库**都要有
   写权限；
2. 可以当等前置的前置所在仓库（见下面「等前置」）。

跨仓库读不到（父 issue、标签记录、权限）一律判不了，本轮不写。名单外的仓库不认。

</details>

<details><summary>在已有的 PR 上打标签（接手）</summary>

已经开好的 PR，维护者直接在 **PR** 上打托管标签，daemon 就接手：PR 除托管标签外只挂着 `pending/human`（且授权打在它之后），
或一个流程标签都没有、PR 自己挂着托管标签时，翻到 `pending/review` 并在 PR 上说一句，之后走同样的复审 → 合并。PR 上的托管
只管「复审 → 合并」这一段，方案阶段只看 issue。

- 授权也可以来自 issue：PR 摘标交人之后，维护者只在 issue 上重新亲手打托管，同样会接手。
- 还挂着 `pending/agent` / `doing/agent` / `pending/review` / `pending/merge` 的 PR（哪怕同时挂着 `pending/human`）一律不接手：
  那是正在进行的工作，下次派工自然带上托管规则。
- PR 上的标签不被认可（不是维护者打的、PR 不合条件、issue 已关、打标签那一刻的正文不合条件）时在 PR 上说一次原因。
- **判不了的接手**：接手要读的东西连续 `AUTOPILOT_UNKNOWN_MAX` 轮判不了（一轮的结论看这一轮最后一次判定，写前那次判不了
  也算），PR 交人（加 `pending/human`、留一条说明），只交一次。「要交人」先记成一条待办再动手；这个决定的唯一依据是
  「判不了」，所以每次动手前都用同一个接手判断现读重判：
  - 还判不了才接着做（加标签、留言，任一步失败或进程被杀下一轮接着做）；
  - 判得出结论了——维护者重新授权、PR 关闭 / 合并 / 改绑别的 issue / 转进别的流程、issue 关闭——待办作废，不写它的任何
    东西，改按现在的结论走普通接手流程。唯一的例外是标签已经由 daemon 为这条待办加上、只差说明，这时把说明补完。
  - 继续做的两种情况都要求 issue / 分支 / 来源和交人决定时一样；已经加过 `pending/human` 的待办，这个标签被人摘掉后就
    作废（不补说明，在接手判得出结论之前也不再交人）。
- **接手也判两次**：判定可接手后、写之前，同一个判断用现读的数据原样再跑一遍（issue 是否打开、需求来源、两处的叫停与授权
  记录，PR 的状态 / 提交 / 目标分支 / 来源 / 绑定都在内），结论或身份变了本轮不写。
- 判过「不接手」的 PR 按 PR 更新时间 + 绑定的 issue 编号 + 该 issue 的更新时间记下，三样都没变就不重读（打 / 摘标签会刷新
  更新时间）；合并前许可不走这个缓存。⚠️ 打标签的人在仓库里的**权限**变了不会刷新更新时间：被拒的 PR 要等 PR 或 issue 有
  任何变动才会重判。

</details>

<details><summary>没绑 issue 的 PR</summary>

跨仓库任务的配套 PR、不绑 issue 的 PR，维护者在 PR 上亲手打的托管标签本身就算授权，新开就打也算。daemon 把 PR 分三种：

- **绑 issue**：来自本仓库、分支正好是 `BRANCH_PREFIX<N>`、正文只关闭 `#N`——issue 和 PR 两处合起来判；
- **以 PR 为准**：来自本仓库、正文里**一个**本仓库关闭关键词都没有——`#N`、`owner/repo#N`（本仓库名，不分大小写）、
  `https://github.com/owner/repo/issues/N`、`GH-N` 这些写法都算关闭本仓库；只引用的 `Refs #N`、关别的仓库的不算——授权和
  叫停都只看 PR：PR 上摘托管标签或打 `pending/human` 就叫停，任何 issue 上的标签都不借给它，分支名恰好和本仓库某个 issue
  同号也不看那个 issue；
- **不合条件**：其余的（写了关闭本仓库 issue 的关键词却没正常绑定、关闭写法有歧义、来自 fork）——不生效，PR 上说一次怎么改。

以 PR 为准时还要求**打标签那一刻的 PR 正文**也是这一种：

- daemon 读 GitHub 保存的 PR 正文修改历史（GraphQL `userContentEdits`），取修改时间不晚于打标签时间的最新一版（同一秒的
  几版和它之前那一版都要合条件；两边都是 GitHub 的时间，不受本机时钟影响）。
- PR 刚开就打、同一秒、之后正文又改过：历史最早那一版的时间等于 PR 的创建时间，就认它是开 PR 时的正文；不等（更早的版本
  缺了）算查不到。
- 所以正文关着某个 issue 时、或 PR 绑着 issue 时打的标签，正文改过之后不算，要维护者看过现在的 PR 再亲手打一次。
- 那一版被从历史里删掉 → 不生效、请重打；历史读不到或分页读不全 → 判不了，本轮不写。
- daemon 本机不为此记任何东西，换机器、状态文件丢失都不影响。

这类 PR 没有方案阶段，接手后从代码复审开始；接手、合并的说明都发在 PR 上。

</details>

<details><summary>外部需求机器人提的需求</summary>

授权照同一套，看谁打的托管标签，不看需求是谁提的。提需求方的确认一步不省：方案复审通过后照常叫醒机器人、等提需求方确认；
要先汇报的项目，提需求方认可 PR 最新提交后交复审，复审核对认可的提交、重跑测试再翻 `pending/merge`。两个功能都开时派工
提示词多一段「外部需求机器人提的需求 + 托管」写清这些，见[对接外部需求机器人 → 托管标签](requester-bot.zh.md#托管标签)。
等待标签被提前摘掉、之后没人打派工标签的条目，只挂托管标签也不自动开工、不被接手（[等待期间 daemon 怎么做](requester-bot.zh.md#等待期间-daemon-怎么做)）。

</details>

<details><summary>daemon 什么时候合并：检查项</summary>

daemon 合并（`PUT /pulls/N/merge`，带复审时的提交号，方式 `AUTOPILOT_MERGE_METHOD`，默认 `squash`）只在下表全部成立时进行；
合并后在 issue 上（没绑 issue 的发在 PR 上）留「已自动合并」评论，之后的清理 / `Done` / 复盘照常：

| 检查 | 不成立 → |
|---|---|
| PR 来自本仓库，并且要么绑 issue（分支正好是 `BRANCH_PREFIX<N>`，正文只关闭 `#N`，逐行和整段两种读法一致；或正文只引用一个 `Refs #N`、没有关闭关键词），要么正文一个本仓库关闭关键词都没有（以 PR 为准） | `pending/human` |
| 以 PR 为准时：授权只看 PR（下一行去掉 issue 那一处），而且打标签那一刻的 PR 正文（修改历史里那一版）也合上一行的条件 | `pending/human` |
| 授权：issue `#N` 或 PR 上**现在挂着**托管标签，那一处最后一次「加上托管标签」的操作人是 `User` 类型、有 `write` / `admin` 权限，且不是 loop 的写入账号、不是 `REQUESTER_BOT_ACCOUNT`；**并且这次加上晚于 issue 和 PR 两处所有的「摘掉」**（见下面「两处的标签怎么合起来算」） | `pending/human` |
| PR 自己挂着托管标签（绑 issue 的 PR 由 daemon 从 issue 复制过来，见上文） | 本轮判不了（连续 `AUTOPILOT_UNKNOWN_MAX` 轮 → `pending/human`） |
| issue 和 PR 都没被打 `pending/human` | `pending/human`（PR 上的 `pending/human`：只摘 `pending/merge`） |
| PR 最新提交**和目标分支**都是派复审时记下的那一对（同一提交改投别的分支 = 另一份改动；没记目标分支的记录算缺） | 回 `pending/review` 重审 |
| 复审的结论评论（写入账号、派复审之后发的）里有这个提交的测试记录，`failed=0`、`passed>0` | `pending/human` |
| 没改 `.github/`——配了 `AUTOPILOT_HUMAN_PATHS` 时是没改清单里的任何文件，见下 | `pending/human` |
| 这个提交上的检查（check run / commit status）全部通过（一个都没有 = 只靠上一条记录） | 没过 → 交回 worker；超过 `AUTOPILOT_CHECKS_TIMEOUT_HOURS`（6）还没跑完 → `pending/human` |
| GitHub 判定可合并（无冲突） | 交回 worker |
| 合并前最后一刻，**同一个许可判断用现读的数据原样再跑一遍**——上面每一行都在内，包括复审的测试记录（评论可以被编辑、删除）和自动检查（变红、重跑中、原本没有又冒出来）；两次都判「可以合」、且是同一个 issue / 提交 / 目标分支才合 | 本轮不合、不记任何状态 |

</details>

<details><summary>读不到的时候，以及交人怎么写</summary>

**读不到**（标签记录、权限、检查、文件、评论）：本轮不写任何东西；连续 `AUTOPILOT_UNKNOWN_MAX`（10）轮读不到才交人。
「读不到」绝不当成「有授权」「通过」「无冲突」。

**交人的每次写入之前都核对现状。**交人要连发三个请求——发说明 → 加 `pending/human` → 摘 `pending/merge`。daemon 先取一份
现状作基准（PR 是否开着、草稿、提交、目标分支、分支、来源、正文、全部标签，PR 标签记录里「这一次入队」和最后一次标签变动
的编号；绑定的 issue 和拆分子项的父 issue 的状态、标签、标签记录），把交人原因用现读的数据重新判一遍，再确认基准没变；之后
每次写入之前都再判一遍原因、再比一遍现状，只允许多出 daemon 自己刚确认过的那一次写入。维护者在中间关了 PR、动了任何标签、
推了提交、改了目标分支、把同一个提交重新送进队列，或在 issue 上撤销了叫停——daemon 本轮不再写，下一轮按现状重新判断。

- 交人不留本机待办：仍在合并队列的下一轮从头重判；同一次入队、同一提交、同一原因的说明已经在就不重发（说明末尾有一行隐藏
  标记），同一提交重新入队后旧说明不算。
- 说明发不出去就不翻标签，不会出现「挂了 `pending/human` 却没有说明」。
- PR 上同时挂着 `pending/human` 和 `pending/merge`（人叫停，或交人做到一半）：只摘 `pending/merge`、不留言；摘之前同样取
  基准、再比一遍。要让 PR 留在队列里，先摘掉 `pending/human`。
- 现状读不全（PR、issue、任一处的标签记录、评论读不到；响应缺字段或状态词不认识；标签记录缺编号，或和当前标签对不上）：
  本轮不写。所以「连续读不到到上限」那种交人，只在这些读得到时才写得出去（读不到的是改动文件、检查、权限这类时照常交人）；
  否则 PR 留在队列里每轮重试，不会被合并，日志里有原因。
- ⚠️ 消除不了的窗口：GitHub 没有「状态没变才写」的写法，最后一次核对开始读到写请求到达 GitHub 之间的操作 daemon 看不到。
  落在里面的最坏结果是已关闭 / 已被人接手的 PR 多一个 `pending/human` 或多一条说明，或刚重新排队的 PR 被摘掉
  `pending/merge`。它不会导致合并。

</details>

<details><summary>两处的标签怎么合起来算</summary>

停止线 = issue 和 PR 两处所有「摘掉托管标签」里最晚的那一次。授权只来自一次**晚于停止线**、由维护者亲手打的「加上」，
而且那一处现在还挂着。所以：

- 在任一处摘掉 = 叫停；之后维护者在任一处亲手重新打上 = 恢复
- 叫停之后 loop 账号、Bot、没写权限的人再打上，不算恢复，也不能借另一处叫停之前的旧授权复活
- 没摘过时，worker 在 PR 上打的标签不影响 issue 上已有的授权（它不是授权，也不是叫停）
- PR 上从没碰过托管标签时，结果和只看 issue 一样；每次判断多读一次 PR 的标签记录
- 两处的先后按标签记录的时间比；比不出（缺时间）算判不了
- 接手时和 PR 上的 `pending/human` 比先后，逐条看所有成立的授权：PR 上的按记录顺序比，issue 上的按时间比（同一秒不算在后）；
  只要有一条明确在后就接手，另一处同一秒的授权不会把它遮住

</details>

<details><summary>限制：最后的窗口、仓库规则、多台机器、账号</summary>

- **剩下的窗口**只在「最后这次读」到「合并请求到达 GitHub」之间。合并请求带着复审的提交号，这段时间的新推送 GitHub 会拒；
  这段时间检查变红则拦不住。要服务端兜底，把这些检查设成目标分支的「必须通过」（分支保护），daemon 不绕它。
- **GitHub 拒绝的**（分支保护要求人工批准、合并方式没开）交人——daemon 不绕仓库规则。
- **多机**：复审的提交号只记在派复审的那台机器上，`SELFHEAL_ONLY_OWN_WORKERS=true` 时另一台的**合并那一步**不碰这个 PR；
  但普通派工和复审不看归属，所以托管的仓库只该有一台机器在轮询（见[只在一台机器上跑这个仓库的轮询](#只在一台机器上跑这个仓库的轮询)）。
- **两个账号**：loop 的写入账号和维护者必须是两个账号，否则任何标签都算不上维护者打的（worker 和复审都用写入账号写 GitHub）。
- **本仓库会部署自己**：`GigleAI/cavil-loop` 的 `main` 合并后几分钟内就在 daemon 上生效，在这里开托管意味着自动合并的改动会
  无人经手地改掉正在运行的 daemon。要不要在本仓库开是单独、慎重的决定。

</details>

<details><summary>状态存在哪</summary>

状态在 `state.json` 的 `autopilot` 下：

- `prs.<n>`：复审的提交、目标分支与时间、打回次数、连续读不到次数、开始等检查的时间、托管关掉后收尾做到一半的待办
  `off_handover`（带着基准，见下文「怎么整体关闭托管」）；
- `notices` / `denied`：只说一次的评论、按 `updated_at` 记下的被拒 issue；
- `takeover` / `takeover_unknown` / `takeover_handoff`：判过「不接手」的 PR 及其缓存键、接手阶段连续判不了的轮数、还没做完的
  交人待办（`denied` 和 `takeover` 的值都带判定规则版本，规则放宽后的升级里旧记录自动作废、按新规则重判一次）；
- `mirror`：判过「不用补 / 不用收回托管标签」的 PR 及同样的缓存键。

和 `requester_bot_done_queue` 一样不进迁移循环，功能真做了事才出现。

</details>

### 合并前必须人过目的文件（`AUTOPILOT_HUMAN_PATHS`）

有一类文件，改动本身不是「运行代码」，但会让代码在之后以维护者身份运行：CI 工作流、git hooks、agent 配置、安装 / 构建 /
环境配置文件。配了 `AUTOPILOT_HUMAN_PATHS` 之后，托管 PR 只要碰到清单里的文件就不合并，翻 `pending/human` 交人，说明里列出
命中的文件。留空或不写（默认）：只拦 `.github/`，别的都不变。

开启：在项目配置里加一行，下一轮轮询生效。关闭：删掉这一行（或写成 `""`）；已经交给人的 PR 仍在人手上。

<details><summary>示例配置行</summary>

<!-- autopilot-human-paths:examples:begin -->
```bash
AUTOPILOT_HUMAN_PATHS="default"
AUTOPILOT_HUMAN_PATHS="default /systemd/ /launchd/ /setup.sh"
AUTOPILOT_HUMAN_PATHS="default /scripts/ /prompts/ /systemd/ /launchd/ /setup.sh"
AUTOPILOT_HUMAN_PATHS="default /setup.sh /scripts/check-commit.sh"
```
<!-- autopilot-human-paths:examples:end -->

</details>

<details><summary><code>default</code> 里有什么、条目怎么读</summary>

- `default` 展开成内置清单：`/.github/` `.husky/` `.githooks/` `/.pre-commit-config.yaml` `/lefthook.yml` `.claude/`
  `.codex/` `.agents/` `.mcp.json` `.devcontainer/` `.vscode/` `package.json` `Makefile` `.envrc`。可以和别的条目混写（上面
  第二、三行）；不含 `default` 就只用写出来的条目。`/.github/` 始终在清单里。
- **条目怎么读**（空格或逗号分隔，和 `.gitignore` 的常用部分一致）：开头 `/` = 只认仓库根目录（`/setup.sh` 不命中
  `tools/setup.sh`）；开头没有 `/` = 任何深度（`package.json` 命中 `client/package.json`）；末尾 `/` = 目录及其下所有文件；
  `*` 只在一段路径内通配。改名的文件新旧路径都拿来匹配。
- **只看路径，不看内容**：清单里的文件（测试文件除外，见下）只要被改就算（`package.json` 里只升级依赖版本也算）。锁文件和
  `AGENTS.md` / `CLAUDE.md` 不在内置清单里，项目需要可以自己加。

</details>

<details><summary>daemon 读不懂的条目、读不全的文件列表</summary>

- **读不懂的条目绝不跳过**：开头没有 `/` 却在中间含 `/`（`a/b.txt`）、含 `.` / `..` 段、有空段、`**`。这时本项目每一次托管
  合并都交人，说明里点名这个条目，直到配置改好。
- **文件列表必须读全**：GitHub 在 PR 上自报的改动文件数（`changed_files`）要和读到的条数相等。缺页（这个接口一个 PR 最多给
  3000 个文件）、缺自报数、响应形状不对、请求失败都算「读不到」：本轮不合并、什么都不写，连续 `AUTOPILOT_UNKNOWN_MAX` 轮后
  交人。「读不到」绝不当成「没命中」。
- **交人前重判**：命中（或条目读不懂）之后，整个合并许可用现读的数据原样再判；结论、命中的文件、PR 的最新提交 / 目标分支 /
  分支名 / 绑定的 issue 都没变才交人，否则本轮什么都不写。交人本身和托管其他交人走同一段代码：三次写入每次之前都重判、都
  核对现状（见上文「读不到的时候，以及交人怎么写」）。

</details>

<details><summary>测试文件不算（<code>AUTOPILOT_HUMAN_PATHS_EXEMPT_TESTS</code>）</summary>

新旧路径都是测试文件的文件不拿去和清单比，所以只改清单目录里测试文件的 PR 照常合并；测试文件和别的文件混在一个 PR 里时，
只拿别的文件比、说明里也只点名它们。测试文件只看路径认（只有一份认法：`scripts/_human_paths.sh` 里的 `is_test`）：

- 文件名形如 `<名字>.test.<扩展名>` 或 `<名字>.spec.<扩展名>`（扩展名不限，`a.test.json` 也算；`a.test`、`test.mjs`、
  `a.tests.mjs` 不算），或
- 位于某一层叫 `__tests__` 的目录下；
- 但仓库根目录 `.github/` 下的一律不算：GitHub 会运行那里任何名字的工作流，`.github/workflows/ci.test.yml` 照样要人过目。

改名的文件，新旧路径都是测试文件才算。新路径是测试文件的那条改动记录必须读得全：改动类型是 GitHub 的已知词，改名 / 复制
还带着旧路径；缺了就算「文件列表读不全」（本轮不合并、什么都不写，连续读不到才交人），绝不当成「没有旧路径」放行。

不写、写成空或 `"on"` = 测试文件不算；其他任何值（`"off"`、写错的词）= 测试文件和别的文件一样照清单比。这一项只在配了
`AUTOPILOT_HUMAN_PATHS` 时起作用。要知道的限制：只看文件名、不看内容——项目里若本来就有东西会自动以维护者身份运行某个
测试文件（git 钩子、agent 钩子里写死了它），把这一项写成 `"off"`。项目自己的复审规则里抄了这份名单的，改成引用这一节，
别留一份副本。

</details>

<details><summary>钩子把检查交给清单外的文件</summary>

常见写法是钩子只做一层壳——`.githooks/pre-commit` 里只有 `exec scripts/check-commit.sh`——真正的检查在钩子目录以外的脚本里。
那个脚本每次提交都以开发者身份运行，和钩子本身是一类风险；但 daemon 只看路径，不会顺着钩子去找它调用的文件：只改
`scripts/check-commit.sh` 的托管 PR 会被合并。daemon 拦一个文件的条件是**命中清单、而且没被当成测试文件豁免掉**，所以：

- 把被调用的文件**追加**到现有的值后面，不要替换整行。原来是 `AUTOPILOT_HUMAN_PATHS="default /setup.sh"`，就写成
  `AUTOPILOT_HUMAN_PATHS="default /setup.sh /scripts/check-commit.sh"`；写成 `"default /scripts/check-commit.sh"` 会悄悄丢掉 `/setup.sh`。
- 被调用的文件名字算测试文件（`scripts/check.test.sh`）、测试文件豁免又开着时，只追加进清单**不够**：还要加
  `AUTOPILOT_HUMAN_PATHS_EXEMPT_TESTS="off"`（代价：清单目录里的测试文件改动也会交人），或者把它改成不像测试文件的名字、同步
  改钩子，再追加新路径。只关豁免、不追加，同样拦不住。
- 改配置之前用下面这条只读命令核对结果（和合并检查同一份规则；不读 GitHub、不读项目配置）。每个路径输出 `拦` 或 `不拦` 和
  原因；全部是「拦」时退出码 0，用法错误或清单里有 daemon 读不懂的条目时是 2：

<!-- autopilot-human-paths:check:begin -->
```bash
bash ~/.agents/skills/cavil-loop/scripts/human-paths-check.sh \
    --spec 'default /setup.sh /scripts/check-commit.sh' --exempt-tests on \
    scripts/check-commit.sh setup.sh .githooks/pre-commit
```
<!-- autopilot-human-paths:check:end -->

`--spec` 是打算写进配置的值；`AUTOPILOT_HUMAN_PATHS_EXEMPT_TESTS` 不写、写成空或 `"on"` 时 `--exempt-tests` 传 `on`，否则传
`off`。改名 / 复制的文件作为一项传 `--renamed <旧路径> <新路径>`：合并检查对一条改名记录是新旧路径一起判的（两边都算测试文件
才豁免），拆成两个路径分别验算可能得出不一样的结论。开发模式下用 checkout 里的 `scripts/human-paths-check.sh`。

配了清单的项目，托管复审会多一步（只在配了清单时出现，否则复审提示词不变）：顺着清单里的钩子和钩子配置（以及它们调用的
`package.json` scripts、`Makefile` 目标）找到它们运行的仓库内文件，目标分支和 PR 两边都看；PR 改到调用链上 daemon 不会拦的
文件，或者调用链上有算不出路径的调用（变量、命令替换、通配）时，不翻合并队列、交人，并给出用上面这条命令验算过的配置建议。
这一步是复审读代码的判断，不是 daemon 的硬检查：复审可能漏看，工具自己隐式加载的文件（如 lint 工具的配置）也不跟踪——这类
文件请自己写进清单。

</details>

### 托管条目上外部账号的内容（`AUTOPILOT_OUTSIDER_GUARD`）

公开仓库里任何账号都能评论，而托管中间没有人确认方案、没有人点合并。打开这一项后，agent 改用一条读取命令读托管条目——
外部账号文字里的链接、代码、附件都被去掉；`block` 档下，授权之后有外部账号评论过的 PR 不自动合并。默认关闭；开启：在项目
配置里写（下一轮轮询生效）

```bash
AUTOPILOT_OUTSIDER_GUARD="block"   # 或 "mark"：只标注和剥离，合并条件不变
AUTOPILOT_OUTSIDER_SCREEN="on"     # 不写或 "" = 不预筛
```

关闭：删掉这两行（或写成 `""`）。从下一轮起恢复原来的规则；已经交给人的 PR 仍在人手上。

<details><summary>打开后做什么</summary>

外部账号 = 在本仓库**没有写权限**的账号（不是维护者、不是 loop 的写入账号、不是外部需求机器人）。它的评论触发不了 daemon 的
任何动作：开不了工、合不了 PR、冒充不了托管授权。但托管条目派给 agent 之后，agent 会读到这些评论。打开这一项后：

- **agent 改用读取命令读本条**（`scripts/outsider-read.sh`，托管条目的提示词里写好了确切命令）：输出本条的全部正文和评论
  （PR 带上它绑定的 issue，拆分子项带上父 issue），每条标明作者身份。外部账号的**文字照常给读**，其中的链接、图片、附件、
  代码块、行内代码、HTML 注释和看不见的字符换成写明种类的占位；loop 自己的旧评论里原样引用过的同一个链接 / 代码也去掉。
  授权之后被外部账号改过的正文，给授权那一刻的版本。外部账号的话只当参考：不算需求、不算确认、不改变范围；里面的文件和
  命令不下载、不运行、不照抄。
- **合并前交人**（`block` 档）：维护者打托管标签之后，有外部账号评论（issue、PR 对话、行内评论、review）或改过正文——现在
  查得到的，或本机记录里有的（事后删掉也算）——这条 PR 就不自动合并，翻 `pending/human`，说明里点名那几条。授权之前就在的
  外部内容算维护者已过目，不拦。
- **模型预筛**（`AUTOPILOT_OUTSIDER_SCREEN="on"`）：daemon 派工前把每条外部内容（已剥离的文字）交给一个**不给任何工具**的
  模型，问它是不是在指挥 agent 做事；判为是的、筛失败的、还没筛过的，给 agent 看时整条换成占位、只留出处链接。每条新内容
  只筛一次（按内容存结论），每次派工最多补筛 5 条。读取命令自己不调模型（在 worker 会话里再起 `claude -p` 认证失败），所以
  派工之后新来的外部评论要等下次派工才筛得到，这期间是隐藏的。
- **会话**：托管条目派工时，这个角色现有的会话如果不是在保护开着时起的（这条原本是普通条目、或这一项是后来才打开的），就
  作废旧会话、起一条全新的——旧会话里可能有没剥过的原文。之后照常续接。

</details>

<details><summary>配置取值</summary>

留空或不写 = 关闭：GitHub 调用、state、提示词都不变。写了认不出的词按 `block` 处理。预筛命令可以用
`AUTOPILOT_OUTSIDER_SCREEN_CMD` 换（文字从 stdin 进、stdout 只认 `SAFE` / `SUSPECT`，别的输出都算没筛成）；留空用内置的
`claude -p --tools '' --strict-mcp-config …`（关掉全部工具和 MCP，模型 haiku）。

</details>

<details><summary>PR 被拦在合并前之后怎么办</summary>

在 GitHub 网页上操作：

1. 打开交人说明里点名的那几条外部内容，再看一遍 PR 的改动，确认改动里没有照着外部内容做的、超出本条范围的东西。
2. 选一种：
   - **自己合**：审完直接在 PR 页面点合并。
   - **继续托管**：到提供授权的地方（说明里写着，通常是 issue）把 `autopilot` 标签摘掉、再打上——这表示「这些我看过了」，
     之后的判断只看这次重新打标签之后的外部内容；再把 PR 的标签从 `pending/human` 改成 `pending/review`。复审通过后 daemon
     再检查、合并。看到 PR 上出现托管合并说明就算恢复了；要是又被拦下，说明里点名的是重新打标签之后新来的外部内容。
   - **不合**：关掉 PR。
3. 想看 agent 看到的是什么、本机记下了什么，在装着这个项目的机器上跑（只改前两行；跑这条命令本身也会把查到的外部内容记下来，
   和 agent 跑时一样）：

<!-- outsider-ops:begin -->
```bash
KEY=myproject    # the instance name / 实例名: systemctl --user list-timers 'cavil-loop-poll@*'
N=123            # the issue or PR number / 条目编号
ENV_FILE="$HOME/.config/cavil-loop/$KEY.conf"
[ -f "$ENV_FILE" ] || ENV_FILE="$HOME/.config/coding-agent-work-loop/$KEY.conf"   # installed before the rename / 改名前装的
CONF=$(sed -n 's/^CODING_AGENT_CONFIG=//p' "$ENV_FILE" | tr -d '"')
STATE_DIR=$(bash -c 'source "$1" >/dev/null 2>&1; printf %s "$STATE_DIR"' _ "$CONF")
ENTRY="$HOME/.agents/releases/cavil-loop/entrypoints/outsider-read.sh"
[ -f "$ENTRY" ] || ENTRY="$HOME/.agents/skills/cavil-loop/scripts/outsider-read.sh"   # development mode / 开发模式
bash "$ENTRY" --config "$CONF" "$N"
echo "exit code / 退出码: $?"
ls "$STATE_DIR/outsider/" 2>/dev/null || echo "no records yet / 本机还没有任何记录"
```
<!-- outsider-ops:end -->

退出码 0 = 读全了；3 = 读不全（网络、权限查不到、正文那一版取不回），什么都不输出。记录按条目编号分目录（PR 绑着 issue 时
用 issue 的编号），条目收尾清理时删掉。

</details>

<details><summary>它挡不住的</summary>

这不是沙箱：不守规则的 agent 仍然可以绕开读取命令去读原文、下载并运行别人给的文件；纯文字写的恶意要求剥不掉（预筛能拦下
一部分，也会漏判、误判）；拆开写的网址、用自己的话转述的内容认不出来；两次检查之间出现又删掉的评论 daemon 没见过；合并前
最后一次检查到合并请求到达 GitHub 之间的窗口消除不了；本机记录不在多台机器之间同步。

</details>

### 只在一台机器上跑这个仓库的轮询

开托管前，确认**只有一台机器**在跑这个仓库的轮询：在**每台别的机器**上跑下面的主机检查（`REPO=<仓库> bash host-check.sh`），
按最后一行处理。

<details><summary>每种结论怎么处理</summary>

| 最后一行 | 怎么做 |
|---|---|
| `HOST_VERDICT=STOPPED` | 那台不跑这个仓库，可以继续 |
| `HOST_VERDICT=RUNNING` | **先**停调度、**再**等会话跑完（不留「看着空闲、停之前又派出去」的空档）：Linux `systemctl --user disable --now cavil-loop-poll@<实例名>.timer`（改名前装的是 `coding-agent-poll@<实例名>.timer`）；macOS `launchctl bootout gui/$UID/dev.luosky.cavil-loop.<实例名>`。等它的会话自己结束——**不要杀**：别的机器不接手它派的活，杀了就卡在 `doing/agent`。重跑直到 `STOPPED` |
| `HOST_VERDICT=UNKNOWN` | 查不清，**不要开托管** |

</details>

<details><summary>为什么另一台机器会把托管弄断</summary>

另一台只要还在跑，**不管它开没开托管**都可能领走托管条目的复审和派工（普通派工不看托管开关，也不看活是哪台派的；只有合并
那一步看归属）：它派的复审不带托管规则，设计通过会交人、代码通过不会进自动合并，闭环就断了；它若也开着托管、又没开
`SELFHEAL_ONLY_OWN_WORKERS`，还会把别家复审过的 PR 送回重审。

</details>

<details><summary>检查看哪些东西</summary>

它按 daemon 自己的读法载入安装登记和项目配置（干净环境、子进程、限时 10 秒、输出丢弃），读出 daemon 实际会用的仓库名和会话
前缀——引号写法、重复赋值、变量拼写都和 daemon 一致；确定是这个仓库后再看定时任务停没停、开机会不会自启、还有没有会话，
以及还有没有工作目录在这个项目 worktree 底下的进程（会话没了、进程还活着的 worker 也算在跑）。任何一样读不到都判 `UNKNOWN`。

它只认安装脚本装出来的轮询；用别的方式（自己写的定时任务等）跑过这个仓库的机器，同样按「查不清」处理。

</details>

<details><summary>主机检查脚本</summary>

<!-- autopilot-ops:host-check -->
```bash
# autopilot host check. Run on every OTHER machine before turning autopilot on:
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

</details>

### 怎么整体关闭托管

在配置里把 `LABEL_AUTOPILOT` 留空（`LABEL_AUTOPILOT=""`）或删掉那一行就行，不用停定时任务、不用跑别的。下一轮起不再自动合并，
本机等合并的 PR 交给人。⚠️ issue 上残留的托管标签在关着时不起作用，但**以后再打开托管，留着它的 issue 会立刻重新进入托管**，
不想这样就摘掉。

<details><summary>关掉之后 daemon 做什么</summary>

- 不再自动合并任何东西，新派出去的活也不再带托管规则；
- 本机托管过、还挂着 `LABEL_PENDING_MERGE` 等合并的 PR，翻成 `pending/human` 并在 PR 上留言说明。关掉之前就派出去、之后才
  跑完的复审若又翻出等合并，下一轮照样收；
- 排队中、正在跑的活不清空，照普通流程走完、交人；已完成的合并不撤回。

只认本机托管过的 PR（`state.json` 的 `autopilot.prs` 有记录）：别的项目恰好也有同名标签不受影响，从没开过托管的项目一个
GitHub 调用都不多。

</details>

<details><summary>交接的几次写入怎么核对</summary>

交接的最终状态是：有 `pending/human`、没有等合并标签、PR 上有一条交人说明；顺序是加 `pending/human` → 摘等合并标签 → 发说明。
三次写入和开着时的交人照同一套核对：动 GitHub 之前先在 `state.json` 记下一条待办，里面带着开始时 PR 的现状（基准）、「现在
应该是什么样」（基准 + daemon 已确认的自己的写入）和已经决定要发、还没确认结果的那一步；每次写入之前现读 PR，和待办对得上
才写，写完再读一次确认只多了自己这一条。

- 中间任何一步失败或进程被杀，下一轮靠待办接着做：现状等于「应该的样子」就继续，恰好多出待写的那一步就认作自己写成的。
- **其他任何差异都说明有人动过**（关了 PR、摘了 `pending/human` 自己接手、重新入队、推了提交……）：待办作废，本轮不再写；
  之后 PR 不在合并队列就不再碰，仍挂着等合并标签的下一轮当作新的一件事从头开始。
- 现状读不全时本轮不写，待办原样留着。
- 重新开启托管时待办全部清掉，之后再关不会接着上次做到一半的地方。

</details>

## 外部需求机器人（可选，**默认关闭**）

另一个 AI 助手（有自己的 GitHub 账号）直接给项目提需求时，agent 提问 / 汇报不翻 `pending/human`，而是叫醒
这个机器人。默认关闭：五个配置项（`LABEL_PENDING_REQUESTER_BOT` / `REQUESTER_BOT_ACCOUNT` /
`REQUESTER_BOT_ALLOWED_ACTORS` / `REQUESTER_BOT_ORIGIN_MARKER` / `REQUESTER_BOT_REPORT_FIRST`）全部留空
= 关闭。完整说明：[对接外部需求机器人](requester-bot.zh.md)。

<details><summary>做什么、有哪些配置</summary>

agent 跑叫醒脚本：挂 `LABEL_PENDING_REQUESTER_BOT`，确认挂上后调一次机器人的 webhook（issue、PR 一样；
不指派、不请求 review）。PR 合并或关闭未合并时，daemon 在机器人提的 issue 上留一条结果评论、加等待标签、
调 webhook。

早期的名字（`LABEL_PENDING_RELAY`、`RELAY_*`）照样认；同一项新名字有值时用新名字。webhook 另有三项
（`REQUESTER_BOT_WEBHOOK_URL` / `_KEY_HEADER` / `_KEY`），地址留空 = 不发；配置文件必须是 600。
`REQUESTER_BOT_WAKE_ANY_ITEM=true`（默认 false）让不是机器人提的条目也能叫醒它，见
[requester-bot.zh.md](requester-bot.zh.md#维护者自己的条目可选)；合并 / 关闭通知照旧只发给机器人提的需求。

</details>

<details><summary>运维上要知道的</summary>

- 挂着等待标签的条目，greedy 兜底和 self-heal 都不碰；有人打了触发标签就照原流程派，派工时摘掉等待标签
- 没有等待超时。机器人一直没回音，`poll.log` 里不会有任何动静，要人自己看看板上挂着等待标签的条目
- 叫醒脚本走长期入口 `~/.agents/releases/cavil-loop/entrypoints/notify-requester-bot.sh`（发版切换时路径不失效；早期入口 `notify-relay.sh` 转发到它），
  每次叫醒在 `poll.log` 留一行 `notify-requester-bot #<编号>: …`；配了 webhook 时紧跟一行结果（`已通知 webhook（HTTP 200）` / `webhook 通知失败（…）` / `… 跳过`），不含地址和密钥
- 合并 / 关闭通知：没发成的记在 `state.json` 的 `requester_bot_done_queue`；发成一条 `poll.log` 有一行 `✅ 已把 PR #N 的结果…`，连续 30 轮失败放弃时有一行 ⚠️。它跑在合并后清理那一段里，`AUTO_CLEANUP_ON_MERGE=false` 时也一并不发
- 退出码、证据规则和接入示例：[对接外部需求机器人](requester-bot.zh.md)

</details>

## 往返记录：agent 之间的来回写进同一条评论（`ENABLE_ROUND_LOG`）

agent 之间的一段来回——交方案或 PR、复审、修订、再复审……——只占**一条**评论，叫「往返记录」，不再每一步一条。
配置里写 `ENABLE_ROUND_LOG=true` 才开（模板里写了；配置里没有这一行时算关，`poll.log` 提示一次）。写
`ENABLE_ROUND_LOG=false`（或删掉这一行）即关闭。

<details><summary>记录里写什么、什么照旧单独发</summary>

每次交给 agent 的交付（发完要把条目翻到复审标签、或翻回派工标签的那一条）在末尾追加一节，只写改了什么、给下一个
agent 的交代和用量 footer；完整的当前版本（整份方案 / 完整交付说明）放在记录顶部，换成最新的。

- **照旧单独发**：所有交给人的评论、托管交合并的复审结论（合并检查只认派复审之后新建的评论里的测试记录）、daemon 的评论、
  等前置登记。中途有任何人发了新评论，这条记录就结束，下一次交付另起一条
- **只有 loop 改它**：往返记录只由 loop 写评论的账号写、只由它改，不改任何别的评论。回复和勾选请在交人评论里，不要编辑往返
  记录；编辑它不受保护，人的改动可能被下一节盖掉

</details>

<details><summary>命令与每次写之前的核对</summary>

agent 通过长期入口 `~/.agents/releases/cavil-loop/entrypoints/round-log.sh` 跑 `post` / `show`。

- 每次写之前都重读目标（仍打开、仍挂 `doing/agent`、没挂 `pending/human` / 等前置 / `pending/merge` / `pending/PR` 标签、PR 没合并、目标分支和来源没变、最新提交就是本次交付
  依据的那个）。状态和标签在读到的每一份响应上都核对（PR 上先读 issue 再读 PR，issue 上读完关联 PR 列表后再读一次 issue），字段缺失或读不懂就不写。改写失败或超时就另起一条完整的新记录，节编号不变，读取和统计只算一份。
- 发到 PR 上时调用方必须给本次交付依据的提交和目标分支（`--basis` / `--base`；PR 来自别的仓库再加 `--source`）——命令不拿自己第一次读到的值当基准，缺了就拒收。缺 `--basis` / `--base` 是用法不对（退出码 64）：agent 补齐参数重跑，不改成单独发。
- 复审必须带 `--of`——开始复审时读取命令在最新单元下标出的值（节编号；单独评论是 `comment-<编号>`；线程里还没有任何交付时是 `body`，如首次开 PR、交付说明只写在 PR 正文里）；这期间又来了新的交付，这条结论就过期了（退出码 3），不发、也不改成单独发。
- 复审时最新的交付不是往返记录里的一节（开关关着时发的独立评论、单独发的交付，或之后 loop 账号又单独发了评论）时，这条复审结论被拒收（退出码 2），改成单独发——不会挂到记录里更早的那一节上。
- 评论区里已有的记录读不懂（缺标记、版本对不上）时按评论读不全处理（退出码 5）：什么都不写，agent 也不改成单独发、不翻标签。
- 复审轮次仍从最近一次人工动作算起：读取命令按时间列出算作一轮复审的单元（记录里的复审节，或 loop 账号单独发、第一个非空行整行就是轮次标记的评论；讨论里举的例子不算）和不是 loop 账号写的评论，并写明那里的总数是全部历史；编辑评论、只改标签这类动作从评论编辑信息和 issue events 读。
- 每次运行在 `poll.log` 留一行 `round-log #<编号> post：<结果>`。

**托管条目开了外部内容保护**：用受保护读取命令读，它的输出末尾带着同样的单元视图。写入之前也先走同一次受保护读取，
读不全就什么都不写。

</details>

<details><summary>认谁的记录、统计</summary>

- **认记录只有一种判法**：作者是 loop 写评论的账号（`WRITE_GH_TOKEN` 的账号，没配时是 gh 自己登录的账号），写入 / 读取命令、
  周报、`pr-time-stats.py` 都一样。别的账号发的、带着记录标记的评论只当普通评论，名字以 -bot 结尾的也一样。loop 账号写的
  记录读不懂时，读取和两个统计都报错退出
- **统计**：周报和 `pr-time-stats.py` 用同一个函数把记录拆成一节一条（每节用自己的追加时间）；周报对每个有往返记录的条目
  先整串重读评论、再按周筛，读失败就报错退出

</details>

<details><summary>关掉</summary>

写 `ENABLE_ROUND_LOG=false`（或删掉这一行）。已有的记录原样留着、照常被读取和统计；改完之后**开始的派工**交付恢复成普通评论
（已经开着的 worker / 复审会话照它开始时的规则写）。

不开编辑器、用项目配置脚本改（`myproject` 换成项目的实例名）：先查现在的值，开着时输出 `ENABLE_ROUND_LOG=true`：

<!-- round-log-check-ops:begin -->
```bash
bash "$HOME/.agents/skills/cavil-loop/scripts/project-config.sh" get myproject | jq -r '.fields[] | select(.name == "ENABLE_ROUND_LOG") | "\(.name)=\(.value)"'
```
<!-- round-log-check-ops:end -->

再整段运行下面这一段，看最后一行：

- `ROUND_LOG=off`：已保存，读回是 `false`（上一行是 `RESULT=saved`；本来就是关的时是 `RESULT=unchanged`）。
- `NOT_WRITTEN: …`：什么都没写（配置读不了、读取之后保存之前被别处改过、备份写不进……），配置没动，直接重跑这一段即可。
- `UNCONFIRMED: …`：配置已经写过，但没能确认现在的值（紧接着又被别处存了一版，或读回失败）：跑上面查值的命令，
  显示 `false` 就是已关上，不是 `false` 再重跑这一段。

<!-- round-log-off-ops:begin -->
```bash
(
  SKILL="$HOME/.agents/skills/cavil-loop"; KEY=myproject
  PC() { bash "$SKILL/scripts/project-config.sh" "$@"; }
  REV="$(PC get "$KEY" | jq -er .rev 2>/dev/null)" || { echo "NOT_WRITTEN: config unreadable"; exit 1; }
  RC=0; OUT="$(printf '{"ENABLE_ROUND_LOG":"false"}' | PC set "$KEY" --rev "$REV")" || RC=$?
  printf '%s\n' "$OUT" | tail -1
  case "$RC" in
    0) ;;
    4) echo "UNCONFIRMED: written, then changed elsewhere"; exit 1 ;;
    *) echo "NOT_WRITTEN: exit $RC"; exit 1 ;;
  esac
  NOW="$(PC get "$KEY" | jq -er '.fields[] | select(.name == "ENABLE_ROUND_LOG") | .value' 2>/dev/null)" \
    || { echo "UNCONFIRMED: saved, read-back failed"; exit 1; }
  if [ "$NOW" = false ]; then echo "ROUND_LOG=off"; else echo "UNCONFIRMED: read back ${NOW}"; exit 1; fi
)
```
<!-- round-log-off-ops:end -->

要让所有项目默认打开：改 `scripts/_lib.sh` 里 `round_log_enabled` 那一个空值分支即可，配置里没有这一行的项目随之打开。

</details>

## 评论用量 footer

`COMMENT_FOOTER="on"` 时，每条交人评论末尾接一段由 `scripts/drivers/token-usage/comment-footer.sh`
整段生成的 footer：一行总览（耗时拆成 AI / 测试 / 远端 CI / 其他，加模型、token、参考金额），它同时是一个
折叠块的标题；最后一行是给周报读的隐藏 `agent-metrics` 机器记录。`COMMENT_FOOTER="off"` 关掉。

<details><summary>总览怎么拆耗时</summary>

- **总耗时按 AI / 测试 / 远端 CI / 其他的顺序拆开。**「其他」= 总 − AI − 测试 − 远端 CI，按显示出来的
  整秒相减，最小 0；测试和别的段有重叠（AI 在想、或在等远端 CI 时测试在后台跑）时记 0，细节里说明。
- **测试那段只在配了 `COMMENT_FOOTER_EXTRA_CMD` 且有话可说时出现**：`测试 4m 51s`（大于 0 秒），
  或 `测试未知`（命令回答 `test_secs=unknown`——跑过但说不出耗时，例如只有后台 / 未完成的运行；
  或命令失败、超时、第一行不对，这几种原因写在细节里）。命令回答 0 表示确认这轮没跑测试：总览
  不提测试，和没配命令的项目一样；机器记录照写 `test_secs=0`，周报仍分得清两者。拿不准有没有跑的
  命令要回答 `unknown`，不能回答 0。
- **AI 时间是估算**（总览写「AI 约 …」）。每次模型请求从发出请求算到最后一段回复写进会话记录，
  几次请求同时覆盖的那一秒只算一次。偏差来源：含网络往返和排队等首字的时间；会话记录是写盘
  时刻，与真实收发差几毫秒到几秒；AI 在想的时候后台命令可能也在跑。这段说明不在每条评论里重复；
  算不出来时总览写「AI 时间未知」，细节里写原因。

</details>

### 测试耗时：自带的统计命令

skill 自带一个测试耗时命令 `scripts/drivers/token-usage/test-time.sh`，和 footer 脚本一样有长期入口，
跑的永远是已合并、已部署的版本，worktree 里正在改的那份不会被执行。默认不开，在本机配置里加这一行打开
（带存在判断：合并到部署之间那几分钟入口还不在，footer 照样不报错）；退回就把这一行清空。

```bash
COMMENT_FOOTER_EXTRA_CMD='f="$HOME/.agents/releases/cavil-loop/entrypoints/drivers/token-usage/test-time.sh"; if [ -e "$f" ]; then bash "$f"; else printf "test_secs=unknown\n- 测试统计命令尚未部署\n"; fi'
```

检查：下一条交人评论的总览里出现 `测试 …`（或 `测试未知`，细节里写原因）。

<details><summary>测试耗时从哪来：整套测试和单跑测试</summary>

- **整套测试**——`tests/run.sh` 每次运行生成一个编号，在自己的输出里印 `cavil-test-run id=<编号>`
  （记账没写进去时后面加 ` log=failed`），并往 `${XDG_STATE_HOME:-~/.local/state}/cavil-loop/test-runs.jsonl`
  （`CAVIL_TEST_RUNS_LOG` 可改）追加带同一编号的开始行、结束行。会话里的命令和记录**只按这条命令
  自己输出里的编号**关联（前台看工具结果；Claude 放后台的命令看工具结果里写明的输出文件；codex
  看这条命令在它那个 `exec` 单元输出里的那一项，加上之后同一 `session_id` 的 `write_stdin` 轮询返回的输出——
  别的命令的输出一概不算，例如 `cat` 一份存下的日志），不按开始时刻接近——人在旁边手跑的、同一 agent
  并发的另一次，都是另一次。两行都在、或只有结束行（结束行自带开始时刻）→ 实测计时；只有开始行 →
  「未记到结束」；印了编号但没有记录 →「没有记账」；读不到编号 →「无法关联」；记录里有、没有任何会话
  命令印出过 → 单独算一次、实测计时。嵌套运行（测试里再跑 `tests/run.sh`）不记账。
- **单跑测试**——从 agent 自己的会话里认出的测试命令（`bash tests/<名字>.test.sh`、
  `bash test/tauri/mutations.sh`、`npm test` / `npm run test…`、`npx vitest`、`npx playwright test`、
  `cargo test`；引号和 here-doc 里的文字不算），按工具调用到工具结果计时，是整条命令的估算。
- **回答**：任何一栏读不了 → `unknown`；有实测部分 → 各段时间的并集（并行的同一秒只算一次；另有未计时的
  写进细节，所以是下限）；看到了运行、一秒都没计上 → `unknown`；两栏都读到、一次都没跑 → 0。

</details>

<details><summary>codex 会话和测试耗时的已知限制</summary>

- codex：`exec` 单元只有在通篇都是 `text(await tools.X({…}));` 语句、且每条语句恰好一项输出时，
  才把输出逐项配给命令；别的单元命令照样计（整套记「无法关联」、单跑不计时），输出不配给任何一条。
  带 JSON 参数的标准函数调用（`exec_command`、`shell`、`local_shell_call`）也认。命令文本解析不了
  （例如模板字符串）记「解析不了」，回答变 `unknown`，不会是 0。
- 限制：包一层（`bash -c '…'`、自己的脚本）认不出来；放后台（Claude）或单元返回时还在跑（codex）的
  单跑只计次数；整套测试的输出写进了文件（`> log`）或别的原因读不到时，同一次可能算两遍——一次
  「无法关联」、一次按记录——次数多 1，秒数不多。

</details>

### 远端 CI 等待

远端 CI 那段是 agent 等 GitHub Actions 跑完的时间（总览写「远端 CI 约 …」）。从 agent 自己的会话记录里认，
不查 GitHub，不需要配置；数字按命令推断，可能偏多。

<details><summary>哪些命令算等待，等待从何时起止</summary>

- 认哪些命令（Claude 的 Bash、Monitor 调用；codex 的 `exec` 命令）：本身阻塞到运行结束的 `gh run watch …`、
  `gh pr checks … --watch`；或一个 `for` / `while` / `until` 循环，里面同时有 `sleep` 和远端 CI 状态查询
  （`gh run view` / `gh run list` / `gh pr checks`，或 `gh api` 访问 `…/actions/runs…`、`…/check-runs`、
  `…/check-suites`、`…/commits/<sha>/status`）。只认真正会执行的命令：按 shell 规则拆开，单引号里是文字，
  双引号和不带引号处的 `$( … )` / 反引号会执行；`echo gh run watch 1` 这种打印出来的文字、循环里 echo 的
  查询都不算。单次查询、`gh workflow run`、轮询 PR 评论 / 标签也不算。
- 循环那一条要求查询和 `sleep` 在**同一个**循环里（外层循环里的也算）；`for` 头部的查询只执行一次，不算轮询。
- 不算（拿不准时宁可留在「其他」，不把别的时间挪进「远端 CI」）：函数定义里的命令（定义不等于调用，调用也不去
  追）；整条放后台（`… &`）的命令；交给 `bash -c` / `sh -c` / `eval` / `xargs` / `ssh` / `sudo` 当字符串执行的、
  自己的脚本文件里的。
- 起止：开始 = 工具调用写进会话的时刻；结束 = 前台命令的工具结果、后台命令和 Monitor 的「后台任务结束」
  通知（Monitor 运行中的事件通知不算）、codex 命令自报的耗时或报出退出码那次轮询。

</details>

<details><summary>合计怎么算，机器记录</summary>

- 合计 = 各条等待时段的并集，再扣掉与 AI 请求重合的部分（后台在等、agent 同时在干活的那段算 AI），所以
  不和 AI 重叠。细节逐条列出等的是哪个运行（只从认定为等待的那条 gh 命令里取，`gh run …` /
  `actions/runs/<编号>`，命令里用变量时找同一条命令里的赋值）或哪个 PR 的检查、起止和这一条自己的时长
  （不扣 AI，可以和 Actions 页面对），并写明几条重叠、扣了多少 AI 时间。
- 没记到结束的（后台任务还没结束、通知缺失、codex 一直没报退出码）只计条数、不算进合计（细节里注明）；一条都没
  计上时总览写「远端 CI 未知」。上一轮派工里开始的等待不算。
- 机器记录：`ci_wait_secs`（合计，毫秒精度）、`ci_waits`（条数）、`ci_wait_untimed`（没记到结束的条数）；
  没有等待时写 `ci_wait_secs=0.000 ci_waits=0 ci_wait_untimed=0`，一条都没计上时不写 `ci_wait_secs`。统计
  不出来（会话读不了、统计出错）时三个都不写，细节写「远端 CI 等待没统计到」和原因。周报目前不解析这三个
  字段。

</details>

<details><summary>为什么可能偏多，以及其他限制</summary>

- footer 细节标题写「按命令推断，可能偏多」：数字是按命令推断的，不是专用等待命令实测记下的。已知会多算的
  几种：一条命令里只要认出等待，整条命令的时长都算进远端 CI，等待之外的其他耗时操作一起算进去；等待写在没走的
  分支里（`if false; then gh run watch 1; fi; sleep 60`、`false && gh run watch 1; sleep 60`）时，后面那段时间也
  算进去；函数体里出现引号中的 `}`（`f() { echo '}'; gh run watch 1; }`）会让函数体被当成已执行。多算多少取决于
  命令里掺了多少别的耗时操作，说不出上限。
- 上面「不算」的写法里真在等的那段仍算「其他」；`&&` / `||` / `if` / `case` 分支里的等待按执行算（看不出分支
  走没走）；没记到结束的等待不算进合计；和本机测试的重叠扣不掉（测试只给总数），见上面「其他」记 0 的规则。

</details>

### Claude footer 的单价

Claude 一侧 footer 按 daemon 每天下载一次的最新 Claude 公开价给每次调用定价，不从会话日志反推。
`PRICE_AUTO_FETCH=off` 停掉下载，已经下载下来的价照用。

<details><summary>每日下载价目与取价顺序</summary>

- daemon 每天下载一次 Claude 官方价目页（只在调度器起的轮询里做；手动直接跑 `agent-poll.sh` 的轮询跳过这次
  每日刷新，但有缺价标记时仍会联网补那个模型的价），只用这一处的价（不拿 LiteLLM 对照；缺价补抓仍要两边一致），
  五项单价（input、output、缓存读、5 分钟和 1 小时缓存写入）齐全、通过合理性校验的模型存进
  `${XDG_CACHE_HOME:-~/.cache}/cavil-loop/latest-prices.json`。
- 下次下载的时刻写在旁边的 `latest-prices.next`。下载失败过 `PRICE_FETCH_COOLDOWN_SECS`（默认 6 小时）再试；
  下载到了却写不进缓存，10 分钟后再试；两种情况都继续用上一份。连下次时刻也写不进去时，`poll.log` 写
  「下次刷新时刻没能保存，下一轮会再抓」，每轮都会再下载，直到缓存目录能写。
- 用量驱动用 `python3 scripts/weekly-report/price_solve.py --listed` 取单价（这一步不读会话日志）：模型有
  最新价用最新价，没有用内置表，再没有用缺价时补抓来的价。机器记录里是 `price_source=default`，金额拆成
  `fetched`（下载来的）和 `reference_only`（内置表）。
- footer 对 Claude 驱动只调一次 `--both`，人读行和机器记录出自同一张表；拿到的不是恰好两行就两行一起算
  「用量未知」，不再调第二次（Codex 驱动调两次）。
- `PRICE_AUTO_FETCH=off` 只停掉下载（每日下载和缺价补抓都停）：已经下载下来的价照用——上次的
  `latest-prices.json`，以及 `fetched-prices.json` 里补抓来的、这份文件和内置表都没收录的模型的价。
- 取单价不读会话日志；统计本次用量读当前工作目录对应的会话。周报从日志反解单价。

</details>

### 每个已合并 PR 的平均 AI 与测试耗时（估算）

`scripts/pr-time-stats.py` 把一段时间内合并的每个 PR 的 AI 耗时和测试耗时加起来：数据来自上面的 footer、
本机 `tests/run.sh` 测试流水和 GitHub Actions。只读：只读 GitHub（用 `gh` 当前登录的身份）和测试流水，
不写任何地方。

<details><summary>命令</summary>

```bash
python3 ~/.agents/skills/cavil-loop/scripts/pr-time-stats.py \
    --repo OWNER/REPO --worktree-base "$WORKTREE_BASE" --bot-login <loop 写评论的账号> \
    [--since 2026-11-07] [--until YYYY-MM-DD] [--no-ci-selection] [--no-cache] [--json]
```

</details>

<details><summary>读哪些 PR 和评论</summary>

- 算哪些 PR：在 `[--since, --until]` 合并（默认从本机测试流水开始记的 2026-11-07 到今天）、创建不早于
  `--since`、也没有早于它的 footer。
- 读哪些评论：PR 自己的，加上它对应 issue 的。对应 issue 用 daemon 同一条规则找：分支名
  `BRANCH_PREFIX<N>` → 正文第一处 `Closes / Fixes / Resolves / Refs #N` → PR 号本身。只认机器人账号发的
  footer；loop 账号名不以 `-bot` 结尾时用 `--bot-login` 指定。几个已合并 PR 对到同一个 issue 时，issue 上的
  评论和测试运行按各 PR 的合并时刻切开（标「共用工作树」）。

</details>

<details><summary>各栏</summary>

- AI（footer 的 `ai_secs` 相加）；单跑（footer 的 `adhoc_secs` 相加——footer 只记合计，分不出种类）；
  `tests/run.sh` 的运行从流水按参数分：冒烟（只跑 `smoke`）、快速（`--quick`）、按种类（`--kind`）、相关改动
  （按名字跑几个文件或 `--changed-from`）、全部（不带挑选条件）、其他；`Tests` 工作流的 CI 每次尝试按汇总
  那一步印的挑选方式分（全量 / 只跑改动够得着的 / 未知），`Client` 工作流单列；本地小计、CI 小计（各次尝试
  取并集）、测试总耗时。
- 「完整测试」= 带负对照的整套运行，只有每晚的 `Negative controls` 工作流在主干上这么跑、不属于某个 PR：
  这一栏为 0，报告另列它每次运行多久——只算「负对照那一步」自己真的跑了的那几次（shell 分片、autopilot、
  客户端三种作业都按步骤判断；跑红的照实计入）。只做了准备就收尾的运行（不在主干上的手动运行、定时运行发现
  同一个提交上次已经跑绿），以及准备步骤失败、负对照那一步没开始的运行，整条运行照样显示完成或失败，都不算
  进去、单列为「没真跑」；作业或步骤读不到、负对照那一步被取消或状态认不出的，也不算、单列，下次重读。发版
  流水线和客户端完整测试单列为「其他主干测试」，不算完整测试。

</details>

<details><summary>为什么是估算，什么时候直接停下</summary>

- footer 的数值直接相加、不跨派工去重，同一 agent 在同一工作树上两轮派工时间重叠时，重叠段算两次（标
  「派工重叠」）；本地和 CI 也是直接相加。footer 的测试字段带不确定标记（读取失败、认不出的命令、未计时、
  未关联）时照常计入，标「测试记录不全」（是下限）。
- 没有 footer 的 PR 没有 AI 值，本地小计和测试总耗时也记「未知」（缺单跑那部分），`tests/run.sh` 各栏和 CI
  照给；某条 footer 缺 `ai_secs` 时这个 PR 的 AI 记「未知」——都不当 0 进平均。每栏的平均都写明各自的计入
  个数，各栏平均不能相加。
- 读 GitHub 或流水失败、列表没读全，命令以退出码 2 结束，不出报告。`--no-ci-selection` 不读 CI 日志
  （`Tests` 的尝试全部记「挑选方式未知」）。

</details>

<details><summary>请求量和缓存</summary>

- 每个 PR 读一两页评论，`Tests` 每次尝试再读两次（作业列表、汇总那一步的日志）——约 180 个 PR 的时间段大约
  1000 次请求，占 `gh` 当前登录账号每小时额度的五分之一；这个账号可能就是 daemon 轮询用的那个，一小时内跑几遍
  就可能把额度用光。
- 跑完的尝试的起止和挑选方式存在 `$XDG_CACHE_HOME/cavil-loop/pr-time-stats-<仓库>.json`（不会再变），重跑只读
  评论和列表；读失败的不存。报告末尾写明这次发了几次请求。`--no-cache` 不用缓存。

</details>

## Codex token 折算参考价值

没设 `CODEX_PRICES` 时，Codex 用量驱动按[内置价格表](../scripts/drivers/token-usage/codex-prices.json)（2026-10-19
对照官方模型页核过）给 token 折价。美元金额是**按 API 公开标价折算的参考价值**，不是订阅账单或已核验的实际支出。设
`CODEX_PRICES` 可整表替换，设 `CODEX_PRICES='{}'` 关闭估算。

<details><summary>内置表覆盖哪些型号</summary>

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

- 表里是它们的标准文本输入、缓存输入和输出标价。
- GPT-6 的四个型号与 GPT-5.6 的三个型号另配有官方列出的缓存写入单价；名字带 codex 的型号官方未列缓存写入价，其缓存写入仍报缺价。
- `gpt-5.6-sol` 目前是促销价，官方只保证至 2026-11-21；请在此之前复核该型号，不要等 90 天过期提示（它来得更晚）。

</details>

<details><summary>替换价格表：<code>CODEX_PRICES</code> 与统一单价兜底</summary>

- `CODEX_PRICES` 是按完整模型 ID 写的 JSON，整表替换内置表；[配置模板](../cavil-loop.config.example)有可直接复制的版本。
  `CODEX_PRICES='{}'` 关闭估算。
- 未知模型或缺少单价的 token 项仍报缺价。
- 三个 `CODEX_PRICE_*_PER_M` 变量为没有精确 `CODEX_PRICES` 条目的模型提供统一单价兜底；有精确模型条目时，精确条目优先。
- 要从宿主配置覆盖，写 `export CODEX_PRICES='...'`，并把 `CODEX_PRICES` 加进 `WORKER_PASS_ENV`：tmux 内的 worker 不会自动继承未导出的配置变量。

</details>

<details><summary>估算的局限</summary>

- 驱动认不出长上下文与 Fast / Batch / Flex 档位，估算只取 Standard 标价。
- 内置表是静态的：超过 90 天，人读用量会提示复核。表里已有的模型不会在运行时刷新；只有表里**没有**的模型会被自动补价（见下一节）。
- 周报分别列出内置公开参考价和部署者自填价；两者都未与账单交叉核验。

</details>

## 缺价自动补价

用量驱动（Claude / Codex 两侧）发现某个模型有用量却没有单价时，footer 照实写「金额未计」，daemon 下一轮去抓这个模型的价。
默认开启；`PRICE_AUTO_FETCH=0` 关闭。

<details><summary>怎么抓价、什么时候才采用</summary>

驱动跑在 worker 里，**不联网**，只在 `~/.cache/cavil-loop/unpriced/` 下留一个空标记。daemon 下一轮看到标记，运行
`scripts/drivers/token-usage/price_fetch.py`，下载：

| 来源 | 默认地址 |
|---|---|
| Anthropic 官方价目页（markdown 版） | `https://platform.claude.com/docs/en/about-claude/pricing.md` |
| OpenAI 官方价目页（markdown 版，只读 Standard 表） | `https://developers.openai.com/api/docs/pricing.md` |
| LiteLLM 社区价目表（GitHub 上的 JSON） | `https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json` |

只有官方页与 LiteLLM **一致**（两边都列出的每一项偏差 ≤ 10%）、各自通过合理性校验（正数、≤ $1000/M、output ≥ input、
缓存读 ≤ input）、且官方页上该模型只有一行时，才写进 `~/.cache/cavil-loop/fetched-prices.json`；只有一边列出的项照旧算缺价。
此后两个驱动都按它计价，footer 人读行多一句「（含自动联网获取的单价）」，金额单独记在 `fetched` 可信度桶里，一路带到周报。

</details>

<details><summary>规则、失败处理与配置项</summary>

- 只补缺：内置价和部署者配的 `CODEX_PRICES` 永远优先；显式设了 `CODEX_PRICES`（包括 `{}`）时 Codex 侧不补。
- 失败（下载失败、页面改版、两边对不上）连同原因写进 `poll.log`，6 小时后再试（`PRICE_FETCH_COOLDOWN_SECS`）。单次请求
  15 秒超时（`PRICE_FETCH_TIMEOUT`），抓价失败不影响派工。
- 发现缺价的那一条评论仍写「金额未计」，下一轮之后的评论才带金额；已发出的 footer 不改写。
- 关闭：`PRICE_AUTO_FETCH=0`。三个地址可用 `PRICE_FETCH_ANTHROPIC_URL` / `PRICE_FETCH_OPENAI_URL` /
  `PRICE_FETCH_LITELLM_URL` 覆盖。
- 想让 daemon 立刻重试失败的模型，删 `~/.cache/cavil-loop/price-fetch-state.json`；想丢掉某个抓来的价，改或删 `fetched-prices.json`。

</details>

## agent 撞到用量上限：停派这个 agent，被打断的条目转人工

worker 撞到订阅的用量上限时，daemon 在解除之前不再给这个 agent 派工，并把被打断的条目交给人。默认关闭；
配置 `ENABLE_USAGE_LIMIT_PAUSE=true` 开启。关着、留空或不写时，不多读一次 tmux 或 GitHub，也不留状态文件。

<details><summary>为什么要它，daemon 做什么</summary>

两个 agent 都跑在包月订阅上，有时段用量上限。worker 撞上之后，CLI 停在一条提示上：会话活着、条目还挂
`doing/agent`、名额占着——而新派给这个 agent 的会话一开口又撞一次。开关打开后，daemon 每轮看一眼本机派
出去、仍挂着 `doing/agent` 的会话，认出这条提示就做两件事，别的都不做：

| 做什么 | 细节 |
|---|---|
| 这个 agent 在解除之前不再接新活 | 新 issue、issue 评论、PR 评论、复审、往已有会话里注入，凡是要用这个 agent 的都跳过；标签不动、不计派工失败，到解除时间自动恢复。别的 agent 照常。暂停是**整台机器、按 agent 和账号目录**记的（`~/.claude` / `CLAUDE_CONFIG_DIR`，`~/.codex` / `CODEX_HOME`）：同一个账号的几个项目会一起撞 |
| 被打断的那一条交给人 | 留一条评论（哪个 agent、几点解除、标签改回哪个），然后加 `pending/human`、摘 `doing/agent`。daemon 不往会话里送字、不停程序、不关会话、不自己续接 |

暂停开始时 `poll.log` 里有 `⏸ 用量上限：<agent> 撞到用量上限（…），暂停派工到 <时间>`，之后每轮列出被跳过的
条目。只有暂停决定一轮派不派。

</details>

<details><summary>人要做的事</summary>

打开 daemon 留言的那个条目。到留言里写的解除时间之后，在右侧 Labels 里把 `pending/human` 换成留言指定的触发
标签（`pending/agent`、复审标签……）。提前换也可以：daemon 会等到解除时间再派。重新派工时续接这个角色登记的
原会话。到点后仍没被派、或又撞了上限，就让它留在 `pending/human`，看 daemon 的留言和 `poll.log`，不要来回切标签。

</details>

<details><summary>怎么认出撞上限</summary>

下面四样都成立才算，否则什么都不做（和没开这项一样）：

- 工作窗格最后一块输出是 CLI 的上限提示，后面只跟着 CLI 自己画在它下面的行（规则在 `scripts/usage_limit.py`，照 `tests/fixtures/usage-limit/` 里的真实截屏写的）；「You've used 99% of your session limit」这类提醒、codex 的「You have N usage limit resets available」都不是
- agent 空闲
- 会话是这个条目、这个角色登记的那条，而且它的记录里，本次派工开始之后的模型回复、工具输出、派工说明都不含这句话
- 连续两轮，屏幕和会话记录都没变

解除时间读自提示本身（claude：钟点加时区，如 `resets 4:50pm (Asia/Singapore)`；codex：
`try again at Aug 20th, 2026 11:35 AM`，按本机时区读）。读不出、或在 8 天以外的，改用固定等待
`USAGE_LIMIT_FALLBACK_SECS`（默认 3600 秒）；到点如果还在上限里，下一个撞上的 worker 会再被认出来。

</details>

<details><summary>要知道的限制</summary>

- 这条提示只出现在窗格里，会话记录里没有对应的标记，所以来源核对是「记录里看不到这句话是模型或工具打出来的」，不是证明。认错的代价：一个条目被留言并转给人（把标签改回即可），这个 agent 暂停到屏幕上读出的那个时间（可以按下面的命令手动解除）。
- 转人工不等于停止执行。现有的完工回收会在会话闲置满宽限时间后关掉它（对话保留，里面的后台命令随之结束）；带「到点自动继续」的 claude 可能到点自己接着干。
- daemon 的三次写入（留言、加 `pending/human`、摘 `doing/agent`）之间每次都重读。条目、它的 PR（目标分支、最新提交、来源）、标签或本机会话变了，daemon 就**停手，不撤回任何已经写上去的东西**。所以条目可能同时挂着 `pending/human` 和 `doing/agent`：它仍占一个名额，直到人摘掉 `doing/agent`。读不到不算变了：daemon 等下一轮接着做。
- CLI 一启动就退出的情况按普通的派工失败处理（没有以这种方式出现上限提示的真实样本）；**周**上限撞满的屏也没有真实样本——按同一结构匹配，没有实测过。

</details>

<details><summary>查看 / 手动解除暂停</summary>

暂停只在到点时结束，或者它的记录被删掉时结束——不会因为别的会话看起来在忙而提前结束。在 daemon 那台机器上
任意 shell 里执行（第一段什么都不用填）：

<!-- usage-limit-ops:begin -->
```bash
DIR="$HOME/.local/state/cavil-loop/usage-limit"
# 1. look: which agents are paused on this machine, until when / 查看：本机哪些 agent 在暂停、到几点
found=0
for f in "$DIR"/*.json; do
    [ -e "$f" ] || continue
    found=1
    row=$(jq -er '[.agent, (.until | floor | tostring), .account, .item, .source] | @tsv' "$f" 2>/dev/null) \
        || { echo "unreadable, the daemon treats it as no pause / 读不出，daemon 按没有暂停处理: $f"; continue; }
    IFS=$'\t' read -r agent until account item source <<<"$row"
    when=$(date -d "@$until" '+%Y-%m-%d %H:%M %Z' 2>/dev/null || date -r "$until" '+%Y-%m-%d %H:%M %Z')   # GNU date / BSD date
    echo "$agent  until $when  account=$account  seen-on=$item  time-from=$source"
done
[ "$found" = 1 ] || echo "no pause record on this machine / 本机没有暂停记录"
```

```bash
# 2. lift a pause by hand: set AGENT, then run / 手动解除：先填 AGENT 再执行
AGENT=claude
DIR="$HOME/.local/state/cavil-loop/usage-limit"
rm -f "$DIR/$AGENT"-*.json
left=$(ls "$DIR" 2>/dev/null | grep -c "^$AGENT-" || true)
echo "pause records left for $AGENT: $left  (0 = lifted / 0 = 已解除)"
```
<!-- usage-limit-ops:end -->

解除之后，下一轮轮询就会重新给这个 agent 派工；如果账号其实还在上限里，第一个撞上的 worker 会再被认出来、
暂停重新出现（没有需要回退的东西）。项目自己的进度文件是 `$STATE_DIR/usage-limit.json`（各条目的派工开始时刻、
做到一半的转人工）；转人工做到一半时别动它——那时删掉可能多出第二条留言。

</details>

## 重测试排队（可选，**默认关闭**）

多个条目的 worker 同时跑整套测试，内存和 CPU 会叠到整机卡死。配了这一项之后，项目里列出的「重测试」命令在同一个系统账号下一次只放行一套，其余排队；条目被清理、或起测试的 worker 结束后，它留下的测试会被停掉。默认关闭；在项目的 `cavil-loop.config` 里列出算重测试的命令（每行一条）即打开：

```bash
HEAVY_TEST_COMMANDS="bash tests/run.sh"
```

把 `HEAVY_TEST_COMMANDS` 留空（或删掉这一行）即关闭。

<details><summary>对 worker 有什么变化、怎么关</summary>

下一次派工起，worker 的提示词多一段，要求这些命令写成 `bash <skill>/scripts/heavy-test.sh -- bash tests/run.sh` 来跑；只跑一个测试文件不用排队。已经在跑的 worker 不受影响（它们的提示词是启动时定的）。关掉就把 `HEAVY_TEST_COMMANDS` 留空（或删掉这一行）。

</details>

<details><summary>怎么排的</summary>

- 每套测试放进 systemd 给它单独建的一个进程分组（`cavil-heavy-<编号>.scope`）。下一套要等前面每个「运行中」的分组里一个进程都不剩才开始——包装命令被强杀、被测程序关掉继承来的文件、子进程跑到后台或脱离进程组，都不会提前放行。等的时候每 30 秒打印一行在等哪个项目、哪个条目、跑了多久。
- 测试主进程退出后，包装命令把自己的分组整个停掉，留下的后台子进程一起结束。
- 分组状态只认明确的回答：「不存在 / 已停止」才算结束，查询失败、空输出、不认识的词一律当作还在跑。
- 运行记录本身读不出来、或内容不认识（十个字段缺了哪一行、同一个字段出现两次、状态不是「排队中 / 运行中」、分组名和编号对不上、项目 / 条目 / 代数这三项归属只有一部分）时，同样不当它「没在跑」：按编号查它的分组，分组确认消失才删这条记录；分组还在就一直挡着后面的排队和本账号下条目的工作树清理，并在排队提示和轮询日志里指出是哪个文件。`--list` 里它显示为「读不到」，确认去向后用 `--stop <编号>` 停掉即可。
- 不保证先到先得，只保证不重叠。`HEAVY_TEST_LOCK_WAIT=<秒>` 设排队上限，到时退出码 75；默认 0 = 一直等。

</details>

<details><summary>条目结束时怎么清</summary>

- 派工（建工作树、起 worker、记下这次启动）和 `cleanup-issue.sh`（停会话、停测试、删工作树）整段拿着同一把条目锁，只能一先一后。等不到锁（默认 60 秒）时，派工本轮不派、标签不动，清理什么都不动并以非 0 退出。
- 每个条目有一个「代数」，清理一拿到锁就加一。worker 启动时带着当时的代数，测试登记和开跑前都要核对：对不上（条目在这个 worker 启动之后被清理过）就不启动，退出码 76。清理之后重新派出的 worker 拿到的是新代数，不受影响。
- 清理先停掉本条目还在排队 / 还在跑的重测试，确认分组消失后才删工作树。查不清或停不掉 → 保留工作树、非 0 退出；合并后的自动清理因此不记「已清理」，下一轮重试，PR 的 `Done` 标签也等到清理成功那一轮。
- 每次起 worker 记下它的进程号和启动时间（起之前先登记，起来后补上进程号）。每轮轮询据此检查：worker 进程已经不在（或那个进程号现在是别的进程）而它起的测试还在排队 / 运行，就整组停掉。worker 还在、或认不清，都不停。确认结束的启动记录只盖章不删，所以那个 worker 留下的迟到请求再来排队也不会启动（退出码 76）；记录到条目清理时才删。

</details>

<details><summary>查看谁在占、手动停一套</summary>

<!-- heavy-test-ops:begin -->
```bash
SKILL="$HOME/.agents/skills/cavil-loop"
IDF="$(mktemp)"
bash "$SKILL/scripts/heavy-test.sh" --id-file "$IDF" -- sleep 120 &
while [ ! -s "$IDF" ] && kill -0 $! 2>/dev/null; do sleep 0.2; done
bash "$SKILL/scripts/heavy-test.sh" --list
bash "$SKILL/scripts/heavy-test.sh" --stop "$(cat "$IDF")"
wait
bash "$SKILL/scripts/heavy-test.sh" --list
rm -f "$IDF"
```
<!-- heavy-test-ops:end -->

上面依次是：跑一套（这里用 `sleep 120` 代替真的测试命令），让它登记后把**自己的运行编号**写进一个临时文件；等到编号写出来；列出本账号下登记着的全部运行（编号、排队中 / 运行中、分组状态、项目和条目、命令、已多久）；按那个编号把刚才这一套停掉（它的命令以 143 退出）——它还在排队也一样停得掉；再列一次。别的条目的运行这时可能也在列表里，这几条命令不会碰它们：要停哪一套，一律拿编号指定，不要从列表里挑「第一条运行中的」——那很可能是别的条目的。平时只想停某一套时，先 `--list` 看清项目、条目和命令，再 `--stop <它的编号>`。`--stop` 只在确认分组已消失后才删记录；查不到分组状态时不发停止请求，报错并保留记录。

</details>

<details><summary>边界</summary>

- 完整效果需要 Linux + cgroup v2 + systemd 用户实例。明确没有这些的环境（不是 Linux、不是 cgroup v2、没装 `systemd-run` / `systemctl`、这个账号没有用户实例的 socket，例如 macOS）只排队包装命令本身：不建分组、不登记、不清理，运行时打印一行说明。用户实例在、只是这一次没问到，或建不出分组时，包装命令以 70 退出、不跑测试——不会悄悄降级，因为降级模式看不到已有的分组，上一套还在跑也会照样开始。降级模式下如果还留着登记着的运行，同样以 70 退出：确认它们都已结束后删掉 `~/.local/state/cavil-loop/heavy-test/runs/` 里的记录再重试。
- 「整机」指同一个系统账号：排队锁和运行记录在 `~/.local/state/cavil-loop/` 下（`heavy-test.lock`、`heavy-test/runs/`），不同账号互不排队。
- 只管通过包装命令起的测试。worker 直接跑、开发服务器、别的后台进程都不排队也不会被停。
- 测试搬进自己的分组后，不再受 tmux 窗格分组上配的内存上限约束。需要上限时用 `HEAVY_TEST_SCOPE_PROPERTIES="MemoryMax=6G"`（空格分隔的 systemd 属性），默认不加。
- 强制清理（`--force`）一个 worker 正在干活的条目，会停掉那个 worker；条目锁保证的是清理不会和「正在启动」交错。

</details>

<details><summary>关掉之后留下什么</summary>

`HEAVY_TEST_COMMANDS` 留空后，之后的派工不再带这一段、不再拿条目锁。关掉之前起的 worker 仍可能通过包装命令跑测试，它们照常排队；这些还登记着的运行在条目清理和每轮轮询时照样会被停掉，不需要手动处理，要立刻停就用上面的 `--stop`。项目状态目录里留下的 `item-locks/`、`item-gen/`、`worker-launch/` 不用删。

</details>

## base 分支测试工作流失败自动报告（**默认关闭**）

列出的测试工作流在 base 分支上合并之后变红（两个各自通过的 PR 合在一起坏了、环境变了、偶发失败）时，
daemon 给它开一条 issue，或在同一原因的那条开着的报告上追加评论。默认关闭；填上
`CI_FAILURE_REPORT_WORKFLOWS` 就开启，留空就关闭（关闭前先看下面的「关闭这项功能」）。

```bash
CI_FAILURE_REPORT_WORKFLOWS="tests.yml"   # 工作流文件名，空格或逗号分隔；留空 = 关闭
CI_FAILURE_REPORT_BRANCH="main"           # 看哪个分支上的运行
CI_FAILURE_REPORT_DISPATCH=false          # true：新开 / 重开的报告打派工标签
CI_FAILURE_REPORT_MAX_FIX_ATTEMPTS=2      # 这么多个不同的修复 PR 合并后仍然红 → 交人
```

<details><summary>开启之前</summary>

- 已经自己会报告的工作流不要写进来（本仓库的 `release.yml` 就是）。
- **一个仓库只在一台机器上开**：下面的「不派工名单」存在本机，另一台轮询同一仓库的机器仍可能把正在
  交人的报告派出去（只在 `CI_FAILURE_REPORT_DISPATCH=true` 时有这个问题）。
- **依赖**：除了 daemon 本来就要的工具，还需要机器上有 `python3`（只用标准库）。没有它时检查不运行
  （每轮一行日志），本功能的报告一律不派工。
- **令牌。** 读用 `GH_TOKEN`：要能读 Actions 运行和检查标注（fine-grained：*Actions: read*、
  *Checks: read*）。遇到限流就等过去，不会报成权限问题；普通的 403 / 404 每天记一次日志。

</details>

<details><summary>看什么</summary>

列出的工作流在那个分支上、由推送触发、在开启那一刻及之后创建的运行。只看每次运行的第一次尝试：
重新运行不管红绿都不写任何东西。检查每 5 分钟一次，在主轮询里做（持着轮询锁、在空闲退避闸门
**之前**，所以主轮询退避时它照样按自己的钟走）。停机之后从上次完整核对到的位置接着看，不会跳过，
只是报告晚到。

</details>

<details><summary>一次红的运行落到哪</summary>

从上往下第一条命中的：

| 这次运行 | 落到 |
|---|---|
| 它的提交是某个 PR 的合并提交，PR 正文引用了某条报告（`Closes` / `Fixes` / `Resolves` / `Refs #N`，关键词和编号在同一行） | 那条报告：「修复 #P 合并后仍然失败（第 k 次）」。已按「已完成」关闭的会被重开。按修复 PR 计次 |
| CI 把失败的测试标全了，而且和某条开着的报告完全相同 | 在那条报告上追加评论 |
| CI 标全了，没有开着的报告对得上 | 新开一条报告 |
| CI 的清单不完整（有失败任务没有错误标注，或某个步骤正好 10 条——GitHub 每步最多留 10 条） | 本工作流唯一一条开着的「原因未确认」报告，它明写这些失败不代表是同一个原因 |

所以「同一个原因」指的是「失败的测试文件相同」（本仓库 `tests/run.sh` 标出来的粒度）：同一个测试
文件里两处不同的断言坏了，会被当成一个原因。工作流重新转绿时，每条开着的报告会收到一条「已转绿」；
报告不会被自动关闭。被关成「不做 / 重复」的报告不再动它。

</details>

<details><summary>交人</summary>

不同的修复 PR 失败达到 `CI_FAILURE_REPORT_MAX_FIX_ATTEMPTS` 次时，报告先进本机的**不派工名单**，
然后评论里写明、摘掉派工标签、加上 `pending/human`。在名单里期间，三个派工入口（标签、greedy、托管）
都不会为它启动 worker，不管它身上是什么标签。交人确认完成后出名单；或者只要有人改了它的流程标签、
关闭了它，也出名单，之后 daemon 不再动它。正处在别的流程里的报告（`doing/agent`、复审、等前置……）
留在名单里不动，等那边有变化。

</details>

<details><summary>日志摘录与时限</summary>

日志摘录是不可信文本：去掉时间戳和颜色控制符，令牌样式打码，只留最后 80 行 / 6000 字符，让伪造的
隐藏标记失效，再放进围栏比其中最长的反引号串还长的代码块。

这里不用 coreutils 的 `timeout`（macOS 没有）：检查程序自己给每次 `gh` 调用设时限（60 秒）、给整轮设
预算（90 秒），主轮询用 bash 内建等它，超过预算 120 秒还不退就把它连同它起的 `gh` 等进程整组停掉，
等到一个不剩才往下走（之后不会有迟到的写入）。

</details>

<details><summary>状态文件与查看方法</summary>

`$STATE_DIR/ci-failure-report.json`（故意不放进 `state.json`）记着每个工作流的开启时刻、运行完整
核对到哪、还没处理完的运行，以及不派工名单。这样看：

<!-- ci-failure-report-ops:begin -->
```bash
KEY=myproject    # the instance name / 实例名: systemctl --user list-timers 'cavil-loop-poll@*'
SKILL="$HOME/.agents/skills/cavil-loop"
ENV_FILE="$HOME/.config/cavil-loop/$KEY.conf"
[ -f "$ENV_FILE" ] || ENV_FILE="$HOME/.config/coding-agent-work-loop/$KEY.conf"   # installed before the rename / 改名前装的
CONF=$(sed -n 's/^CODING_AGENT_CONFIG=//p' "$ENV_FILE" | tr -d '"')
CODING_AGENT_CONFIG="$CONF" bash "$SKILL/scripts/ci-failure-report.sh" --list
```
<!-- ci-failure-report-ops:end -->

</details>

<details><summary>状态文件丢失或损坏时</summary>

这个文件丢失或损坏时（而 GitHub 上已经有本功能的报告），daemon 不去重建它——它已经决定但还没写到
GitHub 的那部分，从 GitHub 上读不回来。它会暂停：不检查、不写，本功能的报告一律不派工，并开一条
提示 issue（`pending/human`），列出每条开着的报告和它的标签。**从丢失到重新开始之间的失败不会被
报告**（这段时间自己看一眼 Actions 页面）；做到一半的交人不会续做，那条报告的标签由人来定。然后从
当前时刻重新开始：

<!-- ci-failure-report-restart:begin -->
```bash
KEY=myproject    # the instance name / 实例名: systemctl --user list-timers 'cavil-loop-poll@*'
SKILL="$HOME/.agents/skills/cavil-loop"
ENV_FILE="$HOME/.config/cavil-loop/$KEY.conf"
[ -f "$ENV_FILE" ] || ENV_FILE="$HOME/.config/coding-agent-work-loop/$KEY.conf"   # installed before the rename / 改名前装的
CONF=$(sed -n 's/^CODING_AGENT_CONFIG=//p' "$ENV_FILE" | tr -d '"')
CODING_AGENT_CONFIG="$CONF" bash "$SKILL/scripts/ci-failure-report.sh" --restart
```
<!-- ci-failure-report-restart:end -->

成功时它打印 `已从当前时刻重新开始`；下一轮轮询会在提示 issue 上留言并关闭它。失败时它什么都不改、
暂停保持原样——修好原因再跑一次。没有处在暂停中时它拒绝执行。修复次数是从报告的评论里数出来的，
重新开始之后不会丢。

</details>

<details><summary>关闭这项功能</summary>

先跑上面的 `--list`，等到它打印 `不派工名单：空`：配置留空之后名单既不被查也不再处理，正在进行的
交人会停在半路。然后把 `CI_FAILURE_REPORT_WORKFLOWS` 留空。以后再填上，会从留着的状态文件接着看。

</details>

## GitHub 令牌脱敏

worker 的环境里有 GitHub 令牌，agent 运行时可能把它原样打印出来（执行 `env`、调试 `gh`、报错带出请求头）。daemon 把会留下这类输出的文件里的 GitHub 令牌替换掉，匹配规则只有一份（`scripts/redact_tokens.py`）。daemon 自己的日志始终处理；另外两处各有开关（见下表）。

<details><summary>处理哪些文件</summary>

| 文件 | 谁写的 | 怎么处理 | 开关 |
|---|---|---|---|
| `poll.log`、窗格历史（`$STATE_DIR/sessions/*.log`） | daemon | **落盘前**替换 | 始终开着 |
| claude / codex 的会话记录（`~/.claude/projects`、`~/.codex/sessions`） | agent 的 CLI | 每 10 分钟扫一次、**原地**替换，只碰工作目录在本项目 `WORKTREE_BASE` 之下的会话 | `REDACT_AGENT_RECORDS`（默认开；留空 / `false` = 不改） |
| codex 的环境快照（`~/.codex/shell_snapshots/*.sh`） | codex | 不改：起 codex worker 时关掉这项功能（`--disable shell_snapshot`），**不再产生新快照**；已有的清一次（见下一节） | `CODEX_SHELL_SNAPSHOT`（默认 `off`；`on` = 保留 codex 的默认行为） |

</details>

<details><summary>每一处具体怎么做</summary>

- `poll.log` 和窗格历史：日志函数、清理钩子的输出、tmux 报错、秒退 / 信任框截屏、迁移时并入的旧日志、窗格历史的实时写入，写盘前都先过同一个入口。
- 会话记录：只改令牌那几个字节，文件长度不变、不改名、不删、不留备份。

</details>

<details><summary>替换后的样子，以及扫描记录</summary>

替换后的样子是 `REDACTED-<12 位指纹>`，后面用 `-` 补到和原令牌一样长。指纹是令牌 sha256 的前 12 位：推不回原文，同一把令牌在所有文件里指纹相同，可以用来认「是哪一把」：

```bash
printf '%s' "$GH_TOKEN" | sha256sum | cut -c1-12
```

每次扫描替换了东西，`poll.log` 里有一行 `令牌脱敏：N 个文件里替换了 M 处（指纹 …）`。扫描位置记在 `$STATE_DIR/redact-scan.json`、上次扫描时间在 `$STATE_DIR/redact-scan.stamp`；两个都删掉 = 下一轮从头扫一遍（已替换的不会再变）。

</details>

<details><summary>会话记录为什么敢原地改</summary>

周报和用量 footer 都读这些文件，agent 的 CLI 还一直开着它追加。替换只动令牌所在的字节，换上的字符和令牌是同一类（字母、数字、`-`），所以任何时刻读到的每一行都是同样结构的 JSON；用来认领记录的字段（工作目录、会话编号、请求编号、时间、模型等）里的串即使长得像令牌也不改。`tests/token-redaction.test.sh` 在替换写到一半时跑真实的周报采集，结果与替换前逐字节相同。

</details>

<details><summary>不处理的范围（原文可能仍在）</summary>

- 不带前缀的老格式令牌（40 位十六进制）：和提交哈希无法区分，不认
- 窗格历史是终端原始输出：令牌被终端折行、或中间夹了控制码时认不出（紧跟在颜色控制码后面的认得）
- 升级前就在跑、且认不出 worker 窗格的会话（人分过屏、又没有窗格记录）：日志管道不会被换成过滤版，它之后写下的原文只能靠定期扫描事后替换
- 工作目录不在 `WORKTREE_BASE` 之下的会话（人自己手动开的 claude / codex）、claude 的输入历史和文件改动备份、cursor / opencode 的记录
- GitHub 令牌以外的密钥（例如 codex 快照里的其他登录令牌）
- 替换脚本本身起不来时（例如本机没有 `python3`）：daemon 的日志入口只写一行 `令牌替换失败…已丢弃`，窗格历史不再写入——宁可缺记录，不落原文

</details>

### 清理 codex 已有的环境快照

新起的 codex worker 不写快照，但以前写下的还在，每一份都有 `GH_TOKEN` 原文。用下面的命令清一次；它只在**本机当前用户没有任何 codex 进程**时才动手，因为正在跑的 codex 还会读它自己的快照，令牌换掉后它的 `gh` 就全用假令牌了。

<details><summary>清理命令和结果怎么看</summary>

有 codex 进程在跑、或进程清单读不到时，脚本列出原因并退出，一个文件都不改。先让 codex worker 干完活（或停掉列出的进程），再原样运行：

<!-- redact-ops:begin -->
```bash
SKILL="$HOME/.agents/skills/cavil-loop"    # the installed skill / 装好的 skill 目录
SNAPS="$HOME/.codex/shell_snapshots"
with_token() { grep -lE 'gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{82}' "$SNAPS"/*.sh 2>/dev/null | wc -l; }
echo "snapshots holding a token before / 清理前带令牌的快照: $(with_token)"
if bash "$SKILL/scripts/redact-snapshots.sh" --check; then
    bash "$SKILL/scripts/redact-snapshots.sh"
fi
echo "snapshots holding a token after / 清理后带令牌的快照: $(with_token)"
```
<!-- redact-ops:end -->

看到 `完成：N 个快照文件，其中 M 个含令牌，共替换 K 处` 且最后一行是 0 就清完了。看到 `❌ 本机还有 codex 进程在跑` 说明什么都没改：等它列出的进程结束后重跑。替换不可撤销（没有备份），也不需要撤销：令牌本身没变，worker 的环境里照旧有它。`--check` 只检查、不改文件。

</details>

## 合并后的对话复盘

PR 合并后，一条后台队列让模型通读这个 PR 的全部讨论，在来源项目里写一份报告 `docs/retrospectives/pr-N.md`，
并更新项目的计次经验文件，之后的派工和复审说明都会带上它。`POST_MERGE_RETROSPECTIVE=true` 才打开；设为 `false`
暂停（保留队列）。需要 Python 3、支持 safe mode / 结构化输出的 Claude CLI 和来源项目的推送权限。

<details><summary>读什么、写什么、写到哪</summary>

- 首次运行记录启用时间，后续分页扫描更新过的 closed PR，只处理之后合并的；不补跑历史、不处理未合并关闭项，
  也不依赖自动 cleanup。
- 分页采集关联 issue、普通评论、review、行内评论。Claude（`RETROSPECTIVE_MODEL=sonnet`）没有工具或 MCP 权限。
- 固定发布程序只提交 `docs/retrospectives/pr-N.md` 和 `.agents/skills/cavil-loop/prompts/lessons.md`（配了项目
  命令时再加上它的改动，见下）到**来源项目自己的仓库** `origin/$BASE_BRANCH`（默认 main），使用隔离 worktree、
  仅 fast-forward 推送。项目经验从该项目远端读取，只加载进该项目的 prompt，位于项目增量要求之前。
- 公开 cavil 仓库的 `prompts/lessons.md` 只保留经过独立审查、脱离项目也成立的公开流程原则。自动发布程序不会向
  cavil 写入生成的项目内容、标识、链接或复盘。通用改进候选先保存在项目报告中，另行去项目化审查后才能公开。证据
  保存在来源项目和本机状态目录。
- 不修改旧评论或业务 worker 标签。

</details>

<details><summary>计次经验文件：编号、出现记录、升级</summary>

项目经验是一本按 PR 计次的错题本（格式与校验见 `scripts/retrospective_lessons.py`）：每条规则有永久编号
`L<n>`，所在段落（`硬规则` / `待确认` / `观察中`）就是它的状态，`Seen N×` 列出出现过它的不同 PR。

- 模型每次只能给规则追加**本次 PR** 的一次出现，并且必须附上本次采集到的某条评论 / review 的链接作为证据；
  已有规则的「规则」「适用」字段、编号和旧的出现记录都不能改，含义不同只能新开一条从 1 次起算。
- 在 3 个不同 PR 里出现、并且字数在下面所说的上限以内的规则由程序升级（超长的先留在 `观察中` 等着）：
  `RETROSPECTIVE_PROMOTION=auto`（默认）直接进 `硬规则`，`confirm` 只进 `待确认`、由人手改文件挪进 `硬规则`。
  违反任何一条，整份输出作废。自审与交叉 review 模板要求逐条核对 `硬规则`。
- 项目里的 lessons.md 还是不计次的旧格式时，复盘在调模型之前就跳过、不计失败次数，一小时后再查，等项目迁移完
  自动补上。

</details>

<details><summary>派工说明里带的是裁过的版本</summary>

计次格式的文件（有 `<!-- next-id: N -->` 这一行）只带开头说明，以及 `硬规则` / `待确认` 每条的编号、规则、
适用、为什么；整段 `观察中`、每条的「这样做是对的」举例和 `Seen` 出现记录只留在文件里，末尾一句告诉 agent 去哪读。
没有 `next-id` 行的文件（skill 自带的通用经验、手写的文件）原样带。文件本身不变，复盘读写整份。

</details>

<details><summary>升档时的单条字数上限（<code>RETROSPECTIVE_RULE_MAX_CHARS</code>）</summary>

`RETROSPECTIVE_RULE_MAX_CHARS`（默认 300，`0` = 不限，留空 = 300）限制要升档的条目：「规则」「适用」「为什么」
三栏合计的字符数（一个汉字算 1，不算 `- 规则：` 这类前缀）。

- 挪段由复盘程序做，不靠模型：刚攒够 3 个 PR、字数在上限内的，进 `硬规则`（`auto`）或 `待确认`（`confirm`）；
  超了的留在 `观察中`，编号记进 next-id 正下方的一行 `<!-- held-over-limit: L12 L34 -->`，报告末尾由程序追加一段
  （编号、字数、上限、怎么处理），`retrospective.log` 也记一行（`rule length limit 300: held back L12(312)`）。
  模型可以把「为什么」改写短，那一轮就按改写后的字数判断；「规则」「适用」不许模型改。
- 被挡下的条目达标之后——人在主干上把它压短了、调高了上限、或改成 `0`——下一次复盘（任一 PR 合并后）就把它
  补升到当前模式对应的段，并从那一行去掉。
- 想让某条一直留在 `观察中`，从那一行删掉它的编号；删的是最后一个编号时，留下空的 `<!-- held-over-limit: -->`
  或删掉整行都可以，下一次复盘不再写这一行。还列着编号时删掉整行，所有被挡下的条目都不再补升。
- 那一行里不够格的编号（找不到这条、不在 `观察中`、不足 3 个 PR——手工往里加编号不会让它升档）会被去掉，并在
  报告里列出。已经在 `硬规则` / `待确认` 的条目不量字数、也不会被挪回去。
- 这一行不给模型看、不进派工说明；模型交回的文字里自己带了这一行，整份作废（计一次）。人手改坏了这一行（格式
  不对、出现两行、挪到了 next-id 上面或写进了段里），复盘在调模型之前就停下、不计失败次数、一小时后再查，任务的
  错误信息里写明是第几行——改对或删掉这一行即可。

</details>

<details><summary>上限填错了</summary>

填的不是 0–100000 之间、按普通十进制写的整数（不带正负号、不带前导 0：写 `300`，不是 `0300` 或 `+300`）时，
每一轮复盘在读队列之前就停下：`retrospective.log` 末尾是
`RETROSPECTIVE_RULE_MAX_CHARS must be an integer from 0 to 100000 written without leading zeros, not '…'`，
之后不再出现新的复盘记录；队列里每个任务的状态和重试次数都不变。在项目配置里把这一行改对（或删掉这一行，= 300；
客户端「项目配置」弹窗里也能改）。成功的标志：下一轮轮询后 `retrospective.log` 出现 `retrospective PR #N started` /
`committed` 这样的新记录，不再出现填错的那一行。不用手改任务文件：等着的任务按原来的重试次数接着跑。

</details>

### 目录经验与只复盘哪些 PR

`RETROSPECTIVE_DIRECTORY_LESSONS` **默认打开**：复盘只处理「开关在本机生效那一刻及之后」合并的 PR，每个都可以把
和它改过的目录相关的经验写进经验文件末尾的 `## 目录经验` 段。设为 `false` 就复盘队列里所有 PR、不写目录经验。

<details><summary>哪些 PR 会被跳过，每一轮怎么给队列分类</summary>

- 开关生效前合并、还在队列里等的 PR 会在任务文件里标成 `skipped`（保留，不删），**永远不会被复盘**：没有复盘
  报告，也不计入任何经验次数。文件里没有 `## 目录经验` 这一段时复盘会自己补上。
- 关掉开关时复盘队列里所有 PR，不写目录经验（已有的这一段一字不改：根本不交给模型）。关掉再打开会重新计时，
  关着期间合并、还在排队的 PR 同样被跳过。开关写成 `true` / `false` 以外的值，复盘在读写任何东西之前就报错停下。
- 每一轮先把整个队列分类一遍（所有未结束的任务，不看排队位置和重试时间；主干上已经有报告的算完成；合并时间或
  主干上的报告读不出的任务原样留到下一轮），再最多复盘一个。
- 开始时间按机器记在 `$STATE_DIR/retrospectives/directory-lessons.json`（不进 `cursor.json`）；换机器或文件丢了，
  就从那一刻重新计时。开关打开时这个文件读不出或写不进，整个队列这一轮暂停（日志写明文件位置）——因为判断不了
  哪些该跳过。

</details>

<details><summary>目录经验的条目格式</summary>

目录经验的条目格式与前三段一样、共用 `next-id`，区别是每次记录写明发生在哪些目录：
`- Seen 2×: #1460 <链接> [server/credits/] · #1471 <链接> [server/credits/ · server/usage/]`。

- 目录相对仓库根、以 `/` 结尾；每条新记录至少写一个，且必须是合并后目录树里真实存在的目录（不许绝对路径、
  `..`、`.git`、指出仓库的链接）。
- 旧条目和旧记录（包括目录）一字不改；同一 PR 在一条里只记一次；把流程经验原样抄进这一段会被拒；模型自己加
  这个标题会被拒。
- 这一段不参与升级，条目不进不出。各目录的次数由项目自己从记录里筛；派工拼说明时跳过这一段，这些经验只经项目
  自己的各层目录说明到达 agent。
- 24000 字的上限算的是除这一段以外的整份文件（不是派工说明里裁过的版本），这一段另有 24000 字上限。

</details>

<details><summary>关掉开关却没记下来时：重新计时</summary>

关掉开关会留下记录（时间文件写成「关」、或删掉、或在 `cursor.json` 里留一个标记——时间文件读不出时一律留标记，
那个文件原样不动）。因为这个标记而记下的开始时间会记住是哪个标记，标记之后没清掉，下一轮也只是再清一次，不会当成
又关过一次。如果这一轮三处都写不进去，队列暂停，`retrospective.log` 会写明原因和文件位置；之后如果没人处理就把开关
改回打开，会沿用旧的开始时间，关着期间合并的 PR 可能被复盘并写上目录经验。要重新计时，按下面的顺序做（停下 → 留证据
→ 重置 → 重启）：

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

每一步只在上一步成功后才执行。怎样算成功：整段打印 `reset done`，之后 `retrospective.log` 里下一行是
`directory lessons on: handling PRs merged at or after <时间>`，时间晚于这次重置。第 2 步拿到的复盘扫描锁一直持有到
第 4 步结束，备份和重置期间不会有复盘在跑。三种结果：

- `reset done`——全部完成。
- `reset done, but the poller did NOT start again`——重置已经完成（时间文件已删、备份保留），只是重启失败：照打印出的
  `systemctl --user start` 命令再启动一次。
- `reset FAILED`——出错那一步之后都没执行，重置没有发生：停止那一步失败，轮询保持原状；之后的步骤失败，轮询保持停止，
  时间文件和 `cursor.json` 都没动（备份失败不会删任何东西）。修好原因（磁盘、权限——时间文件读不出时也备份不了）后，
  把整段重新执行一遍。

改名前的老安装，定时器叫 `coding-agent-poll@<项目>.timer`。重置救不回已经按旧时间写进去的目录经验：在主干上看经验文件的
`git log -p`，找那段时间的 `docs: learn from` 提交，手工删掉写错的条目（人工编辑就是下一轮的新基线）。

</details>

### 复盘后执行的项目命令（可选）

`POST_RETROSPECTIVE_PROJECT_CMD`（留空 = 关闭）在复盘的临时 checkout 里、报告和经验写好之后、提交之前跑一条项目自己
的命令——比如把目录经验排名后写进各层 `AGENTS.md` 的脚本。它的改动进同一个提交。它按运行 daemon 的本机用户权限执行，
只配置可信命令。

<details><summary>命令拿到什么，什么情况算复盘失败</summary>

- 在 checkout 根目录用 `bash -c` 执行，时机是报告和经验文件校验通过并写好之后。它拿到 `RETROSPECTIVE_PR`、
  `RETROSPECTIVE_LESSONS_FILE`、`RETROSPECTIVE_REPORT_FILE`（相对仓库根的路径），限时 10 分钟。
- 它改动或新建的文件和报告、经验文件进**同一个提交**，仓库忽略规则排除的文件除外——脚本留下多余文件是脚本的 bug，要修。
- 非零退出、超时、改了校验过的报告或经验文件、自己提交，都算本次复盘失败：什么都不推、临时 checkout 删掉，按原有
  规则重试（一小时一次、共 3 次；每次重试都会重新调模型）。成功时日志记下输出末尾，失败时输出末尾进失败原因。
- 临时 checkout 是从主干新取的，没有 `node_modules` 这类没提交的东西。
- **它按运行 daemon 的本机用户权限执行**：复盘自己用的 GitHub 令牌（`GH_TOKEN` / `GITHUB_TOKEN`）不传给它，但这不是
  隔离——本机已有的 `gh` 登录、git 凭据它仍然用得到，它绕开这个 checkout 直接推送也拦不住。

</details>

### 并发、重试与状态

本机所有项目最多同时一个复盘；同一个 PR 连续失败 3 次就停下，需人把任务文件的 `status` 改回 `pending`。状态、证据、
重试信息位于 `$STATE_DIR/retrospective.log` 和 `$STATE_DIR/retrospectives/`。

<details><summary>细节</summary>

- 全机锁是 `~/.local/state/cavil-loop/retrospective.lock`，与部署方式无关。
- 模型超时 30 分钟，失败一小时后重试；停下的 PR 在任务文件里记为 `status: failed`，原因在日志里。
- 项目远端报告作为完成标记。

</details>

## 按需 preview（socket 激活）

给每个待验收的 issue 一条可点的预览 URL，又不为每个 open 的 issue 常驻一份 web server：URL 一直在监听，
app 在第一次访问时才起、闲置到点再停。默认关闭；配了 `PREVIEW_EXEC`（启动 app 的命令）就打开，用
`scripts/preview-serve.sh` 注册一个 preview，由清理挂点注销。

<details><summary>命令：注册、查看、手动注销、在清理挂点里注销</summary>

手动操作：

```bash
bash scripts/preview-serve.sh 791          # 注册 + 起监听，打印 URL
bash scripts/preview-serve.sh 791 --warm   # 顺便立刻预热（验收前想省那 1 秒）
bash scripts/preview-serve.sh --list       # 本项目所有 preview 及其死活
bash scripts/preview-unserve.sh --issue 791  # 手动注销：预期 worktree 按配置推算 #791 的那个
```

在清理挂点里（`CLEANUP_HOOK` 指向的脚本，放在项目自己的目录里）按技能的安装路径调用脚本，并且一定要带上挂点拿到的 worktree。挂点收到的是真实的 `ISSUE` 和 `WORKTREE`；不带
`--expect-worktree` 时脚本按配置推算该编号的 worktree，遇到同号但不同 worktree 的情况可能注销别人的 preview：

<!-- preview-unserve-hook:begin -->
```bash
# CLEANUP_HOOK script: deregister this item's preview / 清理挂点脚本：注销本条目的预览
# An empty WORKTREE means "not trusted": skip, exit 0 / WORKTREE 为空表示不可信：跳过，退出 0
if [ -n "${WORKTREE:-}" ]; then
    cd "$PROJECT_ROOT" || exit 1
    bash "$HOME/.agents/skills/cavil-loop/scripts/preview-unserve.sh" --issue "$ISSUE" --expect-worktree "$WORKTREE"
fi
```
<!-- preview-unserve-hook:end -->

端口、主人或 worktree 对不上，一律不注销。改名前的安装，技能在旧路径下，换成那个路径。

</details>

<details><summary>为什么用 socket 激活，各个单元怎么接</summary>

每个 issue 起一个常驻 `tmux` session 跑 web server，没人看的时候也占着内存——10 个等验收的 issue 就是 10 个空转的
server，接近 1 GiB 内存。socket 激活把「URL 常在」和
「进程常驻」拆开：

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

</details>

<details><summary>什么时候才打印地址</summary>

**只有真起来了才给地址。** 任何一步没成功（监听起不来、`--warm` 时 app 起不来、或预热请求经公开
端口拿不到 2xx/3xx），`preview-serve.sh` 非零退出、**不打印 URL**，并把那个单元最后 20 行日志打到
stderr。不带 `--warm` 时只确认监听已经起来——app 要等第一次访问才拉起，所以输出里会写明「尚未实际
访问验证」；交给人看之前想确认页面能打开，就带 `--warm`。预热请求的超时是 `PREVIEW_PROBE_TIMEOUT`
（默认 30 秒）。

</details>

### 端口归属：取模之后的同端口

配了 `PREVIEW_PORT_MODULO`（例：1000）时端口是 `BASE + issue % MODULO`，同余 issue 共用一个端口，所以每个
端口都有记在 `<port>.conf` 里的**主人**（项目 + 完整 issue 号 + worktree）。规则只有一句：**谁都只动登记在
自己名下的端口；查不到登记就什么都不动**。

<details><summary>注册、注销碰到别人的端口时怎么办</summary>

例：issue 40 与 1040 都是 4040。

- `preview-serve.sh` 发现端口登记在别人名下（同余 issue 或别的项目）→ exit 2 并报出占用方，一个字节都不写
- `preview-unserve.sh --issue N` / `--port P --expect-issue N` 只注销主人三项全等的登记；
  没登记 → exit 0 不动；主人不符 → exit 3 不动。裸端口调用 `preview-unserve.sh <port>` 仍然可用，
  但预期主人取 cleanup hook 拿到的 `ISSUE` / `WORKTREE` env，缺了就拒绝
- 读登记 → 比对 → 写 conf / systemd / tailscale 全在同一把端口锁（`.port-<port>.lock`）里，
  注册与注销共用，并发注册恰好一个成功
- 没登记的遗留 tailscale 路由**不自动拆**：端口可能已被别的服务复用，按公式拆就是误伤。
  人工处理前先核对路由当前指向谁

守卫：`tests/preview-port-ownership.test.sh`。

</details>

### 三个必须知道的坑

app 必须从 `$PORT` / `$HOST` 读监听地址（拿到的是后端端口，不是公开端口），preview 的 conf 文件里每个值都要带
引号，app 单元里的就绪门不能删。

<details><summary>① app 拿到的是后端端口，不是公开端口</summary>

公开端口被 `.socket` 占着，app 再 bind 会 `EADDRINUSE`。`preview-run.sh` 注入的 `$PORT` = 公开端口 +
`PREVIEW_BACKEND_OFFSET`。所以 `PREVIEW_EXEC` 指向的进程**必须从 `$PORT` / `$HOST` 读监听参数**，端口写死的
app 接不进来。

</details>

<details><summary>② conf 文件的值一律带双引号</summary>

`~/.config/cavil-loop/preview/<port>.conf` 有两个读者：systemd 的 `EnvironmentFile=`（整行右侧都算 value，
不加引号也对）和 `preview-run.sh` 的 bash `source`（不加引号，`PREVIEW_EXEC=node server/index.mjs` 会被
解析成「带临时环境变量执行 `server/index.mjs`」，exit 127）。`preview-serve.sh` 已经处理好了，手改 conf 的时候
别踩。

</details>

<details><summary>③ 就绪门不能省</summary>

`Type=exec` 只保证 execve 成功，不保证已经 `bind`。少了 `cavil-loop-preview-app@.service` 里那行
`ExecStartPost=preview-wait.sh`，proxy 会在 node 还没听上时就转发，**首次访问稳定 502**——而且 app 慢启动
300ms 就能踩到，本地手测经常撞不上。

</details>

### app 起不来的时候

socket 会反复重触发，撞上 `TriggerLimitBurst` 后进 `failed`：**不再接受激活**，URL 静默变死。看 app 的日志、
改好配置，重跑 `preview-serve.sh`。

<details><summary>诊断和恢复</summary>

对 failed 的 socket，`systemctl start` 是 no-op，看单元状态看不出问题。诊断和恢复：

```bash
journalctl --user -u 'cavil-loop-preview-app@4791.service' -n 50
bash scripts/preview-serve.sh 791     # 内含 reset-failed，改完配置重跑就能恢复
```

</details>

### 跟 cleanup 的关系

preview 随 issue 生灭：`preview-serve.sh` 用 `systemctl start` 而不是 `enable`，重启后不会自动复活。issue
关闭时的注销要项目自己做——在项目的 `CLEANUP_HOOK` 里加一行 `preview-unserve.sh`。

<details><summary>cleanup hook 里那行注销</summary>

重启之后 worktree 多半已经被 `cleanup-issue.sh` 删了，所以 preview 不随开机启用。hook 里调
`preview-unserve.sh --issue "$ISSUE" --expect-worktree "$WORKTREE"`（**一定要带上 hook 拿到的实际
`WORKTREE`**：只传 `--issue` 时预期主人取配置推出来的路径，同号但不同路径的清理就能拆掉别人的登记；
`WORKTREE` 不可信时整个跳过注销，别退回默认路径）。这一条要自己加进 hook，`cleanup-issue.sh` 不知道你有没有
启用 preview。

</details>

## 评论配图的公网入口：只放行图片和视频

评论配图要能被 GitHub 抓到，所以资产目录（`review-shots`）经公网隧道对外开放。隧道后面要放自带的小服务 `scripts/public-assets/serve.mjs`，不要放普通静态文件服务。`setup.sh` 不装它：每台机器启用一次（步骤见下面的折叠块）。

<details><summary>为什么不能用普通静态文件服务</summary>

评论配图要能被 GitHub 抓到，所以资产目录（`review-shots`）要经公网隧道对外。**不要把这个目录直接交给静态文件服务器**（例如把隧道直接指到目录）：它会列出每个子目录里的文件名，也会把目录里的任何文件原样交出去——worker 顺手放进去的日志、测试报告、登录状态文件就等于公开了。往每个目录里放一个 `index.html` 挡列表也不可靠：新建的子目录会漏，而且挡不住文件类型。

</details>

<details><summary>自带小服务给哪些文件</summary>

用自带的小服务（`scripts/public-assets/serve.mjs`）挡在隧道后面：

- 只监听 `127.0.0.1`；只响应 GET / HEAD
- 只交出扩展名是图片 / 视频（`png jpg jpeg gif webp avif svg mp4 webm mov`）、**而且开头的字节确实是那种格式**的文件；`svg` 另查内容像 SVG 且不含凭证样式
- 任何目录、其他类型、改了扩展名的文件、路径里有 `.` 开头的段、符号链接指到目录外：一律同一个 404，不带原因；原因在本机日志里（`journalctl --user -u cavil-loop-public-assets`）
- 支持分段请求（视频拖动需要）

</details>

<details><summary>启用（整机一份）</summary>

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

</details>

<details><summary>发图前自查</summary>

发图前自查用 `node scripts/public-assets/check.mjs <目录或文件>`：逐个报公网拿不拿得到，任何文件里有令牌 / 密钥样式就点名并以退出码 1 结束（发布命令发布前也会跑；配了出图地址的项目，worker 不自己跑它，见下一节）。

</details>

### 目录规则、唯一的发布命令、服务端强制拦截

每张评论配图都只经一条命令 `scripts/publish-asset.sh` 发布，落在资产目录的 `<项目 key>/<条目编号>/` 下。严格模式（服务配置里 `PUBLIC_ASSETS_STRICT=1`）下服务只给这些文件和旧图清单里的旧图；daemon 会自己把机器切到严格模式（`switch.sh --auto`），写 `PUBLIC_ASSETS_AUTO_SWITCH=0` 可以停掉自动切换。

<details><summary>目录规则</summary>

**目录规则**：新发的图一律落在资产目录的 `<项目 key>/<条目编号>/<名字>-rev-<唯一戳>.<扩展名>`，周报是 `<项目 key>/weekly-report/<文件名>`。路径由 cavil-loop 定，worker 不起名、不选目录。项目 key 就是 `~/.config/cavil-loop/<key>.conf` 的名字。

</details>

<details><summary>发布命令</summary>

**发布命令**：评论配图和周报共用 `scripts/publish-asset.sh`（托管安装走长期入口 `~/.agents/releases/cavil-loop/entrypoints/publish-asset.sh`；`scripts/weekly-report/publish-asset.sh` 也能用，原样转发）。配了出图地址的项目，派工提示词里讲出图的两条（「怎么出图」「评论配图标准」）换成这一条命令，项目 key 和条目编号已写死：`bash '<入口>' --project '<key>' --item <编号> <图片>...`。它依次：

1. 读对外服务自己报告的状态，服务端拦截没生效就拒绝（原因写在 stderr）；目录取服务报告的实际目录，不猜；
2. 把文件复制成目标目录里的隐藏临时文件，**查这份副本**有没有凭证样式，有就删掉、拒绝；
3. 改名成最终名字，同名已存在就拒绝（不覆盖）；
4. 核对公网地址 HTTP 200 且下载到的字节数等于文件大小，不对就删掉刚放的文件、报错；
5. stdout 只打印地址，一行一个。

不是图片 / 视频的（周报 PDF 等）不公开，放进不公开目录的 `<项目 key>/<子目录>/` 下。

</details>

<details><summary>严格模式：服务端强制拦截</summary>

**服务端强制拦截（严格模式）**：对外服务配置里有 `PUBLIC_ASSETS_STRICT=1` 时，它只交出两类文件——项目子目录下的（key 必须是本机登记过的项目），或旧图清单里**路径和内容（SHA-256）都对得上**的旧图；每个文件整份读进内存，在这份内存上判格式、查凭证（所有类型，不只 SVG）、比清单，再从这份内存送出——检查过的就是送出去的。绕过发布命令直接拷进目录的文件，含凭证样式的不给；拷到项目子目录以外的新文件，一律不给。没有这一行时只按上面的基本规则（这也是切换失败时的退回状态）。

单文件上限默认 256 MB（`PUBLIC_ASSETS_MAX_BYTES=` 调），超过的不交出。

</details>

<details><summary>旧图：旧图清单</summary>

**旧图**：切换时把资产目录里不在项目子目录下的全部图片 / 视频登记成旧图清单（相对路径 + 大小 + SHA-256），写两份：配置目录里的 `public-assets-legacy.json` 和 `~/.local/state/cavil-loop/public-assets/legacy.json`；清单的校验值写进服务配置的 `PUBLIC_ASSETS_LEGACY_SHA=` 一行。**这一行就是唯一的可信状态**：有它 = 清单已生效、以它为准、永不重建；没有它 = 从未生效、可以重建。

- 改权限、改修改时间、按原路径原内容从备份还原：旧图照常能打开；
- 改名、挪位置、换内容：旧图变 404（已发评论里的那张会破）；
- 一份清单坏了：服务用另一份，再跑一次切换会把好的那份复制回去；
- 两份都坏、或校验值那一行格式不对：旧结构一律 404，日志写原因，切换命令不重建——从备份找回任一份（校验值对上即可）；只有人决定时才删掉校验值那一行重建（重建会把此刻目录里项目子目录以外的文件都当旧图）。

</details>

<details><summary>切换到严格模式，以及自动切换</summary>

**切换**：

```bash
bash ~/.agents/skills/cavil-loop/scripts/public-assets/switch.sh --status   # 只读：配置、服务、拦截是否生效、代码是否一致、清单状态
bash ~/.agents/skills/cavil-loop/scripts/public-assets/switch.sh --verify   # 放几个测试文件经本机端口和公网地址各查一遍，再删掉；不改配置
bash ~/.agents/skills/cavil-loop/scripts/public-assets/switch.sh            # 执行切换：备份配置 → 建 / 核对清单 → 写严格模式 → 重启 → 核验；失败自动退回老规则
```

切换命令核验通过后另写一份验收记录（状态目录里的 `accepted.json`，记的是核验时那个服务进程）。**只有服务在严格模式、而且验收记录对的正是现在这个进程，才算拦截已生效**：切换在核验之前被中断、服务自己重启过，都会让它变成「严格模式在跑、核验没完成」，这时发布命令不发图，自动切换会重新核验。

只配了早期周报图片地址（`WEEKLY_REPORT_ASSET_URL`）、没配出图地址的项目，切换命令一律不切换、点名这些项目：严格模式下它们的周报图不会被交出，而新地址没法从旧地址推出来。给这些项目的 `<key>.conf` 加一行 `WEEKLY_REPORT_ASSET_ROOT_URL=`（公网入口实际挂的前缀）后再切换。

daemon 每轮调一次 `switch.sh --auto`：服务没在严格模式、或在跑的代码和磁盘上的不一样，就自动切换（会重启一次服务），失败按 1、5、15、60 分钟退避，每个代码版本最多试 5 次。不想让它自动切换：服务配置里加 `PUBLIC_ASSETS_AUTO_SWITCH=0`。核验做四项：一张旧图 200、旧结构位置新放的图 404、`<key>/0/`（0 号条目留给核验）下的正常图 200、带假令牌样式的图 404；只删它自己刚建的文件。

</details>

<details><summary>手动退回基本规则</summary>

切换出问题时手动退回老规则（不依赖切换命令能运行；先把 `OLD_IMAGE_URL` 设成任一张旧图的公网地址）：

<!-- public-assets-rollback:begin -->
```bash
(
set -eu
CONF="$(ls ~/.config/cavil-loop/public-assets.conf ~/.config/coding-agent-work-loop/public-assets.conf 2>/dev/null | head -n 1)" || true
if [ -z "$CONF" ]; then echo "NO-CONFIG: nothing changed"; exit 1; fi
BAK="$CONF.bak-manual-$(date +%Y%m%d-%H%M%S)"
if ! cp -p "$CONF" "$BAK" || ! cmp -s "$CONF" "$BAK"; then echo "BACKUP-FAILED: nothing changed"; exit 1; fi
sed -i '/^PUBLIC_ASSETS_STRICT=/d' "$CONF"
grep -q '^PUBLIC_ASSETS_AUTO_SWITCH=0$' "$CONF" || echo 'PUBLIC_ASSETS_AUTO_SWITCH=0' >> "$CONF"
if grep -q '^PUBLIC_ASSETS_STRICT=' "$CONF"; then echo "EDIT-FAILED: restore $BAK"; exit 1; fi
systemctl --user restart cavil-loop-public-assets.service
sleep 2
systemctl --user is-active cavil-loop-public-assets.service
PID="$(systemctl --user show -p MainPID --value cavil-loop-public-assets.service)"
jq -e --argjson p "$PID" '.pid == $p and .strict == false' ~/.local/state/cavil-loop/public-assets/status.json
curl -sk -o /dev/null -w '%{http_code}\n' "$OLD_IMAGE_URL"
echo "ROLLED-BACK"
)
```
<!-- public-assets-rollback:end -->

看到 `active`、`true`、`200` 和最后一行 `ROLLED-BACK` 算恢复：`true` 是服务自己报告「现在这个进程严格模式关」（进程号对得上才算）。中途任何一步失败，命令块就地停下、后面的步骤都不做：`NO-CONFIG` / `BACKUP-FAILED` 表示什么都没改；`EDIT-FAILED` 表示配置改了一半，用它打印的备份文件覆盖回去；`systemctl` 或 `jq` 那一行失败表示服务没按老规则起来，看 `journalctl --user -u cavil-loop-public-assets -n 50`。`PUBLIC_ASSETS_LEGACY_SHA=` 那一行保留，下次切换沿用；想恢复自动切换就删掉 `PUBLIC_ASSETS_AUTO_SWITCH=0` 那一行。

</details>

<details><summary>各项目占用统计</summary>

**占用统计**（只读，不删任何文件）：`bash ~/.agents/skills/cavil-loop/scripts/public-assets/usage.sh` 按项目、按条目列出占用，旧结构里归不到项目的单列一行，按名字推出来但对外服务不交出的那个目录也单列。删不删、删哪些由人决定：删掉的图在已发评论里会变成破图。

</details>

<details><summary>脚本查不出来的；限制</summary>

**脚本查不出来的**：截到的画面里显示了令牌、个人信息（姓名、邮箱、账号、订单……），凭证检查只看文件字节，看不出像素里的内容。这一条仍靠 worker 只截可公开的页面、复审抽查。

**限制**：只有装了这套对外服务的机器能发图；直接把目录交给别的静态服务对外的机器，发布命令一律拒绝。切换会重启一次服务，重启那一下（秒级）的图片请求会失败。

</details>

<details><summary>不是图片的附件；要登录状态的截图</summary>

不是图片 / 视频的附件（周报 PDF 等）不公开发布：`publish-asset.sh` 把它放进不公开的目录，项目配置里设了 `WEEKLY_REPORT_PRIVATE_ASSET_ROOT_URL`（只在内网可达的地址前缀，对应目录由 `WEEKLY_REPORT_PRIVATE_ASSET_ROOT` 指定，默认资产目录旁的 `private-assets/`）就给那个地址，没设就给本机路径。周报趋势图的矢量版留在本机（`WEEKLY_REPORT_VECTOR_DIR`，默认资产目录旁的 `weekly-report-vector/`），`topdf.mjs` 从本机读。

截图要带登录状态时，`scripts/review-screenshot.mjs --auth <文件>` 要求登录状态文件在被 git 忽略的路径里、且不在截图输出目录内，否则报错不截图；它改端口用的副本写在原件旁边（权限 600），结束、出错、被中断都会删掉。

</details>

### 哪些项目的评论能出图

公网出图地址按项目配：只有项目自己的 `~/.config/cavil-loop/<key>.conf` 里有一行 `WEEKLY_REPORT_ASSET_ROOT_URL=`，这个项目的 worker 才拿得到地址；上面的公网入口是整台机器一份。

<details><summary>没有地址时 worker 怎么做</summary>

没有这一行时，worker 拿到的派工说明是「本项目没有出图地址」，只能用文字描述图。不能改成把截图提交进仓库、再在评论里嵌 `github.com/<仓库>/blob|raw/…` 或 `raw.githubusercontent.com/…` 地址：私有仓库的这种地址 GitHub 不替它代理图片，没登录 GitHub 的人取不到图（实测返回 404），手机 GitHub app 能否显示未实测。worker 和复审的说明里都禁止这样嵌图；给一个注明「需登录 GitHub 才能看」的普通链接、再用文字描述，是允许的。

</details>

<details><summary>接入一个项目意味着什么</summary>

给项目接入后，它的截图拿到地址的人都能打开（文件名带唯一戳、不列目录，但并不私密）。派工说明只允许放可公开的内容：登录后才看得到的页面、带个人信息（姓名、邮箱、账号、订单等）的页面、内部预览环境，一律不放，拿不准就改用文字描述。图片内容没有自动检查，这条靠 worker 自己判断、复审抽查。接不接入按项目逐个决定。

</details>

<details><summary>接入一个项目、核对、再撤销</summary>

给一个项目接入：在同一个终端里依次跑下面几段（第一段设好后面几段用的名字）。下一轮轮询起生效（每轮 timer 都重新启动服务，systemd 每次启动都重读这个文件）；已经在跑的 worker 仍用它拿到的旧说明。

<!-- asset-url-ops:vars:begin -->
```bash
KEY=myproject      # the project to turn on / 要接入的项目: systemctl --user list-timers 'cavil-loop-poll@*'
FROM=otherproject  # a project that already shows images / 已经能出图的项目
ENV_FILE="$HOME/.config/cavil-loop/$KEY.conf"
REC="$ENV_FILE.asset-url-added"   # the address this procedure added / 本流程加进去的地址
LOCK="$ENV_FILE.asset-url.lock"   # add and revert hold it from first read to last write / 补地址和撤销从第一次读到最后一次写都持有它
URL=$(sed -n 's/^WEEKLY_REPORT_ASSET_ROOT_URL=//p' "$HOME/.config/cavil-loop/$FROM.conf" | tr -d '"')
echo "URL=$URL"
```
<!-- asset-url-ops:vars:end -->

<!-- asset-url-ops:add:begin -->
```bash
# One add / revert at a time per project: a second one waits up to 60 s, then stops with nothing changed.
# 同一项目同时只跑一个补地址 / 撤销：后来的最多等 60 秒，等不到就停下、什么都不改。
(
    flock -w 60 9 || { echo "STOP: another add / revert of $KEY holds $LOCK — nothing changed; run this block again"; exit 0; }
    if [ -z "$URL" ]; then
        echo "STOP: no address in $FROM — nothing changed"
    elif [ ! -w "$ENV_FILE" ]; then
        echo "FAILED: $ENV_FILE is not writable (or missing) — nothing changed; fix that and run this block again"
    else
        # Every decision and the new file come from ONE snapshot (the backup); right before the swap the file must
        # still equal it, and the replaced file must still equal it right after — otherwise someone saved in between.
        # 所有判断和新文件都只来自同一份快照（就是备份）；替换前文件必须仍等于它，替换后被换下的旧文件也必须仍等于它。
        # A record with no address line is left over from a failed add or an unfinished revert; it is rewritten.
        # 没有地址行却有记录：是上次接入失败或撤销没做完留下的，直接重写。
        LINE="WEEKLY_REPORT_ASSET_ROOT_URL=\"$URL\""
        BAK=$(mktemp "$ENV_FILE.bak-$(date +%Y%m%d-%H%M%S)-XXXX") || BAK=
        TMPF=$(mktemp "$ENV_FILE.XXXXXX") || TMPF=
        OLD="$ENV_FILE.replaced-$$"
        if ! { [ -n "$BAK" ] && [ -n "$TMPF" ] && cat "$ENV_FILE" > "$BAK"; }; then
            rm -f "$TMPF" "$BAK"; echo "FAILED: $ENV_FILE could not be read — nothing changed"
        elif [ "$(grep -c '^WEEKLY_REPORT_ASSET_ROOT_URL=' "$BAK")" != 0 ]; then
            rm -f "$TMPF" "$BAK"; echo "STOP: $ENV_FILE already has an address line — nothing changed"
        elif ! { { cat "$BAK" && { [ -z "$(tail -c 1 "$BAK")" ] || echo; } && printf '%s\n' "$LINE"; } > "$TMPF" \
            && [ "$(tail -n 1 "$TMPF")" = "$LINE" ] && [ "$(grep -c '^WEEKLY_REPORT_ASSET_ROOT_URL=' "$TMPF")" = 1 ] \
            && chmod --reference="$ENV_FILE" "$TMPF"; }; then
            rm -f "$TMPF" "$BAK"; echo "FAILED: $ENV_FILE not changed — fix the cause and run this block again"
        elif ! cmp -s "$ENV_FILE" "$BAK"; then
            rm -f "$TMPF" "$BAK"; echo "STOP: $ENV_FILE was changed while this block ran — nothing changed; run it again"
        elif ! ( umask 077 && printf '%s\n' "$URL" > "$REC" ) || ! ln "$ENV_FILE" "$OLD" || ! mv "$TMPF" "$ENV_FILE"; then
            rm -f "$TMPF" "$OLD" "$BAK"; echo "FAILED: $ENV_FILE not changed — fix the cause and run this block again"
        elif ! cmp -s "$OLD" "$BAK"; then
            echo "CONFLICT: ADDED, but a change saved at the same moment is in $OLD — copy it into $ENV_FILE by hand, then delete $OLD"
        else
            rm -f "$OLD"; echo "ADDED (backup / 备份: $BAK; record / 记录: $REC)"
        fi
    fi
) 9>>"$LOCK" || echo "FAILED: could not open $LOCK — nothing changed"
```
<!-- asset-url-ops:add:end -->

<!-- asset-url-ops:check:begin -->
```bash
n=$(grep -c '^WEEKLY_REPORT_ASSET_ROOT_URL=' "$ENV_FILE")
v=$(sed -n 's/^WEEKLY_REPORT_ASSET_ROOT_URL=//p' "$ENV_FILE" | tr -d '"')
added=$(cat "$REC" 2>/dev/null)
if [ "$n" = 0 ]; then echo "NONE: no address — workers describe images in words${added:+ (a leftover record will be cleared by add or revert)}"
elif [ "$n" = 1 ] && [ -n "$added" ] && [ "$v" = "$added" ]; then echo "OK: $v"
else echo "MISMATCH: ${n:-unreadable} line(s): $v (recorded / 记录: ${added:-none})"
fi
```
<!-- asset-url-ops:check:end -->

<!-- asset-url-ops:revert:begin -->
```bash
# One add / revert at a time per project: a second one waits up to 60 s, then stops with nothing changed.
# 同一项目同时只跑一个补地址 / 撤销：后来的最多等 60 秒，等不到就停下、什么都不改。
(
    flock -w 60 9 || { echo "STOP: another add / revert of $KEY holds $LOCK — nothing changed; run this block again"; exit 0; }
    added=$(cat "$REC" 2>/dev/null)
    # Every decision and the new file come from ONE snapshot, compared with the file again before and after the swap.
    # 所有判断和新文件都只来自同一份快照，替换前后再和文件比对。
    SNAP=$(mktemp "$ENV_FILE.snap-XXXXXX") || SNAP=
    TMPF=$(mktemp "$ENV_FILE.XXXXXX") || TMPF=
    OLD="$ENV_FILE.replaced-$$"
    if ! { [ -n "$SNAP" ] && [ -n "$TMPF" ] && cat "$ENV_FILE" > "$SNAP"; }; then
        rm -f "$TMPF" "$SNAP"; echo "STOP: $ENV_FILE could not be read — nothing changed"
    else
        n=$(grep -c '^WEEKLY_REPORT_ASSET_ROOT_URL=' "$SNAP")
        v=$(sed -n 's/^WEEKLY_REPORT_ASSET_ROOT_URL=//p' "$SNAP" | tr -d '"')
        if [ "$n" = 0 ]; then
            # Nothing to remove; only a leftover record (failed add, or a revert that stopped after removing the line) is cleared.
            # 没有地址行：只清掉遗留的记录（接入失败、或撤销删了行后没删掉记录）。
            rm -f "$TMPF" "$SNAP"
            if rm -f "$REC" && [ ! -e "$REC" ]; then echo "REVERTED: no address line${added:+, leftover record cleared}"
            else echo "FAILED: could not remove $REC — fix the cause and run this block again"
            fi
        elif [ -z "$added" ] || [ "$n" != 1 ] || [ "$v" != "$added" ]; then
            rm -f "$TMPF" "$SNAP"
            echo "STOP: $n address line(s), value '$v', recorded '${added:-none}' — not the line that was added; nothing changed, ask the maintainer"
        elif ! { { grep -v '^WEEKLY_REPORT_ASSET_ROOT_URL=' "$SNAP" > "$TMPF" || [ $? -eq 1 ]; } \
            && [ "$(grep -c '^WEEKLY_REPORT_ASSET_ROOT_URL=' "$TMPF")" = 0 ] \
            && [ "$(wc -l < "$TMPF")" = "$(grep -vc '^WEEKLY_REPORT_ASSET_ROOT_URL=' "$SNAP")" ] \
            && chmod --reference="$ENV_FILE" "$TMPF"; }; then
            rm -f "$TMPF" "$SNAP"; echo "FAILED: $ENV_FILE not changed — fix the cause and run this block again"
        elif ! cmp -s "$ENV_FILE" "$SNAP"; then
            rm -f "$TMPF" "$SNAP"; echo "STOP: $ENV_FILE was changed while this block ran — nothing changed; run it again"
        elif ! ln "$ENV_FILE" "$OLD" || ! mv "$TMPF" "$ENV_FILE"; then
            rm -f "$TMPF" "$SNAP" "$OLD"; echo "FAILED: $ENV_FILE not changed — fix the cause and run this block again"
        elif ! cmp -s "$OLD" "$SNAP"; then
            rm -f "$SNAP" "$REC"
            echo "CONFLICT: REVERTED, but a change saved at the same moment is in $OLD — copy it into $ENV_FILE by hand, then delete $OLD"
        elif rm -f "$SNAP" "$OLD" "$REC" && [ ! -e "$REC" ]; then
            echo "REVERTED"
        else
            echo "PARTIAL: address line removed, record $REC left — run this block again to clear it"
        fi
    fi
) 9>>"$LOCK" || echo "FAILED: could not open $LOCK — nothing changed"
```
<!-- asset-url-ops:revert:end -->

看到什么算成功：补地址那段打印 `ADDED`、备份路径（同目录，权限 600；文件里有该项目的 GitHub 令牌，别打印内容）和记录文件 `<key>.conf.asset-url-added`，记录里是本流程写进去的地址；核对那段打印 `OK: <地址>`。要撤销，先跑第一段，再跑撤销那段：它拿这份记录比对——不拿另一个项目现在的地址比，那个地址之后可能换过——只删本次加的那一行，而且只在这样的行恰好一行、值仍等于记录的地址时才删；其他设置保持现在的样子（之后换过的令牌不会被改回去），记录随这一行一起删掉。没有记录就什么都不删。

</details>

<details><summary>每种结果和下一步</summary>

每种结果和下一步（任何一步失败，留下的状态都能用这几段继续处理）：

| 那段打印 | 含义 | 下一步 |
|---|---|---|
| 补地址 `ADDED` | 地址行和记录都已写好 | 核对应打印 `OK` |
| 补地址 `FAILED` | 配置文件没有改动——文件不存在、不可写、读不了，或写入失败（可能留下了记录） | 排除原因（例如腾出磁盘空间、或让文件可写）后重跑补地址那段——没有地址行的记录会被重写 |
| 补地址 `STOP` | 没有可复制的地址、或已有地址行 | 什么都没改；去看文件 |
| 补地址 / 撤销 `STOP: another add / revert … holds …` | 另一个终端正在对这个项目跑补地址或撤销，60 秒内没跑完 | 什么都没改；等那一段跑完再重跑这一段 |
| 补地址 / 撤销 `FAILED: could not open … .asset-url.lock` | 配置旁边的锁文件建不了或打不开 | 什么都没改；让目录可写后重跑这一段 |
| 补地址 / 撤销 `STOP: … was changed while this block ran` | 这段读完文件之后、替换之前，别处保存了这个文件 | 什么都没改，别处那次保存留着；重跑这一段 |
| 补地址 / 撤销 `CONFLICT` | 别处恰好在替换的那一刻保存了；这一段的改动已生效，别处的改动在它点名的 `….replaced-<n>` 文件里 | 把那个文件里别处的改动手工抄进配置，再删掉它 |
| 撤销 `REVERTED` | 加的那一行和记录都已删掉（或本来没有那一行，只清掉了遗留记录） | 核对打印 `NONE` |
| 撤销 `PARTIAL` | 地址行已删，记录还在 | 再跑一次撤销，它会清掉记录 |
| 撤销 `FAILED` | 什么都没删 | 排除原因后重跑撤销 |
| 撤销 `STOP` | 那一行不是本流程加的、有多行、没有记录、或文件读不了 | 什么都没改；和维护者一起看文件 |

</details>

<details><summary>配置文件怎样安全替换</summary>

配置文件只会被整份替换：补地址和撤销都先在同一目录写出完整的新文件、核对无误，再改名覆盖旧文件，所以写到一半出错（磁盘满、文件大小限制）时旧文件原样不动。新文件沿用旧文件的权限。同一项目的补地址和撤销不会交错：每段从第一次读到最后一次写都持有锁文件 `<key>.conf.asset-url.lock`（留在原处，是空文件），一段在跑时另一段会等它跑完。每一段都从文件的一份快照出发（补地址用的就是备份）：替换前文件必须仍等于这份快照，否则停下、什么都不改；替换后被换下的那份文件也必须仍等于它，否则说明中途有人保存过，这一段报 `CONFLICT` 并留下那份文件。查不出的情况：编辑器恰好在最后一次核对和替换之间、用改名的方式存盘——那次保存会丢。跑这几段时不要同时手改这个文件，也不要对这个项目跑 `setup.sh`。备份只供人工对照，不要拿它覆盖回去，那会把之后的所有改动一起撤掉。

</details>

## Prompt 模板

提示词怎么拼、模板和项目增量从哪儿找、模板里能用的全部占位符，见编排文档的[拼提示词](orchestration.zh.md#拼提示词模板与增量)一节。

## Cleanup hook（`CLEANUP_HOOK`）

清理脚本拿到什么、什么时候跑、怎么按 worktree 找该清的东西，见编排文档的[合并后清理](orchestration.zh.md#合并后清理cleanup_hook)一节。

## 文件结构

工具本身、接入的项目和每个用户的状态在磁盘上各放在哪。

### Skill 目录（Linux 受管布局）

skill 软链指向一个不可变的 release；poll 等入口都从 `entrypoints/` 里的启动器进入，清理旧 release 时不会删掉它们。

<details><summary>目录树</summary>

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

</details>

<details><summary>启动器、租约与 release 清理</summary>

poll、token 用量 driver 和周报都从 `entrypoints/` 里的持久启动器进入。启动器不会随旧 release 被清理：它先取得共享部署锁、解析稳定软链并拿到目标 release 的 `.inuse` 租约，之后才打开版本内脚本。清理只有取得独占租约才删除旧 release；不会使用“超过 N 小时”或“保留最近 N 个”的猜测规则。可选共享覆盖放在 `~/.config/cavil-loop/deploy.conf`，字段见 `cavil-loop-deploy.conf.example`。

</details>

### Host project（接入后）

接入只多一个 gitignored 的配置文件；项目级的 prompt 和 hook 覆盖是可选的。

<details><summary>目录树</summary>

```
your-project/
├── .gitignore                          # +1 行：cavil-loop.config
├── cavil-loop.config                  # 配置（gitignored）
├── .agents/skills/cavil-loop/  # 可选：项目自定义 prompt + cleanup-hook
│   ├── prompts/
│   └── cleanup-hook.sh
└── ... your code ...
```

</details>

### 用户级状态文件

`<project-key>.conf` 是两个 OS 共享的环境变量单源真相——格式一样，只是不同调度器加载方式不一样。每个项目的状态放在 `~/.local/state/cavil-loop/<project>/`。

<details><summary>目录树</summary>

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
├── usage-limit.json                    # 开了 ENABLE_USAGE_LIMIT_PAUSE 才有：各条目派工开始时刻 + 做到一半的转人工
├── poll.log                            # 滚动日志
├── runlog/                             # 运行记录：每轮轮询一条 + 快照
├── poll.lock                           # flock
└── sessions/                           # 每个 worker tmux session 的 pane 日志
    └── <project>-issue<N>.log
```

</details>

## 按 OS 选调度器

`setup.sh` 用 `uname -s` 检测 OS，自动选对应调度器：Linux 用 `systemd --user` timer，macOS 用 `launchd` LaunchAgent；其他系统直接报错退出，要走[手动 cron 兜底](#手动-cron-兜底)。两边的 tick 都由 `POLL_INTERVAL_SECS` 决定，改了要重跑 `setup.sh`。

<details><summary>各个 OS 装上的是什么</summary>

| OS | 调度器 | Unit / Plist | `setup.sh` 自动装？ |
|----|--------|--------------|---------------------|
| Linux | `systemd --user` timer | `~/.config/systemd/user/cavil-loop-poll@<key>.{service,timer}`（symlink 到 skill 模板）+ `cavil-loop-poll@<key>.timer.d/interval.conf`（按 `POLL_INTERVAL_SECS` 生成）| ✅ |
| macOS | `launchd` LaunchAgent | `~/Library/LaunchAgents/dev.luosky.cavil-loop.<key>.plist`（生成，非 symlink）| ✅ |
| 其他 | — | — | ❌ `exit 1`；见 [手动 cron 兜底](#手动-cron-兜底) |

两条路径都读同一份 `~/.config/cavil-loop/<key>.conf`。Linux 在持久 poll 入口前执行 `skill-deploy.sh`；网络 fetch 使用单独的非阻塞锁和超时，只有发布与清理才短暂持有部署锁，所以慢 fetch 不会挡住当前 release 的消费者，失败尝试也会进入共享节流。macOS 运行钉版本入口但不自动部署，plist 模板有改动要重跑 `setup.sh`。

</details>

<details><summary>tick 频率与 <code>POLL_INTERVAL_SECS</code></summary>

tick 频率只是「最多多久打一次 GitHub」的上限：一整天没人碰的项目会在 `agent-poll.sh`
内部决定跳过大部分 tick（见[空闲与故障退避](architecture.zh.md#轮询节奏空闲退避与故障退避)）。
起一个进程只要几十毫秒，调用才是稀缺资源，所以 tick 本身保持便宜且频繁。

两个系统上驱动 timer 的都是 `POLL_INTERVAL_SECS`；Linux 端 `setup.sh` 把它写成本实例的
drop-in，而不是去改共享模板。手写的 `interval.conf` 永远不会被覆盖 —— `setup.sh` 会提示
一句然后放着不动。

</details>

### macOS 专属

每个用户一个 LaunchAgent，用 `launchctl bootstrap` 加载；要先 `brew install flock`，只在登录状态下运行。

<details><summary>Label、加载方式、频率、日志、flock、登出</summary>

- **Label**：`dev.luosky.cavil-loop.<key>`（必须和 plist 文件名一致）
- **加载方式**：`launchctl bootstrap gui/$UID <plist>`（modern 语法，macOS 10.10+）。`setup.sh` 会先 `bootout` 再 bootstrap，重跑幂等。
- **运行频率**：`StartInterval` 取自 `POLL_INTERVAL_SECS`（等价 systemd `OnUnitActiveSec`）。plist 是生成的不是 symlink，改了要重跑 `setup.sh`。
- **日志**：stdout/stderr → `~/Library/Logs/cavil-loop/<key>.{out,err}.log`。更深的 poll 日志仍在 `$STATE_DIR/poll.log`。
- **flock**：macOS 不自带，先 `brew install flock` 再跑 `setup.sh`。
- **登出 / 合盖**：user LaunchAgent 登录后常驻（即使锁屏也跑）；想"无登录、开机即跑"要装到 `/Library/LaunchDaemons/` —— `setup.sh` 故意不进这里（要 `sudo`，且破坏和 Linux `--user` systemd 的对称）。

</details>

## 多 project 共存

skill 和调度器模板各装一次，每个 project 跑一次 `setup.sh`；每个项目各有自己的 timer、日志和 state，互不干扰。

<details><summary>命令</summary>

```bash
bash ~/.agents/skills/cavil-loop/setup.sh ~/github/projectA
bash ~/.agents/skills/cavil-loop/setup.sh ~/github/projectB
```

</details>

<details><summary>装完得到什么</summary>

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

</details>

## 用脚本安装、查状态、断开

程序（桌面客户端，或人自己写的脚本）通过 skill 目录里的这几个脚本安装、查看、断开项目，不用自己重写安装逻辑。对改名前的旧安装同样有效（新旧名字统一由 `scripts/_names.sh` 挑）。

<details><summary>各个脚本</summary>

| 脚本 | 做什么 | 会写东西吗 |
|---|---|---|
| `setup.sh --yes <host> [key]` | 和 `setup.sh` 一样，但最后不问 y/N，直接启用并启动后台任务；不带 `--yes` 就是普通的 `setup.sh` | 会（同 `setup.sh`） |
| `scripts/install-status.sh [--agent <名字>] [--project <目录>]` | 输出一个 JSON 对象，本机状态一次读全 | 不会 |
| `scripts/disconnect-project.sh <key>` | 停掉一个项目的后台任务、撤掉登记；保留项目配置和状态 | 会 |
| `scripts/launchd-refresh.sh <key>` | 只用于 macOS：模板变了之后换新一个项目的 launchd plist，先备份、失败就恢复 | 会 |
| `scripts/project-service.sh <key> stop\|start` | 停 / 启一个项目的后台轮询任务（远程入口用）：只在「在跑 → 停」「已停 → 启」时执行，读不到不动，执行后读回 | 会 |

</details>

<details><summary>命令：接入、列出、检查、断开</summary>

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

</details>

<details><summary>状态输出：每个字段</summary>

**状态输出**（`version: 1`）。顶层：`os`、`scheduler`（`systemd` / `launchd`）、`daemon`（`entry` 稳定 skill 入口、`target` 实际指向、`form` 安装形态——`managed` 受管 release / `checkout` 普通代码目录 / `directory` / `missing` / `dangling`、`version` release 的 sha 或代码目录的 `HEAD`）、`gh`（`installed`、`logged_in`）、`base_deps.missing`（每个项目都要的通用工具）、`bash`（`path` 轮询会用的 bash，和 `setup.sh` 同一个挑选函数；`major` 主版本；`ok` —— 4 及以上为 `true`，macOS 自带的 3.2 为 `false`，跑不了 daemon，要 `brew install bash`；读不出版本为 `null`）、`agent_check`（带 `--agent` 才有）、`remote_access`（本脚本旁边那份远程入口代码的 `{level, fingerprint}`——接口级别和 `remote_access.py` 的 sha256；读不到为 `null`）、`project_check`（带 `--project <目录>` 才有：那个目录里已有的项目配置，按轮询一样的读法读——`config_state` 为 `none` / `ok` / `unreadable`，以及 `config`、`repo`、`worker_agent`；`setup.sh` 会沿用这份配置，所以接上后实际用的就是这两项）、`projects[]`。每个项目：`key`、`layout`（`new` / `legacy` = 改名前装的）、`env_file`、`host`、`config`、`config_state`（`ok` / `unreadable`）、`repo`、`state_dir`、`agents[]`、`deps`、`scheduler`、`last_poll`。

- `agents[]` 列出 worker agent、复审 agent（只在配了 `LABEL_PENDING_REVIEW` 时）和按标签选模型时用的 agent（`role: fable`，`required: false`——只有有人给条目打了那个标签才会起，所以没装 claude 的 codex 项目不会被报成缺依赖）。每项有 `bin`、`state`（`ok` / `missing` / `no_driver`）和 `missing`，用的是 `setup.sh` 同一个函数，两边结论不会不一致。`deps` 汇总必需的那几项：`ok` / `missing` / `unknown`（配置读不出或找不到 driver）。
- `scheduler.state` 是 `running` / `stopped` / `unknown`。只认已知状态词：读失败、空输出、不认识的词一律 `unknown`，绝不报 `stopped`；`raw` 是读到的原文。
- `last_poll` 取最近一次真读了 GitHub 的轮询（`poll-pace.json`），没有就取 `poll.log` 的修改时间；都没有为 `null`。
- 没有 `jq` 时拼不出完整状态：脚本只输出 `{version: 1, precheck: true, os, base_deps: {missing}}`（不靠 `jq` 查的通用工具），退出码 3；这时项目和后台任务状态一概读不到。

</details>

<details><summary>断开：检查什么、退出码</summary>

**断开**照[卸载某个 project](#卸载某个-project) 的步骤做：先读后台任务状态，读不到就什么都不动（退出 2）；停完读回确认（Linux 上还确认不再开机自启），确认不了就保留登记（退出 3）。退出 0 = 已断开，1 = 没有这个实例。最后一行固定是 `RESULT=<disconnected|not_found|unknown|failed>`。worker 的 tmux 会话不动。

</details>

<details><summary>换新 launchd plist（macOS）</summary>

**换新 launchd plist（macOS）。** plist 是生成的、不是软链，重跑 `setup.sh` 看到已存在就跳过；daemon 更新、模板变了之后，每个项目跑一次下面的命令。

<!-- install-scripts-mac-ops:begin -->
```bash
SKILL="$HOME/.agents/skills/cavil-loop"
bash "$SKILL/scripts/launchd-refresh.sh" myproject
```
<!-- install-scripts-mac-ops:end -->

</details>

<details><summary>换新时做了什么、各种结果</summary>

它用 `setup.sh` 同一个函数生成新 plist，`plutil -lint` 校验，和现有文件逐字比对——一样就 `RESULT=unchanged`。不一样：读任务状态（读不到就停，什么都不动）；已加载的先拿该项目的轮询锁（等当前这一轮结束，最多 `CAVIL_REFRESH_LOCK_WAIT` 秒，默认 300），bootout 并确认已卸载；把旧文件备份到 `$STATE_DIR/launchd-backup/`；原子换上新文件；原来已加载的就重新加载，并读回确认加载的是这个文件。加载失败就用备份恢复原文件和原状态。最后一行 `RESULT=` 是 `replaced` / `unchanged`（退出 0）、`unknown` / `lint_failed` / `lock_timeout`（退出 2，什么都没动）、`not_found` / `not_macos`（退出 1）、`failed`（退出 3，原文件和原状态已恢复——两者都读回确认过才报它）、`needs_human`（退出 4：恢复失败或确认不了——输出里有报错原文、原文件位置和手动恢复的命令，做过备份的话备份保留）。Linux 上单元文件是指向模板的软链，部署器自己重新加载，不适用这个脚本。

</details>

## 用脚本读 / 改一个项目的常用配置

`scripts/project-config.sh` 读、改一个已接项目的常用配置项；桌面客户端的「项目配置」弹窗就是调它，人也可以直接跑。只读写 `scripts/config-fields.txt` 里登记的项；保存要么全写要么全不写，并留备份。`myproject` 是实例名。

<details><summary>命令</summary>

<!-- project-config-ops:begin -->
```bash
SKILL="$HOME/.agents/skills/cavil-loop"
bash "$SKILL/scripts/project-config.sh" get myproject | jq -r '.fields[] | select(.mode == "edit") | "\(.name)=\(.value) editable=\(.editable)"'
REV="$(bash "$SKILL/scripts/project-config.sh" get myproject | jq -r .rev)"
SAVED="$(printf '{"MAX_CONCURRENT_WORKERS":"2"}' | bash "$SKILL/scripts/project-config.sh" set myproject --rev "$REV")"
printf '%s\n' "$SAVED" | tail -1
bash "$SKILL/scripts/project-config.sh" get myproject | jq -r '.fields[] | select(.name == "MAX_CONCURRENT_WORKERS") | "\(.name)=\(.value)"'
BACKUP="$(printf '%s\n' "$SAVED" | sed -n 's/^DETAIL=//p' | jq -r .backup)"
cp "$BACKUP" "$(bash "$SKILL/scripts/project-config.sh" get myproject | jq -r .real)"
```
<!-- project-config-ops:end -->

依次是：列出能改的配置项和当前值；取配置文件的指纹；改一项；打印结果行；读回新值；最后用这次保存留下的备份把保存前的版本放回去（还原就是最后两行，别的什么都没动过）。

</details>

⚠️ 保存时不要同时在编辑器里改同一个文件：保存前后在编辑器里存的修改可能丢失，即使结果是 `saved`（细节见最后一个折叠块）。

<details><summary>能读、能改哪些</summary>

**能读、能改哪些。** 只有 `scripts/config-fields.txt` 里登记的（agent 与模型、并发数、重试次数和轮数、评论语言、几个开关）。命令、钩子、令牌、网络地址、目录、项目的各种名字不登记：不会被打印，也改不了。标签、几选一的模式、不是单个数字的文字值只显示（`mode: "show"`）：它们和可改的项放在同一个主题分组里，每项在 `reason` 里带着自己的原因（`config-fields.txt` 的第 8 列）。登记了的项只有在「配置的代码里只提到它这一次，而且这一处是最外层单独一行、顶格写的普通字面值」时才可改。写成算式或引用了变量的、有两处赋值的、放在 `if`、循环、`case`、函数或 `{ }` 组里的（分几行写还是一行写完、缩进不缩进、那个分支执行没执行都一样）、接在别的命令后面的（`cmd && KEY=…`）、用别的写法的（`declare`、只 `export` 不赋值、`read`、`printf -v`、`${KEY:=…}`）、或者代码里别处还提到了它的，返回 `editable: false` 并写明原因，仍然用文本编辑器改。「配置文件里有没有这一项」用的是同一份证据：只有代码里一次都没提到它（注释不算），保存时才会给它追加一行。这些都看 bash 自己对这份文件的解析结果，不看缩进；解析结果读不出来时，所有项一律只显示。有一种情况看不到：写在没执行的分支里、名字是运行时才拼出来的（`eval`、被 `source` 的另一个文件）。`value` 一律是 daemon 实际按它工作的值，和这一行能不能改分开算：配置加载完之后没设置或为空的项——没有这一行、写成空值、所在分支没执行——给出的是 daemon 的默认值。少数项的空值有自己的意思，按它自己的规则给值：`ENABLE_POLL_RUN_LOG` 不写这一行 = 开、写成空值 = 关（登记成 `true;empty=false`）。有早期名字的项（外部需求机器人的 `LABEL_PENDING_RELAY`、`RELAY_REPORT_FIRST`）按 daemon 挑值的规则给值：新名字有值用新名字的，否则用早期名字的（新旧名字的对照只在 `scripts/_names.sh` 的 `CAVIL_SETTING_EARLY_NAMES` 写一份）。配置的代码里只要提到了早期名字，或者加载完早期名字有定义（比如来自配置加载的另一个文件），这一项就只显示并写明原因：在这里写新名字会让两个名字并存、值还可能互相矛盾，先用文本编辑器把那一行改成新名字。两个必填的标签（`LABEL_PENDING_AGENT`、`LABEL_PENDING_HUMAN`）没有默认值：没有这一行 daemon 不启动，给出的值是空。`in_file: false` 表示文件的代码里一次都没提到这一项；保存它会在文件末尾追加一行。

</details>

<details><summary><code>get</code>：输出</summary>

**`get <key>`** 输出一个 JSON：`state`（`ok` / `unreadable` / `not_found`）、`config`、`real`（解析掉软链接后的文件）、`rev`（真实位置加内容的指纹）、`fields[]`——`name`、`group`、`mode`、`label`、`help`、`type`（`agent` / `model` / `int` / `bool` / `enum` / `label` / `text`——`text` 是原样显示的值，如流程标签、标签列表、分支名，只显示——按类型带 `options`、`min` / `max`、`on` / `off`；整数的范围是使用它的代码实际接受的范围，按十进制数字比大小——那段代码不设上限时 `max` 是 `null`，长到 JSON 数字表示不精确时给字符串，例如托管检查超时的 2562047788015215 小时（乘 3600 后不溢出的最大值））、`value`、`default`、`in_file`、`editable`、`reason`，以及 `tier`——客户端窗口把这一项放在哪（`config-fields.txt` 的第 9 列）：`main` 直接显示，`more` 收在所在分组的「高级」里，`advanced` 收进窗口底部默认收起的「高级设置」；客户端读到没有这个字段的较老 daemon 时全部直接显示。配置加载不了就是 `unreadable`，一个值都不给——绝不当成「什么都没设」。

</details>

<details><summary><code>set</code>：保存怎么做、各种结果</summary>

**`set <key> --rev <指纹>`** 从标准输入读一个值全是字符串的 JSON 对象，要么全写要么全不写。它按文件的真实位置拿锁，基于一份私有副本工作，逐个值按登记的类型校验，只改那几行（注释、引号写法和其余每个字节都不动），检查新文件还能加载、别的变量一个都没变，把保存前的版本复制到 `$STATE_DIR/config-backups/`（权限 600，留最近 10 份），紧挨着替换再拿文件和 `--rev` 比一次，然后把新文件改名换上。倒数第二行是 `DETAIL=<json>`（`changes[]` 里有原值和新值，`backup` 是备份位置），最后一行是 `RESULT=`：

| `RESULT` | 退出码 | 含义 |
|---|---|---|
| `saved` | 0 | 已写入；换上之后马上读回，是新内容 |
| `unchanged` | 0 | 要写的值文件里本来就是；什么都没写 |
| `changed` | 2 | 文件不是取 `--rev` 时的那一份了（读取之后、或保存进行中被改过）；什么都没写——重新读取 |
| `invalid` / `not_editable` | 2 | 值不符合类型 / 这一项没登记、只显示、或不是普通字面值；什么都没写 |
| `busy` | 2 | 另一个保存占着锁（`--lock-wait <秒>`，默认 15）；什么都没写 |
| `unreadable` / `verify_failed` / `backup_failed` / `write_failed` | 2 | 配置加载不了 / 新文件没通过检查 / 备份写不进去 / 文件操作失败；什么都没写 |
| `not_found` | 1 | 没有这个已接项目 |
| `saved_then_changed` | 4 | 新文件已经换上，读回之前又被别处改写了；脚本不再动它——重新读取，并和备份对一下 |

</details>

<details><summary>保存时编辑器开着这个文件</summary>

**保存时不要同时在编辑器里改同一个文件。** 脚本没法让编辑器等它。最后一次核对时文件和 `--rev` 不一样，它就不写；那次核对之后的事它看不到：编辑器在那次核对和换上之间存的一版会被新文件换掉；编辑器在保存前就开着这个文件、保存后才存盘的，要么用它手里整份旧内容把新值盖回去，要么写进刚被换下的那个文件。这两种情况结果仍可能是 `saved`，丢掉的修改找不回来——备份里只有保存前的那一版。新文件换上之后脚本不再写配置文件：不回滚，不自动恢复。轮询每一轮开头读一次配置，替换是改名，所以它读到的要么是旧的整份、要么是新的整份；已经在跑的 worker 用的还是它启动时的值。

</details>

## 给流程标签改名

流程标签（派工、干活中、等人、转 PR 跟踪、已完成，以及复审、托管、等合并、等前置、暂缓、等外部需求机器人这几个可选标签）存在三个地方：项目配置、GitHub 上的标签本身（和挂着它的每个 issue / PR）、桌面客户端自己记的标签名。`scripts/label-rename.sh` 一次改前两处；桌面客户端的「改名…」按钮调用它，然后只给这个仓库存新名字。只有一个设置一个名字的才能改名；列表类设置（`LABEL_PENDING_AGENT_EXTRA`、`GREEDY_SKIP_LABELS`、`PRIORITY_LABELS`）不能，它们里面用到了新旧名字时改名会被拦下。

<details><summary>命令</summary>

<!-- label-rename-ops:begin -->
```bash
SKILL="$HOME/.agents/skills/cavil-loop"
bash "$SKILL/scripts/label-rename.sh" myproject check --field LABEL_PENDING_HUMAN --from pending/human --to needs-human --others-stopped | tail -1
REV="$(bash "$SKILL/scripts/project-config.sh" get myproject | jq -r .rev)"
bash "$SKILL/scripts/label-rename.sh" myproject rename --field LABEL_PENDING_HUMAN --from pending/human --to needs-human --rev "$REV" --others-stopped | tail -1
bash "$SKILL/scripts/label-rename.sh" myproject finish --no-client | tail -1
```
<!-- label-rename-ops:end -->

依次是：检查（只读，每一项和原因都在 `DETAIL=` 那一行）；取配置的指纹；改名——GitHub 和配置都换成新名字后最后一行是 `RESULT=awaiting_client`；结束暂停。`--others-stopped` 是人确认「没有别的机器在轮询本仓库，或已经停掉」（见下文）。`finish --no-client` 表示这次不改客户端的名字，要在客户端设置里手动改。

</details>

<details><summary>各种结果、接下来做什么</summary>

| `RESULT` | 意思 | 接下来 |
|---|---|---|
| `awaiting_client` | GitHub 和配置都已是新名字；本项目仍暂停 | 客户端存好自己的名字后 `finish --client-saved`；终端里用 `finish --no-client` |
| `done` | 做完了，暂停文件已删 | — |
| `refused` | 有检查没过，或 GitHub 拒绝了改名（4xx）；什么都没改 | 按 `DETAIL=` 里的原因处理后再试 |
| `no_answer` | 改名请求没有回音：之后任何时候都可能生效 | `continue`（只读）直到 GitHub 上是新名字，或 `resend`；没有 `undo` |
| `partial` | GitHub 已改名，配置没写成 | 处理原因后 `continue` |
| `busy` | 轮询锁一直被占（`LABEL_RENAME_LOCK_WAIT`，默认 60 秒）；什么都没改 | 再试 |
| `unknown` | 有东西读不到，或 GitHub 上两个名字都不是；什么都没写 | 看提示；手动处理好后 `abandon --yes` |

</details>

<details><summary>改名期间没有东西按旧名字动手</summary>

**改名期间没有东西按旧名字动手。** 脚本在本项目的轮询锁里做，动 GitHub 之前先写 `$STATE_DIR/label-rename.json`。有这个文件时，本项目每一轮轮询、人手动跑的派工和 CI 报告、叫醒外部需求机器人的脚本都不动手（轮询记录写 `label-rename`）。每个「读了配置、之后会写标签」的入口拿到轮询锁后，先确认自己加载之后配置没变：配置本身在 bash 读它之前、它 `source` 的每个文件在其第一条命令执行之前（此时 bash 已把整个文件读进来）各算一次内容指纹，加载完再算一次（不一样 = 加载期间被换过，这一次不动手）；拿到锁后再算一遍，有一个变了或读不了就不动手，下一轮用新配置。人在编辑器里改、经本工具保存都算在内。看不到的是配置用别的方式读的文件（例如 `$(cat …)`），以及「存在才 source」、加载时还不存在、之后才出现的文件——标签名请写在配置里，或写在配置每次都会 source 的文件里。配置在加载时自己设置或清掉 `DEBUG` 陷阱、或执行 `set +T`，之后 source 的文件就看不见了，之后又恢复也一样：这时闸门每轮都不放行，`poll.log` 里写明原因，去掉配置里的这一行后恢复。在命令替换等子 shell 里 source 的文件同样算指纹。已接受的限制：不是字面写成 `trap … DEBUG` 的 trap 命令（经变量、别名拼出来的）认不出来，配置用这种写法清掉陷阱再恢复，中间 source 的文件看不见。人手动跑的派工脚本会先在轮询锁里重新起自己。这个文件只由 `finish`、`undo` 或 `abandon --yes` 删掉。

</details>

<details><summary>改名前的检查项</summary>

**检查项。** 新名字只用字母、数字和 `. _ : / @ + -`，1–50 个字符。仓库里有名字正好是旧名的标签，没有叫新名的标签（标签名不分大小写唯一，所以只改大小写的改名不做）。没有打开的条目挂着干活中标签（`doing/agent`），卡住检测没有停下的条目。别的设置没用到这两个名字。配置那一行是最外层的普通字面值（和 `project-config.sh` 同一条规则）。托管、等合并、等前置、等外部需求机器人这几个标签按 GitHub 的标签历史判断，改名后历史里记的是不是新名字没实测过——所以有打开的条目挂着它们时不能改名。标签列表读不全是「判断不了」，不是「新名字没被占用」。

</details>

<details><summary>请求没回音时</summary>

**请求没回音时。** GitHub 的标签接口没有条件写入，也没有「这个请求已作废」的回执，没回音的改名可能在之后任何时候生效。所以脚本从不把「旧名字还在」当成「什么都没发生」：本项目一直暂停，`undo` 被拒，只有 `continue` 和 `resend`（重发是安全的：迟到的那个请求目标相同，旧名字没了之后会被拒掉）。这样的改名做完后会写 `$STATE_DIR/label-watch.json`：之后每一轮轮询先读仓库标签，按那个固定编号对应的名字和配置不一致就整轮不做（轮询记录写 `label-watch`）；人手动跑的派工、CI 报告、释放卡住条目，以及叫醒外部需求机器人的脚本，拿到轮询锁后做同样的核对、同样不动手，直到 `label-rename.sh myproject watch-end`。核对记录只记一个标签，所以核对期间给别的标签改名会被拦下（同一个标签再改名可以，核对跟着换成新名字）。迟到的请求恰好落在核对之后、这一轮最后一次写标签之前时，这一轮仍可能按旧名字动手一次——这是已接受的风险。

</details>

<details><summary>另一台机器也在轮询同一个仓库时</summary>

**另一台机器也在轮询同一个仓库时。** GitHub 一改名，那台的配置还是旧名字。改名前先停掉它的轮询（客户端会列出它知道的机器并先停掉）。改完后在那台运行 `follow`，带上第一台输出里的标签固定编号（`LABEL_ID=`）：它核对这个编号的标签已是新名字、旧名字已经没有、那台自己的轮询已停（读法同 `project-service.sh`；在跑或读不到都拦下），只改那台的配置，不向 GitHub 发任何请求——然后 `finish --no-client`，再开那台的轮询。

```bash
bash "$SKILL/scripts/label-rename.sh" otherproject follow --field LABEL_PENDING_HUMAN --from pending/human --to needs-human --label-id 1234567 --rev "$(bash "$SKILL/scripts/project-config.sh" get otherproject | jq -r .rev)"
```

</details>

`status` 打印进行中的记录和是否在核对标签；`project-config.sh get` 也在 `label_rename` 里给出同样的状态，并给每个能改名的设置 `rename.ok` / `rename.reason`。

## 远程入口：让另一台电脑上的客户端看这台机器的 daemon

daemon 装在一台机器上、桌面客户端装在另一台电脑上时，客户端的「设置 → 远程 daemon」可以列出这台机器接了哪些项目、在不在跑，停 / 启某个项目的轮询，看轮询日志的最后 200 行，读 / 改某个项目的常用设置（和「本机 daemon → 配置」同一张表单）。**只通过 Tailscale**，并且要先配对。默认是关的：不跑下面的命令，这台机器上没有任何监听、没有任何转发。

<details><summary>前提</summary>

**前提**（缺哪一条，`enable` 会说明并停下，不留半开的入口）：

- 这台机器的 Tailscale 已连上，所在网络在管理后台 DNS 页开了 MagicDNS 和 HTTPS Certificates。
- 登记转发要管理员权限：当前用户是 Tailscale 的操作者（`sudo tailscale set --operator=$USER` 设一次），或 `sudo` 免密。都没有时 `enable` 会给出一条要人用 `sudo` 跑的命令，跑完重跑 `enable`。
- 本机有 `python3`、`tailscale`、`jq`。
- 客户端那台电脑在同一个 Tailscale 网络里。

</details>

<details><summary>命令</summary>

<!-- remote-access-ops:begin -->
```bash
RA="$HOME/.agents/skills/cavil-loop/scripts/remote-access.sh"
bash "$RA" enable
bash "$RA" pair
bash "$RA" status
bash "$RA" list
bash "$RA" revoke MacBook-Pro
bash "$RA" disable
```
<!-- remote-access-ops:end -->

依次是：打开入口；生成一个配对码（入口没开时 `pair` 会先打开，所以平时只跑 `pair` 就够）；看入口状态；列出已配对设备；撤销名叫 `MacBook-Pro` 的那台；关闭入口。

</details>

<details><summary>不用终端：桌面客户端</summary>

**不用终端**：这台机器上也装了桌面客户端（Mac）时，上面这些在它的「设置 → 本机 daemon → 允许其他电脑远程连接」里都有——开关跑 `enable` / `disable`，「生成配对码」跑 `pair` 并用大字显示码和剩余时间，「作废这个码」跑 `pair-cancel`，「已配对的电脑…」跑 `list` / `revoke`。开关显示的是之后 `status` 读回的结果；读不到时显示「状态未知」，不提供开关。另一台电脑上，「添加远程 daemon」列出那台电脑 Tailscale 里的机器（`tailscale status --json`，只读），对在线的每一台在 47387 端口问一次远程入口在不在——「已打开远程连接」「未打开远程连接」（连接被拒绝）「不确定」（其余一切情况，不当成没开）「不在线」——机器名点选、不用抄；自定端口或列表读不到时仍可「手动输入机器名」。远程入口只能在那台机器上打开：没有窗口的服务器仍要在它上面跑一次 `pair`。

</details>

<details><summary>配对</summary>

**配对**：`pair` 打印这台机器的完整机器名（以 `.ts.net` 结尾）和一个 8 位配对码，在客户端「添加远程 daemon」里填这两样。配对码 10 分钟有效、只能用一次、连续输错 5 次作废。配对成功后客户端得到一把只属于它的钥匙（存在它的系统钥匙串里），这台机器把它记在 `~/.local/state/cavil-loop/remote-access/devices.json`（目录 700、文件 600）。

</details>

<details><summary>每条命令和结果</summary>

**每条命令**的最后一行是 `RESULT=<...>`（`list` / `revoke` 除外）：

| 命令 | 做什么 | 结果 |
|------|--------|------|
| `enable [--port N]` | 登记 `tailscale serve` 转发（HTTPS，仅本 Tailscale 网络）→ 写后台任务文件 → 启动常驻服务。默认端口 47387。换端口时，新端口起来之后撤掉本功能在旧端口上的转发（撤不掉：`partial`，退出 3，写明哪个端口）。端口上已有别的转发时不接管，哪怕形状一样（`port_taken`） | `enabled`；前提不满足：`tailscale_down` / `tailscale_unknown` / `no_https` / `need_admin` / `funnel`（这个端口开着公网入口）/ `port_taken` / `unknown`（后台任务状态读不到），退出 2、什么都没动；`failed` 退出 3 |
| `pair` | 入口没开就先 `enable`，再生成配对码（新码顶替等待中的码）。另给桌面客户端打印 `HOST=` / `CODE=` / `EXPIRES=`（失效时刻，秒） | `code` |
| `pair-cancel` | 作废等待中的配对码（没有也算成功） | `cancelled` |
| `status` | 只读。服务在运行时另写出它跑的是不是磁盘上的代码（`ENTRY_CODE=`，见「更新之后」）。另给桌面客户端打印 `HOST=`（读到机器名时才有）、`PORT=`、`DEVICES=`（台数，清单读不懂是 `unknown`） | `open` / `closed` / `partial` / `unknown` |
| `list [--machine]` | 列出已配对设备：编号、设备名、Tailscale 设备名、配对时间。`--machine`：一台一行 `DEVICE=<编号>\t<设备名>\t<设备>\t<时间>`，最后 `RESULT=ok` | —（`--machine` 时 `ok`） |
| `revoke <设备名或编号>` | 撤销一台设备，立刻生效；没有这台设备退出 1 | — |
| `disable` | 停服务并移除后台任务文件 → 撤掉本功能登记过的每一个端口的转发（换过端口也一并撤，别的功能的转发不动）→ 清掉等待中的配对码。已配对设备清单保留 | `disabled`；状态读不到退出 2、什么都没动；停不下来或转发撤不掉退出 3（`partial`），输出里写明还剩什么、该跑哪条命令 |

</details>

<details><summary>边界：能做什么、不能做什么</summary>

**边界**：

- 常驻服务只监听 `127.0.0.1`；对外只有 `tailscale serve` 那一条 HTTPS 转发。`enable` 不开公网入口（funnel），发现这个端口上开着就拒绝。本功能登记过哪些端口记在 `~/.local/state/cavil-loop/remote-access/ports`（登记前先记、撤掉并读回确认后才划掉），关闭和换端口都按它收尾；Tailscale 的转发设置读不到（查询失败，或退出 0 却没有输出）时什么都不动。这份清单和记着当前端口的 `port` 文件本身也分「没有 / 读得懂 / 读不懂」三种：读不了、或有一行不是端口号，就是「不知道哪些转发是本功能的」——`enable`、`pair`、`disable` 退出 2（`RESULT=state_unknown`）、什么都不动、不覆盖这份文件，`status` 报 `unknown`；按提示用 `tailscale serve status` 核对后把 `ports` 改成每行一个本功能登记过的端口（一个都没有就删掉文件）再重跑。清单写不进去时：登记之前发现的，不登记（`state_unwritable`，退出 2）；撤掉转发之后才发现的，报 `partial`（退出 3），修好后重跑。已配对设备清单读不懂时，`status` 写「读不到」、`list` / `revoke` 退出 2，不报「0 台」。
- 每个请求先确认来访者：转发层给出的来访地址必须是一个 Tailscale 地址，且本机 `tailscale whois` 查得到它是哪台设备。查不到、查询失败、带公网入口标记，一律拒绝。
- 配对之后钥匙不再传输：每个请求带「时间 + 一次性随机数 + 请求内容」的签名，回复也带签名；来访设备的 Tailscale 身份必须等于配对时那台，钥匙拷到别的设备上用会被拒。
- 能做的只有：读状态（`install-status.sh` 的输出原样）、停 / 启一个项目（`scripts/project-service.sh <key> stop|start`——只在「在跑 → 停」「已停 → 启」时执行，状态读不到既不停也不启，执行后读回）、读一个项目 `poll.log` 的最后 200 行、读 / 改一个项目的常用设置（在这台机器上执行 `scripts/project-config.sh <key> get|set`——只有 `scripts/config-fields.txt` 登记为可改的那几项，和「本机 daemon → 配置」在本机能改的一样；命令、钩子、令牌、目录和标签类开关都不在其中）、撤销自己。不能断开项目、不能更新 daemon、不能接新项目、不能读整份配置文件、不能执行任意命令。
- 日志按盘上的样子返回，不另做处理：daemon 写 `poll.log` 之前已把 GitHub 令牌脱敏（开着脱敏的话），其余内容配对过的客户端都看得到。
- 同一台机器上的其他系统用户能连到回环端口，但没有配对码和钥匙做不了任何事。
- 常驻服务的代码在它启动那一刻读进内存。每轮轮询比一次它在跑的代码和磁盘上的代码，不一样就重启它——见下面「更新之后」。

</details>

<details><summary>更新之后：自动重启，以及手动步骤</summary>

**更新之后。**更新只换磁盘上的文件，常驻服务照旧跑它启动时的代码。每轮轮询（Linux、macOS 一样）问一下本机回环端口上的服务在跑哪份代码（`/v1/hello`：接口级别，以及它启动时脚本内容的 sha256），和服务登记指向的那份脚本（`--skill <目录>`）比。只有回答证明两者不同——指纹不是磁盘上那份，或者答了「我是本功能的入口」却不报指纹（较老版本的入口）——才重启它：

- 只重启正在运行的服务（Linux `systemctl --user try-restart`，macOS `launchctl kickstart -k`：停着的、已卸载的都不会被启动），而且持着 `enable`、`disable` 也要拿的同一把锁（`~/.local/state/cavil-loop/remote-access/svc.lock`），拿到后全部重读一遍。拿不到锁的那一轮跳过；`enable` / `disable` 最多等 60 秒，等不到就什么都不改（`RESULT=busy`）；
- 服务之后报出磁盘上的指纹才算重启完成。失败或确认不了的，隔 1、2、5、15 分钟再试，同一份代码最多 5 次，记在 `remote-access/restart.json`（发重启前先记「进行中」，轮询中途被杀也算一次）。失败 5 次后不再试，在轮询的系统日志里每天说一次、在 `status` 里写明；哪一轮看到服务已经是磁盘上的代码就删掉记录，代码再变就重新开始。记录读不懂 = 不自动重启（删掉它即重新开始）；重启前记录写不进 = 不重启；
- 读不到的——服务管理器、回环上的回答、端口记录、服务登记——什么都不改，记一行日志，等下一轮；
- 正在停止的服务对新请求回 503 `not_ready`，把在途的请求做完（最多 30 秒）再退出。

`status` 写出两份代码（`ENTRY_CODE=same|differs|unknown`）和自动重启的状态。客户端说那台机器的远程入口在跑更新前的代码、或判断不了时，给的就是下面这几步——只用服务管理器和服务自己的登记，所以不管 skill 目录叫什么（`cavil-loop`、`coding-agent-work-loop`、`coding-agent-workflow`、开发副本）都能照做：

1. 重启远程入口（配对和端口不变）。Linux：下面第一行，打印 `active` 算成功（`inactive` 或「not found」= 远程入口没开）。macOS：第二块的第一行，打印 `state = running` 算成功（「Could not find service」= 没开）。两条都不会把关着的入口打开。
2. 回客户端再点「配置」。能读出，就是这个原因，结束。
3. 仍是同一条提示：那台机器的代码早于这项功能，要更新 daemon。第二行打印服务用的 skill 目录：目录里有 `.git`（手动 / 开发模式安装），跑 `git -C <目录> pull`；没有（托管安装）会自己更新，约 10 分钟内。什么都没打印：服务登记缺失或读不了，到那台机器上重跑一次安装（`setup.sh`）。更新后再做一次第 1 步。

<!-- remote-restart-linux:begin -->
```bash
systemctl --user try-restart cavil-loop-remote.service && systemctl --user is-active cavil-loop-remote.service
systemctl --user cat cavil-loop-remote.service | sed -n 's/.*--skill \([^ ]*\).*/\1/p'
```
<!-- remote-restart-linux:end -->

<!-- remote-restart-mac:begin -->
```bash
launchctl kickstart -k gui/$(id -u)/dev.luosky.cavil-loop.remote && launchctl print gui/$(id -u)/dev.luosky.cavil-loop.remote | grep 'state ='
sed -n 's|.*<string>--skill</string><string>\([^<]*\)</string>.*|\1|p' ~/Library/LaunchAgents/dev.luosky.cavil-loop.remote.plist
```
<!-- remote-restart-mac:end -->

</details>

<details><summary>客户端取消配对</summary>

**客户端取消配对**：连得上时由这台机器确认撤销；连不上时客户端只能停止使用并显示「取消配对未完成」——这时这台机器上的授权**还在**，恢复连接后客户端会重试，或在这台机器上跑 `revoke`。

</details>

<details><summary>协议（给想自己写客户端或排查的人）</summary>

**协议**（给想自己写客户端或排查的人）。入口 `https://<机器名>:<端口>`：

- `POST /v1/pair`，请求体 `{"code": "<8 位>", "name": "<设备名>"}` → `{"version": 1, "id": "<设备编号>", "key": "<64 位十六进制钥匙>", "name": ...}`。
- 其余请求带四个头：`X-Cavil-Device`（设备编号）、`X-Cavil-Time`（Unix 秒，与这台机器相差不超过 120 秒）、`X-Cavil-Nonce`（16–64 位十六进制，不能重复——处理过的请求记在 `nonces.json` 里，服务重启后重放同一个请求照样被拒；这份记录读不懂时，服务在 240 秒内不接受任何签名请求，回 503 `not_ready`）、`X-Cavil-Signature` = HMAC-SHA256(钥匙, `方法\n路径\n时间\n随机数\nSHA256(请求体)的十六进制`) 的十六进制。回复的 `X-Cavil-Signature` = HMAC-SHA256(钥匙, `resp\n随机数\n状态码\nSHA256(回复体)的十六进制`)。
- `GET /v1/hello`（不签名）→ `{"service": "cavil-loop-remote", "version": 1, "level": <接口级别>, "fingerprint": "<正在跑的脚本的 sha256>"}`（较老版本的入口不报 `level` / `fingerprint`）。`GET /v1/status` → `{"status": <install-status.sh 的输出>, "entry": 正在跑的服务的 {"level", "fingerprint"}}`——状态里带着磁盘上那份代码的 `remote_access: {level, fingerprint}`，客户端据此分得清「代码太旧」和「已更新、没重启」；`POST /v1/projects/<key>/stop|start` → `{"result": "ok|failed|refused|not_found", "state": "running|stopped|unknown", "output": ...}`；`GET /v1/projects/<key>/log` → `{"path", "exists", "text"}`；`POST /v1/unpair` → `{"result": "revoked"}`。
- 项目常用设置：`GET /v1/projects/<key>/config` → `{"result": "ok", "config": <project-config.sh get 的输出>}` 或 `{"result": "not_found|unreadable", "output": ...}`。`POST /v1/projects/<key>/config`，请求体 `{"rev": "<读到的配置指纹>", "values": {"MAX_CONCURRENT_WORKERS": "3"}}` → `{"result": <project-config.sh set 的 RESULT 词>, "detail": {...}, "output": ...}`。执行 `set` 之前服务先核对请求体——设置名 `[A-Z][A-Z0-9_]*`（≤ 64）、值只含 `A-Za-z0-9._:/@,+-`（≤ 200）、指纹 64 位十六进制、1–64 项；不合规回 `result: "refused"`，读、写脚本都不执行——再读一次配置，只放行此刻标成可改的项（否则 `refused`，不执行 `set`）。`set` 没有给出 `RESULT=` 行（被杀、超时）回 `unconfirmed`：文件可能改了也可能没改。远程入口太老、不认识这两个请求的机器对这两个请求回 404 `not_found`；客户端这时再读一次状态，说明是哪一种：磁盘上的代码太旧（更新 daemon）、磁盘上的代码已更新但入口还在跑旧的（重启它）、或判断不了（照上面「更新之后」的几步）。
- 出错时回复 `{"error": "<代码>", "message": "<给人看的话>"}`：`not_tailscale` / `unknown_device` / `funnel`（403，来访者不是查得到的 Tailscale 设备）、`pairing_closed` / `pairing_wrong` / `pairing_expired` / `pairing_locked`（403）、`revoked`（401，没配对或已撤销）、`device_mismatch` / `signature` / `clock` / `replay`（403）、`status_failed`（502，状态脚本没跑成）、`not_ready`（503，见上）。

</details>

## 升级、迁移、回退与开发模式

受管 **Linux** 安装**自动**升级：每轮 poll 跟 `CAVIL_DEPLOY_BRANCH`（默认 `main`）的最新 commit，合入后最迟约一个 fetch 节流周期（`CAVIL_DEPLOY_FETCH_INTERVAL`，默认 300 秒）加一次 tick 生效。**macOS** 手动升级。回退没有持久做法；要停在某个版本，用开发模式，或把 `CAVIL_DEPLOY_BRANCH` 指向停在该 commit 的分支。

<details><summary>受管 Linux 升级怎么做</summary>

受管 **Linux** 每轮 poll 在明确的网络超时内 fetch 配置的 base 分支，完整解包不可变文件树后再原子替换稳定软链；断网、锁竞争或 fetch 失败都保留当前 release，fetch 进行时消费者仍可从当前 release 启动。升级是**自动**的，不需要也无法指定目标版本：跟的是 `CAVIL_DEPLOY_BRANCH`（默认 `main`）的最新 commit，与 GitHub Release / tag 无关，release 只是该 commit 的不可变快照 `releases/<sha>/`。全机共用 `CAVIL_DEPLOY_FETCH_INTERVAL`（默认 300 秒）的 fetch 节流，因此合入 base 分支后最迟约一个节流周期加一次 tick 生效。切换只影响之后启动的进程：已在运行的消费者持 `.inuse` 共享租约，继续跑自己那个 SHA。旧式 checkout 安装只通过显式动作迁移：

</details>

<details><summary>旧式 checkout 迁成受管；开发模式</summary>

```bash
bash ~/.agents/skills/cavil-loop/setup.sh <host>
# 或在旧 checkout 中：
bash scripts/skill-deploy.sh --bootstrap --force
```

这样不会误接管维护者的开发软链。Linux 上单独执行 bootstrap 也会把已安装的 systemd 模板软链改指稳定受管 skill，并 reload user manager；它不会安装原本不存在的 unit，新装调度器仍应使用 `setup.sh`。稳定路径原本是实体目录时，会保留为带时间戳的 `.pre-managed.*` 备份。开发模式把稳定软链原子指向 `releases/` 外，日常部署会拒绝接管，直到再次显式 bootstrap。开发模式仍会从该 checkout 安装持久的 `entrypoints/`，因为调度器 unit 一律经由它启动。缺这些启动器的 checkout 会让 poller 每轮以 127 退出（`poll-entry.sh: No such file or directory`，只出现在 poller 的 `journalctl --user -u <timer 单元>` 里，`poll.log` 里没有）；pull 到最新 commit 或执行 bootstrap 即可恢复。

</details>

<details><summary>回退</summary>

**回退目前没有持久做法**：部署成功后会立即清理所有没有活跃租约的旧 release，通常不留可回退的目标；即使某个旧 release 因仍有租约而暂时保留，手工把软链指回去也只维持到下一轮部署——部署器不比较新旧，只把软链对齐 base 分支 tip，因而会再次切到最新 commit。需要持续停在某个版本时，用开发模式脱管，或把 `CAVIL_DEPLOY_BRANCH` 指向一个停在该 commit 的分支。

</details>

<details><summary>部署对各类改动文件怎么处理；告警</summary>

| 变更 | 部署行为 |
|---|---|
| scripts、数据、prompt | 随稳定软链切换生效 |
| systemd `.service` / `.timer` | 自动执行 `systemctl --user daemon-reload` |
| systemd `.socket` / `.slice` 改了或删了 | 不自动应用；开一条带人工步骤的告警 |
| **新增** systemd 单元文件 | 不用处理——还没有任何机器装过它；不告警 |
| launchd plist 模板内容变了 | 不自动应用；要求重跑 `setup.sh` |
| launchd 模板新增 / 改名 / 删除 | 不用处理——已生成的 plist 不依赖模板文件；不告警 |

远端被确认持续领先超过配置阈值后，部署器在指定仓库最多开一条告警，追平后自动关闭这类落后告警。需要人工处理的调度告警（`.socket`、`.slice`、launchd 或 `daemon-reload` 失败）不会被下一次无变更部署误关；维护者处理完并关闭告警 issue 后，部署器才清除该状态。

</details>

<details><summary>macOS：手动升级</summary>

**macOS** 仍手动升级。LaunchAgent plist 是 per-project、由 `setup.sh` 生成；模板变化后重跑：

```bash
launchctl bootout gui/$UID/dev.luosky.cavil-loop.<key> || true
rm ~/Library/LaunchAgents/dev.luosky.cavil-loop.<key>.plist
bash ~/.agents/skills/cavil-loop/setup.sh <host>
```

只有受管 Linux 会自动取得纯脚本更新。

</details>

### 升级不会自动补上的新配置

升级不改项目的 `cavil-loop.config`，所以「不写这一行就关」的新功能在老项目上一直关着。调度轮询每轮都检查这类缺项，每个缺项第一次缺失时在 `poll.log` 里写一行提示（补上又去掉会再提示一次），别的什么都不做。

<details><summary>哪些配置会提示、什么时候提示</summary>

升级换的是代码，不动项目自己的 `cavil-loop.config`。新功能若是**配置里不写就关**、而 `cavil-loop.config.example` 里是开的（新装项目因此默认就有），老项目上它就一直关着，没有任何提示。这类配置项在 [`scripts/config-notices.txt`](../scripts/config-notices.txt) 里登记为 `notice`；模板里其余每一项都登记为 `quiet` 并写明原因（不写时行为相同、必填项、示例值、权限参数）。

daemon 每轮调度轮询把这些项和配置（加上 systemd 环境文件）实际设置的值对一遍。写成空值（如 `ENABLE_CONCURRENT_WORK_HINT=""`）算「已决定不开」，不会被提示。每个缺项在 `poll.log` 里写一行（`⚠️ 配置提示：本项目配置里没有 <KEY> …`，附上要开时照抄的模板行和不开时写的值）——每项一次；补上又去掉的项会再写一次。

它只做这一件事：这件事上 daemon 不发任何 GitHub 调用，不开提示 issue；较老版本开过的提示 issue 不评论、也不自动关，由人手动关掉。老配置里写着的 `CONFIG_NOTICE_ISSUE` 一行不起作用，留着无害。daemon 从不改配置。只在调度器经 `poll-entry.sh` 起的轮询里运行：手动直接跑 `agent-poll.sh` 试跑、或在 worker 会话里跑，都不写。状态在 `$STATE_DIR/config-notice.json`，删掉它只意味着「重新判断一次」（最坏每个缺项的日志多写一次）。

</details>

<details><summary>看一个项目缺什么</summary>

直接看一个项目缺什么，在任意 shell 里跑（先改 `KEY`，别的什么都不用设）：

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

怎么看：`logged` 是当前缺的项（每项在 `poll.log` 写过一次）。把某一项写进配置后，下一轮调度轮询就把它从列表里去掉。早先版本写下的文件里可能还有 `issue` / `issued`，下一轮调度轮询会把它们去掉。

</details>

<details><summary>往模板里加新配置项</summary>

往 `cavil-loop.config.example` 里加配置项时，要在同一个改动里登记进 `scripts/config-notices.txt`，否则 `tests/config-notice.test.sh` 红。只有「不写就关、模板里开」的才登记成 `notice`。

</details>

## 改名前的安装

项目改名为 `cavil-loop` 之前装的安装（原名 `coding-agent-work-loop`）在迁移前照旧用旧名字运行，迁移是自动的——见[旧安装自动迁移](#旧安装自动迁移)。新旧路径同时存在时一律用新的。

<details><summary>新旧名字对照</summary>

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

</details>

<details><summary>代码怎么挑名字，对各部分意味着什么</summary>

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

</details>

### 旧安装自动迁移

`scripts/migrate-legacy.sh` 把一个旧项目迁到新名字。不用人去跑：Linux 上任何一个项目的轮询都会把本机空闲的旧项目迁掉；
macOS 上重跑一次 `setup.sh <host>`。

<details><summary>两种系统上各在什么时候迁</summary>

- **Linux**：**任何一个**项目的每一轮轮询（`poll-entry.sh`，在主轮询读配置之前）都会顺手把本机
  所有空闲的旧项目迁掉。所以它随部署生效——受管安装合并后约 10 分钟内。开发模式的机器（技能
  入口指向一个 checkout）要等那个 checkout 更新到包含它的版本。迁的正好是起这一轮的旧 timer
  所属的项目时，这一轮到此结束，迁移刚启用的新 timer 约 30 秒后跑下一轮。
- **macOS**：重跑一次 `setup.sh <host>`。它先迁移，再生成新的 LaunchAgent——plist 是生成出来的，
  后台轮询自己换不了。

</details>

<details><summary>只迁空闲的项目</summary>

**只迁空闲的项目。** 空闲 = 这个项目没有 worker 的 tmux 会话（`<TMUX_PREFIX>-<SESSION_NAME_PREFIX><N>`）、
周报没在生成、轮询锁没被占着。**先**拿轮询锁，持锁再看 worker 和周报：派工只发生在持有这把锁
的轮询里，所以从看完到搬目录之间不可能冒出新 worker（先看后拿锁的话，中间那一轮轮询可以派完工、
放掉锁）。正在跑的 worker 记住的是旧路径，在它底下搬状态目录，它下一次 `source _lib.sh` 就会在
旧位置建出一个空目录。忙的项目每轮都会再试，等待原因一小时最多记一次。周报不读状态目录，查它只是
为了不在它跑的时候换它的定时任务。

</details>

<details><summary>项目迁到一半时，它的主轮询暂停</summary>

**项目迁到一半时，它的主轮询暂停。** 从第 1 步到最后，进度文件里写着这个项目的配置（`CFG=…`），
`poll-entry.sh` 看到就直接结束这一轮、不跑 `agent-poll.sh`。不然一轮轮询正好落在「状态目录已搬、
配置还没改」中间，就会在旧位置 mkdir 出空状态目录，用空状态把历史评论重新派一遍。下一轮（本项目
或任何一个项目的）接着迁。光看一眼进度文件不够——一轮轮询可能在迁移开始前看过、又恰好在目录搬走
前读了旧配置。所以本机还有旧安装时，`poll-entry.sh` 从这次检查一直到 `agent-poll.sh` 拿到本项目的
轮询锁，都持着全机迁移锁的**共享**一侧（拿到后立刻放掉，派出去的进程不会继承）；迁移要拿排他一侧
才能开始。所有需要人处理的情况（见下）都在第 1 步**之前**查完，所以只有确实迁得完
的项目才会暂停。迁移中途仍在旧位置冒出的空壳（没有 `state.json`、只有 `poll.log` / `poll.lock`）
认得出来：日志并进新目录后删掉。

</details>

<details><summary>按顺序做的步骤</summary>

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

</details>

<details><summary>什么时候删旧技能入口</summary>

本机一个旧项目都不剩、**旧预览也都搬到了新单元**时，删掉旧的 `~/.agents/skills/coding-agent-work-loop`；
还经过它的单元链接（旧预览模板、旧 slice）先改走新入口——旧单元文件一个字节都没改。

</details>

<details><summary>故意不搬的</summary>

故意不搬的：

- 项目自己的文件：`coding-agent.config` 不改名（项目的忽略规则写的是旧文件名），只改写里面的
  `STATE_DIR` 那一行（以及同一目录的其他写法）；备份绝不写进项目目录。仓库里已提交的覆盖目录不改名。
- `~/.local/state/coding-agent-poll/review-shots`：评论配图从这里经公网地址提供；新目录不存在时
  代码继续用它。
- 配置在 `~/.local/state/coding-agent-poll/<p>` 以外的状态目录：原地不动。

</details>

<details><summary>什么时候停手等人；一直失败时</summary>

以下情况在动任何东西之前就停手等人（日志里带 ⛔，每轮都会再试，但一小时只记一次；期间旧安装照常轮询）：新旧两份环境文件都在、又不是
迁移留下的半成品（有人手动装过新的——可能两个 timer 都开着）；新旧两个状态目录都在；项目配置的
`STATE_DIR` 不是能机械改写的写法；新状态根目录在另一个磁盘分区。

开始迁之后仍然每次都失败的项目（比如 `systemctl` 每次都报错）会一直暂停，每次尝试都记一行 ❌。
macOS 上迁到一半时重跑 `setup.sh` 会接着迁完；这种状态下 setup 不会再按旧名字往下装。

</details>

<details><summary>日志与撤销</summary>

日志：`~/.local/state/cavil-loop/migrate.log`（也在跑它的那个轮询的 journal 里，项目自己的 `poll.log`
里留一行）。要撤销，照备份目录手工恢复。

</details>

#### 旧预览搬到新单元

删掉旧技能入口之前，旧项目登记的每个预览都会搬到新单元上，端口和地址不变——每轮轮询自动搬。一个端口有两个不同主人时（冲突）等人处理（见下面的折叠块）。

<details><summary>为什么预览要搬、谁来搬</summary>

旧预览单元文件里 `ExecStart` / `ExecStartPost` 写死的是 `%h/.agents/skills/coding-agent-work-loop/scripts/…`。
只改单元文件的软链救不了它：删掉旧入口之后，旧单元一启动就找不到脚本，预览全部 502。所以删
入口之前，`~/.config/coding-agent-work-loop/preview/` 下的每份登记都要搬到 `cavil-loop-preview*@<端口>`
上，端口和 URL 不变（tailscale 路由按端口绑，也不用动）。

谁来搬：旧项目全部迁完之后，每一轮轮询的迁移步骤都搬一次（失败的下一轮再来）；`preview-serve.sh`
在本机已装新单元、而自己名下的登记还在旧目录时，先搬再注册。两处是同一个函数
（`scripts/_preview_adopt.sh`），全程持端口锁。

</details>

<details><summary>每个端口的步骤和三种状态</summary>

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

</details>

<details><summary>处理冲突（人工）</summary>

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

</details>

<details><summary>轮询入口什么时候调迁移</summary>

轮询入口调迁移的条件因此不止「还有旧项目的环境文件」：旧登记目录里还有登记、或者旧入口还在而新入口
也在，同样会调（`_names.sh` 的 `cavil_legacy_leftovers`）。三样都没有就不调。守卫：
`tests/preview-legacy-adopt.test.sh`。

</details>

## 手动 cron 兜底

[按 OS 选调度器](#按-os-选调度器)里的两种调度器不是硬要求：`agent-poll.sh` 无状态，任何调度器都能驱动。适用于 `setup.sh` 不自动配的系统（BSD、不带 systemd 的 WSL、容器、……），或者就不想用 systemd / launchd。

<details><summary>cron 配置行</summary>

**cron**（任何 Unix）：

```cron
* * * * * CODING_AGENT_CONFIG=$HOME/myproject/cavil-loop.config bash $HOME/.agents/skills/cavil-loop/scripts/poll-entry.sh >> /tmp/cavil-loop-cron.log 2>&1
```

</details>

<details><summary>改用 Claude Code 的 <code>/loop</code> 会话驱动</summary>

起一个长 session 跑 `/loop 60s bash ~/.agents/skills/cavil-loop/scripts/poll-entry.sh`。优点：调度逻辑也能上下文感知；缺点：贵 + session 死了就停。

</details>

## 升级到 webhook（即时触发）

轮询有最坏 1 分钟延迟。要即时触发，就让一个小的 webhook listener 在 GitHub 事件到来时跑 `agent-poll.sh`，timer 留着当兜底。

<details><summary>步骤</summary>

1. tailscale funnel / cloudflare tunnel 把本机 `<port>` 开公网
2. 跑 [`webhook`](https://github.com/adnanh/webhook) 这种小 listener 订阅 GitHub `issue_comment` + `labeled` 事件
3. listener 收到 → 直接跑 `agent-poll.sh`（poll 本身按 label 过滤 + state.json 去重，safe to retrigger）
4. 保留 systemd timer / launchd LaunchAgent 当兜底

</details>

## 自定义 worker（不是 Claude Code）

Worker 切换走一层薄的 **driver 抽象**，不需要 fork。内置：`claude`、`opencode`、`codex`、`cursor`；想加自家 agent，往 `scripts/drivers/<name>.sh` 加（或放项目级 `<host>/.agents/skills/cavil-loop/drivers/<name>.sh`） — 5 个函数的接口契约和模板见 [drivers.zh.md](drivers.zh.md)。

<details><summary>各个角色用哪个 agent 和模型</summary>

普通任务默认使用 `WORKER_AGENT=claude`；`WORKER_MODEL` 只覆盖普通任务的模型。启用可选 review 关卡后，review 独立使用 `REVIEW_WORKER_AGENT=codex` 和 `REVIEW_MODEL`；模型留空时由对应 driver 使用自己的当前默认值。

</details>

## 发版节奏

每轮迭代（一个自然周，周一到周日）发一个版本。定时运行每天北京时间 00:10 触发，门禁的普通回归全绿后发刚结束的那一周；`client/` 有改动时桌面客户端在同一次运行里一起发。

Release 只是 changelog 和 `npx skills add` 的落点，**和受管安装的升级无关**：受管 Linux 跟的是 base 分支最新提交（见[升级、迁移、回退与开发模式](#升级迁移回退与开发模式)）。

<details><summary>每周发版怎么走：时间、哪一周、哪个提交、门禁、tag 规则、手动发版、客户端</summary>

每轮迭代结束发一个版本。迭代按 cavil project 看板的 Iteration 字段：每轮 7 天、周一开始，和自然周对齐，所以不读看板，直接按日历触发：

- **何时**：`.github/workflows/release.yml` 的定时触发，**每天** 00:10 北京时间（16:10 UTC）。周一那次发刚结束的那一周；其余六天发现这一周已发布，十几秒就结束——周一门禁没过时，修复合进 main 之后的第一次每天检查把这一周补发出来，名字和标题仍归那一周。GitHub 的定时任务高峰期会晚几分钟到几十分钟执行。
- **发哪一周**：「刚结束的那一周」= 运行开始时按北京时间算、最近一个已经过完的周日 D（北京时间周日 23:59 还是上一周，周一 00:00 起是这一周）。计划那步只算一次，门禁和打标签都用它定下的周、提交和 tag，跨过零点也不变。只补最近这一周：连续漏发两周以上时更早的周不单独出版本，它们的提交算进补发的这一版。
- **运行期间 main 又有合入时发哪个提交**：一次运行可能排在另一次 Release 运行后面等着（同一时间只跑一个），门禁也要跑一阵，这期间 main 常会有新提交。计划那步取它执行时 main 的最新提交——不是触发运行那一刻的提交；发版那步只给门禁测过的那个提交打 tag，不管 main 之后又走了多远。只有签出根本不在 main 历史上（分叉）才拒绝。在本机手动跑 `scripts/release.sh` 仍要求本地 main 与 `origin/main` 完全一致。
- **门禁跑什么**：shell 普通回归——和每个 PR 上 Tests 工作流同样的四个 `tests/run.sh --ci` 分片和「每个单元恰好通过一次」核对——测的是 tag 将要指向的那个提交。任何一个门禁任务红、被跳过或缺失，就不打 tag、不建页面。负对照**不在**门禁里：它们每晚单独跑（见后面第二节），红了开 issue，不拦发版。
- **发什么**：tag 是 `release/vD.N`。Release 标题带上 tag 日期所在的周一～周日，例如 `release/v2026.10.25.1 · 迭代 2026-10-19 ~ 10-25`。计划那步（`scripts/release.sh --plan`）按顺序判断，命中第一条即定：
  1. main 最新提交上有 `release/v*` tag 还没有 Release 页面 → 门禁测这个提交，给这个 tag 补建页面，不打新 tag
  2. 刚结束那一周的 tag 里有没有页面的（取序号最大的那个）→ 门禁测**这个 tag 自己的提交**，给它补建页面，不打新 tag
  3. main 最新提交上的 tag 都有页面 → 不发，日志写「本轮无新提交」
  4. 这一周已有发布过的 tag：定时运行不发；手动发版给 main 最新提交打这一周的下一个序号
  5. 其余 → 给 main 最新提交打 `release/vD.1`
- **上次只推了 tag 也能补**：tag 已推但 Release 页面创建失败时，下一次运行（定时或手动发版）先补这个页面（上面第 1、2 条），排在「这一周已发布」之前。生成说明的起点是最近一个**有 Release 页面**的 tag，一直没补上页面的 tag（例如更早一周的）会被跳过，它的改动算进下一个 Release。查不到 Release 列表时整次运行失败，不猜。tag 直接读远端（签出里可能还留着远端已删的 tag），读不到同样整次失败；建页面前再核对远端 tag 仍指向受测提交，被删或被挪走就不建，`gh release create --verify-tag` 也不会替缺失的 tag 新建一个。
- **手动发版**：Actions 页面 → Release → Run workflow（选 main，不勾 `gate_only`），按上面同一张表走，只差第 4 条；勾 `gate_only` 只跑门禁（普通回归），永远测 main 最新提交，不看这一周发没发，不打 tag 不建页面。或在本机 main 上跑 `bash scripts/release.sh`（交互确认——用当天 UTC 日期，它不判断是否已发过）。
- **同一次运行里完成**：流程用内置令牌推的 tag 不会再触发流程，所以定时 / 手动运行在同一个 job 里接着生成 Release；人手推的 tag 仍由 tag 触发走后半段。不需要额外 secret。
- **桌面客户端一起发**：会发这一周版本的运行（上面第 1、2、4、5 条——不含只跑门禁的手动运行，也不含人手推的 `release/v*` tag）同时看客户端：上一个有 Release 页面的客户端正式版以来 `client/` 有改动，就也出一个客户端正式版。版本号是最大的 `client/vX.Y.Z` 标签末位加一；提交在 `client/package.json` 里的版本更高时用它（要开新的次版本号就在那里改）。发版不用先提交改版本号，打包时按标签写进去。`client` 任务调用 `.github/workflows/client.yml`，对计划定下的那个提交、那个标签跑和人手推 `client/v*` 标签完全一样的快速测试、完整测试、两台 Mac 打包、体积门槛和建发版页；人手推标签照旧可用。这些全过了才在受测提交上打标签。后台工具的发版不等客户端，客户端也不等后台工具的门禁。客户端红了，这一周就没有客户端正式版（后台工具照发），下面的失败报告会写明；修好后，下一次每周发版在 `client/` 有改动时再出，也可以手动推标签。

</details>

### 发版运行失败会自动开 issue

Release 的任何一次运行——定时、tag 推送、手动发版、手动「只跑门禁」（正文标「诊断运行」）——只要有任务失败，最后一个任务 `report failure` 就会写到一条 issue 上，失败不再只有打开 Actions 页面的人才看得到。被取消的运行不报告。

<details><summary>报告写什么、判断不了时</summary>

- **没有未关闭的同类 issue**：新建一条，标题 `Release 工作流运行失败（自动报告）`，带 `pending/agent`，daemon 照常派工。「同类」= 本仓库、未关闭、创建者 `github-actions[bot]`、正文含 `<!-- cavil-release-failure -->`、不是 PR。
- **已有一条未关闭**：在编号最小的那条下追加评论，**从不改它的标签**——它正在处理、等人、等前置，都原样保持。处理完就关掉它；下次失败会新建一条。
- **写了什么**：运行链接、触发方式、受测提交、每个任务的结果和失败步骤、门禁汇总里没通过的 shell 单位。门禁通过、只有发版任务失败时写明失败在哪一步。
- **判断不了时**（issue 列表某一页或其中某一条读不全、查到之后到写入之间那条 issue 变了）一律不写，`report failure` 任务标红，看该任务日志。
- 新 issue 打的标签是仓库变量 `RELEASE_FAILURE_LABEL`（默认 `pending/agent`），必须和本仓库的派工标签一致。

</details>

<details><summary>补打漏掉的标签；停用 / 恢复报告</summary>

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

</details>

### 负对照每晚单独跑

负对照是故意把代码改坏、要求测试变红——检验的是测试本身，不是代码。全部负对照（每个 `tests/*.test.sh` 带 `MUTATION=1`、autopilot 分到六个任务的改坏副本、客户端的 `test/mutation` 和真实应用那一套）只在 `.github/workflows/negative-controls.yml` 里跑：

<details><summary>什么时候在哪跑、红了怎样</summary>

- **何时**：每晚 02:10 北京时间（18:10 UTC），测 main 最新提交。定时运行在第一个任务里先查：本工作流上一次成功运行就在同一个提交上，就到此为止；查不到就照跑。Actions → Negative controls → Run workflow（选 main）手动跑，总是跑；在别的分支上运行什么都不做。
- **不在 PR 上跑，也不在 Tests、Client 里跑**：这两个工作流的手动运行也没有「也跑负对照」的选项。worker 和复审在开发期间不跑负对照。
- **不拦发版**：发版门禁只跑普通回归（见上面「门禁跑什么」）。
- **红了自动开 issue**：和 Release 运行失败同一个脚本、同样的规则（只新建或评论、写前重读、从不改已有 issue 的标签），但是单独一条：标题 `负对照每晚运行失败（自动报告）`，标记 `<!-- cavil-negative-controls-failure -->`，带 `pending/agent`（`RELEASE_FAILURE_LABEL`）。两种报告互不评论到对方的 issue 上。正文列出失败的任务、没按预期变红的 shell 单位和客户端条目。

</details>

<details><summary>停用 / 恢复每晚报告</summary>

<!-- negative-controls-ops:begin -->
**停用每晚报告**（照常每晚运行，红了只是不开 issue）与**恢复**：

```bash
gh variable set NEGATIVE_CONTROLS_REPORT --body off --repo GigleAI/cavil-loop
gh variable delete NEGATIVE_CONTROLS_REPORT --repo GigleAI/cavil-loop
```

停用只跑第一行，恢复只跑第二行。核对：`gh variable list --repo GigleAI/cavil-loop` 停用期间显示 `NEGATIVE_CONTROLS_REPORT off`，恢复后没有这一项。
<!-- negative-controls-ops:end -->

</details>

### 客户端开发版每晚出

客户端的开发版（标签 `client/vX.Y.Z-dev.N`，标着 Pre-release）由 `.github/workflows/client.yml` 每晚出一次，不再是每次合进 main 就出：

<details><summary>什么时候跑、打包和发布什么、怎么判断出不出、手动出一版</summary>

- **何时**：每晚 04:30 北京时间（20:30 UTC）起跑，约一个小时，取 main 最新提交。GitHub 的定时任务高峰期会晚几十分钟，偶尔整次不跑，那一晚就顺延到下一晚。
- **有改动才出**：先看最新一个已发的开发版构建自哪个提交，再比那个提交和 main 最新提交在 `client/`、`.github/workflows/client.yml`、`.github/actions/client-setup/` 上有没有差别。没有差别就到此为止，不打包、不发，这一轮是绿的。最新那一版没带齐、没上传完六个文件，或者它的标签不在发版记下的提交上（见下面「核对一版是否带齐」——每晚判断、发布、重跑和人用的核对命令是同一条规则），也算没发完：已经公开的版本一律不改——还是那个提交时不打包、不发（勾 `force` 时照样打包检查，发布那一步报失败、什么都不写）；main 上有了新提交，就照常构建，发一个更高的版本盖过它，客户端没有改动也一样，没带齐的那一版原样留着。从没公开过的草稿（上次发布中途断了留下的：没有发布时间、还没有标签）照常补齐再发布；公开过又被改回草稿的（GitHub 留着它的发布时间和标签）和已公开的一样不改，读不出是哪一种时也不改。新建发版页和补齐草稿之前都先读这个版本的标签：标签已经在（不管指向哪个提交——发版页删了、标签还留着，或单独打过）就当这个版本做过，一样不改；读不到也不写。发布之后再读一次，标签必须指向这次构建的提交，否则这次运行报失败、不清理旧版本；之后重跑同一个提交，发现这一版文件齐全也照样先核对标签，标签不对就一样报失败、不清理。补齐时换上这一次构建的全部六个文件——这些文件互相依赖（`latest.json` 里记着各个安装包的签名），只补一个会对不上。有一个版本更高、标签还在、发版页却不公开的开发版时，也照常构建；它就是这个提交时不构建（同一个提交出不了新版本，它又不能改）。这些都只管「补包时改不改文件」：保留最近 10 个之外的旧开发版照常连标签一起清理掉，那是到期清理，不是改写。有文件读不出是否上传完时（列表里没有状态、状态是不认识的词、大小读不出、同名文件不止一个、有文件没有名字，或整份文件列表读不出），或者某个发版读不出是不是草稿、是不是预发布时，读第二次，仍读不出就什么都不改。读不到发版列表或标签列表、比不出差别，都按「有改动」照常构建。上一晚在测试或打包时失败，这些改动就还没发出去，下一晚照样重试；失败在发布那一步时，那一版可能已经发出、只发了一半或没发出：从没公开过的草稿下一晚补齐，已公开却没带齐的原样不动、等下一个提交发更高的版本，带齐发出的不再重发。
- **跑什么**：快速测试、Apple 芯片的 Mac 打包和它的真实更新检查、Windows x64 打包和它的真实更新检查（装上低一版的测试版，让它在开发版渠道上自己找到新版、下载、验签、重启后装好；字节被改过的安装包必须被它拒绝、什么都不改）、体积门。全部通过才发成预发布，只留最近 10 个。完整测试不在这里，仍在每周日那一次。
- **合进 main 时**：只跑快速测试，不打包、不发版。
- **手动出一版**：Actions → Client → Run workflow，选 main，勾 `publish`。和每晚那一轮完全一样；再勾 `force` 时跳过「有没有改动」那一步：main 自上一版以来前进过，就出一个内容一样、版本号更高的新版；还是同一个提交，就照样打包检查一遍，发布那一步发现这个版本已经发过，什么都不写。在别的分支上勾 `publish`，第一步就失败，不打包、不签名、不写发版页；不勾 `publish` 的手动运行在任何分支上都只打包检查（用一次性密钥），不发。
- **一次只发一个**：每晚的和手动勾 `publish` 的运行排在同一个队里，后来的等前一个跑完，不会取消正在跑的；合进 main 的快速测试和 PR 上的检查不在这个队里。

</details>

<details><summary>每晚红了开 issue；核对一版是否带齐</summary>

- **红了自动开 issue**：和发版失败同一个脚本、同样的规则（只新建或评论、写前重读、从不改已有 issue 的标签），单独一条：标题 `客户端每晚开发版失败（自动报告）`，标记 `<!-- cavil-client-nightly-failure -->`，带 `pending/agent`（`RELEASE_FAILURE_LABEL`）。只有每晚那一轮会开，手动运行红了不开。正文写明这次要发的是哪个版本、失败在发布之前还是发布那一步，并附上对这个版本按下面规则核对的结果：现在已完整在发版页上（这次发出后、收尾没做完，或者是之前的运行发出的、这次没走到发布）、没完整发出（装着的 App 仍是上一版；还没公开的下一晚重试，已公开却没带齐的等下一个提交发更高的版本），或读不出（要人按下面的命令核对）。核对的是这次要发的那一版，不是 Releases 页上最新的那一版——这次没建出新版时，最新的那一版是前一晚的。
- **核对一版是否带齐**：一个开发版要带齐并上传完这六个文件——Apple 芯片的 `-arm64.dmg`、`-arm64.app.tar.gz`、`-arm64.app.tar.gz.sig`，Windows 的 `-windows-x64.exe`、`-windows-x64.exe.sig`，以及 `latest.json`。Releases 页上列着但大小为 0 的文件是没上传完的，不算。也可以在本仓库的 `client/` 目录跑只读核对（和发布、每晚判断用同一条规则，不写任何东西；版本号换成要核对的那个）：

<!-- client-nightly-check:begin -->
```bash
node scripts/dev-release.mjs --check 0.5.3-dev.640 --repo GigleAI/cavil-loop
```
<!-- client-nightly-check:end -->

  打印 `COMPLETE` 才算发好（退出码 0）：六个文件都上传完，**并且**这一版的标签在发版记下的那个提交上；`INCOMPLETE` 后面写着缺了或没上传完的文件，或者「文件都已上传完成，但标签指向别的提交 / 标签不存在」（退出码 1）；`UNKNOWN` 是读不到发版列表、有文件读不出是否上传完、读不出这一版是不是草稿，或标签读不出（退出码 2），不是「没有」。

</details>

<details><summary>停用与恢复每晚报告</summary>

<!-- client-nightly-ops:begin -->
**停用每晚报告**（照常每晚出版，红了只是不开 issue）与**恢复**：

```bash
gh variable set CLIENT_NIGHTLY_REPORT --body off --repo GigleAI/cavil-loop
gh variable delete CLIENT_NIGHTLY_REPORT --repo GigleAI/cavil-loop
```

停用只跑第一行，恢复只跑第二行。核对：`gh variable list --repo GigleAI/cavil-loop` 停用期间显示 `CLIENT_NIGHTLY_REPORT off`，恢复后没有这一项。
<!-- client-nightly-ops:end -->

</details>

## 故障排查

下面每一条从看到的现象（或想问的问题）出发，先给要查的第一件事；命令收在它下面的折叠块里。

### 最近几轮轮询都干了什么（运行记录）

每一轮轮询退出时写一条记录（时间、结果、走到的最后一步、看到几个候选派了几个、GitHub 调用几次失败几次）；出了
问题的那一轮还会另存一份快照。默认开启。查看最近几轮：

<details><summary>命令</summary>

<!-- poll-history-ops:begin -->
```bash
KEY=myproject    # the instance name / 实例名: systemctl --user list-timers 'cavil-loop-poll@*'
ENV_FILE="$HOME/.config/cavil-loop/$KEY.conf"
[ -f "$ENV_FILE" ] || ENV_FILE="$HOME/.config/coding-agent-work-loop/$KEY.conf"   # installed before the rename / 改名前装的
CONF=$(sed -n 's/^CODING_AGENT_CONFIG=//p' "$ENV_FILE" | tr -d '"')
bash "$HOME/.agents/skills/cavil-loop/scripts/poll-history.sh" --config "$CONF" -n 20
```
<!-- poll-history-ops:end -->

</details>

<details><summary>命令打印什么、每种结果是什么意思</summary>

`poll.log` 里只有代码主动打的那些行，轮询进程的 stderr 又是指向 `/dev/null` 的，运行记录补上另一半。非零退出、
读不到 GitHub、轻量检查超时或失败、某一步超过 `POLL_RUN_LOG_SLOW_SECS`、发现上一轮卡在锁上的那一轮，还会另存
一份**快照**。`poll-entry.sh` 一进来就先写一行「已启动」，所以「完全没跑起来」和「跑了没事做」分得开。

命令打印：最近几轮的表格；有进度文件、没有正式记录的轮次；入口记录（启动了但没走到「配置加载完」，或在那之前
就退出了，带退出码）；最近一份快照，连同那一轮在 `poll.log` 里对应的那一段。`--json` 是同一份数据，给机器读。

| 结果 | 含义 |
|---|---|
| `ok` | 正常跑完 |
| `pace-skip` | 被空闲 / 故障退避跳过（轻量检查的结果在单独一列） |
| `lock-busy` | 上一轮还没跑完；备注里写着占锁的是哪一轮、已经跑了多久 |
| `github-unreadable` | 读不到 GitHub，没派工就停了（有快照） |
| `label-rename` | 有一次流程标签改名还没做完，或配置在这一轮加载之后被改过——这一轮什么都没做（[给流程标签改名](#给流程标签改名)） |
| `label-watch` | 改名后的标签核对发现 GitHub 上那个标签的名字和配置不一样，或读不到——这一轮什么都没做 |
| `error` | 非零退出（有快照，带脚本名和行号） |
| `early-exit` | 没走到最后就以 0 退出，走的是运行记录没有起名字的路径 |

</details>

<details><summary>读的时候要知道</summary>

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

</details>

<details><summary>文件在哪、各留多少</summary>

每个目录都是先腾出一个位置再新增，所以就算轮次接连在写到一半时被杀，数量也守得住；只有恰好同一时刻在写的几轮
才会短暂超出，每轮最多多一份。

| 路径 | 内容 | 保留 |
|---|---|---|
| `$STATE_DIR/runlog/rounds/` | 每轮一条正式记录 | `POLL_RUN_LOG_ROUNDS`（1000） |
| `$STATE_DIR/runlog/snapshots/` | 快照 | `POLL_RUN_LOG_SNAPSHOTS`（20） |
| `$STATE_DIR/runlog/inflight/` | 进行中轮次的进度 | `POLL_RUN_LOG_INFLIGHT`（64） |
| `$STATE_DIR/runlog/acct/` | 平时是空的：每一轮在这里建一份计数用的文件，打开之后立刻删掉 | `POLL_RUN_LOG_INFLIGHT`（64） |
| `~/.local/state/cavil-loop/runlog/entry/` | 没走到「配置加载完」的那些轮询的入口记录（本机所有项目共用） | 200 |

</details>

<details><summary>关掉并删除已有记录</summary>

要再打开，把 `ENABLE_POLL_RUN_LOG=false` 那一行删掉；下一轮轮询会重新建目录。

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

</details>

### poll.log 变稀疏了，daemon 是不是死了

多半没死：一整天没人碰的项目会**故意**少轮询（`POLL_BACKOFF_LADDER`），退避中的每个 tick 仍然写一行，写明现在
在哪一档。日志**真**的一行都没有（连跳过那行也没有），才是 daemon 真的停了，往下看。

<details><summary>日志长什么样</summary>

```
[...] [myproj] 本轮跳过（已安静 3d4h，当前档位 10m0s，还差 7m12s）
```

</details>

<details><summary>按顺序查，以及怎么立刻回最快档</summary>

```bash
cat ~/.local/state/cavil-loop/<key>/poll-pace.json    # 现在哪一档、从什么时候开始安静
grep -c 'poll start' ~/.local/state/cavil-loop/<key>/poll.log   # 到目前为止真跑了几轮
rm ~/.local/state/cavil-loop/<key>/poll-pace.json     # 立刻回最快档
```

删这个文件永远是安全的：它只存节奏，不存「哪些评论看过了」那些游标（那些在 `state.json` 里）。而且不管它里面
是什么，两条保证都成立：最长 `POLL_FORCE_SYNC_SECS` 一定会跑一次完整轮询；任何解析不出来、或者超出合法范围的
状态一律按「现在就该跑」处理，而不是「再等等」。想整个关掉就把 `POLL_BACKOFF_LADDER` 置空。

</details>

<details><summary>开着空闲轻量检查时</summary>

`POLL_IDLE_PROBE` 开着时，跳过那行末尾带「；轻量检查：无变化」；被它叫醒的那个 tick 记一行「轻量检查：仓库有
变化 → 提前跑一轮」，或者写明为什么说不准（「读不到 GitHub」「GitHub 回了 HTTP <n>」），说不准时同样照跑。打标签、
评论（含代码行内评论）、往 PR 推送提交、关闭 / 合并大约一个 tick 内就能看到；主干新提交、CI 结果看不到，等下一次
完整检查（最长 `POLL_IDLE_PROBE_MAX_SECS`，默认 10 分钟）。删 `~/.local/state/cavil-loop/<key>/poll-probe.etag`
同样安全：下一次检查只是多跑一轮。

</details>

### Timer / agent 起来了但 daemon 不跑

看调度器的状态和轮询单元自己的日志；常见原因是项目 conf 里路径不对、配置缺字段、`gh` 没登录、`claude` 不在调度器
的 `PATH` 里。

<details><summary>查看用的命令（Linux / macOS）</summary>

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

</details>

<details><summary>常见原因和处理</summary>

两个系统通用：
- `~/.config/cavil-loop/<key>.conf` 路径不对 → 编辑 conf
- `cavil-loop.config` 缺字段 → 看 `poll.log`
- `gh auth` 没登录 → `gh auth status`
- `claude` 不在调度器 `PATH` 里 → `~/.config/cavil-loop/<key>.conf` 里 `PATH=` 加上 `which claude` 的目录

macOS 专属：
- "Bootstrap failed: 5: Input/output error" → 之前的 load 还在。`launchctl bootout "gui/$UID/dev.luosky.cavil-loop.<key>"` 后重跑 setup。
- `<key>.err.log` 报 `flock: command not found` → `brew install flock`。

</details>

### 发新版后某个项目的定时任务消失了（`Unit to trigger vanished`）

某个项目的 `poll.log` 停住、没有报错，`systemctl --user list-timers` 里它的 NEXT 是 `-`（或根本不在列表里），
journal 里有 `Unit to trigger vanished.`。每一轮轮询都会自动修好它；只有这台机器上**所有**项目的定时任务都已经停了、
没有任何一轮轮询来修时，才要手动处理。

<details><summary>现象和原因</summary>

journal 里有

```
cavil-loop-poll@<key>.timer: Failed to open …/cavil-loop-poll@<key>.timer: No such file or directory
cavil-loop-poll@<key>.timer: Unit to trigger vanished.
```

`systemctl --user enable` 会把模板链接解析到底，实例链接和 `timers.target.wants/` 里那条都直指某一个
`~/.agents/releases/cavil-loop/releases/<sha>/`，而不是稳定入口 `~/.agents/skills/cavil-loop/`。部署器一清理那一版，
定时任务的单元文件就没了。

</details>

<details><summary>自动修复是怎么做的，以及它的限制</summary>

`scripts/repair-unit-links.sh`。每一轮轮询（总是当前版本）、部署器清理旧版本之前、`setup.sh` 启用之后、旧安装
迁移启用之后都会跑它。它把我们自己的链接（新名字和改名前的名字）改回稳定入口；改之前先写一个持久的「待重新加载」
记号，`daemon-reload` 成功才清掉（所以重新加载失败了，下一轮哪怕没有链接要改也会再做）；记号清掉之后，才启动
systemd 报告为「已启用 + 失败、原因 `resources`」的定时任务——这正是 systemd 记录「运行中单元文件消失」的方式。
你停掉的（`inactive`）、禁用的，一律不启动；状态查不到也不动。部署器也不会删除还有单元链接指进去的版本。

限制：手动 `systemctl --user reset-failed` 之后这个记录就没了，不会替你启动；user manager 重启也会丢掉它（链接修好
后，已启用的任务登录时本来就会起来）。

</details>

<details><summary>手动修复：第 0–4 步</summary>

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

1. 更新到带 `repair-unit-links.sh` 的版本（机器上只有改名前的入口时，`if` 那段会自动换成 `~/.agents/skills/coding-agent-work-loop`）：

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

</details>

### Worker session 卡在权限弹窗

确认 `cavil-loop.config` 里 `CLAUDE_EXTRA_FLAGS="--dangerously-skip-permissions"`。本机受信任环境下强烈推荐。

### Worker 卡在目录信任确认框（「Quick safety check」/「Trust this folder?」）

daemon 每次起会话前都会先写信任记录、起完看一眼屏幕，所以这种情况表现为：这条活被翻回 `pending/human`，留言写明
哪个 agent、哪个目录；`poll.log` 里有一行 `卡在 <agent> 的目录信任确认框上（工作目录 …，该补的信任记录：…）`，
当时的屏幕存进了会话日志。

<details><summary>怎么处理</summary>

1. 先在 `poll.log` 里找那次派工前后以 `[trust]` 开头的行：等锁超时、「连续 3 次在写入前被别的进程改动」、配置文件读不懂，都会说明记录为什么没写进去。
2. 都没有，多半是 agent 改了判定规则。在 daemon 机器上进入留言里的那个目录手动跑一次 agent，选信任后退出，再把标签改回 `pending/agent`。然后看 agent 自己写的是哪一条（`~/.claude.json` 的 `projects`、`~/.codex/config.toml` 的 `[projects."…"]`），据此改那个 driver 的 `agent_trust_key`。

</details>

### 所有项目的 poll.log 停在同一分钟

不是哪个 worker 卡住了——整个 `systemd --user` manager 没了，连带**所有**项目的每个定时任务、每个 tmux 会话、每个
worker。通常是 systemd-oomd 杀的；修法都在 root 一侧，不在本仓库里。

<details><summary>先确认</summary>

不费事，也不用 root：

```bash
for k in <key1> <key2> …; do
  echo "--- $k"; tail -1 ~/.local/state/cavil-loop/$k/poll.log
done
systemctl show user@$(id -u).service -p ActiveEnterTimestamp   # a recent timestamp on a
                                                              # long-uptime box = it restarted
```

所有项目都停在同一分钟内，说明是 manager 被杀了，不是某个 worker 卡住。

然后到**系统** journal 里找结论——`journalctl --user` 永远看不到 oomd：

```bash
sudo journalctl --since "<that minute>" | grep -iE 'oomd|user@<uid>'
```

长这样（真实抓到的）：

```
systemd-oomd: Killed /user.slice/user-1003.slice/user@1003.service/init.scope
  due to memory pressure for /user.slice/user-1003.slice/user@1003.service
  being 63.73% > 50.00% for > 20s with reclaim activity
systemd[1]: user@1003.service: Main process exited, code=killed, status=9/KILL
```

</details>

<details><summary>两个容易弄错的地方</summary>

- **oomd 挑中的是 `init.scope`**——装着 `systemd --user` 本身的那个 cgroup，只有几 MiB。它按 pgscan 速率给子 cgroup
  排序，不看大小；所有候选的增量都是 0 时（转储里 `Pgscan == Last Pgscan`）就拿第一个，也就是 manager。所以给 worker
  slice 设 `MemoryHigh=` / `MemoryMax=` 影响不了谁被杀。更糟的是，`MemoryHigh=` 的限流本身会**制造**触发条件要求的
  回收活动，让这一刀来得更早。
- **没有任何东西会把 manager 拉回来。** `Linger=yes` 只是让**正在运行**的 manager 在登出后不退，不会重启一个已经失败
  的。只有有人登录时 manager 才会回来（开一个 SSH 会话，logind 会顺带启动这个单元），这期间不会有任何告警。

</details>

<details><summary>修法（root 一侧）</summary>

```ini
# /etc/systemd/system/user@<uid>.service.d/no-oomd.conf
# overrides /usr/lib/systemd/system/user@.service.d/10-oomd-user-service-defaults.conf
# for this uid only
[Service]
ManagedOOMMemoryPressure=auto
```

```ini
# /etc/systemd/system/user-manager-watchdog.service  (+ a 2-minute .timer)
[Service]
Type=oneshot
ExecStart=/bin/sh -c 'systemctl is-active --quiet user@<uid>.service || systemctl start user@<uid>.service'
```

oomd 解除之后，兜底的是 worker slice 自己的 `MemoryMax=`：超出它是内核的 cgroup OOM，只能挑这个 slice **里面**的进程，
所以被杀的总是某个 worker，self-heal 下一轮会重新派工。内存怎么算见 `systemd/app-cavil\x2dloop\x2dpoll.slice` 里的注释。

</details>

### 每次派工几秒内就死，self-heal 永远救不回来

`tmux ls` 显示「no server running」时，是轮询单元自己起的 tmux server 在轮询退出时被一起杀掉，新的 worker 会话也跟着
没了。轮询单元自带 `KillMode=process` 来防这件事——确认它还在：

<details><summary>命令</summary>

```bash
systemctl --user show cavil-loop-poll@<instance>.service -p KillMode   # want: process
```

</details>

<details><summary>poll.log 里的现象</summary>

一个总以错误的「会话损坏」结论收场的循环：

```
dispatch PR #N comment ...
🔄 self-heal: PR #N session=<prefix>-issue<M> 不存在 → 自动重新派工（第 1/3 次 …）
… (3 rounds) …
⚠️ self-heal: PR #N 自动恢复 3 次仍死（疑似会话损坏）→ 转人工 pending/human
```

看 tmux server 到底还在不在：

```bash
tmux ls   # "no server running on /tmp/tmux-<uid>/default" → this is your case
```

</details>

<details><summary>为什么会这样</summary>

平时 tmux server 是长期存在的，住在**别的** cgroup 里（由交互式登录启动），`tmux new-session` 只是连上去，不会在轮询
单元的 cgroup 里留下东西。一旦 server 死了——通常是 systemd-oomd 杀掉了整个 `user@<uid>.service` cgroup——下一次
`tmux new-session` 会**自己启动 server**，而它落在 `cavil-loop-poll@<i>.service` 里面。单元是 `Type=oneshot`，systemd
默认的 `KillMode=control-group` 会在轮询脚本退出的那一刻给这个 cgroup 里剩下的一切发 SIGTERM，刚起的 server 和它的
worker 会话一起没了。

所以 self-heal 永远不会成功：重新派工、会话又死、三轮用完，这条活被以假的「会话损坏」理由扔到 `pending/human`。

</details>

<details><summary>复现，以及出事之后怎么恢复</summary>

不碰 daemon 就能复现（也能确认已修好）：

```bash
systemd-run --user --unit=probe --service-type=oneshot \
  /usr/bin/tmux new-session -d -s probe 'sleep 300'
sleep 3 && tmux ls   # session gone → control-group; session listed → process
```

被放弃路径送到 `pending/human` 的条目要把原来的触发标签打回去。daemon 把它记在 `state.json` 的 `worker_trigger_labels`
下，`poll.log` 每一行重试也写着它（`翻 doing/agent → X`）。先把 `KillMode` 修好——在那之前重新打标签只会再死一次。

</details>

### 每轮都打印「上一轮还没跑完，跳过」，什么都不跑

`poll.lock` 的 flock 卡住了：有个长期存在的进程（tmux server、某个 worker）还拿着它的文件描述符。删掉锁文件就能解开，
不用杀任何进程：

<details><summary>命令</summary>

```bash
rm -f "$STATE_DIR/poll.lock"
```

</details>

<details><summary>原因，以及怎么找出占锁的进程</summary>

flock 挂在**打开的文件描述**上，所以只要还有**任何**进程开着那个 fd，锁就一直被占着——而 `agent-poll.sh` 把它开成
fd 9，子进程会继承。长期存在的进程一旦落进轮询的进程树，就会开着 fd 9 好几个小时，锁永远不释放。daemon 于是彻底
安静：没有报错、没有派工，只是永远「跳过」。

```bash
# any process still holding the lock
for p in /proc/[0-9]*; do
  for fd in $p/fd/*; do
    [ "$(readlink -f "$fd" 2>/dev/null)" = "$STATE_DIR/poll.lock" ] &&
      echo "$(basename "$p") $(tr -d '\0' < "$p/cmdline" | cut -c1-60)"
  done
done 2>/dev/null | sort -u
```

短命的 `bash` / `gh` 进程是正在跑的那一轮，正常。`tmux` 或 worker 进程才是问题。`_lib.sh` 被 source 时就关掉 fd 9
（所有派工脚本都在启动长期进程之前 source 它）；看到某个 worker 占着锁，就是这道防护缺了。

删锁文件管用，是因为 flock 绑在 inode 上：下一轮打开的是一个新文件，旧进程继续锁着那个已经删掉的 inode。

</details>

### Daemon 不停 re-dispatch 同一 PR

可能是 worker 没翻 label。检查 prompt 模板是否要求 worker 翻 label。或手动：
<details><summary>命令</summary>

```bash
gh pr edit N --add-label pending/human --remove-label pending/agent
```

</details>

<details><summary>另一个原因：worker 没留评论</summary>

如果 worker 没回任何 comment 就完事，state.json 的 comment ID 不会推进，下次又会被当新评论。Prompt 应强制 worker 至少回一句评论。

</details>

### 条目一直停在 `doing/agent`，会话还在却没人干活

worker 没发评论、没翻标签就停下了，tmux 会话却还活着，这条会一直占着并发名额。配了 `STUCK_WORKER_QUIET_SECS` 时
daemon 自己处理（默认关闭；要再关掉，配置里写 `STUCK_WORKER_QUIET_SECS=""`），`poll.log` 里都以「卡住检测：」开头。

<details><summary>daemon 一步步怎么做</summary>

常见原因：worker 自己判断「不该我做」后空手结束、拿到空 prompt 干等、崩在翻标签之前。self-heal 只救「会话不在」的，
回收看到 `doing/agent` 就跳过。

| 什么时候 | daemon 做什么 |
|---|---|
| agent 空闲、GitHub 和本地分支都没动静，连续 `STUCK_WORKER_QUIET_SECS` 秒 | 往工作窗格里发一段固定的催促文字（不写 GitHub） |
| 催完再过 `STUCK_WORKER_STEP_GAP_SECS` 秒仍没动静 | 把 `doing/agent` 换回派工时的触发标签，确认换成后结束会话，下一轮重派；最多 `STUCK_WORKER_MAX_RESTARTS` 次 |
| 重派后又卡住 `STUCK_WORKER_QUIET_SECS` 秒 | 留一条评论（卡了多久、试过哪几步、怎么继续），翻 `pending/human`；会话保留 |

「空闲」是看屏幕判断的：agent 把活放到后台再等结果时，看起来也是空闲。所以默认要连续 30 分钟，第一步也只是催促。
阶梯进度记在 `state.json` 的 `stuck_workers` 里，daemon 重启后接着走；条目正常交接（离开 `doing/agent`）后清零。

</details>

<details><summary>每项判断是怎么做的</summary>

判断只用脚本比对，不调用大模型：

- **忙不忙**看的是登记的工作窗格的画面，按这条会话实际跑的那个 agent 的规则判（复审 agent 和开发
  agent 的忙碌特征字不一样）。压缩上下文算忙，停在弹窗上算闲。
- **有没有动静**：条目和它绑定的条目（PR 对应的 issue、issue 对应的 PR）的标签、评论、提交，
  加上本地工作分支的最新提交。任何一项变了，或任何一轮看到 agent 在忙，计时清零。
- **保护标签**：条目自己同时挂着 `pending/human`、等前置、等外部需求机器人、任一派工标签、
  `pending/merge`、`pending/PR`，或绑定条目挂着 `pending/human`、等前置、等外部需求机器人，就不
  推进。PR 对应的 issue 挂着 `pending/PR` 是开 PR 后的正常状态，不算保护。
- **每次动手前全部重读**：留言、加标签、摘标签、结束会话，每一次之前都把条目、绑定条目和本地会话重新读一遍，必须和
  开始计时时完全一样（是否打开 / 已合并、目标分支、最新提交、来源、标签、最新评论与标签事件、
  工作窗格和 agent），否则这一轮不动手、重新计时。
- **读不出就不动**：tmux 或 GitHub 有任何一项读不出，这一轮不推进、不清零。
- **做到一半出异常就停住**：重派 / 交人那一步要写好几次 GitHub（重派：加触发标签 → 摘 `doing/agent`
  → 结束会话；交人：发评论 → 加 `pending/human` → 摘 `doing/agent`），全部在同一轮里做完。第一次写入
  之后，任何一次写入没当场确认成功、两次写入之间核对出变化、或读不到状态，daemon 当场停住这一条：
  不撤回已经写的、不重试、不留到下一轮接着做。第一次写入之前核对不过只是重新计时，不算停住。

</details>

<details><summary>不会被处理的几种</summary>

日志里每种原因只提示一次：

- 不是本机派的（`state.json` 的 `worker_hosts` 里记的不是本机）
- 会话上没有记录 agent / 角色，或会话里有多个窗格又没有登记工作窗格
- 同一个工作编号下 issue 和 PR 同时挂着 `doing/agent`（共用一个会话，分不清在给哪条干活）
- 会话已经不在了（那是 self-heal 的事）

</details>

#### daemon 对一条停手之后

日志里有一行「🧊 卡住检测：… 停住，交给人处理」，条目上有一条「⚠️ daemon 已对这一条停手，等人处理」的说明评论。
要恢复，在条目上摘掉所有流程标签、再打上要用的那一枚派工标签；做不到时，在本机用 `stuck-release.sh` 解卡。

<details><summary>停住期间哪些事不做</summary>

说明评论写着发生了什么、现在的标签、会话是否还开着、怎么恢复。停住期间 daemon 对这一条（以及它当时核对过的关联
issue / PR）不派工、不改标签、不结束会话、不合并：

| 环节 | 停住时 |
|---|---|
| 派工（各派工标签、复审、greedy 兜底、只挂托管标签的自动开工） | 不派；例外只有下面「在 GitHub 上恢复」那一枚标签 |
| 会话不在时的自愈、完工会话回收 | 跳过，标签和会话原样留着 |
| 托管：接手 PR、复制托管标签、合并 | 跳过 |
| 等前置检查 | 跳过，前置完成了也不翻回 |
| PR 没合并就关闭后翻关联 issue 的标签；PR 合并后给 issue 打 `Done` / 交人、清理工作目录；子项全关后父 issue 的收尾 | 先不做，也不记成做过；恢复后的那一轮再做 |
| 等人 PR 的冲突检查 | 跳过 |

条目被关闭不算恢复：记录留着，重新打开后仍然停住（合并了的 PR 开不回来，记录清掉）。

</details>

<details><summary>在 GitHub 上恢复（正常办法）</summary>

1. 在这一条的 Labels 里把流程标签（`doing/agent`、`pending/review`、`pending/agent` 这一类）全部摘掉；
   摘标签不会触发任何事。
2. 再打上要用的那一枚派工标签（例如 `pending/agent`）；要用的正是刚摘掉的那枚，就摘掉后重新打一次。
3. daemon 下一轮照常派工，把这枚标签换成 `doing/agent`，停住记录清掉。

daemon 认的是：**说明评论发出之后**最后一次流程标签变化是人打上一枚派工标签、条目上现在只有这一枚
流程标签、关联的 issue / PR 没有挂 `pending/human` / 等前置 / 等外部需求机器人。这三条在派工脚本
翻标签或启动会话之前还要现读一遍，仍然成立才派。只加分类标签、挂 `pending/human`、摘标签，都不算恢复；
说明发出之前（或刚发出的几秒内）打的不算，打上后两轮还没开工就摘掉再打一次。
人和 daemon 共用同一个 GitHub 账号的项目，daemon 分不清标签是谁打的，这条路走不通，用下面的本机解卡。

一条恢复指令只用一次：daemon 按它派工之后，只有确认「标签是这次派工换的、会话是这次派工起的 / 送过
任务的」才算成功；否则（派工脚本失败、标签没换成、结果读不到）重新停住并发一条新的说明——说明里写着
任务是否已经送进会话——同一次打标签不会再派第二遍，要继续就再打一次。这类派工不走普通的
「连续失败 N 次转人工」。

</details>

<details><summary>本机解卡</summary>

停住说明一直发不出去、或 `poll.log` 里一直没有「开始认人的恢复指令」时用。在跑 daemon 的机器上运行

<!-- stuck-release-ops:begin -->
```bash
KEY=myproject      # the project's instance name (~/.config/cavil-loop/<KEY>.conf)
N=123              # the issue / PR the daemon stopped on
bash ~/.agents/skills/cavil-loop/scripts/stuck-release.sh "$KEY" "$N"
```
<!-- stuck-release-ops:end -->

它拿着这个项目的轮询锁（期间轮询暂停）现读条目的整份身份（打开 / 合并、目标分支、最新提交、来源仓库、
标签、最新一条流程标签事件、关联条目的标签）并打印出来，要求输入 `yes`（最多等 5 分钟），然后再读
一遍，两次完全一样才删掉停住记录。只改本机记录，不写 GitHub。删掉之后这一条回到普通流程——条目上
现有的派工标签会照常派工，所以先在页面上把标签整理成想要的样子再运行。

| 退出码 | 含义（非 0 时什么都没改） |
|---|---|
| 0 | 已解除 |
| 1 | 用法不对 / 没有这个项目 / 这一条没有停住记录 |
| 2 | 等了 2 分钟没拿到轮询锁，稍后再运行 |
| 3 | 输入 `yes` 之后再读，没读全，或者条目和确认前不一样了（标签、提交、目标分支…）；要解除就重新运行 |
| 4 | 读不到 GitHub（或本机状态文件），不能解除；读得到之后再运行 |
| 5 | 没有输入 `yes` |

</details>

### 同一条活每轮派工都失败

派工失败什么都不改，下一轮 poll 会把同一条活再捡起来——最多连续 `DISPATCH_MAX_RETRIES`（默认 3）次，到上限就摘掉
触发 label、把这条活转 `pending/human`。原因在 `poll.log` 里：

<details><summary>命令</summary>

```bash
grep -E '派工失败|连续 .* 次派工失败' "$STATE_DIR/poll.log" | tail
```

</details>

<details><summary>怎么看失败原因</summary>

派工失败时 label 没翻、comment cursor 没动。失败原因写在 `poll.log` 里，**不需要**再去翻 `journalctl`。如果某行看着
是空的或被截断，那是 bug：派工路径上的每一个 `git` 调用都应该走 `run_git` helper，它会在失败时把命令的完整输出逐行
写进日志。

</details>

<details><summary>目标分支已经被另一个 worktree 签出</summary>

git 对这种情况是**无条件**拒绝的：`git fetch` 必然失败（哪怕根本没东西要更新），而紧随其后的 `git worktree add --force`
反倒会成功、建出**第二个**签出同一分支的 worktree —— 两个 worker 往同一个分支上提交。所以派工会在动手之前就拒绝，
直接转 `pending/human`。留言里写出占用者的真实目录、它现在的状态（有没有未提交改动、比 PR 领先 / 落后几个提交、有没有
进行中的合并 / 变基），并按占用者种类给出能执行的命令：

```bash
# 占用者是主 checkout（你在那里开的分支并 push 了）：
git -C '<主 checkout>' switch main    # 腾出分支，然后重新标 pending/agent
# 占用者是附加 worktree：
git worktree remove '<占用者目录>'     # 腾出分支，然后重新标 pending/agent
```

主 checkout 不能 `git worktree remove`（`fatal: ... is a main working tree`）。项目是 git submodule 时，`git worktree list`
给主 checkout 报的是它的 gitdir（`.../.git/modules/<名字>`），daemon 会先解析成真实工作目录再显示。配置
`AUTO_RELEASE_MAIN_CHECKOUT=1` 后，确定安全时 daemon 会自己执行这个 `switch`（条件见配置模板），并在 PR 上留言说明。

</details>

<details><summary>失败计数</summary>

计数文件在 `$STATE_DIR/dispatch-fail/`，第一次成功时清零、升级转人工时也清零 —— 所以人工重标一次总能拿到完整的重试
次数。要手工清某一条：`rm -f "$STATE_DIR/dispatch-fail/pr-959"`。

</details>

### 调试一次 poll

用本项目的配置手动、立刻跑一轮轮询，再看它写下的日志——改了配置或挂点之后、或者定时跑的那几轮日志看不出问题时用。它和定时的一轮一样会真的干活（可能派工）。

<details><summary>命令</summary>

```bash
CODING_AGENT_CONFIG=~/myproject/cavil-loop.config \
    bash ~/.agents/skills/cavil-loop/scripts/poll-entry.sh
tail -50 ~/.local/state/cavil-loop/myproject/poll.log
```

</details>

### 浏览存活的 worker session

先按 `Ctrl+b`，再按 `s`。列表保留 tmux 原生 `choose-tree` 布局，并在每个 worker session 行末追加 GitHub issue 标题：

<details><summary>输出示例</summary>

```text
myproject-issue42: 1 windows | 优化首页加载性能
```

</details>

<details><summary>标题从哪来</summary>

标题存放在 session-scoped tmux option `@desc` 中；issue/PR worker session 每次创建或复用时都会刷新。没有 `@desc` 的
非 worker session 保持 tmux 原始显示。

</details>

### 回看已退出 session 的历史

tmux session 一旦 exit，原 pane 的 scrollback 就消失了，所以每个 worker session 的输出都用 `tmux pipe-pane` 旁路到磁盘：

<details><summary>命令</summary>

```bash
# 路径（默认值；可通过 SESSION_LOG_DIR 改）
$STATE_DIR/sessions/<TMUX_PREFIX>-issue<N>.log

# 快捷查日志
bash ~/.agents/skills/cavil-loop/scripts/session-log.sh 42        # 打印路径
bash ~/.agents/skills/cavil-loop/scripts/session-log.sh 42 -c     # cat
bash ~/.agents/skills/cavil-loop/scripts/session-log.sh 42 -f     # tail -F 跟随
```

</details>

<details><summary>文件格式，以及让对话本身续上</summary>

日志是 append-only，同一 issue 重起 session 会续写到同一份；每次启动会插一行 `===== <iso-date> session=... opened =====` 当分隔符。

想让 Claude 本身续上对话（而不只是看历史），或 worktree 已被 auto-cleanup 删掉想找回会话，见 [persistence.md → 断点续写 SOP](persistence.zh.md#断点续写-sop)（列了 `--resume <id>` / `--from-pr <P>` / 重建 cwd / 直接读 jsonl 四条路径）。

</details>

### 紧急停所有 worker

先停这个项目的调度器，再杀它的 worker 会话。

<details><summary>命令（Linux / macOS）</summary>

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

</details>

### 卸载某个 project

`bash ~/.agents/skills/cavil-loop/scripts/disconnect-project.sh <key>` 按系统做完下面的必做步骤（改名前的旧安装同样适用），后台任务状态读不到时什么都不删——见[用脚本安装、查状态、断开](#用脚本安装查状态断开)。

<details><summary>手动做（Linux / macOS）</summary>

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

</details>
