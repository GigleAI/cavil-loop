#!/usr/bin/env bash
# 给一个流程标签改名：GitHub 上的标签、配置文件那一行一起改（GitHub#569）。桌面客户端的改名框调用它，人也能直接跑。
#
# 用法（<项目> 是本机项目登记的名字，和 project-config.sh 一样）：
#   bash scripts/label-rename.sh <项目> check    --field <设置名> --from <旧名> --to <新名> [--follow --label-id <编号>] [--others-stopped]
#   bash scripts/label-rename.sh <项目> rename   --field <设置名> --from <旧名> --to <新名> --rev <配置指纹> --others-stopped
#   bash scripts/label-rename.sh <项目> follow   --field <设置名> --from <旧名> --to <新名> --label-id <编号> --rev <配置指纹>
#   bash scripts/label-rename.sh <项目> continue      # 只读 GitHub：请求没回音后「再查一次」；配置没改成时再改一次配置
#   bash scripts/label-rename.sh <项目> resend        # 请求没回音后，再发一次同样的改名
#   bash scripts/label-rename.sh <项目> finish (--client-saved | --no-client)   # 客户端存好自己的标签名后收尾；人在终端跑写 --no-client
#   bash scripts/label-rename.sh <项目> undo          # 只在 GitHub 确定没改时可用：删掉暂停记录，什么都不改
#   bash scripts/label-rename.sh <项目> abandon --yes # 人已手动把三处处理好：删掉暂停记录（只在人明确要求时用）
#   bash scripts/label-rename.sh <项目> watch-end     # 结束改名后的「每轮核对标签」
#   bash scripts/label-rename.sh <项目> status
#
# 最后几行固定是机器可读的：GITHUB= CONFIG= STEP= PAUSED= WATCH= LABEL_ID= DETAIL=<JSON> RESULT=<词>
#   RESULT：ok（check 通过）/ awaiting_client（GitHub 和配置都改好，等客户端存好后 finish）/ done / no_answer
#   （GitHub 改名请求没回音：只能 continue 或 resend）/ partial（GitHub 已改、配置没改成：continue 重试）/
#   refused（没做：检查没过、GitHub 拒绝、条件不对）/ busy（拿不到轮询锁）/ unknown（读不到，什么都没写）
#
# 规则（docs/operations.md「Rename a flow label」）：
#   · 全程在本项目的轮询锁里做（poll_lock_reexec：锁里重新起自己，配置在锁里加载）；
#   · 动 GitHub 之前先写「改名进行中」记录（$STATE_DIR/label-rename.json）。有这个记录时，轮询每一轮、
#     手动跑的派工 / 叫醒 / CI 报告都不动手（_lib.sh label_rename_gate），直到 finish / undo / abandon 删掉它；
#   · GitHub 改名请求没回音：不当成「没改」。只能 continue（只读）或 resend（往前走）；没有 undo。做完后进入
#     「每轮核对标签」（label-watch.json），轮询每轮按标签的固定编号核对名字，直到人 watch-end；
#   · 配置那一行用 project-config.sh set --label-rename 写（同一套保存规则），它要求有对得上的改名记录。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=_names.sh
source "$SCRIPT_DIR/_names.sh"

ORIG_ARGS=("$@")
KEY="${1:-}"; CMD="${2:-}"
usage() { sed -n '2,13p' "$0"; exit 2; }
[ -n "$KEY" ] && [ -n "$CMD" ] || usage
shift 2
FIELD=""; FROM=""; TO=""; REV=""; LABEL_ID=""; FOLLOW=""; OTHERS_STOPPED=""; CLIENT=""; YES=""
while [ $# -gt 0 ]; do
    case "$1" in
        --field) FIELD="${2:-}"; shift 2 2>/dev/null || shift ;;
        --from) FROM="${2:-}"; shift 2 2>/dev/null || shift ;;
        --to) TO="${2:-}"; shift 2 2>/dev/null || shift ;;
        --rev) REV="${2:-}"; shift 2 2>/dev/null || shift ;;
        --label-id) LABEL_ID="${2:-}"; shift 2 2>/dev/null || shift ;;
        --follow) FOLLOW=1; shift ;;
        --others-stopped) OTHERS_STOPPED=1; shift ;;
        --client-saved) CLIENT=saved; shift ;;
        --no-client) CLIENT=none; shift ;;
        --yes) YES=1; shift ;;
        -h|--help) usage ;;
        *) echo "不认识的参数：$1"; exit 2 ;;
    esac
