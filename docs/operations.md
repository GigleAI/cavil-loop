# Operations manual

> **English** · [中文](operations.zh.md)

## Configuration (`coding-agent.config`)

Lives at the host project root, auto-added to `.gitignore`.

```bash
# GitHub
REPO="myorg/myrepo"

# Paths
PROJECT_ROOT="$HOME/github/myproject"
WORKTREE_BASE="$HOME/github/worktree/myproject"
STATE_DIR="$HOME/.local/state/coding-agent-poll/myproject"

# Naming
TMUX_PREFIX="myproject"          # tmux session: myproject-issue42
BRANCH_PREFIX="feature/issue-"   # branch: feature/issue-42
SESSION_NAME_PREFIX="issue"      # Claude session name: issue42

# Labels
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_AGENT_FABLE="pending/agent/fable"
FABLE_WORKER_AGENT="claude"
FABLE_MODEL="claude-fable-5"
LABEL_PENDING_HUMAN="pending/human"
LABEL_AGENT_DOING="doing/agent"
LABEL_PENDING_PR="pending/PR"
LABEL_DONE="Done"

# Install command (run after creating worktree)
WORKTREE_SETUP_CMD="npm ci || npm install"
# Examples:
#   uv:     "uv sync"
#   Cargo:  "cargo fetch"
#   pip:    "pip install -r requirements.txt"
#   Make:   "make setup"
#   none:   ":"

# Gitignored files to copy into the worktree
COPY_TO_WORKTREE=".env"

# Worker identity (commit author)
WORKTREE_GIT_USER_NAME=""        # empty = use global ~/.gitconfig
WORKTREE_GIT_USER_EMAIL=""

# Claude Code launch flags
CLAUDE_EXTRA_FLAGS="--dangerously-skip-permissions"

# Env to pass into the worker (tmux doesn't inherit by default)
WORKER_PASS_ENV="GH_TOKEN"

# Auto-cleanup after merge (worktree + tmux)
AUTO_CLEANUP_ON_MERGE="true"

# Project-level cleanup hook (release ports, tear down tunnels, push metrics)
CLEANUP_HOOK=".agents/skills/coding-agent-work-loop/cleanup-hook.sh"

# Pace
MAX_CONCURRENT_WORKERS=1
POLL_INTERVAL_SECS=60
```

Full field list: [`coding-agent.config.example`](../coding-agent.config.example).

## Model-selecting trigger labels

Use `pending/agent` for the worker CLI's default model. Use
`pending/agent/fable` to dispatch the same workflow through Claude Code with
`--model claude-fable-5`. This per-dispatch override does not change the
project's default worker. It works for issues and PRs, including fresh sessions
and resumed sessions.

The daemon stores the selected worker and model in tmux (`@worker_agent` and
`@worker_model`) and keeps the model in `state.json`. If an existing idle
session uses a different worker or model, it is restarted and resumed with the
requested selection. Self-heal also restores the same model-specific pending
label after a worker crash.

If both pending labels are present, `pending/agent/fable` takes precedence.

## Queue order when the pool is full

When more items carry a pending label than there are free slots, the daemon merges
the issue queue and the PR queue into **one pool** and compares three sort keys in
order (configured by `PRIORITY_LABELS`, default
`priority/p0,priority/p1,priority/p2`):

| Key | Rule | Why |
|---|---|---|
| 1. priority label | Earlier in the list wins; **unlabelled items rank as the last entry** | You never label routine work — only tag the urgent one with `priority/p0` to jump the queue |
| 2. stage | review bounce-back < resumed work < brand-new issue | In-flight work already burned tokens and still has warm context, so finishing it frees a slot sooner; a brand-new issue has no sunk cost |
| 3. waiting time | oldest `updatedAt` first | Breaks ties within the same priority and stage |

Leave `PRIORITY_LABELS` empty to disable key 1; ordering falls back to keys 2 and 3.

