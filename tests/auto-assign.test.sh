#!/usr/bin/env bash
# kind: e2e
# 新建的 issue / PR 自动把提出者设为 assignee 的守卫 —— GitHub#690。
#
# 跑法：bash tests/auto-assign.test.sh      （约 1 分钟）
# 依赖：jq、python3。不碰网络：假 gh（tests/fixtures/auto-assign-fake-gh.py）是带状态的最小 GitHub，
# 每次调用记一行，写请求带着调用时的身份名。
#
# 每一轮都**真的**起 agent-poll.sh 子进程（派工脚本换成只记一行的桩），所以「派工照常」是数派工记录
# 数出来的，「写了几次、写给谁、用的哪把令牌」是数调用记录数出来的。
#
# 这块错了都不报错，只会悄悄变成别的样子：
#   · 只读固定条数 → 停机积压、读失败后被挤出窗口的条目永远没人指派
#   · 读失败当成「没有提出者」/ 连续失败就放弃 → 服务恢复后那条也不会再补
#   · 记录裁剪后又读到老条目 → 人删掉的指派被加回来
#   · 写前只看几个字段 → 关联改了仍按旧关系指给旧的人
#   · PR 用「当成自己编号」兜底 / 子 issue 刚建还没挂父就记「没有」→ 指错或漏指
set -uo pipefail
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
FAKE="$TEST_DIR/fixtures/auto-assign-fake-gh.py"

unset CODING_AGENT_RELEASE_ROOT CLAUDE_PLUGIN_ROOT CAVIL_DEPLOY_ROOT CAVIL_DEPLOY_CONF \
      CODING_AGENT_CONFIG CODING_AGENT_RELEASE_LEASE_FD TICK_DIR GH_TOKEN WRITE_GH_TOKEN PROJECT_GH_TOKEN \
      AUTO_ASSIGN_REQUESTER REQUESTER_BOT_ACCOUNT DISPATCH_PROMPT_KIND
export TZ=UTC

SANDBOX=$(mktemp -d)
cleanup() { [ -n "${KEEP_SANDBOX:-}" ] && { echo "SANDBOX=$SANDBOX"; return 0; }; rm -rf "$SANDBOX"; }
trap cleanup EXIT
mkdir -p "$SANDBOX/bin" "$SANDBOX/home"
export HOME="$SANDBOX/home"
bash "$TEST_DIR/lib/fake_gh_client.sh" install "$SANDBOX/bin/gh" python3 -I "$FAKE"

POLL_TOKEN="ghp_POLL0000000000000000000000000000000"
WRITE_TOKEN="ghp_WRIT2222222222222222222222222222222"

pass=0; fail=0
chk() {
    if [ "$2" = "$3" ]; then echo "  ✅ $1"; pass=$((pass+1))
    else echo "  ❌ $1 (期望 [$3]，实得 [$2])"; fail=$((fail+1)); fi
}

# ── 被测脚本副本：派工脚本换成桩（记一行），其余原样 ──
SCRIPTS="$SANDBOX/real"
mkdir -p "$SCRIPTS"
cp -r "$REPO_DIR/scripts" "$REPO_DIR/prompts" "$SCRIPTS/"
for f in dispatch-new-issue dispatch-issue-comment dispatch-pr-comment; do
    cat > "$SCRIPTS/scripts/$f.sh" <<'STUB'
#!/usr/bin/env bash
echo "$(basename "$0" .sh) $1" >> "$FAKE_GH_DIR/dispatch.log"
STUB
done

iso_ago() { date -u -d "@$(( $(date +%s) - $1 ))" +%Y-%m-%dT%H:%M:%SZ; }
OLD="$(iso_ago 7200)"     # 建好两小时：早过了等关系、等列表稳定的时间

