#!/usr/bin/env bash
# kind: e2e
# GitHub 令牌脱敏（GitHub#342）：窗格历史、poll.log、agent 会话记录里不留令牌原文。
#
# 跑法：bash tests/token-redaction.test.sh        （约 1 分钟）
# 依赖：bash、python3、jq、tmux（3.0+）、git。
#
# 真跑：scripts/redact_tokens.py（子进程）、_lib.sh 的日志入口（log / 截屏 / 窗格历史管道 /
# 定期扫描）、cleanup-issue.sh（带一个真的清理钩子）、周报采集 collect.py、codex 用量驱动、
# redact-snapshots.sh。tmux 是真的，但开在**私有 socket** 上，绝不碰本机跑着 worker 的 server。
# HOME 指到临时目录，令牌全是当场拼出来的假值，不读本机真实会话。
#
# 这类错不会报错：日志照写、派工照跑，只是原文悄悄留在磁盘上，或者周报悄悄少算。所以每一组
# 都同时断言「原文不在了」和「该在的还在」（指纹出现了、记录数没变、普通长串没动）。
set -uo pipefail
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"

# 干净环境重跑自己：worker 会话里带着真 GH_TOKEN / TMUX，漏进来会让 tmux 连到外层 server
if [ -z "${REDACT_TEST_CLEAN_ENV:-}" ]; then
    exec env -i REDACT_TEST_CLEAN_ENV=1 HOME="$HOME" PATH="$PATH" LANG="${LANG:-C.UTF-8}" \
        TERM="${TERM:-dumb}" ${KEEP_SANDBOX:+KEEP_SANDBOX=1} bash "${BASH_SOURCE[0]}" "$@"
fi

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
PY="$REPO_DIR/scripts/redact_tokens.py"

if ! command -v tmux > /dev/null 2>&1; then
    echo "⏭ 本机没有 tmux，整份跳过"; exit 0
fi

TMP=$(mktemp -d); TMP="$(cd "$TMP" && pwd -P)"
TMUX_DIR=$(mktemp -d /tmp/rd.XXXX)       # socket 路径有长度上限，单独放一个短目录
export TMUX_TMPDIR="$TMUX_DIR"
SOCK="$TMUX_DIR/tmux-$(id -u)/default"
mkdir -p "$(dirname "$SOCK")"; chmod 700 "$(dirname "$SOCK")"
REAL_TMUX="$(command -v tmux)"
T() { timeout 10 "$REAL_TMUX" -S "$SOCK" "$@"; }
cleanup() {
    timeout 10 "$REAL_TMUX" -S "$SOCK" kill-server 2>/dev/null || true
    [ -n "${KEEP_SANDBOX:-}" ] && { echo "SANDBOX=$TMP"; return 0; }
    rm -rf "$TMP" "$TMUX_DIR"
}
trap cleanup EXIT

export HOME="$TMP/home"; mkdir -p "$HOME"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 TZ=UTC
unset TMUX GH_TOKEN WRITE_GH_TOKEN GITHUB_TOKEN CODING_AGENT_RELEASE_ROOT

pass=0; fail=0
ok()  { echo "  ✅ $1"; pass=$((pass+1)); }
bad() { echo "  ❌ $1"; fail=$((fail+1)); }
chk() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1（期望 [$3]，实得 [$2]）"; fi; }

# ── 假令牌：当场拼，不在文件里写成一整串 ──
rep() { printf "%${2}s" '' | tr ' ' "$1"; }
TP="ghp_$(rep a 20)$(rep 7 16)"                 # 40 字符，最常见的那种
TO="gho_$(rep B 36)"
TU="ghu_$(rep c 30)$(rep 2 10)"
TS="ghs_$(rep D 40)"
TR="ghr_$(rep e 50)"
TPAT="github_pat_11$(rep F 20)_$(rep g 59)"     # 11 + 82
ALL=("$TP" "$TO" "$TU" "$TS" "$TR" "$TPAT")
fp() { printf '%s' "$1" | python3 -c 'import hashlib,sys; print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest()[:12])'; }
# 期望的替换结果：REDACTED-<指纹> + 补到原长度的 -
want() { local f; f="REDACTED-$(fp "$1")"; printf '%s%s' "$f" "$(rep - $(( ${#1} - ${#f} )))"; }
has()  { grep -qF -- "$2" "$1" 2>/dev/null; }
# 文件里一个原文都没有
no_raw() {   # <文件>...
    local f t
    for f in "$@"; do for t in "${ALL[@]}"; do has "$f" "$t" && return 1; done; done
    return 0
}

# ── 被测项目：最小配置，状态目录 / worktree 都在沙箱里 ──
mkdir -p "$TMP/state" "$TMP/wt" "$TMP/project" "$TMP/bin"
CONF="$TMP/cavil-loop.config"
cat > "$CONF" <<CONF
REPO="example/rd"
PROJECT_ROOT="$TMP/project"
WORKTREE_BASE="$TMP/wt"
STATE_DIR="$TMP/state"
TMUX_PREFIX="rdtest"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
LABEL_PENDING_PR="pending/PR"
LABEL_AGENT_DOING="doing/agent"
LABEL_DONE="Done"
WORKER_SECRET_ENV=""
PATH="$TMP/bin:\$PATH"
GH_TOKEN="fake-token-for-test"
CONF
printf '#!/usr/bin/env bash\nexit 0\n' > "$TMP/bin/gh"; printf '#!/usr/bin/env bash\nexit 0\n' > "$TMP/bin/claude"
chmod +x "$TMP/bin/gh" "$TMP/bin/claude"
LOG="$TMP/state/poll.log"; PANES="$TMP/state/sessions"
ROOT="$REPO_DIR"
# 在加载了真实 _lib.sh 的 shell 里跑一段代码（参数经环境变量传，不拼进代码）
lib() { env CODING_AGENT_CONFIG="$CONF" "${LIB_ENV[@]:-_=_}" bash -c 'source "$0/scripts/_lib.sh" || exit 97; eval "$1"' "$ROOT" "$1"; }
LIB_ENV=()
scan() { rm -f "$TMP/state/redact-scan.stamp"; lib 'redact_scan_tick'; }
wait_for() {   # <秒> <命令...>
    local i n=$(( $1 * 10 )); shift
    for ((i = 0; i < n; i++)); do "$@" && return 0; sleep 0.1; done
    return 1
}

