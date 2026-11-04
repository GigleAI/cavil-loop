#!/usr/bin/env bash
# 统一测试入口 tests/run.sh 的守卫（GitHub#117：PR 上自动跑测试）。
#
# 跑法：bash tests/run.test.sh            默认回归
#       MUTATION=1 bash tests/run.test.sh  另跑负对照（改坏入口脚本的副本，断言必须变红）
# 依赖：bash 4+、coreutils（timeout）、awk。不碰网络，不跑真测试——
#       用假测试目录（RUN_TESTS_DIR）以真子进程调用入口；只有【2】读真实 tests/ 的清单（--list，不执行）。
#
# 为什么要有这个文件：CI 上这条检查的价值全靠入口脚本说真话，而它的失败模式都是**静默变绿**——
#   · 分组漏了一个文件 → 那个测试从此没人跑，检查照样绿
#   · 测试缺依赖自己打印「⏭ 跳过」再退出 0 → 看起来是通过
#   · 汇总只数「失败的」不数「缺的」→ 某一路没跑起来也绿
#   · 超时 / 退出码没传出来 → 挂死或失败被吞
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
RUNSH="$TEST_DIR/run.sh"
# shellcheck source=lib/mutation.sh
source "$TEST_DIR/lib/mutation.sh"

# 本文件自己也常常跑在 run.sh / GitHub Actions 底下：外层的这些变量不能漏进被测的那次运行，
# 否则被测的 run.sh 会以为自己在 Actions 里（折叠输出、写外层的步骤摘要）。需要时各场景显式设。
unset GITHUB_ACTIONS GITHUB_STEP_SUMMARY RUN_TESTS_DIR RUN_TEST_TIMEOUT

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

pass=0; fail=0
chk() {
    if [ "$2" = "$3" ]; then echo "  ✅ $1"; pass=$((pass+1))
    else echo "  ❌ $1 (期望 [$3]，实得 [$2])"; fail=$((fail+1)); fi
}

# ── 假测试目录 ─────────────────────────────────────────────────────────────────
# mkfx <dir> <kind:name>...   kind: pass / fail / selfskip / groupskip / sleep / mut / cwd
# 每个假测试执行时都在 <dir>/../ran/<name> 留一个标记，用来断言「真的跑了 / 真的没跑」。
mkfx() {
    local dir="$1"; shift
    mkdir -p "$dir" "$(dirname "$dir")/ran"
    local spec kind name f
    for spec in "$@"; do
        kind="${spec%%:*}"; name="${spec#*:}"; f="$dir/$name.test.sh"
        printf '#!/usr/bin/env bash\ntouch "$(dirname "$0")/../ran/%s"\n' "$name" > "$f"
        case "$kind" in
            pass)      echo 'echo "  ✅ fine"; exit 0' >> "$f" ;;
            fail)      echo 'echo "BOOM-MARKER from the test"; exit 3' >> "$f" ;;
            selfskip)  echo 'echo "⏭  跳过：缺 something"; exit 0' >> "$f" ;;
            groupskip) printf '%s\n' 'echo "  ⏭  本机没有 x，跳过本组"' 'echo "  ✅ rest ran"' 'exit 0' >> "$f" ;;
            sleep)     echo 'sleep 4; exit 0' >> "$f" ;;
            mut)       echo 'echo "MUT=[${MUTATION:-}]"; exit 0' >> "$f" ;;
            cwd)       echo 'pwd > "$(dirname "$0")/../ran/cwd.txt"; exit 0' >> "$f" ;;
        esac
    done
}
ran() { [ -e "$(dirname "$1")/ran/$2" ] && echo yes || echo no; }
# run.sh 的 stdout/stderr 存到 $OUTF，返回码到 $RC
OUTF="$TMP/out.txt"
runsh() { local r="$1"; shift; RC=0; RUN_TESTS_DIR="$FX" bash "$r" "$@" > "$OUTF" 2>&1 || RC=$?; }
status_of() { awk -F'\t' -v n="$2" '$1 == n { print $2 }' "$1/results.tsv"; }

# ── 场景（每个场景用传入的 run.sh 跑，负对照复用同一函数） ─────────────────────

