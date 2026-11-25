#!/usr/bin/env bash
# kind: e2e
# 派工提示词超过单个命令行参数上限时改由 worker 从文件读；交不出去时转人工。
#
# 跑法：bash tests/prompt-argv-limit.test.sh   （约 10 秒）
# 依赖：bash、jq、git。不碰网络：假 gh / 假 tmux / 假 agent，HOME 指向临时目录。
#
# 每个 driver 都把整份提示词当成一个参数交给 CLI（`"$(cat 文件)"`）。Linux 单个参数上限 131072 字节
# （含结尾 NUL），超了 execve 失败（126，Argument list too long），程序根本起不来：2026-11-20
# GigleTutor-Web 三个 PR 的提示词涨到 136 KB，每次起会话都秒退，被 self-heal 当「会话损坏」转了人工。
#   1. 真 driver（claude / codex）拼出的命令真跑一遍：超长时参数换成一段短指令，CLI 真的起来了；
#      短指令指向一份本次独有的完整副本（和原提示词逐字节相同），写明总行数；codex 的启动标记照抄进去
#   2. 没超上限：命令和改版前逐字节一致，不留任何转交文件；上次超长留下的短指令被删掉
#   3. 写不出转交文件：返回失败，不留半截文件
#   4. 真 dispatch-pr-comment.sh：超长时起会话用短指令；转交文件写不出时不起会话、评论说明、转 pending/human
set -uo pipefail
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"

SANDBOX=$(mktemp -d)
trap '[ -n "${KEEP_SANDBOX:-}" ] && echo "SANDBOX=$SANDBOX" || rm -rf "$SANDBOX"' EXIT
mkdir -p "$SANDBOX/bin" "$SANDBOX/home" "$SANDBOX/out"
export HOME="$SANDBOX/home"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 TZ=UTC
unset CODING_AGENT_RELEASE_ROOT LABEL_AUTOPILOT LABEL_PENDING_BLOCKED GH_TOKEN WRITE_GH_TOKEN GITHUB_TOKEN
unset DISPATCH_AUTOPILOT DISPATCH_AUTOPILOT_ISSUE DISPATCH_AUTOPILOT_PR DISPATCH_PROMPT_KIND
unset DISPATCH_WORKER_AGENT DISPATCH_WORKER_MODEL DISPATCH_WORKER_MODEL_SET CAVIL_PROMPT_ARGV_MAX

pass=0; fail=0
chk() {   # <名字> <实得> <期望>
    if [ "$2" = "$3" ]; then echo "  ✅ $1"; pass=$((pass+1))
    else echo "  ❌ $1 (期望 [$3]，实得 [$2])"; fail=$((fail+1)); fi
}
yes_() { local n="$1"; shift; if "$@"; then chk "$n" yes yes; else chk "$n" no yes; fi; }
no_()  { local n="$1"; shift; if "$@"; then chk "$n" yes no; else chk "$n" no no; fi; }

# 假 agent：记下参数个数和最后一个参数（提示词）。codex 的 --help 给出 --no-daemon，命令形状不随本机版本变
for a in claude codex; do
    cat > "$SANDBOX/bin/$a" <<'SH'
#!/usr/bin/env bash
if [ "${1:-}" = --help ]; then echo "      --no-daemon"; exit 0; fi
printf '%s' "${@: -1}" > "${FAKE_OUT:?}/last"
exit 0
SH
done
chmod +x "$SANDBOX/bin/claude" "$SANDBOX/bin/codex"

# 一份超过 131072 字节的提示词（多字节字符：上限按字节算，不按字符）
big_prompt() {   # <文件>
    local i
    {
        echo "# 派工提示词"
        for i in $(seq 1 2400); do echo "第 $i 行：中文内容按字节算，一个字三个字节，凑够长度。"; done
        printf '最后一行没有换行'
    } > "$1"
}

# 在一个独立的 shell 里加载真 _lib.sh（按配置选 driver），跑 <命令…>
lib_run() {   # <agent> <命令…>
    local agent="$1"; shift
    local d="$SANDBOX/lib-$agent"
    mkdir -p "$d/state/prompts" "$d/wt" "$d/project"
    cat > "$d/config" <<CONF
REPO="example/argv"
PROJECT_ROOT="$d/project"
WORKTREE_BASE="$d/wt"
STATE_DIR="$d/state"
TMUX_PREFIX="argvtest"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
WORKER_AGENT_DEFAULT="$agent"
CONF
    env CODING_AGENT_CONFIG="$d/config" PATH="$SANDBOX/bin:$PATH" FAKE_OUT="$SANDBOX/out" \
        bash -c 'source "$1/scripts/_lib.sh" 2>/dev/null; shift; set +e; "$@"' _ "$REPO_DIR" "$@"
}
LIBP() { printf '%s/lib-%s/state/prompts' "$SANDBOX" "$1"; }

