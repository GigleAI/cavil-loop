#!/usr/bin/env bash
# kind: e2e
# 往返记录 —— GitHub#610：agent 之间的来回写进同一条评论，交人时单独发。
#
# 跑法：bash tests/round-log.test.sh
# 依赖：bash、jq、python3。不碰网络：假 GitHub（tests/lib/fake_github.py，有状态），HOME 指向临时目录。
# 真的跑 scripts/round-log.sh（post / show），周报和单 PR 统计用的拆单元走真的 round_log.py / collect.py。
#
# 守的是（编号对应方案第 15 版的验收标准）：
#   1  issue 上「交第 1 版 → 打回 → 交第 2 版 → 打回 → 交第 3 版」：1 条往返记录，顶部是第 3 版全文，5 节
#   2  交合并 / 交人的结论、带托管测试记录标记的正文、带记录标记的正文：拒收、零写入
#   3  复审读到第 2 版全文：改写成功 / 改写明确失败另起 / 改写超时其实成功又另起（同一节两份）三条路径一致；
#      顶部节号被改坏 → 读取报「版本对不上」、不给当前版本
#   4  最新单元：中间插入 daemon 提醒、最后插入人的评论 → 下一次交付另起一条；开关关着 → 拒收
#   5  改写失败 / 超时 → 另起一条完整的新记录，标签照常可翻；评论读不全 → 零写入
#   6  已过期 / 状态未知：首次写前发现 → 写请求数为零；改写已发出后才发现 → 之后新增写请求为零、维护者的标签不动
#   7  托管受保护读取的视图：外部账号带同款标记的评论不当成记录
#   8  统计：拆成单元后用量记录与「各节拆成独立评论」一致；周报的取材先取齐整串评论再按各节时间归周
#   9  复审轮次：单元里带轮次标记的个数 = 拆成独立评论时的个数
#  10  提示词：开着时多一段、占位符都填上；关着时不加（其余逐字节对比由各自的测试守）
set -uo pipefail
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"

SANDBOX=$(mktemp -d)
trap '[ -n "${KEEP_SANDBOX:-}" ] && echo "SANDBOX=$SANDBOX" || rm -rf "$SANDBOX"' EXIT
mkdir -p "$SANDBOX/bin" "$SANDBOX/home"
export HOME="$SANDBOX/home"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 TZ=UTC
unset CODING_AGENT_RELEASE_ROOT LABEL_AUTOPILOT ENABLE_ROUND_LOG CAVIL_DEPLOY_ROOT
for __v in $(compgen -v DISPATCH_); do unset "$__v"; done; unset __v
unset GH_TOKEN WRITE_GH_TOKEN GITHUB_TOKEN

bash "$TEST_DIR/lib/fake_gh_client.sh" install "$SANDBOX/bin/gh" python3 "$TEST_DIR/lib/fake_github.py"
chmod +x "$SANDBOX/bin/gh"
export PATH="$SANDBOX/bin:$PATH"

pass=0; fail=0
chk() {
    if [ "$2" = "$3" ]; then echo "  ✅ $1"; pass=$((pass+1))
    else echo "  ❌ $1 (期望 [$3]，实得 [$2])"; fail=$((fail+1)); fi
}
has() {   # <名字> <文字> <要包含的>
    if grep -qF -- "$3" <<<"$2"; then echo "  ✅ $1"; pass=$((pass+1))
    else echo "  ❌ $1（没找到 [$3]）"; fail=$((fail+1)); fi
}
lacks() {
    if grep -qF -- "$3" <<<"$2"; then echo "  ❌ $1（不该有 [$3]）"; fail=$((fail+1))
    else echo "  ✅ $1"; pass=$((pass+1)); fi
}

