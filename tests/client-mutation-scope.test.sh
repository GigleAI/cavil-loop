#!/usr/bin/env bash
# client/scripts/mutation-scope.sh (GitHub#195): which client negative controls a CI run needs.
# None on a pull request; the ones related to the whole push on a push to main; every one on a
# client/v* tag; the manual switches as before. The start of a push that cannot be read is
# "cannot tell" → every one, never "nothing changed". Real script, real git repo.
#
#   bash tests/client-mutation-scope.test.sh
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$REPO_DIR/client/scripts/mutation-scope.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export GIT_CONFIG_GLOBAL="$TMP/gitconfig" GIT_CONFIG_NOSYSTEM=1
git config --global user.email test@example.invalid
git config --global user.name test

PASS=0; FAIL=0
check() { if [ "$2" = "$3" ]; then PASS=$((PASS + 1)); echo "  ok   $1"; else FAIL=$((FAIL + 1)); echo "  FAIL $1 (want [$3], got [$2])"; fi; }

R="$TMP/repo"
git init -q -b main "$R"
c() { echo "$1" >> "$R/f"; git -C "$R" add f; git -C "$R" commit -qm "$1"; git -C "$R" rev-parse HEAD; }
A=$(c one); B=$(c two); C=$(c three)
git -C "$R" checkout -q -b other "$A"; X=$(c elsewhere); git -C "$R" checkout -q main
git -C "$R" branch -q -D other     # X stays in the object store, but is not an ancestor of main

# scope <env…> → the script's stdout on one line, then " rc=N"
scope() {
    local out rc=0
    out=$(cd "$R" && env -i PATH="$PATH" GIT_CONFIG_GLOBAL="$GIT_CONFIG_GLOBAL" GIT_CONFIG_NOSYSTEM=1 "$@" bash "$SCRIPT" 2>/dev/null) || rc=$?
    printf '%s rc=%s' "$(printf '%s' "$out" | tr '\n' ' ')" "$rc"
}

echo "== pull requests run none"
check "pull_request" "$(scope EVENT=pull_request REF=refs/pull/7/merge)" "backend=none shell=none rc=0"
check "pull_request, even with a before sha" "$(scope EVENT=pull_request REF=refs/pull/7/merge BEFORE="$A")" "backend=none shell=none rc=0"

echo "== push to main: the whole push, before..after"
check "one commit" "$(scope EVENT=push REF=refs/heads/main BEFORE="$B")" "backend=changed shell=changed base=$B rc=0"
check "several commits: from the push's start" "$(scope EVENT=push REF=refs/heads/main BEFORE="$A")" "backend=changed shell=changed base=$A rc=0"

echo "== push to main, start unreadable → every one, not none"
check "new branch (all zeros)" "$(scope EVENT=push REF=refs/heads/main BEFORE=0000000000000000000000000000000000000000)" "backend=all shell=all rc=0"
check "force push (start not an ancestor)" "$(scope EVENT=push REF=refs/heads/main BEFORE="$X")" "backend=all shell=all rc=0"
check "a commit this checkout does not have" "$(scope EVENT=push REF=refs/heads/main BEFORE=1234567890abcdef1234567890abcdef12345678)" "backend=all shell=all rc=0"
check "empty" "$(scope EVENT=push REF=refs/heads/main BEFORE=)" "backend=all shell=all rc=0"
check "not a sha" "$(scope EVENT=push REF=refs/heads/main 'BEFORE=HEAD~1')" "backend=all shell=all rc=0"
check "before == HEAD (re-run of the same push)" "$(scope EVENT=push REF=refs/heads/main BEFORE="$C")" "backend=changed shell=changed base=$C rc=0"

echo "== client/v* tag: every one"
check "tag" "$(scope EVENT=push REF=refs/tags/client/v0.5.0 BEFORE=0000000000000000000000000000000000000000)" "backend=all shell=all rc=0"
check "another repo tag is not a client release" "$(scope EVENT=push REF=refs/tags/release/v2026.11.09.1)" "backend=none shell=none rc=0"
check "push to another branch" "$(scope EVENT=push REF=refs/heads/feature/x BEFORE="$B")" "backend=none shell=none rc=0"

