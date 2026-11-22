# shellcheck shell=bash
# ── PR 正文登记的合并后待办（GitHub#656）：读法 ──
# 只有一个读法 merge_followup_parse，四种结果（见 scripts/merge_followup.py 文件头的规则）。
# 哪一行算标记、怎么截取清单，和托管总结段共用 _autopilot_summary.sh 里的同一段 awk（body_section / BODY_MARK_AWK）。
# 这里只数标记、截取；校验列表项、拼「格式不对」的原文交给 merge_followup.py（同一份正文、同一份标记位置）。
# shellcheck source=_autopilot_summary.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_autopilot_summary.sh"
MERGE_FOLLOWUP_PY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/merge_followup.py"

merge_followup_marks() {   # stdin：PR 正文；stdout：每个算数的标记一行「B|E|N 行号」
    awk -v b="$MERGE_FOLLOWUP_BEGIN" -v e="$MERGE_FOLLOWUP_END" -v n="$MERGE_FOLLOWUP_NONE" "$BODY_MARK_AWK"'
        { if (fence_step($0)) next
          if (alone_mark($0, b)) print "B " NR
          else if (alone_mark($0, e)) print "E " NR
          else if (alone_mark($0, n)) print "N " NR }'
}

# stdin：PR 正文；stdout：一行 JSON {s: list|none|silent|bad, items: [...], raw: "..."}；return 1 = 算不出（不当成「没提」）
merge_followup_parse() {
    local d rc=0
    d=$(mktemp -d 2>/dev/null) || return 1
    cat > "$d/body" || { rm -rf "$d"; return 1; }
    merge_followup_marks < "$d/body" > "$d/marks" || rc=1
    body_section "$MERGE_FOLLOWUP_BEGIN" "$MERGE_FOLLOWUP_END" alone < "$d/body" > "$d/section" || rc=1
    [ "$rc" = 0 ] && python3 -B "$MERGE_FOLLOWUP_PY" parse "$d/body" "$d/marks" "$d/section" || rc=1
    rm -rf "$d"
    return "$rc"
}

# ── 合并后的交接（GitHub#656）：记录、发现、交接 ──
# 规则全文在 merge_followup.py 文件头和 GitHub#656 的方案里；这里只说 shell 这一侧的分工和不能弄错的几处。
#
# 记录在 state.json 的 .merge_followup 下（故意不进 agent-poll.sh 顶部的补字段循环：没合并过 PR 的项目
# state.json 不变；读处一律 `// {}` 兜底）：
#   prs[<PR>]     PR 记录：target（交接目标；正文读不到又认不出时为空）、owner（known / unknown）、
#                 merged_at / sha / base / head_ref / head_sha、body（ok / pending）、s / items / raw（读法结果）、
#                 found（合并发现已做）、cleanup（retry / done / ended）、cleanup_skipped、rereads、
#                 fb（正文读不到又认不出目标时的兜底：{pos: "pr", sent, superseded, comment, label}）、
#                 ended（yes 之后永不改）、handed（覆盖它的已收敛版本）、pr_labeled、notified、
#                 ap（托管合并预存：{pre: prestored|requested|found, head, base, title, desc, desc_sent}）
#   targets[<N>]  目标记录：v（最新版本号）、fp（最新版本指纹）、sent（已确认发出的版本指纹）、
#                 converged（已收敛的版本指纹）、tries、failed、human_added
#   round         本项目做过几轮交接（兜底目标、正文补读按它数「每 30 轮」）
# 写入：所有对 .merge_followup 的写都经 mf_set（写不进去 return 1，调用方本轮停手）。
# 标签：issue 目标的标签一律交给托管交接那套（autopilot_merged_handoff：一次写一个、写前判两次、写后核对），
#       交接记录放在 .autopilot.handoff["mf<N>"]，带 mf: true（旧的托管交接记录没有它，由迁移接管）。

MF_CLEANED_THIS_ROUND=" "   # 这一轮刚做完合并清理的工作编号（空格分隔），只在本进程内有效
MF_DISCOVERED=0         # 本轮合并发现成功（列表整个读到、新记录全部落盘）：机器人通知依据的第一项
MF_MAX_TRIES="${SUB_ISSUE_ROLLUP_MAX_TRIES:-30}"

mf_get() {   # <jq 表达式（作用于 .merge_followup）> [jq 参数…]；读不出输出空
    local expr="$1"; shift
    jq -c "$@" "(.merge_followup // {}) | ($expr)" "${STATE_FILE:-$STATE_DIR/state.json}" 2>/dev/null
}
mf_set() {   # <jq 表达式（作用于 .merge_followup）> [jq 参数…]
    local expr="$1" sf="${STATE_FILE:-$STATE_DIR/state.json}" tmp
    shift
    tmp=$(mktemp) || return 1
    # 写完是空的就不留这一项：没合并过 PR 的项目 state.json 一字不变
    if jq "$@" ".merge_followup = ((.merge_followup // {}) | $expr) | if .merge_followup == {} then del(.merge_followup) else . end" "$sf" > "$tmp" 2>/dev/null && [ -s "$tmp" ]; then
        mv "$tmp" "$sf"
    else
        rm -f "$tmp"; log "  ⚠️ 合并后交接：状态写入失败（${expr}）"; return 1
    fi
}

# ── T1–T3：托管合并的预存与结果确认 ──
# 合并请求之前先把核准身份和说明全文记下：请求没有响应、GitHub 其实已合并时依据不丢（方案 T1–T3）
mf_ap_prestore() {   # <PR> <目标> <issue|pr> <核准提交> <目标分支> <标题> <说明文件>
    mf_set '.prs[$p] = ((.prs[$p] // {}) + {ap: {pre: "prestored", target: $n, kind: $k, head: $h, base: $b, title: $t, desc: $d, desc_sent: false}})' \
        --arg p "$1" --arg n "$2" --arg k "$3" --arg h "$4" --arg b "$5" --arg t "$6" --rawfile d "$7"
}
mf_ap_requested() { mf_set '.prs[$p].ap.pre = "requested"' --arg p "$1"; }

