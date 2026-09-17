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

mkdir -p "$SRC/scripts"
mkdir -p "$SRC/systemd" "$SRC/launchd"
cp "$REPO_DIR/scripts/skill-deploy.sh" "$SRC/scripts/skill-deploy.sh"
cp "$REPO_DIR/scripts/poll-entry.sh" "$SRC/scripts/poll-entry.sh"
cat > "$SRC/scripts/agent-poll.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
touch "$TEST_STARTED"
while [ ! -f "$TEST_CONTINUE" ]; do sleep 0.01; done
cat "$CODING_AGENT_RELEASE_ROOT/data"
SH
printf 'v1\n' > "$SRC/data"
printf 'service-v1\n' > "$SRC/systemd/poll.service"
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
pass bootstrap

echo '▶ a running consumer stays on v1 while the stable link moves to v2'
TEST_STARTED="$TMP/started" TEST_CONTINUE="$TMP/continue" \
    bash "$CAVIL_SKILL_LINK/scripts/poll-entry.sh" > "$TMP/output" &
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
case " $* " in *' -X POST '*) printf '77\n' ;; esac
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
[ "$(jq -r .alert_issue "$CAVIL_DEPLOY_ROOT/deploy-state.json")" = 77 ] || fail alert-not-recorded
rm "$CAVIL_DEPLOY_ROOT/deploy-state.json"
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
printf 'v3\n' > "$SRC/data"
git -C "$SRC" add data
git -C "$SRC" commit -m v3 >/dev/null
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
ln -sfn "$DEV" "$CAVIL_SKILL_LINK.tmp"; mv -Tf "$CAVIL_SKILL_LINK.tmp" "$CAVIL_SKILL_LINK"
deploy >/dev/null
[ "$(readlink -f "$CAVIL_SKILL_LINK")" = "$DEV" ] || fail development-takeover
pass development-mode

echo '▶ atomic link replacement has no resolution gap'
deploy --bootstrap >/dev/null
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

echo 'All skill deploy tests passed.'
