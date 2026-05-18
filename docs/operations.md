# 运维手册

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
LABEL_AGENT_DOING="agent/doing"
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

```
~/.config/coding-agent-work-loop/
└── <project-key>.conf                  # systemd EnvironmentFile

~/.config/systemd/user/
├── coding-agent-poll@.service          # symlink → skill 目录的模板
└── coding-agent-poll@.timer            # symlink → skill 目录的模板

~/.local/state/coding-agent-poll/<project>/
├── state.json                          # { "seen_comments": ..., "cleaned_prs": ... }
├── poll.log                            # 滚动日志
├── poll.lock                           # flock
└── sessions/                           # 每个 worker tmux session 的 pane 日志
    └── <project>-issue<N>.log
```

## 多 project 共存

skill 装一次，systemd 模板 symlink 一次。每个 project 跑：

```bash
bash ~/.agents/skills/coding-agent-work-loop/setup.sh ~/github/projectA
bash ~/.agents/skills/coding-agent-work-loop/setup.sh ~/github/projectB
```

得到：

```
~/.config/coding-agent-work-loop/
├── projectA.conf
└── projectB.conf

systemctl --user list-timers
  coding-agent-poll@projectA.timer
  coding-agent-poll@projectB.timer
```

互不干扰、独立日志、独立 state。

## Skill 升级

推荐流程（项目 clone 在 `~/github/coding-agent-work-loop`，symlink 进 skill 目录）：

```bash
cd ~/github/coding-agent-work-loop
git pull
```

systemd unit 是 symlink 指模板，下一次 timer tick 自动用新版逻辑——**不需要重跑 setup.sh**。

## 其他调度器

systemd 不是硬要求；脚本无状态、可被任何调度器调起。

**cron**（macOS / 不想用 systemd）：

```cron
* * * * * CODING_AGENT_CONFIG=$HOME/myproject/coding-agent.config bash $HOME/.agents/skills/coding-agent-work-loop/scripts/agent-poll.sh >> /tmp/coding-agent-cron.log 2>&1
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
      <string>/Users/you/.agents/skills/coding-agent-work-loop/scripts/agent-poll.sh</string>
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

**Claude Code `/loop` skill**：起一个长 session 跑 `/loop 60s bash ~/.agents/skills/coding-agent-work-loop/scripts/agent-poll.sh`。优点：调度逻辑也能上下文感知；缺点：贵 + session 死了就停。

## 升级到 webhook（即时触发）

轮询有最坏 1 分钟延迟。要即时：

1. tailscale funnel / cloudflare tunnel 把本机 `<port>` 开公网
2. 跑 [`webhook`](https://github.com/adnanh/webhook) 这种小 listener 订阅 GitHub `issue_comment` + `labeled` 事件
3. listener 收到 → 直接跑 `agent-poll.sh`（poll 本身按 label 过滤 + state.json 去重，safe to retrigger）
4. 保留 systemd timer 当兜底

## 自定义 worker（不是 Claude Code）

dispatch-*.sh 的关键是「在 tmux 里起一个能接受 stdin prompt 的交互式 agent」。换成 Aider、Cursor CLI、自家 agent 都行：把 `claude -n ... "$prompt"` 那行换成你的 CLI 即可。建议 fork 后改 dispatch-*.sh，而不是 patch 原 skill。

## 故障排查

### Timer 起来了但 daemon 不跑

```bash
systemctl --user status coding-agent-poll@<key>.timer
systemctl --user status coding-agent-poll@<key>.service
journalctl --user -u coding-agent-poll@<key>.service --since "10 min ago"
```

常见原因：
- `~/.config/coding-agent-work-loop/<key>.conf` 路径不对 → 编辑 conf
- `coding-agent.config` 缺字段 → 看 `poll.log`
- `gh auth` 没登录 → `gh auth status`
- `claude` 不在 systemd `PATH` 里 → `~/.config/coding-agent-work-loop/<key>.conf` 里 `PATH=` 加上 `which claude` 的目录

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

想让 Claude 本身续上对话（而不只是看历史），或 worktree 已被 auto-cleanup 删掉想找回会话，见 [persistence.md → 断点续写 SOP](persistence.md#断点续写-sop)（列了 `--resume <id>` / `--from-pr <P>` / 重建 cwd / 直接读 jsonl 四条路径）。

### 紧急停所有 worker

```bash
systemctl --user stop coding-agent-poll@<key>.timer
tmux ls | grep "^<project>-issue[0-9]" | cut -d: -f1 | xargs -r -n1 tmux kill-session -t
```

### 卸载某个 project

```bash
KEY=<key>
systemctl --user disable --now coding-agent-poll@$KEY.timer
rm ~/.config/coding-agent-work-loop/$KEY.conf
# 可选：rm <host>/coding-agent.config（也可保留供下次接入）
# 可选：rm -r ~/.local/state/coding-agent-poll/<project>
```
