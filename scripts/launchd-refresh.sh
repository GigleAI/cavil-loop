#!/usr/bin/env bash
# 换新一个项目的 Mac 后台任务配置（launchd plist），一个项目一次（GitHub#313）。
#
# 用法：
#   bash scripts/launchd-refresh.sh <instance-key>
#
# 为什么要它：plist 是 setup.sh 按模板「生成」的，不是软链。daemon 代码更新、模板变了之后，
# 重跑 setup.sh 换不了它——setup 看到文件已存在就跳过，随后重新加载的还是旧文件。
#
# 流程（每一步只认已知结果，读不到就停在当前一步，不往下删或替换）：
#   1. 用安装时同一个函数（scripts/_install.sh 的 cavil_render_plist）生成新文件到临时位置，
#      plutil -lint 校验；不过 → 结束，什么都没动
#   2. 和现有文件逐字比对；一样 → 「无需换新」
#   3. 读任务状态：已加载 / 未加载 / 读不到；读不到 → 结束，什么都没动
#   4. 已加载的：先拿该项目轮询用的同一把锁（等当前这一轮结束；最多等 CAVIL_REFRESH_LOCK_WAIT 秒，
#      默认 300），再 bootout，读回确认未加载；确认不了 → 尽量重新加载原文件，报失败，原文件未动
#   5. 备份原文件到本项目状态目录 launchd-backup/（带时间戳）；备份失败 → 按原状态重新加载原文件，
#      结束；然后原子替换
#   6. 原来已加载的就加载新文件，读回确认已加载、且指向这个文件；原来未加载的保持未加载
#   7. 第 6 步失败：用备份恢复、按原状态重新加载、读回确认；恢复也失败 → 输出两次的原文和备份位置，
#      标为「需要人处理」，备份保留
#
# 最后一行固定是 RESULT=<词>，给调用方（客户端）读：
#   replaced     已换新（退出 0）            unchanged    无需换新（退出 0）
#   unknown      状态读不到，什么都没动（2） lint_failed  新文件校验不过，什么都没动（2）
#   lock_timeout 等不到这一轮轮询结束，什么都没动（2）
#   not_found    没有这个实例 / 没有 plist（1）  not_macos   不是 macOS，不适用（1）
#   failed       没换成，原文件和原状态已读回确认（3）——只有确认过才报它，确认不了一律 needs_human
#   needs_human  没换成，恢复也失败——看输出里的原文和备份位置（4）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"
# shellcheck source=_names.sh
source "$SCRIPT_DIR/_names.sh"
# shellcheck source=_install.sh
source "$SCRIPT_DIR/_install.sh"

result() { echo "RESULT=$1"; exit "$2"; }
indent() { sed 's/^/    /'; }

KEY="${1:-}"
if [ -z "$KEY" ] || ! [[ "$KEY" =~ ^[A-Za-z0-9_.-]+$ ]] || [ "$KEY" = deploy ]; then
    echo "用法：$0 <instance-key>（只能含 [A-Za-z0-9_.-]）" >&2
    result not_found 1
fi
OS="$(uname -s 2>/dev/null || true)"
if [ "$OS" != Darwin ]; then
    echo "只用于 macOS（本机：${OS:-读不到}）。Linux 上的后台任务文件是指向模板的软链，部署器自己会重新加载。"
    result not_macos 1
fi

env_file="$(cavil_project_env "$KEY")"
layout="$(cavil_layout_of_env "$env_file")"
label="$(cavil_launchd_label "$layout" "$KEY")"
log_dir="$(cavil_launchd_log_dir "$layout")"
plist_dir="$HOME/Library/LaunchAgents"
plist="$plist_dir/$label.plist"
template="$SKILL_DIR/launchd/dev.luosky.cavil-loop.plist.template"
domain="gui/$(id -u)"

if [ ! -f "$env_file" ] || [ ! -f "$plist" ]; then
    echo "没有接入实例 $KEY（需要 $env_file 和 $plist 都在；没装过的项目请跑 setup.sh）"
    result not_found 1
