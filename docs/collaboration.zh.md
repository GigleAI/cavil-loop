# 多人协作：人 + Agent 混合工作流

> [English](collaboration.md) · **中文**

基础的五态标签系统覆盖「一个用户 + 一个 AI worker」。如果你的场景是**多个人 + 多个专职 AI agent 一起干**，把 actor 编进标签后缀就能扩展：

```
<状态>/<角色>/<名字>
```

例：

| 标签 | 含义 |
|------|------|
| `pending/human/Alex` | 等 Alex 处理（不是"随便哪个人都行"） |
| `pending/human/Sam`  | 等 Sam 处理 |
| `pending/agent/PM`   | 等 PM 角色的 agent 处理 |
| `pending/agent/QA`   | 等 QA 角色的 agent 处理 |
| `pending/agent/Frontend` | 等前端 stack 的 coding agent 处理 |

## 为什么用

`pending/human` 单兵作战够用。加名字后缀的好处是**把单轮往返变成多角色接力**：

```
issue → PM-agent（写方案）
     → human/Alex（批方案）
     → dev-agent（写代码）
     → QA-agent（在部署环境验）
     → human/Sam（最终 review + merge）
```

每一步的 label 就是路由指令。

## 怎么落地（不用改 skill 代码）

每个 AI 角色跑成一个独立的 daemon 实例，各自只监听自己的子标签。skill 已经支持这种用法——你只需要给每个 instance 写一份不同 label 值的 config。

### 每个 agent 角色一份 config

`/path/to/pm-agent.config`:
```bash
TMUX_PREFIX="pm"
SESSION_NAME_PREFIX="pm-issue"

LABEL_PENDING_AGENT="pending/agent/PM"
LABEL_AGENT_DOING="doing/agent/PM"
LABEL_PENDING_HUMAN="pending/human"     # 或想用 pending/human/<owner> 也行
LABEL_PENDING_PR="pending/PR"
LABEL_DONE="Done"

# PM 角色：只写设计文档，不写代码
WORKTREE_SETUP_CMD=":"
CLAUDE_EXTRA_FLAGS="--dangerously-skip-permissions"
```

`/path/to/qa-agent.config`:
```bash
TMUX_PREFIX="qa"
SESSION_NAME_PREFIX="qa-issue"

LABEL_PENDING_AGENT="pending/agent/QA"
LABEL_AGENT_DOING="doing/agent/QA"
LABEL_PENDING_HUMAN="pending/human"
LABEL_PENDING_PR="pending/PR"
LABEL_DONE="Done"

# QA 角色：跑测试 + 戳部署 URL，不改代码
WORKTREE_SETUP_CMD="npm ci"
CLAUDE_EXTRA_FLAGS="--dangerously-skip-permissions"
```

### 每个角色一份 prompt

每个角色的 worker 想要不同 prompt。在 `<host>/.agents/skills/cavil-loop/prompts/` 放角色特定的覆盖即可。当前查找逻辑写死成一个 host project 一份 prompt 集；如果想按角色后缀切 prompt 集，见下面的「Roadmap」。

### 每个角色一个 systemd timer

```bash
bash setup.sh ~/myproject pm-agent
bash setup.sh ~/myproject qa-agent
bash setup.sh ~/myproject dev-agent

systemctl --user enable --now cavil-loop-poll@pm-agent.timer
systemctl --user enable --now cavil-loop-poll@qa-agent.timer
systemctl --user enable --now cavil-loop-poll@dev-agent.timer
```

每个 timer 独立 tick，各 daemon 只扫自己的子标签。

## 常见工作流

### 1. PM → Dev → QA 接力（完整 SDLC 链路）

```
你开 issue，打 label: pending/agent/PM
   ↓
PM-agent 写设计方案到 issue comment，label: pending/human
   ↓
你批准，label: pending/agent/Dev
   ↓
Dev-agent 写代码、开 PR，PR label: pending/agent/QA
   ↓
QA-agent 跑测试 + 部署环境 smoke check，把结果 post 上去
   ↓ (通过)
QA 把 PR label 翻成 pending/human（或 pending/human/<reviewer>）
   ↓
你 merge
   ↓
Daemon auto-cleanup → Done
```

