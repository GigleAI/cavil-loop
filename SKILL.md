---
name: coding-agent-work-loop
description: Python 跨平台 skill，用 GitHub label 驱动本机 agent（claude / opencode）处理 issue/PR。daemon 自动监听并派工。包含 setup（部署到项目）、daemon（后台轮询）、status（查看状态）、attach / logs（调试 worker）、cleanup（清理）、seed（初始化状态）等命令
---

# coding-agent-work-loop

把 GitHub issue / PR 评论变成你本机 agent 的输入输出。一个 Python daemon + GitHub label，让你通过 GitHub 网页（或 iOS gh app）直接跟 agent 沟通。支持 claude、opencode 两种 worker，可扩展注册新 worker。

> 本 skill 是跨平台 Python 包（≥3.11），不再依赖 systemd / tmux / flock。Worker 抽象层让**任何能被启动且接受 prompt 的 agent CLI 都能接入**——实现 `WorkerBase` 接口并 `@register_worker` 即可。

## 触发方式

用户在调用本 skill 的 agent runtime 里输入 `/coding-agent-work-loop <command>` 或自然语言要求时调用。常见请求：

- 「帮我把这个 daemon 装到 X 项目」→ 调 `setup` 流程
- 「coding agent 现在状态如何」→ 调 `status` 流程
- 「关掉 X 项目的 coding agent」→ 停 daemon 进程
- 「看看 issue #5 的日志」→ 调 `logs` 流程
- 「连上 issue #3 的 worker」→ 调 `attach` 流程
- 「清理 issue #7 的 worktree」→ 调 `cleanup` 流程

## 你（agent）调用本 skill 时该做什么

### setup（部署到一个 host project）

用户给你一个 host project 路径（如 `~/github/myproject`）。你的步骤：

1. 验证路径存在且是 git 仓库（`.git` 在）
2. 跑：
   ```
   uv run coding-agent setup <host-project-path>
   ```
   或指定自定义 instance key：
   ```
   uv run coding-agent setup <host-project-path> --key mykey
   ```
3. setup 会自动：检查依赖（git、gh、python3.11+）、验证 `gh auth`、生成 `coding-agent.config`、创建 GitHub label、初始化 `state.json`
4. setup 跑完后会打印下一步指南，原文转给用户

### daemon（后台轮询）

启动守护进程，持续轮询 GitHub 并派工：

```
uv run coding-agent daemon
```

可用 `--config` 指定配置文件，`--worker` 覆盖 worker 类型。

Ctrl+C 停止。

### poll（单次轮询）

跑一轮 poll 后退出，适合 cron 或手动调试：

```
uv run coding-agent poll
```

### status（查看状态）

查看当前项目所有 worker session 状态：

```
uv run coding-agent status
```

输出包含：项目名、worker 类型、所有 session 列表（含状态 / 关联 issue / worktree 路径）、已死 session、活跃 worker 数。

### attach（连接 worker TUI）

实时连接某个 issue 的 worker session：

```
uv run coding-agent attach <issue-number>
```

### logs（查看 worker 日志）

查看 issue 对应 worker 的日志：

```
uv run coding-agent logs <issue-number>           # 一次性输出
uv run coding-agent logs <issue-number> --follow  # 持续跟踪（类似 tail -F）
```

### cleanup（清理 issue 工作状态）

用户 merge 了 PR 或决定中止某 issue 的工作，要清理状态：

```
uv run coding-agent cleanup <issue-number>
```

可选 flag：
- `--force`：session 还 busy 也强制清理
- `--keep-worktree`：只杀 session，保留 worktree
- `--delete-branch`：同时删本地分支

cleanup 做的事：busy 检查（默认拒绝 busy session，除非 --force）→ 跑项目级 `CLEANUP_HOOK` → 停 worker session → 删 worktree → 可选删分支。

### seed（初始化状态）

首次使用时初始化 `state.json`，setup 内部也会自动调用：

```
uv run coding-agent seed
```

### disable（停止项目 daemon）

不再使用 systemd。直接停止 daemon 进程即可：

```
# 找到 daemon 进程
ps aux | grep "coding_agent daemon"
# 杀掉
kill <pid>
```

或直接在运行 daemon 的终端 Ctrl+C。

可选：删除 `~/.config/coding-agent-work-loop/<key>.conf` 和项目目录下的 `coding-agent.config`。

## 项目内不需要的文件

setup 跑完后，host project 工作树里**只多两个东西**：

1. 一行 `.gitignore`（排除 `coding-agent.config`）
2. 一个 `coding-agent.config`（gitignored，配置）

Python 包、state、日志都在 host 项目之外（`~/.config/` + `~/.local/state/`）。

## 详细架构

见同目录 [README.md](README.md)。

## 文件清单

- `coding_agent/` — Python 包主代码
  - `cli.py` — CLI 入口（argparse，注册所有子命令）
  - `config.py` — 配置加载（从 `coding-agent.config` 读取所有变量）
  - `poll.py` — 主轮询逻辑 + daemon 循环
  - `dispatch.py` — 新 issue / 评论 / PR 评论派工
  - `cleanup.py` — issue 清理（worktree / session / branch）
  - `seed.py` — 初始化 `state.json`
  - `setup_cmd.py` — `setup` 子命令实现
  - `state.py` — state.json 读写 + 文件锁
  - `gh_utils.py` — GitHub CLI 封装（label / issue / PR / comment 查询）
  - `git_ops.py` — git worktree 操作
  - `prompt.py` — prompt 模板渲染
  - `log_util.py` — 日志工具
  - `worker/` — Worker 抽象层 + 实现
    - `__init__.py` — `WorkerBase` ABC + 注册表 + `get_worker()` / `register_worker()`
    - `claude.py` — Claude Code worker 实现
    - `opencode.py` — opencode worker 实现
- `prompts/` — worker 初始 prompt 模板（可被 host project 的 `.coding-agent/prompts/` 覆盖）
- `coding-agent.config.example` — 配置模板
- `pyproject.toml` — Python 包定义 + `coding-agent` CLI 入口点
