#!/usr/bin/env bash
# 轮询运行记录（GitHub#344）：每一轮自己写一条记录，出异常自己留一份快照。
#
# 给谁用：poll-entry.sh（第一行就留「已启动」）、agent-poll.sh（进度、记账、收尾）、
# poll-history.sh（只读查看）。_lib.sh 只在轻量检查里调一次 runlog_probe_note。
#
# 三条硬规则，改这里之前先读：
#   1. **只记不判**：轮询的任何判断都不读这些文件。这里出任何错都只是少记一条，
#      不改退出码、不挡轮询——所以对外的函数全是「子 shell + 吞错」，永远返回 0。
#   2. **每一轮只写自己的文件，不替别的轮次补写**。被强杀的那一轮只留下进度文件，由查看
#      命令对照进程列表现场显示（维护者在 #344 选的 A）。替别人「补交」要在几个文件之间
#      交接，方案复审连着四轮都没能收住中断窗口——别再加回来。
#   3. **记录里没有任意文本**：字段只有数字、固定词、过了格式校验的值。不存源码行、
#      BASH_COMMAND、命令输出、poll.log 正文、原始状态文件。写盘前再按令牌形状擦一遍兜底。
#
# 目录（项目内的都在 $STATE_DIR/runlog/ 下）：
#   inflight/<轮次>.json            进度：开始时间、当前步骤、走过的步骤
#   acct/<轮次>                     本轮记账：每次 gh 调用一行、轻量检查结果一行
#   rounds/<开始时间>-<轮次>.json   正式记录，退出时写一次
#   snapshots/<轮次>-<原因>.json    快照
#   $CAVIL_STATE_HOME/runlog/entry/<轮次>.json   入口记录（那时还不知道项目的状态目录）
#
# 容量协议（runlog_put，五个目录共用这一个函数）：
#   写前腾位（删到 上限-1 以内，腾不出就放弃这次新增）→ 写临时文件 → 改名 → 写后裁剪。
#   临时文件同样占名额。所以没有轮次在写时不超过上限，连续被杀也不会越积越多；只有 W 个
#   轮次恰好同时在写才会短暂到 上限-1+W。
#
# 只定义变量和函数，source 时不做任何 I/O。

# 被 poll-entry.sh / agent-poll.sh 在加载配置之前 source：那时只有 _names.sh 可用。
if [ -z "${CAVIL_STATE_HOME:-}" ]; then
    # shellcheck source=_names.sh
    source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_names.sh"
fi

RUNLOG_STAGE=""          # ""（没启用）/ early（配置还没加载）/ round（一轮进行中）/ off（配置里关了）
RUNLOG_ID=""
RUNLOG_DIR=""
RUNLOG_START=0
RUNLOG_STEP="start"
RUNLOG_STEP_T0=0
RUNLOG_STEPS=""
RUNLOG_SLOW_STEP=""
RUNLOG_OUTCOME=""
RUNLOG_LOCKED=0
RUNLOG_LOG_FROM=0
RUNLOG_CANDIDATES=0
RUNLOG_DISPATCH_OK=0
RUNLOG_DISPATCH_FAIL=0
RUNLOG_ERR_LINE=""
RUNLOG_ERR_SRC=""
RUNLOG_ERR_FUNC=""
RUNLOG_ENTRY_DIR="$CAVIL_STATE_HOME/runlog/entry"
RUNLOG_ACCT_MAX_BYTES=65536

# ── 测试专用的停顿点 ──
# CAVIL_RUNLOG_TEST_KILL_AT=<点>：走到这一点就把轮询进程强杀（模拟断电 / OOM）。
# CAVIL_RUNLOG_TEST_HOLD=<点>:<管道>：走到这一点先建 <管道>.at.<进程号>，再读管道等放行。
# 只有 tests/poll-runlog.test.sh 设它们；没设时这里是两次字符串比较。
_runlog_hook() {
    [ -n "${CAVIL_RUNLOG_TEST_KILL_AT:-}${CAVIL_RUNLOG_TEST_HOLD:-}" ] || return 0
    if [ "${CAVIL_RUNLOG_TEST_KILL_AT:-}" = "$1" ]; then
        kill -9 "$$"; kill -9 "$BASHPID"
    fi
    case "${CAVIL_RUNLOG_TEST_HOLD:-}" in
        "$1":*)
            local fifo="${CAVIL_RUNLOG_TEST_HOLD#"$1":}" _l
            : > "$fifo.at.$$"
            read -r _l < "$fifo" || true ;;
    esac
    return 0
}

