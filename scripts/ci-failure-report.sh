#!/usr/bin/env bash
# base 分支测试工作流失败 → 开 / 续报告 issue（GitHub#345）。逻辑在 ci_failure_report.py，
# 这里只做三件事：加载本项目配置、把要用的配置交给它、保证和主轮询不同时跑。
#
#   bash ci-failure-report.sh             一次检查（主轮询每轮在轮询锁内调一次；手动跑会自己去拿锁）
#   bash ci-failure-report.sh --restart   本机记录丢失、已暂停时：从当前时刻重新开始
#   bash ci-failure-report.sh --list      看状态：是否暂停、不派工名单、各工作流核对到哪
#
# 手动跑要指明项目：CODING_AGENT_CONFIG=<本项目配置文件路径> bash ci-failure-report.sh --list
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec 8>&2
source "$SCRIPT_DIR/_lib.sh"
exec 2>&8 8>&-

MODE=tick
case "${1:-}" in
    "") ;;
    --restart) MODE=restart ;;
    --list) MODE=list ;;
    *) echo "用法：ci-failure-report.sh [--restart | --list]" >&2; exit 2 ;;
esac

# 主轮询调用时它自己持着轮询锁（fd 已经关给本进程了）；手动跑就自己拿，免得和正在跑的一轮同时改
if [ "${CI_FAILURE_REPORT_IN_POLL:-}" != 1 ] && [ "$MODE" != list ]; then
    exec 9>"$STATE_DIR/poll.lock"
    if ! flock -w 300 9; then
        echo "等了 5 分钟还拿不到轮询锁（有一轮轮询一直没结束），什么都没改" >&2
        exit 1
    fi
fi

if ! command -v python3 >/dev/null 2>&1; then
    if [ "$MODE" = tick ]; then
        log "⚠️ CI 失败报告：找不到 python3，这项检查没有运行（装上 python3，或把 CI_FAILURE_REPORT_WORKFLOWS 留空）"
        exit 0
    fi
    echo "找不到 python3" >&2
    exit 1
fi

# 配置交给检查程序，然后 exec：这样本脚本拿到的子进程号就是 python 自己，要停它时信号直接送到
run_py() {
    local wt=""
    [ -z "${WRITE_GH_TOKEN:-}" ] || wt="$WRITE_GH_TOKEN"
    export CI_REPORT_REPO="$REPO" \
        CI_REPORT_STATE_DIR="$STATE_DIR" \
        CI_REPORT_BASE="${CI_FAILURE_REPORT_BRANCH:-main}" \
        CI_REPORT_WORKFLOWS="${CI_FAILURE_REPORT_WORKFLOWS:-}" \
        CI_REPORT_DISPATCH="${CI_FAILURE_REPORT_DISPATCH:-false}" \
        CI_REPORT_MAX_FIX="${CI_FAILURE_REPORT_MAX_FIX_ATTEMPTS:-2}" \
        CI_REPORT_DISPATCH_LABEL="$LABEL_PENDING_AGENT_DEFAULT" \
        CI_REPORT_LABEL_HUMAN="$LABEL_PENDING_HUMAN" \
        CI_REPORT_LABEL_DOING="$LABEL_AGENT_DOING" \
        CI_REPORT_FLOW_LABELS="$(ci_report_flow_labels)" \
        CI_REPORT_TRIGGER_LABELS="$(trigger_labels_all | awk 'NF && !seen[$0]++')" \
        CI_REPORT_BOT_LOGINS="${REQUESTER_BOT_ACCOUNT:-}" \
        CI_REPORT_WRITE_TOKEN="$wt"
    exec python3 "$SCRIPT_DIR/ci_failure_report.py" "$@"
}

# 停止规则只有一条，主轮询和人工运行都照它：检查的整条进程链（检查程序 → gh → gh 起的任何进程）在
# 一个进程组里，要停就整组停、等到组里一个进程都不剩（ci_report_group_stop）；正常结束后也核对一次，
# 组里还有进程就停掉。只停检查程序或它直属的 gh，gh 起的后代还会在本脚本退出后把报告建出来
# （PR #393 复审第 4、5 轮）。
#   · 主轮询调用（CI_FAILURE_REPORT_IN_POLL=1）：本脚本已经是 ci_failure_report_tick 建的那一组的
#     组长，检查程序直接留在这一组里，由 tick 整组停
#   · 人工运行：本脚本自己给检查程序建一组（set -m，只为这一次启动），只停这一组——调用它的终端、
#     同一终端里的别的程序都不在组里，不会被误停
# 输出先落到文件、跑完再交出去（检查进日志，其余原样打印）。
OUT=$(mktemp "$STATE_DIR/.ci-failure-report.XXXXXX")
OWN_GROUP=no
if [ "${CI_FAILURE_REPORT_IN_POLL:-}" = 1 ]; then
    ( run_py "$MODE" ) > "$OUT" 2>&1 &
else
    set -m
    ( run_py "$MODE" ) > "$OUT" 2>&1 &
    set +m
    OWN_GROUP=yes
fi
PY=$!
stop_check() {
    local i=0
    if [ "$OWN_GROUP" = yes ]; then
        ci_report_group_stop "$PY" || true
    else
        # 组归主轮询管：这里只让检查程序先结束它正在等的那次 gh 调用，整组由 tick 收尾
        kill -TERM "$PY" 2>/dev/null || true
        while kill -0 "$PY" 2>/dev/null && [ "$i" -lt 15 ]; do sleep 0.2; i=$((i + 1)); done
        kill -KILL "$PY" 2>/dev/null || true
    fi
    wait "$PY" 2>/dev/null || true
    rm -f "$OUT"
}
trap 'stop_check; exit 143' TERM INT HUP
rc=0
wait "$PY" || rc=$?
if [ "$OWN_GROUP" = yes ] && ! ci_report_group_stop "$PY"; then
    echo "⚠️ 检查的进程组 $PY 停不干净，仍有进程在" >&2
fi
trap - TERM INT HUP
if [ "$MODE" != tick ]; then
    cat "$OUT"
    rm -f "$OUT"
    exit "$rc"
fi
while IFS= read -r line; do
    [ -n "$line" ] && log "$line"
done < "$OUT"
rm -f "$OUT"
[ "$rc" = 0 ] || log "⚠️ CI 失败报告：检查程序异常退出（退出码 ${rc}）"
exit 0