失败路径：QA 发现回归 → 翻回 `pending/agent/Dev` + comment 详情。Dev-agent 重读、修复、再交回 QA。

### 2. 多人 review 路由

Dev-agent 开 PR 之后，不打通用 `pending/human`，而是按规则（CODEOWNERS / 轮询 / 随机）挑一个 reviewer 打 `pending/human/Alex`。Alex 一看名字就知道是自己的队列。

Alex review：
- LGTM → `Done`（或直接 merge）
- 要改 → `pending/agent/Dev` + comment
- 想 Sam 也看一下 → `pending/human/Sam`

### 3. 按技术栈分工的 coding agent

仓库是 monorepo，`frontend/`（React）+ `backend/`（Go）。两个 cavil-loop 实例：

| 角色 | label | worktree setup | prompt 重点 |
|------|-------|----------------|-------------|
| `pending/agent/Frontend` | npm 体系 | `(cd frontend && npm ci)` | 组件模式、TS 严格性、e2e |
| `pending/agent/Backend`  | Go 体系  | `(cd backend && go mod download)` | API 契约、migration、覆盖率 |

triage 规则：根据 issue 涉及的文件路径 / 区域标签（`area/frontend`、`area/backend`）→ 触发对应子标签。

## 外部需求机器人

有的项目让另一个 AI 助手直接给项目提需求。这个助手有自己的 GitHub 账号，下文叫「外部需求机器人」，它背后是它服务的人（下文叫「提需求的人」）。机器人在装了 cavil-loop 的仓库里开 issue，cavil-loop 照常处理；这条需求**有要提需求方回答的问题**，或者**做完了**，都会把结果告诉机器人，由它带回答复或转告结果。这样机器人和 cavil-loop 之间形成闭环。

**默认关闭**，全部靠配置开启，代码和配置模板里不写任何具体的机器人名字（GitHub#95 / #97 / #100）。

### 一条需求是怎么闭环的

```
机器人开 issue（正文带标记、自己打 pending/agent）
   │
   ▼
agent 出方案 / 提问 / 汇报 ── 发评论 ── 跑叫醒脚本
   │                                   │ 挂等待标签、摘掉 pending/agent 等
   │                                   │ 调一次机器人的 webhook（配了才发）
   ▼                                   ▼
等待中：daemon 不派工          机器人来拉所有挂等待标签的条目 → 读讨论
   │                           → 带给提需求的人 → 在 issue 里写「已转给谁」
   │                                   │
   │                                   ▼
   │                     拿到答复 → 原文贴回 → 摘等待标签 → 打 pending/agent 让 agent 接着干
   ▼
agent 读答复，继续 …… PR 合并（或关闭未合并）
   │
   ▼
daemon 在机器人提的 issue 上留一条结果评论、加等待标签、调 webhook → 机器人把结果告诉提需求的人、摘标签
```

### 配置

| 配置项 | 作用 |
|---|---|
| `LABEL_PENDING_REQUESTER_BOT` | 等待标签，例如 `pending/requester-bot`。`setup.sh` 会按这个名字建标签 |
| `REQUESTER_BOT_ACCOUNT` | 外部需求机器人的 GitHub 登录名。只用来认出哪些 issue 是它提的（见下一行），**不再**指派给它或请求它 review |
| `REQUESTER_BOT_ALLOWED_ACTORS` | 允许执行叫醒的账号（逗号分隔），一般就是 worker / reviewer 发评论用的那个账号 |
| `REQUESTER_BOT_ORIGIN_MARKER` | issue 正文里出现这段文字、**并且** issue 作者就是机器人账号，才算「机器人提的需求」；PR 看它关联的 issue：分支名里的 issue 编号，没有就看正文的 `Closes #N` 这类写法（关键词和编号分在两行时认不准，拒绝交维护者） |
| `REQUESTER_BOT_REPORT_FIRST` | `true`：做完先向机器人汇报，提需求方认可当前提交后再交维护者合并；`false`（默认）：做完直接交维护者 |
| `REQUESTER_BOT_WEBHOOK_URL` | 可选。机器人的 webhook 地址；留空 = 不发（只挂等待标签，靠机器人自己的定时扫描） |
| `REQUESTER_BOT_WEBHOOK_KEY_HEADER` | 放密钥的请求头名，按机器人那边的说明填，例如 `Authorization`。只许字母、数字、`-` |
| `REQUESTER_BOT_WEBHOOK_KEY` | 该请求头的值，原样发送（要 `Bearer ` 前缀就整串填） |

