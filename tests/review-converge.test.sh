#!/usr/bin/env bash
# kind: e2e
# 复审收敛与 REVIEW.md（GitHub#621）。
#
# 跑法：bash tests/review-converge.test.sh（约 10 秒）
# 依赖：git（merge-tree --write-tree，2.38 起）、jq。不碰网络：假 gh 从文件里答，HOME 指到临时目录。
#
#   【1】REVIEW.md 三态 × 全部入口：本地裸仓库当 origin，用 daemon 拼 prompt 的同一个函数
#        （compose_prompt_template）拼复审和四个 worker 入口，另有一个整份替换了复审 / worker 模板的项目；
#        再用真实的派工脚本跑一遍新 issue 与复审。主干有 → 复审含全文、worker 含自查句；主干确认没有 →
#        都不含；读不到（远端引用不在 / 是目录）→ 都含「未能读取」；只在本地工作区有 → 不含
#   【2】收敛段送达：每份复审 prompt 都有、worker prompt 都没有；托管复审时托管规则段排在它后面
#   【3】修复范围脚本：真实 git 仓库里造跨轮历史，docs/operations.md 两张表每行一例
set -uo pipefail
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
# shellcheck source=lib/prompt-files.sh
source "$TEST_DIR/lib/prompt-files.sh"
TMP=$(mktemp -d)
trap '[ -n "${KEEP:-}" ] && echo "TMP=$TMP" || rm -rf "$TMP"' EXIT
export TZ=UTC GIT_CONFIG_GLOBAL="$TMP/gitconfig" GIT_CONFIG_NOSYSTEM=1
printf '[user]\n\tname = t\n\temail = t@example.invalid\n[init]\n\tdefaultBranch = main\n' > "$GIT_CONFIG_GLOBAL"

pass=0; fail=0
ok()  { echo "  ✅ $1"; pass=$((pass + 1)); }
bad() { echo "  ❌ $1"; [ -n "${2:-}" ] && printf '     %s\n' "$2"; fail=$((fail + 1)); }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "期望「$3」，实得「$2」"; fi; }

CONVERGE_HEAD='# 复审收敛规则：首轮一次报全，之后只复核修复'
MD_HEAD='# 本项目的审查标准（仓库根目录 REVIEW.md）'
MD_BODY='本项目的独特审查标准：数据口径错一律必须改'
WORKER_LINE='交出 PR 或方案之前，先读它'
UNREAD_REVIEW='本项目 REVIEW.md 未能读取（不代表没有）：本轮按全量复审'
UNREAD_WORKER='REVIEW.md 未能读取（daemon 拼这份说明时读不到主干上的它'

# ════════ 【1】【2】拼 prompt ════════
mkdir -p "$TMP/bin" "$TMP/home"
cat > "$TMP/bin/gh" <<'SH'
#!/usr/bin/env bash
case "$*" in *title*) echo "测试标题" ;; *) echo "{}" ;; esac
exit 0
SH
cat > "$TMP/bin/tmux" <<'SH'
#!/usr/bin/env bash
case "$1" in has-session) exit 1 ;; esac
exit 0
SH
chmod +x "$TMP/bin/gh" "$TMP/bin/tmux"

# make_project <名字> <REVIEW.md 怎么放：remote / none / dir> [replace]
make_project() {
    local d="$TMP/proj-$1"
    git init -q --bare "$d/upstream.git"
    git clone -q "$d/upstream.git" "$d/seed" 2>/dev/null
    (
        cd "$d/seed" || exit 1
        echo x > f
        case "$2" in
            remote) printf '# REVIEW\n\n%s\n' "$MD_BODY" > REVIEW.md ;;
            dir) mkdir REVIEW.md; echo y > REVIEW.md/inner ;;
        esac
        if [ "${3:-}" = replace ]; then
            local P=.agents/skills/cavil-loop/prompts
            mkdir -p "$P"
            printf '项目自己的复审模板，整份替换工具的。\n' > "$P/review.template.md"
            printf '项目自己的 worker 模板，整份替换工具的。\n' > "$P/issue-comment.template.md"
        fi
        git add -A && git commit -qm init && git push -q origin HEAD:main
    ) >/dev/null 2>&1
    git clone -q "$d/upstream.git" "$d/project" 2>/dev/null
    echo "$d"
}

