#!/usr/bin/env bash
# kind: e2e
# 评论 footer 的「远端 CI」一段（GitHub#293）：认出 agent 等 GitHub Actions 的命令，按会话记录定起止、
# 扣掉 AI 时间，总览单独成一段，细节逐条列出，机器记录写三个汇总字段。
#
# 跑法：bash tests/footer-ci-wait.test.sh
# 依赖：python3、jq、git。不碰网络、不读本机真实会话（HOME、会话目录都指到临时目录）。
#
# 全部走真实路径：真实用量驱动（claude.sh / codex.sh）→ 真实 comment-footer.sh → 输出文本；断言从 footer
# 的总览、细节和末行机器记录里读，不调内部函数。会话夹具照本机真实记录的形状写：Claude 的工具调用 /
# 工具结果两条主记录（外加不带时刻的重复副本），后台任务结束是一条排队记录 + 一条进对话的通知、都带
# tool-use-id，Monitor 运行中的事件通知不带 tool-use-id；codex 是 exec 单元 + 输出列表、后续 write_stdin 轮询。
#
# 覆盖：
#   【1】#286 的形状：后台循环等 Release 运行、结束通知收尾 → 总览「远端 CI 约 1h 50m 30s」、各段相加 = 总耗时
#   【2】认法：前台 gh run watch、前台 gh pr checks --watch、Monitor 循环（中途事件不算结束）、前台超时挪到后台、
#        写在双引号里的 $( … )；不该认的单次查询 / 触发运行 / 轮询评论 / 引号里的文字
#   【3】两条等待部分重叠、期间 AI 在工作：逐条时长各自完整，合计按并集再扣 AI
#   【4】没记到结束：部分 → 合计是下限；全部 → 「远端 CI 未知」、不写秒数字段
#   【5】上一轮派工的等待不算
#   【6】统计不出来（输出读不懂 / 脚本退出非 0 / 会话读不了）：footer 照常出，三个字段都不写，细节写原因
#   【7】codex：exec 单元里跑完的、靠轮询才结束的；同一场景 Claude 与 codex 两份夹具结论一致
#   【8】没有等待：footer 可见部分与合并基点逐字节相同，机器记录只多三个零值字段；
#        测试时间统计、驱动人读行和 --kv 行与合并基点逐字节相同
set -uo pipefail
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
TMP=$(mktemp -d)
trap '[ -n "${KEEP:-}" ] && echo "TMP=$TMP" || { chmod -R u+rwX "$TMP" 2>/dev/null; rm -rf "$TMP"; }' EXIT
export TZ=Asia/Shanghai
export HOME="$TMP/home"
export CLAUDE_PROJECTS_DIR="$HOME/.claude/projects"
mkdir -p "$CLAUDE_PROJECTS_DIR" "$HOME/.codex/sessions"

pass=0; fail=0
ok()  { echo "  ✅ $1"; pass=$((pass + 1)); }
bad() { echo "  ❌ $1"; [ -n "${2:-}" ] && printf '     %s\n' "$2"; fail=$((fail + 1)); }
eq()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "期望 [$3] 实得 [$2]"; fi; }
has() { if printf '%s\n' "$2" | grep -qF -- "$3"; then ok "$1"; else bad "$1" "没找到 [$3]"; fi; }
hasnt() { if printf '%s\n' "$2" | grep -qF -- "$3"; then bad "$1" "不该出现 [$3]"; else ok "$1"; fi; }

TU="$REPO_DIR/scripts/drivers/token-usage"
NOW=$(( $(date +%s) / 10 * 10 ))
# 时钟钉死：footer、驱动、统计脚本都读 time.time()；用 sitecustomize 钉在 NOW（生产代码不动）
CLOCK="$TMP/clock"; mkdir -p "$CLOCK"
cat > "$CLOCK/sitecustomize.py" <<'PY'
import os, time
_pin = os.environ.get("FOOTER_TEST_NOW")
if _pin:
    time.time = lambda: float(_pin)
PY
export FOOTER_TEST_NOW="$NOW" PYTHONPATH="$CLOCK"
: > "$TMP/empty.config"

