#!/usr/bin/env bash
# 等外部需求机器人期间等待标签被提前摘掉时不自动续工；机器人的需求 + 托管的合并规则 —— GitHub#162。
#
# 跑法：bash tests/requester-bot-wait.test.sh              （默认不跑负对照）
#       MUTATION=1 bash tests/requester-bot-wait.test.sh   （连负对照一起跑：每份改坏的副本把整套场景重跑一遍）
# 依赖：bash、jq、python3、git。不碰网络：有状态的假 GitHub（tests/lib/fake_github.py）+ 假 tmux。
# 每一轮都真的起 agent-poll.sh 子进程；「派没派、接没接手」从轮询日志的派工队列行和假 GitHub 的状态里读。
#
# 现场（GigleTutor-Web#1455）：worker 挂上等待标签，机器人转达后 6 秒就摘掉、没有答复，没标签就捡的项目
# 当成「接着干」空派两轮。改动后三条自动续工的路都看 GitHub 的标签历史：最近一次挂上等待标签之后没人
# 打派工标签，就不续工。错了的方向都不报错：
#   · 某一条路没接上判断 → 那条路照样空转
#   · 看本机见没见过等待标签 → 两次轮询之间挂上又摘掉的漏拦
#   · 按位置 / 时间排先后 → 同一秒、跨页时判反
#   · 读不到当成「没等过」→ 读失败那一轮照样空转；读不到也被缓存 → 恢复后永远不续工
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
# shellcheck source=lib/mutation.sh
source "$TEST_DIR/lib/mutation.sh"

SANDBOX=$(mktemp -d)
trap '[ -n "${KEEP_SANDBOX:-}" ] && echo "SANDBOX=$SANDBOX" || rm -rf "$SANDBOX"' EXIT
mkdir -p "$SANDBOX/bin" "$SANDBOX/home"
export HOME="$SANDBOX/home"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
unset CODING_AGENT_RELEASE_ROOT CLAUDE_PLUGIN_ROOT CAVIL_DEPLOY_ROOT CAVIL_DEPLOY_CONF CODING_AGENT_CONFIG \
      LABEL_AUTOPILOT DISPATCH_AUTOPILOT DISPATCH_AUTOPILOT_ISSUE DISPATCH_AUTOPILOT_PR GH_TOKEN WRITE_GH_TOKEN GITHUB_TOKEN

printf '#!/usr/bin/env bash\nexec python3 %q "$@"\n' "$TEST_DIR/lib/fake_github.py" > "$SANDBOX/bin/gh"
cat > "$SANDBOX/bin/tmux" <<'SH'
#!/usr/bin/env bash
case "$1" in has-session) exit 1 ;; ls|list-sessions) exit 1 ;; esac
exit 0
SH
chmod +x "$SANDBOX/bin/gh" "$SANDBOX/bin/tmux"

pass=0; fail=0; QUIET=0
chk() {
    if [ "$2" = "$3" ]; then
        [ "$QUIET" = 1 ] || echo "  ✅ $1"; pass=$((pass+1))
    else
        [ "$QUIET" = 1 ] || echo "  ❌ $1 (期望 [$3]，实得 [$2])"; fail=$((fail+1))
    fi
}
section() { [ "$QUIET" = 1 ] || echo "$1"; }

H1=1111111111111111111111111111111111111111
REQ_ON=('LABEL_PENDING_REQUESTER_BOT="pending/req"' 'REQUESTER_BOT_ACCOUNT="req-bot"' 'REQUESTER_BOT_ALLOWED_ACTORS="loop-bot"' 'REQUESTER_BOT_ORIGIN_MARKER="<!-- by-req -->"')

