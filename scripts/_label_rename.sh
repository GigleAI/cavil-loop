#!/usr/bin/env bash
# 流程标签改名（GitHub#569）的共用规则：哪些设置能改名、新名字能写成什么、记录文件在哪。
# _lib.sh（daemon 各入口、scripts/label-rename.sh）和 scripts/project-config.sh 都 source 这一份，
# 不各写一套。只定义，不执行任何东西。

# ── Renaming a flow label: rules moved from the root AGENTS.md (GitHub#658); read before changing ──
# Renaming a flow label (GitHub#569: `scripts/label-rename.sh`, `scripts/_label_rename.sh`, the config
# snapshot load and `label_rename_gate` / `poll_lock_enter` / `poll_lock_reexec` / `label_watch_check`
# in `_lib.sh`, the gate right after the poll lock in `agent-poll.sh`, `stuck-release.sh` and a
# hand-run `ci-failure-report.sh`, `poll_lock_enter` at the top of the three dispatch scripts and
# `notify-requester-bot.sh`, `project-config.sh set --label-rename` and the `rename` / `label_rename`
# fields of `get`, the commands in `docs/operations{,.zh}.md` behind `<!-- label-rename-ops:begin
# -->`) → `tests/label-rename.test.sh` (~1 min; real scripts against the stateful fake GitHub, whose
# `label_ids.json` / `PATCH labels/<name>` / `Fhold_patch_label` serve labels with ids and hold a
# rename back to land late; a fake `flock` changes the config at the moment the poller takes its
# lock). Three rules. **The gate fingerprints every file the config load ran commands from, and never
# loads the config again** (`CONFIG_SRC_LIST` / `CONFIG_SRC_FPS` / `cfg_src_fps` in `_lib.sh`): each
# file is hashed **before** bash reads it (the main config before the one `source "$CONFIG_FILE"`; a
# sourced file when the DEBUG trap first fires inside it, i.e. after bash read the whole file and
# before its first command — never by wrapping `source` / `.` in a function, which changes the sourced
# file's `$1…` and makes its `declare`s local, re-review round 2) and again right after the load — a
# difference means it was replaced mid-load and the fingerprints are void (PR #571 re-review round 1:
# hashing only after the load paired old values with the new file); the load also runs under a DEBUG
# trap with `set -T` on, and every file that ran a command must have a pre-read hash; a config that
# replaces / clears the DEBUG trap or turns functrace off during the load blinds this, so the
# fingerprints are void and the gate refuses (`CONFIG_SRC_BLIND`, re-review round 3) — checked on
# every firing of the trap, not only at the end, so turning it off and on again is caught too (`$-`
# lacks `T`, or the next command is a literal `trap … DEBUG`; re-review round 4); files sourced in a
# subshell report back through a per-load `mkdir`'d temp dir (no temp dir = refuse). After four rounds
# of variants the maintainer chose (PR #571 Q1 = B) to keep this design and accept the remaining gap:
# a trap command built from a variable or alias is not recognised, and the gate under the poll lock
# hashes them again — any difference or unreadable file refuses. Four earlier designs failed review on
# PR #571: loading from a temporary copy broke `${BASH_SOURCE[0]}` (round 3), fingerprinting the main
# file missed a sourced file (round 4), loading the config again under the lock re-ran its commands
# and tripped over `readonly` labels (round 5), a counter moved only by this tool's own saves missed
# hand edits (round 6). Stated limit: files read another way (`$(cat …)`) and a conditionally sourced
# file that appears later are not seen; every entry that reads the config and later writes labels
# passes `label_rename_gate` once it holds the poll lock (the poller and its children through the
# poller; hand-run entries re-run themselves under `flock -o` on the poll lock first, so neither the
# lock nor its fd reaches a tmux server). "Am I under the poller's lock" is
# `CAVIL_POLL_LOCK_HELD=<state dir>|<pid>`, believed only when that pid is an ancestor of the current
# process (so a copy inherited by a tmux server, which has left its parent, counts for nothing, and a
# script in the lock that calls another entry script — the comment dispatcher falling back to the
# new-issue one — is still recognised) — a new entry point that writes labels goes through
# `poll_lock_enter`. **A rename request with no answer is never "not renamed"**: the project stays
# paused, there is no undo, only `continue` (reads) and `resend`; when it finishes, `label-watch.json`
# makes every round check the label by its fixed id until a person runs `watch-end` — that check is
# part of `label_rename_gate`, so every hand-run entry makes it too (PR #571 code review round 1: the
# manual entries skipped it). **The pause record is removed only by `finish` / `undo` / `abandon
# --yes`**, and `finish` re-reads GitHub (by id) and the config first. The desktop client's side
# (rename / follow dialogs, per-repository label names) is in `client/`. Keep the two doc copies
# identical
#

# 能改名的流程标签：一个设置一个名字的那几项（「也算派工的标签」这类逗号列表不在里面）
LABEL_RENAME_FIELDS="LABEL_PENDING_AGENT LABEL_PENDING_AGENT_FABLE LABEL_AGENT_DOING LABEL_PENDING_HUMAN LABEL_PENDING_PR LABEL_DONE LABEL_PENDING_REVIEW LABEL_AUTOPILOT LABEL_PENDING_MERGE LABEL_PENDING_BLOCKED LABEL_PENDING_LATER LABEL_PENDING_REQUESTER_BOT"
# 按标签历史判断的几项：有打开的条目挂着时不让改名（GitHub 的事件记录改名后记哪个名字没实测）
LABEL_RENAME_HISTORY_FIELDS="LABEL_AUTOPILOT LABEL_PENDING_MERGE LABEL_PENDING_BLOCKED LABEL_PENDING_REQUESTER_BOT"
# 配置里会写标签名的其他设置：改名前确认它们没用到新旧两个名字（逗号列表按元素比）
LABEL_RENAME_LIST_FIELDS="LABEL_PENDING_AGENT_EXTRA GREEDY_SKIP_LABELS PRIORITY_LABELS"

label_rename_field_ok() {   # <设置名>
    case " $LABEL_RENAME_FIELDS " in *" $1 "*) return 0 ;; esac
    return 1
}
# 新名字：字母、数字和 . _ : / @ + -，1–50 个字符。GitHub 上限 50；配置那一行能原样写下的字符本来就只有
# 这些（project-config.sh 的 LIT_CHARS），再去掉逗号——逗号在列表类设置里是分隔符
label_rename_name_ok() {   # <名字>
    [ "${#1}" -ge 1 ] && [ "${#1}" -le 50 ] && [[ "$1" =~ ^[A-Za-z0-9._:/@+-]+$ ]]
}
label_rename_record_path() { printf '%s/label-rename.json\n' "$1"; }   # <状态目录>
label_watch_path() { printf '%s/label-watch.json\n' "$1"; }            # <状态目录>

