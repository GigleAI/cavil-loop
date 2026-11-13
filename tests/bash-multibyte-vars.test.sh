#!/usr/bin/env bash
# kind: guard
# reads: repo
# 脚本里「$变量 后面直接跟中文」的写法（GitHub#411）。
#
# macOS 自带的 bash 3.2 判断变量名到哪里结束时，把 UTF-8 中文的首字节也算进名字：
# "$label：" 去找一个不存在的变量，set -u 下脚本直接退出（客户端「更新 daemon」就是这样中途退出的）。
# 规则：脚本里任何位置都不许出现「$变量 紧跟非 ASCII 字符」，写成 ${label}。检查是逐字匹配，不分
# 引号、注释、here-doc——会不会被展开要靠解析 shell 才知道，PR #417 三轮复审各找出一种手写解析认错的
# 写法（${…} 里的单引号、数组下标、算术左移 << 被当成 here-doc），漏一种就放过一处真展开，或者让
# 自动修复改坏原样文字。逐字匹配不会漏；代价是原样文字和注释里也得换个写法，所以也不提供自动修复。
#
# 测两件事：
#   1. 逐字检查和真实 bash 逐例对拍：在测试临时目录生成单字节字符集（ISO-8859-1）的区域设置，Linux 的
#      bash 在其中读变量名的方式和 macOS bash 3.2 相同；每个例子用真 bash 在 set -u 下跑一遍。凡是
#      bash 报变量未定义的例子，检查必须报出（不许漏）；单引号、注释等原样文字 bash 不出错，检查照样
#      报出（规则本来就不许这样写）；加了花括号、位置参数这类，两边都不报。三轮复审给出的输入都在里面
#   2. 仓库里所有非测试脚本（scripts/ 下全部 .sh 和 setup.sh）检查结果为零
# 客户端会调的几个安装脚本在单字节下真跑一遍，放在 tests/install-scripts.test.sh 第 8 组。
#
#   bash tests/bash-multibyte-vars.test.sh
set -uo pipefail
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCAN="$REPO_DIR/tests/lib/bash_multibyte_vars.py"
SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT

pass=0; fail=0
chk() {
    if [ "$2" = "$3" ]; then echo "  ✅ $1"; pass=$((pass+1))
    else echo "  ❌ $1"; echo "     期望：[$3]"; echo "     实得：[$2]"; fail=$((fail+1)); fi
}

LOC="$SANDBOX/locale"; mkdir -p "$LOC"
loc_rc=0; localedef -i en_US -f ISO-8859-1 "$LOC/en_US.ISO-8859-1" > "$SANDBOX/localedef.out" 2>&1 || loc_rc=$?
sb() { env LOCPATH="$LOC" LC_ALL=en_US.ISO-8859-1 "$@"; }

echo "── 0. 单字节区域设置复现 macOS 的读法 ──"
probe_bad="$(sb bash -uc 'v=x; echo "$v：ok"' 2>&1)"; probe_good="$(sb bash -uc 'v=x; echo "${v}：ok"' 2>&1)"
chk "不加花括号报变量未定义、加了正常（复现不了就判红，不跳过）" \
    "$(case "$probe_bad" in *"unbound variable"*) echo reproduced ;; *) echo "not-reproduced(localedef=$loc_rc)" ;; esac) $probe_good" \
    "reproduced x：ok"
[ "$probe_good" = "x：ok" ] || sed 's/^/     | /' "$SANDBOX/localedef.out"

