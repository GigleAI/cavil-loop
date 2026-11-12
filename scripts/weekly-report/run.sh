#!/usr/bin/env bash
# 周报流水线：采数 → 出图 → 传图 → 开 issue。
#
# 每周一由 systemd timer cavil-loop-weekly-report@<project>.timer 触发
# （改名前装的是 coding-agent-weekly-report@<project>.timer，同样走这里）。
# 手动跑：bash run.sh <project-key> [--dry-run] [--week-of YYYY-MM-DD]
#
# 产物落在 issue 里（数据 + 四张趋势图：交付 / 投入 / 成本 / token）。issue 默认打 pending/agent，
# 由 daemon 派 worker 把数据写成大白话解读——数字机器出，人话 agent 写。
set -euo pipefail

# 新旧名字（~/.config/cavil-loop 与改名前的 coding-agent-work-loop）经 _names.sh 挑
# shellcheck source=../_names.sh
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../_names.sh"
DEPLOY_CONF="${CAVIL_DEPLOY_CONF:-$(cavil_deploy_conf)}"
[ ! -f "$DEPLOY_CONF" ] || { set -a; . "$DEPLOY_CONF"; set +a; }
DEPLOY_ROOT="${CAVIL_DEPLOY_ROOT:-$HOME/.agents/releases/cavil-loop}"
if [ -f "$DEPLOY_ROOT/.deploy.lock" ]; then exec {GLOBAL_FD}<>"$DEPLOY_ROOT/.deploy.lock"; flock -s "$GLOBAL_FD"; fi
SELF="$(readlink "/proc/$$/fd/255" 2>/dev/null || readlink -f "${BASH_SOURCE[0]}")"
SELF_DIR="$(dirname "$SELF")"
CODING_AGENT_RELEASE_ROOT="$(dirname "$(dirname "$SELF_DIR")")"
if [ "$(basename "$(dirname "$CODING_AGENT_RELEASE_ROOT")")" = releases ] && [ -f "$CODING_AGENT_RELEASE_ROOT/.inuse" ]; then
    exec {LEASE_FD}<>"$CODING_AGENT_RELEASE_ROOT/.inuse"; flock -s "$LEASE_FD"
    export CODING_AGENT_RELEASE_LEASE_FD="$LEASE_FD"
fi
[ -z "${GLOBAL_FD:-}" ] || { flock -u "$GLOBAL_FD"; eval "exec ${GLOBAL_FD}>&-"; }
export CODING_AGENT_RELEASE_ROOT

HERE="$SELF_DIR"
PROJECT="${1:?用法: run.sh <project-key> [--dry-run] [--week-of YYYY-MM-DD]}"; shift || true

DRY=0; WEEK_OF=""
while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run) DRY=1; shift ;;
        --week-of) WEEK_OF="$2"; shift 2 ;;
        *) echo "未知参数: $1" >&2; exit 2 ;;
    esac
done

CONF="$(cavil_project_env "$PROJECT")"
[ -f "$CONF" ] || { echo "找不到项目配置 $CONF" >&2; exit 1; }
# shellcheck disable=SC1090
set -a; . "$CONF"; set +a
: "${PROJECT_ROOT:?项目配置里缺 PROJECT_ROOT}"

# REPO 从项目配置读；没有就从 PROJECT_ROOT 的 git remote 推
REPO="${WEEKLY_REPORT_REPO:-$(git -C "$PROJECT_ROOT" remote get-url origin 2>/dev/null \
      | sed -E 's#(git@github.com:|https://github.com/)##; s#\.git$##')}"
[ -n "$REPO" ] || { echo "推不出 REPO，请在 $CONF 里设 WEEKLY_REPORT_REPO" >&2; exit 1; }

