#!/usr/bin/env bash
# kind: install
# 读 / 改一个已接项目的常用配置项（GitHub#388）：scripts/project-config.sh + scripts/config-fields.txt。
#
# 全部在假 HOME 下跑**真实**脚本，断言输出和落盘文件——不读源码文本。
#
#   1. get：值、配置文件里写没写、可不可改和原因；命令 / 钩子 / 令牌不出现；读不出不给值；改名前的旧安装
#   2. set：只动那几行、注释和权限保留、备份等于原文件、没写过的项追加、末尾无换行、软链接、和原值一样
#   3. 拒绝写入的每种情况文件不变，旁边各有一个合规的同样保存确实写进去了
#   3b. 赋值写在 if / 循环 / case / 函数 / { } 组里、接在别的命令后面（缩进或不缩进、执行或没执行）→ 只显示，
#       显示的是 daemon 实际用的值；写成空值的行显示默认值
#       一行写完的 if / 函数、接在 && 后面、declare / read / printf -v / ${…:=…} 等写法同样只显示、不许追加；
#       结构读不出来时所有项只显示
#   4. 保存进行中的外部写入：在真实的 cp / mv 前后插入一次外部修改（包装命令，脚本没有测试开关）
#   5. 两次保存同时发生
#   6. 备份是内容快照、只留最近 10 份
#   7. 登记表：每项都在配置模板里；「不写时的值」和登记册、和真实加载 _lib.sh 后的值一致；禁止的类别不在里面
#   8. 文档里写给人照做的命令，按字面在空环境跑通（中英两份一字不差）
#   9. 关掉往返记录的文档步骤：同样照字面跑，正常、已关、读不了、保存前被改、没地方备份、写入后被改、换上后保存进程被杀、
#      读回失败；关掉前后的「有没有条目在来回中」检查（IDLE / BUSY / UNKNOWN）和重新打开（关掉之后写入命令立刻拒收、
#      重新打开后照常写入，由 tests/round-log.test.sh 第 4a 组测）
#
#   bash tests/project-config.test.sh
set -uo pipefail
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT
export TZ=UTC
PC="$REPO_DIR/scripts/project-config.sh"
SYS_PATH="$PATH"

pass=0; fail=0
chk() {
    if [ "$2" = "$3" ]; then echo "  ✅ $1"; pass=$((pass+1))
    else echo "  ❌ $1"; echo "     期望：[$3]"; echo "     实得：[$2]"; fail=$((fail+1)); fi
}
chk_has() {
    case "$2" in *"$3"*) echo "  ✅ $1"; pass=$((pass+1)) ;;
        *) echo "  ❌ $1（没找到 [$3]）"; printf '%s\n' "$2" | head -20 | sed 's/^/     | /'; fail=$((fail+1)) ;; esac
}
chk_lacks() {
    case "$2" in *"$3"*) echo "  ❌ $1（不该出现 [$3]）"; fail=$((fail+1)) ;;
        *) echo "  ✅ $1"; pass=$((pass+1)) ;; esac
}

H="$SANDBOX/h"; P="$SANDBOX/p/widget"; CONF="$P/cavil-loop.config"; ST="$H/st"
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
fresh_world() {
    rm -rf "$H" "$SANDBOX/p"; mkdir -p "$H/.config/cavil-loop" "$P"
    base_config > "$CONF"; chmod 640 "$CONF"
    printf 'PROJECT_ROOT=%s\nCODING_AGENT_CONFIG=%s\n' "$P" "$CONF" > "$H/.config/cavil-loop/widget.conf"
}
# 空环境跑脚本：只给 HOME 和 PATH（外加包装命令要的那几个变量）
run() { env -i HOME="$H" PATH="${RUN_PATH:-$SYS_PATH}" ${HOOK_ENV:+$HOOK_ENV} bash "$PC" "$@" 2>&1; }
rev_now() { run get "${1:-widget}" | jq -r .rev; }
save() {   # <key> <json> [rev] → 全部输出；RC 放退出码
    local key="$1" json="$2" rev="${3:-}"
    [ -n "$rev" ] || rev="$(rev_now "$key")"
    # __live__：get 读不出（配置坏了）时，直接按脚本的算法从文件算指纹
    [ "$rev" != __live__ ] || rev="$({ printf '%s\n' "$CONF"; cat "$CONF"; } | sha256sum | cut -d' ' -f1)"
    RC=0; OUT="$(printf '%s' "$json" | run set "$key" --rev "$rev" "${@:4}")" || RC=$?
    RESULT="$(printf '%s\n' "$OUT" | tail -1)"
    DETAIL="$(printf '%s\n' "$OUT" | sed -n 's/^DETAIL=//p' | tail -1)"
}
field() { jq -c --arg n "$2" '.fields[] | select(.name == $n) | [.value, .in_file, .editable]' <<<"$1"; }
why() { jq -r --arg n "$2" '.fields[] | select(.name == $n) | .reason // ""' <<<"$1"; }
sum() { sha256sum < "$1" | cut -d' ' -f1; }

echo "── 1. get ──"
fresh_world
G="$(run get widget)"; rc=$?
chk "退出 0、state=ok" "$rc $(jq -r .state <<<"$G")" "0 ok"
chk "配置文件位置来自项目登记" "$(jq -r .config <<<"$G")" "$CONF"
chk "双引号字面值：可改" "$(field "$G" WORKER_AGENT)" '["claude",true,true]'
chk "裸字面值：可改" "$(field "$G" MAX_CONCURRENT_WORKERS)" '["1",true,true]'
chk "单引号字面值：可改" "$(field "$G" REVIEW_MAX_ROUNDS)" '["6",true,true]'
chk "空字符串：可改" "$(field "$G" WORKER_MODEL)" '["",true,true]'
chk "没写的项：给 daemon 实际用的值，标「没写」，可改" "$(field "$G" DISPATCH_MAX_RETRIES)" '["3",false,true]'
chk "算式：给出加载后的值，只显示" "$(field "$G" BLOCKED_RECHECK_SECS)" '["300",true,false]'
chk_has "算式：写明原因" "$(why "$G" BLOCKED_RECHECK_SECS)" "算式"
chk "缩进在 if 里的赋值：只显示" "$(field "$G" SELFHEAL_MAX_RETRIES)" '["5",true,false]'
chk "两处赋值：只显示，值是加载后的" "$(field "$G" LOG_LEVEL)" '["debug",true,false]'
chk_has "两处赋值：写明原因" "$(why "$G" LOG_LEVEL)" "2 处"
chk "值不是标准写法的开关：只显示" "$(field "$G" COMMENT_FOOTER)" '["yes",true,false]'
chk "只显示的项：给值、不可改" "$(field "$G" LABEL_PENDING_REVIEW)$(jq -r '.fields[] | select(.name=="LABEL_PENDING_REVIEW") | .mode' <<<"$G")" '["pending/review",true,false]show'
chk "agent 的可选项 = daemon 自带的 driver" "$(jq -c '[.fields[] | select(.name=="WORKER_AGENT") | .options[].value] | sort' <<<"$G")" \
    "$(cd "$REPO_DIR/scripts/drivers" && ls *.sh | grep -v '^_' | sed 's/\.sh$//' | jq -Rcs 'split("\n") | map(select(. != "")) | sort')"
