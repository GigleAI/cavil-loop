#!/usr/bin/env bash
# 主 checkout 长期落后的告警（`check_checkout_staleness` + `sync_project_checkout`）。
#
# 跑法：bash tests/checkout-stale-alert.test.sh
# 依赖：git。**不碰网络**——`gh` 被换成记录调用并吐固定 JSON 的 shell 函数，
# git 那侧则是真的：临时建一个 origin 裸库 + 主 checkout，用真 commit 造落后。
#
# 为什么要有这个文件：这条链路的失效方式是**沉默**——daemon 的三条「不动工作区」
# 保护本身没错，错在它们只写 poll.log。实测过主 checkout 卡 9 天、1523 次派工全被
# 挡而毫无外部信号。所以这里盯死三件事：
#   · 阈值：到点才报，没到点不许吵（否则人会学会无视它，等于没有）；
#   · 去重：每 30 秒一个 poll 周期，重复开 issue 会把仓库刷爆；
#   · 自愈：跟上之后必须自动关，留着过期告警比不告警更伤信任。
# 另外守一条安全边界：告警 issue **不能带 pending label**，否则 daemon 会把自己
# 开的 issue 捡去派工，形成回环。
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

TMP_CONF="$TMP/coding-agent.config"
cat > "$TMP_CONF" <<CONF
REPO="acme/widget"
PROJECT_ROOT="$TMP/project"
WORKTREE_BASE="$TMP/wt"
STATE_DIR="$TMP/state"
TMUX_PREFIX="staletest"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
BASE_BRANCH="main"
CONF
mkdir -p "$TMP/state" "$TMP/wt"

export CODING_AGENT_CONFIG="$TMP_CONF"
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

# ── gh 替身：把调用原样记到 $GH_CALLS，开 issue 时吐一个号 ──
GH_CALLS="$TMP/gh-calls"
: > "$GH_CALLS"
NEXT_ISSUE=77
gh() {
    printf '%s\n' "$*" >> "$GH_CALLS"
    case "$*" in
        *"-X POST"*"/issues"*) printf '%s\n' "$NEXT_ISSUE" ;;
        *) printf '{}\n' ;;
    esac
    return 0
}

git_q() { git -C "$1" "${@:2}" >/dev/null 2>&1; }

# ── 造场景：origin 裸库 + 主 checkout，n 个 commit 的落后 ──
# 每个用例都重建，避免用例之间互相污染状态（标记文件也一起清）。
setup_repo() {  # <落后 commit 数>
    local behind="$1" i
    rm -rf "$TMP/project" "$TMP/origin" "$TMP/seed"
    rm -f "$TMP/state/checkout-stale-alert"
    : > "$GH_CALLS"

    git init -q --bare "$TMP/origin"
    git init -q "$TMP/seed"
    git_q "$TMP/seed" config user.email t@t.t
    git_q "$TMP/seed" config user.name t
    echo base > "$TMP/seed/f"
    git_q "$TMP/seed" add -A
    git_q "$TMP/seed" commit -m base
    git_q "$TMP/seed" branch -M main
    git_q "$TMP/seed" remote add origin "$TMP/origin"
    git_q "$TMP/seed" push -u origin main

    git clone -q "$TMP/origin" "$TMP/project"
    git_q "$TMP/project" config user.email t@t.t
    git_q "$TMP/project" config user.name t

    for ((i = 1; i <= behind; i++)); do
        echo "c$i" >> "$TMP/seed/f"
        git_q "$TMP/seed" commit -am "c$i"
    done
    [ "$behind" -gt 0 ] && git_q "$TMP/seed" push origin main
    git_q "$TMP/project" fetch origin main
    return 0
}

echo "▶ 阈值"

setup_repo 25
CHECKOUT_STALE_ALERT_COMMITS=20 check_checkout_staleness main "有未提交改动" >/dev/null 2>&1
chk "落后 25 ≥ 阈值 20 → 开 issue" "$(grep -c -- '-X POST' "$GH_CALLS")" "1"
chk "issue 号记进标记文件" "$(cat "$TMP/state/checkout-stale-alert" 2>/dev/null)" "77"

setup_repo 19
CHECKOUT_STALE_ALERT_COMMITS=20 check_checkout_staleness main "有未提交改动" >/dev/null 2>&1
chk "落后 19 < 阈值 20 → 不开" "$(grep -c -- '-X POST' "$GH_CALLS")" "0"

setup_repo 25
CHECKOUT_STALE_ALERT_COMMITS=0 check_checkout_staleness main "有未提交改动" >/dev/null 2>&1
chk "阈值 0 = 关掉告警" "$(grep -c -- '-X POST' "$GH_CALLS")" "0"

