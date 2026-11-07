#!/usr/bin/env bash
# 经验文件拼进派工说明时裁掉哪些（GitHub#152 目录经验段；GitHub#208 观察中段、举例、出现记录）。
#
# 跑法：bash tests/retrospective-directory-lessons.test.sh       （MUTATION=1 加跑负对照）
# 依赖：python3、git。自造 SKILL_DIR / PROJECT_ROOT 沙盘，不碰网络、不碰真实项目。
#
# 为什么要有这个文件：目录经验是「只在某块代码会踩的坑」，项目自己的命令把它写进各层目录说明，
# 让改到那块代码的 agent 才看到。它要是漏进派工说明，说明会随项目越记越长，而且什么都不报错；
# 反过来切多了，就把硬规则从派工说明里切掉了，同样无声。
#
# GitHub#208：计次格式的项目经验（有 next-id 行）每次派工整份贴进去，十几天涨到 2.4 万字，大半是
# 给人和复盘程序看的证据。现在只带硬规则 / 待确认的编号、规则、适用、为什么；裁多了同样无声——
# 硬规则一缺，自审和复审的逐条核对就少一行。
#
# 四组：
#   1. 拼派工说明：通用经验、项目经验两个入口都跳过目录经验段；计次格式的项目经验另裁掉观察中段、
#      举例与出现记录，要照做的部分都在，末尾一句指路；
#   2. 两份裁法对拍：shell 的 lessons_for_prompt 与 python 的 prompt_text 对同一批输入逐字节相同；
#   3. 非计次格式、也没有目录经验标题的文件：拼出来的说明与改动前（merge-base）逐字节相同；
#   4. 本仓库真实的经验文件 + 真实四份模板：每条硬规则的规则 / 适用 / 为什么各恰好一次（预期从
#      复盘程序的解析器取，不从裁剪结果抄），举例、出现记录、观察中一条都不在。
#   负对照：两个调用点各自退回 cat、过滤函数整体退回 cat、各条裁剪规则单独去掉，断言必须变红。
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
# shellcheck source=lib/mutation.sh
source "$TEST_DIR/lib/mutation.sh"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
cat > "$TMP/cavil-loop.config" <<CONF
REPO="acme/widget"
PROJECT_ROOT="$TMP/project"
WORKTREE_BASE="$TMP/wt"
STATE_DIR="$TMP/state"
TMUX_PREFIX="dirlessons"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
CONF
PROMPTS="$TMP/project/.agents/skills/cavil-loop/prompts"
mkdir -p "$TMP/state" "$TMP/wt" "$PROMPTS" "$TMP/skill/prompts"

export CODING_AGENT_CONFIG="$TMP/cavil-loop.config"
exec 8>&2
# shellcheck source=../scripts/_lib.sh
source "$REPO_DIR/scripts/_lib.sh"
exec 2>&8 8>&-
set +e
SKILL_DIR="$TMP/skill"
printf 'BASE-通用工作流\n多行模板第二行\n' > "$SKILL_DIR/prompts/new-issue.template.md"

pass=0; fail=0
ok()  { echo "  ✅ $1"; pass=$((pass+1)); }
bad() { echo "  ❌ $1"; fail=$((fail+1)); }
chk() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (期望 '$3'，实得 '$2')"; fi; }

# 项目经验：真实形状（开头声明 + next-id + 三段 + 目录经验），末尾带空行
project_lessons() {
    cat <<'MD'
# 项目复盘经验

以下经验仅适用于本项目。

<!-- next-id: 5 -->

## 硬规则

### L1
- 规则：HARD-RULE-一条硬规则
- 适用：HARD-APPLIES-适用
- 为什么：HARD-WHY-为什么
- 这样做是对的：EXAMPLE-举例
- Seen 3×: #1 · #2 · #3

## 待确认

### L4
- 规则：CONFIRM-待确认
- 为什么：CONFIRM-WHY
- Seen 3×: #7 · #8 · #9

## 观察中

### L2
- 规则：WATCH-观察中
- Seen 1×: #4

## 目录经验

### L3
- 规则：DIR-SECRET-只在扣费目录会踩
- Seen 2×: #5 https://github.com/acme/widget/pull/5#c [server/credits/] · #6 https://github.com/acme/widget/pull/6#d [server/credits/ · server/usage/]

MD
}