chk "整数项带范围" "$(jq -c '.fields[] | select(.name=="MAX_CONCURRENT_WORKERS") | [.type,.min,.max]' <<<"$G")" '["int",1,16]'
# 层级（GitHub#591）：每项的 tier 就是登记表第 9 列，原样交给客户端
chk "每项都带层级，和登记表第 9 列逐项相同" "$(jq -r '.fields[] | "\(.name) \(.tier // "缺")"' <<<"$G")" \
    "$(grep -vE '^[[:space:]]*(#|$)' "$REPO_DIR/scripts/config-fields.txt" | awk -F'|' '{n = $1; t = $9; gsub(/[ \t]/, "", n); gsub(/[ \t]/, "", t); print n, t}')"
chk "三种层级的项数（常用 18 / 组内高级 26 / 高级 40）" "$(jq -r '[.fields[].tier] | group_by(.) | map("\(.[0])=\(length)") | join(" ")' <<<"$G")" "advanced=40 main=18 more=26"
chk_lacks "令牌的值不在输出里" "$G" "ghp_TESTSECRET0000"
chk_lacks "命令的值不在输出里" "$G" "npm ci"
chk "命令 / 钩子 / 令牌不是输出的字段" "$(jq -c '[.fields[].name] | map(select(test("CMD|HOOK|TOKEN|EXEC|URL|ROOT|_DIR$|^REPO$|PREFIX")))' <<<"$G")" '[]'
# 环境里的同名变量不能冒充「配置里设了」
G2="$(env -i HOME="$H" PATH="$SYS_PATH" DISPATCH_MAX_RETRIES=9 bash "$PC" get widget)"
chk "调用方环境里的同名变量不算数" "$(field "$G2" DISPATCH_MAX_RETRIES)" '["3",false,true]'

printf 'if then fi (\n' >> "$CONF"
G="$(run get widget)"; rc=$?
chk "配置加载失败：unreadable，退出 2，不给任何值" "$rc $(jq -r '.state' <<<"$G") $(jq -r '.fields | type' <<<"$G")" "2 unreadable null"
G="$(run get nosuch)"; rc=$?
chk "没有这个项目：not_found，退出 1" "$rc $(jq -r .state <<<"$G")" "1 not_found"
G="$(run get '../x')"; rc=$?
chk "项目名不合规：退出 1" "$rc $(jq -r .state <<<"$G")" "1 not_found"

fresh_world
mkdir -p "$H/.config/coding-agent-work-loop" "$SANDBOX/p/old"
base_config | sed 's/acme\/widget/acme\/old/' > "$SANDBOX/p/old/coding-agent.config"
printf 'PROJECT_ROOT=%s\nCODING_AGENT_CONFIG=%s\n' "$SANDBOX/p/old" "$SANDBOX/p/old/coding-agent.config" > "$H/.config/coding-agent-work-loop/old.conf"
G="$(run get old)"
chk "改名前的旧安装：能读" "$(jq -r .state <<<"$G") $(field "$G" WORKER_AGENT)" 'ok ["claude",true,true]'
save old '{"MAX_CONCURRENT_WORKERS":"4"}'
chk "改名前的旧安装：能改" "$RESULT $(grep -c '^MAX_CONCURRENT_WORKERS=4$' "$SANDBOX/p/old/coding-agent.config")" "RESULT=saved 1"

echo "── 2. set：只动那几行 ──"
fresh_world; cp "$CONF" "$SANDBOX/orig"
save widget '{"MAX_CONCURRENT_WORKERS":"2","WORKER_AGENT":"codex","REVIEW_MAX_ROUNDS":"8","WORKER_MODEL":"opus-5.5"}'
chk "改四项：saved，退出 0" "$RC $RESULT" "0 RESULT=saved"
chk "和原文件的差别只有这四行（引号写法、行尾注释都保留）" "$(diff "$SANDBOX/orig" "$CONF" | grep '^[<>]' | sort)" \
"$(printf '%s\n' '< MAX_CONCURRENT_WORKERS=1' '< REVIEW_MAX_ROUNDS='"'6'" '< WORKER_AGENT="claude"   # 干活的 agent' '< WORKER_MODEL=""' \
   '> MAX_CONCURRENT_WORKERS=2' '> REVIEW_MAX_ROUNDS='"'8'" '> WORKER_AGENT="codex"   # 干活的 agent' '> WORKER_MODEL="opus-5.5"' | sort)"
chk "文件权限不变" "$(stat -c %a "$CONF")" "640"
BK="$(jq -r .backup <<<"$DETAIL")"
chk "备份等于保存前的文件，权限 600，在项目状态目录里" "$(cmp -s "$BK" "$SANDBOX/orig" && echo same) $(stat -c %a "$BK") $(dirname "$BK")" "same 600 $ST/config-backups"
chk "结果里逐项列出原值和新值" "$(jq -c '[.changes[] | [.name,.old,.new,.added]] | sort' <<<"$DETAIL")" \
    '[["MAX_CONCURRENT_WORKERS","1","2",false],["REVIEW_MAX_ROUNDS","6","8",false],["WORKER_AGENT","claude","codex",false],["WORKER_MODEL","","opus-5.5",false]]'
chk "保存后再读：就是新值" "$(field "$(run get widget)" WORKER_AGENT)" '["codex",true,true]'
chk "没有残留的临时文件" "$(ls -A "$P" | grep -c 'pc-')" "0"

cp "$CONF" "$SANDBOX/orig"
save widget '{"POLL_IDLE_PROBE":"false","DISPATCH_MAX_RETRIES":"3"}'
chk "没写过的项：追加在末尾，前面的字节不动" "$RESULT $(head -c "$(wc -c < "$SANDBOX/orig")" "$CONF" | cmp -s - "$SANDBOX/orig" && echo prefix-same) $(tail -2 "$CONF" | tr '\n' ' ')" \
    'RESULT=saved prefix-same POLL_IDLE_PROBE="false" DISPATCH_MAX_RETRIES="3" '
chk "没写过的项即使等于默认值也写进去（算已决定）" "$(jq -c '[.changes[] | select(.name=="DISPATCH_MAX_RETRIES") | .added]' <<<"$DETAIL")" '[true]'
before="$(sum "$CONF")"
save widget '{"POLL_IDLE_PROBE":"false","MAX_CONCURRENT_WORKERS":"2"}'
chk "要写的值和文件里一样：unchanged，文件不变" "$RC $RESULT $(sum "$CONF")" "0 RESULT=unchanged $before"

fresh_world; printf 'LOG_TAIL="x"' >> "$CONF"; cp "$CONF" "$SANDBOX/orig"
save widget '{"MAX_CONCURRENT_WORKERS":"3","AUTO_CLEANUP_ON_MERGE":"false"}'
chk "原文件末尾没有换行：改行不补换行、追加前补一个" "$RESULT $(tail -2 "$CONF" | tr '\n' '|')" 'RESULT=saved LOG_TAIL="x"|AUTO_CLEANUP_ON_MERGE="false"|'
save widget '{"MAX_CONCURRENT_WORKERS":"5"}'
fresh_world; printf 'LOG_TAIL="x"' >> "$CONF"
save widget '{"MAX_CONCURRENT_WORKERS":"3"}'
chk "只改行、不追加：末尾仍然没有换行" "$RESULT $(tail -c 12 "$CONF")" 'RESULT=saved LOG_TAIL="x"'

fresh_world; mkdir -p "$SANDBOX/p/real"; mv "$CONF" "$SANDBOX/p/real/the.config"; ln -s "$SANDBOX/p/real/the.config" "$CONF"
save widget '{"MAX_CONCURRENT_WORKERS":"2"}'
chk "配置文件是软链接：写到它指向的文件，软链接还在" "$RESULT $([ -L "$CONF" ] && echo link) $(grep -c '^MAX_CONCURRENT_WORKERS=2$' "$SANDBOX/p/real/the.config")" "RESULT=saved link 1"

echo "── 3. 拒绝写入：文件不变；旁边同样的合规保存写得进去 ──"
refuse() {   # <标题> <json> <期望 RESULT> [rev]
    fresh_world; [ -z "${PREP:-}" ] || eval "$PREP"
    local before; before="$(sum "$CONF")"
    save widget "$2" "${4:-}"
    chk "$1 → $3，退出非 0，文件不变" "$RESULT $([ "$RC" != 0 ] && echo nz) $(sum "$CONF")" "RESULT=$3 nz $before"
    chk "$1：没有残留的临时文件" "$(ls -A "$P" | grep -c 'pc-')" "0"
}
refuse "算式写的项" '{"BLOCKED_RECHECK_SECS":"600"}' not_editable
refuse "if 里的赋值" '{"SELFHEAL_MAX_RETRIES":"2"}' not_editable
refuse "两处赋值的项" '{"LOG_LEVEL":"info"}' not_editable
refuse "只显示的项" '{"LABEL_AUTOPILOT":"autopilot"}' not_editable
refuse "只显示的项（派工模式）" '{"DISPATCH_MODE":"greedy"}' not_editable
refuse "命令（不在登记表里）" '{"WORKTREE_SETUP_CMD":"true"}' not_editable
refuse "令牌（不在登记表里）" '{"GH_TOKEN":"x"}' not_editable
refuse "一项合规 + 一项不可改：整个不写" '{"MAX_CONCURRENT_WORKERS":"2","GH_TOKEN":"x"}' not_editable
refuse "数字越界" '{"MAX_CONCURRENT_WORKERS":"17"}' invalid
refuse "数字是 0（下限 1）" '{"MAX_CONCURRENT_WORKERS":"0"}' invalid
refuse "不是数字" '{"MAX_CONCURRENT_WORKERS":"2; rm -rf x"}' invalid
refuse "不在可选值里" '{"OUTPUT_LANGUAGE":"xx"}' invalid
refuse "不是 daemon 自带的 agent" '{"WORKER_AGENT":"nosuchagent"}' invalid
refuse "带双引号" '{"WORKER_MODEL":"a\"b"}' invalid
refuse "带 \$" '{"WORKER_MODEL":"$HOME"}' invalid
refuse "带反引号" '{"WORKER_MODEL":"`id`"}' invalid
refuse "带换行" '{"WORKER_MODEL":"a\nGH_TOKEN=x"}' invalid
refuse "带空格" '{"WORKER_MODEL":"a b"}' invalid
refuse "值不是字符串" '{"MAX_CONCURRENT_WORKERS":2}' invalid
refuse "空对象" '{}' invalid
refuse "一项合规 + 一项不合规：整个不写" '{"MAX_CONCURRENT_WORKERS":"2","REVIEW_MAX_ROUNDS":"99"}' invalid
refuse "指纹过期（读取之后文件被改过）" '{"MAX_CONCURRENT_WORKERS":"2"}' changed "0000"
PREP='printf "if then fi (\n" >> "$CONF"' refuse "配置加载失败" '{"MAX_CONCURRENT_WORKERS":"2"}' unreadable "__live__"
PREP='rm -rf "$ST"; mkdir -p "$ST"; : > "$ST/config-backups"' refuse "备份目录写不进（那里是个文件）" '{"MAX_CONCURRENT_WORKERS":"2"}' backup_failed
PREP='echo "STAMP=\$RANDOM\$RANDOM\$RANDOM" >> "$CONF"' refuse "每次加载结果都不一样的配置（验证不了其余项没变）" '{"MAX_CONCURRENT_WORKERS":"2"}' verify_failed
PREP='sed -i "s|^STATE_DIR=.*|STATE_DIR=\"relative/st\"|" "$CONF"' refuse "状态目录不是绝对路径（没处放备份）" '{"MAX_CONCURRENT_WORKERS":"2"}' backup_failed
fresh_world
save widget '{"MAX_CONCURRENT_WORKERS":"2"}'
chk "可达性：同一个世界里合规的保存确实写进去了" "$RESULT $(grep -c '^MAX_CONCURRENT_WORKERS=2$' "$CONF")" "RESULT=saved 1"
fresh_world
RC=0; OUT="$(printf '{"MAX_CONCURRENT_WORKERS":"2"}' | run set widget)" || RC=$?
chk "不带 --rev：不写" "$(tail -1 <<<"$OUT") $(grep -c '^MAX_CONCURRENT_WORKERS=1$' "$CONF")" "RESULT=invalid 1"

echo "── 3b. 赋值在结构里面：看结构不看缩进；实际生效的值和「能不能改」分开算 ──"
# 每个夹具：把并发数那一行换成一种写法。断言 get 给出的值、是否可改；强行保存被拒、文件不变；
# 同一份文件里另一项最外层的字面值照常能改（可达性）。
structure_case() {   # <标题> <期望值> <替换 MAX_CONCURRENT_WORKERS=1 的多行文本>
    fresh_world
    python3 - "$CONF" "$3" <<'PY'
import sys
p, block = sys.argv[1], sys.argv[2]
t = open(p, encoding='utf-8').read()
assert t.count('MAX_CONCURRENT_WORKERS=1\n') == 1
open(p, 'w', encoding='utf-8').write(t.replace('MAX_CONCURRENT_WORKERS=1\n', block + '\n'))
PY
    local g before; g="$(run get widget)"; before="$(sum "$CONF")"
    chk "$1：值 $2、只显示、不算「配置文件里没写」" "$(jq -r .state <<<"$g") $(field "$g" MAX_CONCURRENT_WORKERS)" "ok [\"$2\",true,false]"
    save widget '{"MAX_CONCURRENT_WORKERS":"4"}'
    chk "$1：强行保存 → not_editable，文件不变（既没改行也没在末尾追加）" "$RESULT $(sum "$CONF")" "RESULT=not_editable $before"
    save widget '{"REVIEW_MAX_ROUNDS":"7"}'
    chk "$1：同一份文件里最外层的另一项照常能改" "$RESULT $(grep -c "^REVIEW_MAX_ROUNDS='7'\$" "$CONF")" "RESULT=saved 1"
}
NL=$'\n'
structure_case "if 里、执行了、不缩进" 2 "if true; then${NL}MAX_CONCURRENT_WORKERS=2${NL}fi"
structure_case "if 里、执行了、缩进" 2 "if true; then${NL}    MAX_CONCURRENT_WORKERS=2${NL}fi"
structure_case "if 里、没执行、不缩进（daemon 实际按默认值 1 工作）" 1 "if false; then${NL}MAX_CONCURRENT_WORKERS=2${NL}fi"
structure_case "if 里、没执行、缩进" 1 "if false; then${NL}    MAX_CONCURRENT_WORKERS=2${NL}fi"
structure_case "else 分支里" 3 "if false; then${NL}:${NL}else${NL}MAX_CONCURRENT_WORKERS=3${NL}fi"
structure_case "循环里" 2 "for _x in 1; do${NL}MAX_CONCURRENT_WORKERS=2${NL}done"
structure_case "case 里" 2 "case x in${NL}x)${NL}MAX_CONCURRENT_WORKERS=2${NL};;${NL}esac"
structure_case "{ } 组里" 2 "{${NL}MAX_CONCURRENT_WORKERS=2${NL}}"
structure_case "函数里（调用了）" 2 "set_it() {${NL}MAX_CONCURRENT_WORKERS=2${NL}}${NL}set_it"
structure_case "函数里（没调用）" 1 "set_it() {${NL}MAX_CONCURRENT_WORKERS=2${NL}}"
structure_case "接在 && 后面的下一行" 2 "true &&${NL}MAX_CONCURRENT_WORKERS=2"
structure_case "接在 || 后面的下一行（没执行）" 1 "true ||${NL}MAX_CONCURRENT_WORKERS=2"
structure_case "here-doc 里的同名字样（不是赋值）" 1 ": <<DOC${NL}MAX_CONCURRENT_WORKERS=2${NL}DOC"
structure_case "多行字符串里的同名字样（不是赋值）" 1 "NOTE=\"${NL}MAX_CONCURRENT_WORKERS=2${NL}\""
structure_case "续行里（成了别的命令的参数）" 1 "true \\${NL}MAX_CONCURRENT_WORKERS=2"

# 写在一行里的结构、以及不是 KEY= 开头的各种写法：行首找不到赋值，不等于文件里没有这一项——
# 一样只显示、不许在末尾追加一行把它盖掉（PR #399 代码复审第 2 轮）
structure_case "一行写完的 if（没执行）" 1 "if false; then MAX_CONCURRENT_WORKERS=2; fi"
structure_case "一行写完的 if（执行了）" 2 "if true; then MAX_CONCURRENT_WORKERS=2; fi"
structure_case "一行写完的函数（没调用）" 1 "set_it() { MAX_CONCURRENT_WORKERS=2; }"
structure_case "一行写完的函数（调用了）" 2 "set_it() { MAX_CONCURRENT_WORKERS=2; }; set_it"
structure_case "同一行接在 && 后面（执行了）" 2 "true && MAX_CONCURRENT_WORKERS=2"
structure_case "同一行接在 && 后面（没执行）" 1 "false && MAX_CONCURRENT_WORKERS=2"
structure_case "同一行接在 ; 后面" 2 ": ; MAX_CONCURRENT_WORKERS=2"
structure_case "一行里的 { } 组" 2 "{ MAX_CONCURRENT_WORKERS=2; }"
structure_case "一行里的 for 循环体" 2 "for _x in 1; do MAX_CONCURRENT_WORKERS=2; done"
structure_case "一行里的 case" 2 "case x in x) MAX_CONCURRENT_WORKERS=2 ;; esac"
structure_case "同一行两个赋值、这一项在后面" 2 "PC_OTHER=1 MAX_CONCURRENT_WORKERS=2"
structure_case "declare 赋值" 2 "declare MAX_CONCURRENT_WORKERS=2"
structure_case "只 export、不赋值" 1 "export MAX_CONCURRENT_WORKERS"
structure_case "\${…:=…} 给默认值（执行了）" 2 ': "${MAX_CONCURRENT_WORKERS:=2}"'
structure_case "\${…:=…} 给默认值（没执行）" 1 'false && : "${MAX_CONCURRENT_WORKERS:=2}"'
structure_case "read 读进来" 2 "read -r MAX_CONCURRENT_WORKERS <<<2"
structure_case "printf -v 写进去" 2 "printf -v MAX_CONCURRENT_WORKERS %s 2"
structure_case "当作 for 的循环变量" 2 "for MAX_CONCURRENT_WORKERS in 2; do :; done"
structure_case "(( )) 里赋值" 2 "((MAX_CONCURRENT_WORKERS=2))"
structure_case "unset 掉" 1 "unset MAX_CONCURRENT_WORKERS"
structure_case "只是读了一下它的值" 1 ': "$MAX_CONCURRENT_WORKERS"'
# 最外层那一行本身是普通字面值，但别处还提到这一项：不是「只有这一处」，同样只显示
structure_case "最外层字面值 + 后面没执行的条件里再赋值" 1 "MAX_CONCURRENT_WORKERS=1${NL}if false; then MAX_CONCURRENT_WORKERS=2; fi"
structure_case "最外层字面值 + 后面执行了的 += " 12 "MAX_CONCURRENT_WORKERS=1${NL}true && MAX_CONCURRENT_WORKERS+=2"
# 注释里提到不算（配置模板里大量「# KEY=…」的示例行）：照常可改、可追加
fresh_world; printf '# MAX_CONCURRENT_WORKERS=9 的写法见文档\n# POLL_IDLE_PROBE=false\n' >> "$CONF"
G="$(run get widget)"
chk "注释里提到这一项不算：最外层的字面值照常可改，没写的项照常算没写" "$(field "$G" MAX_CONCURRENT_WORKERS) $(field "$G" POLL_IDLE_PROBE)" '["1",true,true] ["true",false,true]'
save widget '{"MAX_CONCURRENT_WORKERS":"2","POLL_IDLE_PROBE":"false"}'
chk "……保存：一处改行、一处追加" "$RESULT $(grep -c '^MAX_CONCURRENT_WORKERS=2$' "$CONF") $(tail -1 "$CONF")" 'RESULT=saved 1 POLL_IDLE_PROBE="false"'

# 结构读不出来：不知道有没有、在哪 → 所有项只显示，改行和追加都不许（读不出 ≠ 没有）
# 轮询会用的那个 bash 换成一个包装：只有「读结构」那一次调用失败，其余照常
fresh_world; NOSTRUCT="$SANDBOX/nostruct"; mkdir -p "$NOSTRUCT"
printf '#!%s\ncase "$*" in *__pc_fn*) exit 3 ;; esac\nexec %s "$@"\n' "$(command -v bash)" "$(command -v bash)" > "$NOSTRUCT/bash"; chmod +x "$NOSTRUCT/bash"
G="$(RUN_PATH="$NOSTRUCT:$SYS_PATH" run get widget)"; before="$(sum "$CONF")"
chk "结构读不出来：state 仍是 ok（值照常给），可改的项一个都没有" "$(jq -r .state <<<"$G") $(jq '[.fields[] | select(.editable)] | length' <<<"$G") $(field "$G" MAX_CONCURRENT_WORKERS) $(field "$G" POLL_IDLE_PROBE)" 'ok 0 ["1",true,false] ["true",true,false]'
chk_has "结构读不出来：写明原因" "$(why "$G" MAX_CONCURRENT_WORKERS)" "读不出配置文件的结构"
rev="$(jq -r .rev <<<"$G")"
RUN_PATH="$NOSTRUCT:$SYS_PATH" save widget '{"MAX_CONCURRENT_WORKERS":"2"}' "$rev"
chk "结构读不出来：改已有的行 → not_editable，文件不变" "$RESULT $(sum "$CONF")" "RESULT=not_editable $before"
RUN_PATH="$NOSTRUCT:$SYS_PATH" save widget '{"POLL_IDLE_PROBE":"false"}' "$rev"
chk "结构读不出来：追加没写的项 → not_editable，文件不变" "$RESULT $(sum "$CONF")" "RESULT=not_editable $before"
# 数「名字出现几次」的 awk、找原文件赋值行的那次 grep：先打印完整的结果、再以失败退出，也算读不出——
# 不能只看输出的行数（PR #664 复审第 1 轮）。包装真实的 awk / grep，其余调用照常
for broken in awk grep; do
    BROKE="$SANDBOX/broke-$broken"; rm -rf "$BROKE"; mkdir -p "$BROKE"
    if [ "$broken" = awk ]; then
        printf '#!%s\n%s "$@"\nexit 2\n' "$(type -P bash)" "$(type -P awk)" > "$BROKE/awk"
    else
        printf '#!%s\ncase "$*" in *"[A-Za-z0-9_]+="*) %s "$@"; exit 2 ;; esac\nexec %s "$@"\n' "$(type -P bash)" "$(type -P grep)" "$(type -P grep)" > "$BROKE/grep"
    fi
    chmod +x "$BROKE/$broken"
    G="$(RUN_PATH="$BROKE:$SYS_PATH" run get widget)"; before="$(sum "$CONF")"
    chk "$broken 打印完结果后失败：state 仍是 ok，可改的项一个都没有" "$(jq -r .state <<<"$G") $(jq '[.fields[] | select(.editable)] | length' <<<"$G")" 'ok 0'
    chk_has "$broken 打印完结果后失败：写明原因" "$(why "$G" MAX_CONCURRENT_WORKERS)" "读不出配置文件的结构"
    RUN_PATH="$BROKE:$SYS_PATH" save widget '{"MAX_CONCURRENT_WORKERS":"2"}' "$(jq -r .rev <<<"$G")"
    chk "$broken 打印完结果后失败：改已有的行 → not_editable，文件不变" "$RESULT $(sum "$CONF")" "RESULT=not_editable $before"
    RUN_PATH="$BROKE:$SYS_PATH" save widget '{"POLL_IDLE_PROBE":"false"}' "$(jq -r .rev <<<"$G")"
    chk "$broken 打印完结果后失败：追加没写的项 → not_editable，文件不变" "$RESULT $(sum "$CONF")" "RESULT=not_editable $before"
done
save widget '{"MAX_CONCURRENT_WORKERS":"2","POLL_IDLE_PROBE":"false"}' "$rev"
chk "可达性：同一份文件、结构读得出来时这两项都写得进去" "$RESULT $(grep -c '^MAX_CONCURRENT_WORKERS=2$' "$CONF") $(tail -1 "$CONF")" 'RESULT=saved 1 POLL_IDLE_PROBE="false"'

# 写成空值：各处都是「空 = 用默认值」，表单显示默认值；这一行是普通字面值，可以改
fresh_world; sed -i 's/^MAX_CONCURRENT_WORKERS=1$/MAX_CONCURRENT_WORKERS=""/' "$CONF"
G="$(run get widget)"
chk "写成空值：显示 daemon 实际用的默认值 1，可改" "$(field "$G" MAX_CONCURRENT_WORKERS)" '["1",true,true]'
save widget '{"MAX_CONCURRENT_WORKERS":"3"}'
chk "写成空值的行改成 3：只换引号里的值" "$RESULT $(grep -c '^MAX_CONCURRENT_WORKERS="3"$' "$CONF") $(jq -c '[.changes[] | [.old,.new]]' <<<"$DETAIL")" 'RESULT=saved 1 [["1","3"]]'
fresh_world; sed -i 's/^MAX_CONCURRENT_WORKERS=1$/MAX_CONCURRENT_WORKERS=""/' "$CONF"
save widget '{"MAX_CONCURRENT_WORKERS":"1"}'
chk "写成空值的行改成等于默认值的 1：也写进去（文件里原来不是这个值）" "$RESULT $(grep -c '^MAX_CONCURRENT_WORKERS="1"$' "$CONF")" 'RESULT=saved 1'
# 只显示的项同样给实际生效的值
fresh_world; sed -i 's/^DISPATCH_MODE="label"$/DISPATCH_MODE=""/' "$CONF"
chk "只显示的项写成空值：显示默认值" "$(field "$(run get widget)" DISPATCH_MODE)" '["label",true,false]'
# 配置文件整体解析不了结构时不会走到这里（加载就失败了）；最外层的字面值缩进与否：缩进的仍然只显示
fresh_world; sed -i 's/^MAX_CONCURRENT_WORKERS=1$/  MAX_CONCURRENT_WORKERS=1/' "$CONF"
chk "最外层但缩进了的行：只显示（只改顶格写的那种）" "$(field "$(run get widget)" MAX_CONCURRENT_WORKERS)" '["1",true,false]'

echo "── 4. 保存进行中的外部写入（包装真实的 cp / mv）──"
HK="$SANDBOX/hook"; mkdir -p "$HK"
REAL_CP="$(command -v cp)"; REAL_MV="$(command -v mv)"
cat > "$HK/_hook.sh" <<HOOK
# 在指定时机做一次外部修改；每次运行只触发一次
hook() {   # <时机>
    [ "\${HOOK_MODE%%:*}" = "\$1" ] || return 0
    [ -e "\$HOOK_LOG.fired" ] && return 0
    : > "\$HOOK_LOG.fired"
    case "\${HOOK_MODE#*:}" in
        inplace) printf '\n# 外部就地改写\nEXT_MARK="1"\n' >> "\$HOOK_CONF" ;;
        replace) printf '# 外部另写一份再替换\nEXT_MARK="1"\n' > "\$HOOK_CONF.ext" && "$REAL_MV" -f "\$HOOK_CONF.ext" "\$HOOK_CONF" ;;
        relink)  ln -sfn "\$HOOK_OTHER" "\$HOOK_LINK" ;;
        oldfd)   printf '# 保存前就开着的旧文件\nEXT_MARK="1"\n' >&9 ;;
        slow)    sleep 2 ;;
        # 一直停在这里（锁还拿着），直到测试留下放行文件；最多等 60 秒，测试出错时也不会卡住
        hold)    for _ in \$(seq 600); do [ -e "\$HOOK_LOG.release" ] && break; sleep 0.1; done ;;
    esac
}
HOOK
cat > "$HK/cp" <<HOOK
#!/usr/bin/env bash
. "$HK/_hook.sh"
dest="\${@: -1}"; echo "cp \$dest" >> "\$HOOK_LOG"
"$REAL_CP" "\$@"; rc=\$?
case "\$dest" in *.pc-snap.*) hook after_snap ;; esac
exit \$rc
HOOK
cat > "$HK/mv" <<HOOK
#!/usr/bin/env bash
. "$HK/_hook.sh"
dest="\${@: -1}"; echo "mv \$dest" >> "\$HOOK_LOG"
[ "\$dest" = "\$HOOK_CONF" ] && hook before_mv
"$REAL_MV" "\$@"; rc=\$?
[ "\$dest" = "\$HOOK_CONF" ] && hook after_mv
exit \$rc
HOOK
chmod +x "$HK/cp" "$HK/mv"
HLOG="$SANDBOX/hook.log"
hooked() {   # <时机:动作> <json> [key]：带包装命令跑一次保存（指纹先取好）
    local rev; rev="$(rev_now "${3:-widget}")"
    rm -f "$HLOG" "$HLOG.fired"
    RUN_PATH="$HK:$SYS_PATH" HOOK_ENV="HOOK_MODE=$1 HOOK_LOG=$HLOG HOOK_CONF=${HOOK_CONF:-$CONF} HOOK_OTHER=${HOOK_OTHER:-x} HOOK_LINK=${HOOK_LINK:-x}" \
        save "${3:-widget}" "$2" "$rev" ${HOOK_ARGS:-}
}
writes_after_mv() {   # 改名之后脚本还有没有往配置文件 cp / mv
    awk -v c="${HOOK_CONF:-$CONF}" '$0 == "mv " c {seen++; next} seen && ($0 == "cp " c || $0 == "mv " c) {n++} END {print (seen+0) ":" (n+0)}' "$HLOG"
}
J='{"MAX_CONCURRENT_WORKERS":"2"}'

