#!/usr/bin/env bash
# kind: e2e
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
#
# 拆成 3 段（GitHub#211）：tests/run.sh 用 TEST_PART=K/3 把每段当一个调度单位并行跑；直接跑本文件
# 不带 TEST_PART 时三段全跑。段 1 =【1】–【7c】+【12k】+【8】【9】，段 2 =【12】系列（【12k】除外），
# 段 3 =【13】【14】【11】；
# 负对照按出现顺序轮流分给三段（每份负对照仍把整套场景跑一遍）。
# parts: 3
set -uo pipefail
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
# shellcheck source=lib/mutation.sh
source "$TEST_DIR/lib/mutation.sh"
# shellcheck source=lib/parts.sh
source "$TEST_DIR/lib/parts.sh"
# shellcheck source=lib/compat.sh
source "$TEST_DIR/lib/compat.sh"
# shellcheck source=lib/prompt-files.sh
source "$TEST_DIR/lib/prompt-files.sh"

SANDBOX=$(mktemp -d)
trap '[ -n "${KEEP_SANDBOX:-}" ] && echo "SANDBOX=$SANDBOX" || rm -rf "$SANDBOX"' EXIT
mkdir -p "$SANDBOX/bin" "$SANDBOX/home"
export HOME="$SANDBOX/home"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
unset CODING_AGENT_RELEASE_ROOT LABEL_AUTOPILOT DISPATCH_AUTOPILOT DISPATCH_AUTOPILOT_ISSUE DISPATCH_AUTOPILOT_PR
# 在托管 worker 的会话里跑本文件时，这两个派工变量会被继承，【9】的三条提示词检查就拿到别人的值（GitHub#337 时撞到）
unset DISPATCH_AUTOPILOT_WHERE DISPATCH_PROMPT_KIND AUTOPILOT_HUMAN_PATHS AUTOPILOT_HUMAN_PATHS_DEFAULT
# 不继承运行者机器上的令牌（CI 上没有）：派工脚本需要的那把由沙盘配置给占位值（代码复审第 3 轮）
unset GH_TOKEN WRITE_GH_TOKEN GITHUB_TOKEN

bash "$TEST_DIR/lib/fake_gh_client.sh" install "$SANDBOX/bin/gh" python3 "$TEST_DIR/lib/fake_github.py"
cat > "$SANDBOX/bin/tmux" <<'SH'
#!/usr/bin/env bash
case "$1" in has-session) exit 1 ;; ls|list-sessions) exit 1 ;; esac
exit 0
SH
chmod +x "$SANDBOX/bin/tmux"

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
# 外部需求机器人功能四项都填（requester_bot_enabled 成立）
REQ_ON=('LABEL_PENDING_REQUESTER_BOT="pending/req"' 'REQUESTER_BOT_ACCOUNT="req-bot"' 'REQUESTER_BOT_ALLOWED_ACTORS="loop-bot"' 'REQUESTER_BOT_ORIGIN_MARKER="<!-- by-req -->"')

