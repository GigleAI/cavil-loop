#!/usr/bin/env bash
# 公网资产目录的占用统计（GitHub#613，只读：不删、不改、不写任何文件）。
#
#   bash usage.sh            按项目、按条目列出占用（字节），旧结构里归不到项目的单列一行
#
# 目录取对外服务配置里的 PUBLIC_ASSETS_ROOT；另外把按名字推出来、但对外服务并不交出的那个目录
# 也单列（这里面的图公网拿不到）。删不删、删哪些，由人看过之后自己决定。
set -euo pipefail
HERE="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
# shellcheck source=../_names.sh
source "$HERE/../_names.sh"
CONF="${PUBLIC_ASSETS_CONF:-$(cavil_public_assets_conf)}"
PROJECT_DIRS="${PUBLIC_ASSETS_PROJECT_DIRS:-$(cavil_public_assets_project_dirs)}"

root=""
if [ -r "$CONF" ]; then
    root="$(grep -E '^PUBLIC_ASSETS_ROOT=' "$CONF" | tail -n 1 | sed -E 's/^[^=]*=//; s/^"//; s/"$//')" || root=""
fi
[ -n "$root" ] && [ -d "$root" ] || { echo "读不出对外服务的资产目录（$CONF 里的 PUBLIC_ASSETS_ROOT）" >&2; exit 1; }
root="$(readlink -f "$root")"
keys="$(node "$HERE/strict.mjs" keys ${PROJECT_DIRS//:/ })" || { echo "读不出登记的项目" >&2; exit 1; }

# 每个文件归到「项目 / 条目」或「旧结构」，按字节加起来（find 的 %s 是字节，%P 是相对路径）
find "$root" -mindepth 1 -name '.*' -prune -o -type f -printf '%s\t%P\n' | awk -F'\t' -v keys="$keys" '
    BEGIN { n = split(keys, k, "\n"); for (i = 1; i <= n; i++) if (k[i] != "") isk[k[i]] = 1 }
    {
        c = split($2, seg, "/")
        if (c == 3 && (seg[1] in isk) && seg[2] ~ /^([0-9]+|weekly-report)$/) { item[seg[1] "\t" seg[2]] += $1; proj[seg[1]] += $1 }
        else { legacy += $1; nlegacy++ }
        total += $1
    }
    END {
        printf "%-40s %15s\n", "项目 / 条目", "字节"
        for (p in proj) printf "%-40s %15d\n", p, proj[p] | "sort"
        close("sort")
        for (x in item) { split(x, a, "\t"); printf "  %-38s %15d\n", a[1] "/" a[2], item[x] | "sort" }
        close("sort")
        printf "%-40s %15d（%d 个文件）\n", "旧结构（未归属项目）", legacy, nlegacy
        printf "%-40s %15d\n", "合计", total
    }'
other="$(cavil_review_shots)"
if [ -d "$other" ] && [ "$(readlink -f "$other")" != "$root" ]; then
    printf '%-40s %15s（%s，这里的图公网拿不到）\n' "不对外的目录" "$(du -sb "$other" | cut -f1)" "$other"
fi
