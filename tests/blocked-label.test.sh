#!/usr/bin/env bash
# kind: e2e
# 等前置标签：前置完成后自动接着干 —— GitHub#157。
#
# 跑法：bash tests/blocked-label.test.sh              （默认不跑末尾的负对照）
#       MUTATION=1 bash tests/blocked-label.test.sh   （连负对照一起跑，见 tests/lib/mutation.sh）
# 依赖：bash、jq、python3、git。不碰网络：假 GitHub（tests/lib/fake_github.py，有状态：标签、
# 标签记录、评论、「Blocked by」关系）+ 假 tmux，HOME 指向临时目录。每一轮都**真的**起
# agent-poll.sh 子进程；提示词走真实的派工脚本（dispatch-new-issue.sh / dispatch-issue-comment.sh）。
#
# 这块错了的方向都不报错，只会悄悄派错工或永远不派：
#   · 「查不到」当成「已完成」→ 前置没合并就开工；当成「没有前置」→ 无端交人
#   · 判定之后不重读 → 判定与写入之间人加了 pending/human / 新前置，照样自动开工
#   · 认了任何人写的标记 → 外部用户一句评论就能决定什么时候开工
#   · 功能关着也改了状态文件 / 提示词 → 没开这项的项目悄悄变了
#   · 有条目在等时轮询照样退避到 30 分钟 → 「前置完成后几分钟接上」落空
set -uo pipefail
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
# shellcheck source=lib/mutation.sh
source "$TEST_DIR/lib/mutation.sh"
# shellcheck source=lib/compat.sh
source "$TEST_DIR/lib/compat.sh"

SANDBOX=$(mktemp -d)
trap '[ -n "${KEEP_SANDBOX:-}" ] && echo "SANDBOX=$SANDBOX" || rm -rf "$SANDBOX"' EXIT
mkdir -p "$SANDBOX/bin" "$SANDBOX/home"
export HOME="$SANDBOX/home"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 TZ=UTC
unset CODING_AGENT_RELEASE_ROOT LABEL_PENDING_BLOCKED LABEL_AUTOPILOT DISPATCH_AUTOPILOT DISPATCH_AUTOPILOT_ISSUE DISPATCH_AUTOPILOT_PR
unset GH_TOKEN WRITE_GH_TOKEN GITHUB_TOKEN POLL_FAKE_NOW

bash "$TEST_DIR/lib/fake_gh_client.sh" install "$SANDBOX/bin/gh" python3 "$TEST_DIR/lib/fake_github.py"
cat > "$SANDBOX/bin/tmux" <<'SH'
#!/usr/bin/env bash
case "$1" in has-session) exit 1 ;; ls|list-sessions) exit 1 ;; esac
exit 0
SH
chmod +x "$SANDBOX/bin/gh" "$SANDBOX/bin/tmux"

pass=0; fail=0; QUIET=0; FAILED_NAMES=""
chk() {
    if [ "$2" = "$3" ]; then
        [ "$QUIET" = 1 ] || echo "  ✅ $1"; pass=$((pass+1))
    else
        [ "$QUIET" = 1 ] || echo "  ❌ $1 (期望 [$3]，实得 [$2])"; fail=$((fail+1)); FAILED_NAMES+="[$1]"
    fi
}
section() { [ "$QUIET" = 1 ] || echo "$1"; }

# ── 改动前的版本：merge-base 上的 scripts/，配本版的 prompts/（守的是「功能关着时脚本不改拼法」）──
BASE_REV=$(git -C "$REPO_DIR" merge-base HEAD origin/main 2>/dev/null || git -C "$REPO_DIR" rev-parse HEAD~1)
mkdir -p "$SANDBOX/old"
git -C "$REPO_DIR" archive "$BASE_REV" scripts | tar -x -C "$SANDBOX/old"
cp -r "$REPO_DIR/prompts" "$SANDBOX/old/prompts"
mkdir -p "$SANDBOX/new"; cp -r "$REPO_DIR/scripts" "$REPO_DIR/prompts" "$SANDBOX/new/"

T0=1790000000   # 受控时钟的起点（agent-poll 的节奏和细查间隔都读 POLL_FAKE_NOW）