run_scenarios() {
    local SCRIPTS="$1" W="$SANDBOX/run"
    export FAKE_GH_REPO="example/ap"
    local R="repos/example/ap"
    local CONF CALLS GD

    fresh() {   # [额外配置行…]
        rm -rf "$W"; mkdir -p "$W/state" "$W/wt" "$W/gh"
        git init -q "$W/project" 2>/dev/null
        GD="$W/gh"; export FAKE_GH_DIR="$GD"; CALLS="$GD/calls.log"
        CONF="$W/cavil-loop.config"
        cat > "$CONF" <<CONF
REPO="example/ap"
PROJECT_ROOT="$W/project"
WORKTREE_BASE="$W/wt"
STATE_DIR="$W/state"
TMUX_PREFIX="rwtest"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
LABEL_AGENT_DOING="doing/agent"
LABEL_PENDING_REVIEW="pending/review"
POST_MERGE_RETROSPECTIVE=false
AUTO_CLEANUP_ON_MERGE=false
PENDING_HUMAN_CONFLICT_CHECK=false
POLL_BACKOFF_LADDER=""
PRICE_AUTO_FETCH=0
MAX_CONCURRENT_WORKERS=0
PATH="$SANDBOX/bin:\$PATH"
GH_TOKEN="fake-token-for-test"
CONF
        local l; for l in "$@"; do printf '%s\n' "$l" >> "$CONF"; done
        EVN=0
        echo '{}' > "$GD/items.json"; echo '{}' > "$GD/labels.json"; echo '{}' > "$GD/events.json"
        echo '{}' > "$GD/comments.json"; echo '{"maint":"admin"}' > "$GD/perms.json"
        echo '{}' > "$GD/checks.json"; echo '{}' > "$GD/files.json"; echo loop-bot > "$GD/me"
    }
    jset() { local f="$GD/$1" e="$2"; shift 2; jq "$@" "$e" "$f" > "$f.tmp" && mv "$f.tmp" "$f"; }
    mkissue() {   # <n> <labels_csv> [作者]
        jset items.json '.[$n] = {kind:"issue", state:"open", title:"t", body:"需求\n\n<!-- by-req -->", user:{login:$a}, updated_at:"2026-01-01T00:00:00Z"}' \
            --arg n "$1" --arg a "${3:-req-bot}"
        jset labels.json '.[$n] = ($l | split(",") | map(select(. != "")))' --arg n "$1" --arg l "$2"
    }
    mkpr() {   # <n> <分支> <正文> <labels_csv>
        jset items.json '.[$n] = {kind:"pr", state:"open", merged:false, draft:false, title:"t", body:$b,
                user:{login:"loop-bot"}, updated_at:"2026-01-01T00:00:00Z", created_at:"2025-12-01T00:00:00Z",
                head:{sha:$h, ref:$r, repo:{full_name:"example/ap"}}, base:{ref:"main"}, mergeable:true, mergeable_state:"clean"}' \
            --arg n "$1" --arg r "$2" --arg b "$3" --arg h "$H1"
        jset labels.json '.[$n] = ($l | split(",") | map(select(. != "")))' --arg n "$1" --arg l "$4"
    }
    ev() {   # <n> <labeled|unlabeled> <标签> <操作人> [id]
        EVN=$((EVN + 1))
        jset events.json '.[$n] = ((.[$n] // []) + [{event:$e, label:{name:$l}, actor:{login:$a, type:"User"}, created_at:$c}
                                                     + (if $id == "" then {} elif $id == "null" then {id:null} else {id:($id|tonumber)} end)])' \
            --arg n "$1" --arg e "$2" --arg l "$3" --arg a "$4" --arg id "${5:-}" \
            --arg c "$(printf '2026-01-01T%02d:%02d:00Z' $((EVN / 60)) $((EVN % 60)))"
    }
    # 一次「worker 挂上等待标签、机器人没答复就摘掉」（GigleTutor-Web#1455 06:07:58 → 06:09:13）
    wait_cycle() { ev "$1" labeled pending/req loop-bot; ev "$1" unlabeled pending/req req-bot; }
    # 有人打派工标签、派工时 daemon 又摘掉（条目回到一个流程标签都没有）
    trigger_cycle() { ev "$1" labeled pending/agent "${2:-req-bot}"; ev "$1" unlabeled pending/agent loop-bot; }
    bump() { jset items.json '.[$n].updated_at = $u' --arg n "$1" --arg u "2026-02-0${2:-1}T00:00:00Z"; }

    tick() { : > "$CALLS"; : > "$W/state/poll.log" 2>/dev/null; env CODING_AGENT_CONFIG="$CONF" bash "$SCRIPTS/agent-poll.sh" >/dev/null 2>&1; }
    n_calls() { grep -cE -- "$1" "$CALLS" 2>/dev/null || true; }
    log_has() { grep -cF -- "$1" "$W/state/poll.log" 2>/dev/null || true; }
    queued() {   # <issue|PR> <n>：本轮派工队列里有没有它
        if grep -F "派工队列" "$W/state/poll.log" 2>/dev/null | grep -oE "(issue|PR)#[0-9]+\(" | grep -qxF "$1#$2("; then echo yes; else echo no; fi
    }
    has_label() { case ",$(jq -r --arg n "$1" '(.[$n] // []) | join(",")' "$GD/labels.json")," in *",$2,"*) echo yes ;; *) echo no ;; esac; }
    comments_with() { jq -r --arg n "$1" '(.[$n] // [])[].body' "$GD/comments.json" | grep -cF -- "$2" || true; }
    took_none() { if [ "$(has_label 8 pending/review)/$(comments_with 8 'autopilot-takeover pr=8')" = "yes/1" ]; then echo yes; else echo no; fi; }

    # ── 【1】没标签就捡（greedy）──
    section "【1】没标签就捡：等待标签被提前摘掉、之后没人打派工标签 → 不派；从没等过的照派"
    fresh "${REQ_ON[@]}" 'DISPATCH_MODE="greedy"'
    mkissue 50 ""; wait_cycle 50
    mkissue 51 ""
    tick
    chk "#50（挂上又被摘、没有派工标签）不进派工队列" "$(queued issue 50)" no
    chk "#50 日志写明原因" "$(log_has 'greedy：issue #50 不续工')" 1
    chk "到达性 · #51（从没等过）照常进派工队列" "$(queued issue 51)" yes
    chk "到达性 · 这一轮确实读了 #50 的标签记录" "$([ "$(n_calls "$R/issues/50/events")" -gt 0 ] && echo yes || echo no)" yes
    tick
    chk "第二轮没变化：照样现读 #50 的标签记录（结论不缓存）、仍不派、不重复记日志" \
        "$([ "$(n_calls "$R/issues/50/events")" -gt 0 ] && echo yes || echo no)/$(queued issue 50)/$(log_has 'greedy：issue #50 不续工')" "yes/no/0"
    chk "到达性 · 第二轮仍派 #51" "$(queued issue 51)" yes
    # 代码复审第 1 轮的两个反例：结论不能跨「同一秒的新标签事件」「标签配置变了」沿用
    # ① #51 刚判过放行，同一秒（条目 updated_at 不变）里又被挂上等待标签、又被提前摘掉
    wait_cycle 51
    jset events.json '.["51"] |= map(.created_at = "2026-01-01T00:00:00Z")'
    tick
    chk "同一秒新增一次等待交接、条目更新时间没变 → 不派（不沿用上一轮的放行）" "$(queued issue 51)" no
    # ② 只改本机配置的等待标签名，条目本身不变：#50 在新标签下从没等过
    printf '\nLABEL_PENDING_REQUESTER_BOT="pending/new"\n' >> "$CONF"
    tick
    chk "等待标签换了名字、条目没变 → 按新配置重判，#50 放行（不沿用旧标签下的拦住）" "$(queued issue 50)" yes
    # ③ 触发标签的配置变了：等待之后打过的 go/now 原来不算派工标签，配成追加的触发标签后就算
    fresh "${REQ_ON[@]}" 'DISPATCH_MODE="greedy"'
    mkissue 57 ""; wait_cycle 57; ev 57 labeled go/now maint; ev 57 unlabeled go/now loop-bot
    tick
    chk "等待之后只打过 go/now（还不是派工标签）→ 不派" "$(queued issue 57)" no
    printf '\nLABEL_PENDING_AGENT_EXTRA="go/now"\n' >> "$CONF"
    tick
    chk "把 go/now 配成派工标签、条目没变 → 按新配置重判，派" "$(queued issue 57)" yes

    section "【1b】跨轮：第 1 轮挂着等待标签（本来就挡），两轮之间被摘掉 → 第 2 轮不派；打了派工标签 → 派；第二次等待 → 又不派"
    fresh "${REQ_ON[@]}" 'DISPATCH_MODE="greedy"'
    mkissue 50 "pending/req"; ev 50 labeled pending/req loop-bot
    tick
    chk "第 1 轮：挂着等待标签 → 不派" "$(queued issue 50)" no
    jset labels.json '.["50"] = []'; ev 50 unlabeled pending/req req-bot; bump 50 1
    tick
    chk "第 2 轮：等待标签被摘、没有派工标签 → 不派" "$(queued issue 50)" no
    trigger_cycle 50; bump 50 2
    tick
    chk "第 3 轮：机器人贴回答复时打过 pending/agent → 续上" "$(queued issue 50)" yes
    wait_cycle 50; bump 50 3
    tick
    chk "第 4 轮：再次挂上又被提前摘掉 → 又不派" "$(queued issue 50)" no

    section "【1c】先后只按事件编号：同一秒、列表顺序和编号相反时也判对"
    fresh "${REQ_ON[@]}" 'DISPATCH_MODE="greedy"'
    # 派工标签排在列表前面、编号却更大：按编号它在等待之后 → 放行
    mkissue 52 ""; ev 52 labeled pending/agent req-bot 7002; ev 52 labeled pending/req loop-bot 7001; ev 52 unlabeled pending/req req-bot 7003
    # 反过来：等待标签编号更大 → 拦住
    mkissue 53 ""; ev 53 labeled pending/req loop-bot 7102; ev 53 labeled pending/agent req-bot 7101; ev 53 unlabeled pending/req req-bot 7103
    # 两次等待、列表顺序和编号相反：按编号最近一次等待（7302）在派工（7301）之后 → 拦住；
    # 按列表位置取「最后一次等待」会取到 7300、误判成派工在后
    mkissue 56 ""; ev 56 labeled pending/req loop-bot 7302; ev 56 labeled pending/agent req-bot 7301
    ev 56 labeled pending/req loop-bot 7300; ev 56 unlabeled pending/req req-bot 7303
    jset events.json '.["52"] |= map(.created_at = "2026-01-01T00:00:00Z") | .["53"] |= map(.created_at = "2026-01-01T00:00:00Z") | .["56"] |= map(.created_at = "2026-01-01T00:00:00Z")'
    tick
    chk "派工标签编号在后（列表里排在前面）→ 派" "$(queued issue 52)" yes
    chk "等待标签编号在后（列表里排在后面）→ 不派" "$(queued issue 53)" no
    chk "两次等待、列表顺序和编号相反：按编号最近的那次等待在派工之后 → 不派" "$(queued issue 56)" no

    section "【1d】判不了：读不到 / 缺编号 → 本轮不派、下轮再判（不缓存「判不了」）"
    fresh "${REQ_ON[@]}" 'DISPATCH_MODE="greedy"'
    mkissue 54 ""; wait_cycle 54; trigger_cycle 54     # 判得出来时应放行
    touch "$GD/F_issues_54_events"
    tick
    chk "读不到 #54 的标签记录 → 本轮不派" "$(queued issue 54)" no
    chk "  → 日志写「下轮再判」" "$(log_has 'greedy：issue #54 本轮不续工')" 1
    rm -f "$GD/F_issues_54_events"
    tick
    chk "读取恢复、条目没变过 → 重新判、派" "$(queued issue 54)" yes
    fresh "${REQ_ON[@]}" 'DISPATCH_MODE="greedy"'
    mkissue 55 ""; ev 55 labeled pending/req loop-bot null; ev 55 unlabeled pending/req req-bot
    tick
    chk "标签记录缺事件编号 → 不派" "$(queued issue 55)" no

    section "【1e】功能关着：等待标签被摘掉照旧续上，一次标签记录都不读"
    fresh 'DISPATCH_MODE="greedy"' 'LABEL_PENDING_REQUESTER_BOT="pending/req"'
    mkissue 50 ""; wait_cycle 50
    tick
    chk "只配了等待标签（功能没开）→ 派，和改动前一样" "$(queued issue 50)/$(n_calls "$R/issues/50/events")" "yes/0"

    # ── 【2】只挂托管标签的 issue（按标签派工的项目）──
    section "【2】按标签派工 + 只挂托管标签：等待标签被提前摘掉 → 不自动开工；打了派工标签 → 开工"
    fresh "${REQ_ON[@]}" 'LABEL_AUTOPILOT="autopilot"'
    mkissue 60 "autopilot"; ev 60 labeled autopilot maint; wait_cycle 60
    mkissue 61 "autopilot"; ev 61 labeled autopilot maint
    tick
    chk "#60（只剩托管标签、等待被摘）不进派工队列" "$(queued issue 60)" no
    chk "#60 日志写明原因" "$(log_has '托管：issue #60 不自动开工')" 1
    chk "到达性 · #61（机器人提的需求、维护者打的托管、从没等过）照常开工" "$(queued issue 61)" yes
    trigger_cycle 60; bump 60 1
    tick
    chk "#60 之后有人打过 pending/agent → 开工" "$(queued issue 60)" yes
    wait_cycle 60; bump 60 2
    tick
    chk "#60 第二次挂上又被提前摘掉 → 又不开工" "$(queued issue 60)" no

    # ── 【3】托管接手没有流程标签的 PR ──
    section "【3】托管接手：PR 只挂着托管标签、等待被提前摘掉 → 不接手；打了派工标签 → 接手"
    fresh "${REQ_ON[@]}" 'LABEL_AUTOPILOT="autopilot"'
    mkissue 7 "pending/PR"; mkpr 8 feature/issue-7 "做了 X。

