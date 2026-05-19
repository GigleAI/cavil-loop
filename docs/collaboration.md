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

Each role wants a different worker prompt. Drop role-specific overrides at `<host>/.agents/skills/coding-agent-work-loop/prompts/` and switch by config — or split prompts/ per role and point each instance at its own override. (The lookup is hard-coded today; if you need per-role prompt selection, see "Roadmap" below.)

### One systemd timer per role

```bash
bash setup.sh ~/myproject pm-agent
bash setup.sh ~/myproject qa-agent
bash setup.sh ~/myproject dev-agent

systemctl --user enable --now coding-agent-poll@pm-agent.timer
systemctl --user enable --now coding-agent-poll@qa-agent.timer
systemctl --user enable --now coding-agent-poll@dev-agent.timer
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

Repo is monorepo with `frontend/` (React) + `backend/` (Go). Two coding-agent instances:

| Role | Label | Worktree setup | Prompt focus |
|------|-------|----------------|--------------|
| `pending/agent/Frontend` | npm-driven | `(cd frontend && npm ci)` | Component patterns, TS strictness, e2e |
| `pending/agent/Backend`  | Go-driven  | `(cd backend && go mod download)` | API contracts, migrations, test coverage |

Routing rule for triage: the issue's file path / labels (`area/frontend`, `area/backend`) → triggers the corresponding sub-label.

## Practical considerations

- **Naming convention**: keep `<state>` consistent (`pending`, `agent`, `Done`); role goes after the third `/`. Avoid mixing styles like `pending/PM` vs `pending/agent/PM` in the same repo
- **Concurrency**: each instance has its own state.json + worktree base (set `WORKTREE_BASE` differently per role to prevent collisions), so they don't trip over each other
- **Worker prompts per role**: easiest is one host project per role's worktree base + per-role `.agents/skills/coding-agent-work-loop/prompts/` overrides. Alternatively, a future enhancement could let one host project switch prompt sets by role suffix
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
