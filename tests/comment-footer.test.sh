#!/usr/bin/env bash
# 评论用量 footer（GitHub#88 / #90）：一行总览（就是折叠标题）+ 折叠细节 + AI 时间估算 + 项目测试耗时接口。
#
# 跑法：bash tests/comment-footer.test.sh
# 依赖：python3、jq。不碰网络、不读本机真实会话（HOME 指到临时目录）。
#
# 覆盖（全部跑真实脚本，不断言源码文本）：
#   【1】AI 时间估算（ai_time.py）：claude / codex 各一份夹具，夹具里有工具执行、跨文件并行、
#        子代理、<synthetic>、窗口外的请求、老版本 CLI 没有「发请求」记录的情况
#   【2】两个用量驱动的 --kv 真的带出 AI 时间（同一批文件、同一个窗口）
#   【3】footer 生成器（comment-footer.sh）：总览各段相加 = 总耗时；测试与 AI 重叠时「其他」
#        为 0 并说明；项目命令没配（不提测试）/ 确认没跑（「未跑测试」）/ 失败 / 超时 / 首行不对
#        （「测试未知」）/ 字段撞名；AI 算不出来；没有用量；AI 估算长说明不再出现
#   【4】周报读法：footer 末行是机器记录；去掉机器记录后从可见部分读出的时长 / token / 金额
#        与机器记录一致；旧格式评论照旧能读
#   【5】四份模板拼装后的 footer 段：走生产拼装函数，把成品里的命令原样跑一遍
#   【6】负对照：把上面每一条要守住的规矩逐个改坏（沙盘副本），对应检查必须变红
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
TMP=$(mktemp -d)
trap '[ -n "${KEEP:-}" ] && echo "TMP=$TMP" || rm -rf "$TMP"' EXIT
export TZ=Asia/Shanghai     # 周报按 +08:00 读可见时刻；footer 按本机时区写。两边对齐

pass=0; fail=0
ok()  { echo "  ✅ $1"; pass=$((pass + 1)); }
bad() { echo "  ❌ $1"; [ -n "${2:-}" ] && printf '     %s\n' "$2"; fail=$((fail + 1)); }

# ── 夹具 ─────────────────────────────────────────────────────────────────
START=$(( $(date +%s) - 3600 ))
iso() { python3 -c 'import sys,datetime; print(datetime.datetime.fromtimestamp(float(sys.argv[1]), datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z")' "$1"; }
T() { iso "$(python3 -c "print($START + $1)")"; }

WT="$TMP/wt/proj-issue-7"
mkdir -p "$WT" "$TMP/home"
CPROJ="$TMP/home/.claude/projects/$(printf '%s' "$WT" | tr / -)"
mkdir -p "$CPROJ"

# claude：期望 AI = 7 + 14 + 4 + 6 = 31.000 秒，5 次请求
#   A [1,8]    请求发出(api-request) → 最后一段回复；之后工具跑了 12 秒，不算
#   B [21,30] 与另一份会话文件里的 D [25,35] 重叠 → 并集 [21,35] = 14
#   E [41,45] 同一 requestId 两段回复，取最晚
#   G [60,66] 老版本 CLI：没有 api-request，从工具结果那一刻算起
#   不算：子代理（isSidechain）、<synthetic>、窗口开始前就回完的请求 Z
u()  { printf '{"type":"user","timestamp":"%s","isSidechain":false,"message":{"role":"user","content":"x"}}\n' "$(T "$1")"; }
api() { printf '{"type":"api-request","timestamp":"%s","querySource":"repl_main_thread"}\n' "$(T "$1")"; }
asst() { # 时刻 requestId [sidechain] [model]
    printf '{"type":"assistant","timestamp":"%s","requestId":"%s","isSidechain":%s,"message":{"model":"%s","usage":{"input_tokens":10,"output_tokens":20,"cache_read_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0}}}}\n' \
        "$(T "$1")" "$2" "${3:-false}" "${4:-claude-test}"
}
{
    u -10; api -9; asst -5 Z
    u 0; api 1; asst 5 A; asst 8 A
    u 20; api 21; asst 30 B
    u 40; api 41; asst 44 E; asst 45 E
    asst 50 F true
    asst 52 S false "<synthetic>"
    u 60; asst 66 G
} > "$CPROJ/s1.jsonl"
{ api 25; asst 35 D; } > "$CPROJ/s2.jsonl"

# codex：期望 AI = 3.5 + 3 + 2 + 3 = 11.500 秒，4 次请求
#   [0.5,4]  用户消息 → 回完；[10,13] 工具结果 → 回完；[13,15] 紧接着又一次调用；
#   本轮结束后、下一轮开始前的那条用量不算；[30,33] 新一轮从 task_started 算起
CSESS="$TMP/home/.codex/sessions/2026/10/27"
mkdir -p "$CSESS"
cu() { printf '{"type":"token_usage_record","timestamp":"%s","payload":{"usage":{"input_tokens":100,"cached_input_tokens":0,"output_tokens":10}}}\n' "$(T "$1")"; }
ev() { printf '{"type":"event_msg","timestamp":"%s","payload":{"type":"%s"}}\n' "$(T "$1")" "$2"; }
{
    printf '{"type":"session_meta","timestamp":"%s","payload":{"cwd":"%s"}}\n' "$(T 0)" "$WT"
    printf '{"type":"turn_context","timestamp":"%s","payload":{"model":"gpt-test"}}\n' "$(T 0)"
    ev 0 task_started
    printf '{"type":"event_msg","timestamp":"%s","payload":{"type":"item_completed","item":{"type":"UserMessage"}}}\n' "$(T 0.5)"
    cu 4
    printf '{"type":"response_item","timestamp":"%s","payload":{"type":"custom_tool_call_output"}}\n' "$(T 10)"
    cu 13; cu 15
    ev 16 task_complete
    cu 20
    ev 30 task_started; cu 33
} > "$CSESS/rollout-x.jsonl"

