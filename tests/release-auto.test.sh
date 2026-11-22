#!/usr/bin/env bash
# kind: e2e
# scripts/release.sh: the non-interactive mode the weekly Release workflow
# runs (--auto), the Release title (--title), and the interactive mode a
# maintainer runs by hand. Real script, real git repos (bare remote + clone).
# Also the client's release riding on it (GitHub#576): the client plan step, and the steps of
# client.yml's mode / version / tag / page, run against a bare remote.
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
    if j == "mode":  # client.yml's mode job (GitHub#628: the nightly development build's report)
        out[j]["outputs"] = {"sha": sha, "tag": "", "publish": "true", "build": "true"}
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
elif os.environ.get("RF_KIND") == "client-nightly":
    names = ["client build mode", "client quick tests (Linux)", "dmg (arm64)", "Windows installer (x64)",
             "download size (every dmg and installer built)", "publish development build"]
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
    [ "${RF_KIND:-}" = client-nightly ] && wf="${CLIENT_WORKFLOW:-$REPO_DIR/.github/workflows/client.yml}"
    needs="$(NEEDS_WF="$wf" PLAN_SHA="${RF_PLAN_SHA-$RF_SHA}" PLAN_WORK=true needs_json report-failure "$1")"
    set +e
    env -u GITHUB_STEP_SUMMARY PATH="$TMP/rfbin:$PATH" FAKE_GH_DIR="$RF" GITHUB_REPOSITORY=o/r GITHUB_RUN_ID=777 \
        GITHUB_RUN_ATTEMPT=1 GITHUB_SERVER_URL=https://github.com GITHUB_SHA=feedfacefeedfacefeedfacefeedfacefeedface \
        GITHUB_REF_NAME="${RF_REF_NAME:-main}" EVENT="${RF_EVENT:-schedule}" GATE_ONLY="${RF_GATE_ONLY:-}" \
        NEEDS="$needs" SUMMARY_DIR="${RF_SUMMARY_DIR:-}" CLIENT_DIR="${RF_CLIENT_DIR:-}" REPORT_KIND="${RF_KIND:-}" \
        CLIENT_DEV_VERSION="${RF_DEV_V:-}" CLIENT_DEV_CHECK="${RF_DEV_CHECK:-}" CLIENT_DEV_CHECK_RC="${RF_DEV_RC:-}" \
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

echo "-- AGENTS.md: turning the client's nightly report off and on again — as written (GitHub#628; written only in AGENTS.md since PR #673)"
sed -n '/<!-- client-nightly-ops:begin -->/,/<!-- client-nightly-ops:end -->/p' "$REPO_DIR/AGENTS.md" > "$TMP/cn-ops-operations.md.md"
sed -n '/^```bash$/,/^```$/p' "$TMP/cn-ops-operations.md.md" | grep -v '^```' > "$TMP/cn-ops-operations.md.sh"
grep -o '`gh variable list[^`]*`' "$TMP/cn-ops-operations.md.md" | tr -d '`' > "$TMP/cn-ops-operations.md.check"
check "the steps are no longer in the user docs" "$(grep -c 'client-nightly-ops:begin' "$REPO_DIR/docs/operations.md" "$REPO_DIR/docs/operations.zh.md" | awk -F: '{n+=$2} END {print n}')" 0
check "two steps: off, then on" "$(wc -l < "$TMP/cn-ops-operations.md.sh")" 2
check "one check command" "$(wc -l < "$TMP/cn-ops-operations.md.check")" 1
printf 'NEGATIVE_CONTROLS_REPORT\toff\t2026-11-01T00:00:00Z\n' > "$VAR_STATE"   # another switch, set before
vrun "$(sed -n 1p "$TMP/cn-ops-operations.md.sh")"
check "off: the first line runs" "$RC" 0
vrun "$(cat "$TMP/cn-ops-operations.md.check")"
check "check while off: shows CLIENT_NIGHTLY_REPORT off, the other switch untouched" "$RC:$(has_var CLIENT_NIGHTLY_REPORT off):$(has_var NEGATIVE_CONTROLS_REPORT off)" "0:yes:yes"
vrun "$(sed -n 2p "$TMP/cn-ops-operations.md.sh")"
check "on: the second line runs" "$RC" 0
vrun "$(cat "$TMP/cn-ops-operations.md.check")"
check "check after on: CLIENT_NIGHTLY_REPORT is gone, the other switch still there" "$RC:$(grep -c '^CLIENT_NIGHTLY_REPORT	' "$TMP/var.out" || true):$(has_var NEGATIVE_CONTROLS_REPORT off)" "0:0:yes"
check "the variable the steps set is the one the client's report job reads" \
    "$(grep -c "vars.CLIENT_NIGHTLY_REPORT != 'off'" "$REPO_DIR/.github/workflows/client.yml")" 1


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
    # client.yml's two manual options publish a development build (GitHub#628); none is about negative controls
    want="inputs []"; [ "$wf" = client ] && want="inputs ['force', 'publish']"
    check "$wf.yml: a manual run takes no negative-controls option" "$(grep '^inputs' "$TMP/nc-$wf")" "$want"
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


echo "== the client's release rides on the weekly release (GitHub#576)"
CLIENT_WORKFLOW="${CLIENT_WORKFLOW:-$REPO_DIR/.github/workflows/client.yml}"
cstep() {  # cstep <workflow> <job> <step name> → that step's run: script
    python3 - "$1" "$2" "$3" <<'PYC'
import sys, yaml
steps = yaml.safe_load(open(sys.argv[1]))["jobs"][sys.argv[2]]["steps"]
print(next(s["run"] for s in steps if s.get("name") == sys.argv[3]))
PYC
}
cstep "$WORKFLOW" client-plan "Decide the client release" > "$TMP/c-plan.sh"
cstep "$CLIENT_WORKFLOW" mode "Release or development build" > "$TMP/c-mode.sh"
cstep "$CLIENT_WORKFLOW" mode "Anything to build" > "$TMP/c-build.sh"
cstep "$CLIENT_WORKFLOW" package "Version" > "$TMP/c-version.sh"
cstep "$CLIENT_WORKFLOW" package-windows "Version" > "$TMP/c-version-win.sh"
cstep "$CLIENT_WORKFLOW" release "The build is the tag's version, both Macs and Windows" > "$TMP/c-files.sh"
cstep "$CLIENT_WORKFLOW" release "Tag the tested commit" > "$TMP/c-tag.sh"
cstep "$CLIENT_WORKFLOW" release "Create Release" > "$TMP/c-create.sh"

echo "-- how the jobs are wired"
python3 - "$WORKFLOW" "$CLIENT_WORKFLOW" > "$TMP/c-static" <<'PYW'
import sys, yaml
rel = yaml.safe_load(open(sys.argv[1]))["jobs"]
cl_wf = yaml.safe_load(open(sys.argv[2]))
cl = cl_wf["jobs"]
lst = lambda n: n if isinstance(n, list) else [n]
print("plan-needs", lst(rel["client-plan"]["needs"]))
print("plan-if", rel["client-plan"]["if"])
c = rel["client"]
print("call", c.get("uses"), c.get("secrets"), sorted((c.get("with") or {}).items()))
print("call-needs", lst(c["needs"]), "if", c["if"])
print("daemon-release-needs", lst(rel["release"]["needs"]))
on = cl_wf.get("on", cl_wf.get(True))
inp = on["workflow_call"]["inputs"]
print("inputs", sorted((k, v.get("required"), v.get("type")) for k, v in inp.items()))
r = cl["release"]
print("client-release-needs", sorted(lst(r["needs"])), "if", r["if"])
print("no-github-ref-tag-test", "startsWith(github.ref" not in open(sys.argv[2]).read())
bad = []
for jn, j in cl.items():
    if jn in ("mode", "test"):
        continue
    if "mode" not in lst(j.get("needs", [])):
        bad.append(f"{jn}: needs no mode")
    for s in j.get("steps") or []:
        if str(s.get("uses", "")).startswith("actions/checkout") and (s.get("with") or {}).get("ref") != "${{ needs.mode.outputs.sha }}":
            bad.append(f"{jn}: checks out another commit")
print("every-job-on-mode", bad)
print("mode-checkout", cl["mode"]["steps"][0]["with"]["ref"])
print("matrix", cl["package"]["strategy"]["matrix"]["include"])
print("dev-release-if", cl["dev-release"]["if"])
# GitHub#628: what runs on which trigger, and the queue publishing runs share
print("dev-release-conc", (cl["dev-release"].get("concurrency") or {}).get("group"), (cl["dev-release"].get("concurrency") or {}).get("cancel-in-progress"))
print("dev-release-needs", sorted(lst(cl["dev-release"]["needs"])))
# GitHub#665: the publish slot waits for nothing and reads nothing beyond the release list
print("dev-release-perms", sorted((cl["dev-release"].get("permissions") or {}).items()))
for jn in ("package", "package-windows"):
    print(f"{jn}-if", cl[jn].get("if"))
for jn in ("test-rust", "test-vitest"):
    print(f"{jn}-if", cl[jn].get("if"))
