# 设计原理

> [English](architecture.md) · **中文**

## Label 状态机（五态）

| Label | 谁标 | 含义 |
|------|------|------|
| `pending/agent` | 你 | 等 agent pick up（issue 待派工 / PR 有 review 反馈待修） |
| `doing/agent` | daemon | agent 正在 dispatching / worker tmux 正在处理 |
| `pending/human` | worker / daemon | 等你 review / merge / 决策 |
| `pending/PR` | worker（开 PR 时） | issue 工作已转 PR 跟踪；去看 PR |
| `Done` | daemon（auto-cleanup） | **只标 PR**（PR merged = 真闭环）；**不标 issue**（issue 是长期 tracker，关闭权交给你） |

### 关于 PR↔Issue 闭环关系：worker 在设计阶段就决定

| 场景 | PR body 用 | merge 时 issue 状态 | daemon auto-cleanup |
|------|-------|------|------|
| **A. 完整闭环**：一个 PR 全解决 issue | `Closes #N` | GitHub 自动关 | issue 加 Done（与 PR 同状态） |
| **B. 部分实现**：多 PR 才完成 issue | `Refs #N` | 保持 open | issue 翻 `pending/human` 等你 triage |
| **C. issue 太大**：建议拆 sub-issue | 不直接派工 | — | 你拆完每个 sub-issue 再单独 label |

worker 在「设计提案」comment 里就会列出选 A/B/C 的判断，跟你讨论确认后才开干。所以 `Closes` 还是 `Refs` 是**设计阶段共识**，不是 worker 默认行为。

### 状态流转图

```
新 issue ──────────────────► label: pending/human（默认，等你 triage）
   │
   │ 你加 label: pending/agent
   ▼
pending/agent ──► daemon dispatch ──► label: doing/agent  ← GitHub UI 实时可见
                                              │
                                              │ worker 干活（建分支、写代码、跑测试、push、开 PR with `Refs #N`）
                                              ▼
                                       worker 完工 →
                                          - PR  : pending/human
                                          - Issue: pending/PR （工作已转 PR 跟踪）
                                              │
                                              ▼
                                       PR(pending/human) → 你 review
                                              │
                                              ▼ (你 merge PR)
                                       daemon auto-cleanup →
                                          - PR  : Done（PR 闭环）
                                          - Issue: pending/human（issue 仍 open，**等你 triage** 这次 PR 是否真把问题彻底搞定）
                                              │
                                              ▼
                                       你决定：
                                          - 真闭环 → 手动关 issue（可加 Done label）
                                          - 还差点 → 评论 + 标 pending/agent，进新一轮设计或开发
```

> 多人 + 多 agent 协作场景（用 `pending/agent/PM` / `pending/human/Alex` 这种 label 后缀做路由）见 [collaboration.md](collaboration.zh.md)。

## 重入与并发安全

- **flock**：`agent-poll.sh` 用 `$STATE_DIR/poll.lock` 防多个 systemd tick 撞车
- **派工立刻翻 label**：daemon 发现 `pending/agent` → dispatch → **第一件事翻成 `doing/agent`**。下一 tick daemon 看到的是 `doing/agent`，不在 `pending/agent` 扫描范围内，不会重复触发
- **doing/agent 也是 UI 信号**：你在 GitHub 上一眼能区分「agent 在干」（doing/agent）和「agent 干完等你」（pending/human），无需 attach tmux 才能知道
- **state.json**：记录每个 PR「上次见过的最大 comment ID」。同一条评论永远不会被两次派工
- **active worker 计数**：通过 tmux session 命名约定数活的 worker；超过 `MAX_CONCURRENT_WORKERS` 时新任务排队等下一轮

## Worker 会话模型

- 每个 issue → 一个 git worktree → 一个 tmux session → 一个 `claude -n issue<N> --dangerously-skip-permissions` 进程
- 命名：tmux session = `<TMUX_PREFIX>-issue<N>`、worktree = `<WORKTREE_BASE>/issue-<N>`、branch = `<BRANCH_PREFIX><N>`
- PR 评论触发：找对应 session 用 `tmux load-buffer + paste-buffer -p`（bracketed paste）把 prompt 多行注入，再 `send-keys Enter` 提交
- **自动 resume**：worker session 死了（`/quit` / 重启 / crash）后又被触发，调度脚本会查 `~/.claude/projects/<encoded-worktree>/` 有没有历史 jsonl——有就 `claude --continue` 续上原对话（保留所有上下文 + 工具调用历史），没有就 `claude -n issue<N>` 全新起。这意味着用户中途 `/quit` 不丢进度。
- Session 没了（worktree 也被清掉）→ 自动从 PR head branch 重建 worktree + spawn 新 session（同样按上面规则尝试 resume）
- **Pane 日志持久化**：每个 worker session 起来后，dispatch 脚本立刻挂 `tmux pipe-pane` 把输出 append 到 `$SESSION_LOG_DIR/<tmux-session>.log`（默认 `$STATE_DIR/sessions/`）。tmux session 退出后该文件仍在，可以 `cat` / `less` 回看

> 全资产存哪 / 怎么事后查阅 / 怎么断点续写，见 [persistence.md](persistence.zh.md)。

## 设计选择 FAQ

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

一份模板 unit 支持多 project 实例，避免每个项目装一份。`%i` = instance key，`EnvironmentFile=%h/.config/coding-agent-work-loop/%i.conf` 让每个实例读自己的环境。

### 为什么不直接用 Claude Code 的 `--from-pr`

Claude Code CLI 有 `--from-pr` flag 但依赖 Anthropic 官方 GitHub App / Action 流。本项目走「label + 本机 daemon」就是为了**避免依赖**官方 App，让你用自己机器的环境 + Max 计划，不需要 API key。

### 为什么这套架构便宜（对比 webhook + Claude API 方案）

1. **轮询循环不烧 token**：每 60 秒跑一次的 `agent-poll.sh` 是纯 shell + `gh` API 调用，**不调模型**。空闲时 0 token 消耗。只有真的发现 `pending/agent` 的 issue/PR 评论时，才 dispatch 到 Claude Code 进程。
2. **dispatch 走 Claude Code CLI，吃 Max 月费套餐**：worker 是本机 `claude` CLI 进程，计费按你的 Pro/Max 订阅算，不需要 API key、不按 token 计价。相比传统 webhook + Anthropic API 的方案（每次触发都按 token 收钱），长期跑下来便宜一大截。
