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

# 运行记录里取一个字段。记录是「键=值」逐行，值不换行。文件不在 / 读不到 → 空。
heavy_field() {   # <记录文件> <键>
    local line
    while IFS= read -r line; do
        case "$line" in "$2="*) printf '%s' "${line#"$2="}"; return 0 ;; esac
    done 2>/dev/null < "$1" || true
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
