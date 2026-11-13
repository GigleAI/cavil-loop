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
    # The clone may be a workflow checkout left on an older commit (see fresh): catch up first.
    git -C "$WORK" pull -q --ff-only origin main 2>/dev/null || true
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
NC_WORKFLOW="${NC_WORKFLOW:-$REPO_DIR/.github/workflows/negative-controls.yml}"
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
    python3 - "${NEEDS_WF:-$WORKFLOW}" "$1" "$2" "${PLAN_SHA:-}" "${PLAN_WORK:-}" "${PLAN_TAG:-}" "${PLAN_ACTION:-}" <<'PY3'
import json, sys, yaml
wf, job, over, sha, work, tag, action = sys.argv[1:8]
needs = yaml.safe_load(open(wf))["jobs"][job].get("needs", [])
needs = [needs] if isinstance(needs, str) else needs
res = dict(kv.split("=", 1) for kv in over.split())
out = {}
for j in needs:
    out[j] = {"result": res.get(j, "success"), "outputs": {}}
    if j == "plan":
        out[j]["outputs"] = {"sha": sha, "work": work, "tag": tag, "action": action}
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
# A new checkout, like every Actions job gets. With a commit: the checkout a job of a run
# triggered on that commit gets — local main on that commit, origin/main wherever the remote
# is by now (actions/checkout checks out github.sha, not the branch tip; GitHub#329).
fresh() {
    CLONES=$((CLONES + 1)); WORK="$TMP/run$CLONES"
    git clone -q "$REMOTE" "$WORK" 2>/dev/null
    if [ -n "${1:-}" ]; then git -C "$WORK" reset -q --hard "$1"; fi
}
runstep() {  # runstep <script> → $RC, GITHUB_ENV content in $TMP/env, GITHUB_OUTPUT in $TMP/output
    : > "$TMP/env"; : > "$TMP/output"; rm -f "$TMP/gh-args"
    set +e
    (cd "$WORK" && GITHUB_ENV="$TMP/env" GITHUB_OUTPUT="$TMP/output" EVENT="${EVENT:-schedule}" GITHUB_REF="${GITHUB_REF:-}" \
        NEEDS="${NEEDS:-}" GATE_ONLY="${GATE_ONLY:-}" PLAN_TAG="${PLAN_TAG:-}" PLAN_ACTION="${PLAN_ACTION:-}" \
        CAVIL_RELEASE_NOW="${CAVIL_RELEASE_NOW:-}" RELEASE_SHA="${RELEASE_SHA:-}" PATH="$TMP/bin:$PATH" bash -e "$1") >"$TMP/out" 2>"$TMP/err"
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
# The plan step names the week that just ended (GitHub#309): pin the clock to Tuesday
# 2030-01-08 12:00 UTC, so that week ends Sunday 2030-01-06 and the tags above (dated today)
# are in another week. These runs are manual releases unless a case says otherwise.
export CAVIL_RELEASE_NOW=1894104000 EVENT=workflow_dispatch
W=2030.01.06
released() { grep -qxF "$1" "$GH_RELEASES"; }
title_arg() { awk 'prev == "--title" { print; exit } { prev = $0 }' "$TMP/gh-args"; }
# One whole run: plan → (gate, not run here) → cut → notes → create, stopping where
# Actions would. MOVE_MAIN=<msg> pushes a new commit to main between plan and cut,
# like a merge landing while the gate runs. MOVE_BEFORE_PLAN="<msg> …" pushes commits after
# the run was triggered and before its plan job starts, like merges landing while the run
# waits in the queue (GitHub#329). Every job of the run checks out the commit it was
# triggered on (TRIGGER_SHA), whatever main did since.
fullrun() {
    local m
    TRIGGER_SHA="$(git -C "$REMOTE" rev-parse main)"
    for m in ${MOVE_BEFORE_PLAN:-}; do commit "$m"; done
    fresh "$TRIGGER_SHA"; runstep "$TMP/plan.sh"; PLAN_RC=$RC; CUT_OUT="$(cat "$TMP/out")"
    PLAN_SHA="$(sed -n 's/^sha=//p' "$TMP/output")"; PLAN_WORK="$(sed -n 's/^work=//p' "$TMP/output")"
    PLAN_TAG="$(sed -n 's/^tag=//p' "$TMP/output")"; PLAN_ACTION="$(sed -n 's/^action=//p' "$TMP/output")"
    tag=""; export tag; NOTES=""; CREATE_RC=""; CUT_RC=$PLAN_RC
    SUMMARY_RC=""; GUARD_RC=""
    [ "$PLAN_RC" = 0 ] && [ "$PLAN_WORK" = true ] || return 0
    # The gate jobs themselves are not run here: GATE="<job>=<result> …" says how they ended.
    NEEDS="$(needs_json gate-summary "${GATE:-}")" runstep "$TMP/summary.sh"; SUMMARY_RC=$RC
    local summary=success; [ "$SUMMARY_RC" = 0 ] || summary=failure
    NEEDS="$(needs_json release "gate-summary=$summary")" runstep "$TMP/guard.sh"; GUARD_RC=$RC
    [ "$GUARD_RC" = 0 ] || return 0
    if [ -n "${MOVE_MAIN:-}" ]; then commit "$MOVE_MAIN"; fi
    # CUT_NOW: the clock when the release job runs, if it differs from the plan's (a run that
    # crosses midnight). The cut step must not care: it only uses what the plan decided.
    # AFTER_CHECKOUT: run once the release job has its checkout, before it cuts (a tag deleted
    # or moved on the remote meanwhile).
    fresh "$TRIGGER_SHA"; if [ -n "${AFTER_CHECKOUT:-}" ]; then eval "$AFTER_CHECKOUT"; fi
    CAVIL_RELEASE_NOW="${CUT_NOW:-${CAVIL_RELEASE_NOW:-}}" RELEASE_SHA="$PLAN_SHA" runstep "$TMP/cut.sh"; CUT_RC=$RC; CUT_OUT="$CUT_OUT
$(cat "$TMP/out")"
    tag="$(sed -n 's/^tag=//p' "$TMP/env")"; export tag
    [ "$CUT_RC" = 0 ] && [ -n "$tag" ] || return 0
    runstep "$TMP/notes.sh"; NOTES_RC=$RC; NOTES="$(cat "$WORK/release-notes.md" 2>/dev/null || true)"
    [ "$NOTES_RC" = 0 ] || return 0
    RELEASE_SHA="$PLAN_SHA" runstep "$TMP/create.sh"; CREATE_RC=$RC
}
has() { case "$2" in *"$1"*) ok "$3" ;; *) bad "$3 (missing [$1])" ;; esac; }
lacks() { case "$2" in *"$1"*) bad "$3 (unexpected [$1])" ;; *) ok "$3" ;; esac; }

echo "-- new commits → tag, notes, Release"
# .1–.5 are taken above (the second interactive run re-tagged HEAD as .5).
fullrun
check "cut step succeeds" "$CUT_RC" 0
check "exports the new tag" "$tag" "release/v$W.1"
check "tag pushed" "$(git -C "$REMOTE" tag -l "release/v$W.1")" "release/v$W.1"
# .4 and .5 sit on the same commit, so either may head the notes; what matters is the range.
has "- add release.sh (" "$NOTES" "notes list the new commit"
lacks "- four (" "$NOTES" "notes start after the previous release"
check "Release created" "$CREATE_RC" 0
released "release/v$W.1" && ok "Release page exists" || bad "Release page exists"
check "Release title carries the iteration" "$(title_arg)" "$(bash "$RELEASE_SH" --title "release/v$W.1")"

echo "-- nothing new and already released → nothing to do"
fullrun
check "plan step succeeds" "$PLAN_RC" 0
check "plan says no work (gate and release jobs skip)" "$PLAN_WORK" false
check "no tag exported (later steps skip)" "$tag" ""
has '本轮无新提交' "$CUT_OUT" "says so in the run log"
check "no duplicate Release" "$(grep -cxF "release/v$W.1" "$GH_RELEASES")" 1

