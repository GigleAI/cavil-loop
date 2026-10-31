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

## External requester bot

Some projects let another AI assistant file requests directly. That assistant has its own GitHub account — below, the "requester bot" — and acts for the people it serves (the "requester"). The bot opens issues in a repo running cavil-loop and cavil-loop handles them as usual. Whenever a request **has a question the requester must answer**, or **is finished**, the result goes back to the bot, which brings back the answer or passes the result on. That closes the loop between the bot and cavil-loop.

**Off by default.** Everything is switched on through config, and neither the code nor the config template names any particular bot (GitHub#95 / #97 / #100).

### How one request closes the loop

```
bot opens an issue (body carries the marker, bot adds pending/agent itself)
   │
   ▼
agent posts a proposal / question / report ── comment ── runs the wake-up script
   │                                           │ adds the waiting label, removes pending/agent etc.
   │                                           │ calls the bot's webhook once (if configured)
   ▼                                           ▼
waiting: daemon does not dispatch     bot pulls every item carrying the waiting label → reads the thread
   │                                  → takes it to the requester → comments "sent to X"
   │                                           │
   │                                           ▼
   │                         gets the answer → pastes it verbatim → removes the waiting label → adds pending/agent
   ▼
agent reads the answer and carries on …… the PR is merged (or closed unmerged)
   │
   ▼
daemon posts a result comment on the bot's issue, adds the waiting label, calls the webhook → the bot tells the requester and removes the label
```

### Config

| Setting | Meaning |
|---|---|
| `LABEL_PENDING_REQUESTER_BOT` | The waiting label, e.g. `pending/requester-bot`. `setup.sh` creates it |
| `REQUESTER_BOT_ACCOUNT` | The requester bot's GitHub login. Used only to recognise the issues it filed (see the next row) — it is **no longer** assigned or asked to review |
| `REQUESTER_BOT_ALLOWED_ACTORS` | Accounts allowed to run the wake-up (comma-separated) — normally the account workers / reviewers comment with |
| `REQUESTER_BOT_ORIGIN_MARKER` | An issue counts as "filed by the bot" only when its body contains this text **and** its author is the bot account; a PR is judged by its linked issue: the number in its branch name, else `Closes #N`-style links in its body (a keyword and number split across lines is ambiguous and refused) |
| `REQUESTER_BOT_REPORT_FIRST` | `true`: report to the bot first, hand to the maintainer for merge once the requester approves the current commit; `false` (default): hand straight to the maintainer |
| `REQUESTER_BOT_WEBHOOK_URL` | Optional. The bot's webhook URL; empty = nothing is sent (the waiting label alone, picked up by the bot's own periodic scan) |
| `REQUESTER_BOT_WEBHOOK_KEY_HEADER` | Name of the header carrying the key, per the bot's instructions, e.g. `Authorization`. Letters, digits and `-` only |
| `REQUESTER_BOT_WEBHOOK_KEY` | The header's value, sent as-is (include the `Bearer ` prefix yourself if needed) |

The feature is on only when the first four are all set. The three webhook settings are read only from the project config file (a same-named variable in the systemd environment file is ignored), and the file must be mode `600`. With everything empty, dispatching, the greedy skip list, all four prompt kinds and post-merge handling are byte-for-byte what they were.

