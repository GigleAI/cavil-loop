# Filed by issue: always findable, always resumable

> **English** · [中文](persistence.zh.md)

Every artifact an issue produces — design proposal, code, Claude's full conversation (thinking and tool calls included), tmux history — is tied to the **issue number**: worktree, branch, tmux session, Claude session, pane log filenames all include `issue<N>`. **If you remember the issue number, you can find any of it.** Unlike using AI bare, where finding "that conversation we had once" means scrubbing through hundreds of nameless sessions.

Machine reboot, accidental tmux kill, auto-cleanup after PR merge — all are recoverable by issue number. The rest of this doc has two halves: first the full asset listing, then concrete SOPs.

## Asset listing

The work itself lives on GitHub and in git; the conversation lives in the tmux pane log and Claude's session files; the daemon keeps its own small state files under `$STATE_DIR`. Only the worktree and the live tmux session are removed after a merge (see [auto-cleanup boundaries](#auto-cleanup-boundaries)).

<details><summary>Table: work, history and conversation</summary>

| Asset | Path / location | Who cleans it | Backup advice |
|-------|-----------------|---------------|---------------|
| Design proposal | GitHub issue comment (worker stage-1 output) | No one; stays after issue close | None (GitHub is permanent) |
| Discussion | GitHub issue / PR comment thread | No one | None |
| Code branch | `feature/issue-N` (local + remote) | Only when you manually `git branch -d` | Remote = backup |
| Intermediate commits | git reflog + worktree history | git's 90-day gc may remove unreferenced objects | Push before merge |
| Worktree | `$WORKTREE_BASE/issue-N/` | Daemon removes it on PR merge if `AUTO_CLEANUP_ON_MERGE=true` | No backup needed (branch is on remote) |
| Tmux live session | tmux session `<TMUX_PREFIX>-issue<N>` | Daemon kills it on PR merge if `AUTO_CLEANUP_ON_MERGE=true`; vanishes on machine reboot | Not backupable (runtime state) |
| Tmux pane history | `$STATE_DIR/sessions/<TMUX_PREFIX>-issue<N>.log` (append-only) | No one; same issue re-spawn appends to the same file | The file itself is the backup |
| Claude conversation (incl. thinking + tool_use) | `~/.claude/projects/<encoded-cwd>/*.jsonl` | Not this tool — `AUTO_CLEANUP_ON_MERGE` does NOT touch it; Claude Code itself removes old session files (its `cleanupPeriodDays` setting) | Copy it elsewhere if you want to keep it |

> `<encoded-cwd>` = the absolute path with `/` replaced by `-`. E.g. `/home/sky/github/worktree/myproject/issue-42` → `-home-sky-github-worktree-myproject-issue-42`.

</details>

<details><summary>Table: the daemon's local state files</summary>