print("test-if", cl["test"].get("if"), sorted(lst(cl["test"]["needs"])))
print("e2e-if", cl["e2e"]["if"])
crons = sorted(c["cron"] for c in on["schedule"])
print("crons", crons)
d = on["workflow_dispatch"]["inputs"]
print("dispatch", sorted((k, v.get("type"), v.get("default")) for k, v in d.items()))
conc = cl_wf["concurrency"]
print("conc-group", conc["group"])
print("conc-cancel", conc["cancel-in-progress"])
rf = cl["report-failure"]
print("report-if", rf["if"])
print("report-needs", sorted(lst(rf["needs"])))
print("report-kind", [s["env"]["REPORT_KIND"] for s in rf["steps"] if (s.get("env") or {}).get("REPORT_KIND")])
print("report-perms", sorted((rf.get("permissions") or {}).items()))
win = [s.get("name") for s in cl["package-windows"]["steps"]]
print("win-last", win[-1], [s.get("run") for s in cl["package-windows"]["steps"] if s.get("name") == win[-1]])
PYW
S="$(cat "$TMP/c-static")"
has "plan-needs ['plan']" "$S" "client plan waits for the plan only, not for the daemon's gate"
has "plan-if needs.plan.outputs.work == 'true'" "$S" "… and runs whenever the run has work"
has "call ./.github/workflows/client.yml inherit [('sha', '\${{ needs.client-plan.outputs.sha }}'), ('tag', '\${{ needs.client-plan.outputs.tag }}')]" "$S" "the client job calls client.yml with the planned tag and commit, and the update key"
has "call-needs ['client-plan'] if needs.client-plan.outputs.tag != ''" "$S" "… only when the plan named a tag"
has "daemon-release-needs ['plan', 'gate-summary']" "$S" "the daemon's release waits for nothing of the client"
has "inputs [('sha', True, 'string'), ('tag', True, 'string')]" "$S" "client.yml can be called with a tag and a commit"
has "client-release-needs ['e2e', 'mode', 'package', 'package-windows', 'size', 'test'] if needs.mode.outputs.tag != ''" "$S" "client release page only after quick + full tests, both Macs, Windows (GitHub#577) and the size gate"
has "no-github-ref-tag-test True" "$S" "no job decides 'release build' from github.ref (the caller's ref in a call)"
has "every-job-on-mode []" "$S" "every build / test job checks out the commit the mode job names"
has "mode-checkout \${{ inputs.sha || github.sha }}" "$S" "the mode job checks out the called commit"
has "needs.mode.outputs.tag != ''" "$(grep '^matrix' "$TMP/c-static")" "both Macs on every release build"
has "needs.mode.outputs.tag == ''" "$(grep '^dev-release-if' "$TMP/c-static")" "a release build never publishes a development build"
has "dev-release-conc client-dev-release-publish False" "$S" "… one publish at a time, never cancelling a running one"
has "dev-release-perms [('contents', 'write')]" "$S" "… with no permission beyond writing the release (GitHub#665: no wait on other runs, no Actions read)"
has "dev-release-needs ['mode', 'package', 'package-windows', 'size', 'test']" "$S" "… only after the quick tests, both builds with their update checks, and the size gate"
has "crons ['30 20 * * *', '40 16 * * 0']" "$S" "two schedules: the nightly build and the weekly full run"
has "dispatch [('force', 'boolean', False), ('publish', 'boolean', False)]" "$S" "a manual run can publish, and skip the 'anything new?' check, both off by default"
# which jobs run on which trigger, the concurrency group and the report: evaluated below from the
# workflow's own expressions, after the mode job's steps have run for each trigger (GitHub#628)
has "report-needs ['dev-release', 'mode', 'package', 'package-windows', 'size', 'test']" "$S" "… looking at every job of the night"
has "report-kind ['client-nightly']" "$S" "… into its own kind of issue"
has "report-perms [('actions', 'read'), ('contents', 'read'), ('issues', 'write')]" "$S" "… the only job that may write issues"
has "win-last A real update of the installed app ['bash scripts/windows-update-check.sh release/Cavil-Loop-*-windows-x64.exe']" "$S" "the Windows job ends with a real update of the installed app (GitHub#628)"
check "the Windows build stamps its version with the very same step as the Macs (GitHub#577)" "$(cmp -s "$TMP/c-version.sh" "$TMP/c-version-win.sh" && echo same)" "same"

# A repo of its own: client/ with the real version files and scripts, a bare remote, one tag list.
CREMOTE="$TMP/client-remote.git"; CWORK="$TMP/client-work"
git init -q --bare "$CREMOTE"; git clone -q "$CREMOTE" "$CWORK" 2>/dev/null
mkdir -p "$CWORK/client/src-tauri" "$CWORK/client/scripts"
cp "$REPO_DIR/client/package.json" "$CWORK/client/"
cp "$REPO_DIR/client/src-tauri/tauri.conf.json" "$REPO_DIR/client/src-tauri/Cargo.toml" "$CWORK/client/src-tauri/"
cp "$REPO_DIR/client/scripts/release-version.mjs" "$REPO_DIR/client/scripts/dev-version.mjs" "$CWORK/client/scripts/"
node "$CWORK/client/scripts/release-version.mjs" write 0.5.2 --root "$CWORK/client" >/dev/null
echo base > "$CWORK/file"
git -C "$CWORK" add -A; git -C "$CWORK" commit -qm "client 0.5.2"; git -C "$CWORK" push -q origin main
ccommit() {  # ccommit <path> <msg>: change one file, commit, push → prints the commit
    git -C "$CWORK" pull -q --ff-only origin main 2>/dev/null || true
    echo "$2" >> "$CWORK/$1"; git -C "$CWORK" add -A; git -C "$CWORK" commit -qm "$2"; git -C "$CWORK" push -q origin main
    git -C "$CWORK" rev-parse HEAD
}
export CREL="$TMP/client-releases"; : > "$CREL"
crun() {  # crun <dir> <script> [VAR=value …] → $RC, outputs in $TMP/c-output, stdout / stderr in $TMP/c-out / c-err
    local dir="$1" s="$2"; shift 2
    : > "$TMP/c-output"; rm -f "$GH_ARGS"
    set +e
    (cd "$dir" && env -u EVENT -u GH_FAIL_API -u GH_FAIL_TAGS GITHUB_OUTPUT="$TMP/c-output" GITHUB_REPOSITORY=o/r GH_RELEASES="$CREL" \
        PATH="${CPATH:-}$TMP/bin:$PATH" "$@" bash -e "$s") >"$TMP/c-out" 2>"$TMP/c-err"
    RC=$?
    set -e
}
cout() { sed -n "s/^$1=//p" "$TMP/c-output"; }
cplan() {  # cplan <action> <sha> [VAR=value …] in a fresh checkout of the client repo
    rm -rf "$TMP/client-run"; git clone -q "$CREMOTE" "$TMP/client-run" 2>/dev/null
    local a="$1" s="$2"; shift 2
    crun "$TMP/client-run" "$TMP/c-plan.sh" ACTION="$a" SHA="$s" GH_TOKEN=x "$@"
}

echo "-- the plan: which runs get a client release, and which version"
C0="$(git -C "$CREMOTE" rev-parse main)"
cplan new "$C0"
check "no client release yet → the first one, package.json's version" "$RC:$(cout tag):$(cout sha)" "0:client/v0.5.2:$C0"
has "还没有发出过客户端正式版" "$(cat "$TMP/c-err")" "… says so in the run log"
cplan page "$C0"
check "a run finishing the week's missing page: the same" "$RC:$(cout tag)" "0:client/v0.5.2"
for a in none verify push ""; do
    cplan "$a" "$C0"
    check "action '${a}': no client release, nothing read" "$RC:$(cout tag):$( [ -f "$GH_ARGS" ] && echo read || echo none)" "0::none"
done
git -C "$CREMOTE" tag client/v0.5.2 "$C0"; echo client/v0.5.2 >> "$CREL"
C1="$(ccommit file "daemon only")"
cplan new "$C1"
check "only files outside client/ changed since client/v0.5.2 → no client release" "$RC:$(cout tag)" "0:"
has "以来客户端没有改动" "$(cat "$TMP/c-err")" "… says so"
grep -qx -- "--paginate" "$GH_ARGS" && ok "… having read every page of the Release list" || bad "… having read every page of the Release list"
C2="$(ccommit client/src-tauri/x "client change")"
cplan new "$C2"
check "client/ changed → the next patch version, on the planned commit" "$RC:$(cout tag):$(cout sha)" "0:client/v0.5.3:$C2"
cplan new "$C1"
check "the planned commit decides, not main's tip (the client change came after it)" "$RC:$(cout tag)" "0:"
git -C "$CREMOTE" tag client/v0.6.1-dev.9 "$C2"
cplan new "$C2"
check "development tags do not count" "$RC:$(cout tag)" "0:client/v0.5.3"
git -C "$CREMOTE" tag client/v0.5.3 "$C2"   # its release failed: a tag, no page
C3="$(ccommit file "daemon only again")"
cplan new "$C3"
check "the highest tag has no page → measured from the last real release, numbered past every tag" "$RC:$(cout tag)" "0:client/v0.5.4"
(cd "$CWORK" && git pull -q --ff-only origin main && node client/scripts/release-version.mjs write 0.6.0 --root client >/dev/null \
    && git commit -qam "client 0.6.0" && git push -q origin main)
C4="$(git -C "$CREMOTE" rev-parse main)"
cplan new "$C4"
check "package.json raised above every tag → that version" "$RC:$(cout tag)" "0:client/v0.6.0"
cplan new "$C4" GH_FAIL_API=1
check "the Release list cannot be read → the job fails, no tag" "$([ "$RC" != 0 ] && echo red):$(cout tag)" "red:"
mkdir -p "$TMP/c-gitbad"
printf '#!/usr/bin/env bash\n[ "$1" = -C ] && [ "$3" = ls-remote ] && { echo "fatal: injected" >&2; exit 128; }\nexec %q "$@"\n' "$(command -v git)" > "$TMP/c-gitbad/git"
chmod +x "$TMP/c-gitbad/git"
CPATH="$TMP/c-gitbad:" cplan new "$C4"
check "the remote's tags cannot be read → the job fails, no tag" "$([ "$RC" != 0 ] && echo red):$(cout tag)" "red:"
has "读不到远端的客户端标签" "$(cat "$TMP/c-err")" "… says why"
cplan new 0000000000000000000000000000000000000000
check "a planned commit that is not there → the job fails" "$([ "$RC" != 0 ] && echo red):$(cout tag)" "red:"

