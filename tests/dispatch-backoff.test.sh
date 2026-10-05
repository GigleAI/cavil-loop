#!/usr/bin/env bash
# 派工失败退避 + 分支占用前置检查的行为守卫（issue #34）。
#
# 跑法：bash tests/dispatch-backoff.test.sh
# 依赖：git。不碰网络、不调真 gh、不读任何真实项目的 config——自造临时 config +
# 自造 git 沙盘仓库，所以在有真 worker 在跑的机器上跑也是安全的。
#
# 为什么要有这个文件：这两处坏掉都**不会报错**，只会变成「日志里一切正常，钱在烧」——
#   · 退避没接上 → 一条持续失败的活每轮重派，2026-09-18 实测 2.4 小时 270 次，
#     直到 GitHub 把 bot 账号封停才停下；
#   · 分支占用没挡住 → `git fetch` 被 git 拒绝（派工失败），或者更糟：
#     `git worktree add --force` 成功建出第二个签出同一分支的 worktree，
#     两个 worker 往同一个分支上提交、互相覆盖。
#
# 断言的设计原则（AGENTS.md）：fixture 必须能**分辨新旧实现**。所以：
#   · 分支匹配那组里有 `feature/issue-3` vs `feature/issue-34` 的前缀陷阱——
#     用子串匹配的实现会在这条上挂，用全等的才过；
#   · 计数器那组里有 issue-959 / pr-959 的同号不同类陷阱——共用命名空间的实现会挂；
#   · Case C 那组跑的是**真的** dispatch-pr-comment.sh，不是字符串比对。
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"

TMP_CONF=$(mktemp -d)/coding-agent.config
SANDBOX="$(dirname "$TMP_CONF")"
FAKEBIN="$SANDBOX/bin"
GH_CALLS="$SANDBOX/gh-calls.log"
mkdir -p "$SANDBOX/state" "$SANDBOX/wt" "$FAKEBIN"
: > "$GH_CALLS"

# ⚠️ 假 gh / 假 tmux 必须从**配置文件**里覆盖 PATH，不能只在调用前 export。
# _lib.sh 在 source 配置**之前**会把 ~/.hermes/node/bin:~/.local/bin:~/.cargo/bin
# 插到 PATH 最前面（daemon PATH 强化），真 gh 常年就住在 ~/.local/bin —— 于是外面
# export 的假 gh 会被真 gh 盖掉，测试会拿 REPO="example/none" 去打真网络。
# 配置是在那段之后 source 的，所以这里是唯一稳的覆盖点（_lib.sh 注释里写明了这点）。
cat > "$TMP_CONF" <<CONF
REPO="example/none"
PROJECT_ROOT="$SANDBOX/project"
WORKTREE_BASE="$SANDBOX/wt"
STATE_DIR="$SANDBOX/state"
TMUX_PREFIX="backofftest"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
LABEL_AGENT_DOING="doing/agent"
GH_CALLS="$GH_CALLS"
PATH="$FAKEBIN:\$PATH"
CONF

cat > "$FAKEBIN/gh" <<'FAKEGH'
#!/usr/bin/env bash
echo "gh $*" >> "$GH_CALLS"
exit 0
FAKEGH
cat > "$FAKEBIN/tmux" <<'FAKETMUX'
#!/usr/bin/env bash
echo "tmux $*" >> "$GH_CALLS"
# has-session 一律报「不存在」，逼 dispatch 走重建 worktree 的路径（Case C）
case "$1" in has-session) exit 1 ;; esac
exit 0
FAKETMUX
chmod +x "$FAKEBIN/gh" "$FAKEBIN/tmux"
export GH_CALLS

export CODING_AGENT_CONFIG="$TMP_CONF"
# ⚠️ 同 reap / greedy 测试：_lib.sh 顶部 `exec 9>&- 2>/dev/null` 的 2>/dev/null 是
# **永久**重定向，会吞掉调用方之后所有 stderr。source 前后自己倒一手 fd 2，否则这个
# 测试挂了会「无输出 + exit 1」没法查。
exec 8>&2
# shellcheck source=../scripts/_lib.sh
source "$REPO_DIR/scripts/_lib.sh"
exec 2>&8 8>&-
# source 顺带把 -e 带了进来；测试要自己收集失败再汇总，这里关掉。
set +e

cleanup() { [ -n "${KEEP_SANDBOX:-}" ] && { echo "SANDBOX=$SANDBOX"; return 0; }; rm -rf "$SANDBOX"; }
trap cleanup EXIT