# ── 夹具生成器：一个场景 = 若干事件（JSON，每行一个），时刻是相对本轮开始的秒数 ─────────────────
cat > "$TMP/fx.py" <<'PY'
import datetime, json, os, sys, uuid
agent, wt, start, spec = sys.argv[1], sys.argv[2], float(sys.argv[3]), sys.argv[4]
ev = [json.loads(l) for l in open(spec) if l.strip()]
iso = lambda x: datetime.datetime.fromtimestamp(start + x, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
USAGE = {"input_tokens": 10, "output_tokens": 20, "cache_read_input_tokens": 0,
         "cache_creation": {"ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": 0}}
recs = []   # (相对时刻, 次序, 记录)
def add(t, r):
    recs.append((t, len(recs), r))
if agent == "claude":
    d = os.path.join(os.environ["CLAUDE_PROJECTS_DIR"], wt.replace("/", "-")); os.makedirs(d, exist_ok=True)
    out = os.path.join(d, "s.jsonl")
    for e in ev:
        k = e["k"]
        if k == "ai":
            rid = "req_" + uuid.uuid4().hex[:8]
            add(e["a"], {"type": "api-request", "timestamp": iso(e["a"]), "querySource": "repl_main_thread"})
            add(e["b"], {"type": "assistant", "timestamp": iso(e["b"]), "isSidechain": False, "requestId": rid,
                         "message": {"model": "claude-test", "role": "assistant",
                                     "content": [{"type": "text", "text": "x"}], "usage": USAGE}})
        elif k in ("bash", "monitor"):
            inp = {"command": e["cmd"], "description": "x"}
            if e.get("bg"):
                inp["run_in_background"] = True
            use = {"type": "tool_use", "id": e["id"], "name": "Monitor" if k == "monitor" else "Bash", "input": inp}
            add(e["t"], {"type": "assistant", "timestamp": iso(e["t"]), "isSidechain": False,
                         "message": {"model": "claude-test", "role": "assistant", "content": [use]}})
            add(e["t"], {"type": "api-request-blob", "message": {"role": "assistant", "content": [use]}})
            if e.get("rt") is not None:
                res = {"tool_use_id": e["id"], "type": "tool_result", "content": e.get("text", "ok"), "is_error": False}
                add(e["rt"], {"type": "user", "isSidechain": False, "timestamp": iso(e["rt"]),
                              "message": {"role": "user", "content": [res]},
                              "toolUseResult": {"stdout": e.get("text", "ok"), "stderr": "", "interrupted": False}})
        elif k == "done":       # 后台任务结束：排队记录 + 进对话的通知，都带起它的工具调用编号
            body = ("<task-notification>\n<task-id>%s</task-id>\n<tool-use-id>%s</tool-use-id>\n"
                    "<output-file>/nonexistent/%s.output</output-file>\n<status>completed</status>\n"
                    "<summary>Background command completed</summary>\n</task-notification>") % (e["task"], e["id"], e["task"])
            add(e["t"], {"type": "queue-operation", "operation": "enqueue", "timestamp": iso(e["t"]), "content": body})
            add(e["t"] + 0.01, {"type": "queue-operation", "operation": "dequeue", "timestamp": iso(e["t"] + 0.01)})
            add(e["t"] + 0.05, {"type": "user", "isSidechain": False, "timestamp": iso(e["t"] + 0.05),
                                "message": {"role": "user", "content": body}})
        elif k == "event":      # Monitor 运行中的事件：不带 tool-use-id
            body = ("<task-notification>\n<task-id>%s</task-id>\n<summary>Monitor event: \"x\"</summary>\n"
                    "<event>shard 1/4: pass</event>\n</task-notification>") % e["task"]
            add(e["t"], {"type": "queue-operation", "operation": "enqueue", "timestamp": iso(e["t"]), "content": body})
            add(e["t"] + 0.05, {"type": "user", "isSidechain": False, "timestamp": iso(e["t"] + 0.05),
                                "message": {"role": "user", "content": body}})
else:
    dt = datetime.datetime.fromtimestamp(start)
    d = os.path.join(os.environ["HOME"], ".codex", "sessions", f"{dt:%Y}", f"{dt:%m}", f"{dt:%d}"); os.makedirs(d, exist_ok=True)
    out = os.path.join(d, "rollout-%s.jsonl" % os.path.basename(wt))
    add(-30, {"timestamp": iso(-30), "type": "session_meta", "payload": {"cwd": wt}})
    add(-30, {"timestamp": iso(-30), "type": "turn_context", "payload": {"model": "gpt-test"}})
    for e in ev:
        k = e["k"]
        if k == "ai":
            add(e["a"], {"timestamp": iso(e["a"]), "type": "event_msg",
                         "payload": {"type": "item_completed", "item": {"type": "UserMessage"}}})
            add(e["b"], {"timestamp": iso(e["b"]), "type": "token_usage_record",
                         "payload": {"usage": {"input_tokens": 100, "cached_input_tokens": 0, "output_tokens": 10}}})
        elif k == "cell":       # exec 单元：每条语句一行 text(await tools.X({…}));，输出 = 头 + 每条一项
            cid = "call_" + uuid.uuid4().hex[:12]
            lines, items = [], [{"type": "input_text", "text": "Script completed\nWall time 1.0 seconds\nOutput:\n"}]
            for st in e["stmts"]:
                res = {"chunk_id": uuid.uuid4().hex[:6], "wall_time_seconds": st["wall"]}
                if st.get("exit") is None and st.get("sid") is not None:
                    res["session_id"] = st["sid"]
                if st.get("exit") is not None:
                    res["exit_code"] = st["exit"]
                res["output"] = st.get("out", "")
                if "cmd" in st:
                    lines.append("text(await tools.exec_command({cmd:%s,\"yield_time_ms\":1000,\"max_output_tokens\":2000}));"
                                 % json.dumps(st["cmd"]))
                else:
                    lines.append("text(await tools.write_stdin({session_id:%d,chars:\"\",\"yield_time_ms\":30000}));" % st["poll"])
                items.append({"type": "input_text", "text": json.dumps(res, ensure_ascii=False)})
            add(e["t"], {"timestamp": iso(e["t"]), "type": "response_item",
                         "payload": {"type": "custom_tool_call", "call_id": cid, "name": "exec", "input": "\n".join(lines) + "\n"}})
            add(e["t"] + e.get("out_after", 1), {"timestamp": iso(e["t"] + e.get("out_after", 1)), "type": "response_item",
                                                 "payload": {"type": "custom_tool_call_output", "call_id": cid, "output": items}})
with open(out, "w") as f:
    for _, _, r in sorted(recs, key=lambda x: (x[0], x[1])):
        f.write(json.dumps(r, ensure_ascii=False) + "\n")
PY

# case <名字> <agent> <总耗时秒> ← 标准输入是事件（JSON 每行一个）。建好 worktree 目录与会话夹具，设 WT / START
case_setup() {
    local name="$1" agent="$2" wall="$3"
    WT="$TMP/wt/$name"; mkdir -p "$WT"
    START=$(( NOW - wall ))
    cat > "$TMP/$name.events"
    python3 "$TMP/fx.py" "$agent" "$WT" "$START" "$TMP/$name.events"
}
# footer <agent> [驱动] [脚本根目录]：在 $WT 里跑真实 comment-footer.sh
footer() {
    local agent="$1" root="${3:-$REPO_DIR/scripts}"
    local drv="${2:-$root/drivers/token-usage/$agent.sh}"
    (cd "$WT" && CODEX_PRICES='{}' bash "$root/drivers/token-usage/comment-footer.sh" --agent "$agent" --driver "$drv" \
        --config "$TMP/empty.config" --start "$(date -d "@$START" '+%Y-%m-%d %H:%M:%S')" --wt 7)
}
summary() { printf '%s\n' "$1" | sed -n 's/^<details><summary>\(.*\)<\/summary>$/\1/p'; }
marker()  { printf '%s\n' "$1" | grep -v '^$' | tail -1; }
field()   { marker "$1" | grep -o " $2=[^ ]*" | sed "s/^ $2=//"; }
at()      { date -d "@$(( START + $1 ))" '+%H:%M:%S'; }
# 总览各段（秒）相加是否等于总耗时
sums_ok() {
    python3 - "$(summary "$1")" <<'PY'
import re, sys
s = sys.argv[1]
def secs(t):
    n = 0
    for v, u in re.findall(r'(\d+)([hms])', t):
        n += int(v) * {"h": 3600, "m": 60, "s": 1}[u]
    return n
m = re.match(r'⏱️ 耗时：([^（]+)（(.*)）｜', s)
total = secs(m.group(1))
parts = [secs(re.sub(r'^\D+', '', p)) for p in m.group(2).split(" · ")]
print("yes" if sum(parts) == total else f"no {parts} vs {total}")
PY
}
j() { python3 -c 'import json,sys; print(json.dumps(dict(zip(sys.argv[1::2], [json.loads(v) for v in sys.argv[2::2]]))))' "$@"; }

LOOP286='cd /work; R=42565983194; for i in $(seq 1 200); do s=$(gh run view $R --repo o/r --json status --jq .status 2>/dev/null); [ "$s" = completed ] && break; sleep 60; done; gh run view $R --repo o/r --json status,conclusion'
BGTEXT='Command running in background with ID: bh1. Output is being written to: /nonexistent/bh1.output. You will be notified when it completes.'

echo "【1】#286 的形状：后台循环等 Release 运行"
case_setup c286 claude 6700 <<EOF
$(j k '"ai"' a 0 b 5)
$(j k '"bash"' id '"tu1"' t 10 cmd "$(printf '%s' "$LOOP286" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')" bg true rt 10.036 text "$(printf '%s' "$BGTEXT" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')")
$(j k '"done"' id '"tu1"' task '"bh1"' t 6640.245)
$(j k '"ai"' a 6641 b 6651)
EOF
out=$(footer claude)
eq c286_summary "$(summary "$out" | sed 's/｜.*//')" "⏱️ 耗时：1h 51m 40s（AI 约 15s · 远端 CI 约 1h 50m 30s · 其他 55s）"
eq c286_sums "$(sums_ok "$out")" yes
has c286_detail_head "$out" "- 远端 CI 约 1h 50m 30s（等待 1 条，按会话记录识别）："
has c286_detail_line "$out" "  - 等 Actions 运行 42565983194：$(at 10) → $(at 6640)，1h 50m 30s"
eq c286_kv "$(marker "$out" | grep -o 'ci_wait_secs=[^ ]* ci_waits=[^ ]* ci_wait_untimed=[^ ]*')" \
    "ci_wait_secs=6630.245 ci_waits=1 ci_wait_untimed=0"
eq c286_marker_last "$(marker "$out" | grep -c '^<!-- agent-metrics .* -->$')" 1

echo "【2】认法：几种等待写法认出并计时，不该认的不认"
qj() { python3 -c 'import json,sys;print(json.dumps(sys.argv[1]))' "$1"; }
MOVED='Command did not complete within its 120s timeout and was moved to the background (ID: bm2). Output is being written to: /nonexistent/bm2.output.'
case_setup kinds claude 900 <<EOF
$(j k '"bash"' id '"w1"' t 10 cmd "$(qj 'gh run watch 111 --repo o/r --exit-status')" rt 70)
$(j k '"bash"' id '"w2"' t 100 cmd "$(qj 'gh pr checks 171 --repo o/r --watch --interval 20')" rt 160)
$(j k '"monitor"' id '"w3"' t 200 cmd "$(qj 'cd /work; prev=""; while true; do s=$(gh pr checks 172 --repo o/r 2>/dev/null | sort); [ "$s" != "$prev" ] && echo "$s"; prev=$s; sleep 30; done')" rt 200.02 text "$(qj 'Monitor started (task m3, expires in 30m unless the source ends first).')")
$(j k '"event"' task '"m3"' t 230)
$(j k '"done"' id '"w3"' task '"m3"' t 300)
$(j k '"bash"' id '"w4"' t 400 cmd "$(qj 'RID=333; until [ "$(gh run view "$RID" --repo o/r --json status --jq .status)" = completed ]; do sleep 20; done')" rt 520 text "$(qj "$MOVED")")
$(j k '"done"' id '"w4"' task '"bm2"' t 600)
$(j k '"bash"' id '"n1"' t 610 cmd "$(qj 'gh run view 999 --repo o/r --log-failed | tail -50')" rt 615)
$(j k '"bash"' id '"n2"' t 620 cmd "$(qj 'gh workflow run release.yml --repo o/r -f gate_only=true')" rt 622)
$(j k '"bash"' id '"n3"' t 630 cmd "$(qj 'for i in 1 2 3; do gh api repos/o/r/issues/5/comments --jq length; sleep 5; done')" rt 646)
$(j k '"bash"' id '"n4"' t 650 cmd "$(qj 'echo "gh run watch 5"; echo "while true; do gh run view 1; sleep 1; done"')" rt 651)
$(j k '"ai"' a 700 b 705)
EOF
out=$(footer claude)
eq kinds_count "$(field "$out" ci_waits)" 4
eq kinds_secs "$(field "$out" ci_wait_secs)" "420.000"
has kinds_watch "$out" "  - 等 Actions 运行 111：$(at 10) → $(at 70)，1m 0s"
has kinds_checks "$out" "  - 等 PR #171 的检查：$(at 100) → $(at 160)，1m 0s"
has kinds_monitor "$out" "  - 等 PR #172 的检查：$(at 200) → $(at 300)，1m 40s"
has kinds_moved_quoted "$out" "  - 等 Actions 运行 333：$(at 400) → $(at 600)，3m 20s"
has kinds_summary "$(summary "$out")" "远端 CI 约 7m 0s"
eq kinds_sums "$(sums_ok "$out")" yes
hasnt kinds_not_single_query "$out" "运行 999"

echo "【3】两条等待部分重叠、期间 AI 在工作"
case_setup overlap claude 800 <<EOF
$(j k '"bash"' id '"o1"' t 100 cmd "$(qj 'until gh run view 501 --json status --jq .status | grep -q completed; do sleep 30; done')" bg true rt 100.03 text "$(qj "$BGTEXT")")
$(j k '"bash"' id '"o2"' t 300 cmd "$(qj 'while ! gh run view 502 --json conclusion --jq .conclusion | grep -q .; do sleep 30; done')" bg true rt 300.03 text "$(qj "$BGTEXT")")
$(j k '"done"' id '"o1"' task '"t1"' t 400)
$(j k '"ai"' a 350 b 370)
$(j k '"ai"' a 550 b 560)
$(j k '"done"' id '"o2"' task '"t2"' t 600)
$(j k '"ai"' a 700 b 710)
EOF
out=$(footer claude)
has overlap_line1 "$out" "  - 等 Actions 运行 501：$(at 100) → $(at 400)，5m 0s"
has overlap_line2 "$out" "  - 等 Actions 运行 502：$(at 300) → $(at 600)，5m 0s"
eq overlap_secs "$(field "$out" ci_wait_secs)" "470.000"
has overlap_note "$out" "  - 几条等待时间上有重叠，合计按并集算、同一段只算一次"
has overlap_ai_note "$out" "  - 等待期间 AI 也在工作，这 30s 算进 AI，不重复算进远端 CI"
eq overlap_summary "$(summary "$out" | sed 's/｜.*//')" "⏱️ 耗时：13m 20s（AI 约 40s · 远端 CI 约 7m 50s · 其他 4m 50s）"
eq overlap_sums "$(sums_ok "$out")" yes

echo "【4】没记到结束"
case_setup partial claude 300 <<EOF
$(j k '"bash"' id '"p1"' t 10 cmd "$(qj 'gh run watch 602 --repo o/r')" rt 40)
$(j k '"bash"' id '"p2"' t 50 cmd "$(qj 'gh run watch 601 --repo o/r')" bg true rt 50.02 text "$(qj "$BGTEXT")")
$(j k '"ai"' a 200 b 210)
EOF
out=$(footer claude)
eq partial_kv "$(marker "$out" | grep -o 'ci_wait_secs=[^ ]* ci_waits=[^ ]* ci_wait_untimed=[^ ]*')" \
    "ci_wait_secs=30.000 ci_waits=2 ci_wait_untimed=1"
has partial_open "$out" "  - 等 Actions 运行 601：$(at 50) 起，结束未记到"
has partial_note "$out" "  - 另有 1 条没记到结束，合计是下限"
case_setup none_done claude 300 <<EOF
$(j k '"bash"' id '"q1"' t 50 cmd "$(qj 'gh run watch 601 --repo o/r')" bg true rt 50.02 text "$(qj "$BGTEXT")")
$(j k '"ai"' a 200 b 210)
EOF
out=$(footer claude)
eq unknown_summary "$(summary "$out" | sed 's/｜.*//')" "⏱️ 耗时：5m 0s（AI 约 10s · 远端 CI 未知 · 其他 4m 50s）"
eq unknown_no_secs "$(field "$out" ci_wait_secs)" ""
eq unknown_counts "$(marker "$out" | grep -o 'ci_waits=[^ ]* ci_wait_untimed=[^ ]*')" "ci_waits=1 ci_wait_untimed=1"
has unknown_head "$out" "- 远端 CI：等待 1 条，都没记到结束，时长未知（按会话记录识别）："

echo "【5】上一轮派工的等待不算"
case_setup prev claude 300 <<EOF
$(j k '"bash"' id '"r1"' t -100 cmd "$(qj 'gh run watch 801 --repo o/r')" bg true rt -99.9 text "$(qj "$BGTEXT")")
$(j k '"done"' id '"r1"' task '"t9"' t 50)
$(j k '"ai"' a 200 b 210)
EOF
out=$(footer claude)
eq prev_counts "$(marker "$out" | grep -o 'ci_wait_secs=[^ ]* ci_waits=[^ ]* ci_wait_untimed=[^ ]*')" \
    "ci_wait_secs=0.000 ci_waits=0 ci_wait_untimed=0"
hasnt prev_no_line "$out" "801"

echo "【6】统计不出来：footer 照常出，三个字段都不写，细节写原因"
WRAP="$TMP/wrap-driver.sh"
cat > "$WRAP" <<SH
#!/usr/bin/env bash
case "\${2:-}" in
    --ci-wait) [ "\$CI_MODE" = garbage ] && { echo 'not json'; exit 0; }; exit 3 ;;
    *) exec bash "$TU/claude.sh" "\$@" ;;