# 假用量驱动：footer 生成器只关心它的两种输出，内容由环境变量给
FAKE="$TMP/fake-driver.sh"
cat > "$FAKE" <<'SH'
#!/usr/bin/env bash
if [ "${2:-}" = --kv ]; then printf '%s\n' "${FAKE_KV-}"; else printf '%s\n' "${FAKE_HUMAN-}"; fi
SH
KV_FULL="in=24 out=15600 cache_r=8500000 cache_w=58700 cost_usd=2.4812 cost_state=full cost_unknown_tokens=0 price_source=solved models=claude-opus-5-5 model_unknown=no ai_secs=150.400 ai_requests=12"
HUMAN_FULL="24 input, 15.6k output, 8.5m cache read, 58.7k cache write (\$2.48)（模型：claude-opus-5-5）"

# ── 检查器：对一份 scripts/ 目录跑全部行为检查，逐条打印 PASS / FAIL ───────────
cat > "$TMP/check.sh" <<'CHECK'
#!/usr/bin/env bash
# 用法: check.sh <scripts 目录>
set -uo pipefail
S="$1"; D="$S/drivers/token-usage"
say() { if [ "$2" = "$3" ]; then echo "PASS $1"; else echo "FAIL $1 :: 期望 [$3] 实得 [$2]"; fi; }

# 【1】AI 时间估算
say ai_claude "$(python3 "$D/ai_time.py" claude "$START" now "$CPROJ"/*.jsonl)" "ai_secs=31.000 ai_requests=5"
say ai_codex  "$(python3 "$D/ai_time.py" codex "$START" now "$CSESS"/rollout-x.jsonl)" "ai_secs=11.500 ai_requests=4"

# 【2】驱动 --kv 带出 AI 时间
kv=$(cd "$WT" && HOME="$TMP/home" CLAUDE_PROJECTS_DIR="$TMP/home/.claude/projects" bash "$D/claude.sh" "$START" --kv)
say driver_claude "$(printf '%s' "$kv" | grep -o 'ai_secs=[^ ]* ai_requests=[0-9]*$')" "ai_secs=31.000 ai_requests=5"
kv=$(cd "$WT" && HOME="$TMP/home" CODEX_PRICES='{}' bash "$D/codex.sh" "$START" --kv)
say driver_codex "$(printf '%s' "$kv" | grep -o 'ai_secs=[^ ]* ai_requests=[0-9]*$')" "ai_secs=11.500 ai_requests=4"
human=$(cd "$WT" && HOME="$TMP/home" CLAUDE_PROJECTS_DIR="$TMP/home/.claude/projects" bash "$D/claude.sh" "$START")
say driver_human_no_ai "$(printf '%s' "$human" | grep -c ai_secs)" "0"

# 【3】footer 生成器
foot() { # $1 = 总耗时秒数；其余是 env 赋值
    local secs="$1"; shift
    local st; st=$(date -d "@$(( $(date +%s) - secs ))" '+%Y-%m-%d %H:%M:%S')
    (cd "$WT" && env HOME="$TMP/home" "$@" bash "$D/comment-footer.sh" --agent claude --driver "$FAKE" \
        --config "$CFG" --start "$st" --wt 7)
}
# 总览 → "总 测试 AI 其他"（秒；缺的段写 -）
segs() {
    python3 - "$1" <<'PY'
import re, sys
line = next(l for l in sys.argv[1].splitlines() if l.startswith("<details><summary>⏱️"))
line = re.sub(r'^<details><summary>|</summary>$', '', line)
def secs(t):
    h = re.search(r'(\d+)h', t); m = re.search(r'(\d+)m', t); s = re.search(r'(\d+)s', t)
    return sum(int(x.group(1)) * k for x, k in ((h, 3600), (m, 60), (s, 1)) if x)
tot = re.match(r'⏱️ 耗时：([^（]+)（', line).group(1)
inner = re.search(r'（(.*?)）｜', line).group(1)
part = {}
for seg in inner.split(" · "):
    for key, pre in (("test", "测试 "), ("ai", "AI 约 "), ("other", "其他 ")):
        if seg.startswith(pre):
            part[key] = secs(seg[len(pre):])
print(secs(tot), *(part.get(k, "-") for k in ("test", "ai", "other")))
PY
}
# 总览（折叠标题）去掉标签后的文字
ov() { printf '%s\n' "$1" | sed -n 2p | sed -e 's|^<details><summary>||' -e 's|</summary>$||'; }
setcfg() { printf 'COMMENT_FOOTER_EXTRA_CMD=%q\n' "$1" > "$CFG"; }
CFG="$TMP/cfg"

