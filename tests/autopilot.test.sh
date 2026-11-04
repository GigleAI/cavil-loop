#!/usr/bin/env bash
# 托管标签：方案只过复审、复审与测试通过后 daemon 自动合并 —— GitHub#114。
#
# 跑法：bash tests/autopilot.test.sh              （默认不跑末尾的负对照）
#       MUTATION=1 bash tests/autopilot.test.sh   （连负对照一起跑：整套场景在每份改坏的脚本副本上
#       各重跑一遍，见 tests/lib/mutation.sh）
#       MUTATION=1 AUTOPILOT_MUT_SHARD=K/N …      （只跑第 K 份负对照；开 N 个进程并行，见【10】）
# 依赖：bash、jq、python3、git。不碰网络：假 GitHub（tests/lib/fake_github.py，有状态：标签、
# 标签记录、评论、合并接口）+ 假 tmux，HOME 指向临时目录。每一轮都**真的**起 agent-poll.sh 子进程，
# 假 GitHub 把每一次调用记下来，「合没合、翻了什么标签、说了什么」都从调用和状态里读，不读源码。
#
# 这块错了的方向都不报错，只会悄悄合进不该合的东西：
#   · 授权只看「标签在不在」→ 被注入的 worker 给自己的 issue 打个标签就能自动合并
#   · PR 和 issue 的绑定只看正文 / 只看分支 → 任何 PR 都能借走别人的授权
#   · 判定之后不重读 → 判定与合并之间的叫停拦不住
#   · 读不到当成「有授权」/「没冲突」/「检查通过」
#   · 复审之后的新推送不重审、不核对复审的测试重跑记录
# 功能关闭时：提示词、轮询的 GitHub 调用、state.json 与改动前（merge-base）逐字节一致。
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
unset CODING_AGENT_RELEASE_ROOT LABEL_AUTOPILOT DISPATCH_AUTOPILOT DISPATCH_AUTOPILOT_ISSUE

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

# ── 改动前的版本（功能关闭时逐字节对拍用）──
BASE_REV=$(git -C "$REPO_DIR" merge-base HEAD origin/main 2>/dev/null || git -C "$REPO_DIR" rev-parse HEAD~1)
mkdir -p "$SANDBOX/old"
git -C "$REPO_DIR" archive "$BASE_REV" scripts prompts | tar -x -C "$SANDBOX/old"
# 旧脚本拼的是当前的模板：这里对拍的是「功能关闭时脚本没改变拼法」，模板本身的改动（GitHub#125
# 这类只改措辞的 PR）是有意的，不该让这条变红——和 requester-bot 测试的做法一致
rm -rf "$SANDBOX/old/prompts"; cp -r "$REPO_DIR/prompts" "$SANDBOX/old/prompts"

H1=1111111111111111111111111111111111111111
H2=2222222222222222222222222222222222222222

# ─────────────────────────────────────────────────────────────────────────
# 一整套轮询场景。$1 = 被测的 scripts 目录。
# ─────────────────────────────────────────────────────────────────────────
run_scenarios() {
    local SCRIPTS="$1" W="$SANDBOX/run"
    export FAKE_GH_REPO="example/ap"
    local R="repos/example/ap"
    local CONF STATE CALLS GD

    # 每个场景从干净的假 GitHub 和 state 开始
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
TMUX_PREFIX="aptest"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
LABEL_AGENT_DOING="doing/agent"
LABEL_PENDING_REVIEW="pending/review"
LABEL_AUTOPILOT="autopilot"
POST_MERGE_RETROSPECTIVE=false
AUTO_CLEANUP_ON_MERGE=false
PENDING_HUMAN_CONFLICT_CHECK=false
POLL_BACKOFF_LADDER=""
PRICE_AUTO_FETCH=0
MAX_CONCURRENT_WORKERS=0
AUTOPILOT_UNKNOWN_MAX=3
PATH="$SANDBOX/bin:\$PATH"
CONF
        local l; for l in "$@"; do printf '%s\n' "$l" >> "$CONF"; done
        EVN=0
        echo '{}' > "$GD/items.json"; echo '{}' > "$GD/labels.json"; echo '{}' > "$GD/events.json"
        echo '{}' > "$GD/comments.json"; echo '{"maint":"admin","helper":"read"}' > "$GD/perms.json"
        echo '{}' > "$GD/checks.json"; echo '{}' > "$GD/files.json"; echo loop-bot > "$GD/me"
    }
    jset() {   # <文件> <jq 表达式> [jq 参数…]：原地改假 GitHub 的状态
        local f="$GD/$1" e="$2"; shift 2
        jq "$@" "$e" "$f" > "$f.tmp" && mv "$f.tmp" "$f"
    }
    mkissue() {   # <n> <labels_csv> [作者]
        jset items.json '.[$n] = {kind:"issue", state:"open", title:"t", body:"需求", user:{login:$a}, updated_at:"2026-01-01T00:00:00Z"}' \
            --arg n "$1" --arg a "${3:-maint}"
        jset labels.json '.[$n] = ($l | split(",") | map(select(. != "")))' --arg n "$1" --arg l "$2"
    }
    mkpr() {   # <n> <分支> <正文> <提交> <labels_csv> [来源仓库] [mergeable] [mergeable_state]
        jset items.json '.[$n] = {kind:"pr", state:"open", merged:false, draft:false, title:"t", body:$b,
                user:{login:"loop-bot"}, updated_at:"2026-01-01T00:00:00Z",
                head:{sha:$h, ref:$r, repo:{full_name:$repo}}, base:{ref:"main"},
                mergeable:($m | fromjson), mergeable_state:$ms}' \
            --arg n "$1" --arg r "$2" --arg b "$3" --arg h "$4" --arg repo "${6:-example/ap}" \
            --arg m "${7:-true}" --arg ms "${8:-clean}"
        jset labels.json '.[$n] = ($l | split(",") | map(select(. != "")))' --arg n "$1" --arg l "$5"
    }
    # 每条记录带时间（和真 GitHub 一样），按调用先后递增；daemon 自己写的标签记录用当前时间，一定更晚。
    # 要比 daemon 写的还晚（「daemon 交人之后，维护者重新授权」）就给 EV_AT 一个将来的时间
    ev() {   # <n> <labeled|unlabeled> <标签> <操作人> [类型]
        EVN=$((EVN + 1))
        jset events.json '.[$n] = ((.[$n] // []) + [{event:$e, label:{name:$l}, actor:{login:$a, type:$t}, created_at:$c}])' \
            --arg n "$1" --arg e "$2" --arg l "$3" --arg a "$4" --arg t "${5:-User}" \
            --arg c "${EV_AT:-$(printf '2026-01-01T%02d:%02d:00Z' $((EVN / 60)) $((EVN % 60)))}"
    }
    review_rec() {   # <pr> <提交> [时间] [目标分支，"-" = 不记（旧版记录）]：派复审时 daemon 记下的那份
        [ -f "$STATE" ] || echo '{}' > "$STATE"
        jq --arg p "$1" --arg h "$2" --arg t "${3:-2026-01-01T00:00:00Z}" --arg b "${4:-main}" \
            '.autopilot.prs[$p] = ({reviewed_head:$h, reviewed_at:$t} + (if $b == "-" then {} else {reviewed_base:$b} end))' \
            "$STATE" > "$STATE.tmp" && mv "$STATE.tmp" "$STATE"
    }
    evidence() {   # <pr> <提交> <通过> <失败> [发评论的账号] [时间]
        jset comments.json '.[$p] = ((.[$p] // []) + [{id:(900 + ((.[$p] // []) | length)), user:{login:$u}, created_at:$t,
                body:("## ✅ 复审通过\n\n跑了 bash tests/x.test.sh\n\n<!-- autopilot-review-pass head=" + $h + " passed=" + $ok + " failed=" + $bad + " -->")}])' \
            --arg p "$1" --arg h "$2" --arg ok "$3" --arg bad "$4" --arg u "${5:-loop-bot}" --arg t "${6:-2026-06-01T00:00:00Z}"
    }
    # 一个准备好合并的托管 PR：issue 7（maint 打的托管标签）+ PR 8
    happy() {
        mkissue 7 "autopilot,pending/PR"
        ev 7 labeled autopilot maint
        mkpr 8 feature/issue-7 "做了 X。

Closes #7" "$H1" "pending/merge"
        review_rec 8 "$H1"
        evidence 8 "$H1" 12 0
    }

    tick() { : > "$CALLS"; env CODING_AGENT_CONFIG="$CONF" bash "$SCRIPTS/agent-poll.sh" >/dev/null 2>&1; }
    n_calls() { grep -cE -- "$1" "$CALLS" 2>/dev/null || true; }
    merged() { n_calls "^gh api -X PUT $R/pulls/$1/merge "; }
    merged_sha() { grep -E "^gh api -X PUT $R/pulls/$1/merge " "$CALLS" | grep -oE 'sha=[0-9a-f]+' | head -1 | cut -d= -f2; }
    labels_of() { jq -r --arg n "$1" '(.[$n] // []) | sort | join(",")' "$GD/labels.json"; }
    has_label() { case ",$(labels_of "$1")," in *",$2,"*) echo yes ;; *) echo no ;; esac; }
    comments_with() { jq -r --arg n "$1" '(.[$n] // [])[].body' "$GD/comments.json" | grep -cF -- "$2" || true; }
    writes() { n_calls "^gh api -X (POST|PUT|DELETE|PATCH) "; }
    st() { jq -r --arg p "$1" "(.autopilot.prs[\$p] // {}) | $2 // \"\"" "$STATE" 2>/dev/null; }
    log_has() { grep -cF -- "$1" "$W/state/poll.log" 2>/dev/null || true; }

    # ── 【1】主路径 ──
    section "【1】主路径：人只在 issue 上打托管标签，PR 上没有 → 合并复审审过的那个提交"
    fresh; happy
    tick
    chk "发出合并请求" "$(merged 8)" 1
    chk "合并请求带的是复审时记下的提交" "$(merged_sha 8)" "$H1"
    chk "合并方式默认 squash" "$(n_calls "merge_method=squash")" 1
    chk "issue 上留「已自动合并」说明" "$(comments_with 7 'autopilot-merged pr=8')" 1
    chk "说明里写了打标签的人" "$(comments_with 7 '`maint` 在本 issue 打的托管标签')" 1
    chk "合并后清掉这个 PR 的托管记录" "$(st 8 .reviewed_head)" ""
    chk "到达性 · 这一轮读了 issue 的标签记录" "$([ "$(n_calls "^gh api --paginate --slurp $R/issues/7/events")" -gt 0 ] && echo yes || echo no)" yes

    section "【1b】仓库配了自动检查且全部通过 → 合并；说明里写「全部通过」"
    fresh; happy
    jset checks.json '.[$h] = {check_runs:[{name:"test", status:"completed", conclusion:"success"}], statuses:[{context:"ci/x", state:"success"}]}' --arg h "$H1"
    tick
    chk "合并" "$(merged 8)" 1
    chk "说明写检查全部通过" "$(comments_with 7 '自动检查全部通过')" 1

    # ── 【2】授权 ──
    section "【2】授权：不是有写权限的真人在 issue 上打的 → 不合并、交人"
    local who
    for who in "loop-bot:User:loop 自己的写入账号" "helper:User:只有读权限" "renovate[bot]:Bot:Bot 账号" "req-bot:User:外部需求机器人账号"; do
        IFS=: read -r a t what <<< "$who"
        fresh 'REQUESTER_BOT_ACCOUNT="req-bot"'; happy
        jset events.json '.["7"] = [{event:"labeled", label:{name:"autopilot"}, actor:{login:$a, type:$t}}]' --arg a "$a" --arg t "$t"
        tick
        chk "$what 打的 → 不合并" "$(merged 8)" 0
        chk "$what 打的 → PR 交人" "$(has_label 8 pending/human)" yes
        chk "$what 打的 → 摘掉 pending/merge" "$(has_label 8 pending/merge)" no
    done

    fresh; happy
    ev 7 unlabeled autopilot maint; ev 7 labeled autopilot loop-bot
    tick
    chk "真人打过、摘掉后又被 loop 账号打回 → 以最后一次为准，不合并" "$(merged 8)" 0

    fresh; happy
    ev 7 unlabeled autopilot loop-bot; ev 7 labeled autopilot maint
    tick
    chk "被 loop 账号摘过、维护者又亲手打回 → 合并" "$(merged 8)" 1

    fresh; happy
    mkissue 7 "pending/PR"; jset events.json '.["7"] = []'
    jset labels.json '.["8"] = ["pending/merge","autopilot"]'; ev 8 labeled autopilot loop-bot
    tick
    chk "只有 PR 上挂托管标签（worker 打的），issue 上从没打过 → 不合并" "$(merged 8)" 0
    chk "  → PR 交人" "$(has_label 8 pending/human)" yes

    fresh 'REQUESTER_BOT_ACCOUNT="req-bot"'; happy
    mkissue 7 "autopilot,pending/PR" req-bot
    tick
    chk "外部需求机器人提的需求（误进了 pending/merge）→ 不合并" "$(merged 8)" 0
    chk "  → PR 交人" "$(has_label 8 pending/human)" yes

    # ── 【3】绑定 ──
    section "【3】PR 与 issue 的绑定：分支和正文必须同时只指向同一个 issue"
    local case_ br body repo
    for case_ in "feature/issue-9|Closes #7|example/ap|分支是别的 issue 的、正文借用 Closes #7" \
                 "feature/issue-7|Closes #9|example/ap|分支对、正文关闭别的 issue" \
                 "feature/issue-7|Closes
#7|example/ap|关键词和编号分在两行（有歧义）" \
                 "feature/issue-7|Closes #7
Closes #10|example/ap|正文还关闭了另一个 issue" \
                 "feature/issue-7-fix|Closes #7|example/ap|分支名带后缀" \
                 "feature/issue-7|Refs #7|example/ap|只有 Refs，没有关闭关键词" \
                 "feature/issue-7|Closes #7|someone/ap|来自外部仓库（fork）"; do
        IFS='|' read -r br body repo what <<< "$(printf '%s' "$case_" | tr '\n' '\001')"
        br=$(printf '%s' "$br" | tr '\001' '\n'); body=$(printf '%s' "$body" | tr '\001' '\n'); what=$(printf '%s' "$what" | tr '\001' '\n')
        fresh; happy
        mkpr 8 "$br" "$body" "$H1" "pending/merge" "$repo"
        tick
        chk "$what → 不合并" "$(merged 8)" 0
        chk "$what → PR 交人" "$(has_label 8 pending/human)" yes
    done
    fresh; happy
    mkpr 8 feature/issue-7 "Fixes: #7

