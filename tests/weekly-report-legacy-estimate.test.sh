#!/usr/bin/env bash
# 9/14 口径切换前的历史记账：金额按记录里的 token × 现行 Opus 价重估，再抵掉重复计；
# 同时每周汇总四项 token，供趋势图出「token 用量」面板。
#
# 跑法：bash tests/weekly-report-legacy-estimate.test.sh
# 依赖：python3。自造假 `gh` 喂真实评论正文，**走完整链路**
# record.extract → collect.main → report.py / render.py，不预填任何汇总字段。
#
# 为什么要有这个文件：历史记账行的金额是旧驱动写死的——所有 Opus 一律按 Opus 4 的
# 价（输入 $15 / 输出 $75 / 缓存读 $1.5），而且同一次 API 调用的多条日志逐条累加
# （按 requestId 去重后的 1.68 倍，53 个会话中位数）。这些原值直接进趋势图，切换周
# 前后成本差出 3~5 倍，读起来像「突然省了一大笔钱」。原值又改不回去（本机日志多已清掉），
# 只能用记录里留下的 token 数按现行价目估一遍，并在报告里写明是估算。
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
COLLECT="$REPO_DIR/scripts/weekly-report/collect.py"
REPORT="$REPO_DIR/scripts/weekly-report/report.py"
RENDER="$REPO_DIR/scripts/weekly-report/render.py"

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0
chk() { if [ "$2" = "$3" ]; then echo "  ✅ $1"; pass=$((pass+1)); else echo "  ❌ $1 (期望 '$3'，实得 '$2')"; fail=$((fail+1)); fi; }

W=2025-01-06
SW=2025-01-06

marker() {   # hh cost_kv tokens_kv
    printf '干完了。\n\n<!-- agent-metrics agent=claude wt=10 start=%sT%s:00:00+08:00 end=%sT%s:10:00+08:00 wall_secs=600 %s %s-->' \
        "$W" "$1" "$W" "$1" "$3" "$2"
}
legacy() {   # hh tokenline
    printf '干完了。\n\n---\n⏱️ 开始 %s %s:00:00 · 完工 %s:10:00 · 耗时 10m 0s\n%s\n' "$W" "$1" "$1" "$2"
}
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
    python3 "$REPORT" --data "$TMP/d.json" --out "$TMP/r.md" \
        --asset-url-base x --rev y >/dev/null 2>&1 \
        || { echo "report.py 跑挂了"; exit 1; }
    python3 "$RENDER" --data "$TMP/d.json" --out-dir "$TMP/html" \
        --asset-url-base x --rev y >/dev/null 2>"$TMP/err.log" \
        || { echo "render.py 跑挂了："; cat "$TMP/err.log"; exit 1; }
}
q()   { python3 -c "
import json; w=json.load(open('$TMP/d.json'))['weekly']['$W']
print($1)"; }
has() { grep -qF "$1" "$TMP/r.md" && echo yes || echo no; }

# Opus 现行参照价（输入 5 / 输出 25 / 缓存读 0.5 / 缓存写 1h 10，每百万 token），
# 每项 1m token → 40.5 美元；再除以 1.68 → 24.107…
echo "— 历史记账行：按 token × 现行 Opus 价 ÷ 1.68 重估，不用旧驱动写死的金额 —"
run "$(legacy 10 'token 1m input, 1m output, 1m cache read, 1m cache write ($999.00)')"
chk "金额是重估值 24.11（不是原值 999）"   "$(q "round(w['cost'],2)")"        "24.11"
chk "记作「估算」来源"                     "$(q "int(w['src_estimated'])")"   "1"
chk "不再记作「沿用原值」"                 "$(q "int(w['src_original'])")"    "0"
chk "仍算「有金额」"                       "$(q "int(w['cost_records'])")"    "1"
chk "可信度桶记在「估算」下"               "$(q "round(w['price_usd_estimated'],2)")" "24.11"
chk "token 也按 1.68 抵掉重复计：输出"     "$(q "int(w['tok_out'])")"         "595238"
chk "缓存读取"                             "$(q "int(w['tok_cache_r'])")"     "595238"
chk "报告口径说明写明是估算"               "$(has '按记录里的 token 数重估')" "yes"
# 两条纵轴刻度差两个数量级：只靠刻度，读图的人会拿折线高度跟柱子比，把「缓存读取是缓存写入
# 的几十倍」读成「读取反而很少」（GigleTutor-Web#1023 维护者原话）。所以折线的点上直接标值、
# 图例写明看哪条轴。
chk "缓存读取折线把数值直接标在点上（0.6M，抵重后）" "$(grep -c 'class="val" text-anchor="start" fill="#4a3aa7">0.6M</text>' "$TMP/html/effort.html" | tr -d ' ' | sed 's/^[1-9][0-9]*$/yes/')" "yes"
chk "图例写明缓存读取看右轴" "$(grep -c '缓存读取（右轴）' "$TMP/html/effort.html" | tr -d ' ' | sed 's/^[1-9][0-9]*$/yes/')" "yes"
chk "副标题提醒两条轴刻度不同" "$(grep -c '别拿高度直接比' "$TMP/html/effort.html" | tr -d ' ' | sed 's/^[1-9][0-9]*$/yes/')" "yes"
chk "投入面趋势图多了 token 用量面板"      "$(grep -c 'token 用量' "$TMP/html/effort.html" | tr -d ' ' | sed 's/^[1-9][0-9]*$/yes/')" "yes"

echo
echo "— 历史记账行没写金额：保持「没有金额」，不凭 token 补一个出来 —"
run "$(legacy 10 'token 1m input, 1m output')"
chk "没有金额"                             "$(q "int(w['cost_records'])")"    "0"
chk "不算估算"                             "$(q "int(w['src_estimated'])")"   "0"
chk "token 照样计入趋势（抵重后）"         "$(q "int(w['tok_out'])")"         "595238"

echo
echo "— 切换后的机器记录：金额、token 都原样，不做重估 —"
run "$(marker 10 'cost_usd=10.00 ' 'in=100 out=2000000 cache_r=300 cache_w=400')"
chk "金额原样 10"                          "$(q "round(w['cost'],2)")"        "10.0"
chk "不算估算"                             "$(q "int(w['src_estimated'])")"   "0"
chk "token 原样：输出"                     "$(q "int(w['tok_out'])")"         "2000000"
chk "token 原样：输入"                     "$(q "int(w['tok_in'])")"          "100"
chk "报告不提重估"                         "$(has '按记录里的 token 数重估')" "no"

echo
echo "通过 $pass / 失败 $fail"
[ "$fail" -eq 0 ]
