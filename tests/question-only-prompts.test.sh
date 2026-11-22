#!/usr/bin/env bash
# kind: unit
# 纯提问只回答、暂停（GitHub#614）：派工说明里的规则段。
#
# 跑法：bash tests/question-only-prompts.test.sh        （~5 s，不联网：真实派工脚本 + 假 gh / tmux）
#
# 用真实的 dispatch-issue-comment.sh / dispatch-pr-comment.sh / dispatch-new-issue.sh 写出成品提示词，核对：
#   1. 「先判断是不是纯提问」段在 issue 回复和 PR 回复里逐字一致，答复记录命令占位已换成真实命令，
#      而且排在原有判断（决策树 / 流程）之前
#   2. 答复记录只有一种来源：段里只让原样粘贴命令生成的那行，没有手写的记录格式
#   3. 两份 worker 说明里「交出 PR 前先查冲突」一节逐字一致，带纯提问例外；PR 回复第 3 步带例外
#   4. 把「交回 = 确认」连在一起的两句旧提示已经没有了
#   5. 两份托管规则（issue / 只在 PR 上托管）都写了纯提问例外；复审说明的 2L 有 ⑤
#   6. 「疑问 + 建议」一节（GitHub#654）：两份逐字一致、排在纯提问一节之前、新 issue / 复审里没有；
#      停下用等继续标记、清单的放法与取法、停下期间三种情况；托管两份写了例外；复审要点明推翻、2L 有 ⑥
set -uo pipefail
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"
# shellcheck source=lib/prompt-files.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/prompt-files.sh"

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

pass=0; fail=0
ok()  { echo "  ✅ $1"; pass=$((pass+1)); }
bad() { echo "  ❌ $1"; [ -z "${2:-}" ] || printf '       %s\n' "$2"; fail=$((fail+1)); }

D="$TMP/d"
mkdir -p "$D/bin" "$D/home" "$D/state" "$D/wt"
git init -q --bare "$D/upstream.git"
git clone -q "$D/upstream.git" "$D/seed" 2>/dev/null
(cd "$D/seed" && git config user.email t@example.invalid && git config user.name t \
    && echo x > f && git add f && git commit -qm init && git push -q origin HEAD:main) >/dev/null 2>&1
git clone -q "$D/upstream.git" "$D/project" 2>/dev/null
cat > "$D/bin/gh" <<'SH'
#!/usr/bin/env bash
case "$*" in *title*) echo "测试标题" ;; *) echo "{}" ;; esac
exit 0
SH
cat > "$D/bin/tmux" <<'SH'
#!/usr/bin/env bash
case "$1" in has-session) exit 1 ;; esac
exit 0
SH
chmod +x "$D/bin/gh" "$D/bin/tmux"
cat > "$D/config" <<CONF
REPO="example/none"
PROJECT_ROOT="$D/project"
WORKTREE_BASE="$D/wt"
STATE_DIR="$D/state"
TMUX_PREFIX="qop"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
LABEL_AGENT_DOING="doing/agent"
LABEL_PENDING_REVIEW="pending/review"
WORKER_AGENT_DEFAULT="claude"
PATH="$D/bin:\$PATH"
GH_TOKEN="fake-token-for-test"
CONF
N=$((910000000 + ($$ % 1000000) * 3)); NC=$((N + 1)); NP=$((N + 2))
prompt_files_clear "$REPO_DIR" "$D/state"
E=(env -u CODING_AGENT_RELEASE_ROOT -u CAVIL_DEPLOY_ROOT -u DISPATCH_PROMPT_KIND HOME="$D/home" CODING_AGENT_CONFIG="$D/config")
(cd "$D/project" && "${E[@]}" bash "$REPO_DIR/scripts/dispatch-new-issue.sh" "$N") >/dev/null 2>&1
(cd "$D/project" && "${E[@]}" bash "$REPO_DIR/scripts/dispatch-issue-comment.sh" "$NC" 0) >/dev/null 2>&1
mv "$(prompt_file_of "$REPO_DIR" "$D/state" cmt "$NC" 0)" "$TMP/issue-comment.md" 2>/dev/null
(cd "$D/project" && "${E[@]}" DISPATCH_PROMPT_KIND=review bash "$REPO_DIR/scripts/dispatch-issue-comment.sh" "$NC" 0) >/dev/null 2>&1
mv "$(prompt_file_of "$REPO_DIR" "$D/state" cmt "$NC" 0)" "$TMP/review.md" 2>/dev/null
(cd "$D/project" && "${E[@]}" bash "$REPO_DIR/scripts/dispatch-pr-comment.sh" "$NP" "feature/issue-$NP" 0) >/dev/null 2>&1
mv "$(prompt_file_of "$REPO_DIR" "$D/state" new "$N")" "$TMP/new-issue.md" 2>/dev/null
mv "$(prompt_file_of "$REPO_DIR" "$D/state" pr "$NP")" "$TMP/pr-comment.md" 2>/dev/null
for k in new-issue issue-comment pr-comment review; do
    [ -s "$TMP/$k.md" ] || bad "派工脚本没写出 $k 的提示词"