fi
config="$(sed -n 's/^CODING_AGENT_CONFIG=//p' "$env_file" | tail -1)"
host="$(sed -n 's/^PROJECT_ROOT=//p' "$env_file" | tail -1)"
state_dir=""
if [ -n "$config" ] && [ -f "$config" ]; then
    state_dir="$( set +eu; set -a; PROJECT_ROOT="$host"; . "$config" >/dev/null 2>&1 || exit 3; printf '%s' "${STATE_DIR:-}" )" || state_dir=""
fi
if [ -z "$state_dir" ]; then
    echo "读不出项目配置里的 STATE_DIR（配置：${config:-环境文件里没写}），拿不到轮询锁、也没处放备份，什么都没动"
    result unknown 2
fi

# ── 1. 生成新文件到临时位置并校验 ──
poll_secs="$(cavil_config_int "$config" POLL_INTERVAL_SECS 60)"
bash_bin="$(cavil_bash_bin "$OS")"
new="$(mktemp "$plist_dir/.$label.plist.new.XXXXXX")"
trap 'rm -f "$new"' EXIT
cavil_render_plist "$template" "$label" "$KEY" "$SKILL_DIR" "$env_file" "$log_dir" "$bash_bin" "$poll_secs" > "$new"
if ! lint_out="$(plutil -lint "$new" 2>&1)"; then
    echo "1. 新生成的文件校验不过，什么都没动："
    printf '%s\n' "$lint_out" | indent
    result lint_failed 2
fi
echo "1. 新文件已生成并通过校验"

# ── 2. 比对 ──
if cmp -s "$new" "$plist"; then
    echo "2. 和现有文件一样，无需换新：$plist"
    result unchanged 0
fi
echo "2. 和现有文件不同，需要换新"

# ── 3. 读任务状态 ──
cavil_launchd_probe "$label"
orig_state="$CAVIL_SCHED_STATE"
echo "3. 后台任务 $label：$orig_state"
if [ "$orig_state" = unknown ]; then
    echo "   读不到任务状态，什么都没动。读到的原文："
    printf '%s\n' "$CAVIL_SCHED_RAW" | indent
    result unknown 2
fi

# 按原状态把某个文件加载回去，并读回确认。<文件> → 0 = 已确认回到原状态
load_back() {
    local f="$1" out=""
    if [ "$orig_state" = loaded ]; then
        cavil_launchd_probe "$label"
        [ "$CAVIL_SCHED_STATE" = unloaded ] || out="$(launchctl bootout "$domain/$label" 2>&1)" || true
        out="$out$(launchctl bootstrap "$domain" "$f" 2>&1)" || true
        LOAD_BACK_OUT="$out"
        cavil_launchd_probe "$label"
        [ "$CAVIL_SCHED_STATE" = loaded ] && [ "$CAVIL_SCHED_PATH" = "$plist" ]
    else
        LOAD_BACK_OUT=""
        cavil_launchd_probe "$label"
        [ "$CAVIL_SCHED_STATE" = unloaded ]
    fi
}

