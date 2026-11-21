#!/usr/bin/env bash
# kind: guard
# reads: repo
# 外部用户文档里不写 issue / PR 编号（docs/AGENTS.md「How to write them」）。
#
# 跑法：bash tests/doc-numbers.test.sh        （约 1 秒）
# 依赖：python3（标准库）、git。
#
# 外部用户文档的清单和编号的认法都在 tests/lib/doc_links.py（external_docs / NUMBER），
# 链接检查用的是同一份清单。管四件事：
#   1. 当前全部外部用户文档里没有编号（GitHub#N、PR #N、owner/repo#N、括号里的 (#N)）
#   2. 往外部用户文档里插回一处编号会报出来：正文、标题、命令块里的注释、中文括号都算
#   3. 自用文档照留编号：各级 AGENTS.md（含 docs/AGENTS.md）、prompts/ 与 .agents/ 下的文件（含 lessons.md）、
#      docs/retrospectives/、docs/design/ 里写编号不报
#   4. 合法写法不误报：示例编号「#42」、搜索示例「#135」、「排序键 #1」、链接文字是编号的链接、带数字的锚点
set -uo pipefail
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
CHECK="$TEST_DIR/lib/doc_links.py"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

PASS=0 FAIL=0
ok()   { PASS=$((PASS + 1)); echo "  ✓ $1"; }
bad()  { FAIL=$((FAIL + 1)); echo "  ✗ $1"; }
chk()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1（期望 [$3]，实得 [$2]）"; fi; }

echo "【1】当前仓库：外部用户文档里没有编号"
out=$(python3 "$CHECK" --numbers "$REPO_DIR"); rc=$?
chk "检查通过（退出码 0、没有输出）" "$rc|$out" "0|"
ext=$(python3 "$CHECK" --external "$REPO_DIR")
chk "检查确实扫了运维手册、编排文档和 README 的中英两份" \
    "$(grep -cxE 'docs/operations(\.zh)?\.md|docs/orchestration(\.zh)?\.md|README(\.zh)?\.md' <<<"$ext")" 6

# 一份只含文档的副本：外部用户文档 + 几处自用文档
W="$TMP/w"; mkdir -p "$W"
(cd "$REPO_DIR" && git ls-files -co --exclude-standard -- README.md README.zh.md CONTRIBUTING.md CONTRIBUTING.zh.md \
    'docs/*.md' AGENTS.md prompts/lessons.md .agents/skills/cavil-loop/prompts/lessons.md 'docs/retrospectives/*.md' \
    | while IFS= read -r f; do mkdir -p "$W/$(dirname "$f")"; cp "$f" "$W/$f"; done)
chk "副本里的外部用户文档同样没有编号" "$(python3 "$CHECK" --numbers "$W" >/dev/null; echo $?)" 0

reported() {   # <名称> <期望的输出行（正则）> <改法…>：在副本的拷贝上改一处，必须报出这一行
    local name="$1" want="$2" d out rc; shift 2
    d="$TMP/case$RANDOM$RANDOM"; cp -r "$W" "$d"
    (cd "$d" && "$@")
    out=$(python3 "$CHECK" --numbers "$d"); rc=$?
    if [ "$rc" = 1 ] && grep -qE "$want" <<<"$out"; then ok "$name"; else bad "$name（退出码 $rc，输出：${out:-空}）"; fi
}
silent() {   # <名称> <改法…>：改了之后必须仍然通过
    local name="$1" d out rc; shift
    d="$TMP/case$RANDOM$RANDOM"; cp -r "$W" "$d"
    (cd "$d" && "$@")
    out=$(python3 "$CHECK" --numbers "$d"); rc=$?
    if [ "$rc" = 0 ]; then ok "$name"; else bad "$name（退出码 $rc，输出：$out）"; fi
}

echo "【2】外部用户文档里插回编号：报错"
reported "运维手册正文插回 GitHub#461" '^docs/operations\.md:[0-9]+: 写了编号 GitHub#461$' \
    sh -c 'echo "Merging closes the issue (GitHub#461)." >> docs/operations.md'
reported "中文运维手册标题插回（GitHub#337）" '^docs/operations\.zh\.md:[0-9]+: 写了编号 GitHub#337$' \
    sh -c 'echo "### 合并前必须人过目的文件（GitHub#337）" >> docs/operations.zh.md'
reported "编排文档命令块的注释里插回编号" '^docs/orchestration\.md:[0-9]+: 写了编号 GitHub#124$' \
    sh -c 'printf "\`\`\`bash\n# host check (GitHub#124)\n\`\`\`\n" >> docs/orchestration.md'
reported "README 写 PR #620" '^README\.md:[0-9]+: 写了编号 PR #620$' \
    sh -c 'echo "See PR #620 for the parser." >> README.md'
reported "CONTRIBUTING 写 owner/repo#N" '^CONTRIBUTING\.zh\.md:[0-9]+: 写了编号 GigleAI/cavil-loop#238$' \
    sh -c 'echo "见 GigleAI/cavil-loop#238。" >> CONTRIBUTING.zh.md'
reported "短文档里括号写编号（#157）" '^docs/security\.zh\.md:[0-9]+: 写了编号 （#157$' \
    sh -c 'echo "等前置（#157）" >> docs/security.zh.md'
reported "新加的一篇外部文档也查" '^docs/newpage\.md:[0-9]+: 写了编号 GitHub#1$' \
    sh -c 'echo "x GitHub#1" > docs/newpage.md; echo "x" > docs/newpage.zh.md'

echo "【3】自用文档照留编号：不报"
silent "根目录 AGENTS.md 写 GitHub#461" sh -c 'echo "GitHub#461 PR #620 (#337)" >> AGENTS.md'
silent "docs/AGENTS.md 写 GitHub#461" sh -c 'echo "GitHub#461" >> docs/AGENTS.md'
silent "prompts/lessons.md 写编号" sh -c 'echo "PR #612 GitHub#606" >> prompts/lessons.md'
silent "项目经验文件写编号" sh -c 'mkdir -p .agents/skills/cavil-loop/prompts && echo "PR #601" >> .agents/skills/cavil-loop/prompts/lessons.md'
silent "复盘报告写编号" sh -c 'mkdir -p docs/retrospectives && echo "GitHub#461" >> docs/retrospectives/pr-1.md'
silent "设计稿目录写编号" sh -c 'mkdir -p docs/design/issue-260 && echo "GitHub#260" > docs/design/issue-260/notes.md'

echo "【4】合法写法：不误报"
silent "示例编号、搜索示例、排序键、编号做链接文字、带数字的锚点" sh -c '{
    echo "gh issue create --title x   # say you get #42"
    echo "Plain text matches the number (\`135\` / \`#135\`)."
    echo "sort key #1 comes from the label"
    echo "A nightly build: [#628](https://github.com/GigleAI/cavil-loop/issues/628)"
    echo "[steps](docs/operations.md#1-look)"
} >> docs/operations.md'

echo
report_counts "$PASS" "$FAIL"
if [ "$FAIL" -eq 0 ]; then
    echo "全部通过（$PASS 项）"
else
    echo "失败 $FAIL 项"
    exit 1
fi