echo "-- the build mode: release or development build, which version, which key"
rm -rf "$TMP/client-run"; git clone -q "$CREMOTE" "$TMP/client-run" 2>/dev/null
cmode() { crun "$TMP/client-run/client" "$TMP/c-mode.sh" "$@"; }
mode_line() { echo "$RC:$(cout tag):$(cout version):$(cout sha):$(cout sign):$(cout publish)"; }
cmode CALL_TAG=client/v0.6.0 CALL_SHA="$C4" GITHUB_REF=refs/heads/main GITHUB_SHA="$C1" EVENT=schedule
check "called by the weekly release → that tag, its version, the planned commit, the real key" "$(mode_line)" "0:client/v0.6.0:0.6.0:$C4:true:false"
cmode CALL_TAG=client/v0.6.0 CALL_SHA="$C4" GITHUB_REF=refs/heads/main GITHUB_SHA="$C1" EVENT=schedule SCHEDULE='30 20 * * *'
check "… a release build never publishes a development build, whatever the caller's schedule" "$(mode_line)" "0:client/v0.6.0:0.6.0:$C4:true:false"
cmode CALL_TAG=client/v0.6.0 CALL_SHA= GITHUB_REF=refs/heads/main GITHUB_SHA="$C1" EVENT=schedule
check "called without a commit → fails" "$([ "$RC" != 0 ] && echo red):$(cout tag)" "red:"
cmode GITHUB_REF=refs/tags/client/v0.6.0 GITHUB_SHA="$C4" EVENT=push
check "a client tag pushed by hand → the tag's version, no commit needed to change it" "$(mode_line)" "0:client/v0.6.0:0.6.0:$C4:true:false"
cmode GITHUB_REF=refs/tags/client/v0.5.9 GITHUB_SHA="$C4" EVENT=push
check "a tag below package.json → fails" "$([ "$RC" != 0 ] && echo red):$(cout tag)" "red:"
has "低于 package.json 的版本 0.6.0" "$(cat "$TMP/c-err")" "… says why"
git -C "$CREMOTE" tag client/v0.7.0 "$C4"
cmode GITHUB_REF=refs/tags/client/v0.6.5 GITHUB_SHA="$C4" EVENT=push
check "a tag not above an existing release tag → fails" "$([ "$RC" != 0 ] && echo red)" "red"
has "已有 client/v0.7.0" "$(cat "$TMP/c-err")" "… says why"
git -C "$CREMOTE" tag -d client/v0.7.0 >/dev/null
cmode GITHUB_REF=refs/tags/client/v0.6.1-dev.3 GITHUB_SHA="$C4" EVENT=push
check "a development-shaped tag → fails" "$([ "$RC" != 0 ] && echo red)" "red"
cmode GITHUB_REF=refs/heads/main GITHUB_SHA="$C4" EVENT=push
check "push to main → development build to publish, the real key (GitHub#665: as before GitHub#628)" "$(mode_line)" "0:::$C4:true:true"
cmode GITHUB_REF=refs/heads/main GITHUB_SHA="$C4" EVENT=schedule SCHEDULE='40 16 * * 0'
check "the weekly schedule → development build, a throw-away key, nothing published" "$(mode_line)" "0:::$C4:false:false"
cmode GITHUB_REF=refs/heads/main GITHUB_SHA="$C4" EVENT=schedule SCHEDULE='30 20 * * *'
check "the nightly schedule → development build to publish, the real key (GitHub#628)" "$(mode_line)" "0:::$C4:true:true"
for ev in workflow_dispatch pull_request; do
    cmode GITHUB_REF=refs/heads/main GITHUB_SHA="$C4" EVENT="$ev"
    check "$ev → development build, a throw-away key, nothing published" "$(mode_line)" "0:::$C4:false:false"
done
cmode GITHUB_REF=refs/heads/main GITHUB_SHA="$C4" EVENT=workflow_dispatch PUBLISH=false
check "manual run on main, publish not ticked → a check run" "$(mode_line)" "0:::$C4:false:false"
cmode GITHUB_REF=refs/heads/main GITHUB_SHA="$C4" EVENT=workflow_dispatch PUBLISH=true
check "manual run on main, publish ticked → publish, the real key" "$(mode_line)" "0:::$C4:true:true"
cmode GITHUB_REF=refs/heads/feature/issue-628 GITHUB_SHA="$C4" EVENT=workflow_dispatch PUBLISH=true
check "manual run on another branch, publish ticked → fails at once, no decision written" "$([ "$RC" != 0 ] && echo red):$(cout sign):$(cout publish)" "red::"
has "只能在 main 上运行" "$(cat "$TMP/c-out")" "… says why"
cmode GITHUB_REF=refs/heads/feature/issue-628 GITHUB_SHA="$C4" EVENT=workflow_dispatch PUBLISH=false
check "manual run on another branch, publish not ticked → a check run with a throw-away key" "$(mode_line)" "0:::$C4:false:false"

echo "-- anything to build: release, check runs, publishing runs (GitHub#628)"
for f in dev-plan.mjs dev-release.mjs update-manifest.mjs; do cp "$REPO_DIR/client/scripts/$f" "$TMP/client-run/client/scripts/"; done
cbuild() {  # cbuild <releases JSON> VAR=… → build/quick outputs
    printf '%s' "$1" > "$TMP/c-devlist.json"; shift
    mkdir -p "$TMP/c-devbin" "$TMP/c-rt"
    [ -f "$TMP/c-devtags.json" ] || printf '[]' > "$TMP/c-devtags.json"
    # one tag ref (scripts/dev-release.mjs reads it before calling a build done): a published release's
    # tag is on the commit it recorded; no published release of that name → 404
    # the tag list (scripts/dev-plan.mjs): the refs a test wrote to c-devtags.json, plus every published
    # release's own tag on the commit it recorded (GitHub creates it on publishing) unless the test
    # named that tag itself
    cat > "$TMP/c-tagrefs.py" <<'PYT'
import json, sys
given = json.load(open(sys.argv[1]))
names = {r["ref"] for r in given}
for r in json.load(open(sys.argv[2])):
    ref = "refs/tags/" + str(r.get("tag_name"))
    if r.get("draft") is False and ref not in names:
        given.append({"ref": ref, "object": {"type": "commit", "sha": r.get("target_commitish")}})
print(json.dumps([given]))
PYT
    cat > "$TMP/c-tagref.py" <<'PYT'
import json, sys
tag = sys.argv[1].split("/git/ref/tags/", 1)[1]
rel = [r for r in json.load(open(sys.argv[2])) if r.get("tag_name") == tag and r.get("draft") is False]
if not rel:
    print("HTTP 404: Not Found", file=sys.stderr)
    sys.exit(1)
print(json.dumps({"ref": "refs/tags/" + tag, "object": {"type": "commit", "sha": rel[0]["target_commitish"]}}))
PYT
    # the release list, or (scripts/dev-plan.mjs's second read) the client/v* tag refs; GH_FAIL_TAGS fails only the latter
    printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$@" >> "$GH_ARGS"\n[ -z "${GH_FAIL_API:-}" ] || { echo "HTTP 502: injected" >&2; exit 1; }\ncase "$*" in *matching-refs*) [ -z "${GH_FAIL_TAGS:-}" ] || { echo "HTTP 502: injected" >&2; exit 1; }; exec python3 %q %q %q;; *git/ref/tags/*) [ -z "${GH_FAIL_TAGS:-}" ] || { echo "HTTP 502: injected" >&2; exit 1; }; exec python3 %q "$2" %q;; esac\nprintf "[%%s]" "$(cat %q)"\n' "$TMP/c-tagrefs.py" "$TMP/c-devtags.json" "$TMP/c-devlist.json" "$TMP/c-tagref.py" "$TMP/c-devlist.json" "$TMP/c-devlist.json" > "$TMP/c-devbin/gh"
    chmod +x "$TMP/c-devbin/gh"
    CPATH="$TMP/c-devbin:" crun "${CBUILD_ROOT:-$TMP/client-run}/client" "$TMP/c-build.sh" RUNNER_TEMP="$TMP/c-rt" SHA="$C4" GH_TOKEN=x "$@"
}
build_line() { echo "$RC:$(cout build):$(cout quick)"; }
# a published development build carrying every file a build carries (scripts/dev-release.mjs --files)
devrel() {
    local v="0.6.1-dev.$1" assets
    assets="$(node "$REPO_DIR/client/scripts/dev-release.mjs" --files "$v" | python3 -c 'import json,sys; print(json.dumps([{"name": l.strip(), "state": "uploaded", "size": 10} for l in sys.stdin if l.strip()]))')"
    printf '[{"id":1,"tag_name":"client/v%s","draft":false,"prerelease":true,"target_commitish":"%s","assets":%s}]' "$v" "$2" "$assets"
}
devrel_without() {  # devrel_without <n> <sha> <file suffix> → the same build with that file missing
    devrel "$1" "$2" | python3 -c 'import json,sys; d=json.load(sys.stdin); d[0]["assets"]=[a for a in d[0]["assets"] if not a["name"].endswith(sys.argv[1])]; print(json.dumps(d))' "$3"
}
cbuild '[]' TAG=client/v0.6.0 PUBLISH=false EVENT=push
check "a release build → build" "$(build_line)" "0:true:true"
cbuild '[]' TAG= PUBLISH=false EVENT=pull_request
check "pull_request → quick tests only, nothing built" "$(build_line)" "0:false:true"
cbuild "$(devrel 9 "$C1")" TAG= PUBLISH=true EVENT=push
check "push to main (publishing), client changed since the last build → build (GitHub#665)" "$(build_line)" "0:true:true"
cbuild "$(devrel 9 "$C4")" TAG= PUBLISH=true EVENT=push
check "push to main (publishing), this commit already out → skipped before building, the quick tests still run" "$(build_line)" "0:false:true"
for ev in schedule workflow_dispatch; do
    cbuild '[]' TAG= PUBLISH=false EVENT="$ev"
    check "$ev (not publishing) → build and check" "$(build_line)" "0:true:true"