echo "-- tag pushed, Release creation failed → the next run creates it"
commit seven
GH_FAIL_CREATE=1 fullrun
check "first run: tag exported" "$tag" "release/v$W.2"
[ "$CREATE_RC" != 0 ] && ok "first run: create fails" || bad "first run: create fails"
released "release/v$W.2" && bad "first run: no Release page" || ok "first run: no Release page"
fullrun
check "rerun: plan asks for the gate before the missing page" "$PLAN_WORK" true
check "rerun: cut step succeeds" "$CUT_RC" 0
check "rerun: exports the existing tag" "$tag" "release/v$W.2"
has '补建' "$CUT_OUT" "rerun: says it is creating the missing page"
check "rerun: no new tag" "$(git -C "$REMOTE" tag -l "release/v$W.3")" ""
has "Changes since \`release/v$W.1\`" "$NOTES" "rerun: notes start at the previous release"
has "- seven (" "$NOTES" "rerun: notes list the tagged commit"
check "rerun: Release created" "$CREATE_RC" 0
released "release/v$W.2" && ok "rerun: Release page exists" || bad "rerun: Release page exists"
fullrun
check "third run: nothing to do" "$tag" ""
check "third run: no duplicate Release" "$(grep -cxF "release/v$W.2" "$GH_RELEASES")" 1

echo "-- Release lookup fails → the run fails, never guesses"
commit seven-b
git -C "$REMOTE" tag "release/v$W.90" main   # tagged, page unknown
GH_FAIL_API=1 fullrun
[ "$PLAN_RC" != 0 ] && ok "plan step fails" || bad "plan step fails"
check "plan writes no decision" "$PLAN_WORK" ""
check "no tag exported" "$tag" ""
fresh; GH_FAIL_API=1 RELEASE_SHA="$(git -C "$WORK" rev-parse HEAD)" PLAN_TAG="release/v$W.90" PLAN_ACTION=page runstep "$TMP/cut.sh"
[ "$RC" != 0 ] && ok "cut step: lookup failure fails too" || bad "cut step: lookup failure fails too"
git -C "$REMOTE" tag -d "release/v$W.90" >/dev/null

echo "-- a tag that never got its page is skipped as the notes' starting point"
# The orphan is from an earlier week: the plan only goes back for missing pages of the
# week that just ended, so this one stays without a page and the notes must skip it.
commit eight
OLDW=2029.12.30
CAVIL_RELEASE_NOW=$((CAVIL_RELEASE_NOW - 7 * 86400)) GH_FAIL_CREATE=1 fullrun
check "orphan tag pushed, named after the earlier week" "$tag" "release/v$OLDW.1"
released "release/v$OLDW.1" && bad "orphan has no page" || ok "orphan has no page"
commit nine
fullrun
check "next run tags the next number of this week" "$tag" "release/v$W.3"
has "Changes since \`release/v$W.2\`" "$NOTES" "notes start at the last tag with a page"
has "- eight (" "$NOTES" "the orphan's commit is in these notes"
has "- nine (" "$NOTES" "the new commit is in these notes"
lacks "- seven (" "$NOTES" "already-released commits are not repeated"
check "Release created" "$CREATE_RC" 0
fresh; export tag="release/v$W.3"
GH_FAIL_API=1 runstep "$TMP/notes.sh"
[ "$RC" != 0 ] && ok "notes: lookup failure fails the step" || bad "notes: lookup failure fails the step"

echo "-- main moves while the gate runs → the tag goes on the tested commit"
commit ten
MOVE_MAIN=eleven fullrun
check "tag .10 exported" "$tag" "release/v$W.4"
check ".10 points at the planned commit" "$(git -C "$REMOTE" rev-parse "release/v$W.4^{commit}")" "$PLAN_SHA"
[ "$PLAN_SHA" != "$(git -C "$REMOTE" rev-parse main)" ] && ok "… which is not main's newer tip" || bad "… which is not main's newer tip"
has "- ten (" "$NOTES" "notes list the tested commit"
lacks "- eleven (" "$NOTES" "notes leave out the commit that landed during the gate"
check "Release created" "$CREATE_RC" 0
fullrun
check "next run plans the newer commit" "$PLAN_SHA" "$(git -C "$REMOTE" rev-parse main)"
check "… and tags it .11" "$tag" "release/v$W.5"

echo "-- the gate did not pass → no tag, no Release (GitHub#195; the gate is the regression suite since GitHub#416)"
commit twelve
TAGS_BEFORE="$(remote_tags_all)"; PAGES_BEFORE="$(wc -l < "$GH_RELEASES")"
for g in "gate=failure" "gate=skipped" "gate=cancelled"; do
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
check "… and the planned commit is released" "$tag" "release/v$W.6"
check "… on the planned commit" "$(git -C "$REMOTE" rev-parse "release/v$W.6^{commit}")" "$PLAN_SHA"
check "… with its page" "$CREATE_RC" 0

echo "-- main moves while the run waits in the queue → the plan takes main's tip (GitHub#329)"
commit q1
Q1="$(git -C "$REMOTE" rev-parse main)"
MOVE_BEFORE_PLAN="q2 q3" fullrun
check "the run's checkouts are on the commit it was triggered on" "$TRIGGER_SHA:$(git -C "$WORK" rev-parse HEAD)" "$Q1:$Q1"
check "plan succeeds" "$PLAN_RC:$PLAN_WORK:$PLAN_ACTION" "0:true:new"
check "plan: main's tip, two commits past the trigger" "$PLAN_SHA" "$(git -C "$REMOTE" rev-parse main)"
[ "$PLAN_SHA" != "$Q1" ] && ok "… which is not the triggering commit" || bad "… which is not the triggering commit"
check "tag exported" "$tag" "release/v$W.7"
check "tag on the planned commit" "$(git -C "$REMOTE" rev-parse "release/v$W.7^{commit}")" "$PLAN_SHA"
has "- q3 (" "$NOTES" "notes list the commits that landed in the queue"
check "Release created" "$CREATE_RC" 0
released "release/v$W.7" && ok "Release page exists" || bad "Release page exists"

echo "-- … and again while the gate runs → still the planned commit"
commit q4
Q4="$(git -C "$REMOTE" rev-parse main)"
MOVE_BEFORE_PLAN=q5 MOVE_MAIN=q6 fullrun
check "tag exported" "$tag" "release/v$W.8"
check "tag on the planned commit" "$(git -C "$REMOTE" rev-parse "release/v$W.8^{commit}")" "$PLAN_SHA"
check "planned commit = main when the plan ran (q5)" "$(git -C "$REMOTE" log -1 --format=%s "$PLAN_SHA")" q5
check "main has moved past it (q6)" "$(git -C "$REMOTE" log -1 --format=%s main)" q6
check "the release job's checkout was the triggering commit (q4)" "$(git -C "$WORK" rev-parse HEAD)" "$Q4"
has "- q5 (" "$NOTES" "notes list the tested commit"
lacks "- q6 (" "$NOTES" "notes leave out the commit that landed during the gate"
check "Release created" "$CREATE_RC" 0

echo "-- a checkout beside main (not behind it) → plan and cut refuse"
TAGS_BEFORE="$(remote_tags_all)"; PAGES_BEFORE="$(wc -l < "$GH_RELEASES")"
MAIN_NOW="$(git -C "$REMOTE" rev-parse main)"
fresh "$Q4"; echo beside >> "$WORK/file"; git -C "$WORK" commit -qam beside
runstep "$TMP/plan.sh"
check "plan step fails, writes no decision" "$RC:$(cat "$TMP/output")" "1:"
has "not on origin/main's history" "$(cat "$TMP/err")" "plan says why"
RELEASE_SHA="$MAIN_NOW" PLAN_TAG="release/v$W.9" PLAN_ACTION=new runstep "$TMP/cut.sh"
check "cut step fails, exports no tag" "$RC:$(cat "$TMP/env")" "1:"
has "not on origin/main's history" "$(cat "$TMP/err")" "cut says why"
check "no tag, no page" "$(remote_tags_all):$(wc -l < "$GH_RELEASES")" "$TAGS_BEFORE:$PAGES_BEFORE"

