#!/usr/bin/env bash
# 「处理时长」：按**每一轮对话的起止**算，每一轮只归一个派工（scripts/weekly-report/worktime.py）。
#
# 跑法：bash tests/weekly-report-worktime-turns.test.sh
# 依赖：python3。造临时 HOME + 假 gh，跑真实 collect.py，断言**采集输出**，不只看内部函数。
#
# 为什么要有这个文件（GigleTutor-Web#933）：
# 原来按「派工窗口前后两份累计快照」相减来算，窗口归属靠配对，逐条会错位——一段长工作
# 之后紧跟一条短评论，前面那段就被算到短窗口头上（实测 57 秒的窗口算出 53 分钟）。
# 现在改成：一轮 = 共用同一个 promptId 的一段主会话记录；轮的开始时刻交给与 token 同一套
# 唯一认领规则（attribute.owner：半开区间、多个候选取开始最晚的、都不命中就列为未归属），
# 认领到的派工拿**整轮**时长，不封顶、不裁剪。会话日志会被 CLI 按保留期删掉，所以每次
# 采集时把轮的起止写进本地台账，日志没了也还算得出。
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
COLLECT="$REPO_DIR/scripts/weekly-report/collect.py"
WR_DIR="$REPO_DIR/scripts/weekly-report"

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0
chk() { if [ "$2" = "$3" ]; then echo "  ✅ $1"; pass=$((pass+1)); else echo "  ❌ $1 (期望 '$3'，实得 '$2')"; fail=$((fail+1)); fi; }

export HOME="$TMP"
export XDG_CACHE_HOME="$TMP/cache"
unset CLAUDE_PROJECTS_DIR CODEX_SESSIONS_DIR
WT_BASE="$TMP/wt"; WT_PREFIX="tutor"
projdir() { printf '%s/.claude/projects/%s' "$TMP" "$(printf '%s' "$WT_BASE/$WT_PREFIX-$1" | tr '/' '-')"; }

mkdir -p "$TMP/bin" "$TMP/gh"
echo "[]" > "$TMP/gh/pulls.json"
cat > "$TMP/bin/gh" <<SHIM
#!/usr/bin/env bash
for a in "\$@"; do
  case "\$a" in
    *"/issues/comments"*) cat "$TMP/gh/comments.json"; exit 0 ;;
    *"/pulls?"*)          cat "$TMP/gh/pulls.json";    exit 0 ;;
    *"/issues?"*)         cat "$TMP/gh/issues.json";   exit 0 ;;
  esac
done
echo "[]"
SHIM
chmod +x "$TMP/bin/gh"; export PATH="$TMP/bin:$PATH"
cd "$TMP"

# ── 夹具 ──────────────────────────────────────────────────────────────
# 记账评论：c <id> <issue> <agent> <start> <end>（时刻都写 +08:00）
COMMENTS=()
c() {
    local wall
    wall=$(python3 -c "import datetime as d;f=d.datetime.fromisoformat;print(int((f('$5')-f('$4')).total_seconds()))")
    COMMENTS+=("{\"id\":$1,\"issue_url\":\"https://api.github.com/repos/acme/widget/issues/$2\",\"user\":{\"login\":\"acme-bot\"},\"created_at\":\"2026-09-08T00:00:00Z\",\"updated_at\":\"2026-09-08T00:00:00Z\",\"body\":\"ok\\n\\n<!-- agent-metrics agent=$3 wt=$2 start=$4 end=$5 wall_secs=$wall in=1 out=1 cache_r=0 cache_w=0 cost_usd=1.00 -->\"}")
}
flush_comments() {
    local IFS=,
    printf '[%s]' "${COMMENTS[*]}" > "$TMP/gh/comments.json"
    COMMENTS=()
}
cat > "$TMP/gh/issues.json" <<'JSON'
[ {"number":10,"title":"t","state":"open","labels":[],"created_at":"2026-08-01T02:00:00Z","closed_at":null},
  {"number":11,"title":"t","state":"open","labels":[],"created_at":"2026-08-01T02:00:00Z","closed_at":null} ]
JSON

