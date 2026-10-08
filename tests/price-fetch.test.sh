#!/usr/bin/env bash
# 缺价自动抓价（GitHub#51）：驱动留标记 → daemon 抓价 → 驱动用上。
#
# 跑法：bash tests/price-fetch.test.sh
# 依赖：bash / jq / python3 / flock。三个价格来源用 tests/fixtures/price-fetch/ 下的本地
# 假文件（file:// 地址），**不碰网络**；HOME / XDG_CACHE_HOME 指到临时目录，不读本机真实
# 会话、不碰本机真实缓存。驱动和抓价脚本都跑**真实**的那一份。
#
# 为什么要有这个文件：这条链路错了**都不报错**——
#   · 少一道校验 → 一个读错列的价被悄悄写进缓存，之后每条 footer 都带着一个看起来正常、
#     其实错了的金额（比「金额未计」更糟，没人会去怀疑它）
#   · 抓来的价覆盖了内置价 → 人工核对过的单价被静默替换
#   · 不标来源 → 周报把自动抓的价和人工核对的价混成一个数
# 所以每条规则都配一个「去掉它就会红」的用例（两源不一致 / 单源 / 分档歧义 / 结构不合理 /
# 内置已有 / 显式关闭估价）。
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
TU="$REPO_DIR/scripts/drivers/token-usage"
FX="$TEST_DIR/fixtures/price-fetch"

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
export HOME="$TMP"
export XDG_CACHE_HOME="$TMP/.cache"
export PRICE_FETCH_ANTHROPIC_URL="file://$FX/anthropic.md"
export PRICE_FETCH_OPENAI_URL="file://$FX/openai.md"
export PRICE_FETCH_LITELLM_URL="file://$FX/litellm.json"
unset CODEX_PRICES CODEX_PRICE_IN_PER_M CODEX_PRICE_CACHED_IN_PER_M CODEX_PRICE_OUT_PER_M PRICE_AUTO_FETCH
CACHE="$XDG_CACHE_HOME/cavil-loop"
MARK="$CACHE/unpriced"
FETCHED="$CACHE/fetched-prices.json"

pass=0; fail=0
chk() { if [ "$2" = "$3" ]; then echo "  ✅ $1"; pass=$((pass+1)); else echo "  ❌ $1"; echo "       期望 $3"; echo "       实得 $2"; fail=$((fail+1)); fi; }
has() { [ -e "$MARK/$1" ] && echo yes || echo no; }
fetch() { python3 "$TU/price_fetch.py"; }
# 键排序、3.0 规整成 3，只比数值
fprice() { jq -cS --arg a "$1" --arg m "$2" '.[$a][$m].prices // null | if . then map_values(. + 0) else . end' "$FETCHED" 2>/dev/null || echo null; }
reset() { rm -rf "$CACHE"; mkdir -p "$MARK"; }

echo "── 1. 抓价：两源一致才写，逐条规则各有负对照 ──"
reset
for m in claude--claude-test-9 claude--claude-clash-9 claude--claude-lone-9 claude--claude-split-9 \
         claude--claude-bad-9 claude--claude-partial-9 claude--claude-opus-5 \
         codex--gpt-test-9 codex--gpt-test-nocw codex--gpt-6-sol 'evil--x' 'codex--a b'; do
    : > "$MARK/$m"
done
OUT=$(fetch)
chk "claude-test-9：五项全取官方页的值"    "$(fprice claude claude-test-9)" \
    '{"cache_read":0.15,"cache_write_1h":6,"cache_write_5m":3.75,"input":3,"output":15}'
chk "gpt-test-9：只读标准档（Batch 表的半价不能混进来）" "$(fprice codex gpt-test-9)" \
    '{"cache_write":2.5,"cached_in":0.2,"in":2,"out":10}'
chk "gpt-test-nocw：官方页写「-」的缓存写入不采用，其余照取（名字里的括号说明去掉）" \
    "$(fprice codex gpt-test-nocw)" '{"cached_in":0.1,"in":1,"out":8}'
chk "claude-partial-9：只有一边有的 1h 写入不采用"  "$(fprice claude claude-partial-9)" \
    '{"cache_read":0.2,"cache_write_5m":2.5,"input":2,"output":10}'
