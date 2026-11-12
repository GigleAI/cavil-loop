#!/usr/bin/env bash
# kind: e2e
# 托管的 issue 拆成子 issue 后照样托管到底；合并后 issue 留给人关；互通名单里的仓库 —— GitHub#233。
#
# 跑法：bash tests/autopilot-split.test.sh             （默认不跑末尾的负对照）
#       MUTATION=1 bash tests/autopilot-split.test.sh  （连负对照一起跑：每份改坏的脚本副本把整套场景重跑一遍）
# 依赖：bash、jq、python3、git。不碰网络：有状态的假 GitHub（tests/lib/fake_github.py：标签、标签记录、评论、
# 合并接口、父子关系、第二个仓库）+ 假 tmux，HOME 指向临时目录。每一轮都**真的**起 agent-poll.sh 子进程。
#
# 这块错了的方向都不报错，只会悄悄做错事：
#   · 子项只看自己的标签 → 标签只打在父 issue 上的子项，派工不带托管规则、PR 永远补不上标签、不合并
#   · 父 issue 当成随便哪个 issue 的授权 → 任何人建个 issue 挂到托管 issue 下面就借走授权
#   · 停止线不算父 issue → 维护者摘了父 issue 的标签，子项照样合并
#   · 跨仓库不查名单 / 不查权限 → 别的仓库里打的标签让本仓库自动合并
#   · 读不到当成「不是子项」→ 托管的子项被按普通流程派出去
#   · 合并后的交接不看新流程 → 人已经打回返工，又被翻回 pending/human
#   · 跨仓库前置的裸 #N 当成别的仓库 → 本仓库同号条目一关就误开工
set -uo pipefail
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
# shellcheck source=lib/mutation.sh
source "$TEST_DIR/lib/mutation.sh"

SANDBOX=$(mktemp -d)
trap '[ -n "${KEEP_SANDBOX:-}" ] && echo "SANDBOX=$SANDBOX" || rm -rf "$SANDBOX"' EXIT
mkdir -p "$SANDBOX/bin" "$SANDBOX/home"
export HOME="$SANDBOX/home"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
unset CODING_AGENT_RELEASE_ROOT LABEL_AUTOPILOT DISPATCH_AUTOPILOT DISPATCH_AUTOPILOT_ISSUE DISPATCH_AUTOPILOT_PR \
      DISPATCH_AUTOPILOT_WHERE DISPATCH_PROMPT_KIND TRUSTED_REPOS
unset GH_TOKEN WRITE_GH_TOKEN GITHUB_TOKEN
export FAKE_GH_LISTS=1 FAKE_GH_REPO="example/ap"

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
        # KEEP_SANDBOX=1 时把失败那一刻的轮询日志和调用记录留下来，方便看
        if [ -n "${KEEP_SANDBOX:-}" ] && [ -n "${W:-}" ]; then
            cp "$W/state/poll.log" "$SANDBOX/fail-$fail.poll.log" 2>/dev/null; cp "$W/gh/calls.log" "$SANDBOX/fail-$fail.calls.log" 2>/dev/null
        fi
    fi
}
section() { [ "$QUIET" = 1 ] || echo "$1"; }

H1=1111111111111111111111111111111111111111
SUMMARY='<!-- autopilot-summary:begin -->
<details><summary>背景</summary>

周报只算一个仓库。

</details>
<details><summary>采用的方案</summary>

每个仓库各算各的再合并。

</details>
<details><summary>排除的方案和原因</summary>

改归属函数：改动面太大。

</details>
<!-- autopilot-summary:end -->'