done
case "$CMD" in check|rename|follow|continue|resend|finish|undo|abandon|watch-end|status) ;; *) usage ;; esac
if [ -z "$KEY" ] || ! [[ "$KEY" =~ ^[A-Za-z0-9_.-]+$ ]] || [ "$KEY" = deploy ]; then
    echo "项目名不合规（只能含 [A-Za-z0-9_.-]）"; exit 2
fi

# ── 找到项目的配置文件（和 project-config.sh 一样只认本机登记），加载 ──
ENV_FILE="$(cavil_project_env "$KEY")"
[ -f "$ENV_FILE" ] || { echo "本机没有接入项目 ${KEY}（找不到 ${ENV_FILE}）"; exit 2; }
CONFIG="$(sed -n 's/^CODING_AGENT_CONFIG=//p' "$ENV_FILE" | tail -1)"
[ -n "$CONFIG" ] && [ -f "$CONFIG" ] || { echo "项目 $KEY 的配置文件找不到：${CONFIG:-（登记里没写）}"; exit 2; }
export CODING_AGENT_CONFIG="$CONFIG"
# shellcheck source=_lib.sh
source "$SCRIPT_DIR/_lib.sh"
# 注意：source _lib.sh 之后本进程的 stderr 是 /dev/null，下面给人看的话都走 stdout。
STATE_FILE="$STATE_DIR/state.json"

# 只读的 check / status 不拿锁；其余都在本项目的轮询锁里重新起自己（锁里加载的配置，和锁里的读写是同一版）
case "$CMD" in
    check|status) ;;
    *) POLL_LOCK_REEXEC_WAIT_SECS="${LABEL_RENAME_LOCK_WAIT:-60}"
       poll_lock_reexec "${BASH_SOURCE[0]}" ${ORIG_ARGS[@]+"${ORIG_ARGS[@]}"} ;;
esac

REC="$(label_rename_record_file)"
WATCH="$(label_watch_file)"
CHECKS=()          # 每项一行 JSON：{id, ok: true/false/null, text}
R_GITHUB=unknown; R_CONFIG=unknown; R_STEP=""; R_LABEL_ID=""; MESSAGE=""

out() {   # <RESULT> <退出码>
    local paused=no watch=no detail checks rec=null
    { [ -e "$REC" ] || [ -L "$REC" ]; } && paused=yes
    { [ -e "$WATCH" ] || [ -L "$WATCH" ]; } && watch=yes
    if [ "$paused" = yes ]; then rec="$(jq -c . "$REC" 2>/dev/null || echo '"unreadable"')"; [ -n "$rec" ] || rec='"unreadable"'; fi
    if [ "${#CHECKS[@]}" -gt 0 ]; then checks="$(printf '%s\n' "${CHECKS[@]}" | jq -cs .)"; else checks='[]'; fi
    detail="$(jq -cn --argjson c "$checks" --argjson r "$rec" --arg m "$MESSAGE" '{checks:$c, record:$r, message:$m}')"
    [ -z "$MESSAGE" ] || printf '%s\n' "$MESSAGE"
    printf 'GITHUB=%s\nCONFIG=%s\nSTEP=%s\nPAUSED=%s\nWATCH=%s\nLABEL_ID=%s\nDETAIL=%s\nRESULT=%s\n' \
        "$R_GITHUB" "$R_CONFIG" "$R_STEP" "$paused" "$watch" "$R_LABEL_ID" "$detail" "$1"
    exit "$2"
}
chk() {   # <id> <true|false|null> <说明>
    CHECKS+=("$(jq -cn --arg id "$1" --argjson ok "$2" --arg t "$3" '{id:$id, ok:$ok, text:$t}')")
}
checks_ok() {
    [ "${#CHECKS[@]}" -gt 0 ] || return 1
    [ "$(printf '%s\n' "${CHECKS[@]}" | jq -s 'all(.ok == true)')" = true ]
}
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
uri() { printf '%s' "$1" | jq -sRr @uri; }

