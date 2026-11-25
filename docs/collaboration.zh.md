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

`pending/human` 单兵作战够用。加名字后缀的好处是**把单轮往返变成多角色接力**；每一步的 label 就是路由指令。

<details><summary>例子：一条接力链</summary>

```
issue → PM-agent（写方案）
     → human/Alex（批方案）
     → dev-agent（写代码）
     → QA-agent（在部署环境验）
     → human/Sam（最终 review + merge）
```

</details>

## 怎么落地（不用改 skill 代码）

每个 AI 角色跑成一个独立的 daemon 实例，各自只监听自己的子标签。skill 已经支持这种用法——你只需要给每个 instance 写一份不同 label 值的 config。

### 每个 agent 角色一份 config

每个角色一份自己的 config，标签值、前缀和准备命令各不相同。

<details><summary>例子：PM 和 QA 的 config</summary>

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

</details>

### 每个角色一份 prompt

每个角色的 worker 想要不同 prompt。在 `<host>/.agents/skills/cavil-loop/prompts/` 放角色特定的覆盖、按 config 切换即可——或者按角色拆开 prompts/，让每个 instance 指向自己的覆盖。查找逻辑固定为一个 host project 一份 prompt 集；按角色切 prompt 集列在 [Roadmap](#roadmap尚未实现) 里。

### 每个角色一个 systemd timer

每个角色用 `setup.sh` 装一次、开它的 timer；每个 timer 独立 tick，各 daemon 只扫自己的子标签。

<details><summary>命令</summary>

```bash
bash setup.sh ~/myproject pm-agent
bash setup.sh ~/myproject qa-agent
bash setup.sh ~/myproject dev-agent

systemctl --user enable --now cavil-loop-poll@pm-agent.timer
systemctl --user enable --now cavil-loop-poll@qa-agent.timer
systemctl --user enable --now cavil-loop-poll@dev-agent.timer
```

</details>

## 常见工作流

下面是三种常见的角色、名字组合方式。

### 1. PM → Dev → QA 接力（完整 SDLC 链路）

PM agent 写方案、人批准、dev agent 写代码开 PR、QA agent 验完交给人合并。QA 发现回归就带着 comment 翻回 `pending/agent/Dev`。

<details><summary>逐步链路</summary>

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

</details>

### 2. 多人 review 路由

Dev-agent 开 PR 之后，不打通用 `pending/human`，而是按规则（CODEOWNERS / 轮询 / 随机）挑一个 reviewer 打 `pending/human/Alex`。Alex 一看名字就知道是自己的队列。

<details><summary>reviewer 接下来怎么做</summary>

Alex review：
- LGTM → `Done`（或直接 merge）
- 要改 → `pending/agent/Dev` + comment
- 想 Sam 也看一下 → `pending/human/Sam`

</details>

### 3. 按技术栈分工的 coding agent

monorepo 里有 `frontend/`（React）和 `backend/`（Go），就跑两个 cavil-loop 实例，一个技术栈一个。triage 按 issue 涉及的文件路径 / 区域标签（`area/frontend`、`area/backend`）打对应子标签。

<details><summary>例子：两个实例</summary>

| 角色 | label | worktree setup | prompt 重点 |
|------|-------|----------------|-------------|
| `pending/agent/Frontend` | npm 体系 | `(cd frontend && npm ci)` | 组件模式、TS 严格性、e2e |
| `pending/agent/Backend`  | Go 体系  | `(cd backend && go mod download)` | API 契约、migration、覆盖率 |

</details>

## 外部需求机器人

可以让另一个 AI 助手直接来提需求，条目需要它回答或做完时叫它回来看；默认关闭。对接步骤和机器人那边的约定：[对接外部需求机器人](requester-bot.zh.md)。

## 托管：一条 issue 从头交到尾

`LABEL_AUTOPILOT` 开着时（默认开，要求开着复审关卡），维护者可以把单个 issue——或者已经开好的 PR——整个交出去：方案和代码只过复审，daemon 按固定条件自己合并 PR。它是「模式标签」，和上面的分工方式并存；细节和合并条件见 [operations](operations.zh.md#托管标签autopilot)。

## 实操注意点

标签命名保持一致，每个 instance 用自己的状态和 worktree base，每个角色的 prompt 写明交给下家时打哪个标签。

<details><summary>细节</summary>

- **命名一致**：`<状态>` 保持基本五态（`pending`、`agent`、`Done`），角色放在第三个 `/` 后。不要在同仓库混用 `pending/PM` 跟 `pending/agent/PM` 这种不一致命名
- **并发**：每个 instance 有自己的 state.json + worktree base（给每个角色配独立的 `WORKTREE_BASE`），不会互踩
- **角色 prompt**：最简单是给每个角色一份独立的 host project（每个 host 自己的 `.agents/skills/cavil-loop/prompts/` 覆盖）
- **角色间交接**：每个角色的 prompt 要明确写「干完应该打哪个 label 给下家」。例如 PM-agent 结尾："交付方案后打 `pending/human` 等批准，**不要**打其他 label"
- **状态变更很自由**：如果 Alex 的活后续也适合 Sam 接手，就直接改 label，没有迁移成本
- **GitHub assignees 替代方案**：reviewer 路由其实可以用 GitHub 原生的 Assignees 字段替代标签后缀。label 简单好筛选，assignee 是 first-class 但缺少分态

</details>

## 要避免的竞态

各 instance 监听的标签要互不相交：标签重叠的两个 instance 会对同一条目都派工。

<details><summary>细节</summary>

- **标签 pattern 重叠**：instance A 监听 `pending/agent/Frontend`，instance B 监听 `pending/agent/*`，两个都会 dispatch。各 instance 的标签互不相交
- **并发 label flip**：两个 daemon 几乎同时翻同一个 issue 的 label，GitHub 是 last-write-wins。实操很少撞上（每个 daemon 只 dispatch 自己的子标签，永远不在同一 issue 上撞车）

</details>

## Roadmap（尚未实现）

下面这些目前都没有：一个 daemon 按后缀分派多个角色、内建 reviewer 轮换、统一的「下家标签」指令、跨 instance 的状态页。想要哪个就开 issue 跟踪。

<details><summary>每项要做什么</summary>

- **单 daemon + 前缀匹配**：扫 `pending/agent/*`，按后缀路由到对应角色的 prompt + config。N 个角色合并成 1 个 daemon 实例，运维更省，但角色间隔离弱一点
- **内建 reviewer 轮询**：worker 完工时按池子（轮询 / 按文件 ownership）自动挑一个 `pending/human/<name>` 打上
- **跨 agent 交接 via prompt directive**：在 prompt 模板里标准化「下家是谁」指令，配一个小 env 字段如 `NEXT_HANDOFF_LABEL`
- **状态聚合页**：把所有 daemon instance 的「`<role>` 在跑 / 排队 / 今天完成」聚成一个看板

</details>
