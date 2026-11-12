#!/usr/bin/env bash
# kind: e2e
# 老项目配置缺新功能的设置时提示维护者 —— GitHub#289；GitHub#428 起只写轮询日志、不碰 GitHub。
#
# 跑法：bash tests/config-notice.test.sh
# 依赖：bash、jq、python3、git。不碰网络：有状态的假 GitHub（tests/lib/fake_github.py）+ 假 tmux，
# HOME 指向临时目录。每一轮都**真的**起 agent-poll.sh 子进程（照调度入口 poll-entry.sh 的样子带上
# 发布目录和调度标记，发布目录指向本测试自己的一份代码副本），写没写日志从 poll.log、
# $STATE_DIR/config-notice.json 里读，碰没碰 GitHub 从假 GitHub 的条目、标签、评论和调用记录里读，不读源码。
#
# 这块错了的方向都不报错：
#   · 又开 / 评论 / 关提示 issue → 维护者明确不要了（GitHub#428）；老配置里写着 CONFIG_NOTICE_ISSUE=true、
#     或旧状态文件里记着一条开着的提示 issue，都不能把它叫回来
#   · 日志每轮都写 → 刷屏；从来不写 → 又回到「功能一直关着没人知道」
#   · 把空值（KEY=""，明确不开）当成缺 → 维护者关掉了还被追着提示
#   · 手动试跑 agent-poll.sh 也写 → 调试一次就多一行
# 「零调用」都配着「这一轮确实跑到了比对」（日志那一行）；缺项和不缺项的项目 GitHub 调用逐条一致，
# 也和改动前（merge-base）只写日志时（CONFIG_NOTICE_ISSUE=false）逐条一致。
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
    LABEL_PENDING_BLOCKED CONFIG_NOTICE_ISSUE DEMO_NEW_FEATURE ENABLE_CONCURRENT_WORK_HINT CONCURRENT_WORK_HINT \
    ENABLE_USAGE_LIMIT_PAUSE AUTOPILOT_OUTSIDER_GUARD AUTOPILOT_OUTSIDER_SCREEN AUTOPILOT_OUTSIDER_SCREEN_CMD
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
ENABLE_USAGE_LIMIT_PAUSE=""
AUTOPILOT_OUTSIDER_GUARD=""
AUTOPILOT_OUTSIDER_SCREEN=""
# 这一项改名前的名字（GitHub#356）：当前代码不认它，只有对拍用的改动前那份代码还读它
CONCURRENT_WORK_HINT=""
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

# 提示 issue 的那几种动作：开、在某条上读 / 评论 / 关
notice_calls() { n_calls "^gh api( -X [A-Z]+)? $R/issues( |/[0-9]+( |/comments))"; }
calls_norm() { sed 's/[0-9]\{10,\}//g' "$CALLS"; }
ticks_calls() { tick "$1"; calls_norm; tick "$1"; calls_norm; }   # 两轮的调用合在一起
# 早先版本开的提示 issue：开着、带标记、挂 pending/human
legacy_issue() {
    jq '.["1"] = {kind:"issue", state:"open", title:"[daemon] 本项目配置缺 1 项新功能的设置", body:"<!-- cavil-config-notice -->\n## 本项目配置里缺 1 项新功能的设置", user:{login:"loop-bot"}}' \
        "$GD/items.json" > "$GD/i.tmp" && mv "$GD/i.tmp" "$GD/items.json"
    jq '.["1"] = ["pending/human"]' "$GD/labels.json" > "$GD/l.tmp" && mv "$GD/l.tmp" "$GD/labels.json"
}

echo "【1】缺等前置那一行：只写一行轮询日志，不开 issue；老配置里写着 CONFIG_NOTICE_ISSUE=true 也一样"
for extra in "" "CONFIG_NOTICE_ISSUE=true"; do
    what="${extra:-配置里没有开关那一行}"
    fresh ${extra:+"$extra"}
    : > "$SANDBOX/all.calls"
    for _ in 1 2 3; do tick; cat "$CALLS" >> "$SANDBOX/all.calls"; done
    chk "$what：三轮合计零创建、零提示 issue 调用、仓库里没有条目" \
        "$(grep -cE "^gh api -X POST $R/issues " "$SANDBOX/all.calls")/$(grep -cE "^gh api( -X [A-Z]+)? $R/issues( |/[0-9]+( |/comments))" "$SANDBOX/all.calls")/$(n_items)" "0/0/0"
    chk "$what：日志写了一行（这一轮确实跑到了比对），不重复写" "$(log_has '配置提示：本项目配置里没有 LABEL_PENDING_BLOCKED')" 1
    chk "$what：日志给出模板里那一行和不开写什么" \
        "$(log_has '里加 LABEL_PENDING_BLOCKED="pending/blocked"；不开就写 LABEL_PENDING_BLOCKED=""')" 1
    chk "$what：状态只记日志" "$(nst .)" '{"logged":["LABEL_PENDING_BLOCKED"]}'
    chk "$what：这一轮确实跑到了 GitHub" "$([ -s "$CALLS" ] && echo yes || echo no)" yes
