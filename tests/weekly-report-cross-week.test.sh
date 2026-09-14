#!/usr/bin/env bash
# 跨周派工按**开工那一周**入账（scripts/weekly-report/collect.py）。
#
# 跑法：bash tests/weekly-report-cross-week.test.sh
# 依赖：python3。假 `gh` 真的按 `since` 过滤，跑真实 collect.py。
#
# 为什么要有这个文件（GigleTutor-Web#932 交叉 review）：
# 一次派工完全可能跨周——周日 23:50 开工、周一 00:05 才发最终那条累计评论（模板允许）。
# 原来按「最终那条评论所在的周」入账，于是**同一份固定数据，报告目标周往后滚一格，
# 上一周已记的账就整条搬走、旧周被清零**：
#   目标周 2025-01-06（窗口 1 周）→ 2025-01-06 拿到 300 秒 / $5（只看得到中途快照）
#   目标周 2025-01-13（窗口 2 周）→ 2025-01-06 变成 0，900 秒 / $15 跑到新周
# 这直接违反「同一个历史周的数值不随展示窗口位置改变」。
#
# 现在按 `start`（开工时刻）归账，与展示窗口无关；认领阶段**不按评论所在周过滤**，
# 否则上一周只拿得到中途那个较小的快照。注意**不是**把周加进去重键再逐周相加——
# 那会把 900 秒 / $15 错算成 1200 秒 / $20（300 + 900）。
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
COLLECT="$REPO_DIR/scripts/weekly-report/collect.py"

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0
chk() { if [ "$2" = "$3" ]; then echo "  ✅ $1"; pass=$((pass+1)); else echo "  ❌ $1 (期望 '$3'，实得 '$2')"; fail=$((fail+1)); fi; }

# 同一次派工（wt=10，start 2025-01-12 23:50 +08:00 → 开工周 2025-01-06）：
#   ① 周日 23:55 发中途快照 wall=300  / $5   （创建 2025-01-12T15:55:00Z）
#   ② 周一 00:05 发最终快照 wall=900  / $15  （创建 2025-01-12T16:05:00Z，属于 2025-01-13 周）
# ② 落在 issue #11 上，顺带覆盖「跨 issue / PR」。
python3 - "$TMP/all.json" <<'PY'
import json, sys
def row(cid, issue, utc, end, wall, cost):
    body = ("干完了。\n\n<!-- agent-metrics agent=claude wt=10 "
            "start=2025-01-12T23:50:00+08:00 end=%s "
            "wall_secs=%d in=1 out=1 cache_r=0 cache_w=0 cost_usd=%s -->" % (end, wall, cost))
    return {"id": cid,
            "issue_url": "https://api.github.com/repos/acme/widget/issues/%d" % issue,
            "user": {"login": "acme-bot"}, "created_at": utc, "updated_at": utc, "body": body}
json.dump([row(1, 10, "2025-01-12T15:55:00Z", "2025-01-12T23:55:00+08:00", 300, "5.00"),
           row(2, 11, "2025-01-12T16:05:00Z", "2025-01-13T00:05:00+08:00", 900, "15.00")],
          open(sys.argv[1], "w"))
PY

cat > "$TMP/issues.json" <<'JSON'
[ {"number":10,"title":"开工那个 issue","state":"open","labels":[],
   "created_at":"2024-11-01T02:00:00Z","closed_at":null},
  {"number":11,"title":"fix: 收尾（#10）","state":"open","labels":[],
   "created_at":"2024-11-01T02:00:00Z","closed_at":null,"pull_request":{"merged_at":null}} ]
JSON
cat > "$TMP/pulls.json" <<'JSON'
[ {"number":11,"title":"fix: 收尾（#10）","body":"Closes #10"} ]
JSON

mkdir -p "$TMP/bin"
cat > "$TMP/bin/gh" <<SHIM
#!/usr/bin/env bash
for a in "\$@"; do
  case "\$a" in
    *"/issues/comments"*)
        python3 - "$TMP/all.json" "\$a" <<'PY'