write_config() {   # <项目目录> <输出文件>
    cat > "$2" <<CONF
REPO="example/none"
PROJECT_ROOT="$1/project"
WORKTREE_BASE="$1/wt"
STATE_DIR="$1/state"
TMUX_PREFIX="rcv"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
LABEL_PENDING_BLOCKED=""
LABEL_PENDING_LATER=""
LABEL_AGENT_DOING="doing/agent"
LABEL_PENDING_REVIEW="pending/review"
LABEL_AUTOPILOT="autopilot"
LABEL_PENDING_MERGE="pending/merge"
WORKER_AGENT_DEFAULT="claude"
PATH="$TMP/bin:\$PATH"
GH_TOKEN="fake-token-for-test"
CONF
    mkdir -p "$1/state" "$1/wt"
}

# compose_all <项目目录> <输出目录>：拼 review / new-issue / issue-comment / pr-comment / sub-issue，
# 外加托管复审一份。sub-issue 照 dispatch-new-issue.sh 的拼法：issue-comment 成品 + sub-issue 模板
compose_all() {
    local d="$1" out="$2"
    mkdir -p "$out"
    write_config "$d" "$d/config"
    (
        export HOME="$TMP/home" CODING_AGENT_CONFIG="$d/config"
        unset CODING_AGENT_RELEASE_ROOT DISPATCH_AUTOPILOT
        exec 8>&2
        # shellcheck source=../scripts/_lib.sh
        source "$REPO_DIR/scripts/_lib.sh"
        exec 2>&8 8>&-
        set +e
        SKILL_DIR="$REPO_DIR"
        local n f
        for n in review new-issue issue-comment pr-comment; do
            f=$(compose_prompt_template "$n" 2>/dev/null); cp "$f" "$out/$n.md"
        done
        f=$(compose_prompt_template issue-comment 2>/dev/null)
        { cat "$f"; printf '\n\n---\n\n'; cat "$(find_prompt_template sub-issue)"; } > "$out/sub-issue.md"
        DISPATCH_AUTOPILOT=1 DISPATCH_AUTOPILOT_ISSUE=5
        f=$(compose_prompt_template review 2>/dev/null); cp "$f" "$out/review-autopilot.md"
    )
}

has() { grep -qF -- "$2" "$1"; }
WORKERS=(new-issue issue-comment pr-comment sub-issue)

# 一份项目的全部成品对一种期望
expect_set() {   # <标签> <输出目录> present|absent|unreadable
    local tag="$1" out="$2" st="$3" w probs=""
    for f in review review-autopilot; do
        has "$out/$f.md" "$CONVERGE_HEAD" || probs+="$f 没有收敛段; "
        case "$st" in
            present) has "$out/$f.md" "$MD_BODY" || probs+="$f 没有 REVIEW.md 全文; " ;;
            absent) has "$out/$f.md" "$MD_HEAD" && probs+="$f 有 REVIEW.md 段; " ;;
            unreadable) has "$out/$f.md" "$UNREAD_REVIEW" || probs+="$f 没有「未能读取」; "
                        has "$out/$f.md" "$MD_BODY" && probs+="$f 带了全文; " ;;
        esac
    done
    for w in "${WORKERS[@]}"; do
        has "$out/$w.md" "$CONVERGE_HEAD" && probs+="$w 有收敛段; "
        has "$out/$w.md" "$MD_BODY" && probs+="$w 贴了 REVIEW.md 全文; "
        case "$st" in
            present) has "$out/$w.md" "$WORKER_LINE" || probs+="$w 没有自查句; " ;;
            absent) has "$out/$w.md" "$MD_HEAD" && probs+="$w 有 REVIEW.md 段; " ;;
            unreadable) has "$out/$w.md" "$UNREAD_WORKER" || probs+="$w 没有「未能读取」; " ;;
        esac
    done
    if [ -z "$probs" ]; then ok "$tag：复审 ×2、worker ×4 都符合「$st」"; else bad "$tag" "$probs"; fi
}