# new_env [KEY=VAL...]：开关默认开
new_env() {
    W="$SANDBOX/w"
    rm -rf "$W"; mkdir -p "$W/state" "$W/gh" "$W/wt" "$W/project"
    cat > "$W/cavil-loop.config" <<CONF
REPO="acme/widget"
PROJECT_ROOT="$W/project"
WORKTREE_BASE="$W/wt"
STATE_DIR="$W/state"
TMUX_PREFIX="aatest$$"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
LABEL_AGENT_DOING="doing/agent"
LABEL_PENDING_REVIEW="pending/review"
MAX_CONCURRENT_WORKERS=50
POST_MERGE_RETROSPECTIVE=false
AUTO_CLEANUP_ON_MERGE=false
PENDING_HUMAN_CONFLICT_CHECK=false
POLL_BACKOFF_LADDER=""
PRICE_AUTO_FETCH=0
WORKER_SECRET_ENV=""
GH_TOKEN="$POLL_TOKEN"
WRITE_GH_TOKEN="$WRITE_TOKEN"
REQUESTER_BOT_ACCOUNT="req-bot"
AUTO_ASSIGN_REQUESTER=true
PATH="$SANDBOX/bin:\$PATH"
CONF
    local kv; for kv in "$@"; do printf '%s\n' "$kv" >> "$W/cavil-loop.config"; done
    chmod 600 "$W/cavil-loop.config"
    jq -n --arg p "$POLL_TOKEN" --arg w "$WRITE_TOKEN" '{
        repo: "acme/widget",
        tokens: {($p): "poll", ($w): "write"},
        logins: {poll: "loop-bot", write: "loop-bot"},
        items: {}, unassignable: [], faults: [], hooks: []
    }' > "$W/gh/world.json"
    : > "$W/gh/calls.log"; : > "$W/gh/dispatch.log"
}
world() { jq "$@" "$W/gh/world.json" > "$W/gh/world.tmp" && mv "$W/gh/world.tmp" "$W/gh/world.json"; }
# item <n> <issue|pr> <作者> [jq 赋值片段，作用在这一条上]
item() {
    local n="$1" k="$2" u="$3" extra="${4:-.}"
    world --arg n "$n" --arg k "$k" --arg u "$u" --arg c "$OLD" \
        ".items[\$n] = ({kind: \$k, state: \"open\", user: \$u, utype: \"User\", assignees: [], body: \"\", created_at: \$c, labels: []} | $extra)"
}
set_item() { world --arg n "$1" ".items[\$n] |= ($2)"; }
assignees() { jq -r --arg n "$1" '.items[$n].assignees | join(",")' "$W/gh/world.json"; }
tick() {
    : > "$W/gh/calls.log"; : > "$W/gh/dispatch.log"
    env FAKE_GH_DIR="$W/gh" CODING_AGENT_CONFIG="$W/cavil-loop.config" bash "$SCRIPTS/scripts/agent-poll.sh" >/dev/null 2>&1
}
n_calls() { grep -cE -- "$1" "$W/gh/calls.log" 2>/dev/null || true; }
writes() { n_calls '^WRITE assign'; }
writes_of() { n_calls "^WRITE assign #$1 "; }
st() { jq -c "$1" "$W/state/auto-assign.json" 2>/dev/null || echo 无; }
log_has() { grep -cF -- "$1" "$W/state/poll.log" 2>/dev/null || true; }
dispatched() { grep -c . "$W/gh/dispatch.log" 2>/dev/null || true; }
# 起点：仓库里已有 #1（派工用的条目），第一轮记下进度
start() { item 1 issue alice '.labels = ["pending/agent"]'; tick; }
SUBMARK() { printf '%s' "body\\n\\n<!-- agent-split-from: #$1 -->"; }
PARENT_URL() { printf 'https://api.github.com/repos/acme/widget/issues/%s' "$1"; }