# ─────────────────────────────────────────────────────────────────────────
# 一整套轮询场景。$1 = 被测的 scripts 目录。
# ─────────────────────────────────────────────────────────────────────────
# 正式版只跑本段的场景（rs_part）；负对照（RS_ALL=1）不论哪段都跑整套
RS_ALL=1
rs_part() { [ "$RS_ALL" = 1 ] || part_on "$1"; }
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
GH_TOKEN="fake-token-for-test"
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
                user:{login:"loop-bot"}, updated_at:"2026-01-01T00:00:00Z", created_at:$ca,
                head:{sha:$h, ref:$r, repo:{full_name:$repo}}, base:{ref:"main"},
                mergeable:($m | fromjson), mergeable_state:$ms}' \
            --arg n "$1" --arg r "$2" --arg b "$3" --arg h "$4" --arg repo "${6:-example/ap}" \
            --arg m "${7:-true}" --arg ms "${8:-clean}" --arg ca "${MKPR_CREATED:-2025-12-01T00:00:00Z}"
        jset labels.json '.[$n] = ($l | split(",") | map(select(. != "")))' --arg n "$1" --arg l "$5"
        # 真 GitHub 上挂着的标签都有打上它的那条记录；交人的写前核对（GitHub#382）要从记录里认「这一次入队」
        case ",$5," in *",pending/merge,"*) mkpr_queue_ev "$1" ;; esac
    }
    mkpr_queue_ev() {   # <n>：复审把 PR 送进合并队列的那条记录
        jset events.json '.[$n] = ((.[$n] // []) + [{event:"labeled", label:{name:"pending/merge"}, actor:{login:"loop-bot", type:"User"}, created_at:"2025-12-31T00:00:00Z"}])' --arg n "$1"
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

Refs #7" "$H1" "pending/merge,autopilot"
        # PR 上的托管标签是 daemon 从 issue 补过来的副本（GitHub#190），稳态下早就补好了
        ev 8 labeled autopilot loop-bot
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
    off_rec() {   # <pr>：托管关掉后的收尾待办在不在（GitHub#382 起是一条带基准的记录，不再是 true）
        jq -r --arg p "$1" '(.autopilot.prs[$p] // {}) | if has("off_handover") then "待办" else "" end' "$STATE" 2>/dev/null
    }
    st() { jq -r --arg p "$1" "(.autopilot.prs[\$p] // {}) | $2 // \"\"" "$STATE" 2>/dev/null; }
    log_has() { grep -cF -- "$1" "$W/state/poll.log" 2>/dev/null || true; }

    if rs_part 1; then
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

    section "【1c】PR 上 Mac 打包任务显示「已跳过」（GitHub#195）→ 照常合并；同一组里有失败的 → 不合并"
    fresh; happy
    jset checks.json '.[$h] = {check_runs:[{name:"client tests (Linux)", status:"completed", conclusion:"success"}, {name:"dmg (arm64)", status:"completed", conclusion:"skipped"}, {name:"dmg (x64)", status:"completed", conclusion:"skipped"}, {name:"download size (both dmgs)", status:"completed", conclusion:"skipped"}, {name:"测试", status:"completed", conclusion:"success"}]}' --arg h "$H1"
    tick
    chk "已跳过的任务不挡合并" "$(merged 8)" 1
    chk "说明写检查全部通过" "$(comments_with 7 '自动检查全部通过')" 1
    fresh; happy
    jset checks.json '.[$h] = {check_runs:[{name:"client tests (Linux)", status:"completed", conclusion:"failure"}, {name:"dmg (arm64)", status:"completed", conclusion:"skipped"}, {name:"dmg (x64)", status:"completed", conclusion:"skipped"}]}' --arg h "$H1"
    tick
    chk "已跳过的旁边有失败 → 不合并" "$(merged 8)" 0
    chk "  → 交回 worker，点名失败的那个" "$(has_label 8 pending/agent)/$(comments_with 8 '自动检查没过：client tests (Linux)')" "yes/1"

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

    # GitHub#162：外部需求机器人提的需求也能托管——授权看谁打的标签，不看需求是谁提的。
    # 只配账号、和四项都配（功能开启，会走「是不是机器人提的需求」的判定）两种都合并
    local reqcfg
    for reqcfg in only-account enabled; do
        if [ "$reqcfg" = enabled ]; then fresh "${REQ_ON[@]}"; else fresh 'REQUESTER_BOT_ACCOUNT="req-bot"'; fi
        happy
        mkissue 7 "autopilot,pending/PR" req-bot
        jset items.json '.["7"].body = "需求\n\n<!-- by-req -->"'
        tick
        chk "外部需求机器人提的需求、维护者打的托管（$reqcfg）→ 合并" "$(merged 8)/$(has_label 8 pending/human)" "1/no"
    done

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
                 "feature/issue-9|Refs #7|example/ap|分支是别的 issue 的、正文借用 Refs #7" \
                 "feature/issue-7|Refs #7
Refs #10|example/ap|正文引用了两个 issue（Refs 不唯一）" \
                 "feature/issue-7|Closes #7|someone/ap|来自外部仓库（fork）"; do
        IFS='|' read -r br body repo what <<< "$(printf '%s' "$case_" | tr '\n' '\001')"
        br=$(printf '%s' "$br" | tr '\001' '\n'); body=$(printf '%s' "$body" | tr '\001' '\n'); what=$(printf '%s' "$what" | tr '\001' '\n')
        fresh; happy
        mkpr 8 "$br" "$body" "$H1" "pending/merge,autopilot" "$repo"
        tick
        chk "$what → 不合并" "$(merged 8)" 0
        chk "$what → PR 交人" "$(has_label 8 pending/human)" yes
    done
    fresh; happy
    mkpr 8 feature/issue-7 "Fixes: #7

Refs #3" "$H1" "pending/merge,autopilot"
    tick
    # GitHub#233：绑定照旧成立（Fixes: #7 绑 #7，Refs 不关 issue），但正文带关闭关键词，合并时 issue 会被关掉 → 交回 worker 改成 Refs
    chk "Fixes: #7（带冒号）+ 另有 Refs #3 → 不合并，交回 worker 改写" "$(merged 8)/$(has_label 8 pending/agent)" "0/yes"
    chk "  → 打回说明里写了改成 Refs #7" "$(comments_with 8 '改成 `Refs #7`')" 1
    fresh; happy
    mkpr 8 feature/issue-7 "做了 X。

Closes #7" "$H1" "pending/merge,autopilot"
    tick
    chk "老写法 Closes #7（绑定照旧成立）→ 不合并，交回 worker" "$(merged 8)/$(has_label 8 pending/agent)/$(has_label 8 pending/merge)" "0/yes/no"
    chk "  → 记一次打回" "$(st 8 .bounces)" 1

    # ── 【4】叫停 ──
    section "【4】叫停：issue 摘托管标签、issue / PR 任一处打 pending/human"
    fresh; happy
    jset labels.json '.["7"] = ["pending/PR"]'; ev 7 unlabeled autopilot maint
    tick
    chk "issue 摘了托管标签 → 不合并" "$(merged 8)" 0
    chk "  → PR 交人，说明写已摘掉" "$(comments_with 8 '已摘掉（已叫停）')" 1
    fresh; happy
    jset labels.json '.["7"] += ["pending/human"]'; ev 7 labeled pending/human maint
    tick
    chk "issue 上打 pending/human → 不合并" "$(merged 8)" 0
    chk "  → PR 交人" "$(has_label 8 pending/human)" yes
    fresh; happy
    jset labels.json '.["8"] += ["pending/human"]'; ev 8 labeled pending/human maint
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

    fresh; happy; mkpr 8 feature/issue-7 "Refs #7" "$H1" "pending/merge,autopilot" example/ap false dirty
    tick
    chk "有冲突 → 交回 worker" "$(merged 8)/$(has_label 8 pending/agent)" "0/yes"
    fresh; happy; mkpr 8 feature/issue-7 "Refs #7" "$H1" "pending/merge,autopilot" example/ap true dirty
    tick
    chk "只有合并状态说冲突（dirty）→ 也交回 worker" "$(merged 8)/$(has_label 8 pending/agent)" "0/yes"
    fresh; happy; mkpr 8 feature/issue-7 "Refs #7" "$H1" "pending/merge,autopilot" example/ap null unknown
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
    jq '.autopilot.prs["8"].bounces = 5' "$STATE" > "$STATE.tmp" && mv "$STATE.tmp" "$STATE"
    jset checks.json '.[$h] = {check_runs:[{name:"unit", status:"completed", conclusion:"failure"}]}' --arg h "$H1"
    tick
    chk "打回 5 次（没到默认上限 6）再没过 → 仍交回 worker" "$(has_label 8 pending/human)/$(has_label 8 pending/agent)" "no/yes"
    fresh; happy
    jq '.autopilot.prs["8"].bounces = 6' "$STATE" > "$STATE.tmp" && mv "$STATE.tmp" "$STATE"
    jset checks.json '.[$h] = {check_runs:[{name:"unit", status:"completed", conclusion:"failure"}]}' --arg h "$H1"
    tick
    chk "打回次数已到上限（默认 6）再没过 → 交人而不是再打回" "$(has_label 8 pending/human)/$(has_label 8 pending/agent)" "yes/no"

    fresh 'LABEL_PENDING_REVIEW=""'; happy
    tick
    chk "项目没配复审关卡 → 合并这一段整个不动" "$(merged 8)/$(has_label 8 pending/merge)" "0/yes"

    # ── 【7】只挂托管标签的 issue 进派工队列 ──
    section "【7】只挂托管标签的 issue：维护者打的 → 当普通派工（机器人提的需求也一样）；别人打的 → 不派、说一次"
    fresh 'REQUESTER_BOT_ACCOUNT="req-bot"'
    mkissue 20 "autopilot"; ev 20 labeled autopilot maint
    mkissue 21 "autopilot"; ev 21 labeled autopilot loop-bot
    mkissue 22 "autopilot" req-bot; ev 22 labeled autopilot maint
    mkissue 23 "autopilot,pending/human"; ev 23 labeled autopilot maint
    tick
    chk "#20（维护者打的）进派工队列" "$(log_has '托管：issue #20 只挂着托管标签（maint 打的）')" 1
    chk "#21（loop 账号打的）不派" "$(log_has 'issue#21')" 0
    chk "#21 说明一次" "$(comments_with 21 'kind=actor-loop')" 1
    chk "#22（外部需求机器人的需求，维护者打的）也进派工队列" "$(log_has '托管：issue #22 只挂着托管标签（maint 打的）')" 1
    chk "#22 不发「不生效」说明" "$(comments_with 22 'autopilot-notice')" 0
    chk "#23（挂着 pending/human）不当新活收" "$(log_has '托管：issue #23')" 0
    tick
    chk "第二轮：说明不重复" "$(comments_with 21 'kind=actor-loop')" 1
    chk "第二轮：issue 没变过，不再去查被拒那条的标签记录" "$(n_calls "$R/issues/21/events")" 0

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
    mkpr 8 feature/issue-7 "Refs #7" "$H1" "pending/review"
    mkissue 40 "pending/PR"
    mkpr 41 feature/issue-40 "Refs #40" "$H2" "pending/review"
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
    mkpr 8 feature/issue-7 "Refs #7" "$H1" "pending/review"
    : > "$CALLS"; local trc=0
    env CODING_AGENT_CONFIG="$CONF" bash "$SCRIPTS/agent-poll.sh" >/dev/null 2>&1 || trc=$?
    chk "BSD date：轮询正常退出" "$trc" 0
    chk "BSD date：复审提交与时间都记下了" "$(st 8 .reviewed_head)/$([ -n "$(st 8 .reviewed_at)" ] && echo yes || echo no)" "$H1/yes"
    chk "到达性 · BSD date：替身确实拦过 -d（不是没走到）" "$(printf 'x' | env PATH="$SANDBOX/bsd:$PATH" date -u -d @0 >/dev/null 2>&1 && echo passed || echo blocked)" blocked

    fi   # 段 1 到此

    # ── 【12】维护者在 PR 上打托管标签（GitHub#128）──（下面三个函数段 3 也用，定义放在段外）
    # 一条普通（非托管）PR：复审通过后 loop 账号翻了 pending/human 等人合并，维护者在 PR 上打托管标签
    pr_ready() {   # [给 PR 打托管标签的人] [类型]
        mkissue 7 "pending/PR"
        mkpr 8 feature/issue-7 "做了 X。

Refs #7" "$H1" "pending/human,autopilot"
        ev 8 labeled pending/human loop-bot
        ev 8 labeled autopilot "${1:-maint}" "${2:-User}"
    }
    took_none() {   # 没有流程标签的 PR 8 被接手了没有：加上复审、留了接手说明
        if [ "$(has_label 8 pending/review)/$(comments_with 8 'autopilot-takeover pr=8')" = "yes/1" ]; then echo yes; else echo no; fi
    }
    took() {   # PR 8 被接手了没有：翻到复审、摘掉 pending/human、留了接手说明
        if [ "$(has_label 8 pending/review)/$(has_label 8 pending/human)/$(comments_with 8 'autopilot-takeover pr=8')" = "yes/no/1" ]; then echo yes; else echo no; fi
    }
    tk_unknown() { jq -r --arg p "$1" '(.autopilot.takeover_unknown[$p]) // ""' "$STATE" 2>/dev/null; }
    if rs_part 2; then
    section "【12】PR 上打托管标签：维护者亲手打的 → 接手、从复审重来直到合并"
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
    # loop 自己的写入账号打在 PR 上的（worker 违规打的，或 daemon 补的副本）：GitHub#190 起当作没挂——
    # 不接手、也不说「不生效」（副本本来就不是授权，说了是误报）；issue 上没有授权，daemon 把它收回
    fresh; pr_ready loop-bot User
    tick
    chk "loop 自己的写入账号在 PR 上打的 → 不接手、不说「不生效」" "$(took)/$(comments_with 8 'kind=pr-actor-loop')" "no/0"
    chk "  → issue 上没有授权：收回 PR 上这份（GitHub#190）" "$(has_label 8 autopilot)/$(has_label 8 pending/human)" "no/yes"
    tick
    chk "  → 再一轮什么都不写" "$(writes)" 0
    for who in "helper:User:只有读权限:actor-perm" \
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
    chk "issue 是外部需求机器人提的、维护者在 PR 上打的托管 → 接手（GitHub#162）" "$(took)/$(has_label 8 pending/human)" "yes/no"
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
                merge) mkpr 8 feature/issue-7 "Refs #7" "$H1" "pending/merge$( [ "$pl" = yes ] && echo ,autopilot)"
                       review_rec 8 "$H1"; evidence 8 "$H1" 12 0 ;;
                takeover) mkpr 8 feature/issue-7 "Refs #7" "$H1" "pending/human$( [ "$pl" = yes ] && echo ,autopilot)"
                          ev 8 labeled pending/human loop-bot ;;
                dispatch) mkpr 8 feature/issue-7 "Refs #7" "$H1" "pending/review$( [ "$pl" = yes ] && echo ,autopilot)" ;;
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
    ev 8 unlabeled pending/human maint; mkpr_queue_ev 8   # 标签记录和当前标签对得上（真 GitHub 的形状）
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
        # PR 上那份变成 loop 账号打的、issue 上没有授权：那是副本，补标签那一趟把它收回（GitHub#190），不算接手的写入
        chk "$what（判定之后）→ 不接手、零写入" "$(took)/$(( $(writes) - $(n_calls "^gh api -X DELETE $R/issues/8/labels/autopilot\$") ))" "no/0"
        [ "$what" != "PR 上的授权变成 loop 账号打的" ] || chk "  → 变成副本、授权不成立：收回它" "$(has_label 8 autopilot)" no
        chk "到达性 · $what：确实走到了写前重判" "$([ -f "$GD/count_$key" ] && [ "$(cat "$GD/count_$key")" -ge 2 ] && echo yes || echo no)" yes
    done


    section "【12h】跨轮：PR 摘标交人 → 维护者只在 issue 上重新授权 → 接手（复审第 1 轮）"
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
    # 授权在 issue 上有效：补标签那一趟给 PR 补一份（GitHub#190）——这是唯一的写入；副本不算 PR 自己挂着，仍不接手
    chk "没有流程标签、只有 issue 挂托管的 PR（worker 刚开出来）→ 不接手" "$(has_label 8 pending/review)/$(writes)/$(has_label 8 autopilot)" "no/1/yes"
    tick
    chk "  → 下一轮 PR 上挂着副本也不接手、不再写" "$(has_label 8 pending/review)/$(writes)" "no/0"

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

    fi   # 段 2 前半到此；【12k】最慢，放进段 1（段 1 其余场景最轻）
    if rs_part 1; then
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
    # 同样的待办，issue 被关闭 → 作废，不写旧说明
    for change in closed; do
        fresh; unk_ready
        tick; tick; touch "$GD/F_post_labels"; tick
        rm -f "$GD/F_post_labels"
        jset items.json '.["7"].state = "closed"'
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
    # （读不到授权记录时，接手每轮只现读 PR 一次，补标签那一趟（GitHub#190，PR 挂着托管标签、issue 没挂 → 要判收不收回）
    # 每轮再读一次：第 3 轮接手那次是第 5 次，待办现读重判那次是第 6 次）
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
        printf 'cd %q && %s < /dev/null > %q.tmp && mv %q.tmp %q\n' "$GD" "$cmd" "$f" "$f" "$f" > "$GD/hook_pulls_8_6"
        tick; tick; tick
        chk "B $what（交人前现读到）→ 不加 pending/human、没有交人说明、待办作废" \
            "$(has_label 8 pending/human)/$(comments_with 8 'autopilot-takeover-unknown pr=8')/$(tk_owed 8)" "no/0/no"
        chk "到达性 · B $what：确实走到了交人前的现读" "$([ "$(cat "$GD/count_pulls_8" 2>/dev/null)" -ge 6 ] && echo yes || echo no)" yes
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

    fi   # 段 1 的【12k】到此
    if rs_part 2; then
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

    section "【12m】两处都有成立的授权、同一秒：只要有一条明确晚于 PR 上的 pending/human 就接手（复审重置后第 3 轮）"
    # 每行：名字 | issue 挂托管？ | issue 授权时间 | PR 事件（按顺序：h=pending/human、a=autopilot，后接时间）| 期望接手？
    local nm il it pev want
    while IFS='|' read -r nm il it pev want; do
        [ -n "$nm" ] || continue
        fresh
        mkissue 7 "pending/PR$( [ "$il" = yes ] && echo ,autopilot)"
        [ "$il" = yes ] && EV_AT="$it" ev 7 labeled autopilot maint
        mkpr 8 feature/issue-7 "Refs #7" "$H1" "pending/human,autopilot"
        for e in $pev; do
            IFS=@ read -r what at <<< "$e"
            EV_AT="$at" ev 8 labeled "$( [ "$what" = h ] && echo pending/human || echo autopilot)" maint
        done
        tick
        chk "$nm" "$(took)" "$want"
    done <<'ROWS'