done

# 一节：从标题行到下一个二级标题之前
section() { awk -v h="$2" '$0 == h {on = 1; print; next} on && /^## / {exit} on {print}' "$1"; }
Q='## 先判断是不是纯提问（GitHub#614）'
C='## 交出 PR 前：先查和主干有没有冲突'

echo "── 1. 规则段两份一致、命令已渲染、在原有判断之前 ──"
section "$TMP/issue-comment.md" "$Q" > "$TMP/q-issue"
section "$TMP/pr-comment.md" "$Q" > "$TMP/q-pr"
if [ -s "$TMP/q-issue" ] && cmp -s "$TMP/q-issue" "$TMP/q-pr"; then ok "issue 回复和 PR 回复里的规则段逐字一致（$(wc -l < "$TMP/q-issue") 行）"
else bad "两份规则段不一致或缺失"; diff "$TMP/q-issue" "$TMP/q-pr" | head -5 | sed 's/^/       /'; fi
if grep -q 'FEEDBACK_FP_CMD' "$TMP/q-issue"; then bad "答复记录命令的占位没被换掉"
elif grep -qF "feedback-fingerprint.sh' --config '$D/config' snapshot" "$TMP/q-issue"; then ok "占位换成了带项目配置的真实命令"
else bad "规则段里找不到答复记录命令"; fi
qi=$(grep -nxF -- "$Q" "$TMP/issue-comment.md" | head -1 | cut -d: -f1); di=$(grep -nx '## 决策树' "$TMP/issue-comment.md" | head -1 | cut -d: -f1)
qp=$(grep -nxF -- "$Q" "$TMP/pr-comment.md" | head -1 | cut -d: -f1); dp=$(grep -nx '## 流程' "$TMP/pr-comment.md" | head -1 | cut -d: -f1)
if [ -n "$qi" ] && [ -n "$di" ] && [ "$qi" -lt "$di" ] && [ -n "$qp" ] && [ -n "$dp" ] && [ "$qp" -lt "$dp" ]; then ok "规则段排在决策树 / 流程之前"
else bad "规则段的位置不对" "issue $qi/$di，PR $qp/$dp"; fi
grep -q '纯提问' "$TMP/new-issue.md" && bad "新 issue 说明里不该出现纯提问规则段" || ok "新 issue 说明不带规则段（第一次派工没有可答的提问）"

echo "── 2. 答复记录只有一种来源 ──"
if grep -qF '原样使用，不手写、不改动' "$TMP/q-issue" && ! grep -qE 'agent-answer-only (seen|v=2 seen)=<' "$TMP/q-issue"; then ok "只让原样粘贴命令生成的记录，没有手写格式"
else bad "规则段里有手写的答复记录格式"; fi
grep -qF '<!-- agent-answer-only need=continue -->' "$TMP/q-issue" && ok "等继续记录写明了固定写法" || bad "缺等继续记录"
grep -qF '把 snapshot 第一行原样存进一个文件' "$TMP/q-issue" && ! grep -qF '`record `' "$TMP/q-issue" \
    && ok "发前比对存的就是 snapshot 第一行，没有要剥掉的前缀（PR #639 复审第 1 轮 #1）" || bad "规则段对第一行的说法和命令输出对不上"

