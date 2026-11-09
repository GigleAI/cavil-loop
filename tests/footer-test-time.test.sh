#!/usr/bin/env bash
# kind: e2e
# 评论 footer 的测试耗时（GitHub#244）：tests/run.sh 的运行编号 + 流水，内置统计命令
# scripts/drivers/token-usage/test-time.sh，经真实 comment-footer.sh 出 footer。
#
# 跑法：bash tests/footer-test-time.test.sh              （默认不跑负对照）
#       MUTATION=1 bash tests/footer-test-time.test.sh   （连负对照一起跑；见 tests/lib/mutation.sh）
# 依赖：python3、jq、git。不碰网络、不读本机真实会话 / 流水（HOME、会话目录、流水路径都指到临时目录）。
#
# 全部走真实路径：夹具是一个真的 git worktree，里面放仓库的 tests/run.sh 副本，真跑出流水和编号；
# 会话夹具是 Claude 真实记录的形状（工具调用 / 工具结果两条主记录，外加不带时刻的重复副本；后台命令的
# 工具结果里写着输出文件的位置——这句话的原文按本机会话核对过）；codex 夹具是 exec 工具调用的形状。
# 统计结果从 footer 末尾的机器记录和总览里读，不调内部函数。
#
# 覆盖（名字就是 run_check 打印的检查名，负对照按名字认）：
#   记账：编号印在输出里；嵌套运行不记账不印编号；失败的运行 exit 记进结束行
#   关联：前台按编号计时；甲没写进流水、人 10 秒后手跑的乙（#244 复审第 2 轮反例）；同一 agent
#         并发两次；后台从输出文件读编号；后台输出文件没了；流水只读写不进；只有开始行；只有结束行；
#         坏行；流水读不了；会话读不了；两栏都读不了
#   单跑：前台计时；后台只计次 → 未知；引号 / here-doc 里的命令不算；并行取并集；一次都没跑 → 0
#   codex：每条命令只认它自己的输出（含同一 session_id 的后续轮询）；JSON 参数的函数调用；单元对不上号 /
#         写法解析不了时不归、不答 0；别的命令输出里的编号不认（#247 复审第 1 轮反例）；同一场景 claude / codex 结论一致；
#         本轮时间窗前 / 边界 / 窗口内，各条路径同一条件（#247 复审第 2 轮反例）
#   部署前空窗：入口不存在时 footer 写「测试未知」
set -uo pipefail
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
# shellcheck source=lib/mutation.sh
source "$TEST_DIR/lib/mutation.sh"
TMP=$(mktemp -d)
trap '[ -n "${KEEP:-}" ] && echo "TMP=$TMP" || { chmod -R u+rwX "$TMP" 2>/dev/null; rm -rf "$TMP"; }' EXIT
export HOME="$TMP/home" XDG_STATE_HOME="$TMP/home/.local/state" CAVIL_DEPLOY_ROOT="$TMP/no-deploy"
export GIT_CONFIG_GLOBAL="$TMP/gitconfig" GIT_CONFIG_NOSYSTEM=1
mkdir -p "$HOME"
printf '[user]\n\tname = t\n\temail = t@example.invalid\n[init]\n\tdefaultBranch = main\n' > "$GIT_CONFIG_GLOBAL"
# 外层 run.sh / Actions 的变量不能漏进被测的那次运行
unset CAVIL_TEST_RUN_ID RUN_TESTS_DIR CAVIL_TEST_RUNS_LOG GITHUB_ACTIONS GITHUB_STEP_SUMMARY CLAUDE_PROJECTS_DIR CODEX_SESSIONS_DIR

pass=0; fail=0
ok()  { echo "  ✅ $1"; pass=$((pass + 1)); }
bad() { echo "  ❌ $1"; [ -n "${2:-}" ] && printf '     %s\n' "$2"; fail=$((fail + 1)); }

