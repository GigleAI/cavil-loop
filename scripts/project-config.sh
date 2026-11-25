#!/usr/bin/env bash
# 读 / 改一个已接项目的常用配置项（GitHub#388）。给桌面客户端的「项目配置」弹窗用，人也可以直接跑。
#
# 用法：
#   bash scripts/project-config.sh get <instance-key>
#       输出一个 JSON：配置文件位置、指纹（rev）、每个登记项的当前值 / 可不可改 / 为什么不可改
#   printf '{"MAX_CONCURRENT_WORKERS":"2"}' | bash scripts/project-config.sh set <instance-key> --rev <指纹> [--lock-wait <秒>]
#       改这几项。值一律写成字符串。最后一行固定是 RESULT=<词>，前一行 DETAIL=<JSON>
#       --lock-wait：另一个保存正在进行时最多等几秒（默认 15）
#
# 哪些配置项能读、能改：只有 scripts/config-fields.txt 里登记的。命令、钩子、令牌、目录不在里面。
# 配置文件的位置只从本机的项目登记里取（新旧名字走 _names.sh），不接受调用方传路径。
#
# set 的规则（一次调用要么全写要么全不写）：
#   1. 按配置文件的真实位置（解析掉软链接）拿锁；等不到 → busy
#   2. 把配置文件整份复制成一份私有副本，后面的核对、改值、备份全基于它；
#      副本的指纹和 --rev 对不上 → changed（文件在读取之后被别处改过），不写
#   3. 每个值按登记的类型校验 → invalid；不在登记表里 / 只显示 / 写成算式 / 不在最外层的项 → not_editable
#   4. 从副本生成新文件：只替换那一行的值，其余行逐字节不动；配置文件里没有的项追加一行
#   5. 验证新文件：bash -n；重新加载后被改的项等于要写的值、其余所有变量和改之前相同 → 否则 verify_failed
#   6. 副本存进项目状态目录 config-backups/（600，留最近 10 份），读回核对 → 否则 backup_failed
#   7. 紧挨着替换再核对一次配置文件的真实位置和指纹，变了 → changed，不写
#   8. 原子替换（同目录改名）。**从这一步起本脚本不再写配置文件**：不回滚、不自动恢复
#   9. 读回：等于刚写的内容 → saved；不等于 → saved_then_changed（换上之后又被别处改了）
#
# ⚠️ 保存时不要同时在编辑器里改同一个文件。脚本没法让编辑器等它：第 7、8 步之间别处存的一版
# 会被新文件换掉；编辑器在保存前就开着文件、保存后才存盘的，要么把刚写的值整份盖回去，要么
# 写到已被换下的旧文件里。这两种情况脚本发现不了，丢掉的外部修改也找不回来——备份只有
# 「保存前的那一版」。详见 docs/operations.md「Edit a project's settings from a script」。
#
# 退出码：0 = get 输出了 JSON / set 结果是 saved、unchanged；1 = 用法错误、没有这个项目；
#   2 = 没写（changed / invalid / not_editable / busy / unreadable / verify_failed / backup_failed / write_failed）；
#   3 = 缺 jq；4 = saved_then_changed。

# ── Reading and changing a project's everyday settings: rules moved from the root AGENTS.md (GitHub#658); read before changing ──
# Reading and changing a project's everyday settings (GitHub#388: `scripts/project-config.sh`,
# `scripts/config-fields.txt`, the client's `daemon_config.rs` / `ProjectConfigDialog.tsx`, the
# commands in `docs/operations{,.zh}.md` behind `<!-- project-config-ops:begin -->`) →
# `tests/project-config.test.sh` (~30 s; the real script under a fake HOME) and
# `tests/project-config-poll.test.sh` (~15 s; real `agent-poll.sh` rounds before and after a real
# save), plus `client/test/unit/project-config.test.ts` and `client/test/e2e/daemon-config.spec.ts`
# for the form. Only settings registered in `config-fields.txt` are read at all, only `edit` ones are
# written; **never register a command, hook, token, URL, folder or name** — the window could then run
# anything or read a credential (the test asserts the list by name pattern). A registered setting is
# editable only when the config has it on exactly one unindented top-level line as a plain literal
# whose value equals what the config loads to; anything else is shown with the reason. "Top level" is
# read from bash's own parse — the file wrapped in a function body and printed by `declare -f`, where
# a top-level assignment is the line indented exactly four spaces — never from the file's indentation:
# an unindented assignment inside `if true; then … fi` was taken for editable and rewritten (PR #399
# code review round 1). "Editable" and "missing, may be appended" are judged from the same evidence,
# the number of times the name occurs as a word in that normalized code (`mentions`): zero and unset =
# missing; exactly one, and it is the top-level assignment line = editable; anything else is
# show-only. Never decide "missing" from "no line starts with `KEY=`": `if false; then KEY=2; fi` on
# one line has no such line, was reported missing, and a save appended a top-level line over it (round
# 2). An unreadable parse makes every setting show-only — not known is not absent. The value shown is
# a separate question from editability: it is always what the daemon works with — unset or empty after
# loading means the registered default (`effective`), so a line inside a branch that did not run shows
# the default, not an empty field. Each row's "value when the line is missing" must be what the daemon
# really uses: checked against `config-notices.txt` and the template, against a real `_lib.sh` load of
# an empty config, and — for the ones defaulted only where they are used (`${X:-n}`) — against the
# real consumer: poll rounds for concurrency, the two retry caps, cleanup after merge and the conflict
# check with its day limit (a real conflict, real `merge-tree`), the real
# `post-merge-retrospective.sh` for the model it hands to the model program
# (`tests/project_config_retro_test.py`). Every registered default is checked against its consumer
# this way; a new row needs its own. Change a default in both places. A save works from a private copy
# of the file (never a hard link — that is another name for the same mutable file), compares the file
# with the caller's fingerprint once more right before the rename, and **never writes the config after
# the rename**: no rollback, no automatic restore (an earlier design restored a "kept" copy and
# overwrote a newer outside save — design review round 2). What cannot be prevented is stated, not
# hidden: an editor storing between the last check and the rename, or through a file it opened
# earlier, loses its edit while the result may still be `saved`; the test pins those outcomes as they
# are, by wrapping the real `cp` / `mv` (no test switch in the script). "Could not load" is
# `unreadable` with no values, never "nothing set"; no `RESULT=` line is `unconfirmed` on the client —
# neither "saved" nor "nothing written"
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=_names.sh
source "$SCRIPT_DIR/_names.sh"
# shellcheck source=_install.sh
source "$SCRIPT_DIR/_install.sh"
# shellcheck source=_label_rename.sh
source "$SCRIPT_DIR/_label_rename.sh"
# shellcheck source=_preview_ports.sh
source "$SCRIPT_DIR/_preview_ports.sh"

export LC_ALL=C
FIELDS_FILE="$SCRIPT_DIR/config-fields.txt"
LOCK_WAIT_SECS=15
BACKUP_KEEP=10
# 可以原样写进配置文件一行里的字符：没有引号、$、反引号、反斜杠、空白、分号
LIT_CHARS='A-Za-z0-9._:/@,+-'

