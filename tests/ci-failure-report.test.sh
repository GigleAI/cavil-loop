#!/usr/bin/env bash
# kind: e2e
# base 分支测试工作流失败 → 自动开 / 续报告 issue —— GitHub#345。
#
# 跑法：bash tests/ci-failure-report.test.sh
# 依赖：bash、jq、python3、git、flock、timeout。不碰网络：有状态的假 GitHub（tests/lib/fake_github.py：
# Actions 运行 / 任务 / 标注 / 日志、提交对应的 PR、时间线、限流注入）+ 假 tmux / 假 claude，HOME 指向临时目录。
# 「检查」跑的是真实入口 scripts/ci-failure-report.sh；凡是涉及派不派工的，跑的是真实的 agent-poll.sh 和
# 真实的派工脚本（真 git、真 worktree）。结论都从假 GitHub 的条目 / 标签 / 评论 / 调用记录和假 tmux 的
# 记录里读，不读源码。
#
# 这块错了的方向都不报错，只会悄悄漏报、误合并或多派工：
#   · 把「读不到」当成「没失败 / 没有报告 / 首次启用」
#   · 用单向编号游标 → 先启动后结束的运行漏掉
#   · 标注不全时仍认定同因 → 独立故障并进一条报告
#   · 交人做到一半时靠标签顺序挡派工 → greedy / 托管入口照样派
#   · 本机记录丢了去推算 → 看起来恢复了，其实漏了
# 每条「什么都没写 / 没派工」旁边都有一条「确实读了 / 正常条目确实被派工」的旁证。
set -uo pipefail
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
# shellcheck source=lib/compat.sh
source "$TEST_DIR/lib/compat.sh"

SANDBOX=$(mktemp -d)
trap '[ -n "${KEEP_SANDBOX:-}" ] && echo "SANDBOX=$SANDBOX" || rm -rf "$SANDBOX"' EXIT
mkdir -p "$SANDBOX/bin" "$SANDBOX/home"
export HOME="$SANDBOX/home"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 TZ=UTC
unset CODING_AGENT_RELEASE_ROOT LABEL_AUTOPILOT LABEL_PENDING_BLOCKED GH_TOKEN WRITE_GH_TOKEN GITHUB_TOKEN POLL_FAKE_NOW
unset DISPATCH_AUTOPILOT DISPATCH_AUTOPILOT_ISSUE DISPATCH_AUTOPILOT_PR CI_FAILURE_REPORT_WORKFLOWS
export FAKE_GH_LISTS=1 FAKE_GH_REPO="example/ci" FAKE_GH_TIMELINE=1

bash "$TEST_DIR/lib/fake_gh_client.sh" install "$SANDBOX/bin/gh" python3 "$TEST_DIR/lib/fake_github.py"
cat > "$SANDBOX/bin/tmux" <<'SH'
#!/usr/bin/env bash
log="${FAKE_TMUX_LOG:?}"
case "$1" in
    new-session)
        name=""; prev=""
        for a in "$@"; do [ "$prev" = -s ] && name="$a"; prev="$a"; done
        echo "new-session $name" >> "$log"; echo "$name" >> "$log.live"; exit 0 ;;
    has-session)
        t=""; prev=""
        for a in "$@"; do [ "$prev" = -t ] && t="${a#=}"; prev="$a"; done
        grep -qxF -- "$t" "$log.live" 2>/dev/null; exit $? ;;
    ls|list-sessions) [ -s "$log.live" ] && cat "$log.live"; exit 0 ;;
esac
exit 0
SH
printf '#!/usr/bin/env bash\nexit 0\n' > "$SANDBOX/bin/claude"
chmod +x "$SANDBOX/bin/gh" "$SANDBOX/bin/tmux" "$SANDBOX/bin/claude"

pass=0; fail=0
chk() {
    if [ "$2" = "$3" ]; then echo "  ✅ $1"; pass=$((pass+1))
    else echo "  ❌ $1 (期望 [$3]，实得 [$2])"; fail=$((fail+1)); fi
}
has() {   # <名字> <文本> <要包含的片段>
    case "$2" in *"$3"*) echo "  ✅ $1"; pass=$((pass+1)) ;;
        *) echo "  ❌ $1 (没找到 [$3])"; fail=$((fail+1)) ;; esac
}
hasnt() {
    case "$2" in *"$3"*) echo "  ❌ $1 (不该出现 [$3])"; fail=$((fail+1)) ;;
        *) echo "  ✅ $1"; pass=$((pass+1)) ;; esac
}
section() { echo "$1"; }

git init -q --bare -b main "$SANDBOX/origin.git"
git clone -q "$SANDBOX/origin.git" "$SANDBOX/seed" 2>/dev/null
(cd "$SANDBOX/seed" && git -c user.email=t@x -c user.name=t commit -q --allow-empty -m init && git push -q origin HEAD:main) >/dev/null 2>&1

NEW="$SANDBOX/new"; mkdir -p "$NEW"; cp -r "$REPO_DIR/scripts" "$REPO_DIR/prompts" "$NEW/"
W="$SANDBOX/run"; R="repos/example/ci"; WF="tests.yml"
T0=1767268800          # 2026-01-01T12:00:00Z
NOW=$T0
iso() { date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ; }