# ─────────────────────────────────────────────────────────────────────────
# 轮询场景。$1 = 被测的根目录（含 scripts/ prompts/）。$2 = 只跑哪几组（空 = 全部）
# ─────────────────────────────────────────────────────────────────────────
run_poll_scenarios() {
    local ROOT="$1" ONLY="${2:-}" W="$SANDBOX/run"
    export FAKE_GH_REPO="example/ap"
    local R="repos/example/ap"
    local CONF STATE CALLS GD
    want() { [ -z "$ONLY" ] || case " $ONLY " in *" $1 "*) return 0 ;; esac; [ -z "$ONLY" ]; }

    fresh() {   # [额外配置行…]
        rm -rf "$W"; mkdir -p "$W/state" "$W/wt" "$W/gh"
        git init -q "$W/project" 2>/dev/null
        GD="$W/gh"; export FAKE_GH_DIR="$GD"; CALLS="$GD/calls.log"; STATE="$W/state/state.json"
        CONF="$W/cavil-loop.config"
        cat > "$CONF" <<CONF
REPO="example/ap"
PROJECT_ROOT="$W/project"
WORKTREE_BASE="$W/wt"
STATE_DIR="$W/state"
TMUX_PREFIX="bltest"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
LABEL_AGENT_DOING="doing/agent"
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
        EVN=0; CMN=0
        echo '{}' > "$GD/items.json"; echo '{}' > "$GD/labels.json"; echo '{}' > "$GD/events.json"
        echo '{}' > "$GD/comments.json"; echo '{}' > "$GD/perms.json"; echo '{}' > "$GD/blocked_by.json"
        echo loop-bot > "$GD/me"
    }
    on() { fresh 'LABEL_PENDING_BLOCKED="pending/blocked"' "$@"; }
    jset() { local f="$GD/$1" e="$2"; shift 2; jq "$@" "$e" "$f" > "$f.tmp" && mv "$f.tmp" "$f"; }
    mkissue() {   # <n> <labels_csv> [state] [state_reason]
        jset items.json '.[$n] = {kind:"issue", state:$s, title:"t", body:"需求", user:{login:"maint"}, updated_at:"2026-01-01T00:00:00Z"}
                         | if $r == "" then . else .[$n].state_reason = $r end' \
            --arg n "$1" --arg s "${3:-open}" --arg r "${4:-}"
        jset labels.json '.[$n] = ($l | split(",") | map(select(. != "")))' --arg n "$1" --arg l "$2"
    }
    mkpr() {   # <n> <labels_csv> [open|merged|closed]
        local st="${3:-open}"
        jset items.json '.[$n] = {kind:"pr", state:(if $s == "open" then "open" else "closed" end), merged:($s == "merged"),
                draft:false, title:"t", body:"x", user:{login:"loop-bot"}, updated_at:"2026-01-01T00:00:00Z",
                head:{sha:"1111111111111111111111111111111111111111", ref:("feature/issue-" + $n), repo:{full_name:"example/ap"}}, base:{ref:"main"}}' \
            --arg n "$1" --arg s "$st"
        jset labels.json '.[$n] = ($l | split(",") | map(select(. != "")))' --arg n "$1" --arg l "$2"
    }
    set_state() { jset items.json '.[$n].state = $s | if $r == "" then del(.[$n].state_reason) else .[$n].state_reason = $r end' --arg n "$1" --arg s "$2" --arg r "${3:-}"; }
    ev() {   # <n> <labeled|unlabeled> <标签> [操作人]
        EVN=$((EVN + 1))
        jset events.json '.[$n] = ((.[$n] // []) + [{id:($i|tonumber), event:$e, label:{name:$l}, actor:{login:$a, type:"User"}, created_at:$c}])' \
            --arg n "$1" --arg e "$2" --arg l "$3" --arg a "${4:-loop-bot}" --arg i "$EVN" \
            --arg c "$(printf '2026-01-01T%02d:%02d:00Z' $((EVN / 60)) $((EVN % 60)))"
    }
    comment() {   # <n> <正文> [作者] [author_association] [时间]
        CMN=$((CMN + 1))
        jset comments.json '.[$n] = ((.[$n] // []) + [{id:(700 + ($i|tonumber)), body:$b, user:{login:$u}, author_association:$a, created_at:$t}])' \
            --arg n "$1" --arg b "$2" --arg u "${3:-loop-bot}" --arg a "${4:-COLLABORATOR}" --arg i "$CMN" \
            --arg t "${5:-$(printf '2026-01-02T00:%02d:00Z' "$CMN")}"
    }
    mark() {   # <n> <"#11 #12"> [resume] [作者] [author_association] [时间]
        comment "$1" "## 在等前置

<!-- agent-blocked-by: $2${3:+ resume=$3} -->" "${4:-loop-bot}" "${5:-COLLABORATOR}" "${6:-}"
    }
    # 一条在等的 issue 10：worker 挂的标签 + 标记等 issue 11
    waiting() {   # [前置] [resume]
        mkissue 10 "pending/blocked"
        ev 10 labeled pending/blocked
        mark 10 "${1:-#11}" "${2:-}"
    }

    tick() { : > "$CALLS"; env ${NOW:+POLL_FAKE_NOW=$NOW} CODING_AGENT_CONFIG="$CONF" bash "$ROOT/scripts/agent-poll.sh" >/dev/null 2>&1; }
    n_calls() { grep -cE -- "$1" "$CALLS" 2>/dev/null || true; }
    labels_of() { jq -r --arg n "$1" '(.[$n] // []) | sort | join(",")' "$GD/labels.json"; }
    has_label() { case ",$(labels_of "$1")," in *",$2,"*) echo yes ;; *) echo no ;; esac; }
    comments_with() { jq -r --arg n "$1" '(.[$n] // [])[].body' "$GD/comments.json" | grep -cF -- "$2" || true; }
    writes() { n_calls "^gh api -X (POST|PUT|DELETE|PATCH) "; }
    read_deps() { n_calls "^gh api --paginate --slurp $R/issues/$1/dependencies/blocked_by"; }
    yes_if_pos() { [ "${1:-0}" -gt 0 ] && echo yes || echo no; }
    log_has() { grep -cF -- "$1" "$W/state/poll.log" 2>/dev/null || true; }
    hook() {   # <路径 key> <第几次 GET> <shell 片段>
        printf '#!/usr/bin/env bash\nGD=%q\n%s\n' "$GD" "$3" > "$GD/hook_$1_$2"
    }
    queued() { grep -E '派工队列' "$W/state/poll.log" | tail -1 | grep -c "issue#$1(" || true; }

    # ── 【1】功能关着：和改动前逐字节一致 ──
    if want off; then
    section "【1】功能关着：轮询的 GitHub 调用、state.json 和改动前一致（多轮）"
    local side sides="old new" csame=0
    if compat_skip "功能关着：三轮轮询的 GitHub 调用、state.json 与改动前" "$SANDBOX/old" "$ROOT" scripts prompts; then
        sides="new"; csame=1
    fi
    for side in $sides; do
        fresh
        waiting; mkissue 11 "" closed completed
        mkissue 20 "pending/agent"; mkissue 21 "doing/agent,pending/blocked"
        local r; for r in 1 2 3; do
            if [ "$side" = old ]; then RR="$SANDBOX/old"; else RR="$ROOT"; fi
            : > "$CALLS"; env POLL_FAKE_NOW=$((T0 + r * 400)) CODING_AGENT_CONFIG="$CONF" bash "$RR/scripts/agent-poll.sh" >/dev/null 2>&1
            cp "$CALLS" "$SANDBOX/off-$side-calls-$r.log"
        done
        jq -S . "$STATE" > "$SANDBOX/off-$side-state.json"
        labels_of 10 > "$SANDBOX/off-$side-labels"
    done
    local same=same r
    if [ "$csame" = 0 ]; then
    for r in 1 2 3; do cmp -s "$SANDBOX/off-old-calls-$r.log" "$SANDBOX/off-new-calls-$r.log" || same=diff; done
    chk "关闭：三轮的 GitHub 调用逐条相同" "$same" same
    chk "关闭：state.json 逐字节相同" "$(cmp -s "$SANDBOX/off-old-state.json" "$SANDBOX/off-new-state.json" && echo same || echo diff)" same
    fi
    chk "关闭：state.json 没有新字段" "$(jq 'has("blocked_resume")' "$SANDBOX/off-new-state.json")" false
    chk "关闭：一次「Blocked by」都没读" "$(grep -c dependencies "$SANDBOX/off-new-calls-1.log" || true)" 0
    chk "关闭：挂着的等前置标签原样不动" "$(cat "$SANDBOX/off-new-labels")" "pending/blocked"
    chk "到达性 · 关闭时确实在轮询（读了 open 列表）" "$(yes_if_pos "$(grep -c "issues -f state=open" "$SANDBOX/off-new-calls-1.log")")" yes
    fi

    # ── 【2】主路径：前置 issue 以 completed 关闭 → 接力 ──
    if want resume; then
    section "【2】前置 issue 以「已完成」关闭 → 留言、翻回 pending/agent，下一轮进派工队列"
    on; waiting; mkissue 11 "" closed completed
    NOW=$T0 tick
    chk "留一条接力评论" "$(comments_with 10 'v=resume')" 1
    chk "评论里列出前置和结局" "$(comments_with 10 '#11：已完成并关闭')" 1
    chk "翻回 pending/agent" "$(has_label 10 pending/agent)" yes
    chk "摘掉等前置标签" "$(has_label 10 pending/blocked)" no
    chk "进度清掉" "$(jq -r '(.blocked_resume // {}) | has("10")' "$STATE")" false
    NOW=$((T0 + 60)) tick
    chk "下一轮进派工队列" "$(queued 10)" 1
    chk "不重复评论" "$(comments_with 10 'agent-blocked-resolved')" 1

    section "【2b】标记写了 resume=pending/agent/fable → 翻回 fable 队列；写了不认识的 → 回落默认"
    on; waiting "#11" "pending/agent/fable"; mkissue 11 "" closed completed
    NOW=$T0 tick
    chk "fable 队列" "$(labels_of 10)" "pending/agent/fable"
    on; waiting "#11" "Done"; mkissue 11 "" closed completed
    NOW=$T0 tick
    chk "不认识的恢复标签回落 pending/agent" "$(labels_of 10)" "pending/agent"

    section "【2c】只有原生「Blocked by」关系（没有标记）也认"
    on; mkissue 10 "pending/blocked"; ev 10 labeled pending/blocked maint
    mkissue 11 "" closed completed; jset blocked_by.json '.["10"] = [11]'
    NOW=$T0 tick
    chk "原生关系的前置完成 → 接力" "$(labels_of 10)" "pending/agent"

    section "【2d】被挡的是 PR、等的是 PR：PR 已合并 → 接力"
    on; mkpr 30 "pending/blocked"; ev 30 labeled pending/blocked; mark 30 "#31"; mkpr 31 "" merged
    NOW=$T0 tick
    chk "PR 30 翻回 pending/agent" "$(labels_of 30)" "pending/agent"
    chk "评论写前置已合并" "$(comments_with 30 '#31：已合并')" 1
    fi

    # ── 【3】失败收场 → 交人 ──
    if want failed; then
    section "【3】前置失败收场 → 交人，写明哪个前置怎么收场"
    local c
    for c in "pr-unmerged:PR 没合并就关了" "not_planned:关闭为「不做」" "no-reason:没写关闭原因" "missing:读不到（不存在" "foreign:别的仓库"; do
        on
        case "${c%%:*}" in
            pr-unmerged) waiting "#31"; mkpr 31 "" closed ;;
            not_planned) waiting; mkissue 11 "" closed not_planned ;;
            no-reason) waiting; mkissue 11 "" closed ;;
            missing) waiting "#99" ;;
            foreign) waiting; mkissue 11 "" closed completed; jset blocked_by.json '.["10"] = ["other/repo#5"]' ;;
        esac
        NOW=$T0 tick
        chk "${c%%:*} → 交人" "$(labels_of 10)" "pending/human"
        chk "${c%%:*} → 评论写明原因" "$(yes_if_pos "$(comments_with 10 "${c#*:}")")" yes
        chk "${c%%:*} → 没翻回派工标签" "$(has_label 10 pending/agent)" no
    done
    fi

    # ── 【4】部分完成 / 读失败 → 不写；恢复后才写 ──
    if want wait; then
    section "【4】还有没完成的前置 → 什么都不写；读失败 → 不写，恢复后下一轮才写"
    on; waiting "#11 #12"; mkissue 11 "" closed completed; mkissue 12 ""
    NOW=$T0 tick
    chk "部分完成：不写" "$(writes)" 0
    chk "到达性 · 这一轮读了 #10 的「Blocked by」" "$(yes_if_pos "$(read_deps 10)")" yes
    chk "到达性 · 这一轮读了还开着的 #12" "$(yes_if_pos "$(n_calls "^gh api $R/issues/12\$")")" yes
    NOW=$((T0 + 60)) tick
    chk "5 分钟内不重复细查" "$(read_deps 10)" 0
    set_state 12 closed completed
    NOW=$((T0 + 301)) tick
    chk "过了细查间隔、前置全部完成 → 接力" "$(labels_of 10)" "pending/agent"

    local f
    for f in issues_11 issues_10_comments issues_10_events issues_10_dependencies_blocked_by; do
        on; waiting; mkissue 11 "" closed completed
        : > "$GD/F_$f"
        NOW=$T0 tick
        chk "读 $f 失败 → 不写" "$(writes)" 0
        chk "读 $f 失败 → 标签不动" "$(labels_of 10)" "pending/blocked"
        chk "到达性 · 读 $f 失败那一轮确实读过 #10" "$(yes_if_pos "$(n_calls "^gh api $R/issues/10\$")")" yes
        rm -f "$GD/F_$f"
        NOW=$((T0 + 301)) tick
        chk "读 $f 恢复后 → 接力" "$(labels_of 10)" "pending/agent"
    done
    fi

    # ── 【5】读全了但没有前置 → 交人一次 ──
    if want none; then
    section "【5】挂了标签但找不到前置 → 评论一次 + 交人；再跑一轮不重复"
    on; mkissue 10 "pending/blocked"; ev 10 labeled pending/blocked
    NOW=$T0 tick
    chk "交人" "$(labels_of 10)" "pending/human"
    chk "评论说明找不到在等谁" "$(comments_with 10 '## 挂了等前置标签，但找不到在等谁')" 1
    NOW=$((T0 + 400)) tick
    chk "再跑一轮不重复评论" "$(comments_with 10 '## 挂了等前置标签，但找不到在等谁')" 1
    fi

    # ── 【6】判定之后、写之前的变化（受控交错）──
    if want race; then
    section "【6】第一次判定后、写之前：变化了就本轮不写"
    race_case() {   # <路径 key> <第几次 GET> <说明> <钩子里跑的 shell>
        on; waiting; mkissue 11 "" closed completed; mkissue 12 ""
        hook "$1" "$2" "$4"
        NOW=$T0 tick
        chk "$3 → 本轮不写" "$(writes)" 0
        chk "到达性 · $3：第二次判定确实发生（钩子跑了）" "$(yes_if_pos "$(cat "$GD/count_$1" 2>/dev/null)")" yes
    }
    race_case issues_10 2 "人加了 pending/human" \
        'jq '"'"'.["10"] += ["pending/human"]'"'"' $GD/labels.json > $GD/x && mv $GD/x $GD/labels.json'
    race_case issues_10_comments 2 "新增一个没完成的前置（新标记）" \
        'jq '"'"'.["10"] += [{id:999, body:"<!-- agent-blocked-by: #11 #12 -->", user:{login:"loop-bot"}, author_association:"COLLABORATOR", created_at:"2026-01-03T00:00:00Z"}]'"'"' $GD/comments.json > $GD/x && mv $GD/x $GD/comments.json'
    race_case issues_10_dependencies_blocked_by 2 "原生关系新增一个没完成的前置" \
        'jq '"'"'.["10"] = [12]'"'"' $GD/blocked_by.json > $GD/x && mv $GD/x $GD/blocked_by.json'
    race_case issues_10_events 2 "等前置标签摘了又挂" \
        'jq '"'"'.["10"] += [{id:900, event:"unlabeled", label:{name:"pending/blocked"}, created_at:"2026-01-01T00:00:01Z"}, {id:901, event:"labeled", label:{name:"pending/blocked"}, created_at:"2026-01-01T00:00:02Z"}]'"'"' $GD/events.json > $GD/x && mv $GD/x $GD/events.json'
    race_case issues_11 2 "前置被重开" \
        'jq '"'"'.["11"].state = "open" | del(.["11"].state_reason)'"'"' $GD/items.json > $GD/x && mv $GD/x $GD/items.json'
    race_case issues_10 2 "条目被关" \
        'jq '"'"'.["10"].state = "closed"'"'"' $GD/items.json > $GD/x && mv $GD/x $GD/items.json'
    # 对照：同样的布置、没有钩子 → 写了（上面的「不写」不是因为根本没判到第二次）
    on; waiting; mkissue 11 "" closed completed
    NOW=$T0 tick
    chk "对照 · 没有变化 → 写了" "$(labels_of 10)" "pending/agent"
    chk "对照 · 判了两次（#10 读了两遍）" "$(n_calls "^gh api $R/issues/10\$")" 2
    fi

    # ── 【7】人叫停 / 在别的流程里 → 不动 ──
    if want stop; then
    section "【7】同时挂着 pending/human（人叫停）等 → 前置完成也不动"
    local L
    for L in pending/human pending/PR Done; do
        on; waiting; mkissue 11 "" closed completed
        jset labels.json '.["10"] += [$l]' --arg l "$L"
        NOW=$T0 tick
        chk "挂着 $L → 不写" "$(writes)" 0
        chk "挂着 $L → 一次细查都没有" "$(read_deps 10)" 0
        chk "到达性 · 挂着 $L 那一轮在轮询" "$(yes_if_pos "$(n_calls "issues -f state=open")")" yes
    done
    fi

    # ── 【8】写到一半失败 → 只补没做完的；到上限放弃 ──
    if want retry; then
    section "【8】评论成功、翻标签失败 → 下一轮只翻标签不重复评论；一直失败到上限就放弃"
    on; waiting; mkissue 11 "" closed completed
    : > "$GD/F_post_labels"
    NOW=$T0 tick
    chk "评论发了" "$(comments_with 10 'v=resume')" 1
    chk "标签没翻成" "$(labels_of 10)" "pending/blocked"
    chk "进度记下「已评论」" "$(jq -r '.blocked_resume["10"].commented' "$STATE")" true
    rm -f "$GD/F_post_labels"
    NOW=$((T0 + 60)) tick
    chk "恢复后翻成" "$(labels_of 10)" "pending/agent"
    chk "没有重复评论" "$(comments_with 10 'v=resume')" 1

    on 'BLOCKED_MAX_TRIES=2'; waiting; mkissue 11 "" closed completed
    : > "$GD/F_post_comment"
    NOW=$T0 tick; NOW=$((T0 + 60)) tick
    chk "到上限放弃并记日志" "$(yes_if_pos "$(log_has '连续 2 次失败 → 放弃')")" yes
    chk "放弃后留在等前置标签上" "$(labels_of 10)" "pending/blocked"
    rm -f "$GD/F_post_comment"
    NOW=$((T0 + 120)) tick
    chk "放弃后不再自动写" "$(writes)" 0
    fi

    # ── 【9】谁写的标记才算 ──
    if want trust; then
    section "【9】外部用户伪造的标记、本轮等待之前的旧标记 → 不认"
    on; mkissue 10 "pending/blocked"; ev 10 labeled pending/blocked
    mark 10 "#11" "" evil NONE; mkissue 11 "" closed completed
    NOW=$T0 tick
    chk "外部用户的标记不认 → 当作没有前置，交人" "$(labels_of 10)" "pending/human"
    chk "外部用户的标记不认 → 没翻回派工标签" "$(comments_with 10 'v=resume')" 0

    on; mkissue 10 "pending/blocked"
    mark 10 "#11" "" loop-bot COLLABORATOR "2026-01-01T00:00:30Z"
    ev 10 labeled pending/blocked; ev 10 unlabeled pending/blocked; ev 10 labeled pending/blocked
    mkissue 11 "" closed completed
    NOW=$T0 tick
    chk "上一轮等待留下的旧标记不认 → 交人" "$(labels_of 10)" "pending/human"

    on; mkissue 10 "pending/blocked"; ev 10 labeled pending/blocked
    mark 10 "#11" "" maint MEMBER; mkissue 11 "" closed completed
    NOW=$T0 tick
    chk "维护者（MEMBER）写的标记认" "$(labels_of 10)" "pending/agent"

    # 代码复审第 1 轮：GitHub 的时间只到秒。旧登记和摘标签同一秒 → 分不出先后，不能当本轮前置
    # （ev 按调用次序编时间：第 N 个事件是 00:0N:00，所以摘标签那条是 00:02:00）
    on; mkissue 10 "pending/blocked"; mkissue 11 "" closed completed
    ev 10 labeled pending/blocked
    mark 10 "#11" "" loop-bot COLLABORATOR "2026-01-01T00:02:00Z"
    ev 10 unlabeled pending/blocked; ev 10 labeled pending/blocked
    NOW=$T0 tick
    chk "和摘标签同一秒的旧登记不认 → 不自动开工" "$(has_label 10 pending/agent)" no
    chk "和摘标签同一秒的旧登记不认 → 没有接力评论" "$(comments_with 10 'v=resume')" 0
    chk "和摘标签同一秒的旧登记不认 → 交人说明找不到前置" "$(comments_with 10 'v=none')" 1
    # 对照：同样的布置，登记晚摘标签一秒 → 是本轮的，接力
    on; mkissue 10 "pending/blocked"; mkissue 11 "" closed completed
    ev 10 labeled pending/blocked; ev 10 unlabeled pending/blocked; ev 10 labeled pending/blocked
    mark 10 "#11" "" loop-bot COLLABORATOR "2026-01-01T00:02:01Z"
    NOW=$T0 tick
    chk "对照 · 晚摘标签一秒的登记认 → 接力" "$(labels_of 10)" "pending/agent"
    fi

    # ── 【9b】交人之后，人照评论里的步骤恢复等待：整个生命周期走一遍 ──
    if want recover; then
    section "【9b】失败收场 / 找不到前置交人后，照 daemon 评论的步骤重新等别的前置 → 先等着，完成后接力"
    # 人在 GitHub 上动手：都走假 GitHub 的接口（时间是现在，和真接口一样晚于 daemon 的写入）
    as_human() { echo maint > "$GD/me"; env FAKE_GH_DIR="$GD" "$SANDBOX/bin/gh" "$@" >/dev/null 2>&1; echo loop-bot > "$GD/me"; }
    local entry kind
    for entry in failed-marker failed-native none; do
        on; mkissue 12 ""
        case "$entry" in
            failed-marker) waiting "#11"; mkissue 11 "" closed not_planned ;;
            failed-native) mkissue 10 "pending/blocked"; ev 10 labeled pending/blocked maint
                           mkissue 11 "" closed not_planned; jset blocked_by.json '.["10"] = [11]' ;;
            none) mkissue 10 "pending/blocked"; ev 10 labeled pending/blocked ;;
        esac
        NOW=$T0 tick
        chk "$entry：先交人" "$(labels_of 10)" "pending/human"
        local body; body=$(jq -r '.["10"][-1].body' "$GD/comments.json")
        # 评论里的步骤（人只看这条评论）：改前置、摘 pending/human、重新挂 pending/blocked、成功的样子
        chk "$entry：步骤里有「Blocked by」怎么改" "$(printf '%s' "$body" | grep -c 'Add blocked by')" 1
        chk "$entry：步骤里有等 PR 时的登记写法" "$(printf '%s' "$body" | grep -c '<!-- agent-blocked-by: #编号 -->')" 1
        chk "$entry：步骤里有「摘掉 pending/human」" "$(printf '%s' "$body" | grep -c '摘掉本条的 `pending/human` 标签')" 1
        chk "$entry：步骤里有「重新挂 pending/blocked」" "$(printf '%s' "$body" | grep -c '重新挂\*\* `pending/blocked`')" 1
        chk "$entry：步骤里写了成功的样子" "$(printf '%s' "$body" | grep -c '成功的样子')" 1
        # daemon 写给人看的评论（GitHub#237）：写明「人」「daemon」，不用「你」「我」
        chk "$entry：交人评论不用「你」「我」" "$(printf '%s' "$body" | grep -cE '[你我]')" 0
        case "$entry" in failed-*) chk "$entry：标题写「交给人决定」" "$(printf '%s' "$body" | grep -c '^## 前置没有完成，交给人决定$')" 1 ;; esac
        sleep 1.2   # 和 daemon 摘标签不在同一秒（GitHub 的时间只到秒）
        # 照做：第 1 步（失败的那个原生关系去掉、改等 #12；或发登记评论）
        case "$entry" in
            failed-native) jset blocked_by.json '.["10"] = [12]' ;;
            *) as_human api -X POST "repos/example/ap/issues/10/comments" -f "body=改等 #12
