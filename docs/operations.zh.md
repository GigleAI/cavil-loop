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
LABEL_PENDING_AGENT_FABLE="pending/agent/fable"
FABLE_WORKER_AGENT="claude"
FABLE_MODEL="claude-fable-5"
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

## 按模型派工的标签

使用 `pending/agent` 时沿用 worker CLI 的默认模型；使用
`pending/agent/fable` 时，本次派工会切到 Claude Code，并追加
`--model claude-fable-5`。这个覆盖只作用于本次派工，不会修改项目默认 worker。
issue、PR、全新 session 和 resume session 都支持。

daemon 会把选中的 worker 和模型记录在 tmux `@worker_agent` /
`@worker_model`，并把模型写入 `state.json`。如果现有 idle session 的 worker
或模型不同，会重启并以指定组合 resume；worker crash 后 self-heal 也会恢复到
同一个模型专用 pending 标签。

若两个 pending 标签同时存在，`pending/agent/fable` 优先。

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
                              └────────────────────┘（打回 pending/agent，claude 改完再来）
```

几个设计要点：

- **reviewer 拿的是全新上下文**，看产出而不是看实现者的自述——这才是第二双眼睛的价值
- **拦「代码产出」和「设计方案」两类**，各用各的清单。设计方案审的是根因是否成立、
  Design 能否解决它、验收标准是否可验证——此时没有代码是正常的，reviewer 不该因此判不通过
  （实测踩过：codex 拿审代码的尺子去量一份只有方案的 issue，只能报「没有可 review 的实现」）
- 其余纯文字出口（提问、反问、受阻停机、安全停机）仍直达 `pending/human`，
  否则「我有个问题想问你」也要白烧一次 review、还拖慢你被问到的速度
- **轮次上限**（`REVIEW_MAX_ROUNDS`，默认 3）防两个 agent 互相打回烧 API。轮次不存
  state.json，而是数 issue/PR 上的 `<!-- codex-review-round -->` 标记：看板上看得见、
  state 丢了不会重置、人工介入后天然清零
- **打回必须用默认的 `pending/agent`**，不是 review label 自己——模板里用
  `${LABEL_PENDING_AGENT_DEFAULT}` 占位符拿这个值。用错就是死循环
- self-heal 靠 `state.json` 的 `worker_trigger_labels` 把死掉的 session 送回**原来那条队列**；
  只按 model 反推做不到这点（review 关卡换的是 agent 不是 model）

留空 = 完全关闭，行为与从前一致。

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
| `${LABEL_REVIEW_OR_HUMAN}` | **产出后该翻到哪**：启用 review 关卡时 = `pending/review`，未启用时自动退化成 `pending/human`。模板一律用它，别直接写 `${LABEL_PENDING_REVIEW}`——没配置时那个渲染成空串，活会丢掉 `doing/agent` 又拿不到任何 pending 标签，从看板上彻底消失 |
| `${LABEL_PENDING_AGENT_DEFAULT}` | 默认的 `pending/agent`。review 模板打回时必须用它——`${LABEL_PENDING_AGENT}` 是**触发**标签，在 review 关卡里拿它打回等于打回自己，死循环 |
| `${OUTPUT_LANGUAGE}` | ISO 639-1 代码，控制 worker 写回 GitHub 的语言（从 `coding-agent.config` 读，默认 `en`） |

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

参考实现见 tutor 项目的 `.agents/skills/coding-agent-work-loop/cleanup-hook.sh`。

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

Worker 切换走一层薄的 **driver 抽象**，不需要 fork。在 `coding-agent.config` 里设 `WORKER_AGENT=<name>` 即可。内置：`claude`（默认）、`opencode`、`codex`、`cursor`。想加自家 agent，往 `scripts/drivers/<name>.sh` 加（或放项目级 `<host>/.agents/skills/coding-agent-work-loop/drivers/<name>.sh`） — 5 个函数的接口契约和模板见 [drivers.zh.md](drivers.zh.md)。

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