export FAKE_GH_REPO="example/rl"
W="$SANDBOX/run"
fresh() {   # <issue|pr> [额外配置行…]
    local kind="$1"; shift
    rm -rf "$W"; mkdir -p "$W/state" "$W/wt" "$W/gh" "$W/project"
    GD="$W/gh"; export FAKE_GH_DIR="$GD"; CALLS="$GD/calls.log"
    CONF="$W/cavil-loop.config"
    {
        cat <<CONF
REPO="example/rl"
PROJECT_ROOT="$W/project"
WORKTREE_BASE="$W/wt"
STATE_DIR="$W/state"
TMUX_PREFIX="rltest"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
LABEL_AGENT_DOING="doing/agent"
LABEL_PENDING_REVIEW="pending/review"
GH_TOKEN="fake-token-for-test"
ENABLE_ROUND_LOG=true
CONF
        for l in "$@"; do echo "$l"; done
    } > "$CONF"
    echo loop-bot > "$GD/me"
    if [ "$kind" = pr ]; then
        cat > "$GD/items.json" <<'J'
{"8": {"kind": "pr", "state": "open", "title": "p", "body": "Closes #7", "user": {"login": "loop-bot"},
       "head": {"ref": "feature/issue-7", "sha": "aaaa000000000000000000000000000000000001", "repo": {"full_name": "example/rl"}},
       "base": {"ref": "main"}}}
J
        echo '{"8": ["doing/agent"]}' > "$GD/labels.json"
        echo '{"8": [{"id": 100, "body": "PR 开了", "user": {"login": "loop-bot"}, "created_at": "2026-01-01T00:00:00Z"}]}' > "$GD/comments.json"
        N=8
    else
        echo '{"7": {"kind": "issue", "state": "open", "title": "t", "body": "需求", "user": {"login": "maint"}}}' > "$GD/items.json"
        echo '{"7": ["doing/agent"]}' > "$GD/labels.json"
        echo '{"7": [{"id": 100, "body": "人的需求补充", "user": {"login": "maint"}, "created_at": "2026-01-01T00:00:00Z"}]}' > "$GD/comments.json"
        N=7
    fi
}
RL() { bash "$REPO_DIR/scripts/round-log.sh" --config "$CONF" "$@"; }
writes() { local n; n=$(grep -cE '^gh api (-X (POST|PATCH)|.*-X (POST|PATCH))' "$CALLS" 2>/dev/null) || true; echo "${n:-0}"; }
ncomments() { jq --arg n "$N" '.[$n] | length' "$GD/comments.json"; }
records() { jq --arg n "$N" '[.[$n][] | select(.body | startswith("<!-- cavil-round-log:v1 -->"))] | length' "$GD/comments.json"; }
mk() { printf '%s\n' "$2" > "$SANDBOX/$1"; echo "$SANDBOX/$1"; }
result() { printf '%s' "$1" | grep '^RESULT=' | tail -1; }

echo "── 1. issue 上交三版、打回两次：只占一条往返记录 ──"
fresh issue
o=$(RL post 7 --role worker --to pending/review --body "$(mk b1 '第 1 版：初稿')" --full "$(mk f1 '方案全文 V1')"); rc=$?
chk "第 1 次交付：已写入（新开）" "$rc $(result "$o")" "0 RESULT=written"
has "第 1 次交付是新开一条" "$o" "MODE=new"
o=$(RL post 7 --role review --to pending/agent --body "$(mk r1 $'<!-- codex-review-round:1 -->\n## ❌ 打回 1')"); rc=$?
chk "复审第 1 轮：追加" "$rc $(printf '%s' "$o" | grep ^MODE=)" "0 MODE=append"
RL post 7 --role worker --to pending/review --body "$(mk b2 '第 2 版：只改了验收第 3 条')" --full "$(mk f2 '方案全文 V2（验收 3 改成 X）')" >/dev/null
RL post 7 --role review --to pending/agent --body "$(mk r2 $'<!-- codex-review-round:2 -->\n## ❌ 打回 2')" >/dev/null
o=$(RL post 7 --role worker --to pending/review --body "$(mk b3 '第 3 版：补了一条')" --full "$(mk f3 '方案全文 V3')"); rc=$?
chk "第 3 版：已写入" "$rc" "0"
chk "评论区只多了 1 条（原有 1 条 + 1 条往返记录）" "$(ncomments)" "2"
REC=$(jq -r '.["7"][1].body' "$GD/comments.json")
chk "记录里 5 节" "$(grep -c '^<!-- cavil-round-log:sec id=' <<<"$REC")" "5"
has "顶部是第 3 版全文" "$(sed -n '/cavil-round-log:top /,/top-end/p' <<<"$REC")" "方案全文 V3"
lacks "顶部不再是第 2 版" "$(sed -n '/cavil-round-log:top /,/top-end/p' <<<"$REC")" "V2"
o=$(RL show 7); rc=$?
chk "读取：成功" "$rc" "0"
has "最新单元是第 3 版这一节" "$o" "第 3 版：补了一条"
has "附着第 3 版完整版本" "$(sed -n '/最新单元对应的完整版本/,$p' <<<"$o")" "方案全文 V3"
has "复审轮次：带轮次标记的 2 个（第 9 条）" "$o" "带复审轮次标记的 2 个"
o=$(RL show 7 --all)
chk "--all 列出 6 个单元（1 条人的评论 + 5 节）" "$(grep -c '^### 单元 ' <<<"$o")" "6"

