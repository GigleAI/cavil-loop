#!/usr/bin/env bash
# Pi 1.6.0 print-mode driver. Its session/input protocol cannot live in another CLI's driver.
# Sourced by _lib.sh / setup.sh; preserve the caller's shell options, like the other drivers.
AGENT_SESSION_ISOLATION=1
AGENT_BUSY_WHILE_ALIVE=1

agent_bin() { echo pi; }
agent_session_new_id() { agent_session_new_uuid; }

# Resolve once and pass the same directory to Pi: history lookup and launch must agree.
# Only settings are read, never auth.json. --approve makes project settings applicable.
pi_history() {
    local out
    out="$(python3 - "$@" 2>&1 <<'PY'
import json, os, re, sys
from pathlib import Path
mode, cwd = sys.argv[1:3]
cwd = os.path.realpath(cwd)
def path(value):
    return Path(os.path.abspath(os.path.join(cwd, os.path.expanduser(value))))
try:
    agent = path(os.environ.get('PI_CODING_AGENT_DIR') or '~/.pi/agent')
    settings = {}
    for f in (agent / 'settings.json', Path(cwd) / '.pi/settings.json'):
        try:
            value = json.loads(f.read_text(encoding='utf-8-sig'))
        except FileNotFoundError:
            continue
        if not isinstance(value, dict):
            raise ValueError('invalid Pi settings object')
        settings.update(value)
    override = os.environ.get('PI_CODING_AGENT_SESSION_DIR') or settings.get('sessionDir')
    directory = path(override) if override else agent / 'sessions' / ('--' + re.sub(r'[/\\:]', '-', cwd.lstrip('/\\')) + '--')
    if mode == 'dir':
        print(directory)
        sys.exit(0)
    if not directory.exists():
        sys.exit(1 if mode == 'exists' else 0)
    sessions = []
    for f in directory.iterdir():
        if f.suffix != '.jsonl' or not f.is_file():
            continue
        try:
            with f.open(encoding='utf-8-sig') as stream:
                entries = [json.loads(line) for line in stream if line.strip()]
            if not all(isinstance(entry, dict) for entry in entries):
                continue
            header = entries[0]
            sid = header.get('id', '')
            if (header.get('type') == 'session' and header.get('cwd') == cwd
                    and isinstance(sid, str) and re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?', sid)):
                sessions.append((f.stat().st_mtime_ns, sid))
        except (ValueError, IndexError, AttributeError):
            continue  # malformed histories are never resumable
    counts = {}
    for _, sid in sessions:
        counts[sid] = counts.get(sid, 0) + 1
    ids = [sid for _, sid in sorted(sessions, reverse=True) if counts[sid] == 1]
    if mode == 'exists':
        sys.exit(0 if sys.argv[3] in ids else 1)
    for sid in ids:
        print(sid)
except (OSError, ValueError, TypeError) as exc:
    print('Pi history unavailable: ' + str(exc), file=sys.stderr)
    sys.exit(1)
PY
)" || {
        if [ -n "$out" ]; then
            if declare -F log >/dev/null; then log "$out"; else printf '%s\n' "$out" >&2; fi
        fi
        return 1
    }
    [ -z "$out" ] || printf '%s\n' "$out"
    return 0
}
agent_session_list() { pi_history list "$1"; }
agent_session_exists() { pi_history exists "$1" "$2"; }
agent_has_history() {
    local ids
    ids="$(agent_session_list "$1")" || return 1
    [ -n "$ids" ]
}

# Print mode has no idle input prompt. A live pane is running; old output proves nothing.
agent_is_busy() {
    local dead
    session_alive "$1" || return 1
    dead="$(tmux display-message -p -t "=$1:" '#{pane_dead}' 2>/dev/null)" || return 0
    [ "$dead" != 1 ]
}
agent_inject_prompt() {
    # Print mode cannot consume pasted input. Dispatch Case B resumes the registered role.
    tmux kill-session -t "$1" 2>/dev/null || true
    return 1
}

agent_command_new() {
    local dir id
    dir="$(pi_history dir "$1")" || return 1
    id="${WORKER_SESSION_ID:-}"
    [ -n "$id" ] || id="$(agent_session_new_uuid)"
    # stdin avoids argv limits and preserves literal multiline text, including leading '-'.
    printf 'pi --print --approve --session-dir %q --session-id %q --name %q %s < %q' \
        "$dir" "$id" "$2" "$(worker_model_arg)" "$3"
}
agent_command_resume() { agent_command_new "$@"; }
