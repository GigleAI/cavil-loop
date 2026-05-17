# coding-agent-work-loop

> Claude Code skill — 注册名 `coding-agent-workflow`。
> 本文档里所有「项目」指的是这个 GitHub 仓库 `luosky/coding-agent-work-loop`；「skill」指它作为 Claude Code skill 装上后的标识 `coding-agent-workflow`。

把 GitHub issue / PR 评论变成你**本机** Claude Code agent 的输入和输出。一个 systemd timer + 几个 shell 脚本 + 两个 GitHub label，让你直接通过 GitHub 网页（或手机 app）跟 agent 沟通：agent 自动建 worktree、写代码、commit/push、回评论。

> **TL;DR**：在 GitHub PR 评论 → 60 秒内本机 Claude Code 自动读到、改代码、push、回复你。所有沟通在 PR 评论里留痕。

## 为什么这套架构便宜（与 webhook + Claude API 方案对比）

1. **轮询循环不烧 token**：每 60 秒跑一次的 `agent-poll.sh` 是纯 shell + `gh` API 调用，**不调模型**。空闲时 0 token 消耗。只有真的发现 `pending/agent` 的 issue/PR 评论时，才 dispatch 到 Claude Code 进程。
2. **dispatch 走 Claude Code CLI，吃 Max 月费套餐**：worker 是本机 `claude` CLI 进程，计费按你的 Pro/Max 订阅算，不需要 API key、不按 token 计价。相比传统 webhook + Anthropic API 的方案（每次触发都按 token 收钱），长期跑下来便宜一大截。

---

## 它能做什么

```
你在 GitHub 网页 / iOS gh app 评论 PR
   ↓ + 加 label "pending/agent"
GitHub
   ↓ (poll 每 60s)
你本机 systemd timer
   ↓
agent-poll.sh
   ↓ 发现 pending/agent + 有新评论
本机 Claude Code（已开 worktree 的 tmux session）
   ↓ 读评论 → 改代码 → 测试 → commit + push → 回复
GitHub PR 评论流
   ↑（label 翻回 "pending/human"）
你
```

**两种触发场景：**

| 场景 | 触发 | Agent 做的事 |
|------|------|---------|
| 新需求 | 给 issue 加 `pending/agent` | 建 worktree + 分支，让 Claude Code 实现并开 PR |
| Review 反馈 | 给 PR 加 `pending/agent`（带评论） | 找到该 PR 的 worker session，注入「读最新评论后处理」prompt |

**完成判据**：worker 处理完后把 label 翻回 `pending/human` → daemon 不会再触发。

---

## 它**不**做什么

- ❌ **不是云端 Action**：跑在你本机/NAS。用你的本地环境 + Claude Code Max 计划；但机器关机就停
- ❌ **不替代代码 review**：agent 会改代码 + 自动 push。Review 仍是你的事。建议主分支保护 + required reviewer
- ❌ **不自动 merge**：merge / 关 PR 永远是你手动操作

---

## 这是个 Claude Code skill

Claude Code 加载 skill 的目录是 `~/.claude/skills/<name>/`。但**项目源码不建议直接 clone 进 `~/.claude/`**——那是 Claude 的私有 config 目录，把开源项目代码混进去会跟 `.claude/` 下其他东西搅在一起，也不利于 `git pull` 升级 / fork 改造 / 多 agent 框架复用。

**推荐做法**：项目 clone 到你平时放代码的标准位置（如 `~/github/coding-agent-work-loop`），再 symlink 到 skill 目录：

```bash
# 1. 把项目放到代码目录（路径随意，下面用 ~/github 举例）
git clone https://github.com/luosky/coding-agent-work-loop.git ~/github/coding-agent-work-loop

# 2. 注册成 Claude Code skill（skill 名是 coding-agent-workflow）
mkdir -p ~/.claude/skills
ln -s ~/github/coding-agent-work-loop ~/.claude/skills/coding-agent-workflow
```

> 之后 `git pull ~/github/coding-agent-work-loop` 升级，Claude Code 那边自动看到新版本——symlink 不需要重做。

**装到 host project 后，host project 工作树里只多两样东西：**

1. `coding-agent.config` — 本项目专属配置（gitignored）
2. `.gitignore` 里加一行排除上面那个

所有脚本、daemon、unit、state、日志都不进 host project 代码库。

---

## 安装

### 一次性：装 skill

