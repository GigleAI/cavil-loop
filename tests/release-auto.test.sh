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
remote_tags_all() { git -C "$REMOTE" tag -l 'release/v*' | sort | tr '\n' ' '; }
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
step() {  # step [job] <name> → that step's run: script (job defaults to release)
    local job=release; [ $# -eq 2 ] && { job="$1"; shift; }
    python3 - "$WORKFLOW" "$job" "$1" <<'PY2'
import sys, yaml
steps = yaml.safe_load(open(sys.argv[1]))["jobs"][sys.argv[2]]["steps"]
print(next(s["run"] for s in steps if s.get("name") == sys.argv[3]))
PY2
}
step plan "Decide what this run does" > "$TMP/plan.sh"
step gate-summary "Every gate job passed" > "$TMP/summary.sh"
step "Gate passed" > "$TMP/guard.sh"
# The `needs` context a job sees in Actions: exactly the jobs its `needs:` declares, each with a
# result (and the plan's outputs). <job> <space-separated job=result overrides>; default success.
needs_json() {
    python3 - "$WORKFLOW" "$1" "$2" "${PLAN_SHA:-}" "${PLAN_WORK:-}" <<'PY3'
import json, sys, yaml
wf, job, over, sha, work = sys.argv[1:6]
needs = yaml.safe_load(open(wf))["jobs"][job].get("needs", [])
needs = [needs] if isinstance(needs, str) else needs
res = dict(kv.split("=", 1) for kv in over.split())
out = {}
for j in needs:
    out[j] = {"result": res.get(j, "success"), "outputs": {}}
    if j == "plan":
        out[j]["outputs"] = {"sha": sha, "work": work}
print(json.dumps(out))
PY3
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
runstep() {  # runstep <script> → $RC, GITHUB_ENV content in $TMP/env, GITHUB_OUTPUT in $TMP/output
    : > "$TMP/env"; : > "$TMP/output"; rm -f "$TMP/gh-args"
    set +e
    (cd "$WORK" && GITHUB_ENV="$TMP/env" GITHUB_OUTPUT="$TMP/output" EVENT="${EVENT:-schedule}" GITHUB_REF="${GITHUB_REF:-}" \
        NEEDS="${NEEDS:-}" GATE_ONLY="${GATE_ONLY:-}" \
        RELEASE_SHA="${RELEASE_SHA:-}" PATH="$TMP/bin:$PATH" bash -e "$1") >"$TMP/out" 2>"$TMP/err"
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
# One whole run: plan → (gate, not run here) → cut → notes → create, stopping where
# Actions would. MOVE_MAIN=<msg> pushes a new commit to main between plan and cut,
# like a merge landing while the gate runs; the release job's fresh checkout sees it.
fullrun() {
    fresh; runstep "$TMP/plan.sh"; PLAN_RC=$RC; CUT_OUT="$(cat "$TMP/out")"
    PLAN_SHA="$(sed -n 's/^sha=//p' "$TMP/output")"; PLAN_WORK="$(sed -n 's/^work=//p' "$TMP/output")"
    tag=""; export tag; NOTES=""; CREATE_RC=""; CUT_RC=$PLAN_RC
    SUMMARY_RC=""; GUARD_RC=""
    [ "$PLAN_RC" = 0 ] && [ "$PLAN_WORK" = true ] || return 0
    # The gate jobs themselves are not run here: GATE="<job>=<result> …" says how they ended.
    NEEDS="$(needs_json gate-summary "${GATE:-}")" runstep "$TMP/summary.sh"; SUMMARY_RC=$RC
    local summary=success; [ "$SUMMARY_RC" = 0 ] || summary=failure
    NEEDS="$(needs_json release "gate-summary=$summary")" runstep "$TMP/guard.sh"; GUARD_RC=$RC
    [ "$GUARD_RC" = 0 ] || return 0
    if [ -n "${MOVE_MAIN:-}" ]; then commit "$MOVE_MAIN"; fi
    fresh; RELEASE_SHA="$PLAN_SHA" runstep "$TMP/cut.sh"; CUT_RC=$RC; CUT_OUT="$CUT_OUT
$(cat "$TMP/out")"
    tag="$(sed -n 's/^tag=//p' "$TMP/env")"; export tag
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
check "plan step succeeds" "$PLAN_RC" 0
check "plan says no work (gate and release jobs skip)" "$PLAN_WORK" false
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
check "rerun: plan asks for the gate before the missing page" "$PLAN_WORK" true
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
commit seven-b
git -C "$REMOTE" tag "release/v$TODAY.7b" main   # tagged, page unknown
GH_FAIL_API=1 fullrun
[ "$PLAN_RC" != 0 ] && ok "plan step fails" || bad "plan step fails"
check "plan writes no decision" "$PLAN_WORK" ""
check "no tag exported" "$tag" ""
fresh; GH_FAIL_API=1 RELEASE_SHA="$(git -C "$WORK" rev-parse HEAD)" runstep "$TMP/cut.sh"
[ "$RC" != 0 ] && ok "cut step: lookup failure fails too" || bad "cut step: lookup failure fails too"
git -C "$REMOTE" tag -d "release/v$TODAY.7b" >/dev/null

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

echo "-- main moves while the gate runs → the tag goes on the tested commit"
commit ten
MOVE_MAIN=eleven fullrun
check "tag .10 exported" "$tag" "release/v$TODAY.10"
check ".10 points at the planned commit" "$(git -C "$REMOTE" rev-parse "release/v$TODAY.10^{commit}")" "$PLAN_SHA"
[ "$PLAN_SHA" != "$(git -C "$REMOTE" rev-parse main)" ] && ok "… which is not main's newer tip" || bad "… which is not main's newer tip"
has "- ten (" "$NOTES" "notes list the tested commit"
lacks "- eleven (" "$NOTES" "notes leave out the commit that landed during the gate"
check "Release created" "$CREATE_RC" 0
fullrun
check "next run plans the newer commit" "$PLAN_SHA" "$(git -C "$REMOTE" rev-parse main)"
check "… and tags it .11" "$tag" "release/v$TODAY.11"

echo "-- the gate did not pass → no tag, no Release (GitHub#195)"
commit twelve
TAGS_BEFORE="$(remote_tags_all)"; PAGES_BEFORE="$(wc -l < "$GH_RELEASES")"
for g in "gate-client=failure" "gate=failure" "gate-autopilot=failure" "gate-autopilot=skipped" "gate-client=cancelled"; do
    GATE="$g" fullrun
    check "$g: plan asked for the gate" "$PLAN_WORK" true
    [ "$SUMMARY_RC" != 0 ] && ok "$g: release gate is red" || bad "$g: release gate is red"
    [ "$GUARD_RC" != 0 ] && ok "$g: release job stops at its own check" || bad "$g: release job stops at its own check"
    check "$g: no tag" "$(remote_tags_all)" "$TAGS_BEFORE"
    check "$g: no Release page" "$(wc -l < "$GH_RELEASES")" "$PAGES_BEFORE"
done
GATE_ONLY=true fullrun
check "gate-only run: release gate green" "$SUMMARY_RC" 0
[ "$GUARD_RC" != 0 ] && ok "gate-only run: release job refuses" || bad "gate-only run: release job refuses"
check "gate-only run: no tag" "$(remote_tags_all)" "$TAGS_BEFORE"
check "gate-only run: no Release page" "$(wc -l < "$GH_RELEASES")" "$PAGES_BEFORE"
fullrun
check "gate passes → the release job's check passes" "$GUARD_RC" 0
check "… and the planned commit is released" "$tag" "release/v$TODAY.12"
check "… on the planned commit" "$(git -C "$REMOTE" rev-parse "release/v$TODAY.12^{commit}")" "$PLAN_SHA"
check "… with its page" "$CREATE_RC" 0

echo "-- a pushed tag: the plan step gates that tag's commit"
fresh; git -C "$WORK" tag "release/v$TODAY.99" HEAD~1
EVENT=push GITHUB_REF="refs/tags/release/v$TODAY.99" runstep "$TMP/plan.sh"
check "plan succeeds" "$RC" 0
check "plan: work" "$(sed -n 's/^work=//p' "$TMP/output")" true
check "plan: the tag's commit" "$(sed -n 's/^sha=//p' "$TMP/output")" "$(git -C "$WORK" rev-parse HEAD~1)"

echo "-- not on main → the cut step fails"
fresh; git -C "$WORK" checkout -qb not-main
RELEASE_SHA="$(git -C "$WORK" rev-parse HEAD)" runstep "$TMP/cut.sh"
[ "$RC" -ne 0 ] && ok "step fails" || bad "step fails"
check "no tag exported" "$(cat "$TMP/env")" ""

echo "-- a tag pushed by hand on a commit from before --title existed"
fresh
printf '#!/usr/bin/env bash\necho "usage: $0 [--dry-run]" >&2; exit 2\n' > "$WORK/scripts/release.sh"
export tag=release/v2026.10.25.1
runstep "$TMP/create.sh"
check "release still created" "$RC" 0
check "title falls back to the bare tag" "$(title_arg)" "release/v2026.10.25.1"

echo "== --pending and --at (GitHub#195: the plan step, and tagging the commit the gate tested)"
# A repo of its own, so the tag numbers above stay as they are.
REMOTE="$TMP/remote2.git"; WORK="$TMP/work2"
git init -q --bare "$REMOTE"; git clone -q "$REMOTE" "$WORK" 2>/dev/null
commit p1
run --pending
check "--pending, new commit → exit 0" "$RC" 0
check "--pending prints the tag --auto would cut" "$(cat "$TMP/out")" "release/v$TODAY.1"
check "--pending tags nothing" "$(remote_tags)" ""
check "--pending: no local tag either" "$(git -C "$WORK" tag -l 'release/v*')" ""
echo dirt > "$WORK/untracked"; run --pending
check "--pending, dirty tree → refuse like --auto" "$RC" 1
rm "$WORK/untracked"
PLANNED="$(git -C "$WORK" rev-parse HEAD)"
commit p2
run --pending --at "$PLANNED"
check "--pending --at an older main commit → exit 0" "$RC" 0
run --auto --at "$PLANNED"
check "--auto --at: exit 0" "$RC" 0
check "--auto --at: stdout is the tag" "$(cat "$TMP/out")" "release/v$TODAY.1"
check "the tag points at the planned commit, not main's newer tip" \
    "$(git -C "$REMOTE" rev-parse "release/v$TODAY.1^{commit}")" "$PLANNED"
run --pending --at "$PLANNED"
check "--pending --at an already tagged commit → exit 3" "$RC" 3
check "… and prints that tag" "$(cat "$TMP/out")" "release/v$TODAY.1"
run --auto --at "$PLANNED"
check "--auto --at an already tagged commit → exit 3" "$RC" 3
git -C "$WORK" checkout -qb side; echo side >> "$WORK/file"; git -C "$WORK" commit -qam side
SIDE="$(git -C "$WORK" rev-parse HEAD)"; git -C "$WORK" checkout -q main
run --auto --at "$SIDE"
check "--at a commit not on main → exit 1" "$RC" 1
run --pending --at "$SIDE"
check "--pending --at a commit not on main → exit 1" "$RC" 1
run --auto --at no-such-commit
check "--at something that is not a commit → exit 1" "$RC" 1
check "none of those created a tag" "$(remote_tags)" "release/v$TODAY.1"
run --auto --at
check "--at without a value → usage, exit 2" "$RC" 2
run --dry-run --at "$PLANNED"
check "--dry-run takes no --at → exit 2" "$RC" 2
run --auto
check "plain --auto still tags HEAD" "$(git -C "$REMOTE" rev-parse "release/v$TODAY.2^{commit}")" "$(git -C "$WORK" rev-parse HEAD)"

# ── negative controls (MUTATION=1): a broken copy of release.yml must turn this file red ──
# The whole file reruns against the broken copy (WORKFLOW=…) and must exit non-zero.
if [ -z "${RELEASE_AUTO_NESTED:-}" ]; then
    # shellcheck source=lib/mutation.sh
    source "$REPO_DIR/tests/lib/mutation.sh"
    MUT_FAIL=0
    wf_mutant() {   # <name> <old> <new>
        local name="$1" m="$TMP/wf-$1.yml" rc=0
        mutation_gate || return 0
        if ! python3 - "$WORKFLOW" "$m" "$2" "$3" <<'PY4'
import sys
src, dst, old, new = sys.argv[1:5]
t = open(src).read()
if t.count(old) != 1:
    sys.exit(1)
open(dst, "w").write(t.replace(old, new))
PY4
        then echo "  ❌ 负对照 $name：找不到要改的原文（准备失败）"; MUT_FAIL=$((MUT_FAIL + 1)); return 0; fi
        RELEASE_AUTO_NESTED=1 WORKFLOW="$m" MUTATION= bash "$0" >"$TMP/wf-$1.log" 2>&1 || rc=$?
        if [ "$rc" -ne 0 ]; then echo "  ✅ 负对照 $name：变红"; else echo "  ❌ 负对照 $name：仍全绿"; MUT_FAIL=$((MUT_FAIL + 1)); fi
    }
    wf_mutant guard-ignores-gate 'if [ "$plan" != success ] || [ "$work" != true ] || [ "$gate" != success ]; then' 'if false; then'
    wf_mutant guard-ignores-gate-only 'if [ -n "$GATE_ONLY" ]; then echo' 'if false; then echo'
    wf_mutant summary-skips-client 'for j in gate gate-autopilot gate-client; do' 'for j in gate gate-autopilot; do'
    wf_mutant summary-accepts-skipped '[ "$r" = success ] ||' '[ "$r" = success ] || [ "$r" = skipped ] ||'
    wf_mutant release-without-gate 'needs: [plan, gate-summary]' 'needs: [plan]'
    wf_mutant summary-without-client 'needs: [plan, gate, gate-autopilot, gate-client]' 'needs: [plan, gate, gate-autopilot]'
    wf_mutant cut-tags-head 'release.sh --auto --at "$RELEASE_SHA")' 'release.sh --auto)'
    echo
    mutation_summary "$0"
fi

echo
echo "passed $PASS, failed $FAIL${MUT_FAIL:+; 负对照失效 $MUT_FAIL}"
[ "${MUT_FAIL:-0}" -eq 0 ] || exit 1
[ "$FAIL" -eq 0 ]
