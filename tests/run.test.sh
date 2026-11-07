#!/usr/bin/env bash
# kind: meta
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
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"

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
# 文件头标类型（默认 unit，FX_KIND 可改），退出 0 之前用真的 tests/lib/report.sh 报一行计数（GitHub#212）。
mkfx() {
    local dir="$1"; shift
    mkdir -p "$dir" "$(dirname "$dir")/ran"
    local spec kind name f
    for spec in "$@"; do
        kind="${spec%%:*}"; name="${spec#*:}"; f="$dir/$name.test.sh"
        printf '#!/usr/bin/env bash\n# kind: %s\nsource "%s/lib/report.sh"\ntouch "$(dirname "$0")/../ran/%s"\n' \
            "${FX_KIND:-unit}" "$TEST_DIR" "$name" > "$f"
        case "$kind" in
            pass)      echo 'echo "  ✅ fine"; exit 0' >> "$f" ;;
            fail)      echo 'echo "BOOM-MARKER from the test"; exit 3' >> "$f" ;;
            selfskip)  echo 'echo "⏭  跳过：缺 something"; exit 0' >> "$f" ;;
            groupskip) printf '%s\n' 'echo "  ⏭  本机没有 x，跳过本组"' 'echo "  ✅ rest ran"' 'exit 0' >> "$f" ;;
            sleep)     echo 'sleep 4; exit 0' >> "$f" ;;
            mut)       echo 'echo "MUT=[${MUTATION:-}]"; exit 0' >> "$f" ;;
            cwd)       echo 'pwd > "$(dirname "$0")/../ran/cwd.txt"; exit 0' >> "$f" ;;
            # 拆段（GitHub#211）：文件头声明 3 段，每段把收到的 TEST_PART 记一行
            parts3)    printf '%s\n' '# parts: 3' 'echo "${TEST_PART:-none}" >> "$(dirname "$0")/../ran/parts.txt"; exit 0' >> "$f" ;;
            # 记下自己收到的 TEST_PART（不拆段的文件应当是空的）
            seepart)   echo 'echo "[${TEST_PART:-}]" > "$(dirname "$0")/../ran/seepart.txt"; exit 0' >> "$f" ;;
            # 并行：开始时留 .live，最多等 4 秒看有没有别的单元也在跑，记下看到的最大同时数
            par)       printf '%s\n' 'R="$(dirname "$0")/../ran"; touch "$R/$$.live"; m=0' \
                           'for i in $(seq 40); do c=$(ls "$R" | grep -c "\.live$"); [ "$c" -gt "$m" ] && m=$c; [ "$m" -ge 2 ] && break; sleep 0.1; done' \
                           'sleep 0.3; echo "$m" >> "$R/par.txt"; rm -f "$R/$$.live"; exit 0' >> "$f" ;;
            # 第一次执行通过、之后每次都失败（测「同一单位只跑一次」：跑两次就会有一次红）
            once)      printf '%s\n' 'R="$(dirname "$0")/../ran"; n=$( { cat "$R/once.n" 2>/dev/null || echo 0; } ); n=$((n + 1)); echo "$n" > "$R/once.n"' \
                           '[ "$n" -eq 1 ] || { sleep 1; echo "SECOND_RUN_FAILED"; exit 1; }; exit 0' >> "$f" ;;
            # 标了 parallel: no：开始时数一数还有几个单元在跑（应当是 0）
            solo)      printf '%s\n' '# parallel: no' 'R="$(dirname "$0")/../ran"; ls "$R" | grep -c "\.live$" > "$R/solo.txt"; exit 0' >> "$f" ;;
            # 计数行的几种错法（GitHub#212）：都退出 0
            nocount)   echo 'echo "  ✅ looked fine"; exit 0' >> "$f" ;;
            twocount)  echo 'report_counts 1 0; report_counts 1 0; exit 0' >> "$f" ;;
            badcount)  echo 'echo "CAVIL_TEST_COUNTS v=1 regress_pass=x"; exit 0' >> "$f" ;;
            failcount) echo 'report_counts 4 1; exit 0' >> "$f" ;;
            # 负对照计数：MUTATION_COUNT=3，文件自己打印的「跳过」行写 $SAID 项
            mutcount)  printf '%s\n' 'MUTATION_COUNT=3; echo "负对照：跳过 ${SAID:-3} 项（默认不跑）"; report_counts 5 0; exit 0' >> "$f" ;;
            compat)    printf '%s\n' 'COMPAT_RAN=1; COMPAT_SKIPPED=2; report_counts 7 0; exit 0' >> "$f" ;;
        esac
        # 退出 0 的那几种：最后一条 exit 0 之前报计数（上面专门测计数错法的那几种自己写）
        case "$kind" in
            nocount|twocount|badcount|failcount|mutcount|compat|selfskip|fail) ;;
            *) python3 - "$f" <<'PYX'