# 【1】分组：每个文件恰好落进一路；--ci 去掉排除项；结果稳定；新文件自动纳入
part_fixture() {
    rm -rf "$TMP/p"; FX="$TMP/p/tests"
    mkfx "$FX" pass:a pass:b pass:c pass:d pass:e pass:f pass:g pass:x
    printf 'a 100\nb 30\nc 30\nd 20\ne 10\nf 10\n' > "$FX/ci-weights.txt"     # g、x 没登记 → 按 5 秒
    printf 'x  needs a real thing\n' > "$FX/ci-exclude.txt"
}
# 输出：每个文件出现的次数（按名字排序，name=count），只看 --ci 下 N 路的并集
part_union() {  # $1 run.sh, $2 N
    local k; for k in $(seq 1 "$2"); do RUN_TESTS_DIR="$FX" bash "$1" --ci --list --shard "$k/$2"; done \
        | awk '{ c[$2]++ } END { for (n in c) print n "=" c[n] }' | LC_ALL=C sort | paste -sd' '
}
scenario_partition() {  # $1 run.sh → 打印 union
    part_fixture; part_union "$1" 3
}
scenario_heavy_alone() {  # 最重的文件（a=100 > 总量/3）独占一路
    part_fixture
    RUN_TESTS_DIR="$FX" bash "$1" --ci --list --shard 1/3 | awk '{print $2}' | paste -sd' '
}

# 【3】全绿的一次运行：退出 0；每个都 pass 且真的跑了；--ci 下排除项不跑但记成 excluded
scenario_allpass() {  # $1 run.sh → 打印 "rc a b excl_ran excl_status"
    rm -rf "$TMP/ap"; FX="$TMP/ap/tests"
    mkfx "$FX" pass:a pass:b selfskip:excl
    printf 'excl  needs a real thing\n' > "$FX/ci-exclude.txt"
    runsh "$1" --ci --out "$TMP/ap/out"
    echo "$RC $(status_of "$TMP/ap/out" a) $(status_of "$TMP/ap/out" b) $(ran "$FX" a) $(ran "$FX" b) $(ran "$FX" excl) $(status_of "$TMP/ap/out" excl)"
}

# 【4】有一个失败：整体退出非 0，结果记 fail，终端里看得到它的输出
scenario_fail() {
    rm -rf "$TMP/f"; FX="$TMP/f/tests"
    mkfx "$FX" pass:a fail:broken
    runsh "$1" --out "$TMP/f/out"
    echo "$RC $(status_of "$TMP/f/out" broken) $(status_of "$TMP/f/out" a) $(grep -c 'BOOM-MARKER' "$OUTF")"
}

# 【5】整个文件跳过、又不在排除清单 → 判红；在清单里（本机不加 --ci 时会跑到它）→ 不判红
scenario_selfskip() {
    rm -rf "$TMP/s"; FX="$TMP/s/tests"
    mkfx "$FX" pass:a selfskip:quiet selfskip:listed
    printf 'listed  needs a real thing\n' > "$FX/ci-exclude.txt"
    runsh "$1" --out "$TMP/s/out"
    echo "$RC $(status_of "$TMP/s/out" quiet) $(status_of "$TMP/s/out" listed) $(ran "$FX" quiet)"
}

# 【7】超时：判 timeout、整体非 0
scenario_timeout() {
    rm -rf "$TMP/t"; FX="$TMP/t/tests"
    mkfx "$FX" sleep:slow
    RC=0; RUN_TEST_TIMEOUT=1 RUN_TESTS_DIR="$FX" bash "$1" --out "$TMP/t/out" > "$OUTF" 2>&1 || RC=$?
    echo "$RC $(status_of "$TMP/t/out" slow)"
}

# 【9】汇总：各路结果合起来，每个该跑的恰好通过一次才算绿
verify_fixture() {
    rm -rf "$TMP/v"; FX="$TMP/v/tests"
    mkfx "$FX" pass:a pass:b pass:c pass:d pass:e selfskip:x
    printf 'a 40\nb 30\nc 20\n' > "$FX/ci-weights.txt"
    printf 'x  needs a real thing\n' > "$FX/ci-exclude.txt"
    local k; for k in 1 2 3; do RUN_TESTS_DIR="$FX" bash "$RUNSH" --ci --shard "$k/3" --out "$TMP/v/res/shard-$k" > /dev/null 2>&1; done
}
verify_rc() {  # $1 run.sh $2 dir
    local rc=0; RUN_TESTS_DIR="$FX" bash "$1" --ci --verify "$2" > "$OUTF" 2>&1 || rc=$?; echo "$rc"
}
scenario_verify_missing() {  # 删掉一路的结果 → 必须红
    verify_fixture; rm -rf "$TMP/v/res/shard-2"; verify_rc "$1" "$TMP/v/res"
}

