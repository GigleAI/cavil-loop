#!/usr/bin/env bash
# 常驻假 GitHub（GitHub#211）：tests/lib/fake_gh_server.py + tests/lib/fake_gh_client.sh 的守卫。
#
# 跑法：bash tests/fake-gh-server.test.sh              （默认不跑负对照）
#       MUTATION=1 bash tests/fake-gh-server.test.sh   （另跑 4 个负对照：改坏服务 / 转发脚本的副本）
# 依赖：bash、python3、jq。不碰网络：服务只听 127.0.0.1。
#
# 要守住的只有一件事：换成常驻方式以后，测试看到的东西和以前一模一样，而且出了故障不会悄悄多做一次。
#   1. 两种方式（以前的「每次起一个 python3」和常驻转发）从同一份初始状态跑同一组调用：读、写、--jq、
#      --paginate、故障注入、读前钩子、FAKE_GH_OBSERVER、失败退出码、stderr、带 stdin、非 api 子命令、
#      输出写进普通文件时的退回——每次调用的 stdout / stderr / 退出码、假 GitHub 的每个状态文件逐字节相同
#      （fake_github.py 往评论 / 标签记录里写当前时间，比较前把 ISO 时间换成同一个占位；其余不做任何改写）
#   2. 常驻方式确实被用上（服务端计数 > 0），输出写进文件那次确实退回了（计数不变）
#   3. 10 个并发调用每个恰好记一次、输出各自正确
#   4. 中断时序：正例 / 两次调用之间服务被杀 / 已接手未执行就断开 / 已执行未回结果就断开 / 服务回复退回
#      ——退出码、stderr、评论条数、调用记录行数、观察回调次数
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/mutation.sh
source "$TEST_DIR/lib/mutation.sh"
unset FAKE_GH_OBSERVER FAKE_GH_SERVER FAKE_GH_SERVER_FAULT_FILE FAKE_GH_OWNER TEST_PART

SANDBOX=$(mktemp -d)
cleanup() { [ -n "${KEEP_SANDBOX:-}" ] && { echo "SANDBOX=$SANDBOX"; return 0; }; rm -rf "$SANDBOX"; }
trap cleanup EXIT

pass=0; fail=0; QUIET=0
chk() {
    if [ "$2" = "$3" ]; then [ "$QUIET" = 1 ] || echo "  ✅ $1"; pass=$((pass+1))
    else [ "$QUIET" = 1 ] || echo "  ❌ $1 (期望 [$3]，实得 [$2])"; fail=$((fail+1)); fi
}

FAKE_AP="$TEST_DIR/lib/fake_github.py"
FAKE_RB="$TEST_DIR/fixtures/requester-bot-fake-gh.py"
UNKNOWN='假 GitHub：请求已交出、执行结果未知，不重试'

# 跑一次调用，stdout / stderr 都接到管道（常驻方式只接管道），分别存文件；退出码存 .rc
# cap <前缀> [--stdin 文本] [--stdout-file 文件] -- <命令…>
cap() {
    local pre="$1"; shift
    python3 -I - "$pre" "$@" <<'PY'
import subprocess, sys
pre, args = sys.argv[1], sys.argv[2:]
stdin_data, out_file = None, None
while args[0] != "--":
    if args[0] == "--stdin":
        stdin_data = args[1].encode(); args = args[2:]
    elif args[0] == "--stdout-file":
        out_file = args[1]; args = args[2:]
cmd = args[1:]
if out_file:
    # 调用方把 stdout 接到一个已有内容的普通文件（追加方式），stderr 照样是管道
    with open(out_file, "ab") as f:
        r = subprocess.run(cmd, stdout=f, stderr=subprocess.PIPE,
                           input=stdin_data if stdin_data is not None else None,
                           stdin=None if stdin_data is not None else subprocess.DEVNULL)
    out = b""
else:
    r = subprocess.run(cmd, capture_output=True, input=stdin_data,
                       stdin=None if stdin_data is not None else subprocess.DEVNULL)
    out = r.stdout
open(pre + ".out", "wb").write(out)
open(pre + ".err", "wb").write(r.stderr)
open(pre + ".rc", "w").write(str(r.returncode))
PY
}
served() { local n; n=$( { wc -c < "$1.d/served"; } 2>/dev/null) || n=0; echo "${n:-0}" | tr -d ' '; }
# 状态目录逐字节比较（ISO 时间换占位）；输出 same 或第一处不同
dir_same() {
    python3 -I - "$1" "$2" <<'PY'
import os, re, sys
a, b = sys.argv[1:3]
ts = re.compile(rb"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ")
def files(d):
    out = {}
    for root, _, fs in os.walk(d):
        for f in fs:
            p = os.path.join(root, f)
            out[os.path.relpath(p, d)] = ts.sub(b"T", open(p, "rb").read())
    return out
fa, fb = files(a), files(b)
if fa.keys() != fb.keys():
    print("files differ:", sorted(set(fa) ^ set(fb))); sys.exit()
for k in sorted(fa):
    if fa[k] != fb[k]:
        print("differs:", k); sys.exit()
print("same")
PY
}

