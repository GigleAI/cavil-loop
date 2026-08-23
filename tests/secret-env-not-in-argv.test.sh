#!/usr/bin/env bash
# 「敏感 env 不进命令行」的行为守卫（issue #745 现场发现）。
#
# 跑法：bash tests/secret-env-not-in-argv.test.sh
# 依赖：tmux。**全程隔离**：自造临时 config + 临时 STATE_DIR + 假 token + 自造
# TMUX_PREFIX，绝不读写任何真实项目的 secrets 文件（第一版就是因为拿真 config 做
# 冒烟，把假 token 写进了真的 STATE_DIR/secrets/GH_TOKEN）。
#
# 守的是什么：`-e VAR=值` 会把值写进 tmux 的 argv，而 /proc/<pid>/cmdline 是 0444
# 全局可读的，同机任何用户 `ps aux` 就能抄走 PAT。现场实测一个 classic PAT 在
# 长驻 tmux server 的命令行里挂了 11 小时。
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"

SANDBOX=$(mktemp -d)
TMP_CONF="$SANDBOX/coding-agent.config"
FAKE_TOKEN="ghp_TESTTESTTESTTESTTESTTESTTESTTEST0000"
cat > "$TMP_CONF" <<CONF
REPO="example/none"
PROJECT_ROOT="$SANDBOX/project"
WORKTREE_BASE="$SANDBOX/wt"
STATE_DIR="$SANDBOX/state"
TMUX_PREFIX="secrettest"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
WORKER_PASS_ENV="GH_TOKEN"
CONF
mkdir -p "$SANDBOX/state" "$SANDBOX/project" "$SANDBOX/wt"

export CODING_AGENT_CONFIG="$TMP_CONF"
export GH_TOKEN="$FAKE_TOKEN"
exec 8>&2
# shellcheck source=../scripts/_lib.sh
source "$REPO_DIR/scripts/_lib.sh"
exec 2>&8 8>&-
set +e

cleanup() {
    for s in $(tmux ls 2>/dev/null | awk -F: '$1 ~ /^secrettest-/ {print $1}'); do
        tmux kill-session -t "=$s" 2>/dev/null || true
    done
    rm -rf "$SANDBOX"
}
trap cleanup EXIT
cleanup

pass=0; fail=0
chk() {
    if [ "$2" = "$3" ]; then echo "  ✅ $1"; pass=$((pass+1))
    else echo "  ❌ $1 (期望 $3，实得 $2)"; fail=$((fail+1)); fi
}

echo "【1】tmux_env_args 传路径而不是值"
args=$(tmux_env_args | tr '\0' '\n')
chk "argv 里不含 token 值"        "$(echo "$args" | grep -c "$FAKE_TOKEN")" "0"
chk "argv 里有 GH_TOKEN_FILE"     "$(echo "$args" | grep -c '^GH_TOKEN_FILE=')" "1"
chk "argv 里没有裸 GH_TOKEN="     "$(echo "$args" | grep -c '^GH_TOKEN=')" "0"
chk "非敏感的 PATH 仍走原路"      "$(echo "$args" | grep -c '^PATH=')" "1"

echo "【2】secret 文件权限"
sf="$SANDBOX/state/secrets/GH_TOKEN"
chk "文件权限 600"  "$(stat -c '%a' "$sf" 2>/dev/null)" "600"
chk "目录权限 700"  "$(stat -c '%a' "$SANDBOX/state/secrets" 2>/dev/null)" "700"
chk "内容就是 token" "$(cat "$sf" 2>/dev/null)" "$FAKE_TOKEN"

echo "【3】secret_env_prefix 产出的是字面 \$(cat ...)，不是提前展开的值"
# 提前展开 = 值又回到 argv 里，整个改动白做。
pfx=$(secret_env_prefix)
chk "前缀不含 token 值"      "$(printf '%s' "$pfx" | grep -c "$FAKE_TOKEN")" "0"
chk "前缀含字面 \$(cat"      "$(printf '%s' "$pfx" | grep -cF '$(cat "$GH_TOKEN_FILE")')" "1"

