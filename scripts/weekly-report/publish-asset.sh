#!/usr/bin/env bash
# 早期的发布入口：发布命令已挪到 scripts/publish-asset.sh（GitHub#613，评论配图和周报共用一个），
# 这里原样转发，旧调用（publish-asset.sh <project-key> <file> [subdir]）照旧能用。
set -euo pipefail
exec bash "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../publish-asset.sh" "$@"