# 会话记录（时刻写 UTC）
prompt() { printf '{"type":"user","timestamp":"%s","promptId":"%s","message":{"role":"user","content":"go"}}\n' "$1" "$2"; }
asst()   { printf '{"type":"assistant","timestamp":"%s","message":{"content":[{"type":"tool_use"}],"stop_reason":"%s"}}\n' "$1" "${2:-tool_use}"; }
tres()   { printf '{"type":"user","timestamp":"%s","promptId":"%s","message":{"role":"user","content":[{"type":"tool_result"}]}}\n' "$1" "$2"; }
side()   { printf '{"type":"assistant","isSidechain":true,"timestamp":"%s","message":{"content":[{"type":"text"}]}}\n' "$1"; }
synth()  { printf '{"type":"assistant","timestamp":"%s","message":{"model":"<synthetic>","content":[{"type":"text","text":"No response requested."}],"stop_reason":"stop_sequence"}}\n' "$1"; }
snap()   { printf '{"type":"cost-state","totalAPIDuration":%s,"totalToolDuration":%s}\n' "$1" "$2"; }

# session <issue> <会话名>：stdin 写进该 worktree 的会话文件
session() { mkdir -p "$(projdir "$1")"; cat > "$(projdir "$1")/$2.jsonl"; }
wipe_logs() { rm -rf "$TMP/.claude/projects"; }
wipe_all()  { wipe_logs; rm -rf "$TMP/.codex" "$XDG_CACHE_HOME"; }