esac
SH
WT="$TMP/wt/c286"; START=$(( NOW - 6700 ))
out=$(CI_MODE=garbage footer claude "$WRAP")
has bad_json_reason "$out" "- 远端 CI 等待没统计到：统计输出读不懂"
eq bad_json_no_fields "$(marker "$out" | grep -c 'ci_wait')" 0
has bad_json_footer_still "$(summary "$out")" "AI 约 15s"
out=$(CI_MODE=exit footer claude "$WRAP")
has bad_exit_reason "$out" "- 远端 CI 等待没统计到：统计脚本出错（退出码 3）"
eq bad_exit_no_fields "$(marker "$out" | grep -c 'ci_wait')" 0
F="$CLAUDE_PROJECTS_DIR/$(printf '%s' "$TMP/wt/c286" | tr / -)/s.jsonl"
cp "$F" "$TMP/c286.bak"; chmod 000 "$F"
if [ -r "$F" ]; then
    echo "  ⏭ 以 root 运行，读权限拦不住，「会话读不了」一例不适用"
else
    out=$(footer claude)
    has unreadable_reason "$out" "- 远端 CI 等待没统计到：Claude 会话记录读不了（Permission denied）"
    eq unreadable_no_fields "$(marker "$out" | grep -c 'ci_wait')" 0