# 会话夹具：命令文件一行一条命令（JSON：id t cmd bg rt text err），写成 Claude 真实形状
mk_claude() {   # <会话目录> <worktree> <命令文件>
    python3 - "$1" "$2" "$3" <<'PY'
import json, sys, datetime, os
d, wt = sys.argv[1], sys.argv[2]
os.makedirs(d, exist_ok=True)
iso = lambda t: datetime.datetime.fromtimestamp(t, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
out = []
for line in open(sys.argv[3]):
    c = json.loads(line)
    use = {"type": "tool_use", "id": c["id"], "name": "Bash",
           "input": dict({"command": c["cmd"]}, **({"run_in_background": True} if c.get("bg") else {}))}
    out.append({"type": "assistant", "isSidechain": False, "timestamp": iso(c["t"]), "cwd": wt,
                "message": {"role": "assistant", "content": [use]}})
    out.append({"type": "api-request-blob", "message": {"role": "assistant", "content": [use]}})
    if c.get("rt") is None:
        continue
    res = {"tool_use_id": c["id"], "type": "tool_result", "content": c.get("text", ""), "is_error": bool(c.get("err"))}
    out.append({"type": "api-request-blob", "message": {"role": "user", "content": [res]}})
    out.append({"type": "user", "isSidechain": False, "timestamp": iso(c["rt"]), "cwd": wt,
                "message": {"role": "user", "content": [res]},
                "toolUseResult": {"stdout": c.get("text", ""), "stderr": "", "interrupted": False}})
with open(os.path.join(d, "s.jsonl"), "a") as f:
    for r in out:
        f.write(json.dumps(r, ensure_ascii=False) + "\n")
PY
}
cmd_json() {   # id t cmd bg rt text err → 一行 JSON
    python3 -c 'import json,sys; a=sys.argv[1:]; print(json.dumps({"id":a[0],"t":float(a[1]),"cmd":a[2],"bg":a[3]=="1","rt":(float(a[4]) if a[4] else None),"text":a[5],"err":a[6]=="1"}))' "$@"
}
# codex 夹具（真实 rollout 形状）。cx_exec / cx_poll 产出一条语句的描述（JSON），cx_spec 追加一次工具调用：
#   cx_spec <时刻> cell <语句>...      exec 单元：input = 每条语句一行 text(await tools.X({…}));，输出 = 头 + 每条一项
#   cx_spec <时刻> raw <input> <输出>   原样的单元 input（不是纯 text(await …) 序列时用）
#   cx_spec <时刻> fc <名字> <参数 JSON> <输出字符串，空 = 没有输出>
cx_exec() {   # <cmd> <输出> <wall 秒> <exit_code，空 = 还在跑> [session_id]
    python3 -c 'import json,sys; a=sys.argv[1:]; print(json.dumps({"tool":"exec_command","cmd":a[0],"out":a[1],"wall":float(a[2]),"exit":(int(a[3]) if a[3] else None),"sid":(int(a[4]) if len(a)>4 else None)}))' "$@"
}
cx_poll() {   # <session_id> <输出> <exit_code，空 = 还在跑>
    python3 -c 'import json,sys; a=sys.argv[1:]; print(json.dumps({"tool":"write_stdin","sid":int(a[0]),"out":a[1],"wall":1.0,"exit":(int(a[2]) if a[2] else None)}))' "$@"
}
cx_spec() {
    python3 - "$C/codex" "$WT" "$@" <<'PY'
import json, sys, datetime, os, uuid
root, wt, t, kind, *rest = sys.argv[1:]
t = float(t)
dt = datetime.datetime.fromtimestamp(t)
d = os.path.join(root, f"{dt:%Y}", f"{dt:%m}", f"{dt:%d}"); os.makedirs(d, exist_ok=True)
p = os.path.join(d, "rollout-x.jsonl")
iso = lambda x: datetime.datetime.fromtimestamp(x, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
recs = [] if os.path.exists(p) else [{"timestamp": iso(t - 30), "type": "session_meta", "payload": {"cwd": wt}}]
cid = "call_" + uuid.uuid4().hex[:12]
if kind == "cell":
    lines, items = [], [{"type": "input_text", "text": "Script completed\nWall time 1.0 seconds\nOutput:\n"}]
    for st in map(json.loads, rest):
        res = {"chunk_id": uuid.uuid4().hex[:6], "wall_time_seconds": st["wall"]}
        if st["exit"] is None and st.get("sid") is not None:
            res["session_id"] = st["sid"]
        if st["exit"] is not None:
            res["exit_code"] = st["exit"]
        res["output"] = st["out"]
        if st["tool"] == "exec_command":
            lines.append("text(await tools.exec_command({cmd:%s,\"yield_time_ms\":1000,\"max_output_tokens\":2000}));" % json.dumps(st["cmd"]))
        else:
            lines.append("text(await tools.write_stdin({session_id:%d,chars:\"\",\"yield_time_ms\":1000}));" % st["sid"])
        items.append({"type": "input_text", "text": json.dumps(res, ensure_ascii=False)})
    recs.append({"timestamp": iso(t), "type": "response_item", "payload": {"type": "custom_tool_call", "call_id": cid, "name": "exec", "input": "\n".join(lines) + "\n"}})
    recs.append({"timestamp": iso(t + 1), "type": "response_item", "payload": {"type": "custom_tool_call_output", "call_id": cid, "output": items}})
elif kind == "raw":
    src, out = rest
    recs.append({"timestamp": iso(t), "type": "response_item", "payload": {"type": "custom_tool_call", "call_id": cid, "name": "exec", "input": src}})
    recs.append({"timestamp": iso(t + 1), "type": "response_item", "payload": {"type": "custom_tool_call_output", "call_id": cid,
                 "output": [{"type": "input_text", "text": "Script completed\nWall time 1.0 seconds\nOutput:\n"}, {"type": "input_text", "text": out}]}})
else:
    name, args, out = rest
    recs.append({"timestamp": iso(t), "type": "response_item", "payload": {"type": "function_call", "name": name, "call_id": cid, "arguments": args}})
    if out:
        recs.append({"timestamp": iso(t + 1), "type": "response_item", "payload": {"type": "function_call_output", "call_id": cid, "output": out}})
with open(p, "a") as f:
    for r in recs:
        f.write(json.dumps(r, ensure_ascii=False) + "\n")
PY
}
bg_text() { printf 'Command running in background with ID: b%s. Output is being written to: %s. You will be notified when it completes.' "$RANDOM" "$1"; }

# 一个场景的沙盘：真 git worktree + run.sh 副本 + 会话目录 + 流水
new_case() {   # <名字> <run.sh 来源>
    C="$TMP/c/$1"; rm -rf "$C"; mkdir -p "$C"; FOOTER_DIAG=""
    git init -q "$C/repo" && git -C "$C/repo" commit -q --allow-empty -m init
    git -C "$C/repo" worktree add -q "$C/wt/proj-issue-9" -b feature >/dev/null 2>&1
    WT="$C/wt/proj-issue-9"
    mkdir -p "$WT/tests/lib"
    cp "$2" "$WT/tests/run.sh"; cp "$REPO_DIR/tests/lib/report.sh" "$WT/tests/lib/"
    : > "$WT/tests/ci-exclude.txt"; : > "$WT/tests/ci-weights.txt"
    # 类型头拼出来写：本文件自己只许有一行「# kind:」（run.sh 按行首数）
    printf '#!/usr/bin/env bash\n# %s: unit\n' kind > "$WT/tests/quick.test.sh"
    cat >> "$WT/tests/quick.test.sh" <<'EOF'
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"
sleep "${FIX_SLEEP:-1}"
if [ "${FIX_RC:-0}" = 0 ]; then report_counts 1 0; else report_counts 0 1; exit 1; fi
EOF
    PROJ="$C/claude"; CPROJ="$PROJ/$(printf '%s' "$WT" | tr / -)"
    LOG="$C/runs.jsonl"
    SINCE=$(( $(date +%s) - 2 ))
    : > "$C/cmds"
}
# 在夹具 worktree 里真跑一次 run.sh；输出到 $C/out.<n>；返回 run.sh 的退出码
suite() {   # <n> [VAR=val ...]
    local n="$1"; shift
    (cd "$WT" && env "CAVIL_TEST_RUNS_LOG=$LOG" "$@" bash tests/run.sh quick -j 1 --out "$C/o.$n") > "$C/out.$n" 2>&1
}
rid() { sed -n 's/^cavil-test-run id=\([A-Za-z0-9._-]*\).*/\1/p' "$C/out.$1" | head -1; }
rec() { jq -r --arg id "$1" --arg ev "$2" 'select(.id==$id and .ev==$ev) | '"$3" "$LOG" 2>/dev/null | head -1; }
now() { python3 -c 'import time; print(f"{time.time():.3f}")'; }
add() { cmd_json "$@" >> "$C/cmds"; }   # 记一条会话命令

# 出 footer：真实 comment-footer.sh + 配置里的项目命令；读出总览和机器记录
# 出 footer 之前：Python 读到的当前时刻必须已过流水里最晚的时刻。统计按「本轮开始」到「统计那一刻」裁剪，
# 时钟若一时落后于 run.sh 记下的时刻（CI 上 shell 的 date 与 Python 的时钟），已结束的运行会被截掉一截，
# 两次 footer 得出不同秒数（GitHub#291，推断、未证实）。最多等 5 秒；真等了就印一行，CI 日志里留证据。
# 每次出 footer 的时刻记进 FOOTER_DIAG，检查失败时连同流水一起打印。
FOOTER_DIAG=""
log_latest() { python3 - "$LOG" <<'PY'
import json, sys, time
hi = None
try:
    for line in open(sys.argv[1]):
        try:
            d = json.loads(line)
        except ValueError:
            continue
        for k in ("t", "t0"):
            v = d.get(k) if isinstance(d, dict) else None
            if isinstance(v, (int, float)):
                hi = v if hi is None else max(hi, v)
except OSError:
    pass
now = time.time()
if hi is not None and now <= hi:
    end = now + 5
    while time.time() <= hi and time.time() < end:
        time.sleep(0.02)
    print(f"waited={time.time() - now:.3f} latest={hi:.3f} py_before={now:.3f}")
else:
    print(f"waited=0 latest={hi} py_before={now:.3f}")
PY
}
footer_diag() {   # 失败时附在检查名后面的诊断：本轮开始、流水各行、每次出 footer 时的时刻
    printf '诊断：since=%s 流水=[%s] footer=[%s]' "$SINCE" \
        "$(jq -rc '[.ev, .id[0:8], .t0, .t] | map(tostring) | join(" ")' "$LOG" 2>/dev/null | paste -sd ';' -)" "$FOOTER_DIAG"
}
footer() {   # <scripts 目录> [agent]
    local sd="$1" agent="${2:-claude}" w
    w=$(log_latest)
    case "$w" in waited=0\ *) ;; *) echo "  ⏱ 出 footer 前 Python 时钟落后于流水，已等待：$w" >&2 ;; esac
    FOOTER_DIAG+="${FOOTER_DIAG:+; }$agent $w"
    [ -s "$C/cmds" ] && { rm -rf "$CPROJ"; mk_claude "$CPROJ" "$WT" "$C/cmds"; }
    printf '#!/usr/bin/env bash\nexit 0\n' > "$C/driver.sh"
    printf "COMMENT_FOOTER_EXTRA_CMD=%q\n" "bash '$sd/drivers/token-usage/test-time.sh'" > "$C/config"
    (cd "$WT" && CLAUDE_PROJECTS_DIR="$PROJ" CODEX_SESSIONS_DIR="$C/codex" CAVIL_TEST_RUNS_LOG="$LOG" \
        bash "$REPO_DIR/scripts/drivers/token-usage/comment-footer.sh" --agent "$agent" --driver "$C/driver.sh" \
        --config "$C/config" --start "$(date -d "@$SINCE" '+%Y-%m-%d %H:%M:%S')" --wt 9) > "$C/footer" 2>&1
    HEAD=$(sed -n 's/^<details><summary>\(.*\)<\/summary>$/\1/p' "$C/footer" | head -1)
    MARK=$(grep '^<!-- agent-metrics ' "$C/footer" | tail -1)
}
mk() { printf '%s\n' "$MARK" | tr ' ' '\n' | sed -n "s/^$1=//p" | head -1; }

