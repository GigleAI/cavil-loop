# 运维手册

> [English](operations.md) · **中文**

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
LABEL_AGENT_DOING="doing/agent"
LABEL_PENDING_PR="pending/PR"
LABEL_DONE="Done"

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

# Merge 后 daemon 自动 cleanup（worktree + tmux）
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
| `${LABEL_PENDING_AGENT}` / `${LABEL_PENDING_HUMAN}` / `${LABEL_AGENT_DOING}` / `${LABEL_PENDING_PR}` | label 名 |
| `${OUTPUT_LANGUAGE}` | ISO 639-1 代码，控制 worker 写回 GitHub 的语言（从 `coding-agent.config` 读，默认 `en`） |

## 文件结构

### Skill 目录（推荐 symlink 链路）

```
~/github/coding-agent-work-loop/        # 实际项目仓库
├── SKILL.md
├── README.md
├── docs/                               # 详细文档
├── setup.sh
├── coding-agent.config.example
├── scripts/
├── prompts/
└── systemd/

~/.agents/skills/coding-agent-work-loop  -> ~/github/coding-agent-work-loop
~/.claude/skills/coding-agent-work-loop  -> ~/.agents/skills/coding-agent-work-loop
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

`<project-key>.conf` 是两个 OS 共享的环境变量单源真相——格式一样，只是不同调度器加载方式不一样。

```
~/.config/coding-agent-work-loop/
└── <project-key>.conf                  # KEY=VALUE env 文件；systemd 当 EnvironmentFile 读，launchd 用 `source` 内联加载

# 仅 Linux
~/.config/systemd/user/
├── coding-agent-poll@.service          # symlink → skill 目录的模板
└── coding-agent-poll@.timer            # symlink → skill 目录的模板

# 仅 macOS
~/Library/LaunchAgents/
└── dev.luosky.coding-agent-work-loop.<key>.plist   # 每个 project 生成一份（不是 symlink）
~/Library/Logs/coding-agent-work-loop/
└── <key>.out.log, <key>.err.log        # launchd 截获 daemon 的 stdout/stderr

~/.local/state/coding-agent-poll/<project>/
├── state.json                          # { "seen_comments": ..., "cleaned_prs": ... }
├── poll.log                            # 滚动日志
├── poll.lock                           # flock
└── sessions/                           # 每个 worker tmux session 的 pane 日志
    └── <project>-issue<N>.log
```

## 按 OS 选调度器

`setup.sh` 用 `uname -s` 检测 OS，自动选对应调度器：

| OS | 调度器 | Unit / Plist | `setup.sh` 自动装？ |
|----|--------|--------------|---------------------|
| Linux | `systemd --user` timer | `~/.config/systemd/user/coding-agent-poll@<key>.{service,timer}`（symlink 到 skill 模板）| ✅ |
| macOS | `launchd` LaunchAgent | `~/Library/LaunchAgents/dev.luosky.coding-agent-work-loop.<key>.plist`（生成，非 symlink）| ✅ |
| 其他 | — | — | ❌ `exit 1`；见下方 [手动 cron 兜底](#手动-cron-兜底) |

两条路径都读同一份 `~/.config/coding-agent-work-loop/<key>.conf`，都跑同一个 `agent-poll.sh`。唯一差别是 symlink-vs-生成 的 trade-off：Linux 端 `git pull` skill 自动生效；macOS 端因 launchd 没有 template 模式，plist 是 per-project 生成的，模板有改动要重跑 `setup.sh`。

### macOS 专属

- **Label**：`dev.luosky.coding-agent-work-loop.<key>`（必须和 plist 文件名一致）
- **加载方式**：`launchctl bootstrap gui/$UID <plist>`（modern 语法，macOS 10.10+）。`setup.sh` 会先 `bootout` 再 bootstrap，重跑幂等。
- **运行频率**：`StartInterval=60`（每 60 秒一次，等价 systemd `OnUnitActiveSec=60s`）。
- **日志**：stdout/stderr → `~/Library/Logs/coding-agent-work-loop/<key>.{out,err}.log`。更深的 poll 日志仍在 `$STATE_DIR/poll.log`。
- **flock**：macOS 不自带，先 `brew install flock` 再跑 `setup.sh`。
- **登出 / 合盖**：user LaunchAgent 登录后常驻（即使锁屏也跑）；想"无登录、开机即跑"要装到 `/Library/LaunchDaemons/` —— `setup.sh` 故意不进这里（要 `sudo`，且和 Linux `--user` systemd 对称）。

## 多 project 共存

skill 装一次，调度器模板装一次。每个 project 跑：

```bash
bash ~/.agents/skills/coding-agent-work-loop/setup.sh ~/github/projectA
bash ~/.agents/skills/coding-agent-work-loop/setup.sh ~/github/projectB
```

得到：

```
~/.config/coding-agent-work-loop/
├── projectA.conf
└── projectB.conf

