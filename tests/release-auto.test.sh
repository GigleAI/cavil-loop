#!/usr/bin/env bash
# scripts/release.sh: the non-interactive mode the weekly Release workflow
# runs (--auto), the Release title (--title), and the interactive mode a
# maintainer runs by hand. Real script, real git repos (bare remote + clone).
#
#   bash tests/release-auto.test.sh
#   RELEASE_SH=/path/to/old/release.sh bash tests/release-auto.test.sh   # negative control
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RELEASE_SH="${RELEASE_SH:-$REPO_DIR/scripts/release.sh}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export HOME="$TMP/home"
mkdir -p "$HOME"
git config --global user.email test@example.invalid
git config --global user.name test
git config --global init.defaultBranch main

PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); echo "  ok   $1"; }
bad() { FAIL=$((FAIL + 1)); echo "  FAIL $1"; }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (want [$3], got [$2])"; fi; }

REMOTE="$TMP/remote.git"
WORK="$TMP/work"
git init -q --bare "$REMOTE"
git clone -q "$REMOTE" "$WORK" 2>/dev/null

commit() {
    echo "$1" >> "$WORK/file"
    git -C "$WORK" add file
    git -C "$WORK" commit -qm "$1"
    git -C "$WORK" push -q origin main
}
remote_tags() { git -C "$REMOTE" tag -l 'release/v*' | sort | tr '\n' ' ' | sed 's/ $//'; }
# Run the script inside the clone; stdout → $TMP/out, stderr → $TMP/err, rc → $RC.
run() {
    set +e
    (cd "$WORK" && bash "$RELEASE_SH" "$@") >"$TMP/out" 2>"$TMP/err" <"${STDIN:-/dev/null}"
    RC=$?
    set -e
}

TODAY="$(date -u +%Y.%m.%d)"

echo "== --auto: first release on a repo with commits"
commit one
run --auto
check "exit 0" "$RC" 0
check "stdout is exactly the tag" "$(cat "$TMP/out")" "release/v$TODAY.1"
check "tag pushed to remote" "$(remote_tags)" "release/v$TODAY.1"
check "tag points at main tip" "$(git -C "$REMOTE" rev-parse "release/v$TODAY.1^{commit}")" "$(git -C "$REMOTE" rev-parse main)"

echo "== --auto: HEAD already tagged"
run --auto
check "exit 3 (already tagged)" "$RC" 3
check "stdout is the existing tag" "$(cat "$TMP/out")" "release/v$TODAY.1"
check "no new tag" "$(remote_tags)" "release/v$TODAY.1"
grep -q "already tagged release/v$TODAY.1" "$TMP/err" && ok "says why on stderr" || bad "says why on stderr"

echo "== --auto: new commit the same day → next sequence number"
commit two
run --auto
check "exit 0" "$RC" 0
check "stdout is .2" "$(cat "$TMP/out")" "release/v$TODAY.2"
check "remote has .1 and .2" "$(remote_tags)" "release/v$TODAY.1 release/v$TODAY.2"

echo "== --auto: local main ahead of origin → refuse, no tag"
echo three >> "$WORK/file"; git -C "$WORK" commit -qam three
run --auto
check "exit 1" "$RC" 1
check "stdout empty" "$(cat "$TMP/out")" ""
check "no new tag" "$(remote_tags)" "release/v$TODAY.1 release/v$TODAY.2"
check "no local tag either" "$(git -C "$WORK" tag --points-at HEAD)" ""
git -C "$WORK" push -q origin main

echo "== --auto: dirty tree → refuse"
echo dirt > "$WORK/untracked"
run --auto
check "exit 1" "$RC" 1
check "no new tag" "$(remote_tags)" "release/v$TODAY.1 release/v$TODAY.2"
rm "$WORK/untracked"

echo "== --auto: not on main → refuse"
git -C "$WORK" checkout -qb other
run --auto
check "exit 1" "$RC" 1
check "no new tag" "$(remote_tags)" "release/v$TODAY.1 release/v$TODAY.2"
git -C "$WORK" checkout -q main

echo "== --auto: the commit that was ahead is now pushed → releases it"
run --auto
check "exit 0" "$RC" 0
check "stdout is .3" "$(cat "$TMP/out")" "release/v$TODAY.3"

echo "== interactive mode unchanged"
commit four
printf 'n\n' > "$TMP/no"; STDIN="$TMP/no" run
check "answer n → exit 1" "$RC" 1
grep -q '^aborted' "$TMP/out" && ok "prints aborted" || bad "prints aborted"
check "no new tag" "$(remote_tags)" "release/v$TODAY.1 release/v$TODAY.2 release/v$TODAY.3"
run --dry-run
check "--dry-run exit 0" "$RC" 0
grep -q "Will create tag:  release/v$TODAY.4" "$TMP/out" && ok "--dry-run names .4" || bad "--dry-run names .4"
check "--dry-run creates no tag" "$(remote_tags)" "release/v$TODAY.1 release/v$TODAY.2 release/v$TODAY.3"
printf 'y\n' > "$TMP/yes"; STDIN="$TMP/yes" run
check "answer y → exit 0" "$RC" 0
check "tag .4 pushed" "$(remote_tags)" "release/v$TODAY.1 release/v$TODAY.2 release/v$TODAY.3 release/v$TODAY.4"
STDIN="$TMP/yes" run
check "interactive still tags an already-released HEAD (as before)" "$RC" 0