Sorting changes **order only**, never eligibility: busy sessions are still not
interrupted, the concurrency cap still applies, and label semantics are unchanged.
Each cycle logs the resulting order to `poll.log`, so it is obvious who jumped whom:

```
派工队列 4 项，按「优先级/阶段/等待」排：issue#755(p0,全新) PR#747(p2,review打回) issue#712(p2,全新)
```

When one item carries several trigger labels, the first match still wins in the
order `pending/agent/fable` → `pending/agent` → `pending/review`, independent of
the sort.

## Optional cross-review gate (**off by default**)

Leave `LABEL_PENDING_REVIEW` unset and the stage does not exist — the skill's own prompt
templates never mention review, so existing projects upgrade with zero behaviour change.
Set it and workers stop flipping straight to `pending/human` **when they
produced code** — they flip here instead, and the daemon dispatches `REVIEW_WORKER_AGENT`
(`codex` by default) with `prompts/review.template.md` in its own session. Pass →
`pending/human`. Fail → bounced back to `pending/agent` with concrete feedback.

```
pending/agent ──claude──> code or design doc? ──no──> pending/human  (questions,
                              │yes                                    blocked runs)
                              ▼
                        pending/review ──codex──> pass ──> pending/human
                              ▲                    │fail
                              └────────────────────┘  (back to pending/agent)
```

Design notes:

- The reviewer starts from a **fresh context** and reviews the artifact, not the
  implementer's narrative — that is the whole point of a second pair of eyes
- **Two kinds of output are gated — code and design proposals — each with its own checklist.**
  Reviewing a design means checking whether the stated root cause holds, whether the design
  actually addresses it, and whether the acceptance criteria are verifiable; having no code
  yet is normal and must not be treated as a failure (observed in practice: codex applied the
  code checklist to a design-only issue and could only report "no implementation to review")
- Other text-only exits (questions, clarifications, blocked runs, security stops) still go
  straight to `pending/human`; gating those would burn a review on "I have a question for
  you" and slow down your answer
- `REVIEW_MAX_ROUNDS` (default 3) exists solely to stop two agents from bouncing work
  forever, so **a review a human explicitly asked for is exempt**: a human applying the review
  label bypasses the cap outright, and a human comment restarts the count from that comment.
  Detection compares the actor against `gh api user`, so no guessing at comment intent. Rounds
  are counted from `<!-- codex-review-round -->` markers posted *after the last human action*
  rather than `state.json`: visible on the board, survives state loss
- **Bounce-backs must target the default `pending/agent`**, not the review label itself —
  templates get it via the `${LABEL_PENDING_AGENT_DEFAULT}` placeholder. Getting this wrong
  is an infinite loop
- Self-heal routes a dead session back to **the queue that dispatched it** via
  `worker_trigger_labels` in `state.json`; inferring from the model cannot do this (the
  review gate swaps the agent, not the model)

Leave it empty to keep the previous behaviour exactly.

## Prompt templates

Template lookup order (high → low priority):

1. `<host>/.agents/skills/coding-agent-work-loop/prompts/<name>.template.md` — project-level override (recommended)
2. `<host>/.coding-agent/prompts/<name>.template.md` — old path (kept for compat)
3. `<skill>/prompts/<name>.template.md` — skill default

E.g. one project might require `npm run test:e2e`, another `cargo test` — drop a project-specific override.

Available placeholders (`sed`-rendered):

