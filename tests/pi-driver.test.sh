#!/usr/bin/env bash
# kind: e2e
# Pi has a distinct stdin/session protocol; run its driver through real child processes and tmux.
set -euo pipefail
source "$(dirname "$0")/lib/report.sh"
source "$(dirname "$0")/lib/tmux-sandbox.sh"
if [ -z "${PI_TEST_CLEAN:-}" ]; then
    tmux_sandbox_env_i PI_TEST_CLEAN=1 HOME="$HOME" LANG=C.UTF-8 bash "$0"
    exit $?
fi
tmux_sandbox_start
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"
tmux_sandbox_own_dir "$T"
export HOME="$T/home" PATH="$T/bin:$PATH"
mkdir -p "$HOME" "$T/bin" "$T/state" "$T/project" "$T/wt"
git init -q "$T/project"
git -C "$T/project" -c user.name=test -c user.email=test@example.com commit -q --allow-empty -m init
git -C "$T/project" worktree add -q "$T/wt/issue-42"
WT="$T/wt/issue-42"
cat > "$T/config" <<CONF
REPO="example/pi"
PROJECT_ROOT="$T/project"
WORKTREE_BASE="$T/wt"
STATE_DIR="$T/state"
TMUX_PREFIX="pitest"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
WORKER_AGENT="pi"
REVIEW_WORKER_AGENT="pi"
SESSION_LOG_DIR=""
CONF
# The executable reads stdin, records argv and persists Pi's actual JSONL header shape.
cat > "$T/bin/pi" <<'PY'
#!/usr/bin/env python3
import json, os, pathlib, sys
args = sys.argv[1:]
def arg(name): return args[args.index(name)+1]
prompt = sys.stdin.read()
d = pathlib.Path(arg('--session-dir')); d.mkdir(parents=True, exist_ok=True)
sid = arg('--session-id'); f = d / (sid + '.jsonl')
if not f.exists():
    f.write_text(json.dumps(dict(type='session', version=3, id=sid, cwd=os.getcwd(), timestamp='2026-11-23T00:00:00Z'))+'\n')
with f.open('a') as stream:
    stream.write(json.dumps(dict(type='message', id='abcd', parentId=None, message=dict(role='user', content=[dict(type='text', text=prompt)])))+'\n')
