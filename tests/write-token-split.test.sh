#!/usr/bin/env bash
# 两把 token 的分工：轮询 / 读走 GH_TOKEN，所有写走 WRITE_GH_TOKEN（issue #36）。
#
# 跑法：bash tests/write-token-split.test.sh
# 依赖：bash + jq。**不碰网络**：`gh` 换成记录「这次调用时 GH_TOKEN 是什么」的
# shell 函数；config / STATE_DIR 全在临时目录里。
#
# 为什么要有这个文件：这条链路的失效方式是**沉默**。漏掉某处写调用，它照样成功，
# 只是署名换了个账号；把轮询那把交给 worker，也照样能干活，直到某次 push 署错名
# 才看得出来。所以断言全部落在「这一次调用用的是哪一把」，不是「调用有没有成功」。
#
# 判别力（= 退回旧实现必须变红）：
#   · gh_label_flip 里若写回裸 gh        → 【1】红（记到的是轮询 token）
#   · secret_env_file 里若去掉取值指向   → 【3】红（交接文件里是轮询 token）
#   · _lib.sh 里若去掉 export GH_TOKEN   → 【5】红（子进程读不到 config 里的裸赋值）
#   · 告警 issue 若写回裸 gh             → 【2】红
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

POLL_TOKEN="ghp_POLLPOLLPOLLPOLLPOLLPOLLPOLL000000"
WRITE_TOKEN="ghp_WRITEWRITEWRITEWRITEWRITEWRITE1111"

TMP_CONF="$TMP/coding-agent.config"
cat > "$TMP_CONF" <<CONF
REPO="acme/widget"
PROJECT_ROOT="$TMP/project"
WORKTREE_BASE="$TMP/wt"
STATE_DIR="$TMP/state"
TMUX_PREFIX="wtokentest"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
BASE_BRANCH="main"
CONF
mkdir -p "$TMP/state" "$TMP/wt" "$TMP/project"

export CODING_AGENT_CONFIG="$TMP_CONF"
export GH_TOKEN="$POLL_TOKEN"
exec 8>&2
# shellcheck source=../scripts/_lib.sh
source "$REPO_DIR/scripts/_lib.sh"
exec 2>&8 8>&-
set +e

pass=0; fail=0
chk() {
    if [ "$2" = "$3" ]; then echo "  ✅ $1"; pass=$((pass+1))
    else echo "  ❌ $1 (期望 '$3'，实得 '$2')"; fail=$((fail+1)); fi
}

# ── gh 替身：每次调用记一行「用的哪把 token + 调用是什么」 ──
GH_CALLS="$TMP/gh-calls"
gh() {
    printf '%s\t%s\n' "${GH_TOKEN:-<unset>}" "$*" >> "$GH_CALLS"
    case "$*" in
        *"-X POST"*"/issues"|*"-X POST"*"/issues "*) printf '%s\n' 4242 ;;
        *) printf '{}\n' ;;
    esac
}
# 取第 N 次调用用的 token；把值翻译成好读的名字，失败信息才看得懂。
token_of() {
    local t
    t=$(sed -n "${1}p" "$GH_CALLS" 2>/dev/null | cut -f1)
    case "$t" in
        "$POLL_TOKEN")  echo "poll" ;;
        "$WRITE_TOKEN") echo "write" ;;
        "")             echo "<无此调用>" ;;
        *)              echo "其他($t)" ;;
    esac
}
ncalls() { wc -l < "$GH_CALLS" 2>/dev/null | tr -d ' '; }

# 文件不存在时 grep -c 什么都不打印（exit 2），`|| true` 会得到空串而不是 0 ——
# 那样红的是测试自己的写法，不是被测行为。这里统一归一成数字。
warn_count() {
    local n
    [ -f "$1" ] || { echo 0; return 0; }
    n=$(grep -c 'chmod 600' "$1" 2>/dev/null)
    echo "${n:-0}"
}

WRITE_GH_TOKEN="$WRITE_TOKEN"

echo "【1】双 token：翻 label 的两次调用都走写 token"
: > "$GH_CALLS"
gh_label_flip 7 --add pending/human --remove doing/agent >/dev/null 2>&1
chk "一共两次调用（先 DELETE 后 POST）" "$(ncalls)" "2"
chk "摘 label 用写 token"  "$(token_of 1)" "write"
chk "打 label 用写 token"  "$(token_of 2)" "write"

echo "【2】双 token：daemon 自己开 / 关告警 issue 也走写 token"
: > "$GH_CALLS"
checkout_stale_alert_open main 42 "测试原因" >/dev/null 2>&1
chk "开告警 issue 用写 token" "$(token_of 1)" "write"
: > "$GH_CALLS"
checkout_stale_alert_resolve >/dev/null 2>&1
chk "关告警 issue 用写 token" "$(token_of 1)" "write"