ASSET_DIR="${WEEKLY_REPORT_ASSET_DIR:-$(cavil_review_shots)/weekly-report}"
# 公网 URL 前缀没有默认值：主机名属于部署环境，不进这个公开仓库。在项目配置里设。
ASSET_URL="${WEEKLY_REPORT_ASSET_URL:-}"
[ -n "$ASSET_URL" ] || {
    echo "缺 WEEKLY_REPORT_ASSET_URL —— 配图要能被 GitHub 抓到，必须是公网可达的 URL 前缀。" >&2
    echo "在 $CONF 里设，例如：WEEKLY_REPORT_ASSET_URL=\"https://<你的公网主机>/review-assets/weekly-report\"" >&2
    exit 1
}
# 矢量版图表放哪：本机、不公开。topdf.mjs 按同一条规则找（见该文件 vectorDirs）。
VECTOR_DIR="${WEEKLY_REPORT_VECTOR_DIR:-$(dirname "$(cavil_review_shots)")/weekly-report-vector}"
FONTS_DIR="${WEEKLY_REPORT_FONTS_DIR:-$PROJECT_ROOT/public/fonts}"
LABEL="${WEEKLY_REPORT_LABEL:-pending/agent}"

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
# camo 按源 URL 缓存约一年，每轮必须换新 URL，否则顶死旧图
REV="wk-$(date +%Y%m%d)-$(date +%s%N | tail -c 7)"

# 再算进来的项目（GitHub#232）：本机另外几个已部署项目的实例配置名，空格或逗号分隔。
# 不配 = 只算本项目，下面走原来那条路，产物与原来逐字节相同。
EXTRA_PROJECTS="$(printf '%s' "${WEEKLY_REPORT_EXTRA_PROJECTS:-}" | tr ',' ' ' | xargs)"

if [ -z "$EXTRA_PROJECTS" ]; then
echo "== 1/4 采数（repo=${REPO}）"
git -C "$PROJECT_ROOT" fetch origin --quiet || true
# 处理时长要去本机 agent 日志里取每一轮的起止，需要知道 worktree 路径。
# 那两个值在 daemon 的配置里（$PROJECT_ROOT/cavil-loop.config，改名前叫 coding-agent.config），不在本脚本读的
# 项目配置里。用子 shell 只取这两个值，避免把 daemon 那份配置整个灌进来覆盖 REPO 等。
# 路径属于部署环境，不写死在本仓库；取不到就跳过这个指标，其余照常出。
DAEMON_CONF="$(cavil_project_config "$PROJECT_ROOT")"
WT_BASE=""; WT_PREFIX=""
if [ -f "$DAEMON_CONF" ]; then
    WT_BASE=$(set -a; . "$DAEMON_CONF" >/dev/null 2>&1; printf '%s' "${WORKTREE_BASE:-}")
    WT_PREFIX=$(set -a; . "$DAEMON_CONF" >/dev/null 2>&1; printf '%s' "${SESSION_NAME_PREFIX:-}")
fi

# 口径切换那一周（那周起用量按 API 调用去重 + 纳入交叉 review 那一侧）。属于部署事实，
# 不写死在本仓库；设了就以它为准，报告与趋势图都据此判断哪些数字跨口径、不可比。
# 不设也能跑：采集器只在窗口里真能看见那条边界时才标，看不见就什么都不标
# （绝不拿窗口里第一条记录顶上——那会让切换日期每出一次报告就往后漂一周）。
SWITCH_WEEK="${WEEKLY_REPORT_SWITCH_WEEK:-}"

( cd "$PROJECT_ROOT" && python3 "$HERE/collect.py" --repo "$REPO" --out "$WORK/data.json" \
    ${WEEK_OF:+--week-of "$WEEK_OF"} \
    ${WT_BASE:+--worktree-base "$WT_BASE"} \
    ${WT_PREFIX:+--session-prefix "$WT_PREFIX"} \
    ${SWITCH_WEEK:+--switch-week "$SWITCH_WEEK"} )
