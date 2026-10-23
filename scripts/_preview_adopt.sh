#!/usr/bin/env bash
# 把改名前注册的预览（登记在旧目录、跑在 coding-agent-preview* 旧单元上）搬到新单元
# （GigleAI/cavil-loop#75）。迁移脚本（批量）和 preview-serve.sh（自己名下的端口重注册时）
# 共用这一份——同一条规则只写一次。
#
# 为什么非搬不可：旧单元文件里 ExecStart 写死的是旧技能入口下的脚本路径，迁移删掉旧入口
# 之后旧单元就再也起不来（访问 502）。旧单元文件按约定逐字节保留，不能改它的内容。
#
# 只依赖 _names.sh（迁移脚本不能 source _lib.sh），调用前先 source 它。
#
# 一个端口的搬迁步骤，每步都可以重复执行，中途在哪里断，下次从头再跑只会做完剩下的：
#   ① 第一次碰这个端口时记下旧监听原本该不该开（在听 / 已失败 = 该开），已有记录不覆盖
#   ② 旧登记**复制**到新目录（新目录已有同主人的那份就不动）
#   ③ 停掉旧单元的 socket / 代理 / app，确认三者都不在运行
#   ④ 原本该开的，在同一端口起新单元的 socket，确认它在听；失败时旧入口还在就把旧的拉回来
#   ⑤ 旧登记移进迁移备份目录（不删），清掉 ① 的记录
# 于是端口只可能是三种状态，从文件上就看得出来：
#   完成      只有新目录有登记
#   搬到一半  新旧两份、主人相同 → 下次接着搬
#   冲突      新旧两份、主人不同 → 不动，等人处理

CAVIL_PREVIEW_ADOPT_BACKUP="$CAVIL_CONFIG_HOME/migration/preview-legacy"

_padopt_log() { printf '%s\n' "$*" >&2; }

# 登记的主人「项目|issue|worktree」
_padopt_owner() {
    # shellcheck disable=SC1090
    ( source "$1" >/dev/null 2>&1; printf '%s|%s|%s' "${PREVIEW_PROJECT:-}" "${PREVIEW_ISSUE:-}" "${PREVIEW_WORKTREE:-}" )
}

# 单元的状态词；**查不到就输出 unknown**。is-active 的退出码不作数：正常的 inactive / failed
# 也是非零（没装的单元是 inactive + 4），而用户服务管理器连不上时 stdout 什么都没有、只有
# stderr 的报错。所以只认 stdout 第一行是不是一个已知的状态词。
# unknown 不能被任何一步当成「没在跑」或「原本没开」——那会跳过起新监听、却照样收走旧登记、
# 删掉旧入口（PR #79 第 1 轮复审）。读状态的每一处都先挡 unknown。
_padopt_state() {
    local s
    s="$(systemctl --user is-active "$1" 2>/dev/null | head -1)"
    case "$s" in
        active|inactive|failed|activating|deactivating|reloading|refreshing|maintenance) printf '%s\n' "$s" ;;
        *) printf 'unknown\n' ;;
    esac
}