# Linux
systemctl --user list-timers
  coding-agent-poll@projectA.timer
  coding-agent-poll@projectB.timer

# macOS
launchctl list | grep dev.luosky.coding-agent-work-loop
  dev.luosky.coding-agent-work-loop.projectA
  dev.luosky.coding-agent-work-loop.projectB
```

互不干扰、独立日志、独立 state。

## Skill 升级

推荐流程（项目 clone 在 `~/github/coding-agent-work-loop`，symlink 进 skill 目录）：

```bash
cd ~/github/coding-agent-work-loop
git pull
```

**Linux**：systemd unit 是 symlink 指模板，下一次 timer tick 自动用新版逻辑——**不需要重跑 setup.sh**。

**macOS**：LaunchAgent plist 是 per-project、由 `setup.sh` 生成（launchd 无 template 模式）。如果上游 plist 模板有改动，要重跑 `setup.sh` 重新生成：

```bash
launchctl bootout gui/$UID/dev.luosky.coding-agent-work-loop.<key> || true
rm ~/Library/LaunchAgents/dev.luosky.coding-agent-work-loop.<key>.plist
bash ~/.agents/skills/coding-agent-work-loop/setup.sh <host>
```

日常 skill 升级如果只动 `scripts/*` 两边都不用重跑 setup —— 两种调度器每 tick 都重新 exec `agent-poll.sh`。

## 手动 cron 兜底

上面两种调度器不是硬要求；`agent-poll.sh` 无状态，任何调度器都能驱动。适用：

- 你在 `setup.sh` 不自动配的系统（BSD、不带 systemd 的 WSL、容器、……）
- 就不想 systemd / launchd

**cron**（任何 Unix）：

```cron
* * * * * CODING_AGENT_CONFIG=$HOME/myproject/coding-agent.config bash $HOME/.agents/skills/coding-agent-work-loop/scripts/agent-poll.sh >> /tmp/coding-agent-cron.log 2>&1
```

**Claude Code `/loop` skill**：起一个长 session 跑 `/loop 60s bash ~/.agents/skills/coding-agent-work-loop/scripts/agent-poll.sh`。优点：调度逻辑也能上下文感知；缺点：贵 + session 死了就停。

## 升级到 webhook（即时触发）

轮询有最坏 1 分钟延迟。要即时：

1. tailscale funnel / cloudflare tunnel 把本机 `<port>` 开公网
2. 跑 [`webhook`](https://github.com/adnanh/webhook) 这种小 listener 订阅 GitHub `issue_comment` + `labeled` 事件
3. listener 收到 → 直接跑 `agent-poll.sh`（poll 本身按 label 过滤 + state.json 去重，safe to retrigger）
4. 保留 systemd timer / launchd LaunchAgent 当兜底

## 自定义 worker（不是 Claude Code）

Worker 切换走一层薄的 **driver 抽象**，不需要 fork。在 `coding-agent.config` 里设 `WORKER_AGENT=<name>` 即可。内置：`claude`（默认）、`opencode`、`codex`。想加自家 agent，往 `scripts/drivers/<name>.sh` 加（或放项目级 `<host>/.agents/skills/coding-agent-work-loop/drivers/<name>.sh`） — 5 个函数的接口契约和模板见 [drivers.zh.md](drivers.zh.md)。

## 故障排查

### Timer / agent 起来了但 daemon 不跑

**Linux（systemd）**：

```bash
systemctl --user status coding-agent-poll@<key>.timer
systemctl --user status coding-agent-poll@<key>.service
journalctl --user -u coding-agent-poll@<key>.service --since "10 min ago"
```

**macOS（launchd）**：

```bash
launchctl print "gui/$UID/dev.luosky.coding-agent-work-loop.<key>"
tail -50 ~/Library/Logs/coding-agent-work-loop/<key>.err.log
tail -50 ~/Library/Logs/coding-agent-work-loop/<key>.out.log
```

通用原因：
- `~/.config/coding-agent-work-loop/<key>.conf` 路径不对 → 编辑 conf
- `coding-agent.config` 缺字段 → 看 `poll.log`
- `gh auth` 没登录 → `gh auth status`
- `claude` 不在调度器 `PATH` 里 → `~/.config/coding-agent-work-loop/<key>.conf` 里 `PATH=` 加上 `which claude` 的目录

macOS 专属：
- "Bootstrap failed: 5: Input/output error" → 之前的 load 还在。`launchctl bootout "gui/$UID/dev.luosky.coding-agent-work-loop.<key>"` 后重跑 setup。
- `<key>.err.log` 报 `flock: command not found` → `brew install flock`。

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
CODING_AGENT_CONFIG=~/myproject/coding-agent.config \
    bash ~/.agents/skills/coding-agent-work-loop/scripts/agent-poll.sh
tail -50 ~/.local/state/coding-agent-poll/myproject/poll.log
```

### 回看已退出 session 的历史

tmux session 一旦 exit，原 pane 的 scrollback 就消失了。本项目用 `tmux pipe-pane` 把每个 worker session 的输出旁路到磁盘：

```bash
# 路径（默认值；可通过 SESSION_LOG_DIR 改）
$STATE_DIR/sessions/<TMUX_PREFIX>-issue<N>.log

# 快捷查日志
bash ~/.agents/skills/coding-agent-work-loop/scripts/session-log.sh 42        # 打印路径
bash ~/.agents/skills/coding-agent-work-loop/scripts/session-log.sh 42 -c     # cat
bash ~/.agents/skills/coding-agent-work-loop/scripts/session-log.sh 42 -f     # tail -F 跟随
```

日志是 append-only，同一 issue 重起 session 会续写到同一份；每次启动会插一行 `===== <iso-date> session=... opened =====` 当分隔符。

想让 Claude 本身续上对话（而不只是看历史），或 worktree 已被 auto-cleanup 删掉想找回会话，见 [persistence.md → 断点续写 SOP](persistence.zh.md#断点续写-sop)（列了 `--resume <id>` / `--from-pr <P>` / 重建 cwd / 直接读 jsonl 四条路径）。

### 紧急停所有 worker

**Linux**：

```bash
systemctl --user stop coding-agent-poll@<key>.timer
tmux ls | grep "^<project>-issue[0-9]" | cut -d: -f1 | xargs -r -n1 tmux kill-session -t
```

**macOS**：

```bash
launchctl bootout "gui/$UID/dev.luosky.coding-agent-work-loop.<key>"
tmux ls | grep "^<project>-issue[0-9]" | cut -d: -f1 | xargs -n1 tmux kill-session -t
```

### 卸载某个 project

**Linux**：

```bash
KEY=<key>
systemctl --user disable --now coding-agent-poll@$KEY.timer
rm ~/.config/coding-agent-work-loop/$KEY.conf
# 可选：rm <host>/coding-agent.config（也可保留供下次接入）
# 可选：rm -r ~/.local/state/coding-agent-poll/<project>
```

**macOS**：

```bash
KEY=<key>
launchctl bootout "gui/$UID/dev.luosky.coding-agent-work-loop.$KEY"
rm ~/Library/LaunchAgents/dev.luosky.coding-agent-work-loop.$KEY.plist
rm ~/.config/coding-agent-work-loop/$KEY.conf
# 可选：rm <host>/coding-agent.config
# 可选：rm -r ~/.local/state/coding-agent-poll/<project>
# 可选：rm ~/Library/Logs/coding-agent-work-loop/$KEY.*.log
```
