#!/usr/bin/env bash
# Run on the Windows CI machine (GitHub#628), in Git Bash, after the release installer was built: the
# Windows counterpart of scripts/mac-update-check.sh. A real update, through Tauri's updater plugin
# and the app's own updater, from an installed old version to the one just built:
#   0. the "old version": this commit built once more as a debug build with the test switch
#      (cargo feature update-test: the update key and channel can be given to it), its version one
#      step lower — X.Y.Z-dev.(N-1) below a development build X.Y.Z-dev.N (development channel),
#      X.Y.Z-dev.0 below a release X.Y.Z (release channel). The "new version" is the release
#      installer just built, re-signed with a throw-away key whose public half reaches the old app
#   1. the old version is installed the way a person installs it (the installer, silently) and is
#      started in test mode against a loopback stand-in for GitHub (release list → latest.json →
#      installer); it finds the new version, downloads it, checks its signature and reports it ready
#   2. the restart a person asks for (the app's own restart, sent through the test control file): the
#      waiting installer runs and puts the new version in place
#   3. checks: the installed program is byte for byte what the new installer puts in place (each
#      installer is first installed once on its own to learn that: it stamps the program it installs,
#      so the build folder's copy differs); the stand-in served the whole installer; it starts
#      (--smoke-test)
#   4. the old version installed again; an installer whose bytes no longer match its signature (same
#      signature, bytes appended): the stand-in served it whole, the app reports "signature check
#      failed" (not a network error, not "nothing found"), no installer ran (every installed file
#      unchanged), and the old version still starts
#
#   bash scripts/windows-update-check.sh release/Cavil-Loop-<version>-windows-x64.exe
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
client="$(cd "$here/.." && pwd)"
new_installer="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
[ -f "$new_installer" ] || { echo "❌ no installer at $1"; exit 1; }
cd "$client"
py="$(command -v python3 || command -v python)"
# the app's status carries Chinese text; a Windows console's code page cannot print it
export PYTHONUTF8=1 PYTHONIOENCODING=utf-8
win() { cygpath -w "$1"; }
installed_dir="$(cygpath -u "$LOCALAPPDATA")/Cavil Loop"
installed="$installed_dir/Cavil Loop.exe"
work="$(mktemp -d)"
pid=""
srv_pid=""
stop_apps() {
  # every copy of the app: the one started here, and whatever an installer started after it ran
  taskkill //F //IM "Cavil Loop.exe" >/dev/null 2>&1 || true
}
cleanup() {
  [ -n "$srv_pid" ] && kill "$srv_pid" 2>/dev/null || true
  stop_apps
}
trap cleanup EXIT

new="$(node -p "require('./package.json').version")"
channel=stable
prerelease=False
if [[ "$new" =~ ^([0-9]+\.[0-9]+\.[0-9]+)-dev\.([0-9]+)$ ]]; then
  old="${BASH_REMATCH[1]}-dev.$((BASH_REMATCH[2] - 1))"
  channel=dev
  prerelease=True
  [ "${BASH_REMATCH[2]}" -ge 1 ] || { echo "❌ $new has no lower development version"; exit 1; }
else
  old="$new-dev.0"
fi
echo "== old $old → new $new (windows-x86_64, $channel channel)"

echo "== 0. the old version: a debug build with the test switch, version $old"
node --input-type=module -e "import('./scripts/dev-version.mjs').then((m) => m.writeVersion('.', process.argv[1]))" "$old"
rm -rf src-tauri/target/debug/bundle/nsis
npx tauri build --debug --bundles nsis --features update-test --config '{"bundle":{"createUpdaterArtifacts":false}}'
node --input-type=module -e "import('./scripts/dev-version.mjs').then((m) => m.writeVersion('.', process.argv[1]))" "$new"
old_installer="$(ls src-tauri/target/debug/bundle/nsis/*_x64-setup.exe)"
sum() { sha256sum "$1" | cut -d' ' -f1; }