run_scenarios() {
    local SCRIPTS="$1" W="$SANDBOX/run"
    local R="repos/example/ap"
    local CONF STATE CALLS GD OD

    fresh() {   # [额外配置行…]
        rm -rf "$W"; mkdir -p "$W/state" "$W/wt" "$W/gh"
        git init -q "$W/project" 2>/dev/null
        GD="$W/gh"; export FAKE_GH_DIR="$GD"; CALLS="$GD/calls.log"; STATE="$W/state/state.json"
        OD="$GD/repos/other__tutor"
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
PENDING_HUMAN_CONFLICT_CHECK=false
POLL_BACKOFF_LADDER=""
PRICE_AUTO_FETCH=0
MAX_CONCURRENT_WORKERS=0
AUTOPILOT_UNKNOWN_MAX=3
BLOCKED_RECHECK_SECS=0
PATH="$SANDBOX/bin:\$PATH"
GH_TOKEN="fake-token-for-test"
CONF
        local l; for l in "$@"; do printf '%s\n' "$l" >> "$CONF"; done
        EVN=0
        local d
        for d in "$GD" "$OD"; do
            mkdir -p "$d"
            echo '{}' > "$d/items.json"; echo '{}' > "$d/labels.json"; echo '{}' > "$d/events.json"
            echo '{}' > "$d/comments.json"; echo '{"maint":"admin","helper":"read"}' > "$d/perms.json"
            echo '{}' > "$d/checks.json"; echo '{}' > "$d/files.json"; echo loop-bot > "$d/me"
        done
    }
    jset() {   # <文件> <jq 表达式> [jq 参数…]（文件名带目录前缀 other/ = 另一个仓库）
        local f e="$2"
        case "$1" in other/*) f="$OD/${1#other/}" ;; *) f="$GD/$1" ;; esac
        shift 2
        jq "$@" "$e" "$f" > "$f.tmp" && mv "$f.tmp" "$f"
    }
    mkissue() {   # <n> <labels_csv> [作者] [正文] [父 issue 地址] [仓库前缀 other/]
        jset "${6:-}items.json" '.[$n] = ({kind:"issue", state:"open", title:"t", body:$b, user:{login:$a}, updated_at:"2026-01-01T00:00:00Z"}
                + (if $p == "" then {} else {parent_issue_url:$p} end))' \
            --arg n "$1" --arg a "${3:-maint}" --arg b "${4:-需求}" --arg p "${5:-}"
        jset "${6:-}labels.json" '.[$n] = ($l | split(",") | map(select(. != "")))' --arg n "$1" --arg l "$2"
    }
    mkpr() {   # <n> <分支> <正文> <提交> <labels_csv>
        jset items.json '.[$n] = {kind:"pr", state:"open", merged:false, draft:false, title:"拆分子项的改动", body:$b,
                user:{login:"loop-bot"}, updated_at:"2026-01-01T00:00:00Z", created_at:"2025-12-01T00:00:00Z",
                head:{sha:$h, ref:$r, repo:{full_name:"example/ap"}}, base:{ref:"main"},
                mergeable:true, mergeable_state:"clean"}' \
            --arg n "$1" --arg r "$2" --arg b "$3" --arg h "$4"
        jset labels.json '.[$n] = ($l | split(",") | map(select(. != "")))' --arg n "$1" --arg l "$5"
        # 真 GitHub 上挂着的标签都有打上它的那条记录；交人的写前核对（GitHub#382）要从记录里认「这一次入队」
        case ",$5," in *",pending/merge,"*)
            jset events.json '.[$n] = ((.[$n] // []) + [{event:"labeled", label:{name:"pending/merge"}, actor:{login:"loop-bot", type:"User"}, created_at:"2025-12-31T00:00:00Z"}])' --arg n "$1" ;;
        esac
    }
    ev() {   # <n> <labeled|unlabeled> <标签> <操作人> [仓库前缀 other/]
        EVN=$((EVN + 1))
        jset "${5:-}events.json" '.[$n] = ((.[$n] // []) + [{event:$e, label:{name:$l}, actor:{login:$a, type:"User"}, created_at:$c}])' \
            --arg n "$1" --arg e "$2" --arg l "$3" --arg a "$4" \
            --arg c "${EV_AT:-$(printf '2026-01-01T%02d:%02d:00Z' $((EVN / 60)) $((EVN % 60)))}"
    }
    review_rec() {   # <pr> <提交>
        [ -f "$STATE" ] || echo '{"cleaned_prs":[]}' > "$STATE"
        jq --arg p "$1" --arg h "$2" '.autopilot.prs[$p] = {reviewed_head:$h, reviewed_at:"2026-01-01T00:00:00Z", reviewed_base:"main"}' \
            "$STATE" > "$STATE.tmp" && mv "$STATE.tmp" "$STATE"
    }
    evidence() {   # <pr> <提交>
        jset comments.json '.[$p] = ((.[$p] // []) + [{id: 900, user:{login:"loop-bot"}, created_at:"2026-06-01T00:00:00Z",
                body:("## ✅ 复审通过\n\n<!-- autopilot-review-pass head=" + $h + " passed=5 failed=0 -->")}])' --arg p "$1" --arg h "$2"
    }
    tick() { : > "$CALLS"; env CODING_AGENT_CONFIG="$CONF" bash "$SCRIPTS/agent-poll.sh" >/dev/null 2>&1; }
    n_calls() { grep -cE -- "$1" "$CALLS" 2>/dev/null || true; }
    merged() { n_calls "^gh api -X PUT $R/pulls/$1/merge "; }
    labels_of() { jq -r --arg n "$1" '(.[$n] // []) | sort | join(",")' "$GD/labels.json"; }
    has_label() { case ",$(labels_of "$1")," in *",$2,"*) echo yes ;; *) echo no ;; esac; }
    comments_with() { jq -r --arg n "$1" '(.[$n] // [])[].body' "$GD/comments.json" | grep -cF -- "$2" || true; }
    label_writes() { n_calls "^gh api -X (POST|DELETE) $R/issues/$1/labels"; }
    writes() { n_calls "^gh api -X (POST|PUT|DELETE|PATCH) "; }
    log_has() { grep -cF -- "$1" "$W/state/poll.log" 2>/dev/null || true; }
    issue_state() { jq -r --arg n "$1" '.[$n].state // ""' "$GD/items.json"; }

    # 父 issue 50（维护者打的托管）+ 本工具拆出的子项 51（loop 账号建、带拆分标记、挂在 50 下）+ 子项的 PR 52：
    # 复审已通过、PR 上和子项上都**没有**托管标签
    split_ready() {   # [子项作者] [子项正文] [父 issue 地址]
        mkissue 50 "autopilot,pending/PR"; ev 50 labeled autopilot maint
        mkissue 51 "pending/PR" "${1:-loop-bot}" "${2:-周报改两仓库

<!-- agent-split-from: #50 -->}" "${3-https://api.github.com/repos/example/ap/issues/50}"
        mkpr 52 feature/issue-51 "做了 X。

Refs #51
Part of #50

$SUMMARY" "$H1" "pending/merge"
        review_rec 52 "$H1"; evidence 52 "$H1"
    }
    # 同一个子项，父 issue 在另一个仓库 other/tutor#1458
    cross_ready() {
        mkissue 1458 "autopilot,pending/PR" maint "需求" "" other/
        ev 1458 labeled autopilot maint other/
        split_ready loop-bot "周报改两仓库

<!-- agent-split-from: #1458 -->" "https://api.github.com/repos/other/tutor/issues/1458"
        jset items.json 'del(.["50"])'; jset labels.json 'del(.["50"])'
    }

    # ── 【1】同仓库：标签只在父 issue 上 ──
    section "【1】同仓库拆分子项：标签只打在父 issue 上，子项和 PR 都没有 → 补标签、合并"
    fresh; split_ready
    tick
    chk "PR 52 补上托管标签（daemon 的副本）" "$(has_label 52 autopilot)" yes
    chk "同一轮合并 PR 52" "$(merged 52)" 1
    chk "合并说明写授权在父 issue #50" "$(comments_with 51 '父 issue #50 上打的托管标签')" 1
    chk "合并说明原样带上 PR 正文的总结段" "$(comments_with 51 '改归属函数：改动面太大。')/$(comments_with 51 '<summary>排除的方案和原因</summary>')" "1/1"
    chk "合并说明写明要人做什么" "$(comments_with 51 '要人做的：看过之后满意就关闭本 issue')" 1
    chk "子项 51 没被打上托管标签（只在父 issue 上）" "$(has_label 51 autopilot)" no
    tick
    chk "下一轮清理：子项 51 仍打开" "$(issue_state 51)" open
    chk "  → 子项翻 pending/human、摘 pending/PR" "$(has_label 51 pending/human)/$(has_label 51 pending/PR)" "yes/no"
    chk "  → PR 52 打 Done" "$(has_label 52 Done)" yes
    chk "  → 交接记录已清" "$(jq -r '.autopilot.handoff["52"] // "none"' "$STATE")" none
    chk "  → 合并说明只有一条" "$(comments_with 51 'autopilot-merged pr=52 ')" 1

    section "【1L】总结段很长（合并说明约 135 KB，超过单个命令行参数 128 KB 的上限）：照样发出全文；发不出时交接记录存下全文、下一轮补发（GitHub#426）"
    # 正文太大，测试自己也不能经 jq --arg 写：用 python 直接改假 GitHub 的文件
    big_summary() {
        python3 - "$GD/items.json" <<'PY2'
import json, sys
f = sys.argv[1]; d = json.load(open(f))
big = ("<!-- autopilot-summary:begin -->\n<details><summary>背景</summary>\n\nSUMMARYMARK "
       + "很长的总结内容。" * 5700 + "\n\n</details>\n<!-- autopilot-summary:end -->")
d["52"]["body"] = "做了 X。\n\nRefs #51\nPart of #50\n\n" + big
json.dump(d, open(f, "w"), ensure_ascii=False)
PY2
    }
    merged_note() {   # <issue>：daemon 发的合并说明里，带 SUMMARYMARK 的那几条的 UTF-8 字节数（一行一条）
        jq -r --arg n "$1" '(.[$n] // [])[] | select(.body | contains("autopilot-merged pr=52 ")) | select(.body | contains("SUMMARYMARK")) | (.body | utf8bytelength)' "$GD/comments.json"
    }
    fresh; split_ready; big_summary
    tick
    chk "照常合并" "$(merged 52)" 1
    chk "  → 合并说明发出一条，带上全部总结段（超过 130000 字节）" "$(merged_note 51 | awk '$1>130000' | wc -l | tr -d ' ')" 1
    fresh; split_ready; big_summary
    : > "$GD/F_post_comment"
    tick
    chk "评论发不出：照常合并、说明没发出去" "$(merged 52)/$(merged_note 51 | wc -l | tr -d ' ')" "1/0"
    chk "  → 交接记录存下了说明全文" "$(jq -r '.autopilot.handoff["52"].body // "" | select(contains("SUMMARYMARK")) | utf8bytelength > 130000' "$STATE")" true
    rm -f "$GD/F_post_comment"
    tick
    chk "  → 下一轮补发全文，只有一条" "$(merged_note 51 | awk '$1>130000' | wc -l | tr -d ' ')" 1
    chk "  → 交接完成：子项翻 pending/human，记录已清" "$(has_label 51 pending/human)/$(jq -r '.autopilot.handoff["52"] // "none"' "$STATE")" "yes/none"

    section "【1b】同一轮里的无关 PR（issue 不是拆分子项、也没有托管标签）不被补标签、不被合并"
    fresh; split_ready
    mkissue 60 "pending/PR"; mkpr 61 feature/issue-60 "Refs #60" "$H1" "pending/review"
    tick
    chk "无关 PR 61 没补托管标签" "$(has_label 61 autopilot)" no
    chk "无关 PR 61 没被合并" "$(merged 61)" 0
    chk "到达性 · 同一轮子项 PR 52 确实合并了" "$(merged 52)" 1

    section "【1c】正文还写着关闭关键词（Closes #51）→ 不合并，交回 worker 改成 Refs"
    fresh; split_ready
    jset items.json '.["52"].body = "做了 X。\n\nCloses #51"'
    tick
    chk "Closes #51 → 不合并" "$(merged 52)" 0
    chk "  → 交回 worker（pending/agent），说明写改成 Refs #51" "$(has_label 52 pending/agent)/$(comments_with 52 '改成 `Refs #51`')" "yes/1"

    section "【2】不是拆分子项：借不走父 issue 的授权"
    local case_ who body purl what
    for case_ in "maint|<!-- agent-split-from: #50 -->|https://api.github.com/repos/example/ap/issues/50|子项不是 loop 账号建的" \
                 "loop-bot|没有标记|https://api.github.com/repos/example/ap/issues/50|子项正文没有拆分标记" \
                 "loop-bot|<!-- agent-split-from: #49 -->|https://api.github.com/repos/example/ap/issues/50|标记指向别的父 issue" \
                 "loop-bot|<!-- agent-split-from: #500 -->|https://api.github.com/repos/example/ap/issues/50|标记是父号的前缀扩展（#500 ≠ #50）" \
                 "loop-bot|<!-- agent-split-from: #50 -->||GitHub 上没有父子关系（只有标记）"; do
        IFS='|' read -r who body purl what <<< "$case_"
        fresh; split_ready "$who" "$body" "$purl"
        tick
        chk "$what → 不补标签" "$(has_label 52 autopilot)" no
        chk "$what → 不合并" "$(merged 52)" 0
    done

    section "【3】叫停：父 issue 摘标签 / 打 pending/human / 关闭 → 子项都停；维护者重打才恢复"
    fresh; split_ready
    jset labels.json '.["50"] = ["pending/PR"]'; ev 50 unlabeled autopilot maint
    tick
    chk "父 issue 摘了托管标签 → 不合并" "$(merged 52)" 0
    fresh; split_ready; jset labels.json '.["52"] = ["pending/merge","autopilot"]'; ev 52 labeled autopilot loop-bot
    jset labels.json '.["50"] += ["pending/human"]'; ev 50 labeled pending/human maint
    tick
    chk "父 issue 打 pending/human → 不合并" "$(merged 52)" 0
    chk "  → PR 交人" "$(has_label 52 pending/human)" yes
    fresh; split_ready; jset labels.json '.["52"] = ["pending/merge","autopilot"]'; ev 52 labeled autopilot loop-bot
    jset items.json '.["50"].state = "closed"'
    tick
    chk "父 issue 关闭 → 不合并" "$(merged 52)" 0
    fresh; split_ready
    jset labels.json '.["50"] = ["pending/PR"]'; ev 50 unlabeled autopilot maint
    jset labels.json '.["50"] += ["autopilot"]'; ev 50 labeled autopilot loop-bot
    tick
    chk "摘掉后 loop 账号再打上 → 不算恢复、不合并" "$(merged 52)" 0
    fresh; split_ready
    jset labels.json '.["50"] = ["pending/PR"]'; ev 50 unlabeled autopilot maint
    jset labels.json '.["50"] += ["autopilot"]'; ev 50 labeled autopilot maint
    tick
    chk "摘掉后维护者亲手重打 → 恢复、合并" "$(merged 52)" 1
    fresh; split_ready
    jset labels.json '.["51"] += ["pending/human"]'
    tick
    chk "只在子项上打 pending/human → 只停它自己（不合并）" "$(merged 52)" 0

    section "【4】判不了：父 issue 读不到 → 零写入；恢复后照常合并"
    fresh; split_ready
    touch "$GD/F_issues_50"
    tick
    chk "父 issue 读不到 → 不补标签、不合并" "$(has_label 52 autopilot)/$(merged 52)" "no/0"
    chk "  → PR 52 上零写入" "$(label_writes 52)" 0
    rm -f "$GD/F_issues_50"
    tick
    chk "恢复后 → 合并" "$(merged 52)" 1
    fresh; split_ready
    touch "$GD/F_issues_50_events"
    tick
    chk "父 issue 的标签记录读不到 → 不合并、零写入" "$(merged 52)/$(label_writes 52)" "0/0"

    section "【5】派工：子项 51 挂 pending/agent → 带托管规则派工；父 issue 读不到 → 本轮不派"
    fresh 'MAX_CONCURRENT_WORKERS=5'; split_ready
    jset labels.json '.["51"] = ["pending/agent"]'; jset items.json 'del(.["52"])'; jset labels.json 'del(.["52"])'
    tick
    chk "派工时认出是托管条目、授权在父 issue #50" "$(log_has '托管：issue #51 是托管条目（授权在 父 issue #50')" 1
    fresh 'MAX_CONCURRENT_WORKERS=5'; split_ready
    jset labels.json '.["51"] = ["pending/agent"]'; jset items.json 'del(.["52"])'; jset labels.json 'del(.["52"])'
    touch "$GD/F_issues_50"
    tick
    chk "父 issue 读不到 → 本轮不派（日志写明）" "$(log_has '本轮不派，下轮再判')" 1
    chk "  → 子项仍挂 pending/agent、没翻 doing/agent" "$(has_label 51 pending/agent)/$(has_label 51 doing/agent)" "yes/no"
    fresh 'MAX_CONCURRENT_WORKERS=5'
    mkissue 70 "pending/agent"
    tick
    chk "对照：普通 issue 照常派（不当托管条目）" "$(log_has 'dispatch new issue #70')/$(log_has '托管：issue #70 是托管条目')" "1/0"

    # ── 【6】跨仓库 ──
    section "【6】跨仓库父 issue：互通名单 + 两边写权限才继承"
    fresh; cross_ready
    tick
    chk "没配互通名单 → 不补标签、不合并" "$(has_label 52 autopilot)/$(merged 52)" "no/0"
    fresh; cross_ready
    jset labels.json '.["52"] += ["autopilot"]'; ev 52 labeled autopilot loop-bot
    tick
    chk "没配互通名单、PR 上已有 daemon 的副本标签 → 授权不成立：不合并、PR 交人" "$(merged 52)/$(has_label 52 pending/human)" "0/yes"
    fresh 'TRUSTED_REPOS="other/tutor"'; cross_ready
    tick
    chk "名单里有 other/tutor、维护者两边都是 admin → 合并" "$(merged 52)" 1
    chk "  → 说明写授权在父 issue other/tutor#1458" "$(comments_with 51 '父 issue other/tutor#1458 上打的托管标签')" 1
    chk "  → 查过维护者在 other/tutor 的权限" "$([ "$(n_calls '^gh api repos/other/tutor/collaborators/maint/permission')" -gt 0 ] && echo yes || echo no)" yes
    fresh 'TRUSTED_REPOS="other/tutor"'; cross_ready
    jset other/perms.json '.maint = "read"'
    tick
    chk "维护者在 other/tutor 只有 read → 不合并" "$(merged 52)" 0
    fresh 'TRUSTED_REPOS="Other/Tutor, x/y"'; cross_ready
    tick
    chk "名单不分大小写、逗号加空格分隔 → 合并" "$(merged 52)" 1
    fresh 'TRUSTED_REPOS="other/tutor"'; cross_ready
    touch "$OD/F_issues_1458_events"
    tick
    chk "父 issue 的标签记录读不到 → 不合并、PR 上零写入" "$(merged 52)/$(label_writes 52)" "0/0"
    rm -f "$OD/F_issues_1458_events"
    tick
    chk "恢复后 → 合并" "$(merged 52)" 1
    fresh 'TRUSTED_REPOS="other/tutor"'; cross_ready
    jset other/labels.json '.["1458"] = ["pending/PR"]'; ev 1458 unlabeled autopilot maint other/
    tick
    chk "别的仓库的父 issue 摘了托管标签 → 不合并" "$(merged 52)" 0

    # ── 【7】合并后的交接 ──
    # 合并和合并后的清理在同一轮里先后跑；要在两者之间插一步人的操作，第一轮先关掉清理
    merge_only_tick() { printf 'AUTO_CLEANUP_ON_MERGE=false\n' >> "$CONF"; tick; sed -i '/^AUTO_CLEANUP_ON_MERGE=false$/d' "$CONF"; }
    section "【7】合并后交接：人已经打回返工 → 标签一个不动；读不到 → 下轮再试；说明只发一条"
    fresh; split_ready
    merge_only_tick
    chk "到达性 · 合并了" "$(merged 52)" 1
    jset labels.json '.["51"] += ["pending/agent"]'
    tick
    chk "已打 pending/agent → 不加 pending/human" "$(has_label 51 pending/human)" no
    chk "  → pending/agent、pending/PR 都还在" "$(has_label 51 pending/agent)/$(has_label 51 pending/PR)" "yes/yes"
    chk "  → 交接作废" "$(jq -r '.autopilot.handoff["52"] // "none"' "$STATE")" none
    fresh; split_ready
    merge_only_tick
    # 交接先读一遍 issue 判定，翻标签前再读一遍：第二遍之前维护者打了 pending/agent（hook 在第 2 次读 issue 51 前改状态）
    printf 'cd %q && jq %q labels.json > l.tmp && mv l.tmp labels.json\n' "$GD" '.["51"] += ["pending/agent"]' > "$GD/hook_issues_51_2"
    rm -f "$GD/count_issues_51"   # 读的次数从这一轮重新数
    tick
    chk "判定之后、翻标签之前打了 pending/agent → 不加 pending/human" "$(has_label 51 pending/human)/$(has_label 51 pending/agent)" "no/yes"
    chk "  → 到达性：翻标签前确实又读了一遍 issue" "$([ "$(n_calls "^gh api $R/issues/51\$")" -ge 2 ] && echo yes || echo no)" yes
    tick
    chk "  → 下一轮看到新流程，交接作废、标签仍不动" "$(has_label 51 pending/human)/$(jq -r '.autopilot.handoff["52"] // "none"' "$STATE")" "no/none"
    fresh; split_ready
    merge_only_tick
    touch "$GD/F_issues_51"
    tick
    chk "交接时读不到 issue → 子项上零标签写入" "$(label_writes 51)" 0
    chk "  → 交接记录还在" "$(jq -r '.autopilot.handoff["52"].issue // "none"' "$STATE")" 51
    rm -f "$GD/F_issues_51"
    tick
    chk "恢复后 → 翻 pending/human" "$(has_label 51 pending/human)" yes
    fresh; split_ready
    touch "$GD/F_post_comment"
    merge_only_tick
    chk "合并时说明没发出去 → 已合并" "$(merged 52)/$(comments_with 51 'autopilot-merged pr=52 ')" "1/0"
    rm -f "$GD/F_post_comment"
    tick
    chk "下一轮补发说明，只有一条" "$(comments_with 51 'autopilot-merged pr=52 ')" 1
    chk "  → 补发的是完整说明（带总结段）" "$(comments_with 51 '每个仓库各算各的再合并。')" 1
    tick
    chk "再下一轮不重复发" "$(comments_with 51 'autopilot-merged pr=52 ')" 1
    # 复审第 1 轮的两个场景
    fresh; split_ready
    touch "$GD/F_post_comment"; merge_only_tick; rm -f "$GD/F_post_comment"
    jset items.json '.["51"].state = "closed" | .["51"].state_reason = "completed"'
    # 交接读评论（准备补发说明）时，维护者重开 issue、新一轮 worker 已经在跑
    printf 'cd %q && jq %q items.json > i.tmp && mv i.tmp items.json && jq %q labels.json > l.tmp && mv l.tmp labels.json\n' \
        "$GD" '.["51"].state = "open" | del(.["51"].state_reason)' '.["51"] = ["doing/agent"]' > "$GD/hook_issues_51_comments_1"
    rm -f "$GD/count_issues_51_comments"
    tick
    chk "交接中途 issue 被重开、新一轮在跑 → 标签一个不动（只有 doing/agent）" "$(labels_of 51)" "doing/agent"
    chk "  → 到达性：hook 确实跑了、说明补发了" "$(issue_state 51)/$(comments_with 51 'autopilot-merged pr=52 ')" "open/1"
    fresh; split_ready
    merge_only_tick
    touch "$GD/F_delete_labels"
    tick
    chk "摘 pending/PR 失败 → 交接记录留着" "$(jq -r '.autopilot.handoff["52"].issue // "none"' "$STATE")" 51
    chk "  → 这一轮 pending/human 已加上、pending/PR 还在" "$(has_label 51 pending/human)/$(has_label 51 pending/PR)" "yes/yes"
    # 交接一次只摘一次，失败就停手；同一轮里合并后标签的重试队列会再调一次，所以最多 2 次
    chk "  → 摘失败就停手，不在一轮里反复打 GitHub（最多 2 次）" "$([ "$(n_calls "^gh api -X DELETE $R/issues/51/labels/")" -le 2 ] && echo yes || echo no)" yes
    rm -f "$GD/F_delete_labels"
    tick
    chk "恢复后 → 摘掉 pending/PR，只剩 pending/human" "$(has_label 51 pending/human)/$(has_label 51 pending/PR)" "yes/no"
    chk "  → 交接记录已清" "$(jq -r '.autopilot.handoff["52"] // "none"' "$STATE")" none
    # 复审第 2 轮：第一个写请求（加 Done）已经完成、第二个（摘 pending/PR）发出之前，维护者重开 issue、新一轮在跑
    fresh; split_ready
    merge_only_tick
    jset items.json '.["51"].state = "closed" | .["51"].state_reason = "completed"'
    printf 'cd %q && jq %q items.json > i.tmp && mv i.tmp items.json && jq %q labels.json > l.tmp && mv l.tmp labels.json\n' \
        "$GD" '.["51"].state = "open" | del(.["51"].state_reason)' '.["51"] = ["doing/agent"]' > "$GD/hook_DELETE_issues_51_labels_1"
    tick
    chk "加 Done 之后、摘标签之前被重开 → 不再摘任何标签（只剩 doing/agent）" "$(labels_of 51)" "doing/agent"
    chk "  → 到达性：Done 确实先加过、摘标签的 hook 确实跑了" "$(n_calls "^gh api -X POST $R/issues/51/labels -f labels\[\]=Done")/$(issue_state 51)" "1/open"
    chk "  → 交接作废、下一轮也不再动" "$(jq -r '.autopilot.handoff["52"] // "none"' "$STATE")" none
    fresh; split_ready
    merge_only_tick
    printf 'cd %q && jq %q labels.json > l.tmp && mv l.tmp labels.json\n' "$GD" '.["51"] += ["pending/agent"]' > "$GD/hook_after_POST_issues_51_labels_1"
    tick
    chk "打开的 issue：加 pending/human 之后、摘 pending/PR 之前人打了 pending/agent → 后面不再写" "$(has_label 51 pending/agent)/$(has_label 51 pending/PR)" "yes/yes"
    chk "  → 到达性：pending/human 确实先加上了" "$(has_label 51 pending/human)" yes
    fresh; split_ready
    merge_only_tick
    jset items.json '.["51"].state = "closed" | .["51"].state_reason = "completed"'
    touch "$GD/F_delete_labels"
    tick
    chk "人先关了 issue、摘标签失败 → 交接记录留着" "$(jq -r '.autopilot.handoff["52"].issue // "none"' "$STATE")" 51
    rm -f "$GD/F_delete_labels"
    tick
    chk "  → 恢复后 Done、pending/PR 已摘" "$(has_label 51 Done)/$(has_label 51 pending/PR)" "yes/no"
    fresh; split_ready
    jset items.json '.["52"].body = "做了 X。\n\nRefs #51"'
    tick
    chk "PR 正文没有总结段 → 照样合并，说明写明缺总结段" "$(merged 52)/$(comments_with 51 '没有总结段')" "1/1"

    # ── 【8】父 issue 汇总 ──
    section "【8】父 issue 一侧发现子项全部完成（子项留给人关、子项在别的仓库都算）"
    fresh
    mkissue 80 "pending/PR"; jset subs.json '. = {"80": [81, "other/tutor#5"]}' 2>/dev/null || echo '{"80": [81, "other/tutor#5"]}' > "$GD/subs.json"
    mkissue 81 "" loop-bot; mkissue 5 "" loop-bot "x" "" other/
    tick
    chk "子项都还开着 → 父 issue 不动" "$(has_label 80 pending/human)" no
    jset items.json '.["81"].state = "closed"'; jset other/items.json '.["5"].state = "closed"'
    tick
    chk "全部关闭（含别的仓库的子项）→ 父 issue 翻 pending/human" "$(has_label 80 pending/human)/$(has_label 80 pending/PR)" "yes/no"
    chk "  → 发了一条汇总评论" "$(n_calls '^gh issue comment 80 ')" 1
    tick
    chk "下一轮不重复汇总" "$(n_calls '^gh issue comment 80 ')" 0

    # ── 【9】跨仓库前置 ──
    section "【9】等前置：名单里的仓库可以当前置；裸 #N 只指本仓库"
    blocked_ready() {   # <前置写法>
        mkissue 90 "pending/blocked"; ev 90 labeled pending/blocked loop-bot
        jset comments.json '.["90"] = [{id: 5001, user:{login:"loop-bot"}, author_association:"NONE", created_at:"2026-06-01T00:00:00Z",
                body:("## 等前置\n\n<!-- agent-blocked-by: " + $p + " resume=pending/agent -->")}]' --arg p "$1"
        mkissue 9 "" loop-bot "x" "" other/
        mkissue 9 ""
    }
    fresh 'LABEL_PENDING_BLOCKED="pending/blocked"' 'TRUSTED_REPOS="other/tutor"'; blocked_ready "other/tutor#9"
    jset items.json '.["9"].state = "closed" | .["9"].state_reason = "completed"'
    tick
    chk "本仓库同号 #9 关了、别的仓库的 #9 还开着 → 不开工" "$(has_label 90 pending/agent)/$(has_label 90 pending/blocked)" "no/yes"
    jset other/items.json '.["9"].state = "closed" | .["9"].state_reason = "completed"'
    tick
    chk "别的仓库的 #9 以已完成关闭 → 翻回 pending/agent" "$(has_label 90 pending/agent)/$(has_label 90 pending/blocked)" "yes/no"
    chk "  → 说明列出 other/tutor#9" "$(comments_with 90 '- other/tutor#9')" 1
    fresh 'LABEL_PENDING_BLOCKED="pending/blocked"' 'TRUSTED_REPOS="other/tutor"'; blocked_ready "#9"
    jset items.json '.["9"].state = "closed" | .["9"].state_reason = "completed"'
    tick
    chk "开着互通名单、标记写裸 #9 → 指本仓库：本仓库 #9 完成就开工" "$(has_label 90 pending/agent)" yes
    fresh 'LABEL_PENDING_BLOCKED="pending/blocked"'; blocked_ready "other/tutor#9"
    jset other/items.json '.["9"].state = "closed" | .["9"].state_reason = "completed"'
    tick
    # GitHub#243：没配名单时 other/tutor#9 不再丢掉仓库名按本仓库 #9 去判，而是名单外 → 交人
    chk "没配互通名单：other/tutor#9 不当成本仓库 #9，名单外 → 交人" "$(has_label 90 pending/human)/$(has_label 90 pending/blocked)" "yes/no"
    fresh 'LABEL_PENDING_BLOCKED="pending/blocked"' 'TRUSTED_REPOS="x/y"'; blocked_ready "other/tutor#9"
    tick
    chk "前置所在仓库不在名单里 → 交人" "$(has_label 90 pending/human)/$(has_label 90 pending/blocked)" "yes/no"
    fresh 'LABEL_PENDING_BLOCKED="pending/blocked"' 'TRUSTED_REPOS="other/tutor"'; blocked_ready "other/tutor#9"
    jset other/items.json '.["9"].state = "closed" | .["9"].state_reason = "completed"'
    touch "$OD/F_issues_9"
    tick
    chk "别的仓库的前置读不到 → 不动（零写入）" "$(has_label 90 pending/blocked)/$(label_writes 90)" "yes/0"
}

REAL_PASS=0; REAL_FAIL=0
section "══ 正式版 ══"
run_scenarios "$REPO_DIR/scripts"
REAL_PASS=$pass; REAL_FAIL=$fail

# ── 负对照：把被测脚本复制一份、改坏一处，同一套场景必须有断言变红 ──
mut_ran=0; mut_fail=0
mutate() {   # <名字> <python 替换：旧文本> <新文本>
    local name="$1" old="$2" new="$3" M="$SANDBOX/mut-$1"
    mutation_gate || return 0
    rm -rf "$M"; cp -r "$REPO_DIR/scripts" "$M"
    if ! OLD="$old" NEW="$new" python3 - "$M/_lib.sh" <<'PY'
import os, sys
p = sys.argv[1]; t = open(p).read(); o = os.environ["OLD"]
if o not in t:
    sys.exit(1)
open(p, "w").write(t.replace(o, os.environ["NEW"], 1))
PY
    then
        echo "  ❌ 负对照「$name」准备失败：原文不在了"; mut_fail=$((mut_fail+1)); return 0
    fi
    pass=0; fail=0; QUIET=1
    run_scenarios "$M"
    QUIET=0; mut_ran=$((mut_ran+1))
    if [ "$fail" -gt 0 ]; then echo "  ✅ 负对照「$name」变红（$fail 条）"
    else echo "  ❌ 负对照「$name」没变红：测试分不出这处改坏"; mut_fail=$((mut_fail+1)); fi
}
section "══ 负对照 ══"
mutate parent-ignored 'rc=0; split_parent_check "$num" "$ij" || rc=$?
    case "$rc" in
        0) autopilot_authorization_split' 'rc=1
    case "$rc" in
        0) autopilot_authorization_split'
mutate no-author-check '[ -z "$author" ] || [ "$(requester_bot_lc "$author")" != "$(requester_bot_lc "$me")" ]; then
        SPLIT_PARENT_WHY="#$num 不是 loop 写入账号建的"; return 1' 'false; then
        SPLIT_PARENT_WHY="#$num 不是 loop 写入账号建的"; return 1'
mutate no-trust-check 'if ! repo_trusted "$prepo"; then' 'if false; then'
mutate parent-stop-ignored 'if printf '"'"'%s'"'"' "$paj" | jq -e --arg H' 'if false && printf '"'"'%s'"'"' "$paj" | jq -e --arg H'
mutate other-repo-perm-skipped 'if [ -n "$also" ] && [ "$(requester_bot_lc "$also")" != "$(requester_bot_lc "$REPO")" ]; then' 'if false; then'
mutate unknown-as-not-split '        2) AUTOPILOT_REASON="$SPLIT_PARENT_WHY"; return 2 ;;
    esac
    return 1
}' '        2) return 1 ;;
    esac
    return 1
}'
mutate handoff-ignores-flow '            if [ -n "$rest" ]; then
                AH_V=superseded' '            if false; then
                AH_V=superseded'
mutate handoff-no-reread '        if [ "$AH_V" != "$v" ] || [ "$AH_ID|$AH_NEXT" != "$id" ]; then' '        if false; then'
mutate handoff-delete-unchecked '            printf '"'"'%s'"'"' "$out" | grep -q '"'"'HTTP 404'"'"' && continue' '            continue'
mutate bare-number-dropped '| {r: ((.[0] // "") | ascii_downcase' '| select(.[0] != null) | {r: ((.[0] // "") | ascii_downcase'
mutate foreign-not-read 'gh api "repos/${pr:-$REPO}/issues/$p"' 'gh api "repos/$REPO/issues/$p"'
mutate close-bounce-off 'if [ "$AP_KIND" = issue ] && printf '"'"'%s'"'"' "$AP_BODY" | autopilot_body_has_close; then' 'if false; then'
mutate refs-binding-off '       && [ "$(printf '"'"'%s\n'"'"' "$body" | autopilot_body_refs)" = "$n" ]; then' '       && false; then'
mutate discover-off '    [ -s "${TICK_DIR:-/nonexistent}/issues.json" ] || return 0' '    return 0'
pass=$REAL_PASS; fail=$REAL_FAIL

echo
mutation_summary "$0"
echo "正式版：$pass 通过 / $fail 失败；负对照失效 $mut_fail 条（本次跑了 $mut_ran 条）"
REPORT_REGRESS_ONLY=1 report_counts "$pass" "$fail" "$mut_ran" "$mut_fail"
[ "$fail" -eq 0 ] && [ "$mut_fail" -eq 0 ]