# ── 记录 ──
rec_read() {   # → R_* 全局；读不了返回 1
    local line
    line="$(jq -er '[.mode, .field, .from, .to, (.label_id|tostring), .step, (.unanswered|tostring), (.sent|tostring)] | @tsv' "$REC" 2>/dev/null)" || return 1
    IFS=$'\t' read -r RM RF RFROM RTO RID RSTEP RUNANS RSENT <<< "$line"
    case "$RM" in rename|follow) ;; *) return 1 ;; esac
    case "$RSTEP" in github|config|client) ;; *) return 1 ;; esac
    label_rename_field_ok "$RF" && [[ "$RID" =~ ^[0-9]+$ ]] && [ -n "$RFROM" ] && [ -n "$RTO" ] || return 1
    R_STEP="$RSTEP"; R_LABEL_ID="$RID"
}
rec_write() {   # <JSON>：写临时文件再改名；写不了返回 1
    local tmp="$REC.tmp.$$"
    printf '%s\n' "$1" > "$tmp" && mv -f "$tmp" "$REC"
}
rec_set() {   # <jq 表达式>
    local j
    j="$(jq -c "$1" "$REC" 2>/dev/null)" && [ -n "$j" ] && rec_write "$j"
}

# ── GitHub 上的现状：按编号找名字、按名字找编号 ──
LABELS=""
labels_read() { LABELS="$(label_list_read)"; }
name_of_id() { printf '%s\n' "$LABELS" | awk -F'\t' -v id="$1" '$1 == id { print $2; exit }'; }
id_of_name() { printf '%s\n' "$LABELS" | awk -F'\t' -v n="$1" '$2 == n { print $1; exit }'; }
id_of_name_ci() {   # 不分大小写（GitHub 的标签名不分大小写唯一）
    local want; want="$(lower "$1")"
    printf '%s\n' "$LABELS" | awk -F'\t' -v w="$want" 'tolower($2) == w { print $1; exit }'
}
# 现状：new（编号对应新名、没有叫旧名的标签）/ old（编号对应旧名）/ other（都不是：说不清）；读不全返回 1
github_state() {   # <编号> <旧名> <新名>
    labels_read || return 1
    local n; n="$(name_of_id "$1")"
    if [ "$n" = "$3" ] && [ -z "$(id_of_name_ci "$2")" ]; then printf 'new'
    elif [ "$n" = "$2" ]; then printf 'old'
    else printf 'other'; fi
}
open_count() {   # <标签名> → 挂着它的打开条目数（issue 和 PR 一起）；读不了返回 1
    gh api "repos/$REPO/issues?state=open&per_page=1&labels=$(uri "$1")" --jq 'length' 2>/dev/null
}

# 配置里的现状：project-config.sh get（同一套「能不能改这一行」的判断）
PC_JSON=""
pc_get() { PC_JSON="$(bash "$SCRIPT_DIR/project-config.sh" get "$KEY" 2>/dev/null)" && [ "$(printf '%s' "$PC_JSON" | jq -r .state 2>/dev/null)" = ok ]; }
pc_field() { printf '%s' "$PC_JSON" | jq -r --arg k "$1" --arg p "$2" '.fields[] | select(.name == $k) | getpath($p | split("."))' 2>/dev/null; }

