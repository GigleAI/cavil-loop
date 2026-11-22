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
#   9  复审轮次：单元里带轮次标记的个数 = 拆成独立评论时的个数；材料按时间列出标记与人的评论、标明是全部历史，
#      跨人工重置时只数重置点之后的（同一节两份只列一次）
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
# 复审开始时读取命令标出的 --of 值（复审照提示词原样照抄它）
ofv() { RL show "$1" | grep -o -- '--of [^`]*' | head -1 | cut -d' ' -f2; }
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
o=$(RL post 7 --role review --of "$(ofv 7)" --to pending/agent --body "$(mk r1 $'<!-- codex-review-round:1 -->\n## ❌ 打回 1')"); rc=$?
chk "复审第 1 轮：追加" "$rc $(printf '%s' "$o" | grep ^MODE=)" "0 MODE=append"
RL post 7 --role worker --to pending/review --body "$(mk b2 '第 2 版：只改了验收第 3 条')" --full "$(mk f2 '方案全文 V2（验收 3 改成 X）')" >/dev/null
RL post 7 --role review --of "$(ofv 7)" --to pending/agent --body "$(mk r2 $'<!-- codex-review-round:2 -->\n## ❌ 打回 2')" >/dev/null
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
    RL post 7 --role review --of "$(ofv 7)" --to pending/agent --body "$(mk r1 $'<!-- codex-review-round:1 -->\n## ❌ 打回：验收 3 不对')" >/dev/null
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

# 复审读完之后记录坏了（复审重派第 1 轮）：写入命令按「读不懂」处理，不改成单独发、零写入
corrupt_case() {   # <名字> <python 改法>
    fresh issue
    RL post 7 --role worker --to pending/review --body "$(mk b1 '第 1 版')" --full "$(mk f1 'V1')" >/dev/null
    local of; of=$(ofv 7)
    python3 - "$GD/comments.json" "$2" <<'PY2'
import json, sys, re
d = json.load(open(sys.argv[1]))
c = d["7"][-1]
c["body"] = eval(sys.argv[2], {"re": re, "b": c["body"]})
json.dump(d, open(sys.argv[1], "w"))
PY2
    local o so rc src
    so=$(RL show 7); src=$?
    chk "$1：读取命令报读不懂（退出码 4）" "$src" "4"
    : > "$CALLS"
    o=$(RL post 7 --role review --of "$of" --to pending/agent --body "$(mk r1 $'<!-- codex-review-round:1 -->\n## ❌ 打回')"); rc=$?
    chk "$1：写入命令也是读不懂（unreadable，不是照现在单独发）" "$rc $(result "$o")" "5 RESULT=unreadable"
    lacks "$1：不叫改成单独发" "$o" "照现在单独发"
    chk "$1：零写入" "$(writes)" "0"
    chk "$1：写入命令确实读了评论（不是一上来就退出）" "$(grep -c 'issues/7/comments' "$CALLS")" "1"
}
corrupt_case "记录缺了节结束标记" 're.sub(r"<!-- cavil-round-log:sec-end -->\n?", "", b, count=1)'
corrupt_case "记录顶部节号对不上" 're.sub(r"top sec=[0-9a-f]+", "top sec=ffffffffffff", b)'
# 对照：记录读得懂、只是这一条本身不该进记录 → 仍是拒收、照现在单独发
fresh issue
RL post 7 --role worker --to pending/review --body "$(mk b1 '第 1 版')" --full "$(mk f1 'V1')" >/dev/null
o=$(RL post 7 --role review --of "$(ofv 7)" --to pending/human --body "$(mk r1 $'<!-- codex-review-round:1 -->\n## ✅ 交人')"); rc=$?
chk "对照：记录完好、结论是交人 → 仍是拒收（照现在单独发）" "$rc $(result "$o")" "2 RESULT=rejected"

echo "── 2. 不该进记录的交付：拒收、零写入 ──"
fresh issue
for to in pending/merge pending/human; do
    o=$(RL post 7 --role review --of "$(ofv 7)" --to "$to" --body "$(mk r '结论')"); rc=$?
    chk "翻到 $to 的评论：拒收" "$rc $(result "$o")" "2 RESULT=rejected"
done
o=$(RL post 7 --role review --of "$(ofv 7)" --to pending/review --body "$(mk r $'<!-- autopilot-review-pass head=aaaa000000000000000000000000000000000001 passed=3 failed=0 -->\nok')"); rc=$?
chk "带托管测试记录标记的正文：拒收" "$rc" "2"
o=$(RL post 7 --role worker --to pending/review --body "$(mk b '<!-- cavil-round-log:sec-end -->')" --full "$(mk f 'V')"); rc=$?
chk "正文里有记录标记：拒收" "$rc" "2"
o=$(RL post 7 --role worker --to pending/review --body "$(mk b 'x')"); rc=$?
chk "worker 没给完整版本：拒收" "$rc" "2"
chk "以上全部零写入" "$(writes)" "0"

