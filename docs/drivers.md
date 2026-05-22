# Worker Agent Driver

> **English** · [中文](drivers.zh.md)

The daemon / dispatch scripts and "which CLI runs in tmux" are separated by a **driver abstraction**, so any chat-REPL-style CLI that takes a prompt can act as the worker. Switch via `WORKER_AGENT=<name>` in `coding-agent.config` — no fork required.

## Built-in drivers

| Driver | CLI | History path | Busy keyword | Status |
|--------|-----|--------------|--------------|--------|
| `claude`   | `claude`   | `~/.claude/projects/<encoded-cwd>/*.jsonl` | `esc to interrupt` | ✅ default, stable |
| `opencode` | `opencode` | `~/.local/share/opencode/...` (version-dependent) | `thinking` / `working` / `esc to interrupt` / `stop` | ⚠️ first-pass; verify against your installed version |
| `codex`    | `codex`    | `~/.codex/sessions/` or `~/.codex/history/` | `thinking` / `running` / `esc to interrupt` | ⚠️ first-pass; verify against your installed version |
| `cursor`   | `agent`    | _(not cwd-probed; always new session)_ | `thinking` / `running` / spinner / `esc to interrupt` | ✅ stable on macOS (headless `-p --trust --force`) |

Switching (Cursor example):

```bash
# 1. Ensure Cursor Agent CLI is on PATH (`agent --help`)
#    macOS: usually bundled with Cursor IDE

# 2. In coding-agent.config:
WORKER_AGENT="cursor"

# 3. Re-run setup.sh so the daemon EnvironmentFile PATH includes `agent`
WORKER_AGENT=cursor bash ~/.agents/skills/coding-agent-work-loop/setup.sh ~/path/to/your-project
```

> Under launchd/systemd, ensure `GH_TOKEN` is in the daemon EnvironmentFile so the worker's `gh` CLI uses the intended PAT (see `WORKER_PASS_ENV` in `coding-agent.config`).

Switching (Codex example):

```bash
# 1. Install the CLI
npm i -g @openai/codex

# 2. In coding-agent.config:
WORKER_AGENT="codex"

# 3. Re-run setup.sh so the daemon EnvironmentFile PATH points to the new CLI
WORKER_AGENT=codex bash ~/.agents/skills/coding-agent-work-loop/setup.sh ~/path/to/your-project
```

> Switching the driver does **not** alter existing worktrees, but new worker sessions launch the new CLI. Risk of mixing: a worktree whose history was written by the previous driver may not be recognized by the new one — cleanup the worktree before relaunching.

## Adding a new driver

Copy `scripts/drivers/_template.sh` to `scripts/drivers/<your>.sh` and implement five functions.

Project-level (no fork): put it at `<host>/.agents/skills/coding-agent-work-loop/drivers/<your>.sh`. That path is checked before the built-in directory, so it overrides same-name built-ins.

### Required functions

```bash
agent_bin
agent_has_history <cwd>
agent_is_busy <tmux_session>
agent_command_new <cwd> <session_name> <prompt_file>
agent_command_resume <cwd> <session_name> <prompt_file>
```

### Contract

#### `agent_bin`
Echo the CLI executable name. `setup.sh` uses it for `command -v` dependency checks and to inject the binary's directory into the systemd EnvironmentFile `PATH`.

#### `agent_has_history <cwd>`
Return 0 if this cwd already has a session for this agent (dispatch will use `agent_command_resume`); non-zero otherwise (dispatch uses `agent_command_new`).

Helper: `encoded_cwd "$cwd"` converts `/foo/bar` to `-foo-bar` (encoding used by Claude / OpenCode).

#### `agent_is_busy <tmux_session>`
Return 0 if the agent is actively thinking / running a tool; non-zero if idle / dead.
Typical: `tmux capture-pane -t $sess -p | grep -q "<stable keyword>"`.

#### `agent_command_new` / `agent_command_resume`
Echo a **single shell command string**. The string is evaluated by `tmux new-session -d -c <cwd> "<cmd>"` in a subshell, so deferred expansions like `"$(cat $prompt_file)"` work.

Typical:
```bash
agent_command_new() {
    local cwd="$1" name="$2" prompt_file="$3"
    printf 'your-cli %s "$(cat %s)"' "${YOUR_AGENT_EXTRA_FLAGS:-}" "$prompt_file"
}
```

Agents without a resume concept:
```bash
agent_command_resume() { agent_command_new "$@"; }
```

### Optional override: `agent_inject_prompt <tmux_session> <prompt_file>`

Default: `tmux load-buffer + paste-buffer -p + Enter`. Works for most chat-REPL CLIs. Override if your agent needs to enter a `/slash-mode` first or has a different stdin contract.

## Validating your driver

```bash
# 1. Spawn a worker session manually
CODING_AGENT_CONFIG=~/path/to/your-project/coding-agent.config \
    WORKER_AGENT=<your> bash ~/.agents/skills/coding-agent-work-loop/scripts/dispatch-new-issue.sh <test-issue-N>

# 2. Attach to inspect
tmux attach -t <project>-issue<N>

# 3. Once it's running, check busy detection
CODING_AGENT_CONFIG=... WORKER_AGENT=<your> \
    bash -c 'source ~/.agents/skills/coding-agent-work-loop/scripts/_lib.sh; \
             agent_is_busy "<project>-issue<N>" && echo BUSY || echo IDLE'
```

If a built-in driver doesn't match your installed version, please file an issue / PR.
