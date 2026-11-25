#!/usr/bin/env bash
# kind: e2e
# 等外部需求机器人期间等待标签被提前摘掉时不自动续工；机器人的需求 + 托管的合并规则 —— GitHub#162。
#
# 跑法：bash tests/requester-bot-wait.test.sh
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
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"
# shellcheck source=lib/review-converge.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/review-converge.sh"

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"

SANDBOX=$(mktemp -d)
trap '[ -n "${KEEP_SANDBOX:-}" ] && echo "SANDBOX=$SANDBOX" || rm -rf "$SANDBOX"' EXIT
mkdir -p "$SANDBOX/bin" "$SANDBOX/home"
export HOME="$SANDBOX/home"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
unset CODING_AGENT_RELEASE_ROOT CLAUDE_PLUGIN_ROOT CAVIL_DEPLOY_ROOT CAVIL_DEPLOY_CONF CODING_AGENT_CONFIG \
      LABEL_AUTOPILOT DISPATCH_AUTOPILOT DISPATCH_AUTOPILOT_ISSUE DISPATCH_AUTOPILOT_PR GH_TOKEN WRITE_GH_TOKEN GITHUB_TOKEN

bash "$TEST_DIR/lib/fake_gh_client.sh" install "$SANDBOX/bin/gh" python3 "$TEST_DIR/lib/fake_github.py"
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
# 功能加入前的真实旧版（固定提交，不随主干移动）：「旧版先跑、保留状态升级」的跨版本场景用（代码复审第 2 轮）
OLD_REV=278efac7368694d95c66c50174148af3a6fb0534
OLDROOT="$SANDBOX/oldrev"; mkdir -p "$OLDROOT"
git -C "$REPO_DIR" archive "$OLD_REV" scripts prompts | tar -x -C "$OLDROOT" \
    || { echo "取不到旧版 $OLD_REV（跨版本场景没法跑）" >&2; exit 1; }
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

    # ── 【5】从旧版升级：旧版按「机器人的需求不托管」记下的拒绝，升级后必须按新规则重判（代码复审第 2 轮）──
    section "【5】旧版先跑两轮、保留状态升级 → 新版重判：机器人需求的托管 issue 开工、PR 被接手"
    old_tick() { env CODING_AGENT_CONFIG="$CONF" bash "$OLDROOT/scripts/agent-poll.sh" >/dev/null 2>&1; }
    fresh "${REQ_ON[@]}" 'LABEL_AUTOPILOT="autopilot"'
    mkissue 7 "pending/PR"; mkpr 8 feature/issue-7 "做了 X。

Closes #7" "autopilot"
    ev 8 labeled autopilot maint
    old_tick; old_tick
    chk "到达性 · 旧版确实拒绝过这个 PR（留了「机器人需求不托管」说明）" "$(comments_with 8 'kind=pr-requester-bot')" 1
    chk "到达性 · 旧版确实记下了接手记录" "$(jq -r '.autopilot.takeover["8"] // "" | length > 0' "$W/state/state.json" 2>/dev/null)" true
    tick
    chk "升级后（状态原样保留、PR 没变）→ 按新规则重判、接手" "$(took_none)" yes
    fresh "${REQ_ON[@]}" 'LABEL_AUTOPILOT="autopilot"'
    mkissue 60 "autopilot"; ev 60 labeled autopilot maint
    old_tick; old_tick
    chk "到达性 · 旧版确实拒绝过这个 issue" "$(comments_with 60 'kind=requester-bot')" 1
    chk "到达性 · 旧版确实记下了拒绝" "$(jq -r '.autopilot.denied["60"] // "" | length > 0' "$W/state/state.json" 2>/dev/null)" true
    tick
    chk "升级后（状态原样保留、issue 没变）→ 按新规则重判、开工" "$(queued issue 60)" yes

    # ── 【6】机器人贴回带说明的答复、摘了等待标签、没打派工标签 → daemon 替它补打 pending/agent（GitHub#619）──
    # 机器人答复：mkreply <n> <评论编号> <作者> <正文>
    mkreply() {
        jset comments.json '.[$n] = ((.[$n] // []) + [{id:($id|tonumber), body:$b, user:{login:$a}, created_at:"2026-01-02T00:00:00Z", updated_at:"2026-01-02T00:00:00Z"}])' \
            --arg n "$1" --arg id "$2" --arg a "$3" --arg b "$4"
    }
    # 带编号的一次等待：挂上（编号 $2）→ 被机器人摘掉（编号 $3）
    waitid() { ev "$1" labeled pending/req loop-bot "$2"; ev "$1" unlabeled pending/req req-bot "$3"; }
    nfix() { grep -cF -- "$1" "$CALLS" 2>/dev/null || true; }
    backfills() { nfix "api -X POST $R/issues/$1/labels -f labels[]=pending/agent"; }

    section "【6a】greedy：带说明的答复 → 本轮只补打一次 pending/agent、不派；下一轮按明确派工派"
    fresh "${REQ_ON[@]}" 'DISPATCH_MODE="greedy"'
    mkissue 70 ""; waitid 70 8001 8002
    mkreply 70 901 req-bot "提需求方认可了。

