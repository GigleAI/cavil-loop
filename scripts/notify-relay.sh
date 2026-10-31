#!/usr/bin/env bash
# 早期的入口名（GitHub#95），GitHub#97 改名为 notify-requester-bot.sh。保留它是给发版切换
# 那一刻还拿着旧提示词的 worker 用：参数、输出、退出码全部原样转给新脚本。
set -euo pipefail
exec bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/notify-requester-bot.sh" "$@"
