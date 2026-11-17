# shellcheck shell=bash
# 预览端口：怎么算、算出来能不能用——唯一的一份（GitHub#556，复审第 1–4 轮收口）。
#
# 用到它的全部路径：
#   · 注册  preview-serve.sh → preview_ports_issue_problem（算 + 判断，不能用就不写登记）
#   · 注销  preview-unserve.sh → _lib.sh 的 preview_port → preview_port_calc（只算，不判断：
#           旧登记是按当时的端口写的，注销只要找到它，不能因为「这个端口现在看来不能用」就找不到）
#   · 保存  project-config.sh → preview_ports_save_problem（三项设置一起查）
#
# 一条规则，分两层，两层不混：
#   ① 能不能算——逐个运算查，范围就是 bash 自己的：Linux 的 bash 5 和 macOS 自带的 bash 3.2 都是
#      64 位有符号整数，上限 I64 = 2^63−1。
#      · 每个输入（起始号、取余数、偏移、issue 编号）本身要是 bash 整数：只有数字、规范写法（"0" 或不以 0
#        开头——bash 会把前导 0 按八进制读）、不超过 I64（按十进制数字串比较，比较本身不做可能溢出的算术）；
#        取余数不为 0。超过 I64 的数 bash 一读进来就已经回绕，没有可保留的旧行为。
#      · 余数 = issue 编号 % 取余数：两边都是 bash 整数，结果不大于 issue 编号，不会溢出。
#        **取余数是除数不是加数**，它多大都不影响下面的加法（复审第 3、4、5 轮）。
#      · 公开端口 = 起始号 + 余数（不取余数时就是 issue 编号）：先查「起始号 ≤ I64 − 余数」，成立才加；
#        不成立说明真实结果比 I64 还大，那它一定不是可用端口。
#      · 后端端口 = 公开端口 + 偏移：同样先查「偏移 ≤ I64 − 公开端口」再加。
#      于是：原公式在 bash 里不回绕的每一组输入，算出来的端口都和原公式一字不差；会回绕的那些，
#      这里不做那次加法，直接按「端口越界」处理，不再静默得到一个回绕后的数。
#      **不按端口范围卡任何单项**：取余数 100000、1000000000、I64 都能算，起始号 0 不取余数时 #1 的端口是 1。
#   ② 算出来能不能用——只看结果：公开端口、后端端口都在 1–65535，且两者不同（偏移 0 会让两个服务抢一个端口）。
#
# 只用 bash 内建，macOS 自带的 bash 3.2 也能跑（project-config.sh 由桌面客户端在 macOS 上调用）。

PREVIEW_PORT_MAX=65535
PREVIEW_I64=9223372036854775807   # bash 整数的上限 2^63−1（两个平台一样）

# _pp_le <a> <b> → 两个规范十进制数字串，a ≤ b 返回 0。位数不同按位数比；19 位的拆成前 10 位和后 9 位
# 分别比（每段都远小于 2^63），不把可能溢出的整数交给算术
_pp_le() {
    local a="$1" b="$2" ah bh
    [ "${#a}" -ne "${#b}" ] && { [ "${#a}" -lt "${#b}" ]; return; }
    if [ "${#a}" -le 18 ]; then [ "$a" -le "$b" ]; return; fi
    ah="${a:0:${#a}-9}"; bh="${b:0:${#b}-9}"
    [ "$ah" != "$bh" ] && { [ "$ah" -lt "$bh" ]; return; }
    [ $(( 10#${a: -9} )) -le $(( 10#${b: -9} )) ]
}

# _pp_num <值> → 是 bash 整数（规范十进制、不超过 I64）才返回 0（先于任何算术）
_pp_num() {
    case "$1" in ''|*[!0-9]*) return 1 ;; esac
    case "$1" in 0) ;; 0*) return 1 ;; esac
    [ "${#1}" -le 19 ] && _pp_le "$1" "$PREVIEW_I64"
}

