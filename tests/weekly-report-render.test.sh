#!/usr/bin/env bash
# 周报趋势图的渲染契约（render.py 的投入面 / 交付面）。
#
# 跑法：bash tests/weekly-report-render.test.sh
# 依赖：python3。喂一份人工构造的 data.json，不碰网络、不碰真实仓库、不截图。
#
# 为什么要有这个文件：图是 PNG，错了没有任何报错——只有人盯着看才发现。
# 尤其这几处，静默错掉的代价最大：
#   · 秒 → 小时的换算写错（除 60 还是除 3600），图照样画得很漂亮，只是数字全错一个量级。
#   · 数值格式器是 per-series 的：工时那条要带 h、要给小数；**其余系列必须保持原样**。
#     一旦格式器泄漏到别的 series，「成本 7.2k」会变成「7.2kh」这种鬼东西。
#   · 零工时的周：柱顶不打标签（沿用 render.py 的 `if v`），而「行/小时」折线的分母为零，
#     必须断成缺口而不是画到 0——画到 0 会被读成「那周产出为 0」，那是两回事。

set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
export RENDER="$REPO_DIR/scripts/weekly-report/render.py"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0
chk() { if [ "$2" = "$3" ]; then echo "  ✅ $1"; pass=$((pass+1)); else echo "  ❌ $1 (期望 '$3'，实得 '$2')"; fail=$((fail+1)); fi; }

# fixture：5 周，wall（墙上时长）刻意取在格式化的边界上
#   13320 = 3h42m → 3.7h（不足 10 小时给一位小数）
#   35640 = 9h54m → 9.9h（10 小时以下的上边界）
#   36000 = 10h 整 → 10h（正好 10 小时走整数分支）
#  367200 = 102h   → 102h（大值取整）
#       0          → 柱顶不打标签；「行/小时」折线在该周断开
python3 - "$TMP/data.json" <<'PY'
import json, sys
weeks = ["2025-01-06", "2025-01-13", "2025-01-20", "2025-01-27", "2025-02-03"]
wall  = [13320, 35640, 36000, 367200, 0]
cost  = [7243, 6705, 4657, 9707, 642]
add   = [17000, 18000, 10000, 34000, 5000]
dele  = [693, 436, 736, 627, 5000]          # 末周净增 0，配合 wall=0 一起验缺口
weekly = {}
for i, k in enumerate(weeks):
    weekly[k] = {"iss_open": 10 + i, "iss_closed": 8 + i, "pr_merged": 5 + i,
                 "add": add[i], "del": dele[i], "commits": 3, "pr_open": 4,
                 "comments": 100 + i, "human": 10 + i, "bot": 90 + i, "codex": 1,
                 "cost": cost[i], "wall": wall[i], "backlog": 40 + i,
                 "footers": 9, "cost_footers": 9, "outliers": 0, "out": 1000, "sess_med": 60}
json.dump({"weeks": weeks, "weekly": weekly,
           "target_week": {"start": weeks[-1], "end": "2025-02-09"},
           "detail": [], "loose_prs": [], "generated_at": "2025-02-10T09:00:00"},
          open(sys.argv[1], "w"))
PY

python3 "$RENDER" --data "$TMP/data.json" --out-dir "$TMP" \
    --asset-url-base "https://example.invalid/a" --rev "test" >/dev/null 2>"$TMP/err.txt" \
    || { echo "render.py 跑挂了："; cat "$TMP/err.txt"; exit 1; }