<!-- requester-bot-reply wait=8001 -->"
    mkissue 51 ""
    tick
    chk "本轮恰好一个补打写请求（加 pending/agent，不摘任何标签）" "$(backfills 70)/$(nfix "api -X DELETE $R/issues/70/labels")" "1/0"
    chk "补打的这一轮 #70 不进派工队列（不自己续工）" "$(queued issue 70)" no
    chk "#70 现在挂着 pending/agent" "$(has_label 70 pending/agent)" yes
    chk "日志写明替机器人补打、依据哪条答复" "$(log_has '替它补打 pending/agent（依据：机器人的评论 901）')" 1
    chk "到达性 · #51（从没等过）照常进派工队列" "$(queued issue 51)" yes
    tick
    chk "下一轮：#70 走明确派工进派工队列，不再补打" "$(queued issue 70)/$(backfills 70)" "yes/0"

    section "【6b】不该补打的答复：只有转达 / 说明对应的是更早一次等待 / 别人抄的说明 / 说明不独占一行"
    fresh "${REQ_ON[@]}" 'DISPATCH_MODE="greedy"'
    mkissue 71 ""; waitid 71 8101 8102
    mkreply 71 911 req-bot "已转给提需求的人"
    mkreply 71 912 req-bot "又转了一次"
    mkissue 72 ""; waitid 72 8201 8202; waitid 72 8203 8204
    mkreply 72 921 req-bot "旧的答复

<!-- requester-bot-reply wait=8201 -->"
    mkissue 73 ""; waitid 73 8301 8302
    mkreply 73 931 someone "<!-- requester-bot-reply wait=8301 -->"
    mkissue 74 ""; waitid 74 8401 8402
    mkreply 74 941 req-bot "引用：<!-- requester-bot-reply wait=8401 --> 这行不算"
    tick
    chk "只有转达 → 不补打、不派" "$(backfills 71)/$(queued issue 71)" "0/no"
    chk "  → 日志写明只有转达" "$(grep -F 'greedy：issue #71 不续工' "$W/state/poll.log" | grep -cF '机器人只有不带说明的评论（转达）')" 1
    chk "到达性 · 这一轮确实读了 #71 的评论" "$([ "$(n_calls "$R/issues/71/comments")" -gt 0 ] && echo yes || echo no)" yes
    chk "说明对应的是更早一次等待 → 不补打" "$(backfills 72)/$(queued issue 72)" "0/no"
    chk "  → 日志写明编号不是最近一次等待" "$(log_has '说明对应的不是最近这一次等待')" 1
    chk "别人的评论里抄了说明 → 不补打" "$(backfills 73)/$(queued issue 73)" "0/no"
    chk "说明不独占一行 → 不补打" "$(backfills 74)/$(queued issue 74)" "0/no"

    section "【6c】读不到评论 → 本轮不写、不派；恢复后补打；机器人已经自己打过派工标签 → 不补打、照常派"
    fresh "${REQ_ON[@]}" 'DISPATCH_MODE="greedy"'
    mkissue 75 ""; waitid 75 8501 8502
    mkreply 75 951 req-bot "<!-- requester-bot-reply wait=8501 -->"
    touch "$GD/F_issues_75_comments"
    mkissue 76 ""; ev 76 labeled pending/req loop-bot 8601; ev 76 labeled pending/agent req-bot 8602; ev 76 unlabeled pending/req req-bot 8603; ev 76 unlabeled pending/agent loop-bot 8604
    mkreply 76 961 req-bot "<!-- requester-bot-reply wait=8601 -->"
    tick
    chk "读不到 #75 的评论 → 不补打、不派" "$(backfills 75)/$(queued issue 75)" "0/no"
    chk "  → 日志写「下轮再判」" "$(log_has 'greedy：issue #75 本轮不续工（读不到 #75 的评论）')" 1
    chk "机器人等待之后自己打过 pending/agent（规则 3）→ 不补打、照常派" "$(backfills 76)/$(queued issue 76)" "0/yes"
    rm -f "$GD/F_issues_75_comments"
    tick
    chk "读取恢复 → 补打" "$(backfills 75)" 1

    section "【6d】判定之后、写之前条目变了 → 一个写请求都不发；不注入变化时确实发（三条入口各跑一遍）"
    # 在 gh 前面套一层：第 K 次单独读 issue / PR #<n> 之前先跑一段钩子（模拟「判定之后有人改了 GitHub」）。
    # 第 1 次单独读是补打函数的第一次现读（调用方判定时只读标签记录和评论列表），所以 hook_1 = 「调用方判定之后、
    # 补打函数现读之前」，hook_2 = 「补打函数两次现读之间」
    mkshim() {   # <n>
        mkdir -p "$W/shim"; rm -f "$W/shim/count" "$W/shim/hook_"*
        cat > "$W/shim/gh" <<SHIM
#!/usr/bin/env bash
if [ "\$1 \$2" = "api $R/issues/$1" ] && [ \$# -eq 2 ]; then
    c=\$(( \$(cat "$W/shim/count" 2>/dev/null || echo 0) + 1 )); echo "\$c" > "$W/shim/count"
    [ -f "$W/shim/hook_\$c" ] && bash "$W/shim/hook_\$c"
fi
exec "$SANDBOX/bin/gh" "\$@"
SHIM
        chmod +x "$W/shim/gh"
    }
    edit_hook() {   # <k> <n>：第 k 次读之前把 #n 的第一条答复原地改掉（说明行不变）
        echo "jq '.[\"$2\"][0].body = \"请继续修改\n\n\" + (.[\"$2\"][0].body | split(\"\n\") | last) | .[\"$2\"][0].updated_at = \"2026-01-04T00:00:00Z\"' '$GD/comments.json' > '$GD/c.tmp' && mv '$GD/c.tmp' '$GD/comments.json'" > "$W/shim/hook_$1"
    }
    for k in 1 2; do
        for change in human relabel reply-edit; do
            fresh "${REQ_ON[@]}" 'DISPATCH_MODE="greedy"' "PATH=\"$W/shim:\$PATH\""
            mkshim 77
            mkissue 77 ""; waitid 77 8701 8702
            mkreply 77 971 req-bot "<!-- requester-bot-reply wait=8701 -->"
            case "$change" in
                human)      echo "jq '.[\"77\"] = [\"pending/human\"]' '$GD/labels.json' > '$GD/l.tmp' && mv '$GD/l.tmp' '$GD/labels.json'" > "$W/shim/hook_$k" ;;
                relabel)    echo "jq '.[\"77\"] += [{event:\"labeled\", id:8703, label:{name:\"pending/req\"}, actor:{login:\"maint\", type:\"User\"}, created_at:\"2026-01-03T00:00:00Z\"}]' '$GD/events.json' > '$GD/e.tmp' && mv '$GD/e.tmp' '$GD/events.json'" > "$W/shim/hook_$k" ;;
                reply-edit) edit_hook "$k" 77 ;;
            esac
            tick
            chk "greedy · 第 $k 次现读前「$change」→ 本轮不补打" "$(backfills 77)" 0
            chk "  到达性 · 确实读到了第 $k 次" "$([ "$(cat "$W/shim/count" 2>/dev/null || echo 0)" -ge "$k" ] && echo yes || echo no)" yes
        done
    done
    fresh "${REQ_ON[@]}" 'DISPATCH_MODE="greedy"' "PATH=\"$W/shim:\$PATH\""
    mkshim 77
    mkissue 77 ""; waitid 77 8701 8702
    mkreply 77 971 req-bot "<!-- requester-bot-reply wait=8701 -->"
    tick
    chk "对照 · greedy 不注入变化 → 补打一次" "$(backfills 77)" 1
    # 只挂托管标签的 issue、托管 PR：判定之后（第 1 次现读之前）答复被原地编辑
    for target in issue pr; do
        for inj in edit none; do
            fresh "${REQ_ON[@]}" 'LABEL_AUTOPILOT="autopilot"' "PATH=\"$W/shim:\$PATH\""
            if [ "$target" = issue ]; then
                tn=80; mkshim 80
                mkissue 80 "autopilot"; ev 80 labeled autopilot maint 8800; waitid 80 8801 8802
                mkreply 80 981 req-bot "<!-- requester-bot-reply wait=8801 -->"
            else
                tn=8; mkshim 8
                mkissue 7 "pending/PR"; mkpr 8 feature/issue-7 "做了 X。

