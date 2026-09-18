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

另有 3 个可选函数，实现了才有按角色隔离会话的能力，见
[可选 hook：会话隔离](#可选-hook会话隔离)。

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

对于按模型派工的标签，内置 driver 会把 `worker_model_arg` 的结果
（`--model <WORKER_MODEL>`）同时拼入 new / resume 命令。自定义 driver 的 CLI
如果支持单次指定模型，也应接入该 helper。

典型实现：
```bash
agent_command_new() {
    local cwd="$1" name="$2" prompt_file="$3"
    local model_arg
    model_arg="$(worker_model_arg)"
    printf 'your-cli %s %s "$(cat %s)"' \
        "${YOUR_AGENT_EXTRA_FLAGS:-}" "$model_arg" "$prompt_file"
}
```

没有 resume 概念的 agent：让 `agent_command_resume` 直接调 `agent_command_new`：

```bash
agent_command_resume() { agent_command_new "$@"; }
```

### 可选 hook：会话隔离

同一个 agent 既当 worker 又当交叉复审关卡时（`REVIEW_WORKER_AGENT` 配成跟
`WORKER_AGENT` 一样的 CLI），两个角色共用一个 worktree。内置 agent 的「续接」
都是「续这个目录里最近的一条对话」，于是复审会继承 worker 的上下文——连同 worker
为自己辩解的那些话一起继承，就不再是独立复审了。反方向一样糟：复审起完自己那条
之后，worker 下一轮续到的是复审那条，反而丢掉自己的实现上下文。

所以 daemon 给每次派工打一个**角色**（`worker` / `review`，从 prompt 模板类型推），
按 `(work number, agent, 角色)` 把 session id 记在 `$STATE_DIR/agent-sessions/` 下。

driver 想接入，实现下面三个函数并把 `AGENT_SESSION_ISOLATION` 置 1：

```bash
agent_session_new_id <cwd> <role>        # 启动时要钉的 id；CLI 不支持就写空串
agent_session_exists <cwd> <session_id>  # 返回 0 = 这条会话还在、能续
agent_session_list <cwd>                 # 这个 cwd 的会话 id，最近的在前
```

`agent_command_new` / `agent_command_resume` 读 `$WORKER_SESSION_ID`：起新会话时
钉住它，续接时续的就是它。`$WORKER_SESSION_ID` 为空只会出现在「本功能上线前留下的
会话」这一种情况，那时才回落到 CLI 自己的「续最近一条」。

两种形态都支持：

| CLI 能不能在启动时钉 id | driver 怎么做 | 内置例子 |
|---|---|---|
| 能 | `agent_session_new_id` 发一个，启动命令带上 | `claude --session-id <uuid>` |
| 不能 | `agent_session_new_id` 写空串，daemon 在启动后用 `agent_session_list` 把 id 捞回来 | `codex`（0.155.0 启动侧没有这种 flag；它的会话文件在启动后约 0.5s 落盘） |

不实现也能跑：daemon 那时只保证 **review 角色一律起全新会话**，worker 角色保持
上线前「续最近一条」的行为。

### 可选 override：`agent_inject_prompt <tmux_session> <prompt_file>`

默认实现是 `tmux load-buffer + paste-buffer -p + Enter`，对大多数 chat-REPL CLI 通用。需要先 `/<slash-mode>` 切模式的 agent 可在 driver 里重写覆盖。

### 可选 hook：`agent_trust_paths <path>...`

有些 agent 进到没见过的目录会先要人确认「信不信这个目录」，claude 就是——而且 `--dangerously-skip-permissions` **不绕过它**。这个弹窗不会让 session 死掉，于是 dispatch 的秒退探测放行、issue 照常翻成 `doing/agent`：worker 看着活着，其实一动不动。日志里没有任何异常，只有 attach 进去才看得见。

`setup.sh` 每次部署调一次这个 hook，参数是仓库根 + worktree base。agent 没有「目录信任」这个概念的，不实现就行——调用方认得出来并跳过。**必须幂等**：已经信任了就别重写那个文件，它通常正被活着的 agent 进程占着。

内置 `claude` driver 写的是 `~/.claude.json` 里的 `projects["<绝对路径>"].hasTrustDialogAccepted`（测试时用 `CLAUDE_JSON_PATH` 改到别处）。子目录从祖先继承信任，所以这两条就覆盖了以后每个 issue 的 worktree。

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
