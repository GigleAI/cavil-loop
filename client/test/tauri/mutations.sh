#!/usr/bin/env bash
# Negative controls for the real-window test (test/tauri; GitHub#103 convention, tests/lib/mutation.sh):
#
#   bash test/tauri/mutations.sh             -> counts only: "真实窗口负对照：跳过 N 项"
#   MUTATION=1 bash test/tauri/mutations.sh  -> every entry: break one shell handler, rebuild the real
#                                              app, require test/tauri to fail at that handler's step
#
# Each entry passes `mutation_gate` once. Preparation, build or runner failures count as failed
# entries and make this script exit non-zero. The per-entry work is in mutations.mjs.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../../tests/lib/mutation.sh
source "$here/../../../tests/lib/mutation.sh"

node="$(command -v node)"
n="$("$node" "$here/mutations.mjs" --count)"
[[ "$n" =~ ^[0-9]+$ ]] && [ "$n" -gt 0 ] || { echo "❌ 读不到真实窗口负对照清单（得到 [$n]）"; exit 1; }

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