chk "两源对不上（官方 \$3 / LiteLLM \$6）→ 不写" "$(fprice claude claude-clash-9)" "null"
chk "只有官方页收录 → 不写"                  "$(fprice claude claude-lone-9)" "null"
chk "官方页按上下文分两档 → 有歧义，不写"    "$(fprice claude claude-split-9)" "null"
chk "output < input（两边一致也不行）→ 不写" "$(fprice claude claude-bad-9)" "null"
chk "内置参照已有的 claude-opus-5 → 不抓"    "$(fprice claude claude-opus-5)" "null"
chk "内置表已有的 gpt-6-sol → 不抓"          "$(fprice codex gpt-6-sol)" "null"
chk "成功的、内置已有的、名字不合规的标记都删掉" \
    "$(ls "$MARK" | sort | tr '\n' ' ')" \
    "claude--claude-bad-9 claude--claude-clash-9 claude--claude-lone-9 claude--claude-split-9 "
chk "失败原因写进日志：两源对不上"   "$(grep -c 'claude-clash-9 抓价失败.*两边对不上' <<< "$OUT")" "1"
chk "失败原因写进日志：LiteLLM 没收录" "$(grep -c 'claude-lone-9 抓价失败.*LiteLLM：没有收录' <<< "$OUT")" "1"
chk "失败原因写进日志：分档歧义"     "$(grep -c 'claude-split-9 抓价失败.*有歧义' <<< "$OUT")" "1"
chk "失败原因写进日志：数据不合理"   "$(grep -c 'claude-bad-9 抓价失败.*output' <<< "$OUT")" "1"
chk "成功写进日志"                   "$(grep -c '已自动补上单价' <<< "$OUT")" "4"

echo "── 2. 冷却：失败的模型 6 小时内不再请求 ──"
chk "立刻再跑：一条都不抓"  "$(fetch | wc -l)" "0"
chk "冷却设成 0：失败的四个重新抓一遍" "$(PRICE_FETCH_COOLDOWN_SECS=0 fetch | grep -c '抓价失败')" "4"

echo "── 3. 下载失败 / 页面改版 / 关闭开关 / 并发 ──"
reset; : > "$MARK/codex--gpt-test-9"
OUT=$(PRICE_FETCH_OPENAI_URL="file://$TMP/nope.md" fetch)
chk "官方页下载失败 → 不写缓存、记原因" \
    "$([ -f "$FETCHED" ] && echo written || echo none) $(grep -c '官方页下载失败' <<< "$OUT")" "none 1"
reset; : > "$MARK/codex--gpt-test-9"
printf '# Pricing\n\nnothing here\n' > "$TMP/changed.md"
OUT=$(PRICE_FETCH_OPENAI_URL="file://$TMP/changed.md" fetch)
chk "页面改版找不到表 → 不写、说明原因" \
    "$([ -f "$FETCHED" ] && echo written || echo none) $(grep -c '解析不出价目表' <<< "$OUT")" "none 1"
reset; : > "$MARK/codex--gpt-test-9"
PRICE_AUTO_FETCH=0 fetch
chk "PRICE_AUTO_FETCH=0 → 什么都不做（标记留着）" \
    "$([ -f "$FETCHED" ] && echo written || echo none) $(has codex--gpt-test-9)" "none yes"
( flock 7; sleep 3 ) 7>"$CACHE/price-fetch.lock" &
sleep 0.5
fetch
chk "另一个 daemon 正在抓 → 这一轮跳过"  "$([ -f "$FETCHED" ] && echo written || echo none)" "none"
wait

