#!/usr/bin/env bash
# kind: install
# 项目配置脚本（scripts/project-config.sh）少开进程之后，输出和改动前逐字节相同（GitHub#662）。
#
# 改动把「早期名字、名字出现几次、最外层赋值、原文件里的赋值行、实际取值」从逐项起子进程改成一次算完。
# 这几样决定「能不能改这一行、能不能在末尾追加」，所以用改动前（merge-base）的脚本和现在的脚本，
# 对同一批配置样本各跑一遍，逐字节比：
#   - get 的整份 JSON
#   - set 的退出码、全部输出（只把备份路径换成固定占位：它带日期和进程号，每次都不同）、保存后的配置文件
#   - 两次保存各自的备份：存在、权限 600、内容等于保存前的配置
# 样本：tests/project-config.test.sh 3b 组的全部写法（条件 / 循环 / 函数 / 一行写完的结构 / declare / read …），
# 值的末尾有换行 / 只有换行、早期名字、export、行尾注释、名字是别的词的一部分、CRLF、含 NUL 字节、没有末尾换行、加载失败、配置模板全文。
# 两边脚本一样（改动已合入主干）时整组跳过（tests/lib/compat.sh）。
#
#   bash tests/project-config-compat.test.sh
set -uo pipefail
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"
# shellcheck source=lib/compat.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/compat.sh"

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT
export TZ=UTC
SYS_PATH="$PATH"

pass=0; fail=0
# 不一致时打出两边的逐行差异（期望 = 改动前，实得 = 现在），不截前缀：PR #664 复审第 1 轮有一次不一致，
# 只截了两边各前 3000 字节，看不出差在哪
chk() {
    if [ "$2" = "$3" ]; then pass=$((pass+1))
    else
        echo "  ❌ $1（--- 改动前 / +++ 现在）"
        diff -u <(printf '%s\n' "$3") <(printf '%s\n' "$2") | tail -n +3 | head -80 | sed 's/^/     /'
        fail=$((fail+1))
    fi
}

copy_tree() {   # <目标目录> [<rev>]
    mkdir -p "$1"
    if [ -n "${2:-}" ]; then
        git -C "$REPO_DIR" archive "$2" scripts | tar -x -C "$1"
    else
        (cd "$REPO_DIR" && tar -c scripts) | tar -x -C "$1"
    fi
}
NEW="$SANDBOX/new"; copy_tree "$NEW"
BASE_REV=$(git -C "$REPO_DIR" merge-base HEAD origin/main 2>/dev/null || git -C "$REPO_DIR" rev-parse HEAD~1)
OLD="$SANDBOX/old"; copy_tree "$OLD" "$BASE_REV"

if compat_skip "项目配置脚本改动前后的输出" "$OLD" "$NEW" scripts; then
    compat_summary
    report_counts "$pass" "$fail"
    exit 0
fi