else
# ── 多个项目：每个项目各自走完整条采数（严格模式），最后只在结果上合并 ──
# 任一项目读失败就整份不发：一份「少算了一个仓库」的合计看上去完全正常，没人会发现。
#
# 每个项目在子 shell 里从「读项目配置之前」的环境起步，再读它**自己**的配置：仓库名、
# 代码目录（算提交与增删行）、worktree 目录与会话前缀（找本机日志）、口径切换周、
# 机器人账号名单、GitHub 凭据都取它自己的。
#
# ⚠️ 主项目的配置**在本脚本启动之前**就可能已经在环境里了：定时任务的 service 用
# EnvironmentFile= 把它整份导入（PR #235 复审第 1 轮实测：靠「启动时的环境快照」隔离，
# 附加项目没写的切换周、凭据照样继承主项目的）。所以不靠快照，而是按名字清：
#   · 主项目配置文件里**赋过值的每一个名字**（systemd 与本脚本开头导入的正是这些）；
#   · 再加几个一律属于项目的名字（凭据、代码目录、worktree 目录规则、WEEKLY_REPORT_*），
#     不管它是从哪来的；
#   · 例外是本机公共的运行环境（PATH、HOME、语言、时区、XDG_* 目录、日志目录覆盖），
#     附加项目没写就沿用——主项目配置里写 PATH 正是为了让 systemd 找得到 node。
# 清完再读该项目**自己**的配置，没写的字段就是「没配」。
SHARED_ENV_RE='^(PATH|HOME|USER|LOGNAME|SHELL|TERM|TMPDIR|TZ|LANG|LANGUAGE|LC_[A-Z_]+|XDG_[A-Z_]+|CLAUDE_PROJECTS_DIR|CODEX_SESSIONS_DIR)$'
PROJECT_ENV_RE='^(PROJECT_ROOT|GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|WORKTREE_BASE|SESSION_NAME_PREFIX|WEEKLY_REPORT_[A-Za-z0-9_]*)$'
project_scoped_names() {   # 打印要在读附加项目配置前清掉的变量名，一行一个
    {
        sed -nE 's/^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=.*/\2/p' "$CONF"
        compgen -v | grep -E "$PROJECT_ENV_RE" || true
    } | grep -vE "$SHARED_ENV_RE" | sort -u
}
SCOPED_NAMES="$(project_scoped_names)"

collect_one() {   # $1 项目名  $2 输出文件  $3 记录「仓库名 + worktree 目录规则」的文件
    (
        set -euo pipefail
        local v
        for v in $SCOPED_NAMES; do unset "$v" 2>/dev/null || true; done
        local conf; conf="$(cavil_project_env "$1")"
        [ -f "$conf" ] || { echo "[error] 项目 $1：找不到项目配置 $conf" >&2; exit 1; }
        # shellcheck disable=SC1090
        set -a; . "$conf"; set +a
        [ -n "${PROJECT_ROOT:-}" ] || { echo "[error] 项目 $1：$conf 里缺 PROJECT_ROOT" >&2; exit 1; }
        local repo="${WEEKLY_REPORT_REPO:-$(git -C "$PROJECT_ROOT" remote get-url origin 2>/dev/null \
              | sed -E 's#(git@github.com:|https://github.com/)##; s#\.git$##')}"
        [ -n "$repo" ] || { echo "[error] 项目 $1：推不出仓库名，请在 $conf 里设 WEEKLY_REPORT_REPO" >&2; exit 1; }
        # 取最新主干：合并模式下失败就是失败（单项目那条路是 `|| true`）
        git -C "$PROJECT_ROOT" fetch origin --quiet \
            || { echo "[error] 项目 $1（${repo}）：取最新主干失败（git fetch origin）" >&2; exit 1; }
        local dconf wtb="" wtp=""
        dconf="$(cavil_project_config "$PROJECT_ROOT")"
        if [ -f "$dconf" ]; then
            # 先清掉环境里同名的值：该项目的 daemon 配置没写，就是没配，不沿用别处的
            wtb=$(unset WORKTREE_BASE SESSION_NAME_PREFIX; set -a; . "$dconf" >/dev/null 2>&1; printf '%s' "${WORKTREE_BASE:-}")
            wtp=$(unset WORKTREE_BASE SESSION_NAME_PREFIX; set -a; . "$dconf" >/dev/null 2>&1; printf '%s' "${SESSION_NAME_PREFIX:-}")
        fi
        # 只有两项都配了才会去读日志（collect.py 两个都给才读），才需要查撞没撞
        local wtkey=""; [ -z "$wtb" ] || [ -z "$wtp" ] || wtkey="$wtb/$wtp-"
        printf '%s\t%s\t%s\n' "$1" "$repo" "$wtkey" >> "$3"
        local sw="${WEEKLY_REPORT_SWITCH_WEEK:-}"
        echo "   · $1（repo=${repo}）"
        ( cd "$PROJECT_ROOT" && python3 "$HERE/collect.py" --strict --repo "$repo" --out "$2" \
            ${WEEK_OF:+--week-of "$WEEK_OF"} \
            ${wtb:+--worktree-base "$wtb"} \
            ${wtp:+--session-prefix "$wtp"} \
            ${sw:+--switch-week "$sw"} ) \
            || { echo "[error] 项目 $1（${repo}）：采数失败，整份周报不发" >&2; exit 1; }
    )
}