Refs #3" "$H1" "pending/merge"
    tick
    chk "Fixes: #7（带冒号）+ 另有 Refs #3 → 合并（Refs 不关 issue）" "$(merged 8)" 1

    # ── 【4】叫停 ──
    section "【4】叫停：issue 摘托管标签、issue / PR 任一处打 pending/human"
    fresh; happy
    jset labels.json '.["7"] = ["pending/PR"]'; ev 7 unlabeled autopilot maint
    tick
    chk "issue 摘了托管标签 → 不合并" "$(merged 8)" 0
    chk "  → PR 交人，说明写已摘掉" "$(comments_with 8 '已摘掉（已叫停）')" 1
    fresh; happy
    jset labels.json '.["7"] += ["pending/human"]'
    tick
    chk "issue 上打 pending/human → 不合并" "$(merged 8)" 0
    chk "  → PR 交人" "$(has_label 8 pending/human)" yes
    fresh; happy
    jset labels.json '.["8"] += ["pending/human"]'
    tick
    chk "PR 上打 pending/human → 不合并" "$(merged 8)" 0
    chk "  → 摘掉 pending/merge" "$(has_label 8 pending/merge)" no
    chk "  → 是人自己叫停的，不留言" "$(comments_with 8 'cavil-loop daemon')" 0

    section "【4b】判定通过之后、合并之前有人叫停 → 最后一刻重读拦住，本轮什么都不记"
    local hk
    for hk in "issues_7|2|jq '.[\"7\"] = [\"pending/PR\"]' labels.json|issue 摘掉托管标签" \
              "issues_7|2|jq '.[\"7\"] += [\"pending/human\"]' labels.json|issue 打 pending/human" \
              "pulls_8|2|jq '.[\"8\"] += [\"pending/human\"]' labels.json|PR 打 pending/human" \
              "pulls_8|2|jq '.[\"8\"].head.sha = \"$H2\"' items.json|PR 推了新提交" \
              "issues_7_events|2|jq '.[\"7\"] += [{event:\"unlabeled\",label:{name:\"autopilot\"},actor:{login:\"maint\",type:\"User\"}},{event:\"labeled\",label:{name:\"autopilot\"},actor:{login:\"loop-bot\",type:\"User\"}}]' events.json|授权记录变成 loop 账号打的" \
              "commits_${H1}_check-runs|2|jq '.[\"$H1\"] = {check_runs:[{name:\"unit\",status:\"completed\",conclusion:\"failure\"}]}' checks.json|自动检查变红" \
              "commits_${H1}_check-runs|2|jq '.[\"$H1\"] = {check_runs:[{name:\"unit\",status:\"in_progress\"}]}' checks.json|自动检查重跑中" \
              "commits_${H1}_check-runs|2|jq '.[\"$H1\"] = {check_runs:[{name:\"unit\",status:\"completed\",conclusion:\"success\"}]}' checks.json|原本没有检查、新冒出一个" \
              "pulls_8_files|2|jq '.[\"8\"] = [{filename:\".github/workflows/x.yml\"}]' files.json|改动多了 .github/ 文件" \
              "pulls_8|2|jq '.[\"8\"] += {mergeable:false, mergeable_state:\"dirty\"}' items.json|变成与目标分支冲突" \
              "pulls_8|2|jq '.[\"8\"].base.ref = \"release\"' items.json|改投了别的目标分支" \
              "pulls_8|2|jq '.[\"8\"] = []' comments.json|复审的测试记录评论被删掉" \
              "pulls_8|2|jq '.[\"8\"][0].body = \"<!-- autopilot-review-pass head=$H1 passed=12 failed=1 -->\"' comments.json|复审的测试记录被改成有失败" \
              "pulls_8|2|jq '.[\"8\"][0].body = \"<!-- autopilot-review-pass head=$H2 passed=12 failed=0 -->\"' comments.json|复审的测试记录改成了别的提交"; do
        IFS='|' read -r key k cmd what <<< "$hk"
        fresh; happy
        # 检查「变红 / 重跑」的场景：一开始检查是通过的，才能单独测到重读检查这一步
        # （一开始没有检查的话，「新冒出检查」那一条也会拦住，分不出重读检查做没做）
        case "$what" in 自动检查变红|自动检查重跑中)
            jset checks.json '.[$h] = {check_runs:[{name:"unit", status:"completed", conclusion:"success"}]}' --arg h "$H1" ;;
        esac
        local f; f="${cmd##* }"
        printf 'cd %q && %s < /dev/null > %q.tmp && mv %q.tmp %q\n' "$GD" "$cmd" "$f" "$f" "$f" > "$GD/hook_${key}_$k"
        local before; before=$(jq -c '.autopilot' "$STATE")
        tick
        chk "$what（判定之后）→ 不合并" "$(merged 8)" 0
        chk "$what（判定之后）→ 本轮托管记录不变" "$(jq -c '.autopilot' "$STATE")" "$before"
        chk "到达性 · $what：确实走到了合并前重读" "$([ -f "$GD/count_$key" ] && [ "$(cat "$GD/count_$key")" -ge 2 ] && echo yes || echo no)" yes
    done

    # ── 【5】读不到 ──
    section "【5】读不到：不当成有授权，本轮零写入；恢复后照常合并；连续读不到交人"
    fresh; happy
    touch "$GD/F_issues_7_events"
    tick
    chk "标签记录读不到 → 不合并" "$(merged 8)" 0
    chk "  → 一次写调用都没有" "$(writes)" 0
    chk "  → 记一次判不了" "$(st 8 .unknown)" 1
    rm -f "$GD/F_issues_7_events"
    tick
    chk "恢复后 → 合并" "$(merged 8)" 1
    fresh; happy
    ev 7 unlabeled autopilot maint    # 记录说最后一次是摘掉，标签却还挂着：对不上
    tick
    chk "标签记录和当前标签对不上 → 判不了，不合并、不写" "$(merged 8)/$(writes)" "0/0"
    chk "  → 记一次判不了" "$(st 8 .unknown)" 1
    fresh; happy
    touch "$GD/F_collaborators_maint_permission"
    tick; tick
    chk "权限查不到两轮 → 还不交人" "$(has_label 8 pending/human)" no
    tick
    chk "第 3 轮（上限 3）→ 交人" "$(has_label 8 pending/human)" yes
    chk "  → 全程没合并" "$(merged 8)" 0
    fresh; happy
    touch "$GD/F_commits_${H1}_check-runs"
    tick
    chk "自动检查读不到 → 不合并、不写" "$(merged 8)/$(writes)" "0/0"

    # ── 【6】改动本身 ──
    section "【6】改动本身：复审之后的新推送、检查、冲突、.github/、复审的测试记录"
    fresh; happy; review_rec 8 "$H2"
    tick
    chk "复审看的不是现在这个提交 → 不合并" "$(merged 8)" 0
    chk "  → 重新交复审" "$(has_label 8 pending/review)/$(has_label 8 pending/merge)" "yes/no"
    fresh; happy; jset items.json '.["8"].base.ref = "release"'
    tick
    chk "复审时合进 main、现在改投 release（同一提交）→ 不合并" "$(merged 8)" 0
    chk "  → 重新交复审，说明写改投" "$(has_label 8 pending/review)/$(comments_with 8 '现在改投了 `release`')" "yes/1"
    fresh; happy; review_rec 8 "$H1" 2026-01-01T00:00:00Z -
    tick
    chk "复审记录没记目标分支（旧版记下的）→ 重新交复审" "$(merged 8)/$(has_label 8 pending/review)" "0/yes"
    fresh; happy; jq 'del(.autopilot)' "$STATE" > "$STATE.tmp" && mv "$STATE.tmp" "$STATE"
    tick
    chk "没有复审记录 → 重新交复审" "$(merged 8)/$(has_label 8 pending/review)" "0/yes"

    fresh; happy
    jset checks.json '.[$h] = {check_runs:[{name:"unit", status:"completed", conclusion:"failure"}]}' --arg h "$H1"
    tick
    chk "检查没过 → 不合并" "$(merged 8)" 0
    chk "  → 交回 worker（pending/agent）" "$(has_label 8 pending/agent)/$(has_label 8 pending/merge)" "yes/no"
    chk "  → 说明里点名没过的检查" "$(comments_with 8 '自动检查没过：unit')" 1
    chk "  → 打回计数 1" "$(st 8 .bounces)" 1

    fresh; happy
    jset checks.json '.[$h] = {statuses:[{context:"ci/slow", state:"pending"}]}' --arg h "$H1"
    tick
    chk "检查还在跑 → 不合并、不写" "$(merged 8)/$(writes)" "0/0"
    chk "  → 记下开始等的时间" "$([ -n "$(st 8 .checks_pending_since)" ] && echo yes || echo no)" yes
    jq '.autopilot.prs["8"].checks_pending_since = 1' "$STATE" > "$STATE.tmp" && mv "$STATE.tmp" "$STATE"
    tick
    chk "等了超过 6 小时 → 交人" "$(has_label 8 pending/human)" yes

    fresh; happy; mkpr 8 feature/issue-7 "Closes #7" "$H1" "pending/merge" example/ap false dirty
    tick
    chk "有冲突 → 交回 worker" "$(merged 8)/$(has_label 8 pending/agent)" "0/yes"
    fresh; happy; mkpr 8 feature/issue-7 "Closes #7" "$H1" "pending/merge" example/ap true dirty
    tick
    chk "只有合并状态说冲突（dirty）→ 也交回 worker" "$(merged 8)/$(has_label 8 pending/agent)" "0/yes"
    fresh; happy; mkpr 8 feature/issue-7 "Closes #7" "$H1" "pending/merge" example/ap null unknown
    tick
    chk "GitHub 还在算能否合并 → 等，不写" "$(merged 8)/$(writes)" "0/0"

    fresh; happy
    jset files.json '.["8"] = [{filename:"scripts/x.sh"},{filename:".github/workflows/ci.yml"}]'
    tick
    chk "改了 .github/ → 不合并、交人" "$(merged 8)/$(has_label 8 pending/human)" "0/yes"
    fresh; happy
    jset files.json '.["8"] = [{filename:"ci.yml", previous_filename:".github/ci.yml"}]'
    tick
    chk "从 .github/ 挪出来的文件也算 → 不合并" "$(merged 8)" 0

    local ecase
    for ecase in "无记录::" "失败数不是 0:$H1 12 1:" "通过数是 0:$H1 0 0:" "提交号对不上:$H2 12 0:" \
                 "不是写入账号发的:$H1 12 0 someone:" "早于派复审的时间:$H1 12 0 loop-bot 2025-01-01T00:00:00Z:"; do
        IFS=: read -r what eargs _ <<< "$ecase"
        fresh; happy; jset comments.json '.["8"] = []'
        # shellcheck disable=SC2086
        [ -z "$eargs" ] || evidence 8 $eargs
        tick
        chk "复审测试记录：$what → 不合并" "$(merged 8)" 0
        chk "复审测试记录：$what → 交人" "$(has_label 8 pending/human)" yes
    done

    fresh; happy; touch "$GD/F_merge_405"
    tick
    chk "GitHub 拒绝合并（仓库规则）→ 交人" "$(has_label 8 pending/human)" yes
    fresh; happy
    jq '.autopilot.prs["8"].bounces = 3' "$STATE" > "$STATE.tmp" && mv "$STATE.tmp" "$STATE"
    jset checks.json '.[$h] = {check_runs:[{name:"unit", status:"completed", conclusion:"failure"}]}' --arg h "$H1"
    tick
    chk "打回次数已到上限（3）再没过 → 交人而不是再打回" "$(has_label 8 pending/human)/$(has_label 8 pending/agent)" "yes/no"

    fresh 'LABEL_PENDING_REVIEW=""'; happy
    tick
    chk "项目没配复审关卡 → 合并这一段整个不动" "$(merged 8)/$(has_label 8 pending/merge)" "0/yes"

    # ── 【7】只挂托管标签的 issue 进派工队列 ──
    section "【7】只挂托管标签的 issue：维护者打的 → 当普通派工；别人打的 / 机器人需求 → 不派、说一次"
    fresh 'REQUESTER_BOT_ACCOUNT="req-bot"'
    mkissue 20 "autopilot"; ev 20 labeled autopilot maint
    mkissue 21 "autopilot"; ev 21 labeled autopilot loop-bot
    mkissue 22 "autopilot" req-bot; ev 22 labeled autopilot maint
    mkissue 23 "autopilot,pending/human"; ev 23 labeled autopilot maint
    tick
    chk "#20（维护者打的）进派工队列" "$(log_has '托管：issue #20 只挂着托管标签（maint 打的）')" 1
    chk "#21（loop 账号打的）不派" "$(log_has 'issue#21')" 0
    chk "#21 说明一次" "$(comments_with 21 'kind=actor-loop')" 1
    chk "#22（外部需求机器人的需求）不派" "$(log_has 'issue#22')" 0
    chk "#22 说明一次：按普通流程" "$(comments_with 22 'kind=requester-bot')" 1
    chk "#23（挂着 pending/human）不当新活收" "$(log_has '托管：issue #23')" 0
    tick
    chk "第二轮：说明不重复" "$(comments_with 21 'kind=actor-loop')/$(comments_with 22 'kind=requester-bot')" "1/1"
    chk "第二轮：issue 没变过，不再去查被拒那两条的标签记录" "$(n_calls "$R/issues/2[12]/events")" 0

    fresh 'LABEL_PENDING_REVIEW=""'
    mkissue 20 "autopilot"; ev 20 labeled autopilot maint
    tick
    chk "没配复审关卡：只挂托管标签的 issue 不派" "$(log_has '托管：issue #20 只挂着')" 0
    chk "  → 说一次、转人工" "$(comments_with 20 'kind=no-review-gate')/$(has_label 20 pending/human)" "1/yes"

    section "【7b】派工那一刻判定托管（拼不拼托管规则、记不记复审提交）"
    fresh 'MAX_CONCURRENT_WORKERS=5'
    mkissue 30 "autopilot,pending/agent"; ev 30 labeled autopilot maint
    mkissue 31 "autopilot,pending/agent"; ev 31 labeled autopilot loop-bot
    mkissue 7 "autopilot,pending/PR"; ev 7 labeled autopilot maint
    mkpr 8 feature/issue-7 "Closes #7" "$H1" "pending/review"
    mkissue 40 "pending/PR"
    mkpr 41 feature/issue-40 "Closes #40" "$H2" "pending/review"
    tick
    chk "#30（维护者授权）派工时是托管条目" "$(log_has '托管：issue #30 是托管条目')" 1
    chk "#31（loop 账号打的）派工时不是托管条目" "$(log_has '托管：issue #31 是托管条目')" 0
    chk "PR #8 派复审时是托管条目" "$(log_has '托管：pr #8 是托管条目（授权在 issue #7')" 1
    chk "PR #8 派复审时记下复审的提交" "$(st 8 .reviewed_head)" "$H1"
    chk "PR #8 派复审时记下复审的目标分支" "$(st 8 .reviewed_base)" main
    chk "PR #41（issue 没有托管标签）派复审时不记" "$(st 41 .reviewed_head)" ""

    section "【7c】只有 BSD 那种 date（不认 -d）的机器：派托管复审照常，不把整轮轮询带崩"
    mkdir -p "$SANDBOX/bsd"
    printf '#!/usr/bin/env bash\nfor a in "$@"; do case "$a" in -d|-d*|--date*) echo "date: illegal option -- d" >&2; exit 1 ;; esac; done\nexec %q "$@"\n' \
        "$(command -v date)" > "$SANDBOX/bsd/date"; chmod +x "$SANDBOX/bsd/date"
    fresh 'MAX_CONCURRENT_WORKERS=5' "PATH=\"$SANDBOX/bsd:$SANDBOX/bin:\$PATH\""
    mkissue 7 "autopilot,pending/PR"; ev 7 labeled autopilot maint
    mkpr 8 feature/issue-7 "Closes #7" "$H1" "pending/review"
    : > "$CALLS"; local trc=0
    env CODING_AGENT_CONFIG="$CONF" bash "$SCRIPTS/agent-poll.sh" >/dev/null 2>&1 || trc=$?
    chk "BSD date：轮询正常退出" "$trc" 0
    chk "BSD date：复审提交与时间都记下了" "$(st 8 .reviewed_head)/$([ -n "$(st 8 .reviewed_at)" ] && echo yes || echo no)" "$H1/yes"
    chk "到达性 · BSD date：替身确实拦过 -d（不是没走到）" "$(printf 'x' | env PATH="$SANDBOX/bsd:$PATH" date -u -d @0 >/dev/null 2>&1 && echo passed || echo blocked)" blocked

    # ── 【12】维护者在 PR 上打托管标签（GitHub#128）──
    section "【12】PR 上打托管标签：维护者亲手打的 → 接手、从复审重来直到合并"
    # 一条普通（非托管）PR：复审通过后 loop 账号翻了 pending/human 等人合并，维护者在 PR 上打托管标签
    pr_ready() {   # [给 PR 打托管标签的人] [类型]
        mkissue 7 "pending/PR"
        mkpr 8 feature/issue-7 "做了 X。

Closes #7" "$H1" "pending/human,autopilot"
        ev 8 labeled pending/human loop-bot
        ev 8 labeled autopilot "${1:-maint}" "${2:-User}"
    }
    took_none() {   # 没有流程标签的 PR 8 被接手了没有：加上复审、留了接手说明
        if [ "$(has_label 8 pending/review)/$(comments_with 8 'autopilot-takeover pr=8')" = "yes/1" ]; then echo yes; else echo no; fi
    }
    took() {   # PR 8 被接手了没有：翻到复审、摘掉 pending/human、留了接手说明
        if [ "$(has_label 8 pending/review)/$(has_label 8 pending/human)/$(comments_with 8 'autopilot-takeover pr=8')" = "yes/no/1" ]; then echo yes; else echo no; fi
    }
    fresh 'MAX_CONCURRENT_WORKERS=5'; pr_ready
    tick
    chk "接手：PR 翻到 pending/review、摘掉 pending/human、留一条说明" "$(took)" yes
    chk "  → 说明写明授权打在 PR 上" "$(comments_with 8 '`maint` 在 PR #8 上打了托管标签')" 1
    chk "  → 托管标签留着（daemon 不摘）" "$(has_label 8 autopilot)" yes
    chk "  → issue 一个标签都不动" "$(labels_of 7)" "pending/PR"
    chk "  → 同一轮不合并" "$(merged 8)" 0
    chk "到达性 · 接手前读了 PR 的标签记录" "$([ "$(n_calls "^gh api --paginate --slurp $R/issues/8/events")" -gt 0 ] && echo yes || echo no)" yes
    tick
    chk "下一轮派复审：是托管条目，授权写在 PR 上" "$(log_has '托管：pr #8 是托管条目（授权在 PR #8，maint 打的）')" 1
    chk "  → 记下复审的提交" "$(st 8 .reviewed_head)" "$H1"
    jset labels.json '.["8"] = ["pending/merge","autopilot"]'
    evidence 8 "$H1" 12 0 loop-bot 2099-01-01T00:00:00Z
    tick
    chk "复审通过、留了测试记录 → 合并" "$(merged 8)" 1
    chk "  → 合并说明写授权打在 PR 上" "$(comments_with 7 '`maint` 在 PR #8 上打的托管标签')" 1

    fresh; pr_ready
    jset labels.json '.["8"] = ["autopilot"]'; jset events.json '.["8"] = []'; ev 8 labeled autopilot maint
    tick
    chk "没有任何流程标签的 PR 打托管 → 也接手（加 pending/review）" "$(has_label 8 pending/review)/$(comments_with 8 'autopilot-takeover pr=8')" "yes/1"
    fresh; pr_ready
    jset labels.json '.["8"] = ["pending/review","autopilot"]'
    tick
    chk "已经在复审的 PR → 不接手、不说话" "$(writes)" 0

    section "【12b】PR 上的托管标签不是维护者打的、或对不上 issue → 不接手，PR 上说一次"
    for who in "loop-bot:User:loop 自己的写入账号:actor-loop" "helper:User:只有读权限:actor-perm" \
               "renovate[bot]:Bot:Bot 账号:actor-bot" "req-bot:User:外部需求机器人账号:actor-requester-bot"; do
        IFS=: read -r a t what k <<< "$who"
        fresh 'REQUESTER_BOT_ACCOUNT="req-bot"'; pr_ready "$a" "$t"
        tick
        chk "$what 在 PR 上打的 → 不接手" "$(took)/$(has_label 8 pending/human)" "no/yes"
        chk "$what 在 PR 上打的 → PR 上说一次" "$(comments_with 8 "kind=pr-$k")" 1
        tick
        chk "$what：再一轮不重复说、不再读 PR 的标签记录（PR 和 issue 都没变）" "$(comments_with 8 "kind=pr-$k")/$(n_calls "$R/issues/8/events")" "1/0"
    done
    fresh; pr_ready; mkpr 8 feature/issue-9 "Closes #7" "$H1" "pending/human,autopilot"
    tick
    chk "PR 对不上 issue（分支是 #9 的）→ 不接手、说一次" "$(took)/$(comments_with 8 'kind=pr-binding')" "no/1"
    fresh 'REQUESTER_BOT_ACCOUNT="req-bot"'; pr_ready; mkissue 7 "pending/PR" req-bot
    tick
    chk "issue 是外部需求机器人提的 → 不接手、说一次" "$(took)/$(comments_with 8 'kind=pr-requester-bot')" "no/1"
    fresh; pr_ready; jset items.json '.["7"].state = "closed"'
    tick
    chk "issue 已关闭 → 不接手、说一次" "$(took)/$(comments_with 8 'kind=pr-closed')" "no/1"
    fresh 'LABEL_PENDING_REVIEW=""'; pr_ready
    tick
    chk "项目没配复审关卡 → 不接手、说一次" "$(has_label 8 pending/human)/$(comments_with 8 'kind=no-review-gate')" "yes/1"

    section "【12c】叫停：PR 上 pending/human 打在托管标签之后、issue 上挂 pending/human → 不接手"
    fresh; pr_ready
    jset events.json '.["8"] = []'; ev 8 labeled autopilot maint; ev 8 labeled pending/human maint
    tick
    chk "pending/human 打在托管标签之后（叫停）→ 不接手、不说话" "$(took)/$(writes)" "no/0"
    fresh; pr_ready; jset labels.json '.["7"] += ["pending/human"]'
    tick
    chk "issue 上挂着 pending/human → 不接手、不说话" "$(took)/$(writes)" "no/0"

    # ── 授权判据的组合表：三个调用点（派复审、接手、合并前许可）各跑一遍 ──
    # 每行：名字 | issue 现在挂不挂托管 | PR 现在挂不挂 | 托管标签的事件序列（编号/l|u/操作人[/类型]，按时间先后） | 授权成立？
    section "【12d】授权判据：只有晚于两处所有「摘掉」的那次维护者亲手打标签才算（三个调用点各跑一遍）"
    local row name il pl seq want site got tk
    while IFS='|' read -r name il pl seq want; do
        [ -n "$name" ] || continue
        for site in merge takeover dispatch; do
            case "$site" in
                merge) fresh ;;
                takeover) fresh ;;
                dispatch) fresh 'MAX_CONCURRENT_WORKERS=5' ;;
            esac
            mkissue 7 "pending/PR$( [ "$il" = yes ] && echo ,autopilot)"
            case "$site" in
                merge) mkpr 8 feature/issue-7 "Closes #7" "$H1" "pending/merge$( [ "$pl" = yes ] && echo ,autopilot)"
                       review_rec 8 "$H1"; evidence 8 "$H1" 12 0 ;;
                takeover) mkpr 8 feature/issue-7 "Closes #7" "$H1" "pending/human$( [ "$pl" = yes ] && echo ,autopilot)"
                          ev 8 labeled pending/human loop-bot ;;
                dispatch) mkpr 8 feature/issue-7 "Closes #7" "$H1" "pending/review$( [ "$pl" = yes ] && echo ,autopilot)" ;;
            esac
            for tk in $seq; do
                IFS=/ read -r en ek ea et <<< "$tk"
                ev "$en" "$( [ "$ek" = l ] && echo labeled || echo unlabeled)" autopilot "$ea" "${et:-User}"
            done
            tick
            case "$site" in
                merge) got=$( [ "$(merged 8)" = 1 ] && echo yes || echo no ) ;;
                takeover) got=$(took) ;;
                dispatch) got=$( [ "$(log_has '托管：pr #8 是托管条目')" = 1 ] && echo yes || echo no ) ;;
            esac
            # 接手这一列的 PR 挂着 pending/human，而且它早于序列里的每一次操作：授权成立就该接手，
            # 不管授权是打在 PR 上还是 issue 上（PR 摘标交人之后在 issue 上重新授权，复审第 1 轮）
            chk "$site · $name" "$got" "$want"
        done
    done <<'ROWS'
