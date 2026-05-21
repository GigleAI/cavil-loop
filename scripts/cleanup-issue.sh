#!/usr/bin/env bash
# 清理一个完工的 issue（PR merge 后、或想中止任务时跑）。
# 用法：
#   bash scripts/cleanup-issue.sh <issue-number> [--force]
#   bash scripts/cleanup-issue.sh <issue-number> --keep-worktree  # 只杀 session，留 worktree
#
# 步骤：
#   1. 安全检查：worker session 不在「busy 处理中」（busy 时拒绝，--force 可绕过）
#   2. 跑项目级 CLEANUP_HOOK（如果 coding-agent.config 里配了）
#      —— hook 拿到 env: ISSUE / WORKTREE / BRANCH / REPO / PROJECT_ROOT
#   3. 杀 worker tmux session
#   4. 删 worktree（除非 --keep-worktree）
#   5. 可选删本地分支（REMOVE_BRANCH=1 或 --delete-branch）
#
# 注意：**绝不删除远端分支**。远端 feature/issue-<N> 保留供 git log / 复盘 / 重 checkout。
# GitHub 的 auto-delete-branch-on-merge 由仓库 settings 控制，不归 daemon 管。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
source "$SCRIPT_DIR/_lib.sh"

ISSUE="${1:?need issue number}"
shift || true

FORCE=0
KEEP_WORKTREE=0
DELETE_BRANCH=0
for arg in "$@"; do
    case "$arg" in
        --force) FORCE=1 ;;
        --keep-worktree) KEEP_WORKTREE=1 ;;
        --delete-branch) DELETE_BRANCH=1 ;;
        *) echo "unknown flag: $arg" >&2; exit 2 ;;
    esac
done

TMUX_SESSION="$(tmux_session_name "$ISSUE")"
WORKTREE="$(worktree_path "$ISSUE")"
BRANCH="$(branch_name "$ISSUE")"

log "cleanup-issue #$ISSUE: session=$TMUX_SESSION worktree=$WORKTREE branch=$BRANCH"

# ── 1. busy 检查 ──
if tmux has-session -t "$TMUX_SESSION" 2>/dev/null && agent_is_busy "$TMUX_SESSION"; then
    if [ "$FORCE" -ne 1 ]; then
        echo "❌ session $TMUX_SESSION 还在 busy（$WORKER_AGENT 在 processing）。" >&2
        echo "   强制清理：bash $0 $ISSUE --force" >&2
        exit 1
    fi
    log "session busy 但 --force：继续"
fi

# ── 2. 项目级 cleanup hook ──
if [ -n "${CLEANUP_HOOK:-}" ]; then
    hook="$CLEANUP_HOOK"
    # 相对路径解释为相对 PROJECT_ROOT
    [ "${hook#/}" = "$hook" ] && hook="$PROJECT_ROOT/$hook"
    if [ -f "$hook" ]; then
        log "running cleanup hook: $hook"
        ISSUE="$ISSUE" WORKTREE="$WORKTREE" BRANCH="$BRANCH" REPO="$REPO" \
            PROJECT_ROOT="$PROJECT_ROOT" \
            bash "$hook" 2>&1 | sed 's/^/  [hook] /' | tee -a "$LOG_FILE" || \
            log "  ⚠️ hook 非零退出（继续 cleanup）"
    else
        log "  ⚠️ CLEANUP_HOOK=$CLEANUP_HOOK 文件不存在，跳过"
    fi
fi

# ── 3. tmux session ──
if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
    log "killing tmux session $TMUX_SESSION"
    tmux kill-session -t "$TMUX_SESSION"
fi

# ── 4. worktree ──
if [ "$KEEP_WORKTREE" -eq 0 ] && [ -d "$WORKTREE" ]; then
    log "removing worktree $WORKTREE"
    cd "$PROJECT_ROOT"
    if ! git worktree remove "$WORKTREE" 2>/dev/null; then
        log "  worktree 有未提交改动；--force 强删"
        if [ "$FORCE" -eq 1 ]; then
            git worktree remove --force "$WORKTREE" || log "  ⚠️ 强删也失败，手动处理"
        else
            echo "❌ worktree $WORKTREE 有未提交改动；--force 强删" >&2
            exit 1
        fi
    fi
    git worktree prune
fi

# ── 5. 本地分支 ──
if [ "$DELETE_BRANCH" -eq 1 ] || [ "${REMOVE_BRANCH:-0}" = "1" ]; then
    if git -C "$PROJECT_ROOT" show-ref --verify --quiet "refs/heads/$BRANCH"; then
        log "deleting local branch $BRANCH"
        git -C "$PROJECT_ROOT" branch -D "$BRANCH" 2>&1 | sed 's/^/  /' || log "  ⚠️ 分支删除失败"
    fi
fi

log "cleanup-issue #$ISSUE done"
echo "✅ cleanup #$ISSUE done"
