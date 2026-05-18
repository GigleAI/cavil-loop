# coding-agent-work-loop

> **English** · [中文](README.zh.md)

**Async coding agents driven by GitHub labels — your AI works in parallel while you sleep.**

> Turn "babysitting an AI step-by-step" into "wake up, review the PRs."

## What it solves

Working with AI on code is normally **serial**: write a prompt → wait → read → respond → wait → read… You can't walk away, and a single evening barely gets a few requests done.

This tool moves the loop into GitHub, making it **parallel**:

```
Before bed: open 10 issues, label each pending/agent, close laptop, sleep.
Morning:    10 PRs / design proposals sit on GitHub. Review them like a reviewer,
            merge what's good, comment + re-label what needs changes,
            AI does another round on its own (you stay hands-off).
```

You shift from "the person chatting with the AI" to "the person reviewing the AI's PRs." N requests run in parallel, never blocking each other, and progress is visible at a glance via GitHub labels. The mobile gh app handles review + comment + label too, so you can keep things moving during the commute.

## How it works

A **background poller** on your machine looks at GitHub every 60 seconds. When it sees an issue or PR labeled `pending/agent`, it spins up Claude Code locally in an **isolated working directory** to do the work — read comments, write code, run tests, commit, push, reply — then flips the label back to `pending/human` for your review. Everything stays as a paper trail in GitHub comments.

Two trigger scenarios:

| Scenario | Trigger | What the AI does |
|----------|---------|------------------|
| New request | Add `pending/agent` to an issue | Posts a **design proposal** comment first (asking how to approach it, whether to split PRs), then on your confirmation: branch → implement → open PR |
| Review feedback | Add `pending/agent` to a PR (with a comment) | Finds the AI session for this PR, reads the latest comment, and acts |

**Cheap**: the AI is your local `claude` CLI, billed under your Pro/Max subscription — no API tokens burned. The 60s polling only hits the GitHub API, not the model.

## Filed by issue number: always findable, always resumable

Every artifact from an issue's run — the design proposal, the code, Claude's full conversation (thinking and tool calls included), tmux history — is tied to the **issue number**. Resuming #42 later: `cd` into the matching worktree and `claude --resume` to pick the session — you're instantly back in that conversation. Unlike a bare AI chat where you have to scrub through hundreds of nameless sessions to find "that one from before."

Full list of where each artifact lives, retention policy, and SOPs for finding things / resuming work: see [docs/persistence.md](docs/persistence.md).

## What it **doesn't** do

- ❌ **Not a cloud service**: runs on your laptop / NAS. Machine off = it stops
- ❌ **Doesn't replace code review**: the AI changes code and auto-pushes, review is still your job. Protect main + require reviewers
- ❌ **Doesn't auto-merge**: merging / closing PRs is always your call

---

## Quick start

### 1. Install (once)

```bash
npx skills add luosky/coding-agent-work-loop
```

Powered by [skills.sh](https://www.skills.sh/docs/faq) — fetches this skill and registers it with your AI agent (Claude Code et al.). Run the same command again to upgrade.

<details>
<summary>Manual install (without npx)</summary>

```bash
git clone https://github.com/luosky/coding-agent-work-loop.git ~/github/coding-agent-work-loop
mkdir -p ~/.agents/skills ~/.claude/skills
ln -s ~/github/coding-agent-work-loop ~/.agents/skills/coding-agent-work-loop
ln -s ~/.agents/skills/coding-agent-work-loop ~/.claude/skills/coding-agent-work-loop
```

Code lives in `~/github/`; two symlinks let Claude Code find it. Future upgrade: `cd ~/github/coding-agent-work-loop && git pull`.
</details>

### 2. Connect a project

```bash
bash ~/.agents/skills/coding-agent-work-loop/setup.sh ~/path/to/your-project
```

Or just say "install coding-agent-work-loop on ~/path/to/your-project" inside Claude Code — the AI will run it.

One command handles: per-project config, registering the background poller, creating `pending/agent` / `pending/human` etc. labels in the repo, starting the timer. Non-destructive, idempotent.

### 3. Keep running while logged out (optional)

```bash
sudo loginctl enable-linger $USER
```

Linux stops user services on logout by default; this keeps the poller alive when you're away.

## Dependencies

`git`, `gh` (run `gh auth login` first), `tmux`, `jq`, `flock`, `claude` (Pro/Max plan). Linux uses the built-in `systemd` to schedule the poller; macOS uses `launchd` (see [docs/operations.md](docs/operations.md#alternative-schedulers)). Tested on Ubuntu 22.04 / 24.04.

---

## Usage

### Scenario 1: New request

```bash
gh issue create --title "..." --body "..."     # say you get #42
gh issue edit 42 --add-label pending/agent
```

Within 60s the poller picks it up: builds an isolated working dir, starts Claude Code, writes code, opens a PR (with `Closes #42` or `Refs #42` in the body), flips the label to `pending/human` for your review. Watch what the AI does: `tmux attach -t <project>-issue42`.

### Scenario 2: PR review feedback

```bash
gh pr comment N --body "rename foo to bar"
gh pr edit N --add-label pending/agent --remove-label pending/human
```

Within 60s the poller finds the AI session for this PR, feeds in your comment → AI edits → tests → push → reply → flip label.

### Scenario 3: Clarification question

```bash
gh pr comment N --body "why not pattern X here?"
gh pr edit N --add-label pending/agent --remove-label pending/human
```

AI sees it's a discussion question, replies without touching code, keeps label `pending/human` waiting for your next turn.

---

## Read more

| Doc | About |
|-----|-------|
| [docs/architecture.md](docs/architecture.md) | Five-state label machine, PR↔Issue closure relationship (A/B/C), why the design works this way |
| [docs/persistence.md](docs/persistence.md) | Where design proposals / discussions / code / Claude conversations / tmux history live, how to look them up later, how to resume from a break point |
| [docs/security.md](docs/security.md) | **Public-repo users must read.** Anonymous comments can contain prompt injection; how the defenses work |
| [docs/operations.md](docs/operations.md) | Full config, prompt templates, multi-project, upgrades, macOS launchd, webhook trigger, swapping AI worker, troubleshooting |

## Note

This is an **Agent Skill** — a feature package loaded by AI coding tools like Claude Code. But you don't need Claude Code to run it: the background scripts are plain shell + `gh` CLI, scheduled by cron / systemd / launchd, and you can swap Claude out for Aider / Cursor CLI / others (see [docs/operations.md → custom worker](docs/operations.md#custom-worker-not-claude-code)).

## License

MIT. See [LICENSE](LICENSE).