echo "── 【1】【2】REVIEW.md 三态 × 全部入口 ──"
P=$(make_project present remote); compose_all "$P" "$TMP/out-present"; expect_set "主干有 REVIEW.md" "$TMP/out-present" present
P=$(make_project absent none); compose_all "$P" "$TMP/out-absent"; expect_set "主干没有 REVIEW.md" "$TMP/out-absent" absent
# 只在本地工作区有：不捡本地文件
printf '# REVIEW\n\n%s\n' "$MD_BODY" > "$P/project/REVIEW.md"
compose_all "$P" "$TMP/out-local"; expect_set "只在本地工作区有" "$TMP/out-local" absent
P=$(make_project noref remote); git -C "$P/project" update-ref -d refs/remotes/origin/main
compose_all "$P" "$TMP/out-noref"; expect_set "远端引用不在" "$TMP/out-noref" unreadable
P=$(make_project dir dir); compose_all "$P" "$TMP/out-dir"; expect_set "主干上 REVIEW.md 是目录" "$TMP/out-dir" unreadable
P=$(make_project replace remote replace); compose_all "$P" "$TMP/out-replace"
expect_set "整份替换了模板的项目" "$TMP/out-replace" present
has "$TMP/out-replace/review.md" '项目自己的复审模板' && ok "替换项目的复审 prompt 用的是项目模板" || bad "替换项目的复审 prompt 没用项目模板"

# 顺序：REVIEW.md 段 → 收敛段 → 托管规则段（托管段改收敛规则的第 ④ 步，得在后面）
f="$TMP/out-present/review-autopilot.md"
l_md=$(grep -nF -- "$MD_HEAD" "$f" | head -1 | cut -d: -f1)
l_cv=$(grep -nF -- "$CONVERGE_HEAD" "$f" | head -1 | cut -d: -f1)
l_ap=$(grep -nF -- '# 托管规则（本条是托管条目）' "$f" | head -1 | cut -d: -f1)
l_late=$(grep -nF -- '## 迟到的「必须改」（覆盖复审收敛规则判断顺序的第 ④ 步）' "$f" | head -1 | cut -d: -f1)
if [ -n "$l_md" ] && [ -n "$l_cv" ] && [ -n "$l_ap" ] && [ -n "$l_late" ] && [ "$l_md" -lt "$l_cv" ] && [ "$l_cv" -lt "$l_ap" ] && [ "$l_ap" -lt "$l_late" ]; then
    ok "托管复审：REVIEW.md 段 → 收敛段 → 托管规则（含迟到必须改照打回）"
else bad "托管复审里段落顺序不对" "REVIEW.md=$l_md 收敛=$l_cv 托管=$l_ap 迟到=$l_late"; fi
has "$TMP/out-present/review.md" '# 托管规则（本条是托管条目）' && bad "普通复审带了托管规则" || ok "普通复审不带托管规则"
# 收敛段里的命令是渲染好的，指向随发布的修复范围脚本
if has "$f" "bash '$REPO_DIR/scripts/review-scope.sh' --repo 'example/none' pr" && ! has "$f" '@@SCOPE_CMD@@'; then
    ok "收敛段里的修复范围命令已渲染"
else bad "收敛段里的修复范围命令没渲染对" "$(grep -m1 'review-scope' "$f")"; fi
for s in '没输出、退出码不是 0、第一行不是上面两种' '全量轮里不存在「修复范围以外」' '**交人记录**：不打回' '只剩建议时判通过'; do
    has "$TMP/out-present/review.md" "$s" && ok "收敛段有「$s」" || bad "收敛段缺「$s」"
done

