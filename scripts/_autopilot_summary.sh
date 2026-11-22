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
#   围栏  ``` / ~~~ 开头（相对缩进 < 4，或紧跟在列表项符号后面）开，只被同一种符号、长度不短于开头、后面只剩
#         空白的一行关上；开头是 ``` 而后面的字里还有 ` 的不是围栏
#   缩进  相对缩进 ≥ 4 的行：不算标记，也不开围栏
# 每行先把制表符展开成空格（到下一个 4 的倍数列），行首缩进、列表符号后面的空白都按同一套列数算。
# 列表项（- * + 1. 1) 接空白）是容器：栈里每层记一个列表项内容开始的列。一行的「所在层」= 内容列 ≤ 本行缩进
# 的最深一层（没有就是第 0 层，列 0），相对缩进 = 行首缩进 − 所在层的内容列。
#   · 列表项那一行：弹掉比所在层更深的层、压入自己；符号后面的内容再当一行看——又是列表项就再压一层，
#     是围栏开头就开围栏（「- ```」）。符号后面什么都没有的空列表项，紧接一个空行就结束
#   · 别的行：上一行是空行时弹掉比所在层更深的层（列表结束 / 退层），否则（懒续行）不动
#   · 「段落还开着」只认普通段落文字（列表项里的文字算）；标题、标题下划线（===）、分隔线、围栏、HTML 行、
#     空行之后都不算——只有段落开着时，空列表项和不从 1 开始的有序列表项才不能开新列表
#   · 围栏记下开在哪一层；后面的行退到那一层之外（缩进不够），围栏随那个列表项一起结束，这一行照列表外处理。
#     围栏里的行不改列表状态
# 只认这三样，不是完整的 Markdown：段落后面紧接的深缩进行也按代码块算（读成「没提」，错在交人的一边）。
BODY_MARK_AWK='
function list_marker(s,   n) {
    if (s ~ /^[-*+]/) n = 1
    else if (s ~ /^[0-9]/) {
        for (n = 1; substr(s, n + 1, 1) ~ /[0-9]/; n++) ;
        if (n > 9 || substr(s, n + 1, 1) !~ /[.)]/) return 0
        n++
    } else return 0
    return (length(s) == n || substr(s, n + 1, 1) == " ") ? n : 0
}
function fence_open(s, d,   c, n) {
    c = substr(s, 1, 1)
    if (c != "`" && c != "~") return 0
    for (n = 1; substr(s, n + 1, 1) == c; n++) ;
    if (n < 3 || (c == "`" && index(substr(s, n + 1), "`") > 0)) return 0
    infence = 1; fch = c; flen = n; fdepth = d
    return 1
}
function thematic_break(s,   i, c, d, n) {
    n = 0
    for (i = 1; i <= length(s); i++) {
        d = substr(s, i, 1)
        if (d == " ") continue
        if (n == 0) { c = d; if (c != "-" && c != "*" && c != "_") return 0 }
        else if (d != c) return 0
        n++
    }
    return n >= 3
}
function expand_tabs(s,   i, c, out, col) {
    out = ""; col = 0
    for (i = 1; i <= length(s); i++) {
        c = substr(s, i, 1)
        if (c == "\t") { do { out = out " "; col++ } while (col % 4) }
        else { out = out c; col++ }
    }
    return out
}
function atx_heading(s,   n) {
    for (n = 0; substr(s, n + 1, 1) == "#"; n++) ;
    return n >= 1 && n <= 6 && (length(s) == n || substr(s, n + 1, 1) == " ")
}
function line_step(line,   i, col, rest, k, rel, w, sp, n, c, wasblank, waspara) {
    sub(/\r$/, "", line)
    line = expand_tabs(line)
    for (col = 0; substr(line, col + 1, 1) == " "; col++) ;
    rest = substr(line, col + 1)
    if (rest ~ /^ *$/) {
        if (lfresh && !infence) ldepth--
        lfresh = 0; lblank = 1; lpara = 0
        return 1
    }
    wasblank = lblank; lblank = 0; lfresh = 0
    waspara = lpara; lpara = 0
    for (k = ldepth; k > 0 && lcol[k] > col; k--) ;
    if (infence) {
        if (k >= fdepth) {
            rel = col - (fdepth > 0 ? lcol[fdepth] : 0)
            if (rel < 4 && substr(rest, 1, 1) == fch) {
                for (n = 1; substr(rest, n + 1, 1) == fch; n++) ;
                if (n >= flen && substr(rest, n + 1) ~ /^ *$/) infence = 0
            }
            return 1
        }
        infence = 0; ldepth = k
    }
    rel = col - (k > 0 ? lcol[k] : 0)
    if (rel >= 4) { if (wasblank) ldepth = k; lpara = waspara; return 1 }
    if (thematic_break(rest)) { ldepth = k; return 1 }
    if (atx_heading(rest)) { ldepth = k; return 1 }
    if (waspara == 1 && rest ~ /^=+ *$/) return 1
    w = list_marker(rest)
    # 同一层的段落中间：空列表项、不是从 1 开始的有序列表项都不能打断段落（「段落」下一行的「-」是标题下划线）
    if (w > 0 && waspara == 1 && k == ldepth && (length(rest) == w || (w > 1 && substr(rest, 1, w - 1) + 0 != 1))) w = 0
    if (w > 0) {
        ldepth = k
        while (w > 0) {
            for (sp = 0; substr(rest, w + sp + 1, 1) == " "; sp++) ;
            ldepth++
            if (length(rest) == w + sp) { lcol[ldepth] = col + w + 1; lfresh = 1; return 1 }
            if (sp > 4) { lcol[ldepth] = col + w + 1; return 1 }
            lcol[ldepth] = col + w + sp
            col += w + sp; rest = substr(rest, w + sp + 1)
            if (thematic_break(rest)) return 1
            w = list_marker(rest)
        }
        if (!fence_open(rest, ldepth) && !atx_heading(rest)) lpara = 1
        return 1
    }
    # 缩进不够的行只有接在段落后面、本身又不开新块（引用、HTML）时才是懒续行；否则更深的列表项到这里结束
    if (wasblank || !waspara || rest ~ /^[<>]/) ldepth = k
    if (fence_open(rest, k)) { ldepth = k; return 1 }
    if (thematic_break(rest)) return 1
    # 引用里的段落（lpara = 2）在另一个容器里：下一行的列表项不算打断它，懒续行照常
    c = substr(rest, 1, 1)
    if (c == ">") lpara = 2
    else if (c != "<") lpara = 1
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