echo "── 4a. 来回进行到一半关掉开关：下一次调用立刻按关着处理（GitHub#646）──"
# 复审拿到 --of 之后、发结论之前，配置里改成 false：写入命令拒收，一笔不写；受保护读取（outsider-read.sh）不再附往返视图，
# 直接读取（round-log.sh show）不看开关、照常拆分并标出 --of；文档给的退路是重新打开——同一会话照常写进记录
fresh issue 'LABEL_AUTOPILOT="autopilot"' 'LABEL_PENDING_MERGE="pending/merge"' 'AUTOPILOT_OUTSIDER_GUARD="on"' 'AUTOPILOT_OUTSIDER_SCREEN=""'
echo '{"maint": "admin", "loop-bot": "write"}' > "$GD/perms.json"
RL post 7 --role worker --to pending/review --body "$(mk b1 '第 1 版')" --full "$(mk f1 'V1')" >/dev/null
OFV=$(ofv 7)
o=$(bash "$REPO_DIR/scripts/outsider-read.sh" --config "$CONF" 7 2>/dev/null); rc=$?
chk "到达性：开着时读取命令成功并附往返视图" "$rc $(grep -c '往返记录视图' <<<"$o")" "0 1"
chk "到达性：开着时取得了节编号、记录已写进评论区" "$([ -n "$OFV" ] && echo yes) $(records)" "yes 1"
w0=$(writes)
sed -i 's/^ENABLE_ROUND_LOG=true$/ENABLE_ROUND_LOG=false/' "$CONF"
o=$(RL post 7 --role review --of "$OFV" --to pending/agent --body "$(mk r1 $'<!-- codex-review-round:1 -->\n## ❌ 打回')"); rc=$?
chk "关掉之后带着之前的节编号发结论：拒收、退出 2" "$rc $(result "$o")" "2 RESULT=rejected"
chk "关掉之后：一笔没写" "$(( $(writes) - w0 ))" "0"
o=$(bash "$REPO_DIR/scripts/outsider-read.sh" --config "$CONF" 7 2>/dev/null); rc=$?
lacks "关掉之后读取命令不再附往返视图" "$o" "往返记录视图"
lacks "关掉之后受保护读取不再标出要回应的交付（--of）" "$o" "--of "
lacks "关掉之后受保护读取没有「最新单元」这一段" "$o" "## 最新单元"
chk "关掉之后读取命令照常成功" "$rc" "0"
o=$(RL show 7); rc=$?
chk "关掉之后直接读取命令（round-log.sh show）不看开关：照常成功、仍标出 --of" "$rc $(grep -c -- '--of '"$OFV" <<<"$o")" "0 1"
# 文档给的退路：关掉之后发现有条目还在来回中，重新打开 → 同一个会话带着关掉前取得的节编号照常写进记录
sed -i 's/^ENABLE_ROUND_LOG=false$/ENABLE_ROUND_LOG=true/' "$CONF"
o=$(bash "$REPO_DIR/scripts/outsider-read.sh" --config "$CONF" 7 2>/dev/null); rc=$?
chk "重新打开后受保护读取又附上往返视图、标出同一个节编号" "$rc $(grep -c -- '--of '"$OFV" <<<"$o")" "0 1"
o=$(RL post 7 --role review --of "$OFV" --to pending/agent --body "$(mk r1 $'<!-- codex-review-round:1 -->\n## ❌ 打回')"); rc=$?
chk "重新打开后带着关掉前的节编号发结论：写入记录" "$rc $(result "$o")" "0 RESULT=written"
chk "重新打开后：仍只有一条往返记录" "$(records)" "1"

echo "── 4. 最新单元：中途有别的评论 → 另起一条 ──"
fresh issue
RL post 7 --role worker --to pending/review --body "$(mk b1 '第 1 版')" --full "$(mk f1 'V1')" >/dev/null
python3 - "$GD/comments.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
d["7"].append({"id": 1000 + sum(len(v) for v in d.values()), "body": "daemon：提醒一下", "user": {"login": "loop-bot"}, "created_at": "2026-01-02T00:00:00Z"})
json.dump(d, open(sys.argv[1], "w"))
PY
o=$(RL show 7)
has "插入 daemon 提醒后，最新单元是那条提醒" "$o" "daemon：提醒一下"
o=$(RL post 7 --role review --of "$(ofv 7)" --to pending/agent --body "$(mk r1 $'<!-- codex-review-round:1 -->\n打回')"); rc=$?
chk "交付之后插入了 loop 账号的单独评论：分不清最新交付是哪条，复审结论拒收（照现在单独发）" "$rc $(result "$o")" "2 RESULT=rejected"
o=$(RL post 7 --role worker --to pending/review --body "$(mk b2 '第 2 版')" --full "$(mk f2 'V2')")
has "插入别的评论之后：下一次交付另起一条新记录" "$o" "MODE=new"
o=$(RL post 7 --role review --of "$(ofv 7)" --to pending/agent --body "$(mk r2 $'<!-- codex-review-round:1 -->\n打回')")
o=$(RL show 7)
has "另起之后：复审节附着它所审那一版（第 2 版）" "$(sed -n '/最新单元对应的完整版本/,$p' <<<"$o")" "V2"
python3 - "$GD/comments.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
d["7"].append({"id": 1000 + sum(len(v) for v in d.values()), "body": "人：等一下，先别改", "user": {"login": "maint"}, "created_at": "2026-01-03T00:00:00Z"})
json.dump(d, open(sys.argv[1], "w"))
PY
o=$(RL show 7)
has "最后插入人的评论：最新单元是人的评论" "$(sed -n '/^## 最新单元：/,$p' <<<"$o")" "人：等一下"
lacks "最新单元是普通评论时不附完整版本" "$o" "最新单元对应的完整版本"
echo "── 4b. 复审轮次跨人工重置：材料按时间列出，总数标明是全部历史 ──"
fresh issue
RL post 7 --role worker --to pending/review --body "$(mk b1 '第 1 版')" --full "$(mk f1 'V1')" >/dev/null
RL post 7 --role review --of "$(ofv 7)" --to pending/agent --body "$(mk r1 $'<!-- codex-review-round:1 -->\n## ❌ 打回 1')" >/dev/null
sleep 1
python3 - "$GD/comments.json" <<'PY2'
import json, sys, datetime
d = json.load(open(sys.argv[1]))
now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
d["7"].append({"id": 1000 + sum(len(v) for v in d.values()), "body": "人：方向改一下，重新来", "user": {"login": "maint"}, "created_at": now})
json.dump(d, open(sys.argv[1], "w"))
PY2
sleep 1
RL post 7 --role worker --to pending/review --body "$(mk b2 '第 2 版（人工重置后）')" --full "$(mk f2 'V2')" >/dev/null
o=$(RL post 7 --role review --of "$(ofv 7)" --to pending/agent --body "$(mk r2 $'<!-- codex-review-round:1 -->\n## ❌ 新周期打回 1')"); rc=$?
chk "人工重置后新周期第 1 轮：已写入" "$rc $(result "$o")" "0 RESULT=written"
o=$(RL show 7)
mat=$(sed -n '/^## 复审轮次的材料/,$p' <<<"$o")
has "材料：标题写明是全部历史、不是当前轮次" "$mat" "## 复审轮次的材料（全部历史，不是当前轮次）"
chk "材料：按时间依次是 原有人的评论、标记、人工重置的评论、标记" "$(grep -oE '复审轮次标记 [0-9]+|@maint 的评论' <<<"$mat" | tr '\n' ' ')" "@maint 的评论 复审轮次标记 1 @maint 的评论 复审轮次标记 1 "
has "材料：总数标明是全部历史" "$mat" "带复审轮次标记的 2 个，是全部历史"
has "材料：只改标签、编辑评论要另外查 issue events" "$mat" "只改标签这类动作要照上文分页读评论编辑信息和 issue events 另外确定"
t1=$(grep '复审轮次标记 [0-9]' <<<"$mat" | head -1 | awk '{print $2}'); th=$(grep '@maint 的评论' <<<"$mat" | tail -1 | awk '{print $2}'); t2=$(grep '复审轮次标记 [0-9]' <<<"$mat" | sed -n 2p | awk '{print $2}')
chk "材料：时间可用来切分（第 1 个标记 < 人的评论 < 第 2 个标记）" "$([[ "$t1" < "$th" && "$th" < "$t2" ]] && echo ok)" "ok"
chk "材料：重置点之后只有 1 个带标记单元（当前是第 1 轮，下一轮是第 2 轮）" "$(grep -E '复审轮次标记 [0-9]|@maint 的评论' <<<"$mat" | sed -n '3,$p' | grep -c '复审轮次标记 [0-9]')" "1"
# 同一节在评论区出现两次（改写超时其实成功）：材料里只列一次
fresh issue
RL post 7 --role worker --to pending/review --body "$(mk b1 '第 1 版')" --full "$(mk f1 'V1')" >/dev/null
: > "$GD/F_patch_comment_lost"
RL post 7 --role review --of "$(ofv 7)" --to pending/agent --body "$(mk r1 $'<!-- codex-review-round:1 -->\n## ❌ 打回 1')" >/dev/null
rm -f "$GD/F_patch_comment_lost"
chk "同一节出现两次：评论区里那一节确有两份" "$(jq -r '.["7"][] | .body' "$GD/comments.json" | grep -o 'sec id=[0-9a-f]* role=review' | sort | uniq -c | awk '{print $1}')" "2"
chk "同一节出现两次：材料只列一次" "$(RL show 7 | sed -n '/^## 复审轮次的材料/,$p' | grep -c '复审轮次标记 [0-9]')" "1"
# 只认真正的复审：复审节、loop 账号的单独评论且第一个非空行整行是标记；别人的评论只当可能的重置点列出（复审第 6 轮）
fresh issue
RL post 7 --role worker --to pending/review --body "$(mk b1 '第 1 版')" --full "$(mk f1 'V1')" >/dev/null
RL post 7 --role review --of "$(ofv 7)" --to pending/agent --body "$(mk r1 $'<!-- codex-review-round:1 -->\n## ❌ 打回 1')" >/dev/null
python3 - "$GD/comments.json" <<'PY2'
import json, sys, datetime
d = json.load(open(sys.argv[1]))
now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
def add(login, body):
    d["7"].append({"id": 1000 + sum(len(v) for v in d.values()), "body": body, "user": {"login": login}, "created_at": now})