done
cbuild "$(devrel 9 "$C4")" TAG= PUBLISH=true EVENT=schedule
check "publishing run, the commit already published → nothing built, no quick tests either" "$(build_line)" "0:false:false"
has "就是这个提交" "$(cat "$TMP/c-out")" "… says why in the log"
cbuild "$(devrel 9 "$C4")" TAG= PUBLISH=true EVENT=workflow_dispatch FORCE=true
check "… forced → built and checked again" "$(build_line)" "0:true:true"
cbuild "$(devrel 9 "$C2")" TAG= PUBLISH=true EVENT=schedule SHA="$C3"
check "publishing run, main moved on with a daemon-only commit since the last build → nothing built" "$(build_line)" "0:false:false"
has "以来客户端没有改动" "$(cat "$TMP/c-out")" "… says why in the log"
cbuild "$(devrel 9 "$C2")" TAG= PUBLISH=true EVENT=workflow_dispatch FORCE=true SHA="$C3"
check "… forced (\"even without a client change\") → built" "$(build_line)" "0:true:true"
cbuild "$(devrel 9 "$C3")" TAG= PUBLISH=true EVENT=schedule
check "publishing run, only the version files changed since (client/) → build" "$(build_line)" "0:true:true"
cbuild "$(devrel 9 "$C1")" TAG= PUBLISH=true EVENT=schedule
check "publishing run, client/ changed since the last build → build" "$(build_line)" "0:true:true"
cbuild "$(devrel 9 "$C4")" TAG= PUBLISH=true EVENT=schedule GH_FAIL_API=1
check "publishing run, the release list cannot be read → build (never a lost night)" "$(build_line)" "0:true:true"
cbuild '[]' TAG= PUBLISH=true EVENT=schedule SHA=main
check "publishing run, no full commit to compare → the step fails" "$([ "$RC" != 0 ] && echo red):$(cout build)" "red:"
# a public build that is not complete is never changed (PR #630 Q1 = B): on its own commit nothing
# is built; on any later commit a higher version comes out over it, client change or not
for gone in -windows-x64.exe latest.json; do
    cbuild "$(devrel_without 9 "$C4" "$gone")" TAG= PUBLISH=true EVENT=schedule
    check "publishing run, the commit already published but without its $gone → nothing built (the public build is not changed)" "$(build_line)" "0:false:false"
    has "已公开的版本一律不改" "$(cat "$TMP/c-out")" "… says why in the log"
    cbuild "$(devrel_without 9 "$C2" "$gone")" TAG= PUBLISH=true EVENT=schedule SHA="$C3"
    check "… after daemon-only commits → build (a higher version over it)" "$(build_line)" "0:true:true"
done
# review round 4 #9: a build made and then hidden again (the publish step turned it back into a draft
# to fill it in and could not finish): its tag is there, its release page is not public — the
# read-only token cannot see the draft itself. The next night builds, client change or not.
printf '[{"ref":"refs/tags/client/v0.6.1-dev.12","object":{"type":"commit","sha":"%s"}},{"ref":"refs/tags/client/v0.6.1-dev.9","object":{"type":"commit","sha":"%s"}}]' "$C2" "$C2" > "$TMP/c-devtags.json"
cbuild "$(devrel 9 "$C2")" TAG= PUBLISH=true EVENT=schedule SHA="$C3"
check "publishing run, no client change, but a higher build is tagged and not public → build" "$(build_line)" "0:true:true"
has "client/v0.6.1-dev.12" "$(cat "$TMP/c-out")" "… naming it in the log"
check "… it read the tag refs" "$(grep -c 'matching-refs/tags/client/v' "$GH_ARGS")" 1
# that hidden build is of this very commit (it was public once; a public build is never changed and
# the same commit gets the same version): nothing built (PR #630 review #11)
printf '[{"ref":"refs/tags/client/v0.6.1-dev.12","object":{"type":"commit","sha":"%s"}},{"ref":"refs/tags/client/v0.6.1-dev.9","object":{"type":"commit","sha":"%s"}}]' "$C3" "$C2" > "$TMP/c-devtags.json"
cbuild "$(devrel 9 "$C2")" TAG= PUBLISH=true EVENT=schedule SHA="$C3"
check "… the hidden build is of this very commit → nothing built" "$(build_line)" "0:false:false"
has "公开过的版本一律不改" "$(cat "$TMP/c-out")" "… says why in the log"
printf '[{"ref":"refs/tags/client/v0.6.1-dev.9","object":{"type":"commit","sha":"%s"}},{"ref":"refs/tags/client/v0.6.1-dev.3","object":{"type":"commit","sha":"%s"}}]' "$C2" "$C1" > "$TMP/c-devtags.json"
cbuild "$(devrel 9 "$C2")" TAG= PUBLISH=true EVENT=schedule SHA="$C3"
check "… only the published build's tag and a lower one (an old build being cleaned up) → nothing built" "$(build_line)" "0:false:false"
cbuild "$(devrel 9 "$C2")" TAG= PUBLISH=true EVENT=schedule SHA="$C3" GH_FAIL_TAGS=1
check "… the tag list cannot be read → build (never a lost night)" "$(build_line)" "0:true:true"
# review round 4 #14: the newest build's files are complete but its tag is on another commit — the
# plan judges it by the publish step's rule (not done): on its own commit nothing is built (it is not
# changed), after a daemon-only commit a higher version is built
printf '[{"ref":"refs/tags/client/v0.6.1-dev.9","object":{"type":"commit","sha":"%s"}}]' "$C1" > "$TMP/c-devtags.json"
cbuild "$(devrel 9 "$C2")" TAG= PUBLISH=true EVENT=schedule SHA="$C3"
check "publishing run, no client change, but the newest build's tag is on another commit → build" "$(build_line)" "0:true:true"
has "标签不在发版记下的提交上" "$(cat "$TMP/c-out")" "… says why in the log"
cbuild "$(devrel 9 "$C4")" TAG= PUBLISH=true EVENT=schedule
check "… on that build's own commit → nothing built (the public build is not changed)" "$(build_line)" "0:false:false"
printf '[]' > "$TMP/c-devtags.json"
STARTER="$(devrel 9 "$C4" | python3 -c 'import json,sys; d=json.load(sys.stdin); [a.update(state="starter", size=0) for a in d[0]["assets"] if a["name"].endswith("-windows-x64.exe")]; print(json.dumps(d))')"
cbuild "$STARTER" TAG= PUBLISH=true EVENT=schedule
check "publishing run, the commit already published but its Windows installer only a placeholder (starter, size 0) → nothing built (not complete, and not changed)" "$(build_line)" "0:false:false"
cbuild "$STARTER" TAG= PUBLISH=true EVENT=workflow_dispatch FORCE=true
check "… forced → built and checked (the publish step then refuses to change it)" "$(build_line)" "0:true:true"

echo "-- a push that undoes an unpublished client change: quick tests still run, nothing built (GitHub#665 review round 1, problem 1)"
# real commits in a copy of the client repo: A is published, B changes the client (never published),
# C reverts B — C changed the client in its own push, but not since A
rm -rf "$TMP/client-revert"; cp -a "$TMP/client-run" "$TMP/client-revert"
rgit() { git -C "$TMP/client-revert" -c user.name=t -c user.email=t@example.invalid "$@"; }
REV_A="$(rgit rev-parse HEAD)"
echo "unpublished change" >> "$TMP/client-revert/client/src-tauri/x"; rgit add client/src-tauri/x; rgit commit -qm "B: client change"
REV_B="$(rgit rev-parse HEAD)"
rgit revert --no-edit HEAD >/dev/null; REV_C="$(rgit rev-parse HEAD)"
check "… the revert really leaves the client as A had it, B really changed it" "$(rgit diff --quiet "$REV_A" "$REV_C" -- client && echo same):$(rgit diff --quiet "$REV_A" "$REV_B" -- client || echo differs)" "same:differs"
CBUILD_ROOT="$TMP/client-revert" cbuild "$(devrel 9 "$REV_A")" TAG= PUBLISH=true EVENT=push SHA="$REV_C"
check "push to main of the revert C (A published) → nothing built, the quick tests still run" "$(build_line)" "0:false:true"
has "以来客户端没有改动" "$(cat "$TMP/c-out")" "… the plan says why"
CBUILD_ROOT="$TMP/client-revert" cbuild "$(devrel 9 "$REV_A")" TAG= PUBLISH=true EVENT=schedule SHA="$REV_C"
check "… the night on C: skipped before building, no quick tests (unchanged rule)" "$(build_line)" "0:false:false"
CBUILD_ROOT="$TMP/client-revert" cbuild "$(devrel 9 "$REV_A")" TAG= PUBLISH=true EVENT=push SHA="$REV_B"
check "… the push of B itself → build and publish" "$(build_line)" "0:true:true"

echo "-- AGENTS.md: checking whether a build is complete — the command as written (review round 2 #6; only in AGENTS.md since PR #673)"
sed -n '/<!-- client-nightly-check:begin -->/,/<!-- client-nightly-check:end -->/p' "$REPO_DIR/AGENTS.md" \
    | sed -n '/^```bash$/,/^```$/p' | grep -v '^```' > "$TMP/cn-check-operations.md.sh"
check "one check command" "$(wc -l < "$TMP/cn-check-operations.md.sh")" 1
DOCV="$(grep -o '0\.[0-9]*\.[0-9]*-dev\.[0-9]*' "$TMP/cn-check-operations.md.sh")"
doclist() {  # doclist <python expression editing the asset list `a`> → a release list for $DOCV
    node "$REPO_DIR/client/scripts/dev-release.mjs" --files "$DOCV" | python3 -c '
import json, sys
a = [{"name": l.strip(), "state": "uploaded", "size": 10} for l in sys.stdin if l.strip()]
exec(sys.argv[2])
print(json.dumps([{"id": 1, "tag_name": "client/v" + sys.argv[1], "draft": False, "prerelease": True, "target_commitish": "a" * 40, "assets": a}]))' "$DOCV" "$1"
}
docrun() { printf '%s' "$1" > "$TMP/c-devlist.json"; shift; CPATH="$TMP/c-devbin:" crun "$TMP/client-run/client" "$TMP/cn-check-operations.md.sh" "$@"; }
docrun "$(doclist 'pass')"
check "complete build → COMPLETE, exit 0" "$RC:$(grep -c '^COMPLETE' "$TMP/c-out")" "0:1"
docrun "$(doclist 'a = [dict(x, state="starter", size=0) if x["name"].endswith("-windows-x64.exe") else x for x in a]')"
check "Windows installer only a placeholder → INCOMPLETE naming it, exit 1" "$RC:$(grep -c "^INCOMPLETE.*-windows-x64.exe" "$TMP/c-out")" "1:1"
docrun "$(doclist 'a = [x for x in a if not x["name"].endswith(".app.tar.gz.sig")]')"
check "Mac update signature missing → INCOMPLETE, exit 1" "$RC:$(grep -c "^INCOMPLETE.*arm64.app.tar.gz.sig" "$TMP/c-out")" "1:1"
docrun "$(doclist 'pass')" GH_FAIL_API=1
check "release list unreadable → UNKNOWN, exit 2 (never 'not there')" "$RC:$(grep -c '^UNKNOWN' "$TMP/c-out")" "2:1"
check "… the check only reads" "$(grep -cE '^(release|-X)$' "$GH_ARGS" || true)" 0

