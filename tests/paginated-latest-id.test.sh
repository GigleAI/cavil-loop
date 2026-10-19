#!/usr/bin/env bash
# 跑法：bash tests/paginated-latest-id.test.sh
# 依赖：jq。无网络、不调真 agent（PATH 最前面放假 gh / claude / codex / opencode / agent）。
#
# 验证 GigleTutor-Web#1150 那一串空 prompt：
#   ① 取「最新评论 id」时，--paginate 下 --jq 逐页跑，超过一页就吐多行 id。
#      gh_last_id 必须永远只给一行；四个调用点不许再出现逐页取 .[-1] 的写法。
#   ② 就算 prompt 路径里混进换行 / 空格，driver 拼出来的启动命令也必须把整份
#      prompt 原样交给 agent——当时就是 `"$(cat <未加引号的路径>)"` 被换行切成两条命令，
#      agent 收到空字符串。
#
# 负对照：REPO_DIR=<旧版 checkout> bash tests/paginated-latest-id.test.sh 应当变红。
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${REPO_DIR:-$(dirname "$TEST_DIR")}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/project" "$TMP/wt" "$TMP/state" "$TMP/home" "$TMP/bin" "$TMP/pages"

write_config() {   # <agent>
    cat > "$TMP/coding-agent.config" <<CONF
REPO="example/none"
PROJECT_ROOT="$TMP/project"
WORKTREE_BASE="$TMP/wt"
STATE_DIR="$TMP/state"
TMUX_PREFIX="paginatetest"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
WORKER_AGENT="$1"
WORKER_MODEL=""
CONF
}

# 假 gh：照真 gh 的行为，--paginate + --jq 时对 $FAKE_PAGES 下每一页**分别**跑 jq。
# FAKE_GH_FAIL=1 时直接失败。
cat > "$TMP/bin/gh" <<'FAKE'
#!/usr/bin/env bash
[ "${FAKE_GH_FAIL:-0}" = 1 ] && { echo "HTTP 502" >&2; exit 1; }
expr=""; prev=""
for a in "$@"; do [ "$prev" = --jq ] && expr="$a"; prev="$a"; done
for p in $(ls "$FAKE_PAGES" | sort -n); do jq -r "$expr" "$FAKE_PAGES/$p"; done
FAKE
# 假 agent：把最后一个参数（prompt）原样写进 $FAKE_LOG。claude 的默认模型探测
# （带 -p）吐一行 init 就退。
for b in claude codex opencode agent; do
    cat > "$TMP/bin/$b" <<'FAKE'
#!/usr/bin/env bash
for a in "$@"; do [ "$a" = -p ] && [ "$(basename "$0")" = claude ] && {
    echo '{"type":"system","subtype":"init","model":"claude-opus-5-5"}'; exit 0; }; done
last=""; for a in "$@"; do last="$a"; done
printf '%s' "$last" > "$FAKE_LOG"
FAKE
done
chmod +x "$TMP/bin/"*

pass=0
fail=0
chk() {
    if [ "$2" = "$3" ]; then
        echo "  ✅ $1"
        pass=$((pass + 1))
    else
        echo "  ❌ $1 (期望 '$3'，实得 '$(printf '%s' "$2" | tr '\n' '|')')"
        fail=$((fail + 1))
    fi
}

run_lib() {   # <snippet> [args...]：在加载了 _lib.sh 的 shell 里跑
    local snippet="$1"; shift
    env -u CODING_AGENT_RELEASE_ROOT -u CAVIL_DEPLOY_ROOT HOME="$TMP/home" PATH="$TMP/bin:$PATH" CODING_AGENT_CONFIG="$TMP/coding-agent.config" \
        FAKE_PAGES="$TMP/pages" FAKE_LOG="$TMP/agent.log" \
        bash -c 'source "$1/scripts/_lib.sh" 2>/dev/null; shift; '"$snippet" _ "$REPO_DIR" "$@"
}

page() {   # <页号> <id...>：写一页评论
    local n="$1"; shift
    printf '%s\n' "$@" | jq -R 'tonumber | {id: .}' | jq -s . > "$TMP/pages/$n"
}

write_config claude

echo "① gh_last_id：分页时也只给最后一条，且只有一行"
rm -f "$TMP/pages/"*; page 1 11 12 13
chk "单页 → 该页最后一条" "$(run_lib 'gh_last_id repos/x/issues/1/comments')" "13"
rm -f "$TMP/pages/"*; page 1 101 102; page 2 201 202; page 3 301
chk "三页 → 最后一页最后一条（不是每页一行）" "$(run_lib 'gh_last_id repos/x/issues/1/comments')" "301"
rm -f "$TMP/pages/"*; echo '[]' > "$TMP/pages/1"
chk "零条评论 → 0" "$(run_lib 'gh_last_id repos/x/issues/1/comments')" "0"
chk "gh 失败 → 0" "$(FAKE_GH_FAIL=1 run_lib 'gh_last_id repos/x/issues/1/comments')" "0"

stale="$(grep -nE -- "--paginate[^|]*--jq '\.\[-1\]" "$REPO_DIR"/scripts/*.sh "$REPO_DIR"/scripts/drivers/*.sh \
    | grep -vE '^[^:]+:[0-9]+:[[:space:]]*#' | grep -v '| tail -n1' || true)"
chk "scripts/ 里没有逐页取 .[-1] 的写法" "$stale" ""

echo "② 带换行 / 空格 / 引号的 prompt 路径，agent 仍收到完整 prompt"
PROMPT="$TMP/prompt dir/coding-agent-issue-1-cmt-6248331981
6248684498 it's.md"
mkdir -p "$TMP/prompt dir"
printf '第一行\n第二行 "引号" $HOME `x`\n' > "$PROMPT"
want="$(cat "$PROMPT")"
for agent in claude codex opencode cursor; do
    write_config "$agent"
    for kind in new resume resume-id; do
        rm -f "$TMP/agent.log"
        sid=""; fn=agent_command_new
        case "$kind" in resume) fn=agent_command_resume ;; resume-id) fn=agent_command_resume; sid=0b5c2d1e-0000-4000-8000-000000000001 ;; esac
        cmd="$(WORKER_SESSION_ID="$sid" run_lib 'WORKER_SESSION_ID="$4" '"$fn"' "$1" "$2" "$3"' "$TMP/wt" issue1 "$PROMPT" "$sid")"
        (cd "$TMP/wt" && env HOME="$TMP/home" PATH="$TMP/bin:$PATH" FAKE_LOG="$TMP/agent.log" bash -c "$cmd" >/dev/null 2>&1)
        got="$(cat "$TMP/agent.log" 2>/dev/null)"
        chk "$agent $kind" "$got" "$want"
    done
done

echo
echo "通过 $pass，失败 $fail"
[ "$fail" = 0 ]