echo "-- cannot tell whether the checkout is on main → fail, never guess"
mkdir -p "$TMP/gitmb"
printf '#!/usr/bin/env bash\n[ "$1" = merge-base ] && { echo "fatal: injected" >&2; exit 128; }\nexec %q "$@"\n' "$(command -v git)" > "$TMP/gitmb/git"
chmod +x "$TMP/gitmb/git"
fresh "$Q4"
PATH="$TMP/gitmb:$PATH" run --plan --trigger manual --released "$GH_RELEASES"
check "plan fails, writes no plan" "$RC:$(cat "$TMP/out")" "1:"
has "cannot tell whether this checkout" "$(cat "$TMP/err")" "plan says the read failed"
PATH="$TMP/gitmb:$PATH" run --cut "release/v$W.9" --at "$MAIN_NOW"
check "cut fails, prints no tag" "$RC:$(cat "$TMP/out")" "1:"
check "no tag, no page" "$(remote_tags_all):$(wc -l < "$GH_RELEASES")" "$TAGS_BEFORE:$PAGES_BEFORE"
run --plan --trigger manual --released "$GH_RELEASES"
check "same checkout, reads work: plan main's tip (q6)" "$RC:$(sed -n 's/^action=//p;s/^sha=//p;s/^tag=//p' "$TMP/out" | tr '\n' ' ')" "0:new $MAIN_NOW release/v$W.9 "

echo "-- by hand, behind main → refused as before (only --plan / --cut may be behind)"
printf '%s\n' "❌ local main not in sync with origin/main" "   local:  $Q4" "   remote: $MAIN_NOW" > "$TMP/want-err"
for mode in --dry-run --auto --pending "--auto --at $Q4" ""; do
    # shellcheck disable=SC2086
    STDIN="$TMP/yes" run $mode
    check "[${mode:-interactive}] exit 1, nothing on stdout" "$RC:$(cat "$TMP/out")" "1:"
    check "[${mode:-interactive}] the same message" "$(cat "$TMP/err")" "$(cat "$TMP/want-err")"
done
check "no tag, no page" "$(remote_tags_all):$(wc -l < "$GH_RELEASES")" "$TAGS_BEFORE:$PAGES_BEFORE"
fullrun
check "a run on main's tip still releases it" "$tag:$(git -C "$REMOTE" rev-parse "release/v$W.9^{commit}"):$CREATE_RC" "release/v$W.9:$MAIN_NOW:0"

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
git -C "$REMOTE" tag release/v2026.10.25.1 main
fresh
printf '#!/usr/bin/env bash\necho "usage: $0 [--dry-run]" >&2; exit 2\n' > "$WORK/scripts/release.sh"
export tag=release/v2026.10.25.1
RELEASE_SHA="$(git -C "$REMOTE" rev-parse main)" runstep "$TMP/create.sh"
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

echo "== catching up a missed week (GitHub#309: --plan, --cut, the daily schedule)"
check "the schedule fires every day" "$(python3 -c 'import sys,yaml; print(yaml.safe_load(open(sys.argv[1]))[True]["schedule"][0]["cron"])' "$WORKFLOW")" "10 16 * * *"
REMOTE="$TMP/remote3.git"; WORK="$TMP/work3"
git init -q --bare "$REMOTE"; git clone -q "$REMOTE" "$WORK" 2>/dev/null
mkdir -p "$WORK/scripts"; cp "$RELEASE_SH" "$WORK/scripts/release.sh"
git -C "$WORK" add scripts; git -C "$WORK" commit -qm "a0 with release.sh"; git -C "$WORK" push -q origin main
A0="$(git -C "$WORK" rev-parse HEAD)"
git -C "$REMOTE" tag release/v2026.11.01.1 "$A0"
echo release/v2026.11.01.1 > "$GH_RELEASES"          # last week's release, with its page
at() { date -u -d "$1" +%s; }                          # UTC time → epoch seconds
tip() { git -C "$REMOTE" rev-parse main; }
tag_at() { git -C "$REMOTE" rev-parse -q --verify "refs/tags/$1^{commit}" 2>/dev/null || echo none; }
pages() { grep -cxF "$1" "$GH_RELEASES" || true; }

echo "-- the week that just ended, at the boundaries (Beijing time, Monday–Sunday)"
plan_week() { CAVIL_RELEASE_NOW="$1" run --plan --trigger manual --released "$GH_RELEASES"; sed -n 's/^week=//p' "$TMP/out"; }
check "Sunday 15:59 UTC (Sunday 23:59 Beijing) → the previous week" "$(plan_week "$(at '2026-11-08 15:59')")" 2026.11.01
check "Sunday 16:10 UTC (Monday 00:10 Beijing) → the week just ended" "$(plan_week "$(at '2026-11-08 16:10')")" 2026.11.08
check "Monday 01:00 UTC → the same week" "$(plan_week "$(at '2026-11-09 01:00')")" 2026.11.08
check "Sunday 23:59 Beijing a week later → still 11-08" "$(plan_week "$(at '2026-11-15 15:59')")" 2026.11.08
check "across the new year" "$(plan_week "$(at '2026-12-31 20:00')")" 2026.12.27
CAVIL_RELEASE_NOW=yesterday run --plan --trigger manual --released "$GH_RELEASES"
check "a clock that is not epoch seconds → exit 2" "$RC" 2
run --plan --trigger manual --released "$TMP/no-such-file"
check "an unreadable Release list → exit 1, no plan" "$RC:$(cat "$TMP/out")" "1:"
run --plan --trigger weekly --released "$GH_RELEASES"
check "an unknown trigger → usage, exit 2" "$RC" 2
run --cut v1.0 --at "$A0"
check "--cut a name that is not a release tag → exit 2" "$RC" 2
run --cut release/v2026.11.01.1 --at "$A0"
check "--cut a tag already on that commit → exit 3" "$RC:$(cat "$TMP/out")" "3:release/v2026.11.01.1"
run --cut release/v2026.11.08.1 --at "$A0" --page
check "--cut --page when the tag does not exist → exit 1" "$RC" 1
check "… and tags nothing" "$(tag_at release/v2026.11.08.1)" none

echo "-- row 3: main's tip is released → nothing, on either trigger"
EVENT=schedule CAVIL_RELEASE_NOW="$(at '2026-11-08 15:59')" fullrun
check "plan: no work" "$PLAN_WORK:$PLAN_ACTION" "false:none"
has '本轮无新提交' "$CUT_OUT" "says so in the run log"
EVENT=workflow_dispatch CAVIL_RELEASE_NOW="$(at '2026-11-08 15:59')" fullrun
check "manual: no work either" "$PLAN_WORK:$PLAN_ACTION" "false:none"

echo "-- row 4 (scheduled): the week is released, main has moved → nothing"
git -C "$WORK" pull -q; commit b-sunday
B="$(tip)"
EVENT=schedule CAVIL_RELEASE_NOW="$(at '2026-11-08 15:59')" fullrun
check "plan: no work, no gate" "$PLAN_WORK" false
has '已发布' "$CUT_OUT" "names the released week"

echo "-- the Sunday run's gate is red → no tag; Monday's run plans the same week again"
EVENT=schedule CAVIL_RELEASE_NOW="$(at '2026-11-08 16:10')" GATE="gate=failure" fullrun
check "Sunday: row 5, new tag for the week just ended" "$PLAN_ACTION:$PLAN_TAG" "new:release/v2026.11.08.1"
check "Sunday: the gate tests main's tip" "$PLAN_SHA" "$B"
[ "$GUARD_RC" != 0 ] && ok "Sunday: release job refuses" || bad "Sunday: release job refuses"
check "Sunday: no tag" "$(tag_at release/v2026.11.08.1)" none
EVENT=schedule CAVIL_RELEASE_NOW="$(at '2026-11-09 01:00')" GATE="gate=cancelled" fullrun
check "Monday 01:00: still the 11-08 week" "$PLAN_TAG" "release/v2026.11.08.1"
check "Monday: no tag" "$(tag_at release/v2026.11.08.1)" none

echo "-- the fix lands on Tuesday → that day's run releases the missed week"
commit c-fix
C="$(tip)"
EVENT=schedule CAVIL_RELEASE_NOW="$(at '2026-11-10 16:30')" fullrun
check "plan: new, on the fix" "$PLAN_ACTION:$PLAN_SHA" "new:$C"
check "tag named after the missed week" "$tag" "release/v2026.11.08.1"
check "… on the tested commit" "$(tag_at release/v2026.11.08.1)" "$C"
check "page created" "$CREATE_RC:$(pages release/v2026.11.08.1)" "0:1"
check "title is the missed iteration" "$(title_arg)" "release/v2026.11.08.1 · 迭代 2026-11-02 ~ 11-08"
has "Changes since \`release/v2026.11.01.1\`" "$NOTES" "notes start at last week's release"
has "- b-sunday (" "$NOTES" "notes list the commits of the missed week"
has "- c-fix (" "$NOTES" "… and the fix"
EVENT=schedule CAVIL_RELEASE_NOW="$(at '2026-11-11 16:30')" fullrun
check "Wednesday: nothing (row 3)" "$PLAN_WORK" false