fresh() {   # [额外配置行…]
    rm -rf "$W"; mkdir -p "$W/state" "$W/wt" "$W/gh"
    git clone -q "$SANDBOX/origin.git" "$W/project" 2>/dev/null
    GD="$W/gh"; CALLS="$GD/calls.log"; CONF="$W/cavil-loop.config"; ST="$W/state/ci-failure-report.json"
    export FAKE_GH_DIR="$GD" FAKE_TMUX_LOG="$W/tmux.log"
    cat > "$CONF" <<CONF
REPO="example/ci"
PROJECT_ROOT="$W/project"
WORKTREE_BASE="$W/wt"
STATE_DIR="$W/state"
TMUX_PREFIX="citest"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
LABEL_PENDING_PR="pending/PR"
LABEL_AGENT_DOING="doing/agent"
LABEL_DONE="Done"
POST_MERGE_RETROSPECTIVE=false
PENDING_HUMAN_CONFLICT_CHECK=false
POLL_BACKOFF_LADDER=""
PRICE_AUTO_FETCH=0
MAX_CONCURRENT_WORKERS=5
AGENT_TRUST_PROMPT_WAIT_SECS=1
WORKER_SECRET_ENV=""
PATH="$SANDBOX/bin:\$PATH"
GH_TOKEN="fake-token-for-test"
CI_FAILURE_REPORT_WORKFLOWS="$WF"
CONF
    local l; for l in "$@"; do printf '%s\n' "$l" >> "$CONF"; done
    chmod 600 "$CONF"
    for f in items labels events comments perms jobs annotations joblogs commit_pulls timeline; do echo '{}' > "$GD/$f.json"; done
    echo "{\"$WF\": []}" > "$GD/runs.json"
    echo loop-bot > "$GD/me"
    echo '{"cleaned_prs":[],"cleaned_issues":[]}' > "$W/state/state.json"
    NOW=$T0
}
jset() { local f="$GD/$1" e="$2"; shift 2; jq "$@" "$e" "$f" > "$f.tmp" && mv "$f.tmp" "$f"; }
tick() {   # 真实入口跑一次检查（不经主轮询）；输出进 $W/out
    env CODING_AGENT_CONFIG="$CONF" CI_FAILURE_REPORT_NOW="$NOW" timeout 120 bash "$NEW/scripts/ci-failure-report.sh" "$@" > "$W/out" 2>&1
}
poll() {   # 真实的主轮询一轮
    env CODING_AGENT_CONFIG="$CONF" CI_FAILURE_REPORT_NOW="$NOW" timeout 180 bash "$NEW/scripts/agent-poll.sh" > "$W/pollout" 2>&1
}
later() { NOW=$((NOW + ${1:-300})); }
mkrun() {   # <id> <创建时刻 epoch> <status> <conclusion|-> [sha]
    jset runs.json '.[$wf] += [{id: ($id|tonumber), created_at: $c, status: $s,
            conclusion: (if $k == "-" then null else $k end), head_sha: $sha, head_branch: "main", event: "push",
            run_attempt: 1, html_url: ("https://github.com/example/ci/actions/runs/" + $id), display_title: "合并某个改动"}]' \
        --arg wf "$WF" --arg id "$1" --arg c "$(iso "$2")" --arg s "$3" --arg k "$4" --arg sha "${5:-sha$1}"
}
setrun() { jset runs.json "(.[\$wf][] | select(.id == (\$id|tonumber))) |= ($2)" --arg wf "$WF" --arg id "$1"; }
mkjob() {   # <run id> <job id> <名字> <conclusion> <失败步骤名|-> [标注标题…]
    local run="$1" jid="$2" name="$3" concl="$4" step="$5"; shift 5
    jset jobs.json '.[$r] += [{id: ($j|tonumber), name: $n, conclusion: $c, html_url: ("https://github.com/example/ci/job/" + $j),
            steps: (if $s == "-" then [] else [{name: "Set up", conclusion: "success"}, {name: $s, conclusion: $c}] end)}]' \
        --arg r "$run" --arg j "$jid" --arg n "$name" --arg c "$concl" --arg s "$step"
    local t
    jset annotations.json '.[$j] = [{annotation_level: "failure", title: "", message: "Process completed with exit code 1."}]' --arg j "$jid"
    for t in "$@"; do
        jset annotations.json '.[$j] += [{annotation_level: "failure", title: $t, message: ("tests/x: " + $t)}]' --arg j "$jid" --arg t "$t"
    done
    jset joblogs.json '.[$j] = "2026-01-01T12:00:00.1234567Z 第一行\n2026-01-01T12:00:01.0000000Z 失败了"' --arg j "$jid"
}
redrun() {   # <id> <创建时刻> <分片号> <失败的测试…>：一次红的运行 = 一个分片 + 汇总任务
    local id="$1" c="$2" shard="$3"; shift 3
    mkrun "$id" "$c" completed failure
    local titles=() t; for t in "$@"; do titles+=("$t fail"); done
    mkjob "$id" "${id}1" "shard $shard/4" failure "Run shard $shard/4" "${titles[@]}"
    mkjob "$id" "${id}2" "测试" failure "Every expected test passed exactly once" "shard jobs ended with failure"
}
as() {   # <账号> <账号类型> <命令…>：以另一个账号对假 GitHub 操作
    local who="$1" typ="$2"; shift 2
    echo "$who" > "$GD/me"; echo "$typ" > "$GD/me_type"
    "$@" >/dev/null 2>&1; local rc=$?
    echo loop-bot > "$GD/me"; rm -f "$GD/me_type"; return $rc
}
ghx() { env FAKE_GH_DIR="$GD" "$SANDBOX/bin/gh" "$@"; }
labels_of() { jq -r --arg n "$1" '(.[$n] // []) | sort | join(",")' "$GD/labels.json"; }
n_issues() { jq -r '[.[] | select(.kind == "issue")] | length' "$GD/items.json"; }
n_comments() { jq -r --arg n "$1" '(.[$n] // []) | length' "$GD/comments.json"; }
body_of() { jq -r --arg n "$1" '.[$n].body // ""' "$GD/items.json"; }
title_of() { jq -r --arg n "$1" '.[$n].title // ""' "$GD/items.json"; }
state_of() { jq -r --arg n "$1" '.[$n].state // ""' "$GD/items.json"; }
last_comment() { jq -r --arg n "$1" '(.[$n] // []) | last | .body // ""' "$GD/comments.json"; }
writes() { grep -cE '^gh api -X (POST|PATCH|DELETE|PUT) ' "$CALLS" 2>/dev/null || true; }
reads() { grep -c "$1" "$CALLS" 2>/dev/null || true; }
session_of() { local c; c=$(grep -c "^new-session citest-issue$1\$" "$W/tmux.log" 2>/dev/null) || true; echo "${c:-0}"; }
pending_n() { jq -r --arg wf "$WF" '.workflows[$wf].pending | length' "$ST" 2>/dev/null; }
handover() { jq -r '.handover | keys | join(",")' "$ST" 2>/dev/null; }
mkissue() {   # <n> <labels_csv> [作者] [正文]
    jset items.json '.[$n] = {kind:"issue", state:"open", state_reason:null, title:"一条普通需求", body:$b, user:{login:$u},
            updated_at:"2026-01-01T00:00:00Z"}' --arg n "$1" --arg u "${3:-maint}" --arg b "${4:-做一件事}"
    jset labels.json '.[$n] = ($l | split(",") | map(select(. != "")))' --arg n "$1" --arg l "$2"
}
mkpr() {   # <n> <合并提交 sha> <正文>：一个已合并进 main 的 PR
    jset items.json '.[$n] = {kind:"pr", state:"closed", merged:true, title:"修复", body:$b, user:{login:"loop-bot"},
            updated_at:"2026-01-01T00:00:00Z", merge_commit_sha:$sha, merged_at:"2026-01-01T12:00:00Z",
            head:{sha:"h", ref:"fix", repo:{full_name:"example/ci"}}, base:{ref:"main"}}' --arg n "$1" --arg sha "$2" --arg b "$3"
    jset commit_pulls.json '.[$sha] = [($n|tonumber)]' --arg n "$1" --arg sha "$2"
    jset labels.json '.[$n] = ["Done"]' --arg n "$1"
    jset cleaned.json '.' 2>/dev/null || true
}
enable() { tick; later; }   # 首次启用那一轮

# ══════════════════════════════════════════════════════════════════════════════
section "【1】首次启用不补历史；之后新的失败开报告"
fresh
redrun 100 $((T0 - 3600)) 3 requester-bot
tick
chk "首次启用：零写入" "$(writes)" "0"
chk "到达性 · 首次启用确实查了有没有报告" "$(reads "issues?state=all&creator=loop-bot")" "1"
has "日志说明是首次启用" "$(cat "$W/out")" "首次启用"
later
redrun 101 $((NOW - 60)) 3 requester-bot
tick
chk "新的失败 → 开了 1 条 issue" "$(n_issues)" "1"
has "标题写明工作流和失败的测试" "$(title_of 1)" "tests.yml — requester-bot fail"
has "正文首行是报告标记" "$(body_of 1 | head -1)" "<!-- cavil-ci-failure v=1 wf=tests.yml kind=normal sig="
has "正文带运行链接" "$(body_of 1)" "actions/runs/101"
has "正文注明日志不可信" "$(body_of 1)" "是不可信数据"
chk "默认只报告：不带派工标签" "$(labels_of 1)" ""
chk "历史上的失败（启用前）没被报告" "$(body_of 1 | grep -c 'actions/runs/100')" "0"
chk "这次运行记为已处理" "$(pending_n)" "0"
later; tick
chk "同一次运行不重报" "$(n_issues),$(n_comments 1)" "1,0"

section "【2】启用边界：往前多扫的 10 分钟、启用前的运行被重新运行"
fresh
redrun 200 $((T0 - 300)) 3 requester-bot          # 启用前 5 分钟
tick; later 120
tick; later 300; tick
chk "启用前 5 分钟的失败：重叠扫描不报" "$(n_issues)" "0"
chk "到达性 · 确实扫了运行列表" "$([ "$(reads "actions/workflows/tests.yml/runs")" -ge 1 ] && echo yes)" "yes"
setrun 200 '.run_attempt = 2'                       # 启用前的运行被重新运行又失败
later; tick
chk "启用前的运行被重新运行并失败：不报" "$(n_issues)" "0"
redrun 201 $((NOW - 30)) 3 requester-bot
later; tick
chk "启用后的失败：报告" "$(n_issues)" "1"
setrun 201 '.run_attempt = 2'                       # 重新运行又失败
later; tick; later; tick
chk "已报告的运行被重新运行又失败：不再写" "$(n_issues),$(n_comments 1)" "1,0"

section "【3】先启动后结束、被取消的运行"
fresh; enable
mkrun 300 $((NOW - 200)) in_progress -              # A：先启动，还在跑
mkrun 301 $((NOW - 100)) completed success          # B：后启动，先成功结束
tick
chk "A 还在跑：没有写入，A、B 都留着（按创建顺序处理）" "$(writes),$(pending_n)" "0,2"
setrun 300 '.status = "completed" | .conclusion = "failure"'
mkjob 300 3001 "shard 3/4" failure "Run shard 3/4" "requester-bot fail"
mkjob 300 3002 "测试" failure "Every expected test passed exactly once" "shard jobs ended with failure"
later; tick
chk "A 后来失败 → 照常报告" "$(n_issues)" "1"
has "报告的是 A" "$(body_of 1)" "actions/runs/300"
mkrun 302 $((NOW - 50)) completed cancelled
later; tick
has "B 比 A 晚创建且是绿的 → 报告上留一句已转绿" "$(last_comment 1)" "已转绿"
chk "被取消的运行不写任何东西" "$(n_issues),$(n_comments 1),$(pending_n)" "1,1,0"

section "【4】离线很久、超过接口上限、某一页读失败"
fresh; enable
redrun 400 $((NOW + 3600)) 3 requester-bot          # 离线第一天的失败
later $((5 * 86400))                                 # 五天后才回来
tick
chk "离线超过 3 天、之前没有待办 → 恢复后照常报告" "$(n_issues)" "1"
has "报告的是离线第一天那次" "$(body_of 1)" "actions/runs/400"

fresh; enable
i=0; while [ $i -lt 250 ]; do mkrun $((5000 + i)) $((NOW + i)) completed success; i=$((i + 1)); done
redrun 4999 $((NOW + 5)) 3 requester-bot
later 600
export FAKE_GH_RUNS_CAP=100                          # 假接口一次筛选最多给 100 条
( sed -i 's/^LIST_CAP = 1000/LIST_CAP = 100/' "$NEW/scripts/ci_failure_report.py" )
tick
chk "超过单次筛选上限 → 对半切开读完，失败被报告" "$(n_issues)" "1"
chk "到达性 · 确实分了多段去读" "$([ "$(reads "actions/workflows/tests.yml/runs")" -ge 4 ] && echo yes)" "yes"
unset FAKE_GH_RUNS_CAP
cp "$REPO_DIR/scripts/ci_failure_report.py" "$NEW/scripts/ci_failure_report.py"