echo "== the new version's installer, signed with a throw-away key; a loopback stand-in for GitHub"
npx tauri signer generate --ci -p "" -w "$work/key" >/dev/null
pub="$(cat "$work/key.pub")"
port="$("$py" -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')"
base="http://127.0.0.1:$port"
tag="client/v$new"
dl="$work/srv/web/GigleAI/cavil-loop/releases/download/$tag"
mkdir -p "$dl" "$work/srv/api/repos/GigleAI/cavil-loop"
cp "$new_installer" "$dl/setup.exe"
npx tauri signer sign -f "$work/key" -p "" --app-version "$new" "$dl/setup.exe" >/dev/null
cp "$dl/setup.exe" "$work/good.exe"
"$py" - "$new" "$base/web/GigleAI/cavil-loop/releases/download/$tag/setup.exe" "$(cat "$dl/setup.exe.sig")" > "$dl/latest.json" <<'EOF'
import json, sys
v, url, sig = sys.argv[1:4]
print(json.dumps({"version": v, "notes": "", "pub_date": "2026-11-21T00:00:00Z", "platforms": {"windows-x86_64": {"url": url, "signature": sig}}}))
EOF
"$py" - "$tag" "$base" "$prerelease" > "$work/srv/api/repos/GigleAI/cavil-loop/releases" <<'EOF'
import json, sys
tag, base, pre = sys.argv[1:4]
print(json.dumps([
  {"tag_name": tag, "draft": False, "prerelease": pre == "True",
   "assets": [{"name": "latest.json", "browser_download_url": f"{base}/web/GigleAI/cavil-loop/releases/download/{tag}/latest.json"}]},
  {"tag_name": "release/v2026.11.15.1", "draft": False, "prerelease": False, "assets": []},
]))
EOF
# the stand-in writes one line per file it served: path, bytes sent, the file's size
cat > "$work/server.py" <<'EOF'
import http.server, os, sys, functools
root, log, port = sys.argv[1], sys.argv[2], int(sys.argv[3])
class H(http.server.SimpleHTTPRequestHandler):
    def copyfile(self, src, dst):
        sent = 0
        while True:
            b = src.read(65536)
            if not b:
                break
            dst.write(b)
            sent += len(b)
        size = os.fstat(src.fileno()).st_size
        with open(log, "a") as f:
            f.write(f"{self.path} {sent} {size}\n")
    def log_message(self, *a):
        pass
http.server.ThreadingHTTPServer(("127.0.0.1", port), functools.partial(H, directory=root)).serve_forever()
EOF
"$py" "$work/server.py" "$(win "$work/srv")" "$(win "$work/served.log")" "$port" &
srv_pid=$!
for _ in $(seq 1 50); do curl -fsS "$base/api/repos/GigleAI/cavil-loop/releases" >/dev/null 2>&1 && break; sleep 0.2; done
served_whole() {  # served_whole <path> → the stand-in sent that file completely at least once
  "$py" - "$work/served.log" "$1" <<'EOF'
import os, sys
lines = open(sys.argv[1]).read().split("\n") if os.path.exists(sys.argv[1]) else []
for line in filter(None, lines):
    p, sent, size = line.split()
    if p == sys.argv[2] and int(sent) == int(size) and int(size) > 0:
        sys.exit(0)
sys.exit(1)
EOF
}

