#!/usr/bin/env bash
# PR 交给复审 / 交给人之前先查与主干有没有冲突（GitHub#82）。
#
# 跑法：bash tests/conflict-check-prompts.test.sh
# 依赖：git ≥ 2.38（merge-tree --write-tree）。不联网：origin 是本地 bare 仓库，gh 是假的。
#
# 同一条规矩落在三处：issue 回复模板的开发阶段（首次开 PR，拆出来的子项也走这里）、PR 回复
# 模板（返工）、通用 review 模板（复审下结论前）。只改其中一处不会报错，只会让某个入口照样把
# 冲突的 PR 交给人——所以这里按 daemon 真正拼出来的成品对拍：
#   1. 三份成品里的检查命令逐字一致，两份 worker 成品里的处理规则逐字一致，且排在翻 label 之前
#   2. 把成品里的检查命令原样拿出来，在真实 git worktree 里跑：无冲突 / 有冲突 / 只落后 /
#      取不到分支 / 本地没推的提交，各自判对，而且不动工作区、不产生提交
#   3. 每个写入点单独拿掉 / 改一个字，1 必须红
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
cat > "$TMP/coding-agent.config" <<CONF
REPO="acme/widget"
PROJECT_ROOT="$TMP/project"
WORKTREE_BASE="$TMP/wt"
STATE_DIR="$TMP/state"
TMUX_PREFIX="conflicttest"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
CONF
mkdir -p "$TMP/state" "$TMP/wt"

export CODING_AGENT_CONFIG="$TMP/coding-agent.config"
exec 8>&2
# shellcheck source=../scripts/_lib.sh
source "$REPO_DIR/scripts/_lib.sh"
exec 2>&8 8>&-
set +e

pass=0; fail=0
ok()  { echo "  ✅ $1"; pass=$((pass+1)); }
bad() { echo "  ❌ $1"; fail=$((fail+1)); }

ALL=(issue-comment pr-comment review)
WORKERS=(issue-comment pr-comment)
SECTION_HEAD='## 交出 PR 前：先查和主干有没有冲突'

make_sandbox() {
    rm -rf "$TMP/skill" "$TMP/project"
    mkdir -p "$TMP/skill" "$TMP/project/.agents/skills/cavil-loop"
    cp -r "$REPO_DIR/prompts" "$TMP/skill/prompts"
    cp -r "$REPO_DIR/.agents/skills/cavil-loop/prompts" "$TMP/project/.agents/skills/cavil-loop/prompts"
    SKILL_DIR="$TMP/skill"
}

snippet() { sed -n '/^# --- 冲突检查 开始 ---$/,/^# --- 冲突检查 结束 ---$/p' "$1"; }
# worker 的处理规则：从段标题截到下一个二级标题之前
section() { awk -v h="$SECTION_HEAD" '$0==h{on=1;print;next} on&&/^## /{exit} on{print}' "$1"; }
line_of() { grep -nF -- "$2" "$1" | head -1 | cut -d: -f1; }