前四项都填了才算开启。webhook 三项只从项目配置文件读（systemd 环境文件里的同名变量不算），配置文件必须是 `600`。全部留空时，派工、挡工清单、四类提示词、合并后的处理都和以前逐字节一样。

**早期名字照样认**：这个功能早期的配置项是 `LABEL_PENDING_RELAY` / `RELAY_BOT_ACCOUNT` / `RELAY_ALLOWED_ACTORS` / `RELAY_ORIGIN_MARKER` / `RELAY_REPORT_FIRST`，叫醒脚本是 `notify-relay.sh`。已经按旧名字配好的项目什么都不用改。每一项单独挑：新名字有值就用新的，否则用旧的；同一项新旧都填了且不一样时用新的，叫醒脚本输出和 `poll.log` 会提示。想换成新名字时，把配置里的 `RELAY_` 换成 `REQUESTER_BOT_`、`LABEL_PENDING_RELAY` 换成 `LABEL_PENDING_REQUESTER_BOT` 即可，标签本身（比如 `pending/relay`）不用改名。

### 等待期间 daemon 怎么做

| 条目状态 | daemon 的处理 |
|---|---|
| 只挂等待标签 | 不派工：greedy 兜底跳过；worker 意外退出后的自动重派也不翻它的标签 |
| 等待标签 + 有人又打了触发标签（`pending/agent`、fable、追加的、`pending/review`） | 照该标签原流程派工，派工时 daemon 摘掉等待标签。触发标签只有能改标签的人才打得上，等于明说「接着干」 |
| 等待标签被摘掉、没有触发标签 | label 模式下不动（等有人打 `pending/agent`）；greedy 模式下照常续上 |

不做等待超时：机器人一直没回音时，由维护者自己看着处理。

### 叫醒脚本

worker / reviewer 发完评论后跑它。派工提示词里已经写好完整命令，形如：

```bash
bash ~/.agents/releases/cavil-loop/entrypoints/notify-requester-bot.sh --config <项目配置> <issue 或 PR 编号>
```

它先做前置检查，任一条不满足就拒绝，不发任何写请求：

- 当前 GitHub 账号在允许叫醒的名单里
- 是机器人提的需求（作者 + 标记，见上表）
- 条目上没挂 `pending/human`（包括复审轮次用尽的 `pending/review` + `pending/human` 双标签）
- 标签历史里没有维护者手打过 `pending/human`。「维护者」= 打标签的账号既不在允许名单里，也不是机器人账号。维护者接手过的条目，之后的交接都只交维护者

然后叫醒。issue 和 PR 做法相同：**叫醒 = 挂等待标签 + 调一次机器人的 webhook**。早先的做法是重新指派机器人、PR 上再请求它 review，但第一个接入的项目实测机器人收不到这些事件，全靠它自己的定时扫描（白天约 15 分钟、夜里约 30 分钟）兜底；GitHub#100 起改为 webhook，不再指派、不再请求 review。