Closes #7" "autopilot"
    ev 8 labeled autopilot maint; wait_cycle 8
    tick
    chk "等待被提前摘掉 → 不接手" "$(took_none)" no
    chk "  → 日志写明原因" "$(log_has '托管：PR #8 不接手——')" 1
    tick
    chk "第二轮没变化：仍不接手、不重复记日志" "$(took_none)/$(log_has '托管：PR #8 不接手——')" "no/0"
    printf '\nLABEL_PENDING_REQUESTER_BOT="pending/new"\n' >> "$CONF"
    tick
    chk "等待标签换了名字、PR 没变 → 按新配置重判、接手（不沿用上一轮的不接手）" "$(took_none)" yes
    fresh "${REQ_ON[@]}" 'LABEL_AUTOPILOT="autopilot"'
    mkissue 7 "pending/PR"; mkpr 8 feature/issue-7 "做了 X。

Closes #7" "autopilot"
    ev 8 labeled autopilot maint; wait_cycle 8
    tick
    trigger_cycle 8 maint; bump 8 1
    tick
    chk "之后有人打过 pending/agent → 接手（翻 pending/review、留说明）" "$(took_none)" yes
    fresh "${REQ_ON[@]}" 'LABEL_AUTOPILOT="autopilot"'
    mkissue 7 "pending/PR"; mkpr 8 feature/issue-7 "做了 X。