add("maint", "<!-- codex-review-round:9 -->\n维护者在讨论里贴了个格式示例，然后：请重新来一遍")
add("loop-bot", "讨论：标记长这样 <!-- codex-review-round:3 --> ，不是复审")
add("loop-bot", "<!-- codex-review-round:4 --> 后面还跟着字\n半截写法")
add("loop-bot", "\n<!-- codex-review-round:2 -->\n## ❌ 单独发的复审")
json.dump(d, open(sys.argv[1], "w"))
PY2
mat=$(RL show 7 | sed -n '/^## 复审轮次的材料/,$p')
chk "只认真正的复审：材料按时间依次列出" "$(grep -oE '复审轮次标记 [0-9]+（(往返记录里的复审节 [0-9a-f]+|单独评论 #[0-9]+)|@[a-z-]+ 的评论' <<<"$mat" | tr '\n' '|')" "@maint 的评论|复审轮次标记 1（往返记录里的复审节 $(jq -r '.["7"][] | .body' "$GD/comments.json" | grep -o 'sec id=[0-9a-f]* role=review' | head -1 | cut -d= -f2 | cut -d' ' -f1)|@maint 的评论|复审轮次标记 2（单独评论 #$(jq -r '.["7"][-1].id' "$GD/comments.json")|"
has "维护者贴了标记示例：只当不是 loop 账号写的评论（可能的重置点），带作者" "$mat" "@maint 的评论 #$(jq -r '.["7"][-4].id' "$GD/comments.json")（不是 loop 账号写的）"
lacks "维护者贴的示例不算复审（轮次 9 不出现）" "$mat" "复审轮次标记 9"
lacks "loop 账号正文中间的示例不算" "$mat" "复审轮次标记 3"
lacks "loop 账号半截写法不算" "$mat" "复审轮次标记 4"
has "loop 账号单独发的复审算一轮、带作者" "$mat" "复审轮次标记 2（单独评论 #$(jq -r '.["7"][-1].id' "$GD/comments.json")，@loop-bot）"
has "总数只数真正的复审（2 个）" "$mat" "带复审轮次标记的 2 个，是全部历史"
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
    local o rc; o=$(RL post 7 --role review --of "$(ofv 7)" --to pending/agent --body "$(mk r1 'x')"); rc=$?
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
    o=$(RL post 7 --role review --of "$(ofv 7)" --to pending/agent --body "$(mk r1 $'<!-- codex-review-round:1 -->\n打回')"); rc=$?
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
for miss in "--base main" "--basis aaaa000000000000000000000000000000000001" ""; do
    # shellcheck disable=SC2086
    o=$(RL post 8 --role worker --to pending/review --body "$(mk b1 '修了')" --full "$(mk f1 'PR 说明')" $miss); rc=$?
    chk "PR：漏传本次依据（只给了「${miss:-什么都没给}」）→ 用法不对（不是「照现在单独发」的拒收）" "$rc $(result "$o")" "64 RESULT=usage"
done
chk "PR：漏传依据的三次都零写入" "$(writes)" "0"
o=$(RL post 8 --role worker --to pending/review --body "$(mk b1 '修了')" --full "$(mk f1 'PR 说明')" --basis aaaa000000000000000000000000000000000001 --base main); rc=$?
chk "PR：依据提交、目标分支都对得上 → 写入" "$rc" "0"
o=$(RL post 8 --role review --of "$(ofv 8)" --to pending/agent --body "$(mk r1 'x')" --basis bbbb000000000000000000000000000000000002 --base main); rc=$?
chk "PR：有了不是本次依据的提交 → 已过期" "$rc $(result "$o")" "3 RESULT=expired"
printf '#!/usr/bin/env bash\njq %s "%s/items.json" > "%s/i" && mv "%s/i" "%s/items.json"\n' \
    "'.[\"8\"].base.ref = \"release\"'" "$GD" "$GD" "$GD" "$GD" > "$GD/hook_pulls_8_$(( $(cat "$GD/count_pulls_8" 2>/dev/null || echo 0) + 2 ))"