echo "-- row 4: the week is released, main has a new commit"
commit d
D="$(tip)"; TAGS_BEFORE="$(remote_tags_all)"; PAGES_BEFORE="$(wc -l < "$GH_RELEASES")"
EVENT=schedule CAVIL_RELEASE_NOW="$(at '2026-11-11 16:30')" fullrun
check "scheduled: no work, no gate" "$PLAN_WORK" false
check "scheduled: no tag" "$(remote_tags_all)" "$TAGS_BEFORE"
EVENT=workflow_dispatch GATE_ONLY=true CAVIL_RELEASE_NOW="$(at '2026-11-11 16:30')" fullrun
check "gate-only: the gate runs" "$PLAN_WORK:$PLAN_ACTION" "true:verify"
check "gate-only: on main's tip" "$PLAN_SHA" "$D"
check "gate-only: release gate green" "$SUMMARY_RC" 0
[ "$GUARD_RC" != 0 ] && ok "gate-only: release job refuses" || bad "gate-only: release job refuses"
check "gate-only: no tag" "$(remote_tags_all)" "$TAGS_BEFORE"
check "gate-only: no page" "$(wc -l < "$GH_RELEASES")" "$PAGES_BEFORE"

echo "-- the whole life of a second release in the week whose page fails"
EVENT=workflow_dispatch CAVIL_RELEASE_NOW="$(at '2026-11-11 16:30')" GH_FAIL_CREATE=1 fullrun
check "1st manual run: next number of the week" "$PLAN_ACTION:$tag" "new:release/v2026.11.08.2"
check "1st: on D" "$(tag_at release/v2026.11.08.2)" "$D"
[ "$CREATE_RC" != 0 ] && ok "1st: page creation fails" || bad "1st: page creation fails"
check "1st: no page" "$(pages release/v2026.11.08.2)" 0
TAGS_BEFORE="$(remote_tags_all)"
EVENT=workflow_dispatch CAVIL_RELEASE_NOW="$(at '2026-11-11 16:30')" fullrun
check "2nd: row 1, the missing page first" "$PLAN_ACTION:$PLAN_TAG" "page:release/v2026.11.08.2"
check "2nd: the gate tests D" "$PLAN_SHA" "$D"
has '补建' "$CUT_OUT" "2nd: says it is creating the missing page"
check "2nd: no new tag" "$(remote_tags_all)" "$TAGS_BEFORE"
check "2nd: page created" "$CREATE_RC:$(pages release/v2026.11.08.2)" "0:1"
EVENT=workflow_dispatch CAVIL_RELEASE_NOW="$(at '2026-11-11 16:30')" fullrun
check "3rd: nothing to do" "$PLAN_WORK" false
check "3rd: no new tag" "$(remote_tags_all)" "$TAGS_BEFORE"
check "3rd: no duplicate page" "$(pages release/v2026.11.08.2)" 1

echo "-- the same, finished by the daily schedule instead"
commit e
E="$(tip)"
EVENT=workflow_dispatch CAVIL_RELEASE_NOW="$(at '2026-11-12 16:30')" GH_FAIL_CREATE=1 fullrun
check "manual run: .3 on E, page fails" "$tag:$(tag_at release/v2026.11.08.3):$(pages release/v2026.11.08.3)" "release/v2026.11.08.3:$E:0"
TAGS_BEFORE="$(remote_tags_all)"
EVENT=schedule CAVIL_RELEASE_NOW="$(at '2026-11-12 16:30')" fullrun
check "scheduled run: row 1, page for .3 on E" "$PLAN_ACTION:$PLAN_TAG:$PLAN_SHA" "page:release/v2026.11.08.3:$E"
check "… no new tag" "$(remote_tags_all)" "$TAGS_BEFORE"
check "… page created" "$(pages release/v2026.11.08.3)" 1

echo "-- row 2: the week's tag without a page is on an older commit than main's tip"
commit f
F="$(tip)"
EVENT=workflow_dispatch CAVIL_RELEASE_NOW="$(at '2026-11-13 16:30')" GH_FAIL_CREATE=1 fullrun
check "manual run: .4 on F, page fails" "$(tag_at release/v2026.11.08.4):$(pages release/v2026.11.08.4)" "$F:0"
commit g
TAGS_BEFORE="$(remote_tags_all)"
EVENT=schedule CAVIL_RELEASE_NOW="$(at '2026-11-13 16:30')" fullrun
check "plan: page for .4" "$PLAN_ACTION:$PLAN_TAG" "page:release/v2026.11.08.4"
check "the gate tests the tag's own commit F, not main's tip" "$PLAN_SHA" "$F"
check "… no new tag" "$(remote_tags_all)" "$TAGS_BEFORE"
check "… page created for .4" "$CREATE_RC:$(pages release/v2026.11.08.4)" "0:1"
check "… the tag still on F" "$(tag_at release/v2026.11.08.4)" "$F"
git -C "$REMOTE" tag release/v2026.11.08.5 "$F"
git -C "$REMOTE" tag -f release/v2026.11.08.5 "$(git -C "$REMOTE" rev-parse "$F^")" >/dev/null
fresh; CAVIL_RELEASE_NOW="$(at '2026-11-13 16:30')" RELEASE_SHA="$F" PLAN_TAG=release/v2026.11.08.5 PLAN_ACTION=page runstep "$TMP/cut.sh"
check "cut: a planned page whose tag moved to another commit → fails" "$RC:$(cat "$TMP/env")" "1:"
git -C "$REMOTE" tag -d release/v2026.11.08.5 >/dev/null

echo "-- a run that starts on Sunday night and tags on Monday keeps the week it planned"
commit h
EVENT=schedule CAVIL_RELEASE_NOW="$(at '2026-11-22 15:59')" CUT_NOW="$(at '2026-11-22 18:00')" fullrun
check "plan at Sunday 23:59 Beijing: the 11-15 week" "$PLAN_TAG" "release/v2026.11.15.1"
check "tag cut at Monday 02:00 Beijing is still 11-15" "$tag" "release/v2026.11.15.1"
check "no tag for the 11-22 week" "$(tag_at release/v2026.11.22.1)" none
check "title is the planned iteration" "$(title_arg)" "release/v2026.11.15.1 · 迭代 2026-11-09 ~ 11-15"

echo "-- the Release list cannot be read → the scheduled run fails, nothing written"
commit i
TAGS_BEFORE="$(remote_tags_all)"
EVENT=schedule CAVIL_RELEASE_NOW="$(at '2026-11-23 16:30')" GH_FAIL_API=1 fullrun
[ "$PLAN_RC" != 0 ] && ok "plan step fails" || bad "plan step fails"
check "no decision, no tag" "$PLAN_WORK:$(remote_tags_all)" ":$TAGS_BEFORE"

echo "-- every read the decision needs is checked (code review round 1)"
# A git that fails only the remote tag listing; everything else is the real git.
mkdir -p "$TMP/gitfail"; REAL_GIT="$(command -v git)"
printf '#!/usr/bin/env bash\n[ "$1" = ls-remote ] && { echo "fatal: injected" >&2; exit 128; }\nexec %q "$@"\n' "$REAL_GIT" > "$TMP/gitfail/git"
chmod +x "$TMP/gitfail/git"
git -C "$WORK" pull -q; commit j
J="$(tip)"
git -C "$REMOTE" tag release/v2026.11.22.1 "$J"         # a tag of the 11-22 week, no page
commit k
git -C "$WORK" fetch -q --tags
CAVIL_RELEASE_NOW="$(at '2026-11-24 16:30')" run --plan --trigger schedule --released "$GH_RELEASES"
check "listing works: plan the missing page on its own commit" "$RC:$(sed -n 's/^action=//p;s/^sha=//p;s/^tag=//p' "$TMP/out" | tr '\n' ' ')" "0:page $J release/v2026.11.22.1 "
PATH="$TMP/gitfail:$PATH" CAVIL_RELEASE_NOW="$(at '2026-11-24 16:30')" run --plan --trigger schedule --released "$GH_RELEASES"
check "listing fails: plan fails, writes no plan" "$RC:$(cat "$TMP/out")" "1:"
PATH="$TMP/gitfail:$PATH" run --cut release/v2026.11.22.1 --at "$J" --page
check "listing fails: --cut fails too" "$RC:$(cat "$TMP/out")" "1:"
EVENT=schedule CAVIL_RELEASE_NOW="$(at '2026-11-24 16:30')" fullrun
check "workflow: page for the 11-22 tag on J" "$PLAN_ACTION:$PLAN_SHA:$CREATE_RC" "page:$J:0"
grep -qxF -- --verify-tag "$TMP/gh-args" && ok "gh release create is told never to make the tag" || bad "gh release create is told never to make the tag"