fi
chmod 600 "$F"

echo "【7】codex：exec 单元里跑完的、靠轮询才结束的；与 Claude 同一场景结论一致"
case_setup cx codex 500 <<EOF
$(j k '"ai"' a 0 b 5)
$(j k '"cell"' t 10 stmts "[$(j cmd "$(qj 'gh run watch 701 --repo o/r --exit-status')" wall 45.5 exit 0)]" out_after 45.6)
$(j k '"cell"' t 100 stmts "[$(j cmd "$(qj 'until gh run view 702 --repo o/r --json status --jq .status | grep -q completed; do sleep 30; done')" wall 10 sid 5)]" out_after 10.1)
$(j k '"ai"' a 200 b 210)
$(j k '"cell"' t 380 stmts "[$(j poll 5 wall 20 exit 0 out '"done"')]" out_after 20.1)
EOF
cxout=$(footer codex)
has cx_line1 "$cxout" "  - 等 Actions 运行 701：$(at 10) → $(at 55)，46s"
has cx_line2 "$cxout" "  - 等 Actions 运行 702：$(at 100) → $(at 400)，5m 0s"
eq cx_secs "$(field "$cxout" ci_wait_secs)" "335.500"
CXWT="$WT"
case_setup cxsame claude 500 <<EOF
$(j k '"ai"' a 0 b 5)
$(j k '"bash"' id '"s1"' t 10 cmd "$(qj 'gh run watch 701 --repo o/r --exit-status')" rt 55.5)
$(j k '"bash"' id '"s2"' t 100 cmd "$(qj 'until gh run view 702 --repo o/r --json status --jq .status | grep -q completed; do sleep 30; done')" bg true rt 100.04 text "$(qj "$BGTEXT")")
$(j k '"ai"' a 200 b 210)
$(j k '"done"' id '"s2"' task '"t5"' t 400)
EOF
clout=$(footer claude)
eq same_ci_lines "$(printf '%s\n' "$clout" | grep -E '^  - |^- 远端' )" "$(printf '%s\n' "$cxout" | grep -E '^  - |^- 远端')"
eq same_ci_kv "$(marker "$clout" | grep -o 'ci_wait_secs=[^ ]* ci_waits=[^ ]* ci_wait_untimed=[^ ]*')" \
    "$(marker "$cxout" | grep -o 'ci_wait_secs=[^ ]* ci_waits=[^ ]* ci_wait_untimed=[^ ]*')"