echo "== manual run: the two switches, as before"
check "box not ticked" "$(scope EVENT=workflow_dispatch MANUAL= MANUAL_SCOPE=all)" "backend=none shell=none rc=0"
check "ticked, all" "$(scope EVENT=workflow_dispatch MANUAL=yes MANUAL_SCOPE=all)" "backend=all shell=all rc=0"
check "ticked, shell only" "$(scope EVENT=workflow_dispatch MANUAL=yes MANUAL_SCOPE=shell)" "backend=none shell=all rc=0"

# ── negative controls (MUTATION=1): each broken copy must fail at least one check above ──
# shellcheck source=lib/mutation.sh
source "$REPO_DIR/tests/lib/mutation.sh"
MUT_FAIL=0
run_all() {   # run the checks above against $SCRIPT, return the number of failures
    local saved_pass=$PASS saved_fail=$FAIL
    PASS=0; FAIL=0
    {
        check "pr" "$(scope EVENT=pull_request REF=refs/pull/7/merge BEFORE="$A")" "backend=none shell=none rc=0"
        check "main" "$(scope EVENT=push REF=refs/heads/main BEFORE="$A")" "backend=changed shell=changed base=$A rc=0"
        check "zeros" "$(scope EVENT=push REF=refs/heads/main BEFORE=0000000000000000000000000000000000000000)" "backend=all shell=all rc=0"
        check "force" "$(scope EVENT=push REF=refs/heads/main BEFORE="$X")" "backend=all shell=all rc=0"
        check "missing" "$(scope EVENT=push REF=refs/heads/main BEFORE=1234567890abcdef1234567890abcdef12345678)" "backend=all shell=all rc=0"
        check "tag" "$(scope EVENT=push REF=refs/tags/client/v0.5.0)" "backend=all shell=all rc=0"
        check "manual shell" "$(scope EVENT=workflow_dispatch MANUAL=yes MANUAL_SCOPE=shell)" "backend=none shell=all rc=0"
    } >/dev/null
    local f=$FAIL; PASS=$saved_pass; FAIL=$saved_fail
    return "$f"
}
mutant() {   # <name> <old> <new>: replace exactly one occurrence, the checks must go red
    local name="$1" old="$2" new="$3" m="$TMP/mut-$1.sh"
    mutation_gate || return 0
    if ! python3 - "$REPO_DIR/client/scripts/mutation-scope.sh" "$m" "$old" "$new" <<'PY'
import sys
src, dst, old, new = sys.argv[1:5]
t = open(src).read()
if t.count(old) != 1:
    sys.exit(1)
open(dst, "w").write(t.replace(old, new))
PY
    then echo "  ❌ 负对照 $name：找不到要改的原文（准备失败）"; MUT_FAIL=$((MUT_FAIL + 1)); return 0; fi
    local real="$SCRIPT"; SCRIPT="$m"
    if run_all; then echo "  ❌ 负对照 $name：检查仍全绿"; MUT_FAIL=$((MUT_FAIL + 1))
    else echo "  ✅ 负对照 $name：检查变红"; fi
    SCRIPT="$real"
}
mutant unreadable-is-none '                    echo "这次推送的起点读不到（[$b]），负对照全部跑" >&2
                    backend=all; shell=all' '                    echo x >&2'
mutant no-ancestor-check '                   && git merge-base --is-ancestor "$b" HEAD 2>/dev/null; then' '                   ; then'
mutant zeros-accepted '[[ ! "$b" =~ ^0+$ ]]' 'true'
mutant pr-runs-changed '    push)' '    push|pull_request)'
mutant tag-runs-none '            refs/tags/client/v*) backend=all; shell=all ;;' '            refs/tags/client/v*) ;;'
mutant manual-shell-runs-backend '[ "${MANUAL_SCOPE:-all}" = shell ] || backend=all' 'backend=all'
mutant base-not-printed '[ -z "$base" ] || echo "base=$base"' 'true'

echo
mutation_summary "$0"
echo "passed $PASS, failed $FAIL; 负对照失效 $MUT_FAIL"
[ "$FAIL" -eq 0 ] && [ "$MUT_FAIL" -eq 0 ]
