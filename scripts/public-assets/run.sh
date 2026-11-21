#!/usr/bin/env bash
# systemd 单元的入口：起公网资产目录的对外服务（serve.mjs）。
# 配置来自单元的 EnvironmentFile（PUBLIC_ASSETS_ROOT / PUBLIC_ASSETS_PORT，可选 PUBLIC_ASSETS_PREFIX）。
# systemd 用户服务的 PATH 里通常没有用户自己装的 node：配置里写 PUBLIC_ASSETS_NODE=<node 的完整路径>。
# 严格模式（GitHub#613）用到的几个路径在这里按 _names.sh 补上默认值，服务和切换 / 发布命令看的是同一处。
set -euo pipefail
HERE="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
# shellcheck source=../_names.sh
source "$HERE/../_names.sh"
export PUBLIC_ASSETS_STATUS="${PUBLIC_ASSETS_STATUS:-$(cavil_public_assets_status)}"
export PUBLIC_ASSETS_LEGACY_LISTS="${PUBLIC_ASSETS_LEGACY_LISTS:-$(cavil_public_assets_lists)}"
export PUBLIC_ASSETS_PROJECT_DIRS="${PUBLIC_ASSETS_PROJECT_DIRS:-$(cavil_public_assets_project_dirs)}"
exec "${PUBLIC_ASSETS_NODE:-node}" "$HERE/serve.mjs"