done
fresh 'CONFIG_NOTICE_ISSUE=true'; ticks_calls "$NEW" > "$SANDBOX/miss.calls"
fresh 'LABEL_PENDING_BLOCKED=""'; ticks_calls "$NEW" > "$SANDBOX/full.calls"
chk "缺项的项目和配置写全的项目：两轮合计 GitHub 调用逐条一致" "$(diff "$SANDBOX/miss.calls" "$SANDBOX/full.calls" >/dev/null && echo same || echo diff)" same

echo "【2】写进配置（空值 = 明确不开，或开启值）：从记录里去掉；之后再删掉那一行，日志再写一次"
for val in '""' '"pending/blocked"'; do
    fresh
    tick
    conf_set "LABEL_PENDING_BLOCKED=$val"
    tick
    chk "写成 $val：记录清空、零提示 issue 调用" "$(nst .)/$(notice_calls)" '{"logged":[]}/0'
    tick
    chk "写成 $val：日志没有多写" "$(log_has '没有 LABEL_PENDING_BLOCKED')" 1
done
sed -i '/^LABEL_PENDING_BLOCKED=/d' "$CONF"
tick
chk "删掉之后：日志再写一次、记录里又有它" "$(log_has '没有 LABEL_PENDING_BLOCKED')/$(nst .logged)" '2/["LABEL_PENDING_BLOCKED"]'

echo "【2c】由 systemd 环境文件给的值也算已设置（三轮输入只差这一个环境变量，都走调度路径）"
env_tick() {   # <环境变量赋值，空 = 不设>
    fresh
    : > "$CALLS"
    env ${1:+"$1"} CODING_AGENT_RELEASE_ROOT="$NEW" CODING_AGENT_CONFIG="$CONF" CAVIL_SCHEDULED_POLL=1 \
        bash "$NEW/scripts/agent-poll.sh" >/dev/null 2>&1
}
env_tick ""
chk "环境里没有这一行：写日志（证明这一组确实走进了比对）" "$(log_has '没有 LABEL_PENDING_BLOCKED')/$(nst .logged)" '1/["LABEL_PENDING_BLOCKED"]'
env_tick 'LABEL_PENDING_BLOCKED='
chk "环境里给空值：不写日志、不写状态文件" "$(log_has '配置提示')/$(nst .)" "0/无"
chk "（这一轮确实跑到了 GitHub）" "$([ -s "$CALLS" ] && echo yes || echo no)" yes
env_tick 'LABEL_PENDING_BLOCKED=pending/blocked'
chk "环境里给开启值：不写日志、不写状态文件" "$(log_has '配置提示')/$(nst .)" "0/无"

echo "【3】早先版本留下的提示 issue 和记录：不读、不评论、不关，记录里的旧字段丢掉"
# 仍缺、旧记录里已写过日志：这一轮没有新日志要写，旧字段也要丢掉
fresh
legacy_issue
echo '{"issue":1,"logged":["LABEL_PENDING_BLOCKED"],"issued":["LABEL_PENDING_BLOCKED"]}' > "$NSTATE"
tick "$NEW2"
chk "出现新缺项：零创建、不碰那条 issue、零评论" "$(creates)/$(on_issue 1)/$(comments_on 1)" "0/0/0"
chk "那条 issue 原样开着、标签不动" "$(item 1 .state)/$(labels_of 1)" "open/pending/human"
chk "只为新缺项写一行日志（这一轮确实跑到了比对）" "$(log_has '没有 DEMO_NEW_FEATURE')/$(log_has '没有 LABEL_PENDING_BLOCKED')" "1/0"
chk "记录只剩 logged" "$(nst .)" '{"logged":["DEMO_NEW_FEATURE","LABEL_PENDING_BLOCKED"]}'
fresh
legacy_issue
echo '{"issue":1,"logged":["LABEL_PENDING_BLOCKED"],"issued":["LABEL_PENDING_BLOCKED"]}' > "$NSTATE"
tick
chk "缺项没变、没有新日志：旧字段照样丢掉" "$(nst .)/$(log_has '配置提示')" '{"logged":["LABEL_PENDING_BLOCKED"]}/0'
chk "不碰那条 issue" "$(on_issue 1)/$(item 1 .state)" "0/open"
# 缺项都补上了：早先版本会关掉提示 issue，现在不关
fresh 'LABEL_PENDING_BLOCKED=""'
legacy_issue
echo '{"issue":1,"logged":["LABEL_PENDING_BLOCKED"],"issued":["LABEL_PENDING_BLOCKED"]}' > "$NSTATE"
tick
chk "缺项都补上：不重读、不关那条 issue" "$(on_issue 1)/$(n_calls "^gh api -X PATCH ")/$(item 1 .state)" "0/0/open"
chk "记录清空、只剩 logged" "$(nst .)" '{"logged":[]}'
tick
chk "再下一轮：状态文件不再改写" "$(nst .)/$(on_issue 1)" '{"logged":[]}/0'

