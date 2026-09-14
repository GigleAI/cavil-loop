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
    local start_ts="$1" end_ts="$2" wall="$3" cost="$4" wt="$5" agent="${6:-claude}" out="${7:-1}"
    local hms="$((wall / 60))m $((wall % 60))s"
    # 可见记账行里的 token 是**给人看的舍入值**（1234 → 1.2k）；机器标记里才是精确值。
    local shown="$out"; [ "$out" -ge 1000 ] && shown="$(( out / 100 ))"; \
        [ "$out" -ge 1000 ] && shown="${shown:0:$(( ${#shown} - 1 ))}.${shown: -1}k"
    printf '\n\n---\n⏱️ 开始 %s · 完工 %s · 耗时 %s\ntoken %s\n' \
        "$start_ts" "${end_ts:11:8}" "$hms" "1 input, $shown output (\$$cost)"
    printf '<!-- agent-metrics agent=%s wt=%s start=%s end=%s wall_secs=%s %s -->\n' \
        "$agent" "$wt" "$(date -d "$start_ts" --iso-8601=seconds)" \
        "$(date -d "$end_ts" --iso-8601=seconds)" "$wall" \
        "in=1 out=$out cache_r=0 cache_w=0 cost_usd=$cost"
}

# 派工 A：start 10:00，三条累计快照（跨 issue #10 与 PR #11），最终 1200 秒 / $20
A_START="2025-01-08 10:00:00"
a1=$(emit_footer "$A_START" "2025-01-08 10:05:00"  300  5 10)
a2=$(emit_footer "$A_START" "2025-01-08 10:12:00"  720 12 10)
a3=$(emit_footer "$A_START" "2025-01-08 10:20:00" 1200 20 10)
# 派工 B：同一 worktree 的另一次派工，start 不同 → 必须单独入账
B_START="2025-01-08 14:00:00"
b1=$(emit_footer "$B_START" "2025-01-08 14:07:00"  420  7 10)

# 派工 C：**混合来源**。同一次派工里三条评论的身份来源各不相同——
#   ① 机器标记但省了 wt（走采集器传进来的 default_wt，那是**整数** issue 编号）
#   ② 机器标记带显式 wt（从文本解析出来，是**字符串**）
#   ③ 只有历史可见记账行、没有机器标记（同样走 default_wt）
# 身份类型不归一就成了 ('10', start) != (10, start)，三条各记一次、前面两段被重复累加。
C_START="2025-01-08 16:00:00"
# ① 省掉 wt 的机器标记（footer 正文照写，只是标记里不带 wt）
emit_footer_nowt() {
    local start_ts="$1" end_ts="$2" wall="$3" cost="$4"
    printf '\n\n---\n⏱️ 开始 %s · 完工 %s · 耗时 %sm %ss\ntoken %s\n' \
        "$start_ts" "${end_ts:11:8}" "$((wall / 60))" "$((wall % 60))" "1 input, 1 output (\$$cost)"
    printf '<!-- agent-metrics agent=claude start=%s end=%s wall_secs=%s %s -->\n' \
        "$(date -d "$start_ts" --iso-8601=seconds)" "$(date -d "$end_ts" --iso-8601=seconds)" \
        "$wall" "in=1 out=1 cache_r=0 cache_w=0 cost_usd=$cost"
}
# ③ 只有可见记账行、没有机器标记（历史形态）
emit_footer_legacy() {
    local start_ts="$1" end_ts="$2" wall="$3" cost="$4"
    printf '\n\n---\n⏱️ 开始 %s · 完工 %s · 耗时 %sm %ss\ntoken %s\n' \
        "$start_ts" "${end_ts:11:8}" "$((wall / 60))" "$((wall % 60))" "1 input, 1 output (\$$cost)"
}
c1=$(emit_footer_nowt   "$C_START" "2025-01-08 16:04:00"  240  4)
c2=$(emit_footer_legacy "$C_START" "2025-01-08 16:09:00"  540  9)
c3=$(emit_footer        "$C_START" "2025-01-08 16:15:00"  900 15 10)