: > "$CALLS"
o=$(RL post 8 --role review --of "$(ofv 8)" --to pending/agent --body "$(mk r1 'x')" --basis aaaa000000000000000000000000000000000001 --base main); rc=$?
chk "PR：第一次核对之后目标分支变了 → 已过期、零写入" "$rc $(writes)" "3 0"
has "PR：已过期的原因是目标分支变了（不是别的检查）" "$o" "目标分支变了"
# 交付开始后、调用命令之前就改投了：命令第一次读到的已经是新分支，照样要认出来
fresh pr
jq '.["8"].base.ref = "release"' "$GD/items.json" > "$GD/i" && mv "$GD/i" "$GD/items.json"
o=$(RL post 8 --role worker --to pending/review --body "$(mk b1 '修了')" --full "$(mk f1 'PR 说明')" --basis aaaa000000000000000000000000000000000001 --base main); rc=$?
chk "PR：调用之前就改投了 → 已过期、零写入" "$rc $(writes)" "3 0"
has "PR：调用之前就改投了：原因是目标分支变了" "$o" "目标分支变了"
fresh pr
jq '.["8"].head.repo.full_name = "someone/fork"' "$GD/items.json" > "$GD/i" && mv "$GD/i" "$GD/items.json"
o=$(RL post 8 --role worker --to pending/review --body "$(mk b1 '修了')" --full "$(mk f1 'PR 说明')" --basis aaaa000000000000000000000000000000000001 --base main); rc=$?
chk "PR：来源仓库不是本仓库（没给 --source）→ 已过期" "$rc" "3"
o=$(RL post 8 --role worker --to pending/review --body "$(mk b1 '修了')" --full "$(mk f1 'PR 说明')" --basis aaaa000000000000000000000000000000000001 --base main --source someone/fork); rc=$?
chk "PR：给了 --source 且对得上 → 写入" "$rc" "0"
jq '.["8"].merged = true' "$GD/items.json" > "$GD/i" && mv "$GD/i" "$GD/items.json"
o=$(RL post 8 --role review --of "$(ofv 8)" --to pending/agent --body "$(mk r1 'x')" --basis aaaa000000000000000000000000000000000001 --base main); rc=$?
chk "PR：已合并 → 已过期" "$rc" "3"
# 写前读 issue 时还开着，紧接着读 PR 时已经关了（未合并、提交没变）：PR 自己的状态也要核对（复审重派第 1 轮）
pr_state_case() {   # <名字> <PR 的 state 改成什么> <期望退出码 结果>
    fresh pr
    RL post 8 --role worker --to pending/review --body "$(mk b1 '修了')" --full "$(mk f1 'PR 说明')" --basis aaaa000000000000000000000000000000000001 --base main >/dev/null
    local of; of=$(ofv 8)
    local k0; k0=$(cat "$GD/count_pulls_8" 2>/dev/null || echo 0)
    printf '#!/usr/bin/env bash\njq %s "%s/items.json" > "%s/i" && mv "%s/i" "%s/items.json"\n' \
        "'.[\"8\"].state = $2'" "$GD" "$GD" "$GD" "$GD" > "$GD/hook_pulls_8_$((k0 + 1))"
    : > "$CALLS"
    local o rc
    o=$(RL post 8 --role review --of "$of" --to pending/agent --body "$(mk r1 'x')" --basis aaaa000000000000000000000000000000000001 --base main); rc=$?
    chk "$1：$3、零写入" "$rc $(result "$o") $(writes)" "$3 0"
    chk "$1：issue 资源确实读到的是打开（关闭是在读 PR 时才看到的）" "$(grep -c 'api repos/example/rl/issues/8\b' "$CALLS" | awk '{print ($1 >= 1) ? "yes" : "no"}')" "yes"
}
pr_state_case "PR：读 issue 后、读 PR 前被关闭（未合并）" '"closed"' "3 RESULT=expired"
pr_state_case "PR：PR 的状态读回来是没见过的值" '"weird"' "4 RESULT=unknown"
pr_state_case "PR：PR 的状态字段缺失" 'null' "4 RESULT=unknown"
# 最后一次读 PR 时维护者把标签改成了交人（读 issue 时还是派工中）：PR 响应的标签同样要核对（复审重派第 2 轮）。
# 新发、追加、改写失败后另起三条写入路径都要拦住；对照：标签没变时照常写入
# hook_lbl <PR 资源第几次读> <标签 JSON>：那一次读之前把 8 号的标签换掉
hook_lbl() {
    printf '#!/usr/bin/env bash\njq %s "%s/labels.json" > "%s/l" && mv "%s/l" "%s/labels.json"\n' \
        "'.[\"8\"] = $2'" "$GD" "$GD" "$GD" "$GD" > "$GD/hook_pulls_8_$1"
}
pr_label_case() {   # <名字> <路径：new|append|fallback> <换成的标签 JSON|空=不换> <期望退出码 结果> <期望写请求数>
    fresh pr
    local base_args=(--basis aaaa000000000000000000000000000000000001 --base main)
    if [ "$2" != new ]; then
        RL post 8 --role worker --to pending/review --body "$(mk b1 '修了')" --full "$(mk f1 'PR 说明')" "${base_args[@]}" >/dev/null
    fi
    local of; of=$(ofv 8)
    [ "$2" = fallback ] && : > "$GD/F_patch_comment"
    local k0; k0=$(cat "$GD/count_pulls_8" 2>/dev/null || echo 0)
    # 这次写入命令读 PR 资源的次数：开头一次 + 每次写之前一次（另起时改写前、另起前各一次）
    local last=$((k0 + 2)); [ "$2" = fallback ] && last=$((k0 + 3))
    [ -z "$3" ] || hook_lbl "$last" "$3"
    : > "$CALLS"
    local o rc
    if [ "$2" = new ]; then
        o=$(RL post 8 --role worker --to pending/review --body "$(mk b1 '修了')" --full "$(mk f1 'PR 说明')" "${base_args[@]}"); rc=$?
    else
        o=$(RL post 8 --role review --of "$of" --to pending/agent --body "$(mk r1 'x')" "${base_args[@]}"); rc=$?
    fi
    rm -f "$GD/F_patch_comment"
    chk "$1：结果" "$rc $(result "$o")" "$4"
    chk "$1：写请求数" "$(writes)" "$5"
    chk "$1：PR 资源确实读到了第 $((last - k0)) 次（换标签的那一次就是写前最后一次）" "$(( $(cat "$GD/count_pulls_8") - k0 ))" "$((last - k0))"
}
pr_label_case "PR 新发：最后一次读 PR 时已改成交人" new '["pending/human"]' "3 RESULT=expired" 0
pr_label_case "PR 追加：最后一次读 PR 时已改成交人" append '["pending/human"]' "3 RESULT=expired" 0
pr_label_case "PR 改写失败后另起：另起前读 PR 时已改成交人（改写那一次已发出）" fallback '["pending/human"]' "3 RESULT=expired" 1
pr_label_case "PR 追加：最后一次读 PR 时摘掉了派工中" append '[]' "3 RESULT=expired" 0
pr_label_case "PR 追加：最后一次读 PR 时挂上了等前置" append '["doing/agent","pending/blocked"]' "3 RESULT=expired" 0
pr_label_case "对照 PR 新发：标签没变 → 照常写入" new '' "0 RESULT=written" 1
pr_label_case "对照 PR 追加：标签没变 → 照常写入" append '' "0 RESULT=written" 1
pr_label_case "对照 PR 改写失败后另起：标签没变 → 另起写入" fallback '' "0 RESULT=written" 2
# PR 响应里有一个没名字的标签（读不懂）→ 未知，不写
pr_label_case "PR 追加：PR 响应的标签读不懂" append '[""]' "4 RESULT=unknown" 0
# issue 上同一时序：读完关联 PR 列表之后 issue 已改成交人 → 不写
fresh issue
RL post 7 --role worker --to pending/review --body "$(mk b1 '第 1 版')" --full "$(mk f1 'V1')" >/dev/null
of=$(ofv 7)
k0=$(cat "$GD/count_pulls" 2>/dev/null || echo 0)
printf '#!/usr/bin/env bash\njq %s "%s/labels.json" > "%s/l" && mv "%s/l" "%s/labels.json"\n' \
    "'.[\"7\"] = [\"doing/agent\",\"pending/human\"]'" "$GD" "$GD" "$GD" "$GD" > "$GD/hook_pulls_$((k0 + 2))"