复审反例：issue 同秒有授权，PR 内先 pending/human 后 autopilot（同一秒）→ 接手|yes|2026-06-01T00:00:00Z|h@2026-06-01T00:00:00Z a@2026-06-01T00:00:00Z|yes
对照：只有 PR 授权（同一秒，先 pending/human 后 autopilot）→ 接手|no||h@2026-06-01T00:00:00Z a@2026-06-01T00:00:00Z|yes
对照：两处授权，PR 授权晚 1 秒 → 接手|yes|2026-06-01T00:00:00Z|h@2026-06-01T00:00:00Z a@2026-06-01T00:00:01Z|yes
对照：PR 内先 autopilot 后 pending/human（同秒），issue 授权同秒 → 叫停，不接手|yes|2026-06-01T00:00:00Z|a@2026-06-01T00:00:00Z h@2026-06-01T00:00:00Z|no
对照：PR 内先 autopilot 后 pending/human，issue 授权晚 1 秒 → 接手（issue 那条在后）|yes|2026-06-01T00:00:01Z|a@2026-06-01T00:00:00Z h@2026-06-01T00:00:00Z|yes
对照：PR 内先 autopilot 后 pending/human，issue 授权同秒 → 不接手（同秒不算在后）|yes|2026-06-01T00:00:00Z|a@2026-06-01T00:00:00Z h@2026-06-01T00:00:00Z|no
ROWS
    fresh
    mkissue 7 "pending/PR,autopilot"; EV_AT=2026-06-01T00:00:00Z ev 7 labeled autopilot maint
    mkpr 8 feature/issue-7 "Refs #7" "$H1" "pending/human,autopilot"
    EV_AT=2026-06-01T00:00:00Z ev 8 labeled pending/human maint; EV_AT=2026-06-01T00:00:00Z ev 8 labeled autopilot maint
    tick
    chk "复审反例接手时说明写授权打在 PR 上（用的是明确在后的那一条）" "$(comments_with 8 '`maint` 在 PR #8 上打了托管标签')" 1
    tk_unknown() { jq -r --arg p "$1" '(.autopilot.takeover_unknown[$p]) // ""' "$STATE" 2>/dev/null; }
    fresh
    mkissue 7 "pending/PR,autopilot"; ev 7 labeled autopilot maint
    jset events.json '.["7"] |= map(del(.created_at))'
    mkpr 8 feature/issue-7 "Refs #7" "$H1" "pending/human"
    ev 8 labeled pending/human loop-bot
    tick
    chk "唯一的授权在 issue 上、记录缺时间，和 PR 上的 pending/human 比不出先后 → 判不了（计数 1），不当成叫停" "$(took)/$(tk_unknown 8)/$(writes)" "no/1/0"
    chk "到达性 · 这一轮读了 PR 的标签记录" "$([ "$(n_calls "$R/issues/8/events")" -gt 0 ] && echo yes || echo no)" yes

    fi   # 段 2 到此

    if rs_part 3; then
    # ── 【11】托管关掉之后（GitHub#124）：关托管只要改配置，等合并的 PR 由 daemon 交给人 ──
    # ── 【13】没绑 issue 的 PR（GitHub#142）──
    section "【13】没绑 issue 的 PR：维护者在 PR 上亲手打的标签就算授权，看的是打标签那一刻的正文"
    edit() {   # <pr> <修改时间> <那一版的正文> [deleted]：往正文修改历史的最前面加一版（历史按时间倒序）
        [ -f "$GD/edits.json" ] || echo '{}' > "$GD/edits.json"
        if [ "${4:-}" = deleted ]; then
            jset edits.json '.[$n] = ([{editedAt:$t, deletedAt:"2026-09-09T00:00:00Z", diff:null}] + (.[$n] // []))' --arg n "$1" --arg t "$2"
        else
            jset edits.json '.[$n] = ([{editedAt:$t, deletedAt:null, diff:$b}] + (.[$n] // []))' --arg n "$1" --arg t "$2" --arg b "$3"
        fi
    }
    T_LABEL=2026-03-01T00:00:00Z
    po_label() {   # [打标签的人] [类型]：PR 8 上维护者亲手打托管标签（时间 T_LABEL）
        EV_AT="$T_LABEL" ev 8 labeled autopilot "${1:-maint}" "${2:-User}"
    }
    po_merge_ready() {   # [分支] [正文]：没绑 issue、复审已通过、等合并的 PR 8
        mkpr 8 "${1:-feature/xyz}" "${2:-做了 X。}" "$H1" "pending/merge,autopilot"
        po_label
        review_rec 8 "$H1"
        evidence 8 "$H1" 12 0
    }
    gql() { n_calls "^gh api graphql "; }

    section "【13a】刚开就打：PR 正文从没改过，维护者马上打标签 → 接手 → 复审 → 合并"
    fresh 'MAX_CONCURRENT_WORKERS=5'
    mkpr 8 feature/xyz "做了 X。" "$H1" "autopilot"
    po_label
    tick
    chk "接手：加 pending/review、留接手说明" "$(took_none)" yes
    chk "  → 说明写明没绑 issue、只看 PR" "$(comments_with 8 '这个 PR 没绑 issue，授权和叫停都只看 PR 自己')" 1
    chk "到达性 · 读了 PR 正文的修改历史" "$([ "$(gql)" -gt 0 ] && echo yes || echo no)" yes
    tick
    chk "下一轮派复审：是托管条目，授权写在 PR 上" "$(log_has '托管：pr #8 是托管条目（授权在 PR #8，maint 打的）')" 1
    chk "  → 记下复审的提交" "$(st 8 .reviewed_head)" "$H1"
    chk "  → 派工脚本拼出的复审指令带托管规则（标记一路传到复审）" \
        "$(grep -c '维护者在 PR #8 上亲手打了托管标签' "$W/state/prompt-composed-review.md" 2>/dev/null || echo 0)" 1
    jset labels.json '.["8"] = ["pending/merge","autopilot"]'
    evidence 8 "$H1" 12 0 loop-bot 2099-01-01T00:00:00Z
    tick
    chk "复审通过 → 合并" "$(merged 8)" 1
    chk "  → 合并说明发在 PR 上（没有 issue 可发）" "$(comments_with 8 'autopilot-merged pr=8')/$(comments_with 8 '`maint` 在本 PR 上打的托管标签')" "1/1"

    fresh 'MAX_CONCURRENT_WORKERS=5'
    mkpr 8 feature/xyz "做了 X。" "$H1" "pending/agent,autopilot"
    po_label
    tick
    chk "worker 派到这个 PR：拼出的指令是只看 PR 的那一版托管规则" \
        "$(grep -cF '这个 PR **没绑 issue**：授权和叫停都只看 PR #8 自己' "$W/state/prompt-composed-pr-comment.md" 2>/dev/null || echo 0)/$([ -f "$W/state/prompt-composed-pr-comment.md" ] && { grep -cE '^## (开 PR 时|设计阶段)' "$W/state/prompt-composed-pr-comment.md" || true; } || echo 无文件)" "1/0"

    fresh; po_merge_ready
    edit 8 2026-02-01T00:00:00Z "做了 X。"; edit 8 2026-04-01T00:00:00Z "做了 X。补充说明。"
    jset items.json '.["8"].body = "做了 X。补充说明。"'
    tick
    chk "打标签之后正文又改过、改后仍合条件 → 照样合并（看的是打标签那一刻的那一版）" "$(merged 8)" 1

    section "【13b】不是维护者亲手打的 → 不接手、PR 上说一次、不读修改历史"
    # loop 账号打在 PR 上的：GitHub#190 起当作副本（没挂），不接手、不说「不生效」，收回它
    fresh; mkpr 8 feature/xyz "做了 X。" "$H1" "autopilot"; po_label loop-bot User
    tick
    chk "loop 自己的写入账号打的 → 不接手、不说「不生效」、收回" "$(has_label 8 pending/review)/$(comments_with 8 "kind=pr-actor-loop")/$(has_label 8 autopilot)" "no/0/no"
    chk "  → 没读修改历史" "$(gql)" 0
    for who in "helper:User:只有读权限:actor-perm" "renovate[bot]:Bot:Bot 账号:actor-bot"; do
        IFS=: read -r a t what k <<< "$who"
        fresh; mkpr 8 feature/xyz "做了 X。" "$H1" "autopilot"; po_label "$a" "$t"
        tick
        chk "$what 打的 → 不接手、说一次" "$(has_label 8 pending/review)/$(comments_with 8 "kind=pr-$k")" "no/1"
        chk "  → 没读修改历史" "$(gql)" 0
    done

    section "【13c】叫停只看 PR：摘标签、打 pending/human"
    fresh; po_merge_ready
    tick
    chk "对照：不叫停 → 合并" "$(merged 8)" 1
    fresh; po_merge_ready
    jset labels.json '.["8"] = ["pending/merge"]'; ev 8 unlabeled autopilot maint
    tick
    chk "PR 上摘掉托管标签 → 不合并、交人" "$(merged 8)/$(has_label 8 pending/human)" "0/yes"
    fresh; po_merge_ready
    jset labels.json '.["8"] += ["pending/human"]'; ev 8 labeled pending/human maint
    tick
    chk "PR 上打 pending/human → 不合并、摘 pending/merge" "$(merged 8)/$(has_label 8 pending/merge)" "0/no"

    section "【13d】跨仓库、分支撞号 → 按 PR 托管"
    fresh; po_merge_ready feature/issue-1023-x "配套改动。

Refs other/repo#1023"
    tick
    chk "分支 feature/issue-1023-x、正文 Refs other/repo#1023（本仓库没有 #1023）→ 合并" "$(merged 8)" 1
    fresh; mkissue 7 ""; po_merge_ready feature/issue-7 "配套改动。

Refs other/repo#7"
    tick
    chk "分支 feature/issue-7 撞上本仓库无关的 #7（正文不关它）→ 合并" "$(merged 8)" 1
    chk "  → 无关的 #7 一个标签、一条评论都不动" "$(labels_of 7)/$(comments_with 7 'cavil-loop')" "/0"

    section "【13e】拒绝 → 改正文：打标签那一刻正文关着本仓库 issue → 那次不算，重新打才接手（状态保留 / 丢失都一样）"
    fresh; mkissue 58 ""
    mkpr 8 feature/xyz "做了 X。

Closes #58" "$H1" "autopilot"
    edit 8 2026-01-01T00:00:00Z "做了 X。

Closes #58"
    po_label
    tick
    chk "正文关着 #58 却没绑定 → 不接手、说一次" "$(has_label 8 pending/review)/$(comments_with 8 'kind=pr-binding')" "no/1"
    jset items.json '.["8"].body = "做了 X。" | .["8"].updated_at = "2026-04-01T00:00:00Z"'
    edit 8 2026-04-01T00:00:00Z "做了 X。"
    tick
    chk "删掉 Closes #58（状态保留）→ 旧标签仍不算、留言请重打" "$(has_label 8 pending/review)/$(comments_with 8 'kind=pr-label-body')" "no/1"
    chk "  → 留言写明打标签那一刻的正文不合条件" "$(comments_with 8 'PR 后来改过，那次打标签不算')" 1
    rm -f "$STATE"; rm -rf "$W/state/agent-sessions"
    tick
    chk "本机状态整份丢掉（换机器）→ 旧标签仍不算" "$(has_label 8 pending/review)" no
    chk "  → 评论里已有标记，不重复说" "$(comments_with 8 'kind=pr-label-body')" 1
    jset events.json '.["8"] += [{event:"unlabeled", label:{name:"autopilot"}, actor:{login:"maint", type:"User"}, created_at:"2026-05-01T00:00:00Z"},
                                {event:"labeled", label:{name:"autopilot"}, actor:{login:"maint", type:"User"}, created_at:"2026-05-01T00:00:01Z"}]'
    jset items.json '.["8"].updated_at = "2026-05-01T00:00:01Z"'
    tick
    chk "维护者看过现在的正文后重新打 → 接手" "$(took_none)" yes

    fresh; mkissue 58 ""
    po_merge_ready feature/xyz "做了 X。"
    edit 8 2026-01-01T00:00:00Z "做了 X。

Closes #58"
    edit 8 2026-02-01T00:00:00Z "做了 X。"
    edit 8 2026-04-01T00:00:00Z "做了 X。

Closes #58"
    edit 8 2026-05-01T00:00:00Z "做了 X。"
    tick
    chk "打标签那一刻是中间那版干净的（之前、之后都有关 #58 的版本）→ 合并" "$(merged 8)" 1

    section "【13f】绑定被删：绑 #7 的 PR 删掉 Closes #7 → PR 上以前的标签不算，不合并"
    fresh; mkissue 7 "autopilot,pending/human"; ev 7 labeled autopilot maint
    po_merge_ready feature/issue-7 "做了 X。"
    edit 8 2026-01-01T00:00:00Z "做了 X。

Closes #7"
    edit 8 2026-04-01T00:00:00Z "做了 X。"
    tick
    chk "issue 已叫停、worker 删掉 Closes #7 → 不合并、交人" "$(merged 8)/$(has_label 8 pending/human)" "0/yes"
    chk "到达性 · 按没绑 issue 判了（读了修改历史）" "$([ "$(gql)" -gt 0 ] && echo yes || echo no)" yes
    fresh; mkissue 7 "autopilot"; ev 7 labeled autopilot maint
    po_merge_ready feature/xyz "做了 X。

Closes #7"
    tick
    chk "改了分支名、正文还关着 #7 → 不合条件，不合并" "$(merged 8)/$(has_label 8 pending/human)" "0/yes"

    section "【13g】托管中加关闭语句 → 不合并"
    fresh; mkissue 59 ""; po_merge_ready
    jset items.json '.["8"].body = "做了 X。\n\nCloses #59"'
    tick
    chk "worker 在正文加 Closes #59 → 不合并、交人" "$(merged 8)/$(has_label 8 pending/human)" "0/yes"

    section "【13h】同一秒：正文修改和打标签同一秒，分不出先后 → 两版都得合条件"
    fresh; mkissue 58 ""; po_merge_ready
    edit 8 2026-01-01T00:00:00Z "做了 X。"
    edit 8 "$T_LABEL" "做了 X。