MODE="${1:-}"
KEY="${2:-}"
REV=""
# 只给 scripts/label-rename.sh 用（GitHub#569）：这一次只改一个流程标签的名字。要求本项目有一条和它对得上的
# 「改名进行中」记录（同一项、同一旧名、同一新名），所以不能拿来绕过「流程标签只显示」
LABEL_RENAME=""
usage() { sed -n '2,11p' "$0" >&2; }
case "$MODE" in
    get|set) ;;
    -h|--help) sed -n '2,/^set -euo pipefail$/p' "$0" | sed '$d'; exit 0 ;;
    *) usage; exit 1 ;;
esac
shift 2 2>/dev/null || true
while [ $# -gt 0 ]; do
    case "$1" in
        --rev) REV="${2:-}"; shift 2 2>/dev/null || shift ;;
        --label-rename) LABEL_RENAME=1; shift ;;
        --lock-wait) LOCK_WAIT_SECS="${2:-}"; shift 2 2>/dev/null || shift
            case "$LOCK_WAIT_SECS" in ''|*[!0-9]*) echo "--lock-wait 后面要跟秒数" >&2; exit 1 ;; esac ;;
        *) echo "不认识的参数：$1" >&2; exit 1 ;;
    esac
done

DETAIL='{}'
finish() {   # <RESULT 词> <退出码>
    [ "$MODE" = set ] && { printf 'DETAIL=%s\n' "$DETAIL"; printf 'RESULT=%s\n' "$1"; }
    exit "$2"
}
# get 的失败也是一个 JSON（state 说明原因），调用方不用猜
get_fail() {   # <state> <reason> <退出码>
    if command -v jq >/dev/null 2>&1; then
        jq -cn --arg key "$KEY" --arg state "$1" --arg reason "$2" --argjson config "$(json_str_or_null "${CONFIG:-}")" \
            '{version:1, key:$key, config:$config, state:$state, reason:$reason}'
    else
        printf '{"version":1,"state":"%s"}\n' "$1"
    fi
    exit "$3"
}
fail() {   # <state / RESULT 词> <给人看的原因> <退出码>
    if [ "$MODE" = get ]; then get_fail "$1" "$2" "$3"; fi
    echo "$2"
    finish "$1" "$3"
}
json_str_or_null() { if [ -n "$1" ]; then jq -cn --arg v "$1" '$v'; else printf 'null'; fi; }

if ! command -v jq >/dev/null 2>&1; then
    echo "缺 jq，读不了也改不了项目配置" >&2
    [ "$MODE" = get ] && printf '{"version":1,"state":"unreadable","reason":"缺 jq"}\n'
    finish unreadable 3
fi
if [ -z "$KEY" ] || ! [[ "$KEY" =~ ^[A-Za-z0-9_.-]+$ ]] || [ "$KEY" = deploy ]; then
    fail not_found "项目名不合规（只能含 [A-Za-z0-9_.-]）" 1
fi

