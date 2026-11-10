#!/usr/bin/env bash
# 发布一个文件，打印拿它的地址。
#
# 用法: publish-asset.sh <project-key> <file> [subdir]
#   subdir 默认 weekly-report。文件名自动加 -rev-<纳秒>：GitHub camo 按源 URL
#   缓存约一年，复用同名会把旧版本钉死（见 AGENTS.md「评论配图标准」）。
#
# 图片 / 视频 → 公网资产目录，校验公网可达，打印公网 URL。
# 其他类型（PDF 等）→ **不进公网资产目录**（公网只放行图片和视频，见 scripts/public-assets/）：
#   放进不公开的目录；项目配置里设了 WEEKLY_REPORT_PRIVATE_ASSET_ROOT_URL（只在内网可达的
#   地址前缀）就校验并打印那个 URL，没设就打印本机路径。
# 发布前先过 scripts/public-assets/check.mjs：内容里有凭证样式的文件一律拒绝。
#
# 打印到 stdout 的只有最终地址，方便 URL=$(publish-asset.sh ...) 直接取。
set -euo pipefail

PROJECT="${1:?用法: publish-asset.sh <project-key> <file> [subdir]}"
FILE="${2:?缺文件}"
SUBDIR="${3:-weekly-report}"
[ -f "$FILE" ] || { echo "找不到文件 $FILE" >&2; exit 1; }

# shellcheck source=../_names.sh
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../_names.sh"
CONF="$(cavil_project_env "$PROJECT")"
[ -f "$CONF" ] || { echo "找不到项目配置 $CONF" >&2; exit 1; }
# shellcheck disable=SC1090
set -a; . "$CONF"; set +a

HERE="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
CHECK="$HERE/../public-assets/check.mjs"

BASE="$(basename "$FILE")"
EXT="${BASE##*.}"
STEM="${BASE%.*}"
REV="$(date +%s%N | tail -c 10)"
NAME="${STEM}-rev-${REV}.${EXT}"

# 发布前自查：含凭证样式就拒绝（退出码 1），原因照它的输出给。
if ! check_out="$(node "$CHECK" "$FILE" 2>&1)"; then
    echo "拒绝发布 $FILE：" >&2
    printf '%s\n' "$check_out" >&2
    exit 1
fi

if ! printf '%s\n' "$check_out" | grep -q '^拿得到 '; then
    # 不是图片 / 视频：不进公网资产目录。
    PRIV_DIR="${WEEKLY_REPORT_PRIVATE_ASSET_ROOT:-$(dirname "$(cavil_review_shots)")/private-assets}"
    PRIV_URL="${WEEKLY_REPORT_PRIVATE_ASSET_ROOT_URL:-}"
    mkdir -p "$PRIV_DIR/$SUBDIR"
    chmod 700 "$PRIV_DIR"
    cp "$FILE" "$PRIV_DIR/$SUBDIR/$NAME"
    if [ -z "$PRIV_URL" ]; then
        echo "不是图片 / 视频，没有公开发布；文件留在本机（没配 WEEKLY_REPORT_PRIVATE_ASSET_ROOT_URL）" >&2
        echo "$PRIV_DIR/$SUBDIR/$NAME"
        exit 0
    fi
    URL="$PRIV_URL/$SUBDIR/$NAME"
    code=$(curl -sk -o /dev/null -w '%{http_code}' "$URL")
    if [ "$code" != "200" ]; then
        echo "内网地址不可达（HTTP $code）：$URL" >&2
        echo "  文件已在 $PRIV_DIR/$SUBDIR/$NAME；检查 WEEKLY_REPORT_PRIVATE_ASSET_ROOT_URL 指的入口" >&2
        exit 1
    fi
    echo "不是图片 / 视频，没有公开发布；已放到只在内网可达的地址 → HTTP 200（$(du -h "$FILE" | cut -f1)）" >&2
    echo "$URL"
    exit 0
fi

ROOT_DIR="${WEEKLY_REPORT_ASSET_ROOT:-$(cavil_review_shots)}"
# 公网 URL 前缀没有默认值：主机名属于部署环境，不进这个公开仓库。在项目配置里设。
ROOT_URL="${WEEKLY_REPORT_ASSET_ROOT_URL:-}"
[ -n "$ROOT_URL" ] || {
    echo "缺 WEEKLY_REPORT_ASSET_ROOT_URL —— 配图要能被 GitHub 抓到，必须是公网可达的 URL 前缀。" >&2
    echo "在 $CONF 里设，例如：WEEKLY_REPORT_ASSET_ROOT_URL=\"https://<你的公网主机>/review-assets\"" >&2
    exit 1
}

# 目录列表由对外服务（scripts/public-assets/serve.mjs）挡：任何目录都返回 404，
# 不再靠往每个目录里放 index.html。
mkdir -p "$ROOT_DIR/$SUBDIR"
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
