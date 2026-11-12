#!/usr/bin/env bash
# kind: e2e
# 派工提示词放在项目自己的状态目录里（GitHub#396）。
#
# 跑法：bash tests/prompt-files.test.sh   （约 10 秒）
# 依赖：bash、jq、git。不碰网络：假 gh / 假 tmux，HOME 指向临时目录；派工、清理都是真脚本、真 git。
#
# 以前三个派工脚本把提示词写到 /tmp 下只按编号命名的固定文件：同机两个项目派到同一编号会互相覆盖、
# 别的账号读得到，测试用固定编号、两份同时跑时互相读删对方的提示词。现在：
#   1. 三个派工脚本都写到 $STATE_DIR/prompts/<工作编号>-…，目录 700，/tmp 下什么都不写
#      （PR 评论那份按工作编号开头，工作编号和 PR 号不同时也是）
#   2. 清理条目时删掉这个编号的提示词，编号是它前缀的别的条目（39 / 390）一个不碰
#   3. 提示词目录建不出来时不派工：不起 worker、不翻标签
#   4. 测试跑改动前的旧脚本对拍时用的 tests/lib/prompt-files.sh：真跑一份改动前（固定提交）的旧派工
#      脚本，提示词落在本次运行自己的目录、/tmp 下没有；认不出写法的旧脚本一律报错，不悄悄退回 /tmp
set -uo pipefail
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
# shellcheck source=lib/prompt-files.sh
source "$TEST_DIR/lib/prompt-files.sh"

SANDBOX=$(mktemp -d)
trap '[ -n "${KEEP_SANDBOX:-}" ] && echo "SANDBOX=$SANDBOX" || rm -rf "$SANDBOX"' EXIT
mkdir -p "$SANDBOX/bin" "$SANDBOX/home"
export HOME="$SANDBOX/home"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 TZ=UTC
unset CODING_AGENT_RELEASE_ROOT LABEL_AUTOPILOT LABEL_PENDING_BLOCKED GH_TOKEN WRITE_GH_TOKEN GITHUB_TOKEN
unset DISPATCH_AUTOPILOT DISPATCH_AUTOPILOT_ISSUE DISPATCH_AUTOPILOT_PR DISPATCH_PROMPT_KIND

pass=0; fail=0
chk() {   # <名字> <实得> <期望>
    if [ "$2" = "$3" ]; then echo "  ✅ $1"; pass=$((pass+1))
    else echo "  ❌ $1 (期望 [$3]，实得 [$2])"; fail=$((fail+1)); fi
}
yes_() { local n="$1"; shift; if "$@"; then chk "$n" yes yes; else chk "$n" no yes; fi; }
no_()  { local n="$1"; shift; if "$@"; then chk "$n" yes no; else chk "$n" no no; fi; }

# 假 gh：标题、PR 信息给固定答案，翻标签记一行；假 tmux：new-session 记一行，会话一律「不在」
cat > "$SANDBOX/bin/gh" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${FAKE_LOG:?}/gh.log"
case "$*" in
    *"/labels"*) echo '[]' ;;
    *"--jq .title"*|*title*) echo "测试标题" ;;
    *) echo "{}" ;;
esac
exit 0
SH
cat > "$SANDBOX/bin/tmux" <<'SH'
#!/usr/bin/env bash
log="${FAKE_LOG:?}/tmux.log"
case "$1" in
    new-session)
        name=""; prev=""
        for a in "$@"; do [ "$prev" = -s ] && name="$a"; prev="$a"; done
        printf 'new-session %s\n' "$*" >> "$log"; echo "$name" >> "$log.live"; exit 0 ;;
    has-session)
        t=""; prev=""
        for a in "$@"; do [ "$prev" = -t ] && t="${a#=}"; prev="$a"; done
        grep -qxF -- "$t" "$log.live" 2>/dev/null; exit $? ;;
    ls|list-sessions) [ -s "$log.live" ] && cat "$log.live"; exit 0 ;;
esac
exit 0
SH
printf '#!/usr/bin/env bash\nexit 0\n' > "$SANDBOX/bin/claude"
chmod +x "$SANDBOX/bin/gh" "$SANDBOX/bin/tmux" "$SANDBOX/bin/claude"