_runlog_now() { printf '%(%s)T' -1; }

# 正整数配置值：不合法就用默认值。
_runlog_int() {   # <值> <默认> <最小>
    case "$1" in ''|*[!0-9]*) printf '%s' "$2"; return 0 ;; esac
    if [ "${#1}" -gt 7 ] || [ "$1" -lt "$3" ]; then printf '%s' "$2"; else printf '%s' "$1"; fi
}

# 过格式校验的值：合格原样输出，不合格输出 invalid。记录里所有「不是数字」的值都走它。
_runlog_tok() {   # <值> <ERE>
    if printf '%s' "$1" | grep -qE -- "$2"; then printf '%s' "$1"; else printf 'invalid'; fi
}

# `ps -o lstart=` 的一行（"Wed Nov 11 08:20:30 2026"）→ 2026Nov11.082030；读不懂就没有输出。
_runlog_lstart_norm() {
    awk 'NF == 5 && $2 ~ /^[A-Za-z][A-Za-z][A-Za-z]$/ && $3 ~ /^[0-9][0-9]?$/ \
              && $4 ~ /^[0-9][0-9]:[0-9][0-9]:[0-9][0-9]$/ && $5 ~ /^[0-9][0-9][0-9][0-9]$/ {
             gsub(":", "", $4); printf "%s%s%02d.%s", $5, $2, $3, $4; exit }'
}

# 轮次标识 = 进程号 + 进程启动时间。poll-entry.sh 是 exec 成 agent-poll.sh 的，进程号和启动时间
# 都不变，两边各算一次得到同一个值。读不到启动时间时退到「进程号 + 现在」（那就对不上入口记录，
# 入口记录会留着，查看命令照样显示它）。
_runlog_make_id() {
    local ls=""
    ls=$(LC_ALL=C ps -o lstart= -p "$$" 2>/dev/null | _runlog_lstart_norm) || ls=""
    if [ -n "$ls" ]; then printf '%s-%s' "$$" "$ls"; else printf '%s-t%s' "$$" "$(_runlog_now)"; fi
}

# 兜底脱敏：名字像令牌的变量的当前值、GitHub 令牌形状。字段本身都过了校验，这一层不是主防线。
_runlog_scrub() {   # <文本>
    local s="$1" n v
    for n in $(compgen -v); do
        case "$n" in
            *TOKEN*|*SECRET*|*PASSWORD*|*WEBHOOK*|*_KEY|*_KEY_*|*APIKEY*) ;;
            *) continue ;;
        esac
        v="${!n-}"
        [ "${#v}" -ge 8 ] || continue
        s="${s//"$v"/***}"
    done
    case "$s" in
        *ghp_*|*gho_*|*ghu_*|*ghs_*|*ghr_*|*github_pat_*)
            s=$(printf '%s' "$s" | sed -E 's/(gh[pousr]_|github_pat_)[A-Za-z0-9_]+/***/g') ;;
    esac
    printf '%s' "$s"
}

# 把目录里的文件数压到 <上限> 以内；压不到返回 1。
# 先清一分钟以前、别的进程留下的临时文件（写到一半被杀的），再按修改时间从最旧的删。
# 不删 <保留名> 和本进程自己的临时文件。
_runlog_room() {   # <目录> <上限> <保留名>
    local dir="$1" max="$2" keep="$3" list f n i
    local -a names=()
    list=$(ls -A -t -- "$dir") || return 1
    case "$list" in
        *.tmp.*)
            find "$dir" -maxdepth 1 -name '.tmp.*' ! -name ".tmp.$$.*" -mmin +1 -exec rm -f {} + || true
            list=$(ls -A -t -- "$dir") || return 1 ;;
    esac
    [ -n "$list" ] || return 0
    mapfile -t names <<< "$list"
    n=${#names[@]}
    i=$((n - 1))
    while [ "$n" -gt "$max" ] && [ "$i" -ge 0 ]; do
        f="${names[$i]}"; i=$((i - 1))
        [ "$f" = "$keep" ] && continue
        case "$f" in ".tmp.$$."*) continue ;; esac
        rm -f -- "$dir/$f" || return 1
        # 以「这个文件确实不在了」为准，不重新数目录：重新数会把别的轮次此刻刚写进来的也算上，
        # 几轮同时写时互相把对方算成「腾不出位」而白白放弃。
        [ ! -e "$dir/$f" ] || return 1
        n=$((n - 1))
    done
    [ "$n" -le "$max" ]
}

