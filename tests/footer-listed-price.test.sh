#!/usr/bin/env bash
# kind: e2e
# 评论 footer 直接取官方最新价，不反推（GitHub#606；维护者在 PR #612 定的：「不要反推，取最新的，缓存一天」）。
#
# 跑法：bash tests/footer-listed-price.test.sh
# 依赖：python3、jq。不碰网络（价目来源是 tests/fixtures/price-fetch/ 下的 file:// 假文件），
#       不读本机真实会话（HOME / XDG_CACHE_HOME / CLAUDE_PROJECTS_DIR 全指到临时目录）。
#
# 全部跑真实脚本：
#   【1】价目表 `price_solve.py --listed`：每个模型取最新价（fetched）> 内置参照（reference_only）>
#        补缺价（fetched）；最新价文件坏掉、某模型缺项 / 有项不是合法数 → 那部分退回内置价
#   【2】驱动 `claude.sh`：取价一个日志文件都不读（别的工作目录的会话一个都不打开）；金额、
#        price_source、price_status 跟着价目表走；`--both` 两行与分别单独调用逐字节一致
#   【3】footer `comment-footer.sh`：Claude 一侧价目表只取 1 次（直接输出、接进正文文件两种方式）
#   【4】每天抓一次（price_fetch.py）：没到时间不联网；到时间抓、写下次时刻；抓失败旧文件不动、
#        冷却后再试；下次时刻文件读不出 = 到时间
#   【5】daemon 钩子（_lib.sh 的 price_fetch_tick）：没标记、没到时间 → 不启动脚本；到时间 → 启动
#   【6】「下次时刻」文件：同一组内容交给钩子和抓价脚本，结论一致
#   【7】缓存路径上不是普通文件（命名管道）或文件过大：取价、驱动、抓价、钩子都不卡住，当作没有 / 到时；
#        关掉下载后两类已下载的价照用（文档写的行为）
#   【8】补抓价缓存 / 抓价状态里结构坏掉的一层：Claude 取价、Codex 取价、周报补算、daemon 补抓四个
#        使用方都只丢那一层，好的照用；坏记录不算「已有价」，标记留着，抓到合法价后才删
#   【9】读回的每个数都过同一个数值检查：抓价状态里的重试时刻、网络上 LiteLLM 的单价是超大整数 /
#        无穷 / NaN / 负数时，那一项当作没有，别的模型照常补价；正常的冷却照样挡住重复抓取
#   【10】价格缓存写不进去：这个模型什么都不提交（不记尝试、标记留着），同轮另一个模型照常处理并保存
#        状态；写入恢复后下一轮补上。每日刷新写不进去：不算刷新过，10 分钟后再试
set -uo pipefail
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
TU="$REPO_DIR/scripts/drivers/token-usage"
SOLVER="$REPO_DIR/scripts/weekly-report/price_solve.py"
FX="$TEST_DIR/fixtures/price-fetch"
TMP=$(mktemp -d)
trap '[ -n "${KEEP:-}" ] && echo "TMP=$TMP" || rm -rf "$TMP"' EXIT
export TZ=Asia/Shanghai
export HOME="$TMP/home"
export XDG_CACHE_HOME="$TMP/cache"
export CLAUDE_PROJECTS_DIR="$HOME/.claude/projects"
export PRICE_FETCH_ANTHROPIC_URL="file://$FX/anthropic.md"
export PRICE_FETCH_OPENAI_URL="file://$FX/openai.md"
export PRICE_FETCH_LITELLM_URL="file://$FX/litellm.json"
unset PRICE_AUTO_FETCH PRICE_FETCH_COOLDOWN_SECS PRICE_LATEST_REFRESH_SECS PRICE_POLICY
CACHE="$XDG_CACHE_HOME/cavil-loop"
LATEST="$CACHE/latest-prices.json"
NEXT="$CACHE/latest-prices.next"
mkdir -p "$HOME" "$CACHE"

pass=0; fail=0
ok()  { echo "  ✅ $1"; pass=$((pass + 1)); }
bad() { echo "  ❌ $1"; [ -n "${2:-}" ] && printf '     %s\n' "$2"; fail=$((fail + 1)); }
chk() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "期望 [$3] 实得 [$2]"; fi; }

# ── 探针：测试自己的 sitecustomize（审计钩子），生产代码不动 ─────────────────────
#   每个 python 进程打开 PROBE_ROOT 下的 .jsonl 记 "open <路径>"；price_solve.py 每跑一次记 "solver"
PROBE="$TMP/probe"; mkdir -p "$PROBE"
cat > "$PROBE/sitecustomize.py" <<'PY'
import os, sys
_log, _root = os.environ.get("PROBE_LOG"), os.environ.get("PROBE_ROOT")
def _w(s):
    with open(_log, "a", encoding="utf-8") as f:
        f.write(s + "\n")
if _log:
    if os.path.basename(sys.argv[0] if sys.argv else "") == "price_solve.py":
        _w("solver " + " ".join(sys.argv[1:]))
    def _hook(ev, args):
        if ev == "open" and args and isinstance(args[0], str) and _root \
                and args[0].startswith(_root + "/") and args[0].endswith(".jsonl"):
            _w("open " + args[0])
    sys.addaudithook(_hook)
PY
export PYTHONPATH="$PROBE${PYTHONPATH:+:$PYTHONPATH}"
export PROBE_ROOT="$CLAUDE_PROJECTS_DIR"
PLOG="$TMP/probe.log"

