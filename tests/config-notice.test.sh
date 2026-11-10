#!/usr/bin/env bash
# kind: e2e
# 老项目配置缺新功能的设置时提示维护者 —— GitHub#289。
#
# 跑法：bash tests/config-notice.test.sh
# 依赖：bash、jq、python3、git。不碰网络：有状态的假 GitHub（tests/lib/fake_github.py）+ 假 tmux，
# HOME 指向临时目录。每一轮都**真的**起 agent-poll.sh 子进程（照调度入口 poll-entry.sh 的样子带上
# 发布目录和调度标记，发布目录指向本测试自己的一份代码副本），开没开 issue、评论、关闭都从假 GitHub
# 的条目、标签、调用记录和 $STATE_DIR/config-notice.json 里读，不读源码。
#
# 这块错了的方向都不报错：
#   · 每轮都开 / 都评论 → 仓库被刷爆；从来不开 → 又回到「功能一直关着没人知道」
#   · 把空值（KEY=""，明确不开）当成缺 → 维护者关掉了还被追着提示
#   · 把「读不到那条 issue」当成「已关」→ 重复开 issue；当成「开着」→ 往人关掉的 issue 上评论
#   · 写失败也记成「已提示」→ 这一批永远没提示出去
#   · 手动试跑 agent-poll.sh 也开 issue → 维护者调试一次就在仓库里留一条
# 全部缺项都写了的项目、以及只写日志的项目，GitHub 调用和改动前（merge-base）逐条一致。
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
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export TZ=UTC
unset CODING_AGENT_RELEASE_ROOT LABEL_AUTOPILOT GH_TOKEN WRITE_GH_TOKEN GITHUB_TOKEN \
    LABEL_PENDING_BLOCKED CONFIG_NOTICE_ISSUE DEMO_NEW_FEATURE ENABLE_CONCURRENT_WORK_HINT CONCURRENT_WORK_HINT STUCK_WORKER_QUIET_SECS
export FAKE_GH_REPO="example/cn"

bash "$TEST_DIR/lib/fake_gh_client.sh" install "$SANDBOX/bin/gh" python3 "$TEST_DIR/lib/fake_github.py"
cat > "$SANDBOX/bin/tmux" <<'SH'
#!/usr/bin/env bash
# 记下 daemon 的子进程看不看得到调度标记（worker 是 tmux 起的，看得到就会被继承）
[ -z "${TMUX_ENV_LOG:-}" ] || printf '%s\n' "${CAVIL_SCHEDULED_POLL:-none}" >> "$TMUX_ENV_LOG"
case "$1" in has-session) exit 1 ;; ls|list-sessions) exit 1 ;; esac
exit 0
SH
# 假 systemctl：真调度入口 poll-entry.sh 会跑单元链接修复，不能碰本机真的 systemd
printf '#!/usr/bin/env bash\nexit 0\n' > "$SANDBOX/bin/systemctl"
chmod +x "$SANDBOX/bin/gh" "$SANDBOX/bin/tmux" "$SANDBOX/bin/systemctl"

pass=0; fail=0
chk() {
    if [ "$2" = "$3" ]; then echo "  ✅ $1"; pass=$((pass+1))
    else echo "  ❌ $1 (期望 [$3]，实得 [$2])"; fail=$((fail+1)); fi
}

# 两份代码副本：当前的（NEW）和 merge-base 的（OLD）。副本里有配置模板和登记表，
# 测「登记表里新加了一项」时改的是 NEW2 这份，不动仓库。
copy_tree() {   # <目标目录> [<rev>]
    mkdir -p "$1"
    if [ -n "${2:-}" ]; then
        git -C "$REPO_DIR" archive "$2" scripts prompts cavil-loop.config.example | tar -x -C "$1"
    else
        (cd "$REPO_DIR" && tar -c scripts prompts cavil-loop.config.example) | tar -x -C "$1"
    fi
}
NEW="$SANDBOX/new"; copy_tree "$NEW"
NEW2="$SANDBOX/new2"; copy_tree "$NEW2"
printf '\n# 测试用：模拟以后新加的一个功能\nDEMO_NEW_FEATURE="on"\n' >> "$NEW2/cavil-loop.config.example"
printf 'DEMO_NEW_FEATURE | notice | example/upstream#9 | "" | 演示功能：测试用的说明。\n' >> "$NEW2/scripts/config-notices.txt"
BASE_REV=$(git -C "$REPO_DIR" merge-base HEAD origin/main 2>/dev/null || git -C "$REPO_DIR" rev-parse HEAD~1)
OLD="$SANDBOX/old"; copy_tree "$OLD" "$BASE_REV"