echo "-- the version a publishing run tries, and what checking it says (review round 3 #6)"
cbuild '[]' TAG= PUBLISH=true EVENT=schedule FORCE=true
check "publishing run → the development version it will build" "$RC:$(cout dev_version)" "0:$(cd "$TMP/client-run/client" && node scripts/dev-version.mjs)"
cbuild '[]' TAG= PUBLISH=false EVENT=workflow_dispatch
check "a development build that publishes nothing → its version too (every build job stamps it, review round 4 #6)" "$RC:$(cout dev_version)" "0:$(cd "$TMP/client-run/client" && node scripts/dev-version.mjs)"
for ev in push pull_request; do
    cbuild '[]' TAG= PUBLISH=false EVENT="$ev"
    check "$ev (nothing built) → no version" "$RC:$(cout dev_version)" "0:"
done
cbuild '[]' TAG=client/v0.6.0 PUBLISH=false EVENT=push
check "a release build → no development version" "$RC:$(cout dev_version)" "0:"
echo "-- one version per run: counted once in the mode job, stamped as given by both builds and published as given (review round 4 #6)"
cbuild '[]' TAG= PUBLISH=true EVENT=schedule FORCE=true
MODEV="$(cout dev_version)"
git -C "$TMP/client-run" tag client/v9.0.0 "$C4"
LATERV="$(cd "$TMP/client-run/client" && node scripts/dev-version.mjs)"
check "a higher client/v tag appears mid-run: counting again would give another number" "$([ "$LATERV" != "$MODEV" ] && echo differs)" "differs"
for job in package package-windows; do
    cstep "$CLIENT_WORKFLOW" "$job" Version > "$TMP/c-ver.sh"
    (cd "$TMP/client-run/client" && git checkout -q -- package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml)
    crun "$TMP/client-run/client" "$TMP/c-ver.sh" TAG= VERSION= DEV_VERSION="$MODEV"
    check "$job: stamps the mode job's version, not a new count" "$RC:$(node -p "require('$TMP/client-run/client/package.json').version")" "0:$MODEV"
    crun "$TMP/client-run/client" "$TMP/c-ver.sh" TAG= VERSION= DEV_VERSION=
    check "$job: no version from the mode job → fails, never counts its own" "$([ "$RC" != 0 ] && echo red)" "red"
done
(cd "$TMP/client-run/client" && git checkout -q -- package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml)
cstep "$CLIENT_WORKFLOW" dev-release Version > "$TMP/c-ver.sh"
crun "$TMP/client-run/client" "$TMP/c-ver.sh" V="$MODEV"
check "dev-release: publishes the mode job's version" "$RC:$(cout version)" "0:$MODEV"
crun "$TMP/client-run/client" "$TMP/c-ver.sh" V=
check "dev-release: no version from the mode job → fails" "$([ "$RC" != 0 ] && echo red):$(cout version)" "red:"
check "… and the report checks that same output" "$(python3 -c 'import sys,yaml; print(yaml.safe_load(open(sys.argv[1]))["jobs"]["report-failure"]["steps"][1]["env"]["V"])' "$CLIENT_WORKFLOW")" '${{ needs.mode.outputs.dev_version }}'
git -C "$TMP/client-run" tag -d client/v9.0.0 >/dev/null
cstep "$CLIENT_WORKFLOW" report-failure "The version this run tried to publish" > "$TMP/c-tried.sh"
tried() {  # tried <V> <release list JSON> [VAR=…] → $RC, outputs in $TMP/c-output
    printf '%s' "$2" > "$TMP/c-devlist.json"; local v="$1"; shift 2
    CPATH="$TMP/c-devbin:" crun "$TMP/client-run" "$TMP/c-tried.sh" V="$v" GH_TOKEN=x "$@"
}
TV=0.6.1-dev.10
tried "$TV" "$(devrel 9 "$C3")"
check "a complete older build is the newest, this run's version never created → INCOMPLETE for this version (exit 1)" "$RC:$(cout version):$(cout rc):$(cout check | grep -c "^INCOMPLETE client/v$TV")" "0:$TV:1:1"
tried "$TV" "$(devrel 10 "$C4")"
check "this run's version public and complete (the clean-up failed) → COMPLETE (exit 0)" "$RC:$(cout rc):$(cout check | grep -c "^COMPLETE client/v$TV")" "0:0:1"
tried "$TV" "$(devrel 10 "$C4")" GH_FAIL_API=1
check "the list cannot be read → UNKNOWN (exit 2), never a verdict" "$RC:$(cout rc):$(cout check | grep -c '^UNKNOWN')" "0:2:1"
tried "" "$(devrel 10 "$C4")"
check "no version (the mode job failed) → no check at all" "$RC:$(cout version):$(cout check):$(cout rc)" "0:::"

echo "-- a manual publish is refused off main before anything else, a client tag included (review round 1 #3)"
git -C "$TMP/client-run" tag client/v0.6.0 "$C4" 2>/dev/null || true
for ref in refs/tags/client/v0.6.0 refs/heads/feature/x; do
    cmode GITHUB_REF="$ref" GITHUB_SHA="$C4" EVENT=workflow_dispatch PUBLISH=true
    check "manual publish on $ref → fails, nothing decided (no tag, no key, no publish)" "$([ "$RC" != 0 ] && echo red):$(cout tag):$(cout sign):$(cout publish)" "red:::"
done
cmode GITHUB_REF=refs/tags/client/v0.6.0 GITHUB_SHA="$C4" EVENT=push
check "… the same tag pushed is still a release build" "$(mode_line)" "0:client/v0.6.0:0.6.0:$C4:true:false"
cmode CALL_TAG=client/v0.6.0 CALL_SHA="$C4" GITHUB_REF=refs/heads/main GITHUB_SHA="$C1" EVENT=workflow_dispatch
check "… and the weekly release calling with it (from a manual Release run) too" "$(mode_line)" "0:client/v0.6.0:0.6.0:$C4:true:false"
git -C "$TMP/client-run" tag -d client/v0.6.0 >/dev/null 2>&1 || true

echo "-- which jobs run, per trigger: the mode job's real steps, then the workflow's own conditions evaluated (review round 1 #5)"
GHA="$REPO_DIR/tests/lib/gha_expr.py"
# csim <github ctx JSON> <inputs JSON> <release list for the build step> [scenario extras JSON] → "$SIM": ran=<jobs> group=… cancel=…
csim() {
    local gh="$1" inp="$2" list="$3" extra="${4:-{\}}" ev ref sched pub force mo
    ev="$(jq -r .event_name <<<"$gh")"; ref="$(jq -r .ref <<<"$gh")"; sched="$(jq -r '.event.schedule // ""' <<<"$gh")"
    pub="$(jq -r 'if .publish == null then "" else (.publish|tostring) end' <<<"$inp")"; force="$(jq -r 'if .force == null then "" else (.force|tostring) end' <<<"$inp")"
    cmode GITHUB_REF="$ref" GITHUB_SHA="$C4" EVENT="$ev" SCHEDULE="$sched" PUBLISH="$pub"
    mo="$(jq -n --arg tag "$(cout tag)" --arg version "$(cout version)" --arg sha "$(cout sha)" --arg sign "$(cout sign)" --arg publish "$(cout publish)" '{tag:$tag,version:$version,sha:$sha,sign:$sign,publish:$publish}')"
    MODE_RC=$RC
    cbuild "$list" TAG="$(jq -r .tag <<<"$mo")" PUBLISH="$(jq -r .publish <<<"$mo")" EVENT="$ev" FORCE="$force"
    mo="$(jq --arg build "$(cout build)" --arg quick "$(cout quick)" '. + {build:$build, quick:$quick}' <<<"$mo")"
    jq -n --argjson gh "$gh" --argjson inp "$inp" --argjson mo "$mo" --argjson x "$extra" \
        '{github:$gh, inputs:$inp, vars:{}, outputs:{mode:$mo}} + $x' > "$TMP/c-sim.json"
    python3 "$GHA" simulate "$CLIENT_WORKFLOW" "$TMP/c-sim.json" > "$TMP/c-sim.out" || { SIM="simulate failed: $(cat "$TMP/c-sim.out")"; return; }
    SIM="$(jq -r '"ran=" + ([.jobs | to_entries[] | select(.value != "skipped") | .key] | sort | join(",")) + " group=" + (.group|tostring) + " cancel=" + (.cancel|tostring)' "$TMP/c-sim.out")"
}
job_of() { jq -r --arg j "$1" '.jobs[$j]' "$TMP/c-sim.out"; }
NIGHT='{"event_name":"schedule","ref":"refs/heads/main","event":{"schedule":"30 20 * * *"}}'
WEEK='{"event_name":"schedule","ref":"refs/heads/main","event":{"schedule":"40 16 * * 0"}}'
DISPATCH_MAIN='{"event_name":"workflow_dispatch","ref":"refs/heads/main","event":{}}'
DISPATCH_BRANCH='{"event_name":"workflow_dispatch","ref":"refs/heads/feature/issue-628","event":{}}'
PUSH_MAIN='{"event_name":"push","ref":"refs/heads/main","event":{}}'
PR='{"event_name":"pull_request","ref":"refs/pull/630/merge","event":{"pull_request":{"number":630}}}'
CHANGED="$(devrel 9 "$C1")"; SAME="$(devrel 9 "$C4")"
BUILDJOBS="mode,package,package-windows,size,test,test-rust,test-vitest"
csim "$NIGHT" '{}' "$CHANGED"
check "nightly, client changed → quick tests, both builds, size gate, publish; one never-cancelling group" "$SIM" "ran=dev-release,$BUILDJOBS group=client-dev-publish cancel=false"
csim "$NIGHT" '{}' "$SAME"
check "nightly, nothing new → only the mode job runs (and the run is green)" "$SIM" "ran=mode group=client-dev-publish cancel=false"
csim "$WEEK" '{}' "$SAME"
check "weekly → quick + full tests, both builds, size gate, nothing published; its own group" "$SIM" "ran=e2e,$BUILDJOBS group=client-refs/heads/main-weekly cancel=true"
csim "$DISPATCH_MAIN" '{"publish":true,"force":false}' "$CHANGED"
check "manual publish on main, client changed → the nightly run by hand, same group" "$SIM" "ran=dev-release,$BUILDJOBS group=client-dev-publish cancel=false"
csim "$DISPATCH_MAIN" '{"publish":true,"force":false}' "$SAME"
check "manual publish on main, nothing new → only the mode job" "$SIM" "ran=mode group=client-dev-publish cancel=false"
csim "$DISPATCH_MAIN" '{"publish":true,"force":true}' "$SAME"
check "manual publish + force on the commit already out → built and checked, publish runs (and writes nothing, dev-release.mjs)" "$SIM" "ran=dev-release,$BUILDJOBS group=client-dev-publish cancel=false"
csim "$DISPATCH_BRANCH" '{"publish":false,"force":false}' "$SAME"
check "manual check run on a branch → quick + full tests, both builds, nothing published; the branch's own group" "$SIM" "ran=e2e,$BUILDJOBS group=client-refs/heads/feature/issue-628 cancel=true"
csim "$PUSH_MAIN" '{}' "$CHANGED"
check "push to main, client changed → quick tests, both builds, size gate, publish; its own never-cancelling group (GitHub#665)" "$SIM" "ran=dev-release,$BUILDJOBS group=client-dev-publish-push cancel=false"
csim "$PUSH_MAIN" '{}' "$SAME"
check "push to main, this commit already out → skipped before building, the quick tests still run" "$SIM" "ran=mode,test,test-rust,test-vitest group=client-dev-publish-push cancel=false"
csim "$PUSH_MAIN" '{}' "$CHANGED" '{"results":{"dev-release":"failure"}}'
check "push to main, the publish step failed → no report (only the nightly run reports)" "$(job_of report-failure)" "skipped"
csim '{"event_name":"push","ref":"refs/tags/client/v0.6.0","event":{}}' '{}' "$SAME"
check "a pushed client tag keeps its own cancelling group (not a publishing queue)" "${SIM##* group=}" "client-refs/tags/client/v0.6.0 cancel=true"
csim "$PR" '{}' "$SAME"
check "pull request → quick tests only, the PR's own group" "$SIM" "ran=mode,test,test-rust,test-vitest group=client-630 cancel=true"

