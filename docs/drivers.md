# Worker Agent Driver

> **English** · [中文](drivers.zh.md)

The daemon / dispatch scripts and "which CLI runs in tmux" are separated by a **driver abstraction**, so any chat-REPL-style CLI that takes a prompt can act as the worker. Switch via `WORKER_AGENT=<name>` in `coding-agent.config` — no fork required.

## Built-in drivers

| Driver | CLI | History path | Busy keyword | Status |
|--------|-----|--------------|--------------|--------|
| `claude`   | `claude`   | `~/.claude/projects/<encoded-cwd>/*.jsonl` | `esc to interrupt` | ✅ default, stable |
| `opencode` | `opencode` | `~/.local/share/opencode/...` (version-dependent) | `thinking` / `working` / `esc to interrupt` / `stop` | ⚠️ first-pass; verify against your installed version |
| `codex`    | `codex`    | `~/.codex/sessions/` or `~/.codex/history/` | `thinking` / `running` / `esc to interrupt` | ⚠️ first-pass; verify against your installed version |
| `cursor`   | `agent`    | _(not cwd-probed; always new session)_ | `thinking` / `running` / spinner / `esc to interrupt` | ✅ stable on macOS (headless `-p --trust --force`); no mid-session stdin inject — new comments respawn session |

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

> **Cursor caveat:** `-p` is non-interactive print mode — mid-task issue/PR comments cannot be injected via stdin. The driver kills the live session and respawns with the new prompt (Case B) instead of silently dropping it.

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

Three more are optional and unlock per-role session isolation — see
[Optional hooks: session isolation](#optional-hooks-session-isolation).

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

For model-selecting labels, built-in drivers append the result of
`worker_model_arg` (`--model <WORKER_MODEL>`) to both commands. Custom drivers
should do the same if their CLI supports per-invocation model selection.

Typical:
```bash
agent_command_new() {
    local cwd="$1" name="$2" prompt_file="$3"
    local model_arg
    model_arg="$(worker_model_arg)"
    printf 'your-cli %s %s "$(cat %s)"' \
        "${YOUR_AGENT_EXTRA_FLAGS:-}" "$model_arg" "$prompt_file"
}
```

Agents without a resume concept:
```bash
agent_command_resume() { agent_command_new "$@"; }
```

### Optional hooks: session isolation

When the same agent acts as both the worker and the cross-review gate
(`REVIEW_WORKER_AGENT` set to the same CLI as `WORKER_AGENT`), both roles share
one worktree. Every built-in agent resolves "resume" as *the most recent
conversation in this directory*, so the review would inherit the worker's
context — including the worker's own rationalisations — and would no longer be
an independent review. The reverse is just as bad: once the review has created
its own conversation, the worker's next dispatch resumes *that* one and loses
its implementation context.

The daemon therefore tags every dispatch with a **role** (`worker` / `review`,
derived from the prompt template kind) and keeps one session id per
`(work number, agent, role)` under `$STATE_DIR/agent-sessions/`.

Implement all three functions below and set `AGENT_SESSION_ISOLATION=1` in your
driver to opt in:

```bash
agent_session_new_id <cwd> <role>        # id to pin at launch, or "" if the CLI cannot
agent_session_exists <cwd> <session_id>  # 0 = that session is still resumable
agent_session_list <cwd>                 # session ids for this cwd, newest first
```

`agent_command_new` / `agent_command_resume` then read `$WORKER_SESSION_ID`:
pin it when starting fresh, resume exactly that id otherwise. An empty
`$WORKER_SESSION_ID` only happens for conversations that predate this feature —
fall back to your CLI's own "continue the latest" flag there.

Two shapes are supported:

| CLI can pin an id at launch | What the driver does | Built-in example |
|---|---|---|
| yes | `agent_session_new_id` mints one; the launch command passes it | `claude --session-id <uuid>` |
| no | `agent_session_new_id` echoes `""`; the daemon reads the id back from `agent_session_list` right after launch | `codex` (no such flag as of 0.155.0; its rollout file lands ~0.5 s after start) |

Not implementing these is fine — the daemon then only guarantees that the
**review role always starts a fresh session**, and the worker role keeps the
pre-existing "resume the latest conversation" behaviour.

### Optional override: `agent_inject_prompt <tmux_session> <prompt_file>`

Default: `tmux load-buffer + paste-buffer -p + Enter`. Works for most chat-REPL CLIs. Override if your agent needs to enter a `/slash-mode` first or has a different stdin contract.

### Optional hook: `agent_trust_paths <path>...`

Some agents refuse to work in a directory they have never seen until a human confirms a folder-trust dialog — and for Claude Code `--dangerously-skip-permissions` does **not** skip it. The dialog doesn't kill the session, so the dispatcher's crash check lets it through and the issue still flips to `doing/agent`: the worker looks alive and does nothing. Nothing in the logs says otherwise; you only see it by attaching.

`setup.sh` calls this hook once per deploy with the host project root and the worktree base. Leave it unimplemented if your agent has no notion of directory trust — callers detect that and move on. It must be idempotent: when the paths are already trusted, don't rewrite the file — a live agent process is usually holding it.

The built-in `claude` driver sets `projects["<abs path>"].hasTrustDialogAccepted` in `~/.claude.json` (point `CLAUDE_JSON_PATH` elsewhere in tests). Subdirectories inherit trust from ancestors, which is why those two entries cover every per-issue worktree.

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
