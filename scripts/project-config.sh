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
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=_names.sh
source "$SCRIPT_DIR/_names.sh"
# shellcheck source=_install.sh
source "$SCRIPT_DIR/_install.sh"

export LC_ALL=C
FIELDS_FILE="$SCRIPT_DIR/config-fields.txt"
LOCK_WAIT_SECS=15
BACKUP_KEEP=10
# 可以原样写进配置文件一行里的字符：没有引号、$、反引号、反斜杠、空白、分号
LIT_CHARS='A-Za-z0-9._:/@,+-'

MODE="${1:-}"
KEY="${2:-}"
REV=""
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
[ -f "$ENV_FILE" ] || fail not_found "本机没有接入项目 $KEY（找不到 $ENV_FILE）" 1
HOST="$(env_value "$ENV_FILE" PROJECT_ROOT)"
CONFIG="$(env_value "$ENV_FILE" CODING_AGENT_CONFIG)"
[ -n "$CONFIG" ] || fail unreadable "项目 $KEY 的登记里没有写配置文件的位置（$ENV_FILE）" 2
[ -f "$CONFIG" ] && [ -r "$CONFIG" ] || fail unreadable "配置文件不存在或读不了：$CONFIG" 2
REAL="$(resolve_path "$CONFIG")" || fail unreadable "解析不了配置文件的真实位置：$CONFIG" 2
OS="$(uname -s 2>/dev/null || true)"
RUN_BASH="$(cavil_bash_bin "$OS")"