# ── 检查（check / rename / follow 共用）──
run_checks() {   # <rename|follow>
    local mode="$1" k v el cur n i doing
    CHECKS=()
    if ! label_rename_field_ok "$FIELD"; then chk field false "${FIELD:-（没给）} 不是能在这里改名的流程标签"; return 0; fi
    if label_rename_name_ok "$TO" && [ "$TO" != "$FROM" ]; then chk name true "新名字 $TO 可以用"
    else chk name false "新名字只能用字母、数字和 . _ : / @ + -，1–50 个字符，并且和旧名字不同"; fi
    if [ -e "$REC" ] || [ -L "$REC" ]; then chk pending false "本项目有一次改名还没做完，先把它做完或退回"; fi
    cur="$(label_field_value "$FIELD")"
    if [ "$cur" = "$FROM" ] && [ -n "$FROM" ]; then chk config_value true "配置里 $FIELD 是 $FROM"
    else chk config_value false "配置里 $FIELD 现在是「${cur}」，不是「${FROM}」（重新打开配置窗口再试）"; fi
    if ! pc_get; then chk config_line null "读不了配置文件，判断不了这一行能不能改"
    elif [ "$(pc_field "$FIELD" rename.ok)" = true ]; then chk config_line true "配置文件里这一行可以改"
    else chk config_line false "$(pc_field "$FIELD" rename.reason)"; fi
    # 其他设置没用到新旧两个名字
    el=""
    for k in $LABEL_RENAME_FIELDS; do
        [ "$k" != "$FIELD" ] || continue
        v="$(label_field_value "$k" || true)"
        [ -n "$v" ] || continue
        if [ "$(lower "$v")" = "$(lower "$FROM")" ] || [ "$(lower "$v")" = "$(lower "$TO")" ]; then el="$el $k"; fi
    done
    for k in $LABEL_RENAME_LIST_FIELDS; do
        v="${!k-}"
        while IFS= read -r n; do
            n="$(printf '%s' "$n" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
            [ -n "$n" ] || continue
            if [ "$(lower "$n")" = "$(lower "$FROM")" ] || [ "$(lower "$n")" = "$(lower "$TO")" ]; then el="$el $k"; break; fi
        done < <(printf '%s\n' "$v" | tr ',' '\n')
    done
    if [ -z "$el" ]; then chk other_settings true "配置里别的设置没用到这两个名字"
    else chk other_settings false "配置里这些设置也用到了旧名字或新名字，先用编辑器改它们：${el# }"; fi
    # GitHub 上的标签
    if ! labels_read; then chk labels null "读不全仓库的标签列表"; return 0; fi
    if [ "$mode" = rename ]; then
        i="$(id_of_name "$FROM")"
        if [ -n "$i" ]; then chk old_label true "仓库里有标签 ${FROM}（编号 ${i}）"; R_LABEL_ID="$i"
        else chk old_label false "仓库里没有名字正好是「${FROM}」的标签"; fi
        n="$(id_of_name_ci "$TO")"
        if [ -z "$n" ] || [ "$n" = "$i" ]; then chk new_free true "仓库里没有别的标签叫 $TO"
        else chk new_free false "仓库里已经有标签叫「$(name_of_id "$n")」（标签名不分大小写）"; fi
        if doing="$(open_count "$LABEL_AGENT_DOING")"; then
            if [ "$doing" = 0 ]; then chk no_worker true "没有条目挂着 $LABEL_AGENT_DOING"
            else chk no_worker false "有条目挂着 ${LABEL_AGENT_DOING}（有 worker 在干活），等它们交出去再改"; fi
        else chk no_worker null "读不了挂着 $LABEL_AGENT_DOING 的条目"; fi
        case " $LABEL_RENAME_HISTORY_FIELDS " in *" $FIELD "*)
            if n="$(open_count "$FROM")"; then
                if [ "$n" = 0 ]; then chk history true "没有打开的条目挂着 $FROM"
                else chk history false "有打开的条目挂着 ${FROM}；这个标签按添加记录判断，GitHub 改名后旧记录记哪个名字没核实过，先等这些条目处理完"; fi
            else chk history null "读不了挂着 $FROM 的条目"; fi ;;
        esac
        if [ ! -f "$STATE_FILE" ]; then chk not_frozen true "没有被卡住检测停下的条目"
        else
            stuck_frozen_scan
            if [ "$STUCK_FZ" = none ]; then chk not_frozen true "没有被卡住检测停下的条目"
            else chk not_frozen false "有被卡住检测停下的条目（${STUCK_FZ}），先处理它们"; fi
        fi
        if [ "$OTHERS_STOPPED" = 1 ]; then chk others_stopped true "已确认没有别的机器在轮询本仓库（或已经停掉）"
        else chk others_stopped false "要先确认没有别的机器在轮询本仓库（或已经停掉）"; fi
    else
        if [[ "$LABEL_ID" =~ ^[0-9]+$ ]]; then
            R_LABEL_ID="$LABEL_ID"
            n="$(name_of_id "$LABEL_ID")"
            if [ "$n" = "$TO" ]; then chk followed true "仓库里编号 $LABEL_ID 的标签现在叫 $TO"
            else chk followed false "仓库里编号 $LABEL_ID 的标签现在叫「${n:-（不存在）}」，不是 $TO"; fi
        else chk followed false "改名凭据里没有标签编号"; fi
        if [ -z "$(id_of_name_ci "$FROM")" ]; then chk old_gone true "仓库里已经没有 $FROM"
        else chk old_gone false "仓库里还有标签叫 ${FROM}，另一台的改名可能还没做完"; fi
    fi
}