# 每组断言：给一次拼装结果打分，返回失败条数（负对照用它判断「变红」）
judge_compose() {   # <合成文件>
    local out="$1" n=0
    grep -q '^HARD-RULE\|规则：HARD-RULE' "$out" || n=$((n+1))
    grep -q 'HARD-APPLIES' "$out" || n=$((n+1))
    grep -q 'HARD-WHY' "$out" || n=$((n+1))
    grep -q 'CONFIRM-待确认' "$out" || n=$((n+1))
    grep -q 'CONFIRM-WHY' "$out" || n=$((n+1))
    [ "$(grep -cxF -- "$LESSONS_PROMPT_NOTE" "$out")" = 1 ] || n=$((n+1))
    grep -q 'WATCH-观察中' "$out" && n=$((n+1))
    grep -qx '## 观察中' "$out" && n=$((n+1))
    grep -q 'EXAMPLE-举例' "$out" && n=$((n+1))
    grep -q '^- Seen' "$out" && n=$((n+1))
    grep -q 'GENERAL-通用经验' "$out" || n=$((n+1))
    grep -q 'GENERAL-DIR-通用目录段' "$out" && n=$((n+1))
    grep -q 'DIR-SECRET' "$out" && n=$((n+1))
    grep -qx '## 目录经验' "$out" && n=$((n+1))
    echo "$n"
}

setup_both() {
    project_lessons > "$PROMPTS/lessons.md"
    printf '# 通用公开经验\n\n- GENERAL-通用经验\n\n## 目录经验\n\n- GENERAL-DIR-通用目录段\n' > "$SKILL_DIR/prompts/lessons.md"
}

echo "── 1. 拼派工说明：两个入口都跳过目录经验段；项目经验只带要照做的部分 ──"
setup_both
out=$(compose_prompt_template new-issue)
chk "合成了文件" "$([ -s "$out" ] && echo yes)" "yes"
chk "base 两行都在" "$(grep -c '^BASE-通用工作流$\|^多行模板第二行$' "$out")" "2"
chk "硬规则在" "$(grep -c 'HARD-RULE-一条硬规则' "$out")" "1"
chk "硬规则的适用、为什么在" "$(grep -c 'HARD-APPLIES\|HARD-WHY' "$out")" "2"
chk "待确认的规则、为什么在" "$(grep -c 'CONFIRM-待确认\|CONFIRM-WHY' "$out")" "2"
chk "观察中整段不在（标题也不在）" "$(grep -c 'WATCH-观察中\|^## 观察中$' "$out")" "0"
chk "举例、出现记录不在" "$(grep -c 'EXAMPLE-举例\|^- Seen' "$out")" "0"
chk "指路一句恰好一次" "$(grep -cxF -- "$LESSONS_PROMPT_NOTE" "$out")" "1"
chk "通用经验在" "$(grep -c 'GENERAL-通用经验' "$out")" "1"
chk "项目目录经验不在" "$(grep -c 'DIR-SECRET' "$out")" "0"
chk "通用经验的目录段不在" "$(grep -c 'GENERAL-DIR' "$out")" "0"
chk "标题行不在" "$(grep -cx '## 目录经验' "$out")" "0"
chk "打分 0 失败" "$(judge_compose "$out")" "0"
printf 'EXTRA-项目要求\n' > "$PROMPTS/new-issue.extra.md"
out=$(compose_prompt_template new-issue)
chk "有项目增量时同样跳过、增量仍在最后" \
    "$(grep -c 'DIR-SECRET' "$out") $(tail -1 "$out")" "0 EXTRA-项目要求"
