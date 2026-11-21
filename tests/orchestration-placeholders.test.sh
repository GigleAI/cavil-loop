#!/usr/bin/env bash
# kind: e2e
# 编排文档占位符表（docs/orchestration{,.zh}.md「Placeholders / 占位符」）里列的每个 ${NAME}，
# 派工时真的被换掉。
#
# 跑法：bash tests/orchestration-placeholders.test.sh      （约 10 秒）
# 依赖：git、python3。不碰网络（假 gh、假 tmux），HOME 指到临时目录。
#
# 不看派工脚本的源码：起真实的三个派工脚本（新 issue / issue 评论 / PR 评论），项目的追加要求里
# 每个占位符单独一行，读派工写出的提示词，看那一行还是不是原样的 ${NAME}。至少一个入口换掉了
# 就算「会渲染」（${PR}、${ISSUE_N} 只有 PR 评论入口有，${TITLE} 只有新 issue 入口有）。
#   1. 两份文档的占位符表一样，认出了 ≥ 20 个名字
#   2. 表里每个名字都被至少一个入口换掉
#   3. 到达性：三个入口都写出了提示词，追加要求确实进了提示词；一个故意编的 ${ISSUE_NUMBR}
#      原样留着——「没换掉」能被看出来
# 文档里哪些位置可以写占位符（只在「拼提示词」一节）由 tests/orchestration-docs.test.sh 管。
set -uo pipefail
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
# shellcheck source=lib/prompt-files.sh
source "$TEST_DIR/lib/prompt-files.sh"
TMP=$(mktemp -d)
trap '[ -n "${KEEP_TMP:-}" ] && echo "TMP=$TMP" || rm -rf "$TMP"' EXIT

PASS=0 FAIL=0
ok()   { PASS=$((PASS + 1)); echo "  ✓ $1"; }
bad()  { FAIL=$((FAIL + 1)); echo "  ✗ $1"; }
chk()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1（期望 [$3]，实得 [$2]）"; fi; }

table() {   # <doc>：占位符表第一列里的 ${NAME}
    python3 - "$1" <<'PY'
import re, sys
sect, out = None, set()
for line in open(sys.argv[1], encoding='utf-8'):
    if line.startswith('#'):
        sect = line.strip() if line.startswith('### ') else None
    if sect and re.match(r'^### (Placeholders|占位符)$', sect) and line.startswith('|'):
        out |= set(re.findall(r'\$\{([A-Z][A-Z0-9_]+)\}', line.split('|')[1]))
print('\n'.join(sorted(out)))
PY
}

echo "【1】占位符表"
T_EN=$(table "$REPO_DIR/docs/orchestration.md"); T_ZH=$(table "$REPO_DIR/docs/orchestration.zh.md")
chk "两份文档的占位符表一样" "$([ "$T_EN" = "$T_ZH" ] && echo same)" same
chk "认出了 ≥ 20 个名字" "$([ "$(wc -l <<<"$T_EN")" -ge 20 ] && echo yes)" yes

# ── 一个项目：三个入口的追加要求里，每个占位符（加一个编出来的）各占一行，前面一行是标记 ──
D="$TMP/d"; mkdir -p "$D/bin" "$D/state" "$D/wt" "$TMP/home"
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
cat > "$D/config" <<CONF
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
PATH="$D/bin:\$PATH"
GH_TOKEN="fake-token-for-test"
CONF
N_NEW=987801; N_CMT=987802; N_PR=987803
run() { (cd "$D/project" && env -u CODING_AGENT_RELEASE_ROOT -u CAVIL_DEPLOY_ROOT -u DISPATCH_PROMPT_KIND \
    -u DISPATCH_WORKER_AGENT HOME="$TMP/home" CODING_AGENT_CONFIG="$D/config" bash "$@") >/dev/null 2>&1; }
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

# 标记行下面那一行：还是原样的 ${NAME} = 没换；整个提示词里找不到标记 = 读不到（不当成换掉了）
after() {   # <prompt> <name>：打印 same / changed / missing
    awk -v m="PROBE-$2" -v p="\${$2}" '$0 == m {getline n; print (n == p ? "same" : "changed"); f = 1; exit} END {if (!f) print "missing"}' "$1"
}

echo "【3】到达性"
for kind in new-issue issue-comment pr-comment; do
    chk "$kind：写出了提示词，追加要求在里面" "$([ -s "$TMP/out/$kind.md" ] && grep -c '^## 占位符探针$' "$TMP/out/$kind.md")" 1
    chk "$kind：编出来的 \${ISSUE_NUMBR} 原样留着" "$(after "$TMP/out/$kind.md" ISSUE_NUMBR)" same
done

echo "【2】表里每个名字都被至少一个入口换掉"
for n in $T_EN; do
    got=""
    for kind in new-issue issue-comment pr-comment; do got="$got $(after "$TMP/out/$kind.md" "$n")"; done
    case "$got" in
        *changed*) ok "\${$n}：被换掉（新 issue / issue 评论 / PR 评论：$got）" ;;
        *) bad "\${$n}：三个入口都没换掉（$got）" ;;
    esac
done

echo
report_counts "$PASS" "$FAIL"
if [ "$FAIL" -eq 0 ]; then echo "全部通过（$PASS 项）"; else echo "失败 $FAIL 项"; exit 1; fi