echo "── 0. 本机确实有这个上限（不然下面「起得来」证明不了什么）──"
mkdir -p "$(LIBP claude)"
big_prompt "$(LIBP claude)/1-pr-2.md"
BIG_SIZE=$(wc -c < "$(LIBP claude)/1-pr-2.md" | tr -d ' ')
yes_ "提示词超过 131072 字节（实得 $BIG_SIZE）" test "$BIG_SIZE" -gt 131072
if [ "$(uname -s)" = Linux ]; then
    rm -f "$SANDBOX/out/last"
    env PATH="$SANDBOX/bin:$PATH" FAKE_OUT="$SANDBOX/out" \
        bash -c 'claude -n x "$(cat "$1")"' _ "$(LIBP claude)/1-pr-2.md" 2>/dev/null; rc=$?
    chk "改版前的写法：整份当参数传，程序起不来（126）" "$rc" 126
    no_ "改版前的写法：假 claude 一次都没跑" test -e "$SANDBOX/out/last"
else
    echo "  ⏭ 不是 Linux，没有单参数上限，跳过改版前写法的对照"
fi

for agent in claude codex; do
    echo "── 1. $agent：超长时参数换成短指令，程序真的起来了 ──"
    P="$(LIBP "$agent")"; mkdir -p "$P"
    big_prompt "$P/1-pr-2.md"
    if [ "$agent" = codex ]; then
        printf '\n<!-- coding-agent-launch: 0123abcd-0000-4000-8000-0123456789ab -->\n' >> "$P/1-pr-2.md"
    fi
    cmd="$(lib_run "$agent" agent_launch_command "$SANDBOX/lib-$agent/wt" "issue1" "$P/1-pr-2.md")"; rc=$?
    chk "$agent：拼命令成功" "$rc" 0
    yes_ "$agent：命令读的是短指令文件" grep -qF "$P/1-pr-2.md.argv.md" <<<"$cmd"
    rm -f "$SANDBOX/out/last"
    env PATH="$SANDBOX/bin:$PATH" FAKE_OUT="$SANDBOX/out" bash -c "$cmd" 2>/dev/null; rc=$?
    chk "$agent：命令真跑，程序起来了" "$rc" 0
    yes_ "$agent：程序收到了提示词参数" test -s "$SANDBOX/out/last"
    got="$(cat "$SANDBOX/out/last")"
    chk "$agent：收到的参数就是短指令全文" "$got" "$(cat "$P/1-pr-2.md.argv.md")"
    yes_ "$agent：短指令远小于上限" test "$(printf '%s' "$got" | wc -c)" -lt 4096
    full="$(grep -o "$P/1-pr-2.md.full-[0-9a-f-]*\.md" <<<"$got" | head -1)"
    yes_ "$agent：短指令写明了完整副本的路径" test -n "$full"
    yes_ "$agent：完整副本和原提示词逐字节相同" cmp -s "$full" "$P/1-pr-2.md"
    lines="$(awk 'END { print NR }' "$P/1-pr-2.md")"
    yes_ "$agent：短指令写明读到第 $lines 行（最后一行）" grep -qF "第 $lines 行" <<<"$got"
    chk "$agent：回捞会话拿短指令当本次原文" \
        "$(lib_run "$agent" agent_prompt_argv_used "$P/1-pr-2.md")" "$P/1-pr-2.md.argv.md"
    if [ "$agent" = codex ]; then
        chk "codex：启动标记照抄进短指令" \
            "$(lib_run codex agent_session_prompt_tag "$P/1-pr-2.md.argv.md")" "0123abcd-0000-4000-8000-0123456789ab"
    fi
    # 再启动一次：副本是新的一份（下一次派工覆盖原文件时，前一个 worker 手里的副本不变）
    lib_run "$agent" agent_launch_command "$SANDBOX/lib-$agent/wt" "issue1" "$P/1-pr-2.md" > /dev/null
    chk "$agent：每次启动一份独有的副本" "$(ls "$P" | grep -c '\.full-')" 2

    echo "── 2. $agent：没超上限，命令和改版前逐字节一致 ──"
    printf '小提示词\n第二行\n' > "$P/1-pr-2.md"
    cmd="$(lib_run "$agent" agent_launch_command "$SANDBOX/lib-$agent/wt" "issue1" "$P/1-pr-2.md")"
    want="$(lib_run "$agent" agent_command_new "$SANDBOX/lib-$agent/wt" "issue1" "$P/1-pr-2.md")"
    chk "$agent：命令和 driver 直接拼的一样" "$cmd" "$want"
    no_ "$agent：上次超长留下的短指令删掉了" test -e "$P/1-pr-2.md.argv.md"
    chk "$agent：回捞会话拿原提示词比对" \
        "$(lib_run "$agent" agent_prompt_argv_used "$P/1-pr-2.md")" "$P/1-pr-2.md"
    rm -f "$SANDBOX/out/last"
    env PATH="$SANDBOX/bin:$PATH" FAKE_OUT="$SANDBOX/out" bash -c "$cmd"
    chk "$agent：程序收到的是原提示词" "$(cat "$SANDBOX/out/last")" "$(printf '小提示词\n第二行')"