# ── 登记表 ──
F_NAME=(); F_GROUP=(); F_TYPE=(); F_DEF=(); F_MODE=(); F_LABEL=(); F_HELP=()
trim() { local s="$1"; s="${s#"${s%%[![:space:]]*}"}"; s="${s%"${s##*[![:space:]]}"}"; printf '%s' "$s"; }
[ -r "$FIELDS_FILE" ] || fail unreadable "找不到登记表 $FIELDS_FILE" 2
while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    IFS='|' read -r c1 c2 c3 c4 c5 c6 c7 <<<"$line"
    F_NAME+=("$(trim "$c1")"); F_GROUP+=("$(trim "$c2")"); F_TYPE+=("$(trim "$c3")"); F_DEF+=("$(trim "$c4")")
    F_MODE+=("$(trim "$c5")"); F_LABEL+=("$(trim "$c6")"); F_HELP+=("$(trim "${c7:-}")")
done < "$FIELDS_FILE"
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
    ' _ "$1" "$HOST" "${F_NAME[@]}"
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
    return 0
}
# 这一项的名字在整份配置的代码里（注释不算——规范格式里没有注释）出现了几次、是不是最外层的赋值。
# 「能不能改这一行」和「没有这一行、能不能在末尾追加」用的是这同一份证据：
#   mentions <KEY>           名字作为一个完整的词出现的次数。不只数 KEY= 这种写法：export / declare / read /
#                            printf -v / for KEY in / ${KEY:=…} / unset / 写在一行里的 if、函数体、a && KEY=…
#                            都会提到这个名字，一处都不能漏看
#   top_level_assign <KEY>   规范格式里有一行恰好缩进 4 格、以 KEY= 开头
mentions() {
    { printf '%s\n' "$NORM" | grep -ow -- "$1" || true; } | wc -l | tr -d ' '
}
top_level_assign() {
    printf '%s\n' "$NORM" | grep -qE "^    (export )?$1="
}

# daemon 实际用的值：各处读这些配置项都是「没设置或为空 → 默认值」（${X:-默认}），这里同一条规则。
# 和「配置文件里这一行能不能改」是两件事，分开算。
effective() {   # <下标>
    if [ -n "${V_VAL[$1]}" ]; then printf '%s' "${V_VAL[$1]}"; else printf '%s' "${F_DEF[$1]}"; fi
}

V_SET=(); V_VAL=(); STATE_DIR_VAL=""
read_values() {   # <配置文件> → 填 V_SET / V_VAL（和 F_NAME 同下标）、STATE_DIR_VAL；失败返回 1
    local parts=() p i=0 n=${#F_NAME[@]}
    while IFS= read -r -d '' p; do parts+=("$p"); done < <(load_values "$1" || true)
    [ "${#parts[@]}" -eq $((n * 3 + 2)) ] || return 1
    [ "${parts[$((n * 3 + 1))]}" = "__pc_end__" ] || return 1
    V_SET=(); V_VAL=()
    while [ "$i" -lt "$n" ]; do
        [ "${parts[$((i * 3))]}" = "${F_NAME[$i]}" ] || return 1
        V_SET+=("${parts[$((i * 3 + 1))]}"); V_VAL+=("${parts[$((i * 3 + 2))]}")
        i=$((i + 1))
    done
    STATE_DIR_VAL="${parts[$((n * 3))]}"
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
    m="$(mentions "$k")"
    # 整份配置的代码里一次都没提到这个名字，加载后也确实没有值：才算「没有这一行」，可以追加
    if [ "$m" = 0 ]; then
        if [ "${V_SET[$i]}" = 0 ]; then W_KIND=absent
        else W_WHY="配置文件里找不到这一项的赋值，它的值是别处给的"; fi
        return 0
    fi
    hits="$(grep -nE "^[[:space:]]*(export[[:space:]]+)?$k=" "$file" || true)"
    count=0; [ -z "$hits" ] || count="$(printf '%s\n' "$hits" | wc -l | tr -d ' ')"
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
            if [[ "$v" =~ ^(0|[1-9][0-9]{0,8})$ ]] && [ "$v" -ge "$lo" ] && [ "$v" -le "$hi" ]; then return 0; fi
            BAD_WHY="只能是 $lo 到 $hi 之间的整数"; return 1 ;;
        bool:*)
            lo="${type#bool:}"; hi="${lo#*:}"; lo="${lo%%:*}"
            [ "$v" = "$lo" ] || [ "$v" = "$hi" ] && return 0
            BAD_WHY="只能是 $lo 或 $hi"; return 1 ;;
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
type_json() {   # <类型>
    local type="$1" lo hi
    case "$type" in
        agent) jq -cn '{type:"agent", options:[$ARGS.positional[] | {value:., label:.}]}' --args ${AGENTS[@]+"${AGENTS[@]}"} ;;
        int:*) lo="${type#int:}"; hi="${lo#*:}"; lo="${lo%%:*}"
               jq -cn --argjson lo "$lo" --argjson hi "$hi" '{type:"int", min:$lo, max:$hi}' ;;
        bool:*) lo="${type#bool:}"; hi="${lo#*:}"; lo="${lo%%:*}"
                jq -cn --arg on "$lo" --arg off "$hi" '{type:"bool", on:$on, off:$off}' ;;
        enum:*) jq -cn --arg o "${type#enum:}" '{type:"enum", options:[$o | split(",")[] | {value:(split("=")[0]), label:(split("=")[1:] | join("="))}]}' ;;
        *) jq -cn --arg t "$type" '{type:$t}' ;;
    esac
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
        in_file=true; value="$(effective "$i")"; editable=false; why="$W_WHY"
        [ "$W_KIND" = absent ] && in_file=false
        if [ "${F_MODE[$i]}" = edit ]; then
            if [ "$W_KIND" = complex ]; then :
            elif valid_value "${F_TYPE[$i]}" "$value"; then editable=true
            else why="现在的值不是这里能改的写法（$BAD_WHY）"; fi
        else
            why=""
        fi
        fields+=("$(jq -cn --arg name "${F_NAME[$i]}" --arg group "${F_GROUP[$i]}" --arg mode "${F_MODE[$i]}" \
            --arg label "${F_LABEL[$i]}" --arg help "${F_HELP[$i]}" --arg value "$value" --arg def "${F_DEF[$i]}" \
            --argjson in_file "$in_file" --argjson editable "$editable" --arg why "$why" \
            --argjson t "$(type_json "${F_TYPE[$i]}")" \
            '{name:$name, group:$group, mode:$mode, label:$label, help:$help, value:$value, default:$def,
              in_file:$in_file, editable:$editable, reason:(if $why == "" then null else $why end)} + $t')")
    done
    printf '%s\n' "${fields[@]}" | jq -s --arg key "$KEY" --arg config "$CONFIG" --arg real "$REAL" --arg rev "$rev" \
        '{version:1, key:$key, state:"ok", config:$config, real:$real, rev:$rev, fields:.}'
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
cp -p "$REAL" "$SNAP" 2>/dev/null || { echo "复制不了配置文件到 $SNAP，什么都没写"; finish write_failed 2; }
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
    if ! i="$(field_index "$k")" || [ "${F_MODE[$i]}" != edit ]; then
        echo "$k 不是能在这里改的配置项，什么都没写"
        DETAIL="$(jq -cn --arg k "$k" '{field:$k}')"; finish not_editable 2
    fi
    inspect_field "$SNAP" "$i"
    old="$(effective "$i")"
    if [ "$W_KIND" = complex ] || ! valid_value "${F_TYPE[$i]}" "$old"; then
        echo "$k 现在不能在这里改（${W_WHY:-现在的值不是标准写法}），什么都没写"
        DETAIL="$(jq -cn --arg k "$k" '{field:$k}')"; finish not_editable 2
    fi
    if ! valid_value "${F_TYPE[$i]}" "$v"; then
        echo "${F_LABEL[$i]}（$k）的值不合规：$BAD_WHY。什么都没写"
        DETAIL="$(jq -cn --arg k "$k" --arg why "$BAD_WHY" '{field:$k, reason:$why}')"; finish invalid 2
    fi
    # 文件里已经是这个值的不算改动（没写过的项即使等于默认值也算：写进去才是「已决定」）
    if [ "$W_KIND" = literal ] && [ "$W_LITERAL" = "$v" ]; then continue; fi
    E_IDX+=("$i"); E_KIND+=("$W_KIND"); E_LINE+=("$W_LINE"); E_QUOTE+=("$W_QUOTE"); E_LIT+=("$W_LITERAL"); E_NEW+=("$v")
    changes+=("$(jq -cn --arg k "$k" --arg label "${F_LABEL[$i]}" --arg old "$old" --arg new "$v" \
        --argjson added "$([ "$W_KIND" = absent ] && echo true || echo false)" \
        '{name:$k, label:$label, old:$old, new:$new, added:$added}')")
