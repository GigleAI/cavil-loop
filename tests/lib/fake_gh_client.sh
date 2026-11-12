#!/usr/bin/env bash
# Resident fake GitHub, client side (GitHub#211). One line in a test replaces the old
#     printf '#!/usr/bin/env bash\nexec python3 %q "$@"\n' "$FAKE" > "$SANDBOX/bin/gh"
# with
#     bash "$TEST_DIR/lib/fake_gh_client.sh" install "$SANDBOX/bin/gh" python3 "$FAKE"
#
# `install <gh path> <fallback command...>` starts tests/lib/fake_gh_server.py for the fake script in
# the fallback command (the last argument; a `-I` before it is kept) and writes <gh path>: a bash
# script that forwards each call to that server over 127.0.0.1 using only bash builtins — no fork —
# and otherwise runs the fallback command exactly as the old wrapper did. Server state (port, token,
# pid, log, "served" / "fallback" counters, one byte per call) lives in "<gh path>.d/".
#
# The forwarder runs the fallback command only when the call provably did not run:
#   · it cannot connect (no server yet, or it has exited since the previous call), or
#   · the server answered FALLBACK (it checks before running anything; see fake_gh_server.py).
# Every other outcome after the request went out — no ACK, or ACK but no exit status — fails with
# exit 70 and says so on stderr. It never re-runs: the call may already have written to the fake's
# state, and doing it twice would be a silent second comment / label instead of a red test.
#
# The server exits on its own once the installing process (the test, `--owner`, default $PPID) is gone
# or "<gh path>.d/" has been removed; `stop <gh path>` stops it at once.
#
# Test-only: FAKE_GH_SERVER_FAULT_FILE=<file> at install time passes `--fault-file` to the server
# (tests/fake-gh-server.test.sh). FAKE_GH_SERVER=0 at install time writes the old wrapper, no server.
set -euo pipefail

# The forwarder body. `install` copies it verbatim into the generated gh (declare -f), after
# FAKE_GH_STATE / FAKE_GH_FALLBACK are set.
fake_gh_forward() {
    local port token reply
    if { read -r port < "$FAKE_GH_STATE/port" && read -r token < "$FAKE_GH_STATE/token" \
         && exec 3<>"/dev/tcp/127.0.0.1/$port"; } 2>/dev/null; then
        # Sent from a subshell on purpose: `printf … >&3` in this shell would point this process's
        # own fd 1 at the socket for the length of the write, and the server — which reads
        # /proc/$$/fd/1 the moment the line arrives — then sometimes saw a socket instead of the
        # caller's pipe and answered FALLBACK (measured: 31 of 120 copies of fake-gh-server run 40 at
        # a time, every extra fallback logged fd 1 = socket). `$$` in the subshell is still this pid.
        ( printf '%s %s %s\n' "$token" "$$" "$#" ) >&3
        if ! IFS= read -r reply <&3; then
            echo "假 GitHub：请求已交出、执行结果未知，不重试（服务没有回复就断开了）" >&2
            exit 70
        fi
        case "$reply" in
            FALLBACK) exec 3>&- ;;
            ACK)
                if IFS= read -r reply <&3 && [[ "$reply" =~ ^EXIT\ ([0-9]+)$ ]]; then
                    exit "${BASH_REMATCH[1]}"
                fi
                echo "假 GitHub：请求已交出、执行结果未知，不重试（已接手，但没收到退出码）" >&2
                exit 70 ;;
            *)
                echo "假 GitHub：请求已交出、执行结果未知，不重试（无法识别的回复）" >&2
                exit 70 ;;
        esac
    fi
    # 退回旧方式的次数（只为看得见：服务端另有 served 计数）
    { printf 1 >> "$FAKE_GH_STATE/fallback"; } 2>/dev/null
    exec "${FAKE_GH_FALLBACK[@]}" "$@"
}

fake_gh_install() {
    local gh="$1"; shift
    [ $# -ge 1 ] || { echo "fake_gh_client.sh install: no fallback command" >&2; return 2; }
    local script="${!#}" isolated=() a
    for a in "$@"; do [ "$a" = -I ] && isolated=(--isolated); done
    local self; self="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    local state="$gh.d"
    rm -rf "$state"; mkdir -p "$state"; chmod 700 "$state"
    {
        printf '#!/usr/bin/env bash\n'
        printf '# Written by tests/lib/fake_gh_client.sh (GitHub#211): forwards to the resident fake GitHub.\n'
        printf 'FAKE_GH_STATE=%q\n' "$state"
        printf 'FAKE_GH_FALLBACK=('; printf ' %q' "$@"; printf ' )\n'
        if [ "${FAKE_GH_SERVER:-1}" = 0 ]; then
            printf 'exec "${FAKE_GH_FALLBACK[@]}" "$@"\n'
        else
            declare -f fake_gh_forward
            printf 'fake_gh_forward "$@"\n'
        fi
    } > "$gh"
    chmod +x "$gh"
    [ "${FAKE_GH_SERVER:-1}" = 0 ] && return 0
    # The server can only stand in for `python3 <script>` or `python3 -I <script>`: it is started the
    # same way, so its interpreter is set up like the original. Anything else: no server, every call
    # runs the fallback.
    case "$*" in
        "python3 $script"|"python3 -I $script") ;;
        *) echo "fake_gh_client.sh: no resident server for '$*' (only 'python3 [-I] <script>')" >&2; return 0 ;;
    esac
    local pyflags=(); [ ${#isolated[@]} -eq 0 ] || pyflags=(-I)
    (umask 077; { head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'; echo; } > "$state/token")
    local fault=()
    [ -n "${FAKE_GH_SERVER_FAULT_FILE:-}" ] && fault=(--fault-file "$FAKE_GH_SERVER_FAULT_FILE")
    python3 "${pyflags[@]}" "$self/fake_gh_server.py" --state "$state" --script "$script" --owner "${FAKE_GH_OWNER:-$PPID}" \
        "${isolated[@]}" "${fault[@]}" < /dev/null > "$state/server.log" 2>&1 &
    # Wait for the port file (the server writes it last, atomically). If it never comes the
    # forwarder simply cannot connect and runs the fallback — slower, never wrong.
    local i
    for i in $(seq 1 100); do
        [ -s "$state/port" ] && return 0
        kill -0 $! 2>/dev/null || break
        sleep 0.05
    done
    echo "fake_gh_client.sh: resident fake GitHub did not start; every call falls back ($(tail -n 3 "$state/server.log" 2>/dev/null | tr '\n' ' '))" >&2
    return 0
}

fake_gh_stop() {
    local state="$1.d" pid
    { read -r pid < "$state/pid"; } 2>/dev/null || return 0
    kill "$pid" 2>/dev/null || true
    rm -f "$state/port"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    cmd="${1:-}"; shift || true
    case "$cmd" in
        install) FAKE_GH_OWNER="${FAKE_GH_OWNER:-$PPID}" fake_gh_install "$@" ;;
        stop) fake_gh_stop "$@" ;;
        *) echo "usage: fake_gh_client.sh install <gh path> <fallback command...> | stop <gh path>" >&2; exit 2 ;;
    esac
fi