: > "$CALLS"
o=$(RL post 7 --role review --of "$of" --to pending/agent --body "$(mk r1 $'<!-- codex-review-round:1 -->\n## ❌ 打回')"); rc=$?
chk "issue：读关联 PR 列表时 issue 已改成交人 → 已过期、零写入" "$rc $(result "$o") $(writes)" "3 RESULT=expired 0"
has "issue：已过期的原因是已有人接手" "$o" "已有人接手"
fresh issue
python3 - "$GD/items.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
d["9"] = {"kind": "pr", "state": "open", "title": "p", "body": "Closes #7", "head": {"ref": "feature/issue-7", "sha": "c" * 40, "repo": {"full_name": "example/rl"}}, "base": {"ref": "main"}}
json.dump(d, open(sys.argv[1], "w"))
PY
o=$(RL post 7 --role worker --to pending/review --body "$(mk b1 'x')" --full "$(mk f1 'V')"); rc=$?
chk "issue：已经有了工作分支的 PR（不再是方案阶段）→ 已过期" "$rc" "3"

echo "── 旧式交付（开关打开前的独立评论）上的复审 ──"
fresh issue
python3 - "$GD/comments.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
d["7"].append({"id": 300, "body": "## 方案第 3 版（开关打开前的独立评论）\n方案全文", "user": {"login": "loop-bot"}, "created_at": "2026-01-02T00:00:00Z"})
json.dump(d, open(sys.argv[1], "w"))
PY
: > "$CALLS"
o=$(RL post 7 --role review --of "$(ofv 7)" --to pending/agent --body "$(mk r1 $'<!-- codex-review-round:1 -->\n打回')"); rc=$?
chk "旧式交付上的复审：拒收，照现在单独发" "$rc $(result "$o")" "2 RESULT=rejected"
has "旧式交付上的复审：说明原因" "$o" "所审的交付是一条单独的评论、不在往返记录里"
chk "旧式交付上的复审：零写入（不留一条读不出版本的记录）" "$(writes) $(records)" "0 0"
o=$(RL show 7); rc=$?
chk "旧式交付上的复审：读取照常（退出码 0）" "$rc" "0"
# 复审照现在单独发出之后，worker 下一次交付开第一条往返记录，之后的复审照常追加
python3 - "$GD/comments.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
d["7"].append({"id": 301, "body": "<!-- codex-review-round:1 -->\n打回（单独发的）", "user": {"login": "loop-bot"}, "created_at": "2026-01-02T01:00:00Z"})
json.dump(d, open(sys.argv[1], "w"))
PY
RL post 7 --role worker --to pending/review --body "$(mk b2 '第 4 版')" --full "$(mk f2 'V4 全文')" >/dev/null
o=$(RL post 7 --role review --of "$(ofv 7)" --to pending/agent --body "$(mk r2 $'<!-- codex-review-round:2 -->\n再打回')"); rc=$?
chk "之后的复审追加进新记录" "$rc $(printf '%s' "$o" | grep ^MODE=)" "0 MODE=append"
o=$(RL show 7); rc=$?
chk "之后读取照常（退出码 0）" "$rc" "0"
has "之后读取：附着第 4 版全文" "$(sed -n '/最新单元对应的完整版本/,$p' <<<"$o")" "V4 全文"
has "之后读取：轮次 2 个（单独发的 1 个 + 记录里 1 个）" "$o" "带复审轮次标记的 2 个"

