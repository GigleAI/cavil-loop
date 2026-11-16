#!/usr/bin/env bash
# 「合并前必须人过目的文件」清单的规则（GitHub#337 / #548 / #560）。
#
# 两处 source 这一份，规则只写在这里：
#   - _lib.sh：托管合并检查（autopilot_paths_verdict）
#   - human-paths-check.sh：给复审 / 维护者用的只读验算命令——「照这个配置，daemon 拦不拦这些路径」
# 只定义变量，不读配置、不做任何 I/O。
# `default` 这个词展开成的内置清单：之后会以维护者身份运行代码的文件（CI、git hooks、agent 配置、
# 项目级提示词覆盖、打开目录就可能执行任务的编辑器 / 容器配置、安装 / 构建 / 环境配置）
AUTOPILOT_HUMAN_PATHS_DEFAULT="/.github/ .husky/ .githooks/ /.pre-commit-config.yaml /lefthook.yml .claude/ .codex/ .agents/ .mcp.json .devcontainer/ .vscode/ package.json Makefile .envrc"

# 清单条目 → 正则。rules(spec; def)：[{raw, re} | {raw, bad}]
# is_test：这个路径算不算测试文件（GitHub#548，只此一份，文档 docs/operations*.md 同名一节列的就是这几条）：
#   文件名形如 <名字>.test.<扩展名> / <名字>.spec.<扩展名>（名字、扩展名都不能空，扩展名不含 . ），
#   或者路径里某一层目录叫 __tests__；但仓库根目录 .github/ 下的一律不算（GitHub 会运行那里任何名字的工作流）
# shellcheck disable=SC2016
AUTOPILOT_PATHS_JQ='
    def esc: explode | map([.] | implode | . as $c
        | if $c == "*" then "[^/]*"
          elif ([".", "^", "$", "+", "?", "(", ")", "[", "]", "{", "}", "|", "\\"] | index($c)) != null then "\\" + $c
          else $c end) | join("");
    def rule: . as $raw
        | startswith("/") as $rooted | endswith("/") as $dir
        | (if $rooted then .[1:] else . end | if $dir then .[:-1] else . end) as $core
        | ($core | split("/")) as $segs
        | if $core == "" then {raw: $raw, bad: "空条目"}
          elif ($segs | any(. == "")) then {raw: $raw, bad: "有空的一段"}
          elif ($segs | any(. == "." or . == "..")) then {raw: $raw, bad: "不能含 . 或 .. 段"}
          elif ($core | contains("**")) then {raw: $raw, bad: "不支持 **"}
          elif (($rooted | not) and ($segs | length) > 1) then {raw: $raw, bad: "中间含 / 的条目要以 / 开头"}
          else {raw: $raw, re: ((if $rooted then "^" else "(^|/)" end) + ($segs | map(esc) | join("/")) + (if $dir then "/" else "$" end))}
          end;
    def is_test:
        (startswith(".github/") | not)
        and ((split("/") | last | test("^.+\\.(test|spec)\\.[^./]+$"))
             or (split("/") | .[:-1] | any(.[]; . == "__tests__")));
    def test_rec_ok:
        .status as $st
        | (($st | type) == "string")
          and ($st | IN("added", "removed", "modified", "renamed", "copied", "changed", "unchanged"))
          and (if $st == "renamed" or $st == "copied"
               then ((.previous_filename | type) == "string" and .previous_filename != "")
               else true end);
    def rules($spec; $def):
        ([$spec | splits("[,\\s]+") | select(. != "")]
         | map(if . == "default" then ($def | splits("\\s+") | select(. != "")) else . end)
         | ["/.github/"] + . | unique) | map(rule);
    # 一条改动记录（{filename, previous_filename?}：GitHub 改动文件列表的一项，或验算命令拼出来的一项）的判定。
    # 合并检查和验算命令（human-paths-check.sh，GitHub#560）都只用这三个函数，不各写一份：
    #   rec_paths      新旧路径（旧路径只在改名 / 复制时有）
    #   rec_exempt     测试文件豁免开着、而且新旧路径都算测试文件 → 整条记录不拿去比清单
    #   rec_hits       新旧路径里命中清单的那些
    def rec_paths: [.filename, (.previous_filename // empty) | select(. != "")];
    def rec_exempt($ex): $ex == "on" and (rec_paths | all(is_test));
    def rec_hits($res): [rec_paths[] | select(. as $f | any($res[]; . as $re | $f | test($re)))];
    # 验算命令的结论：hit（拦）/ miss（不在清单里）/ exempt-hit（豁免掉了，关豁免就会拦）/ exempt-miss（豁免掉了，关了也不拦）
    def rec_verdict($res; $ex):
        (rec_hits($res) | length > 0) as $m
        | if rec_exempt($ex) then (if $m then "exempt-hit" else "exempt-miss" end)
          elif $m then "hit" else "miss" end;
'