pass=0; fail=0
chk() {
    if [ "$2" = "$3" ]; then echo "  ✅ $1"; pass=$((pass+1))
    else echo "  ❌ $1 (期望 $3，实得 $2)"; fail=$((fail+1)); fi
}
chk_has() {
    case "$2" in
        *"$3"*) echo "  ✅ $1"; pass=$((pass+1));;
        *) echo "  ❌ $1 (输出里找不到 '$3')"; echo "     实得: $2"; fail=$((fail+1));;
    esac
}

# ────────────────────────────────────────────────────────────────────────────
# 造一个真 git 沙盘：上游 + 主 checkout + 一个「占住某分支」的外部 worktree。
# 形状照抄 2026-09-18 事故现场：占用者的目录名不符合 daemon 的 issue-N 命名约定，
# daemon 完全不知道它存在。
# ────────────────────────────────────────────────────────────────────────────
GIT_SB="$SANDBOX/git"
mkdir -p "$GIT_SB"
(
    set -e
    cd "$GIT_SB"
    git init -q --bare upstream.git
    git clone -q upstream.git seed
    cd seed
    git config user.email t@example.invalid; git config user.name t
    echo hello > f.txt
    git add f.txt; git commit -qm init
    git push -q origin HEAD:main
) >/dev/null 2>&1

PROJECT="$SANDBOX/project"
git clone -q "$GIT_SB/upstream.git" "$PROJECT" >/dev/null 2>&1
git -C "$PROJECT" config user.email t@example.invalid
git -C "$PROJECT" config user.name t

# 两个本地分支：一个会被外部 worktree 占住，一个空着做对照。
# 34 / 3 这对数字是故意的：前缀陷阱。
git -C "$PROJECT" branch feature/issue-34 >/dev/null 2>&1
git -C "$PROJECT" branch feature/issue-7  >/dev/null 2>&1
HOLDER_DIR="$SANDBOX/hand-made-runner"
git -C "$PROJECT" worktree add -q "$HOLDER_DIR" feature/issue-34 >/dev/null 2>&1

echo "── branch_checked_out_elsewhere：分支占用检测 ──"
cd "$PROJECT"

if holder=$(branch_checked_out_elsewhere "feature/issue-34"); then rc=0; else rc=1; holder=""; fi
chk "被外部 worktree 签出的分支 → 命中"            "$rc"     "0"
chk "命中时报出占用者路径"                          "$holder" "$HOLDER_DIR"

if holder=$(branch_checked_out_elsewhere "feature/issue-7"); then rc=0; else rc=1; holder=""; fi
chk "没人签出的分支 → 不命中"                       "$rc"     "1"

# 前缀陷阱：`feature/issue-3` 是 `feature/issue-34` 的前缀。
# 用子串 / 前缀匹配的实现会在这条上误报命中。
if holder=$(branch_checked_out_elsewhere "feature/issue-3"); then rc=0; else rc=1; holder=""; fi
chk "前缀不算占用（issue-3 ≠ issue-34）"            "$rc"     "1"

# 反向前缀：`feature/issue-345` 以被占分支为前缀。
if holder=$(branch_checked_out_elsewhere "feature/issue-345"); then rc=0; else rc=1; holder=""; fi
chk "更长的同前缀分支不算占用（issue-345）"          "$rc"     "1"

# 自己那份不算占用（重复派工时 worktree 可能已经在了）
if holder=$(branch_checked_out_elsewhere "feature/issue-34" "$HOLDER_DIR"); then rc=0; else rc=1; holder=""; fi
chk "传入自己的路径时不算占用"                       "$rc"     "1"

# 主 checkout 自己签出的 main 也应该被查到（不是只认 worktree add 出来的）
if holder=$(branch_checked_out_elsewhere "main"); then rc=0; else rc=1; holder=""; fi
chk "主 checkout 签出的分支同样算占用"               "$rc"     "0"

echo "── git 的真实行为（钉住前置检查存在的理由）──"
out=$(git -C "$PROJECT" fetch origin "+refs/heads/main:refs/heads/feature/issue-34" 2>&1); rc=$?
chk "fetch 进被签出的分支 → 失败"                    "$([ $rc -ne 0 ] && echo yes || echo no)" "yes"
chk_has "失败原因是 refusing to fetch"               "$out" "refusing to fetch"