# ── 配置那一步：project-config.sh 同一套保存规则 ──
config_step() {   # <field> <from> <to>：改成 → 0；R_CONFIG / MESSAGE 写清楚
    local rev res rc=0
    if [ "$(label_field_value "$1")" = "$3" ]; then R_CONFIG=new; return 0; fi
    if ! pc_get; then R_CONFIG=old; MESSAGE="读不了配置文件，配置没改"; return 1; fi
    rev="$(printf '%s' "$PC_JSON" | jq -r .rev)"
    res="$(jq -cn --arg k "$1" --arg v "$3" '{($k):$v}' | bash "$SCRIPT_DIR/project-config.sh" set "$KEY" --rev "$rev" --label-rename 2>&1)" || rc=$?
    case "$(printf '%s\n' "$res" | sed -n 's/^RESULT=//p' | tail -1)" in
        saved) R_CONFIG=new; return 0 ;;
        *) R_CONFIG=old; MESSAGE="配置没改成：$(printf '%s\n' "$res" | grep -v '^\(DETAIL\|RESULT\)=' | head -3 | tr '\n' ' ')"; return 1 ;;
    esac
}

# GitHub 改名请求：answered（改成了）/ refused（GitHub 明确拒绝，没改）/ noanswer（不知道）
GH_OUT=""; PATCH_RESULT=""
patch_label() {   # <旧名> <新名> → PATCH_RESULT = answered / refused / noanswer，GH_OUT 留 gh 的话
    local rc=0
    GH_OUT="$(gh_write api -X PATCH "repos/$REPO/labels/$(uri "$1")" -f new_name="$2" --jq .name 2>&1)" || rc=$?
    if [ "$rc" = 0 ] && [ "$(printf '%s\n' "$GH_OUT" | tail -1)" = "$2" ]; then PATCH_RESULT=answered
    elif [ "$rc" != 0 ] && printf '%s' "$GH_OUT" | grep -qE 'HTTP 4[0-9][0-9]'; then PATCH_RESULT=refused
    else PATCH_RESULT=noanswer; fi
}

# 从 GitHub 那一步往后走（rename / continue / resend 共用）
after_github_new() {
    rec_set '.step = "config"' || { MESSAGE="写不了改名记录，停在这里（${REC}）"; out unknown 1; }
    R_GITHUB=new; R_STEP=config
    if ! config_step "$RF" "$RFROM" "$RTO"; then out partial 1; fi
    rec_set '.step = "client"' || { MESSAGE="写不了改名记录，停在这里（${REC}）"; out unknown 1; }
    R_STEP=client
    MESSAGE="GitHub 上的标签和配置都已是 ${RTO}；客户端存好自己的标签名后运行 finish（终端里：finish --no-client）"
    out awaiting_client 0
}
send_and_continue() {
    rec_set '.sent = true' || { MESSAGE="写不了改名记录，什么都没发（${REC}）"; out unknown 1; }
    patch_label "$RFROM" "$RTO"
    case "$PATCH_RESULT" in
        answered) after_github_new ;;
        refused)
            if [ "$RUNANS" = true ]; then
                # 之前有过没回音的请求：这次被拒不能证明 GitHub 没改，照没回音处理
                R_GITHUB=unknown; R_STEP=github
                MESSAGE="GitHub 拒绝了这次改名（$(printf '%s' "$GH_OUT" | tail -1)）；之前有过没回音的请求，只能再查一次"
                out no_answer 1
            fi
            rm -f "$REC"; R_GITHUB=old; R_CONFIG=old; R_STEP=""
            MESSAGE="GitHub 拒绝了改名，什么都没改：$(printf '%s' "$GH_OUT" | tail -1)"
            out refused 1 ;;
        *)
            rec_set '.unanswered = true' || true
            RUNANS=true; R_STEP=github
            local s
            if s="$(github_state "$RID" "$RFROM" "$RTO")" && [ "$s" = new ]; then after_github_new; fi
            R_GITHUB=unknown
            MESSAGE="GitHub 改名请求没有回音，不知道改没改：只能再查一次（continue）或重发（resend），本项目暂停中"
            out no_answer 1 ;;
    esac
}

