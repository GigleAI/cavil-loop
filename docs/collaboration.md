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

Plain `pending/human` works for solo projects. A name suffix disambiguates and enables **handoff chains** instead of a single back-and-forth; each step's label is the routing instruction.

<details><summary>Example: a handoff chain</summary>

```
issue → PM-agent (drafts spec)
     → human/Alex (approves spec)
     → dev-agent (implements)
     → QA-agent (tests in deployed env)
     → human/Sam (final review + merge)
```

</details>

## How to set it up today

Each AI role runs as its own daemon instance, configured to listen for its specific sub-label. The skill already supports this — you just pick different label values per config.

### One config per agent role

Each role gets its own config file with its own label values, prefixes and setup command.

<details><summary>Example: PM and QA configs</summary>

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

</details>

### Project-specific prompt per role

Each role wants a different worker prompt. Drop role-specific overrides at `<host>/.agents/skills/cavil-loop/prompts/` and switch by config — or split prompts/ per role and point each instance at its own override. The lookup is fixed to one prompt set per host project; per-role prompt selection is listed under [Roadmap](#roadmap-not-yet-implemented).

### One systemd timer per role

Install each role with `setup.sh` and enable its timer; each timer ticks independently and each daemon scans only its sub-label.

<details><summary>Commands</summary>

```bash
bash setup.sh ~/myproject pm-agent
bash setup.sh ~/myproject qa-agent
bash setup.sh ~/myproject dev-agent

systemctl --user enable --now cavil-loop-poll@pm-agent.timer
systemctl --user enable --now cavil-loop-poll@qa-agent.timer
systemctl --user enable --now cavil-loop-poll@dev-agent.timer
```

</details>

## Common workflows

Three typical ways to combine roles and names follow.

### 1. PM → dev → QA handoff (full SDLC chain)

The PM agent drafts, a human approves, the dev agent codes and opens a PR, the QA agent tests it and hands it to a human for the merge. A regression found by QA goes back to `pending/agent/Dev` with a comment.

<details><summary>The chain step by step</summary>

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

</details>

### 2. Multi-human review routing

Dev-agent opens a PR. Instead of a generic `pending/human`, it picks a reviewer (CODEOWNERS-driven, round-robin, or random) and applies `pending/human/Alex`. Alex sees their name on it → knows it's their queue.

<details><summary>What the reviewer does next</summary>

Alex review:
- LGTM → `Done` (or just merge)
- Changes needed → `pending/agent/Dev` with comment
- Wants Sam's eyes → `pending/human/Sam`

</details>

### 3. Specialized coding agents by stack

In a monorepo with `frontend/` (React) and `backend/` (Go), run two cavil-loop instances, one per stack. Triage routes an issue by its file paths / area labels (`area/frontend`, `area/backend`) to the matching sub-label.

<details><summary>Example: the two instances</summary>

| Role | Label | Worktree setup | Prompt focus |
|------|-------|----------------|--------------|
| `pending/agent/Frontend` | npm-driven | `(cd frontend && npm ci)` | Component patterns, TS strictness, e2e |
| `pending/agent/Backend`  | Go-driven  | `(cd backend && go mod download)` | API contracts, migrations, test coverage |

</details>

## External requester bot

Another AI assistant can file requests directly and get called back when an item needs its answer or is finished; off by default. Setup and the bot-side protocol: [Hooking up an external requester bot](requester-bot.md).

## Autopilot: one issue end to end

With `LABEL_AUTOPILOT` on (on by default, needs the review gate), a maintainer can hand a single issue — or an existing PR — over completely: design and code go through review only, and the daemon merges the PR itself under fixed checks. It is a *mode* label, so it coexists with the routing above; details and the merge conditions: [operations](operations.md#autopilot-label-autopilot).

## Practical considerations

Keep label names consistent, give each instance its own state and worktree base, and make each role's prompt name the label to hand on with.

<details><summary>Details</summary>

- **Naming convention**: keep `<state>` consistent (`pending`, `agent`, `Done`); role goes after the third `/`. Avoid mixing styles like `pending/PM` vs `pending/agent/PM` in the same repo
- **Concurrency**: each instance has its own state.json + worktree base (set `WORKTREE_BASE` differently per role to prevent collisions), so they don't trip over each other
- **Worker prompts per role**: easiest is one host project per role's worktree base + per-role `.agents/skills/cavil-loop/prompts/` overrides
- **Handoff in prompts**: each role's prompt should explicitly list "label to apply when done." E.g., PM-agent's prompt ends with "apply `pending/human` for spec approval, **not** any other label"
- **State pollution**: if Alex's `pending/human/Alex` work also fits Sam's queue later, just change the label — no state to migrate
- **GitHub assignees as alternative**: you could mirror reviewer routing onto GitHub's native "Assignees" field instead of label suffixes. Labels are simpler to filter; assignees are first-class but lack the per-state breakdown

</details>

## Race conditions to avoid

Keep the labels the instances listen to disjoint: two instances whose labels overlap both dispatch the same item.

<details><summary>Details</summary>

- **Overlapping label patterns**: if instance A listens to `pending/agent/Frontend` and instance B mistakenly listens to `pending/agent/*`, both will dispatch. Keep instance labels disjoint
- **Concurrent label flips**: if two daemons try to flip the same issue near-simultaneously, GitHub's last-write-wins. Probably rare in practice (each daemon dispatches on its own sub-label, so they never target the same issue at the same time)

</details>

## Roadmap (not yet implemented)

None of these exist today: one daemon routing many roles by suffix, built-in reviewer rotation, a standard "next label" instruction, and a status page across instances. Open an issue to track one.

<details><summary>What each would do</summary>

- **Single daemon with prefix matching**: scan `pending/agent/*` and route by suffix to per-role prompt + per-role config. Replaces N daemon instances with 1 instance for many roles. Simpler ops, harder per-role isolation.
- **Built-in reviewer rotation**: pick `pending/human/<name>` from a configured pool (round-robin / by file ownership) when worker finishes
- **Cross-agent handoff via prompt directives**: standardize the "next label" instruction across prompt templates, with a small env field like `NEXT_HANDOFF_LABEL`
- **Status pages**: aggregated dashboard of `<role> in flight / queued / done today` across all daemon instances

</details>
