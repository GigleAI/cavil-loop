#!/usr/bin/env bash
# 一次派工发多条评论时，采集器只能按最终那条累计记录入账一次。
#
# 跑法：bash tests/weekly-report-dispatch-dedup.test.sh
# 依赖：python3。自造假 `gh` 喂 fixture，不碰网络。
#
# 为什么要有这个文件：
# 记账行里的 wall_secs / 金额 / token 都是**从这次派工开始起的累计值**，而 end 是
# 「写这条评论的时刻」。同一次派工发多条评论（先在 issue 回一条、稍后在关联 PR 再回
# 一条，或先发验证再发收尾），每条都是一个更大的累计快照。
#   · 逐条求和 → 前半段被重复算
#   · 身份里带上 end → 每条都成了「不同的派工」，同样重复算
#   · 身份去掉 end 但保留最早那条 → 漏掉后半段
# 三种都错，而且都只会让数字悄悄变大 / 变小，不会有任何报错。
#
# 本测试用**派工模板里那段 printf 原样生成 footer**（不是手写简写 fixture），
# 再走真实 collect.py 汇总，覆盖：不同 end、跨 issue/PR、不同派工不被误合并。
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
COLLECT="$REPO_DIR/scripts/weekly-report/collect.py"

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0
chk() { if [ "$2" = "$3" ]; then echo "  ✅ $1"; pass=$((pass+1)); else echo "  ❌ $1 (期望 '$3'，实得 '$2')"; fail=$((fail+1)); fi; }

# 派工模板里生成 footer 的那两行 printf，**原样照搬**。模板改了这里要同步。
emit_footer() {
    local start_ts="$1" end_ts="$2" wall="$3" cost="$4" wt="$5" agent="${6:-claude}"
    local hms="$((wall / 60))m $((wall % 60))s"
    printf '\n\n---\n⏱️ 开始 %s · 完工 %s · 耗时 %s\ntoken %s\n' \
        "$start_ts" "${end_ts:11:8}" "$hms" "1 input, 1 output (\$$cost)"
    printf '<!-- agent-metrics agent=%s wt=%s start=%s end=%s wall_secs=%s %s -->\n' \
        "$agent" "$wt" "$(date -d "$start_ts" --iso-8601=seconds)" \
        "$(date -d "$end_ts" --iso-8601=seconds)" "$wall" \
        "in=1 out=1 cache_r=0 cache_w=0 cost_usd=$cost"
}

# 派工 A：start 10:00，三条累计快照（跨 issue #10 与 PR #11），最终 1200 秒 / $20
A_START="2025-01-08 10:00:00"
a1=$(emit_footer "$A_START" "2025-01-08 10:05:00"  300  5 10)
a2=$(emit_footer "$A_START" "2025-01-08 10:12:00"  720 12 10)
a3=$(emit_footer "$A_START" "2025-01-08 10:20:00" 1200 20 10)
# 派工 B：同一 worktree 的另一次派工，start 不同 → 必须单独入账
B_START="2025-01-08 14:00:00"
b1=$(emit_footer "$B_START" "2025-01-08 14:07:00"  420  7 10)

py_json() { python3 -c "import json,sys; print(json.dumps(sys.stdin.read()))"; }
A1=$(printf '在 issue 上回一条%s' "$a1" | py_json)
A2=$(printf '在 PR 上回一条%s'    "$a2" | py_json)
A3=$(printf '收尾再回一条%s'      "$a3" | py_json)
B1=$(printf '第二次派工%s'        "$b1" | py_json)

W_OUT="2024-12-31T02:00:00Z"
cat > "$TMP/issues.json" <<JSON
[
 {"number":10,"title":"承载两次派工的 issue","state":"open","labels":[],
  "created_at":"$W_OUT","closed_at":null},
 {"number":11,"title":"fix: 修一修（#10）","state":"open","labels":[],
  "created_at":"$W_OUT","closed_at":null,"pull_request":{"merged_at":null}}
]
JSON
cat > "$TMP/comments.json" <<JSON
[
 {"id":1,"issue_url":"https://api.github.com/repos/acme/widget/issues/10",
  "user":{"login":"acme-bot"},"created_at":"2025-01-08T02:05:00Z","body":$A1},
 {"id":2,"issue_url":"https://api.github.com/repos/acme/widget/issues/11",
  "user":{"login":"acme-bot"},"created_at":"2025-01-08T02:12:00Z","body":$A2},
 {"id":3,"issue_url":"https://api.github.com/repos/acme/widget/issues/11",
  "user":{"login":"acme-bot"},"created_at":"2025-01-08T02:20:00Z","body":$A3},
 {"id":4,"issue_url":"https://api.github.com/repos/acme/widget/issues/11",
  "user":{"login":"acme-bot"},"created_at":"2025-01-08T06:07:00Z","body":$B1}
]
JSON
cat > "$TMP/pulls.json" <<'JSON'
[ {"number":11,"title":"fix: 修一修（#10）","body":"Closes #10"} ]
JSON

mkdir -p "$TMP/bin"
cat > "$TMP/bin/gh" <<SH
#!/usr/bin/env bash
for a in "\$@"; do
  case "\$a" in
    *"/issues/comments"*) cat "$TMP/comments.json"; exit 0 ;;
    *"/pulls?"*)          cat "$TMP/pulls.json";    exit 0 ;;
    *"/issues?"*)         cat "$TMP/issues.json";   exit 0 ;;
  esac
done
echo "[]"
SH
chmod +x "$TMP/bin/gh"; export PATH="$TMP/bin:$PATH"

cd "$TMP"
python3 "$COLLECT" --repo acme/widget --out "$TMP/data.json" --weeks 1 --week-of 2025-01-06 \
    >/dev/null 2>"$TMP/err.log" || { echo "collect.py 跑挂了："; cat "$TMP/err.log"; exit 1; }

q() { python3 -c "
import json
D=json.load(open('$TMP/data.json'))
w=D['weekly']['2025-01-06']
def one(n):
    r=[d for d in D['detail'] if d['num']==n]
    return r[0] if r else {}
try:
    $1
except Exception as e:
    print('')
"; }

chk "两次派工 → 只入账 2 条记账记录（不是 4 条）"        "$(q "print(int(w['records']))")" "2"
chk "被折叠的累计快照记 2 条"                            "$(q "print(int(w['dupes']))")"   "2"
chk "墙上时长 = 派工A 最终 1200 + 派工B 420，不是逐条求和" "$(q "print(int(w['wall']))")"    "1620"
chk "成本 = 20 + 7，不是 5+12+20+7"                      "$(q "print(round(w['cost']))")"  "27"
chk "轮数仍按全部评论算（4 条）"                          "$(q "print(int(one(10)['rounds']))")" "4"
chk "issue #10 的墙上时长同样只算最终累计"                "$(q "print(int(one(10)['wall']))")"   "1620"

echo
echo "通过 $pass / 失败 $fail"
[ "$fail" -eq 0 ]
