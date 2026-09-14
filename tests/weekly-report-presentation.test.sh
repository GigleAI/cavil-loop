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
# switch_week 由采集侧给（见 collect.py 的 switch_week()）——**只来自部署配置**，
# 采集器不从数据里猜。这里的 fixture 直接把「部署方配置的那一周」写死成第一个有 codex
# 记账的周；场景 E / F 用 SWITCH_WEEK 覆盖成「配的是更早的周」和「没配」。
# 报告只管用这个字段，绝不自己在窗口里找——那会随窗口滚动漂移。
sw = next((k for i, k in enumerate(weeks) if weekly[k]["records_codex"] and i > 0), None)
if "SWITCH_WEEK" in __import__("os").environ:
    sw = __import__("os").environ["SWITCH_WEEK"] or None
json.dump({"weeks": weeks, "weekly": weekly, "switch_week": sw,
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
chk "折算价值的环比 → 不给百分比"                      "$(chg '折算价值（按公开标价）')" "—（口径变化，不可比）"
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
chk "成本恢复百分比（\$15 → \$30）"                "$(chg '折算价值（按公开标价）')" "+100%"
chk "切换周记号仍标在第一个含 codex 的周"          "$(has '† 1/13 那周起口径改了')" "yes"

echo
echo "── 场景 E：切换周已滚出展示窗口（switch_week 落在窗口之前） ──"
# 真实切换在 2024-12-30，窗口 2025-01-06 起——窗口里每一周都有 codex 记账。
# 这时**不能**把窗口里第一周当成新的切换点，否则历史切换日期每周往后漂一次。
SWITCH_WEEK="2024-12-30" mkfix "1:10:1:5:1" "1:10:1:5:1" "1:10:1:5:1" "2:20:2:10:2"
chk "不把窗口里第一周标成切换周"                   "$(has '那周起口径改了')" "no"
chk "环比恢复正常（不误判成跨口径）"               "$(chg 'AI 工作时长（墙上）')" "+100%"
chk "过渡期已过（切换后第 4 周以上）→ 不出并列块"  "$(has '口径切换过渡期')" "no"

echo
echo "── 场景 F：采集侧判不出边界（switch_week 为空） ──"
SWITCH_WEEK="" mkfix "1:10:1:5:1" "1:10:1:5:1"
chk "什么都不标"                                   "$(has '那周起口径改了')" "no"
chk "环比照常给百分比"                             "$(chg 'AI 工作时长（墙上）')" "+0%"
chk "不出口径切换过渡期块"                         "$(has '口径切换过渡期')" "no"

echo
echo "── 场景 G：过渡期已结束，但「codex 占成本多少」必须常驻 ──"
# #931 Q3 拍板的是「合并一个总数 + 括注 codex 占比」，**没有四周截止条件**；
# 四周过渡期管的只是那张并列表。原来两件事绑在同一个 if 里，过渡期一结束占比就没了。
# switch_week=2024-12-30、目标周 2025-01-27（切换后第 5 周）、两侧金额齐全。
SWITCH_WEEK="2024-12-30" mkfix "1:10:1:5:1" "1:10:1:5:1" "1:10:1:5:1" "1:10:1:5:1"
chk "过渡期已过 → 不再出并列表"           "$(has '口径切换过渡期')" "no"
chk "但占比照常给（5 / 15 = 33%）"         "$(has '交叉 review 那一侧占成本 33%')" "yes"
chk "占比不受过渡期结束影响，仍标明金额齐全" "$(has '条记账金额齐全')" "yes"

echo
echo "── 场景 H：过渡期结束后，金额缺失仍不能变回假 0% ──"
# 同样是切换后第 5 周，但 codex 那侧一条金额都没有
SWITCH_WEEK="2024-12-30" mkfix "1:10:1:0:0" "1:10:1:0:0" "1:10:1:0:0" "1:10:1:0:0"
chk "不出现「占成本 0%」"                  "$(has '占成本 0%')" "no"
chk "明说算不出来、不是 0%"                "$(has '算不出来——不是 0%')" "yes"
# 部分缺金额：codex 2 条只有 1 条带 $5
SWITCH_WEEK="2024-12-30" mkfix "1:10:2:5:1" "1:10:2:5:1" "1:10:2:5:1" "1:10:2:5:1"
chk "部分缺金额 → 给占比但写清分母"        "$(has '分母只含带金额的记账（该侧 1/2 条、主 worker 1/1 条）')" "yes"

echo
echo "── 场景 I：过渡期里某一周没人做 review（正常情形）──"
# 切换已由配置定死，本周有没有 review 不能决定要不要出并列表。
# switch_week=2025-01-13、目标周 2025-01-20（第 2 / 4 周），本周只有 claude 一条 \$10。
SWITCH_WEEK="2025-01-13" mkfix "1:10:0:0:0" "1:10:1:5:1" "1:10:0:0:0"
chk "并列表照常出"                         "$(has '两侧合计·新口径')" "yes"
chk "并写明是第 2 / 4 周"                  "$(has '第 2 / 4 周')" "yes"
chk "说明本周该侧没有记账、不是口径回退"   "$(has '两行数值相同')" "yes"
chk "占比那一段也说明本周该侧没有记录"     "$(has '没有记账记录')" "yes"

echo
echo "通过 $pass / 失败 $fail"
[ "$fail" -eq 0 ]
