#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec 8>&2
source "$SCRIPT_DIR/_lib.sh"
exec 2>&8 8>&-
[ "${POST_MERGE_RETROSPECTIVE:-true}" = true ] || exit 0
export REPO STATE_DIR BRANCH_PREFIX PROJECT_ROOT
export BASE_BRANCH="${BASE_BRANCH:-main}"
export RETROSPECTIVE_SKILL_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
export RETROSPECTIVE_MODEL="${RETROSPECTIVE_MODEL:-sonnet}"
exec python3 "$SCRIPT_DIR/post-merge-retrospective.py" "$@"