git init -q --bare -b main "$SANDBOX/up.git"
git clone -q "$SANDBOX/up.git" "$SANDBOX/seed" 2>/dev/null
(cd "$SANDBOX/seed" && git -c user.email=t@example.invalid -c user.name=t commit -q --allow-empty -m init \
    && git push -q origin HEAD:main) >/dev/null 2>&1

# 编号每次运行都不同，「/tmp 下没有这个编号的文件」才能归到本次运行头上
N=$(( 700000000 + ($$ % 100000) * 1000 + RANDOM % 1000 )); P=$((N + 7)); M="${N}0"

# setup <名字>：一套独立的项目、状态目录、配置
setup() {
    W="$SANDBOX/w-$1"; rm -rf "$W"; mkdir -p "$W/state" "$W/wt" "$W/log"
    git clone -q "$SANDBOX/up.git" "$W/project" 2>/dev/null
    cat > "$W/config" <<CONF
REPO="example/pf"
PROJECT_ROOT="$W/project"
WORKTREE_BASE="$W/wt"
STATE_DIR="$W/state"
TMUX_PREFIX="pftest"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
LABEL_AGENT_DOING="doing/agent"
LABEL_PENDING_REVIEW="pending/review"
WORKER_AGENT_DEFAULT="claude"
POST_MERGE_RETROSPECTIVE=false
PATH="$SANDBOX/bin:\$PATH"
GH_TOKEN="fake-token-for-test"
CONF
}
run_in() {   # <根> <脚本> <参数…>
    local root="$1" s="$2"; shift 2
    (cd "$W/project" && env FAKE_LOG="$W/log" CODING_AGENT_CONFIG="$W/config" PATH="$SANDBOX/bin:$PATH" \
        timeout 120 bash "$root/scripts/$s" "$@") > "$W/log/$s.out" 2>&1
}
tmp_hits() { find /tmp -maxdepth 1 -name "cavil-loop-*-$1-*" 2>/dev/null | wc -l | tr -d ' '; }

echo "── 1. 三个派工脚本写到状态目录，/tmp 下什么都不写 ──"
setup cur
run_in "$REPO_DIR" dispatch-new-issue.sh "$N"; rc_new=$?
run_in "$REPO_DIR" dispatch-issue-comment.sh "$N" 0; rc_cmt=$?
# PR 号和工作编号不同：分支名带的是工作编号
run_in "$REPO_DIR" dispatch-pr-comment.sh "$P" "feature/issue-$N" 0; rc_pr=$?
chk "三次派工都成功" "$rc_new/$rc_cmt/$rc_pr" "0/0/0"
yes_ "新 issue：提示词写在 <状态目录>/prompts/$N-new.md" test -s "$W/state/prompts/$N-new.md"
yes_ "issue 评论：写在 $N-cmt-0.md" test -s "$W/state/prompts/$N-cmt-0.md"
yes_ "PR 评论：按工作编号开头，写在 $N-pr-$P.md" test -s "$W/state/prompts/$N-pr-$P.md"
chk "提示词目录只有这三份" "$(ls "$W/state/prompts" | sort | tr '\n' ' ')" "$N-cmt-0.md $N-new.md $N-pr-$P.md "
chk "提示词目录权限是 700" "$(stat -c %a "$W/state/prompts")" 700
chk "/tmp 下没有这两个编号的提示词" "$(tmp_hits "$N")/$(tmp_hits "$P")" "0/0"
yes_ "提示词是真的派工提示词（带着 issue 编号）" grep -q "#$N" "$W/state/prompts/$N-new.md"
yes_ "worker 启动命令读的就是这份文件" grep -qF "$W/state/prompts/$N-new.md" "$W/log/tmux.log"
chk "测试用的查找规则找到的就是这三份" \
    "$(prompt_file_of "$REPO_DIR" "$W/state" new "$N")|$(prompt_file_of "$REPO_DIR" "$W/state" cmt "$N" 0)|$(prompt_file_of "$REPO_DIR" "$W/state" pr "$P")" \
    "$W/state/prompts/$N-new.md|$W/state/prompts/$N-cmt-0.md|$W/state/prompts/$N-pr-$P.md"