echo "── 4. codex 驱动：留标记 → 抓价 → 用上并注明 ──"
reset
START=$(( $(date +%s) - 3600 ))
ts() { date -u -d "@$(( START + $1 ))" '+%Y-%m-%dT%H:%M:%S.000Z'; }
WT="$TMP/wt/issue-1"; mkdir -p "$WT" "$TMP/.codex/sessions/2026/10/08"
rec() { printf '{"type":"token_usage_record","timestamp":"%s","payload":{"usage":{"input_tokens":%s,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":%s,"reasoning_output_tokens":0,"total_tokens":%s}}}\n' "$(ts "$1")" "$2" "$3" "$(( $2 + $3 ))"; }
{
    printf '{"type":"session_meta","timestamp":"%s","payload":{"cwd":"%s"}}\n' "$(ts 1)" "$WT"
    printf '{"type":"turn_context","timestamp":"%s","payload":{"model":"gpt-test-9"}}\n' "$(ts 2)"
    rec 10 1000000 100000
    printf '{"type":"turn_context","timestamp":"%s","payload":{"model":"gpt-6-sol"}}\n' "$(ts 20)"
    rec 30 1000000 0
} > "$TMP/.codex/sessions/2026/10/08/rollout-x.jsonl"
cx() { ( cd "$WT" && bash "$TU/codex.sh" "$START" "$@" ); }
KV=$(cx --kv)
chk "抓价前：gpt-test-9 没价 → 金额偏低、缺价 110 万" \
    "$(grep -o 'cost_state=[a-z]* cost_unknown_tokens=[0-9]*' <<< "$KV")" "cost_state=partial cost_unknown_tokens=1100000"
chk "抓价前：没用上抓来的价 → 不出 price_status（与改动前逐字节一致）" \
    "$(grep -c 'price_status' <<< "$KV")" "0"
chk "抓价前：只给缺价的模型留标记（gpt-6-sol 内置有价，不留）" "$(ls "$MARK" | tr '\n' ' ')" "codex--gpt-test-9 "
fetch >/dev/null
KV=$(cx --kv); HM=$(cx)
chk "抓价后：全有价，金额 = 内置 \$2 + 抓来的 \$2 + \$1" \
    "$(grep -o 'cost_usd=[0-9.]* cost_state=[a-z]* cost_unknown_tokens=[0-9]*' <<< "$KV")" \
    "cost_usd=5 cost_state=full cost_unknown_tokens=0"
chk "抓价后：金额按来源拆桶，桶合计 = cost_usd" \
    "$(grep -o 'price_status=[^ ]*' <<< "$KV")" "price_status=unrated:2,fetched:3"
chk "抓价后：人读行注明用了自动联网获取的单价" \
    "$HM" "2m input, 100k output, 0 cache read, 0 cache write (\$5.00)（含自动联网获取的单价）（模型：gpt-6-sol、gpt-test-9）"
chk "抓价后：不再留标记" "$(ls "$MARK" | wc -l)" "0"

echo "── 5. codex：抓来的价不覆盖内置；显式配表时不补也不留标记 ──"
tmpf=$(mktemp); jq '.codex["gpt-6-sol"] = {"prices": {"in": 999, "out": 999}}' "$FETCHED" > "$tmpf" && mv "$tmpf" "$FETCHED"
chk "缓存里塞一个 \$999 的 gpt-6-sol → 照旧按内置 \$2 算" \
    "$(cx --kv | grep -o 'cost_usd=[0-9.]*')" "cost_usd=5"
reset
KV=$( cd "$WT" && CODEX_PRICES='{}' bash "$TU/codex.sh" "$START" --kv )
chk "CODEX_PRICES='{}'（关闭估价）→ 不留标记" "$(ls "$MARK" | wc -l)" "0"
fetch >/dev/null 2>&1; : > "$MARK/codex--gpt-test-9"; fetch >/dev/null
KV=$( cd "$WT" && CODEX_PRICES='{"gpt-6-sol":{"in":2,"cached_in":0.2,"out":10}}' bash "$TU/codex.sh" "$START" --kv )
chk "显式配表 → 缓存里有 gpt-test-9 也不用（部署者说了只用自己的表）" \
    "$(grep -o 'cost_state=[a-z]*' <<< "$KV") $(grep -c 'fetched' <<< "$KV")" "cost_state=partial 0"