import sys
p = sys.argv[1]; s = open(p).read(); i = s.rfind("exit 0")
open(p, "w").write(s[:i] + "report_counts 1 0; " + s[i:])
PYX
            ;;
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

echo "【2】真实 tests/：4 路并集正好是全部调度单位减去排除清单"
# 调度单位（GitHub#211）：没声明 parts 的文件是一个单位；声明了「# parts: N」的是 名字:1/N … 名字:N/N
expected=$(cd "$TEST_DIR" && for f in *.test.sh; do n=${f%.test.sh}; grep -qE "^$n[[:space:]]" ci-exclude.txt && continue
    p=$(sed -n 's/^# parts: *\([0-9][0-9]*\) *$/\1/p' "$f" | head -1)
    if [ -n "$p" ] && [ "$p" -gt 1 ]; then for k in $(seq 1 "$p"); do echo "$n:$k/$p"; done; else echo "$n"; fi
done | LC_ALL=C sort | paste -sd' ')
got=$(for k in 1 2 3 4; do bash "$RUNSH" --ci --list --shard "$k/4"; done | awk '{print $2}' | LC_ALL=C sort | paste -sd' ')
chk "并集 = 全部 − 排除" "$got" "$expected"
chk "没有单位出现两次" "$(for k in 1 2 3 4; do bash "$RUNSH" --ci --list --shard "$k/4"; done | awk '{print $2}' | sort | uniq -d | wc -l)" "0"
chk "清单里确有测试（不是两边都空）" "$([ "$(echo "$got" | wc -w)" -gt 40 ] && echo yes || echo no)" "yes"
chk "最慢的两个文件确实拆了段（autopilot 3 段、requester-bot 2 段）" \
    "$(echo "$got" | tr ' ' '\n' | grep -cE '^(autopilot:[123]/3|requester-bot:[12]/2)$')" 5
