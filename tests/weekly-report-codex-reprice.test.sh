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
echo "通过 $pass / 失败 $fail"
[ "$fail" -eq 0 ]