# ── 会话快照：本工作目录一份（两种模型），别的工作目录一份（不该被打开）─────────────
START=1790000000
WT="$TMP/wt/proj-issue-7"; OTHER="$TMP/wt/proj-issue-8"
mkdir -p "$WT" "$OTHER"
python3 - "$CLAUDE_PROJECTS_DIR" "$START" "$WT" "$OTHER" <<'PY'
import json, os, sys, datetime
base, start, wt, other = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4]
def iso(t):
    return datetime.datetime.fromtimestamp(t, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
def asst(t, rid, model, i, o, cr, w5, w1):
    return {"type": "assistant", "timestamp": iso(t), "requestId": rid, "uuid": rid,
            "message": {"model": model, "usage": {
                "input_tokens": i, "output_tokens": o, "cache_read_input_tokens": cr,
                "cache_creation": {"ephemeral_5m_input_tokens": w5, "ephemeral_1h_input_tokens": w1}}}}
def put(cwd, name, recs):
    d = os.path.join(base, cwd.replace("/", "-"))
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, name), "w", encoding="utf-8") as f:
        for r in recs:
            f.write(json.dumps(r) + "\n")
put(wt, "a.jsonl", [asst(start + 10, "r1", "claude-opus-5-5", 1000, 2000, 1000000, 10000, 20000),
                    asst(start + 20, "r2", "claude-gap-9", 1000, 1000, 0, 0, 0)])
put(other, "b.jsonl", [asst(start + 10, "x1", "claude-opus-5-5", 5, 5, 5, 5, 5)])
PY

drv() { ( cd "$WT" && bash "$TU/claude.sh" "$START" "$@" ); }
kvget() { tr ' ' '\n' <<<"$1" | sed -n "s/^$2=//p"; }
# 金额是不舍入的浮点原值（0.8175000000000001），比较时按 6 位小数
r6() { sed -E 's/([0-9]+\.[0-9]+(E-?[0-9]+)?)/\n\1\n/g' <<<"$1" | awk 'NR%2==0{printf "%.6f",$0;next}{printf "%s",$0}'; }
listed() { python3 "$SOLVER" --listed; }
put_latest() { mkdir -p "$CACHE"; printf '%s\n' "$1" > "$LATEST"; }
put_gap() { printf '{"claude":{"claude-gap-9":{"prices":{"input":1,"output":2,"cache_read":0.1,"cache_write_5m":1.25,"cache_write_1h":2}}}}\n' > "$CACHE/fetched-prices.json"; }
L55='{"claude":{"models":{"claude-opus-5-5":{"input":5,"output":25,"cache_read":0.5,"cache_write_5m":6.25,"cache_write_1h":10}}}}'

echo "── 1. 价目表：最新价 > 内置参照 > 补缺价，坏的退回 ──"
rm -rf "$CACHE"; mkdir -p "$CACHE"
T=$(listed)
chk "没有最新价：opus-5-5 用内置参照，出处 reference_only" \
    "$(jq -c '.models["claude-opus-5-5"].input' <<<"$T")" '{"status":"reference_only","price":4}'
chk "形状与 --table 相同：models + fast，快速档在" "$(jq -c '[has("models"), (.fast["claude-opus-5-5"].input)]' <<<"$T")" '[true,8]'
put_latest "$L55"; put_gap
T=$(listed)
chk "有最新价：opus-5-5 取最新价，出处 fetched" "$(jq -c '.models["claude-opus-5-5"].output' <<<"$T")" '{"status":"fetched","price":25.0}'
chk "内置表里有、最新价里没有的模型照旧用内置" "$(jq -r '.models["claude-haiku-4-5"].input.status' <<<"$T")" "reference_only"
chk "两样都没有的模型用补缺价，出处 fetched" "$(jq -c '.models["claude-gap-9"].output' <<<"$T")" '{"status":"fetched","price":2.0}'
put_latest '{"claude":{"models":{"claude-gap-9":{"input":3,"output":6,"cache_read":0.3,"cache_write_5m":3.75,"cache_write_1h":6}}}}'
chk "最新价也收录了补缺的模型：最新价优先" "$(jq -r '.models["claude-gap-9"].output.price' <<<"$(listed)")" "6.0"
for bad_latest in 'not json' '[]' '{"claude":{"models":[]}}' \
        '{"claude":{"models":{"claude-opus-5-5":{"input":5,"output":25}}}}' \
        '{"claude":{"models":{"claude-opus-5-5":{"input":"5","output":25,"cache_read":0.5,"cache_write_5m":6.25,"cache_write_1h":10}}}}' \
        '{"claude":{"models":{"claude-opus-5-5":{"input":-1,"output":25,"cache_read":0.5,"cache_write_5m":6.25,"cache_write_1h":10}}}}' \
        '{"claude":{"models":{"claude-opus-5-5":{"input":true,"output":25,"cache_read":0.5,"cache_write_5m":6.25,"cache_write_1h":10}}}}'; do
    put_latest "$bad_latest"
    chk "最新价坏掉（${bad_latest:0:40}…）→ opus-5-5 退回内置参照" \
        "$(jq -c '.models["claude-opus-5-5"].input' <<<"$(listed)")" '{"status":"reference_only","price":4}'