echo "── 【1】真实派工脚本 ──"
P=$(make_project dispatch remote); write_config "$P" "$P/config"
for spec in "new-issue::new" "review:review:cmt"; do
    name="${spec%%:*}"; rest="${spec#*:}"; kind="${rest%%:*}"; pk="${rest#*:}"
    prompt_files_clear "$REPO_DIR" "$P/state"
    if [ "$pk" = new ]; then
        (cd "$P/project" && env -u CODING_AGENT_RELEASE_ROOT -u DISPATCH_AUTOPILOT HOME="$TMP/home" CODING_AGENT_CONFIG="$P/config" \
            bash "$REPO_DIR/scripts/dispatch-new-issue.sh" 321) >/dev/null 2>&1
        pf=$(prompt_file_of "$REPO_DIR" "$P/state" new 321)
    else
        (cd "$P/project" && env -u CODING_AGENT_RELEASE_ROOT -u DISPATCH_AUTOPILOT DISPATCH_PROMPT_KIND="$kind" HOME="$TMP/home" CODING_AGENT_CONFIG="$P/config" \
            bash "$REPO_DIR/scripts/dispatch-issue-comment.sh" 322 0) >/dev/null 2>&1
        pf=$(prompt_file_of "$REPO_DIR" "$P/state" cmt 322 0)
    fi
    if [ ! -s "$pf" ]; then bad "$name：派工脚本没写出 prompt"; continue; fi
    if [ "$name" = review ]; then
        has "$pf" "$MD_BODY" && has "$pf" "$CONVERGE_HEAD" && ok "复审派工 prompt 带 REVIEW.md 全文和收敛段" || bad "复审派工 prompt 缺段"
    else
        has "$pf" "$WORKER_LINE" && ! has "$pf" "$CONVERGE_HEAD" && ok "新 issue 派工 prompt 带自查句、不带收敛段" || bad "新 issue 派工 prompt 不对"
        has "$pf" 'git show origin/main:REVIEW.md' && ok "自查句里的读法已渲染成主干分支" || bad "自查句里没有 origin/main"
    fi
done

# ════════ 【3】修复范围脚本 ════════
echo "── 【3】修复范围脚本 ──"
G="$TMP/gh-data"; mkdir -p "$G" "$TMP/bin3"
REAL_GIT=$(command -v git)
# 假 gh：gh api [--paginate] <路径> [--jq 表达式]；数据是 $G 下的文件，fail-<键> 存在 = 这个请求失败
cat > "$TMP/bin3/gh" <<'SH'
#!/usr/bin/env bash
[ "$1" = api ] || exit 9
shift
path="" jqx=""
while [ $# -gt 0 ]; do
    case "$1" in --paginate) shift ;; --jq) jqx="$2"; shift 2 ;; *) path="$1"; shift ;; esac
done
key=$(printf '%s' "$path" | tr '/' '_')
[ ! -e "$GH_DATA/fail-$key" ] || { echo "HTTP 500" >&2; exit 1; }
f="$GH_DATA/$key.json"
[ -f "$f" ] || { echo "gh: Not Found (HTTP 404)" >&2; exit 1; }
if [ -n "$jqx" ]; then jq -r "$jqx" < "$f"; else cat "$f"; fi
SH
# git 包一层：GIT_FAIL=<子命令> 时那个子命令失败（退出码 128），其余照常
cat > "$TMP/bin3/git" <<SH
#!/usr/bin/env bash
for a in "\$@"; do
    if [ -n "\${GIT_FAIL:-}" ] && [ "\$a" = "\$GIT_FAIL" ]; then echo "fatal: injected" >&2; exit 128; fi
    case "\$a" in -*) ;; *) break ;; esac
done
exec "$REAL_GIT" "\$@"
SH
chmod +x "$TMP/bin3/gh" "$TMP/bin3/git"
SCOPE="$REPO_DIR/scripts/review-scope.sh"
echo '{"login":"loop-bot"}' > "$G/user.json"

UP="$TMP/scope-up.git"; git init -q --bare "$UP"
SEED="$TMP/scope-seed"; git clone -q "$UP" "$SEED" 2>/dev/null
WT="$TMP/scope-wt"
g() { git -C "$SEED" "$@"; }
commit_file() { printf '%s\n' "$2" > "$SEED/$1"; g add -A; g commit -qm "$3"; }
lines() { local i; for i in $(seq 1 "$1"); do echo "line $i"; done; }
lines 10 > "$SEED/a.txt"; lines 10 > "$SEED/b.txt"; g add -A; g commit -qm base; g push -q origin HEAD:main