echo "-- the planned tag is deleted on the remote after the release job checked out"
commit l
L="$(tip)"
EVENT=workflow_dispatch CAVIL_RELEASE_NOW="$(at '2026-11-24 16:30')" GH_FAIL_CREATE=1 fullrun
check "a second tag of the week without its page" "$tag:$(tag_at release/v2026.11.22.2)" "release/v2026.11.22.2:$L"
commit m
PAGES_BEFORE="$(wc -l < "$GH_RELEASES")"
EVENT=schedule CAVIL_RELEASE_NOW="$(at '2026-11-24 16:30')" AFTER_CHECKOUT='git -C "$REMOTE" tag -d release/v2026.11.22.2 >/dev/null' fullrun
check "plan: page for it, on L" "$PLAN_ACTION:$PLAN_TAG:$PLAN_SHA" "page:release/v2026.11.22.2:$L"
check "the release job's checkout still has it locally" "$(git -C "$WORK" rev-parse -q --verify 'refs/tags/release/v2026.11.22.2^{commit}')" "$L"
[ "$CUT_RC" != 0 ] && ok "cut step fails" || bad "cut step fails"
check "no tag exported, no page" "$tag:$(wc -l < "$GH_RELEASES")" ":$PAGES_BEFORE"
check "no tag recreated on the remote" "$(tag_at release/v2026.11.22.2)" none

echo "-- the tag moves on the remote between the cut step and the page"
commit n
N="$(tip)"; git -C "$REMOTE" tag release/v2026.11.22.3 "$N"
fresh; export tag=release/v2026.11.22.3
git -C "$REMOTE" tag -f release/v2026.11.22.3 "$L" >/dev/null
PAGES_BEFORE="$(wc -l < "$GH_RELEASES")"
RELEASE_SHA="$N" runstep "$TMP/create.sh"
check "create step: tag no longer on the tested commit → fails, no page" "$([ "$RC" != 0 ] && echo red):$(wc -l < "$GH_RELEASES")" "red:$PAGES_BEFORE"
git -C "$REMOTE" tag -d release/v2026.11.22.3 >/dev/null
RELEASE_SHA="$N" runstep "$TMP/create.sh"
check "create step: tag gone → fails, no page" "$([ "$RC" != 0 ] && echo red):$(wc -l < "$GH_RELEASES")" "red:$PAGES_BEFORE"

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
    rm -f "$RF/comments.json" "$RF/jobs.json"   # a name reused inside $( ) starts empty too
}
# The run's job list: every job of release.yml by its display name, success unless overridden.
# rf_jobs "<display name>=<conclusion>[:<failed step>]" …
rf_jobs() {
    python3 - "$@" > "$RF/jobs.json" <<'PYJ'
import json, sys
import os
if os.environ.get("RF_KIND") == "negative-controls":
    names = ["plan"] + [f"negative controls {k}/4" for k in range(1, 5)] \
        + [f"negative controls autopilot {k}/6" for k in range(1, 7)] \
        + ["negative controls client", "negative controls summary"]
else:
    names = ["plan"] + [f"gate {k}/4" for k in range(1, 5)] + ["release gate", "release"]
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
    local needs wf="$WORKFLOW"
    [ "${RF_KIND:-}" = negative-controls ] && wf="$NC_WORKFLOW"
    needs="$(NEEDS_WF="$wf" PLAN_SHA="${RF_PLAN_SHA-$RF_SHA}" PLAN_WORK=true needs_json report-failure "$1")"
    set +e
    env -u GITHUB_STEP_SUMMARY PATH="$TMP/rfbin:$PATH" FAKE_GH_DIR="$RF" GITHUB_REPOSITORY=o/r GITHUB_RUN_ID=777 \
        GITHUB_RUN_ATTEMPT=1 GITHUB_SERVER_URL=https://github.com GITHUB_SHA=feedfacefeedfacefeedfacefeedfacefeedface \
        GITHUB_REF_NAME="${RF_REF_NAME:-main}" EVENT="${RF_EVENT:-schedule}" GATE_ONLY="${RF_GATE_ONLY:-}" \
        NEEDS="$needs" SUMMARY_DIR="${RF_SUMMARY_DIR:-}" CLIENT_DIR="${RF_CLIENT_DIR:-}" REPORT_KIND="${RF_KIND:-}" \
        python3 "${RF_PY:-$REPORT_PY}" > "$TMP/rf-out" 2>&1
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
rf_jobs "gate 3/4=failure:Tests, shard 3/4" "release gate=failure:Every shell shard passed exactly once"
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
has "「Tests, shard 3/4」" "$B" "run 1: names the failed step"
lacks "report failure" "$B" "run 1: leaves its own job out"
check "run 1: GitHub had to make no label" "$(rf_q "$RF/repo_labels.json" 'len(d)')" 5
k=0
for L in '[{"name":"doing/agent"}]' '[{"name":"pending/human"}]' '[{"name":"pending/blocked"}]' '[{"name":"needs-maintainer"}]' '[]'; do
    k=$((k + 1))
    set_issue 1 "{\"labels\": $L}"
    before="$(labels_of 1)"
    run_report "gate=failure gate-summary=failure release=skipped"
    check "run $((k + 1)) ($before): green" "$RC" 0
    check "run $((k + 1)) ($before): still one issue" "$(n_issues)" 1
    check "run $((k + 1)) ($before): one more comment" "$(n_comments 1)" "$k"
    check "run $((k + 1)) ($before): no label write" "$(label_writes)" 0
    check "run $((k + 1)) ($before): labels unchanged" "$(labels_of 1)" "$before"
    check "run $((k + 1)) ($before): re-read right before writing" "$(gets_of 1)" 1
done
has "$RUN_LINK" "$(last_comment 1)" "comment has the run link"
has "gate 3/4](" "$(last_comment 1)" "comment names the failed job"
set_issue 1 '{"state": "closed"}'
run_report "release=failure"
check "after close: a second issue" "$(n_issues)" 2
check "after close: it carries the dispatch label" "$(labels_of 2)" "pending/agent"
check "after close: nothing written to the closed one" "$(n_comments 1)" 5

echo "-- one run each: the body names what actually failed"
rf_repo; rf_jobs "gate 2/4=failure:Tests, shard 2/4" "release gate=failure:Every shell shard passed exactly once"
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

rf_repo; rf_jobs "release=failure:Create GitHub Release"
run_report "release=failure"
B="$(body_of 1)"
has "门禁已通过，发版在『Create GitHub Release』失败" "$B" "release only: gate passed, names the step"
has "$RUN_LINK" "$B" "release only: run link"

rf_repo; rf_jobs "plan=failure:Decide what this run does" "gate 1/4=skipped" "release=skipped"
RF_PLAN_SHA="" run_report "plan=failure gate=skipped gate-summary=skipped release=skipped"
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

rf_repo; rf_jobs "gate 2/4=failure:Tests, shard 2/4" "release gate=failure:Every gate job passed" "release=skipped"
RF_EVENT=workflow_dispatch RF_GATE_ONLY=true run_report "gate=failure gate-summary=failure release=skipped"
B="$(body_of 1)"
has "手动只跑门禁" "$B" "gate-only failed: says how it was started"
has "诊断运行" "$B" "gate-only failed: marked diagnostic"
has "gate 2/4](" "$B" "gate-only failed: names the job"
has "$RF_SHA" "$B" "gate-only failed: tested commit"

rf_repo; RF_EVENT=push RF_REF_NAME=release/v2026.11.08.1 run_report "gate=failure gate-summary=failure release=skipped"
has 'tag 推送（`release/v2026.11.08.1`）' "$(body_of 1)" "tag push failed: names the tag"

rf_repo; run_report ""
check "all passed: exit 0" "$RC" 0
check "all passed: no call at all" "$(wc -l < "$RF/calls.log")" 0
run_report "gate=cancelled gate-summary=skipped release=skipped"
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

echo "-- docs: turning the nightly report off, checking, turning it on, checking — as written (GitHub#416)"
# Each doc's block: the two bash lines (off, on) and the check command named in the text after them.
for f in operations.md operations.zh.md; do
    sed -n '/<!-- negative-controls-ops:begin -->/,/<!-- negative-controls-ops:end -->/p' "$REPO_DIR/docs/$f" > "$TMP/nc-ops-$f.md"
    sed -n '/^```bash$/,/^```$/p' "$TMP/nc-ops-$f.md" | grep -v '^```' > "$TMP/nc-ops-$f.sh"
    grep -o '`gh variable list[^`]*`' "$TMP/nc-ops-$f.md" | tr -d '`' > "$TMP/nc-ops-$f.check"
done
check "both docs carry the same steps" "$(cmp -s "$TMP/nc-ops-operations.md.sh" "$TMP/nc-ops-operations.zh.md.sh" && echo same)" same
check "both docs name the same check" "$(cmp -s "$TMP/nc-ops-operations.md.check" "$TMP/nc-ops-operations.zh.md.check" && echo same)" same
check "two steps: off, then on" "$(wc -l < "$TMP/nc-ops-operations.md.sh")" 2
check "one check command" "$(wc -l < "$TMP/nc-ops-operations.md.check")" 1
# A gh stand-in that keeps the repository's variables, the way `gh variable` shows them (NAME<tab>VALUE<tab>UPDATED).
mkdir -p "$TMP/varbin"
cat > "$TMP/varbin/gh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[ "$1" = variable ] || { echo "unexpected: $*" >&2; exit 9; }
repo=""; name=""; body=""; op="$2"; shift 2
while [ $# -gt 0 ]; do case "$1" in
    --repo) repo="$2"; shift 2 ;;
    --body) body="$2"; shift 2 ;;
    *) [ -z "$name" ] && name="$1" || { echo "unexpected: $1" >&2; exit 9; }; shift ;;