echo "【1】替换规则：每种前缀都认，结果等长、带指纹"
for t in "${ALL[@]}"; do
    out="$(printf 'x=%s;\n' "$t" | python3 "$PY" filter)"
    chk "${t%%_*}_… 换成 REDACTED-<指纹>，长度不变" "$out" "x=$(want "$t");"
done
chk "同一把令牌出现两次，指纹相同" \
    "$(printf '%s %s\n' "$TP" "$TP" | python3 "$PY" filter | tr ' ' '\n' | sort -u | wc -l | tr -d ' ')" "1"
chk "换行符转义后面的令牌（JSON 里的 \\n）也认" \
    "$(printf '"a\\\\n%s\\\\nb"' "$TP" | python3 "$PY" filter)" "$(printf '"a\\\\n%s\\\\nb"' "$(want "$TP")")"
chk "颜色控制码后面的令牌也认" \
    "$(printf '\033[32m%s\033[0m' "$TP" | python3 "$PY" filter | tr -d '\033')" "[32m$(want "$TP")[0m"

echo "【2】不误伤：提交哈希、uuid、sha256、短串、超长串、夹在更长标识符里的"
SAFE="$TMP/safe.txt"
{
    echo "commit 3f1c0a9d2b7e4f60813a5c9e7d2b4a6f8c0e1d3b"
    echo "uuid 4d9e5509-1591-493b-80b9-7d93e3f5344a"
    echo "sha256 $(rep 9 64)"
    echo "ghp 不带下划线 ghp$(rep a 40)"
    echo "太短 ghp_$(rep a 35) github_pat_$(rep a 81)"
    echo "太长 ghp_$(rep a 252) github_pat_$(rep a 245)"
    echo "夹在标识符里 my_ghp_$(rep a 36) xghs_$(rep a 36)"
    echo "已经替换过的 $(want "$TP")"
} > "$SAFE"
cp "$SAFE" "$TMP/safe.orig"
python3 "$PY" filter < "$SAFE" > "$TMP/safe.out"
chk "数据流过滤：逐字节不变" "$(cmp -s "$TMP/safe.out" "$TMP/safe.orig" && echo same)" "same"
python3 "$PY" files "$SAFE" > "$TMP/safe.sum"
chk "文件原地扫描：逐字节不变，报 0 处替换" \
    "$(cmp -s "$SAFE" "$TMP/safe.orig" && echo same)|$(grep -o 'replaced=[0-9]*' "$TMP/safe.sum")" "same|replaced=0"