setcfg "printf 'test_secs=291\n  - 整条链 1 次 4m 40s\n  - 单跑 3 次 约 11s\nkv test_runs=4\n'"
out=$(foot 480 FAKE_KV="$KV_FULL" FAKE_HUMAN="$HUMAN_FULL")
read -r tot t a o <<< "$(segs "$out")"
say sum_equals_total "$(( t + a + o ))" "$tot"
say sum_parts "$t $a" "291 150"
say overview_model_cost "$(ov "$out" | grep -c '｜模型：claude-opus-5-5 · 8.5m token · 约 \$2.48$')" "1"
say details_project_lines "$(printf '%s\n' "$out" | grep -c '^  - 单跑 3 次 约 11s$')" "1"
say details_token_verbatim "$(printf '%s\n' "$out" | grep -cF -- "- token 明细：$HUMAN_FULL")" "1"
# AI 时间的估算口径写在运维文档里，不再每条评论重复一大段（总览的「AI 约」已表明是估算）
say ai_note_gone "$(printf '%s\n' "$out" | grep -c '是估算\|偏差来源')" "0"
# 总览就是折叠标题（GitHub#90）：收起时只剩一行；标题后空一行，细节里的列表才按 markdown 渲染
say overview_is_summary "$(printf '%s\n' "$out" | sed -n 2p | grep -c '^<details><summary>⏱️ 耗时：.*</summary>$')" "1"
say no_separate_details_head "$(printf '%s\n' "$out" | grep -c '细节</summary>')" "0"
say summary_then_blank "$(printf '%s\n' "$out" | sed -n 3p)" ""
say marker_last "$(printf '%s\n' "$out" | grep -v '^$' | tail -1 | grep -c '^<!-- agent-metrics .* -->$')" "1"
say marker_fields "$(printf '%s\n' "$out" | tail -1 | grep -o 'ai_secs=150.400 ai_requests=12 test_secs=291 test_runs=4')" "ai_secs=150.400 ai_requests=12 test_secs=291 test_runs=4"
printf '%s\n' "$out" > "$TMP/footer-full.txt"

setcfg "printf 'test_secs=400\n'"
out=$(foot 480 FAKE_KV="$KV_FULL" FAKE_HUMAN="$HUMAN_FULL")
read -r tot t a o <<< "$(segs "$out")"
say overlap_other_zero "$o" "0"
say overlap_noted "$(printf '%s\n' "$out" | grep -c '「其他」记为 0')" "1"

setcfg ""
out=$(foot 300 FAKE_KV="$KV_FULL" FAKE_HUMAN="$HUMAN_FULL")
read -r tot t a o <<< "$(segs "$out")"
say no_cmd_no_test "$t" "-"
say no_cmd_sum "$(( a + o ))" "$tot"
say no_cmd_no_test_secs "$(printf '%s\n' "$out" | tail -1 | grep -c test_secs)" "0"
# 没配项目命令的项目：总览照旧不提测试（「未跑测试」「测试未知」都只给配了命令的项目）
say no_cmd_overview_no_test "$(ov "$out" | grep -c '测试')" "0"

setcfg "echo test_secs=5; exit 3"
out=$(foot 300 FAKE_KV="$KV_FULL" FAKE_HUMAN="$HUMAN_FULL")
say cmd_fail_no_test "$(segs "$out" | cut -d' ' -f2)" "-"
say cmd_fail_noted "$(printf '%s\n' "$out" | grep -c '项目命令退出码 3')" "1"
# 配了命令却没取到数：总览写「测试未知」，不和「没跑测试」「没配命令」混成一样
say cmd_fail_overview "$(ov "$out" | grep -c '（测试未知 · AI 约 ')" "1"

setcfg "sleep 30 & sleep 30"
t0=$(date +%s)
out=$(foot 300 CAVIL_FOOTER_EXTRA_TIMEOUT=2 FAKE_KV="$KV_FULL" FAKE_HUMAN="$HUMAN_FULL")
say cmd_timeout_noted "$(printf '%s\n' "$out" | grep -c '超过 2 秒没结束')" "1"
say cmd_timeout_not_hung "$(( $(date +%s) - t0 < 15 ))" "1"
say cmd_timeout_marker "$(printf '%s\n' "$out" | grep -v '^$' | tail -1 | grep -c '^<!-- agent-metrics')" "1"
say cmd_timeout_overview "$(ov "$out" | grep -c '（测试未知 · AI 约 ')" "1"

setcfg "echo 测试跑了 5 分钟"
out=$(foot 300 FAKE_KV="$KV_FULL" FAKE_HUMAN="$HUMAN_FULL")
say cmd_badline_no_test "$(segs "$out" | cut -d' ' -f2)" "-"
say cmd_badline_noted "$(printf '%s\n' "$out" | grep -c '第一行不是')" "1"
say cmd_badline_overview "$(ov "$out" | grep -c '（测试未知 · AI 约 ')" "1"

# 机器记录里的测试秒数照项目命令的原文写，不在写出时舍入；总览照样按整秒显示
setcfg "printf 'test_secs=123.456789\n'"
out=$(foot 480 FAKE_KV="$KV_FULL" FAKE_HUMAN="$HUMAN_FULL")
say test_secs_exact "$(printf '%s\n' "$out" | tail -1 | grep -o 'test_secs=[^ ]*')" "test_secs=123.456789"
say test_secs_overview_rounded "$(segs "$out" | cut -d' ' -f2)" "123"
setcfg "printf 'test_secs=1234567\n'"
out=$(foot 480 FAKE_KV="$KV_FULL" FAKE_HUMAN="$HUMAN_FULL")
say test_secs_exact_large "$(printf '%s\n' "$out" | tail -1 | grep -o 'test_secs=[^ ]*')" "test_secs=1234567"

