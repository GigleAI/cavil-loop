#!/usr/bin/env bash
# 验算「合并前必须人过目的文件」清单（GitHub#560）：照给定的清单值和测试文件豁免开关，daemon 的托管合并检查
# 拦不拦这些路径。只读：不读 GitHub、不读项目配置、不写任何文件；判断用的是合并检查同一份规则（_human_paths.sh）。
#
# 用法：
#   bash human-paths-check.sh --spec '<AUTOPILOT_HUMAN_PATHS 的值>' --exempt-tests on|off [<仓库内相对路径>...] \
#       [--renamed <旧路径> <新路径>]...
#
# 每一项按一条改动记录判，和合并检查对 GitHub 改动文件列表里的一项判法相同（_human_paths.sh 的 rec_verdict）：
# 单个路径 = 修改（新增、删除也一样）；改名 / 复制的文件用 --renamed 把新旧路径一起交进来——测试文件豁免看的是
# 「新旧路径都算测试文件」，拆成两个路径分别判会得出和合并检查不一样的结论。
#
# 每一项输出一行（制表符分隔；改名的那一项写成「旧路径 -> 新路径」）：
#   拦<TAB><路径>                      命中清单，只改它的托管 PR 会交人
#   不拦<TAB><路径><TAB>不在清单里
#   不拦<TAB><路径><TAB>测试文件豁免（命中清单）       名字算测试文件、豁免开着，合并检查不拿它去比
#   不拦<TAB><路径><TAB>测试文件豁免（也不在清单里）   同上，而且关了豁免也不命中
# 退出码：0 = 全部拦；1 = 至少一个不拦；2 = 用法错误、清单里有写法不认识的条目（这时 daemon 每次托管合并都交人）、
# 或 jq 跑不起来。2 的时候不输出逐路径结论。
#
# --exempt-tests 只收 on / off：daemon 里不写这一行、写成空或 "on" 都是 on，其余任何值都是 off。
set -euo pipefail

usage() {
    echo "用法：bash $(basename "$0") --spec '<清单值>' --exempt-tests on|off [<路径>...] [--renamed <旧路径> <新路径>]..." >&2
    exit 2
}

# 一个路径的写法检查，通过就打印规整后的路径
norm_path() {   # <路径>
    local p="${1#./}"
    case "$p" in
        ""|/*) echo "路径要写成仓库内的相对路径：「${p}」" >&2; return 1 ;;
        *$'\n'*|*$'\t'*) echo "路径里不能有换行或制表符" >&2; return 1 ;;
    esac
    case "/$p/" in
        */../*|*/./*|*//*) echo "路径里不能有 . / .. 段或空段：「${p}」" >&2; return 1 ;;
    esac
    printf '%s\n' "$p"
}

# 每一项是一条改动记录，和 GitHub 改动文件列表的一项同形：单个路径 = 修改；--renamed = 改名 / 复制（新旧路径一起判）
spec="" spec_set="" ex="" recs=()
while [ $# -gt 0 ]; do
    case "$1" in
        --spec) [ $# -ge 2 ] || usage; spec="$2"; spec_set=1; shift 2 ;;
        --exempt-tests) [ $# -ge 2 ] || usage; ex="$2"; shift 2 ;;
        --renamed)
            [ $# -ge 3 ] || usage
            old=$(norm_path "$2") || exit 2; new=$(norm_path "$3") || exit 2
            recs+=("$(jq -cn --arg f "$new" --arg o "$old" '{filename: $f, previous_filename: $o}')"); shift 3 ;;
        --) shift; while [ $# -gt 0 ]; do p=$(norm_path "$1") || exit 2; recs+=("$(jq -cn --arg f "$p" '{filename: $f}')"); shift; done ;;
        -*) usage ;;
        *) p=$(norm_path "$1") || exit 2; recs+=("$(jq -cn --arg f "$p" '{filename: $f}')"); shift ;;
    esac
done
[ -n "$spec_set" ] || usage
case "$ex" in on|off) ;; *) usage ;; esac
[ "${#recs[@]}" -gt 0 ] || usage

# shellcheck source=_human_paths.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_human_paths.sh"

if ! out=$(printf '%s\n' "${recs[@]}" | jq -nr --arg spec "$spec" --arg def "$AUTOPILOT_HUMAN_PATHS_DEFAULT" --arg ex "$ex" \
        "$AUTOPILOT_PATHS_JQ"'
        [inputs] as $rs0 | rules($spec; $def) as $rs
        | ($rs | map(select(.bad))) as $bad
        | if ($bad | length) > 0 then "bad\t\($bad[0].raw)（\($bad[0].bad)）"
          else ($rs | map(.re)) as $res
            | $rs0[] | "\(rec_verdict($res; $ex))\t\(if .previous_filename then "\(.previous_filename) -> \(.filename)" else .filename end)"
          end' 2>&1); then
    echo "验算失败（jq）：$out" >&2
    exit 2
fi

rc=0
while IFS=$'\t' read -r v p; do
    case "$v" in
        bad) echo "清单里有写法不认识的条目：${p}——这时 daemon 每次托管合并都交人，先改好清单再验算" >&2; exit 2 ;;
        hit) printf '拦\t%s\n' "$p" ;;
        miss) printf '不拦\t%s\t不在清单里\n' "$p"; rc=1 ;;
        exempt-hit) printf '不拦\t%s\t测试文件豁免（命中清单）\n' "$p"; rc=1 ;;
        exempt-miss) printf '不拦\t%s\t测试文件豁免（也不在清单里）\n' "$p"; rc=1 ;;
        *) echo "验算失败：认不出的结论「${v}」" >&2; exit 2 ;;
    esac
done <<< "$out"
exit "$rc"