# ── 一组调用：同一份初始状态，旧方式（每次起 python3）和常驻方式各跑一遍 ─────────────
seed_ap() {   # <状态目录>
    local d="$1"; rm -rf "$d"; mkdir -p "$d"
    echo '{"7":{"kind":"issue","state":"open","title":"t7","body":"x","user":{"login":"maint"}},
           "8":{"kind":"pr","state":"open","title":"p8","head":{"sha":"abc","ref":"feature/issue-7"},"base":{"ref":"main"}}}' > "$d/items.json"
    echo '{"7":["pending/agent"]}' > "$d/labels.json"
    echo '{"7":[{"event":"labeled","label":{"name":"pending/agent"},"actor":{"login":"maint","type":"User"}}]}' > "$d/events.json"
    echo '{"7":[{"id":1,"body":"first","user":{"login":"maint"}}]}' > "$d/comments.json"
    echo loop-bot > "$d/me"
    # 第 3 次读 issues/7 之前跑的钩子：往 stdout 打一行、改一下标签（测「钩子的输出也进调用方」）
    printf '%s\n' 'echo HOOK-RAN' 'cd "$(dirname "$0")" && jq ".\"7\" += [\"hooked\"]" labels.json > l.tmp && mv l.tmp labels.json' > "$d/hook_issues_7_3"
}
seed_rb() {   # <状态目录>
    local d="$1"; rm -rf "$d"; mkdir -p "$d"
    echo '{"me":"worker-bot","items":{"50":{"number":50,"title":"t50","user":"req-bot","body":"b","state":"open","labels":["doing/agent"],"comments":[]}}}' > "$d/state.json"
    echo '[]' > "$d/faults.json"
}
run_set() {   # <gh 路径> <结果目录> <ap 状态目录> <rb 状态目录>
    local GH="$1" R="$2" AD="$3" RD="$4" i=0
    mkdir -p "$R"
    c() { i=$((i + 1)); cap "$R/$i" "$@"; }
    export FAKE_GH_REPO=example/ap
    # fake_github.py 那一组
    export FAKE_GH_DIR="$AD"
    c -- "$GH" api repos/example/ap/issues/7                                   # 读
    c -- "$GH" api repos/example/ap/issues/7 --jq .title                       # --jq
    c -- "$GH" api repos/example/ap/issues/7                                   # 第 3 次读：钩子先跑
    c -- "$GH" api repos/example/ap/issues/99                                  # 404：退出码 1 + stderr
    c -- "$GH" api -X POST repos/example/ap/issues/7/comments -f "body=多行
第二行 \"引号\" \$HOME"                                                          # 写，带换行 / 引号 / 中文
    c -- "$GH" api repos/example/ap/issues/7/comments --paginate --slurp --jq 'map(length)'
    c -- "$GH" api -X POST repos/example/ap/issues/7/labels -f 'labels[]=x y'  # 加标签（带空格）
    c -- "$GH" api -X DELETE repos/example/ap/issues/7/labels/x%20y             # 摘标签
    c -- "$GH" api -X DELETE repos/example/ap/issues/7/labels/nope              # 摘不存在的：404
    touch "$AD/F_issues_7_events"
    c -- "$GH" api repos/example/ap/issues/7/events                            # 故障注入：502
    rm -f "$AD/F_issues_7_events"
    c -- "$GH" api repos/example/ap/issues/7 --jq '.['                         # jq 表达式错：退出码 + stderr
    c --stdin "一些标准输入" -- "$GH" api repos/example/ap/issues/7 --jq .number    # 带 stdin
    c -- "$GH" pr list --json number                                           # 非 api 子命令
    c -- "$GH" ''                                                              # 空参数
    c -- env GH_TOKEN=tok-xyz "$GH" api user --jq .login                       # 环境变量（令牌记进 tokens.log）
    printf 'PRE\n' > "$R/tofile.txt"
    c --stdout-file "$R/tofile.txt" -- "$GH" api repos/example/ap/issues/7 --jq .title   # 输出写进普通文件：退回
    # requester-bot 那份假 gh：观察钩子
    export FAKE_GH_DIR="$RD" FAKE_GH_REPO=example/requester-bot
    export FAKE_GH_OBSERVER="echo OBS >> '$RD/obs.log'; echo obs-out; echo obs-err >&2"
    c -- "$GH-rb" api repos/example/requester-bot/issues/50 --jq .title
    c -- "$GH-rb" api -X POST repos/example/requester-bot/issues/50/comments -f body=hi --jq .id
    c -- "$GH-rb" api repos/example/requester-bot/issues/404
    unset FAKE_GH_OBSERVER
    # 工作目录：--input 写的是相对路径，读的必须是调用方当前目录下那份
    mkdir -p "$R/cwd"; echo '{"body":"来自文件"}' > "$R/cwd/in.json"
    (cd "$R/cwd" && cap "$R/cwd-call" -- "$GH-rb" api -X POST repos/example/requester-bot/issues/50/comments --input in.json --jq .id)
}