echo "── 1. 逐字检查和真实 bash 逐例对拍 ──"
# 每例：<名字>|<真 bash 会不会报变量未定义>|<检查会不会报出>|<脚本正文>。正文前统一加 set -u 和两个变量。
# 前两列都用真 bash / 真检查实测核对；另外每例都要求「bash 出错 ⇒ 检查报出」，检查不许漏。
cases=(
'双引号|1|1|echo "a $x：b"'
'不加引号|1|1|echo a$x，b'
'花括号已加|0|0|echo "a ${x}：b"'
'单引号原样|0|1|echo '"'"'a $x：b'"'"
'单引号在双引号里不算引号|1|1|echo "it'"'"'s $x：b"'
'$'"'"'...'"'"' 原样|0|1|echo $'"'"'$x：b'"'"
'注释|0|1|true # $x：b'
'命令替换里|1|1|echo "$(echo "$x：")"'
'反引号里|1|1|echo `echo $x：`'
'${a:+…} 里|1|1|echo "${x:+（$y）}"'
'here-string|1|1|cat <<< "$x：b"'
'here-string 之后的 here-doc 照样认|1|1|cat <<< "$x" >/dev/null; cat <<EOF
$y：b
EOF'
'不加引号的 here-doc|1|1|cat <<EOF
a $x：b
EOF'
'引号界定符的 here-doc 原样|0|1|cat <<'"'"'EOF'"'"'
a $x：b
EOF'
'<<- 的 here-doc|1|1|cat <<-EOF
	a $x：b
	EOF'
'here-doc 之后回到代码|1|1|cat <<'"'"'EOF'"'"' >/dev/null
$x：原样
EOF
echo "$y：b"'
'多行双引号|1|1|echo "第一行
$x：第二行"'
'$((…)) 后面|1|1|echo "$((1+1)) $x："'
'位置参数和特殊变量|0|0|set -- a; echo "$1：$#：$?："'
'双引号里 ${a:+'"'"'…'"'"'}：单引号是普通字符，照样展开|1|1|echo "${x:+'"'"'$y：'"'"'}"'
'双引号里 ${a:-'"'"'…'"'"'}：同上|1|1|echo "${z:-'"'"'$y：'"'"'}"'
'双引号里 ${a=…} 不带冒号：同上|1|1|echo "${z='"'"'$y：'"'"'}"'
'双引号外 ${a:+'"'"'…'"'"'}：单引号起引号作用|0|1|echo ${x:+'"'"'$y：'"'"'}'
'双引号里 ${a#'"'"'…'"'"'}：模式里单引号起引号作用|0|1|echo "${x#'"'"'$y：'"'"'}"'
'双引号里 ${a/…/'"'"'…'"'"'}：替换里单引号起引号作用|0|1|echo "${x/v/'"'"'$y：'"'"'}"'
'${a:+"…"} 里的双引号|1|1|echo "${x:+"$y："}"'
'不加引号的 here-doc 里 ${a:+'"'"'…'"'"'}|1|1|cat <<EOF
${x:+'"'"'$y：'"'"'}
EOF'
'${#a} 和 ${a:0:1} 后面跟中文|0|0|echo "${#x}：${x:0:1}："'
'关联数组下标里的 $x|1|1|declare -A a=([k]=ok); echo "${a[$x：]-d}"'
'数组下标里的命令替换（外层照常输出，只在里面出错）|1|1|a=(ok); echo "${a[$(printf "%s" "$x：" >/dev/null; printf 0)]}"'
'嵌套下标之后的操作符照样认出|1|1|a=(0 ok); echo "${a[a[0]]:+'"'"'$y：'"'"'}"'
'下标里的单引号（双引号里外都）起引号作用|0|1|declare -A a=([k]=ok); echo "${a['"'"'$y：'"'"']-d}" ${a['"'"'$y：'"'"']-d}'
'下标之后的默认值也会展开|1|1|a=(ok); echo "${a[1]:-$y：}"'
'嵌套 ${…} 在双引号里：单引号是普通字符|1|1|echo "${z:-${q:-'"'"'$y：'"'"'}}"'
'嵌套 ${…} 在双引号外：单引号起引号作用|0|1|echo ${z:-${q:-'"'"'$y：'"'"'}}'
'双引号外 ${a:-$'"'"'…'"'"'} 原样|0|1|echo ${z:-$'"'"'$y：'"'"'}'
'${a:?…} 的提示文字也会展开|1|1|echo "${z:?$y：}"'
'算术左移之后的单引号原样文字（复审第 3 轮的输入）|0|1|printf '"'"'%s\n'"'"' "$((1 << 2))"
printf '"'"'%s\n'"'"' '"'"'$x：原样'"'"''
'算术左移之后的展开|1|1|printf '"'"'%s\n'"'"' "$((1 << 2))" "$y："'
'算术左移和真的 here-doc 在一起|1|1|echo "$((1 << 2))"; cat <<EOF
$x：b
EOF'
)
for c in "${cases[@]}"; do
    name="${c%%|*}"; rest="${c#*|}"; want_bash="${rest%%|*}"; rest="${rest#*|}"; want_check="${rest%%|*}"; body="${rest#*|}"
    f="$SANDBOX/case.sh"
    printf 'set -u\nx=v; y=w\n%s\n' "$body" > "$f"
    err="$(sb bash "$f" 2>&1 >/dev/null)"
    case "$err" in *"unbound variable"*) bash_says=1 ;; *) bash_says=0 ;; esac
    rc=0; python3 "$SCAN" "$f" > /dev/null || rc=$?
    case "$rc" in 0) check_says=0 ;; 1) check_says=1 ;; *) check_says="错误($rc)" ;; esac
    sound=$([ "$bash_says" = 1 ] && [ "$check_says" != 1 ] && echo 漏报 || echo ok)
    chk "$name：bash 出错=$bash_says，检查报出=$check_says" "$bash_says $check_says $sound" "$want_bash $want_check ok"
done

echo "── 2. 仓库脚本里没有这种写法 ──"
mapfile -t files < <(cd "$REPO_DIR" && { git ls-files -- 'scripts/*.sh' 'scripts/**/*.sh'; echo setup.sh; } | sort -u)
chk "扫描的脚本数不为零（git ls-files 读到了）" "$([ "${#files[@]}" -gt 20 ] && echo ok || echo "${#files[@]}")" ok
found="$(cd "$REPO_DIR" && python3 "$SCAN" "${files[@]}")"
chk "scripts/ 和 setup.sh 里没有「\$变量 紧跟非 ASCII 字符」（有就改成 \${变量}；原样文字和注释里也换个写法）" "$found" ""

echo
echo "通过 $pass，失败 $fail"
report_counts "$pass" "$fail"
[ "$fail" -eq 0 ]