sha256() {
    if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -d' ' -f1
    elif command -v shasum >/dev/null 2>&1; then shasum -a 256 | cut -d' ' -f1
    else return 1; fi
}
# 解析掉软链接后的真实位置（不依赖 realpath：老 macOS 没有）
resolve_path() {
    local p="$1" n=0 t d
    while [ -L "$p" ]; do
        n=$((n + 1)); [ "$n" -le 40 ] || return 1
        t="$(readlink "$p")" || return 1
        case "$t" in /*) p="$t" ;; *) p="$(dirname "$p")/$t" ;; esac
    done
    d="$(cd "$(dirname "$p")" 2>/dev/null && pwd -P)" || return 1
    printf '%s/%s\n' "$d" "$(basename "$p")"
}
# 指纹 = 真实位置 + 内容。位置变了（软链接改指别处）或内容变了，指纹都变。
rev_of() {   # <真实位置> <读内容的文件>
    [ -f "$2" ] && [ -r "$2" ] || return 1
    { printf '%s\n' "$1"; cat "$2"; } | sha256
}

# ── 项目登记：环境文件 → 项目根、配置文件 ──
env_value() { sed -n "s/^$2=//p" "$1" 2>/dev/null | tail -1; }
ENV_FILE="$(cavil_project_env "$KEY")"
[ -f "$ENV_FILE" ] || fail not_found "本机没有接入项目 ${KEY}（找不到 ${ENV_FILE}）" 1
HOST="$(env_value "$ENV_FILE" PROJECT_ROOT)"
CONFIG="$(env_value "$ENV_FILE" CODING_AGENT_CONFIG)"
[ -n "$CONFIG" ] || fail unreadable "项目 $KEY 的登记里没有写配置文件的位置（${ENV_FILE}）" 2
[ -f "$CONFIG" ] && [ -r "$CONFIG" ] || fail unreadable "配置文件不存在或读不了：$CONFIG" 2
REAL="$(resolve_path "$CONFIG")" || fail unreadable "解析不了配置文件的真实位置：$CONFIG" 2
OS="$(uname -s 2>/dev/null || true)"
RUN_BASH="$(cavil_bash_bin "$OS")"

# ── 登记表 ──
# F_DEF = 不写这一行时的值；F_EMPTY = 写成空值时的值（登记成「默认;empty=值」的项和默认值不同，其余同默认值）；
# F_WHY = 只显示的原因（show 行的第 8 列）；F_TIER = 层级（第 9 列：main / more / advanced，GitHub#591）
F_NAME=(); F_GROUP=(); F_TYPE=(); F_DEF=(); F_EMPTY=(); F_MODE=(); F_LABEL=(); F_HELP=(); F_WHY=(); F_TIER=()
# 去掉首尾空白，结果写进 <变量名>：不经命令替换。登记表每行 9 列、84 行，每列起一个子 shell 就是读一次
# 七百多个进程，CI 上那条逐值读写的用例因此卡在 60 秒时限边上（GitHub#662）
trim_to() {   # <变量名> <文本>
    local __t="$2"; __t="${__t#"${__t%%[![:space:]]*}"}"; __t="${__t%"${__t##*[![:space:]]}"}"; printf -v "$1" '%s' "$__t"
}
[ -r "$FIELDS_FILE" ] || fail unreadable "找不到登记表 $FIELDS_FILE" 2
while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    IFS='|' read -r c1 c2 c3 c4 c5 c6 c7 c8 c9 <<<"$line"
    trim_to c4 "$c4"
    case "$c4" in
        *';empty='*) F_DEF+=("${c4%%;empty=*}"); F_EMPTY+=("${c4#*;empty=}") ;;
        *) F_DEF+=("$c4"); F_EMPTY+=("$c4") ;;
    esac
    trim_to c1 "$c1"; trim_to c2 "$c2"; trim_to c3 "$c3"; trim_to c5 "$c5"; trim_to c6 "$c6"
    trim_to c7 "${c7:-}"; trim_to c8 "${c8:-}"
    F_NAME+=("$c1"); F_GROUP+=("$c2"); F_TYPE+=("$c3")
    F_MODE+=("$c5"); F_LABEL+=("$c6"); F_HELP+=("$c7"); F_WHY+=("$c8")
    # 层级是一个词，去掉全部空白即可，不再为它起一个子进程（81 行各一次，PR #596 复审第 3 轮实测慢了约 1 成）
    c9="${c9:-}"; F_TIER+=("${c9//[[:space:]]/}")
done < "$FIELDS_FILE"
# F_EARLY = 这一项的早期名字（_names.sh 的 CAVIL_SETTING_EARLY_NAMES，daemon 加载时按同一张表挑值），没有就是空
F_EARLY=()
for __k in "${F_NAME[@]}"; do cavil_setting_early_name_to __e "$__k"; F_EARLY+=("$__e"); done
# 加载时一起读的早期名字：和 F_NAME 同下标，没有早期名字的位置放一个配置里不会有的名字（读出来一定是没设置）
EARLY_LOAD=()
for __k in "${F_EARLY[@]}"; do EARLY_LOAD+=("${__k:-__pc_no_early_name}"); done
field_index() {   # <KEY> → 下标；没有返回 1
    local i
    for i in "${!F_NAME[@]}"; do [ "${F_NAME[$i]}" = "$1" ] && { printf '%s' "$i"; return 0; }; done
    return 1
}

# daemon 自带的 agent：scripts/drivers/ 下不以 _ 开头的 *.sh
AGENTS=()
for f in "$SCRIPT_DIR"/drivers/*.sh; do
    [ -f "$f" ] || continue
    n="$(basename "$f" .sh)"
    case "$n" in _*) continue ;; esac
    AGENTS+=("$n")
done

# ── 在干净环境里加载一份配置 ──
# env -i：调用方环境里的同名变量不能冒充「配置里设了」。用轮询会用的那个 bash。
# load_values <配置文件>：对每个登记项输出 名字\0是否设置(1/0)\0值\0，最后 STATE_DIR 和结束标记。
load_values() {
    env -i HOME="$HOME" PATH="$PATH" "$RUN_BASH" --noprofile --norc -c '
        __pc_f="$1"; PROJECT_ROOT="$2"; shift 2
        set -a; . "$__pc_f" >/dev/null 2>&1 </dev/null || exit 3; set +a
        for __pc_k in "$@"; do
            if [ -n "${!__pc_k+x}" ]; then printf "%s\0001\000%s\000" "$__pc_k" "${!__pc_k}"
            else printf "%s\0000\000\000" "$__pc_k"; fi
        done
        printf "%s\000%s\000" "${STATE_DIR:-}" "__pc_end__"
    ' _ "$1" "$HOST" "${F_NAME[@]}" "${EARLY_LOAD[@]}"
}
# dump_vars <配置文件> [不算在内的变量名...]：加载后的全部变量和函数（去掉 bash 自己会变的那些）
dump_vars() {
    local f="$1"; shift
    env -i HOME="$HOME" PATH="$PATH" "$RUN_BASH" --noprofile --norc -c '
        __pc_f="$1"; PROJECT_ROOT="$2"; shift 2
        set -a; . "$__pc_f" >/dev/null 2>&1 </dev/null || exit 3; set +a
        for __pc_v in $(compgen -v); do
            case "$__pc_v" in
                __pc_*|BASH*|PPID|RANDOM|SECONDS|SRANDOM|EPOCHREALTIME|EPOCHSECONDS|LINENO|_|PIPESTATUS|FUNCNAME|GROUPS|DIRSTACK|COMP_*|HISTCMD) continue ;;
            esac
            for __pc_s in "$@"; do [ "$__pc_s" = "$__pc_v" ] && continue 2; done
            declare -p "$__pc_v" 2>/dev/null
        done
        declare -f
        echo __pc_end__
    ' _ "$f" "$HOST" "$@"
}

# ── 配置文件的结构：哪些赋值在最外层 ──
# 不自己解析 shell：把整份文件包进一个函数体交给 bash 解析（只定义、不执行），再让它用 declare -f
# 按自己的规范格式打印出来。那份格式里每条命令一行、每进一层结构（if / 循环 / case / 函数 / { } 组）
# 多缩进 4 格，所以「最外层的赋值」= 恰好缩进 4 格、以 KEY= 开头的那一行。原文件怎么缩进、
# 有没有缩进都不影响这个判断；写在 `cmd &&` 后面、续行里、here-doc 或多行字符串里的同名字样
# 也都不会是这种行。解析不了 → NORM_OK=0，所有项一律只显示。
NORM=""; NORM_OK=0
load_structure() {   # <配置文件>
    NORM_OK=0
    NORM="$(env -i HOME="$HOME" PATH="$PATH" "$RUN_BASH" --noprofile --norc -c '
        __pc_src="$(cat "$1")" || exit 3
        eval "__pc_fn() {
$__pc_src
}" 2>/dev/null || exit 3
        declare -f __pc_fn || exit 3
        echo __pc_end__
    ' _ "$1" 2>/dev/null)" || return 0
    case "$NORM" in *__pc_end__) NORM_OK=1 ;; esac
    [ "$NORM_OK" = 1 ] || return 0
    index_structure "$1"
    return 0
}
# 这一项的名字在整份配置的代码里（注释不算——规范格式里没有注释）出现了几次、是不是最外层的赋值。
# 「能不能改这一行」和「没有这一行、能不能在末尾追加」用的是这同一份证据：
#   M_NAME[i] / M_EARLY[i]   名字（早期名字）作为一个完整的词出现的次数。不只数 KEY= 这种写法：export / declare / read /
#                            printf -v / for KEY in / ${KEY:=…} / unset / 写在一行里的 if、函数体、a && KEY=…
#                            都会提到这个名字，一处都不能漏看
#   top_level_assign <KEY>   规范格式里有一行恰好缩进 4 格、以 KEY= 开头
#   file_hits <KEY>          原文件里以 KEY= 开头（前面可以有空白和 export）的行，grep -n 的格式
# 三样都在 load_structure 里对全部登记项一次算好（index_structure），不再每项各起几次 grep：逐项算时
# 读一次要开约 1400 个进程，CI 上那条逐值读写的用例卡在 60 秒时限边上（GitHub#662）。
# 「完整的词」和 grep -w 同一个意思：名字只由字母、数字、下划线组成，前后紧挨着的不是这三类字符
# （本脚本开头 LC_ALL=C，非 ASCII 字节不算这三类）——等于把代码切成连续的字母数字下划线段，数和名字相同的段。
# 输出有几行（命令替换去掉了末尾换行：空 = 0 行，否则 = 换行数 + 1）。在 bash 里数，不另起 wc
line_count() {   # <文本>
    local nl
    if [ -z "$1" ]; then printf 0; return 0; fi
    nl="${1//[!$'\n']/}"; printf '%s' "$(( ${#nl} + 1 ))"
}
M_NAME=(); M_EARLY=(); TOP_NAMES=" "; HIT_NAME=(); HIT_LINE=(); HITS_OK=0
index_structure() {   # <配置文件>：填 M_NAME / M_EARLY（和 F_NAME 同下标）、TOP_NAMES、HIT_NAME / HIT_LINE
    local counts=() c l re all txt rc
    # 下面三步任何一步的证据不完整（命令失败、输出形状不对）都当成「结构读不出」：NORM_OK=0，所有项只显示、
    # 不许改行也不许追加。不能只看输出行数——命令可以先打印完整的结果、再以失败退出（PR #664 复审第 1 轮）
    M_NAME=(); M_EARLY=(); TOP_NAMES=" "; HIT_NAME=(); HIT_LINE=(); HITS_OK=0
    # 1. 出现次数：一个 awk 把规范化代码切成词段，只数登记过的名字和早期名字，按传进去的顺序各输出一个数。
    #    整个管道（set -o pipefail）以 0 结束、每行都是数字、行数正好是名字数，才算数出来了
    if ! txt="$(printf '%s\n' "$NORM" | awk -v names="${F_NAME[*]} ${EARLY_LOAD[*]}" '
        BEGIN { n = split(names, N, " "); for (i = 1; i <= n; i++) want[N[i]] = 1 }
        { s = $0
          while (match(s, /[A-Za-z0-9_]+/)) { w = substr(s, RSTART, RLENGTH); if (w in want) c[w]++; s = substr(s, RSTART + RLENGTH) } }
        END { for (i = 1; i <= n; i++) print ((N[i] in c) ? c[N[i]] : 0) }')"; then
        NORM_OK=0; return 0
    fi
    while IFS= read -r c; do
        [[ "$c" =~ ^(0|[1-9][0-9]*)$ ]] || { NORM_OK=0; return 0; }
        counts+=("$c")
    done <<<"$txt"
    if [ "${#counts[@]}" -ne $(( ${#F_NAME[@]} * 2 )) ]; then NORM_OK=0; return 0; fi
    for c in "${!F_NAME[@]}"; do
        M_NAME+=("${counts[$c]}"); M_EARLY+=("${counts[$(( ${#F_NAME[@]} + c ))]}")
    done
    # 2. 最外层赋值：规范格式里恰好缩进 4 格、以 [export ]名字= 开头的行（只在 bash 里做，不起进程）
    re='^    (export )?([A-Za-z0-9_]+)='
    while IFS= read -r l; do
        [[ "$l" =~ $re ]] && TOP_NAMES+="${BASH_REMATCH[2]} "
    done <<<"$NORM"
    # 3. 原文件里的赋值行：一次 grep 取出所有「[空白][export 空白]名字=」开头的行，按名字分好。
    #    有一行不是「行号:内容」（例如老 grep 对含 NUL 的文件只说一句 Binary file matches）就不用这份结果，
    #    退回逐项 grep，结果和以前逐字节相同。grep 退出码 0 = 有匹配、1 = 没有（这时输出必须是空的），
    #    其余 = 读错了，当成结构读不出
    rc=0; all="$(grep -nE '^[[:space:]]*(export[[:space:]]+)?[A-Za-z0-9_]+=' "$1")" || rc=$?
    if [ "$rc" -gt 1 ] || { [ "$rc" = 1 ] && [ -n "$all" ]; }; then NORM_OK=0; return 0; fi
    HITS_OK=1
    re='^[0-9]+:[[:space:]]*(export[[:space:]]+)?([A-Za-z0-9_]+)='
    if [ -n "$all" ]; then
        while IFS= read -r l; do
            if [[ "$l" =~ $re ]]; then HIT_NAME+=("${BASH_REMATCH[2]}"); HIT_LINE+=("$l")
            else HITS_OK=0; HIT_NAME=(); HIT_LINE=(); break; fi
        done <<<"$all"
    fi
    return 0
}
top_level_assign() {
    case "$TOP_NAMES" in *" $1 "*) return 0 ;; esac
    return 1
}
file_hits_to() {   # <变量名> <配置文件> <KEY>：和 grep -nE "^[[:space:]]*(export[[:space:]]+)?KEY=" 的输出相同（去掉末尾换行）
    # grep 读错了（退出码 2 及以上）返回 1：调用方不能把它当成「没有这一行」
    local __fh="" __j __rc=0
    if [ "$HITS_OK" != 1 ]; then
        __fh="$(grep -nE "^[[:space:]]*(export[[:space:]]+)?$3=" "$2")" || __rc=$?
        [ "$__rc" -le 1 ] || return 1
    else
        for __j in ${HIT_NAME[@]+"${!HIT_NAME[@]}"}; do
            [ "${HIT_NAME[$__j]}" = "$3" ] || continue
            if [ -z "$__fh" ]; then __fh="${HIT_LINE[$__j]}"; else __fh+=$'\n'"${HIT_LINE[$__j]}"; fi
        done
    fi
    printf -v "$1" '%s' "$__fh"
}

# daemon 实际用的值：有值 → 它；没有值但早期名字有值 → 早期名字的值（_lib.sh 用 cavil_pick_setting
# 挑，这里调的是同一个函数）；没设置 → 默认值；为空 → 写成空值时的值（多数项读的是 ${X:-默认}，两者相同；
# 少数项读的是 ${X-默认}，空值有自己的意思，登记成「默认;empty=值」——例如等前置、暂缓两个标签
# （GitHub#551：不写 = 开，写成空值 = 关）。按项登记、不按类型：同是标签的「等合并」读的是 ${X:-默认}，空值仍是默认标签）。
# 和「配置文件里这一行能不能改」是两件事，分开算。
# 末尾的换行一律去掉、只剩换行就算空：和以前 picked="$(cavil_pick_setting …)"、value="$(effective …)" 两次命令替换
# 的结果相同（值 "opus\n" 显示 "opus"，只有换行的值回落到默认值；PR #664 复审第 1 轮）
effective_to() {   # <变量名> <下标>：结果写进变量，不经命令替换（每次读对每一项都要算，GitHub#662）
    local __ep
    cavil_pick_setting_to __ep "${V_VAL[$2]}" "${V_EARLY_VAL[$2]}"
    __ep="${__ep%"${__ep##*[!$'\n']}"}"
    if [ -n "$__ep" ]; then printf -v "$1" '%s' "$__ep"
    elif [ "${V_SET[$2]}" = 1 ]; then printf -v "$1" '%s' "${F_EMPTY[$2]}"
    else printf -v "$1" '%s' "${F_DEF[$2]}"; fi
}
effective() {   # <下标>：同上，打印出来
    local __ev; effective_to __ev "$1"; printf '%s' "$__ev"
}

V_SET=(); V_VAL=(); V_EARLY_SET=(); V_EARLY_VAL=(); STATE_DIR_VAL=""
read_values() {   # <配置文件> → 填 V_SET / V_VAL / V_EARLY_SET / V_EARLY_VAL（和 F_NAME 同下标）、STATE_DIR_VAL；失败返回 1
    local parts=() p i=0 n=${#F_NAME[@]} m
    m=$((n * 2))
    while IFS= read -r -d '' p; do parts+=("$p"); done < <(load_values "$1" || true)
    [ "${#parts[@]}" -eq $((m * 3 + 2)) ] || return 1
    [ "${parts[$((m * 3 + 1))]}" = "__pc_end__" ] || return 1
    V_SET=(); V_VAL=(); V_EARLY_SET=(); V_EARLY_VAL=()
    while [ "$i" -lt "$n" ]; do
        [ "${parts[$((i * 3))]}" = "${F_NAME[$i]}" ] || return 1
        [ "${parts[$(((n + i) * 3))]}" = "${EARLY_LOAD[$i]}" ] || return 1
        V_SET+=("${parts[$((i * 3 + 1))]}"); V_VAL+=("${parts[$((i * 3 + 2))]}")
        V_EARLY_SET+=("${parts[$(((n + i) * 3 + 1))]}"); V_EARLY_VAL+=("${parts[$(((n + i) * 3 + 2))]}")
        i=$((i + 1))
    done
    STATE_DIR_VAL="${parts[$((m * 3))]}"
}

# ── 一个配置项在文件里是怎么写的 ──
# 结果放全局：W_KIND = literal（整份代码里只提到这一次、是最外层单独一行的普通字面值、且加载后的值就是它）/
# absent（整份代码里一次都没提到、加载后也确实没有值）/ complex；W_LINE 行号、W_QUOTE 引号（" ' 或空）、W_LITERAL 这一行写的字面值、
# W_WHY 不可改的原因。调用前先对同一个文件跑过 load_structure。
inspect_field() {   # <配置文件> <下标>
    local file="$1" i="$2" k="${F_NAME[$2]}" hits count ln text re m
    W_KIND=complex; W_LINE=0; W_QUOTE=""; W_WHY=""; W_LITERAL=""
    # 结构读不出来：不知道这一项在文件里有没有、在哪——不当成「没有」，也不当成「在最外层」
    if [ "$NORM_OK" != 1 ]; then
        W_WHY="读不出配置文件的结构，判断不了这一项能不能安全地改"; return 0
    fi
    # 用到了这一项的早期名字：daemon 照样认（新名字没有值时用它），但在这里写新名字会让两个名字并存、
    # 值还可能互相矛盾。两份证据任一成立都只显示：配置的代码里提到了它（没执行的分支、unset 也算），
    # 或者加载完它有定义（不管来自哪里——配置加载的另一个文件、运行时拼出来的名字，这里都看不到文字）
    if [ -n "${F_EARLY[$i]}" ]; then
        if [ "${M_EARLY[$i]}" != 0 ]; then
            W_WHY="配置文件里写的是这一项的早期名字 ${F_EARLY[$i]}（daemon 照样认）；在文件里把它改成 ${k} 后才能在这里改"
            return 0
        fi
        if [ "${V_EARLY_SET[$i]}" = 1 ]; then
            W_WHY="配置加载后有这一项的早期名字 ${F_EARLY[$i]}（不在这份文件里，可能来自它加载的另一个文件；daemon 照样认）；把那里改成 ${k} 后才能在这里改"
            return 0
        fi
    fi
    m="${M_NAME[$i]}"
    # 整份配置的代码里一次都没提到这个名字，加载后也确实没有值：才算「没有这一行」，可以追加
    if [ "$m" = 0 ]; then
        if [ "${V_SET[$i]}" = 0 ]; then W_KIND=absent
        else W_WHY="配置文件里找不到这一项的赋值，它的值是别处给的"; fi
        return 0
    fi
    if ! file_hits_to hits "$file" "$k"; then
        W_WHY="读不出配置文件的结构，判断不了这一项能不能安全地改"; return 0
    fi
    count="$(line_count "$hits")"
    if [ "$count" -gt 1 ]; then W_WHY="配置文件里有 $count 处给这一项赋值"; return 0; fi
    # 不是「单独一行、在最外层的赋值」：写在 if / 循环 / case / 函数 / { } 组里（一行写完的也算）、
    # 接在别的命令后面，或者是 export / declare / read 这类别的写法。看结构，不看缩进
    if [ "$count" = 0 ] || ! top_level_assign "$k"; then
        W_WHY="配置文件里这一项写在条件、循环或函数里面，接在别的命令后面，或不是普通的赋值写法"; return 0
    fi
    if [ "$m" != 1 ]; then W_WHY="配置文件里除了赋值的那一行，别处还提到了这一项（共 $m 处）"; return 0; fi
    ln="${hits%%:*}"; text="${hits#*:}"
    case "$text" in [[:space:]]*) W_WHY="配置文件里这一行前面有缩进"; return 0 ;; esac
    W_WHY="配置文件里这一项是手写的算式或引用了别的变量"
    re='^(export[[:space:]]+)?'"$k"'="(['"$LIT_CHARS"']*)"([[:space:]]+#.*|[[:space:]]*)$'
    if [[ "$text" =~ $re ]]; then W_QUOTE='"'
    else
        re='^(export[[:space:]]+)?'"$k"'='"'"'(['"$LIT_CHARS"']*)'"'"'([[:space:]]+#.*|[[:space:]]*)$'
        if [[ "$text" =~ $re ]]; then W_QUOTE="'"
        else
            re='^(export[[:space:]]+)?'"$k"'=(['"$LIT_CHARS"']*)([[:space:]]+#.*|[[:space:]]*)$'
            [[ "$text" =~ $re ]] || return 0
        fi
    fi
    # 字面值和加载后的值不一样：别处还有看不见的写法改了它（另一个文件、运行时拼出来的名字）
    if [ "${V_SET[$i]}" != 1 ] || [ "${BASH_REMATCH[2]}" != "${V_VAL[$i]}" ]; then
        W_WHY="配置文件里这一行写的值和加载后实际的值不一样，别处还改了它"; return 0
    fi
    W_KIND=literal; W_LINE="$ln"; W_WHY=""; W_LITERAL="${BASH_REMATCH[2]}"
}

# 整数按十进制数字串比大小，不经过 bash 的 64 位整数：登记的上限可以是使用端的真实上限
# （head -n 收到 2^64-1、[ -gt ] 收到 2^63-1），比较时不会溢出。两边都是不带前导 0 的写法。
# 上限留空 = 使用它的代码不设上限。位数以 200 为限：窗口送来的每个值都不超过 200 个字符（客户端后端
# daemon_config.rs 的 valid_value、远程入口 remote_access.py 的 VALUE_RE），这里和它们用同一个数。
INT_MAX_DIGITS=200
dec_le() {   # <a> <b>：a <= b 返回 0
    if [ "${#1}" -ne "${#2}" ]; then [ "${#1}" -lt "${#2}" ]; return; fi
    [ "$1" = "$2" ] && return 0
    [[ "$1" < "$2" ]]   # 同样位数的数字串：按字节比（本脚本开头已 LC_ALL=C）
}

# ── 按类型校验一个值；不合规时把原因放进 BAD_WHY ──
valid_value() {   # <类型> <值>
    local type="$1" v="$2" lo hi a opts o
    BAD_WHY=""
    case "$v" in *[!$LIT_CHARS]*) BAD_WHY="含有不能写进配置文件的字符"; return 1 ;; esac
    case "$type" in
        agent)
            for a in ${AGENTS[@]+"${AGENTS[@]}"}; do [ "$a" = "$v" ] && return 0; done
            BAD_WHY="只能是 daemon 自带的 agent：${AGENTS[*]-}"; return 1 ;;
        model)
            [ -z "$v" ] && return 0
            [ "${#v}" -le 80 ] && [[ "$v" =~ ^[A-Za-z0-9][A-Za-z0-9._:/@-]*$ ]] && return 0
            BAD_WHY="模型名只能含字母、数字和 . _ : / @ -"; return 1 ;;
        int:*)
            lo="${type#int:}"; hi="${lo#*:}"; lo="${lo%%:*}"
            # int:下限:上限:empty = 另外可以留空（GitHub#556）
            a=""; case "$hi" in *:empty) hi="${hi%:empty}"; a="，或者留空"; [ -z "$v" ] && return 0 ;; esac
            if [[ "$v" =~ ^(0|[1-9][0-9]*)$ ]] && [ "${#v}" -le "$INT_MAX_DIGITS" ] \
               && dec_le "$lo" "$v" && { [ -z "$hi" ] || dec_le "$v" "$hi"; }; then return 0; fi
            if [ -z "$hi" ]; then BAD_WHY="只能是不小于 $lo 的整数$a"; else BAD_WHY="只能是 $lo 到 $hi 之间的整数$a"; fi
            return 1 ;;
        bool:*)
            lo="${type#bool:}"; hi="${lo#*:}"; lo="${lo%%:*}"
            [ "$v" = "$lo" ] || [ "$v" = "$hi" ] && return 0
            BAD_WHY="只能是 $lo 或 $hi"; return 1 ;;
        repodir)
            # 项目仓库里的相对目录（GitHub#688）：规则和复盘程序的 report_dir_problem 是同一条，
            # 同一份正反例对拍（tests/fixtures/repodir-cases.txt）。空 = 使用方的默认目录
            [ -z "$v" ] && return 0
            BAD_WHY="只能是项目仓库里的相对目录：用 / 分隔的字母、数字、. _ -，不以 / 开头或结尾，不含 . 或 .. 段，不进 .git"
            [ "${#v}" -le 200 ] && [[ "$v" =~ ^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$ ]] || return 1
            a="$v/"
            while [ -n "$a" ]; do
                o="${a%%/*}"; a="${a#*/}"
                case "$o" in .|..|[.][Gg][Ii][Tt]) return 1 ;; esac
            done
            BAD_WHY=""; return 0 ;;
        enum:*)
            opts="${type#enum:}"
            while [ -n "$opts" ]; do
                o="${opts%%,*}"; [ "${o%%=*}" = "$v" ] && [ -n "$v" ] && return 0
                case "$opts" in *,*) opts="${opts#*,}" ;; *) opts="" ;; esac
            done
            BAD_WHY="不在可选的值里"; return 1 ;;
    esac
    BAD_WHY="这种类型不能在这里改"; return 1
}

