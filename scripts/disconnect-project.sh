#!/usr/bin/env bash
# 断开一个已接的项目：停掉它的后台任务、撤掉登记（GitHub#313）。
#
# 用法：
#   bash scripts/disconnect-project.sh <instance-key>
#
# 做的就是 docs/operations.md「Uninstall one project」那几步：
#   Linux：systemctl --user disable --now <前缀>-poll@<key>.timer，再删 ~/.config/cavil-loop/<key>.conf
#   macOS：launchctl bootout gui/$UID/<label>，再删 ~/Library/LaunchAgents/<label>.plist 和 <key>.conf
# 改名前的旧安装用旧名字（scripts/_names.sh 挑）。**默认保留**项目根目录的配置文件和状态目录，
# 以后重跑 setup.sh 就能原样接回来；worker 的 tmux 会话不动。
#
# 每一步只认已知结果：
#   · 停之前先读后台任务状态，读不到 → 什么都不删，退出 2；
#   · 停完读回确认已停（Linux 还要确认不再开机自启），确认不了 → 登记不删，退出 3。
# 退出码：0 = 已断开；1 = 用法错误 / 没有这个实例；2 = 状态读不到，什么都没动；3 = 停不下来，登记保留。
# 最后一行固定是 RESULT=<disconnected|not_found|unknown|failed>，给调用方（客户端）读。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=_names.sh
source "$SCRIPT_DIR/_names.sh"
# shellcheck source=_install.sh
source "$SCRIPT_DIR/_install.sh"

KEY="${1:-}"
if [ -z "$KEY" ] || ! [[ "$KEY" =~ ^[A-Za-z0-9_.-]+$ ]] || [ "$KEY" = deploy ]; then
    echo "用法：$0 <instance-key>（只能含 [A-Za-z0-9_.-]）" >&2
    echo "RESULT=not_found"
    exit 1
fi

result() { echo "RESULT=$1"; exit "$2"; }

env_file="$(cavil_project_env "$KEY")"
layout="$(cavil_layout_of_env "$env_file")"
OS="$(uname -s 2>/dev/null || true)"

case "$OS" in
    Linux)
        unit="$(cavil_systemd_timer "$layout" "$KEY")"
        if [ ! -e "$env_file" ] && [ ! -e "$HOME/.config/systemd/user/timers.target.wants/$unit" ]; then
            echo "没有接入实例 ${KEY}（找不到 ${env_file}）"
            result not_found 1
        fi
        cavil_systemd_probe "$unit"
        echo "后台任务 ${unit}：$CAVIL_SCHED_STATE"
        if [ "$CAVIL_SCHED_STATE" = unknown ]; then
            echo "读不到后台任务状态，什么都没动。读到的原文："
            printf '%s\n' "$CAVIL_SCHED_RAW" | sed 's/^/  /'
            result unknown 2
        fi
        disable_out="$(systemctl --user disable --now "$unit" 2>&1)" || true
        cavil_systemd_probe "$unit"
        cavil_systemd_enabled_probe "$unit"
        if [ "$CAVIL_SCHED_STATE" != stopped ] || [ "$CAVIL_SCHED_ENABLED" != no ]; then
            echo "停不下来或确认不了（运行：${CAVIL_SCHED_STATE}，开机自启：${CAVIL_SCHED_ENABLED}），登记保留。"
            [ -n "$disable_out" ] && printf '%s\n' "$disable_out" | sed 's/^/  /'
            result failed 3
        fi
        echo "✓ 已停止并取消开机自启：$unit"
        ;;
    Darwin)
        label="$(cavil_launchd_label "$layout" "$KEY")"
        plist="$HOME/Library/LaunchAgents/$label.plist"
        if [ ! -e "$env_file" ] && [ ! -e "$plist" ]; then
            echo "没有接入实例 ${KEY}（找不到 $env_file 和 ${plist}）"
            result not_found 1
        fi
        cavil_launchd_probe "$label"
        echo "后台任务 ${label}：$CAVIL_SCHED_STATE"
        case "$CAVIL_SCHED_STATE" in
            unknown)
                echo "读不到后台任务状态，什么都没动。读到的原文："
                printf '%s\n' "$CAVIL_SCHED_RAW" | sed 's/^/  /'
                result unknown 2 ;;
            loaded)
                bootout_out="$(launchctl bootout "gui/$(id -u)/$label" 2>&1)" || true
                cavil_launchd_probe "$label"
                if [ "$CAVIL_SCHED_STATE" != unloaded ]; then
                    echo "卸载后读回不是「未加载」（${CAVIL_SCHED_STATE}），登记保留。"
                    [ -n "$bootout_out" ] && printf '%s\n' "$bootout_out" | sed 's/^/  /'
                    result failed 3
                fi
                echo "✓ 已卸载：$label" ;;
        esac
        if [ -e "$plist" ]; then
            rm -f "$plist"
            echo "✓ 已删除 $plist"
        fi
        ;;
    *)
        echo "不支持的系统：${OS:-读不到}，什么都没动"
        result unknown 2 ;;
esac

if [ -e "$env_file" ]; then
    rm -f "$env_file"
    echo "✓ 已删除 $env_file"
fi
echo "保留：项目根目录的配置文件、状态目录（重跑 setup.sh 可接回）"
result disconnected 0