W="$SANDBOX/w"; H="$W/h"; P="$W/p/widget"; CONF="$P/cavil-loop.config"; ST="$H/st"
base_config() {
    cat <<'CONF'
# 项目配置（测试用）
REPO="acme/widget"
STATE_DIR="$HOME/st"
WORKER_AGENT="claude"   # 干活的 agent
WORKER_MODEL=""
MAX_CONCURRENT_WORKERS=1
REVIEW_MAX_ROUNDS='6'
BLOCKED_RECHECK_SECS=$((5 * 60))
OUTPUT_LANGUAGE="zh"
COMMENT_FOOTER="yes"
if true; then
    SELFHEAL_MAX_RETRIES=5
fi
LOG_LEVEL="info"
LOG_LEVEL="debug"
WORKTREE_SETUP_CMD="npm ci || npm install"
PR_CREATED_HOOK="hooks/pr.sh"
GH_TOKEN="ghp_TESTSECRET0000"
LABEL_PENDING_REVIEW="pending/review"
DISPATCH_MODE="label"
CONF
}
# 一个世界：假 HOME + 项目登记 + 一份配置（内容由 $1 给出的文件决定）
make_world() {   # <配置内容文件>
    rm -rf "$W"; mkdir -p "$H/.config/cavil-loop" "$P"
    cp "$1" "$CONF"; chmod 640 "$CONF"
    printf 'PROJECT_ROOT=%s\nCODING_AGENT_CONFIG=%s\n' "$P" "$CONF" > "$H/.config/cavil-loop/widget.conf"
}
run_pc() {   # <脚本树> <参数...>：空环境，只给 HOME 和 PATH；先标准输出，再标准错误；返回脚本的退出码
    local tree="$1" rc=0; shift
    env -i HOME="$H" PATH="$SYS_PATH" bash "$tree/scripts/project-config.sh" "$@" 2>"$SANDBOX/err" || rc=$?
    # 标准错误也比，只去掉 grep 对含 NUL 字节的文件说的「binary file matches」：改动前逐项 grep 每项说一次，
    # 现在一次 grep 只说一次；这句只到标准错误，不进 JSON / DETAIL / RESULT（「含 NUL 字节」样本）
    printf -- '--- 标准错误 ---\n'; grep -v ': binary file matches$' "$SANDBOX/err" || true
    return "$rc"
}
# 一次 set 的结果：退出码 + 输出（备份路径换成占位）+ 保存后的配置 + 备份的核对
set_once() {   # <脚本树> <json> <rev> → 一段文本
    local tree="$1" json="$2" rev="$3" rc=0 out bk before bkcheck=none
    before="$(cat "$CONF"; printf x)"
    out="$(printf '%s' "$json" | run_pc "$tree" set widget --rev "$rev")" || rc=$?
    bk="$(printf '%s\n' "$out" | sed -n 's/^DETAIL=//p' | tail -1 | jq -r '.backup // empty' 2>/dev/null)"
    if [ -n "$bk" ]; then
        if [ -f "$bk" ] && [ "$(stat -c %a "$bk")" = 600 ] && [ "$(cat "$bk"; printf x)" = "$before" ]; then bkcheck=ok
        else bkcheck=bad; fi
        out="${out//"$bk"/<备份>}"
    fi
    printf 'rc=%s\nbackup=%s\n%s\n--- 配置 ---\n' "$rc" "$bkcheck" "$out"
    cat -v "$CONF"
    sha256sum < "$CONF"
}
SAMPLES="$SANDBOX/samples"; mkdir -p "$SAMPLES"; NS=0
sample() {   # <名字> <配置内容>（printf '%s' 原样写）
    NS=$((NS + 1)); printf '%s' "$2" > "$SAMPLES/$NS"; printf '%s\n' "$1" > "$SAMPLES/$NS.name"
}
# 把 base_config 里 MAX_CONCURRENT_WORKERS=1 那一行换成一种写法
variant() {   # <名字> <替换文本>
    local t; t="$(base_config; printf x)"; t="${t%x}"
    sample "$1" "${t/$'MAX_CONCURRENT_WORKERS=1\n'/$2$'\n'}"
}
NL=$'\n'
sample "基础样本" "$(base_config)$NL"
# tests/project-config.test.sh 3b 组的全部写法
variant "if 里、执行了、不缩进" "if true; then${NL}MAX_CONCURRENT_WORKERS=2${NL}fi"
variant "if 里、执行了、缩进" "if true; then${NL}    MAX_CONCURRENT_WORKERS=2${NL}fi"
variant "if 里、没执行" "if false; then${NL}MAX_CONCURRENT_WORKERS=2${NL}fi"
variant "else 分支里" "if false; then${NL}:${NL}else${NL}MAX_CONCURRENT_WORKERS=3${NL}fi"
variant "循环里" "for _x in 1; do${NL}MAX_CONCURRENT_WORKERS=2${NL}done"
variant "case 里" "case x in${NL}x)${NL}MAX_CONCURRENT_WORKERS=2${NL};;${NL}esac"
variant "{ } 组里" "{${NL}MAX_CONCURRENT_WORKERS=2${NL}}"
variant "函数里（调用了）" "set_it() {${NL}MAX_CONCURRENT_WORKERS=2${NL}}${NL}set_it"
variant "函数里（没调用）" "set_it() {${NL}MAX_CONCURRENT_WORKERS=2${NL}}"
variant "接在 && 后面的下一行" "true &&${NL}MAX_CONCURRENT_WORKERS=2"
variant "接在 || 后面的下一行" "true ||${NL}MAX_CONCURRENT_WORKERS=2"
variant "here-doc 里" ": <<DOC${NL}MAX_CONCURRENT_WORKERS=2${NL}DOC"
variant "多行字符串里" "NOTE=\"${NL}MAX_CONCURRENT_WORKERS=2${NL}\""
variant "续行里" "true \\${NL}MAX_CONCURRENT_WORKERS=2"
variant "一行写完的 if（没执行）" "if false; then MAX_CONCURRENT_WORKERS=2; fi"
variant "一行写完的 if（执行了）" "if true; then MAX_CONCURRENT_WORKERS=2; fi"
variant "一行写完的函数" "set_it() { MAX_CONCURRENT_WORKERS=2; }; set_it"
variant "同一行接在 && 后面" "false && MAX_CONCURRENT_WORKERS=2"
variant "同一行接在 ; 后面" ": ; MAX_CONCURRENT_WORKERS=2"
variant "一行里的 { } 组" "{ MAX_CONCURRENT_WORKERS=2; }"
variant "一行里的 case" "case x in x) MAX_CONCURRENT_WORKERS=2 ;; esac"
variant "同一行两个赋值" "PC_OTHER=1 MAX_CONCURRENT_WORKERS=2"
variant "declare 赋值" "declare MAX_CONCURRENT_WORKERS=2"
variant "只 export、不赋值" "export MAX_CONCURRENT_WORKERS"
variant "\${…:=…}（执行了）" ': "${MAX_CONCURRENT_WORKERS:=2}"'
variant "\${…:=…}（没执行）" 'false && : "${MAX_CONCURRENT_WORKERS:=2}"'
variant "read 读进来" "read -r MAX_CONCURRENT_WORKERS <<<2"
variant "printf -v" "printf -v MAX_CONCURRENT_WORKERS %s 2"
variant "for 的循环变量" "for MAX_CONCURRENT_WORKERS in 2; do :; done"
variant "(( )) 里赋值" "((MAX_CONCURRENT_WORKERS=2))"
variant "unset 掉" "unset MAX_CONCURRENT_WORKERS"
variant "只是读了一下" ': "$MAX_CONCURRENT_WORKERS"'
variant "最外层 + 没执行的条件里再赋值" "MAX_CONCURRENT_WORKERS=1${NL}if false; then MAX_CONCURRENT_WORKERS=2; fi"
variant "最外层 + 执行了的 +=" "MAX_CONCURRENT_WORKERS=1${NL}true && MAX_CONCURRENT_WORKERS+=2"
# 词的边界：名字是别的词的一部分、紧挨着数字 / 下划线 / 非 ASCII 字节
variant "名字是别的词的前缀 / 后缀" "MAX_CONCURRENT_WORKERS=1${NL}XMAX_CONCURRENT_WORKERS=2${NL}MAX_CONCURRENT_WORKERS_X=3${NL}N1MAX_CONCURRENT_WORKERS=4"
variant "名字紧挨着非 ASCII 字节" "MAX_CONCURRENT_WORKERS=1${NL}NOTE=\"中MAX_CONCURRENT_WORKERS中\""
variant "名字紧挨着标点" "MAX_CONCURRENT_WORKERS=1${NL}NOTE=\"x-MAX_CONCURRENT_WORKERS.y\""
# 写法
variant "export 字面值" "export MAX_CONCURRENT_WORKERS=1"
variant "最外层但缩进" "  MAX_CONCURRENT_WORKERS=1"
variant "行尾注释" "MAX_CONCURRENT_WORKERS=1   # 并发"
variant "写成空值" 'MAX_CONCURRENT_WORKERS=""'
variant "注释里提到" "MAX_CONCURRENT_WORKERS=1${NL}# MAX_CONCURRENT_WORKERS=9 见文档${NL}# POLL_IDLE_PROBE=false"
# 值的末尾有换行、只有换行（以前经两次命令替换去掉末尾换行，只剩换行的回落到默认值；PR #664 复审第 1 轮）
sample "值的末尾有换行" "$(base_config)${NL}WORKER_MODEL=\$'opus\\n'${NL}OUTPUT_LANGUAGE=\$'en\\n\\n'${NL}"
sample "值只有换行" "$(base_config)${NL}RETROSPECTIVE_MODEL=\$'\\n'${NL}DISPATCH_MAX_RETRIES=\$'\\n'${NL}"
sample "早期名字的值末尾有换行 / 只有换行" "$(base_config)${NL}RELAY_BOT_ACCOUNT=\$'old-bot\\n'${NL}LABEL_PENDING_RELAY=\$'\\n'${NL}"
# 早期名字（daemon 照样认）：写在文件里、和新名字并存、只在没执行的分支里
sample "早期名字写在文件里" "$(base_config)${NL}RELAY_BOT_ACCOUNT=\"old-bot\"${NL}LABEL_PENDING_RELAY=\"pending/relay\"${NL}"
sample "早期名字和新名字并存" "$(base_config)${NL}REQUESTER_BOT_ACCOUNT=\"new-bot\"${NL}RELAY_BOT_ACCOUNT=\"old-bot\"${NL}"
sample "早期名字在没执行的分支里" "$(base_config)${NL}if false; then RELAY_REPORT_FIRST=true; fi${NL}"
# 文件形状
sample "没有末尾换行" "$(base_config)${NL}LOG_TAIL=\"x\""
sample "CRLF 行" "$(base_config)${NL}AUTO_CLEANUP_ON_MERGE=true"$'\r'"${NL}"
sample "含 NUL 字节" "$(base_config)${NL}"; printf 'NOTE=1\000x\n' >> "$SAMPLES/$NS"
sample "加载失败" "$(base_config)${NL}if then fi (${NL}"
sample "配置模板全文" "$(cat "$REPO_DIR/cavil-loop.config.example")${NL}STATE_DIR=\"\$HOME/st\"${NL}"