# 断言全部走这个 helper：按 class="ttl" 把 SVG 切成面板，逐块查
q() { python3 - "$TMP" "$@" <<'PY'
import re, sys
TMP = sys.argv[1]; expr = sys.argv[2]

def read(name):
    return open(f"{TMP}/{name}.html").read()

def _legoverlap(s):
    """图例是否有叠字：同一面板（按 y 分组）内按 x 排序，相邻两条的间距必须放得下
    前一条的文字。宽度用独立的保守估计（中文 11px / 其他 6px），不复用 render.py
    自己的算法——否则测的是「自己等于自己」。"""
    rows = {}
    for x, y, t in re.findall(
            r'<text x="([\d.]+)" y="([\d.-]+)" class="leg">([^<]*)<', s):
        rows.setdefault(y, []).append((float(x), t))
    bad = 0
    for row in rows.values():
        row.sort()
        for (x1, t1), (x2, _t2) in zip(row, row[1:]):
            if x2 - x1 < sum(11 if ord(c) > 0x2E80 else 6 for c in t1):
                bad += 1
    return bad

def panels(name):
    """按面板标题切片，返回 [(标题, 该面板的 SVG 片段), ...]"""
    s = read(name)
    ts = [m.start() for m in re.finditer(r'<text x="\d+" y="\d+" class="ttl">', s)]
    ts.append(s.index("</svg>"))
    out = []
    for i in range(len(ts) - 1):
        seg = s[ts[i]:ts[i + 1]]
        out.append((re.search(r'class="ttl">([^<]*)<', seg).group(1), seg))
    return out

def titles(name):      return [t for t, _ in panels(name)]
def seg(name, i):      return panels(name)[i][1]
def bartops(s):        return re.findall(r'class="val"[^>]*>([^<]*)<', s)
def axis(s):           return re.findall(r'class="ax" text-anchor="end">([^<]*)<', s)
def dots(s):           return len(re.findall(r'<circle ', s))
def legends(s):        return re.findall(r'class="leg">([^<]*)<', s)
def height(name):      return re.search(r'<svg width="\d+" height="(\d+)"', read(name)).group(1)
def legoverlap(name):
    return _legoverlap(read(name))

print(eval(expr))
PY
}

echo "— 面板顺序（Q2=A：工时夹在讨论轮数和花销之间）"
chk "投入面三块面板，顺序为 讨论轮数 → AI 投入时间 → 花销" \
    "$(q '"|".join(t.split("：")[0] for t in titles("effort"))')" "讨论轮数|AI 投入时间|花销（美元）"

echo
echo "— 秒 → 小时的换算与格式（只作用于工时那条 series）"
chk "3h42m 显示成 3.7h"     "$(q 'bartops(seg("effort",1))[0]')" "3.7h"
chk "9h54m 显示成 9.9h"     "$(q 'bartops(seg("effort",1))[1]')" "9.9h"
chk "正好 10h 显示成 10h"   "$(q 'bartops(seg("effort",1))[2]')" "10h"
chk "102h 显示成 102h"      "$(q 'bartops(seg("effort",1))[3]')" "102h"

echo
echo "— 零工时那一周"
chk "5 周只有 4 个柱顶标签（零工时不打标签）" "$(q 'len(bartops(seg("effort",1)))')" "4"
chk "左轴最低刻度带单位，是 0h"               "$(q 'axis(seg("effort",1))[0]')" "0h"
chk "「行/小时」折线在零工时那周断开（4 个点不是 5 个）" \
    "$(q 'dots(seg("effort",1))')" "4"
chk "工时面板有「行 / 墙上小时」这条辅助折线（Q1=C）" \
    "$(q '"行 / 墙上小时" in legends(seg("effort",1))')" "True"

echo
echo "— 图上的口径措辞必须跟柱子画的东西一致（#932 review 第 6 轮）"
# 柱子画的是墙上时长，它**包含**等待。图上写「不含等人回话的空档」而正文写「包含等待」，
# 读图的人只会记住图——这张图是直接贴进周报的。
chk "工时面板标题点明「含等待」"      "$(q '"含等待" in titles("effort")[1]')" "True"
chk "标题不再自称「实际干活的小时数」" "$(q '"实际干活" in titles("effort")[1]')" "False"
chk "副标题不再说「不含等人回话的空档」" \
    "$(q '"不含等人回话的空档" in read("effort")')" "False"
chk "柱子的图例写明含等待"            "$(q '"墙上时长（含等待）" in legends(seg("effort",1))')" "True"
chk "没有 work 数据时不画模型+工具折线" \
    "$(q 'any("模型 + 工具" in t for t in legends(seg("effort",1)))')" "False"
chk "图例不叠字（中文按中文宽度排版，不是按拉丁宽度）" \
    "$(q 'legoverlap("effort")')" "0"

echo
echo "— 默认格式器不受影响：其他 series 一个字符都不许变"
chk "花销面板柱顶仍是全局格式 7.2k" "$(q 'bartops(seg("effort",2))[0]')" "7.2k"
chk "花销面板柱顶没有一个带 h"      "$(q 'any(v.endswith("h") for v in bartops(seg("effort",2)))')" "False"
chk "讨论轮数面板柱顶没有一个带 h"  "$(q 'any(v.endswith("h") for v in bartops(seg("effort",0)))')" "False"

echo
echo "— 交付面不回归"
chk "交付面仍是两块面板"        "$(q 'len(titles("delivery"))')" "2"
chk "交付面页高仍是 680"        "$(q 'height("delivery")')" "680"
chk "交付面柱顶没有一个带 h"    "$(q 'any(v.endswith("h") for p in panels("delivery") for v in bartops(p[1]))')" "False"

