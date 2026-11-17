#!/usr/bin/env bash
# kind: e2e
# 流程标签改名（GitHub#569）：真实 scripts/label-rename.sh、project-config.sh、agent-poll.sh、dispatch-new-issue.sh
# 跑在常驻假 GitHub（tests/lib/fake_github.py：label_ids.json 是仓库的标签和编号，PATCH labels/<名字> 改名，
# 挂着它的条目跟着换；Fhold_patch_label 让请求没回音、先不生效，release_held 之后再生效）上。
#
#   1. 检查：每一项各有一个被拦下的用例；读不全标签列表是「读不了」，不是「没被占用」
#   2. 改名全程：GitHub、配置都换成新名字；暂停期间一轮轮询一个 GitHub 请求都不发；收尾后挂着新名字的条目照常派工
#   3. GitHub 明确拒绝：什么都没改、暂停记录删掉
#   4. 没回音：本项目一直暂停、不能退回；请求之后生效 → 再查一次接着做完，进入「每轮核对标签」；
#      核对期间迟到的请求把名字改掉 → 下一轮整轮不做（不派工）
#   5. 配置那一步没写成：停在「配置」，暂停中；修好后 continue 做完
#   6. 先读配置、后拿锁：轮询读完配置、拿锁之前配置被换掉（假 flock 在那一刻改配置）→ 拿到锁后整轮不做
#   7. 手动跑的派工：改名进行中 → 不动手；轮询锁被占 → 等不到就不动手；都没有 → 照常派工
#   8. 另一台机器跟进：只改那台配置、不发 GitHub 写请求；编号对不上 / 旧名还在 → 拦下
#   9. project-config.sh：get 带上每个流程标签能不能改名和改名状态；没有对得上的改名记录时 set --label-rename 拒绝
#
#   bash tests/label-rename.test.sh      （约 1 分钟）
set -uo pipefail
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
SANDBOX=$(mktemp -d)
trap '[ -n "${KEEP_SANDBOX:-}" ] && echo "SANDBOX=$SANDBOX" || rm -rf "$SANDBOX"' EXIT
mkdir -p "$SANDBOX/bin" "$SANDBOX/home/.config/cavil-loop"
export HOME="$SANDBOX/home"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 TZ=UTC
unset CODING_AGENT_RELEASE_ROOT LABEL_AUTOPILOT LABEL_PENDING_BLOCKED LABEL_PENDING_LATER STUCK_WORKER_QUIET_SECS GH_TOKEN WRITE_GH_TOKEN GITHUB_TOKEN POLL_FAKE_NOW
unset DISPATCH_AUTOPILOT DISPATCH_AUTOPILOT_ISSUE DISPATCH_AUTOPILOT_PR CAVIL_SCHEDULED_POLL CAVIL_POLL_LOCK_HELD CAVIL_POLL_LOCK_GATE CODING_AGENT_CONFIG
export FAKE_GH_LISTS=1 FAKE_GH_REPO="example/lr"

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
# 假 flock：轮询拿锁（-n 9）的那一刻先跑一次 $FLOCK_HOOK（只跑一次），再交给真的 flock——
# 模拟「轮询读完配置、还没拿到锁」时别处把配置换掉
REAL_FLOCK="$(command -v flock)"
cat > "$SANDBOX/bin/flock" <<SH
#!/usr/bin/env bash
if [ "\$1" = -n ] && [ "\$2" = 9 ] && [ -n "\${FLOCK_HOOK:-}" ] && [ -f "\$FLOCK_HOOK" ]; then
    bash "\$FLOCK_HOOK"; rm -f "\$FLOCK_HOOK"
fi
exec "$REAL_FLOCK" "\$@"
SH
# 假 systemctl：项目的轮询任务状态从 $SANDBOX/sched 读（active / inactive / 别的词 = 读不到）；文件不在 = 停着
cat > "$SANDBOX/bin/systemctl" <<SH
#!/usr/bin/env bash
case " \$* " in
    *" show "*) if [ -f "$SANDBOX/sched" ]; then cat "$SANDBOX/sched"; else echo inactive; fi ;;
    *" is-enabled "*) echo enabled ;;
esac
exit 0
SH
chmod +x "$SANDBOX/bin/gh" "$SANDBOX/bin/tmux" "$SANDBOX/bin/claude" "$SANDBOX/bin/flock" "$SANDBOX/bin/systemctl"

pass=0; fail=0
chk() {
    if [ "$2" = "$3" ]; then echo "  ✅ $1"; pass=$((pass+1))
    else echo "  ❌ $1 (期望 [$3]，实得 [$2])"; fail=$((fail+1)); fi
}

git init -q --bare -b main "$SANDBOX/origin.git"
git clone -q "$SANDBOX/origin.git" "$SANDBOX/seed" 2>/dev/null
(cd "$SANDBOX/seed" && git -c user.email=t@x -c user.name=t commit -q --allow-empty -m init && git push -q origin HEAD:main) >/dev/null 2>&1
ROOT="$SANDBOX/skill"; mkdir -p "$ROOT"; cp -r "$REPO_DIR/scripts" "$REPO_DIR/prompts" "$ROOT/"
S="$ROOT/scripts"
GD="$SANDBOX/gh"
I_HUMAN=988101; I_AGENT=988102; I_DOING=988103