# ── 全部检查：用给定的 scripts 目录和 run.sh 跑，打印 PASS/FAIL <名字> ──────────────
run_check() {   # <scripts 目录> <run.sh>
    local SD="$1" RS="$2" a b t0 t1 x
    local -A WIN_U=() WIN_A=() WIN_S=()
    chk() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1 :: ${3:-}"; fi; }

    # 1 前台整套测试：编号印在输出里，按流水计时
    new_case fg "$RS"; t=$(now); suite 1; t1=$(now)
    a=$(rid 1)
    chk id_printed '[ -n "$a" ] && [ "$(rec "$a" start .id)" = "$a" ]' "输出里没有编号或流水里没有开始行：$(head -2 "$C/out.1")"
    add u1 "$t" "bash tests/run.sh quick -j 1" 0 "$t1" "$(cat "$C/out.1")" 0
    footer "$SD"
    # 流水缺字段（负对照改坏记账时）就留空，检查照样判红，不在输出里留 Python 报错
    x=$(python3 -c "print(round($(rec "$a" end .t) - $(rec "$a" end .t0), 3))" 2>/dev/null)
    chk fg_timed '[ -n "$x" ] && [ "$(mk suite_timed)" = 1 ] && python3 -c "import sys; sys.exit(abs(float(\"$(mk test_secs)\") - $x) > 0.002)" 2>/dev/null && [[ "$HEAD" == *"测试 "* ]] && [[ "$HEAD" != *"测试未知"* ]]' \
        "期望按流水计 [$x] 秒，实得 [$(mk test_secs)] / $HEAD / $(footer_diag)"

    # 2 复审第 2 轮反例：agent 的甲没写进流水；人 10 秒后（这里紧接着）手跑的乙有完整流水、不在会话里
    new_case neighbor "$RS"; mkdir -p "$C/ro"; chmod 555 "$C/ro"
    t=$(now); suite 1 CAVIL_TEST_RUNS_LOG="$C/ro/x/runs.jsonl"; t1=$(now)
    suite 2
    a=$(rid 1); b=$(rid 2)
    chk log_failed_printed 'grep -q "^cavil-test-run id=$a log=failed" "$C/out.1"' "$(head -1 "$C/out.1")"
    add u1 "$t" "bash tests/run.sh quick" 0 "$t1" "$(cat "$C/out.1")" 0
    footer "$SD"
    chk neighbor_not_claimed '[ "$(mk suite_runs)" = 2 ] && [ "$(mk suite_timed)" = 1 ] && [ "$(mk suite_unlogged)" = 1 ] && grep -q "另有 1 次未计时" "$C/footer"' \
        "期望 2 次（乙计时、甲没有记账），实得 runs=$(mk suite_runs) timed=$(mk suite_timed) unlogged=$(mk suite_unlogged)"

    # 3 同一 agent 并发两次：一次流水完整、一次没写进去，各认各的编号
    new_case concurrent "$RS"; mkdir -p "$C/ro"; chmod 555 "$C/ro"
    t=$(now)
    suite 1 & suite 2 CAVIL_TEST_RUNS_LOG="$C/ro/x/runs.jsonl" & wait
    t1=$(now)
    add u1 "$t" "bash tests/run.sh quick" 0 "$t1" "$(cat "$C/out.1")" 0
    add u2 "$t" "bash tests/run.sh quick" 0 "$t1" "$(cat "$C/out.2")" 0
    footer "$SD"
    chk concurrent_own_ids '[ "$(mk suite_runs)" = 2 ] && [ "$(mk suite_timed)" = 1 ] && [ "$(mk suite_unlogged)" = 1 ]' \
        "实得 runs=$(mk suite_runs) timed=$(mk suite_timed) unlogged=$(mk suite_unlogged)"

    # 4 后台整套测试：编号从工具结果写明的输出文件里读
    new_case bg "$RS"; t=$(now); suite 1; cp "$C/out.1" "$C/task.output"
    add u1 "$t" "bash tests/run.sh quick" 1 "$t" "$(bg_text "$C/task.output")" 0
    footer "$SD"
    chk bg_linked '[ "$(mk suite_runs)" = 1 ] && [ "$(mk suite_timed)" = 1 ] && [ "$(mk suite_unlinked)" = 0 ]' \
        "实得 runs=$(mk suite_runs) timed=$(mk suite_timed) unlinked=$(mk suite_unlinked)"
    # 前台命令超时被挪到后台（工具结果以那句话开头）：同样去输出文件里找编号，不按工具结果的时刻计时
    rm -rf "$CPROJ"; : > "$C/cmds"
    add m1 "$t" "bash tests/run.sh quick" 0 "$(python3 -c "print($t+120)")" \
        "Command did not complete within its 120s timeout and was moved to the background (ID: bx1). $(bg_text "$C/task.output" | sed 's/^Command running in background with ID: [^.]*\. //')" 0
    add m2 "$t" "bash tests/autopilot.test.sh" 0 "$(python3 -c "print($t+120)")" \
        "Command did not complete within its 120s timeout and was moved to the background (ID: bx2). Output is being written to: $C/none.output." 0
    footer "$SD"
    chk moved_to_bg '[ "$(mk suite_timed)" = 1 ] && [ "$(mk suite_runs)" = 1 ] && [ "$(mk adhoc_untimed)" = 1 ] && [ "$(mk adhoc_timed)" = 0 ]' \
        "实得 suite runs=$(mk suite_runs) timed=$(mk suite_timed) adhoc timed=$(mk adhoc_timed) untimed=$(mk adhoc_untimed)"
    : > "$C/cmds"; add u1 "$t" "bash tests/run.sh quick" 1 "$t" "$(bg_text "$C/task.output")" 0
    # 输出文件没了：这条命令「无法关联」，流水里那次照样单独计时（次数多 1、秒数不多）
    rm -f "$C/task.output"; rm -rf "$CPROJ"; footer "$SD"
    chk bg_output_gone '[ "$(mk suite_unlinked)" = 1 ] && [ "$(mk suite_timed)" = 1 ] && [ "$(mk suite_runs)" = 2 ]' \
        "实得 runs=$(mk suite_runs) timed=$(mk suite_timed) unlinked=$(mk suite_unlinked)"

    # 5 流水只读（旧内容读得到、新行写不进）：不能报 0
    new_case readonly "$RS"; suite 0; chmod 444 "$LOG"
    sleep 1.1; SINCE=$(date +%s)        # 旧内容那次在派工开始之前，不算本轮
    t=$(now); suite 1; t1=$(now)
    add u1 "$t" "bash tests/run.sh quick" 0 "$t1" "$(cat "$C/out.1")" 0
    footer "$SD"
    chk readonly_log_not_zero '[ -z "$(mk test_secs)" ] && [ "$(mk suite_runs)" = 1 ] && [ "$(mk suite_unlogged)" = 1 ] && [[ "$HEAD" == *"测试未知"* ]]' \
        "实得 test_secs=[$(mk test_secs)] unlogged=$(mk suite_unlogged) / $HEAD"
    chmod 644 "$LOG"

    # 6 只有开始行（run.sh 被 kill -9，没来得及写结束行）
    new_case killed "$RS"; t=$(now)
    # setsid：run.sh 和它起的测试在一个进程组里，一起 kill -9（不留后台的 sleep）
    (cd "$WT" && FIX_SLEEP=30 CAVIL_TEST_RUNS_LOG="$LOG" exec setsid bash tests/run.sh quick -j 1 --out "$C/o.1") > "$C/out.1" 2>&1 &
    x=$!
    for _ in $(seq 50); do [ -s "$LOG" ] && break; sleep 0.1; done
    sleep 0.3; kill -9 -- "-$x" 2>/dev/null; wait "$x" 2>/dev/null
    t1=$(now)
    add u1 "$t" "bash tests/run.sh quick" 0 "$t1" "$(cat "$C/out.1")" 1
    footer "$SD"
    chk start_only_unfinished '[ "$(mk suite_unfinished)" = 1 ] && [[ "$HEAD" == *"测试未知"* ]]' \
        "实得 unfinished=$(mk suite_unfinished) / $HEAD"

    # 7 只有结束行（开始行丢了）：结束行自带开始时刻，照样计时；坏行跳过
    new_case endonly "$RS"; t=$(now); suite 1; t1=$(now)
    a=$(rid 1); jq -c --arg id "$a" 'select(.ev != "start")' "$LOG" > "$C/l2"; { echo 'not json'; cat "$C/l2"; } > "$LOG"
    add u1 "$t" "bash tests/run.sh quick" 0 "$t1" "$(cat "$C/out.1")" 0
    footer "$SD"
    chk end_only_timed '[ "$(mk suite_timed)" = 1 ] && [ "$(mk test_secs)" != "" ] && grep -q "1 行读不懂" "$C/footer"' \
        "实得 timed=$(mk suite_timed) test_secs=[$(mk test_secs)]"

    # 8 失败的运行：退出码记进结束行，细节写「1 次红」
    new_case red "$RS"; t=$(now); suite 1 FIX_RC=1; t1=$(now)
    chk red_exit_recorded '[ "$(rec "$(rid 1)" end .exit)" = 1 ]' "结束行 exit=[$(rec "$(rid 1)" end .exit)]"
    add u1 "$t" "bash tests/run.sh quick" 0 "$t1" "$(cat "$C/out.1")" 1
    footer "$SD"
    chk red_counted '[ "$(mk suite_failed)" = 1 ] && grep -q "1 次红" "$C/footer"' "实得 failed=$(mk suite_failed)"

    # 9 流水读不了 / 会话读不了 / 两栏都读不了
    new_case unreadable "$RS"; suite 1; chmod 000 "$LOG"
    t=$(now); add u1 "$t" "bash tests/autopilot.test.sh" 0 "$(python3 -c "print($t+3)")" "ok" 0
    footer "$SD"
    chk log_unreadable_unknown '[[ "$HEAD" == *"测试未知"* ]] && [ "$(mk suite_read)" = failed ] && grep -q "流水读不了" "$C/footer"' "$HEAD"
    rm -rf "$CPROJ"; : > "$C/cmds"; footer "$SD"
    chk both_unreadable '[[ "$HEAD" == *"测试未知"* ]] && grep -q "测试统计没取到" "$C/footer"' "$HEAD"
    chmod 644 "$LOG"; footer "$SD"
    chk session_unreadable_unknown '[[ "$HEAD" == *"测试未知"* ]] && [ "$(mk adhoc_read)" = failed ]' "$HEAD"

    # 10 嵌套：继承了编号、或用夹具测试目录跑，都不记账、不印编号
    new_case nested "$RS"; suite 1 CAVIL_TEST_RUN_ID=outer; suite 2 CAVIL_TEST_RUNS_LOG= RUN_TESTS_DIR="$WT/tests"
    chk nested_silent '[ ! -s "$LOG" ] && ! grep -q "^cavil-test-run" "$C/out.1" "$C/out.2"' "$(cat "$LOG" 2>/dev/null | head -2)"

    # 11 单跑：前台计时（并行取并集）；后台只计次 → 未知；引号 / here-doc / --list 不算 → 0
    new_case adhoc "$RS"
    SINCE=$(( $(date +%s) - 60 )); t=$(( SINCE + 5 ))
    add a1 "$t" "cd tests && MUTATION=1 timeout 600 bash ./autopilot.test.sh" 0 "$(python3 -c "print($t+4)")" "ok" 0
    add a2 "$(python3 -c "print($t+2)")" "npm --prefix client test" 0 "$(python3 -c "print($t+6)")" "Exit code 1" 1
    footer "$SD"
    chk adhoc_union '[ "$(mk test_secs)" = 6 ] && [ "$(mk adhoc_runs)" = 2 ] && [ "$(mk adhoc_failed)" = 1 ]' \
        "期望并集 6 秒，实得 [$(mk test_secs)] runs=$(mk adhoc_runs) failed=$(mk adhoc_failed)"
    rm -rf "$CPROJ"; : > "$C/cmds"
    add b1 "$t" "bash tests/autopilot.test.sh" 1 "$t" "$(bg_text "$C/none.output")" 0
    footer "$SD"
    chk adhoc_bg_unknown '[[ "$HEAD" == *"测试未知"* ]] && [ "$(mk adhoc_untimed)" = 1 ]' "$HEAD"
    rm -rf "$CPROJ"; : > "$C/cmds"
    add q1 "$t" 'echo "bash tests/run.sh" && grep -n x tests/autopilot.test.sh' 0 "$(python3 -c "print($t+1)")" "" 0
    add q2 "$t" $'cat > /tmp/x <<EOF\nbash tests/run.sh\nnpm test\nEOF' 0 "$(python3 -c "print($t+1)")" "" 0
    add q3 "$t" "bash tests/run.sh --list" 0 "$(python3 -c "print($t+1)")" "1 a" 0
    add q4 "$t" "bash -n tests/run.sh && bash -n tests/autopilot.test.sh" 0 "$(python3 -c "print($t+1)")" "" 0
    footer "$SD"
    chk no_tests_zero '[ "$(mk test_secs)" = 0 ] && [[ "$HEAD" != *"测试"* ]] && grep -q "本轮未跑测试" "$C/footer"' \
        "实得 test_secs=[$(mk test_secs)] / $HEAD"

    # 12 codex：逐条命令拿它自己的输出（含同一 session_id 的后续轮询），别处印出的编号一概不认
    #    形状照本机真实 rollout：exec 单元 = 一串 `text(await tools.X({…}));`，输出列表首项「Script completed」头、
    #    之后每条语句一项；exec_command 那一项是 JSON（output / wall_time_seconds / exit_code 或 session_id）
    # 12a 一个单元三条整套命令：一次记进去了、一次印了编号但没写进流水、一次输出被截断没有编号
    new_case codex "$RS"; mkdir -p "$C/ro"; chmod 555 "$C/ro"
    t=$(now); suite 1; suite 2 CAVIL_TEST_RUNS_LOG="$C/ro/x/runs.jsonl"
    cx_spec "$t" cell \
        "$(cx_exec "bash tests/run.sh quick -j 1" "$(cat "$C/out.1")" 2 0)" \
        "$(cx_exec "env -u MUTATION bash tests/run.sh quick" "$(cat "$C/out.2")" 2 0)" \
        "$(cx_exec "bash tests/run.sh quick" "…(truncated)" 2 0)"
    footer "$SD" codex
    chk codex_by_id '[ "$(mk suite_timed)" = 1 ] && [ "$(mk suite_unlogged)" = 1 ] && [ "$(mk suite_unlinked)" = 1 ] && [ "$(mk suite_runs)" = 3 ]' \
        "实得 runs=$(mk suite_runs) timed=$(mk suite_timed) unlogged=$(mk suite_unlogged) unlinked=$(mk suite_unlinked)"

    # 12b #247 复审第 1 轮反例：甲的输出没有编号、也没写进流水；另一条 `cat` 印出人手跑的乙的编号
    new_case codex_other "$RS"; mkdir -p "$C/ro"; chmod 555 "$C/ro"
    t=$(now); suite 1 CAVIL_TEST_RUNS_LOG="$C/ro/x/runs.jsonl"; suite 2
    cx_spec "$t" cell "$(cx_exec "bash tests/run.sh --quick" "(output truncated)" 2 0)"
    cx_spec "$(python3 -c "print($t+5)")" cell "$(cx_exec "cat /tmp/human-run-output" "$(cat "$C/out.2")" 0.1 0)"
    footer "$SD" codex
    chk codex_other_output_not_claimed '[ "$(mk suite_runs)" = 2 ] && [ "$(mk suite_unlinked)" = 1 ] && [ "$(mk suite_timed)" = 1 ]' \
        "期望甲无法关联、乙按流水计，实得 runs=$(mk suite_runs) unlinked=$(mk suite_unlinked) timed=$(mk suite_timed)"

    # 12c 标准函数调用（arguments 是 JSON）：单跑测试照样认出、按 wall_time_seconds 计时；没有输出 → 不计时 → 未知
    new_case codex_json "$RS"
    SINCE=$(( $(date +%s) - 60 )); t=$(( SINCE + 5 ))
    cx_spec "$t" fc exec_command '{"cmd":"bash tests/comment-footer.test.sh","yield_time_ms":1000}' \
        '{"chunk_id":"a1","wall_time_seconds":2.5,"exit_code":0,"output":"ok\n"}'
    footer "$SD" codex
    chk codex_json_args '[ "$(mk adhoc_runs)" = 1 ] && [ "$(mk test_secs)" = 2.5 ]' "实得 adhoc=$(mk adhoc_runs) test_secs=[$(mk test_secs)]"
    rm -rf "$C/codex"; cx_spec "$t" fc exec_command '{"cmd":"bash tests/comment-footer.test.sh"}' ""
    footer "$SD" codex
    chk codex_json_no_output_unknown '[ "$(mk adhoc_runs)" = 1 ] && [[ "$HEAD" == *"测试未知"* ]]' "$HEAD"

    # 12d 长命令：第一项只有 session_id、没有编号；之后 write_stdin 轮询到的输出里才有 → 仍按编号认领
    #     另一个 session 的轮询输出里印的编号不算
    new_case codex_poll "$RS"; mkdir -p "$C/ro"; chmod 555 "$C/ro"
    t=$(now); suite 1; suite 2 CAVIL_TEST_RUNS_LOG="$C/ro/x/runs.jsonl"
    cx_spec "$t" cell "$(cx_exec "bash tests/run.sh quick" "" 1 "" 71)" "$(cx_exec "bash tests/run.sh quick" "" 1 "" 72)"
    cx_spec "$(python3 -c "print($t+3)")" cell "$(cx_poll 71 "$(cat "$C/out.1")" 0)"
    footer "$SD" codex
    chk codex_poll_linked '[ "$(mk suite_runs)" = 2 ] && [ "$(mk suite_timed)" = 1 ] && [ "$(mk suite_unlinked)" = 1 ]' \
        "实得 runs=$(mk suite_runs) timed=$(mk suite_timed) unlinked=$(mk suite_unlinked)"

    # 12e 不是纯 text(await …) 序列的单元：命令照样认（整套记「无法关联」），输出不归给任何一条；
    #     写法认不出来的 exec_command（模板字符串）→ 不算 0
    new_case codex_raw "$RS"
    t=$(now); suite 1
    cx_spec "$t" raw 'const r = await tools.exec_command({cmd:"bash tests/run.sh quick"});
text(r);' "$(cat "$C/out.1")"
    footer "$SD" codex
    chk codex_unaligned_unlinked '[ "$(mk suite_unlinked)" = 1 ] && [ "$(mk suite_runs)" = 2 ]' \
        "实得 runs=$(mk suite_runs) unlinked=$(mk suite_unlinked)"
    # 两条语句、只有一项输出：对不上号，哪条都不归
    rm -rf "$C/codex"
    cx_spec "$t" raw 'text(await tools.exec_command({cmd:"bash tests/run.sh quick"}));
text(await tools.exec_command({cmd:"cat /tmp/x"}));' "$(cat "$C/out.1")"
    footer "$SD" codex
    chk codex_misaligned_unlinked '[ "$(mk suite_unlinked)" = 1 ] && [ "$(mk suite_runs)" = 2 ]' \
        "实得 runs=$(mk suite_runs) unlinked=$(mk suite_unlinked)"
    rm -rf "$C/codex"; : > "$LOG"
    cx_spec "$t" raw 'text(await tools.exec_command({cmd:`bash tests/run.sh`}));' 'x'
    footer "$SD" codex
    chk codex_unparsed_not_zero '[ "$(mk cmd_unparsed)" = 1 ] && [ -z "$(mk test_secs)" ] && [[ "$HEAD" == *"测试未知"* ]]' \
        "实得 unparsed=$(mk cmd_unparsed) test_secs=[$(mk test_secs)] / $HEAD"

    # 12g 本轮时间窗（#247 复审第 2 轮）：凡「属于本轮」都按调用发出时刻 ≥ 本轮开始判，各条路径同一条件。
    #     本轮开始前的调用——解析不了的、非纯单元里认出的、纯单元里的、标准函数调用——一概不进本轮；
    #     恰好在开始那一刻、和开始之后的照算
    new_case window "$RS"
    SINCE=$(( $(date +%s) - 100 ))
    for at in -10 0; do   # 窗口前 10 秒、恰在边界
        t=$(( SINCE + at ))
        rm -rf "$C/codex"
        cx_spec "$t" raw 'const r = await tools.exec_command({cmd:`bash tests/run.sh --quick`}); text(r);' 'ok'
        cx_spec "$t" raw 'const r = await tools.exec_command({cmd:"bash tests/autopilot.test.sh"}); text(r);' 'ok'
        cx_spec "$t" cell "$(cx_exec "bash tests/comment-footer.test.sh" "ok" 2 0)"
        cx_spec "$t" fc exec_command '{"cmd":"bash tests/smoke.test.sh"}' '{"wall_time_seconds":1,"exit_code":0,"output":"ok"}'
        cx_spec "$t" fc exec_command 'not json' ''
        footer "$SD" codex
        WIN_U[$at]=$(mk cmd_unparsed); WIN_A[$at]=$(mk adhoc_runs); WIN_S[$at]=$(mk test_secs)
    done
    chk window_before_excluded '[ "${WIN_U[-10]}" = 0 ] && [ "${WIN_A[-10]}" = 0 ] && [ "${WIN_S[-10]}" = 0 ]' \
        "窗口前：期望全 0，实得 unparsed=${WIN_U[-10]} adhoc=${WIN_A[-10]} test_secs=[${WIN_S[-10]}]"
    chk window_boundary_included '[ "${WIN_U[0]}" = 2 ] && [ "${WIN_A[0]}" = 3 ]' \
        "恰在边界：期望 unparsed=2 adhoc=3，实得 unparsed=${WIN_U[0]} adhoc=${WIN_A[0]}"
    # 旧命令（窗口前发出、带 session_id）在窗口内才被轮询到结束：它仍是旧命令，不算本轮；它印的编号也认不领本轮的运行
    rm -rf "$C/codex"; : > "$LOG"
    cx_spec "$(( SINCE - 20 ))" cell "$(cx_exec "bash tests/run.sh quick" "" 1 "" 91)"
    cx_spec "$(( SINCE + 5 ))" cell "$(cx_poll 91 "cavil-test-run id=old-run" 0)"
    footer "$SD" codex
    chk window_old_polled_excluded '[ "$(mk suite_runs)" = 0 ] && [ "$(mk test_secs)" = 0 ]' \
        "实得 runs=$(mk suite_runs) test_secs=[$(mk test_secs)]"
    # 同一条件在 Claude 那一侧：窗口前的命令不算，恰在边界的算
    rm -rf "$C/codex"; : > "$C/cmds"
    add w1 "$(( SINCE - 10 ))" "bash tests/autopilot.test.sh" 0 "$(( SINCE - 5 ))" "ok" 0
    footer "$SD" claude; a=$(mk adhoc_runs)
    add w2 "$SINCE" "bash tests/autopilot.test.sh" 0 "$(( SINCE + 3 ))" "ok" 0
    footer "$SD" claude; b=$(mk adhoc_runs)
    chk window_claude_same '[ "$a" = 0 ] && [ "$b" = 1 ]' "窗口前 adhoc=$a（期望 0），加上边界那条后 adhoc=$b（期望 1）"

    # 12f 同一场景两种 agent 的记录：整套测试的结论必须一字不差（同一套规则，L3）
    new_case same "$RS"; mkdir -p "$C/ro"; chmod 555 "$C/ro"
    t=$(now); suite 1 CAVIL_TEST_RUNS_LOG="$C/ro/x/runs.jsonl"; t1=$(now); suite 2
    add u1 "$t" "bash tests/run.sh quick" 0 "$t1" "$(cat "$C/out.1")" 0
    add u2 "$t1" "cat /tmp/x" 0 "$t1" "$(cat "$C/out.2")" 0
    cx_spec "$t" cell "$(cx_exec "bash tests/run.sh quick" "$(cat "$C/out.1")" 1 0)"
    cx_spec "$t1" cell "$(cx_exec "cat /tmp/x" "$(cat "$C/out.2")" 0 0)"
    footer "$SD" claude; a=$(printf '%s\n' "$MARK" | tr ' ' '\n' | grep '^suite_' | sort)
    footer "$SD" codex;  b=$(printf '%s\n' "$MARK" | tr ' ' '\n' | grep '^suite_' | sort)
    chk claude_codex_same '[ -n "$a" ] && [ "$a" = "$b" ] && printf "%s\n" "$a" | grep -qx "suite_runs=2"' "claude：$(echo $a) / codex：$(echo $b) / $(footer_diag)"

    # 13 文档里那一行配置原样跑：部署前空窗（入口不在）→ 测试未知；装上入口 → 照常统计；清空 → 总览不提测试
    new_case gap "$RS"; printf '#!/usr/bin/env bash\nexit 0\n' > "$C/driver.sh"
    printf '%s\n' "$DOC_LINE" > "$C/config"
    gap_footer() { (cd "$WT" && CLAUDE_PROJECTS_DIR="$PROJ" CAVIL_TEST_RUNS_LOG="$LOG" \
        bash "$REPO_DIR/scripts/drivers/token-usage/comment-footer.sh" --agent claude --driver "$C/driver.sh" \
        --config "$C/config" --start "$(date -d "@$SINCE" '+%Y-%m-%d %H:%M:%S')" --wt 9) > "$C/footer" 2>&1; }
    gap_footer
    chk deploy_gap 'grep -q "测试未知" "$C/footer" && grep -q "测试统计命令尚未部署" "$C/footer"' "$(head -3 "$C/footer")"
    x="$HOME/.agents/releases/cavil-loop/entrypoints/drivers/token-usage"; mkdir -p "$x"
    ln -sfn "$SD/drivers/token-usage/test-time.sh" "$x/test-time.sh"
    t=$(now); suite 1; t1=$(now)
    add u1 "$t" "bash tests/run.sh quick" 0 "$t1" "$(cat "$C/out.1")" 0; mk_claude "$CPROJ" "$WT" "$C/cmds"
    gap_footer; rm -rf "$HOME/.agents"
    chk doc_line_deployed 'grep -q "suite_timed=1" "$C/footer" && grep -q "测试 " "$C/footer" && ! grep -q "测试未知" "$C/footer"' "$(head -3 "$C/footer")"
    printf 'COMMENT_FOOTER_EXTRA_CMD=""\n' > "$C/config"; gap_footer
    chk doc_line_undo '! grep -q "测试" "$C/footer" && ! grep -q "suite_" "$C/footer"' "$(head -3 "$C/footer")"
}

