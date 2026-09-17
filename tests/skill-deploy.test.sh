#!/usr/bin/env bash
# Immutable skill releases, atomic switching and consumer leases.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export HOME="$TMP/home"
mkdir -p "$HOME"

REMOTE="$TMP/remote.git"
SRC="$TMP/source"
git init --bare "$REMOTE" >/dev/null
git init -b main "$SRC" >/dev/null
git -C "$SRC" config user.email test@example.invalid
git -C "$SRC" config user.name test
git -C "$SRC" remote add origin "$REMOTE"

mkdir -p "$SRC/scripts/drivers/token-usage" "$SRC/scripts/weekly-report"
mkdir -p "$SRC/systemd" "$SRC/launchd"
cp "$REPO_DIR/scripts/skill-deploy.sh" "$SRC/scripts/skill-deploy.sh"
cp "$REPO_DIR/scripts/poll-entry.sh" "$SRC/scripts/poll-entry.sh"
cp "$REPO_DIR/scripts/release-entry.sh" "$SRC/scripts/release-entry.sh"
cat > "$SRC/scripts/agent-poll.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
touch "$TEST_STARTED"
while [ ! -f "$TEST_CONTINUE" ]; do sleep 0.01; done
cat "$CODING_AGENT_RELEASE_ROOT/data"
SH
for driver in claude codex; do
    cat > "$SRC/scripts/drivers/token-usage/$driver.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
cat "$CODING_AGENT_RELEASE_ROOT/data"
SH
done
cat > "$SRC/scripts/weekly-report/run.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
cat "$CODING_AGENT_RELEASE_ROOT/data"
SH
printf 'v1\n' > "$SRC/data"
printf 'service-v1\n' > "$SRC/systemd/poll.service"
printf 'managed-service-v1\n' > "$SRC/systemd/coding-agent-poll@.service"
printf 'socket-v1\n' > "$SRC/systemd/preview.socket"
printf 'plist-v1\n' > "$SRC/launchd/poll.plist.template"
git -C "$SRC" add .
git -C "$SRC" commit -m v1 >/dev/null
git -C "$SRC" push -u origin main >/dev/null

export CAVIL_DEPLOY_ROOT="$HOME/.agents/releases/cavil-loop"
export CAVIL_SKILL_LINK="$HOME/.agents/skills/coding-agent-work-loop"
export CAVIL_DEPLOY_REPO="$REMOTE"
export CAVIL_DEPLOY_BRANCH=main

