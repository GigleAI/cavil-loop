#!/usr/bin/env bash
# 重测试排队与遗留测试清理的公共判断（GitHub#343）。
#
# scripts/heavy-test.sh（worker 在会话里跑，不加载项目配置）和 _lib.sh（daemon 的派工、清理、
# 每轮检查）都 source 这一份：分组状态怎么读、条目代数怎么读、「起这套测试的 worker 还在不在」
# 怎么判，只写在这里。只定义函数，不做任何 I/O。
#
# 三条规则贯穿所有函数：
#   - 只认明确的状态词。查询失败、空输出、不认识的词一律是「不知道」（unknown），
#     调用方拿到 unknown 时不删记录、不放行、不停进程、不删工作树。
#   - 「分组不存在」才算这次运行结束：运行记录只能由已经在自己分组里的进程写，所以有记录
#     就一定有过分组；分组没了 = 这次运行一个进程都不剩，也不会再启动。
#   - 进程身份 = 进程号 + 启动时间。只比进程号会把复用了同一个号的别的进程当成原来那个。

# ── Heavy tests one at a time, and stopping an item's tests when it ends: rules moved from the root AGENTS.md (GitHub#658); read before changing ──
# Heavy tests one at a time, and stopping an item's tests when it ends (GitHub#343:
# `HEAVY_TEST_COMMANDS`; `scripts/heavy-test.sh` — the queue wrapper a worker runs in its session;
# `scripts/_heavy.sh` — the one implementation of "scope state", "item generation" and "is the worker
# that started this test still there", sourced by both the wrapper and `_lib.sh`; `heavy_*` /
# `item_lock_reexec` in `_lib.sh`; the item lock at the top of the three dispatch scripts and
# `cleanup-issue.sh`; step 0c in `agent-poll.sh`; `prompts/heavy-test.md`; the commands in
# `docs/operations{,.zh}.md` behind `<!-- heavy-test-ops:begin -->`) → `tests/heavy-test.test.sh`
# (~2.5 min; the real wrapper, the real dispatch / cleanup scripts, real tmux on a private socket, a
# stand-in for systemd) plus `tests/heavy-test-systemd.test.sh` (~20 s; real `systemd-run --user
# --scope`, not in CI). The next run is let through when the previous run's scope is empty, not by who
# holds a lock: a run record can only be written by a process already inside its own scope, so "scope
# not found" proves that run will never start; the command under test inherits no lock descriptor.
# Scope state is read from explicit words only — a failed query, empty output or an unknown word
# counts as still running (no record removed, nothing let through, nothing stopped, no worktree
# removed). Dispatch and cleanup each re-run themselves under the item lock (`flock -o`: the flock
# process holds the lock and does not pass the descriptor on — otherwise it leaks through a freshly
# started tmux server into the worker, and the lock is held for as long as the worker lives); cleanup
# bumps the item's generation as soon as it holds the lock, and the wrapper checks the generation and
# writes its record under the same lock (shared), so the two cannot interleave. Lock order is fixed:
# poll lock → item lock, queue lock → item lock; dispatch and cleanup never take the queue lock. The
# stand-in only checks decisions; "a process cannot leave its scope, the whole scope is stopped,
# nothing outside it is touched" is checked only in the real-systemd file; both files run the doc
# commands verbatim (including with another item already holding the queue: a run to stop is always
# named by its id, `--id-file` hands a run its own id, never pick one out of the account-wide list),
# and the two doc copies must be identical. "This machine cannot use scopes" must be a fact visible on
# the spot (not Linux / not cgroup v2 / no binaries / no user-manager socket); a user manager that
# exists but did not answer this time is "unknown" — exit 70, no degrading (the degraded mode cannot
# see existing scopes). Scopes are stopped only through `heavy_stop_unit`, which re-reads the state
# itself right before stopping and sends nothing when that read fails. Run records are read only
# through `heavy_run_load` (read / file already gone / unreadable or unrecognised — three outcomes;
# each of the ten fields is checked for "is this line there", and a missing line is not an empty value
# — the ownership fields statedir / item / gen are either all present, or all explicitly empty for a
# hand-run; the field table sits above that function in `_heavy.sh`; the wrapper reads its own record
# back through the same function after writing it, and refuses to run when the environment carries
# only part of an ownership): an unreadable record must never be filtered out as "queued" or "not this
# project's" — the scope name follows from the file name, the record is removed only once that scope
# is confirmed gone, and until then it blocks the queue and worktree removal and is not stopped; never
# judge a run record from `heavy_field`'s empty string again. A launch record is written before the
# worker starts (pid pending), only marked — never deleted — once the launch is confirmed ended, and
# removed at item cleanup: the wrapper lets nothing through for a launch id with no record, so
# deleting the record would let a late request from an ended worker start again. With
# `HEAVY_TEST_COMMANDS` unset the prompts, the GitHub calls and the files in the state directory equal
# the merge-base scripts' (the test diffs them)
#