echo "【3】拆段：怎么切都和一次送完一样；普通输出不被压着"
cat > "$TMP/split.py" <<'PYEOF'
import subprocess, sys, time, os, select
py, tp, tpat = sys.argv[1], sys.argv[2].encode(), sys.argv[3].encode()
data = b"a " + tp + b"\n\\n" + tpat + b'" g gh ghp githu \x1b[1m' + tp + b" x" + tp + b"y_ end " + tp
def run(parts):
    p = subprocess.Popen([sys.executable, py, "filter"], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    for i, part in enumerate(parts):
        if i: time.sleep(0.01)
        p.stdin.write(part); p.stdin.flush()
    p.stdin.close()
    out = p.stdout.read(); p.wait()
    return out
whole = run([data])
bad = [c for c in range(1, len(data)) if run([data[:c], data[c:]]) != whole]
three = run([data[:1], data[1:3], data[3:]]) == whole
print("cuts=%d bad=%d three=%s raw=%d" % (len(data) - 1, len(bad), three, whole.count(tp)))
# 普通输出立刻出来；可能是令牌开头的尾巴先压着，输入关闭后原样放行
p = subprocess.Popen([sys.executable, py, "filter"], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
p.stdin.write(b"hello\n"); p.stdin.flush()
r, _, _ = select.select([p.stdout], [], [], 5)
first = os.read(p.stdout.fileno(), 100) if r else b"<nothing>"
p.stdin.write(b"x gh"); p.stdin.flush()
r, _, _ = select.select([p.stdout], [], [], 5)
second = os.read(p.stdout.fileno(), 100) if r else b"<nothing>"
p.stdin.close()
rest = p.stdout.read(); p.wait()
print("first=%r second=%r rest=%r" % (first, second, rest))
PYEOF
python3 "$TMP/split.py" "$PY" "$TP" "$TPAT" > "$TMP/split.out" 2>&1
# 那份输入里有一处 x<令牌>y_：左边紧挨字母，不算令牌，原样保留（raw=1 就是它）
chk "每个切点切成两段（含切在前缀中间）结果都相同" "$(sed -n 1p "$TMP/split.out" | sed 's/cuts=[0-9]* //')" "bad=0 three=True raw=1"
chk "真的试了每个切点" "$(sed -n 1p "$TMP/split.out" | grep -oE 'cuts=[0-9]+' | cut -d= -f2 | awk '{print ($1 > 250) ? "yes" : "no"}')" "yes"
chk "普通输出送进去就能读到；半截前缀先压着，输入结束后原样放行" \
    "$(sed -n 2p "$TMP/split.out")" "first=b'hello\\n' second=b'x ' rest=b'gh'"

echo "【4】daemon 的日志入口：log()"
lib 'log "调试输出 token='"$TP"' 以及 '"$TPAT"'"'
chk "poll.log 里没有原文、有指纹" "$(no_raw "$LOG" && echo clean)|$(has "$LOG" "$(want "$TP")" && echo fp)|$(has "$LOG" "$(want "$TPAT")" && echo fp2)" "clean|fp|fp2"
lib 'log "普通一行 commit 3f1c0a9d2b7e4f60813a5c9e7d2b4a6f8c0e1d3b"'
chk "普通日志行照常写入" "$(grep -c '普通一行 commit 3f1c0a9d2b7e4f60813a5c9e7d2b4a6f8c0e1d3b$' "$LOG")" "1"

echo "【5】清理钩子的输出和报错（真跑 cleanup-issue.sh）"
cat > "$TMP/project/hook.sh" <<HOOK
#!/usr/bin/env bash
echo "hook 正常输出 \$ISSUE token=$TO"
echo "hook 报错 Authorization: token $TU" >&2
exit 3
HOOK
echo 'CLEANUP_HOOK="hook.sh"' >> "$CONF"
env CODING_AGENT_CONFIG="$CONF" timeout 60 bash "$ROOT/scripts/cleanup-issue.sh" 986342 > "$TMP/cleanup.out" 2>&1
chk "钩子真的跑了、两行都进了 poll.log" "$(grep -c '\[hook\] hook' "$LOG")" "2"
chk "poll.log 和脚本自己的输出里都没有原文" "$(no_raw "$LOG" "$TMP/cleanup.out" && echo clean)" "clean"
chk "两把令牌的指纹都在" "$(has "$LOG" "$(want "$TO")" && echo o)$(has "$LOG" "$(want "$TU")" && echo u)" "ou"
chk "钩子非零退出照旧被记下来" "$(grep -c 'hook 非零退出' "$LOG")" "1"

echo "【6】真 tmux：秒退截屏、信任框截屏、设置会话属性的报错"
T new-session -d -s rdtest-issue1 -x 200 -y 50 "sh -c 'echo 启动失败 token=$TS; exit 1'" \; set-option -w remain-on-exit on
lib 'start_session_logging rdtest-issue1; verify_fresh_session rdtest-issue1 1 && echo "rc=0" || echo "rc=1"' > "$TMP/v.out" 2>&1
chk "秒退被认出来" "$(grep -c '^rc=1$' "$TMP/v.out")" "1"
chk "截屏进了窗格历史和 poll.log，两处都没有原文、都有指纹" \
    "$(no_raw "$PANES/rdtest-issue1.log" "$LOG" "$TMP/v.out" && echo clean)|$(has "$PANES/rdtest-issue1.log" "$(want "$TS")" && echo pane)|$(has "$LOG" "$(want "$TS")" && echo poll)" "clean|pane|poll"

T new-session -d -s rdtest-issue2 -x 200 -y 50 "sh -c 'echo TRUSTBOX token=$TR; sleep 60'"
lib 'AGENT_TRUST_PROMPT_FOOTER_RE=x; AGENT_TRUST_PROMPT_WAIT_SECS=3
     agent_trust_prompt_on_screen() { grep -q TRUSTBOX; }
     agent_trust_prompt_blocked rdtest-issue2 "'"$TMP"'" && echo "rc=0" || echo "rc=1"' > "$TMP/t.out" 2>&1
chk "信任框被认出来（走到了截屏那一步）" "$(grep -c '^rc=0$' "$TMP/t.out")" "1"
chk "截屏进了窗格历史：没有原文、有指纹" \
    "$(no_raw "$PANES/rdtest-issue2.log" && echo clean)|$(has "$PANES/rdtest-issue2.log" "$(want "$TR")" && echo fp)" "clean|fp"

# tmux 自己报错时带出了令牌（例：会话标题里有令牌、设置失败时原样回显）
cat > "$TMP/bin/tmux" <<W
#!/usr/bin/env bash
if [ -n "\${FAKE_TMUX_SETOPT_FAIL:-}" ] && [ "\$1" = set-option ]; then
    echo "bad option value: $TP" >&2; exit 1
fi
if [ -n "\${FAKE_TMUX_LIST_FAIL:-}" ] && [ "\$1" = list-sessions ]; then
    echo "lost server" >&2; exit 1
fi
exec "$REAL_TMUX" "\$@"
W
chmod +x "$TMP/bin/tmux"
T new-session -d -s rdtest-issue3 -x 200 -y 50 "sleep 60"
: > "$LOG"
LIB_ENV=(FAKE_TMUX_SETOPT_FAIL=1)
lib 'WORKER_MODEL=m; WORKER_SESSION_ROLE=worker; configure_tmux_session_display rdtest-issue3 "标题"' > "$TMP/c.out" 2>&1
LIB_ENV=()
chk "tmux 的报错进了 poll.log（至少一行）" "$(grep -c '\[tmux\]' "$LOG" | awk '{print ($1 >= 1) ? "yes" : "no"}')" "yes"
chk "没有原文、有指纹" "$(no_raw "$LOG" "$TMP/c.out" && echo clean)|$(has "$LOG" "$(want "$TP")" && echo fp)" "clean|fp"

echo "【7】真 tmux：窗格历史实时写入"
T new-session -d -s rdtest-issue4 -x 250 -y 50 \
    "sh -c 'sleep 1; echo 第一行 $TP; printf \"分两次写 ${TPAT%????????????????????}\"; sleep 1; echo \"${TPAT#${TPAT%????????????????????}} 完\"; echo 普通行; sleep 60'"
lib 'start_session_logging rdtest-issue4'
P4="$PANES/rdtest-issue4.log"
wait_for 10 has "$P4" "普通行"
chk "窗格输出进了历史文件" "$(has "$P4" "第一行" && has "$P4" "普通行" && echo yes)" "yes"
chk "没有原文；两把令牌（其中一把分两次写出）的指纹都在" \
    "$(no_raw "$P4" && echo clean)|$(has "$P4" "$(want "$TP")" && echo a)$(has "$P4" "$(want "$TPAT")" && echo b)" "clean|ab"
chk "会话上记了「已换成过滤版」的标记" "$(T show-options -qv -t '=rdtest-issue4:' @redact_pipe)" "1"
lib 'start_session_logging rdtest-issue4'
T send-keys -t rdtest-issue4 "" ""
chk "再调一次不会把日志管道关掉" "$(T list-panes -t '=rdtest-issue4:' -F '#{pane_pipe}')" "1"

echo "【8】升级前用 cat 挂着日志的活会话：定期扫描时换成过滤版，换之前落盘的原文被替换"
T new-session -d -s rdtest-issue5 -x 200 -y 50 "sh -c 'sleep 1; echo 旧写法 $TO; sleep 4; echo 换了以后 $TU; sleep 60'"
P5="$PANES/rdtest-issue5.log"
T pipe-pane -t rdtest-issue5 "cat >> '$P5'"
wait_for 5 has "$P5" "$TO"
chk "前提：旧写法确实把原文写进了文件" "$(has "$P5" "$TO" && echo raw)" "raw"
# 认不出 worker 窗格的会话（两个窗格、没有记录）：不换
T new-session -d -s rdtest-issue6 -x 200 -y 50 "sleep 60"
T split-window -t rdtest-issue6 "sleep 60"
T pipe-pane -t rdtest-issue6 "cat >> '$PANES/rdtest-issue6.log'"
# 别的项目的会话，前缀恰好以本项目的前缀开头：不是本项目的，不能碰
T new-session -d -s rdtest-web-issue5 -x 200 -y 50 "sleep 60"
T pipe-pane -t rdtest-web-issue5 "cat >> '$TMP/foreign.log'"
scan 2> "$TMP/scan8.err"
chk "别的项目的会话（前缀相近）没有被碰，日志也没被引到本项目来" \
    "$(T show-options -qv -t '=rdtest-web-issue5:' @redact_pipe)|$([ -e "$PANES/rdtest-web-issue5.log" ] && echo leaked || echo none)" "|none"
chk "认得出窗格的会话换上了过滤版" "$(T show-options -qv -t '=rdtest-issue5:' @redact_pipe)" "1"
chk "认不出窗格的会话没有被碰" "$(T show-options -qv -t '=rdtest-issue6:' @redact_pipe)" ""
wait_for 10 has "$P5" "换了以后"
chk "换之前落盘的原文已被替换，换之后的输出没有原文" \
    "$(no_raw "$P5" && echo clean)|$(has "$P5" "$(want "$TO")" && echo old)$(has "$P5" "$(want "$TU")" && echo new)" "clean|oldnew"
chk "扫描在 poll.log 里留了一行说明" "$(grep -c '令牌脱敏：.*替换了' "$LOG" | awk '{print ($1 >= 1) ? "yes" : "no"}')" "yes"

echo "【9】已经写完的窗格历史：最后一段没有结束字符也处理；读不到 tmux 时不当作写完"
P9="$PANES/rdtest-issue90.log"
printf '旧会话的输出\n最后一行没有换行 %s' "$TP" > "$P9"
LIB_ENV=(FAKE_TMUX_LIST_FAIL=1)
scan 2>/dev/null
LIB_ENV=()
chk "tmux 读不出：文件末尾那段先不动" "$(has "$P9" "$TP" && echo raw)" "raw"
# 还活着的会话：文件末尾停在半截令牌上（后面还会接着写），过几轮扫描也不动
T new-session -d -s rdtest-issue91 -x 200 -y 50 "sleep 60"
P91="$PANES/rdtest-issue91.log"
printf '活会话的输出 %s' "${TP%??????????}" > "$P91"
scan 2>/dev/null; scan 2>/dev/null
chk "tmux 读得出、会话已不在：末尾的令牌被替换" "$(no_raw "$P9" && echo clean)|$(has "$P9" "$(want "$TP")" && echo fp)" "clean|fp"
chk "活会话的半截令牌扫两轮都不动" "$(cat "$P91")" "活会话的输出 ${TP%??????????}"
printf '%s 接上了\n' "${TP#${TP%??????????}}" >> "$P91"
scan 2>/dev/null
chk "后半截写进来以后整串被替换，指纹和一次写入时相同" "$(cat "$P91")" "活会话的输出 $(want "$TP") 接上了"

echo "【10】替换脚本坏掉时：每个入口都不写原文"
BROKEN="$TMP/broken"; mkdir -p "$BROKEN"
cp -R "$REPO_DIR/scripts" "$BROKEN/scripts"; cp -R "$REPO_DIR/prompts" "$BROKEN/prompts" 2>/dev/null
for mode in "import sys; sys.exit(3)" "import sys, os; os.write(1, b'partial '); sys.exit(4)"; do
    echo "$mode" > "$BROKEN/scripts/redact_tokens.py"
    : > "$LOG"; rm -f "$PANES"/rdtest-issue7*.log
    ROOT="$BROKEN"
    lib 'log "坏脚本 token='"$TP"'"' 2> "$TMP/b.err"
    env CODING_AGENT_CONFIG="$CONF" timeout 60 bash "$BROKEN/scripts/cleanup-issue.sh" 986342 > "$TMP/b.cleanup" 2>&1
    T new-session -d -s rdtest-issue7 -x 200 -y 50 "sh -c 'sleep 1; echo 实时 $TS; sleep 2'"
    lib 'start_session_logging rdtest-issue7' 2>/dev/null
    sleep 2.5
    printf '%s\n' "旧日志 $TR" > "$TMP/old.log"
    ( source "$BROKEN/scripts/_redact.sh"; redact_stream < "$TMP/old.log" > "$TMP/b.stream" )
    ROOT="$REPO_DIR"
    T kill-session -t rdtest-issue7 2>/dev/null
    chk "坏法「${mode:0:28}…」：poll.log / 标准错误 / 钩子输出 / 窗格历史 / 整文件并入 都没有原文" \
        "$(no_raw "$LOG" "$TMP/b.err" "$TMP/b.cleanup" "$PANES/rdtest-issue7.log" "$TMP/b.stream" && echo clean)" "clean"
    chk "　日志里写明了替换失败（log 一行 + 钩子一段）" "$(grep -c '令牌替换失败' "$LOG")" "2"
    chk "　整文件并入也留了说明" "$(grep -c '令牌替换失败' "$TMP/b.stream")" "1"
done

echo "【11】agent 会话记录：原地替换，周报采集前后一致（真跑 collect.py）"
W=2025-01-06
export CLAUDE_PROJECTS_DIR="$HOME/.claude/projects" XDG_CACHE_HOME="$TMP/cache"
CENC="$(printf '%s' "$TMP/wt/issue-7" | tr / -)"      # 本仓库的读取方按这个写法找目录
CJ="$CLAUDE_PROJECTS_DIR/$CENC/s.jsonl"; mkdir -p "$(dirname "$CJ")"
ccall() {   # <HH:MM 北京时间> <out token> <请求编号>
    printf '{"type":"assistant","cwd":"%s","sessionId":"s1","timestamp":"%sT%s:00Z","requestId":"%s","message":{"model":"claude-opus-5","usage":{"input_tokens":0,"output_tokens":%s,"cache_read_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0}}}}\n' \
        "$TMP/wt/issue-7" "$W" "$(date -u -d "$W $1 +0800" +%H:%M)" "$3" "$2"
}
ctool() {   # 一条工具输出记录，内容里带令牌（env 的输出、gh 的报错）
    printf '{"type":"user","cwd":"%s","sessionId":"s1","timestamp":"%sT02:00:00Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"PATH=/usr/bin\\nGH_TOKEN=%s\\nHOME=/x\\n%s\\n> Authorization: token %s"}]}}\n' \
        "$TMP/wt/issue-7" "$W" "$1" "$2" "$3"
}
{ ccall 10:05 1000 req_a; ctool "$TP" "$TPAT" "$TO"; ccall 10:10 2000 req_b; ctool "$TU" "$TS" "$TR"; ccall 10:20 4000 req_c; } > "$CJ"
# 别的项目的会话（工作目录不在本项目下）：不能碰
OENC="$(printf '%s' "$TMP/wt-other/issue-7" | tr / -)"
OJ="$CLAUDE_PROJECTS_DIR/$OENC/s.jsonl"; mkdir -p "$(dirname "$OJ")"
printf '{"type":"user","cwd":"%s","message":{"content":"GH_TOKEN=%s"}}\n' "$TMP/wt-other/issue-7" "$TP" > "$OJ"
cp "$OJ" "$TMP/other.orig"

cat > "$TMP/issues.json" <<'JSON'
[ {"number":10,"title":"承载记账的 issue","state":"open","labels":[],"created_at":"2024-12-01T02:00:00Z","closed_at":null} ]
JSON
echo "[]" > "$TMP/pulls.json"
printf '[{"id":1,"issue_url":"https://api.github.com/repos/acme/widget/issues/10","user":{"login":"acme-bot"},"created_at":"%sT03:30:00Z","body":%s}]' "$W" \
    "$(printf '干完了。\n\n<!-- agent-metrics agent=claude wt=7 start=%sT10:00:00+08:00 end=%sT11:00:00+08:00 wall_secs=600 in=0 out=7000 cache_r=0 cache_w=0 cost_usd=0.18 cost_state=full cost_unknown_tokens=0 -->' "$W" "$W" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')" > "$TMP/comments.json"
mkdir -p "$TMP/ghbin"
cat > "$TMP/ghbin/gh" <<SHIM
#!/usr/bin/env bash
for a in "\$@"; do
  case "\$a" in
    *"/issues/comments"*) cat "$TMP/comments.json"; exit 0 ;;
    *"/pulls?"*)          cat "$TMP/pulls.json";    exit 0 ;;
    *"/issues?"*)         cat "$TMP/issues.json";   exit 0 ;;
  esac