echo "── 1. 开关关着：一个请求都不多发，派工照常 ──"
new_env AUTO_ASSIGN_REQUESTER=false
item 1 issue alice '.labels = ["pending/agent"]'
item 2 issue bob
tick
chk "派工照常（这一轮确实跑到了派工）" "$(dispatched)" 1
chk "没读按新建时间排的列表" "$(n_calls 'sort=created')" 0
chk "没有指派写入" "$(writes)" 0
chk "没有状态文件" "$(st .)" 无
new_env AUTO_ASSIGN_REQUESTER=""
item 1 issue alice '.labels = ["pending/agent"]'
tick
chk "写成空值也是关：没读列表" "$(n_calls 'sort=created')" 0
for v in 1 yes TRUE on; do
    new_env "AUTO_ASSIGN_REQUESTER=$v"
    item 1 issue alice '.labels = ["pending/agent"]'
    tick
    chk "写成 $v 也是关（说明里只有 true 算开）：没读列表、派工照常" "$(n_calls 'sort=created')/$(dispatched)" "0/1"
done

echo "── 2. 第一次打开：只记下进度，不回头补历史条目 ──"
new_env
item 1 issue alice '.labels = ["pending/agent"]'
item 2 issue bob
tick
chk "派工照常" "$(dispatched)" 1
chk "进度记成当前最大编号" "$(st .cursor)" 2
chk "历史条目没被指派" "$(writes)" 0
tick
chk "第二轮也不回头补 #2" "$(assignees 2)" ""

echo "── 3. 提出者怎么认 ──"
new_env; start
item 2 issue bob                                                   # 人开的 issue
item 3 pr loop-bot '.head_ref = "feature/issue-2"'                  # agent 开的 PR，分支对上 #2
item 4 issue carol
item 5 pr loop-bot '.head_ref = "fix-something" | .body = "改了点东西\n\nCloses #4"'   # 正文关联
item 6 issue loop-bot ".parent = \"$(PARENT_URL 4)\" | .body = \"$(SUBMARK 4)\""      # 拆出的子 issue
item 7 issue loop-bot ".parent = \"$(PARENT_URL 6)\" | .body = \"$(SUBMARK 6)\""      # 子项的子项
item 8 pr loop-bot '.head_ref = "feature/issue-7"'                  # 子项的 PR
item 9 issue dave '.assignees = ["erin"]'                           # 已有 assignee
item 10 issue loop-bot '.body = "CI 失败报告"'                       # daemon 自己开的，没有来源
item 11 issue req-bot                                               # 外部需求机器人开的
item 12 issue "app/ci" '.utype = "Bot"'                             # GitHub App
item 13 pr loop-bot '.head_ref = "feature/issue-3"'                 # 对上的编号是 PR
item 14 pr loop-bot '.head_ref = "feature/issue-2" | .head_repo = "evil/widget"'   # 别的仓库来的
item 15 pr loop-bot '.head_ref = "chore" | .body = "没写关联"'       # 对不上 → 不用「当成自己编号」兜底
item 16 pr frank '.head_ref = "patch-1"'                            # 人开的 PR
item 17 issue gina '.state = "closed"'                              # 已关闭
tick
chk "派工照常" "$(dispatched)" 1
chk "人开的 issue → 作者" "$(assignees 2)" bob
chk "agent 开的 PR（分支名）→ 对应 issue 的提出者" "$(assignees 3)" bob
chk "agent 开的 PR（正文 Closes）→ 对应 issue 的提出者" "$(assignees 5)" carol
chk "拆出的子 issue → 父 issue 的提出者" "$(assignees 6)" carol
chk "子项的子项 → 一直往上找到真人" "$(assignees 7)" carol
chk "子项的 PR → 同一个人" "$(assignees 8)" carol
chk "人开的 PR → 作者" "$(assignees 16)" frank
chk "已有 assignee 的不动" "$(assignees 9)" erin
chk "daemon 自己开的、没有来源 → 不指派" "$(assignees 10)" ""
chk "外部需求机器人开的 → 不指派" "$(assignees 11)" ""
chk "GitHub App 开的 → 不指派" "$(assignees 12)" ""
chk "对上的编号是 PR → 不指派" "$(assignees 13)" ""
chk "别的仓库来的 PR → 不指派" "$(assignees 14)" ""
chk "对不上关联的 PR → 不指派（不拿 PR 自己的编号兜底）" "$(assignees 15)" ""
chk "已关闭的 → 不指派" "$(assignees 17)" ""
chk "一共写了 8 次（#2 #3 #4 #5 #6 #7 #8 #16），全用写入身份" "$(writes)/$(n_calls '^WRITE .*token=write$')" "8/8"
chk "全部有结论，进度推到最后" "$(st .cursor)" 17
chk "进度之前的记录已清掉" "$(st '[.done, .pending] | map(length)')" "[0,0]"
tick
chk "下一轮：没有新条目，不再写" "$(writes)" 0