# 四路各自的参考时间合计（拆段文件的一行参考时间平分到各段，单独写了「名字:K/N」的以它为准——和 run.sh 同一规则）
unit_weight() {   # <单位>
    local u="$1" f="${1%%:*}" p w
    w=$(awk -v n="$u" '$1 == n {print $2; f=1} END {if (!f) print ""}' "$TEST_DIR/ci-weights.txt")
    if [ -n "$w" ]; then echo "$w"; return; fi
    w=$(awk -v n="$f" '$1 == n {print $2; f=1} END {if (!f) print 5}' "$TEST_DIR/ci-weights.txt")
    if [ "$u" != "$f" ]; then p=${u##*/}; awk -v w="$w" -v p="$p" 'BEGIN {printf "%.3f\n", w / p}'; else echo "$w"; fi
}
shard_total() { bash "$RUNSH" --ci --list --shard "$1/4" | awk '{print $2}' | while read -r u; do unit_weight "$u"; done | awk '{s += $1} END {printf "%.3f\n", s + 0}'; }
totals=$(for k in 1 2 3 4; do shard_total "$k"; done | paste -sd' ')
max_unit=$(for k in 1 2 3 4; do bash "$RUNSH" --ci --list --shard "$k/4"; done | awk '{print $2}' | while read -r u; do unit_weight "$u"; done | sort -g | tail -1)
# 先放最重的、每个放进当前最轻的那一路：最重一路和最轻一路之差不会超过最重的那个单位
chk "四路负载均衡：最重一路 − 最轻一路 ≤ 最重的单个调度单位（$totals；最重单位 $max_unit 秒）" \
    "$(echo "$totals" | tr ' ' '\n' | sort -g | awk -v m="$max_unit" 'NR == 1 {lo = $1} {hi = $1} END {print (hi - lo <= m + 0.001) ? "yes" : "no"}')" yes
chk "到达性 · 确实读到了各路的参考时间" "$(echo "$totals" | awk '{print ($1 > 0 && $4 > 0) ? "yes" : "no"}')" yes
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

echo "【11】拆段：每段一个调度单位，用 TEST_PART=K/N 跑一次；汇总要每段恰好通过一次（GitHub#211）"
rm -rf "$TMP/pt"; FX="$TMP/pt/tests"; mkfx "$FX" parts3:big seepart:small
chk "清单里拆段文件出现为 3 个单位" "$(RUN_TESTS_DIR="$FX" bash "$RUNSH" --list | awk '{print $2}' | paste -sd' ')" "big:1/3 big:2/3 big:3/3 small"
RC=0; TEST_PART=9/9 RUN_TESTS_DIR="$FX" bash "$RUNSH" -j 2 --out "$TMP/pt/out" > "$OUTF" 2>&1 || RC=$?
chk "rc / 三段各跑一次、各收到自己的 TEST_PART" "$RC $(LC_ALL=C sort "$TMP/pt/ran/parts.txt" | paste -sd' ')" "0 1/3 2/3 3/3"
chk "不拆段的文件收不到 TEST_PART（外面带进来的也不漏进去）" "$(cat "$TMP/pt/ran/seepart.txt")" "[]"
chk "结果里每段一行" "$(awk -F'\t' '{print $1 "=" $2}' "$TMP/pt/out/results.tsv" | LC_ALL=C sort | paste -sd' ')" "big:1/3=pass big:2/3=pass big:3/3=pass small=pass"
rm -f "$TMP/pt/ran/parts.txt"; runsh "$RUNSH" big:2/3 --out "$TMP/pt/out1"
chk "点名一段：只跑那一段" "$RC $(cat "$TMP/pt/ran/parts.txt")" "0 2/3"
runsh "$RUNSH" big:4/3 --out "$TMP/pt/out2"
chk "点名不存在的段 → 退出 2" "$RC" "2"
for k in 1 2; do RUN_TESTS_DIR="$FX" bash "$RUNSH" --shard "$k/2" --out "$TMP/pt/res/shard-$k" > /dev/null 2>&1; done
chk "各路合起来每段恰好一次 → 绿" "$(verify_rc "$RUNSH" "$TMP/pt/res" | sed 's/^/rc=/')" "rc=0"
cp -r "$TMP/pt/res" "$TMP/pt/res-miss"; grep -l 'big:2/3' "$TMP"/pt/res-miss/*/results.tsv | xargs sed -i '/^big:2\/3\t/d'
chk "少跑一段 → 红" "$(verify_rc "$RUNSH" "$TMP/pt/res-miss")" "1"
chk "  并说明是哪一段" "$(grep -c 'big:2/3: no result' "$OUTF")" 1
cp -r "$TMP/pt/res" "$TMP/pt/res-dup"; grep -h '^big:1/3' "$TMP"/pt/res/*/results.tsv >> "$TMP/pt/res-dup/shard-1/results.tsv"
chk "同一段跑了两次 → 红" "$(verify_rc "$RUNSH" "$TMP/pt/res-dup")" "1"
cp -r "$TMP/pt/res" "$TMP/pt/res-extra"; printf 'big:4/3\tpass\t1\t\n' >> "$TMP/pt/res-extra/shard-1/results.tsv"
chk "多跑一段（不存在的第 4 段）→ 红" "$(verify_rc "$RUNSH" "$TMP/pt/res-extra")" "1"
cp -r "$TMP/pt/res" "$TMP/pt/res-whole"; printf 'big\tpass\t1\t\n' >> "$TMP/pt/res-whole/shard-1/results.tsv"
chk "拆段文件又整份跑了一次 → 红" "$(verify_rc "$RUNSH" "$TMP/pt/res-whole")" "1"
printf 'big:2/3 40\nbig 30\n' > "$FX/ci-weights.txt"
chk "参考时间：段自己有一行就用它，其余段平分整份那一行" \
    "$(RUN_TESTS_DIR="$FX" bash "$RUNSH" --list --shard 1/2 | awk '{print $2}' | paste -sd' ')" "big:2/3"

echo "【12】并行：-j 2 时两个单位同时在跑；标了 parallel: no 的单独跑"
rm -rf "$TMP/j"; FX="$TMP/j/tests"; mkfx "$FX" par:p1 par:p2 solo:s
runsh "$RUNSH" -j 2 --out "$TMP/j/out"
chk "rc / 两个并行单位都看到了对方（同时数 2）" "$RC $(LC_ALL=C sort "$TMP/j/ran/par.txt" | paste -sd' ')" "0 2 2"
chk "parallel: no 的那个开始时没有别的单位在跑" "$(cat "$TMP/j/ran/solo.txt")" "0"
chk "三个都有结果" "$(awk -F'\t' '$2 == "pass"' "$TMP/j/out/results.tsv" | wc -l)" 3
rm -f "$TMP/j/ran/par.txt"; runsh "$RUNSH" -j 1 p1 p2 --out "$TMP/j/out1"
chk "-j 1：一个接一个（每个都只看到自己）" "$RC $(paste -sd' ' "$TMP/j/ran/par.txt")" "0 1 1"
runsh "$RUNSH" -j 0 --list
chk "-j 0 → 退出 2" "$RC" "2"

echo "【13】同一单位点名两次 / 整份文件和其中一段一起点名：每个单位只跑一次（PR #221 复审第 1 轮）"
# 输出：rc / 执行次数 / results.tsv 行数 / 拆段文件各段的执行记录
scenario_dup() {   # $1 run.sh
    rm -rf "$TMP/dup"; FX="$TMP/dup/tests"; mkfx "$FX" once:probe parts3:big
    RC=0; RUN_TESTS_DIR="$FX" bash "$1" probe probe big big:2/3 -j 2 --out "$TMP/dup/out" > "$OUTF" 2>&1 || RC=$?
    echo "$RC $(cat "$TMP/dup/ran/once.n" 2>/dev/null || echo 0) $(wc -l < "$TMP/dup/out/results.tsv" | tr -d ' ') $(LC_ALL=C sort "$TMP/dup/ran/parts.txt" | paste -sd,)"
}
chk "rc / probe 只执行 1 次 / 4 行结果 / 三段各 1 次" "$(scenario_dup "$RUNSH")" "0 1 4 1/3,2/3,3/3"
chk "  并说明哪些名字重复了" "$(grep -c 'named more than once' "$OUTF")" 2

echo "【14】类型标注：每个文件恰好一个合法类型，缺了、多了、写错都直接报错（GitHub#212）"
# 输出：rc / 报错里点名了这个文件
scenario_kind_bad() {   # $1 run.sh  $2 怎么改坏：none / two / bogus
    rm -rf "$TMP/kb"; FX="$TMP/kb/tests"; mkfx "$FX" pass:good pass:odd
    case "$2" in
        none)  sed -i '/^# kind:/d' "$FX/odd.test.sh" ;;
        two)   sed -i '2a # kind: e2e' "$FX/odd.test.sh" ;;
        bogus) sed -i 's/^# kind: unit$/# kind: regression/' "$FX/odd.test.sh" ;;
    esac
    runsh "$1" --out "$TMP/kb/out"
    echo "$RC $(grep -c 'odd.test.sh' "$OUTF") $(ran "$FX" good)"
}
chk "删掉类型行 → 退出 2、点名、一个都没跑" "$(scenario_kind_bad "$RUNSH" none)" "2 1 no"
chk "两行类型 → 退出 2、点名" "$(scenario_kind_bad "$RUNSH" two)" "2 1 no"
chk "写错类型 → 退出 2、点名" "$(scenario_kind_bad "$RUNSH" bogus)" "2 1 no"
rm -rf "$TMP/kb2"; FX="$TMP/kb2/tests"; mkfx "$FX" pass:good; sed -i '/^# kind:/d' "$FX/good.test.sh"
for mode in --list "--verify $TMP/kb2" "--ci --shard 1/2 --list"; do
    # shellcheck disable=SC2086
    runsh "$RUNSH" $mode
    chk "类型缺失时 $mode 也退出 2（CI 的分组、汇总都拦得住）" "$RC" "2"