Closes #7" "autopilot"
                ev 8 labeled autopilot maint 8900; waitid 8 8901 8902
                mkreply 8 991 req-bot "<!-- requester-bot-reply wait=8901 -->"
            fi
            [ "$inj" = edit ] && edit_hook 1 "$tn"
            tick
            if [ "$inj" = edit ]; then
                chk "托管 $target · 判定之后答复被原地编辑 → 本轮不补打" "$(backfills "$tn")" 0
                chk "  到达性 · 补打函数确实现读过" "$([ "$(cat "$W/shim/count" 2>/dev/null || echo 0)" -ge 1 ] && echo yes || echo no)" yes
            else
                chk "对照 · 托管 $target 不注入变化 → 补打一次" "$(backfills "$tn")" 1
            fi
        done
    done

    # 第一次判定之后、补打函数第一次现读之前，维护者摘掉再重新打托管标签、PR 推了新提交（获批方案第 14 版验收 10）
    # → 本轮零写；下一轮按新状态重新判断（重新授权仍成立、答复仍有效）→ 补打一次
    fresh "${REQ_ON[@]}" 'LABEL_AUTOPILOT="autopilot"' "PATH=\"$W/shim:\$PATH\""
    mkshim 80
    mkissue 80 "autopilot"; ev 80 labeled autopilot maint 8800; waitid 80 8801 8802
    mkreply 80 981 req-bot "<!-- requester-bot-reply wait=8801 -->"
    echo "jq '.[\"80\"] += [{event:\"unlabeled\", id:8803, label:{name:\"autopilot\"}, actor:{login:\"maint\", type:\"User\"}, created_at:\"2026-01-03T00:00:00Z\"}, {event:\"labeled\", id:8804, label:{name:\"autopilot\"}, actor:{login:\"maint\", type:\"User\"}, created_at:\"2026-01-03T00:00:01Z\"}]' '$GD/events.json' > '$GD/e.tmp' && mv '$GD/e.tmp' '$GD/events.json'" > "$W/shim/hook_1"
    tick
    chk "托管 issue · 第一次判定之后维护者重新授权 → 本轮不补打" "$(backfills 80)" 0
    chk "  到达性 · 重新授权确实发生在补打函数现读之前" "$(cat "$W/shim/count" 2>/dev/null)/$(jq -r '.["80"] | map(select(.event == "unlabeled" and .label.name == "autopilot")) | length' "$GD/events.json")" "1/1"
    tick
    chk "  下一轮按新授权重判 → 补打一次" "$(backfills 80)" 1
    fresh "${REQ_ON[@]}" 'DISPATCH_MODE="greedy"' "PATH=\"$W/shim:\$PATH\""
    mkshim 9
    mkpr 9 feature/x "无关联的 PR" ""; waitid 9 8961 8962
    mkreply 9 996 req-bot "<!-- requester-bot-reply wait=8961 -->"
    echo "jq '.[\"9\"].head.sha = \"2222222222222222222222222222222222222222\"' '$GD/items.json' > '$GD/i.tmp' && mv '$GD/i.tmp' '$GD/items.json'" > "$W/shim/hook_1"
    tick
    chk "greedy PR · 第一次判定之后 PR 推了新提交 → 本轮不补打" "$(backfills 9)" 0
    chk "  到达性 · 补打函数现读之前确实换了提交" "$(cat "$W/shim/count" 2>/dev/null)/$(jq -r '.["9"].head.sha' "$GD/items.json")" "1/2222222222222222222222222222222222222222"
    tick
    chk "  下一轮按新提交重判 → 补打一次" "$(backfills 9)" 1
    # 托管接手：接手判定第一次给出 backfill 之后、补打函数第一次现读之前重新授权 / 推新提交 → 本轮不补打，下一轮补打
    for k in 1 2; do
        for change in reauth push pr-label issue-label; do
            fresh "${REQ_ON[@]}" 'LABEL_AUTOPILOT="autopilot"' "PATH=\"$W/shim:\$PATH\""
            mkshim 8
            mkissue 7 "pending/PR"; mkpr 8 feature/issue-7 "做了 X。