echo "【4】端到端：worker 真拿得到 token，且 cmdline 里扫不到"
probe="$SANDBOX/probe.out"
CMD="$(secret_env_prefix)printf '%s' \"\$GH_TOKEN\" > $probe; sleep 30"
tmux_env=()
while IFS= read -r -d '' e; do tmux_env+=("$e"); done < <(tmux_env_args)
tmux new-session -d -s secrettest-issue901 "${tmux_env[@]}" -c "$SANDBOX" "$CMD"
# ⚠️ 轮询等待，不要写死 `sleep 2`。这台机器常年 load 两位数，固定 2s 在忙的时候
# 不够 worker 把 probe 写出来 —— 实测偶发假红一次。预算是稳定性参数：文件一出现
# 就往下走（快），忙的时候最多等 15s（稳）。真挂住的用例照样会红，不是把问题盖掉。
waited=0
while [ ! -s "$probe" ] && [ "$waited" -lt 150 ]; do
    sleep 0.1
    waited=$((waited + 1))
done
chk "worker 读到的 GH_TOKEN 正确" "$(cat "$probe" 2>/dev/null)" "$FAKE_TOKEN"

pane_pid=$(tmux list-panes -t '=secrettest-issue901' -F '#{pane_pid}' 2>/dev/null)
# ⚠️ 用 bash 内建 [[ == ]] 而不是 grep：`grep -q "$TOKEN"` 自己的 argv 就含 token，
# 扫到 grep 自身那个 pid 时必然命中，守卫永远红（同「pgrep watcher 匹配到自己」那类坑）。
# 内建匹配不 fork，不产生任何新 argv。
cmdline_has_token() {
    local pid="$1" line
    while IFS= read -r line; do
        if [[ "$line" == *"$FAKE_TOKEN"* ]]; then return 0; fi
    done < <(tr '\0' '\n' < "/proc/$pid/cmdline" 2>/dev/null)
    return 1
}
# 检查 tmux server + pane 进程 + pane 的所有后代——真实场景要防的就是这一族。
tmux_server_pid=$(tmux display-message -p '#{pid}' 2>/dev/null)
hit=0
for pid in $tmux_server_pid $pane_pid $(pgrep -P "$pane_pid" 2>/dev/null); do
    [ -n "$pid" ] || continue
    if cmdline_has_token "$pid"; then hit=$((hit+1)); fi
done
chk "tmux server / pane / 子进程的 cmdline 都不含 token" "$hit" "0"
# 不断言 pane cmdline 里"必须含 _FILE 路径"：sh 跑完 export 后会把最后一条命令
# **exec 掉**（真实 CMD 里那条就是 claude 本身），pane 进程于是变成 claude / sleep，
# 连路径都不在 argv 里了——比断言的还干净，但时机不稳定，不适合拿来做断言。

echo "【5】require_secret_env：变量缺失时拒绝派工"
( unset GH_TOKEN; require_secret_env >/dev/null 2>&1 )
chk "GH_TOKEN 缺失 → 返回非 0" "$?" "1"
require_secret_env >/dev/null 2>&1
chk "GH_TOKEN 存在 → 返回 0"   "$?" "0"

echo "【6】项目透传的变量里没有敏感变量时，不因 GH_TOKEN 缺失而拦下派工"
# 注意空串不算「不透传」：既有语义是 ${WORKER_PASS_ENV:-GH_TOKEN}，`:-` 对空串
# 同样取默认值。这里用一个真的不含敏感变量的取值来测交集逻辑。
( WORKER_PASS_ENV="SOME_OTHER_VAR"; unset GH_TOKEN; require_secret_env >/dev/null 2>&1 )
chk "WORKER_PASS_ENV 不含敏感变量 → 放行" "$?" "0"

echo
echo "通过 $pass / 失败 $fail"
[ "$fail" -eq 0 ]
