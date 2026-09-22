# Filed by issue: always findable, always resumable

> **English** · [中文](persistence.zh.md)

Every artifact an issue produces — design proposal, code, Claude's full conversation (thinking and tool calls included), tmux history — is tied to the **issue number**: worktree, branch, tmux session, Claude session, pane log filenames all include `issue<N>`. **If you remember the issue number, you can find any of it.** Unlike using AI bare, where finding "that conversation we had once" means scrubbing through hundreds of nameless sessions.

Machine reboot, accidental tmux kill, auto-cleanup after PR merge — all are recoverable by issue number. The rest of this doc has two halves: first the full asset listing, then concrete SOPs.

## Asset listing

| Asset | Path / location | Who cleans it | Backup advice |
|-------|-----------------|---------------|---------------|
| Design proposal | GitHub issue comment (worker stage-1 output) | No one; stays after issue close | None (GitHub is permanent) |
| Discussion | GitHub issue / PR comment thread | No one | None |
| Code branch | `feature/issue-N` (local + remote) | Only when you manually `git branch -d` | Remote = backup |
| Intermediate commits | git reflog + worktree history | git's 90-day gc may remove unreferenced objects | Push before merge |
| Worktree | `$WORKTREE_BASE/issue-N/` | Daemon removes it on PR merge if `AUTO_CLEANUP_ON_MERGE=true` | No backup needed (branch is on remote) |
| Tmux live session | tmux session `<TMUX_PREFIX>-issue<N>` | Daemon kills it on PR merge if `AUTO_CLEANUP_ON_MERGE=true`; vanishes on machine reboot | Not backupable (runtime state) |
| Tmux pane history | `$STATE_DIR/sessions/<TMUX_PREFIX>-issue<N>.log` (append-only) | No one; same issue re-spawn appends to the same file | The file itself is the backup |
| Claude conversation (incl. thinking + tool_use) | `~/.claude/projects/<encoded-cwd>/*.jsonl` | **No one**; `AUTO_CLEANUP_ON_MERGE` does NOT touch this | The file itself is the backup |
| Dispatch dedup / progress | `$STATE_DIR/state.json` | No one; daemon restart doesn't lose it | Occasional `cp` to backup |
| Retry counters (consecutive dispatch failures / self-heal attempts) | `$STATE_DIR/dispatch-fail/<kind>-<N>`, `$STATE_DIR/selfheal/<N>` | Cleared on the first success and again when the item is escalated to `pending/human` | Not worth backing up — losing them only grants a fresh set of attempts |
| Poll pace (idle + failure backoff) | `$STATE_DIR/poll-pace.json` | No one; safe to delete by hand at any time | Not worth backing up — deleting it just means the project polls at full speed again |

> `<encoded-cwd>` = the absolute path with `/` replaced by `-`. E.g. `/home/sky/github/worktree/myproject/issue-42` → `-home-sky-github-worktree-myproject-issue-42`.

## How long things are kept

Short answer: **as long as you don't delete them and the disk is alive, they stay**. Neither this tool, Claude Code, nor git auto-GCs —

- **GitHub issue / PR / comment**: permanent on GitHub; closing an issue / merging a PR doesn't delete them
- **git branch + commit**: neither local nor remote does auto-cleanup; `git gc` only removes **unreferenced** objects, so once you push or merge to main you're safe
- **`~/.claude/projects/<encoded-cwd>/*.jsonl`**: Claude Code doesn't auto-cleanup these (no `--gc/--prune/--retain` flag in help, no retention field in settings.json — as of 2026-05). Caveat: Anthropic's future policy may add one; for long-term archival peace of mind, `cp -r ~/.claude/projects/` to backup storage
- **`$STATE_DIR/sessions/*.log`, `$STATE_DIR/state.json`**: pure local files, no one cleans them

**Only thing that shrinks**: intermediate commits in a worktree that were **never pushed nor merged** can get pruned by `git gc` after 90 days as orphaned objects. Make `push` a habit and you're fine.

## SOPs: look it up later

### "Half a year later, I want to know why we designed it this way"

