#!/usr/bin/env bash
# 验算「合并前必须人过目的文件」清单（GitHub#560）：照给定的清单值和测试文件豁免开关，daemon 的托管合并检查
# 拦不拦这些路径。只读：不读 GitHub、不读项目配置、不写任何文件；判断用的是合并检查同一份规则（_human_paths.sh）。
#
# 用法：
#   bash human-paths-check.sh --spec '<AUTOPILOT_HUMAN_PATHS 的值>' --exempt-tests on|off <仓库内相对路径>...
#
# 每个路径输出一行（制表符分隔）：
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
    echo "用法：bash $(basename "$0") --spec '<清单值>' --exempt-tests on|off <路径>..." >&2
    exit 2
}

spec="" spec_set="" ex=""
while [ $# -gt 0 ]; do
    case "$1" in
        --spec) [ $# -ge 2 ] || usage; spec="$2"; spec_set=1; shift 2 ;;
        --exempt-tests) [ $# -ge 2 ] || usage; ex="$2"; shift 2 ;;
        --) shift; break ;;
        -*) usage ;;
        *) break ;;
    esac
done
[ -n "$spec_set" ] || usage
case "$ex" in on|off) ;; *) usage ;; esac
[ $# -gt 0 ] || usage

paths=()
for p in "$@"; do
    p="${p#./}"
    case "$p" in
        ""|/*) echo "路径要写成仓库内的相对路径：「${p}」" >&2; exit 2 ;;
        *$'\n'*|*$'\t'*) echo "路径里不能有换行或制表符" >&2; exit 2 ;;
    esac
    case "/$p/" in
        */../*|*/./*|*//*) echo "路径里不能有 . / .. 段或空段：「${p}」" >&2; exit 2 ;;
    esac
    paths+=("$p")
done

# shellcheck source=_human_paths.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_human_paths.sh"

if ! out=$(printf '%s\n' "${paths[@]}" | jq -Rr --arg spec "$spec" --arg def "$AUTOPILOT_HUMAN_PATHS_DEFAULT" --arg ex "$ex" \
        "$AUTOPILOT_PATHS_JQ"'
        [., inputs] as $ps | rules($spec; $def) as $rs
        | ($rs | map(select(.bad))) as $bad
        | if ($bad | length) > 0 then "bad\t\($bad[0].raw)（\($bad[0].bad)）"
          else ($rs | map(.re)) as $res
            | [$ps[] | [., path_verdict($res; $ex)]] | .[] | "\(.[1])\t\(.[0])"
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
