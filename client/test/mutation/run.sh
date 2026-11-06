#!/usr/bin/env bash
# Negative controls for client/ (GitHub#103 convention, tests/lib/mutation.sh):
#
#   bash test/mutation/run.sh                       -> counts only: "负对照：跳过 N 项"
#   MUTATION=1 bash test/mutation/run.sh            -> baseline first, then every entry
#   MUTATION=1 bash test/mutation/run.sh --changed  -> baseline first, then only the entries this
#                                                      change could affect (GitHub#178; select.mjs)
#
# Each entry that runs passes `mutation_gate` once, so "skipped N" and "ran N" come from the same
# counter. The per-entry work (copy, break one spot, run that entry's test files, require the
# named assertions to fail) is in run.mjs.
#
# --changed has three outcomes, kept apart: N related entries (run them) / nothing related (says
# which files changed, exit 0, nothing ran) / cannot tell (git or the base cannot be read: exit 1).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../../tests/lib/mutation.sh
source "$here/../../../tests/lib/mutation.sh"

scope=--all
case "${1:-}" in
    '') ;;
    --changed) scope=--changed ;;
    *) echo "用法：bash test/mutation/run.sh [--changed]（实得 [$1]）" >&2; exit 2 ;;
esac

node="$(command -v node)"
n="$("$node" "$here/run.mjs" --count)"
[[ "$n" =~ ^[0-9]+$ ]] && [ "$n" -gt 0 ] || { echo "❌ 读不到负对照清单（得到 [$n]）"; exit 1; }

if ! mutation_on; then
    for ((i = 0; i < n; i++)); do mutation_gate || true; done
    echo "负对照：跳过 $MUTATION_COUNT 项（默认不跑；npm run test:mutation 打开，只跑和改动相关的用 npm run test:mutation -- --changed）"
    exit 0
fi

state="$(mktemp -d "${TMPDIR:-/tmp}/cavil-client-mut-state-XXXXXX")"
trap 'rm -rf "$state"' EXIT
export CLIENT_MUT_STATE="$state"

if [ "$scope" = --changed ]; then
    "$node" "$here/run.mjs" --changes > "$state/changes.json" || { echo "❌ 判断不了这次改了什么，一项负对照都没跑"; exit 1; }
fi
"$node" "$here/run.mjs" --baseline || { echo "❌ 基线没通过，负对照的结果不可信，停止"; exit 1; }
picked="$("$node" "$here/run.mjs" --select "$scope")" || { echo "❌ 判断不了哪些负对照相关，一项都没跑"; exit 1; }
read -r -a idx <<< "$picked"
if [ "${#idx[@]}" -eq 0 ]; then
    echo "负对照：本次改动没有相关负对照（共 $n 项，一项都没跑）"
    exit 0
fi
"$node" "$here/run.mjs" --baseline-e2e "${idx[@]}" || { echo "❌ 界面基线没通过，负对照的结果不可信，停止"; exit 1; }

failed=0
for i in "${idx[@]}"; do
    [[ "$i" =~ ^[0-9]+$ ]] || { echo "❌ 挑出的编号不对：[$i]"; exit 1; }
    mutation_gate || continue
    "$node" "$here/run.mjs" --one "$i" || failed=$((failed + 1))
done

[ "$scope" = --changed ] && what="和本次改动相关的" || what="全部"
echo "负对照：本次跑了 $MUTATION_COUNT 项（${what}，共 $n 项），$((MUTATION_COUNT - failed)) 项按预期变红，$failed 项失败"
[ "$failed" -eq 0 ]