fresh; enable
i=0; while [ $i -lt 230 ]; do mkrun $((6000 + i)) $((NOW + 200 + i)) completed cancelled; i=$((i + 1)); done
redrun 5999 $((NOW + 5)) 3 requester-bot             # 创建得最早 → 在最后一页
later 900
F0=$(jq -r --arg wf "$WF" '.workflows[$wf].frontier' "$ST")
touch "$GD/Fpage_actions_workflows_tests.yml_runs_2"
tick
chk "第 2 页读失败 → 零写入" "$(writes)" "0"
chk "第 2 页读失败 → 核对边界不动、没有运行被记为待办或已处理" \
    "$(jq -r --arg wf "$WF" '.workflows[$wf] | "\(.frontier) \(.pending|length) \(.done|length)"' "$ST")" "$F0 0 0"
has "日志说明没读完整" "$(cat "$W/out")" "没读完整"
rm -f "$GD/Fpage_actions_workflows_tests.yml_runs_2"
later 1800; tick
chk "恢复后：第 3 页上的失败被报告" "$(n_issues)" "1"

section "【5】主轮询退避时，检查照样按自己的间隔跑"
fresh 'POLL_BACKOFF_LADDER="86400:300"' 'POLL_IDLE_PROBE=false'
enable
redrun 500 $((NOW - 60)) 3 requester-bot
export POLL_FAKE_NOW=$NOW
# 主轮询的节奏状态：刚轮询过、已安静一天多、下一次还差 250 秒 → 这一轮该被跳过
jq -n --argjson n "$NOW" '{next_due: ($n + 250), last_poll: $n, last_active: ($n - 90000), fail_streak: 0, fingerprint: "x"}' \
    > "$W/state/poll-pace.json"
mkissue 55 "pending/agent"
poll
has "这一轮主轮询因退避被跳过" "$(cat "$W/state/poll.log" 2>/dev/null)" "本轮跳过"
chk "主轮询确实没干活：普通条目没被派工" "$(labels_of 55)" "pending/agent"
chk "但检查照常运行，失败被报告" "$(jq -r '[.[] | select(.kind == "issue" and (.body | startswith("<!-- cavil-ci-failure")))] | length' "$GD/items.json")" "1"
unset POLL_FAKE_NOW

section "【5b】没有 timeout 命令的机器（macOS 的安装条件）：检查照常启动；时限靠自己"
# 一套不含 timeout 的命令目录：系统目录里的命令逐个链接过来，唯独不要 timeout
FARM="$SANDBOX/farm"; mkdir -p "$FARM"
for d in /bin /usr/bin /usr/local/bin; do
    [ -d "$d" ] || continue
    for f in "$d"/*; do
        b=${f##*/}
        [ "$b" = timeout ] || [ "$b" = gtimeout ] || [ -e "$FARM/$b" ] || ln -s "$f" "$FARM/$b" 2>/dev/null
    done
done
for b in python3 jq git flock; do [ -e "$FARM/$b" ] || ln -s "$(command -v "$b")" "$FARM/$b"; done
fresh "PATH=\"$SANDBOX/bin:$FARM\""
chk "搭好：这台「机器」上确实没有 timeout" "$(env PATH="$SANDBOX/bin:$FARM" bash -c 'command -v timeout >/dev/null 2>&1 && echo has || echo missing')" "missing"
poll
chk "没有 timeout：检查照常启动，建了本机记录" "$([ -f "$ST" ] && echo yes || echo no)" "yes"
hasnt "没有 timeout：日志里没有异常退出" "$(cat "$W/state/poll.log")" "异常退出"
later
redrun 550 $((NOW - 60)) 3 requester-bot
poll
chk "没有 timeout：新的失败照常被报告" "$(n_issues)" "1"
tick --list
has "没有 timeout：人工查看的入口也能用" "$(cat "$W/out")" "状态：正常"
# 一次 gh 调用卡住：检查程序自己到时限就结束这次调用、收尾退出，不靠外部命令
fresh "PATH=\"$SANDBOX/bin:$FARM\""; enable
redrun 551 $((NOW - 60)) 3 requester-bot
printf 'sleep 25\n' > "$GD/hook_actions_workflows_tests.yml_runs_1"
T1=$(date +%s)
env CODING_AGENT_CONFIG="$CONF" CI_FAILURE_REPORT_NOW="$NOW" CI_FAILURE_REPORT_CALL_TIMEOUT=2 bash "$NEW/scripts/agent-poll.sh" > "$W/pollout" 2>&1
T2=$(date +%s)
chk "gh 调用卡住：几秒内就结束这一轮（实测 $((T2 - T1)) 秒），没等它 25 秒" "$([ $((T2 - T1)) -le 15 ] && echo yes || echo no)" "yes"
has "日志写明是调用超时" "$(cat "$W/state/poll.log")" "没有返回，已结束这次调用"
chk "这一轮什么都没写，运行留着下一轮再看" "$(n_issues)" "0"
rm -f "$GD/hook_actions_workflows_tests.yml_runs_1"; later
poll
chk "下一轮恢复：失败被报告" "$(n_issues)" "1"
# 兜底：检查程序整个不退出 → 主轮询用 bash 内建等到上限后把它停掉，这一轮照常往下走
fresh "PATH=\"$SANDBOX/bin:$FARM\""; enable
mkissue 55 "pending/agent"
redrun 552 $((NOW - 60)) 3 requester-bot
printf 'sleep 25\n' > "$GD/hook_actions_workflows_tests.yml_runs_1"
T1=$(date +%s)
env CODING_AGENT_CONFIG="$CONF" CI_FAILURE_REPORT_NOW="$NOW" CI_FAILURE_REPORT_CALL_TIMEOUT=100 CI_FAILURE_REPORT_HARD_LIMIT=3 \
    bash "$NEW/scripts/agent-poll.sh" > "$W/pollout" 2>&1
T2=$(date +%s)
has "检查不退出：到上限被强制停掉" "$(cat "$W/state/poll.log")" "强制停掉"
chk "强制停掉后这一轮照常派工，没被拖住（实测 $((T2 - T1)) 秒）" "$(session_of 55),$([ $((T2 - T1)) -le 20 ] && echo yes || echo no)" "1,yes"
sleep 1
chk "检查程序没有留下孤儿进程" "$(pgrep -f -- "$NEW/scripts/ci_failure_report.py tick" | wc -l | tr -d ' ')" "0"
rm -f /tmp/cavil-loop-issue-55-* 2>/dev/null

section "【6】同因看失败的测试；证据不完整进「原因未确认」"
fresh; enable
redrun 600 $((NOW - 60)) 3 requester-bot; tick; later
redrun 601 $((NOW - 60)) 3 requester-bot; tick; later
chk "同一个测试再次失败 → 只追加评论" "$(n_issues),$(n_comments 1)" "1,1"
has "评论写明和这条报告相同" "$(last_comment 1)" "失败的测试和这条报告相同"
redrun 602 $((NOW - 60)) 3 autopilot:2/3; tick; later
chk "同分片、不同测试 → 另开" "$(n_issues),$(n_comments 1)" "2,1"
redrun 603 $((NOW - 60)) 1 requester-bot; tick; later
chk "不同分片 → 另开" "$(n_issues)" "3"
# 正好 10 条标注：可能被截断，不认定同因
mkrun 604 $((NOW - 60)) completed failure
mkjob 604 6041 "shard 3/4" failure "Run shard 3/4" a1 a2 a3 a4 a5 a6 a7 a8 a9 a10
mkjob 604 6042 "测试" failure "Every expected test passed exactly once" "shard jobs ended with failure"
tick; later
chk "步骤正好 10 条标注 → 另开一条「原因未确认」" "$(n_issues)" "4"
has "标题写明原因未确认" "$(title_of 4)" "原因未确认"
has "正文写明不代表同因" "$(body_of 4)" "不代表是同一个原因"
has "正文首行标记是 unconfirmed" "$(body_of 4 | head -1)" "kind=unconfirmed"
# 一个失败任务有标注、另一个没有
mkrun 605 $((NOW - 60)) completed failure
mkjob 605 6051 "shard 3/4" failure "Run shard 3/4" "requester-bot fail"
mkjob 605 6052 "测试" failure "Every expected test passed exactly once"
tick; later
chk "部分任务没有标注 → 追加在同一条「原因未确认」，不新开" "$(n_issues),$(n_comments 4)" "4,1"
has "评论写明不代表同因" "$(last_comment 4)" "不代表和本 issue 里其它失败是同一个原因"
redrun 606 $((NOW - 60)) 3 requester-bot; tick; later
chk "之后证据完整的失败 → 落到普通报告 #1，不并进「原因未确认」" "$(n_comments 1),$(n_comments 4)" "2,1"
# 标注读不到
redrun 607 $((NOW - 60)) 2 blocked-label
touch "$GD/F_check-runs_6071_annotations"; W0=$(writes); tick
chk "标注读不到 → 零写入，运行留在待办" "$(( $(writes) - W0 )),$(pending_n)" "0,1"
chk "到达性 · 确实去读了任务列表" "$([ "$(reads "actions/runs/607/attempts/1/jobs")" -ge 1 ] && echo yes)" "yes"
rm -f "$GD/F_check-runs_6071_annotations"; later; tick
chk "恢复后按证据正确判断（新原因 → 另开）" "$(n_issues),$(pending_n)" "5,0"

