#!/usr/bin/env bash
# 把一个文件发到 funnel 的公网资产目录，校验公网可达，打印 URL。
#
# 用法: publish-asset.sh <project-key> <file> [subdir]
#   subdir 默认 weekly-report。文件名自动加 -rev-<纳秒>：GitHub camo 按源 URL
#   缓存约一年，复用同名会把旧版本钉死（见 AGENTS.md「评论配图标准」）。
#
# 打印到 stdout 的只有最终 URL，方便 URL=$(publish-asset.sh ...) 直接取。
set -euo pipefail

PROJECT="${1:?用法: publish-asset.sh <project-key> <file> [subdir]}"
FILE="${2:?缺文件}"
SUBDIR="${3:-weekly-report}"
[ -f "$FILE" ] || { echo "找不到文件 $FILE" >&2; exit 1; }

CONF="$HOME/.config/coding-agent-work-loop/${PROJECT}.conf"
[ -f "$CONF" ] || { echo "找不到项目配置 $CONF" >&2; exit 1; }
# shellcheck disable=SC1090
set -a; . "$CONF"; set +a

ROOT_DIR="${WEEKLY_REPORT_ASSET_ROOT:-$HOME/.local/state/coding-agent-poll/review-shots}"
ROOT_URL="${WEEKLY_REPORT_ASSET_ROOT_URL:-https://futurelab05.mercat-delta.ts.net:8443/review-assets}"

BASE="$(basename "$FILE")"
EXT="${BASE##*.}"
STEM="${BASE%.*}"
REV="$(date +%s%N | tail -c 10)"
NAME="${STEM}-rev-${REV}.${EXT}"

mkdir -p "$ROOT_DIR/$SUBDIR"
cp "$FILE" "$ROOT_DIR/$SUBDIR/$NAME"

URL="$ROOT_URL/$SUBDIR/$NAME"
code=$(curl -sk -o /dev/null -w '%{http_code}' "$URL")
if [ "$code" != "200" ]; then
    echo "公网不可达（HTTP $code）：$URL" >&2
    echo "  tailscale funnel 没开或路径没挂，检查: sudo tailscale serve status" >&2
    exit 1
fi
echo "已发布 → HTTP 200（$(du -h "$FILE" | cut -f1)）" >&2
echo "$URL"