echo "-- several runs in order: merges, nights and a manual publish meeting at the publish step (GitHub#665 review round 1, problem 5)"
# The queues are the workflow's own (groups and cancel flags evaluated above from its expressions); how
# GitHub runs a group is modelled: one running, one waiting, a newcomer replaces the waiting one, a
# running one is never cancelled (cancel-in-progress false). What each run then does at the publish step
# is the real decision of scripts/dev-release.mjs (`decide`), and what the next night does is the real
# plan of scripts/dev-plan.mjs (`plan` on `latestBuild`).
csim "$PUSH_MAIN" '{}' "$CHANGED"; QPUSH="$(jq -r .group "$TMP/c-sim.out"):$(jq -r .cancel "$TMP/c-sim.out")"
csim "$NIGHT" '{}' "$CHANGED"; QNIGHT="$(jq -r .group "$TMP/c-sim.out"):$(jq -r .cancel "$TMP/c-sim.out")"
csim "$DISPATCH_MAIN" '{"publish":true,"force":false}' "$CHANGED"; QMAN="$(jq -r .group "$TMP/c-sim.out"):$(jq -r .cancel "$TMP/c-sim.out")"
QSLOT="$(python3 -c 'import sys,yaml; c=yaml.safe_load(open(sys.argv[1]))["jobs"]["dev-release"]["concurrency"]; print(c["group"] + ":" + str(c["cancel-in-progress"]).lower())' "$CLIENT_WORKFLOW")"
check "the queues the model runs on: pushes alone, nights and manual publishes together, one publish slot; none cancels a running one" \
    "$QPUSH|$QNIGHT|$QMAN|$QSLOT" "client-dev-publish-push:false|client-dev-publish:false|client-dev-publish:false|client-dev-release-publish:false"
cat > "$TMP/c-order.mjs" <<'NODE'
import { decide, devFiles } from 'DEVREL';
import { plan, latestBuild } from 'DEVPLAN';
const [qpush, qnight, qman, qslot] = process.argv.slice(2).map((q) => q.split(':'));
const groupOf = { push: qpush[0], night: qnight[0], manual: qman[0] };
for (const q of [qpush, qnight, qman, qslot]) if (q[1] !== 'false') throw new Error(`a queue cancels a running run: ${q}`);
const sha = (n) => String(n).padStart(40, '0');
const release = (n) => ({ tag_name: `client/v0.6.1-dev.${n}`, draft: false, prerelease: true, published_at: 'x', target_commitish: sha(n),
  assets: devFiles(`0.6.1-dev.${n}`).map((name) => ({ name, state: 'uploaded', size: 10 })) });
// one world: release list, queues (one running + one waiting per group), the publish slot, a log
function world(published) {
  const w = { list: published.map(release), groups: {}, slot: { running: null, waiting: null }, log: [], slotReplaced: 0, maxAtSlot: 0, runs: {} };
  const q = (g) => (w.groups[g] ??= { running: null, waiting: null });
  const start = (r) => { r.state = 'building'; q(r.group).running = r; w.log.push(`${r.id} starts`); };
  w.arrive = (id, kind, n) => {
    const r = { id, kind, n, group: groupOf[kind], state: 'new' }; w.runs[id] = r;
    const g = q(r.group);
    if (!g.running) return start(r);
    if (g.waiting) { g.waiting.state = 'replaced'; w.log.push(`${g.waiting.id} replaced in its run queue by ${id}`); }
    g.waiting = r; r.state = 'waiting';
  };
  const atSlot = () => [w.slot.running, w.slot.waiting].filter(Boolean).length;
  const slotTake = (r) => { w.slot.running = r; r.state = 'publishing'; };
  // its packages are done: the run reaches the publish job
  w.packed = (id) => {
    const r = w.runs[id]; if (r.state !== 'building') throw new Error(`${id} is not building (${r.state})`);
    if (!w.slot.running) slotTake(r);
    else { if (w.slot.waiting) { w.slotReplaced++; w.slot.waiting.state = 'publish-cancelled'; } w.slot.waiting = r; r.state = 'publish-waiting'; }
    w.maxAtSlot = Math.max(w.maxAtSlot, atSlot());
  };
  // the run holding the slot publishes (or writes nothing), leaves the slot, and its run ends
  w.publish = (id, ok = true) => {
    const r = w.runs[id]; if (w.slot.running !== r) throw new Error(`${id} does not hold the publish slot`);
    const d = decide(w.list, `0.6.1-dev.${r.n}`, devFiles(`0.6.1-dev.${r.n}`));
    r.decision = d.action;
    if (d.action === 'create' && ok) { w.list.push(release(r.n)); w.log.push(`${id} publishes dev.${r.n}`); }
    else w.log.push(`${id}: ${d.action}${ok ? '' : ' (write failed)'}`);
    if (!ok) r.decision = 'failed';
    w.slot.running = null; r.state = 'done';
    if (w.slot.waiting) { const n = w.slot.waiting; w.slot.waiting = null; slotTake(n); }
    const g = q(r.group); g.running = null;
    if (g.waiting) { const n = g.waiting; g.waiting = null; start(n); }
  };
  w.top = () => Math.max(0, ...w.list.map((x) => Number(x.tag_name.split('.').pop())));
  w.nextNight = (head, changed) => plan({ latest: latestBuild(w.list, w.list.map((x) => ({ name: x.tag_name, sha: x.target_commitish }))), head: sha(head), force: false, changed });
  return w;
}
const out = {};
// 1. the older build arrives late: night (dev.10) and merge B (dev.11) build together, B finishes first
{ const w = world([9]); w.arrive('N', 'night', 10); w.arrive('B', 'push', 11); w.arrive('C', 'push', 12);
  w.packed('B'); w.packed('N'); w.publish('B'); w.publish('N'); w.packed('C'); w.publish('C');
  out.oldLate = { night: w.runs.N.decision, top: w.top(), maxAtSlot: w.maxAtSlot, replacedAtSlot: w.slotReplaced, c: w.runs.C.decision }; }
// 2. the newer build arrives late: the night publishes dev.10 first, merge B dev.11 after it
{ const w = world([9]); w.arrive('N', 'night', 10); w.arrive('B', 'push', 11);
  w.packed('N'); w.packed('B'); w.publish('N'); w.publish('B');
  out.newLate = { night: w.runs.N.decision, b: w.runs.B.decision, top: w.top(), maxAtSlot: w.maxAtSlot, replacedAtSlot: w.slotReplaced }; }
// 3. a third run arrives while one is publishing and one waits: merges B, C, D and a manual publish
{ const w = world([9]); w.arrive('N', 'night', 10); w.arrive('B', 'push', 11); w.arrive('C', 'push', 12); w.arrive('D', 'push', 13); w.arrive('M', 'manual', 13);
  w.packed('B'); w.packed('N'); w.publish('B'); w.publish('N');   // N done → M starts; B done → D starts
  w.packed('M'); w.packed('D'); w.publish('M'); w.publish('D');
  out.third = { c: w.runs.C.state, top: w.top(), maxAtSlot: w.maxAtSlot, replacedAtSlot: w.slotReplaced, m: w.runs.M.decision, d: w.runs.D.decision }; }
// 4. a merge's write fails: the next night still sees the client changed since the newest published build
{ const w = world([9]); w.arrive('B', 'push', 11); w.packed('B'); w.publish('B', false);
  out.failed = { top: w.top(), night: w.nextNight(11, true).build, nightSameAsPublished: w.nextNight(9, true).build }; }
// 5. every order of finishing for one push and one night per round, three rounds (exhaustive over 2 choices × 3)
{ let worst = 0, replaced = 0, regress = 0;
  for (let mask = 0; mask < 8; mask++) {
    const w = world([1]); let v = 1;
    for (let round = 0; round < 3; round++) {
      const night = `N${round}`, push = `P${round}`; const vn = ++v, vp = ++v;
      w.arrive(night, 'night', vn); w.arrive(push, 'push', vp);
      const first = mask >> round & 1 ? [night, push] : [push, night];
      w.packed(first[0]); w.packed(first[1]); const before = w.top(); w.publish(first[0]); w.publish(first[1]);
      if (w.top() < before) regress++;
    }
    worst = Math.max(worst, w.maxAtSlot); replaced += w.slotReplaced;
  }
  out.every = { worst, replaced, regress }; }
