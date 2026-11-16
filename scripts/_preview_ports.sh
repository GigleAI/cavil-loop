# shellcheck shell=bash
# 预览端口：怎么算、算出来能不能用——唯一的一份（GitHub#556，复审第 1–3 轮收口）。
#
# 用到它的全部路径：
#   · 注册  preview-serve.sh → preview_ports_issue_problem（算 + 判断，不能用就不写登记）
#   · 注销  preview-unserve.sh → _lib.sh 的 preview_port → preview_port_calc（只算，不判断：
#           旧登记是按当时的端口写的，注销只要找到它，不能因为「这个端口现在看来不能用」就找不到）
#   · 保存  project-config.sh → preview_ports_save_problem（三项设置一起查）
#
# 一条规则，分两层，两层不混：
#   ① 能不能参与运算——只看算术安全：每个输入（起始号、取余数、偏移、issue 编号）是规范十进制
#      （"0" 或不以 0 开头，bash 不会按八进制读）且不超过 9 位（加起来远小于 2^63，不会回绕），取余数不为 0。
#      **不在这一层按端口范围卡单项**：取余数是除数不是端口，100000 是合法的取余数（复审第 3 轮）；
#      起始号 0 不取余数时 #1 的端口是 1（复审第 2 轮）。
#   ② 算出来能不能用——只看结果：公开端口、后端端口都在 1–65535，且两者不同（偏移 0 会让两个服务抢一个端口）。
#
# 只用 bash 内建，macOS 自带的 bash 3.2 也能跑（project-config.sh 由桌面客户端在 macOS 上调用）。

PREVIEW_PORT_MAX=65535

# _pp_num <值> → 规范十进制且不超过 9 位才返回 0（先于任何算术）
_pp_num() {
    case "$1" in ''|*[!0-9]*) return 1 ;; esac
    case "$1" in 0) ;; 0*) return 1 ;; esac
    [ "${#1}" -le 9 ]
}

# preview_ports_inputs_problem <起始号> <取余数，空 = 不取> <后端偏移> [issue 编号]
#   → 第 ① 层：都能参与运算时不输出、返回 0；否则输出是哪一项、为什么，返回 1
preview_ports_inputs_problem() {
    _pp_num "$1" || { printf '起始号 %s 不是不超过 9 位的非负整数\n' "${1:-（空）}"; return 1; }
    if [ -n "$2" ] && { ! _pp_num "$2" || [ "$2" = 0 ]; }; then
        printf '取余数 %s 不是不超过 9 位的正整数（不取余数就留空）\n' "$2"; return 1
    fi
    _pp_num "$3" || { printf '后端偏移 %s 不是不超过 9 位的非负整数\n' "${3:-（空）}"; return 1; }
    if [ $# -ge 4 ] && ! _pp_num "$4"; then printf 'issue 编号 %s 不是不超过 9 位的整数\n' "$4"; return 1; fi
    return 0
}

# preview_port_calc <起始号> <取余数，空 = 不取> <issue 编号> → 公开端口（只算，不判断能不能用）
# 输入过不了第 ① 层时不输出、返回 1，不做算术
preview_port_calc() {
    preview_ports_inputs_problem "$1" "$2" 0 "$3" >/dev/null || return 1
    if [ -n "$2" ]; then
        echo $(( $1 + $3 % $2 ))
    else
        echo $(( $1 + $3 ))
    fi
}

# preview_port_problem <公开端口> <后端端口> → 第 ② 层：能用时不输出、返回 0；否则输出原因、返回 1
# （两个数都由上面算出，已是不超过 10 位的十进制）
preview_port_problem() {
    local what p
    for what in "公开端口:$1" "后端端口:$2"; do
        p="${what#*:}"
        case "$p" in ''|*[!0-9]*) printf '%s 算不出来\n' "${what%%:*}"; return 1 ;; esac
        if [ "$p" -lt 1 ] || [ "$p" -gt "$PREVIEW_PORT_MAX" ]; then
            printf '%s %s 超出 1 到 %s\n' "${what%%:*}" "$p" "$PREVIEW_PORT_MAX"; return 1
        fi
    done
    [ "$1" != "$2" ] || { printf '后端端口和公开端口都是 %s（偏移是 0），两个服务会抢同一个端口\n' "$1"; return 1; }
    return 0
}

# preview_ports_issue_problem <起始号> <取余数> <后端偏移> <issue 编号> → 注册前的完整判断
#   能用时把「公开端口 后端端口」写到 stdout、返回 0；否则输出原因、返回 1
preview_ports_issue_problem() {
    local why port back
    why="$(preview_ports_inputs_problem "$1" "$2" "$3" "$4")" || { printf '%s\n' "$why"; return 1; }
    port="$(preview_port_calc "$1" "$2" "$4")" || { printf '端口算不出来\n'; return 1; }
    back=$(( port + $3 ))
    why="$(preview_port_problem "$port" "$back")" || { printf '%s\n' "$why"; return 1; }
    printf '%s %s\n' "$port" "$back"
}

# preview_ports_save_problem <起始号> <取余数，空 = 不取> <后端偏移> → 保存前的组合检查
# 查的是每种配置都一定会用到的端口，判断用注册时的同一个函数：
#   · #1 的端口
#   · 配了取余数时，编号是取余数整数倍的那条（余数 0，端口 = 起始号；起始号 0 时它是端口 0）
# 端口随 issue 编号变大而越界（不取余数时一直往上加；取余数时余数大的那些）这件事，保存时不拦：
# 拦了会让取余数很大的旧配置连别的项都改不了（复审第 3 轮）。它由注册入口按那条 issue 实际算出的端口拦下并说明。
preview_ports_save_problem() {
    local why n
    why="$(preview_ports_inputs_problem "$1" "$2" "$3")" || { printf '%s\n' "$why"; return 1; }
    for n in 1 ${2:+"$2"}; do
        if ! why="$(preview_ports_issue_problem "$1" "$2" "$3" "$n")"; then
            printf '按这组设置，#%s 的预览端口就不能用（%s）\n' "$n" "$why"; return 1
        fi
    done
    return 0
}