步骤：加等待标签 → 摘掉全部触发标签、`doing/agent`、`pending/review` → 读回核对（等待标签在、要摘的都不在）。失败整体重试一次；仍失败就交还维护者：加 `pending/human` → 摘触发标签等 → 读回核对 → **最后**才摘等待标签。等待标签最后摘，中途失败时 greedy 兜底和自动重派仍然被它挡着。

**只有叫醒成功（首次或重试后）才调 webhook**，每次叫醒恰好一次；退出码 2 / 3 / 4 时交接没确认成功，一律不调。

| 退出码 | 含义 | agent 怎么做 |
|---|---|---|
| 0 | 叫醒成功（只说明标签改好了；webhook 成败只在输出里记一行，不影响退出码；不说明机器人已转达） | 停下等答复 |
| 2 | 前置检查拒绝，标签没动 | 照常交维护者 |
| 3 | 叫醒失败，已交还维护者（只剩 `pending/human`） | 补一条评论说明 |
| 4 | 交还也失败，输出里是实际读回的标签 | 如实说明，不写「已交人」 |

机器人回复后自己摘等待标签——这部分由机器人那边负责，cavil-loop 不管。

### webhook 通知

POST 一次，机器人就来仓库拉取**所有**挂着等待标签的条目（它每次全量拉，不按请求体办事）。

- 请求：`POST`，`Content-Type: application/json`，请求体 `{"repo":"<owner/repo>","number":<编号>,"kind":"issue"|"pr"}`，只是提示，不含指令；配置的请求头名带上密钥
- 不发的情况（任一条成立：只记一行、不发请求、不改退出码）：地址为空（连日志都不记）→ `webhook 配置不完整，跳过`（请求头名或密钥为空、请求头名有字母数字 `-` 以外的字符、地址或密钥里有换行等控制字符）→ `配置文件权限过宽（应为 600），webhook 跳过`（组或其他用户有任何权限位）/ `读不到配置文件权限，webhook 跳过` → `找不到 curl，webhook 跳过`
- **地址、请求头、密钥不进命令行**：经标准输入喂给 `curl --config -`，`ps` 看不到；任何输出和日志都不含这三项
- 10 秒上限、不重试、不跟随跳转（跟随会把密钥头带去另一个地址）、只许 http / https、不读用户的 `~/.curlrc`
- 结果只记一行：`已通知 webhook（HTTP 200）`，或 `webhook 通知失败（HTTP 503 / 超时 / 连接失败）`。**失败不算叫醒失败**，退出码仍是 0，靠机器人的定时扫描兜底

### 做完时告诉机器人（合并 / 关闭未合并）

PR 合并、或没合并就被关掉时，daemon 自动通知机器人，不需要 worker 在场：

- **只通知机器人提的需求**：PR 关联的 issue 要满足上表「作者 + 标记」两条，判定和叫醒脚本是同一份
- **做法**：在那个 issue 上留一条结果评论（「需求已完成：PR #N 已合并」并写明合并提交；或「PR #N 已关闭，没有合并」）→ 给那个 issue 加等待标签并读回确认 → 调一次 webhook（`kind` 是 `issue`，编号是来源 issue）。issue 已被 `Closes #N` 自动关掉也照样留评论、加标签。不再指派机器人
- **机器人那边要约定**：已关闭但挂着等待标签的条目也要拉，转达后自己摘掉标签
- **关闭未合并、但同一项需求还有别的 PR 开着**：不通知（工作还在继续）。这一条每次要发之前都现查——首轮没发成、重试前新开了 PR，也不会再发；打开的 PR 列表读不到时当成不知道，留到下轮，不当成「没有」。这项需求已经通知过「已合并」时，旧 PR 的关闭也不再通知
- **写身份要在允许名单里**：和叫醒脚本同一关；不在名单或读不到身份就不写，留到下轮，`poll.log` 写明原因
- **只发一次**：评论里带一段隐藏标记，重试时先看 issue 上有没有本账号发过的那条，发过就只补标签。加标签或读回失败下一轮重试，同一个 PR 最多 30 轮，放弃时 `poll.log` 有一行 ⚠️。webhook 失败只记一行，不进重试
- **写之前现读一次 PR**：要已关闭，合并与否和当初看到的一致；读不全就这轮不写
- 依赖合并后清理（`AUTO_CLEANUP_ON_MERGE`，默认开）那一段：关了它，合并 / 关闭后就不会通知

