#!/usr/bin/env bash
# 托管标签：方案只过复审、复审与测试通过后 daemon 自动合并 —— GitHub#114。
#
# 跑法：bash tests/autopilot.test.sh              （默认不跑末尾的负对照）
#       MUTATION=1 bash tests/autopilot.test.sh   （连负对照一起跑：整套场景在每份改坏的脚本副本上
#       各重跑一遍，见 tests/lib/mutation.sh）
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
    ev() {   # <n> <labeled|unlabeled> <标签> <操作人> [类型]
        jset events.json '.[$n] = ((.[$n] // []) + [{event:$e, label:{name:$l}, actor:{login:$a, type:$t}}])' \
            --arg n "$1" --arg e "$2" --arg l "$3" --arg a "$4" --arg t "${5:-User}"
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
    mkissue 7 "pending/PR"; jset labels.json '.["8"] = ["pending/merge","autopilot"]'
    tick
    chk "只有 PR 上挂托管标签（worker 复制过去），issue 上没有 → 不合并" "$(merged 8)" 0
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
        echo '{"5":["autopilot"],"6":["autopilot","pending/agent"],"7":["autopilot","pending/PR"],"8":["pending/merge","pending/review"]}' > "$out/gh/labels.json"
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
    local N=987714
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
mutate auth-last-event _lib.sh 'if [ "$ev_kind" != labeled ]; then' 'if false; then'
mutate auth-unknown-ok _lib.sh 'AUTOPILOT_REASON="读不到 issue #$num 的标签记录"; return 2' 'AUTOPILOT_ACTOR=x; return 0'
mutate evidence-failed _lib.sh 'select(.h == $h and (.f | tonumber) == 0 and (.p | tonumber) > 0)' 'select(.h == $h)'
mutate dot-github _lib.sh 'any(startswith(".github/"))' 'any(startswith(".nothing/"))'
mutate gnu-date _lib.sh "at=\$(jq -nr 'now - 120 | floor | strftime(\"%Y-%m-%dT%H:%M:%SZ\")' 2>/dev/null) || at=\"\"" 'at=$(date -u -d "@$(( $(date +%s) - 120 ))" +%Y-%m-%dT%H:%M:%SZ)'
# ── 许可函数里的每一项判断（两次都跳过）──
mutate permit-auth _lib.sh '    rc=0; autopilot_authorization "$AP_N" "$ij" || rc=$?' '    rc=0'
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
mutate2 reread-auth '    rc=0; autopilot_authorization "$AP_N" "$ij" || rc=$?' '    rc=0; [ -n "${AP_SECOND:-}" ] || autopilot_authorization "$AP_N" "$ij" || rc=$?'
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
mutate dispatch-site _lib.sh '    rc=0; autopilot_authorization "$n" "$ij" || rc=$?
    case "$rc" in
        0) AUTOPILOT_ISSUE="$n"; return 0 ;;' '    rc=0
    case "$rc" in
        0) AUTOPILOT_ISSUE="$n"; return 0 ;;'
mutate collect-site agent-poll.sh '        rc=0; autopilot_authorization "$num" "$ij" || rc=$?
        case "$rc" in' '        rc=0
        case "$rc" in'
# ── 托管关掉之后的收尾（GitHub#124）──
mutate off-sweep-not-called agent-poll.sh 'autopilot_off_sweep "$STATE_FILE" || true' ':'
mutate off-sweep-any-pr _lib.sh "        printf '%s\\n' \"\$mine\" | grep -qx \"\$pr\" || continue" '        :'
mutate off-sweep-no-reread _lib.sh "        printf '%s' \"\$pj\" | jq -e --arg M \"\$m\" '.state == \"open\" and (.merged | not) and any(.labels[]?; .name == \$M)' >/dev/null 2>&1 || continue" '        :'
mutate off-sweep-no-verify _lib.sh '            *",$m,"*) log "托管已关：PR #$pr 回读仍挂着 $m，下轮再收尾"; continue ;;' '            *",$m,"*) ;;'
mutate remember-review agent-poll.sh '            autopilot_remember_review "$STATE_FILE" "$2"' '            :'
# 旧实现对照（复审第 2 轮要求）：上一版 a420448 的 _lib.sh 整份换进来，必须有检查变红
mutate_old() {   # <名字> <提交>
    local name="$1" rev="$2" M="$SANDBOX/mut-$1"
    mutation_gate || return 0
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
pass=$REAL_PASS; fail=$REAL_FAIL

echo
mutation_summary "$0"
echo "正式版：$pass 通过 / $fail 失败；负对照失效 $mut_fail 条（本次跑了 $mut_ran 条）"
[ "$fail" -eq 0 ] && [ "$mut_fail" -eq 0 ]
