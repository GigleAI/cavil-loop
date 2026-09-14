#!/usr/bin/env bash
# 「模型 + 工具」时长：判会话跟窗口有没有交集，要用会话自己的时间范围
# （scripts/weekly-report/worktime.py）。
#
# 跑法：bash tests/weekly-report-worktime-window.test.sh
# 依赖：python3。造临时 HOME + 假 gh，跑真实 collect.py，断言**采集输出**的
# work / work_records / work_missing，不只看内部函数返回值。
#
# 为什么要有这个文件（GigleTutor-Web#932 交叉 review）：
# claude 的累计快照（cost-state）是**派工结束之后**才落盘的。一个**新会话的第一次派工**
# ——10:00 开工、10:10 发完工评论、10:10:30 才落下第一份快照——原来用
# `seq[0][0] > end`（第一份**快照**的时刻）判交集，这个条件成立，整个会话被跳过：
# 日志在、累计值也在，却被记成 `work_missing`，合计系统性漏算。
# 改成用会话自己的首 / 末记录时刻判交集；**真正晚于窗口才开始**的会话仍然挡在外面。
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
COLLECT="$REPO_DIR/scripts/weekly-report/collect.py"

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0
chk() { if [ "$2" = "$3" ]; then echo "  ✅ $1"; pass=$((pass+1)); else echo "  ❌ $1 (期望 '$3'，实得 '$2')"; fail=$((fail+1)); fi; }

WT_BASE="$TMP/wt"; WT_PREFIX="tutor"
WT="$WT_BASE/$WT_PREFIX-10"
ENC="$(printf '%s' "$WT" | tr '/' '-')"
PROJ="$TMP/.claude/projects/$ENC"
mkdir -p "$PROJ" "$WT"

# 派工窗口：2026-09-07（周一）10:00 ~ 10:10 +08:00，墙上 600 秒
cat > "$TMP/comments.json" <<JSON
[ {"id":1,"issue_url":"https://api.github.com/repos/acme/widget/issues/10",
   "user":{"login":"acme-bot"},
   "created_at":"2026-09-07T02:10:00Z","updated_at":"2026-09-07T02:10:00Z",
   "body":"干完了。\\n\\n<!-- agent-metrics agent=claude wt=10 start=2026-09-07T10:00:00+08:00 end=2026-09-07T10:10:00+08:00 wall_secs=600 in=1 out=1 cache_r=0 cache_w=0 cost_usd=10.00 -->"} ]
JSON
cat > "$TMP/issues.json" <<'JSON'
[ {"number":10,"title":"承载记账的 issue","state":"open","labels":[],
   "created_at":"2026-08-01T02:00:00Z","closed_at":null} ]
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

# 写一份会话 jsonl：ts... 是带 timestamp 的普通记录，snap... 是 cost-state 累计快照
ts()   { printf '{"type":"assistant","timestamp":"%s"}\n' "$1"; }
snap() { printf '{"type":"cost-state","totalAPIDuration":%s,"totalToolDuration":%s}\n' "$1" "$2"; }

run() {
    rm -rf "$PROJ"; mkdir -p "$PROJ"
    cat > "$PROJ/$1.jsonl"
    HOME="$TMP" python3 "$COLLECT" --repo acme/widget --out "$TMP/d.json" --weeks 1 \
        --week-of 2026-09-07 --worktree-base "$WT_BASE" --session-prefix "$WT_PREFIX" \
        >/dev/null 2>"$TMP/err.log" \
        || { echo "collect.py 跑挂了："; cat "$TMP/err.log"; exit 1; }
}
q() { python3 -c "
import json; w=json.load(open('$TMP/d.json'))['weekly']['2026-09-07']
v=w['$1']; print(int(v) if abs(v-round(v))<1e-9 else v)"; }

echo "— 新会话的第一次派工：第一份快照落在完工评论之后 —"
# 会话 10:00 开始，10:10:30 才落第一份快照（120s API + 180s 工具 = 300 秒）
run session-new <<EOF
$(ts 2026-09-07T02:00:00Z)
$(ts 2026-09-07T02:10:30Z)
$(snap 120000 180000)
EOF
chk "算得出来，不再记成缺失"         "$(q work_records)" "1"
chk "work_missing 是 0"              "$(q work_missing)" "0"
chk "时长 = 120s + 180s = 300 秒"     "$(q work)"         "300"

echo
echo "— 真正晚于窗口才开始的会话：仍然不认领 —"
# 会话 11:00 才开始（窗口 10:10 就结束了）
run session-later <<EOF
$(ts 2026-09-07T03:00:00Z)
$(ts 2026-09-07T03:10:30Z)
$(snap 999000 999000)
EOF
chk "不认领 → 记成缺失"              "$(q work_missing)" "1"
chk "work_records 是 0"              "$(q work_records)" "0"
chk "时长为 0"                       "$(q work)"         "0"

echo
echo "— 同一会话的后续派工：按基线差分，不把前面那段算进来 —"
# 09:50 有一份快照（基线 100s+100s），窗口内干活，10:10:30 落第二份（400s+400s）
run session-cont <<EOF
$(ts 2026-09-07T01:50:00Z)
$(snap 100000 100000)
$(ts 2026-09-07T02:00:00Z)
$(ts 2026-09-07T02:10:30Z)
$(snap 400000 400000)
EOF
chk "算得出来"                       "$(q work_records)" "1"
chk "差分 = (400-100)+(400-100) = 600 秒" "$(q work)"     "600"

echo
echo "— 会话整段都在窗口之前：不认领 —"
run session-before <<EOF
$(ts 2026-09-06T02:00:00Z)
$(ts 2026-09-06T02:10:30Z)
$(snap 500000 500000)
EOF
chk "不认领 → 记成缺失"              "$(q work_missing)" "1"
chk "时长为 0"                       "$(q work)"         "0"

echo
echo "通过 $pass / 失败 $fail"
[ "$fail" -eq 0 ]
