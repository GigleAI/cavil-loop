# 运维手册

## 配置（`coding-agent.config`）

放在 host project 根，已自动加 `.gitignore`。

```bash
# GitHub
REPO="myorg/myrepo"

# 路径
PROJECT_ROOT="$HOME/github/myproject"
WORKTREE_BASE="$HOME/github/worktree/myproject"
STATE_DIR="$HOME/.local/state/coding-agent-poll"

# 命名规范
TMUX_PREFIX="myproject"          # 日志前缀 + 兼容命名（不再创建 tmux session）
BRANCH_PREFIX="feature/issue-"   # branch: feature/issue-42
SESSION_NAME_PREFIX="issue"      # worker session name: issue42

# Label
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
LABEL_AGENT_DOING="agent/doing"
LABEL_PENDING_PR="pending/PR"
LABEL_DONE="Done"

# Worker 选择
WORKER="claude"                  # 可选：claude | opencode

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

# OpenCode 启动 flag
OPENCODE_EXTRA_FLAGS=""

# OpenCode serve 服务地址
OPENCODE_SERVER_URL="http://127.0.0.1:4096"

# 传给 worker 的 env
WORKER_PASS_ENV="GH_TOKEN"

# Merge 后 daemon 自动 cleanup（worktree + session）
AUTO_CLEANUP_ON_MERGE="true"

# 项目级 cleanup hook（解端口、撤 tunnel、推 metric）
CLEANUP_HOOK=".agents/skills/coding-agent-work-loop/cleanup-hook.sh"

# 节奏
MAX_CONCURRENT_WORKERS=1
POLL_INTERVAL_SECS=60
```

完整字段见 [`coding-agent.config.example`](../coding-agent.config.example)。

## Prompt 模板

模板查找顺序（高 → 低）：

1. `<host>/.agents/skills/coding-agent-work-loop/prompts/<name>.template.md` — 项目自定义（推荐）
2. `<host>/.coding-agent/prompts/<name>.template.md` — 老路径（兼容）
3. `<skill>/prompts/<name>.template.md` — skill 默认

例如某项目要求 worker 跑 `npm run test:e2e`、某项目要 `cargo test`，各放一份覆盖。

可用占位（`prompt.py:render_template()` 用 `str.replace` 渲染）：

| 占位 | 含义 |
|------|------|
| `${ISSUE}` | issue 编号 |
| `${PR}` | PR 编号（仅 pr-comment） |
| `${REPO}` | 仓库 owner/repo |
| `${TITLE}` | issue 标题（仅 new-issue） |
| `${WORKTREE}` | worktree 绝对路径 |
| `${BRANCH}` | branch 全名 |
| `${ISSUE_N}` | 从 branch 反推的 issue 编号（仅 pr-comment） |
| `${LABEL_PENDING_AGENT}` / `${LABEL_PENDING_HUMAN}` / `${LABEL_AGENT_DOING}` / `${LABEL_PENDING_PR}` | label 名 |

## 文件结构

### Python 包结构

```
coding-agent-work-loop/                 # 实际项目仓库
├── README.md
├── AGENTS.md
├── SKILL.md
├── CONTRIBUTING.md
├── LICENSE
├── pyproject.toml                      # 包元数据 + ruff/pytest 配置
├── coding-agent.config.example         # 配置模板
├── coding_agent/                       ← Python 3.11+ 包
│   ├── __init__.py                     ← 版本号
│   ├── __main__.py                     ← python -m coding_agent 入口
│   ├── cli.py                          ← argparse CLI
│   ├── config.py                       ← Config 类
│   ├── state.py                        ← State 类 + 文件锁
│   ├── log_util.py                     ← Logger
│   ├── poll.py                         ← 主轮询逻辑 + daemon 循环
│   ├── dispatch.py                     ← 派工逻辑
│   ├── gh_utils.py                     ← gh CLI 封装
│   ├── git_ops.py                      ← git 操作
│   ├── prompt.py                       ← 模板查找 + 渲染
│   ├── cleanup.py                      ← merge 后清理
│   ├── seed.py                         ← 首装时 seed state.json
│   ├── setup_cmd.py                    ← setup 子命令
│   └── worker/                         ← Worker 抽象层
│       ├── __init__.py                 ← WorkerBase ABC + 注册表
│       ├── claude.py                   ← ClaudeWorker
│       └── opencode.py                 ← OpencodeWorker
├── prompts/
│   ├── new-issue.template.md
│   ├── issue-comment.template.md
│   └── pr-comment.template.md
└── docs/
    ├── architecture.md
    ├── security.md
    └── operations.md                   ← 本文件
```

### Host project（接入后）

```
your-project/
├── .gitignore                          # +1 行：coding-agent.config
├── coding-agent.config                  # 配置（gitignored）
├── .agents/skills/coding-agent-work-loop/  # 可选：项目自定义 prompt + cleanup-hook
│   ├── prompts/
│   └── cleanup-hook.sh
└── ... your code ...
```

### 用户级状态文件

```
~/.local/state/coding-agent-poll/<project>/
├── state.json                          # { "seen_comments": ..., "cleaned_prs": ..., "sessions": ... }
├── poll.log                            # 滚动日志（log_util append）
├── poll.lock                           # 文件锁（state.py:acquire_lock）
└── sessions/                           # 每个 worker session 的持久化日志
    └── <session-name>.log
```

## 多 project 共存