# 本机配置那一行：文档两份、配置样例、入口脚本头注释四处必须一字不差，测试原样跑它（不另写一份）
DOC_LINE=""; same=1
for f in docs/operations.md docs/operations.zh.md cavil-loop.config.example scripts/drivers/token-usage/test-time.sh; do
    l=$(grep -m1 "COMMENT_FOOTER_EXTRA_CMD='f=" "$REPO_DIR/$f" | sed 's/^[#[:space:]]*//')
    [ -n "$l" ] || { same=0; echo "  （$f 里没有那一行配置）"; continue; }
    if [ -z "$DOC_LINE" ]; then DOC_LINE="$l"; elif [ "$l" != "$DOC_LINE" ]; then same=0; echo "  （$f 那一行和别处不同）"; fi
done
if [ "$same" = 1 ] && [ -n "$DOC_LINE" ]; then ok "四处写的本机配置那一行一字不差"; else bad "四处写的本机配置那一行不一致或缺失"; fi

echo "【1】真实路径上的全部检查"
while IFS= read -r l; do
    case "$l" in
        PASS\ *) ok "${l#PASS }" ;;
        FAIL\ *) n="${l#FAIL }"; bad "${n%% ::*}" "${n#* :: }" ;;
    esac
done <<< "$(run_check "$REPO_DIR/scripts" "$REPO_DIR/tests/run.sh")"

