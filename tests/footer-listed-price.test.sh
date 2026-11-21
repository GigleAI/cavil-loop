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

report_counts "$pass" "$fail"
echo
echo "通过 $pass，失败 $fail"
[ "$fail" -eq 0 ]
