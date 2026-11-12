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

run_py() {
    local wt=""
    [ -z "${WRITE_GH_TOKEN:-}" ] || wt="$WRITE_GH_TOKEN"
    CI_REPORT_REPO="$REPO" \
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
    CI_REPORT_WRITE_TOKEN="$wt" \
        python3 "$SCRIPT_DIR/ci_failure_report.py" "$@"
}

if [ "$MODE" != tick ]; then
    run_py "$MODE"
    exit $?
fi

rc=0
while IFS= read -r line; do
    [ -n "$line" ] && log "$line"
done < <(run_py tick 2>&1 || echo "⚠️ CI 失败报告：检查程序异常退出（退出码 $?）")
exit "$rc"