# 带容量协议的写文件。返回 0 = 写成了，1 = 没写（腾不出位 / 写失败）。调用方都在子 shell 里。
_runlog_put() {   # <目录> <上限> <文件名> <内容>
    local dir="$1" cap="$2" name="$3" body tmp
    mkdir -p "$dir" || return 1
    _runlog_room "$dir" "$((cap - 1))" "$name" || return 1
    body=$(_runlog_scrub "$4")
    tmp="$dir/.tmp.$$.$RANDOM$RANDOM"
    if ! printf '%s\n' "$body" > "$tmp"; then rm -f "$tmp"; return 1; fi
    _runlog_hook "tmp:${dir##*/}"
    if ! mv -f "$tmp" "$dir/$name"; then rm -f "$tmp"; return 1; fi
    _runlog_hook "renamed:${dir##*/}"
    _runlog_room "$dir" "$cap" "$name" || true
    return 0
}

# ── 入口记录 ──

_runlog_config_tok() {
    local c="${CODING_AGENT_CONFIG:-}"
    if [ -z "$c" ]; then printf 'none'; else _runlog_tok "$c" '^[A-Za-z0-9_./@+-]{1,300}$'; fi
}

_runlog_entry_write() {   # <事件> <退出码或空>
    local rc="${2:-}"
    # 这时还没有项目配置，上限只能从环境变量来（测试用；平时就是 200）。
    _runlog_put "$RUNLOG_ENTRY_DIR" "$(_runlog_int "${CAVIL_RUNLOG_ENTRY_MAX:-}" 200 2)" "$RUNLOG_ID.json" \
        "{\"v\":1,\"ev\":\"$1\",\"id\":\"$RUNLOG_ID\",\"t\":$(_runlog_now),\"config\":\"$(_runlog_config_tok)\"${rc:+,\"rc\":$rc}}"
}

# poll-entry.sh 一开始调：留「已启动」。
runlog_entry_mark() {
    RUNLOG_ID=$(_runlog_make_id 2>/dev/null) || RUNLOG_ID=""
    [ -n "$RUNLOG_ID" ] || return 0
    ( set +e; _runlog_entry_write entry ""; _runlog_hook entry ) >/dev/null 2>&1 || true
    return 0
}

# agent-poll.sh 在加载配置**之前**调：挂退出钩子。必须在主 shell 里跑（要设 trap 和变量）。
runlog_early() {
    RUNLOG_ID=$(_runlog_make_id 2>/dev/null) || RUNLOG_ID=""
    [ -n "$RUNLOG_ID" ] || return 0
    RUNLOG_STAGE=early
    # errtrace：让函数里失败的那一行也能记到行号。钩子只给三个变量赋值；记最后一次——
    # set -e 下函数里那一行失败后 shell 当场退出，最后一次就是退出的那一行。
    set -o errtrace
    trap 'RUNLOG_ERR_LINE=$LINENO; RUNLOG_ERR_SRC=${BASH_SOURCE[0]:-}; RUNLOG_ERR_FUNC=${FUNCNAME[0]:-}' ERR
    trap 'runlog_on_exit $?' EXIT
    return 0
}

# ── 一轮 ──

_runlog_enabled() {
    case "$(printf '%s' "${ENABLE_POLL_RUN_LOG-true}" | tr '[:upper:]' '[:lower:]')" in
        ""|false|0|off|no) return 1 ;;
        *) return 0 ;;
    esac
}

_runlog_inflight_write() {
    _runlog_put "$RUNLOG_DIR/inflight" "$(_runlog_int "${POLL_RUN_LOG_INFLIGHT:-}" 64 2)" "$RUNLOG_ID.json" \
        "{\"v\":1,\"id\":\"$RUNLOG_ID\",\"start\":$RUNLOG_START,\"lock\":$RUNLOG_LOCKED,\"step\":\"$RUNLOG_STEP\",\"steps\":[$RUNLOG_STEPS],\"log_from\":$RUNLOG_LOG_FROM}"
}

_runlog_file_size() {   # <文件> → 字节数；读不到输出 0
    local n
    n=$(wc -c < "$1" 2>/dev/null) || n=0
    n="${n//[!0-9]/}"
    printf '%s' "${n:-0}"
}

