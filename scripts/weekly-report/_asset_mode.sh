# shellcheck shell=bash
# 周报配图走哪条路（GitHub#613）：run.sh 和公网资产的切换命令共用这一条判断，不各读各的。
#   publish   配了出图地址（WEEKLY_REPORT_ASSET_ROOT_URL 加载后非空）→ 经发布命令发图
#   legacy    没配出图地址、只配了早期的周报图片地址（WEEKLY_REPORT_ASSET_URL 加载后非空）→ 旧路径
#   none      两个都没有（周报会直接报缺地址）
# 判断看的是配置**加载之后**的值，不是文件里的字面写法：`X=''`、`X=""`、同一键写了几次，都以加载结果为准。

weekly_asset_mode() {   # <出图地址> <早期的周报图片地址>
    if [ -n "${1:-}" ]; then printf 'publish\n'
    elif [ -n "${2:-}" ]; then printf 'legacy\n'
    else printf 'none\n'; fi
}

# 按周报加载项目配置的方式（set -a; . <文件>）在子进程里读一个配置，输出它的模式。
# 调用方环境里已有的这两个值不带进去（daemon 的环境里常常就有本项目的值）；读不出输出 unreadable。
weekly_asset_mode_of_conf() {   # <项目配置 <key>.conf>
    local out
    out="$(env -u WEEKLY_REPORT_ASSET_ROOT_URL -u WEEKLY_REPORT_ASSET_URL bash -c \
        'set -a; . "$1" >/dev/null 2>&1 || exit 3; printf "%s\n%s\n" "${WEEKLY_REPORT_ASSET_ROOT_URL:-}" "${WEEKLY_REPORT_ASSET_URL:-}"' \
        _ "$1" </dev/null 2>/dev/null)" || { printf 'unreadable\n'; return 0; }
    weekly_asset_mode "$(printf '%s\n' "$out" | sed -n 1p)" "$(printf '%s\n' "$out" | sed -n 2p)"
}