for how in inplace replace; do
    fresh_world; hooked "after_snap:$how" "$J"
    chk "取副本之后、最后核对之前，外部${how}：changed，没写" "$RESULT $(grep -c 'EXT_MARK' "$CONF") $(grep -c '^MAX_CONCURRENT_WORKERS=2$' "$CONF")" "RESULT=changed 1 0"
    chk "  ……外部修改真的发生了、脚本一次都没往配置文件改名、没有残留" "$([ -e "$HLOG.fired" ] && echo fired) $(grep -c "^mv $CONF\$" "$HLOG") $(ls -A "$P" | grep -c 'pc-')" "fired 0 0"
done
fresh_world; mkdir -p "$SANDBOX/p/real"; mv "$CONF" "$SANDBOX/p/real/a.config"; ln -s "$SANDBOX/p/real/a.config" "$CONF"
sed 's/acme\/widget/acme\/other/' "$SANDBOX/p/real/a.config" > "$SANDBOX/p/real/b.config"
sa="$(sum "$SANDBOX/p/real/a.config")"; sb="$(sum "$SANDBOX/p/real/b.config")"
HOOK_CONF="$SANDBOX/p/real/a.config" HOOK_OTHER="$SANDBOX/p/real/b.config" HOOK_LINK="$CONF" hooked "after_snap:relink" "$J"
chk "取副本之后软链接被指到另一个文件：changed，两个文件都不变" "$RESULT $(sum "$SANDBOX/p/real/a.config") $(sum "$SANDBOX/p/real/b.config") $(readlink "$CONF")" \
    "RESULT=changed $sa $sb $SANDBOX/p/real/b.config"

# 已声明保证不了的两种：照实断言现状（外部那一版丢了，脚本照常报已保存）
for how in inplace replace; do
    fresh_world; cp "$CONF" "$SANDBOX/orig"; hooked "before_mv:$how" "$J"
    chk "最后核对之后、换上之前，外部${how}：saved，文件是刚写的版本（外部那一版不在了）" \
        "$RESULT $([ -e "$HLOG.fired" ] && echo fired) $(grep -c 'EXT_MARK' "$CONF") $(grep -c '^MAX_CONCURRENT_WORKERS=2$' "$CONF")" "RESULT=saved fired 0 1"
    chk "  ……备份是保存前的版本；换上之后脚本没有再写配置文件" "$(cmp -s "$(jq -r .backup <<<"$DETAIL")" "$SANDBOX/orig" && echo same) $(writes_after_mv)" "same 1:0"
done

fresh_world; hooked "after_mv:replace" "$J"
chk "换上之后、读回之前，外部另写后替换：saved_then_changed，退出 4" "$RC $RESULT" "4 RESULT=saved_then_changed"
chk "  ……文件是外部版本，脚本没有再写它（不回滚、不恢复）" "$(cat "$CONF" | tr '\n' '|') $(writes_after_mv)" '# 外部另写一份再替换|EXT_MARK="1"| 1:0'
chk_has "  ……输出里给了备份位置" "$OUT" "$ST/config-backups/"

