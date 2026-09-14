#!/usr/bin/env bash
# 从本机日志重算金额：什么时候重算、什么时候沿用原值、哪些能进「去重合计」。
#
# 跑法：bash tests/weekly-report-log-check.test.sh
# 依赖：python3 / jq。自造假 `gh` + 假 claude 日志，**走完整链路**
# record.extract → collect.main → report.py，断言一路到最终 markdown。
#
# 为什么要有这个文件（GigleTutor-Web#934）：
# 驱动写 footer 时看不见别的派工的窗口，跨派工的重叠只能在采集侧消解。这里钉住三件事：
#   · 有日志且通过检验才用重算值，否则沿用原记录值（Q5=B：门槛是「有没有日志」，不按周划线）
#   · 缺口要有**被别人认领走的调用**这种逐条证据，不能靠「窗口相交」推定
#   · **回退值与重算值不能直接相加** —— 两条重叠派工一条回退一条重算时，共用的那次调用
#     会被算两遍（真实 $2 被算成 $3）。含回退的重叠组整组单列、不进合计。
#
# ⚠️ 必须走采集层到最终 markdown：只断言中间状态（比如 log_check 的取值）会漏掉
#    「状态判对了、但合计照样把两边加起来」这类错。
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
COLLECT="$REPO_DIR/scripts/weekly-report/collect.py"
REPORT="$REPO_DIR/scripts/weekly-report/report.py"

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0
chk() { if [ "$2" = "$3" ]; then echo "  ✅ $1"; pass=$((pass+1)); else echo "  ❌ $1"; echo "       期望 $3"; echo "       实得 $2"; fail=$((fail+1)); fi; }

W=2025-01-06
WTBASE="$TMP/wt"; PREFIX="issue"
export CLAUDE_PROJECTS_DIR="$TMP/projects"
# 本机没有可反解的记账 → 价目走参照兜底，Opus 5 = in$5 / out$25 / cr$0.5 / 1h$10，结果确定
export XDG_CACHE_HOME="$TMP/cache"

# 一条派工的机器记录。$1 wt  $2 起 hh  $3 止 hh  $4 out token  $5 cost_usd
marker() {   # $6 可选：price_status（如 disputed:10.00），$7 可选：price_source
    printf '干完了。\n\n<!-- agent-metrics agent=claude wt=%s start=%sT%s:00+08:00 end=%sT%s:00+08:00 wall_secs=600 in=0 out=%s cache_r=0 cache_w=0 cost_usd=%s cost_state=full cost_unknown_tokens=0' \
        "$1" "$W" "$2" "$W" "$3" "$4" "$5"
    [ -n "${7:-}" ] && printf ' price_source=%s' "$7"
    [ -n "${6:-}" ] && printf ' price_status=%s' "$6"
    printf ' -->'
}
# 往某 worktree 的 claude 日志里写一次调用。$1 wt  $2 时刻 HH:MM  $3 out token  $4 reqid
call() {
    local enc; enc=$(printf '%s' "$WTBASE/$PREFIX-$1" | tr / -)
    mkdir -p "$CLAUDE_PROJECTS_DIR/$enc"
    printf '{"type":"assistant","timestamp":"%sT%s:00Z","requestId":"%s","message":{"model":"claude-opus-5","usage":{"input_tokens":0,"output_tokens":%s,"cache_read_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0}}}}\n' \
        "$W" "$(date -u -d "$W $2 +0800" +%H:%M)" "$4" "$3" >> "$CLAUDE_PROJECTS_DIR/$enc/s.jsonl"
}

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
py_json() { python3 -c "import json,sys; print(json.dumps(sys.stdin.read()))"; }