Closes #58"
    edit 8 2026-04-01T00:00:00Z "做了 X。"
    tick
    chk "同一秒那版关着 #58 → 不合并" "$(merged 8)" 0
    fresh; po_merge_ready
    edit 8 2026-01-01T00:00:00Z "做了 X。"
    edit 8 "$T_LABEL" "做了 Y。"
    tick
    chk "对照：同一秒那版也干净 → 合并" "$(merged 8)" 1

    section "【13i】修改历史：那一版被删 → 不算；读不到 / 分页读不全 → 判不了、不写；分页读得全 → 照常"
    fresh; po_merge_ready
    edit 8 2026-01-01T00:00:00Z "" deleted
    edit 8 2026-04-01T00:00:00Z "做了 X。"
    tick
    chk "打标签那一刻的那一版被从历史里删掉 → 不合并、交人" "$(merged 8)/$(has_label 8 pending/human)" "0/yes"
    fresh; po_merge_ready; touch "$GD/F_graphql_8"
    tick
    chk "修改历史读不到 → 不合并、零写入" "$(merged 8)/$(writes)" "0/0"
    fresh; po_merge_ready
    edit 8 2026-01-01T00:00:00Z "做了 X。"; edit 8 2026-04-01T00:00:00Z "做了 X。"; edit 8 2026-05-01T00:00:00Z "做了 X。"
    touch "$GD/F_graphql_nocursor_8"
    FAKE_GH_EDIT_PAGE=1 tick
    chk "分页读不全（还有下一页却没给游标）→ 不合并、零写入" "$(merged 8)/$(writes)" "0/0"
    rm -f "$GD/F_graphql_nocursor_8"
    FAKE_GH_EDIT_PAGE=1 tick
    chk "一页一条、要翻到第 3 页才找到 → 合并" "$(merged 8)" 1
    chk "  → 确实翻了页" "$([ "$(n_calls ' -f after=')" -gt 0 ] && echo yes || echo no)" yes

    section "【13j】没绑 issue 的 PR：关联到外部需求机器人的需求、PR 是机器人开的 → 也托管（GitHub#162）；fork 不托管"
    # 原来这几种一律不合并；现在授权只看 PR 上的托管标签是谁打的。功能只配账号 / 四项都配两种都跑
    local rf where reqcfg
    for reqcfg in only-account enabled; do
        for rf in "Refs #58" "Refs https://github.com/example/ap/issues/58"; do
            for where in now then; do
                if [ "$reqcfg" = enabled ]; then fresh "${REQ_ON[@]}"; else fresh 'REQUESTER_BOT_ACCOUNT="req-bot"'; fi
                mkissue 58 "" req-bot; jset items.json '.["58"].body = "需求\n\n<!-- by-req -->"'
                if [ "$where" = now ]; then
                    po_merge_ready feature/xyz "做了 X。

$rf"
                else
                    po_merge_ready
                    edit 8 2026-01-01T00:00:00Z "做了 X。

$rf"
                    edit 8 2026-04-01T00:00:00Z "做了 X。"
                fi
                tick
                chk "「$rf」·$( [ "$where" = now ] && echo 现在的正文 || echo 只在打标签那一刻 )·#58 是机器人的需求（$reqcfg）→ 合并" "$(merged 8)" 1
            done
        done
        if [ "$reqcfg" = enabled ]; then fresh "${REQ_ON[@]}"; else fresh 'REQUESTER_BOT_ACCOUNT="req-bot"'; fi
        po_merge_ready
        jset items.json '.["8"].user.login = "req-bot"'
        tick
        chk "PR 是机器人开的、维护者打的托管（$reqcfg）→ 合并" "$(merged 8)" 1
    done
    fresh; mkpr 8 feature/xyz "做了 X。" "$H1" "pending/merge,autopilot" someone/ap
    po_label; review_rec 8 "$H1"; evidence 8 "$H1" 12 0
    tick
    chk "来自 fork → 不合并" "$(merged 8)" 0

    section "【13k】两次判定之间正文被改 → 本轮不合并、不记任何状态"
    fresh; mkissue 59 ""; po_merge_ready
    tick_hook() { printf 'cd %q && jq %q items.json > items.json.tmp && mv items.json.tmp items.json\n' "$GD" "$1" > "$GD/hook_pulls_8_$2"; }
    tick_hook '.["8"].body = "做了 X。\n\nCloses #59"' 3
    before=$(jq -c '.autopilot.prs' "$STATE")
    tick
    chk "判定之后加了 Closes #59 → 不合并" "$(merged 8)" 0
    chk "  → 本轮这个 PR 的托管记录不变" "$(jq -c '.autopilot.prs' "$STATE")" "$before"
    chk "到达性 · 确实走到了合并前重读" "$([ "$(cat "$GD/count_pulls_8" 2>/dev/null)" -ge 3 ] && echo yes || echo no)" yes

    section "【13m】关闭本仓库 issue 的各种写法都算（代码复审第 1 轮）；指向别的仓库的不算"
    local cb
    while IFS= read -r cb; do
        fresh; mkissue 58 "pending/human"; po_merge_ready feature/xyz "做了 X。

$cb"
        tick
        chk "正文「$cb」→ 不合并、交人" "$(merged 8)/$(has_label 8 pending/human)" "0/yes"
    done <<'CLOSES'
Closes example/ap#58
Fixes https://github.com/example/ap/issues/58
closes: EXAMPLE/AP#58
Resolves GH-58
fixed http://www.github.com/example/ap/issues/58/
CLOSES
    fresh; mkissue 58 ""; po_merge_ready
    edit 8 2026-01-01T00:00:00Z "做了 X。

Fixes https://github.com/example/ap/issues/58"
    edit 8 2026-04-01T00:00:00Z "做了 X。"
    tick
    chk "打标签那一刻的正文用链接写法关 #58、后来删掉 → 不合并" "$(merged 8)" 0
    while IFS= read -r cb; do
        fresh; po_merge_ready feature/xyz "做了 X。

$cb"
        tick
        chk "对照：正文「$cb」（关的是别的仓库 / 只引用不关）→ 合并" "$(merged 8)" 1
    done <<'CLOSES'
Closes other/repo#58
Fixes https://github.com/other/repo/issues/58
Refs example/ap#58
CLOSES

    section "【13n】PR 刚开就打、同一秒：之后正文改过也照样有效；更早的版本缺了才不算（代码复审第 1 轮）"
    fresh; MKPR_CREATED="$T_LABEL" po_merge_ready feature/xyz "做了 X。补充说明。"
    edit 8 "$T_LABEL" "做了 X。"
    edit 8 2026-04-01T00:00:00Z "做了 X。补充说明。"
    tick
    chk "开 PR 和打标签同一秒、之后改过一次（仍合条件）→ 合并" "$(merged 8)" 1
    fresh; mkissue 58 ""; MKPR_CREATED="$T_LABEL" po_merge_ready feature/xyz "做了 X。"
    edit 8 "$T_LABEL" "做了 X。