# T3：每轮先确认还没被合并发现接走的预存记录。读不到 = 不动；请求失败本身不删记录
mf_ap_confirm_tick() {
    local pr pj st merged sha want
    for pr in $(mf_get '[.prs // {} | to_entries[] | select(.value.ap != null and (.value.found // false) == false and .value.ap.pre != "found") | .key] | .[]' | tr -d '"'); do
        [[ "$pr" =~ ^[0-9]+$ ]] || continue
        pj=$(gh api "repos/$REPO/pulls/$pr" 2>/dev/null) || continue
        st=$(printf '%s' "$pj" | jq -r '.state // ""'); merged=$(printf '%s' "$pj" | jq -r '.merged // ""')
        sha=$(printf '%s' "$pj" | jq -r '.head.sha // ""'); want=$(mf_get '.prs[$p].ap.head // ""' --arg p "$pr" | jq -r .)
        if [ "$merged" = true ] && [ "$sha" = "$want" ]; then
            # daemon 自己合并、现读确认已合并：这就是合并发现（T3 → T4），不用等已合并列表把它列出来
            # （刚合并的 PR 进列表可能慢一拍）。和列表发现走同一个 mf_discover，记录一模一样
            local f="$STATE_DIR/.mf-confirm"
            if printf '%s' "$pj" | jq -c '[{number, title, body, headRefName: .head.ref, mergedAt: .merged_at,
                    mergeCommit: {oid: (.merge_commit_sha // "")}, baseRefName: .base.ref, headRefOid: .head.sha,
                    headRepository: {name: ((.head.repo.full_name // "") | split("/") | .[1] // "")},
                    headRepositoryOwner: {login: ((.head.repo.full_name // "") | split("/") | .[0] // "")}}]' > "$f" 2>/dev/null; then
                mf_discover "$f" || log "  合并后交接：托管合并的 PR #$pr 已确认合并，记录没写进去，下轮再来"
            fi
            rm -f "$f"
        elif [ "$st" = closed ] && { [ "$merged" = false ] || [ "$sha" != "$want" ]; }; then
            log "  合并后交接：托管预存的 PR #$pr 已关闭未合并（或提交对不上），预存作废"
            mf_set 'del(.prs[$p])' --arg p "$pr" || true
        elif [ "$st" = open ] && [ -n "$sha" ] && [ "$sha" != "$want" ]; then
            log "  合并后交接：托管预存的 PR #$pr 有了新提交，预存作废（下次合并重新预存）"
            mf_set 'del(.prs[$p])' --arg p "$pr" || true
        fi
    done
}

# ── T4：合并发现。<列表文件> = gh pr list --state merged 的 JSON（带正文、合并时间、合并提交、分支）──
# 一次写入全部新发现的 PR 记录；写不进去 return 1（整段停下，下轮重来：这些 PR 没记入已清理，会再被发现）
mf_discover() {   # <列表文件>
    local list="$1" cleaned pr branch body bstate parsed target owner rec closes d rc=0
    MF_DISCOVERED=0
    cleaned=$(jq -c '.cleaned_prs // []' "${STATE_FILE:-$STATE_DIR/state.json}" 2>/dev/null) || return 1
    MF_DEFAULT_BRANCH=""
    # 正文、清单大小没有上限：一律经文件 / 标准输入交给 jq，不经命令行参数（AGENTS.md，GitHub#426）
    d=$(mktemp -d) || return 1
    : > "$d/new.jsonl"
    while IFS= read -r rec; do
        [ -n "$rec" ] || continue
        pr=$(printf '%s' "$rec" | jq -r '.number')
        branch=$(printf '%s' "$rec" | jq -r '.headRefName // ""')
        if printf '%s' "$cleaned" | jq -e --argjson n "$pr" 'index($n) != null' >/dev/null; then continue; fi
        if [ "$(mf_get '.prs[$p].found // false' --arg p "$pr")" = true ]; then continue; fi
        if [ "$(printf '%s' "$rec" | jq -r '.body | type')" = string ]; then
            body=$(printf '%s' "$rec" | jq -r '.body')
            if ! printf '%s\n' "$body" | merge_followup_parse > "$d/parsed"; then
                log "  ⚠️ 合并后交接：PR #$pr 的正文读法出错，本轮整段停下"; rm -rf "$d"; return 1
            fi
            bstate=ok; closes=0
            target=$(pr_to_issue_num "$pr" "$branch" "$body"); owner=known
            # GitHub 只在合进默认分支时按关闭关键词关 issue；默认分支读不到时按「会关」记（交接最多等 5 轮）
            if printf '%s' "$body" | autopilot_body_has_close; then
                [ -n "$MF_DEFAULT_BRANCH" ] || MF_DEFAULT_BRANCH=$(gh api "repos/$REPO" --jq '.default_branch // ""' 2>/dev/null) || MF_DEFAULT_BRANCH=""
                if [ -z "$MF_DEFAULT_BRANCH" ] || [ "$MF_DEFAULT_BRANCH" = "$(printf '%s' "$rec" | jq -r '.baseRefName // ""')" ]; then closes=1; fi
            fi
        else
            echo '{"s":"silent","items":[],"raw":""}' > "$d/parsed"; bstate=pending; closes=0
            target=$(branch_to_issue_num "$branch"); owner=known
            [ -n "$target" ] || owner=unknown
        fi
        printf '%s' "$rec" | jq -c --arg p "$pr" --slurpfile x "$d/parsed" --arg t "$target" \
            --arg o "$owner" --arg b "$bstate" --arg c "$closes" '. as $r | {key: $p, value: ({closes: ($c == "1"), target: (if $t == "" then null else $t end), owner: $o, body: $b,
                merged_at: ($r.mergedAt // ""), sha: ($r.mergeCommit.oid // ""), base: ($r.baseRefName // ""),
                head_ref: ($r.headRefName // ""), head_sha: ($r.headRefOid // ""), title: ($r.title // ""),
                head_repo: (if ($r.headRepositoryOwner.login // "") != "" and ($r.headRepository.name // "") != ""
                            then "\($r.headRepositoryOwner.login)/\($r.headRepository.name)" else "" end),
                found: true, cleanup: "retry", rereads: 0} + $x[0])}' >> "$d/new.jsonl" || { rm -rf "$d"; return 1; }
    done < <(jq -c '.[]' "$list" 2>/dev/null)
    if [ -s "$d/new.jsonl" ]; then
        # 托管预存：分支提交和核准提交一致才接上（不一致 = 合进去的不是复审过的那一版，说明作废）
        # 托管预存：交接目标按托管的绑定（绑 issue = 那个 issue，没绑 = PR 本身），不按分支名猜——分支 feature/issue-7
        # 撞上本仓库无关的 #7 时，清理按工作编号照旧（work），交接不碰 #7
        mf_set 'reduce ($n[]) as $e (.; (if $e.value.target != null then .targets[$e.value.target].wake = true else . end) | .prs[$e.key] = (
                    ($e.value + {work: $e.value.target}) as $v
                    | (if (.prs[$e.key].ap // null) != null and .prs[$e.key].ap.head == $v.head_sha
                       then $v + {target: (.prs[$e.key].ap.target // $v.target), ap: (.prs[$e.key].ap + {pre: "found"})} else $v end)))' \
            --slurpfile n "$d/new.jsonl" || rc=1
        if [ "$rc" != 0 ]; then rm -rf "$d"; return 1; fi
        for pr in $(jq -r 'select(.value.owner == "known") | .value.target' "$d/new.jsonl" | sort -u); do
            # 它若是拆出来的 sub-issue：父 issue 汇总入队（与主干同一时刻：发现即入队，不看清理成没成；
            # 合并清理关着时主干不做汇总，这里也不入队）
            [ "${AUTO_CLEANUP_ON_MERGE:-true}" = false ] || sub_issue_rollup_enqueue "$pr" "${STATE_FILE:-$STATE_DIR/state.json}"
        done
        log "  合并后交接：发现 $(jq -s 'length' "$d/new.jsonl") 个新合并的 PR（$(jq -rs 'map("#" + .key) | join(" ")' "$d/new.jsonl")）"
    fi
    rm -rf "$d"
    MF_DISCOVERED=1
}

# T5 之后：本轮列表完整读到时，仍在「待重试」、但已不在列表里的清理永久判「已终止」；归属未知的不清理
mf_cleanup_settle() {   # <列表文件>
    local list="$1" nums
    nums=$(jq -c '[.[].number | tostring]' "$list" 2>/dev/null) || return 0
    # 列表不满 30 个时，没在里面的 PR 不是「被挤出窗口」（多半是刚合并、还没进列表），不判已终止
    [ "$(printf '%s' "$nums" | jq 'length')" -ge 30 ] || return 0
    mf_set '(.prs // {}) as $P | reduce ($P | to_entries[]) as $e (.;
        if ($e.value.found // false) and ($e.value.cleanup // "") == "retry" and (($n | index($e.key)) == null)
        then .prs[$e.key].cleanup = "ended" | (if $e.value.target != null then .targets[$e.value.target].wake = true else . end)
        else . end)' --argjson n "$nums" || true
}
# 合并清理关着（AUTO_CLEANUP_ON_MERGE=false）：清理不做，「待重试」的一律记「已终止」，交接不等它
mf_cleanup_off() {
    mf_set '(.prs // {}) as $P | reduce ($P | to_entries[] | select((.value.found // false) and .value.cleanup == "retry")) as $e (.;
        .prs[$e.key].cleanup = "ended" | (if $e.value.target != null then .targets[$e.value.target].wake = true else . end))'
}
mf_cleanup_mark() {   # <PR> <done|retry|ended> [skipped]
    if [ "$2" = retry ]; then mf_set '.prs[$p].cleanup = "retry"' --arg p "$1"; return; fi
    mf_set '.prs[$p].cleanup = $s | (if $k != "" then .prs[$p].cleanup_skipped = true else . end)
            | (if .prs[$p].target != null then .targets[.prs[$p].target].wake = true else . end)' \
        --arg p "$1" --arg s "$2" --arg k "${3:-}"
}

# ── T4b：正文读不到的 PR，补读（前 30 轮每轮，之后每 30 轮一次）──
mf_reread_tick() {
    local round pr r pj body parsed target branch fbpos note
    round=$(mf_get '.round // 0')
    for pr in $(mf_get '[.prs // {} | to_entries[] | select((.value.found // false) and .value.body == "pending") | .key] | .[]' | tr -d '"'); do
        r=$(mf_get '.prs[$p].rereads // 0' --arg p "$pr")
        if [ "$r" -ge 30 ] && [ $(( round % 30 )) -ne 0 ]; then continue; fi
        if pj=$(gh api "repos/$REPO/pulls/$pr" 2>/dev/null) && [ "$(printf '%s' "$pj" | jq -r '.body | type' 2>/dev/null)" = string ]; then
            body=$(printf '%s' "$pj" | jq -r '.body')
            printf '%s\n' "$body" | merge_followup_parse > "$STATE_DIR/.mf-parsed" || continue
            branch=$(mf_get '.prs[$p].head_ref // ""' --arg p "$pr" | jq -r .)
            target=$(pr_to_issue_num "$pr" "$branch" "$body")
            fbpos=$(mf_get '.prs[$p].fb.pos // ""' --arg p "$pr" | jq -r .)
            note=""
            if [ -n "$fbpos" ]; then
                case "$(mf_get '"\(.prs[$p].fb.sent // false)|\(.prs[$p].fb.comment // "no")"' --arg p "$pr" | jq -r .)" in
                    true\|*) note="之前正文读不到，已在 PR #$pr 上交过兜底提醒" ;;
                    false\|yes) note="PR #$pr 上已发一条兜底评论，提醒标签未确认挂上" ;;
                    false\|unknown) note="PR #$pr 上可能已有一条兜底评论，未能确认" ;;
                esac
            fi
            mf_set '.prs[$p] += ($x[0] + {body: "ok", owner: "known", target: $t, work: $t, rereads: (.prs[$p].rereads + 1)})
                    | (if $note != "" then .prs[$p].fb_note = $note else . end)
                    | (if .prs[$p].fb != null then .prs[$p].fb.superseded = true else . end)
                    | .prs[$p].handed = null | .targets[$t].wake = true' \
                --arg p "$pr" --slurpfile x "$STATE_DIR/.mf-parsed" --arg t "$target" --arg note "$note" || continue
            log "  合并后交接：PR #$pr 的正文补读到了（目标 #${target}）"
            [ "${AUTO_CLEANUP_ON_MERGE:-true}" = false ] || sub_issue_rollup_enqueue "$target" "${STATE_FILE:-$STATE_DIR/state.json}"
            continue
        fi
        r=$((r + 1))
        mf_set '.prs[$p].rereads = $r' --arg p "$pr" --argjson r "$r" || continue
        if [ "$r" -ge 30 ] && [ "$(mf_get '.prs[$p].owner' --arg p "$pr" | jq -r .)" = unknown ] \
           && [ "$(mf_get '.prs[$p].fb // null' --arg p "$pr")" = null ]; then
            log "  合并后交接：PR #$pr 的正文连续 $r 轮读不到、分支名也认不出目标 → 在 PR 本身上交人兜底"
            mf_set '.prs[$p].fb = {pos: "pr", sent: false, comment: "no"}' --arg p "$pr" || true
        fi
    done
}

# ── 迁移：升级后第一轮接管主干的在途记录（方案修订版 23–25 的接管表）──
# 读不出的条目原样留在旧字段，下轮再试；它对应的机器人通知不发（只会少报，不会误报「完成」）
mf_record_from_pr() {   # <PR> [托管说明] [说明已发 true|false]；现读 PR 建一条已发现的记录（清理已做过）
    local pr="$1" body target branch f="$STATE_DIR/.mf-rec" rc=0
    gh api "repos/$REPO/pulls/$pr" > "$f.pj" 2>/dev/null || return 1
    [ "$(jq -r '.merged // false' "$f.pj" 2>/dev/null)" = true ] || return 1
    [ "$(jq -r '.body | type' "$f.pj")" = string ] || return 1
    body=$(jq -r '.body' "$f.pj")
    printf '%s\n' "$body" | merge_followup_parse > "$f.x" || return 1
    printf '%s' "${2:-}" > "$f.d"
    branch=$(jq -r '.head.ref // ""' "$f.pj")
    target=$(pr_to_issue_num "$pr" "$branch" "$body")
    mf_set '$j[0] as $j | .prs[$p] = ((.prs[$p] // {}) + {target: $t, work: $t, owner: "known", body: "ok", found: true, cleanup: "done", rereads: 0,
                merged_at: ($j.merged_at // ""), sha: ($j.merge_commit_sha // ""), base: ($j.base.ref // ""),
                head_ref: ($j.head.ref // ""), head_sha: ($j.head.sha // ""), head_repo: ($j.head.repo.full_name // ""),
                title: ($j.title // ""), migrated: true} + $x[0])
            | (if $d != "" then .prs[$p].ap = {pre: "found", desc: $d, desc_sent: ($s == "true"), title: ($j.title // ""), head: ($j.head.sha // "")} else . end)' \
        --arg p "$pr" --slurpfile j "$f.pj" --slurpfile x "$f.x" --arg t "$target" --rawfile d "$f.d" --arg s "${3:-false}" || rc=1
    rm -f "$f.pj" "$f.x" "$f.d"
    return "$rc"
}
mf_migrate() {
    local sf="${STATE_FILE:-$STATE_DIR/state.json}" issue pr body sent
    for issue in $(jq -r '(.merged_label_queue // {}) | keys[]' "$sf" 2>/dev/null); do
        pr=$(jq -r --arg i "$issue" '.merged_label_queue[$i].pr // ""' "$sf")
        if [[ "$pr" =~ ^[0-9]+$ ]] && { [ "$(mf_get '.prs[$p].found // false' --arg p "$pr")" = true ] || mf_record_from_pr "$pr"; }; then
            jq --arg i "$issue" 'del(.merged_label_queue[$i])' "$sf" > "$sf.mf" && mv "$sf.mf" "$sf"
            log "  合并后交接：接管旧的合并后标签条目 issue #${issue}（PR #${pr}）"
        fi
    done
    for pr in $(jq -r '(.requester_bot_done_queue // {}) | to_entries[] | select(.value.kind == "merged" and (.value.v // 0) < 2) | .key' "$sf" 2>/dev/null); do
        [[ "$pr" =~ ^[0-9]+$ ]] || continue
        if [ "$(mf_get '.prs[$p].found // false' --arg p "$pr")" = true ] || mf_record_from_pr "$pr"; then
            # 旧条目看不出评论发没发：标 legacy，由机器人通知那一步先按旧标记辨认（修订版 24、25）
            jq --arg p "$pr" '.requester_bot_done_queue[$p] += {v: 2, legacy: true}' "$sf" > "$sf.mf" && mv "$sf.mf" "$sf"
            log "  合并后交接：接管旧的机器人「已合并」通知条目 PR #$pr"
        fi
    done
    for pr in $(jq -r '(.autopilot.handoff // {}) | to_entries[] | select((.value.mf // false) == false) | .key' "$sf" 2>/dev/null); do
        [[ "$pr" =~ ^[0-9]+$ ]] || continue
        body=$(jq -r --arg p "$pr" '.autopilot.handoff[$p].body // ""' "$sf")
        sent=$(jq -r --arg p "$pr" '.autopilot.handoff[$p].commented // false' "$sf")
        [ -n "$body" ] || body="合并说明见 PR #${pr}。"
        if mf_record_from_pr "$pr" "$body" "$sent"; then
            jq --arg p "$pr" 'del(.autopilot.handoff[$p])' "$sf" > "$sf.mf" && mv "$sf.mf" "$sf"
            log "  合并后交接：接管旧的托管合并交接 PR #${pr}（说明$( [ "$sent" = true ] && echo 已发、不重发 || echo 未发、并进清单评论)）"
        fi
    done
}

# ── T6：一个目标的共用结论（现读现算；同一函数供 T7 写前重判和机器人通知依据用）──
# stdout：conclude 的输出 + {state, kind, labels}；return 1 = 发评论必需的那部分读不到（①）
# ② 结束判定所需（事件记录、执行人写权限）读不到不停手：相关清单记「判不了」照列
MF_BOTS_JSON='[]'
mf_target_conclude() {   # <目标编号> [兜底 PR：目标就是这个正文读不到的 PR 本身]
    local n="$1" fb="${2:-}" ij st labs kind need actors writers='{}' login atype rc ended me flows sup=false newest d out=1
    # 记录里有托管说明、清单原文，事件记录也没有上限：一律经文件交给 jq / python，不经命令行参数
    d=$(mktemp -d) || return 1
    _mf_conclude_in "$n" "$fb" "$d" && out=0
    rm -rf "$d"
    return "$out"
}
_mf_conclude_in() {   # <目标> <兜底 PR> <临时目录>
    local n="$1" fb="$2" d="$3" ij st labs kind need actors writers='{}' closers='{}' login atype rc ended me flows sup=false newest nid out pr lastclose=unread
    ij=$(gh api "repos/$REPO/issues/$n" 2>/dev/null) || return 1
    printf '%s' "$ij" | jq -e '(.state | type) == "string" and (.labels | type) == "array"' >/dev/null 2>&1 || return 1
    st=$(printf '%s' "$ij" | jq -r .state); labs=$(printf '%s' "$ij" | jq -c '[.labels[].name] | sort')
    kind=issue; [ "$(printf '%s' "$ij" | jq -r '.pull_request != null')" = true ] && kind=pr
    if [ -n "$fb" ]; then
        mf_get '[{pr: $p} + .prs[$p]]' --arg p "$fb" > "$d/recs"
    else
        mf_get '[.prs // {} | to_entries[] | select((.value.found // false) and .value.target == $n) | {pr: .key} + .value]' --arg n "$n" > "$d/recs"
    fi
    [ "$(jq 'length' "$d/recs" 2>/dev/null)" -gt 0 ] 2>/dev/null || return 1
    # 每个覆盖到的 PR 现读身份（已合并、合并提交、目标分支、来源分支），和记录对得上才往下算；对不上或读不到 = 不写。
    # 读到的身份进写前依据（basis），两次判定逐字比较
    : > "$d/ident"
    for pr in $(jq -r '.[].pr' "$d/recs"); do
        gh api "repos/$REPO/pulls/$pr" > "$d/pj" 2>/dev/null || return 1
        jq -c --arg p "$pr" '{pr: $p, merged: (.merged // null), sha: (.merge_commit_sha // ""), base: (.base.ref // ""),
            head_ref: (.head.ref // ""), head_sha: (.head.sha // ""), head_repo: (.head.repo.full_name // ""),
            labels: (if (.labels | type) == "array" then ([.labels[].name] | sort) else error("labels") end)}' "$d/pj" >> "$d/ident" 2>/dev/null || return 1
        # 合并提交、目标分支、来源分支、分支最新提交、来源仓库：记录和现读两边都得有值、而且相等，缺一样就不写
        jq -e --slurpfile i <(tail -n 1 "$d/ident") --arg p "$pr" '.[] | select(.pr == $p) as $r | $i[0] as $i
            | $i.merged == true
              and all(["sha", "base", "head_ref", "head_sha", "head_repo"][]; . as $k | (($r[$k] // "") != "" and $r[$k] == $i[$k]))' \
            "$d/recs" >/dev/null 2>&1 || {
            log "  合并后交接：PR #$pr 现读的身份和记录对不上（或缺字段），#$n 本轮不写"; return 1; }
    done
    me=$(write_identity_login)
    MF_BOTS_JSON=$(printf '%s\n%s\n' "$me" "${REQUESTER_BOT_ACCOUNT:-}" | jq -Rsc 'split("\n") | map(select(. != ""))')
    need=$(jq -c '[.[] | select(.ended != "yes") | {(.pr): (.merged_at // "")}] | add // {}' "$d/recs")
    if [ "$need" != "{}" ]; then
        if gh api --paginate --slurp "repos/$REPO/issues/$n/events" > "$d/evraw" 2>/dev/null \
           && jq -c '[.[] | if type == "array" then .[] else error("page") end]' "$d/evraw" > "$d/evs" 2>/dev/null; then
            actors=$(jq -r --argjson b "$MF_BOTS_JSON" '[.[] | select(.event == "closed" and ((.commit_id // "") == ""))
                | .actor | select(. != null) | select(((.login // "") | ascii_downcase) as $l | ($b | map(ascii_downcase) | index($l)) == null)
                | "\(.login)\t\(.type // "User")"] | unique[]' "$d/evs")
            while IFS=$'\t' read -r login atype; do
                [ -n "$login" ] || continue
                rc=0; repo_maintainer_check "$login" "$atype" || rc=$?
                writers=$(printf '%s' "$writers" | jq -c --arg l "$(printf '%s' "$login" | tr '[:upper:]' '[:lower:]')" --arg r "$rc" \
                    '.[$l] = (if $r == "0" then true elif $r == "1" then false else null end)')
            done <<< "$actors"
            # 关闭事件是谁关的：只认 GraphQL 的 ClosedEvent.closer（PR 合并带关时 REST 的 commit_id 是空的，分不出
            # 合并带关和人亲手关）。只查可能算数的那几条（没有 commit_id、不是 loop / 机器人关的）；读不到 = 判不了
            jq -r --argjson b "$MF_BOTS_JSON" '.[] | select(.event == "closed" and ((.commit_id // "") == ""))
                | select(((.actor.login // "") | ascii_downcase) as $l | $l != "" and ($b | map(ascii_downcase) | index($l)) == null)
                | .node_id // empty' "$d/evs" | sort -u > "$d/nids"
            while IFS= read -r nid; do
                [ -n "$nid" ] || continue
                # 只认两种明确的回答：closer 字段在、值是 null（人亲手关，记 none）；closer 是带类型名的对象（PR / 提交带关）。
                # 节点不是关闭事件、缺 closer 字段、closer 缺类型名 → 不记，按「判不了」处理
                if out=$(gh api graphql -f query='query($id:ID!){node(id:$id){__typename ... on ClosedEvent{closer{__typename}}}}' -f id="$nid" 2>/dev/null); then
                    out=$(printf '%s' "$out" | jq -c '.data.node as $n
                        | if ($n | type) == "object" and $n.__typename == "ClosedEvent" and ($n | has("closer")) then
                              (if $n.closer == null then "none"
                               elif ($n.closer | type) == "object" and (($n.closer.__typename // null) | type) == "string" and $n.closer.__typename != "" then $n.closer.__typename
                               else null end)
                          else null end' 2>/dev/null) || out=null
                    [ "$out" = null ] || closers=$(printf '%s' "$closers" | jq -c --arg n "$nid" --argjson o "$out" '.[$n] = $o')
                fi
            done < "$d/nids"
            lastclose=$(jq -r '[.[] | select(.event == "closed" or .event == "reopened") | "\(.event):\(.id // "")"] | last // "none"' "$d/evs")
        else
            echo null > "$d/evs"
        fi
        ended=$(jq -c --argjson m "$need" --argjson w "$writers" --argjson b "$MF_BOTS_JSON" --argjson c "$closers" \
            '{events: ., merged: $m, writers: $w, bots: $b, closers: $c}' "$d/evs" | python3 -B "$MERGE_FOLLOWUP_PY" ended) || return 1
        # T13：确认维护者在合并之后亲手关闭过 → 永久记下（只增不改）
        if [ -z "$fb" ] && printf '%s' "$ended" | jq -e 'to_entries | any(.value == "yes")' >/dev/null; then
            mf_set 'reduce ($e | to_entries[] | select(.value == "yes") | .key) as $k (.; .prs[$k].ended = "yes")' --argjson e "$ended" || return 1
        fi
        jq -c --argjson e "$ended" 'map(.ended = ($e[.pr] // .ended // "no"))' "$d/recs" > "$d/recs2" && mv "$d/recs2" "$d/recs" || return 1
    fi
    if [ "$st" = open ]; then
        flows=$(autopilot_handoff_flow_labels)
        [ "$(mf_get '.targets[$n].human_added // false' --arg n "$n")" = true ] && flows=$(printf '%s' "$flows" | jq -c --arg H "$LABEL_PENDING_HUMAN" 'map(select(. != $H))')
        printf '%s' "$labs" | jq -e --argjson f "$flows" 'any(.[]; . as $l | $f | index($l))' >/dev/null 2>&1 && sup=true
    fi
    newest=$(jq -r 'sort_by(.merged_at, (.pr | tonumber)) | last | .pr' "$d/recs")
    # 托管说明属于「最新合并的那个 PR」这一版：只看记录本身，不看发没发过（否则发出之后重算的结论就变了）。
    # 迁移接管的、升级前已发过说明的（desc_sent）不再并进来
    jq -c --arg nw "$newest" 'map(select(.pr == $nw)) | .[0]
        | if . != null and .ap != null and .ap.pre == "found" and (.ap.desc_sent // false) == false
          then {pr: .pr, title: (.ap.title // .title // ""), desc: (.ap.desc // ""), head: (.ap.head // ""), closes: (.closes // false)} else null end' "$d/recs" > "$d/ap" || return 1
    jq -cn --arg n "$n" --arg k "$kind" --arg s "$st" --argjson sup "$sup" --arg nw "$newest" --slurpfile ap "$d/ap" --slurpfile r "$d/recs" \
        --arg H "$LABEL_PENDING_HUMAN" --arg D "$LABEL_DONE" --arg A "${LABEL_PENDING_AGENT_DEFAULT:-pending/agent}" \
        '{target: $n, kind: $k, state: $s, superseded: $sup, newest: $nw, autopilot: $ap[0], labels: {human: $H, done: $D, agent: $A}, records: $r[0]}' \
        | python3 -B "$MERGE_FOLLOWUP_PY" conclude > "$d/c" || return 1
    # basis = 写前核对的全部依据：目标状态、完整标签、每个覆盖 PR 的现读身份、关闭证据（最后一次关闭 / 重开、每条清单
    # 结束与否）。发评论前两次判定的 fp 和 basis 都要逐字一致
    jq -c --arg s "$st" --arg k "$kind" --argjson l "$labs" --slurpfile ap "$d/ap" --slurpfile id "$d/ident" \
        --slurpfile r "$d/recs" --arg lc "$lastclose" \
        '. + {state: $s, kind: $k, labels: $l, ap: $ap[0],
              basis: {state: $s, labels: $l, ident: $id, last_close: $lc, ended: ($r[0] | map({(.pr): (.ended // "no")}) | add)}}' "$d/c"
}

# 目标上已确认发出的那条清单评论（按标记找，只认写身份发的）。0 = 有；1 = 没有；2 = 读不到
mf_comment_find() {   # <目标> <指纹>
    local me out
    me=$(write_identity_login); [ -n "$me" ] || return 2
    out=$(gh api --paginate --slurp "repos/$REPO/issues/$1/comments" 2>/dev/null) || return 2
    printf '%s' "$out" | jq -e --arg me "$me" --arg m "<!-- cavil-loop:merge-followup target=$1 " --arg f " fp=$2 -->" '
        any(.[] | if type == "array" then .[] else . end; ((.user.login // "") | ascii_downcase) == ($me | ascii_downcase)
            and ((.body // "") | contains($m) and contains($f)))' >/dev/null 2>&1 \
        && return 0
    return 1
}

# 合并 PR 自己的标签：Done（<reminder>=true 时另挂 pending/human），摘掉流程标签。复审第 1–3 轮在这条路径上连续指出
# 写前依据不全的变体，这里一次收口（硬规则 L1）。整条路径只认一份「PR 现状」（mf_pr_state）：
#   身份（已合并、分支最新提交）+ 完整标签 + 每个流程标签最后一次「加上」的事件编号和时间。
#   读不全（缺 labels 数组、事件页读不到、相关事件缺编号或时间）= 判不了，本轮一个标签都不动（return 1）。
# 判断能不能动：PR 上的每个流程标签，都必须找得到「加上」它的事件、有时间、而且早于合并时间（合并前挂的、这一轮留下的），
#   才可以摘；有一个是合并之后挂上的 → 新一轮，这个 PR 的标签一个不动（return 0，记 pr_superseded）；
#   有一个找不到事件或缺时间 → 判不了（return 1）。
# 写：一次一步，每步之前现读 mf_pr_state，必须等于「开始时 + 已写成的这几步」：身份一样、标签集合一样、
#   每个这次没动过的流程标签最后一次「加上」的事件编号一样（同名标签被摘掉又挂回去，集合不变、事件编号变了 → 停手）。
#   不一致就停手（return 1），下一轮从头判。写完再读一次，核对同一份期望
mf_pr_state() {   # <PR> → stdout 一行 JSON {merged, head_sha, labels, last:{标签: {id, at}}}；return 1 = 读不全
    local pr="$1" pj ev flows
    pj=$(gh api "repos/$REPO/pulls/$pr" 2>/dev/null) || return 1
    ev=$(gh api --paginate --slurp "repos/$REPO/issues/$pr/events" 2>/dev/null) || return 1
    flows=$(mf_flow_labels)
    { printf '%s\n' "$pj"; printf '%s\n' "$ev"; } | jq -cs --argjson f "$flows" '
        .[0] as $p | .[1] as $pages
        | if ($p.labels | type) != "array" or ($p.merged | type) != "boolean"
             or any(($p.merge_commit_sha, $p.base.ref, $p.head.ref, $p.head.sha, $p.head.repo.full_name); (. // "") == "")
          then error("pr") else . end
        | [$pages[] | if type == "array" then .[] else error("page") end] as $e
        | [$e[] | select((.event == "labeled" or .event == "unlabeled") and ((.label.name // "") as $l | $f | index($l)) != null)] as $le
        | if any($le[]; (.id | type) != "number" or ((.created_at // "") == "")) then error("event") else . end
        | ([$e | to_entries[] | select(.value.event == "merged") | .key] | last) as $mp
        | {merged: $p.merged, ident: {sha: $p.merge_commit_sha, base: $p.base.ref, head_ref: $p.head.ref, head_sha: $p.head.sha,
                                     head_repo: $p.head.repo.full_name},
           labels: ([$p.labels[].name] | sort), merged_pos: $mp,
           last: (reduce ($e | to_entries[] | select(.value.event == "labeled" and ((.value.label.name // "") as $l | $f | index($l)) != null)) as $x
                  ({}; .[$x.value.label.name] = {id: $x.value.id, at: $x.value.created_at, pos: $x.key,
                                                 by: ((($x.value.actor // {}).login // "") | ascii_downcase)}))}' 2>/dev/null
}
mf_flow_labels() {
    printf '%s\n' "$LABEL_PENDING_HUMAN" "$LABEL_PENDING_AGENT_DEFAULT" "${LABEL_PENDING_AGENT_FABLE:-}" "${LABEL_PENDING_REVIEW:-}" \
        "${LABEL_PENDING_MERGE:-}" "$LABEL_AGENT_DOING" | awk 'NF && !seen[$0]++' | jq -Rsc 'split("\n") | map(select(. != ""))'
}
mf_pr_labels() {   # <PR> <true|false>
    local pr="$1" rem="$2" at s0 flows verdict plan step kind lab cur expect touched='[]' out me
    at=$(mf_get '.prs[$p].merged_at // ""' --arg p "$pr" | jq -r .)
    [ -n "$at" ] || return 1
    s0=$(mf_pr_state "$pr") && [ -n "$s0" ] || { log "  合并后交接：PR #$pr 的标签或标签事件读不全，本轮不动它的标签"; return 1; }
    # 身份口径和清单判定那边（_mf_conclude_in）同一套五项：合并提交、目标分支、来源分支、分支最新提交、来源仓库
    printf '%s' "$s0" | jq -e --argjson r "$(mf_get '.prs[$p] | {sha, base, head_ref, head_sha, head_repo}' --arg p "$pr")" '
        . as $s | $s.merged == true and all(["sha", "base", "head_ref", "head_sha", "head_repo"][]; . as $k | (($r[$k] // "") != "" and $r[$k] == $s.ident[$k]))' \
        >/dev/null 2>&1 || { log "  合并后交接：PR #$pr 现读的身份和记录对不上，本轮不动它的标签"; return 1; }
    me=$(write_identity_login | tr '[:upper:]' '[:lower:]'); [ -n "$me" ] || return 1
    flows=$(mf_flow_labels)
    # 交接自己写的那个提醒（写入账号挂上的 pending/human——上一轮写了一半：加了提醒、摘旧标签失败）不是新一轮：
    # 它不挡这次收尾，提醒本身按 <reminder> 保留或摘掉。只认 pending/human：别的流程标签哪怕是写入账号挂的
    # （比如新一轮派工时 daemon 翻的 doing/agent）也照常算新一轮
    verdict=$(printf '%s' "$s0" | jq -r --argjson f "$flows" --arg at "$at" --arg me "$me" --arg H "$LABEL_PENDING_HUMAN" '
        .merged_pos as $mp | . as $S
        | [.labels[] | select(. as $l | ($f | index($l)) != null)
                     | select(. != $H or (($S.last[.] // {}).by // "") != $me)] as $on
        | [ $on[] as $l | (.last[$l] // null) as $x
            # 先后按事件在记录里的位置比（合并和挂标签常在同一秒）：排在「merged」事件之后 = 新一轮；没有 merged 事件时
            # 才按时间比，同一秒算判不了
            | if $x == null then "unknown"
              elif $mp != null then (if $x.pos > $mp then "new" else "old" end)
              elif ($x.at[:19]) > ($at[:19]) then "new" elif ($x.at[:19]) == ($at[:19]) then "unknown" else "old" end ]
        | if index("new") != null then "new" elif index("unknown") != null then "unknown" else "ok" end')
    case "$verdict" in
        new) log "  合并后交接：PR #$pr 合并之后又挂上了流程标签（新一轮），它的标签不动"
             mf_set '.prs[$p].pr_superseded = true' --arg p "$pr" || true; return 0 ;;
        unknown) log "  合并后交接：PR #$pr 有流程标签找不到加上它的事件（或缺时间），判不了，本轮不动"; return 1 ;;
        ok) ;;
        *) return 1 ;;
    esac
    plan=$(printf '%s' "$s0" | jq -c --arg D "$LABEL_DONE" --arg H "$LABEL_PENDING_HUMAN" --arg r "$rem" --argjson f "$flows" '.labels as $L
        | (if ($L | index($D)) == null then ["add:" + $D] else [] end)
        + (if $r == "true" and ($L | index($H)) == null then ["add:" + $H] else [] end)
        + [$L[] | select(. as $l | ($f | index($l)) != null and ($r != "true" or $l != $H)) | "del:" + .]')
    expect="$s0"
    for step in $(printf '%s' "$plan" | jq -r '.[] | @base64'); do
        step=$(printf '%s' "$step" | base64 -d); kind="${step%%:*}"; lab="${step#*:}"
        cur=$(mf_pr_state "$pr") && [ -n "$cur" ] || { log "  合并后交接：PR #$pr 写标签途中读不全，本轮停手"; return 1; }
        if ! mf_pr_state_same "$cur" "$expect" "$touched"; then
            log "  合并后交接：PR #$pr 的标签在两次写之间被人改了，本轮停手，下轮从头判"; return 1
        fi
        if [ "$kind" = add ]; then
            run_gh "合并后交接：PR #$pr 加 $lab" gh_write api -X POST "repos/$REPO/issues/$pr/labels" -f "labels[]=$lab" >/dev/null || return 1
            expect=$(printf '%s' "$expect" | jq -c --arg l "$lab" '.labels = (.labels + [$l] | unique | sort)')
        else
            if ! out=$(gh_write api -X DELETE "repos/$REPO/issues/$pr/labels/$(printf '%s' "$lab" | jq -sRr @uri)" 2>&1) \
               && ! printf '%s' "$out" | grep -q 'HTTP 404'; then
                log "  合并后交接：PR #$pr 摘 $lab 失败，下轮再试"; return 1
            fi
            expect=$(printf '%s' "$expect" | jq -c --arg l "$lab" '.labels = (.labels | map(select(. != $l)))')
        fi
        touched=$(printf '%s' "$touched" | jq -c --arg l "$lab" '. + [$l] | unique')
    done
    cur=$(mf_pr_state "$pr") && [ -n "$cur" ] || return 1
    mf_pr_state_same "$cur" "$expect" "$touched"
}
# 两份 PR 现状是不是同一个：身份、标签集合一样，没被这次写过的流程标签最后一次「加上」的事件也一样
mf_pr_state_same() {   # <现读> <期望> <这次写过的标签 JSON 数组>
    jq -en --argjson a "$1" --argjson b "$2" --argjson t "$3" '
        $a.merged == $b.merged and $a.ident == $b.ident and $a.labels == $b.labels
        and (($a.last | with_entries(select(.key as $k | ($t | index($k)) == null) | .value = .value.id))
             == ($b.last | with_entries(select(.key as $k | ($t | index($k)) == null) | .value = .value.id)))' >/dev/null 2>&1
}

mf_try_fail() {   # <目标> <原因>：一次真正尝试了读写却没成功的轮次（等清理的轮次不调它）
    local n="$1" why="$2" tries
    tries=$(mf_get '(.targets[$n].tries // 0) + 1' --arg n "$n")
    if [ "$tries" -ge "$MF_MAX_TRIES" ]; then
        mf_set '.targets[$n] += {tries: $t, failed: $w, failed_round: (.round // 0)} | .targets[$n].wake = false' --arg n "$n" --argjson t "$tries" --arg w "$why" || true
        log "⚠️ 合并后交接：#$n 连续 $tries 轮没交接成（${why}），先停下；有新 PR 合并或清理状态变化时再试"
    else
        mf_set '.targets[$n].tries = $t' --arg n "$n" --argjson t "$tries" || true
        log "  合并后交接：#$n 这一轮没交接成（${why}），下轮再试"
    fi
}

# ── T6–T8：交接一个目标 ──
mf_target_tick() {   # <目标> [兜底 PR]
    local n="$1" fb="${2:-}" c1 c2 fp v sent bf rc pr own fv labs
    # 做出这个 PR 的那一轮留下的 doing/agent：这一轮刚为这个 issue 做完合并清理（会话已收掉）、也确实没有会话，
    # 它就不是「新一轮」，先摘掉——和主干「清理成功后摘 doing/agent」同一时刻；之后的轮次里再出现的 doing/agent
    # 是人或 daemon 新开的一轮，交接照表 1 第 3 行不动标签
    if [ -z "$fb" ] && [ -n "${LABEL_AGENT_DOING:-}" ] && case "$MF_CLEANED_THIS_ROUND" in *" $n "*) true ;; *) false ;; esac \
       && labs=$(gh api "repos/$REPO/issues/$n" --jq '[.labels[].name]' 2>/dev/null) \
       && printf '%s' "$labs" | jq -e --arg D "$LABEL_AGENT_DOING" 'index($D) != null' >/dev/null 2>&1 \
       && ! session_alive "$(tmux_session_name "$n")"; then
        if run_gh "合并后交接：#$n 摘掉上一轮留下的 $LABEL_AGENT_DOING" \
            gh_write api -X DELETE "repos/$REPO/issues/$n/labels/$(printf '%s' "$LABEL_AGENT_DOING" | jq -sRr @uri)" >/dev/null; then
            log "  合并后交接：#$n 的 $LABEL_AGENT_DOING 没有对应的会话，按上一轮留下的摘掉"
        fi
    fi
    if ! c1=$(mf_target_conclude "$n" "$fb"); then mf_try_fail "$n" "读不到 #$n 的状态"; return 1; fi
    fp=$(printf '%s' "$c1" | jq -r .fp)
    if [ "$(mf_get '.targets[$n].fp // ""' --arg n "$n" | jq -r .)" != "$fp" ]; then
        mf_set '.targets[$n] = ((.targets[$n] // {}) + {v: ((.targets[$n].v // 0) + 1), fp: $f})' --arg n "$n" --arg f "$fp" || return 1
    fi
    v=$(mf_get '.targets[$n].v' --arg n "$n")
    # PR 正文写着关闭关键词、目标却还开着：GitHub 按关键词关 issue 有时晚于合并，最多等 5 轮再按「开着」交接
    # （不等就会先发一条「开着」的评论，关掉之后又发一条）；等的轮次不计入重试
    if [ "$(printf '%s' "$c1" | jq -r .state)" = open ] && [ -z "$fb" ] \
       && [ "$(mf_get '[.prs // {} | .[] | select(.target == $n and .handed == null and (.closes // false))] | length' --arg n "$n")" != 0 ] \
       && [ "$(mf_get '.targets[$n].close_waits // 0' --arg n "$n")" -lt 5 ]; then
        mf_set '.targets[$n].close_waits = ((.targets[$n].close_waits // 0) + 1)' --arg n "$n" || true
        log "  合并后交接：#$n 还开着，等 GitHub 随合并关掉它（PR 正文写着关闭关键词）"
        return 0
    fi
    # T7：评论
    sent=$(mf_get '.targets[$n].sent // ""' --arg n "$n" | jq -r .)
    if [ "$(printf '%s' "$c1" | jq -r .needs_comment)" = true ] && [ "$sent" != "$fp" ]; then
        rc=0; mf_comment_find "$n" "$fp" || rc=$?
        if [ "$rc" = 2 ]; then mf_try_fail "$n" "读不到 #$n 的评论"; return 1; fi
        if [ "$rc" = 1 ]; then
            if ! c2=$(mf_target_conclude "$n" "$fb") || [ "$(printf '%s' "$c2" | jq -c '{fp, basis}')" != "$(printf '%s' "$c1" | jq -c '{fp, basis}')" ]; then
                mf_try_fail "$n" "#$n 判定之后有变化"; return 1
            fi
            bf=$(mktemp) || return 1
            {
                printf '%s' "$c1" | jq -r .comment
                printf '\n%s\n' "$(autopilot_daemon_sig)"
                printf '<!-- cavil-loop:merge-followup target=%s v=%s covers=%s fp=%s -->\n' "$n" "$v" "$(printf '%s' "$c1" | jq -r '.covers | join(",")')" "$fp"
                printf '%s' "$c1" | jq -r 'if .ap != null then "<!-- cavil-loop:autopilot-merged pr=\(.ap.pr) head=\(.ap.head) -->" else empty end'
            } > "$bf"
            if ! run_gh "合并后交接：#$n 发清单评论（第 $v 版）" gh_write api -X POST "repos/$REPO/issues/$n/comments" -F "body=@$bf" >/dev/null; then
                rm -f "$bf"
                [ -z "$fb" ] || mf_set '.prs[$p].fb.comment = "unknown"' --arg p "$fb" || true
                mf_try_fail "$n" "#$n 的清单评论发不出去"; return 1
            fi
            rm -f "$bf"
            rc=0; mf_comment_find "$n" "$fp" || rc=$?
            if [ "$rc" != 0 ]; then
                [ -z "$fb" ] || mf_set '.prs[$p].fb.comment = "unknown"' --arg p "$fb" || true
                mf_try_fail "$n" "#$n 的清单评论发出后读不回来"; return 1
            fi
        fi
        mf_set '.targets[$n].sent = $f | (if $b != "" then .prs[$b].fb.comment = "yes" else . end)' \
            --arg n "$n" --arg f "$fp" --arg b "$fb" || return 1
        log "  合并后交接：#$n 的清单评论已确认（第 $v 版）"
    fi
    # T8：标签
    if [ "$(printf '%s' "$c1" | jq -r .kind)" = issue ]; then
        autopilot_state_set "${STATE_FILE:-$STATE_DIR/state.json}" '.handoff[$k] = ((.handoff[$k] // {}) + {issue: $n, closes: ($c == "true"), commented: true, body: "", mf: true})' \
            --arg k "mf$n" --arg n "$n" --arg c "$(printf '%s' "$c1" | jq -r .reminder)" || return 1
        rc=0; autopilot_merged_handoff "$n" "mf$n" || rc=$?
        # 没开托管的项目：交接记录用完就删，不在 state.json 里留下空的 .autopilot
        jq 'if (.autopilot.handoff // null) == {} then del(.autopilot.handoff) else . end | if .autopilot == {} then del(.autopilot) else . end' \
            "${STATE_FILE:-$STATE_DIR/state.json}" > "${STATE_FILE:-$STATE_DIR/state.json}.mf" && mv "${STATE_FILE:-$STATE_DIR/state.json}.mf" "${STATE_FILE:-$STATE_DIR/state.json}"
        if [ "$rc" != 0 ]; then mf_try_fail "$n" "#$n 的标签没收敛"; return 1; fi
        [ "$(printf '%s' "$c1" | jq -r .state)" = open ] && mf_set '.targets[$n].human_added = true' --arg n "$n" || true
    else
        # 目标就是 PR 本身：Done，有待办（或兜底）时另挂 pending/human；读回确认才算写成
        if ! mf_pr_labels "$n" "$(printf '%s' "$c1" | jq -r .reminder)"; then mf_try_fail "$n" "PR #$n 的标签没写成"; return 1; fi
        mf_set '.prs[$p].pr_labeled = true' --arg p "$n" || return 1
        if [ -n "$fb" ]; then
            # 兜底送达：上面已确认兜底评论，PR 上现读到 pending/human 才写「是」（新一轮的流程标签挡着、没挂上时不算）
            if gh api "repos/$REPO/issues/$n" --jq '[.labels[].name]' 2>/dev/null | jq -e --arg H "$LABEL_PENDING_HUMAN" 'index($H) != null' >/dev/null 2>&1; then
                mf_set '.prs[$p].fb.sent = true' --arg p "$fb" || return 1
                log "  合并后交接：PR #$fb 的兜底提醒已送达"
            else
                mf_try_fail "$n" "PR #$n 上没挂上 $LABEL_PENDING_HUMAN"; return 1
            fi
        fi
    fi
    # 每个合并 PR 自己的 Done（不是目标的那些）：读回确认写成之后才往下走；没写成这一轮停在这里，
    # 下一轮评论不重发（已确认的指纹），只补标签
    for pr in $(printf '%s' "$c1" | jq -r '.covers[]'); do
        [ "$pr" != "$n" ] || continue
        if [ "$(mf_get '.prs[$p].pr_labeled // false' --arg p "$pr")" != true ]; then
            if ! mf_pr_labels "$pr" false; then mf_try_fail "$n" "PR #$pr 的标签没写成"; return 1; fi
            mf_set '.prs[$p].pr_labeled = true' --arg p "$pr" || return 1
        fi
    done
    # 收敛：目标记录标已收敛，覆盖的 PR 记录标已交接
    mf_set '.targets[$n] += {converged: $f, tries: 0, wake: false, close_waits: 0} | del(.targets[$n].failed)
            | reduce ($c[] | tostring) as $p (.; if .prs[$p] != null then .prs[$p].handed = $v else . end)' \
        --arg n "$n" --arg f "$fp" --argjson v "$v" --argjson c "$(printf '%s' "$c1" | jq -c .covers)" || return 1
    [ -n "$fb" ] || log "  合并后交接：#$n 交接完成（第 $v 版，覆盖 PR $(printf '%s' "$c1" | jq -r '.covers | map("#\(.)") | join(" ")')）"
    for pr in $(printf '%s' "$c1" | jq -r '.covers[]'); do
        # 合并清理关着时主干不发机器人的结果通知（发送那一段也在清理开着时才跑），这里也不入队
        if requester_bot_enabled && [ "${AUTO_CLEANUP_ON_MERGE:-true}" != false ] \
           && [ "$(mf_get '.prs[$p].notified // ""' --arg p "$pr" | jq -r .)" = "" ]; then
            requester_bot_done_enqueue "$pr" merged "${STATE_FILE:-$STATE_DIR/state.json}"
            mf_set '.prs[$p].notified = "queued"' --arg p "$pr" || true
        fi
    done
    return 0
}

# 每轮：迁移 → 补读 → 逐个目标交接。<列表读到了> = 本轮合并发现成功（1）/ 列表没读全（0）
mf_handover_tick() {
    local n fb round
    # 没有任何记录、也没有要接管的旧条目：什么都不写（没合并过 PR 的项目 state.json 一字不变）
    if [ "$(jq -r '((.merge_followup.prs // {}) | length) + ((.merged_label_queue // {}) | length)
            + ([(.requester_bot_done_queue // {})[] | select(.kind == "merged" and (.v // 0) < 2)] | length)
            + ([(.autopilot.handoff // {})[] | select((.mf // false) == false)] | length)' "${STATE_FILE:-$STATE_DIR/state.json}" 2>/dev/null)" = 0 ]; then
        return 0
    fi
    mf_set '.round = ((.round // 0) + 1)' || return 0
    round=$(mf_get '.round // 0')
    mf_migrate
    mf_reread_tick
    # 「交接失败」的目标只在被唤醒时回到 T6、重新计数：有新 PR 并进来（发现 / 补读到正文）、或覆盖的 PR 清理状态变了。
    # 没有这些就一直停着，不会因为它自己那几条还没交接的记录每轮复活
    mf_set 'reduce ((.targets // {}) | to_entries[] | select((.value.failed // null) != null and (.value.wake // false)) | .key) as $t
              (.; .targets[$t] |= (del(.failed) | .tries = 0))' || true
    for n in $(mf_get '(.prs // {}) as $P | (.targets // {}) as $T
            | [$P | to_entries[] | select((.value.found // false) and .value.target != null) | .value.target] | unique
            | map(select(. as $t | (($T[$t].failed // null) == null or ($T[$t].wake // false))
                and ([$P | to_entries[] | select(.value.target == $t and (.value.found // false))] as $R
                     | (any($R[]; .value.handed == null) or ($T[$t].wake // false) or (($T[$t].fp // "") != ($T[$t].converged // "")))))) | .[]' | tr -d '"'); do
        [[ "$n" =~ ^[0-9]+$ ]] || continue
        if stuck_frozen "$n"; then stuck_skip_note "合并后的交接" "$n"; continue; fi
        if issue_halted_round "$n"; then continue; fi
        if [ "$(mf_get '[.prs // {} | to_entries[] | select(.value.target == $n and (.value.found // false) and .value.cleanup == "retry")] | length' --arg n "$n")" != 0 ]; then
            log "  合并后交接：#$n 等覆盖的 PR 本机清理成功后再交接（$(mf_get '[.prs // {} | to_entries[] | select(.value.target == $n and .value.cleanup == "retry") | "#" + .key] | join(" ")' --arg n "$n" | jq -r .)）"
            continue
        fi
        mf_target_tick "$n" || true
    done
    # 兜底目标（正文读不到、认不出目标的 PR 本身）：送达之前一直不是终态；失败后每 30 轮再试一次
    for fb in $(mf_get '[.prs // {} | to_entries[] | select(.value.fb != null and (.value.fb.sent // false) == false and (.value.fb.superseded // false) == false) | .key] | .[]' | tr -d '"'); do
        if [ -n "$(mf_get '.targets[$p].failed // ""' --arg p "$fb" | jq -r .)" ]; then
            [ $(( round % 30 )) -eq 0 ] || continue
            mf_set '.targets[$p] |= (del(.failed) | .tries = 0)' --arg p "$fb" || continue
        fi
        mf_target_tick "$fb" "$fb" || true
    done
}

# ── T9 / T10：机器人结果评论的通知依据（一个函数，发之前现算两次、逐字一致才发）──
# stdout：依据 JSON（同时是 notice 的输入）；return 1 = 不成立（表 2 第 0 行：不发，下轮再判）
mf_notice_basis() {   # <PR> [来源 issue]
    local pr="$1" origin="${2:-}" rec t fb c conv guard d rc=0 oj='null'
    # 来源 issue（机器人的需求，可能不是交接目标）：状态和完整标签也进依据，发评论前、写等待标签前都现读比对
    if [ -n "$origin" ]; then
        # 来源关联也现读重判（和发通知前那次是同一个判定函数）：PR 现在指向的来源不是这一个 → 不成立
        local item orc=0
        item=$(gh api "repos/$REPO/issues/$pr" 2>/dev/null) || return 1
        requester_bot_item_origin "$pr" "$item" >/dev/null 2>&1 || orc=$?
        [ "$orc" = 0 ] && [ "${REQUESTER_BOT_ORIGIN:-}" = "$origin" ] || return 1
        oj=$(gh api "repos/$REPO/issues/$origin" --jq '{n: .number, state: (.state // ""), labels: ([.labels[].name] | sort)}' 2>/dev/null) || return 1
        printf '%s' "$oj" | jq -e '.state != ""' >/dev/null 2>&1 || return 1
    fi
    [ "$MF_DISCOVERED" = 1 ] || return 1
    rec=$(mf_get '.prs[$p] // null | if . == null then null else del(.ap) end' --arg p "$pr"); [ -n "$rec" ] && [ "$rec" != null ] || return 1
    [ "$(printf '%s' "$rec" | jq -r '.handed // "null"')" != null ] || return 1
    t=$(printf '%s' "$rec" | jq -r '.target // ""'); fb=""
    if [ -z "$t" ]; then t="$pr"; fb="$pr"; fi
    c=$(mf_target_conclude "$t" "$fb") || return 1
    conv=$(mf_get '.targets[$t].converged // ""' --arg t "$t" | jq -r .)
    [ -n "$conv" ] && [ "$(printf '%s' "$c" | jq -r .fp)" = "$conv" ] || return 1
    guard=$(mf_get --arg at "$(printf '%s' "$rec" | jq -r '.merged_at // ""')" \
        '[.prs // {} | .[] | select(.body == "pending" and .owner == "unknown" and (.fb.sent // false) == false and (.merged_at // "") <= $at)] | length > 0')
    d=$(mktemp -d) || return 1
    printf '%s' "$rec" > "$d/r"; printf '%s' "$c" | jq -c '{fp, state, followups, fu, basis}' > "$d/c" || rc=1
    [ "$rc" = 0 ] && jq -cn --arg pr "$pr" --argjson o "$oj" --slurpfile r "$d/r" --slurpfile c "$d/c" --argjson g "${guard:-true}" --arg v "$(mf_get '.targets[$t].v // 0' --arg t "$t")" '
        $r[0] as $r | $c[0] as $c
        | ($c.fu | map(select(.pr == $pr)) | .[0].ended // null) as $own_end
        | {pr: $pr, title: ($r.title // ""), base: ($r.base // ""), sha: ($r.sha // ""), merged_at: ($r.merged_at // ""),
           conc: {fp: $c.fp, followups: $c.followups, fu: $c.fu}, own_s: $r.s, own_ended: ($r.ended // $own_end // "no"),
           guard: $g, target_state: $c.state, maintainer_closed: (($r.ended // "") == "yes"), version: $v,
           target_basis: $c.basis, origin: $o}' || rc=1
    rm -rf "$d"
    return "$rc"
}
