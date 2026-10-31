# Multi-actor collaboration: humans + agents

> **English** · [中文](collaboration.zh.md)

The base five-state label system handles "one user + one AI worker." For teams with **multiple humans and/or multiple specialized AI agents**, extend the labels by encoding the actor as a suffix:

```
<state>/<role>/<name>
```

Examples:

| Label | Meaning |
|-------|---------|
| `pending/human/Alex` | Needs Alex specifically (not just "any human") |
| `pending/human/Sam`  | Needs Sam specifically |
| `pending/agent/PM`   | Needs the PM-role agent |
| `pending/agent/QA`   | Needs the QA-role agent |
| `pending/agent/Frontend` | Needs the frontend-stack coding agent |

## Why use it

Plain `pending/human` works for solo projects. A name suffix disambiguates and enables **handoff chains** instead of a single back-and-forth:

```
issue → PM-agent (drafts spec)
     → human/Alex (approves spec)
     → dev-agent (implements)
     → QA-agent (tests in deployed env)
     → human/Sam (final review + merge)
```

Each step's label is the routing instruction.

## How to set it up today

Each AI role runs as its own daemon instance, configured to listen for its specific sub-label. The skill already supports this — you just pick different label values per config.

### One config per agent role

`/path/to/pm-agent.config`:
```bash
TMUX_PREFIX="pm"
SESSION_NAME_PREFIX="pm-issue"

LABEL_PENDING_AGENT="pending/agent/PM"
LABEL_AGENT_DOING="doing/agent/PM"
LABEL_PENDING_HUMAN="pending/human"     # or pending/human/<owner> if you want
LABEL_PENDING_PR="pending/PR"
LABEL_DONE="Done"

# PM role: design docs, no code
WORKTREE_SETUP_CMD=":"
CLAUDE_EXTRA_FLAGS="--dangerously-skip-permissions"
```

`/path/to/qa-agent.config`:
```bash
TMUX_PREFIX="qa"
SESSION_NAME_PREFIX="qa-issue"

LABEL_PENDING_AGENT="pending/agent/QA"
LABEL_AGENT_DOING="doing/agent/QA"
LABEL_PENDING_HUMAN="pending/human"
LABEL_PENDING_PR="pending/PR"
LABEL_DONE="Done"

# QA role: run tests, hit deployed URL, no code edits
WORKTREE_SETUP_CMD="npm ci"
CLAUDE_EXTRA_FLAGS="--dangerously-skip-permissions"
```

### Project-specific prompt per role

Each role wants a different worker prompt. Drop role-specific overrides at `<host>/.agents/skills/cavil-loop/prompts/` and switch by config — or split prompts/ per role and point each instance at its own override. (The lookup is hard-coded today; if you need per-role prompt selection, see "Roadmap" below.)

### One systemd timer per role

```bash
bash setup.sh ~/myproject pm-agent
bash setup.sh ~/myproject qa-agent
bash setup.sh ~/myproject dev-agent

systemctl --user enable --now cavil-loop-poll@pm-agent.timer
systemctl --user enable --now cavil-loop-poll@qa-agent.timer
systemctl --user enable --now cavil-loop-poll@dev-agent.timer
```

Each timer ticks independently; each daemon scans only its sub-label.

## Common workflows

### 1. PM → dev → QA handoff (full SDLC chain)

```
You open issue, label: pending/agent/PM
   ↓
PM-agent writes design proposal as issue comment, label: pending/human
   ↓
You approve, label: pending/agent/Dev
   ↓
Dev-agent codes, opens PR, label on PR: pending/agent/QA
   ↓
QA-agent runs tests + deployed-env smoke check, posts results
   ↓ (pass)
QA flips PR label to pending/human (or pending/human/<reviewer>)
   ↓
You merge
   ↓
Daemon auto-cleanup → Done
```

Failure path: QA finds a regression → flips back to `pending/agent/Dev` with a comment. Dev-agent rereads, fixes, re-hands to QA.

### 2. Multi-human review routing

Dev-agent opens a PR. Instead of a generic `pending/human`, it picks a reviewer (CODEOWNERS-driven, round-robin, or random) and applies `pending/human/Alex`. Alex sees their name on it → knows it's their queue.

Alex review:
- LGTM → `Done` (or just merge)
- Changes needed → `pending/agent/Dev` with comment
- Wants Sam's eyes → `pending/human/Sam`

### 3. Specialized coding agents by stack

Repo is monorepo with `frontend/` (React) + `backend/` (Go). Two cavil-loop instances:

| Role | Label | Worktree setup | Prompt focus |
|------|-------|----------------|--------------|
| `pending/agent/Frontend` | npm-driven | `(cd frontend && npm ci)` | Component patterns, TS strictness, e2e |
| `pending/agent/Backend`  | Go-driven  | `(cd backend && go mod download)` | API contracts, migrations, test coverage |

Routing rule for triage: the issue's file path / labels (`area/frontend`, `area/backend`) → triggers the corresponding sub-label.

