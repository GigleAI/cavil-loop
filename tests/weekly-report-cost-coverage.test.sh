#!/usr/bin/env bash
# 「这条记账有没有金额」必须看**字段在不在**，不能看**金额是不是 0**。
#
# 跑法：bash tests/weekly-report-cost-coverage.test.sh
# 依赖：python3。自造假 `gh` 喂真实评论正文，**走完整链路**
# record.extract → collect.main → report.py，不预填任何 `cost_records`。
#
# 为什么要有这个文件（GigleTutor-Web#932 交叉 review）：
# `cost = 0` 有两种来源，含义完全相反——
#   · 驱动**没配单价** → 根本不写 `cost_usd`（codex driver 有意为之）；
#   · 驱动**配了单价**、但这段估算不足半美分 → `usd2` 如实写出 `cost_usd=0.00`。
# 原来按「金额非零」判覆盖，后者被算成「没采到金额」，报告于是白纸黑字写
# 「该侧未配单价，驱动如实不出金额」——事实正好相反。
# 历史记账行同理：`token … ($0.00)` 是「记了，是 0」，整行没有 `($…)` 才是「没记」。
#
# ⚠️ 这个测试**必须走采集层**：呈现层 fixture 直接预填 `cost_records`，正好绕开了
# 出错的那段逻辑，挡不住这类回归。
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
COLLECT="$REPO_DIR/scripts/weekly-report/collect.py"
REPORT="$REPO_DIR/scripts/weekly-report/report.py"

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0
chk() { if [ "$2" = "$3" ]; then echo "  ✅ $1"; pass=$((pass+1)); else echo "  ❌ $1 (期望 '$3'，实得 '$2')"; fail=$((fail+1)); fi; }

W=2025-01-06        # 目标周（周一）
SW=2025-01-06       # 口径切换周：配置给定，好让并列表与占比都出来

# 一条机器记录评论。$4 传 `cost_usd=...` 那一段；传空串就是**完全不写金额**。
marker() {   # agent hh cost_kv
    local ag="$1" hh="$2" ck="$3"
    printf '干完了。\n\n<!-- agent-metrics agent=%s wt=10 start=%sT%s:00:00+08:00 end=%sT%s:10:00+08:00 wall_secs=600 in=1 out=1 cache_r=0 cache_w=0 %s-->' \
        "$ag" "$W" "$hh" "$W" "$hh" "$ck"
}
# 一条历史记账行评论（没有机器记录）。$2 传 ` ($x.xx)`；传空串就是 token 行里没有金额。
legacy() {   # hh money
    printf '干完了。\n\n---\n⏱️ 开始 %s %s:00:00 · 完工 %s:10:00 · 耗时 10m 0s\ntoken 1 input, 1 output%s\n' \
        "$W" "$1" "$1" "$2"
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

# 把若干条评论正文喂进去，跑完整链路，产出 report.md
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
}
q()   { python3 -c "
import json; w=json.load(open('$TMP/d.json'))['weekly']['$W']
print(int(w['$1']))"; }
has() { grep -qF "$1" "$TMP/r.md" && echo yes || echo no; }

echo "— 显式 cost_usd=0.00：记了，是 0（不是「没采到」）—"
run "$(marker claude 10 'cost_usd=10.00 ')" "$(marker codex 11 'cost_usd=0.00 ')"
chk "两条都算「有金额」"                 "$(q cost_records)"       "2"
chk "codex 那侧也算有金额"               "$(q cost_records_codex)" "1"
chk "不提示缺金额"                       "$(has '条没有金额')"      "no"
chk "不谎称该侧未配单价"                 "$(has '该侧未配单价')"    "no"
chk "不出现「算不出来」话术"             "$(has '算不出来——不是 0%')" "no"
chk "合计成本栏不加「仅 N/M 条有金额」"  "$(has '条有金额）')"      "no"
chk "占比按标价估算给出 0%"              "$(has '占成本 0%')"       "yes"
chk "并说明按分舍入、不代表账单为零"     "$(has '不代表真实账单为零')" "yes"

echo
echo "— 完全不写 cost_usd：确实没采到 —"
run "$(marker claude 10 'cost_usd=10.00 ')" "$(marker codex 11 '')"
chk "只有 1 条算有金额"                  "$(q cost_records)"       "1"
chk "codex 那侧 0 条"                    "$(q cost_records_codex)" "0"
chk "提示缺金额"                         "$(has '条没有金额')"      "yes"
chk "明说算不出来、不是 0%"              "$(has '算不出来——不是 0%')" "yes"

echo
echo "— 正金额：不受影响 —"
run "$(marker claude 10 'cost_usd=10.00 ')" "$(marker codex 11 'cost_usd=5.00 ')"
chk "两条都算有金额"                     "$(q cost_records)"       "2"
chk "占比 5/15 = 33%"                    "$(has '占成本 33%')"      "yes"
chk "不提示缺金额"                       "$(has '条没有金额')"      "no"

echo
echo "— 历史记账行：(\$0.00) 是记了，没有 (\$…) 才是没记 —"
run "$(legacy 10 ' ($0.00)')" "$(legacy 11 ' ($10.00)')"
chk "两条都算有金额"                     "$(q cost_records)"       "2"
chk "不提示缺金额"                       "$(has '条没有金额')"      "no"
run "$(legacy 10 '')" "$(legacy 11 ' ($10.00)')"
chk "token 行里没有金额 → 只有 1 条有"   "$(q cost_records)"       "1"
chk "提示缺金额"                         "$(has '条没有金额')"      "yes"

echo
echo "通过 $pass / 失败 $fail"
[ "$fail" -eq 0 ]