echo "── 3. 复审读到第 2 版全文：三条写入路径一致 ──"
review_view() {   # → 复审侧读取输出（交第 2 版之后）
    RL show 7
}
path_case() {   # <名字> <注入文件|空>
    fresh issue
    RL post 7 --role worker --to pending/review --body "$(mk b1 '第 1 版')" --full "$(mk f1 '方案全文 V1：验收 3 = 旧写法')" >/dev/null
    RL post 7 --role review --to pending/agent --body "$(mk r1 $'<!-- codex-review-round:1 -->\n## ❌ 打回：验收 3 不对')" >/dev/null
    [ -z "$2" ] || : > "$GD/$2"
    local o rc; o=$(RL post 7 --role worker --to pending/review --body "$(mk b2 '第 2 版：只改了验收 3')" --full "$(mk f2 '方案全文 V2：验收 3 = 新写法')"); rc=$?
    rm -f "$GD/$2" 2>/dev/null
    chk "$1：交第 2 版已写入" "$rc $(result "$o")" "0 RESULT=written"
    local v; v=$(review_view)
    has "$1：最新单元是第 2 版这一节" "$(sed -n '/^## 最新单元：/,/^## 最新单元对应/p' <<<"$v")" "第 2 版：只改了验收 3"
    has "$1：完整版本是第 2 版" "$(sed -n '/最新单元对应的完整版本/,$p' <<<"$v")" "验收 3 = 新写法"
    lacks "$1：完整版本里没有第 1 版写法" "$(sed -n '/最新单元对应的完整版本/,$p' <<<"$v")" "旧写法"
    lacks "$1：打回意见不混进「本轮」" "$(sed -n '/^## 最新单元：/,$p' <<<"$v")" "验收 3 不对"
    has "$1：轮次只算 1 次" "$v" "带复审轮次标记的 1 个"
    printf '%s' "$o"
}
o=$(path_case "改写成功" ""); printf '%s\n' "$o" | grep -E '^  (✅|❌)'; has "改写成功走的是追加" "$o" "MODE=append"
pass=$((pass + $(grep -c '^  ✅' <<<"$o"))); fail=$((fail + $(grep -c '^  ❌' <<<"$o")))
o=$(path_case "改写明确失败" F_patch_comment); printf '%s\n' "$o" | grep -E '^  (✅|❌)'
pass=$((pass + $(grep -c '^  ✅' <<<"$o"))); fail=$((fail + $(grep -c '^  ❌' <<<"$o")))
has "改写明确失败：另起了一条" "$o" "MODE=fallback"
chk "改写明确失败：两条往返记录" "$(records)" "2"
o=$(path_case "改写超时其实成功" F_patch_comment_lost); printf '%s\n' "$o" | grep -E '^  (✅|❌)'
pass=$((pass + $(grep -c '^  ✅' <<<"$o"))); fail=$((fail + $(grep -c '^  ❌' <<<"$o")))
SECS=$(jq -r '.["7"][] | .body' "$GD/comments.json" | grep -o 'sec id=[0-9a-f]*' | sort | uniq -c | awk '$1 == 2' | wc -l)
chk "改写超时其实成功：同一节在评论区出现两次" "$SECS" "1"
v=$(RL show 7 --all)
chk "改写超时其实成功：读取只算一份（1 条人的评论 + 3 节）" "$(grep -c '^### 单元 ' <<<"$v")" "4"
# 顶部节号被改坏
fresh issue
RL post 7 --role worker --to pending/review --body "$(mk b1 '第 1 版')" --full "$(mk f1 'V1')" >/dev/null
python3 - "$GD/comments.json" <<'PY'
import json, sys, re
d = json.load(open(sys.argv[1]))
c = d["7"][-1]
c["body"] = re.sub(r"top sec=[0-9a-f]+", "top sec=ffffffffffff", c["body"])
json.dump(d, open(sys.argv[1], "w"))
PY
o=$(RL show 7); rc=$?
chk "顶部节号对不上：读取退出码 4" "$rc" "4"
has "顶部节号对不上：说「版本对不上」" "$o" "版本对不上"
lacks "顶部节号对不上：不给任何当前版本" "$o" "最新单元对应的完整版本"