只在 issue 上、PR 从没碰过（原有用法）|yes|no|7/l/maint|yes
issue 有授权、loop 账号在 PR 上打了（没摘过）→ 仍按 issue 的授权|yes|yes|7/l/maint 8/l/loop-bot|yes
只在 PR 上、维护者打的|no|yes|8/l/maint|yes
issue 一直挂着，PR 上打过又摘掉 → 叫停|yes|no|7/l/maint 8/l/maint 8/u/maint|no
复审的反例：issue 一直挂着 → PR 打又摘 → loop 账号在 PR 再打 → 仍叫停|yes|yes|7/l/maint 8/l/maint 8/u/maint 8/l/loop-bot|no
同上，之后维护者在 PR 亲手重打 → 恢复|yes|yes|7/l/maint 8/l/maint 8/u/maint 8/u/loop-bot 8/l/maint|yes
叫停后 Bot 在 PR 上补打 → 仍叫停|yes|yes|7/l/maint 8/l/maint 8/u/maint 8/l/renovate[bot]/Bot|no
叫停后只读账号在 PR 上补打 → 仍叫停|yes|yes|7/l/maint 8/l/maint 8/u/maint 8/l/helper|no
issue 上摘掉，维护者之后在 PR 上亲手打 → 恢复（Q1 默认 A）|no|yes|7/l/maint 7/u/maint 8/l/maint|yes
PR 上摘掉，维护者之后在 issue 上亲手打 → 恢复|yes|no|8/l/maint 8/u/maint 7/l/maint|yes
PR 上摘掉，之后 loop 账号在 issue 上打 → 仍叫停|yes|no|8/l/maint 8/u/maint 7/l/loop-bot|no
PR 上有授权，之后 issue 上摘掉（issue 早先有过）→ 叫停|no|yes|7/l/maint 8/l/maint 7/u/maint|no
两处都摘过、维护者最后在 issue 上重打 → 恢复|yes|no|7/l/maint 8/l/maint 8/u/maint 7/u/maint 7/l/maint|yes
ROWS

    section "【12e】判过「不接手」的缓存：只要 PR 或 issue 有变化就重判"
    fresh; pr_ready
    jset labels.json '.["7"] = ["pending/PR"]'
    jset events.json '.["8"] = []'; ev 8 labeled pending/human loop-bot
    ev 7 labeled autopilot maint; ev 8 labeled autopilot maint; ev 7 unlabeled autopilot maint
    tick
    chk "issue 上的摘掉晚于 PR 上的打 → 叫停，不接手" "$(took)" no
    local pr_upd; pr_upd=$(jq -r '.["8"].updated_at' "$GD/items.json")
    tick
    chk "  → 下一轮 PR 和 issue 都没变 → 不再读 PR 的标签记录" "$(n_calls "$R/issues/8/events")" 0
    jset labels.json '.["7"] += ["autopilot"]'; ev 7 labeled autopilot maint
    jset items.json '.["7"].updated_at = "2026-02-01T00:00:00Z"'
    tick
    chk "  → 只在 issue 上由维护者重新打托管（PR 的更新时间没变）→ 接手" "$(took)" yes
    chk "  → 这几轮里 PR 的更新时间确实没被测试改过（接手前）" "$pr_upd" "2026-01-01T00:00:00Z"
    chk "  → 说明写授权打在 issue 上" "$(comments_with 8 '`maint` 在 issue #7 上打了托管标签')" 1

    fresh; pr_ready; jset labels.json '.["7"] += ["pending/human"]'
    tick; tick
    chk "issue 上挂 pending/human 时不接手，缓存后两轮都不动" "$(took)" no
    jset labels.json '.["7"] = ["pending/PR"]'; jset items.json '.["7"].updated_at = "2026-02-01T00:00:00Z"'
    tick
    chk "  → 只在 issue 上摘掉 pending/human → 接手" "$(took)" yes

    fresh; pr_ready
    jset labels.json '.["8"] = ["pending/merge","autopilot"]'; review_rec 8 "$H1"; evidence 8 "$H1" 12 0
    tick
    chk "PR 上的授权、等合并 → 合并" "$(merged 8)" 1
    fresh; pr_ready
    jset labels.json '.["8"] = ["pending/merge"]'; ev 8 unlabeled autopilot maint
    review_rec 8 "$H1"; evidence 8 "$H1" 12 0
    tick
    chk "摘掉 PR 上的托管 → 等合并的 PR 交人、不合并" "$(merged 8)/$(has_label 8 pending/human)" "0/yes"
    chk "  → 说明写已叫停" "$(comments_with 8 '已叫停')" 1

    section "【12f】读不到：不接手、零写入"
    fresh; pr_ready; touch "$GD/F_issues_8_events"
    tick
    chk "PR 的标签记录读不到 → 不接手、一次写调用都没有" "$(took)/$(writes)" "no/0"
    rm -f "$GD/F_issues_8_events"; tick
    chk "  → 恢复后接手" "$(took)" yes
    fresh; pr_ready; touch "$GD/F_issues_7_events"
    tick
    chk "issue 的标签记录读不到 → 不接手、零写入" "$(took)/$(writes)" "no/0"
    fresh; pr_ready; touch "$GD/F_collaborators_maint_permission"
    tick
    chk "打标签的人权限查不到 → 不接手、零写入" "$(took)/$(writes)" "no/0"
    fresh; pr_ready
    jset labels.json '.["7"] = ["pending/PR"]'; jset events.json '.["7"] = [{event:"unlabeled", label:{name:"autopilot"}, actor:{login:"maint",type:"User"}}]'
    tick
    chk "另一处的摘掉没有时间、比不出先后 → 判不了、零写入" "$(took)/$(writes)" "no/0"

    section "【12g】判定接手之后、写之前有变化 → 本轮不写"
    for hk in "issues_7|2|jq '.[\"7\"] += [\"pending/human\"]' labels.json|issue 打 pending/human" \
              "issues_7|2|jq '.[\"7\"].state = \"closed\"' items.json|issue 被关闭" \
              "issues_7_events|2|jq '.[\"7\"] += [{event:\"labeled\",label:{name:\"autopilot\"},actor:{login:\"maint\",type:\"User\"},created_at:\"2099-01-01T00:00:00Z\"},{event:\"unlabeled\",label:{name:\"autopilot\"},actor:{login:\"maint\",type:\"User\"},created_at:\"2099-01-01T00:00:01Z\"}]' events.json|issue 上新出现一次摘掉（叫停）" \
              "issues_8_events|2|jq '.[\"8\"] += [{event:\"unlabeled\",label:{name:\"autopilot\"},actor:{login:\"maint\",type:\"User\"},created_at:\"2099-01-01T00:00:00Z\"},{event:\"labeled\",label:{name:\"autopilot\"},actor:{login:\"loop-bot\",type:\"User\"},created_at:\"2099-01-01T00:00:01Z\"}]' events.json|PR 上的授权变成 loop 账号打的" \
              "pulls_8|2|jq '.[\"8\"].head.sha = \"$H2\"' items.json|PR 推了新提交" \
              "pulls_8|2|jq '.[\"8\"].base.ref = \"release\"' items.json|PR 改投了别的目标分支" \
              "pulls_8|2|jq '.[\"8\"].head.ref = \"feature/issue-9\"' items.json|PR 换了分支（对不上 issue）" \
              "pulls_8|2|jq '.[\"8\"].head.repo.full_name = \"someone/ap\"' items.json|PR 的来源变成外部仓库" \
              "pulls_8|2|jq '.[\"8\"].state = \"closed\"' items.json|PR 被关闭" \
              "pulls_8|2|jq '.[\"8\"] = [\"pending/human\"]' labels.json|PR 上的托管标签被摘掉"; do
        IFS='|' read -r key k cmd what <<< "$hk"
        fresh; pr_ready
        local f; f="${cmd##* }"
        printf 'cd %q && %s < /dev/null > %q.tmp && mv %q.tmp %q\n' "$GD" "$cmd" "$f" "$f" "$f" > "$GD/hook_${key}_$k"
        tick
        chk "$what（判定之后）→ 不接手、零写入" "$(took)/$(writes)" "no/0"
        chk "到达性 · $what：确实走到了写前重判" "$([ -f "$GD/count_$key" ] && [ "$(cat "$GD/count_$key")" -ge 2 ] && echo yes || echo no)" yes
    done


    section "【12h】跨轮：PR 摘标交人 → 维护者只在 issue 上重新授权 → 接手（复审第 1 轮）"
    tk_unknown() { jq -r --arg p "$1" '(.autopilot.takeover_unknown[$p]) // ""' "$STATE" 2>/dev/null; }
    fresh; happy
    jset labels.json '.["8"] = ["pending/merge"]'; ev 8 labeled autopilot maint; ev 8 unlabeled autopilot maint
    tick
    chk "第 1 轮：PR 上摘掉托管 → 等合并的 PR 交人" "$(merged 8)/$(has_label 8 pending/human)/$(has_label 8 pending/merge)" "0/yes/no"
    tick
    chk "第 2 轮：issue 上的托管是交人之前打的 → 不接手（daemon 交人之后没有新授权）" "$(took)" no
    jset labels.json '.["7"] = ["pending/PR"]'
    EV_AT=2099-01-01T00:00:00Z ev 7 unlabeled autopilot maint
    jset labels.json '.["7"] += ["autopilot"]'
    EV_AT=2099-01-01T00:00:01Z ev 7 labeled autopilot maint
    jset items.json '.["7"].updated_at = "2099-01-01T00:00:01Z"'
    tick
    chk "第 3 轮：维护者只在 issue 上摘掉又亲手打上（晚于交人）→ 接手、翻复审" "$(took)" yes
    chk "  → 说明写授权打在 issue 上" "$(comments_with 8 '`maint` 在 issue #7 上打了托管标签')" 1
    chk "到达性 · 这一轮读了 PR 的标签记录" "$([ "$(n_calls "$R/issues/8/events")" -gt 0 ] && echo yes || echo no)" yes
    fresh; pr_ready
    jset labels.json '.["8"] = ["pending/human"]'; jset events.json '.["8"] = []'; ev 8 labeled pending/human loop-bot
    tick
    chk "普通的等人 PR（issue 和 PR 都没有托管标签）→ 不碰，也不读它的标签记录" "$(writes)/$(n_calls "$R/issues/8/events")/$(n_calls "^gh api $R/pulls/8\$")" "0/0/0"
    chk "到达性 · 这一轮确实读了 PR 列表" "$([ "$(n_calls "$R/pulls -f state=open")" -gt 0 ] && echo yes || echo no)" yes
    fresh; pr_ready
    mkissue 7 "pending/PR,autopilot"; ev 7 labeled autopilot maint
    jset labels.json '.["8"] = []'; jset events.json '.["8"] = []'
    tick
    chk "没有流程标签、只有 issue 挂托管的 PR（worker 刚开出来）→ 不接手" "$(has_label 8 pending/review)/$(writes)" "no/0"

    section "【12i】接手阶段连续读不到：到上限（3）交人，只交一次；中途恢复就清零"
    fresh; pr_ready; jset labels.json '.["8"] = ["autopilot"]'; touch "$GD/F_issues_8_events"
    tick; tick
    chk "读不到两轮 → 还不交人、零写入，计数 2" "$(has_label 8 pending/human)/$(writes)/$(tk_unknown 8)" "no/0/2"
    chk "到达性 · 确实去读了 PR 的标签记录" "$([ "$(n_calls "$R/issues/8/events")" -gt 0 ] && echo yes || echo no)" yes
    tick
    chk "第 3 轮 → 交人：加 pending/human、留一条说明" "$(has_label 8 pending/human)/$(comments_with 8 'autopilot-takeover-unknown pr=8')" "yes/1"
    tick; tick; tick
    chk "之后还是读不到 → 不再交第二次" "$(comments_with 8 'autopilot-takeover-unknown pr=8')" 1
    rm -f "$GD/F_issues_8_events"
    jset items.json '.["8"].updated_at = "2099-02-01T00:00:00Z"'
    tick
    chk "恢复后有了确定结论（daemon 交人在托管标签之后 → 不接手）→ 计数清掉" "$(tk_unknown 8)/$(took)" "/no"
    fresh; pr_ready; jset labels.json '.["8"] = ["autopilot"]'; touch "$GD/F_issues_8_events"
    tick
    chk "读不到一轮 → 计数 1" "$(tk_unknown 8)" 1
    rm -f "$GD/F_issues_8_events"; tick
    chk "  → 下一轮恢复 → 接手、计数清掉" "$(has_label 8 pending/review)/$(tk_unknown 8)" "yes/"
    fresh; pr_ready; jset labels.json '.["8"] = ["autopilot"]'; touch "$GD/F_issues_8_events"
    tick; tick; touch "$GD/F_post_comment"; tick
    chk "第 3 轮交人时留言失败 → 标签已加、没有说明、还没记「已交人」" "$(has_label 8 pending/human)/$(comments_with 8 'autopilot-takeover-unknown pr=8')/$(tk_unknown 8)" "yes/0/3"
    rm -f "$GD/F_post_comment"; tick
    chk "  → 下一轮补发说明一次" "$(comments_with 8 'autopilot-takeover-unknown pr=8')/$(tk_unknown 8)" "1/done"

    section "【12k】交人待办：判不了到上限之后，加标签 → 留言 → 收尾，中途失败 / 情况变化都接得上（复审第 2 轮）"
    tk_owed() { jq -r --arg p "$1" 'if .autopilot.takeover_handoff[$p] then "yes" else "no" end' "$STATE" 2>/dev/null; }
    unk_ready() { pr_ready; jset labels.json '.["8"] = ["autopilot"]'; touch "$GD/F_issues_8_events"; }
    # A：第 3 轮交人时留言失败，下一轮读取和留言**同时**恢复
    fresh; unk_ready
    tick; tick; touch "$GD/F_post_comment"; tick
    chk "A 留言失败：标签已加、没有说明、待办还在" "$(has_label 8 pending/human)/$(comments_with 8 'autopilot-takeover-unknown pr=8')/$(tk_owed 8)" "yes/0/yes"
    rm -f "$GD/F_post_comment" "$GD/F_issues_8_events"; tick
    chk "A 两边同时恢复 → 下一轮补发说明一次、待办清掉" "$(comments_with 8 'autopilot-takeover-unknown pr=8')/$(tk_owed 8)" "1/no"
    tick
    chk "到达性 · A 收尾后的下一轮确实重新判了接手（读了 PR 的标签记录）" "$([ "$(n_calls "$R/issues/8/events")" -gt 0 ] && echo yes || echo no)" yes
    chk "A 收尾后的下一轮：daemon 的交人在授权之后 → 不接手，计数清掉" "$(took)/$(tk_unknown 8)" "no/"
    tick
    chk "A 再一轮：说明仍是一条，零写入" "$(comments_with 8 'autopilot-takeover-unknown pr=8')/$(writes)" "1/0"
    # A2：只恢复读取，留言还在失败 → 不丢待办
    fresh; unk_ready
    tick; tick; touch "$GD/F_post_comment"; tick
    rm -f "$GD/F_issues_8_events"; tick
    chk "A2 只恢复读取、留言仍失败 → 没有说明、待办还在" "$(comments_with 8 'autopilot-takeover-unknown pr=8')/$(tk_owed 8)" "0/yes"
    rm -f "$GD/F_post_comment"; tick
    chk "A2 留言也恢复 → 补发一次、待办清掉" "$(comments_with 8 'autopilot-takeover-unknown pr=8')/$(tk_owed 8)" "1/no"
    # 交人这个决定只有一个依据：判不了。每次动手前用同一个接手判断现读重判——
    # 还判不了才接着交人；判得出结论（重新授权、恢复、改绑、关闭……）就作废，改按结论走（复审第 3 / 4 轮）
    # 复审第 5 轮：标签已加、说明发送失败之后的恢复分支，同样要过「身份没变」「pending/human 还在」两个前提
    lab_ready() { unk_ready; touch "$GD/F_post_comment"; tick; tick; tick; }
    fresh; lab_ready
    chk "前置：标签已加、说明没发、待办记着「标签已加」" "$(has_label 8 pending/human)/$(comments_with 8 'autopilot-takeover-unknown pr=8')/$(jq -r '.autopilot.takeover_handoff["8"].labeled' "$STATE")" "yes/0/true"
    # 正向对照：标签还在、身份没变、仍判不了 → 补发一次
    rm -f "$GD/F_post_comment"; tick
    chk "正向：评论恢复、仍判不了、标签还在 → 补发一次、收尾" "$(comments_with 8 'autopilot-takeover-unknown pr=8')/$(tk_owed 8)/$(tk_unknown 8)" "1/no/done"
    tick
    chk "  → 再一轮不重复" "$(comments_with 8 'autopilot-takeover-unknown pr=8')" 1
    # 反例 1：两接口恢复后，分支和正文一起改绑到打开的 issue #9
    fresh; lab_ready
    rm -f "$GD/F_issues_8_events" "$GD/F_post_comment"
    mkissue 9 "pending/PR"
    jset items.json '. * {"8": {head: {ref: "feature/issue-9"}, body: "Closes #9"}}'
    tick
    chk "反例 1 标签已加后改绑 #9 → 不发旧说明、待办作废" "$(comments_with 8 'autopilot-takeover-unknown pr=8')/$(tk_owed 8)" "0/no"
    chk "到达性 · 反例 1 这一轮读了 PR 的标签记录" "$([ "$(n_calls "$R/issues/8/events")" -gt 0 ] && echo yes || echo no)" yes
    # 同样改绑，但授权记录仍读不到（走「仍判不了」那一行）
    fresh; lab_ready
    rm -f "$GD/F_post_comment"
    mkissue 9 "pending/PR"
    jset items.json '. * {"8": {head: {ref: "feature/issue-9"}, body: "Closes #9"}}'
    tick
    chk "反例 1b 改绑且仍判不了 → 不发旧说明、待办作废" "$(comments_with 8 'autopilot-takeover-unknown pr=8')/$(tk_owed 8)" "0/no"
    # 反例 2：维护者摘掉 pending/human，评论恢复，授权记录仍读不到，连跑几轮
    fresh; lab_ready
    rm -f "$GD/F_post_comment"
    jset labels.json '.["8"] = ["autopilot"]'; EV_AT=2099-01-01T00:00:00Z ev 8 unlabeled pending/human maint
    tick
    chk "反例 2 人工摘掉 pending/human → 不补说明、不记 done，记 cancelled" "$(comments_with 8 'autopilot-takeover-unknown pr=8')/$(tk_owed 8)/$(tk_unknown 8)" "0/no/cancelled"
    tick; tick; tick; tick
    chk "反例 2 之后仍判不了 → 不加回 pending/human、不留言" "$(has_label 8 pending/human)/$(comments_with 8 'autopilot-takeover-unknown pr=8')/$(tk_unknown 8)" "no/0/cancelled"
    chk "到达性 · 反例 2 这几轮仍在读授权记录" "$([ "$(n_calls "$R/issues/8/events")" -gt 0 ] && echo yes || echo no)" yes
    rm -f "$GD/F_issues_8_events"; tick
    chk "反例 2 授权记录恢复（授权有效）→ 有确定结论，接手、清掉 cancelled" "$(took_none)/$(tk_unknown 8)" "yes/"
    # A3：加标签就失败，之后读取恢复、维护者**没有**重新授权：授权本来就有效，现在判得出了 → 接手，不交人
    fresh; unk_ready
    tick; tick; touch "$GD/F_post_labels"; tick
    chk "A3 加标签失败 → 没有说明、待办还在" "$(has_label 8 pending/human)/$(comments_with 8 'autopilot-takeover-unknown pr=8')/$(tk_owed 8)" "no/0/yes"
    rm -f "$GD/F_post_labels" "$GD/F_issues_8_events"; tick
    chk "A3 恢复后判得出（授权有效）→ 待办作废、接手，不留交人说明" "$(tk_owed 8)/$(took_none)/$(has_label 8 pending/human)/$(comments_with 8 'autopilot-takeover-unknown pr=8')" "no/yes/no/0"
    # A3b（正向对照）：加标签失败后仍判不了 → 下一轮把交人做完
    fresh; unk_ready
    tick; tick; touch "$GD/F_post_labels"; tick
    rm -f "$GD/F_post_labels"; tick
    chk "A3b 加标签恢复、仍判不了 → 加 pending/human、说明一次、待办清掉" "$(has_label 8 pending/human)/$(comments_with 8 'autopilot-takeover-unknown pr=8')/$(tk_owed 8)/$(tk_unknown 8)" "yes/1/no/done"
    # 复审第 3 轮反例 1：加标签失败 → 两个接口恢复 → 维护者在 PR / issue 上重新亲手授权 → 重试
    for where in pr issue; do
        fresh; unk_ready
        [ "$where" = issue ] && mkissue 7 "pending/PR"
        tick; tick; touch "$GD/F_post_labels"; tick
        rm -f "$GD/F_post_labels" "$GD/F_issues_8_events"
        if [ "$where" = pr ]; then
            jset labels.json '.["8"] = []'; EV_AT=2099-01-01T00:00:00Z ev 8 unlabeled autopilot maint
            jset labels.json '.["8"] = ["autopilot"]'; EV_AT=2099-01-01T00:00:01Z ev 8 labeled autopilot maint
        else
            jset labels.json '.["7"] += ["autopilot"]'; EV_AT=2099-01-01T00:00:01Z ev 7 labeled autopilot maint
        fi
        tick
        chk "反例 1（在 $where 上重新授权）→ 旧待办作废、接手；不补加 pending/human、不发旧说明" \
            "$(tk_owed 8)/$(took_none)/$(has_label 8 pending/human)/$(comments_with 8 'autopilot-takeover-unknown pr=8')" "no/yes/no/0"
        tick
        chk "反例 1（$where）再一轮：仍是接手后的状态" "$(has_label 8 pending/review)/$(has_label 8 pending/human)" "yes/no"
    done
    # 复审第 3 轮反例 2：待办期间 PR 正文改绑别的 issue（分支、来源不变）
    fresh; unk_ready
    tick; tick; touch "$GD/F_post_labels"; tick
    rm -f "$GD/F_post_labels"
    jset items.json '.["8"].body = "Closes #99"'
    tick
    chk "反例 2 正文改成 Closes #99 → 旧待办作废：不加 pending/human、不发旧说明" \
        "$(tk_owed 8)/$(has_label 8 pending/human)/$(comments_with 8 'autopilot-takeover-unknown pr=8')" "no/no/0"
    chk "  → 改按现在的结论走：PR 对不上 issue，按不生效说一次" "$(comments_with 8 'kind=pr-binding')" 1
    # 同样的待办，issue 被关闭 / 外部需求机器人的需求 → 作废，不写旧说明
    for change in closed requester; do
        fresh 'REQUESTER_BOT_ACCOUNT="req-bot"'; unk_ready
        tick; tick; touch "$GD/F_post_labels"; tick
        rm -f "$GD/F_post_labels"
        if [ "$change" = closed ]; then jset items.json '.["7"].state = "closed"'; else jset items.json '.["7"].user.login = "req-bot"'; fi
        tick
        chk "待办期间 issue 变化（$change）→ 作废，不加 pending/human、不发旧说明" \
            "$(tk_owed 8)/$(has_label 8 pending/human)/$(comments_with 8 'autopilot-takeover-unknown pr=8')" "no/no/0"
    done
    # A4：进程中途被杀——用状态和标签记录直接摆出中间态（daemon 加 pending/human 时 GitHub 会留一条记录）
    fresh; pr_ready; jset labels.json '.["8"] = ["autopilot","pending/human"]'; EV_AT=2099-01-01T00:00:00Z ev 8 labeled pending/human loop-bot
    echo '{"autopilot":{"takeover_handoff":{"8":{"k":3,"reason":"x","n":"7","ref":"feature/issue-7","repo":"example/ap","labeled":false}}}}' > "$STATE"
    tick
    chk "A4 标签已加、没记下 → 不重复加标签，说明一次" "$(n_calls "^gh api -X POST $R/issues/8/labels")/$(comments_with 8 'autopilot-takeover-unknown pr=8')/$(tk_owed 8)" "0/1/no"
    fresh; pr_ready; jset labels.json '.["8"] = ["autopilot","pending/human"]'; EV_AT=2099-01-01T00:00:00Z ev 8 labeled pending/human loop-bot
    jset comments.json '.["8"] = [{id:960, user:{login:"loop-bot"}, created_at:"2026-06-02T00:00:00Z", body:"（上一轮发的）\n<!-- cavil-loop:autopilot-takeover-unknown pr=8 -->"}]'
    echo '{"autopilot":{"takeover_handoff":{"8":{"k":3,"reason":"x","n":"7","ref":"feature/issue-7","repo":"example/ap","labeled":true}}}}' > "$STATE"
    tick
    chk "A4 说明已发、没清待办 → 不重复发，只收尾" "$(comments_with 8 'autopilot-takeover-unknown pr=8')/$(n_calls "^gh api -X POST $R/issues/8/comments")/$(tk_owed 8)" "1/0/no"
    chk "到达性 · A4 这一轮读了 PR 的评论" "$([ "$(n_calls "$R/issues/8/comments")" -gt 0 ] && echo yes || echo no)" yes
    fresh; pr_ready; jset labels.json '.["8"] = ["autopilot","pending/human"]'; EV_AT=2099-01-01T00:00:00Z ev 8 labeled pending/human maint
    echo '{"autopilot":{"takeover_handoff":{"8":{"k":3,"reason":"x","n":"7","ref":"feature/issue-7","repo":"example/ap","labeled":true}}}}' > "$STATE"
    tick
    chk "A4 最后那次 pending/human 是维护者打的（不是 daemon 为待办加的）→ 叫停：作废、零写入" "$(writes)/$(tk_owed 8)" "0/no"
    fresh; pr_ready; jset labels.json '.["8"] = ["autopilot"]'
    echo '{"autopilot":{"takeover_handoff":{"8":{"k":3,"reason":"x","n":"7","ref":"feature/issue-7","repo":"example/ap","labeled":true}}}}' > "$STATE"
    tick
    chk "A4 我们加的 pending/human 已被人摘掉、授权有效 → 作废、接手，不留交人说明" "$(tk_owed 8)/$(took_none)/$(comments_with 8 'autopilot-takeover-unknown pr=8')" "no/yes/0"

    # B：到上限、准备交人时，现读 PR 发现情况变了 → 不写旧决定的任何东西，待办作废
    # （读不到授权记录时，每轮只现读 PR 一次；第 3 轮是第 3 次，待办现读重判那次是第 4 次）
    for hk in "jq '.[\"8\"].state = \"closed\"' items.json|PR 被关闭" \
              "jq '.[\"8\"] += {merged: true, state: \"closed\"}' items.json|PR 已合并" \
              "jq '.[\"8\"] += [\"pending/review\"]' labels.json|PR 转进复审" \
              "jq '.[\"8\"].head.ref = \"feature/issue-9\"' items.json|PR 换了分支" \
              "jq '.[\"8\"].head.repo.full_name = \"someone/ap\"' items.json|PR 的来源变了" \
              "jq '.[\"8\"].body = \"Closes #99\"' items.json|PR 正文改绑别的 issue" \
              "jq '. * {\"8\": {head: {ref: \"feature/issue-9\"}, body: \"Closes #9\"}}' items.json|PR 分支和正文一起改绑到另一个 issue"; do
        IFS='|' read -r cmd what <<< "$hk"
        fresh; unk_ready
        local f; f="${cmd##* }"
        printf 'cd %q && %s < /dev/null > %q.tmp && mv %q.tmp %q\n' "$GD" "$cmd" "$f" "$f" "$f" > "$GD/hook_pulls_8_4"
        tick; tick; tick
        chk "B $what（交人前现读到）→ 不加 pending/human、没有交人说明、待办作废" \
            "$(has_label 8 pending/human)/$(comments_with 8 'autopilot-takeover-unknown pr=8')/$(tk_owed 8)" "no/0/no"
        chk "到达性 · B $what：确实走到了交人前的现读" "$([ "$(cat "$GD/count_pulls_8" 2>/dev/null)" -ge 4 ] && echo yes || echo no)" yes
    done
    fresh; unk_ready; touch "$GD/F_pulls_8"
    tick; tick; tick
    chk "B 交人前现读不到 PR → 零写入、待办留着" "$(writes)/$(tk_owed 8)" "0/yes"
    rm -f "$GD/F_pulls_8"; tick
    chk "  → 恢复后（仍判不了）交人一次" "$(has_label 8 pending/human)/$(comments_with 8 'autopilot-takeover-unknown pr=8')" "yes/1"

    # C：每轮第一次判定读得到、写前那次读不到（授权记录缺操作人）
    fresh; pr_ready; jset labels.json '.["8"] = ["autopilot"]'
    jq -c '.["8"]' "$GD/events.json" > "$GD/ev_good.json"
    jq -c '[ .[] | if .label.name == "autopilot" then .actor = {} else . end ]' "$GD/ev_good.json" > "$GD/ev_bad.json"
    local kk
    # 第 1–6 次读：好、坏交替（每轮第一次判定读得到、写前那次读不到）；之后一直坏（交人待办现读重判那次也判不了）
    for kk in 1 2 3 4 5 6 7 8 9 10; do
        if [ $((kk % 2)) = 1 ] && [ "$kk" -le 6 ]; then src=ev_good.json; else src=ev_bad.json; fi
        printf 'cd %q && jq --slurpfile e %q %q events.json > events.json.tmp && mv events.json.tmp events.json\n' \
            "$GD" "$src" '.["8"] = $e[0]' > "$GD/hook_issues_8_events_$kk"
    done
    tick
    chk "C 第 1 轮：写前那次判不了 → 零写入、计数 1" "$(writes)/$(tk_unknown 8)" "0/1"
    tick
    chk "C 第 2 轮：计数 2（第一次判定读得到不能清零）" "$(writes)/$(tk_unknown 8)" "0/2"
    tick
    chk "C 第 3 轮（上限 3）→ 交人：加 pending/human、说明一次" "$(has_label 8 pending/human)/$(comments_with 8 'autopilot-takeover-unknown pr=8')" "yes/1"
    chk "到达性 · C 每轮都读了两次 PR 的标签记录，第 3 轮交人前又现读一次" "$(cat "$GD/count_issues_8_events")" 7
    fresh; pr_ready; jset labels.json '.["8"] = ["autopilot"]'
    jq -c '.["8"]' "$GD/events.json" > "$GD/ev_good.json"
    jq -c '[ .[] | if .label.name == "autopilot" then .actor = {} else . end ]' "$GD/ev_good.json" > "$GD/ev_bad.json"
    printf 'cd %q && jq --slurpfile e ev_bad.json %q events.json > events.json.tmp && mv events.json.tmp events.json\n' "$GD" '.["8"] = $e[0]' > "$GD/hook_issues_8_events_2"
    printf 'cd %q && jq --slurpfile e ev_good.json %q events.json > events.json.tmp && mv events.json.tmp events.json\n' "$GD" '.["8"] = $e[0]' > "$GD/hook_issues_8_events_3"
    tick
    chk "C2 写前那次判不了一轮 → 计数 1" "$(tk_unknown 8)" 1
    tick
    chk "C2 下一轮两次都读得到 → 接手、计数清掉" "$(took_none)/$(tk_unknown 8)" "yes/"

    fresh; pr_ready; jset labels.json '.["8"] = ["autopilot"]'; touch "$GD/F_issues_8_events"
    tick; tick; tick
    jset labels.json '.["8"] = ["autopilot"]'
    tick; tick; tick; tick
    chk "交过人之后维护者摘掉 pending/human、仍然判不了 → 不再把它加回去" "$(has_label 8 pending/human)/$(comments_with 8 'autopilot-takeover-unknown pr=8')" "no/1"
    chk "到达性 · 这几轮确实还在读 PR 的标签记录" "$([ "$(n_calls "$R/issues/8/events")" -gt 0 ] && echo yes || echo no)" yes

    section "【12j】pending/human 和别的流程标签共存：正在进行的工作不接手（复审第 1 轮）"
    for other in pending/review pending/agent doing/agent pending/merge; do
        fresh; pr_ready
        jset labels.json '.["8"] += [$o]' --arg o "$other"
        review_rec 8 "$H1"
        local wantrev=no; [ "$other" = pending/review ] && wantrev=yes
        tick
        # （挂着 pending/merge 时合并那一趟按原有规矩会摘掉它：PR 上有 pending/human = 叫停，那不是接手）
        chk "pending/human + $other + 维护者的托管标签 → 不接手：pending/human 留着、没加复审、没有接手说明" \
            "$(has_label 8 pending/human)/$(has_label 8 pending/review)/$(comments_with 8 'autopilot-takeover pr=8')" "yes/$wantrev/0"
        chk "  → 复审记录没被清掉" "$(st 8 .reviewed_head)" "$H1"
    done

    # ── 【11】托管关掉之后（GitHub#124）：关托管只要改配置，等合并的 PR 由 daemon 交给人 ──
    section "【11】托管关掉之后：本机托管过、还挂着等合并的 PR → 交人并说明；其他一概不碰"
    local OFF='LABEL_AUTOPILOT=""'
    fresh "$OFF"; happy
    tick
    chk "关掉后：不发合并请求" "$(merged 8)" 0
    chk "关掉后：PR 交人" "$(has_label 8 pending/human)" yes
    chk "关掉后：摘掉等合并标签" "$(has_label 8 pending/merge)" no
    chk "关掉后：PR 上留言说明为什么停了" "$(comments_with 8 '托管已在配置里关掉')" 1
    chk "关掉后：issue 不动（托管标签留着，不替人摘）" "$(has_label 7 autopilot)" yes
    tick
    chk "关掉后：再跑一轮不重复留言" "$(comments_with 8 '托管已在配置里关掉')" 1
    chk "关掉后：再跑一轮零写入" "$(writes)" 0

    fresh "$OFF"; happy
    mkpr 9 feature/issue-9 "Closes #9" "$H2" "pending/merge"
    tick
    chk "本机没托管记录的 PR（别的用途的同名标签）→ 不碰" "$(labels_of 9)" "pending/merge"
    chk "  …本机托管过的那个照样交人" "$(has_label 8 pending/human)" yes

    fresh "$OFF"
    mkpr 9 feature/issue-9 "Closes #9" "$H2" "pending/merge"
    tick
    chk "从没开过托管（state 里没有托管记录）→ 零写入" "$(writes)" 0
    chk "  …也不为它多读任何一个 PR" "$(n_calls "^gh api $R/pulls/9\$")" 0
    chk "到达性 · 这一轮确实读了 PR 列表" "$([ "$(n_calls "$R/pulls -f state=open")" -gt 0 ] && echo yes || echo no)" yes

    fresh "$OFF"; happy
    jset labels.json '.["8"] = ["pending/review"]'
    tick
    chk "本机托管过、但没挂等合并（还在复审）→ 不碰" "$(labels_of 8)" "pending/review"

    fresh "$OFF"; happy
    printf 'jq %q %q > %q.t && mv %q.t %q\n' '.["8"].merged = true | .["8"].state = "closed"' "$GD/items.json" "$GD/items.json" "$GD/items.json" "$GD/items.json" > "$GD/hook_pulls_8_1"
    tick
    chk "判定之后、动手之前 PR 已被合并 → 现读拦住，不翻标签" "$(has_label 8 pending/human)" no
    chk "  …也不留言" "$(comments_with 8 '托管已在配置里关掉')" 0

    fresh "$OFF"; happy
    touch "$GD/F_pulls_8"
    tick
    chk "现读 PR 读不到 → 本轮不动" "$(labels_of 8)" "pending/merge"
    rm -f "$GD/F_pulls_8"; tick
    chk "  …恢复后下一轮交人" "$(has_label 8 pending/human)/$(has_label 8 pending/merge)" "yes/no"

    fresh "$OFF"; happy
    touch "$GD/F_delete_labels"
    tick
    chk "摘等合并标签失败 → 回读发现还挂着，不留言" "$(comments_with 8 '托管已在配置里关掉')" 0
    rm -f "$GD/F_delete_labels"; tick
    chk "  …恢复后下一轮补上：摘掉、留言一次" "$(has_label 8 pending/merge)/$(comments_with 8 '托管已在配置里关掉')" "no/1"

    # 交人是三步写（加 pending/human → 摘等合并 → 留言），每一步失败后下一轮都要接着做完（PR #127 复审）
    fresh "$OFF"; happy
    touch "$GD/F_post_labels"
    tick
    chk "加 pending/human 失败 → 等合并标签原样留着（下轮还找得到）" "$(labels_of 8)" "pending/merge"
    chk "  …也不留言" "$(comments_with 8 '托管已在配置里关掉')" 0
    rm -f "$GD/F_post_labels"; tick
    chk "  …恢复后下一轮交人：有 pending/human、没有等合并" "$(labels_of 8)" "pending/human"
    chk "  …留言一次" "$(comments_with 8 '托管已在配置里关掉')" 1

    fresh "$OFF"; happy
    touch "$GD/F_post_comment"
    tick
    chk "留言失败 → 标签已交接" "$(labels_of 8)" "pending/human"
    chk "  …交接记号还在（说明还欠着）" "$(st 8 .off_handover)" "true"
    rm -f "$GD/F_post_comment"; tick
    chk "  …恢复后下一轮补发留言（等合并标签已经没了也找得回来）" "$(comments_with 8 '托管已在配置里关掉')" 1
    chk "  …补发后清掉记号" "$(st 8 .off_handover)" ""
    tick
    chk "  …再一轮零写入、不重复留言" "$(writes)/$(comments_with 8 '托管已在配置里关掉')" "0/1"

    fresh "$OFF"; happy
    touch "$GD/F_post_labels" "$GD/F_delete_labels" "$GD/F_post_comment"
    tick; tick
    chk "三步全失败两轮 → 等合并标签仍在、没有留言" "$(labels_of 8)/$(comments_with 8 '托管已在配置里关掉')" "pending/merge/0"
    rm -f "$GD/F_post_labels"; tick
    chk "  …只恢复加标签：两个标签都在（摘还在失败），不留言" "$(labels_of 8)/$(comments_with 8 '托管已在配置里关掉')" "pending/human,pending/merge/0"
    rm -f "$GD/F_delete_labels"; tick
    chk "  …再恢复摘标签：交接完成，留言仍欠着" "$(labels_of 8)/$(st 8 .off_handover)" "pending/human/true"
    rm -f "$GD/F_post_comment"; tick
    chk "  …最后恢复留言：补发一次" "$(comments_with 8 '托管已在配置里关掉')/$(st 8 .off_handover)" "1/"

    # 标签两步都写成功、紧接着的回读失败（PR #127 复审第 2 轮）：意图在动 GitHub 之前就记下了，下轮接着做
    fresh "$OFF"; happy
    touch "$GD/F_issues_8"
    tick
    chk "标签改好、回读失败 → 标签已是目标，交接记号在，没发说明" "$(labels_of 8)/$(st 8 .off_handover)/$(comments_with 8 '托管已在配置里关掉')" "pending/human/true/0"
    rm -f "$GD/F_issues_8"; tick
    chk "  …恢复后下一轮补发说明一次、清掉记号" "$(comments_with 8 '托管已在配置里关掉')/$(st 8 .off_handover)" "1/"

    fresh "$OFF"; happy
    touch "$GD/F_issues_8_comments"
    tick
    chk "读不到已有评论（判断不了发没发过）→ 不发" "$(comments_with 8 '托管已在配置里关掉')/$(st 8 .off_handover)" "0/true"
    rm -f "$GD/F_issues_8_comments"; tick
    chk "  …恢复后发一次" "$(comments_with 8 '托管已在配置里关掉')/$(st 8 .off_handover)" "1/"

    # 进程半路被杀 / 清记号失败：用状态直接摆出中间态
    fresh "$OFF"; happy
    jset labels.json '.["8"] = ["pending/human"]'
    jq '.autopilot.prs["8"].off_handover = true' "$STATE" > "$STATE.tmp" && mv "$STATE.tmp" "$STATE"
    tick
    chk "中间态：标签已交接、说明没发 → 补发一次、清记号" "$(comments_with 8 '托管已在配置里关掉')/$(st 8 .off_handover)" "1/"

    fresh "$OFF"; happy
    jset labels.json '.["8"] = ["pending/human"]'
    jset comments.json '.["8"] = [{id:950, user:{login:"loop-bot"}, created_at:"2026-06-02T00:00:00Z", body:"托管已在配置里关掉（上一轮发的）\n<!-- autopilot-off-handover -->"}]'
    jq '.autopilot.prs["8"].off_handover = true' "$STATE" > "$STATE.tmp" && mv "$STATE.tmp" "$STATE"
    tick
    chk "中间态：说明已发、只是记号没清 → 不重复发，只清记号" "$(comments_with 8 '托管已在配置里关掉')/$(st 8 .off_handover)/$(n_calls "^gh api -X POST $R/issues/8/comments")" "1//0"
    chk "到达性 · 这一轮确实读了这个 PR 的评论" "$([ "$(n_calls "$R/issues/8/comments")" -gt 0 ] && echo yes || echo no)" yes

    fresh "$OFF"; happy
    jset items.json '.["8"].state = "closed"'
    tick
    chk "已关闭的 PR 的托管记录被清掉（之后这里不再读 GitHub）" "$(st 8 .reviewed_head)" ""

    fresh; happy
    tick
    chk "开着时这段不插手：照常合并，不留「已关掉」的言" "$(merged 8)/$(comments_with 8 '托管已在配置里关掉')" "1/0"
}