# 配置加载完之后调（主 shell）。开关关着：删掉入口记录，之后什么都不做。
runlog_begin() {
    [ "$RUNLOG_STAGE" = early ] || return 0
    if ! _runlog_enabled; then
        RUNLOG_STAGE=off
        rm -f "$RUNLOG_ENTRY_DIR/$RUNLOG_ID.json" 2>/dev/null || true
        return 0
    fi
    RUNLOG_DIR="$STATE_DIR/runlog"
    RUNLOG_START=$(_runlog_now)
    RUNLOG_STEP_T0=$RUNLOG_START
    RUNLOG_LOG_FROM=$(_runlog_file_size "${LOG_FILE:-/nonexistent}")
    RUNLOG_STAGE=round
    (
        set +e
        _runlog_inflight_write || exit 0
        # 记账文件只在这里占一次名额，之后只追加；没建成就整轮不记账（计数显示「未知」）。
        _runlog_put "$RUNLOG_DIR/acct" "$(_runlog_int "${POLL_RUN_LOG_INFLIGHT:-}" 64 2)" "$RUNLOG_ID" "" || true
        rm -f "$RUNLOG_ENTRY_DIR/$RUNLOG_ID.json"
        _runlog_hook begin
    ) >/dev/null 2>&1 || true
    # 数轮询进程自己发出的 gh 调用：原样执行、原样返回，只往记账文件追加一行。
    # 不导出——派工子脚本和 tmux 看不到它（worker 会继承导出的东西，几小时后还在往这一轮记）。
    gh() {
        local _runlog_rc=0
        command gh "$@" || _runlog_rc=$?
        if [ "$_runlog_rc" = 0 ]; then _runlog_acct g0; else _runlog_acct g1; fi
        return "$_runlog_rc"
    }
    return 0
}

# 往本轮记账文件追加一行。文件不在（没建成 / 被别的轮次腾位删了）就不记——绝不在这里重建，
# 重建等于绕过容量协议。超过上限不再追加，收尾时标「计数已封顶」。
_runlog_acct() {   # <一行>
    [ "$RUNLOG_STAGE" = round ] || return 0
    local f="$RUNLOG_DIR/acct/$RUNLOG_ID" c
    { [ -f "$f" ] && c=$(<"$f"); } 2>/dev/null || return 0
    [ "${#c}" -lt "$RUNLOG_ACCT_MAX_BYTES" ] || return 0
    printf '%s\n' "$1" >> "$f" 2>/dev/null || true
    return 0
}

# 轻量检查（_lib.sh 的 pace_probe）拿到结果后调。它在节奏闸门的子 shell 里跑，改变量传不出来，
# 所以写进记账文件。<经 timeout 转手> = 1 时那次请求绕过了上面的 gh 函数，在这里补记一次调用。
runlog_probe_note() {   # <退出码> <HTTP 状态或空> <经 timeout 转手: 1/0>
    [ "$RUNLOG_STAGE" = round ] || return 0
    local cls
    if [ "$1" = 124 ] || [ "$1" = 137 ]; then cls=timeout
    else
        case "$2" in
            200|304) cls="$2" ;;
            "") cls=unreadable ;;
            [0-9][0-9][0-9]) cls="http-$2" ;;
            *) cls=unreadable ;;
        esac
    fi
    if [ "${3:-0}" = 1 ]; then
        case "$cls" in 200|304) _runlog_acct g0 ;; *) _runlog_acct g1 ;; esac
    fi
    _runlog_acct "p $cls"
    return 0
}

# 进入下一步（主 shell）。步骤名是固定词表，见 agent-poll.sh 里的调用。
runlog_step() {
    [ "$RUNLOG_STAGE" = round ] || return 0
    local now dur
    now=$(_runlog_now)
    dur=$((now - RUNLOG_STEP_T0))
    RUNLOG_STEPS+="${RUNLOG_STEPS:+,}[\"$RUNLOG_STEP\",$dur]"
    if [ -z "$RUNLOG_SLOW_STEP" ] && [ "$dur" -gt "$(_runlog_int "${POLL_RUN_LOG_SLOW_SECS:-}" 600 1)" ]; then
        RUNLOG_SLOW_STEP="$RUNLOG_STEP"
    fi
    RUNLOG_STEP="$1"
    RUNLOG_STEP_T0=$now
    ( set +e; _runlog_inflight_write ) >/dev/null 2>&1 || true
    return 0
}