echo "== --title: Monday–Sunday iteration of the tag's date"
title() { run --title "$1"; [ "$RC" = 0 ] && cat "$TMP/out" || echo "rc=$RC"; }
check "Sunday (the weekly run)" "$(title release/v2026.10.25.1)" "release/v2026.10.25.1 · 迭代 2026-10-19 ~ 10-25"
check "Monday" "$(title release/v2026.10.19.2)" "release/v2026.10.19.2 · 迭代 2026-10-19 ~ 10-25"
check "mid-week" "$(title release/v2026.10.22.1)" "release/v2026.10.22.1 · 迭代 2026-10-19 ~ 10-25"
check "across a month" "$(title release/v2026.11.01.1)" "release/v2026.11.01.1 · 迭代 2026-10-26 ~ 11-01"
check "across a year keeps the year" "$(title release/v2027.01.01.1)" "release/v2027.01.01.1 · 迭代 2026-12-28 ~ 2027-01-03"
check "leap day" "$(title release/v2028.02.29.1)" "release/v2028.02.29.1 · 迭代 2028-02-28 ~ 03-05"
check "not a release tag → exit 2" "$(title v1.0)" "rc=2"
check "impossible date → exit 2" "$(title release/v2026.13.40.1)" "rc=2"

echo "== the workflow's own steps (run: blocks read out of release.yml)"
WORKFLOW="${WORKFLOW:-$REPO_DIR/.github/workflows/release.yml}"
step() {  # step <name> → that step's run: script
    python3 - "$WORKFLOW" "$1" <<'PY2'
import sys, yaml
steps = yaml.safe_load(open(sys.argv[1]))["jobs"]["release"]["steps"]
print(next(s["run"] for s in steps if s.get("name") == sys.argv[2]))
PY2
}
step "Cut tag (scheduled / manual)" > "$TMP/cut.sh"
step "Generate release notes" > "$TMP/notes.sh"
step "Create GitHub Release" > "$TMP/create.sh"
# Actions runs `bash -e` in a fresh checkout; the steps call scripts/release.sh from there.
mkdir -p "$WORK/scripts"; cp "$RELEASE_SH" "$WORK/scripts/release.sh"
git -C "$WORK" add scripts; git -C "$WORK" commit -qm "add release.sh"; git -C "$WORK" push -q origin main
CLONES=0
fresh() {  # a new checkout of the remote, like every Actions run gets
    CLONES=$((CLONES + 1)); WORK="$TMP/run$CLONES"
    git clone -q "$REMOTE" "$WORK" 2>/dev/null
}
runstep() {  # runstep <script> → $RC, GITHUB_ENV content in $TMP/env
    : > "$TMP/env"; rm -f "$TMP/gh-args"
    set +e
    (cd "$WORK" && GITHUB_ENV="$TMP/env" PATH="$TMP/bin:$PATH" bash -e "$1") >"$TMP/out" 2>"$TMP/err"
    RC=$?
    set -e
}
# Fake gh holding the repo's Releases in a file, one tag per line, with
# switches to make the lookup or the create fail.
mkdir -p "$TMP/bin"
cat > "$TMP/bin/gh" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$GH_ARGS"
case "$1" in
    api)
        [ -z "${GH_FAIL_API:-}" ] || { echo "HTTP 502: injected" >&2; exit 1; }
        case " $* " in *" repos/$GITHUB_REPOSITORY/releases "*) ;; *) echo "unexpected: $*" >&2; exit 9 ;; esac
        cat "$GH_RELEASES" ;;
    release)
        [ "$2" = create ] || exit 9
        [ -z "${GH_FAIL_CREATE:-}" ] || { echo "injected: release API unavailable" >&2; exit 1; }
        echo "$3" >> "$GH_RELEASES" ;;
    *) exit 9 ;;
esac
SH
chmod +x "$TMP/bin/gh"
export GH_ARGS="$TMP/gh-args" GH_RELEASES="$TMP/releases" GITHUB_REPOSITORY=o/r
git -C "$REMOTE" tag -l 'release/v*' > "$GH_RELEASES"   # .1–.5 from above all have their page
released() { grep -qxF "$1" "$GH_RELEASES"; }
title_arg() { awk 'prev == "--title" { print; exit } { prev = $0 }' "$TMP/gh-args"; }
# One whole run: cut → notes → create, stopping where Actions would.
fullrun() {
    fresh; runstep "$TMP/cut.sh"; CUT_RC=$RC; CUT_OUT="$(cat "$TMP/out")"
    tag="$(sed -n 's/^tag=//p' "$TMP/env")"; export tag
    NOTES=""; CREATE_RC=""
    [ "$CUT_RC" = 0 ] && [ -n "$tag" ] || return 0
    runstep "$TMP/notes.sh"; NOTES_RC=$RC; NOTES="$(cat "$WORK/release-notes.md" 2>/dev/null || true)"
    [ "$NOTES_RC" = 0 ] || return 0
    runstep "$TMP/create.sh"; CREATE_RC=$RC
}
has() { case "$2" in *"$1"*) ok "$3" ;; *) bad "$3 (missing [$1])" ;; esac; }
lacks() { case "$2" in *"$1"*) bad "$3 (unexpected [$1])" ;; *) ok "$3" ;; esac; }