W="$SANDBOX/run"; R="repos/example/cn"
fresh() {   # [额外配置行…]
    rm -rf "$W"; mkdir -p "$W/state" "$W/wt" "$W/gh"
    git init -q -b main "$W/project" 2>/dev/null
    GD="$W/gh"; export FAKE_GH_DIR="$GD"; CALLS="$GD/calls.log"
    CONF="$W/cavil-loop.config"; NSTATE="$W/state/config-notice.json"
    cat > "$CONF" <<CONF
REPO="example/cn"
PROJECT_ROOT="$W/project"
WORKTREE_BASE="$W/wt"
STATE_DIR="$W/state"
TMUX_PREFIX="cntest"
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
POLL_IDLE_PROBE=false
PRICE_AUTO_FETCH=0
MAX_CONCURRENT_WORKERS=0
# 这份「老项目配置」对别的 notice 项都已经拿过主意（写成空值 = 决定不开），只剩等前置标签那一项没写：
# 下面每一组都以「恰好缺 LABEL_PENDING_BLOCKED 一项」为起点
ENABLE_CONCURRENT_WORK_HINT=""
# 这一项改名前的名字（GitHub#356）：当前代码不认它，只有对拍用的改动前那份代码还读它
CONCURRENT_WORK_HINT=""
STUCK_WORKER_QUIET_SECS=""
PATH="$SANDBOX/bin:\$PATH"
GH_TOKEN="fake-token-for-test"
CONF
    local l; for l in "$@"; do printf '%s\n' "$l" >> "$CONF"; done
    echo '{}' > "$GD/items.json"; echo '{}' > "$GD/labels.json"; echo '{}' > "$GD/events.json"
    echo '{}' > "$GD/comments.json"; echo '{}' > "$GD/perms.json"; echo loop-bot > "$GD/me"
    echo '{"cleaned_prs":[],"cleaned_issues":[]}' > "$W/state/state.json"
}
conf_set() { printf '%s\n' "$1" >> "$CONF"; }
# 一轮调度器起的轮询：照 poll-entry.sh 的样子导出发布目录、只给 agent-poll.sh 这一个进程交调度标记
tick() {   # [<root>]
    local root="${1:-$NEW}"
    : > "$CALLS"
    env CODING_AGENT_RELEASE_ROOT="$root" CODING_AGENT_CONFIG="$CONF" CAVIL_SCHEDULED_POLL=1 \
        bash "$root/scripts/agent-poll.sh" >/dev/null 2>&1
}
n_calls() { grep -cE -- "$1" "$CALLS" 2>/dev/null || true; }
creates() { n_calls "^gh api -X POST $R/issues "; }
on_issue() { n_calls "^gh api( -X [A-Z]+)? $R/issues/$1( |/)"; }
item() { jq -r --arg n "$1" ".[\$n]$2 // \"\"" "$GD/items.json"; }
labels_of() { jq -r --arg n "$1" '(.[$n] // []) | sort | join(",")' "$GD/labels.json"; }
n_items() { jq 'length' "$GD/items.json"; }
nst() { jq -c "$1" "$NSTATE" 2>/dev/null || echo "无"; }
comments_on() { jq -r --arg n "$1" '(.[$n] // []) | length' "$GD/comments.json"; }
log_has() { grep -cF -- "$1" "$W/state/poll.log" 2>/dev/null || true; }

