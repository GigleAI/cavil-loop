#!/usr/bin/env bash
# kind: unit
# 哪条前置登记算数（GitHub#429）：daemon 的 blocked_mark_pick 跑共享样例 tests/fixtures/blocked-marks.json。
#
# 跑法：bash tests/blocked-mark-parse.test.sh
# 依赖：bash、jq。不碰网络。
#
# 客户端关系图按同一套规则读评论里的 loop 登记（client/src/data/loopBlocked.ts），客户端单元测试
# （client/test/unit/loop-blocked.test.ts）拿同一份样例、同一份期望跑客户端的实现。两边都等于同一份
# 期望，就保证两边判的是同一条登记——只改一边，必有一边红。
# 这里跑的是 scripts/_lib.sh 里真实的函数（source 整个库），评论按 REST 的真实形状、按
# `gh api --paginate --slurp` 的「页的数组」喂进去，和 blocked_decide 里的调用一样。
set -uo pipefail
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
FIX="$TEST_DIR/fixtures/blocked-marks.json"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
cat > "$TMP/c.config" <<CONF
REPO="GigleAI/cavil-loop"
PROJECT_ROOT="$TMP/project"
WORKTREE_BASE="$TMP/wt"
STATE_DIR="$TMP/state"
TMUX_PREFIX="marktest"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
BASE_BRANCH="main"
CONF
mkdir -p "$TMP/state" "$TMP/wt" "$TMP/project"
export HOME="$TMP" CODING_AGENT_CONFIG="$TMP/c.config"
unset CODING_AGENT_RELEASE_ROOT
exec 8>&2
# shellcheck source=../scripts/_lib.sh
source "$REPO_DIR/scripts/_lib.sh"
exec 2>&8 8>&-
set +e

pass=0
fail=0
chk() {
    if [ "$2" = "$3" ]; then pass=$((pass + 1)); echo "  ✓ $1"
    else fail=$((fail + 1)); echo "  ✗ $1"; echo "      期望：$3"; echo "      实得：$2"; fi
}

self=$(jq -r .self "$FIX")
me=$(jq -r .me "$FIX")
n=$(jq '.cases | length' "$FIX")
chk "样例至少 10 条（防止样例文件被清空后两边空对空）" "$([ "$n" -ge 10 ] && echo yes)" yes
for i in $(seq 0 $((n - 1))); do
    name=$(jq -r ".cases[$i].name" "$FIX")
    since=$(jq -r ".cases[$i].since" "$FIX")
    want=$(jq -c ".cases[$i].want | sort_by(.r, .n)" "$FIX")
    got=$(jq -c "[.cases[$i].comments]" "$FIX" | blocked_mark_pick "$me" "$self" "$since" | jq -c '.set | sort_by(.r, .n)')
    chk "$name" "$got" "$want"
done

# 「到达性」：同一份样例里确实有判出前置的、也有判出空的，不是全空
nonempty=$(jq '[.cases[] | select(.want | length > 0)] | length' "$FIX")
chk "样例里有判出前置的用例" "$([ "$nonempty" -ge 5 ] && echo yes)" yes

echo
echo "通过 $pass，失败 $fail"
report_counts "$pass" "$fail"
[ "$fail" -eq 0 ]