done
echo "[]"
SHIM
chmod +x "$TMP/ghbin/gh"
collect() {   # <输出文件>
    rm -rf "$XDG_CACHE_HOME"
    ( cd "$TMP" && PATH="$TMP/ghbin:$PATH" python3 "$REPO_DIR/scripts/weekly-report/collect.py" --repo acme/widget \
        --out "$1" --weeks 2 --week-of "$W" --worktree-base "$TMP/wt" --session-prefix issue ) > "$TMP/collect.log" 2>&1 \
        || { echo "collect.py 跑挂了："; tail -5 "$TMP/collect.log"; }
    # 采集时间戳不是数据
    python3 - "$1" <<'PYEOF'
import json, sys
d = json.load(open(sys.argv[1]))
for k in ("generated_at", "collected_at"):
    d.pop(k, None)
json.dump(d, open(sys.argv[1], "w"), sort_keys=True, ensure_ascii=False, indent=1)
PYEOF
}
lines_ok() { python3 -c 'import json,sys; [json.loads(l) for l in open(sys.argv[1])]; print("ok")' "$1" 2>/dev/null; }
collect "$TMP/before.json"
# 前提：采集的结果确实取决于这份会话文件——把它挪走再采一次，结果必须不同
mv "$CJ" "$CJ.away"; collect "$TMP/nolog.json"; mv "$CJ.away" "$CJ"
chk "前提：采集真的读了这份会话（没有它时结果不同）" "$(cmp -s "$TMP/before.json" "$TMP/nolog.json" && echo same || echo differs)" "differs"
SIZE_BEFORE=$(wc -c < "$CJ"); INO_BEFORE=$(stat -c %i "$CJ")