# PR 的提交推到 refs/pull/<N>/head；PR 接口返回最新提交与目标分支
set_pr() {   # <N> <提交> [目标分支]
    g push -q -f origin "$2:refs/pull/$1/head"
    jq -n --arg h "$(g rev-parse "$2")" --arg b "${3:-main}" '{head: {sha: $h}, base: {ref: $b}}' > "$G/repos_o_r_pulls_$1.json"
}
# 结论评论：<N> <提交 / 原样标记行>；第二个参数是 40 位提交号就写成代码基线标记
review_comments() {   # <N> <标记行>...
    local n="$1"; shift
    local arr='[]' m i=1
    for m in "$@"; do
        arr=$(jq -c --arg b "<!-- codex-review-round:$i -->"$'\n'"$m"$'\n'"## ❌ 复审未通过" --argjson id "$((1000 + i))" \
            '. + [{id: $id, user: {login: "loop-bot"}, body: $b}]' <<<"$arr")
        i=$((i + 1))
    done
    # 别的账号发的、带着另一个基线的评论：不算
    arr=$(jq -c '. + [{id: 9, user: {login: "someone"}, body: "<!-- codex-review-round:9 -->\n<!-- review-baseline: code head=0000000000000000000000000000000000000000 base=main -->"}]' <<<"$arr")
    printf '%s\n' "$arr" > "$G/repos_o_r_issues_${n}_comments.json"
}
code_mark() { printf '<!-- review-baseline: code head=%s base=%s -->' "$(g rev-parse "$1")" "${2:-main}"; }
run_scope() {   # <参数>...：在 worktree 里跑，打印第一行，差异存进 $TMP/scope-out
    rm -rf "$WT"; git clone -q "$UP" "$WT" 2>/dev/null
    (cd "$WT" && PATH="$TMP/bin3:$PATH" GH_DATA="$G" bash "$SCOPE" --repo o/r "$@") > "$TMP/scope-out" 2>/dev/null
    echo "rc=$? $(head -1 "$TMP/scope-out")"
}

# PR 1：在 a.txt 上改了第 2 行（上轮审过的提交 P1），之后的情形各自从这里长
g checkout -qb pr1 main
sed -i 's/^line 2$/line 2 pr/' "$SEED/a.txt"; g commit -qam "pr: a2"; P1=$(g rev-parse HEAD)