done
chk "真实 tests/：每个文件都有合法类型（--list 没报错）" "$(bash "$RUNSH" --list > /dev/null 2>&1; echo $?)" "0"
chk "真实 tests/：类型行逐个文件恰好一行" \
    "$(cd "$TEST_DIR" && for f in *.test.sh; do grep -cE '^# kind: (unit|e2e|install|guard|smoke|meta)$' "$f"; done | sort -u | paste -sd' ')" "1"

echo "【15】--kind / --quick：只挑指定类型；和点名、未知类型混用直接报错"
rm -rf "$TMP/k"; FX="$TMP/k/tests"
FX_KIND=unit mkfx "$FX" pass:u1; FX_KIND=e2e mkfx "$FX" pass:e1 parts3:e2; FX_KIND=guard mkfx "$FX" pass:g1
FX_KIND=smoke mkfx "$FX" pass:s1; FX_KIND=meta mkfx "$FX" pass:m1; FX_KIND=install mkfx "$FX" pass:i1
chk "--kind unit,guard 的清单" "$(RUN_TESTS_DIR="$FX" bash "$RUNSH" --kind unit,guard --list | awk '{print $2}' | paste -sd' ')" "g1 u1"
chk "--kind e2e 拆段文件按段列出" "$(RUN_TESTS_DIR="$FX" bash "$RUNSH" --kind e2e --list | awk '{print $2}' | paste -sd' ')" "e1 e2:1/3 e2:2/3 e2:3/3"
chk "--quick = smoke + unit + guard + meta" "$(RUN_TESTS_DIR="$FX" bash "$RUNSH" --quick --list | awk '{print $2}' | paste -sd' ')" "g1 m1 s1 u1"
runsh "$RUNSH" --quick --out "$TMP/k/out"
chk "--quick 真的只跑了这四类（rc / 跑了 s1 / 没跑 e1、i1）" "$RC $(ran "$FX" s1) $(ran "$FX" e1) $(ran "$FX" i1)" "0 yes no no"
chk "--quick 的结果表只有 4 行" "$(wc -l < "$TMP/k/out/results.tsv" | tr -d ' ')" "4"
runsh "$RUNSH" --kind unit --list --shard 1/2
chk "--kind 和 --shard 一起用：只在这一类里分" "$RC $(cat "$OUTF" | awk '{print $2}' | paste -sd' ')" "0 u1"
runsh "$RUNSH" --kind bogus --list; chk "--kind 未知类型 → 退出 2" "$RC" "2"
runsh "$RUNSH" --kind unit u1; chk "--kind 和点名混用 → 退出 2" "$RC" "2"
runsh "$RUNSH" --kind unit --quick --list; chk "--kind 和 --quick 混用 → 退出 2" "$RC" "2"
chk "真实 tests/：--quick 里有冒烟测试、没有端到端" \
    "$(bash "$RUNSH" --quick --list | awk '{print $2}' | grep -cxE 'smoke|autopilot:1/3')" "1"