Closes #7" "autopilot"
    ev 8 labeled autopilot maint
    tick
    chk "到达性 · 从没等过的同样 PR → 接手" "$(took_none)" yes
    fresh "${REQ_ON[@]}" 'LABEL_AUTOPILOT="autopilot"'
    mkissue 7 "pending/PR"; mkpr 8 feature/issue-7 "做了 X。

Closes #7" "autopilot"
    ev 8 labeled autopilot maint; wait_cycle 8; trigger_cycle 8 maint
    touch "$GD/F_issues_8_events"
    tick
    chk "读不到 PR 的标签记录 → 不接手" "$(took_none)" no
}

# ── 提示词：机器人需求 + 托管的合并规则 ──
compose() {   # <scripts+prompts 根> <模板名> [环境变量…]
    local root="$1" name="$2"; shift 2
    local W="$SANDBOX/compose"; rm -rf "$W"; mkdir -p "$W/state" "$W/project"
    git init -q "$W/project" 2>/dev/null
    cat > "$W/conf" <<CONF
REPO="example/ap"
PROJECT_ROOT="$W/project"
WORKTREE_BASE="$W/wt"
STATE_DIR="$W/state"
TMUX_PREFIX="rwc"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
LABEL_AGENT_DOING="doing/agent"
LABEL_PENDING_REVIEW="pending/review"
PATH="$SANDBOX/bin:\$PATH"
CONF
    local f
    f=$(cd "$W/project" && env "$@" CODING_AGENT_CONFIG="$W/conf" bash -c 'source "$1/scripts/_lib.sh" >/dev/null 2>&1; compose_prompt_template "$2"' _ "$root" "$name" 2>/dev/null)
    [ -n "$f" ] && [ -f "$f" ] && sed "s|$root|<ROOT>|g" "$f"
}

