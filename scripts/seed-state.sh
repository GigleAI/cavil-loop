#!/usr/bin/env bash
# 首次部署时跑：seed state.json，把当前所有 open PR 的最新 comment ID 设为「已见」，
# 避免 daemon 启动后把历史评论当新评论 re-dispatch。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
source "$SCRIPT_DIR/_lib.sh"

STATE_FILE="$STATE_DIR/state.json"
seen_conv='{}'        # /issues/N/comments
seen_inline='{}'      # /pulls/N/comments (inline review comments)
seen_review='{}'      # /pulls/N/reviews
seen_issue='{}'       # /issues/N/comments on issues

echo "== seed open PR 的三种 latest-id（conversation / inline / reviews）=="
pr_numbers=$(gh pr list --repo "$REPO" --state open --json number --jq '.[].number')
for pr in $pr_numbers; do
    c=$(gh api "repos/$REPO/issues/$pr/comments"  --jq '.[-1].id // 0' 2>/dev/null || echo 0)
    i=$(gh api "repos/$REPO/pulls/$pr/comments"   --jq '.[-1].id // 0' 2>/dev/null || echo 0)
    r=$(gh api "repos/$REPO/pulls/$pr/reviews"    --jq '.[-1].id // 0' 2>/dev/null || echo 0)
    seen_conv=$(  echo "$seen_conv"   | jq ".\"$pr\" = $c")
    seen_inline=$(echo "$seen_inline" | jq ".\"$pr\" = $i")
    seen_review=$(echo "$seen_review" | jq ".\"$pr\" = $r")
    echo "  PR #$pr -> conv=$c inline=$i review=$r"
done

echo "== seed Issue latest-comment ids（避免老 issue 的历史 comment 被当新事件触发）=="
issue_numbers=$(gh issue list --repo "$REPO" --state open --json number --jq '.[].number')
for is in $issue_numbers; do
    latest=$(gh api "repos/$REPO/issues/$is/comments" --jq '.[-1].id // 0' 2>/dev/null || echo 0)
    seen_issue=$(echo "$seen_issue" | jq ".\"$is\" = $latest")
    echo "  Issue #$is -> last comment id $latest"
done

jq -n \
    --argjson c "$seen_conv" \
    --argjson i "$seen_inline" \
    --argjson r "$seen_review" \
    --argjson is "$seen_issue" \
    '{seen_comments: $c, seen_review_comments: $i, seen_reviews: $r, seen_issue_comments: $is, worker_models: {}}' \
    > "$STATE_FILE"
echo "Seeded $STATE_FILE"