setup_repo 25
CHECKOUT_STALE_ALERT_COMMITS=abc check_checkout_staleness main "有未提交改动" >/dev/null 2>&1
chk "阈值非数字 → 静默跳过，不报错" "$(grep -c -- '-X POST' "$GH_CALLS")" "0"

echo "▶ 去重（poll 每 30 秒一轮，不能每轮都开）"

setup_repo 25
for _ in 1 2 3 4 5; do
    CHECKOUT_STALE_ALERT_COMMITS=20 check_checkout_staleness main "有未提交改动" >/dev/null 2>&1
done
chk "连开 5 轮只开 1 个 issue" "$(grep -c -- '-X POST' "$GH_CALLS")" "1"

echo "▶ 自愈：跟上后自动关"

setup_repo 25
CHECKOUT_STALE_ALERT_COMMITS=20 check_checkout_staleness main "有未提交改动" >/dev/null 2>&1
git_q "$TMP/project" merge --ff-only origin/main
CHECKOUT_STALE_ALERT_COMMITS=20 check_checkout_staleness main "" >/dev/null 2>&1
chk "跟上后 PATCH 关闭告警" "$(grep -c -- '-X PATCH' "$GH_CALLS")" "1"
chk "关闭时带 state=closed" "$(grep -c 'state=closed' "$GH_CALLS")" "1"
chk "标记文件已清除" "$([ -e "$TMP/state/checkout-stale-alert" ] && echo yes || echo no)" "no"

setup_repo 25
CHECKOUT_STALE_ALERT_COMMITS=20 check_checkout_staleness main "有未提交改动" >/dev/null 2>&1
git_q "$TMP/project" merge --ff-only origin/main
CHECKOUT_STALE_ALERT_COMMITS=20 check_checkout_staleness main "" >/dev/null 2>&1
CHECKOUT_STALE_ALERT_COMMITS=20 check_checkout_staleness main "" >/dev/null 2>&1
chk "已跟上时不重复 PATCH" "$(grep -c -- '-X PATCH' "$GH_CALLS")" "1"

echo "▶ 安全边界：告警 issue 不能被 daemon 捡去派工"

setup_repo 25
CHECKOUT_STALE_ALERT_COMMITS=20 check_checkout_staleness main "有未提交改动" >/dev/null 2>&1
chk "开 issue 时不带任何 label" "$(grep -c 'labels' "$GH_CALLS")" "0"

echo "▶ sync_project_checkout 的三条「不动工作区」路径都会检查"

# (1) 工作区有未提交改动
setup_repo 25
echo dirty > "$TMP/project/wip"
sync_project_checkout >/dev/null 2>&1
chk "脏工作区 → 告警" "$(grep -c -- '-X POST' "$GH_CALLS")" "1"
chk "脏工作区 → 不碰工作区（WIP 还在）" "$([ -e "$TMP/project/wip" ] && echo yes || echo no)" "yes"
chk "脏工作区 → 本地 main 没被 ff" "$(git -C "$TMP/project" rev-list --count refs/heads/main..origin/main)" "25"

# (2) 停在别的分支
setup_repo 25
git_q "$TMP/project" checkout -b feature/x
sync_project_checkout >/dev/null 2>&1
chk "停在别的分支 → 告警" "$(grep -c -- '-X POST' "$GH_CALLS")" "1"
chk "停在别的分支 → 没被切回去" "$(git -C "$TMP/project" rev-parse --abbrev-ref HEAD)" "feature/x"

# (3) 本地 base 与 origin 分叉
setup_repo 25
echo local > "$TMP/project/mine"
git_q "$TMP/project" add -A
git_q "$TMP/project" commit -m "本地独有"
sync_project_checkout >/dev/null 2>&1
chk "本地分叉 → 告警" "$(grep -c -- '-X POST' "$GH_CALLS")" "1"

# (4) 正常路径：干净 + 在 base → ff 成功，且不告警
setup_repo 25
sync_project_checkout >/dev/null 2>&1
chk "干净工作区 → ff 到最新" "$(git -C "$TMP/project" rev-list --count refs/heads/main..origin/main)" "0"
chk "ff 成功 → 不告警" "$(grep -c -- '-X POST' "$GH_CALLS")" "0"

echo "▶ 离线：fetch 失败时不判断（落后数不可信）"

setup_repo 25
echo dirty > "$TMP/project/wip"
git_q "$TMP/project" remote set-url origin "$TMP/does-not-exist"
sync_project_checkout >/dev/null 2>&1
chk "fetch 失败 → 不开 issue" "$(grep -c -- '-X POST' "$GH_CALLS")" "0"

echo
echo "通过 $pass，失败 $fail"
[ "$fail" -eq 0 ]