mkconf() {   # <名字> → 建一个项目：配置、登记、状态目录
    local k="$1" W="$SANDBOX/$1"
    rm -rf "$W"; mkdir -p "$W/state" "$W/wt"
    git clone -q "$SANDBOX/origin.git" "$W/project" 2>/dev/null
    cat > "$W/cavil-loop.config" <<CONF
REPO="example/lr"
PROJECT_ROOT="$W/project"
WORKTREE_BASE="$W/wt"
STATE_DIR="$W/state"
TMUX_PREFIX="$k"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
LABEL_PENDING_PR="pending/PR"
LABEL_AGENT_DOING="doing/agent"
LABEL_DONE="Done"
DISPATCH_MODE="greedy"
POST_MERGE_RETROSPECTIVE=false
PENDING_HUMAN_CONFLICT_CHECK=false
POLL_BACKOFF_LADDER=""
PRICE_AUTO_FETCH=0
AGENT_TRUST_PROMPT_WAIT_SECS=1
WORKER_SECRET_ENV=""
PATH="$SANDBOX/bin:\$PATH"
GH_TOKEN="fake-token-for-test"
CONF
    chmod 600 "$W/cavil-loop.config"
    printf 'PROJECT_ROOT=%s\nCODING_AGENT_CONFIG=%s\n' "$W/project" "$W/cavil-loop.config" > "$HOME/.config/cavil-loop/$k.conf"
}
world() {   # 假 GitHub：三条 issue（等人 / 排队 / 无标签），仓库标签带编号
    rm -rf "$GD"; mkdir -p "$GD"
    export FAKE_GH_DIR="$GD"
    : > "$GD/filter_labels"
    python3 - "$GD" "$I_HUMAN" "$I_AGENT" <<'PY'
import json, sys
d, h, a = sys.argv[1:]
it = lambda t: {"kind": "issue", "state": "open", "title": t, "body": "", "user": {"login": "someone"},
                "updated_at": "2026-01-01T00:00:00Z", "created_at": "2026-01-01T00:00:00Z"}
json.dump({h: it("waits for human"), a: it("queued")}, open(d + "/items.json", "w"))
json.dump({h: ["pending/human"], a: []}, open(d + "/labels.json", "w"))
json.dump({"pending/agent": 101, "pending/human": 102, "doing/agent": 103, "pending/PR": 104, "Done": 105,
           "pending/blocked": 106, "pending/later": 107}, open(d + "/label_ids.json", "w"))
PY
}
release_held() {   # 让被扣住的改名请求现在生效（迟到）
    python3 - "$GD" <<'PY'
import json, os, sys
d = sys.argv[1]
held = json.load(open(d + "/held_patch.json")) if os.path.exists(d + "/held_patch.json") else []
ids = json.load(open(d + "/label_ids.json")); lb = json.load(open(d + "/labels.json"))
for h in held:
    if h["from"] in ids and not any(n.lower() == h["to"].lower() for n in ids):
        ids[h["to"]] = ids.pop(h["from"])
        for n in lb: lb[n] = [h["to"] if l == h["from"] else l for l in lb[n]]
json.dump(ids, open(d + "/label_ids.json", "w")); json.dump(lb, open(d + "/labels.json", "w"))
os.remove(d + "/held_patch.json") if held else None
PY
}
lbl_name() { jq -r --argjson id "$1" 'to_entries[] | select(.value == $id) | .key' "$GD/label_ids.json"; }
item_labels() { jq -r --arg n "$1" '.[$n] | join(",")' "$GD/labels.json"; }
conf_val() { sed -n "s/^$2=//p" "$SANDBOX/$1/cavil-loop.config" | tr -d '"'; }
rn() { bash "$S/label-rename.sh" "$@" 2>&1; }
res() { printf '%s\n' "$1" | sed -n 's/^RESULT=//p' | tail -1; }
line() { printf '%s\n' "$1" | sed -n "s/^$2=//p" | tail -1; }
failed_checks() { printf '%s\n' "$1" | sed -n 's/^DETAIL=//p' | tail -1 | jq -r '[.checks[] | select(.ok != true) | .id] | join(",")'; }
rev_of() { bash "$S/project-config.sh" get "$1" | jq -r .rev; }
poll() {   # <项目> → 跑一轮真实轮询
    local W="$SANDBOX/$1"
    export FAKE_TMUX_LOG="$W/tmux.log"
    (cd "$W/project" && CODING_AGENT_CONFIG="$W/cavil-loop.config" bash "$S/agent-poll.sh") >/dev/null 2>&1
}
calls() { if [ -f "$GD/calls.log" ]; then grep -c . "$GD/calls.log"; else echo 0; fi; }
writes() { if [ -f "$GD/calls.log" ]; then grep -cE -- '-X (POST|PATCH|DELETE|PUT)|--method (POST|PATCH|DELETE|PUT)|issue edit|pr edit' "$GD/calls.log"; else echo 0; fi; }

mkconf lra
world

