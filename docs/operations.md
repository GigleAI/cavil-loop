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
| `${OUTPUT_LANGUAGE}` | ISO 639-1 code controlling the language of GitHub-facing output (from `coding-agent.config`, default `en`) |

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

```
~/.config/coding-agent-work-loop/
└── <project-key>.conf                  # systemd EnvironmentFile

~/.config/systemd/user/
├── coding-agent-poll@.service          # symlink → skill dir template
└── coding-agent-poll@.timer            # symlink → skill dir template

~/.local/state/coding-agent-poll/<project>/
├── state.json                          # { "seen_comments": ..., "cleaned_prs": ... }
├── poll.log                            # rolling log
├── poll.lock                           # flock
└── sessions/                           # tmux pane logs per worker
    └── <project>-issue<N>.log
```

## Running multiple projects

Skill installed once, systemd template symlinked once. For each project:

```bash
bash ~/.agents/skills/coding-agent-work-loop/setup.sh ~/github/projectA
bash ~/.agents/skills/coding-agent-work-loop/setup.sh ~/github/projectB
```

You get:

```
~/.config/coding-agent-work-loop/
├── projectA.conf
└── projectB.conf

systemctl --user list-timers
  coding-agent-poll@projectA.timer
  coding-agent-poll@projectB.timer
```

Independent logs, independent state, no interference.

## Upgrading the skill

Recommended workflow (project cloned at `~/github/coding-agent-work-loop`, symlinked into the skill dir):

```bash
cd ~/github/coding-agent-work-loop
git pull
```

The systemd unit is a symlink pointing at the template, so the next timer tick uses the new logic — **no need to re-run `setup.sh`**.

## Alternative schedulers

systemd isn't required; the scripts are stateless and can be invoked by any scheduler.

**cron** (macOS / when you'd rather not deal with systemd):

```cron
* * * * * CODING_AGENT_CONFIG=$HOME/myproject/coding-agent.config bash $HOME/.agents/skills/coding-agent-work-loop/scripts/agent-poll.sh >> /tmp/coding-agent-cron.log 2>&1
```

**macOS launchd**:

```xml
<!-- ~/Library/LaunchAgents/com.example.coding-agent-poll.plist -->
<plist version="1.0">
  <dict>
    <key>Label</key><string>com.example.coding-agent-poll</string>
    <key>ProgramArguments</key>
    <array>
      <string>/bin/bash</string>
      <string>/Users/you/.agents/skills/coding-agent-work-loop/scripts/agent-poll.sh</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
      <key>CODING_AGENT_CONFIG</key>
      <string>/Users/you/myproject/coding-agent.config</string>
    </dict>
    <key>StartInterval</key><integer>60</integer>
  </dict>
</plist>
```

**Claude Code `/loop` skill**: open a long-running session that calls `/loop 60s bash ~/.agents/skills/coding-agent-work-loop/scripts/agent-poll.sh`. Upside: the scheduling logic can be context-aware. Downside: expensive + the session dying stops everything.

## Upgrading to webhooks (instant trigger)

Polling has up to 1 minute of latency. For instant:

1. Tailscale funnel / Cloudflare tunnel to expose your local `<port>` publicly
2. Run something like [`webhook`](https://github.com/adnanh/webhook) — a small listener subscribed to GitHub `issue_comment` + `labeled` events
3. On event → invoke `agent-poll.sh` (the poller is label-filtered and state.json-deduped, safe to retrigger)
4. Keep the systemd timer as a fallback

## Custom worker (not Claude Code)

Worker selection now goes through a thin **driver layer** — no fork needed. Set `WORKER_AGENT=<name>` in `coding-agent.config`. Built-ins: `claude` (default), `opencode`, `codex`. To add your own agent, drop a `scripts/drivers/<name>.sh` (or project-level override at `<host>/.agents/skills/coding-agent-work-loop/drivers/<name>.sh`) — see [drivers.md](drivers.md) for the 5-function contract and a template.

## Troubleshooting

### Timer is on but daemon isn't running

```bash
systemctl --user status coding-agent-poll@<key>.timer
systemctl --user status coding-agent-poll@<key>.service
journalctl --user -u coding-agent-poll@<key>.service --since "10 min ago"
```

Common causes:
- `~/.config/coding-agent-work-loop/<key>.conf` has a bad path → edit the conf
- `coding-agent.config` is missing fields → check `poll.log`
- `gh auth` not logged in → `gh auth status`
- `claude` isn't in systemd's `PATH` → in `~/.config/coding-agent-work-loop/<key>.conf` add the `which claude` dir to `PATH=`

### Worker session stuck on permission prompt

Make sure `CLAUDE_EXTRA_FLAGS="--dangerously-skip-permissions"` is set in `coding-agent.config`. Strongly recommended in trusted local environments.

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

```bash
systemctl --user stop coding-agent-poll@<key>.timer
tmux ls | grep "^<project>-issue[0-9]" | cut -d: -f1 | xargs -r -n1 tmux kill-session -t
```

### Uninstall one project

```bash
KEY=<key>
systemctl --user disable --now coding-agent-poll@$KEY.timer
rm ~/.config/coding-agent-work-loop/$KEY.conf
# optional: rm <host>/coding-agent.config (or keep it for re-deploy later)
# optional: rm -r ~/.local/state/coding-agent-poll/<project>
```