# ── 4. 已加载的：等这一轮轮询结束，再卸载 ──
if [ "$orig_state" = loaded ]; then
    mkdir -p "$state_dir"
    wait_secs="${CAVIL_REFRESH_LOCK_WAIT:-300}"
    case "$wait_secs" in ''|*[!0-9]*) wait_secs=300 ;; esac
    # 固定 fd 8：macOS 自带的 bash 3.2 不支持 {fd} 写法
    exec 8>>"$state_dir/poll.lock"
    if ! flock -w "$wait_secs" 8; then
        echo "4. 等了 ${wait_secs}s，这个项目的轮询还没跑完（$state_dir/poll.lock），什么都没动；稍后再试"
        result lock_timeout 2
    fi
    bootout_out="$(launchctl bootout "$domain/$label" 2>&1)" || true
    cavil_launchd_probe "$label"
    if [ "$CAVIL_SCHED_STATE" != unloaded ]; then
        echo "4. 卸载后读回不是「未加载」（$CAVIL_SCHED_STATE），原文件未动："
        printf '%s\n' "$bootout_out" "$CAVIL_SCHED_RAW" | indent
        # 「原样」要读回确认：仍是原来那份在跑，或者按原状态重新加载原文件后读回确认。
        # 读不到 / 加载失败都不能报 failed（failed = 已确认恢复），只能交人。
        if [ "$CAVIL_SCHED_STATE" = loaded ] && [ "$CAVIL_SCHED_PATH" = "$plist" ]; then
            echo "   任务仍是原来那份、仍已加载"
            result failed 3
        fi
        if load_back "$plist"; then
            echo "   已按原状态重新加载原文件，并读回确认"
            result failed 3
        fi
        echo "   重新加载原文件没有确认成功——需要人处理："
        printf '%s\n' "${LOAD_BACK_OUT:-}" "$CAVIL_SCHED_RAW" | indent
        echo "   原文件未动：$plist；原来的状态：$orig_state；手动恢复：launchctl bootstrap $domain \"$plist\""
        result needs_human 4
    fi
    echo "4. 已卸载（拿着轮询锁，期间不会有新一轮开始）"
fi

# ── 5. 备份 + 原子替换 ──
backup_dir="$state_dir/launchd-backup"
backup="$backup_dir/$label.plist.$(date +%Y%m%d-%H%M%S).$$"
if ! { mkdir -p "$backup_dir" && cp -p "$plist" "$backup" && cmp -s "$plist" "$backup"; } 2>/dev/null; then
    echo "5. 备份失败（$backup），不换；按原状态重新加载原文件"
    if load_back "$plist"; then result failed 3; fi
    echo "   重新加载原文件也没成功："
    printf '%s\n' "$LOAD_BACK_OUT" "$CAVIL_SCHED_RAW" | indent
    result needs_human 4
fi
echo "5. 已备份：$backup"
if ! mv -f "$new" "$plist"; then
    echo "5. 替换失败；按原状态重新加载原文件"
    if cmp -s "$backup" "$plist" && load_back "$plist"; then echo "   原文件未变，已读回确认原状态"; result failed 3; fi
    printf '%s\n' "$LOAD_BACK_OUT" "$CAVIL_SCHED_RAW" | indent
    result needs_human 4
fi
echo "5. 已换上新文件：$plist"

# ── 6. 按原状态加载新文件 ──
if load_back "$plist"; then
    if [ "$orig_state" = loaded ]; then echo "6. 已加载新文件并读回确认"; else echo "6. 原来未加载，保持未加载"; fi
    result replaced 0
fi
first_out="$LOAD_BACK_OUT"; first_raw="$CAVIL_SCHED_RAW"
echo "6. 加载新文件失败（读回：$CAVIL_SCHED_STATE）："
printf '%s\n' "$first_out" "$first_raw" | indent

# ── 7. 用备份恢复 ──
LOAD_BACK_OUT=""
restore_tmp="$(mktemp "$plist_dir/.$label.plist.restore.XXXXXX")"
if cp -p "$backup" "$restore_tmp" && mv -f "$restore_tmp" "$plist" && cmp -s "$backup" "$plist" \
   && load_back "$plist"; then
    echo "7. 已用备份恢复原文件，并按原状态（$orig_state）重新加载、读回确认"
    echo "   备份保留：$backup"
    result failed 3
fi
rm -f "$restore_tmp"
echo "7. 恢复也失败——需要人处理。"
echo "   第一次（加载新文件）的原文："
printf '%s\n' "$first_out" "$first_raw" | indent
echo "   第二次（恢复原文件）的原文："
printf '%s\n' "${LOAD_BACK_OUT:-}" "$CAVIL_SCHED_RAW" | indent
echo "   原文件备份：$backup（保留，不会删）"
echo "   原来的状态：$orig_state；手动恢复：cp \"$backup\" \"$plist\" && launchctl bootstrap $domain \"$plist\""
result needs_human 4