Closes #58"
    edit 8 2026-04-01T00:00:00Z "做了 X。"
    tick
    chk "同上，但开 PR 时那版关着 #58 → 不合并" "$(merged 8)" 0
    fresh; po_merge_ready feature/xyz "做了 X。补充说明。"
    edit 8 "$T_LABEL" "做了 X。"
    edit 8 2026-04-01T00:00:00Z "做了 X。补充说明。"
    tick
    chk "最早一版和打标签同一秒、但不是开 PR 时那版（更早的缺了）→ 不合并" "$(merged 8)" 0

    section "【13l】绑 issue 的 PR 一次修改历史都不读"
    fresh; happy
    tick
    chk "绑 issue 的 PR 照常合并、没读修改历史" "$(merged 8)/$(gql)" "1/0"

    # ── 【14】PR 上补一份托管标签（GitHub#190）──
    # 托管 issue 绑定的 PR 上，daemon 每轮补一份托管标签（写入身份打的「副本」）；授权明确没了再收回自己补的那份。
    # 补和收回同一个判定、判两次，第二次紧挨着写、全部现读；合并前许可要求 PR 上挂着它。
    local WT='WRITE_GH_TOKEN="write-tok"'
    mirror_ready() {   # [PR 的标签]：issue 7（maint 打的托管）+ 绑定它的 PR 8，PR 上还没有托管标签
        mkissue 7 "autopilot,pending/PR"
        ev 7 labeled autopilot maint
        mkpr 8 feature/issue-7 "做了 X。

Refs #7" "$H1" "${1-pending/review}"
    }
    copy_ready() {   # [PR 的标签]：PR 8 上挂着 daemon 补的副本；issue 7 上维护者已经摘掉托管标签
        mkissue 7 "pending/PR"
        ev 7 labeled autopilot maint
        mkpr 8 feature/issue-7 "做了 X。

Refs #7" "$H1" "${1:-pending/review,autopilot}"
        ev 8 labeled autopilot loop-bot
        ev 7 unlabeled autopilot maint
    }
    adds() { n_calls "^gh api -X POST $R/issues/8/labels -f labels\[\]=autopilot\$"; }
    dels() { n_calls "^gh api -X DELETE $R/issues/8/labels/autopilot\$"; }
    hook() {   # <读取的键> <第几次> <jq 表达式> <文件>：第 k 次读这个路径之前改假 GitHub
        printf 'cd %q && jq %q %s < /dev/null > %s.tmp && mv %s.tmp %s\n' "$GD" "$3" "$4" "$4" "$4" "$4" > "$GD/hook_${1}_$2"
    }
    notices() { echo "$(comments_with 7 'autopilot-notice')/$(comments_with 8 'autopilot-notice')"; }
    unflag() { rm -f "${GD:?}/${1:?}"; }

    section "【14】PR 上补托管标签：授权有效、PR 上没有 → 补一份，用写入身份；之后不再重复（GitHub#190）"
    fresh "$WT"; mirror_ready
    tick
    chk "补上：PR 8 挂上 autopilot" "$(has_label 8 autopilot)" yes
    chk "  → 正好一次加标签请求" "$(adds)" 1
    chk "  → 用的是写入身份" "$(grep -cE "^write-tok gh api -X POST $R/issues/8/labels -f labels\[\]=autopilot\$" "$GD/tokens.log")" 1
    chk "  → PR 上最后一次打托管标签的是 loop 账号（副本）" "$(jq -r '[.["8"][] | select(.event == "labeled" and .label.name == "autopilot")] | last | .actor.login' "$GD/events.json")" loop-bot
    chk "  → issue 上的托管标签原样保留" "$(has_label 7 autopilot)" yes
    chk "  → 不在任何地方说「不生效」" "$(notices)" "0/0"
    chk "  → 日志写明授权在 issue" "$(log_has '托管：PR #8 补上托管标签 autopilot（授权在 issue #7）')" 1
    tick
    chk "再一轮：不再写，也不再读两处的标签记录" "$(writes)/$(n_calls "$R/issues/(7|8)/events")" "0/0"

    section "【14a】补：两次判定之间有变化 → 本轮不写，下一轮按现状重判"
    local hk k2 key cmd file what
    for hk in "issues_7|2|.[\"7\"] = [\"pending/PR\"]|labels.json|issue 摘掉托管标签" \
              "issues_7|2|.[\"7\"] += [\"pending/human\"]|labels.json|issue 打 pending/human" \
              "issues_7|2|.[\"7\"].state = \"closed\"|items.json|issue 关闭" \
              "pulls_8|2|.[\"8\"] += [\"pending/human\"]|labels.json|PR 打 pending/human" \
              "pulls_8|2|.[\"8\"].head.sha = \"$H2\"|items.json|PR 推了新提交" \
              "pulls_8|2|.[\"8\"].base.ref = \"release\"|items.json|PR 改投别的目标分支" \
              "pulls_8|2|.[\"8\"].body = \"Closes #9\"|items.json|PR 正文改绑别的 issue" \
              "pulls_8|2|.[\"8\"].state = \"closed\"|items.json|PR 被关闭" \
              "pulls_8|2|.[\"8\"] += [\"autopilot\"]|labels.json|PR 上已经被人打了托管标签" \
              "pulls_8|2|del(.[\"8\"].base.ref)|items.json|PR 的目标分支读不到" \
              "issues_7_events|2|.[\"7\"] += [{event:\"unlabeled\",label:{name:\"autopilot\"},actor:{login:\"maint\",type:\"User\"},created_at:\"2026-02-01T00:00:00Z\"},{event:\"labeled\",label:{name:\"autopilot\"},actor:{login:\"maint\",type:\"User\"},created_at:\"2026-02-01T00:00:01Z\"}]|events.json|授权换成了另一次打标签（摘掉又重打）"; do
        IFS='|' read -r key k2 cmd file what <<< "$hk"
        fresh "$WT"; mirror_ready
        hook "$key" "$k2" "$cmd" "$file"
        tick
        chk "补 · $what（判定之后）→ 不写" "$(adds)" 0
        chk "到达性 · 补 · $what：确实走到了写前重判" "$(log_has '托管：PR #8 判定补托管标签之后有变化')" 1
    done
    fresh "$WT"; mirror_ready
    hook issues_7_events 2 '.["7"] += [{event:"unlabeled",label:{name:"autopilot"},actor:{login:"maint",type:"User"},created_at:"2026-02-01T00:00:00Z"},{event:"labeled",label:{name:"autopilot"},actor:{login:"maint",type:"User"},created_at:"2026-02-01T00:00:01Z"}]' events.json
    tick; tick
    chk "授权换了一次但仍成立：下一轮照常补上" "$(has_label 8 autopilot)" yes

    section "【14b】补：读不到 → 不写、不记下判定；恢复后补上"
    local f
    for f in "F_issues_7_events:issue 的标签记录" "F_collaborators_maint_permission:打标签人的权限" \
             "F_user:loop 的写入账号" "F_issues_7:issue 本身"; do
        IFS=: read -r key what <<< "$f"
        fresh "$WT"; mirror_ready
        touch "$GD/$key"
        tick
        chk "补 · $what 读不到 → 不写" "$(adds)" 0
        chk "  → 不记下判定" "$(jq -r '.autopilot.mirror["8"] // ""' "$STATE" 2>/dev/null)" ""
        unflag "$key"
        tick
        chk "  → 恢复后补上" "$(has_label 8 autopilot)" yes
    done

    section "【14c】补：不该补的不补"
    fresh "$WT"; mirror_ready
    jset events.json '.["7"] = [{event:"labeled", label:{name:"autopilot"}, actor:{login:"helper", type:"User"}, created_at:"2026-01-01T00:00:01Z"}]'
    tick
    chk "issue 上的标签是没写权限的人打的 → 不补" "$(adds)" 0
    tick
    chk "  → 判过「不补」：issue 和 PR 都没变就不再读标签记录" "$(n_calls "$R/issues/7/events")" 0
    fresh "$WT"; mirror_ready; mkpr 8 feature/xyz "做了 X。" "$H1" "pending/review"
    tick
    chk "没绑 issue 的 PR → 不补" "$(adds)/$(has_label 8 autopilot)" "0/no"
    fresh "$WT"; mirror_ready "pending/review,pending/human"
    tick
    chk "PR 挂着 pending/human（叫停）→ 不补" "$(adds)" 0
    fresh "$WT" 'SELFHEAL_ONLY_OWN_WORKERS=true' 'SELFHEAL_HOST_ID="me"'; mirror_ready
    echo '{"worker_hosts":{"7":"other"}}' > "$STATE"
    tick
    chk "别的机器负责的活 → 不补" "$(adds)" 0
    fresh "$WT" 'LABEL_AUTOPILOT=""'; mirror_ready
    tick
    chk "托管关闭 → 不补" "$(adds)" 0

    section "【14d】补标签失败、复审已通过：不带标签不合并；补上之后合并；一直补不上到上限交人"
    fresh "$WT"; mirror_ready "pending/merge"; review_rec 8 "$H1"; evidence 8 "$H1" 12 0
    touch "$GD/F_post_label_autopilot"
    tick
    chk "加标签失败 → 不合并" "$(merged 8)" 0
    chk "  → 记一次判不了" "$(st 8 .unknown)" 1
    unflag F_post_label_autopilot
    tick
    chk "下一轮补上 → 同一轮合并" "$(has_label 8 autopilot)/$(merged 8)" "yes/1"
    fresh "$WT"; mirror_ready "pending/merge"; review_rec 8 "$H1"; evidence 8 "$H1" 12 0
    touch "$GD/F_post_label_noop_autopilot"
    tick
    chk "加标签返回成功、其实没加上 → 不合并" "$(merged 8)/$(has_label 8 autopilot)" "0/no"
    chk "  → 日志写明读回没有" "$(log_has '补托管标签的请求返回成功，读回却没有')" 1
    : > "$GD/merge_calls"
    tick; tick
    chk "连续 3 轮（上限 3）补不上 → 交人" "$(has_label 8 pending/human)/$(has_label 8 pending/merge)" "yes/no"
    chk "  → 交人说明写了原因" "$(comments_with 8 '上还没有托管标签')" 1
    chk "  → 全程没合并" "$(jq -r '.["8"].merged' "$GD/items.json")" false

    section "【14e】收回：维护者摘了 issue 上的托管标签 → 收回 daemon 补在 PR 上的那份，不说「不生效」"
    fresh "$WT"; copy_ready "pending/merge,autopilot"; review_rec 8 "$H1"; evidence 8 "$H1" 12 0
    tick
    chk "收回副本" "$(has_label 8 autopilot)/$(dels)" "no/1"
    chk "  → 用的是写入身份" "$(grep -cE "^write-tok gh api -X DELETE $R/issues/8/labels/autopilot\$" "$GD/tokens.log")" 1
    chk "  → 不合并、PR 交人" "$(merged 8)/$(has_label 8 pending/human)" "0/yes"
    chk "  → 不说「不生效」" "$(notices)" "0/0"
    tick
    chk "再一轮什么都不写" "$(writes)" 0
    EV_AT=2099-01-01T00:00:00Z ev 7 labeled autopilot maint; jset labels.json '.["7"] += ["autopilot"]'
    jset labels.json '.["8"] = ["pending/review"]'
    tick
    chk "维护者之后在 issue 上重新亲手打 → 再补一份" "$(has_label 8 autopilot)" yes
    fresh "$WT"; copy_ready; jset items.json '.["7"].state = "closed"'
    tick
    chk "issue 关闭了 → 收回" "$(has_label 8 autopilot)" no
    fresh "$WT"; copy_ready; mkissue 7 "autopilot,pending/PR"
    mkpr 8 feature/issue-7 "做了 X。" "$H1" "pending/review,autopilot"
    tick
    chk "PR 正文不再关闭 #7（不绑 issue 了）→ 收回" "$(has_label 8 autopilot)" no

    section "【14f】收回：不该收的不收"
    fresh "$WT"; copy_ready
    jset events.json '.["8"] = [{event:"labeled", label:{name:"autopilot"}, actor:{login:"maint", type:"User"}, created_at:"2026-01-01T00:00:01Z"}]'
    tick
    chk "PR 上的托管标签是维护者亲手打的 → 从不收回" "$(has_label 8 autopilot)/$(dels)" "yes/0"
    fresh "$WT"; copy_ready
    touch "$GD/F_issues_7_events"
    tick
    chk "授权判不了（issue 的标签记录读不到）→ 不收回" "$(dels)" 0
    chk "  → 不记下判定" "$(jq -r '.autopilot.mirror["8"] // ""' "$STATE" 2>/dev/null)" ""
    unflag F_issues_7_events
    tick
    chk "  → 恢复后收回" "$(has_label 8 autopilot)" no
    fresh "$WT"; copy_ready
    touch "$GD/F_user"
    tick
    chk "写入账号读不到（分不出是不是副本）→ 不收回" "$(dels)" 0

    section "【14g】收回：两次判定之间有变化 → 本轮不删，下一轮按现状重判"
    # 这些场景里 PR 挂着流程标签，接手那一趟不读它：收回的两次判定读的是第 1、2 次
    for hk in "pulls_8|2|.[\"8\"].head.sha = \"$H2\"|items.json|PR 推了新提交" \
              "pulls_8|2|.[\"8\"].base.ref = \"release\"|items.json|PR 改投别的目标分支" \
              "pulls_8|2|.[\"8\"].state = \"closed\"|items.json|PR 被关闭" \
              "pulls_8|2|.[\"8\"] += [\"pending/human\"]|labels.json|PR 打 pending/human" \
              "pulls_8|2|del(.[\"8\"].base.ref)|items.json|PR 的目标分支读不到" \
              "pulls_8|2|.[\"8\"].head.ref = \"feature/issue-7b\"|items.json|PR 换了来源分支名" \
              "issues_7|2|.[\"7\"] += [\"pending/human\"]|labels.json|issue 打 pending/human" \
              "issues_7|2|.[\"7\"].state = \"closed\"|items.json|issue 关闭" \
              "issues_8_events|3|.[\"8\"] += [{event:\"unlabeled\",label:{name:\"autopilot\"},actor:{login:\"maint\",type:\"User\"},created_at:\"2026-02-01T00:00:00Z\"},{event:\"labeled\",label:{name:\"autopilot\"},actor:{login:\"maint\",type:\"User\"},created_at:\"2026-02-01T00:00:01Z\"}]|events.json|维护者在 PR 上亲手重打了托管标签" \
              "issues_8_events|3|.[\"8\"] += [{event:\"unlabeled\",label:{name:\"autopilot\"},actor:{login:\"maint\",type:\"User\"},created_at:\"2026-02-01T00:00:00Z\"},{event:\"labeled\",label:{name:\"autopilot\"},actor:{login:\"loop-bot\",type:\"User\"},created_at:\"2026-02-01T00:00:01Z\"}]|events.json|PR 上的副本换成了另一次打的"; do
        IFS='|' read -r key k2 cmd file what <<< "$hk"
        fresh "$WT"; copy_ready
        hook "$key" "$k2" "$cmd" "$file"
        tick
        chk "收回 · $what（判定之后）→ 不删" "$(dels)" 0
        chk "到达性 · 收回 · $what：确实走到了写前重判" "$(log_has '托管：PR #8 判定收回托管标签之后有变化')" 1
    done

    section "【14i】收回：同一次判定里先读到副本、授权那次又读到维护者重打 → 不删（PR #203 代码复审第 1 轮）"
    # 收回判定的读取顺序：PR 标签记录（认副本）→ issue 标签记录 → PR 标签记录（授权）。
    # 第一轮的两次判定读 PR 记录第 1–4 次、issue 记录第 1–2 次；钩子挂在第二次判定的 issue 那一遍上，
    # 让维护者的重打恰好落在「认副本」之后、「授权」之前
    local at sec
    for sec in "2026-02-01T00:00:00Z:和 issue 上的摘掉同一秒" "2026-02-01T00:00:05Z:晚于 issue 上的摘掉"; do
        at="${sec%%Z:*}Z"; what="${sec#*Z:}"
        fresh "$WT"; copy_ready
        jset events.json '.["7"] |= map(if .event == "unlabeled" then .created_at = "2026-02-01T00:00:00Z" else . end)'
        hook issues_7_events 2 ".[\"8\"] += [{event:\"unlabeled\",label:{name:\"autopilot\"},actor:{login:\"maint\",type:\"User\"},created_at:\"$at\"},{event:\"labeled\",label:{name:\"autopilot\"},actor:{login:\"maint\",type:\"User\"},created_at:\"$at\"}]" events.json
        tick
        chk "维护者重打（$what）落在判定内部 → 不删" "$(dels)/$(has_label 8 autopilot)" "0/yes"
        chk "到达性 · $what：确实走到了第二次判定的授权那一遍" "$(cat "$GD/count_issues_7_events" 2>/dev/null)/$(cat "$GD/count_issues_8_events" 2>/dev/null)" "2/4"
        tick
        chk "  → 下一轮：PR 上是维护者亲手打的，仍不删" "$(dels)/$(has_label 8 autopilot)" "0/yes"
    done
    # 没绑 issue 的 PR：授权只读 PR，同样两遍——第二次判定第 1 遍（认副本，第 3 次）之后、第 2 遍（第 4 次）之前重打
    fresh "$WT"
    mkpr 8 feature/xyz "做了 X。" "$H1" "pending/review,autopilot"
    ev 8 labeled autopilot loop-bot
    hook issues_8_events 4 '.["8"] += [{event:"unlabeled",label:{name:"autopilot"},actor:{login:"maint",type:"User"},created_at:"2026-02-01T00:00:00Z"},{event:"labeled",label:{name:"autopilot"},actor:{login:"maint",type:"User"},created_at:"2026-02-01T00:00:00Z"}]' events.json
    tick
    chk "没绑 issue 的 PR：判定内部维护者重打 → 不删" "$(dels)/$(has_label 8 autopilot)" "0/yes"
    chk "到达性 · 两次判定共读了 4 遍 PR 的标签记录" "$(cat "$GD/count_issues_8_events" 2>/dev/null)" 4
    fresh "$WT"
    mkpr 8 feature/xyz "做了 X。" "$H1" "pending/review,autopilot"
    ev 8 labeled autopilot loop-bot
    tick
    chk "对照：没绑 issue 的 PR 上只有副本 → 收回" "$(dels)/$(has_label 8 autopilot)" "1/no"

    section "【14h】副本不是授权：不触发接手"
    fresh "$WT"; mirror_ready ""
    jset labels.json '.["8"] = ["autopilot"]'; ev 8 labeled autopilot loop-bot
    tick
    chk "PR 一个流程标签都没有、只挂着副本 → 不接手" "$(has_label 8 pending/review)/$(comments_with 8 'autopilot-takeover pr=8')" "no/0"
    chk "  → 不说「不生效」" "$(notices)" "0/0"
    chk "到达性 · 这一轮确实为接手读了两处的标签记录" "$([ "$(n_calls "^gh api --paginate --slurp $R/issues/8/events")" -gt 0 ] && echo yes || echo no)" yes
    fresh "$WT"; mirror_ready ""
    jset labels.json '.["8"] = ["autopilot"]'; ev 8 labeled autopilot maint
    tick
    chk "对照：维护者亲手打在 PR 上的 → 照旧接手" "$(has_label 8 pending/review)/$(comments_with 8 'autopilot-takeover pr=8')" "yes/1"

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
    mkpr 9 feature/issue-9 "Refs #9" "$H2" "pending/merge"
    tick
    chk "本机没托管记录的 PR（别的用途的同名标签）→ 不碰" "$(labels_of 9)" "pending/merge"
    chk "  …本机托管过的那个照样交人" "$(has_label 8 pending/human)" yes

    fresh "$OFF"
    mkpr 9 feature/issue-9 "Refs #9" "$H2" "pending/merge"
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
    chk "现读 PR 读不到 → 本轮不动" "$(labels_of 8)" "autopilot,pending/merge"
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
    chk "加 pending/human 失败 → 等合并标签原样留着（下轮还找得到）" "$(labels_of 8)" "autopilot,pending/merge"
    chk "  …也不留言" "$(comments_with 8 '托管已在配置里关掉')" 0
    rm -f "$GD/F_post_labels"; tick
    chk "  …恢复后下一轮交人：有 pending/human、没有等合并" "$(labels_of 8)" "autopilot,pending/human"
    chk "  …留言一次" "$(comments_with 8 '托管已在配置里关掉')" 1

    fresh "$OFF"; happy
    touch "$GD/F_post_comment"
    tick
    chk "留言失败 → 标签已交接" "$(labels_of 8)" "autopilot,pending/human"
    chk "  …交接记号还在（说明还欠着）" "$(off_rec 8)" "待办"
    rm -f "$GD/F_post_comment"; tick
    chk "  …恢复后下一轮补发留言（等合并标签已经没了也找得回来）" "$(comments_with 8 '托管已在配置里关掉')" 1
    chk "  …补发后清掉记号" "$(off_rec 8)" ""
    tick
    chk "  …再一轮零写入、不重复留言" "$(writes)/$(comments_with 8 '托管已在配置里关掉')" "0/1"

    fresh "$OFF"; happy
    touch "$GD/F_post_comment_lost"
    tick
    chk "留言已经发上去、却报失败（响应丢了）→ 待办还在" "$(comments_with 8 '托管已在配置里关掉')/$(off_rec 8)" "1/待办"
    rm -f "$GD/F_post_comment_lost"; tick
    chk "  …下一轮认出已发的留言：不重复发，只清待办" "$(comments_with 8 '托管已在配置里关掉')/$(off_rec 8)/$(n_calls "^gh api -X POST $R/issues/8/comments")" "1//0"

    fresh "$OFF"; happy
    touch "$GD/F_post_labels" "$GD/F_delete_labels" "$GD/F_post_comment"
    tick; tick
    chk "三步全失败两轮 → 等合并标签仍在、没有留言" "$(labels_of 8)/$(comments_with 8 '托管已在配置里关掉')" "autopilot,pending/merge/0"
    rm -f "$GD/F_post_labels"; tick
    chk "  …只恢复加标签：两个标签都在（摘还在失败），不留言" "$(labels_of 8)/$(comments_with 8 '托管已在配置里关掉')" "autopilot,pending/human,pending/merge/0"
    rm -f "$GD/F_delete_labels"; tick
    chk "  …再恢复摘标签：交接完成，留言仍欠着" "$(labels_of 8)/$(off_rec 8)" "autopilot,pending/human/待办"
    rm -f "$GD/F_post_comment"; tick
    chk "  …最后恢复留言：补发一次" "$(comments_with 8 '托管已在配置里关掉')/$(off_rec 8)" "1/"

    # 标签两步都写成功、紧接着的确认读失败（PR #127 复审第 2 轮）：待办在动 GitHub 之前就记下了，下轮接着做。
    # 一轮收尾里 PR 的标签记录依次读 6 次（取基准、加标签前、加完确认、摘标签前、摘完确认、发说明前）；
    # 假 GitHub 先看失败开关、再跑 hook：第 4 次读的 hook 里打开开关，第 5 次读（摘完确认）就失败
    fresh "$OFF"; happy
    printf 'touch %q\n' "$GD/F_issues_8_events" > "$GD/hook_issues_8_events_4"
    tick
    chk "标签改好、确认读失败 → 标签已是目标，待办在，没发说明" "$(labels_of 8)/$(off_rec 8)/$(comments_with 8 '托管已在配置里关掉')" "autopilot,pending/human/待办/0"
    rm -f "$GD/F_issues_8_events" "$GD/hook_issues_8_events_4"; tick
    chk "  …恢复后下一轮认出那次摘标签是自己写成的，补发说明一次、清掉待办" "$(comments_with 8 '托管已在配置里关掉')/$(off_rec 8)" "1/"

    fresh "$OFF"; happy
    touch "$GD/F_issues_8_comments"
    tick
    chk "读不到已有评论（判断不了发没发过）→ 不发" "$(comments_with 8 '托管已在配置里关掉')/$(off_rec 8)" "0/待办"
    rm -f "$GD/F_issues_8_comments"; tick
    chk "  …恢复后发一次" "$(comments_with 8 '托管已在配置里关掉')/$(off_rec 8)" "1/"

    # 旧版留下的「true」记号没有基准（GitHub#382）：分不清是 daemon 中断还是人已接手，一律作废
    fresh "$OFF"; happy
    jset labels.json '.["8"] = ["pending/human"]'; ev 8 unlabeled pending/merge loop-bot; ev 8 labeled pending/human loop-bot
    jq '.autopilot.prs["8"].off_handover = true' "$STATE" > "$STATE.tmp" && mv "$STATE.tmp" "$STATE"
    tick
    chk "旧版记号、PR 已不在合并队列 → 作废：不补发说明、零写入、记号清掉" "$(comments_with 8 '托管已在配置里关掉')/$(writes)/$(off_rec 8)" "0/0/"
    chk "到达性 · 这一轮确实读了这个 PR 的现状" "$([ "$(n_calls "^gh api $R/pulls/8\$")" -gt 0 ] && echo yes || echo no)" yes
    tick
    chk "  …之后不再碰这个 PR" "$(writes)/$(n_calls "^gh api $R/pulls/8\$")" "0/0"

    fresh "$OFF"; happy
    jq '.autopilot.prs["8"].off_handover = true' "$STATE" > "$STATE.tmp" && mv "$STATE.tmp" "$STATE"
    tick
    chk "旧版记号、PR 仍在合并队列 → 这一轮只作废，不写" "$(writes)/$(off_rec 8)/$(labels_of 8)" "0//autopilot,pending/merge"
    tick
    chk "  …下一轮当作新的一件事从头收尾：交人、说明一条、待办清掉" "$(labels_of 8)/$(comments_with 8 '托管已在配置里关掉')/$(off_rec 8)" "autopilot,pending/human/1/"
    chk "到达性 · 这一轮确实读了这个 PR 的评论" "$([ "$(n_calls "$R/issues/8/comments")" -gt 0 ] && echo yes || echo no)" yes

    fresh "$OFF"; happy
    jset items.json '.["8"].state = "closed"'
    tick
    chk "已关闭的 PR 的托管记录被清掉（之后这里不再读 GitHub）" "$(st 8 .reviewed_head)" ""

    fresh; happy
    tick
    chk "开着时这段不插手：照常合并，不留「已关掉」的言" "$(merged 8)/$(comments_with 8 '托管已在配置里关掉')" "1/0"
    fi   # 段 3 到此
}