rm -f "$PROMPTS/new-issue.extra.md"

echo "── 1b. Windows 换行（CRLF）的经验文件：两个入口同样跳过目录经验段 ──"
crlf_judge() {   # 给 CRLF 版本打分：两份经验都换成 CRLF 后拼装，返回失败条数
    setup_both
    sed -i 's/$/\r/' "$PROMPTS/lessons.md" "$SKILL_DIR/prompts/lessons.md"
    judge_compose "$(compose_prompt_template new-issue)"
}
setup_both; sed -i 's/$/\r/' "$PROMPTS/lessons.md" "$SKILL_DIR/prompts/lessons.md"
chk "夹具确实是 CRLF" "$(grep -c $'\r$' "$PROMPTS/lessons.md" | awk '{print ($1 > 10) ? "yes" : "no"}')" "yes"
out=$(compose_prompt_template new-issue)
chk "CRLF：硬规则在" "$(grep -c 'HARD-RULE-一条硬规则' "$out")" "1"
chk "CRLF：通用经验在" "$(grep -c 'GENERAL-通用经验' "$out")" "1"
chk "CRLF：项目目录经验不在" "$(grep -c 'DIR-SECRET' "$out")" "0"
chk "CRLF：通用经验的目录段不在" "$(grep -c 'GENERAL-DIR' "$out")" "0"
chk "CRLF：打分 0 失败" "$(crlf_judge)" "0"
# 大文件：标题靠前、后面很长，管道里 grep -q 提前退出也不能判反（pipefail 下 SIGPIPE）
{ project_lessons; for i in $(seq 1 20000); do echo "- 填充行 $i"; done; } > "$PROMPTS/lessons.md"
sed -i '0,/^## 目录经验$/!{/^## 目录经验$/d}' "$PROMPTS/lessons.md"
( set -o pipefail; lessons_for_prompt "$PROMPTS/lessons.md" ) > "$TMP/big.out"
chk "pipefail 下大文件仍切掉目录段" "$(grep -c 'DIR-SECRET\|填充行' "$TMP/big.out")" "0"
chk "pipefail 下大文件仍按计次格式裁掉观察中" "$(grep -c 'WATCH-观察中' "$TMP/big.out")" "0"
{ project_lessons | sed '/^<!-- next-id/d'; for i in $(seq 1 20000); do echo "- 填充行 $i"; done; } > "$TMP/big-plain.md"
sed -i '0,/^## 目录经验$/!{/^## 目录经验$/d}' "$TMP/big-plain.md"
( set -o pipefail; lessons_for_prompt "$TMP/big-plain.md" ) > "$TMP/big-plain.out"
chk "pipefail 下非计次大文件仍切掉目录段" "$(grep -c 'DIR-SECRET\|填充行' "$TMP/big-plain.out")" "0"

