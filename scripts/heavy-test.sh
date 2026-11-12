#!/usr/bin/env bash
# 重测试排队（GitHub#343）：同一个系统账号下，同一时间只放行一套「重测试」。
#
# 用法：
#   bash scripts/heavy-test.sh -- <命令…>     排队 → 轮到了再跑 → 原样返回命令的退出码
#   bash scripts/heavy-test.sh --list         列出登记着的运行（谁在排队、谁在跑）
#   bash scripts/heavy-test.sh --stop <编号>  停掉一套（--list 第一列的编号）
#
# 怎么保证不重叠（Linux + cgroup v2 + systemd 用户实例）：
#   1. 外层先用 systemd-run --user --scope 给这次运行建一个进程分组，自己的内层进到分组里；
#   2. 内层确认自己在分组里之后才登记（排队中），所以「有记录」一定意味着「分组存在过」；
#   3. 拿到排队锁后，把所有「运行中」记录的分组逐个查一遍，全部确认消失才启动；
#   4. 测试结束后内层把自己的分组整个停掉——留下的后台子进程一起结束。
# 放行依据是「分组空了」，不是「谁还拿着锁」：包装命令被强杀、被测程序关掉继承来的文件、
# 子进程脱离进程组，都逃不出分组，分组不空就不放行。
#
# 条目归属：worker 的环境里带着 CAVIL_HEAVY_ITEM / _GEN / _LAUNCH / _STATE_DIR（派工时给的）。
# 登记和启动前各核对一次「条目的代数没变、起我的那个 worker 还在」，核对和写记录在条目锁里做，
# 和 cleanup-issue.sh 的「代数加一 + 停本条目的分组 + 删工作树」互斥。人手动跑（没有这些变量）
# 跳过条目核对，只排队。
#
# 其余环境（macOS、没有 systemd 用户实例）：只排队包装命令本身，不建分组、不登记、不清理。
set -euo pipefail

SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(dirname "$SELF")"
# shellcheck source=_names.sh
source "$SCRIPT_DIR/_names.sh"
# shellcheck source=_heavy.sh
source "$SCRIPT_DIR/_heavy.sh"

RUNS="$CAVIL_HEAVY_TEST_RUNS"
QUEUE_LOCK="$CAVIL_HEAVY_TEST_LOCK"
RC_DIR="$CAVIL_STATE_HOME/heavy-test/rc"
WAIT_LIMIT="${CAVIL_HEAVY_LOCK_WAIT:-0}"
[[ "$WAIT_LIMIT" =~ ^[0-9]+$ ]] || WAIT_LIMIT=0
PRINT_EVERY="${CAVIL_HEAVY_PRINT_SECS:-30}"
[[ "$PRINT_EVERY" =~ ^[1-9][0-9]*$ ]] || PRINT_EVERY=30

say() { printf '[heavy-test] %s\n' "$*" >&2; }

usage() {
    cat >&2 <<'EOF'
用法：
  heavy-test.sh -- <命令…>      排队跑一套重测试
  heavy-test.sh --list          列出登记着的运行
  heavy-test.sh --stop <编号>   停掉一套
EOF
    exit 2
}

fmt_age() {   # <开始的秒数>
    local s=$(( $(date +%s) - $1 ))
    [ "$s" -ge 0 ] || s=0
    if [ "$s" -ge 60 ]; then printf '%d 分 %d 秒' $((s / 60)) $((s % 60)); else printf '%d 秒' "$s"; fi
}

describe_run() {   # <记录文件> → 「项目 #条目（命令）」
    local f="$1" project item cmd
    project="$(heavy_field "$f" project)"; item="$(heavy_field "$f" item)"; cmd="$(heavy_field "$f" cmd)"
    printf '%s%s（%s）' "${project:-手动运行}" "${item:+ #$item}" "$cmd"
}

# ── 查看 / 手动停 ──
cmd_list() {
    local f id n=0 since
    for f in "$RUNS"/*; do
        [ -f "$f" ] || continue
        id="${f##*/}"; heavy_is_run_id "$id" || continue
        since="$(heavy_field "$f" since)"
        [[ "$since" =~ ^[0-9]+$ ]] || since="$(date +%s)"
        printf '%s  %s  分组:%s  %s  已 %s\n' "$id" "$(heavy_field "$f" state)" \
            "$(heavy_scope_state "$(heavy_field "$f" unit)")" "$(describe_run "$f")" "$(fmt_age "$since")"
        n=$((n + 1))
    done
    [ "$n" -gt 0 ] || echo "没有登记着的重测试"
}

