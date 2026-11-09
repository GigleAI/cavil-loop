#!/usr/bin/env bash
# kind: e2e
# scripts/release.sh: the non-interactive mode the weekly Release workflow
# runs (--auto), the Release title (--title), and the interactive mode a
# maintainer runs by hand. Real script, real git repos (bare remote + clone).
#
#   bash tests/release-auto.test.sh
#   RELEASE_SH=/path/to/old/release.sh bash tests/release-auto.test.sh   # negative control
set -euo pipefail
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"

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

echo "== release failure → issue (GitHub#285: the report-failure job, scripts/release_failure_report.py)"
REPORT_PY="$REPO_DIR/scripts/release_failure_report.py"
FAKE_RF="$REPO_DIR/tests/fixtures/release-failure-fake-gh.py"
mkdir -p "$TMP/rfbin"
printf '#!/usr/bin/env bash\nexec python3 %q "$@"\n' "$FAKE_RF" > "$TMP/rfbin/gh"; chmod +x "$TMP/rfbin/gh"
RF_SHA=0123456789abcdef0123456789abcdef01234567
RF=""
rf_repo() {  # a fresh fake repo: the dispatch label exists, no issues
    RF="$TMP/rf$((CLONES += 1))"; mkdir -p "$RF"
    echo '["pending/agent","doing/agent","pending/human","pending/blocked","needs-maintainer"]' > "$RF/repo_labels.json"
    echo '[]' > "$RF/issues.json"
}
# The run's job list: every job of release.yml by its display name, success unless overridden.
# rf_jobs "<display name>=<conclusion>[:<failed step>]" …
rf_jobs() {
    python3 - "$@" > "$RF/jobs.json" <<'PYJ'
import json, sys
names = ["plan"] + [f"gate {k}/4" for k in range(1, 5)] + [f"gate autopilot {k}/6" for k in range(1, 7)] \
    + ["gate client", "release gate", "release"]
over = {}
for a in sys.argv[1:]:
    n, _, v = a.partition("=")
    c, _, s = v.partition(":")
    over[n] = (c, s)
jobs = []
for i, n in enumerate(names):
    c, s = over.get(n, ("success", ""))
    steps = [{"name": "Set up job", "conclusion": "success"}]
    if s:
        steps.append({"name": s, "conclusion": "failure"})
    jobs.append({"name": n, "status": "completed", "conclusion": c, "steps": steps,
                 "html_url": f"https://github.com/o/r/actions/runs/777/job/{i + 1}"})
jobs.append({"name": "report failure", "status": "in_progress", "conclusion": None, "steps": []})
print(json.dumps({"total_count": len(jobs), "jobs": jobs}))
PYJ
}
# run_report "<job=result …>" → $RC, stdout+stderr in $TMP/rf-out; the fake's calls in $RF/calls.log
run_report() {
    : > "$RF/calls.log"
    [ -f "$RF/jobs.json" ] || rf_jobs
    local needs; needs="$(PLAN_SHA="${RF_PLAN_SHA-$RF_SHA}" PLAN_WORK=true needs_json report-failure "$1")"
    set +e
    env -u GITHUB_STEP_SUMMARY PATH="$TMP/rfbin:$PATH" FAKE_GH_DIR="$RF" GITHUB_REPOSITORY=o/r GITHUB_RUN_ID=777 \
        GITHUB_RUN_ATTEMPT=1 GITHUB_SERVER_URL=https://github.com GITHUB_SHA=feedfacefeedfacefeedfacefeedfacefeedface \
        GITHUB_REF_NAME="${RF_REF_NAME:-main}" EVENT="${RF_EVENT:-schedule}" GATE_ONLY="${RF_GATE_ONLY:-}" \
        NEEDS="$needs" SUMMARY_DIR="${RF_SUMMARY_DIR:-}" CLIENT_DIR="${RF_CLIENT_DIR:-}" \
        python3 "$REPORT_PY" > "$TMP/rf-out" 2>&1
    RC=$?
    set -e
}
rf_q() { python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(eval(sys.argv[2]))" "$@"; }
n_issues() { rf_q "$RF/issues.json" 'len(d)'; }
n_open() { rf_q "$RF/issues.json" 'len([i for i in d if i["state"]=="open"])'; }
labels_of() { rf_q "$RF/issues.json" "' '.join(sorted(l['name'] for l in next(i for i in d if i['number']==$1)['labels'])) or '-'"; }
body_of() { rf_q "$RF/issues.json" "next(i for i in d if i['number']==$1)['body']"; }
n_comments() { rf_q "$RF/comments.json" "len(d.get('$1', []))" 2>/dev/null || echo 0; }
last_comment() { rf_q "$RF/comments.json" "d['$1'][-1]"; }
set_issue() { python3 - "$RF/issues.json" "$1" "$2" <<'PYS'
import json, sys
f, n, patch = sys.argv[1], int(sys.argv[2]), json.loads(sys.argv[3])
d = json.load(open(f)); next(i for i in d if i["number"] == n).update(patch); json.dump(d, open(f, "w"))
PYS
}
writes() { grep -cE '^(POST|PATCH|PUT|DELETE) ' "$RF/calls.log" || true; }
label_writes() { grep -cE '^(POST|PUT|DELETE|PATCH) .*(/labels|issues/[0-9]+$)' "$RF/calls.log" || true; }
gets_of() { grep -cxF "GET repos/o/r/issues/$1" "$RF/calls.log" || true; }
RUN_LINK="https://github.com/o/r/actions/runs/777"

echo "-- the job itself: runs after every other job, on any failure, never on a cancelled run"
python3 - "$WORKFLOW" > "$TMP/rf-static" <<'PYW'
import sys, yaml
jobs = yaml.safe_load(open(sys.argv[1]))["jobs"]
r = jobs["report-failure"]
needs = r["needs"] if isinstance(r["needs"], list) else [r["needs"]]
print("needs-all", sorted(needs) == sorted(j for j in jobs if j != "report-failure"))
print("if", r["if"])
print("perms", sorted(f"{k}={v}" for k, v in r["permissions"].items()))
print("others", sorted(j for j, v in jobs.items() if j != "report-failure" and "permissions" in v))
print("script", any("release_failure_report.py" in (s.get("run") or "") for s in r["steps"]))
print("name", r["name"])
PYW
has "needs-all True" "$(cat "$TMP/rf-static")" "depends on every other job"
has "!cancelled()" "$(grep '^if' "$TMP/rf-static")" "not on a cancelled run"
has "contains(needs.*.result, 'failure')" "$(grep '^if' "$TMP/rf-static")" "on any failed job, whatever the trigger"
lacks "event_name" "$(grep '^if' "$TMP/rf-static")" "no trigger is excluded"
check "only this job gets issue write + run read" "$(grep '^perms' "$TMP/rf-static")" "perms ['actions=read', 'contents=read', 'issues=write']"
check "no other job gets its own permissions" "$(grep '^others' "$TMP/rf-static")" "others []"
has "script True" "$(cat "$TMP/rf-static")" "runs the report script"
check "the display name the script leaves out of its job table" "$(grep '^name' "$TMP/rf-static")" "name report failure"

echo "-- several runs on one repo: create once, then only comments whatever the labels became, then a new one after close"
rf_repo
rf_jobs "gate 3/4=failure:Negative controls, shard 3/4" "release gate=failure:Every shell shard passed exactly once"
run_report "gate=failure gate-summary=failure release=skipped"
check "run 1: green" "$RC" 0
check "run 1: one issue" "$(n_issues)" 1
check "run 1: it carries the dispatch label" "$(labels_of 1)" "pending/agent"
grep -qxF "POST repos/o/r/issues" "$RF/calls.log" && ok "run 1: the fake received the create" || bad "run 1: the fake received the create"
B="$(body_of 1)"
has "<!-- cavil-release-failure -->" "$B" "run 1: body has the marker"
has "$RUN_LINK" "$B" "run 1: body has the run link"
has "$RF_SHA" "$B" "run 1: body has the tested commit"
has "gate 3/4](" "$B" "run 1: names the failed job"
has "「Negative controls, shard 3/4」" "$B" "run 1: names the failed step"
lacks "report failure" "$B" "run 1: leaves its own job out"
check "run 1: GitHub had to make no label" "$(rf_q "$RF/repo_labels.json" 'len(d)')" 5
k=0
for L in '[{"name":"doing/agent"}]' '[{"name":"pending/human"}]' '[{"name":"pending/blocked"}]' '[{"name":"needs-maintainer"}]' '[]'; do
    k=$((k + 1))
    set_issue 1 "{\"labels\": $L}"
    before="$(labels_of 1)"
    run_report "gate-client=failure gate-summary=failure release=skipped"
    check "run $((k + 1)) ($before): green" "$RC" 0
    check "run $((k + 1)) ($before): still one issue" "$(n_issues)" 1
    check "run $((k + 1)) ($before): one more comment" "$(n_comments 1)" "$k"
    check "run $((k + 1)) ($before): no label write" "$(label_writes)" 0
    check "run $((k + 1)) ($before): labels unchanged" "$(labels_of 1)" "$before"
    check "run $((k + 1)) ($before): re-read right before writing" "$(gets_of 1)" 1
done
has "$RUN_LINK" "$(last_comment 1)" "comment has the run link"
has "gate client](" "$(last_comment 1)" "comment names the failed job"
set_issue 1 '{"state": "closed"}'
run_report "release=failure"
check "after close: a second issue" "$(n_issues)" 2
check "after close: it carries the dispatch label" "$(labels_of 2)" "pending/agent"
check "after close: nothing written to the closed one" "$(n_comments 1)" 5

echo "-- one run each: the body names what actually failed"
rf_repo; rf_jobs "gate 2/4=failure:Negative controls, shard 2/4" "release gate=failure:Every shell shard passed exactly once"
mkdir -p "$RF/sum"
printf '## ❌ 1 of 60 tests did not pass\n\n- ❌ run.test: fail\n\n| x |\n' > "$RF/sum/verify.md"
printf '## 负对照汇总\n\n| x |\n\n没通过的单位：\n- ❌ `run.test (fail)`\n' > "$RF/sum/tally.md"
RF_SUMMARY_DIR="$RF/sum" run_report "gate=failure gate-summary=failure release=skipped"
B="$(body_of 1)"
has "gate 2/4](" "$B" "shell only: names the shard"
has "- ❌ run.test: fail" "$B" "shell only: lists the unit the summary did not pass"
has '`run.test (fail)`' "$B" "shell only: and the tally's failed unit"
lacks "### 客户端负对照" "$B" "shell only: no client section"
has "$RF_SHA" "$B" "shell only: tested commit"

rf_repo; rf_jobs "gate client=failure:Negative controls (vitest / back end / UI)" "release gate=failure:Every gate job passed"
mkdir -p "$RF/cl"; printf '❌ 没变红：看板不可写时照样发修改\n' > "$RF/cl/not-red.txt"
RF_CLIENT_DIR="$RF/cl" run_report "gate-client=failure gate-summary=failure release=skipped"
B="$(body_of 1)"
has "gate client](" "$B" "client only: names the job"
has "- ❌ 没变红：看板不可写时照样发修改" "$B" "client only: lists the entry that did not go red"
lacks "### shell 测试单位" "$B" "client only: no shell section without a summary"
rf_repo; rf_jobs "gate client=failure:Negative controls (vitest / back end / UI)"
run_report "gate-client=failure gate-summary=failure release=skipped"
has "客户端没留下条目清单，见该任务日志（[任务日志](https://github.com/o/r/actions/runs/777/job/12)）" "$(body_of 1)" "client, no list: says so and links the job"

rf_repo; rf_jobs "release=failure:Create GitHub Release"
run_report "release=failure"
B="$(body_of 1)"
has "门禁已通过，发版在『Create GitHub Release』失败" "$B" "release only: gate passed, names the step"
has "$RUN_LINK" "$B" "release only: run link"

rf_repo; rf_jobs "plan=failure:Decide what this run does" "gate 1/4=skipped" "release=skipped"
RF_PLAN_SHA="" run_report "plan=failure gate=skipped gate-autopilot=skipped gate-client=skipped gate-summary=skipped release=skipped"
B="$(body_of 1)"
check "plan failed (no summary): still reported" "$(n_issues)" 1
has "「Decide what this run does」" "$B" "plan failed: names the step"
has "feedfacefeedfacefeedfacefeedfacefeedface" "$B" "plan failed: falls back to the run's commit, and says so"
has "计划任务没给出受测提交" "$B" "plan failed: … says so"

rf_repo; rf_jobs "release=failure:Cut tag (scheduled / manual)"
RF_EVENT=workflow_dispatch run_report "release=failure"
B="$(body_of 1)"
has "手动发版" "$B" "manual release failed: says how it was started"
has "『Cut tag (scheduled / manual)』" "$B" "manual release failed: names the step"
lacks "诊断运行" "$B" "manual release: not called diagnostic"

rf_repo; rf_jobs "gate autopilot 2/6=failure:autopilot negative controls, part 2/6" "release gate=failure:Every gate job passed" "release=skipped"
RF_EVENT=workflow_dispatch RF_GATE_ONLY=true run_report "gate-autopilot=failure gate-summary=failure release=skipped"
B="$(body_of 1)"
has "手动只跑门禁" "$B" "gate-only failed: says how it was started"
has "诊断运行" "$B" "gate-only failed: marked diagnostic"
has "gate autopilot 2/6](" "$B" "gate-only failed: names the job"
has "$RF_SHA" "$B" "gate-only failed: tested commit"

rf_repo; RF_EVENT=push RF_REF_NAME=release/v2026.11.08.1 run_report "gate=failure gate-summary=failure release=skipped"
has 'tag 推送（`release/v2026.11.08.1`）' "$(body_of 1)" "tag push failed: names the tag"

rf_repo; run_report ""
check "all passed: exit 0" "$RC" 0
check "all passed: no call at all" "$(wc -l < "$RF/calls.log")" 0
run_report "gate=cancelled gate-autopilot=cancelled gate-client=cancelled gate-summary=skipped release=skipped"
check "cancelled: exit 0" "$RC" 0
check "cancelled: no call at all" "$(wc -l < "$RF/calls.log")" 0

echo "-- reads that fail or come back incomplete"
rf_repo
python3 - "$RF/issues.json" <<'PYF'
import json, sys
json.dump([{"number": n, "title": "x", "state": "open", "user": {"login": "github-actions[bot]"}, "body": "other",
            "html_url": f"https://github.com/o/r/issues/{n}", "labels": []} for n in range(1, 131)], open(sys.argv[1], "w"))
PYF
touch "$RF/F_list_2"
run_report "gate=failure"
[ "$RC" != 0 ] && ok "list page 2 fails: red" || bad "list page 2 fails: red"
grep -q "^GET repos/o/r/issues?.*page=2" "$RF/calls.log" && ok "list page 2 fails: page 2 was asked for" || bad "list page 2 fails: page 2 was asked for"
check "list page 2 fails: no write" "$(writes)" 0
rm "$RF/F_list_2"
run_report "gate=failure"
check "130 issues over two pages, none ours: creates" "$(n_issues)" 131
check "… green" "$RC" 0

rf_repo; run_report "gate=failure"; set_issue 1 '{"labels": []}'
python3 - "$RF/issues.json" <<'PYF'
import json, sys
d = json.load(open(sys.argv[1])); d.append({"number": 2, "state": "open", "user": {"login": "github-actions[bot]"},
    "html_url": "https://github.com/o/r/issues/2", "labels": []}); json.dump(d, open(sys.argv[1], "w"))
PYF
run_report "gate=failure"
[ "$RC" != 0 ] && ok "an item without a body: red" || bad "an item without a body: red"
check "an item without a body: no write" "$(writes)" 0
has "缺字段：body" "$(cat "$TMP/rf-out")" "an item without a body: says which field"

rf_repo
echo '[{"number": 1, "title": "x", "state": "open", "user": {"login": "github-actions[bot]"}, "body": "<!-- cavil-release-failure -->", "html_url": "https://github.com/o/r/pull/1", "pull_request": {}, "labels": []}]' > "$RF/issues.json"
run_report "gate=failure"
check "a PR carrying the marker is not of the same kind: no comment on it" "$(n_comments 1)" 0
check "… a new issue instead" "$(n_issues)" 2

rf_repo; run_report "gate=failure"
echo '{"state": "closed"}' > "$RF/hook_get_1"
run_report "gate=failure"
check "closed between the list and the re-read: no comment on it" "$(n_comments 1)" 0
check "… found again, none left: a new issue" "$(n_issues)" 2
check "… green" "$RC" 0

rf_repo; run_report "gate=failure"
echo '{"body": "edited by someone"}' > "$RF/getpatch_1"
run_report "gate=failure"
[ "$RC" != 0 ] && ok "marker gone on the re-read, still gone after finding again: red" || bad "marker gone on the re-read, still gone after finding again: red"
check "… no write" "$(writes)" 0
check "… re-read twice (once more after finding again)" "$(gets_of 1)" 2
check "… nothing created" "$(n_issues)" 1

rf_repo; echo '["doing/agent"]' > "$RF/repo_labels.json"
run_report "gate=failure"
[ "$RC" != 0 ] && ok "dispatch label missing (404): red" || bad "dispatch label missing (404): red"
check "… created anyway" "$(n_issues)" 1
check "… without a label" "$(labels_of 1)" "-"
check "… and GitHub made no label of that name" "$(cat "$RF/repo_labels.json")" '["doing/agent"]'
has "需维护者手动打 pending/agent" "$(cat "$TMP/rf-out")" "… says what to do"

rf_repo; touch "$RF/F_label"
run_report "gate=failure"
[ "$RC" != 0 ] && ok "label read fails (not 404): red" || bad "label read fails (not 404): red"
check "… no write" "$(writes)" 0

rf_repo; touch "$RF/F_create_nolabel"
run_report "gate=failure"
[ "$RC" != 0 ] && ok "created, read back without the label: red" || bad "created, read back without the label: red"
has "issue #1 已建、派工标签没打上，需维护者手动打 pending/agent" "$(cat "$TMP/rf-out")" "… names the issue and what to do"
check "… not patched up afterwards" "$(label_writes)" 0
check "… one write (the create)" "$(writes)" 1

rf_repo; touch "$RF/F_readback"
run_report "gate=failure"
[ "$RC" != 0 ] && ok "created, read back fails: red" || bad "created, read back fails: red"
check "… no further write" "$(writes)" 1

rf_repo; touch "$RF/F_create"
run_report "gate=failure"
[ "$RC" != 0 ] && ok "create fails: red" || bad "create fails: red"
check "… not retried" "$(grep -cxF 'POST repos/o/r/issues' "$RF/calls.log")" 1

rf_repo; touch "$RF/F_jobs"
run_report "gate=failure gate-summary=failure release=skipped"
check "job list unreadable: still reported" "$(n_issues)" 1
has "步骤明细读不到" "$(body_of 1)" "… and says the step detail is missing"
has '`gate` | failure' "$(body_of 1)" "… falling back to the jobs' results"

echo "-- docs: the steps for a missing label and for turning it off, run as written"
for f in operations.md operations.zh.md; do
    sed -n '/<!-- release-failure-ops:begin -->/,/<!-- release-failure-ops:end -->/p' "$REPO_DIR/docs/$f" \
        | sed -n '/^```bash$/,/^```$/p' | grep -v '^```' > "$TMP/rf-ops-$f.sh"
done
check "both docs carry the same steps" "$(cmp -s "$TMP/rf-ops-operations.md.sh" "$TMP/rf-ops-operations.zh.md.sh" && echo same)" same
[ -s "$TMP/rf-ops-operations.md.sh" ] && ok "the steps were found" || bad "the steps were found"
mkdir -p "$TMP/opsbin"
cat > "$TMP/opsbin/gh" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$OPS_LOG"
case "$*" in
    *"--jq"*) echo '["pending/agent"]' ;;
