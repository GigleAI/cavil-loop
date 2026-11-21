#!/usr/bin/env bash
# kind: e2e
# 编排文档占位符表（docs/orchestration{,.zh}.md「Placeholders / 占位符」）里列的每个 ${NAME}，
# 在每个派工入口渲染成它该有的值。
#
# 跑法：bash tests/orchestration-placeholders.test.sh      （约 10 秒）
# 依赖：git、python3。不碰网络（假 gh、假 tmux），HOME 指到临时目录，派工脚本在只有 HOME / PATH / LANG
# 和项目配置路径的干净环境里跑（不继承调用方的 DISPATCH_* 等派工环境）。
#
# 不看派工脚本的源码：起真实的三个派工脚本（新 issue / issue 评论 / PR 评论），项目的追加要求里
# 每个占位符单独一行、前一行是标记，读派工写出的提示词，取标记下面那一行，和下表逐个入口比对：
#   =值     必须正好是这个值          ~正则   必须匹配
#   EMPTY   必须渲染成空行            KEPT    这个入口不渲染它，必须原样留着 ${NAME}
# 标记找不到、或标记是最后一行（下面没有那一行）= 输出丢了，一律算失败，绝不算「换掉了」。
#   1. 两份文档的占位符表一样（读法只有一份：tests/lib/doc_placeholders.py，文档检查也用它）
#   2. 表里的名字和下表一一对应：表里多一个没写期望的、期望里多一个表里没有的，都报出来
#   3. 每个名字在每个入口都是期望的值；一个编出来的 ${ISSUE_NUMBR} 三个入口都原样留着
#   4. 判定本身：只有标记没有下一行、标记缺失，都判成失败
set -uo pipefail
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
DP="$TEST_DIR/lib/doc_placeholders.py"
# shellcheck source=lib/prompt-files.sh
source "$TEST_DIR/lib/prompt-files.sh"
TMP=$(mktemp -d)
trap '[ -n "${KEEP_TMP:-}" ] && echo "TMP=$TMP" || rm -rf "$TMP"' EXIT

PASS=0 FAIL=0
ok()   { PASS=$((PASS + 1)); echo "  ✓ $1"; }
bad()  { FAIL=$((FAIL + 1)); echo "  ✗ $1"; }
chk()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1（期望 [$3]，实得 [$2]）"; fi; }

D="$TMP/d"; mkdir -p "$D/bin" "$D/state" "$D/wt" "$TMP/home"
N_NEW=987801; N_CMT=987802; N_PR=987803
CONF="$D/config"

# 名字 → 新 issue | issue 评论 | PR 评论 三个入口各自的期望
expect() {
    cat <<EOF
BRANCH	=feature/issue-$N_NEW	=feature/issue-$N_CMT	=feature/issue-$N_PR
CAVIL_STEP_DIR	=$REPO_DIR/scripts	=$REPO_DIR/scripts	=$REPO_DIR/scripts
COMMENT_FOOTER_CMD	~^bash '$REPO_DIR/scripts/drivers/token-usage/comment-footer\.sh' --agent 'claude' --driver '[^']*/claude\.sh' --config '$CONF'\$	~^bash '$REPO_DIR/scripts/drivers/token-usage/comment-footer\.sh' --agent 'claude' --driver '[^']*/claude\.sh' --config '$CONF'\$	~^bash '$REPO_DIR/scripts/drivers/token-usage/comment-footer\.sh' --agent 'claude' --driver '[^']*/claude\.sh' --config '$CONF'\$
CONCURRENT_WORK	=（本项目没有开启这项提示。）	=（本项目没有开启这项提示。）	=（本项目没有开启这项提示。）
DESIGN_REVIEW_NOTE	EMPTY	EMPTY	KEPT
FEEDBACK_FP_CMD	=bash '$REPO_DIR/scripts/feedback-fingerprint.sh' --config '$CONF'	=bash '$REPO_DIR/scripts/feedback-fingerprint.sh' --config '$CONF'	=bash '$REPO_DIR/scripts/feedback-fingerprint.sh' --config '$CONF'
ISSUE	=$N_NEW	=$N_CMT	KEPT
ISSUE_N	KEPT	KEPT	=$N_PR
LABEL_AGENT_DOING	=doing/agent	=doing/agent	=doing/agent
LABEL_DESIGN_REVIEW_OR_HUMAN	=pending/human	=pending/human	KEPT
LABEL_PENDING_AGENT	=pending/agent	=pending/agent	=pending/agent
LABEL_PENDING_AGENT_DEFAULT	=pending/agent	=pending/agent	=pending/agent
LABEL_PENDING_HUMAN	=pending/human	=pending/human	=pending/human
LABEL_PENDING_PR	=pending/PR	=pending/PR	=pending/PR
LABEL_REVIEW_OR_HUMAN	=pending/human	=pending/human	=pending/human
OUTPUT_LANGUAGE	=en	=en	=en
PARENT_ISSUE	EMPTY	KEPT	KEPT
PR	KEPT	KEPT	=$N_PR
PREVIEW_URL_HOST	=preview.example.test	=preview.example.test	=preview.example.test
REPO	=example/none	=example/none	=example/none
REVIEW_ASSET_BASE_URL	EMPTY	EMPTY	EMPTY
TASK_START_TS	~^20[0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9]\$	~^20[0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9]\$	~^20[0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9]\$
TITLE	=测试标题	KEPT	KEPT
WORKTREE	=$D/wt/issue-$N_NEW	=$D/wt/issue-$N_CMT	KEPT
WORK_NUM	=$N_NEW	=$N_CMT	=$N_PR
EOF
}

