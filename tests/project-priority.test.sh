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

# ── ① issue 原生字段（新版 GitHub Issues 自带；值在 issue 上，不在看板条目上）──
ifv() {  # <编号> <优先级名或 -> ；每条记录都重复带着整份选项定义，真实 API 就长这样
    local vals=""
    [ "$2" != "-" ] && vals="{\"name\":\"$2\",\"field\":{\"name\":\"Priority\",\"options\":[{\"name\":\"Urgent\"},{\"name\":\"High\"},{\"name\":\"Medium\"},{\"name\":\"Low\"}]}}"
    printf '{"number":%s,"issueFieldValues":{"nodes":[%s]}}' "$1" "$vals"
}
ifpage() {  # <hasNextPage> <cursor> <记录...>
    local has="$1" cur="$2"; shift 2
    local j; j=$(printf '%s,' "$@"); j="${j%,}"
    printf '{"data":{"repository":{"issues":{"pageInfo":{"hasNextPage":%s,"endCursor":"%s"},"nodes":[%s]}}}}' "$has" "$cur" "$j"
}

echo "── issue 原生字段：档位取选项顺序，选项数只能算一份 ──"
echo 0 > "$CALL_N"
ifpage false "" "$(ifv 826 High)" "$(ifv 814 Urgent)" "$(ifv 807 Low)" "$(ifv 999 -)" > "$TMP/resp.1"
out=$(issue_field_priority_pairs 2>/dev/null)
chk "Urgent → 0（选项里排第一）"     "$(grep -c '^814	0$' <<<"$out")"   "1"
chk "High → 1"                       "$(grep -c '^826	1$' <<<"$out")"   "1"
chk "Low → 3（最后一档）"            "$(grep -c '^807	3$' <<<"$out")"   "1"
chk "没设值的不进表"                 "$(grep -c '^999' <<<"$out")"       "0"
# 这条是真踩过的：每条记录都重复带一份选项定义，全收会变成 4×N，档位数直接算错
chk "选项数 = 4，不是 4×记录数"      "$(grep -c '^#options	4$' <<<"$out")" "1"
chk "报出用的是原生字段"             "$(grep -c '^#project	issue 原生字段 Priority' <<<"$out")" "1"

echo "── issue 原生字段：分页 + 只认指定字段名 ──"
echo 0 > "$CALL_N"
ifpage true "C1" "$(ifv 101 Urgent)" > "$TMP/resp.1"
ifpage false ""  "$(ifv 102 Medium)" > "$TMP/resp.2"
out=$(issue_field_priority_pairs 2>/dev/null)
chk "第一页在" "$(grep -c '^101	0$' <<<"$out")" "1"
chk "第二页在" "$(grep -c '^102	2$' <<<"$out")" "1"
echo 0 > "$CALL_N"
printf '{"data":{"repository":{"issues":{"pageInfo":{"hasNextPage":false,"endCursor":""},"nodes":[{"number":201,"issueFieldValues":{"nodes":[{"name":"Hot","field":{"name":"Severity","options":[{"name":"Hot"},{"name":"Cold"}]}}]}}]}}}}' > "$TMP/resp.1"
issue_field_priority_pairs >/dev/null 2>&1
chk "同名以外的单选字段不算数 → 非 0" "$([ $? -ne 0 ] && echo yes || echo no)" "yes"

echo "── 两条路的取舍：原生没有就回落到看板单选字段 ──"
echo 0 > "$CALL_N"
ifpage false "" "$(ifv 301 -)" > "$TMP/resp.1"        # ① 一条值都没有 → 失败
echo '{"data":{"repository":{"projectsV2":{"nodes":[{"id":"PVT_1","number":7,"title":"board"}]}}}}' > "$TMP/resp.2"
page false "" "$(item 302 acme/widget P1)" > "$TMP/resp.3"   # ② 看板这条有
out=$(priority_pairs 2>/dev/null)
chk "回落到看板字段并拿到值" "$(grep -c '^302	1$' <<<"$out")" "1"
chk "报出用的是看板"         "$(grep -c '^#project	7 board$' <<<"$out")" "1"
chk "不混进 ① 的半截输出"    "$(grep -c '原生字段' <<<"$out")" "0"

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