# 类型 → 客户端画表单要的那部分 JSON
# 一个登记项的类型 → JSON 里的 type 和它带的字段。agent 的选项是 $ARGS.positional（daemon 自带的 agent）。
# int:下限:上限 / bool:开的值:关的值 都在第一个冒号处分开，和 valid_value 一致（int 的上限可以留空）
TYPE_JQ='def type_json($t):
    def after($p): $t[($p | length):];
    def head($s): if ($s | index(":")) == null then $s else $s[:($s | index(":"))] end;
    def tail($s): if ($s | index(":")) == null then $s else $s[(($s | index(":")) + 1):] end;
    if $t == "agent" then {type:"agent", options:[$ARGS.positional[] | {value:., label:.}]}
    elif $t | startswith("int:") then after("int:") as $r
        # 末尾的 :empty = 另外可以留空（GitHub#556），给 empty:true；不带它的项 JSON 和以前一样
        | ($r | endswith(":empty")) as $e | (if $e then $r[:-6] else $r end) as $r
        # max：空 = 代码不设上限（null）；超过 JSON 数字能精确表示的位数时给字符串，免得被读成近似值
        | {type:"int", min:(head($r) | tonumber), max:(tail($r) | if . == "" then null elif length <= 15 then tonumber else . end)}
        + (if $e then {empty:true} else {} end)
    elif $t | startswith("bool:") then after("bool:") as $r | {type:"bool", on:head($r), off:tail($r)}
    elif $t | startswith("enum:") then {type:"enum", options:[after("enum:") | split(",")[] | {value:(split("=")[0]), label:(split("=")[1:] | join("="))}]}
    else {type:$t} end;'