| Asset | Path / location | Who cleans it | Backup advice |
|-------|-----------------|---------------|---------------|
| Dispatch dedup / progress | `$STATE_DIR/state.json` | No one; daemon restart doesn't lose it | Occasional `cp` to backup |
| Dispatch prompts (the prompt rendered for the worker on each dispatch) | `$STATE_DIR/prompts/<N>-new.md`, `<N>-cmt-<comment id>.md`, `<N>-pr-<PR>.md` (directory mode 700, readable by this account only) | Removed for that number when the item is cleaned up (`cleanup-issue.sh`, including the automatic cleanup after merge) — leave it to that. If you delete by hand, only for items with no dispatch in progress (not `doing/agent`, no poll running): the worker reads the file only when it starts, during the dispatch, and codex reads it once more afterwards to confirm which session is its own; deleting it then starts the worker with an empty prompt | Not worth backing up — nothing reads it once the dispatch has finished, and the content stays in the tmux history and the Claude conversation. Leftover `/tmp/cavil-loop-*.md` files from older installs are not read by anything; nobody cleans them, they go away on reboot |
| Retry counters (consecutive dispatch failures / self-heal attempts) | `$STATE_DIR/dispatch-fail/<kind>-<N>`, `$STATE_DIR/selfheal/<N>` | Cleared on the first success and again when the item is escalated to `pending/human` | Not worth backing up — losing them only grants a fresh set of attempts |
| Poll pace (idle + failure backoff) | `$STATE_DIR/poll-pace.json`, or the path in `PACE_FILE` when that is set ([which file](architecture.md#poll-pace-idle-and-failure-backoff)) | No one; safe to delete by hand at any time | Not worth backing up — deleting it just means the project polls at full speed again |
| Usage-limit pause, per agent and account directory | `~/.local/state/cavil-loop/usage-limit/<agent>-<hash>.json` (machine-wide, shared by every project) | No one; it stops counting at its `until` time. Deleting it lifts the pause now | Not worth backing up — if the account is still limited, the next worker that hits the limit brings it back |
| Usage-limit progress of one project | `$STATE_DIR/usage-limit.json` | The daemon, as items leave `doing/agent` | Not worth backing up; do not delete it while a hand-over is in progress (a second comment could follow) |
| Poll run log (one record per round, snapshots) | `$STATE_DIR/runlog/` (`rounds/`, `snapshots/`, `inflight/`, `acct/`), plus `~/.local/state/cavil-loop/runlog/entry/` for polls that never loaded their config | The poller itself: newest 1000 records, 20 snapshots, 64 progress files, 200 entry records; safe to delete by hand at any time | Not worth backing up — diagnostics only, nothing reads it back |
| Records of outside accounts' content on autopilot items | `$STATE_DIR/outsider/<item number>/` (one file per seen version of each outside comment; fingerprints only, no text), screening verdicts in `$STATE_DIR/outsider-screen/` | The item's cleanup (`cleanup-issue.sh`) removes its directory; nobody removes the verdicts | Not worth backing up; **do not delete while the autopilot item is open**: a deleted outside comment would then stop holding back the merge |
| Machine-wide post-merge retrospective lock | `~/.local/state/cavil-loop/retrospective.lock` (one per machine, shared by every project and every deployed release) | No one; an empty file whose lock is released when the process exits | Not worth backing up — safe to delete while no retrospective is running |
| Auto-fetched prices for models missing from the built-in tables | `~/.cache/cavil-loop/fetched-prices.json` (+ `unpriced/` markers, `price-fetch-state.json` retry state) | No one; markers are removed once a model is priced | Not worth backing up — deleting it just makes the daemon fetch again the next time a gap shows up |

</details>

## How long things are kept

This tool and git delete nothing on their own beyond what [auto-cleanup](#auto-cleanup-boundaries) removes; GitHub keeps issues, PRs and comments for good. Two things do shrink: commits that were never pushed nor merged, and Claude Code's old session files.

<details><summary>Details per kind of artifact</summary>

- **GitHub issue / PR / comment**: permanent on GitHub; closing an issue / merging a PR doesn't delete them
- **git branch + commit**: neither local nor remote does auto-cleanup; `git gc` only removes **unreferenced** objects, so once you push or merge to main you're safe. Intermediate commits in a worktree that were **never pushed nor merged** can get pruned by `git gc` after 90 days as orphaned objects — make `push` a habit
- **`~/.claude/projects/<encoded-cwd>/*.jsonl`**: Claude Code removes session files older than its `cleanupPeriodDays` setting; for long-term archival, raise that setting or `cp -r ~/.claude/projects/` to backup storage
- **`$STATE_DIR/sessions/*.log`, `$STATE_DIR/state.json`**: pure local files, no one cleans them

</details>

## SOPs: look it up later

Design and discussion are read on GitHub, the reasoning from the pane log and the Claude session files, the code history from git.

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
bash ~/.agents/skills/cavil-loop/scripts/session-log.sh <N> -c

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

The daemon rebuilds a lost worktree and session by itself; the Claude conversation is resumed by hand from the session files on disk.

### Worker mid-way and the machine rebooted

After recovery, the daemon's next poll cycle (up to 60s) auto-redispatches: sees worktree + session both gone, rebuilds the worktree from PR head branch, spawns a new tmux session. **Claude's conversation history doesn't auto-resume** (the new session starts fresh), but the jsonl on disk is still there — see the next section.

### Tmux session accidentally killed / auto-cleanup removed the worktree

Data **isn't lost**; resume by session ID, by PR number, from the picker in the original directory, or read the raw file.

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

<details><summary>Details: --continue, how --from-pr matches, the session ID</summary>

`claude --continue` (`-c`) only sees the **most recent session in the current directory**. Once cleanup happens or you change directories, it's useless; cross-directory recovery requires `--resume` / `--from-pr`.

**How `--from-pr` matches**: every jsonl message has `cwd` (working directory at the time) and `gitBranch` (git branch at the time) fields. `--from-pr <P>` calls `gh pr view <P>` to get the PR's head ref (e.g. `feature/issue-42`), then scans all jsonl under `~/.claude/projects/` for sessions whose `gitBranch` matches the head ref, and resumes that one. So **it works precisely because the worker started Claude after `git checkout feature/issue-42`** — which this tool's dispatch scripts do by construction.

Want 100% deterministic recovery → use the session ID directly (`claude --resume <uuid>`). The session ID is the uuid in `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`. The worker does not post its session ID to the issue / PR; open an issue if you want that.

</details>

## auto-cleanup boundaries

`AUTO_CLEANUP_ON_MERGE=true` (default on) triggers when the daemon sees a PR get merged and **only cleans runtime state**: the worktree, the tmux session and whatever `CLEANUP_HOOK` does. Set `AUTO_CLEANUP_ON_MERGE=false` in `cavil-loop.config` to leave everything in place and run `bash $SKILL_DIR/scripts/cleanup-issue.sh <N>` yourself (flags in [operations.md](operations.md)).

<details><summary>Table: what is and is not cleaned</summary>

| Gets cleaned | Does NOT get cleaned |
|--------------|-----------------------|
| `$WORKTREE_BASE/issue-N/` (worktree dir) | git branch (local + remote) |
| Tmux session `<TMUX_PREFIX>-issue<N>` | `~/.claude/projects/<encoded-cwd>/*.jsonl` |
| `CLEANUP_HOOK` (ports / tunnels / notifications) | `$STATE_DIR/sessions/*.log` (tmux pane log) |
|  | `$STATE_DIR/state.json` |
|  | GitHub issue / PR / comments |

</details>