done
# 一项超大 / 越界的单价只让那个模型退回内置价，其余下载来的价照用（PR #612 复审第 1 轮：
# JSON 里的 10**400 转浮点抛异常，整张表取价失败）
BIG=$(python3 -c 'print(10**400)')
for v in "$BIG" "-$BIG" 1e400 1001; do
    put_latest "{\"claude\":{\"models\":{\"claude-sonnet-4-6\":{\"input\":$v,\"output\":1,\"cache_read\":1,\"cache_write_5m\":1,\"cache_write_1h\":1},$(jq -c '.claude.models | to_entries[0] | "\(.key|tojson):\(.value|tojson)"' -r <<<"$L55")}}}"
    T=$(listed)
    chk "最新价里有一项单价是 ${v:0:12}…：取价照常出表，这个模型退回内置、别的模型仍用下载价" \
        "$(jq -c '[.models["claude-sonnet-4-6"].input.status, .models["claude-sonnet-4-6"].input.price, .models["claude-opus-5-5"].input.status]' <<<"$T" 2>/dev/null)" \
        '["reference_only",3,"fetched"]'
    printf '{"claude":{"claude-gap-9":{"prices":{"input":%s,"output":2}}}}\n' "$v" > "$CACHE/fetched-prices.json"
    # input 不合法 = 这个模型的 token 有一大块没法计价：整条补缺记录不算有价（复审第 3 轮），表照常出
    chk "补缺价里 input 是 ${v:0:12}…：取价照常出表，这条补缺记录不收" \
        "$(jq -c '[(.models | has("claude-gap-9")), .models["claude-opus-5-5"].input.status]' <<<"$(listed)" 2>/dev/null)" '[false,"fetched"]'
done
rm -f "$CACHE/fetched-prices.json"

echo "── 2. 驱动：不读别的会话，金额跟着价目表走 ──"
rm -rf "$CACHE"; mkdir -p "$CACHE"; : > "$PLOG"
KV=$(PROBE_LOG="$PLOG" drv --kv)
chk "取价没打开任何别的工作目录的会话" "$(grep -c "proj-issue-8" "$PLOG")" "0"
chk "price_solve.py 只以 --listed 跑了 1 次" "$(grep '^solver' "$PLOG")" "solver --listed"
# 内置 opus-5-5：in 4、out 20、读 0.2、5m 5、1h 8 → 0.004 + 0.04 + 0.2 + 0.05 + 0.16 = 0.454；gap-9 无价
chk "无最新价：金额按内置参照，gap-9 那部分记缺价" \
    "$(r6 "$(kvget "$KV" cost_state) $(kvget "$KV" cost_unknown_tokens) $(kvget "$KV" price_source) $(kvget "$KV" price_status)")" \
    "partial 2000 default reference_only:0.454000"
put_latest "$L55"; put_gap
KV=$(drv --kv); HUMAN=$(drv)
# 最新 opus-5-5：0.005 + 0.05 + 0.5 + 0.0625 + 0.2 = 0.8175；gap-9：0.001 + 0.002 = 0.003
chk "有最新价：两部分都是 fetched，cost_state=full" \
    "$(r6 "$(kvget "$KV" cost_state) $(kvget "$KV" price_status)")" "full fetched:0.820500"
chk "人读行注明含自动联网获取的单价" "$(grep -c '含自动联网获取的单价' <<<"$HUMAN")" "1"
BOTH=$(drv --both)
chk "--both 两行与分别单独调用逐字节一致" "$BOTH" "$(printf '%s\n%s' "$HUMAN" "$(drv --kv)")"
rm -rf "$CACHE"
chk "缓存目录整个不存在也照样出数（内置参照）" "$(r6 "$(kvget "$(drv --kv)" price_status)")" "reference_only:0.454000"

echo "── 3. footer：价目表只取 1 次 ──"
mkdir -p "$CACHE"; put_latest "$L55"
CONF="$TMP/project.config"; : > "$CONF"
STARTS=$(date -d "@$START" '+%Y-%m-%d %H:%M:%S')
footer() { ( cd "$WT" && PROBE_LOG="$PLOG" bash "$TU/comment-footer.sh" --agent claude \
               --driver "$TU/claude.sh" --config "$CONF" --start "$STARTS" --wt 7 "$@" ); }
: > "$PLOG"; F=$(footer)
chk "直接输出：价目表取了 1 次" "$(grep -c '^solver' "$PLOG")" "1"
chk "机器记录带最新价的金额" "$(r6 "$(grep -o 'price_status=[^ ]*' <<<"$F")")" "price_status=fetched:0.817500"
printf '## 正文\n' > "$TMP/body.md"; : > "$PLOG"; footer --body "$TMP/body.md" >/dev/null
chk "接进正文文件：价目表同样取了 1 次" "$(grep -c '^solver' "$PLOG")" "1"
chk "正文后面接上的 footer 带同样的金额" "$(r6 "$(grep -o 'price_status=[^ ]*' "$TMP/body.md.footer")")" "price_status=fetched:0.817500"
chk "整条 footer 没打开别的工作目录的会话" "$(grep -c "proj-issue-8" "$PLOG")" "0"

echo "── 4. 每天抓一次最新价（price_fetch.py）──"
fetch() { python3 "$TU/price_fetch.py"; }
rm -rf "$CACHE"
NOW=$(date +%s); OUT=$(fetch)
chk "第一次（没有下次时刻）：抓了，两源一致、五项齐全的才收" \
    "$(jq -c '.claude.models | keys' "$LATEST" 2>/dev/null)" '["claude-test-9","claude-zero-9"]'