run() {
    local n=0 rows=()
    for body in "$@"; do
        n=$((n+1))
        rows+=("{\"id\":$n,\"issue_url\":\"https://api.github.com/repos/acme/widget/issues/10\",\"user\":{\"login\":\"acme-bot\"},\"created_at\":\"${W}T0${n}:30:00Z\",\"body\":$(printf '%s' "$body" | py_json)}")
    done
    printf '[%s]' "$(IFS=,; echo "${rows[*]}")" > "$TMP/comments.json"
    rm -rf "$XDG_CACHE_HOME"
    python3 "$COLLECT" --repo acme/widget --out "$TMP/d.json" --weeks 2 --week-of "$W" \
        --worktree-base "$WTBASE" --session-prefix "$PREFIX" >/dev/null 2>"$TMP/err.log" \
        || { echo "collect.py 跑挂了："; cat "$TMP/err.log"; exit 1; }
    python3 "$REPORT" --data "$TMP/d.json" --out "$TMP/r.md" --asset-url-base x --rev y >/dev/null 2>&1 \
        || { echo "report.py 跑挂了"; exit 1; }
}
q() { python3 -c "
import json; w=json.load(open('$TMP/d.json'))['weekly']['$W']
v=w.get('$1',0); print(int(v) if float(v)==int(v) else round(float(v),2))"; }

echo "── 1. 有日志且通过检验 → 用重算值 ──"
rm -rf "$CLAUDE_PROJECTS_DIR"
call 10 "10:05" 1000000 r1                         # 窗口内一次调用，out = 1,000,000
run "$(marker 10 '10:00' '10:10' 1000000 '999.00')"
chk "判为「按日志重算」"              "$(q src_recomputed)"        "1"
chk "没有沿用原值的"                  "$(q src_original)"          "0"
chk "金额来自重算（1e6 out × \$25/M = \$25），不是记录里的 999" "$(q cost)" "25"
chk "日志检验：未检出缺失"            "$(q log_no_shortfall_detected)" "1"
chk "该派工进入去重合计"              "$(q records_not_summable)"  "0"

echo "── 2. 日志被清理 → 沿用原记录值 ──"
rm -rf "$CLAUDE_PROJECTS_DIR"
run "$(marker 10 '10:00' '10:10' 1000000 '999.00')"
chk "判为「沿用原记录」"              "$(q src_original)"          "1"
chk "金额沿用记录里的 999"            "$(q cost)"                  "999"
chk "日志检验：覆盖未知"              "$(q log_unknown)"           "1"
chk "孤立派工即使沿用原值也进合计"    "$(q records_not_summable)"  "0"

echo "── 3. 重算到的比记录里少 → 确证缺失，沿用原值 ──"
rm -rf "$CLAUDE_PROJECTS_DIR"
call 10 "10:05" 400000 r1                          # 只剩 40 万，记录里写的是 100 万
run "$(marker 10 '10:00' '10:10' 1000000 '999.00')"
chk "判为检出缺失"                    "$(q log_shortfall_detected)" "1"
chk "沿用原记录值，不拿残缺重算值顶替" "$(q cost)"                  "999"

echo "── 4. 一条回退 + 一条重算的重叠组 → 整组不进合计 ──"
# A=[10:00,10:20) 记录 out=200 万；B=[10:10,10:15) 记录 out=100 万。
# 日志里只剩 B 窗口内那一次调用（t=10:12，归 start 最晚的 B）。
# A 的缺口没人认领 → 检出缺失 → 沿用原值；B 通过检验 → 用重算值。
# 两者窗口相交，直接相加会把 t=10:12 那次调用算两遍 —— 必须整组单列。
rm -rf "$CLAUDE_PROJECTS_DIR"
call 10 "10:12" 1000000 r1
run "$(marker 10 '10:00' '10:20' 2000000 '100.00')" "$(marker 10 '10:10' '10:15' 1000000 '50.00')"
chk "A 沿用原值、B 用重算值"          "$(q src_original)/$(q src_recomputed)" "1/1"
chk "整组不进去重合计（2 条）"        "$(q records_not_summable)"  "2"
chk "去重合计里一分钱都不含这组"      "$(q cost)"                  "0"
chk "单列金额 = 原值 + 重算值（仅供参考，不可相加进上面）" "$(q cost_not_summable)" "125"
chk "报告里出现「不可相加」的提示"    "$(grep -qF '不可' "$TMP/r.md" && echo yes || echo no)" "yes"

echo "── 5. 重叠组全部可重算 → 整组进合计，且不重不漏 ──"
rm -rf "$CLAUDE_PROJECTS_DIR"
call 10 "10:02" 400000 r1      # 落在 A 独占区
call 10 "10:12" 600000 r2      # 落在重叠区 → 归 start 最晚的 B
run "$(marker 10 '10:00' '10:20' 1000000 '0.00')" "$(marker 10 '10:10' '10:15' 600000 '0.00')"
chk "两条都用重算值"                  "$(q src_recomputed)"        "2"
chk "整组都进合计"                    "$(q records_not_summable)"  "0"
chk "合计 = 全部调用各计一次（1e6 out → \$25）" "$(q cost)"        "25"

echo "── 6. 单价可信度一路走到最终 markdown（GitHub#934 交叉 review 第 1 轮）──"
# 四态只活在求解器里、没进报告的话，「用参照兜底的存疑金额」和「已与参照核对的金额」
# 在报告上长得一模一样，设计承诺的报红就是空的。下面三种都断言到**最终 markdown**。

# ⑴ 存疑：驱动记下这笔钱用的单价与外部参照冲突 → 报告必须报红、必须点名金额
rm -rf "$CLAUDE_PROJECTS_DIR"        # 没日志 → 走沿用原值那条路，可信度来自记录本身
run "$(marker 10 '10:00' '10:10' 1000000 '30.00' 'corroborated:20.00,disputed:10.00' solved)"
chk "存疑金额单独入桶（\$10）"        "$(q price_usd_disputed)"        "10"
chk "已核对金额单独入桶（\$20）"      "$(q price_usd_corroborated)"    "20"
chk "报告里出现「与参照冲突（存疑）」并报红" \
    "$(grep -qF '与参照冲突（存疑）' "$TMP/r.md" && grep -qF '⚠️' "$TMP/r.md" && echo yes || echo no)" "yes"
chk "报红那句带得出具体金额，不是笼统一句「有存疑」" \
    "$(grep -qF '$10（' "$TMP/r.md" && echo yes || echo no)" "yes"

# ⑵ 有单价但未核对：解得稳、但没有可比的参照 → 报告要说这是候选估算
run "$(marker 10 '10:00' '10:10' 1000000 '7.00' 'uncorroborated:7.00' solved)"
chk "未核对金额入桶（\$7）"           "$(q price_usd_uncorroborated)"  "7"
chk "报告写明「反解稳定但无参照可比」" \
    "$(grep -qF '反解稳定但无参照可比' "$TMP/r.md" && echo yes || echo no)" "yes"

# ⑶ 不可解、用参照兜底：走**重算**那条路——本测试的日志目录里没有 CLI 记账记录，
#    求解器解不出任何单价，policy=A 于是取参照价。这一整条是真实链路，不是造出来的桶。
rm -rf "$CLAUDE_PROJECTS_DIR"
call 10 "10:05" 1000000 r1
run "$(marker 10 '10:00' '10:10' 1000000 '999.00')"
chk "确实走的是重算那条路"            "$(q src_recomputed)"            "1"
chk "兜底金额入 unstable 桶（\$25）"  "$(q price_usd_unstable)"        "25"
chk "报告写明「反解不出、用外部参照兜底」" \
    "$(grep -qF '反解不出、用外部参照兜底' "$TMP/r.md" && echo yes || echo no)" "yes"

# ⑷ 参照本身的出处与局限必须写出来，不能包装成「已核验的官方价目」
chk "报告点名参照出处（本机缓存的那份）" \
    "$(grep -qF 'cached 2026-06-24' "$TMP/r.md" && echo yes || echo no)" "yes"
chk "报告明说本次没有联网核验参照" \
    "$(grep -qF '没有联网核验' "$TMP/r.md" && echo yes || echo no)" "yes"
chk "全仓不得再出现「已与官方价目交叉核对」这类说法" \
    "$(grep -rlF '与官方公开价目**交叉核对**' "$REPO_DIR/scripts" 2>/dev/null | wc -l)" "0"

# ⑸ 两侧不是同一把尺子：本 worker 反解 / 交叉 review 人工配置，必须分别说明
chk "报告分别说明两侧单价出处" \
    "$(grep -qF '本机反解' "$TMP/r.md" && grep -qF '人工配置' "$TMP/r.md" && echo yes || echo no)" "yes"

# ⑹ 历史评论：旧驱动那张过期表算出来的金额，不许冒充任何一态
rm -rf "$CLAUDE_PROJECTS_DIR"
run "$(marker 10 '10:00' '10:10' 1000000 '12.00')"
chk "没带可信度的金额落「说不出可信度」桶（\$12）" "$(q price_usd_unrated)" "12"
chk "报告写明这部分说不出可信度"      \
    "$(grep -qF '说不出可信度' "$TMP/r.md" && echo yes || echo no)" "yes"

echo "── 7. 「删日志后重跑数值会变」必须在报告里披露 ──"
# 第 1、2 组已经是这条的回归本身：同一条记录，有日志时算出 $25、日志删掉后变回 $999。
# 这里补的是**披露**——数值会变是 Q5=B 的既定代价，报告必须自己说出来，
# 否则读者会把历史周的数字当成不会变的定值。
chk "报告写明历史周数值会随本机日志被清理而改变" \
    "$(grep -qF '同一个历史周的数值会随本机日志被清理而改变' "$TMP/r.md" && echo yes || echo no)" "yes"
chk "报告带生成时间（数值会变，就必须能看出是哪一次跑出来的）" \
    "$(grep -qF '数据生成时间' "$TMP/r.md" && echo yes || echo no)" "yes"

echo
echo "结果：$pass passed, $fail failed"
[ "$fail" -eq 0 ]