deploy() { bash "$REPO_DIR/scripts/skill-deploy.sh" --force "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "✓ $*"; }

echo '▶ bootstrap publishes an immutable release and stable link'
deploy --bootstrap >/dev/null
V1=$(git -C "$SRC" rev-parse HEAD)
[ "$(readlink -f "$CAVIL_SKILL_LINK")" = "$CAVIL_DEPLOY_ROOT/releases/$V1" ] || fail bootstrap
[ -f "$CAVIL_DEPLOY_ROOT/releases/$V1/.inuse" ] || fail lease-file
[ -f "$CAVIL_DEPLOY_ROOT/entrypoints/poll-entry.sh" ] || fail durable-entrypoint
pass bootstrap

echo '▶ a running consumer stays on v1 while the stable link moves to v2'
TEST_STARTED="$TMP/started" TEST_CONTINUE="$TMP/continue" \
    bash "$CAVIL_DEPLOY_ROOT/entrypoints/poll-entry.sh" > "$TMP/output" &
consumer=$!
for _ in $(seq 1 200); do [ -f "$TMP/started" ] && break; sleep 0.01; done
[ -f "$TMP/started" ] || fail consumer-start
printf 'v2\n' > "$SRC/data"
git -C "$SRC" add data
git -C "$SRC" commit -m v2 >/dev/null
git -C "$SRC" push >/dev/null
deploy >/dev/null
V2=$(git -C "$SRC" rev-parse HEAD)
[ "$(readlink -f "$CAVIL_SKILL_LINK")" = "$CAVIL_DEPLOY_ROOT/releases/$V2" ] || fail switch
[ -d "$CAVIL_DEPLOY_ROOT/releases/$V1" ] || fail leased-release-was-deleted
touch "$TMP/continue"
wait "$consumer"
[ "$(cat "$TMP/output")" = v1 ] || fail mixed-version
deploy >/dev/null
[ ! -e "$CAVIL_DEPLOY_ROOT/releases/$V1" ] || fail released-version-not-cleaned
pass version-pin-and-lease

echo '▶ the first new poll can seed entrypoints after an old deployer switches it'
rm -rf "$CAVIL_DEPLOY_ROOT/entrypoints"
TEST_STARTED="$TMP/bridge-started" TEST_CONTINUE="$TMP/continue" \
    bash "$CAVIL_SKILL_LINK/scripts/poll-entry.sh" > "$TMP/bridge.out"
[ -f "$CAVIL_DEPLOY_ROOT/entrypoints/poll-entry.sh" ] || fail rollout-bridge-did-not-seed
[ "$(cat "$TMP/bridge.out")" = v2 ] || fail rollout-bridge-wrong-release
pass rollout-bridge

echo '▶ durable entrypoints survive cleanup before their first lock'
DEPLOY_CONF="$TMP/deploy.conf"
export CAVIL_DEPLOY_CONF="$DEPLOY_CONF" TEST_PAUSE_ROOT="$TMP/entry-pauses"
mkdir -p "$TEST_PAUSE_ROOT"
cat > "$DEPLOY_CONF" <<'SH'
if [ -n "${CAVIL_ENTRY_TEST_PAUSE:-}" ]; then
    touch "$TEST_PAUSE_ROOT/$CAVIL_ENTRY_TEST_PAUSE.started"
    while [ ! -f "$TEST_PAUSE_ROOT/$CAVIL_ENTRY_TEST_PAUSE.continue" ]; do sleep 0.01; done
fi
SH
touch "$TMP/continue"
export TEST_STARTED="$TMP/durable-poll-started" TEST_CONTINUE="$TMP/continue"
entries=(
    poll-entry.sh
    drivers/token-usage/claude.sh
    drivers/token-usage/codex.sh
    weekly-report/run.sh
)
pids=()
for entry in "${entries[@]}"; do
    name="${entry//\//-}"
    CAVIL_ENTRY_TEST_PAUSE="$name" \
        bash "$CAVIL_DEPLOY_ROOT/entrypoints/$entry" > "$TEST_PAUSE_ROOT/$name.out" &
    pids+=("$!")
done
for entry in "${entries[@]}"; do
    name="${entry//\//-}"
    for _ in $(seq 1 200); do [ -f "$TEST_PAUSE_ROOT/$name.started" ] && break; sleep 0.01; done
    [ -f "$TEST_PAUSE_ROOT/$name.started" ] || fail "$name-did-not-pause"
done
printf 'v3\n' > "$SRC/data"
git -C "$SRC" add data
git -C "$SRC" commit -m v3 >/dev/null
git -C "$SRC" push >/dev/null
deploy >/dev/null
[ ! -e "$CAVIL_DEPLOY_ROOT/releases/$V2" ] || fail pre-lock-old-release-not-cleaned
for entry in "${entries[@]}"; do
    name="${entry//\//-}"
    touch "$TEST_PAUSE_ROOT/$name.continue"
done
for pid in "${pids[@]}"; do wait "$pid" || fail durable-entry-exited; done
for entry in "${entries[@]}"; do
    name="${entry//\//-}"
    [ "$(cat "$TEST_PAUSE_ROOT/$name.out")" = v3 ] || fail "$name-used-deleted-release"
done
unset CAVIL_DEPLOY_CONF
pass durable-pre-lock-entrypoints

echo '▶ lease age does not make an active release deletable'
OLD="$CAVIL_DEPLOY_ROOT/releases/old-active"
mkdir -p "$OLD"; : > "$OLD/.inuse"; touch -d '2 days ago' "$OLD" "$OLD/.inuse"
( exec 9<>"$OLD/.inuse"; flock -s 9; touch "$TMP/old-locked"; while [ ! -f "$TMP/unlock" ]; do sleep 0.01; done ) &
locker=$!
for _ in $(seq 1 200); do [ -f "$TMP/old-locked" ] && break; sleep 0.01; done
deploy >/dev/null
[ -d "$OLD" ] || fail active-old-release-deleted
touch "$TMP/unlock"; wait "$locker"
deploy >/dev/null
[ ! -e "$OLD" ] || fail inactive-old-release-not-deleted
pass no-age-heuristic

echo '▶ service/timer reload automatically; socket/launchd changes alert'
mkdir -p "$TMP/fakebin"
cat > "$TMP/fakebin/systemctl" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$TEST_SYSTEMCTL_LOG"
SH
cat > "$TMP/fakebin/gh" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$TEST_GH_LOG"
case " $* " in
    *' -X POST '* )
        if [ "${TEST_ALERT_FAIL:-0}" = 1 ]; then exit 1; fi
        ;;
