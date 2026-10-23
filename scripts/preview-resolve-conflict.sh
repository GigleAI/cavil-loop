#!/usr/bin/env bash
# 处理改名迁移留下的预览端口冲突（GigleAI/cavil-loop#75）：同一个端口在旧登记目录
# （~/.config/coding-agent-work-loop/preview/）和新登记目录（~/.config/cavil-loop/preview/）
# 各有一份登记、而且主人不同。迁移不替人判断哪份是真的，两份都不动，旧技能入口也因此一直保留。
#
# 用法：
#   preview-resolve-conflict.sh <port>                    只看：两份登记各归谁、新旧监听现在的状态
#   preview-resolve-conflict.sh <port> --keep old|new     留下一份：另一份连同它的单元停掉、登记移进备份
#   preview-resolve-conflict.sh <port> --swap <备份目录>   选错了：换成上次移走的那一份（只认这个端口这次的备份，见 swap()）
#
# 为什么是脚本不是一串手敲命令：整件事要在同一把端口锁里做完（注册、注销、迁移才不会插进来），
# 手敲的话锁在子 shell 里、变量留在父 shell 里，第二步就找不到文件（PR #79 第 2 轮复审）。
#
# 留下的那份**最后总是跑在新单元上**：留新的就是原样；留旧的就当场用迁移同一个搬迁函数搬过去。
# 所以选错了要换回来，也只在新单元上换，不依赖旧技能入口——全部冲突处理完后，下一轮迁移会把
# 旧入口删掉，之后再换回旧单元已经起不来了。
#
# 退出码：0 完成 / 1 没做完（原因见输出；已做的步骤可以重跑）/ 2 用法错或不是冲突。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_names.sh
source "$SCRIPT_DIR/_names.sh"
# shellcheck source=_preview_adopt.sh
source "$SCRIPT_DIR/_preview_adopt.sh"

PORT="${1:-}"
case "$PORT" in ''|*[!0-9]*) echo "用法：$0 <port> [--keep old|new | --swap <备份目录>]" >&2; exit 2 ;; esac
shift
ACTION="show"; ARG=""
case "${1:-}" in
    "") ;;
    --keep) ACTION=keep; ARG="${2:-}"; case "$ARG" in old|new) ;; *) echo "--keep 后面写 old 或 new" >&2; exit 2 ;; esac ;;
    --swap) ACTION=swap; ARG="${2:-}"; [ -d "$ARG" ] || { echo "--swap 后面写 --keep 打印出来的备份目录" >&2; exit 2; } ;;
    *) echo "不认识的参数：$1" >&2; exit 2 ;;
esac

UNIT_DIR="${CAVIL_SYSTEMD_USER_DIR:-$HOME/.config/systemd/user}"
OLD="$CAVIL_LEGACY_CONFIG_HOME/preview/$PORT.conf"
NEW="$CAVIL_CONFIG_HOME/preview/$PORT.conf"
OLD_UNITS=("$CAVIL_LEGACY_UNIT_PREFIX-preview@$PORT.socket" "$CAVIL_LEGACY_UNIT_PREFIX-preview@$PORT.service" "$CAVIL_LEGACY_UNIT_PREFIX-preview-app@$PORT.service")
NEW_UNITS=("$CAVIL_UNIT_PREFIX-preview@$PORT.socket" "$CAVIL_UNIT_PREFIX-preview@$PORT.service" "$CAVIL_UNIT_PREFIX-preview-app@$PORT.service")
NEW_SOCK="${NEW_UNITS[0]}"

say() { printf '%s\n' "$*"; }
owner_of() { [ -f "$1" ] && _padopt_owner "$1" | sed 's/|/ #/; s/|/ /' || echo "（没有）"; }

# 停掉一组单元并确认都停了；查不到状态也算没停（见 _preview_adopt.sh 的 _padopt_state）
stop_units() {
    local u st
    systemctl --user stop "$@" >/dev/null 2>&1 || true
    systemctl --user reset-failed "$@" >/dev/null 2>&1 || true
    for u in "$@"; do
        st="$(_padopt_state "$u")"
        case "$st" in
            inactive|failed) ;;
            *) say "❌ $u 没停下来（$st），什么都没移走；处理好之后重跑同一条命令"; return 1 ;;
        esac
    done
}

# 起新监听并确认在听
start_new_listener() {
    systemctl --user reset-failed "${NEW_UNITS[@]}" >/dev/null 2>&1 || true
    systemctl --user start "$NEW_SOCK" >/dev/null 2>&1 || true
    if [ "$(_padopt_state "$NEW_SOCK")" != active ]; then
        say "❌ 新监听 $NEW_SOCK 没起来（$(_padopt_state "$NEW_SOCK")）。登记已经处理好，修好后重跑：systemctl --user start $NEW_SOCK"
        return 1
    fi
}