echo "【1】缺等前置那一行：开一条挂 pending/human 的提示 issue，正文写清楚做什么、写哪一行"
fresh
tick
chk "开了一条 issue" "$(creates)/$(n_items)" "1/1"
chk "挂 pending/human（不会被派工）" "$(labels_of 1)" "pending/human"
body=$(item 1 .body)
chk "正文带本功能的隐藏标记" "$(grep -c '<!-- cavil-config-notice -->' <<<"$body")" 1
chk "正文点名缺的配置项" "$(grep -c '`LABEL_PENDING_BLOCKED`' <<<"$body")" 1
chk "正文给出模板里的那一行原文" "$(grep -cx 'LABEL_PENDING_BLOCKED="pending/blocked"' <<<"$body")" 1
chk "正文提到跨仓库要配 TRUSTED_REPOS、要建标签" \
    "$(grep -c 'TRUSTED_REPOS' <<<"$body")/$(grep -c '建好 `pending/blocked` 标签' <<<"$body")" "1/1"
chk "正文写了不开怎么写" "$(grep -c '写成 `LABEL_PENDING_BLOCKED=""`' <<<"$body")" 1
chk "正文写了配置文件在哪" "$(grep -cF "$CONF" <<<"$body")" 1
chk "标题说缺 1 项" "$(item 1 .title)" "[daemon] 本项目配置缺 1 项新功能的设置"
chk "用写身份开的（gh_write）" "$(grep -c 'fake-token-for-test gh api -X POST repos/example/cn/issues ' "$GD/tokens.log")" 1
chk "记下 issue 号和已提示的项" "$(nst '[.issue, .issued, .logged]')" '[1,["LABEL_PENDING_BLOCKED"],["LABEL_PENDING_BLOCKED"]]'
chk "轮询日志写了一行" "$(log_has '配置提示：本项目配置里没有 LABEL_PENDING_BLOCKED')" 1
tick
chk "下一轮：零创建、不碰那条 issue" "$(creates)/$(on_issue 1)" "0/0"
chk "日志不重复写" "$(log_has '配置提示：本项目配置里没有 LABEL_PENDING_BLOCKED')" 1

echo "【2】维护者写进配置（明确不开 = 空值）：下一轮关掉提示 issue，之后不再碰"
conf_set 'LABEL_PENDING_BLOCKED=""'
tick
chk "关之前重读过、然后关掉" "$(n_calls "^gh api $R/issues/1 --jq")/$(n_calls "^gh api -X PATCH $R/issues/1 ")" "1/1"
chk "issue 已关闭" "$(item 1 .state)" "closed"
chk "状态里不再挂着 issue" "$(nst '[.issue, .issued]')" '[null,[]]'
tick
chk "再下一轮：零调用" "$(creates)/$(on_issue 1)" "0/0"

echo "【2b】写成开（pending/blocked）同样算已决定"
fresh
tick
conf_set 'LABEL_PENDING_BLOCKED="pending/blocked"'
tick
chk "关掉提示 issue" "$(item 1 .state)" "closed"

echo "【2c】由 systemd 环境文件给的值也算已设置（三轮输入只差这一个环境变量，都走调度路径）"
env_tick() {   # <环境变量赋值，空 = 不设>
    fresh
    : > "$CALLS"
    env ${1:+"$1"} CODING_AGENT_RELEASE_ROOT="$NEW" CODING_AGENT_CONFIG="$CONF" CAVIL_SCHEDULED_POLL=1 \
        bash "$NEW/scripts/agent-poll.sh" >/dev/null 2>&1
}
env_tick ""
chk "环境里没有这一行：开提示 issue（证明这一组确实走进了比对）" "$(creates)/$(nst .issue)" "1/1"
env_tick 'LABEL_PENDING_BLOCKED='
chk "环境里给空值：不开、不写状态文件" "$(creates)/$(nst .)" "0/无"
chk "（这一轮确实跑到了 GitHub）" "$([ -s "$CALLS" ] && echo yes || echo no)" yes
env_tick 'LABEL_PENDING_BLOCKED=pending/blocked'
chk "环境里给开启值：不开、不写状态文件" "$(creates)/$(nst .)" "0/无"