# ─────────────────────────────────────────────────────────────────────────
# 【8】功能关闭：轮询的 GitHub 调用、state.json、拼出来的提示词都和改动前逐字节一致
# ─────────────────────────────────────────────────────────────────────────
off_mode() {
    local W="$SANDBOX/off" root out roots="old new" same=0
    if compat_skip "功能关闭时两轮轮询的 GitHub 调用、state.json 与改动前" "$SANDBOX/old" "$REPO_DIR" scripts; then
        roots="new"; same=1
    fi
    for root in $roots; do
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
    if [ "$same" = 0 ]; then
    chk "关闭时：两轮轮询的 GitHub 调用和改动前逐条一致" \
        "$(diff <(sed "s|$W/new|W|g" "$W/new/gh/calls.log") <(sed "s|$W/old|W|g" "$W/old/gh/calls.log") >/dev/null && echo same || echo diff)" same
    chk "关闭时：state.json 和改动前逐字节一致" "$(cmp -s "$W/new/state/state.json" "$W/old/state/state.json" && echo same || echo diff)" same
    fi
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
    local root="$1" name same=1 o n names="new-issue issue-comment pr-comment review"
    section "【9】提示词：关闭时和改动前逐字节一致；托管条目拼入托管规则"
    # 旧脚本那边的 prompts/ 已换成当前的，所以两边只差 scripts/
    if compat_skip "四份提示词与改动前" "$SANDBOX/old" "$root" scripts prompts; then names=""; fi
    for name in $names; do
        for env_set in "LABEL_PENDING_REVIEW=pending/review" "LABEL_PENDING_REVIEW=pending/review LABEL_AUTOPILOT=autopilot" \
                       "LABEL_PENDING_REVIEW= LABEL_AUTOPILOT=autopilot DISPATCH_AUTOPILOT=1 DISPATCH_AUTOPILOT_ISSUE=7" \
                       "LABEL_PENDING_REVIEW= LABEL_AUTOPILOT=autopilot DISPATCH_AUTOPILOT=1 DISPATCH_AUTOPILOT_PR=8"; do
            # shellcheck disable=SC2086
            o=$(compose "$SANDBOX/old" "$name" $env_set); n=$(compose "$root" "$name" $env_set)
            if [ -z "$n" ] || [ "$o" != "$n" ]; then same=0; [ "$QUIET" = 1 ] || echo "     不一致：$name / $env_set"; fi
        done
    done
    [ -z "$names" ] || chk "不是托管条目（或没配复审关卡）时，四份提示词和改动前逐字节一致" "$same" 1
    local on="LABEL_PENDING_REVIEW=pending/review LABEL_AUTOPILOT=autopilot DISPATCH_AUTOPILOT=1 DISPATCH_AUTOPILOT_ISSUE=7"
    for name in new-issue issue-comment pr-comment; do
        # shellcheck disable=SC2086
        n=$(compose "$root" "$name" $on)
        chk "$name：拼入 worker 的托管规则" "$(printf '%s' "$n" | grep -c '^# 托管规则（本条是托管条目）')" 1
        chk "$name：写明只写一个 Refs #7、不写关闭关键词、分支 feature/issue-7" "$(printf '%s' "$n" | grep -cF '**只写一个** `Refs #7`，**不写**任何关闭关键词')/$(printf '%s' "$n" | grep -c '`feature/issue-7`')" "1/1"
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
    # 没绑 issue 的 PR（GitHub#142）：worker 拿只看 PR 的那一版，复审写授权在 PR 上
    local m pon="LABEL_PENDING_REVIEW=pending/review LABEL_AUTOPILOT=autopilot DISPATCH_AUTOPILOT=1 DISPATCH_AUTOPILOT_PR=8"
    # shellcheck disable=SC2086
    m=$(compose "$root" pr-comment $pon)
    chk "没绑 issue · pr-comment：拼入只看 PR 的托管规则" \
        "$(printf '%s' "$m" | grep -c '^# 托管规则（本条是托管条目）')/$(printf '%s' "$m" | grep -cF '这个 PR **没绑 issue**：授权和叫停都只看 PR #8 自己')" "1/1"
    chk "没绑 issue · pr-comment：写授权在 PR #8、不让加关闭关键词" \
        "$(printf '%s' "$m" | grep -c '维护者在 PR #8 上亲手打了托管标签')/$(printf '%s' "$m" | grep -c '不要改 PR 正文里的关闭关键词')" "1/1"
    chk "没绑 issue · pr-comment：没有绑 issue 那一版的「开 PR 时」和设计阶段、没有没换掉的占位" \
        "$(printf '%s' "$m" | grep -cE '^## (开 PR 时|设计阶段)')/$(printf '%s' "$m" | grep -c '@@')" "0/0"
    # shellcheck disable=SC2086
    chk "没绑 issue · review：写授权在 PR #8" "$(compose "$root" review $pon | grep -c '维护者在 PR #8 上亲手打了托管标签')" 1
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
    # 编号取得很大，避开本机真实派工的编号（提示词写在本次运行自己的状态目录里）
    local N=$((900000 + $$ % 90000))
    export FAKE_GH_DIR="$W/gh"; mkdir -p "$W/gh"; for f in labels events comments; do echo '{}' > "$W/gh/$f.json"; done
    echo '{"'$N'":{"kind":"issue","state":"open","title":"托管测试","body":"x","user":{"login":"maint"}}}' > "$W/gh/items.json"
    prompt_files_clear "$root" "$W/state"
    (cd "$W/project" && env DISPATCH_AUTOPILOT=1 DISPATCH_AUTOPILOT_ISSUE="$N" CODING_AGENT_CONFIG="$W/conf" \
        bash "$root/scripts/dispatch-new-issue.sh" "$N") >/dev/null 2>&1
    chk "派工脚本写出的提示词带托管规则（标记一路传到 worker）" \
        "$(grep -c '^# 托管规则（本条是托管条目）' "$(prompt_file_of "$root" "$W/state" new "$N")" 2>/dev/null || echo 0)" 1
}