esac
SH
chmod +x "$TMP/opsbin/gh"
export OPS_LOG="$TMP/ops.log"; : > "$OPS_LOG"
set +e; (PATH="$TMP/opsbin:$PATH" bash -e "$TMP/rf-ops-operations.md.sh") > "$TMP/ops.out" 2>&1; RC=$?; set -e
check "the steps run" "$RC" 0
has "api -X POST repos/GigleAI/cavil-loop/issues/123/labels -f labels[]=pending/agent" "$(cat "$OPS_LOG")" "adds the label to the named issue"
has "api repos/GigleAI/cavil-loop/issues/123 --jq" "$(cat "$OPS_LOG")" "reads it back"
has "variable set RELEASE_FAILURE_REPORT --body off --repo GigleAI/cavil-loop" "$(cat "$OPS_LOG")" "turns it off with the variable the job reads"
has "variable delete RELEASE_FAILURE_REPORT --repo GigleAI/cavil-loop" "$(cat "$OPS_LOG")" "turns it back on"
has "vars.RELEASE_FAILURE_REPORT != 'off'" "$(grep '^if' "$TMP/rf-static")" "the job reads that variable"


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
# negative controls run as child processes and never touch PASS / FAIL: regression-only in every mode
REPORT_REGRESS_ONLY=1 report_counts "$PASS" "$FAIL" "" "${MUT_FAIL:--}"
[ "${MUT_FAIL:-0}" -eq 0 ] || exit 1
[ "$FAIL" -eq 0 ]