一个 Python 包装一次，每个 project 配一个 `coding-agent.config`。可以开多个 daemon 实例：

```bash
cd ~/github/projectA && coding-agent daemon &
cd ~/github/projectB && coding-agent daemon &
```

各 project 的 `STATE_DIR` 不同，互不干扰、独立日志、独立 state。

## 升级

推荐流程（项目 clone 在 `~/github/coding-agent-work-loop`）：

```bash
cd ~/github/coding-agent-work-loop
git pull
uv pip install -e .                     # 或 uv tool install . --force
```

正在跑的 daemon 下次 poll cycle 自动用新代码——**不需要重跑 setup**。

## 调度方式

`coding-agent daemon` 内置了 `while True + sleep` 循环，不需要外部调度器。持久化方式可选：

**nohup**（最简单）：
```bash
nohup coding-agent daemon >> /tmp/coding-agent.log 2>&1 &
```

**tmux**（方便 attach 回去看）：
```bash
tmux new -s coding-agent -d "coding-agent daemon"
```

**shell profile**（登录自启）：
```bash
# ~/.bashrc / ~/.zshrc 末尾
(coding-agent daemon &)
```

**单次 poll**（调试 / cron 兜底）：
```bash
coding-agent poll                       # 跑一轮就退出
```

cron 或其他外部调度器可以周期调 `coding-agent poll`，但推荐直接用 daemon 模式——它自带文件锁，不会撞车。

## 升级到 webhook（即时触发）

轮询有最坏 1 分钟延迟。要即时：

1. tailscale funnel / cloudflare tunnel 把本机 `<port>` 开公网
2. 跑 [`webhook`](https://github.com/adnanh/webhook) 这种小 listener 订阅 GitHub `issue_comment` + `labeled` 事件
3. listener 收到 → 直接跑 `coding-agent poll`（poll 本身按 label 过滤 + state.json 去重，safe to retrigger）
4. 保留 daemon 当兜底

## 自定义 worker（不是 Claude Code / Opencode）

加新 worker 后端的步骤：

1. 在 `coding_agent/worker/` 下新建文件（如 `aider.py`），继承 `WorkerBase`
2. 实现所有 `@abstractmethod`：`start` / `resume` / `get_status` / `list_sessions` / `stop` / `get_logs` / `has_history` / `attach`
3. 用 `@register_worker` 装饰器注册
4. 在 `coding_agent/worker/__init__.py` 的 `_lazy_import_workers()` 里加 import
5. 在 `cli.py` 的 `--worker` choices 里加选项
6. 在 `coding-agent.config` 里设 `WORKER="aider"`（或 CLI `--worker aider`）

核心思路：`WorkerBase` 把「在某个环境里起一个能接受 prompt 的交互式 agent」抽象成统一接口。换成 Aider、Cursor CLI、自家 agent 只需实现 `start` / `resume` 等，不需要改 dispatch 或 poll 逻辑。

验证：`coding-agent status --worker aider`

## 故障排查

### Daemon 不跑 / 报错退出

```bash
coding-agent poll                       # 单次 poll 看输出
tail -50 ~/.local/state/coding-agent-poll/<project>/poll.log
```

常见原因：
- `coding-agent.config` 缺字段 → 看 stderr 报错
- `gh auth` 没登录 → `gh auth status`
- `claude` / `opencode` 不在 `PATH` 里 → 配置里 `WORKER_PASS_ENV` 不影响 PATH，需在 shell profile 确保可找到

### Worker session 卡在权限弹窗

确认 `coding-agent.config` 里 `CLAUDE_EXTRA_FLAGS="--dangerously-skip-permissions"`。本机受信任环境下强烈推荐。

### Daemon 不停 re-dispatch 同一 PR

可能是 worker 没翻 label。检查 prompt 模板是否要求 worker 翻 label。或手动：
```bash
gh pr edit N --add-label pending/human --remove-label pending/agent
```

如果 worker 没回任何 comment 就完事，state.json 的 comment ID 不会推进，下次又会被当新评论。Prompt 应强制 worker 至少回一句评论。

### 调试一次 poll

```bash
CODING_AGENT_CONFIG=~/myproject/coding-agent.config coding-agent poll
tail -50 ~/.local/state/coding-agent-poll/myproject/poll.log
```

### 查看 session 状态

```bash
coding-agent status                     # 列出所有 session + 状态
```

### 查看 session 日志

```bash
coding-agent logs 42                    # 打印 issue #42 的 worker session 日志
coding-agent logs 42 -f                 # tail -F 跟随（实时）
```

日志是 append-only，同一 issue 重起 session 会续写到同一份；每次启动会插一行 `===== <iso-date> session=... opened =====` 当分隔符。

想让 worker 本身续上对话（而不只是看历史），直接 `coding-agent attach 42`。

### 紧急停所有 worker

```bash
# 停 daemon（Ctrl-C 或 kill daemon 进程）
# 停单个 session：
coding-agent cleanup 42 --force
# 查所有活跃 session：
coding-agent status
```

### 卸载某个 project

```bash
# 停 daemon 进程（Ctrl-C 或 kill）
# 可选：uv tool uninstall coding-agent-work-loop
# 可选：rm <host>/coding-agent.config（也可保留供下次接入）
# 可选：rm -r ~/.local/state/coding-agent-poll/<project>
```

没有 systemd unit / cron job / launchd plist 需要清理——daemon 就是个普通 Python 进程，停了就行。