echo "=== 正式版 ==="
RS_ALL=0; run_scenarios "$REPO_DIR/scripts"; RS_ALL=1
if part_on 1; then
section "【8】功能关闭：和改动前逐字节一致"
off_mode
prompts_check "$REPO_DIR"
fi
REAL_PASS=$pass; REAL_FAIL=$fail

# ─────────────────────────────────────────────────────────────────────────
# 【10】负对照（MUTATION=1）：把脚本副本逐个改坏一处，整套场景必须有检查变红
# ─────────────────────────────────────────────────────────────────────────
section "【10】负对照（改坏一处，至少一条检查必须变红）"
mut_fail=0; mut_ran=0
# 负对照很慢（每份都把整套场景重跑一遍，约 2.5 分钟，共 60 多份）。AUTOPILOT_MUT_SHARD=K/N 只跑第 K 份
# （按顺序轮流分），各自独立的沙盘，可以开 N 个进程并行跑；不设 = 全跑。只影响跑哪几份，不改任何判断。
MUT_IDX=0
# AUTOPILOT_MUT_ONLY=名字1,名字2 只跑点名的几份（改到某几处时复跑对应负对照用）；和 SHARD 可以一起用
mut_in_shard() {   # [名字]
    MUT_IDX=$((MUT_IDX + 1))
    if [ -n "${AUTOPILOT_MUT_ONLY:-}" ]; then
        case ",$AUTOPILOT_MUT_ONLY," in *",${1:-},"*) ;; *) return 1 ;; esac
    fi
    [ -n "${AUTOPILOT_MUT_SHARD:-}" ] || return 0
    local k="${AUTOPILOT_MUT_SHARD%/*}" n="${AUTOPILOT_MUT_SHARD#*/}"
    [ $(( (MUT_IDX - 1) % n + 1 )) -eq "$k" ]
}
mutate() {   # <名字> <文件（相对 scripts/）> <原文> <替换后> [<原文> <替换后> …]：每对原文都必须找得到
    local name="$1" file="$2" M="$SANDBOX/mut-$1"
    shift 2
    part_take || return 0
    mutation_gate || return 0
    mut_in_shard "$name" || return 0
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
mutate2 reread-pr-halt '[ -n "${AP_HANDOVER_MINE:-}" ] || { AP_V=halt_pr; return 0; }' '[ -n "${AP_HANDOVER_MINE:-}${AP_SECOND:-}" ] || { AP_V=halt_pr; return 0; }'
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
# GitHub#382 起收尾的每次写入都对着带基准的待办核对，下面几条指向的原文跟着换成新代码里的同一处：
# 现读拦住（PR 已合并就不动）＝ 新待办的判定「开着、挂着等合并标签」
mutate off-sweep-no-reread _lib.sh "            printf '%s' \"\$AF_FP\" | jq -e --arg M \"\$m\" '.pr.open and (.pr.labels | index(\$M) != null)' >/dev/null 2>&1 || continue" '            :'
mutate off-sweep-no-intent _lib.sh ' or ($prs[(.number | tostring)] | has("off_handover"))' ''
# 待写的那一步不在动 GitHub 之前记下：写成之后确认读失败，下一轮就认不出那次是自己写的，说明永远补不上
mutate off-sweep-intent-late _lib.sh "    autopilot_state_set \"\$sf\" '.prs[\$p].off_handover.pending = {op: \$o, label: \$l}' --arg p \"\$pr\" --arg o \"\$op\" --arg l \"\$label\" \\
        || { log \"托管已关：PR #\$pr 记不下待写的那一步，本轮不动\"; return 1; }" '    :'
mutate off-sweep-no-dedupe _lib.sh "        if ! printf '%s' \"\$cmts\" | jq -e --arg T \"\$marker\" 'any(.[][]?; (.body // \"\") | contains(\$T))' >/dev/null 2>&1; then" '        if true; then'
# 摘等合并标签有没有摘掉完全不核对（摘的结果、摘完的确认、发说明前的最终状态三处一起去掉）
mutate off-sweep-no-verify _lib.sh '        autopilot_label_delete "$pr" "$label" || return 1' '        autopilot_label_delete "$pr" "$label" || true' \
    '    if ! autopilot_fingerprint "$pr" || ! autopilot_fp_is_own_write "$(printf '"'"'%s'"'"' "$exp" | jq -cS .)" "$op" "$label"; then' '    if false; then' \
    "            '.pr.open and (.pr.labels | index(\$M) == null) and (.pr.labels | index(\$H) != null)' >/dev/null 2>&1 || continue" "            '.pr.open' >/dev/null 2>&1 || continue"
mutate remember-review agent-poll.sh '            autopilot_remember_review "$STATE_FILE" "$2"' '            :'
# ── PR 上的托管标签（GitHub#128）──
# 两处合起来的授权判据
mutate pr-no-stopline _lib.sh 'elif all($u[]; . < $t) then "after" else "before" end' 'elif true then "after" else "before" end'
mutate pr-stops-ignored _lib.sh 'unl: map(select(.value.event == "unlabeled")' 'unl: map(select(false)'
mutate pr-no-actor-check _lib.sh '        rc=0; autopilot_actor_check "$(printf '"'"'%s'"'"' "$here" | jq -r '"'"'.p.lab.actor'"'"')"' '        rc=0; [ "$kind" = pr ] || autopilot_actor_check "$(printf '"'"'%s'"'"' "$here" | jq -r '"'"'.p.lab.actor'"'"')"'
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
mutate takeover-cache-pr-only _lib.sh '        key="$AUTOPILOT_JUDGE_REV|$upd|$n|$iupd"' '        key="$AUTOPILOT_JUDGE_REV|$upd"'
mutate takeover-no-notice _lib.sh '        actor-*|binding|closed|label-body) ;;' '        nothing) ;;'
mutate takeover-issue-only-candidate _lib.sh 'select(any(.labels[]?; .name == $L or .name == $H) or' 'select(any(.labels[]?; .name == $L) or'
mutate takeover-coexist _lib.sh "'[.labels[]?.name | select(. != \$L and . != \$H)] | join(\",\")')" "'[.labels[]?.name | select(. != \$L and . != \$H and false)] | join(\",\")')"
mutate takeover-unknown-no-count _lib.sh '        *) autopilot_takeover_unknown "$sf" "$pr" "$AT_REASON" "$key"; return 0 ;;' '        *) return 0 ;;'
mutate takeover-unknown-no-done _lib.sh '    if [ "$k" = done ] || [ "$k" = cancelled ]; then' '    if [ "$k" = cancelled ]; then'
mutate takeover-unknown-done-early _lib.sh '    autopilot_state_set "$sf" '"'"'.takeover_handoff[$p].labeled = true'"'"' --arg p "$pr" || return 0' '    autopilot_state_set "$sf" '"'"'del(.takeover_handoff[$p]) | .takeover_unknown[$p] = "done"'"'"' --arg p "$pr"; return 0'
mutate unk-second-not-counted _lib.sh '    if [ "$AT_V" = unknown ]; then autopilot_takeover_unknown "$sf" "$pr" "$AT_REASON" "$key"; return 0; fi' '    :'
mutate unk-reset-on-first-take _lib.sh '    case "$AT_V" in skip|deny) autopilot_takeover_reset "$sf" "$pr" ;; esac' '    case "$AT_V" in skip|deny|take) autopilot_takeover_reset "$sf" "$pr" ;; esac'
mutate handoff-not-first _lib.sh '        if [ -n "$(autopilot_state_get "$sf" '"'"'.takeover_handoff[$p]'"'"' --arg p "$num")" ]; then' '        if false; then'
mutate handoff-no-rejudge _lib.sh '    autopilot_takeover_permit "$pr"
    local cont=""' '    autopilot_takeover_permit "$pr"; AT_V=unknown
    local cont=""'
mutate handoff-skip-not-dropped _lib.sh '                drop="现在判得出结论了（不接手）"' '                :'
mutate handoff-take-not-dropped _lib.sh '        *) drop="现在判得出结论了（${AT_V}）" ;;' '        *) : ;;'
mutate handoff-human-not-mine _lib.sh '               && [ "$(requester_bot_lc "$AT_HUMAN_BY")" = "$(requester_bot_lc "$me")" ]; then' '               ; then'
# 记下的 issue 编号、分支、来源三项一起核对（分支必须和 issue 编号对应，所以单拆一项另两项仍会拦住，这里整段拆掉）
mutate handoff-no-identity _lib.sh '            drop="PR 的 issue / 分支 / 来源和交人决定时不一样了"' '            :'
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
mutate auth-cands-first-only _lib.sh '        done <<< "$AUTOPILOT_AUTH_CANDS"' '        done <<< "$(printf '"'"'%s'"'"' "$AUTOPILOT_AUTH_CANDS" | head -1)"'
mutate auth-cands-unknown-ok _lib.sh '        [ "$when" = after ] || [ -z "$any_unknown" ] || when=unknown' '        :'
# ── 没绑 issue 的 PR（GitHub#142）──
mutate po-closes-ok _lib.sh 'if [ -z "$by_line" ] && [ -z "$by_whole" ]; then
        AUTOPILOT_PR_KIND=pr' 'if true; then
        AUTOPILOT_PR_KIND=pr'
mutate po-current-body-only _lib.sh '    rc=0; autopilot_body_at "$pr" "$t" "$pj" || rc=$?' '    rc=0; AUTOPILOT_BODY_CANDS=$(printf '"'"'%s'"'"' "$pj" | jq -c '"'"'[.body // ""]'"'"')'
mutate po-oldest-version _lib.sh '| sort_by(.editedAt) | .[-1:])' '| sort_by(.editedAt) | .[:1])'
mutate po-same-second-one _lib.sh '([$e[] | select(.editedAt == $t)] + ' '(['
mutate po-deleted-ok _lib.sh 'elif any($c[]; .deletedAt != null or (.diff | type) != "string") then {err: "deleted"}' 'elif false then {err: "deleted"}'
mutate po-unknown-ok _lib.sh '        *) return 2 ;;
    esac
    nb=' '        *) AUTOPILOT_BODY_CANDS=$(printf '"'"'%s'"'"' "$pj" | jq -c '"'"'[.body // ""]'"'"') ;;
    esac
    nb='
mutate po-page-gap-ok _lib.sh '[ -n "$after" ] || { AUTOPILOT_REASON="PR #$pr 正文的修改历史分页读不全"; return 2; }' '[ -n "$after" ] || break'
mutate po-fork-ok _lib.sh '        AUTOPILOT_REASON="PR 不是从本仓库的分支开的（来源：${repo:-未知}）"; return 0
    fi
    body=' '        :
    fi
    body='
mutate po-actor-skip _lib.sh '    rc=0; autopilot_actor_check "$(printf '"'"'%s'"'"' "$pp" | jq -r '"'"'.lab.actor'"'"')" "$(printf '"'"'%s'"'"' "$pp" | jq -r '"'"'.lab.atype'"'"')" || rc=$?
    [ "$rc" = 0 ] || return "$rc"
    actor=' '    rc=0; autopilot_actor_check "$(printf '"'"'%s'"'"' "$pp" | jq -r '"'"'.lab.actor'"'"')" "$(printf '"'"'%s'"'"' "$pp" | jq -r '"'"'.lab.atype'"'"')" || rc=0; AUTOPILOT_ACTOR=x
    actor='
mutate po-qualified-closes _lib.sh '    by_line=$(printf '"'"'%s\n'"'"' "$body" | autopilot_body_closes line any)
    by_whole=$(printf '"'"'%s'"'"' "$body" | autopilot_body_closes whole any)' '    by_line=$(printf '"'"'%s\n'"'"' "$body" | autopilot_body_closes line)
    by_whole=$(printf '"'"'%s'"'"' "$body" | autopilot_body_closes whole)'
mutate po-closes-no-url _lib.sh '|https?://(www\.)?github\.com/[[:alnum:]_.-]+/[[:alnum:]_.-]+/issues/[0-9]+)'"'" ')'"'" \
    '|https?://(?:www\.)?github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/issues/[0-9]+)'"'" ')'"'"
mutate po-closes-other-repo-local _lib.sh '| select(.o == $me) | .n) end;' '| .n) end;'
mutate po-initial-same-second-deny _lib.sh '               and ($created == "" or $first != $created or $first != $t) then {err: "none"}' '               then {err: "none"}'
mutate po-initial-no-created-check _lib.sh '               and ($created == "" or $first != $created or $first != $t) then {err: "none"}' '               and ($first != $t) then {err: "none"}'
# GitHub#162：把「外部需求机器人提的需求不托管」逐处放回去，都必须变红（issue 上按作者、功能开启时按来源、没绑 issue 的 PR）
mutate req-deny-issue-author _lib.sh '    local ip pp
    autopilot_place_read "$num" "$ij" "issue #$num" || return 2' '    local ip pp
    if [ -n "${REQUESTER_BOT_ACCOUNT:-}" ] && [ "$(printf '"'"'%s'"'"' "$ij" | jq -r '"'"'.user.login'"'"')" = "$REQUESTER_BOT_ACCOUNT" ]; then AUTOPILOT_DENY=requester-bot; AUTOPILOT_REASON=x; return 1; fi
    autopilot_place_read "$num" "$ij" "issue #$num" || return 2'
mutate req-deny-issue-origin _lib.sh '    local ip pp
    autopilot_place_read "$num" "$ij" "issue #$num" || return 2' '    local ip pp
    if requester_bot_enabled && requester_bot_item_origin "$num" "$ij"; then AUTOPILOT_DENY=requester-bot; AUTOPILOT_REASON=x; return 1; fi
    autopilot_place_read "$num" "$ij" "issue #$num" || return 2'
mutate req-deny-pr-only _lib.sh '    autopilot_place_read "$pr" "$pj" "PR #$pr" || return 2
    autopilot_place_strip_copy "PR #$pr" || return 2
    pp="$AUTOPILOT_PLACE"; AUTOPILOT_PR_EVENTS="$AUTOPILOT_PLACE_EVENTS"; AUTOPILOT_PR_COPY="$AUTOPILOT_PLACE_COPY"; AUTOPILOT_PR_COPY_READ=1
    if [ -n "$AUTOPILOT_PR_COPY" ]; then' '    if [ "$(printf '"'"'%s'"'"' "$pj" | jq -r '"'"'.user.login'"'"')" = "${REQUESTER_BOT_ACCOUNT:-none}" ] || printf '"'"'%s'"'"' "$pj" | jq -e '"'"'.body | test("#58")'"'"' >/dev/null || [ "$(printf '"'"'%s'"'"' "$pj" | jq -r '"'"'.head.ref'"'"')" = "${REQUESTER_BOT_ACCOUNT:-none}" ]; then AUTOPILOT_DENY=requester-bot; AUTOPILOT_REASON=x; return 1; fi
    autopilot_place_read "$pr" "$pj" "PR #$pr" || return 2
    autopilot_place_strip_copy "PR #$pr" || return 2
    pp="$AUTOPILOT_PLACE"; AUTOPILOT_PR_EVENTS="$AUTOPILOT_PLACE_EVENTS"; AUTOPILOT_PR_COPY="$AUTOPILOT_PLACE_COPY"; AUTOPILOT_PR_COPY_READ=1
    if [ -n "$AUTOPILOT_PR_COPY" ]; then'
mutate po-dispatch-site _lib.sh '                    0) AUTOPILOT_PR="$num"; return 0 ;;' '                    0) return 1 ;;'
mutate po-merge-note-issue _lib.sh '        if [ "$kind" = pr ]; then n="$pr"; where="本 PR 上"' '        if false; then n="$pr"; where="本 PR 上"'
mutate po-no-label-body-notice _lib.sh '        actor-*|binding|closed|label-body) ;;' '        actor-*|binding|closed) ;;'
mutate po-section-inactive _lib.sh ' || [[ "${DISPATCH_AUTOPILOT_PR:-}" =~ ^[0-9]+$ ]]; }' '; }'
mutate po-worker-issue-file _lib.sh '    elif [ -n "$pr_only" ]; then f="$SKILL_DIR/prompts/autopilot-worker-pr.md"' '    elif false; then f="$SKILL_DIR/prompts/autopilot-worker-pr.md"'
mutate po-dispatch-no-pr agent-poll.sh ' DISPATCH_AUTOPILOT_PR="$AP_PR"' ''
# ── PR 上补托管标签（GitHub#190）：补、收回两条路径各自的写前重判与每个身份字段，副本不授权，合并前要求标签 ──
MIR_CMP='    if [ "$AM_V" != "$v" ] || [ "$AM_ID" != "$id" ]; then'
mutate mirror-add-no-second _lib.sh "$MIR_CMP" '    if [ "$v" = remove ] && { [ "$AM_V" != "$v" ] || [ "$AM_ID" != "$id" ]; }; then'
mutate mirror-rm-no-second _lib.sh "$MIR_CMP" '    if [ "$v" = add ] && { [ "$AM_V" != "$v" ] || [ "$AM_ID" != "$id" ]; }; then'
MIR_ID='    AM_ID="$state|'
mutate mirror-add-head _lib.sh "$MIR_ID" '    [ "$AM_V" != add ] || head=x; AM_ID="$state|'
mutate mirror-add-base _lib.sh "$MIR_ID" '    [ "$AM_V" != add ] || base=x; AM_ID="$state|'
mutate mirror-add-auth _lib.sh "$MIR_ID" '    [ "$AM_V" != add ] || AUTOPILOT_AUTH_IDX=x; AM_ID="$state|'
mutate mirror-rm-head _lib.sh "$MIR_ID" '    [ "$AM_V" != remove ] || head=x; AM_ID="$state|'
mutate mirror-rm-base _lib.sh "$MIR_ID" '    [ "$AM_V" != remove ] || base=x; AM_ID="$state|'
mutate mirror-rm-ph _lib.sh "$MIR_ID" '    [ "$AM_V" != remove ] || ph=x; AM_ID="$state|'
mutate mirror-rm-ih _lib.sh "$MIR_ID" '    [ "$AM_V" != remove ] || ih=x; AM_ID="$state|'
mutate mirror-rm-istate _lib.sh "$MIR_ID" '    [ "$AM_V" != remove ] || istate=x; AM_ID="$state|'
mutate mirror-rm-copy _lib.sh "$MIR_ID" '    [ "$AM_V" != remove ] || copy=x; AM_ID="$state|'
mutate mirror-rm-one-evidence _lib.sh '        if [ -n "$AUTOPILOT_PR_COPY_READ" ] && [ "$AUTOPILOT_PR_COPY" != "$copy" ]; then' '        if false; then'
mutate mirror-rm-maint _lib.sh '        if [ -z "$AUTOPILOT_PLACE_COPY" ]; then AM_V=none; return 0; fi' '        :'
mutate mirror-rm-unknown _lib.sh '            1) ;;
            *) AM_REASON="$AUTOPILOT_REASON"; return 0 ;;
        esac
        # 授权判定自己又读了' '            *) ;;
        esac
        # 授权判定自己又读了'
