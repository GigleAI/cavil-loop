# shellcheck shell=bash
# 预览端口的算法和「这组设置算出来的端口能不能用」：唯一的一份（GitHub#556 复审第 1、2 轮）。
#
# 读者：
#   · _lib.sh 的 preview_port（preview-serve.sh 注册、preview-unserve.sh 注销都靠它算端口）
#   · preview-serve.sh 注册前的检查
#   · project-config.sh 保存起始号 / 取余数 / 后端偏移时的组合检查
# 起始号、取余数、偏移三项各自在范围里，不等于算出来的端口在范围里（起始号 6000 + 偏移 65535，
# #1 的后端端口是 71536）；而且手写配置里的大数一进 bash 算术就静默回绕（偏移写成 2^64，加完等于没加），
# 所以**先查参与运算的每个输入，再做算术，再查结果**。三步都在这里，调用方不各写一份。
#
# 只用 bash 内建，macOS 自带的 bash 3.2 也能跑（project-config.sh 由桌面客户端在 macOS 上调用）。

PREVIEW_PORT_MAX=65535

# _pp_num <值> <最多几位> → 规范十进制（"0" 或不以 0 开头）且不超过位数才返回 0。
# 先于任何算术：空值、负号、前导 0（bash 会按八进制读）、位数过多（会回绕）都在这里拦下
_pp_num() {
    case "$1" in ''|*[!0-9]*) return 1 ;; esac
    case "$1" in 0) ;; 0*) return 1 ;; esac
    [ "${#1}" -le "$2" ]
}

# preview_ports_inputs_problem <起始号> <取余数，空 = 不取> <后端偏移>
#   → 三项都能参与运算时不输出、返回 0；否则输出是哪一项、为什么，返回 1
#   起始号 0–65535（不取余数时 0 是可用的：#1 的端口是 1；取余数时由组合检查判断）
#   取余数 空 或 1–65535（0 会除以零）   后端偏移 1–65535（0 会和公开端口撞上）
preview_ports_inputs_problem() {
    if ! _pp_num "$1" 5 || [ "$1" -gt "$PREVIEW_PORT_MAX" ]; then
        printf '起始号 %s 不是 0 到 %s 之间的整数\n' "${1:-（空）}" "$PREVIEW_PORT_MAX"; return 1
    fi
    if [ -n "$2" ] && { ! _pp_num "$2" 5 || [ "$2" -lt 1 ] || [ "$2" -gt "$PREVIEW_PORT_MAX" ]; }; then
        printf '取余数 %s 不是 1 到 %s 之间的整数（不取余数就留空）\n' "$2" "$PREVIEW_PORT_MAX"; return 1
    fi
    if ! _pp_num "$3" 5 || [ "$3" -lt 1 ] || [ "$3" -gt "$PREVIEW_PORT_MAX" ]; then
        printf '后端偏移 %s 不是 1 到 %s 之间的整数\n' "${3:-（空）}" "$PREVIEW_PORT_MAX"; return 1
    fi
    return 0
}

# preview_port_calc <起始号> <取余数，空 = 不取> <issue 编号> → 公开端口
# 输入不能参与运算时不输出、返回 1（不做算术）。issue 编号最多 9 位
preview_port_calc() {
    _pp_num "$3" 9 || return 1
    preview_ports_inputs_problem "$1" "$2" 1 >/dev/null || return 1
    if [ -n "$2" ]; then
        echo $(( $1 + $3 % $2 ))
    else
        echo $(( $1 + $3 ))
    fi
}

# preview_port_problem <公开端口> <后端端口> → 都能用时不输出、返回 0；否则输出原因、返回 1
preview_port_problem() {
    local what p
    for what in "公开端口:$1" "后端端口:$2"; do
        p="${what#*:}"
        if ! _pp_num "$p" 10 || [ "$p" -lt 1 ] || [ "$p" -gt "$PREVIEW_PORT_MAX" ]; then
            printf '%s %s 超出 1 到 %s\n' "${what%%:*}" "${p:-（空）}" "$PREVIEW_PORT_MAX"; return 1
        fi
    done
    return 0
}

# preview_ports_issue_problem <起始号> <取余数> <后端偏移> <issue 编号> → 注册前的完整检查
#   输入 → 算端口 → 端口能不能用；能用时把「公开端口 后端端口」写到 stdout、返回 0
preview_ports_issue_problem() {
    local why port
    why="$(preview_ports_inputs_problem "$1" "$2" "$3")" || { printf '%s\n' "$why"; return 1; }
    _pp_num "$4" 9 || { printf 'issue 编号 %s 不是 1 到 9 位的整数\n' "$4"; return 1; }
    port="$(preview_port_calc "$1" "$2" "$4")" || { printf '端口算不出来\n'; return 1; }
    why="$(preview_port_problem "$port" $(( port + $3 )))" || { printf '%s\n' "$why"; return 1; }
    printf '%s %s\n' "$port" $(( port + $3 ))
}

# preview_ports_save_problem <起始号> <取余数，空 = 不取> <后端偏移> → 保存前的组合检查
#   配了取余数：所有 issue 的端口落在「起始号」到「起始号 + 取余数 − 1」，两头连同后端端口都要能用
#     （起始号 0 时，编号是取余数整数倍的 issue 端口就是 0，不能用）
#   没配取余数：端口随 issue 编号一直往上加，保存时只能保证最小的 #1 能用；编号大到越界时由注册前的检查拦下
preview_ports_save_problem() {
    local base="$1" mod="$2" off="$3" lo hi why
    why="$(preview_ports_inputs_problem "$base" "$mod" "$off")" || { printf '%s\n' "$why"; return 1; }
    if [ -n "$mod" ]; then lo="$base"; hi=$(( base + mod - 1 )); else lo=$(( base + 1 )); hi="$lo"; fi
    if ! why="$(preview_port_problem "$lo" $(( lo + off )))"; then
        printf '按这组设置，最小的端口就不能用（%s）\n' "$why"; return 1
    fi
    if ! why="$(preview_port_problem "$hi" $(( hi + off )))"; then
        printf '按这组设置，最大的端口不能用（%s）：起始号 + 取余数 − 1 + 后端偏移不能超过 %s\n' "$why" "$PREVIEW_PORT_MAX"; return 1
    fi
    return 0
}