fresh_world; exec 9<>"$CONF"; hooked "after_mv:oldfd" "$J"; exec 9>&-
chk "保存前就开着的旧文件、换上之后才写：saved，文件是刚写的版本" \
    "$RESULT $([ -e "$HLOG.fired" ] && echo fired) $(grep -c 'EXT_MARK' "$CONF") $(grep -c '^MAX_CONCURRENT_WORKERS=2$' "$CONF") $(writes_after_mv)" "RESULT=saved fired 0 1 1:0"

fresh_world; hooked "none:none" "$J"
chk "可达性：同样的包装命令、不插入外部写入 → saved，恰好一次改名" "$RESULT $(grep -c "^mv $CONF\$" "$HLOG") $(grep -c '^MAX_CONCURRENT_WORKERS=2$' "$CONF")" "RESULT=saved 1 1"

echo "── 5. 两次保存同时发生 ──"
fresh_world
rev="$(rev_now)"
rm -f "$HLOG" "$HLOG.fired"
( printf '{"MAX_CONCURRENT_WORKERS":"2"}' | env -i HOME="$H" PATH="$HK:$SYS_PATH" HOOK_MODE=after_snap:slow HOOK_LOG="$HLOG" HOOK_CONF="$CONF" bash "$PC" set widget --rev "$rev" > "$SANDBOX/a.out" 2>&1 ) &
apid=$!
for _ in $(seq 50); do [ -e "$HLOG.fired" ] && break; sleep 0.1; done
save widget '{"REVIEW_MAX_ROUNDS":"9"}' "$rev"
wait "$apid"
chk "先到的 saved，后到的等到锁后发现文件已变：changed" "$(tail -1 "$SANDBOX/a.out") $RESULT" "RESULT=saved RESULT=changed"
chk "最终文件是先到那次的完整结果，不是两次的混合" "$(grep -c '^MAX_CONCURRENT_WORKERS=2$' "$CONF") $(grep -c "^REVIEW_MAX_ROUNDS='6'\$" "$CONF")" "1 1"
# 两个项目名指向同一个配置文件（其中一个经软链接）：同一把锁
fresh_world; mkdir -p "$SANDBOX/p/alias"; ln -s "$CONF" "$SANDBOX/p/alias/cavil-loop.config"
printf 'PROJECT_ROOT=%s\nCODING_AGENT_CONFIG=%s\n' "$SANDBOX/p/alias" "$SANDBOX/p/alias/cavil-loop.config" > "$H/.config/cavil-loop/alias.conf"
rev="$(rev_now)"; rev2="$(rev_now alias)"
chk "两个项目名、同一个真实文件：指纹相同" "$rev" "$rev2"
# 先到的那次停在拿着锁的地方，等这边放行；不靠固定睡几秒——机器忙时第二次保存可能在锁放开之后才到（PR #652 复审）
rm -f "$HLOG" "$HLOG.fired" "$HLOG.release"
( printf '{"MAX_CONCURRENT_WORKERS":"2"}' | env -i HOME="$H" PATH="$HK:$SYS_PATH" HOOK_MODE=after_snap:hold HOOK_LOG="$HLOG" HOOK_CONF="$CONF" bash "$PC" set widget --rev "$rev" > "$SANDBOX/a.out" 2>&1 ) &
apid=$!
for _ in $(seq 300); do [ -e "$HLOG.fired" ] && break; sleep 0.1; done
chk "到达性：先到的那次确实停在拿着锁的地方" "$([ -e "$HLOG.fired" ] && echo held) $(kill -0 "$apid" 2>/dev/null && echo running)" "held running"
save alias '{"REVIEW_MAX_ROUNDS":"9"}' "$rev2" --lock-wait 0
: > "$HLOG.release"
wait "$apid"
chk "另一个项目名同时保存、不肯等：busy，没写；先到的照常 saved" "$RESULT $(tail -1 "$SANDBOX/a.out") $(grep -c "^REVIEW_MAX_ROUNDS='6'\$" "$CONF")" "RESULT=busy RESULT=saved 1"

echo "── 6. 备份 ──"
fresh_world; cp "$CONF" "$SANDBOX/orig"
save widget '{"MAX_CONCURRENT_WORKERS":"2"}'; BK="$(jq -r .backup <<<"$DETAIL")"
printf '# later\n' >> "$CONF"
chk "备份是内容快照：之后再改配置文件，备份不变" "$(cmp -s "$BK" "$SANDBOX/orig" && echo same)" "same"
for n in 3 4 5 6 7 8 9 10 11 12 13; do save widget "{\"MAX_CONCURRENT_WORKERS\":\"$n\"}"; done
chk "保存 12 次后只留最近 10 份备份，最新一份在" "$(ls "$ST/config-backups" | wc -l | tr -d ' ') $([ -f "$(jq -r .backup <<<"$DETAIL")" ] && echo latest)" "10 latest"
: > "$ST/config-backups/keep-me.txt"; save widget '{"MAX_CONCURRENT_WORKERS":"1"}'
chk "清旧备份只动自己命名的文件" "$([ -e "$ST/config-backups/keep-me.txt" ] && echo kept)" "kept"

echo "── 7. 登记表 ──"
FIELDS="$REPO_DIR/scripts/config-fields.txt"; TPL="$REPO_DIR/cavil-loop.config.example"; NOTICES="$REPO_DIR/scripts/config-notices.txt"
col() { grep -vE '^[[:space:]]*(#|$)' "$FIELDS" | awk -F'|' -v n="$1" -v k="$2" '{gsub(/^[ \t]+|[ \t]+$/, "", $1)} $1 == k {v = $n; gsub(/^[ \t]+|[ \t]+$/, "", v); print v}'; }
names="$(grep -vE '^[[:space:]]*(#|$)' "$FIELDS" | awk -F'|' '{gsub(/[ \t]/, "", $1); print $1}')"
chk "登记表非空、没有重名" "$([ "$(wc -l <<<"$names")" -ge 20 ] && echo many) $(sort <<<"$names" | uniq -d | wc -l | tr -d ' ')" "many 0"
bad=""
for k in $names; do
    tv="$(sed -n "s/^$k=//p" "$TPL" | head -1)"
    grep -qE "^$k=" "$TPL" || { bad="$bad $k:不在模板里"; continue; }
    tv="${tv%%[[:space:]]#*}"; tv="${tv%\"}"; tv="${tv#\"}"
    def="$(col 4 "$k")"; def="${def%%;empty=*}"; type="$(col 3 "$k")"
    reg="$(grep -E "^$k[[:space:]]*\|" "$NOTICES" | head -1)"
    case "$reg" in
        *"| quiet | 不写这一行时的行为和模板里的值相同"*) [ "$def" = "$tv" ] || bad="$bad $k:登记册说和模板一样，模板[$tv]登记表[$def]" ;;
        # 必填项没有「不写时的值」：不写这一行 daemon 不加载（下面另外对拍），登记成空
        *"| quiet | 必填项，每个项目自己的值"*) [ -z "$def" ] || bad="$bad $k:必填项登记了不写时的值[$def]" ;;
        *"| notice |"*)
            off="$(awk -F'|' '{v = $4; gsub(/^[ \t]+|[ \t]+$/, "", v); print v}' <<<"$reg")"; off="${off%\"}"; off="${off#\"}"
            case "$type" in bool:*) [ -z "$off" ] && off="${type##*:}" ;; esac
            [ "$def" = "$off" ] || bad="$bad $k:登记册的不开值[$off]登记表[$def]" ;;
        *) bad="$bad $k:登记册里没有可对的条目" ;;
    esac
done
chk "每项都在配置模板里，「不写时的值」和配置项登记册（config-notices.txt）一致" "$bad" ""
# 真实加载 _lib.sh（配置里一项都不写）后的值
MIN="$SANDBOX/min"; mkdir -p "$MIN/proj" "$MIN/state" "$MIN/wt"
cat > "$MIN/cavil-loop.config" <<CONF
REPO="example/min"
PROJECT_ROOT="$MIN/proj"
WORKTREE_BASE="$MIN/wt"
STATE_DIR="$MIN/state"
TMUX_PREFIX="mintest"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
CONF
LIBKEYS="CONCURRENT_WORK_MAX_BYTES WORKER_AGENT WORKER_MODEL REVIEW_WORKER_AGENT REVIEW_MODEL REVIEW_MAX_ROUNDS REVIEW_DESIGN_PROPOSALS OUTPUT_LANGUAGE COMMENT_FOOTER BLOCKED_RECHECK_SECS BLOCKED_MAX_TRIES POLL_IDLE_PROBE LOG_LEVEL DISPATCH_MODE LABEL_PENDING_REVIEW LABEL_AUTOPILOT LABEL_PENDING_BLOCKED LABEL_PENDING_LATER STUCK_WORKER_QUIET_SECS STUCK_WORKER_STEP_GAP_SECS STUCK_WORKER_MAX_RESTARTS AUTOPILOT_HUMAN_PATHS_EXEMPT_TESTS AUTOPILOT_OUTSIDER_GUARD AUTOPILOT_OUTSIDER_SCREEN LABEL_PENDING_REQUESTER_BOT REQUESTER_BOT_REPORT_FIRST REQUESTER_BOT_WAKE_ANY_ITEM CI_FAILURE_REPORT_DISPATCH AUTO_RELEASE_MAIN_CHECKOUT SELFHEAL_ONLY_OWN_WORKERS FABLE_WORKER_AGENT FABLE_MODEL LABEL_PENDING_AGENT_FABLE LABEL_PENDING_AGENT_EXTRA LABEL_AGENT_DOING LABEL_PENDING_PR LABEL_DONE AUTOPILOT_MERGE_METHOD AUTOPILOT_CHECKS_TIMEOUT_HOURS USAGE_LIMIT_FALLBACK_SECS HEAVY_TEST_LOCK_WAIT CHECKOUT_STALE_ALERT_COMMITS GREEDY_SCAN_LIMIT PRIORITY_LABELS PRIORITY_SOURCE PROJECT_PRIORITY_FIELD CI_FAILURE_REPORT_BRANCH CI_FAILURE_REPORT_MAX_FIX_ATTEMPTS POLL_BACKOFF_LADDER POLL_FORCE_SYNC_SECS POLL_FAIL_BACKOFF_MAX_SECS POLL_DUE_SLACK_SECS POLL_IDLE_PROBE_MAX_SECS"
# 这几项加载后的变量值不是 daemon 的判断本身，问真正做判断的那个函数（或保留下来的那份值）：
#   ENABLE_CONCURRENT_WORK_HINT  concurrent_work_enabled
#   ENABLE_ROUND_LOG             round_log_enabled
#   ENABLE_USAGE_LIMIT_PAUSE     usage_limit_enabled（不写时变量是空值，判断是「关」）
#   ENABLE_POLL_RUN_LOG          _runlog_enabled（agent-poll.sh 加载 _runlog.sh 后用它；不写 = 开、空值 = 关）
#   LABEL_PENDING_MERGE          AUTOPILOT_MERGE_LABEL_NAME（托管关着时 LABEL_PENDING_MERGE 本身会被清空，这份是清空前的标签名）
#   GREEDY_SKIP_LABELS           加载时不补值，用到时（greedy_skip_label_list）才读：问它在内置的跳过标签之后多列了哪些
#   POLL_RUN_LOG_ROUNDS / _SNAPSHOTS / _INFLIGHT / _SLOW_SECS  加载时不补值，轮询记录用到时才补：问 _runlog_setting（用到它们的地方都问它，GitHub#556）
RUNLOG_KEYS="POLL_RUN_LOG_ROUNDS POLL_RUN_LOG_SNAPSHOTS POLL_RUN_LOG_INFLIGHT POLL_RUN_LOG_SLOW_SECS"
FNKEYS="ENABLE_CONCURRENT_WORK_HINT ENABLE_ROUND_LOG ENABLE_USAGE_LIMIT_PAUSE ENABLE_POLL_RUN_LOG LABEL_PENDING_MERGE GREEDY_SKIP_LABELS $RUNLOG_KEYS"
lib_load() {
    env -i HOME="$MIN" PATH="$SYS_PATH" CODING_AGENT_CONFIG="$MIN/cavil-loop.config" bash -c '
    source "$1/scripts/_lib.sh" >/dev/null 2>&1 || { echo LOAD_FAILED; exit 1; }
    source "$1/scripts/_runlog.sh" >/dev/null 2>&1 || { echo RUNLOG_LOAD_FAILED; exit 1; }
    shift; for k in "$@"; do printf "%s=%s\n" "$k" "${!k-<未设置>}"; done
    if concurrent_work_enabled; then echo ENABLE_CONCURRENT_WORK_HINT=true; else echo ENABLE_CONCURRENT_WORK_HINT=false; fi
    if round_log_enabled; then echo ENABLE_ROUND_LOG=true; else echo ENABLE_ROUND_LOG=false; fi
    if usage_limit_enabled; then echo ENABLE_USAGE_LIMIT_PAUSE=true; else echo ENABLE_USAGE_LIMIT_PAUSE=false; fi
    if _runlog_enabled; then echo ENABLE_POLL_RUN_LOG=true; else echo ENABLE_POLL_RUN_LOG=false; fi
    echo "LABEL_PENDING_MERGE=$AUTOPILOT_MERGE_LABEL_NAME"
    __n="$(GREEDY_SKIP_LABELS="" greedy_skip_label_list | wc -l)"
    echo "GREEDY_SKIP_LABELS=$(greedy_skip_label_list | tail -n +$((__n + 1)) | paste -sd, -)"
    for k in POLL_RUN_LOG_ROUNDS POLL_RUN_LOG_SNAPSHOTS POLL_RUN_LOG_INFLIGHT POLL_RUN_LOG_SLOW_SECS; do echo "$k=$(_runlog_setting "$k")"; done
' _ "$REPO_DIR" $LIBKEYS 2>&1
}
loaded="$(lib_load)"
# col 4 是「不写时的值[;empty=写成空值时的值]」
reg_unset() { local d; d="$(col 4 "$1")"; printf '%s' "${d%%;empty=*}"; }
reg_empty() { local d; d="$(col 4 "$1")"; case "$d" in *';empty='*) printf '%s' "${d#*;empty=}" ;; *) printf '%s' "$d" ;; esac; }
want="$(for k in $LIBKEYS $FNKEYS; do printf '%s=%s\n' "$k" "$(reg_unset "$k")"; done)"
nkeys="$(wc -w <<<"$LIBKEYS $FNKEYS" | tr -d ' ')"
chk "真实加载公共库（配置里一项都不写）后的值 = 登记表的「不写时的值」（$nkeys 项）" "$loaded" "$want"
mkdir -p "$H/.config/cavil-loop"; printf 'PROJECT_ROOT=%s\nCODING_AGENT_CONFIG=%s\n' "$MIN/proj" "$MIN/cavil-loop.config" > "$H/.config/cavil-loop/min.conf"
shown_of() { run get min | jq -r --arg ks "$LIBKEYS $FNKEYS" '. as $g | $ks | split(" ")[] | . as $k | "\($k)=\($g.fields[] | select(.name == $k) | .value)"'; }
chk "同一份一项都不写的配置：project-config.sh 显示的值 = 公共库实际得到的值" "$(shown_of)" "$loaded"
# 每一项都写成空值：多数项「空 = 用默认值」，少数项（登记成「默认;empty=值」的）空值有自己的意思——同一份输入对拍
for k in $LIBKEYS $FNKEYS; do printf '%s=""\n' "$k"; done >> "$MIN/cavil-loop.config"
loaded="$(lib_load)"
want="$(for k in $LIBKEYS $FNKEYS; do printf '%s=%s\n' "$k" "$(reg_empty "$k")"; done)"
chk "这 $nkeys 项全写成空值后真实加载公共库：是登记表的「写成空值时的值」" "$loaded" "$want"
chk "确有空值和不写不同的项（轮询记录：不写 = 开、空值 = 关）" "$(reg_unset ENABLE_POLL_RUN_LOG) $(reg_empty ENABLE_POLL_RUN_LOG)" "true false"
chk "到达性 · 两个默认开的标签开关（GitHub#551）：没写这一行时是标签名，写成空值时公共库读到空" \
    "$(for k in LABEL_PENDING_BLOCKED LABEL_PENDING_LATER; do printf '%s ' "$(reg_unset "$k")"; done)|$(grep -E '^LABEL_PENDING_(BLOCKED|LATER)=' <<<"$loaded" | tr '\n' ' ')" \
    "pending/blocked pending/later |LABEL_PENDING_BLOCKED= LABEL_PENDING_LATER= "