# 打印发现的问题，一行一条；空输出 = 全部满足
check_prompts() {
    local name f s ref_snip="" ref_sec=""
    for name in "${ALL[@]}"; do
        f=$(compose_prompt_template "$name" 2>/dev/null)
        [ -s "$f" ] || { echo "$name: 拼不出 prompt"; continue; }
        cp "$f" "$TMP/composed-$name.md"; f="$TMP/composed-$name.md"
        s=$(snippet "$f")
        if [ -z "$s" ]; then echo "$name: 没有冲突检查命令"; continue; fi
        [ "$(grep -c '^# --- 冲突检查 开始 ---$' "$f")" -eq 1 ] || echo "$name: 冲突检查命令不止一份"
        if [ -z "$ref_snip" ]; then ref_snip="$s"; elif [ "$s" != "$ref_snip" ]; then echo "$name: 冲突检查命令和 ${ALL[0]} 不一致"; fi
    done

    for name in "${WORKERS[@]}"; do
        f="$TMP/composed-$name.md"; [ -s "$f" ] || continue
        s=$(section "$f")
        if [ -z "$s" ]; then echo "$name: 没有「交出 PR 前」处理规则"; continue; fi
        grep -qF '冲突检查 开始' <<<"$s" || echo "$name: 处理规则里没有检查命令"
        grep -qF '不 rebase、不强推' <<<"$s" || echo "$name: 处理规则缺「不 rebase、不强推」"
        grep -qF 'git merge --abort' <<<"$s" || echo "$name: 处理规则缺解不了时的恢复"
        grep -qF '重跑相关测试' <<<"$s" || echo "$name: 处理规则缺重跑测试"
        grep -qF '没有冲突时**不要**合主干' <<<"$s" || echo "$name: 处理规则缺「只落后不合」"
        grep -qF '不要写成「无冲突」' <<<"$s" || echo "$name: 处理规则缺检查失败时的如实披露"
        if [ -z "$ref_sec" ]; then ref_sec="$s"; elif [ "$s" != "$ref_sec" ]; then echo "$name: 处理规则和 ${WORKERS[0]} 不一致"; fi
    done

    # 翻 label 的那一步必须先指到这段，而且指向在翻 label 命令之前
    local ref flip
    f="$TMP/composed-pr-comment.md"
    if [ -s "$f" ]; then
        ref=$(grep -E '^3\. .*flip_label' "$f" | head -1)
        flip=${ref%%flip_label*}
        grep -qF '翻 label 之前先做下方「交出 PR 前：先查和主干有没有冲突」' <<<"$flip" \
            || echo "pr-comment: 翻 label 那一步没先指到冲突检查"
    fi
    f="$TMP/composed-issue-comment.md"
    if [ -s "$f" ]; then
        ref=$(line_of "$f" '再做下方「交出 PR 前：先查和主干有没有冲突」')
        flip=$(line_of "$f" 'flip_label <P> --add')
        if [ -z "$ref" ]; then echo "issue-comment: 开 PR 后翻 label 前没指到冲突检查"
        elif [ -z "$flip" ] || [ "$ref" -ge "$flip" ]; then echo "issue-comment: 冲突检查排在翻 label 之后"; fi
    fi

    # 复审：第 2C 步在发结论评论（第 3 步）之前，有冲突改判不通过
    f="$TMP/composed-review.md"
    if [ -s "$f" ]; then
        ref=$(grep -nE '^2C\. ' "$f" | head -1 | cut -d: -f1)
        flip=$(grep -nE '^3\. 在该目标发一条 review 结论评论' "$f" | head -1 | cut -d: -f1)
        local start
        start=$(line_of "$f" '# --- 冲突检查 开始 ---')
        if [ -z "$ref" ]; then echo "review: 没有下结论前的冲突检查步骤"
        elif [ -z "$flip" ] || [ "$ref" -ge "$flip" ] || [ -z "$start" ] || [ "$start" -ge "$flip" ]; then
            echo "review: 冲突检查排在发结论评论之后"
        fi
        sed -n "${ref:-1},${flip:-\$}p" "$f" | grep -qF '**改判不通过**' || echo "review: 有冲突没写成改判不通过"
    fi
}

echo "── 仓库现状：三份成品带同一份检查命令，worker 处理规则一致，都排在翻 label / 下结论之前 ──"
make_sandbox
out=$(check_prompts)
if [ -z "$out" ]; then ok "全部满足"; else bad "仓库现状不满足："; sed 's/^/       /' <<<"$out"; fi

# ── 2. 成品里的检查命令原样在真实 git worktree 里跑 ──
echo "── 检查命令实跑（真实 git worktree + 假 gh）──"
mkdir -p "$TMP/bin"
cat > "$TMP/bin/gh" <<'GH'
#!/usr/bin/env bash
# 只认 `gh pr view <P> --repo R --json baseRefName,headRefOid --jq ...`，按环境变量回答
case "$*" in
    "pr view 7 --repo acme/widget --json baseRefName,headRefOid "*) echo "$FAKE_BASE $FAKE_OID" ;;
    *) echo "fake gh: unexpected: $*" >&2; exit 1 ;;
esac
GH
chmod +x "$TMP/bin/gh"

GITC=(-c user.name=t -c user.email=t@t -c init.defaultBranch=main)
G() { git "${GITC[@]}" "$@"; }

# origin（bare）+ 主 checkout + 一个 worktree 上的功能分支，PR 头同时推到 refs/pull/7/head
setup_repo() {   # <功能分支改 f 的哪一行内容> <主干改什么：same|other|none>
    rm -rf "$TMP/git"; mkdir -p "$TMP/git"
    G init -q --bare "$TMP/git/origin.git"
    G clone -q "$TMP/git/origin.git" "$TMP/git/main" 2>/dev/null
    (cd "$TMP/git/main" && printf 'a\nb\nc\n' > f && echo x > g && G add . && G commit -qm init && G push -q origin main) || return 1
    (cd "$TMP/git/main" && G worktree add -q -b feature/issue-7 "$TMP/git/wt" main) || return 1
    (cd "$TMP/git/wt" && printf 'a\n%s\nc\n' "$1" > f && G commit -qam feat \
        && G push -q origin feature/issue-7 && G push -q origin HEAD:refs/pull/7/head) || return 1
    case "$2" in
        same)  (cd "$TMP/git/main" && printf 'a\nMAIN\nc\n' > f && G commit -qam main && G push -q origin main) ;;
        other) (cd "$TMP/git/main" && echo z > g && G commit -qam main && G push -q origin main) ;;
        none)  : ;;
    esac
}

