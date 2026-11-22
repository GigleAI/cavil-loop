# Operations manual

> **English** · [中文](operations.zh.md)

Everything an operator needs after `setup.sh`: the settings in `cavil-loop.config`, each optional feature (what it does, whether it is on by default, how to switch it), the commands for running the daemon, and troubleshooting. Each section starts with the short answer; open the folded blocks for rules, edge cases and step-by-step commands. How a project plugs in its own prompts and commands is in [Orchestration](orchestration.md).

- **Set up first**: [Configuration (`cavil-loop.config`)](#configuration-cavil-loopconfig)
- **Features, one per section**: [Queue order when the pool is full](#queue-order-when-the-pool-is-full) · [Model-selecting trigger labels](#model-selecting-trigger-labels) · [Waiting on another item: `pending/blocked`](#waiting-on-another-item-pendingblocked) · [Parked for later: `pending/later`](#parked-for-later-pendinglater) · [Auto-add issues / PRs to GitHub Projects (optional, off by default)](#auto-add-issues--prs-to-github-projects-optional-off-by-default) · [Optional cross-review gate (off by default)](#optional-cross-review-gate-off-by-default) · [Autopilot label (optional, off by default)](#autopilot-label-optional-off-by-default) · [External requester bot (optional, off by default)](#external-requester-bot-optional-off-by-default) · [Round log: agent ↔ agent back-and-forth in one comment (`ENABLE_ROUND_LOG`)](#round-log-agent--agent-back-and-forth-in-one-comment-enable_round_log) · [Comment usage footer](#comment-usage-footer) · [Codex token value estimates](#codex-token-value-estimates) · [Automatic price gap fill](#automatic-price-gap-fill) · [Agent hit its usage limit: pause that agent, hand the interrupted item to a human](#agent-hit-its-usage-limit-pause-that-agent-hand-the-interrupted-item-to-a-human) · [Heavy tests: one at a time (optional, off by default)](#heavy-tests-one-at-a-time-optional-off-by-default) · [Report a failed test workflow on the base branch (off by default)](#report-a-failed-test-workflow-on-the-base-branch-off-by-default) · [GitHub token redaction](#github-token-redaction) · [Post-merge retrospectives](#post-merge-retrospectives) · [On-demand preview (socket activation)](#on-demand-preview-socket-activation) · [Public entry for comment images: images and videos only](#public-entry-for-comment-images-images-and-videos-only) · [Prompt templates](#prompt-templates) · [Cleanup hook (`CLEANUP_HOOK`)](#cleanup-hook-cleanup_hook)
- **Running the daemon**: [File layout](#file-layout) · [Scheduler by OS](#scheduler-by-os) · [Running multiple projects](#running-multiple-projects) · [Scripted install, status and disconnect](#scripted-install-status-and-disconnect) · [Edit a project's settings from a script](#edit-a-projects-settings-from-a-script) · [Rename a flow label](#rename-a-flow-label) · [Remote access: let the client on another computer see this machine's daemon](#remote-access-let-the-client-on-another-computer-see-this-machines-daemon) · [Upgrading, migration, rollback, and development mode](#upgrading-migration-rollback-and-development-mode) · [Installations from before the rename](#installations-from-before-the-rename) · [Manual cron fallback](#manual-cron-fallback) · [Upgrading to webhooks (instant trigger)](#upgrading-to-webhooks-instant-trigger) · [Custom worker (not Claude Code)](#custom-worker-not-claude-code) · [Release cadence](#release-cadence)
- **When something goes wrong**: [Troubleshooting](#troubleshooting)

## Configuration (`cavil-loop.config`)

One file per project, at the host project root (`setup.sh` creates it and adds it to `.gitignore`). To get a project
running you set only a few lines: `REPO`, the paths (`PROJECT_ROOT`, `WORKTREE_BASE`, `STATE_DIR`), `WORKTREE_SETUP_CMD`
and the token; everything else has a working default. The full field list with comments is
[`cavil-loop.config.example`](../cavil-loop.config.example).

<details><summary>A typical config, commented</summary>

```bash
# GitHub
REPO="myorg/myrepo"

# Paths
PROJECT_ROOT="$HOME/github/myproject"
WORKTREE_BASE="$HOME/github/worktree/myproject"
STATE_DIR="$HOME/.local/state/cavil-loop/myproject"

# Logging: info by default; debug adds priority reads, greedy skips and review-cap details.
LOG_LEVEL="info"

# Naming
TMUX_PREFIX="myproject"          # tmux session: myproject-issue42
BRANCH_PREFIX="feature/issue-"   # branch: feature/issue-42
SESSION_NAME_PREFIX="issue"      # Claude session name: issue42

# Labels
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_AGENT_FABLE="pending/agent/fable"
FABLE_WORKER_AGENT="claude"
FABLE_MODEL="fable"
LABEL_PENDING_HUMAN="pending/human"
LABEL_AGENT_DOING="doing/agent"
LABEL_PENDING_PR="pending/PR"
LABEL_DONE="Done"

# Worker selection
WORKER_AGENT="claude"           # ordinary work; default
WORKER_MODEL=""                 # optional ordinary-worker model override
REVIEW_WORKER_AGENT="codex"     # cross-review; only used when review is enabled
REVIEW_MODEL=""                 # optional review-worker model override

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

# Second GitHub identity: GH_TOKEN polls/reads, this one does every write
# (label flips, the daemon's alert issue, the retrospective push, and the token
# handed to the worker). Empty = reuse GH_TOKEN (one account does everything). Keep this file 0600 when it holds a token.
# WRITE_GH_TOKEN=""

# Auto-cleanup after merge (worktree + tmux)
AUTO_CLEANUP_ON_MERGE=true

# PRs waiting at pending/human that start conflicting with their base.
# Checked only when the base or the PR head moved. Updated within N days → one
# comment + back to pending/agent for the worker to resolve; older / forks →
# one reminder comment, label unchanged. 0 = remind only, never auto-fix.
PENDING_HUMAN_CONFLICT_CHECK=true
PENDING_HUMAN_CONFLICT_AUTOFIX_DAYS=2

# Project-level cleanup hook (release ports, tear down tunnels, push metrics)
CLEANUP_HOOK=".agents/skills/cavil-loop/cleanup-hook.sh"

# Pace
MAX_CONCURRENT_WORKERS=1

# How often the scheduler wakes the poller. setup.sh writes it into the systemd
# timer drop-in / launchd plist, so it takes effect after re-running setup.sh.
POLL_INTERVAL_SECS=60

# Idle backoff: `<quiet seconds>:<poll interval seconds>`, comma separated. A
# project nobody has touched for that long polls at that interval. Empty string
# turns the whole feature off (idle AND failure backoff).
POLL_BACKOFF_LADDER="86400:300,259200:600,604800:1800"
# Force a full poll if this long has passed since the last successful GitHub
# read, whatever the ladder or the local state says.
POLL_FORCE_SYNC_SECS=1800
# Idle probe: while backed off, each tick first sends one
# conditional request (free when the answer is 304); if the repo changed, a full
# poll runs now. false turns it off. While on, full polls are at most this far apart.
POLL_IDLE_PROBE=true
POLL_IDLE_PROBE_MAX_SECS=600
# Failure gets its own ladder (starts at POLL_INTERVAL_SECS, doubles each time,
# capped here) and never
# advances the quiet timer: "cannot read GitHub" is not "nothing to do".
POLL_FAIL_BACKOFF_MAX_SECS=1800
# Slack for timer jitter, so a 60s tier is not stretched into 120s.
POLL_DUE_SLACK_SECS=10

# Give up on an item after this many consecutive dispatch failures: the daemon
# strips its trigger labels and hands it to pending/human. A failed dispatch
# changes nothing on its own, so without a cap the next poll simply tries again
# forever (and a bot account re-dispatching in a loop can get suspended by GitHub).
# Counters live in $STATE_DIR/dispatch-fail/ and reset on success and on escalation.
DISPATCH_MAX_RETRIES=3
# Same idea for self-heal: how many times a worker whose tmux session died may
# be auto-redispatched before the item goes to pending/human instead.
SELFHEAL_MAX_RETRIES=3

# An item on doing/agent whose session is alive but nobody is working: the agent
# is idle and nothing changed on GitHub or the local branch for this many seconds in a row →
# nudge the session once; still nothing STEP_GAP seconds later → end the session, put the
# trigger label back and redispatch (at most MAX_RESTARTS times); stuck again → comment and
# hand to pending/human. Script checks only, no model call. Empty or 0 = off; so is a config
# without this line.
STUCK_WORKER_QUIET_SECS=1800
STUCK_WORKER_STEP_GAP_SECS=900
STUCK_WORKER_MAX_RESTARTS=1

# Open an issue when the local base falls this many commits behind origin
# (auto-closed once it catches up). Off by default — only a checkout people
# actually work in gets stuck this way. 20 is a good value when you want it.
CHECKOUT_STALE_ALERT_COMMITS=0

# 1 = when a PR's branch is held by this project's own main checkout, and that
# checkout is clean, has nothing in progress and matches the PR's latest commit
# exactly, switch it back to BASE_BRANCH and carry on (comments on the PR).
# Off by default: it relaxes "the daemon never touches your working tree".
AUTO_RELEASE_MAIN_CHECKOUT=0

# What counts as actionable: label = only pending/agent items; greedy = every open item
# unless a blocking label stops it
DISPATCH_MODE="label"
GREEDY_SKIP_LABELS=""            # extra blocking labels for greedy (comma-separated)
LABEL_PENDING_LATER="pending/later"  # parked: never picked up automatically (greedy / autopilot); line missing = on, empty = off
GREEDY_SCAN_LIMIT=100

# Where sort key #1 comes from: label = priority/p* labels; project = GitHub's Priority
# field; both = the field where set, labels as fallback
PRIORITY_SOURCE="label"
PROJECT_PRIORITY_FIELD="Priority"
PROJECT_NUMBER=""                # empty = first board linked to this repo
PROJECT_OWNER=""                 # only when the board's owner differs from the repo's
PROJECT_GH_TOKEN=""              # token used only for the board read; empty = reuse GH_TOKEN
AUTO_ADD_PROJECTS=""             # add this repo's issues / PRs to these projects ("myorg/4 myorg/11"); empty = off
CI_FAILURE_REPORT_WORKFLOWS=""   # report a failed test workflow on the base branch ("tests.yml"); empty = off
# WRITE_GH_TOKEN=""              # token used for every WRITE; empty = reuse GH_TOKEN
```

</details>

## Queue order when the pool is full

When more items carry a pending label than there are free slots, the daemon puts issues and PRs into **one pool**
and takes them in order of three keys: priority label, then stage, then waiting time. Priority labels come from
`PRIORITY_LABELS` (default `priority/p0,priority/p1,priority/p2`); leave it empty to sort by stage and waiting time
only.

<details><summary>The three sort keys</summary>

| Key | Rule | Why |
|---|---|---|
| 1. priority label | Earlier in the list wins; **items marked nowhere sort last**, behind every marked one | You never label routine work — only tag the urgent one with `priority/p0` to jump the queue |
| 2. stage | review bounce-back < resumed work < brand-new issue | In-flight work already burned tokens and still has warm context, so finishing it frees a slot sooner; a brand-new issue has no sunk cost |
| 3. waiting time | oldest `updatedAt` first | Breaks ties within the same priority and stage |

</details>

<details><summary>What sorting does not change, and the log line</summary>

Sorting changes **order only**, never eligibility: busy sessions are still not interrupted, the concurrency cap still
applies, and label semantics are unchanged. Each cycle logs the resulting order to `poll.log`, so it is obvious who
jumped whom:

```
派工队列 4 项，按「优先级/阶段/等待」排：issue#A(p0,全新) PR#B(p2,review打回) issue#C(p2,全新)
```

When one item carries several trigger labels, the first match still wins in the order `pending/agent/fable` →
`pending/agent` → `pending/review`, independent of the sort.

</details>

### Sourcing sort key #1 from a GitHub Project field

`PRIORITY_SOURCE` decides where key 1 is read from: `label` (default), `project` (the Priority field of a GitHub
Project), or `both` (the field where set, labels as fallback). Reading a project needs the `read:project` scope; when
the board cannot be read, the daemon logs a warning and falls back to label ordering for that poll.

<details><summary>The three values of <code>PRIORITY_SOURCE</code></summary>

| Value | Key 1 comes from | Items with no value |
|---|---|---|
| `label` (default) | the labels in `PRIORITY_LABELS` | sort last, behind every marked item |
| `project` | the native issue field, else a Project v2 single-select (default name `Priority`) | sort last, **labels ignored** |
| `both` | the priority field value where set, label as fallback | neither set → sorts last |

**Tier order is not restated in config** — it follows the order the options are defined in on the project, so
reordering there is the only edit. `PROJECT_NUMBER` picks the project; empty means the first one linked to this repo.

</details>

<details><summary>Why PRs fall back to labels: Priority is an issue field</summary>

GitHub's Priority is an **issue-level field, not a board field** — even though it shows as a board column and is
clickable under the project's field settings (`/projects/N/settings/fields/<id>`). Measured behaviour:

| Read path | What you get |
|---|---|
| Projects API `field(name:"Priority")` | a `ProjectV2SingleSelectField` whose **options are empty** (same databaseId as the settings URL, while the UI shows Urgent/High/Medium/Low) |
| Projects API item values | typed `ProjectV2ItemIssueFieldValue`, not a single-select value → `fieldValueByName` reads nothing |
| Issue API `issue.issueFieldValues` | ✅ both the value and the option order |
| Control: `Status` (a real board custom field) | options come back normally (`Backlog/Preparing/…`) |

So the daemon tries the native issue field first, then a genuine board single-select. Only the latter can be set on
PRs — PRs have no native issue fields — so while the native field is in use, PRs always fall back to label ordering.
Each poll logs which one it used.

</details>

<details><summary>How the board is chosen</summary>

| `PROJECT_NUMBER` | Lookup | Must the board be linked to the repo? |
|---|---|---|
| set | direct by `<PROJECT_OWNER, number>` (tries organization, then user) | no |
| empty | the lowest-numbered project **linked to this repo** | yes |

The number is the last path segment of the board URL (`github.com/users/<you>/projects/7` → `7`). `PROJECT_OWNER`
defaults to the repo owner and **must be set when the board lives under a different owner** — a personal board holding
cards from org repos is the common case. The automatic lookup pins `orderBy=NUMBER ASC` rather than trusting the
API's unpromised default order (with two boards linked, that default could reshuffle priorities between polls). Every
poll logs which board it actually used: `Project 优先级：读到 12 条（看板 7 board7，字段 Priority，source=both）`.

</details>

<details><summary>⚠️ Permissions needed to read a project</summary>

Projects v2 is GraphQL-only.

- a classic PAT must carry **`read:project`** (tick it on the existing token at <https://github.com/settings/tokens>;
  no need to mint a new one)
- a **user-owned** project (`github.com/users/<you>/projects/N`, not an org one) also requires that account to be a
  collaborator on the project — a bot account is not one by default
- to avoid touching the bot's permissions, put a board-reading token in `PROJECT_GH_TOKEN` instead

If any of that fails the daemon **logs one warning and falls back to label ordering for that poll** — dispatch never
stops over a board it cannot read:

```
⚠️ Project 优先级读取失败，本轮回落到 label 排序：{"errors":[{"type":"INSUFFICIENT_SCOPES",...
```

Once the scope is granted the next poll logs `Project 优先级：读到 N 条（字段 Priority，source=both）` instead.

</details>

## Model-selecting trigger labels

`pending/agent` dispatches with the worker CLI's default model; `pending/agent/fable` dispatches the same workflow
through Claude Code with `--model fable` (`FABLE_MODEL`; the alias resolves to the newest Fable release). The override
applies to that one dispatch only, works for issues and PRs, fresh and resumed sessions, and does not change the
project's default worker. If both labels are present, `pending/agent/fable` wins.

<details><summary>Which model a resumed Claude session gets</summary>

With no model override, a resumed Claude session is still passed an explicit `--model`: `claude --continue` /
`--resume <id>` alone keeps the model the session was *started* with, so a long-running issue would never move to a
newer default. The daemon asks Claude itself which model a fresh session would get: right before resuming it runs
`claude -p --no-session-persistence --strict-mcp-config --output-format stream-json` in the worktree with the same
`CLAUDE_EXTRA_FLAGS`, reads the model from the first `system/init` line, and kills the probe. `ANTHROPIC_BASE_URL`
points at a closed local port for the probe, so no API request leaves the machine. Settings precedence (env, managed,
`--settings`, git-worktree local files, `--setting-sources` …) is therefore Claude's own, not re-implemented here.

</details>

<details><summary>When the probe adds nothing, and what it costs</summary>

- `CLAUDE_EXTRA_FLAGS` already containing `--model`, or unparseable (unbalanced quotes) → no probe, nothing added.
- The probe must see exactly the arguments the worker gets from bash. The flags are never `eval`ed; they are split by
  a whitelist tokenizer that only accepts what bash splits unambiguously: plain `[A-Za-z0-9-_=+.,:/@%]`, single
  quotes, double quotes without `$` / backtick / backslash, and a word-leading `~` / `~/…` (expanded to `$HOME`).
  Anything else outside quotes — `\`, `$`, backtick, globs, braces, `;&|<>()!#`, a non-leading `~`, `~user` — means
  no probe and nothing added (logged). The test suite checks the accepted forms against bash's own splitting.
- The time limit uses only bash builtins (no coreutils `timeout`, which macOS lacks); a probe ignoring TERM is killed
  after 2 more seconds.
- The probe fails (no `init` within `CLAUDE_MODEL_PROBE_TIMEOUT`, default 20s; `claude` missing) → nothing added, the
  session keeps its model, and the poll log says so.
- It costs ~3–4s per resume and runs the project's `SessionStart` hooks once. If your settings set
  `ANTHROPIC_BASE_URL` themselves (or you use Bedrock/Vertex), the probe's request is not blocked: it is killed right
  after `init`, but one request may already be in flight.

</details>

<details><summary>Live sessions, restarts and self-heal</summary>

- A session that is still alive when a new comment arrives gets the prompt injected and keeps its model until it is
  restarted.
- The daemon stores the selected worker and model in tmux (`@worker_agent` and `@worker_model`) and keeps the model in
  `state.json`. If an existing idle session uses a different worker or model, it is restarted and resumed with the
  requested selection.
- Self-heal restores the same model-specific pending label after a worker crash.

</details>

## Waiting on another item: `pending/blocked`

When a worker's work is blocked on **another issue / PR** (not on a human decision), it records the
prerequisites and puts `pending/blocked` on instead of `pending/human`; the daemon puts the item
back in the queue once they are all done. On by default: a config without the
`LABEL_PENDING_BLOCKED` line uses `pending/blocked`; `LABEL_PENDING_BLOCKED=""` turns it off.

<details><summary>The label itself</summary>

A repository that does not have the label yet still works — GitHub creates it (grey, no
description) the first time it is put on an item; rerunning `setup.sh` does not recolour a label
that already exists, change its colour on the repository's Labels page if wanted.

</details>

<details><summary>What the daemon does each round</summary>

Every poll round the daemon looks at items carrying the label:

| Prerequisites | Daemon does |
|---|---|
| all done (issue closed as *completed*, PR merged) | one comment, removes the label, adds back the trigger label the marker names (default `pending/agent`) — the next round dispatches it |
| one ended otherwise (closed *not planned* / *duplicate* / no reason, PR closed unmerged, unreadable 404) | comment naming it, `pending/human` |
| one in a trusted repo cannot be read: 404 / 410 (does not exist, deleted, or a private repo the polling token may not read — GitHub answers 404 for that too) or a 403 that is not a rate limit | comment naming it and saying how to grant read access, `pending/human` |
| none can be found, or one lives in another repo that is not on the trusted list (`TRUSTED_REPOS`) | comment (how to add the repo to the list), `pending/human` |
| some still open | nothing |
| GitHub cannot be read (error, missing field; for another repo also a rate limit, network error or 5xx) | nothing; looks again next round — never treated as done |

</details>

<details><summary>Where the prerequisites come from</summary>

The union of two places:

- the issue's native *Blocked by* relationship (sidebar → Relationships; GitHub accepts only
  issues as the blocker, a PR returns 422 "Target issue may only be an issue");
- the latest hidden marker `<!-- agent-blocked-by: #12 OWNER/REPO#N resume=pending/agent -->` posted by the loop's write account or a
  maintainer (`OWNER` / `MEMBER` / `COLLABORATOR`) strictly after the label was last removed — GitHub timestamps are whole
  seconds, so a marker in the same second as that removal cannot be told apart and is treated as the previous round's.

`#12` means this repo; `OWNER/REPO#N` another repo, see below (this repo's own full name, any case,
counts as `#12`). Free text such as "waiting on #12" is never read. `resume=` must be one of the
configured trigger labels, otherwise the default one is used.

Which marker counts is decided in `_lib.sh` `blocked_mark_pick`; the desktop client's dependency
graph reads the same marker by the same rule to draw its arrows (both run one shared set of
cases), except that the client does not know the loop's write account and only accepts markers by
`OWNER` / `MEMBER` / `COLLABORATOR`. The client setting "等前置的标签" must match
`LABEL_PENDING_BLOCKED` here.

</details>

<details><summary>Prerequisites in another repo</summary>

With `TRUSTED_REPOS` set, the marker may say `owner/repo#N` and that repo's *Blocked by* entries
count too; the daemon reads their state there, with the same notion of done. A bare `#N` always
means this repo, so an item here with the same number never triggers it. Repos not on the list go
to a human with a comment saying how to add them — with the list empty that is every
`owner/repo#N`. Another repo is only ever read, with the polling identity — the daemon never writes
there; a private repo needs that token to have read access, otherwise it answers 404 and the item
is handed to a human naming the prerequisite and the token's missing access.

An autopilot PR says `Closes #N`, so the merge closes the issue and waiting on an autopilot issue
means waiting for its merge; only for an autopilot PR that says `Refs #N` does the issue stay open
until a human closes it — to continue as soon as that code is merged, name the PR as the
prerequisite.

</details>

<details><summary>Recovering after a hand-off, and stopping it</summary>

**Recovering after a hand-off**: the daemon's comment lists the steps — fix the prerequisites
(remove the failed one from *Blocked by*, add the new one, or post a new marker for a PR),
**remove `pending/human`**, put `pending/blocked` back. While `pending/human` is still on, the
daemon treats the item as stopped and never resumes it.

**Stopping it**: add `pending/human` (or any flow label — `doing/agent`, `pending/PR`,
`pending/review`, a trigger label…) and the daemon leaves the item alone. Putting a trigger label
on by hand dispatches it as usual and the dispatch removes `pending/blocked`. Greedy dispatch,
self-heal and autopilot's "label only" pickup all skip items carrying it.

</details>

<details><summary>Before writing, and retries</summary>

Before writing the daemon reads everything again and decides a second time; if anything differs
(a new prerequisite, the label removed and put back, `pending/human` added, a prerequisite
reopened) it writes nothing this round. Progress is kept in `state.json` → `blocked_resume` (only
while the feature is on) so a retry after a failed label write does not post the comment twice;
after `BLOCKED_MAX_TRIES` failed attempts it gives up, logs, and leaves the item on
`pending/blocked` for a human.

</details>

<details><summary>Timing and limits</summary>

While an item is waiting, the poll interval is capped at `BLOCKED_RECHECK_SECS` (300 s), so a
finished prerequisite is usually picked up within about 7 minutes. *Noticing* a newly labelled item
still follows the idle backoff — in a project that has been quiet for a week a hand-added label can
take up to ~30 minutes to be seen (the worker's own label is seen within a minute, the project
having just been active). `rm poll-pace.json` brings polling back to full speed.

"Merged" is not "deployed here": when the prerequisite is a change to this loop itself, the resumed
worker checks the locally deployed version before relying on it. Not supported: prerequisites on
other hosts than github.com, cycle detection (two items waiting on each other both stay waiting).

</details>

## Parked for later: `pending/later`

For items a human has decided not to work on for now: the daemon never picks up an item carrying
it on its own, but a trigger label still dispatches it. On by default: a config without the
`LABEL_PENDING_LATER` line uses `pending/later`; `LABEL_PENDING_LATER=""` turns it off. To resume
a parked item, a human removes `pending/later` (greedy mode picks the item up next round) or adds
`pending/agent`; the daemon never removes it.

<details><summary>What the daemon does with a parked item</summary>

| Item | Daemon does |
|---|---|
| carries only the parked label (greedy mode's catch-all pass) | skips it, no dispatch |
| carries the autopilot label + the parked label (autopilot's "label only" pickup) | skips it, no dispatch |
| carries the parked label and someone adds a trigger label (`pending/agent` …) | dispatches as usual — it only stops the automatic pickup; a trigger label is an explicit "go" |

It is not "waiting for a human": the client's "等人处理" (waiting for a human) count does not
include it; carrying a label, it also leaves the client's "未处理" (untriaged) list.

</details>

<details><summary>Creating the label, and finding parked items</summary>

**Creating the label**: put the line into the config and rerun `setup.sh`, which creates the labels
the config names; or create it on the repository's Labels page.

**Finding parked items**:

| Looking for | Repository Issues page | GitHub Project view | Desktop client |
|---|---|---|---|
| Parked | `label:pending/later` | `label:pending/later` | `label:pending/later` |
| In progress, parked ones left out | `is:open -label:pending/later` | `is:open -label:pending/later` | `is:open -label:pending/later` |

</details>

## Auto-add issues / PRs to GitHub Projects (optional, **off by default**)

Every poll, the daemon adds this repository's issues and PRs to the GitHub Projects you list — useful because GitHub
Free allows only **one** auto-add workflow per project, watching **one** repository
([GitHub docs](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/adding-items-automatically)).
Off while the setting is empty; to collect several repositories on one board, set this in each repository's config:

```bash
AUTO_ADD_PROJECTS="myorg/4 myorg/11"   # "<org or user>/<number>", space or comma separated
```

<details><summary>Which items get added</summary>

| Item | Added? |
|---|---|
| Open issue / PR (however old) | yes |
| Closed / merged, **created after** the project was first synced here (e.g. opened and closed while the daemon was down) | yes |
| Closed before the project was first synced, even if someone comments on it later | no |
| An old item that gets reopened | yes (it is open again) |
| Already on the board (archived cards included) | no write request |

Owner names are case-insensitive, like on GitHub: `MyOrg/4` and `myorg/4` are the same board and share one sync
record, so changing the spelling keeps its progress.

</details>

<details><summary>It only adds — removed cards can come back</summary>

It only adds — no field edits, no removals. **It does not remember removals**: an already-synced board looks at items
updated since 10 minutes before its last sync, so a card someone removes by hand comes back if that item is updated
again, or if it was itself updated within those 10 minutes (the overlap that keeps updates landing mid-poll from
being missed). Older items are not touched — a new board's full scan does not push them back into a board that is
already in sync. There is **no per-item exclusion**: closing an item does not keep it off — an item created after the
board started syncing stays a candidate when closed or merged (that is how items opened and closed during downtime
get added). Removing the board from `AUTO_ADD_PROJECTS` stops auto-adding to that board **entirely**, for every item.

</details>

<details><summary>Permissions</summary>

Reads go through `PROJECT_GH_TOKEN` (else `GH_TOKEN`); the add is a write and goes through `WRITE_GH_TOKEN` (else
`GH_TOKEN`). The write identity needs the **`project`** scope (classic PAT) or write access to the project
(fine-grained). If the read identity cannot see a project, nothing is written to it — otherwise every item would look
"missing" and be re-added every poll.

</details>

<details><summary>Failures, state file and request cost</summary>

A wrong entry (`foo`, a number that does not exist), a read failure or a write failure logs **one** warning (repeated
only when the message changes) and is retried next poll; dispatch and cleanup are unaffected, and each project is
judged on its own: a new board whose first full scan fails does not hold back a board that is already in sync.

```
⚠️ 自动加入 Project：myorg/11：写入失败（写身份需要能写这个 Project）：issue #12 加不进去：Resource not accessible by personal access token，同步时间不推进，下一轮重试
自动加入 Project：myorg/4 已加入 3 条
```

State lives in `$STATE_DIR/project-auto-add.json` (one entry per project, deliberately not in `state.json`): when
this project was first synced, whether its first full scan finished, and the last fully successful sync. The
first-sync time is written on the first attempt and never changes. Deleting the file starts every project over (the
"created after" cut-off then moves to now). Requests: one combined read per poll when nothing changed; adding a second
project does not double it.

</details>

## Optional cross-review gate (**off by default**)

A second agent reviews a worker's code before a human sees it. Off by default: with
`LABEL_PENDING_REVIEW` unset the stage does not exist and the built-in prompts never mention
review. Set it and a worker that **produced code** flips to that label instead of `pending/human`;
the daemon then dispatches `REVIEW_WORKER_AGENT` (`codex` by default) with
`prompts/review.template.md` in its own session. Pass → `pending/human`; fail → bounced back to
`pending/agent` with concrete feedback. Leave it empty to turn the gate off.

<details><summary>Flow</summary>

```
pending/agent ──claude──> code or design doc? ──no──> pending/human  (questions,
                              │yes                                    blocked runs)
                              ▼
                        pending/review ──codex──> pass ──> pending/human
                              ▲                    │fail
                              ├────────────────────┘  (back to pending/agent)
                              │
                              └── rounds exhausted ──> pending/review + pending/human
```

</details>

<details><summary>"Waiting for a human" has two states</summary>

They are told apart by the label combination:

| Labels | Meaning | What the human does |
|---|---|---|
| `pending/human` alone | Reviewed and ready | Accept / merge |
| `pending/review` + `pending/human` | Round cap hit; the two agents never converged | Read the summary comment and decide |

In the second state the daemon **never dispatches the item**, wherever it sits in the
queue (`poll.log` records why it was skipped). Removing `pending/human` by hand is how you
say "keep reviewing, my way": that `unlabeled` event pushes the reviewer's "last human
action" timestamp forward, the round counter resets to zero, and the next cycle reviews
normally.

</details>

<details><summary>Design proposals through the gate: <code>REVIEW_DESIGN_PROPOSALS</code></summary>

Whether design proposals go through the gate too is a separate switch, `REVIEW_DESIGN_PROPOSALS`
(default `false`). Off, only code goes to review and a design proposal (or a revised one) flips
straight to `pending/human`; set to `true` with `LABEL_PENDING_REVIEW` configured, a proposal
flips to the review label and reaches you only after review. The switch alone, without a review
label, still hands to you. Clarifying answers and questions are unaffected.

Projects that route proposals to review from their own `new-issue.extra.md` /
`issue-comment.extra.md` ("flip `${LABEL_REVIEW_OR_HUMAN}`") keep working with the switch on or
off: the extra rules come after the generic template and win on conflict, and
`${LABEL_REVIEW_OR_HUMAN}` does not depend on the switch. To move from that to the switch: deploy
a version that has the switch, turn it on on every machine running the project, and only then
delete that line from the extra rules — in the other order, proposals go straight to you for a
while.

</details>

<details><summary>How the reviewer works</summary>

- The reviewer starts from a **fresh context** and reviews the artifact, not the
  implementer's narrative — that is the whole point of a second pair of eyes
- **Two kinds of output are gated — code and design proposals — each with its own checklist.**
  Reviewing a design means checking whether the stated root cause holds, whether the design
  actually addresses it, and whether the acceptance criteria are verifiable; having no code
  yet is normal and must not be treated as a failure (a reviewer that applies the code
  checklist to a design-only issue can only report "no implementation to review")
- **A failed design review means "revise the design", not "go implement it".** The bounce
  lands on the same `pending/agent` queue as a human saying "design looks good, go build it",
  so the reviewer has to spell out which one it is — otherwise the next worker implements a
  proposal no human ever approved
- **Unticked checkboxes are not a defect.** The convention is one tick = decided, none =
  the stated default applies, several = let's discuss — so "the human hasn't ticked" already
  *is* a decision. A reviewer that reads it as "missing human confirmation" bounces work that
  was ready; what it should review instead is whether the default is the right one
- Other text-only exits (questions, clarifications, blocked runs, security stops) still go
  straight to `pending/human`; gating those would burn a review on "I have a question for
  you" and slow down your answer
- **A review verdict comment's heading starts with the verdict**: `## ✅ …` when it passes,
  `## ❌ …` for everything else (bounced back, rounds exhausted, conflicts with the base
  branch, check could not run) — readable at a glance in a phone's notification list

</details>

<details><summary>Round cap: <code>REVIEW_MAX_ROUNDS</code></summary>

`REVIEW_MAX_ROUNDS` (default 6) exists solely to stop two agents from bouncing work forever, so
**a review a human explicitly asked for is exempt**: a human applying the review label bypasses
the cap outright, and a human comment restarts the count from that comment. Detection compares
the actor against `gh api user`, so no guessing at comment intent. Rounds are counted from
`<!-- codex-review-round -->` markers posted *after the last human action* rather than
`state.json`: visible on the board, survives state loss.

</details>

<details><summary>Labels and self-heal</summary>

- **Bounce-backs must target the default `pending/agent`**, not the review label itself —
  templates get it via the `${LABEL_PENDING_AGENT_DEFAULT}` placeholder. Getting this wrong
  is an infinite loop
- Self-heal routes a dead session back to **the queue that dispatched it** via
  `worker_trigger_labels` in `state.json`; inferring from the model cannot do this (the
  review gate swaps the agent, not the model)

</details>

### Review converges: everything in round one, then only the fixes

The reviewer lists every problem in the first round, and from round 2 on checks that list and the
fix instead of reviewing everything again. Always on with the review gate: the reviewer's prompt
always carries this section (`prompts/review-converge.md`, appended by the common prompt assembly,
so projects that replace the whole review template get it too).

<details><summary>Full round, re-check round, and the decision order</summary>

- **Full round** — the first round after the last human action, or any round whose baseline
  cannot be worked out: requirement, diff (or the whole proposal), tests and docs in one pass;
  every problem listed and numbered "problem 1", "problem 2", … kept across rounds — never `#1`,
  which GitHub turns into a link to issue 1 (a list written with `#N` earlier is read as problem N).
- **Re-check round** — from round 2 on, when the baseline is usable: the list is checked item by
  item (fixed / not fixed / the worker's reason for not changing it holds or not), new problems
  *inside the fix* are numbered and can bounce, and the always-blocking checks still cover the
  whole PR.
- **One decision order per problem**, stopping at the first step that gives an answer:
  ① always blocks — failed or cancelled checks, a conflict with the base branch, an applicable
  hard rule broken, a security boundary crossed, data deleted or corrupted (no project rule can
  lower this); ② grade it from the project's review extra → `REVIEW.md` → the built-in split
  (wrong behaviour / data / tests = must fix; wording, naming, readability = suggestion) — a
  suggestion never bounces, it is listed in a fold; ③ full round, or inside the fix → bounce;
  ④ a must-fix found late, outside the fix → on an ordinary item it is written under "needs your
  attention" and does not bounce (the human decides before merging); on an autopilot item it
  bounces, since nobody reads the note before the daemon merges.
  Every checklist item the review template already says must fail the review (the hard rules, a
  code name in a question for the human, "you" / "I" for a party, the hand-off layout items, a
  conflict, the design-review points) is a must-fix, never a suggestion; and what the worker wrote
  this round (comments, the proposal, the PR body) is always inside the review's scope, so those
  bounce at step ③ and never reach step ④.
- The round marker keeps its format (the weekly report reads it); the line after it is a hidden
  baseline the next round computes the fix from (only the first two lines of a verdict comment
  count — a marker quoted anywhere else is ignored):
  `<!-- review-baseline: code head=<sha> base=<branch> -->` or
  `<!-- review-baseline: plan comment=<id> sha256=<fingerprint> -->`.

</details>

<details><summary>What "the fix" is: <code>review-scope.sh</code></summary>

What "the fix" is comes from `scripts/review-scope.sh` (managed entrypoint
`entrypoints/review-scope.sh`, read-only). It reads the latest review verdict posted by the
dispatch account, and checks top to bottom, stopping at the first match:

| # | Code | Output |
|---|---|---|
| 1 | round 1 after the last human action | `full first-round` |
| 2 | reading the comments / the PR failed | `full read-failed` |
| 3 | no baseline line, or a malformed one | `full no-baseline` |
| 4 | the PR's base branch differs from the baseline's | `full base-changed` |
| 5 | fetch failed, or the reviewed commit is not available | `full baseline-missing` |
| 6 | the reviewed commit is not an ancestor of the current one (rebase / force push) | `full history-rewritten` |
| 7 | the fork point with the base cannot be computed | `full read-failed` |
| 8 | merging "reviewed commit + fork point" conflicts (also when the PR resolved a conflict with the base this round) | `full merge-conflict` |
| 9 | that merge fails otherwise | `full read-failed` |
| 10 | comparing the merged tree with the current commit fails | `full read-failed` |
| 11 | no difference (only synced with the base, or no new commit) | `scope 0` |
| 12 | a difference | `scope <files>` + the diff |

The merged tree is `git merge-tree --write-tree <reviewed commit> <fork point>`: what the reviewer
saw last round plus whatever the base brought in since, so a plain merge of `main` into the branch
is not counted as part of the fix.

For a design proposal: round 1, an unreadable comment list or no baseline → full; the previous
proposal comment deleted (`deleted`), edited in place since (`edited`), the same comment as this
round's (`same-comment`), either comment not posted by the dispatch account (`not-own`) or not on
this issue (`not-this-issue`) → full; otherwise `scope` plus the diff from the previous proposal's
text to this one. The command only ever shows text the dispatch account posted on this issue itself
(the guarded read command shows such comments verbatim too); on an autopilot item everything else
is still read through the guarded read command. A proposal run also prints
`current sha256=<fingerprint>` and the full text of this round's comment, both from one read — the
reviewer reviews exactly that printed text, so the fingerprint is the version it saw — and the
baseline is written only through
`review-scope.sh fingerprint <id> --issue <N> --expect <that fingerprint>`, which refuses (exit 3)
when the comment was edited while it was being reviewed — then no baseline is written and the next
round is full.

On an autopilot item with the outsider guard on (`AUTOPILOT_OUTSIDER_GUARD`), every comment on the
item is read only through the guarded read command, so the review prompt carries no proposal mode
at all there: proposal reviews are full every round and write no proposal baseline. Code mode
reads no comments there either: the reviewer copies the second line of its own last verdict out of
the guarded read output and passes it with `--baseline-mark '<line>'`; when the guarded read
succeeds but holds no such line (or a malformed one), the round is full; when the guarded read
itself fails, that is not "no baseline" — the outsider rules apply (retry once, then hand to a human
with the command's error), and the review does not go on as a full round. Elsewhere code mode reads
the comment list only to find that line and never shows comment text.

Fingerprints use `sha256sum` or macOS's `shasum` (`scripts/_sha256.sh`, shared with the config
fingerprints); with neither, it is `full read-failed`. No output, a non-zero exit or any other
first line is treated as full.

</details>

<details><summary>A project's own review standard: <code>REVIEW.md</code></summary>

A project may put a `REVIEW.md` at its repository root: what its reviews look at, what counts as
must-fix, what is only a suggestion, what not to raise. The daemon reads it from `origin/<base>`
like the project prompt files, with three outcomes:

| `REVIEW.md` on the base branch | Review prompt | Worker prompts (new issue, issue comment, PR comment, split sub-issue) |
|---|---|---|
| present | gets the whole file | one line pointing at it |
| confirmed absent | nothing added | nothing added |
| unreadable (no remote ref, the tree cannot be listed, not a regular file) | "REVIEW.md could not be read: review in full, relax nothing" | says it could not be read |

A local copy in the main checkout is never used instead. This repository's own `REVIEW.md` holds
its test-evidence rules; its `review.extra.md` keeps the comment-writing rules.

</details>

## Autopilot label (optional, **off by default**)

With autopilot a maintainer hands one issue over end to end — design, code, review and merge — by putting a label on it;
an independent review checks each step and the daemon merges once fixed conditions hold. It is off by default: turn it on
by setting `LABEL_AUTOPILOT` (e.g. `autopilot`) together with the review gate `LABEL_PENDING_REVIEW`, which it requires;
turn it off by leaving `LABEL_AUTOPILOT` empty (see [Turning autopilot off](#turning-autopilot-off)). Issues without the
label are not affected, and with `LABEL_AUTOPILOT` empty nothing changes for a project that never turned it on.

<details><summary>Flow</summary>

```
issue: autopilot ──> design ──> pending/review ──pass──> pending/agent ──> code + PR
                                     │fail (revise)                              │
                                     └───────────────────────────────────────────┘
PR:  pending/review ──pass + test record──> pending/merge ──daemon checks──> merged
                                                  │ checks fail / conflict ──> back to the worker
                                                  └ anything else wrong ─────> pending/human
```

</details>

<details><summary>Starting it, the design phase and the code phase</summary>

- **Starting it**: the autopilot label alone is enough — an issue carrying it and no state / trigger label is
  dispatched as if it had `pending/agent`. It is a *mode* label, not a trigger: it is never removed and stays visible
  on the board.
- **Design**: still written and posted on the issue, multiple-choice questions use their defaults, and it always goes
  to review (whatever `REVIEW_DESIGN_PROPOSALS` says). A passing design review flips the issue back to `pending/agent`
  and the worker starts building.
- **Code**: a passing review flips the PR to `LABEL_PENDING_MERGE` (`pending/merge`) instead of `pending/human`, and
  the reviewer adds a machine line with its test re-run to the verdict comment:
  `<!-- autopilot-review-pass head=<sha> passed=<n> failed=<n> -->`.
- **Bounces back to the worker** are counted per PR and capped at `REVIEW_MAX_ROUNDS`.
- **Stopping it**: remove the label from the issue or the PR, or add `pending/human` to the issue or the PR. The
  re-read right before merging catches a stop that lands between the checks and the merge.

</details>

<details><summary>The PR carries the label too</summary>

Once an autopilot issue has a PR bound to it, the daemon copies the autopilot label onto that PR (checked every round,
so a failed write is retried). The PR list then shows which PRs will be merged automatically, and you can stop one right
on the PR by removing the label. The issue keeps its own label — that one is the authorization.

- The copy is added by the loop's write account and therefore **never counts as authorization**: it does not start a
  takeover, does not trigger the "label not accepted" comment, and a worker adding the label to its own PR gains nothing.
- Each add / remove is judged twice, the second time from fresh reads right before writing (PR open / merged, head
  commit, target branch, source repo / branch, bound issue and its state, `pending/human` on either side, the
  authorization event, and — for a removal — the exact label event of the copy); any change or unreadable field means
  no write this round.
- Once the authorization is definitely gone (label removed on the issue or PR, issue closed, PR no longer bound…) the
  daemon removes **its own** copy again; a label a maintainer added by hand on the PR is never removed.
- A bound PR is **not merged while it lacks the label**: that counts as an undecidable round, so
  `AUTOPILOT_UNKNOWN_MAX` rounds without it hand the PR to a human.
- Only PRs this machine works on are touched (same ownership rule as the merge step). After autopilot is turned off the
  copies are left in place (they do nothing; remove them by hand if you like).

</details>

<details><summary>Splitting into sub-issues</summary>

The split plan goes through review like any design, and once it passes the worker creates the sub-issues directly. The
reviewer also checks "does this really need splitting" and "is any work left on the parent outside the sub-issues" (on
autopilot the wrap-up becomes a sub-issue too).

- A sub-issue this tool created — really attached to the parent on GitHub, carrying the split marker that points at
  the parent, created by the loop's write account — **inherits the parent's autopilot**: neither the sub-issue nor its
  PR needs the label.
- Dispatch, takeover, adding the label to the PR and the merge permit all treat the parent as a third place under the
  same rule as issue + PR (the stop line is the latest removal across all three; the authorization is a maintainer's
  own add after it).
- Removing the label from the parent, adding `pending/human` to it or closing it stops every sub-issue; to stop just
  one, add `pending/human` to that sub-issue.
- The parent or its label history unreadable = undecidable: not dispatched this round, nothing written (never
  dispatched as a normal item).
- Once every sub-issue is closed the parent goes to `pending/human` for a human to close.

</details>

<details><summary>After the merge: the issue is closed and keeps <code>pending/human</code> as a reminder</summary>

An autopilot PR body says `Closes #N`, so merging into the default branch makes GitHub close the issue, and items waiting
on it (`pending/blocked`) start right away. After merging, the daemon comments on the issue — one visible line of
conclusion plus what the human needs to do; background / chosen approach / ruled-out approaches and why copied verbatim
from the summary section the worker wrote in the PR body (`<!-- autopilot-summary:begin -->` to
`<!-- autopilot-summary:end -->`), the merge evidence folded at the end — then adds `Done` and `pending/human` to the
closed issue and removes `pending/PR` and other flow labels.

- **When satisfied**, the human **only removes `pending/human`** (`Done` stays; a reminder added after the close and
  then removed is recognised from the event history and not added back).
- **For rework**: reopen the issue → remove `Done` and `pending/human` → add `pending/agent`.
- If GitHub has not closed the issue yet the daemon looks again next round; if a human reopened it before the
  hand-over, the "issue stays open" path applies (next fold).
- The hand-over writes one label at a time, judges twice from fresh reads of the issue and its event history before
  each write, and after each write requires the state, label set and the positions of the last close and the last
  `pending/human` add to be exactly "the previous reading + the step the daemon just wrote" (the only new event allowed
  is the daemon's own for that step) — anything else stops the round; unreadable = retried next round; the comment is
  de-duplicated by its marker.

**The closed-issue sweep keeps a reminder added after the close.** The pass that gives issues closed as completed `Done`
and strips their flow labels reads the event history — if the last "added `pending/human`" comes after the last
"closed", it is the post-close reminder and stays; one added before the close (a human closing an issue that sat on
`pending/human`) is removed.

- Order is the position in the event history, never the timestamp (closing on merge and adding the reminder often share
  a second).
- The history is read for every issue closed as completed, with or without `pending/human`; unreadable, an event without
  an id, or history that contradicts the labels (no "closed" event, or the state the history implies — last closed or
  reopened, reminder last added or removed — does not match what was read) → nothing written, retried next round.
- The sweep also writes one label at a time, judges twice before each write and checks the reading after each one: a
  reminder re-added or the issue reopened after the judgement stops the round instead of being overwritten, and nothing
  else in that poll round touches the issue again (the retry queue waits for the next round) — the same holds for any
  round that did not finish: unreadable, contradicting or a failed write.

**Finding what to look at:**

| Looking for | Repository Issues page | GitHub Project view |
|---|---|---|
| Waiting for a human (including closed after merge) | `label:pending/human` | `label:pending/human` (no `is:open`) |
| Still in progress | `is:open` | `is:open` |
| In progress + waiting for a human | `is:issue (is:open OR (is:closed label:pending/human))` | not expressible (no cross-field OR, no parentheses) |

The desktop client's default search `-Status:done -label:Done` hides these closed `Done` items; open them from the
"等人处理" (waiting for a human) count in the top bar. Same for a Project view whose filter has `-Status:done`: save a
separate view with just `label:pending/human`.

</details>

<details><summary>PRs that only reference the issue: the issue stays open</summary>

An autopilot PR whose body only says `Refs #N`, with no closing keyword, still merges, and GitHub does not close the
issue. After the comment the daemon flips the issue to `pending/human`, removing `pending/PR`; the human closes it when
satisfied (closing as *completed* adds `Done` as usual) or adds `pending/agent` for rework. A `Closes #N` PR merged into a
branch other than the default one (GitHub does not close issues then) takes this path too.

- If any flow label (dispatch, in progress, review, waiting, pending/human…) is already on the issue by the time of the
  hand-over, a new round has started: no label is touched, only the comment is posted if missing.
- Every write re-reads the issue first and writes nothing if its state or label set changed; unreadable = retried next
  round; the comment is de-duplicated by its marker.
- An autopilot PR merged by a maintainer by hand gets no special treatment: like any PR, the issue its `Closes #N`
  closed gets `Done`.

</details>

<details><summary>Trusted repos (<code>TRUSTED_REPOS</code>)</summary>

`TRUSTED_REPOS` is empty by default: comma-separated `owner/repo`. A listed repo

1. may hold the parent of a split sub-issue: a maintainer's own autopilot label on that parent authorizes this repo's
   sub-issue, and whoever added it needs write access in **both** repos;
2. may hold a prerequisite for "waiting on another item" (see "Waiting on another item" below).

Anything unreadable across repos (parent, label history, permission) is undecidable and nothing is written. Repos not on
the list are not trusted.

</details>

<details><summary>Putting the label on an existing PR (takeover)</summary>

For a PR that already exists, a maintainer can put the autopilot label on the **PR** itself and the daemon takes it
over: when, besides the autopilot label, the PR carries only `pending/human` (and the authorization came after it), or no
flow label at all while the PR itself carries the autopilot label, it moves the PR to `pending/review` with a short
comment, then the same review → merge path. PR-side autopilot covers only "review → merge"; the design phase still looks
at the issue only.

- The authorization may also come from the issue: after a PR was handed to a human for a removed label, a maintainer
  re-adding the label on the issue alone takes it over too.
- A PR that still carries `pending/agent` / `doing/agent` / `pending/review` / `pending/merge` (even alongside
  `pending/human`) is never taken over — that is work in progress, and its next dispatch carries the autopilot rules.
- When the PR-side label is not accepted (not added by a maintainer, the PR does not qualify, the issue is closed, the
  PR description did not qualify when the label was added) the PR gets one comment saying why.
- **Undecidable takeovers**: if the takeover cannot be decided for `AUTOPILOT_UNKNOWN_MAX` rounds (a round's verdict is
  its last decision, so the re-check right before writing counts too), the PR goes to a human (`pending/human` plus one
  comment), once. The hand-off is recorded as a pending task before anything is written. Its only basis is "cannot
  decide", so every attempt re-runs the same takeover decision from fresh reads:
  - still undecidable → carry on (label, then comment; a failed write or a killed process is picked up next round);
  - decidable now — a maintainer re-authorized, the PR was closed / merged / rebound to another issue / moved into
    another flow, the issue was closed — → drop the task without writing any of it and handle the PR through the
    normal takeover path. The one exception: the loop already added the `pending/human` for this task and only the
    comment is missing — then it posts the comment.
  - Both ways of carrying on require the issue / branch / source to match the ones recorded at decision time, and a task
    that already added `pending/human` is cancelled (no comment, no further hand-off until the takeover is decidable)
    once someone removes that label.
- **Takeover is judged twice too**: after deciding to take a PR over and right before writing, the same decision runs
  again from fresh reads (issue open, request origin, stops and authorization on both places, the PR's state / head /
  target / source / binding); if the verdict or identity changed, nothing is written this round.
- A PR judged "no takeover" is remembered by PR `updated_at` + bound issue number + that issue's `updated_at`, and is
  not re-read while all three are unchanged (adding / removing a label bumps `updated_at`); the merge permit never uses
  this cache. ⚠️ A change in the labeler's **permission** does not bump `updated_at`: a rejected PR is re-judged only
  once the PR or the issue changes.

</details>

<details><summary>PRs bound to no issue</summary>

For the other half of a cross-repo task, or any PR that does not bind to an issue, a maintainer's own autopilot label on
the PR is itself the authorization — even when added right after the PR is opened. The daemon sorts PRs three ways:

- **bound to an issue**: from this repo, branch exactly `BRANCH_PREFIX<N>`, body closes only `#N` — judged on the issue
  and the PR together;
- **PR-only**: from this repo and the body has **no** closing keyword for an issue of this repo — `#N`, `owner/repo#N`
  (this repo, case-insensitive), `https://github.com/owner/repo/issues/N` and `GH-N` all count; a plain `Refs #N` or
  closing another repo's issue does not — authorization and stops come from the PR alone: removing the label or adding
  `pending/human` on the PR stops it, no issue's label is lent to it, and an issue that merely shares the branch's
  number is ignored;
- **not eligible**: anything else (closes an issue of this repo without binding to it, an ambiguous closing line, a
  fork) — not accepted, with one comment on the PR saying how to fix it.

PR-only also requires the **PR description as it was when the label was added** to be PR-only:

- The daemon reads GitHub's edit history of the description (GraphQL `userContentEdits`) and takes the newest revision
  not later than the label event (revisions in the same second and the one before them must all qualify; both
  timestamps are GitHub's, so the local clock does not matter).
- Labeled in the same second the PR was opened and edited later: the oldest revision counts as the opening description
  only if its time equals the PR's creation time; otherwise (older revisions missing) it is "not found".
- So a label added while the body closed some issue, or while the PR was bound to an issue, does not count after the
  body is edited — a maintainer re-adds it after looking at the current PR.
- A deleted revision → not accepted, re-add; history unreadable or a page missing → undecidable, nothing written this
  round.
- Nothing about this is stored locally, so a new machine or a lost state file changes nothing.

Such PRs have no design phase — the takeover starts at code review — and the takeover and merge notes go on the PR.

</details>

<details><summary>Requests filed by the external requester bot</summary>

Authorization follows the same rule — who added the autopilot label, not who filed the request. None of the requester's
confirmations is skipped: after the proposal review passes, the bot is woken and the requester confirms as usual; in
report-first projects, once the requester approves the PR's head commit the PR goes to review, and the reviewer checks
the approved commit and reruns the tests before flipping `pending/merge`. With both features on, the dispatch prompt
gets one more section ("requests filed by the bot + autopilot") spelling this out; see
[Hooking up an external requester bot → Autopilot label](requester-bot.md#autopilot-label). An item whose waiting label
was removed early, with no dispatch label added afterwards, is neither started from the autopilot label alone nor taken
over ([What the daemon does while waiting](requester-bot.md#what-the-daemon-does-while-waiting)).

</details>

<details><summary>When the daemon merges: the checks</summary>

The daemon merges (`PUT /pulls/N/merge` with the reviewed sha, `AUTOPILOT_MERGE_METHOD`, `squash` by default) only when
every item below holds; it then comments "已自动合并" on the issue (on the PR when there is no issue) and the usual
post-merge cleanup / `Done` / retrospective take over:

| Check | Fails → |
|---|---|
| The PR is from this repo and either bound (branch `BRANCH_PREFIX<N>` exactly, and the body closes exactly `#N`, read per line and as a whole, both must agree, or references only one `Refs #N` with no closing keyword) or PR-only (the body has no closing keyword for an issue of this repo) | `pending/human` |
| PR-only: authorization comes from the PR alone (drop the issue side of the next row), and the PR description at label time (that revision in the edit history) also meets the previous row | `pending/human` |
| Authorization: the label is **currently on** issue `#N` or the PR, the last "added the autopilot label" event there was by a `User` with `write`/`admin` who is not the loop's write account and not `REQUESTER_BOT_ACCOUNT`, **and that event is later than every "removed" event on both the issue and the PR** (see "How the issue and the PR combine" below) | `pending/human` |
| The PR itself carries the autopilot label (for a bound PR the daemon copies it from the issue, see above) | undecidable this round (→ `pending/human` after `AUTOPILOT_UNKNOWN_MAX` rounds) |
| Nobody added `pending/human` to the issue or the PR | `pending/human` (PR-side `pending/human`: just drops `pending/merge`) |
| The PR head **and target branch** are the ones recorded when the review was dispatched (same commit retargeted to another branch = a different change; a record without the branch counts as missing) | back to `pending/review` |
| The reviewer's verdict comment (write account, after dispatch) carries the record for that commit with `failed=0`, `passed>0` | `pending/human` |
| No change under `.github/` — or, with `AUTOPILOT_HUMAN_PATHS` set, no change to any listed file, see below | `pending/human` |
| Every check run / commit status on that commit passed (none at all = rely on the record above) | failing → back to the worker; still running after `AUTOPILOT_CHECKS_TIMEOUT_HOURS` (6) → `pending/human` |
| GitHub says mergeable (no conflict) | back to the worker |
| Right before merging, the **same permit function runs again from fresh reads** — every row above, including the reviewer's test record (a comment can be edited or deleted) and the checks (red, re-running, or newly appeared); both runs must say "merge" for the same issue / commit / target | skip this round, record nothing |

</details>

<details><summary>When something cannot be read, and how a hand-over is written</summary>

**Can't read something** (events, permissions, checks, files, comments): nothing is written this round; after
`AUTOPILOT_UNKNOWN_MAX` (10) rounds in a row it goes to a human. "Can't read" is never treated as "authorized", "passed"
or "no conflict".

**Every write of a hand-over is checked against the current state first.** Handing a PR to a human takes three requests —
post the note → add `pending/human` → remove `pending/merge`. The daemon first takes a baseline (PR open / draft / head /
target branch / branch / source / body / all labels, the ids of "this queueing" and of the last label change in the PR's
label events; state, labels and label events of the bound issue and of a split sub-issue's parent), judges the reason
again from fresh reads, then confirms the baseline is unchanged; before each later write it judges the reason and compares
the state once more, allowing only the one write of its own it has just confirmed. If a maintainer closed the PR, touched
any label, pushed, changed the target branch, re-queued the same commit, or lifted a stop on the issue in between, nothing
more is written this round and the next round judges the PR as it then is.

- No local to-do is kept: a PR still in the merge queue is judged from scratch next round; a note for the same queueing,
  commit and reason is not posted twice (it ends with a hidden marker), and after the same commit is re-queued the old
  note no longer counts.
- If the note cannot be posted the labels are not flipped — never `pending/human` without a note.
- A PR carrying both `pending/human` and `pending/merge` (a maintainer's stop, or a hand-over cut short): only
  `pending/merge` is removed, silently, after the same baseline-and-compare. To keep a PR queued, remove `pending/human`
  first.
- State that cannot be read whole (PR, issue, any label history or the comments unreadable; an answer with a field
  missing or an unknown state word; a label event without an id, or events that contradict the current labels): nothing
  is written this round. So the "unreadable for N rounds" hand-over only gets written when these are readable (it works
  normally when what is unreadable is the changed files, checks or a permission); otherwise the PR stays queued and is
  retried every round — never merged, with the reason in the log.
- ⚠️ What cannot be closed: GitHub has no "write only if unchanged", so an action that lands between the start of the
  last check and the write reaching GitHub is not seen. The worst outcome is one more `pending/human` or one more note on
  a PR that was just closed or taken over, or `pending/merge` removed from a PR that was just re-queued. It never causes a
  merge.

</details>

<details><summary>How the issue and the PR combine</summary>

The stop line is the latest "removed the autopilot label" event on either the issue or the PR. Authorization comes only
from an "added" event **later than the stop line**, performed by a maintainer, on a place that still carries the label.
So:

- removing it in either place stops; a maintainer adding it again in either place resumes
- after a stop, the loop account, a Bot or someone without write access adding it does not resume, and cannot revive an
  older authorization from the other place
- with no removal at all, the worker adding the label to the PR does not affect the issue's authorization (it is neither
  an authorization nor a stop)
- a PR whose label was never touched gives the same result as looking at the issue alone; each decision reads the PR's
  label events once more
- order across the two places is by event time; when it cannot be told (missing time) the decision is "can't tell"
- for the takeover, every valid authorization is compared with the PR's `pending/human` — by event order on the PR, by
  time on the issue (the same second is not "later"); one provably later authorization is enough, and a same-second one
  on the other place does not hide it

</details>

<details><summary>Limits: the last window, repository rules, several machines, accounts</summary>

- **The window that is left** is between the last read and the merge request reaching GitHub. The merge request carries
  the reviewed sha, so a push in that window is refused by GitHub; a check that flips in that window is not. For a
  server-side guarantee on checks, mark them as required on the target branch (branch protection) — the daemon never
  bypasses it.
- **What GitHub refuses** (branch protection requiring approvals, merge method disabled) goes to a human — the daemon
  never works around repository rules.
- **Multi-host**: only the machine that dispatched the review holds the reviewed commit, so with
  `SELFHEAL_ONLY_OWN_WORKERS=true` the other machine's **merge step** leaves the PR alone. Ordinary dispatch and review do
  not check ownership, though, so a repo on autopilot should be polled by one machine only (see
  [Poll the repo from one machine only](#poll-the-repo-from-one-machine-only)).
- **Two accounts**: the loop's write account and the maintainer must differ, otherwise no label can count as the
  maintainer's (workers and the reviewer write as that account).
- **This repo deploys itself**: on `GigleAI/cavil-loop`, a merged `main` is activated on the daemon within minutes, so an
  autopilot merge here changes the running daemon with nobody in between. Turning it on here is a separate, deliberate
  decision.

</details>

<details><summary>Where the state is kept</summary>

State lives in `state.json` under `autopilot`:

- `prs.<n>`: reviewed commit / target branch / time, bounces, unreadable rounds, check-wait start, `off_handover` (the
  to-do of an autopilot-off hand-over still in progress; it carries its baseline, see "Turning autopilot off");
- `notices` / `denied`: one-time comments and rejected issues by their `updated_at`;
- `takeover` / `takeover_unknown` / `takeover_handoff`: PRs judged "no takeover" with their cache key, undecidable rounds
  during takeover, and hand-offs not yet finished (the values of `denied` and `takeover` carry a judging-rules revision,
  so after an upgrade that relaxes a rule the old records stop matching and each item is judged once under the new rule);
- `mirror`: PRs judged "nothing to copy / remove" with the same kind of cache key.

Like `requester_bot_done_queue` it is not in the migration loop and only appears once the feature does something.

</details>

### Files a human must look at before an autopilot merge (`AUTOPILOT_HUMAN_PATHS`)

Some files do not run code by being changed, but make code run later as the maintainer: CI workflows, git hooks, agent
configuration, install / build / environment files. With `AUTOPILOT_HUMAN_PATHS` set, an autopilot PR that touches a
listed file is not merged: it goes to `pending/human` with a note naming the files. Empty or not set (the default): only
`.github/` is refused, and nothing else changes.

To turn it on, add one line to the project's config; it takes effect on the next poll. To turn it off, delete the line
(or set it to `""`); PRs already handed to a human stay with the human.

<details><summary>Example lines</summary>

<!-- autopilot-human-paths:examples:begin -->
```bash
AUTOPILOT_HUMAN_PATHS="default"
AUTOPILOT_HUMAN_PATHS="default /systemd/ /launchd/ /setup.sh"
AUTOPILOT_HUMAN_PATHS="default /scripts/ /prompts/ /systemd/ /launchd/ /setup.sh"
AUTOPILOT_HUMAN_PATHS="default /setup.sh /scripts/check-commit.sh"
```
<!-- autopilot-human-paths:examples:end -->

</details>

<details><summary>What <code>default</code> contains and how an entry is read</summary>

- `default` expands to the built-in list: `/.github/` `.husky/` `.githooks/` `/.pre-commit-config.yaml` `/lefthook.yml`
  `.claude/` `.codex/` `.agents/` `.mcp.json` `.devcontainer/` `.vscode/` `package.json` `Makefile` `.envrc`. It can be
  mixed with more entries (second and third line above); a value without `default` uses only the entries written.
  `/.github/` is always on the list.
- **How an entry is read** (space- or comma-separated, the common part of `.gitignore`): a leading `/` means the repo
  root only (`/setup.sh` does not match `tools/setup.sh`); no leading `/` means any depth (`package.json` matches
  `client/package.json`); a trailing `/` means a directory and everything under it; `*` matches within one path
  segment. A renamed file is matched on both its old and new path.
- **Only paths are looked at, not content**: any change to a listed file (other than test files, see below) counts (a
  dependency bump in `package.json` too). Lock files and `AGENTS.md` / `CLAUDE.md` are not on the built-in list; add
  them if the project wants them.

</details>

<details><summary>Entries or file lists the daemon cannot read</summary>

- **An entry the daemon cannot read is never skipped**: no leading `/` but a `/` in the middle (`a/b.txt`), a `.` /
  `..` segment, an empty segment, `**`. Every autopilot merge of the project then goes to a human with a note naming the
  entry, until the config is fixed.
- **The file list must be read whole**: the number of files GitHub reports on the PR (`changed_files`) has to equal the
  number of entries read. Missing pages (the endpoint returns at most 3000 files per PR), a missing count, a malformed
  answer or a failed request all count as "can't read": no merge and nothing written this round, a human after
  `AUTOPILOT_UNKNOWN_MAX` rounds. "Can't read" is never "no hit".
- **Judged again before the hand-off**: after a hit (or an unreadable entry) the whole merge permit runs again from
  fresh reads; the verdict, the files hit and the PR's head / target branch / branch / bound issue must be the same,
  otherwise nothing is written this round. The hand-off itself is the same code every other autopilot hand-over uses:
  each of its three writes is preceded by a fresh judgement and a state check (see "When something cannot be read, and
  how a hand-over is written" above).

</details>

<details><summary>Test files do not count (<code>AUTOPILOT_HUMAN_PATHS_EXEMPT_TESTS</code>)</summary>

A file whose old and new paths are both test files is not matched against the list, so a PR that only changes test files
under a listed directory is merged as usual; in a PR that mixes them, only the other files are matched and named. A test
file is, by its path alone (one rule, `is_test` in `scripts/_human_paths.sh`):

- a file name of the form `<name>.test.<ext>` or `<name>.spec.<ext>` (any extension, `a.test.json` too; `a.test`,
  `test.mjs`, `a.tests.mjs` are not), or
- a file anywhere below a directory named `__tests__`;
- except anything under the repo root's `.github/`: GitHub runs every workflow there whatever its name, so
  `.github/workflows/ci.test.yml` is still a file a human must look at.

A renamed file counts as a test file only when both its old and its new path are test files. The change record of a file
whose new path is a test file must be complete: its status is one of GitHub's known words, and a rename / copy carries its
old path; otherwise the file list counts as "can't read" (no merge and nothing written this round, a human only after
repeated rounds), never as "no old path".

Not set, empty or `"on"` = test files do not count; any other value (`"off"`, a misspelling) = test files are matched like
any other file. The setting matters only when `AUTOPILOT_HUMAN_PATHS` is set. A limit to know: the rule looks at names,
not content — if something in the project already runs a particular test file as the maintainer on its own (a git hook or
an agent hook that runs it), set this to `"off"`. A project whose own review rules copied the file list should point to
this section instead of keeping a copy.

</details>

<details><summary>A hook that hands its work to a file outside the list</summary>

A common shape is a hook that is only a shell — `.githooks/pre-commit` contains `exec scripts/check-commit.sh` — with the
real check in a script outside the hook directory. That script runs on every commit as the developer, the same risk as
the hook itself, but the daemon looks at paths only and never follows a hook to the files it calls: an autopilot PR that
changes only `scripts/check-commit.sh` is merged. The daemon blocks a file only when it **matches the list and is not
exempted as a test file**, so:

- **Append** each called file to the existing value — never replace the line. With
  `AUTOPILOT_HUMAN_PATHS="default /setup.sh"` that is `AUTOPILOT_HUMAN_PATHS="default /setup.sh /scripts/check-commit.sh"`;
  writing `"default /scripts/check-commit.sh"` would silently drop `/setup.sh`.
- If the called file's name counts as a test file (`scripts/check.test.sh`) and the test-file exemption is on, appending
  it is **not enough**: also set `AUTOPILOT_HUMAN_PATHS_EXEMPT_TESTS="off"` (cost: changes to test files under listed
  directories then go to a human too), or rename it to a name that is not a test file, update the hook, and append the
  new path. Turning the exemption off without appending is not enough either.
- Before changing the config, check the result with the read-only command below (same rules as the merge check; it
  reads neither GitHub nor the project config). Each path prints `拦` (blocked) or `不拦` (not blocked) with the reason;
  the exit code is 0 only when every path is blocked, 2 for a usage error or an entry the daemon cannot read:

<!-- autopilot-human-paths:check:begin -->
```bash
bash ~/.agents/skills/cavil-loop/scripts/human-paths-check.sh \
    --spec 'default /setup.sh /scripts/check-commit.sh' --exempt-tests on \
    scripts/check-commit.sh setup.sh .githooks/pre-commit
```
<!-- autopilot-human-paths:check:end -->

`--spec` is the value you intend to write; `--exempt-tests` is `on` when `AUTOPILOT_HUMAN_PATHS_EXEMPT_TESTS` is missing,
empty or `"on"`, otherwise `off`. A renamed or copied file is one item, `--renamed <old path> <new path>`: the merge check
judges both paths of one rename together (exempt only when both are test files), so checking them as two separate paths
can give a different answer. On a development checkout use `scripts/human-paths-check.sh` in it.

The autopilot reviewer of a project with the list set gets an extra step for this (only then; otherwise its prompt is
unchanged): it follows the hooks and hook configs on the list (and the `package.json` scripts / `Makefile` targets they
call) to the repo files they run, on both the target branch and the PR; when the PR changes a file on such a chain that
the daemon would not block, or a call whose path cannot be worked out (a variable, command substitution, glob), it hands
the PR to a human instead of queuing the merge, and suggests a config change it has checked with the command above. That
step is the reviewer reading code, not a check the daemon enforces: a reviewer can miss a call, and files a tool loads
implicitly (a linter's own config) are not followed — put those on the list yourself.

</details>

### Comments by outside accounts on autopilot items (`AUTOPILOT_OUTSIDER_GUARD`)

Anyone can comment on a public repository, and on autopilot nobody confirms the plan or clicks merge. This setting makes
the agent read an autopilot item through a command that strips links, code and attachments from outside accounts' text,
and (in `block` mode) holds back the merge of a PR an outside account commented on after the authorization. It is off by
default; to turn it on, write in the project's config (takes effect on the next poll):

```bash
AUTOPILOT_OUTSIDER_GUARD="block"   # or "mark": only label and strip, merge rules unchanged
AUTOPILOT_OUTSIDER_SCREEN="on"     # missing or "" = no pre-screening
```

To turn it off, remove the two lines (or set them to `""`); the old rules apply from the next poll, and PRs already handed
over stay with a human.

<details><summary>What it does when on</summary>

An outside account is one **without write access** to this repo — not a maintainer, not the loop's write account, not the
requester bot. Its comments cannot make the daemon do anything: they start no work, merge nothing and cannot pose as the
autopilot authorization. But once an autopilot item is dispatched, the agent reads those comments. With this setting on:

- **The agent reads the item through a read command** (`scripts/outsider-read.sh`; the autopilot prompt gives the exact
  command): it prints every body and comment of the item (a PR also brings the issue it is bound to, a split sub-issue
  its parent), each one labelled with who wrote it. An outside account's **text stays readable**; its links, images,
  attachments, code blocks, inline code, HTML comments and invisible characters become placeholders that name what was
  removed, and the same links / code are also removed from the loop's own earlier comments that quoted them. A body an
  outside account edited after the authorization is shown as it was at the moment of the authorization. Outside text is
  only a reference: not a requirement, not a confirmation, no change of scope; files and commands in it are never
  downloaded, run or copied.
- **Hand-over before merging** (`block`): once an outside account has commented (issue, PR conversation, inline comment,
  review) or edited a body after the maintainer added the autopilot label — seen now, or recorded on this machine earlier
  (a deleted comment still counts) — the PR is not merged automatically; it goes to `pending/human` with a note naming
  those comments. Outside content from before the authorization counts as already seen by the maintainer.
- **Model pre-screening** (`AUTOPILOT_OUTSIDER_SCREEN="on"`): before dispatching, the daemon hands every outside comment
  (already stripped) to a model that has **no tools**, asking whether it is ordering the agent to do something; those
  judged so, those whose screening failed and those not screened yet are shown to the agent as a placeholder with the
  link only. Each version is screened once (the verdict is stored by content), at most 5 new ones per dispatch. The read
  command never calls the model itself (a nested `claude -p` inside a worker session fails to authenticate), so an
  outside comment posted after a dispatch stays hidden until the next dispatch screens it.
- **Sessions**: when an autopilot item is dispatched and this role's current session was not started with the
  protection on (the item was an ordinary one, or the setting was turned on later), that session is retired and a fresh
  one started — the old one may hold unstripped text. After that it is resumed as usual.

</details>

<details><summary>Setting values</summary>

Empty or missing = off: GitHub calls, state and prompts are unchanged. An unknown word counts as `block`.
`AUTOPILOT_OUTSIDER_SCREEN_CMD` replaces the screening command (text on stdin, stdout exactly `SAFE` or `SUSPECT`,
anything else = not screened); empty = the built-in `claude -p --tools '' --strict-mcp-config …` (every tool and MCP server
off, model haiku).

</details>

<details><summary>When a PR was held back before merging</summary>

On the GitHub website:

1. Open the outside comments the note names and look at the PR's changes again: make sure nothing in them follows the
   outside text or goes beyond the item.
2. Pick one:
   - **Merge it yourself**: review and click merge on the PR page.
   - **Keep autopilot**: where the authorization is (the note says; usually the issue) remove the `autopilot` label and
     add it again — that means "I have seen these", and from then on only outside content after the new label counts;
     then change the PR's label from `pending/human` to `pending/review`. Once the review passes the daemon checks and
     merges again. The autopilot merge note on the PR means it worked; if it is held back again, the note names outside
     content that arrived after the new label.
   - **Don't merge**: close the PR.
3. To see what the agent sees and what this machine recorded, run this on the machine that runs the project (change the
   first two lines only; running it also records the outside content it finds, exactly as when the agent runs it):

<!-- outsider-ops:begin -->
```bash
KEY=myproject    # the instance name / 实例名: systemctl --user list-timers 'cavil-loop-poll@*'
N=123            # the issue or PR number / 条目编号
ENV_FILE="$HOME/.config/cavil-loop/$KEY.conf"
[ -f "$ENV_FILE" ] || ENV_FILE="$HOME/.config/coding-agent-work-loop/$KEY.conf"   # installed before the rename / 改名前装的
CONF=$(sed -n 's/^CODING_AGENT_CONFIG=//p' "$ENV_FILE" | tr -d '"')
STATE_DIR=$(bash -c 'source "$1" >/dev/null 2>&1; printf %s "$STATE_DIR"' _ "$CONF")
ENTRY="$HOME/.agents/releases/cavil-loop/entrypoints/outsider-read.sh"
[ -f "$ENTRY" ] || ENTRY="$HOME/.agents/skills/cavil-loop/scripts/outsider-read.sh"   # development mode / 开发模式
bash "$ENTRY" --config "$CONF" "$N"
echo "exit code / 退出码: $?"
ls "$STATE_DIR/outsider/" 2>/dev/null || echo "no records yet / 本机还没有任何记录"
```
<!-- outsider-ops:end -->

Exit code 0 = read completely; 3 = could not read everything (network, a permission that cannot be read, a body version
that cannot be recovered) and nothing is printed. Records are kept per item number (the issue's number when a PR is bound
to an issue) and removed when the item is cleaned up.

</details>

<details><summary>What it does not stop</summary>

This is not a sandbox: an agent that ignores its rules can still read the original and run what it was given; malicious
requests written as plain text cannot be stripped (pre-screening catches some and also misses and misjudges); a link
written in pieces or content retold in someone's own words is not recognised; a comment posted and deleted between two
checks is never seen; the window between the last check and the merge request reaching GitHub cannot be closed; records
are not shared between machines.

</details>

### Poll the repo from one machine only

Before turning autopilot on, make sure **exactly one machine** polls the repo: run the host check below on **every other
machine** (`REPO=<owner/repo> bash host-check.sh`) and act on its last line.

<details><summary>What each verdict means and what to do</summary>

| Last line | What to do |
|---|---|
| `HOST_VERDICT=STOPPED` | That machine does not poll the repo; go on |
| `HOST_VERDICT=RUNNING` | Stop the scheduler **first**, **then** wait for its sessions (no "looked idle, dispatched before the stop" gap): Linux `systemctl --user disable --now cavil-loop-poll@<key>.timer` (`coding-agent-poll@<key>.timer` on a pre-rename install); macOS `launchctl bootout gui/$UID/dev.luosky.cavil-loop.<key>`. Let the sessions end on their own — **do not kill them**: no other machine picks up its work, so it would stay on `doing/agent`. Rerun until `STOPPED` |
| `HOST_VERDICT=UNKNOWN` | Cannot tell; **do not turn autopilot on** |

</details>

<details><summary>Why a second machine breaks autopilot</summary>

Any other machine still polling the repo, **autopilot on or off**, can take the review and dispatch of autopilot items
(ordinary dispatch ignores the autopilot switch and which machine started the work; only the merge step checks
ownership): its review carries no autopilot rules, so a design pass goes to a human and a code pass never reaches the
auto-merge, breaking the loop. If it also has autopilot on without `SELFHEAL_ONLY_OWN_WORKERS`, it sends PRs the other
machine reviewed back for review.

</details>

<details><summary>What the check looks at</summary>

It loads each install's registry and project config the way the daemon does (clean env, subprocess, 10 s limit, output
dropped) and reads the repo and session prefix the daemon actually uses — quoting, repeated assignments and variables
behave as for the daemon. For an instance of this repo it then checks whether the timer is stopped, whether it still
starts at boot, whether sessions are left, and whether any process still works under the project's worktree directory (a
worker whose session is gone but whose process lives on is still running). Anything it cannot read is `UNKNOWN`.

It only knows pollers installed by `setup.sh`; a machine that polled the repo some other way (a hand-made cron job, …)
counts as "cannot tell" too.

</details>

<details><summary>The host check script</summary>

<!-- autopilot-ops:host-check -->
```bash
# autopilot host check. Run on every OTHER machine before turning autopilot on:
#   REPO=<owner/repo> bash host-check.sh
# Finds every poller instance installed on this machine for REPO and judges each one
# STOPPED / RUNNING / UNKNOWN. Only a last line of HOST_VERDICT=STOPPED means "this machine
# does not poll REPO". Anything it cannot read counts as UNKNOWN, never as "not installed".
REPO=${REPO:?set REPO=<owner/repo>}
verdict=STOPPED
bad() { echo "$1 $2"; case "$1" in UNKNOWN) verdict=UNKNOWN;; RUNNING) [ "$verdict" = UNKNOWN ] || verdict=RUNNING;; esac; }
found=0
for d in "$HOME/.config/cavil-loop" "$HOME/.config/coding-agent-work-loop"; do
  [ -e "$d" ] || continue
  [ -d "$d" ] && [ -r "$d" ] && [ -x "$d" ] || bad UNKNOWN "cannot read registry dir $d"
done
# Read an instance's repo and session prefix the way its daemon does: load the registry
# env file, then source the project config. Clean env, subprocess, 10 s limit, output dropped.
if command -v timeout >/dev/null 2>&1; then lim() { timeout 10 "$@"; }
elif command -v gtimeout >/dev/null 2>&1; then lim() { gtimeout 10 "$@"; }
else lim() { perl -e 'alarm 10; exec @ARGV or exit 127' "$@"; }   # macOS has perl, not timeout
fi
load_instance() {   # <registry file>  -> prints "repo\nprefix\nworktree base"
  lim env -i HOME="$HOME" PATH="$PATH" bash -c '
    set -a; . "$1" >/dev/null 2>&1 || exit 3; set +a
    [ -n "${CODING_AGENT_CONFIG:-}" ] && [ -r "$CODING_AGENT_CONFIG" ] || exit 4
    . "$CODING_AGENT_CONFIG" >/dev/null 2>&1 || exit 5
    printf "%s\n%s\n%s\n" "${REPO:-}" "${TMUX_PREFIX:-}" "${WORKTREE_BASE:-}"
  ' _ "$1" </dev/null 2>/dev/null
}
# Which of my processes work under $1 (a worktree base)? Prints "W <pid>" for each, "S <pid> <name>"
# for each one whose working directory cannot be read (setuid / setgid helpers such as sshd or
# gpg-agent) and none of whose parents works there either; fails if a process cannot be judged.
scan_procs() {
  local d p c pp n hit bad=0
  for d in /proc/[0-9]*; do
    [ -O "$d" ] || continue
    p=${d#/proc/}
    if c=$(readlink "$d/cwd" 2>/dev/null); then
      case "$c/" in "$1"/*) echo "W $p";; esac; continue
    fi
    [ -e "$d" ] || continue                                       # exited meanwhile
    hit=0; n=0; pp=$p
    while [ $n -lt 64 ]; do
      pp=$(sed 's/.*) [A-Za-z] //; s/ .*//' "/proc/$pp/stat" 2>/dev/null) || { [ -e "$d" ] && bad=1; break; }
      [ "$pp" -gt 1 ] 2>/dev/null || break
      c=$(readlink "/proc/$pp/cwd" 2>/dev/null) && case "$c/" in "$1"/*) hit=1; break;; esac
      n=$((n+1))
    done
    if [ $hit = 1 ]; then echo "W $p"; elif [ -e "$d" ]; then echo "S $p $(cat "$d/comm" 2>/dev/null)"; fi
  done
  return $bad
}
want=$(printf '%s' "$REPO" | tr 'A-Z' 'a-z')
for f in "$HOME"/.config/cavil-loop/*.conf "$HOME"/.config/coding-agent-work-loop/*.conf; do
  [ -e "$f" ] || continue
  key=$(basename "$f" .conf)
  if ! got=$(load_instance "$f"); then bad UNKNOWN "instance $key: loading its config failed (unreadable, syntax error or timeout)"; continue; fi
  repo=$(printf '%s\n' "$got" | sed -n 1p); prefix=$(printf '%s\n' "$got" | sed -n 2p); wt=$(printf '%s\n' "$got" | sed -n 3p); wt=${wt%/}
  [ -n "$repo" ] || { bad UNKNOWN "instance $key: no REPO after loading its config"; continue; }
  [ "$(printf '%s' "$repo" | tr 'A-Z' 'a-z')" = "$want" ] || continue   # definitely another repo
  found=$((found+1))
  [ -n "$prefix" ] || { bad UNKNOWN "instance $key: no TMUX_PREFIX after loading its config"; continue; }
  [ -n "$wt" ] || { bad UNKNOWN "instance $key: no WORKTREE_BASE after loading its config"; continue; }
  # 1) scheduler: running or enabled at boot = RUNNING; unreadable or unknown words = UNKNOWN
  if command -v systemctl >/dev/null 2>&1; then
    for u in "cavil-loop-poll@$key.timer" "cavil-loop-poll@$key.service" "coding-agent-poll@$key.timer" "coding-agent-poll@$key.service"; do
      if ! out=$(systemctl --user show -p LoadState,ActiveState,UnitFileState "$u" 2>&1); then bad UNKNOWN "instance $key: cannot query $u ($out)"; continue; fi
      ld=$(printf '%s\n' "$out" | sed -n 's/^LoadState=//p'); ac=$(printf '%s\n' "$out" | sed -n 's/^ActiveState=//p'); uf=$(printf '%s\n' "$out" | sed -n 's/^UnitFileState=//p')
      case "$ld" in not-found) continue;; loaded|masked) ;; *) bad UNKNOWN "instance $key: $u LoadState=$ld"; continue;; esac
      case "$ac" in inactive|failed) ;; active|activating|deactivating|reloading) bad RUNNING "instance $key: $u is running ($ac)";; *) bad UNKNOWN "instance $key: $u ActiveState=$ac";; esac
      case "$u" in *.timer)
        case "$uf" in disabled|masked) ;; enabled|enabled-runtime|linked|linked-runtime|static|indirect|generated|alias) bad RUNNING "instance $key: $u still starts at boot ($uf)";; *) bad UNKNOWN "instance $key: $u UnitFileState=$uf";; esac;;
      esac
    done
  elif command -v launchctl >/dev/null 2>&1; then
    for lb in "dev.luosky.cavil-loop.$key" "dev.luosky.coding-agent-work-loop.$key"; do
      out=$(launchctl print "gui/$(id -u)/$lb" 2>&1); rc=$?
      if [ $rc -eq 0 ]; then bad RUNNING "instance $key: launchd still has $lb loaded"
      elif printf '%s' "$out" | grep -qi 'could not find service'; then :
      else bad UNKNOWN "instance $key: cannot query $lb ($out)"; fi
    done
  else
    bad UNKNOWN "instance $key: neither systemctl nor launchctl found"
  fi
  # 2) sessions still running for this instance
  out=$(tmux ls -F '#{session_name}' 2>&1); rc=$?
  if [ $rc -eq 0 ]; then
    s=$(printf '%s\n' "$out" | awk -v p="$prefix-" 'index($0,p)==1' | tr '\n' ' ')
    [ -z "$s" ] || bad RUNNING "instance $key: sessions still running: $s"
  elif printf '%s' "$out" | grep -Eq 'no server running|error connecting to .*No such file'; then :
  else bad UNKNOWN "instance $key: cannot list tmux sessions ($out)"; fi
  # 3) worker processes left behind: a killed session does not end a process that ignores SIGHUP,
  #    so also look for any of my processes whose working directory is under WORKTREE_BASE
  if [ -d /proc/self ]; then
    if out=$(scan_procs "$wt"); then
      left=$(printf '%s\n' "$out" | awk '$1=="W"{printf " %s", $2}'); unk=""
    else left=""; unk=" (some process could not be judged)"; fi
  elif out=$(lsof -a -d cwd -u "$(id -u)" -Fpn 2>/dev/null); then   # macOS: no /proc
    left=$(printf '%s\n' "$out" | awk -v w="$wt/" '/^p/{p=substr($0,2)} /^n/{if (index(substr($0,2)"/",w)==1) printf " %s", p}'); unk=""
  else
    left=""; unk="(cannot list processes)"
  fi
  [ -z "$unk" ] || bad UNKNOWN "instance $key: cannot read the working directory of:$unk"
  [ -z "$left" ] || bad RUNNING "instance $key: processes still working under $wt (PIDs:$left)"
  echo "instance $key (session prefix $prefix) checked"
done
echo "instances=$found"
echo "HOST_VERDICT=$verdict"
```

</details>

### Turning autopilot off

Leave `LABEL_AUTOPILOT` empty in the config (`LABEL_AUTOPILOT=""`) or delete the line — no timer to stop, nothing else to
run. From the next round nothing is auto-merged, and PRs this machine had waiting on the merge label are handed to a human.
⚠️ Autopilot labels left on issues do nothing while the switch is off, but **once autopilot is turned on again every issue
still carrying it is back on autopilot** — remove them if that is not what you want.

<details><summary>What the daemon does after it is turned off</summary>

- nothing is auto-merged any more, and new dispatches no longer carry the autopilot rules;
- every open PR this machine had on autopilot that still carries `LABEL_PENDING_MERGE` is moved to `pending/human` with a
  comment saying why. A review dispatched before the switch that finishes later and flips a PR to the merge label is
  caught the round after;
- queued and running work is not cleared — it finishes the normal way and ends with a human; completed merges stay.

Only PRs this machine had on autopilot are touched (recorded under `autopilot.prs` in `state.json`), so a same-named label
used elsewhere is left alone and a project that never turned autopilot on makes no extra GitHub call.

</details>

<details><summary>How the hand-over writes are checked</summary>

The target state is `pending/human` present, the merge label gone, one hand-over comment on the PR; the order is add
`pending/human` → remove the merge label → post the note. The three writes follow the same checks as a hand-over while
autopilot is on: before touching GitHub the sweep records a to-do in `state.json` that carries the PR's state at the start
(the baseline), "what it should look like now" (the baseline plus the daemon's own confirmed writes) and the one write
already decided on but not yet confirmed; before each write the PR is read afresh and must match the to-do, and after it
the PR is read once more to confirm only that one change was added.

- A failure at any step, or a killed process, is picked up the next round through the to-do: if the PR is as it should
  be the sweep continues, and if exactly the pending write has appeared it is taken as its own.
- **Any other difference means somebody touched the PR** (closed it, removed `pending/human` to take it over, re-queued
  it, pushed…): the to-do is dropped and nothing more is written this round; after that a PR no longer in the merge queue
  is left alone, and one still carrying the merge label is started from scratch the following round as a new case.
- State that cannot be read whole means no write this round and the to-do stays.
- Turning autopilot back on clears every to-do, so turning it off again never resumes a half-done one.

</details>

## External requester bot (optional, **off by default**)

When another AI assistant with its own GitHub account files requests directly, the agent's
questions / reports skip `pending/human` and wake the bot instead. Off by default: leaving the
five settings (`LABEL_PENDING_REQUESTER_BOT` / `REQUESTER_BOT_ACCOUNT` /
`REQUESTER_BOT_ALLOWED_ACTORS` / `REQUESTER_BOT_ORIGIN_MARKER` / `REQUESTER_BOT_REPORT_FIRST`)
empty turns it off. Full guide: [Hooking up an external requester bot](requester-bot.md).

<details><summary>What it does, and its settings</summary>

The agent runs the wake-up script: the item gets `LABEL_PENDING_REQUESTER_BOT` and, once that is
confirmed, the bot's webhook is called once (issue and PR alike; the bot is not assigned or asked
to review). When the PR is merged or closed unmerged, the daemon posts a result comment on the
bot's issue, adds the waiting label and calls the webhook.

The early names (`LABEL_PENDING_RELAY`, `RELAY_*`) are still read; for each setting the new name
wins when it has a value. The webhook has three more settings (`REQUESTER_BOT_WEBHOOK_URL` /
`_KEY_HEADER` / `_KEY`); an empty URL sends nothing, and the config file must be mode 600.
`REQUESTER_BOT_WAKE_ANY_ITEM=true` (default false) also lets items the bot did not file wake it —
see [requester-bot.md](requester-bot.md#a-maintainers-own-items-optional); merge / close notices
still go to the bot's own requests only.

</details>

<details><summary>Operating it</summary>

- Items carrying the waiting label are left alone by the greedy pass and self-heal; adding a trigger label dispatches them through the normal flow and removes the waiting label
- There is no waiting timeout. If the bot never answers, nothing shows up in `poll.log`; watch the board for items stuck on the waiting label
- The wake-up script runs through the durable entry `~/.agents/releases/cavil-loop/entrypoints/notify-requester-bot.sh` (survives release switches; the early `notify-relay.sh` entry forwards to it) and logs one `notify-requester-bot #<number>: …` line to `poll.log` per run, followed by one webhook result line when configured (`已通知 webhook（HTTP 200）` / `webhook 通知失败（…）` / `… 跳过`) — never the URL or key
- Merge / close notices: pending ones sit in `state.json` under `requester_bot_done_queue`; each one logs `✅ 已把 PR #N 的结果…` when sent, or a ⚠️ line after 30 failed ticks. They run inside the post-merge cleanup pass, so `AUTO_CLEANUP_ON_MERGE=false` turns them off too
- Exit codes, evidence rules and a worked example: [Hooking up an external requester bot](requester-bot.md)

</details>

## Round log: agent ↔ agent back-and-forth in one comment (`ENABLE_ROUND_LOG`)

One back-and-forth between agents — a proposal or PR, the review, the revision, the next review … —
takes **one** comment, the *round log*, instead of one comment per step. Off unless the config says
`ENABLE_ROUND_LOG=true` (the template does; a project whose config lacks the line gets one
`poll.log` notice and stays off). Set `ENABLE_ROUND_LOG=false` (or remove the line) to turn it off.

<details><summary>What goes into the record, and what stays separate</summary>

Each delivery that goes to another agent (the comment after which the agent flips the item to the
review label or back to the dispatch label) is appended as a short section: what changed, what the
next agent needs, the usage footer. The full current version (whole proposal / whole delivery
summary) sits at the top of the record and is replaced by the latest one.

Each section is folded into one line titled "⏱️ the section's time · worker or 复审 (review) · the first
line of the section"; the full text opens below it. A worker writes that first line as a one-sentence
summary starting with ✅ (delivered), ❓ (a question for the reviewer) or ❌ (not finished, something
failed); a review's first line is its `## ✅ …` / `## ❌ …` verdict heading. A first line without an
emoji gets 📝, and a section with no usage record says "耗时未记录" (time not recorded). In the desktop
client's activity list the record's line shows the sum of the sections' times ("≥" in front when a
section has no record), how many deliveries and reviews it holds, and the last section's sentence.

- **Stay separate**: every comment to a human, the review verdict that queues an autopilot merge
  (the merge check only accepts the test record in a comment created after the review was dispatched), daemon
  comments, waiting-on-prerequisite notes. A new comment by anyone in between ends the record; the next delivery
  starts a new one
- **Only the loop edits it**: the record is written and edited only by the loop's write account; no other comment
  is ever edited. Reply and tick boxes in the hand-off comments, not in the record. Editing a record is not
  protected against: a human edit can be overwritten by the next section

</details>

<details><summary>Commands and the checks before every write</summary>

Agents run `round-log.sh post` / `show` through the durable entry
`~/.agents/releases/cavil-loop/entrypoints/round-log.sh`.

- Before every write the target is re-read (open, still `doing/agent`, no `pending/human` / waiting / `pending/merge` / `pending/PR` label, PR not merged, same base branch and source, head commit equal to
  the delivery's). State and labels are checked on every response read — the issue and then the PR on a PR, the issue again after the linked-PR list on an issue — and a missing or unrecognised field means nothing is written. An edit that fails or times out is replaced by a complete new record carrying the same section id;
  readers and statistics count a section once.
- On a PR the caller must pass the commit and base branch the delivery was made against (`--basis` / `--base`; `--source` for a PR from another repository) — the command never takes its own first read as the baseline and refuses without them. A missing `--basis` / `--base` is a usage error (exit 64): the agent completes the call, and never falls back to a plain comment.
- A review must pass `--of` — the value the read command printed under the latest unit when the review started (a section id, `comment-<id>` for a plain comment, or `body` when the thread has no delivery yet, e.g. a first PR whose delivery is its description); if another delivery arrived since, the verdict is expired (exit 3) and is neither posted nor turned into a plain comment.
- A review whose latest delivery is not a section of a record (a plain comment posted while the switch was off, a delivery that was posted on its own, or any later plain comment by the loop's account) is refused (exit 2) and posted as a plain comment — it is never attached to an older section.
- A record already in the thread that cannot be parsed (a missing marker, a version that does not match) is treated like an unreadable thread (exit 5): nothing is written, and the agent neither posts on its own nor flips the label.
- Review rounds are still counted from the last human action: the read command lists the review units (review sections of a record, or a plain comment by the loop's account whose first non-empty line is exactly a round marker — an example quoted in a discussion does not count) and the comments not written by the loop's account, with their times, and says its total is the whole history; edits and label-only actions are read from the comment edit data and issue events.
- Each run logs one `round-log #<n> post：<result>` line to `poll.log`.

**Autopilot items with the outsider guard on** are read through the protected read command; its
output ends with the same unit view. Writing goes through the same protected read first, and writes
nothing when it fails.

</details>

<details><summary>Whose record it is, and statistics</summary>

- **One rule for whose record it is**: a record counts only when its author is the loop's write account (the login of
  `WRITE_GH_TOKEN`, or gh's own login without it) — for the commands, the weekly report and `pr-time-stats.py`
  alike. A comment by any other account that carries the record marker is an ordinary comment, a bot-suffixed name
  included. A record by the write account that cannot be parsed stops the read and both statistics with an error
- **Statistics**: the weekly report and `pr-time-stats.py` split records into sections (each with its own append
  time) through the same function; for every item that has a record, the weekly report re-reads that item's whole
  comment thread before applying the week window, and stops with an error when that read fails

</details>

<details><summary>Turning it off</summary>

Set `ENABLE_ROUND_LOG=false` (or remove the line). Existing records stay as they are and are still
counted. It takes effect at once: the round-log write command checks the setting each time it runs, and
the guarded read (`outsider-read.sh`, autopilot items with the outside-content guard) stops adding the
split view. An agent session already running keeps the instructions it was started with, so an item that
is in the middle of an agent back-and-forth when the setting goes off can stop half-way: a worker whose
delivery the write command refuses posts it as a separate comment and carries on; a review on a guarded
item may find no delivery to answer and stop without a verdict or a label change, leaving the item on
`doing/agent`.

Looking at which items carry `doing/agent` or `pending/review` before turning it off makes a collision
less likely but cannot rule it out: an item queued for dispatch, or one being dispatched that does not
carry `doing/agent` yet, does not show. So keep an eye on the items for a while afterwards and dispatch
again any item that stopped half-way:

- **How to spot one**: the item carries `doing/agent`, has had no new comment for a while, and its agent
  session has stopped (on a project with the stuck-worker check, the daemon also reminds or hands over by itself)
- **Hand it to a person first**: in the Labels box on the item's page, add `pending/human` first,
  reload the page to see it is there, and only then remove `doing/agent`. Not the other way round: for the
  moment neither is on, a project that picks up items on its own may dispatch it again as a new one. If
  `pending/human` did not stick, do not remove `doing/agent`
- **Then dispatch it as usual**: see which step it stopped at. If the latest delivery has no review verdict
  yet — it is a worker's comment, or a first round whose delivery is only in the PR description with none in
  the comments — add `pending/review` so the review carries on; if the latest agent comment is a review
  verdict (a rejection or anything else), add `pending/agent` so a worker carries on. Either way, add the
  new label first and remove `pending/human` after it. If the step cannot be told, leave it on
  `pending/human` for a maintainer
- **How to tell it worked**: the item first carries `doing/agent` again (the daemon dispatched it), then a
  new comment by the loop account appears — a review verdict or a worker delivery, a separate comment now,
  no longer part of the round log — and `doing/agent` has given way to the next step's label. With a queue of
  dispatches or an agent at its usage limit this can take a long time; go by these two things actually
  showing up, not by how long it has been

To do it with the project settings script instead of an editor (`myproject` is the instance key),
first check the current value — it prints `ENABLE_ROUND_LOG=true` while the round log is on:

<!-- round-log-check-ops:begin -->
```bash
bash "$HOME/.agents/skills/cavil-loop/scripts/project-config.sh" get myproject | jq -r '.fields[] | select(.name == "ENABLE_ROUND_LOG") | "\(.name)=\(.value)"'
```
<!-- round-log-check-ops:end -->

To turn it off, run this whole block and read its last line:

- `ROUND_LOG=off` — saved and read back as `false` (the line above it is `RESULT=saved`, or
  `RESULT=unchanged` when it was already off).
- `NOT_WRITTEN: …` — the settings script said for sure that nothing was written (the config could
  not be read, it changed between the read and the save, the backup could not be made, …); the config
  is untouched and the block can simply be run again.
- `UNCONFIRMED: …` — the config may have been written but the current value is not confirmed (another
  save landed right after it, the save stopped without its result line, or the read-back failed): run
  the check command above; `false` means it is off, anything else (or a check that fails) means it is
  still not confirmed — run the block again.

<!-- round-log-off-ops:begin -->
```bash
(
  SKILL="$HOME/.agents/skills/cavil-loop"; KEY=myproject
  PC() { bash "$SKILL/scripts/project-config.sh" "$@"; }
  REV="$(PC get "$KEY" | jq -er .rev 2>/dev/null)" || { echo "NOT_WRITTEN: config unreadable"; exit 1; }
  OUT="$(printf '{"ENABLE_ROUND_LOG":"false"}' | PC set "$KEY" --rev "$REV")" || true
  RES="$(printf '%s\n' "$OUT" | tail -1)"; printf '%s\n' "$RES"
  case "$RES" in
    RESULT=saved|RESULT=unchanged) ;;
    RESULT=changed|RESULT=invalid|RESULT=not_editable|RESULT=busy|RESULT=unreadable|RESULT=verify_failed|RESULT=backup_failed|RESULT=write_failed)
      echo "NOT_WRITTEN: ${RES#RESULT=}"; exit 1 ;;
    *) echo "UNCONFIRMED: ${RES:-no result line}"; exit 1 ;;
  esac
  NOW="$(PC get "$KEY" | jq -er '.fields[] | select(.name == "ENABLE_ROUND_LOG") | .value' 2>/dev/null)" \
    || { echo "UNCONFIRMED: saved, read-back failed"; exit 1; }
  if [ "$NOW" = false ]; then echo "ROUND_LOG=off"; else echo "UNCONFIRMED: read back ${NOW}"; exit 1; fi
)
```
<!-- round-log-off-ops:end -->

To turn it back on, use the block below — same last-line words as the one above, `ROUND_LOG=on` when it
worked. Turning it back on only affects later writes and reads; an item that already stopped half-way
still needs to be dispatched again as described above.

<!-- round-log-on-ops:begin -->
```bash
(
  SKILL="$HOME/.agents/skills/cavil-loop"; KEY=myproject
  PC() { bash "$SKILL/scripts/project-config.sh" "$@"; }
  REV="$(PC get "$KEY" | jq -er .rev 2>/dev/null)" || { echo "NOT_WRITTEN: config unreadable"; exit 1; }
  OUT="$(printf '{"ENABLE_ROUND_LOG":"true"}' | PC set "$KEY" --rev "$REV")" || true
  RES="$(printf '%s\n' "$OUT" | tail -1)"; printf '%s\n' "$RES"
  case "$RES" in
    RESULT=saved|RESULT=unchanged) ;;
    RESULT=changed|RESULT=invalid|RESULT=not_editable|RESULT=busy|RESULT=unreadable|RESULT=verify_failed|RESULT=backup_failed|RESULT=write_failed)
      echo "NOT_WRITTEN: ${RES#RESULT=}"; exit 1 ;;
    *) echo "UNCONFIRMED: ${RES:-no result line}"; exit 1 ;;
  esac
  NOW="$(PC get "$KEY" | jq -er '.fields[] | select(.name == "ENABLE_ROUND_LOG") | .value' 2>/dev/null)" \
    || { echo "UNCONFIRMED: saved, read-back failed"; exit 1; }
  if [ "$NOW" = true ]; then echo "ROUND_LOG=on"; else echo "UNCONFIRMED: read back ${NOW}"; exit 1; fi
)
```
<!-- round-log-on-ops:end -->

To make it the default for every project, change the one empty-value branch of `round_log_enabled` in `scripts/_lib.sh` — every
project without the line then has it on.

</details>

## Comment usage footer

With `COMMENT_FOOTER="on"`, every hand-off comment ends with a footer that
`scripts/drivers/token-usage/comment-footer.sh` generates whole: one summary line (time split into
AI / test / remote CI / other, model, tokens, a reference amount), which is also the toggle of a
folded block, and a hidden `agent-metrics` record on the last line for the weekly report. Turn it off
with `COMMENT_FOOTER="off"`.

<details><summary>How the summary line splits the time</summary>

- **Total wall time is split into AI / test / remote CI / other, in that order.** "Other" is
  total − AI − test − remote CI in displayed whole seconds, floored at 0; when tests overlap another
  part (tests running in the background while the AI works or while waiting on remote CI) it is 0
  and the details say so.
- **The test part only exists when `COMMENT_FOOTER_EXTRA_CMD` is set and has something to say.** It
  shows `测试 4m 51s` (more than 0 s) or `测试未知` (the command answered `test_secs=unknown` because
  tests ran but their time is unknown — e.g. only background or unfinished runs — or it failed, timed
  out or printed a bad first line; for those the reason goes into the details). An answer of 0 means
  the command is sure no tests ran this round: the summary then leaves tests out, as for a project
  without the command, while the machine record keeps `test_secs=0` so the weekly report can still
  tell the two apart. A command that cannot tell whether anything ran must answer `unknown`, never 0.
- **AI time is an estimate** (the summary says `AI 约 …`). Per model request it counts from the
  request being sent to the last reply chunk written into the session log, and a second covered by
  several requests counts once. It includes network round-trips and queueing before the first token;
  session logs carry write time, a few ms to a few s off the real send / receive; background commands
  may run while the AI thinks. This is not repeated in every comment; when it cannot be computed the
  summary says `AI 时间未知` and the details give the reason.

</details>

### Test time: the built-in command

The skill ships a test-time command, `scripts/drivers/token-usage/test-time.sh`, with a durable entry
point like the footer script, so it always runs the merged and deployed version — never the copy a
worktree is editing. It is off until you add this line to the local config (the guard keeps the footer
working in the minutes between merge and deployment); to undo, empty the line again.

```bash
COMMENT_FOOTER_EXTRA_CMD='f="$HOME/.agents/releases/cavil-loop/entrypoints/drivers/token-usage/test-time.sh"; if [ -e "$f" ]; then bash "$f"; else printf "test_secs=unknown\n- 测试统计命令尚未部署\n"; fi'
```

Check: the next hand-off comment's summary line shows `测试 …` (or `测试未知` with a reason in the
details).

<details><summary>Where the test time comes from: full runs and single runs</summary>

- **Full runs** — `tests/run.sh` gives each run an id, prints `cavil-test-run id=<id>` in its own
  output (with ` log=failed` when the record could not be written) and appends a start and an end
  line with that id to `${XDG_STATE_HOME:-~/.local/state}/cavil-loop/test-runs.jsonl`
  (`CAVIL_TEST_RUNS_LOG` overrides it). A command in the agent's session is linked to a record
  **only by the id in that command's own output** (the tool result; for a Claude background command,
  the output file the tool result names; for codex, that command's own item in its `exec` cell's
  output plus what later `write_stdin` polls of the same `session_id` return — never another
  command's output, e.g. a `cat` of some saved log) — never by a nearby start time: a run a human
  started next to it, or a second run of the same agent, is a different run. Linked with both lines,
  or with only the end line (it carries the start time) → measured. Only a start line → "未记到结束".
  Id printed but no record → "没有记账". No id readable → "无法关联". A record no session command
  printed → counted on its own, measured. Nested runs (a test running `tests/run.sh` again) record
  nothing.
- **Single runs** — test commands recognised in the agent's own session (`bash tests/<x>.test.sh`,
  `bash test/tauri/mutations.sh`, `npm test` / `npm run test…`, `npx vitest`, `npx playwright test`,
  `cargo test`; text inside quotes and here-docs does not count), timed from tool call to tool
  result — an estimate of the whole command.
- **The answer**: a source that cannot be read → `unknown`; anything measured → the union of the
  measured spans (parallel tests count once; other untimed runs are listed in the details, so the
  number is a lower bound); runs seen but none measured → `unknown`; both sources read and nothing
  ran → 0.

</details>

<details><summary>codex sessions and known limits of the test time</summary>

- codex: an `exec` cell's output is matched to its commands only when the cell is nothing but
  `text(await tools.X({…}));` statements and has one output item per statement; any other cell
  still counts its commands (a full run → "无法关联", a single run → untimed) but gives its output to
  none of them. Standard function calls with JSON arguments (`exec_command`, `shell`,
  `local_shell_call`) are read too. A command whose text cannot be parsed (e.g. a template string)
  is listed as "解析不了" and makes the answer `unknown`, never 0.
- Limits: wrappers (`bash -c '…'`, an own script) are not recognised; a single run that went to the
  background (Claude) or was still running when its cell returned (codex) is counted, not timed; a
  full run whose output went to a file (`> log`) or otherwise cannot be read is counted twice — once
  as "无法关联", once from its record — the seconds are not.

</details>

### Remote CI wait

The remote CI part is the time the agent spent waiting for GitHub Actions (the summary says
`远端 CI 约 …`). It is read from the agent's own session log, not from GitHub, needs no configuration,
and is inferred from the commands, so it may run high.

<details><summary>Which commands count as a wait, and when a wait starts and ends</summary>

- Which commands count (Claude Bash and Monitor calls, codex `exec` commands): ones that block until
  the run ends — `gh run watch …`, `gh pr checks … --watch` — or a `for` / `while` / `until` loop
  containing both `sleep` and a remote CI status query (`gh run view` / `gh run list` /
  `gh pr checks`, or `gh api` on `…/actions/runs…`, `…/check-runs`, `…/check-suites`,
  `…/commits/<sha>/status`). Only commands that actually run count: the command is split the way the
  shell does it — single quotes are text, `$( … )` / backticks unquoted or in double quotes run — so
  printed text such as `echo gh run watch 1`, or a query a loop only echoes, does not. Nor do a single
  query, `gh workflow run`, or polling PR comments / labels.
- For the loop form the query and the `sleep` must sit in the **same** loop (an enclosing loop
  counts); a query in a `for` header runs once and is not polling.
- Not counted (when unsure the time stays in "other" rather than being moved into remote CI):
  commands inside a function definition (defining is not calling, and calls are not followed); a
  command sent to the background (`… &`); anything handed over as a string to `bash -c` / `sh -c` /
  `eval` / `xargs` / `ssh` / `sudo`, or inside a script file of the agent's own.
- Start = when the tool call was written to the session; end = the foreground command's tool result,
  the "background task finished" notification for background commands and Monitor (Monitor's
  per-event notifications do not end it), or codex's own reported duration / the poll that reported
  the exit code.

</details>

<details><summary>How the total is computed, and the machine record</summary>

- The total is the union of all wait spans minus the part overlapping AI requests (time the agent
  worked while a background wait ran counts as AI), so it never overlaps AI. The details list each
  wait: which run (taken only from the gh command recognised as the wait — `gh run …` /
  `actions/runs/<id>`; a variable is resolved from an assignment in the same command) or which PR's
  checks, start / end, and that wait's own length (AI not subtracted, so it matches the Actions
  page), plus notes on overlaps and the AI time taken out.
- Waits with no end on record (background task still running, notification missing, codex never
  reported an exit code) are counted but not timed and left out of the total (the details say so);
  when none could be timed the summary says `远端 CI 未知`. Waits that started in an earlier dispatch
  round are ignored.
- Machine record: `ci_wait_secs` (total, millisecond precision), `ci_waits` (count),
  `ci_wait_untimed` (count with no end); with no waits it writes `ci_wait_secs=0.000 ci_waits=0
  ci_wait_untimed=0`, and leaves out `ci_wait_secs` when none could be timed. When it cannot be
  computed (session unreadable, the tally failed) none of the three is written and the details say
  `远端 CI 等待没统计到` with the reason. The weekly report does not parse these fields yet.

</details>

<details><summary>Why the number may run high, and other limits</summary>

- The footer's details heading says `按命令推断，可能偏多`: the number is inferred from the commands
  rather than recorded by a dedicated wait command. Known over-counts: once a command is recognised as
  a wait, the whole command's duration goes into remote CI, including any other slow work in the same
  command; a wait in a branch that did not run (`if false; then gh run watch 1; fi; sleep 60`,
  `false && gh run watch 1; sleep 60`) still brings the rest of the command's time in; a quoted `}`
  inside a function body (`f() { echo '}'; gh run watch 1; }`) makes the body look executed. How much
  it over-counts depends on what else the command does, so there is no upper bound.
- A real wait written in one of the not-counted forms stays in "other"; a wait inside an `&&` /
  `||` / `if` / `case` branch is counted as run (whether the branch ran cannot be told); waits with
  no end on record are left out of the total; overlap with local tests cannot be taken out (tests
  only report a total) — see the "other is 0" rule above.

</details>

### Prices in the Claude footer

The Claude footer prices each call with the latest published Claude prices, downloaded by the daemon
once a day; it does not solve prices from session logs. `PRICE_AUTO_FETCH=off` stops the downloads,
and prices already downloaded keep being used.

<details><summary>The daily price download and the fallback order</summary>

- Once a day the daemon downloads the official Claude pricing page (only in polls the scheduler
  started; a hand-run `agent-poll.sh` skips the daily refresh, but still fetches the price of a model
  that has a missing-price marker) and uses only its prices (no cross-check against LiteLLM; the
  gap-fill for missing models still needs both to agree), keeping every model whose five prices
  (input, output, cache read, 5-minute and 1-hour cache write) are all there and pass the sanity
  checks, in `${XDG_CACHE_HOME:-~/.cache}/cavil-loop/latest-prices.json`.
- The time of the next download is in `latest-prices.next` next to it. A failed download is retried
  after `PRICE_FETCH_COOLDOWN_SECS` (6 hours by default); a download that could not be written to the
  cache, after 10 minutes; either way the previous file stays in use. When the next time cannot be
  written either, `poll.log` says "下次刷新时刻没能保存，下一轮会再抓" and every round downloads again
  until the cache directory is writable.
- The usage driver prices each call with `python3 scripts/weekly-report/price_solve.py --listed`,
  which reads no session log: the latest price for the model, else the built-in table, else a price
  fetched for a missing model. In the machine record that is `price_source=default`, with the amount
  split into `fetched` (downloaded) and `reference_only` (built-in).
- The footer calls the Claude driver once with `--both`, which prints the readable line and the
  machine record from one table; anything but exactly two lines counts as "usage unknown" for both,
  and the driver is not called again (the Codex driver is called twice).
- `PRICE_AUTO_FETCH=off` stops the downloads only (the daily one and the gap-fill): prices already
  downloaded keep being used — the last `latest-prices.json`, and the gap-fill prices in
  `fetched-prices.json` for models neither that file nor the built-in table lists.
- Taking the prices reads no session log; counting this dispatch's usage reads the sessions of the
  current working directory. The weekly report solves prices from the logs.

</details>

### Average AI and test time per merged PR (estimate)

`scripts/pr-time-stats.py` adds up, for every PR merged in a window, the AI time and the test time
recorded by the footers above, the local `tests/run.sh` run log and GitHub Actions. It is read-only:
it reads GitHub (with whatever `gh` is logged in as) and the run log, and writes nothing.

<details><summary>Command</summary>

```bash
python3 ~/.agents/skills/cavil-loop/scripts/pr-time-stats.py \
    --repo OWNER/REPO --worktree-base "$WORKTREE_BASE" --bot-login <loop write account> \
    [--since 2026-11-07] [--until YYYY-MM-DD] [--no-ci-selection] [--no-cache] [--json]
```

</details>

<details><summary>Which PRs and comments it reads</summary>

- Which PRs: merged within `[--since, --until]` (default: from 2026-11-07, the day the local run log
  starts, to today), created on or after `--since`, and with no footer from before it.
- Which comments: the PR's own and those of the issue it works on, found with the daemon's rule
  (branch `BRANCH_PREFIX<N>` → first `Closes / Fixes / Resolves / Refs #N` in the body → the PR
  number). Only footers posted by a bot account count; pass the loop account with `--bot-login` when
  its name does not end in `-bot`. When several merged PRs share one issue, that issue's comments and
  runs are split at each PR's merge time (marked "shared worktree").

</details>

<details><summary>The columns</summary>

- AI (footer `ai_secs` summed); single test files (footer `adhoc_secs` summed — the footer only keeps
  a total, so these cannot be split by kind); `tests/run.sh` runs from the run log, by their
  arguments: smoke (`smoke` alone), quick (`--quick`), by kind (`--kind`), related (named files or
  `--changed-from`), all (no selection), other; CI attempts of the `Tests` workflow split by the
  selection its summary job printed (full run / only what the change can reach / unknown), and of the
  `Client` workflow; local subtotal, CI subtotal (union of attempts) and total.
- "Full tests" means the whole suite run with negative controls, which only the nightly
  `Negative controls` workflow does, on `main`, never per PR: that column is 0 and the report lists
  that workflow's run times — only runs in which the negative-control step itself ran (judged per step
  in the shell, autopilot and client jobs; a red step counts as it is). A run that only did its
  preparation (a manual run off `main`, or a scheduled run that found the same commit already green)
  or whose jobs failed in a preparation step before the negative-control step started still shows as
  completed / failed; it is left out and counted as "did not really run". A run whose jobs or steps
  cannot be read, or whose negative-control step was cancelled or has an unknown state, is left out
  and counted separately too, and read again next time. The release workflow and the client's full
  tests are listed separately as "other tests on main", not as full tests.

</details>

<details><summary>Why it is an estimate, and when it stops</summary>

- Footer values are added up without de-duplication, so when two dispatches of the same agent on one
  worktree overlap in time, the overlap is counted twice (marked "dispatches overlap"); local and CI
  time are added the same way. A footer whose test fields carry an uncertainty marker (unreadable,
  unrecognised commands, untimed, unlinked) is counted as is and marked "test record incomplete" (a
  lower bound).
- A PR with no footer has no AI value, and its local subtotal and total test time are unknown too
  (the single-file part is missing) — its `tests/run.sh` columns and CI are still given; a footer
  without `ai_secs` makes that PR's AI unknown. None of these is averaged as 0. Every column's average
  states its own count, so averages of different columns do not add up.
- Any GitHub or run-log read that fails, or a list that is not read whole, stops the command with
  exit code 2 and no report. `--no-ci-selection` skips reading the CI logs (all `Tests` attempts then
  count as "selection unknown").

</details>

<details><summary>Request cost and the cache</summary>

- A page or two of comments per PR, plus two requests per `Tests` attempt (its job list and the
  summary job's log) — about 1,000 requests for a window of about 180 PRs, a fifth of the hourly
  allowance of the account `gh` is logged in as, which may be the one the daemon polls with; a few
  runs in one hour can exhaust it.
- Finished attempts' times and selections are kept in
  `$XDG_CACHE_HOME/cavil-loop/pr-time-stats-<repo>.json` (they never change), so a rerun reads only
  comments and lists; failed reads are not cached. The report states how many requests it made.
  `--no-cache` ignores the cache.

</details>

## Codex token value estimates

The Codex usage driver prices tokens with a [built-in price table](../scripts/drivers/token-usage/codex-prices.json)
(checked on 2026-10-19 against the official API model pages) unless `CODEX_PRICES` is set. The USD amount is a
**converted reference value at published API list price**, not a subscription bill or verified spend. Set
`CODEX_PRICES` to replace the table, or `CODEX_PRICES='{}'` to turn estimates off.

<details><summary>Which models the built-in table covers</summary>

[`gpt-6-astra`](https://developers.openai.com/api/docs/models/gpt-6-astra),
[`gpt-6.1-sol`](https://developers.openai.com/api/docs/models/gpt-6.1-sol),
[`gpt-6-sol`](https://developers.openai.com/api/docs/models/gpt-6-sol),
[`gpt-6-luna`](https://developers.openai.com/api/docs/models/gpt-6-luna),
[`gpt-5.6-sol`](https://developers.openai.com/api/docs/models/gpt-5.6-sol),
[`gpt-5.6-terra`](https://developers.openai.com/api/docs/models/gpt-5.6-terra),
[`gpt-5.6-luna`](https://developers.openai.com/api/docs/models/gpt-5.6-luna),
[`gpt-5.3-codex`](https://developers.openai.com/api/docs/models/gpt-5.3-codex),
[`gpt-5.2-codex`](https://developers.openai.com/api/docs/models/gpt-5.2-codex),
[`gpt-5-codex`](https://developers.openai.com/api/docs/models/gpt-5-codex),
and [`codex-mini-latest`](https://developers.openai.com/api/docs/models/codex-mini-latest).

- The table holds their Standard text input, cached-input and output rates.
- The four GPT-6 and three GPT-5.6 models also carry their listed cache-write rates; the Codex-named models have no
  listed cache-write rate, so cache writes on them stay unpriced.
- `gpt-5.6-sol` is on promotional pricing that OpenAI only guarantees through 2026-11-21. Re-check that model before
  then instead of waiting for the 90-day stale warning, which fires later.

</details>

<details><summary>Overriding the table: <code>CODEX_PRICES</code> and the fallback rates</summary>

- `CODEX_PRICES` is a JSON map keyed by exact model ID and replaces the whole table. A copy-ready map is in
  [the config example](../cavil-loop.config.example). `CODEX_PRICES='{}'` turns estimates off.
- Unlisted models and token components without a rate stay unpriced.
- The three `CODEX_PRICE_*_PER_M` variables give one common rate for models without an exact `CODEX_PRICES` entry;
  an exact model entry takes precedence.
- To override from the host config, use `export CODEX_PRICES='...'` and add `CODEX_PRICES` to `WORKER_PASS_ENV`:
  tmux workers do not inherit plain config shell variables.

</details>

<details><summary>Limits of the estimate</summary>

- Long-context and Fast / Batch / Flex rates are not identified by this driver; the estimates use Standard rates.
- The built-in table is static: after 90 days its human-readable output asks for a price review. Existing entries are
  never refreshed at runtime; only models missing from the table are filled in automatically (next section).
- The weekly report shows built-in API reference rates and operator-configured rates separately; neither Codex source
  is cross-checked against an invoice.

</details>

## Automatic price gap fill

When a usage driver (Claude or Codex) sees tokens for a model it has no price for, the footer says the amount was
not computed, and on the next poll tick the daemon tries to fetch that model's price. It is on by default;
`PRICE_AUTO_FETCH=0` turns it off.

<details><summary>How a price is fetched and when it is accepted</summary>

The driver runs inside the worker and does not go online; it only leaves an empty marker under
`~/.cache/cavil-loop/unpriced/`. On the next poll tick the daemon runs `scripts/drivers/token-usage/price_fetch.py`,
which downloads:

| Source | Default URL |
|---|---|
| Anthropic official pricing (markdown) | `https://platform.claude.com/docs/en/about-claude/pricing.md` |
| OpenAI official pricing (markdown, Standard table only) | `https://developers.openai.com/api/docs/pricing.md` |
| LiteLLM community price list (JSON on GitHub) | `https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json` |

A model is written to `~/.cache/cavil-loop/fetched-prices.json` only when the official page and LiteLLM **agree**
(≤ 10% apart on every item both list), each side passes sanity checks (positive, ≤ $1000/M, output ≥ input, cache
read ≤ input), and the official page lists the model on exactly one row. Items only one source lists stay unpriced.
From then on both drivers price that model, the footer adds 「（含自动联网获取的单价）」, and the money is tracked in
its own `fetched` trust bucket through to the weekly report.

</details>

<details><summary>Rules, failures and settings</summary>

- Gap fill only: built-in prices and operator-set `CODEX_PRICES` always win; an explicit `CODEX_PRICES` (including
  `{}`) turns gap fill off for Codex.
- Failures (download, page layout change, sources disagree) are logged to `poll.log` with the reason and retried
  after 6 hours (`PRICE_FETCH_COOLDOWN_SECS`). Each request times out after 15 s (`PRICE_FETCH_TIMEOUT`); fetch
  failures never block dispatch.
- The comment that discovered the gap still says "not computed"; comments after the next tick carry the amount.
  Posted footers are not rewritten.
- Turn it off with `PRICE_AUTO_FETCH=0`. The three URLs can be overridden with `PRICE_FETCH_ANTHROPIC_URL` /
  `PRICE_FETCH_OPENAI_URL` / `PRICE_FETCH_LITELLM_URL`.
- To make the daemon re-try a failed model now, delete `~/.cache/cavil-loop/price-fetch-state.json`; to drop a
  fetched price, edit or delete `fetched-prices.json`.

</details>

## Agent hit its usage limit: pause that agent, hand the interrupted item to a human

When a worker hits its subscription's usage limit, the daemon stops dispatching to that agent until
the limit lifts and hands the interrupted item to a human. Off by default; turn it on with
`ENABLE_USAGE_LIMIT_PAUSE=true`. Off, empty or missing means no extra read of tmux or GitHub and no
state file.

<details><summary>Why, and what the daemon does</summary>

Both agents run on flat-rate subscriptions with a usage limit per time window. When a worker hits
it, the CLI stops on a notice: the session is alive, the item still says `doing/agent`, the slot
stays taken — and every new session dispatched to that agent hits the limit on its first request.
With the switch on, the daemon looks, every poll round, at the sessions this machine dispatched
that still carry `doing/agent`, and when it recognises the notice it does two things and nothing
else:

| What | Detail |
|---|---|
| that agent gets no new work until the limit lifts | new issues, issue comments, PR comments, reviews and prompts injected into a live session are all skipped for that agent; labels stay as they are, nothing counts as a failed dispatch, and dispatch resumes by itself at the reset time. Other agents carry on. The pause is **machine-wide per agent and account directory** (`~/.claude` / `CLAUDE_CONFIG_DIR`, `~/.codex` / `CODEX_HOME`): projects sharing an account hit the limit together |
| the interrupted item goes to a human | one comment (which agent, when the limit lifts, which label to put back), then `pending/human` is added and `doing/agent` removed. The daemon does not type into the session, stop its program, close it or resume it |

`poll.log` says `⏸ 用量上限：<agent> 撞到用量上限（…），暂停派工到 <time>` when a pause starts and
lists the skipped items each round after that. Only the pause decides whether a round dispatches.

</details>

<details><summary>What a human does</summary>

Open the item the daemon commented on. After the time in the comment, replace `pending/human` with
the trigger label the comment names (`pending/agent`, the review label, …) in the Labels box.
Doing it earlier is fine: the daemon waits for the reset time before dispatching. The next dispatch
resumes the role's registered conversation. If the item is not dispatched after the reset time, or
hits the limit again, leave it on `pending/human` and read the daemon's comment and `poll.log`
rather than flipping labels back and forth.

</details>

<details><summary>How the limit is recognised</summary>

All four must hold, or nothing happens (exactly as with the switch off):

- the last block on the worker pane is the CLI's limit notice, followed only by lines the CLI itself draws under it (rules in `scripts/usage_limit.py`, written from real pane captures in `tests/fixtures/usage-limit/`); reminders such as "You've used 99% of your session limit" or codex's "You have N usage limit resets available" are not it
- the agent is idle
- the session is the one registered for this item and role, and its record shows no model reply, tool output or dispatch prompt containing that sentence since this dispatch started
- screen and session record are unchanged across two consecutive poll rounds

The reset time is read from the notice (claude: time of day plus time zone, e.g.
`resets 4:50pm (Asia/Singapore)`; codex: `try again at Aug 20th, 2026 11:35 AM`, read in the
machine's time zone). A time that cannot be read, or lies more than 8 days ahead, becomes a fixed
wait of `USAGE_LIMIT_FALLBACK_SECS` (default 3600); if the limit is still on after that, the next
worker that hits it is recognised again.

</details>

<details><summary>Limits to know about</summary>

- The notice exists only on the pane — nothing in the session record marks it — so the source check is "the record does not show the sentence being produced", not proof. A wrong call costs: one item is commented on and handed to a human (put the label back), and that agent is paused until the time read from the screen (lift it by hand, below).
- Handing over does not stop the session. The existing reaper closes it after it has been idle for the grace period (the conversation is kept; background commands in it end), and a claude that offers "continuing automatically" may carry on by itself at the reset time.
- Between the daemon's three writes (comment, add `pending/human`, remove `doing/agent`) everything is re-read. If the item, its PR (base branch, head commit, source), its labels or the local session changed, the daemon **stops and undoes nothing**. An item can therefore be left with both `pending/human` and `doing/agent`: it still takes a slot until a human removes `doing/agent`. A read that fails is not a change: the daemon waits and continues next round.
- A CLI that exits at once on launch is handled by the ordinary dispatch-failure path (there is no real sample of a limit shown that way), and there is no real sample of a *weekly* limit screen — it is matched by the same structure, not verified.

</details>

<details><summary>Look at / lift a pause by hand</summary>

The pause ends only at its time, or when its record is deleted — never because another session
looks busy. Run in any shell on the daemon's machine (nothing needs to be set for the first block):

<!-- usage-limit-ops:begin -->
```bash
DIR="$HOME/.local/state/cavil-loop/usage-limit"
# 1. look: which agents are paused on this machine, until when / 查看：本机哪些 agent 在暂停、到几点
found=0
for f in "$DIR"/*.json; do
    [ -e "$f" ] || continue
    found=1
    row=$(jq -er '[.agent, (.until | floor | tostring), .account, .item, .source] | @tsv' "$f" 2>/dev/null) \
        || { echo "unreadable, the daemon treats it as no pause / 读不出，daemon 按没有暂停处理: $f"; continue; }
    IFS=$'\t' read -r agent until account item source <<<"$row"
    when=$(date -d "@$until" '+%Y-%m-%d %H:%M %Z' 2>/dev/null || date -r "$until" '+%Y-%m-%d %H:%M %Z')   # GNU date / BSD date
    echo "$agent  until $when  account=$account  seen-on=$item  time-from=$source"
done
[ "$found" = 1 ] || echo "no pause record on this machine / 本机没有暂停记录"
```

```bash
# 2. lift a pause by hand: set AGENT, then run / 手动解除：先填 AGENT 再执行
AGENT=claude
DIR="$HOME/.local/state/cavil-loop/usage-limit"
rm -f "$DIR/$AGENT"-*.json
left=$(ls "$DIR" 2>/dev/null | grep -c "^$AGENT-" || true)
echo "pause records left for $AGENT: $left  (0 = lifted / 0 = 已解除)"
```
<!-- usage-limit-ops:end -->

After lifting, the next poll round dispatches to that agent again; if the account is in fact still
limited, the first worker to hit it is recognised and the pause comes back (there is nothing to
roll back). A project's own progress file is `$STATE_DIR/usage-limit.json` (dispatch start times,
and hand-overs in progress); leave it alone while a hand-over is in progress — deleting it then can
produce a second comment.

</details>

## Heavy tests: one at a time (optional, **off by default**)

Several workers running the full test suite at once stack memory and CPU until the machine stalls. With this on, the "heavy test" commands a project lists are let through one at a time under one system account and the rest wait; when an item is cleaned up, or the worker that started a test has ended, the tests it left behind are stopped. Off by default; turn it on by listing the heavy commands in the project's `cavil-loop.config`, one per line:

```bash
HEAVY_TEST_COMMANDS="bash tests/run.sh"
```

Leave `HEAVY_TEST_COMMANDS` empty (or remove the line) to turn it off.

<details><summary>What changes for workers, and turning it off</summary>

From the next dispatch on, the worker prompt gets one more section telling the agent to run these as `bash <skill>/scripts/heavy-test.sh -- bash tests/run.sh`; a single test file needs no queue. Workers already running are not affected (their prompt was fixed at start). To turn it off, leave `HEAVY_TEST_COMMANDS` empty (or remove the line).

</details>

<details><summary>How the queue works</summary>

- Each run goes into its own systemd scope (`cavil-heavy-<id>.scope`). The next run starts only when every "running" scope ahead of it has no process left — a killed wrapper, a test that closes inherited descriptors, a child that backgrounds itself or leaves the process group cannot release it early. While waiting it prints, every 30 seconds, which project and item it waits for and for how long.
- When the test's main process exits, the wrapper stops its own scope, so background children left behind end with it.
- Scope state is read from explicit answers only: "not found / inactive" means ended; a failed query, empty output or an unknown word counts as still running.
- A run record that cannot be read, or whose content is not recognised (any of its ten fields missing, a field given twice, a state other than queued / running, a scope name that does not match its id, only part of the project / item / generation ownership present), is not taken for "not running" either: its scope is looked up by the id, and the record is removed only once that scope is confirmed gone; while the scope is there it keeps blocking the queue and the worktree cleanup of items under this account, and the waiting notice and the poll log name the file. `--list` shows it as unreadable (「读不到」); once it is clear what that run is, `--stop <id>` stops it.
- No first-come-first-served guarantee, only no overlap. `HEAVY_TEST_LOCK_WAIT=<seconds>` caps the wait (exit code 75); default 0 = wait as long as it takes.

</details>

<details><summary>What happens when an item ends</summary>

- Dispatch (create the worktree, start the worker, record this launch) and `cleanup-issue.sh` (stop the session, stop the tests, remove the worktree) each hold one per-item lock from start to end, so they run one after the other. When the lock cannot be taken (60 seconds by default), dispatch does nothing this round and leaves the label, and cleanup changes nothing and exits non-zero.
- Every item has a generation, bumped by cleanup as soon as it holds the lock. A worker carries the generation it was started with, and a test checks it when it registers and again before it starts: on a mismatch (the item was cleaned after this worker started) it does not start, exit code 76. A worker dispatched after the cleanup gets the new generation and is not affected.
- Cleanup first stops this item's queued and running heavy tests and removes the worktree only after their scopes are confirmed gone. Unknown state or a failed stop → the worktree is kept and the exit code is non-zero; the automatic post-merge cleanup then does not record the item as cleaned and retries next round, and the PR's `Done` label waits for the round in which cleanup succeeds.
- Each worker launch records the worker's pid and start time (registered before the worker starts, completed with the pid once it is up). Every poll round checks them: when that process is gone (or the pid now belongs to another process) while a test it started is still queued or running, the whole scope is stopped. A worker that is alive, or one that cannot be identified, is left alone. A launch confirmed as ended is marked, not deleted, so a late request left behind by that worker does not start either (exit code 76); the record is removed when the item is cleaned up.

</details>

<details><summary>See who holds the queue, stop one run by hand</summary>

<!-- heavy-test-ops:begin -->
```bash
SKILL="$HOME/.agents/skills/cavil-loop"
IDF="$(mktemp)"
bash "$SKILL/scripts/heavy-test.sh" --id-file "$IDF" -- sleep 120 &
while [ ! -s "$IDF" ] && kill -0 $! 2>/dev/null; do sleep 0.2; done
bash "$SKILL/scripts/heavy-test.sh" --list
bash "$SKILL/scripts/heavy-test.sh" --stop "$(cat "$IDF")"
wait
bash "$SKILL/scripts/heavy-test.sh" --list
rm -f "$IDF"
```
<!-- heavy-test-ops:end -->

In order: start a run (`sleep 120` stands in for a real test command) and have it write **its own run id** to a temporary file once it is registered; wait for the id; list every run registered under this account (id, queued / running, scope state, project and item, command, age); stop exactly that run by its id (its command exits with 143) — it is stopped the same way while still queued; list again. Other items' runs may be in the list at that point and these commands do not touch them: always name the run to stop by its id, never pick "the first running one" from the list — that may well belong to another item. To stop one run in everyday use, read `--list` for the project, item and command first, then `--stop <its id>`. `--stop` removes the record only after the scope is confirmed gone; when the scope's state cannot be read it sends no stop request, reports an error and keeps the record.

</details>

<details><summary>Limits</summary>

- The full behavior needs Linux + cgroup v2 + a systemd user manager. Where these are plainly absent (not Linux, not cgroup v2, no `systemd-run` / `systemctl`, no user-manager socket for this account — macOS, for one) only the wrapper itself is queued: no scope, no record, no cleanup, and a notice is printed. When the user manager exists but did not answer this time, or the scope cannot be created, the wrapper exits with 70 and does not run the test — it never degrades silently, because the degraded mode cannot see existing scopes and would start while the previous run is still going. In degraded mode it also exits with 70 while run records are still registered: once those runs are known to have ended, remove the records under `~/.local/state/cavil-loop/heavy-test/runs/` and retry.
- "Machine-wide" means one system account: the queue lock and the run records live under `~/.local/state/cavil-loop/` (`heavy-test.lock`, `heavy-test/runs/`); different accounts do not queue behind each other.
- Only tests started through the wrapper are queued or stopped. A command the worker runs directly, a dev server, any other background process is neither queued nor stopped.
- A test moved into its own scope is no longer under a memory cap set on the tmux pane's scope. Use `HEAVY_TEST_SCOPE_PROPERTIES="MemoryMax=6G"` (space-separated systemd properties) when a cap is needed; none by default.
- A forced cleanup (`--force`) of an item whose worker is busy still stops that worker; what the item lock guarantees is that cleanup never interleaves with a launch in progress.

</details>

<details><summary>What turning it off leaves behind</summary>

After `HEAVY_TEST_COMMANDS` is emptied, later dispatches no longer carry the section and no longer take the item lock. Workers started before that may still run tests through the wrapper; those queue as usual, and runs still registered are stopped at item cleanup and by the poll round — nothing to do by hand; use `--stop` above to stop one right away. `item-locks/`, `item-gen/` and `worker-launch/` left in the project's state directory need not be removed.

</details>

## Report a failed test workflow on the base branch (**off by default**)

When a listed test workflow goes red on the base branch after a merge (two PRs that each passed,
a changed environment, a flaky test), the daemon opens an issue for it, or comments on the open
report of the same cause. Off by default; set `CI_FAILURE_REPORT_WORKFLOWS` to turn it on, leave
it empty to turn it off (see "Turning it off" below first).

```bash
CI_FAILURE_REPORT_WORKFLOWS="tests.yml"   # workflow file names, space or comma separated; empty = off
CI_FAILURE_REPORT_BRANCH="main"           # the branch whose runs are watched
CI_FAILURE_REPORT_DISPATCH=false          # true: a new / reopened report gets the dispatch label
CI_FAILURE_REPORT_MAX_FIX_ATTEMPTS=2      # this many different fix PRs still red → hand to a human
```

<details><summary>Before turning it on</summary>

- Do not list a workflow that already reports itself (this repository's `release.yml` does).
- **Turn it on on one machine per repository**: the "do not dispatch" list below is local, so a
  second machine polling the same repository could still dispatch a report that is being handed
  over (only with `CI_FAILURE_REPORT_DISPATCH=true`).
- **Needs** `python3` on the machine (standard library only) besides the tools the daemon already
  requires. Without it the check does not run (one log line per round) and this feature's reports
  are held back from dispatch.
- **Token.** Reads use `GH_TOKEN`: it must be able to read Actions runs and check-run
  annotations (fine-grained: *Actions: read*, *Checks: read*). A rate limit is waited out and never
  reported as a permission problem; a plain 403 / 404 is logged once a day.

</details>

<details><summary>What is watched</summary>

Runs of the listed workflows on that branch, triggered by a push, created at or after the moment
you turned it on. Only a run's first attempt counts: a re-run, red or green, writes nothing. The
check runs every 5 minutes inside the poll (under the poll lock, *before* the idle-backoff gate,
so it keeps its own clock while the poller backs off). After downtime it continues from where it
had completely checked — nothing is skipped, reports just arrive late.

</details>

<details><summary>Where a red run goes</summary>

First match wins:

| the run | goes to |
|---|---|
| its commit is the merge of a PR whose body refers to a report (`Closes` / `Fixes` / `Resolves` / `Refs #N`, keyword and number on one line) | that report: "fix #P merged, still failing (k-th time)". A report closed as completed is reopened. Counted per fix PR |
| CI marked the failed tests completely, and they are exactly those of an open report | a comment on that report |
| CI marked them completely, no open report matches | a new report |
| CI's list is incomplete (a failed job without an error annotation, or a step with 10 of them — GitHub keeps at most 10) | this workflow's single open "cause not confirmed" report, which says in so many words that its failures need not share a cause |

"The same cause" therefore means "the same failed test files" (what this repository's
`tests/run.sh` annotates): two different assertions breaking inside one test file are treated
as one cause. When the workflow goes green again, each open report gets one "green again" comment;
reports are never closed automatically. A report closed as *not planned* / *duplicate* is left alone.

</details>

<details><summary>Hand-over to a human</summary>

When `CI_FAILURE_REPORT_MAX_FIX_ATTEMPTS` different fix PRs have failed, the report enters the
local *do not dispatch* list first, then its comment says so, the dispatch labels are removed and
`pending/human` is added. While it is on the list no dispatch entry (label, greedy, autopilot)
starts a worker for it, whatever labels it carries. It leaves the list when the hand-over is
confirmed, or as soon as a person changes one of its flow labels or closes it — the daemon then
does not touch it any more. A report that is waiting in another flow (`doing/agent`, review,
blocked, …) stays on the list untouched until that changes.

</details>

<details><summary>The log excerpt and time limits</summary>

The log excerpt is untrusted text: timestamps and colour codes are stripped, token-like strings
masked, the last 80 lines / 6000 characters kept, hidden-marker look-alikes defused, and it goes
into a code block whose fence is longer than any backtick run in it.

Nothing here uses coreutils `timeout`, which macOS lacks: the checker bounds every `gh` call
itself (60 s) and the whole round (90 s), and the poller waits for it with bash builtins and stops
it — together with `gh` and anything it started, as one process group, waiting until none is left,
so no late write follows — if it still has not returned 120 s after that.

</details>

<details><summary>State file and how to look at it</summary>

`$STATE_DIR/ci-failure-report.json` (deliberately not in `state.json`) holds, per workflow, the
enable time, how far the runs were completely checked, the runs not settled yet, and the
*do not dispatch* list. Look at it with:

<!-- ci-failure-report-ops:begin -->
```bash
KEY=myproject    # the instance name / 实例名: systemctl --user list-timers 'cavil-loop-poll@*'
SKILL="$HOME/.agents/skills/cavil-loop"
ENV_FILE="$HOME/.config/cavil-loop/$KEY.conf"
[ -f "$ENV_FILE" ] || ENV_FILE="$HOME/.config/coding-agent-work-loop/$KEY.conf"   # installed before the rename / 改名前装的
CONF=$(sed -n 's/^CODING_AGENT_CONFIG=//p' "$ENV_FILE" | tr -d '"')
CODING_AGENT_CONFIG="$CONF" bash "$SKILL/scripts/ci-failure-report.sh" --list
```
<!-- ci-failure-report-ops:end -->

</details>

<details><summary>If the state file is lost or damaged</summary>

If that file is lost or damaged while GitHub already has reports of this feature, the daemon
does not reconstruct it — what it had decided but not yet written cannot be read back from GitHub.
It pauses: no checks, no writes, none of this feature's reports is dispatched, and one notice
issue (`pending/human`) lists every open report with its labels. **Failures between the loss and
the restart are not reported** (look at the Actions page yourself), and a hand-over that was
half done is not resumed — set that report's labels yourself. Then restart from now:

<!-- ci-failure-report-restart:begin -->
```bash
KEY=myproject    # the instance name / 实例名: systemctl --user list-timers 'cavil-loop-poll@*'
SKILL="$HOME/.agents/skills/cavil-loop"
ENV_FILE="$HOME/.config/cavil-loop/$KEY.conf"
[ -f "$ENV_FILE" ] || ENV_FILE="$HOME/.config/coding-agent-work-loop/$KEY.conf"   # installed before the rename / 改名前装的
CONF=$(sed -n 's/^CODING_AGENT_CONFIG=//p' "$ENV_FILE" | tr -d '"')
CODING_AGENT_CONFIG="$CONF" bash "$SKILL/scripts/ci-failure-report.sh" --restart
```
<!-- ci-failure-report-restart:end -->

It prints `已从当前时刻重新开始` on success; the next poll comments on the notice issue and
closes it. If it fails it changes nothing and the pause stays — fix the cause and run it again. It
refuses to run when nothing is paused. Fix counts are read from the reports' comments, so they
survive the restart.

</details>

<details><summary>Turning it off</summary>

Run the `--list` command first and wait until it prints `不派工名单：空`: with the setting empty
the list is neither consulted nor worked on, so a hand-over in progress would stop where it is.
Then empty `CI_FAILURE_REPORT_WORKFLOWS`. Setting it again later continues from the kept state
file.

</details>

## GitHub token redaction

A worker's environment holds a GitHub token, and an agent can print it verbatim while it works (running `env`, debugging `gh`, an error that echoes request headers). The daemon replaces GitHub tokens in the files that keep such output, with one set of matching rules (`scripts/redact_tokens.py`). It is always on for the daemon's own logs; the two other places have their own switch (table below).

<details><summary>Which files are cleaned</summary>

| File | Written by | What happens | Switch |
|---|---|---|---|
| `poll.log`, pane history (`$STATE_DIR/sessions/*.log`) | the daemon | Replaced **before it reaches disk** | always on |
| claude / codex session records (`~/.claude/projects`, `~/.codex/sessions`) | the agent's CLI | Scanned every 10 minutes and replaced **in place**, only for sessions whose working directory is under this project's `WORKTREE_BASE` | `REDACT_AGENT_RECORDS` (on by default; empty / `false` = leave them alone) |
| codex environment snapshots (`~/.codex/shell_snapshots/*.sh`) | codex | Not rewritten: codex workers start with the feature turned off (`--disable shell_snapshot`), so **no new snapshot is written**; clean the existing ones once (next section) | `CODEX_SHELL_SNAPSHOT` (`off` by default; `on` = keep codex's default behaviour) |

</details>

<details><summary>What each place does in detail</summary>

- `poll.log` and pane history: the log function, cleanup-hook output, tmux errors, the instant-exit / trust-dialog pane captures, the old log merged in during migration and the live pane-history pipe all go through one entry point before anything is written.
- Session records: only the token's bytes change, the file keeps its length and name, nothing is deleted, no backup is kept.

</details>

<details><summary>What a replaced token looks like, and the scan record</summary>

A replaced token reads `REDACTED-<12-character fingerprint>`, padded with `-` to the original length. The fingerprint is the first 12 hex characters of the token's sha256: it cannot be turned back into the token, and one token has the same fingerprint in every file, so it tells you *which* token it was:

```bash
printf '%s' "$GH_TOKEN" | sha256sum | cut -c1-12
```

Whenever a scan replaced something, `poll.log` gets a line `令牌脱敏：N 个文件里替换了 M 处（指纹 …）`. Scan positions live in `$STATE_DIR/redact-scan.json` and the time of the last scan in `$STATE_DIR/redact-scan.stamp`; delete both to have the next round scan everything from the start (what is already replaced does not change again).

</details>

<details><summary>Why session records can be edited in place</summary>

The weekly report and the usage footer read these files, and the agent's CLI keeps them open and appends. A replacement touches only the token's bytes and writes characters of the same kind (letters, digits, `-`), so every line reads as the same JSON structure at any moment; strings in the fields used to claim a record (working directory, session id, request id, timestamp, model, …) are left alone even when they look like a token. `tests/token-redaction.test.sh` runs the real weekly-report collector while a replacement is half written and gets byte-identical results.

</details>

<details><summary>Not covered (the original text may still be there)</summary>

- Old-format tokens without a prefix (40 hex characters): indistinguishable from a commit hash, not matched
- Pane history is raw terminal output: a token the terminal wrapped, or one with control codes in the middle, is not recognised (one right after a colour code is)
- Sessions that were running before the upgrade and whose worker pane cannot be identified (a person split the window and there is no pane record): their log pipe is not switched to the filtering one, so what they write later is only replaced afterwards by the periodic scan
- Sessions whose working directory is not under `WORKTREE_BASE` (claude / codex a person started by hand), claude's input history and file-edit backups, cursor / opencode records
- Secrets other than GitHub tokens (for example other login tokens in a codex snapshot)
- When the redaction script itself cannot start (for example no `python3`): the daemon's log entry points write one line `令牌替换失败…已丢弃` and pane history stops being written — a missing record rather than the original text

</details>

### Cleaning the existing codex environment snapshots

New codex workers write no snapshot, but snapshots written earlier are still there, each with `GH_TOKEN` in clear text. Clean them once with the command below; it only acts when **the current user has no codex process at all**, because a running codex still reads its own snapshot and would switch to a fake token.

<details><summary>The cleanup command and how to read its result</summary>

With a codex process running, or when the process list cannot be read, the script prints the reason and exits without changing a file. Let the codex workers finish (or stop the processes it lists), then run this as written:

<!-- redact-ops:begin -->
```bash
SKILL="$HOME/.agents/skills/cavil-loop"    # the installed skill / 装好的 skill 目录
SNAPS="$HOME/.codex/shell_snapshots"
with_token() { grep -lE 'gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{82}' "$SNAPS"/*.sh 2>/dev/null | wc -l; }
echo "snapshots holding a token before / 清理前带令牌的快照: $(with_token)"
if bash "$SKILL/scripts/redact-snapshots.sh" --check; then
    bash "$SKILL/scripts/redact-snapshots.sh"
fi
echo "snapshots holding a token after / 清理后带令牌的快照: $(with_token)"
```
<!-- redact-ops:end -->

`完成：N 个快照文件，其中 M 个含令牌，共替换 K 处` followed by a last line of 0 means it is done. `❌ 本机还有 codex 进程在跑` means nothing was changed: rerun once the listed processes have ended. A replacement cannot be undone (there is no backup) and does not need to be: the token itself is unchanged and the worker's environment still has it. `--check` only checks and changes nothing.

</details>

## Post-merge retrospectives

After a PR is merged, a background queue has a model read the PR's whole discussion, write a report to
`docs/retrospectives/pr-N.md` in the source project and update the project's counted lessons file,
which later dispatch and review prompts carry. Off unless `POST_MERGE_RETROSPECTIVE=true`; set it to
`false` to pause it (the queue is kept). It needs Python 3, a Claude CLI with safe mode and structured
output, and push access to the project.

<details><summary>What it reads, what it writes, and where</summary>

- The first run records the activation time; later scans paginate updated closed PRs and enqueue only
  merges after it. Closed-unmerged PRs are excluded. Automatic cleanup need not be enabled.
- The collector reads the associated issues, conversation comments, reviews and inline comments with
  pagination. Claude (`RETROSPECTIVE_MODEL=sonnet`) receives the evidence without tools or MCP access.
- A fixed publisher commits only `docs/retrospectives/pr-N.md` and
  `.agents/skills/cavil-loop/prompts/lessons.md` (plus whatever an optional project command changes,
  below) to the **source project's** `origin/$BASE_BRANCH` (`main` by default), using an isolated
  worktree and fast-forward-only push. Project lessons are loaded from that project's remote ref into
  its prompts, before project extras.
- The public cavil repository only holds independently reviewed, project-neutral workflow rules in
  `prompts/lessons.md`. The automatic publisher never writes generated project content, identifiers,
  links or reports there. Generalization candidates stay in the project report until separately
  reviewed for public suitability. Report evidence remains in the source project and local state
  directory.
- No existing comments or worker labels are changed.

</details>

<details><summary>The counted lessons file: ids, sightings, promotion</summary>

Project lessons are a counted error book (format and checks: `scripts/retrospective_lessons.py`).
Each rule has a permanent id `L<n>`; the section it sits in (`硬规则` hard rules / `待确认` awaiting
confirmation / `观察中` watching) is its state, and `Seen N×` lists the distinct PRs it occurred in.

- A run may only add **this PR** to a rule, once, citing the URL of a comment / review collected for
  this PR. A rule's 规则/适用 (rule/applies) fields, its id and its earlier sightings are locked; a
  different meaning is a new rule starting from one.
- A rule reaching 3 distinct PRs is promoted when it is within the length limit described below (an
  over-long one waits in `观察中`): `RETROSPECTIVE_PROMOTION=auto` (default) moves it into `硬规则`,
  `confirm` only into `待确认`, from where a human edit moves it on. Any violation voids the whole
  output. The self-review and cross-review templates check every hard rule one by one.
- While a project's lessons.md is in an old, uncounted format the run is skipped before the model
  call, without counting an attempt, and retried hourly until the project migrates it.

</details>

<details><summary>What a prompt gets: a trimmed copy</summary>

For a file in the counted format (it has the `<!-- next-id: N -->` line), dispatch and review prompts
carry the preamble plus each `硬规则` / `待确认` entry's id, 规则, 适用 and 为什么; the whole `观察中`
section, every 这样做是对的 example and every `Seen` line stay in the file only, and one closing line
tells the agent where to read them. A file without the `next-id` line (the skill's public lessons, a
hand-written file) goes in as it is. The file itself is unchanged and the retrospective reads and
rewrites all of it.

</details>

<details><summary>Length limit on promotions (<code>RETROSPECTIVE_RULE_MAX_CHARS</code>)</summary>

`RETROSPECTIVE_RULE_MAX_CHARS` (default 300, `0` = no limit, an empty value = 300) caps an entry being
promoted: its 规则 + 适用 + 为什么 together, counted in characters (a CJK character is one; the
`- 规则：` prefixes do not count).

- The retrospective program, not the model, places promotions: an entry that just reached 3 PRs and
  fits goes to `硬规则` (`auto`) or `待确认` (`confirm`); one over the limit stays in `观察中`, its id
  goes into one line right under next-id, `<!-- held-over-limit: L12 L34 -->`, and the report ends
  with a section the program writes (id, characters, limit, what to do), plus one line in
  `retrospective.log` (`rule length limit 300: held back L12(312)`). The model may rewrite 为什么
  shorter, and then the entry is judged on the shorter text in the same run; 规则 / 适用 stay locked.
- Once a held entry fits — a human shortened it on the base branch, or raised the limit, or set it to
  `0` — the next retrospective (after any merged PR) promotes it into the section the current mode
  names and drops it from the line.
- To keep an entry in `观察中` for good, delete its id from the line; when it was the last id, either
  leave the empty line `<!-- held-over-limit: -->` or delete the whole line — both are fine, and the
  next retrospective writes no line at all. Deleting the whole line while it still lists ids stops
  every held entry from being promoted later.
- Ids on the line that do not qualify (no such entry, not in `观察中`, fewer than 3 PRs — typing an id
  there never promotes it) are dropped and listed in the report. Entries already in `硬规则` /
  `待确认` are never measured and never moved back.
- The line is never shown to the model and never goes into dispatch prompts; a model output that
  carries it is rejected (one attempt). A line a human edit broke (not of that form, given twice,
  moved above next-id or into a section) holds the retrospective before the model call, without
  counting an attempt, retried hourly, with the line number in the job's error — fix or delete the
  line.

</details>

<details><summary>If the limit is mistyped</summary>

Anything but an integer from 0 to 100000 in plain decimal (no sign, no leading zeros: `300`, not
`0300` or `+300`) stops every retrospective round before it reads the queue: `retrospective.log` ends
with `RETROSPECTIVE_RULE_MAX_CHARS must be an integer from 0 to 100000 written without leading zeros, not '…'`
and no new retrospective lines follow; no job's state or attempt count changes. Fix the line in the
project config (or delete it, = 300; the desktop client's 项目配置 dialog edits it too). Success: after
the next poll `retrospective.log` shows new lines such as `retrospective PR #N started` / `committed`,
and the mistyped-value line no longer appears. No job file needs editing: the waiting jobs carry on
with the attempt counts they had.

</details>

### Directory lessons and which PRs get retrospected

`RETROSPECTIVE_DIRECTORY_LESSONS` is **on by default**: the retrospective then handles only PRs merged
at or after the moment the switch took effect on this machine, and each may write lessons tied to the
directories it touched into the `## 目录经验` section at the end of lessons.md. Set it to `false` to
retrospect every queued PR and write no directory lessons.

<details><summary>Which PRs are skipped, and how a run classifies the queue</summary>

- PRs merged before the switch took effect that are still waiting in the queue are marked `skipped`
  in their job file (kept, not deleted) and **never retrospected**: no report, not counted in any
  lesson. The retrospective adds the `## 目录经验` heading itself if it is missing.
- With the switch off, every queued PR is retrospected and no directory lessons are written (the
  section, if present, is kept byte for byte: the model is not shown it). Turning it off and on again
  starts counting anew, so PRs merged while it was off and still queued are skipped too. Any value
  other than `true` / `false` stops the run before it reads or writes anything.
- Each run first classifies the whole queue (every unfinished job, whatever its place or retry time;
  a PR whose report is already on the base branch counts as done; a job whose merge time or
  base-branch report cannot be read is left as it is for the next round), then retrospects at most one.
- The start time is kept per machine in `$STATE_DIR/retrospectives/directory-lessons.json` (never in
  `cursor.json`); a new machine or a lost file starts counting from then. If that file is unreadable
  or cannot be written while the switch is on, the whole queue pauses for that round (logged with the
  file's path) — it cannot tell which PRs to skip.

</details>

<details><summary>The directory-lesson entry format</summary>

Directory-lesson entries use the same format and share `next-id`, but every sighting names where it
happened: `- Seen 2×: #1460 <url> [server/credits/] · #1471 <url> [server/credits/ · server/usage/]`.

- Directories are relative to the repository root and end in `/`; every new sighting must name at
  least one, each must be a real directory in the merged tree (no absolute paths, `..`, `.git`, or
  links out of the repository).
- Old entries and sightings, directories included, never change; a PR is counted once per entry;
  copying a process lesson verbatim into this section is rejected; a model adding the heading itself
  is rejected.
- The section never promotes and entries never move in or out of it. Per-directory counts are left to
  the project, and prompt composition leaves the section out, so these lessons reach agents only
  through the project's own per-directory instructions.
- The 24 000-character limit covers the whole file except this section (not the trimmed copy prompts
  get); this section has its own 24 000.

</details>

<details><summary>If turning the switch off could not be recorded: start counting again</summary>

Turning it off leaves a record (the start-time file says off, or is removed, or `cursor.json` gets a
note — always the note when the start-time file cannot be read, which is then left as it is). A start
time recorded because of such a note remembers it, so a note that could not be cleared afterwards is
only cleared again, never taken for a new off. If all three writes fail in that round, the queue
pauses and `retrospective.log` says so with the file's path; if the switch is then turned back on
before anyone acts, the old start time is reused and PRs merged while it was off may be retrospected
and get directory lessons. To start counting again (stop, keep evidence, reset, restart):

<!-- retro-dir-recovery:begin -->
```bash
(
# Every step ends in "|| exit": nothing after a failed step runs.
# 1) This project's state directory: replace <project> with the project's key, the
#    directory name under ~/.local/state/cavil-loop/ (also the timer's instance name).
STATE_DIR="$HOME/.local/state/cavil-loop/<project>"
Q="$STATE_DIR/retrospectives"
TIMER="cavil-loop-poll@$(basename "$STATE_DIR").timer"
# 2) Stop this project's poller, then take the retrospective's scan lock and keep it
#    until this block ends: a retrospective already running finishes first, and one
#    started later (by a poll that was already under way) gives up while we hold it.
systemctl --user stop "$TIMER" || exit 1
exec 9>>"$Q/scan.lock" || exit 1
flock 9 || exit 1
# 3) Keep the evidence: copy the start-time file and the scan record (copy only).
ts=$(date -u +%Y%m%dT%H%M%SZ) || exit 1
if [ -e "$Q/directory-lessons.json" ]; then cp -p "$Q/directory-lessons.json" "$Q/directory-lessons.json.bak-$ts" || exit 1; fi
cp -p "$Q/cursor.json" "$Q/cursor.json.bak-$ts" || exit 1
# 4) Reset the start time: remove the start-time file only.
rm -f "$Q/directory-lessons.json" || exit 1
test ! -e "$Q/directory-lessons.json" || exit 1
# 5) Release the lock, then start the poller again.
exec 9>&- || exit 2
systemctl --user start "$TIMER" || exit 2
)
case $? in
0) echo "reset done" ;;
2) echo "reset done, but the poller did NOT start again: run  systemctl --user start cavil-loop-poll@<project>.timer" ;;
*) echo "reset FAILED: stopped at the step that printed the error above; no later step ran" ;;
esac
```
<!-- retro-dir-recovery:end -->

Every step runs only if the one before it succeeded. Success: the block prints `reset done`, and the
next `retrospective.log` line reads `directory lessons on: handling PRs merged at or after <time>`
with a time after the reset. The scan lock is held from step 2 to the end of step 4, so no
retrospective runs while the evidence is copied and the start time reset. Three outcomes:

- `reset done` — all done.
- `reset done, but the poller did NOT start again` — the reset is complete (start-time file gone,
  backups kept); only the restart failed: run the printed `systemctl --user start` command.
- `reset FAILED` — nothing after the failing step ran and the reset has not happened: a failed stop
  leaves the poller as it was; a later failure leaves it stopped with the start-time file and
  `cursor.json` untouched (a failed backup deletes nothing). Fix the cause (disk, permissions — an
  unreadable start-time file cannot be backed up either) and run the whole block again.

On a pre-rename install the timer is `coding-agent-poll@<project>.timer`. The reset cannot undo
directory lessons already committed under the old time: check `git log -p -- <lessons file>` on the
base branch for `docs: learn from` commits in that window and remove the wrong entries by hand (a
human edit is simply the next baseline).

</details>

### Project command after the retrospective (optional)

`POST_RETROSPECTIVE_PROJECT_CMD` (empty = off) runs a command of your own in the retrospective's
temporary checkout after the report and lessons are written and before the commit — e.g. a script
that ranks directory lessons and writes them into each directory's `AGENTS.md`. Its changes go into
the same commit. It runs with the daemon user's own permissions, so configure trusted commands only.

<details><summary>What the command gets, and when it fails the retrospective</summary>

- It runs with `bash -c` at the root of the checkout, after the report and lessons are validated and
  written. It gets `RETROSPECTIVE_PR`, `RETROSPECTIVE_LESSONS_FILE` and `RETROSPECTIVE_REPORT_FILE`
  (paths relative to the root) and a 10-minute limit.
- Everything it changes or creates goes into the same commit as the report and lessons, except files
  the repository's ignore rules exclude — a script that leaves stray files behind needs fixing.
- A non-zero exit, a timeout, changing the validated report or lessons, or committing on its own fails
  this retrospective: nothing is pushed, the temporary checkout is removed, and the usual retry
  applies (hourly, 3 attempts; each retry calls the model again). Its output tail is logged on success
  and kept in the failure reason.
- The checkout is fresh from the base branch, so untracked things such as `node_modules` are not there.
- **It runs with the daemon user's own permissions**: the retrospective's GitHub tokens (`GH_TOKEN` /
  `GITHUB_TOKEN`) are not passed on, but that is not isolation — a stored `gh` login or git
  credentials stay reachable, and a push made outside this checkout cannot be stopped.

</details>

### Concurrency, retries and status

One retrospective runs across all local projects at a time; a PR that fails 3 times in a row is
parked until a human sets its job file back to `pending`. Status, evidence and retries are in
`$STATE_DIR/retrospective.log` and `$STATE_DIR/retrospectives/`.

<details><summary>Details</summary>

- The machine-wide lock is `~/.local/state/cavil-loop/retrospective.lock`, independent of how the
  skill is deployed.
- The model timeout is 30 minutes and failures retry after one hour; a parked PR has `status: failed`
  in its job file, with the reason in the log.
- Remote project reports are completion markers.

</details>

## On-demand preview (socket activation)

Gives every issue awaiting acceptance a clickable preview URL without keeping one web server resident
per open issue: the URL is always listening, the app starts on the first visit and stops again once
idle. Off by default; setting `PREVIEW_EXEC` (the command that starts your app) turns it on, and
`scripts/preview-serve.sh` registers a preview; your cleanup hook deregisters it.

<details><summary>Commands: register, list, deregister by hand, deregister from the cleanup hook</summary>

By hand:

```bash
bash scripts/preview-serve.sh 791          # register + listen, print the URL
bash scripts/preview-serve.sh 791 --warm   # also warm it up now (skip the 1s before a review)
bash scripts/preview-serve.sh --list       # every preview in this project and whether it is up
bash scripts/preview-unserve.sh --issue 791  # deregister by hand: the expected worktree is the one the config gives #791
```

From the cleanup hook (the script `CLEANUP_HOOK` names, run from the project's own directory), call the script by the skill's installed path and always pass the worktree the hook was given. The hook is handed the real
`ISSUE` and `WORKTREE`; without `--expect-worktree` the script assumes the worktree the config would
give that number, and could deregister a preview that belongs to another worktree with the same number:

<!-- preview-unserve-hook:begin -->
```bash
# CLEANUP_HOOK script: deregister this item's preview / 清理挂点脚本：注销本条目的预览
# An empty WORKTREE means "not trusted": skip, exit 0 / WORKTREE 为空表示不可信：跳过，退出 0
if [ -n "${WORKTREE:-}" ]; then
    cd "$PROJECT_ROOT" || exit 1
    bash "$HOME/.agents/skills/cavil-loop/scripts/preview-unserve.sh" --issue "$ISSUE" --expect-worktree "$WORKTREE"
fi
```
<!-- preview-unserve-hook:end -->

A port, owner or worktree that does not match means nothing is deregistered. An install from before the rename has the skill at its old path; use that path instead.

</details>

<details><summary>Why socket activation, and how the units fit together</summary>

A resident `tmux` session running a web server per issue keeps every open issue's server in memory
while nobody looks at it — ten waiting issues mean ten idle servers, close to 1 GiB of memory. Socket activation separates "the URL is always up" from "the process is always
resident":

```
tailscale serve :4791 (or hit 127.0.0.1:4791 directly)
        │
cavil-loop-preview@4791.socket        always listening, ~0 memory
        │ first connection triggers
cavil-loop-preview@4791.service       systemd-socket-proxyd, exits on --exit-idle-time
        │ Requires
cavil-loop-preview-app@4791.service   your server; StopWhenUnneeded takes it down too
```

Measured: ~0.4s cold start (plus your app's own startup), 0.01s warm, all memory returned once idle,
and the next hit brings it back. **No rebuild** — the worktree's build output is still on disk.

</details>

<details><summary>When a URL is printed</summary>

**A URL is printed only when the preview really came up.** If any step fails (the listener does not
start, the app does not start under `--warm`, or the warm-up request through the public port does not
get a 2xx/3xx), `preview-serve.sh` exits non-zero, **prints no URL**, and dumps the last 20 journal
lines of that unit to stderr. Without `--warm` it only confirms the listener is up — the app starts on
the first visit — so the output says the page has not been visited yet; pass `--warm` when you want to
be sure before handing the link to a person. The warm-up request times out after
`PREVIEW_PROBE_TIMEOUT` (default 30 s).

</details>

### Port ownership once ports wrap

With `PREVIEW_PORT_MODULO` set (e.g. 1000) the port is `BASE + issue % MODULO`, so congruent issues
share a port, and every port has an **owner** recorded in `<port>.conf` (project + full issue number +
worktree). The one rule: **only ever touch a port registered to you; if there is no registration,
touch nothing**.

<details><summary>What register and deregister do with someone else's port</summary>

Example: issues 40 and 1040 both get port 4040.

- `preview-serve.sh` finds the port registered to someone else (a congruent issue, or another
  project) → exits 2 naming the owner, writes nothing
- `preview-unserve.sh --issue N` / `--port P --expect-issue N` only deregisters when all three owner
  fields match; no registration → exit 0, untouched; different owner → exit 3, untouched. The bare-port
  call `preview-unserve.sh <port>` still works, but takes the expected owner from the `ISSUE` /
  `WORKTREE` env the cleanup hook receives and is refused without them
- read registration → compare → write conf / systemd / tailscale all happen under one per-port lock
  (`.port-<port>.lock`) shared by register and deregister; concurrent registration yields exactly one
  winner
- unregistered leftover tailscale routes are **not** removed automatically: the port may have been
  reused by another service. Check what a route points at before removing it by hand

Guarded by `tests/preview-port-ownership.test.sh`.

</details>

### Three things you must know

The app must listen on `$PORT` / `$HOST` (the backend port, not the public one), every value in the
preview conf file must be quoted, and the readiness gate in the app unit must stay.

<details><summary>① The app gets the backend port, not the public one</summary>

The public port belongs to the `.socket`; the app binding it again would get `EADDRINUSE`.
`preview-run.sh` injects `$PORT` = public port + `PREVIEW_BACKEND_OFFSET`. So whatever `PREVIEW_EXEC`
starts **must read its listen address from `$PORT` / `$HOST`** — an app with a hardcoded port cannot
be wired in.

</details>

<details><summary>② Quote every value in the conf file</summary>

`~/.config/cavil-loop/preview/<port>.conf` has two readers: systemd's `EnvironmentFile=` (everything
right of `=` is the value, quotes optional) and the bash `source` in `preview-run.sh` (without quotes,
`PREVIEW_EXEC=node server/index.mjs` parses as "run `server/index.mjs` with a temporary environment
variable" and exits 127). `preview-serve.sh` gets this right; watch out if you hand-edit a conf.

</details>

<details><summary>③ Do not drop the readiness gate</summary>

`Type=exec` only guarantees that execve succeeded, not that the app has `bind`ed. Without the
`ExecStartPost=preview-wait.sh` line in `cavil-loop-preview-app@.service`, the proxy forwards before
node is listening and the **first request reliably 502s** — an app that takes 300ms to start is enough
to trigger it, and manual local testing often misses it.

</details>

### When the app fails to start

The socket re-triggers repeatedly, hits `TriggerLimitBurst`, and goes `failed`: it **stops accepting
activation** and the URL dies silently. Read the app's journal, fix the config, and rerun
`preview-serve.sh`.

<details><summary>Diagnose and recover</summary>

`systemctl start` is a no-op on the failed socket, so the unit state does not make the problem
obvious. To diagnose and recover:

```bash
journalctl --user -u 'cavil-loop-preview-app@4791.service' -n 50
bash scripts/preview-serve.sh 791     # includes reset-failed; re-run after fixing the config
```

</details>

### Relationship to cleanup

A preview lives and dies with its issue: `preview-serve.sh` uses `systemctl start`, not `enable`, so it
does not come back after a reboot. Deregistering it when the issue closes is your job — add a
`preview-unserve.sh` call to your project's `CLEANUP_HOOK`.

<details><summary>The deregister line for the cleanup hook</summary>

After a reboot `cleanup-issue.sh` has usually removed the worktree already, which is why previews are
not enabled. The hook should call
`preview-unserve.sh --issue "$ISSUE" --expect-worktree "$WORKTREE"` (**always pass the hook's actual
`WORKTREE`**: with `--issue` alone the expected owner is the path derived from config, so a cleanup
from a same-numbered but different worktree could release someone else's registration; if `WORKTREE`
is untrustworthy, skip deregistration rather than falling back to the default path). You have to add
that line yourself, since `cleanup-issue.sh` has no way to know whether you enabled previews.

</details>

## Public entry for comment images: images and videos only

Comment images must be fetchable by GitHub, so the asset directory (`review-shots`) is exposed through a public tunnel. Put the bundled server `scripts/public-assets/serve.mjs` behind the tunnel — never a plain static file server. It is not installed by `setup.sh`: enable it once per machine (steps in the fold below).

<details><summary>Why not a static file server</summary>

Comment images must be fetchable by GitHub, so the asset directory (`review-shots`) is exposed through a public tunnel. **Do not hand that directory straight to a static file server** (for example by pointing the tunnel at the directory): it lists the file names in every subdirectory and serves any file as is — a log, a test report or a login-state file a worker dropped there becomes public. Putting an `index.html` in each directory to hide the listing is not reliable either: new subdirectories are missed, and it does nothing about file types.

</details>

<details><summary>What the bundled server serves</summary>

Put the bundled server (`scripts/public-assets/serve.mjs`) behind the tunnel instead:

- listens on `127.0.0.1` only; answers GET / HEAD only
- serves a file only when its extension is an image / video (`png jpg jpeg gif webp avif svg mp4 webm mov`) **and its first bytes really are that format**; an `svg` must also look like SVG and contain no credential-like text
- any directory, any other type, a renamed file, a path segment starting with `.`, a symlink pointing outside: the same 404 with no reason; the reason is in the local journal (`journalctl --user -u cavil-loop-public-assets`)
- range requests are supported (needed for video seeking)

</details>

<details><summary>Enable it (one per machine)</summary>

Enable it (one per machine, not per project):

```bash
# 1. write the config (pick a free port)
cat > ~/.config/cavil-loop/public-assets.conf <<CONF
PUBLIC_ASSETS_ROOT=$HOME/.local/state/cavil-loop/review-shots
PUBLIC_ASSETS_PORT=<port>
PUBLIC_ASSETS_NODE=$(command -v node)
CONF
# 2. install the unit and start the service (setup.sh does not install this one: it is opt-in, one per machine)
ln -sfn ~/.agents/skills/cavil-loop/systemd/cavil-loop-public-assets.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now cavil-loop-public-assets.service
# 3. change the public entry from "serve the directory" to "forward to this port", same public path, e.g. tailscale:
#    tailscale serve --bg --https=<public port> --set-path /review-assets/ http://127.0.0.1:<port>
```

Set `PUBLIC_ASSETS_ROOT` to the asset directory actually in use (`~/.local/state/coding-agent-poll/review-shots` on a pre-rename install). Add `PUBLIC_ASSETS_PREFIX=` when the public path prefix is not `/review-assets/`.

</details>

<details><summary>Check images before posting</summary>

Before posting images, run `node scripts/public-assets/check.mjs <dir or file>`: it reports per file whether the public can fetch it, and names any file containing a token / key pattern and exits 1 (the publish command runs it before publishing; workers of projects with an image address do not run it themselves, see the next section).

</details>

### Directory rule, one publish command, enforced server-side check

Every comment image is published with one command, `scripts/publish-asset.sh`, into `<project key>/<item number>/` of the asset directory. In strict mode (`PUBLIC_ASSETS_STRICT=1` in the service config) the server serves only those files and the old images on its legacy list; the daemon switches a machine to strict mode by itself (`switch.sh --auto`), and `PUBLIC_ASSETS_AUTO_SWITCH=0` stops that.

<details><summary>Directory rule</summary>

**Directory rule**: every new image lands at `<project key>/<item number>/<name>-rev-<unique stamp>.<ext>` in the asset directory, the weekly report at `<project key>/weekly-report/<file name>`. cavil-loop decides the path; workers neither name nor pick directories. The project key is the name of `~/.config/cavil-loop/<key>.conf`.

</details>

<details><summary>The publish command</summary>

**Publish command**: comment images and the weekly report share `scripts/publish-asset.sh` (managed installs use the durable entry `~/.agents/releases/cavil-loop/entrypoints/publish-asset.sh`; `scripts/weekly-report/publish-asset.sh` also works and forwards unchanged). For projects with an image address, the two image bullets of the dispatch prompt ("how to make images", "comment image standard") are replaced by this one command with the project key and item number filled in: `bash '<entry>' --project '<key>' --item <number> <image>...`. It:

1. reads the state the public-asset service reports about itself and refuses when the server-side check is not in force (reason on stderr); the directory is the one the service reports, never guessed;
2. copies the file to a hidden temporary file inside the target directory and **scans that copy** for credential patterns, deleting it and refusing on a hit;
3. renames it to the final name, refusing when that name exists (no overwrite);
4. checks that the public URL answers HTTP 200 with exactly the file's size, deleting the file it just placed otherwise;
5. prints only the URLs on stdout, one per line.

Files that are not images / videos (the weekly-report PDF, …) stay private, under `<project key>/<subdir>/` of the private directory.

</details>

<details><summary>Strict mode: the enforced server-side check</summary>

**Enforced server-side check (strict mode)**: with `PUBLIC_ASSETS_STRICT=1` in the service config the service serves only two kinds of file — files under a project subdirectory (the key must be a project registered on this machine), or old images in the legacy list whose **path and content (SHA-256) both match**; each file is read whole into memory, its format, credential patterns (every type, not only SVG) and list entry are judged on that buffer, and the response is sent from the same buffer — what was checked is what goes out. A file copied in without the publish command is not served when it carries a credential pattern; a new file outside the project subdirectories is never served. Without the line only the basic rules above apply (this is also the state a failed switch returns to).

The single-file limit is 256 MB by default (`PUBLIC_ASSETS_MAX_BYTES=`); larger files are not served.

</details>

<details><summary>Old images: the legacy list</summary>

**Old images**: the switch records every image / video outside the project subdirectories as the legacy list (relative path + size + SHA-256), written twice: `public-assets-legacy.json` in the config directory and `~/.local/state/cavil-loop/public-assets/legacy.json`; the list's checksum goes into the service config as one line `PUBLIC_ASSETS_LEGACY_SHA=`. **That line is the only trusted state**: present = the list is in force, it governs, it is never rebuilt; absent = never in force, may be (re)built.

- changing permissions or modification time, restoring from a backup at the same path with the same content: the old image still opens;
- renaming, moving or changing the content: the old image becomes 404 (that image breaks in comments already posted);
- one list damaged: the service uses the other, and running the switch again copies the good one back;
- both damaged, or the checksum line malformed: every old-structure file is 404 with the reason in the log, and the switch does not rebuild — restore either copy from a backup (the checksum must match); only when a person decides, delete the checksum line and rebuild (a rebuild takes every file outside the project subdirectories at that moment as an old image).

</details>

<details><summary>Switching to strict mode, and the automatic switch</summary>

**Switching**:

```bash
bash ~/.agents/skills/cavil-loop/scripts/public-assets/switch.sh --status   # read-only: config, service, check in force, code current, list state
bash ~/.agents/skills/cavil-loop/scripts/public-assets/switch.sh --verify   # places a few test files, checks them via the local port and the public URL, deletes them; config unchanged
bash ~/.agents/skills/cavil-loop/scripts/public-assets/switch.sh            # switch: back up config → build / check list → write strict mode → restart → verify; rolls back on failure
```

After its verification passes, the switch also writes an acceptance record (`accepted.json` in the state directory, naming the service process it verified). **The check counts as in force only when the service runs in strict mode and the acceptance record names exactly the running process**: a switch interrupted before its verification, or a service that restarted on its own, turns it into "strict mode running, verification not done" — the publish command then refuses, and the automatic switch verifies again.

When any project has only the early weekly-report image address (`WEEKLY_REPORT_ASSET_URL`) and no image address, the switch refuses and names those projects: in strict mode their weekly-report images would not be served, and the new address cannot be derived from the old one. Add a `WEEKLY_REPORT_ASSET_ROOT_URL=` line (the prefix the public entry really mounts) to those projects' `<key>.conf`, then switch.

The daemon calls `switch.sh --auto` every round: when the service is not in strict mode, or the running code differs from the code on disk, it switches (restarting the service once); failures back off 1, 5, 15, 60 minutes, at most 5 tries per code version. To stop it switching automatically, add `PUBLIC_ASSETS_AUTO_SWITCH=0` to the service config. The verification has four checks: an old image 200, a new file in an old-structure position 404, a normal image under `<key>/0/` (item 0 is reserved for this) 200, an image with a fake token pattern 404; it deletes only the files it just created.

</details>

<details><summary>Rolling back to the basic rules by hand</summary>

When a switch goes wrong, return to the old rules by hand (this does not need the switch command to run; first set `OLD_IMAGE_URL` to the public URL of any old image):

<!-- public-assets-rollback:begin -->
```bash
(
set -eu
CONF="$(ls ~/.config/cavil-loop/public-assets.conf ~/.config/coding-agent-work-loop/public-assets.conf 2>/dev/null | head -n 1)" || true
if [ -z "$CONF" ]; then echo "NO-CONFIG: nothing changed"; exit 1; fi
BAK="$CONF.bak-manual-$(date +%Y%m%d-%H%M%S)"
if ! cp -p "$CONF" "$BAK" || ! cmp -s "$CONF" "$BAK"; then echo "BACKUP-FAILED: nothing changed"; exit 1; fi
sed -i '/^PUBLIC_ASSETS_STRICT=/d' "$CONF"
grep -q '^PUBLIC_ASSETS_AUTO_SWITCH=0$' "$CONF" || echo 'PUBLIC_ASSETS_AUTO_SWITCH=0' >> "$CONF"
if grep -q '^PUBLIC_ASSETS_STRICT=' "$CONF"; then echo "EDIT-FAILED: restore $BAK"; exit 1; fi
systemctl --user restart cavil-loop-public-assets.service
sleep 2
systemctl --user is-active cavil-loop-public-assets.service
PID="$(systemctl --user show -p MainPID --value cavil-loop-public-assets.service)"
jq -e --argjson p "$PID" '.pid == $p and .strict == false' ~/.local/state/cavil-loop/public-assets/status.json
curl -sk -o /dev/null -w '%{http_code}\n' "$OLD_IMAGE_URL"
echo "ROLLED-BACK"
)
```
<!-- public-assets-rollback:end -->

`active`, `true`, `200` and a last line `ROLLED-BACK` mean it is back: `true` is the service itself reporting "this process runs with strict mode off" (it counts only when the process id matches). Any failing step stops the block on the spot and nothing after it runs: `NO-CONFIG` / `BACKUP-FAILED` mean nothing was changed; `EDIT-FAILED` means the config is half edited — copy the backup it names back over it; a failing `systemctl` or `jq` line means the service did not come up on the old rules — see `journalctl --user -u cavil-loop-public-assets -n 50`. The `PUBLIC_ASSETS_LEGACY_SHA=` line stays, the next switch reuses it; to turn automatic switching back on, delete the `PUBLIC_ASSETS_AUTO_SWITCH=0` line.

</details>

<details><summary>Usage per project</summary>

**Usage** (read-only, deletes nothing): `bash ~/.agents/skills/cavil-loop/scripts/public-assets/usage.sh` lists usage per project and per item, old-structure files that belong to no project on one line, and the directory the names point at but the service does not serve on its own line. Whether and what to delete is a person's call: a deleted image breaks in the comments already posted.

</details>

<details><summary>What scripts cannot see; limits</summary>

**What scripts cannot see**: a token or personal data (names, e-mail addresses, accounts, orders, …) shown in the captured page. The credential check reads file bytes, not pixels. That still rests on the worker capturing only public pages and on the reviewer's spot check.

**Limits**: only machines running this service can publish images; a machine that exposes the directory through another static server is refused by the publish command. A switch restarts the service once; image requests in that moment (seconds) fail.

</details>

<details><summary>Attachments that are not images; screenshots that need a login</summary>

Attachments that are not images / videos (the weekly-report PDF, …) are not published publicly: `publish-asset.sh` puts them in a non-public directory and prints an internal-only URL when the project config sets `WEEKLY_REPORT_PRIVATE_ASSET_ROOT_URL` (the directory is `WEEKLY_REPORT_PRIVATE_ASSET_ROOT`, default `private-assets/` next to the asset directory), otherwise the local path. The vector versions of the weekly-report charts stay on the machine (`WEEKLY_REPORT_VECTOR_DIR`, default `weekly-report-vector/` next to the asset directory); `topdf.mjs` reads them locally.

For screenshots that need a login state, `scripts/review-screenshot.mjs --auth <file>` requires the file to be in a git-ignored path and outside the screenshot output directory, and refuses otherwise; the per-port copy it makes is written next to the original (mode 600) and removed on normal exit, on error and on interruption.

</details>

### Which projects show images in comments

A project's workers get the public address only when that project's own file `~/.config/cavil-loop/<key>.conf` has a `WEEKLY_REPORT_ASSET_ROOT_URL=` line; the public entry above is per machine, the address is per project.

<details><summary>Without an address: what workers do instead</summary>

Without the line the worker prompt says "this project has no image address", and workers describe images in words. They must not fall back to committing screenshots into the repository and embedding `github.com/<repo>/blob|raw/…` or `raw.githubusercontent.com/…` addresses: for a private repository GitHub does not proxy those images, so anyone not signed in to GitHub gets no image (measured: HTTP 404); whether the GitHub mobile app shows it has not been tested. The worker and review prompts forbid it; a plain link marked "needs a GitHub login", plus a description in words, is allowed.

</details>

<details><summary>What turning a project on means</summary>

Turning a project on makes its screenshots public to anyone who has the address (file names carry a unique stamp and nothing is listed, but nothing is private either). The prompts allow only public content there: no pages that need a login, no pages showing personal data (names, e-mail addresses, accounts, orders, …), no internal preview environments — when unsure, words instead. Nothing checks image content automatically; that rule rests on the worker and the reviewer's spot check. Decide per project.

</details>

<details><summary>Turn one project on, check it, turn it off again</summary>

To turn one project on, run these in one terminal (the first block sets the names the others use). The change takes effect from the next poll round (each round starts the service, and systemd reads the file at every start); a worker already running keeps its old prompt.

<!-- asset-url-ops:vars:begin -->
```bash
KEY=myproject      # the project to turn on / 要接入的项目: systemctl --user list-timers 'cavil-loop-poll@*'
FROM=otherproject  # a project that already shows images / 已经能出图的项目
ENV_FILE="$HOME/.config/cavil-loop/$KEY.conf"
REC="$ENV_FILE.asset-url-added"   # the address this procedure added / 本流程加进去的地址
LOCK="$ENV_FILE.asset-url.lock"   # add and revert hold it from first read to last write / 补地址和撤销从第一次读到最后一次写都持有它
URL=$(sed -n 's/^WEEKLY_REPORT_ASSET_ROOT_URL=//p' "$HOME/.config/cavil-loop/$FROM.conf" | tr -d '"')
echo "URL=$URL"
```
<!-- asset-url-ops:vars:end -->

<!-- asset-url-ops:add:begin -->
```bash
# One add / revert at a time per project: a second one waits up to 60 s, then stops with nothing changed.
# 同一项目同时只跑一个补地址 / 撤销：后来的最多等 60 秒，等不到就停下、什么都不改。
(
    flock -w 60 9 || { echo "STOP: another add / revert of $KEY holds $LOCK — nothing changed; run this block again"; exit 0; }
    if [ -z "$URL" ]; then
        echo "STOP: no address in $FROM — nothing changed"
    elif [ ! -w "$ENV_FILE" ]; then
        echo "FAILED: $ENV_FILE is not writable (or missing) — nothing changed; fix that and run this block again"
    else
        # Every decision and the new file come from ONE snapshot (the backup); right before the swap the file must
        # still equal it, and the replaced file must still equal it right after — otherwise someone saved in between.
        # 所有判断和新文件都只来自同一份快照（就是备份）；替换前文件必须仍等于它，替换后被换下的旧文件也必须仍等于它。
        # A record with no address line is left over from a failed add or an unfinished revert; it is rewritten.
        # 没有地址行却有记录：是上次接入失败或撤销没做完留下的，直接重写。
        LINE="WEEKLY_REPORT_ASSET_ROOT_URL=\"$URL\""
        BAK=$(mktemp "$ENV_FILE.bak-$(date +%Y%m%d-%H%M%S)-XXXX") || BAK=
        TMPF=$(mktemp "$ENV_FILE.XXXXXX") || TMPF=
        OLD="$ENV_FILE.replaced-$$"
        if ! { [ -n "$BAK" ] && [ -n "$TMPF" ] && cat "$ENV_FILE" > "$BAK"; }; then
            rm -f "$TMPF" "$BAK"; echo "FAILED: $ENV_FILE could not be read — nothing changed"
        elif [ "$(grep -c '^WEEKLY_REPORT_ASSET_ROOT_URL=' "$BAK")" != 0 ]; then
            rm -f "$TMPF" "$BAK"; echo "STOP: $ENV_FILE already has an address line — nothing changed"
        elif ! { { cat "$BAK" && { [ -z "$(tail -c 1 "$BAK")" ] || echo; } && printf '%s\n' "$LINE"; } > "$TMPF" \
            && [ "$(tail -n 1 "$TMPF")" = "$LINE" ] && [ "$(grep -c '^WEEKLY_REPORT_ASSET_ROOT_URL=' "$TMPF")" = 1 ] \
            && chmod --reference="$ENV_FILE" "$TMPF"; }; then
            rm -f "$TMPF" "$BAK"; echo "FAILED: $ENV_FILE not changed — fix the cause and run this block again"
        elif ! cmp -s "$ENV_FILE" "$BAK"; then
            rm -f "$TMPF" "$BAK"; echo "STOP: $ENV_FILE was changed while this block ran — nothing changed; run it again"
        elif ! ( umask 077 && printf '%s\n' "$URL" > "$REC" ) || ! ln "$ENV_FILE" "$OLD" || ! mv "$TMPF" "$ENV_FILE"; then
            rm -f "$TMPF" "$OLD" "$BAK"; echo "FAILED: $ENV_FILE not changed — fix the cause and run this block again"
        elif ! cmp -s "$OLD" "$BAK"; then
            echo "CONFLICT: ADDED, but a change saved at the same moment is in $OLD — copy it into $ENV_FILE by hand, then delete $OLD"
        else
            rm -f "$OLD"; echo "ADDED (backup / 备份: $BAK; record / 记录: $REC)"
        fi
    fi
) 9>>"$LOCK" || echo "FAILED: could not open $LOCK — nothing changed"
```
<!-- asset-url-ops:add:end -->

<!-- asset-url-ops:check:begin -->
```bash
n=$(grep -c '^WEEKLY_REPORT_ASSET_ROOT_URL=' "$ENV_FILE")
v=$(sed -n 's/^WEEKLY_REPORT_ASSET_ROOT_URL=//p' "$ENV_FILE" | tr -d '"')
added=$(cat "$REC" 2>/dev/null)
if [ "$n" = 0 ]; then echo "NONE: no address — workers describe images in words${added:+ (a leftover record will be cleared by add or revert)}"
elif [ "$n" = 1 ] && [ -n "$added" ] && [ "$v" = "$added" ]; then echo "OK: $v"
else echo "MISMATCH: ${n:-unreadable} line(s): $v (recorded / 记录: ${added:-none})"
fi
```
<!-- asset-url-ops:check:end -->

<!-- asset-url-ops:revert:begin -->
```bash
# One add / revert at a time per project: a second one waits up to 60 s, then stops with nothing changed.
# 同一项目同时只跑一个补地址 / 撤销：后来的最多等 60 秒，等不到就停下、什么都不改。
(
    flock -w 60 9 || { echo "STOP: another add / revert of $KEY holds $LOCK — nothing changed; run this block again"; exit 0; }
    added=$(cat "$REC" 2>/dev/null)
    # Every decision and the new file come from ONE snapshot, compared with the file again before and after the swap.
    # 所有判断和新文件都只来自同一份快照，替换前后再和文件比对。
    SNAP=$(mktemp "$ENV_FILE.snap-XXXXXX") || SNAP=
    TMPF=$(mktemp "$ENV_FILE.XXXXXX") || TMPF=
    OLD="$ENV_FILE.replaced-$$"
    if ! { [ -n "$SNAP" ] && [ -n "$TMPF" ] && cat "$ENV_FILE" > "$SNAP"; }; then
        rm -f "$TMPF" "$SNAP"; echo "STOP: $ENV_FILE could not be read — nothing changed"
    else
        n=$(grep -c '^WEEKLY_REPORT_ASSET_ROOT_URL=' "$SNAP")
        v=$(sed -n 's/^WEEKLY_REPORT_ASSET_ROOT_URL=//p' "$SNAP" | tr -d '"')
        if [ "$n" = 0 ]; then
            # Nothing to remove; only a leftover record (failed add, or a revert that stopped after removing the line) is cleared.
            # 没有地址行：只清掉遗留的记录（接入失败、或撤销删了行后没删掉记录）。
            rm -f "$TMPF" "$SNAP"
            if rm -f "$REC" && [ ! -e "$REC" ]; then echo "REVERTED: no address line${added:+, leftover record cleared}"
            else echo "FAILED: could not remove $REC — fix the cause and run this block again"
            fi
        elif [ -z "$added" ] || [ "$n" != 1 ] || [ "$v" != "$added" ]; then
            rm -f "$TMPF" "$SNAP"
            echo "STOP: $n address line(s), value '$v', recorded '${added:-none}' — not the line that was added; nothing changed, ask the maintainer"
        elif ! { { grep -v '^WEEKLY_REPORT_ASSET_ROOT_URL=' "$SNAP" > "$TMPF" || [ $? -eq 1 ]; } \
            && [ "$(grep -c '^WEEKLY_REPORT_ASSET_ROOT_URL=' "$TMPF")" = 0 ] \
            && [ "$(wc -l < "$TMPF")" = "$(grep -vc '^WEEKLY_REPORT_ASSET_ROOT_URL=' "$SNAP")" ] \
            && chmod --reference="$ENV_FILE" "$TMPF"; }; then
            rm -f "$TMPF" "$SNAP"; echo "FAILED: $ENV_FILE not changed — fix the cause and run this block again"
        elif ! cmp -s "$ENV_FILE" "$SNAP"; then
            rm -f "$TMPF" "$SNAP"; echo "STOP: $ENV_FILE was changed while this block ran — nothing changed; run it again"
        elif ! ln "$ENV_FILE" "$OLD" || ! mv "$TMPF" "$ENV_FILE"; then
            rm -f "$TMPF" "$SNAP" "$OLD"; echo "FAILED: $ENV_FILE not changed — fix the cause and run this block again"
        elif ! cmp -s "$OLD" "$SNAP"; then
            rm -f "$SNAP" "$REC"
            echo "CONFLICT: REVERTED, but a change saved at the same moment is in $OLD — copy it into $ENV_FILE by hand, then delete $OLD"
        elif rm -f "$SNAP" "$OLD" "$REC" && [ ! -e "$REC" ]; then
            echo "REVERTED"
        else
            echo "PARTIAL: address line removed, record $REC left — run this block again to clear it"
        fi
    fi
) 9>>"$LOCK" || echo "FAILED: could not open $LOCK — nothing changed"
```
<!-- asset-url-ops:revert:end -->

Expected output: add prints `ADDED`, the backup path (mode 600, same directory; the file holds the project's GitHub token, so do not print it) and the record `<key>.conf.asset-url-added`, which keeps the address this procedure wrote; check prints `OK: <address>`. To turn it off again, run the first block and then revert: it compares with that record — never with the other project's current address, which may have changed since — and removes only the line that was added, only when there is exactly one such line and it still equals the recorded address; every other setting stays as it is now (a later token change survives), and the record is removed with the line. Without a record nothing is removed.

</details>

<details><summary>Every outcome, and what to do next</summary>

Every outcome, and what to do next (a failed step never leaves a state the blocks cannot continue from):

| Block prints | Meaning | Next |
|---|---|---|
| add `ADDED` | line and record written | check should print `OK` |
| add `FAILED` | the file was not changed — it is missing, not writable or unreadable, or a write failed (a record may be left) | fix the cause (e.g. free disk space, or make the file writable) and run add again — a record without a line is rewritten |
| add `STOP` | no address to copy, or the file already has an address line | nothing changed; look at the file |
| add / revert `STOP: another add / revert … holds …` | another terminal is running add or revert for this project and did not finish within 60 s | nothing changed; let that one finish, then run this block again |
| add / revert `FAILED: could not open … .asset-url.lock` | the lock file next to the configuration could not be created or opened | nothing changed; make the directory writable and run the block again |
| add / revert `STOP: … was changed while this block ran` | someone saved the file after this block read it and before the swap | nothing changed, their save is kept; run the block again |
| add / revert `CONFLICT` | someone saved the file at the very moment of the swap; this block's change is in place, theirs is in the `….replaced-<n>` file it names | copy their change from that file into the config by hand, then delete it |
| revert `REVERTED` | the added line and the record are gone (or there was no line and only a leftover record was cleared) | check prints `NONE` |
| revert `PARTIAL` | the line is gone, the record is still there | run revert again: it clears the record |
| revert `FAILED` | nothing removed | fix the cause and run revert again |
| revert `STOP` | the line is not the one that was added, there are several, there is no record, or the file cannot be read | nothing changed; look at the file with the maintainer |

</details>

<details><summary>How the file is replaced safely</summary>

The configuration file is only ever replaced whole: add and revert write the complete new file next to it, check it, and only then rename it over the old one, so a write that fails or stops half-way (a full disk, a size limit) leaves the old file exactly as it was. The new file keeps the old file's permissions. Add and revert for the same project never overlap: each holds the lock file `<key>.conf.asset-url.lock` (left in place, it is empty) from its first read to its last write, and one started while the other runs waits for it. Each block works from one snapshot of the file (for add, the backup): right before the swap the file must still equal that snapshot, otherwise the block stops and changes nothing; right after the swap the file that was replaced must still equal it, otherwise a save landed in between and the block reports `CONFLICT` and keeps that file. Not caught: an editor that saves by renaming its own file in the instant between the last check and the swap — that save is lost. Do not edit the file, or run `setup.sh` for this project, while running these blocks. The backup is only for comparing by hand; do not copy it back over the file, that would undo every later change.

</details>

## Prompt templates

How prompts are composed, where the template and the project addition are found, and every placeholder a template can use: [Compose prompt](orchestration.md#compose-prompt-templates-and-additions) in the orchestration guide.

## Cleanup hook (`CLEANUP_HOOK`)

What the cleanup script gets, when it runs, and how to find what to clean by worktree: [Cleanup on merge](orchestration.md#cleanup-on-merge-cleanup_hook) in the orchestration guide.

## File layout

Where the tool, a connected project and the per-user state live on disk.

### Skill directory (managed Linux layout)

The skill link points at one immutable release; the poller and other entries start through launchers in `entrypoints/`, which release cleanup never removes.

<details><summary>Directory tree</summary>

```
~/github/cavil-loop/        # optional development checkout; deployment never mutates it
~/.agents/skills/cavil-loop -> ~/.agents/releases/cavil-loop/releases/<sha>/
~/.agents/releases/cavil-loop/
├── mirror.git/                         # fetch-only mirror
├── releases/<sha>/                     # immutable trees with .inuse leases
├── entrypoints/                        # durable launchers; never removed with a release
├── .fetch.lock                         # network-fetch serialization only
├── .deploy.lock                        # short publish/select/cleanup lock
├── .last-fetch                         # shared fetch throttle
└── deploy-state.json                   # lag, success, and alert state
~/.claude/skills/cavil-loop  -> ~/.agents/skills/cavil-loop
```

</details>

<details><summary>Launchers, leases and release cleanup</summary>

Poll, token-usage, and weekly-report start through launchers in `entrypoints/`. Those launchers cannot be removed by release cleanup: they take the shared deploy lock, resolve the stable link, and acquire the selected release's `.inuse` lease before opening any versioned script. Cleanup removes an old release only after taking that lease exclusively; age and “keep N versions” are deliberately not used. Optional shared overrides live in `~/.config/cavil-loop/deploy.conf`; see `cavil-loop-deploy.conf.example`.

</details>

### Host project (after connecting)

Connecting adds one gitignored config file; project-level prompt and hook overrides are optional.

<details><summary>Directory tree</summary>

```
your-project/
├── .gitignore                              # +1 line: cavil-loop.config
├── cavil-loop.config                      # config (gitignored)
├── .agents/skills/cavil-loop/   # optional: project-level prompt + cleanup-hook overrides
│   ├── prompts/
│   └── cleanup-hook.sh
└── ... your code ...
```

</details>

### User-level state files

`<project-key>.conf` is the single source of truth for env vars on both OS — same format, different scheduler loads it. Each project's state lives under `~/.local/state/cavil-loop/<project>/`.

<details><summary>Directory tree</summary>

```
~/.config/cavil-loop/
└── <project-key>.conf                  # KEY=VALUE env file; systemd reads as EnvironmentFile, launchd sources it inline

# Linux only
~/.config/systemd/user/
├── cavil-loop-poll@.service          # symlink → skill dir template
└── cavil-loop-poll@.timer            # symlink → skill dir template

# macOS only
~/Library/LaunchAgents/
└── dev.luosky.cavil-loop.<key>.plist   # generated per project (not a symlink)
~/Library/Logs/cavil-loop/
└── <key>.out.log, <key>.err.log        # launchd captures daemon stdout/stderr

~/.local/state/cavil-loop/<project>/
├── state.json                          # { "seen_comments": ..., "cleaned_prs": ... }
├── poll-pace.json                      # idle/failure backoff state; `rm` it = back to full speed
├── usage-limit.json                    # only with ENABLE_USAGE_LIMIT_PAUSE: dispatch start times + hand-overs in progress
├── poll.log                            # rolling log
├── runlog/                             # run log: one record per poll round + snapshots
├── poll.lock                           # flock
└── sessions/                           # tmux pane logs per worker
    └── <project>-issue<N>.log
```

</details>

## Scheduler by OS

`setup.sh` detects the OS with `uname -s` and wires the right scheduler automatically: a `systemd --user` timer on Linux, a `launchd` LaunchAgent on macOS; anything else stops with an error and needs the [manual cron fallback](#manual-cron-fallback). `POLL_INTERVAL_SECS` sets the tick on both; change it and re-run `setup.sh`.

<details><summary>What each OS gets</summary>

| OS | Scheduler | Unit / Plist | Set up by `setup.sh`? |
|----|-----------|--------------|-----------------------|
| Linux | `systemd --user` timer | `~/.config/systemd/user/cavil-loop-poll@<key>.{service,timer}` (symlink to skill template) + `cavil-loop-poll@<key>.timer.d/interval.conf` (generated from `POLL_INTERVAL_SECS`) | ✅ |
| macOS | `launchd` LaunchAgent | `~/Library/LaunchAgents/dev.luosky.cavil-loop.<key>.plist` (generated) | ✅ |
| Other | — | — | ❌ `exit 1`; see [manual cron fallback](#manual-cron-fallback) |

Both paths read the same `~/.config/cavil-loop/<key>.conf` env file. Linux runs `skill-deploy.sh` before the durable poll entry. Network work has a separate non-blocking lock and timeout; only publication and cleanup take the short deploy lock, so a slow fetch cannot hold up consumers of the current release. Failed fetch attempts also enter the shared throttle. macOS runs the pinned entry but does not auto-deploy, and a plist template change requires re-running `setup.sh`.

</details>

<details><summary>Tick cadence and <code>POLL_INTERVAL_SECS</code></summary>

The tick cadence is only an upper bound on how often GitHub gets called: a
project nobody has touched for a day or more decides, inside `agent-poll.sh`,
to skip most of its ticks (see [idle and failure backoff](architecture.md#poll-pace-idle-and-failure-backoff)).
Waking a process costs tens of milliseconds; API calls are the scarce resource,
so the tick itself stays cheap and frequent.

`POLL_INTERVAL_SECS` is what drives the timer on both OSes, and on Linux
`setup.sh` writes it as a per-instance drop-in rather than editing the shared
template. A hand-written `interval.conf` is never overwritten — `setup.sh` says
so and leaves it alone.

</details>

### macOS specifics

A per-user LaunchAgent, loaded with `launchctl bootstrap`; it needs `brew install flock` first and runs only while you are logged in.

<details><summary>Label, loading, cadence, logs, flock, logout</summary>

- **Label**: `dev.luosky.cavil-loop.<key>` (must match the filename)
- **Loaded via**: `launchctl bootstrap gui/$UID <plist>` (modern syntax, macOS 10.10+). `setup.sh` runs `bootout` first if a previous load exists, so re-runs are idempotent.
- **Run cadence**: `StartInterval` comes from `POLL_INTERVAL_SECS` (equivalent to systemd `OnUnitActiveSec`). Changing it means re-running `setup.sh`, since the plist is generated, not symlinked.
- **Logs**: stdout/stderr → `~/Library/Logs/cavil-loop/<key>.{out,err}.log`. The deeper poll log still lives at `$STATE_DIR/poll.log`.
- **flock**: not bundled with macOS. `brew install flock` once before running `setup.sh`.
- **Logout / lid-close**: a user LaunchAgent runs when you're logged in (even with screen locked). For "run even when no user is logged in," you'd need a `/Library/LaunchDaemons/` install — `setup.sh` deliberately doesn't go there (requires `sudo`, breaks symmetry with Linux's `--user` systemd).

</details>

## Running multiple projects

Install the skill and the scheduler template once, then run `setup.sh` once per project; each project gets its own timer, log and state, with no interference.

<details><summary>Commands</summary>

```bash
bash ~/.agents/skills/cavil-loop/setup.sh ~/github/projectA
bash ~/.agents/skills/cavil-loop/setup.sh ~/github/projectB
```

</details>

<details><summary>What you get</summary>

```
~/.config/cavil-loop/
├── projectA.conf
└── projectB.conf

# Linux
systemctl --user list-timers
  cavil-loop-poll@projectA.timer
  cavil-loop-poll@projectB.timer

# macOS
launchctl list | grep dev.luosky.cavil-loop
  dev.luosky.cavil-loop.projectA
  dev.luosky.cavil-loop.projectB
```

Independent logs, independent state, no interference.

</details>

## Scripted install, status and disconnect

A program (the desktop client, or a script of your own) installs, inspects and disconnects projects through four scripts in the skill directory instead of re-implementing the install logic. They work for installations from before the rename too (old names are picked through `scripts/_names.sh`).

<details><summary>The scripts</summary>

| Script | What it does | Writes anything? |
|---|---|---|
| `setup.sh --yes <host> [key]` | Same as `setup.sh`, but does not ask the final y/N: enables and starts the poller right away; without `--yes` it is plain `setup.sh` | yes (as `setup.sh`) |
| `scripts/install-status.sh [--agent <name>] [--project <dir>]` | Prints one JSON object with the whole local state | no |
| `scripts/disconnect-project.sh <key>` | Stops one project's poller and removes its registration; keeps the project config and state | yes |
| `scripts/launchd-refresh.sh <key>` | macOS only: replaces one project's launchd plist after the template changed, with backup and rollback | yes |
| `scripts/project-service.sh <key> stop\|start` | Stops / starts one project's background poller (used by remote access): only "running → stop" and "stopped → start", nothing when the state cannot be read, read back afterwards | yes |

</details>

<details><summary>Commands: connect, list, check, disconnect</summary>

<!-- install-scripts-ops:begin -->
```bash
SKILL="$HOME/.agents/skills/cavil-loop"
git init -q "$HOME/github/myproject"
bash "$SKILL/setup.sh" --yes "$HOME/github/myproject"
bash "$SKILL/scripts/install-status.sh" | jq -r '.projects[] | "\(.key) \(.repo) \(.scheduler.state) deps=\(.deps.state)"'
bash "$SKILL/scripts/install-status.sh" --agent codex | jq -c '.agent_check | {agent, state, missing}'
bash "$SKILL/scripts/disconnect-project.sh" myproject
```
<!-- install-scripts-ops:end -->

The lines above, in order: connect a project without the y/N question; list every connected project with its scheduler state and dependency verdict; check what is missing before connecting a new project with `codex`; disconnect it again. `myproject` is the instance key (by default the directory name; `.projects[].key` in the status output).

</details>

<details><summary>Status output: every field</summary>

**Status output** (`version: 1`). Top level: `os`, `scheduler` (`systemd` / `launchd`), `daemon` (`entry` — the stable skill link, `target` — where it resolves, `form` — `managed` release / `checkout` git directory / `directory` / `missing` / `dangling`, `version` — release sha or the checkout's `HEAD`), `gh` (`installed`, `logged_in`), `base_deps.missing` (tools every project needs), `bash` (`path` — the bash the poller will run with, picked by the same function `setup.sh` uses; `major`; `ok` — `true` for 4 or later, `false` for the bash 3.2 macOS ships, which cannot run the daemon (`brew install bash`), `null` when the version could not be read), `agent_check` (only with `--agent`), `remote_access` (`{level, fingerprint}` of the remote-entry code on disk next to this script — the interface level and the sha256 of `remote_access.py`; `null` when it cannot be read), `project_check` (only with `--project <dir>`: the project config already in that directory, read the way the poller reads it — `config_state` `none` / `ok` / `unreadable`, `config`, `repo`, `worker_agent`; `setup.sh` keeps such a config, so these are what the project will run with), and `projects[]`. Each project: `key`, `layout` (`new` / `legacy` = installed before the rename), `env_file`, `host`, `config`, `config_state` (`ok` / `unreadable`), `repo`, `state_dir`, `agents[]`, `deps`, `scheduler`, `last_poll`.

- `agents[]` lists the worker agent, the review agent (only while `LABEL_PENDING_REVIEW` is set) and the agent the model-selecting label uses (`role: fable`, `required: false` — it starts only when someone puts that label on an item, so a codex project without claude is not reported as missing a dependency). Each has `bin`, `state` (`ok` / `missing` / `no_driver`) and `missing`, computed by the same function `setup.sh` uses — the two cannot disagree. `deps` sums up the required ones: `ok` / `missing` / `unknown` (config unreadable or no driver).
- `scheduler.state` is `running` / `stopped` / `unknown`. Only known state words count: a failed read, empty output or an unfamiliar word is `unknown`, never `stopped`. `raw` carries what was read.
- `last_poll` is the last poll that actually read GitHub (`poll-pace.json`), else the modification time of `poll.log`; `null` when neither exists.
- Without `jq` the full status cannot be built: the script then prints only `{version: 1, precheck: true, os, base_deps: {missing}}` (the common tools, checked without `jq`) and exits 3. Projects and scheduler states are unknown in that case.

</details>

<details><summary>Disconnect: what it checks and its exit codes</summary>

**Disconnect** follows [Uninstall one project](#uninstall-one-project): it reads the scheduler state first and touches nothing when that read fails (exit 2); after stopping it reads the state back (on Linux also "not enabled at boot") and keeps the registration when it cannot confirm (exit 3). Exit 0 = disconnected, 1 = no such instance. The last line is always `RESULT=<disconnected|not_found|unknown|failed>`. Worker tmux sessions are left alone.

</details>

<details><summary>Refreshing a launchd plist (macOS)</summary>

**Refreshing a launchd plist (macOS).** The plist is generated, not a symlink, and re-running `setup.sh` skips an existing one; after a daemon update that changed the template, run this once per project.

<!-- install-scripts-mac-ops:begin -->
```bash
SKILL="$HOME/.agents/skills/cavil-loop"
bash "$SKILL/scripts/launchd-refresh.sh" myproject
```
<!-- install-scripts-mac-ops:end -->

</details>

<details><summary>What the refresh does, and its results</summary>

It renders the new plist with the same function `setup.sh` uses, checks it with `plutil -lint`, and compares it with the current file — identical means `RESULT=unchanged`. Otherwise it reads the job state (unreadable → stop, nothing touched); if the job is loaded it takes the project's poll lock (waits for the current poll to end, at most `CAVIL_REFRESH_LOCK_WAIT` seconds, default 300), boots it out and confirms it is gone; copies the old file to `$STATE_DIR/launchd-backup/`; swaps the new one in atomically; and loads it again if it was loaded before, reading back that it is loaded from that file. If loading fails it restores the backup and the previous state. The last line is `RESULT=` one of `replaced` / `unchanged` (exit 0), `unknown` / `lint_failed` / `lock_timeout` (exit 2, nothing touched), `not_found` / `not_macos` (exit 1), `failed` (exit 3, old file and state restored — only after reading both back), `needs_human` (exit 4: the restore failed or could not be confirmed — the output shows the error texts, where the original file is, and how to restore it by hand; a backup, if one was made, is kept). On Linux the unit files are symlinks to the templates and the deployer reloads them, so this script does not apply there.

</details>

## Edit a project's settings from a script

`scripts/project-config.sh` reads and changes the everyday settings of one connected project; the desktop client's "项目配置" dialog is built on it, and a person can run it too. Only settings registered in `scripts/config-fields.txt` are read or written; a save writes all values or none and keeps a backup. `myproject` is the instance key.

<details><summary>Commands</summary>

<!-- project-config-ops:begin -->
```bash
SKILL="$HOME/.agents/skills/cavil-loop"
bash "$SKILL/scripts/project-config.sh" get myproject | jq -r '.fields[] | select(.mode == "edit") | "\(.name)=\(.value) editable=\(.editable)"'
REV="$(bash "$SKILL/scripts/project-config.sh" get myproject | jq -r .rev)"
SAVED="$(printf '{"MAX_CONCURRENT_WORKERS":"2"}' | bash "$SKILL/scripts/project-config.sh" set myproject --rev "$REV")"
printf '%s\n' "$SAVED" | tail -1
bash "$SKILL/scripts/project-config.sh" get myproject | jq -r '.fields[] | select(.name == "MAX_CONCURRENT_WORKERS") | "\(.name)=\(.value)"'
BACKUP="$(printf '%s\n' "$SAVED" | sed -n 's/^DETAIL=//p' | jq -r .backup)"
cp "$BACKUP" "$(bash "$SKILL/scripts/project-config.sh" get myproject | jq -r .real)"
```
<!-- project-config-ops:end -->

In order: list the settings that can be changed with their current values; take the file's fingerprint; change one setting; print the result line; read the new value back; then put the pre-save version back from the backup the save made (the last two lines are the whole way back — nothing else was touched).

</details>

⚠️ Do not edit the same file in an editor while saving: an edit stored around the save can be lost even when the result is `saved` (details in the last fold).

<details><summary>Which settings it can read and change</summary>

**What it can read and change.** Only the settings registered in `scripts/config-fields.txt` (agent and model, concurrency, retry and round counts, the comment language, a few switches). Commands, hooks, tokens, URLs, directories and the project's names are not registered: they are never printed and cannot be set. Labels, choose-one modes and text values that are not a single number are shown only (`mode: "show"`): they sit in their topic group next to the settings that can be changed, and each carries its own reason in `reason` (the eighth column of `config-fields.txt`). A registered setting is editable only when the config's code names it exactly once, and that one place is an unindented line of its own at the top level holding a plain literal. One written as arithmetic or with a variable, assigned twice, placed inside an `if`, a loop, a `case`, a function or a `{ }` group — on several lines or on one, indented or not, whether that branch runs or not — following another command (`cmd && KEY=…`), written some other way (`declare`, a bare `export`, `read`, `printf -v`, `${KEY:=…}`), or merely mentioned a second time anywhere else in the code comes back `editable: false` with the reason, and stays a job for a text editor. The same evidence decides whether a setting counts as missing from the file: only when the code never names it at all (comments do not count) may a save append a line for it. Where things sit is read from bash's own parse of the file, not from its indentation; when that parse cannot be read, every setting is show-only. One thing cannot be seen: a name put together at run time (`eval`, another file that is sourced) inside a branch that did not run. `value` is always what the daemon works with, separately from whether the line can be changed: a setting that is unset or empty after the config loads — no such line, an empty value, a branch that did not run — is reported with the daemon's default. A few settings give an empty value a meaning of its own, and are reported by that rule: `ENABLE_POLL_RUN_LOG` is on when the line is missing and off when it is empty (registered as `true;empty=false`). A setting with an early name (the requester bot's `LABEL_PENDING_RELAY`, `RELAY_REPORT_FIRST`) is reported the way the daemon picks it: the new name's value when it has one, otherwise the early name's (the pairs are listed once, in `CAVIL_SETTING_EARLY_NAMES` in `scripts/_names.sh`). A config whose code names the early name at all, or that ends up defining it once loaded (for instance from another file it sources), is show-only for that setting, with the reason: writing the new name next to it would leave two names, possibly with conflicting values; rename the line in a text editor first. The two required labels (`LABEL_PENDING_AGENT`, `LABEL_PENDING_HUMAN`) have no default: without their line the daemon does not start, and they are reported empty. `in_file: false` means the file's code never names the setting; saving it appends one line.

</details>

<details><summary><code>get</code>: the output</summary>

**`get <key>`** prints one JSON object: `state` (`ok` / `unreadable` / `not_found`), `config`, `real` (the file after following symlinks), `rev` (fingerprint of that location plus the content) and `fields[]` — `name`, `group`, `mode`, `label`, `help`, `type` (`agent` / `model` / `int` / `bool` / `enum` / `label` / `text` — `text` is a value read as written, such as a flow label, a label list or a branch name, shown only — with `options`, `min` / `max`, `on` / `off` as the type needs; an integer's range is what the code using it accepts, compared digit by digit — `max` is `null` when that code sets no upper bound, and a string when it is longer than a JSON number holds exactly, such as the autopilot check timeout's 2562047788015215 hours, the most that still fits once multiplied by 3600), `value`, `default`, `in_file`, `editable`, `reason`, and `tier` — where the client's dialog puts the setting (the ninth column of `config-fields.txt`): `main` shown at once, `more` folded under its group's 「高级」, `advanced` in the 「高级设置」 block at the bottom, folded by default; a client reading an older daemon without this field shows every setting at once. A config that cannot be loaded is `unreadable` with no values at all — never "nothing set".

</details>

<details><summary><code>set</code>: how a save works, and every result</summary>

**`set <key> --rev <fingerprint>`** takes a JSON object of strings on standard input and writes all of it or none of it. It locks on the file's real location, works from a private copy of the file, validates every value against its registered type, changes only those lines (comments, quoting and every other byte stay), checks that the new file still loads and that no other variable moved, copies the pre-save version to `$STATE_DIR/config-backups/` (mode 600, the latest 10 kept), compares the file with `--rev` once more right before the swap, and renames the new file into place. The next-to-last line is `DETAIL=<json>` (`changes[]` with old and new values, `backup`), the last is `RESULT=`:

| `RESULT` | Exit | Meaning |
|---|---|---|
| `saved` | 0 | written; reading it back right after the swap gave the new content |
| `unchanged` | 0 | every value already was what the file says; nothing written |
| `changed` | 2 | the file is not the one `--rev` was taken from (edited since the read, or during the save); nothing written — read again |
| `invalid` / `not_editable` | 2 | a value does not fit its type / a setting is not registered, show-only, or not a plain literal; nothing written |
| `busy` | 2 | another save holds the lock (`--lock-wait <seconds>`, default 15); nothing written |
| `unreadable` / `verify_failed` / `backup_failed` / `write_failed` | 2 | the config does not load / the new file failed its check / the backup could not be written / a file operation failed; nothing written |
| `not_found` | 1 | no such connected project |
| `saved_then_changed` | 4 | the new file was swapped in, and something else rewrote the file before the read-back; the script leaves it as it is — read again and compare with the backup |

</details>

<details><summary>Saving while an editor has the file open</summary>

**Do not edit the same file in an editor while saving.** The script cannot make an editor wait. It refuses to write when the file differs from `--rev` at its last check; after that check it cannot see anything: a version an editor stores between that check and the swap is replaced by the new file, and an editor that had the file open before the save and stores afterwards either overwrites the new values with its whole old copy or writes into the file that was just swapped out. In both cases the result may still be `saved`, and the lost edit cannot be recovered — the backup holds only the version from before the save. Once the new file is in place the script never writes the config again: no rollback, no automatic restore. The poller reads the config once at the start of each tick, and the swap is a rename, so it sees the whole old file or the whole new one; a running worker keeps the values it started with.

</details>

## Rename a flow label

A flow label (dispatch, working, waiting for a human, moved to PR, done, and the optional review / autopilot / merge / blocked / later / requester-bot labels) lives in three places: the project's config, the label itself on GitHub (and every issue / PR carrying it), and the desktop client's own label names. `scripts/label-rename.sh` changes the first two in one go; the desktop client's 「改名…」 button runs it and then saves its own names for that repository only. Only a setting that holds one label name can be renamed; list settings (`LABEL_PENDING_AGENT_EXTRA`, `GREEDY_SKIP_LABELS`, `PRIORITY_LABELS`) cannot, and a rename is refused while one of them names the old or the new name.

<details><summary>Commands</summary>

<!-- label-rename-ops:begin -->
```bash
SKILL="$HOME/.agents/skills/cavil-loop"
bash "$SKILL/scripts/label-rename.sh" myproject check --field LABEL_PENDING_HUMAN --from pending/human --to needs-human --others-stopped | tail -1
REV="$(bash "$SKILL/scripts/project-config.sh" get myproject | jq -r .rev)"
bash "$SKILL/scripts/label-rename.sh" myproject rename --field LABEL_PENDING_HUMAN --from pending/human --to needs-human --rev "$REV" --others-stopped | tail -1
bash "$SKILL/scripts/label-rename.sh" myproject finish --no-client | tail -1
```
<!-- label-rename-ops:end -->

In order: check (read-only: every check with its reason is in the `DETAIL=` line); take the config's fingerprint; rename — the last line is `RESULT=awaiting_client` once GitHub and the config both hold the new name; then end the pause. `--others-stopped` is the person's statement that no other machine polls this repository, or that it has been stopped (see below). `finish --no-client` says the client's names are not being changed this time; change them in the client's settings by hand.

</details>

<details><summary>Results and what to do next</summary>

| `RESULT` | Meaning | What next |
|---|---|---|
| `awaiting_client` | GitHub and the config hold the new name; the project stays paused | the client saves its names, then `finish --client-saved`; from a terminal `finish --no-client` |
| `done` | finished; the pause file is gone | — |
| `refused` | a check failed, or GitHub refused the rename (4xx); nothing changed | fix the reason in `DETAIL=`, try again |
| `no_answer` | the rename request got no answer: it may still take effect at any later time | `continue` (reads only) until GitHub shows the new name, or `resend`; there is no `undo` |
| `partial` | GitHub was renamed, the config was not written | fix the reason, `continue` |
| `busy` | the poll lock stayed taken (`LABEL_RENAME_LOCK_WAIT`, default 60 s); nothing changed | try again |
| `unknown` | something could not be read, or GitHub shows neither name; nothing written | read the message; after fixing it by hand, `abandon --yes` |

</details>

<details><summary>While it runs, nothing acts on the old name</summary>

**While it runs, nothing acts on the old name.** The script works inside the project's poll lock and writes `$STATE_DIR/label-rename.json` before it touches GitHub. While that file exists, every poll round of the project, a dispatch or CI report run by hand, and the requester-bot wake script do nothing (the run log records `label-rename`). Every entry that reads the config and later writes labels checks, once it holds the poll lock, that the config has not changed since it was loaded: it fingerprints the config right before bash reads it, and each file the config `source`s right before that file's first command runs (bash has read the whole file by then), then once more when loading is done (a difference means the file was replaced while loading, and the entry does nothing); under the lock it fingerprints them again, and if any differs or cannot be read it does nothing and the next round uses the new config. This covers hand edits as well as saves through this tool. It does not see files the config reads some other way (for example `$(cat …)`), or a file the config would source only if it existed and that appears later — keep label names in the config or in a file it always sources. A config that sets or clears its own `DEBUG` trap, or runs `set +T`, while it loads hides the files it sources afterwards — also when it turns it back on later; the gate then refuses every round, with a line saying so in `poll.log`, until that line is removed. Files sourced inside a command substitution or another subshell are fingerprinted the same way. Accepted limit: a `trap` command that is not written out as `trap … DEBUG` — built from a variable or an alias — is not recognised, so a config that removes and restores the trap that way hides what it sources in between. Dispatch scripts run by hand re-run themselves inside the poll lock first. The file is removed only by `finish`, `undo` or `abandon --yes`.

</details>

<details><summary>Checks before a rename</summary>

**Checks.** The new name uses only letters, digits and `. _ : / @ + -`, 1–50 characters. The repository has a label with exactly the old name and none with the new name (labels are unique regardless of case, so a rename that only changes upper / lower case is refused). No open item carries the working label (`doing/agent`) and the stuck-worker check holds no item. No other setting uses either name. The config line is a plain top-level literal (the same rule as `project-config.sh`). The autopilot, merge, blocked and requester-bot labels are judged from GitHub's label history, and whether that history shows the new name after a rename has not been measured — so they cannot be renamed while an open item carries them. A label list that cannot be read in full is "cannot tell", never "the new name is free".

</details>

<details><summary>A request that got no answer</summary>

**A request that got no answer.** GitHub's label API has no conditional write and no receipt that a request was dropped, so an unanswered rename can land at any later moment. The script therefore never takes "the old name is still there" as "nothing happened": the project stays paused, `undo` is refused, and only `continue` and `resend` are offered (resending is safe — a late copy aims at the same name, and fails once the old name is gone). When such a rename finishes, `$STATE_DIR/label-watch.json` is written: from then on every poll round reads the repository's labels first and does nothing when the label with that fixed id is not called what the config says (run log: `label-watch`); a dispatch, CI report or stuck-item release run by hand, and the requester-bot wake script, make the same check once they hold the poll lock and stop the same way. It ends only with `label-rename.sh myproject watch-end`. The record holds one label, so while it is on, renaming any other label is refused (renaming the same label again is allowed and moves the check to the new name). One round can still act on the old name if a late request lands between that check and the round's last label write; this is an accepted risk.

</details>

<details><summary>Other machines polling the same repository</summary>

**Other machines polling the same repository.** Their configs still name the old label once GitHub is renamed. Stop their polling before the rename (the client lists the machines it knows and stops them first). Afterwards, on each of them, run `follow` with the label's fixed id from the first machine's output (`LABEL_ID=`): it checks that the label with that id now has the new name, the old name is gone and that machine's own polling is stopped (read the way `project-service.sh` reads it; running or unreadable refuses), changes only that machine's config, and sends nothing to GitHub — then `finish --no-client` and start that machine's polling again.

```bash
bash "$SKILL/scripts/label-rename.sh" otherproject follow --field LABEL_PENDING_HUMAN --from pending/human --to needs-human --label-id 1234567 --rev "$(bash "$SKILL/scripts/project-config.sh" get otherproject | jq -r .rev)"
```

</details>

`status` prints the pending record and whether the label check is on; `project-config.sh get` reports the same under `label_rename`, and each renameable setting's `rename.ok` / `rename.reason`.

## Remote access: let the client on another computer see this machine's daemon

When the daemon runs on one machine and the desktop client on another, the client's "设置 → 远程 daemon" section can list the projects this machine has connected and whether they are running, stop / start one project's poller, show the last 200 lines of its poll log, and read / change a project's everyday settings (the same form as "本机 daemon → 配置"). **Tailscale only**, and only after pairing. It is off by default: without the commands below nothing listens on this machine and nothing is forwarded.

<details><summary>Requirements</summary>

**Requirements** (`enable` names the missing one and stops, leaving nothing half open):

- Tailscale is connected on this machine, and its tailnet has MagicDNS and HTTPS Certificates turned on (admin console, DNS page).
- Registering the forward needs admin rights: the current user is the Tailscale operator (`sudo tailscale set --operator=$USER`, once), or `sudo` works without a password. With neither, `enable` prints the one command to run with `sudo`; run it, then run `enable` again.
- `python3`, `tailscale` and `jq` are installed.
- The client's computer is in the same tailnet.

</details>

<details><summary>Commands</summary>

<!-- remote-access-ops:begin -->
```bash
RA="$HOME/.agents/skills/cavil-loop/scripts/remote-access.sh"
bash "$RA" enable
bash "$RA" pair
bash "$RA" status
bash "$RA" list
bash "$RA" revoke MacBook-Pro
bash "$RA" disable
```
<!-- remote-access-ops:end -->

In order: open the entry; make a pairing code (`pair` opens the entry first when it is closed, so `pair` alone is usually enough); show the entry's state; list paired devices; revoke the one named `MacBook-Pro`; close the entry.

</details>

<details><summary>Without a terminal: the desktop client</summary>

**Without a terminal**: when this machine runs the desktop client too (a Mac), the same things are in its "设置 → 本机 daemon → 允许其他电脑远程连接" block — a switch that runs `enable` / `disable`, "生成配对码" that runs `pair` and shows the code in large digits with the time left, "作废这个码" (`pair-cancel`), and "已配对的电脑…" (`list` / `revoke`). The switch shows what `status` reads back afterwards; when that read fails it shows "状态未知" and offers no switch. On the other computer, "添加远程 daemon" lists the machines in that computer's Tailscale (`tailscale status --json`, read-only) and asks each online one once whether its remote entry answers on port 47387 — "已打开远程连接", "未打开远程连接" (the connection was refused), "不确定" (anything else: never shown as closed) or "不在线" — so the name is picked, not copied; "手动输入机器名" stays for a custom port or when the list cannot be read. The remote entry can only be opened on the machine itself: a server without a window still runs `pair` once there.

</details>

<details><summary>Pairing</summary>

**Pairing**: `pair` prints this machine's full name (ending in `.ts.net`) and an 8-digit code; type both into the client's "添加远程 daemon" dialog. A code lasts 10 minutes, works once, and is void after 5 wrong tries in a row. A successful pairing gives the client a key of its own (kept in its system keychain); this machine records it in `~/.local/state/cavil-loop/remote-access/devices.json` (directory 700, file 600).

</details>

<details><summary>Every command and its result</summary>

**Every command** ends with a `RESULT=<...>` line (except `list` / `revoke`):

| Command | What it does | Result |
|---------|--------------|--------|
| `enable [--port N]` | Registers the `tailscale serve` forward (HTTPS, tailnet only) → writes the background job file → starts the resident service. Default port 47387. On a port change, the forward this feature had on the old port is removed once the new one is up (cannot remove it: `partial`, exit 3, naming the port). A forward already on the port is never taken over, even one of the same shape (`port_taken`) | `enabled`; a missing requirement: `tailscale_down` / `tailscale_unknown` / `no_https` / `need_admin` / `funnel` (the port has a public entry) / `port_taken` / `unknown` (job state unreadable), exit 2, nothing changed; `failed`, exit 3 |
| `pair` | Runs `enable` first when the entry is closed, then makes a code (a new code replaces the waiting one). Also prints `HOST=` / `CODE=` / `EXPIRES=` (epoch seconds) for the desktop client | `code` |
| `pair-cancel` | Voids the waiting code (none waiting is also success) | `cancelled` |
| `status` | Read-only. While the service runs it also says whether it runs the code on disk (`ENTRY_CODE=`, see "After an update"). Also prints `HOST=` (only when the name was read), `PORT=` and `DEVICES=` (a number, `unknown` when the list cannot be read) for the desktop client | `open` / `closed` / `partial` / `unknown` |
| `list [--machine]` | Paired devices: id, name, Tailscale device name, time of pairing. `--machine`: one `DEVICE=<id>\t<name>\t<device>\t<time>` line each, then `RESULT=ok` | — (`ok` with `--machine`) |
| `revoke <name or id>` | Revokes one device, effective at once; exit 1 when there is no such device | — |
| `disable` | Stops the service and removes its job file → removes the forward on every port this feature registered (after a port change too; other features' forwards are left alone) → drops a waiting pairing code. The list of paired devices is kept | `disabled`; unreadable state: exit 2, nothing changed; cannot stop or cannot remove the forward: exit 3 (`partial`), the output says what is left and which command to run |

</details>

<details><summary>Limits: what it can and cannot do</summary>

**Limits**:

- The resident service listens on `127.0.0.1` only; the one way in is the `tailscale serve` HTTPS forward. `enable` never opens a public entry (funnel) and refuses a port that has one. The ports this feature registered are kept in `~/.local/state/cavil-loop/remote-access/ports` (written before registering, struck only after the removal was read back), and closing or changing the port goes by that list; when Tailscale's forward settings cannot be read (the query fails, or exits 0 with no output) nothing is changed. That list and the `port` file holding the current port are themselves read three ways — absent / readable / not readable: a file that cannot be read, or has a line that is not a port number, means "which forwards are this feature's is not known" — `enable`, `pair` and `disable` exit 2 (`RESULT=state_unknown`), change nothing and do not overwrite the file, and `status` reports `unknown`; check with `tailscale serve status` as the message says, make `ports` one registered port per line (delete the file when there is none) and run the command again. When the list cannot be written: found before registering, nothing is registered (`state_unwritable`, exit 2); found only after a forward was removed, the result is `partial` (exit 3) — fix it and run again. When the list of paired devices cannot be read, `status` says "读不到" and `list` / `revoke` exit 2, never "0 devices".
- Every request is checked for who sent it first: the caller address the forwarding layer gives must be one Tailscale address, and `tailscale whois` on this machine must know which device it is. Not found, a failed lookup, or a public-entry mark: refused.
- After pairing the key never travels again: each request carries a signature over "time + one-time nonce + the request", and so does each reply; the caller's Tailscale identity must be the device that paired, so a key copied to another device is refused.
- All it can do: read the status (the output of `install-status.sh`, unchanged), stop / start one project (`scripts/project-service.sh <key> stop|start` — only "running → stop" and "stopped → start", neither when the state cannot be read, and the state is read back afterwards), read the last 200 lines of one project's `poll.log`, read / change one project's everyday settings (`scripts/project-config.sh <key> get|set` on this machine — only the settings `scripts/config-fields.txt` registers as editable, the same ones "本机 daemon → 配置" changes here; commands, hooks, tokens, folders and the label switches are not among them), revoke itself. It cannot disconnect a project, update the daemon, connect a new project, read the whole config file, or run an arbitrary command.
- The log is returned as it is on disk, with no processing of its own: the daemon already redacts GitHub tokens before writing `poll.log` (when that is on); everything else in it is visible to a paired client.
- Other system users on the same machine can reach the loopback port, but can do nothing without a pairing code or a key.
- The resident service holds its code in memory from the moment it started. Every poll round compares the code it runs with the code on disk and restarts it when they differ — see "After an update" below.

</details>

<details><summary>After an update: automatic restart, and the steps by hand</summary>

**After an update.** An update only replaces files on disk; the resident service keeps running the code it started with. Each poll round (Linux and macOS alike) asks the service on the loopback port which code it runs (`/v1/hello`: an interface level and the sha256 of its script, as read when it started) and compares that with the script the service registration points at (`--skill <folder>`). Only when the answer proves they differ — a fingerprint that is not the one on disk, or no fingerprint at all from a service that answers as this feature (an older version of the entry) — it restarts the service:

- only a service that is running (Linux `systemctl --user try-restart`, macOS `launchctl kickstart -k`: neither starts one that is stopped or unloaded), and only while holding the same lock `enable` and `disable` take (`~/.local/state/cavil-loop/remote-access/svc.lock`), re-reading everything after taking it. A round that cannot take the lock skips; `enable` / `disable` wait up to 60 s and otherwise change nothing (`RESULT=busy`);
- a restart counts as done only when the service then reports the fingerprint on disk. A failed or unconfirmed one is retried after 1, 2, 5 and 15 minutes, at most 5 times per version of the code, recorded in `remote-access/restart.json` (written as "in progress" before the restart is sent, so a round killed half-way still counts). After 5 failures it stops trying and says so in the poller's system log once a day and in `status`; a round that finds the service already on the code on disk drops the record, and code that changes again starts over. A record that cannot be read means no automatic restart (delete it to start over); one that cannot be written before a restart means no restart;
- anything that cannot be read — the service manager, the loopback answer, the port record, the registration — changes nothing, logs one line and waits for the next round;
- a stopping service answers new requests with 503 `not_ready` and finishes the ones in flight (up to 30 s) before it exits.

`status` shows both codes (`ENTRY_CODE=same|differs|unknown`) and the state of the automatic restart. When a client says the machine's remote entry runs code from before an update, or cannot tell, these are the steps it gives — they use only the service manager and the service's own registration, so they work on every install whatever the skill folder is called (`cavil-loop`, `coding-agent-work-loop`, `coding-agent-workflow`, a development checkout):

1. Restart the remote entry (pairings and port are kept). Linux: the first line below; success prints `active` (`inactive` or "not found": remote access is not on). macOS: the first line of the second block; success prints `state = running` ("Could not find service": not on). Neither starts a service that is off.
2. Open the settings again in the client. If they load, that was all.
3. Still the same message: the code on that machine predates the feature, update the daemon. The second line prints the skill folder the service uses: with a `.git` folder in it (a manual / development install) run `git -C <folder> pull`; without (a managed install) it updates itself within about 10 minutes. Nothing printed: the registration is missing or unreadable, run the installation (`setup.sh`) on that machine again. After updating, do step 1 once more.

<!-- remote-restart-linux:begin -->
```bash
systemctl --user try-restart cavil-loop-remote.service && systemctl --user is-active cavil-loop-remote.service
systemctl --user cat cavil-loop-remote.service | sed -n 's/.*--skill \([^ ]*\).*/\1/p'
```
<!-- remote-restart-linux:end -->

<!-- remote-restart-mac:begin -->
```bash
launchctl kickstart -k gui/$(id -u)/dev.luosky.cavil-loop.remote && launchctl print gui/$(id -u)/dev.luosky.cavil-loop.remote | grep 'state ='
sed -n 's|.*<string>--skill</string><string>\([^<]*\)</string>.*|\1|p' ~/Library/LaunchAgents/dev.luosky.cavil-loop.remote.plist
```
<!-- remote-restart-mac:end -->

</details>

<details><summary>Unpairing from the client</summary>

**Unpairing from the client**: when this machine can be reached, it confirms the revocation; when it cannot, the client can only stop using the key and show "取消配对未完成" — the authorization on this machine is **still there**. The client retries once the connection is back, or run `revoke` on this machine.

</details>

<details><summary>Protocol (for writing another client, or for debugging)</summary>

**Protocol** (for writing another client, or for debugging). The entry is `https://<machine name>:<port>`:

- `POST /v1/pair` with `{"code": "<8 digits>", "name": "<device name>"}` → `{"version": 1, "id": "<device id>", "key": "<64 hex digits>", "name": ...}`.
- Every other request carries four headers: `X-Cavil-Device` (device id), `X-Cavil-Time` (Unix seconds, within 120 s of this machine's clock), `X-Cavil-Nonce` (16–64 hex digits, never repeated — handled requests are recorded in `nonces.json`, so the same request replayed after a service restart is still refused; when that record cannot be read the service accepts no signed request for 240 s and answers 503 `not_ready`), `X-Cavil-Signature` = hex of HMAC-SHA256(key, `method\npath\ntime\nnonce\nhex SHA256(body)`). A reply's `X-Cavil-Signature` = hex of HMAC-SHA256(key, `resp\nnonce\nstatus code\nhex SHA256(reply body)`).
- `GET /v1/hello` (unsigned) → `{"service": "cavil-loop-remote", "version": 1, "level": <interface level>, "fingerprint": "<sha256 of the running script>"}` (older versions of the entry do not send `level` / `fingerprint`). `GET /v1/status` → `{"status": <install-status.sh output>, "entry": {"level", "fingerprint"} of the running service}` — the status carries `remote_access: {level, fingerprint}` of the code on disk, so a client can tell "code too old" from "updated, not restarted"; `POST /v1/projects/<key>/stop|start` → `{"result": "ok|failed|refused|not_found", "state": "running|stopped|unknown", "output": ...}`; `GET /v1/projects/<key>/log` → `{"path", "exists", "text"}`; `POST /v1/unpair` → `{"result": "revoked"}`.
- A project's settings: `GET /v1/projects/<key>/config` → `{"result": "ok", "config": <project-config.sh get output>}` or `{"result": "not_found|unreadable", "output": ...}`. `POST /v1/projects/<key>/config` with `{"rev": "<the config's fingerprint as read>", "values": {"MAX_CONCURRENT_WORKERS": "3"}}` → `{"result": <project-config.sh set's RESULT word>, "detail": {...}, "output": ...}`. Before running `set` the service checks the body — setting names `[A-Z][A-Z0-9_]*` (≤ 64), values only `A-Za-z0-9._:/@,+-` (≤ 200), a 64-hex fingerprint, 1–64 settings; otherwise `result: "refused"` and neither script runs — then reads the config once and lets only the settings marked editable right now through (`refused`, `set` not run). No `RESULT=` line from `set` (killed, timed out) is `unconfirmed`: the file may or may not have changed. A machine whose remote entry is too old to know these requests answers 404 `not_found` to both; the client then reads the status once more and says which it is: the code on disk is too old (update the daemon), the code on disk is new but the entry still runs the old one (restart it), or it cannot tell (the steps under "After an update").
- An error reply is `{"error": "<code>", "message": "<words for a person>"}`: `not_tailscale` / `unknown_device` / `funnel` (403, the caller is not a known Tailscale device), `pairing_closed` / `pairing_wrong` / `pairing_expired` / `pairing_locked` (403), `revoked` (401, never paired or revoked), `device_mismatch` / `signature` / `clock` / `replay` (403), `status_failed` (502, the status script did not run), `not_ready` (503, see above).

</details>

## Upgrading, migration, rollback, and development mode

Managed **Linux** installs upgrade **automatically**: each poll follows the tip commit of `CAVIL_DEPLOY_BRANCH` (default `main`), so a merge takes effect within about one fetch-throttle window (`CAVIL_DEPLOY_FETCH_INTERVAL`, default 300 s) plus a tick. On **macOS**, upgrades are manual. There is no durable rollback; to stay on one version, use development mode or point `CAVIL_DEPLOY_BRANCH` at a branch parked on that commit.

<details><summary>How a managed Linux upgrade works</summary>

Managed **Linux** polls fetch the configured base branch with a bounded network timeout, unpack a complete immutable tree, then atomically replace the stable link. Offline, lock, and fetch failures retain the current release; consumers can continue starting from it while fetch is in progress. Upgrades are **automatic**, and no target version can be pinned: the deployer follows the tip commit of `CAVIL_DEPLOY_BRANCH` (default `main`), unrelated to GitHub Releases or tags — a release is just an immutable snapshot of that commit at `releases/<sha>/`. A host-wide `CAVIL_DEPLOY_FETCH_INTERVAL` (default 300s) throttles fetches, so a merge to the base branch takes effect within roughly one throttle window plus a tick. Switching affects only later starts: consumers already running hold a shared `.inuse` lease and stay on their own SHA. Migrate a checkout-style installation only through an explicit action:

</details>

<details><summary>Moving a checkout-style install to managed; development mode</summary>

```bash
bash ~/.agents/skills/cavil-loop/setup.sh <host>
# or, from the old checkout:
bash scripts/skill-deploy.sh --bootstrap --force
```

This avoids mistaking a maintainer's development link for production. On Linux, standalone bootstrap also repoints already-installed systemd template symlinks to the stable managed skill and reloads the user manager; missing units are not installed, so use `setup.sh` for a new scheduler installation. A real directory at the stable path is preserved as a timestamped `.pre-managed.*` backup. For development mode, atomically point the stable link outside `releases/`; routine deployment refuses to take it over until another explicit bootstrap. Development mode still installs the durable `entrypoints/` from that checkout, because the scheduler units always start through them. A checkout without those launchers stops polling with exit 127 (`poll-entry.sh: No such file or directory`, visible only in the poller's `journalctl --user -u <timer unit>`, never in `poll.log`); pull to the latest commit or bootstrap to recover.

</details>

<details><summary>Rollback</summary>

**There is currently no durable rollback.** A successful deployment immediately reclaims every old release without an active lease, so usually no rollback target survives; and even when a lease keeps one alive, pointing the stable link back at it only holds until the next deployment — the deployer does not compare versions, it aligns the stable link with the base-branch tip, so it switches forward again. To stay on a specific version, use development mode to opt out of management, or point `CAVIL_DEPLOY_BRANCH` at a branch parked on that commit.

</details>

<details><summary>What a deployment does with each kind of changed file; alerts</summary>

| Changed files | Deployment behavior |
|---|---|
| scripts, data, prompts | Active with the stable-link switch |
| systemd `.service` / `.timer` | Runs `systemctl --user daemon-reload` |
| systemd `.socket` / `.slice` changed or removed | Not applied automatically; opens one actionable alert |
| systemd unit file **added** | Nothing to do — no machine has installed it yet; no alert |
| launchd plist template content changed | Not applied automatically; asks for `setup.sh` |
| launchd template added / renamed / removed | Nothing to do — plists already generated do not depend on the template file; no alert |

After the remote is observed ahead for the configured threshold, deployment opens at most one issue in the configured alert repository and closes that lag alert after recovery. Alerts for manual scheduler work (`.socket`, `.slice`, launchd, or a failed `daemon-reload`) persist across no-change deployments and clear only after a maintainer closes the alert issue to acknowledge completion.

</details>

<details><summary>macOS: upgrading by hand</summary>

On **macOS**, upgrades remain manual. The per-project LaunchAgent plist is generated by `setup.sh`; regenerate it after a template change:

```bash
launchctl bootout gui/$UID/dev.luosky.cavil-loop.<key> || true
rm ~/Library/LaunchAgents/dev.luosky.cavil-loop.<key>.plist
bash ~/.agents/skills/cavil-loop/setup.sh <host>
```

Only managed Linux installations fetch script-only updates automatically.

</details>

### New settings an upgrade does not add to your config

An upgrade never edits your `cavil-loop.config`, so a new feature that is off when its line is missing stays off on an existing project. Scheduled polls check for such missing settings and write one `poll.log` line the first time each one is missing (a setting added and then removed again is reported again); nothing else happens.

<details><summary>Which settings are reported, and when</summary>

An upgrade replaces the code, never your project's `cavil-loop.config`. A new feature that is **off when its line is missing** — while `cavil-loop.config.example` turns it on, so freshly installed projects have it — therefore stays off on an existing project, silently. The keys this applies to are registered as `notice` in [`scripts/config-notices.txt`](../scripts/config-notices.txt); every other key of the template is registered there as `quiet`, with the reason (same behaviour when missing, required, example value, permission flag).

Each scheduled poll the daemon checks those keys against what the config (plus the systemd environment file) actually sets. An empty value such as `ENABLE_CONCURRENT_WORK_HINT=""` counts as "decided: off" and is never reported. Each key that is missing gets one line in `poll.log` (`⚠️ 配置提示：本项目配置里没有 <KEY> …`, with the template line that turns it on and the value that keeps it off) — once per key; a key that is added and later removed again is logged again.

That log line is all it does. The daemon sends no GitHub call for this and opens no issue; a notice issue opened by an older version is neither commented on nor closed — close it by hand. A `CONFIG_NOTICE_ISSUE` line in an old config is ignored and can stay. The daemon never edits the config. This runs only in the scheduled poller (started through `poll-entry.sh`): running `agent-poll.sh` by hand for a dry run, or from inside a worker session, writes nothing. State lives in `$STATE_DIR/config-notice.json`; deleting it only means "judge afresh" (at worst each missing key is logged once more).

</details>

<details><summary>See what a project lacks</summary>

To see what a project lacks, run this in any shell (set `KEY` first; nothing else needs to be set):

<!-- config-notice-ops:begin -->
```bash
KEY=myproject    # the instance name / 实例名: systemctl --user list-timers 'cavil-loop-poll@*'
ENV_FILE="$HOME/.config/cavil-loop/$KEY.conf"
[ -f "$ENV_FILE" ] || ENV_FILE="$HOME/.config/coding-agent-work-loop/$KEY.conf"   # installed before the rename / 改名前装的
CONF=$(sed -n 's/^CODING_AGENT_CONFIG=//p' "$ENV_FILE" | tr -d '"')
STATE_DIR=$(bash -c 'source "$1" >/dev/null 2>&1; printf %s "$STATE_DIR"' _ "$CONF")
echo "config: $CONF"
echo "state:  $STATE_DIR"
if [ -f "$STATE_DIR/config-notice.json" ]; then
    jq . "$STATE_DIR/config-notice.json"
else
    echo "no config-notice.json: nothing missing, or no scheduled poll of this version yet / 没有缺项，或新版本还没被调度器跑过"
fi
grep -s '配置提示' "$STATE_DIR/poll.log" | tail -5
```
<!-- config-notice-ops:end -->

How to read it: `logged` lists the keys missing right now (each written to `poll.log` once). After you add a key's line to the config, the next scheduled poll drops it from the list. A file written by an earlier version may still carry `issue` / `issued`; the next scheduled poll drops them.

</details>

<details><summary>Adding a new setting to the template</summary>

Adding a key to `cavil-loop.config.example` means registering it in `scripts/config-notices.txt` in the same change — `tests/config-notice.test.sh` fails otherwise. Register it as `notice` only when it is off when missing but on in the template.

</details>

## Installations from before the rename

Installations made before the project was renamed to `cavil-loop` (its earlier name is `coding-agent-work-loop`) keep running on their old names until they are migrated, and the migration is automatic — see [Automatic migration](#automatic-migration-of-old-installations). Wherever both an old and a new path exist, the new one wins.

<details><summary>Old and new names, side by side</summary>

| What | New installation | Before the rename (still honored) |
|---|---|---|
| Skill entry | `~/.agents/skills/cavil-loop`, `~/.claude/skills/cavil-loop` | `~/.agents/skills/coding-agent-work-loop` |
| Skill command | `/cavil-loop` | `/coding-agent-work-loop` (no alias is kept) |
| Per-project env file, `deploy.conf`, preview registrations | `~/.config/cavil-loop/` | `~/.config/coding-agent-work-loop/` |
| State | `~/.local/state/cavil-loop/<project>/` | `~/.local/state/coding-agent-poll/<project>/` |
| Linux units | `cavil-loop-poll@` / `cavil-loop-weekly-report@` / `cavil-loop-preview*@` / `app-cavil\x2dloop\x2dpoll.slice` | `coding-agent-*` / `app-coding\x2dagent\x2dpoll.slice` |
| macOS LaunchAgent / logs | `dev.luosky.cavil-loop.<key>`, `~/Library/Logs/cavil-loop/` | `dev.luosky.coding-agent-work-loop.<key>`, `~/Library/Logs/coding-agent-work-loop/` |
| Local config in the project root | `cavil-loop.config` | `coding-agent.config` |
| Project override directory (committed) | `.agents/skills/cavil-loop/` | `.agents/skills/coding-agent-work-loop/`, `.agents/skills/coding-agent-workflow/`, `.coding-agent/` |

</details>

<details><summary>How the code picks a name, and what that means for each part</summary>

How the code chooses, everywhere (`scripts/_names.sh`; `release-entry.sh` inlines the same
rule): **if the new-name path exists use it, otherwise use the old-name path if that exists,
otherwise create the new one.** When both exist the new one wins.

- The old `coding-agent-*` unit files stay in `systemd/` **byte for byte**: the units installed
  on old machines are symlinks to those exact paths, and changing a `.socket` / `.slice` would
  raise a manual-action alert on every machine.
- `setup.sh` initialises `state.json` only when the state directory has none. Re-running it — on
  any installation, including the run that just migrated an old one — keeps the existing read
  cursors and worker records instead of rebuilding them from the currently open items.
- Re-running `setup.sh` on a project whose `~/.config/coding-agent-work-loop/<key>.conf` exists
  first migrates it (below) and then continues as a new installation. If the project is busy the
  migration is skipped and setup keeps the old names for this run. It never installs a second,
  new-named timer next to a running old one — two pollers would race for the same issues.
- A project that already has `coding-agent.config` keeps that file name: its ignore rule names the
  old file, and a renamed copy would no longer be ignored and could be committed by a worker.
- One machine can carry both skill entries (old projects use the old one, a newly set-up project
  the new one). The deployer switches both together whenever both point into `releases/`, and
  never deletes a release that one of them still points to.
- On-demand previews follow **their own registration**, not "which units this machine has":
  a preview an old project registered stays on the old units and the old registration
  directory even after new units are installed, until it is moved to the new units (see "Old
  previews move to the new units" below). Ownership checks, `--list` and unregistering look at
  both directories; a port taken in either one is taken. Old and new share one port lock (the
  old directory's while the machine has old units or the old registration directory — which is
  why that directory is kept even once empty). When starting, each unit reads the registration it
  is bound to — the new unit passes its path, the old one reads the old directory. Fresh
  registrations, and re-registering your own old registration on a machine that has the new
  units, use the new units.
- Old and new workers land in different slices, so each slice carries its own memory limit while
  both kinds of installation coexist. The new slice name follows the same derivation rule as
  the old one; it has not yet been observed on a real machine.

</details>

### Automatic migration of old installations

`scripts/migrate-legacy.sh` moves one old project to the new names. Nobody has to run it: on Linux
any project's poll migrates every idle old project on the machine; on macOS re-run `setup.sh <host>`.

<details><summary>When it runs on each system</summary>

- **Linux**: every poll tick of *any* project (`poll-entry.sh`, before the poller loads its
  config) migrates every idle old project on the machine. So it takes effect once the release
  containing it is deployed — within ~10 minutes of merging on managed installs. A machine in
  development mode (skill link pointing at a checkout) picks it up when that checkout is updated.
  When the project being migrated is the one whose old timer started this tick, the tick ends
  right there and the new timer (enabled by the migration) runs the next one ~30 s later.
- **macOS**: re-run `setup.sh <host>`. It migrates first and then generates the new LaunchAgent.
  launchd plists are generated, so the background poller cannot swap them itself.

</details>

<details><summary>Only an idle project is migrated</summary>

**Only an idle project is migrated.** Idle means: no worker tmux session of that project
(`<TMUX_PREFIX>-<SESSION_NAME_PREFIX><N>`), its weekly report is not running, and its poll lock is
free. The poll lock is taken **first** and the worker / weekly checks run while holding it: workers
are only dispatched by a poll holding that lock, so no new worker can appear between the check and
the move (checking first and locking second leaves a window in which a poll dispatches and
releases). A running worker remembers the old paths; moving the state directory under it would
make its next `source _lib.sh` recreate an empty one at the old place. A busy project is retried
on every tick; the reason is logged at most once an hour. The weekly report does not read the
state directory; it is only checked so its timer is not swapped mid-run.

</details>

<details><summary>While a project is mid-migration, its main poll is skipped</summary>

**While a project is mid-migration, its main poll is skipped.** From step 1 until the end, the
progress file names the project's config (`CFG=…`); `poll-entry.sh` sees that and ends the tick
without running `agent-poll.sh`. Otherwise a tick landing between "state directory moved" and
"config rewritten" would `mkdir` an empty state directory at the old place and re-dispatch every
old comment from empty state. The next tick (of this or any other project) resumes the migration.
A one-off look at the progress file is not enough — a tick could look before the migration
starts and load the old config just before the directory moves. So while this machine still has
old installations, `poll-entry.sh` holds the **shared** side of the machine-wide migration lock
from that check until `agent-poll.sh` has taken the project's own poll lock (then releases it, so
nothing it spawns inherits it); a migration needs the exclusive side to start.
Everything that needs a human (below) is checked **before** step 1, so a project only pauses when
the migration is actually able to finish. An empty stray directory that still appears at the old
place mid-migration (no `state.json`, only `poll.log` / `poll.lock`) is recognised, its log merged
into the new directory, and removed.

</details>

<details><summary>The steps, in order</summary>

What happens, in order (each step can be repeated; an interrupted run is finished by the next one):

| Step | What | Old copy |
|---|---|---|
| 1 | Record whether the old timers were enabled / running (`~/.config/cavil-loop/migration/<key>.inprogress`); back up the env file, the project config and the state's `state.json` / `agent-sessions/` / `poll-pace.json` | backup in `~/.config/cavil-loop/migration/<key>-<ts>/` (0700) |
| 2 | Shared, first project only: `~/.agents/skills/cavil-loop` pointing where the old link points; `~/.claude/skills/coding-agent-work-loop` → `cavil-loop` (no alias kept); `deploy.conf` moved, old skill path inside it rewritten | `deploy.conf.migrated-<ts>` |
| 3 | Linux: link the new unit templates; copy the machine's slice drop-in to the new slice | the old slice and its drop-in stay — a tmux server started before the migration still lives in it |
| 4 | Move the state directory (`~/.local/state/coding-agent-poll/<p>` → `~/.local/state/cavil-loop/<p>`, one same-disk rename) **and** rewrite the hard-coded path in the project config. The rewritten config is verified before anything moves | config original in the backup |
| 5 | Write `~/.config/cavil-loop/<key>.conf` (0600) | — |
| 6 | Linux: copy the instance drop-ins (poll interval) to the new timer names; enable / start the new poll / weekly timers **only if the old ones were** enabled / running; **then** `disable --now` the old ones (never the service: the migration often runs inside it). New first: if the new timer cannot be enabled or started, the old one is still running and retries on its next tick; while both are on, both ticks only resume the migration (progress file) and neither runs the main poll. macOS: `bootout` the old LaunchAgent | old drop-ins and instance links → backup; old plist → backup |
| 7 | Rename the old env file last — while it exists, the next run comes back to finish | `<key>.conf.migrated-<ts>` |

</details>

<details><summary>When the old skill link is removed</summary>

When no old project is left **and every old preview has moved to the new units**, the old
`~/.agents/skills/coding-agent-work-loop` link is removed; unit links that still go through it
(old preview templates, the old slice) are first re-pointed through the new link — the old unit
files are kept byte for byte.

</details>

<details><summary>Not moved, on purpose</summary>

Not moved, on purpose:

- The project's own files: `coding-agent.config` keeps its name (its ignore rule names the old
  file), only its `STATE_DIR` line (and any other mention of that same directory) is rewritten;
  backups are never written into the project directory. Committed override directories are not
  renamed.
- `~/.local/state/coding-agent-poll/review-shots`: comment images are served from it under a public
  URL; the code keeps using it while no new one exists.
- A state directory configured outside `~/.local/state/coding-agent-poll/<p>`: left where it is.

</details>

<details><summary>When it stops and waits for a human; when it keeps failing</summary>

It stops before touching anything and waits for a human (logged with ⛔, retried each tick but logged hourly; the old installation keeps polling meanwhile) when the new
and old env file both exist without a migration in progress (someone installed the new one by
hand — two timers may be running), when old and new state directories both exist, when the
project config's `STATE_DIR` cannot be rewritten mechanically, or when the new state root is on a
different disk.

A project whose migration keeps failing *after* it started (e.g. `systemctl` errors every time)
stays paused; every attempt logs a ❌ line. On macOS, re-running `setup.sh` after a half-done
migration finishes it; setup refuses to continue on the old names in that state.

</details>

<details><summary>Log and undo</summary>

Log: `~/.local/state/cavil-loop/migrate.log` (also in the journal of whichever poll ran it, and one
line in the project's own `poll.log`). Undo by hand from the backup directory.

</details>

#### Old previews move to the new units

Before the old skill link is removed, every preview an old project registered moves to the new units on the same port and URL — automatically, every poll tick. A conflict between two owners of one port waits for a human (see the folds below).

<details><summary>Why previews must move, and who moves them</summary>

The old preview unit files hard-code `%h/.agents/skills/coding-agent-work-loop/scripts/…` in
`ExecStart` / `ExecStartPost`. Re-pointing the unit-file symlink does not help: once the old link
is gone, the old unit cannot find its scripts and every old preview returns 502. So before
that link is removed, every registration under `~/.config/coding-agent-work-loop/preview/` moves
to `cavil-loop-preview*@<port>` — same port, same URL (tailscale routes are bound by port and stay).

Who moves them: once every old project is migrated, the migration step of every poll tick moves
them (a failed one is retried next tick); `preview-serve.sh` moves its own registration first when
the machine has the new units and that registration is still in the old directory. Both call the
same function (`scripts/_preview_adopt.sh`), holding the port lock throughout.

</details>

<details><summary>Per-port steps and the three states</summary>

Per port (every step is safe to repeat; wherever it stops, the next run only finishes what is left):

| Step | What | On failure |
|---|---|---|
| ① | The first time a port is touched, record whether its old listener was meant to be on (listening or `failed` = on; not listening = off) in `~/.config/cavil-loop/migration/preview-<port>.listen`; an existing record is never overwritten | nothing changed |
| ② | **Copy** the old registration into the new directory (left alone if the new one already has it with the same owner) | old registration untouched |
| ③ | Stop and `reset-failed` the old socket / proxy / app; confirm none of them is running | both registrations stay; next tick resumes |
| ④ | If it was meant to be on, start the new socket and confirm it is listening; otherwise skip | both registrations stay; while the old link exists, the old socket is started again |
| ⑤ | Move the old registration into `~/.config/cavil-loop/migration/preview-legacy/` (not deleted); drop the ① record | — |

So a port is always in one of three states: only the new directory has it = **done**; both, same
owner = **half moved**, resumed next tick; both, different owners = **conflict**, neither is
touched, `migrate.log` notes it hourly and a human decides which one is real. While any port is
half moved or in conflict, the old skill link is kept — those old units still need it.

**A port whose state cannot be read is not done either.** When the user service manager is
unreachable (`systemctl --user` only prints an error and no state), the step neither records the
original state nor concludes the old units have stopped; the registrations and the old link stay
as they are, the log says the state could not be read, and the next tick tries again.

</details>

<details><summary>Resolving a conflict (by hand)</summary>

**Resolving a conflict (by hand).** `preview-unserve.sh` cannot do it: if either of the two
registrations belongs to someone other than the caller, it touches nothing (exit 3) — on purpose,
and that must stay. Use `scripts/preview-resolve-conflict.sh` instead. It does every step inside
**one hold of the port lock**, so registration, unregistration and migration of that port wait
meanwhile; and the copy you keep **always ends up on the new units**, so switching back after a
wrong choice never depends on the old skill link — once every conflict is resolved, the next
migration tick removes that link.

1. **Look** (read-only, changes nothing):
   ```bash
   bash ~/.agents/skills/cavil-loop/scripts/preview-resolve-conflict.sh 4050
   ```
   Prints each copy's owner (project, issue, worktree) and the old and new listener states.
   Normally keep the one whose worktree still exists and whose issue is still open.
2. **Keep one** (`old` = the copy in the old registration directory, `new` = the one in the new):
   ```bash
   bash ~/.agents/skills/cavil-loop/scripts/preview-resolve-conflict.sh 4050 --keep new
   ```
   It backs both up to `~/.config/cavil-loop/migration/preview-conflict-<port>-<time>/` (the first
   output line, `备份：…`, is that directory — note it) → stops the removed side's socket / proxy /
   app and confirms they stopped → moves that registration into the backup → when keeping `old`,
   moves it onto the new units right away → confirms the new listener is up. `✅` means done; any
   failing step exits 1 and says where it stopped — if units would not stop, no registration was
   moved, and re-running the same command after fixing it is safe.
3. **Check**: open the preview URL and see the page. After the next poll tick (about a minute)
   `migrate.log` no longer reports a conflict for this port; once every conflict is resolved and
   every old preview has moved, the old skill link is removed — that is expected.
4. **Wrong choice**: switch to the copy that was removed (the backup directory from step 2):
   ```bash
   bash ~/.agents/skills/cavil-loop/scripts/preview-resolve-conflict.sh 4050 --swap ~/.config/cavil-loop/migration/preview-conflict-4050-<time>
   ```
   It first proves this backup belongs to this port's resolution: the port recorded in the backup and
   the port inside the copy to restore must both be this port, and the current registration must be
   byte-identical to the copy that was kept back then. Anything else is refused (exit 2) and nothing is
   touched — a backup from another port, or a port that was re-registered after the resolution, stops
   here. Then it **copies** the current registration into the backup, stops the new units, replaces the
   registration in place in one atomic step (it is never missing), and starts the listener on the
   **new units** — this works even after the old link is gone. A failure exits 1; re-run the same
   command after fixing it and it continues where it stopped. Then check as in step 3. Files already in
   the backup directory are never changed: `old.conf` / `new.conf` are the registrations as they were before.

</details>

<details><summary>When the poll entry runs the migration</summary>

The poll entry therefore calls the migration not only while old project env files exist, but also
while the old registration directory has entries, or while both the old and the new skill links
exist (`cavil_legacy_leftovers` in `_names.sh`). With none of the three it is not called. Guard:
`tests/preview-legacy-adopt.test.sh`.

</details>

## Manual cron fallback

The schedulers in [Scheduler by OS](#scheduler-by-os) aren't required: `agent-poll.sh` is stateless and any scheduler can drive it. Use this on a system `setup.sh` doesn't configure (BSD, WSL without systemd, a container, …) or when you'd rather not use systemd / launchd.

<details><summary>cron line</summary>

**cron** (any Unix):

```cron
* * * * * CODING_AGENT_CONFIG=$HOME/myproject/cavil-loop.config bash $HOME/.agents/skills/cavil-loop/scripts/poll-entry.sh >> /tmp/cavil-loop-cron.log 2>&1
```

</details>

<details><summary>Driving it from a Claude Code <code>/loop</code> session instead</summary>

Open a long-running session that calls `/loop 60s bash ~/.agents/skills/cavil-loop/scripts/poll-entry.sh`. Upside: the scheduling logic can be context-aware. Downside: expensive + the session dying stops everything.

</details>

## Upgrading to webhooks (instant trigger)

Polling has up to 1 minute of latency. For an instant trigger, let a small webhook listener run `agent-poll.sh` on GitHub events and keep the timer as a fallback.

<details><summary>Steps</summary>

1. Tailscale funnel / Cloudflare tunnel to expose your local `<port>` publicly
2. Run something like [`webhook`](https://github.com/adnanh/webhook) — a small listener subscribed to GitHub `issue_comment` + `labeled` events
3. On event → invoke `agent-poll.sh` (the poller is label-filtered and state.json-deduped, safe to retrigger)
4. Keep the systemd timer / launchd LaunchAgent as a fallback

</details>

## Custom worker (not Claude Code)

Workers are chosen through a thin **driver layer** — no fork needed. Built-ins: `claude`, `opencode`, `codex`, `cursor`; to add your own agent, drop a `scripts/drivers/<name>.sh` (or a project-level override at `<host>/.agents/skills/cavil-loop/drivers/<name>.sh`) — see [drivers.md](drivers.md) for the 5-function contract and a template.

<details><summary>Which agent and model each role uses</summary>

Ordinary work uses `WORKER_AGENT=claude` by default; `WORKER_MODEL` is an optional model override for that path. When the optional review gate is enabled, review uses `REVIEW_WORKER_AGENT=codex` and `REVIEW_MODEL` independently. An empty model leaves selection to the driver's current default.

</details>

## Release cadence

One release per iteration (a calendar week, Monday–Sunday). A scheduled run every day at 00:10 Beijing time releases the week that just ended once its regression-test gate is green; the desktop client is released in the same run when `client/` changed.

A Release is a changelog and an `npx skills add` landing point; it **has nothing to do with how managed installs upgrade** — managed Linux follows the base branch tip (see [Upgrading, migration, rollback, and development mode](#upgrading-migration-rollback-and-development-mode)).

<details><summary>How the weekly release works: schedule, which week, which commit, the gate, the tag table, manual runs, the client</summary>

One release per iteration. Iterations follow the cavil project board's Iteration field: 7 days, starting Monday, aligned to calendar weeks — so the board is not read, the schedule is a calendar one:

- **When**: the scheduled trigger in `.github/workflows/release.yml`, **every day** at 00:10 Beijing time (16:10 UTC). Monday's run releases the week that just ended; the other six find it released and stop within seconds — or, when Monday's gate was red, the first daily run after the fix is on main releases that same week, under that week's name and title. GitHub may start scheduled runs minutes to tens of minutes late under load.
- **Which week**: "the week that just ended" = the latest Sunday D that is over in Beijing time when the run starts (Sunday 23:59 Beijing is still the previous week; from Monday 00:00 it is this one). The plan step works it out once; the gate and the tag use the week, commit and tag it fixed, even across midnight. Only the latest week is caught up: when two or more weeks were missed, the earlier ones get no release of their own and their commits go into the one that is released.
- **Which commit when main moves during a run**: a run can wait in the queue behind another Release run (only one runs at a time), and the gate takes a while; main often gets new commits meanwhile. The plan step takes main's tip as it is when the plan step runs — not the commit the run was triggered on — and the release step tags exactly the commit the gate tested, however far main has moved since. Only a checkout that is not on main's history at all is refused. Running `scripts/release.sh` by hand still requires the local main to equal `origin/main`.
- **What the gate runs**: the shell regression suite — the same four `tests/run.sh --ci` shards and exactly-once check as the Tests workflow on every PR — on the one commit the tag will point at. Any red, skipped or missing gate job means no tag and no page. The negative controls are **not** part of it: they run every night on their own (next section but one) and a red one opens an issue instead of holding the release.
- **What**: tag `release/vD.N`. The Release title carries the Monday–Sunday week the tag's date falls in, e.g. `release/v2026.10.25.1 · 迭代 2026-10-19 ~ 10-25`. The plan step (`scripts/release.sh --plan`) decides in order, first match wins:
  1. a `release/v*` tag on main's tip has no Release page → gate that commit, create that tag's page, no new tag
  2. a tag of the week that just ended has no page (the highest such one) → gate **that tag's own commit**, create its page, no new tag
  3. every tag on main's tip has its page → nothing; logs "本轮无新提交" (no new commits this round)
  4. the week already has a released tag: a scheduled run releases nothing; a manual release tags main's tip with the week's next number
  5. otherwise → tag main's tip `release/vD.1`
- **A tag without its page gets one later**: if the tag was pushed but creating the Release failed, the next run (scheduled or manual release) creates the missing page first (rules 1 and 2), before "this week is released" is looked at. The notes start at the nearest earlier tag that **has a Release page**; a tag that never got one (from an earlier week, say) is skipped, so its changes go into the next Release. If the list of Releases cannot be read, the run fails rather than guessing. Tags are read from the remote itself (a checkout can still hold a tag the remote has deleted), and a failed listing fails the run too. Right before the page is created the remote tag must still point at the tested commit — deleted or moved means no page — and `gh release create --verify-tag` never creates a missing tag.
- **Manual release**: Actions → Release → Run workflow (on main, `gate_only` unticked) follows the same table, except rule 4; with `gate_only` ticked it only runs the gate (the regression suite), always on main's tip, whatever the week's state, and creates no tag and no page. Or run `bash scripts/release.sh` on a local main (interactive — today's UTC date, and it does not check whether HEAD is already released).
- **Within the same run**: a tag pushed with the built-in token does not trigger another workflow run, so scheduled / manual runs create the Release in the same job; tags pushed by a person still trigger the tag path. No extra secret is needed.
- **The desktop client rides along**: a run that releases the week (rules 1, 2, 4 and 5 above — not a gate-only run, not a `release/v*` tag pushed by hand) also releases the client when `client/` changed since the last client release that has a Release page. Its version is the highest `client/vX.Y.Z` tag plus one in the last place, or the committed `client/package.json` version when that is higher (raise it there to start a new minor version); nothing has to be committed for a release, the build writes the version from the tag. The `client` job calls `.github/workflows/client.yml` for that tag on the planned commit: the same quick and full tests, both Macs, size gate and Release page as a `client/v*` tag pushed by hand, which still works. The tag is created only once all of that passed, on the tested commit. The daemon's release does not wait for the client, and the client does not wait for the daemon's gate. A red client run means no client release this week (the daemon's still goes out) and the failure report below says so; the next weekly release tries again when `client/` has changes, or push the tag by hand after the fix.

</details>

### A failed run opens an issue

Whenever a job of a Release run fails — scheduled, tag push, manual release or manual gate-only (marked "诊断运行", diagnostic) — the last job, `report failure`, writes to an issue so the failure is not seen only by whoever opens the Actions page. A cancelled run reports nothing.

<details><summary>What the report writes, and when it cannot</summary>

- **No open one of the same kind**: it creates an issue titled `Release 工作流运行失败（自动报告）`, labelled `pending/agent`, so the daemon dispatches it like any other. "Same kind" = this repo, open, created by `github-actions[bot]`, body carrying `<!-- cavil-release-failure -->`, not a PR.
- **One is open**: it adds a comment to the lowest-numbered one and **never touches its labels** — whatever state it is in (being worked on, waiting for a human, waiting on a prerequisite), it stays there. Close it once the failure is dealt with; the next failure opens a new one.
- **What it says**: the run link, how the run was started, the tested commit, every job's result with its failed steps, and the shell units the gate summary did not pass. When the gate passed and only the release job failed, it names the step.
- **When it cannot tell** (a page of the issue list or one of its items cannot be read whole, the issue changed between the lookup and the write) it writes nothing and the `report failure` job goes red. Look at that job's log.
- The label it puts on a new issue is the repository variable `RELEASE_FAILURE_LABEL` (default `pending/agent`); it must match this repo's dispatch label.

</details>

<details><summary>Fixing a missing label; turning the report off and on</summary>

<!-- release-failure-ops:begin -->
**The job is red with "issue #N 已建、派工标签没打上" (created, the dispatch label is not on it)**: the issue exists but the daemon will not pick it up. Later runs only comment on it, they never add the label. Put the label on by hand, with N being the number in that message:

```bash
N=123
gh api -X POST "repos/GigleAI/cavil-loop/issues/$N/labels" -f 'labels[]=pending/agent'
gh api "repos/GigleAI/cavil-loop/issues/$N" --jq '[.labels[].name]'
```

Success: the list printed last contains `pending/agent`. If the first command answers 404 for the label, the repo has no such label: create it first (`setup.sh` does), or set `RELEASE_FAILURE_LABEL` to the repo's dispatch label. Nothing to roll back: removing the label again (Labels on the issue page) puts it back as it was.

**Turning it off** (the job is then skipped on every run) and **back on**:

```bash
gh variable set RELEASE_FAILURE_REPORT --body off --repo GigleAI/cavil-loop
gh variable delete RELEASE_FAILURE_REPORT --repo GigleAI/cavil-loop
```

Run only the first line to turn it off, only the second to turn it back on. Check: `gh variable list --repo GigleAI/cavil-loop` shows `RELEASE_FAILURE_REPORT off` while it is off, and nothing of that name once it is on again.
<!-- release-failure-ops:end -->

</details>

### Negative controls run every night

A negative control breaks the code on purpose and requires the tests to go red — it tests the tests, not the code. All of them (every `tests/*.test.sh` with `MUTATION=1`, autopilot's broken copies over six jobs, the client's `test/mutation` and the real app's set) run in `.github/workflows/negative-controls.yml` and nowhere else:

<details><summary>When and where they run, and what a red run does</summary>

- **When**: every night at 02:10 Beijing time (18:10 UTC), on main's tip. A scheduled run stops at its first job when the last successful run of this workflow was on the same commit; if that cannot be looked up it runs. Actions → Negative controls → Run workflow (on main) runs it by hand, always. A run on any other branch does nothing.
- **Not on pull requests, not in Tests or Client**: neither workflow has a "negative controls" option, manual runs included. Workers and reviewers do not run them while developing.
- **Does not hold a release**: the release gate is the regression suite only (see "What the gate runs" above).
- **A red run opens an issue** the same way a failed Release run does (the same script, the same rules: only create or comment, re-read before writing, never touch an existing issue's labels) — but its own: titled `负对照每晚运行失败（自动报告）`, marker `<!-- cavil-negative-controls-failure -->`, labelled `pending/agent` (`RELEASE_FAILURE_LABEL`). The two kinds never comment on each other's issue. It lists the failed jobs, the shell units that did not go red and the client entries that did not go red.

</details>

<details><summary>Turning the nightly report off and on</summary>

<!-- negative-controls-ops:begin -->
**Turning the nightly report off** (the runs go on, a red one just opens no issue) and **back on**:

```bash
gh variable set NEGATIVE_CONTROLS_REPORT --body off --repo GigleAI/cavil-loop
gh variable delete NEGATIVE_CONTROLS_REPORT --repo GigleAI/cavil-loop
```

Run only the first line to turn it off, only the second to turn it back on. Check: `gh variable list --repo GigleAI/cavil-loop` shows `NEGATIVE_CONTROLS_REPORT off` while it is off, and nothing of that name once it is on again.
<!-- negative-controls-ops:end -->

</details>

### The client's development build: built on a merge, a nightly catch-up

The client's development builds (tag `client/vX.Y.Z-dev.N`, marked Pre-release) come out of `.github/workflows/client.yml`: a merge into main that touches the client starts a run; it runs the quick tests, then decides by the same rule as the nightly run whether to build: when the newest published development build is complete and the client has not changed since it (or that build is of this very commit), nothing is built; when the client changed, or that newest build lacks files, is not public, has its tag on the wrong commit, or cannot be read, a higher version is built and published. A nightly run applies the same rule and so tries again when a merge's build did not come out:

<details><summary>When it runs, what it builds and publishes, how it decides, a build by hand</summary>

- **On a merge into main** that changes `client/`, `.github/workflows/client.yml` or `.github/actions/client-setup/`: the quick tests always; then, by the same check as the nightly run below, both builds with their update checks, the size gate, and the publish step. When that check says nothing is to be built (most often a revert back to the newest build, which is complete), only the quick tests run — unlike a night with nothing new, which ends before them. A merge that changes none of these starts no client run (the client would be the same).
- **When the nightly run runs**: every night from 04:30 Beijing time (20:30 UTC), about an hour, on main's tip. GitHub's scheduled runs can start tens of minutes late at busy times and are occasionally skipped; that night's build then moves to the next night.
- **Only when the client changed**: it first looks up which commit the newest published development build was made from, then compares that commit with main's tip on `client/`, `.github/workflows/client.yml` and `.github/actions/client-setup/`. No difference: it stops there, builds nothing, publishes nothing, and the run is green. A newest build that does not carry all six files, fully uploaded, or whose tag is not on the commit the release recorded (see "Checking whether a build is complete" below — the nightly decision, the publish step, a rerun and the check command go by one rule), counts as not finished, but a public release is never changed: on that same commit nothing is built or published (with `force` it builds and checks, and the publish step fails and writes nothing); once main has a new commit it builds as usual and publishes a higher version over it, even with no client change, and the incomplete one stays as it is. A draft that never went public (a publish cut off part-way: no publish time recorded, no tag yet) is filled in and published; a draft that was public once (GitHub keeps its publish time and its tag) is left as it is like a public one, and so is one where that cannot be read. Before creating a release page or filling in a draft it reads this version's tag: a tag already there (on any commit — a release page deleted with its tag left, or a tag made by hand) means the version was made before, and it is not changed either; a tag it cannot read means nothing is written. After publishing it reads the tag again, and it must be on the commit that was built, or the run fails and cleans nothing up; a rerun of that commit that finds the version complete checks the tag first as well, and fails the same way, cleaning nothing up. Filling a draft in, all six files of this build go in, since the files depend on each other (`latest.json` carries each package's signature) and replacing just one would not verify. A build of a higher version whose tag is there but whose release page is not public also makes the night build, unless it is of this very commit (the same commit cannot get a new version, and that build is not changed). All of this is about filling a build in: old development builds outside the latest 10 are still removed with their tags, as the regular clean-up, not a change to a public build. When a file's upload state cannot be judged (no state, a state word it does not know, a size it cannot read, two files of one name, a file listed without a name, or a file list it cannot read at all), or a release does not say whether it is a draft or a pre-release, it reads the list once more, and if it still cannot tell it changes nothing. A release or tag list it cannot read, or two commits it cannot compare, count as "changed" and it builds as usual. If last night failed in the tests or the packaging, those changes have not gone out yet, so the next night tries again; if it failed in the publish step, that build may be out, half out or not out: one still a draft that never went public is filled in the next night, one public but not complete is left as it is until the next commit's higher version, one that went out complete is not published again.
- **What it runs**: the quick tests, the Apple-silicon Mac build and its real update check, the Windows x64 build and its real update check (a test build one version lower is installed, finds the new one on the development channel, downloads and checks it, and puts it in place on restart; an installer whose bytes were changed must be refused and change nothing), and the size gate. Only when all pass is it published as a pre-release; the latest 10 are kept. The full tests are not part of it; they stay in the Sunday run.
- **A build by hand**: Actions → Client → Run workflow, on main, tick `publish`. Exactly the nightly run; with `force` ticked as well it skips the "did the client change?" step: if main moved on since the last build, a new build with the same content and a higher version comes out; on the very commit already published it builds and checks once more, and the publish step finds that version already out and writes nothing. `publish` ticked on any other branch fails at the first step: nothing built, nothing signed, no release page. A manual run without `publish` only builds and checks (with a throw-away key) on any branch, and publishes nothing.
- **One publish at a time**: the nightly runs and the manual runs with `publish` queue in one line, merges into main in another; in each a later one waits for the one before it and never cancels it, and a newer one replaces one still waiting. Both lines may build at the same time; the step that writes the release page takes one run at a time and reads the release list again first: a higher version already out, or this version already out complete, means it writes nothing. Since each line runs one at a time, at most two runs reach that step together, so the one waiting is never replaced. What can be replaced is a merge still waiting in its line, by a newer merge that carries its changes. A merge whose build fails is not reported; the next merge or the next night tries again by the same rule. A merge that changed the client but leaves it as the newest complete published build has it (a revert) runs its quick tests and builds nothing. The checks on a pull request are in neither line.

</details>

<details><summary>A red night opens an issue; checking whether a build is complete</summary>

- **A red night opens an issue** the same way a failed Release run does (the same script, the same rules: only create or comment, re-read before writing, never touch an existing issue's labels) — but its own: titled `客户端每晚开发版失败（自动报告）`, marker `<!-- cavil-client-nightly-failure -->`, labelled `pending/agent` (`RELEASE_FAILURE_LABEL`). Only the nightly run reports; a red manual run does not. The issue names the version this run tried to publish, whether it failed before publishing or in the publish step, and the result of checking that version by the rule below: complete on the Releases page now (this run put it out and a later step did not finish, or an earlier run put it out and this one never reached the publish step), not out complete (installed apps keep the previous build; one not yet public is tried again the next night, one public but incomplete waits for the next commit's higher version), or cannot tell (a person checks with the command below). It checks the version this run tried, never the newest one on the Releases page — when this run created no new release, the newest one is the previous night's.
- **Checking whether a build is complete**: a development build must carry these six files, fully uploaded — for Apple silicon `-arm64.dmg`, `-arm64.app.tar.gz` and `-arm64.app.tar.gz.sig`, for Windows `-windows-x64.exe` and `-windows-x64.exe.sig`, and `latest.json`. A file listed on the Releases page with size 0 did not finish uploading and does not count. Or run the read-only check in this repository's `client/` directory (the same rule as the publish step and the nightly decision; it writes nothing; put in the version to check):

<!-- client-nightly-check:begin -->
```bash
node scripts/dev-release.mjs --check 0.5.3-dev.640 --repo GigleAI/cavil-loop
```
<!-- client-nightly-check:end -->

  `COMPLETE` (exit 0) means done: all six files uploaded **and** this version's tag on the commit the release recorded; `INCOMPLETE` lists the files missing or not fully uploaded, or says the files are complete but the tag is on another commit or missing (exit 1); `UNKNOWN` means the release list could not be read, a file's upload state cannot be judged, the release does not say whether it is a draft, or the tag cannot be read (exit 2), not "there is none".

</details>

<details><summary>Turning the nightly report off and on</summary>

<!-- client-nightly-ops:begin -->
**Turning the nightly report off** (the builds go on, a red night just opens no issue) and **back on**:

```bash
gh variable set CLIENT_NIGHTLY_REPORT --body off --repo GigleAI/cavil-loop
gh variable delete CLIENT_NIGHTLY_REPORT --repo GigleAI/cavil-loop
```

Run only the first line to turn it off, only the second to turn it back on. Check: `gh variable list --repo GigleAI/cavil-loop` shows `CLIENT_NIGHTLY_REPORT off` while it is off, and nothing of that name once it is on again.
<!-- client-nightly-ops:end -->

</details>

## Troubleshooting

Each entry below starts from what you see (a symptom or a question) and gives the first thing to check; the commands are folded under it.

### What did the last polls do? (run log)

Every poll round writes one record when it exits (times, result, last step reached, candidates seen and
dispatched, GitHub calls made and failed); rounds that go wrong also save a snapshot. It is on by default. To read
the last rounds:

<details><summary>Commands</summary>

<!-- poll-history-ops:begin -->
```bash
KEY=myproject    # the instance name / 实例名: systemctl --user list-timers 'cavil-loop-poll@*'
ENV_FILE="$HOME/.config/cavil-loop/$KEY.conf"
[ -f "$ENV_FILE" ] || ENV_FILE="$HOME/.config/coding-agent-work-loop/$KEY.conf"   # installed before the rename / 改名前装的
CONF=$(sed -n 's/^CODING_AGENT_CONFIG=//p' "$ENV_FILE" | tr -d '"')
bash "$HOME/.agents/skills/cavil-loop/scripts/poll-history.sh" --config "$CONF" -n 20
```
<!-- poll-history-ops:end -->

</details>

<details><summary>What the command prints, and what each result means</summary>

`poll.log` only has what the code chose to log, and the poller's stderr goes to `/dev/null`; the run log is the
other half. A round that exits non-zero, cannot read GitHub, has its idle probe time out or fail, spends more
than `POLL_RUN_LOG_SLOW_SECS` in one step, or finds the previous round stuck behind the lock also saves a
**snapshot**. `poll-entry.sh` writes a "started" line before anything else, so "never got going" and "ran with
nothing to do" look different.

The command prints the last rounds as a table; rounds that have a progress file but no record; entry records (the
poll started but never got as far as loading the config, or exited before that with the exit code shown); and
the latest snapshot with the matching slice of `poll.log`. `--json` gives the same data for a machine.

| Result | Meaning |
|---|---|
| `ok` | ran to the end |
| `pace-skip` | skipped by the idle / failure backoff (the idle probe result is in its own column) |
| `lock-busy` | the previous round was still running; the note says which round holds the lock and for how long |
| `github-unreadable` | could not read GitHub, stopped without dispatching (snapshot saved) |
| `label-rename` | a flow-label rename is not finished, or the config changed after this round loaded it — the round did nothing ([Rename a flow label](#rename-a-flow-label)) |
| `label-watch` | the label check after a rename found the label's name on GitHub differs from the config, or could not read it — the round did nothing |
| `error` | exited non-zero (snapshot saved, with script name and line number) |
| `early-exit` | exited 0 before reaching the end, by a path the run log has no name for |

</details>

<details><summary>Things to know when reading it</summary>

- **A round that was killed outright** (power loss, OOM, `SIGKILL`) cannot write its record, and nothing writes
  one for it afterwards. It leaves its progress file, which the command shows as "未正常结束" (did not finish)
  with the step it stopped in, after checking the process list. When the process list cannot be trusted the
  command says "判断不了" (cannot tell) instead of guessing. Only the 64 most recent progress files are kept.
- **GitHub calls** are the ones the poll process itself made (its subshells and the idle probe included), not
  those of dispatch scripts or Python helpers. A call counts as failed when `gh` exits non-zero; the idle probe
  is the one exception — a `200` or `304` answer is a success there (the real `gh` exits 1 on `304`). `未知`
  (unknown) means the round could not set its counters up or read them back — never read it as zero; a
  trailing `+` means the count reached its cap (20000 calls in one round) and the real number is at least that.
- **If the entry script itself never ran** (a missing file, exit 127), nothing can be written here. The command
  then prints the `journalctl` line to look at instead.
- Snapshots hold checked fields only: script name, line number, function name, step name, exit code, a few
  validated config values, the pace state's numeric fields, and byte offsets into `poll.log` — no source text,
  no command output, no issue or comment text. The same reason at the same place is saved once per hour.
- Nothing in the poller reads these files; they decide nothing. A write that fails, or a full directory that
  cannot be trimmed, only means one record fewer.

</details>

<details><summary>Where the files are and how much is kept</summary>

Each directory makes room before it adds a file, so the counts hold even when rounds keep getting killed
mid-write; only rounds writing at the very same moment can exceed them briefly, by at most one file each.

| Path | What | Kept |
|---|---|---|
| `$STATE_DIR/runlog/rounds/` | one record per round | `POLL_RUN_LOG_ROUNDS` (1000) |
| `$STATE_DIR/runlog/snapshots/` | snapshots | `POLL_RUN_LOG_SNAPSHOTS` (20) |
| `$STATE_DIR/runlog/inflight/` | progress of rounds in flight | `POLL_RUN_LOG_INFLIGHT` (64) |
| `$STATE_DIR/runlog/acct/` | normally empty: a round creates its counter file here, opens it and deletes it at once | `POLL_RUN_LOG_INFLIGHT` (64) |
| `~/.local/state/cavil-loop/runlog/entry/` | entry records of polls that never loaded their config (all projects) | 200 |

</details>

<details><summary>Turn it off and remove what was recorded</summary>

Delete the `ENABLE_POLL_RUN_LOG=false` line again to turn it back on; the next poll recreates the directory.

<!-- poll-history-off-ops:begin -->
```bash
KEY=myproject    # the instance name / 实例名: systemctl --user list-timers 'cavil-loop-poll@*'
ENV_FILE="$HOME/.config/cavil-loop/$KEY.conf"
[ -f "$ENV_FILE" ] || ENV_FILE="$HOME/.config/coding-agent-work-loop/$KEY.conf"   # installed before the rename / 改名前装的
CONF=$(sed -n 's/^CODING_AGENT_CONFIG=//p' "$ENV_FILE" | tr -d '"')
STATE_DIR=$(bash -c 'source "$1" >/dev/null 2>&1; printf %s "$STATE_DIR"' _ "$CONF")
[ -n "$STATE_DIR" ] || { echo "cannot read STATE_DIR from $CONF / 读不到 STATE_DIR"; exit 1; }
echo 'ENABLE_POLL_RUN_LOG=false' >> "$CONF"
rm -rf "$STATE_DIR/runlog"
echo "run log off, records removed: $STATE_DIR/runlog / 已关闭并删除记录"
```
<!-- poll-history-off-ops:end -->

</details>

### poll.log went sparse — did the daemon die?

Probably not: a project nobody has touched for a day or more polls less often on purpose
(`POLL_BACKOFF_LADDER`), and every skipped tick still writes one line saying which tier it is on. Only a log with
no lines at all, not even skip lines, means the daemon is down — then carry on below.

<details><summary>What the log line looks like</summary>

```
[...] [myproj] 本轮跳过（已安静 3d4h，当前档位 10m0s，还差 7m12s）
```

</details>

<details><summary>Checks, and how to go back to full speed</summary>

```bash
cat ~/.local/state/cavil-loop/<key>/poll-pace.json    # which tier, since when
grep -c 'poll start' ~/.local/state/cavil-loop/<key>/poll.log   # real polls so far
rm ~/.local/state/cavil-loop/<key>/poll-pace.json     # back to full speed, right now
```

Deleting that file is always safe — it only holds pacing, never the "which comments have I seen" cursors (those
live in `state.json`). Two guarantees hold regardless of what is in it: a full poll happens at least every
`POLL_FORCE_SYNC_SECS`, and any unparseable / out-of-range state is treated as "due now" rather than "wait
longer". To turn the whole thing off, set `POLL_BACKOFF_LADDER=""`.

</details>

<details><summary>With the idle probe on</summary>

With `POLL_IDLE_PROBE` on, a skip line ends with `；轻量检查：无变化` ("idle probe: unchanged"), and a tick it
woke up logs `轻量检查：仓库有变化 → 提前跑一轮` ("repo changed → polling now") — or the reason it could not
tell (`读不到 GitHub` = could not reach GitHub, `GitHub 回了 HTTP <n>`), which also polls. Labels, comments
(including line-by-line review comments), pushes to a PR and close / merge are seen within about a tick; new
commits on the base branch and CI results are not, and wait for the next full poll (at most
`POLL_IDLE_PROBE_MAX_SECS`, default 10 min). `rm ~/.local/state/cavil-loop/<key>/poll-probe.etag` is safe too:
the next probe just polls once more.

</details>

### Timer / agent is on but daemon isn't running

Look at the scheduler's status and the poll unit's own log; the usual causes are a wrong path in the per-project
conf, missing config fields, `gh` not logged in, or `claude` not on the scheduler's `PATH`.

<details><summary>Commands to look with (Linux / macOS)</summary>

**Linux (systemd)**:

```bash
systemctl --user status cavil-loop-poll@<key>.timer
systemctl --user status cavil-loop-poll@<key>.service
journalctl --user -u cavil-loop-poll@<key>.service --since "10 min ago"
```

**macOS (launchd)**:

```bash
launchctl print "gui/$UID/dev.luosky.cavil-loop.<key>"
tail -50 ~/Library/Logs/cavil-loop/<key>.err.log
tail -50 ~/Library/Logs/cavil-loop/<key>.out.log
```

</details>

<details><summary>Common causes and fixes</summary>

Both OS:
- `~/.config/cavil-loop/<key>.conf` has a bad path → edit the conf
- `cavil-loop.config` is missing fields → check `poll.log`
- `gh auth` not logged in → `gh auth status`
- `claude` isn't in the scheduler's `PATH` → in `~/.config/cavil-loop/<key>.conf` add the `which claude` dir to `PATH=`

macOS only:
- "Bootstrap failed: 5: Input/output error" → previous load is still around. `launchctl bootout "gui/$UID/dev.luosky.cavil-loop.<key>"`, then re-run setup.
- `flock: command not found` in `<key>.err.log` → `brew install flock`.

</details>

### A project's timer vanished after a new release (`Unit to trigger vanished`)

One project's `poll.log` stops with no error, `systemctl --user list-timers` shows `-` under NEXT for it (or does
not list it), and the journal says `Unit to trigger vanished.`. Every poll round repairs this by itself; you only
step in when *every* project's timer on the machine is already dead, so no poll round runs to do it.

<details><summary>Symptom and cause</summary>

The journal has

```
cavil-loop-poll@<key>.timer: Failed to open …/cavil-loop-poll@<key>.timer: No such file or directory
cavil-loop-poll@<key>.timer: Unit to trigger vanished.
```

`systemctl --user enable` resolves the template symlink to the end, so the instance link and its
`timers.target.wants/` twin point straight into one `~/.agents/releases/cavil-loop/releases/<sha>/` instead of
the stable `~/.agents/skills/cavil-loop/`. Once the deployer cleans that release up, the timer's unit file is gone.

</details>

<details><summary>What repairs it automatically, and its limits</summary>

`scripts/repair-unit-links.sh`, run by every poll round (always the current release), by the deployer before it
cleans up old releases, by `setup.sh` right after enabling, and by the legacy migration right after enabling. It
repoints our links (new and pre-rename names) at the stable entry, writes a durable "reload pending" mark first
and clears it only after a successful `daemon-reload` (so a failed reload is retried next round even with nothing
left to relink), and only then starts timers that systemd reports as *enabled + failed with result `resources`* —
how systemd records "unit file vanished while running". A timer you stopped (`inactive`) or disabled is never
started; an unreadable state is left alone. The deployer also refuses to delete any release a unit link still
reaches.

Limits: after `systemctl --user reset-failed` the vanished state is gone and the timer is not started for you; a
restart of the user manager also forgets it (an enabled timer then starts at login anyway, once its link is fixed).

</details>

<details><summary>Repair by hand: steps 0–4</summary>

0. Check whether you are in that case:

   ```bash
   systemctl --user list-timers --all 'cavil-loop-*' 'coding-agent-*'
   U=~/.config/systemd/user
   for d in "$U" "$U"/*.wants "$U"/*.requires; do
       case "$d" in *'*'*) continue ;; esac
       [ -d "$d" ] && [ -r "$d" ] && [ -x "$d" ] || { echo "cannot read: $d"; continue; }
       for l in "$d"/*; do
           [ -L "$l" ] || continue
           case "$(basename "$l")" in cavil-loop-*|coding-agent-*) ;; *) continue ;; esac
           case "$(readlink "$l")" in */.agents/releases/cavil-loop/releases/*) echo "points into a release: $l" ;; esac
           [ -e "$l" ] || echo "broken: $l"
       done
   done
   ```

   A project with `-` under NEXT, a missing project, or any line printed by the loop means: continue. Otherwise stop here.

1. Update to a release that has `repair-unit-links.sh` (if only the pre-rename entry exists, the `if` picks `~/.agents/skills/coding-agent-work-loop`):

   ```bash
   SKILL="$HOME/.agents/skills/cavil-loop"
   if [ ! -e "$SKILL" ] && [ ! -L "$SKILL" ]; then
       SKILL="$HOME/.agents/skills/coding-agent-work-loop"
   fi
   bash "$SKILL/scripts/skill-deploy.sh" --force
   test -f "$SKILL/scripts/repair-unit-links.sh" && echo "has the fix"
   ```

   `--force` skips the 5-minute fetch throttle, not the locks: on `another instance is fetching; skip` or `a consumer or another publisher is active` wait a minute and rerun (at most 3 times). On `development mode` the entry points at a checkout the deployer does not manage — `git pull` in that checkout instead. No `has the fix` line → stop and report both commands' full output.

2. Repair (prints every relinked link, the reload and every started timer; non-zero exit → stop and report the output):

   <!-- repair-unit-links:repair -->
   ```bash
   SKILL="$HOME/.agents/skills/cavil-loop"
   if [ ! -e "$SKILL" ] && [ ! -L "$SKILL" ]; then
       SKILL="$HOME/.agents/skills/coding-agent-work-loop"
   fi
   bash "$SKILL/scripts/repair-unit-links.sh"
   ```

3. Check — success means the loop prints nothing and every timer you want running has a time under NEXT (a timer you paused on purpose may stay inactive):

   <!-- repair-unit-links:check -->
   ```bash
   U=~/.config/systemd/user
   for d in "$U" "$U"/*.wants "$U"/*.requires; do
       case "$d" in *'*'*) continue ;; esac
       [ -d "$d" ] && [ -r "$d" ] && [ -x "$d" ] || { echo "cannot read: $d"; continue; }
       for l in "$d"/*; do
           [ -L "$l" ] || continue
           case "$(basename "$l")" in cavil-loop-*|coding-agent-*) ;; *) continue ;; esac
           case "$(readlink "$l")" in */.agents/releases/cavil-loop/releases/*) echo "points into a release: $l" ;; esac
           [ -e "$l" ] || echo "broken: $l"
       done
   done
   systemctl --user list-timers --all 'cavil-loop-*' 'coding-agent-*'
   ```

   (A shell loop, not `find`: `find` does not enter `~/.config/systemd/user` when that directory is itself a symlink, and would print nothing even with broken links inside. A directory it cannot enter — a missing permission on it or on a parent — prints `cannot read: …` instead of passing silently; that is not a success either.)

4. Manual fallback for one project, only if 1–3 do not work. `KEY` is the project's name (the `<key>.conf` under `~/.config/cavil-loop/`, or `~/.config/coding-agent-work-loop/` on a pre-rename install); use `P=coding-agent` for a pre-rename unit and `KIND=weekly-report` for a weekly-report timer. Only run it for a timer you want running:

   <!-- repair-unit-links:fallback -->
   ```bash
   KEY=arktool
   P=cavil-loop
   KIND=poll
   SKILL="$HOME/.agents/skills/cavil-loop"
   if [ ! -e "$SKILL" ] && [ ! -L "$SKILL" ]; then
       SKILL="$HOME/.agents/skills/coding-agent-work-loop"
   fi
   S="$SKILL/systemd/$P-$KIND@.timer"
   U="$P-$KIND@$KEY.timer"
   if [ ! -f "$S" ]; then
       echo "template missing: $S"
   else
       (
           set -e
           cd "$HOME/.config/systemd/user"
           mkdir -p timers.target.wants
           ln -sfn "$S" "$U"
           ln -sfn "$S" "timers.target.wants/$U"
           systemctl --user daemon-reload
           systemctl --user restart "$U"
           systemctl --user list-timers --all "$U"
       )
   fi
   ```

   A time under NEXT means it is back. On any error stop and report the output plus `systemctl --user status "$U"`. If you started a timer you did not want: `systemctl --user stop "$U"` (and `systemctl --user disable "$U"` to keep it off across logins).

</details>

### Worker session stuck on permission prompt

Make sure `CLAUDE_EXTRA_FLAGS="--dangerously-skip-permissions"` is set in `cavil-loop.config`. Strongly recommended in trusted local environments.

### Worker stuck on a folder-trust dialog ("Quick safety check" / "Trust this folder?")

The daemon writes the trust record before every launch and checks the screen afterwards, so this shows up as an
item bounced to `pending/human` with a comment naming the agent and directory, plus a `poll.log` line
`卡在 <agent> 的目录信任确认框上（工作目录 …，该补的信任记录：…）`. The pane is saved in the session log.

<details><summary>What to do</summary>

1. Look in `poll.log` for lines starting with `[trust]` around that dispatch: a lock timeout, "changed by another process 3 times", or an unreadable config file explain why the record wasn't written.
2. Otherwise the agent's rule probably changed. On the daemon machine run the agent once by hand in the directory from the comment, pick "trust", exit, and relabel `pending/agent`. Then check which entry the agent itself wrote (`~/.claude.json` → `projects`, `~/.codex/config.toml` → `[projects."…"]`) and update that driver's `agent_trust_key`.

</details>

### Every project's poll.log stops at the same minute

Not one stuck worker — the whole `systemd --user` manager is gone, and with it every timer, every tmux session,
and every worker of *every* project. The usual killer is systemd-oomd; the fixes are root-side, outside this repo.

<details><summary>Confirm it</summary>

Cheap, no root:

```bash
for k in <key1> <key2> …; do
  echo "--- $k"; tail -1 ~/.local/state/cavil-loop/$k/poll.log
done
systemctl show user@$(id -u).service -p ActiveEnterTimestamp   # a recent timestamp on a
                                                              # long-uptime box = it restarted
```

All keys stopping inside the same minute means the manager was killed, not that a worker hung.

Then get the verdict from the **system** journal — `journalctl --user` never shows oomd:

```bash
sudo journalctl --since "<that minute>" | grep -iE 'oomd|user@<uid>'
```

What it looks like (a real capture):

```
systemd-oomd: Killed /user.slice/user-1003.slice/user@1003.service/init.scope
  due to memory pressure for /user.slice/user-1003.slice/user@1003.service
  being 63.73% > 50.00% for > 20s with reclaim activity
systemd[1]: user@1003.service: Main process exited, code=killed, status=9/KILL
```

</details>

<details><summary>Two things that are easy to get wrong</summary>

- **oomd picks `init.scope`** — the cgroup holding `systemd --user` itself, a few MiB.
  It ranks descendant cgroups by pgscan rate, not by size; when every candidate's delta is 0
  (the dump shows `Pgscan == Last Pgscan`) it takes the first one, which is the manager.
  So `MemoryHigh=` / `MemoryMax=` on the worker slice cannot influence who gets killed.
  Worse, `MemoryHigh=` throttling *creates* the reclaim activity the trigger condition asks
  for, which brings the kill forward.
- **Nothing brings the manager back.** `Linger=yes` only keeps a *running* manager alive
  after logout; it does not restart a failed one. The manager returns only when someone logs
  in (an SSH session makes logind start the unit as a side effect), and nothing warns in between.

</details>

<details><summary>Fixes (root-side)</summary>

```ini
# /etc/systemd/system/user@<uid>.service.d/no-oomd.conf
# overrides /usr/lib/systemd/system/user@.service.d/10-oomd-user-service-defaults.conf
# for this uid only
[Service]
ManagedOOMMemoryPressure=auto
```

```ini
# /etc/systemd/system/user-manager-watchdog.service  (+ a 2-minute .timer)
[Service]
Type=oneshot
ExecStart=/bin/sh -c 'systemctl is-active --quiet user@<uid>.service || systemctl start user@<uid>.service'
```

With oomd disarmed, the backstop is the worker slice's own `MemoryMax=`: exceeding it is a
kernel cgroup OOM that can only pick a process *inside* that slice, so the victim is always
a worker and self-heal re-dispatches it on the next poll. See the comments in
`systemd/app-cavil\x2dloop\x2dpoll.slice` for the memory arithmetic.

</details>

### Every dispatch dies within seconds, self-heal never recovers

If `tmux ls` says "no server running", a tmux server started by the poll unit is being killed when the poll
exits, taking every new worker session with it. The poll unit ships with `KillMode=process` to prevent this —
check that it is still set.

<details><summary>Command</summary>

```bash
systemctl --user show cavil-loop-poll@<instance>.service -p KillMode   # want: process
```

</details>

<details><summary>Symptom in poll.log</summary>

A loop that always ends in a false "session corrupted" verdict:

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

</details>

<details><summary>Why it happens</summary>

Normally the tmux server is long-lived and lives in *some other* cgroup (started by an
interactive login), so `tmux new-session` just attaches and leaves nothing behind in the
poll unit's cgroup. Once the server dies — typically because systemd-oomd killed the whole
`user@<uid>.service` cgroup — the next `tmux new-session` **starts the server itself**, and
it lands inside `cavil-loop-poll@<i>.service`. With `Type=oneshot`, systemd's default
`KillMode=control-group` then SIGTERMs everything left in that cgroup the moment the poll
script exits, taking the brand-new server and its worker session with it.

So self-heal can't ever succeed: it re-dispatches, the session dies again, three rounds burn
out, and the issue gets dumped to `pending/human` under a bogus "session corrupted" reason.

</details>

<details><summary>Reproduce it, and recover afterwards</summary>

Reproduce the failure (and confirm the fix) without touching the daemon:

```bash
systemd-run --user --unit=probe --service-type=oneshot \
  /usr/bin/tmux new-session -d -s probe 'sleep 300'
sleep 3 && tmux ls   # session gone → control-group; session listed → process
```

Items sent to `pending/human` by the give-up path need their original trigger label back. The daemon records it
in `state.json` under `worker_trigger_labels`, and each retry line in `poll.log` names it (`翻 doing/agent → X`).
Fix the `KillMode` first — anything you re-label before that just dies again.

</details>

### Every poll prints "上一轮还没跑完，跳过" and nothing ever runs

The `poll.lock` flock is stuck because a long-lived process (the tmux server, a worker) still holds its file
descriptor. Deleting the lock file unsticks it without killing anything:

<details><summary>Command</summary>

```bash
rm -f "$STATE_DIR/poll.lock"
```

</details>

<details><summary>Why, and how to find the holder</summary>

flock lives on the *open file description*, so the lock is held as long as **any** process still has that fd
open — and `agent-poll.sh` opens it as fd 9, which children inherit. If a long-lived process ends up in the
poll's process tree, it keeps fd 9 open for hours and the lock is never released. The daemon then goes
completely silent: no errors, no dispatches, just "skip" forever.

```bash
# any process still holding the lock
for p in /proc/[0-9]*; do
  for fd in $p/fd/*; do
    [ "$(readlink -f "$fd" 2>/dev/null)" = "$STATE_DIR/poll.lock" ] &&
      echo "$(basename "$p") $(tr -d '\0' < "$p/cmdline" | cut -c1-60)"
  done
done 2>/dev/null | sort -u
```

Short-lived `bash` / `gh` processes are the poll currently running — that's normal. A `tmux` or worker process is
the bug. `_lib.sh` closes fd 9 on source (all dispatch scripts source it before spawning anything long-lived); if
you see a worker holding it, that guard is missing.

Deleting the lock file works because flock is bound to the inode: the next poll opens a fresh one while the old
process keeps a lock on the now-unlinked inode.

</details>

### Daemon keeps re-dispatching the same PR

Likely the worker didn't flip the label. Check that the prompt template tells the worker to flip. Or manually:
<details><summary>Command</summary>

```bash
gh pr edit N --add-label pending/human --remove-label pending/agent
```

</details>

<details><summary>Another cause: the worker left no comment</summary>

If the worker finishes without leaving any comment, state.json's comment ID doesn't advance and the same comment gets treated as new next time. Prompts should require the worker to leave at least one reply.

</details>

### An item stays on `doing/agent`, the session is alive, nobody is working

The worker stopped without commenting or flipping the label while its tmux session is still alive, so the item
keeps its concurrency slot. With `STUCK_WORKER_QUIET_SECS` set the daemon handles it (off by default; turn it off
again with `STUCK_WORKER_QUIET_SECS=""`); its `poll.log` lines all start with "卡住检测：".

<details><summary>What the daemon does, step by step</summary>

Typical causes: the worker decided "not mine" and quit, got an empty prompt, or crashed before the flip.
Self-heal only acts when the session is gone and the reaper skips anything labeled `doing/agent`.

| When | What the daemon does |
|---|---|
| agent idle, nothing new on GitHub or the local branch, for `STUCK_WORKER_QUIET_SECS` in a row | pastes a fixed reminder into the worker pane (no GitHub write) |
| still nothing `STUCK_WORKER_STEP_GAP_SECS` after the reminder | swaps `doing/agent` for the label that triggered the dispatch, ends the session once the swap is confirmed, redispatches next round; at most `STUCK_WORKER_MAX_RESTARTS` times |
| stuck again for `STUCK_WORKER_QUIET_SECS` after the redispatch | posts a comment (how long, what was tried, how to continue), flips to `pending/human`; the session is kept |

"Idle" is read off the screen: an agent that pushed work to the background and waits looks idle too. Hence the
30-minute default and the harmless first step. Progress lives in `stuck_workers` in `state.json`, so a daemon
restart continues where it was; it is cleared once the item is handed on normally (leaves `doing/agent`).

</details>

<details><summary>How each check is made</summary>

Every check is a script comparison, never a model call:

- **Busy or not** is read off the recorded worker pane, with the rules of the agent that session
  actually runs (the review agent and the development agent show "busy" differently). Compacting
  counts as busy; sitting on a dialog counts as idle.
- **Activity**: labels, comments and commits on the item and on the item bound to it (the issue
  behind a PR, the PRs of an issue), plus the local work branch's head. Any change, or one round
  that sees the agent busy, resets the clock.
- **Protecting labels**: nothing happens while the item itself also carries `pending/human`, the
  blocked label, the requester-bot waiting label, any dispatch label, `pending/merge` or
  `pending/PR`, or while the bound item carries `pending/human`, the blocked label or the
  requester-bot waiting label. `pending/PR` on the issue behind a PR is the normal state after
  the PR was opened and does not protect.
- **Everything is re-read before each action**: before the comment, before each label write
  and before ending the session, the item, the bound item and the local session are read again and must be exactly
  what they were when the clock started (open / merged, base branch, head commit, source, labels,
  latest comment and label event, worker pane and agent); otherwise nothing is done this round
  and the clock restarts.
- **Unreadable means hands off**: if tmux or GitHub cannot be read, the round neither advances
  nor resets.
- **Any anomaly half-way stops the item**: the restart / hand-over step is several GitHub writes
  (restart: add the trigger label → remove `doing/agent` → end the session; hand-over: comment →
  add `pending/human` → remove `doing/agent`), all done within one round. After the first write,
  a write that cannot be confirmed on the spot, a change found between two writes, or state that
  cannot be read makes the daemon stop on that item right there: nothing is rolled back, nothing
  is retried, nothing is continued next round. A failed check before the first write only
  restarts the clock.

</details>

<details><summary>Never handled</summary>

Each reason is logged once:

- not dispatched by this machine (`worker_hosts` in `state.json` names another host)
- the session has no recorded agent / role, or has several panes and no recorded worker pane
- an issue and a PR of the same work number both carry `doing/agent` (one shared session; no way
  to tell which one it is working for)
- the session is gone (that is self-heal's job)

</details>

#### After the daemon has stopped on an item

The log has a line `🧊 卡住检测：… 停住，交给人处理` and the item has a comment "⚠️ daemon 已对这一条停手，等人处理".
To resume, remove every flow label on the item and add the one dispatch label to use; if that is not possible,
release it on the machine with `stuck-release.sh`.

<details><summary>What is held back while stopped</summary>

The comment says what happened, the labels now, whether the session is still open, and how to resume. While
stopped, the daemon does not dispatch, relabel, end the session of or merge that item (nor the bound issue / PR it
checked at that moment):

| Pass | While stopped |
|---|---|
| Dispatch (every dispatch label, review, the greedy pass, autopilot-only auto start) | not dispatched; the one exception is the label under "Resume on GitHub" below |
| Self-heal when the session is gone, reaping finished sessions | skipped, labels and session left as they are |
| Autopilot: takeover, copying the label, merge | skipped |
| Waiting-on-prerequisite check | skipped, not flipped back even when the prerequisite is done |
| Relabeling the bound issue after a PR was closed unmerged; `Done` / hand-over and worktree cleanup after a merge; the parent roll-up when all sub-issues are closed | held back and not recorded as done; done in the round after resuming |
| Conflict check on `pending/human` PRs | skipped |

Closing the item does not resume it: the record stays and the item is still stopped when
reopened (a merged PR cannot be reopened; its record is dropped).

</details>

<details><summary>Resume on GitHub (the normal way)</summary>

1. In the item's Labels, remove every flow label (`doing/agent`, `pending/review`,
   `pending/agent` and the like); removing labels triggers nothing.
2. Add the one dispatch label to use (e.g. `pending/agent`); if it is the one just removed, add
   it again after removing it.
3. Next round the daemon dispatches as usual, swaps that label for `doing/agent` and drops the
   record.

What the daemon accepts: the last flow-label change **after the comment was posted** is a human
adding a dispatch label, that label is the only flow label on the item now, and the bound issue
/ PR carries no `pending/human` / waiting-on-prerequisite / waiting-for-requester-bot label. The
dispatch script reads all of this again right before it flips a label or starts a session and
only goes on when it still holds. Adding a classification label, adding `pending/human` or
removing labels does not resume; a label added before the comment (or within seconds of it) does
not count — if nothing starts within two rounds, remove it and add it again.
Where people and the daemon share one GitHub account the daemon cannot tell who added the label, so this
way does not work; use the release on the machine below.

One resume instruction is used once: after dispatching on it, the daemon counts it a success only
when it can confirm the labels were swapped by this dispatch and the session was started / fed by
this dispatch; otherwise (the dispatch script failed, the labels were not swapped, the result
cannot be read) it stops again and posts a new comment — saying whether the task already reached
the session — and the same label event never dispatches a second time; add the label again to go
on. These dispatches do not go through the ordinary "N failures in a row → `pending/human`".

</details>

<details><summary>Release on the machine</summary>

Use this when the comment never gets posted, or `poll.log` never shows "开始认人的恢复指令". On the machine
running the daemon, run

<!-- stuck-release-ops:begin -->
```bash
KEY=myproject      # the project's instance name (~/.config/cavil-loop/<KEY>.conf)
N=123              # the issue / PR the daemon stopped on
bash ~/.agents/skills/cavil-loop/scripts/stuck-release.sh "$KEY" "$N"
```
<!-- stuck-release-ops:end -->

It holds the project's poll lock (polling pauses meanwhile), reads the item's whole identity
(open / merged, base branch, head commit, source repo, labels, latest flow-label event, the
bound item's labels), prints it and asks for `yes` (waits at most 5 minutes), then reads again
and deletes the record only when both reads are identical. It changes the local record only and
writes nothing to GitHub. Afterwards the item is back in the ordinary flow — a dispatch label on
it will be dispatched — so tidy the labels on the page first.

| Exit code | Meaning (nothing was changed unless 0) |
|---|---|
| 0 | released |
| 1 | bad usage / no such project / no record for this item |
| 2 | the poll lock was not free within 2 minutes; run it again later |
| 3 | after `yes` the second read failed or the item differs (labels, commit, base branch, …); run it again to release |
| 4 | GitHub (or the local state file) could not be read; run it again when it can |
| 5 | `yes` was not entered |

</details>

### Dispatch fails every round for the same item

A failed dispatch changes nothing, so the next poll picks the same item up again — up to
`DISPATCH_MAX_RETRIES` (default 3) times in a row, after which the daemon strips the trigger labels and hands the
item to `pending/human`. The reason is in `poll.log`:

<details><summary>Command</summary>

```bash
grep -E '派工失败|连续 .* 次派工失败' "$STATE_DIR/poll.log" | tail
```

</details>

<details><summary>Reading the reason</summary>

The label is not flipped and the comment cursors do not advance on a failed dispatch. The failure reason is
written into `poll.log` itself — you should not need `journalctl`. If a line looks truncated or empty, that is a
bug: every `git` call on a dispatch path is supposed to go through the `run_git` helper, which logs the command's
full output on failure.

</details>

<details><summary>The branch is already checked out by another worktree</summary>

`git` refuses this unconditionally: `git fetch` into such a branch always fails, even when there is nothing to
update, and `git worktree add --force` would happily create a *second* worktree on that same branch — two workers
committing to one branch. Dispatch therefore refuses up front and sends the item straight to `pending/human`. The
comment names the holder by its real directory, says what state it is in (uncommitted changes, commits ahead of /
behind the PR, any merge / rebase in progress), and gives the command that fits the holder:

```bash
# the holder is the main checkout (you created the branch there and pushed it):
git -C '<main checkout>' switch main    # free the branch, then re-label pending/agent
# the holder is a linked worktree:
git worktree remove '<holder-dir>'      # free the branch, then re-label pending/agent
```

The main checkout cannot be `git worktree remove`d (`fatal: ... is a main working tree`). When the project is a
git submodule, `git worktree list` reports the main checkout as its gitdir (`.../.git/modules/<name>`); the daemon
resolves that to the real working directory before showing it. With `AUTO_RELEASE_MAIN_CHECKOUT=1` the daemon does
the `switch` itself when it is provably safe (see the config template for the exact conditions) and comments on
the PR that it did.

</details>

<details><summary>The failure counters</summary>

The counters live in `$STATE_DIR/dispatch-fail/` and are cleared on the first success and again when an item is
escalated, so re-labelling by hand always gives it a fresh set of attempts. To clear one by hand:
`rm -f "$STATE_DIR/dispatch-fail/pr-959"`.

</details>

### Debug a single poll

Run one poll round by hand, right now, with this project's config, and read what it logged — useful after changing the config or a hook, or when the timer's own runs show nothing useful. It does real work (it can dispatch), like any scheduled round.

<details><summary>Commands</summary>

```bash
CODING_AGENT_CONFIG=~/myproject/cavil-loop.config \
    bash ~/.agents/skills/cavil-loop/scripts/poll-entry.sh
tail -50 ~/.local/state/cavil-loop/myproject/poll.log
```

</details>

### Browse live worker sessions

Press `Ctrl+b`, then `s`. The workflow keeps tmux's normal `choose-tree` layout and appends the GitHub issue
title to each worker session row:

<details><summary>Example output</summary>

```text
myproject-issue42: 1 windows | Optimize homepage load performance
```

</details>

<details><summary>Where the title comes from</summary>

The title is stored as the session-scoped tmux option `@desc`. It is refreshed whenever an issue/PR worker session
is created or reused. Non-worker sessions without `@desc` keep the normal tmux display.

</details>

### Review history of an exited session

Once a tmux session exits, the pane's scrollback is gone, so each worker session's output is mirrored to disk with
`tmux pipe-pane`:

<details><summary>Commands</summary>

```bash
# Path (default; tunable via SESSION_LOG_DIR in cavil-loop.config)
$STATE_DIR/sessions/<TMUX_PREFIX>-issue<N>.log

# Shortcut
bash ~/.agents/skills/cavil-loop/scripts/session-log.sh 42        # print path
bash ~/.agents/skills/cavil-loop/scripts/session-log.sh 42 -c     # cat
bash ~/.agents/skills/cavil-loop/scripts/session-log.sh 42 -f     # tail -F
```

</details>

<details><summary>File format, and resuming the conversation itself</summary>

Append-only; re-spawning the session for the same issue extends the same file. Each spawn writes a `===== <iso-date> session=... opened =====` separator line.

If you want Claude itself to resume the conversation (not just inspect history), or the worktree has been auto-cleanup'd and you want the session back, see [persistence.md → Resume from a break point](persistence.md#sops-resume-from-a-break-point) — it lists four paths (`--resume <id>` / `--from-pr <P>` / rebuild cwd / read jsonl directly).

</details>

### Emergency stop all workers

Stop the project's scheduler, then kill its worker sessions.

<details><summary>Commands (Linux / macOS)</summary>

**Linux**:

```bash
systemctl --user stop cavil-loop-poll@<key>.timer
tmux ls | grep "^<project>-issue[0-9]" | cut -d: -f1 | xargs -r -n1 tmux kill-session -t
```

**macOS**:

```bash
launchctl bootout "gui/$UID/dev.luosky.cavil-loop.<key>"
tmux ls | grep "^<project>-issue[0-9]" | cut -d: -f1 | xargs -n1 tmux kill-session -t
```

</details>

### Uninstall one project

`bash ~/.agents/skills/cavil-loop/scripts/disconnect-project.sh <key>` does the required steps below for either OS (and for installations from before the rename), refusing to delete anything when the scheduler state cannot be read — see [Scripted install, status and disconnect](#scripted-install-status-and-disconnect).

<details><summary>By hand (Linux / macOS)</summary>

**Linux**:

```bash
KEY=<key>
systemctl --user disable --now cavil-loop-poll@$KEY.timer
rm ~/.config/cavil-loop/$KEY.conf
# optional: rm <host>/cavil-loop.config (or keep it for re-deploy later)
# optional: rm -r ~/.local/state/cavil-loop/<project>
```

**macOS**:

```bash
KEY=<key>
launchctl bootout "gui/$UID/dev.luosky.cavil-loop.$KEY"
rm ~/Library/LaunchAgents/dev.luosky.cavil-loop.$KEY.plist
rm ~/.config/cavil-loop/$KEY.conf
# optional: rm <host>/cavil-loop.config
# optional: rm -r ~/.local/state/cavil-loop/<project>
# optional: rm ~/Library/Logs/cavil-loop/$KEY.*.log
```

</details>
