# shellcheck shell=bash
# 负对照的开关（GitHub#103）。被测试文件 source，不单独执行。
#
# 负对照 = 把被测代码复制一份、故意改坏一处（或换成旧版本），同一组断言必须变红。
# 它检验的是**测试本身**分得出对错实现，不是代码对不对：代码和测试都没变时重跑，
# 结果必然和上次一样。所以默认回归不跑它，只在两个时刻打开：
#   · 写测试 / 改到被测代码时，证明新断言分得出对错实现；
#   · 复审时复跑确认。
#
#   bash tests/<name>.test.sh              默认：负对照一条都不准备、不跑，只计数
#   MUTATION=1 bash tests/<name>.test.sh   打开：和改动前一样全部跑
#
# 每个测试的每一条负对照都经过一次 mutation_gate：关着时它只记一笔、返回 1；开着时记一笔、
# 返回 0。两种模式走同一个计数器，所以「默认跳过 N 条」和「打开跑了 N 条」是同一个数，
# 不靠手写常数——条数对不上一眼可见。
#
# 默认模式不核对负对照要改的原文还在不在：那是把测试绑在实现文本上。原文过期要等下一次
# 打开开关才报，且仍然算红（各测试自己的「准备失败」记账照旧）。

case "${MUTATION:-}" in
    ''|0|1) ;;
    *) echo "MUTATION 只认 1（打开）或 0 / 不设（关闭），实得 [${MUTATION}]" >&2; exit 2 ;;
esac

MUTATION_COUNT=0

mutation_on() { [ "${MUTATION:-}" = 1 ]; }

# 一条负对照的入口：计数；开关打开时返回 0（照常跑），关着时返回 1（调用方直接跳过）。
# 必须在主 shell 里调（不要放进 $( ) 子 shell），否则计数传不回来。
mutation_gate() {
    MUTATION_COUNT=$((MUTATION_COUNT + 1))
    mutation_on
}

# 汇总一行。$1 = 测试文件名（不给就用 $0）
mutation_summary() {
    local name; name=$(basename "${1:-$0}")
    if mutation_on; then
        echo "负对照：本次跑了 $MUTATION_COUNT 项（MUTATION=1）"
    else
        echo "负对照：跳过 $MUTATION_COUNT 项（默认不跑；MUTATION=1 bash tests/$name 打开）"
    fi
}