# 行 1：首轮
set_pr 1 "$P1"; review_comments 1 "$(code_mark "$P1")"
check "代码 1：最近人工动作后的第 1 轮 → full first-round" "$(run_scope pr 1 --round 1)" "rc=0 full first-round"
# 行 2：读评论失败
touch "$G/fail-repos_o_r_issues_1_comments"
check "代码 2：读评论失败 → full read-failed" "$(run_scope pr 1 --round 2)" "rc=0 full read-failed"
rm -f "$G/fail-repos_o_r_issues_1_comments"
touch "$G/fail-repos_o_r_pulls_1"
check "代码 2：读 PR 失败 → full read-failed" "$(run_scope pr 1 --round 2)" "rc=0 full read-failed"
rm -f "$G/fail-repos_o_r_pulls_1"
# 行 3：最新一条结论没有基线标记 / 标记格式不符（更早那条有标记也不认）
review_comments 1 "$(code_mark "$P1")" "（没有基线标记）"
check "代码 3：最新结论没有基线标记 → full no-baseline" "$(run_scope pr 1 --round 2)" "rc=0 full no-baseline"
review_comments 1 "<!-- review-baseline: code head=$(g rev-parse --short "$P1") base=main -->"
check "代码 3：标记格式不符 → full no-baseline" "$(run_scope pr 1 --round 2)" "rc=0 full no-baseline"
printf '[{"id":9,"user":{"login":"someone"},"body":"<!-- codex-review-round:1 -->\\n%s"}]\n' "$(code_mark "$P1")" > "$G/repos_o_r_issues_1_comments.json"
check "代码 3：只有别的账号的结论 → full no-baseline" "$(run_scope pr 1 --round 2)" "rc=0 full no-baseline"
# 行 4：改投分支
review_comments 1 "$(code_mark "$P1" release)"
check "代码 4：目标分支与标记不同 → full base-changed" "$(run_scope pr 1 --round 2)" "rc=0 full base-changed"
# 行 5：上轮审过的提交取不到 / 拉取失败
review_comments 1 "<!-- review-baseline: code head=1234567890123456789012345678901234567890 base=main -->"
check "代码 5：上轮审过的提交取不到 → full baseline-missing" "$(run_scope pr 1 --round 2)" "rc=0 full baseline-missing"
review_comments 1 "$(code_mark "$P1")"
check "代码 5：拉取失败 → full baseline-missing" "$(GIT_FAIL=fetch run_scope pr 1 --round 2)" "rc=0 full baseline-missing"
# 行 6：强推（上轮的提交不在本轮历史里）
g checkout -q -b pr1-rewritten main; sed -i 's/^line 2$/line 2 rewritten/' "$SEED/a.txt"; g commit -qam rewritten
set_pr 1 pr1-rewritten
check "代码 6：变基 / 强推 → full history-rewritten" "$(run_scope pr 1 --round 2)" "rc=0 full history-rewritten"
# 行 7：分叉点算不出（目标分支和 PR 没有共同祖先）
g checkout -q --orphan unrelated; g rm -rqf . ; echo z > "$SEED/z.txt"; g add -A; g commit -qm unrelated; g push -q origin HEAD:unrelated
set_pr 1 "$P1" unrelated; review_comments 1 "$(code_mark "$P1" unrelated)"
check "代码 7：分叉点算不出 → full read-failed" "$(run_scope pr 1 --round 2)" "rc=0 full read-failed"
# 行 9、10：合成出别的错、比较失败
set_pr 1 "$P1"; review_comments 1 "$(code_mark "$P1")"
check "代码 9：合成出错 → full read-failed" "$(GIT_FAIL=merge-tree run_scope pr 1 --round 2)" "rc=0 full read-failed"
check "代码 10：比较失败 → full read-failed" "$(GIT_FAIL=diff run_scope pr 1 --round 2)" "rc=0 full read-failed"
# 行 11：没有新提交
check "代码 11：没有新提交 → scope 0" "$(run_scope pr 1 --round 2)" "rc=0 scope 0"
[ "$(wc -l < "$TMP/scope-out")" = 1 ] && ok "代码 11：scope 0 后面没有差异" || bad "代码 11：scope 0 后面还有内容"
# 行 11：只同步了主干——主干改了 PR 也改的同一个文件（另一处）
g checkout -q main; sed -i 's/^line 9$/line 9 main/' "$SEED/a.txt"; g commit -qam "main: a9"; g push -q origin HEAD:main
g checkout -q pr1; g merge -q --no-edit main >/dev/null; set_pr 1 pr1
check "代码 11：只合入主干（同一文件另一处）→ scope 0" "$(run_scope pr 1 --round 2)" "rc=0 scope 0"
# 行 12：同步主干之后在同一文件实改一行 → 只列这一行
sed -i 's/^line 5$/line 5 fix/' "$SEED/a.txt"; g commit -qam "fix: a5"; set_pr 1 pr1
check "代码 12：同步主干后实改一行 → scope 1" "$(run_scope pr 1 --round 2)" "rc=0 scope 1"
if grep -q '^+line 5 fix$' "$TMP/scope-out" && grep -q '^-line 5$' "$TMP/scope-out" \
   && ! grep -q 'line 9 main' "$TMP/scope-out" && [ "$(grep -c '^[-+][^-+]' "$TMP/scope-out")" = 2 ]; then
    ok "代码 12：差异只有修复的那一行，主干带进来的不在里面"