esac
case " $* " in
    *' -X POST '*'switching stable link failed'*) printf '78\n'; exit 0 ;;
    *' -X POST '*) printf '77\n' ;;
esac
case " $* " in
    *' repos/GigleAI/cavil-loop/issues/77 --jq .state '*)
        [ "${TEST_ALERT_CLOSED:-0}" = 1 ] && printf 'closed\n'
        ;;
esac
SH
chmod +x "$TMP/fakebin/systemctl" "$TMP/fakebin/gh"
export TEST_SYSTEMCTL_LOG="$TMP/systemctl.log" TEST_GH_LOG="$TMP/gh.log"
printf 'service-v2\n' > "$SRC/systemd/poll.service"
git -C "$SRC" add systemd/poll.service
git -C "$SRC" commit -m service-v2 >/dev/null
git -C "$SRC" push >/dev/null
PATH="$TMP/fakebin:$PATH" deploy >/dev/null
grep -qx -- '--user daemon-reload' "$TEST_SYSTEMCTL_LOG" || fail daemon-reload
[ ! -e "$TEST_GH_LOG" ] || fail service-change-alerted

printf 'socket-v2\n' > "$SRC/systemd/preview.socket"
git -C "$SRC" add systemd/preview.socket
git -C "$SRC" commit -m socket-v2 >/dev/null
git -C "$SRC" push >/dev/null
PATH="$TMP/fakebin:$PATH" deploy >/dev/null
grep -q -- '-X POST repos/GigleAI/cavil-loop/issues' "$TEST_GH_LOG" || fail manual-change-not-alerted
[ "$(jq -r .scheduler_alert_issue "$CAVIL_DEPLOY_ROOT/deploy-state.json")" = 77 ] || fail alert-not-recorded
PATH="$TMP/fakebin:$PATH" deploy >/dev/null
! grep -q -- '-X PATCH repos/GigleAI/cavil-loop/issues/77' "$TEST_GH_LOG" || fail manual-alert-auto-closed
[ "$(jq -r .scheduler_alert_issue "$CAVIL_DEPLOY_ROOT/deploy-state.json")" = 77 ] || fail manual-alert-forgotten

echo '▶ deployment failure and recovery preserve a pending scheduler alert'
cat > "$TMP/fakebin/mv" <<'SH'
#!/usr/bin/env bash
if [ "${1:-}" = -Tf ]; then exit 1; fi
exec /usr/bin/mv "$@"
SH
chmod +x "$TMP/fakebin/mv"
printf 'data-after-scheduler-alert\n' > "$SRC/data"
git -C "$SRC" add data
git -C "$SRC" commit -m data-after-scheduler-alert >/dev/null
git -C "$SRC" push >/dev/null
PATH="$TMP/fakebin:$PATH" CAVIL_DEPLOY_ALERT_AFTER=0 deploy >/dev/null
[ "$(jq -r .scheduler_alert_issue "$CAVIL_DEPLOY_ROOT/deploy-state.json")" = 77 ] || fail failure-overwrote-scheduler-alert
[ -n "$(jq -r '.lag_alert_issue // empty' "$CAVIL_DEPLOY_ROOT/deploy-state.json")" ] || fail failure-did-not-record-lag-alert
rm "$TMP/fakebin/mv"
PATH="$TMP/fakebin:$PATH" deploy >/dev/null
! grep -q -- '-X PATCH repos/GigleAI/cavil-loop/issues/77' "$TEST_GH_LOG" || fail recovery-closed-scheduler-alert
[ "$(jq -r .scheduler_alert_issue "$CAVIL_DEPLOY_ROOT/deploy-state.json")" = 77 ] || fail recovery-forgot-scheduler-alert

