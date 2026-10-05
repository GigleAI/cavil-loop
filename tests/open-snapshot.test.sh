#!/usr/bin/env bash
# 本轮 open 快照（`open_snapshot` / `snapshot_rows`）的守卫。
#
# 跑法：bash tests/open-snapshot.test.sh
# 依赖：jq。不碰网络——gh 被替换成受控 stub，顺便数它被调了几次。
#
# 为什么要有这个文件：这层缓存是为了省 API 调用而加的，但它坐在**取工**和**回收**
# 中间，错了的两个方向都不会报错：
#   · 缓存太黏（该刷新时没刷新）→ 回收拿着过期名单去 kill 正在干活的 worker；
#   · 过滤写错（label 筛漏 / PR 条目混进 issue）→ 活悄悄不派，或者同一条活派两次。
# 再加一条：坏响应绝不能进缓存——进去了，本轮后面每一个判断都建立在它上面。
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"

TMP_CONF=$(mktemp -d)/coding-agent.config
SANDBOX="$(dirname "$TMP_CONF")"
cat > "$TMP_CONF" <<CONF
REPO="example/snap"
PROJECT_ROOT="$SANDBOX/project"
WORKTREE_BASE="$SANDBOX/wt"
STATE_DIR="$SANDBOX/state"
TMUX_PREFIX="snaptest"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
LABEL_AGENT_DOING="doing/agent"
CONF
mkdir -p "$SANDBOX/state" "$SANDBOX/project" "$SANDBOX/wt"

export CODING_AGENT_CONFIG="$TMP_CONF"
# ⚠️ 同 reap / greedy 测试：_lib.sh 顶部的 `exec 9>&- 2>/dev/null` 会永久吞掉调用方
# stderr，source 前后自己倒一手 fd 2，否则这个测试挂了会「无输出 + exit 1」没法查。
exec 8>&2
# shellcheck source=../scripts/_lib.sh
source "$REPO_DIR/scripts/_lib.sh"
exec 2>&8 8>&-
set +e

cleanup() { rm -rf "$(dirname "$TMP_CONF")"; }
trap cleanup EXIT

pass=0; fail=0
chk() {
    if [ "$2" = "$3" ]; then echo "  ✅ $1"; pass=$((pass+1))
    else echo "  ❌ $1 (期望 [$3]，实得 [$2])"; fail=$((fail+1)); fi
}

# ⚠️ 计数必须落文件：snapshot_rows 内部是 `pages=$(open_snapshot ...)`，命令替换开子
# shell，stub 里 `GH_CALLS=$((GH_CALLS+1))` 加的是子 shell 的副本，回不到这里。
# （同一个坑正是 open_snapshot 本身把缓存放文件而不是变量的原因。）
GH_COUNT="$SANDBOX/gh.count"
gh_calls() { [ -f "$GH_COUNT" ] && wc -l < "$GH_COUNT" | tr -d ' ' || echo 0; }
# issues endpoint 故意混进一条 PR 条目（带 .pull_request）——真实 REST /issues 就是
# 这样返回的，漏了这个 select 会把 PR 当 issue 派一遍工。
ISSUE_PAGES='[[{"number":11,"updated_at":"2026-01-01T00:00:00Z","title":"first","labels":[{"name":"pending/agent"}]},
               {"number":12,"updated_at":"2026-01-02T00:00:00Z","title":"tab\there","labels":[]}],
              [{"number":13,"updated_at":"2026-01-03T00:00:00Z","title":"pr-in-issues","labels":[{"name":"pending/agent"}],"pull_request":{"url":"x"}}]]'
PR_PAGES='[[{"number":21,"head":{"ref":"feature/issue-11"},"updated_at":"2026-01-04T00:00:00Z","title":"pr one","labels":[{"name":"pending/agent"},{"name":"doing/agent"}]}]]'

gh() {
    echo x >> "$GH_COUNT"
    case "$*" in
        *"repos/$REPO/issues"*) printf '%s\n' "$ISSUE_PAGES" ;;
        *"repos/$REPO/pulls"*)  printf '%s\n' "$PR_PAGES" ;;
        *) return 1 ;;
    esac
}