echo "1. 检查"
r="$(rn lra check --field LABEL_PENDING_HUMAN --from pending/human --to needs-human --others-stopped)"
chk "全部通过" "$(res "$r")/$(failed_checks "$r")" "ok/"
r="$(rn lra check --field LABEL_PENDING_HUMAN --from pending/human --to 'needs human' --others-stopped)"
chk "新名字有空格 → 拦下" "$(res "$r")/$(failed_checks "$r")" "refused/name"
r="$(rn lra check --field LABEL_PENDING_HUMAN --from pending/human --to done --others-stopped)"
chk "新名字和已有标签只差大小写 → 拦下（同时配置里「已完成」也叫 Done）" "$(res "$r")/$(failed_checks "$r")" "refused/other_settings,new_free"
r="$(rn lra check --field LABEL_PENDING_HUMAN --from pending/human --to Pending/Human --others-stopped)"
chk "只改大小写 → 拦下（复审第 1 轮）" "$(res "$r")/$(failed_checks "$r")" "refused/name,new_free"
r="$(rn lra check --field LABEL_PENDING_HUMAN --from pending/human --to needs-human)"
chk "没确认其他机器 → 拦下" "$(res "$r")/$(failed_checks "$r")" "refused/others_stopped"
r="$(rn lra check --field LABEL_PENDING_HUMAN --from pending/hum --to needs-human --others-stopped)"
chk "旧名字和配置对不上 → 拦下" "$(res "$r")/$(failed_checks "$r")" "refused/config_value,old_label"
r="$(rn lra check --field LABEL_PENDING_AGENT_EXTRA --from x --to y --others-stopped)"
chk "列表类设置不能改名" "$(res "$r")/$(failed_checks "$r")" "refused/field"
jq --arg n "$I_DOING" '. + {($n): {"kind":"issue","state":"open","title":"busy","body":"","user":{"login":"x"},"updated_at":"2026-01-01T00:00:00Z","created_at":"2026-01-01T00:00:00Z"}}' "$GD/items.json" > "$GD/i.tmp" && mv "$GD/i.tmp" "$GD/items.json"
jq --arg n "$I_DOING" '. + {($n): ["doing/agent"]}' "$GD/labels.json" > "$GD/l.tmp" && mv "$GD/l.tmp" "$GD/labels.json"
r="$(rn lra check --field LABEL_PENDING_HUMAN --from pending/human --to needs-human --others-stopped)"
chk "有条目挂着 doing/agent → 拦下" "$(res "$r")/$(failed_checks "$r")" "refused/no_worker"
r="$(rn lra check --field LABEL_PENDING_BLOCKED --from pending/blocked --to waits --others-stopped)"
chk "等前置这类按历史判断的标签：配置里没写这一行时不能改名（先写成单独一行）" "$(res "$r")/$(failed_checks "$r" | tr ',' '\n' | grep -c config_line)" "refused/1"
world
: > "$GD/F_labels"
r="$(rn lra check --field LABEL_PENDING_HUMAN --from pending/human --to needs-human --others-stopped)"
chk "读不全标签列表 → 读不了（null），不当成通过" "$(res "$r")/$(printf '%s\n' "$r" | sed -n 's/^DETAIL=//p' | jq -r '.checks[] | select(.id == "labels") | .ok')" "refused/null"
rm -f "$GD/F_labels"
printf 'GREEDY_SKIP_LABELS="foo,needs-human"\n' >> "$SANDBOX/lra/cavil-loop.config"
r="$(rn lra check --field LABEL_PENDING_HUMAN --from pending/human --to needs-human --others-stopped)"
chk "别的设置的列表里用到了新名字 → 拦下" "$(res "$r")/$(failed_checks "$r")" "refused/other_settings"
sed -i '/^GREEDY_SKIP_LABELS=/d' "$SANDBOX/lra/cavil-loop.config"

echo "2. 改名全程"
world; rm -f "$GD/calls.log"
REV="$(rev_of lra)"
r="$(rn lra rename --field LABEL_PENDING_HUMAN --from pending/human --to needs-human --rev "$REV" --others-stopped)"
chk "结果：等客户端" "$(res "$r")/$(line "$r" GITHUB)/$(line "$r" CONFIG)/$(line "$r" PAUSED)" "awaiting_client/new/new/yes"
chk "GitHub 上编号 102 改成了 needs-human" "$(lbl_name 102)" "needs-human"
chk "挂着它的条目跟着换" "$(item_labels "$I_HUMAN")" "needs-human"
chk "配置那一行改了" "$(conf_val lra LABEL_PENDING_HUMAN)" "needs-human"
chk "只发了一次 GitHub 写请求（改名）" "$(writes)" "1"
n0="$(calls)"
poll lra
chk "暂停期间一轮轮询：一个 GitHub 请求都没发" "$(( $(calls) - n0 ))" "0"
chk "暂停期间一轮轮询：日志写明在改名（这一轮确实开始了）" "$(grep -c '流程标签改名还没做完' "$SANDBOX/lra/state/poll.log")" "1"
r="$(rn lra finish)"
chk "finish 不写明客户端 → 拒绝" "$(res "$r")" "refused"
r="$(rn lra finish --no-client)"
chk "finish → done，暂停记录删掉、没有核对" "$(res "$r")/$(line "$r" PAUSED)/$(line "$r" WATCH)" "done/no/no"
# 收尾后：等人的条目（现在挂 needs-human）不被「开着的都派」派走；排队的那条照常派
poll lra
chk "收尾后：等人的条目仍被认出、没被派工" "$(item_labels "$I_HUMAN")" "needs-human"
chk "收尾后：另一条照常被派工" "$(item_labels "$I_AGENT")" "doing/agent"

