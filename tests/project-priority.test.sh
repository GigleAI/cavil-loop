#!/usr/bin/env bash
# GitHub Project (v2) 优先级来源的守卫（`project_priority_pairs` 解析 + `priority_rank` 取舍）。
#
# 跑法：bash tests/project-priority.test.sh
# 依赖：jq。**不碰网络**——`gh` 被换成读固定 fixture 的 shell 函数，所以这个测试
# 在没有 read:project scope 的机器上照样能跑（现实就是如此，见 docs/operations）。
#
# 为什么要有这个文件：这条链路上每一环坏了都是「悄悄排错序」而不是报错——
#   · 跨仓库串号：一个 Project 常挂多个仓库的卡片，编号会撞车，不按仓库过滤就会
#     拿别的仓库 #42 的优先级去排本仓库的 #42；
#   · 没设优先级的条目：必须落到**最后一档**，落成 0 会让整个看板的未分类项插队；
#   · 分页：Project 超过 100 项时只读第一页 = 后面的条目全体降级，且毫无迹象；
#   · 读不到时必须**降级不中断**：token 缺 scope 是常态，不能让派工整轮停摆。
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"

TMP=$(mktemp -d)
TMP_CONF="$TMP/coding-agent.config"
cat > "$TMP_CONF" <<CONF
REPO="acme/widget"
PROJECT_ROOT="$TMP/project"
WORKTREE_BASE="$TMP/wt"
STATE_DIR="$TMP/state"
TMUX_PREFIX="priotest"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
PRIORITY_LABELS="priority/p0,priority/p1,priority/p2"
CONF
mkdir -p "$TMP/state" "$TMP/project" "$TMP/wt"

export CODING_AGENT_CONFIG="$TMP_CONF"
exec 8>&2
# shellcheck source=../scripts/_lib.sh
source "$REPO_DIR/scripts/_lib.sh"
exec 2>&8 8>&-
set +e

trap 'rm -rf "$TMP"' EXIT

pass=0; fail=0
chk() {
    if [ "$2" = "$3" ]; then echo "  ✅ $1"; pass=$((pass+1))
    else echo "  ❌ $1 (期望 '$3'，实得 '$2')"; fail=$((fail+1)); fi
}

# ── 把 gh 换成按调用次序吐 fixture 的函数 ──
# 第 1 次 = 查仓库关联的 Project；第 2 次起 = 拉 items 分页。
CALL_N="$TMP/calls"; echo 0 > "$CALL_N"
gh() {
    local n; n=$(( $(cat "$CALL_N") + 1 )); echo "$n" > "$CALL_N"
    cat "$TMP/resp.$n" 2>/dev/null || { echo '{"errors":[{"message":"fixture 缺失"}]}'; return 1; }
}

item() {  # <编号> <仓库> <优先级名或 null>
    local v="null"; [ "$3" != "null" ] && v="{\"name\":\"$3\"}"
    printf '{"content":{"number":%s,"repository":{"nameWithOwner":"%s"}},"fieldValueByName":%s}' "$1" "$2" "$v"
}
page() {  # <hasNextPage> <cursor> <items...>
    local has="$1" cur="$2"; shift 2
    local joined; joined=$(printf '%s,' "$@"); joined="${joined%,}"
    printf '{"data":{"node":{"field":{"options":[{"name":"P0"},{"name":"P1"},{"name":"P2"}]},"items":{"pageInfo":{"hasNextPage":%s,"endCursor":"%s"},"nodes":[%s]}}}}' "$has" "$cur" "$joined"
}

echo "── 解析：过滤 / 空值 / 档位下标 ──"
echo '{"data":{"repository":{"projectsV2":{"nodes":[{"id":"PVT_1","number":7,"title":"board"}]}}}}' > "$TMP/resp.1"
page false "" "$(item 101 acme/widget P0)" \
            "$(item 102 acme/widget P2)" \
            "$(item 103 other/repo  P0)" \
            "$(item 104 acme/widget null)" > "$TMP/resp.2"
out=$(project_priority_pairs 2>/dev/null)
chk "P0 → 档位 0"                "$(grep -c '^101	0$' <<<"$out")"  "1"
chk "P2 → 档位 2"                "$(grep -c '^102	2$' <<<"$out")"  "1"
chk "别的仓库的卡片被过滤掉"      "$(grep -c '^103' <<<"$out")"      "0"
chk "没设优先级的不进表"          "$(grep -c '^104' <<<"$out")"      "0"
chk "吐出选项数（供最后一档用）"  "$(grep -c '^#options	3$' <<<"$out")" "1"

echo "── 解析：分页不能只读第一页 ──"
echo 0 > "$CALL_N"
echo '{"data":{"repository":{"projectsV2":{"nodes":[{"id":"PVT_1","number":7,"title":"board"}]}}}}' > "$TMP/resp.1"
page true  "CUR1" "$(item 201 acme/widget P0)" > "$TMP/resp.2"
page false ""     "$(item 202 acme/widget P1)" > "$TMP/resp.3"
out=$(project_priority_pairs 2>/dev/null)
chk "第一页的条目在"   "$(grep -c '^201	0$' <<<"$out")" "1"
chk "第二页的条目也在" "$(grep -c '^202	1$' <<<"$out")" "1"