# 项目命令确认这轮一条测试都没跑：总览写「未跑测试」，各段相加仍等于总耗时，机器记录照写 0
setcfg "printf 'test_secs=0\n- 本轮未跑测试\n'"
out=$(foot 300 FAKE_KV="$KV_FULL" FAKE_HUMAN="$HUMAN_FULL")
say zero_test_overview "$(ov "$out" | grep -c '（未跑测试 · AI 约 ')" "1"
read -r tot t a o <<< "$(segs "$out")"
say zero_test_sum "$t $(( a + o ))" "- $tot"
say zero_test_secs_kept "$(printf '%s\n' "$out" | tail -1 | grep -c ' test_secs=0 ')" "1"

# 项目命令回答「跑过但耗时未知」（test_secs=unknown，例如只有后台 / 未完成的运行）：总览写「测试未知」
# 而不是「未跑测试」；项目给的细节和机器字段照常保留，机器记录里不写非数字的 test_secs
setcfg "printf 'test_secs=unknown\n- 测试 1 次（后台运行，未计时）\nkv runs_seen=1\n'"
out=$(foot 300 FAKE_KV="$KV_FULL" FAKE_HUMAN="$HUMAN_FULL")
say unknown_test_overview "$(ov "$out" | grep -c '（测试未知 · AI 约 ')" "1"
say unknown_test_detail_kept "$(printf '%s\n' "$out" | grep -c '^- 测试 1 次（后台运行，未计时）$')" "1"
say unknown_test_marker "$(printf '%s\n' "$out" | tail -1 | grep -c 'test_secs=') $(printf '%s\n' "$out" | tail -1 | grep -c ' runs_seen=1 ')" "0 1"
say unknown_test_no_fail_note "$(printf '%s\n' "$out" | grep -c '测试统计没取到')" "0"

setcfg "printf 'test_secs=10\nkv wall_secs=1 models=evil test_secs=9 cost_usd=0 runs=3 bad=a--b\n'"
out=$(foot 300 FAKE_KV="$KV_FULL" FAKE_HUMAN="$HUMAN_FULL")
m=$(printf '%s\n' "$out" | tail -1)
say kv_collision_kept_core "$(printf '%s' "$m" | grep -o 'wall_secs=[0-9]*' | wc -l | tr -d ' ') $(printf '%s' "$m" | grep -o 'models=[^ ]*') $(printf '%s' "$m" | grep -o 'test_secs=[^ ]*' | tr '\n' ' ')" "1 models=claude-opus-5-5 test_secs=10 "
say kv_collision_new_kept "$(printf '%s' "$m" | grep -c ' runs=3 ')" "1"
say kv_unsafe_dropped "$(printf '%s' "$m" | grep -c 'bad=')" "0"

setcfg ""
out=$(foot 300 FAKE_KV="${KV_FULL% ai_secs=*}" FAKE_HUMAN="$HUMAN_FULL")
say ai_unknown "$(printf '%s\n' "$out" | grep -c '（AI 时间未知）｜')" "1"
say ai_unknown_no_other "$(ov "$out" | grep -c '其他')" "0"

out=$(foot 300 FAKE_KV="" FAKE_HUMAN="")
say no_usage "$(ov "$out" | grep -c '｜模型未知 · token 未知$')" "1"
say no_usage_detail "$(printf '%s\n' "$out" | grep -c 'token 明细：未知')" "1"

out=$(foot 300 FAKE_KV="${KV_FULL/cost_state=full/cost_state=partial}" FAKE_HUMAN="$HUMAN_FULL")
say cost_partial "$(ov "$out" | grep -c '约 \$2.48（部分用量未计价，偏低）$')" "1"
kv_none=$(printf '%s' "$KV_FULL" | sed 's/ cost_usd=[^ ]*//; s/cost_state=full/cost_state=none/')
out=$(foot 300 FAKE_KV="$kv_none" FAKE_HUMAN="$HUMAN_FULL")
say cost_none "$(ov "$out" | grep -c '金额未计（没有单价）$')" "1"
out=$(foot 300 FAKE_KV="${KV_FULL/models=claude-opus-5-5 model_unknown=no/models=a,b model_unknown=yes}" FAKE_HUMAN="$HUMAN_FULL")
say model_list "$(ov "$out" | grep -c '｜模型：a、b；另有模型无法确认 · ')" "1"
# 总览进 <summary> 前做 HTML 转义：模型名带尖括号也弄不坏折叠块
out=$(foot 300 FAKE_KV="${KV_FULL/models=claude-opus-5-5/models=x<y>\&z}" FAKE_HUMAN="$HUMAN_FULL")
say summary_escaped "$(ov "$out" | grep -c '｜模型：x&lt;y&gt;&amp;z · ') $(printf '%s\n' "$out" | grep -c '</details>')" "1 1"

# 【4】周报读法：同一条 footer，机器记录与可见部分读出同一组数
python3 - "$S/weekly-report" "$TMP/footer-full.txt" <<'PY'
import sys
sys.path.insert(0, sys.argv[1])
import record
foot = open(sys.argv[2]).read()
body = "## 正文\n\n第一段\n\n" + foot
def say(n, got, want):
    print(f"PASS {n}" if got == want else f"FAIL {n} :: 期望 [{want}] 实得 [{got}]")