case "$CMD" in
status)
    if [ -e "$REC" ] || [ -L "$REC" ]; then
        if rec_read; then MESSAGE="改名进行中：$RF $RFROM → ${RTO}，停在 $RSTEP"; else MESSAGE="改名记录读不了：$REC"; fi
    fi
    out ok 0 ;;

check)
    if [ "$FOLLOW" = 1 ]; then run_checks follow; else run_checks rename; fi
    if checks_ok; then out ok 0; fi
    out refused 1 ;;

rename|follow)
    if [ "$CMD" = follow ]; then run_checks follow; else run_checks rename; fi
    checks_ok || { MESSAGE="检查没过，什么都没改"; out refused 1; }
    now_rev="$(cfg_rev_of "$CONFIG_REAL" "$CONFIG_REAL" || true)"
    if [ -z "$REV" ] || [ "$REV" != "$now_rev" ]; then
        MESSAGE="配置文件在打开窗口之后被改过，什么都没改（重新打开后再试）"; out refused 1
    fi
    rec_write "$(jq -cn --arg m "$CMD" --arg f "$FIELD" --arg a "$FROM" --arg b "$TO" --argjson id "$R_LABEL_ID" \
        --arg h "$(hostname 2>/dev/null || echo unknown)" --argjson t "$(date +%s)" \
        '{mode:$m, field:$f, from:$a, to:$b, label_id:$id, step:(if $m == "follow" then "config" else "github" end),
          sent:false, unanswered:false, started:$t, host:$h}')" \
        || { MESSAGE="写不了改名记录（${REC}），什么都没改"; out unknown 1; }
    rec_read || { MESSAGE="刚写的改名记录读不回来（${REC}）"; out unknown 1; }
    R_CONFIG=old
    if [ "$CMD" = follow ]; then R_GITHUB=new; after_github_new; fi
    R_GITHUB=old
    send_and_continue ;;

continue|resend)
    { [ -e "$REC" ] || [ -L "$REC" ]; } || { MESSAGE="没有进行中的改名"; R_GITHUB=unknown; out refused 1; }
    rec_read || { MESSAGE="改名记录读不了（${REC}），什么都没改"; out unknown 1; }
    case "$RSTEP" in
        client) R_GITHUB=new; R_CONFIG=new; MESSAGE="GitHub 和配置都已改好，等客户端存好后 finish"; out awaiting_client 0 ;;
        config) R_GITHUB=new; after_github_new ;;
    esac
    # 停在 GitHub 那一步
    if ! s="$(github_state "$RID" "$RFROM" "$RTO")"; then MESSAGE="读不全仓库的标签列表，什么都没改"; out unknown 1; fi
    case "$s" in
        new) after_github_new ;;
        old)
            R_GITHUB=old
            # 发出去之后没记下结果（进程在请求中途被杀）：和没回音一样，那个请求以后仍可能生效
            if [ "$RSENT" = true ] && [ "$RUNANS" != true ]; then
                rec_set '.unanswered = true' || { MESSAGE="写不了改名记录（${REC}），什么都没改"; out unknown 1; }
                RUNANS=true
            fi
            if [ "$CMD" = resend ]; then send_and_continue; fi
            if [ "$RUNANS" = true ]; then
                MESSAGE="GitHub 上编号 $RID 的标签现在仍叫 ${RFROM}；之前的请求以后仍可能生效，只能重发（resend）"
                out no_answer 1
            fi
            MESSAGE="GitHub 上还没改名；重发（resend）或退回（undo）"; out partial 1 ;;
        *)
            R_GITHUB=unknown
            MESSAGE="GitHub 上编号 $RID 的标签现在叫「$(name_of_id "$RID")」，既不是 $RFROM 也不是 ${RTO}（或另有叫 $RFROM 的标签）。什么都没改；手动处理好后用 abandon --yes"
            out unknown 1 ;;
    esac ;;