TEST_ALERT_CLOSED=1 PATH="$TMP/fakebin:$PATH" deploy >/dev/null
[ "$(jq -r '.scheduler_alert_issue // ""' "$CAVIL_DEPLOY_ROOT/deploy-state.json")" = "" ] || fail acknowledged-alert-not-cleared

echo '▶ failed scheduler alert creation is retried on a no-change deploy'
printf 'socket-v3\n' > "$SRC/systemd/preview.socket"
git -C "$SRC" add systemd/preview.socket
git -C "$SRC" commit -m socket-v3 >/dev/null
git -C "$SRC" push >/dev/null
: > "$TEST_GH_LOG"
TEST_ALERT_FAIL=1 PATH="$TMP/fakebin:$PATH" deploy >/dev/null
[ "$(jq -r '.scheduler_pending' "$CAVIL_DEPLOY_ROOT/deploy-state.json")" = 1 ] || fail failed-alert-pending-not-recorded
[ "$(jq -r '.scheduler_alert_issue' "$CAVIL_DEPLOY_ROOT/deploy-state.json")" = "" ] || fail failed-alert-issue-should-be-empty
: > "$TEST_GH_LOG"
PATH="$TMP/fakebin:$PATH" deploy >/dev/null
grep -q -- '-X POST repos/GigleAI/cavil-loop/issues' "$TEST_GH_LOG" || fail failed-alert-not-retried
[ "$(jq -r '.scheduler_alert_issue' "$CAVIL_DEPLOY_ROOT/deploy-state.json")" = 77 ] || fail retried-alert-not-recorded
pass scheduler-alert-retry
pass scheduler-boundaries

echo '▶ a failed stable-link switch is visible and keeps the old release'
cat > "$TMP/fakebin/mv" <<'SH'
#!/usr/bin/env bash
if [ "${1:-}" = -Tf ]; then exit 1; fi
exec /usr/bin/mv "$@"
SH
chmod +x "$TMP/fakebin/mv"
: > "$TEST_GH_LOG"
before=$(readlink -f "$CAVIL_SKILL_LINK")
printf 'v4\n' > "$SRC/data"
git -C "$SRC" add data
git -C "$SRC" commit -m v4 >/dev/null
git -C "$SRC" push >/dev/null
PATH="$TMP/fakebin:$PATH" CAVIL_DEPLOY_ALERT_AFTER=0 deploy >/dev/null
[ "$(readlink -f "$CAVIL_SKILL_LINK")" = "$before" ] || fail failed-switch-changed-link
grep -q -- '-X POST repos/GigleAI/cavil-loop/issues' "$TEST_GH_LOG" || fail lag-alert-not-opened
grep -q -- 'labels\[\]=pending/human' "$TEST_GH_LOG" || fail alert-missing-safe-label
rm "$CAVIL_DEPLOY_ROOT/deploy-state.json"
deploy >/dev/null
pass failed-switch

echo '▶ development links are never taken over without bootstrap'
DEV="$TMP/dev"; mkdir -p "$DEV"
mkdir -p "$DEV/systemd" "$TMP/systemd-user"
printf 'legacy-service\n' > "$DEV/systemd/coding-agent-poll@.service"
ln -s "$DEV/systemd/coding-agent-poll@.service" "$TMP/systemd-user/coding-agent-poll@.service"
ln -sfn "$DEV" "$CAVIL_SKILL_LINK.tmp"; mv -Tf "$CAVIL_SKILL_LINK.tmp" "$CAVIL_SKILL_LINK"
deploy >/dev/null
[ "$(readlink -f "$CAVIL_SKILL_LINK")" = "$DEV" ] || fail development-takeover
pass development-mode