run_snippet() {   # <成品 prompt>；在 worktree 里跑，回显输出
    snippet "$1" | sed 's|\${REPO}|acme/widget|g' > "$TMP/snippet.sh"
    (cd "$TMP/git/wt" && PATH="$TMP/bin:$PATH" P=7 bash "$TMP/snippet.sh" 2>&1)
}

untouched() {   # 工作区干净、HEAD 没动
    local head="$1"
    [ -z "$(cd "$TMP/git/wt" && git status --porcelain)" ] && [ "$(cd "$TMP/git/wt" && git rev-parse HEAD)" = "$head" ]
}

expect_run() {   # <说明> <期望 CONFLICT_CHECK 值> [期望出现在输出里的片段]
    local name out head
    for name in "${ALL[@]}"; do
        head=$(cd "$TMP/git/wt" && git rev-parse HEAD)
        out=$(run_snippet "$TMP/composed-$name.md")
        if ! grep -q "^CONFLICT_CHECK=$2" <<<"$out"; then bad "$name: $1 → 期望 $2，实得：$(tr '\n' ' ' <<<"$out")"; continue; fi
        if [ -n "${3:-}" ] && ! grep -qxF -- "$3" <<<"$out"; then bad "$name: $1 → 输出里没列出 $3"; continue; fi
        if ! untouched "$head"; then bad "$name: $1 → 检查动了工作区或产生了提交"; continue; fi
        ok "$name: $1 → $2"
    done
}

if ! git -C "$REPO_DIR" merge-tree --write-tree HEAD HEAD >/dev/null 2>&1; then
    bad "本机 git 不支持 merge-tree --write-tree（要 ≥ 2.38），实跑部分跳过"
else
    export FAKE_BASE=main
    setup_repo FEAT same;  FAKE_OID=$(cd "$TMP/git/wt" && git rev-parse HEAD); export FAKE_OID
    expect_run "主干改了同一行" conflict f
    setup_repo FEAT other; FAKE_OID=$(cd "$TMP/git/wt" && git rev-parse HEAD)
    expect_run "主干只改了别的文件（落后但不冲突）" clean
    setup_repo FEAT none;  FAKE_OID=$(cd "$TMP/git/wt" && git rev-parse HEAD)
    expect_run "主干没动" clean

    # 本地有一个没推的、会冲突的提交：查的是 GitHub 上的 PR 提交，不算它
    setup_repo FEAT other; FAKE_OID=$(cd "$TMP/git/wt" && git rev-parse HEAD)
    (cd "$TMP/git/main" && G pull -q origin main 2>/dev/null)
    (cd "$TMP/git/wt" && echo LOCAL > g && G commit -qam local)
    expect_run "本地没推的冲突提交" clean

    setup_repo FEAT same;  FAKE_OID=$(cd "$TMP/git/wt" && git rev-parse HEAD)
    FAKE_BASE=nosuch expect_run "目标分支取不到" error
    FAKE_OID=0123456789012345678901234567890123456789 expect_run "PR 提交取不到" error
    FAKE_BASE="" FAKE_OID="" expect_run "gh 什么都没回" error

    # 夹具得分得清错误实现：拿成品命令改出两个看似等价的版本，同一夹具下必须判错
    variant() {   # <说明> <python 改写> <夹具准备> <正确值>
        local out
        snippet "$TMP/composed-review.md" | sed 's|\${REPO}|acme/widget|g' > "$TMP/variant.sh"
        python3 -c "$2" "$TMP/variant.sh"
        eval "$3"
        out=$(cd "$TMP/git/wt" && PATH="$TMP/bin:$PATH" P=7 bash "$TMP/variant.sh" 2>&1)
        if grep -q "^CONFLICT_CHECK=$4" <<<"$out"; then bad "负对照：$1 → 夹具没分出来（仍判 $4）"
        else ok "负对照：$1 → 判成 $(grep -o '^CONFLICT_CHECK=[a-z]*' <<<"$out" | head -1)，夹具分得出"; fi
    }
    variant "用本地 HEAD 代替 GitHub 上的 PR 提交" \
        'import sys;p=sys.argv[1];t=open(p).read();t=t.replace("--name-only \"$HEAD_OID\"","--name-only HEAD");open(p,"w").write(t)' \
        'setup_repo FEAT other; FAKE_OID=$(cd "$TMP/git/wt" && git rev-parse HEAD); (cd "$TMP/git/wt" && echo LOCAL > g && G commit -qam local)' \
        clean
    variant "不先确认分支取得到、只看退出码" \
        'import sys,re;p=sys.argv[1];t=open(p).read();t=re.sub(r"if \[ -z \"\$BASE\" \].*?\nelse\n","if false; then :\nelse\n",t,flags=re.S);t=t.replace("[ \"$rc\" -eq 1 ] && head -1 \"$MT\" | grep -qE '"'"'^[0-9a-f]{40}([0-9a-f]{24})?$'"'"'","[ \"$rc\" -eq 1 ]");open(p,"w").write(t)' \
        'setup_repo FEAT same; FAKE_OID=$(cd "$TMP/git/wt" && git rev-parse HEAD); FAKE_BASE=nosuch' \
        error
    FAKE_BASE=main
