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

## Dispatch modes: label / greedy

`DISPATCH_MODE` switches what the daemon considers actionable:

| | `label` (default) | `greedy` |
|---|---|---|
| Enters the queue | items carrying a trigger label (`pending/agent[/fable]`, `pending/review`) | every **open** issue / PR, unless a blocking label stops it |
| Blocking labels | — | `pending/human`, `doing/agent`, `Done`, `pending/PR`, `pending/review`, plus `GREEDY_SKIP_LABELS` |
| With nothing labelled | nothing happens | work starts immediately |
| Fits | a human picks what the agent works on | "anything filed here is work to do" |

The two are **not either/or**: in greedy mode the label passes still run first
(collection order: fable → default → review → greedy sweep), and whoever enqueues an
item first keeps it. So `pending/agent/fable` and `pending/review` still select their
own model / agent / template; greedy only sweeps up the rest with the default agent
and model. Sort keys (priority label → stage → waiting time) are identical in both.

In greedy mode the loop closes itself through the worker: dispatch flips
`doing/agent` (blocked), finishing flips `pending/human` (blocked) — so the same item
is never re-opened in a loop. If a worker dies before flipping, self-heal returns it
to the `pending/agent` queue.

> ⚠️ Under greedy, **anyone opening an issue immediately spends a worker's tokens** —
> anonymous outside users included on a public repo. Only enable it where "filed here
> means do it" is actually true.

## Re-entry and concurrency safety

- **flock**: `agent-poll.sh` uses `$STATE_DIR/poll.lock` to prevent simultaneous systemd ticks from colliding
- **Label flip is immediate on dispatch**: daemon sees `pending/agent` → dispatches → **first thing it does is flip to `doing/agent`**. Next tick the daemon sees `doing/agent`, which isn't in the `pending/agent` scan set, so no re-dispatch
- **`doing/agent` is also a UI signal**: at a glance on GitHub you can tell "agent is working" (doing/agent) from "agent finished, waiting on you" (pending/human) — no need to attach tmux to know
- **state.json**: records the highest comment ID seen per PR, so the same comment is never dispatched twice
- **Active worker counting**: counts live workers via the tmux session naming convention; new tasks queue up when `MAX_CONCURRENT_WORKERS` is reached

## Poll pace: idle and failure backoff

The scheduler wakes `agent-poll.sh` every `POLL_INTERVAL_SECS` and always will —
the script cannot change when its own alarm next rings, so the thing being saved
here is **API calls, not processes** (a process costs tens of milliseconds plus
one flock; calls are the scarce resource). What the backoff changes is the first
thing the script does after waking: decide whether to talk to GitHub at all.

**The hard boundary**: this state decides *whether this tick runs*, never *what
it does when it runs*. Who gets dispatched, whether the concurrency cap is full,
which session to reap — all of that is still read fresh from GitHub labels every
real poll. A corrupted pace file can only produce the wrong cadence; it cannot
produce a wrong dispatch or kill a live worker.

**The ladder is keyed on how long the project has been quiet**, not on how many
idle polls have gone by (`POLL_BACKOFF_LADDER`, `<quiet secs>:<interval secs>`):

| Quiet for | Poll every | vs. a 60s tick |
|---|---|---|
| under 1 day | no backoff, every tick | 1x |
| 1–3 days | 5 min | 1/5 |
| 3–7 days | 10 min | 1/10 |
| 7 days or more | 30 min | 1/30 |

The top tier is "no gate at all", not "at most once per `POLL_INTERVAL_SECS`" —
an instance whose timer drop-in ticks faster than that keeps its cadence. Making
it a floor instead is a silent slowdown with no error anywhere, which is exactly
the failure mode this whole area exists to avoid.

Any of these resets the quiet timer to zero on the spot: the daemon did
something (dispatch, self-heal, reap, cleanup); a worker is still running
(`doing/agent` on GitHub, or a live worker tmux session here); the queue has work
waiting even if the concurrency cap blocked it; or the repo changed. "Changed" is
a fingerprint over the rows this poll actually considered — number, updated_at
and labels for items carrying a label the daemon reacts to, plus bare membership
for every other open item so that a merge or a close still registers. It is
computed from the snapshot this tick already fetched, so it costs no extra call.

That fingerprint is also how multi-host setups stay independent: in label mode
another machine's churn on labels this machine does not watch will not wake it.
**Greedy mode cannot isolate** — a greedy candidate set is by definition every
open item in the repo, so everything is in scope. That is greedy's semantics, not
a bug.

**Failing to read GitHub is not the same as having nothing to do.** Failures run
their own ladder — starting at `POLL_INTERVAL_SECS`, doubling on each further
failure, capped at `POLL_FAIL_BACKOFF_MAX_SECS` — and
deliberately **freeze** the quiet timer, so an outage never slows a busy project
down and recovery resumes at the pre-outage tier. Measured 2026-09-18..22: five
projects burned 30040 polls across 88 hours, every single one a 403 "account
suspended"; the same window under this ladder is 905.

**Three defences keep a bad local file from wedging a project**, all failing
*open* (broken state means poll, never means wait):

| Defence | What it covers |
|---|---|
| Heartbeat (`POLL_FORCE_SYNC_SECS`) | More than this since the last successful GitHub read → poll unconditionally, whatever the ladder, the fingerprint, or a bug in this logic says. It does **not** override the failure ladder: re-reading GitHub is precisely what that ladder exists to avoid, and a failure state is self-evident rather than inferred. |
| Only a state the writer could have produced | Before any decision to wait, the file must pass two tests. Each numeric field is checked for character class *and* digit width, since bash arithmetic silently wraps an oversized all-digit value into a plausible-looking timestamp. Then the fields are checked against each other: the writer always leaves `last_active <= last_poll <= next_due <= last_poll + the cap for whichever ladder it used`, so anything else cannot have come from this program and counts as corrupt. Stating it as one closed rule rather than a list of field checks is deliberate — a list only ever covers the variants someone thought of, and the combinations are unbounded. Corrupt means "due now"; the next real poll rewrites the file clean. |
| Two timestamps | Bash has no monotonic clock (`date +%s` is wall time), so both "next due" and "last polled" are stored. Clock jumps forward → poll; jumps backward → state is untrustworthy → poll; file cannot be written (full/read-only disk) → every tick polls, i.e. the pre-#35 behaviour. |

State lives in `$STATE_DIR/poll-pace.json`, separate from `state.json` so that
`rm`-ing it returns the project to full speed without losing the "which comments
have I seen" cursors. A backed-off tick still writes one line to `poll.log`
saying which tier it is on and how long it will wait.

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
2. **Dispatch goes through the Claude Code CLI, which is on your Max subscription**: workers are local `claude` CLI processes, billed under your Pro/Max plan; no API key, no per-token pricing. **This is why the weekly report's money column is a *list-price equivalent*, not a bill** — there is no per-token invoice to reconcile against, so the report shows the project's converted value and the flat subscription outlay as two separate rows and never divides one by the other. Versus the traditional webhook + Anthropic API approach (every trigger costs tokens), this is much cheaper long-term.