echo "── 解析：拿不到 Project 要返回失败（好让调用方降级）──"
echo 0 > "$CALL_N"
echo '{"data":{"repository":{"projectsV2":{"nodes":[]}}}}' > "$TMP/resp.1"
project_priority_pairs >/dev/null 2>&1
chk "没有关联 Project → 非 0" "$([ $? -ne 0 ] && echo yes || echo no)" "yes"
echo 0 > "$CALL_N"
rm -f "$TMP/resp.1"
project_priority_pairs >/dev/null 2>&1
chk "GraphQL 报错 → 非 0"     "$([ $? -ne 0 ] && echo yes || echo no)" "yes"

echo "── 定位看板：自动挑 = 关联 Project 里编号最小的，且要报出挑了谁 ──"
echo 0 > "$CALL_N"
# API 即使乱序返回，也不能靠它的默认顺序 —— 查询里写死 orderBy=NUMBER ASC，
# 这里的 fixture 故意把 9 号放前面，断言取的是服务端给的第一个（= 编号最小的那个）
echo '{"data":{"repository":{"projectsV2":{"nodes":[{"id":"PVT_7","number":7,"title":"board7"},{"id":"PVT_9","number":9,"title":"board9"}]}}}}' > "$TMP/resp.1"
page false "" "$(item 301 acme/widget P1)" > "$TMP/resp.2"
out=$(project_priority_pairs 2>/dev/null)
chk "报出用了哪个看板" "$(grep -c '^#project	7 board7$' <<<"$out")" "1"
chk "照常吐条目"       "$(grep -c '^301	1$' <<<"$out")"            "1"

echo "── 定位看板：给了编号就按 <owner,number> 直取，org 找不到要换 user 再试 ──"
echo 0 > "$CALL_N"
PROJECT_NUMBER=4
PROJECT_OWNER=someone            # 个人看板 + 组织仓库：两个 owner 本来就不是一个人
# 第 1 次按 organization 查 → NOT_FOUND（个人 owner 走这个入口必然失败，要能忽略）
echo '{"data":{"organization":null},"errors":[{"type":"NOT_FOUND","message":"Could not resolve to an Organization"}]}' > "$TMP/resp.1"
# 第 2 次按 user 查 → 命中
echo '{"data":{"user":{"projectV2":{"id":"PVT_U4","number":4,"title":"my board"}}}}' > "$TMP/resp.2"
page false "" "$(item 401 acme/widget P0)" > "$TMP/resp.3"
out=$(project_priority_pairs 2>/dev/null)
chk "org 入口失败后回落到 user" "$(grep -c '^#project	4 my board$' <<<"$out")" "1"
chk "直取路径照常吐条目"        "$(grep -c '^401	0$' <<<"$out")"                "1"
echo 0 > "$CALL_N"
echo '{"data":{"organization":null},"errors":[{"type":"NOT_FOUND"}]}' > "$TMP/resp.1"
echo '{"data":{"user":null},"errors":[{"type":"NOT_FOUND"}]}' > "$TMP/resp.2"
project_priority_pairs >/dev/null 2>&1
chk "两个入口都没有 → 非 0"     "$([ $? -ne 0 ] && echo yes || echo no)" "yes"
PROJECT_NUMBER=""; PROJECT_OWNER=""

echo "── 取舍：priority_rank 在三种 source 下 ──"
PROJECT_PRIO=([101]=0 [102]=2)
_proj_rank_default=2          # 3 个选项 → 没设值的落最后一档
PRIORITY_SOURCE=label
chk "label 模式无视 Project 表"        "$(priority_rank "priority/p1" 101)" "1"
chk "label 模式没打标签 = 最后一档"    "$(priority_rank "" 101)"            "2"
PRIORITY_SOURCE=project
chk "project 模式用 Project 的档位"    "$(priority_rank "priority/p1" 101)" "0"
chk "project 模式无视 label"           "$(priority_rank "priority/p0" 102)" "2"
chk "project 模式没设值 = 最后一档"    "$(priority_rank "priority/p0" 999)" "2"
PRIORITY_SOURCE=both
chk "both：Project 设了就用 Project"   "$(priority_rank "priority/p2" 101)" "0"
chk "both：Project 没设回落 label"     "$(priority_rank "priority/p0" 999)" "0"
chk "both：两边都没有 = 最后一档"      "$(priority_rank "" 999)"            "2"

echo "── PRIORITY_SOURCE 校验 ──"
PRIORITY_SOURCE=projekt bash -c "source '$REPO_DIR/scripts/_lib.sh'" >/dev/null 2>&1
chk "拼错的来源名 exit 非 0" "$([ $? -ne 0 ] && echo yes || echo no)" "yes"

echo
echo "结果：$pass 通过 / $fail 失败"
[ "$fail" -eq 0 ]