chk "同是标签的「等合并」写成空值仍是默认标签：按项登记、不按类型" "$(grep '^LABEL_PENDING_MERGE=' <<<"$loaded")" "LABEL_PENDING_MERGE=pending/merge"
chk "同一份全空的配置：project-config.sh 显示的值 = 公共库实际得到的值" "$(shown_of)" "$loaded"
# 保存这两种新写法：空值 = 关的开关（轮询记录）、「关」本身是空值的开关（外部内容预筛）
save min '{"ENABLE_POLL_RUN_LOG":"true","AUTOPILOT_OUTSIDER_SCREEN":"on"}'
chk "空值的轮询记录改成开、空值的预筛改成 on：保存成功" "$RESULT" "RESULT=saved"
chk "文件里那两行改成了新值" "$(grep -cxE 'ENABLE_POLL_RUN_LOG="true"|AUTOPILOT_OUTSIDER_SCREEN="on"' "$MIN/cavil-loop.config")" 2
G="$(run get min)"
chk "读回：轮询记录开、预筛 on" "$(field "$G" ENABLE_POLL_RUN_LOG) $(field "$G" AUTOPILOT_OUTSIDER_SCREEN)" '["true",true,true] ["on",true,true]'
save min '{"ENABLE_POLL_RUN_LOG":"false","AUTOPILOT_OUTSIDER_SCREEN":""}'
chk "再关掉（预筛的「关」写成空值）：保存成功" "$RESULT" "RESULT=saved"
G="$(run get min)"
chk "读回：轮询记录关、预筛关（空值）" "$(field "$G" ENABLE_POLL_RUN_LOG) $(field "$G" AUTOPILOT_OUTSIDER_SCREEN)" '["false",true,true] ["",true,true]'
chk "预筛那一行确实写成了空值" "$(grep -cx 'AUTOPILOT_OUTSIDER_SCREEN=""' "$MIN/cavil-loop.config")" 1
save min '{"AUTOPILOT_OUTSIDER_SCREEN":"yes"}'
chk "预筛只认 on 和空值：写 yes 被拒" "$RESULT" "RESULT=invalid"
# 早期名字（外部需求机器人的 RELAY_* / LABEL_PENDING_RELAY）：daemon 加载时新名字没有值就用早期名字的值，
# 窗口显示的值必须是同一个——同一份配置，真实加载公共库和 project-config.sh 对拍。用到早期名字的项只显示、不可改
EARLY_PAIRS="$(env -i bash -c 'source "$1/scripts/_names.sh"; printf "%s\n" "$CAVIL_SETTING_EARLY_NAMES"' _ "$REPO_DIR")"
chk "早期名字对照表有五对（外部需求机器人的五项）" "$(grep -c . <<<"$EARLY_PAIRS")" 5
EW="$SANDBOX/early"; mkdir -p "$EW/proj" "$EW/state" "$EW/wt"
printf 'PROJECT_ROOT=%s\nCODING_AGENT_CONFIG=%s\n' "$EW/proj" "$EW/cavil-loop.config" > "$H/.config/cavil-loop/early.conf"
early_conf() {   # <追加的行...>：只有必填项，再加上这几行
    cat > "$EW/cavil-loop.config" <<CONF
REPO="example/early"
PROJECT_ROOT="$EW/proj"
WORKTREE_BASE="$EW/wt"
STATE_DIR="$EW/state"
TMUX_PREFIX="earlytest"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
CONF
    local l; for l in "$@"; do printf '%s\n' "$l" >> "$EW/cavil-loop.config"; done
}
EKEYS="LABEL_PENDING_REQUESTER_BOT REQUESTER_BOT_ACCOUNT REQUESTER_BOT_ALLOWED_ACTORS REQUESTER_BOT_ORIGIN_MARKER REQUESTER_BOT_REPORT_FIRST"
early_lib() {   # 真实加载公共库后，五个新名字的值 + 冲突提示
    env -i HOME="$EW" PATH="$SYS_PATH" CODING_AGENT_CONFIG="$EW/cavil-loop.config" bash -c '
    source "$1/scripts/_lib.sh" >/dev/null 2>&1 || { echo LOAD_FAILED; exit 1; }
    shift; for k in "$@"; do printf "%s=%s\n" "$k" "${!k-<未设置>}"; done
    printf "CONFLICTS=%s\n" "$REQUESTER_BOT_NAME_CONFLICTS"
' _ "$REPO_DIR" $EKEYS 2>&1
}
early_lib_shown() {   # 两个登记了的项：公共库的值 / 窗口显示的值
    local L G; L="$(early_lib)"; G="$(run get early)"
    printf 'lib %s %s | shown %s %s' \
        "$(sed -n 's/^LABEL_PENDING_REQUESTER_BOT=//p' <<<"$L")" "$(sed -n 's/^REQUESTER_BOT_REPORT_FIRST=//p' <<<"$L")" \
        "$(jq -r '.fields[] | select(.name == "LABEL_PENDING_REQUESTER_BOT") | .value' <<<"$G")" \
        "$(jq -r '.fields[] | select(.name == "REQUESTER_BOT_REPORT_FIRST") | .value' <<<"$G")"
}
early_conf 'LABEL_PENDING_RELAY="pending/relay"' 'RELAY_BOT_ACCOUNT="old-bot"' 'RELAY_ALLOWED_ACTORS="old-bot"' \
    'RELAY_ORIGIN_MARKER="<!-- old -->"' 'RELAY_REPORT_FIRST="true"'
chk "只写早期名字：公共库五项都取早期名字的值，没有冲突提示" "$(early_lib)" \
    "$(printf '%s\n' LABEL_PENDING_REQUESTER_BOT=pending/relay REQUESTER_BOT_ACCOUNT=old-bot REQUESTER_BOT_ALLOWED_ACTORS=old-bot 'REQUESTER_BOT_ORIGIN_MARKER=<!-- old -->' REQUESTER_BOT_REPORT_FIRST=true CONFLICTS=)"
chk "只写早期名字：窗口显示的值 = 公共库的值" "$(early_lib_shown)" "lib pending/relay true | shown pending/relay true"
G="$(run get early)"
chk "只写早期名字：可改的那项变成只显示，标成「文件里有」" "$(field "$G" REQUESTER_BOT_REPORT_FIRST)" '["true",true,false]'
chk_has "只显示的原因写出早期名字和怎么改" "$(why "$G" REQUESTER_BOT_REPORT_FIRST)" "早期名字 RELAY_REPORT_FIRST"
before="$(sum "$EW/cavil-loop.config")"
save early '{"REQUESTER_BOT_REPORT_FIRST":"false"}'
chk "只写早期名字：保存这一项被拒，文件不变" "$RESULT $(sum "$EW/cavil-loop.config")" "RESULT=not_editable $before"
early_conf 'LABEL_PENDING_REQUESTER_BOT=""' 'REQUESTER_BOT_REPORT_FIRST=""' 'LABEL_PENDING_RELAY="pending/relay"' 'RELAY_REPORT_FIRST="true"'
chk "新名字写成空值、早期名字有值：窗口显示的值 = 公共库的值（早期名字的值）" "$(early_lib_shown)" "lib pending/relay true | shown pending/relay true"
early_conf 'LABEL_PENDING_REQUESTER_BOT="pending/bot"' 'REQUESTER_BOT_REPORT_FIRST="false"' 'LABEL_PENDING_RELAY="pending/relay"' 'RELAY_REPORT_FIRST="true"'
chk "两个名字都有值且不同：窗口显示的值 = 公共库的值（新名字的值）" "$(early_lib_shown)" "lib pending/bot false | shown pending/bot false"
chk_has "两个名字都有值且不同：公共库照旧提示冲突" "$(early_lib)" "REQUESTER_BOT_REPORT_FIRST（用它）/ RELAY_REPORT_FIRST（忽略）"
chk "两个名字都有值且不同：也只显示" "$(field "$(run get early)" REQUESTER_BOT_REPORT_FIRST)" '["false",true,false]'
early_conf 'RELAY_REPORT_FIRST=""'
chk "早期名字写成空值：窗口显示的值 = 公共库的值（默认）" "$(early_lib_shown)" "lib  false | shown  false"
chk "早期名字只写成空值也算用到了它：只显示" "$(field "$(run get early)" REQUESTER_BOT_REPORT_FIRST)" '["false",true,false]'
# 早期名字来自配置加载的另一个文件：主文件里看不到这个名字的文字，凭加载后的定义判断
printf 'RELAY_REPORT_FIRST="true"\n' > "$EW/extra.sh"
early_conf ". \"$EW/extra.sh\""
chk "早期名字在被加载的另一个文件里：窗口显示的值 = 公共库的值" "$(early_lib_shown)" "lib  true | shown  true"
G="$(run get early)"
chk "早期名字在被加载的另一个文件里：只显示" "$(field "$G" REQUESTER_BOT_REPORT_FIRST)" '["true",true,false]'
chk_has "原因写明可能来自加载的另一个文件" "$(why "$G" REQUESTER_BOT_REPORT_FIRST)" "加载的另一个文件"
before="$(sum "$EW/cavil-loop.config")"
save early '{"REQUESTER_BOT_REPORT_FIRST":"false"}'
chk "早期名字在被加载的另一个文件里：保存被拒，主文件不变" "$RESULT $(sum "$EW/cavil-loop.config")" "RESULT=not_editable $before"
early_conf 'REQUESTER_BOT_REPORT_FIRST="false"' ". \"$EW/extra.sh\""
chk "主文件写新名字、被加载的文件写不同的早期名字：显示新名字的值，公共库提示冲突" \
    "$(early_lib_shown) $(early_lib | grep -c 'RELAY_REPORT_FIRST（忽略）')" "lib  false | shown  false 1"
