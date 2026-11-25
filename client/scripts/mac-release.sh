#!/usr/bin/env bash
# The client's Mac packages, built and signed on a Mac of the maintainers' own instead of on GitHub
# Actions, and published to the same place in the same shape (GitHub Releases, latest.json).
#
# Why a Mac of our own: the Developer ID certificate stays in that Mac's keychain, never in a CI
# secret. codesign reaches the keychain only from the logged-in desktop session (over ssh it fails),
# so this runs as a launchd LaunchAgent in that session — a plain script, no AI.
#
# The hand-over with the Client workflow (.github/workflows/client.yml), one draft release per version:
#   Actions runs the tests and builds Windows, then leaves a draft `client/v<version>` on the tested
#   commit carrying the two Windows files (scripts/handover.mjs create). Installed apps never see a
#   draft. Each round here:
#     1. asks which draft waits for the Macs (scripts/handover.mjs waiting): a release before a
#        development build, of development builds only the highest
#     2. on that commit builds arm64 and x64, signed with the Developer ID and the hardened runtime,
#        notarized when the notary key is set up (skipped until then), each update package signed
#        with the update key; checks them (codesign, Gatekeeper, size, the dmg window and first open,
#        a real update of an installed app)
#     3. writes latest.json from every package (scripts/update-manifest.mjs) and publishes: a
#        development build through scripts/dev-release.mjs (fills the draft, publishes, keeps the
#        latest 10), a release through scripts/handover.mjs publish
#   Anything that fails leaves the draft as it was; the next round starts over. A draft that waits too
#   long is reported by the nightly run (client.yml, handover.mjs stale).
#
# Local settings, never in the repository: a shell file at $CAVIL_MAC_RELEASE_CONF (default
# ~/.config/cavil-mac-release/config), mode 0600, read with `source`:
#   SIGNING_IDENTITY="Developer ID Application: …"      required
#   GITHUB_TOKEN_FILE=…   fine-grained token, this repository only, Contents: read and write   (round)
#   UPDATE_KEY_FILE=…     the update key (minisign secret key, what CI had as TAURI_SIGNING_PRIVATE_KEY)  (round)
#   UPDATE_KEY_PASSWORD_KEYCHAIN=…   its password: the service name of a generic password in this
#                         user's login keychain (preferred: not a file any process can read; the
#                         keychain opens only in the desktop session, where this runs)
#   UPDATE_KEY_PASSWORD_FILE=…   or its password in a file, when it has one
#   NOTARY_KEY_FILE=… NOTARY_KEY_ID=… NOTARY_ISSUER=…   App Store Connect API key: all three, or none (= no notarization)
#   WORK_DIR=…            checkout, logs, state (default ~/.local/share/cavil-mac-release)
#   DMGBUILD_BIN=…        directory holding dmgbuild, when it is not on PATH
#   QUIET_HOURS=HH:MM-HH:MM   no new round starts in this window (the Mac's other scheduled jobs)
#   INTERVAL=600          seconds between rounds (install)
# Every secret file must be mode 0600 and owned by this user, or nothing starts. No secret is ever
# printed: the token reaches only the publish step (never npm ci or the build), the update key only
# the build step.
#
#   mac-release.sh round                          one round (what launchd runs)
#   mac-release.sh build <commit> [<version>]     build, sign and check one commit; publishes nothing
#                                                 (no update key set up: a throw-away one is used)
#   mac-release.sh install | uninstall            the LaunchAgent (mac-release.plist.template)
#   mac-release.sh status                         the last rounds
#   mac-release.sh verify <dmg>…                  codesign / Gatekeeper report of built dmgs
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LABEL=dev.gigle.cavil-mac-release
CONF="${CAVIL_MAC_RELEASE_CONF:-$HOME/.config/cavil-mac-release/config}"
REPO=GigleAI/cavil-loop
ARCHES=(arm64 x64)
export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

say() { printf '%s %s\n' "$(date '+%F %T')" "$*"; }
die() { say "❌ $*"; exit 1; }

# A secret file: there, this user's, 0600. Never read into the log.
secret_ok() {
  local f="$1" what="$2"
  [ -n "$f" ] || die "$what: not set in $CONF"
  [ -f "$f" ] || die "$what: $f does not exist"
  [ "$(stat -f %u "$f")" = "$(id -u)" ] || die "$what: $f is not owned by $(id -un)"
  [ "$(stat -f %Lp "$f")" = 600 ] || die "$what: $f must be mode 0600 (chmod 600 '$f')"
}