chk "收进来的价取官方页的值" "$(jq -c '.claude.models["claude-test-9"] | map_values(. + 0)' "$LATEST")" \
    '{"cache_read":0.15,"cache_write_1h":6,"cache_write_5m":3.75,"input":3,"output":15}'
N1=$(cat "$NEXT")
chk "下次时刻 = 现在 + 一天" "$([ $((N1 - NOW)) -ge 86399 ] && [ $((N1 - NOW)) -le 86401 ] && echo yes || echo "$((N1 - NOW))")" "yes"
chk "日志写了更新几个模型、哪些没采用" "$(grep -c '已更新 Claude 最新价目：2 个模型；未采用' <<<"$OUT")" "1"
chk "价目表随之换上最新价" "$(jq -r '.models["claude-test-9"].input.status' <<<"$(listed)")" "fetched"
cp "$LATEST" "$TMP/latest.bak"
OUT=$(PRICE_FETCH_ANTHROPIC_URL="file://$TMP/nope.md" fetch)
chk "一天之内再跑：不抓（来源换成坏地址也没有失败日志），文件不动" \
    "$(printf '%s' "$OUT" | wc -c) $(cmp -s "$LATEST" "$TMP/latest.bak" && echo same)" "0 same"
echo 0 > "$NEXT"; NOW=$(date +%s)
OUT=$(PRICE_FETCH_ANTHROPIC_URL="file://$TMP/nope.md" fetch)
chk "到时间但官方页下载失败：旧文件不动" "$(cmp -s "$LATEST" "$TMP/latest.bak" && echo same)" "same"
N2=$(cat "$NEXT")
chk "失败后按冷却（6 小时）再试，日志说明继续用上次的价" \
    "$([ $((N2 - NOW)) -ge 21599 ] && [ $((N2 - NOW)) -le 21601 ] && echo yes || echo "$((N2 - NOW))") $(grep -c '最新价目抓取失败，6 小时后再试' <<<"$OUT")" "yes 1"
echo 0 > "$NEXT"
printf '# Pricing\n\n## Model pricing\n\n| Model | Base input tokens | Output tokens |\n| --- | --- | --- |\n| Claude Test 9 | $3 / MTok | $15 / MTok |\n' > "$TMP/short.md"
OUT=$(PRICE_FETCH_ANTHROPIC_URL="file://$TMP/short.md" fetch)
chk "页面只剩 input / output（缺项）：一个都不收，算失败，旧文件不动" \
    "$(cmp -s "$LATEST" "$TMP/latest.bak" && echo same) $(grep -c '没有一个模型两边一致、五项齐全' <<<"$OUT")" "same 1"
for junk in "" "abc" "12 34"; do
    printf '%s' "$junk" > "$NEXT"; rm -f "$LATEST"; fetch >/dev/null
    chk "下次时刻读不出（[$junk]）→ 当作到时间，照抓" "$([ -s "$LATEST" ] && echo fetched || echo idle)" "fetched"
done
rm -f "$LATEST"; mkdir -p "$CACHE/unpriced"; : > "$CACHE/unpriced/claude--claude-test-9"
echo 0 > "$NEXT"; fetch >/dev/null
chk "最新价已收录的模型，缺价标记直接删掉（不再单独补抓）" \
    "$([ -e "$CACHE/unpriced/claude--claude-test-9" ] && echo kept || echo removed) $(jq -r '.claude["claude-test-9"] // "none"' "$CACHE/fetched-prices.json" 2>/dev/null || echo none)" "removed none"
OUT=$(PRICE_AUTO_FETCH=0 bash -c 'rm -f "$1"; python3 "$2"' _ "$NEXT" "$TU/price_fetch.py")
chk "PRICE_AUTO_FETCH=0 → 到时间也不抓" "$([ -e "$NEXT" ] && echo ran || echo idle)" "idle"

echo "── 5. daemon 钩子（_lib.sh 的 price_fetch_tick）──"
SB="$TMP/sb"; mkdir -p "$SB/state" "$SB/project" "$SB/wt"
cat > "$SB/coding-agent.config" <<CONF
REPO="acme/widget"
PROJECT_ROOT="$SB/project"
WORKTREE_BASE="$SB/wt"
STATE_DIR="$SB/state"
TMUX_PREFIX="lptest"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
LABEL_PENDING_PR="pending/PR"
LABEL_AGENT_DOING="doing/agent"
CONF
tick() {
    ( export CODING_AGENT_CONFIG="$SB/coding-agent.config"
      exec 8>&2
      # shellcheck source=../scripts/_lib.sh
      source "$REPO_DIR/scripts/_lib.sh"
      exec 2>&8 8>&-
      price_fetch_tick ) 2>/dev/null
}
rm -rf "$CACHE"; mkdir -p "$CACHE"; echo $(( $(date +%s) + 3600 )) > "$NEXT"; : > "$PLOG"
PROBE_LOG="$PLOG" tick
chk "没标记、没到时间 → 不启动抓价脚本" "$(grep -c . "$PLOG") $([ -e "$LATEST" ] && echo ran || echo idle)" "0 idle"
echo 0 > "$NEXT"; rm -f "$SB/state/poll.log"
tick
chk "到时间 → 启动，抓到的结果带前缀进 poll.log" \
    "$([ -s "$LATEST" ] && echo fetched) $(grep -c '\[lptest\].*抓价：已更新 Claude 最新价目' "$SB/state/poll.log")" "fetched 1"
