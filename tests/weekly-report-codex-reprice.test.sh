#!/usr/bin/env bash
# 交叉 review（codex）那一侧：写评论时缺单价、记账行没写金额的记录，周报出报告时用
# **当时的价目**（内置表 + 缺价自动补来的价）按记录里的 token 补算金额。
#
# 跑法：bash tests/weekly-report-codex-reprice.test.sh
# 依赖：python3。假 `gh` 喂真实评论正文，走 record.extract → collect.main → report.py 真实链路。
#
# 为什么要有这个文件（GigleTutor-Web#1023）：缺价自动补（#55）只让**之后**写出的记账行带上
# 金额；之前已经写进评论、没有金额的 codex 记录，周报一律「沿用原值」= 没有金额，价补上了
# 周报也不变。claude 那一侧能按本机日志重算，codex 这一侧原来一条路都没有。
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
COLLECT="$REPO_DIR/scripts/weekly-report/collect.py"
REPORT="$REPO_DIR/scripts/weekly-report/report.py"

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
export XDG_CACHE_HOME="$TMP/cache"; mkdir -p "$XDG_CACHE_HOME/cavil-loop"
unset CODEX_PRICES CODEX_PRICE_IN_PER_M CODEX_PRICE_CACHED_IN_PER_M CODEX_PRICE_OUT_PER_M
pass=0; fail=0
chk() { if [ "$2" = "$3" ]; then echo "  ✅ $1"; pass=$((pass+1)); else echo "  ❌ $1 (期望 '$3'，实得 '$2')"; fail=$((fail+1)); fi; }

W=2025-01-06; SW=2025-01-06
codex() {   # hh models extra_kv
    printf '审完了。\n\n<!-- agent-metrics agent=codex wt=10 start=%sT%s:00:00+08:00 end=%sT%s:10:00+08:00 wall_secs=600 in=1000000 out=1000000 cache_r=1000000 cache_w=0 models=%s %s-->' \
        "$W" "$1" "$W" "$1" "$2" "$3"
}
# 同上，但四项 token 由调用方给。$1 hh  $2 models  $3 "in out cache_r cache_w"  $4 extra_kv
codex_t() {
    set -- "$1" "$2" $3 "${4:-}"
    printf '审完了。\n\n<!-- agent-metrics agent=codex wt=10 start=%sT%s:00:00+08:00 end=%sT%s:10:00+08:00 wall_secs=600 in=%s out=%s cache_r=%s cache_w=%s models=%s %s-->' \
        "$W" "$1" "$W" "$1" "$3" "$4" "$5" "$6" "$2" "$7"
}
fetched() { printf '%s' "$1" > "$XDG_CACHE_HOME/cavil-loop/fetched-prices.json"; }
py_json() { python3 -c "import json,sys; print(json.dumps(sys.stdin.read()))"; }
cat > "$TMP/issues.json" <<'JSON'
[ {"number":10,"title":"承载记账的 issue","state":"open","labels":[],
   "created_at":"2024-12-01T02:00:00Z","closed_at":null} ]
