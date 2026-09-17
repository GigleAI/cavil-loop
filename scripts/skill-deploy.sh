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
FETCH_TIMEOUT="${CAVIL_DEPLOY_FETCH_TIMEOUT:-30}"
ALERT_AFTER="${CAVIL_DEPLOY_ALERT_AFTER:-1800}"
ALERT_REPO="${CAVIL_DEPLOY_ALERT_REPO:-GigleAI/cavil-loop}"
MIRROR="$DEPLOY_ROOT/mirror.git"
RELEASES="$DEPLOY_ROOT/releases"
LOCK="$DEPLOY_ROOT/.deploy.lock"
FETCH_LOCK="$DEPLOY_ROOT/.fetch.lock"
LAST_FETCH="$DEPLOY_ROOT/.last-fetch"
STATE="$DEPLOY_ROOT/deploy-state.json"
SYSTEMD_USER_DIR="${CAVIL_SYSTEMD_USER_DIR:-$HOME/.config/systemd/user}"

log_deploy() { printf '[skill-deploy] %s\n' "$*" >&2; }
trap 'rc=$?; log_deploy "unexpected failure (exit $rc); keeping the current release"; exit 0' ERR

mkdir -p "$DEPLOY_ROOT" "$RELEASES" "$(dirname "$STABLE_LINK")"
: > "$LOCK"
: > "$FETCH_LOCK"

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
exec {FETCH_FD}<>"$FETCH_LOCK"
if ! flock -n "$FETCH_FD"; then
    log_deploy "another instance is fetching; skip"
    exit 0
fi
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
    # Network work never holds the consumer/deploy lock. Bound it explicitly so
    # ExecStartPre also returns to the existing release in finite time.
    if ! timeout --foreground "$FETCH_TIMEOUT" git -C "$MIRROR" fetch --quiet --prune origin "+refs/heads/$BASE_BRANCH:refs/remotes/origin/$BASE_BRANCH"; then
        deploy_error="fetch origin/$BASE_BRANCH failed"
    fi
fi
# A failed attempt is throttled too; otherwise every project instance retries a
# slow/offline remote on every poll.
touch "$LAST_FETCH"
flock -u "$FETCH_FD"
eval "exec ${FETCH_FD}>&-"

exec {DEPLOY_FD}<>"$LOCK"
if ! flock -n "$DEPLOY_FD"; then
    log_deploy "a consumer or another publisher is active; keep current release"
    exit 0
fi

# Re-read after fetch: the stable link may have changed while no deploy lock was
# held. All publication and cleanup decisions below use this locked snapshot.
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

state_value() { jq -r --arg k "$1" '.[$k] // empty' "$STATE" 2>/dev/null || true; }
state_number() { local value; value="$(state_value "$1")"; printf '%s' "${value:-0}"; }
write_state() {
    local tmp scheduler_pending scheduler_reason scheduler_pending_since
    if [ "$#" -ge 8 ]; then scheduler_pending="$8"; else scheduler_pending="$(state_value scheduler_pending)"; fi
    if [ "$#" -ge 9 ]; then scheduler_reason="$9"; else scheduler_reason="$(state_value scheduler_reason)"; fi
    if [ "$#" -ge 10 ]; then scheduler_pending_since="${10}"; else scheduler_pending_since="$(state_value scheduler_pending_since)"; fi
    [ -n "$scheduler_pending" ] || scheduler_pending=0
    [ -n "$scheduler_pending_since" ] || scheduler_pending_since=0
    tmp=$(mktemp "$DEPLOY_ROOT/.state.XXXXXX")
    jq -n --arg current_sha "$1" --arg remote_sha "$2" \
        --argjson behind_since "$3" --argjson last_success_at "$4" \
        --arg lag_alert_issue "$5" --arg scheduler_alert_issue "$6" \
        --arg last_error "$7" --argjson scheduler_pending "$scheduler_pending" \
        --arg scheduler_reason "$scheduler_reason" --argjson scheduler_pending_since "$scheduler_pending_since" \
        '{current_sha:$current_sha,remote_sha:$remote_sha,behind_since:$behind_since,last_success_at:$last_success_at,lag_alert_issue:$lag_alert_issue,scheduler_alert_issue:$scheduler_alert_issue,scheduler_pending:$scheduler_pending,scheduler_reason:$scheduler_reason,scheduler_pending_since:$scheduler_pending_since,last_error:$last_error}' > "$tmp"
    mv "$tmp" "$STATE"
}