echo
echo "— 版面"
chk "投入面页高 1020（三块面板 × 340）" "$(q 'height("effort")')" "1020"


echo
echo "— 口径切换竖线（GigleTutor-Web#932 review 第 5 轮）"
# 切换周左右两侧的时长 / 成本不是同一把尺子量的，折线连过去会被读成趋势变化，
# 所以要在图上标一条竖线。没有切换周时**一条都不能画**。
chk "没有 codex 记账的周 → 投入面不画竖线" \
    "$(q 'read("effort").count("口径切换")')" "0"

# 同一份 fixture，改成第 3 周起有 codex 记账
python3 - "$TMP/data.json" "$TMP/sw.json" <<'INNER'
import json, sys
D = json.load(open(sys.argv[1]))
for i, k in enumerate(D["weeks"]):
    D["weekly"][k]["records_codex"] = 2 if i >= 2 else 0
    D["weekly"][k]["work"] = D["weekly"][k]["wall"] * 0.8
    D["weekly"][k]["work_records"] = 3
# 切换周由采集侧给（collect.py 的 switch_week）；图不自己在窗口里找，否则会随窗口漂移
D["switch_week"] = D["weeks"][2]
json.dump(D, open(sys.argv[2], "w"))
INNER

mkdir -p "$TMP/sw"
python3 "$RENDER" --data "$TMP/sw.json" --out-dir "$TMP/sw" \
    --asset-url-base "https://example.invalid/a" --rev "test" >/dev/null 2>"$TMP/err2.txt" \
    || { echo "render.py 跑挂了："; cat "$TMP/err2.txt"; exit 1; }

swleg() { python3 - "$TMP/sw/effort.html" <<'INNER4'
import re, sys
rows = {}
for x, y, t in re.findall(r'<text x="([\d.]+)" y="([\d.-]+)" class="leg">([^<]*)<',
                          open(sys.argv[1]).read()):
    rows.setdefault(y, []).append((float(x), t))
bad = 0
for row in rows.values():
    row.sort()
    for (x1, t1), (x2, _t2) in zip(row, row[1:]):
        if x2 - x1 < sum(11 if ord(c) > 0x2E80 else 6 for c in t1):
            bad += 1
print(bad)
INNER4
}

sw() { python3 - "$TMP/sw/$1.html" "$2" <<'INNER2'
import re, sys
s = open(sys.argv[1]).read()
print(eval(sys.argv[2]))
INNER2
}

chk "有切换周 → 投入面画 2 条（工时面板 + 花销面板）" \
    "$(sw effort 's.count("口径切换")')" "2"
chk "交付面不画（issue / PR / 代码行不受口径影响）" \
    "$(sw delivery 's.count("口径切换")')" "0"
chk "竖线画成红色虚线" \
    "$(sw effort 'len(re.findall(r"stroke-dasharray=.4 3.", s))')" "2"
chk "switch_week 不在窗口里 → 一条都不画（不拿窗口里第一条 codex 记录顶上）" \
    "$(python3 - "$TMP" <<'INNER3'
import json, subprocess, sys, os, re
TMP = sys.argv[1]
D = json.load(open(f"{TMP}/sw.json"))
D["switch_week"] = "2024-12-30"          # 真实切换在窗口之前
json.dump(D, open(f"{TMP}/sw2.json", "w"))
os.makedirs(f"{TMP}/sw2", exist_ok=True)
subprocess.run([sys.executable, os.environ["RENDER"], "--data", f"{TMP}/sw2.json",
                "--out-dir", f"{TMP}/sw2", "--asset-url-base", "x", "--rev", "t"],
               check=True, stdout=subprocess.DEVNULL)
print(open(f"{TMP}/sw2/effort.html").read().count("口径切换"))
INNER3
)" "0"

echo
echo "— 有 work 数据时并列画出「模型 + 工具」"
chk "画出模型 + 工具折线（不含等待的那条）" \
    "$(sw effort 'any("模型 + 工具" in t for t in re.findall(r"class=.leg.>([^<]*)<", s))')" "True"
chk "副标题点明那条不含等待" \
    "$(sw effort '"不含等待" in s')" "True"
chk "三条图例并排时仍不叠字" "$(swleg)" "0"

echo
echo "通过 $pass / 失败 $fail"
[ "$fail" -eq 0 ]