prompts_check() {
    local root="$1" name n
    local req="LABEL_PENDING_REQUESTER_BOT=pending/req REQUESTER_BOT_ACCOUNT=req-bot REQUESTER_BOT_ALLOWED_ACTORS=loop-bot REQUESTER_BOT_ORIGIN_MARKER=<!--by-req-->"
    local ap="LABEL_AUTOPILOT=autopilot DISPATCH_AUTOPILOT=1 DISPATCH_AUTOPILOT_ISSUE=7"
    section "【4】提示词：两个功能都开、是托管条目时才追加合并规则，放在两段之后"
    for name in new-issue issue-comment pr-comment review; do
        # shellcheck disable=SC2086
        n=$(compose "$root" "$name" $req $ap)
        chk "$name：恰好一段合并规则" "$(printf '%s' "$n" | grep -c '^# 外部需求机器人提的需求 + 托管')" 1
        chk "$name：顺序是 交接规则 → 托管规则 → 合并规则" \
            "$(printf '%s' "$n" | awk '/^# 外部需求机器人交接规则/{a=NR} /^# 托管规则（本条是托管条目）/{b=NR} /^# 外部需求机器人提的需求 \+ 托管/{c=NR} END{print (a>0 && b>a && c>b) ? "yes" : "no"}')" yes
        chk "$name：没有没换掉的占位" "$(printf '%s' "$n" | grep -c '@@')" 0
        # shellcheck disable=SC2086
        chk "$name：只开托管（机器人功能关）→ 没有合并规则" "$(compose "$root" "$name" $ap | grep -c '外部需求机器人提的需求 + 托管')" 0
        # shellcheck disable=SC2086
        chk "$name：只开机器人功能（不是托管条目）→ 没有合并规则" "$(compose "$root" "$name" $req LABEL_AUTOPILOT=autopilot | grep -c '外部需求机器人提的需求 + 托管')" 0
    done
    # shellcheck disable=SC2086
    n=$(compose "$root" review $req $ap REQUESTER_BOT_REPORT_FIRST=true)
    chk "先汇报的项目 · review：方案通过叫醒机器人、不翻 pending/agent" \
        "$(printf '%s' "$n" | grep -cF '**复审，方案通过时**：不翻 `pending/agent`')" 1
    chk "先汇报的项目 · review：没有提需求方认可时不翻 pending/merge、不写机器记录" \
        "$(printf '%s' "$n" | grep -cF '但 PR 上还没有提需求方对 PR 最新提交的认可**：不翻 `pending/merge`，**不写**')" 1
    chk "先汇报的项目 · review：有对最新提交的认可才走托管的通过" \
        "$(printf '%s' "$n" | grep -cF 'PR 上已有提需求方对 PR 最新提交的认可**')" 1
    chk "先汇报的项目：认可后有新提交 → 旧认可作废" "$(printf '%s' "$n" | grep -c '旧认可作废')" 1
    # shellcheck disable=SC2086
    n=$(compose "$root" pr-comment $req $ap REQUESTER_BOT_REPORT_FIRST=true)
    chk "先汇报的项目 · pr-comment：认可当前提交后交复审、不交维护者" \
        "$(printf '%s' "$n" | grep -cF '**不交维护者**，交复审——翻 `pending/review`、摘 `doing/agent`')" 1
    # shellcheck disable=SC2086
    n=$(compose "$root" review $req $ap REQUESTER_BOT_REPORT_FIRST=false)
    chk "不先汇报的项目 · review：代码通过照托管翻 pending/merge" \
        "$(printf '%s' "$n" | grep -cF '本项目**不**要求先向机器人汇报结果：代码复审通过照托管规则翻 `pending/merge`')/$(printf '%s' "$n" | grep -c '旧认可作废')" "1/0"
}

