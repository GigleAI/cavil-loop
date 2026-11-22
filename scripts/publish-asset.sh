#!/usr/bin/env bash
# 发布评论配图 / 周报附件，打印拿它的地址（GitHub#613：唯一的发布入口）。
#
# 用法：
#   publish-asset.sh --project <key> --item <条目编号> <文件>...           评论配图
#   publish-asset.sh --project <key> --weekly-report [--keep-name] <文件>... 周报
#   publish-asset.sh --project <key> --check-ready                          只问「现在能不能发图」
#   publish-asset.sh <key> <文件> [weekly-report|<条目编号>]                早期写法，照旧可用
#
# 图片 / 视频 → 公网资产目录 <key>/<条目编号或 weekly-report>/<名字>-rev-<唯一戳>.<扩展名>：
#   ① 对外服务必须报告「服务端拦截已生效」（严格模式开、旧图清单可用、进程就是记录的那个），否则拒绝；
#      目录取服务自己报告的实际目录，不猜。
#   ② 文件先复制成目标目录里的隐藏临时文件，**查这份副本**有没有凭证样式（有就删掉副本、拒绝）；
#   ③ 改名成最终名字（已存在就拒绝，不覆盖）；
#   ④ 核对公网地址 HTTP 200 且下载到的字节数等于文件大小，不对就删掉自己刚放的文件、报错。
# 其他类型（PDF 等）→ 不进公网资产目录：放进不公开的目录 <私有目录>/<key>/<子目录>/，配了
#   WEEKLY_REPORT_PRIVATE_ASSET_ROOT_URL（只在内网可达的地址前缀）就核对并打印那个地址，没配就打印本机路径。
# --keep-name 只给周报：周报文件名本来就带每期唯一的戳（PDF 用它找本机矢量图），原样保留。
#
# stdout 只有地址（一行一个），其余说明都在 stderr。退出码：0 全部发出；1 拒绝或失败；2 用法错误。

# ── One publish entry and the enforced server-side check for comment images: rules moved from the root AGENTS.md (GitHub#658); read before changing ──
# One publish entry and the enforced server-side check for comment images (GitHub#613:
# `scripts/publish-asset.sh`, `scripts/public-assets/{serve,rules,strict}.mjs`, `switch.sh`,
# `usage.sh`, `asset_publish_fill` / `asset_project_key` in `_lib.sh` and its call after
# `concurrent_work_fill` in the three dispatch scripts, `prompts/asset-publish.md`, the `--auto` call
# in `poll-entry.sh`, the publish branch of `weekly-report/run.sh`, the commands in
# `docs/operations{,.zh}.md` behind `<!-- public-assets-rollback:begin -->`) →
# `tests/public-assets-strict.test.sh` (~40 s; the real service through `run.sh`, a fake `systemctl`
# that really starts and stops it, the real dispatch script and weekly `run.sh`) plus
# `tests/public-assets.test.sh` and `tests/reply-layout-prompts.test.sh`. "Is the server-side check in
# force" has one definition, `statusCheck` in `strict.mjs` (the service's own status file: strict on,
# legacy list usable, recorded pid alive with the same start time — **and** the switch's acceptance
# record `accepted.json`, written only after its verification passed, naming exactly that process;
# strict mode running without it is `strict-unverified`, never "in force") — the publish command, the
# switch and the weekly report all ask it; unreadable is never "in force". Where the service really
# serves (directory, listening port, path prefix) is taken from that same answer and nothing else: a
# status file missing any of them is `unknown`, and no caller falls back to a configured or default
# value (PR #623 review round 6: the switch's check assumed `/review-assets/` and a working service
# with a custom `PUBLIC_ASSETS_PREFIX` was rolled back). The switch refuses while any registered
# project has only the early `WEEKLY_REPORT_ASSET_URL` and no `WEEKLY_REPORT_ASSET_ROOT_URL` (the new
# address cannot be derived), so an automatic switch never stops a weekly report. Project configs are
# read one way only, `scripts/weekly-report/_asset_mode.sh` (`project_conf_load` in a child,
# `project_conf_source` in place: inherited values removed, then `set -a; .` — the values after
# loading, never the file's text), by the weekly report, the publish command and the switch's
# pre-check and verification; which configs are projects is only `strict.mjs keys`, and either one
# failing to read is "cannot tell" → no switch (PR #623 review rounds 2–3 each found a third reader
# with its own parsing). The only trusted legacy state is the `PUBLIC_ASSETS_LEGACY_SHA=` line in the
# service config: present = the list governs and is never rebuilt, absent = never in force; never
# rebuild a list from the directory as it is now. In strict mode a file is read whole into memory and
# judged, compared and sent from that one buffer — never stream from disk after judging. The cache
# keyed by file identity holds content facts only (the bytes, their SHA-256, the credential findings);
# whether a path may be served, its extension / format and its legacy-list entry are judged again on
# every request, because one identity can sit at several paths (hard links) — caching a verdict let
# one path's answer decide another's (PR #623 review round 5). An old image is judged by the legacy
# list alone (path in the list, content SHA-256 equal) — never make it depend on the project list: one
# unreadable project config would then break every old image in posted comments (PR #623 review round
# 4); only a path not in the list needs the project list, and an unreadable one refuses that path.
# Without `PUBLIC_ASSETS_STRICT=1` the service answers exactly like the merge-base copy (the test
# diffs a set of requests); with no image address the worker prompts are untouched.
#
set -euo pipefail