# 派工 D：**来源资格 + token 来源**（GitHub#932 review 第 3 轮）。
#   ① 机器人真实记录：wall 600 / $10 / out 1234，正文里还顺手贴了一句 token 示例
#   ② 人（非机器人）把同一行机器记录复制进讨论当例子，wt / start 与 ① 相同、
#      end 更晚、数字更大 —— 它既不能自己入账，也不能因为 end 晚就顶掉 ①
D_START="2025-01-08 18:00:00"
d1=$(emit_footer "$D_START" "2025-01-08 18:10:00"  600 10 10 claude 1234)
d2=$(emit_footer "$D_START" "2025-01-08 18:30:00" 9999 999 10 claude 888888)

py_json() { python3 -c "import json,sys; print(json.dumps(sys.stdin.read()))"; }
A1=$(printf '在 issue 上回一条%s' "$a1" | py_json)
A2=$(printf '在 PR 上回一条%s'    "$a2" | py_json)
A3=$(printf '收尾再回一条%s'      "$a3" | py_json)
B1=$(printf '第二次派工%s'        "$b1" | py_json)
C1=$(printf '混合：标记省了 wt%s'  "$c1" | py_json)
C2=$(printf '混合：只有可见记账行%s' "$c2" | py_json)
C3=$(printf '混合：标记带显式 wt%s' "$c3" | py_json)
D1=$(printf '干完了。顺手贴个示例：token 1 input, 999k output ($500)%s' "$d1" | py_json)
D2=$(printf '我们的记账格式长这样，供参考：%s' "$d2" | py_json)

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
  "user":{"login":"acme-bot"},"created_at":"2025-01-08T06:07:00Z","body":$B1},
 {"id":5,"issue_url":"https://api.github.com/repos/acme/widget/issues/10",
  "user":{"login":"acme-bot"},"created_at":"2025-01-08T08:04:00Z","body":$C1},
 {"id":6,"issue_url":"https://api.github.com/repos/acme/widget/issues/11",
  "user":{"login":"acme-bot"},"created_at":"2025-01-08T08:09:00Z","body":$C2},
 {"id":7,"issue_url":"https://api.github.com/repos/acme/widget/issues/11",
  "user":{"login":"acme-bot"},"created_at":"2025-01-08T08:15:00Z","body":$C3},
 {"id":8,"issue_url":"https://api.github.com/repos/acme/widget/issues/11",
  "user":{"login":"acme-bot"},"created_at":"2025-01-08T10:10:00Z","body":$D1},
 {"id":9,"issue_url":"https://api.github.com/repos/acme/widget/issues/11",
  "user":{"login":"acme-user"},"created_at":"2025-01-08T10:30:00Z","body":$D2}
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

chk "四次派工 → 只入账 4 条记账记录（不是 9 条）"        "$(q "print(int(w['records']))")" "4"
chk "被折叠的累计快照记 4 条"                            "$(q "print(int(w['dupes']))")"   "4"
chk "墙上时长 = A 1200 + B 420 + C 900 + D 600"          "$(q "print(int(w['wall']))")"    "3120"
chk "成本 = 20 + 7 + 15 + 10，不是把每条快照都加上"       "$(q "print(round(w['cost']))")"  "52"
chk "人发的示例不作为记账来源（记账来源 8 条，不是 9 条）" "$(q "print(int(w['footers']))")" "8"
chk "人发的示例 end 更晚也顶不掉真实记录（D 仍是 600 秒 / \$10）" \
    "$(q "print(int(w['wall'])-2520, round(w['cost'])-42)")" "600 10"
chk "输出 token = 1+1+1+1234，正文示例与人发的示例都不算" "$(q "print(int(w['out']))")"     "1237"
chk "轮数仍按全部评论算（9 条）"                          "$(q "print(int(one(10)['rounds']))")" "9"
chk "人发的那条计入「人发的评论」（1 条）"                "$(q "print(int(one(10)['human']))")"  "1"
chk "issue #10 的墙上时长同样只算各次派工的最终累计"      "$(q "print(int(one(10)['wall']))")"   "3120"

echo
echo "通过 $pass / 失败 $fail"
[ "$fail" -eq 0 ]
