# Hooking up an external requester bot: grokbot as the example

> **English** · [中文](requester-bot.zh.md)

Some projects let another AI assistant file requests directly — below, the "requester bot" — acting for the people it serves (the "requester"). The bot opens issues in a repo running cavil-loop and cavil-loop handles them as usual. Whenever a request **has a question the requester must answer**, or **is finished**, the result goes back to the bot, which brings back the answer or passes the result on. That closes the loop between the bot and cavil-loop.

The first half of this guide is a step-by-step integration, using [`grokbot`](https://github.com/grokbot) as the example (any other bot differs only in the name); the second half is reference.

**Off by default.** Everything is switched on through config, and neither the code nor the config template names any particular bot (GitHub#95 / #97 / #100).

- [How one request closes the loop](#how-one-request-closes-the-loop)
- [What you need first](#what-you-need-first)
- [Integration steps](#integration-steps)
- [What grokbot has to do on its side](#what-grokbot-has-to-do-on-its-side)
- [One request end to end: what you see on the issue](#one-request-end-to-end-what-you-see-on-the-issue)
- [Troubleshooting](#troubleshooting)
- [Pausing and rolling back](#pausing-and-rolling-back)
- [Reference](#reference)

## How one request closes the loop

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


## What you need first

| Who | Needs |
|---|---|
| You (maintainer) | A repo already connected to cavil-loop; the GitHub account workers / reviewers comment with (the "worker account" below), able to edit this repo's labels |
| grokbot | Able to open issues, comment and edit labels in this repo (step 1 grants it), and to read issue / PR comments and labels |
| grokbot (optional) | A webhook URL that accepts an HTTPS POST, plus a key. Works without it: only the waiting label is set and grokbot finds it on its own periodic scan, just later |

## Integration steps

### 1. Give grokbot a role that can edit labels

Work starts on the `pending/agent` label, which only people with the right repo permission can add — that is what stops strangers from putting the agent to work, and this feature does not change it. The lowest GitHub repo role that can edit labels is **Triage**: it manages labels and cannot change code.

- Repo → Settings → Collaborators and teams → Add people → `grokbot` → role **Triage** → send the invite; grokbot accepts it
- To pause grokbot, remove it on the same page

### 2. Fill in the config

Add to the project's `cavil-loop.config` (use your own worker account):

```bash
LABEL_PENDING_REQUESTER_BOT="pending/requester-bot"
REQUESTER_BOT_ACCOUNT="grokbot"
REQUESTER_BOT_ALLOWED_ACTORS="your-worker-bot"          # the account workers / reviewers comment with
REQUESTER_BOT_ORIGIN_MARKER="<!-- requested-by-grokbot -->"
REQUESTER_BOT_REPORT_FIRST="true"                       # report to grokbot first, maintainer merges after approval
# webhook (URL and key from grokbot's side)
REQUESTER_BOT_WEBHOOK_URL="https://<url from grokbot>"
REQUESTER_BOT_WEBHOOK_KEY_HEADER="Authorization"
REQUESTER_BOT_WEBHOOK_KEY="Bearer <key from grokbot>"
```

What each setting means: [Reference → Config](#config). The feature is on only when the first four are all set; the three webhook settings can wait.

### 3. Lock down the config file

The file holds the webhook key and must be readable by you only, or the webhook is never sent (`poll.log` gets a "permissions too wide" line):

```bash
chmod 600 <project dir>/cavil-loop.config
```

### 4. Create the waiting label

Repo → Issues → Labels → New label, name `pending/requester-bot`. (A project set up with `setup.sh` gets it automatically when the setting is present.)

No restart needed after editing the config: every poll tick reads it afresh.

### 5. Agree on grokbot's side

Hand the next section, [What grokbot has to do on its side](#what-grokbot-has-to-do-on-its-side), to whoever runs grokbot and have it implemented as written.

### 6. Check it works

Have grokbot file a test request, then check in order:

1. Once the agent posts its proposal, the issue shows `pending/requester-bot`; `poll.log` contains `notify-requester-bot #<number>: ✅ 已叫醒 grokbot` followed by `已通知 webhook（HTTP 200）`
2. grokbot comments on the item carrying the waiting label saying whom it sent it to, later pastes the answer back verbatim on that same item, removes `pending/requester-bot` and adds `pending/agent`; on the next tick the agent carries on
3. After the PR merges, the issue gets a "request done" comment and carries `pending/requester-bot` again, with `issue #<number>：已通知 webhook（HTTP 200）` in `poll.log`

If any step does not match, see [Troubleshooting](#troubleshooting).

## What grokbot has to do on its side

cavil-loop only handles its own side; grokbot implements the following:

1. **Filing a request**: open an issue whose body ends with the marker `<!-- requested-by-grokbot -->`, and add `pending/agent`. Only an issue authored by grokbot **and** carrying the marker counts as its request — missing either, cavil-loop treats it as an ordinary issue and questions go to the maintainer only
2. **On a webhook call, or its own periodic scan**: pull **every** issue / PR carrying `pending/requester-bot`, **closed ones included**. The webhook body is only a hint; always pull everything rather than acting on the body (format: [Reference → The webhook call](#the-webhook-call))
3. **Passing it on**: read the thread, take the latest comment to the requester, then comment **on the item carrying the waiting label** saying whom it went to — the issue for a proposal or question, the PR for a result report on that PR. That comment is the only thing the agent accepts as proof the requester was told
4. **Bringing the answer back**: on that same **issue or PR carrying the waiting label**, paste the answer **verbatim** → remove its `pending/requester-bot` → add `pending/agent` to it so the agent continues (with `DISPATCH_MODE=greedy` this last step is optional — removing the waiting label is enough). **Never post a PR's answer on the source issue**: the daemon dispatches each item by its own labels, so that redispatches the issue while the waiting PR stays parked. When approving a report, the answer must say so clearly; the agent also checks that the approved report names the PR's current head commit, and asks again if not
5. **On a comment headed "request done" / "closed without merging"** (the daemon posts it on the source issue): tell the requester, then remove `pending/requester-bot`; the request is finished
6. **Leave items carrying `pending/human` alone**: those are for the maintainer
7. **Attachments**: images etc. from the requester can be pasted into the issue and the agent downloads them itself; the other direction (agent sending attachments to grokbot) is not supported yet

## One request end to end: what you see on the issue

With `REQUESTER_BOT_REPORT_FIRST="true"`:

| Step | Who | Labels | New comment |
|---|---|---|---|
| 1. File the request | grokbot | issue `pending/agent` | issue body carrying the marker |
| 2. Dispatch | daemon | issue `doing/agent` | — |
| 3. Proposal | agent | issue `pending/requester-bot` (with design review on, `pending/review` first, switched to it once review passes) | design proposal |
| 4. Pass on, bring the answer back | grokbot | issue `pending/agent` | on the issue: "sent to X"; the verbatim answer |
| 5. Build, open PR | agent | issue `pending/PR`; the PR is reviewed first if the review gate is on | the PR |
| 6. Report the result | agent / reviewer | PR `pending/requester-bot` | result report (names the commit) |
| 7. Requester approves | grokbot | PR `pending/agent` | on the PR (not the source issue): "sent to X"; the verbatim approval |
| 8. Hand to the maintainer | agent | PR `pending/human` | handoff comment |
| 9. Merge | maintainer | PR `Done`; issue gets `pending/requester-bot` | daemon posts "request done" |
| 10. Wrap up | grokbot | removes `pending/requester-bot` from the issue | — |

With `REQUESTER_BOT_REPORT_FIRST="false"` steps 6 and 7 do not happen: finished work goes straight to the maintainer, and steps 9 and 10 still follow the merge.

## Troubleshooting

| You see | Cause / fix |
|---|---|
| The item has `pending/human` and a "wake-up failed, handed to the maintainer" comment | Read the script output quoted in it; common cause: the worker account cannot edit labels |
| The proposal went straight to the maintainer and grokbot was not woken | A wake-up pre-check refused: the issue author is not `REQUESTER_BOT_ACCOUNT`, the body lacks the marker, the item carries `pending/human`, or a maintainer added `pending/human` by hand and has not lifted it since (to resume: the maintainer removes it and re-adds `pending/agent`) |
| `webhook 通知失败（…）` in `poll.log` | The label is still in place and grokbot sees it on its next periodic scan; check grokbot's side per the reason in brackets (HTTP status / timeout / connection failed) |
| `webhook 配置不完整，跳过` | Header name or key empty, header name has characters other than letters / digits / `-`, or a newline in the URL / key |
| `配置文件权限过宽（应为 600），webhook 跳过` | Do step 3 |
| `找不到 curl，webhook 跳过` | Install curl |
| grokbot never got "request done" after a merge | Post-merge cleanup is off (`AUTO_CLEANUP_ON_MERGE`); or, for a PR closed unmerged, the same request still has another PR open (no notice then); or the write identity is not in `REQUESTER_BOT_ALLOWED_ACTORS` — `poll.log` says which |

Wake-up script exit codes: [Reference → The wake-up script](#the-wake-up-script).

## Pausing and rolling back

- **Stop grokbot filing requests**: remove it under repo Settings → Collaborators and teams
- **Stop only the webhook, keep the waiting label**: clear `REQUESTER_BOT_WEBHOOK_URL`
- **Turn it all off**: clear these settings and remove the waiting label by hand from any item still carrying it. With them cleared, dispatching, prompts and post-merge handling are as if it had never been on

## Reference

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
- no hand-added `pending/human` by a maintainer is still in effect. "Maintainer" = an account that is neither in the allowed list nor the bot. Events are sorted by id and only what follows the maintainer's latest hand-added `pending/human` counts: if a maintainer later removes it or adds a dispatch label (`pending/agent` and its variants, `pending/review`), the pause is lifted; a removal by the bot / worker account, or by an account that can no longer be read, does not count. Unreadable label history, or events without an id → refuse (GitHub#106)

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

- **Wake the bot**: proposals / revised proposals the requester has to confirm (when the proposal must go through review first — the project turned on design review, or its own extra rules say so — the reviewer wakes the bot when the proposal passes review; otherwise the worker wakes it right after posting the proposal); product questions for the requester during implementation; result reports (when `REQUESTER_BOT_REPORT_FIRST=true`). The merge / close result is sent by the daemon; workers need not do anything
- **Still maintainer only**: maintainer already took over, suspicious content, red tests needing a call, unresolvable conflicts, review cap reached, permissions / local config / credentials / database grants
- **Evidence rules**: "requester notified" counts only on the bot's "sent to X" comment after the report; "approved" counts only when the bot's verbatim answer clearly approves **and** the approved report names the PR's current head commit. Approved → hand to the maintainer for merge; changes requested → fix, re-review, report again; ambiguous → ask again
- Attachments the bot pastes into the issue (images etc.) are downloaded with the agent's own token

Not included: the agent *sending* attachments to the bot (GitHub has no programmatic comment-attachment upload); a separate issue later.