# 这条是前置检查真正的理由：--force 会绕过保护，建出第二个签出同一分支的 worktree。
git -C "$PROJECT" worktree add --force "$SANDBOX/dup" feature/issue-34 >/dev/null 2>&1; rc=$?
n_checkouts=$(git -C "$PROJECT" worktree list --porcelain | grep -c '^branch refs/heads/feature/issue-34$')
chk "worktree add --force 绕过保护（所以光修 fetch 不够）" "$rc" "0"
chk "  → 确实出现两个 worktree 共用一个分支"          "$n_checkouts" "2"
git -C "$PROJECT" worktree remove --force "$SANDBOX/dup" >/dev/null 2>&1

echo "── dispatch 失败计数器 ──"
dispatch_fail_reset "issue-959"; dispatch_fail_reset "pr-959"
chk "第 1 次 bump"                                   "$(dispatch_fail_bump 'issue-959')" "1"
chk "第 2 次 bump"                                   "$(dispatch_fail_bump 'issue-959')" "2"
chk "第 3 次 bump"                                   "$(dispatch_fail_bump 'issue-959')" "3"
# 同号不同类：GitHub 上 issue 和 PR 共用编号，两套计数不能互相污染。
chk "同编号的 PR 是独立计数"                          "$(dispatch_fail_bump 'pr-959')"    "1"
chk "  → issue 那边不受影响"                          "$(dispatch_fail_bump 'issue-959')" "4"
dispatch_fail_reset "issue-959"
chk "reset 之后从头数"                                "$(dispatch_fail_bump 'issue-959')" "1"
chk "  → PR 那边没被 reset 带走"                      "$(dispatch_fail_bump 'pr-959')"    "2"
# selfheal 用的是裸 issue_n，两个目录必须分开
selfheal_reset "959"; selfheal_bump "959" >/dev/null
dispatch_fail_reset "issue-959"
chk "selfheal 计数不被 dispatch reset 清掉"           "$(selfheal_bump '959')" "2"

echo "── run_git：失败原因必须落进 poll.log ──"
: > "$LOG_FILE"
# ls-remote 对一个不存在的 remote 名：在解析阶段就失败，不出网，且错误里带着参数原文。
run_git "故意失败的 git" git -C "$PROJECT" ls-remote no-such-remote-xyz >/dev/null 2>&1; rc=$?
logged=$(cat "$LOG_FILE")
chk "失败时返回非 0"                                  "$([ $rc -ne 0 ] && echo yes || echo no)" "yes"
chk_has "poll.log 里有描述"                           "$logged" "故意失败的 git失败"
chk_has "poll.log 里有 git 自己的原文"                "$logged" "no-such-remote-xyz"
# 多行 stderr 要逐行进日志，不能像旧代码那样 `| tail -2` 截断掉真正有用的那行
chk "多行错误逐行进日志"                              "$(printf '%s' "$logged" | grep -c 'fatal:')" "2"
: > "$LOG_FILE"
run_git "会成功的 git" git -C "$PROJECT" rev-parse --verify HEAD >/dev/null 2>&1
chk "成功时不写日志（不增加日常噪音）"                 "$(wc -c < "$LOG_FILE" | tr -d ' ')" "0"

# ────────────────────────────────────────────────────────────────────────────
# 端到端：跑**真的** dispatch-pr-comment.sh 走 Case C，目标分支被占住。
# 假 gh 记录所有调用，假 tmux 保证不会真起 session。
# ────────────────────────────────────────────────────────────────────────────
echo "── 端到端：Case C 撞上被占用的分支 ──"
# PR #34 的 head 分支 = feature/issue-34，正好被 $HOLDER_DIR 占着。
# 这就是 2026-09-18 事故的形状。
: > "$LOG_FILE"
before_wt=$(git -C "$PROJECT" worktree list --porcelain | grep -c '^worktree ')
out=$(cd "$PROJECT" && CODING_AGENT_CONFIG="$TMP_CONF" \
    bash "$REPO_DIR/scripts/dispatch-pr-comment.sh" 34 "feature/issue-34" 0 2>&1)
rc=$?
after_wt=$(git -C "$PROJECT" worktree list --porcelain | grep -c '^worktree ')
logged=$(cat "$LOG_FILE")

chk_has "poll.log 写明分支被占用"        "$logged" "已被另一个 worktree 签出"
chk_has "poll.log 写出占用者的路径"      "$logged" "$HOLDER_DIR"
chk "没有新建 worktree（没出现双签出）"  "$after_wt" "$before_wt"
chk "占用分支仍然只有一个 checkout"      "$(git -C "$PROJECT" worktree list --porcelain | grep -c '^branch refs/heads/feature/issue-34$')" "1"
chk_has "翻了 pending/human 标签"        "$(cat "$GH_CALLS")" "labels[]=pending/human"
# 没走 fetch：确定性失败不该再白跑一次出网
chk "没有尝试 fetch（不做注定失败的出网）" "$(printf '%s' "$logged" | grep -c 'refusing to fetch')" "0"