echo "── 6. claude 驱动：留标记 → 抓价 → 用上，可信度记 fetched ──"
reset
CW="$TMP/wt/issue-2"; mkdir -p "$CW"
ENC=$(cd "$CW" && pwd | tr / -); mkdir -p "$TMP/.claude/projects/$ENC"
cts() { date -u -d "@$(( START + $1 ))" '+%Y-%m-%dT%H:%M:%S.000Z'; }
{
    printf '{"type":"assistant","timestamp":"%s","requestId":"r1","message":{"model":"claude-test-9","usage":{"input_tokens":1000000,"output_tokens":100000}}}\n' "$(cts 10)"
    printf '{"type":"assistant","timestamp":"%s","requestId":"r2","message":{"model":"<synthetic>","usage":{"input_tokens":5,"output_tokens":5}}}\n' "$(cts 20)"
    printf '{"type":"assistant","timestamp":"%s","requestId":"r3","message":{"usage":{"input_tokens":7,"output_tokens":0}}}\n' "$(cts 30)"
} > "$TMP/.claude/projects/$ENC/s.jsonl"
cl() { ( cd "$CW" && bash "$TU/claude.sh" "$START" "$@" ); }
KV=$(cl --kv)
chk "抓价前：claude-test-9 没价、模型认不出的 7 个 token 也没价（<synthetic> 不计）" \
    "$(grep -o 'cost_state=[a-z]* cost_unknown_tokens=[0-9]*' <<< "$KV")" "cost_state=none cost_unknown_tokens=1100007"
chk "抓价前：只给认得出的模型留标记（<synthetic> / 认不出的不留）" "$(ls "$MARK" | tr '\n' ' ')" "claude--claude-test-9 "
fetch >/dev/null
KV=$(cl --kv); HM=$(cl)
chk "抓价后：claude-test-9 按 \$3/\$15 算出 \$4.5，认不出模型的仍算缺价" \
    "$(grep -o 'cost_usd=[0-9.]* cost_state=[a-z]* cost_unknown_tokens=[0-9]*' <<< "$KV")" \
    "cost_usd=4.5 cost_state=partial cost_unknown_tokens=7"
chk "抓价后：可信度桶是 fetched（不是 unstable，不和内置参照兜底混在一起）" \
    "$(grep -o 'price_status=[^ ]*' <<< "$KV")" "price_status=fetched:4.5"
chk "抓价后：人读行注明" \
    "$(grep -c '（含自动联网获取的单价）' <<< "$HM")" "1"
chk "认不出模型那部分不会再留标记" "$(ls "$MARK" | wc -l)" "0"

echo "── 7. claude：抓来的价不覆盖内置参照 ──"
tmpf=$(mktemp); jq '.claude["claude-opus-5"] = {"prices": {"input": 999, "output": 999}}' "$FETCHED" > "$tmpf" && mv "$tmpf" "$FETCHED"
chk "缓存里塞一个 \$999 的 claude-opus-5 → 价目表里仍是内置的 \$5" \
    "$(python3 "$REPO_DIR/scripts/weekly-report/price_solve.py" --table | jq -c '.models["claude-opus-5"].input | [.price, .status]')" \
    '[5,"unstable"]'
chk "price_solve 价目表里 claude-test-9 的状态是 fetched" \
    "$(python3 "$REPO_DIR/scripts/weekly-report/price_solve.py" --table | jq -r '.models["claude-test-9"].input.status')" "fetched"

# 上面两条走的是「本机没有该模型流量」那条路。本机有流量、反解不稳时走 classify()，
# 那条路也必须把兜底状态记成 fetched、且内置参照永远优先——直接调真实函数钉住。
PYOUT=$(python3 - "$REPO_DIR/scripts/weekly-report" <<'PY'
import sys
sys.path.insert(0, sys.argv[1])
import price_solve as ps
g = {it: {"price": None, "stable": False, "reason": "x", "amplify": None, "spread": None,
          "share": None, "n": 0} for it in ps.ITEMS}
fx = {"claude-test-9": {"input": 3, "output": 15}, "claude-opus-5": {"input": 999, "output": 999}}
a = ps.classify("claude-test-9", g, {}, "A", fx)["input"]
b = ps.classify("claude-opus-5", g, {}, "A", fx)["input"]
c = ps.classify("claude-test-9", g, {}, "B", fx)["input"]
print(a["status"], a["price"], b["status"], b["price"], c["price"],
      "claude-opus-5" in ps.fetched_reference(), "claude-test-9" in ps.fetched_reference())
PY
)
chk "classify：不稳 + 抓来的参照 → fetched，取抓来的价" "$(cut -d' ' -f1-2 <<< "$PYOUT")" "fetched 3"
chk "classify：内置参照里有的模型，抓来的 \$999 不顶替内置 \$5" "$(cut -d' ' -f3-4 <<< "$PYOUT")" "unstable 5"
chk "classify：policy=B 时抓来的价同样不兜底" "$(cut -d' ' -f5 <<< "$PYOUT")" "None"
chk "fetched_reference：排除内置已有的模型、保留新模型" "$(cut -d' ' -f6-7 <<< "$PYOUT")" "False True"