# ─────────────────────────────────────────────────────────────────────────
# 【8】功能关闭：轮询的 GitHub 调用、state.json、拼出来的提示词都和改动前逐字节一致
# ─────────────────────────────────────────────────────────────────────────
off_mode() {
    local W="$SANDBOX/off" root out
    for root in old new; do
        out="$W/$root"; rm -rf "$out"; mkdir -p "$out/state" "$out/wt" "$out/gh"
        git init -q "$out/project" 2>/dev/null
        export FAKE_GH_DIR="$out/gh" FAKE_GH_REPO="example/ap"
        cat > "$out/conf" <<CONF
REPO="example/ap"
PROJECT_ROOT="$out/project"
WORKTREE_BASE="$out/wt"
STATE_DIR="$out/state"
TMUX_PREFIX="apoff"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
LABEL_AGENT_DOING="doing/agent"
LABEL_PENDING_REVIEW="pending/review"
POST_MERGE_RETROSPECTIVE=false
POLL_BACKOFF_LADDER=""
PRICE_AUTO_FETCH=0
MAX_CONCURRENT_WORKERS=0
PATH="$SANDBOX/bin:\$PATH"
CONF
        # 托管相关的名字都在（标签挂着、PR 挂着 pending/merge），但配置里没开托管
        echo '{"5":{"kind":"issue","state":"open","title":"t","body":"x","user":{"login":"maint"}},
               "6":{"kind":"issue","state":"open","title":"t","body":"x","user":{"login":"maint"}},
               "7":{"kind":"issue","state":"open","title":"t","body":"x","user":{"login":"maint"}},
               "8":{"kind":"pr","state":"open","merged":false,"title":"t","body":"Closes #7","user":{"login":"loop-bot"},
                    "head":{"sha":"'"$H1"'","ref":"feature/issue-7","repo":{"full_name":"example/ap"}},"base":{"ref":"main"},
                    "mergeable":true,"mergeable_state":"clean"}}' > "$out/gh/items.json"
        echo '{"5":["autopilot"],"6":["autopilot","pending/agent"],"7":["autopilot","pending/PR"],"8":["pending/merge","pending/review","autopilot"]}' > "$out/gh/labels.json"
        echo '{"6":[{"event":"labeled","label":{"name":"autopilot"},"actor":{"login":"maint","type":"User"}}]}' > "$out/gh/events.json"
        for f in comments checks files; do echo '{}' > "$out/gh/$f.json"; done
        echo '{"maint":"admin"}' > "$out/gh/perms.json"; echo loop-bot > "$out/gh/me"
        local scripts="$SANDBOX/old/scripts"; [ "$root" = new ] && scripts="$REPO_DIR/scripts"
        env CODING_AGENT_CONFIG="$out/conf" bash "$scripts/agent-poll.sh" >/dev/null 2>&1
        env CODING_AGENT_CONFIG="$out/conf" bash "$scripts/agent-poll.sh" >/dev/null 2>&1
    done
    chk "关闭时：两轮轮询的 GitHub 调用和改动前逐条一致" \
        "$(diff <(sed "s|$W/new|W|g" "$W/new/gh/calls.log") <(sed "s|$W/old|W|g" "$W/old/gh/calls.log") >/dev/null && echo same || echo diff)" same
    chk "关闭时：state.json 和改动前逐字节一致" "$(cmp -s "$W/new/state/state.json" "$W/old/state/state.json" && echo same || echo diff)" same
    chk "到达性 · 关闭时的轮询确实读了 issue / PR 列表" \
        "$(grep -c "repos/example/ap/pulls -f state=open" "$W/new/gh/calls.log")" 2
}