done
if [ "${#E_IDX[@]}" -eq 0 ]; then
    echo "要写的值和配置文件里的一样，什么都没写"
    DETAIL='{"changes":[]}'; finish unchanged 0
fi
changes_json="$(printf '%s\n' "${changes[@]}" | jq -cs '.')"

# 4. 从副本生成新文件
cp -p "$SNAP" "$NEW" 2>/dev/null || { echo "建不了临时文件 $NEW，什么都没写"; finish write_failed 2; }
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
} > "$NEW" || { echo "写不了临时文件 $NEW，什么都没写"; finish write_failed 2; }

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
    echo "备份写不进 $BK_DIR，什么都没写"; finish backup_failed 2
fi
# 只留最近 BACKUP_KEEP 份（只动自己命名的备份）
ls -1 "$BK_DIR" 2>/dev/null | grep -E '^[0-9]{8}-[0-9]{6}-[0-9]+\.config$' | sort -r | tail -n +$((BACKUP_KEEP + 1)) \
    | while IFS= read -r old_bk; do rm -f "$BK_DIR/$old_bk"; done || true
DETAIL="$(jq -cn --argjson c "$changes_json" --arg b "$BACKUP" --arg config "$CONFIG" '{changes:$c, backup:$b, config:$config}')"

# 7. 紧挨着替换的最后核对：真实位置没变、内容没变
real_now="$(resolve_path "$CONFIG" || true)"
if [ "$real_now" != "$REAL" ] || [ "$(rev_of "$REAL" "$REAL" || true)" != "$REV" ]; then
    echo "保存进行中配置文件被别处改了，什么都没写（备份留在 $BACKUP，可以不管它）"
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