echo "── 2. 不该进记录的交付：拒收、零写入 ──"
fresh issue
for to in pending/merge pending/human; do
    o=$(RL post 7 --role review --to "$to" --body "$(mk r '结论')"); rc=$?
    chk "翻到 $to 的评论：拒收" "$rc $(result "$o")" "2 RESULT=rejected"
done
o=$(RL post 7 --role review --to pending/review --body "$(mk r $'<!-- autopilot-review-pass head=aaaa000000000000000000000000000000000001 passed=3 failed=0 -->\nok')"); rc=$?
chk "带托管测试记录标记的正文：拒收" "$rc" "2"
o=$(RL post 7 --role worker --to pending/review --body "$(mk b '<!-- cavil-round-log:sec-end -->')" --full "$(mk f 'V')"); rc=$?
chk "正文里有记录标记：拒收" "$rc" "2"
o=$(RL post 7 --role worker --to pending/review --body "$(mk b 'x')"); rc=$?
chk "worker 没给完整版本：拒收" "$rc" "2"
chk "以上全部零写入" "$(writes)" "0"

echo "── 4. 最新单元：中途有别的评论 → 另起一条 ──"
fresh issue
RL post 7 --role worker --to pending/review --body "$(mk b1 '第 1 版')" --full "$(mk f1 'V1')" >/dev/null
python3 - "$GD/comments.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
d["7"].append({"id": 5000, "body": "daemon：提醒一下", "user": {"login": "loop-bot"}, "created_at": "2026-01-02T00:00:00Z"})
json.dump(d, open(sys.argv[1], "w"))
PY
o=$(RL show 7)
has "插入 daemon 提醒后，最新单元是那条提醒" "$o" "daemon：提醒一下"
o=$(RL post 7 --role review --to pending/agent --body "$(mk r1 $'<!-- codex-review-round:1 -->\n打回')")
has "插入别的评论之后：另起一条新记录" "$o" "MODE=new"
o=$(RL show 7)
has "另起之后：复审节仍附着它所审那一版（第 1 版）" "$(sed -n '/最新单元对应的完整版本/,$p' <<<"$o")" "V1"
python3 - "$GD/comments.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
d["7"].append({"id": 9000, "body": "人：等一下，先别改", "user": {"login": "maint"}, "created_at": "2026-01-03T00:00:00Z"})
json.dump(d, open(sys.argv[1], "w"))
PY
o=$(RL show 7)
has "最后插入人的评论：最新单元是人的评论" "$(sed -n '/^## 最新单元：/,$p' <<<"$o")" "人：等一下"
lacks "最新单元是普通评论时不附完整版本" "$o" "最新单元对应的完整版本"
fresh issue 'ENABLE_ROUND_LOG=""'
o=$(RL post 7 --role worker --to pending/review --body "$(mk b1 '第 1 版')" --full "$(mk f1 'V1')"); rc=$?
chk "开关关着：拒收、照现在单独发" "$rc" "2"
chk "开关关着：零写入" "$(writes)" "0"

echo "── 5. 评论读不全：零写入 ──"
fresh issue
: > "$GD/F_issues_7_comments"
o=$(RL post 7 --role worker --to pending/review --body "$(mk b1 'x')" --full "$(mk f1 'V')"); rc=$?
chk "评论读不全：退出码 5" "$rc $(result "$o")" "5 RESULT=unreadable"
chk "评论读不全：零写入" "$(writes)" "0"
o=$(RL show 7); rc=$?
chk "读取命令：评论读不全退出码 5" "$rc" "5"

