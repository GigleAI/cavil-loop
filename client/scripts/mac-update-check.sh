#!/usr/bin/env bash
# Run on a macOS CI machine (GitHub#184). A real update, through Tauri's updater plugin and the
# app's own updater, from an installed old version to a new one:
#   1. the old app is in /Applications (installed the way a user ends up with it: the first-open
#      step done, no "downloaded from the internet" mark) and is started
#   2. it finds the new release on a loopback stand-in for GitHub (release list → latest.json →
#      package), downloads it, checks its signature, and swaps itself for it
#   3. checks: /Applications now holds the new version (version number + a file only the new
#      package has); no quarantine mark anywhere in it; its ad-hoc signature verifies; it starts
#      through LaunchServices (`open`, the double-click path, where Gatekeeper looks)
#   4. a package whose bytes do not match its signature: refused, the old app left exactly as it was
#
# The "new version" is the same build as the old one with its version number raised and a marker
# file added, re-signed ad-hoc: the update path does not care what the app does, only what it is.
# Signed with a throw-away key whose public half reaches the app through the test-build-only
# CAVIL_CLIENT_TEST_UPDATE_PUBKEY (cargo feature update-test; the released app has no such switch).
#
#   bash scripts/mac-update-check.sh "<test build>.app"
#   (built with: npx tauri build --debug --bundles app --features update-test)
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
src_app="$1"
[ -d "$src_app" ] || { echo "❌ no app at $src_app"; exit 1; }
installed="/Applications/Cavil Loop.app"
[ -e "$installed" ] && { echo "❌ $installed already exists; this check installs its own"; exit 1; }
work="$(mktemp -d)"
pid=""
srv_pid=""
cleanup() {
  [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  [ -n "$srv_pid" ] && kill "$srv_pid" 2>/dev/null || true
  rm -rf "$installed"
}
trap cleanup EXIT
plist() { /usr/libexec/PlistBuddy -c "Print :$1" "$2/Contents/Info.plist"; }

old="$(plist CFBundleShortVersionString "$src_app")"
IFS=. read -r a b c <<<"$old"
new="$a.$b.$((c + 1))"
case "$(uname -m)" in arm64) target=darwin-aarch64 ;; *) target=darwin-x86_64 ;; esac
echo "== old $old → new $new ($target)"

echo "== 0. a throw-away update key; the new version's package, signed with it"
tauri="$here/../node_modules/.bin/tauri"
"$tauri" signer generate --ci -p "" -w "$work/key" >/dev/null
pub="$(cat "$work/key.pub")"
mkdir -p "$work/new"
ditto "$src_app" "$work/new/Cavil Loop.app"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $new" -c "Set :CFBundleVersion $new" "$work/new/Cavil Loop.app/Contents/Info.plist"
echo "$new" > "$work/new/Cavil Loop.app/Contents/Resources/cavil-update-marker"
codesign --force --deep -s - "$work/new/Cavil Loop.app"
port="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')"
base="http://127.0.0.1:$port"
dl="$work/srv/web/GigleAI/cavil-loop/releases/download/client/v$new"
mkdir -p "$dl" "$work/srv/api/repos/GigleAI/cavil-loop"
(cd "$work/new" && COPYFILE_DISABLE=1 tar czf "$dl/app.tar.gz" "Cavil Loop.app")
"$tauri" signer sign -f "$work/key" -p "" --app-version "$new" "$dl/app.tar.gz" >/dev/null
cp "$dl/app.tar.gz" "$work/good.tar.gz"
manifest() {
  python3 - "$new" "$target" "$base/web/GigleAI/cavil-loop/releases/download/client/v$new/app.tar.gz" "$(cat "$dl/app.tar.gz.sig")" > "$dl/latest.json" <<'EOF'
import json, sys
v, t, url, sig = sys.argv[1:5]
print(json.dumps({"version": v, "notes": "", "pub_date": "2026-11-06T00:00:00Z", "platforms": {t: {"url": url, "signature": sig}}}))
EOF
}
manifest
python3 - "$new" "$base" > "$work/srv/api/repos/GigleAI/cavil-loop/releases" <<'EOF'
import json, sys
v, base = sys.argv[1:3]
tag = f"client/v{v}"
print(json.dumps([
  {"tag_name": tag, "draft": False, "prerelease": False,
   "assets": [{"name": "latest.json", "browser_download_url": f"{base}/web/GigleAI/cavil-loop/releases/download/{tag}/latest.json"}]},
  {"tag_name": "release/v2026.11.01.1", "draft": False, "prerelease": False, "assets": []},
]))
EOF
python3 -m http.server "$port" --bind 127.0.0.1 --directory "$work/srv" >"$work/srv.log" 2>&1 &
srv_pid=$!
for _ in $(seq 1 50); do curl -fsS "$base/api/repos/GigleAI/cavil-loop/releases" >/dev/null 2>&1 && break; sleep 0.2; done

install_old() {
  rm -rf "$installed"
  ditto "$src_app" "$installed"
  xattr -dr com.apple.quarantine "$installed" 2>/dev/null || true
}