chk "这种情况也只显示" "$(field "$(run get early)" REQUESTER_BOT_REPORT_FIRST)" '["false",true,false]'
printf 'RELAY_REPORT_FIRST=""\n' > "$EW/extra.sh"
early_conf ". \"$EW/extra.sh\""
chk "被加载的文件把早期名字写成空值：显示默认，也只显示" "$(field "$(run get early)" REQUESTER_BOT_REPORT_FIRST)" '["false",true,false]'
printf 'UNRELATED_SETTING="1"\n' > "$EW/extra.sh"
early_conf ". \"$EW/extra.sh\""
G="$(run get early)"
chk "被加载的文件里没有早期名字：新名字照旧可改（文件里没有，保存会追加）" "$(field "$G" REQUESTER_BOT_REPORT_FIRST)" '["false",false,true]'
save early '{"REQUESTER_BOT_REPORT_FIRST":"true"}'
chk "被加载的文件里没有早期名字：保存成功，公共库读到新值" "$RESULT $(early_lib_shown)" "RESULT=saved lib  true | shown  true"
early_conf 'REQUESTER_BOT_REPORT_FIRST="false"'
chk "只写新名字：照旧可改" "$(field "$(run get early)" REQUESTER_BOT_REPORT_FIRST)" '["false",true,true]'
save early '{"REQUESTER_BOT_REPORT_FIRST":"true"}'
chk "只写新名字：保存成功，公共库读到新值，和窗口一致" "$RESULT $(early_lib_shown)" "RESULT=saved lib  true | shown  true"
# 两个必填的流程标签（派工、等人）：配置里没有这一行，daemon 加载公共库就退出——没有「不写时 daemon 用的值」，
# 登记表的「不写时的值」是空；窗口照实显示空、标成文件里没有（GitHub#555）
RQ="$SANDBOX/req"; mkdir -p "$RQ/proj" "$RQ/state" "$RQ/wt"
printf 'PROJECT_ROOT=%s\nCODING_AGENT_CONFIG=%s\n' "$RQ/proj" "$RQ/cavil-loop.config" > "$H/.config/cavil-loop/req.conf"
req_conf() {   # [不写的那一项]
    printf '%s\n' 'REPO="example/req"' "PROJECT_ROOT=\"$RQ/proj\"" "WORKTREE_BASE=\"$RQ/wt\"" "STATE_DIR=\"$RQ/state\"" \
        'TMUX_PREFIX="reqtest"' 'BRANCH_PREFIX="feature/issue-"' 'SESSION_NAME_PREFIX="issue"' \
        'LABEL_PENDING_AGENT="pending/agent"' 'LABEL_PENDING_HUMAN="pending/human"' | grep -v "^${1:-__none__}=" > "$RQ/cavil-loop.config"
}
req_load() {
    env -i HOME="$RQ" PATH="$SYS_PATH" CODING_AGENT_CONFIG="$RQ/cavil-loop.config" bash -c '
        source "$1/scripts/_lib.sh" >/dev/null 2>&1 || exit 1
        echo "LOADED $LABEL_PENDING_AGENT $LABEL_PENDING_HUMAN"' _ "$REPO_DIR" 2>/dev/null || echo LOAD_FAILED
}
req_conf
chk "到达性 · 两个必填标签都写了：公共库照常加载，窗口显示写的值" \
    "$(req_load) | $(G="$(run get req)"; field "$G" LABEL_PENDING_AGENT) $(field "$G" LABEL_PENDING_HUMAN)" \
    'LOADED pending/agent pending/human | ["pending/agent",true,false] ["pending/human",true,false]'
for k in LABEL_PENDING_AGENT LABEL_PENDING_HUMAN; do
    req_conf "$k"
    chk "必填的 $k 不写：公共库不加载；登记表「不写时的值」是空，窗口显示空、文件里没有" \
        "$(req_load) [$(col 4 "$k")] $(field "$(run get req)" "$k")" 'LOAD_FAILED [] ["",false,false]'
done
# 整数的范围 = 使用它的代码在 daemon 跑的每个平台上实际接受的范围（GitHub#555 复审三轮）。按十进制数字比大小，不受位数限制：
# bash 拿去 [ -gt ] / $(( )) 的到 2^63-1（Linux 的 bash 5、macOS 的 bash 3.2 一样），乘 3600 再比的取乘完不溢出的那个数，
# 只有 Python 读的、和「开着的都派」的扫描条数（十位数及以上不再交给各平台上限不同的 head，等于全看；真实轮询对拍在
# tests/project-config-poll.test.sh）不设上限
U64=18446744073709551615; I64=9223372036854775807; HMAX=2562047788015215
chk "整数范围：每项登记的就是它使用端的上下限" \
    "$(for k in GREEDY_SCAN_LIMIT AUTOPILOT_CHECKS_TIMEOUT_HOURS CHECKOUT_STALE_ALERT_COMMITS HEAVY_TEST_LOCK_WAIT PENDING_HUMAN_CONFLICT_MAX_TRIES CI_FAILURE_REPORT_MAX_FIX_ATTEMPTS USAGE_LIMIT_FALLBACK_SECS; do printf '%s ' "$(col 3 "$k")"; done)" \
    "int:0: int:0:$HMAX int:0:$I64 int:0:$I64 int:1:$I64 int:1: int:60:604800 "
# 使用端自己的写法在两端的表现（同一个命令 / 表达式，照抄使用它的那一行）
chk "使用端 · 重测试排队 / 冲突重试 / 落后提醒用 [ -gt ] / [ -ge ] 比：$I64 能比，再大 1 报错" \
    "$(bash -c '[ "$1" -gt 0 ] && echo ok' _ "$I64") $(bash -c '[ "$1" -gt 0 ] 2>/dev/null; echo $?' _ 9223372036854775808)" "ok 2"
chk "使用端 · 托管检查超时乘 3600：$HMAX 小时不溢出，再大 1 溢出成负数" \
    "$(bash -c 'echo $(( $1 * 3600 >= 0 ))' _ "$HMAX") $(bash -c 'echo $(( $1 * 3600 >= 0 ))' _ 2562047788015216)" "1 0"
usage_after_load() {   # <USAGE_LIMIT_FALLBACK_SECS 的值> → 公共库加载后实际用的值
    req_conf; printf 'USAGE_LIMIT_FALLBACK_SECS=%s\n' "$1" >> "$RQ/cavil-loop.config"
    env -i HOME="$RQ" PATH="$SYS_PATH" CODING_AGENT_CONFIG="$RQ/cavil-loop.config" bash -c '
        source "$1/scripts/_lib.sh" >/dev/null 2>&1 || exit 1; printf %s "$USAGE_LIMIT_FALLBACK_SECS"' _ "$REPO_DIR" 2>/dev/null || printf LOAD_FAILED
}
chk "读不出解除时间的停派秒数：登记的两端 60 / 604800 公共库照用，出界的 59 / 604801 被改回 3600" \
    "$(for v in 60 604800 59 604801; do printf '%s ' "$(usage_after_load "$v")"; done)" "60 604800 3600 3600 "
fix_after_load() {   # <CI 报告修复上限的值> → 检查脚本实际用的值
    env -i PATH="$SYS_PATH" CI_REPORT_MAX_FIX="$1" python3 -c 'import sys; sys.path.insert(0, sys.argv[1]); import ci_failure_report as m; print(m.MAX_FIX, end="")' "$REPO_DIR/scripts" 2>/dev/null || printf LOAD_FAILED
}
BIG200="1$(printf '0%.0s' $(seq 199))"
chk "CI 报告修复上限：1 和 200 位的数检查脚本照用（不设上限），0 被改回 2（所以登记从 1 起）" \
    "$(for v in 1 "$BIG200" 0; do r="$(fix_after_load "$v")"; [ "$r" = "$v" ] && r=same; printf '%s ' "$r"; done)" "same same 2 "
G="$(run get req)"
chk "get 给的上限：超过 15 位的给字符串（不被读成近似值），不设上限的给 null，小的照旧是数" \
    "$(jq -c '[.fields[] | select(.name == "GREEDY_SCAN_LIMIT" or .name == "AUTOPILOT_CHECKS_TIMEOUT_HOURS" or .name == "CI_FAILURE_REPORT_MAX_FIX_ATTEMPTS" or .name == "USAGE_LIMIT_FALLBACK_SECS") | [.name, .min, .max]]' <<<"$G")" \
    "[[\"USAGE_LIMIT_FALLBACK_SECS\",60,604800],[\"GREEDY_SCAN_LIMIT\",0,null],[\"AUTOPILOT_CHECKS_TIMEOUT_HOURS\",0,\"$HMAX\"],[\"CI_FAILURE_REPORT_MAX_FIX_ATTEMPTS\",1,null]]"
# 配置里已经是超出旧登记范围的值（九位以上、十位数）或有意义的 0：窗口照样可改，能改回普通值
RANGE_KEYS="GREEDY_SCAN_LIMIT AUTOPILOT_CHECKS_TIMEOUT_HOURS CHECKOUT_STALE_ALERT_COMMITS HEAVY_TEST_LOCK_WAIT PENDING_HUMAN_CONFLICT_MAX_TRIES CI_FAILURE_REPORT_MAX_FIX_ATTEMPTS"
req_conf
printf '%s\n' GREEDY_SCAN_LIMIT=1000000000 AUTOPILOT_CHECKS_TIMEOUT_HOURS=0 CHECKOUT_STALE_ALERT_COMMITS=1000000000 HEAVY_TEST_LOCK_WAIT=1000000000 \
    PENDING_HUMAN_CONFLICT_MAX_TRIES=1000000000 CI_FAILURE_REPORT_MAX_FIX_ATTEMPTS=1000000000 >> "$RQ/cavil-loop.config"
G="$(run get req)"
chk "配置里写着十位数 1000000000（托管检查超时写 0）：都显示原值、都可改" \
    "$(for k in $RANGE_KEYS; do printf '%s ' "$(field "$G" "$k")"; done)" \
    '["1000000000",true,true] ["0",true,true] ["1000000000",true,true] ["1000000000",true,true] ["1000000000",true,true] ["1000000000",true,true] '
save req '{"GREEDY_SCAN_LIMIT":"100","AUTOPILOT_CHECKS_TIMEOUT_HOURS":"6","CHECKOUT_STALE_ALERT_COMMITS":"20","HEAVY_TEST_LOCK_WAIT":"0","PENDING_HUMAN_CONFLICT_MAX_TRIES":"10","CI_FAILURE_REPORT_MAX_FIX_ATTEMPTS":"2"}'
chk "从十位数改回普通值：保存成功，文件里就是新值" "$RESULT $(grep -cxE 'GREEDY_SCAN_LIMIT=100|AUTOPILOT_CHECKS_TIMEOUT_HOURS=6|CHECKOUT_STALE_ALERT_COMMITS=20|HEAVY_TEST_LOCK_WAIT=0|PENDING_HUMAN_CONFLICT_MAX_TRIES=10|CI_FAILURE_REPORT_MAX_FIX_ATTEMPTS=2' "$RQ/cavil-loop.config")" "RESULT=saved 6"
read_back() { local G k; G="$(run get req)"; for k in $RANGE_KEYS; do printf '%s ' "$(jq -r --arg n "$k" '.fields[] | select(.name == $n) | .value' <<<"$G")"; done; }
for v in 999999999 1000000000; do
    save req "$(jq -cn --arg v "$v" '{GREEDY_SCAN_LIMIT:$v, AUTOPILOT_CHECKS_TIMEOUT_HOURS:$v, CHECKOUT_STALE_ALERT_COMMITS:$v, HEAVY_TEST_LOCK_WAIT:$v, PENDING_HUMAN_CONFLICT_MAX_TRIES:$v, CI_FAILURE_REPORT_MAX_FIX_ATTEMPTS:$v}')"
    chk "六项都改成 $v：保存成功，读回就是 $v" "$RESULT $(read_back)" "RESULT=saved $v $v $v $v $v $v "
done
save req "{\"GREEDY_SCAN_LIMIT\":\"$U64\",\"AUTOPILOT_CHECKS_TIMEOUT_HOURS\":\"$HMAX\",\"CHECKOUT_STALE_ALERT_COMMITS\":\"$I64\",\"HEAVY_TEST_LOCK_WAIT\":\"$I64\",\"PENDING_HUMAN_CONFLICT_MAX_TRIES\":\"$I64\",\"CI_FAILURE_REPORT_MAX_FIX_ATTEMPTS\":\"$BIG200\"}"
chk "六项都改成各自使用端的上限（「开着的都派」写 2^64-1，CI 修复上限写 200 位）：保存成功，读回就是这些值" "$RESULT $(read_back)" "RESULT=saved $U64 $HMAX $I64 $I64 $I64 $BIG200 "
G="$(run get req)"
chk "上限上的值照样可改" "$(for k in $RANGE_KEYS; do printf '%s ' "$(jq -r --arg n "$k" '.fields[] | select(.name == $n) | .editable' <<<"$G")"; done)" "true true true true true true "
save req '{"GREEDY_SCAN_LIMIT":"0","PENDING_HUMAN_CONFLICT_MAX_TRIES":"1","CI_FAILURE_REPORT_MAX_FIX_ATTEMPTS":"1"}'
chk "下限 0 / 1：保存成功" "$RESULT" "RESULT=saved"
for kv in AUTOPILOT_CHECKS_TIMEOUT_HOURS:2562047788015216 CHECKOUT_STALE_ALERT_COMMITS:9223372036854775808 \
          HEAVY_TEST_LOCK_WAIT:9223372036854775808 PENDING_HUMAN_CONFLICT_MAX_TRIES:9223372036854775808 PENDING_HUMAN_CONFLICT_MAX_TRIES:0 \
          CI_FAILURE_REPORT_MAX_FIX_ATTEMPTS:0 "CI_FAILURE_REPORT_MAX_FIX_ATTEMPTS:${BIG200}0" GREEDY_SCAN_LIMIT:0100 \
          USAGE_LIMIT_FALLBACK_SECS:59 USAGE_LIMIT_FALLBACK_SECS:604801; do
    before="$(sum "$RQ/cavil-loop.config")"
    save req "{\"${kv%%:*}\":\"${kv#*:}\"}"
    chk "使用端不收或会改回默认的值不让存：${kv%%:*} = ${kv#*:} → invalid，文件不变" "$RESULT $(sum "$RQ/cavil-loop.config")" "RESULT=invalid $before"