m = record.extract(body, "acme-bot", 1, 7)
say("weekly_marker", (m and m["src"], m and m["wall"]), ("marker", m and int((m["end"] - m["start"]).total_seconds())))
lines = body.rstrip("\n").split("\n")
v = record.extract("\n".join(lines[:-1]), "acme-bot", 2, 7)       # 去掉机器记录
say("weekly_new_visible", v and v["src"], "footer")
if v:
    # 可见部分精确到秒，机器记录带时区；token 可见部分是截断下界
    say("weekly_new_same_window", (v["start"], v["end"]),
        (m["start"].replace(microsecond=0), m["end"].replace(microsecond=0)))
    say("weekly_new_same_tokens", v["tokens"], {"in": 24, "out": 15600, "cache_r": 8500000, "cache_w": 58700})
    say("weekly_new_same_cost", (v["cost"], v["has_cost"]), (2.48, True))
# GitHub#88 那一版（总览一行、下面单独一个「细节」折叠头）已有评论在用，照样要认
v88 = "\n".join(sum(([l[len("<details><summary>"):-len("</summary>")], "<details><summary>细节</summary>"]
                      if l.startswith("<details><summary>⏱️") else [l] for l in lines[:-1]), []))
w = record.extract(v88, "acme-bot", 5, 7)
say("weekly_v88_visible", w and (w["src"], w["start"], w["end"], w["tokens"]),
    v and ("footer", v["start"], v["end"], v["tokens"]))
old = ("正文\n\n---\n⏱️ 开始 2026-10-27 08:48:16 · 完工 08:56:16 · 耗时 8m 0s\n"
       "token 24 input, 15.6k output, 8.5m cache read, 58.7k cache write ($2.48)（模型：claude-opus-5-5）")
o = record.extract(old, "acme-bot", 3, 7)
say("weekly_old_visible", o and (o["src"], o["wall"], o["cost"]), ("footer", 480, 2.48))
# 正文里零散提到「耗时：」「token 明细：」凑不出新排版的形状：折叠头后第一条必须是开始 / 完工，
# #88 那一版的总览后必须紧跟「细节」折叠头
loose = ("<details><summary>⏱️ 耗时：8m 0s（AI 约 1m）</summary>\n\n上面那行是总览的样子，下面是细节的样子：\n"
         "- 开始 2026-10-27 08:48:16 · 完工 08:56:16\n- token 明细：1 input, 999k output ($9.00)\n</details>")
loose88 = "⏱️ 耗时：8m 0s（AI 约 1m）\n- 开始 2026-10-27 08:48:16 · 完工 08:56:16\n- token 明细：1 input, 999k output ($9.00)"
say("weekly_new_needs_shape", (record.extract(loose, "acme-bot", 4, 7), record.extract(loose88, "acme-bot", 6, 7)), (None, None))
PY
CHECK

export START CPROJ CSESS WT TMP FAKE KV_FULL HUMAN_FULL

run_check() { bash "$TMP/check.sh" "$1" 2>&1; }

# 【1】–【4】跑真实脚本
echo "【1–4】真实脚本"
res=$(run_check "$REPO_DIR/scripts")
while IFS= read -r l; do
    case "$l" in
        PASS\ *) ok "${l#PASS }" ;;
        FAIL\ *) n="${l#FAIL }"; bad "${n%% ::*}" "${n#* :: }" ;;
        *) [ -n "$l" ] && echo "     $l" ;;
    esac
done <<< "$res"

# 【5】模板：走生产拼装函数拿到四份成品，占位用 _lib.sh 生产的值替换，把 footer 段原样跑一遍
echo "【5】四份模板拼装后的 footer 段"
PROJ="$TMP/project"
mkdir -p "$PROJ/.agents/skills/cavil-loop" "$TMP/state"
cp -r "$REPO_DIR/.agents/skills/cavil-loop/prompts" "$PROJ/.agents/skills/cavil-loop/prompts"
cat > "$TMP/lib.config" <<CONF
REPO="example/none"
PROJECT_ROOT="$PROJ"
WORKTREE_BASE="$TMP/wt"
STATE_DIR="$TMP/state"
TMUX_PREFIX="ft"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
WORKER_AGENT_DEFAULT="claude"
COMMENT_FOOTER_EXTRA_CMD="printf 'test_secs=12\\n'"
CONF
REAL_HOME="$HOME"
export HOME="$TMP/home"          # _lib.sh 找托管入口用 HOME；沙盘里没有，落到仓库里的脚本
export CODING_AGENT_CONFIG="$TMP/lib.config"
# 在托管安装 / worker 里跑测试时这个变量指向线上那份发布，_lib.sh 会去那里找脚本
unset CODING_AGENT_RELEASE_ROOT CODING_AGENT_RELEASE_LEASE_FD
exec 8>&2
# shellcheck source=../scripts/_lib.sh
source "$REPO_DIR/scripts/_lib.sh"
exec 2>&8 8>&-
set +e
SKILL_DIR="$REPO_DIR"
case "${COMMENT_FOOTER_CMD:-}" in
    *"--driver '$AGENT_TOKEN_USAGE_SCRIPT'"*"--config '$TMP/lib.config'"*) ok "_lib.sh 的 footer 命令带上它选好的用量驱动和项目配置" ;;
    *) bad "_lib.sh 的 footer 命令没带上选好的用量驱动 / 项目配置" "${COMMENT_FOOTER_CMD:-}" ;;