console.log(JSON.stringify(out));
NODE
sed -i "s|'DEVREL'|'$REPO_DIR/client/scripts/dev-release.mjs'|; s|'DEVPLAN'|'$REPO_DIR/client/scripts/dev-plan.mjs'|" "$TMP/c-order.mjs"
ORDER="$(node "$TMP/c-order.mjs" "$QPUSH" "$QNIGHT" "$QMAN" "$QSLOT")" || ORDER="model failed"
oj() { jq -c "$1" <<<"$ORDER" 2>/dev/null || echo "unreadable: $ORDER"; }
check "older build late (night dev.10 after merge dev.11): the night writes nothing, the newer one stays; never more than two at the publish step, nothing replaced there" \
    "$(oj '.oldLate')" '{"night":"skip","top":12,"maxAtSlot":2,"replacedAtSlot":0,"c":"create"}'
check "newer build late (merge dev.11 after night dev.10): both written in order" \
    "$(oj '.newLate')" '{"night":"create","b":"create","top":11,"maxAtSlot":2,"replacedAtSlot":0}'
check "a third run while one publishes and one waits: only a merge still waiting in its own run queue is replaced (C, by D, which carries it); the publish step never replaces anything" \
    "$(oj '.third')" '{"c":"replaced","top":13,"maxAtSlot":2,"replacedAtSlot":0,"m":"create","d":"done"}'
check "a merge's write fails: nothing new out, the next night builds it (and would not on the published commit)" \
    "$(oj '.failed')" '{"top":9,"night":true,"nightSameAsPublished":false}'
check "every finishing order of a push and a night, three rounds: at most two at the publish step, nothing replaced, the newest version never goes down" \
    "$(oj '.every')" '{"worst":2,"replaced":0,"regress":0}'

echo "-- the quick-test verdict: red when the mode job failed, skipped only when it said nothing to test (review round 1 #4)"
csim "$NIGHT" '{}' "$CHANGED" '{"results":{"mode":"failure"},"outputs":{}}'
check "mode job failed → the verdict job still runs (and the report too)" "$(job_of test):$(job_of test-rust):$(job_of report-failure)" "success:skipped:success"
cstep "$CLIENT_WORKFLOW" test "Both quick-test jobs passed" > "$TMP/c-verdict.sh"
verdict() { crun "$TMP" "$TMP/c-verdict.sh" "$@"; echo "$RC"; }
check "… and its step is red when the mode job failed" "$(verdict MODE=failure RUST=skipped VITEST=skipped)" 1
check "… green when both quick tests passed" "$(verdict MODE=success RUST=success VITEST=success)" 0
check "… red when one of them failed" "$(verdict MODE=success RUST=success VITEST=failure):$(verdict MODE=success RUST=failure VITEST=success)" "1:1"
csim "$NIGHT" '{}' "$SAME"
check "mode said nothing to test → the verdict job is skipped" "$(job_of test)" "skipped"

echo "-- the nightly failure report: only a failed nightly run, never a cancelled one, never when switched off (review round 1 #5)"
csim "$NIGHT" '{}' "$CHANGED" '{"results":{"package-windows":"failure"}}'
check "nightly, the Windows build failed → report (and nothing published)" "$(job_of report-failure):$(job_of dev-release):$(job_of size)" "success:skipped:skipped"
csim "$NIGHT" '{}' "$CHANGED" '{"results":{"dev-release":"failure"}}'
check "nightly, the publish step failed → report" "$(job_of report-failure)" "success"
csim "$NIGHT" '{}' "$CHANGED"
check "nightly, all green → no report" "$(job_of report-failure):$(job_of dev-release)" "skipped:success"
csim "$NIGHT" '{}' "$CHANGED" '{"results":{"package-windows":"failure"},"cancelled":true}'
check "nightly, cancelled → no report" "$(job_of report-failure)" "skipped"
csim "$NIGHT" '{}' "$CHANGED" '{"results":{"package-windows":"failure"},"vars":{"CLIENT_NIGHTLY_REPORT":"off"}}'
check "nightly, report switched off → no report" "$(job_of report-failure)" "skipped"
csim "$WEEK" '{}' "$SAME" '{"results":{"package-windows":"failure"}}'
check "weekly, a build failed → no report (not the nightly run)" "$(job_of report-failure)" "skipped"
csim "$DISPATCH_MAIN" '{"publish":true,"force":false}' "$CHANGED" '{"results":{"package-windows":"failure"}}'
check "manual publish, a build failed → no report" "$(job_of report-failure)" "skipped"

echo "-- the version written into the three files"
cver() { crun "$TMP/client-run/client" "$TMP/c-version.sh" "$@"; }
three() { node -e 'const v=require("fs");const r=process.argv[1];const p=JSON.parse(v.readFileSync(r+"/package.json")).version;const c=JSON.parse(v.readFileSync(r+"/src-tauri/tauri.conf.json")).version;const g=/^version = "([^"]*)"/m.exec(v.readFileSync(r+"/src-tauri/Cargo.toml","utf8"))[1];console.log([p,c,g].join(" "))' "$TMP/client-run/client"; }
cver TAG=client/v0.6.0 VERSION=0.6.0
check "release build: the tag's version in all three" "$RC:$(three)" "0:0.6.0 0.6.0 0.6.0"
git -C "$TMP/client-run" checkout -q -- client
cver TAG=client/v0.6.0 VERSION=
check "release build without a version → fails, nothing written" "$([ "$RC" != 0 ] && echo red):$(three)" "red:0.6.0 0.6.0 0.6.0"
N="$(git -C "$TMP/client-run" rev-list --count HEAD)"
# a development build stamps the version the mode job counted (review round 4 #6): count it the way
# the mode job does, in this checkout
mver() { (cd "$TMP/client-run/client" && node scripts/dev-version.mjs); }
cver TAG= VERSION= DEV_VERSION="$(mver)"
check "development build: package.json's version + 1, -dev.<commits>" "$RC:$(three)" "0:0.6.1-dev.$N 0.6.1-dev.$N 0.6.1-dev.$N"
git -C "$TMP/client-run" checkout -q -- client
git -C "$TMP/client-run" tag client/v0.6.4 HEAD; git -C "$TMP/client-run" tag client/v0.6.9-dev.2 HEAD
cver TAG= VERSION= DEV_VERSION="$(mver)"
check "… after a release above package.json: counted from that release (dev builds stay newer)" "$RC:$(three)" "0:0.6.5-dev.$N 0.6.5-dev.$N 0.6.5-dev.$N"
git -C "$TMP/client-run" checkout -q -- client

echo "-- the release page: the tested build, the tag on the tested commit"
mkdir -p "$TMP/client-run/client/dist-release"
for arch in arm64 x64; do for e in dmg app.tar.gz app.tar.gz.sig; do : > "$TMP/client-run/client/dist-release/Cavil-Loop-0.6.0-$arch.$e"; done; done
: > "$TMP/client-run/client/dist-release/Cavil-Loop-0.6.0-windows-x64.exe"
crun "$TMP/client-run/client" "$TMP/c-files.sh" V=0.6.0
check "the Windows installer's signature missing → fails (GitHub#577)" "$([ "$RC" != 0 ] && echo red)" "red"
: > "$TMP/client-run/client/dist-release/Cavil-Loop-0.6.0-windows-x64.exe.sig"
crun "$TMP/client-run/client" "$TMP/c-files.sh" V=0.6.0
check "both Macs' and Windows' files of the tag's version → passes" "$RC" 0
crun "$TMP/client-run/client" "$TMP/c-files.sh" V=0.6.1
check "files of another version → fails" "$([ "$RC" != 0 ] && echo red)" "red"
rm "$TMP/client-run/client/dist-release/Cavil-Loop-0.6.0-x64.app.tar.gz.sig"
crun "$TMP/client-run/client" "$TMP/c-files.sh" V=0.6.0
check "one Mac's signature missing → fails" "$([ "$RC" != 0 ] && echo red)" "red"
: > "$TMP/client-run/client/dist-release/Cavil-Loop-0.6.0-x64.app.tar.gz.sig"
ctag() { crun "$TMP/client-run/client" "$TMP/c-tag.sh" "$@"; }
ccreate() { crun "$TMP/client-run/client" "$TMP/c-create.sh" "$@"; }
remote_tag() { git -C "$CREMOTE" rev-parse -q --verify "refs/tags/$1^{commit}" 2>/dev/null || echo none; }
PAGES_BEFORE="$(wc -l < "$CREL")"
ccreate TAG=client/v0.6.0 SHA="$C4" GH_TOKEN=x
check "no tag on the remote yet → no page" "$([ "$RC" != 0 ] && echo red):$(wc -l < "$CREL")" "red:$PAGES_BEFORE"
ctag TAG=client/v0.6.0 SHA="$C3"
check "tag absent → created on the tested commit" "$RC:$(remote_tag client/v0.6.0)" "0:$C3"
ccreate TAG=client/v0.6.0 SHA="$C4" GH_TOKEN=x
check "the remote's tag is on another commit → no page" "$([ "$RC" != 0 ] && echo red):$(wc -l < "$CREL")" "red:$PAGES_BEFORE"
ctag TAG=client/v0.6.0 SHA="$C4"
check "tag on another commit → fails, left alone" "$([ "$RC" != 0 ] && echo red):$(remote_tag client/v0.6.0)" "red:$C3"
git -C "$CREMOTE" tag -d client/v0.6.0 >/dev/null
ctag TAG=client/v0.6.0 SHA="$C4"; ctag TAG=client/v0.6.0 SHA="$C4"
check "tag already on the tested commit → kept (a rerun)" "$RC:$(remote_tag client/v0.6.0)" "0:$C4"
ccreate TAG=client/v0.6.0 SHA="$C4" GH_TOKEN=x
check "page created for the tag" "$RC:$(tail -1 "$CREL")" "0:client/v0.6.0"
A="$(cat "$GH_ARGS")"
has "--verify-tag" "$A" "… never letting gh make the tag"
has "--latest=false" "$A" "… not marked Latest (the daemon's release keeps it)"
has "Cavil Loop 客户端 v0.6.0" "$A" "… titled with the version"
has "dist-release/latest.json" "$A" "… with the update manifest"