<!-- agent-blocked-by: #12 -->" ;;
        esac
        as_human api -X DELETE "repos/example/ap/issues/10/labels/pending%2Fhuman"   # 第 2 步
        as_human api -X POST "repos/example/ap/issues/10/labels" -f "labels[]=pending/blocked"   # 第 3 步
        NOW=$((T0 + 400)) tick
        chk "$entry：照做后、#12 还开着 → 只挂着等前置标签" "$(labels_of 10)" "pending/blocked"
        chk "$entry：照做后、#12 还开着 → daemon 不留言" "$(writes)" 0
        chk "到达性 · $entry：照做后那一轮确实细查了它" "$(yes_if_pos "$(read_deps 10)")" yes
        set_state 12 closed completed
        NOW=$((T0 + 800)) tick
        chk "$entry：#12 完成 → 接力" "$(labels_of 10)" "pending/agent"
        chk "$entry：#12 完成 → 留「前置已完成」" "$(comments_with 10 'v=resume')" 1
        body=$(jq -r '.["10"][-1].body' "$GD/comments.json")
        chk "$entry：「前置已完成」写明本条不需要人做任何事" "$(printf '%s' "$body" | grep -c '本条不需要人做任何事')" 1
        chk "$entry：「前置已完成」不用「你」「我」" "$(printf '%s' "$body" | grep -cE '[你我]')" 0
    done
    fi

    # ── 【10】轮询节奏 ──
    if want pace; then
    section "【10】轮询节奏：首次发现按原退避；发现后最长 5 分钟一查；不在等时回到原阶梯"
    # 这一组测的是等前置的封顶和原阶梯本身；空闲轻量检查（GitHub#252）会让「首次发现」提前到
    # 下一个 tick、并把 30 分钟档封到 10 分钟，那一套由 tests/poll-probe.test.sh 测，这里关掉。
    on 'POLL_BACKOFF_LADDER="86400:300,259200:600,604800:1800"' 'POLL_IDLE_PROBE=false'
    mkissue 10 ""; mkissue 11 ""
    NOW=$T0 tick
    local fp; fp=$(jq -r .fingerprint "$W/state/poll-pace.json")
    # 已经安静 8 天、退避到 30 分钟一轮
    jq -n --argjson nd $((T0 + 1800)) --argjson lp $T0 --argjson la $((T0 - 8 * 86400)) --arg fp "$fp" \
        '{next_due:$nd, last_poll:$lp, last_active:$la, fail_streak:0, fingerprint:$fp}' > "$W/state/poll-pace.json"
    # 这时有人挂上等前置标签（前置 11 还开着）
    jset labels.json '.["10"] = ["pending/blocked"]'; ev 10 labeled pending/blocked maint; mark 10 "#11" "" maint MEMBER
    NOW=$((T0 + 60)) tick
    chk "11a 首次发现：60 秒时仍按原档位跳过（不打 GitHub）" "$(wc -l < "$CALLS" | tr -d ' ')" 0
    NOW=$((T0 + 360)) tick
    chk "11a 首次发现：6 分钟时仍跳过" "$(wc -l < "$CALLS" | tr -d ' ')" 0
    NOW=$((T0 + 1800)) tick
    chk "11a 首次发现：到原档位（30 分钟）才读到它" "$(yes_if_pos "$(read_deps 10)")" yes
    chk "11b 发现之后：下一轮间隔封顶 5 分钟" "$(jq '.next_due - .last_poll' "$W/state/poll-pace.json")" 300
    set_state 11 closed completed
    NOW=$((T0 + 1800 + 250)) tick
    chk "11b 封顶后 4 分多钟仍不跑（没到期）" "$(wc -l < "$CALLS" | tr -d ' ')" 0
    NOW=$((T0 + 1800 + 300)) tick
    chk "11b 前置完成后 5 分钟这一轮接力（距完成 ≤ 6 分钟）" "$(labels_of 10)" "pending/agent"

    # 11c：没有在等的条目时节奏和原阶梯一样；挂着 pending/human 的等前置条目不加快
    local case_
    for case_ in none stopped; do
        on 'POLL_BACKOFF_LADDER="86400:300,259200:600,604800:1800"' 'POLL_IDLE_PROBE=false'
        mkissue 10 ""
        [ "$case_" = stopped ] && { jset labels.json '.["10"] = ["pending/blocked","pending/human"]'; ev 10 labeled pending/blocked; }
        NOW=$T0 tick
        fp=$(jq -r .fingerprint "$W/state/poll-pace.json")
        jq -n --argjson nd $((T0 + 1800)) --argjson lp $T0 --argjson la $((T0 - 8 * 86400)) --arg fp "$fp" \
            '{next_due:$nd, last_poll:$lp, last_active:$la, fail_streak:0, fingerprint:$fp}' > "$W/state/poll-pace.json"
        NOW=$((T0 + 1800)) tick
        chk "11c $case_：下一轮仍按原阶梯 30 分钟" "$(jq '.next_due - .last_poll' "$W/state/poll-pace.json")" 1800
    done
    fi

    # ── 【11】greedy / 自愈 / 手动接着干 / 托管 ──
    if want flow; then
    section "【11】greedy 兜底不收它；自愈不翻它；手动打 pending/agent 照常派；托管不收它"
    on 'DISPATCH_MODE="greedy"'
    mkissue 10 "pending/blocked"; mkissue 40 ""
    NOW=$T0 tick
    chk "greedy：只挂等前置标签 → 不进派工队列" "$(queued 10)" 0
    chk "到达性 · greedy 这一轮确实收了别的条目" "$(queued 40)" 1

    on; mkissue 21 "doing/agent,pending/blocked"; mkissue 22 "doing/agent"
    NOW=$T0 tick
    chk "自愈：挂着等前置标签的 doing/agent 不翻回触发标签" "$(labels_of 21)" "doing/agent,pending/blocked"
    chk "到达性 · 自愈确实翻了没挂等前置标签的那条" "$(labels_of 22)" "pending/agent"

    on; mkissue 10 "pending/agent,pending/blocked"
    NOW=$T0 tick
    chk "手动打了 pending/agent → 进派工队列" "$(queued 10)" 1
    chk "手动打了 pending/agent → 等前置检查不碰它" "$(read_deps 10)" 0
    # 派工翻 doing/agent 时一并摘掉等前置标签（三个派工脚本共用的那一步）
    env FAKE_GH_DIR="$GD" CODING_AGENT_CONFIG="$CONF" bash -c 'source "$1/scripts/_lib.sh" 2>/dev/null; flip_to_doing 10 test' _ "$ROOT" >/dev/null 2>&1
    chk "派工翻 doing/agent 时摘掉等前置标签" "$(labels_of 10)" "doing/agent"

    on 'LABEL_PENDING_REVIEW="pending/review"' 'LABEL_AUTOPILOT="autopilot"'
    echo '{"maint":"admin"}' > "$GD/perms.json"
    mkissue 10 "autopilot,pending/blocked"; ev 10 labeled autopilot maint
    mkissue 41 "autopilot"; ev 41 labeled autopilot maint
    NOW=$T0 tick
    chk "托管：挂着等前置标签的托管 issue 不当作派工" "$(queued 10)" 0
    chk "到达性 · 托管这一轮确实收了只挂托管标签的 issue" "$(queued 41)" 1
    fi
}