echo "── 6. 已过期 / 状态未知 ──"
expired_case() {   # <名字> <做法：shell 片段，改 $GD> <期望退出码>
    fresh issue
    RL post 7 --role worker --to pending/review --body "$(mk b1 '第 1 版')" --full "$(mk f1 'V1')" >/dev/null
    : > "$CALLS"
    eval "$2"
    local o rc; o=$(RL post 7 --role review --to pending/agent --body "$(mk r1 'x')"); rc=$?
    chk "$1：退出码 $3" "$rc" "$3"
    chk "$1：写请求数为零" "$(writes)" "0"
}
expired_case "目标已关闭" "jq '.[\"7\"].state = \"closed\"' \"\$GD/items.json\" > \"\$GD/i\" && mv \"\$GD/i\" \"\$GD/items.json\"" 3
expired_case "人挂了 pending/blocked" "echo '{\"7\": [\"doing/agent\", \"pending/blocked\"]}' > \"\$GD/labels.json\"" 3
expired_case "带 pending/human" "echo '{\"7\": [\"doing/agent\", \"pending/human\"]}' > \"\$GD/labels.json\"" 3
expired_case "不再挂 doing/agent" "echo '{\"7\": []}' > \"\$GD/labels.json\"" 3
expired_case "目标状态读不到" ": > \"\$GD/F_issues_7\"" 4
# 改写请求已经发出之后才发现目标被人接手：之后不再发任何写请求、不另起，维护者的标签原样
for inj in F_patch_comment F_patch_comment_lost; do
    fresh issue
    RL post 7 --role worker --to pending/review --body "$(mk b1 '第 1 版')" --full "$(mk f1 'V1')" >/dev/null
    : > "$GD/$inj"
    printf '#!/usr/bin/env bash\necho %s > "%s/labels.json"\n' "'{\"7\": [\"doing/agent\", \"pending/blocked\"]}'" "$GD" > "$GD/hook_PATCH_comment_1"
    : > "$CALLS"
    o=$(RL post 7 --role review --to pending/agent --body "$(mk r1 $'<!-- codex-review-round:1 -->\n打回')"); rc=$?
    chk "改写已发出后才发现（$inj）：退出码 3" "$rc" "3"
    chk "改写已发出后才发现（$inj）：只发出了那一次改写" "$(writes)" "1"
    chk "改写已发出后才发现（$inj）：没有另起新记录" "$(records)" "1"
    chk "改写已发出后才发现（$inj）：维护者挂的 pending/blocked 还在" "$(jq -c '.["7"]' "$GD/labels.json")" '["doing/agent","pending/blocked"]'
    rm -f "$GD/$inj"
    v=$(RL show 7 --all)
    if [ "$inj" = F_patch_comment_lost ]; then
        chk "请求已生效：这一节按事实计入" "$(grep -c '^### 单元 ' <<<"$v")" "3"
    else
        chk "请求未生效：没有这一节" "$(grep -c '^### 单元 ' <<<"$v")" "2"
    fi
done

echo "── PR：本次依据的提交、目标分支 ──"
fresh pr
o=$(RL post 8 --role worker --to pending/review --body "$(mk b1 '修了')" --full "$(mk f1 'PR 说明')" --basis aaaa000000000000000000000000000000000001); rc=$?
chk "PR：依据提交对得上 → 写入" "$rc" "0"
o=$(RL post 8 --role review --to pending/agent --body "$(mk r1 'x')" --basis bbbb000000000000000000000000000000000002); rc=$?
chk "PR：有了不是本次依据的提交 → 已过期" "$rc $(result "$o")" "3 RESULT=expired"
printf '#!/usr/bin/env bash\njq %s "%s/items.json" > "%s/i" && mv "%s/i" "%s/items.json"\n' \
    "'.[\"8\"].base.ref = \"release\"'" "$GD" "$GD" "$GD" "$GD" > "$GD/hook_pulls_8_$(( $(cat "$GD/count_pulls_8" 2>/dev/null || echo 0) + 2 ))"
