#!/usr/bin/env bash
# 周报流水线：采数 → 出图 → 传图 → 开 issue。
#
# 每周一由 systemd timer coding-agent-weekly-report@<project>.timer 触发。
# 手动跑：bash run.sh <project-key> [--dry-run] [--week-of YYYY-MM-DD]
#
# 产物落在 issue 里（数据 + 两张趋势图）。issue 默认打 pending/agent，
# 由 daemon 派 worker 把数据写成大白话解读——数字机器出，人话 agent 写。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT="${1:?用法: run.sh <project-key> [--dry-run] [--week-of YYYY-MM-DD]}"; shift || true

DRY=0; WEEK_OF=""
while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run) DRY=1; shift ;;
        --week-of) WEEK_OF="$2"; shift 2 ;;
        *) echo "未知参数: $1" >&2; exit 2 ;;
    esac
done

CONF="$HOME/.config/coding-agent-work-loop/${PROJECT}.conf"
[ -f "$CONF" ] || { echo "找不到项目配置 $CONF" >&2; exit 1; }
# shellcheck disable=SC1090
set -a; . "$CONF"; set +a
: "${PROJECT_ROOT:?项目配置里缺 PROJECT_ROOT}"

# REPO 从项目配置读；没有就从 PROJECT_ROOT 的 git remote 推
REPO="${WEEKLY_REPORT_REPO:-$(git -C "$PROJECT_ROOT" remote get-url origin 2>/dev/null \
      | sed -E 's#(git@github.com:|https://github.com/)##; s#\.git$##')}"
[ -n "$REPO" ] || { echo "推不出 REPO，请在 $CONF 里设 WEEKLY_REPORT_REPO" >&2; exit 1; }

ASSET_DIR="${WEEKLY_REPORT_ASSET_DIR:-$HOME/.local/state/coding-agent-poll/review-shots/weekly-report}"
# 公网 URL 前缀没有默认值：主机名属于部署环境，不进这个公开仓库。在项目配置里设。
ASSET_URL="${WEEKLY_REPORT_ASSET_URL:-}"
[ -n "$ASSET_URL" ] || {
    echo "缺 WEEKLY_REPORT_ASSET_URL —— 配图要能被 GitHub 抓到，必须是公网可达的 URL 前缀。" >&2
    echo "在 $CONF 里设，例如：WEEKLY_REPORT_ASSET_URL=\"https://<你的公网主机>/review-assets/weekly-report\"" >&2
    exit 1
}
FONTS_DIR="${WEEKLY_REPORT_FONTS_DIR:-$PROJECT_ROOT/public/fonts}"
LABEL="${WEEKLY_REPORT_LABEL:-pending/agent}"

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
# camo 按源 URL 缓存约一年，每轮必须换新 URL，否则顶死旧图
REV="wk-$(date +%Y%m%d)-$(date +%s%N | tail -c 7)"

echo "== 1/4 采数（repo=$REPO）"
git -C "$PROJECT_ROOT" fetch origin --quiet || true
( cd "$PROJECT_ROOT" && python3 "$HERE/collect.py" --repo "$REPO" --out "$WORK/data.json" \
    ${WEEK_OF:+--week-of "$WEEK_OF"} )

echo "== 2/4 出图"
python3 "$HERE/render.py" --data "$WORK/data.json" --out-dir "$WORK" \
    --asset-url-base "$ASSET_URL" --rev "$REV" --fonts-dir "$FONTS_DIR"
for n in delivery effort; do
    node "$HERE/shot.mjs" "$PROJECT_ROOT" "$WORK/$n.html" "$WORK/$n-$REV.png"
done

echo "== 3/4 传图"
mkdir -p "$ASSET_DIR"
# 资产目录挡住目录列表：静态文件服务器（tailscale serve 的 path handler 等）
# 见到目录就会吐出可点击的文件清单，等于把历来所有截图的索引公开。放一个
# index.html，服务器就改吐它而不是清单；直链不受影响。
for d in "$ASSET_DIR" "$ASSET_DIR/.."; do
    [ -e "$d/index.html" ] || printf '<!doctype html><title>404</title>Not found.\n' > "$d/index.html"