show() {
    say "端口 :$PORT"
    say "  旧登记 $OLD"
    say "    主人：$(owner_of "$OLD")    旧监听：$(_padopt_state "${OLD_UNITS[0]}")"
    say "  新登记 $NEW"
    say "    主人：$(owner_of "$NEW")    新监听：$(_padopt_state "$NEW_SOCK")"
    if [ -f "$OLD" ] && [ -f "$NEW" ] && [ "$(_padopt_owner "$OLD")" != "$(_padopt_owner "$NEW")" ]; then
        say "这是冲突。留哪份：$0 $PORT --keep old 或 --keep new"
    else
        say "不是冲突（两份主人相同 = 迁移搬到一半，下一轮会接着搬；只有一份 = 没有要处理的）"
    fi
}

keep() {
    if ! { [ -f "$OLD" ] && [ -f "$NEW" ] && [ "$(_padopt_owner "$OLD")" != "$(_padopt_owner "$NEW")" ]; }; then
        say "端口 :$PORT 不是冲突，不动。现状："; show; return 2
    fi
    [ -e "$UNIT_DIR/$CAVIL_UNIT_PREFIX-preview@.socket" ] || { say "❌ 新预览单元没装（$UNIT_DIR/$CAVIL_UNIT_PREFIX-preview@.socket）"; return 1; }
    local b
    b="$CAVIL_CONFIG_HOME/migration/preview-conflict-$PORT-$(date +%Y%m%d-%H%M%S)"
    # 这个函数是在 `|| rc=$?` 左边调的，set -e 在里面不起作用：每一步都要自己查
    mkdir -p "$b" && chmod 700 "$b" && cp -p "$OLD" "$b/old.conf" && cp -p "$NEW" "$b/new.conf" \
        || { say "❌ 备份到 $b 失败，什么都没动"; return 1; }
    # state 是 --swap 认这份备份的唯一依据：哪个端口、留的是哪份
    printf 'port=%s\nkept=%s\nold_listener=%s\nnew_listener=%s\n' \
        "$PORT" "$ARG" "$(_padopt_state "${OLD_UNITS[0]}")" "$(_padopt_state "$NEW_SOCK")" > "$b/state" \
        || { say "❌ 写 $b/state 失败，什么都没动"; return 1; }
    say "备份：$b"
    if [ "$ARG" = new ]; then
        stop_units "${OLD_UNITS[@]}" || return 1
        mv "$OLD" "$b/old.removed" || { say "❌ 移走旧登记失败"; return 1; }
        say "旧登记（$(owner_of "$b/old.removed")）已停掉并移进备份"
        start_new_listener || return 1
    else
        stop_units "${NEW_UNITS[@]}" || return 1
        mv "$NEW" "$b/new.removed" || { say "❌ 移走新登记失败"; return 1; }
        say "新登记（$(owner_of "$b/new.removed")）已停掉并移进备份；旧登记现在搬到新单元"
        local rc=0
        PREVIEW_ADOPT_LOG=say preview_adopt_legacy "$PORT" "$UNIT_DIR" yes || rc=$?
        if [ "$rc" != 0 ]; then
            say "❌ 旧登记这次没搬完（见上一行）。冲突已经解除，下一轮迁移会接着搬；也可以修好后重跑：$0 $PORT"
            return 1
        fi
    fi
    say "✅ 端口 :$PORT 现在只剩 $(owner_of "$NEW") 的登记，跑在新单元上（$(_padopt_state "$NEW_SOCK")）。"
    say "   打开预览地址确认能看到页面；选错了就跑：$0 $PORT --swap $b"
}

# --swap 的规矩（PR #79 第 3 轮复审）：
#   · 持锁之后、停任何单元写任何文件之前，先证明「这份备份就是这个端口这次冲突的备份，
#     而且现在跑着的正是那次留下的那份」：
#       备份里 state 记的端口 = 命令里的端口，要换上的那份登记里写的端口也是它；
#       当前新登记逐字节等于备份里「留下的那份」原件（--keep old 时搬迁原样复制，所以也成立）。
#     任何一条对不上就拒绝，什么都不动——另一个端口的备份、后来又有人重新注册过的端口，都在这里挡住。
#   · 换登记只做同目录原子替换（先写临时文件，再 rename 覆盖），新登记目录里**任何时刻都有一份登记**。
#     当前那份先**复制**进备份，不挪走；备份目录里原有的文件一个都不改。
#   · 中途断了能接着做：开始前写下 swap.pending（记着要换上的那份的指纹）。重跑时，当前登记已经
#     是要换上的那份、而 swap.pending 还在 → 直接从「起监听」接着做；做完写 swap.done、删 swap.pending。
sha_of() { sha256sum "$1" 2>/dev/null | cut -c1-64; }
conf_port() { ( set +u; . "$1" >/dev/null 2>&1; printf '%s' "${PREVIEW_PORT:-}" ); }