# start the installed app in test mode (loopback GitHub, its own profile); its updater looks at once
run_old() {
  local rec="$1"
  : > "$rec"
  env CAVIL_CLIENT_TEST_MODE=1 CAVIL_CLIENT_TEST_API="$base/api" CAVIL_CLIENT_TEST_WEB="$base/web" \
    CAVIL_CLIENT_TEST_CREDENTIAL_FILE="$work/cred" CAVIL_CLIENT_USER_DATA="$work/profile-$(basename "$rec")" \
    CAVIL_CLIENT_TEST_ALERTS_FILE="$rec" CAVIL_CLIENT_TEST_UPDATE=1 CAVIL_CLIENT_TEST_UPDATE_PUBKEY="$pub" \
    "$installed/Contents/MacOS/Cavil Loop" --hidden >"$rec.out" 2>&1 &
  pid=$!
}

# the updater's last status in the record file
last_status() {
  python3 - "$1" <<'EOF'
import json, sys
last = None
for line in open(sys.argv[1]):
    try:
        r = json.loads(line)
    except ValueError:
        continue
    if r.get("op") == "update":
        last = r["status"]
print(json.dumps(last))
EOF
}

wait_round() {
  local rec="$1"
  for _ in $(seq 1 180); do
    st="$(last_status "$rec")"
    if python3 -c 'import json,sys; s=json.loads(sys.argv[1]); sys.exit(0 if s and s.get("phase") in ("idle","ready") and s.get("last") else 1)' "$st"; then
      echo "$st"
      return 0
    fi
    sleep 1
  done
  echo "❌ no finished round within 180 s; last status: $(last_status "$rec")"
  tail -20 "$rec.out" || true
  return 1
}

echo "== 1–2. the installed old version updates itself"
install_old
run_old "$work/rec-good.jsonl"
st="$(wait_round "$work/rec-good.jsonl")" || exit 1
echo "updater: $st"
kill "$pid" 2>/dev/null || true
wait "$pid" 2>/dev/null || true
pid=""
python3 -c 'import json,sys; s=json.loads(sys.argv[1]); sys.exit(0 if s["phase"]=="ready" and s["version"]==sys.argv[2] else 1)' "$st" "$new" \
  || { echo "❌ the update did not end ready for $new"; exit 1; }
grep -F '"op":"update"' "$work/rec-good.jsonl" | grep -qF '"phase":"downloading"' || { echo "❌ never reported downloading"; exit 1; }

echo "== 3. /Applications holds the new version, unmarked, signed, and it starts like a double-click"
got="$(plist CFBundleShortVersionString "$installed")"
[ "$got" = "$new" ] || { echo "❌ installed version is $got, expected $new"; exit 1; }
[ "$(cat "$installed/Contents/Resources/cavil-update-marker" 2>/dev/null)" = "$new" ] || { echo "❌ the new package's marker file is not in the installed app"; exit 1; }
if xattr -lr "$installed" 2>/dev/null | grep -q 'com.apple.quarantine'; then
  echo "❌ the updated app carries the quarantine mark:"; xattr -lr "$installed" | grep 'com.apple.quarantine' | head; exit 1
fi
echo "quarantine mark on the new app before the updater's own clean-up: $(grep -F '"op":"quarantine"' "$work/rec-good.jsonl" || echo '(not recorded)')"
codesign --verify --deep --strict "$installed"
marker="$work/smoke-open.txt"
open -n -W "$installed" --args --smoke-test "--smoke-out=$marker" &
opid=$!
for _ in $(seq 1 60); do [ -s "$marker" ] && break; sleep 1; done
kill "$opid" 2>/dev/null || true
cat "$marker" 2>/dev/null || true
grep -q 'CAVIL_SMOKE_OK' "$marker" 2>/dev/null || { echo "❌ the updated app did not start through LaunchServices"; exit 1; }
echo "✅ updated to $new: version, marker, no quarantine mark, signature verifies, starts via open"

echo "== 4. a package that does not match its signature is refused; the old app stays as it was"
install_old
before="$(find "$installed" -type f -exec shasum {} + | sort | shasum)"
printf 'tampered' >> "$dl/app.tar.gz"
run_old "$work/rec-bad.jsonl"
st="$(wait_round "$work/rec-bad.jsonl")" || exit 1
echo "updater: $st"
kill "$pid" 2>/dev/null || true
wait "$pid" 2>/dev/null || true
pid=""
python3 -c 'import json,sys; s=json.loads(sys.argv[1]); sys.exit(0 if s["phase"]=="idle" and not s["last"]["ok"] and "签名校验失败" in s["last"]["message"] else 1)' "$st" \
  || { echo "❌ a tampered package was not reported as a signature failure"; exit 1; }
after="$(find "$installed" -type f -exec shasum {} + | sort | shasum)"
[ "$before" = "$after" ] || { echo "❌ the installed app changed after a refused package"; exit 1; }
[ "$(plist CFBundleShortVersionString "$installed")" = "$old" ] || { echo "❌ the installed version changed"; exit 1; }
cp "$work/good.tar.gz" "$dl/app.tar.gz"
echo "✅ tampered package refused, installed app byte for byte unchanged"