# 替换写到一半时停住，这时跑真实采集
( LIB_ENV=(CAVIL_REDACT_TEST_PAUSE="$TMP/pause"); scan 2> "$TMP/scan11.err" ) &
SCAN_PID=$!
wait_for 20 test -e "$TMP/pause.reached"
chk "替换真的停在了一半（同步点到了）" "$([ -e "$TMP/pause.reached" ] && [ ! -e "$TMP/pause.done" ] && echo paused)" "paused"
cp "$CJ" "$TMP/half.jsonl"
collect "$TMP/during.json"
chk "停在一半时：每行仍能按 JSON 解析" "$(lines_ok "$TMP/half.jsonl")" "ok"
chk "停在一半时跑采集：结果和替换前逐字节相同" "$(cmp -s "$TMP/before.json" "$TMP/during.json" && echo same)" "same"
# 同时另一个进程往文件末尾追加（CLI 续写）
ccall 10:30 8000 req_d >> "$CJ"
touch "$TMP/pause.go"; wait "$SCAN_PID"
chk "扫描期间追加的那一行还在、没被截掉" "$(grep -c '"requestId":"req_d"' "$CJ")" "1"
chk "文件没被改名替换（同一个文件）、原有部分长度不变" \
    "$(stat -c %i "$CJ")|$(head -c "$SIZE_BEFORE" "$CJ" | wc -c | tr -d ' ')|$(sed -n 1,5p "$CJ" | wc -c | tr -d ' ')" "$INO_BEFORE|$SIZE_BEFORE|$SIZE_BEFORE"
