---
name: cavil-loop
description: 用 GitHub label 驱动本机 agent 处理 issue/PR，daemon 自动监听并派工。每个 issue 的设计方案 / 讨论 / 代码 / Claude 对话 / tmux 历史都按 issue 号归档，凭号码就能事后查阅、断点续写。包含 setup（一次部署到某个项目）、status（查 daemon 状态）、disable（关闭某项目的 daemon）等命令
---

# cavil-loop

> [English](SKILL.md) · **中文**

把 GitHub issue / PR 评论变成你本机 agent 的输入输出。一个 systemd timer + 几个 shell 脚本 + 两个 GitHub label，让你通过 GitHub 网页（或 iOS gh app）直接跟 agent 沟通。

> 本 skill 设计上 agent-agnostic。Worker CLI 由 `cavil-loop.config` 里的 `WORKER_AGENT=<name>` 选；daemon / dispatch 通过一层薄的 **driver 抽象**对接各家 agent CLI。内置 driver：`claude`（默认，Claude Code）、`opencode`（sst/opencode）、`codex`（OpenAI Codex CLI）、`cursor`（Cursor Agent CLI）。加自家 driver 见 [docs/drivers.zh.md](docs/drivers.zh.md)。

## 触发方式

用户在调用本 skill 的 agent runtime 里输入 `/cavil-loop <command>` 或自然语言要求时调用。常见请求：

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
   bash "${CLAUDE_PLUGIN_ROOT:-$HOME/.agents/skills/cavil-loop}/setup.sh" <host-project-path>
   ```
   `$CLAUDE_PLUGIN_ROOT` 是 Claude Code runtime 注入的 skill 根目录变量；没有时回退到规范的 `~/.agents/skills/cavil-loop`。
4. setup.sh 跑完后会打印下一步指南，原文转给用户

### status

用户要看状态。你的步骤：

1. `bash "${CLAUDE_PLUGIN_ROOT:-$HOME/.agents/skills/cavil-loop}/scripts/install-status.sh"` — 一个 JSON 对象（只读）：daemon 装在哪、哪个版本、`gh` 是否登录、每个已接项目（新旧名字都列）的后台任务状态（`running` / `stopped` / `unknown`——`unknown` 是读不到，不要报成已停）、上次轮询时间、配置里用的 agent 缺哪些依赖。字段说明见 [docs/operations.zh.md](docs/operations.zh.md#用脚本安装查状态断开github313)
2. 只有第 1 步出现 `unknown` 或要看更多细节时：`systemctl --user list-timers 'cavil-loop-poll@*' --no-pager` / `systemctl --user list-units 'cavil-loop-poll@*.service' --no-pager`（macOS：`launchctl print gui/$UID/dev.luosky.cavil-loop.<key>`）
3. 对第 1 步 `projects[]` 里的每个项目：
   - `tail -20 $STATE_DIR/poll.log`（第 1 步输出里的 `state_dir`）
   - `gh issue list --repo $REPO --label pending/agent` + `gh pr list --repo $REPO --label pending/agent`
   - `bash "${CLAUDE_PLUGIN_ROOT:-$HOME/.agents/skills/cavil-loop}/scripts/poll-history.sh" --state-dir $STATE_DIR`——最近几轮轮询各干了什么（结果、最后一步、派工数、GitHub 调用数）、没正常结束的轮次、最近一份快照（GitHub#344，见 [docs/operations.zh.md](docs/operations.zh.md#最近几轮轮询都干了什么运行记录github344)）。只读
   - `jq . $STATE_DIR/config-notice.json`（有这个文件时）——本项目配置里缺的新功能设置：这些功能在本项目上是关着的，新装项目却是开的（GitHub#289，见 [docs/operations.zh.md](docs/operations.zh.md#升级不会自动补上的新配置)）。逐项列出缺的配置项和要开时写的那一行
4. 汇总报告给用户

改名前装的项目仍用旧名字运行：`coding-agent-poll@*` 定时任务、`~/.config/coding-agent-work-loop/*.conf`。两套都查，别把旧项目报成「没装」；空闲的旧项目会被自动迁走，搬了什么、为什么还在等，看 `~/.local/state/cavil-loop/migrate.log`（见 [docs/operations.zh.md](docs/operations.zh.md#改名前的安装)）。

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
- 跑项目级 `CLEANUP_HOOK`（在 `cavil-loop.config` 配，比如解 tailscale 端口、关 dev server）
- 杀 worker tmux session
- 删 worktree（默认）
- 可选删本地分支

### disable

用户要停某项目。你的步骤：

1. 确认 instance 名（`status` 脚本输出里的 `.projects[].key`）
2. `bash "${CLAUDE_PLUGIN_ROOT:-$HOME/.agents/skills/cavil-loop}/scripts/disconnect-project.sh" <key>` — 停掉后台任务（Linux 定时器或 macOS LaunchAgent，改名前的旧安装用旧名字），确认已停后撤掉登记；项目配置和状态保留。退出 2（`RESULT=unknown`）= 读不到后台任务状态，什么都没动；退出 3（`RESULT=failed`）= 停不下来，登记保留——把输出转告用户，不要自己手删文件
3. 报告（说明项目配置和状态都保留着，重跑 `setup.sh` 就能接回）

## 项目内不需要的文件

setup 跑完后，host project 工作树里**只多两个东西**：

1. 一行 `.gitignore`（排除 `cavil-loop.config`）
2. 一个 `cavil-loop.config`（gitignored，配置）

脚本、systemd unit、state、日志都在 host 项目之外（skill 目录 + `~/.config/` + `~/.local/state/`）。

## 详细架构

见同目录 [README.md](README.zh.md)。

## 文件清单

- `setup.sh` — bootstrap 一个 host project
- `scripts/` — daemon + dispatch 脚本（不复制到 host project）
- `prompts/` — worker 初始 prompt 模板（可被 host project 的 `.agents/skills/cavil-loop/prompts/` 覆盖）
- `systemd/` — `cavil-loop-poll@.service/.timer` 模板单元，setup 时复制到 `~/.config/systemd/user/`
- `cavil-loop.config.example` — 配置模板