echo "-- a newer release appears while this one builds → this one writes nothing (PR #580 review round 1)"
PAGES_BEFORE="$(wc -l < "$CREL")"
git -C "$CREMOTE" tag client/v0.6.2 "$C4"     # a person pushed and released 0.6.2 meanwhile
ctag TAG=client/v0.6.1 SHA="$C4"
check "tag step: 0.6.1 not tagged once 0.6.2 exists" "$([ "$RC" != 0 ] && echo red):$(remote_tag client/v0.6.1)" "red:none"
has "已有 client/v0.6.2" "$(cat "$TMP/c-err")" "… says why"
git -C "$CREMOTE" tag client/v0.6.1 "$C4"     # tagged before 0.6.2 came, page not yet made
ccreate TAG=client/v0.6.1 SHA="$C4" GH_TOKEN=x
check "page step: no page for 0.6.1 once 0.6.2 exists" "$([ "$RC" != 0 ] && echo red):$(wc -l < "$CREL")" "red:$PAGES_BEFORE"
git -C "$CREMOTE" tag -d client/v0.6.1 client/v0.6.2 >/dev/null
CPATH="$TMP/c-gitbad:" ctag TAG=client/v0.6.1 SHA="$C4"
check "the remote's tags cannot be read → no tag" "$([ "$RC" != 0 ] && echo red):$(remote_tag client/v0.6.1)" "red:none"
ctag TAG=client/v0.6.1 SHA="$C4"
check "nothing newer → tagged as usual" "$RC:$(remote_tag client/v0.6.1)" "0:$C4"
python3 - "$CLIENT_WORKFLOW" > "$TMP/c-conc" <<'PYK'
import sys, yaml
c = yaml.safe_load(open(sys.argv[1]))["jobs"]["release"].get("concurrency") or {}
print(c.get("group"), c.get("cancel-in-progress"))
PYK
check "publishing is one at a time for every version and trigger, never cancelling a running one" "$(cat "$TMP/c-conc")" "client-release-publish False"

echo "-- a failed client release is reported; the daemon's release is not its business"
rf_repo
run_report "client=failure"
check "client failed alone → an issue for the daemon" "$RC:$(n_issues):$(labels_of 1)" "0:1:pending/agent"
B="$(body_of 1)"
has "客户端正式版没发出" "$B" "… says the client release did not ship"
has "后台工具的发版不受它影响" "$B" "… and that the daemon's release went on"
lacks "门禁已通过，发版" "$B" "… without blaming the daemon's release"
rf_repo; rf_jobs "release=failure:Create GitHub Release"
run_report "release=failure client=failure"
has "门禁已通过，发版在『Create GitHub Release』失败。" "$(body_of 1)" "daemon release and client both failed: the daemon's line still names its step"
has "客户端正式版没发出" "$(body_of 1)" "… and the client's line is there too"
rf_repo; run_report "client-plan=failure client=skipped"
has "没能判断这次要不要出客户端正式版" "$(body_of 1)" "the client plan failed → said as such"
rf_repo; run_report "client=skipped client-plan=success"
check "no client release this week (skipped) → nothing to report" "$RC:$(n_issues)" "0:0"

echo "-- a failed nightly development build is reported in its own issue (GitHub#628)"
export RF_KIND=client-nightly
# the version this run tried, and what checking it said (the workflow's "The version this run tried
# to publish" step; tested below): here it was never created — the previous night's build is the newest
export RF_DEV_V=0.5.3-dev.640 RF_DEV_RC=1 RF_DEV_CHECK="INCOMPLETE client/v0.5.3-dev.640：没有这个发版"
rf_repo; rf_jobs "Windows installer (x64)=failure:A real update of the installed app" "publish development build=skipped"
run_report "package-windows=failure size=skipped dev-release=skipped"
check "red night: green job, one issue, with the dispatch label" "$RC:$(n_issues):$(labels_of 1)" "0:1:pending/agent"
B="$(body_of 1)"
has "<!-- cavil-client-nightly-failure -->" "$B" "… its own marker"
lacks "<!-- cavil-release-failure -->" "$B" "… not the release marker"
lacks "<!-- cavil-negative-controls-failure -->" "$B" "… not the negative-controls marker"
check "… its own title" "$(rf_q "$RF/issues.json" 'd[0]["title"]')" "客户端每晚开发版失败（自动报告）"
has "## 客户端每晚开发版运行失败" "$B" "… heading names the nightly build"
has "定时（每晚）" "$B" "… says how it started"
has "失败在发布之前" "$B" "… says where it failed"
has "这次要发的 \`0.5.3-dev.640\` 没有完整发出" "$B" "… names the version this run tried, and that it did not go out (review round 3 #6)"
has "仍是上一版" "$B" "… what that means for installed apps"
has "Windows installer (x64)](" "$B" "… names the failed job"
has "「A real update of the installed app」" "$B" "… and the failed step"
has "$RF_SHA" "$B" "… the tested commit, from the mode job"
lacks "计划任务没给出受测提交" "$B" "… not the 'no tested commit' fallback"
lacks "### 客户端负对照" "$B" "… no negative-controls section"
run_report "package=failure size=skipped dev-release=skipped"
check "second red night: a comment, no new issue" "$(n_issues):$(n_comments 1)" "1:1"
has "## 又一次客户端每晚开发版运行失败" "$(last_comment 1)" "… comment heading names the nightly build"
echo "-- the report is about the version this run tried, by what checking it said (review round 3 #6)"
rf_repo; rf_jobs "publish development build=failure:Publish (pre-release), keep the latest 10"
RF_DEV_RC=1 RF_DEV_CHECK="INCOMPLETE client/v0.5.3-dev.640：没有这个发版" run_report "dev-release=failure"
B="$(body_of 1)"
has "失败在发布那一步" "$B" "publish step failed before its release existed (a complete older build is the newest) → says the publish step"
has "这次要发的 \`0.5.3-dev.640\` 没有完整发出" "$B" "… and that this version did not go out — never judged by the newest build"
has "没有这个发版" "$B" "… quoting the check"
lacks "已完整在发版页上" "$B" "… never 'it is out'"
rf_repo; rf_jobs "publish development build=failure:Publish (pre-release), keep the latest 10"
RF_DEV_RC=0 RF_DEV_CHECK="COMPLETE client/v0.5.3-dev.640：6 个文件都已上传完成" run_report "dev-release=failure"
B="$(body_of 1)"
has "这次要发的 \`0.5.3-dev.640\` 现在已完整在发版页上" "$B" "this version public complete, the clean-up failed → says it is out"
has "红的是发布之后的读回或旧版清理" "$B" "… and that what failed came after publishing"
has "不会重发" "$B" "… and that it will not be published again"
lacks "没有完整发出" "$B" "… not 'it did not go out'"
# review round 4 #6: the version is complete, but this run never reached the publish step (the plan
# could not read the list, so it built; the Mac build failed) — the two facts are said apart
rf_repo; rf_jobs "dmg (arm64)=failure:Build the app (Tauri), its update package, and the dmg"
RF_DEV_RC=0 RF_DEV_CHECK="COMPLETE client/v0.5.3-dev.640：6 个文件都已上传完成" run_report "package=failure size=skipped dev-release=skipped"
B="$(body_of 1)"
has "失败在发布之前（测试、打包或体积检查），发布那一步没有运行" "$B" "complete version, publish step not run → says this run failed before publishing"
has "现在已完整在发版页上" "$B" "… and that the version is complete now"
has "是之前的运行发出的，不是这次" "$B" "… put out by an earlier run, not this one"
lacks "红的是发布之后的读回或旧版清理" "$B" "… never 'what failed came after publishing'"
lacks "失败在发布那一步" "$B" "… nor 'failed in the publish step'"
rf_repo; rf_jobs "publish development build=failure:Publish (pre-release), keep the latest 10"
RF_DEV_RC=2 RF_DEV_CHECK="UNKNOWN 读不到发版列表：HTTP 502" run_report "dev-release=failure"
B="$(body_of 1)"
has "读不出这次要发的 \`0.5.3-dev.640\` 现在的状态" "$B" "check could not tell → says so"
has "node scripts/dev-release.mjs --check 0.5.3-dev.640" "$B" "… with the command for that very version"
for f in -arm64.dmg -arm64.app.tar.gz '-arm64.app.tar.gz` 及其 `.sig' -windows-x64.exe latest.json; do
    has "$f" "$B" "… names $f (review round 2 #6)"
done
has "大小为 0 的不算" "$B" "… and says a placeholder does not count"
has "标签要在发版记下的提交上" "$B" "… and that the tag must be on the recorded commit (review #13)"
lacks "已完整在发版页上" "$B" "… never 'it is out'"
lacks "没有完整发出" "$B" "… nor 'it did not go out'"
rf_repo; rf_jobs "client build mode=failure:Release or development build"
RF_DEV_V= RF_DEV_RC= RF_DEV_CHECK= run_report "mode=failure test=skipped package=skipped package-windows=skipped size=skipped dev-release=skipped"
has "没取到这次要发的版本号" "$(body_of 1)" "no version (the mode job failed) → says so, never 'the newest build'"
rf_repo; rf_jobs "client quick tests (Linux)=failure:Both quick-test jobs passed"
run_report "test=failure package=skipped package-windows=skipped size=skipped dev-release=skipped"
has "失败在发布之前" "$(body_of 1)" "failed before publishing → says so"
lacks "失败在发布那一步" "$(body_of 1)" "… not the publish-step sentence"
rf_repo; rf_jobs "Windows installer (x64)=failure:A real update of the installed app"
run_report "package-windows=failure size=skipped dev-release=skipped"
run_report "package=failure size=skipped dev-release=skipped"
RF_KIND=negative-controls run_report "shell=failure summary=failure"
check "a negative-controls failure next to it: its own new issue, nothing added here" "$(n_issues):$(n_comments 1)" "2:1"
RF_KIND=release run_report "gate=failure gate-summary=failure release=skipped"
check "a release failure next to it: its own new issue too" "$(n_issues):$(n_comments 1)" "3:1"
rf_repo; run_report "test=cancelled package=cancelled package-windows=cancelled size=skipped dev-release=skipped"
check "cancelled night: no call at all" "$(wc -l < "$RF/calls.log")" 0
rf_repo; run_report ""
check "a green night: nothing to report, no write" "$RC:$(n_issues):$(writes)" "0:0:0"
unset RF_KIND RF_DEV_V RF_DEV_RC RF_DEV_CHECK


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