section "【7】修复合并后仍失败：记回原报告、按修复 PR 计次、达到上限交人"
fresh 'CI_FAILURE_REPORT_DISPATCH=true'; enable
redrun 700 $((NOW - 60)) 3 requester-bot; tick; later
chk "派工打开：新报告带派工标签" "$(labels_of 1)" "pending/agent"
mkissue 50 ""                                         # 一条普通 issue，PR 正文先引用它
mkpr 60 shaF1 $'先处理 Refs #50\n\nCloses #1'
ghx api -X PATCH "$R/issues/1" -f state=closed -f state_reason=completed >/dev/null   # 合并时被带关
mkrun 701 $((NOW - 60)) completed failure shaF1
mkjob 701 7011 "shard 1/4" failure "Run shard 1/4" "blocked-label fail"               # 失败位置变了
mkjob 701 7012 "测试" failure "Every expected test passed exactly once" "shard jobs ended with failure"
tick; later
chk "修复改变了失败位置 → 仍记在原报告，不新开" "$(n_issues | tr -d ' ')" "2"
has "评论写明是第 1 次修复失败" "$(last_comment 1)" "修复 #60 合并后仍然失败（第 1 次）"
has "评论写明失败位置不同" "$(last_comment 1)" "失败的位置和这条报告开出时不同"
chk "被带关的报告重新打开，并重新打上派工标签" "$(state_of 1),$(labels_of 1)" "open,pending/agent"
chk "还没到上限：不在不派工名单里" "$(handover)" ""
# 评论发失败后重试：次数不变
mkpr 61 shaF2 'Fixes #1'
redrun 702 $((NOW - 60)) 3 requester-bot; setrun 702 '.head_sha = "shaF2"'
touch "$GD/F_POST_issues_1_comments"; C0=$(n_comments 1); tick
chk "达到上限、评论发送失败 → 已先进不派工名单" "$(handover),$(( $(n_comments 1) - C0 ))" "1,0"
chk "评论还没发出：名单里记着没公布" "$(jq -r '.handover["1"].announced' "$ST")" "false"
rm -f "$GD/F_POST_issues_1_comments"; later; tick
has "重试后评论发出，仍是第 2 次（不因重试多算）" "$(jq -r '.["1"][] | .body' "$GD/comments.json" | grep -c '第 2 次')" "1"
has "评论带交人说明" "$(jq -r '.["1"][] | .body' "$GD/comments.json")" "达到上限（2），daemon 不再派工"
later; tick
chk "交人完成：摘掉派工标签、挂上 pending/human、出名单" "$(labels_of 1),$(handover)" "pending/human,"
has "留了已交人评论" "$(last_comment 1)" "已交给人处理"
# 之后的失败只评论、不动标签
mkpr 62 shaF3 'Refs #1'
redrun 703 $((NOW - 60)) 3 requester-bot; setrun 703 '.head_sha = "shaF3"'
tick; later; tick; later
has "再一次修复失败：照常评论" "$(jq -r '.["1"][] | .body' "$GD/comments.json")" "修复 #62 合并后仍然失败（第 3 次）"
# 一个 PR 引用两条报告；跨行不算
fresh; enable
redrun 710 $((NOW - 60)) 3 requester-bot; tick; later
redrun 711 $((NOW - 60)) 1 blocked-label; tick; later
mkpr 70 shaG1 'Fixes #1, #2'
redrun 712 $((NOW - 60)) 2 smoke; setrun 712 '.head_sha = "shaG1"'
tick; later
chk "一个 PR 引用两条报告 → 两条各记一次，不新开" "$(n_comments 1),$(n_comments 2),$(n_issues)" "1,1,2"
mkpr 71 shaG2 $'Refs\n#1'
redrun 713 $((NOW - 60)) 4 footer; setrun 713 '.head_sha = "shaG2"'
tick; later
chk "关键词和编号跨行 → 不算修复，按新原因另开" "$(n_comments 1),$(n_issues)" "1,3"
# 归属读不到
mkpr 72 shaG3 'Fixes #2'
redrun 714 $((NOW - 60)) 1 blocked-label; setrun 714 '.head_sha = "shaG3"'
touch "$GD/F_commits_shaG3_pulls"; W0=$(writes); tick
chk "归属读不到 → 零写入、留在待办" "$(( $(writes) - W0 )),$(pending_n)" "0,1"
rm -f "$GD/F_commits_shaG3_pulls"; later; tick; later
has "恢复后正确归属到 #2" "$(last_comment 2)" "修复 #72 合并后仍然失败"
# 已转绿只留一次
mkrun 715 $((NOW - 60)) completed success; tick; later
mkrun 716 $((NOW - 60)) completed success; tick; later
chk "已转绿：每条开着的报告只留一次" "$(jq -r '.["2"][] | .body' "$GD/comments.json" | grep -c 已转绿)" "1"

section "【7b】正文引用的解析：自己的规则 + 和现有「取第一处」的函数对拍"
refs() { printf '%s' "$1" | python3 "$NEW/scripts/ci_failure_report.py" refs; }
old_first() { ( source "$NEW/scripts/_lib.sh" >/dev/null 2>&1; printf '%s' "$1" | pr_body_linked_issue ); }
chk "先普通引用、后报告引用 → 两个都取到" "$(refs $'Refs #50\n\nCloses #7')" "50 7"
chk "同一行逗号列表都算" "$(refs 'Closes #1, #2,#3')" "1 2 3"
chk "关键词和编号跨行不算" "$(refs $'Refs\n#12')" ""
chk "不分大小写、各种变体" "$(refs $'FIXED #4\nresolves #5\nref #6')" "4 5 6"
chk "没有关键词的 #N 不算" "$(refs '见 #9 和 #10')" ""
for b in $'Refs #50\n\nCloses #7' 'Closes #1, #2' $'Refs\n#12' 'fix #3 then closes #4' '没有引用' $'x\nResolved #8'; do
    chk "对拍第一个编号：$(printf '%s' "$b" | tr '\n' '|')" "$(refs "$b" | cut -d' ' -f1)" \
        "$(env CODING_AGENT_CONFIG="$CONF" bash -c 'source "$0/scripts/_lib.sh" >/dev/null 2>&1; printf "%s" "$1" | pr_body_linked_issue' "$NEW" "$b")"
done

section "【8】写入保护：写前重读、部分成功后只补没做的、关闭原因、限流"
# 读取之后、写入之前人挂上了等待标签（改过名字的）→ 不打派工标签，评论照发
fresh 'CI_FAILURE_REPORT_DISPATCH=true' 'LABEL_PENDING_BLOCKED="wait/dep"'; enable
redrun 800 $((NOW - 60)) 3 requester-bot; tick; later
ghx api -X DELETE "$R/issues/1/labels/pending%2Fagent" >/dev/null
mkpr 60 shaH1 'Refs #1'
redrun 801 $((NOW - 60)) 3 requester-bot; setrun 801 '.head_sha = "shaH1"'
cat > "$GD/hook_issues_1_comments_1" <<SH
echo maint > "$GD/me"; FAKE_GH_DIR="$GD" "$SANDBOX/bin/gh" api -X POST "$R/issues/1/labels" -f "labels[]=wait/dep" >/dev/null; echo loop-bot > "$GD/me"
SH
tick; later
has "评论照发" "$(last_comment 1)" "修复 #60 合并后仍然失败（第 1 次）"
chk "写前重读看到人挂的等待标签 → 不打派工标签" "$(labels_of 1)" "wait/dep"
chk "到达性 · 这一步之前确实重读了 issue" "$([ "$(reads "api $R/issues/1\$")" -ge 2 ] && echo yes)" "yes"

# 评论成功、打标签时被限流 → 下一轮只补标签
fresh 'CI_FAILURE_REPORT_DISPATCH=true'; enable
redrun 810 $((NOW - 60)) 3 requester-bot; tick; later
ghx api -X DELETE "$R/issues/1/labels/pending%2Fagent" >/dev/null
mkpr 60 shaI1 'Refs #1'
redrun 811 $((NOW - 60)) 3 requester-bot; setrun 811 '.head_sha = "shaI1"'
touch "$GD/F403rl_POST_issues_1_labels"; tick
chk "评论已发、标签被限流：运行留在待办" "$(n_comments 1),$(labels_of 1),$(pending_n)" "1,,1"
has "日志说是限流" "$(cat "$W/out")" "GitHub 限流，稍后再看"
hasnt "日志里没有「权限」字样" "$(cat "$W/out")" "权限"
rm -f "$GD/F403rl_POST_issues_1_labels"; later 1000; tick
chk "恢复后：不重复评论，只补上标签" "$(n_comments 1),$(labels_of 1),$(pending_n)" "1,pending/agent,0"