echo "3. GitHub 明确拒绝"
mkconf lra; world; : > "$GD/F_patch_label"
r="$(rn lra rename --field LABEL_PENDING_HUMAN --from pending/human --to needs-human --rev "$(rev_of lra)" --others-stopped)"
chk "结果：refused，什么都没改，暂停记录删掉" "$(res "$r")/$(lbl_name 102)/$(conf_val lra LABEL_PENDING_HUMAN)/$(line "$r" PAUSED)" "refused/pending/human/pending/human/no"
rm -f "$GD/F_patch_label"

echo "4. 没回音"
mkconf lra; world; : > "$GD/Fhold_patch_label"
r="$(rn lra rename --field LABEL_PENDING_HUMAN --from pending/human --to needs-human --rev "$(rev_of lra)" --others-stopped)"
chk "结果：no_answer，暂停中，配置没动" "$(res "$r")/$(line "$r" PAUSED)/$(conf_val lra LABEL_PENDING_HUMAN)" "no_answer/yes/pending/human"
r="$(rn lra undo)"
chk "没回音后不能退回" "$(res "$r")/$(line "$r" PAUSED)" "refused/yes"
r="$(rn lra continue)"
chk "再查一次（还没生效）：仍是 no_answer，只读（没发写请求）" "$(res "$r")/$(writes)" "no_answer/1"
n0="$(calls)"; poll lra
chk "没回音期间轮询一个请求都不发" "$(( $(calls) - n0 ))" "0"
release_held
r="$(rn lra continue)"
chk "请求后来生效 → 再查一次接着改完配置" "$(res "$r")/$(conf_val lra LABEL_PENDING_HUMAN)" "awaiting_client/needs-human"
r="$(rn lra finish --client-saved)"
chk "收尾 → 进入每轮核对标签" "$(res "$r")/$(line "$r" WATCH)/$(jq -r '.label_id' "$SANDBOX/lra/state/label-watch.json")" "done/yes/102"
n0="$(calls)"; poll lra
chk "核对通过：这一轮照常跑（发了请求）" "$([ $(( $(calls) - n0 )) -gt 1 ] && echo yes)" "yes"
# 迟到：再把名字改回去（有一个请求被扣住，没回音），收尾后被扣住的请求又把名字改掉
rm -f "$GD/Fhold_patch_label"
python3 - "$GD" <<'PY'
import json, sys; d = sys.argv[1]
json.dump([{"from": "pending/human", "to": "needs-human"}], open(d + "/held_patch.json", "w"))
PY
# 上一轮把排队的那条派了出去（doing/agent）：当它已交回，不然改名会被「有 worker 在干活」拦下
jq --arg n "$I_AGENT" '.[$n] = []' "$GD/labels.json" > "$GD/l.tmp" && mv "$GD/l.tmp" "$GD/labels.json"
r="$(rn lra rename --field LABEL_PENDING_HUMAN --from needs-human --to pending/human --rev "$(rev_of lra)" --others-stopped)"
r2="$(rn lra finish --no-client)"
chk "改回旧名字做完；核对跟着换成新的名字" "$(res "$r")/$(res "$r2")/$(jq -r .name "$SANDBOX/lra/state/label-watch.json")" "awaiting_client/done/pending/human"
release_held
chk "迟到的请求生效：GitHub 上又叫 needs-human，配置是 pending/human" "$(lbl_name 102)/$(conf_val lra LABEL_PENDING_HUMAN)" "needs-human/pending/human"
jq --arg n "$I_AGENT" '.[$n] = []' "$GD/labels.json" > "$GD/l.tmp" && mv "$GD/l.tmp" "$GD/labels.json"
w0="$(writes)"; poll lra
chk "下一轮整轮不做：没有写请求" "$(( $(writes) - w0 ))" "0"
chk "日志写明标签核对没过" "$(grep -c '标签核对：GitHub 上编号 102' "$SANDBOX/lra/state/poll.log")" "1"
r="$(rn lra watch-end)"
chk "watch-end 结束核对" "$(res "$r")/$(line "$r" WATCH)" "done/no"

echo "4b. 一个标签还在核对时，另一个标签不改名（复审第 2 轮：核对记录只记一个标签，不能被覆盖）"
mkconf lra; world; : > "$GD/Fhold_patch_label"
rn lra rename --field LABEL_PENDING_HUMAN --from pending/human --to needs-human --rev "$(rev_of lra)" --others-stopped >/dev/null
rm -f "$GD/Fhold_patch_label"; release_held
rn lra continue >/dev/null; rn lra finish --no-client >/dev/null
chk "标签 A（编号 102）没回音后做完：在核对" "$(jq -r .label_id "$SANDBOX/lra/state/label-watch.json")" "102"
r="$(rn lra check --field LABEL_DONE --from Done --to Shipped --others-stopped)"
chk "标签 B（已完成）改名被拦下，写明先结束 A 的核对" "$(res "$r")/$(failed_checks "$r")" "refused/watch"
w0="$(writes)"
r="$(rn lra rename --field LABEL_DONE --from Done --to Shipped --rev "$(rev_of lra)" --others-stopped)"
chk "直接改名同样被拦下：没有 GitHub 写请求、配置不动、A 的核对还在" "$(res "$r")/$(( $(writes) - w0 ))/$(conf_val lra LABEL_DONE)/$(jq -r .label_id "$SANDBOX/lra/state/label-watch.json")" "refused/0/Done/102"
r="$(rn lra check --field LABEL_PENDING_HUMAN --from needs-human --to waits-human --others-stopped)"
chk "同一个标签 A 可以再改名（核对跟着换名字）" "$(res "$r")" "ok"
rn lra watch-end >/dev/null
r="$(rn lra check --field LABEL_DONE --from Done --to Shipped --others-stopped)"
chk "结束 A 的核对后，B 可以改名" "$(res "$r")" "ok"
echo '{"label_id":' > "$SANDBOX/lra/state/label-watch.json"
r="$(rn lra check --field LABEL_DONE --from Done --to Shipped --others-stopped)"
chk "核对记录读不了 → 判断不了（null），不放行" "$(res "$r")/$(printf '%s\n' "$r" | sed -n 's/^DETAIL=//p' | jq -r '.checks[] | select(.id == "watch") | .ok')" "refused/null"