echo "── 2. 已有的目录权限太宽：派工时收紧成 700 ──"
setup widen
mkdir -p "$W/state/prompts"; chmod 755 "$W/state/prompts"
run_in "$REPO_DIR" dispatch-new-issue.sh "$N"; rc=$?
chk "派工成功" "$rc" 0
yes_ "写出了提示词" test -s "$W/state/prompts/$N-new.md"
chk "目录权限收紧成 700" "$(stat -c %a "$W/state/prompts")" 700

echo "── 3. 清理条目：删这个编号的提示词，编号以它开头的别的条目（$N / $M）不碰 ──"
setup clean
run_in "$REPO_DIR" dispatch-new-issue.sh "$N"
run_in "$REPO_DIR" dispatch-issue-comment.sh "$N" 0
run_in "$REPO_DIR" dispatch-pr-comment.sh "$P" "feature/issue-$N" 0
run_in "$REPO_DIR" dispatch-new-issue.sh "$M"
run_in "$REPO_DIR" dispatch-issue-comment.sh "$M" 0
chk "清理前：两个条目各有提示词" "$(ls "$W/state/prompts" | wc -l | tr -d ' ')" 5
run_in "$REPO_DIR" cleanup-issue.sh "$N" --force; rc=$?
chk "清理成功" "$rc" 0
chk "清理后只剩 $M 的两份" "$(ls "$W/state/prompts" | sort | tr '\n' ' ')" "$M-cmt-0.md $M-new.md "
no_ "worktree 也删了（清理确实走完）" test -d "$W/wt/issue-$N"
run_in "$REPO_DIR" cleanup-issue.sh "$M" --force; rc=$?
chk "第二个条目清理成功、目录空了" "$rc/$(ls "$W/state/prompts" | wc -l | tr -d ' ')" "0/0"
run_in "$REPO_DIR" cleanup-issue.sh "$((N + 3))" --force; rc=$?
chk "没派过工的编号清理也照常成功" "$rc" 0

echo "── 4. 提示词目录建不出来：不派工 ──"
setup nodir
: > "$W/state/prompts"   # 同名文件占住，mkdir 必然失败
run_in "$REPO_DIR" dispatch-new-issue.sh "$N"; rc=$?
no_ "派工失败退出" test "$rc" = 0
chk "没起 worker" "$(cat "$W/log/tmux.log" 2>/dev/null | grep -c '^new-session')" 0
chk "没翻 doing/agent" "$(cat "$W/log/gh.log" 2>/dev/null | grep -c 'doing/agent')" 0
yes_ "日志写明建不出提示词目录" grep -q '建不出提示词目录' "$W/state/poll.log"
setup okdir
run_in "$REPO_DIR" dispatch-new-issue.sh "$N"
chk "对照：目录能建时同一次派工起了 worker、翻了 doing/agent" \
    "$(grep -c '^new-session' "$W/log/tmux.log")/$([ "$(grep -c 'doing/agent' "$W/log/gh.log")" -ge 1 ] && echo yes)" "1/yes"

echo "── 5. 测试跑旧脚本：真跑一份改动前的派工脚本，提示词落在本次运行的目录 ──"
# 固定提交，不随主干变：GitHub#396 之前的最后一个主干提交，三个派工脚本还写 /tmp
OLD_REV=4f585deace1aec90db8e942cae7775f5c2023554
OLD="$SANDBOX/old"; mkdir -p "$OLD"
git -C "$REPO_DIR" archive "$OLD_REV" scripts prompts | tar -x -C "$OLD"
chk "夹具：旧版三个派工脚本各有一处 /tmp 固定路径" \
    "$(for s in $PROMPT_TREE_SCRIPTS; do grep -c '"/tmp/cavil-loop-' "$OLD/scripts/$s"; done | tr '\n' ' ')" "1 1 1 "
cp -r "$OLD" "$SANDBOX/old-pristine"
yes_ "改写旧脚本成功" prompt_tree_isolate "$OLD" "$SANDBOX/legacy"
chk "改写后三个脚本都没有 /tmp 固定路径" \
    "$(for s in $PROMPT_TREE_SCRIPTS; do grep -c '"/tmp/cavil-loop-' "$OLD/scripts/$s"; done | tr '\n' ' ')" "0 0 0 "
