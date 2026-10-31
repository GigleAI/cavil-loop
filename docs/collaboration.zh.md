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

## 外部传话机器人

有的项目让另一个 AI 助手替别人提需求。这个助手有自己的 GitHub 账号，下文叫「传话机器人」。它建 issue，cavil-loop 照常处理。agent 要问提需求的人、或者要汇报结果时，不交给维护者（`pending/human`），而是叫醒传话机器人，由它把话转给提需求的人，再把答复原文贴回来。

**默认关闭**，全部靠配置开启，代码和配置模板里不写任何具体的机器人名字（GitHub#95）。

### 一轮交接是怎么走的

```
机器人建 issue（正文带标记、自己打 pending/agent）
   │
   ▼
agent 出方案 / 提问 / 汇报 ── 发评论 ── 跑叫醒脚本
   │                                   │ 挂「等待传话」标签、摘掉 pending/agent 等、
   │                                   │ 把机器人重新指派为 assignee（这样才会通知它）
   ▼                                   ▼
等待中：daemon 不派工          机器人读讨论 → 转给提需求的人 → 在 issue 里写「已转给谁」
   │                                   │
   │                                   ▼
   │                     拿到答复 → 原文贴回 issue → 摘等待标签 → 把自己移出 assignee
   │                                   → 打 pending/agent 让 agent 接着干
   ▼
agent 读答复，继续
```

### 配置

| 配置项 | 作用 |
|---|---|
| `LABEL_PENDING_RELAY` | 等待传话标签，例如 `pending/relay`。`setup.sh` 会按这个名字建标签 |
| `RELAY_BOT_ACCOUNT` | 传话机器人的 GitHub 登录名，叫醒时指派给它 |
| `RELAY_ALLOWED_ACTORS` | 允许执行叫醒的账号（逗号分隔），一般就是 worker / reviewer 发评论用的那个账号 |
| `RELAY_ORIGIN_MARKER` | issue 正文里出现这段文字、**并且** issue 作者就是机器人账号，才算「机器人替别人提的需求」；PR 看它关联的 issue |
| `RELAY_REPORT_FIRST` | `true`：做完先经传话汇报，提需求方认可当前提交后再交维护者合并；`false`（默认）：做完直接交维护者 |