# ─────────────────────────────────────────────────────────────────────────
# 提示词：真实的派工脚本写出的那份
# ─────────────────────────────────────────────────────────────────────────
# 假 gh：issue 标题；拆分子项三项核对（父子关系 / 正文标记 / 作者是写入账号）
cat > "$SANDBOX/bin/gh-prompt" <<'SH'
#!/usr/bin/env bash
args="$*"; jqx=""
while [ $# -gt 0 ]; do [ "$1" = --jq ] && jqx="$2"; shift; done
out='{}'
case "$args" in
    *"api user"*) out='{"login":"loop-bot"}' ;;
    *issues/987822/parent*) out='{"number":987800,"repository_url":"https://api.github.com/repos/example/none"}' ;;
    *issues/*/parent*) echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;
    *issues/987822*) out='{"number":987822,"title":"测试标题","user":{"login":"loop-bot"},"body":"子项\n\n<!-- agent-split-from: #987800 -->"}' ;;
    *issues/*) out='{"number":1,"title":"测试标题","user":{"login":"maint"},"body":"x"}' ;;
esac
if [ -n "$jqx" ]; then printf '%s' "$out" | jq -r "$jqx"; else printf '%s\n' "$out"; fi
SH
chmod +x "$SANDBOX/bin/gh-prompt"
mkdir -p "$SANDBOX/pbin"; cp "$SANDBOX/bin/tmux" "$SANDBOX/pbin/tmux"; cp "$SANDBOX/bin/gh-prompt" "$SANDBOX/pbin/gh"

PROJ="$SANDBOX/proj"
git init -q --bare "$PROJ/upstream.git"
git clone -q "$PROJ/upstream.git" "$PROJ/seed" 2>/dev/null
( cd "$PROJ/seed" && git config user.email t@example.invalid && git config user.name t && echo x > f \
  && git add -A && git commit -qm init && git push -q origin HEAD:main ) >/dev/null 2>&1

N_NEW=987811; N_CMT=987812; N_SUB=987822
render() {   # <根目录> <开关：on|off> <输出目录>
    local root="$1" sw="$2" out="$3" w kind f
    w="$out.work"; rm -rf "$w" "$out"; mkdir -p "$w/state" "$w/wt" "$out"
    git clone -q "$PROJ/upstream.git" "$w/project" 2>/dev/null
    {
        cat <<CONF
REPO="example/none"
PROJECT_ROOT="$w/project"
WORKTREE_BASE="$w/wt"
STATE_DIR="$w/state"
TMUX_PREFIX="blp"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
LABEL_AGENT_DOING="doing/agent"
WORKER_AGENT_DEFAULT="claude"
PATH="$SANDBOX/pbin:\$PATH"
GH_TOKEN="fake-token-for-test"
CONF
        [ "$sw" = on ] && echo 'LABEL_PENDING_BLOCKED="pending/blocked"'
    } > "$w/config"
    rm -f "/tmp/cavil-loop-issue-$N_NEW-prompt.md" "/tmp/cavil-loop-issue-$N_SUB-prompt.md" "/tmp/cavil-loop-issue-$N_CMT-cmt-0.md"
    local e=(env -u CODING_AGENT_RELEASE_ROOT -u LABEL_PENDING_BLOCKED HOME="$SANDBOX/home" CODING_AGENT_CONFIG="$w/config")
    (cd "$w/project" && "${e[@]}" bash "$root/scripts/dispatch-new-issue.sh" "$N_NEW") >/dev/null 2>&1
    (cd "$w/project" && "${e[@]}" bash "$root/scripts/dispatch-new-issue.sh" "$N_SUB") >/dev/null 2>&1
    (cd "$w/project" && "${e[@]}" bash "$root/scripts/dispatch-issue-comment.sh" "$N_CMT" 0) >/dev/null 2>&1
    for kind in new-issue:"/tmp/cavil-loop-issue-$N_NEW-prompt.md" sub-issue:"/tmp/cavil-loop-issue-$N_SUB-prompt.md" issue-comment:"/tmp/cavil-loop-issue-$N_CMT-cmt-0.md"; do
        f="${kind#*:}"; kind="${kind%%:*}"
        if [ -s "$f" ]; then
            sed -e "s|$root|<ROOT>|g" -e "s|$w|<W>|g" -e 's/20[0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9]/<TS>/g' "$f" > "$out/$kind.md"
        fi
        rm -f "$f"
    done
}
compose_out() {   # <根目录> <开关> <kind>：拼装结果（review / pr-comment 这两类不走上面的派工脚本）
    local c="$SANDBOX/compose-$2.config"
    {
        cat <<CONF
REPO="example/none"
PROJECT_ROOT="$PROJ/seed"
STATE_DIR="$SANDBOX/cstate-$2"
WORKTREE_BASE="$SANDBOX/cwt"
TMUX_PREFIX="blc"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
LABEL_AGENT_DOING="doing/agent"
WORKER_AGENT_DEFAULT="claude"
PATH="$SANDBOX/pbin:\$PATH"
GH_TOKEN="fake-token-for-test"
CONF
        [ "$2" = on ] && echo 'LABEL_PENDING_BLOCKED="pending/blocked"'
    } > "$c"
    mkdir -p "$SANDBOX/cstate-$2"
    env -u CODING_AGENT_RELEASE_ROOT -u LABEL_PENDING_BLOCKED HOME="$SANDBOX/home" CODING_AGENT_CONFIG="$c" \
        bash -c 'source "$1/scripts/_lib.sh" 2>/dev/null; f=$(compose_prompt_template "$2"); cat "$f"' _ "$1" "$3"
}

# 一组提示词检查。$1 = 根目录。打印每条检查的结果（chk）
run_prompt_checks() {
    local R="$1" O="$SANDBOX/pout" k csame=0
    mkdir -p "$O"
    compat_skip "提示词 · 功能关着时五类提示词与改动前的派工脚本" "$SANDBOX/old" "$R" scripts prompts && csame=1
    [ "$csame" = 1 ] || [ -d "$O/old-off" ] || render "$SANDBOX/old" off "$O/old-off"
    render "$R" off "$O/off"; render "$R" on "$O/on"
    for k in new-issue sub-issue issue-comment; do
        [ "$csame" = 0 ] || continue
        chk "提示词 · 关闭：$k 和改动前的派工脚本逐字节一致" \
            "$( [ -s "$O/off/$k.md" ] && cmp -s "$O/off/$k.md" "$O/old-off/$k.md" && echo same || echo diff)" same
    done
    for k in pr-comment review; do
        compose_out "$R" off "$k" > "$O/off-$k.md"
        [ "$csame" = 0 ] || continue
        compose_out "$SANDBOX/old" off "$k" > "$O/old-off-$k.md"
        chk "提示词 · 关闭：$k 拼装和改动前逐字节一致" \
            "$( [ -s "$O/off-$k.md" ] && cmp -s "$O/off-$k.md" "$O/old-off-$k.md" && echo same || echo diff)" same
    done
    chk "提示词 · 到达性：子项那份真的走了子项路径（含子项说明）" "$(grep -c '只做本子项正文写明的那一块' "$O/off/sub-issue.md" || true)" 1
    chk "提示词 · 关闭：拆分仍是「有前置 → 等人点」" "$(grep -c '有前置 → `flip_label $SUB --add pending/human`' "$O/off/issue-comment.md" || true)" 1

    for k in new-issue sub-issue issue-comment; do
        chk "提示词 · 开启：$k 带等前置规则" "$(grep -c '^# 等前置规则（本项目开启了等前置标签 `pending/blocked`）' "$O/on/$k.md" || true)" 1
        chk "提示词 · 开启：$k 没有没换掉的占位" "$(grep -cE '@@[A-Z_]+@@|\$\{LABEL_PENDING_AGENT\}' "$O/on/$k.md" || true)" 0
    done
    chk "提示词 · 开启：标记里的恢复标签渲染成派你来的标签" "$(grep -c 'agent-blocked-by: #12 #34 resume=pending/agent -->' "$O/on/issue-comment.md" || true)" 1
    chk "提示词 · 开启：拆分改成「有前置 → 挂等前置标签」" "$(grep -c '再挂 `pending/blocked`；前置合并后 daemon 会自动' "$O/on/issue-comment.md" || true)" 1
    # 子项那份：覆盖「前置还没合并 → 交人」的那一段必须排在子项说明之后（后文覆盖前文）
    local a b
    a=$(grep -n '只做本子项正文写明的那一块' "$O/on/sub-issue.md" | head -1 | cut -d: -f1)
    b=$(grep -n '那条改成：照「等前置规则」登记前置' "$O/on/sub-issue.md" | head -1 | cut -d: -f1)
    chk "提示词 · 开启：子项那份的「前置没合并」改成挂等前置标签，且排在子项说明之后" \
        "$( [ -n "$a" ] && [ -n "$b" ] && [ "$b" -gt "$a" ] && echo after || echo "no(${a:-?}/${b:-?})")" after
    compose_out "$R" on pr-comment > "$O/on-pr-comment.md"
    chk "提示词 · 开启：pr-comment 拼装也带等前置规则" "$(grep -c '^# 等前置规则' "$O/on-pr-comment.md" || true)" 1
}

# ─────────────────────────────────────────────────────────────────────────
echo "── 提示词 ──"
run_prompt_checks "$SANDBOX/new"
echo "── 轮询 ──"
run_poll_scenarios "$SANDBOX/new"

# ─────────────────────────────────────────────────────────────────────────
# 【12】负对照：沙盘副本逐个改坏，对应那组检查必须变红
# ─────────────────────────────────────────────────────────────────────────
echo "── 负对照 ──"
MUT_BAD=0
mutant() {   # <名字> <文件> <原文> <改成> <跑哪组：prompt 或 run_poll_scenarios 的组名>
    mutation_gate || return 0
    local name="$1" file="$2" from="$3" to="$4" groups="$5" M="$SANDBOX/mut"
    rm -rf "$M"; mkdir -p "$M"; cp -r "$REPO_DIR/scripts" "$REPO_DIR/prompts" "$M/"
    if ! python3 - "$M/$file" "$from" "$to" <<'PY'
import sys
p, a, b = sys.argv[1:4]
s = open(p).read()
if s.count(a) < 1: sys.exit(1)
open(p, "w").write(s.replace(a, b, 1))
PY
    then echo "  ❌ 负对照「$name」准备失败：原文找不到"; MUT_BAD=$((MUT_BAD + 1)); return 0; fi
    local p0=$pass f0=$fail
    QUIET=1
    if [ "$groups" = prompt ]; then run_prompt_checks "$M"; else run_poll_scenarios "$M" "$groups"; fi
    QUIET=0
    local nf=$((fail - f0))
    pass=$p0; fail=$f0
    if [ "$nf" -gt 0 ]; then echo "  ✅ 负对照「$name」：$nf 条检查变红"; pass=$((pass + 1))
    else echo "  ❌ 负对照「$name」：改坏了却全绿"; fail=$((fail + 1)); fi
}
mutant "issue 关成「不做」也算完成" scripts/_lib.sh 'elif .state_reason == "completed" then "completed"' 'elif .state == "closed" then "completed"' failed
mutant "读不到前置当成已完成" scripts/_lib.sh '                _bfail "读不到前置 #$p"; return 2' '                o=completed' wait
mutant "写前不重判" scripts/_lib.sh 'if [ "$rc" != 0 ] || [ "$d2" != "$d1" ]; then' 'if false; then' race
mutant "标记不核对作者" scripts/_lib.sh '| select(((.user.login // "") | ascii_downcase) == ($me | ascii_downcase)' '| select(true or ((.user.login // "") | ascii_downcase) == ($me | ascii_downcase)' trust
mutant "旧标记也认" scripts/_lib.sh '| select($since == "" or (.created_at // "") > $since) ]' '| select(true) ]' trust
mutant "同一秒的旧登记也认（回到 >=）" scripts/_lib.sh '| select($since == "" or (.created_at // "") > $since) ]' '| select($since == "" or (.created_at // "") >= $since) ]' trust
mutant "交人步骤不写摘 pending/human" scripts/_lib.sh '2. **解除人工等待**：摘掉本条的 `%s` 标签\n3.' '2. **解除人工等待**：%s\n3.' recover
mutant "不看人叫停" scripts/_lib.sh '    if stop=$(blocked_stop_reason "$labels_csv"); then
        jq -cn' '    if false; then
        jq -cn' race
mutant "等待期间不封顶轮询" scripts/agent-poll.sh 'if [ "${BLOCKED_WAITING:-0}" = 1 ]; then pace_cap="$BLOCKED_RECHECK_SECS"; fi' ':' pace
mutant "评论不记进度（重试时重复评论）" scripts/_lib.sh "            rec=\$(printf '%s' \"\$rec\" | jq -c '.commented = true')" "            rec=\$(printf '%s' \"\$rec\" | jq -c '.commented = false')" retry
mutant "self-heal 不跳过等前置" scripts/agent-poll.sh '    if labels_have_blocked "$labels_csv"; then
        SELFHEAL_BLOCKED' '    if false; then
        SELFHEAL_BLOCKED' flow
mutant "greedy 不挡等前置" scripts/_lib.sh '        "${LABEL_PENDING_MERGE:-}" \
        "${LABEL_PENDING_BLOCKED:-}"' '        "${LABEL_PENDING_MERGE:-}"' flow
mutant "派工不摘等前置标签" scripts/_lib.sh '[ -z "$LABEL_PENDING_BLOCKED" ] || BLOCKED_DISPATCH_CLEAR=("$LABEL_PENDING_BLOCKED")' ':' flow
mutant "功能关着也写状态" scripts/_lib.sh '    BLOCKED_WAITING=0; BLOCKED_ACTED=0
    blocked_enabled || return 0' '    BLOCKED_WAITING=0; BLOCKED_ACTED=0
    blocked_state_set "$sf" ".blocked_resume = (.blocked_resume // {})" || true
    blocked_enabled || return 0' off
mutant "拼装时不加等前置规则" scripts/_lib.sh '        if blocked_enabled; then
            printf' '        if false; then
            printf' prompt
mutant "子项不追加覆盖段" scripts/dispatch-new-issue.sh 'if blocked_enabled; then printf' 'if false; then printf' prompt
mutant "功能关着也加规则" scripts/_lib.sh '        if blocked_enabled; then
            printf' '        if true; then
            printf' prompt

echo
echo "通过 $pass，失败 $fail"
[ "$MUT_BAD" = 0 ] || echo "负对照准备失败 $MUT_BAD 项"
mutation_summary "$0"
compat_summary
report_counts "$pass" "$fail"
[ "$fail" = 0 ] && [ "$MUT_BAD" = 0 ]