swap() {
    local b="$ARG" kept bport src keep_src cur target
    [ -f "$b/state" ] || { say "❌ $b 不是 --keep 留下的备份目录（没有 state）"; return 2; }
    bport="$(sed -n 's/^port=//p' "$b/state" | head -1)"
    kept="$(sed -n 's/^kept=//p' "$b/state" | head -1)"
    case "$kept" in old) src="$b/new.conf"; keep_src="$b/old.conf" ;; new) src="$b/old.conf"; keep_src="$b/new.conf" ;;
        *) say "❌ $b/state 里没有记留下的是哪份，不认这份备份"; return 2 ;; esac
    if [ "$bport" != "$PORT" ]; then
        say "❌ 这份备份是端口 :${bport:-?} 的，不是 :$PORT，不动"; return 2
    fi
    [ -f "$src" ] && [ -f "$keep_src" ] || { say "❌ $b 里缺 old.conf / new.conf，不认这份备份"; return 2; }
    if [ "$(conf_port "$src")" != "$PORT" ]; then
        say "❌ 要换上的登记里写的端口是 :$(conf_port "$src")，不是 :$PORT，不动"; return 2
    fi
    [ ! -f "$OLD" ] || { say "❌ 旧登记目录里还有 :$PORT（上次留旧的那份还没搬完）。等下一轮迁移搬完，或先跑 $0 $PORT 看现状"; return 1; }
    [ -f "$NEW" ] || { say "❌ 新登记目录里没有 :$PORT 的登记，不动；现状："; show; return 1; }
    target="$(sha_of "$src")"; cur="$(sha_of "$NEW")"

    if [ -f "$b/swap.done" ]; then
        [ "$cur" = "$target" ] || { say "❌ 这份备份已经换过一次，而 :$PORT 现在的登记又变了，不动"; return 2; }
        say "这份备份已经换过了，登记就是 $(owner_of "$NEW")；只确认一下监听"
        start_new_listener || return 1
        say "✅ 端口 :$PORT 是 $(owner_of "$NEW")，跑在新单元上"; return 0
    fi
    if [ "$cur" = "$target" ] && [ -f "$b/swap.pending" ]; then
        say "上次换到一半（登记已经换好），接着起监听"
    elif [ "$cur" = "$(sha_of "$keep_src")" ]; then
        printf 'target=%s\n' "$target" > "$b/swap.pending.tmp" && mv -f "$b/swap.pending.tmp" "$b/swap.pending" \
            && cp -p "$NEW" "$b/replaced-$(date +%Y%m%d-%H%M%S).conf" \
            || { rm -f "$b/swap.pending.tmp"; say "❌ 写备份失败，什么都没换"; return 1; }
        stop_units "${NEW_UNITS[@]}" || return 1
        local tmp
        tmp="$(mktemp "$(dirname "$NEW")/.swap-$PORT.XXXXXX")" && cat "$src" > "$tmp" && chmod 600 "$tmp" \
            || { rm -f "${tmp:-}"; say "❌ 准备换上的登记写不出来，什么都没换（当前登记原样在，单元已停，重跑同一条命令即可）"; return 1; }
        mv -f "$tmp" "$NEW" \
            || { rm -f "$tmp"; say "❌ 换登记失败，当前登记原样在（单元已停），重跑同一条命令即可"; return 1; }
        say "已换成 $(owner_of "$NEW") 的登记（换下来的那份复制在 $b）"
    else
        say "❌ :$PORT 现在的登记（$(owner_of "$NEW")）既不是这份备份当时留下的那份，也不是要换上的那份——"
        say "   处理完冲突之后有人重新注册过，或者这份备份不是这次的。不动"
        return 2
    fi
    start_new_listener || return 1
    : > "$b/swap.done" && rm -f "$b/swap.pending"
    say "✅ 端口 :$PORT 现在是 $(owner_of "$NEW")，跑在新单元上。打开预览地址确认能看到页面"
}

rc=0
case "$ACTION" in
    show) show ;;
    keep) preview_adopt_with_lock "$PORT" "$UNIT_DIR" keep || rc=$? ;;
    swap) preview_adopt_with_lock "$PORT" "$UNIT_DIR" swap || rc=$? ;;
esac
exit "$rc"
