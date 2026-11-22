# shellcheck shell=bash
# 托管总结段的标记和截取规则（GitHub#233 定的格式）：daemon 合并后照搬（_lib.sh 的 autopilot_merged_comment），
# PR 正文检查命令（pr-body-lint.sh，GitHub#644）判总结段时也照它截取——同一条规则只有这一份。
# 规则：哪一行含开始标记（按字面找，不管它在不在注释、文本框、代码里），下一行起照搬；遇到含结束标记的行停。
AUTOPILOT_SUMMARY_BEGIN='<!-- autopilot-summary:begin -->'
AUTOPILOT_SUMMARY_END='<!-- autopilot-summary:end -->'
autopilot_summary_extract() {   # stdin：PR 正文；stdout：截出的总结段（去掉末尾空行）
    awk -v b="$AUTOPILOT_SUMMARY_BEGIN" -v e="$AUTOPILOT_SUMMARY_END" '
        index($0, e) { on = 0 } on { print } index($0, b) { on = 1; found = 1 }' | sed -e :a -e '/^\n*$/{$d;N;ba' -e '}'
}