esac
template_check() { # $1 = skill 目录（含 prompts/）；打印 PASS / FAIL
SKILL_DIR="$1"
local name f block rendered got first_block=""
for name in new-issue issue-comment pr-comment review; do
    f=$(compose_prompt_template "$name" 2>/dev/null)
    if [ ! -s "$f" ]; then echo "FAIL tpl_$name :: 拼装失败"; continue; fi
    cp "$f" "$TMP/composed-$name.md"
    block=$(awk '/^ *```bash$/{b=""; inb=1; next} inb && /^ *```$/{if (b ~ /COMMENT_FOOTER_CMD/) printf "%s", b; inb=0; next} inb{sub(/^   /, ""); b=b $0 "\n"}' "$TMP/composed-$name.md")
    if [ -z "$block" ]; then echo "FAIL tpl_$name :: 成品里没有调用 footer 脚本的那段命令"; continue; fi
    [ -z "$first_block" ] && first_block="$block"
    if [ "$block" = "$first_block" ]; then echo "PASS tpl_same_$name"
    else echo "FAIL tpl_same_$name :: footer 命令与 new-issue 的不一致"; fi
    if grep -q 'AGENT_TOKEN_USAGE_SCRIPT\|⏱️ 开始 %s' "$TMP/composed-$name.md"; then
        echo "FAIL tpl_noold_$name :: 成品里还留着手拼 footer 的旧说明"
    else
        echo "PASS tpl_noold_$name"
    fi
    # 开始时刻取夹具起点：真驱动读夹具会话，AI 时间应是夹具算好的 31 秒
    rendered=$(printf '%s' "$block" | sed -e "s|\${COMMENT_FOOTER_CMD}|${COMMENT_FOOTER_CMD:-}|g" \
        -e "s|\${TASK_START_TS}|$(date -d "@$START" '+%Y-%m-%d %H:%M:%S')|g" \
        -e "s|\${WORK_NUM}|7|g" -e "s|^BODY=.*|BODY=$TMP/body-$name.md|")
    printf '## 正文\n' > "$TMP/body-$name.md"
    (cd "$WT" && HOME="$TMP/home" CLAUDE_PROJECTS_DIR="$TMP/home/.claude/projects" bash -c "$rendered") 2>/dev/null
    got="$TMP/body-$name.md.footer"
    if [ -s "$got" ] && head -1 "$got" | grep -q '^## 正文$' \
       && grep -v '^$' "$got" | tail -1 | grep -q '^<!-- agent-metrics agent=claude wt=7 .* ai_secs=31.000 ai_requests=5 test_secs=12 -->$' \
       && grep -qE '^<details><summary>⏱️ 耗时：1h [0-9]+m [0-9]+s（测试 12s · AI 约 31s · 其他 ' "$got"; then
        echo "PASS tpl_$name"
    else
        echo "FAIL tpl_$name :: 照成品命令没跑出预期的评论：$(grep -v '^$' "$got" 2>/dev/null | sed -n '2p;$p' | tr '\n' '|')"
    fi
    rm -f "$got"
done
}
report() { # 把 PASS / FAIL 行转成 ✅ / ❌；$1 = PASS 时的说明后缀
    local l n
    while IFS= read -r l; do
        case "$l" in
            PASS\ *) ok "${l#PASS }${1:-}" ;;
            FAIL\ *) n="${l#FAIL }"; bad "${n%% ::*}" "${n#* :: }" ;;
        esac
    done
}
template_check "$REPO_DIR" | report "（tpl_<模板> = 照成品命令跑出正文 + footer、机器记录在末行；same = 四份逐字一致；noold = 无手拼旧说明）"

export HOME="$REAL_HOME"

# 【5b】三个派工脚本真的把占位换掉：起真派工脚本（假 gh / 假 tmux），读它写出的 prompt
echo "【5b】三个派工脚本渲染出的 prompt"
DSB="$TMP/dispatch"
mkdir -p "$DSB/bin" "$DSB/state" "$DSB/wt"
git init -q --bare "$DSB/upstream.git"
git clone -q "$DSB/upstream.git" "$DSB/seed" 2>/dev/null
(cd "$DSB/seed" && git config user.email t@example.invalid && git config user.name t \
    && echo x > f && git add f && git commit -qm init && git push -q origin HEAD:main) >/dev/null 2>&1
git clone -q "$DSB/upstream.git" "$DSB/project" 2>/dev/null
cat > "$DSB/bin/gh" <<'SH'
#!/usr/bin/env bash
case "$*" in
    *"--jq .title"*|*title*) echo "测试标题" ;;
    *) echo "{}" ;;