chk "六把令牌都没有原文了、指纹都在" \
    "$(no_raw "$CJ" && echo clean)|$(n=0; for t in "${ALL[@]}"; do has "$CJ" "$(want "$t")" && n=$((n+1)); done; echo "$n")" "clean|6"
chk "每行仍能按 JSON 解析" "$(lines_ok "$CJ")" "ok"
# 追加的那条调用落在同一次派工里，采集会多算它：把它去掉再比「替换前后」
grep -v '"requestId":"req_d"' "$CJ" > "$TMP/cj.tmp" && cat "$TMP/cj.tmp" > "$CJ"
collect "$TMP/after.json"
chk "替换后跑采集：结果和替换前逐字节相同" "$(cmp -s "$TMP/before.json" "$TMP/after.json" && echo same)" "same"
chk "别的项目的会话一个字节没动" "$(cmp -s "$OJ" "$TMP/other.orig" && echo same)" "same"
cp "$CJ" "$TMP/cj.once"
scan 2>/dev/null
chk "再扫一遍：字节不变" "$(cmp -s "$CJ" "$TMP/cj.once" && echo same)" "same"
# 没写完的最后一行（没有换行）先不动，写完再处理
printf '{"type":"user","cwd":"%s","message":{"content":"半行 %s' "$TMP/wt/issue-7" "$TP" >> "$CJ"
scan 2>/dev/null
chk "没写完的最后一行先不动" "$(tail -c 60 "$CJ" | grep -c "${TP: -20}")" "1"
printf ' 写完了"}}\n' >> "$CJ"
scan 2>/dev/null
chk "这一行写完以后被替换" "$(no_raw "$CJ" && echo clean)|$(lines_ok "$CJ")" "clean|ok"

echo "【12】codex 会话记录：认领用的字段里有长得像令牌的串时不改，用量不变（真跑用量驱动）"
# 工作目录本身就带着一段令牌样式（人给目录起的名字）：改了它，周报 / 用量驱动就认领不到这份记录
ODD="$TMP/wt/issue-8-$TP"; mkdir -p "$ODD" "$HOME/.codex/sessions/2026/09/14"
START=$(( $(date +%s) - 3600 ))
ts() { date -u -d "@$(( START + $1 ))" '+%Y-%m-%dT%H:%M:%S.000Z'; }
CX="$HOME/.codex/sessions/2026/09/14/rollout-2026-09-14T00-00-00-4d9e5509-1591-493b-80b9-7d93e3f5344a.jsonl"
{
    printf '{"type":"session_meta","timestamp":"%s","payload":{"cwd":"%s"}}\n' "$(ts -200)" "$ODD"
    printf '{"type":"turn_context","timestamp":"%s","payload":{"cwd":"%s","model":"gpt-test"}}\n' "$(ts -199)" "$ODD"
    printf '{"type":"token_usage_record","timestamp":"%s","payload":{"usage":{"input_tokens":1000,"cached_input_tokens":400,"cache_write_input_tokens":0,"output_tokens":300,"reasoning_output_tokens":100,"total_tokens":1300}}}\n' "$(ts 10)"
    printf '{"type":"response_item","timestamp":"%s","payload":{"type":"function_call_output","output":"cd %s\\nGH_TOKEN=%s\\n"}}\n' "$(ts 11)" "$ODD" "$TO"
    printf '{"type":"token_usage_record","timestamp":"%s","payload":{"usage":{"input_tokens":2000,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":700,"reasoning_output_tokens":0,"total_tokens":2700}}}\n' "$(ts 20)"
} > "$CX"
cdrv() { ( cd "$ODD" && CODEX_PRICES='{}' bash "$REPO_DIR/scripts/drivers/token-usage/codex.sh" "$START" --kv 2>&1 ); }
cdrv > "$TMP/cx.before"
chk "前提：驱动认领到了这份记录（两条用量，未缓存输入合计 2600）" "$(grep -oE '(^| )in=[0-9]+' "$TMP/cx.before" | tr -d ' ')" "in=2600"
scan 2> "$TMP/scan12.err"
cdrv > "$TMP/cx.after"
chk "替换后驱动的输出逐字节相同" "$(cmp -s "$TMP/cx.before" "$TMP/cx.after" && echo same)" "same"
chk "记录工作目录的两行一个字节没动" "$(sed -n 1,2p "$CX" | grep -c "\"cwd\":\"$ODD\"")" "2"
chk "真令牌被替换了；内容里出现的那段目录名（不在受保护字段里）照常替换" \
    "$(has "$CX" "$TO" && echo raw || echo clean)|$(has "$CX" "$(want "$TO")" && echo fp)|$(sed -n 4p "$CX" | grep -c "$TP")" "clean|fp|0"