echo "【3】双 token：读 / 轮询仍然走轮询 token，交接给 worker 的是写 token"
: > "$GH_CALLS"
run_gh_capture "读 issue" gh api "repos/$REPO/issues/1" >/dev/null 2>&1
chk "普通读用轮询 token" "$(token_of 1)" "poll"
sf="$TMP/state/secrets/GH_TOKEN"
rm -f "$sf"
secret_env_file GH_TOKEN >/dev/null
chk "交接文件里是写 token"     "$(cat "$sf" 2>/dev/null)" "$WRITE_TOKEN"
chk "交接文件里没有轮询 token" "$(grep -c "$POLL_TOKEN" "$sf" 2>/dev/null || true)" "0"

echo "【4】不配写 token → 逐项回落，与单账号时的行为一致"
unset WRITE_GH_TOKEN
: > "$GH_CALLS"
gh_label_flip 7 --add pending/human --remove doing/agent >/dev/null 2>&1
chk "翻 label 回落成轮询 token" "$(token_of 1)" "poll"
chk "（第二次同样）"            "$(token_of 2)" "poll"
rm -f "$sf"
secret_env_file GH_TOKEN >/dev/null
chk "交接文件回落成 GH_TOKEN 的值" "$(cat "$sf" 2>/dev/null)" "$POLL_TOKEN"
WRITE_GH_TOKEN="$WRITE_TOKEN"

echo "【5】config 里的裸赋值，子进程（gh / git）必须读得到"
# 这一条必须**跨真实子进程**。在当前 shell 里 echo 一下是测不出来的：systemd 部署
# 下 GH_TOKEN 早在环境里，config 里再来一次裸赋值会继承已有的 export 属性照常工作，
# 于是「不 export 也行」这个错误结论在已有安装上永远验证不出。这里用 `env -u` 把
# 两个变量都从环境里摘掉，模拟全新安装 / cron 部署。
BARE_CONF="$TMP/bare.config"
sed "s|^STATE_DIR=.*|STATE_DIR=\"$TMP/state-bare\"|" "$TMP_CONF" > "$BARE_CONF"
printf 'GH_TOKEN=%s\n' "$POLL_TOKEN" >> "$BARE_CONF"
child=$(env -u GH_TOKEN -u WRITE_GH_TOKEN CODING_AGENT_CONFIG="$BARE_CONF" \
    bash -c 'source "$0/scripts/_lib.sh"; bash -c '"'"'printf %s "${GH_TOKEN:-<空>}"'"'"'' \
    "$REPO_DIR" 2>/dev/null)
chk "config 写裸赋值时子进程读得到 token" "$child" "$POLL_TOKEN"

echo "【6】config 装着 token 却全局可读 → 每轮告警；600 则安静"
LOOSE_CONF="$TMP/loose.config"
sed "s|^STATE_DIR=.*|STATE_DIR=\"$TMP/state-loose\"|" "$TMP_CONF" > "$LOOSE_CONF"
printf 'GH_TOKEN=%s\n' "$POLL_TOKEN" >> "$LOOSE_CONF"
chmod 644 "$LOOSE_CONF"
env -u GH_TOKEN -u WRITE_GH_TOKEN CODING_AGENT_CONFIG="$LOOSE_CONF" \
    bash -c 'source "$0/scripts/_lib.sh"' "$REPO_DIR" >/dev/null 2>&1
chk "644 → poll.log 里有权限告警" \
    "$(warn_count "$TMP/state-loose/poll.log")" "1"
chmod 600 "$LOOSE_CONF"
rm -rf "$TMP/state-loose"
env -u GH_TOKEN -u WRITE_GH_TOKEN CODING_AGENT_CONFIG="$LOOSE_CONF" \
    bash -c 'source "$0/scripts/_lib.sh"' "$REPO_DIR" >/dev/null 2>&1
chk "600 → 不告警" \
    "$(warn_count "$TMP/state-loose/poll.log")" "0"
# 没装 token 的 config 不该被这条规则误伤（老安装：token 在 EnvironmentFile 里）
NOTOK_CONF="$TMP/notoken.config"
sed "s|^STATE_DIR=.*|STATE_DIR=\"$TMP/state-notok\"|" "$TMP_CONF" > "$NOTOK_CONF"
chmod 644 "$NOTOK_CONF"
GH_TOKEN="$POLL_TOKEN" CODING_AGENT_CONFIG="$NOTOK_CONF" \
    bash -c 'source "$0/scripts/_lib.sh"' "$REPO_DIR" >/dev/null 2>&1
chk "token 只在环境里、config 没写 → 不告警" \
    "$(warn_count "$TMP/state-notok/poll.log")" "0"

echo
echo "通过 $pass / 失败 $fail"
[ "$fail" -eq 0 ]