echo "=== 正式版 ==="
run_scenarios "$REPO_DIR/scripts"
prompts_check "$REPO_DIR"
REAL_PASS=$pass; REAL_FAIL=$fail

section "【9】负对照（改坏一处，至少一条检查必须变红）"
mut_fail=0; mut_ran=0
mutate() {   # <名字> <文件（相对 scripts/）> <原文> <替换后> [<原文> <替换后> …]：每对原文都必须找得到
    local name="$1" file="$2" M="$SANDBOX/mut-$1"
    shift 2
    mutation_gate || return 0
    mut_ran=$((mut_ran + 1))
    rm -rf "$M"; mkdir -p "$M"; cp -r "$REPO_DIR/scripts" "$REPO_DIR/prompts" "$M/"
    if ! python3 - "$M/scripts/$file" "$@" <<'PY'
import sys
p, pairs = sys.argv[1], sys.argv[2:]
s = open(p).read()
for old, new in zip(pairs[0::2], pairs[1::2]):
    if s.count(old) < 1:
        sys.exit(1)
    s = s.replace(old, new, 1)
open(p, "w").write(s)
PY
    then
        echo "  ❌ 负对照 $name：要改的原文找不到（准备失败）"; mut_fail=$((mut_fail + 1)); return 0
    fi
    pass=0; fail=0; QUIET=1
    run_scenarios "$M/scripts"; prompts_check "$M"
    QUIET=0
    if [ "$fail" -gt 0 ]; then echo "  ✅ 负对照 $name：$fail 条检查变红"
    else echo "  ❌ 负对照 $name：改坏后整套检查仍全绿（测试分不出这个错误实现）"; mut_fail=$((mut_fail + 1)); fi
}
# 三个调用点各拆一个
mutate site-greedy agent-poll.sh '        rc=0; requester_bot_wait_hold "$num" || rc=$?
        case "$rc" in
            0) [ -n "$REQUESTER_BOT_WAIT_LOGGED" ] || log "greedy' '        rc=1
        case "$rc" in
            0) [ -n "$REQUESTER_BOT_WAIT_LOGGED" ] || log "greedy'