# 开报告成功、但没来得及记下 → 不开第二条
fresh; enable
redrun 820 $((NOW - 60)) 3 requester-bot; tick; later
jq --arg wf "$WF" '.workflows[$wf].pending["820"] = {created: .workflows[$wf].done["820"]} | del(.workflows[$wf].done["820"])' "$ST" > "$ST.t" && mv "$ST.t" "$ST"
tick
chk "同一次运行重新判断 → 认出已经开过：不开第二条，也不追加「又一次失败」" "$(n_issues),$(n_comments 1),$(pending_n)" "1,0,0"
chk "到达性 · 重新判断时确实读了任务和报告列表" "$([ "$(reads "actions/runs/820/attempts/1/jobs")" -ge 2 ] && echo yes)" "yes"
# 同样的重试，落点是「原因未确认」报告
fresh; enable
mkrun 821 $((NOW - 60)) completed failure
mkjob 821 8211 "shard 3/4" failure "Run shard 3/4"
tick; later
has "搭好：开的是原因未确认报告" "$(title_of 1)" "原因未确认"
jq --arg wf "$WF" '.workflows[$wf].pending["821"] = {created: .workflows[$wf].done["821"]} | del(.workflows[$wf].done["821"])' "$ST" > "$ST.t" && mv "$ST.t" "$ST"
tick
chk "原因未确认报告同样：不开第二条、不追加评论" "$(n_issues),$(n_comments 1),$(pending_n)" "1,0,0"

# 去重要读的评论列表读完之后、写之前，维护者把报告关成「不做」→ 不写、不记已处理
fresh; enable
redrun 825 $((NOW - 60)) 3 requester-bot; tick; later
redrun 826 $((NOW - 60)) 3 requester-bot
cat > "$GD/hook_issues_1_comments_1" <<SH
echo maint > "$GD/me"; FAKE_GH_DIR="$GD" FAKE_GH_TIMELINE=1 "$SANDBOX/bin/gh" api -X PATCH "$R/issues/1" -f state=closed -f state_reason=not_planned >/dev/null; echo loop-bot > "$GD/me"
SH
R0=$(reads "api $R/issues/1\$"); tick
chk "读评论期间报告被关成不做 → 没有追加评论，运行没被记为已处理" "$(state_of 1),$(n_comments 1),$(pending_n)" "closed,0,1"
chk "到达性 · 评论列表读完之后确实又重读了一次 issue" "$([ "$(( $(reads "api $R/issues/1\$") - R0 ))" -ge 1 ] && [ "$(reads "issues/1/comments")" -ge 1 ] && echo yes)" "yes"
later; tick
chk "下一轮按当时的状态重新判断：原报告已关 → 另开一条，不写进已关的那条" "$(n_issues),$(n_comments 1),$(pending_n)" "2,0,0"
# 同样的时点，报告正文的标记被改掉（不再是本功能的报告）
fresh; enable
redrun 827 $((NOW - 60)) 3 requester-bot; tick; later
redrun 828 $((NOW - 60)) 3 requester-bot
cat > "$GD/hook_issues_1_comments_1" <<SH
jq '.["1"].body = "被人整段改写了"' "$GD/items.json" > "$GD/items.json.t" && mv "$GD/items.json.t" "$GD/items.json"
SH
tick
chk "读评论期间正文标记被改掉 → 不往这条 issue 写评论" "$(n_comments 1)" "0"

# 关闭原因三种
fresh; enable
redrun 830 $((NOW - 60)) 3 requester-bot; tick; later
ghx api -X PATCH "$R/issues/1" -f state=closed -f state_reason=not_planned >/dev/null
mkpr 60 shaJ1 'Fixes #1'
redrun 831 $((NOW - 60)) 3 requester-bot; setrun 831 '.head_sha = "shaJ1"'
W0=$(writes); tick; later
chk "报告被关成「不做」→ 什么都不写，运行记为已处理" "$(( $(writes) - W0 )),$(state_of 1),$(pending_n)" "0,closed,0"
jset items.json '.["1"].state_reason = null'
mkpr 61 shaJ2 'Fixes #1'
redrun 832 $((NOW - 60)) 3 requester-bot; setrun 832 '.head_sha = "shaJ2"'
W0=$(writes); tick; later; tick; later
chk "关闭原因缺失 → 不重开、不写，一直留在待办" "$(( $(writes) - W0 )),$(state_of 1),$(pending_n)" "0,closed,1"
jset items.json '.["1"].state_reason = "completed"'
tick; later
chk "之后读到「已完成」→ 重开并评论" "$(state_of 1),$(n_comments 1),$(pending_n)" "open,1,0"

# 限流与权限
fresh; enable
redrun 840 $((NOW - 60)) 3 requester-bot
touch "$GD/F429_actions_workflows_tests.yml_runs"; tick
chk "运行列表 429 → 零写入" "$(writes)" "0"
has "按限流处理" "$(cat "$W/out")" "GitHub 限流，稍后再看"
hasnt "不说成权限问题" "$(cat "$W/out")" "权限"
rm -f "$GD/F429_actions_workflows_tests.yml_runs"; later 1000; tick
chk "限流过后照常报告" "$(n_issues)" "1"
touch "$GD/F403_actions_workflows_tests.yml_runs"; later; tick
has "普通 403 才报权限" "$(cat "$W/out")" "没有读 Actions / 检查结果的权限"
rm -f "$GD/F403_actions_workflows_tests.yml_runs"

section "【9】交人没做完的报告：三个派工入口和启动前都不派"
# 搭到「第 2 次修复失败的那次运行已出现、还没处理」；$1 = 入口：label | greedy | autopilot，其余是额外配置
build() {
    local mode="$1"; shift
    local extra=('CI_FAILURE_REPORT_DISPATCH=true' 'LABEL_PENDING_AGENT_EXTRA="pending/agent/05"')
    case "$mode" in
        greedy) extra+=('DISPATCH_MODE="greedy"') ;;
        autopilot) extra+=('LABEL_AUTOPILOT="autopilot"' 'LABEL_PENDING_REVIEW="pending/review"') ;;
    esac
    fresh "${extra[@]}" "$@"; enable
    echo '{"maint":"admin"}' > "$GD/perms.json"
    redrun 900 $((NOW - 60)) 3 requester-bot; tick; later
    [ "$mode" != autopilot ] || as maint User ghx api -X POST "$R/issues/1/labels" -f "labels[]=autopilot"
    mkpr 60 shaK1 'Refs #1'
    redrun 901 $((NOW - 60)) 3 requester-bot; setrun 901 '.head_sha = "shaK1"'; tick; later
    mkpr 61 shaK2 'Refs #1'
    redrun 902 $((NOW - 60)) 3 requester-bot; setrun 902 '.head_sha = "shaK2"'
}
strip() { printf '%s' "$1" | tr ',' '\n' | grep -vx autopilot | paste -sd, -; }
scenario() {   # <入口> <状态 1-4>
    local mode="$1" stn="$2" want
    build "$mode"
    case "$stn" in
        1) touch "$GD/F_POST_issues_1_comments"; want="pending/agent" ;;
        2) touch "$GD/F_DELETE_issues_1_labels"; want="pending/agent" ;;
        3) ghx api -X POST "$R/issues/1/labels" -f "labels[]=pending/agent/05" >/dev/null
           printf 'touch "%s/F_DELETE_issues_1_labels"\n' "$GD" > "$GD/hook_DELETE_issues_1_labels_1"   # 第一个摘成功之后，后面的摘都失败
           want="pending/agent/05" ;;
        4) touch "$GD/F403rl_POST_issues_1_labels"; want="" ;;
    esac
    tick; later 60
    [ "$stn" = 1 ] || { tick; later 60; }           # 评论发出后的下一轮才开始改标签
    chk "[$mode·状态$stn] 搭好：在不派工名单里，标签停在半路" "$(handover),$(strip "$(labels_of 1)")" "1,$want"
    # 正常条目：这个入口本来会派的那一种
    case "$mode" in
        label) mkissue 55 "pending/agent" ;;
        greedy) mkissue 55 "" ;;
        autopilot) mkissue 55 ""; as maint User ghx api -X POST "$R/issues/55/labels" -f "labels[]=autopilot" ;;
    esac
    poll; later 60
    chk "[$mode·状态$stn] 这条报告没被派工（没起会话、没翻 doing/agent）" \
        "$(session_of 1),$(strip "$(labels_of 1)")" "0,$want"
    chk "[$mode·状态$stn] 旁证：正常条目确实被派工" "$(session_of 55),$(strip "$(labels_of 55)")" "1,doing/agent"
    rm -f "$GD"/F_* "$GD"/F403rl_* "$GD"/hook_DELETE_*
    later 1000; poll; later 60; poll; later 60; poll
    chk "[$mode·状态$stn] 故障消失后交人完成：pending/human、出名单、始终没派" \
        "$(strip "$(labels_of 1)"),$(handover),$(session_of 1)" "pending/human,,0"
    chk "[$mode·状态$stn] 交人评论只有 1 条带上限说明、已交人评论 1 条" \
        "$(jq -r '.["1"][] | .body' "$GD/comments.json" | grep -c '达到上限'),$(jq -r '.["1"][] | .body' "$GD/comments.json" | grep -c '已交给人处理')" "1,1"
    rm -f /tmp/cavil-loop-issue-55-* /tmp/cavil-loop-issue-1-* 2>/dev/null
}
for m in label greedy autopilot; do for s in 1 2 3 4; do scenario "$m" "$s"; done; done