### 交接规则（写进派工提示词）

功能开启后，daemon 在四类派工提示词（新 issue、issue 评论、PR 评论、复审）的**最末尾**追加一段「外部需求机器人交接规则」。放在最末尾是为了让整份替换了工具模板的项目也收得到。要点：

- **叫醒机器人**：方案 / 修订方案等提需求方确认（启用交叉 review 时由 reviewer 在方案复审通过后叫醒）；实现中要提需求方回答的产品问题；汇报结果（`REQUESTER_BOT_REPORT_FIRST=true` 时）。合并 / 关闭后的结果由 daemon 自动告诉机器人，worker 不用管
- **仍然只交维护者**：维护者已接手、可疑内容、测试红灯要人裁决、冲突解不了、复审轮次用尽、权限 / 本机配置 / 凭据 / 数据库授权类事项
- **证据规则**：「已通知提需求的人」只认机器人在汇报之后留的「已转给谁」评论；「已认可」只认机器人贴回的答复原文明确认可，**并且**被认可的那条汇报写的提交编号就是 PR 当前最新提交。认可 → 交维护者合并；要求修改 → 改完、重新审查、再汇报；答复含糊 → 再问一次
- 机器人贴进 issue 的附件（图片等），agent 用自己的令牌下载阅读

不做：agent 往机器人**发**附件（GitHub 没有给程序用的评论附件上传接口），以后另开 issue。

### 接入示例：grokbot