done
# GitHub#556 登记的轮询节奏、轮询记录、预览几项：登记的范围 = 使用端实际收的范围
chk "整数范围（GitHub#556）：轮询节奏 9 位、轮询记录 7 位、预览端口 65535、就绪等待 120 秒" \
    "$(for k in POLL_FORCE_SYNC_SECS POLL_FAIL_BACKOFF_MAX_SECS POLL_DUE_SLACK_SECS POLL_IDLE_PROBE_MAX_SECS $RUNLOG_KEYS PREVIEW_PORT_BASE PREVIEW_PORT_MODULO PREVIEW_BACKEND_OFFSET PREVIEW_READY_TIMEOUT; do printf '%s ' "$(col 3 "$k")"; done)" \
    "int:0:999999999 int:0:999999999 int:0:999999999 int:1:999999999 int:2:9999999 int:2:9999999 int:2:9999999 int:1:9999999 int:0:65535 int:1:9223372036854775807:empty int:1:65535 int:0:120 "
pace_after_load() {   # <名字> <值> → 公共库加载后实际用的值（轻量检查封顶问 pace_probe_cap：不合法 = 不封顶，输出 none）
    req_conf; printf '%s=%s\n' "$1" "$2" >> "$RQ/cavil-loop.config"
    env -i HOME="$RQ" PATH="$SYS_PATH" CODING_AGENT_CONFIG="$RQ/cavil-loop.config" bash -c '
        source "$1/scripts/_lib.sh" >/dev/null 2>&1 || exit 1
        if [ "$2" = POLL_IDLE_PROBE_MAX_SECS ]; then POLL_FORCE_SYNC_SECS=999999999; pace_probe_cap quiet || printf none; else printf %s "${!2}"; fi' _ "$REPO_DIR" "$1" 2>/dev/null || printf LOAD_FAILED
}
for kd in POLL_FORCE_SYNC_SECS:1800 POLL_FAIL_BACKOFF_MAX_SECS:1800 POLL_DUE_SLACK_SECS:10; do
    chk "轮询节奏 ${kd%%:*}：0 和 999999999 公共库照用，10 位的 1000000000 被改回 ${kd#*:}" \
        "$(for v in 0 999999999 1000000000; do printf '%s ' "$(pace_after_load "${kd%%:*}" "$v")"; done)" "0 999999999 ${kd#*:} "
done
chk "轻量检查封顶：1 和 999999999 照用（心跳调到最大时），0 和 10 位的不封顶（所以登记 1 到 999999999）" \
    "$(for v in 1 999999999 0 1000000000; do printf '%s ' "$(pace_after_load POLL_IDLE_PROBE_MAX_SECS "$v")"; done)" "1 999999999 none none "
runlog_after() {   # <名字> <值> → 轮询记录实际用的值
    env -i PATH="$SYS_PATH" "$1=$2" bash -c 'source "$1/scripts/_runlog.sh" >/dev/null 2>&1 || exit 1; _runlog_setting "$2"' _ "$REPO_DIR" "$1" 2>/dev/null || printf LOAD_FAILED
}
for k in $RUNLOG_KEYS; do
    lo="$(col 3 "$k" | cut -d: -f2)"; d="$(col 4 "$k")"
    chk "轮询记录 $k：$lo 和 9999999 照用，$((lo - 1)) 和 8 位的 10000000 被改回 $d" \
        "$(for v in "$lo" 9999999 "$((lo - 1))" 10000000; do printf '%s ' "$(runlog_after "$k" "$v")"; done)" "$lo 9999999 $d $d "
done
preview_port_of() {   # <起始号> <取模数> <issue> → 公共库 preview_port 算出的端口；出错输出 ERR
    req_conf; printf 'PREVIEW_PORT_BASE=%s\nPREVIEW_PORT_MODULO=%s\n' "$1" "$2" >> "$RQ/cavil-loop.config"
    env -i HOME="$RQ" PATH="$SYS_PATH" CODING_AGENT_CONFIG="$RQ/cavil-loop.config" bash -c '
        source "$1/scripts/_lib.sh" >/dev/null 2>&1 || exit 1; preview_port "$2"' _ "$REPO_DIR" "$3" 2>/dev/null || printf ERR
}
chk "预览端口：取模留空 = 不取模（4000 + 1040），取模 1000 = 4040，取模 0 算不出来（所以登记从 1 起）" \
    "$(preview_port_of 4000 '""' 1040) $(preview_port_of 4000 1000 1040) $(preview_port_of 4000 0 1040)" "5040 4040 ERR"
chk "就绪等待上限 = 预览单元启动最多等的秒数（新旧两套单元都是 120）" \
    "$(sed -n 's/^TimeoutStartSec=//p' "$REPO_DIR/systemd/cavil-loop-preview-app@.service" "$REPO_DIR/systemd/coding-agent-preview-app@.service" | tr '\n' ' ')" "120 120 "
# 可以留空的整数（GitHub#556）：get 给 empty:true，别的整数不带这个字段；留空能存，0 不能
G="$(run get req)"
chk "get：取模那一项带 empty:true，别的整数项都不带" \
    "$(jq -c '[.fields[] | select(.type == "int" and .empty == true) | .name]' <<<"$G") $(jq -c '[.fields[] | select(.type == "int" and has("empty") and .name != "PREVIEW_PORT_MODULO")] | length' <<<"$G")" \
    '["PREVIEW_PORT_MODULO"] 0'
req_conf; printf 'PREVIEW_PORT_MODULO=1000\n' >> "$RQ/cavil-loop.config"
save req '{"PREVIEW_PORT_MODULO":""}'
chk "取模从 1000 改成留空：保存成功，文件里那一行写成空值（照原行不带引号），读回是空" \
    "$RESULT $(grep -cxE 'PREVIEW_PORT_MODULO=(""|)' "$RQ/cavil-loop.config") $(field "$(run get req)" PREVIEW_PORT_MODULO)" 'RESULT=saved 1 ["",true,true]'
for v in 0 9223372036854775808; do
    before="$(sum "$RQ/cavil-loop.config")"
    save req "{\"PREVIEW_PORT_MODULO\":\"$v\"}"
    chk "取模写 $v 不让存（文件不变），原因里说可以留空" "$RESULT $(sum "$RQ/cavil-loop.config") $(grep -q '或者留空' <<<"$OUT" && echo said)" "RESULT=invalid $before said"
done
before="$(sum "$RQ/cavil-loop.config")"
save req '{"PREVIEW_BACKEND_OFFSET":""}'
chk "不带 empty 的整数（预览端口偏移）留空仍不让存" "$RESULT $(sum "$RQ/cavil-loop.config")" "RESULT=invalid $before"
# 三项合起来算出的端口（GitHub#556 复审第 1 轮）：每项都在范围里，合起来超过 65535 的不让存；规则和注册前的检查是同一份
pv_combo() {   # <配置里另写的几行（\n 分隔）> <要存的 JSON> → RESULT + 文件变没变 + 原因里有没有「不能用」
    req_conf; [ -n "$1" ] && printf '%b\n' "$1" >> "$RQ/cavil-loop.config"
    local before; before="$(sum "$RQ/cavil-loop.config")"
    save req "$2"
    printf '%s %s %s' "$RESULT" "$([ "$(sum "$RQ/cavil-loop.config")" = "$before" ] && echo same || echo changed)" "$(grep -q '不能用' <<<"$OUT" && echo said || echo silent)"
}
chk "起始号 6000 + 偏移 65535（单项都合法）：#1 的后端端口 71536，不让存，说明原因" "$(pv_combo '' '{"PREVIEW_PORT_BASE":"6000","PREVIEW_BACKEND_OFFSET":"65535"}')" "RESULT=invalid same said"
chk "只改起始号到 65535（偏移不写 = 10000）：#1 就越界，不让存" "$(pv_combo '' '{"PREVIEW_PORT_BASE":"65535"}')" "RESULT=invalid same said"
chk "只改偏移，起始号是配置里已有的 60000：合起来越界，不让存" "$(pv_combo 'PREVIEW_PORT_BASE=60000' '{"PREVIEW_BACKEND_OFFSET":"5536"}')" "RESULT=invalid same said"
# 复审第 3 轮：编号大了才越界的那几条不在保存时拦（取余数很大的旧配置要能改别的项），由注册入口按那条的实际端口拦
chk "取余数 1000、起始号 60000、偏移 5000：#1 和余数 0 的那条都能用，能存（余数大的那几条注册时拦，见轮询测试）" "$(pv_combo '' '{"PREVIEW_PORT_BASE":"60000","PREVIEW_PORT_MODULO":"1000","PREVIEW_BACKEND_OFFSET":"5000"}')" "RESULT=saved changed silent"
chk "旧配置取余数 100000（是除数，不是端口）：只改偏移照常能存" "$(pv_combo 'PREVIEW_PORT_MODULO=100000' '{"PREVIEW_BACKEND_OFFSET":"20000"}')" "RESULT=saved changed silent"
chk "取余数改成 100000：能存" "$(pv_combo '' '{"PREVIEW_PORT_MODULO":"100000"}')" "RESULT=saved changed silent"
# 复审第 4、5 轮：限制是 bash 64 位整数本身的（2^63−1），每次加法前查会不会越过它；取余数是除数，不受加法限制
chk "取余数改成 1000000000（十位数）：能存" "$(pv_combo '' '{"PREVIEW_PORT_MODULO":"1000000000"}')" "RESULT=saved changed silent"
chk "旧配置取余数 1000000000：只改偏移照常能存" "$(pv_combo 'PREVIEW_PORT_MODULO=1000000000' '{"PREVIEW_BACKEND_OFFSET":"20000"}')" "RESULT=saved changed silent"
chk "取余数 3074457345618258603（上一轮误拒的值）：能存" "$(pv_combo '' '{"PREVIEW_PORT_MODULO":"3074457345618258603"}')" "RESULT=saved changed silent"
chk "旧配置取余数 3074457345618258603：只改偏移照常能存" "$(pv_combo 'PREVIEW_PORT_MODULO=3074457345618258603' '{"PREVIEW_BACKEND_OFFSET":"20000"}')" "RESULT=saved changed silent"
chk "取余数正好是 bash 整数上限 2^63−1：能存" "$(pv_combo '' '{"PREVIEW_PORT_MODULO":"9223372036854775807"}')" "RESULT=saved changed silent"
chk "旧配置取余数 2^63（bash 整数装不下）：改偏移时算不了端口，不让存" "$(pv_combo 'PREVIEW_PORT_MODULO=9223372036854775808' '{"PREVIEW_BACKEND_OFFSET":"20000"}')" "RESULT=invalid same said"
chk "偏移 65535 配起始号 4000：#1 的后端端口 69536，不让存" "$(pv_combo '' '{"PREVIEW_BACKEND_OFFSET":"65535"}')" "RESULT=invalid same said"
chk "边界正好：取余数 1000、起始号 60000、偏移 4536（60999 + 4536 = 65535）：能存" "$(pv_combo '' '{"PREVIEW_PORT_BASE":"60000","PREVIEW_PORT_MODULO":"1000","PREVIEW_BACKEND_OFFSET":"4536"}')" "RESULT=saved changed silent"
chk "边界正好：不取余数、起始号 4000、偏移 61534（#1 的后端 65535）：能存" "$(pv_combo '' '{"PREVIEW_PORT_BASE":"4000","PREVIEW_BACKEND_OFFSET":"61534"}')" "RESULT=saved changed silent"
chk "配置里另一项写坏了（偏移 = abc）时改起始号：算不了端口，不让存" "$(pv_combo 'PREVIEW_BACKEND_OFFSET=abc' '{"PREVIEW_PORT_BASE":"5000"}')" "RESULT=invalid same said"
# 复审第 2 轮：起始号 0 在不取余数时可用（#1 的端口是 1）；取余数时编号整除的 issue 端口是 0，不能用
chk "起始号改成 0、不取余数、偏移默认 10000：#1 端口 1、后端 10001，能存" "$(pv_combo '' '{"PREVIEW_PORT_BASE":"0"}')" "RESULT=saved changed silent"
chk "配置里已有起始号 0、不取余数：只改偏移照常能存" "$(pv_combo 'PREVIEW_PORT_BASE=0' '{"PREVIEW_BACKEND_OFFSET":"20000"}')" "RESULT=saved changed silent"
chk "配置里已有起始号 0：配上取余数 1000 会算出端口 0，不让存" "$(pv_combo 'PREVIEW_PORT_BASE=0' '{"PREVIEW_PORT_MODULO":"1000"}')" "RESULT=invalid same said"
chk "配置里手写的偏移是 2^64（算术会回绕成 0）时改起始号：先查输入，不让存" "$(pv_combo 'PREVIEW_BACKEND_OFFSET=18446744073709551616' '{"PREVIEW_PORT_BASE":"5000"}')" "RESULT=invalid same said"
chk "配置里手写的取余数是 0（会除以零）时改偏移：不让存" "$(pv_combo 'PREVIEW_PORT_MODULO=0' '{"PREVIEW_BACKEND_OFFSET":"100"}')" "RESULT=invalid same said"
chk "不碰这三项的保存不做这项检查（配置里已经越界也照常存别的）" "$(pv_combo 'PREVIEW_PORT_BASE=65535' '{"PREVIEW_READY_TIMEOUT":"30"}')" "RESULT=saved changed silent"
# 唯一的例外 PREVIEW_PORT_BASE：名字以 _BASE 结尾，却是预览端口的起始号（一个整数），不是目录（GitHub#556）
chk "名字像目录的例外只有预览端口起始号，且它登记成整数" "$(col 3 PREVIEW_PORT_BASE)" "int:0:65535"
chk "禁止的类别不在登记表里（命令、钩子、令牌、地址、目录、项目名）" \
    "$(grep -vx PREVIEW_PORT_BASE <<<"$names" | grep -E '(_CMD|_HOOK|TOKEN|_EXEC|_URL|_ROOT|_DIR|_BASE|_PREFIX|_FLAGS|_ENV|^REPO|WEBHOOK|_KEY)$' | tr '\n' ' ')" ""