# 【2】负对照：沙盘副本逐个改坏，对应检查必须变红
echo "【2】负对照（改坏一处，对应检查必须变红）"
neg() { # $1 说明；$2 文件（相对仓库根）；$3 原文；$4 改成；$5 期望变红的检查名
    mutation_gate || return 0
    local sb="$TMP/neg/$5.$MUTATION_COUNT"
    rm -rf "$sb"; mkdir -p "$sb/tests"; cp -r "$REPO_DIR/scripts" "$sb/scripts"; cp "$REPO_DIR/tests/run.sh" "$sb/tests/run.sh"
    python3 - "$sb/$2" "$3" "$4" <<'PY' || { bad "$1：改坏失败（原文没找到）"; return; }
import sys
p, old, new = sys.argv[1:4]
s = open(p).read()
if old not in s:
    sys.exit(1)
open(p, "w").write(s.replace(old, new, 1))
PY
    run_check "$sb/scripts" "$sb/tests/run.sh" > "$sb/check.out"
    if grep -q "^FAIL $5 " "$sb/check.out"; then ok "$1 → $5 变红"
    else bad "$1 → $5 没变红（这条检查拦不住这种改坏）"; fi
}
TT=scripts/drivers/token-usage/test_time.py
neg "测试秒数逐段相加、不取并集" $TT \
    's["secs"] = union_secs(s["spans"], since, now)' 's["secs"] = sum(b - a for a, b in s["spans"])' adhoc_union