# 启动前复核：候选收集之后才进名单
build label
mkissue 55 "pending/agent"
jq '.next_check = 99999999999' "$ST" > "$ST.t" && mv "$ST.t" "$ST"      # 这一轮检查不处理运行，名单由下面的钩子写入
# 候选都收集完之后：先派 #55（更新时间更早，排在前面），在它翻标签的那一刻把 #1 写进名单
cat > "$GD/hook_POST_issues_55_labels_1" <<SH
jq '.handover["1"] = {announced: false, run: 902, pr: 61, wf: "tests.yml"}' "$ST" > "$ST.t" && mv "$ST.t" "$ST"
SH
poll
chk "收集之后才进名单 → 启动前拦下" "$(session_of 1),$(labels_of 1)" "0,pending/agent"
has "日志写明不派工的原因" "$(cat "$W/state/poll.log")" "issue #1 不派工"
chk "旁证：同一轮正常条目被派工" "$(session_of 55)" "1"
rm -f /tmp/cavil-loop-issue-55-* 2>/dev/null

# 「待交人」之前就挂着等前置；之后被翻回派工标签
build label 'LABEL_PENDING_BLOCKED="wait/dep"'
ghx api -X DELETE "$R/issues/1/labels/pending%2Fagent" >/dev/null
as maint User ghx api -X POST "$R/issues/1/labels" -f "labels[]=wait/dep"
tick; later 60; tick; later 60; tick; later 60
chk "交人前就挂着等待标签 → 不加 pending/human，一直在名单里" "$(labels_of 1),$(handover)" "wait/dep,1"
ghx api -X DELETE "$R/issues/1/labels/wait%2Fdep" >/dev/null             # daemon（写账号）把它翻回派工标签
ghx api -X POST "$R/issues/1/labels" -f "labels[]=pending/agent" >/dev/null
poll; later 60; poll
chk "被翻回派工标签 → 先摘掉、不派，再完成交人" "$(session_of 1),$(labels_of 1),$(handover)" "0,pending/human,"

# 挂着 doing/agent 很久；机器人账号改标签不算人
build label
ghx api -X DELETE "$R/issues/1/labels/pending%2Fagent" >/dev/null
ghx api -X POST "$R/issues/1/labels" -f "labels[]=doing/agent" >/dev/null
tick; later 60; tick; later $((30 * 3600)); tick
chk "worker 在跑超过 24 小时 → 仍在名单里、标签不动" "$(labels_of 1),$(handover)" "doing/agent,1"
as dependabot Bot ghx api -X POST "$R/issues/1/labels" -f "labels[]=pending/PR"
as dependabot Bot ghx api -X DELETE "$R/issues/1/labels/pending%2FPR"
later 60; tick
chk "机器人类型的账号改了流程标签 → 不算人工处置，仍在名单里" "$(handover)" "1"
ghx api -X DELETE "$R/issues/1/labels/doing%2Fagent" >/dev/null
later 60; tick
chk "worker 结束后完成交人" "$(labels_of 1),$(handover)" "pending/human,"

# 真人在「待交人」之后打了派工标签 → 出名单、不摘人的标签、正常派工
build label
ghx api -X DELETE "$R/issues/1/labels/pending%2Fagent" >/dev/null
touch "$GD/F_POST_issues_1_labels"                     # 让交人停在「还没加 pending/human」
tick; later 60; tick; later 60
chk "搭好：评论已发、在名单里" "$(handover)" "1"
rm -f "$GD/F_POST_issues_1_labels"
as maint User ghx api -X POST "$R/issues/1/labels" -f "labels[]=pending/agent"
poll
chk "人接手 → 出名单、人打的标签不被摘、当轮正常派工" "$(handover),$(session_of 1),$(labels_of 1)" ",1,doing/agent"
rm -f /tmp/cavil-loop-issue-1-* 2>/dev/null

# 交人完成后维护者重新打派工标签 → 正常派工
build label
tick; later 60; tick; later 60; tick; later 60
chk "搭好：交人已完成" "$(labels_of 1),$(handover)" "pending/human,"
as maint User ghx api -X DELETE "$R/issues/1/labels/pending%2Fhuman"
as maint User ghx api -X POST "$R/issues/1/labels" -f "labels[]=pending/agent"
poll
chk "交人完成后人重新打派工标签 → 正常派工" "$(session_of 1),$(labels_of 1)" "1,doing/agent"
rm -f /tmp/cavil-loop-issue-1-* 2>/dev/null

section "【10】本机记录丢失：不推算，暂停、不派工、开提示，等人重新开始"
build label
touch "$GD/F_POST_issues_1_comments"; tick; later 60
chk "搭好：交人意图已记、评论没发出、报告还带派工标签" "$(handover),$(labels_of 1)" "1,pending/agent"
rm -f "$GD/F_POST_issues_1_comments" "$ST"            # 记录丢失
mkissue 55 "pending/agent"
C0=$(n_comments 1); poll; later 60; poll; later 60
chk "暂停：这条报告几轮都不被派工，评论、标签都没动" "$(session_of 1),$(labels_of 1),$(( $(n_comments 1) - C0 ))" "0,pending/agent,0"
chk "旁证：正常条目确实被派工" "$(session_of 55)" "1"
NOTICE=$(jq -r 'to_entries[] | select(.value.kind == "issue" and (.value.body | contains("cavil-ci-failure-paused"))) | .key' "$GD/items.json")
chk "提示 issue 只开 1 条" "$(printf '%s\n' "$NOTICE" | grep -c .)" "1"
chk "提示 issue 带 pending/human" "$(labels_of "$NOTICE")" "pending/human"
has "提示写明这段时间的失败不会被报告" "$(body_of "$NOTICE")" "失败不会被报告"
has "提示列出受影响的报告和它的标签" "$(body_of "$NOTICE")" '| #1 | `pending/agent` |'
has "提示给出重新开始的命令" "$(body_of "$NOTICE")" "ci-failure-report.sh --restart"
chk "暂停期间没有重建本机记录" "$([ -f "$ST" ] && echo yes || echo no)" "no"
redrun 990 $((NOW - 30)) 2 smoke; I0=$(n_issues); later; tick
chk "暂停期间的新失败不报告" "$(( $(n_issues) - I0 ))" "0"
tick --list
has "查看状态：显示暂停中" "$(cat "$W/out")" "暂停中"
# 重新开始写入失败 → 暂停保持
chmod 555 "$W/state"; tick --restart; rc=$?; chmod 755 "$W/state"
chk "重新开始时新记录写不进去 → 命令报错，暂停保持原样" "$rc,$([ -f "$ST" ] && echo yes || echo no),$([ -f "$W/state/ci-failure-report.hold" ] && echo yes || echo no)" "1,no,yes"
tick --restart; rc=$?
chk "修好后重新开始成功" "$rc" "0"
has "输出写明已重新开始" "$(cat "$W/out")" "已从当前时刻重新开始"
later 60; tick
chk "之后提示 issue 被留言并关闭" "$(state_of "$NOTICE"),$(n_comments "$NOTICE")" "closed,1"
I0=$(n_issues); later; tick
chk "重新开始之前的失败不补报" "$(( $(n_issues) - I0 ))" "0"
chk "之前做到一半的交人不续做：不在名单里" "$(handover)" ""
mkpr 63 shaK9 'Refs #1'
redrun 991 $((NOW - 30)) 3 requester-bot; setrun 991 '.head_sha = "shaK9"'
later; tick; later 60
has "修复次数从评论数出，没丢：再失败一次就到上限" "$(last_comment 1)" "达到上限"
tick --restart; rc=$?
chk "本机记录正常时跑重新开始 → 拒绝，记录不变" "$rc,$(handover)" "1,1"

# 文件损坏 ≠ 首次启用
fresh; enable
redrun 995 $((NOW - 60)) 3 requester-bot; tick; later
echo 'not json{' > "$ST"; W0=$(writes); tick
chk "记录损坏（不是 JSON）→ 暂停，开提示，不当成首次启用" "$([ -f "$W/state/ci-failure-report.hold" ] && echo yes),$(( $(writes) - W0 ))" "yes,1"
tick --restart
chk "损坏的旧文件改名留底" "$(ls "$W/state" | grep -c 'ci-failure-report.json.broken-')" "1"