else bad "代码 12：差异不对" "$(cat "$TMP/scope-out")"; fi
# 目标是纯 issue、结论评论发在 issue 上：--on
cp "$G/repos_o_r_issues_1_comments.json" "$G/repos_o_r_issues_77_comments.json"; echo '[]' > "$G/repos_o_r_issues_1_comments.json"
check "代码：结论评论在 issue 上（--on）→ 照样找到基线" "$(run_scope pr 1 --round 2 --on 77)" "rc=0 scope 1"
# 行 8：PR 与主干改同一行，PR 本轮手工解决冲突
g checkout -q -b pr2 main; sed -i 's/^line 3$/line 3 pr/' "$SEED/b.txt"; g commit -qam "pr2: b3"; P2=$(g rev-parse HEAD)
set_pr 2 "$P2"; review_comments 2 "$(code_mark "$P2")"
g checkout -q main; sed -i 's/^line 3$/line 3 main/' "$SEED/b.txt"; g commit -qam "main: b3"; g push -q origin HEAD:main
g checkout -q pr2; g merge -q --no-edit main >/dev/null 2>&1
sed -i -e '/^<<<<<<<\|^=======\|^>>>>>>>/d' -e '/^line 3 main$/d' "$SEED/b.txt"; g commit -qam "resolve" >/dev/null 2>&1
set_pr 2 pr2
check "代码 8：PR 手工解决了与主干的冲突 → full merge-conflict" "$(run_scope pr 2 --round 3)" "rc=0 full merge-conflict"

# 用法错误：退出码 2，不输出结论
out=$(cd "$WT" && PATH="$TMP/bin3:$PATH" GH_DATA="$G" bash "$SCOPE" --repo o/r pr 1 2>/dev/null); rc=$?
check "用法错误（没给轮次）→ 退出码 2、没有输出" "rc=$rc out=$out" "rc=2 out="

echo "── 【3】方案 ──"
cmt() { jq -n --argjson id "$1" --arg b "$2" '{id: $id, user: {login: "loop-bot"}, body: $b}' > "$G/repos_o_r_issues_comments_$1.json"; }
cmt 501 $'## 方案 v1\n\n第一段\n第二段'
cmt 502 $'## 方案 v2\n\n第一段\n第二段改了'
FP=$(cd "$WT" && PATH="$TMP/bin3:$PATH" GH_DATA="$G" bash "$SCOPE" --repo o/r fingerprint 501 2>/dev/null)
[[ "$FP" =~ ^[0-9a-f]{64}$ ]] && ok "fingerprint 打印 64 位指纹" || bad "fingerprint 输出不对" "$FP"
plan_mark() { printf '<!-- review-baseline: plan comment=%s sha256=%s -->' "$1" "$2"; }
review_comments 9 "$(plan_mark 501 "$FP")"
check "方案 1：第 1 轮 → full first-round" "$(run_scope plan 9 --round 1 --comment 502)" "rc=0 full first-round"
review_comments 9 "（没有基线标记）"
check "方案 1：找不到上轮标记 → full no-baseline" "$(run_scope plan 9 --round 2 --comment 502)" "rc=0 full no-baseline"
touch "$G/fail-repos_o_r_issues_9_comments"
check "方案 1：读评论失败 → full read-failed" "$(run_scope plan 9 --round 2 --comment 502)" "rc=0 full read-failed"
rm -f "$G/fail-repos_o_r_issues_9_comments"
review_comments 9 "$(plan_mark 599 "$FP")"
check "方案 2：上一版评论已删除 → full deleted" "$(run_scope plan 9 --round 2 --comment 502)" "rc=0 full deleted"
review_comments 9 "$(plan_mark 501 "$(printf '%064d' 0)")"
check "方案 3：上一版被原地编辑过（指纹不同）→ full edited" "$(run_scope plan 9 --round 2 --comment 502)" "rc=0 full edited"
review_comments 9 "$(plan_mark 501 "$FP")"
check "方案 4：上一版就是本轮这条 → full same-comment" "$(run_scope plan 9 --round 2 --comment 501)" "rc=0 full same-comment"
check "方案 5：另一条新评论、指纹一致 → scope 1" "$(run_scope plan 9 --round 2 --comment 502)" "rc=0 scope 1"
if grep -q '^+第二段改了$' "$TMP/scope-out" && grep -q '^-第二段$' "$TMP/scope-out" && ! grep -q '^[-+]第一段$' "$TMP/scope-out"; then
    ok "方案 5：差异只有改动的段落"
else bad "方案 5：差异不对" "$(cat "$TMP/scope-out")"; fi

echo "通过 $pass，失败 $fail"
report_counts "$pass" "$fail"
[ "$fail" -eq 0 ]
