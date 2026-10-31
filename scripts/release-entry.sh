#!/usr/bin/env bash
# Durable managed-release launcher. The deployed copy lives outside releases/,
# so cleanup cannot unlink the script before it has acquired a release lease.
set -euo pipefail

# 新旧名字的挑法与 scripts/_names.sh 的 cavil_pick 是同一条规则：新名字的在就用新的，
# 否则旧名字的在就用旧的，都不在按新的。本文件被复制到 releases/ 之外长期存放，
# source 不到发布目录里的 _names.sh，只好内联；tests/cavil-names.test.sh 对拍两边。
cavil_pick() {
    if [ -e "$1" ] || [ -L "$1" ]; then printf '%s\n' "$1"
    elif [ -e "$2" ] || [ -L "$2" ]; then printf '%s\n' "$2"
    else printf '%s\n' "$1"; fi
}
DEPLOY_CONF="${CAVIL_DEPLOY_CONF:-$(cavil_pick "$HOME/.config/cavil-loop/deploy.conf" "$HOME/.config/coding-agent-work-loop/deploy.conf")}"
[ ! -f "$DEPLOY_CONF" ] || { set -a; . "$DEPLOY_CONF"; set +a; }
DEPLOY_ROOT="${CAVIL_DEPLOY_ROOT:-$HOME/.agents/releases/cavil-loop}"
STABLE_LINK="${CAVIL_SKILL_LINK:-$(cavil_pick "$HOME/.agents/skills/cavil-loop" "$HOME/.agents/skills/coding-agent-work-loop")}"

case "$0" in
    */poll-entry.sh) relative="scripts/poll-entry.sh" ;;
    */drivers/token-usage/*.sh)
        relative="scripts/drivers/token-usage/$(basename "$0")"
        ;;
    */weekly-report/run.sh) relative="scripts/weekly-report/run.sh" ;;
    */notify-requester-bot.sh) relative="scripts/notify-requester-bot.sh" ;;   # worker 叫醒外部需求机器人（GitHub#95 / #97）
    */notify-relay.sh) relative="scripts/notify-relay.sh" ;;   # 同上的早期入口名，转发到新脚本
    *) echo "unknown managed entrypoint: $0" >&2; exit 2 ;;
esac

exec {GLOBAL_FD}<>"$DEPLOY_ROOT/.deploy.lock"
flock -s "$GLOBAL_FD"
release="$(readlink -f "$STABLE_LINK" 2>/dev/null || true)"
[ -n "$release" ] && [ -d "$release" ] || {
    echo "managed skill entry is unavailable: $STABLE_LINK" >&2
    exit 1
}
case "$release" in
    "$DEPLOY_ROOT/releases/"*)
        [ -f "$release/.inuse" ] || {
            echo "managed release has no lease file: $release" >&2
            exit 1
        }
        exec {LEASE_FD}<>"$release/.inuse"
        flock -s "$LEASE_FD"
        export CODING_AGENT_RELEASE_LEASE_FD="$LEASE_FD"
        ;;
esac
export CODING_AGENT_RELEASE_ROOT="$release"
flock -u "$GLOBAL_FD"
eval "exec ${GLOBAL_FD}>&-"

exec bash "$release/$relative" "$@"