neg "第 1 版：会话里的整套测试命令整个不看" $TT \
    '        if k["suite"]:
            # 只认' '        if False:
            # 只认' readonly_log_not_zero
neg "第 2 版：按开始时刻接近认领流水" $TT \
    'found = [i for i in RUN_MARK.findall(c["text"] or "") if i not in claimed]' \
    'found = [i for i, r in runs.items() if i not in claimed and r["t0"] is not None and c["t"] - 5 <= r["t0"] <= c["t"] + 120][:1]' \
    neighbor_not_claimed
neg "有运行证据、一秒没计上时答 0" $TT \
    '    elif runs > 0 or unparsed:
        answer = "unknown"' '    elif unparsed:
        answer = "unknown"' start_only_unfinished
neg "某一栏读取失败时照常给秒数" $TT \
    '    if not read_ok:
        answer = "unknown"' '    if False:
        answer = "unknown"' log_unreadable_unknown
neg "结束行不带开始时刻（只有结束行时不计时）" tests/run.sh \
    "'{ev:\"end\",id:\$id,wt:\$wt,t0:\$t0," "'{ev:\"end\",id:\$id,wt:\$wt," end_only_timed
neg "嵌套运行也记账" tests/run.sh \
    'if [ -z "${CAVIL_TEST_RUN_ID:-}" ] && {' 'if {' nested_silent