echo "── 新旧混合：记录里的第 1 版 → 单独发的第 2 版 → 打回 → 续跑 ──"
fresh issue
RL post 7 --role worker --to pending/review --body "$(mk b1 '第 1 版')" --full "$(mk f1 '方案全文 V1')" >/dev/null
V1SEC=$(jq -r '.["7"][-1].body' "$GD/comments.json" | grep -o 'sec id=[0-9a-f]*' | head -1 | cut -d= -f2)
python3 - "$GD/comments.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
d["7"].append({"id": 1000 + sum(len(v) for v in d.values()), "body": "## 方案第 2 版（单独发的）\n方案全文 V2", "user": {"login": "loop-bot"}, "created_at": "2026-01-03T00:00:00Z"})
json.dump(d, open(sys.argv[1], "w"))
PY
: > "$CALLS"
o=$(RL post 7 --role review --of "$(ofv 7)" --to pending/agent --body "$(mk r1 $'<!-- codex-review-round:1 -->\n打回第 2 版')"); rc=$?
chk "最新交付是单独的评论：复审结论拒收（不挂到记录里的第 1 版上）" "$rc $(result "$o")" "2 RESULT=rejected"
o=$(RL post 7 --role review --to pending/agent --of "$V1SEC" --body "$(mk r1 $'<!-- codex-review-round:1 -->\n打回第 2 版')"); rc=$?
chk "给 --of 第 1 版：它之后已经有了新交付 → 过期（不发、不翻标签）" "$rc $(result "$o")" "3 RESULT=expired"
chk "两次都零写入" "$(writes)" "0"
python3 - "$GD/comments.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
d["7"].append({"id": 1000 + sum(len(v) for v in d.values()), "body": "<!-- codex-review-round:1 -->\n打回第 2 版（单独发的）", "user": {"login": "loop-bot"}, "created_at": "2026-01-03T01:00:00Z"})
json.dump(d, open(sys.argv[1], "w"))
PY
RL post 7 --role worker --to pending/review --body "$(mk b3 '第 3 版')" --full "$(mk f3 '方案全文 V3')" >/dev/null
o=$(RL post 7 --role review --of "$(ofv 7)" --to pending/agent --body "$(mk r3 $'<!-- codex-review-round:2 -->\n打回第 3 版')"); rc=$?
chk "续跑：第 3 版之后的复审追加进新记录" "$rc $(printf '%s' "$o" | grep ^MODE=)" "0 MODE=append"
o=$(RL show 7); rc=$?
chk "续跑：读取成功" "$rc" "0"
has "续跑：打回意见附着的是第 3 版全文" "$(sed -n '/最新单元对应的完整版本/,$p' <<<"$o")" "方案全文 V3"
lacks "续跑：没有附上第 1 版" "$(sed -n '/最新单元对应的完整版本/,$p' <<<"$o")" "V1"

echo "── 复审依据从读取带到写入：审的过程中又来了新交付 ──"
fresh issue
RL post 7 --role worker --to pending/review --body "$(mk b1 '第 1 版')" --full "$(mk f1 '方案全文 V1')" >/dev/null
o=$(RL post 7 --role review --to pending/agent --body "$(mk r0 'x')"); rc=$?
chk "复审没给 --of：用法不对（不是「照现在单独发」）" "$rc $(result "$o")" "64 RESULT=usage"
READ_OF=$(ofv 7)
chk "读取命令标出了所审那一节的 --of 值" "$( [ -n "$READ_OF" ] && echo yes)" "yes"
RL post 7 --role worker --to pending/review --body "$(mk b2 '第 2 版')" --full "$(mk f2 '方案全文 V2')" >/dev/null
: > "$CALLS"
o=$(RL post 7 --role review --of "$READ_OF" --to pending/agent --body "$(mk r1 $'<!-- codex-review-round:1 -->\n打回第 1 版')"); rc=$?
chk "读完第 1 版后又交了第 2 版：第 1 版的结论过期，不发" "$rc $(result "$o")" "3 RESULT=expired"
chk "过期的结论：零写入（没有改成单独发）" "$(writes)" "0"
has "过期的结论：说明是被新交付取代" "$o" "已经不是最新的交付"
READ_OF=$(ofv 7)
o=$(RL post 7 --role review --of "$READ_OF" --to pending/agent --body "$(mk r2 $'<!-- codex-review-round:1 -->\n打回第 2 版')"); rc=$?
chk "重新读到第 2 版再发：写入" "$rc $(result "$o")" "0 RESULT=written"
o=$(RL show 7)
has "重新读到第 2 版再发：打回意见附着第 2 版全文" "$(sed -n '/最新单元对应的完整版本/,$p' <<<"$o")" "方案全文 V2"
has "重新读到第 2 版再发：最新单元是第 2 版的打回" "$(sed -n '/^## 最新单元：/,/^## 最新单元对应/p' <<<"$o")" "打回第 2 版"

echo "── 首次开 PR：交付说明只写在 PR 正文里（线程里一条评论都没有）──"
fresh pr
echo '{"8": []}' > "$GD/comments.json"
o=$(RL show 8); rc=$?
chk "只有 PR 正文：读取成功" "$rc" "0"
READ_OF=$(ofv 8)
chk "只有 PR 正文：读取命令标出 --of body" "$READ_OF" "body"
B='--basis aaaa000000000000000000000000000000000001 --base main'
: > "$CALLS"
# shellcheck disable=SC2086
o=$(RL post 8 --role review --of "$READ_OF" --to pending/agent --body "$(mk r1 $'<!-- codex-review-round:1 -->\n打回首次交付')" $B); rc=$?
chk "只有 PR 正文、它仍是最新交付：复审结论拒收，照现在单独发（不是停下）" "$rc $(result "$o")" "2 RESULT=rejected"
has "只有 PR 正文：说明是正文本身" "$o" "所审的交付是正文本身"
chk "只有 PR 正文：命令自己零写入（结论由复审照现在单独发）" "$(writes)" "0"
# 复审照现在单独发了打回，worker 修完交下一版：从这里起进往返记录
python3 - "$GD/comments.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
d["8"].append({"id": 1000 + sum(len(v) for v in d.values()), "body": "<!-- codex-review-round:1 -->\n打回首次交付（单独发的）", "user": {"login": "loop-bot"}, "created_at": "2026-01-02T00:00:00Z"})
json.dump(d, open(sys.argv[1], "w"))
PY
# shellcheck disable=SC2086
o=$(RL post 8 --role worker --to pending/review --body "$(mk b2 '修了打回的两处')" --full "$(mk f2 'PR 说明 第 2 版')" $B); rc=$?
chk "worker 交下一版：开第一条往返记录" "$rc $(printf '%s' "$o" | grep ^MODE=)" "0 MODE=new"
: > "$CALLS"
# shellcheck disable=SC2086
o=$(RL post 8 --role review --of body --to pending/agent --body "$(mk r2 $'<!-- codex-review-round:2 -->\n对首次交付的旧结论')" $B); rc=$?
chk "期间已有新交付：按 PR 正文写的旧结论过期，不发" "$rc $(result "$o")" "3 RESULT=expired"
chk "期间已有新交付：零写入" "$(writes)" "0"
READ_OF=$(ofv 8)
# shellcheck disable=SC2086
o=$(RL post 8 --role review --of "$READ_OF" --to pending/agent --body "$(mk r3 $'<!-- codex-review-round:2 -->\n打回第 2 版')" $B); rc=$?
chk "重读后对第 2 版发结论：追加进记录" "$rc $(printf '%s' "$o" | grep ^MODE=)" "0 MODE=append"
o=$(RL show 8)
has "重读后：打回附着第 2 版 PR 说明" "$(sed -n '/最新单元对应的完整版本/,$p' <<<"$o")" "PR 说明 第 2 版"
# 受保护读取的视图（PR 没有对话评论）：同样标出 --of body
o=$(OS_RES='{"view": []}' OS_TARGET_KIND=pr CODING_AGENT_CONFIG="$CONF" bash -c 'source "$1/scripts/_lib.sh" >/dev/null 2>&1; round_log_view_from_scan' _ "$REPO_DIR"); rc=$?
chk "受保护读取视图、PR 没有对话评论：成功" "$rc" "0"
has "受保护读取视图、PR 没有对话评论：标出 --of body" "$o" "--of body"

