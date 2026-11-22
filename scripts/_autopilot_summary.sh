# shellcheck shell=bash
# PR 正文里两种「标记之间的一段」的读法，只有这一份（GitHub#233 / #644 / #656）：
#   托管总结段（AUTOPILOT_SUMMARY_*）：daemon 合并后照搬（_lib.sh 的合并交接），PR 正文检查命令（pr-body-lint.sh）也照它截取；
#   合并后待办（MERGE_FOLLOWUP_*）：_merge_followup.sh 的 merge_followup_parse 先数标记、再用它取清单。
# body_section <开始标记> <结束标记> <line|alone>：哪一行算标记由第三个参数定——
#   line   行里含有标记就算（按字面找，不管它在不在注释、文本框、代码里）；托管总结段一直是这样，输出不变
#   alone  标记独占一行（行首 1–3 格、列表续行的缩进不算），而且不在代码块（``` / ~~~ 围栏、缩进代码块）和引用（>）里；
#          正文里贴的写法示例不算
# 从开始标记的下一行起照搬，遇到结束标记的行停（之后再遇到开始标记会接着照搬，和以前一样）；去掉末尾空行。
AUTOPILOT_SUMMARY_BEGIN='<!-- autopilot-summary:begin -->'
AUTOPILOT_SUMMARY_END='<!-- autopilot-summary:end -->'
MERGE_FOLLOWUP_BEGIN='<!-- merge-followup:begin -->'
MERGE_FOLLOWUP_END='<!-- merge-followup:end -->'
MERGE_FOLLOWUP_NONE='<!-- merge-followup:none -->'
# 一行算不算「独占一行、不在代码块和引用里」的标记：awk 函数文本，body_section 和 merge_followup_parse 共用。
# 逐行先调 line_step（更新状态；返回 1 = 这一行不可能是标记），再调 alone_mark。代码块有两种（GitHub#675）：
#   围栏  ``` / ~~~ 开头（相对缩进 < 4）开，只被同一种符号、长度不短于开头、后面只剩空白的一行关上；
#         开头是 ``` 而后面的字里还有 ` 的不是围栏。围栏里的行不改列表状态
#   缩进  相对缩进 ≥ 4 的行（制表符算到下一个 4 的倍数列）：不算标记，也不开围栏
# 「相对缩进」= 行首缩进 − 所在列表层的内容列。列表层是一个栈，每层记一个列表项（- * + 1. 1) 接空白）
# 内容开始的列；基准层 = 栈里内容列 ≤ 本行缩进的最深一层（没有就是第 0 层，列 0）。相对缩进 < 4 的列表项
# 弹掉比基准层更深的层再压入自己；不是列表项的行，上一行是空行时弹掉比基准层更深的层，否则（懒续行）不动。
# 只认这三样，不是完整的 Markdown：段落后面紧接的深缩进行也按代码块算（读成「没提」，错在交人的一边）。
BODY_MARK_AWK='
function line_step(line,   i, c, col, rest, k, base, rel, w, sp, n) {
    sub(/\r$/, "", line)
    col = 0
    for (i = 1; i <= length(line); i++) {
        c = substr(line, i, 1)
        if (c == " ") col++
        else if (c == "\t") col += 4 - col % 4
        else break
    }
    rest = substr(line, i)
    if (rest ~ /^[ \t]*$/) { lblank = 1; return 1 }
    for (k = ldepth; k > 0 && lcol[k] > col; k--) ;
    base = (k > 0) ? lcol[k] : 0
    rel = col - base
    if (infence) {
        lblank = 0
        if (rel < 4 && substr(rest, 1, 1) == fch) {
            for (n = 1; substr(rest, n + 1, 1) == fch; n++) ;
            if (n >= flen && substr(rest, n + 1) ~ /^[ \t]*$/) infence = 0
        }
        return 1
    }
    if (rel >= 4) { if (lblank) ldepth = k; lblank = 0; return 1 }
    lblank_was = lblank; lblank = 0
    w = 0
    if (rest ~ /^[-*+]/) w = 1
    else if (rest ~ /^[0-9]/) {
        for (n = 1; substr(rest, n + 1, 1) ~ /[0-9]/; n++) ;
        if (n <= 9 && substr(rest, n + 1, 1) ~ /[.)]/) w = n + 1
    }
    if (w > 0 && (length(rest) == w || substr(rest, w + 1, 1) ~ /[ \t]/)) {
        for (sp = 0; substr(rest, w + sp + 1, 1) == " "; sp++) ;
        if (sp == 0 || sp > 4 || length(rest) == w + sp) sp = 1
        ldepth = k + 1; lcol[ldepth] = col + w + sp
        return 1
    }
    if (lblank_was) ldepth = k
    c = substr(rest, 1, 1)
    if (c == "`" || c == "~") {
        for (n = 1; substr(rest, n + 1, 1) == c; n++) ;
        if (n >= 3 && !(c == "`" && index(substr(rest, n + 1), "`") > 0)) {
            infence = 1; fch = c; flen = n; return 1
        }
    }
    return 0
}
function alone_mark(line, m,   t) {
    t = line; sub(/^[ \t]+/, "", t); sub(/[ \t\r]+$/, "", t)
    return t == m
}'
body_section() {   # stdin：PR 正文；stdout：截出的一段
    awk -v b="$1" -v e="$2" -v mode="$3" "$BODY_MARK_AWK"'
        { isb = 0; ise = 0
          if (mode == "alone") { if (!line_step($0)) { isb = alone_mark($0, b); ise = alone_mark($0, e) } }
          else { isb = index($0, b) > 0; ise = index($0, e) > 0 } }
        ise { on = 0 } on { print } isb { on = 1 }' | sed -e :a -e '/^\n*$/{$d;N;ba' -e '}'
}
autopilot_summary_extract() {   # stdin：PR 正文；stdout：截出的总结段（去掉末尾空行）
    body_section "$AUTOPILOT_SUMMARY_BEGIN" "$AUTOPILOT_SUMMARY_END" line
}