echo '▶ bootstrap migrates old systemd symlinks and reloads the user manager'
rm -f "$TMP/fakebin/mv"
: > "$TEST_SYSTEMCTL_LOG"
CAVIL_SYSTEMD_USER_DIR="$TMP/systemd-user" PATH="$TMP/fakebin:$PATH" deploy --bootstrap >/dev/null
[ "$(readlink "$TMP/systemd-user/coding-agent-poll@.service")" = "$CAVIL_SKILL_LINK/systemd/coding-agent-poll@.service" ] || fail bootstrap-did-not-migrate-systemd-link
grep -qx -- '--user daemon-reload' "$TEST_SYSTEMCTL_LOG" || fail bootstrap-did-not-reload-systemd
pass bootstrap-systemd-migration

echo '▶ bootstrap reloads an entity at the existing stable systemd path'
ENTITY_SOURCE=$(readlink -f "$CAVIL_SKILL_LINK")
rm -f "$CAVIL_SKILL_LINK"
mkdir -p "$CAVIL_SKILL_LINK"
cp -a "$ENTITY_SOURCE/." "$CAVIL_SKILL_LINK/"
: > "$TEST_SYSTEMCTL_LOG"
CAVIL_SYSTEMD_USER_DIR="$TMP/systemd-user" PATH="$TMP/fakebin:$PATH" deploy --bootstrap >/dev/null
grep -qx -- '--user daemon-reload' "$TEST_SYSTEMCTL_LOG" || fail bootstrap-entity-did-not-reload-systemd
pass bootstrap-entity-systemd-migration

echo '▶ atomic link replacement has no resolution gap'
(
    for _ in $(seq 1 200); do readlink -f "$CAVIL_SKILL_LINK" >/dev/null || exit 1; done
) & resolver=$!
deploy >/dev/null
wait "$resolver" || fail resolution-gap
pass atomic-link

echo '▶ offline fetch keeps the active release and remains non-blocking'
before=$(readlink -f "$CAVIL_SKILL_LINK")
CAVIL_DEPLOY_REPO="$TMP/does-not-exist.git" deploy >/dev/null
[ "$(readlink -f "$CAVIL_SKILL_LINK")" = "$before" ] || fail offline-switched-release
pass offline-fallback

echo '▶ slow fetch does not hold the consumer lock and failed attempts throttle'
cat > "$TMP/fakebin/git" <<'SH'
#!/usr/bin/env bash
case " $* " in
    *' fetch '*)
        touch "$TEST_SLOW_FETCH_STARTED"
        sleep 3
        exit 1
        ;;
esac
exec /usr/bin/git "$@"
SH
chmod +x "$TMP/fakebin/git"
export TEST_SLOW_FETCH_STARTED="$TMP/slow-fetch-started"
PATH="$TMP/fakebin:$PATH" CAVIL_DEPLOY_FETCH_TIMEOUT=2 deploy > "$TMP/slow-deploy.log" 2>&1 &
slow_deploy=$!
for _ in $(seq 1 200); do [ -f "$TEST_SLOW_FETCH_STARTED" ] && break; sleep 0.01; done
[ -f "$TEST_SLOW_FETCH_STARTED" ] || fail slow-fetch-did-not-start
TEST_STARTED="$TMP/slow-consumer-started" TEST_CONTINUE="$TMP/continue" \
    timeout 1 bash "$CAVIL_DEPLOY_ROOT/entrypoints/poll-entry.sh" > "$TMP/slow-consumer.out" \
    || fail slow-fetch-blocked-consumer
wait "$slow_deploy"
mtime_before=$(stat -c %Y "$CAVIL_DEPLOY_ROOT/.last-fetch")
PATH="$TMP/fakebin:$PATH" bash "$REPO_DIR/scripts/skill-deploy.sh" >/dev/null
mtime_after=$(stat -c %Y "$CAVIL_DEPLOY_ROOT/.last-fetch")
[ "$mtime_before" = "$mtime_after" ] || fail failed-fetch-was-not-throttled
pass slow-fetch-isolated

echo 'All skill deploy tests passed.'
