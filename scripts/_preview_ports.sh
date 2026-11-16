# shellcheck shell=bash
# 预览端口的算法和「算出来的端口能不能用」：唯一的一份（GitHub#556 复审第 1 轮）。
#
# 两个读者：
#   · _lib.sh（preview_port，preview-serve.sh 注册前的检查）——真正算端口、真正注册的那条路
#   · project-config.sh（保存起始号 / 取余数 / 后端偏移时的组合检查）——窗口里存值的那条路
# 起始号、取余数、偏移三项各自在范围里，不等于算出来的端口在范围里：起始号 6000、偏移 65535，
# #1 的后端端口就是 71536。所以这两条路都问这里，不各写一份。
#
# 只用 bash 内建，macOS 自带的 bash 3.2 也能跑（project-config.sh 由桌面客户端在 macOS 上调用）。

PREVIEW_PORT_MAX=65535

# preview_port_calc <起始号> <取余数，空 = 不取> <issue 编号> → 公开端口
preview_port_calc() {
    if [ -n "$2" ]; then
        echo $(( $1 + $3 % $2 ))
    else
        echo $(( $1 + $3 ))
    fi
}

# preview_port_problem <公开端口> <后端端口> → 能用时不输出、返回 0；不能用时输出原因、返回 1
# 不是规范十进制数字（含空值、位数过多）也算不能用：不交给算术，免得回绕成一个像样的数
preview_port_problem() {
    local what p
    for what in "公开端口:$1" "后端端口:$2"; do
        p="${what#*:}"
        case "$p" in ''|*[!0-9]*|0?*) printf '%s %s 不是 1 到 %s 之间的端口号\n' "${what%%:*}" "${p:-（空）}" "$PREVIEW_PORT_MAX"; return 1 ;; esac
        if [ "${#p}" -gt 5 ] || [ "$p" -lt 1 ] || [ "$p" -gt "$PREVIEW_PORT_MAX" ]; then
            printf '%s %s 超出 1 到 %s\n' "${what%%:*}" "$p" "$PREVIEW_PORT_MAX"; return 1
        fi
    done
    return 0
}

# preview_ports_save_problem <起始号> <取余数，空 = 不取> <后端偏移> → 保存前的组合检查
# 三项都已按各自的范围校验过（起始号 1–65535、取余数 1–65535 或空、偏移 1–65535）。
#   配了取余数：所有 issue 的端口落在「起始号 + 0」到「起始号 + 取余数 − 1」，最大的那个连同后端端口都要能用
#   没配取余数：端口随 issue 编号一直往上加，保存时只能保证最小的 #1 能用；更大的编号越界时由注册前的检查拦下并说明
preview_ports_save_problem() {
    local base="$1" mod="$2" off="$3" lo hi why
    if [ -n "$mod" ]; then lo="$base"; hi=$(( base + mod - 1 )); else lo=$(( base + 1 )); hi="$lo"; fi
    if ! why="$(preview_port_problem "$lo" $(( lo + off )))"; then
        printf '按这组设置，最小的端口就不能用（%s）\n' "$why"; return 1
    fi
    if ! why="$(preview_port_problem "$hi" $(( hi + off )))"; then
        printf '按这组设置，最大的端口不能用（%s）：起始号 + 取余数 − 1 + 后端偏移不能超过 %s\n' "$why" "$PREVIEW_PORT_MAX"; return 1
    fi
    return 0
}