| Placeholder | Meaning |
|-------------|---------|
| `${ISSUE}` | issue number |
| `${PR}` | PR number (pr-comment only) |
| `${REPO}` | owner/repo |
| `${TITLE}` | issue title (new-issue only) |
| `${WORKTREE}` | absolute worktree path |
| `${BRANCH}` | full branch name |
| `${ISSUE_N}` | issue number derived from branch (pr-comment only) |
| `${LABEL_PENDING_AGENT}` / `${LABEL_PENDING_HUMAN}` / `${LABEL_AGENT_DOING}` / `${LABEL_PENDING_PR}` | label names |
| `${LABEL_REVIEW_OR_HUMAN}` | **where output goes next**: `pending/review` when the gate is on, automatically degrading to `pending/human` when it is off. Always use this in templates rather than `${LABEL_PENDING_REVIEW}` — the latter renders empty when unconfigured, so the work loses `doing/agent` without gaining any pending label and vanishes from the board |
| `${LABEL_PENDING_AGENT_DEFAULT}` | the plain `pending/agent`. Review templates must bounce back to this — `${LABEL_PENDING_AGENT}` is the *triggering* label, so inside the review gate it would bounce work back to the reviewer itself: an infinite loop |
| `${OUTPUT_LANGUAGE}` | ISO 639-1 code controlling the language of GitHub-facing output (from `coding-agent.config`, default `en`) |

## Cleanup hook (`CLEANUP_HOOK`)

`cleanup-issue.sh` runs the project-level hook **before** killing the worker session and
removing the worktree, injecting `ISSUE` / `WORKTREE` / `BRANCH` / `REPO` / `PROJECT_ROOT`.
Typical uses: release preview ports, tear down tunnel routes, push metrics. A non-zero exit
does not abort the cleanup (it only logs a warning).

### Resolve by worktree, not by guessed names and port numbers

The classic mistake is assuming the worker only ever opens the one session you agreed on and
only ever binds the one port you can compute. Counter-example measured in tutor on
2026-07-29 — the convention was `<prefix>-issue<N>-server` on port `4000+N`, but the worker
spun up its own e2e rig:

```
<prefix>-issue695-e2e-be      PORT=5695
<prefix>-issue695-e2e-noauth  PORT=5696     ← 5000+696; not even the same offset formula
```

Those two backends run different auth configs, so reusing a single preview server was never
an option. Cleanup caught none of them: the worktree was removed, the processes stayed alive
as orphans whose cwd reads `(deleted)`, the longest for 2 days 17 hours, holding ports and
memory the whole time.

**Naming conventions get broken; cwd does not lie.** Recommended fallback order:

1. Kill every session prefixed `<prefix>-issue<N>-` (keep the trailing `-`, or `N=69` will
   take out `<prefix>-issue695-server`) instead of one hardcoded name
2. Kill every process whose cwd is under `$WORKTREE` (`readlink /proc/<pid>/cwd`; once the
   worktree is gone the path carries a ` (deleted)` suffix — match that too)
3. Collect ports from what those processes are **actually listening on**, not from a formula

Killing processes by cwd is risky enough to deserve three guards, worth copying verbatim:

- **Validate the shape of `$WORKTREE`** (e.g. require `.../worktree/<project>/issue-<N>` with
  the number matching `$ISSUE`); fall back to name-based cleanup only if it does not match.
  This is what stops an empty or `/` value from sweeping the whole machine
- **Exclude yourself and your entire ancestor chain**, or the hook kills itself along with
  `cleanup-issue.sh`
- **Leave the bare `<prefix>-issue<N>` session alone** — that one belongs to
  `cleanup-issue.sh`; keep the division of labour

Reference implementation: `.agents/skills/coding-agent-work-loop/cleanup-hook.sh` in tutor.

## File layout

### Skill directory (recommended symlink chain)

```
~/github/coding-agent-work-loop/        # the actual project repo
├── SKILL.md
├── README.md
├── docs/                               # extended docs
├── setup.sh
├── coding-agent.config.example
├── scripts/
├── prompts/
└── systemd/

~/.agents/skills/coding-agent-work-loop  -> ~/github/coding-agent-work-loop
~/.claude/skills/coding-agent-work-loop  -> ~/.agents/skills/coding-agent-work-loop
```

### Host project (after connecting)