# 本项目有没有没做完的流程标签改名、有没有在核对标签（GitHub#569）。记录是 scripts/label-rename.sh 写的小 JSON；
# 读不了 = unreadable，不当成「没有」
label_rename_status_json() {
    local rec watch p w
    case "$STATE_DIR_VAL" in /*) ;; *) printf '{"state":"unknown"}'; return 0 ;; esac
    rec="$(label_rename_record_path "$STATE_DIR_VAL")"; watch="$(label_watch_path "$STATE_DIR_VAL")"
    p=null; w=null
    if [ -e "$rec" ] || [ -L "$rec" ]; then
        p="$(jq -c 'if type == "object" then . else error("x") end' "$rec" 2>/dev/null)" || p='"unreadable"'
        [ -n "$p" ] || p='"unreadable"'
    fi
    if [ -e "$watch" ] || [ -L "$watch" ]; then
        w="$(jq -c 'if type == "object" then . else error("x") end' "$watch" 2>/dev/null)" || w='"unreadable"'
        [ -n "$w" ] || w='"unreadable"'
    fi
    jq -cn --argjson p "$p" --argjson w "$w" '{state:"ok", pending:$p, watch:$w}'
}

# ════════════════ get ════════════════
if [ "$MODE" = get ]; then
    rev="$(rev_of "$REAL" "$REAL")" || get_fail unreadable "读不了配置文件：$REAL" 2
    read_values "$REAL" || get_fail unreadable "配置文件加载失败（shell 语法错误，或加载中途退出）：$CONFIG" 2
    # 加载期间文件变了：读到的值和指纹可能对不上，让调用方重读
    load_structure "$REAL"
    [ "$(rev_of "$REAL" "$REAL" || true)" = "$rev" ] || get_fail unreadable "读取期间配置文件被改了，请重新读取" 2
    fields=()
    for i in "${!F_NAME[@]}"; do
        inspect_field "$REAL" "$i"
        in_file=true; effective_to value "$i"; editable=false; why="$W_WHY"
        [ "$W_KIND" = absent ] && in_file=false
        if [ "${F_MODE[$i]}" = edit ]; then
            if [ "$W_KIND" = complex ]; then :
            elif valid_value "${F_TYPE[$i]}" "$value"; then editable=true
            else why="现在的值不是这里能改的写法（${BAD_WHY}）"; fi
        else
            why="${F_WHY[$i]}"
        fi
        # 能不能在改名框里改名（GitHub#569）：只看能改名的流程标签；配置里要是最外层一行普通字面值、值不为空
        rn=""; rn_why=""
        if label_rename_field_ok "${F_NAME[$i]}"; then
            if [ -z "$value" ]; then rn=false; rn_why="这个功能关着（标签为空），没有可以改名的标签"
            elif [ "$W_KIND" != literal ]; then rn=false; rn_why="${W_WHY:-配置文件里没有单独写这一行}，用编辑器改成最外层单独一行后才能在这里改名"
            elif ! label_rename_name_ok "$value"; then rn=false; rn_why="现在的名字含有这里改不了的字符"
            else rn=true; fi
        fi
        # 每项 14 个字段，最后用一次 jq 拼成 JSON（不再每项起两次 jq）
        fields+=("${F_NAME[$i]}" "${F_GROUP[$i]}" "${F_MODE[$i]}" "${F_LABEL[$i]}" "${F_HELP[$i]}" "$value" \
            "${F_DEF[$i]}" "$in_file" "$editable" "$why" "${F_TYPE[$i]}" "$rn" "$rn_why" "${F_TIER[$i]}")
    done
    # --rawfile 整份读进一个字符串：jq -R 从管道分块读时会把一个多字节字符切在两块之间，读成乱码（jq 1.7 实测）
    jq -n --rawfile raw <(printf '%s\0' "${fields[@]}") --arg key "$KEY" --arg config "$CONFIG" --arg real "$REAL" --arg rev "$rev" \
        --argjson lr "$(label_rename_status_json)" \
        "$TYPE_JQ"'
        ($raw | split("\u0000") | .[:-1]) as $f
        | [range(0; $f | length; 14) as $i | $f[$i:$i + 14]
           | {name:.[0], group:.[1], mode:.[2], label:.[3], help:.[4], value:.[5], default:.[6],
              in_file:(.[7] == "true"), editable:(.[8] == "true"), reason:(if .[9] == "" then null else .[9] end)}
             + type_json(.[10])
             + (if .[11] == "" then {} else {rename:{ok:(.[11] == "true"), reason:(if .[12] == "" then null else .[12] end)}} end)
             + (if .[13] == "" then {} else {tier:.[13]} end)]
        | {version:1, key:$key, state:"ok", config:$config, real:$real, rev:$rev, fields:.,
           label_rename:$lr}' \
        --args ${AGENTS[@]+"${AGENTS[@]}"}
    exit 0
fi

# ════════════════ set ════════════════
[ -n "$REV" ] || { echo "set 必须带 --rev <get 给的指纹>" >&2; finish invalid 1; }
INPUT="$(cat)"
# 要改的项：一个 JSON 对象，值全是字符串
W_NAMES=(); W_VALUES=()
if ! printf '%s' "$INPUT" | jq -e 'type == "object" and length > 0 and all(.[]; type == "string")' >/dev/null 2>&1; then
    echo "要改的项必须是一个非空 JSON 对象，值都写成字符串"
    finish invalid 2
fi
while IFS= read -r -d '' k && IFS= read -r -d '' v; do W_NAMES+=("$k"); W_VALUES+=("$v"); done \
    < <(printf '%s' "$INPUT" | jq -j 'to_entries[] | select(.value | test("\u0000") | not) | "\(.key)\u0000\(.value)\u0000"')
[ "${#W_NAMES[@]}" -eq "$(printf '%s' "$INPUT" | jq 'length')" ] || { echo "要改的值里有不能用的字符"; finish invalid 2; }

DIR="$(dirname "$REAL")"; BASE="$(basename "$REAL")"
SNAP="$DIR/.$BASE.pc-snap.$$"; NEW="$DIR/.$BASE.pc-new.$$"
cleanup() { rm -f "$SNAP" "$NEW" 2>/dev/null || true; }
trap cleanup EXIT

# 1. 互斥：按真实位置拿锁
LOCK_DIR="$CAVIL_STATE_HOME/config-locks"
mkdir -p "$LOCK_DIR" 2>/dev/null || { echo "建不了锁目录 $LOCK_DIR"; finish busy 2; }
LOCK="$LOCK_DIR/$(printf '%s' "$REAL" | sha256).lock"
exec 8>"$LOCK" || { echo "打不开锁文件 $LOCK"; finish busy 2; }
if ! flock -w "$LOCK_WAIT_SECS" 8; then
    echo "另一个保存还没结束（等了 $LOCK_WAIT_SECS 秒），什么都没写"
    finish busy 2
fi

# 2. 私有副本 + 第一次核对
cp -p "$REAL" "$SNAP" 2>/dev/null || { echo "复制不了配置文件到 ${SNAP}，什么都没写"; finish write_failed 2; }
snap_rev="$(rev_of "$REAL" "$SNAP")" || { echo "读不了副本，什么都没写"; finish write_failed 2; }
if [ "$snap_rev" != "$REV" ]; then
    echo "配置文件在读取之后被别处改过，什么都没写。重新读取后再改。"
    finish changed 2
fi
if ! read_values "$SNAP"; then
    echo "配置文件加载失败，什么都没写"
    finish unreadable 2
fi
load_structure "$SNAP"

# 3. 逐项：登记了吗、能改吗、值合规吗
E_IDX=(); E_KIND=(); E_LINE=(); E_QUOTE=(); E_LIT=(); E_NEW=()
changes=()
for j in "${!W_NAMES[@]}"; do
    k="${W_NAMES[$j]}"; v="${W_VALUES[$j]}"
    if [ -n "$LABEL_RENAME" ]; then
        # 改名脚本的这一次写入：只能是一个能改名的流程标签，而且必须有对得上的「改名进行中」记录
        if [ "${#W_NAMES[@]}" != 1 ] || ! i="$(field_index "$k")" || ! label_rename_field_ok "$k"; then
            echo "$k 不是能改名的流程标签，什么都没写"
            DETAIL="$(jq -cn --arg k "$k" '{field:$k}')"; finish not_editable 2
        fi
        inspect_field "$SNAP" "$i"
        effective_to old "$i"
        rec="$(label_rename_record_path "$STATE_DIR_VAL")"
        if [ "$W_KIND" != literal ] || [ -z "$old" ] \
           || ! jq -e --arg k "$k" --arg o "$old" --arg n "$v" '.field == $k and .from == $o and .to == $n' "$rec" >/dev/null 2>&1; then
            echo "$k 没有对得上的改名记录，或配置里这一行不能改（${W_WHY:-}），什么都没写"
            DETAIL="$(jq -cn --arg k "$k" '{field:$k}')"; finish not_editable 2
        fi
        if ! label_rename_name_ok "$v"; then
            echo "新名字只能用字母、数字和 . _ : / @ + -，最长 50 个字符。什么都没写"
            DETAIL="$(jq -cn --arg k "$k" '{field:$k, reason:"name"}')"; finish invalid 2
        fi
    elif ! i="$(field_index "$k")" || [ "${F_MODE[$i]}" != edit ]; then
        echo "$k 不是能在这里改的配置项，什么都没写"
        DETAIL="$(jq -cn --arg k "$k" '{field:$k}')"; finish not_editable 2
    else
    inspect_field "$SNAP" "$i"
    effective_to old "$i"
    if [ "$W_KIND" = complex ] || ! valid_value "${F_TYPE[$i]}" "$old"; then
        echo "$k 现在不能在这里改（${W_WHY:-现在的值不是标准写法}），什么都没写"
        DETAIL="$(jq -cn --arg k "$k" '{field:$k}')"; finish not_editable 2
    fi
    fi
    if [ -z "$LABEL_RENAME" ] && ! valid_value "${F_TYPE[$i]}" "$v"; then
        echo "${F_LABEL[$i]}（${k}）的值不合规：${BAD_WHY}。什么都没写"
        DETAIL="$(jq -cn --arg k "$k" --arg why "$BAD_WHY" '{field:$k, reason:$why}')"; finish invalid 2
    fi
    # 文件里已经是这个值的不算改动（没写过的项即使等于默认值也算：写进去才是「已决定」）
    if [ "$W_KIND" = literal ] && [ "$W_LITERAL" = "$v" ]; then continue; fi
    E_IDX+=("$i"); E_KIND+=("$W_KIND"); E_LINE+=("$W_LINE"); E_QUOTE+=("$W_QUOTE"); E_LIT+=("$W_LITERAL"); E_NEW+=("$v")
    changes+=("$(jq -cn --arg k "$k" --arg label "${F_LABEL[$i]}" --arg old "$old" --arg new "$v" \
        --argjson added "$([ "$W_KIND" = absent ] && echo true || echo false)" \
        '{name:$k, label:$label, old:$old, new:$new, added:$added}')")
done
# 3b. 组合检查（GitHub#556）：预览端口的起始号 / 取余数 / 后端偏移改了任何一项，就用保存后的三项
#     （没改的取现在实际用的值）算一遍端口；算出来不能用就不存。规则和注册前的检查是同一份（_preview_ports.sh）
pv_touch=0
for k in "${W_NAMES[@]}"; do case "$k" in PREVIEW_PORT_BASE|PREVIEW_PORT_MODULO|PREVIEW_BACKEND_OFFSET) pv_touch=1 ;; esac; done
if [ "$pv_touch" = 1 ]; then
    pv_after() {   # <名字> → 保存后的值：这次要写的，否则 daemon 现在实际用的
        local j i
        for j in "${!W_NAMES[@]}"; do [ "${W_NAMES[$j]}" = "$1" ] && { printf '%s' "${W_VALUES[$j]}"; return; }; done
        i="$(field_index "$1")" && effective "$i"
    }
    pv_b="$(pv_after PREVIEW_PORT_BASE)"; pv_m="$(pv_after PREVIEW_PORT_MODULO)"; pv_o="$(pv_after PREVIEW_BACKEND_OFFSET)"
    # 没改的那几项现在的值也一起查：能不能参与运算、算出来的端口能不能用，都由 _preview_ports.sh 判断
    pv_bad="$(preview_ports_save_problem "$pv_b" "$pv_m" "$pv_o")" || true
    if [ -n "$pv_bad" ]; then
        echo "预览端口的三项设置合起来不能用：${pv_bad}。什么都没写"
        DETAIL="$(jq -cn --arg why "$pv_bad" '{field:"PREVIEW_PORT_BASE", reason:$why}')"; finish invalid 2
    fi
fi
if [ "${#E_IDX[@]}" -eq 0 ]; then
    echo "要写的值和配置文件里的一样，什么都没写"
    DETAIL='{"changes":[]}'; finish unchanged 0
fi
changes_json="$(printf '%s\n' "${changes[@]}" | jq -cs '.')"

# 4. 从副本生成新文件
cp -p "$SNAP" "$NEW" 2>/dev/null || { echo "建不了临时文件 ${NEW}，什么都没写"; finish write_failed 2; }
{
    n=0; ended=1; tail_nl=1
    while IFS= read -r line || { ended=0; [ -n "$line" ]; }; do
        n=$((n + 1)); tail_nl="$ended"
        for e in "${!E_IDX[@]}"; do
            if [ "${E_KIND[$e]}" = literal ] && [ "${E_LINE[$e]}" = "$n" ]; then
                k="${F_NAME[${E_IDX[$e]}]}"; q="${E_QUOTE[$e]}"
                head="${line%%"$k="*}"; rest="${line#*"$k="}"
                # rest = 旧值（带引号）+ 行尾注释；旧值是字面值，长度算得出来
                oldlen=$(( ${#E_LIT[$e]} + ${#q} * 2 ))
                line="$head$k=$q${E_NEW[$e]}$q${rest:$oldlen}"
            fi
        done
        if [ "$ended" = 1 ]; then printf '%s\n' "$line"; else printf '%s' "$line"; fi
    done < "$SNAP"
    first=1
    for e in "${!E_IDX[@]}"; do
        [ "${E_KIND[$e]}" = absent ] || continue
        # 原文件最后一行没有换行符：先补一个，前面的字节不动
        if [ "$first" = 1 ] && [ "$tail_nl" = 0 ]; then printf '\n'; fi
        first=0
        printf '%s="%s"\n' "${F_NAME[${E_IDX[$e]}]}" "${E_NEW[$e]}"
    done
} > "$NEW" || { echo "写不了临时文件 ${NEW}，什么都没写"; finish write_failed 2; }

# 5. 验证新文件
changed_names=()
for e in "${!E_IDX[@]}"; do changed_names+=("${F_NAME[${E_IDX[$e]}]}"); done
if ! "$RUN_BASH" -n "$NEW" 2>/dev/null; then
    echo "新文件语法检查没过，什么都没写"; finish verify_failed 2
fi
before="$(dump_vars "$SNAP" "${changed_names[@]}" || true)"
after="$(dump_vars "$NEW" "${changed_names[@]}" || true)"
case "$before" in *__pc_end__) ;; *) echo "副本加载失败，什么都没写"; finish verify_failed 2 ;; esac
if [ "$before" != "$after" ]; then
    echo "新文件加载后，没改的配置项也变了，什么都没写"; finish verify_failed 2
fi
old_set=("${V_SET[@]}"); old_val=("${V_VAL[@]}")
read_values "$NEW" || { echo "新文件加载失败，什么都没写"; finish verify_failed 2; }
for e in "${!E_IDX[@]}"; do
    i="${E_IDX[$e]}"
    if [ "${V_SET[$i]}" != 1 ] || [ "${V_VAL[$i]}" != "${E_NEW[$e]}" ]; then
        echo "新文件加载后 ${F_NAME[$i]} 不是要写的值，什么都没写"; finish verify_failed 2
    fi
done
V_SET=("${old_set[@]}"); V_VAL=("${old_val[@]}")
new_sum="$(sha256 < "$NEW")" || { echo "算不了新文件的校验和，什么都没写"; finish verify_failed 2; }

# 6. 备份（内容复制，不是另起一个名字）
case "$STATE_DIR_VAL" in
    /*) ;;
    *) echo "配置里的状态目录不是绝对路径，没处放备份，什么都没写"; finish backup_failed 2 ;;
esac
BK_DIR="$STATE_DIR_VAL/config-backups"
BACKUP="$BK_DIR/$(date +%Y%m%d-%H%M%S)-$$.config"
if ! mkdir -p "$BK_DIR" 2>/dev/null || ! cp "$SNAP" "$BACKUP" 2>/dev/null || ! chmod 600 "$BACKUP" 2>/dev/null \
   || ! cmp -s "$SNAP" "$BACKUP"; then
    rm -f "$BACKUP" 2>/dev/null || true
    echo "备份写不进 ${BK_DIR}，什么都没写"; finish backup_failed 2
fi
# 只留最近 BACKUP_KEEP 份（只动自己命名的备份）
ls -1 "$BK_DIR" 2>/dev/null | grep -E '^[0-9]{8}-[0-9]{6}-[0-9]+\.config$' | sort -r | tail -n +$((BACKUP_KEEP + 1)) \
    | while IFS= read -r old_bk; do rm -f "$BK_DIR/$old_bk"; done || true
DETAIL="$(jq -cn --argjson c "$changes_json" --arg b "$BACKUP" --arg config "$CONFIG" '{changes:$c, backup:$b, config:$config}')"

# 7. 紧挨着替换的最后核对：真实位置没变、内容没变
real_now="$(resolve_path "$CONFIG" || true)"
if [ "$real_now" != "$REAL" ] || [ "$(rev_of "$REAL" "$REAL" || true)" != "$REV" ]; then
    echo "保存进行中配置文件被别处改了，什么都没写（备份留在 ${BACKUP}，可以不管它）"
    finish changed 2
fi

# 8. 原子替换。从这一行起本脚本不再写配置文件。
if ! mv -f "$NEW" "$REAL"; then
    echo "换不上新文件，什么都没写"; finish write_failed 2
fi

# 9. 读回
if [ "$(sha256 < "$REAL" 2>/dev/null || true)" = "$new_sum" ]; then
    echo "已保存 ${#E_IDX[@]} 项，下一轮轮询生效。保存前的版本备份在 $BACKUP"
    finish saved 0
fi
echo "已写入，但随后又被别处改了：现在的配置文件不是刚写的内容，请重新读取核对。保存前的版本备份在 $BACKUP"
finish saved_then_changed 4