HERE="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
# shellcheck source=_names.sh
source "$HERE/_names.sh"
CHECK="$HERE/public-assets/check.mjs"
STRICT="$HERE/public-assets/strict.mjs"

usage() { sed -n '4,8p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2; exit 2; }

PROJECT="" ITEM="" WEEKLY=0 KEEP=0 READY_ONLY=0
FILES=()
if [ $# -gt 0 ] && [ "${1#--}" = "$1" ]; then
    # 早期写法：<key> <文件> [子目录]；子目录只认 weekly-report（默认）或条目编号
    PROJECT="$1"; FILES=("${2:-}"); sub="${3:-weekly-report}"
    [ -n "${FILES[0]}" ] || usage
    if [ "$sub" = weekly-report ]; then WEEKLY=1
    elif [[ "$sub" =~ ^[0-9]+$ ]]; then ITEM="$sub"
    else echo "子目录只能是 weekly-report 或条目编号：$sub" >&2; exit 2; fi
else
    while [ $# -gt 0 ]; do
        case "$1" in
            --project) PROJECT="${2:-}"; shift 2 || usage ;;
            --item) ITEM="${2:-}"; shift 2 || usage ;;
            --weekly-report) WEEKLY=1; shift ;;
            --keep-name) KEEP=1; shift ;;
            --check-ready) READY_ONLY=1; shift ;;
            --) shift; FILES+=("$@"); break ;;
            -*) echo "未知参数: $1" >&2; usage ;;
            *) FILES+=("$1"); shift ;;
        esac
    done