```
your-project/
├── .gitignore                              # +1 line: coding-agent.config
├── coding-agent.config                      # config (gitignored)
├── .agents/skills/coding-agent-work-loop/   # optional: project-level prompt + cleanup-hook overrides
│   ├── prompts/
│   └── cleanup-hook.sh
└── ... your code ...
```

### User-level state files

`<project-key>.conf` is the single source of truth for env vars on both OS — same format, different scheduler loads it.

```
~/.config/coding-agent-work-loop/
└── <project-key>.conf                  # KEY=VALUE env file; systemd reads as EnvironmentFile, launchd sources it inline

# Linux only
~/.config/systemd/user/
├── coding-agent-poll@.service          # symlink → skill dir template
└── coding-agent-poll@.timer            # symlink → skill dir template

# macOS only
~/Library/LaunchAgents/
└── dev.luosky.coding-agent-work-loop.<key>.plist   # generated per project (not a symlink)
~/Library/Logs/coding-agent-work-loop/
└── <key>.out.log, <key>.err.log        # launchd captures daemon stdout/stderr

~/.local/state/coding-agent-poll/<project>/
├── state.json                          # { "seen_comments": ..., "cleaned_prs": ... }
├── poll.log                            # rolling log
├── poll.lock                           # flock
└── sessions/                           # tmux pane logs per worker
    └── <project>-issue<N>.log
```

## Scheduler by OS

`setup.sh` detects the OS with `uname -s` and wires the right scheduler automatically:

| OS | Scheduler | Unit / Plist | Set up by `setup.sh`? |
|----|-----------|--------------|-----------------------|
| Linux | `systemd --user` timer | `~/.config/systemd/user/coding-agent-poll@<key>.{service,timer}` (symlink to skill template) | ✅ |
| macOS | `launchd` LaunchAgent | `~/Library/LaunchAgents/dev.luosky.coding-agent-work-loop.<key>.plist` (generated) | ✅ |
| Other | — | — | ❌ `exit 1`; see [manual cron fallback](#manual-cron-fallback) below |

Both paths read the same `~/.config/coding-agent-work-loop/<key>.conf` env file and invoke the same `agent-poll.sh`. The only difference is the symlink-vs-generate trade-off: on Linux, `git pull`-ing the skill auto-updates the unit; on macOS the plist is per-project (launchd has no template mode), so a template change requires re-running `setup.sh`.

### macOS specifics

- **Label**: `dev.luosky.coding-agent-work-loop.<key>` (must match the filename)
- **Loaded via**: `launchctl bootstrap gui/$UID <plist>` (modern syntax, macOS 10.10+). `setup.sh` runs `bootout` first if a previous load exists, so re-runs are idempotent.
- **Run cadence**: `StartInterval=60` (every 60s, equivalent to systemd `OnUnitActiveSec=60s`).
- **Logs**: stdout/stderr → `~/Library/Logs/coding-agent-work-loop/<key>.{out,err}.log`. The deeper poll log still lives at `$STATE_DIR/poll.log`.
- **flock**: not bundled with macOS. `brew install flock` once before running `setup.sh`.
- **Logout / lid-close**: a user LaunchAgent runs when you're logged in (even with screen locked). For "run even when no user is logged in," you'd need a `/Library/LaunchDaemons/` install — `setup.sh` deliberately doesn't go there (requires `sudo`, breaks symmetry with Linux's `--user` systemd).

## Running multiple projects

Skill installed once, scheduler template installed once. For each project:

```bash
bash ~/.agents/skills/coding-agent-work-loop/setup.sh ~/github/projectA
bash ~/.agents/skills/coding-agent-work-loop/setup.sh ~/github/projectB
```

You get:

```
~/.config/coding-agent-work-loop/
├── projectA.conf
└── projectB.conf

# Linux
systemctl --user list-timers
  coding-agent-poll@projectA.timer
  coding-agent-poll@projectB.timer

# macOS
launchctl list | grep dev.luosky.coding-agent-work-loop
  dev.luosky.coding-agent-work-loop.projectA
  dev.luosky.coding-agent-work-loop.projectB
```