cmd_stop() {
    local id="${1:-}" f unit
    heavy_is_run_id "$id" || { say "编号不对：要 --list 第一列那串 32 位字符"; exit 2; }
    f="$RUNS/$id"
    [ -f "$f" ] || { say "没有这条运行记录：$id"; exit 1; }
    unit="$(heavy_field "$f" unit)"
    [ "$unit" = "$(heavy_unit_name "$id")" ] || { say "记录里的分组名不对，没有动任何东西：$f"; exit 1; }
    if heavy_stop_unit "$unit" 30; then
        rm -f "$f"
        echo "已停：$id"
    else
        say "没能确认 $unit 已停（现在：$(heavy_scope_state "$unit")），记录保留"
        exit 1
    fi
}

# ── 条目归属 ──
ITEM="${CAVIL_HEAVY_ITEM:-}"; GEN="${CAVIL_HEAVY_GEN:-}"
LAUNCH="${CAVIL_HEAVY_LAUNCH:-}"; SDIR="${CAVIL_HEAVY_STATE_DIR:-}"
if ! [[ "$ITEM" =~ ^[0-9]+$ && "$GEN" =~ ^[0-9]+$ && -n "$SDIR" ]]; then
    ITEM=""; GEN=""; LAUNCH=""; SDIR=""
fi

# 这次运行还能不能继续。返回 0 = 可以；1 = 不行（原因已打印）。必须在条目锁里调。
item_check() {
    local g ls
    if ! g="$(heavy_gen_read "$SDIR" "$ITEM")"; then
        say "读不到条目 #$ITEM 的清理记录（$SDIR），不启动"
        return 1
    fi
    if [ "$g" != "$GEN" ]; then
        say "条目 #$ITEM 在这个 worker 启动之后已被清理过（第 $GEN 代 → 现在第 $g 代），不启动"
        return 1
    fi
    [ -n "$LAUNCH" ] || return 0
    ls="$(heavy_launch_state "$SDIR" "$LAUNCH")"
    case "$ls" in
        alive|none) return 0 ;;
        ended) say "起这套测试的 worker 已经结束，不启动"; return 1 ;;
        *) say "读不到起这套测试的 worker 是否还在，不启动"; return 1 ;;
    esac
}

# 在条目锁（共享）里跑一个函数；手动运行没有条目，直接跑。
with_item_lock() {
    local fd rc=0
    if [ -z "$ITEM" ]; then "$@"; return $?; fi
    mkdir -p "$SDIR/item-locks"
    exec {fd}<>"$(heavy_item_lock_path "$SDIR" "$ITEM")"
    if ! flock -s -w 60 "$fd"; then
        exec {fd}>&-
        say "等条目 #$ITEM 的锁超过 60 秒（正在派工或清理），不启动"
        return 1
    fi
    "$@" || rc=$?
    exec {fd}>&-
    return "$rc"
}

write_record() {   # <状态>
    local tmp="$REC.tmp.$$"
    {
        printf 'state=%s\n' "$1"
        printf 'unit=%s\n' "$UNIT"
        printf 'statedir=%s\n' "$SDIR"
        printf 'project=%s\n' "${CAVIL_HEAVY_PROJECT:-}"
        printf 'item=%s\n' "$ITEM"
        printf 'gen=%s\n' "$GEN"
        printf 'launch=%s\n' "$LAUNCH"
        printf 'pid=%s\n' "$$"
        printf 'since=%s\n' "$SINCE"
        printf 'cmd=%s\n' "$CMD_TEXT"
    } > "$tmp"
    mv -f "$tmp" "$REC"
}

register_queued() { item_check_if_item && write_record queued; }
mark_running() { item_check_if_item && write_record running; }
item_check_if_item() { [ -z "$ITEM" ] || item_check; }