echo "【2d】人把提示 issue 转进别的流程（摘了 pending/human、改打派工标签）：不关、不评论，不再跟踪"
set_labels() { jq --arg n "$1" --arg l "$2" '.[$n] = ($l | split(",") | map(select(. != "")))' "$GD/labels.json" > "$GD/l.tmp" && mv "$GD/l.tmp" "$GD/labels.json"; }
fresh
tick
set_labels 1 "pending/agent"
conf_set 'LABEL_PENDING_BLOCKED=""'
tick
chk "关闭路径：重读过，但没关" "$(n_calls "^gh api $R/issues/1 --jq")/$(n_calls "^gh api -X PATCH ")/$(item 1 .state)" "1/0/open"
chk "标签原样留着" "$(labels_of 1)" "pending/agent"
chk "不再跟踪它" "$(nst .issue)" "null"
tick
chk "下一轮不再读它" "$(on_issue 1)" 0
fresh
tick
set_labels 1 "doing/agent,pending/human"
tick "$NEW2"
chk "评论路径：保护标签还在但多了别的流程标签 → 不评论，另开一条" "$(comments_on 1)/$(creates)/$(item 1 .state)" "0/1/open"
fresh
tick
set_labels 1 ""
conf_set 'LABEL_PENDING_BLOCKED=""'
tick
chk "保护标签被摘光：不关" "$(n_calls "^gh api -X PATCH ")/$(item 1 .state)" "0/open"
fresh
tick
set_labels 1 "pending/human,bug"
conf_set 'LABEL_PENDING_BLOCKED=""'
tick
chk "只多了非流程标签（bug）：照常关" "$(item 1 .state)" "closed"

echo "【3】人手动关掉提示 issue：同一批不重开、不再读它；出现新缺项才开新的一条（列全部缺项）"
fresh
tick
jq '.["1"].state = "closed"' "$GD/items.json" > "$GD/i.tmp" && mv "$GD/i.tmp" "$GD/items.json"
tick; tick
chk "缺项没变：零创建、零读" "$(creates)/$(on_issue 1)" "0/0"
tick "$NEW2"
chk "新缺项：先重读旧 issue，发现已关，开新的" "$(n_calls "^gh api $R/issues/1 --jq")/$(creates)" "1/1"
chk "没往人关掉的 issue 上评论" "$(comments_on 1)" 0
body=$(item 2 .body)
chk "新 issue 列出全部缺项" "$(grep -c '`LABEL_PENDING_BLOCKED`' <<<"$body")/$(grep -c '`DEMO_NEW_FEATURE`' <<<"$body")" "1/1"
chk "新 issue 标题说缺 2 项" "$(item 2 .title)" "[daemon] 本项目配置缺 2 项新功能的设置"
chk "状态指向新 issue" "$(nst '[.issue, .issued]')" '[2,["DEMO_NEW_FEATURE","LABEL_PENDING_BLOCKED"]]'
chk "日志只为新缺项写一行" "$(log_has '没有 DEMO_NEW_FEATURE')/$(log_has '没有 LABEL_PENDING_BLOCKED')" "1/1"

echo "【4】提示 issue 还开着时出现新缺项：在它上面追加评论，不开第二条"
fresh
tick
tick "$NEW2"
chk "零创建、一条评论" "$(creates)/$(comments_on 1)" "0/1"
cbody=$(jq -r '.["1"][0].body' "$GD/comments.json")
chk "评论只讲新增的那一项" "$(grep -c '`DEMO_NEW_FEATURE`' <<<"$cbody")/$(grep -c '`LABEL_PENDING_BLOCKED`' <<<"$cbody")" "1/0"
chk "评论给出模板里的那一行" "$(grep -cx 'DEMO_NEW_FEATURE="on"' <<<"$cbody")" 1
tick "$NEW2"
chk "再下一轮：不重复评论" "$(comments_on 1)/$(on_issue 1)" "1/0"
conf_set 'DEMO_NEW_FEATURE=""'
conf_set 'LABEL_PENDING_BLOCKED=""'
tick "$NEW2"
chk "两项都写进配置后关掉" "$(item 1 .state)" "closed"