# 拼提示词：走 dispatch 脚本真正用的那个拼装函数。$1 = scripts+prompts 根，$2 = 模板名，其余是环境变量
compose() {
    local root="$1" name="$2"; shift 2
    local W="$SANDBOX/compose"; rm -rf "$W/state"; mkdir -p "$W/state" "$W/project"
    git init -q "$W/project" 2>/dev/null
    cat > "$W/conf" <<CONF
REPO="example/ap"
PROJECT_ROOT="$W/project"
WORKTREE_BASE="$W/wt"
STATE_DIR="$W/state"
TMUX_PREFIX="apc"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
LABEL_AGENT_DOING="doing/agent"
PATH="$SANDBOX/bin:\$PATH"
CONF
    local f
    f=$(cd "$W/project" && env "$@" CODING_AGENT_CONFIG="$W/conf" bash -c 'source "$1/scripts/_lib.sh" >/dev/null 2>&1; compose_prompt_template "$2"' _ "$root" "$name" 2>/dev/null)
    [ -n "$f" ] && [ -f "$f" ] && sed "s|$root|<ROOT>|g" "$f"
}

prompts_check() {
    local root="$1" name same=1 o n
    section "【9】提示词：关闭时和改动前逐字节一致；托管条目拼入托管规则"
    for name in new-issue issue-comment pr-comment review; do
        for env_set in "LABEL_PENDING_REVIEW=pending/review" "LABEL_PENDING_REVIEW=pending/review LABEL_AUTOPILOT=autopilot" \
                       "LABEL_PENDING_REVIEW= LABEL_AUTOPILOT=autopilot DISPATCH_AUTOPILOT=1 DISPATCH_AUTOPILOT_ISSUE=7"; do
            # shellcheck disable=SC2086
            o=$(compose "$SANDBOX/old" "$name" $env_set); n=$(compose "$root" "$name" $env_set)
            if [ -z "$n" ] || [ "$o" != "$n" ]; then same=0; [ "$QUIET" = 1 ] || echo "     不一致：$name / $env_set"; fi
        done
    done
    chk "不是托管条目（或没配复审关卡）时，四份提示词和改动前逐字节一致" "$same" 1
    local on="LABEL_PENDING_REVIEW=pending/review LABEL_AUTOPILOT=autopilot DISPATCH_AUTOPILOT=1 DISPATCH_AUTOPILOT_ISSUE=7"
    for name in new-issue issue-comment pr-comment; do
        # shellcheck disable=SC2086
        n=$(compose "$root" "$name" $on)
        chk "$name：拼入 worker 的托管规则" "$(printf '%s' "$n" | grep -c '^# 托管规则（本条是托管条目）')" 1
        chk "$name：写明只写一个 Closes #7、分支 feature/issue-7" "$(printf '%s' "$n" | grep -cF '**只写一个**关闭关键词 `Closes #7`')/$(printf '%s' "$n" | grep -c '`feature/issue-7`')" "1/1"
        chk "$name：没有复审那份" "$(printf '%s' "$n" | grep -c 'autopilot-review-pass')" 0
        chk "$name：没有没换掉的占位" "$(printf '%s' "$n" | grep -c '@@')" 0
    done
    # shellcheck disable=SC2086
    n=$(compose "$root" review $on)
    chk "review：没说授权在哪一处时写 issue #7" "$(printf '%s' "$n" | grep -c '维护者在 issue #7 上亲手打了托管标签')" 1
    # shellcheck disable=SC2086
    chk "review：授权打在 PR 上时写 PR #8（GitHub#128）" \
        "$(compose "$root" review $on DISPATCH_AUTOPILOT_WHERE='PR #8' | grep -c '维护者在 PR #8 上亲手打了托管标签')" 1
    # shellcheck disable=SC2086
    chk "issue-comment：授权打在 PR 上时写 PR #8" \
        "$(compose "$root" issue-comment $on DISPATCH_AUTOPILOT_WHERE='PR #8' | grep -c '维护者在 PR #8 上亲手打了托管标签')" 1
    chk "review：拼入复审的托管规则（通过翻 pending/merge、留测试记录）" \
        "$(printf '%s' "$n" | grep -c 'REST 翻 `pending/merge`，摘 `pending/review`')/$(printf '%s' "$n" | grep -c 'autopilot-review-pass head=')" "1/1"
    chk "review：方案通过翻 pending/agent" "$(printf '%s' "$n" | grep -c 'REST 翻 `pending/agent`，摘 `pending/review`')" 1
    chk "review：托管规则在最末尾（在通用复审指令之后）" \
        "$(printf '%s' "$n" | awk '/^# 托管规则/{a=NR} /^5\. 通过：REST 翻/{b=NR} END{print (a>b && b>0) ? "yes" : "no"}')" yes

    # 派工脚本真的把轮询给的标记传进拼装（读它写出的那份给 worker 的提示词）
    local W="$SANDBOX/disp"; rm -rf "$W"; mkdir -p "$W/state" "$W/wt"
    git init -q --bare "$W/up.git"; git clone -q "$W/up.git" "$W/seed" 2>/dev/null
    (cd "$W/seed" && git -c user.email=t@x -c user.name=t commit -q --allow-empty -m init && git push -q origin HEAD:main) >/dev/null 2>&1
    git clone -q "$W/up.git" "$W/project" 2>/dev/null
    cat > "$W/conf" <<CONF
REPO="example/ap"
PROJECT_ROOT="$W/project"
WORKTREE_BASE="$W/wt"
STATE_DIR="$W/state"
TMUX_PREFIX="apd"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
LABEL_AGENT_DOING="doing/agent"
LABEL_PENDING_REVIEW="pending/review"
LABEL_AUTOPILOT="autopilot"
WORKER_AGENT_DEFAULT="claude"
PATH="$SANDBOX/bin:\$PATH"
GH_TOKEN="fake-token-for-test"
CONF
    # 编号按进程区分：派工脚本把提示词写到 /tmp 下按编号命名的文件，几个测试进程并行跑时不能撞名
    local N=$((900000 + $$ % 90000))
    export FAKE_GH_DIR="$W/gh"; mkdir -p "$W/gh"; for f in labels events comments; do echo '{}' > "$W/gh/$f.json"; done
    echo '{"'$N'":{"kind":"issue","state":"open","title":"托管测试","body":"x","user":{"login":"maint"}}}' > "$W/gh/items.json"
    rm -f "/tmp/cavil-loop-issue-$N-prompt.md"
    (cd "$W/project" && env DISPATCH_AUTOPILOT=1 DISPATCH_AUTOPILOT_ISSUE="$N" CODING_AGENT_CONFIG="$W/conf" \
        bash "$root/scripts/dispatch-new-issue.sh" "$N") >/dev/null 2>&1
    chk "派工脚本写出的提示词带托管规则（标记一路传到 worker）" \
        "$(grep -c '^# 托管规则（本条是托管条目）' "/tmp/cavil-loop-issue-$N-prompt.md" 2>/dev/null || echo 0)" 1
    rm -f "/tmp/cavil-loop-issue-$N-prompt.md"
}

