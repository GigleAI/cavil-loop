#!/usr/bin/env bash
# 停 / 启一个已接项目的后台轮询任务（GitHub#387）。给远程入口（scripts/remote-access/）用：
# 桌面客户端在本机做同一件事的那份规则在 client/src-tauri/crates/core/src/daemon.rs 的 service()，
# 两边用同一组场景对拍（client/test/unit/remote.test.ts）。
#
# 用法：
#   bash scripts/project-service.sh <instance-key> stop|start
#
# 规则（和本机那份一致）：
#   · 项目、后台任务名、当前状态都来自当场重新跑的 scripts/install-status.sh，不信调用方；
#   · 只在「在跑 → 停」「已停 → 启」时执行；状态读不到（unknown）既不停也不启；
#   · 执行后再读一次状态，只有读回的状态算数。
# 输出：给人看的说明若干行，最后两行固定是
#   STATE=<running|stopped|unknown>      操作后（或拒绝时当前）读到的状态
#   RESULT=<ok|failed|refused|not_found>
# 退出码：0 = ok；1 = 用法错误 / 没有这个项目；2 = 拒绝（没有执行任何操作）；3 = 执行了但读回的状态不对。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

KEY="${1:-}"; ACTION="${2:-}"
finish() { echo "STATE=$1"; echo "RESULT=$2"; exit "$3"; }

if [ -z "$KEY" ] || ! [[ "$KEY" =~ ^[A-Za-z0-9_.-]+$ ]] || [ "$KEY" = deploy ]; then
    echo "用法：$0 <instance-key> stop|start（实例名只能含 [A-Za-z0-9_.-]）" >&2
    finish unknown not_found 1
fi
case "$ACTION" in stop|start) ;; *) echo "用法：$0 <instance-key> stop|start" >&2; finish unknown refused 1 ;; esac

# 读一次状态，取出这个项目的后台任务那一段（JSON）；读不到返回非 0。
read_sched() {
    local out
    out="$(bash "$SCRIPT_DIR/install-status.sh" 2>/dev/null)" || return 1
    printf '%s' "$out" | jq -ce --arg k "$KEY" 'select(.version == 1) | .projects | map(select(.key == $k)) | if length == 0 then {missing:true} else .[0].scheduler end' 2>/dev/null
}

if ! sched="$(read_sched)"; then
    echo "读不到本机状态，没有执行"
    finish unknown refused 2
fi
if [ "$(jq -r '.missing // false' <<<"$sched")" = true ]; then
    echo "本机没有接入项目 $KEY"
    finish unknown not_found 1
fi
kind="$(jq -r '.kind // ""' <<<"$sched")"
unit="$(jq -r '.unit // ""' <<<"$sched")"
state="$(jq -r '.state // "unknown"' <<<"$sched")"
case "$state" in running|stopped) ;; *) state=unknown ;; esac

want_from=running; verb=停
[ "$ACTION" = start ] && { want_from=stopped; verb=启; }
if [ "$state" != "$want_from" ]; then
    case "$state" in running) shown=在跑 ;; stopped) shown=已停 ;; *) shown=读不到 ;; esac
    echo "$KEY 现在的后台任务状态是「${shown}」，没有执行「${verb}」"
    finish "$state" refused 2
fi
if ! [[ "$unit" =~ ^[A-Za-z0-9_.@-]+$ ]] || [[ "$unit" == -* ]]; then
    echo "状态脚本给出的后台任务名不合规，没有执行"
    finish "$state" refused 2
fi

case "$kind" in
    systemd)
        case "$unit" in *.timer) ;; *) echo "状态脚本给出的后台任务名不合规，没有执行"; finish "$state" refused 2 ;; esac
        systemctl --user "$ACTION" "$unit" 2>&1 || true
        ;;
    launchd)
        uid="$(id -u 2>/dev/null || true)"
        case "$uid" in ''|*[!0-9]*) echo "读不到本机用户编号（id -u），没有执行"; finish "$state" refused 2 ;; esac
        if [ "$ACTION" = stop ]; then
            launchctl bootout "gui/$uid/$unit" 2>&1 || true
        else
            plist="$(jq -r '.plist // ""' <<<"$sched")"
            expect="$HOME/Library/LaunchAgents/$unit.plist"
            if [ "$plist" != "$expect" ] || [ ! -f "$expect" ]; then
                echo "找不到 $KEY 的后台任务配置文件 ${expect}，没有执行"
                finish "$state" refused 2
            fi
            launchctl bootstrap "gui/$uid" "$plist" 2>&1 || true
        fi
        ;;
    *)
        echo "认不出这台机器的后台任务管理器，没有执行"
        finish "$state" refused 2 ;;
esac

# 读回：只有状态脚本现在报的状态算数
want=stopped; [ "$ACTION" = start ] && want=running
now=unknown
if after="$(read_sched)"; then
    now="$(jq -r '.state // "unknown"' <<<"$after")"
    case "$now" in running|stopped) ;; *) now=unknown ;; esac
fi
if [ "$now" = "$want" ]; then finish "$now" ok 0; fi
echo "执行了「${verb}」，但读回的状态是 $now"
finish "$now" failed 3