echo "== 1/4 采数（多个项目合并：$PROJECT ${EXTRA_PROJECTS}）"
IDS="$WORK/ids.tsv"; : > "$IDS"
PARTS=()
i=0
for P in "$PROJECT" $EXTRA_PROJECTS; do
    i=$((i + 1))
    collect_one "$P" "$WORK/part-$i.json" "$IDS"
    PARTS+=("$WORK/part-$i.json")
done
# 两个项目的 worktree 目录规则相同 → 两边会读到同一份本机日志，金额和处理时长串账
DUP=$(awk -F'\t' '$3!="" {print $3}' "$IDS" | sort | uniq -d)
if [ -n "$DUP" ]; then
    echo "[error] 下面这些项目的 worktree 目录规则相同，本机日志分不开、会串账：" >&2
    awk -F'\t' -v d="$DUP" '$3==d {print "   " $1 "（" $2 "）→ " $3 "<编号>"}' "$IDS" >&2
    exit 1
fi
DUPR=$(cut -f2 "$IDS" | sort | uniq -d)
[ -z "$DUPR" ] || { echo "[error] 同一个仓库被算了不止一次：$DUPR" >&2; exit 1; }
python3 "$HERE/merge.py" --out "$WORK/data.json" --primary "${PARTS[0]}" "${PARTS[@]:1}"
fi

echo "== 2/4 出图"
python3 "$HERE/render.py" --data "$WORK/data.json" --out-dir "$WORK" \
    --asset-url-base "$ASSET_URL" --rev "$REV" --fonts-dir "$FONTS_DIR"
for n in delivery effort cost token; do
    node "$HERE/shot.mjs" "$PROJECT_ROOT" "$WORK/$n.html" "$WORK/$n-$REV.png"
done