esac; done
[ "$repo" = GigleAI/cavil-loop ] || { echo "wrong repo: $repo" >&2; exit 9; }
f="$VAR_STATE"; touch "$f"
case "$op" in
    set) [ -n "$name" ] && [ -n "$body" ] || exit 9
         grep -v "^$name	" "$f" > "$f.t" || true; printf '%s\t%s\t2026-11-12T00:00:00Z\n' "$name" "$body" >> "$f.t"; mv "$f.t" "$f" ;;
    delete) grep -q "^$name	" "$f" || { echo "HTTP 404: variable not found" >&2; exit 1; }
            grep -v "^$name	" "$f" > "$f.t" || true; mv "$f.t" "$f" ;;
    list) [ -z "$name" ] || exit 9; sort "$f" ;;
    *) exit 9 ;;
esac
SH
chmod +x "$TMP/varbin/gh"
export VAR_STATE="$TMP/vars.tsv"
printf 'RELEASE_FAILURE_REPORT\toff\t2026-11-01T00:00:00Z\n' > "$VAR_STATE"   # the other switch, set before
vrun() { set +e; (PATH="$TMP/varbin:$PATH" bash -e -c "$1") > "$TMP/var.out" 2>&1; RC=$?; set -e; }
has_var() { awk -F'\t' -v n="$1" -v v="$2" '$1 == n && $2 == v { f = 1 } END { exit !f }' "$TMP/var.out" && echo yes || echo no; }
vrun "$(sed -n 1p "$TMP/nc-ops-operations.md.sh")"
check "off: the first line runs" "$RC" 0
vrun "$(cat "$TMP/nc-ops-operations.md.check")"
check "check while off: runs" "$RC" 0
check "check while off: shows NEGATIVE_CONTROLS_REPORT off" "$(has_var NEGATIVE_CONTROLS_REPORT off)" yes
check "… the release report's switch untouched" "$(has_var RELEASE_FAILURE_REPORT off)" yes
vrun "$(sed -n 2p "$TMP/nc-ops-operations.md.sh")"
check "on: the second line runs" "$RC" 0
vrun "$(cat "$TMP/nc-ops-operations.md.check")"
check "check after on: runs" "$RC" 0
check "check after on: NEGATIVE_CONTROLS_REPORT is gone" "$(grep -c '^NEGATIVE_CONTROLS_REPORT	' "$TMP/var.out" || true)" 0
check "… the release report's switch still there" "$(has_var RELEASE_FAILURE_REPORT off)" yes
check "the variable the steps set is the one the report job reads" \
    "$(grep -c "vars.NEGATIVE_CONTROLS_REPORT != 'off'" "$NC_WORKFLOW")" 1


echo "== the release kind's issues and comments are unchanged (GitHub#416: one script, two kinds)"
# shellcheck source=lib/compat.sh
source "$REPO_DIR/tests/lib/compat.sh"
RF_BASE="$(git -C "$REPO_DIR" merge-base HEAD origin/main 2>/dev/null || git -C "$REPO_DIR" rev-parse HEAD)"
mkdir -p "$TMP/rf-old"; git -C "$REPO_DIR" archive "$RF_BASE" scripts | tar -x -C "$TMP/rf-old"
rf_scene() {  # <scene> → the fake repo's issues, comments and the calls of one scene, for one script
    rf_repo
    case "$1" in
        new) rf_jobs "gate 1/4=failure:Tests, shard 1/4"; run_report "gate=failure gate-summary=failure release=skipped" ;;
        again) rf_jobs "release=failure:Create GitHub Release"; run_report "release=failure"; run_report "release=failure" ;;
        nolabel) echo '["doing/agent"]' > "$RF/repo_labels.json"; RF_EVENT=workflow_dispatch RF_GATE_ONLY=true run_report "gate=failure" ;;
    esac
    echo "rc=$RC"; cat "$RF/issues.json"; echo; cat "$RF/comments.json" 2>/dev/null || echo "(no comments)"; echo; cat "$RF/calls.log"; cat "$TMP/rf-out"
}
if ! compat_skip "发版失败报告：issue、评论、调用与改动前" "$TMP/rf-old" "$REPO_DIR" scripts; then
    for sc in new again nolabel; do
        old="$(RF_PY="$TMP/rf-old/scripts/release_failure_report.py" rf_scene "$sc")"
        new="$(rf_scene "$sc")"
        new_k="$(RF_KIND=release rf_scene "$sc")"
        check "release kind, scene $sc: same as before the change" "$([ -n "$old" ] && [ "$old" = "$new" ] && echo same)" same
        check "release kind named explicitly, scene $sc: same as before" "$([ "$old" = "$new_k" ] && echo same)" same
    done
fi
rf_repo; RF_KIND=bogus run_report "gate=failure"
[ "$RC" != 0 ] && ok "unknown kind: red" || bad "unknown kind: red"
check "unknown kind: no write" "$(writes)" 0

echo "== the nightly negative controls (GitHub#416: .github/workflows/negative-controls.yml)"
nc_step() {  # <job> <step name> → that step's run: script, matrix values filled in
    python3 - "$NC_WORKFLOW" "$1" "$2" <<'PYN'
import sys, yaml
steps = yaml.safe_load(open(sys.argv[1]))["jobs"][sys.argv[2]]["steps"]
s = next(s["run"] for s in steps if s.get("name") == sys.argv[3])
print(s.replace("${{ matrix.shard }}", "1").replace("${{ matrix.part }}", "1"))
PYN
}
wf_env() {  # <workflow> <job> → that job's env as shell assignments (matrix values filled in)
    # Any other ${{ … }} expression is read as it evaluates on a push to main or a manual run: empty, and an
    # empty value is left out (tests.yml's CHANGED_FROM is set only on a pull request, GitHub#495).
    python3 - "$1" "$2" <<'PYE'
import re, shlex, sys, yaml
env = yaml.safe_load(open(sys.argv[1]))["jobs"][sys.argv[2]].get("env") or {}
for k, v in env.items():
    v = str(v).replace("${{ matrix.shard }}", "1").replace("${{ matrix.part }}", "1")
    v = re.sub(r"\$\{\{.*?\}\}", "", v)
    if v:
        print(f"{k}={shlex.quote(v)}")
PYE
}