Closes #7" "autopilot"
            ev 8 labeled autopilot maint 8900; waitid 8 8901 8902
            mkreply 8 991 req-bot "<!-- requester-bot-reply wait=8901 -->"
            case "$change" in
                reauth) echo "jq '.[\"8\"] += [{event:\"unlabeled\", id:8903, label:{name:\"autopilot\"}, actor:{login:\"maint\", type:\"User\"}, created_at:\"2026-01-03T00:00:00Z\"}, {event:\"labeled\", id:8904, label:{name:\"autopilot\"}, actor:{login:\"maint\", type:\"User\"}, created_at:\"2026-01-03T00:00:01Z\"}]' '$GD/events.json' > '$GD/e.tmp' && mv '$GD/e.tmp' '$GD/events.json'" > "$W/shim/hook_$k" ;;
                push)   echo "jq '.[\"8\"].head.sha = \"2222222222222222222222222222222222222222\"' '$GD/items.json' > '$GD/i.tmp' && mv '$GD/i.tmp' '$GD/items.json'" > "$W/shim/hook_$k" ;;
                # 不影响接手资格的普通分类标签：加在 PR 上 / 加在绑定的 issue 上
                pr-label)    echo "jq '.[\"8\"] += [\"kind/docs\"]' '$GD/labels.json' > '$GD/l.tmp' && mv '$GD/l.tmp' '$GD/labels.json'" > "$W/shim/hook_$k" ;;
                issue-label) echo "jq '.[\"7\"] += [\"kind/docs\"]' '$GD/labels.json' > '$GD/l.tmp' && mv '$GD/l.tmp' '$GD/labels.json'" > "$W/shim/hook_$k" ;;
            esac
            tick
            chk "托管 PR · 第 $k 次现读前「$change」→ 本轮不补打" "$(backfills 8)" 0
            chk "  到达性 · 确实读到了第 $k 次" "$([ "$(cat "$W/shim/count" 2>/dev/null || echo 0)" -ge "$k" ] && echo yes || echo no)" yes
            tick
            chk "  下一轮按新状态重判 → 补打一次" "$(backfills 8)" 1
        done
    done
    # greedy / 只挂托管标签的 issue 的第 2 次现读前同样两种变化（第 1 次的见上面两组）
    for target in issue pr; do
        if [ "$target" = issue ]; then
            fresh "${REQ_ON[@]}" 'LABEL_AUTOPILOT="autopilot"' "PATH=\"$W/shim:\$PATH\""
            tn=80; mkshim 80
            mkissue 80 "autopilot"; ev 80 labeled autopilot maint 8800; waitid 80 8801 8802
            mkreply 80 981 req-bot "<!-- requester-bot-reply wait=8801 -->"
            echo "jq '.[\"80\"] += [{event:\"unlabeled\", id:8803, label:{name:\"autopilot\"}, actor:{login:\"maint\", type:\"User\"}, created_at:\"2026-01-03T00:00:00Z\"}, {event:\"labeled\", id:8804, label:{name:\"autopilot\"}, actor:{login:\"maint\", type:\"User\"}, created_at:\"2026-01-03T00:00:01Z\"}]' '$GD/events.json' > '$GD/e.tmp' && mv '$GD/e.tmp' '$GD/events.json'" > "$W/shim/hook_2"
        else
            fresh "${REQ_ON[@]}" 'DISPATCH_MODE="greedy"' "PATH=\"$W/shim:\$PATH\""
            tn=9; mkshim 9
            mkpr 9 feature/x "无关联的 PR" ""; waitid 9 8961 8962
            mkreply 9 996 req-bot "<!-- requester-bot-reply wait=8961 -->"
            echo "jq '.[\"9\"].head.sha = \"2222222222222222222222222222222222222222\"' '$GD/items.json' > '$GD/i.tmp' && mv '$GD/i.tmp' '$GD/items.json'" > "$W/shim/hook_2"
        fi
        tick
        chk "$target · 第 2 次现读前重新授权 / 推新提交 → 本轮不补打" "$(backfills "$tn")" 0
        chk "  到达性 · 确实读到了第 2 次" "$(cat "$W/shim/count" 2>/dev/null)" 2
        tick
        chk "  下一轮按新状态重判 → 补打一次" "$(backfills "$tn")" 1
    done

    # greedy PR：第一次判定之后、第 1 / 2 次现读之前转成草稿，或加一个普通分类标签 → 本轮不补打；标签那组下一轮补打一次
    for k in 1 2; do
        for change in draft label; do
            fresh "${REQ_ON[@]}" 'DISPATCH_MODE="greedy"' "PATH=\"$W/shim:\$PATH\""
            mkshim 9
            mkpr 9 feature/x "无关联的 PR" ""; waitid 9 8961 8962
            mkreply 9 996 req-bot "<!-- requester-bot-reply wait=8961 -->"
            case "$change" in
                draft) echo "jq '.[\"9\"].draft = true' '$GD/items.json' > '$GD/i.tmp' && mv '$GD/i.tmp' '$GD/items.json'" > "$W/shim/hook_$k" ;;
                label) echo "jq '.[\"9\"] += [\"kind/docs\"]' '$GD/labels.json' > '$GD/l.tmp' && mv '$GD/l.tmp' '$GD/labels.json'" > "$W/shim/hook_$k" ;;
            esac
            tick
            chk "greedy PR · 第 $k 次现读前「$change」→ 本轮不补打" "$(backfills 9)" 0
            chk "  到达性 · 确实读到了第 $k 次" "$([ "$(cat "$W/shim/count" 2>/dev/null || echo 0)" -ge "$k" ] && echo yes || echo no)" yes
            if [ "$change" = label ]; then
                tick
                chk "  下一轮按新标签重判 → 补打一次" "$(backfills 9)" 1
            fi
        done
    done

    # 输入本身变了、判出的条目身份和标签都没变：greedy PR 正文去掉 `Closes #7`（绑定的 issue 跟着变），
    # 托管接手的拆分子项 PR：父 issue 加了普通标签 / 子项和父 issue 解除关系。第 1 / 2 次现读前注入 → 本轮不补打，下一轮补打一次
    for k in 1 2; do
        fresh "${REQ_ON[@]}" 'DISPATCH_MODE="greedy"' "PATH=\"$W/shim:\$PATH\""
        mkshim 9
        mkissue 7 "pending/PR"; mkpr 9 feature/issue-7 "做了 X。