import json, re, sys
rows = json.load(open(sys.argv[1]))
m = re.search(r"since=([0-9T:Z+-]+)", sys.argv[2])
if m:
    rows = [r for r in rows if r["updated_at"] > m.group(1)]
print(json.dumps(rows))
PY
        exit 0 ;;
    *"/pulls?"*)  cat "$TMP/pulls.json";  exit 0 ;;
    *"/issues?"*) cat "$TMP/issues.json"; exit 0 ;;
  esac
done
echo "[]"
SHIM
chmod +x "$TMP/bin/gh"; export PATH="$TMP/bin:$PATH"
cd "$TMP"

run() {   # target weeks
    python3 "$COLLECT" --repo acme/widget --out "$TMP/d.json" --weeks "$2" \
        --week-of "$1" >/dev/null 2>"$TMP/err.log" \
        || { echo "collect.py 跑挂了："; cat "$TMP/err.log"; exit 1; }
}
q() { python3 -c "
import json
D=json.load(open('$TMP/d.json')); w=D['weekly'].get('$1')
print('missing' if w is None else int(w['$2']))"; }
tot() { python3 -c "
import json
D=json.load(open('$TMP/d.json'))
print(int(sum(D['weekly'][k]['$1'] for k in D['weeks'])))"; }

echo "— 目标周 = 开工那一周（窗口只有 1 周）—"
run 2025-01-06 1
chk "开工周入账 1 条"                  "$(q 2025-01-06 records)" "1"
chk "拿到的是**最终**累计快照 900 秒"  "$(q 2025-01-06 wall)"    "900"
chk "金额也是最终的 \$15"              "$(q 2025-01-06 cost)"    "15"
chk "折叠掉 1 条中途快照"              "$(q 2025-01-06 dupes)"   "1"
chk "讨论条数只算窗口内那 1 条"        "$(q 2025-01-06 comments)" "1"

echo
echo "— 目标周前滚一格：上一周的账**不许**被搬走 —"
run 2025-01-13 2
chk "开工周仍是 1 条"                  "$(q 2025-01-06 records)" "1"
chk "开工周仍是 900 秒"                "$(q 2025-01-06 wall)"    "900"
chk "开工周仍是 \$15"                  "$(q 2025-01-06 cost)"    "15"
chk "下一周不重复入账"                 "$(q 2025-01-13 records)" "0"
chk "全窗口合计仍是 900 秒（没有 300+900）" "$(tot wall)" "900"
chk "全窗口合计仍是 \$15"              "$(tot cost)"  "15"

echo
echo "— 再拉宽窗口：数值一律不变 —"
for wk in 5 10; do
    run 2025-01-13 "$wk"
    chk "--weeks $wk：开工周 900 秒 / \$15" \
        "$(q 2025-01-06 wall)/$(q 2025-01-06 cost)" "900/15"
    chk "--weeks $wk：全窗口合计不重复" "$(tot wall)" "900"
done

echo
echo "— 开工周落在窗口之前：不入账，也不报错 —"
run 2025-01-20 1
chk "窗口只有 2025-01-20 → 该派工不入账" "$(q 2025-01-20 records)" "0"

echo
echo "— 只在下周发唯一那条完工评论：明细里不能整条消失 —"
# 跨周派工按开工周入账，可那一周它一条评论都没有 → rounds=0。
# 报告的明细过滤原来只看 rounds>0，于是这条工作已经进了当周总时长 / 成本，
# 却从「上周有推进但没关的 issue」里整条不见（GitHub#932 交叉 review）。
# 这里**必须真的跑 report.py 看最终 markdown**——只断言 collect 的 JSON 会正好绕过这个缺口。

REPORT="$REPO_DIR/scripts/weekly-report/report.py"

# 三个承载对象：#10 纯 issue、#11 关联 #10 的 PR、#12 没有关联 issue 的 PR
cat > "$TMP/issues.json" <<'JSON'
[ {"number":10,"title":"跨周开工的 issue","state":"open","labels":[],
   "created_at":"2024-11-01T02:00:00Z","closed_at":null},
  {"number":11,"title":"fix: 收尾（#10）","state":"open","labels":[],
   "created_at":"2024-11-01T02:00:00Z","closed_at":null,"pull_request":{"merged_at":null}},
  {"number":12,"title":"chore: 工具链改动","state":"open","labels":[],
   "created_at":"2024-11-01T02:00:00Z","closed_at":null,"pull_request":{"merged_at":null}} ]
JSON
cat > "$TMP/pulls.json" <<'JSON'
[ {"number":11,"title":"fix: 收尾（#10）","body":"Closes #10"},
  {"number":12,"title":"chore: 工具链改动","body":""} ]
JSON

# 只有一条评论：周一 00:05 发的**唯一**完工快照（没有周日那条中途评论 → 当周 rounds=0）
only_final() {   # issue_number
    python3 - "$TMP/all.json" "$1" <<'PY'
import json, sys
body = ("干完了。\n\n<!-- agent-metrics agent=claude wt=10 "
        "start=2025-01-12T23:50:00+08:00 end=2025-01-13T00:05:00+08:00 "
        "wall_secs=900 in=1 out=1 cache_r=0 cache_w=0 cost_usd=15.00 -->")
json.dump([{"id": 1,
            "issue_url": "https://api.github.com/repos/acme/widget/issues/%s" % sys.argv[2],
            "user": {"login": "acme-bot"},
            "created_at": "2025-01-12T16:05:00Z", "updated_at": "2025-01-12T16:05:00Z",
            "body": body}], open(sys.argv[1], "w"))
PY
}
gen_report() {
    run 2025-01-06 1
    python3 "$REPORT" --data "$TMP/d.json" --out "$TMP/r.md" \
        --asset-url-base x --rev y >/dev/null 2>&1 \
        || { echo "report.py 跑挂了"; exit 1; }
}
has() { grep -qF "$1" "$TMP/r.md" && echo yes || echo no; }

echo "  · 评论发在 issue #10 上"
only_final 10; gen_report
chk "当周总时长仍是 900 秒"                "$(q 2025-01-06 wall)" "900"
chk "当周讨论条数照实是 0"                 "$(q 2025-01-06 comments)" "0"
chk "明细里有 #10 这一行"                  "$(has '| #10 | 跨周开工的 issue |')" "yes"
chk "「有推进但没关的 issue」计 1 个"      "$(has '上周有推进但没关的 issue（1 个）')" "yes"
chk "轮数照实显示 0，不伪造"               "$(has '| 0（你 0） | 15m |')" "yes"

echo "  · 评论发在关联 PR #11 上（工作并进 issue #10）"
only_final 11; gen_report
chk "当周总时长仍是 900 秒"                "$(q 2025-01-06 wall)" "900"
chk "明细里仍是 #10 这一行"                "$(has '| #10 | 跨周开工的 issue |')" "yes"
chk "「有推进但没关的 issue」计 1 个"      "$(has '上周有推进但没关的 issue（1 个）')" "yes"

echo "  · 评论发在没有关联 issue 的 PR #12 上"
only_final 12; gen_report
chk "当周总时长仍是 900 秒"                "$(q 2025-01-06 wall)" "900"
chk "单列在「没有对应 issue 的 PR」里"     "$(has '上周没有对应 issue 的 PR（1 个）')" "yes"
chk "那一行确实是 #12"                     "$(has '| #12 | chore: 工具链改动 |')" "yes"
chk "不会同时混进 issue 明细"              "$(has '上周有推进但没关的 issue（0 个）')" "yes"

echo
echo "通过 $pass / 失败 $fail"
[ "$fail" -eq 0 ]
