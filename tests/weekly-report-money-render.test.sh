#!/usr/bin/env bash
# 周报里**金额那几行的渲染**（scripts/weekly-report/report.py）。
#
# 跑法：bash tests/weekly-report-money-render.test.sh
# 依赖：python3。跑**真实 report.py**，不碰网络、不读本机日志。
#
# 为什么要有这个文件（GigleTutor-Web#934 交叉 review 第 7 轮）：
#  1. **显示取整不能决定「有没有」**。可信度分桶原来按 `round(金额) != 0` 筛，
#     $0.10 的存疑金额直接从报告里消失，还反过来输出「本次区间没有算出金额，
#     无从谈可信度」——把「显示成零」讲成了「没算出来」，承诺的报红也跟着没了。
#  2. **实付两列要各按各周摊**。原来只算一次目标周就把同一个数填进两格，
#     跨月的前一周（天数不同）被复制成本周的数，环比直接错。
#
# ⚠️ 可信度那几条**不预填桶**：先跑真实的 `attribute.price_calls` 把桶算出来，
#    再喂进 report。预填合计会绕开「计价 → 呈现」这一段，正是本轮出错的那一段。
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
REPORT="$REPO_DIR/scripts/weekly-report/report.py"

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0
chk() { if [ "$2" = "$3" ]; then echo "  ✅ $1"; pass=$((pass+1)); else echo "  ❌ $1"; echo "       期望 $3"; echo "       实得 $2"; fail=$((fail+1)); fi; }

# 造 data.json。$1 目标周一；$2.. 是「模型项:token数:单价:可信度」，
# 这些**交给真实 price_calls 去算**，不手填桶。
mkdata() { python3 - "$REPO_DIR/scripts/weekly-report" "$TMP/d.json" "$@" <<'PY'
import json, sys, datetime
sys.path.insert(0, sys.argv[1])   # 由调用方传入，别硬编码本机路径
import attribute

out, tw = sys.argv[2], sys.argv[3]
specs = sys.argv[4:]
priced, table = {}, {}
for sp in specs:
    item, tok, price, status = sp.split(":")
    priced[item] = int(tok)
    table[item] = {"price": float(price), "status": status}
usd, unk, state, buckets = 0.0, 0, "none", {}
if priced:
    usd, unk, state, buckets = attribute.price_calls(
        [{"model": "m1", "speed": "standard", "priced": priced}],
        {"models": {"m1": table}, "fast": {}})

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
cur = dict(ZERO)
cur["cost"] = usd
cur["records"] = 1 if priced else 0
cur["cost_records"] = 1 if state != "none" else 0
cur[f"state_{state}"] = 1 if priced else 0
cur["price_src_solved"] = 1 if priced else 0
for k, v in buckets.items():
    cur[f"price_usd_{k}"] = v

mon = datetime.date.fromisoformat(tw)
prev = (mon - datetime.timedelta(days=7)).isoformat()
weekly = {prev: dict(ZERO), tw: cur}
json.dump({"repo": "acme/widget", "generated_at": datetime.datetime.now().isoformat(),
           "price_reference": {"source": "ref-x", "policy": "A"},
           "switch_week": None, "long_windows": [], "misattributed": [],
           "target_week": {"start": tw, "end": (mon + datetime.timedelta(days=7)).isoformat()},
           "weeks": [prev, tw], "weekly": weekly, "detail": [], "loose_prs": []}, open(out, "w"))
print(f"price_calls: usd={round(usd,4)} unk={unk} state={state} buckets={buckets}", file=sys.stderr)
PY
}
# 只有目标周一份数据（没有前一周）——报告不能因此跑挂
mkdata1() { python3 - "$TMP/d.json" "$1" <<'PY'
import json, sys, datetime
out, tw = sys.argv[1], sys.argv[2]
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
mon = datetime.date.fromisoformat(tw)
json.dump({"repo": "acme/widget", "generated_at": datetime.datetime.now().isoformat(),
           "price_reference": {"source": "ref-x", "policy": "A"},
           "switch_week": None, "long_windows": [], "misattributed": [],
           "target_week": {"start": tw, "end": (mon + datetime.timedelta(days=7)).isoformat()},
           "weeks": [tw], "weekly": {tw: dict(ZERO)}, "detail": [], "loose_prs": []}, open(out, "w"))
PY
}

run_report() { python3 "$REPORT" --data "$TMP/d.json" --out "$TMP/r.md" \
                 --asset-url-base x --rev y >/dev/null 2>"$TMP/err.log" \
               || { echo "report.py 跑挂了："; cat "$TMP/err.log"; exit 1; }; }
trust_line() { grep -o '单价可信度.*' "$TMP/r.md" | head -1; }
paid_row()  { grep -o '| 实付（美元，订阅月费按天摊到本周） |[^|]*|[^|]*|' "$TMP/r.md" | head -1; }

echo "── 1. 小额金额不许被显示取整抹掉 ──"
# 10,000 input × $10/M = $0.10，状态 disputed。真实 price_calls 算出来的桶。
mkdata 2026-03-02 "input:10000:10:disputed" 2>/dev/null
run_report
chk "存疑提示没有消失"                \
    "$(trust_line | grep -qF '与参照冲突（存疑）' && echo yes || echo no)" "yes"