cj=$(cd "$WT" && bash "$TU/claude.sh" "$START" --ci-wait); xj=$(cd "$CXWT" && bash "$TU/codex.sh" "$START" --ci-wait)
eq same_json "$cj" "$xj"

echo "【8】没有等待：与合并基点逐字节对拍"
BASE_REV=$(git -C "$REPO_DIR" merge-base HEAD origin/main 2>/dev/null || git -C "$REPO_DIR" rev-parse HEAD~1)
mkdir -p "$TMP/old"; git -C "$REPO_DIR" archive "$BASE_REV" scripts | tar -x -C "$TMP/old"
case_setup quiet claude 600 <<EOF
$(j k '"ai"' a 0 b 30)
$(j k '"bash"' id '"x1"' t 40 cmd "$(qj 'bash tests/foo.test.sh')" rt 70 text "$(qj 'ok')")
$(j k '"bash"' id '"x2"' t 80 cmd "$(qj 'gh run view 999 --repo o/r --log-failed')" rt 82)
$(j k '"bash"' id '"x3"' t 90 cmd "$(qj 'bash tests/bar.test.sh')" bg true rt 90.02 text "$(qj "$BGTEXT")")
$(j k '"done"' id '"x3"' task '"t7"' t 150)
$(j k '"monitor"' id '"x4"' t 155 cmd "$(qj 'bash tests/baz.test.sh 2>&1 | grep -E "通过|失败"')" rt 155.02 text "$(qj 'Monitor started (task m9).')")
$(j k '"done"' id '"x4"' task '"m9"' t 158)
$(j k '"ai"' a 160 b 200)
EOF
for agent in claude; do
    new=$(footer "$agent"); old=$(footer "$agent" "" "$TMP/old/scripts")
    eq quiet_visible_same "$(printf '%s\n' "$new" | sed '$d')" "$(printf '%s\n' "$old" | sed '$d')"
    eq quiet_marker "$(marker "$new")" "$(marker "$old" | sed 's/ -->$/ ci_wait_secs=0.000 ci_waits=0 ci_wait_untimed=0 -->/')"