: > "$CALLS"
o=$(RL post 8 --role review --to pending/agent --body "$(mk r1 'x')" --basis aaaa000000000000000000000000000000000001); rc=$?
chk "PR：第一次核对之后目标分支变了 → 已过期、零写入" "$rc $(writes)" "3 0"
has "PR：已过期的原因是目标分支变了（不是别的检查）" "$o" "目标分支变了"
jq '.["8"].merged = true' "$GD/items.json" > "$GD/i" && mv "$GD/i" "$GD/items.json"
o=$(RL post 8 --role review --to pending/agent --body "$(mk r1 'x')"); rc=$?
chk "PR：已合并 → 已过期" "$rc" "3"
fresh issue
python3 - "$GD/items.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
d["9"] = {"kind": "pr", "state": "open", "title": "p", "body": "Closes #7", "head": {"ref": "feature/issue-7", "sha": "c" * 40, "repo": {"full_name": "example/rl"}}, "base": {"ref": "main"}}
json.dump(d, open(sys.argv[1], "w"))
PY
o=$(RL post 7 --role worker --to pending/review --body "$(mk b1 'x')" --full "$(mk f1 'V')"); rc=$?
chk "issue：已经有了工作分支的 PR（不再是方案阶段）→ 已过期" "$rc" "3"

echo "── 7. 托管受保护读取的视图：只认 loop 账号的记录 ──"
fresh issue
RL post 7 --role worker --to pending/review --body "$(mk b1 '第 1 版')" --full "$(mk f1 'V1')" >/dev/null
REC=$(jq -c '.["7"][-1].body' "$GD/comments.json")
OSRES=$(jq -nc --argjson rec "$REC" '{view: [
  {src: "issue-comment", id: "100", author: "maint", trusted: false, at: "2026-01-01T00:00:00Z", url: "", body: "人的需求补充"},
  {src: "issue-comment", id: "1001", author: "loop-bot", trusted: true, at: "2026-01-01T01:00:00Z", url: "", body: $rec},
  {src: "issue-comment", id: "1002", author: "stranger", trusted: false, at: "2026-01-01T02:00:00Z", url: "", body: ($rec | sub("第 1 版"; "外人伪造的一节"))}]}')
o=$(OS_RES="$OSRES" OS_TARGET_KIND=issue CODING_AGENT_CONFIG="$CONF" bash -c 'source "$1/scripts/_lib.sh" >/dev/null 2>&1; round_log_view_from_scan --all' _ "$REPO_DIR"); rc=$?
chk "视图：成功" "$rc" "0"
chk "外部账号带同款标记的评论当一条普通评论（共 3 个单元）" "$(grep -c '^### 单元 ' <<<"$o")" "3"
has "最新单元是那条外部评论本身（不是记录里的一节）" "$(sed -n '/^## 最新单元：/,/^$/p' <<<"$o")" "评论 #1002（@stranger"
lacks "外部评论不附完整版本" "$o" "最新单元对应的完整版本"