run() {   # run [week-of] [weeks]
    flush_comments
    python3 "$COLLECT" --repo acme/widget --out "$TMP/d.json" --weeks "${2:-1}" \
        --week-of "${1:-2026-09-07}" --worktree-base "$WT_BASE" --session-prefix "$WT_PREFIX" \
        >/dev/null 2>"$TMP/err.log" \
        || { echo "collect.py 跑挂了："; cat "$TMP/err.log"; exit 1; }
}
q() {   # q <字段> [周]
    python3 -c "
import json; w=json.load(open('$TMP/d.json'))['weekly']['${2:-2026-09-07}']
v=w.get('$1', 0); print(int(v) if abs(v-round(v))<1e-9 else v)"; }
qj() { python3 -c "import json; d=json.load(open('$TMP/d.json')); print($1)"; }

echo "— 基本：一轮从 prompt 到最后一条记录，工具结果不开新轮 —"
wipe_all
c 1 10 claude 2026-09-07T10:00:00+08:00 2026-09-07T10:10:00+08:00
session 10 s1 <<EOF
$(prompt 2026-09-07T02:00:05Z p1)
$(asst   2026-09-07T02:01:00Z)
$(tres   2026-09-07T02:04:00Z p1)
$(asst   2026-09-07T02:05:00Z)
$(tres   2026-09-07T02:08:00Z p1)
$(asst   2026-09-07T02:09:00Z end_turn)
$(snap 999000 999000)
$(side   2026-09-07T02:30:00Z)
EOF
run
chk "算得出"                                  "$(q work_records)" "1"
chk "整轮 = 10:00:05 → 10:09:00 = 535 秒（不按工具结果切开；子代理记录不延长轮）" "$(q work)" "535"
chk "不读累计快照（999+999 秒的快照不影响结果）" "$(q work_missing)" "0"

echo
echo "— 被中断的轮：CLI 事后补写的占位回复（<synthetic>）不算这一轮的结束 —"
# 实测（#933 实跑）：一轮跑到一半进程没了，两天后来新指令时 CLI 先补一条
# model=<synthetic>「No response requested.」——按它延长，上一轮就变成 41 小时。
wipe_all
c 1 10 claude 2026-09-07T10:00:00+08:00 2026-09-07T10:10:00+08:00
c 2 10 claude 2026-09-09T10:00:00+08:00 2026-09-09T10:10:00+08:00
session 10 s1 <<EOF
$(prompt 2026-09-07T02:00:00Z p1)
$(asst   2026-09-07T02:02:00Z)
$(tres   2026-09-07T02:05:00Z p1)
$(synth  2026-09-09T02:00:00Z)
$(prompt 2026-09-09T02:00:01Z p2)
$(asst   2026-09-09T02:01:41Z end_turn)
EOF
run
chk "中断那轮只算到最后一条真实记录：300 秒；后一轮 100 秒" "$(q work)" "400"

echo
echo "— 窗口重叠：一轮只算给开始最晚的那个窗口 —"
wipe_all
c 1 10 claude 2026-09-07T10:00:00+08:00 2026-09-07T10:10:00+08:00
c 2 10 claude 2026-09-07T10:05:00+08:00 2026-09-07T10:15:00+08:00
session 10 s1 <<EOF
$(prompt 2026-09-07T02:06:40Z p1)
$(asst   2026-09-07T02:08:20Z end_turn)
EOF
run
chk "合计 100 秒，不是 200 秒"                  "$(q work)" "100"
chk "只有 B 算得出，A 记为拿不到"               "$(q work_records)/$(q work_missing)" "1/1"

echo
echo "— 窗口首尾相接：恰好落在边界上的轮只归后一个 —"
wipe_all
c 1 10 claude 2026-09-07T10:00:00+08:00 2026-09-07T10:05:00+08:00
c 2 10 claude 2026-09-07T10:05:00+08:00 2026-09-07T10:10:00+08:00
session 10 s1 <<EOF
$(prompt 2026-09-07T02:05:00Z p1)
$(asst   2026-09-07T02:06:00Z end_turn)
EOF
run
chk "合计 60 秒"                               "$(q work)" "60"
chk "只认领一次"                               "$(q work_records)" "1"

echo
echo "— 同一次派工发了两条累计评论：去重后只认领一次 —"
wipe_all
c 1 10 claude 2026-09-07T10:00:00+08:00 2026-09-07T10:05:00+08:00
c 2 10 claude 2026-09-07T10:00:00+08:00 2026-09-07T10:10:00+08:00
session 10 s1 <<EOF
$(prompt 2026-09-07T02:00:10Z p1)
$(asst   2026-09-07T02:08:30Z end_turn)
EOF
run
chk "一条派工、500 秒"                          "$(q work_records)/$(q work)" "1/500"

echo
echo "— 跨完工：短窗口拿到整轮，不封顶，进超长名单 —"
wipe_all
c 1 10 claude 2026-09-07T10:00:00+08:00 2026-09-07T10:00:57+08:00
session 10 s1 <<EOF
$(prompt 2026-09-07T02:00:01Z p1)
$(asst   2026-09-07T02:53:21Z end_turn)
EOF
run
chk "这次派工得 3200 秒"                        "$(q work)" "3200"
chk "进超长名单"                               "$(qj "[(m['wall'],m['work']) for m in d['long_turns']]")" "[(57, 3200)]"

echo
echo "— 跨后续派工：轮从 A 里开始、结束在 B 开始之后 → 整轮归 A；B 只拿自己的轮 —"
wipe_all
c 1 10 claude 2026-09-07T10:00:00+08:00 2026-09-07T10:08:00+08:00
c 2 10 claude 2026-09-07T10:15:00+08:00 2026-09-07T10:25:00+08:00
session 10 s1 <<EOF
$(prompt 2026-09-07T02:01:00Z p1)
$(asst   2026-09-07T02:20:00Z end_turn)
$(prompt 2026-09-07T02:21:00Z p2)
$(asst   2026-09-07T02:22:40Z end_turn)
EOF
run
chk "A 1140 秒 + B 100 秒 = 1240 秒，两条都算得出" "$(q work)/$(q work_records)" "1240/2"
chk "A 进超长名单（1140 > 2×480），B 不进"          "$(qj "[m['work'] for m in d['long_turns']]")" "[1140]"

echo
echo "— 跨周：周日 23:50 开工的轮跑到周一，整轮记在开工那一周 —"
wipe_all
c 1 10 claude 2026-09-13T23:50:00+08:00 2026-09-14T00:30:00+08:00
session 10 s1 <<EOF
$(prompt 2026-09-13T15:50:10Z p1)
$(asst   2026-09-13T16:20:00Z end_turn)
EOF
run 2026-09-14 2
chk "开工那周 1790 秒"                          "$(q work 2026-09-07)" "1790"
chk "下一周 0"                                  "$(q work 2026-09-14)" "0"

echo
echo "— 轮的开始不落在任何窗口：不分给任何派工，单独列出 —"
wipe_all
c 1 10 claude 2026-09-07T10:00:00+08:00 2026-09-07T10:10:00+08:00
session 10 s1 <<EOF
$(prompt 2026-09-07T01:00:00Z p0)
$(asst   2026-09-07T01:30:00Z end_turn)
$(prompt 2026-09-07T02:00:10Z p1)
$(asst   2026-09-07T02:01:50Z end_turn)
EOF
run
chk "派工只得自己那轮 100 秒"                    "$(q work)" "100"
chk "未归属：1 轮 1800 秒"                       "$(qj "[(u['turns'],u['secs']) for u in d['work_unattributed']]")" "[(1, 1800)]"

echo
echo "— 未归属的轮按各自的开始周汇总，不挤到同一周 —"
wipe_all
c 1 10 claude 2026-09-14T10:00:00+08:00 2026-09-14T10:10:00+08:00
session 10 s1 <<EOF
$(prompt 2026-09-07T01:00:00Z p0)
$(asst   2026-09-07T01:01:40Z end_turn)
$(prompt 2026-09-14T01:00:00Z p1)
$(asst   2026-09-14T01:03:20Z end_turn)
EOF
run 2026-09-14 2
chk "两周各列一轮：100 秒 / 200 秒" \
    "$(qj "sorted((u['week'],u['turns'],u['secs']) for u in d['work_unattributed'])")" \
    "[('2026-09-07', 1, 100), ('2026-09-14', 1, 200)]"

echo
echo "— 台账：进行中 → 结束后更新 → 删日志仍算得出 —"
wipe_all
c 1 10 claude 2026-09-07T10:00:00+08:00 2026-09-07T10:10:00+08:00
session 10 s1 <<EOF
$(prompt 2026-09-07T02:00:05Z p1)
$(asst   2026-09-07T02:03:00Z)
EOF
run
chk "第一次扫：轮还在跑，先算到 175 秒"            "$(q work)" "175"
chk "记一轮进行中"                              "$(q work_in_progress)" "1"
c 1 10 claude 2026-09-07T10:00:00+08:00 2026-09-07T10:10:00+08:00
session 10 s1 <<EOF
$(prompt 2026-09-07T02:00:05Z p1)
$(asst   2026-09-07T02:03:00Z)
$(tres   2026-09-07T02:06:00Z p1)
$(asst   2026-09-07T02:08:00Z end_turn)
EOF
run
chk "第二次扫：结束时刻更新到 475 秒"              "$(q work)" "475"
chk "不再是进行中"                              "$(q work_in_progress)" "0"
wipe_logs
c 1 10 claude 2026-09-07T10:00:00+08:00 2026-09-07T10:10:00+08:00
run
chk "日志删掉后：台账里仍是 475 秒"               "$(q work)" "475"
chk "台账是合法 JSONL，且只有一行这一轮"          "$(python3 -c "
import json,glob
rows=[json.loads(l) for f in glob.glob('$XDG_CACHE_HOME/cavil-loop/*.jsonl') for l in open(f) if l.strip()]
print(len(rows), rows[0]['done'])")" "1 True"

echo
echo "— 台账并发：两个进程同时合并，谁的轮都不丢 —"
wipe_all
cat > "$TMP/hammer.py" <<'PY'
import sys
sys.path.insert(0, sys.argv[1])
import worktime
tag = sys.argv[2]
for i in range(40):
    worktime.merge_ledger([{"agent": "claude", "wt": "/x/" + tag, "sid": tag, "pid": "p%d" % i,
                            "start": 1000.0 + i, "end": 1001.0 + i, "done": True}])
PY
python3 "$TMP/hammer.py" "$WR_DIR" A & p1=$!
python3 "$TMP/hammer.py" "$WR_DIR" B & p2=$!
wait $p1; wait $p2
chk "80 轮都在、每行都是合法 JSON" "$(python3 -c "
import json,glob
rows=[json.loads(l) for f in glob.glob('$XDG_CACHE_HOME/cavil-loop/*.jsonl') for l in open(f) if l.strip()]
print(len({(r['sid'],r['pid']) for r in rows}))")" "80"

echo
echo "— codex 一侧也走唯一认领：重叠窗口只算一次 —"
wipe_all
c 1 10 codex 2026-09-07T10:00:00+08:00 2026-09-07T10:10:00+08:00
c 2 10 codex 2026-09-07T10:05:00+08:00 2026-09-07T10:15:00+08:00
mkdir -p "$TMP/.codex/sessions/2026/09/07"
python3 - "$TMP/.codex/sessions/2026/09/07/rollout-a.jsonl" "$WT_BASE/$WT_PREFIX-10" <<'PY'
import json, sys, datetime
t = lambda s: int(datetime.datetime.fromisoformat(s).timestamp() * 1000)
with open(sys.argv[1], "w") as f:
    f.write(json.dumps({"type": "session_meta", "payload": {"cwd": sys.argv[2]}}) + "\n")
    f.write(json.dumps({"type": "event_msg", "payload": {
        "started_at_ms": t("2026-09-07T10:06:00+08:00"),
        "completed_at_ms": t("2026-09-07T10:07:00+08:00")}}) + "\n")
PY
run
chk "合计 60 秒，不是 120 秒"                    "$(q work)" "60"

echo
echo "通过 $pass / 失败 $fail"
[ "$fail" -eq 0 ]