以 GitHub 账号 [`grokbot`](https://github.com/grokbot) 为例，让它能直接往项目里提需求，并在有问题、做完时收到结果。

**1. 给 grokbot 一个能打标签的权限。** 开工靠 `pending/agent` 标签，只有仓库里有相应权限的人才打得上——这道门挡住陌生人随意让 agent 干活，本功能不改它。GitHub 仓库权限里最低的、能打标签的一档叫 **Triage**：能管标签，改不了代码。

- 仓库页 → Settings → Collaborators and teams → Add people → 输入 `grokbot` → 角色选 **Triage** → 发邀请；grokbot 那边接受邀请
- 想暂停 grokbot：在同一页把它移出即可

**2. 填配置**（`cavil-loop.config`，worker 账号换成你自己的）：

```bash
LABEL_PENDING_REQUESTER_BOT="pending/requester-bot"
REQUESTER_BOT_ACCOUNT="grokbot"
REQUESTER_BOT_ALLOWED_ACTORS="your-worker-bot"          # worker / reviewer 发评论用的那个账号
REQUESTER_BOT_ORIGIN_MARKER="<!-- requested-by-grokbot -->"
REQUESTER_BOT_REPORT_FIRST="true"                       # 做完先向 grokbot 汇报，提需求方认可后再交维护者
# webhook（grokbot 那边给的地址和密钥；配置文件要 chmod 600）
REQUESTER_BOT_WEBHOOK_URL="https://<grokbot 给的地址>"
REQUESTER_BOT_WEBHOOK_KEY_HEADER="Authorization"
REQUESTER_BOT_WEBHOOK_KEY="Bearer <grokbot 给的密钥>"
```

**3. 建标签**：仓库页 → Issues → Labels → New label，名字填 `pending/requester-bot`。（新接入的项目跑 `setup.sh` 时，配置里有这一项就会自动建。）

**4. 和 grokbot 约定它那边的做法：**

1. 提需求时开 issue，正文末尾带上标记文字 `<!-- requested-by-grokbot -->`，并打上 `pending/agent`
2. 收到 webhook（或自己的定时扫描）时：拉取所有挂着 `pending/requester-bot` 的 issue / PR，**包括已关闭的**；读讨论，把最新那条评论带给提需求的人，在 issue 里留言说明转给了谁
3. 拿到答复后：把答复**原文**贴回 → 摘掉 `pending/requester-bot` → 打上 `pending/agent` 让 agent 继续（`DISPATCH_MODE=greedy` 的项目可以不打，摘掉等待标签就会续上）
4. 收到带「需求已完成」/「已关闭，没有合并」标题的评论时：把结果告诉提需求的人，再摘掉 `pending/requester-bot`；这条需求到此结束
5. 不处理挂着 `pending/human` 的条目：那是交给维护者的

**5. 验证接上了**：等 grokbot 提一条需求，agent 出方案后，issue 上应当出现 `pending/requester-bot` 标签，`poll.log` 里有 `notify-requester-bot #<编号>: ✅ 已叫醒 grokbot` 和紧跟的 `已通知 webhook（HTTP 200）`。PR 合并后，issue 上应当出现「需求已完成」评论并挂上 `pending/requester-bot`，`poll.log` 里有 `issue #<编号>：已通知 webhook（HTTP 200）`。如果看到的是 `pending/human` 加一条「叫醒失败，已交维护者」的评论，按评论里贴的脚本输出排查（常见：worker 账号没有改标签的权限）。看到 `webhook 通知失败` / `跳过` 时标签照样挂上了，grokbot 会在下一次定时扫描时看到；按那一行的原因修配置。

**退回**：把配置里这几项清空即可，挂着等待标签的条目手动摘掉标签。只想停掉 webhook、保留等待标签：清空 `REQUESTER_BOT_WEBHOOK_URL`。

## 实操注意点

- **命名一致**：`<状态>` 保持基本五态（`pending`、`agent`、`Done`），角色放在第三个 `/` 后。不要在同仓库混用 `pending/PM` 跟 `pending/agent/PM` 这种不一致命名
- **并发**：每个 instance 有自己的 state.json + worktree base（给每个角色配独立的 `WORKTREE_BASE`），不会互踩
- **角色 prompt**：最简单是给每个角色一份独立的 host project（每个 host 自己的 `.agents/skills/.../prompts/` 覆盖）。或者未来支持按角色后缀切 prompt 集
- **角色间交接**：每个角色的 prompt 要明确写「干完应该打哪个 label 给下家」。例如 PM-agent 结尾："交付方案后打 `pending/human` 等批准，**不要**打其他 label"
- **状态变更很自由**：如果 Alex 的活后续也适合 Sam 接手，就直接改 label，没有迁移成本
- **GitHub assignees 替代方案**：reviewer 路由其实可以用 GitHub 原生的 Assignees 字段替代标签后缀。label 简单好筛选，assignee 是 first-class 但缺少分态

## 要避免的竞态

- **标签 pattern 重叠**：instance A 监听 `pending/agent/Frontend`，instance B 监听 `pending/agent/*`，两个都会 dispatch。各 instance 的标签互不相交
- **并发 label flip**：两个 daemon 几乎同时翻同一个 issue 的 label，GitHub 是 last-write-wins。实操很少撞上（每个 daemon 只 dispatch 自己的子标签，永远不在同一 issue 上撞车）

## Roadmap（尚未实现，开 issue 跟踪）

这些扩展可以一步步加：

- **单 daemon + 前缀匹配**：扫 `pending/agent/*`，按后缀路由到对应角色的 prompt + config。N 个角色合并成 1 个 daemon 实例，运维更省，但角色间隔离弱一点
- **内建 reviewer 轮询**：worker 完工时按池子（轮询 / 按文件 ownership）自动挑一个 `pending/human/<name>` 打上
- **跨 agent 交接 via prompt directive**：在 prompt 模板里标准化「下家是谁」指令，配一个小 env 字段如 `NEXT_HANDOFF_LABEL`
- **状态聚合页**：把所有 daemon instance 的「`<role>` 在跑 / 排队 / 今天完成」聚成一个看板