chk "只显示的那六项确实登记成 show" "$(for k in DISPATCH_MODE LABEL_PENDING_REVIEW LABEL_AUTOPILOT AUTOPILOT_HUMAN_PATHS_EXEMPT_TESTS LABEL_PENDING_BLOCKED LABEL_PENDING_LATER; do col 5 "$k"; done | tr '\n' ' ')" "show show show show show show "
G="$(run get min)"
chk "get 把只显示行的原因放进 reason" "$(jq -r '.fields[] | select(.name == "LABEL_PENDING_MERGE") | .reason' <<<"$G")" "$(col 8 LABEL_PENDING_MERGE)"
chk "只显示的行不再集中在一个分组里，而是放进各自的主题分组" \
    "$(jq -r '[.fields[] | select(.mode == "show") | .group] | unique | length > 3' <<<"$G") $(jq -r '[.fields[] | select(.group | test("只显示"))] | length' <<<"$G")" "true 0"

echo "── 8. 文档里的命令照字面跑 ──"
doc_block() {
    awk -v b="<!-- $2:begin -->" -v e="<!-- $2:end -->" '$0==b{f=1;next} $0==e{f=0} f' "$REPO_DIR/docs/$1" \
        | awk '/^```bash$/{f=1;next} /^```$/{f=0} f'
}
doc_block operations.md project-config-ops > "$SANDBOX/doc.sh"
chk "中英两份文档里的命令一字不差" "$(doc_block operations.zh.md project-config-ops)" "$(cat "$SANDBOX/doc.sh")"
chk "命令块非空" "$(grep -c . "$SANDBOX/doc.sh" | awk '{print ($1>3)}')" 1
fresh_world; mv "$H/.config/cavil-loop/widget.conf" "$H/.config/cavil-loop/myproject.conf"
mkdir -p "$H/.agents/skills"; ln -s "$REPO_DIR" "$H/.agents/skills/cavil-loop"; cp "$CONF" "$SANDBOX/orig"
rc=0; out="$(env -i HOME="$H" PATH="$SYS_PATH" bash -euo pipefail "$SANDBOX/doc.sh" 2>&1)" || rc=$?
chk "读 → 改 → 核对 → 用备份还原：空环境下跑完、退出 0" "$rc" 0
chk_has "列出了可改的项" "$out" "MAX_CONCURRENT_WORKERS=1 editable=true"
chk_has "保存成功" "$out" "RESULT=saved"
chk_has "改完读回是新值" "$out" "MAX_CONCURRENT_WORKERS=2"
chk "照文档还原后，配置文件和保存前一字不差" "$(cmp -s "$CONF" "$SANDBOX/orig" && echo same)" "same"
[ "$fail" = 0 ] || printf '%s\n' "$out" | sed 's/^/     | /'

echo "── 9. 关掉往返记录的文档步骤：照字面在空环境跑，七种情况各有一个结局 ──"
# 查值、关掉两段命令（docs/operations{,.zh}.md 的 round-log-check-ops / round-log-off-ops），中英两份一字不差；
# 失败时机用包一层的 jq / mv 做出来（包装命令把路径写死：空环境里没有别的变量可传）
for b in round-log-check-ops round-log-off-ops; do
    chk "$b：中英两份文档里的命令一字不差" "$(doc_block operations.zh.md "$b")" "$(doc_block operations.md "$b")"
done
doc_block operations.md round-log-check-ops > "$SANDBOX/rl-check.sh"
doc_block operations.md round-log-off-ops > "$SANDBOX/rl-off.sh"
chk "两段命令都非空" "$(grep -c . "$SANDBOX/rl-check.sh" | awk '{print ($1>0)}') $(grep -c . "$SANDBOX/rl-off.sh" | awk '{print ($1>5)}')" "1 1"
RL_W="$SANDBOX/rl-wrap"; REAL_JQ="$(command -v jq)"; REAL_MV2="$(command -v mv)"
rl_world() {   # <ENABLE_ROUND_LOG 的值>：myproject 这个实例，配置里写着这一行
    fresh_world; mv "$H/.config/cavil-loop/widget.conf" "$H/.config/cavil-loop/myproject.conf"
    printf 'ENABLE_ROUND_LOG="%s"\n' "$1" >> "$CONF"
    mkdir -p "$H/.agents/skills"; ln -s "$REPO_DIR" "$H/.agents/skills/cavil-loop"
    rm -rf "$RL_W"; mkdir -p "$RL_W"
}
rl_wrap_jq() {   # <匹配的过滤器> <动作>：只在文档命令那一次 jq 调用上动手，脚本自己的 jq 调用照常
    cat > "$RL_W/jq" <<W
#!/usr/bin/env bash
if [ "\$1" = -er ] && [ "\$2" = '$1' ]; then
    case '$2' in
        fail) cat >/dev/null; exit 5 ;;
        edit) "$REAL_JQ" "\$@"; rc=\$?; printf '\n# 别处改的一行\nEXT_MARK="1"\n' >> "$CONF"; exit \$rc ;;
    esac
fi
exec "$REAL_JQ" "\$@"
W
    chmod +x "$RL_W/jq"
}
rl_run() {   # <脚本>：只带 HOME / PATH / LANG
    RL_RC=0; RL_OUT="$(env -i HOME="$H" PATH="$RL_W:$SYS_PATH" LANG=C.UTF-8 bash "$1" 2>&1)" || RL_RC=$?
}
rl_val() { sed -n 's/^ENABLE_ROUND_LOG="\(.*\)"$/\1/p' "$CONF"; }
rl_last() { printf '%s\n' "$RL_OUT" | tail -1; }

rl_world true; rl_run "$SANDBOX/rl-check.sh"
chk "查值：开着时输出 ENABLE_ROUND_LOG=true" "$RL_OUT" "ENABLE_ROUND_LOG=true"
rl_run "$SANDBOX/rl-off.sh"
chk "正常关闭：最后一行 ROUND_LOG=off、退出 0" "$(rl_last) $RL_RC" "ROUND_LOG=off 0"
chk_has "正常关闭：上一行是 RESULT=saved" "$RL_OUT" "RESULT=saved"
chk "正常关闭：配置里变成 false" "$(rl_val)" "false"
rl_run "$SANDBOX/rl-check.sh"
chk "关掉之后查值输出 false" "$RL_OUT" "ENABLE_ROUND_LOG=false"
rl_run "$SANDBOX/rl-off.sh"
chk "已经关着再跑一次：ROUND_LOG=off、RESULT=unchanged" "$(rl_last) $(grep -c '^RESULT=unchanged$' <<<"$RL_OUT")" "ROUND_LOG=off 1"

rl_world true; chmod 000 "$CONF"; rl_run "$SANDBOX/rl-off.sh"; chmod 640 "$CONF"
chk "配置读不了：没写入、退出非 0" "$(rl_last) $([ "$RL_RC" != 0 ] && echo nz)" "NOT_WRITTEN: config unreadable nz"
chk "配置读不了：文件不变" "$(rl_val)" "true"

rl_world true; rl_wrap_jq .rev edit; rl_run "$SANDBOX/rl-off.sh"
chk "取指纹后、保存前被别处改过：没写入（RESULT=changed）" "$(rl_last) $(grep -c '^RESULT=changed$' <<<"$RL_OUT")" "NOT_WRITTEN: changed 1"
chk "取指纹后被改过：值仍是 true，别处那一行还在" "$(rl_val) $(grep -c '^EXT_MARK=' "$CONF")" "true 1"

rl_world true; mkdir -p "$ST"; : > "$ST/config-backups"; rl_run "$SANDBOX/rl-off.sh"
chk "没地方放备份：没写入（RESULT=backup_failed）" "$(rl_last) $(grep -c '^RESULT=backup_failed$' <<<"$RL_OUT")" "NOT_WRITTEN: backup_failed 1"
chk "没地方放备份：文件不变" "$(rl_val)" "true"

rl_world true
cat > "$RL_W/mv" <<W
#!/usr/bin/env bash
"$REAL_MV2" "\$@"; rc=\$?
[ "\${@: -1}" = "$CONF" ] && printf '\n# 换上之后别处又存了一版\nEXT_MARK="1"\n' >> "$CONF"
exit \$rc
W
chmod +x "$RL_W/mv"; rl_run "$SANDBOX/rl-off.sh"
chk "写入后马上被别处改：UNCONFIRMED（RESULT=saved_then_changed）、退出非 0" \
    "$(rl_last) $(grep -c '^RESULT=saved_then_changed$' <<<"$RL_OUT") $([ "$RL_RC" != 0 ] && echo nz)" "UNCONFIRMED: RESULT=saved_then_changed 1 nz"
chk "写入后被改：已是 false，别处那一行也在" "$(rl_val) $(grep -c '^EXT_MARK=' "$CONF")" "false 1"

# 换上新文件之后保存进程被杀（没给出结果行）：不能报成没写入
rl_world true
cat > "$RL_W/mv" <<W
#!/usr/bin/env bash
"$REAL_MV2" "\$@"; rc=\$?
[ "\${@: -1}" = "$CONF" ] && kill -9 "\$PPID"
exit \$rc
W
chmod +x "$RL_W/mv"; rl_run "$SANDBOX/rl-off.sh"
chk "换上新文件后保存进程被杀：UNCONFIRMED、退出非 0" "$(rl_last) $([ "$RL_RC" != 0 ] && echo nz)" "UNCONFIRMED: no result line nz"
chk "保存进程被杀：文件里其实已是 false（所以不能说没写入）" "$(rl_val) $(grep -c '^RESULT=' <<<"$RL_OUT")" "false 0"
rm -f "$RL_W/mv"; rl_run "$SANDBOX/rl-check.sh"
chk "保存进程被杀之后照说明跑查值：显示 false" "$RL_OUT" "ENABLE_ROUND_LOG=false"

rl_world true; rl_wrap_jq '.fields[] | select(.name == "ENABLE_ROUND_LOG") | .value' fail; rl_run "$SANDBOX/rl-off.sh"
chk "保存成功、读回失败：UNCONFIRMED、退出非 0" "$(rl_last) $(grep -c '^RESULT=saved$' <<<"$RL_OUT") $([ "$RL_RC" != 0 ] && echo nz)" "UNCONFIRMED: saved, read-back failed 1 nz"
chk "读回失败：文件里已是 false" "$(rl_val)" "false"
rm -f "$RL_W/jq"; rl_run "$SANDBOX/rl-check.sh"
chk "读回失败之后照说明跑查值：显示 false" "$RL_OUT" "ENABLE_ROUND_LOG=false"

# 想恢复时：重新打开，照字面跑，中英两份一字不差
chk "round-log-on-ops：中英两份文档里的命令一字不差" "$(doc_block operations.zh.md round-log-on-ops)" "$(doc_block operations.md round-log-on-ops)"
doc_block operations.md round-log-on-ops > "$SANDBOX/rl-on.sh"
chk "文档里不再有查标签的检查命令" "$(doc_block operations.md round-log-busy-ops; doc_block operations.zh.md round-log-busy-ops)" ""
rl_world false; rl_run "$SANDBOX/rl-on.sh"
chk "重新打开：最后一行 ROUND_LOG=on、退出 0、配置里变成 true" "$(rl_last) $RL_RC $(rl_val)" "ROUND_LOG=on 0 true"
rl_world false; chmod 000 "$CONF"; rl_run "$SANDBOX/rl-on.sh"; chmod 640 "$CONF"
chk "重新打开时配置读不了：没写入、文件不变" "$(rl_last) $(rl_val)" "NOT_WRITTEN: config unreadable false"


echo
echo "通过 $pass，失败 $fail"
report_counts "$pass" "$fail"
[ "$fail" = 0 ]