load_conf() {
  [ -f "$CONF" ] || die "no settings file $CONF (see the header of $0)"
  secret_ok "$CONF" "settings file"
  # shellcheck disable=SC1090
  source "$CONF"
  : "${SIGNING_IDENTITY:?SIGNING_IDENTITY is not set in $CONF}"
  WORK_DIR="${WORK_DIR:-$HOME/.local/share/cavil-mac-release}"
  INTERVAL="${INTERVAL:-600}"
  [ -n "${DMGBUILD_BIN:-}" ] && export PATH="$DMGBUILD_BIN:$PATH"
  NOTARIZE=false
  if [ -n "${NOTARY_KEY_FILE:-}${NOTARY_KEY_ID:-}${NOTARY_ISSUER:-}" ]; then
    [ -n "${NOTARY_KEY_FILE:-}" ] && [ -n "${NOTARY_KEY_ID:-}" ] && [ -n "${NOTARY_ISSUER:-}" ] || die "notarization needs all three of NOTARY_KEY_FILE, NOTARY_KEY_ID, NOTARY_ISSUER"
    secret_ok "$NOTARY_KEY_FILE" "NOTARY_KEY_FILE"
    NOTARIZE=true
  fi
  mkdir -p "$WORK_DIR/log"
}

in_quiet_hours() {
  [ -n "${QUIET_HOURS:-}" ] || return 1
  local from="${QUIET_HOURS%-*}" to="${QUIET_HOURS#*-}" now
  now="$(date +%H:%M)"
  if [[ "$from" < "$to" ]]; then [[ ! "$now" < "$from" && "$now" < "$to" ]]; else [[ ! "$now" < "$from" || "$now" < "$to" ]]; fi
}

# The checkout this builds from: a clone of its own, put on exactly <commit>, nothing else left in it.
checkout() {
  local sha="$1" repo="$WORK_DIR/repo"
  [ -d "$repo/.git" ] || git clone -q "https://github.com/$REPO.git" "$repo"
  git -C "$repo" fetch -q --tags --force origin '+refs/heads/main:refs/remotes/origin/main'
  git -C "$repo" cat-file -e "$sha^{commit}" 2>/dev/null || git -C "$repo" fetch -q origin "$sha"
  git -C "$repo" checkout -q --force --detach "$sha"
  # the Rust build cache stays (minutes saved per build); everything else is rebuilt
  git -C "$repo" clean -q -ffdx -e client/src-tauri/target
  CLIENT="$repo/client"
}

# Everything the Tauri bundler is told beyond tauri.conf.json: the signing identity, and the update
# package with the public key that verifies it.
bundle_conf() {
  node -e 'console.log(JSON.stringify({ bundle: { createUpdaterArtifacts: true, macOS: { signingIdentity: process.argv[1] } }, plugins: { updater: { pubkey: process.argv[2] } } }))' "$SIGNING_IDENTITY" "$1"
}

# Notarize and staple a dmg (the app inside was notarized by the bundler, APPLE_API_* below).
notarize() {
  [ "$NOTARIZE" = true ] || { say "⏭ notarization not set up (no NOTARY_KEY_*): skipped"; return 0; }
  xcrun notarytool submit "$1" --key "$NOTARY_KEY_FILE" --key-id "$NOTARY_KEY_ID" --issuer "$NOTARY_ISSUER" --wait
  xcrun stapler staple "$1"
}