fi
[[ "$PROJECT" =~ ^[A-Za-z0-9_-][A-Za-z0-9._-]*$ ]] || { echo "项目 key 不对：${PROJECT:-（空）}" >&2; exit 2; }
if [ "$READY_ONLY" = 0 ]; then
    [ ${#FILES[@]} -gt 0 ] || usage
    if [ "$WEEKLY" = 1 ]; then
        [ -z "$ITEM" ] || { echo "--item 和 --weekly-report 只能选一个" >&2; exit 2; }
        SUB=weekly-report
    else
        [ "$KEEP" = 0 ] || { echo "--keep-name 只给周报用" >&2; exit 2; }
        [[ "$ITEM" =~ ^[1-9][0-9]*$ ]] || { echo "条目编号不对：${ITEM:-（空）}" >&2; exit 2; }
        SUB="$ITEM"
    fi
fi

CONF="$(cavil_project_env "$PROJECT")"
[ -f "$CONF" ] || { echo "找不到项目配置 $CONF" >&2; exit 1; }
# shellcheck disable=SC1090
# 加载口径和周报、切换命令同一份（去掉继承来的同名值）
# shellcheck source=weekly-report/_asset_mode.sh
source "$HERE/weekly-report/_asset_mode.sh"
project_conf_source "$CONF"
ROOT_URL="${WEEKLY_REPORT_ASSET_ROOT_URL:-}"
ROOT_URL="${ROOT_URL%/}"

# 服务端拦截是否生效：只认对外服务自己写的状态文件（判断规则在 strict.mjs，切换命令用同一份）。
STATUS_FILE="${PUBLIC_ASSETS_STATUS:-$(cavil_public_assets_status)}"
SERVE_ROOT=""
ready() {
    local j state reason
    if ! j="$(node "$STRICT" status-check "$STATUS_FILE" 2>/dev/null)"; then
        echo "读不出对外服务的状态（检查命令没跑成）" >&2; return 1
    fi
    state="$(printf '%s' "$j" | jq -r '.state // ""' 2>/dev/null)" || state=""
    reason="$(printf '%s' "$j" | jq -r '.reason // ""' 2>/dev/null)" || reason=""
    if [ "$state" != enforced ]; then
        echo "服务端拦截没有生效，不发布公网图片：${reason:-状态未知}" >&2
        echo "  查看：bash $HERE/public-assets/switch.sh --status" >&2
        return 1
    fi
    SERVE_ROOT="$(printf '%s' "$j" | jq -r '.root // ""')"
    [ -n "$SERVE_ROOT" ] && [ -d "$SERVE_ROOT" ] || { echo "对外服务报告的目录不存在：${SERVE_ROOT:-（空）}" >&2; return 1; }
    [ -n "$ROOT_URL" ] || {
        echo "缺 WEEKLY_REPORT_ASSET_ROOT_URL —— 配图要能被 GitHub 抓到，必须是公网可达的 URL 前缀。" >&2
        echo "在 $CONF 里设，例如：WEEKLY_REPORT_ASSET_ROOT_URL=\"https://<公网主机>/review-assets\"" >&2
        return 1
    }
}

if [ "$READY_ONLY" = 1 ]; then
    ready || exit 1
    echo "能发：对外服务的拦截已生效，目录 $SERVE_ROOT" >&2
    exit 0
fi

size_of() { wc -c < "$1" | tr -d ' '; }
REV() { date +%s%N | tail -c 10; }
# 文件名里只留字母、数字、点、下划线、连字符：地址不用转义，也不会以点开头
safe_stem() { printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '-' | sed 's/^[.-]*//'; }

READY_DONE=0
publish_one() {
    local file="$1" base ext stem name check_out dir tmp final url got
    [ -f "$file" ] || { echo "找不到文件 $file" >&2; return 1; }
    base="$(basename "$file")"
    ext="${base##*.}"; [ "$ext" != "$base" ] || ext=""
    stem="${base%.*}"
    if [ "$KEEP" = 1 ]; then
        [[ "$base" =~ ^[A-Za-z0-9_][A-Za-z0-9._-]*$ ]] || { echo "--keep-name 的文件名只能是字母、数字、点、下划线、连字符：$base" >&2; return 1; }
        name="$base"
    else
        stem="$(safe_stem "$stem")"; [ -n "$stem" ] || stem=asset
        name="${stem}-rev-$(REV)${ext:+.$ext}"
    fi

    # 原文件先过一遍：含凭证样式直接拒绝，顺便知道是不是图片 / 视频
    if ! check_out="$(node "$CHECK" "$file" 2>&1)"; then
        echo "拒绝发布 ${file}：" >&2; printf '%s\n' "$check_out" >&2; return 1
    fi

    if ! printf '%s\n' "$check_out" | grep -q '^拿得到 '; then
        # 不是图片 / 视频：不进公网资产目录
        local priv_dir="${WEEKLY_REPORT_PRIVATE_ASSET_ROOT:-$(dirname "$(cavil_review_shots)")/private-assets}"
        local priv_url="${WEEKLY_REPORT_PRIVATE_ASSET_ROOT_URL:-}" code
        mkdir -p "$priv_dir/$PROJECT/$SUB"
        chmod 700 "$priv_dir"
        cp "$file" "$priv_dir/$PROJECT/$SUB/$name"
        if [ -z "$priv_url" ]; then
            echo "不是图片 / 视频，没有公开发布；文件留在本机（没配 WEEKLY_REPORT_PRIVATE_ASSET_ROOT_URL）" >&2
            echo "$priv_dir/$PROJECT/$SUB/$name"
            return 0
        fi
        url="${priv_url%/}/$PROJECT/$SUB/$name"
        code=$(curl -sk -o /dev/null -w '%{http_code}' "$url") || code="000"
        if [ "$code" != "200" ]; then
            echo "内网地址不可达（HTTP ${code}）：$url" >&2
            echo "  文件已在 $priv_dir/$PROJECT/$SUB/${name}；检查 WEEKLY_REPORT_PRIVATE_ASSET_ROOT_URL 指的入口" >&2
            return 1
        fi
        echo "不是图片 / 视频，没有公开发布；已放到只在内网可达的地址 → HTTP 200" >&2
        echo "$url"
        return 0
    fi

    if [ "$READY_DONE" = 0 ]; then ready || return 1; READY_DONE=1; fi
    dir="$SERVE_ROOT/$PROJECT/$SUB"
    mkdir -p "$dir"
    tmp="$(mktemp "$dir/.publish.XXXXXX")"
    cp "$file" "$tmp"
    chmod 644 "$tmp"
    # 查的是已经落进目标目录的这份副本（凭证样式；类型和格式上面已按原文件判过，内容相同）：之后只改名，不再写内容
    if ! check_out="$(node "$CHECK" "$tmp" 2>&1)"; then
        rm -f "$tmp"
        echo "拒绝发布 ${file}（复制后的副本没过检查）：" >&2; printf '%s\n' "$check_out" >&2; return 1
    fi
    final="$dir/$name"
    # 硬链接不覆盖已存在的名字；成功后再删临时名
    if ! ln "$tmp" "$final" 2>/dev/null; then
        rm -f "$tmp"; echo "目标已存在，不覆盖：$final" >&2; return 1
    fi
    rm -f "$tmp"
    url="$ROOT_URL/$PROJECT/$SUB/$name"
    got="$(curl -sk -o /dev/null -w '%{http_code} %{size_download}' "$url")" || got="000 0"
    if [ "$got" != "200 $(size_of "$final")" ]; then
        rm -f "$final"
        echo "公网核对没过（期望 200 $(size_of "$file") 字节，实得 ${got}）：$url" >&2
        echo "  写入的目录是 ${dir}；公网入口没开、路径没挂，或入口交的不是这个目录。已删掉刚放的文件。" >&2
        return 1
    fi
    echo "已发布 → HTTP 200（$(size_of "$final") 字节）" >&2
    echo "$url"
}

rc=0
for f in "${FILES[@]}"; do publish_one "$f" || rc=1; done
exit "$rc"