echo "── 3. 冲突一节与 PR 回复第 3 步 ──"
section "$TMP/issue-comment.md" "$C" > "$TMP/c-issue"
section "$TMP/pr-comment.md" "$C" > "$TMP/c-pr"
if [ -s "$TMP/c-issue" ] && cmp -s "$TMP/c-issue" "$TMP/c-pr"; then ok "两份 worker 说明的冲突一节逐字一致"
else bad "两份冲突一节不一致"; diff "$TMP/c-issue" "$TMP/c-pr" | head -5 | sed 's/^/       /'; fi
grep -qF '纯提问（见上文「先判断是不是纯提问」的 B）不做这一节的合主干、提交、推送' "$TMP/c-issue" \
    && grep -qF '（不含纯提问：纯提问不解冲突）' "$TMP/c-issue" && ok "冲突一节写明纯提问例外" || bad "冲突一节缺纯提问例外"
grep -qF '3. 纯提问已经按上文「先判断是不是纯提问」的 B 答完' "$TMP/pr-comment.md" && ok "PR 回复第 3 步写明纯提问例外" || bad "PR 回复第 3 步缺例外"

echo "── 4. 旧提示已经没有 ──"
grep -qF 'OK 后重新标' "$TMP/issue-comment.md" && bad "issue 回复里还有「OK 后重新标」" || ok "issue 回复里没有「OK 后重新标」"
grep -qF '确认后请重新标' "$TMP/new-issue.md" && bad "新 issue 说明里还有「确认后请重新标」" || ok "新 issue 说明里没有「确认后请重新标」"
grep -qF '只是提问就直接问，agent 只回答、不开工' "$TMP/new-issue.md" && grep -qF '只是提问就直接问，agent 只回答、不开工' "$TMP/issue-comment.md" \
    && ok "两处结尾提示换成了新说法" || bad "结尾提示没换"

echo "── 5. 托管规则与复审 ──"
for f in autopilot-worker autopilot-worker-pr; do
    grep -qF '**纯提问是这一段的例外**' "$REPO_DIR/prompts/$f.md" && grep -qF '人这一轮只是提问时先照上文 B 只回答、停下，交回后再修' "$REPO_DIR/prompts/$f.md" \
        && ok "$f：写了纯提问例外（交接与 daemon 打回两处）" || bad "$f：缺纯提问例外"
done
grep -qF '⑤ 人这一轮提了问题，worker 本轮第一条评论的标题下第一段却不是这些问题的答案' "$TMP/review.md" \
    && grep -qF '逐条对照下面六项' "$TMP/review.md" && ok "复审 2L 有 ⑤（答案不在第一段就打回）" || bad "复审 2L 缺 ⑤"

echo "── 6. 「疑问 + 建议」一节（GitHub#654）──"
S='## 先判断「疑问 + 建议」可不可行（GitHub#654）'
section "$TMP/issue-comment.md" "$S" > "$TMP/s-issue"
section "$TMP/pr-comment.md" "$S" > "$TMP/s-pr"
if [ -s "$TMP/s-issue" ] && cmp -s "$TMP/s-issue" "$TMP/s-pr"; then ok "issue 回复和 PR 回复里的「疑问 + 建议」一节逐字一致（$(wc -l < "$TMP/s-issue") 行）"
else bad "两份「疑问 + 建议」一节不一致或缺失"; diff "$TMP/s-issue" "$TMP/s-pr" | head -5 | sed 's/^/       /'; fi
for k in issue-comment pr-comment; do
    si=$(grep -nxF -- "$S" "$TMP/$k.md" | head -1 | cut -d: -f1); qi=$(grep -nxF -- "$Q" "$TMP/$k.md" | head -1 | cut -d: -f1)
    [ -n "$si" ] && [ -n "$qi" ] && [ "$si" -lt "$qi" ] && ok "$k：排在纯提问一节之前" || bad "$k：「疑问 + 建议」一节的位置不对" "$si/$qi"