## External relay bot

Some projects let another AI assistant file requests on behalf of other people. That assistant has its own GitHub account; below it is called the "relay bot". It opens issues and cavil-loop handles them as usual. When the agent needs the requester to answer a question or confirm a result, it does not hand off to the maintainer (`pending/human`). It wakes the relay bot instead, which forwards the comment to the requester and pastes the answer back verbatim.

**Off by default.** Everything is switched on through config, and neither the code nor the config template names any particular bot (GitHub#95).

### One round trip

```
bot opens an issue (body carries the marker, bot adds pending/agent itself)
   │
   ▼
agent posts a proposal / question / report ── comment ── runs the wake-up script
   │                                           │ adds the waiting label, removes pending/agent etc.,
   │                                           │ re-assigns the bot (that is what notifies it)
   ▼                                           ▼
waiting: daemon does not dispatch     bot reads the thread → forwards it → comments "forwarded to X"
   │                                           │
   │                                           ▼
   │                         gets the answer → pastes it verbatim → removes the waiting label →
   │                         unassigns itself → adds pending/agent so the agent continues
   ▼
agent reads the answer and carries on
```

### Config

| Setting | Meaning |
|---|---|
| `LABEL_PENDING_RELAY` | The waiting label, e.g. `pending/relay`. `setup.sh` creates it |
| `RELAY_BOT_ACCOUNT` | The relay bot's GitHub login; it is assigned on wake-up |
| `RELAY_ALLOWED_ACTORS` | Accounts allowed to run the wake-up (comma-separated) — normally the account workers / reviewers comment with |
| `RELAY_ORIGIN_MARKER` | An issue counts as "filed by the bot for someone" only when its body contains this text **and** its author is the bot account; a PR is judged by its linked issue |
| `RELAY_REPORT_FIRST` | `true`: report through the bot first, hand to the maintainer for merge once the requester approves the current commit; `false` (default): hand straight to the maintainer |

The feature is on only when the first four are all set. With everything empty, dispatching, the greedy skip list and all four prompt kinds are byte-for-byte what they were.

### What the daemon does while waiting

| Item state | Daemon |
|---|---|
| waiting label only | not dispatched: the greedy pass skips it, and self-heal does not flip its labels back after a worker dies |
| waiting label + someone added a trigger label (`pending/agent`, fable, extra, `pending/review`) | dispatched through that label's normal flow; the daemon removes the waiting label when it dispatches. Only people allowed to edit labels can add a trigger label, so this is an explicit "carry on" |
| waiting label removed, no trigger label | label mode: nothing happens until someone adds `pending/agent`; greedy mode: picked up as usual |

There is no waiting timeout: if the bot never answers, the maintainer deals with it.

### The wake-up script

Workers / reviewers run it after posting their comment. The dispatch prompt already contains the full command, shaped like:

```bash
bash ~/.agents/releases/cavil-loop/entrypoints/notify-relay.sh --config <project config> <issue or PR number>
```

Pre-checks first — if any fails it refuses without sending a single write:

- the current GitHub account is in `RELAY_ALLOWED_ACTORS`
- the item was filed by the bot for someone (author + marker, see above)
- the item does not carry `pending/human` (including the review-cap `pending/review` + `pending/human` pair)
- no maintainer ever added `pending/human` by hand. "Maintainer" = an account that is neither in the allowed list nor the bot. Once a maintainer has taken over, every later handoff goes to the maintainer

Then: add the waiting label → remove every trigger label, `doing/agent`, `pending/review` → if the bot is already an assignee, remove it first → assign it → read back and verify. On failure it retries the whole thing once; if that fails too it hands back to the maintainer: add `pending/human` → remove the trigger labels etc. → read back → remove the waiting label **last**. Removing it last means that if the handback stops halfway, the greedy pass and self-heal are still held off by it.

| Exit | Meaning | Agent should |
|---|---|---|
| 0 | woken (labels and assignee are set — not proof the bot relayed anything) | stop and wait |
| 2 | refused by a pre-check, labels untouched | hand to the maintainer as usual |
| 3 | wake-up failed, handed back to the maintainer (only `pending/human` left) | post a short note |
| 4 | the handback failed too; output shows the labels actually read back | say so plainly, never claim it was handed over |

### Handoff rules (appended to the dispatch prompt)

With the feature on, the daemon appends an "external relay handoff rules" section at the **very end** of all four dispatch prompts (new issue, issue comment, PR comment, review). It goes at the end so projects that replace the whole built-in template still get it. Key points:

- **Go through the bot**: proposals / revised proposals the requester has to confirm (with cross-review on, the reviewer wakes the bot when the proposal passes review); product questions for the requester during implementation; result reports (when `RELAY_REPORT_FIRST=true`)
- **Still maintainer only**: maintainer already took over, suspicious content, red tests needing a call, unresolvable conflicts, review cap reached, permissions / local config / credentials / database grants
- **Evidence rules**: "requester notified" counts only on the bot's "forwarded to X" comment after the report; "approved" counts only when the bot's verbatim answer clearly approves **and** the approved report names the PR's current head commit. Approved → hand to the maintainer for merge; changes requested → fix, re-review, report again; ambiguous → ask again
- Attachments the bot pastes into the issue (images etc.) are downloaded with the agent's own token

Not included: the agent *sending* attachments to the bot (GitHub has no programmatic comment-attachment upload); a separate issue later.

### Example: grokbot

Using the GitHub account [`grokbot`](https://github.com/grokbot) so it can file requests into the project on its own.

**1. Give grokbot a role that can edit labels.** Work starts on the `pending/agent` label, which only people with the right repo permission can add — that is what stops strangers from putting the agent to work, and this feature does not change it. The lowest GitHub repo role that can edit labels is **Triage**: it manages labels and assignees and cannot change code.

- Repo → Settings → Collaborators and teams → Add people → `grokbot` → role **Triage** → send the invite; grokbot accepts it
- To pause grokbot, remove it on the same page

**2. Config** (`cavil-loop.config`; use your own worker account):

```bash
LABEL_PENDING_RELAY="pending/relay"
RELAY_BOT_ACCOUNT="grokbot"
RELAY_ALLOWED_ACTORS="your-worker-bot"          # the account workers / reviewers comment with
RELAY_ORIGIN_MARKER="<!-- relayed-by-grokbot -->"
RELAY_REPORT_FIRST="true"                       # report through grokbot first, maintainer merges after approval
```

**3. Create the label**: repo → Issues → Labels → New label, name `pending/relay`. (A project set up with `setup.sh` gets it automatically when the setting is present.)

**4. Agree on grokbot's side of the protocol:**

1. When opening an issue, end the body with the marker `<!-- relayed-by-grokbot -->` and add `pending/agent`
2. When assigned: read the thread, forward the latest comment to the requester, and comment on the issue saying whom it went to
3. On an answer: paste it back **verbatim** → remove `pending/relay` → unassign itself → add `pending/agent` so the agent continues (with `DISPATCH_MODE=greedy` this last step is optional — removing the waiting label is enough)
4. Ignore items carrying `pending/human`: those are for the maintainer

**5. Check it works**: once grokbot files a request and the agent posts a proposal, the issue should show `pending/relay` with grokbot as assignee, and `poll.log` should contain `notify-relay #<number>: ✅ 已叫醒 grokbot`. If you see `pending/human` plus a "wake-up failed, handed to the maintainer" comment instead, read the script output quoted there (common cause: grokbot has not accepted the invite yet, so it cannot be assigned).

**Rollback**: clear those five settings; remove `pending/relay` by hand from any item still carrying it.

## Practical considerations

- **Naming convention**: keep `<state>` consistent (`pending`, `agent`, `Done`); role goes after the third `/`. Avoid mixing styles like `pending/PM` vs `pending/agent/PM` in the same repo
- **Concurrency**: each instance has its own state.json + worktree base (set `WORKTREE_BASE` differently per role to prevent collisions), so they don't trip over each other
- **Worker prompts per role**: easiest is one host project per role's worktree base + per-role `.agents/skills/cavil-loop/prompts/` overrides. Alternatively, a future enhancement could let one host project switch prompt sets by role suffix
- **Handoff in prompts**: each role's prompt should explicitly list "label to apply when done." E.g., PM-agent's prompt ends with "apply `pending/human` for spec approval, **not** any other label"
- **State pollution**: if Alex's `pending/human/Alex` work also fits Sam's queue later, just change the label — no state to migrate
- **GitHub assignees as alternative**: you could mirror reviewer routing onto GitHub's native "Assignees" field instead of label suffixes. Labels are simpler to filter; assignees are first-class but lack the per-state breakdown

## Race conditions to avoid

- **Overlapping label patterns**: if instance A listens to `pending/agent/Frontend` and instance B mistakenly listens to `pending/agent/*`, both will dispatch. Keep instance labels disjoint
- **Concurrent label flips**: if two daemons try to flip the same issue near-simultaneously, GitHub's last-write-wins. Probably rare in practice (each daemon dispatches on its own sub-label, so they never target the same issue at the same time)

## Roadmap (not yet implemented)

These are extensions worth exploring; open an issue to track:

- **Single daemon with prefix matching**: scan `pending/agent/*` and route by suffix to per-role prompt + per-role config. Replaces N daemon instances with 1 instance for many roles. Simpler ops, harder per-role isolation.
- **Built-in reviewer rotation**: pick `pending/human/<name>` from a configured pool (round-robin / by file ownership) when worker finishes
- **Cross-agent handoff via prompt directives**: standardize the "next label" instruction across prompt templates, with a small env field like `NEXT_HANDOFF_LABEL`
- **Status pages**: aggregated dashboard of `<role> in flight / queued / done today` across all daemon instances