done
for mode in "" --kv; do
    for agent in claude codex; do
        d="$WT"; [ "$agent" = codex ] && d="$CXWT"
        n=$(cd "$d" && CODEX_PRICES='{}' bash "$TU/$agent.sh" "$START" $mode)
        o=$(cd "$d" && CODEX_PRICES='{}' bash "$TMP/old/scripts/drivers/token-usage/$agent.sh" "$START" $mode)
        eq "driver_same_${agent}${mode:-_human}" "$n" "$o"
    done
done
for d in "$WT" "$TMP/wt/kinds" "$CXWT"; do
    agent=claude; [ "$d" = "$CXWT" ] && agent=codex
    tt() { (cd "$d" && CAVIL_FOOTER_START_EPOCH="$START" CAVIL_FOOTER_WORKTREE="$d" CAVIL_FOOTER_AGENT="$agent" \
            CODEX_SESSIONS_DIR="$HOME/.codex/sessions" CAVIL_TEST_RUNS_LOG="$TMP/runs.jsonl" python3 "$1"); }
    eq "test_time_same_$(basename "$d")" "$(tt "$TU/test_time.py")" "$(tt "$TMP/old/scripts/drivers/token-usage/test_time.py")"
done

echo
report_counts "$pass" "$fail"
echo "通过 $pass，失败 $fail"
[ "$fail" -eq 0 ]