echo "── 4. 积压超过一页：逐页读完，全部指派 ──"
new_env; start
for n in $(seq 2 131); do item "$n" issue "u$n"; done
tick
chk "读了两页" "$(n_calls 'sort=created.*page=2')" 1
chk "130 条全部指派" "$(writes)" 130
chk "最早的和最新的都对" "$(assignees 2)/$(assignees 131)" "u2/u131"
chk "进度推到 131" "$(st .cursor)" 131

echo "── 5. 某条读失败：挡住进度、后面照常，恢复后补上 ──"
new_env; start
item 2 issue bob
item 3 issue carol
world '.faults = [{path: "repos/acme/widget/issues/2", times: 1}]'
tick
chk "#2 本轮没写" "$(assignees 2)" ""
chk "#3 照常指派" "$(assignees 3)" carol
chk "进度停在 #2 前面" "$(st .cursor)" 1
chk "#2 记在未决里，#3 记在已处理里" "$(st '[.pending["2"], .done["3"]]')" '[1,"assigned"]'
for n in $(seq 4 120); do item "$n" issue "u$n"; done
tick
chk "恢复后 #2 补上（新条目已把它挤出第一页也照样读到）" "$(assignees 2)" bob
chk "#3 没再写一次" "$(writes_of 3)" 0
chk "进度推过去了" "$(st .cursor)" 120

echo "── 6. 人删掉的指派不会被加回来 ──"
new_env; start
item 2 issue bob
tick
chk "先指派了" "$(assignees 2)" bob
set_item 2 '.assignees = []'
item 3 issue carol
tick; tick
chk "人删掉以后再过两轮：#2 仍然没人" "$(assignees 2)" ""
chk "这两轮只写了 #3" "$(writes_of 2)/$(assignees 3)" "0/carol"
chk "#2 的记录已随进度清掉" "$(st '.done | has("2")')" false

echo "── 7. 刚建好的子 issue 还没挂父：等，不记「没有」 ──"
new_env; start
item 2 issue bob
item 3 issue loop-bot ".created_at = \"$(iso_ago 30)\" | .body = \"$(SUBMARK 2)\""
item 4 issue loop-bot ".created_at = \"$(iso_ago 700)\" | .body = \"没挂父\""
tick
chk "刚建好、还没挂父 → 不指派，记未决" "$(assignees 3)/$(st '.pending["3"]')" "/1"
chk "建好已过 10 分钟仍找不到来源 → 记「没有」" "$(st '.done["4"]')" '"none"'
chk "刚建好的挡住进度" "$(st .cursor)" 2
set_item 3 ".parent = \"$(PARENT_URL 2)\""
tick
chk "挂上父之后 → 指派父 issue 的提出者" "$(assignees 3)" bob
chk "刚建好不满 5 分钟：进度先不越过它" "$(st .cursor)" 2
set_item 3 ".created_at = \"$OLD\""
tick
chk "满了之后进度越过去，不再写" "$(st .cursor)/$(writes)" "4/0"