# 还在跑的别的运行：分组确认消失的顺手删记录，其余的列出来。
others_running() {
    local f id unit st
    BLOCKERS=()
    for f in "$RUNS"/*; do
        [ -f "$f" ] || continue
        id="${f##*/}"; heavy_is_run_id "$id" || continue
        [ "$id" != "$RUN_ID" ] || continue
        st="$(heavy_field "$f" state)"; unit="$(heavy_field "$f" unit)"
        [ -e "$f" ] || continue            # 读的时候正好被删了
        if [ "$unit" != "$(heavy_unit_name "$id")" ]; then
            # 不是本工具写的东西：不认识就当它还在跑，不替人删
            [ "$st" != running ] || BLOCKERS+=("$f")
            continue
        fi
        case "$(heavy_scope_state "$unit")" in
            gone) rm -f "$f" ;;
            *) [ "$st" != running ] || BLOCKERS+=("$f") ;;
        esac
    done
}

print_waiting() {
    local f since any=0
    others_running
    for f in "${BLOCKERS[@]}"; do
        since="$(heavy_field "$f" since)"; [[ "$since" =~ ^[0-9]+$ ]] || since="$(date +%s)"
        say "排队中：上一套重测试 $(describe_run "$f") 还有进程在运行，已 $(fmt_age "$since")"
        any=1
    done
    [ "$any" = 1 ] || say "排队中：另一套重测试正在检查或收尾"
}

give_up_waiting() {
    say "排队超过 ${WAIT_LIMIT} 秒，放弃"
    print_waiting
    rm -f "$REC"
    finish 75
}

finish() {   # <退出码>：把退出码留给外层，然后退出
    printf '%s' "$1" > "$RC_DIR/$RUN_ID.rc" 2>/dev/null || true
    exit "$1"
}

tick_wait() {   # 排队 / 等上一套结束的每一秒：到上限就放弃，到点就打印在等谁
    if [ "$WAIT_LIMIT" -gt 0 ] && [ "$WAITED" -ge "$WAIT_LIMIT" ]; then give_up_waiting; fi
    if [ $((WAITED % PRINT_EVERY)) -eq 0 ]; then print_waiting; fi
    WAITED=$((WAITED + 1))
}

# ── 内层：已经在自己的分组里 ──
run_inner() {
    local cg cur qfd rc=0
    mkdir -p "$RUNS" "$RC_DIR"
    : > "$RC_DIR/$RUN_ID.entered"
    UNIT="$(heavy_unit_name "$RUN_ID")"; REC="$RUNS/$RUN_ID"
    SINCE="$(date +%s)"; CMD_TEXT="$*"; CMD_TEXT="${CMD_TEXT//$'\n'/ }"

    # 1. 不在预期的分组里就不登记：记录只能由分组里的进程写
    cg="${CAVIL_HEAVY_CGROUP_OVERRIDE:-$(cat /proc/self/cgroup 2>/dev/null || true)}"
    cg="${cg%%$'\n'*}"; cur="${cg##*/}"
    if [ "$cur" != "$UNIT" ]; then
        say "不在预期的进程分组里（期望 $UNIT，实际 ${cur:-读不到}），不登记、不跑"
        finish 70
    fi

    # 2. 登记成排队中（条目锁里核对代数）
    if ! with_item_lock register_queued; then finish 76; fi

    # 3. 排队
    exec {qfd}<>"$QUEUE_LOCK"
    WAITED=0
    until flock -w 1 "$qfd"; do tick_wait; done

    # 4. 上一套的分组全部确认消失才往下
    while :; do
        others_running
        [ "${#BLOCKERS[@]}" -gt 0 ] || break
        tick_wait
        sleep 1
    done

    # 5. 再核对一次，改成运行中
    if ! with_item_lock mark_running; then rm -f "$REC"; finish 76; fi

    # 6. 跑。排队锁、版本租约的描述符都不传给被测命令：放行只看分组，不看谁拿着锁
    (
        if [[ "${CODING_AGENT_RELEASE_LEASE_FD:-}" =~ ^[0-9]+$ ]]; then
            eval "exec ${CODING_AGENT_RELEASE_LEASE_FD}>&-" 2>/dev/null || true
        fi
        exec "$@"
    ) {qfd}>&- || rc=$?

    # 7. 收尾：先留下退出码，再把自己的分组整个停掉（连同留下的后台子进程）。
    #    记录不在这里删——分组没空之前它得挡着下一套；分组空了谁看到谁删。
    printf '%s' "$rc" > "$RC_DIR/$RUN_ID.rc"
    systemctl --user stop --no-block "$UNIT" >/dev/null 2>&1 || exit "$rc"
    sleep 30 || true
    exit "$rc"
}

