#!/usr/bin/env bash
# kind: install
# 读 / 改一个已接项目的常用配置项（GitHub#388）：scripts/project-config.sh + scripts/config-fields.txt。
#
# 全部在假 HOME 下跑**真实**脚本，断言输出和落盘文件——不读源码文本。
#
#   1. get：值、配置文件里写没写、可不可改和原因；命令 / 钩子 / 令牌不出现；读不出不给值；改名前的旧安装
#   2. set：只动那几行、注释和权限保留、备份等于原文件、没写过的项追加、末尾无换行、软链接、和原值一样
#   3. 拒绝写入的每种情况文件不变，旁边各有一个合规的同样保存确实写进去了
#   4. 保存进行中的外部写入：在真实的 cp / mv 前后插入一次外部修改（包装命令，脚本没有测试开关）
#   5. 两次保存同时发生
#   6. 备份是内容快照、只留最近 10 份
#   7. 登记表：每项都在配置模板里；「不写时的值」和登记册、和真实加载 _lib.sh 后的值一致；禁止的类别不在里面
#   8. 文档里写给人照做的命令，按字面在空环境跑通（中英两份一字不差）
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
rm -f "$HLOG" "$HLOG.fired"
( printf '{"MAX_CONCURRENT_WORKERS":"2"}' | env -i HOME="$H" PATH="$HK:$SYS_PATH" HOOK_MODE=after_snap:slow HOOK_LOG="$HLOG" HOOK_CONF="$CONF" bash "$PC" set widget --rev "$rev" > "$SANDBOX/a.out" 2>&1 ) &
apid=$!
for _ in $(seq 50); do [ -e "$HLOG.fired" ] && break; sleep 0.1; done
save alias '{"REVIEW_MAX_ROUNDS":"9"}' "$rev2" --lock-wait 0
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
    def="$(col 4 "$k")"; type="$(col 3 "$k")"
    reg="$(grep -E "^$k[[:space:]]*\|" "$NOTICES" | head -1)"
    case "$reg" in
        *"| quiet | 不写这一行时的行为和模板里的值相同"*) [ "$def" = "$tv" ] || bad="$bad $k:登记册说和模板一样，模板[$tv]登记表[$def]" ;;
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
LIBKEYS="WORKER_AGENT WORKER_MODEL REVIEW_WORKER_AGENT REVIEW_MODEL REVIEW_MAX_ROUNDS REVIEW_DESIGN_PROPOSALS OUTPUT_LANGUAGE COMMENT_FOOTER BLOCKED_RECHECK_SECS BLOCKED_MAX_TRIES POLL_IDLE_PROBE LOG_LEVEL DISPATCH_MODE LABEL_PENDING_REVIEW LABEL_AUTOPILOT LABEL_PENDING_BLOCKED"
loaded="$(env -i HOME="$MIN" PATH="$SYS_PATH" CODING_AGENT_CONFIG="$MIN/cavil-loop.config" bash -c '
    source "$1/scripts/_lib.sh" >/dev/null 2>&1 || { echo LOAD_FAILED; exit 1; }
    shift; for k in "$@"; do printf "%s=%s\n" "$k" "${!k-<未设置>}"; done
    if concurrent_work_enabled; then echo ENABLE_CONCURRENT_WORK_HINT=true; else echo ENABLE_CONCURRENT_WORK_HINT=false; fi
' _ "$REPO_DIR" $LIBKEYS 2>&1)"
want="$(for k in $LIBKEYS ENABLE_CONCURRENT_WORK_HINT; do printf '%s=%s\n' "$k" "$(col 4 "$k")"; done)"
chk "真实加载公共库（配置里一项都不写）后的值 = 登记表的「不写时的值」（17 项）" "$loaded" "$want"
chk "禁止的类别不在登记表里（命令、钩子、令牌、地址、目录、项目名）" \
    "$(grep -E '(_CMD|_HOOK|TOKEN|_EXEC|_URL|_ROOT|_DIR|_BASE|_PREFIX|_FLAGS|_ENV|^REPO|WEBHOOK|_KEY)$' <<<"$names" | tr '\n' ' ')" ""
chk "只显示的那四项确实登记成 show" "$(for k in DISPATCH_MODE LABEL_PENDING_REVIEW LABEL_AUTOPILOT LABEL_PENDING_BLOCKED; do col 5 "$k"; done | tr '\n' ' ')" "show show show show "

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

echo
echo "通过 $pass，失败 $fail"
report_counts "$pass" "$fail"
[ "$fail" = 0 ]
