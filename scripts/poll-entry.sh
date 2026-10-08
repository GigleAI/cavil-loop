#!/usr/bin/env bash
set -euo pipefail

# Take the shared side before resolving the executing inode. Cleanup takes the
# exclusive side, so it cannot remove an old release in the resolve→lease gap.
DEPLOY_CONF="${CAVIL_DEPLOY_CONF:-$HOME/.config/coding-agent-work-loop/deploy.conf}"
[ ! -f "$DEPLOY_CONF" ] || { set -a; . "$DEPLOY_CONF"; set +a; }
DEPLOY_ROOT="${CAVIL_DEPLOY_ROOT:-$HOME/.agents/releases/cavil-loop}"
if [ -f "$DEPLOY_ROOT/.deploy.lock" ]; then exec {GLOBAL_FD}<>"$DEPLOY_ROOT/.deploy.lock"; flock -s "$GLOBAL_FD"; fi
# /proc points at the inode bash is currently executing, even if the stable link switches.
SELF="$(readlink "/proc/$$/fd/255" 2>/dev/null || readlink -f "${BASH_SOURCE[0]}")"
SELF_DIR="$(dirname "$SELF")"
CODING_AGENT_RELEASE_ROOT="$(dirname "$SELF_DIR")"
if [ "$(basename "$(dirname "$CODING_AGENT_RELEASE_ROOT")")" = releases ] && [ -f "$CODING_AGENT_RELEASE_ROOT/.inuse" ]; then
    exec {LEASE_FD}<>"$CODING_AGENT_RELEASE_ROOT/.inuse"; flock -s "$LEASE_FD"
    export CODING_AGENT_RELEASE_LEASE_FD="$LEASE_FD"

    # Rollout bridge: the deployer from the preceding release cannot know how
    # to install this release's new durable launchers. The first new poll runs
    # while holding the shared deploy lock and seeds them before dispatching a
    # worker, so that worker's later token-usage call is safe as well.
    ENTRY_ROOT="$DEPLOY_ROOT/entrypoints"
    if [ ! -f "$ENTRY_ROOT/poll-entry.sh" ] && [ -f "$CODING_AGENT_RELEASE_ROOT/scripts/release-entry.sh" ]; then
        mkdir -p "$ENTRY_ROOT/drivers/token-usage" "$ENTRY_ROOT/weekly-report"
        ENTRY_TMP=$(mktemp "$ENTRY_ROOT/.release-entry.XXXXXX")
        cp "$CODING_AGENT_RELEASE_ROOT/scripts/release-entry.sh" "$ENTRY_TMP"
        chmod +x "$ENTRY_TMP"
        mv "$ENTRY_TMP" "$ENTRY_ROOT/release-entry.sh"
        ln -sfn release-entry.sh "$ENTRY_ROOT/poll-entry.sh"
        for driver in "$CODING_AGENT_RELEASE_ROOT"/scripts/drivers/token-usage/*.sh; do
            [ -f "$driver" ] || continue
            ln -sfn ../../release-entry.sh "$ENTRY_ROOT/drivers/token-usage/$(basename "$driver")"
        done
        ln -sfn ../release-entry.sh "$ENTRY_ROOT/weekly-report/run.sh"
    fi
fi
[ -z "${GLOBAL_FD:-}" ] || { flock -u "$GLOBAL_FD"; eval "exec ${GLOBAL_FD}>&-"; }
export CODING_AGENT_RELEASE_ROOT
exec bash "$CODING_AGENT_RELEASE_ROOT/scripts/agent-poll.sh" "$@"