# 标记下面那一行：打印 VALUE:<那一行>，标记不在或下面没有一行打印 MISSING
after() {   # <prompt> <name>
    [ -s "$1" ] || { echo MISSING; return; }
    awk -v m="PROBE-$2" '$0 == m { if ((getline n) > 0) { print "VALUE:" n } else { print "MISSING" }; f = 1; exit }
                         END { if (!f) print "MISSING" }' "$1"
}
# 按期望判定：打印 ok 或 原因
judge() {   # <prompt> <name> <期望>
    local got want="$3"; got="$(after "$1" "$2")"
    [ "$got" = MISSING ] && { echo "输出里没有这一行"; return; }
    got="${got#VALUE:}"
    case "$want" in
        EMPTY) [ -z "$got" ] && echo ok || echo "应为空，实得 [$got]" ;;
        KEPT)  [ "$got" = "\${$2}" ] && echo ok || echo "应原样留着，实得 [$got]" ;;
        =*)    [ "$got" = "${want#=}" ] && echo ok || echo "应为 [${want#=}]，实得 [$got]" ;;
        "~"*)  printf '%s\n' "$got" | grep -qE -- "${want#\~}" && echo ok || echo "应匹配 ${want#\~}，实得 [$got]" ;;
        *)     echo "期望写法不认识：$want" ;;
    esac
}

echo "【1】占位符表（读法：tests/lib/doc_placeholders.py）"
T_EN=$(python3 "$DP" table "$REPO_DIR/docs/orchestration.md"); T_ZH=$(python3 "$DP" table "$REPO_DIR/docs/orchestration.zh.md")
chk "两份文档的占位符表一样" "$([ "$T_EN" = "$T_ZH" ] && echo same)" same
chk "认出了 ≥ 20 个名字" "$([ "$(wc -l <<<"$T_EN")" -ge 20 ] && echo yes)" yes

echo "【2】表里的名字和期望一一对应"
chk "表里每个名字都写了期望，期望里没有表里没有的名字" "$(diff <(printf '%s\n' "$T_EN" | LC_ALL=C sort) <(expect | cut -f1 | LC_ALL=C sort) && echo same)" same

# ── 一个项目：三个入口的追加要求里，每个占位符（加一个编出来的）各占一行，前面一行是标记 ──
git init -q --bare "$D/upstream.git"
git clone -q "$D/upstream.git" "$D/seed" 2>/dev/null
P="$D/seed/.agents/skills/cavil-loop/prompts"; mkdir -p "$P"
for kind in new-issue issue-comment pr-comment; do
    { echo "## 占位符探针"; echo
      for n in $T_EN ISSUE_NUMBR; do printf 'PROBE-%s\n${%s}\n\n' "$n" "$n"; done; } > "$P/$kind.extra.md"
done
(cd "$D/seed" && git config user.email t@example.invalid && git config user.name t \
    && git add -A && git commit -qm init && git push -q origin HEAD:main) >/dev/null 2>&1
