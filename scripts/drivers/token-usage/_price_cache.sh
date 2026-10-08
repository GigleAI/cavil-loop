# shellcheck shell=bash
# 两个计价驱动共用：缺价标记（GitHub#51）。
#
# 驱动跑在 worker 里，worker 不许访问 github.com 以外的地址，所以发现「某模型有用量却
# 没有单价」时**只在本机留一个空标记文件**，不联网；daemon 下一轮看到标记，再由
# price_fetch.py 去抓价。目录与 price_solve.cache_dir() 是同一个。
#
# 标记名 `<agent>--<model>`。模型名来自本机日志，只收 [A-Za-z0-9._-]、最长 100 字符，
# 其余一律不写——日志内容不能决定文件路径。写失败静默：标记只是提示，不能拖住评论 footer。

price_cache_dir() { printf '%s/cavil-loop' "${XDG_CACHE_HOME:-$HOME/.cache}"; }

# 抓来的单价缓存（fetched-prices.json）里某一侧的 {model: prices}；没有 / 坏掉 → {}
fetched_prices_json() {
    local f; f="$(price_cache_dir)/fetched-prices.json"
    [ -f "$f" ] || { echo '{}'; return; }
    jq -c --arg a "$1" '(.[$a] // {}) | with_entries(select(.value.prices | type == "object")
        | .value = .value.prices)' "$f" 2>/dev/null || echo '{}'
}

mark_unpriced() {
    local agent="$1" m dir; shift
    dir="$(price_cache_dir)/unpriced"
    for m in "$@"; do
        [[ "$m" =~ ^[A-Za-z0-9._-]{1,100}$ ]] || continue
        mkdir -p "$dir" 2>/dev/null && : > "$dir/$agent--$m" 2>/dev/null
    done
    return 0
}