rm -f "$NEXT" "$LATEST"; tick
chk "下次时刻文件不在 → 当作到时间" "$([ -s "$LATEST" ] && echo fetched || echo idle)" "fetched"
rm -f "$LATEST"; echo 0 > "$NEXT"; PRICE_AUTO_FETCH=off tick
chk "PRICE_AUTO_FETCH=off → 不启动" "$([ -e "$LATEST" ] && echo ran || echo idle)" "idle"

echo "── 6. 「下次时刻」文件：daemon 钩子与抓价脚本对同一个文件给同一个答案 ──"
# 两处各自判断「到没到时间」，规则必须一致（PR #612 复审第 1 轮：`12 9999999999` 被钩子删掉空格
# 读成未来时刻、跳过启动，抓价脚本却判到时——没有缺价标记时坏文件永远没人重写）。
# 每个文件分别交给真实钩子（看抓价脚本有没有被启动、写出最新价）和抓价脚本自己的判断。
due_py() { python3 - "$TU" <<'PY2'
import sys, time
sys.path.insert(0, sys.argv[1])
import price_fetch
print("due" if price_fetch.latest_due(time.time()) else "wait")
PY2
}
FUT=$(( $(date +%s) + 86400 ))
CASES=("future|wait|$FUT" "future-nl|wait|$FUT\n" "future-nl2|wait|$FUT\n\n" "zero-padded|wait|000$FUT"
       "past|due|0" "empty|due|" "junk|due|abc" "space-split|due|12 $FUT" "lead-space|due| $FUT"
       "lead-nl|due|\n$FUT" "plus|due|+$FUT" "underscore|due|1_${FUT}" "nul|due|$FUT\0" "cr|due|$FUT\r\n"
       "19-digits|due|9999999999999999999" "over-64-bytes|due|$FUT$(printf '\\n%.0s' $(seq 60))")