mutate site-autopilot-rows agent-poll.sh '                rc=0; requester_bot_wait_hold "$num" || rc=$?' '                rc=1'
mutate site-takeover _lib.sh '    if [ "$AT_MODE" = none ]; then
        rc=0; requester_bot_wait_hold' '    if false; then
        rc=0; requester_bot_wait_hold'
# 判据本身
mutate no-trigger-release _lib.sh '            return 1
        fi
    done' '            :
        fi
    done'
mutate order-by-position _lib.sh "sorted=\$(printf '%s\n' \"\$rows\" | awk -F'\t' 'NF' | sort -t\$'\t' -k1,1n)" "sorted=\$(printf '%s\n' \"\$rows\" | awk -F'\t' 'NF')"
mutate unknown-is-free _lib.sh '        REQUESTER_BOT_WAIT_REASON="读不到 #$n 的标签记录"; return 2' '        REQUESTER_BOT_WAIT_REASON="读不到 #$n 的标签记录"; return 1'
mutate missing-id-ok _lib.sh '        REQUESTER_BOT_WAIT_REASON="#$n 的标签记录缺事件编号"; return 2' '        :'
# 缓存（代码复审第 1 轮）：放回「判过放行就一直放行」「判过拦住就一直拦住」两种跨轮缓存，都必须变红
mutate free-cached _lib.sh '    requester_bot_enabled || return 1
    if ! rows=' '    requester_bot_enabled || return 1
    grep -qx "$n" "$STATE_DIR/free-cache" 2>/dev/null && return 1
    if ! rows=' '    [ -n "$e" ] || return 1' '    [ -n "$e" ] || { echo "$n" >> "$STATE_DIR/free-cache"; return 1; }'