echo "── 8. 写之前整条重算：依据变了就不写，下一轮按新关系指派 ──"
new_env; start
item 2 issue bob
item 3 issue carol
item 4 pr loop-bot '.head_ref = "chore" | .body = "Closes #2"'
# 第二次读 PR（写前重算）时正文改成关联 #3
world '.hooks = [{path: "repos/acme/widget/pulls/4", nth: 2, jq: ".items[\"4\"].body = \"Closes #3\""}]'
tick
chk "关联改了：本轮不写旧的人" "$(writes_of 4)" 0
chk "日志写明重算不一致" "$(log_has '#4 写之前重读')" 1
tick
chk "下一轮按新关联指派" "$(assignees 4)" carol
new_env; start
item 2 issue bob
item 3 issue carol
item 4 issue loop-bot ".parent = \"$(PARENT_URL 2)\" | .body = \"$(SUBMARK 2)\""
world ".hooks = [{path: \"repos/acme/widget/issues/4\", nth: 2, jq: \".items[\\\"4\\\"].parent = \\\"$(PARENT_URL 3)\\\" | .items[\\\"4\\\"].body = \\\"$(SUBMARK 3)\\\"\"}]"
tick
chk "子 issue 换了父：本轮不写" "$(writes_of 4)" 0
tick
chk "下一轮指派新父 issue 的提出者" "$(assignees 4)" carol
new_env; start
item 2 issue bob
item 3 pr loop-bot '.head_ref = "feature/issue-2"'
world '.hooks = [{path: "repos/acme/widget/pulls/3", nth: 2, jq: ".items[\"3\"].head_sha = \"1111111111111111111111111111111111111111\""}]'
tick
chk "PR 推了新提交：本轮不写" "$(writes_of 3)" 0
tick
chk "下一轮照常指派" "$(assignees 3)" bob
new_env; start
item 2 issue bob
item 3 issue carol
world '.hooks = [{path: "repos/acme/widget/issues/2", nth: 2, jq: ".items[\"2\"].assignees = [\"zed\"]"}, {path: "repos/acme/widget/issues/3", nth: 2, jq: ".items[\"3\"].state = \"closed\""}]'
tick
chk "判定后被人指派了别人：不写" "$(assignees 2)/$(writes_of 2)" "zed/0"
chk "判定后被关了：不写" "$(writes_of 3)" 0
tick
chk "下一轮记成「已有人」和「已关闭」，不写" "$(writes)/$(st .cursor)" "0/3"
new_env; start
item 2 issue bob
# 第二次读 #2（写前重算）之前塞一次读失败
world '.hooks = [{path: "repos/acme/widget/issues/2", nth: 2, jq: ".faults = [{path: \"repos/acme/widget/issues/2\", times: 1}]"}]'
tick
chk "写前重读失败：不写、不记完成" "$(writes_of 2)/$(st '.done | has("2")')" "0/false"
tick
chk "下一轮照常指派" "$(assignees 2)" bob

new_env; start
item 2 issue bob
item 3 pr loop-bot '.head_ref = "feature/issue-2"'
world '.hooks = [{path: "repos/acme/widget/pulls/3", nth: 2, jq: ".items[\"3\"].state = \"closed\""}]'
tick
chk "写前读 PR 详情才发现关了：不写" "$(writes_of 3)" 0
tick
chk "下一轮记成已关闭，进度越过，不写" "$(writes_of 3)/$(st .cursor)" "0/3"
new_env; start
item 2 issue bob
item 3 pr loop-bot '.head_ref = "feature/issue-2" | .merged = true'
tick
chk "PR 详情说已合并（条目接口还写着 open）：不写，记已关闭" "$(writes_of 3)/$(st .cursor)" "0/3"