for c in "${CASES[@]}"; do
    name=${c%%|*}; rest=${c#*|}; want=${rest%%|*}; content=${rest#*|}
    rm -rf "$CACHE"; mkdir -p "$CACHE"; printf "$content" > "$NEXT"
    py=$(due_py)
    tick
    sh=$([ -s "$LATEST" ] && echo due || echo wait)
    chk "$name：钩子 $sh / 抓价脚本 $py，都是 $want" "$sh $py" "$want $want"
done
rm -rf "$CACHE"; mkdir -p "$CACHE"
chk "文件不在：抓价脚本判到时" "$(due_py)" "due"
tick
chk "文件不在：钩子启动了抓价脚本" "$([ -s "$LATEST" ] && echo due || echo wait)" "due"

echo "── 7. 缓存路径上不是普通文件 / 文件过大：不卡住，当作没有 ──"
# PR #612 复审第 2 轮：路径上是没有写端的命名管道时，普通的 open() 一直等下去。
# 每条命令都套 timeout：卡住就是 124，断言里能看出来，不会把测试拖死
T_OUT=20
fifo_at() { rm -rf "$1"; mkfifo "$1"; }
rm -rf "$CACHE"; mkdir -p "$CACHE"
fifo_at "$NEXT"
rc=0; out=$(TU="$TU" timeout $T_OUT python3 -c '
import os, sys, time
sys.path.insert(0, os.environ["TU"])
import price_fetch
print("due" if price_fetch.latest_due(time.time()) else "wait")' 2>&1) || rc=$?
chk "下次时刻文件是命名管道：抓价脚本判到时，不卡住" "$rc $out" "0 due"
# 钩子是 shell 函数，套不了 timeout：放到后台，超时就杀掉（被杀的退出码不是 0，断言会红）
tick & pid=$!
( sleep $T_OUT; kill $pid 2>/dev/null ) & killer=$!
rc=0; wait $pid || rc=$?; kill $killer 2>/dev/null; wait $killer 2>/dev/null
chk "下次时刻文件是命名管道：钩子启动抓价、抓到最新价、把时刻写回成普通文件" \
    "$rc $([ -s "$LATEST" ] && echo fetched) $([ -f "$NEXT" ] && [ ! -p "$NEXT" ] && echo regular)" "0 fetched regular"
for f in latest-prices.json fetched-prices.json; do
    rm -rf "$CACHE"; mkdir -p "$CACHE"; fifo_at "$CACHE/$f"
    rc=0; T=$(timeout $T_OUT python3 "$SOLVER" --listed) || rc=$?
    chk "$f 是命名管道：取价照常出表（opus-5-5 用内置价）" \
        "$rc $(jq -r '.models["claude-opus-5-5"].input.status' <<<"$T" 2>/dev/null)" "0 reference_only"
    rc=0; KV=$(cd "$WT" && timeout $T_OUT bash "$TU/claude.sh" "$START" --kv) || rc=$?
    chk "$f 是命名管道：驱动照常出机器记录" "$rc $(kvget "$KV" cost_state)" "0 partial"
    rc=0; timeout $T_OUT python3 "$TU/price_fetch.py" >/dev/null || rc=$?
    chk "$f 是命名管道：抓价脚本照常跑完" "$rc" "0"
done
rm -rf "$CACHE"; mkdir -p "$CACHE"; fifo_at "$CACHE/price-fetch.lock"
rc=0; OUT=$(timeout $T_OUT python3 "$TU/price_fetch.py") || rc=$?
chk "抓价锁文件是命名管道：本轮跳过并留日志，不卡住" "$rc $(grep -c '抓价锁文件' <<<"$OUT")" "0 1"
rm -rf "$CACHE"; mkdir -p "$CACHE"
python3 - "$LATEST" <<'PY2'
import json, sys
m = {"input": 5, "output": 25, "cache_read": 0.5, "cache_write_5m": 6.25, "cache_write_1h": 10}
doc = {"claude": {"models": {"claude-opus-5-5": m}}, "pad": "x" * (9 * 1024 * 1024)}
open(sys.argv[1], "w").write(json.dumps(doc))
PY2
chk "最新价文件超过 8 MB：当作没有，opus-5-5 用内置价" \
    "$(jq -r '.models["claude-opus-5-5"].input.status' <<<"$(listed)")" "reference_only"
# 文档写的行为：关掉下载只停下载，两类已经下载下来的价照用
rm -rf "$CACHE"; mkdir -p "$CACHE"; put_latest "$L55"; put_gap; echo 0 > "$NEXT"
OUT=$(PRICE_AUTO_FETCH=off python3 "$TU/price_fetch.py"; echo "rc=$?")
T=$(listed)
chk "PRICE_AUTO_FETCH=off：不下载（时刻文件没被改写），每日价和补缺价都照用" \
    "$(cat "$NEXT") $(jq -c '[.models["claude-opus-5-5"].input.status, .models["claude-gap-9"].input.status]' <<<"$T")" \
    '0 ["fetched","fetched"]'

echo "── 8. 补抓价缓存结构坏掉：四个使用方都只丢坏的那层 ──"
# PR #612 复审第 3 轮：{"claude":[1]} 让取价进程退出、内置价也出不来；单价 1001 的记录被取价丢掉，
# daemon 却当成已有价删了缺价标记。规则只有一份（price_solve.load_fetched），这里把同一组坏缓存
# 分别交给每个使用方。
GOOD_C='"claude-gap-9":{"prices":{"input":1,"output":2}}'
GOOD_X='"gpt-good-9":{"prices":{"in":1,"out":2}}'
BADS=(
  "claude-list|{\"claude\":[1],\"codex\":{$GOOD_X}}"
  "codex-list|{\"claude\":{$GOOD_C},\"codex\":[1]}"
  "entry-list|{\"claude\":{$GOOD_C,\"claude-bad-9\":[1]},\"codex\":{$GOOD_X,\"gpt-bad-9\":[1]}}"
  "prices-list|{\"claude\":{$GOOD_C,\"claude-bad-9\":{\"prices\":[1]}},\"codex\":{$GOOD_X,\"gpt-bad-9\":{\"prices\":[1]}}}"
  "price-string|{\"claude\":{$GOOD_C,\"claude-bad-9\":{\"prices\":{\"input\":\"1\",\"output\":2}}},\"codex\":{$GOOD_X,\"gpt-bad-9\":{\"prices\":{\"in\":\"1\",\"out\":2}}}}"
  "price-1001|{\"claude\":{$GOOD_C,\"claude-bad-9\":{\"prices\":{\"input\":1001,\"output\":1001}}},\"codex\":{$GOOD_X,\"gpt-bad-9\":{\"prices\":{\"in\":1001,\"out\":1001}}}}"
  "price-huge|{\"claude\":{$GOOD_C,\"claude-bad-9\":{\"prices\":{\"input\":$BIG,\"output\":1}}},\"codex\":{$GOOD_X,\"gpt-bad-9\":{\"prices\":{\"in\":$BIG,\"out\":1}}}}"
  "no-output|{\"claude\":{$GOOD_C,\"claude-bad-9\":{\"prices\":{\"input\":1}}},\"codex\":{$GOOD_X,\"gpt-bad-9\":{\"prices\":{\"in\":1}}}}"
  "bad-name|{\"claude\":{$GOOD_C,\"../x y\":{\"prices\":{\"input\":1,\"output\":2}}},\"codex\":{$GOOD_X}}"
  "top-list|[1]"
  "top-null|null"
)
weekly_side() { python3 - "$REPO_DIR/scripts/weekly-report" <<'PY2'
import json, sys
sys.path.insert(0, sys.argv[1])
import price_solve as ps
r, t = ps.fetched_reference(), ps.codex_price_table()["models"]
print(json.dumps(["claude-gap-9" in r, "claude-bad-9" in r, "gpt-good-9" in t, "gpt-bad-9" in t]))
PY2
}
codex_side() { bash -c 'source "$1/_price_cache.sh"; fetched_prices_json codex' _ "$TU"; }
for c in "${BADS[@]}"; do
    name=${c%%|*}; doc=${c#*|}
    rm -rf "$CACHE"; mkdir -p "$CACHE"; put_latest "$L55"; printf '%s\n' "$doc" > "$CACHE/fetched-prices.json"
    want_c=true; want_x=true
    case "$name" in claude-list|top-list|top-null) want_c=false ;; esac
    case "$name" in codex-list|top-list|top-null) want_x=false ;; esac
    rc=0; T=$(python3 "$SOLVER" --listed) || rc=$?
    chk "$name：Claude 取价照常出表，每日价和内置价都在，坏记录不进表，好的补缺价按预期" \
        "$rc $(jq -c '[.models["claude-opus-5-5"].input.status, .models["claude-haiku-4-5"].input.status, has("models") and (.models | has("claude-bad-9")), (.models | has("claude-gap-9"))]' <<<"$T" 2>/dev/null)" \
        "0 [\"fetched\",\"reference_only\",false,$want_c]"
    rc=0; X=$(codex_side) || rc=$?
    chk "$name：Codex 取价读到的补缺价只含好记录" \
        "$rc $(jq -c '[has("gpt-bad-9"), has("gpt-good-9")]' <<<"$X" 2>/dev/null)" "0 [false,$want_x]"
    rc=0; W=$(weekly_side) || rc=$?
    chk "$name：周报补算两侧都不出错，只留好记录" "$rc $W" "0 [$want_c, false, $want_x, false]"
done
# daemon 补抓：坏记录不算已有价，标记留着；抓到两源一致的价才写进去、删标记；好记录保留
for c in "price-1001|{\"claude\":{$GOOD_C,\"claude-test-9\":{\"prices\":{\"input\":1001,\"output\":1001}}}}" \
         "entry-list|{\"claude\":{$GOOD_C,\"claude-test-9\":[1]}}" \
         "claude-list|{\"claude\":[1]}"; do
    name=${c%%|*}; doc=${c#*|}
    rm -rf "$CACHE"; mkdir -p "$CACHE/unpriced"; echo 9999999999 > "$NEXT"
    printf '%s\n' "$doc" > "$CACHE/fetched-prices.json"; : > "$CACHE/unpriced/claude--claude-test-9"
    OUT=$(PRICE_FETCH_ANTHROPIC_URL="file://$TMP/nope.md" python3 "$TU/price_fetch.py")
    chk "$name：抓价失败时坏记录不算有价，缺价标记留着" \
        "$([ -e "$CACHE/unpriced/claude--claude-test-9" ] && echo kept || echo removed) $(grep -c 'claude-test-9 抓价失败' <<<"$OUT")" "kept 1"
    rm -f "$CACHE/price-fetch-state.json"
    OUT=$(python3 "$TU/price_fetch.py")
    chk "$name：抓到两源一致的价后写进去、删标记，原有好记录保留" \
        "$([ -e "$CACHE/unpriced/claude--claude-test-9" ] && echo kept || echo removed) $(jq -c '[.claude["claude-test-9"].prices.input, (.claude | has("claude-gap-9"))]' "$CACHE/fetched-prices.json")" \
        "removed [3.0,$([ "$name" = claude-list ] && echo false || echo true)]"
    chk "$name：补上后取价用上这个价" "$(jq -r '.models["claude-test-9"].input.price' <<<"$(listed)")" "3.0"
done
# 抓价状态文件的一项结构坏了：当作没试过，照常去抓
for st in '{"claude/claude-test-9":[1]}' '{"claude/claude-test-9":{"last_attempt":"x"}}' \
          '{"claude/claude-test-9":{"last_attempt":true}}' '[1]'; do
    rm -rf "$CACHE"; mkdir -p "$CACHE/unpriced"; echo 9999999999 > "$NEXT"
    printf '%s\n' "$st" > "$CACHE/price-fetch-state.json"; : > "$CACHE/unpriced/claude--claude-test-9"
    rc=0; python3 "$TU/price_fetch.py" >/dev/null || rc=$?
    chk "抓价状态是 ${st:0:40}：照常抓到价" \
        "$rc $(jq -r '.claude["claude-test-9"].prices.input' "$CACHE/fetched-prices.json" 2>/dev/null)" "0 3.0"
done

echo "── 9. 读回的数：超大整数 / 无穷 / NaN 只影响那一项，抓价整轮照常 ──"
# PR #612 复审第 4 轮：抓价状态里 last_attempt 是 10**400 时，转浮点抛异常，整轮抓价提前结束，
# 别的缺价标记也补不上。现在每个读回的数都过 price_solve.number_in，且一个模型出了意外只影响它自己
two_markers() { rm -rf "$CACHE"; mkdir -p "$CACHE/unpriced"; echo 9999999999 > "$NEXT"
                : > "$CACHE/unpriced/claude--claude-test-9"; : > "$CACHE/unpriced/codex--gpt-test-9"; }
for t in "$BIG" "-$BIG" 1e400 -1 NaN Infinity '"12"' true null '[1]'; do
    two_markers
    printf '{"claude/claude-test-9":{"last_attempt":%s},"codex/gpt-test-9":{"last_attempt":%s}}\n' "$t" "$t" > "$CACHE/price-fetch-state.json"
    rc=0; OUT=$(python3 "$TU/price_fetch.py") || rc=$?
    chk "重试时刻是 ${t:0:12}…：当作没试过，两个模型都补上价，没有异常" \
        "$rc $(jq -c '[.claude["claude-test-9"].prices.input, .codex["gpt-test-9"].prices.in]' "$CACHE/fetched-prices.json" 2>/dev/null) $(grep -c '异常' <<<"$OUT")" \
        "0 [3.0,2.0] 0"
    chk "重试时刻是 ${t:0:12}…：写回的状态是合法的时刻" \
        "$(jq -c '[.["claude/claude-test-9"].last_attempt, .["codex/gpt-test-9"].last_attempt] | map(type)' "$CACHE/price-fetch-state.json")" '["number","number"]'
done
# 正常冷却照样有效：一个刚试过、一个坏时刻——前者不抓，后者照抓
two_markers
printf '{"claude/claude-test-9":{"last_attempt":%s},"codex/gpt-test-9":{"last_attempt":%s}}\n' "$(( $(date +%s) - 10 ))" "$BIG" > "$CACHE/price-fetch-state.json"
OUT=$(python3 "$TU/price_fetch.py")
chk "刚试过的模型仍在冷却：不抓、标记留着；坏时刻的另一个照常补上" \
    "$([ -e "$CACHE/unpriced/claude--claude-test-9" ] && echo kept) $(jq -c '[.claude["claude-test-9"], .codex["gpt-test-9"].prices.in]' "$CACHE/fetched-prices.json" 2>/dev/null)" \
    "kept [null,2.0]"
# 网络上 LiteLLM 的单价是超大整数：那个模型两源对不上、不收，别的照常
python3 - "$FX/litellm.json" "$TMP/litellm-big.json" <<'PY2'
import sys
raw = open(sys.argv[1]).read()
raw = raw.replace('"claude-test-9": {"input_cost_per_token": 3e-06', '"claude-test-9": {"input_cost_per_token": ' + str(10**400), 1)
open(sys.argv[2], "w").write(raw)
PY2
two_markers
rc=0; OUT=$(PRICE_FETCH_LITELLM_URL="file://$TMP/litellm-big.json" python3 "$TU/price_fetch.py") || rc=$?
chk "LiteLLM 里 claude-test-9 的单价是超大整数：它不收、标记留着，codex 那个照常补上，没有异常" \
    "$rc $([ -e "$CACHE/unpriced/claude--claude-test-9" ] && echo kept) $(jq -c '[.claude["claude-test-9"], .codex["gpt-test-9"].prices.in]' "$CACHE/fetched-prices.json" 2>/dev/null) $(grep -c '异常' <<<"$OUT")" \
    "0 kept [null,2.0] 0"
# 每日刷新遇到同样的超大整数：那个模型不收，别的照收
rm -rf "$CACHE"; mkdir -p "$CACHE"
rc=0; OUT=$(PRICE_FETCH_LITELLM_URL="file://$TMP/litellm-big.json" python3 "$TU/price_fetch.py") || rc=$?
chk "每日刷新遇到超大整数：claude-test-9 不收，claude-zero-9 照收，没有异常" \
    "$rc $(jq -c '.claude.models | keys' "$LATEST" 2>/dev/null) $(grep -c '异常' <<<"$OUT")" '0 ["claude-zero-9"] 0'

echo "── 10. 价格缓存写不进去：不提交，恢复后下一轮补上 ──"
# PR #612 复审第 5 轮：fetched-prices.json 写入失败后，这个模型在内存里的价和 ok 状态被同轮另一个
# 模型的状态保存带了出去——下一轮以为补过了、冷却 6 小时，标记却还在、价也没有
rm -rf "$CACHE"; mkdir -p "$CACHE/unpriced" "$CACHE/fetched-prices.json"; echo 9999999999 > "$NEXT"
: > "$CACHE/unpriced/claude--claude-test-9"; : > "$CACHE/unpriced/claude--claude-clash-9"
rc=0; OUT=$(python3 "$TU/price_fetch.py") || rc=$?
chk "写不进去的那个：不记尝试、标记留着、日志说明；同轮另一个照常记下失败并保存状态" \
    "$rc $(jq -c '[has("claude/claude-test-9"), .["claude/claude-clash-9"].result != null]' "$CACHE/price-fetch-state.json") $([ -e "$CACHE/unpriced/claude--claude-test-9" ] && echo kept) $(grep -c 'claude-test-9 抓到了价但写不进缓存' <<<"$OUT")" \
    "0 [false,true] kept 1"
rmdir "$CACHE/fetched-prices.json"
OUT=$(python3 "$TU/price_fetch.py")
chk "写入恢复后下一轮：claude-test-9 补上、标记删掉、状态记 ok；clash 仍在冷却" \
    "$(jq -r '.claude["claude-test-9"].prices.input' "$CACHE/fetched-prices.json") $([ -e "$CACHE/unpriced/claude--claude-test-9" ] && echo kept || echo removed) $(jq -r '.["claude/claude-test-9"].result' "$CACHE/price-fetch-state.json") $(grep -c 'clash' <<<"$OUT")" \
    "3.0 removed ok 0"
chk "补上后取价用上这个价" "$(jq -r '.models["claude-test-9"].input.price' <<<"$(listed)")" "3.0"
# 每日刷新写不进去：最新价文件位置被目录占着
rm -rf "$CACHE"; mkdir -p "$CACHE/latest-prices.json"; echo 0 > "$NEXT"
NOW=$(date +%s); rc=0; OUT=$(python3 "$TU/price_fetch.py") || rc=$?
N=$(cat "$NEXT")
chk "每日刷新写不进去：不算刷新过，10 分钟后再试，日志说明" \
    "$rc $([ $((N - NOW)) -ge 599 ] && [ $((N - NOW)) -le 601 ] && echo 10min || echo "$((N - NOW))") $(grep -c '最新价目已抓到但写不进缓存' <<<"$OUT")" "0 10min 1"
rmdir "$LATEST"; echo 0 > "$NEXT"; python3 "$TU/price_fetch.py" >/dev/null
chk "写入恢复后：最新价写进去" "$(jq -c '.claude.models | keys' "$LATEST")" '["claude-test-9","claude-zero-9"]'
chk "没有遗留临时文件" "$(ls -A "$CACHE" | grep -c '\.tmp$')" "0"

report_counts "$pass" "$fail"
echo
echo "通过 $pass，失败 $fail"
[ "$fail" -eq 0 ]
