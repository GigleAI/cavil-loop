#!/usr/bin/env bash
# 给指定 issue 编号创建 worktree：分支 + 装依赖 + 复制 gitignored 配置文件。
# 用法：
#   scripts/create-worktree.sh <issue-number> [base-branch]
# 例：
#   scripts/create-worktree.sh 42 main
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
source "$SCRIPT_DIR/_lib.sh"

ISSUE="${1:?need issue number}"
BASE_BRANCH="${2:-main}"

BRANCH="$(branch_name "$ISSUE")"
WORKTREE_DIR="$(worktree_path "$ISSUE")"

log "create-worktree: issue=$ISSUE branch=$BRANCH dir=$WORKTREE_DIR base=$BASE_BRANCH"

cd "$PROJECT_ROOT"

# 1. 分支
if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
    log "  branch $BRANCH 已存在，复用"
elif git show-ref --verify --quiet "refs/remotes/origin/$BRANCH"; then
    log "  origin/$BRANCH 已存在，签出"
    git fetch origin "$BRANCH"
else
    # 新分支从【最新的 upstream base】切，而不是可能过时的本地 $BASE_BRANCH：
    # 先 fetch，基于 origin/$BASE_BRANCH 建分支。不碰主项目工作区（主 checkout
    # 常有未提交 WIP，绝不能 pull/reset/改 HEAD）——只更新 remote-tracking ref。
    if git fetch origin "$BASE_BRANCH" --quiet 2>/dev/null \
       && git show-ref --verify --quiet "refs/remotes/origin/$BASE_BRANCH"; then
        log "  新建分支 $BRANCH ← origin/$BASE_BRANCH（已 fetch 取最新）"
        git branch "$BRANCH" "origin/$BASE_BRANCH"
    else
        log "  ⚠️ 取不到 origin/$BASE_BRANCH，回退本地 $BASE_BRANCH"
        git branch "$BRANCH" "$BASE_BRANCH"
    fi
fi

# 2. worktree
if [ -d "$WORKTREE_DIR" ]; then
    log "  worktree 目录已存在：${WORKTREE_DIR}（跳过创建）"
else
    mkdir -p "$WORKTREE_BASE"
    git worktree add "$WORKTREE_DIR" "$BRANCH"
fi

# 3a. 给 worktree 设独立的 git 身份（worker commit 用 bot 而非 user）
if [ -n "${WORKTREE_GIT_USER_NAME:-}" ] || [ -n "${WORKTREE_GIT_USER_EMAIL:-}" ]; then
    [ -n "${WORKTREE_GIT_USER_NAME:-}" ] && git -C "$WORKTREE_DIR" config user.name "$WORKTREE_GIT_USER_NAME"
    [ -n "${WORKTREE_GIT_USER_EMAIL:-}" ] && git -C "$WORKTREE_DIR" config user.email "$WORKTREE_GIT_USER_EMAIL"
    log "  worker identity: $(git -C "$WORKTREE_DIR" config user.name) <$(git -C "$WORKTREE_DIR" config user.email)>"
fi

# 3b. 复制 COPY_TO_WORKTREE 列出的本地配置（默认含 .env 和 .claude/settings.local.json）
for rel in ${COPY_TO_WORKTREE:-}; do
    src="$PROJECT_ROOT/$rel"
    dst="$WORKTREE_DIR/$rel"
    if [ -f "$src" ]; then
        mkdir -p "$(dirname "$dst")"
        cp "$src" "$dst"
        log "  复制 $rel"
    fi
done

# 4. 跑 setup 命令
if [ -n "${WORKTREE_SETUP_CMD:-}" ] && [ "${WORKTREE_SETUP_CMD}" != ":" ]; then
    log "  跑 WORKTREE_SETUP_CMD: $WORKTREE_SETUP_CMD"
    (cd "$WORKTREE_DIR" && eval "$WORKTREE_SETUP_CMD") || {
        log "  ⚠️ WORKTREE_SETUP_CMD 失败（继续，不阻塞）"
    }
fi

log "create-worktree done: $WORKTREE_DIR"
echo "$WORKTREE_DIR"