done
section "$TMP/issue-comment.md" "$Q" | grep -qF '只排在上一节「疑问 + 建议」之后：本轮有疑问 + 建议，或正在停下中，先照上一节办' \
    && ok "纯提问一节写明先照「疑问 + 建议」一节办" || bad "纯提问一节没指回「疑问 + 建议」一节"
for k in new-issue review; do
    grep -qF '疑问 + 建议」可不可行（GitHub#654）' "$TMP/$k.md" && bad "$k 说明里不该有「疑问 + 建议」一节" || ok "$k 说明里没有「疑问 + 建议」一节"
done
has_s() { grep -qF -- "$1" "$TMP/s-issue"; }
for p in \
    '**1. 全部可行 → 当作修改要求**' \
    '每条建议写「可行，本轮采纳：<打算怎么做>」，不写结果' \
    '**2. 至少一条不可行 → 先回答、停下**（不管同轮还有没有别的要求）' \
    '**3. 复审推翻了已采纳的建议 → 先告知人、停下**' \
    'worker 不认同复审的推翻，照原有规则写「不改 + 理由」交复审，不停' \
    '不改方案、不改代码、不提交、不推送、不交复审' \
    '`verdict resume` 而且 `write ok <标签>` 才发' \
    '单独一行放 `<!-- agent-answer-only need=continue -->`，**不放** snapshot 第一行' \
    '固定小标题 `### 暂缓：留言「继续」后接着做`' \
    '并原样重贴那张清单' \
    '不发下一节 C 那句不带清单的通用提示' \
    '不发带答复记录的纯提问答复' \
    '清单只从最近那一条停下评论取，不往前翻更早的评论' \
    '被编辑的按新原文，来源被删或人撤回的去掉，都写明；每项只做一次' \
    '不需要证明之前的复审还针对当前版本' \
    '「人的建议与采纳情况」' \
    '连续两次都不是 `resume` 时，改发一条' \
    '**照样带上清单**（停下前已有清单时用最近那张，本轮新暂缓的项一并列上，' \
    '不发 B ① 指向的那句不带清单的通用提示' \
    '最后一次 `compare` 输出里列出的新增 / 被编辑的反馈也逐条列进去，标「未及处理」' \
    '「这一段停下期间」从这一连串停下评论里最早的那条算起（不是最近那条）' \
    '夹在两条停下评论之间、没来得及进清单的反馈也算在内' \
    '**每次代码交付**（首次开 PR 和之后每一轮）都把这一段的最新版同步进 PR 正文' \
    '托管条目写进总结段「采用的方案」那一块（总结段仍是三块，daemon 合并时只从 PR 正文搬这一段）' \
    '「人的建议与结果」：原话 → 采纳了什么 → 结果 → 复审有没有推翻'; do
    has_s "$p" && ok "写了：$p" || bad "缺：$p"
done
for f in autopilot-worker autopilot-worker-pr; do
    grep -qF '「疑问 + 建议」里有不可行的、或复审推翻了已采纳的建议时同样是例外' "$REPO_DIR/prompts/$f.md" \
        && ok "$f：写了「疑问 + 建议」停下的例外" || bad "$f：缺「疑问 + 建议」例外"
done
grep -qF '在那一条里写明「推翻人的建议」并附人的原话链接' "$TMP/review.md" && ok "复审：推翻已采纳的建议要点明并附原话链接" || bad "复审缺「推翻人的建议」要求"
grep -qF '⑥ worker 交付里「人的建议与采纳情况」有已采纳的人的建议' "$TMP/review.md" \
    && grep -qF '里的建议现状和最新一版交付说明对不上' "$TMP/review.md" && ok "复审 2L 有 ⑥（缺「人的建议与结果」就打回）" || bad "复审 2L 缺 ⑥"

report_counts "$pass" "$fail"
echo
if [ "$fail" -eq 0 ]; then echo "全部通过（$pass 项）"; exit 0; fi
echo "失败 $fail 项（通过 $pass 项）"; exit 1