mutate hold-cached _lib.sh '    requester_bot_enabled || return 1
    if ! rows=' '    requester_bot_enabled || return 1
    grep -qx "$n" "$STATE_DIR/hold-cache" 2>/dev/null && return 0
    if ! rows=' '    # 日志去重（不影响上面的结论）' '    echo "$n" >> "$STATE_DIR/hold-cache"'
mutate takeover-hold-cached _lib.sh '                [ -n "$REQUESTER_BOT_WAIT_LOGGED" ] || log "托管：PR #$pr 不接手——$REQUESTER_BOT_WAIT_REASON，等有人打派工标签"
                return 0' '                [ -n "$REQUESTER_BOT_WAIT_LOGGED" ] || log "托管：PR #$pr 不接手——$REQUESTER_BOT_WAIT_REASON，等有人打派工标签"'
mutate log-dedup-missing _lib.sh '        REQUESTER_BOT_WAIT_LOGGED=1' '        :'
mutate enabled-gate-missing _lib.sh '    REQUESTER_BOT_WAIT_REASON=""; REQUESTER_BOT_WAIT_LOGGED=""
    requester_bot_enabled || return 1' '    REQUESTER_BOT_WAIT_REASON=""; REQUESTER_BOT_WAIT_LOGGED=""'
# 提示词
mutate prompt-section-missing _lib.sh '                autopilot_requester_bot_section' '                :'
mutate prompt-report-rule-swapped _lib.sh '    if requester_bot_report_first; then
        rule="本项目要求**先向机器人汇报结果**' '    if ! requester_bot_report_first; then
        rule="本项目要求**先向机器人汇报结果**'
# 整份换回旧实现（配本版 prompts/）：必须变红。merge-base = 改动前；83d29bf = 代码复审第 1 轮打回的那一版（按 updated_at 缓存结论）
mutate_rev() {   # <名字> <提交（空 = merge-base）>
    local name="$1" rev="$2" M="$SANDBOX/mut-rev-$1"
    mutation_gate || return 0
    mut_ran=$((mut_ran + 1))
    [ -n "$rev" ] || rev=$(git -C "$REPO_DIR" merge-base HEAD origin/main 2>/dev/null) || rev=""
    rm -rf "$M"; mkdir -p "$M"
    if [ -z "$rev" ] || ! git -C "$REPO_DIR" archive "$rev" scripts | tar -x -C "$M"; then
        echo "  ❌ 负对照 $name：取不到 ${rev:-merge-base} 的实现（准备失败）"; mut_fail=$((mut_fail + 1)); return 0
    fi
    cp -r "$REPO_DIR/prompts" "$M/"
    pass=0; fail=0; QUIET=1
    run_scenarios "$M/scripts"; prompts_check "$M"
    QUIET=0
    if [ "$fail" -gt 0 ]; then echo "  ✅ 负对照 $name：$fail 条检查变红"
    else echo "  ❌ 负对照 $name：旧实现整套检查仍全绿"; mut_fail=$((mut_fail + 1)); fi
}
mutate_rev merge-base ""
mutate_rev prev-83d29bf 83d29bf112d021fc965712be7548f5e9e8f31715
pass=$REAL_PASS; fail=$REAL_FAIL

echo
mutation_summary "$0"
echo "正式版：$pass 通过 / $fail 失败；负对照失效 $mut_fail 条（本次跑了 $mut_ran 条）"
[ "$fail" -eq 0 ] && [ "$mut_fail" -eq 0 ]
