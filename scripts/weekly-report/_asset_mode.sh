# shellcheck shell=bash
# 项目配置里和出图有关的两个值，以及周报配图走哪条路（GitHub#613）。
# 读项目配置只有这一种方式，周报 run.sh、发布命令、公网资产的切换命令（预检和核验）都照它：
#   · 加载：`set -a; . <key>.conf`，和 systemd / 周报加载它的方式一样；
#   · 加载前去掉调用方环境里已有的同名值（daemon 和 worker 的环境里常常就有别的项目或本项目的值），
#     只看这份配置自己加载出来的结果——`X=''`、`X="..."`、`X='...'`、同一键写了几次，都以加载结果为准；
#   · 读不出（没有读权限、语法错）就是「读不出」，不当成「没配」。
# 哪些配置算「本机登记的项目」只认一处：scripts/public-assets/strict.mjs 的 keys（对外服务、核验、
# 统计、切换都用它；目录或文件读不出时它报错，调用方当「判断不了」）。

# 周报走哪条路：publish（配了出图地址）/ legacy（只配了早期的周报图片地址）/ none（两个都没有）
weekly_asset_mode() {   # <出图地址> <早期的周报图片地址>
    if [ -n "${1:-}" ]; then printf 'publish\n'
    elif [ -n "${2:-}" ]; then printf 'legacy\n'
    else printf 'none\n'; fi
}

# 在子进程里按上面的方式加载一个项目配置，输出两行：出图地址、早期的周报图片地址。读不出返回 1。
project_conf_load() {   # <项目配置 <key>.conf>
    [ -r "$1" ] || return 1
    env -u WEEKLY_REPORT_ASSET_ROOT_URL -u WEEKLY_REPORT_ASSET_URL bash -c \
        'set -a; . "$1" >/dev/null 2>&1 || exit 3; printf "%s\n%s\n" "${WEEKLY_REPORT_ASSET_ROOT_URL:-}" "${WEEKLY_REPORT_ASSET_URL:-}"' \
        _ "$1" </dev/null 2>/dev/null
}

# 一个项目配置的周报模式；读不出输出 unreadable
weekly_asset_mode_of_conf() {   # <项目配置 <key>.conf>
    local out
    out="$(project_conf_load "$1")" || { printf 'unreadable\n'; return 0; }
    weekly_asset_mode "$(printf '%s\n' "$out" | sed -n 1p)" "$(printf '%s\n' "$out" | sed -n 2p)"
}

# 当前 shell 里加载项目配置（周报 run.sh、发布命令用）：先去掉继承来的同名值，和 project_conf_load 同一口径
project_conf_source() {   # <项目配置 <key>.conf>
    unset WEEKLY_REPORT_ASSET_ROOT_URL WEEKLY_REPORT_ASSET_URL
    # shellcheck disable=SC1090
    set -a; . "$1"; set +a
}