Closes #7" ""; waitid 9 8961 8962
        mkreply 9 996 req-bot "<!-- requester-bot-reply wait=8961 -->"
        echo "jq '.[\"9\"].body = \"做了 X。\"' '$GD/items.json' > '$GD/i.tmp' && mv '$GD/i.tmp' '$GD/items.json'" > "$W/shim/hook_$k"
        tick
        chk "greedy PR · 第 $k 次现读前正文去掉 Closes #7 → 本轮不补打" "$(backfills 9)" 0
        chk "  到达性 · 确实读到了第 $k 次" "$([ "$(cat "$W/shim/count" 2>/dev/null || echo 0)" -ge "$k" ] && echo yes || echo no)" yes
        tick
        chk "  下一轮按新正文重判 → 补打一次" "$(backfills 9)" 1
        for change in parent-label unlink; do
            fresh "${REQ_ON[@]}" 'LABEL_AUTOPILOT="autopilot"' "PATH=\"$W/shim:\$PATH\""
            mkshim 8
            mkissue 50 "autopilot" maint; ev 50 labeled autopilot maint 8890
            mkissue 7 "pending/PR" loop-bot
            jset items.json '.["7"].body = "子项\n\n<!-- agent-split-from: #50 -->" | .["7"].parent_issue_url = "https://api.github.com/repos/example/ap/issues/50"'
            mkpr 8 feature/issue-7 "做了 X。

