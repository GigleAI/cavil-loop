#!/usr/bin/env bash
# Publish immutable releases and atomically switch the stable skill link.
set -Eeuo pipefail

FORCE=0
BOOTSTRAP=0
for arg in "$@"; do
    case "$arg" in
        --force) FORCE=1 ;;
        --bootstrap) BOOTSTRAP=1 ;;
        *) echo "unknown argument: $arg" >&2; exit 2 ;;
    esac
done

DEPLOY_CONF="${CAVIL_DEPLOY_CONF:-$HOME/.config/coding-agent-work-loop/deploy.conf}"
[ ! -f "$DEPLOY_CONF" ] || { set -a; . "$DEPLOY_CONF"; set +a; }
DEPLOY_ROOT="${CAVIL_DEPLOY_ROOT:-$HOME/.agents/releases/cavil-loop}"
STABLE_LINK="${CAVIL_SKILL_LINK:-$HOME/.agents/skills/coding-agent-work-loop}"

SOURCE_DIR="${CAVIL_DEPLOY_SOURCE_DIR:-}"
SOURCE_REMOTE=""
if [ -n "$SOURCE_DIR" ]; then
    SOURCE_REMOTE="$(git -C "$SOURCE_DIR" remote get-url origin 2>/dev/null || true)"
fi
MIRROR_REMOTE="$(git -C "$DEPLOY_ROOT/mirror.git" remote get-url origin 2>/dev/null || true)"
REPO_URL="${CAVIL_DEPLOY_REPO:-${SOURCE_REMOTE:-${MIRROR_REMOTE:-https://github.com/GigleAI/cavil-loop.git}}}"
BASE_BRANCH="${CAVIL_DEPLOY_BRANCH:-main}"
FETCH_INTERVAL="${CAVIL_DEPLOY_FETCH_INTERVAL:-300}"
ALERT_AFTER="${CAVIL_DEPLOY_ALERT_AFTER:-1800}"
ALERT_REPO="${CAVIL_DEPLOY_ALERT_REPO:-GigleAI/cavil-loop}"
MIRROR="$DEPLOY_ROOT/mirror.git"
RELEASES="$DEPLOY_ROOT/releases"
LOCK="$DEPLOY_ROOT/.deploy.lock"
LAST_FETCH="$DEPLOY_ROOT/.last-fetch"
STATE="$DEPLOY_ROOT/deploy-state.json"

log_deploy() { printf '[skill-deploy] %s\n' "$*" >&2; }
trap 'rc=$?; log_deploy "unexpected failure (exit $rc); keeping the current release"; exit 0' ERR

mkdir -p "$DEPLOY_ROOT" "$RELEASES" "$(dirname "$STABLE_LINK")"
: > "$LOCK"
exec {DEPLOY_FD}<>"$LOCK"
if ! flock -n "$DEPLOY_FD"; then
    log_deploy "another instance is deploying; skip"
    exit 0
fi

current=""
if [ -L "$STABLE_LINK" ]; then current="$(readlink -f "$STABLE_LINK" 2>/dev/null || true)"; fi
if [ -d "$STABLE_LINK" ] && [ ! -L "$STABLE_LINK" ]; then
    current="$(cd "$STABLE_LINK" && pwd -P)"