# ══ 默认回归 ═══════════════════════════════════════════════════════════════════
echo "【1】分组：不重不漏、排除项不进、稳定、新文件自动纳入"
part_fixture   # 主 shell 里也建一份，下面直接用 $FX（场景函数在 $( ) 子 shell 里，设的变量带不出来）
chk "3 路并集：每个非排除文件恰好一次，排除项 x 不在" "$(scenario_partition "$RUNSH")" "a=1 b=1 c=1 d=1 e=1 f=1 g=1"
first=$(RUN_TESTS_DIR="$FX" bash "$RUNSH" --ci --list --shard 3/3 | paste -sd' ')
second=$(RUN_TESTS_DIR="$FX" bash "$RUNSH" --ci --list --shard 3/3 | paste -sd' ')
chk "同一份文件两次分组结果相同（各路分别计算也对得上）" "$second" "$first"
[ -n "$first" ] && nonempty=yes || nonempty=no
chk "第 3 路确实分到了文件" "$nonempty" "yes"
chk "最重的文件独占一路" "$(scenario_heavy_alone "$RUNSH")" "a"
chk "不加 --ci 时排除项照常在清单里" "$(RUN_TESTS_DIR="$FX" bash "$RUNSH" --list | awk '$2=="x"' | wc -l)" "1"
mkfx "$FX" pass:newcomer
chk "新加的测试文件不用登记就进了某一路" "$(part_union "$RUNSH" 3 | tr ' ' '\n' | grep -c '^newcomer=1$')" "1"
chk "分 1 路时就是全部" "$(RUN_TESTS_DIR="$FX" bash "$RUNSH" --ci --list --shard 1/1 | wc -l)" "8"

echo "【2】真实 tests/：4 路并集正好是全部测试减去排除清单"
expected=$(cd "$TEST_DIR" && for f in *.test.sh; do n=${f%.test.sh}; grep -qE "^$n[[:space:]]" ci-exclude.txt || echo "$n"; done | LC_ALL=C sort | paste -sd' ')
got=$(for k in 1 2 3 4; do bash "$RUNSH" --ci --list --shard "$k/4"; done | awk '{print $2}' | LC_ALL=C sort | paste -sd' ')
chk "并集 = 全部 − 排除" "$got" "$expected"
chk "没有文件出现两次" "$(for k in 1 2 3 4; do bash "$RUNSH" --ci --list --shard "$k/4"; done | awk '{print $2}' | sort | uniq -d | wc -l)" "0"
chk "清单里确有测试（不是两边都空）" "$([ "$(echo "$got" | wc -w)" -gt 40 ] && echo yes || echo no)" "yes"
# 最慢的 requester-bot 那一路不该再背别的重测试（参考时间 1 秒以内的零碎文件挤进来不影响总时长）
rb_shard=$(for k in 1 2 3 4; do bash "$RUNSH" --ci --list --shard "$k/4" | awk -v k="$k" '$2 == "requester-bot" {print k}'; done)
rb_others=$(bash "$RUNSH" --ci --list --shard "$rb_shard/4" | awk '$2 != "requester-bot" {print $2}' \
    | while read -r n; do awk -v n="$n" '$1 == n {print $2; f=1} END {if (!f) print 5}' "$TEST_DIR/ci-weights.txt"; done \
    | awk '{s += $1} END {print s + 0}')
chk "requester-bot（最慢）那一路没有别的重测试（同路其余文件参考时间合计 ≤ 5 秒）" \
    "$([ -n "$rb_shard" ] && awk -v s="$rb_others" 'BEGIN {exit !(s <= 5)}' && echo yes || echo "no（第 ${rb_shard:-?} 路，其余合计 ${rb_others} 秒）")" yes
chk "排除清单里的 preview-socket-activation 不在 --ci 清单" "$(bash "$RUNSH" --ci --list | awk '$2=="preview-socket-activation"' | wc -l)" "0"