# 一套检查：$1 = fake_gh_server.py / fake_gh_client.sh 所在目录（负对照传改坏的副本）
suite() {
    local LIB="$1" W="$SANDBOX/run-$RANDOM" i diffs=0 n
    mkdir -p "$W/old-bin" "$W/new-bin"
    FAKE_GH_SERVER=0 bash "$LIB/fake_gh_client.sh" install "$W/old-bin/gh" python3 "$FAKE_AP"
    FAKE_GH_SERVER=0 bash "$LIB/fake_gh_client.sh" install "$W/old-bin/gh-rb" python3 -I "$FAKE_RB"
    FAKE_GH_OWNER=$$ bash "$LIB/fake_gh_client.sh" install "$W/new-bin/gh" python3 "$FAKE_AP"
    FAKE_GH_OWNER=$$ bash "$LIB/fake_gh_client.sh" install "$W/new-bin/gh-rb" python3 -I "$FAKE_RB"
    chk "到达性 · 常驻服务起来了（两份都有端口）" "$([ -s "$W/new-bin/gh.d/port" ] && [ -s "$W/new-bin/gh-rb.d/port" ] && echo yes || echo no)" yes
    chk "旧方式那份没起服务" "$([ -e "$W/old-bin/gh.d/port" ] && echo yes || echo no)" no
    chk "令牌文件只有自己能读（0600）" "$(stat -c %a "$W/new-bin/gh.d/token" 2>/dev/null)" 600

    seed_ap "$W/ap-old"; seed_rb "$W/rb-old"; seed_ap "$W/ap-new"; seed_rb "$W/rb-new"
    run_set "$W/old-bin/gh" "$W/res-old" "$W/ap-old" "$W/rb-old"
    local before_file; before_file=$(served "$W/new-bin/gh")
    run_set "$W/new-bin/gh" "$W/res-new" "$W/ap-new" "$W/rb-new"
    n=$(find "$W/res-old" -name '*.rc' | wc -l)
    chk "到达性 · 两边都跑了同样多次调用（$n 次）" "$(find "$W/res-new" -name '*.rc' | wc -l)" "$n"
    for f in "$W"/res-old/*.out "$W"/res-old/*.err "$W"/res-old/*.rc; do
        cmp -s "$f" "$W/res-new/$(basename "$f")" || { diffs=$((diffs + 1)); [ "$QUIET" = 1 ] || echo "     不同：$(basename "$f")"; }
    done
    chk "每次调用的 stdout / stderr / 退出码逐字节相同" "$diffs" 0
    chk "调用方写进普通文件的输出相同（接在原有内容之后）" "$(cmp -s "$W/res-old/tofile.txt" "$W/res-new/tofile.txt" && echo same || echo diff)" same
    chk "  …内容是「PRE」后接 t7" "$(paste -sd' ' "$W/res-new/tofile.txt")" "PRE t7"
    chk "fake_github.py 的全部状态文件相同" "$(dir_same "$W/ap-old" "$W/ap-new")" same
    chk "requester-bot 假 gh 的全部状态文件相同（含观察钩子的记录）" "$(dir_same "$W/rb-old" "$W/rb-new")" same
    chk "到达性 · 这组调用确实覆盖了：退出码 1、钩子输出、观察钩子、写入" \
        "$(cat "$W/res-new/4.rc")/$(grep -c HOOK-RAN "$W/res-new/3.out")/$(grep -c . "$W/rb-new/obs.log" 2>/dev/null)/$(jq '."7" | length' "$W/ap-new/comments.json")" "1/1/3/2"
    chk "到达性 · 带换行和引号的评论原样写进去了" "$(jq -r '."7"[1].body' "$W/ap-new/comments.json")" "多行
第二行 \"引号\" \$HOME"
    chk "到达性 · 工作目录传到了（--input 相对路径读到了调用方目录下的文件）" "$(jq -r '.items."50".comments[-1].body' "$W/rb-new/state.json")" "来自文件"
    chk "到达性 · 环境变量传到了（tokens.log 记下了 tok-xyz）" "$(grep -c '^tok-xyz gh api user' "$W/ap-new/tokens.log")" 1
    chk "常驻方式确实被用上（服务端计数 > 0）" "$([ "$(served "$W/new-bin/gh")" -gt 0 ] && echo yes || echo no)" yes
    # 计数：fake_github 那份共 16 次调用，其中输出写进文件那 1 次退回 → 15
    chk "输出写进普通文件那次退回了旧方式（服务只接了另外 15 次）" "$(( $(served "$W/new-bin/gh") - before_file ))" 15

    # ── 10 个并发调用：每个恰好记一次、输出各自正确 ──
    # 用 `api user`：假 GitHub 自己给每个读路径记的次数文件（count_*）不带锁，并发读同一路径时
    # 它自己就会读到半截——那是假 GitHub 原有的样子（每次起 python3 时一样），不是这里要测的
    export FAKE_GH_DIR="$W/ap-new" FAKE_GH_REPO=example/ap
    : > "$W/ap-new/calls.log"
    local s0; s0=$(served "$W/new-bin/gh")
    for i in $(seq 1 10); do
        ( out=$("$W/new-bin/gh" api user -f "probe=$i" --jq .login 2>/dev/null); echo "$i:$out" > "$W/conc-$i" ) &
    done
    wait
    chk "并发 10 次：每次的输出都对" "$(cat "$W"/conc-* | sort -n | paste -sd' ')" "1:loop-bot 2:loop-bot 3:loop-bot 4:loop-bot 5:loop-bot 6:loop-bot 7:loop-bot 8:loop-bot 9:loop-bot 10:loop-bot"
    chk "并发 10 次：调用记录 10 行、每个只出现一次" "$(wc -l < "$W/ap-new/calls.log" | tr -d ' ')/$(sort "$W/ap-new/calls.log" | uniq -d | wc -l | tr -d ' ')" "10/0"
    chk "并发 10 次：都走了常驻服务" "$(( $(served "$W/new-bin/gh") - s0 ))" 10

    # ── 中断时序（只有测试打开的开关能让服务在指定时点退出） ──
    local FF="$W/fault" G="$W/int-bin/gh-rb" D
    mkdir -p "$W/int-bin"
    FAKE_GH_SERVER_FAULT_FILE="$FF" FAKE_GH_OWNER=$$ bash "$LIB/fake_gh_client.sh" install "$G" python3 -I "$FAKE_RB"
    export FAKE_GH_REPO=example/requester-bot
    post() {   # <情形名> → 在全新状态上发一条评论，结果存 $W/int-<名>.*
        D="$W/int-$1"; seed_rb "$D"; export FAKE_GH_DIR="$D"
        export FAKE_GH_OBSERVER="echo OBS >> '$D/obs.log'"
        cap "$W/int-$1" -- "$G" api -X POST repos/example/requester-bot/issues/50/comments -f body=hi --jq .id
        sleep 0.3   # 给「万一被重跑」留出时间：后面断言调用记录仍只有一行
        unset FAKE_GH_OBSERVER
    }
    tally() {   # <情形名> → 退出码/评论条数/调用记录行数（每次调用一行「gh …」）/观察回调次数
        local D="$W/int-$1"
        echo "$(cat "$D.rc")/$(jq '.items."50".comments | length' "$D/state.json")/$(grep -c '^gh ' "$D/calls.log" 2>/dev/null || echo 0)/$(grep -c . "$D/obs.log" 2>/dev/null || echo 0)"
    }
    local s1
    rm -f "$FF"; s1=$(served "$G"); post ok
    chk "中断 · 正例：退出码 0，评论 1 条，记录 1 行，回调 1 次" "$(tally ok)" "0/1/1/1"
    chk "中断 · 正例：走的是常驻服务" "$(( $(served "$G") - s1 ))" 1

    echo after-ack > "$FF"; post ack
    chk "中断 · 已接手、还没执行就断开：退出码 70；评论 0、记录 0、回调 0（没有第二次执行）" "$(tally ack)" "70/0/0/0"
    chk "  …stderr 写明结果未知" "$(grep -c "$UNKNOWN" "$W/int-ack.err")" 1

    echo after-exec > "$FF"; post exec
    chk "中断 · 评论已保存、退出码没送回就断开：退出码 70；评论 1（不撤销）、记录 1、回调 1，不出现第 2 条" "$(tally exec)" "70/1/1/1"
    chk "  …stderr 写明结果未知" "$(grep -c "$UNKNOWN" "$W/int-exec.err")" 1

    rm -f "$FF"
    D="$W/int-file"; seed_rb "$D"; export FAKE_GH_DIR="$D"; export FAKE_GH_OBSERVER="echo OBS >> '$D/obs.log'"
    : > "$W/int-file.txt"; s1=$(served "$G")
    cap "$W/int-file" --stdout-file "$W/int-file.txt" -- "$G" api -X POST repos/example/requester-bot/issues/50/comments -f body=hi --jq .id
    unset FAKE_GH_OBSERVER
    chk "中断 · 服务回复退回（输出写进文件）：退回旧方式执行一次，结果与正例相同" "$(tally file)" "0/1/1/1"
    chk "  …输出与正例相同、服务没接这一次" "$(cat "$W/int-file.txt")/$(( $(served "$G") - s1 ))" "$(cat "$W/int-ok.out")/0"

    kill -9 "$(cat "$G.d/pid")" 2>/dev/null; sleep 0.2
    chk "到达性 · 服务确实被杀了、端口文件还在（测的是连不上，不是找不到端口）" \
        "$(kill -0 "$(cat "$G.d/pid")" 2>/dev/null && echo alive || echo dead)/$([ -s "$G.d/port" ] && echo port || echo noport)" "dead/port"
    post killed
    chk "中断 · 服务在两次调用之间被杀，下一次调用：连不上 → 退回旧方式执行一次，结果与正例相同" "$(tally killed)" "0/1/1/1"
    chk "  …输出与正例相同、stderr 为空" "$(cat "$W/int-killed.out")/$(wc -c < "$W/int-killed.err" | tr -d ' ')" "$(cat "$W/int-ok.out")/0"

    # ── 安全：没带对令牌的请求不执行任何东西 ──
    local P; P=$(cat "$W/new-bin/gh.d/port"); D="$W/tok"; seed_ap "$D"
    python3 -I - "$P" "$$" <<'PY' > "$W/tok.reply"
import socket, sys
s = socket.create_connection(("127.0.0.1", int(sys.argv[1])))
s.sendall(b"wrong-token %s 2\n" % sys.argv[2].encode())
print(repr(s.recv(100)))
PY
    chk "令牌不对：连接被直接关掉，什么都不回" "$(cat "$W/tok.reply")" "b''"
    chk "服务只听 127.0.0.1（/proc/net/tcp 里这个端口的监听地址）" \
        "$(awk -v p="$(printf ':%04X' "$P")" '$2 ~ p"$" && $4 == "0A" {print $2}' /proc/net/tcp | head -1)" "$(printf '0100007F:%04X' "$P")"

    # ── 测试进程没了，服务自己退出 ──
    local X="$W/owner-bin/gh"; mkdir -p "$W/owner-bin"
    bash -c 'FAKE_GH_OWNER=$$ bash "$1" install "$2" python3 "$3"' _ "$LIB/fake_gh_client.sh" "$X" "$FAKE_AP"
    local spid; spid=$(cat "$X.d/pid" 2>/dev/null)
    for i in $(seq 30); do kill -0 "$spid" 2>/dev/null || break; sleep 0.1; done
    chk "装它的进程退出后，服务在 3 秒内自己退出" "$(kill -0 "$spid" 2>/dev/null && echo alive || echo gone)" gone
    for f in "$W"/*-bin/*.d/pid; do kill "$(cat "$f")" 2>/dev/null; done
}

echo "── 常驻假 GitHub：和每次起 python3 逐字节一致；故障不重跑 ──"
suite "$TEST_DIR/lib"

# ── 负对照（MUTATION=1）：改坏服务 / 转发脚本的副本，同一套检查必须变红 ──
echo "── 负对照 ──"
neg() {   # <说明> <文件名> <原文> <改成>
    mutation_gate || return 0
    local M="$SANDBOX/mut-$RANDOM"; mkdir -p "$M"
    cp "$TEST_DIR/lib/fake_gh_server.py" "$TEST_DIR/lib/fake_gh_client.sh" "$M/"
    if ! python3 -I - "$M/$2" "$3" "$4" <<'PY'
import sys
p, old, new = sys.argv[1:4]
s = open(p).read()
if s.count(old) != 1:
    sys.exit(1)
open(p, "w").write(s.replace(old, new))
PY
    then echo "  ❌ 负对照准备失败（原文找不到）：$1"; fail=$((fail + 1)); return 0; fi
    local before=$fail
    QUIET=1; suite "$M"; QUIET=0
    local got=$((fail - before)); fail=$before
    chk "负对照：$1 → 变红（$got 条失败）" "$([ "$got" -gt 0 ] && echo red || echo green)" red
}
neg "服务端丢掉调用方的环境变量" fake_gh_server.py '        os.environ.update(env)' '        os.environ.update({k: v for k, v in env.items() if k != "GH_TOKEN"})'
neg "服务端丢掉退出码（一律回 0）" fake_gh_server.py '        conn.sendall(b"EXIT %d\n" % (code & 0xFF))' '        conn.sendall(b"EXIT 0\n")'
neg "该退回时不退回（普通文件也直接写）" fake_gh_server.py \
    '                if not (stat.S_ISFIFO(st.st_mode) or stat.S_ISCHR(st.st_mode)):' '                if False:'
neg "结果未知时改成重跑" fake_gh_client.sh \
    '                echo "假 GitHub：请求已交出、执行结果未知，不重试（已接手，但没收到退出码）" >&2
                exit 70 ;;' \
    '                exec 3>&-; exec "${FAKE_GH_FALLBACK[@]}" "$@" ;;'

echo
mutation_summary "$0"
echo "结果：$pass 通过 / $fail 失败"
[ "$fail" -eq 0 ]