**Early names still work.** The settings used to be `LABEL_PENDING_RELAY` / `RELAY_BOT_ACCOUNT` / `RELAY_ALLOWED_ACTORS` / `RELAY_ORIGIN_MARKER` / `RELAY_REPORT_FIRST`, and the wake-up script `notify-relay.sh`. A project configured with those needs no change. Each setting is picked on its own: the new name if it has a value, else the old one; if both are set and differ, the new one wins and the wake-up output and `poll.log` say so. To switch, replace `RELAY_` with `REQUESTER_BOT_` and `LABEL_PENDING_RELAY` with `LABEL_PENDING_REQUESTER_BOT`; the label itself (e.g. `pending/relay`) need not be renamed.

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
bash ~/.agents/releases/cavil-loop/entrypoints/notify-requester-bot.sh --config <project config> <issue or PR number>
```

Pre-checks first — if any fails it refuses without sending a single write:

- the current GitHub account is in the allowed list
- the item was filed by the bot (author + marker, see above)
- the item does not carry `pending/human` (including the review-cap `pending/review` + `pending/human` pair)
- no maintainer ever added `pending/human` by hand. "Maintainer" = an account that is neither in the allowed list nor the bot. Once a maintainer has taken over, every later handoff goes to the maintainer

Then it wakes the bot, the same way for issues and PRs: **wake-up = waiting label + one call to the bot's webhook**. It used to re-assign the bot and, on a PR, request its review, but on the first project that adopted this the bot never received those events and relied entirely on its own periodic scan (about every 15 minutes by day, 30 at night). Since GitHub#100 the webhook replaces them: no assignment, no review request.

Steps: add the waiting label → remove every trigger label, `doing/agent`, `pending/review` → read back and verify (waiting label present, none of the removed ones left). On failure it retries the whole thing once; if that fails too it hands back to the maintainer: add `pending/human` → remove the trigger labels etc. → read back → remove the waiting label **last**. Removing it last means that if the handback stops halfway, the greedy pass and self-heal are still held off by it.

**The webhook is called only after a successful wake-up** (first try or retry), exactly once per wake-up; on exits 2 / 3 / 4 the handoff was not confirmed and it is never called.

| Exit | Meaning | Agent should |
|---|---|---|
| 0 | woken (labels are set; the webhook result is one line of output and does not change the exit code; not proof the bot passed anything on) | stop and wait |
| 2 | refused by a pre-check, labels untouched | hand to the maintainer as usual |
| 3 | wake-up failed, handed back to the maintainer (only `pending/human` left) | post a short note |
| 4 | the handback failed too; output shows the labels actually read back | say so plainly, never claim it was handed over |

After answering, the bot removes the waiting label itself — that is the bot's side, not cavil-loop's.

### The webhook call

One POST, and the bot comes and pulls **every** item carrying the waiting label (it always pulls everything and does not act on the request body).

- Request: `POST`, `Content-Type: application/json`, body `{"repo":"<owner/repo>","number":<number>,"kind":"issue"|"pr"}` — a hint, no instructions; the configured header carries the key
- When it is not sent (any one holds: one log line, no request, exit code unchanged): URL empty (not even a log line) → `webhook 配置不完整，跳过` (header name or key empty, header name has characters other than letters / digits / `-`, URL or key contains a newline or other control character) → `配置文件权限过宽（应为 600），webhook 跳过` (any group / other permission bit) / `读不到配置文件权限，webhook 跳过` → `找不到 curl，webhook 跳过`
- **URL, header and key never go on a command line**: they are fed to `curl --config -` on stdin, invisible to `ps`; no output or log line ever contains them
- 10-second limit, no retry, redirects not followed (following would carry the key header to another host), http / https only, the user's `~/.curlrc` is not read
- The result is one line: `已通知 webhook（HTTP 200）` or `webhook 通知失败（HTTP 503 / 超时 / 连接失败）` (sent / failed: HTTP status, timeout, connection failed). **A failure is not a wake-up failure**: the exit code stays 0 and the bot's periodic scan is the fallback

### Telling the bot when it is done (merged / closed unmerged)

When a PR is merged, or closed without merging, the daemon tells the bot on its own — no worker needed:

- **Only requests filed by the bot**: the PR's linked issue must pass the same author + marker check as the wake-up script (one shared implementation)
- **What it does**: posts a result comment on that issue ("request done: PR #N merged" with the merge commit, or "PR #N closed without merging") → adds the waiting label to that issue and reads it back → calls the webhook once (`kind` is `issue`, the number is the source issue). It does this even when `Closes #N` has already closed the issue. The bot is no longer assigned
- **The bot's side must agree**: it pulls closed items carrying the waiting label too, and removes the label itself once it has passed the result on
- **Closed unmerged while the same request still has another PR open**: no notice (the work goes on). This is re-checked on every attempt — if the first try failed and a new PR was opened before the retry, nothing is sent; if the open-PR list cannot be read, that counts as unknown and waits for the next tick, never as "none". Once the request has been reported as merged, an old PR being closed is not reported
- **The write identity must be on the allowed list** — the same check as the wake-up script; if it is not, or cannot be read, nothing is written, the notice waits for the next tick and `poll.log` says why
- **Once only**: the comment carries a hidden marker; a retry first checks whether this account already posted it and, if so, only redoes the label. A failure to add or read back the label retries on the next tick, up to 30 ticks per PR; giving up logs a ⚠️ line to `poll.log`. A webhook failure is one log line and is not retried
- **Re-reads the PR before writing**: it must be closed, merged-or-not as first seen; if the fields cannot be read, nothing is written this tick
- Runs inside the post-merge cleanup pass (`AUTO_CLEANUP_ON_MERGE`, on by default): with that off, no merge / close notice is sent

