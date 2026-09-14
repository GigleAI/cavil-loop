#!/usr/bin/env bash
# 拉评论的查询起点必须按**统计用的时区**换算成 UTC（scripts/weekly-report/collect.py）。
#
# 跑法：bash tests/weekly-report-window-boundary.test.sh
# 依赖：python3。假 `gh` **真的按 `since` 过滤** fixture（这点很关键，见下）。
#
# 为什么要有这个文件（GigleTutor-Web#932 交叉 review）：
# 报告按**北京时间**切周，而 GitHub 的 `since` 按 **UTC** 比较。原来直接拼
# `<北京周一>T00:00:00Z`，等于从北京时间周一 **08:00** 才开始取评论——那天
# 00:00–08:00 之间发出、之后又没被编辑过的评论整段拿不到。
# 后果不是少一点点：**同一个历史周的时长 / 金额会随展示窗口左移而变小**——
# 那一周还在窗口内部时取得到（since 更早），滚到最左端就少掉这 8 小时。
# 「逐周核对旧周数值」这条验收会直接被它砸掉。
#
# ⚠️ 其他几个采集测试的假 `gh` 对 comments 请求一律返回全部 fixture，**绕开了查询起点**，
# 挡不住这类问题。这里的假 `gh` 必须解析 `since=` 并照它过滤。
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
COLLECT="$REPO_DIR/scripts/weekly-report/collect.py"

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0
chk() { if [ "$2" = "$3" ]; then echo "  ✅ $1"; pass=$((pass+1)); else echo "  ❌ $1 (期望 '$3'，实得 '$2')"; fail=$((fail+1)); fi; }

# 目标周：2025-01-06（北京时间周一）。三条评论，都带机器记录 600 秒 / $10：
#   A 周一 01:00 +08:00 = 2025-01-05T17:00:00Z —— 旧实现漏掉的就是这一条
#   B 周一 00:00:00 +08:00 = 2025-01-05T16:00:00Z —— 正好压在边界上
#   C 上周日 23:59 +08:00 = 2025-01-05T15:59:00Z —— 不属于目标周，永远不该计入
python3 - "$TMP/all.json" <<'PY'
import json, sys
def row(cid, utc, hh):
    body = ("干完了。\n\n<!-- agent-metrics agent=claude wt=10 "
            "start=2025-01-06T%s:00:00+08:00 end=2025-01-06T%s:10:00+08:00 "
            "wall_secs=600 in=1 out=1 cache_r=0 cache_w=0 cost_usd=10.00 -->" % (hh, hh))
    return {"id": cid, "issue_url": "https://api.github.com/repos/acme/widget/issues/10",
            "user": {"login": "acme-bot"},
            "created_at": utc, "updated_at": utc, "body": body}
json.dump([row(1, "2025-01-05T17:00:00Z", "01"),     # A
           row(2, "2025-01-05T16:00:00Z", "02"),     # B（边界）
           row(3, "2025-01-05T15:59:00Z", "03")],    # C（上一周）
          open(sys.argv[1], "w"))
PY

cat > "$TMP/issues.json" <<'JSON'
[ {"number":10,"title":"承载记账的 issue","state":"open","labels":[],
   "created_at":"2024-11-01T02:00:00Z","closed_at":null} ]
JSON
echo "[]" > "$TMP/pulls.json"

# 假 gh：**按 since 过滤**，并把本次查询记到 query.log
mkdir -p "$TMP/bin"
cat > "$TMP/bin/gh" <<SHIM
#!/usr/bin/env bash
for a in "\$@"; do
  case "\$a" in
    *"/issues/comments"*)
        printf '%s\n' "\$a" >> "$TMP/query.log"
        python3 - "$TMP/all.json" "\$a" <<'PY'
import json, re, sys
rows = json.load(open(sys.argv[1]))
m = re.search(r"since=([0-9T:Z+-]+)", sys.argv[2])
if m:
    # GitHub 的 since 语义是「**晚于**这个时刻」（严格大于），照此过滤
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

run() {   # weeks
    : > "$TMP/query.log"
    python3 "$COLLECT" --repo acme/widget --out "$TMP/d.json" --weeks "$1" \
        --week-of 2025-01-06 >/dev/null 2>"$TMP/err.log" \
        || { echo "collect.py 跑挂了："; cat "$TMP/err.log"; exit 1; }
}
q() { python3 -c "
import json; w=json.load(open('$TMP/d.json'))['weekly']['2025-01-06']
print(int(w['$1']))"; }

echo "— 目标周就是窗口最左端（旧实现在这里漏掉整整 8 小时）—"
run 1
chk "查询起点按北京时间周一换算成 UTC" \
    "$(grep -o 'since=[^&]*' "$TMP/query.log")" "since=2025-01-05T15:59:59Z"
chk "周一 01:00 与 00:00 两条都计入 → 2 条"  "$(q records)" "2"
chk "墙上时长 600 × 2"                        "$(q wall)"    "1200"
chk "金额 \$10 × 2"                           "$(q cost)"    "20"
chk "上一周那条不计入（金额覆盖仍是 2/2）"    "$(q cost_records)" "2"

echo
echo "— 同一个目标周挪到窗口内部：数字必须一模一样 —"
for wk in 2 5 10; do
    run "$wk"
    chk "--weeks $wk：记账条数不变"   "$(q records)" "2"
    chk "--weeks $wk：墙上时长不变"   "$(q wall)"    "1200"
    chk "--weeks $wk：金额不变"       "$(q cost)"    "20"
done

echo
echo "通过 $pass / 失败 $fail"
[ "$fail" -eq 0 ]
