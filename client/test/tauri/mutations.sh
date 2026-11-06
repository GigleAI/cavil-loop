#!/usr/bin/env bash
# Negative controls for the real-window test (test/tauri; GitHub#103 convention, tests/lib/mutation.sh):
#
#   bash test/tauri/mutations.sh             -> counts only: "真实窗口负对照：跳过 N 项"
#   MUTATION=1 bash test/tauri/mutations.sh  -> every entry: break one shell handler, rebuild the real
#                                              app, require test/tauri to fail at that handler's step
#   MUTATION=1 bash test/tauri/mutations.sh --changed
#                                           -> the same, but only when this change touches the app shell,
#                                              its config or test/tauri (GitHub#178); otherwise says so and
#                                              runs nothing; git unreadable = exit 1
#
# Each entry passes `mutation_gate` once. Preparation, build or runner failures count as failed
# entries and make this script exit non-zero. The per-entry work is in mutations.mjs.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../../tests/lib/mutation.sh
source "$here/../../../tests/lib/mutation.sh"

scope=all
case "${1:-}" in
    '') ;;
    --changed) scope=changed ;;
    *) echo "用法：bash test/tauri/mutations.sh [--changed]（实得 [$1]）" >&2; exit 2 ;;
esac

node="$(command -v node)"
n="$("$node" "$here/mutations.mjs" --count)"
[[ "$n" =~ ^[0-9]+$ ]] && [ "$n" -gt 0 ] || { echo "❌ 读不到真实窗口负对照清单（得到 [$n]）"; exit 1; }

if mutation_on && [ "$scope" = changed ]; then
    rc=0; "$node" "$here/mutations.mjs" --related || rc=$?
    case "$rc" in
        0) ;;
        1) echo "真实窗口负对照：本次改动没有相关项（共 $n 项，一项都没跑）"; exit 0 ;;
        *) echo "❌ 判断不了这次改了什么，一项真实窗口负对照都没跑"; exit 1 ;;
    esac
fi

failed=0
for ((i = 0; i < n; i++)); do
    mutation_gate || continue
    "$node" "$here/mutations.mjs" --one "$i" || failed=$((failed + 1))
done

if mutation_on; then
    echo "真实窗口负对照：本次跑了 $MUTATION_COUNT 项，$((MUTATION_COUNT - failed)) 项按预期变红，$failed 项失败"
    [ "$failed" -eq 0 ]
else
    echo "真实窗口负对照：跳过 $MUTATION_COUNT 项（默认不跑；MUTATION=1 bash test/tauri/mutations.sh 打开）"
fi