echo "── 8b. 读到了但不认得 / 缺字段：判不了，恢复后补上 ──"
new_env; start
item 2 issue bob '.state = "mystery"'
item 3 issue carol '.utype = "Alien"'
item 4 issue dave
item 5 pr loop-bot '.head_ref = "chore" | .body = "Closes #4" | .drop_pull = ["body"]'
item 6 pr loop-bot '.head_ref = "feature/issue-4" | .drop_pull = ["head.repo"]'
item 7 issue loop-bot ".parent = \"$(PARENT_URL 4)\" | .body = \"$(SUBMARK 4)\" | .drop_issue = [\"body\"]"
tick
chk "不认识的开关状态、账号类型、缺正文、缺来源仓库：都不写" "$(assignees 2)$(assignees 3)$(assignees 5)$(assignees 6)$(assignees 7)" ""
chk "都记在未决里，进度停在第一个前面" "$(st '[.cursor, (.pending | keys)]')" '[1,["2","3","5","6","7"]]'
chk "同一轮里正常的 #4 照常指派" "$(assignees 4)" dave
set_item 2 '.state = "open"'; set_item 3 '.utype = "User"'
set_item 5 '.drop_pull = []'; set_item 6 '.drop_pull = []'; set_item 7 '.drop_issue = []'
tick
chk "恢复后全部补上" "$(assignees 2)/$(assignees 3)/$(assignees 5)/$(assignees 6)/$(assignees 7)" "bob/carol/dave/dave/dave"
chk "进度推到最后" "$(st .cursor)" 7
echo "── 8c. 字段表逐行：空串 / 编号对不上 = 判不了，合法的空值照常 ──"
new_env; start
item 2 issue bob
item 3 pr loop-bot '.head_ref = "" | .body = ""'                         # 来源分支名为空、正文也空
item 4 pr loop-bot '.head_ref = "feature/issue-2" | .base = ""'          # 目标分支名为空
item 5 pr loop-bot '.head_ref = "feature/issue-2" | .head_sha = ""'      # 提交为空
item 6 issue "" '.user = ""'                                             # 作者登录名为空
item 7 issue loop-bot '.parent = "" | .patch_issue = {parent_issue_url: ""}'   # 父 issue 地址是空串
item 8 issue frank '.patch_issue = {assignees: [{login: ""}]}'          # assignee 登录名为空
item 9 issue gina '.patch_issue = {number: 99}'                         # 条目接口回了别的编号
item 10 pr loop-bot '.head_ref = "feature/issue-2" | .patch_pull = {number: 99}'   # PR 详情回了别的编号
tick
chk "八种都不写" "$(assignees 3)$(assignees 4)$(assignees 5)$(assignees 7)$(assignees 9)$(assignees 10)/$(writes)" "/1"
chk "唯一的一次写是正常的 #2" "$(writes_of 2)" 1
chk "八条都记未决，进度停在 #2" "$(st '[.cursor, (.pending | keys)]')" '[2,["10","3","4","5","6","7","8","9"]]'
set_item 3 '.head_ref = "feature/issue-2"'; set_item 4 '.base = "main"'; set_item 5 '.head_sha = "abc123"'
set_item 6 '.user = "henry"'; set_item 7 ".patch_issue = {} | .parent = \"$(PARENT_URL 2)\" | .body = \"$(SUBMARK 2)\""
set_item 8 '.patch_issue = {}'; set_item 9 '.patch_issue = {}'; set_item 10 '.patch_pull = {}'
tick
chk "恢复后全部补上" "$(assignees 3)/$(assignees 4)/$(assignees 5)/$(assignees 6)/$(assignees 7)/$(assignees 8)/$(assignees 9)/$(assignees 10)" "bob/bob/bob/henry/bob/frank/gina/bob"
chk "进度推到最后" "$(st .cursor)" 10
new_env; start
item 2 issue bob '.body = null'
item 3 pr loop-bot '.head_ref = "feature/issue-2" | .body = null'
tick
chk "合法的空值：正文为 null 照常指派" "$(assignees 2)/$(assignees 3)" "bob/bob"
new_env; start
item 2 issue bob
# 写后第一次读回（第三次读 #2）回了坏形状
world '.hooks = [{path: "repos/acme/widget/issues/2", nth: 3, jq: ".items[\"2\"].patch_issue = {assignees: null}"}]'
tick
chk "写后读回形状不对：不记完成、进度不越过" "$(writes_of 2)/$(st '.done | has("2")')/$(st .cursor)" "1/false/1"
set_item 2 '.patch_issue = {}'
tick
chk "下一轮看到已有人，记完成，不再写" "$(writes_of 2)/$(st .cursor)" "0/2"
new_env; start
item 2 issue bob
jq '.done = {"5": "whatever"}' "$W/state/auto-assign.json" > "$W/s.tmp" && mv "$W/s.tmp" "$W/state/auto-assign.json"
tick
chk "状态文件里有不认识的结果：不写、不覆盖" "$(writes)/$(st '.done["5"]')" '0/"whatever"'