echo "5. 配置那一步没写成"
mkconf lra; world
chmod 500 "$SANDBOX/lra"
r="$(rn lra rename --field LABEL_PENDING_HUMAN --from pending/human --to needs-human --rev "$(rev_of lra)" --others-stopped)"
chk "GitHub 改了、配置没改 → partial，停在配置这一步、暂停中" "$(res "$r")/$(line "$r" GITHUB)/$(line "$r" CONFIG)/$(line "$r" STEP)/$(line "$r" PAUSED)" "partial/new/old/config/yes"
chmod 700 "$SANDBOX/lra"
r="$(rn lra continue)"
chk "修好后 continue：配置改成、等客户端" "$(res "$r")/$(conf_val lra LABEL_PENDING_HUMAN)" "awaiting_client/needs-human"
rn lra finish --no-client >/dev/null

echo "6. 先读配置、后拿锁：人在编辑器里改主配置"
mkconf lra; world
cat > "$SANDBOX/hook.sh" <<SH
sed -i 's/^LABEL_DONE=.*/LABEL_DONE="Finished"/' "$SANDBOX/lra/cavil-loop.config"
SH
n0="$(calls)"
FLOCK_HOOK="$SANDBOX/hook.sh" poll lra
chk "拿到锁后发现配置被换过：整轮不做（没有 GitHub 请求）" "$(( $(calls) - n0 ))" "0"
chk "日志写明配置在加载之后被改过" "$(grep -c '在本进程加载之后被改过或读不了' "$SANDBOX/lra/state/poll.log")" "1"
n0="$(calls)"; poll lra
chk "下一轮用新配置照常跑" "$([ $(( $(calls) - n0 )) -gt 1 ] && echo yes)" "yes"

echo "6a. 先读配置、后拿锁：本工具自己的保存（项目配置窗口走的就是它）"
mkconf lra; world
cat > "$SANDBOX/hook.sh" <<SH
rev="\$(bash "$S/project-config.sh" get lra | jq -r .rev)"
printf '{"MAX_CONCURRENT_WORKERS":"2"}' | bash "$S/project-config.sh" set lra --rev "\$rev" >/dev/null 2>&1
SH
n0="$(calls)"
FLOCK_HOOK="$SANDBOX/hook.sh" poll lra
chk "整轮不做、日志写明" "$(( $(calls) - n0 ))/$(grep -c '在本进程加载之后被改过或读不了' "$SANDBOX/lra/state/poll.log")" "0/1"

echo "6b. 配置用 \${BASH_SOURCE[0]} 找邻近文件（复审第 3 轮：加载时不能换掉配置的路径）"
mkconf lra; world
sed -i '/^DISPATCH_MODE=/d' "$SANDBOX/lra/cavil-loop.config"
printf 'DISPATCH_MODE="greedy"\n' > "$SANDBOX/lra/extra.conf"
printf 'source "$(dirname "${BASH_SOURCE[0]}")/extra.conf"\n' >> "$SANDBOX/lra/cavil-loop.config"
n0="$(calls)"; poll lra
chk "照常跑完一轮：等人的不派、排队的那条被派（邻近文件里的「开着的都派」生效）" "$(item_labels "$I_HUMAN")/$(item_labels "$I_AGENT")" "pending/human/doing/agent"
chk "日志里没有闸门拦下的记录" "$(grep -c '这一次不动手' "$SANDBOX/lra/state/poll.log" || true)" "0"
r="$(rn lra check --field LABEL_PENDING_HUMAN --from pending/human --to needs-human --others-stopped)"
chk "改名检查照常（只有 doing/agent 那一项因为刚派出去被拦下）" "$(res "$r")/$(failed_checks "$r")" "refused/no_worker"