echo "── 8. daemon 钩子（_lib.sh 的 price_fetch_tick）──"
SB="$TMP/sb"; mkdir -p "$SB/state" "$SB/project" "$SB/wt"
cat > "$SB/coding-agent.config" <<CONF
REPO="acme/widget"
PROJECT_ROOT="$SB/project"
WORKTREE_BASE="$SB/wt"
STATE_DIR="$SB/state"
TMUX_PREFIX="pftest"
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
reset; rm -f "$SB/state/poll.log"
tick
chk "没有标记 → 不跑抓价（不建状态文件）" "$([ -f "$CACHE/price-fetch-state.json" ] && echo ran || echo idle)" "idle"
: > "$MARK/codex--gpt-test-9"
PRICE_AUTO_FETCH=0 tick
chk "PRICE_AUTO_FETCH=0 → 有标记也不跑" "$([ -f "$CACHE/price-fetch-state.json" ] && echo ran || echo idle)" "idle"
tick
chk "有标记 → 抓价，结果带前缀进 poll.log" \
    "$(fprice codex gpt-test-9 | jq -r .in) $(grep -c '\[pftest\].*抓价：codex 模型 gpt-test-9 已自动补上单价' "$SB/state/poll.log")" "2 1"

# 配置文件里的赋值不带 export：子进程看不到就会静默用默认地址（这里默认地址会真的去联网，
# 所以先在环境里删掉测试导出的地址，只留配置里那一份）
reset; : > "$MARK/codex--gpt-test-9"
cp "$SB/coding-agent.config" "$SB/conf.bak"
printf 'PRICE_FETCH_OPENAI_URL="file://%s/openai.md"\nPRICE_FETCH_LITELLM_URL="file://%s/litellm.json"\nPRICE_FETCH_COOLDOWN_SECS=abc\n' "$FX" "$FX" >> "$SB/coding-agent.config"
( unset PRICE_FETCH_OPENAI_URL PRICE_FETCH_LITELLM_URL; tick )
cp "$SB/conf.bak" "$SB/coding-agent.config"
chk "配置文件里没 export 的地址照样传给抓价脚本（坏掉的冷却值不让它崩）" "$(fprice codex gpt-test-9 | jq -r .in)" "2"

echo "── 9. 周报：fetched 一桶单独显示 ──"
python3 - "$TMP/d.json" <<'PY'
import json, sys
tw, prev = "2026-10-05", "2026-09-28"
# report.py 按键直接取的那些字段（同 weekly-report-money-render.test.sh 的 ZERO）
ZERO = {k: 0 for k in (
  "iss_open","iss_closed","pr_open","pr_merged","comments","human","bot","wall","work","cost",
  "out","commits","add","del","records","dupes","footers","cost_footers","long_windows",
  "misattributed","work_records","work_missing","codex","sess_med","backlog","wall_claude",
  "wall_codex","cost_claude","cost_codex","work_claude","work_codex","records_claude",
  "records_codex","cost_records","cost_records_claude","cost_records_codex","src_recomputed",
  "src_original","state_full","state_partial","state_none","log_no_shortfall_detected",
  "log_shortfall_detected","log_unknown","log_true_zero","cost_not_summable",
  "records_not_summable","price_usd_corroborated","price_usd_uncorroborated","price_usd_disputed",
  "price_usd_unstable","price_usd_reference_only","price_usd_unrated","price_src_solved",
  "price_src_configured")}
cur = dict(ZERO); cur.update({"cost": 3.0, "records": 1, "cost_records": 1, "state_full": 1,
       "price_usd_fetched": 3.0, "price_src_default": 1, "records_codex": 1, "cost_records_codex": 1})
