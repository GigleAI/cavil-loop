#!/usr/bin/env bash
# Negative controls for client/ (GitHub#103 convention, tests/lib/mutation.sh):
#
#   bash test/mutation/run.sh                       -> checks every entry's source text and named test
#                                                      still exist (nothing run), then counts only:
#                                                      "负对照：跳过 N 项"
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

# GitHub#649: every call to the runner goes through `call`, in this shell (never inside $(…), a pipe
# or ( … ): the exit there would end only a subshell). Each call says where the runner's stdout goes:
# "-" = shown as it is, or a file this script reads after looking at the exit code. CLEANUP_FAILED
# (the value run.mjs exports) means the runner's processes could not be confirmed gone: the whole
# run stops there, nothing after it is started.
CLEANUP_FAILED=75
out_tmp="$(mktemp "${TMPDIR:-/tmp}/cavil-client-mut-out-XXXXXX")"
rc=0
call() {
    local what="$1" dest="$2"
    shift 2
    rc=0
    if [ "$dest" = - ]; then
        "$node" "$here/run.mjs" "$@" || rc=$?
    else
        "$node" "$here/run.mjs" "$@" > "$dest" || rc=$?
    fi
    if [ "$rc" -eq "$CLEANUP_FAILED" ]; then
        echo "❌ 收尾失败（${what}），停止整晚运行，后面的步骤都没有跑"
        rm -f "$out_tmp"
        exit "$CLEANUP_FAILED"
    fi
}

call "读负对照清单" "$out_tmp" --count
if [ "$rc" -ne 0 ]; then echo "❌ 读不到负对照清单（退出码 $rc）"; rm -f "$out_tmp"; exit 1; fi
n="$(cat "$out_tmp")"
[[ "$n" =~ ^[0-9]+$ ]] && [ "$n" -gt 0 ] || { echo "❌ 读不到负对照清单（得到 [$n]）"; rm -f "$out_tmp"; exit 1; }

if ! mutation_on; then
    # the PR checks run this step: code an entry breaks, or a test it names, changed without
    # updating the list goes red here, in that pull request, instead of in the next nightly run
    # on main (GitHub#527: PR #481 left both kinds behind)
    call "核对清单原文" - --check
    [ "$rc" -eq 0 ] || { echo "❌ 清单要改坏的原文核对没通过"; rm -f "$out_tmp"; exit 1; }
    call "核对清单点名" - --names
    [ "$rc" -eq 0 ] || { echo "❌ 清单点名的测试核对没通过"; rm -f "$out_tmp"; exit 1; }
    rm -f "$out_tmp"
    for ((i = 0; i < n; i++)); do mutation_gate || true; done
    echo "负对照：跳过 $MUTATION_COUNT 项（默认不跑；npm run test:mutation 打开，只跑和改动相关的用 npm run test:mutation -- --changed）"
    exit 0
fi

state="$(mktemp -d "${TMPDIR:-/tmp}/cavil-client-mut-state-XXXXXX")"
trap 'rm -rf "$state" "$out_tmp"' EXIT
export CLIENT_MUT_STATE="$state"

if [ "$scope" = --changed ]; then
    call "判断改动" "$state/changes.json" --changes
    [ "$rc" -eq 0 ] || { echo "❌ 判断不了这次改了什么，一项负对照都没跑"; exit 1; }
fi
call "基线" - --baseline
[ "$rc" -eq 0 ] || { echo "❌ 基线没通过，负对照的结果不可信，停止"; exit 1; }
call "挑选负对照项目" "$out_tmp" --select "$scope"
[ "$rc" -eq 0 ] || { echo "❌ 判断不了哪些负对照相关，一项都没跑"; exit 1; }
read -r -a idx < "$out_tmp" || true
if [ "${#idx[@]}" -eq 0 ]; then
    echo "负对照：本次改动没有相关负对照（共 $n 项，一项都没跑）"
    exit 0
fi
call "界面基线" - --baseline-e2e "${idx[@]}"
[ "$rc" -eq 0 ] || { echo "❌ 界面基线没通过，负对照的结果不可信，停止"; exit 1; }

failed=0
for i in "${idx[@]}"; do
    [[ "$i" =~ ^[0-9]+$ ]] || { echo "❌ 挑出的编号不对：[$i]"; exit 1; }
    mutation_gate || continue
    call "第 $i 项（已经跑了 $MUTATION_COUNT 项）" - --one "$i"
    [ "$rc" -eq 0 ] || failed=$((failed + 1))
done

[ "$scope" = --changed ] && what="和本次改动相关的" || what="全部"
echo "负对照：本次跑了 $MUTATION_COUNT 项（${what}，共 $n 项），$((MUTATION_COUNT - failed)) 项按预期变红，$failed 项失败"
[ "$failed" -eq 0 ]
