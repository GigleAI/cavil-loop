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
# 复盘会 `git commit` + `git push` 到 base 分支（见 .py 里那两步），那是往仓库历史
# 里写内容，必须署写身份而不是轮询那把。push 的认证走 gh 的 credential helper，而
# 它认的就是 GH_TOKEN —— 所以整段子进程换成写 token 就够，不用把 token 选择渗进
# python。顺带它自己那几个 gh api 读也走写身份，量级可忽略（每个 merged PR 几次）。
_retro_token="$(gh_write_token)"
if [ -n "$_retro_token" ]; then
    export GH_TOKEN="$_retro_token"
fi
unset _retro_token
exec python3 "$SCRIPT_DIR/post-merge-retrospective.py" "$@"