pathlib.Path(os.environ['PI_TEST_OUT']).write_text(json.dumps(dict(argv=args, prompt=prompt, id=sid)))
PY
chmod +x "$T/bin/pi"
export PI_TEST_OUT="$T/out.json"
lib() {
    env CODING_AGENT_CONFIG="$T/config" ROOT="$ROOT" WT="$WT" T="$T" \
        bash -c 'source "$ROOT/scripts/_lib.sh"; eval "$1"' bash "$1"
}
pass=0; fail=0
check() {
    if "$@"; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: $*"; fi
}
# Plan in the parent shell, launch in a child: exercise persisted role ownership, not a hand-built ID.
run_role() {
    local role="$1"
    DISPATCH_PROMPT_KIND="$role" lib 'agent_session_plan 42 "$WT" "$T/prompt"; cmd=$(agent_launch_command "$WT" "example/pi#42" "$T/prompt"); cd "$WT"; bash -c "$cmd"'
}
printf '%s\n' 'first line "quotes" $HOME `literal`' '第二行' > "$T/prompt"
run_role new-issue
worker="$(jq -r .id "$T/out.json")"
check test -n "$worker"
check test "$(jq -r .prompt "$T/out.json")" = "$(cat "$T/prompt")"
run_role review
review="$(jq -r .id "$T/out.json")"
check test "$review" != "$worker"
run_role issue-comment
check test "$(jq -r .id "$T/out.json")" = "$worker"
run_role review
check test "$(jq -r .id "$T/out.json")" = "$review"
check lib 'agent_session_exists "$WT" "'"$worker"'"'
# Settings precedence, env overrides, cwd filtering, malformed and duplicate histories.
mkdir -p "$HOME/.pi/agent" "$WT/.pi"
printf '{"sessionDir":"global sessions"}\n' > "$HOME/.pi/agent/settings.json"
printf '{"sessionDir":"local sessions"}\n' > "$WT/.pi/settings.json"
check test "$(lib 'pi_history dir "$WT"')" = "$WT/local sessions"
check test "$(PI_CODING_AGENT_DIR="$T/other-agent" lib 'pi_history dir "$WT"')" = "$WT/local sessions"
check test "$(PI_CODING_AGENT_SESSION_DIR='env sessions' lib 'pi_history dir "$WT"')" = "$WT/env sessions"
printf 'broken' > "$WT/.pi/settings.json"
check bash -c '! "$@"' bash env CODING_AGENT_CONFIG="$T/config" ROOT="$ROOT" WT="$WT" bash -c 'source "$ROOT/scripts/_lib.sh"; pi_history dir "$WT"'
rm "$WT/.pi/settings.json" "$HOME/.pi/agent/settings.json"
dir="$(lib 'pi_history dir "$WT"')"
printf 'broken\n' > "$dir/broken.jsonl"
printf '{"type":"session","id":"other","cwd":"/other"}\n' > "$dir/other.jsonl"
check test "$(lib 'agent_session_list "$WT"' | wc -l | tr -d ' ')" = 2
cp "$dir/$worker.jsonl" "$dir/duplicate.jsonl"
check bash -c '! "$@"' bash env CODING_AGENT_CONFIG="$T/config" ROOT="$ROOT" WT="$WT" SID="$worker" bash -c 'source "$ROOT/scripts/_lib.sh"; agent_session_exists "$WT" "$SID"'
rm "$dir/duplicate.jsonl"
# Direct driver input exceeds execve's single-argument limit; no truncation or interpretation.
python3 -c 'print("中文 text\n" * 30000, end="last line")' > "$T/prompt"
cmd="$(lib 'WORKER_SESSION_ID="large"; WORKER_MODEL="provider/model:high"; agent_command_new "$WT" "name with quotes '\''" "$T/prompt"')"
(cd "$WT"; bash -c "$cmd")
check cmp "$T/prompt" <(jq -jr .prompt "$T/out.json")
check test "$(jq -r '.argv[.argv | index("--model") + 1]' "$T/out.json")" = provider/model:high
# A real live print-mode pane is busy; even 'thinking' scrollback in a dead pane is idle.
tmux new-session -d -s pi-test 'printf "thinking\n"; sleep 30'
check lib 'agent_is_busy pi-test'
tmux set-option -t pi-test @worker_agent pi
tmux set-option -t pi-test @worker_role worker
check test "$(lib 'stuck_sample pi-test; echo "$STUCK_S_STATE"')" = busy
check bash -c '! "$@"' bash env CODING_AGENT_CONFIG="$T/config" ROOT="$ROOT" bash -c 'source "$ROOT/scripts/_lib.sh"; agent_inject_prompt pi-test /unused'
check bash -c '! "$@"' bash tmux has-session -t pi-test
tmux new-session -d -s pi-dead 'sleep 1; echo thinking'
tmux set-option -w -t pi-dead remain-on-exit on
sleep 2
check bash -c '! "$@"' bash env CODING_AGENT_CONFIG="$T/config" ROOT="$ROOT" bash -c 'source "$ROOT/scripts/_lib.sh"; agent_is_busy pi-dead'
# Installation uses the same loader and finds the actual selected binary.
check env ROOT="$ROOT" T="$T" bash -c 'source "$ROOT/scripts/_names.sh"; source "$ROOT/scripts/_install.sh"; cavil_agent_deps "$ROOT" "$T/project" pi Linux; test "$CAVIL_AGENT_BIN" = pi'
mkdir -p "$T/project/.agents/skills/cavil-loop/drivers"
cat "$ROOT/scripts/drivers/pi.sh" > "$T/project/.agents/skills/cavil-loop/drivers/pi.sh"
printf '\nagent_bin() { echo cavil-test-absent-pi; }\n' >> "$T/project/.agents/skills/cavil-loop/drivers/pi.sh"
check env ROOT="$ROOT" T="$T" bash -c 'source "$ROOT/scripts/_names.sh"; source "$ROOT/scripts/_install.sh"; cavil_agent_deps "$ROOT" "$T/project" pi Linux; [[ " ${CAVIL_DEPS_MISSING[*]} " == *" cavil-test-absent-pi "* ]]'
report_counts "$pass" "$fail"
test "$fail" = 0