# 运行记录里取一个字段。记录是「键=值」逐行，值不换行。文件不在 / 读不到 → 空。
heavy_field() {   # <记录文件> <键>
    local line
    while IFS= read -r line; do
        case "$line" in "$2="*) printf '%s' "${line#"$2="}"; return 0 ;; esac
    done 2>/dev/null < "$1" || true
    return 0
}

# 读一条运行记录。运行记录的每一个消费者（排队、列表、清理、每轮检查）都只通过它读，不各自拿
# heavy_field 的空字符串去猜——空字符串分不出「这个字段写的就是空」和「文件读不到 / 这一行没有」。
#
#   返回 0  读到了，而且十个字段一个不缺、各自的值都合规：HR_STATE、HR_UNIT、HR_STATEDIR、HR_PROJECT、
#           HR_ITEM、HR_GEN、HR_LAUNCH、HR_PID、HR_SINCE、HR_CMD 已填好
#   返回 1  文件已经不在了（别人刚删掉）——这条运行已经了结，跳过即可
#   返回 2  文件在，但读不到、缺字段、字段重复、或值不合规。**不能**当成「不在跑」「不是我的」「手动
#           运行」：调用方按文件名推出分组名（heavy_unit_name）去查分组，只有分组确认消失才能删这条
#           记录；分组还在或查不清时，它挡着排队、挡着删工作树，也不会被停。
#
# 字段表（写的一方是 heavy-test.sh 的 write_record，十行每次都写全；这里逐行核对「这一行在不在」）：
#
#   字段      谁靠它做什么                           允许写成空吗
#   state     排队：只有 running 挡人                不允许；只认 queued / running
#   unit      所有人：停 / 查的是哪个分组            不允许；必须等于按文件名推出的分组名
#   statedir  清理、每轮检查：是不是本项目的         只有「手动运行」可以空（见下）；否则必须是绝对路径
#   item      清理：是不是这个条目的                 只有「手动运行」可以空；否则是数字
#   gen       （排队命令自己核对代数，记录里留底）   只有「手动运行」可以空；否则是数字
#   launch    每轮检查：起它的 worker 结束没有       可以空（派工时没拿到启动编号）；否则 32 位十六进制，
#                                                    而且只能出现在有条目归属的记录里
#   project   只用于显示                             可以空
#   pid       只用于测试和排查                       不允许；数字
#   since     只用于显示                             不允许；数字
#   cmd       只用于显示                             可以空，但这一行必须在
#
# 「手动运行」= statedir、item、gen、launch 四行都在、而且都**明确写成空**。归属三项（statedir、item、gen）
# 要么全有要么全空：只有一部分、或者哪一行干脆没有，都是返回 2——缺了归属的记录不能被推断成手动运行，
# 也不能被推断成别的项目的。
heavy_run_load() {   # <记录文件>
    local f="$1" content line k v seen=" "
    HR_STATE=""; HR_UNIT=""; HR_STATEDIR=""; HR_PROJECT=""; HR_ITEM=""; HR_GEN=""
    HR_LAUNCH=""; HR_PID=""; HR_SINCE=""; HR_CMD=""
    if ! content="$(cat "$f" 2>/dev/null)"; then
        if [ -e "$f" ] || [ -L "$f" ]; then return 2; fi
        return 1
    fi
    while IFS= read -r line; do
        case "$line" in *=*) ;; *) [ -z "$line" ] && continue; return 2 ;; esac
        k="${line%%=*}"; v="${line#*=}"
        case "$k" in
            state|unit|statedir|project|item|gen|launch|pid|since|cmd) ;;
            *) continue ;;      # 以后新加的字段：不认识的行不算错
        esac
        case "$seen" in *" $k "*) return 2 ;; esac      # 同一个字段出现两次：不知道该信哪个
        seen="$seen$k "
        case "$k" in
            state) HR_STATE="$v" ;;
            unit) HR_UNIT="$v" ;;
            statedir) HR_STATEDIR="$v" ;;
            project) HR_PROJECT="$v" ;;
            item) HR_ITEM="$v" ;;
            gen) HR_GEN="$v" ;;
            launch) HR_LAUNCH="$v" ;;
            pid) HR_PID="$v" ;;
            since) HR_SINCE="$v" ;;
            cmd) HR_CMD="$v" ;;
        esac
    done <<<"$content"
    for k in state unit statedir project item gen launch pid since cmd; do
        case "$seen" in *" $k "*) ;; *) return 2 ;; esac     # 这一行没有：不是「空」，是「不知道」
    done
    case "$HR_STATE" in queued|running) ;; *) return 2 ;; esac
    [ "$HR_UNIT" = "$(heavy_unit_name "${f##*/}")" ] || return 2
    [[ "$HR_PID" =~ ^[0-9]+$ && "$HR_SINCE" =~ ^[0-9]+$ ]] || return 2
    if [ -z "$HR_STATEDIR" ] && [ -z "$HR_ITEM" ] && [ -z "$HR_GEN" ]; then
        [ -z "$HR_LAUNCH" ] || return 2                      # 手动运行不会有 worker 启动编号
    else
        [[ "$HR_STATEDIR" == /* && "$HR_ITEM" =~ ^[0-9]+$ && "$HR_GEN" =~ ^[0-9]+$ ]] || return 2
        [[ -z "$HR_LAUNCH" || "$HR_LAUNCH" =~ ^[0-9a-f]{32}$ ]] || return 2
    fi
    return 0
}

# 运行记录文件名就是运行编号：32 位十六进制。目录里别的东西（写到一半的临时文件）不算记录。
heavy_is_run_id() { [[ "$1" =~ ^[0-9a-f]{32}$ ]]; }

heavy_unit_name() { printf 'cavil-heavy-%s.scope' "$1"; }

# 分组现在的状态：gone（不存在 / 已停止）｜active（还有进程）｜unknown。
heavy_scope_state() {   # <分组名>
    local out load="" active="" line
    if ! out="$(systemctl --user show "$1" -p LoadState -p ActiveState 2>/dev/null)"; then
        echo unknown; return 0
    fi
    while IFS= read -r line; do
        case "$line" in
            LoadState=*) load="${line#LoadState=}" ;;
            ActiveState=*) active="${line#ActiveState=}" ;;
        esac
    done <<<"$out"
    case "$load" in
        not-found) echo gone; return 0 ;;
        loaded) ;;
        *) echo unknown; return 0 ;;
    esac
    case "$active" in
        inactive|failed) echo gone ;;
        active|activating|deactivating|reloading) echo active ;;
        *) echo unknown ;;
    esac
}

# 停一个分组并确认它消失。返回 0 = 已确认消失；非 0 = 没停掉或查不清（调用方按「还在跑」处理）。
# 停之前在这里再读一次状态，只有读到明确的「运行中」才发停止请求：调用方先前读到过什么不算数，
# 这一次读不出来（unknown）就什么都不发、直接返回非 0。所有要停分组的地方都走这一个函数。
heavy_stop_unit() {   # <分组名> [最多等几秒，默认 30]
    local unit="$1" wait_secs="${2:-30}" i st
    st="$(heavy_scope_state "$unit")"
    case "$st" in
        gone) return 0 ;;
        active) ;;
        *) return 1 ;;
    esac
    systemctl --user stop "$unit" >/dev/null 2>&1 || true
    for ((i = 0; i < wait_secs * 5; i++)); do
        st="$(heavy_scope_state "$unit")"
        [ "$st" != gone ] || return 0
        sleep 0.2
    done
    return 1
}

# 进程的启动时间（/proc/<pid>/stat 第 22 项，开机以来的时钟滴答数）。读不到 → 非 0。
heavy_proc_start() {   # <pid>
    local stat rest
    stat="$(cat "/proc/$1/stat" 2>/dev/null)" || return 1
    rest="${stat##*) }"            # 进程名可以含空格和括号，从最后一个 ") " 之后数
    # shellcheck disable=SC2086
    set -- $rest
    [[ "${20:-}" =~ ^[0-9]+$ ]] || return 1
    printf '%s' "${20}"
}

heavy_launch_file() { printf '%s/worker-launch/%s' "$1" "$2"; }

# 起这套测试的那次 worker 启动现在怎样：
#   alive        启动记录里的进程还在，而且还是同一个进程
#   ended        那个进程号已不存在，或现在是启动时间不同的另一个进程，或记录上已经盖了「已结束」
#   unidentified 派工登记了这次启动，但没读到 worker 的进程号（刚起、或读窗格失败）——无从判断它
#                在不在：它的测试可以跑，但不会被「worker 已结束」这条规则停掉
#   none         没有这次启动的记录。派工在起 worker **之前**就写下记录，已结束的记录也只盖章不删，
#                所以正常情况下不会出现；出现了就是来历不明，调用方不放行
#   unknown      记录读不出来 / 格式不对 / 读不到进程信息
# 「已结束」是不可逆的：一旦确认过，heavy_launch_mark_ended 在记录上盖章，之后不再看进程号——
# 进程号被复用、记录被整理，都不会让一次已经结束的启动重新变回「还在」或「没记录」。
heavy_launch_state() {   # <项目状态目录> <启动编号>
    local sdir="$1" id="$2" f pid start cur
    [[ "$id" =~ ^[0-9a-f]{32}$ ]] || { echo unknown; return 0; }
    [ -d "$sdir" ] && [ -r /proc/self/stat ] || { echo unknown; return 0; }
    f="$(heavy_launch_file "$sdir" "$id")"
    if [ ! -e "$f" ]; then echo none; return 0; fi
    [ -r "$f" ] || { echo unknown; return 0; }
    if [ "$(heavy_field "$f" ended)" = 1 ]; then echo ended; return 0; fi
    pid="$(heavy_field "$f" pid)"; start="$(heavy_field "$f" start)"
    if [ "$pid" = pending ]; then echo unidentified; return 0; fi
    [[ "$pid" =~ ^[0-9]+$ && "$start" =~ ^[0-9]+$ ]] || { echo unknown; return 0; }
    if [ ! -d "/proc/$pid" ]; then echo ended; return 0; fi
    if ! cur="$(heavy_proc_start "$pid")"; then
        # 读的那一瞬间它退出了：再看一次目录，没了才算结束
        if [ ! -d "/proc/$pid" ]; then echo ended; else echo unknown; fi
        return 0
    fi
    if [ "$cur" = "$start" ]; then echo alive; else echo ended; fi
}

# 在一份启动记录上盖「已结束」。只在 heavy_launch_state 刚返回 ended 之后调。
heavy_launch_mark_ended() {   # <项目状态目录> <启动编号>
    local f
    f="$(heavy_launch_file "$1" "$2")"
    [ -f "$f" ] || return 0
    [ "$(heavy_field "$f" ended)" = 1 ] || printf 'ended=1\n' >> "$f" 2>/dev/null || true
}

heavy_item_lock_path() { printf '%s/item-locks/%s.lock' "$1" "$2"; }
heavy_gen_file() { printf '%s/item-gen/%s' "$1" "$2"; }

# 条目现在是第几代：每清理一次加一，没清理过 = 0。读不出来 → 返回 2、不输出。
heavy_gen_read() {   # <项目状态目录> <条目号>
    local f g
    [ -d "$1" ] || return 2
    f="$(heavy_gen_file "$1" "$2")"
    if [ ! -e "$f" ]; then printf '0'; return 0; fi
    g="$(cat "$f" 2>/dev/null)" || return 2
    [[ "$g" =~ ^[0-9]+$ ]] || return 2
    printf '%s' "$g"
}