```bash
# 项目代码放标准代码目录（避免污染 ~/.claude/）
git clone https://github.com/luosky/coding-agent-work-loop.git ~/github/coding-agent-work-loop

# symlink 进 Claude Code skill 目录
mkdir -p ~/.claude/skills
ln -s ~/github/coding-agent-work-loop ~/.claude/skills/coding-agent-workflow
```

或如果你 fork 了：

```bash
git clone git@github.com:<you>/coding-agent-work-loop.git ~/github/coding-agent-work-loop
ln -s ~/github/coding-agent-work-loop ~/.claude/skills/coding-agent-workflow
```

> **快速安装（不推荐，但能跑）**：直接 `git clone https://github.com/luosky/coding-agent-work-loop.git ~/.claude/skills/coding-agent-workflow`。
> 缺点：项目代码住在 Claude 私有 config 目录里，和其他 `.claude/` 下东西混着。

### 每个想接入的 host project

```bash
bash ~/.claude/skills/coding-agent-workflow/setup.sh ~/path/to/your-project
```

或在 Claude Code 里说：「帮我把 coding-agent-workflow 装到 ~/path/to/your-project」，Claude 会调本 skill 自动跑。

`setup.sh` 做的事（无破坏性，幂等）：

1. 检查依赖（`git` / `gh` / `tmux` / `jq` / `flock` / `systemctl` / `claude`）
2. `<host>/coding-agent.config` 从模板生成，预填仓库名 + 路径
3. `<host>/.gitignore` 加一行排除 `coding-agent.config`
4. `~/.config/coding-agent-workflow/<key>.conf` 注册 systemd EnvironmentFile
5. `~/.config/systemd/user/coding-agent-poll@.service/.timer` symlink 到 skill 目录的模板单元（一次完成，所有项目共用）
6. GitHub 仓库建 `pending/agent` + `pending/human` label（已存在则跳过）
7. `seed-state.sh` seed 一次 state.json，避免历史评论被当新评论
8. 询问是否 `systemctl --user enable --now coding-agent-poll@<key>.timer`

> 跑完之后 `git status` 在 host project 里只会看到 `.gitignore` 一行小改动。其他都在 host project 之外。

### 长期跑（用户不在线也跑）

```bash
sudo loginctl enable-linger $USER
```

---

## 依赖

| 工具 | 必需 | 用途 |
|------|:---:|------|
| `git` ≥ 2.5 | ✅ | worktree |
| `gh` (GitHub CLI) | ✅ | issue/PR/label 操作；先 `gh auth login` |
| `tmux` ≥ 3.0 | ✅ | 容纳 Claude Code 长会话 |
| `jq` | ✅ | state.json / API 输出处理 |
| `flock` | ✅ | daemon 重入锁 |
| `claude` (Claude Code CLI) | ✅ | worker；建议 Pro/Max 计划 |
| `systemd` user units | ✅ | 调度 daemon |