json.dump({"repo": "acme/widget", "generated_at": "2026-10-08T00:00:00",
           "price_reference": {"source": "ref-x", "policy": "A"},
           "switch_week": None, "long_windows": [], "misattributed": [],
           "target_week": {"start": tw, "end": "2026-10-12"},
           "weeks": [prev, tw], "weekly": {prev: dict(ZERO), tw: cur}, "detail": [], "loose_prs": []},
          open(sys.argv[1], "w"))
PY
python3 "$REPO_DIR/scripts/weekly-report/report.py" --data "$TMP/d.json" --out "$TMP/r.md" \
    --asset-url-base x --rev y >/dev/null 2>"$TMP/err.log" || cat "$TMP/err.log"
TL=$(grep -o '单价可信度.*' "$TMP/r.md" | head -1)
chk "可信度一栏点名「自动联网获取的单价」并给出金额" \
    "$(grep -qF '**自动联网获取的单价** $3' <<< "$TL" && echo yes || echo no)" "yes"
chk "并说明它不等于与账单核对过" \
    "$(grep -qF '不等于**与账单核对过' <<< "$TL" && echo yes || echo no)" "yes"
# 与抓来的参照冲突的那一桶：报红（⚠️）和「自动联网获取」两个信息都要在
jq '.weekly["2026-10-05"] |= (.price_usd_fetched = 0 | .price_usd_disputed_fetched = 3)' "$TMP/d.json" > "$TMP/d2.json" \
    && mv "$TMP/d2.json" "$TMP/d.json"
python3 "$REPO_DIR/scripts/weekly-report/report.py" --data "$TMP/d.json" --out "$TMP/r.md" \
    --asset-url-base x --rev y >/dev/null 2>"$TMP/err.log" || cat "$TMP/err.log"
TL=$(grep -o '单价可信度.*' "$TMP/r.md" | head -1)
chk "与抓来的参照冲突：报红且点名来源，金额可见" \
    "$(grep -qF '**⚠️ 与自动联网获取的参照冲突（存疑）** $3' <<< "$TL" && echo yes || echo no)" "yes"
chk "只有冲突那一桶时，同样说明它不等于与账单核对过" \
    "$(grep -qF '不等于**与账单核对过' <<< "$TL" && echo yes || echo no)" "yes"

echo "── 10. 本机有记账样本时（走 classify）：零价不丢、冲突时不丢来源（PR #55 复审第 1 轮）──"
# 前面 6 / 7 两组的模型在本机没有 cost-state，走的是「本机无流量」那条路；本机一旦出现
# 该模型的记账样本，就改走 classify()。两条路必须给出同一个价、同一个来源。
# 每个子用例换一个干净的 HOME，样本互不干扰。驱动和周报重算各跑一遍对拍。
fresh() { export HOME="$TMP/h$1" XDG_CACHE_HOME="$TMP/h$1/.cache"
          CACHE="$XDG_CACHE_HOME/cavil-loop"; MARK="$CACHE/unpriced"; FETCHED="$CACHE/fetched-prices.json"
          mkdir -p "$MARK"; CW="$TMP/h$1/wt/issue-9"; mkdir -p "$CW"
          ENC=$(cd "$CW" && pwd | tr / -); PJ="$HOME/.claude/projects"; mkdir -p "$PJ/$ENC"; }
call() {  # $1 模型 $2 usage JSON → 本 worktree 的一次调用
    printf '{"type":"assistant","timestamp":"%s","requestId":"q%s","message":{"model":"%s","usage":%s}}\n' \
        "$(cts 10)" "$RANDOM" "$1" "$2" >> "$PJ/$ENC/s.jsonl"; }
cl() { ( cd "$CW" && bash "$TU/claude.sh" "$START" "$@" ); }
# 周报重算那一侧：真实 price_solve 表 + 真实 attribute.price_calls，算同一批调用
wk() { python3 - "$REPO_DIR/scripts/weekly-report" "$@" <<'PY'
import sys, json
sys.path.insert(0, sys.argv[1])
import price_solve, attribute
model, priced = sys.argv[2], json.loads(sys.argv[3])
usd, unk, state, b = attribute.price_calls([{"model": model, "speed": "standard", "priced": priced}],
                                           price_solve.build_cached("A"))
print(f"usd={usd:g} unk={unk} state={state} buckets={json.dumps(b, sort_keys=True)}")
PY
}

