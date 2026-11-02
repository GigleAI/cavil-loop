# Worker Agent Driver

> **English** · [中文](drivers.zh.md)

The daemon / dispatch scripts and "which CLI runs in tmux" are separated by a **driver abstraction**, so any chat-REPL-style CLI that takes a prompt can act as the worker. Switch via `WORKER_AGENT=<name>` in `cavil-loop.config` — no fork required.

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

# 2. In cavil-loop.config:
WORKER_AGENT="cursor"

# 3. Re-run setup.sh so the daemon EnvironmentFile PATH includes `agent`
WORKER_AGENT=cursor bash ~/.agents/skills/cavil-loop/setup.sh ~/path/to/your-project
```

> Under launchd/systemd, ensure `GH_TOKEN` is in the daemon EnvironmentFile so the worker's `gh` CLI uses the intended PAT (see `WORKER_PASS_ENV` in `cavil-loop.config`).

> **Cursor caveat:** `-p` is non-interactive print mode — mid-task issue/PR comments cannot be injected via stdin. The driver kills the live session and respawns with the new prompt (Case B) instead of silently dropping it.

Switching (Codex example):

```bash
# 1. Install the CLI
npm i -g @openai/codex

# 2. In cavil-loop.config:
WORKER_AGENT="codex"

# 3. Re-run setup.sh so the daemon EnvironmentFile PATH points to the new CLI
WORKER_AGENT=codex bash ~/.agents/skills/cavil-loop/setup.sh ~/path/to/your-project
```

> Switching the driver does **not** alter existing worktrees, but new worker sessions launch the new CLI. Risk of mixing: a worktree whose history was written by the previous driver may not be recognized by the new one — cleanup the worktree before relaunching.

## Adding a new driver

Copy `scripts/drivers/_template.sh` to `scripts/drivers/<your>.sh` and implement five functions.

Project-level (no fork): put it at `<host>/.agents/skills/cavil-loop/drivers/<your>.sh`. That path is checked before the built-in directory, so it overrides same-name built-ins.

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

A CLI that cannot pin an id also needs a fourth hook, plus
`AGENT_SESSION_PROOF=1`:

```bash
agent_session_started_with <cwd> <session_id> <prompt_file>   # 0 = this launch started it
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

If your CLI cannot pin an id, make sure `agent_session_list` is cheap and
ordered newest-first: the daemon polls it right after launch to learn the id.
That read-back needs real evidence, which is what `agent_session_started_with`
is for — "a session that showed up after I launched" is not evidence, because
an earlier role whose read-back failed can have its session land inside your
window. The built-in codex driver compares the session's **launch
input** — every user message before the first assistant reply — against the
prompt file the launch was given. Three shortcuts all fail in practice: only the
first user message (a real session opens with the repo's AGENTS instructions, so
the dispatch prompt is the *second* one), only its first line (multi-line
prompts never match themselves), and a fixed-length prefix (shared openings
match the wrong role). The
daemon also appends a one-line unique marker to the prompt of any launch that
will need a read-back, so two launches rendering the same prompt stay
distinguishable; read it with `agent_session_prompt_tag`. Without the hook the
daemon falls back to claiming a lone candidate only when no earlier launch for
that work item was left unresolved.

When the read-back cannot prove anything, the conversation simply stays
unowned — the daemon will not hand it to another role, and the role starts
fresh next time. Do **not** try to make adoption smarter to compensate; the
worker only ever adopts conversations that predate role tracking, and that is
deliberate.

Not implementing these is fine — the daemon then only guarantees that the
**review role always starts a fresh session**, and the worker role keeps the
pre-existing "resume the latest conversation" behaviour.

### Optional override: `agent_inject_prompt <tmux_session> <prompt_file>`

Default: `tmux load-buffer + paste-buffer -p + Enter`. Works for most chat-REPL CLIs. Override if your agent needs to enter a `/slash-mode` first or has a different stdin contract.

### Optional hooks: directory trust (`agent_trust_key`, `agent_trust_paths`, `AGENT_TRUST_PROMPT_*`)

Some agents refuse to work in a directory they have never seen until a human confirms a folder-trust dialog — and the "skip permissions" flags (`--dangerously-skip-permissions`, `--dangerously-bypass-approvals-and-sandbox`) do **not** skip it. The dialog doesn't kill the session, so the dispatcher's crash check lets it through and the issue still flips to `doing/agent`: the worker looks alive and does nothing.

Three optional pieces, all used through one entry point, `agent_trust_dirs <dir>...` in `scripts/drivers/_common.sh`:

- `agent_trust_key <dir>` — print the directory the agent **actually** decides trust on when a session starts in `<dir>`. This is not "the directory or any parent": measured in 2026-11 (GitHub#108), neither agent inherits trust from a parent directory inside a git repository. Not implemented → the directory itself.
- `agent_trust_paths <key>...` — record those keys as trusted. Idempotent: if they already are, don't write a byte (a live agent is usually holding the file). Write through `trust_config_locked_update` (below), never your own read-modify-write.
- `AGENT_TRUST_PROMPT_TITLE` / `AGENT_TRUST_PROMPT_OPTION_RE` / `AGENT_TRUST_PROMPT_FOOTER_RE` — the dialog's **structure**: the last non-empty line of the screen is the dialog's footer, a whole line above it is the "trust" option, and the title (a fixed string, may wrap) is among those lines. With all three set, the daemon checks the pane after every launch (`agent_trust_prompt_on_screen` in `_common.sh`); a match kills the session and hands the item to a human (`pending/human`) with a comment saying which agent, which directory and which record was expected. Never key on a single phrase: a conversation that quotes the dialog — which happens exactly when someone works on this feature — would get killed (reproduced in the PR #110 review). Build the three from a real screen capture and add it to `tests/fixtures/trust-dialog/`, together with a capture of the agent's other dialogs that share the footer (claude's bypass-permissions confirmation, codex's update prompt).

When they run: `setup.sh` once per deploy for the project root, and **every dispatch** right before a session is launched — new session, resume, and the "resume died, start fresh" fallback in all three dispatch scripts (it lives in `agent_session_plan`). Per-dispatch is required: for submodule projects codex trusts each worktree on its own, and deploy time doesn't know those paths. It also brings projects deployed before this change up to date without rerunning setup. A failure to write never blocks the dispatch; the dialog check catches the case where it mattered.

Rules of the built-in drivers (measured on real CLIs: claude 2.1.316 with an isolated config dir, codex 0.163.0):

| session started in | claude trusts by | codex trusts by |
|---|---|---|
| main checkout of a normal repo, or one of its worktrees | the main checkout | the main checkout (its dialog says "Trusting will apply to the repository root") |
| a submodule, or a worktree of a submodule | `<superproject>/.git/modules/<name>` | the worktree itself (one record per issue) |
| a worktree of a bare repo | the bare repo directory (by the same rule; not measured) | the worktree itself |
| not in git | the directory or any parent | the directory itself |

The old `setup.sh` wrote a "worktree base" entry on the assumption that worktrees inherit it; it never had any effect and is gone. Normal projects didn't prompt only because the repo-root entry was there.

`claude` writes `projects["<abs path>"].hasTrustDialogAccepted` in `~/.claude.json` (`CLAUDE_JSON_PATH` overrides it). `codex` appends `[projects."<abs path>"] trust_level = "trusted"` to `${CODEX_HOME:-~/.codex}/config.toml` (needs Python 3.11+ for `tomllib`; without it nothing is written and the dispatch log says so). Resolving a symlinked config file (dotfiles) needs only `readlink` / `cd -P`: if the real path cannot be determined (a link loop, an uncreatable directory) nothing is written — replacing the link itself would detach the user's dotfiles; it never rewrites the rest of the file, and never changes an entry a human set to something other than `trusted`.

**Concurrency.** Every project's daemon on a machine shares these two files, but each project's poll lock is its own. Two "read → merge → atomic replace" writers running at once silently drop each other's entries while both report success — an atomic rename only prevents half-written files. `trust_config_locked_update` therefore takes a lock keyed by the config file's real path (under `~/.local/state/cavil-loop-trust-locks/`, shared by every project, new or pre-rename install), and only then reads, decides, renders and replaces. It waits at most `TRUST_LOCK_WAIT_SECS` (10 s); on timeout it writes nothing. The post-launch dialog check looks for up to `AGENT_TRUST_PROMPT_WAIT_SECS` (4 s; claude shows its dialog within 0.3 s) and stops early if the session exits.

The running claude / codex and hand edits don't take this lock. Before replacing, the content fingerprint is compared again; if it changed, the result is thrown away and redone (up to 3 times), and after replacing the record is read back. What it **cannot** guarantee: a write landing in the instant between the last comparison and the rename is overwritten, and an agent writing back its own older copy can drop the record just added. The next dispatch adds it again; a launch that actually hits the dialog is turned into a visible hand-off by the dialog check.

## Validating your driver

```bash
# 1. Spawn a worker session manually
CODING_AGENT_CONFIG=~/path/to/your-project/cavil-loop.config \
    WORKER_AGENT=<your> bash ~/.agents/skills/cavil-loop/scripts/dispatch-new-issue.sh <test-issue-N>

# 2. Attach to inspect
tmux attach -t <project>-issue<N>

# 3. Once it's running, check busy detection
CODING_AGENT_CONFIG=... WORKER_AGENT=<your> \
    bash -c 'source ~/.agents/skills/cavil-loop/scripts/_lib.sh; \
             agent_is_busy "<project>-issue<N>" && echo BUSY || echo IDLE'
```

If a built-in driver doesn't match your installed version, please file an issue / PR.