echo "【3】全绿：退出 0、真的跑了、排除项没跑但有记录"
chk "rc / 两个结果 / 两个真跑了 / 排除项没跑 / 记成 excluded" "$(scenario_allpass "$RUNSH")" "0 pass pass yes yes no excluded"
chk "汇总表写进了 summary.md" "$(grep -c '^| `a` | ✅ pass' "$TMP/ap/out/summary.md")" "1"
chk "每个测试的完整输出存成了日志" "$(grep -c 'fine' "$TMP/ap/out/logs/a.log")" "1"
FX="$TMP/ap/tests"; mkfx "$FX" cwd:cwd
runsh "$RUNSH" cwd --out "$TMP/ap/out2"
chk "测试在仓库根目录下运行" "$(cat "$TMP/ap/ran/cwd.txt" 2>/dev/null)" "$(cd "$TMP/ap" && pwd)"

echo "【4】有失败：退出非 0，看得到失败输出"
chk "rc / broken=fail / a=pass / 终端里有失败输出" "$(scenario_fail "$RUNSH")" "1 fail pass 1"

echo "【5】整个文件跳过"
chk "rc / 没登记的判 skipped / 登记过的不判红 / 它确实被执行了" "$(scenario_selfskip "$RUNSH")" "1 skipped skipped-ok yes"
rm -rf "$TMP/s2"; FX="$TMP/s2/tests"; mkfx "$FX" selfskip:listed
printf 'listed  needs a real thing\n' > "$FX/ci-exclude.txt"
runsh "$RUNSH" --out "$TMP/s2/out"
chk "只有登记过的自跳过文件 → 本机整体仍是绿的" "$RC" "0"

echo "【6】文件里只跳过一组：照常判 pass，并注明"
rm -rf "$TMP/g"; FX="$TMP/g/tests"; mkfx "$FX" groupskip:partial
runsh "$RUNSH" --out "$TMP/g/out"
chk "rc / 结果" "$RC $(status_of "$TMP/g/out" partial)" "0 pass"
chk "注明跳过了几组" "$(awk -F'\t' '$1=="partial"{print $4}' "$TMP/g/out/results.tsv")" "1 group(s) skipped inside the file"

echo "【7】超时"
chk "rc / 结果" "$(scenario_timeout "$RUNSH")" "1 timeout"

echo "【8】MUTATION 原样传给测试；GitHub Actions 下按测试折叠、失败打 error"
rm -rf "$TMP/m"; FX="$TMP/m/tests"; mkfx "$FX" mut:m fail:broken
RC=0; MUTATION=1 GITHUB_ACTIONS=true GITHUB_STEP_SUMMARY="$TMP/m/summary" RUN_TESTS_DIR="$FX" bash "$RUNSH" --out "$TMP/m/out" > "$OUTF" 2>&1 || RC=$?
chk "测试读到 MUTATION=1" "$(grep -c 'MUT=\[1\]' "$TMP/m/out/logs/m.log")" "1"
chk "每个测试一个折叠组" "$(grep -c '^::group::' "$OUTF")" "2"
chk "失败的测试有一条 ::error" "$(grep -c '^::error title=broken fail::' "$OUTF")" "1"
chk "失败输出打在折叠组外（共出现两次：组内 + 组外）" "$(grep -c 'BOOM-MARKER' "$OUTF")" "2"
chk "结果表写进了 Actions 的步骤摘要" "$(grep -c '^| `broken` | ❌ fail' "$TMP/m/summary")" "1"

echo "【9】汇总各路结果"
verify_fixture
chk "三路都在 → 绿" "$(verify_rc "$RUNSH" "$TMP/v/res")" "0"
chk "绿的那次确实读到了 5 个结果" "$(grep -c 'All 5 tests passed' "$OUTF")" "1"
chk "汇总里列出排除项及原因" "$(grep -c '`x` — needs a real thing' "$OUTF")" "1"
chk "少了一路 → 红" "$(scenario_verify_missing "$RUNSH")" "1"
chk "少了一路 → 说清是哪个测试没结果" "$(grep -c 'no result (no shard ran it)' "$OUTF")" "$(awk 'END{print NR}' <(RUN_TESTS_DIR="$FX" bash "$RUNSH" --ci --list --shard 2/3))"
verify_fixture; cp -r "$TMP/v/res/shard-1" "$TMP/v/res/shard-1-again"
chk "同一路结果出现两次 → 红" "$(verify_rc "$RUNSH" "$TMP/v/res")" "1"
verify_fixture; f=$(grep -l . "$TMP"/v/res/shard-*/results.tsv | head -1); sed -i '1s/\tpass\t/\tfail\t/' "$f"
chk "有一个结果是 fail → 红" "$(verify_rc "$RUNSH" "$TMP/v/res")" "1"
verify_fixture; printf 'ghost\tpass\t1\t\n' >> "$TMP/v/res/shard-1/results.tsv"
chk "多出一个不该有的结果 → 红" "$(verify_rc "$RUNSH" "$TMP/v/res")" "1"
verify_fixture; printf 'x\texcluded\t0\tneeds a real thing\n' >> "$TMP/v/res/shard-1/results.tsv"
chk "排除项的 excluded 记录不算多余" "$(verify_rc "$RUNSH" "$TMP/v/res")" "0"