mutate mirror-cache-unknown _lib.sh '        *) log "托管：PR #$pr 要不要补 / 收回托管标签判不了' '        *) autopilot_state_set "$sf" '"'"'.mirror[$p] = $k'"'"' --arg p "$pr" --arg k "$key"; log "托管：PR #$pr 要不要补 / 收回托管标签判不了'
mutate mirror-add-plain-gh _lib.sh '            gh_write api -X POST "repos/$REPO/issues/$pr/labels" -f "labels[]=$LABEL_AUTOPILOT"' '            gh api -X POST "repos/$REPO/issues/$pr/labels" -f "labels[]=$LABEL_AUTOPILOT"'
mutate mirror-rm-plain-gh _lib.sh '    if out=$(gh_write api -X DELETE "repos/$REPO/issues/$pr/labels/$enc" 2>&1); then' '    if out=$(gh api -X DELETE "repos/$REPO/issues/$pr/labels/$enc" 2>&1); then'
mutate copy-auth-no-strip _lib.sh '    autopilot_place_strip_copy "PR #$pr" || return 2
    pp="$AUTOPILOT_PLACE"; AUTOPILOT_PR_EVENTS="$AUTOPILOT_PLACE_EVENTS"; AUTOPILOT_PR_COPY="$AUTOPILOT_PLACE_COPY"; AUTOPILOT_PR_COPY_READ=1
    # 两处' '    pp="$AUTOPILOT_PLACE"; AUTOPILOT_PR_EVENTS="$AUTOPILOT_PLACE_EVENTS"; AUTOPILOT_PR_COPY=""; AUTOPILOT_PR_COPY_READ=1
    # 两处'
mutate copy-pr-only-no-strip _lib.sh '    if [ -n "$AUTOPILOT_PR_COPY" ]; then
        AUTOPILOT_DENY=no-label' '    if false; then
        AUTOPILOT_DENY=no-label'
mutate copy-takeover-guard _lib.sh '    if [ "$AT_MODE" = none ] && [ -n "$AUTOPILOT_PR_COPY" ]; then AT_V=skip; return 0; fi' ''
mutate merge-needs-pr-label _lib.sh '    if [ "$AP_KIND" = issue ] && ! autopilot_has_label "$pj"; then' '    if false; then'
mutate mirror-tick-off agent-poll.sh 'autopilot_mirror_tick "$STATE_FILE" || true' ':'
# 旧实现对照（复审第 2 轮要求）：上一版 a420448 的 _lib.sh 整份换进来，必须有检查变红
mutate_old() {   # <名字> <提交>
    local name="$1" rev="$2" M="$SANDBOX/mut-$1"
    part_take || return 0
    mutation_gate || return 0
    mut_in_shard "$name" || return 0
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
# 同秒授权被遮住的那一版
mutate_old prev-bee1a66 bee1a66b99fee7c3a47079612b0e8fc9a189a455
pass=$REAL_PASS; fail=$REAL_FAIL

echo
mutation_summary "$0"
compat_summary
echo "正式版：$pass 通过 / $fail 失败；负对照失效 $mut_fail 条（本次跑了 $mut_ran 条）"
# 正式版计数在负对照开始前已存下、负对照不改它：各模式下都只含回归（tests/lib/report.sh）
REPORT_REGRESS_ONLY=1 report_counts "$pass" "$fail" "$mut_ran" "$mut_fail"
[ "$fail" -eq 0 ] && [ "$mut_fail" -eq 0 ]