# 对照：分支没被占用时，同一条路径要能正常往下走（不能一刀切全挡）
: > "$LOG_FILE"; : > "$GH_CALLS"
out2=$(cd "$PROJECT" && CODING_AGENT_CONFIG="$TMP_CONF" \
    bash "$REPO_DIR/scripts/dispatch-pr-comment.sh" 7 "feature/issue-7" 0 2>&1)
logged2=$(cat "$LOG_FILE")
chk "没被占用的分支不会被误挡"           "$(printf '%s' "$logged2" | grep -c '已被另一个 worktree 签出')" "0"

# ────────────────────────────────────────────────────────────────────────────
# 端到端：跑**真的** agent-poll.sh 四轮，dispatch 每轮都失败。
#
# 这一组才是 2026-09-18 那个 bug 的正面回归。前面的计数器单测只证明「函数会数数」，
# 证明不了「agent-poll.sh 真的把它接上了」——PR #30 的教训就是测试没跨真实进程边界，
# bug 在的时候照样全绿。所以这里起真进程：真 agent-poll.sh + 真 _lib.sh + 真 flock +
# 真 jq，只有 gh / tmux / 被派工的那个 dispatch 脚本是假的。
#
# 关键断言是**派工次数停在 3**。退避没接上的话它会是 4（以及第 5、第 6……）。
# ────────────────────────────────────────────────────────────────────────────
echo "── 端到端：连续失败四轮，真 agent-poll.sh ──"

E2E="$SANDBOX/e2e"
E2E_SCRIPTS="$E2E/scripts"
mkdir -p "$E2E_SCRIPTS" "$E2E/state" "$E2E/wt" "$E2E/bin"

# scripts/ 全部软链过来 —— 跑的是仓库里真的实现，不是副本；只有被派工的那个换成
# 必定失败的桩（「dispatch 失败」是本组的 fixture，不是被测对象）。
# scripts/ 下所有条目都要链过来，不只是 *.sh —— _lib.sh 会 source
# drivers/_common.sh，少了它 source 阶段就静默失败（stderr 是 /dev/null，
# 症状是「poll 跑完什么都没发生、退出码 0」）。prompts/ 同理照顾一下。
for f in "$REPO_DIR"/scripts/*; do
    ln -sf "$f" "$E2E_SCRIPTS/$(basename "$f")"
done
ln -sfn "$REPO_DIR/prompts" "$E2E/prompts"
DISPATCH_CALLS="$E2E/dispatch-calls.log"; : > "$DISPATCH_CALLS"
rm -f "$E2E_SCRIPTS/dispatch-new-issue.sh"
cat > "$E2E_SCRIPTS/dispatch-new-issue.sh" <<'STUB'
#!/usr/bin/env bash
echo "$*" >> "$DISPATCH_CALLS"
# 漏在 stdout 上的原因：agent-poll 应该把它捞进 poll.log
echo "fatal: refusing to fetch into branch 'refs/heads/feature/issue-50'"
exit 1
STUB
chmod +x "$E2E_SCRIPTS/dispatch-new-issue.sh"

E2E_LABELS="$E2E/labels.txt"
printf 'pending/agent\n' > "$E2E_LABELS"
E2E_GH_CALLS="$E2E/gh-calls.log"; : > "$E2E_GH_CALLS"

cat > "$E2E/bin/gh" <<'E2EGH'
#!/usr/bin/env bash
# 够用的假 gh：认得 open 快照、comment 游标、以及 label 的增删（真的改 $E2E_LABELS，
# 所以「翻了 label 之后下一轮还捡不捡得到」是被真实验证的，不是假设的）。
printf '%s\n' "$*" >> "$E2E_GH_CALLS"
JQ=""
argv=("$@")
for ((i = 0; i < ${#argv[@]}; i++)); do
    [ "${argv[i]}" = "--jq" ] && JQ="${argv[i+1]}"
done
all="$*"
emit() {
    if [ -n "$JQ" ]; then printf '%s' "$1" | jq -r "$JQ" 2>/dev/null || true
    else printf '%s' "$1"; fi
}
case "$all" in
    *"-X POST"*"/labels"*)
        for a in "${argv[@]}"; do
            case "$a" in "labels[]="*) printf '%s\n' "${a#labels[]=}" >> "$E2E_LABELS" ;; esac
        done
        emit '{}'; exit 0 ;;
    *"-X DELETE"*"/labels/"*)
        enc=""
        for a in "${argv[@]}"; do case "$a" in */labels/*) enc="${a##*/labels/}" ;; esac; done
        # 只需要还原 label 名里可能出现的 '/'（%2F）——本仓的 label 没有别的特殊字符
        dec=$(printf '%s' "$enc" | sed 's/%2[Ff]/\//g')
        grep -vxF "$dec" "$E2E_LABELS" > "$E2E_LABELS.tmp" 2>/dev/null || :
        mv "$E2E_LABELS.tmp" "$E2E_LABELS" 2>/dev/null || :
        emit '{}'; exit 0 ;;
    *"/issues/50/comments"*) emit '[]'; exit 0 ;;
    *"/pulls"*"state=open"*) emit '[[]]'; exit 0 ;;
    *"/issues"*"state=open"*)
        lbl=$(jq -R -s 'split("\n") | map(select(length > 0)) | map({name: .})' "$E2E_LABELS")
        emit "[[{\"number\":50,\"title\":\"boom\",\"updated_at\":\"2026-09-22T00:00:00Z\",\"labels\":$lbl}]]"
        exit 0 ;;