esac
exit 0
SH
cat > "$DSB/bin/tmux" <<'SH'
#!/usr/bin/env bash
case "$1" in has-session) exit 1 ;; esac
exit 0
SH
chmod +x "$DSB/bin/gh" "$DSB/bin/tmux"
cat > "$DSB/config" <<CONF
REPO="example/none"
PROJECT_ROOT="$DSB/project"
WORKTREE_BASE="$DSB/wt"
STATE_DIR="$DSB/state"
TMUX_PREFIX="ftd"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
LABEL_AGENT_DOING="doing/agent"
WORKER_AGENT_DEFAULT="claude"
PATH="$DSB/bin:\$PATH"
CONF
# 编号取得很大，避免撞上本机真实派工写在 /tmp 下的 prompt
N_NEW=987601; N_CMT=987602; N_PR=987603
dispatch_check() { # $1 = scripts 目录；打印 PASS / FAIL
    local sd="$1" kind f
    rm -f "/tmp/cavil-loop-issue-$N_NEW-prompt.md" "/tmp/cavil-loop-issue-$N_CMT-cmt-0.md" "/tmp/cavil-loop-pr-$N_PR-prompt.md"
    (cd "$DSB/project" && env -u CODING_AGENT_RELEASE_ROOT HOME="$TMP/home" CODING_AGENT_CONFIG="$DSB/config" \
        bash "$sd/dispatch-new-issue.sh" "$N_NEW") >/dev/null 2>&1
    (cd "$DSB/project" && env -u CODING_AGENT_RELEASE_ROOT HOME="$TMP/home" CODING_AGENT_CONFIG="$DSB/config" \
        bash "$sd/dispatch-issue-comment.sh" "$N_CMT" 0) >/dev/null 2>&1
    (cd "$DSB/project" && env -u CODING_AGENT_RELEASE_ROOT HOME="$TMP/home" CODING_AGENT_CONFIG="$DSB/config" \
        bash "$sd/dispatch-pr-comment.sh" "$N_PR" "feature/issue-$N_PR" 0) >/dev/null 2>&1
    for kind in new-issue:"/tmp/cavil-loop-issue-$N_NEW-prompt.md" issue-comment:"/tmp/cavil-loop-issue-$N_CMT-cmt-0.md" \
                pr-comment:"/tmp/cavil-loop-pr-$N_PR-prompt.md"; do
        f="${kind#*:}"; kind="${kind%%:*}"
        if [ ! -s "$f" ]; then echo "FAIL dispatch_$kind :: 没写出 prompt"
        elif grep -q 'COMMENT_FOOTER_CMD' "$f"; then echo "FAIL dispatch_$kind :: 占位没被换掉"
        elif grep -q "^FOOTER=\$(bash '$sd/drivers/token-usage/comment-footer.sh' --agent 'claude' --driver '[^']*/claude.sh' --config '$DSB/config' --start \"20[0-9-]* [0-9:]*\" --wt \"[0-9]*\")\$" "$f"; then
            echo "PASS dispatch_$kind"
        else echo "FAIL dispatch_$kind :: 渲染出的命令不对：$(grep -m1 '^FOOTER=' "$f")"; fi
    done
    rm -f "/tmp/cavil-loop-issue-$N_NEW-prompt.md" "/tmp/cavil-loop-issue-$N_CMT-cmt-0.md" "/tmp/cavil-loop-pr-$N_PR-prompt.md"
}
while IFS= read -r l; do
    case "$l" in
        PASS\ *) ok "${l#PASS }：派工脚本渲染出可直接运行的 footer 命令" ;;
        FAIL\ *) n="${l#FAIL }"; bad "${n%% ::*}" "${n#* :: }" ;;
    esac
done <<< "$(dispatch_check "$REPO_DIR/scripts")"

# 【6】负对照：沙盘副本逐个改坏，对应检查必须变红
echo "【6】负对照（改坏一处，对应检查必须变红）"
neg() { # $1 = 说明；$2 = 文件（相对 scripts/）；$3 = python 替换表达式 old；$4 = new；$5 = 期望变红的检查名
    local sb="$TMP/neg/$5"
    rm -rf "$sb"; mkdir -p "$sb"; cp -r "$REPO_DIR/scripts" "$sb/scripts"
    python3 - "$sb/scripts/$2" "$3" "$4" <<'PY' || { bad "$1：改坏失败（原文没找到）"; return; }
import sys
p, old, new = sys.argv[1:4]
s = open(p).read()
if old not in s:
    sys.exit(1)
open(p, "w").write(s.replace(old, new, 1))
PY
    run_check "$sb/scripts" > "$sb/check.out"
    if grep -q "^FAIL $5 " "$sb/check.out"; then ok "$1 → $5 变红"
    else bad "$1 → $5 没变红（这条检查拦不住这种改坏）"; fi
}
neg "AI 时间不取并集、逐段相加" drivers/token-usage/ai_time.py \
    "return union_ms(spans, start_ms, end_ms), len(spans)" \
    "return sum(min(b, end_ms) - max(a, start_ms) for a, b in spans), len(spans)" ai_claude
neg "claude 不以工具结果为请求起点（工具时间算进 AI）" drivers/token-usage/ai_time.py \
    '        elif t == "user":
            ready = ts' '        elif t == "user":
            pass' ai_claude
neg "codex 本轮结束后不清起点（轮间空闲算进 AI）" drivers/token-usage/ai_time.py \
    '            ready = None' '            pass' ai_codex
neg "子代理记录也算进 claude 的 AI 时间" drivers/token-usage/ai_time.py \
    '        if r.get("isSidechain"):
            continue' '' ai_claude
neg "claude 驱动不附 AI 时间" drivers/token-usage/claude.sh \
    '[ -z "$AI" ] || LINE="$LINE $AI"' ':' driver_claude
neg "codex 驱动不附 AI 时间" drivers/token-usage/codex.sh \
    '[ -z "$AI" ] || LINE="$LINE $AI"' ':' driver_codex
neg "「其他」不封底为 0" drivers/token-usage/comment_footer.py \
    'segs.append(f"其他 {fmt_dur(max(0, other))}")' 'segs.append(f"其他 {other}s")' overlap_other_zero