测过：Ubuntu 22.04 / 24.04。macOS 需要把 systemd 换成 launchd（见 [其他调度器](#其他调度器)）。

---

## 设计原理

### Label 状态机

```
新 issue ──────────────────► label: pending/human（默认，等你 triage）
   │
   │ 你加 label: pending/agent
   ▼
pending/agent on issue ───► daemon 发现 ──► agent 开始干
                                              │
                                              ▼ agent 开 PR 后立即操作：
                                              ├─ PR: label = pending/human
                                              └─ Issue: label = pending/human（去 pending/agent）

PR(pending/human) ───► 你 review
   ├─ 批准 / merge → 关 PR
   └─ 想让 agent 改 → 评论 + 加 label pending/agent
              │
              ▼
        daemon 发现 PR 有新评论且 label=pending/agent
              │
              ▼
        agent 修代码 + commit + push + 回评论 + label 翻回 pending/human
```

### 重入与并发安全

- **flock**：`agent-poll.sh` 用 `$STATE_DIR/poll.lock` 防多个 systemd tick 撞车
- **派工立刻翻 label**：daemon 发现 `pending/agent` → dispatch → **第一件事就翻回 pending/human**。worker 还在处理时 daemon 看到的是 pending/human，不会重复触发
- **state.json**：记录每个 PR 「上次见过的最大 comment ID」。同一条评论永远不会被两次派工
- **active worker 计数**：通过 tmux session 命名约定数活的 worker；超过 `MAX_CONCURRENT_WORKERS` 时新任务排队等下一轮

### Worker 会话模型

- 每个 issue → 一个 git worktree → 一个 tmux session → 一个 `claude -n issue<N> --dangerously-skip-permissions` 进程
- 命名：tmux session = `<TMUX_PREFIX>-issue<N>`、worktree = `<WORKTREE_BASE>/issue-<N>`、branch = `<BRANCH_PREFIX><N>`
- PR 评论触发：找对应 session 用 `tmux load-buffer + paste-buffer -p`（bracketed paste）把 prompt 多行注入，再 `send-keys Enter` 提交
- Session 没了（worktree 被清掉）→ 自动从 PR head branch 重建 worktree + spawn 新 session

> **配套工具：** Claude Code 默认不会在 Edit/Write 前自动读项目里散落的 `AGENTS.md`。如果你的项目用 `AGENTS.md`（或 `CLAUDE.md` 之外的其他领域知识文件）沉淀业务规则，建议另装一个 PreToolUse hook 自动注入——那是独立工具，不在本项目范围内。

---

## 配置（`coding-agent.config`）

放在 host project 根，已自动加 `.gitignore`。

```bash
# GitHub
REPO="myorg/myrepo"

# 路径
PROJECT_ROOT="$HOME/github/myproject"
WORKTREE_BASE="$HOME/github/worktree/myproject"
STATE_DIR="$HOME/.local/state/coding-agent-poll/myproject"

# 命名规范
TMUX_PREFIX="myproject"          # tmux session: myproject-issue42
BRANCH_PREFIX="feature/issue-"   # branch: feature/issue-42
SESSION_NAME_PREFIX="issue"      # Claude session name: issue42

# Label
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"

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

# Claude Code 启动 flag
CLAUDE_EXTRA_FLAGS="--dangerously-skip-permissions"

# 节奏
MAX_CONCURRENT_WORKERS=1
POLL_INTERVAL_SECS=60
```

---

## Prompt 模板

**默认**：skill 目录里的 `prompts/{new-issue,pr-comment}.template.md`，所有项目共用。

**项目自定义**：`<host>/.coding-agent/prompts/{new-issue,pr-comment}.template.md` 优先级更高。例如某项目要求 worker 跑 `npm run test:e2e`、某项目要 `cargo test`——各放一份覆盖。

可用占位（`sed` 渲染）：

| 占位 | 含义 |
|------|------|
| `${ISSUE}` | issue 编号 |
| `${PR}` | PR 编号（仅 pr-comment） |
| `${REPO}` | 仓库 owner/repo |
| `${TITLE}` | issue 标题（仅 new-issue） |
| `${WORKTREE}` | worktree 绝对路径 |
| `${BRANCH}` | branch 全名 |
| `${ISSUE_N}` | 从 branch 反推的 issue 编号（仅 pr-comment） |
| `${LABEL_PENDING_AGENT}` | label 名 |
| `${LABEL_PENDING_HUMAN}` | label 名 |

---

## 端到端使用流程

### 场景 1：新需求

```bash
gh issue create --title "..." --body "..."     # 假设拿到 #42
gh issue edit 42 --add-label pending/agent
```

60 秒内：
- `agent-poll.sh` 发现 `pending/agent` issue
- `dispatch-new-issue.sh 42`：建 worktree + 分支 + 装依赖 + 起 tmux session
- 立刻把 issue label 翻回 `pending/human`
- 你可以 `tmux attach -t <project>-issue42` 看 Claude 干活

Claude 完成后：
- `gh pr create` 创建 PR（body 含 `Closes #42`）
- PR 和 issue 都标 `pending/human`
- 停在 idle 回复 "PR #N 已开"

### 场景 2：PR Review 反馈

```bash
gh pr comment N --body "把 foo 改成 bar"
gh pr edit N --add-label pending/agent --remove-label pending/human
```

60 秒内：
- `agent-poll.sh` 发现 PR #N 是 `pending/agent` 且有新 comment
- `dispatch-pr-comment.sh N`：找 tmux session，存在 → `paste-buffer -p` 注入；不存在 → 重起
- 立即把 PR label 翻回 `pending/human`

Claude 处理：改代码 → `npm run type-check` / test → `git commit && git push` → `gh pr comment` 简报 → idle。

### 场景 3：澄清问题

```bash
gh pr comment N --body "这里为什么不用 X 模式？"
gh pr edit N --add-label pending/agent --remove-label pending/human
```

Claude 看是讨论性问题，回评论 + label 保持 `pending/human` 等你下一句。

---

## 文件结构

### Skill 目录（共用，不变）

推荐：项目本体住代码目录，skill 目录是 symlink 别名：

```
~/github/coding-agent-work-loop/        # 实际项目仓库（git clone 在这）
├── SKILL.md                            # Claude Code skill entry
├── README.md                           # 本文件
├── LICENSE
├── setup.sh                            # bootstrap 一个 host project
├── coding-agent.config.example
├── scripts/
│   ├── _lib.sh
│   ├── agent-poll.sh
│   ├── dispatch-new-issue.sh
│   ├── dispatch-pr-comment.sh
│   ├── seed-state.sh
│   └── create-worktree.sh
├── prompts/
│   ├── new-issue.template.md
│   └── pr-comment.template.md
└── systemd/
    ├── coding-agent-poll@.service
    └── coding-agent-poll@.timer

~/.claude/skills/coding-agent-workflow  -> ~/github/coding-agent-work-loop  # symlink
```

> 快速安装的人直接把 repo clone 到 `~/.claude/skills/coding-agent-workflow/`——结构相同，只是没有 symlink 这一步。

### Host project（接入后）

```
your-project/
├── .git/
├── .gitignore                      # +1 行：coding-agent.config
├── coding-agent.config             # 配置（gitignored）
├── .coding-agent/                  # 可选：项目自定义 prompt 覆盖
│   └── prompts/
└── ... your code ...
```

### 用户级状态文件

```
~/.config/coding-agent-workflow/
└── <project-key>.conf              # systemd EnvironmentFile（PROJECT_ROOT, CODING_AGENT_CONFIG）

~/.config/systemd/user/
├── coding-agent-poll@.service      # symlink → skill 目录的模板
└── coding-agent-poll@.timer        # symlink → skill 目录的模板

~/.local/state/coding-agent-poll/<project>/
├── state.json                       # { "seen_comments": { "<PR>": <id> } }
├── poll.log                         # 滚动日志
└── poll.lock                        # flock
```

---

## 多 project 共存

skill 装一次，systemd 模板 symlink 一次。每个 project 跑：

```bash
bash ~/.claude/skills/coding-agent-workflow/setup.sh ~/github/projectA
bash ~/.claude/skills/coding-agent-workflow/setup.sh ~/github/projectB
```

得到：

```
~/.config/coding-agent-workflow/
├── projectA.conf
└── projectB.conf

systemctl --user list-timers
  coding-agent-poll@projectA.timer
  coding-agent-poll@projectB.timer
```

互不干扰、独立日志、独立 state。

---

## Skill 升级

如果你按推荐流程装的（项目在 `~/github/coding-agent-work-loop`，symlink 进 skill 目录）：

```bash
cd ~/github/coding-agent-work-loop
git pull
```

如果你是快速安装（直接 clone 进 skill 目录）：

```bash
cd ~/.claude/skills/coding-agent-workflow
git pull
```

systemd unit 是 symlink 指模板，下一次 timer tick 自动用新版逻辑——**不需要重跑 setup.sh**。
唯一例外：`coding-agent.config.example` / `prompts/*.template.md` 有不兼容改动时，参考 CHANGELOG 手动同步到 host project。

---

## 其他调度器

systemd 不是硬要求；脚本无状态、可被任何调度器调起。

**cron**（macOS / 不想用 systemd）：

```cron
* * * * * CODING_AGENT_CONFIG=$HOME/myproject/coding-agent.config bash $HOME/.claude/skills/coding-agent-workflow/scripts/agent-poll.sh >> /tmp/coding-agent-cron.log 2>&1
```

**macOS launchd**：

```xml
<!-- ~/Library/LaunchAgents/com.example.coding-agent-poll.plist -->
<plist version="1.0">
  <dict>
    <key>Label</key><string>com.example.coding-agent-poll</string>
    <key>ProgramArguments</key>
    <array>
      <string>/bin/bash</string>
      <string>/Users/you/.claude/skills/coding-agent-workflow/scripts/agent-poll.sh</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
      <key>CODING_AGENT_CONFIG</key>
      <string>/Users/you/myproject/coding-agent.config</string>
    </dict>
    <key>StartInterval</key><integer>60</integer>
  </dict>
</plist>
```

**Claude Code `/loop` skill**：起一个长 session 跑 `/loop 60s bash ~/.claude/skills/coding-agent-workflow/scripts/agent-poll.sh`。优点：调度逻辑也能上下文感知；缺点：贵 + session 死了就停。

---

## 升级到 webhook（即时触发）

轮询有最坏 1 分钟延迟。要即时：
1. tailscale funnel / cloudflare tunnel 把本机 `<port>` 开公网
2. 跑 [`webhook`](https://github.com/adnanh/webhook) 这种小 listener 订阅 GitHub `issue_comment` + `labeled` 事件
3. listener 收到 → 直接跑 `agent-poll.sh`（poll 本身按 label 过滤 + state.json 去重，safe to retrigger）
4. 保留 systemd timer 当兜底

---

## 自定义 worker（不是 Claude Code）

dispatch-*.sh 的关键是「在 tmux 里起一个能接受 stdin prompt 的交互式 agent」。换成 Aider、Cursor CLI、自家 agent 都行：把 `claude -n ... "$prompt"` 那行换成你的 CLI 即可。建议 fork 后改 dispatch-*.sh，而不是 patch 原 skill。

---

## 故障排查

### Timer 起来了但 daemon 不跑

```bash
systemctl --user status coding-agent-poll@<key>.timer
systemctl --user status coding-agent-poll@<key>.service
journalctl --user -u coding-agent-poll@<key>.service --since "10 min ago"
```

常见原因：
- `~/.config/coding-agent-workflow/<key>.conf` 路径不对 → 编辑 conf
- `coding-agent.config` 缺字段 → 看 `poll.log`
- `gh auth` 没登录 → `gh auth status`
- `claude` 不在 systemd `PATH` 里 → `~/.config/coding-agent-workflow/<key>.conf` 里 `PATH=` 加上 `which claude` 的目录

### Worker session 卡在权限弹窗

确认 `coding-agent.config` 里 `CLAUDE_EXTRA_FLAGS="--dangerously-skip-permissions"`。本机受信任环境下强烈推荐。

### Daemon 不停 re-dispatch 同一 PR

可能是 worker 没翻 label。检查 `<host>/.coding-agent/prompts/pr-comment.template.md` 是否要求 worker 翻 label。或：
```bash
gh pr edit N --add-label pending/human --remove-label pending/agent
```

如果 worker 没回任何 comment 就完事，state.json 的 comment ID 不会推进，下次又会被当新评论。Prompt 应强制 worker 至少回一句评论。

### 调试一次 poll

```bash
CODING_AGENT_CONFIG=~/myproject/coding-agent.config \
    bash ~/.claude/skills/coding-agent-workflow/scripts/agent-poll.sh
tail -50 ~/.local/state/coding-agent-poll/myproject/poll.log
```

### 紧急停所有 worker

```bash
systemctl --user stop coding-agent-poll@<key>.timer
tmux ls | grep "^<project>-issue[0-9]" | cut -d: -f1 | xargs -r -n1 tmux kill-session -t
```

### 卸载某个 project

```bash
KEY=<key>
systemctl --user disable --now coding-agent-poll@$KEY.timer
rm ~/.config/coding-agent-workflow/$KEY.conf
# 可选：rm <host>/coding-agent.config（也可保留供下次接入）
# 可选：rm -r ~/.local/state/coding-agent-poll/<project>
```

---

## 架构细节（深入）

### 为什么用 git worktree

- 主 working tree 不被打扰，你可以并行干自己的事
- 每个 issue 一个独立目录，依赖独立装，互不污染
- 删 worktree 不影响 git history

### 为什么用 tmux

- Claude Code 是 TUI 应用，需要伪终端
- session 可以 attach 回去看进度 / 接管
- session 死了不影响 worker 进程（但 Claude 是前台进程，tmux 死了它也死，所以靠 tmux 保命）

### 为什么用 `paste-buffer -p`（bracketed paste）

直接 `send-keys` 多行字符串会把 `\n` 当成 Enter 提交多次。`paste-buffer -p` 用终端的 bracketed paste 协议把整段当成一个粘贴块，Claude Code（基于 Ink/React-TUI）会作为单条用户消息处理。

### 为什么 systemd 用 `@` 模板

一份模板 unit 支持多 project 实例，避免每个项目装一份。`%i` = instance key，`EnvironmentFile=%h/.config/coding-agent-workflow/%i.conf` 让每个实例读自己的环境。

### 为什么不直接用 Claude Code 的 `--from-pr`

Claude Code CLI 有 `--from-pr` flag 但依赖 Anthropic 官方 GitHub App / Action 流。本项目走「label + 本机 daemon」就是为了**避免依赖**官方 App，让你用自己机器的环境 + Max 计划，不需要 API key。

---

## License

MIT。见 [LICENSE](LICENSE)。