Closes #7" "autopilot"
            ev 8 labeled autopilot maint 8900; waitid 8 8901 8902
            mkreply 8 991 req-bot "<!-- requester-bot-reply wait=8901 -->"
            case "$change" in
                parent-label) echo "jq '.[\"50\"] += [\"kind/docs\"]' '$GD/labels.json' > '$GD/l.tmp' && mv '$GD/l.tmp' '$GD/labels.json'" > "$W/shim/hook_$k" ;;
                unlink)       echo "jq '.[\"7\"] |= del(.parent_issue_url)' '$GD/items.json' > '$GD/i.tmp' && mv '$GD/i.tmp' '$GD/items.json'" > "$W/shim/hook_$k" ;;
            esac
            tick
            chk "托管拆分子项 PR · 第 $k 次现读前「$change」→ 本轮不补打" "$(backfills 8)" 0
            chk "  到达性 · 确实读到了第 $k 次" "$([ "$(cat "$W/shim/count" 2>/dev/null || echo 0)" -ge "$k" ] && echo yes || echo no)" yes
            tick
            chk "  下一轮按新状态重判 → 补打一次" "$(backfills 8)" 1
        done
    done
    # 对照：拆分子项的托管 PR 不注入变化 → 补打一次（证明上面的「不补打」来自变化，不是拆分子项本来就判不过）
    fresh "${REQ_ON[@]}" 'LABEL_AUTOPILOT="autopilot"'
    mkissue 50 "autopilot" maint; ev 50 labeled autopilot maint 8890
    mkissue 7 "pending/PR" loop-bot
    jset items.json '.["7"].body = "子项\n\n<!-- agent-split-from: #50 -->" | .["7"].parent_issue_url = "https://api.github.com/repos/example/ap/issues/50"'
    mkpr 8 feature/issue-7 "做了 X。

Closes #7" "autopilot"
    ev 8 labeled autopilot maint 8900; waitid 8 8901 8902
    mkreply 8 991 req-bot "<!-- requester-bot-reply wait=8901 -->"
    tick
    chk "对照 · 拆分子项的托管 PR 不注入变化 → 补打一次" "$(backfills 8)" 1
    chk "  到达性 · 授权判定确实读了父 issue #50" "$([ "$(n_calls "$R/issues/50")" -ge 1 ] && echo yes || echo no)" yes

    section "【6d2】PR / 标签缺字段或为空（草稿标记 / 来源仓库读不到或为空 / 标签名为空）→ 判不了，不补打"
    for miss in draft repo repo-empty label-empty; do
        fresh "${REQ_ON[@]}" 'LABEL_AUTOPILOT="autopilot"'
        mkissue 7 "pending/PR"; mkpr 8 feature/issue-7 "做了 X。