chk "报红的 ⚠️ 还在"                  \
    "$(trust_line | grep -qF '⚠️' && echo yes || echo no)" "yes"
chk "小额显示到分（\$0.10），不是被抹成 0" \
    "$(trust_line | grep -qF '$0.10' && echo yes || echo no)" "yes"
chk "不许说「没有算出金额」（那是把显示成零讲成了没算出来）" \
    "$(trust_line | grep -qF '没有算出金额' && echo yes || echo no)" "no"

echo "── 2. 大桶小桶混在一起时，小桶照样出现 ──"
mkdata 2026-03-02 "input:100000000:10:corroborated" "output:10000:10:disputed" 2>/dev/null
run_report
chk "大桶按整数显示（\$1,000）"        \
    "$(trust_line | grep -qF '$1,000' && echo yes || echo no)" "yes"
chk "小桶没被大桶盖过去（\$0.10 仍在）" \
    "$(trust_line | grep -qF '$0.10' && echo yes || echo no)" "yes"
chk "两个桶都点了名"                  \
    "$(trust_line | grep -qF '与参照冲突（存疑）' && trust_line | grep -qF '与参照一致' && echo yes || echo no)" "yes"

echo "── 3. 小额 uncorroborated 同理（不是只给 disputed 开后门）──"
mkdata 2026-03-02 "input:20000:10:uncorroborated" 2>/dev/null
run_report
chk "「反解稳定但无参照可比」出现"    \
    "$(trust_line | grep -qF '反解稳定但无参照可比' && echo yes || echo no)" "yes"
chk "金额显示 \$0.20"                 \
    "$(trust_line | grep -qF '$0.20' && echo yes || echo no)" "yes"

echo "── 4. 不足一分的金额也要看得见，不能静默 ──"
mkdata 2026-03-02 "input:100:10:disputed" 2>/dev/null
run_report
chk "写成「< \$0.01」而不是消失"      \
    "$(trust_line | grep -qF '< $0.01' && echo yes || echo no)" "yes"

echo "── 5. 反向：真的一分钱都没算出来时，照旧说「没算出金额」 ──"
mkdata 2026-03-02 2>/dev/null
run_report
chk "如实说本次区间没有算出金额"      \
    "$(trust_line | grep -qF '没有算出金额' && echo yes || echo no)" "yes"
chk "不出现任何可信度桶"              \
    "$(trust_line | grep -qE '与参照冲突|与参照一致|无参照可比' && echo yes || echo no)" "no"

echo "── 6. 实付：两列各按各周的起点摊（跨月周） ──"
# 月费 300。目标周 2026-03-02：7 天全在 3 月（31 天）→ 7×300/31 ≈ 67.7 → $68
# 前一周 2026-02-23：6 天在 2 月（28 天）+ 1 天在 3 月 → 6×300/28 + 300/31 ≈ 74.0 → $74
mkdata 2026-03-02 "input:100000000:10:corroborated" 2>/dev/null
chk "跨月的前一周不再复制本周的数" \
    "$(WEEKLY_REPORT_SUBSCRIPTION_MONTHLY=300 python3 "$REPORT" --data "$TMP/d.json" \
        --out "$TMP/r.md" --asset-url-base x --rev y >/dev/null 2>&1; paid_row)" \
    "| 实付（美元，订阅月费按天摊到本周） | \$68 | \$74 |"

echo "── 7. 实付：不同月天数各算各的 ──"
# 目标周 2026-02-02（2 月 28 天）：7×300/28 ≈ 75 → \$75
# 前一周 2026-01-26：6 天在 1 月（31 天）+ 1 天在 2 月 → 6×300/31 + 300/28 ≈ 68.8 → \$69
mkdata 2026-02-02 "input:100000000:10:corroborated" 2>/dev/null
chk "2 月那一周按 28 天摊、1 月按 31 天" \
    "$(WEEKLY_REPORT_SUBSCRIPTION_MONTHLY=300 python3 "$REPORT" --data "$TMP/d.json" \
        --out "$TMP/r.md" --asset-url-base x --rev y >/dev/null 2>&1; paid_row)" \
    "| 实付（美元，订阅月费按天摊到本周） | \$75 | \$69 |"

echo "── 8. 实付：没配月费 → 两列都「未配置」，不猜 ──"
mkdata 2026-03-02 "input:100000000:10:corroborated" 2>/dev/null
chk "两列都是未配置" \
    "$(env -u WEEKLY_REPORT_SUBSCRIPTION_MONTHLY python3 "$REPORT" --data "$TMP/d.json" \
        --out "$TMP/r.md" --asset-url-base x --rev y >/dev/null 2>&1; paid_row)" \
    "| 实付（美元，订阅月费按天摊到本周） | 未配置 | 未配置 |"

echo "── 9. 实付：只有目标周一份数据也要算得出前一周（日历事实，不依赖有没有数据）──"
mkdata1 2026-03-02
chk "单周输入不跑挂，两格都给得出" \
    "$(WEEKLY_REPORT_SUBSCRIPTION_MONTHLY=300 python3 "$REPORT" --data "$TMP/d.json" \
        --out "$TMP/r.md" --asset-url-base x --rev y >/dev/null 2>&1; paid_row)" \
    "| 实付（美元，订阅月费按天摊到本周） | \$68 | \$74 |"

echo
echo "结果：$pass passed, $fail failed"
[ "$fail" -eq 0 ]