# Build, sign and check both Macs of <commit> as <version> into $OUT. $1 = commit, $2 = version,
# $3 = "real" (the update key) | "throwaway".
build_all() {
  local sha="$1" version="$2" keymode="$3"
  checkout "$sha"
  cd "$CLIENT"
  npm ci --no-audit --no-fund >/dev/null
  if [[ "$version" == *-dev.* ]]; then node scripts/dev-version.mjs --set "$version"; else node scripts/release-version.mjs write "$version"; fi
  local pub keyfile pass=""
  if [ "$keymode" = real ]; then
    secret_ok "${UPDATE_KEY_FILE:-}" UPDATE_KEY_FILE
    keyfile="$UPDATE_KEY_FILE"
    if [ -n "${UPDATE_KEY_PASSWORD_KEYCHAIN:-}" ]; then
      pass="$(security find-generic-password -s "$UPDATE_KEY_PASSWORD_KEYCHAIN" -w)" || die "no password '$UPDATE_KEY_PASSWORD_KEYCHAIN' in the login keychain (or it is locked)"
    elif [ -n "${UPDATE_KEY_PASSWORD_FILE:-}" ]; then
      secret_ok "$UPDATE_KEY_PASSWORD_FILE" UPDATE_KEY_PASSWORD_FILE; pass="$(cat "$UPDATE_KEY_PASSWORD_FILE")"
    fi
    pub="$(node -p "require('./src-tauri/tauri.conf.json').plugins.updater.pubkey")"
    [ -n "$pub" ] || die "plugins.updater.pubkey in tauri.conf.json is empty"
  else
    keyfile="$WORK_DIR/throwaway-update.key"
    rm -f "$keyfile" "$keyfile.pub"
    npx tauri signer generate --ci -p "" -w "$keyfile" >/dev/null
    pub="$(cat "$keyfile.pub")"
  fi
  local conf
  conf="$(bundle_conf "$pub")"
  printf '%s' "$conf" > "$WORK_DIR/update-conf.json"
  rm -rf release && mkdir -p release
  local arch triple dir app
  for arch in "${ARCHES[@]}"; do
    triple="$([ "$arch" = arm64 ] && echo aarch64-apple-darwin || echo x86_64-apple-darwin)"
    say "== $arch: build and sign ($triple)"
    (
      export TAURI_SIGNING_PRIVATE_KEY="$keyfile" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$pass"
      if [ "$NOTARIZE" = true ]; then export APPLE_API_KEY="$NOTARY_KEY_ID" APPLE_API_ISSUER="$NOTARY_ISSUER" APPLE_API_KEY_PATH="$NOTARY_KEY_FILE"; fi
      npx tauri build --bundles app --target "$triple" --config "$conf"
    )
    dir="src-tauri/target/$triple/release/bundle/macos"
    app="$dir/Cavil Loop.app"
    node scripts/update-manifest.mjs --verify "$app.tar.gz" "$app.tar.gz.sig" --conf "$WORK_DIR/update-conf.json"
    node scripts/make-dmg.mjs --arch "$arch" --app "$app"
    codesign --force --sign "$SIGNING_IDENTITY" --timestamp "release/Cavil-Loop-$version-$arch.dmg"
    notarize "release/Cavil-Loop-$version-$arch.dmg"
    for ext in tar.gz tar.gz.sig; do cp "$app.$ext" "release/Cavil-Loop-$version-$arch.app.$ext"; done
  done
  say "== checks"
  node scripts/size-gate.mjs release/*.dmg --expect arm64,x64
  node scripts/size-gate.mjs release/*.app.tar.gz --expect arm64,x64
  verify release/*.dmg
  # no window screenshot: scripting Finder asks for a permission nobody is there to grant
  for arch in "${ARCHES[@]}"; do
    CAVIL_EXPECT_SIGNER="$SIGNING_IDENTITY" CAVIL_EXPECT_NOTARIZED="$NOTARIZE" \
      bash scripts/mac-open-check.sh "release/Cavil-Loop-$version-$arch.dmg"
  done
  # a real update of an installed app, as CI did (a test build of its own, ad-hoc signed)
  (
    export TAURI_SIGNING_PRIVATE_KEY="" TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
    npx tauri build --debug --bundles app --features update-test
  )
  bash scripts/mac-update-check.sh "src-tauri/target/debug/bundle/macos/Cavil Loop.app"
  # the version files were stamped for this build only
  git checkout -q -- .
  OUT="$CLIENT/release"
}

# What a maintainer wants to see of a signed dmg: who signed the app, hardened runtime, Gatekeeper.
verify() {
  local dmg mnt app
  for dmg in "$@"; do
    mnt="$(mktemp -d)"
    hdiutil attach -nobrowse -readonly -mountpoint "$mnt" "$dmg" >/dev/null
    app="$(find "$mnt" -maxdepth 1 -name '*.app' | head -n1)"
    echo "--- $(basename "$dmg")"
    codesign --verify --deep --strict --verbose=2 "$app" 2>&1 | sed 's/^/  /'
    codesign -dvv "$app" 2>&1 | grep -E '^(Authority|TeamIdentifier|Timestamp|CodeDirectory)' | sed 's/^/  /'
    lipo -archs "$app/Contents/MacOS/Cavil Loop" | sed 's/^/  archs: /'
    spctl --assess --type execute -vv "$app" 2>&1 | sed 's/^/  spctl app: /' || true
    codesign --verify --verbose=2 "$dmg" 2>&1 | sed 's/^/  dmg: /'
    spctl --assess --type open --context context:primary-signature -vv "$dmg" 2>&1 | sed 's/^/  spctl dmg: /' || true
    hdiutil detach "$mnt" -quiet || true
  done
}

# One round: the draft waiting for the Macs, built, checked, published.
round() {
  load_conf
  if in_quiet_hours; then say "⏭ quiet hours ($QUIET_HOURS)"; return 0; fi
  # one round at a time (launchd starts the next one on time even if this one is still going)
  local lock="$WORK_DIR/round.lock"
  if ! mkdir "$lock" 2>/dev/null; then
    if kill -0 "$(cat "$lock/pid" 2>/dev/null || echo 0)" 2>/dev/null; then say "⏭ a round is still going"; return 0; fi
    rm -rf "$lock" && mkdir "$lock"
  fi
  echo $$ > "$lock/pid"
  trap 'rm -rf "$lock"' EXIT
  secret_ok "${GITHUB_TOKEN_FILE:-}" GITHUB_TOKEN_FILE
  local job
  # handover.mjs reads the release list (drafts are visible only to a token that can write)
  checkout origin/main
  job="$(GH_TOKEN="$(cat "$GITHUB_TOKEN_FILE")" node "$CLIENT/scripts/handover.mjs" waiting --repo "$REPO")"
  [ "$job" != null ] || { say "nothing waits for the Macs"; return 0; }
  local tag version sha channel
  tag="$(node -p 'JSON.parse(process.argv[1]).tag' "$job")"
  version="$(node -p 'JSON.parse(process.argv[1]).version' "$job")"
  sha="$(node -p 'JSON.parse(process.argv[1]).sha' "$job")"
  channel="$(node -p 'JSON.parse(process.argv[1]).channel' "$job")"
  say "== $tag ($channel) on $sha"
  build_all "$sha" "$version" real
  cd "$CLIENT"
  (
    export GH_TOKEN
    GH_TOKEN="$(cat "$GITHUB_TOKEN_FILE")"
    # the Windows files and the page's text, from the draft itself
    node scripts/handover.mjs fetch --repo "$REPO" --tag "$tag" --dir "$OUT" --notes-out "$WORK_DIR/notes.md"
    if [ "$channel" = dev ]; then
      node scripts/update-manifest.mjs --channel dev --version "$version" --dir "$OUT" --conf src-tauri/tauri.conf.json --notes "$WORK_DIR/notes.md" --out "$OUT/latest.json"
      node scripts/dev-release.mjs --version "$version" --sha "$sha" --dir "$OUT" --notes-file "$WORK_DIR/notes.md" --keep 10 --repo "$REPO"
    else
      node scripts/update-manifest.mjs --version "$version" --dir "$OUT" --conf src-tauri/tauri.conf.json --notes RELEASE_NOTES.md --out "$OUT/latest.json"
      node scripts/handover.mjs publish --repo "$REPO" --tag "$tag" --sha "$sha" --dir "$OUT"
    fi
  )
  say "✅ $tag published: https://github.com/$REPO/releases/tag/$tag"
}

install_agent() {
  load_conf
  local plist="$HOME/Library/LaunchAgents/$LABEL.plist" log="$WORK_DIR/log/launchd.log"
  mkdir -p "$HOME/Library/LaunchAgents"
  # the script runs from its own copy, so a checkout this script switches between commits never
  # changes the program that is running
  mkdir -p "$WORK_DIR/bin"
  cp "$here/mac-release.sh" "$WORK_DIR/bin/mac-release.sh"
  sed -e "s|@LABEL@|$LABEL|g" -e "s|@SCRIPT@|$WORK_DIR/bin/mac-release.sh|g" -e "s|@CONF@|$CONF|g" \
      -e "s|@INTERVAL@|$INTERVAL|g" -e "s|@LOG@|$log|g" "$here/mac-release.plist.template" > "$plist"
  plutil -lint "$plist" >/dev/null
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$plist"
  say "installed $LABEL: every ${INTERVAL}s in the desktop session; log $log"
}

uninstall_agent() {
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
  say "removed $LABEL (settings, checkout and logs kept)"
}

cmd="${1:-}"
shift || true
case "$cmd" in
  round)
    load_conf
    log="$WORK_DIR/log/$(date +%F).log"
    round "$@" >>"$log" 2>&1 || { rc=$?; say "❌ round failed (exit $rc), see $log" >>"$log"; exit "$rc"; }
    # logs older than 30 days go
    find "$WORK_DIR/log" -name '20*.log' -mtime +30 -delete 2>/dev/null || true
    ;;
  build)
    [ -n "${1:-}" ] || die "usage: mac-release.sh build <commit> [<version>]"
    load_conf
    sha="$1"
    checkout "$sha"
    sha="$(git -C "$WORK_DIR/repo" rev-parse HEAD)"
    version="${2:-$(cd "$CLIENT" && node scripts/dev-version.mjs)}"
    keymode=throwaway
    [ -n "${UPDATE_KEY_FILE:-}" ] && keymode=real
    build_all "$sha" "$version" "$keymode"
    say "✅ built and checked $version ($sha), nothing published: $OUT"
    ;;
  verify) load_conf; verify "$@" ;;
  install) install_agent ;;
  uninstall) uninstall_agent ;;
  status)
    load_conf
    launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | grep -E 'state|last exit' || echo "$LABEL not loaded"
    ls -t "$WORK_DIR/log/"20*.log 2>/dev/null | head -1 | xargs -I{} tail -20 {}
    ;;
  *) sed -n '2,45p' "$0"; exit 2 ;;
esac
