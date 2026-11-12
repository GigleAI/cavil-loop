#!/usr/bin/env bash
# kind: guard
# 脚本里「$变量 后面直接跟中文」的写法（GitHub#411）。
#
# macOS 自带的 bash 3.2 判断变量名到哪里结束时，把 UTF-8 中文的首字节也算进名字：
# "$label：" 去找一个不存在的变量，set -u 下脚本直接退出（客户端「更新 daemon」就是这样中途退出的）。
# 规则：会被展开的位置，变量后面紧跟非 ASCII 字符时一律写 ${label}。
#
# 测两件事：
#   1. 找这种写法的扫描器（tests/lib/bash_multibyte_vars.py）和真实 bash 逐例对拍：在测试临时目录生成
#      单字节字符集（ISO-8859-1）的区域设置，Linux 的 bash 在其中读变量名的方式和 macOS bash 3.2 相同；
#      每个例子用真 bash 在 set -u 下跑一遍，「bash 报变量未定义」必须和「扫描器报出」一致——
#      单引号、注释、引号界定符的 here-doc 是原样文字，不会出错，也不能报
#   2. 仓库里所有非测试脚本（scripts/ 下全部 .sh 和 setup.sh）扫描结果为零；修复工具改过的例子能在
#      单字节下跑通
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

echo "── 1. 扫描器与真实 bash 逐例对拍 ──"
# 每例：<名字>|<期望扫描器报出几处>|<脚本正文>。正文前统一加 set -u 和两个变量；
# 期望数只用来让例子写错时看得出来，判定以真 bash 的结果为准。
cases=(
'双引号|1|echo "a $x：b"'
'不加引号|1|echo a$x，b'
'花括号已加|0|echo "a ${x}：b"'
'单引号原样|0|echo '"'"'a $x：b'"'"
'单引号在双引号里不算引号|1|echo "it'"'"'s $x：b"'
'$'"'"'...'"'"' 原样|0|echo $'"'"'$x：b'"'"
'注释|0|true # $x：b'
'命令替换里|1|echo "$(echo "$x：")"'
'反引号里|1|echo `echo $x：`'
'${a:+…} 里|1|echo "${x:+（$y）}"'
'here-string|1|cat <<< "$x：b"'
'here-string 之后的 here-doc 照样认|1|cat <<< "$x" >/dev/null; cat <<EOF
$y：b
EOF'
'不加引号的 here-doc|1|cat <<EOF
a $x：b
EOF'
'引号界定符的 here-doc 原样|0|cat <<'"'"'EOF'"'"'
a $x：b
EOF'
'<<- 的 here-doc|1|cat <<-EOF
	a $x：b
	EOF'
'here-doc 之后回到代码|1|cat <<'"'"'EOF'"'"' >/dev/null
$x：原样
EOF
echo "$y：b"'
'多行双引号|1|echo "第一行
$x：第二行"'
'$((…)) 后面|1|echo "$((1+1)) $x："'
'位置参数和特殊变量|0|set -- a; echo "$1：$#：$?："'
)
for c in "${cases[@]}"; do
    name="${c%%|*}"; rest="${c#*|}"; want="${rest%%|*}"; body="${rest#*|}"
    f="$SANDBOX/case.sh"
    printf 'set -u\nx=v; y=w\n%s\n' "$body" > "$f"
    rc=0; err="$(sb bash "$f" 2>&1 >/dev/null)" || rc=$?
    case "$err" in *"unbound variable"*) bash_says=1 ;; *) bash_says=0 ;; esac
    hits="$(python3 "$SCAN" check "$f" | grep -c .)"
    scan_says=$([ "$hits" -gt 0 ] && echo 1 || echo 0)
    chk "$name：真 bash 出错=$bash_says，扫描器报出=$scan_says（应报 $want 处）" "$bash_says $scan_says $hits" "$scan_says $bash_says $want"
done

echo "── 2. 修复工具改过之后，单字节下能跑通 ──"
f="$SANDBOX/fix.sh"
printf 'set -u\nx=v; y=w\necho "a $x：b" "$(echo "$y，c")"\ncat <<EOF\n$x：d\nEOF\necho '"'"'$x：原样'"'"'\n' > "$f"
python3 "$SCAN" fix "$f" > /dev/null
rc=0; out="$(sb bash "$f" 2>&1)" || rc=$?
chk "改过的例子：退出 0、展开正确、单引号里原样不动" "$rc $(printf '%s' "$out" | tr '\n' '|')" '0 a v：b w，c|v：d|$x：原样'
chk "改过的例子：扫描结果为零" "$(python3 "$SCAN" check "$f" | grep -c .)" 0

echo "── 3. 仓库脚本里没有这种写法 ──"
mapfile -t files < <(cd "$REPO_DIR" && { git ls-files -- 'scripts/*.sh' 'scripts/**/*.sh'; echo setup.sh; } | sort -u)
chk "扫描的脚本数不为零（git ls-files 读到了）" "$([ "${#files[@]}" -gt 20 ] && echo ok || echo "${#files[@]}")" ok
found="$(cd "$REPO_DIR" && python3 "$SCAN" check "${files[@]}")"
chk "scripts/ 和 setup.sh 里没有「\$变量 紧跟非 ASCII 字符」（有就改成 \${变量}）" "$found" ""

echo
echo "通过 $pass，失败 $fail"
report_counts "$pass" "$fail"
[ "$fail" -eq 0 ]