neg "记账失败时不印编号" tests/run.sh \
    '        echo "cavil-test-run id=$CAVIL_TEST_RUN_ID log=failed"' '        :' neighbor_not_claimed
neg "后台命令不读输出文件" $TT \
    '        if u["bg"] and res:' '        if False:' bg_linked
neg "前台超时挪到后台的命令按工具结果时刻计时" $TT \
    '        if res and not u["bg"] and MOVED_BG.match(res["text"]):' '        if False:' moved_to_bg
neg "#247 复审第 1 轮：本会话任意命令输出里的编号都拿来认领" $TT \
    'found = [i for i in RUN_MARK.findall(c["text"] or "") if i not in claimed]' \
    'found = [i for x in cmds for i in RUN_MARK.findall(x["text"] or "") if i not in claimed][:1]' \
    codex_other_output_not_claimed
neg "codex 标准函数调用的 JSON 参数不解析" $TT \
    '                        fields = json.loads(pl.get("arguments") or "")' '                        fields = None' codex_json_args
neg "codex 轮询到的后续输出不归回原命令" $TT \
    '                c["text"] = (c["text"] or "") + body' '                pass' codex_poll_linked
neg "codex 单元的语句数和输出项数对不上也照顺序配" $TT \
    'and len(items) - 1 == len(stmts))' ')' codex_misaligned_unlinked
neg "#247 复审第 2 轮：解析失败计数不按本轮时间窗筛" $TT \
    'sum(1 for x in bad if x >= since)' 'len(bad)' window_before_excluded
neg "codex 命令不按本轮时间窗筛" $TT \
    '[c for c in cmds if c["call_t"] >= since]' 'cmds' window_before_excluded
neg "解析不了的命令不影响回答（可能答 0）" $TT \
    '    elif runs > 0 or unparsed:' '    elif runs > 0:' codex_unparsed_not_zero

echo
mutation_summary "$0"
echo "通过 $pass，失败 $fail"
report_counts "$pass" "$fail"
[ "$fail" -eq 0 ]