done

echo "── 2b. 上限正好等于提示词大小：照旧整份传 ──"
P="$(LIBP claude)"
head -c 1000 /dev/zero | tr '\0' 'a' > "$P/5-new.md"
cmd="$(CAVIL_PROMPT_ARGV_MAX=1000 lib_run claude agent_launch_command "$SANDBOX/lib-claude/wt" "issue5" "$P/5-new.md")"
yes_ "1000 字节、上限 1000：读原文件" grep -qF "\"\$(cat $P/5-new.md)\"" <<<"$cmd"
cmd="$(CAVIL_PROMPT_ARGV_MAX=999 lib_run claude agent_launch_command "$SANDBOX/lib-claude/wt" "issue5" "$P/5-new.md")"
yes_ "1000 字节、上限 999：读短指令" grep -qF "$P/5-new.md.argv.md" <<<"$cmd"
cmd="$(CAVIL_PROMPT_ARGV_MAX=999999 lib_run claude agent_launch_command "$SANDBOX/lib-claude/wt" "issue5" "$P/5-new.md")"
yes_ "测试上限超出范围按真机上限算（1000 字节照旧整份传）" grep -qF "\"\$(cat $P/5-new.md)\"" <<<"$cmd"

echo "── 3. 写不出转交文件：失败，不留半截文件 ──"
P="$(LIBP claude)"; rm -f "$P"/*
big_prompt "$P/3-new.md"
chmod 500 "$P"
if [ -w "$P" ]; then
    echo "  ⏭ 以 root 跑，目录权限挡不住写入，跳过这一组"
else
    cmd="$(lib_run claude agent_launch_command "$SANDBOX/lib-claude/wt" "issue3" "$P/3-new.md")"; rc=$?
    chk "返回失败" "$rc" 1
    chk "没有输出命令" "$cmd" ""
    chmod 700 "$P"
    chk "目录里只有原提示词" "$(ls "$P" | tr '\n' ' ')" "3-new.md "
fi
chmod 700 "$P"
cmd="$(lib_run claude agent_launch_command "$SANDBOX/lib-claude/wt" "issue3" "$P/nope.md")"; rc=$?
chk "提示词文件不存在：返回失败" "$rc" 1

# ── 4. 真 dispatch-pr-comment.sh ──
# 假 gh：标题、PR 信息给固定答案，每次调用记一行；假 tmux：new-session 记一行，会话一律「不在」
export FAKE_ITEM_LABELS_LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/fake_item_labels.sh"
cat > "$SANDBOX/bin/gh" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${FAKE_LOG:?}/gh.log"
# 派工先读条目、认领、读回（GitHub#700）：单条读取和标签增删按状态回答
[ -z "${FAKE_ITEM_LABELS_LIB:-}" ] || FAKE_ITEM_DIR="${FAKE_ITEM_DIR:-$FAKE_LOG/items}" . "$FAKE_ITEM_LABELS_LIB" "$@"
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
# 假 cp：FAKE_CP_FAIL_FULL 设了时，写转交副本（*.full-*.md）一律失败，其余照常
cat > "$SANDBOX/bin/cp" <<'SH'
#!/usr/bin/env bash
if [ -n "${FAKE_CP_FAIL_FULL:-}" ]; then
    for a in "$@"; do case "$a" in *.full-*.md) echo "cp: 假失败" >&2; exit 1 ;; esac; done
fi
exec /bin/cp "$@"
SH
chmod +x "$SANDBOX/bin/gh" "$SANDBOX/bin/tmux" "$SANDBOX/bin/cp"

git init -q --bare -b main "$SANDBOX/up.git"
git clone -q "$SANDBOX/up.git" "$SANDBOX/seed" 2>/dev/null
(cd "$SANDBOX/seed" && git -c user.email=t@example.invalid -c user.name=t commit -q --allow-empty -m init \
    && git push -q origin HEAD:main HEAD:refs/pull/48/head) >/dev/null 2>&1

N=41; PR=48
setup() {
    W="$SANDBOX/w-$1"; rm -rf "$W"; mkdir -p "$W/state" "$W/wt" "$W/log"
    git clone -q "$SANDBOX/up.git" "$W/project" 2>/dev/null
    cat > "$W/config" <<CONF
REPO="example/argv"
PROJECT_ROOT="$W/project"
WORKTREE_BASE="$W/wt"
STATE_DIR="$W/state"
TMUX_PREFIX="argvtest"
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
run_pr() {   # <额外环境…>
    (cd "$W/project" && env FAKE_LOG="$W/log" FAKE_OUT="$SANDBOX/out" CODING_AGENT_CONFIG="$W/config" \
        PATH="$SANDBOX/bin:$PATH" "$@" \
        timeout 120 bash "$REPO_DIR/scripts/dispatch-pr-comment.sh" "$PR" "feature/issue-$N" 0) \
        > "$W/log/out" 2>&1
}

echo "── 4a. 派工脚本：提示词超过上限 → 起会话用短指令 ──"
setup ok
run_pr CAVIL_PROMPT_ARGV_MAX=2000; rc=$?
chk "派工成功" "$rc" 0
yes_ "起了会话" grep -q '^new-session' "$W/log/tmux.log"
yes_ "会话命令读的是短指令" grep -qF "$W/state/prompts/$N-pr-$PR.md.argv.md" "$W/log/tmux.log"
yes_ "完整副本在状态目录里、和提示词相同" \
    bash -c 'cmp -s "$1"/'"$N-pr-$PR"'.md.full-*.md "$1/'"$N-pr-$PR"'.md"' _ "$W/state/prompts"
yes_ "翻到了 doing/agent" grep -q 'doing/agent' "$W/log/gh.log"
no_ "没有转人工" grep -q 'pending/human' "$W/log/gh.log"
yes_ "poll.log 记下了改走文件" grep -q '超过单个命令行参数上限 2000：改为让 worker 从' "$W/state/poll.log"

echo "── 4b. 派工脚本：没超上限 → 照旧整份传 ──"
setup small
run_pr; rc=$?
chk "派工成功" "$rc" 0
yes_ "会话命令读的是原提示词" grep -qF "\$(cat $W/state/prompts/$N-pr-$PR.md)" "$W/log/tmux.log"
chk "提示词目录只有原提示词" "$(ls "$W/state/prompts" | tr '\n' ' ')" "$N-pr-$PR.md "

echo "── 4c. 派工脚本：转交文件写不出 → 不起会话，评论说明，转 pending/human ──"
setup refuse
run_pr CAVIL_PROMPT_ARGV_MAX=2000 FAKE_CP_FAIL_FULL=1; rc=$?
chk "派工脚本正常退出（不进重试计数）" "$rc" 0
no_ "没起会话" grep -sq '^new-session' "$W/log/tmux.log"
yes_ "发了转人工说明评论" grep -q "issues/$PR/comments" "$W/log/gh.log"
yes_ "评论写明提示词太长" grep -q '提示词太长' "$W/log/gh.log"
yes_ "加了 pending/human" grep -q 'pending/human' "$W/log/gh.log"
no_ "没翻 doing/agent" grep -q 'labels\[\]=doing/agent' "$W/log/gh.log"
yes_ "poll.log 写明了原因" grep -q '写不出转交文件' "$W/state/poll.log"
no_ "没留下半截副本" bash -c 'ls "$1" | grep -q "\.full-"' _ "$W/state/prompts"

report_counts "$pass" "$fail"
echo
if [ "$fail" -eq 0 ]; then echo "全部通过（$pass 项）"; exit 0; fi
echo "失败 $fail 项（通过 $pass 项）"; exit 1
