#!/usr/bin/env bash
# 「同时在进行的工作」的一行化规则和 PR 正文第一句的取法（GitHub#598），jq 定义。
#
# 两处 source 这一份，规则只写在这里：
#   - _lib.sh：派工时列「同时在进行的其他工作」（concurrent_work_*）
#   - pr-body-lint.sh：worker 发出 PR 正文前的只读检查——第一行能不能被这条规则读成摘要（GitHub#644）
# 只定义变量，不读配置、不做任何 I/O。
# 别人写的文字压成一行的规则：标题、PR 正文摘要、提交标题、目录名都用这一份（jq 定义，拼在各个程序前面）
CONCURRENT_WORK_JQ_DEFS='
def cw_flat($n): (. // "") | tostring
    | gsub("[\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}\\s]+"; " ") | gsub("`"; "") | gsub("「"; "『") | gsub("」"; "』")
    | sub("^ +"; "") | sub(" +$"; "")
    | if length > $n then .[0:$n] + "…" else . end;
def cw_line:
    sub("^\\s+"; "") | sub("\\s+$"; "")
    | if . == "" then null
      elif test("^(\\||!\\[|<|-{3,}$|\\*{3,}$|_{3,}$|={3,}$)") then null
      elif test("^(>\\s*)*((close[sd]?|fix(e[sd])?|resolve[sd]?|refs?|part of)\\b[^#]*#[0-9]+|#[0-9]+\\s*$)"; "i") then null
      elif test("^#{1,6}(\\s|$)") then (sub("^#{1,6}\\s*"; "") | sub("\\s+#+$"; "") | if length < 8 then null else . end)
      else sub("^(>\\s*)+"; "") | sub("^([-*+]|[0-9]+[.)])\\s+"; "") | sub("^\\[[ xX]\\]\\s+"; "")
      end
    | if . == null then null
      else gsub("!\\[[^\\]]*\\]\\([^)]*\\)"; "") | gsub("\\[(?<t>[^\\]]*)\\]\\([^)]*\\)"; .t)
           | gsub("\\*\\*|__"; "") | sub("^\\s+"; "") | sub("\\s+$"; "")
           | if test("[\\p{L}\\p{N}]") then . else null end
      end;
def cw_first_sentence:
    (. // "") | tostring | gsub("\r\n?"; "\n")
    | gsub("<!--[\\s\\S]*?-->"; "") | sub("<!--[\\s\\S]*$"; "")
    # 第一个可用的行找到后，同一段里接着的普通行（软换行）也并进来，句子跨行时不会只剩半句；
    # 空行或另一种块（标题、列表、引用、表格、代码块、图片、HTML、关联行）开头就到段尾。
    # 标题自成一块：取标题当摘要时，下一行即使紧挨着也不并进来。
    # 两行相接时只有两边都是中日文字（汉字、假名、全角标点）才直接相连，别的文字之间补一个空格
    | reduce (split("\n")[]) as $l ({fence: null, out: null, done: false};
        if .done then .
        elif .out != null then
            (if ($l | test("^\\s*$") or test("^\\s{0,3}(#|[-*+]\\s|[0-9]+[.)]\\s|>|\\||!\\[|<|```|~~~)")) then .done = true
             else (($l | cw_line) as $c
                   | if $c == null then .done = true
                     elif ((.out | test("[\\p{Han}\\p{Hiragana}\\p{Katakana}\\x{3000}-\\x{303F}\\x{FF00}-\\x{FFEF}]$"))
                           and ($c | test("^[\\p{Han}\\p{Hiragana}\\p{Katakana}\\x{3000}-\\x{303F}\\x{FF00}-\\x{FFEF}]"))) then .out += $c
                     else .out += " " + $c end) end)
        elif .fence != null then (.fence as $f | if ($l | test("^\\s{0,3}" + $f)) then .fence = null else . end)
        elif ($l | test("^\\s{0,3}(```|~~~)")) then .fence = ($l | capture("^\\s{0,3}(?<f>```|~~~)").f)
        elif ($l | test("^( {4}|\\t)")) then .
        else (($l | cw_line) as $c
              | if $c == null then .
                elif ($l | test("^\\s{0,3}#{1,6}(\\s|$)")) then .out = $c | .done = true
                else .out = $c end) end)
    | (.out // "")
    | (capture("^(?<s>.*?(?:[。！？]|[.!?](?=\\s|$)))") // {s: .}).s
    | sub("[。！？.!?]+$"; "")
    | cw_flat(120);
'
