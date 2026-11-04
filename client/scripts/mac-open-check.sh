#!/usr/bin/env bash
# Run on a macOS CI machine against a built dmg. Verifies, for real:
#   1. the app inside the dmg starts (smoke test, direct launch)
#   2. it carries an ad-hoc signature that verifies (Apple silicon needs one)
#   3. once marked as downloaded (quarantine), Gatekeeper rejects it — i.e.
#      the user WILL see the "cannot be opened" dialog on first open
#   4. the documented terminal step (remove the quarantine mark) makes a
#      LaunchServices launch (`open`, same path as a double-click) succeed
# The System Settings "Open Anyway" button path needs a human click and is
# NOT verified here.
#
#   bash scripts/mac-open-check.sh release/Cavil-Loop-0.1.0-arm64.dmg
set -euo pipefail
dmg="$1"
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
