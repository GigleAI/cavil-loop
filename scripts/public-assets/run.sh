#!/usr/bin/env bash
# systemd 单元的入口：起公网资产目录的对外服务（serve.mjs）。
# 配置来自单元的 EnvironmentFile（PUBLIC_ASSETS_ROOT / PUBLIC_ASSETS_PORT，可选 PUBLIC_ASSETS_PREFIX）。
# systemd 用户服务的 PATH 里通常没有用户自己装的 node：配置里写 PUBLIC_ASSETS_NODE=<node 的完整路径>。
set -euo pipefail
HERE="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
exec "${PUBLIC_ASSETS_NODE:-node}" "$HERE/serve.mjs"