Closes #7" "autopilot"
        ev 8 labeled autopilot maint 8900; waitid 8 8901 8902
        mkreply 8 991 req-bot "<!-- requester-bot-reply wait=8901 -->"
        case "$miss" in
            draft) jset items.json '.["8"] |= del(.draft)' ;;
            repo)  jset items.json '.["8"].head.repo = null' ;;
            repo-empty)  jset items.json '.["8"].head.repo.full_name = ""' ;;
            label-empty) jset labels.json '.["8"] += [""]' ;;
        esac
        tick
        chk "缺 $miss → 不补打" "$(backfills 8)" 0
        chk "  到达性 · 补打函数确实读过 PR #8" "$([ "$(n_calls "$R/pulls/8 ")$(n_calls "$R/pulls/8\$")" != 00 ] && echo yes || echo no)" yes
    done

    # 正文读不全（字段缺失 / 类型不对）≠ 正文明确为空（复审第 6 轮，维护者选 A）：
    # 第一次判定看到正文，写前两次现读都读不到 → 本轮不补打；读取恢复后下一轮补打一次。正文明确为空（""、null）照常补打
    for bad in missing false; do
        fresh "${REQ_ON[@]}" 'DISPATCH_MODE="greedy"' "PATH=\"$W/shim:\$PATH\""
        mkshim 9
        mkpr 9 feature/x "" ""; waitid 9 8961 8962
        mkreply 9 996 req-bot "<!-- requester-bot-reply wait=8961 -->"
        case "$bad" in
            missing) echo "jq '.[\"9\"] |= del(.body)' '$GD/items.json' > '$GD/i.tmp' && mv '$GD/i.tmp' '$GD/items.json'" > "$W/shim/hook_1" ;;
            false)   echo "jq '.[\"9\"].body = false' '$GD/items.json' > '$GD/i.tmp' && mv '$GD/i.tmp' '$GD/items.json'" > "$W/shim/hook_1" ;;
        esac
        tick
        chk "greedy PR · 写前现读正文「$bad」→ 本轮不补打" "$(backfills 9)" 0
        chk "  到达性 · 补打函数确实现读过" "$([ "$(cat "$W/shim/count" 2>/dev/null || echo 0)" -ge 1 ] && echo yes || echo no)" yes
        jset items.json '.["9"].body = ""'
        tick
        chk "  正文读取恢复 → 下一轮补打一次" "$(backfills 9)" 1
    done
    for empty in '""' null; do
        fresh "${REQ_ON[@]}" 'DISPATCH_MODE="greedy"'
        mkpr 9 feature/x "" ""; waitid 9 8961 8962
        jset items.json ".[\"9\"].body = $empty"
        mkreply 9 996 req-bot "<!-- requester-bot-reply wait=8961 -->"
        tick
        chk "greedy PR · 正文明确为空（$empty）→ 补打一次" "$(backfills 9)" 1
    done

    section "【6d3】只有 shasum、没有 sha256sum 的机器：带说明的答复照样补打"
    fresh "${REQ_ON[@]}" 'DISPATCH_MODE="greedy"'
    mkdir -p "$W/nosha"
    local f b
    for f in /usr/local/bin/* /usr/bin/* /bin/*; do
        b=$(basename "$f"); [ "$b" = sha256sum ] && continue
        [ -e "$W/nosha/$b" ] || ln -s "$f" "$W/nosha/$b" 2>/dev/null || true
    done
    printf 'PATH="%s:%s"\n' "$SANDBOX/bin" "$W/nosha" >> "$CONF"
    mkissue 70 ""; waitid 70 8001 8002
    mkreply 70 901 req-bot "<!-- requester-bot-reply wait=8001 -->"
    tick
    chk "没有 sha256sum 时照样补打" "$(backfills 70)" 1
    chk "  到达性 · 这台「机器」上确实没有 sha256sum、有 shasum" \
        "$(PATH="$W/nosha" command -v sha256sum >/dev/null 2>&1 && echo has || echo none)/$(PATH="$W/nosha" command -v shasum >/dev/null 2>&1 && echo has || echo none)" "none/has"

    section "【6e】按标签派工 + 托管：只挂托管标签的 issue、托管 PR 都由 daemon 补打；托管 PR 不加 pending/review、不发接手说明"
    fresh "${REQ_ON[@]}" 'LABEL_AUTOPILOT="autopilot"'
    mkissue 80 "autopilot"; ev 80 labeled autopilot maint 8800; waitid 80 8801 8802
    mkreply 80 981 req-bot "<!-- requester-bot-reply wait=8801 -->"
    mkissue 7 "pending/PR"; mkpr 8 feature/issue-7 "做了 X。

Closes #7" "autopilot"
    ev 8 labeled autopilot maint 8900; waitid 8 8901 8902
    mkreply 8 991 req-bot "认可当前提交。

<!-- requester-bot-reply wait=8901 -->"
    mkissue 81 ""; waitid 81 8951 8952
    mkreply 81 995 req-bot "<!-- requester-bot-reply wait=8951 -->"
    tick
    chk "只挂托管标签的 issue #80 → 补打一次、本轮不派" "$(backfills 80)/$(queued issue 80)" "1/no"
    chk "托管 PR #8 → 补打一次" "$(backfills 8)" 1
    chk "托管 PR #8 没加 pending/review、没发接手说明" "$(has_label 8 pending/review)/$(comments_with 8 'autopilot-takeover pr=8')" "no/0"
    chk "按标签派工的普通条目 #81 → 不补打（只认机器人自己的标签，和今天一样）" "$(backfills 81)" 0
    tick
    chk "下一轮：#80、PR #8 都走明确派工进队列" "$(queued issue 80)/$(queued PR 8)" "yes/yes"
    chk "下一轮仍没有接手说明、不再补打" "$(comments_with 8 'autopilot-takeover pr=8')/$(backfills 8)" "0/0"

    section "【6f】greedy + 托管都开：同一个托管 PR 先后经过两处入口，整轮只有一个写请求"
    fresh "${REQ_ON[@]}" 'LABEL_AUTOPILOT="autopilot"' 'DISPATCH_MODE="greedy"'
    mkissue 7 "pending/PR"; mkpr 8 feature/issue-7 "做了 X。

Closes #7" "autopilot"
    ev 8 labeled autopilot maint 8900; waitid 8 8901 8902
    mkreply 8 991 req-bot "<!-- requester-bot-reply wait=8901 -->"
    tick
    chk "整轮只有一个补打写请求、没加 pending/review" "$(backfills 8)/$(has_label 8 pending/review)" "1/no"

    section "【6g】机器人的派工标签晚到（派工已摘掉补打的标签之后才打）→ 不再补打，按现有明确派工再派一次（真实轮询跨三轮）"
    # 派工脚本换成桩：记一次派工，再走真实的「翻 doing/agent」（摘掉派工标签和等待标签）；其余是真实 agent-poll.sh
    rm -rf "$SANDBOX/stubscripts"; cp -r "$SCRIPTS" "$SANDBOX/stubscripts"
    local d
    for d in dispatch-new-issue.sh dispatch-issue-comment.sh dispatch-pr-comment.sh; do
        printf '#!/usr/bin/env bash\nset -uo pipefail\nsource "$(dirname "$0")/_lib.sh"\necho "$1" >> "$STATE_DIR/stub-dispatched"\nflip_to_doing "$1" "stub" || true\n' > "$SANDBOX/stubscripts/$d"
    done
    fresh "${REQ_ON[@]}" 'DISPATCH_MODE="greedy"' 'MAX_CONCURRENT_WORKERS=1'
    stick() { : > "$CALLS"; : > "$W/state/poll.log" 2>/dev/null; env CODING_AGENT_CONFIG="$CONF" bash "$SANDBOX/stubscripts/agent-poll.sh" >/dev/null 2>&1; }
    dispatched() { grep -cx "$1" "$W/state/stub-dispatched" 2>/dev/null || echo 0; }
    mkissue 78 ""; waitid 78 8781 8782
    mkreply 78 978 req-bot "<!-- requester-bot-reply wait=8781 -->"
    stick
    chk "第 1 轮：补打、不派" "$(backfills 78)/$(dispatched 78)" "1/0"
    stick
    chk "第 2 轮：明确派工派 1 次，派工时摘掉了 pending/agent、挂上 doing/agent" "$(dispatched 78)/$(has_label 78 pending/agent)/$(has_label 78 doing/agent)" "1/no/yes"
    # worker 干完交出（条目回到没有流程标签）；机器人这时才打上自己的 pending/agent
    jset labels.json '.["78"] = []'; ev 78 unlabeled doing/agent loop-bot 8786
    ev 78 labeled pending/agent req-bot 8787; jset labels.json '.["78"] = ["pending/agent"]'
    stick
    chk "第 3 轮：机器人晚到的标签 → 再派 1 次（共 2 次），daemon 没再补打" "$(dispatched 78)/$(backfills 78)" "2/0"

    section "【6h】对接文档里读等待事件编号的命令：只给 HOME / PATH 照字面跑，产出的说明被 daemon 认出"
    fresh "${REQ_ON[@]}" 'DISPATCH_MODE="greedy"'
    mkissue 79 ""; waitid 79 8791 8792; waitid 79 8793 8794
    mkdir -p "$W/docbin"
    printf '#!/usr/bin/env bash\nexport FAKE_GH_DIR=%q FAKE_GH_REPO=example/ap\nexec %q "$@"\n' "$GD" "$SANDBOX/bin/gh" > "$W/docbin/gh"
    chmod +x "$W/docbin/gh"
    local doc_e
    doc_e=$(sed -n '/<!-- requester-bot-reply-ops:begin -->/,/<!-- requester-bot-reply-ops:end -->/p' "$REPO_DIR/docs/requester-bot.zh.md" \
        | sed -n '/^ *```bash/,/^ *```$/p' | sed '1d;$d' | sed 's/^   //' \
        | sed -e 's|OWNER/REPO|example/ap|' -e 's|/issues/123/|/issues/79/|' -e 's|pending/requester-bot|pending/req|' \
        | env -i HOME="$HOME" PATH="$W/docbin:/usr/bin:/bin" bash 2>/dev/null)
    chk "文档命令读出的是最近一次挂等待标签的编号" "$doc_e" 8793
    # 前页已输出、后页失败（gh --paginate 先吐出第一页再退出 22）：命令一个编号都不能输出
    mkdir -p "$W/docbin-partial"
    printf '#!/usr/bin/env bash\necho 100\nexit 22\n' > "$W/docbin-partial/gh"; chmod +x "$W/docbin-partial/gh"
    local doc_partial
    doc_partial=$(sed -n '/<!-- requester-bot-reply-ops:begin -->/,/<!-- requester-bot-reply-ops:end -->/p' "$REPO_DIR/docs/requester-bot.zh.md" \
        | sed -n '/^ *```bash/,/^ *```$/p' | sed '1d;$d' | sed 's/^   //' \
        | sed -e 's|OWNER/REPO|example/ap|' -e 's|/issues/123/|/issues/79/|' -e 's|pending/requester-bot|pending/req|' \
        | env -i HOME="$HOME" PATH="$W/docbin-partial:/usr/bin:/bin" bash 2>/dev/null)
    chk "文档命令：前页有输出、后页读失败 → 什么编号都不输出" "[$doc_partial]" "[]"
    mkreply 79 979 req-bot "答复

<!-- requester-bot-reply wait=$doc_e -->"
    tick
    chk "按文档写的说明 → 被认出、补打" "$(backfills 79)" 1
    chk "中英文两份文档里的命令块一致（除注释）" \
        "$(diff <(sed -n '/requester-bot-reply-ops:begin/,/requester-bot-reply-ops:end/p' "$REPO_DIR/docs/requester-bot.zh.md" | grep -v '^ *#') \
                <(sed -n '/requester-bot-reply-ops:begin/,/requester-bot-reply-ops:end/p' "$REPO_DIR/docs/requester-bot.md" | grep -v '^ *#') >/dev/null && echo same || echo diff)" same
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
    [ -n "$f" ] && [ -f "$f" ] && sed "s|$root|<ROOT>|g" "$f" | strip_review_converge   # GitHub#621 的两段不归这里的对拍管
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
        chk "$name：带「同一条答复上一轮已处理就不重复做」那一句（第二次派工的提示同样是它）" "$(printf '%s' "$n" | grep -c '这条答复上一轮已处理')" 1
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

echo
echo "正式版：$pass 通过 / $fail 失败"
report_counts "$pass" "$fail"
[ "$fail" -eq 0 ]
