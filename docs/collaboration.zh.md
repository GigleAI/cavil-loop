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

每个角色的 worker 想要不同 prompt。在 `<host>/.agents/skills/coding-agent-work-loop/prompts/` 放角色特定的覆盖即可。当前查找逻辑写死成一个 host project 一份 prompt 集；如果想按角色后缀切 prompt 集，见下面的「Roadmap」。

### 每个角色一个 systemd timer

```bash
bash setup.sh ~/myproject pm-agent
bash setup.sh ~/myproject qa-agent
bash setup.sh ~/myproject dev-agent

systemctl --user enable --now coding-agent-poll@pm-agent.timer
systemctl --user enable --now coding-agent-poll@qa-agent.timer
systemctl --user enable --now coding-agent-poll@dev-agent.timer
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

仓库是 monorepo，`frontend/`（React）+ `backend/`（Go）。两个 coding-agent 实例：

| 角色 | label | worktree setup | prompt 重点 |
|------|-------|----------------|-------------|
| `pending/agent/Frontend` | npm 体系 | `(cd frontend && npm ci)` | 组件模式、TS 严格性、e2e |
| `pending/agent/Backend`  | Go 体系  | `(cd backend && go mod download)` | API 契约、migration、覆盖率 |

triage 规则：根据 issue 涉及的文件路径 / 区域标签（`area/frontend`、`area/backend`）→ 触发对应子标签。

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