finish)
    { [ -e "$REC" ] || [ -L "$REC" ]; } || { MESSAGE="没有进行中的改名"; out refused 1; }
    rec_read || { MESSAGE="改名记录读不了（${REC}），什么都没改"; out unknown 1; }
    [ -n "$CLIENT" ] || { MESSAGE="finish 要写明 --client-saved（客户端已存好）或 --no-client（不改客户端）"; out refused 2; }
    [ "$RSTEP" = client ] || { MESSAGE="改名还停在 $RSTEP 这一步，不能收尾"; out refused 1; }
    if ! s="$(github_state "$RID" "$RFROM" "$RTO")"; then MESSAGE="读不全仓库的标签列表，没有收尾（本项目继续暂停）"; out unknown 1; fi
    if [ "$s" != new ]; then
        R_GITHUB=unknown; MESSAGE="GitHub 上编号 $RID 的标签现在叫「$(name_of_id "$RID")」，不是 ${RTO}，没有收尾"; out unknown 1
    fi
    R_GITHUB=new
    if [ "$(label_field_value "$RF")" != "$RTO" ]; then R_CONFIG=old; MESSAGE="配置里 $RF 不是 ${RTO}，没有收尾"; out unknown 1; fi
    R_CONFIG=new
    if [ "$RUNANS" = true ]; then
        jq -cn --arg f "$RF" --argjson id "$RID" --arg n "$RTO" --argjson t "$(date +%s)" '{field:$f, label_id:$id, name:$n, since:$t}' \
            > "$WATCH.tmp.$$" && mv -f "$WATCH.tmp.$$" "$WATCH" \
            || { MESSAGE="写不了标签核对记录（${WATCH}），没有收尾"; out unknown 1; }
    elif [ -e "$WATCH" ] && [ "$(jq -r '.label_id|tostring' "$WATCH" 2>/dev/null)" = "$RID" ]; then
        # 同一个标签之前在核对：跟着改成新名字（核对还在，人结束才结束）
        jq -c --arg f "$RF" --arg n "$RTO" '.field = $f | .name = $n' "$WATCH" > "$WATCH.tmp.$$" && mv -f "$WATCH.tmp.$$" "$WATCH" || true
    fi
    rm -f "$REC" || { MESSAGE="删不掉改名记录（${REC}）"; out unknown 1; }
    R_STEP=""
    MESSAGE="已改名：$RFROM → ${RTO}（${RF}）。本项目轮询恢复"
    [ "$RUNANS" != true ] || MESSAGE="${MESSAGE}；中途有过没回音的请求，之后每轮先核对标签，确认不需要后运行 watch-end"
    out done 0 ;;

undo)
    { [ -e "$REC" ] || [ -L "$REC" ]; } || { MESSAGE="没有进行中的改名"; out refused 1; }
    rec_read || { MESSAGE="改名记录读不了（${REC}），什么都没改"; out unknown 1; }
    if [ "$RM" = follow ]; then
        [ "$(label_field_value "$RF")" = "$RFROM" ] || { MESSAGE="配置已经改成 ${RTO}，跟进不能退回；运行 continue 做完"; out refused 1; }
        rm -f "$REC"; R_CONFIG=old; MESSAGE="已退回：没改任何东西"; out done 0
    fi
    if [ "$RSTEP" != github ] || [ "$RUNANS" = true ] || [ "$RSENT" = true ]; then
        MESSAGE="GitHub 上可能已经改了（或有请求没回音），不能退回；要回到旧名字，等做完后再改一次名"; out refused 1
    fi
    rm -f "$REC"; R_GITHUB=old; R_CONFIG=old; MESSAGE="已退回：没改任何东西"; out done 0 ;;

abandon)
    [ "$YES" = 1 ] || { MESSAGE="abandon 会直接删掉改名记录、恢复轮询，只在人已经手动把 GitHub 和配置处理好之后用；确认后加 --yes"; out refused 2; }
    if [ -e "$REC" ] || [ -L "$REC" ]; then
        MESSAGE="已删掉改名记录：$(cat "$REC" 2>/dev/null || echo 读不了)"
        rm -f "$REC"
    else MESSAGE="没有进行中的改名"; fi
    out done 0 ;;

watch-end)
    if [ -e "$WATCH" ] || [ -L "$WATCH" ]; then rm -f "$WATCH"; MESSAGE="已结束标签核对"; else MESSAGE="没有在核对标签"; fi
    out done 0 ;;
esac