echo "【16】计数行：退出 0 却没有、出现两次、格式不对、报了失败、负对照数对不上 → 都判红（GitHub#212）"
# 输出：rc / 结果 / 结果里的说明里带的关键字（有 = 1）
scenario_counts() {   # $1 run.sh  $2 fixture kind  $3 说明里应有的字  [SAID=…]
    rm -rf "$TMP/c"; FX="$TMP/c/tests"; mkfx "$FX" "$2:x"
    runsh "$1" --out "$TMP/c/out"
    echo "$RC $(status_of "$TMP/c/out" x) $(awk -F'\t' '$1 == "x" {print $4}' "$TMP/c/out/results.tsv" | grep -cF -- "$3")"
}
chk "没有计数行 → fail「没汇报计数」" "$(scenario_counts "$RUNSH" nocount '没汇报计数')" "1 fail 1"
chk "计数行两次 → fail" "$(scenario_counts "$RUNSH" twocount '2 times')" "1 fail 1"
chk "计数行格式不对 → fail" "$(scenario_counts "$RUNSH" badcount 'malformed')" "1 fail 1"
chk "计数里有失败、退出码却是 0 → fail" "$(scenario_counts "$RUNSH" failcount '1 failed')" "1 fail 1"
chk "负对照「跳过」行和计数行对不上 → fail" "$(SAID=4 scenario_counts "$RUNSH" mutcount '跳过 4 项')" "1 fail 1"
chk "对得上 → pass（正例）" "$(SAID=3 scenario_counts "$RUNSH" mutcount '')" "0 pass 1"
chk "  结果表里记下类型和各项计数" "$(awk -F'\t' '$1 == "x" {print $5, $6, $7, $8, $9, $10, $11, $12}' "$TMP/c/out/results.tsv")" "unit 5 0 0 0 0 3 -"
chk "失败、也没报计数的文件 → 计数记成「-」，不出错" "$(scenario_counts "$RUNSH" fail 'exit 3' | cut -d' ' -f2) $(awk -F'\t' '$1 == "x" {print $6}' "$TMP/c/out/results.tsv")" "fail -"
chk "改动前对拍的两项计数也进了结果表" "$(scenario_counts "$RUNSH" compat '' >/dev/null; awk -F'\t' '$1 == "x" {print $8, $9}' "$TMP/c/out/results.tsv")" "1 2"
rm -rf "$TMP/c2"; FX="$TMP/c2/tests"; mkfx "$FX" selfskip:quiet; printf 'quiet  needs a real thing\n' > "$FX/ci-exclude.txt"
runsh "$RUNSH" --out "$TMP/c2/out"
chk "登记过的自跳过文件不需要计数行（仍是 skipped-ok）" "$RC $(status_of "$TMP/c2/out" quiet)" "0 skipped-ok"
# MUTATION=1 时：计数行的「跑 + 跳过」要等于文件打印的「本次跑了 N 项」
rm -rf "$TMP/c3"; FX="$TMP/c3/tests"; mkfx "$FX" pass:x
printf '%s\n' '#!/usr/bin/env bash' '# kind: unit' "source \"$TEST_DIR/lib/report.sh\"" \
    'MUTATION_COUNT=3; echo "负对照：本次跑了 ${SAID:-3} 项（MUTATION=1）"; report_counts 9 0 "${RAN:-}"; exit 0' > "$FX/x.test.sh"