echo "-- the plan step: main only; a scheduled run skips only a commit already green"
nc_step plan "Decide whether to run" > "$TMP/nc-plan.sh"
mkdir -p "$TMP/ncbin"
cat > "$TMP/ncbin/gh" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$NC_GH_LOG"
[ -z "${NC_GH_FAIL:-}" ] || { echo "HTTP 502: injected" >&2; exit 1; }
case "$*" in
    "api repos/o/r/actions/workflows/negative-controls.yml/runs?branch=main&status=success&per_page=1 --jq "*) printf '%s\n' "$NC_LAST" ;;
    *) echo "unexpected: $*" >&2; exit 9 ;;
esac
SH
chmod +x "$TMP/ncbin/gh"
NC_TIP="$(git -C "$REMOTE" rev-parse main)"
nc_plan() {  # EVENT / REF / NC_LAST / NC_GH_FAIL → $RC, $NC_RUN, $NC_SHA, gh calls in $TMP/nc-gh.log
    fresh "$NC_TIP"; : > "$TMP/nc-gh.log"; : > "$TMP/output"
    set +e
    (cd "$WORK" && GITHUB_OUTPUT="$TMP/output" GITHUB_REPOSITORY=o/r EVENT="$1" REF="${2:-refs/heads/main}" \
        NC_GH_LOG="$TMP/nc-gh.log" NC_LAST="${NC_LAST:-}" NC_GH_FAIL="${NC_GH_FAIL:-}" PATH="$TMP/ncbin:$PATH" \
        bash -e "$TMP/nc-plan.sh") > "$TMP/out" 2>&1
    RC=$?
    set -e
    NC_RUN="$(sed -n 's/^run=//p' "$TMP/output")"; NC_SHA="$(sed -n 's/^sha=//p' "$TMP/output")"
}
NC_LAST="$NC_TIP" nc_plan schedule
check "scheduled, last success on this commit: step succeeds" "$RC" 0
check "… does not run" "$NC_RUN" false
check "… the lookup really happened" "$(wc -l < "$TMP/nc-gh.log")" 1
NC_LAST=0000000000000000000000000000000000000000 nc_plan schedule
check "scheduled, main moved since: runs" "$NC_RUN" true
check "… on main's tip" "$NC_SHA" "$NC_TIP"
NC_GH_FAIL=1 nc_plan schedule
check "scheduled, lookup fails: step still succeeds" "$RC" 0
check "… and runs" "$NC_RUN" true
NC_LAST="" nc_plan schedule
check "scheduled, never succeeded before: runs" "$NC_RUN" true
NC_LAST="null" nc_plan schedule
check "scheduled, lookup reads no commit id: runs" "$NC_RUN" true
NC_LAST="$NC_TIP" nc_plan workflow_dispatch
check "manual on main: runs even when already green" "$NC_RUN" true
check "… without asking GitHub" "$(wc -l < "$TMP/nc-gh.log")" 0
NC_LAST=0000000000000000000000000000000000000000 nc_plan workflow_dispatch refs/heads/feature/issue-1
check "manual on another branch: does not run" "$NC_RUN" false
NC_LAST=0000000000000000000000000000000000000000 nc_plan schedule refs/heads/other
check "scheduled on another ref: does not run" "$NC_RUN" false

echo "-- the jobs really start the negative controls (their own steps, with stand-ins for the test runners)"
# A sandbox checkout whose test entry points only record how they were called and with which MUTATION.
NCS="$TMP/nc-sandbox"; mkdir -p "$NCS/tests" "$NCS/client/test/tauri" "$NCS/stub"
cat > "$NCS/tests/run.sh" <<'SH'
echo "run.sh $* MUTATION=${MUTATION:-} SHARD=${AUTOPILOT_MUT_SHARD:-} ONLY=${AUTOPILOT_MUT_ONLY:-}" >> "$NC_REC"
SH
cat > "$NCS/client/test/tauri/mutations.sh" <<'SH'
echo "tauri-mutations $* MUTATION=${MUTATION:-}" >> "$NC_REC"
SH
printf '#!/usr/bin/env bash\necho "npm $* MUTATION=${MUTATION:-}" >> "$NC_REC"\n' > "$NCS/stub/npm"
printf '#!/usr/bin/env bash\n[ "$1" = -a ] && shift\nexec "$@"\n' > "$NCS/stub/xvfb-run"
chmod +x "$NCS/stub/npm" "$NCS/stub/xvfb-run"
nc_exec() {  # <workflow> <job> <step name> <dir inside the sandbox> → appends to $NC_REC
    local wf="$1" job="$2" name="$3" dir="$4" envs
    python3 - "$wf" "$job" "$name" > "$TMP/nc-step.sh" <<'PYX'
import sys, yaml
fill = lambda x: x.replace("${{ matrix.shard }}", "1").replace("${{ matrix.part }}", "1")
steps = yaml.safe_load(open(sys.argv[1]))["jobs"][sys.argv[2]]["steps"]
print(fill(next(s["run"] for s in steps if fill(s.get("name") or "") == sys.argv[3])))
PYX
    envs="$(wf_env "$wf" "$job")"
    (cd "$NCS/$dir" && env -u MUTATION -u AUTOPILOT_MUT_SHARD -u AUTOPILOT_MUT_ONLY -u CHANGED_FROM $envs RUNNER_TEMP="$TMP/nc-rt" \
        NC_REC="$NC_REC" PATH="$NCS/stub:$PATH" bash -e "$TMP/nc-step.sh") >/dev/null 2>&1
}
export NC_REC="$TMP/nc-rec"; : > "$NC_REC"; mkdir -p "$TMP/nc-rt"
nc_exec "$NC_WORKFLOW" shell "Negative controls, shard 1/4" .
nc_exec "$NC_WORKFLOW" autopilot "autopilot negative controls, part 1/6" .
nc_exec "$NC_WORKFLOW" client "Negative controls (vitest / back end / UI)" client
nc_exec "$NC_WORKFLOW" client "Negative controls for the app shell (each rebuilds the real app)" client
REC="$(cat "$NC_REC")"
has "run.sh --ci --shard 1/4 --out $TMP/nc-rt/results MUTATION=1" "$REC" "shell job: runs its shard with negative controls on"
has "ONLY=none-see-autopilot-job" "$REC" "shell job: leaves autopilot's broken copies to their own job"
has "run.sh autopilot --out $TMP/nc-rt/results MUTATION=1 SHARD=1/6" "$REC" "autopilot job: runs its part of autopilot's negative controls"
has "npm run test:mutation MUTATION=1" "$REC" "client job: runs the client's negative controls"
has "tauri-mutations  MUTATION=1" "$REC" "client job: runs the real app's negative controls"
python3 - "$NC_WORKFLOW" > "$TMP/nc-static" <<'PYW'
import sys, yaml
wf = yaml.safe_load(open(sys.argv[1]))
on = wf.get("on", wf.get(True))
jobs = wf["jobs"]
r = jobs["report-failure"]
needs = r["needs"] if isinstance(r["needs"], list) else [r["needs"]]
print("needs-all", sorted(needs) == sorted(j for j in jobs if j != "report-failure"))
print("if", r["if"])
print("perms", sorted(f"{k}={v}" for k, v in r["permissions"].items()))
print("kind", next(s["env"].get("REPORT_KIND") for s in r["steps"] if "release_failure_report.py" in (s.get("run") or "")))
print("triggers", sorted(on))
print("cron", on["schedule"][0]["cron"])
print("run-gated", sorted(j for j in ("shell", "autopilot", "client") if "needs.plan.outputs.run == 'true'" in jobs[j]["if"]))
s = jobs["summary"]
print("summary-needs", sorted(s["needs"]))
PYW
NCST="$(cat "$TMP/nc-static")"
has "triggers ['schedule', 'workflow_dispatch']" "$NCST" "runs on a schedule and by hand, never on a PR or push"
has "cron 10 18 * * *" "$NCST" "nightly at 02:10 Beijing time"
has "run-gated ['autopilot', 'client', 'shell']" "$NCST" "every negative-control job waits for the plan's go"
has "needs-all True" "$NCST" "the report depends on every other job"
has "!cancelled()" "$(grep '^if' "$TMP/nc-static")" "report: not on a cancelled run"
has "contains(needs.*.result, 'failure')" "$(grep '^if' "$TMP/nc-static")" "report: on any failed job"
has "vars.NEGATIVE_CONTROLS_REPORT != 'off'" "$(grep '^if' "$TMP/nc-static")" "report: its own off switch"
has "perms ['actions=read', 'contents=read', 'issues=write']" "$NCST" "report: issue write + run read"
has "kind negative-controls" "$NCST" "report: its own kind"
has "summary-needs ['autopilot', 'client', 'plan', 'shell']" "$NCST" "summary waits for every job"