echo "=== 正式版 ==="
run_scenarios "$REPO_DIR/scripts"
section "【8】功能关闭：和改动前逐字节一致"
off_mode
prompts_check "$REPO_DIR"
REAL_PASS=$pass; REAL_FAIL=$fail

# ─────────────────────────────────────────────────────────────────────────
# 【10】负对照（MUTATION=1）：把脚本副本逐个改坏一处，整套场景必须有检查变红
# ─────────────────────────────────────────────────────────────────────────
section "【10】负对照（改坏一处，至少一条检查必须变红）"
mut_fail=0; mut_ran=0
# 负对照很慢（每份都把整套场景重跑一遍，约 2.5 分钟，共 60 多份）。AUTOPILOT_MUT_SHARD=K/N 只跑第 K 份
# （按顺序轮流分），各自独立的沙盘，可以开 N 个进程并行跑；不设 = 全跑。只影响跑哪几份，不改任何判断。
MUT_IDX=0
mut_in_shard() {
    MUT_IDX=$((MUT_IDX + 1))
    [ -n "${AUTOPILOT_MUT_SHARD:-}" ] || return 0
    local k="${AUTOPILOT_MUT_SHARD%/*}" n="${AUTOPILOT_MUT_SHARD#*/}"
    [ $(( (MUT_IDX - 1) % n + 1 )) -eq "$k" ]
}
mutate() {   # <名字> <文件（相对 scripts/）> <原文> <替换后> [<原文> <替换后> …]：每对原文都必须找得到
    local name="$1" file="$2" M="$SANDBOX/mut-$1"
    shift 2
    mutation_gate || return 0
    mut_in_shard || return 0
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
    run_scenarios "$M/scripts"
    QUIET=0
    if [ "$fail" -gt 0 ]; then
        echo "  ✅ 负对照 $name：$fail 条检查变红"
    else
        echo "  ❌ 负对照 $name：改坏后整套检查仍全绿（测试分不出这个错误实现）"; mut_fail=$((mut_fail + 1))
    fi
}
# 合并前那次重判用 AP_SECOND=1 标出来，「只在第二次跳过某一项」的负对照靠它
SECOND_OLD='    autopilot_permit "$sf" "$pr"
    if [ "$AP_V" != ok ]'