new_tick() { rm -rf "$TICK_DIR"; : > "$GH_COUNT"; }

echo "【1】一轮之内只拉一次，后面全走缓存"
new_tick
snapshot_rows issue "" >/dev/null
snapshot_rows issue "pending/agent" >/dev/null
snapshot_rows pr "" >/dev/null
snapshot_rows pr "pending/agent" >/dev/null
chk "4 次取行 = 2 次 gh（issues + pulls 各一次）" "$(gh_calls)" "2"

echo "【2】fresh 绕过缓存——回收前那次重读靠它拿到此刻真值"
new_tick
snapshot_rows issue "" >/dev/null          # 建缓存：1 次
chk "建缓存"                    "$(gh_calls)" "1"
open_snapshot issues >/dev/null            # 命中缓存：不增
chk "再读走缓存"                "$(gh_calls)" "1"
open_snapshot issues fresh >/dev/null      # 强制刷新：+1
chk "fresh 真的重新拉"          "$(gh_calls)" "2"

echo "【3】label 过滤等价于原来的服务端 ?labels="
new_tick
chk "issue 带 label"  "$(snapshot_rows issue "pending/agent" | cut -f1 | tr '\n' ',')" "11,"
chk "issue 不带 label（全量）" "$(snapshot_rows issue "" | cut -f1 | tr '\n' ',')" "11,12,"
chk "PR 带 label"     "$(snapshot_rows pr "doing/agent" | cut -f1 | tr '\n' ',')" "21,"
chk "label 不存在时为空" "$(snapshot_rows issue "nope" | tr -d '\n')" ""

echo "【4】/issues 里的 PR 条目不能混进 issue 行"
new_tick
chk "13 号（带 pull_request）被排除" "$(snapshot_rows issue "" | cut -f1 | grep -c '^13$')" "0"

echo "【5】TSV 五列格式跟改造前逐字段一致"
new_tick
# issue：分支列恒为 "-"；PR：分支列是 head.ref。标题里的 tab 要被换成空格，
# 否则它会把自己劈成新的一列，下游 read -r 的字段全部错位。
chk "issue 行"  "$(snapshot_rows issue "pending/agent" | head -1 | tr '\t' '|')" "11|-|2026-01-01T00:00:00Z|pending/agent|first"
chk "PR 行"     "$(snapshot_rows pr "doing/agent" | head -1 | tr '\t' '|')" "21|feature/issue-11|2026-01-04T00:00:00Z|pending/agent,doing/agent|pr one"
chk "标题里的 tab 被压成空格" "$(snapshot_rows issue "" | sed -n 2p | tr '\t' '|')" "12|-|2026-01-02T00:00:00Z||tab here"

echo "【6】坏响应不落缓存，下一次还会重试（而不是一直吃着坏数据）"
new_tick
ISSUE_PAGES='not json at all'
snapshot_rows issue "" >/dev/null 2>&1
chk "坏响应返回非 0"        "$?" "1"
chk "坏响应没写进缓存"      "$([ -s "$TICK_DIR/issues.json" ] && echo yes || echo no)" "no"
ISSUE_PAGES='[[{"number":11,"updated_at":"2026-01-01T00:00:00Z","title":"first","labels":[]}]]'
chk "恢复后立刻能读到"      "$(snapshot_rows issue "" | cut -f1)" "11"

echo "【7】顶层不是数组的响应同样要挡住（半截 / 单对象）"
new_tick
ISSUE_PAGES='{"message":"Not Found"}'
snapshot_rows issue "" >/dev/null 2>&1
chk "单个对象被拒"          "$?" "1"
new_tick
ISSUE_PAGES='[{"number":11}]'
snapshot_rows issue "" >/dev/null 2>&1
chk "少一层（没 slurp 成页数组）被拒" "$?" "1"

echo
echo "通过 $pass / 失败 $fail"
[ "$fail" -eq 0 ]
