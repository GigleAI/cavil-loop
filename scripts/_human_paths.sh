#!/usr/bin/env bash
# 「合并前必须人过目的文件」清单的规则（GitHub#337 / #548 / #560）。
#
# 两处 source 这一份，规则只写在这里：
#   - _lib.sh：托管合并检查（autopilot_paths_verdict）
#   - human-paths-check.sh：给复审 / 维护者用的只读验算命令——「照这个配置，daemon 拦不拦这些路径」
# 只定义变量，不读配置、不做任何 I/O。
# `default` 这个词展开成的内置清单：之后会以维护者身份运行代码的文件（CI、git hooks、agent 配置、
# 项目级提示词覆盖、打开目录就可能执行任务的编辑器 / 容器配置、安装 / 构建 / 环境配置）

# ── Files a human must look at before an autopilot merge: rules moved from the root AGENTS.md (GitHub#658); read before changing ──
# Files a human must look at before an autopilot merge (GitHub#337: `AUTOPILOT_HUMAN_PATHS` /
# `AUTOPILOT_HUMAN_PATHS_DEFAULT`, `autopilot_paths_verdict` in `_lib.sh` and the `AUTOPILOT_PATHS_JQ`
# rules in `_human_paths.sh`, the branch in `autopilot_permit`) →
# `tests/autopilot-human-paths.test.sh` (~2 min; real `agent-poll.sh` against the stateful fake
# GitHub, which now reports `changed_files` on a PR and can serve a raw file-list answer from
# `raw_pulls_<n>_files`) plus `tests/autopilot.test.sh`. Empty or unset means the old `.github/` code
# path, untouched: the test compares five scenarios, abnormal file lists included, with the merge-base
# scripts — GitHub calls byte for byte on the three where nothing is handed over, and state, labels
# and the visible comment text on the two that hand the PR over (the hand-over's own calls changed in
# GitHub#382) — so **every new behaviour hangs on the value being non-empty**, never add one outside
# that branch. With a value: the list is matched and read-completeness is checked in one jq program;
# an entry that cannot be read is a hand-off naming it, never skipped; a file list that is not
# provably whole (count ≠ the PR's `changed_files`, missing count, malformed, failed) is "can't read",
# never "no hit". The two new hand-offs (`AP_STOP` = `paths` / `paths-config`) go through
# `autopilot_to_human` like every other reason: before each write the whole permit is re-run and must
# give the same verdict, the same `AP_STOP_KEY` (files hit / bad entry) and the same PR identity
# (GitHub#382, next entry). The config lines in `docs/operations{,.zh}.md` (behind `<!--
# autopilot-human-paths:examples:begin -->`) are run through the real poller by the test; keep the two
# copies identical. Test files do not count (GitHub#548, `AUTOPILOT_HUMAN_PATHS_EXEMPT_TESTS`, not set
# / empty / `on` = on): what a test file is lives only in `is_test` inside `AUTOPILOT_PATHS_JQ` — the
# same jq program used for the decision and every re-judgement — and the docs list exactly its rules;
# a renamed file is skipped only when both paths are test files, and nothing under the root `.github/`
# is ever a test file (the maintainer's choice in #548). Skipping needs a complete record: for a file
# whose new path is a test file, an unknown or missing `status`, or a rename / copy without a
# non-empty `previous_filename`, is "can't read" (`test_rec_ok`), never "no old path" (PR #549 code
# review round 1). Any other value leaves the jq output untouched: the test diffs calls, state, labels
# and comments against the merge-base scripts with `off` and with a misspelled value. Files a hook
# calls from outside the list (GitHub#560): the daemon still looks at paths only — it never reads a
# hook to find what it runs. The gap is covered in two places. ① The docs tell maintainers to *append*
# the called file to the existing value (never replace the line) and, for a test-named file with the
# exemption on, also turn the exemption off or rename. ② `prompts/autopilot-review-human-paths.md`,
# appended by `autopilot_review_paths_section` to the autopilot **review** prompt only when the list
# is set (unset: every composed prompt equals the merge-base copy byte for byte, the test diffs them),
# has the reviewer follow listed hooks to the repo files they run and hand over instead of queuing the
# merge when the PR changes a file on that chain that the daemon would not block, or when a call's
# path cannot be worked out. Any config advice it gives must first be checked with
# `scripts/human-paths-check.sh` (read-only, managed entrypoint `entrypoints/human-paths-check.sh`).
# That command and the merge check judge a change record (one file, or the old + new path of one
# rename / copy) with the same `rec_exempt` / `rec_hits` in `_human_paths.sh` (`rec_verdict` on top
# for the command; a rename goes in as `--renamed <old> <new>`, never as two paths — PR #565 code
# review round 1), and the test cross-checks the command against real poll rounds for every list ×
# exemption × file-name combination, renames included; the doc command behind `<!--
# autopilot-human-paths:check:begin -->` is run verbatim. This is the reviewer reading code, not a
# daemon check: never describe it as a guarantee
#
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