# 每个样本：get 比 JSON；三次 set（改两行 / 追加一项 / 早期名字那一项）比结果
SETS=('{"MAX_CONCURRENT_WORKERS":"4","REVIEW_MAX_ROUNDS":"7"}' '{"POLL_IDLE_PROBE":"false","DISPATCH_MAX_RETRIES":"3"}' '{"REQUESTER_BOT_ACCOUNT":"bot2"}')
saved=0; refused=0; backups_ok=0
for n in $(seq 1 "$NS"); do
    name="$(cat "$SAMPLES/$n.name")"
    make_world "$SAMPLES/$n"; g_old="$(run_pc "$OLD" get widget; echo "rc=$?")"
    make_world "$SAMPLES/$n"; g_new="$(run_pc "$NEW" get widget; echo "rc=$?")"
    chk "$name：get 输出逐字节相同" "$g_new" "$g_old"
    rev="$({ printf '%s\n' "$CONF"; cat "$CONF"; } | sha256sum | cut -d' ' -f1)"
    for js in "${SETS[@]}"; do
        make_world "$SAMPLES/$n"; s_old="$(set_once "$OLD" "$js" "$rev")"
        # 第二次保存（基于第一次保存后的文件），改前改后各自接着做
        r2="$({ printf '%s\n' "$CONF"; cat "$CONF"; } | sha256sum | cut -d' ' -f1)"
        s_old2="$(set_once "$OLD" '{"MAX_CONCURRENT_WORKERS":"5"}' "$r2")"
        make_world "$SAMPLES/$n"; s_new="$(set_once "$NEW" "$js" "$rev")"
        r2="$({ printf '%s\n' "$CONF"; cat "$CONF"; } | sha256sum | cut -d' ' -f1)"
        s_new2="$(set_once "$NEW" '{"MAX_CONCURRENT_WORKERS":"5"}' "$r2")"
        chk "$name：set $js 结果相同" "$s_new" "$s_old"
        chk "$name：接着第二次保存，结果相同" "$s_new2" "$s_old2"
        for s in "$s_new" "$s_new2"; do
            case "$s" in *RESULT=saved*) saved=$((saved + 1)) ;; *RESULT=*) refused=$((refused + 1)) ;; esac
            case "$s" in *backup=bad*) chk "$name：备份存在、600、等于保存前的配置" bad ok ;; *backup=ok*) backups_ok=$((backups_ok + 1)) ;; esac
        done
    done
done
# 可达性：对拍不是「两边都什么都没做」——样本里既有写进去的保存，也有被拒的；备份确实核对过
chk "样本数" "$NS" 54
chk "有写进去的保存、有被拒的保存、备份核对过（各 > 10）" "$([ "$saved" -gt 10 ] && [ "$refused" -gt 10 ] && [ "$backups_ok" -gt 10 ] && echo yes)" yes
echo "  样本 $NS 个；写进去 $saved 次、被拒 $refused 次，核对备份 $backups_ok 份"

compat_summary
echo
echo "通过 $pass，失败 $fail"
report_counts "$pass" "$fail"
[ "$fail" = 0 ]