neg "AI 秒数不按显示值相减" drivers/token-usage/comment_footer.py \
    'other = wall - (test or 0) - ai' 'other = wall - (test or 0) - float(kv["ai_secs"])' sum_equals_total
neg "机器记录里的测试秒数按 :g 格式化（只留六位有效数字）" drivers/token-usage/comment_footer.py \
    'marker.append(f"test_secs={extra[0]}")' 'marker.append(f"test_secs={float(extra[0]):g}")' test_secs_exact
neg "项目字段可以覆盖核心字段" drivers/token-usage/comment_footer.py \
    'and k not in reserved' '' kv_collision_kept_core
neg "超时不杀子进程组" drivers/token-usage/comment_footer.py \
    'os.killpg(p.pid, signal.SIGKILL)' 'p.kill()' cmd_timeout_not_hung
neg "周报不认新排版" weekly-report/record.py \
    '(_legacy_footer(lines), _new_footer(lines))' '(_legacy_footer(lines),)' weekly_new_visible
neg "新排版不核对开始 / 完工的位置" weekly-report/record.py \
    'head = RE_NEW_HEAD.match(rest[0]) if rest else None' 'head = next((h for h in map(RE_NEW_HEAD.match, rest) if h), None)' weekly_new_needs_shape
neg "#88 那一版不核对「细节」折叠头" weekly-report/record.py \
    'if not rest or not RE_NEW_DETAILS.match(rest[0]):
                continue
            rest = rest[1:]' 'rest = [l for l in rest if not RE_NEW_DETAILS.match(l)]' weekly_new_needs_shape
neg "周报不认 #88 那一版" weekly-report/record.py \
    'RE_NEW_FOLD.match(l.strip()) or RE_NEW_SUM.match(l.strip())' 'RE_NEW_FOLD.match(l.strip())' weekly_v88_visible
neg "总览不转义就进 <summary>" drivers/token-usage/comment_footer.py \
    'html.escape(head, quote=False)' 'head' summary_escaped
neg "总览不做折叠标题（退回 #88 的两行）" drivers/token-usage/comment_footer.py \
    'f"<details><summary>{html.escape(head, quote=False)}</summary>"' 'head, "<details><summary>细节</summary>"' overview_is_summary

neg "统计失败时总览不写「测试未知」" drivers/token-usage/comment_footer.py \
    'test_seg = "测试未知"' 'test_seg = None' cmd_fail_overview
neg "命令确认没跑测试时总览不写「未跑测试」" drivers/token-usage/comment_footer.py \
    'if test is not None else "未跑测试"' 'if test is not None else None' zero_test_overview
neg "没配命令的项目也写测试段" drivers/token-usage/comment_footer.py \
    'segs = [test_seg] if test_seg else []' 'segs = [test_seg or "测试未知"]' no_cmd_overview_no_test
neg "AI 估算长说明又放回每条评论" drivers/token-usage/comment_footer.py \
    '    if ai is None:' '    details.append("- AI 时间是估算：偏差来源……") if ai is not None else None
    if ai is None:' ai_note_gone

neg "项目回答 unknown 时当成 0 秒（写成「未跑测试」）" drivers/token-usage/comment_footer.py \
    'if test_text == TEST_UNKNOWN:
                test_seg = "测试未知"
            else:' 'if test_text == TEST_UNKNOWN:
                test_text = "0"
            if True:' unknown_test_overview

# 模板：每份单独去掉 footer 段里调脚本那一行，只有那一份变红
for name in new-issue issue-comment pr-comment review; do
    sk="$TMP/neg/tpl-$name"; rm -rf "$sk"; mkdir -p "$sk"; cp -r "$REPO_DIR/prompts" "$sk/prompts"
    sed -i '/COMMENT_FOOTER_CMD/d' "$sk/prompts/$name.template.md"
    out=$(template_check "$sk")
    if printf '%s\n' "$out" | grep -q "^FAIL tpl_$name " \
       && [ "$(printf '%s\n' "$out" | grep -c '^FAIL tpl_[a-z-]* ')" = 1 ]; then
        ok "$name 模板去掉 footer 命令 → 只有 tpl_$name 变红"
    else
        bad "$name 模板去掉 footer 命令 → 没有恰好变红 tpl_$name" "$(printf '%s\n' "$out" | grep '^FAIL' | head -3)"
    fi
done
# 派工脚本：每个单独去掉渲染这个占位的那一行，只有它写出的 prompt 变红
for kind in new-issue issue-comment pr-comment; do
    sb="$TMP/neg/dispatch-$kind"; rm -rf "$sb"; mkdir -p "$sb"
    cp -r "$REPO_DIR/scripts" "$sb/scripts"; cp -r "$REPO_DIR/prompts" "$sb/prompts"
    sed -i '/COMMENT_FOOTER_CMD/d' "$sb/scripts/dispatch-$kind.sh"
    out=$(dispatch_check "$sb/scripts")
    if printf '%s\n' "$out" | grep -q "^FAIL dispatch_$kind " \
       && [ "$(printf '%s\n' "$out" | grep -c '^FAIL')" = 1 ]; then
        ok "dispatch-$kind.sh 不渲染占位 → 只有 dispatch_$kind 变红"
    else
        bad "dispatch-$kind.sh 不渲染占位 → 没有恰好变红 dispatch_$kind" "$(printf '%s\n' "$out" | head -3)"
    fi
done

echo
echo "通过 $pass，失败 $fail"
[ "$fail" -eq 0 ]