# ── 外层 ──
heavy_mode() {
    case "${CAVIL_HEAVY_MODE:-}" in full|degraded) echo "$CAVIL_HEAVY_MODE"; return 0 ;; esac
    if [ "$(uname -s)" = Linux ] && [ -f /sys/fs/cgroup/cgroup.controllers ] \
       && command -v systemd-run >/dev/null 2>&1 && command -v systemctl >/dev/null 2>&1 \
       && systemctl --user show-environment >/dev/null 2>&1; then
        echo full
    else
        echo degraded
    fi
}

run_degraded() {
    local qfd rc=0 waited=0
    say "这台机器没有可用的 systemd 用户实例（或不是 Linux / cgroup v2）：只排队这条命令本身，不管它留下的后台进程"
    mkdir -p "$(dirname "$QUEUE_LOCK")"
    exec {qfd}<>"$QUEUE_LOCK"
    until flock -w 1 "$qfd"; do
        if [ "$WAIT_LIMIT" -gt 0 ] && [ "$waited" -ge "$WAIT_LIMIT" ]; then
            say "排队超过 ${WAIT_LIMIT} 秒，放弃"; exit 75
        fi
        [ $((waited % PRINT_EVERY)) -ne 0 ] || say "排队中：另一套重测试正在运行"
        waited=$((waited + 1))
    done
    "$@" {qfd}>&- || rc=$?
    exit "$rc"
}

run_outer() {
    local props=(-p TimeoutStopSec=10s) p child rc=0 i
    RUN_ID="$(tr -d '-' < /proc/sys/kernel/random/uuid)"
    UNIT="$(heavy_unit_name "$RUN_ID")"
    mkdir -p "$RUNS" "$RC_DIR"
    for p in ${CAVIL_HEAVY_SCOPE_PROPERTIES:-}; do props+=(-p "$p"); done

    # 被叫停（worker 的命令超时、人按 Ctrl-C）：把整个分组停掉，不留孤儿
    trap 'systemctl --user stop "$UNIT" >/dev/null 2>&1 || true; wait "$child" 2>/dev/null || true; rm -f "$RC_DIR/$RUN_ID".*; exit 143' TERM INT HUP

    systemd-run --user --scope --quiet --collect --unit="$UNIT" "${props[@]}" -- \
        bash "$SELF" --inner "$RUN_ID" -- "$@" <&0 &
    child=$!
    wait "$child" || rc=$?
    trap - TERM INT HUP

    if [ ! -e "$RC_DIR/$RUN_ID.entered" ]; then
        say "建不出这次运行的进程分组（systemd-run 退出码 $rc），没有跑命令"
        exit 70
    fi
    if [ -s "$RC_DIR/$RUN_ID.rc" ]; then rc="$(cat "$RC_DIR/$RUN_ID.rc")"; fi
    # 分组确认消失了就把记录删掉；没消失（还有进程 / 查不清）就留着，让它继续挡着下一套
    for ((i = 0; i < 100; i++)); do
        if [ "$(heavy_scope_state "$UNIT")" = gone ]; then rm -f "$RUNS/$RUN_ID"; break; fi
        sleep 0.2
    done
    rm -f "$RC_DIR/$RUN_ID".*
    exit "$rc"
}

INNER=0
case "${1:-}" in
    --list) cmd_list; exit 0 ;;
    --stop) cmd_stop "${2:-}"; exit 0 ;;
    --inner) INNER=1; RUN_ID="${2:-}"; shift 2; heavy_is_run_id "$RUN_ID" || usage ;;
    --) ;;
    *) usage ;;
esac
[ "${1:-}" = "--" ] || usage
shift
[ $# -gt 0 ] || usage

if [ "$INNER" = 1 ]; then run_inner "$@"; fi
case "$(heavy_mode)" in
    full) run_outer "$@" ;;
    *) run_degraded "$@" ;;
esac