echo "【4】登记表里新加了一项：新缺项多写一行日志，仍不开 issue"
fresh
tick
tick "$NEW2"
chk "零创建、日志各一行" "$(creates)/$(log_has '没有 DEMO_NEW_FEATURE')/$(log_has '没有 LABEL_PENDING_BLOCKED')" "0/1/1"
chk "日志给出模板里的那一行" "$(log_has '里加 DEMO_NEW_FEATURE="on"；')" 1
tick "$NEW2"
chk "再下一轮：不重复写" "$(log_has '没有 DEMO_NEW_FEATURE')" 1

echo "【4b】改了名的设置（GitHub#356）：配置里只写着旧名字 = 没写，照常提示新名字；旧记录里的旧名字不拦这一次"
OLD_KEY="CONCURRENT_WORK_HINT"; NEW_KEY="ENABLE_CONCURRENT_WORK_HINT"
only_old_name() { sed -i "/^$NEW_KEY=/d; /^$OLD_KEY=/d" "$CONF"; conf_set "$OLD_KEY=\"true\""; }
fresh 'LABEL_PENDING_BLOCKED=""'
only_old_name
tick
chk "只写旧名字：日志点名新名字、给出新名字那一行" "$(log_has "没有 ${NEW_KEY}，")/$(log_has "里加 $NEW_KEY=true；")" "1/1"
chk "零创建；记下的是新名字" "$(creates)/$(nst .logged)" "0/[\"$NEW_KEY\"]"
conf_set "$NEW_KEY=\"true\""
tick
chk "补上新名字那一行后清空" "$(nst .logged)" "[]"
fresh 'LABEL_PENDING_BLOCKED=""'
echo "{\"logged\":[\"$OLD_KEY\"]}" > "$NSTATE"
sed -i "/^$NEW_KEY=/d; /^$OLD_KEY=/d" "$CONF"
tick
chk "旧记录里只有旧名字：照常为新名字写日志、记录里只剩新名字" "$(log_has "没有 ${NEW_KEY}，")/$(nst .logged)" "1/[\"$NEW_KEY\"]"

echo "【5】状态文件读不懂：写一行说明，按全新状态重来"
fresh
echo 'not json' > "$NSTATE"
tick
chk "说明一行 + 缺项日志一行" "$(log_has '读不懂，按全新状态重来')/$(log_has '没有 LABEL_PENDING_BLOCKED')" "1/1"
chk "状态改写成正常形状、零创建" "$(nst .)/$(creates)" '{"logged":["LABEL_PENDING_BLOCKED"]}/0'

echo "【10】不是调度器起的轮询：不写日志、不写状态"
fresh
: > "$CALLS"; env CODING_AGENT_CONFIG="$CONF" bash "$NEW/scripts/agent-poll.sh" >/dev/null 2>&1
chk "手动直接跑 agent-poll.sh：零创建、无状态文件、无日志" "$(creates)/$(nst .)/$(log_has '配置提示')" "0/无/0"
chk "（这一轮确实跑到了 GitHub）" "$([ -s "$CALLS" ] && echo yes || echo no)" yes
# worker 会话里继承了调度入口导出的发布目录，但没有调度标记
: > "$CALLS"; env CODING_AGENT_RELEASE_ROOT="$NEW" CODING_AGENT_CONFIG="$CONF" bash "$NEW/scripts/agent-poll.sh" >/dev/null 2>&1
chk "worker 会话里跑（有发布目录、没调度标记）：无状态文件、无日志" "$(nst .)/$(log_has '配置提示')" "无/0"

echo "【10b】调度标记不传给 daemon 的子进程（worker 继承不到）"
fresh
export TMUX_ENV_LOG="$W/tmux-env.log"; : > "$TMUX_ENV_LOG"
tick
chk "子进程确实被调起过" "$([ -s "$TMUX_ENV_LOG" ] && echo yes || echo no)" yes
chk "子进程都看不到调度标记" "$(sort -u "$TMUX_ENV_LOG" | tr '\n' ' ')" "none "
chk "这一轮本身认得是调度器起的（写了日志）" "$(log_has '没有 LABEL_PENDING_BLOCKED')" 1
unset TMUX_ENV_LOG