fi

# ── 3. 负对照：每个写入点单独拿掉 / 改一个字，check_prompts 必须报出对应那条 ──
expect_red() {   # <说明> <期望出现的报错片段>
    out=$(check_prompts)
    if grep -qF -- "$2" <<<"$out"; then ok "负对照：$1 → 被拦下"
    else bad "负对照：$1 → 没被拦下（输出：${out:-空}）"; fi
}

echo "── 负对照 ──"
for name in issue-comment pr-comment; do
    make_sandbox
    python3 - "$SKILL_DIR/prompts/$name.template.md" "$SECTION_HEAD" <<'PY'
import sys
p, head = sys.argv[1], sys.argv[2]
t = open(p).read()
s = t.index(head + "\n"); e = t.index("\n## ", s + 1) + 1
open(p, "w").write(t[:s] + t[e:])
PY
    expect_red "$name 没有处理规则段" "$name: 没有「交出 PR 前」处理规则"
done

make_sandbox
sed -i '/^# --- 冲突检查 开始 ---$/,/^# --- 冲突检查 结束 ---$/d' "$SKILL_DIR/prompts/review.template.md"
expect_red "review 没有检查命令" "review: 没有冲突检查命令"

for name in issue-comment pr-comment review; do
    make_sandbox
    sed -i 's/merge-tree --write-tree --name-only/merge-tree --write-tree/' "$SKILL_DIR/prompts/$name.template.md"
    want="$name: 冲突检查命令和 issue-comment 不一致"
    [ "$name" = issue-comment ] && want="pr-comment: 冲突检查命令和 issue-comment 不一致"
    expect_red "$name 检查命令改了一个参数" "$want"
done

make_sandbox
sed -i 's/不 rebase、不强推/尽量不强推/' "$SKILL_DIR/prompts/pr-comment.template.md"
expect_red "pr-comment 处理规则放松了强推" "pr-comment: 处理规则缺「不 rebase、不强推」"

make_sandbox
sed -i 's/读懂两边各自要做什么/读懂两边要做什么/' "$SKILL_DIR/prompts/issue-comment.template.md"
expect_red "issue-comment 处理规则改了一个词" "pr-comment: 处理规则和 issue-comment 不一致"

make_sandbox
sed -i 's/3\. 翻 label 之前先做下方「交出 PR 前：先查和主干有没有冲突」，按它的结果决定翻哪个。翻 label：/3. 翻 label：/' "$SKILL_DIR/prompts/pr-comment.template.md"
expect_red "pr-comment 翻 label 不再先查冲突" "pr-comment: 翻 label 那一步没先指到冲突检查"

make_sandbox
sed -i 's/，再做下方「交出 PR 前：先查和主干有没有冲突」（解不了时第一行改成给 PR 翻 `${LABEL_PENDING_HUMAN}`、不交复审，第二行照旧），然后翻 label/，再翻 label/' "$SKILL_DIR/prompts/issue-comment.template.md"
expect_red "issue-comment 开 PR 后不再先查冲突" "issue-comment: 开 PR 后翻 label 前没指到冲突检查"

make_sandbox
python3 - "$SKILL_DIR/prompts/review.template.md" <<'PY'
import sys
p = sys.argv[1]; t = open(p).read()
s = t.index("2C. "); e = t.index("3. 在该目标发一条 review 结论评论")
block = t[s:e]; t = t[:s] + t[e:]
a = t.index("5. 通过：REST 翻")
open(p, "w").write(t[:a] + block + t[a:])
PY
expect_red "review 冲突检查挪到发结论评论之后" "review: 冲突检查排在发结论评论之后"

make_sandbox
sed -i 's/\*\*改判不通过\*\*/可以酌情通过/' "$SKILL_DIR/prompts/review.template.md"
expect_red "review 有冲突不再判不通过" "review: 有冲突没写成改判不通过"

echo
echo "通过 $pass，失败 $fail"
[ "$fail" -eq 0 ]