Independent logs, independent state, no interference.

## Upgrading the skill

Recommended workflow (project cloned at `~/github/coding-agent-work-loop`, symlinked into the skill dir):

```bash
cd ~/github/coding-agent-work-loop
git pull
```

On **Linux** the systemd unit is a symlink pointing at the template, so the next timer tick uses the new logic — **no need to re-run `setup.sh`**.

On **macOS** the LaunchAgent plist is per-project and generated by `setup.sh` (launchd has no template mode). If the upstream plist template changes meaningfully, re-run `setup.sh` to regenerate the plist:

```bash
launchctl bootout gui/$UID/dev.luosky.coding-agent-work-loop.<key> || true
rm ~/Library/LaunchAgents/dev.luosky.coding-agent-work-loop.<key>.plist
bash ~/.agents/skills/coding-agent-work-loop/setup.sh <host>
```

Day-to-day skill upgrades that touch only `scripts/*` don't need re-setup on either OS — both schedulers re-exec `agent-poll.sh` every tick.

## Manual cron fallback

The schedulers above aren't required; `agent-poll.sh` is stateless and any scheduler can drive it. Useful when:

- You're on a system `setup.sh` doesn't auto-configure (BSD, WSL without systemd, container, …)
- You'd rather not deal with systemd / launchd at all

**cron** (any Unix):

```cron
* * * * * CODING_AGENT_CONFIG=$HOME/myproject/coding-agent.config bash $HOME/.agents/skills/coding-agent-work-loop/scripts/agent-poll.sh >> /tmp/coding-agent-cron.log 2>&1
```

**Claude Code `/loop` skill**: open a long-running session that calls `/loop 60s bash ~/.agents/skills/coding-agent-work-loop/scripts/agent-poll.sh`. Upside: the scheduling logic can be context-aware. Downside: expensive + the session dying stops everything.

## Upgrading to webhooks (instant trigger)

Polling has up to 1 minute of latency. For instant:

1. Tailscale funnel / Cloudflare tunnel to expose your local `<port>` publicly
2. Run something like [`webhook`](https://github.com/adnanh/webhook) — a small listener subscribed to GitHub `issue_comment` + `labeled` events
3. On event → invoke `agent-poll.sh` (the poller is label-filtered and state.json-deduped, safe to retrigger)
4. Keep the systemd timer / launchd LaunchAgent as a fallback

## Custom worker (not Claude Code)

Worker selection now goes through a thin **driver layer** — no fork needed. Set `WORKER_AGENT=<name>` in `coding-agent.config`. Built-ins: `claude` (default), `opencode`, `codex`, `cursor`. To add your own agent, drop a `scripts/drivers/<name>.sh` (or project-level override at `<host>/.agents/skills/coding-agent-work-loop/drivers/<name>.sh`) — see [drivers.md](drivers.md) for the 5-function contract and a template.

## Troubleshooting

### Timer / agent is on but daemon isn't running

**Linux (systemd)**:

```bash
systemctl --user status coding-agent-poll@<key>.timer
systemctl --user status coding-agent-poll@<key>.service
journalctl --user -u coding-agent-poll@<key>.service --since "10 min ago"
```

**macOS (launchd)**:

```bash
launchctl print "gui/$UID/dev.luosky.coding-agent-work-loop.<key>"
tail -50 ~/Library/Logs/coding-agent-work-loop/<key>.err.log
tail -50 ~/Library/Logs/coding-agent-work-loop/<key>.out.log
```

Common causes (both OS):
- `~/.config/coding-agent-work-loop/<key>.conf` has a bad path → edit the conf
- `coding-agent.config` is missing fields → check `poll.log`
- `gh auth` not logged in → `gh auth status`
- `claude` isn't in the scheduler's `PATH` → in `~/.config/coding-agent-work-loop/<key>.conf` add the `which claude` dir to `PATH=`

macOS-specific:
- "Bootstrap failed: 5: Input/output error" → previous load is still around. `launchctl bootout "gui/$UID/dev.luosky.coding-agent-work-loop.<key>"`, then re-run setup.
- `flock: command not found` in `<key>.err.log` → `brew install flock`.

### Worker session stuck on permission prompt

Make sure `CLAUDE_EXTRA_FLAGS="--dangerously-skip-permissions"` is set in `coding-agent.config`. Strongly recommended in trusted local environments.

### Every dispatch dies within seconds, self-heal never recovers

Symptom in `poll.log` — a loop that always ends in a false "session corrupted" verdict:

```
dispatch PR #N comment ...
🔄 self-heal: PR #N session=<prefix>-issue<M> 不存在 → 自动重新派工（第 1/3 次 …）
… (3 rounds) …
⚠️ self-heal: PR #N 自动恢复 3 次仍死（疑似会话损坏）→ 转人工 pending/human
```

Check whether the tmux server is alive at all:

```bash
tmux ls   # "no server running on /tmp/tmux-<uid>/default" → this is your case
```

Normally the tmux server is long-lived and lives in *some other* cgroup (started by an
interactive login), so `tmux new-session` just attaches and leaves nothing behind in the
poll unit's cgroup. Once the server dies — typically because systemd-oomd killed the whole
`user@<uid>.service` cgroup — the next `tmux new-session` **starts the server itself**, and
it lands inside `coding-agent-poll@<i>.service`. With `Type=oneshot`, systemd's default
`KillMode=control-group` then SIGTERMs everything left in that cgroup the moment the poll
script exits, taking the brand-new server and its worker session with it.

So self-heal can't ever succeed: it re-dispatches, the session dies again, three rounds burn
out, and the issue gets dumped to `pending/human` under a bogus "session corrupted" reason.

The unit ships with `KillMode=process` to prevent this. Verify it survived your local edits:

```bash
systemctl --user show coding-agent-poll@<instance>.service -p KillMode   # want: process
```

Reproduce the failure (and confirm the fix) without touching the daemon:

```bash
systemd-run --user --unit=probe --service-type=oneshot \
  /usr/bin/tmux new-session -d -s probe 'sleep 300'
sleep 3 && tmux ls   # session gone → control-group; session listed → process
```

Recovering after an episode: items sent to `pending/human` by the give-up path need their
original trigger label back. The daemon records it in `state.json` under
`worker_trigger_labels`, and each retry line in `poll.log` names it (`翻 doing/agent → X`).
Fix the `KillMode` first — anything you re-label before that just dies again.

### Every poll prints "上一轮还没跑完，跳过" and nothing ever runs

The `poll.lock` flock is stuck. flock lives on the *open file description*, so the lock is
held as long as **any** process still has that fd open — and `agent-poll.sh` opens it as fd 9,
which children inherit. If a long-lived process (the tmux server, a worker) ends up in the
poll's process tree, it keeps fd 9 open for hours and the lock is never released. The daemon
then goes completely silent: no errors, no dispatches, just "skip" forever.

Find the holder:

```bash
# any process still holding the lock
for p in /proc/[0-9]*; do
  for fd in $p/fd/*; do
    [ "$(readlink -f "$fd" 2>/dev/null)" = "$STATE_DIR/poll.lock" ] &&
      echo "$(basename "$p") $(tr -d '\0' < "$p/cmdline" | cut -c1-60)"
  done
done 2>/dev/null | sort -u
```

Short-lived `bash` / `gh` processes are the poll currently running — that's normal. A `tmux`
or worker process is the bug. `_lib.sh` closes fd 9 on source (all dispatch scripts source it
before spawning anything long-lived); if you see a worker holding it, that guard is missing.

To unstick without killing the running worker, just delete the lock file — flock is bound to
the inode, so the next poll opens a fresh one while the old process keeps a lock on the
now-unlinked inode:

```bash
rm -f "$STATE_DIR/poll.lock"
```

### Daemon keeps re-dispatching the same PR

Likely the worker didn't flip the label. Check that the prompt template tells the worker to flip. Or manually:
```bash
gh pr edit N --add-label pending/human --remove-label pending/agent
```

If the worker finishes without leaving any comment, state.json's comment ID doesn't advance and the same comment gets treated as new next time. Prompts should require the worker to leave at least one reply.

### Debug a single poll

```bash
CODING_AGENT_CONFIG=~/myproject/coding-agent.config \
    bash ~/.agents/skills/coding-agent-work-loop/scripts/agent-poll.sh
tail -50 ~/.local/state/coding-agent-poll/myproject/poll.log
```

### Browse live worker sessions

Press `Ctrl+b`, then `s`. The workflow keeps tmux's normal `choose-tree` layout
and appends the GitHub issue title to each worker session row:

```text
myproject-issue42: 1 windows | Optimize homepage load performance
```

The title is stored as the session-scoped tmux option `@desc`. It is refreshed
whenever an issue/PR worker session is created or reused. Non-worker sessions
without `@desc` keep the normal tmux display.

### Review history of an exited session

Once a tmux session exits, the pane's scrollback is gone. This project uses `tmux pipe-pane` to mirror each worker session's output to disk:

```bash
# Path (default; tunable via SESSION_LOG_DIR in coding-agent.config)
$STATE_DIR/sessions/<TMUX_PREFIX>-issue<N>.log

# Shortcut
bash ~/.agents/skills/coding-agent-work-loop/scripts/session-log.sh 42        # print path
bash ~/.agents/skills/coding-agent-work-loop/scripts/session-log.sh 42 -c     # cat
bash ~/.agents/skills/coding-agent-work-loop/scripts/session-log.sh 42 -f     # tail -F
```

Append-only; re-spawning the session for the same issue extends the same file. Each spawn writes a `===== <iso-date> session=... opened =====` separator line.

If you want Claude itself to resume the conversation (not just inspect history), or the worktree has been auto-cleanup'd and you want the session back, see [persistence.md → Resume from a break point](persistence.md#sops-resume-from-a-break-point) — it lists four paths (`--resume <id>` / `--from-pr <P>` / rebuild cwd / read jsonl directly).

### Emergency stop all workers

**Linux**:

```bash
systemctl --user stop coding-agent-poll@<key>.timer
tmux ls | grep "^<project>-issue[0-9]" | cut -d: -f1 | xargs -r -n1 tmux kill-session -t
```

**macOS**:

```bash
launchctl bootout "gui/$UID/dev.luosky.coding-agent-work-loop.<key>"
tmux ls | grep "^<project>-issue[0-9]" | cut -d: -f1 | xargs -n1 tmux kill-session -t
```

### Uninstall one project

**Linux**:

```bash
KEY=<key>
systemctl --user disable --now coding-agent-poll@$KEY.timer
rm ~/.config/coding-agent-work-loop/$KEY.conf
# optional: rm <host>/coding-agent.config (or keep it for re-deploy later)
# optional: rm -r ~/.local/state/coding-agent-poll/<project>
```

**macOS**:

```bash
KEY=<key>
launchctl bootout "gui/$UID/dev.luosky.coding-agent-work-loop.$KEY"
rm ~/Library/LaunchAgents/dev.luosky.coding-agent-work-loop.$KEY.plist
rm ~/.config/coding-agent-work-loop/$KEY.conf
# optional: rm <host>/coding-agent.config
# optional: rm -r ~/.local/state/coding-agent-poll/<project>
# optional: rm ~/Library/Logs/coding-agent-work-loop/$KEY.*.log
```