echo "-- the summary: green only when every job passed"
nc_step summary "Every job passed" > "$TMP/nc-sum.sh"
for g in "shell=failure" "autopilot=failure" "client=failure" "client=skipped" "autopilot=cancelled"; do
    NEEDS="$(NEEDS_WF="$NC_WORKFLOW" needs_json summary "$g")" runstep "$TMP/nc-sum.sh"
    [ "$RC" != 0 ] && ok "$g: summary is red" || bad "$g: summary is red"
done
NEEDS="$(NEEDS_WF="$NC_WORKFLOW" needs_json summary "")" runstep "$TMP/nc-sum.sh"
check "all passed: summary is green" "$RC" 0
NEEDS='{"plan": {"result": "success"}}' runstep "$TMP/nc-sum.sh"
[ "$RC" != 0 ] && ok "a job missing from needs: summary is red" || bad "a job missing from needs: summary is red"

echo "-- no negative controls anywhere else: Tests and Client, manual runs included"
for wf in tests client; do
    python3 - "$REPO_DIR/.github/workflows/$wf.yml" > "$TMP/nc-$wf" <<'PYT'
import sys, yaml
wf = yaml.safe_load(open(sys.argv[1]))
on = wf.get("on", wf.get(True))
print("inputs", sorted(((on.get("workflow_dispatch") or {}).get("inputs") or {})))
hits = []
for jn, j in wf["jobs"].items():
    for k, v in (j.get("env") or {}).items():
        if k == "MUTATION":
            hits.append(f"{jn}.env")
    for s in j.get("steps") or []:
        if "MUTATION" in (s.get("run") or "") or "MUTATION" in str(s.get("env") or ""):
            hits.append(f"{jn}:{s.get('name')}")
print("mutation", hits)
PYT
    check "$wf.yml: a manual run takes no options" "$(grep '^inputs' "$TMP/nc-$wf")" "inputs []"
    check "$wf.yml: no job or step turns negative controls on" "$(grep '^mutation' "$TMP/nc-$wf")" "mutation []"
done
: > "$NC_REC"
nc_exec "$REPO_DIR/.github/workflows/tests.yml" shard "Run shard 1/8" .
has "run.sh --ci --shard 1/8 -j 3 --out $TMP/nc-rt/results MUTATION= " "$(cat "$NC_REC")" "tests.yml shard: really runs, negative controls off"
nc_exec "$REPO_DIR/.github/workflows/release.yml" gate "Tests, shard 1/4" .
has "run.sh --ci --shard 1/4 -j 2 --out $TMP/nc-rt/results MUTATION= " "$(cat "$NC_REC")" "release gate shard: the regression suite, negative controls off"

echo "-- its failure report: its own issue, never the release one"
export RF_KIND=negative-controls
rf_repo; rf_jobs "negative controls 2/4=failure:Negative controls, shard 2/4" "negative controls summary=failure:Every shell shard passed exactly once"
mkdir -p "$RF/sum"
printf '## ❌ 1 of 60 tests did not pass\n\n- ❌ run.test: fail\n' > "$RF/sum/verify.md"
printf '## 负对照汇总\n\n| x |\n\n没通过的单位：\n- ❌ `run.test (fail)`\n' > "$RF/sum/tally.md"
RF_SUMMARY_DIR="$RF/sum" run_report "shell=failure summary=failure"
check "nightly red: green job" "$RC" 0
check "… one issue" "$(n_issues)" 1
check "… with the dispatch label" "$(labels_of 1)" "pending/agent"
B="$(body_of 1)"
has "<!-- cavil-negative-controls-failure -->" "$B" "… its own marker"
lacks "<!-- cavil-release-failure -->" "$B" "… not the release marker"
check "… its own title" "$(rf_q "$RF/issues.json" 'd[0]["title"]')" "负对照每晚运行失败（自动报告）"
has "## 负对照每晚运行失败" "$B" "… heading names the nightly run"
has "定时（每晚）" "$B" "… says how it started"
has "不新增负对照" "$B" "… tells the agent how to fix it"
has "negative controls 2/4](" "$B" "… names the failed job"
has '`run.test (fail)`' "$B" "… lists the unit that did not go red"
has "$RF_SHA" "$B" "… tested commit"
run_report "client=failure summary=failure"
check "second red night: a comment, no new issue" "$(n_issues):$(n_comments 1)" "1:1"
has "## 又一次负对照每晚运行失败" "$(last_comment 1)" "… comment heading names the nightly run"
# the two kinds never cross
RF_KIND=release run_report "gate=failure gate-summary=failure release=skipped"
check "a release failure next to an open nightly issue: its own new issue" "$(n_issues)" 2
check "… nothing added to the nightly one" "$(n_comments 1)" 1
has "<!-- cavil-release-failure -->" "$(body_of 2)" "… with the release marker"
run_report "shell=failure summary=failure"
check "the next red night goes to the nightly issue" "$(n_comments 1):$(n_comments 2)" "2:0"

rf_repo; rf_jobs "negative controls client=failure:Negative controls (vitest / back end / UI)" "negative controls summary=failure:Every job passed"
mkdir -p "$RF/cl"; printf '❌ 没变红：看板不可写时照样发修改\n' > "$RF/cl/not-red.txt"
RF_CLIENT_DIR="$RF/cl" run_report "client=failure summary=failure"
B="$(body_of 1)"
has "negative controls client](" "$B" "client only: names the job"
has "- ❌ 没变红：看板不可写时照样发修改" "$B" "client only: lists the entry that did not go red"
lacks "### shell 测试单位" "$B" "client only: no shell section without a summary"
rf_repo; rf_jobs "negative controls client=failure:Negative controls (vitest / back end / UI)"
run_report "client=failure summary=failure"
has "客户端没留下条目清单，见该任务日志（[任务日志](https://github.com/o/r/actions/runs/777/job/12)）" "$(body_of 1)" "client, no list: says so and links the job"
rf_repo; RF_EVENT=workflow_dispatch run_report "plan=failure shell=skipped autopilot=skipped client=skipped summary=skipped"
has "- 触发：手动" "$(body_of 1)" "manual nightly run: says so"
lacks "诊断运行" "$(body_of 1)" "… not called a gate-only run"
rf_repo; run_report "shell=cancelled autopilot=cancelled client=cancelled summary=skipped"
check "cancelled night: no call at all" "$(wc -l < "$RF/calls.log")" 0
unset RF_KIND


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
    wf_mutant summary-skips-gate 'for j in gate; do' 'for j in ; do'
    wf_mutant summary-accepts-skipped '[ "$r" = success ] ||' '[ "$r" = success ] || [ "$r" = skipped ] ||'
    wf_mutant release-without-gate 'needs: [plan, gate-summary]' 'needs: [plan]'
    wf_mutant summary-without-gate 'needs: [plan, gate]' 'needs: [plan]'
    wf_mutant cut-tags-head 'release.sh --cut "$PLAN_TAG" --at "$RELEASE_SHA" $page)' 'release.sh --cut "$PLAN_TAG" --at "$(git rev-parse HEAD)" $page)'
    echo
    mutation_summary "$0"
fi

echo
echo "passed $PASS, failed $FAIL${MUT_FAIL:+; 负对照失效 $MUT_FAIL}"
# negative controls run as child processes and never touch PASS / FAIL: regression-only in every mode
REPORT_REGRESS_ONLY=1 report_counts "$PASS" "$FAIL" "" "${MUT_FAIL:--}"
[ "${MUT_FAIL:-0}" -eq 0 ] || exit 1
[ "$FAIL" -eq 0 ]
