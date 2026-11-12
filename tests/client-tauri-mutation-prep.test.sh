#!/usr/bin/env bash
# kind: meta
# client/test/tauri/mutations.sh prepares what its entries read (GitHub#195 review round 2): the built
# window (dist/) and the app's icons are not in git, and the nightly negative-controls run starts from a clean
# checkout. The real script runs with a fake `node` that records every call and, for an entry,
# records whether dist/ existed at that moment — no app is built, nothing is broken, no negative
# control actually runs.
#
#   bash tests/client-tauri-mutation-prep.test.sh
set -euo pipefail
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
PASS=0; FAIL=0
check() { if [ "$2" = "$3" ]; then PASS=$((PASS + 1)); echo "  ok   $1"; else FAIL=$((FAIL + 1)); echo "  FAIL $1 (want [$3], got [$2])"; fi; }

# A clean checkout's shape: the script, its runner and the shared switch, no dist/, no icons.
fresh() {
    C="$TMP/co$1"; rm -rf "$C"
    mkdir -p "$C/client/test/tauri" "$C/client/scripts" "$C/tests/lib" "$C/bin"
    cp "$REPO_DIR/client/test/tauri/mutations.sh" "$C/client/test/tauri/"
    : > "$C/client/test/tauri/mutations.mjs"; : > "$C/client/scripts/build.mjs"
    cp "$REPO_DIR/tests/lib/mutation.sh" "$C/tests/lib/"
    cat > "$C/bin/node" <<'SH'
#!/usr/bin/env bash
c="$(cd "$(dirname "$0")/.." && pwd)/client"
case "$1" in
    */scripts/build.mjs)
        echo "build" >> "$LOG"
        [ -z "${BUILD_FAILS:-}" ] || exit 1
        mkdir -p "$c/dist/renderer" "$c/src-tauri/icons" ;;
    */mutations.mjs)
        case "$2" in
            --count) echo 3 ;;
            --one) echo "one $3 dist=$([ -d "$c/dist/renderer" ] && echo yes || echo no) icons=$([ -d "$c/src-tauri/icons" ] && echo yes || echo no)" >> "$LOG" ;;
            *) echo "unexpected $*" >> "$LOG"; exit 9 ;;
        esac ;;
    *) echo "unexpected $*" >> "$LOG"; exit 9 ;;
esac
SH
    chmod +x "$C/bin/node"
    LOG="$C/log"; : > "$LOG"
}
run() {   # [env…] → $RC, $OUT
    RC=0
    OUT=$(cd "$C/client" && env -i PATH="$C/bin:/usr/bin:/bin" LOG="$LOG" "$@" bash test/tauri/mutations.sh 2>&1) || RC=$?
}

echo "== default mode: counts only, builds nothing"
fresh 1; run
check "exit 0" "$RC" 0
check "no build, no entry ran" "$(cat "$LOG")" ""
case "$OUT" in *"跳过 3 项"*) PASS=$((PASS + 1)); echo "  ok   says 3 skipped" ;; *) FAIL=$((FAIL + 1)); echo "  FAIL says 3 skipped ($OUT)" ;; esac
check "clean checkout still has no dist/" "$([ -e "$C/client/dist" ] && echo yes || echo no)" no

echo "== switch on, clean checkout: build first, then every entry sees dist/ and the icons"
fresh 2; run MUTATION=1
check "exit 0" "$RC" 0
check "build before the first entry, once" "$(cat "$LOG")" "build
one 0 dist=yes icons=yes
one 1 dist=yes icons=yes
one 2 dist=yes icons=yes"

echo "== build fails: stop, no entry runs, red"
fresh 3; run MUTATION=1 BUILD_FAILS=1
[ "$RC" -ne 0 ] && { PASS=$((PASS + 1)); echo "  ok   exit non-zero"; } || { FAIL=$((FAIL + 1)); echo "  FAIL exit non-zero"; }
check "only the build was attempted" "$(cat "$LOG")" "build"
case "$OUT" in *"一项真实窗口负对照都没跑"*) PASS=$((PASS + 1)); echo "  ok   says nothing ran" ;; *) FAIL=$((FAIL + 1)); echo "  FAIL says nothing ran ($OUT)" ;; esac

echo
echo "passed $PASS, failed $FAIL"
report_counts "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
