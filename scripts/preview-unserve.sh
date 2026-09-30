#!/usr/bin/env bash
# 注销一个 preview：停 socket + proxy + app，解 tailscale 路由，删 conf。
# **只注销登记在调用方名下的端口**（见 _lib.sh「preview 端口与归属」）。
#
# 用法：
#   bash scripts/preview-unserve.sh --issue <N>
#       注销本项目 #N 的 preview：端口按公式算，预期主人 = 本项目 + #N + worktree_path N
#       （cleanup hook 调用时**必须**再带 --expect-worktree <hook 拿到的实际 WORKTREE>）
#   bash scripts/preview-unserve.sh --port <P> --expect-issue <N> [--expect-worktree <W>]
#       按指定端口注销（迁移旧端口、清理孤儿登记时用）；W 缺省同样取 worktree_path N
#   bash scripts/preview-unserve.sh <P>
#       过渡期兼容：项目 cleanup hook 升级前的旧调用。预期主人**只**取 cleanup-issue.sh
#       注入给 hook 的 ISSUE / WORKTREE env；缺任一个就拒绝（exit 2），不再不认主强拆
#
# 退出码：0 已注销 / 本来就没登记（幂等，清理路径上反复调不出错）
#         3 端口登记在别人名下，什么都没动
#         2 用法错误（包括缺 ISSUE / WORKTREE env 的裸端口调用——不认主的强制注销已删除）
#         4 等端口锁超时
set -euo pipefail

# cleanup-issue.sh 注入给 hook 的 env，只给过渡期的裸端口调用当预期主人用
# （在 source _lib.sh 之前取，免得被配置里的同名变量盖掉）
HOOK_ISSUE="${ISSUE:-}" HOOK_WORKTREE="${WORKTREE-__unset__}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# _lib.sh 顶部的 `exec 9>&- 2>/dev/null` 会永久吞掉 stderr；「端口属于谁、为什么不动」
# 必须让调用方（cleanup hook 的日志）看得见，所以 source 前后存还 fd 2。
exec 8>&2
# shellcheck source=_lib.sh
source "$SCRIPT_DIR/_lib.sh"
exec 2>&8 8>&-

usage() {
    sed -n '5,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
    exit 2
}

ISSUE="" PORT="" EXPECT_WT=""
if [ $# -eq 1 ] && [[ "$1" =~ ^[0-9]+$ ]]; then
    if [ -z "$HOOK_ISSUE" ] || [ "$HOOK_WORKTREE" = "__unset__" ]; then
        echo "❌ 裸端口调用 \`preview-unserve.sh $1\` 缺 ISSUE / WORKTREE env，不知道预期主人是谁，不动" >&2
        echo "   改用 --port $1 --expect-issue <N>" >&2
        exit 2
    fi
    PORT="$1" ISSUE="$HOOK_ISSUE"
    # hook 在 worktree 形状不符时会把 WORKTREE 清空：空串照样拿去比对 → 不等 → 不动
    EXPECT_WT="${HOOK_WORKTREE:-<empty>}"
    set --
fi
while [ $# -gt 0 ]; do
    case "$1" in
        --issue)           ISSUE="${2:-}"; shift 2 || usage ;;
        --port)            PORT="${2:-}"; shift 2 || usage ;;
        --expect-issue)    ISSUE="${2:-}"; shift 2 || usage ;;
        --expect-worktree) EXPECT_WT="${2:-}"; shift 2 || usage ;;
        *)
            echo "❌ 不认识的参数：$1" >&2
            usage ;;
    esac
done

[[ "$ISSUE" =~ ^[0-9]+$ ]] || usage
[ -z "$PORT" ] && PORT="$(preview_port "$ISSUE")"
[[ "$PORT" =~ ^[0-9]+$ ]] || usage
[ -z "$EXPECT_WT" ] && EXPECT_WT="$(worktree_path "$ISSUE")"

preview_with_port_lock "$PORT" preview_release_owned "$PORT" "$TMUX_PREFIX" "$ISSUE" "$EXPECT_WT"