chk "改写只动了三个派工脚本各一行" \
    "$(diff -r "$SANDBOX/old-pristine" "$OLD" | grep -c '^>')/$(diff -rq "$SANDBOX/old-pristine" "$OLD" | grep -c '^Files')" "3/3"
setup old
run_in "$OLD" dispatch-new-issue.sh "$N"; rc=$?
chk "旧脚本派工成功" "$rc" 0
yes_ "旧脚本的提示词写在本次运行的目录里" test -s "$SANDBOX/legacy/cavil-loop-issue-$N-prompt.md"
chk "查找规则找到的就是它" "$(prompt_file_of "$OLD" "$W/state" new "$N")" "$SANDBOX/legacy/cavil-loop-issue-$N-prompt.md"
chk "/tmp 下没有这个编号的提示词" "$(tmp_hits "$N")" 0
run_in "$OLD" dispatch-pr-comment.sh "$P" "feature/issue-$N" 0
yes_ "旧脚本的 PR 提示词也在本次运行的目录里" test -s "$SANDBOX/legacy/cavil-loop-pr-$P-prompt.md"
chk "PR 的查找规则找到的就是它" "$(prompt_file_of "$OLD" "$W/state" pr "$P")" "$SANDBOX/legacy/cavil-loop-pr-$P-prompt.md"
prompt_files_clear "$OLD" "$W/state"
chk "清掉的只是本次运行目录里的那几份" "$(ls "$SANDBOX/legacy" | wc -l | tr -d ' ')" 0
yes_ "同一份旧脚本再改写一次：不报错、仍指向同一目录" prompt_tree_isolate "$OLD" "$SANDBOX/legacy"
no_ "已经改写过的旧脚本不能再改到另一个目录" prompt_tree_isolate "$OLD" "$SANDBOX/legacy2" 2>/dev/null

echo "── 6. 认不出写法的旧脚本：报错，不悄悄退回 /tmp ──"
part="$SANDBOX/old-part"; cp -r "$SANDBOX/old-pristine" "$part"
sed -i 's|"/tmp/cavil-loop-pr-|"/var/tmp/cavil-loop-pr-|' "$part/scripts/dispatch-pr-comment.sh"
no_ "只有两个脚本写 /tmp 固定路径：报错" prompt_tree_isolate "$part" "$SANDBOX/legacy-part" 2>/dev/null
two="$SANDBOX/old-two"; cp -r "$SANDBOX/old-pristine" "$two"
grep '"/tmp/cavil-loop-' "$two/scripts/dispatch-new-issue.sh" | sed 's/^/# /' >> "$two/scripts/dispatch-new-issue.sh"
no_ "某个脚本有两处：报错" prompt_tree_isolate "$two" "$SANDBOX/legacy-two" 2>/dev/null
chk "报错时脚本一个字节没改" "$(diff -rq "$SANDBOX/old-pristine/scripts/dispatch-issue-comment.sh" "$two/scripts/dispatch-issue-comment.sh" >/dev/null && echo same)" same
rel="$SANDBOX/old-rel"; cp -r "$SANDBOX/old-pristine" "$rel"
no_ "目录不是绝对路径：报错" prompt_tree_isolate "$rel" "legacy-rel" 2>/dev/null
NEWCOPY="$SANDBOX/newcopy"; mkdir -p "$NEWCOPY"; cp -r "$REPO_DIR/scripts" "$NEWCOPY/"
yes_ "新写法的脚本：什么都不做、不报错" prompt_tree_isolate "$NEWCOPY" "$SANDBOX/legacy-new"
chk "新写法的脚本一个字节没改、没留记号" \
    "$(diff -rq "$REPO_DIR/scripts" "$NEWCOPY/scripts" >/dev/null && echo same)/$([ -e "$NEWCOPY/$PROMPT_TREE_MARK" ] && echo mark || echo none)" "same/none"

echo
echo "通过 $pass，失败 $fail"
report_counts "$pass" "$fail"
[ "$fail" -eq 0 ]