echo "-- new commits → tag, notes, Release"
# .1–.5 are taken above (the second interactive run re-tagged HEAD as .5).
fullrun
check "cut step succeeds" "$CUT_RC" 0
check "exports the new tag" "$tag" "release/v$TODAY.6"
check "tag pushed" "$(git -C "$REMOTE" tag -l "release/v$TODAY.6")" "release/v$TODAY.6"
# .4 and .5 sit on the same commit, so either may head the notes; what matters is the range.
has "- add release.sh (" "$NOTES" "notes list the new commit"
lacks "- four (" "$NOTES" "notes start after the previous release"
check "Release created" "$CREATE_RC" 0
released "release/v$TODAY.6" && ok "Release page exists" || bad "Release page exists"
check "Release title carries the iteration" "$(title_arg)" "$(bash "$RELEASE_SH" --title "release/v$TODAY.6")"

echo "-- nothing new and already released → nothing to do"
fullrun
check "cut step succeeds" "$CUT_RC" 0
check "no tag exported (later steps skip)" "$tag" ""
has '本轮无新提交' "$CUT_OUT" "says so in the run log"
check "no duplicate Release" "$(grep -cxF "release/v$TODAY.6" "$GH_RELEASES")" 1

echo "-- tag pushed, Release creation failed → the next run creates it"
commit seven
GH_FAIL_CREATE=1 fullrun
check "first run: tag exported" "$tag" "release/v$TODAY.7"
[ "$CREATE_RC" != 0 ] && ok "first run: create fails" || bad "first run: create fails"
released "release/v$TODAY.7" && bad "first run: no Release page" || ok "first run: no Release page"
fullrun
check "rerun: cut step succeeds" "$CUT_RC" 0
check "rerun: exports the existing tag" "$tag" "release/v$TODAY.7"
has '补建' "$CUT_OUT" "rerun: says it is creating the missing page"
check "rerun: no new tag" "$(git -C "$REMOTE" tag -l "release/v$TODAY.8")" ""
has "Changes since \`release/v$TODAY.6\`" "$NOTES" "rerun: notes start at the previous release"
has "- seven (" "$NOTES" "rerun: notes list the tagged commit"
check "rerun: Release created" "$CREATE_RC" 0
released "release/v$TODAY.7" && ok "rerun: Release page exists" || bad "rerun: Release page exists"
fullrun
check "third run: nothing to do" "$tag" ""
check "third run: no duplicate Release" "$(grep -cxF "release/v$TODAY.7" "$GH_RELEASES")" 1

echo "-- Release lookup fails → the run fails, never guesses"
GH_FAIL_API=1 fullrun
[ "$CUT_RC" != 0 ] && ok "cut step fails" || bad "cut step fails"
check "no tag exported" "$tag" ""

echo "-- a tag that never got its page is skipped as the notes' starting point"
commit eight
GH_FAIL_CREATE=1 fullrun
check "orphan tag .8 pushed" "$tag" "release/v$TODAY.8"
released "release/v$TODAY.8" && bad "orphan has no page" || ok "orphan has no page"
commit nine
fullrun
check "next run tags .9" "$tag" "release/v$TODAY.9"
has "Changes since \`release/v$TODAY.7\`" "$NOTES" "notes start at the last tag with a page"
has "- eight (" "$NOTES" "the orphan's commit is in these notes"
has "- nine (" "$NOTES" "the new commit is in these notes"
lacks "- seven (" "$NOTES" "already-released commits are not repeated"
check "Release created" "$CREATE_RC" 0
fresh; export tag="release/v$TODAY.9"
GH_FAIL_API=1 runstep "$TMP/notes.sh"
[ "$RC" != 0 ] && ok "notes: lookup failure fails the step" || bad "notes: lookup failure fails the step"

echo "-- not on main → the cut step fails"
fresh; git -C "$WORK" checkout -qb not-main
runstep "$TMP/cut.sh"
[ "$RC" -ne 0 ] && ok "step fails" || bad "step fails"
check "no tag exported" "$(cat "$TMP/env")" ""

echo "-- a tag pushed by hand on a commit from before --title existed"
fresh
printf '#!/usr/bin/env bash\necho "usage: $0 [--dry-run]" >&2; exit 2\n' > "$WORK/scripts/release.sh"
export tag=release/v2026.10.25.1
runstep "$TMP/create.sh"
check "release still created" "$RC" 0
check "title falls back to the bare tag" "$(title_arg)" "release/v2026.10.25.1"

echo
echo "passed $PASS, failed $FAIL"
[ "$FAIL" -eq 0 ]