done
cp "$WORK"/*-"$REV".png "$ASSET_DIR/"
for n in delivery effort; do
    code=$(curl -sk -o /dev/null -w '%{http_code}' "$ASSET_URL/$n-$REV.png")
    [ "$code" = "200" ] || { echo "配图公网不可达（$n → HTTP $code），中止" >&2; exit 1; }
    echo "   $ASSET_URL/$n-$REV.png → 200"
done

echo "== 4/4 出报告"
python3 "$HERE/report.py" --data "$WORK/data.json" --out "$WORK/report.md" \
    --asset-url-base "$ASSET_URL" --rev "$REV"

WEEK_START=$(python3 -c "import json;print(json.load(open('$WORK/data.json'))['target_week']['start'])")
WEEK_END=$(python3 -c "import json;print(json.load(open('$WORK/data.json'))['target_week']['end'])")
TITLE="📊 周报 ${WEEK_START} ~ ${WEEK_END}"

BODY="$WORK/body.md"
{
    cat <<'HDR'
> 本 issue 由每周一的定时任务自动生成：**数字是机器算的，解读要 agent 来写。**
>
> **@agent 你的任务**：把下面的数据写成一份「普通用户看得懂」的周报，**发一条 issue 评论 + 出一份 PDF**，
> 然后把 label 翻成 `pending/human`。
>
> **内容要求**
> 1. 开头一句话总览；每个 issue 用大白话讲清楚「解决了什么、对用户意味着什么」，不要只甩标题
> 2. 分组：已上线 / 不用写代码就闭环 / 有推进没完成（按「等谁」分：等验收合并、等拍板）/ 新提未开工
> 3. 给 3~5 条「值得注意的现象」，要有解释而不只是罗列数字
> 4. 不要显示代码文件数；不要开 PR
> 5. 趋势图直接引用下面那两张，不用重新出图
>
> **PDF 文档规范（顺序固定，不要改）**
> 1. **本周总体数据表格** —— 开篇第一屏就是数字，含环比
> 2. **总体结论与注意事项** —— **精简**，3~5 条，每条一句话结论 + 一句话解释，别铺开写
> 3. **详细展开** —— 按上面的分组逐条讲
> 4. 末尾附数据口径
>
> ⚠️ PDF 是给人看**这周干了什么**的，**不要写周报工具自身的口径修正 / 数据遗漏 / 复核过程**——
> 那类元信息留在 issue 评论里说。PDF 专心给数据和解读。
>
> **出 PDF 与发布**（脚本在 `scripts/weekly-report/`，别自己造）
> ```bash
> node topdf.mjs <项目目录> report.md report.pdf --title "标题" --subtitle "副标题"
> URL=$(bash publish-asset.sh <project-key> report.pdf)   # 自动加 rev + 校验公网 200
> ```
> 评论里把 `$URL` 作为下载链接给出来。

---

HDR
    cat "$WORK/report.md"
} > "$BODY"

if [ "$DRY" = "1" ]; then
    echo "== dry-run：不发 issue，报告在 $HOME/weekly-report-dryrun.md"
    cp "$BODY" "$HOME/weekly-report-dryrun.md"
    cp "$WORK/data.json" "$HOME/weekly-report-dryrun.json"
    exit 0
fi

URL=$(gh issue create --repo "$REPO" --title "$TITLE" --body-file "$BODY")
echo "已开 issue: $URL"
NUM="${URL##*/}"
# 打 label 走 REST：gh issue edit --add-label 走 GraphQL，bot PAT 缺 read:org 会挂
gh api -X POST "repos/$REPO/issues/$NUM/labels" -f "labels[]=$LABEL" >/dev/null
echo "已打 label: $LABEL"