JSON
echo "[]" > "$TMP/pulls.json"
mkdir -p "$TMP/bin"
cat > "$TMP/bin/gh" <<SHIM
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
chmod +x "$TMP/bin/gh"; export PATH="$TMP/bin:$PATH"
cd "$TMP"
run() {
    local n=0 rows=()
    for body in "$@"; do
        n=$((n+1))
        rows+=("{\"id\":$n,\"issue_url\":\"https://api.github.com/repos/acme/widget/issues/10\",\"user\":{\"login\":\"acme-bot\"},\"created_at\":\"${W}T0${n}:00:00Z\",\"body\":$(printf '%s' "$body" | py_json)}")
    done
    printf '[%s]' "$(IFS=,; echo "${rows[*]}")" > "$TMP/comments.json"
    python3 "$COLLECT" --repo acme/widget --out "$TMP/d.json" --weeks 2 --week-of "$W" \
        --switch-week "$SW" >/dev/null 2>"$TMP/err.log" \
        || { echo "collect.py 跑挂了："; cat "$TMP/err.log"; exit 1; }
    python3 "$REPORT" --data "$TMP/d.json" --out "$TMP/r.md" --asset-url-base x --rev y >/dev/null 2>&1 \
        || { echo "report.py 跑挂了"; exit 1; }
}
q()   { python3 -c "
import json; w=json.load(open('$TMP/d.json'))['weekly']['$W']
print($1)"; }
has() { grep -qF "$1" "$TMP/r.md" && echo yes || echo no; }

# 内置表 gpt-6-sol：输入 2 / 缓存 0.2 / 输出 10（每百万）→ 各 1M token = 12.2 美元
echo "— 内置表里有价的模型：没写金额的记录按 token 补算 —"
run "$(codex 10 gpt-6-sol 'cost_state=none cost_unknown_tokens=3000000 ')"
chk "补算出 12.2"                    "$(q "round(w['cost_codex'],2)")"        "12.2"
chk "算作有金额"                      "$(q "int(w['cost_records_codex'])")"   "1"
chk "来源记作补算"                    "$(q "int(w['src_repriced'])")"          "1"
chk "报告口径写明补算"                "$(has '按记录里的 token 补算')"        "yes"

echo
echo "— 内置表没有、缺价自动补抓到了的模型：用抓来的价 —"
cat > "$XDG_CACHE_HOME/cavil-loop/fetched-prices.json" <<'JSON'
{"codex": {"gpt-x-new": {"prices": {"in": 1, "cached_in": 0.1, "out": 5}}}}
JSON
run "$(codex 10 gpt-x-new 'cost_state=none ')"
chk "按抓来的价补算出 6.1"            "$(q "round(w['cost_codex'],2)")"        "6.1"

echo
echo "— 哪里都没有价：仍然没有金额，不编一个 —"
rm -f "$XDG_CACHE_HOME/cavil-loop/fetched-prices.json"
run "$(codex 10 gpt-x-new 'cost_state=none ')"
chk "没有金额"                        "$(q "int(w['cost_records_codex'])")"   "0"
chk "不算补算"                        "$(q "int(w['src_repriced'])")"          "0"

echo
echo "— 一条记录用了两个模型：token 拆不开，不补算 —"
run "$(codex 10 gpt-6-sol,gpt-6-luna 'cost_state=none ')"
chk "没有金额"                        "$(q "int(w['cost_records_codex'])")"   "0"

echo
echo "— 原本就有金额的记录：沿用原值，不重算 —"
run "$(codex 10 gpt-6-sol 'cost_usd=99.00 cost_state=full ')"
chk "金额仍是 99"                     "$(q "round(w['cost_codex'],2)")"        "99.0"
chk "不算补算"                        "$(q "int(w['src_repriced'])")"          "0"

echo
echo "— 部署者显式关了估价（CODEX_PRICES='{}'）：不补算 —"
CODEX_PRICES='{}' run "$(codex 10 gpt-6-sol 'cost_state=none ')"
chk "没有金额"                        "$(q "int(w['cost_records_codex'])")"   "0"

echo
echo "— 内置价补算：来源记内置参考价、过期标记跟着现在的内置表走，不沿用旧记录（#59 复审第 1 轮）—"
rm -f "$XDG_CACHE_HOME/cavil-loop/fetched-prices.json"
# 旧记录自己写着 price_stale=yes（写评论时的表），补算用的是现在这张表
run "$(codex 10 gpt-6-sol 'cost_state=none price_source=default price_stale=yes ')"
chk "来源计为内置 API 参考价"         "$(q "int(w['price_src_default'])")"     "1"
chk "金额进「说不出可信度」桶，不进抓来的桶" "$(q "round(w['price_usd_unrated'],2), round(w['price_usd_fetched'],2)")" "12.2 0"
STALE=$(python3 -c "
import datetime, json
d = json.load(open('$REPO_DIR/scripts/drivers/token-usage/codex-prices.json'))['checked_at']
print(1 if (datetime.date.today() - datetime.date.fromisoformat(d)).days > 90 else 0)")
chk "过期计数按现在的内置表算（$STALE），不照搬旧记录的 yes" "$(q "int(w['price_stale_records'])")" "$STALE"

echo
echo "— 抓来的价补算：金额进「自动联网获取」那一桶，报告照实说（#59 复审第 1 轮）—"
fetched '{"codex": {"gpt-x-new": {"prices": {"in": 1, "cached_in": 0.1, "out": 5}}}}'
run "$(codex 10 gpt-x-new 'cost_state=none ')"
chk "fetched 桶 6.1、说不出可信度桶 0" "$(q "round(w['price_usd_fetched'],2), round(w['price_usd_unrated'],2)")" "6.1 0"
chk "来源仍计内置（default）那一路"   "$(q "int(w['price_src_default'])")"     "1"
chk "报告说明是自动联网获取的单价"    "$(has '自动联网获取的单价')"            "yes"

echo
echo "— 模型归属不全（另有调用认不出模型）：token 拆不开，不补算（#59 复审第 1 轮）—"
run "$(codex 10 gpt-x-new 'cost_state=none model_unknown=yes ')"
chk "没有金额"                        "$(q "int(w['cost_records_codex'])")"   "0"
chk "不算补算"                        "$(q "int(w['src_repriced'])")"          "0"
chk "金额 0（不把未知模型的用量算到已知模型头上）" "$(q "round(w['cost_codex'],2)")" "0.0"
run "$(codex 10 gpt-x-new 'cost_state=none model_unknown=no ')"
chk "对照：归属完整（model_unknown=no）照常补算 6.1" "$(q "round(w['cost_codex'],2)")" "6.1"

echo
echo "— 只有一部分项有价：已知部分照算，没价的计「部分计价」（#59 复审第 1 轮）—"
# 抓来的价只收两个来源都列出的项，缺缓存读取价是合法的
fetched '{"codex": {"gpt-x-new": {"prices": {"in": 1, "out": 5}}}}'
run "$(codex 10 gpt-x-new 'cost_state=none ')"
chk "已知部分 6.0（输入 1 + 输出 5）" "$(q "round(w['cost_codex'],2)")"        "6.0"
chk "状态是部分计价"                  "$(q "int(w['state_partial']), int(w['state_full']), int(w['state_none'])")" "1 0 0"
chk "算作有金额"                      "$(q "int(w['cost_records_codex'])")"   "1"
chk "金额仍进 fetched 桶"             "$(q "round(w['price_usd_fetched'],2)")" "6.0"
run "$(codex_t 10 gpt-x-new '1000000 1000000 0 0' 'cost_state=none ')"
chk "缺价的项用量为 0：不妨碍补算，状态是完整" "$(q "round(w['cost_codex'],2), int(w['state_full'])")" "6.0 1"
fetched '{"codex": {"gpt-x-new": {"prices": {"in": 1, "cached_in": 0.1, "out": 5}}}}'
run "$(codex_t 10 gpt-x-new '1000000 1000000 1000000 500000' 'cost_state=none ')"
chk "缓存写入非零但没价：其余照算 6.1，部分计价" "$(q "round(w['cost_codex'],2), int(w['state_partial'])")" "6.1 1"
fetched '{"codex": {"gpt-x-new": {"prices": {"cache_write": 3}}}}'
run "$(codex 10 gpt-x-new 'cost_state=none ')"
chk "有价的项用量全为 0：仍是没有金额" "$(q "int(w['cost_records_codex']), int(w['src_repriced'])")" "0 0"
rm -f "$XDG_CACHE_HOME/cavil-loop/fetched-prices.json"

echo
echo "— 部署者配置的价：来源记人工配置 —"
CODEX_PRICES='{"gpt-6-sol":{"in":2,"cached_in":0.2,"out":10}}' run "$(codex 10 gpt-6-sol 'cost_state=none ')"
chk "补算 12.2、来源计人工配置"       "$(q "round(w['cost_codex'],2), int(w['price_src_configured']), int(w['price_src_default'])")" "12.2 1 0"

echo
echo "— 内置表超过 90 天：补算标过期；部署者配置的价不标（替身日期直接测函数）—"
# 上面走真实链路的那条只能在内置表「今天没过期」时测；这里把「今天」换成 2099 年再测一遍。
stale() { env "$@" python3 - "$REPO_DIR/scripts/weekly-report" <<'PY'
import datetime, sys, types
sys.path.insert(0, sys.argv[1])
import price_solve
class D(datetime.date):
    @classmethod
    def today(cls):
        return datetime.date(2099, 1, 1)
price_solve.datetime = types.SimpleNamespace(date=D)
pt = price_solve.codex_price_table()
rec = {"models": ["gpt-6-sol"], "model_unknown": False,
       "tokens": {"in": 1000000, "out": 1000000, "cache_r": 1000000, "cache_w": 0}}
rp = price_solve.codex_reprice(rec, pt)
print(pt["source"], pt["stale"], rp and rp["price_stale"])
PY
}
chk "内置表过期 → 来源 default、补算结果带过期标记" "$(stale -u CODEX_PRICES)" "default True True"
chk "部署者配置的价 → 不标过期"                    "$(stale CODEX_PRICES='{"gpt-6-sol":{"in":2,"cached_in":0.2,"out":10}}')" "configured False False"

echo
echo "— 交叉核对：驱动（codex.sh）和补算（price_solve.codex_reprice）算同一份会话，结果必须一致 —"
# 同一规则两处实现（驱动用 jq、补算用 python）：只各自断言数字，一边漏了分支另一边照样全绿。
# 这里让真实驱动对一份假会话出机器记录，再把这条记录交给补算（补算只看 token / 模型字段，
# 不看金额），比较金额 / 状态 / 缺价 token / 可信度桶 / 来源五项。
DRIVER="$REPO_DIR/scripts/drivers/token-usage/codex.sh"
XS="$TMP/xs"; XWT="$XS/wt"; mkdir -p "$XWT" "$XS/home/.codex/sessions/2026/01/01"
XSTART=$(( $(date +%s) - 3600 ))
xts() { date -u -d "@$(( XSTART + $1 ))" '+%Y-%m-%dT%H:%M:%S.000Z'; }
xsession() {   # $1 模型（空 = 不写 turn_context → 认不出模型）
    {
        printf '{"type":"session_meta","timestamp":"%s","payload":{"cwd":"%s"}}\n' "$(xts 1)" "$XWT"
        [ -n "$1" ] && printf '{"type":"turn_context","timestamp":"%s","payload":{"cwd":"%s","model":"%s"}}\n' "$(xts 2)" "$XWT" "$1"
        # input 含 cached：未命中缓存 = 1,600,000；cached 1,400,000；cache_write 50,000；output 1,000,000
        printf '{"type":"token_usage_record","timestamp":"%s","payload":{"usage":{"input_tokens":3000000,"cached_input_tokens":1400000,"cache_write_input_tokens":50000,"output_tokens":1000000,"reasoning_output_tokens":0,"total_tokens":4000000}}}\n' "$(xts 10)"
    } > "$XS/home/.codex/sessions/2026/01/01/rollout-x.jsonl"
}
xcheck() {   # $1 说明  其余：传给驱动和补算的环境变量（VAR=value …）
    local label="$1"; shift
    local kv
    kv=$( cd "$XWT" && env "$@" HOME="$XS/home" bash "$DRIVER" "$XSTART" --kv 2>/dev/null )
    chk "$label" "$( env "$@" python3 - "$REPO_DIR/scripts/weekly-report" "$kv" <<'PY'
import sys
sys.path.insert(0, sys.argv[1])
import price_solve, record
kv = sys.argv[2]
d = dict(p.split("=", 1) for p in kv.split() if "=" in p)
body = ("x\n\n<!-- agent-metrics agent=codex wt=10 start=2025-01-06T10:00:00+08:00 "
        "end=2025-01-06T10:10:00+08:00 wall_secs=600 " + kv + " -->")
rec = record.extract(body, "acme-bot", 1)
rp = price_solve.codex_reprice(rec, price_solve.codex_price_table())
if d.get("cost_state") == "none" or d.get("model_unknown") == "yes":
    # 驱动算不出、或归属不全时补算必须放弃（归属不全时驱动可能算出 partial，那是它在调用级别看得见模型）
    print("ok" if rp is None else f"补算不该出结果：{rp}")
    sys.exit()
want = {"cost": float(d["cost_usd"]), "cost_state": d["cost_state"],
        "unknown_tokens": int(d["cost_unknown_tokens"]),
        "price_status": record._price_status(d.get("price_status")) or {},
        "price_source": d["price_source"]}
got = None if rp is None else {k: rp[k] for k in want}
same = got is not None and all(
    abs(got[k] - want[k]) < 1e-9 if k == "cost" else
    (got[k].keys() == want[k].keys() and all(abs(got[k][b] - want[k][b]) < 1e-9 for b in want[k]))
    if k == "price_status" else got[k] == want[k] for k in want)
print("ok" if same else f"驱动 {want} ≠ 补算 {got}")
PY
)" "ok"
}
xsession gpt-x-new
xcheck "配置价四项齐全 → 完整"                CODEX_PRICES='{"gpt-x-new":{"in":1,"cached_in":0.1,"out":5,"cache_write":2}}'
xcheck "配置价缺缓存写入 → 部分计价"          CODEX_PRICES='{"gpt-x-new":{"in":1,"cached_in":0.1,"out":5}}'
xcheck "配置价只有输入 / 输出 → 部分计价"      CODEX_PRICES='{"gpt-x-new":{"in":1,"out":5}}'
xcheck "配置价只有缓存写入 → 部分计价"        CODEX_PRICES='{"gpt-x-new":{"cache_write":3}}'
xcheck "旧三变量（所有模型同价）"             CODEX_PRICE_IN_PER_M=1 CODEX_PRICE_CACHED_IN_PER_M=0.1 CODEX_PRICE_OUT_PER_M=5
fetched '{"codex": {"gpt-x-new": {"prices": {"in": 1, "out": 5}}}}'
xcheck "抓来的价（部分项）→ fetched 桶一致"  -u CODEX_PRICES XDG_CACHE_HOME="$XDG_CACHE_HOME"
rm -f "$XDG_CACHE_HOME/cavil-loop/fetched-prices.json"
xsession gpt-6-sol
xcheck "内置表的模型 → default 来源一致"     -u CODEX_PRICES XDG_CACHE_HOME="$XDG_CACHE_HOME"
xsession ""
xcheck "认不出模型 → 两边都没有金额"         CODEX_PRICES='{"gpt-x-new":{"in":1,"cached_in":0.1,"out":5}}'

echo
echo "通过 $pass / 失败 $fail"
[ "$fail" -eq 0 ]