前四项都填了才算开启。全部留空时，派工、挡工清单、四类提示词都和以前逐字节一样。

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
bash ~/.agents/releases/cavil-loop/entrypoints/notify-relay.sh --config <项目配置> <issue 或 PR 编号>
```

它先做前置检查，任一条不满足就拒绝，不发任何写请求：

- 当前 GitHub 账号在 `RELAY_ALLOWED_ACTORS` 里
- 是机器人替别人提的需求（作者 + 标记，见上表）
- 条目上没挂 `pending/human`（包括复审轮次用尽的 `pending/review` + `pending/human` 双标签）
- 标签历史里没有维护者手打过 `pending/human`。「维护者」= 打标签的账号既不在允许名单里，也不是机器人账号。维护者接手过的条目，之后的交接都只交维护者

然后：加等待标签 → 摘掉全部触发标签、`doing/agent`、`pending/review` → 机器人已经是 assignee 就先移掉 → 再指派 → 读回核对。失败整体重试一次；仍失败就交还维护者：加 `pending/human` → 摘触发标签等 → 读回核对 → **最后**才摘等待标签。等待标签最后摘，中途失败时 greedy 兜底和自动重派仍然被它挡着。

| 退出码 | 含义 | agent 怎么做 |
|---|---|---|
| 0 | 叫醒成功（只说明标签和 assignee 改好了，不说明机器人已转达） | 停下等答复 |
| 2 | 前置检查拒绝，标签没动 | 照常交维护者 |
| 3 | 叫醒失败，已交还维护者（只剩 `pending/human`） | 补一条评论说明 |
| 4 | 交还也失败，输出里是实际读回的标签 | 如实说明，不写「已交人」 |

### 交接规则（写进派工提示词）

功能开启后，daemon 在四类派工提示词（新 issue、issue 评论、PR 评论、复审）的**最末尾**追加一段「外部传话交接规则」。放在最末尾是为了让整份替换了工具模板的项目也收得到。要点：

- **走传话**：方案 / 修订方案等提需求方确认（启用交叉 review 时由 reviewer 在方案复审通过后叫醒）；实现中要提需求方回答的产品问题；汇报结果（`RELAY_REPORT_FIRST=true` 时）
- **仍然只交维护者**：维护者已接手、可疑内容、测试红灯要人裁决、冲突解不了、复审轮次用尽、权限 / 本机配置 / 凭据 / 数据库授权类事项
- **证据规则**：「已通知提需求的人」只认机器人在汇报之后留的「已转给谁」评论；「已认可」只认机器人贴回的答复原文明确认可，**并且**被认可的那条汇报写的提交编号就是 PR 当前最新提交。认可 → 交维护者合并；要求修改 → 改完、重新审查、再汇报；答复含糊 → 再问一次
- 机器人贴进 issue 的附件（图片等），agent 用自己的令牌下载阅读

不做：agent 往机器人**发**附件（GitHub 没有给程序用的评论附件上传接口），以后另开 issue。

### 接入示例：grokbot

以 GitHub 账号 [`grokbot`](https://github.com/grokbot) 为例，让它能自己往项目里提需求。

**1. 给 grokbot 一个能打标签的权限。** 开工靠 `pending/agent` 标签，只有仓库里有相应权限的人才打得上——这道门挡住陌生人随意让 agent 干活，本功能不改它。GitHub 仓库权限里最低的、能打标签的一档叫 **Triage**：能管标签和 assignee，改不了代码。

- 仓库页 → Settings → Collaborators and teams → Add people → 输入 `grokbot` → 角色选 **Triage** → 发邀请；grokbot 那边接受邀请
- 想暂停 grokbot：在同一页把它移出即可

**2. 填配置**（`cavil-loop.config`，worker 账号换成你自己的）：

```bash
LABEL_PENDING_RELAY="pending/relay"
RELAY_BOT_ACCOUNT="grokbot"
RELAY_ALLOWED_ACTORS="your-worker-bot"          # worker / reviewer 发评论用的那个账号
RELAY_ORIGIN_MARKER="<!-- relayed-by-grokbot -->"
RELAY_REPORT_FIRST="true"                       # 做完先经 grokbot 汇报，提需求方认可后再交维护者
```

**3. 建标签**：仓库页 → Issues → Labels → New label，名字填 `pending/relay`。（新接入的项目跑 `setup.sh` 时，配置里有这一项就会自动建。）

**4. 和 grokbot 约定它那边的做法：**

1. 建 issue 时，正文末尾带上标记文字 `<!-- relayed-by-grokbot -->`，并打上 `pending/agent`
2. 被指派为 assignee 时：读讨论，把最新那条评论转给提需求的人，在 issue 里留言说明转给了谁
3. 拿到答复后：把答复**原文**贴回 issue → 摘掉 `pending/relay` → 把自己移出 assignee → 打上 `pending/agent` 让 agent 继续（`DISPATCH_MODE=greedy` 的项目可以不打，摘掉等待标签就会续上）
4. 不处理挂着 `pending/human` 的条目：那是交给维护者的

**5. 验证接上了**：等 grokbot 提一条需求，agent 出方案后，issue 上应当出现 `pending/relay` 标签、assignee 是 grokbot，`poll.log` 里有 `notify-relay #<编号>: ✅ 已叫醒 grokbot`。如果看到的是 `pending/human` 加一条「叫醒失败，已交维护者」的评论，按评论里贴的脚本输出排查（常见：grokbot 还没接受邀请，指派不上）。

**退回**：把配置里这五项清空即可，挂着 `pending/relay` 的条目手动摘掉标签。

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