echo "【4b】改了名的设置（GitHub#356）：配置里只写着旧名字 = 没写，照常提示新名字；旧提示记录不拦这一次"
OLD_KEY="CONCURRENT_WORK_HINT"; NEW_KEY="ENABLE_CONCURRENT_WORK_HINT"
only_old_name() { sed -i "/^$NEW_KEY=/d; /^$OLD_KEY=/d" "$CONF"; conf_set "$OLD_KEY=\"true\""; }
fresh 'LABEL_PENDING_BLOCKED=""'
only_old_name
tick
chk "只写旧名字：开一条提示 issue" "$(creates)/$(n_items)" "1/1"
body=$(item 1 .body)
chk "正文点名新名字、给出模板里新名字那一行" "$(grep -c "\`$NEW_KEY\`" <<<"$body")/$(grep -cx "$NEW_KEY=\"true\"" <<<"$body")" "1/1"
chk "正文说明旧名字已不再生效" "$(grep -c "原来叫 \`$OLD_KEY\`，那个名字已不再生效" <<<"$body")" 1
chk "记下的是新名字" "$(nst '.issued')" "[\"$NEW_KEY\"]"
conf_set "$NEW_KEY=\"true\""
tick
chk "补上新名字那一行后关掉" "$(item 1 .state)" "closed"
# 旧版本留下的提示记录：提示 issue 开着，记录里是旧名字
fresh
tick
jq --arg k "$OLD_KEY" '.logged += [$k] | .issued += [$k]' "$NSTATE" > "$NSTATE.tmp" && mv "$NSTATE.tmp" "$NSTATE"
sed -i "/^$NEW_KEY=/d; /^$OLD_KEY=/d" "$CONF"
tick
chk "旧记录 + 两个名字都没写：零创建、原 issue 上一条评论" "$(creates)/$(comments_on 1)" "0/1"
cbody=$(jq -r '.["1"][0].body' "$GD/comments.json")
chk "评论给出新名字那一行" "$(grep -cx "$NEW_KEY=\"true\"" <<<"$cbody")" 1
chk "记录里只剩现在登记着的名字" "$(nst '.issued')" "[\"$NEW_KEY\",\"LABEL_PENDING_BLOCKED\"]"
tick
chk "再下一轮：不重复评论" "$(comments_on 1)/$(on_issue 1)" "1/0"
conf_set "$NEW_KEY=\"\""
conf_set 'LABEL_PENDING_BLOCKED=""'
tick
chk "都写进配置后关掉" "$(item 1 .state)" "closed"

echo "【5】读不到提示 issue：什么都不写、不记，恢复后补上"
fresh
tick
touch "$GD/F_issues_1"
tick "$NEW2"
chk "读失败那轮：零创建、零评论" "$(creates)/$(comments_on 1)" "0/0"
chk "已提示记录没被改成包含新项" "$(nst .issued)" '["LABEL_PENDING_BLOCKED"]'
rm -f "$GD/F_issues_1"
tick "$NEW2"
chk "恢复后：补上评论，仍不开第二条" "$(comments_on 1)/$(n_items)" "1/1"

echo "【6】开 issue 失败：不记已提示，下一轮再开，且只开一条"
fresh
touch "$GD/F_post_issue"
tick
chk "失败那轮：没有 issue、状态里没记" "$(n_items)/$(nst '[.issue, .issued]')" '0/[null,[]]'
chk "日志照写（日志不依赖 GitHub）" "$(log_has '没有 LABEL_PENDING_BLOCKED')" 1
rm -f "$GD/F_post_issue"
tick; tick
chk "恢复后只开了一条" "$(n_items)" 1

echo "【7】评论失败、关闭失败：下一轮重来"
fresh
tick
touch "$GD/F_post_comment"
tick "$NEW2"
chk "评论失败：没记已提示" "$(nst .issued)" '["LABEL_PENDING_BLOCKED"]'
rm -f "$GD/F_post_comment"
tick "$NEW2"
chk "下一轮补上评论" "$(comments_on 1)" 1
conf_set 'DEMO_NEW_FEATURE=""'; conf_set 'LABEL_PENDING_BLOCKED=""'
touch "$GD/F_patch_issue"
tick "$NEW2"
chk "关闭失败：issue 仍记着、仍开着" "$(nst .issue)/$(item 1 .state)" "1/open"
rm -f "$GD/F_patch_issue"
tick "$NEW2"
chk "下一轮关掉" "$(item 1 .state)/$(nst .issue)" "closed/null"

echo "【8】状态里的号不是本功能开的（或是 PR）：不碰它，另开一条"
fresh
jq '.["1"] = {kind:"issue", state:"open", title:"别的事", body:"人写的", user:{login:"maint"}}' "$GD/items.json" > "$GD/i.tmp" && mv "$GD/i.tmp" "$GD/items.json"
echo '{"issue":1,"logged":["LABEL_PENDING_BLOCKED"],"issued":["LABEL_PENDING_BLOCKED"]}' > "$NSTATE"
tick "$NEW2"
chk "不在别人的 issue 上评论、另开一条" "$(comments_on 1)/$(creates)/$(item 1 .state)" "0/1/open"

echo "【9】只写日志（CONFIG_NOTICE_ISSUE=false）：零 GitHub 写，日志每项一次"
fresh 'CONFIG_NOTICE_ISSUE=false'
tick; tick
chk "零创建" "$(creates)" 0
chk "日志一次" "$(log_has '没有 LABEL_PENDING_BLOCKED')" 1
chk "状态只记日志" "$(nst '[.issue, .logged, .issued]')" '[null,["LABEL_PENDING_BLOCKED"],[]]'

echo "【10】不是调度器起的轮询：不提示、不写状态"
fresh
: > "$CALLS"; env CODING_AGENT_CONFIG="$CONF" bash "$NEW/scripts/agent-poll.sh" >/dev/null 2>&1
chk "手动直接跑 agent-poll.sh：零创建、无状态文件、无日志" "$(creates)/$(nst .)/$(log_has '配置提示')" "0/无/0"
chk "（这一轮确实跑到了 GitHub）" "$([ -s "$CALLS" ] && echo yes || echo no)" yes
# worker 会话里继承了调度入口导出的发布目录，但没有调度标记
: > "$CALLS"; env CODING_AGENT_RELEASE_ROOT="$NEW" CODING_AGENT_CONFIG="$CONF" bash "$NEW/scripts/agent-poll.sh" >/dev/null 2>&1
chk "worker 会话里跑（有发布目录、没调度标记）：零创建、无状态文件" "$(creates)/$(nst .)" "0/无"

echo "【10b】调度标记不传给 daemon 的子进程（worker 继承不到）"
fresh
export TMUX_ENV_LOG="$W/tmux-env.log"; : > "$TMUX_ENV_LOG"
tick
chk "子进程确实被调起过" "$([ -s "$TMUX_ENV_LOG" ] && echo yes || echo no)" yes
chk "子进程都看不到调度标记" "$(sort -u "$TMUX_ENV_LOG" | tr '\n' ' ')" "none "
chk "这一轮本身认得是调度器起的（开了 issue）" "$(creates)" 1
unset TMUX_ENV_LOG

echo "【10c】经真实调度入口 poll-entry.sh：开提示 issue"
fresh
: > "$CALLS"
env -u CODING_AGENT_RELEASE_ROOT CAVIL_DEPLOY_CONF="$SANDBOX/no-deploy.conf" CAVIL_DEPLOY_ROOT="$SANDBOX/no-deploy" \
    CODING_AGENT_CONFIG="$CONF" PATH="$SANDBOX/bin:$PATH" bash "$NEW/scripts/poll-entry.sh" >/dev/null 2>&1
chk "开了一条提示 issue" "$(creates)/$(labels_of 1)" "1/pending/human"

echo "【11】和改动前逐条一致：配置都写全的项目、只写日志的项目"
same_calls() {   # <描述> [配置行…]
    local what="$1"; shift
    if ! compat_skip "$what" "$OLD" "$NEW" scripts; then
        fresh "$@"; tick "$OLD"; tick "$OLD"; sed 's/[0-9]\{10,\}//g' "$CALLS" > "$SANDBOX/old.calls"
        fresh "$@"; tick "$NEW"; tick "$NEW"; sed 's/[0-9]\{10,\}//g' "$CALLS" > "$SANDBOX/new.calls"
        chk "$what：GitHub 调用逐条一致" "$(diff "$SANDBOX/old.calls" "$SANDBOX/new.calls" >/dev/null && echo same || echo diff)" same
        chk "$what：确实发过调用（不是早退）" "$([ -s "$SANDBOX/new.calls" ] && echo yes || echo no)" yes
    fi
}
same_calls "配置全写了" 'LABEL_PENDING_BLOCKED=""'
same_calls "只写日志" 'CONFIG_NOTICE_ISSUE=false'

echo "【12】登记表：模板里每个配置项都登记了，登记的都在模板里，说明字段齐全"
# 守的是以后：往模板里加新配置项却没决定老项目要不要被提示，这里就红。
guard() {   # <模板> <登记表> → 打印问题，一行一个
    local tpl="$1" reg="$2"
    python3 - "$tpl" "$reg" <<'PY'
import re, sys
tpl, reg = sys.argv[1], sys.argv[2]
keys = []
for l in open(tpl, encoding="utf-8"):
    m = re.match(r"^([A-Z_][A-Z0-9_]*)=", l)
    if m and m.group(1) not in keys:
        keys.append(m.group(1))
seen = {}
for l in open(reg, encoding="utf-8"):
    if not l.strip() or l.lstrip().startswith("#"):
        continue
    f = [x.strip() for x in l.rstrip("\n").split("|")]
    k = f[0]
    if k in seen:
        print("登记了两次:", k)
    seen[k] = f
    if len(f) < 2 or f[1] not in ("notice", "quiet"):
        print("种类不对:", k)
    elif f[1] == "quiet" and (len(f) != 3 or not f[2]):
        print("quiet 要写一句原因:", k)
    elif f[1] == "notice" and (len(f) != 5 or not all(f[2:])):
        print("notice 要写出处、不开时的值、说明:", k)
for k in keys:
    if k not in seen:
        print("模板里有、登记表里没有:", k)
for k in seen:
    if k not in keys:
        print("登记表里有、模板里没有:", k)
PY
}
chk "当前仓库：没有问题" "$(guard "$REPO_DIR/cavil-loop.config.example" "$REPO_DIR/scripts/config-notices.txt")" ""
cp "$REPO_DIR/cavil-loop.config.example" "$SANDBOX/tpl.extra"; echo 'BRAND_NEW_KEY="x"' >> "$SANDBOX/tpl.extra"
chk "模板加一项不登记：报出来" "$(guard "$SANDBOX/tpl.extra" "$REPO_DIR/scripts/config-notices.txt")" "模板里有、登记表里没有: BRAND_NEW_KEY"
chk "测试用的扩展副本也合规" "$(guard "$NEW2/cavil-loop.config.example" "$NEW2/scripts/config-notices.txt")" ""

echo "【13】登记表的分类和代码一致：notice 项不写时确实是关的、模板里是开的；quiet 项里公共库给了默认值的，和模板值相同"
# 只能核对公共库在加载时就补上默认值的那些项；在用的地方才补默认值的项由人工核对过（见登记表开头）。
mkdir -p "$SANDBOX/cls"
cat > "$SANDBOX/cls/min.config" <<CONF
REPO="a/b"
PROJECT_ROOT="$SANDBOX/cls/p"
WORKTREE_BASE="$SANDBOX/cls/w"
STATE_DIR="$SANDBOX/cls/s"
TMUX_PREFIX="x"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
CONF
sed "s|^STATE_DIR=.*|STATE_DIR=\"$SANDBOX/cls/s2\"|" "$REPO_DIR/cavil-loop.config.example" > "$SANDBOX/cls/tpl.config"
dump() {   # <配置> → KEY<TAB>值 / KEY<TAB><unset>
    env -i HOME="$HOME" PATH=/usr/bin:/bin CODING_AGENT_CONFIG="$1" REG="$REPO_DIR/scripts/config-notices.txt" bash -c '
        source "'"$REPO_DIR"'/scripts/_lib.sh" >/dev/null 2>&1
        grep -vE "^[[:space:]]*(#|$)" "$REG" | while IFS="|" read -r k kind _; do
            k="${k//[[:space:]]/}"; kind="${kind//[[:space:]]/}"
            if [ -n "${!k+x}" ]; then printf "%s\t%s\t%s\n" "$k" "$kind" "${!k}"; else printf "%s\t%s\t<unset>\n" "$k" "$kind"; fi
        done'
}
dump "$SANDBOX/cls/min.config" > "$SANDBOX/cls/a"
dump "$SANDBOX/cls/tpl.config" > "$SANDBOX/cls/b"
mism=$(paste "$SANDBOX/cls/a" "$SANDBOX/cls/b" | awk -F'\t' '
    $2 == "quiet" && $3 != "<unset>" && $3 != $6 && $1 !~ /^(REPO|PROJECT_ROOT|WORKTREE_BASE|STATE_DIR|TMUX_PREFIX|BRANCH_PREFIX|SESSION_NAME_PREFIX|LABEL_PENDING_AGENT|LABEL_PENDING_HUMAN|PATH)$/ { print "quiet 但默认值≠模板:", $1 }
    $2 == "notice" && ($3 == $6) { print "notice 但不写时和模板一样:", $1 }')
chk "分类与公共库的默认值一致" "$mism" ""
chk "核对确实覆盖到了 notice 项（不写时是空、模板里开）" \
    "$(awk -F'\t' '$1 == "LABEL_PENDING_BLOCKED" { print $3 }' "$SANDBOX/cls/a")|$(awk -F'\t' '$1 == "LABEL_PENDING_BLOCKED" { print $3 }' "$SANDBOX/cls/b")" "|pending/blocked"
chk "核对覆盖的 quiet 项不止几个" "$([ "$(awk -F'\t' '$2 == "quiet" && $3 != "<unset>"' "$SANDBOX/cls/a" | wc -l)" -ge 30 ] && echo yes || echo no)" yes

echo "【14】运维文档里的查看步骤：中英文两份一字不差，在干净 shell 里按原样执行"
ops_block() {   # <文档> → 标记之间 ```bash 代码块的内容
    awk '/<!-- config-notice-ops:begin -->/{on=1; next} /<!-- config-notice-ops:end -->/{on=0}
         on && /^```bash$/{inb=1; next} on && /^```$/{inb=0; next} inb' "$1"
}
OPS_EN=$(ops_block "$REPO_DIR/docs/operations.md"); OPS_ZH=$(ops_block "$REPO_DIR/docs/operations.zh.md")
chk "两份文档都有这段" "$([ -n "$OPS_EN" ] && [ -n "$OPS_ZH" ] && echo yes || echo no)" yes
chk "两份一字不差" "$([ "$OPS_EN" = "$OPS_ZH" ] && echo same || echo diff)" same
# 维护者要填的只有 KEY 那一行；别的照抄。HOME 是一台装好了这个项目的「机器」，环境里什么都不预设。
OPS_HOME="$SANDBOX/ops-home"; mkdir -p "$OPS_HOME/.config/cavil-loop"
run_ops() {
    printf '%s\n' "$OPS_EN" | sed 's/^KEY=myproject /KEY=cntest /' > "$SANDBOX/ops.sh"
    env -i HOME="$OPS_HOME" PATH=/usr/local/bin:/usr/bin:/bin bash "$SANDBOX/ops.sh" 2>&1
}
fresh
printf 'PROJECT_ROOT=%s\nCODING_AGENT_CONFIG=%s\nGH_TOKEN=x\n' "$W/project" "$CONF" > "$OPS_HOME/.config/cavil-loop/cntest.conf"
rm -f "$W/state/config-notice.json"
out=$(run_ops)
chk "还没跑过：找到了配置和状态目录" "$(grep -cxF "config: $CONF" <<<"$out")/$(grep -cxF "state:  $W/state" <<<"$out")" "1/1"
chk "还没跑过：说明没有状态文件，不报错" "$(grep -c '^no config-notice.json' <<<"$out")/$(grep -c 'No such file' <<<"$out")" "1/0"
tick
out=$(run_ops)
chk "跑过一轮：列出缺项和 issue 号" "$(printf '%s\n' "$out" | sed -n '/^{/,/^}/p' | jq -c '[.issue, .logged]')" '[1,["LABEL_PENDING_BLOCKED"]]'
chk "跑过一轮：日志里那一行也列出来" "$(grep -c '配置提示：本项目配置里没有 LABEL_PENDING_BLOCKED' <<<"$out")" 1
conf_set 'LABEL_PENDING_BLOCKED=""'
tick
out=$(run_ops)
chk "补上配置后：缺项清空、issue 回到 null，issue 已关" "$(printf '%s\n' "$out" | sed -n '/^{/,/^}/p' | jq -c '[.issue, .logged, .issued]')/$(item 1 .state)" '[null,[],[]]/closed'

echo
echo "结果：$pass 通过 / $fail 失败"
compat_summary
report_counts "$pass" "$fail"
[ "$fail" -eq 0 ]