fi
case "$current" in
    "$RELEASES"/*) ;;
    "") ;;
    *)
        if [ "$BOOTSTRAP" -ne 1 ]; then
            log_deploy "development mode ($STABLE_LINK -> $current); not taking over"
            exit 0
        fi
        ;;
esac

now=$(date +%s)
if [ "$FORCE" -ne 1 ] && [ -f "$LAST_FETCH" ]; then
    last=$(stat -c %Y "$LAST_FETCH" 2>/dev/null || echo 0)
    if [ $((now - last)) -lt "$FETCH_INTERVAL" ]; then
        log_deploy "fetch throttled"
        exit 0
    fi
fi

deploy_error=""
if [ ! -d "$MIRROR" ]; then
    git init --bare "$MIRROR" >/dev/null 2>&1 || deploy_error="cannot initialise mirror"
    [ -n "$deploy_error" ] || git -C "$MIRROR" remote add origin "$REPO_URL" || deploy_error="cannot configure mirror"
fi
if [ -z "$deploy_error" ]; then
    git -C "$MIRROR" remote set-url origin "$REPO_URL" >/dev/null 2>&1 || true
    if ! git -C "$MIRROR" fetch --quiet --prune origin "+refs/heads/$BASE_BRANCH:refs/remotes/origin/$BASE_BRANCH"; then
        deploy_error="fetch origin/$BASE_BRANCH failed"
    else
        touch "$LAST_FETCH"
    fi
fi

state_value() { jq -r --arg k "$1" '.[$k] // empty' "$STATE" 2>/dev/null || true; }
state_number() { local value; value="$(state_value "$1")"; printf '%s' "${value:-0}"; }
write_state() {
    local tmp
    tmp=$(mktemp "$DEPLOY_ROOT/.state.XXXXXX")
    jq -n --arg current_sha "$1" --arg remote_sha "$2" \
        --argjson behind_since "$3" --argjson last_success_at "$4" \
        --arg alert_issue "$5" --arg last_error "$6" --arg alert_kind "${7:-}" \
        '{current_sha:$current_sha,remote_sha:$remote_sha,behind_since:$behind_since,last_success_at:$last_success_at,alert_issue:$alert_issue,alert_kind:$alert_kind,last_error:$last_error}' > "$tmp"
    mv "$tmp" "$STATE"
}

open_alert() {
    local kind="$1" reason="$2" since="$3" issue body
    issue="$(state_value alert_issue)"
    [ -z "$issue" ] || { printf '%s' "$issue"; return 0; }
    body=$(printf '当前 release：`%s`\n远端 SHA：`%s`\n开始落后：`%s`\n最近成功：`%s`\n原因：%s\n\n请按运维文档处理；部署器会在恢复后自动关闭本 issue。' \
        "${current_sha:-无}" "${remote_sha:-未知}" "$since" "$(state_number last_success_at)" "$reason")
    issue=$(gh api -X POST "repos/$ALERT_REPO/issues" \
        -f title="coding-agent skill 部署需要处理" -f body="$body" \
        -f 'labels[]=pending/human' --jq .number 2>/dev/null || true)
    [ -z "$issue" ] && log_deploy "failed to create deployment alert in $ALERT_REPO"
    printf '%s' "$issue"
}

close_alert() {
    local issue="$1"
    [ -n "$issue" ] || return 0
    if gh api -X PATCH "repos/$ALERT_REPO/issues/$issue" -f state=closed >/dev/null 2>&1; then
        log_deploy "closed recovered deployment alert #$issue"
    else
        log_deploy "failed to close recovered deployment alert #$issue"
        return 1
    fi
}

record_lag_failure() {
    local reason="$1" behind_since alert_issue
    behind_since="$(state_number behind_since)"; [ "$behind_since" -gt 0 ] || behind_since="$now"
    alert_issue="$(state_value alert_issue)"
    if [ $((now - behind_since)) -ge "$ALERT_AFTER" ]; then alert_issue="$(open_alert lag "$reason" "$behind_since")"; fi
    write_state "$current_sha" "$remote_sha" "$behind_since" "$(state_number last_success_at)" "$alert_issue" "$reason" "lag"
    log_deploy "$reason; keeping current release"
}

current_sha=""
case "$current" in "$RELEASES"/*) current_sha="$(basename "$current")" ;; esac
remote_sha="$(git -C "$MIRROR" rev-parse "refs/remotes/origin/$BASE_BRANCH" 2>/dev/null || true)"

if [ -n "$deploy_error" ] || [ -z "$remote_sha" ]; then
    # A failed fetch cannot prove that remote is ahead. Preserve an already
    # observed lag, but never invent one from an offline check alone.
    behind_since="$(state_number behind_since)"
    alert_issue="$(state_value alert_issue)"
    if [ "$behind_since" -gt 0 ] && [ $((now - behind_since)) -ge "$ALERT_AFTER" ]; then
        alert_issue="$(open_alert lag "${deploy_error:-remote SHA unavailable}" "$behind_since")"
    fi
    write_state "$current_sha" "${remote_sha:-$(state_value remote_sha)}" "$behind_since" "$(state_number last_success_at)" "$alert_issue" "${deploy_error:-remote SHA unavailable}" "$(state_value alert_kind)"
    log_deploy "${deploy_error:-remote SHA unavailable}; keeping current release"
    exit 0
fi

target="$RELEASES/$remote_sha"
if [ ! -d "$target" ]; then
    tmp=$(mktemp -d "$RELEASES/.unpack.XXXXXX")
    if ! git -C "$MIRROR" archive "$remote_sha" | tar -x -C "$tmp"; then
        rm -rf -- "$tmp"
        record_lag_failure "archive failed"
        exit 0
    fi
    : > "$tmp/.inuse"
    if ! mv "$tmp" "$target"; then
        rm -rf -- "$tmp"
        record_lag_failure "publishing release directory failed"
        exit 0
    fi
fi

scheduler_reload=0
manual_scheduler=0
case "$current" in
"$RELEASES"/*)
    if [ -d "$current/systemd" ] && [ -d "$target/systemd" ]; then
        scheduler_changes="$(diff -qr "$current/systemd" "$target/systemd" 2>/dev/null || true)"
        grep -E '\.(service|timer)( |$)' <<< "$scheduler_changes" >/dev/null && scheduler_reload=1 || true
        grep -E '\.(socket|slice)( |$)' <<< "$scheduler_changes" >/dev/null && manual_scheduler=1 || true
    fi
    if [ -d "$current/launchd" ] && [ -d "$target/launchd" ]; then
        diff -qr "$current/launchd" "$target/launchd" >/dev/null 2>&1 || manual_scheduler=1
    fi
    ;;
esac

link_tmp="$(dirname "$STABLE_LINK")/.coding-agent-work-loop.$$.link"
if ! ln -s "$target" "$link_tmp"; then record_lag_failure "creating replacement link failed"; exit 0; fi
if [ -e "$STABLE_LINK" ] && [ ! -L "$STABLE_LINK" ]; then
    if [ "$BOOTSTRAP" -ne 1 ]; then
        rm -f -- "$link_tmp"
        log_deploy "stable path is a directory; --bootstrap is required"
        exit 0
    fi
    backup="$STABLE_LINK.pre-managed.$(date +%Y%m%d%H%M%S)"
    if ! mv "$STABLE_LINK" "$backup"; then rm -f -- "$link_tmp"; record_lag_failure "preserving previous skill directory failed"; exit 0; fi
    log_deploy "preserved previous skill directory at $backup"
fi
if ! mv -Tf "$link_tmp" "$STABLE_LINK"; then rm -f -- "$link_tmp"; record_lag_failure "switching stable link failed"; exit 0; fi
current_sha="$remote_sha"
log_deploy "activated $remote_sha"

if [ "$scheduler_reload" -eq 1 ] && command -v systemctl >/dev/null 2>&1; then
    systemctl --user daemon-reload && log_deploy "systemd daemon-reload complete" || { log_deploy "systemd daemon-reload failed; manual action required"; manual_scheduler=1; }
fi
previous_alert="$(state_value alert_issue)"
if [ "$manual_scheduler" -eq 1 ]; then
    log_deploy ".socket/.slice or launchd template changed; apply it manually (rerun setup on macOS)"
    alert_issue="$(open_alert scheduler "调度配置含不能安全自动应用的变更；Linux 请检查 .socket/.slice，macOS 请重跑 setup.sh。" "$now")"
    write_state "$current_sha" "$remote_sha" 0 "$now" "$alert_issue" "manual scheduler action required" "scheduler"
else
    if close_alert "$previous_alert"; then previous_alert=""; fi
    write_state "$current_sha" "$remote_sha" 0 "$now" "$previous_alert" "" ""
fi

# Safe because every candidate is a direct child of the validated releases root;
# an exclusive .inuse lock proves no managed consumer still uses it.
for old in "$RELEASES"/*; do
    [ -d "$old" ] || continue
    [ "$old" != "$target" ] || continue
    [ -f "$old/.inuse" ] || continue
    exec {OLD_FD}<>"$old/.inuse"
    if flock -n -x "$OLD_FD"; then rm -rf -- "$old"; fi
    eval "exec ${OLD_FD}>&-"
done

exit 0