uninstall() {
  stop_apps
  if [ -f "$installed_dir/uninstall.exe" ]; then
    # NSIS's uninstaller copies itself away and returns at once; it goes on deleting in the
    # background, so wait for the whole folder (a new install meanwhile would lose files to it)
    "$installed_dir/uninstall.exe" //S || true
    for _ in $(seq 1 90); do [ -e "$installed_dir" ] || break; sleep 1; done
  fi
  [ ! -e "$installed" ] || { echo "❌ could not remove the installed app before the check"; exit 1; }
  # whatever is left in the folder (a log, an empty folder) goes too, so the next install starts clean
  rm -rf "$installed_dir"
}
# the installed program is the one an installer puts in place, byte for byte: waits for it, since the
# file appears before the installer has finished writing it
wait_installed() {  # wait_installed <sum> <seconds>
  local i
  for i in $(seq 1 "$2"); do
    if [ -f "$installed" ] && [ "$(sum "$installed" 2>/dev/null)" = "$1" ]; then return 0; fi
    sleep 1
  done
  echo "installed: $(ls -l "$installed" 2>&1); its sha256 $(sum "$installed" 2>/dev/null || echo '(unreadable)'), expected $1"
  return 1
}
# what an installer puts in place (the installer stamps the program it installs, so the build folder's
# copy is not it): install it alone, wait until the program stops changing, take its sha256
installed_by() {  # installed_by <installer> → sha256 of the installed program
  uninstall >&2
  local rc=0 a="" b="" n=0
  "$1" //S >&2 || rc=$?
  [ "$rc" = 0 ] || { echo "❌ $1 exited $rc" >&2; exit 1; }
  for _ in $(seq 1 120); do
    b="$( [ -f "$installed" ] && sum "$installed" 2>/dev/null || true)"
    if [ -n "$b" ] && [ "$b" = "$a" ]; then n=$((n + 1)); [ "$n" -ge 3 ] && break; else n=0; fi
    a="$b"
    sleep 1
  done
  [ "$n" -ge 3 ] || { echo "❌ $1 put no settled program in place" >&2; exit 1; }
  echo "$b"
}
install_old() {
  uninstall
  "$old_installer" //S
  wait_installed "$old_sum" 120 || { echo "❌ the old version is not what got installed"; ls -la "$installed_dir" || true; exit 1; }
}
echo "== what each installer puts in place"
new_sum="$(installed_by "$new_installer")"
old_sum="$(installed_by "$old_installer")"
echo "new $new_sum, old $old_sum"
[ "$old_sum" != "$new_sum" ] || { echo "❌ the old and the new installer put the same program in place"; exit 1; }

# start the installed app in test mode (loopback GitHub, its own profile); its updater looks at once
run_old() {
  local rec="$1"
  : > "$rec"
  : > "$rec.control"
  env CAVIL_CLIENT_TEST_MODE=1 CAVIL_CLIENT_TEST_API="$base/api" CAVIL_CLIENT_TEST_WEB="$base/web" \
    CAVIL_CLIENT_TEST_CREDENTIAL_FILE="$(win "$work/cred")" CAVIL_CLIENT_USER_DATA="$(win "$work/profile-$(basename "$rec")")" \
    CAVIL_CLIENT_TEST_ALERTS_FILE="$(win "$rec")" CAVIL_CLIENT_TEST_CONTROL_FILE="$(win "$rec.control")" \
    CAVIL_CLIENT_TEST_UPDATE=1 CAVIL_CLIENT_TEST_UPDATE_PUBKEY="$pub" CAVIL_CLIENT_TEST_UPDATE_CHANNEL="$channel" \
    "$installed" --hidden >"$rec.out" 2>&1 &
  pid=$!
}