echo "【10】排除清单写错 / 参数冲突：直接报错"
rm -rf "$TMP/e"; FX="$TMP/e/tests"; mkfx "$FX" pass:a
printf 'gone  removed long ago\n' > "$FX/ci-exclude.txt"
runsh "$RUNSH" --ci --list
chk "清单里的文件不存在 → 退出 2" "$RC" "2"
chk "并说明是哪一个" "$(grep -c 'lists gone' "$OUTF")" "1"
printf 'a\n' > "$FX/ci-exclude.txt"
runsh "$RUNSH" --ci --list
chk "没写原因 → 退出 2" "$RC" "2"
rm -f "$FX/ci-exclude.txt"
runsh "$RUNSH" --shard 1/2 a
chk "--shard 和指定测试名混用 → 退出 2" "$RC" "2"
runsh "$RUNSH" --shard 3/2
chk "--shard 越界 → 退出 2" "$RC" "2"

# ══ 负对照：改坏入口脚本的副本，对应场景必须变红 ════════════════════════════════
echo "【负对照】"
mutant() {  # $1 名字  $2 python 替换：旧 → 新（必须恰好命中一次）
    local dst="$TMP/mut-$1.sh"
    python3 - "$RUNSH" "$dst" "$2" "$3" <<'PY' || return 1
import sys
src, dst, old, new = sys.argv[1:5]
s = open(src).read()
if s.count(old) != 1:
    sys.exit("mutation target found %d times: %r" % (s.count(old), old))
open(dst, "w").write(s.replace(old, new))
PY
    echo "$dst"
}
neg() {  # $1 说明  $2 场景函数  $3 正确实现的期望值  $4 名字  $5 旧  $6 新
    mutation_gate || return 0
    local m; m=$(mutant "$4" "$5" "$6") || { echo "  ❌ 负对照准备失败：$1"; fail=$((fail+1)); return; }
    local got; got=$("$2" "$m")
    if [ "$got" != "$3" ]; then echo "  ✅ 负对照拦下：$1"; pass=$((pass+1))
    else echo "  ❌ 负对照没拦下：$1（改坏后仍得到 [$got]）"; fail=$((fail+1)); fi
}
neg "分组漏掉最后一个文件" scenario_partition "a=1 b=1 c=1 d=1 e=1 f=1 g=1" drop-last \
    'load[best] += $1; print best, $2 }' 'load[best] += $1; if (NR > 1) print best, $2 }'
neg "分组总放进第 1 路" scenario_heavy_alone "a" all-in-one \
    'if (load[i] + 0 < load[best] + 0) best = i' 'if (0) best = i'
neg "--ci 不去掉排除项" scenario_allpass "0 pass pass yes yes no excluded" ci-runs-excluded \
    'if [ "$CI_MODE" = 1 ] && [ -n "${EXCLUDED[$n]+x}" ]; then continue; fi' ':'
neg "失败不影响退出码" scenario_fail "1 fail pass 1" swallow-exit \
    'if [ "$failed" -gt 0 ]; then echo "❌ $failed of ${#RUN[@]} failed"; exit 1; fi' ':'
neg "整文件跳过当成通过" scenario_selfskip "1 skipped skipped-ok yes" no-skip-check \
    "elif grep -qE '^⏭' \"\$log\"; then" 'elif false; then'
neg "超时没生效" scenario_timeout "1 timeout" no-timeout \
    '"${TIMEOUT_CMD[@]}" bash' 'bash'
neg "汇总只看收到的结果、不对照该跑的清单" scenario_verify_missing "1" verify-no-missing \
    'for n in $(selected); do
        c=${SEEN[$n]:-0}' 'for n in "${!SEEN[@]}"; do
        c=${SEEN[$n]:-0}'

echo
mutation_summary "$0"
echo "结果：$pass 通过 / $fail 失败"
[ "$fail" -eq 0 ]
