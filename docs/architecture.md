# Design

> **English** · [中文](architecture.zh.md)

## Label state machine (five states)

| Label | Set by | Meaning |
|-------|--------|---------|
| `pending/agent` | You | Wait for the agent to pick it up (issue waiting for dispatch / PR has review feedback to address) |
| `doing/agent`   | Daemon | Daemon is dispatching / worker tmux is running |
| `pending/human` | Worker / daemon | Wait for you to review / merge / decide |
| `pending/PR`    | Worker (when opening a PR) | Issue work moved to the PR for tracking; go look at the PR |
| `Done`          | Daemon (auto-cleanup) | **Only on the PR** (PR merged = truly closed); **not on the issue** (the issue is a long-term tracker; closing it is your call) |

### PR↔Issue closure: decided at design time

| Scenario | PR body uses | Issue state at merge | Daemon auto-cleanup |
|----------|--------------|----------------------|---------------------|
| **A. Full closure**: one PR fully resolves the issue | `Closes #N` | GitHub auto-closes | Issue gets `Done` (in sync with the PR) |
| **B. Partial implementation**: multiple PRs are needed | `Refs #N` | Stays open | Issue flipped to `pending/human` for you to triage |
| **C. Issue too large**: suggest splitting into sub-issues | Not dispatched directly | — | You break it down, then label each sub-issue separately |

In its "design proposal" comment, the worker explicitly justifies its A/B/C pick and asks you to confirm before coding. So `Closes` vs `Refs` is a **design-time consensus**, not the worker's default.

### State flow

```
New issue ──────────────────► label: pending/human (default, waiting for you to triage)
   │
   │ You add label: pending/agent
   ▼
pending/agent ──► daemon dispatch ──► label: doing/agent   ← visible in GitHub UI live
                                              │
                                              │ worker does work (branch / write code / run tests / push / open PR with `Refs #N`)
                                              ▼
                                       worker done →
                                          - PR  : pending/human
                                          - Issue: pending/PR (work transferred to PR for tracking)
                                              │
                                              ▼
                                       PR(pending/human) → you review
                                              │
                                              ▼ (you merge the PR)
                                       daemon auto-cleanup →
                                          - PR  : Done (PR closure)
                                          - Issue: pending/human (issue still open, **you decide** whether this PR truly resolves it)
                                              │
                                              ▼
                                       You decide:
                                          - Fully resolved → manually close the issue (optionally add Done label)
                                          - Still partial → comment + label pending/agent for a fresh design / dev cycle
```

> For multi-human + multi-agent workflows (label suffixes like `pending/agent/PM`, `pending/human/Alex`), see [collaboration.md](collaboration.md).

## Re-entry and concurrency safety

- **flock**: `agent-poll.sh` uses `$STATE_DIR/poll.lock` to prevent simultaneous systemd ticks from colliding
- **Label flip is immediate on dispatch**: daemon sees `pending/agent` → dispatches → **first thing it does is flip to `doing/agent`**. Next tick the daemon sees `doing/agent`, which isn't in the `pending/agent` scan set, so no re-dispatch
- **`doing/agent` is also a UI signal**: at a glance on GitHub you can tell "agent is working" (doing/agent) from "agent finished, waiting on you" (pending/human) — no need to attach tmux to know
- **state.json**: records the highest comment ID seen per PR, so the same comment is never dispatched twice
- **Active worker counting**: counts live workers via the tmux session naming convention; new tasks queue up when `MAX_CONCURRENT_WORKERS` is reached

## Worker session model

- Each issue → one git worktree → one tmux session → one `claude -n issue<N> --dangerously-skip-permissions` process
- Naming: tmux session = `<TMUX_PREFIX>-issue<N>`, worktree = `<WORKTREE_BASE>/issue-<N>`, branch = `<BRANCH_PREFIX><N>`
- **Where N comes from for PR dispatch**: `pr_to_issue_num` runs a fallback chain — branch matches `<BRANCH_PREFIX>N` → use it; else PR body has `Closes/Fixes/Resolves/Refs #N` → use it; else fallback to the PR number itself. So an external PR or hand-opened meta PR (no `feature/issue-N` branch, no linked issue) still gets a stable N to drive worktree/session naming. GitHub-only assumption (issue/PR share namespace); see [AGENTS.md](../AGENTS.md#session--worktree--branch-naming) for cross-platform notes
- PR comment trigger: find the corresponding session, use `tmux load-buffer + paste-buffer -p` (bracketed paste) to inject the multi-line prompt, then `send-keys Enter` to submit
- **Auto-resume**: if the worker session dies (`/quit` / restart / crash) and another trigger comes in, the dispatch script checks `~/.claude/projects/<encoded-worktree>/` for existing jsonl files — if found, runs `claude --continue` to resume the original conversation (all context + tool history preserved); otherwise `claude -n issue<N>` for a fresh start. User-initiated `/quit` in the middle of work doesn't lose progress.
- Session gone (and worktree also cleaned up) → automatically rebuilds the worktree from PR head branch + spawns a new session (applies the same resume logic above)
- **Pane log persistence**: each worker session opens with a `tmux pipe-pane` that appends pane output to `$SESSION_LOG_DIR/<tmux-session>.log` (default `$STATE_DIR/sessions/`). The file lives on after the tmux session exits — `cat` / `less` to review

> Where every artifact lives, how to look things up after the fact, and how to resume from a break point: see [persistence.md](persistence.md).

## Design choice FAQ

### Why git worktree

- Main working tree stays untouched, you can keep working on your own things in parallel
- Each issue gets its own directory, dependencies installed independently, no cross-contamination
- Removing a worktree doesn't affect git history

### Why tmux

- Claude Code is a TUI app, needs a pseudo-terminal
- Sessions can be reattached for you to watch progress / take over
- A dying session doesn't kill the worker process (well — Claude is a foreground process, so tmux dying does kill it; tmux is what keeps it alive)

### Why `paste-buffer -p` (bracketed paste)

A direct `send-keys` of a multi-line string would interpret each `\n` as Enter, submitting one message per line. `paste-buffer -p` uses the terminal's bracketed-paste protocol so the whole block is a single paste, which Claude Code (Ink/React-TUI) processes as one user message.

### Why systemd `@` template units

A single template service supports multiple project instances, so we don't install one per project. `%i` = instance key; `EnvironmentFile=%h/.config/coding-agent-work-loop/%i.conf` lets each instance read its own env.

### Why not just use Claude Code's `--from-pr`

Claude Code CLI has a `--from-pr` flag, but it depends on Anthropic's official GitHub App / Action flow. This project's "label + local daemon" approach exists specifically to **avoid that dependency**, so you can use your own machine + Max plan, no API key required.

### Why this stack is cheap (vs webhook + Claude API)

1. **The polling loop burns zero tokens**: `agent-poll.sh` running every 60 seconds is plain shell + `gh` API calls — **no model calls**. Idle = 0 token consumption. Only when it actually finds a `pending/agent` issue / PR does it dispatch to a Claude Code process.
2. **Dispatch goes through the Claude Code CLI, which is on your Max subscription**: workers are local `claude` CLI processes, billed under your Pro/Max plan; no API key, no per-token pricing. Versus the traditional webhook + Anthropic API approach (every trigger costs tokens), this is much cheaper long-term.