last_status() {
  "$py" - "$1" <<'EOF'
import json, sys
last = None
for line in open(sys.argv[1], encoding="utf-8", errors="replace"):
    try:
        r = json.loads(line)
    except ValueError:
        continue
    if r.get("op") == "update":
        last = r["status"]
print(json.dumps(last))
EOF
}
ever_phase() {
  "$py" - "$1" "$2" <<'EOF'
import json, sys
for line in open(sys.argv[1], encoding="utf-8", errors="replace"):
    try:
        r = json.loads(line)
    except ValueError:
        continue
    if r.get("op") == "update" and (r.get("status") or {}).get("phase") == sys.argv[2]:
        sys.exit(0)
sys.exit(1)
EOF
}
wait_round() {
  local rec="$1"
  for _ in $(seq 1 180); do
    st="$(last_status "$rec")"
    if "$py" -c 'import json,sys; s=json.loads(sys.argv[1]); sys.exit(0 if s and s.get("phase") in ("idle","ready") and s.get("last") else 1)' "$st"; then
      echo "$st"
      return 0
    fi
    sleep 1
  done
  echo "❌ no finished round within 180 s; last status: $(last_status "$rec")"
  tail -20 "$rec.out" || true
  return 1
}
smoke() {  # smoke <what> → the installed app starts, mounts its window and reaches its back end
  local out="$work/smoke-$1.txt"
  rm -f "$out"
  timeout 120 "$installed" --smoke-test "--smoke-out=$(win "$out")" || true
  cat "$out" 2>/dev/null || true
  grep -q 'CAVIL_SMOKE_OK' "$out" 2>/dev/null || { echo "❌ the installed app ($1) did not start"; exit 1; }
}
tree_sum() { (cd "$installed_dir" && find . -type f -print0 | sort -z | xargs -0 sha256sum) | sha256sum | cut -d' ' -f1; }

echo "== 1. the installed old version finds the new one, downloads it, checks it: ready"
install_old
run_old "$work/rec-good.jsonl"
st="$(wait_round "$work/rec-good.jsonl")" || exit 1
echo "updater: $st"
"$py" -c 'import json,sys; s=json.loads(sys.argv[1]); sys.exit(0 if s["phase"]=="ready" and s["version"]==sys.argv[2] else 1)' "$st" "$new" \
  || { echo "❌ the update did not end ready for $new"; exit 1; }
ever_phase "$work/rec-good.jsonl" downloading || { echo "❌ never reported downloading"; exit 1; }
served_whole "/web/GigleAI/cavil-loop/releases/download/$tag/setup.exe" || { echo "❌ the stand-in never served the whole installer"; cat "$work/served.log" || true; exit 1; }

echo "== 2. restart, as a person asks for it: the waiting installer puts the new version in place"
echo restart >> "$work/rec-good.jsonl.control"
wait_installed "$new_sum" 240 || { echo "❌ the new version was not installed within 240 s after the restart"; tail -20 "$work/rec-good.jsonl.out" || true; exit 1; }
# the installer starts the new app when it is done; give it a moment, then stop every copy
sleep 5
stop_apps
sleep 2

echo "== 3. the installed program is the new build's, and it starts"
[ "$(sum "$installed")" = "$new_sum" ] || { echo "❌ the installed program is not the new build"; exit 1; }
smoke new
echo "✅ updated $old → $new: the installed program is the new build, served whole, starts"

echo "== 4. an installer that does not match its signature is refused; the old version stays as it was"
install_old
before="$(tree_sum)"
printf 'tampered' >> "$dl/setup.exe"
: > "$work/served.log"
run_old "$work/rec-bad.jsonl"
st="$(wait_round "$work/rec-bad.jsonl")" || exit 1
echo "updater: $st"
stop_apps
sleep 2
"$py" -c 'import json,sys; s=json.loads(sys.argv[1]); sys.exit(0 if s["phase"]=="idle" and not s["last"]["ok"] and "签名校验失败" in s["last"]["message"] else 1)' "$st" \
  || { echo "❌ a tampered installer was not reported as a signature failure"; exit 1; }
served_whole "/web/GigleAI/cavil-loop/releases/download/$tag/setup.exe" || { echo "❌ the tampered installer was never served whole: the refusal did not come from the app's own check"; exit 1; }
after="$(tree_sum)"
[ "$before" = "$after" ] || { echo "❌ the installed app changed after a refused installer"; exit 1; }
[ "$(sum "$installed")" = "$old_sum" ] || { echo "❌ the installed program is no longer the old version"; exit 1; }
smoke old
cp "$work/good.exe" "$dl/setup.exe"
echo "✅ tampered installer served whole and refused as a signature failure; installed files unchanged; the old version starts"
uninstall