One-stop on GitHub:

```bash
gh issue view <N> --repo <owner>/<repo> --comments    # design + discussion
gh pr list --repo <owner>/<repo> --search "<N> in:body" --state all   # find the PR
gh pr view <P> --comments                              # review discussion + final outcome
```

### "I want to see how Claude reasoned step by step at the time"

Two complementary trails — **tmux pane log** for raw terminal output, **Claude jsonl** for structured prompt/response history:

```bash
# Tmux pane log (human-readable, chronological)
bash ~/.agents/skills/coding-agent-work-loop/scripts/session-log.sh <N> -c

# Claude raw conversation jsonl (indexed by cwd)
ls ~/.claude/projects/<encoded-cwd>/
jq -r '.message.content' ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl | less
```

### "I want to diff the intermediate implementation against what was merged"

```bash
git log --all --source -- <file>           # every commit touching this file
git reflog show feature/issue-N            # branch HEAD history
gh pr diff <P>                             # the diff that was merged
```

## SOPs: resume from a break point

### Worker mid-way and the machine rebooted

After recovery, the daemon's next poll cycle (up to 60s) auto-redispatches: sees worktree + session both gone, rebuilds the worktree from PR head branch, spawns a new tmux session. **Claude's conversation history doesn't auto-resume** (the new session starts fresh), but the jsonl on disk is still there — see the next section.

### Tmux session accidentally killed / auto-cleanup removed the worktree

Data **isn't lost**, four recovery paths:

```bash
# ① Know the session ID (from jsonl filename)
claude --resume <session-id>          # works from any directory

# ② Know the PR number
claude --from-pr <P>                   # PR-indexed recovery (see "How --from-pr matches" below)

# ③ Remember nothing, lean on the picker
mkdir -p <original-worktree-path>      # an empty dir is enough to coax the picker
cd <original-worktree-path>
claude --resume                        # picker lists all sessions for this cwd

# ④ Tools all fail, read the raw file
jq . ~/.claude/projects/<encoded-cwd>/*.jsonl
```

> `claude --continue` (`-c`) only sees the **most recent session in the current directory**. Once cleanup happens or you change directories, it's useless; cross-directory recovery requires `--resume` / `--from-pr`.

**How `--from-pr` matches**: every jsonl message has `cwd` (working directory at the time) and `gitBranch` (git branch at the time) fields. `--from-pr <P>` calls `gh pr view <P>` to get the PR's head ref (e.g. `feature/issue-42`), then scans all jsonl under `~/.claude/projects/` for sessions whose `gitBranch` matches the head ref, and resumes that one. So **it works precisely because the worker started Claude after `git checkout feature/issue-42`** — which this tool's dispatch scripts do by construction.

> Want 100% deterministic recovery → use the session ID directly (`claude --resume <uuid>`). The session ID is the uuid in `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`.
>
> Idea worth pursuing but out of scope here: have the worker auto-post its session ID as an issue/PR comment on startup, so you get a single-click `--resume <uuid>` later. Open a new issue if you want to track it.

## auto-cleanup boundaries

`AUTO_CLEANUP_ON_MERGE=true` (default on) triggers when the daemon sees a PR get merged. It **only cleans runtime state**:

| Gets cleaned | Does NOT get cleaned |
|--------------|-----------------------|
| `$WORKTREE_BASE/issue-N/` (worktree dir) | git branch (local + remote) |
| Tmux session `<TMUX_PREFIX>-issue<N>` | `~/.claude/projects/<encoded-cwd>/*.jsonl` |
| `CLEANUP_HOOK` (ports / tunnels / notifications) | `$STATE_DIR/sessions/*.log` (tmux pane log) |
|  | `$STATE_DIR/state.json` |
|  | GitHub issue / PR / comments |

Want to turn it off (post-merge leaves everything in place, fully manual):

```bash
# coding-agent.config
AUTO_CLEANUP_ON_MERGE="false"
```

Then run `bash $SKILL_DIR/scripts/cleanup-issue.sh <N>` when you want to clean. Flags in [operations.md](operations.md).