# preview_ports_inputs_problem <起始号> <取余数，空 = 不取> <后端偏移> [issue 编号]
#   → 每个输入都是 bash 整数（取余数不为 0）时不输出、返回 0；否则输出是哪一项、为什么，返回 1
preview_ports_inputs_problem() {
    _pp_num "$1" || { printf '起始号 %s 不是不超过 %s 的非负整数（只有数字、不以 0 开头）\n' "${1:-（空）}" "$PREVIEW_I64"; return 1; }
    if [ -n "$2" ] && { ! _pp_num "$2" || [ "$2" = 0 ]; }; then
        printf '取余数 %s 不是不超过 %s 的正整数（只有数字、不以 0 开头；不取余数就留空）\n' "$2" "$PREVIEW_I64"; return 1
    fi
    _pp_num "$3" || { printf '后端偏移 %s 不是不超过 %s 的非负整数（只有数字、不以 0 开头）\n' "${3:-（空）}" "$PREVIEW_I64"; return 1; }
    if [ $# -ge 4 ] && ! _pp_num "$4"; then printf 'issue 编号 %s 不是不超过 %s 的整数\n' "$4" "$PREVIEW_I64"; return 1; fi
    return 0
}

# preview_port_calc <起始号> <取余数，空 = 不取> <issue 编号> → 公开端口（只算，不判断能不能用）
#   返回 0 = 算出来了；1 = 输入不是 bash 整数（或取余数是 0），不做算术；2 = 真实结果大于 I64，不做那次加法
preview_port_calc() {
    local r
    preview_ports_inputs_problem "$1" "$2" 0 "$3" >/dev/null || return 1
    if [ -n "$2" ]; then r=$(( $3 % $2 )); else r="$3"; fi
    [ "$1" -le $(( PREVIEW_I64 - r )) ] || return 2
    echo $(( $1 + r ))
}

# _pp_port_problem <名字> <端口> → 一个端口在 1–65535 时不输出、返回 0；否则输出原因、返回 1
_pp_port_problem() {
    case "$2" in ''|*[!0-9]*) printf '%s 算不出来\n' "$1"; return 1 ;; esac
    if [ "$2" -lt 1 ] || [ "$2" -gt "$PREVIEW_PORT_MAX" ]; then
        printf '%s %s 超出 1 到 %s\n' "$1" "$2" "$PREVIEW_PORT_MAX"; return 1
    fi
}

# preview_port_problem <公开端口> <后端端口> → 第 ② 层：能用时不输出、返回 0；否则输出原因、返回 1
# （两个数都由上面算出，都是不大于 I64 的非负整数）
preview_port_problem() {
    _pp_port_problem 公开端口 "$1" || return 1
    _pp_port_problem 后端端口 "$2" || return 1
    [ "$1" != "$2" ] || { printf '后端端口和公开端口都是 %s（偏移是 0），两个服务会抢同一个端口\n' "$1"; return 1; }
}

# preview_ports_issue_problem <起始号> <取余数> <后端偏移> <issue 编号> → 注册前的完整判断
#   能用时把「公开端口 后端端口」写到 stdout、返回 0；否则输出原因、返回 1
preview_ports_issue_problem() {
    local why port back
    local rc=0
    why="$(preview_ports_inputs_problem "$1" "$2" "$3" "$4")" || { printf '%s\n' "$why"; return 1; }
    port="$(preview_port_calc "$1" "$2" "$4")" || rc=$?
    if [ "$rc" = 2 ]; then printf '公开端口超出 1 到 %s（比 bash 能表示的最大整数还大）\n' "$PREVIEW_PORT_MAX"; return 1; fi
    [ "$rc" = 0 ] || { printf '端口算不出来\n'; return 1; }
    # 公开端口已越界就不必再加偏移；没越界时先查加法不溢出再加
    why="$(_pp_port_problem 公开端口 "$port")" || { printf '%s\n' "$why"; return 1; }
    [ "$3" -le $(( PREVIEW_I64 - port )) ] || { printf '后端端口超出 1 到 %s（比 bash 能表示的最大整数还大）\n' "$PREVIEW_PORT_MAX"; return 1; }
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