echo "6c. 邻近文件里的标签名在读完配置、拿锁之前被改（复审第 4 轮）"
mkconf lra; world
sed -i '/^LABEL_PENDING_HUMAN=/d' "$SANDBOX/lra/cavil-loop.config"
printf 'LABEL_PENDING_HUMAN="pending/human"\n' > "$SANDBOX/lra/extra.conf"
printf 'source "$(dirname "${BASH_SOURCE[0]}")/extra.conf"\n' >> "$SANDBOX/lra/cavil-loop.config"
# 人在这一刻把邻近文件和 GitHub 一起改成 needs-human（主配置一个字节都没变）
cat > "$SANDBOX/hook.sh" <<SH
printf 'LABEL_PENDING_HUMAN="needs-human"\\n' > "$SANDBOX/lra/extra.conf"
python3 - "$GD" <<'PY2'
import json, sys
d = sys.argv[1]
ids = json.load(open(d + "/label_ids.json")); ids["needs-human"] = ids.pop("pending/human"); json.dump(ids, open(d + "/label_ids.json", "w"))
lb = json.load(open(d + "/labels.json"))
for n in lb: lb[n] = ["needs-human" if l == "pending/human" else l for l in lb[n]]
json.dump(lb, open(d + "/labels.json", "w"))
PY2
SH
n0="$(calls)"
FLOCK_HOOK="$SANDBOX/hook.sh" poll lra
chk "这一轮整轮不做：没有 GitHub 请求，等人的条目没被派工" "$(( $(calls) - n0 ))/$(item_labels "$I_HUMAN")" "0/needs-human"
chk "日志写明标签名在加载之后被改过" "$(grep -c '在本进程加载之后被改过或读不了' "$SANDBOX/lra/state/poll.log")" "1"
poll lra
chk "下一轮用新值：等人的条目（needs-human）仍不派、排队的那条照常派" "$(item_labels "$I_HUMAN")/$(item_labels "$I_AGENT")" "needs-human/doing/agent"

echo "6d. 只读的标签变量、配置里带命令（复审第 5 轮）：闸门不重新执行配置，照常放行"
mkconf lra; world
sed -i 's/^LABEL_PENDING_HUMAN=.*/readonly LABEL_PENDING_HUMAN="pending\/human"/; s/^DISPATCH_MODE=.*/DISPATCH_MODE="label"/' "$SANDBOX/lra/cavil-loop.config"
printf 'echo loaded >> "%s/side.log"\n' "$SANDBOX/lra" >> "$SANDBOX/lra/cavil-loop.config"
rm -f "$SANDBOX/lra/side.log"
n0="$(calls)"; poll lra
chk "这一轮照常跑完（发了 GitHub 请求，日志里没有闸门拦下）" "$([ $(( $(calls) - n0 )) -gt 1 ] && echo yes)/$(grep -c '这一次不动手' "$SANDBOX/lra/state/poll.log" || true)" "yes/0"
chk "配置里的命令一轮只执行一次（没有派工时只有轮询自己加载一次）" "$(wc -l < "$SANDBOX/lra/side.log")" "1"

echo "6e. 邻近文件在读完配置、拿锁之前变得读不了：不动手"
mkconf lra; world
printf 'DISPATCH_MODE="label"\n' > "$SANDBOX/lra/extra.conf"
printf 'source "$(dirname "${BASH_SOURCE[0]}")/extra.conf"\n' >> "$SANDBOX/lra/cavil-loop.config"
cat > "$SANDBOX/hook.sh" <<SH
chmod 000 "$SANDBOX/lra/extra.conf"
SH
n0="$(calls)"
FLOCK_HOOK="$SANDBOX/hook.sh" poll lra
chk "整轮不做、日志写明" "$(( $(calls) - n0 ))/$(grep -c '在本进程加载之后被改过或读不了' "$SANDBOX/lra/state/poll.log")" "0/1"
chmod 644 "$SANDBOX/lra/extra.conf"
n0="$(calls)"; poll lra
chk "恢复可读后下一轮照常跑" "$([ $(( $(calls) - n0 )) -gt 1 ] && echo yes)" "yes"

echo "6f. 加载期间（bash 已读入旧内容、加载还没结束）主配置被原子替换（复审：指纹要对得上实际读到的版本）"
mkconf lra; world
sed 's/^LABEL_PENDING_HUMAN=.*/LABEL_PENDING_HUMAN="needs-human"/' "$SANDBOX/lra/cavil-loop.config" > "$SANDBOX/lra/new.config"
# 旧配置最后一行在加载中把文件换掉（模拟编辑器 / 本工具在这一刻保存）
printf 'mv -f "%s/new.config" "%s/cavil-loop.config"\n' "$SANDBOX/lra" "$SANDBOX/lra" >> "$SANDBOX/lra/cavil-loop.config"
n0="$(calls)"; poll lra
chk "这一轮整轮不做、日志写明加载期间被改过" "$(( $(calls) - n0 ))/$(grep -c '在本进程加载期间被改过' "$SANDBOX/lra/state/poll.log")" "0/1"
chk "主配置已是新内容" "$(grep -c '^LABEL_PENDING_HUMAN="needs-human"' "$SANDBOX/lra/cavil-loop.config")" "1"
n0="$(calls)"; poll lra
chk "下一轮用新配置照常跑" "$([ $(( $(calls) - n0 )) -gt 1 ] && echo yes)" "yes"