SECOND_NEW='    AP_SECOND=1 autopilot_permit "$sf" "$pr"
    if [ "$AP_V" != ok ]'
mutate2() {   # <名字> <原文> <替换后>：只在合并前的第二次判定里改坏
    mutate "$1" _lib.sh "$SECOND_OLD" "$SECOND_NEW" "$2" "$3"
}

# ── 判定本身（两次判定都受影响）──
mutate binding-no-body _lib.sh 'if [ "$by_line" != "$n" ]; then' 'if false; then'
mutate binding-no-fork _lib.sh 'if [ -z "$repo" ] || [ "$(requester_bot_lc "$repo")" != "$(requester_bot_lc "$REPO")" ]; then' 'if false; then'
mutate auth-loop-actor _lib.sh 'if [ "$(requester_bot_lc "$actor")" = "$(requester_bot_lc "$me")" ]; then' 'if false; then'
mutate auth-no-perm _lib.sh '        admin|write) ;;' '        *) ;;'
mutate auth-last-event _lib.sh '        true:labeled|false:unlabeled|false:) ;;' '        true:labeled|true:unlabeled|false:unlabeled|false:) ;;'
mutate auth-unknown-ok _lib.sh '    autopilot_place_read "$num" "$ij" "issue #$num" || return 2' '    autopilot_place_read "$num" "$ij" "issue #$num" || { AUTOPILOT_ACTOR=x; return 0; }'
mutate evidence-failed _lib.sh 'select(.h == $h and (.f | tonumber) == 0 and (.p | tonumber) > 0)' 'select(.h == $h)'
mutate dot-github _lib.sh 'any(startswith(".github/"))' 'any(startswith(".nothing/"))'
mutate gnu-date _lib.sh "at=\$(jq -nr 'now - 120 | floor | strftime(\"%Y-%m-%dT%H:%M:%SZ\")' 2>/dev/null) || at=\"\"" 'at=$(date -u -d "@$(( $(date +%s) - 120 ))" +%Y-%m-%dT%H:%M:%SZ)'
# ── 许可函数里的每一项判断（两次都跳过）──
mutate permit-auth _lib.sh '    rc=0; autopilot_authorization "$AP_N" "$ij" "$pr" "$pj" || rc=$?' '    rc=0'
mutate permit-issue-halt _lib.sh "    if printf '%s' \"\$ij\" | jq -e --arg H \"\$LABEL_PENDING_HUMAN\" 'any(.labels[]?; .name == \$H)' >/dev/null 2>&1; then
        AP_V=human" '    if false; then
        AP_V=human'
mutate permit-reviewed-head _lib.sh 'if [ -z "$AP_RH" ] || [ "$AP_RH" != "$AP_HEAD" ] || ' 'if '
mutate permit-review-base _lib.sh '[ -z "$AP_RB" ] || [ "$AP_RB" != "$AP_BASE" ] || ' ''
mutate permit-evidence _lib.sh '    rc=0; autopilot_review_evidence "$pr" "$AP_HEAD" "$AP_RAT" || rc=$?' '    rc=0'
mutate permit-checks _lib.sh '        fail) AP_V=worker;' '        fail) ;; failx) AP_V=worker;'
mutate permit-conflict _lib.sh '        conflict) AP_V=worker;' '        conflictx) AP_V=worker;'
# ── 合并前的第二次判定：整个不做 / 只在第二次跳过某一项 ──
mutate reread-none _lib.sh "$SECOND_OLD" '    :
    if [ "$AP_V" != ok ]'
mutate2 reread-pr-halt 'case ",$labels," in *",$LABEL_PENDING_HUMAN,"*) AP_V=halt_pr' 'case ",$labels,${AP_SECOND:+x}" in *",$LABEL_PENDING_HUMAN,") AP_V=halt_pr'
mutate2 reread-issue-halt "    if printf '%s' \"\$ij\" | jq -e --arg H \"\$LABEL_PENDING_HUMAN\" 'any(.labels[]?; .name == \$H)' >/dev/null 2>&1; then
        AP_V=human" "    if [ -z \"\${AP_SECOND:-}\" ] && printf '%s' \"\$ij\" | jq -e --arg H \"\$LABEL_PENDING_HUMAN\" 'any(.labels[]?; .name == \$H)' >/dev/null 2>&1; then
        AP_V=human"
mutate2 reread-auth '    rc=0; autopilot_authorization "$AP_N" "$ij" "$pr" "$pj" || rc=$?' '    rc=0; [ -n "${AP_SECOND:-}" ] || autopilot_authorization "$AP_N" "$ij" "$pr" "$pj" || rc=$?'
# 第二次判定时新推送 / 改投有两道拦截：复审记录对不上、两次判定的身份对不上。单拆一道另一道仍会拦住
# （本来就是双保险，不是测试漏洞），所以这项把两道一起拆掉，必须变红
mutate reread-identity _lib.sh "$SECOND_OLD" "$SECOND_NEW" \
    'if [ -z "$AP_RH" ] || [ "$AP_RH" != "$AP_HEAD" ] || [ -z "$AP_RB" ] || [ "$AP_RB" != "$AP_BASE" ] || [ -z "$AP_RAT" ]; then' \
    'if [ -z "$AP_RH" ] || { [ -z "${AP_SECOND:-}" ] && { [ "$AP_RH" != "$AP_HEAD" ] || [ "$AP_RB" != "$AP_BASE" ]; }; } || [ -z "$AP_RB" ] || [ -z "$AP_RAT" ]; then' \
    ' || [ "$AP_HEAD" != "$head" ] || [ "$AP_BASE" != "$base" ] \' ' \'
mutate2 reread-files '    case "$(autopilot_files_verdict "$pr")" in' '    case "$([ -n "${AP_SECOND:-}" ] && echo ok || autopilot_files_verdict "$pr")" in'
mutate2 reread-evidence '    rc=0; autopilot_review_evidence "$pr" "$AP_HEAD" "$AP_RAT" || rc=$?' '    rc=0; [ -n "${AP_SECOND:-}" ] || autopilot_review_evidence "$pr" "$AP_HEAD" "$AP_RAT" || rc=$?'
mutate2 reread-checks '        fail) AP_V=worker;' '        fail) [ -n "${AP_SECOND:-}" ] && { AP_V=ok; return 0; }; AP_V=worker;'
mutate2 reread-checks-pending '        pending) AP_V=wait_checks;' '        pending) [ -n "${AP_SECOND:-}" ] && { AP_V=ok; return 0; }; AP_V=wait_checks;'
mutate reread-new-checks _lib.sh ' \
       || [ "$AP_REF" != "$ref" ] || { [ "$checks" = none ] && [ "$AP_CHECKS" != none ]; }; then' ' \
       || [ "$AP_REF" != "$ref" ]; then'
mutate2 reread-conflict '    case "$(autopilot_conflict_verdict "$pj")" in' '    case "$([ -n "${AP_SECOND:-}" ] && echo ok || autopilot_conflict_verdict "$pj")" in'
# ── 派工 / 收队处 ──
mutate dispatch-site _lib.sh '    case "$rc" in
        0) AUTOPILOT_ISSUE="$n"; return 0 ;;' '    rc=0
    case "$rc" in
        0) AUTOPILOT_ISSUE="$n"; return 0 ;;'
