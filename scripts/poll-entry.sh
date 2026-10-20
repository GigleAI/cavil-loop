#!/usr/bin/env bash
set -euo pipefail

# Take the shared side before resolving the executing inode. Cleanup takes the
# exclusive side, so it cannot remove an old release in the resolve→lease gap.
# shellcheck source=_names.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_names.sh"
DEPLOY_CONF="${CAVIL_DEPLOY_CONF:-$(cavil_deploy_conf)}"
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

# 改名前的旧安装（GigleAI/cavil-loop#71）：任何一个项目的这一轮都顺手把本机空闲的旧项目迁到
# 新名字。必须在 agent-poll.sh 之前——它一 source _lib.sh 就会 mkdir 配置里的状态目录，
# 迁到一半时会在旧位置凭空建出一个空目录。迁移自己出任何问题都不能挡住本轮轮询。
# macOS 不在这里迁：LaunchAgent 要靠重跑 setup.sh 重新生成。
if [ "$(uname -s)" = Linux ] && compgen -G "$CAVIL_LEGACY_CONFIG_HOME/*.conf" >/dev/null \
   && [ -f "$CODING_AGENT_RELEASE_ROOT/scripts/migrate-legacy.sh" ]; then
    MIGRATED="$(bash "$CODING_AGENT_RELEASE_ROOT/scripts/migrate-legacy.sh" --all || true)"
    # 刚迁的正是本项目：这一轮是旧后台任务起的，让位给已经接手的新任务（它 30 秒内会跑第一轮）。
    if [ -n "${CODING_AGENT_CONFIG:-}" ] && printf '%s\n' "$MIGRATED" | cut -f3 | grep -qxF "$CODING_AGENT_CONFIG"; then
        exit 0
    fi
fi
exec bash "$CODING_AGENT_RELEASE_ROOT/scripts/agent-poll.sh" "$@"