new_env; start
item 2 pr loop-bot '.head_ref = "feature/issue-1"'
world '.items["2"].head_repo = null' 
tick
chk "PR 的来源仓库已删（明确为空）→ 记没有，不指派" "$(assignees 2)/$(st .cursor)" "/2"

echo "── 9. 写失败、GitHub 不接受这个人、条目被删 ──"
new_env; start
item 2 issue bob
world '.faults = [{path: "repos/acme/widget/issues/2/assignees", method: "POST", times: 1}]'
tick
chk "写失败：不记完成" "$(st '.pending["2"]')" 1
tick
chk "下一轮重试成功" "$(assignees 2)" bob
new_env; start
item 2 issue outsider
world '.unassignable = ["outsider"]'
tick
chk "GitHub 不接受：记「不可指派」" "$(st '.done["2"] // "推过去了"')" '"推过去了"'
chk "日志写一次" "$(log_has '#2 的提出者 @outsider 不能被指派')" 1
tick
chk "不再重试" "$(writes_of 2)" 0
new_env; start
item 2 issue bob '.deleted = true'
item 3 issue carol
tick
chk "条目读回不存在、仓库读得到 → 记「已不在」，进度越过" "$(st .cursor)" 3
new_env; start
item 2 issue bob '.deleted = true'
world '.faults = [{path: "repos/acme/widget"}]'
tick
chk "条目 404 但仓库也读不到 → 判不了，不越过" "$(st '[.cursor, .pending["2"]]')" "[1,1]"

echo "── 10. 一直判不了：永不放弃，降频重试，恢复后补上 ──"
new_env; start
item 2 issue bob
item 3 issue carol
world '.faults = [{path: "repos/acme/widget/issues/2"}]'
jq '.pending = {"2": 29}' "$W/state/auto-assign.json" > "$W/s.tmp" && mv "$W/s.tmp" "$W/state/auto-assign.json"
tick
chk "第 30 轮：照常读一次，日志提醒一次" "$(n_calls '^GET repos/acme/widget/issues/2 ')/$(log_has '#2 已连续 30 轮判不了')" "1/1"
chk "后面的 #3 照常指派" "$(assignees 3)" carol
tick
chk "第 31 轮：降频，不读它" "$(n_calls '^GET repos/acme/widget/issues/2 ')/$(st '.pending["2"]')" "0/31"
jq '.pending["2"] = 39' "$W/state/auto-assign.json" > "$W/s.tmp" && mv "$W/s.tmp" "$W/state/auto-assign.json"
tick
chk "第 40 轮：再读一次，仍未放弃" "$(n_calls '^GET repos/acme/widget/issues/2 ')/$(st '[.cursor, .pending["2"]]')" "1/[1,40]"
chk "提醒只写过一次" "$(log_has '#2 已连续 30 轮判不了')" 1
world '.faults = []'
jq '.pending["2"] = 49' "$W/state/auto-assign.json" > "$W/s.tmp" && mv "$W/s.tmp" "$W/state/auto-assign.json"
tick
chk "恢复后补上指派" "$(assignees 2)" bob
chk "#3 没被重复写，进度推过去" "$(writes_of 3)/$(st .cursor)" "0/3"

echo "── 11. 状态文件读不懂：不覆盖、不写 ──"
new_env; start
item 2 issue bob
echo 'garbage' > "$W/state/auto-assign.json"
tick
chk "不写" "$(writes)" 0
chk "不覆盖" "$(cat "$W/state/auto-assign.json")" garbage
chk "日志说明" "$(log_has '状态文件')" 1
chk "派工照常" "$(dispatched)" 1

report_counts "$pass" "$fail"
echo
if [ "$fail" -eq 0 ]; then echo "✅ 全部通过（$pass 项）"; exit 0; fi
echo "❌ $fail 项失败（共 $((pass + fail)) 项）"; exit 1