echo "── 2. shell 与 python 两份切法对拍（同一批输入：无 \r 的逐字节相同，有 \r 的按 python 读文本的换行规矩读回后相同）──"
F="$TMP/fixtures"; mkdir -p "$F"
project_lessons > "$F/real.md"
printf '%s' "$(project_lessons)" > "$F/no-trailing-newline.md"
printf 'a\n\n## 目录经验\nx\n\n## 后面还有一段\nb\n\n\n' > "$F/middle.md"
printf '## 目录经验\n' > "$F/heading-only.md"
printf 'a\n## 目录经验 \nb\n' > "$F/heading-with-space.md"
printf '一行没有换行' > "$F/plain-no-newline.md"
project_lessons | sed 's/$/\r/' > "$F/crlf-real.md"
printf 'a\r## 目录经验\rSECRET\r## 下一段\rb\r' > "$F/lone-cr.md"
printf 'a\r\n\r\n## 目录经验\r\nx\r\n' > "$F/crlf-heading-last.md"
printf 'a\r\nb\r\n' > "$F/crlf-plain.md"
printf 'a\n\n\n' > "$F/plain-trailing-blanks.md"
project_lessons | sed '/^## 目录经验$/,$d' > "$F/counted-no-dir.md"
printf '%s' "$(project_lessons | sed '/^## 目录经验$/,$d')" > "$F/counted-no-trailing-newline.md"
project_lessons | sed '/^## 目录经验$/,$d' | sed 's/$/\r/' > "$F/counted-crlf.md"
project_lessons | sed '/^## 目录经验$/,$d' | tr '\n' '\r' > "$F/counted-lone-cr.md"
# 观察中在最前、在最后、出现两次；前言里以「- Seen」开头的行不在条目里，留着；条目里的未知行留着
printf '前言\n- Seen 9×: 前言里的\n\n<!-- next-id: 3 -->\n\n## 观察中\n\n### L1\n- 规则：W\n\n## 硬规则\n\n### L2\n- 规则：H\n- 其他行\n- Seen 3×: #1\n\n## 附注\n- Seen 1×: 段首的\n\n## 观察中\n- 第二次\n' > "$F/counted-odd.md"
printf '<!-- next-id: 1 -->\n' > "$F/counted-empty.md"
# 非计次格式（没有 next-id）：「- Seen」「这样做是对的」「## 观察中」都是普通文本，原样
printf '# 手写经验\n\n### L1\n- Seen 3×: 普通文本\n- 这样做是对的：也是普通文本\n\n## 观察中\n- 留着\n' > "$F/freeform.md"
printf '<!-- next-id: x -->\n## 观察中\n- 留着\n' > "$F/bad-next-id.md"
for f in "$F"/*.md; do
    lessons_for_prompt "$f" > "$f.sh"
    python3 - "$f" "$f.py" "$REPO_DIR/scripts" <<'PY'
import sys
sys.path.insert(0, sys.argv[3])
import retrospective_lessons as rl
text = open(sys.argv[1], encoding='utf-8').read()          # 复盘程序的读法（换行归一）
open(sys.argv[2], 'w', encoding='utf-8', newline='').write(rl.prompt_text(text))
PY
    if ! grep -q $'\r' "$f"; then
        if cmp -s "$f.sh" "$f.py"; then ok "$(basename "$f")：两边逐字节相同"; else bad "$(basename "$f")：两边不同"; diff "$f.sh" "$f.py" | head -5; fi
    elif python3 -c 'import sys; a=open(sys.argv[1],encoding="utf-8").read(); b=open(sys.argv[2],encoding="utf-8",newline="").read(); sys.exit(a != b)' "$f.sh" "$f.py"; then
        ok "$(basename "$f")：两边相同（按换行归一读回）"
    else
        bad "$(basename "$f")：两边不同"; od -c "$f.sh" | head -3
    fi
done
chk "没有标题的文件原样输出（不补换行）" "$(cmp -s "$F/plain-no-newline.md" "$F/plain-no-newline.md.sh" && echo same)" "same"
chk "没有标题的文件末尾空行不动" "$(cmp -s "$F/plain-trailing-blanks.md" "$F/plain-trailing-blanks.md.sh" && echo same)" "same"
chk "CRLF 文件确实切掉了目录段" "$(grep -c 'DIR-SECRET' "$F/crlf-real.md.sh")" "0"
chk "单独 \r 换行的文件也切掉了" "$(grep -c SECRET "$F/lone-cr.md.sh")" "0"
chk "没有标题的 CRLF 文件原样输出" "$(cmp -s "$F/crlf-plain.md" "$F/crlf-plain.md.sh" && echo same)" "same"
chk "中间一段切掉后下一段保留" "$(cat "$F/middle.md.sh")" "$(printf 'a\n\n## 后面还有一段\nb')"
chk "非计次格式的手写经验原样输出" "$(cmp -s "$F/freeform.md" "$F/freeform.md.sh" && echo same)" "same"
chk "next-id 不是数字的不算计次格式" "$(cmp -s "$F/bad-next-id.md" "$F/bad-next-id.md.sh" && echo same)" "same"
chk "CRLF 计次文件也裁掉了观察中和出现记录" "$(grep -c 'WATCH\|^- Seen' "$F/counted-crlf.md.sh")" "0"
chk "单独 \r 换行的计次文件也裁掉了" "$(grep -c 'WATCH\|^- Seen' "$F/counted-lone-cr.md.sh")" "0"
chk "怪形状：前言行、条目外的段首行、未知行留着，两段观察中都切掉，条目里的出现记录切掉" \
    "$(cat "$F/counted-odd.md.sh")" \
    "$(printf '前言\n- Seen 9×: 前言里的\n\n<!-- next-id: 3 -->\n\n## 硬规则\n\n### L2\n- 规则：H\n- 其他行\n\n## 附注\n- Seen 1×: 段首的\n\n%s' "$LESSONS_PROMPT_NOTE")"

echo "── 3. 非计次格式、没有目录经验标题：与改动前的拼装逐字节相同 ──"
BASE_REV=$(git -C "$REPO_DIR" merge-base HEAD origin/main 2>/dev/null || git -C "$REPO_DIR" rev-parse HEAD~1)
old_fn=$(git -C "$REPO_DIR" show "$BASE_REV:scripts/_lib.sh" \
    | awk '/^compose_prompt_template\(\) \{/{on=1} on{print} on && /^\}/{exit}')
if [ -z "$old_fn" ]; then
    bad "merge-base $BASE_REV 上取不到 compose_prompt_template"
else
    eval "${old_fn/compose_prompt_template()/old_compose_prompt_template()}"
    project_lessons | sed '/^## 目录经验$/,$d; /^<!-- next-id/d' > "$PROMPTS/lessons.md"
    printf '# 通用公开经验\n\n- GENERAL-通用经验' > "$SKILL_DIR/prompts/lessons.md"   # 故意不带末尾换行
    for overlay in no yes; do
        [ "$overlay" = yes ] && printf 'EXTRA-项目要求\n' > "$PROMPTS/new-issue.extra.md"
        new_out=$(compose_prompt_template new-issue); cp "$new_out" "$TMP/new.md"
        old_out=$(old_compose_prompt_template new-issue); cp "$old_out" "$TMP/old.md"
        if cmp -s "$TMP/new.md" "$TMP/old.md" && [ -s "$TMP/new.md" ]; then
            ok "项目增量=$overlay：与 $BASE_REV 逐字节相同（$(wc -l < "$TMP/new.md") 行）"
        else
            bad "项目增量=$overlay：与 $BASE_REV 不同"; diff "$TMP/old.md" "$TMP/new.md" | head -5
        fi
    done
    rm -f "$PROMPTS/new-issue.extra.md"
    unset -f old_compose_prompt_template
fi

echo "── 4. 真实经验文件 + 真实模板：硬规则逐条都在，证据和观察中都不在 ──"
real_check() {   # <合成文件>：最后一行是失败条数，前面是逐条原因
    python3 - "$1" "$REPO_DIR/.agents/skills/cavil-loop/prompts/lessons.md" "$REPO_DIR/scripts" <<'CHECK'
import sys
sys.path.insert(0, sys.argv[3])
import retrospective_lessons as rl
lines = open(sys.argv[1], encoding='utf-8').read().split('\n')
lessons = rl.parse(open(sys.argv[2], encoding='utf-8').read())
bad = 0
must = [e for e in lessons.entries if e.section in ('硬规则', '待确认')]
if not any(e.section == '硬规则' for e in must):
    print('真实经验文件里没有硬规则，本组测不到东西'); bad += 1
for e in must:
    for field, value in (('规则', e.rule), ('适用', e.applies), ('为什么', e.why)):
        if value is None:
            continue
        n = lines.count(f'- {field}：{value}')
        if n != 1:
            print(f'L{e.id} {field} 出现 {n} 次'); bad += 1
    if lines.count(f'### L{e.id}') != 1:
        print(f'L{e.id} 编号行不是恰好一次'); bad += 1
for e in lessons.entries:
    if e.section == '观察中' and f'### L{e.id}' in lines:
        print(f'观察中的 L{e.id} 进了派工说明'); bad += 1
    if e.example and f'- 这样做是对的：{e.example}' in lines:
        print(f'L{e.id} 的举例进了派工说明'); bad += 1
if any(l.startswith('- Seen ') for l in lines):
    print('有出现记录行'); bad += 1
if lines.count(rl.PROMPT_NOTE) != 1:
    print('指路一句不是恰好一次'); bad += 1
print(bad)
CHECK
}
SKILL_DIR="$REPO_DIR"
cp "$REPO_DIR/.agents/skills/cavil-loop/prompts/lessons.md" "$PROMPTS/lessons.md"
for kind in new-issue issue-comment pr-comment review; do
    out=$(compose_prompt_template "$kind")
    res=$(real_check "$out")
    chk "$kind：硬规则 / 待确认逐条在，证据与观察中不在" "$(tail -1 <<<"$res")" "0"
    [ "$(tail -1 <<<"$res")" = 0 ] || head -n -1 <<<"$res" | sed 's/^/      /'
done
full=$(python3 -c 'import sys; sys.path.insert(0, sys.argv[2]); import retrospective_lessons as rl; print(len(rl.outside_directory_text(open(sys.argv[1], encoding="utf-8").read())))' "$PROMPTS/lessons.md" "$REPO_DIR/scripts")
trim=$(lessons_for_prompt "$PROMPTS/lessons.md" | python3 -c 'import sys; print(len(sys.stdin.read()))')
echo "    （实测：本仓库项目经验整份 $full 字 → 进派工说明 $trim 字）"
chk "进派工说明的比整份短" "$([ "$trim" -lt "$full" ] && echo yes)" "yes"
SKILL_DIR="$TMP/skill"
rm -f "$PROMPTS/lessons.md"

mutation_on && echo "── 负对照：退回原样拼接、去掉单条裁剪规则，断言必须变红 ──"
real_compose=$(declare -f compose_prompt_template)
real_filter=$(declare -f lessons_for_prompt)
mutant() {   # <说明> <要改坏的原文> <改成>
    mutation_gate || return 0
    local body="${real_compose/"$2"/"$3"}"
    if [ "$body" = "$real_compose" ]; then bad "准备失败：$1（原文已不在）"; return; fi
    eval "$body"
    setup_both
    local out n; out=$(compose_prompt_template new-issue); n=$(judge_compose "$out")
    if [ "$n" -gt 0 ]; then ok "$1 → 变红（$n 条断言失败）"; else bad "$1 → 仍全绿"; fi
    eval "$real_compose"
}
mutant "通用经验入口退回 cat" 'lessons_for_prompt "$lessons"' 'cat "$lessons"'
mutant "项目经验入口退回 cat" 'lessons_for_prompt "$project_lessons"' 'cat "$project_lessons"'
if mutation_gate; then
    # 上一版：只认 LF 的标题探测（CRLF 文件整份原样进了派工说明，复审第 1 轮）
    eval "$(declare -f lessons_for_prompt | sed 's/< <(_lessons_lf "\$1")/"$1"/; s/_lessons_lf "\$1" | awk/awk/; s/}'"'"'$/}'"'"' "$1"/')"
    if declare -f lessons_for_prompt | grep -q _lessons_lf; then
        bad "准备失败：只认 LF 的旧探测（原文已不在）"
    else
        n=$(crlf_judge)
        if [ "$n" -gt 0 ]; then ok "只认 LF 的旧探测 → CRLF 变红（$n 条断言失败）"; else bad "只认 LF 的旧探测 → CRLF 仍全绿"; fi
    fi
    eval "$real_filter"
fi
pipe_mutant() {   # <说明> <要改成管道的探测原文> <大文件是否计次格式 yes/no> <漏出来就算变红的字样>
    # 探测走管道：pipefail 下 grep -q 提前退出让 sed 吃 SIGPIPE，判成「没有这一行」
    mutation_gate || return 0
    local from="grep $2 < <(_lessons_lf \"\$1\")" to="_lessons_lf \"\$1\" | grep $2"
    local body="${real_filter/"$from"/"$to"}"
    if [ "$body" = "$real_filter" ]; then bad "准备失败：$1（原文已不在）"; return; fi
    eval "$body"
    { if [ "$3" = yes ]; then project_lessons; else project_lessons | sed '/^<!-- next-id/d'; fi
      for i in $(seq 1 20000); do echo "- 填充行 $i"; done; } > "$TMP/big.md"
    sed -i '0,/^## 目录经验$/!{/^## 目录经验$/d}' "$TMP/big.md"
    ( set -o pipefail; lessons_for_prompt "$TMP/big.md" ) > "$TMP/big.mut"
    if [ "$(grep -c "$4" "$TMP/big.mut")" -gt 0 ]; then ok "$1 → pipefail 大文件变红"; else bad "$1 → 仍全绿"; fi
    eval "$real_filter"
}
pipe_mutant "目录经验探测走管道" "-qx '## 目录经验'" no 'DIR-SECRET'
pipe_mutant "计次格式探测走管道" "-qxE '<!-- next-id: [0-9]+ -->'" yes 'WATCH-观察中'
filter_mutant() {   # <说明> <要改坏的原文> <改成>：改坏过滤函数，看第 1 组打分和第 2 组对拍
    mutation_gate || return 0
    local body="${real_filter/"$2"/"$3"}" n diffs=0 f
    if [ "$body" = "$real_filter" ]; then bad "准备失败：$1（原文已不在）"; return; fi
    eval "$body"
    setup_both
    n=$(judge_compose "$(compose_prompt_template new-issue)")
    for f in "$F"/*.md; do lessons_for_prompt "$f" > "$f.mut"; cmp -s "$f.mut" "$f.sh" || diffs=$((diffs+1)); done
    if [ "$n" -gt 0 ] || [ "$diffs" -gt 0 ]; then ok "$1 → 变红（$n 条断言失败，$diffs 个夹具输出变了）"; else bad "$1 → 仍全绿"; fi
    eval "$real_filter"
}
filter_mutant "观察中段不裁" '(counted && sec == "观察中")' '0'
filter_mutant "举例、出现记录不裁" 'counted && entry && /^- (这样做是对的：|Seen [0-9]+×:)/ { next }' ''
filter_mutant "只裁出现记录、举例留着" '这样做是对的：|Seen' 'Seen'
filter_mutant "条目外也裁（前言里的行被误删）" 'counted && entry && /' 'counted && /'
filter_mutant "不认计次格式（只按目录经验判断）" 'counted=1' 'counted=0'
filter_mutant "非计次格式也裁" 'local counted=0' 'local counted=1'
filter_mutant "末尾不加指路" 'END { if (counted) { print ""; print note } }' ''
filter_mutant "进了新段不清条目标记" 'sec = substr($0, 4); entry = 0' 'sec = substr($0, 4)'
if mutation_gate; then
    lessons_for_prompt() { cat "$1"; }
    setup_both
    n=$(judge_compose "$(compose_prompt_template new-issue)")
    if [ "$n" -gt 0 ]; then ok "过滤函数整体退回 cat → 变红（$n 条断言失败）"; else bad "过滤函数整体退回 cat → 仍全绿"; fi
    project_lessons > "$F/real.md"; lessons_for_prompt "$F/real.md" > "$F/real.md.sh"
    if cmp -s "$F/real.md.sh" "$F/real.md.py"; then bad "过滤函数退回 cat → 对拍仍相同"; else ok "过滤函数退回 cat → 对拍变红"; fi
    eval "$real_filter"
fi

echo
mutation_summary "$0"
echo "结果：$pass 通过 / $fail 失败"
[ "$fail" -eq 0 ]