echo "── 8. 统计：拆成单元 = 各节拆成独立评论 ──"
fresh issue
FOOT1='<!-- agent-metrics agent=claude wt=7 start=2026-01-04T23:50:00+08:00 end=2026-01-05T00:10:00+08:00 wall_secs=1200 in=1 out=2 cache_r=3 cache_w=4 cost_usd=0.5 -->'
FOOT2='<!-- agent-metrics agent=codex wt=7 start=2026-01-05T01:00:00+08:00 end=2026-01-05T01:05:00+08:00 wall_secs=300 in=5 out=6 cache_r=7 cache_w=8 cost_usd=0.25 -->'
RL post 7 --role worker --to pending/review --body "$(mk b1 "第 1 版
$FOOT1")" --full "$(mk f1 'V1')" >/dev/null
RL post 7 --role review --to pending/agent --body "$(mk r1 "<!-- codex-review-round:1 -->
打回
$FOOT2")" >/dev/null
o=$(WEEKLY_REPORT_BOT_LOGINS=loop-bot PYTHONPATH="$REPO_DIR/scripts:$REPO_DIR/scripts/weekly-report" python3 - "$GD/comments.json" <<'PY'
import json, sys
import round_log, record
cs = json.load(open(sys.argv[1]))["7"]
for c in cs:
    c.setdefault("html_url", "")
units = round_log.expand_github_comments(cs, record.is_bot)
def recs(lst):
    out = []
    for c in lst:
        r = record.extract(c["body"], c["user"]["login"], c["id"], default_wt=7)
        if r:
            out.append((str(r.get("start")), r.get("wall_secs"), r.get("cost_usd"), r.get("agent")))
    return sorted(out)
# 「各节拆成在追加时间发出的独立评论」：手工从记录里切出来
sep = []
for u in round_log.units([{"id": c["id"], "author": c["user"]["login"], "at": c["created_at"], "body": c["body"]} for c in cs],
                         lambda a: a == "loop-bot"):
    sep.append({"id": u["id"], "body": u["body"], "user": {"login": u["author"]}})
print("units=%d" % len(units))
print("same=%s" % (recs(units) == recs(sep)))
print("n=%d" % len(recs(units)))
print("rounds=%d" % sum(1 for c in units if c["body"].lstrip().startswith("<!-- codex-review-round")))
print("ids=%s" % ",".join(str(c["id"]) for c in units))
PY
)
has "统计：拆出 3 条（1 条人的评论 + 2 节）" "$o" "units=3"
has "统计：用量记录与拆成独立评论时相同" "$o" "same=True"
has "统计：读出 2 次派工" "$o" "n=2"
has "统计：轮次标记 1 个" "$o" "rounds=1"
# 周报取材：since 列表里只有那条往返记录（旧记录在下一周被改写）→ 整串重读、各节按自己的追加时间
o=$(WEEKLY_REPORT_BOT_LOGINS=loop-bot FAKE_GH_DIR="$GD" python3 - "$REPO_DIR/scripts/weekly-report" "$GD/comments.json" <<'PY'
import json, sys
sys.path.insert(0, sys.argv[1])
sys.argv = sys.argv[:1] + sys.argv[3:] if False else sys.argv
import collect
cs = json.load(open(sys.argv[2]))["7"]
rec = [dict(c, issue_url="https://api.github.com/repos/example/rl/issues/7", updated_at="2026-01-12T00:00:00Z") for c in cs if c["body"].startswith("<!-- cavil-round-log")]
out = collect.expand_round_logs("example/rl", rec)
print("n=%d" % len(out))
print("at=%s" % ",".join(c["created_at"] for c in out))
PY
)
has "周报：since 列表只有那条记录时，整串重读后拿齐 3 条（含人的评论）" "$o" "n=3"
: > "$GD/F_issues_7_comments"
o=$(WEEKLY_REPORT_BOT_LOGINS=loop-bot FAKE_GH_DIR="$GD" python3 - "$REPO_DIR/scripts/weekly-report" "$GD/comments.json" <<'PY' 2>&1
import json, sys
sys.path.insert(0, sys.argv[1])
import collect
rec = [{"id": 1, "body": "<!-- cavil-round-log:v1 -->\n", "user": {"login": "loop-bot"}, "created_at": "2026-01-01T00:00:00Z",
        "issue_url": "https://api.github.com/repos/example/rl/issues/7"}]
collect.expand_round_logs("example/rl", rec)
print("NOT-EXITED")
PY
); rc=$?
chk "周报：整串重读失败 → 整次退出，不出半份数字" "$rc" "2"
lacks "周报：读失败后没有继续往下算" "$o" "NOT-EXITED"

echo "── 10. 提示词 ──"
fresh issue
sec=$(CODING_AGENT_CONFIG="$CONF" bash -c 'source "$1/scripts/_lib.sh" >/dev/null 2>&1; f=$(compose_prompt_template review); cat "$f"' _ "$REPO_DIR")
has "开着：复审提示词多了往返记录一段" "$sec" "# 往返记录（本项目开启了"
lacks "开着：占位符都填上了" "$sec" "@@"
has "开着：写入命令指向本次的脚本" "$sec" "round-log.sh' --config '$CONF' post <编号>"
fresh issue 'ENABLE_ROUND_LOG=""'
sec=$(CODING_AGENT_CONFIG="$CONF" bash -c 'source "$1/scripts/_lib.sh" >/dev/null 2>&1; f=$(compose_prompt_template review); cat "$f"' _ "$REPO_DIR")
lacks "关着：不加这一段" "$sec" "# 往返记录（本项目开启了"

echo
echo "通过 $pass，失败 $fail"
report_counts "$pass" "$fail"
[ "$fail" -eq 0 ]