echo "6g. 加载期间被 source 的邻近文件被原子替换"
mkconf lra; world
printf 'LABEL_PENDING_HUMAN="pending/human"\n' > "$SANDBOX/lra/extra.conf"
printf 'LABEL_PENDING_HUMAN="needs-human"\n' > "$SANDBOX/lra/extra.new"
sed -i '/^LABEL_PENDING_HUMAN=/d' "$SANDBOX/lra/cavil-loop.config"
printf 'source "$(dirname "${BASH_SOURCE[0]}")/extra.conf"\nmv -f "%s/extra.new" "%s/extra.conf"\n' "$SANDBOX/lra" "$SANDBOX/lra" >> "$SANDBOX/lra/cavil-loop.config"
n0="$(calls)"; poll lra
chk "这一轮整轮不做、日志写明加载期间被改过" "$(( $(calls) - n0 ))/$(grep -c '在本进程加载期间被改过' "$SANDBOX/lra/state/poll.log")" "0/1"
sed -i '/extra.new/d' "$SANDBOX/lra/cavil-loop.config"
n0="$(calls)"; poll lra
chk "去掉换文件那一行后下一轮照常跑（只读、命令只执行一次的 6d 仍在）" "$([ $(( $(calls) - n0 )) -gt 1 ] && echo yes)" "yes"

echo "7. 手动跑的派工"
mkconf lra; world
jq --arg n "$I_AGENT" '.[$n] = ["pending/agent"]' "$GD/labels.json" > "$GD/l.tmp" && mv "$GD/l.tmp" "$GD/labels.json"
echo '{"mode":"rename","field":"LABEL_PENDING_HUMAN","from":"pending/human","to":"needs-human","label_id":102,"step":"client","sent":true,"unanswered":false}' > "$SANDBOX/lra/state/label-rename.json"
w0="$(writes)"
(cd "$SANDBOX/lra/project" && FAKE_TMUX_LOG="$SANDBOX/lra/tmux.log" CODING_AGENT_CONFIG="$SANDBOX/lra/cavil-loop.config" bash "$S/dispatch-new-issue.sh" "$I_AGENT" >/dev/null 2>&1); rc=$?
chk "改名进行中：手动派工不动手（退出 75、没有写请求）" "$rc/$(( $(writes) - w0 ))" "75/0"
rm -f "$SANDBOX/lra/state/label-rename.json"
"$REAL_FLOCK" "$SANDBOX/lra/state/poll.lock" sleep 6 & HOLDER=$!
sleep 0.5
(cd "$SANDBOX/lra/project" && POLL_LOCK_REEXEC_WAIT_SECS=1 FAKE_TMUX_LOG="$SANDBOX/lra/tmux.log" CODING_AGENT_CONFIG="$SANDBOX/lra/cavil-loop.config" bash "$S/dispatch-new-issue.sh" "$I_AGENT" >/dev/null 2>&1); rc=$?
chk "轮询锁被占：等不到就不动手" "$rc/$(( $(writes) - w0 ))" "75/0"
kill "$HOLDER" 2>/dev/null; wait "$HOLDER" 2>/dev/null
(cd "$SANDBOX/lra/project" && FAKE_TMUX_LOG="$SANDBOX/lra/tmux.log" CODING_AGENT_CONFIG="$SANDBOX/lra/cavil-loop.config" bash "$S/dispatch-new-issue.sh" "$I_AGENT" >/dev/null 2>&1); rc=$?
chk "都没有：手动派工照常（翻成 doing/agent）" "$rc/$(item_labels "$I_AGENT")" "0/doing/agent"
chk "派工起的 worker 会话不带着轮询锁（锁现在拿得到）" "$("$REAL_FLOCK" -n "$SANDBOX/lra/state/poll.lock" true && echo free)" "free"

echo "7b. 被 source 的邻近文件看到的位置参数、declare 的作用域和直接 source 一样（复审：不能给 source 套函数）"
mkconf lra; world
jq --arg n "$I_AGENT" '.[$n] = ["pending/agent"]' "$GD/labels.json" > "$GD/l.tmp" && mv "$GD/l.tmp" "$GD/labels.json"
rm -f "$SANDBOX/lra/args.log"
printf 'printf "%%s\\n" "arg=${1-unset}" >> "%s/args.log"\ndeclare SRC_DECL=x\n' "$SANDBOX/lra" > "$SANDBOX/lra/extra.conf"
printf 'source "$(dirname "${BASH_SOURCE[0]}")/extra.conf"\n[ "${SRC_DECL-}" = x ] || echo "decl=lost" >> "%s/args.log"\n' "$SANDBOX/lra" >> "$SANDBOX/lra/cavil-loop.config"
(cd "$SANDBOX/lra/project" && FAKE_TMUX_LOG="$SANDBOX/lra/tmux.log" CODING_AGENT_CONFIG="$SANDBOX/lra/cavil-loop.config" bash "$S/dispatch-new-issue.sh" "$I_AGENT" >/dev/null 2>&1); rc=$?
chk "手动派工照常（翻成 doing/agent）" "$rc/$(item_labels "$I_AGENT")" "0/doing/agent"
chk "邻近文件每次加载看到的 \$1 都是派工脚本收到的编号，declare 的变量留在全局" "$(sort -u "$SANDBOX/lra/args.log" | tr '\n' ' ')" "arg=$I_AGENT "