echo "【10c】经真实调度入口 poll-entry.sh：写日志，不开 issue"
fresh 'CONFIG_NOTICE_ISSUE=true'
: > "$CALLS"
env -u CODING_AGENT_RELEASE_ROOT CAVIL_DEPLOY_CONF="$SANDBOX/no-deploy.conf" CAVIL_DEPLOY_ROOT="$SANDBOX/no-deploy" \
    CODING_AGENT_CONFIG="$CONF" PATH="$SANDBOX/bin:$PATH" bash "$NEW/scripts/poll-entry.sh" >/dev/null 2>&1
chk "日志一行、零创建、零提示 issue 调用" "$(log_has '没有 LABEL_PENDING_BLOCKED')/$(creates)/$(notice_calls)" "1/0/0"

echo "【11】和改动前逐条一致：配置都写全的项目；缺项的项目对改动前只写日志的跑法"
same_calls() {   # <描述> <改动前那份的配置行> <当前这份的配置行>
    local what="$1" old_line="$2" new_line="$3"
    if ! compat_skip "$what" "$OLD" "$NEW" scripts; then
        fresh "$old_line"; ticks_calls "$OLD" > "$SANDBOX/old.calls"
        fresh "$new_line"; ticks_calls "$NEW" > "$SANDBOX/new.calls"
        chk "$what：两轮合计 GitHub 调用逐条一致" "$(diff "$SANDBOX/old.calls" "$SANDBOX/new.calls" >/dev/null && echo same || echo diff)" same
        chk "$what：确实发过调用（不是早退）" "$([ -s "$SANDBOX/new.calls" ] && echo yes || echo no)" yes
    fi
}
same_calls "配置全写了" 'LABEL_PENDING_BLOCKED=""' 'LABEL_PENDING_BLOCKED=""'
same_calls "缺一项（改动前只写日志 / 当前写着开 issue 的老开关）" 'CONFIG_NOTICE_ISSUE=false' 'CONFIG_NOTICE_ISSUE=true'
chk "缺一项：当前这份确实写了日志" "$(log_has '没有 LABEL_PENDING_BLOCKED')" 1

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
chk "跑过一轮：列出缺项" "$(printf '%s\n' "$out" | sed -n '/^{/,/^}/p' | jq -c .)" '{"logged":["LABEL_PENDING_BLOCKED"]}'
chk "跑过一轮：日志里那一行也列出来" "$(grep -c '配置提示：本项目配置里没有 LABEL_PENDING_BLOCKED' <<<"$out")" 1
conf_set 'LABEL_PENDING_BLOCKED=""'
tick
out=$(run_ops)
chk "补上配置后：缺项清空" "$(printf '%s\n' "$out" | sed -n '/^{/,/^}/p' | jq -c .)" '{"logged":[]}'
echo '{"issue":7,"logged":[],"issued":["LABEL_PENDING_BLOCKED"]}' > "$W/state/config-notice.json"
tick
out=$(run_ops)
chk "早先版本写下的 issue / issued：下一轮调度轮询后不见了" "$(printf '%s\n' "$out" | sed -n '/^{/,/^}/p' | jq -c .)" '{"logged":[]}'

echo "【开关写法】模板里的 true / false 不带引号，提示里照抄的那一行也不带（GitHub#403）"
chk "模板里没有带引号的 true / false 赋值" "$(grep -cE '^[A-Z_]+="(true|false)"' "$REPO_DIR/cavil-loop.config.example" || true)" 0
fresh 'LABEL_PENDING_BLOCKED=""'
sed -i '/^ENABLE_USAGE_LIMIT_PAUSE=/d' "$CONF"
tick
chk "恰好缺用量上限这一项：只记它、零创建" "$(nst '.logged')/$(creates)" '["ENABLE_USAGE_LIMIT_PAUSE"]/0'
chk "轮询日志里要照抄的那一行不带引号" "$(log_has '里加 ENABLE_USAGE_LIMIT_PAUSE=true；')/$(log_has 'ENABLE_USAGE_LIMIT_PAUSE="true"')" "1/0"
# 老配置里带引号的写法照样算「已经写了」：补上之后缺项清空
conf_set 'ENABLE_USAGE_LIMIT_PAUSE="true"'
tick
chk "配置里写带引号的旧写法：照样认，缺项清空" "$(nst '.logged')" '[]'

echo
echo "结果：$pass 通过 / $fail 失败"
compat_summary
report_counts "$pass" "$fail"
[ "$fail" -eq 0 ]