echo "── 托管 + 外部内容保护：写入路径也走受保护读取 ──"
GUARD=('LABEL_AUTOPILOT="autopilot"' 'LABEL_PENDING_MERGE="pending/merge"' 'AUTOPILOT_OUTSIDER_GUARD="on"' 'AUTOPILOT_OUTSIDER_SCREEN=""')
fresh issue "${GUARD[@]}"
echo '{"maint": "admin", "loop-bot": "write"}' > "$GD/perms.json"
o=$(RL post 7 --role worker --to pending/review --body "$(mk b1 '第 1 版')" --full "$(mk f1 'V1')"); rc=$?
chk "保护开着、受保护读取读全：写入" "$rc $(result "$o")" "0 RESULT=written"
has "保护开着：确实跑了受保护读取（查了评论作者的权限）" "$(cat "$CALLS")" "collaborators/maint/permission"
: > "$CALLS"
OFX=$(ofv 7)
: > "$GD/F_collaborators_maint_permission"
: > "$CALLS"
o=$(RL post 7 --role review --of "$OFX" --to pending/agent --body "$(mk r1 $'<!-- codex-review-round:1 -->\n打回')"); rc=$?
chk "保护开着、原样评论读得到但受保护读取失败：不写" "$rc $(result "$o")" "5 RESULT=unreadable"
chk "受保护读取失败：零写入" "$(writes)" "0"
has "受保护读取失败：原样评论确实读成功了（失败的只是受保护读取）" "$(cat "$CALLS")" "issues/7/comments"
rm -f "$GD/F_collaborators_maint_permission"
o=$(RL show 7); rc=$?
chk "保护开着：读取命令也走受保护读取、成功" "$rc" "0"
# 两次读之间同一条评论被改了（编号不变、版本变了）：不写
OFX=$(ofv 7)
printf '#!/usr/bin/env bash\npython3 - "%s/comments.json" <<'"'"'PY'"'"'\nimport json, sys\nd = json.load(open(sys.argv[1]))\nd["7"][0]["body"] = "人改过的需求"\nd["7"][0]["updated_at"] = "2026-02-01T00:00:00Z"\njson.dump(d, open(sys.argv[1], "w"))\nPY\n' "$GD" > "$GD/hook_issues_7_comments_$(( $(cat "$GD/count_issues_7_comments" 2>/dev/null || echo 0) + 2 ))"
: > "$CALLS"
o=$(RL post 7 --role review --of "$OFX" --to pending/agent --body "$(mk r1 $'<!-- codex-review-round:1 -->\n打回')"); rc=$?
chk "两次读之间评论被改：不写" "$rc $(result "$o")" "5 RESULT=unreadable"
has "两次读之间评论被改：原因是版本不同" "$o" "编号或版本不同"
chk "两次读之间评论被改：零写入" "$(writes)" "0"
# 记录作者是别的机器人账号（名字也以 -bot 结尾）：写入、读取都只当普通评论
fresh issue
python3 - "$GD/comments.json" "$REPO_DIR/scripts" <<'PY'
import json, sys
sys.path.insert(0, sys.argv[2])
import round_log
d = json.load(open(sys.argv[1]))
body = round_log.new_record("aaaaaa000001", "别人的版本", round_log.section_text("aaaaaa000001", "worker", "2026-01-01T01:00:00Z", 100, None, "别人的一节"))
d["7"].append({"id": 400, "body": body, "user": {"login": "other-bot"}, "created_at": "2026-01-01T01:00:00Z"})
json.dump(d, open(sys.argv[1], "w"))
PY
o=$(RL show 7 --all)
chk "别的机器人账号写的「记录」：读取当一条普通评论（2 个单元）" "$(grep -c '^### 单元 ' <<<"$o")" "2"
o=$(RL post 7 --role worker --to pending/review --body "$(mk b1 '第 1 版')" --full "$(mk f1 'V1')")
has "别的机器人账号写的「记录」：写入不往里追加，另开一条" "$o" "MODE=new"

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
RL post 7 --role review --of "$(ofv 7)" --to pending/agent --body "$(mk r1 "<!-- codex-review-round:1 -->
打回
$FOOT2")" >/dev/null
o=$(WEEKLY_REPORT_BOT_LOGINS=loop-bot PYTHONPATH="$REPO_DIR/scripts:$REPO_DIR/scripts/weekly-report" python3 - "$GD/comments.json" <<'PY'
import json, sys
import round_log, record
cs = json.load(open(sys.argv[1]))["7"]
for c in cs:
    c.setdefault("html_url", "")
units = round_log.expand_github_comments(cs, round_log.trusted_by("loop-bot"))
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

echo "── 8b. 同一条线程：读取命令、周报、单 PR 统计认记录的规则相同 ──"
fresh issue
F1='<!-- agent-metrics agent=claude wt=7 start=2026-01-05T01:00:00+08:00 end=2026-01-05T01:05:00+08:00 wall_secs=300 in=1 out=2 cache_r=3 cache_w=4 cost_usd=0.5 -->'
RL post 7 --role worker --to pending/review --body "$(mk b1 "第 1 版
$F1")" --full "$(mk f1 'V1')" >/dev/null
python3 - "$GD/comments.json" "$REPO_DIR/scripts" <<'PY'
import json, sys
sys.path.insert(0, sys.argv[2])
import round_log
d = json.load(open(sys.argv[1]))
body = round_log.new_record("bbbbbb000001", "别人的版本", round_log.section_text("bbbbbb000001", "worker", "2026-01-06T01:00:00Z", 2000, None, "别人的一节"))
d["7"].append({"id": 2000, "body": body, "user": {"login": "other-bot"}, "created_at": "2026-01-06T01:00:00Z"})
json.dump(d, open(sys.argv[1], "w"))
PY
show_n=$(RL show 7 --all | grep -c '^### 单元 ')
stats=$(FAKE_GH_DIR="$GD" WEEKLY_REPORT_BOT_LOGINS="loop-bot,other-bot" python3 - "$REPO_DIR/scripts" "$GD/comments.json" <<'PY' 2>&1
import json, sys, importlib.util
sys.path.insert(0, sys.argv[1]); sys.path.insert(0, sys.argv[1] + "/weekly-report")
import collect
spec = importlib.util.spec_from_file_location("pts", sys.argv[1] + "/pr-time-stats.py")
pts = importlib.util.module_from_spec(spec); spec.loader.exec_module(pts)
cs = json.load(open(sys.argv[2]))["7"]
for c in cs:
    c["issue_url"] = "https://api.github.com/repos/example/rl/issues/7"
w = collect.expand_round_logs("example/rl", [c for c in cs if c["id"] >= 1000])
p = pts.expand_rl(cs)
print("weekly=%d pr=%d" % (len(w), len(p)))
PY
)
chk "同一线程：读取命令拆出 3 个单元（人的评论 + 1 节 + 别人的那条当普通评论）" "$show_n" "3"
chk "同一线程：周报、单 PR 统计拆出的条数与读取命令一致（别的机器人账号写的不认，名字以 -bot 结尾也不认）" "$stats" "weekly=3 pr=3"
# 可信账号写的记录坏了：两个统计入口都报错退出，不悄悄按整条评论算
python3 - "$GD/comments.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
for c in d["7"]:
    if c["user"]["login"] == "loop-bot" and c["body"].startswith("<!-- cavil-round-log"):
        c["body"] = c["body"].replace("<!-- cavil-round-log:sec-end -->", "", 1)
json.dump(d, open(sys.argv[1], "w"))
PY
o=$(FAKE_GH_DIR="$GD" python3 - "$REPO_DIR/scripts" "$GD/comments.json" <<'PY' 2>&1
import json, sys
sys.path.insert(0, sys.argv[1]); sys.path.insert(0, sys.argv[1] + "/weekly-report")
import collect
cs = json.load(open(sys.argv[2]))["7"]
for c in cs:
    c["issue_url"] = "https://api.github.com/repos/example/rl/issues/7"
collect.expand_round_logs("example/rl", [c for c in cs if c["id"] >= 1000])
print("NOT-EXITED")
PY
); rc=$?
chk "记录坏了：周报整次退出" "$rc" "2"
lacks "记录坏了：周报没有继续往下算" "$o" "NOT-EXITED"
o=$(FAKE_GH_DIR="$GD" python3 - "$REPO_DIR/scripts" "$GD/comments.json" <<'PY' 2>&1
import json, sys, importlib.util
spec = importlib.util.spec_from_file_location("pts", sys.argv[1] + "/pr-time-stats.py")
pts = importlib.util.module_from_spec(spec); spec.loader.exec_module(pts)
cs = json.load(open(sys.argv[2]))["7"]
try:
    pts.expand_rl(cs)
    print("NO-ERROR")
except pts.Fail as e:
    print("FAIL:%s" % e)
PY
)
has "记录坏了：单 PR 统计报错（不出半份数字）" "$o" "FAIL:往返记录"
o=$(RL show 7); rc=$?
chk "记录坏了：读取命令也报错（退出码 4，读不懂）" "$rc" "4"

echo "── 10. 提示词 ──"
fresh issue
sec=$(CODING_AGENT_CONFIG="$CONF" bash -c 'source "$1/scripts/_lib.sh" >/dev/null 2>&1; f=$(compose_prompt_template review); cat "$f"' _ "$REPO_DIR")
has "开着：复审提示词多了往返记录一段" "$sec" "# 往返记录（本项目开启了"
lacks "开着：占位符都填上了" "$sec" "@@"
has "开着：写入命令指向本次的脚本" "$sec" "round-log.sh' --config '$CONF' post <编号>"
has "开着：缺本次依据时提示词要求补齐重跑、不改成单独发" "$sec" "| \`RESULT=usage\`（64） | 用法不对，包括发到 PR 上没给"
has "开着：缺本次依据时补不齐就不发、不翻标签" "$sec" "补不齐就不发评论、不翻标签，停下"
has "开着：复审必须带读取时标出的 --of、原样照抄" "$sec" "复审**必须**带 \`--of\`"
has "开着：过期的复审结论不改成单独发" "$sec" "**也不改成单独发**"
has "开着：记录读不懂按读评论失败处理、不改成单独发" "$sec" "| \`RESULT=unreadable\`（5） | 评论读不全，或评论区里已有的往返记录读不懂（缺标记、版本对不上） | 什么都没写；照上文读评论失败的规则处理，**不改成单独发**、不翻标签 |"
has "开着：首次交付只有正文时的 --of 写法" "$sec" "| 正文本身（线程里还没有任何交付，如首次开 PR 时交付说明只写在 PR 正文里） | \`body\` | 拒收：照上文单独发 | 过期：不发、不翻标签 |"
has "开着：轮次仍按最近一次人工动作重置（照上文的办法定重置点）" "$sec" "仍是「最近一次人工动作之后本目标第几轮」"
has "开着：材料里的总数是全部历史、只数重置点之后的" "$sec" "那里的总数是**全部历史**，不是当前轮次——只数重置点之后的带标记单元"
has "开着：只改标签、编辑评论要另外查" "$sec" "只改了标签、编辑了评论这类动作不在这份材料里，必须另外查"
has "开着：复审模板本身的重置规则仍在（读 issue events、派工账号以外的动作才重置）" "$sec" "只有 actor/login **不同于派工账号** 的动作才可重置轮次"
lacks "开着：不再叫复审直接用末尾的总数" "$sec" "数单元里带轮次标记的个数（输出末尾写了）"
fresh issue 'ENABLE_ROUND_LOG=""'
sec=$(CODING_AGENT_CONFIG="$CONF" bash -c 'source "$1/scripts/_lib.sh" >/dev/null 2>&1; f=$(compose_prompt_template review); cat "$f"' _ "$REPO_DIR")
lacks "关着：不加这一段" "$sec" "# 往返记录（本项目开启了"

echo
echo "通过 $pass，失败 $fail"
report_counts "$pass" "$fail"
[ "$fail" -eq 0 ]