chk "每行仍能按 JSON 解析" "$(lines_ok "$CX")" "ok"

echo "【13】开关：REDACT_AGENT_RECORDS 留空时不改 agent 的文件，daemon 自己的日志照常处理"
printf '{"type":"user","cwd":"%s","message":{"content":"关着的时候 %s"}}\n' "$TMP/wt/issue-7" "$TS" >> "$CJ"
cp "$CJ" "$TMP/cj.off"
printf '关着的时候 poll.log 里的旧内容 %s\n' "$TS" >> "$LOG"
echo 'REDACT_AGENT_RECORDS=""' >> "$CONF"
scan 2>/dev/null
chk "会话记录一个字节没动" "$(cmp -s "$CJ" "$TMP/cj.off" && echo same)" "same"
chk "poll.log 里的旧内容照常被替换" "$(no_raw "$LOG" && echo clean)|$(has "$LOG" "$(want "$TS")" && echo fp)" "clean|fp"
sed -i '$d' "$CONF"
scan 2>/dev/null
chk "开关打开后下一次扫描就替换" "$(no_raw "$CJ" && echo clean)" "clean"
lib 'redact_scan_tick'
chk "没到间隔时不扫（刚扫过）" "$(printf '%s 又来一行\n' "$TP" >> "$LOG"; lib 'redact_scan_tick'; has "$LOG" "$TP" && echo untouched)" "untouched"