echo "8. 另一台机器跟进"
mkconf lra; mkconf lrb; world
r="$(rn lra rename --field LABEL_PENDING_HUMAN --from pending/human --to needs-human --rev "$(rev_of lra)" --others-stopped)"
rn lra finish --no-client >/dev/null
LID="$(line "$r" LABEL_ID)"
chk "第一台改名的标签编号" "$LID" "102"
r="$(rn lrb check --follow --field LABEL_PENDING_HUMAN --from pending/human --to needs-human --label-id 999)"
chk "编号对不上（另建的同名标签）→ 拦下" "$(res "$r")/$(failed_checks "$r")" "refused/followed"
echo active > "$SANDBOX/sched"
r="$(rn lrb follow --field LABEL_PENDING_HUMAN --from pending/human --to needs-human --label-id "$LID" --rev "$(rev_of lrb)")"
chk "那台的轮询还在跑 → 跟进拦下、配置不动（复审第 1 轮）" "$(res "$r")/$(failed_checks "$r")/$(conf_val lrb LABEL_PENDING_HUMAN)" "refused/poller_stopped/pending/human"
echo activating-weird > "$SANDBOX/sched"
r="$(rn lrb check --follow --field LABEL_PENDING_HUMAN --from pending/human --to needs-human --label-id "$LID")"
chk "那台的轮询状态读不到 → 判断不了（null），不放行" "$(res "$r")/$(printf '%s\n' "$r" | sed -n 's/^DETAIL=//p' | jq -r '.checks[] | select(.id == "poller_stopped") | .ok')" "refused/null"
echo inactive > "$SANDBOX/sched"
w0="$(writes)"
r="$(rn lrb follow --field LABEL_PENDING_HUMAN --from pending/human --to needs-human --label-id "$LID" --rev "$(rev_of lrb)")"
chk "跟进：只改那台配置" "$(res "$r")/$(conf_val lrb LABEL_PENDING_HUMAN)" "awaiting_client/needs-human"
chk "跟进不发 GitHub 写请求" "$(( $(writes) - w0 ))" "0"
r="$(rn lrb finish --no-client)"
chk "跟进收尾" "$(res "$r")/$(line "$r" PAUSED)" "done/no"
mkconf lrb
python3 - "$GD" <<'PY'
import json, sys; d = sys.argv[1]; ids = json.load(open(d + "/label_ids.json")); ids["pending/human"] = 999
json.dump(ids, open(d + "/label_ids.json", "w"))
PY
r="$(rn lrb check --follow --field LABEL_PENDING_HUMAN --from pending/human --to needs-human --label-id "$LID")"
chk "旧名字还在（有人又建了一个）→ 拦下" "$(res "$r")/$(failed_checks "$r")" "refused/old_gone"

echo "9. project-config.sh"
mkconf lra; world
g="$(bash "$S/project-config.sh" get lra)"
chk "get：等人可以改名" "$(printf '%s' "$g" | jq -r '.fields[] | select(.name == "LABEL_PENDING_HUMAN") | .rename.ok')" "true"
chk "get：等前置（配置里没写这一行）不能改名，并写明原因" "$(printf '%s' "$g" | jq -r '.fields[] | select(.name == "LABEL_PENDING_BLOCKED") | [.rename.ok, (.rename.reason != null)] | map(tostring) | join("/")')" "false/true"
chk "get：没有列表类设置的改名信息" "$(printf '%s' "$g" | jq -r '.fields[] | select(.name == "LABEL_PENDING_AGENT_EXTRA") | has("rename")')" "false"
chk "get：改名状态" "$(printf '%s' "$g" | jq -c '.label_rename')" '{"state":"ok","pending":null,"watch":null}'
r="$(printf '{"LABEL_PENDING_HUMAN":"x-human"}' | bash "$S/project-config.sh" set lra --rev "$(rev_of lra)" --label-rename 2>&1)"
chk "没有改名记录时 set --label-rename 拒绝、配置不动" "$(res "$r")/$(conf_val lra LABEL_PENDING_HUMAN)" "not_editable/pending/human"
r="$(printf '{"LABEL_PENDING_HUMAN":"x-human"}' | bash "$S/project-config.sh" set lra --rev "$(rev_of lra)" 2>&1)"
chk "普通保存仍改不了流程标签" "$(res "$r")" "not_editable"

echo "10. 文档里的命令照字面跑（docs/operations{,.zh}.md 的 label-rename-ops 两份相同）"
block() { sed -n '/<!-- label-rename-ops:begin -->/,/<!-- label-rename-ops:end -->/p' "$1" | sed '1,2d;$d' | sed '$d'; }
B_EN="$(block "$REPO_DIR/docs/operations.md")"; B_ZH="$(block "$REPO_DIR/docs/operations.zh.md")"
chk "两份命令相同、不为空" "$([ -n "$B_EN" ] && [ "$B_EN" = "$B_ZH" ] && echo same)" "same"
mkdir -p "$HOME/.agents/skills"; ln -sfn "$ROOT" "$HOME/.agents/skills/cavil-loop"
mkconf myproject; world
o="$(env -i HOME="$HOME" PATH="$SANDBOX/bin:$PATH" LANG=C.UTF-8 FAKE_GH_DIR="$GD" FAKE_GH_REPO="$FAKE_GH_REPO" FAKE_GH_LISTS=1 bash -c "$B_EN" 2>&1)"
chk "三行结果：ok / awaiting_client / done" "$(printf '%s\n' "$o" | tr '\n' ' ')" "RESULT=ok RESULT=awaiting_client RESULT=done "
chk "GitHub 和配置都换成了新名字" "$(lbl_name 102)/$(conf_val myproject LABEL_PENDING_HUMAN)" "needs-human/needs-human"

report_counts "$pass" "$fail"
echo "通过 $pass / 失败 $fail"
[ "$fail" = 0 ]