# 10a 零价：两源一致给缓存读 $0
fresh za; : > "$MARK/claude--claude-zero-9"; fetch >/dev/null
call claude-zero-9 '{"input_tokens":0,"output_tokens":100000,"cache_read_input_tokens":1000000}'
chk "10a 无记账样本：\$0 的缓存读算「有价」，全部计价" \
    "$(cl --kv | grep -o 'cost_usd=[0-9.]* cost_state=[a-z]* cost_unknown_tokens=[0-9]*')" \
    "cost_usd=1.5 cost_state=full cost_unknown_tokens=0"
# 追加一条该模型的记账样本（不够反解）→ 改走 classify。旧实现在这里把 0 当「没有参照」，
# 100 万缓存读 token 变成缺价
mkdir -p "$PJ/sess-1"
printf '{"type":"cost-state","totalCostUSD":1.5,"modelUsage":{"claude-zero-9":{"inputTokens":0,"outputTokens":100000,"cacheReadInputTokens":1000000,"cacheCreationInputTokens":0}}}\n' > "$PJ/sess-1/s.jsonl"
chk "10a 有一条记账样本后：仍是全部计价（\$0 不被当成没价）" \
    "$(cl --kv | grep -o 'cost_usd=[0-9.]* cost_state=[a-z]* cost_unknown_tokens=[0-9]*')" \
    "cost_usd=1.5 cost_state=full cost_unknown_tokens=0"
chk "10a 周报重算与驱动一致" \
    "$(wk claude-zero-9 '{"output":100000,"cache_read":1000000}')" \
    'usd=1.5 unk=0 state=full buckets={"fetched": 1.5}'

# 10b 本机解得稳、但与抓来的参照冲突：取抓来的价（策略 A），冲突警示和来源都要留
fresh zb; : > "$MARK/claude--claude-test-9"; fetch >/dev/null
python3 - "$PJ" <<'PY'
import json, os, sys
# 四个分量各 10 条、每条只有该分量 100 万 token，账按抓来价的 2 倍出 → 解得稳、偏 100%
real = {"inputTokens": 6, "outputTokens": 30, "cacheReadInputTokens": 0.30, "cacheCreationInputTokens": 7.5}
k = 0
for comp, price in real.items():
    for j in range(10):
        d = os.path.join(sys.argv[1], f"solve-{k}"); os.makedirs(d, exist_ok=True)
        mu = {c: 0 for c in real}; mu[comp] = 1_000_000 + j * 1000
        with open(os.path.join(d, "s.jsonl"), "w") as f:
            f.write(json.dumps({"type": "cost-state", "totalCostUSD": mu[comp] * price / 1e6,
                                "modelUsage": {"claude-test-9": mu}}) + "\n")
        k += 1
PY
call claude-test-9 '{"input_tokens":1000000,"output_tokens":0}'
KV=$(cl --kv); HM=$(cl)
chk "10b 金额按抓来的 \$3 算（不是本机解出的 \$6）" "$(grep -o 'cost_usd=[0-9.]*' <<< "$KV")" "cost_usd=3"
chk "10b 可信度桶：冲突 + 来自自动抓取，两件事都在" \
    "$(grep -o 'price_status=[^ ]*' <<< "$KV")" "price_status=disputed_fetched:3"
chk "10b 人读行：冲突警示还在" "$(grep -c '与外部参照冲突（存疑）' <<< "$HM")" "1"
chk "10b 人读行：也注明含自动联网获取的单价" "$(grep -c '（含自动联网获取的单价）' <<< "$HM")" "1"
chk "10b 周报重算与驱动一致" "$(wk claude-test-9 '{"input":1000000}')" \
    'usd=3 unk=0 state=full buckets={"disputed_fetched": 3.0}'

echo
echo "通过 $pass / 失败 $fail"
[ "$fail" -eq 0 ]