runlog_locked()   { RUNLOG_LOCKED=1; runlog_step gate; }
runlog_outcome()  { RUNLOG_OUTCOME="$1"; return 0; }
runlog_dispatch() { if [ "$1" = 0 ]; then RUNLOG_DISPATCH_OK=$((RUNLOG_DISPATCH_OK + 1)); else RUNLOG_DISPATCH_FAIL=$((RUNLOG_DISPATCH_FAIL + 1)); fi; return 0; }
runlog_candidates() {   # <队列，一行一条>
    if [ -n "$1" ]; then RUNLOG_CANDIDATES=$(printf '%s\n' "$1" | grep -c . || true); else RUNLOG_CANDIDATES=0; fi
    return 0
}

# EXIT 钩子。原来的退出码不动：这里不 exit，函数体在子 shell 里、错误全吞。
runlog_on_exit() {
    local rc="$1"
    case "$rc" in ''|*[!0-9]*) rc=1 ;; esac
    case "$RUNLOG_STAGE" in
        early) ( set +e; _runlog_entry_write early-exit "$rc" ) >/dev/null 2>&1 || true ;;
        round) ( set +e; _runlog_finish "$rc" ) >/dev/null 2>&1 || true ;;
    esac
    return 0
}

# 出错位置：只留脚本名（本工具 scripts/ 下自己的）、行号、函数名、步骤名。
_runlog_where() {
    local src="${RUNLOG_ERR_SRC##*/}" line="$RUNLOG_ERR_LINE" fn="$RUNLOG_ERR_FUNC"
    if [ -n "$src" ] && [ -f "$(dirname "${BASH_SOURCE[0]}")/$src" ]; then
        src=$(_runlog_tok "$src" '^[A-Za-z0-9_.-]{1,60}$')
    else
        src=other
    fi
    case "$line" in ''|*[!0-9]*) line=0 ;; esac
    if [ -n "$fn" ]; then fn=$(_runlog_tok "$fn" '^[A-Za-z0-9_]{1,80}$'); fi
    printf '%s:%s:%s:%s' "$src" "$line" "$fn" "$RUNLOG_STEP"
}

# 同原因、同位置一小时内已有一份 → 输出那一份的名字。
_runlog_snapshot_recent() {   # <原因> <位置>
    local f
    while IFS= read -r f; do
        [ -n "$f" ] || continue
        if grep -qF "\"where\":\"$2\"" "$f"; then printf '%s' "${f##*/}"; return 0; fi
    done < <(find "$RUNLOG_DIR/snapshots" -maxdepth 1 -name "*-$1.json" -mmin -60 2>/dev/null)
    return 1
}

