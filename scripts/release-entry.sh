#!/usr/bin/env bash
# Durable managed-release launcher. The deployed copy lives outside releases/,
# so cleanup cannot unlink the script before it has acquired a release lease.
set -euo pipefail

DEPLOY_CONF="${CAVIL_DEPLOY_CONF:-$HOME/.config/coding-agent-work-loop/deploy.conf}"
[ ! -f "$DEPLOY_CONF" ] || { set -a; . "$DEPLOY_CONF"; set +a; }
DEPLOY_ROOT="${CAVIL_DEPLOY_ROOT:-$HOME/.agents/releases/cavil-loop}"
STABLE_LINK="${CAVIL_SKILL_LINK:-$HOME/.agents/skills/coding-agent-work-loop}"

case "$0" in
    */poll-entry.sh) relative="scripts/poll-entry.sh" ;;
    */drivers/token-usage/*.sh)
        relative="scripts/drivers/token-usage/$(basename "$0")"
        ;;
    */weekly-report/run.sh) relative="scripts/weekly-report/run.sh" ;;
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
