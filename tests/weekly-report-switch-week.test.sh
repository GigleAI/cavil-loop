#!/usr/bin/env bash
# 口径切换那一周必须是**部署事实**，不能由展示窗口算出来（scripts/weekly-report/collect.py）。
#
# 跑法：bash tests/weekly-report-switch-week.test.sh
# 依赖：python3。自造假 `gh` 喂 fixture，跑真实 collect.py，不碰网络。
#
# 为什么要有这个文件（GigleTutor-Web#932 交叉 review 第 6 轮）：
# 原来是在当前 10 周窗口里现找「第一个有交叉 review 记账的周」当切换点。窗口每周往前
# 滚一格，真实切换周滚出去之后，窗口里第一个有记录的周就会被当成**新的**切换点——
# 同一份数据、只把窗口挪一周，报告里的切换日期就从 1/6 变成 1/13，图上的红线跟着漂。
# 它改的是「对历史数据口径的判断」，不是排版。
#
# 第二版加了「第一个有 codex 记账的周前面还得有一个没有的周」，**仍然不成立**：
# 切换之后某一周没有交叉 review 是再正常不过的事，空周证明不了部署时间。把切换后
# 2025-02-17 那周的 codex 记录删掉（只留 claude），真实边界滚出窗口后，2025-02-24
# 照样被标成新的切换周。
#
# 所以现在的规则很简单：**只认配置**。没配就返回 null——不知道就是不知道，报告不标
# 切换周、不画竖线、不出过渡期并列块，环比照常给；窗口里确实有交叉 review 记账却没配
# 时打一条 warn，报告的口径说明里也写明。
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
COLLECT="$REPO_DIR/scripts/weekly-report/collect.py"

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0
chk() { if [ "$2" = "$3" ]; then echo "  ✅ $1"; pass=$((pass+1)); else echo "  ❌ $1 (期望 '$3'，实得 '$2')"; fail=$((fail+1)); fi; }

# 15 周的评论：每周一条 claude 记账；**2025-02-10 那周起**每周再加一条 codex 记账。
# 真实切换点固定在 2025-02-10，与用哪个窗口去看无关。
# QUIET 那一周（可选）**切换之后却没有 codex 记账** —— 正常情形，用来钉住「空周不能
# 被当成新边界」。
SWITCH="2025-02-10"
mkcomments() {
python3 - "$TMP/comments.json" "$SWITCH" "${1:-}" <<'PY'
import datetime, json, sys
out, switch = sys.argv[1], datetime.date.fromisoformat(sys.argv[2])
quiet = datetime.date.fromisoformat(sys.argv[3]) if len(sys.argv) > 3 and sys.argv[3] else None
start = datetime.date(2025, 1, 6)
rows, cid = [], 0
for i in range(15):
    wk = start + datetime.timedelta(days=7 * i)
    agents = ["claude"] + (["codex"] if wk >= switch and wk != quiet else [])
    for j, ag in enumerate(agents):
        cid += 1
        st = datetime.datetime.combine(wk, datetime.time(10 + j)).isoformat() + "+08:00"
        en = datetime.datetime.combine(wk, datetime.time(10 + j, 10)).isoformat() + "+08:00"
        body = ("干完了。\n\n<!-- agent-metrics agent=%s wt=10 start=%s end=%s "
                "wall_secs=600 in=1 out=1 cache_r=0 cache_w=0 cost_usd=1 -->" % (ag, st, en))
        rows.append({"id": cid,
                     "issue_url": "https://api.github.com/repos/acme/widget/issues/10",
                     "user": {"login": "acme-bot"},
                     "created_at": datetime.datetime.combine(
                         wk, datetime.time(2 + j)).strftime("%Y-%m-%dT%H:%M:%SZ"),
                     "body": body})
json.dump(rows, open(out, "w"))
PY
}
mkcomments

cat > "$TMP/issues.json" <<'JSON'
[ {"number":10,"title":"承载记账的 issue","state":"open","labels":[],
   "created_at":"2024-12-31T02:00:00Z","closed_at":null} ]
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

# 跑一次采集，回显 switch_week
run() {
    local weekof="$1"; shift
    python3 "$COLLECT" --repo acme/widget --out "$TMP/d.json" --weeks 10 \
        --week-of "$weekof" "$@" >/dev/null 2>"$TMP/err.log" \
        || { echo "collect.py 跑挂了："; cat "$TMP/err.log"; exit 1; }
    python3 -c "
import json; D=json.load(open('$TMP/d.json'))
print(D.get('switch_week') or 'null')"
}

echo "— 没配置：一律 null，绝不从数据里猜 —"
chk "边界就在窗口里，也不猜"                 "$(run 2025-03-10)" "null"
chk "边界已滚出窗口 → null"                  "$(run 2025-04-21)" "null"
chk "再滚一周 → 仍是 null（不会每周往后漂）" "$(run 2025-04-28)" "null"
chk "整段窗口都在切换之前 → null"            "$(run 2025-02-03)" "null"

echo
echo "— 切换之后有一周没人做 review（正常情形）：空周不是新边界 —"
# 第二版规则真正翻车的地方：2025-02-17 那周只有 claude、没有 codex。真实切换仍是
# 2025-02-10，滚出窗口后「空周 → 有记录」被当成新边界，标成 2025-02-24。
mkcomments 2025-02-17
chk "切换后空周 + 边界已滚出 → 仍是 null，不标成 2025-02-24" "$(run 2025-04-21)" "null"
chk "再滚一周 → 仍是 null"                                   "$(run 2025-04-28)" "null"
chk "配了切换周就不受空周影响"        "$(run 2025-04-21 --switch-week "$SWITCH")" "$SWITCH"
mkcomments

echo
echo "— 配置里给了切换周：窗口怎么滚都用它 —"
chk "边界在窗口里时以配置为准"     "$(run 2025-03-10 --switch-week "$SWITCH")" "$SWITCH"
chk "边界滚出窗口后仍是同一天"     "$(run 2025-04-28 --switch-week "$SWITCH")" "$SWITCH"
chk "给那周里的任意一天也归到周一" "$(run 2025-04-28 --switch-week 2025-02-14)" "$SWITCH"
chk "整段窗口都在切换之前，配置照样生效" "$(run 2025-02-03 --switch-week "$SWITCH")" "$SWITCH"

echo
echo "— 没配置但窗口里已有交叉 review 记账 → 打 warn 提醒去配 —"
run 2025-03-10 >/dev/null
chk "stderr 里有提醒" "$(grep -c 'WEEKLY_REPORT_SWITCH_WEEK' "$TMP/err.log")" "1"

echo
echo "通过 $pass / 失败 $fail"
[ "$fail" -eq 0 ]
