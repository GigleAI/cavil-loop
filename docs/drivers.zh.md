# Worker Agent Driver

> [English](drivers.md) · **中文**

`coding-agent-work-loop` 的 daemon / dispatch 脚本和「在 tmux 里跑哪个 CLI」之间隔了一层 **driver 抽象**，让任何能接受 prompt 的 chat-REPL 风格 CLI 都能当 worker。配 `WORKER_AGENT=<name>` 即可切换，无需 fork。

## 内置 driver

| Driver | CLI | 历史路径 | Busy 探测关键字 | 状态 |
|--------|-----|---------|---------------|------|
| `claude`   | `claude`   | `~/.claude/projects/<encoded-cwd>/*.jsonl` | `esc to interrupt` | ✅ 默认、稳定 |
| `opencode` | `opencode` | `~/.local/share/opencode/...` (按版本) | `thinking` / `working` / `esc to interrupt` / `stop` | ⚠️ 首版适配，请按你装的版本核对 |
| `codex`    | `codex`    | `~/.codex/sessions/` 或 `~/.codex/history/` | `thinking` / `running` / `esc to interrupt` | ⚠️ 首版适配，请按你装的版本核对 |
| `cursor`   | `agent`    | _(不按 cwd 探测；始终 new session)_ | `thinking` / `running` / spinner / `esc to interrupt` | ✅ macOS 验收通过（headless `-p --trust --force`）；不支持 mid-session stdin 注入，新 comment 会重起 session |

切换（Cursor 示例）：

```bash
# 1. 确保 Cursor Agent CLI 在 PATH 上（`agent --help`）
#    macOS：通常随 Cursor IDE 安装

# 2. 在 coding-agent.config 里改
WORKER_AGENT="cursor"

# 3. 重跑 setup.sh 让 daemon EnvironmentFile 的 PATH 包含 `agent`
WORKER_AGENT=cursor bash ~/.agents/skills/coding-agent-work-loop/setup.sh ~/path/to/your-project
```

> launchd/systemd 下请确保 EnvironmentFile 含 `GH_TOKEN`，worker 里的 `gh` 才会用预期 PAT（见 `coding-agent.config` 的 `WORKER_PASS_ENV`）。

> **Cursor 注意：** `-p` 是 non-interactive print 模式，mid-task 的 issue/PR comment 无法通过 stdin 注入。driver 会 kill 当前 session 并用新 prompt 重起（Case B），不会 silent drop。

切换（Codex 示例）：

```bash
# 1. 装好对应 CLI
npm i -g @openai/codex

# 2. 在 coding-agent.config 里改
WORKER_AGENT="codex"

# 3. 重跑 setup.sh 让 daemon EnvironmentFile 的 PATH 指向新 CLI
WORKER_AGENT=codex bash ~/.agents/skills/coding-agent-work-loop/setup.sh ~/path/to/your-project
```

> 切换 driver 后**已有的 worktree 不变**，但新建的 worker session 会用新 CLI 启动。混用风险：同一 worktree 历史是给上一个 driver 写的，新 driver 可能找不到/认不出 → 把 worktree cleanup 后再启动。

## 加新 driver

复制 `scripts/drivers/_template.sh` 为 `scripts/drivers/<your>.sh`，实现 5 个函数。

也可放项目级而不动 skill：`<host>/.agents/skills/coding-agent-work-loop/drivers/<your>.sh`，自动覆盖同名内置 driver。

### 必填函数

```bash
agent_bin
agent_has_history <cwd>
agent_is_busy <tmux_session>
agent_command_new <cwd> <session_name> <prompt_file>
agent_command_resume <cwd> <session_name> <prompt_file>
```

### 接口语义

#### `agent_bin`
stdout 写 CLI 可执行名。setup.sh 用它 `command -v` 检查依赖、并把所在目录拼进 systemd EnvironmentFile 的 `PATH`。

#### `agent_has_history <cwd>`
返回 0 = 该 cwd 有本 agent 的历史会话（dispatch 会走 `agent_command_resume`），非 0 = 没有（走 `agent_command_new`）。

工具：`encoded_cwd "$cwd"` 把 `/foo/bar` 转成 `-foo-bar`（Claude / OpenCode 通用编码）。

#### `agent_is_busy <tmux_session>`
返回 0 = agent 正在 thinking / tool-use；非 0 = idle / dead。
通常实现：`tmux capture-pane -t $sess -p | grep -q "<某个稳定关键字>"`。

#### `agent_command_new` / `agent_command_resume`
stdout 写**一行 shell 命令字符串**。该字符串会被 `tmux new-session -d -c <cwd> "<cmd>"` 在子 shell 里求值，所以可以用 `"$(cat $prompt_file)"` 之类延迟展开。

典型实现：
```bash
agent_command_new() {
    local cwd="$1" name="$2" prompt_file="$3"
    printf 'your-cli %s "$(cat %s)"' "${YOUR_AGENT_EXTRA_FLAGS:-}" "$prompt_file"
}
```

没有 resume 概念的 agent：让 `agent_command_resume` 直接调 `agent_command_new`：

```bash
agent_command_resume() { agent_command_new "$@"; }
```

### 可选 override：`agent_inject_prompt <tmux_session> <prompt_file>`

默认实现是 `tmux load-buffer + paste-buffer -p + Enter`，对大多数 chat-REPL CLI 通用。需要先 `/<slash-mode>` 切模式的 agent 可在 driver 里重写覆盖。

## 验证你的 driver

```bash
# 1. 手动起一个 worker session 看启动是否成功
CODING_AGENT_CONFIG=~/path/to/your-project/coding-agent.config \
    WORKER_AGENT=<your> bash ~/.agents/skills/coding-agent-work-loop/scripts/dispatch-new-issue.sh <test-issue-N>

# 2. 进 tmux 看
tmux attach -t <project>-issue<N>

# 3. 让 agent 跑一会儿，然后从外面查 busy 探测是否对上
CODING_AGENT_CONFIG=... WORKER_AGENT=<your> \
    bash -c 'source ~/.agents/skills/coding-agent-work-loop/scripts/_lib.sh; \
             agent_is_busy "<project>-issue<N>" && echo BUSY || echo IDLE'
```

如果某个内置 driver 在你机器上行为不对，欢迎提 issue / PR 修。