esac
# 其余（merged PR 清理、closed issue 复盘等）一律空
case "$all" in
    *--json*) emit '[]' ;;
    *) printf '' ;;
esac
exit 0
E2EGH
cat > "$E2E/bin/tmux" <<'E2ETMUX'
#!/usr/bin/env bash
case "$1" in has-session) exit 1 ;; ls) exit 0 ;; esac
exit 0
E2ETMUX
chmod +x "$E2E/bin/gh" "$E2E/bin/tmux"

E2E_CONF="$E2E/coding-agent.config"
cat > "$E2E_CONF" <<CONF
REPO="example/none"
PROJECT_ROOT="$PROJECT"
WORKTREE_BASE="$E2E/wt"
STATE_DIR="$E2E/state"
TMUX_PREFIX="backoffe2e"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
LABEL_AGENT_DOING="doing/agent"
MAX_CONCURRENT_WORKERS=1
DISPATCH_MAX_RETRIES=3
AUTO_CLEANUP_ON_MERGE="false"
PATH="$E2E/bin:\$PATH"
CONF

export DISPATCH_CALLS E2E_LABELS E2E_GH_CALLS
E2E_LOG="$E2E/state/poll.log"

labels_now() { tr '\n' ',' < "$E2E_LABELS"; }
n_dispatch()  { awk 'NF' "$DISPATCH_CALLS" 2>/dev/null | wc -l | tr -d ' '; }

for round in 1 2 3 4; do
    CODING_AGENT_CONFIG="$E2E_CONF" bash "$E2E_SCRIPTS/agent-poll.sh" >/dev/null 2>&1
    eval "R${round}_CALLS=\$(n_dispatch)"
    eval "R${round}_LABELS=\$(labels_now)"
done

chk "第 1 轮派了 1 次"                     "$R1_CALLS" "1"
chk "第 2 轮又派了 1 次（瞬时失败仍允许重试）" "$R2_CALLS" "2"
chk "第 3 轮派到上限"                       "$R3_CALLS" "3"
chk "第 4 轮不再派工（热循环被刹住）"        "$R4_CALLS" "3"
chk_has "第 1、2 轮标签没动，仍是 pending/agent" "$R2_LABELS" "pending/agent"
chk_has "到上限后翻成 pending/human"        "$R3_LABELS" "pending/human"
chk "到上限后触发 label 已被摘掉"           "$(printf '%s' "$R3_LABELS" | grep -c 'pending/agent')" "0"

e2e_log=$(cat "$E2E_LOG")
chk_has "poll.log 里带失败次数"             "$e2e_log" "第 1/3 次"
chk_has "poll.log 里带升级说明"             "$e2e_log" "连续 3 次派工失败"
# 这条是「poll.log 里能直接看出失败原因，不用翻 journal」那条验收：
# dispatch 漏在 stdout 上的 fatal 必须被捞进 poll.log
chk_has "poll.log 里有 dispatch 漏出来的原因" "$e2e_log" "refusing to fetch into branch"
# 计数在升级时清零 —— 人工重标一次应该重新拿到完整的重试次数
chk "升级后计数已清零"                      "$([ -f "$E2E/state/dispatch-fail/issue-50" ] && echo yes || echo no)" "no"

echo
echo "通过 $pass，失败 $fail"
[ "$fail" -eq 0 ]