# preview_legacy_pending_ports：旧目录里还有登记的端口，一行一个
preview_legacy_pending_ports() {
    local f
    for f in "$CAVIL_LEGACY_CONFIG_HOME/preview"/*.conf; do
        [ -f "$f" ] || continue
        basename "$f" .conf
    done
}

# preview_adopt_legacy <port> [unit_dir] [force_listen]：**必须在端口锁里调**。
#   force_listen=yes：不管旧监听原本开没开，搬完都起新监听（preview-serve 重注册用）
# 返回：0 已完成或没有旧登记 / 1 这次没搬完（下次接着做）/ 3 冲突（等人）
# 过程写到 ${PREVIEW_ADOPT_LOG:-_padopt_log}（迁移脚本传自己的日志函数）。
preview_adopt_legacy() {
    local port="$1" unit_dir="${2:-$HOME/.config/systemd/user}" force="${3:-}"
    local log="${PREVIEW_ADOPT_LOG:-_padopt_log}"
    local old="$CAVIL_LEGACY_CONFIG_HOME/preview/$port.conf"
    local new_dir="$CAVIL_CONFIG_HOME/preview" rec="$CAVIL_CONFIG_HOME/migration/preview-$port.listen"
    local new="$new_dir/$port.conf"
    local old_u="$CAVIL_LEGACY_UNIT_PREFIX" new_u="$CAVIL_UNIT_PREFIX"

    if [ ! -f "$old" ]; then
        rm -f "$rec"
        return 0
    fi
    if [ -f "$new" ] && [ "$(_padopt_owner "$new")" != "$(_padopt_owner "$old")" ]; then
        return 3
    fi
    if [ ! -e "$unit_dir/$new_u-preview@.socket" ]; then
        "$log" "preview :$port 还没法搬：新预览单元没装（$unit_dir/$new_u-preview@.socket）"
        return 1
    fi

    # ① 原状
    mkdir -p "$CAVIL_CONFIG_HOME/migration" && chmod 700 "$CAVIL_CONFIG_HOME/migration" || return 1
    if [ ! -f "$rec" ]; then
        local want tmp
        case "$(_padopt_state "$old_u-preview@$port.socket")" in
            active|activating|failed) want=yes ;;
            unknown) "$log" "❌ preview :$port 查不到旧监听的状态（用户服务管理器连不上？），原状没法记，这次不搬"
                     return 1 ;;
            *) want=no ;;
        esac
        tmp="$(mktemp "$CAVIL_CONFIG_HOME/migration/.preview-$port.XXXXXX")" || return 1
        printf '%s\n' "$want" > "$tmp" && mv -f "$tmp" "$rec" || { rm -f "$tmp"; return 1; }
    fi
    local listen; listen="$(head -1 "$rec" 2>/dev/null)"
    [ "$force" = yes ] && listen=yes

    # ② 复制登记
    if [ ! -f "$new" ]; then
        local tmp
        mkdir -p "$new_dir" || return 1
        tmp="$(mktemp "$new_dir/.adopt-$port.XXXXXX")" || return 1
        cat "$old" > "$tmp" && chmod 600 "$tmp" && mv -f "$tmp" "$new" || {
            rm -f "$tmp"; "$log" "❌ preview :$port 复制登记到 $new 失败"; return 1; }
    fi

    # ③ 停旧单元。stop 的返回码不作数（模板链接不在时 stop 会报 not loaded），看的是停完的状态。
    local old_units=("$old_u-preview@$port.socket" "$old_u-preview@$port.service" "$old_u-preview-app@$port.service") u
    systemctl --user stop "${old_units[@]}" >/dev/null 2>&1 || true
    systemctl --user reset-failed "${old_units[@]}" >/dev/null 2>&1 || true
    local st
    for u in "${old_units[@]}"; do
        st="$(_padopt_state "$u")"
        case "$st" in
            inactive|failed) ;;
            unknown) "$log" "❌ preview :$port 查不到旧单元 $u 停没停（用户服务管理器连不上？），下次再搬"
                     return 1 ;;
            *) "$log" "❌ preview :$port 旧单元 $u 停不下来（$st），下次再搬"
               return 1 ;;
        esac
    done

    # ④ 起新监听
    if [ "$listen" = yes ]; then
        local sock="$new_u-preview@$port.socket"
        systemctl --user reset-failed "$sock" "$new_u-preview@$port.service" "$new_u-preview-app@$port.service" >/dev/null 2>&1 || true
        systemctl --user start "$sock" >/dev/null 2>&1 || true
        if [ "$(_padopt_state "$sock")" != active ]; then
            local back=""
            # 旧入口还在，旧单元就还能跑：先把它拉回来，别让人这段时间对着一个死地址
            if [ -e "$CAVIL_LEGACY_SKILL_HOME/scripts/preview-run.sh" ]; then
                systemctl --user start "$old_u-preview@$port.socket" >/dev/null 2>&1 || true
                back="；旧监听已拉回（$(_padopt_state "$old_u-preview@$port.socket")）"
            fi
            "$log" "❌ preview :$port 新监听 $sock 起不来（$(_padopt_state "$sock")），下次再搬$back"
            return 1
        fi
    fi

    # ⑤ 收尾
    mkdir -p "$CAVIL_PREVIEW_ADOPT_BACKUP" && chmod 700 "$CAVIL_PREVIEW_ADOPT_BACKUP" || return 1
    mv -f "$old" "$CAVIL_PREVIEW_ADOPT_BACKUP/$port.conf.adopted-$(date +%Y%m%d-%H%M%S)" || {
        "$log" "❌ preview :$port 旧登记收进备份失败，下次再收"; return 1; }
    rm -f "$rec"
    "$log" "preview :$port 已从旧单元搬到 $new_u-preview@$port（$([ "$listen" = yes ] && echo 在听 || echo 原本没开，保持不开)；旧登记在 $CAVIL_PREVIEW_ADOPT_BACKUP）"
    return 0
}

# preview_adopt_legacy_locked <port> [unit_dir]：自己拿端口锁再搬（迁移脚本用）。
# 锁和 preview-serve / preview-unserve 是同一把（cavil_preview_lock_dir）。等不到锁返回 1，下次再来。
preview_adopt_legacy_locked() {
    local port="$1" unit_dir="${2:-$HOME/.config/systemd/user}" lock_dir
    lock_dir="$(cavil_preview_lock_dir "$unit_dir")"
    mkdir -p "$lock_dir" || return 1
    (
        flock -w "${PREVIEW_LOCK_TIMEOUT:-30}" 7 || exit 1
        preview_adopt_legacy "$port" "$unit_dir"
    ) 7>"$lock_dir/.port-$port.lock"
}
