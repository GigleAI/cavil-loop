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
# 公网 URL 前缀没有默认值：主机名属于部署环境，不进这个公开仓库。在项目配置里设。
ROOT_URL="${WEEKLY_REPORT_ASSET_ROOT_URL:-}"
[ -n "$ROOT_URL" ] || {
    echo "缺 WEEKLY_REPORT_ASSET_ROOT_URL —— 附件要能被下载，必须是公网可达的 URL 前缀。" >&2
    echo "在 $CONF 里设，例如：WEEKLY_REPORT_ASSET_ROOT_URL=\"https://<你的公网主机>/review-assets\"" >&2
    exit 1
}

BASE="$(basename "$FILE")"
EXT="${BASE##*.}"
STEM="${BASE%.*}"
REV="$(date +%s%N | tail -c 10)"
NAME="${STEM}-rev-${REV}.${EXT}"

mkdir -p "$ROOT_DIR/$SUBDIR"
# 资产目录挡住目录列表：静态文件服务器（tailscale serve 的 path handler 等）
# 见到目录就会吐出可点击的文件清单，等于把历来所有截图的索引公开。放一个
# index.html，服务器就改吐它而不是清单；直链不受影响。
for d in "$ROOT_DIR" "$ROOT_DIR/$SUBDIR"; do
    [ -e "$d/index.html" ] || printf '<!doctype html><title>404</title>Not found.\n' > "$d/index.html"
done
cp "$FILE" "$ROOT_DIR/$SUBDIR/$NAME"

URL="$ROOT_URL/$SUBDIR/$NAME"
code=$(curl -sk -o /dev/null -w '%{http_code}' "$URL")
if [ "$code" != "200" ]; then
    echo "公网不可达（HTTP $code）：$URL" >&2
    echo "  公网入口没开或路径没挂（tailscale funnel 用户可查: sudo tailscale serve status）" >&2
    exit 1
fi
echo "已发布 → HTTP 200（$(du -h "$FILE" | cut -f1)）" >&2
echo "$URL"
