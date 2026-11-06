#!/usr/bin/env bash
# Run on a macOS CI machine against a built dmg. Verifies, for real:
#   0. the dmg window (background, Applications link, instructions file, copy page) and
#      the app's icon being build/icon.png rather than Electron's default
#   1. the app inside the dmg starts (smoke test, direct launch)
#   2. it carries an ad-hoc signature that verifies (Apple silicon needs one)
#   3. once marked as downloaded (quarantine), Gatekeeper rejects it — i.e.
#      the user WILL see the "cannot be opened" dialog on first open
#   4. the documented terminal step (remove the quarantine mark) makes a
#      LaunchServices launch (`open`, same path as a double-click) succeed
#   5. that launched app sends one real system notification through the
#      production path and reports what macOS did with it (shown / failed /
#      timeout). Informational: a CI machine may never grant the permission a
#      user grants on first use, so this step logs the result but does not
#      fail the job — a person's Mac is the acceptance (GitHub#139).
# The System Settings "Open Anyway" button path needs a human click and is
# NOT verified here.
#
#   bash scripts/mac-open-check.sh release/Cavil-Loop-0.1.0-arm64.dmg [window-screenshot.png]
set -euo pipefail
dmg="$1"
shot="${2:-}"
work="$(mktemp -d)"
mnt="$work/mnt"
mkdir -p "$mnt"
hdiutil attach -nobrowse -readonly -mountpoint "$mnt" "$dmg" >/dev/null
trap 'hdiutil detach "$mnt" -quiet || true' EXIT
app_src="$(find "$mnt" -maxdepth 1 -name '*.app' | head -n1)"
[ -n "$app_src" ] || { echo "❌ no .app in $dmg"; exit 1; }
app="$work/Cavil Loop.app"
cp -R "$app_src" "$app"
bin="$app/Contents/MacOS/Cavil Loop"

echo "== 0. dmg window: background + the copyable first-open instructions"
# electron-builder merges background.png + background@2x.png into one multi-resolution .background.tiff
bg="$(find "$mnt" -maxdepth 2 \( -name '.background.tiff' -o -path '*/.background/*' \) -type f | head -n1)"
[ -n "$bg" ] || { echo "❌ no background image in the dmg"; ls -la "$mnt"; exit 1; }
tiffutil -info "$bg" 2>/dev/null | grep -iE 'width|height' | head -4 || true
txt="$mnt/打不开时看这里.txt"
[ -f "$txt" ] || { echo "❌ the instructions file is missing"; ls -la "$mnt"; exit 1; }
grep -qF 'xattr -dr com.apple.quarantine "/Applications/Cavil Loop.app"' "$txt" || { echo "❌ the instructions file lacks the command"; exit 1; }
grep -qF '仍要打开' "$txt" || { echo "❌ the instructions file lacks the System Settings way"; exit 1; }
page="$mnt/复制放行命令.html"
[ -f "$page" ] || { echo "❌ the copy-the-command page is missing"; ls -la "$mnt"; exit 1; }
grep -qF 'xattr -dr com.apple.quarantine "/Applications/Cavil Loop.app"' "$page" || { echo "❌ the copy-the-command page lacks the command"; exit 1; }
[ -L "$mnt/Applications" ] || { echo "❌ no Applications link"; exit 1; }
echo "✅ background, Applications link, instructions file and copy page present"
if [ -n "$shot" ]; then
  # best effort: a picture of the window a user sees (the CI machine has a GUI session)
  open "$mnt" || true
  sleep 4
  echo "Finder window bounds: $(osascript -e 'tell application "Finder" to get bounds of front window' 2>&1 || true)"
  screencapture -x "$shot" || true
  osascript -e 'tell application "Finder" to close every window' >/dev/null 2>&1 || true
fi

echo "== 0b. app icon is build/icon.png (GitHub#144), not Electron's default"
# Reads the icon Info.plist names, takes the largest image in that .icns and
# compares it with build/icon.png; unreadable or missing counts as a failure.
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node "$here/icon.mjs" check-app "$app" "$here/../build/icon.png" || { echo "❌ app icon check failed"; exit 1; }

echo "== 1. direct launch smoke test"
out="$("$bin" --smoke-test 2>&1 || true)"
echo "$out" | grep -E 'CAVIL_SMOKE_(OK|FAIL)' || true
grep -q 'CAVIL_SMOKE_OK' <<<"$out" || { echo "❌ smoke test failed"; echo "$out" | tail -20; exit 1; }

echo "== 2. signature"
codesign -dv "$app" 2>&1 | grep -E 'Signature=|Identifier=' || true
codesign --verify --deep --strict "$app"
echo "✅ codesign --verify passed (ad-hoc)"

echo "== 3. quarantined copy is rejected by Gatekeeper"
xattr -w com.apple.quarantine "0083;$(printf '%x' "$(date +%s)");Safari;$(uuidgen)" "$app"
if spctl --assess --type execute -vv "$app" 2>&1; then
  echo "❌ Gatekeeper accepted an unsigned quarantined app — the first-open instructions would be wrong"
  exit 1
fi
echo "✅ rejected as expected (the user sees the first-open dialog)"

echo "== 4. documented step: xattr -dr com.apple.quarantine, then open like a double-click"
xattr -dr com.apple.quarantine "$app"
if xattr -p com.apple.quarantine "$app" >/dev/null 2>&1; then echo "❌ quarantine mark still there"; exit 1; fi
marker="$work/smoke-open.txt"
open -n -W "$app" --args --smoke-test "--smoke-out=$marker" &
pid=$!
for _ in $(seq 1 60); do [ -s "$marker" ] && break; sleep 1; done
kill "$pid" 2>/dev/null || true
cat "$marker" 2>/dev/null || true
grep -q 'CAVIL_SMOKE_OK' "$marker" 2>/dev/null || { echo "❌ app did not start via open after removing quarantine"; exit 1; }
echo "✅ starts via LaunchServices after the documented step"

echo "== 5. one real notification from the launched app (unsigned, as shipped)"
sw_vers 2>/dev/null || true
marker="$work/notify-open.txt"
open -n -W "$app" --args --notify-check "--smoke-out=$marker" &
pid=$!
for _ in $(seq 1 90); do [ -s "$marker" ] && break; sleep 1; done
kill "$pid" 2>/dev/null || true
cat "$marker" 2>/dev/null || true
grep -q 'CAVIL_SMOKE_OK' "$marker" 2>/dev/null || { echo "❌ app did not start for the notification check"; exit 1; }
result="$(sed -n 's/.*notify-check=//p' "$marker")"
echo "CAVIL_NOTIFY_RESULT ${result:-missing}"
case "$result" in
  shown) echo "✅ macOS reported the notification as delivered (show event)";;
  *) echo "⚠️ macOS did not report the notification as delivered on this machine: ${result:-missing} (not a failure of the job; see the comment above)";;
esac