git clone -q "$D/upstream.git" "$D/project" 2>/dev/null
cat > "$D/bin/gh" <<'SH'
#!/usr/bin/env bash
case "$*" in
    *"--jq .title"*|*title*) echo "测试标题" ;;
    *) echo "{}" ;;
esac
exit 0
SH
cat > "$D/bin/tmux" <<'SH'
#!/usr/bin/env bash
case "$1" in has-session) exit 1 ;; esac
exit 0
SH
chmod +x "$D/bin/gh" "$D/bin/tmux"
cat > "$CONF" <<CONF
REPO="example/none"
PROJECT_ROOT="$D/project"
WORKTREE_BASE="$D/wt"
STATE_DIR="$D/state"
TMUX_PREFIX="oph"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
LABEL_AGENT_DOING="doing/agent"
WORKER_AGENT_DEFAULT="claude"
PREVIEW_URL_HOST="preview.example.test"
PATH="$D/bin:\$PATH"
GH_TOKEN="fake-token-for-test"
CONF
run() { (cd "$D/project" && env -i HOME="$TMP/home" PATH="$PATH" LANG=C.UTF-8 CODING_AGENT_CONFIG="$CONF" bash "$@") >/dev/null 2>&1; }
prompt_files_clear "$REPO_DIR" "$D/state"
run "$REPO_DIR/scripts/dispatch-new-issue.sh" "$N_NEW"
run "$REPO_DIR/scripts/dispatch-issue-comment.sh" "$N_CMT" 0
run "$REPO_DIR/scripts/dispatch-pr-comment.sh" "$N_PR" "feature/issue-$N_PR" 0
mkdir -p "$TMP/out"
for kind in new-issue:"$(prompt_file_of "$REPO_DIR" "$D/state" new "$N_NEW")" \
            issue-comment:"$(prompt_file_of "$REPO_DIR" "$D/state" cmt "$N_CMT" 0)" \
            pr-comment:"$(prompt_file_of "$REPO_DIR" "$D/state" pr "$N_PR")"; do
    f="${kind#*:}"; kind="${kind%%:*}"
    [ -s "$f" ] && cp "$f" "$TMP/out/$kind.md"
done
prompt_files_clear "$REPO_DIR" "$D/state"

echo "【3】每个名字在每个入口的值"
for kind in new-issue issue-comment pr-comment; do
    chk "$kind：写出了提示词，追加要求在里面" "$([ -s "$TMP/out/$kind.md" ] && grep -c '^## 占位符探针$' "$TMP/out/$kind.md")" 1
    chk "$kind：编出来的 \${ISSUE_NUMBR} 原样留着" "$(judge "$TMP/out/$kind.md" ISSUE_NUMBR KEPT)" ok
done
while IFS=$'\t' read -r n e1 e2 e3; do
    i=0
    for kind in new-issue issue-comment pr-comment; do
        i=$((i + 1)); case $i in 1) w="$e1" ;; 2) w="$e2" ;; 3) w="$e3" ;; esac
        chk "\${$n} · $kind" "$(judge "$TMP/out/$kind.md" "$n" "$w")" ok
    done
done < <(expect)

echo "【4】判定本身：输出丢了不算换掉"
printf 'x\nPROBE-TITLE\n' > "$TMP/cut.md"
chk "标记是最后一行（下面那一行丢了）：判失败" "$(judge "$TMP/cut.md" TITLE '=测试标题')" "输出里没有这一行"
printf 'x\n' > "$TMP/none.md"
chk "标记不在：判失败" "$(judge "$TMP/none.md" TITLE KEPT)" "输出里没有这一行"
printf 'PROBE-TITLE\n${TITLE}\n' > "$TMP/kept.md"
chk "  到达性 · 原样留着的确判成 KEPT、判不成值" "$(judge "$TMP/kept.md" TITLE KEPT) / $(judge "$TMP/kept.md" TITLE '=测试标题')" 'ok / 应为 [测试标题]，实得 [${TITLE}]'

echo
report_counts "$PASS" "$FAIL"
if [ "$FAIL" -eq 0 ]; then echo "全部通过（$PASS 项）"; else echo "失败 $FAIL 项"; exit 1; fi