RC=0; MUTATION=1 RUN_TESTS_DIR="$FX" bash "$RUNSH" --out "$TMP/c3/out" > "$OUTF" 2>&1 || RC=$?
chk "MUTATION=1：对得上 → pass，跑 3 / 跳过 0" "$RC $(awk -F'\t' '{print $2, $10, $11}' "$TMP/c3/out/results.tsv")" "0 pass 3 0"
RC=0; RAN=1 MUTATION=1 RUN_TESTS_DIR="$FX" bash "$RUNSH" --out "$TMP/c3/out" > "$OUTF" 2>&1 || RC=$?
chk "MUTATION=1：文件只跑了其中 1 项 → 跑 1 / 跳过 2，仍对得上" "$RC $(awk -F'\t' '{print $2, $10, $11}' "$TMP/c3/out/results.tsv")" "0 pass 1 2"
RC=0; SAID=5 MUTATION=1 RUN_TESTS_DIR="$FX" bash "$RUNSH" --out "$TMP/c3/out" > "$OUTF" 2>&1 || RC=$?
chk "MUTATION=1：「本次跑了」行和计数行对不上 → fail" "$RC $(awk -F'\t' '{print $2}' "$TMP/c3/out/results.tsv")" "1 fail"

echo "【17】汇报：结果表按类型分组，回归 / 负对照分两栏；汇总（--verify）和门禁统计（--tally）同样分栏"
rm -rf "$TMP/r"; FX="$TMP/r/tests"; FX_KIND=e2e mkfx "$FX" compat:e1; FX_KIND=unit mkfx "$FX" mutcount:u1 pass:u2
runsh "$RUNSH" --out "$TMP/r/out"
chk "rc" "$RC" "0"
chk "summary.md：每类一节（先 unit 后 e2e）" "$(grep -E '^#### ' "$TMP/r/out/summary.md" | paste -sd'|')" '#### `unit` 单元回归|#### `e2e` 端到端'
chk "summary.md：按类型一行，回归和负对照分栏" "$(grep -F '| `unit` 单元回归 |' "$TMP/r/out/summary.md")" '| `unit` 单元回归 | 2 | 6 / 0 | 0 / 0 | 0 / 3 |  |'
chk "summary.md：e2e 那一行带改动前对拍" "$(grep -F '| `e2e` 端到端 |' "$TMP/r/out/summary.md")" '| `e2e` 端到端 | 1 | 7 / 0 | 1 / 2 | 0 / 0 |  |'
chk "summary.md：合计「回归 13 项 / 负对照 3 项」" "$(grep -c '回归 13 项 / 负对照 3 项' "$TMP/r/out/summary.md")" "1"
chk "终端里也有这张表" "$(grep -c '^| \*\*合计\*\* | 3 | 13 / 0 | 1 / 2 | 0 / 3 |' "$OUTF")" "1"
mkdir -p "$TMP/r/v/shard-1"; cp "$TMP/r/out/results.tsv" "$TMP/r/v/shard-1/"
chk "--verify：绿" "$(verify_rc "$RUNSH" "$TMP/r/v")" "0"
chk "--verify：输出里有同样的分栏合计" "$(grep -c '回归 13 项 / 负对照 3 项' "$OUTF")" "1"
awk -F'\t' -v OFS='\t' '{ print $1, $2, $3, $4 }' "$TMP/r/out/results.tsv" > "$TMP/r/v/shard-1/results.tsv"
chk "--verify：通过了却没有计数的结果 → 红" "$(verify_rc "$RUNSH" "$TMP/r/v")" "1"
chk "  并说明是哪个" "$(grep -c 'u2: passed but its result has no counts' "$OUTF")" "1"
# --tally：同一单位出现在几个作业里（门禁的 autopilot 各段在 6 个作业里各跑一遍）也照加；跑过的负对照单列
mkdir -p "$TMP/r/t/a" "$TMP/r/t/b"
printf 'big:1/2\tpass\t9\t\te2e\t10\t0\t0\t0\t4\t6\t0\n' > "$TMP/r/t/a/results.tsv"
printf 'big:1/2\tfail\t9\texit 1\te2e\t10\t1\t0\t0\t5\t5\t2\nbig:2/2\tpass\t9\t\te2e\t3\t0\t0\t0\t0\t0\t-\n' > "$TMP/r/t/b/results.tsv"
RC=0; RUN_TESTS_DIR="$FX" bash "$RUNSH" --tally "$TMP/r/t" > "$OUTF" 2>&1 || RC=$?
chk "--tally：rc 0（只汇报，判定交给别的步骤）" "$RC" "0"
chk "--tally：负对照跑了 9 项、没变红 2 项" "$(grep -c '^负对照：跑了 9 项；没变红 2 项' "$OUTF")" "1"
chk "--tally：列出没通过的单位" "$(grep -c '^- ❌ `big:1/2 (fail)`' "$OUTF")" "1"
chk "--tally：e2e 一行加总三条结果" "$(grep -F '| `e2e` 端到端 |' "$OUTF")" '| `e2e` 端到端 | 3 | 23 / 1 | 0 / 0 | 9 / 11 |  |'

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
neg() {  # $1 说明  $2 场景函数  $3 正确实现的期望值  $4 名字  $5 旧  $6 新  [场景的其余参数…]
    mutation_gate || return 0
    local m; m=$(mutant "$4" "$5" "$6") || { echo "  ❌ 负对照准备失败：$1"; fail=$((fail+1)); return; }
    local got; got=$("$2" "$m" "${@:7}")
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
    'if [ "$failed" -gt 0 ]; then echo "❌ $failed of $ran failed"; exit 1; fi' ':'
neg "整文件跳过当成通过" scenario_selfskip "1 skipped skipped-ok yes" no-skip-check \
    "elif grep -qE '^⏭' \"\$log\"; then" 'elif false; then'
neg "超时没生效" scenario_timeout "1 timeout" no-timeout \
    '"${TIMEOUT_CMD[@]}" bash' 'bash'
neg "重复点名不去重（失败被同名的通过盖住）" scenario_dup "0 1 4 1/3,2/3,3/3" no-dedup \
    'if [ -n "${ONCE[$u]+x}" ]; then echo "run.sh: $u named more than once; it runs once" >&2; continue; fi' ':'
neg "汇总只看收到的结果、不对照该跑的清单" scenario_verify_missing "1" verify-no-missing \
    'for n in $(selected); do
        c=${SEEN[$n]:-0}' 'for n in "${!SEEN[@]}"; do
        c=${SEEN[$n]:-0}'

neg "不查计数行（提前退出也算通过）" scenario_counts "1 fail 1" no-count-check \
    '                [ "$status" != pass ] || { status=fail; note="$(cat "$RUNSTATE/$id.why")"; }' ':' nocount '没汇报计数'
neg "不核对负对照数" scenario_counts "1 fail 1" no-mut-crosscheck \
    '    if [ -n "$said" ] && [ "$said" != "$ms" ]; then' '    if false; then' mutcount '跳过 4 项'
neg "不查类型行" scenario_kind_bad "2 1 no" no-kind-check \
    '    [ "$kl" -eq 1 ] || die' '    true || die' none

echo
mutation_summary "$0"
echo "结果：$pass 通过 / $fail 失败"
report_counts "$pass" "$fail"
[ "$fail" -eq 0 ]