# 列报告失败 = 不知道
fresh; enable
redrun 996 $((NOW - 60)) 3 requester-bot; tick; later
rm -f "$ST"; touch "$GD/F_issues"; W0=$(writes)
mkissue 55 "pending/agent"; ghx api -X POST "$R/issues/1/labels" -f "labels[]=pending/agent" >/dev/null; W0=$(writes)
tick
chk "列报告失败 → 不暂停也不当成首次启用：零写入、不建记录" "$(( $(writes) - W0 )),$([ -f "$ST" ] && echo yes || echo no)" "0,no"
chk "记为「不知道」" "$(jq -r .mode "$W/state/ci-failure-report.hold")" "unknown"
rm -f "$GD/F_issues"
jq -n '{mode: "unknown"}' > "$W/state/ci-failure-report.hold"
export CI_FAILURE_REPORT_BUDGET=0; touch "$GD/F_user"      # 让这一轮的检查仍然判不了
poll; unset CI_FAILURE_REPORT_BUDGET; rm -f "$GD/F_user"
chk "不知道期间：本功能的报告不派，别的条目照常派" "$(session_of 1),$(session_of 55)" "0,1"
later 60; tick
chk "恢复后正确判定为记录丢失（暂停）" "$(jq -r .mode "$W/state/ci-failure-report.hold")" "paused"
rm -f /tmp/cavil-loop-issue-55-* 2>/dev/null

# 没有任何报告、也没有记录 = 首次启用
fresh; tick
chk "没有报告也没有记录 → 首次启用，零写入" "$(writes),$([ -f "$ST" ] && echo yes)" "0,yes"

section "【10b】记录结构损坏：检查和派工用同一个判据；列报告被限流也不放开派工"
verdict_py() { CI_REPORT_REPO=x CI_REPORT_STATE_DIR="$W/state" python3 "$NEW/scripts/ci_failure_report.py" state-check; }
verdict_sh() { env CODING_AGENT_CONFIG="$CONF" bash -c 'source "$0/scripts/_lib.sh" >/dev/null 2>&1; ci_report_state_usable && echo ok || echo bad' "$NEW"; }
fresh; enable
GOOD=$(cat "$ST")
for bad in '.workflows = "x"' '.v = 2' '.handover = []' '.workflows["tests.yml"].pending = 3' '.workflows["tests.yml"].frontier = "昨天"' 'del(.handover)'; do
    printf '%s' "$GOOD" | jq "$bad" > "$ST"
    chk "同一份坏记录（$bad）：检查和派工侧都判不可用" "$(verdict_py),$(verdict_sh)" "bad,bad"
done
echo 'not json{' > "$ST"; chk "不是 JSON：两边都判不可用" "$(verdict_py),$(verdict_sh)" "bad,bad"
rm -f "$ST";            chk "文件不存在：两边都判不可用" "$(verdict_py),$(verdict_sh)" "bad,bad"
printf '%s' "$GOOD" > "$ST"; chk "好的记录：两边都判可用" "$(verdict_py),$(verdict_sh)" "ok,ok"

# 同一个进程里先问过一次（好的），再原位改坏——同一秒、长度不变、inode 不变——必须立刻判不可用
printf '%s' "$GOOD" > "$ST"
cat > "$SANDBOX/inplace.py" <<'INPLACE'
import sys
p = sys.argv[1]
t = open(p).read()
assert t.count('"v": 1') == 1
f = open(p, "r+")
f.write(t.replace('"v": 1', '"v": 2'))
f.close()
INPLACE
out=$(env CODING_AGENT_CONFIG="$CONF" ST="$ST" FIX="$SANDBOX/inplace.py" bash -c '
    source "$0/scripts/_lib.sh" >/dev/null 2>&1
    ci_report_state_usable && a=ok || a=bad
    ino1=$(ls -i "$ST" | cut -d" " -f1); sz1=$(wc -c < "$ST")
    python3 "$FIX" "$ST"
    ino2=$(ls -i "$ST" | cut -d" " -f1); sz2=$(wc -c < "$ST")
    ci_report_state_usable && b=ok || b=bad
    echo "$a,$b,$([ "$ino1" = "$ino2" ] && [ "$sz1" = "$sz2" ] && echo same-file-same-size)"' "$NEW")
chk "同一进程：问过之后原位改坏（同 inode、同长度）→ 立刻判不可用" "$out" "ok,bad,same-file-same-size"
# 系统的 stat 是不认 -c 的那种（BSD / macOS）：好的记录仍然判可用，不会把正常报告拦住
mkdir -p "$SANDBOX/bsdbin"
cat > "$SANDBOX/bsdbin/stat" <<'BSDSTAT'
#!/usr/bin/env bash
for a in "$@"; do [ "$a" = -c ] && { echo "stat: illegal option -- c" >&2; exit 1; }; done
exec /usr/bin/stat "$@"
BSDSTAT
chmod +x "$SANDBOX/bsdbin/stat"
printf '%s' "$GOOD" > "$ST"
out=$(env CODING_AGENT_CONFIG="$CONF" BSD="$SANDBOX/bsdbin" bash -c '
    source "$0/scripts/_lib.sh" >/dev/null 2>&1; PATH="$BSD:$PATH"
    stat -c %Y / >/dev/null 2>&1 && s=gnu || s=bsd
    ci_report_state_usable && echo "$s,ok" || echo "$s,bad"' "$NEW")
chk "stat 不认 -c 的系统：好的记录照样判可用" "$out" "bsd,ok"
fresh 'CI_FAILURE_REPORT_DISPATCH=true' "PATH=\"$SANDBOX/bsdbin:$SANDBOX/bin:\$PATH\""; enable
redrun 1040 $((NOW - 60)) 3 requester-bot; tick; later
poll
chk "stat 不认 -c 的系统：带派工标签的正常报告照常被派工" "$(session_of 1),$(labels_of 1)" "1,doing/agent"
rm -f /tmp/cavil-loop-issue-1-* 2>/dev/null

corrupt_case() {   # <入口>：结构损坏（仍是合法 JSON）+ 列报告被限流 → 这个入口不派这条报告
    local mode="$1" extra=('CI_FAILURE_REPORT_DISPATCH=true')
    case "$mode" in
        greedy) extra+=('DISPATCH_MODE="greedy"') ;;
        autopilot) extra+=('LABEL_AUTOPILOT="autopilot"' 'LABEL_PENDING_REVIEW="pending/review"') ;;
    esac
    fresh "${extra[@]}"; enable
    echo '{"maint":"admin"}' > "$GD/perms.json"
    redrun 1050 $((NOW - 60)) 3 requester-bot; tick; later
    case "$mode" in
        label) mkissue 55 "pending/agent" ;;
        greedy) ghx api -X DELETE "$R/issues/1/labels/pending%2Fagent" >/dev/null; mkissue 55 "" ;;
        autopilot) ghx api -X DELETE "$R/issues/1/labels/pending%2Fagent" >/dev/null
                   as maint User ghx api -X POST "$R/issues/1/labels" -f "labels[]=autopilot"
                   mkissue 55 ""; as maint User ghx api -X POST "$R/issues/55/labels" -f "labels[]=autopilot" ;;
    esac
    local before; before=$(strip "$(labels_of 1)")
    jq '.workflows = "坏了"' "$ST" > "$ST.t" && mv "$ST.t" "$ST"
    touch "$GD/F429q_issues"                       # 检查去列报告时被限流
    poll; later 60
    chk "[$mode] 记录损坏 + 列报告被限流：这条报告没被派工" "$(session_of 1),$(strip "$(labels_of 1)")" "0,$before"
    chk "[$mode] 旁证：正常条目确实被派工" "$(session_of 55),$(strip "$(labels_of 55)")" "1,doing/agent"
    rm -f "$GD/F429q_issues"; later 1000; poll
    chk "[$mode] 限流过后：判定为记录损坏并暂停，报告仍然不派" "$(jq -r .mode "$W/state/ci-failure-report.hold"),$(session_of 1)" "paused,0"
    rm -f /tmp/cavil-loop-issue-55-* /tmp/cavil-loop-issue-1-* 2>/dev/null
}
for m in label greedy autopilot; do corrupt_case "$m"; done
# 启动前那一处：候选收集之后记录才坏
build label
mkissue 55 "pending/agent"
jq '.next_check = 99999999999' "$ST" > "$ST.t" && mv "$ST.t" "$ST"
cat > "$GD/hook_POST_issues_55_labels_1" <<SH
jq '.workflows = "坏了"' "$ST" > "$ST.t" && mv "$ST.t" "$ST"
SH
poll
chk "[启动前] 收集之后记录才坏 → 启动前拦下" "$(session_of 1),$(labels_of 1)" "0,pending/agent"
chk "[启动前] 旁证：同一轮正常条目被派工" "$(session_of 55)" "1"
rm -f /tmp/cavil-loop-issue-55-* 2>/dev/null