_runlog_snapshot_write() {   # <文件名> <原因> <位置> <退出码> <轻量检查> <步骤 JSON>
    local rounds="[]" pace="null" files cfg
    files=$(ls -- "$RUNLOG_DIR/rounds" 2>/dev/null | LC_ALL=C sort | tail -n 30) || files=""
    if [ -n "$files" ]; then
        rounds=$(cd "$RUNLOG_DIR/rounds" && printf '%s\n' "$files" | xargs jq -c -s '.' 2>/dev/null) || rounds="[]"
        [ -n "$rounds" ] || rounds="[]"
    fi
    # 节奏状态：逐字段提取并校验，不认识的字段不读，原文件不拷。
    if [ -n "${PACE_FILE:-}" ] && [ -f "$PACE_FILE" ]; then
        pace=$(jq -c '
            def int: if type == "number" and . == floor and . >= 0 then . else "invalid" end;
            {next_due: (.next_due | int), last_poll: (.last_poll | int),
             last_active: (.last_active | int), fail_streak: (.fail_streak | int),
             fingerprint: (.fingerprint | if type == "string" and test("^([0-9a-f]{16})?$") then . else "invalid" end)}
            ' "$PACE_FILE" 2>/dev/null) || pace="null"
        [ -n "$pace" ] || pace="null"
    fi
    cfg="{\"repo\":\"$(_runlog_tok "${REPO:-}" '^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$')\""
    cfg+=",\"tmux_prefix\":\"$(_runlog_tok "${TMUX_PREFIX:-}" '^[A-Za-z0-9_-]{1,60}$')\""
    cfg+=",\"max_concurrent_workers\":\"$(_runlog_tok "${MAX_CONCURRENT_WORKERS:-1}" '^[0-9]{1,6}$')\""
    cfg+=",\"dispatch_mode\":\"$(_runlog_tok "${DISPATCH_MODE:-label}" '^[a-z]{1,20}$')\""
    cfg+=",\"force_sync_secs\":\"$(_runlog_tok "${POLL_FORCE_SYNC_SECS:-0}" '^[0-9]{1,9}$')\"}"
    _runlog_put "$RUNLOG_DIR/snapshots" "$(_runlog_int "${POLL_RUN_LOG_SNAPSHOTS:-}" 20 2)" "$1" \
        "{\"v\":1,\"id\":\"$RUNLOG_ID\",\"t\":$(_runlog_now),\"reason\":\"$2\",\"where\":\"$3\",\"rc\":$4,\"probe\":\"$5\",\"steps\":[$6],\"release\":\"$(_runlog_release)\",\"bash\":\"$(_runlog_tok "${BASH_VERSION:-}" '^[A-Za-z0-9_.()-]{1,40}$')\",\"config\":$cfg,\"pace\":$pace,\"poll_log\":{\"from\":$RUNLOG_LOG_FROM,\"to\":$(_runlog_file_size "${LOG_FILE:-/nonexistent}")},\"rounds\":$rounds}"
}

_runlog_release() {
    local r="${CODING_AGENT_RELEASE_ROOT:-}"
    r="${r##*/}"
    if printf '%s' "$r" | grep -qE '^[0-9a-f]{7,64}$'; then printf '%s' "$r"; else printf 'dev'; fi
}

# 上一轮没跑完、这一轮因锁被占跳过：占锁的是谁（别人的、已拿到锁的、最近动过的进度文件）。只读。
_runlog_holder() {
    local f
    while IFS= read -r f; do
        [ -n "$f" ] || continue
        [ "$f" != "$RUNLOG_ID.json" ] || continue
        case "$f" in .tmp.*) continue ;; esac
        if grep -q '"lock":1' "$RUNLOG_DIR/inflight/$f" 2>/dev/null; then printf '%s' "$f"; return 0; fi
    done < <(ls -t -- "$RUNLOG_DIR/inflight" 2>/dev/null)
    return 1
}