state_alert_issue() {
    local kind="$1" issue
    issue="$(state_value "${kind}_alert_issue")"
    if [ -z "$issue" ] && [ "$(state_value alert_kind)" = "$kind" ]; then
        # Read the pre-split schema once during rolling upgrades. The next state
        # write persists this issue in its kind-specific field.
        issue="$(state_value alert_issue)"
    fi
    printf '%s' "$issue"
}

open_alert() {
    local kind="$1" reason="$2" since="$3" issue body ending
    issue="$(state_alert_issue "$kind")"
    if alert_is_closed "$issue"; then
        issue=""
    fi
    [ -z "$issue" ] || { printf '%s' "$issue"; return 0; }
    if [ "$kind" = scheduler ]; then
        ending='请按运维文档完成操作并关闭本 issue；部署器看到人工确认后才会清除待处理状态。'
    else
        ending='请按运维文档处理；部署器会在恢复后自动关闭本 issue。'
    fi
    body=$(printf '当前 release：`%s`\n远端 SHA：`%s`\n开始落后：`%s`\n最近成功：`%s`\n原因：%s\n\n%s' \
        "${current_sha:-无}" "${remote_sha:-未知}" "$since" "$(state_number last_success_at)" "$reason" "$ending")
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

alert_is_closed() {
    local issue="$1" state
    [ -n "$issue" ] || return 1
    state="$(gh api "repos/$ALERT_REPO/issues/$issue" --jq .state 2>/dev/null || true)"
    [ "$state" = closed ]
}

record_lag_failure() {
    local reason="$1" behind_since lag_alert_issue scheduler_alert_issue
    behind_since="$(state_number behind_since)"; [ "$behind_since" -gt 0 ] || behind_since="$now"
    lag_alert_issue="$(state_alert_issue lag)"
    scheduler_alert_issue="$(state_alert_issue scheduler)"
    if [ $((now - behind_since)) -ge "$ALERT_AFTER" ]; then lag_alert_issue="$(open_alert lag "$reason" "$behind_since")"; fi
    write_state "$current_sha" "$remote_sha" "$behind_since" "$(state_number last_success_at)" \
        "$lag_alert_issue" "$scheduler_alert_issue" "$reason"
    log_deploy "$reason; keeping current release"
}

current_sha=""
case "$current" in "$RELEASES"/*) current_sha="$(basename "$current")" ;; esac
remote_sha="$(git -C "$MIRROR" rev-parse "refs/remotes/origin/$BASE_BRANCH" 2>/dev/null || true)"

if [ -n "$deploy_error" ] || [ -z "$remote_sha" ]; then
    # A failed fetch cannot prove that remote is ahead. Preserve an already
    # observed lag, but never invent one from an offline check alone.
    behind_since="$(state_number behind_since)"
    lag_alert_issue="$(state_alert_issue lag)"
    if [ "$behind_since" -gt 0 ] && [ $((now - behind_since)) -ge "$ALERT_AFTER" ]; then
        lag_alert_issue="$(open_alert lag "${deploy_error:-remote SHA unavailable}" "$behind_since")"
    fi
    write_state "$current_sha" "${remote_sha:-$(state_value remote_sha)}" "$behind_since" "$(state_number last_success_at)" \
        "$lag_alert_issue" "$(state_alert_issue scheduler)" "${deploy_error:-remote SHA unavailable}"
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

install_entrypoints() {
    local root="$DEPLOY_ROOT/entrypoints" src="$target/scripts/release-entry.sh" tmp driver
    [ -f "$src" ] || { log_deploy "release is missing scripts/release-entry.sh"; return 1; }
    mkdir -p "$root/drivers/token-usage" "$root/weekly-report"
    tmp=$(mktemp "$root/.release-entry.XXXXXX")
    cp "$src" "$tmp"
    chmod +x "$tmp"
    mv "$tmp" "$root/release-entry.sh"
    ln -sfn release-entry.sh "$root/poll-entry.sh"
    for driver in "$target"/scripts/drivers/token-usage/*.sh; do
        [ -f "$driver" ] || continue
        ln -sfn ../../release-entry.sh "$root/drivers/token-usage/$(basename "$driver")"
    done
    ln -sfn ../release-entry.sh "$root/weekly-report/run.sh"
}
install_entrypoints || { record_lag_failure "installing durable entrypoints failed"; exit 0; }

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

if [ "$BOOTSTRAP" -eq 1 ] && [ "$(uname -s)" = Linux ] && [ -d "$target/systemd" ]; then
    # Old setup versions linked installed templates to a checkout. An explicit
    # bootstrap is the migration boundary: repoint existing template symlinks
    # to the stable managed skill, but do not install units that were absent.
    mkdir -p "$SYSTEMD_USER_DIR"
    for unit_src in "$target"/systemd/*; do
        [ -f "$unit_src" ] || continue
        unit_dst="$SYSTEMD_USER_DIR/$(basename "$unit_src")"
        [ -L "$unit_dst" ] || continue
        # Bootstrap can replace an entity at the same stable path. The unit
        # link text then stays unchanged, but its target content changed and
        # the user manager still needs to reload the template.
        scheduler_reload=1
        managed_unit="$STABLE_LINK/systemd/$(basename "$unit_src")"
        if [ "$(readlink "$unit_dst")" != "$managed_unit" ]; then
            ln -sfn "$managed_unit" "$unit_dst"
            scheduler_reload=1
            log_deploy "migrated systemd template $(basename "$unit_src") to the managed skill"
        fi
    done
fi

if [ "$scheduler_reload" -eq 1 ]; then
    if command -v systemctl >/dev/null 2>&1 && systemctl --user daemon-reload; then
        log_deploy "systemd daemon-reload complete"
    else
        log_deploy "systemd daemon-reload failed; manual action required"
        manual_scheduler=1
    fi
fi
previous_lag_alert="$(state_alert_issue lag)"
previous_scheduler_alert="$(state_alert_issue scheduler)"
previous_scheduler_pending="$(state_value scheduler_pending)"
previous_scheduler_reason="$(state_value scheduler_reason)"
previous_scheduler_pending_since="$(state_value scheduler_pending_since)"
[ -n "$previous_scheduler_pending" ] || [ -z "$previous_scheduler_alert" ] || previous_scheduler_pending=1
if [ "$previous_scheduler_pending" = 1 ] && [ -z "$previous_scheduler_pending_since" ]; then
    previous_scheduler_pending_since="$(state_number last_success_at)"
fi
if [ "$previous_scheduler_pending" = 1 ] && [ -z "$previous_scheduler_reason" ]; then
    previous_scheduler_reason="调度配置仍待人工处理。"
fi
if [ "$manual_scheduler" -eq 1 ]; then
    log_deploy ".socket/.slice or launchd template changed; apply it manually (rerun setup on macOS)"
    previous_scheduler_pending=1
    previous_scheduler_reason="调度配置含不能安全自动应用的变更；Linux 请检查 .socket/.slice，macOS 请重跑 setup.sh。"
    previous_scheduler_pending_since="${previous_scheduler_pending_since:-$now}"
    scheduler_alert_issue="$(open_alert scheduler "$previous_scheduler_reason" "$previous_scheduler_pending_since")"
else
    scheduler_alert_issue="$previous_scheduler_alert"
    if [ "$previous_scheduler_pending" = 1 ]; then
        # A successful no-change deploy cannot prove that the operator applied
        # a socket/slice/plist change or repaired daemon-reload. Retry a failed
        # notification, and use human closure—not deployment success—as the
        # acknowledgement that clears the pending fact.
        if [ -n "$scheduler_alert_issue" ] && alert_is_closed "$scheduler_alert_issue"; then
            scheduler_alert_issue=""
            previous_scheduler_pending=0
            previous_scheduler_reason=""
            previous_scheduler_pending_since=0
        elif [ -z "$scheduler_alert_issue" ]; then
            scheduler_alert_issue="$(open_alert scheduler "$previous_scheduler_reason" "$previous_scheduler_pending_since")"
        fi
    fi
fi
if close_alert "$previous_lag_alert"; then previous_lag_alert=""; fi
if [ "$previous_scheduler_pending" = 1 ]; then
    last_error="manual scheduler action still pending"
else
    last_error=""
fi
write_state "$current_sha" "$remote_sha" 0 "$now" "$previous_lag_alert" "$scheduler_alert_issue" "$last_error" \
    "$previous_scheduler_pending" "$previous_scheduler_reason" "$previous_scheduler_pending_since"

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