echo "【14】守卫：往 poll.log / 窗格历史追加内容的地方都经过脱敏入口"
# 这一组只防「以后新增一处直接写」；每个入口的行为在上面各组里真跑过。
guard() {   # <scripts 目录> → 列出没经过入口的追加写
    grep -nE '(>>|tee -a)[[:space:]]*"?\$\{?(LOG_FILE|log_path|new_sd/poll\.log)' "$1"/*.sh \
        | grep -vE 'redact_(pipe|stream)|redact-ok' || true
}
chk "现在的脚本里没有绕过入口的追加写" "$(guard "$REPO_DIR/scripts" | wc -l | tr -d ' ')" "0"
mkdir -p "$TMP/guard"; cp "$REPO_DIR"/scripts/*.sh "$TMP/guard/"
echo 'some_cmd 2>&1 | tee -a "$LOG_FILE" >&2' >> "$TMP/guard/cleanup-issue.sh"
chk "新增一处直接写会被认出来" "$(guard "$TMP/guard" | wc -l | tr -d ' ')" "1"

echo "【15】codex 环境快照：新 worker 不再写；旧快照的清理脚本有 codex 在跑就拒绝"
mkdir -p "$TMP/cxbin"
cat > "$TMP/cxbin/codex" <<'CX'
#!/usr/bin/env bash
case "$*" in
    "features list") [ -n "${FAKE_CODEX_NO_FEATURE:-}" ] || echo "shell_snapshot    stable    true"; exit 0 ;;
    *--help*) echo "      --no-daemon"; exit 0 ;;
esac
exec sleep 30
CX
chmod +x "$TMP/cxbin/codex"
echo 'WORKER_AGENT="codex"' >> "$CONF"
cxcmd() { PATH="$TMP/cxbin:$PATH" lib "$1" 2>/dev/null; }
echo p > "$TMP/p.md"
chk "新起的 codex 命令关掉了快照功能" "$(cxcmd "agent_command_new '$TMP' n '$TMP/p.md'" | grep -c -- '--disable shell_snapshot')" "1"
chk "按编号续接的命令也关" "$(cxcmd "WORKER_SESSION_ID=abc; agent_command_resume '$TMP' n '$TMP/p.md'" | grep -c -- '--disable shell_snapshot')" "1"
chk "续接最近一条的命令也关" "$(cxcmd "agent_command_resume '$TMP' n '$TMP/p.md'" | grep -c -- '--disable shell_snapshot')" "1"
chk "这个版本的 codex 没有这项功能时不传" "$(FAKE_CODEX_NO_FEATURE=1 cxcmd "agent_command_new '$TMP' n '$TMP/p.md'" | grep -c -- '--disable')" "0"
echo 'CODEX_SHELL_SNAPSHOT="on"' >> "$CONF"
chk "配置成保留快照时不传" "$(cxcmd "agent_command_new '$TMP' n '$TMP/p.md'" | grep -c -- '--disable')" "0"
sed -i '$d' "$CONF"; sed -i '$d' "$CONF"

SNAP="$HOME/.codex/shell_snapshots"; mkdir -p "$SNAP"
mksnap() { printf '# Snapshot file\ndeclare -x GH_TOKEN="%s"\ndeclare -x HOME="/x"\n' "$TP" > "$SNAP/$1.sh"; }
mksnap a; mksnap b
# 假的进程清单：测试不依赖本机此刻有没有 codex 在跑
cat > "$TMP/cxbin/ps" <<'PS'
#!/usr/bin/env bash
case "${FAKE_PS:-none}" in
    fail)  exit 1 ;;
    empty) exit 0 ;;
    codex) echo "  101 bash -l"; echo "  202 /opt/x/bin/codex resume abc --no-daemon"; echo "  303 node /usr/lib/codex.js"; exit 0 ;;
    none)  echo "  101 bash -l"; echo "  404 vim notes-about-codex.md"; exit 0 ;;
esac
PS
chmod +x "$TMP/cxbin/ps"
snapclean() { PATH="$TMP/cxbin:$PATH" bash "$REPO_DIR/scripts/redact-snapshots.sh" "$@" > "$TMP/snap.out" 2>&1; echo $?; }
chk "有 codex 进程在跑：拒绝，文件不动" "$(FAKE_PS=codex snapclean)|$(has "$SNAP/a.sh" "$TP" && echo raw)|$(grep -c '202 \|303 ' "$TMP/snap.out")" "1|raw|2"
chk "进程清单读不到：拒绝，文件不动" "$(FAKE_PS=fail snapclean)|$(has "$SNAP/a.sh" "$TP" && echo raw)" "1|raw"
chk "进程清单是空的：拒绝，文件不动" "$(FAKE_PS=empty snapclean)|$(has "$SNAP/b.sh" "$TP" && echo raw)" "1|raw"
chk "只检查：不改文件" "$(FAKE_PS=none snapclean --check)|$(has "$SNAP/a.sh" "$TP" && echo raw)" "0|raw"
chk "没有 codex 进程：两个快照都替换，指纹和别处相同" \
    "$(FAKE_PS=none snapclean)|$(no_raw "$SNAP/a.sh" "$SNAP/b.sh" && echo clean)|$(grep -c "GH_TOKEN=\"$(want "$TP")\"" "$SNAP/a.sh")" "0|clean|1"
chk "替换后的快照仍是能执行的 shell 脚本，别的变量没动" "$(bash -c "source '$SNAP/a.sh'; echo \"\$HOME|\${#GH_TOKEN}\"")" "/x|${#TP}"
chk "脚本报了替换数" "$(grep -c '2 个快照文件，其中 2 个含令牌，共替换 2 处' "$TMP/snap.out")" "1"

echo "【16】文档里的清理步骤：两份一字不差，按原样在空环境里跑"
ops_block() {
    awk '/<!-- redact-ops:begin -->/{on=1; next} /<!-- redact-ops:end -->/{on=0}
         on && /^```bash$/{inb=1; next} on && /^```$/{inb=0; next} inb' "$1"
}
OPS_EN=$(ops_block "$REPO_DIR/docs/operations.md"); OPS_ZH=$(ops_block "$REPO_DIR/docs/operations.zh.md")
chk "两份文档都有这段，而且一字不差" "$([ -n "$OPS_EN" ] && [ "$OPS_EN" = "$OPS_ZH" ] && echo same)" "same"
# 一台装好了 skill 的「机器」：稳定入口指向本仓库；环境里除了 HOME / PATH 什么都不预设
OPS_HOME="$TMP/ops-home"; mkdir -p "$OPS_HOME/.agents/skills" "$OPS_HOME/.codex/shell_snapshots"
ln -s "$REPO_DIR" "$OPS_HOME/.agents/skills/cavil-loop"
for n in a b c; do printf 'declare -x GH_TOKEN="%s"\ndeclare -x X="1"\n' "$TO" > "$OPS_HOME/.codex/shell_snapshots/$n.sh"; done
printf 'declare -x X="1"\n' > "$OPS_HOME/.codex/shell_snapshots/d.sh"
printf '%s\n' "$OPS_EN" > "$TMP/ops.sh"
run_ops() { env -i HOME="$OPS_HOME" PATH="$TMP/cxbin:/usr/local/bin:/usr/bin:/bin" FAKE_PS="$1" bash "$TMP/ops.sh" > "$TMP/ops.out" 2>&1; }
run_ops codex
chk "codex 还在跑：照着做什么都不会改，前后都是 3 个" \
    "$(grep -c '本机还有 codex 进程在跑' "$TMP/ops.out")|$(grep -oE '(before|after) / [^:]*: [0-9]+' "$TMP/ops.out" | grep -oE '[0-9]+$' | tr '\n' ' ')|$(grep -l "$TO" "$OPS_HOME"/.codex/shell_snapshots/*.sh | wc -l | tr -d ' ')" "1|3 3 |3"
run_ops none
chk "codex 停了以后重跑：3 → 0，文档说的那行「完成」出现了" \
    "$(grep -c '^完成：4 个快照文件，其中 3 个含令牌，共替换 3 处' "$TMP/ops.out")|$(grep -oE '(before|after) / [^:]*: [0-9]+' "$TMP/ops.out" | grep -oE '[0-9]+$' | tr '\n' ' ')|$(grep -l "$TO" "$OPS_HOME"/.codex/shell_snapshots/*.sh 2>/dev/null | wc -l | tr -d ' ')" "1|3 0 |0"
run_ops none
chk "再跑一遍没有副作用" "$(grep -c '共替换 0 处' "$TMP/ops.out")|$(grep -c "GH_TOKEN=\"$(want "$TO")\"" "$OPS_HOME/.codex/shell_snapshots/a.sh")" "1|1"

echo
report_counts "$pass" "$fail"
if [ "$fail" -eq 0 ]; then echo "✅ 全部通过（$pass 项）"; exit 0; fi
echo "❌ 失败 $fail 项（通过 $pass 项）"; exit 1