### Handoff rules (appended to the dispatch prompt)

With the feature on, the daemon appends an "external requester bot handoff rules" section at the **very end** of all four dispatch prompts (new issue, issue comment, PR comment, review). It goes at the end so projects that replace the whole built-in template still get it. Key points:

- **Wake the bot**: proposals / revised proposals the requester has to confirm (with cross-review on, the reviewer wakes the bot when the proposal passes review); product questions for the requester during implementation; result reports (when `REQUESTER_BOT_REPORT_FIRST=true`). The merge / close result is sent by the daemon; workers need not do anything
- **Still maintainer only**: maintainer already took over, suspicious content, red tests needing a call, unresolvable conflicts, review cap reached, permissions / local config / credentials / database grants
- **Evidence rules**: "requester notified" counts only on the bot's "sent to X" comment after the report; "approved" counts only when the bot's verbatim answer clearly approves **and** the approved report names the PR's current head commit. Approved → hand to the maintainer for merge; changes requested → fix, re-review, report again; ambiguous → ask again
- Attachments the bot pastes into the issue (images etc.) are downloaded with the agent's own token

Not included: the agent *sending* attachments to the bot (GitHub has no programmatic comment-attachment upload); a separate issue later.

### Example: grokbot

Using the GitHub account [`grokbot`](https://github.com/grokbot) so it can file requests into the project directly and hear back when there is a question or the work is done.

**1. Give grokbot a role that can edit labels.** Work starts on the `pending/agent` label, which only people with the right repo permission can add — that is what stops strangers from putting the agent to work, and this feature does not change it. The lowest GitHub repo role that can edit labels is **Triage**: it manages labels and cannot change code.

- Repo → Settings → Collaborators and teams → Add people → `grokbot` → role **Triage** → send the invite; grokbot accepts it
- To pause grokbot, remove it on the same page

**2. Config** (`cavil-loop.config`; use your own worker account):

```bash
LABEL_PENDING_REQUESTER_BOT="pending/requester-bot"
REQUESTER_BOT_ACCOUNT="grokbot"
REQUESTER_BOT_ALLOWED_ACTORS="your-worker-bot"          # the account workers / reviewers comment with
REQUESTER_BOT_ORIGIN_MARKER="<!-- requested-by-grokbot -->"
REQUESTER_BOT_REPORT_FIRST="true"                       # report to grokbot first, maintainer merges after approval
# webhook (URL and key from grokbot's side; chmod 600 the config file)
REQUESTER_BOT_WEBHOOK_URL="https://<url from grokbot>"
REQUESTER_BOT_WEBHOOK_KEY_HEADER="Authorization"
REQUESTER_BOT_WEBHOOK_KEY="Bearer <key from grokbot>"
```

**3. Create the label**: repo → Issues → Labels → New label, name `pending/requester-bot`. (A project set up with `setup.sh` gets it automatically when the setting is present.)

**4. Agree on grokbot's side of the protocol:**

1. To file a request, open an issue whose body ends with the marker `<!-- requested-by-grokbot -->` and add `pending/agent`
2. On a webhook call (or its own periodic scan): pull every issue / PR carrying `pending/requester-bot`, **closed ones included**; read the thread, take the latest comment to the requester, and comment on the issue saying whom it went to
3. On an answer: paste it back **verbatim** → remove `pending/requester-bot` → add `pending/agent` so the agent continues (with `DISPATCH_MODE=greedy` this last step is optional — removing the waiting label is enough)
4. On a comment headed "request done" / "closed without merging": tell the requester, then remove `pending/requester-bot`; the request is finished
5. Ignore items carrying `pending/human`: those are for the maintainer

**5. Check it works**: once grokbot files a request and the agent posts a proposal, the issue should show `pending/requester-bot`, and `poll.log` should contain `notify-requester-bot #<number>: ✅ 已叫醒 grokbot` followed by `已通知 webhook（HTTP 200）`. After the PR merges, the issue should get a "request done" comment and carry `pending/requester-bot` again, with `issue #<number>：已通知 webhook（HTTP 200）` in `poll.log`. If you see `pending/human` plus a "wake-up failed, handed to the maintainer" comment instead, read the script output quoted there (common cause: the worker account cannot edit labels). A `webhook 通知失败` / `跳过` line means the label is still in place and grokbot will see it on its next periodic scan; fix the config per the reason on that line.

**Rollback**: clear these settings; remove the waiting label by hand from any item still carrying it. To stop only the webhook and keep the waiting label, clear `REQUESTER_BOT_WEBHOOK_URL`.

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