echo "── 字段没有选项时必须算失败（否则全体并列第一档，静默排错序）──"
echo 0 > "$CALL_N"
echo '{"data":{"repository":{"projectsV2":{"nodes":[{"id":"PVT_1","number":7,"title":"board"}]}}}}' > "$TMP/resp.1"
# 字段在、但一个选项都没配 —— GitHub 自带模板的 Priority 出厂就是这样
printf '{"data":{"node":{"field":{"options":[]},"items":{"pageInfo":{"hasNextPage":false,"endCursor":""},"nodes":[]}}}}' > "$TMP/resp.2"
project_priority_pairs >/dev/null 2>&1
chk "空选项 → 非 0（调用方好回落）" "$([ $? -ne 0 ] && echo yes || echo no)" "yes"
echo 0 > "$CALL_N"
printf '{"data":{"node":{"field":null,"items":{"pageInfo":{"hasNextPage":false,"endCursor":""},"nodes":[]}}}}' > "$TMP/resp.2"
project_priority_pairs >/dev/null 2>&1
chk "字段名写错（field=null）→ 非 0" "$([ $? -ne 0 ] && echo yes || echo no)" "yes"

echo "── 取舍：priority_rank 在三种 source 下 ──"
PROJECT_PRIO=([101]=0 [102]=2)
# 原生字段 4 档（Urgent/High/Medium/Low → 0..3），label 3 档（p0/p1/p2 → 0..2）。
# 「哪儿都没标」取两边档位数的最大值 = 4，比任何一边的任何一档都大。
_prio_rank_unset=4
PRIORITY_SOURCE=label
chk "label 模式无视 Project 表"        "$(priority_rank "priority/p1" 101)" "1"
PRIORITY_SOURCE=project
chk "project 模式用 Project 的档位"    "$(priority_rank "priority/p1" 101)" "0"
chk "project 模式无视 label"           "$(priority_rank "priority/p0" 102)" "2"
PRIORITY_SOURCE=both
chk "both：Project 设了就用 Project"   "$(priority_rank "priority/p2" 101)" "0"
chk "both：Project 没设回落 label"     "$(priority_rank "priority/p0" 999)" "0"

# ↓ 这组是「没标的必须垫底」——踩过的坑：两套档位下标各自独立，"哪儿都没标"沿用
#   label 的最后一档(2) 时，会排到明确标了 Low(3) 的**前面**。
chk "哪儿都没标 → 比 label 最低档还靠后" "$(priority_rank "" 999)"          "4"
chk "  比 priority/p2（=2）靠后"         "$([ "$(priority_rank "" 999)" -gt "$(priority_rank "priority/p2" 999)" ] && echo yes)" "yes"
chk "  比原生 Low（=3）靠后"             "$([ "$(priority_rank "" 999)" -gt 3 ] && echo yes)" "yes"
PRIORITY_SOURCE=project
chk "project 模式没设值也垫底"           "$(priority_rank "priority/p0" 999)" "4"
PRIORITY_SOURCE=label
chk "只用 label 时没打标签也垫底"        "$(priority_rank "" 999)"            "4"
chk "  且 priority/p2 排在它前面"        "$(priority_rank "priority/p2" 999)" "2"

echo "── PRIORITY_SOURCE 校验 ──"
PRIORITY_SOURCE=projekt bash -c "source '$REPO_DIR/scripts/_lib.sh'" >/dev/null 2>&1
chk "拼错的来源名 exit 非 0" "$([ $? -ne 0 ] && echo yes || echo no)" "yes"

echo
echo "结果：$pass 通过 / $fail 失败"
[ "$fail" -eq 0 ]