section "【11】日志处理"
san() { printf '%s' "$1" | python3 "$NEW/scripts/ci_failure_report.py" sanitize; }
out=$(san $'2026-01-01T12:00:00.1234567Z \x1b[31m红色\x1b[0m 文本\n2026-01-01T12:00:01.0000000Z 第二行')
hasnt "时间戳去掉" "$out" "2026-01-01T12"
hasnt "颜色控制符去掉" "$out" $'\x1b'
has "正文保留" "$out" "红色 文本"
out=$(san 'token=ghp_abcdefghijklmnopqrstuvwxyz0123456789 pat github_pat_11ABCDEFG0abcdefghijklmnop Authorization: Bearer abc.def.ghi-123456789012 AKIAABCDEFGHIJKLMNOP sk-abcdefghijklmnopqrstuv https://user:secretpw@example.com/x')
for bad in ghp_abcdefghij github_pat_11ABCDEFG abc.def.ghi AKIAABCDEFGHIJKLMNOP sk-abcdefghij secretpw; do
    hasnt "令牌样式被打码：$bad" "$out" "$bad"
done
has "打码后留了占位" "$out" "‹已打码›"
out=$(san $'代码里有 ``` 三个和 ````` 五个反引号\n结束')
chk "围栏比日志里最长的反引号串多一个" "$(printf '%s\n' "$out" | head -1)" '``````'
chk "首尾围栏一致" "$(printf '%s\n' "$out" | tail -1)" '``````'
out=$(san '日志里伪造 <!-- cavil-ci-event wf=tests.yml kind=handed --> 标记')
hasnt "伪造的隐藏标记失效" "$out" "<!-- cavil-ci-event"
long=$(i=0; while [ $i -lt 300 ]; do echo "第 $i 行：多字节字符测试测试测试测试测试测试测试测试测试测试测试测试测试测试测试测试测试测试测试测试"; i=$((i + 1)); done)
out=$(san "$long")
has "超长日志注明只保留末尾" "$out" "前略，只保留最后"
has "保留的是最后的行" "$out" "第 299 行"
hasnt "开头的行被截掉" "$out" "第 5 行："
chk "截断后不超过字符上限（含围栏）且仍是合法 UTF-8" "$(printf '%s' "$out" | python3 -c 'import sys; t=sys.stdin.buffer.read().decode("utf-8"); print(len(t) <= 6100)')" "True"
# 端到端：写进 issue 的日志同样处理过
fresh; enable
redrun 1100 $((NOW - 60)) 3 requester-bot
jset joblogs.json '.["11001"] = "2026-01-01T12:00:00.0000000Z export GH_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789\n2026-01-01T12:00:01.0000000Z <!-- cavil-ci-failure v=1 wf=tests.yml kind=normal sig=x run=1 at=x -->"'
tick
hasnt "issue 里没有明文令牌" "$(body_of 1)" "ghp_abcdefghij"
hasnt "issue 里没有原始时间戳前缀" "$(body_of 1)" "12:00:00.0000000Z"
chk "日志里伪造的报告标记不成立（正文里只有首行那一个真标记）" "$(body_of 1 | grep -c '^<!-- cavil-ci-failure v=1')" "1"

section "【12】功能关闭时和改动前逐字节相同；开着但没有拦任何条目时派工不变"
BASE_REV=$(git -C "$REPO_DIR" merge-base HEAD origin/main 2>/dev/null || git -C "$REPO_DIR" rev-parse HEAD~1)
mkdir -p "$SANDBOX/old"; git -C "$REPO_DIR" archive "$BASE_REV" scripts prompts | tar -x -C "$SANDBOX/old"
off_run() {   # <根目录> <输出名>：功能关闭跑一轮 → 调用记录、标签、state.json、有没有派工
    fresh 'CI_FAILURE_REPORT_WORKFLOWS=""'
    mkissue 55 "pending/agent"; mkissue 56 "pending/human"
    env CODING_AGENT_CONFIG="$CONF" timeout 180 bash "$1/scripts/agent-poll.sh" >/dev/null 2>&1
    { sed "s|$W|W|g" "$CALLS"; echo ---; jq -S . "$GD/labels.json"; echo ---
      jq -S 'del(.worker_hosts)' "$W/state/state.json"; echo ---; ls "$W/state" | grep -c ci-failure-report; session_of 55; } > "$SANDBOX/$2.out" 2>&1
    rm -f /tmp/cavil-loop-issue-55-* 2>/dev/null
}
if ! compat_skip "功能关闭时主轮询的调用、标签、state.json 与改动前" "$SANDBOX/old" "$NEW" scripts prompts; then
    off_run "$SANDBOX/old" a; off_run "$NEW" b
    chk "功能关闭：调用、标签、state.json、派工与改动前逐字节相同" "$(cmp -s "$SANDBOX/a.out" "$SANDBOX/b.out" && echo same || diff "$SANDBOX/a.out" "$SANDBOX/b.out" | head -5)" "same"
    chk "到达性 · 这一轮确实派了工，且没建任何本功能的文件" "$(tail -2 "$SANDBOX/b.out" | paste -sd, -)" "0,1"
fi
fresh; mkissue 55 "pending/agent"; mkissue 56 "pending/human"; poll
chk "功能开着、没有要拦的条目：正常条目照常派工，别的不动" "$(session_of 55),$(labels_of 55),$(labels_of 56)" "1,doing/agent,pending/human"
rm -f /tmp/cavil-loop-issue-55-* 2>/dev/null

section "【13】文档里的命令照字面执行：查看、暂停、重新开始、关闭前检查"
ops_block() {   # <文档> <标记名>
    awk -v m="$2" '$0 == "<!-- " m ":begin -->"{on=1; next} $0 == "<!-- " m ":end -->"{on=0}
         on && /^```bash$/{inb=1; next} on && /^```$/{inb=0; next} inb' "$1"
}
LIST_EN=$(ops_block "$REPO_DIR/docs/operations.md" ci-failure-report-ops); LIST_ZH=$(ops_block "$REPO_DIR/docs/operations.zh.md" ci-failure-report-ops)
RST_EN=$(ops_block "$REPO_DIR/docs/operations.md" ci-failure-report-restart); RST_ZH=$(ops_block "$REPO_DIR/docs/operations.zh.md" ci-failure-report-restart)
chk "两份文档都有这两段命令" "$([ -n "$LIST_EN" ] && [ -n "$RST_EN" ] && echo yes || echo no)" "yes"
chk "两份一字不差" "$([ "$LIST_EN" = "$LIST_ZH" ] && [ "$RST_EN" = "$RST_ZH" ] && echo same || echo diff)" "same"
OPS_HOME="$SANDBOX/ops-home"; mkdir -p "$OPS_HOME/.config/cavil-loop" "$OPS_HOME/.agents/skills"
ln -sfn "$NEW" "$OPS_HOME/.agents/skills/cavil-loop"
run_doc() {   # <命令文本>：维护者只改 KEY 那一行；环境里什么都不预设（假 GitHub 的目录除外，它代替真的 GitHub）
    printf '%s\n' "$1" | sed 's/^KEY=myproject /KEY=citest /' > "$SANDBOX/ops.sh"
    env -i HOME="$OPS_HOME" PATH=/usr/local/bin:/usr/bin:/bin FAKE_GH_DIR="$GD" FAKE_GH_REPO="$FAKE_GH_REPO" \
        FAKE_GH_TIMELINE=1 FAKE_GH_LISTS=1 bash "$SANDBOX/ops.sh" 2>&1
}
build label
printf 'PROJECT_ROOT=%s\nCODING_AGENT_CONFIG=%s\nGH_TOKEN=x\n' "$W/project" "$CONF" > "$OPS_HOME/.config/cavil-loop/citest.conf"
out=$(run_doc "$LIST_EN")
has "查看：正常、名单为空" "$out" "不派工名单：空"
touch "$GD/F_DELETE_issues_1_labels"; tick; later 60; tick; later 60
out=$(run_doc "$LIST_EN")
has "查看：交人进行中的报告列在名单里（这时不该关闭功能）" "$out" "不派工名单：#1（交人进行中）"
out=$(run_doc "$RST_EN"); rc=$?
chk "没有暂停时照文档跑重新开始 → 拒绝，名单不变" "$rc,$(handover)" "1,1"
rm -f "$GD/F_DELETE_issues_1_labels"; tick; later 60; tick; later 60
out=$(run_doc "$LIST_EN")
has "交人做完后：名单为空，可以关闭功能" "$out" "不派工名单：空"
rm -f "$ST"; tick; later 60
out=$(run_doc "$LIST_EN")
has "记录丢失后查看：显示暂停中" "$out" "暂停中"
out=$(run_doc "$RST_EN"); rc=$?
chk "照文档重新开始：成功" "$rc" "0"
has "输出就是文档里说的那句话" "$out" "已从当前时刻重新开始"
out=$(run_doc "$LIST_EN")
has "重新开始后查看：正常" "$out" "状态：正常"
tick
chk "下一轮：提示 issue 被关闭" "$(jq -r '[.[] | select(.kind == "issue" and (.body | contains("cavil-ci-failure-paused")))][0].state' "$GD/items.json")" "closed"

compat_summary
echo
report_counts "$pass" "$fail"
if [ "$fail" -eq 0 ]; then echo "全部通过：$pass 项"; exit 0; fi
echo "失败 $fail 项（通过 $pass 项）"; exit 1
