#!/usr/bin/env bash
# Which negative controls a client CI run needs (GitHub#195: they run only when the app is
# packaged — a push to main and a client/v* tag — never on a pull request).
#
#   EVENT=<github.event_name> REF=<github.ref> BEFORE=<github.event.before> \
#   MANUAL=<non-empty when the manual "mutation" box is ticked> MANUAL_SCOPE=<all|shell> \
#       bash client/scripts/mutation-scope.sh
#
# Run inside the checkout (HEAD = the pushed commit). Prints, one per line:
#   backend=none|changed|all   the vitest / back-end set (test/mutation/run.sh)
#   shell=none|changed|all     the real-app set (test/tauri/mutations.sh)
#   base=<sha>                 only with "changed": where this push started (CLIENT_MUT_BASE)
#
# "changed" covers the whole push (before..after), so a push of several commits is checked as
# one. When the start of the push cannot be read — a new branch (all zeros), a force push (not an
# ancestor of HEAD), a commit this checkout does not have, anything else — that is "cannot tell",
# never "nothing changed": every negative control runs.
set -euo pipefail

backend=none; shell=none; base=""
case "${EVENT:-}" in
    push)
        case "${REF:-}" in
            refs/tags/client/v*) backend=all; shell=all ;;
            refs/heads/main)
                b="${BEFORE:-}"
                if [[ "$b" =~ ^[0-9a-f]{40}([0-9a-f]{24})?$ ]] && [[ ! "$b" =~ ^0+$ ]] \
                   && git rev-parse -q --verify "${b}^{commit}" >/dev/null 2>&1 \
                   && git merge-base --is-ancestor "$b" HEAD 2>/dev/null; then
                    backend=changed; shell=changed; base="$b"
                else
                    echo "这次推送的起点读不到（[$b]），负对照全部跑" >&2
                    backend=all; shell=all
                fi
                ;;
        esac
        ;;
    workflow_dispatch)
        if [ -n "${MANUAL:-}" ]; then
            shell=all
            [ "${MANUAL_SCOPE:-all}" = shell ] || backend=all
        fi
        ;;
esac
echo "backend=$backend"
echo "shell=$shell"
[ -z "$base" ] || echo "base=$base"