mutate collect-site agent-poll.sh '        rc=0; autopilot_authorization "$num" "$ij" || rc=$?
        case "$rc" in' '        rc=0
        case "$rc" in'
# ── 托管关掉之后的收尾（GitHub#124）──
mutate off-sweep-not-called agent-poll.sh 'autopilot_off_sweep "$STATE_FILE" || true' ':'
mutate off-sweep-any-pr _lib.sh '| .[][] | select($prs[(.number | tostring)] != null)' '| .[][]'
mutate off-sweep-no-reread _lib.sh "        printf '%s' \"\$pj\" | jq -e '.state == \"open\" and (.merged | not)' >/dev/null 2>&1 || continue" '        :'
mutate off-sweep-no-intent _lib.sh ' or ($prs[(.number | tostring)].off_handover // false)' ''
mutate off-sweep-intent-late _lib.sh "        if [ \"\$(autopilot_state_get \"\$sf\" '.prs[\$p].off_handover // false' --arg p \"\$pr\")\" != true ]; then" '        if false; then' \
    '        # ③ 交人说明只发一条' '        autopilot_state_set "$sf" '"'"'.prs[$p] = ((.prs[$p] // {}) + {off_handover: true})'"'"' --arg p "$pr" || true
        # ③ 交人说明只发一条'
mutate off-sweep-no-dedupe _lib.sh "        if ! printf '%s' \"\$cmts\" | jq -e --arg T \"\$AUTOPILOT_OFF_TAG\" 'any(.[][]?; (.body // \"\") | contains(\$T))' >/dev/null 2>&1; then" '        if true; then'
# 「先摘后加」那个旧写法不再单列：交接记号在动 GitHub 之前就记下，摘完加失败的 PR 下一轮靠记号也找得回来
mutate off-sweep-no-verify _lib.sh '*",$m,"*) log "托管已关：PR #$pr 回读仍挂着 $m，下轮再收尾"; continue ;;' '*",$m,"*) ;;'
mutate remember-review agent-poll.sh '            autopilot_remember_review "$STATE_FILE" "$2"' '            :'
# ── PR 上的托管标签（GitHub#128）──
# 两处合起来的授权判据
mutate pr-no-stopline _lib.sh 'elif all($u[]; . < $t) then "after" else "before" end' 'elif true then "after" else "before" end'
mutate pr-stops-ignored _lib.sh 'unl: map(select(.value.event == "unlabeled")' 'unl: map(select(false)'
mutate pr-no-actor-check _lib.sh '        rc=0; autopilot_actor_check "$(printf '"'"'%s'"'"' "$here" | jq -r '"'"'.lab.actor'"'"')"' '        rc=0; [ "$cand" = pr ] || autopilot_actor_check "$(printf '"'"'%s'"'"' "$here" | jq -r '"'"'.lab.actor'"'"')"'
mutate pr-stale-auth-ok _lib.sh '            *:before) ;;' '            *:before) [ "$rc" = 0 ] && { ok_kind="$kind"; ok_num="$cnum"; ok_place="$here"; ok_actor="$AUTOPILOT_ACTOR"; } ;;'
mutate pr-no-time-ok _lib.sh 'elif $t == null or $t == "" or any($u[]; . == null or . == "") then "unknown"' 'elif false then "unknown"'
# 三个调用点各自接到两处判据（单独拆掉一处只看 issue）
mutate pr-site-permit _lib.sh '    rc=0; autopilot_authorization "$AP_N" "$ij" "$pr" "$pj" || rc=$?' '    rc=0; autopilot_authorization "$AP_N" "$ij" || rc=$?'
mutate pr-site-dispatch _lib.sh '        autopilot_authorization "$n" "$ij" "$num" "$pj" || rc=$?' '        autopilot_authorization "$n" "$ij" || rc=$?'
mutate pr-site-takeover _lib.sh '    rc=0; autopilot_authorization "$AT_N" "$ij" "$pr" "$pj" || rc=$?' '    rc=0; autopilot_authorization "$AT_N" "$ij" || rc=$?'
# 接手
mutate takeover-not-called agent-poll.sh 'autopilot_takeover_tick "$STATE_FILE" || true' ':'
mutate takeover-in-flow _lib.sh '    if autopilot_labels_in_flow "$rest"; then AT_V=skip; return 0; fi' '    :'
mutate takeover-human-order _lib.sh '                AT_V=skip; AT_WHY=human-later' '                AT_V=take; return 0'
mutate takeover-issue-halt _lib.sh "        AT_V=skip; return 0
    fi
    rc=0; autopilot_authorization \"\$AT_N\"" "        :
    fi
    rc=0; autopilot_authorization \"\$AT_N\""
mutate takeover-once _lib.sh '    # 写之前：同一个判定用现读的数据原样再跑一遍，结论和身份都没变才写
    autopilot_takeover_permit "$pr"' '    :'
mutate takeover-identity _lib.sh '    if [ "$AT_V" != take ] || [ "$AT_N" != "$n" ] || [ "$AT_HEAD" != "$head" ] || [ "$AT_BASE" != "$base" ] \
       || [ "$AT_REF" != "$ref" ] || [ "$AT_REPO" != "$repo" ] || [ "$AT_MODE" != "$mode" ]; then' '    if [ "$AT_V" != take ] && [ "$AT_V" != deny ]; then'
# 写前那次重判只看 PR、不看 issue 一侧（复审第 1 轮指出的错误做法）
TAKE2_OLD='    # 写之前：同一个判定用现读的数据原样再跑一遍，结论和身份都没变才写
    autopilot_takeover_permit "$pr"'
TAKE2_NEW='    # 写之前：同一个判定用现读的数据原样再跑一遍，结论和身份都没变才写
    AT_SECOND=1 autopilot_takeover_permit "$pr"'
mutate takeover-reread-pr-only _lib.sh "$TAKE2_OLD" "$TAKE2_NEW" \
    "    if printf '%s' \"\$ij\" | jq -e --arg H \"\$LABEL_PENDING_HUMAN\" 'any(.labels[]?; .name == \$H)' >/dev/null 2>&1; then
        AT_V=skip; return 0" "    if [ -z \"\${AT_SECOND:-}\" ] && printf '%s' \"\$ij\" | jq -e --arg H \"\$LABEL_PENDING_HUMAN\" 'any(.labels[]?; .name == \$H)' >/dev/null 2>&1; then
        AT_V=skip; return 0" \
    '    rc=0; autopilot_authorization "$AT_N" "$ij" "$pr" "$pj" || rc=$?' '    rc=0; [ -n "${AT_SECOND:-}" ] || autopilot_authorization "$AT_N" "$ij" "$pr" "$pj" || rc=$?'
mutate takeover-cache-pr-only _lib.sh '        key="$upd|$n|$iupd"' '        key="$upd"'
mutate takeover-no-notice _lib.sh '        actor-*|binding|requester-bot|closed) ;;' '        nothing) ;;'
mutate takeover-issue-only-candidate _lib.sh 'select(any(.labels[]?; .name == $L or .name == $H) or' 'select(any(.labels[]?; .name == $L) or'
mutate takeover-coexist _lib.sh "'[.labels[]?.name | select(. != \$L and . != \$H)] | join(\",\")')" "'[.labels[]?.name | select(. != \$L and . != \$H and false)] | join(\",\")')"
mutate takeover-unknown-no-count _lib.sh '        *) autopilot_takeover_unknown "$sf" "$pr" "$AT_REASON" "$key"; return 0 ;;' '        *) return 0 ;;'
mutate takeover-unknown-no-done _lib.sh '    if [ "$k" = done ]; then' '    if false; then'
mutate takeover-unknown-done-early _lib.sh '    autopilot_state_set "$sf" '"'"'.takeover_handoff[$p].labeled = true'"'"' --arg p "$pr" || return 0' '    autopilot_state_set "$sf" '"'"'del(.takeover_handoff[$p]) | .takeover_unknown[$p] = "done"'"'"' --arg p "$pr"; return 0'
mutate unk-second-not-counted _lib.sh '    if [ "$AT_V" = unknown ]; then autopilot_takeover_unknown "$sf" "$pr" "$AT_REASON" "$key"; return 0; fi' '    :'
mutate unk-reset-on-first-take _lib.sh '    case "$AT_V" in skip|deny) autopilot_takeover_reset "$sf" "$pr" ;; esac' '    case "$AT_V" in skip|deny|take) autopilot_takeover_reset "$sf" "$pr" ;; esac'
mutate handoff-not-first _lib.sh '        if [ -n "$(autopilot_state_get "$sf" '"'"'.takeover_handoff[$p]'"'"' --arg p "$num")" ]; then' '        if false; then'
mutate handoff-no-rejudge _lib.sh '    # 现读重判：和普通接手用的是同一个许可函数
    autopilot_takeover_permit "$pr"
    case "$AT_V" in' '    autopilot_takeover_permit "$pr"; AT_V=unknown
    case "$AT_V" in'
mutate handoff-skip-not-dropped _lib.sh '                drop="现在判得出结论了（不接手）"' '                :'
mutate handoff-take-not-dropped _lib.sh '        *) drop="现在判得出结论了（${AT_V}）" ;;' '        *) : ;;'
mutate handoff-human-not-mine _lib.sh '               && [ "$(requester_bot_lc "$AT_HUMAN_BY")" = "$(requester_bot_lc "$me")" ]; then' '               ; then'
# 记下的 issue 编号、分支、来源三项一起核对（分支必须和 issue 编号对应，所以单拆一项另两项仍会拦住，这里整段拆掉）
mutate handoff-no-identity _lib.sh '                drop="PR 的 issue / 分支 / 来源和交人决定时不一样了"' '                :'
mutate handoff-no-dedupe _lib.sh "    if ! printf '%s' \"\$cmts\" | jq -e --arg T \"<!-- cavil-loop:autopilot-takeover-unknown pr=\$pr -->\"" "    if true || ! printf '%s' \"\$cmts\" | jq -e --arg T \"<!-- cavil-loop:autopilot-takeover-unknown pr=\$pr -->\""
mutate handoff-relabel _lib.sh '    if [ "$labeled" != true ]; then
        labels=' '    if true; then
        labels=' '            *",$LABEL_PENDING_HUMAN,"*) ;;
            *) run_gh "label 翻转 (托管接手判不了' '            *",$LABEL_PENDING_HUMAN,nomatch"*) ;;
            *) run_gh "label 翻转 (托管接手判不了'
mutate takeover-unknown-no-reset _lib.sh '        || autopilot_state_set "$1" '"'"'del(.takeover_unknown[$p])'"'"' --arg p "$2" || true' '        || true'
mutate handoff-cont-no-identity _lib.sh '        if { [ -n "$n" ] && [ "$AT_N" != "$n" ]; } || { [ -n "$ref" ] && [ "$AT_REF" != "$ref" ]; } \' '        if false && { [ -n "$n" ] && [ "$AT_N" != "$n" ]; } || false && { [ -n "$ref" ] && [ "$AT_REF" != "$ref" ]; } \'
mutate handoff-no-label-present _lib.sh '        elif [ "$labeled" = true ] && ! printf' '        elif false && ! printf'
mutate handoff-cancelled-redo _lib.sh '    if [ "$k" = done ] || [ "$k" = cancelled ]; then' '    if [ "$k" = done ]; then'
# 旧实现对照（复审第 2 轮要求）：上一版 a420448 的 _lib.sh 整份换进来，必须有检查变红
mutate_old() {   # <名字> <提交>
    local name="$1" rev="$2" M="$SANDBOX/mut-$1"
    mutation_gate || return 0
    mut_in_shard || return 0
    mut_ran=$((mut_ran + 1))
    rm -rf "$M"; mkdir -p "$M"; cp -r "$REPO_DIR/scripts" "$REPO_DIR/prompts" "$M/"
    if ! git -C "$REPO_DIR" show "$rev:scripts/_lib.sh" > "$M/scripts/_lib.sh" 2>/dev/null; then
        echo "  ❌ 负对照 $name：取不到 $rev 的旧实现（准备失败）"; mut_fail=$((mut_fail + 1)); return 0
    fi
    pass=0; fail=0; QUIET=1
    run_scenarios "$M/scripts"
    QUIET=0
    if [ "$fail" -gt 0 ]; then echo "  ✅ 负对照 $name：$fail 条检查变红"
    else echo "  ❌ 负对照 $name：旧实现整套检查仍全绿"; mut_fail=$((mut_fail + 1)); fi
}
mutate_old old-a420448 a4204481429c54cd1803ca8d68aab27fecc9f71d
# 上一轮复审（PR #132 第 2 轮）打回的那一版：交人待办丢失、写前那次判不了不计数、交人前不核对 PR 状态
mutate_old prev-083fc09 083fc09b80972778d3efb47da4788d87e6fca881
# 复审第 3 / 4 轮打回的那一版：交人待办不重判，压掉新授权、改绑后照写
mutate_old prev-046867f 046867f24326de38f1cc373ce067ab5ca485b085
# 复审第 5 轮打回的那一版：标签已加、只欠说明时不核对身份和 pending/human 还在不在
mutate_old prev-58e19a2 58e19a224f64909f18cacbbacae3e1fe692e3d34
pass=$REAL_PASS; fail=$REAL_FAIL

echo
mutation_summary "$0"
echo "正式版：$pass 通过 / $fail 失败；负对照失效 $mut_fail 条（本次跑了 $mut_ran 条）"
[ "$fail" -eq 0 ] && [ "$mut_fail" -eq 0 ]