echo "== 3/4 传图"
mkdir -p "$ASSET_DIR"
# 目录列表由对外服务（scripts/public-assets/serve.mjs）挡，不再往目录里放 index.html。
cp "$WORK"/*-"$REV".png "$ASSET_DIR/"
# 矢量版（GitHub#273）：和 PNG 同名同戳，topdf.mjs 出 PDF 时按 PNG 的文件名找到它、代替 PNG。
# 临时目录随退出删掉，所以必须在这里留一份；字体已内嵌，不带本机路径。
# 它是网页不是图片，公网资产目录只放行图片和视频，所以留在本机不公开的目录里，topdf.mjs 从本机读。
mkdir -p "$VECTOR_DIR"
for n in delivery effort cost token; do
    cp "$WORK/$n.chart.html" "$VECTOR_DIR/$n-$REV.chart.html"
done
for n in delivery effort cost token; do
    f="$n-$REV.png"
    code=$(curl -sk -o /dev/null -w '%{http_code}' "$ASSET_URL/$f")
    [ "$code" = "200" ] || { echo "配图公网不可达（$f → HTTP ${code}），中止" >&2; exit 1; }
    echo "   $ASSET_URL/$f → 200"
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
> 5. 趋势图直接引用下面那四张（交付 / 投入 / 成本 / token），不用重新出图
> 6. **用词说人话，别用直译术语**。两个时间指标一律按下面这两个名字写，
>    正文、PDF、图注都一样，**不要写「墙上时长 / 墙上时间 / 挂钟时间」**（那是
>    wall time 的直译，中文读者看不懂）：
>    - **总耗时（含等待）** = 一次派工从开工到完工走过的钟点数，中间干等也算进去
>    - **处理时长（不含轮间等待）** = AI 每一轮从收到指令到做完回复经过的时间，轮与轮之间
>      的等待不算，但轮内的等待（权限确认、重试、进程挂起）照算，**不要写成「不含等待」或
>      「真干了多少活」**；它可能超过总耗时（一轮在完工评论之后还在跑），那不是数据错了
>    金额一律写明**美元**（本工具不做汇率换算）；正文若引用某条 issue 自己算出的
>    人民币金额，要点明那是那条 issue 的口径、跟周报这套记账无关。
>
> **PDF 文档规范（顺序固定，不要改）**
> 下面的数据部分**已经按 PDF 页序排好**：交付 / 投入 / 成本 / token / 按模型拆分各占一页，
> 每页是「该类的图 + 最近 10 周表」（本周行加粗、最后一行环比，†/≈ 的说明跟着各自的表）。
> 每页开头那行 `<div style="break-before: page"></div>` 是分页标记，**不要删**。拼 PDF 时：
> 1. **第 1 页：总体结论与注意事项** —— 写在「上周数据」标题之后、第一个分页标记之前。
>    **精简**，3~5 条，每条一句话结论 + 一句话解释，别铺开写
> 2. **交付 → 投入 → 成本 → token → 按模型拆分**，五页原样保留，顺序不动，图和表不拆开
> 3. **详细展开**（新起一页）—— 按上面的分组逐条讲，「本周明细」那几张表是素材
> 4. 末尾附数据口径
>
> ⚠️ PDF 是给人看**这周干了什么**的，**不要写周报工具自身的口径修正 / 数据遗漏 / 复核过程**——
> 那类元信息留在 issue 评论里说。PDF 专心给数据和解读。
>
> **出 PDF 与发布**（脚本在 `scripts/weekly-report/`，别自己造）
> ```bash
> node topdf.mjs <项目目录> report.md report.pdf --title "标题" --subtitle "副标题"
> URL=$(bash publish-asset.sh <project-key> report.pdf)   # 自动加 rev；PDF 不公开发布
> ```
> PDF 不是图片，不进公网资产目录。`$URL` 以 `http` 开头时是只在内网可达的下载地址，评论里给出来并
> 写明「需在内网打开」；否则它是本机路径，评论里写明「PDF 在运行 daemon 的那台机器上：<路径>」。
> 报告里的四张趋势图**原样保留 PNG 链接**，命令也不用改：`topdf.mjs` 会按每张 PNG 的文件名在本机
> 取同名的矢量版（`…-<戳>.chart.html`）放进 PDF，图放大也清楚。取不到矢量版它会报错退出、
> 列出是哪张——不要删图、不要换图，把报错原样写进 issue 评论、翻 `pending/human`；
> 只有维护者同意接受位图时，才在命令末尾加 `--allow-raster`。

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
