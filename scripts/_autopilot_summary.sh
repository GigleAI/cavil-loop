# shellcheck shell=bash
# PR 正文里两种「标记之间的一段」的读法，只有这一份（GitHub#233 / #644 / #656）：
#   托管总结段（AUTOPILOT_SUMMARY_*）：daemon 合并后照搬（_lib.sh 的合并交接），PR 正文检查命令（pr-body-lint.sh）也照它截取；
#   合并后待办（MERGE_FOLLOWUP_*）：_merge_followup.sh 的 merge_followup_parse 先数标记、再用它取清单。
# body_section <开始标记> <结束标记> <line|alone>：哪一行算标记由第三个参数定——
#   line   行里含有标记就算（按字面找，不管它在不在注释、文本框、代码里）；托管总结段一直是这样，输出不变
#   alone  标记独占一行（前后空白不算），而且不在代码块（``` / ~~~）和引用（>）里；正文里贴的写法示例不算
# 从开始标记的下一行起照搬，遇到结束标记的行停（之后再遇到开始标记会接着照搬，和以前一样）；去掉末尾空行。
AUTOPILOT_SUMMARY_BEGIN='<!-- autopilot-summary:begin -->'
AUTOPILOT_SUMMARY_END='<!-- autopilot-summary:end -->'
MERGE_FOLLOWUP_BEGIN='<!-- merge-followup:begin -->'
MERGE_FOLLOWUP_END='<!-- merge-followup:end -->'
MERGE_FOLLOWUP_NONE='<!-- merge-followup:none -->'
# 一行算不算「独占一行、不在代码块和引用里」的标记：awk 函数文本，body_section 和 merge_followup_parse 共用
BODY_MARK_AWK='
function fence_step(line,   t) {
    t = line; sub(/^[ \t]+/, "", t)
    if (t ~ /^(```|~~~)/) { infence = !infence; return 1 }
    return 0
}
function alone_mark(line, m,   t) {
    if (infence) return 0
    t = line; sub(/^[ \t]+/, "", t); sub(/[ \t\r]+$/, "", t)
    return t == m
}'
body_section() {   # stdin：PR 正文；stdout：截出的一段
    awk -v b="$1" -v e="$2" -v mode="$3" "$BODY_MARK_AWK"'
        { isb = 0; ise = 0
          if (mode == "alone") { if (!fence_step($0)) { isb = alone_mark($0, b); ise = alone_mark($0, e) } }
          else { isb = index($0, b) > 0; ise = index($0, e) > 0 } }
        ise { on = 0 } on { print } isb { on = 1 }' | sed -e :a -e '/^\n*$/{$d;N;ba' -e '}'
}
autopilot_summary_extract() {   # stdin：PR 正文；stdout：截出的总结段（去掉末尾空行）
    body_section "$AUTOPILOT_SUMMARY_BEGIN" "$AUTOPILOT_SUMMARY_END" line
}