_runlog_finish() {   # <退出码>
    local rc="$1" now dur outcome acct calls="null" failed="null" probe="" capped=0
    local snap_reason="" snap_name="" snap='{"state":"none"}' where ref
    local holder="" holder_id="" holder_start="" holder_age="" extra="" f id
    now=$(_runlog_now)
    dur=$((now - RUNLOG_STEP_T0))
    RUNLOG_STEPS+="${RUNLOG_STEPS:+,}[\"$RUNLOG_STEP\",$dur]"
    if [ -z "$RUNLOG_SLOW_STEP" ] && [ "$dur" -gt "$(_runlog_int "${POLL_RUN_LOG_SLOW_SECS:-}" 600 1)" ]; then
        RUNLOG_SLOW_STEP="$RUNLOG_STEP"
    fi
    if [ "$rc" != 0 ]; then outcome=error
    else
        case "$RUNLOG_OUTCOME" in
            ok|pace-skip|lock-busy|github-unreadable) outcome="$RUNLOG_OUTCOME" ;;
            *) outcome=early-exit ;;
        esac
    fi

    # 记账：文件不在 = 未知（null），绝不记成 0。
    acct="$RUNLOG_DIR/acct/$RUNLOG_ID"
    if [ -f "$acct" ]; then
        calls=$(grep -c '^g' "$acct"); calls="${calls:-0}"
        failed=$(grep -c '^g1' "$acct"); failed="${failed:-0}"
        probe=$(sed -n 's/^p //p' "$acct" | tail -n 1)
        [ -z "$probe" ] || probe=$(_runlog_tok "$probe" '^(200|304|timeout|unreadable|http-[0-9]{3})$')
        [ "$(_runlog_file_size "$acct")" -lt "$RUNLOG_ACCT_MAX_BYTES" ] || capped=1
    fi

    # 要不要快照。原因是固定词；名字由「轮次 + 原因」决定，同一轮同一原因重写也只有一份。
    case "$outcome" in
        error) snap_reason=error; where=$(_runlog_where) ;;
        github-unreadable) snap_reason=github-unreadable; where="$RUNLOG_STEP" ;;
    esac
    if [ -z "$snap_reason" ]; then
        case "$probe" in
            timeout) snap_reason=probe-timeout; where=probe ;;
            unreadable) snap_reason=probe-unreadable; where=probe ;;
            http-*) snap_reason=probe-http; where="$probe" ;;
        esac
    fi
    if [ -z "$snap_reason" ] && [ -n "$RUNLOG_SLOW_STEP" ]; then
        snap_reason=slow-step; where="$RUNLOG_SLOW_STEP"
    fi
    snap_name="$RUNLOG_ID-$snap_reason.json"
    if [ "$outcome" = lock-busy ]; then
        if holder=$(_runlog_holder); then
            holder_id="${holder%.json}"
            holder_start=$(sed -n 's/.*"start":\([0-9][0-9]*\).*/\1/p' "$RUNLOG_DIR/inflight/$holder" 2>/dev/null | head -n 1)
            case "$holder_start" in ''|*[!0-9]*) holder_start="" ;; esac
            holder_id=$(_runlog_tok "$holder_id" '^[0-9]+-[A-Za-z0-9.]{1,40}$')
            if [ -n "$holder_start" ] && [ "$holder_id" != invalid ]; then
                holder_age=$((now - holder_start))
                extra=",\"holder\":\"$holder_id\",\"holder_age\":$holder_age"
                # 卡死：用被卡住的那一轮命名，几轮同时发现也只有同名的一份；已有就不再写。
                if [ -z "$snap_reason" ] && [ "$holder_age" -gt "$(_runlog_int "${POLL_RUN_LOG_SLOW_SECS:-}" 600 1)" ] \
                   && [ ! -e "$RUNLOG_DIR/snapshots/$holder_id-stuck.json" ]; then
                    snap_reason=stuck; where="$holder_id"; snap_name="$holder_id-stuck.json"
                fi
            fi
        fi
    fi
    if [ -n "$snap_reason" ]; then
        if [ "$snap_reason" != stuck ] && ref=$(_runlog_snapshot_recent "$snap_reason" "$where"); then
            snap="{\"state\":\"dedup\",\"ref\":\"$ref\"}"
        elif _runlog_snapshot_write "$snap_name" "$snap_reason" "$where" "$rc" "$probe" "$RUNLOG_STEPS"; then
            snap="{\"state\":\"written\",\"name\":\"$snap_name\"}"
        else
            snap='{"state":"failed"}'
        fi
        _runlog_hook snapshot
    fi

    _runlog_put "$RUNLOG_DIR/rounds" "$(_runlog_int "${POLL_RUN_LOG_ROUNDS:-}" 1000 2)" "$RUNLOG_START-$RUNLOG_ID.json" \
        "{\"v\":1,\"id\":\"$RUNLOG_ID\",\"start\":$RUNLOG_START,\"end\":$now,\"secs\":$((now - RUNLOG_START)),\"outcome\":\"$outcome\",\"rc\":$rc,\"step\":\"$RUNLOG_STEP\",\"steps\":[$RUNLOG_STEPS],\"candidates\":$RUNLOG_CANDIDATES,\"dispatched\":$RUNLOG_DISPATCH_OK,\"dispatch_failed\":$RUNLOG_DISPATCH_FAIL,\"gh_calls\":$calls,\"gh_failed\":$failed,\"gh_capped\":$capped,\"probe\":\"$probe\",\"release\":\"$(_runlog_release)\",\"log_from\":$RUNLOG_LOG_FROM,\"log_to\":$(_runlog_file_size "${LOG_FILE:-/nonexistent}")$extra,\"snapshot\":$snap}"
    _runlog_hook record
    rm -f "$RUNLOG_DIR/inflight/$RUNLOG_ID.json" "$acct"

    # 顺手清掉「正式记录已写、进度文件没来得及删」的残留（那一轮在上面两行之间被杀了）。
    # 只是删除多余的进度文件，重复删无害；不替任何轮次写东西。
    for f in "$RUNLOG_DIR/inflight"/*.json; do
        [ -e "$f" ] || continue
        id="${f##*/}"; id="${id%.json}"
        if compgen -G "$RUNLOG_DIR/rounds/*-$id.json" > /dev/null; then rm -f "$f" "$RUNLOG_DIR/acct/$id"; fi
    done
    return 0
}
