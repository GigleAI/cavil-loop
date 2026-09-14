#!/usr/bin/env bash
# 周报**呈现**层的两条硬规矩（scripts/weekly-report/report.py）。
#
# 跑法：bash tests/weekly-report-presentation.test.sh
# 依赖：python3。喂人工构造的 data.json，跑**真实 report.py**，不碰网络。
#
# 为什么要有这个文件（GigleTutor-Web#932 交叉 review 第 5 轮）：
#  1. **缺金额不是零金额**。某一侧没配单价时驱动是**有意**不出金额的，采集后落成 0；
#     报告直接拿 cost_codex / cost 算，就会白纸黑字写出「交叉 review 那一侧占成本 0%」
#     ——那是把「没采到」讲成了「没花钱」。
#  2. **跨口径不给环比**。口径切换那一周同时发生两件事：用量按 API 调用去重、纳入交叉
#     review 那一侧。拿它跟前一周比，「量得更全了」会被读成「干得更多了」——而紧随其后
#     那段说明又写着「与切换前的周不可直接比」，自相矛盾。
# 这两类错都不会报错，只会让人读出错误结论，所以必须钉住。
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
REPORT="$REPO_DIR/scripts/weekly-report/report.py"

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0
chk() { if [ "$2" = "$3" ]; then echo "  ✅ $1"; pass=$((pass+1)); else echo "  ❌ $1"; echo "       期望 $3"; echo "       实得 $2"; fail=$((fail+1)); fi; }

# 造 data.json：每周给一组「claude 侧 / codex 侧」的记账条数与金额，其余字段固定。
# codex_cost_recs 就是本测试的关键旋钮——它是「该侧有几条记账**带金额**」。
mkfix() { python3 - "$TMP/data.json" "$@" <<'PY'
import json, sys
out, spec = sys.argv[1], sys.argv[2:]
# spec 每周一项："claude条数:claude金额:codex条数:codex金额:codex有金额条数"
weeks = ["2025-01-06", "2025-01-13", "2025-01-20", "2025-01-27"][:len(spec)]
weekly = {}
for i, (k, sp) in enumerate(zip(weeks, spec)):
    rcl, ccl, rcd, ccd, cr_cd = (float(x) for x in sp.split(":"))
    weekly[k] = {
        "iss_open": 10, "iss_closed": 8, "pr_merged": 5, "pr_open": 5,
        "add": 2000, "del": 1000, "commits": 3,
        "comments": 100, "human": 10, "bot": 90, "codex": 1,
        "backlog": 40, "sess_med": 60, "out": 1000,
        "wall": (rcl + rcd) * 3600, "work": (rcl + rcd) * 1800,
        "cost": ccl + ccd,
        "records": rcl + rcd, "dupes": 0,
        "footers": rcl + rcd, "cost_footers": rcl + rcd,
        "work_records": rcl + rcd, "work_missing": 0,
        "long_windows": 0, "misattributed": 0,
        "wall_claude": rcl * 3600, "wall_codex": rcd * 3600,
        "work_claude": rcl * 1800, "work_codex": rcd * 1800,
        "cost_claude": ccl, "cost_codex": ccd,
        "records_claude": rcl, "records_codex": rcd,
        "cost_records": rcl + cr_cd,          # claude 侧一律有金额
        "cost_records_claude": rcl, "cost_records_codex": cr_cd,
    }
json.dump({"weeks": weeks, "weekly": weekly,
           "target_week": {"start": weeks[-1], "end": "2025-02-02"},
           "detail": [], "loose_prs": [], "long_windows": [], "misattributed": [],
           "generated_at": "2025-02-03T09:00:00"}, open(out, "w"))
PY
python3 "$REPORT" --data "$TMP/data.json" --out "$TMP/report.md" \
    --asset-url-base "https://example.invalid/a" --rev test >/dev/null 2>"$TMP/err.txt" \
    || { echo "report.py 跑挂了："; cat "$TMP/err.txt"; exit 1; }
}

# 从报告里抓某个指标那一行的「变化」列
chg() { grep -F "| $1 |" "$TMP/report.md" | head -1 | awk -F'|' '{gsub(/^ +| +$/,"",$5); print $5}'; }
has() { grep -qF "$1" "$TMP/report.md" && echo yes || echo no; }

echo "── 场景 A：切换周，codex 有记账但一条金额都没有（本次部署的真实状态） ──"
# 前一周：claude 1 条 / $10；切换周：claude 1 条 / $10 + codex 1 条 / 无金额
mkfix "1:10:0:0:0" "1:10:1:0:0"
chk "不得出现「占成本 0%」"                       "$(has '占成本 0%')" "no"
chk "明说占比算不出来、不是 0%"                   "$(has '算不出来——不是 0%')" "yes"
chk "合计成本标明只含已知金额的条数"               "$(has '$10（仅 1/2 条有金额）')" "yes"
chk "正文点出本周有几条没金额"                     "$(has '有 **1 条没有金额**（其中交叉 review 那一侧 1 条）')" "yes"
chk "墙上时长的环比 → 不给百分比"                  "$(chg 'AI 工作时长（墙上）')" "—（口径变化，不可比）"
chk "模型 + 工具的环比 → 不给百分比"               "$(chg '其中模型 + 工具')" "—（口径变化，不可比）"
chk "成本的环比 → 不给百分比"                      "$(chg '成本（按调用去重后的标价估算）')" "—（口径变化，不可比）"
chk "同口径的业务指标照常给环比"                   "$(chg '新提 issue')" "+0%"
chk "逐周表标出切换周"                             "$(has '† 1/13 那周起口径改了')" "yes"

echo
echo "── 场景 B：切换周，codex 部分记账有金额 ──"
# codex 2 条、其中 1 条带金额 $5；claude 1 条 / $10 → 已知金额合计 $15
mkfix "1:10:0:0:0" "1:10:2:5:1"
chk "给占比时必须紧挨着说明分母范围" \
    "$(has '分母只含带金额的记账（该侧 1/2 条、主 worker 1/1 条）')" "yes"
chk "并明确它不是完整的两侧占比"                   "$(has '**不是完整的两侧占比**')" "yes"
chk "百分比按已知金额算（5 / 15）"                 "$(has '交叉 review 那一侧占 33%')" "yes"

echo
echo "── 场景 C：切换周，两侧金额齐全 ──"
mkfix "1:10:0:0:0" "1:10:1:5:1"
chk "金额齐全时正常给占比"                         "$(has '占成本 33%（两侧 2 条记账金额齐全）')" "yes"
chk "金额齐全时不再提「仅 N/M 条有金额」"          "$(has '条有金额）')" "no"
chk "不出现「无法计算」那套话术"                   "$(has '算不出来——不是 0%')" "no"

echo
echo "── 场景 D：切换之后的同口径周 → 环比恢复正常 ──"
# 第 3 周与第 4 周都含 codex：目标周不在切换边界上
mkfix "1:10:0:0:0" "1:10:1:5:1" "1:10:1:5:1" "2:20:2:10:2"
chk "墙上时长恢复百分比（2h → 4h）"                "$(chg 'AI 工作时长（墙上）')" "+100%"
chk "成本恢复百分比（\$15 → \$30）"                "$(chg '成本（按调用去重后的标价估算）')" "+100%"
chk "切换周记号仍标在第一个含 codex 的周"          "$(has '† 1/13 那周起口径改了')" "yes"

echo
echo "通过 $pass / 失败 $fail"
[ "$fail" -eq 0 ]
