---
name: coding-agent-work-loop
description: 用 GitHub label 驱动本机 agent 处理 issue/PR，daemon 自动监听并派工。每个 issue 的设计方案 / 讨论 / 代码 / Claude 对话 / tmux 历史都按 issue 号归档，凭号码就能事后查阅、断点续写。包含 setup（一次部署到某个项目）、status（查 daemon 状态）、disable（关闭某项目的 daemon）等命令
---

# coding-agent-work-loop

> [English](SKILL.md) · **中文**

把 GitHub issue / PR 评论变成你本机 agent 的输入输出。一个 systemd timer + 几个 shell 脚本 + 两个 GitHub label，让你通过 GitHub 网页（或 iOS gh app）直接跟 agent 沟通。

> 本 skill 设计上 agent-agnostic。Worker CLI 由 `coding-agent.config` 里的 `WORKER_AGENT=<name>` 选；daemon / dispatch 通过一层薄的 **driver 抽象**对接各家 agent CLI。内置 driver：`claude`（默认，Claude Code）、`opencode`（sst/opencode）、`codex`（OpenAI Codex CLI）、`cursor`（Cursor Agent CLI）。加自家 driver 见 [docs/drivers.zh.md](docs/drivers.zh.md)。

## 触发方式

用户在调用本 skill 的 agent runtime 里输入 `/coding-agent-work-loop <command>` 或自然语言要求时调用。常见请求：

- 「帮我把这个 daemon 装到 X 项目」→ 调 `setup` 流程
- 「coding agent 现在状态如何」→ 调 `status` 流程
- 「关掉 X 项目的 coding agent」→ 调 `disable` 流程

## 你（agent）调用本 skill 时该做什么

### setup（部署到一个 host project）

用户给你一个 host project 路径（如 `~/github/myproject`）。你的步骤：

1. 验证路径存在且是 git 仓库（`.git` 在）
2. 检查依赖：`git`、`gh`（已 `gh auth login`）、`tmux`、`jq`、`flock`、`systemctl`，以及 `WORKER_AGENT` 选定的 worker CLI（默认 `claude`；其他内置：`opencode`、`codex`、`cursor`）都能 `command -v` 到
3. 跑：
   ```bash
   bash "${CLAUDE_PLUGIN_ROOT:-$HOME/.agents/skills/coding-agent-work-loop}/setup.sh" <host-project-path>
   ```
   `$CLAUDE_PLUGIN_ROOT` 是 Claude Code runtime 注入的 skill 根目录变量；没有时回退到规范的 `~/.agents/skills/coding-agent-work-loop`。
4. setup.sh 跑完后会打印下一步指南，原文转给用户

### status

用户要看状态。你的步骤：

1. `systemctl --user list-timers 'coding-agent-poll@*' --no-pager` — 看 timer 健康
2. `systemctl --user list-units 'coding-agent-poll@*.service' --no-pager` — 看最近一次执行
3. 对每个已注册的 `~/.config/coding-agent-work-loop/*.conf`：
   - `tail -20 $STATE_DIR/poll.log`（从 conf 读 STATE_DIR）
   - `gh issue list --repo $REPO --label pending/agent` + `gh pr list --repo $REPO --label pending/agent`
4. 汇总报告给用户

### cleanup（验收完成后）

用户 merge 了 PR 或决定中止某 issue 的工作，要清理状态。步骤：

1. 确认 issue 已结束（PR merged 或被关闭）
2. 跑：
   ```bash
   bash "$CLAUDE_PLUGIN_ROOT/scripts/cleanup-issue.sh" <issue-number>
   ```
   或加 flag：`--force`（worker 还 busy 也清）、`--keep-worktree`（只杀 session）、`--delete-branch`（同时删本地分支）

cleanup-issue.sh 做的事：
- busy 检查（默认拒绝清理 busy session，除非 --force）
- 跑项目级 `CLEANUP_HOOK`（在 `coding-agent.config` 配，比如解 tailscale 端口、关 dev server）
- 杀 worker tmux session
- 删 worktree（默认）
- 可选删本地分支

### disable

用户要停某项目。你的步骤：

1. 确认 instance 名（`systemctl --user list-timers 'coding-agent-poll@*'`）
2. `systemctl --user disable --now coding-agent-poll@<key>.timer`
3. 可选：删除 `~/.config/systemd/user/coding-agent-poll@<key>.{service,timer}` 实例符号链接（如果是真单元文件不动）
4. 可选：删除 `~/.config/coding-agent-work-loop/<key>.conf`
5. 报告

## 项目内不需要的文件

setup 跑完后，host project 工作树里**只多两个东西**：

1. 一行 `.gitignore`（排除 `coding-agent.config`）
2. 一个 `coding-agent.config`（gitignored，配置）

脚本、systemd unit、state、日志都在 host 项目之外（skill 目录 + `~/.config/` + `~/.local/state/`）。

## 详细架构

见同目录 [README.md](README.zh.md)。

## 文件清单

- `setup.sh` — bootstrap 一个 host project
- `scripts/` — daemon + dispatch 脚本（不复制到 host project）
- `prompts/` — worker 初始 prompt 模板（可被 host project 的 `.coding-agent/prompts/` 覆盖）
- `systemd/` — `coding-agent-poll@.service/.timer` 模板单元，setup 时复制到 `~/.config/systemd/user/`
- `coding-agent.config.example` — 配置模板
