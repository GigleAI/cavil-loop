#!/usr/bin/env bash
# Negative controls for client/ (GitHub#103 convention, tests/lib/mutation.sh):
#
#   bash test/mutation/run.sh             -> counts only: "负对照：跳过 N 项"
#   MUTATION=1 bash test/mutation/run.sh  -> baseline first, then every entry
#
# Each entry passes `mutation_gate` once, so "skipped N" and "ran N" come from
# the same counter. The per-entry work (copy, break one spot, run vitest,
# require the named assertions to fail) is in run.mjs.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../../tests/lib/mutation.sh
source "$here/../../../tests/lib/mutation.sh"

node="$(command -v node)"
n="$("$node" "$here/run.mjs" --count)"
[[ "$n" =~ ^[0-9]+$ ]] && [ "$n" -gt 0 ] || { echo "❌ 读不到负对照清单（得到 [$n]）"; exit 1; }

failed=0
if mutation_on; then
    "$node" "$here/run.mjs" --baseline || { echo "❌ 基线没通过，负对照的结果不可信，停止"; exit 1; }
fi
for ((i = 0; i < n; i++)); do
    mutation_gate || continue
    "$node" "$here/run.mjs" --one "$i" || failed=$((failed + 1))
done

if mutation_on; then
    echo "负对照：本次跑了 $MUTATION_COUNT 项，$((MUTATION_COUNT - failed)) 项按预期变红，$failed 项失败"
    [ "$failed" -eq 0 ]
else
    echo "负对照：跳过 $MUTATION_COUNT 项（默认不跑；MUTATION=1 npm run test:mutation 打开）"
fi
