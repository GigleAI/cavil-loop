---
name: coding-agent-work-loop
description: GitHub label-driven workflow that lets a local AI handle issues / PRs; the daemon listens for `pending/agent` and dispatches work. Every issue's design proposal / discussion / code / Claude conversation / tmux history is filed under the issue number, so you can find or resume any of it later just by knowing the issue number. Commands include setup (deploy to a project), status (check daemon state), disable (turn off a project's daemon)
---

# coding-agent-work-loop

> **English** · [中文](SKILL.zh.md)

Turn GitHub issue / PR comments into the input and output of your local AI. A systemd timer + a few shell scripts + two GitHub labels let you talk to the AI directly through the GitHub web UI (or the iOS gh app).

> This skill is agent-agnostic by design. Worker CLI is selected by `WORKER_AGENT=<name>` in `coding-agent.config`; the daemon / dispatch scripts go through a thin **driver layer** that plugs in different agent CLIs. Built-in drivers: `claude` (default, Claude Code), `opencode` (sst/opencode), `codex` (OpenAI Codex CLI). Add your own via `scripts/drivers/<name>.sh` — see [docs/drivers.md](docs/drivers.md).

## When to invoke

The user calls this skill from the host agent runtime via `/coding-agent-work-loop <command>` or a natural-language request. Common forms:

- "Install this daemon on project X" → run the `setup` flow
- "What's the state of the coding agent?" → run the `status` flow
- "Disable the coding agent on project X" → run the `disable` flow

## What you (the agent) should do when invoked

### setup (deploy to a host project)

The user gives you a host project path (e.g. `~/github/myproject`). Steps:

1. Verify the path exists and is a git repo (has `.git`)
2. Check deps: `git`, `gh` (must be logged in via `gh auth login`), `tmux`, `jq`, `flock`, `systemctl`, plus the worker CLI selected by `WORKER_AGENT` (default `claude`; other built-ins: `opencode`, `codex`). Each must resolve via `command -v`.
3. Run:
   ```bash
   bash "${CLAUDE_PLUGIN_ROOT:-$HOME/.agents/skills/coding-agent-work-loop}/setup.sh" <host-project-path>
   ```
   `$CLAUDE_PLUGIN_ROOT` is the skill-root env Claude Code injects; if absent, fall back to the canonical `~/.agents/skills/coding-agent-work-loop`.
4. `setup.sh` prints next-step guidance when done — relay it to the user verbatim.

### status

User wants the state. Steps:

1. `systemctl --user list-timers 'coding-agent-poll@*' --no-pager` — timer health
2. `systemctl --user list-units 'coding-agent-poll@*.service' --no-pager` — last execution
3. For each registered `~/.config/coding-agent-work-loop/*.conf`:
   - `tail -20 $STATE_DIR/poll.log` (read `STATE_DIR` from the conf)
   - `gh issue list --repo $REPO --label pending/agent` + `gh pr list --repo $REPO --label pending/agent`
4. Summarize for the user

### cleanup (after a PR is accepted / rejected)

User merged a PR or wants to abort work on an issue. Steps:

1. Confirm the issue is finished (PR merged or closed)
2. Run:
   ```bash
   bash "$CLAUDE_PLUGIN_ROOT/scripts/cleanup-issue.sh" <issue-number>
   ```
   Optional flags: `--force` (clean even if the worker is busy), `--keep-worktree` (only kill the session), `--delete-branch` (also drop the local branch)

What `cleanup-issue.sh` does:
- Busy check (refuses by default unless `--force`)
- Runs the project-level `CLEANUP_HOOK` (configured in `coding-agent.config`, e.g. tear down tailscale ports, stop dev server)
- Kills the worker's tmux session
- Removes the worktree (default)
- Optionally removes the local branch

### disable

User wants to stop one project. Steps:

1. Confirm the instance name (`systemctl --user list-timers 'coding-agent-poll@*'`)
2. `systemctl --user disable --now coding-agent-poll@<key>.timer`
3. Optional: remove the `~/.config/systemd/user/coding-agent-poll@<key>.{service,timer}` instance symlinks (leave the actual template alone)
4. Optional: remove `~/.config/coding-agent-work-loop/<key>.conf`
5. Report back

## What does NOT land in the host project

After `setup`, the host project's worktree gains **only two things**:

1. One `.gitignore` line (excluding `coding-agent.config`)
2. A `coding-agent.config` (gitignored, config)

Scripts, systemd units, state, logs all live outside the host project (skill dir + `~/.config/` + `~/.local/state/`).

## Full architecture

See sibling [README.md](README.md).

## File listing

- `setup.sh` — bootstrap a host project
- `scripts/` — daemon + dispatch scripts (never copied to host project)
- `prompts/` — initial worker prompt templates (override via host project's `.agents/skills/coding-agent-work-loop/prompts/`)
- `systemd/` — `coding-agent-poll@.service/.timer` template units; setup copies them to `~/.config/systemd/user/`
- `coding-agent.config.example` — config template
