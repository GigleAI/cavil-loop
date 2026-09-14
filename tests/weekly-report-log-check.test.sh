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
# 同上，但金额那几个字段整段由调用方给（用来造「整条 footer 没写金额」这种记录）。
# $1 wt  $2 起 hh  $3 止 hh  $4 out token  $5 金额字段原文
marker_raw() {
    printf '干完了。\n\n<!-- agent-metrics agent=claude wt=%s start=%sT%s:00+08:00 end=%sT%s:00+08:00 wall_secs=600 in=0 out=%s cache_r=0 cache_w=0 %s -->' \
        "$1" "$W" "$2" "$W" "$3" "$4" "$5"
}
# 往某 worktree 的 claude 日志里写一次调用。$1 wt  $2 时刻 HH:MM  $3 out token  $4 reqid
#                                        $5 模型（可选，默认 claude-opus-5）
call() {
    local enc; enc=$(printf '%s' "$WTBASE/$PREFIX-$1" | tr / -)
    mkdir -p "$CLAUDE_PROJECTS_DIR/$enc"
    printf '{"type":"assistant","timestamp":"%sT%s:00Z","requestId":"%s","message":{"model":"%s","usage":{"input_tokens":0,"output_tokens":%s,"cache_read_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0}}}}\n' \
        "$W" "$(date -u -d "$W $2 +0800" +%H:%M)" "$4" "${5:-claude-opus-5}" "$3" >> "$CLAUDE_PROJECTS_DIR/$enc/s.jsonl"
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

echo "── 8. 重算结论必须整套取用：空可信度桶不许回退到旧 footer（第 2 轮打回）──"
# A=[10:00,10:20) 与 B=[10:10,10:15) 重叠，唯一一次调用落在 10:12 → 只归 B（start 最晚）。
# 两条都有日志、都通过检验、都重算：A 该是 $0 + **空桶**，B 是 $25 + unstable。
# 改前 collect 用 `info.get(...) or rec.get(...)` 逐字段回退，把 A 那个合法的空桶
# 当成「没算」，于是旧 footer 的 disputed:25 复活 —— 合计 $25，桶却是
# disputed $25 + unstable $25，最终报告报出一笔根本不存在的存疑金额。
rm -rf "$CLAUDE_PROJECTS_DIR"
call 10 "10:12" 1000000 r1
run "$(marker 10 '10:00' '10:20' 1000000 '25.00' 'disputed:25.00' solved)" \
    "$(marker 10 '10:10' '10:15' 1000000 '25.00' 'disputed:25.00' solved)"
chk "两条都走重算"                    "$(q src_recomputed)/$(q src_original)"  "2/0"
chk "合计只算一次调用（\$25）"        "$(q cost)"                  "25"
chk "旧 footer 的 disputed 不复活"    "$(q price_usd_disputed)"    "0"
chk "桶里只有重算得到的那一份（unstable \$25）" "$(q price_usd_unstable)" "25"
chk "桶的合计 == 表头金额（改前是 50 vs 25）" \
    "$(python3 -c "
import json; w=json.load(open('$TMP/d.json'))['weekly']['$W']
b=sum(v for k,v in w.items() if k.startswith('price_usd_'))
print(f\"{round(b,2)}/{round(w['cost'],2)}\")")" "25.0/25.0"
chk "最终 markdown 里不出现那笔存疑金额" \
    "$(grep -qF '与参照冲突（存疑）' "$TMP/r.md" && echo yes || echo no)" "no"

# 重算后**全部缺价**（这个模型压根不在价目表里）→ 旧记录的可信度同样不许带回来
rm -rf "$CLAUDE_PROJECTS_DIR"
call 10 "10:05" 1000000 r1 some-model-not-in-any-price-table
run "$(marker 10 '10:00' '10:10' 1000000 '25.00' 'corroborated:25.00' solved)"
chk "重算走通"                        "$(q src_recomputed)"        "1"
chk "一分钱都算不出（不是沿用记录里的 25）" "$(q cost)"             "0"
chk "价格覆盖落 none"                 "$(q state_none)"            "1"
chk "旧记录的 corroborated 不许带回来" "$(q price_usd_corroborated)" "0"
chk "所有可信度桶全空"                \
    "$(python3 -c "
import json; w=json.load(open('$TMP/d.json'))['weekly']['$W']
print(round(sum(v for k,v in w.items() if k.startswith('price_usd_')),2))")" "0"

echo "── 9. 金额覆盖计数必须跟着最终采用的金额走（第 3 轮打回）──"
# 金额本身已经改成按日志重算，但「这条有没有金额」原来还在看**旧 footer** 写没写。
# 两者一分家，报告就会自相矛盾。下面两个方向都走到最终 markdown。

# ⑴ 旧 footer 没金额（那时还没配单价），但本机日志现在重算得出 $25
rm -rf "$CLAUDE_PROJECTS_DIR"
call 10 "10:05" 1000000 r1
run "$(marker_raw 10 '10:00' '10:10' 1000000 'cost_state=none cost_unknown_tokens=0')"
chk "金额来自重算（\$25）"            "$(q cost)"                  "25"
chk "覆盖计数跟着重算走（1 条有金额）" "$(q cost_records)"          "1"
chk "旧 footer 的原始证据仍单独留着（0 条）" "$(q cost_footers)"     "0"
chk "报告不再自相矛盾地说「没有金额」" \
    "$(grep -qF '条没有金额' "$TMP/r.md" && echo yes || echo no)" "no"

# ⑵ 旧 footer 有 $25，但本轮重算时这个模型压根没有单价
rm -rf "$CLAUDE_PROJECTS_DIR"
call 10 "10:05" 1000000 r1 some-model-not-in-any-price-table
run "$(marker 10 '10:00' '10:10' 1000000 '25.00')"
chk "一分钱都算不出（\$0）"           "$(q cost)"                  "0"
chk "覆盖计数也归零（0 条有金额）"    "$(q cost_records)"          "0"
chk "旧 footer 的原始证据仍单独留着（1 条）" "$(q cost_footers)"     "1"
chk "顶部缺金额告警必须出现（改前整个消失）" \
    "$(grep -qF '条没有金额' "$TMP/r.md" && echo yes || echo no)" "yes"

# ⑶ 语义不能被顺带改坏：配了单价、金额如实是 0.00 —— 那是「记了，是 0」，不是「没采到」
rm -rf "$CLAUDE_PROJECTS_DIR"
run "$(marker_raw 10 '10:00' '10:10' 1000 'cost_usd=0.00 cost_state=full cost_unknown_tokens=0')"
chk "真实零金额算「有金额」（按非零判会误报没采到）" "$(q cost_records)" "1"
chk "顶部不出缺金额告警"              \
    "$(grep -qF '条没有金额' "$TMP/r.md" && echo yes || echo no)" "no"

# ⑷ 部分缺价：算出了一部分 → 仍算「有金额」，但报告要说金额偏低
rm -rf "$CLAUDE_PROJECTS_DIR"
run "$(marker_raw 10 '10:00' '10:10' 1000000 'cost_usd=12.00 cost_state=partial cost_unknown_tokens=500000')"
chk "部分缺价算「有金额」"            "$(q cost_records)"          "1"
chk "但覆盖三态如实记成 partial"      "$(q state_partial)"         "1"

# ⑸ 沿用原值：日志没了 → 用旧 footer 的金额，覆盖计数也跟着旧 footer（此时它就是最终值）
rm -rf "$CLAUDE_PROJECTS_DIR"
run "$(marker 10 '10:00' '10:10' 1000000 '999.00')"
chk "沿用原值"                        "$(q src_original)"          "1"
chk "覆盖计数跟着沿用的那份（1 条）"  "$(q cost_records)"          "1"

echo "── 10. 「已知的零」不是「算不出」（第 4 轮打回）──"
# 覆盖判据改成跟着最终金额走之后，冒出一个边界：`price_calls` 原来要求「至少算出过
# 一个价」才给 full，于是**空认领**（调用全被另一条派工认领走）和**真实零调用**
# 这两种确定的 $0 被判成缺价，报告凭空说「N 条没有金额、真实开销更高」。
# ⚠️ 这两条不能用 footer 写 `cost_usd=0.00` 来代测 —— 那条路根本不走重算，
#   绕开了出错的那个状态（第 9 组⑶ 测的就是那条，两者互不替代）。

# ⑴ 空认领：A=[10:00,10:20) 与 B=[10:10,10:15)，唯一调用在 10:12 只归 B。
#    A 的缺口全部由「B 认领走了」解释，两条都通过检验、都重算，A 就是确定的 $0。
rm -rf "$CLAUDE_PROJECTS_DIR"
call 10 "10:12" 1000000 r1
run "$(marker 10 '10:00' '10:20' 1000000 '25.00')" "$(marker 10 '10:10' '10:15' 1000000 '25.00')"
chk "两条都走重算"                    "$(q src_recomputed)"        "2"
chk "合计只算一次调用（\$25）"        "$(q cost)"                  "25"
chk "两条都算「有金额」（A 是已知的 \$0）" "$(q cost_records)"      "2"
chk "没有一条被判成「算不出」"        "$(q state_none)"            "0"
chk "两条都记 full"                   "$(q state_full)"            "2"
chk "报告不再凭空说「真实开销更高」"  \
    "$(grep -qF '真实开销更高' "$TMP/r.md" && echo yes || echo no)" "no"

# ⑵ 真实零调用：日志在、但窗口里一次 API 调用都没有 → 日志检验判 true_zero
rm -rf "$CLAUDE_PROJECTS_DIR"
ZENC=$(printf '%s' "$WTBASE/$PREFIX-10" | tr / -)
mkdir -p "$CLAUDE_PROJECTS_DIR/$ZENC"
printf '{"type":"user","timestamp":"%sT02:00:00Z"}\n' "$W" > "$CLAUDE_PROJECTS_DIR/$ZENC/s.jsonl"
run "$(marker 10 '10:00' '10:10' 0 '0.00')"
chk "日志检验判真实零调用"            "$(q log_true_zero)"         "1"
chk "金额是确定的 \$0"                "$(q cost)"                  "0"
chk "算「有金额」（已知的零）"        "$(q cost_records)"          "1"
chk "记 full，不是 none"              "$(q state_full)/$(q state_none)" "1/0"
chk "报告不说「没有金额」"            \
    "$(grep -qF '条没有金额' "$TMP/r.md" && echo yes || echo no)" "no"

# ⑶ 反向守住：有**非零**的未知 token 时仍旧是 none —— 这条别被上面的放宽带歪
rm -rf "$CLAUDE_PROJECTS_DIR"
call 10 "10:05" 1000000 r1 some-model-not-in-any-price-table
run "$(marker 10 '10:00' '10:10' 1000000 '25.00')"
chk "有 token 但没单价 → 仍然是「一条都算不出」" "$(q state_none)"  "1"
chk "覆盖计数仍然归零"                "$(q cost_records)"          "0"
chk "报告仍要报缺金额"                \
    "$(grep -qF '条没有金额' "$TMP/r.md" && echo yes || echo no)" "yes"

echo "── 11. 交叉 review 侧：未计价的项一路走到最终报告（第 5 轮打回）──"
# 这一组不自己拼 footer —— 先造一份**原始 rollout**、跑**真实的 codex driver** 拿到
# 它输出的那行，再把它当成记账行喂进 record 解析 → collect → report。
# 中间任何一环把「未计价的 cache write」吞掉，最终报告就会说这条金额是完整的。
CXHOME="$TMP/cx"; mkdir -p "$CXHOME/wt" "$CXHOME/.codex/sessions/2026/09/14"
CXTS=$(date -u -d "$W 10:05 +0800" '+%Y-%m-%dT%H:%M:%S.000Z')
{ printf '{"type":"session_meta","timestamp":"%s","payload":{"cwd":"%s"}}\n' "$CXTS" "$CXHOME/wt"
  printf '{"type":"turn_context","timestamp":"%s","payload":{"cwd":"%s","model":"mA"}}\n' "$CXTS" "$CXHOME/wt"
  printf '{"type":"token_usage_record","timestamp":"%s","payload":{"usage":{"input_tokens":1000000,"cached_input_tokens":0,"cache_write_input_tokens":50000,"output_tokens":0,"reasoning_output_tokens":0,"total_tokens":1000000}}}\n' "$CXTS"
} > "$CXHOME/.codex/sessions/2026/09/14/rollout-A.jsonl"
CXKV=$( cd "$CXHOME/wt" && HOME="$CXHOME" \
        CODEX_PRICES='{"mA":{"in":10,"cached_in":1,"out":100}}' \
        bash "$REPO_DIR/scripts/drivers/token-usage/codex.sh" \
             "$(date -d "$W 10:00 +0800" +%s)" --kv )
chk "driver 自己就报出了未计价的部分" \
    "$(printf '%s' "$CXKV" | grep -o 'cost_state=[a-z]* cost_unknown_tokens=[0-9]*')" \
    "cost_state=partial cost_unknown_tokens=50000"

CXBODY=$(printf '交叉 review 完了。\n\n<!-- agent-metrics agent=codex wt=10 start=%sT10:00:00+08:00 end=%sT10:10:00+08:00 wall_secs=600 %s -->' \
         "$W" "$W" "$CXKV")
rm -rf "$CLAUDE_PROJECTS_DIR"
run "$CXBODY"
chk "记账金额采到了（\$10）"          "$(q cost)"                  "10"
chk "算「有金额」（partial 也是有金额）" "$(q cost_records)"        "1"
chk "覆盖三态如实记 partial"          "$(q state_partial)"         "1"
chk "不是 full"                       "$(q state_full)"            "0"
chk "报告写明有一条只算了一部分用量"  \
    "$(grep -qF '1 条**只算了一部分用量**' "$TMP/r.md" && echo yes || echo no)" "yes"
chk "报告不再把 partial 说成「只算了一部分模型」（同一模型里某项没价也会 partial）" \
    "$(grep -qF '只算了一部分模型' "$TMP/r.md" && echo yes || echo no)" "no"

echo "── 12. 全部实际用量缺价，一路到最终报告都必须是「算不出」（第 6 轮打回）──"
# 同第 11 组的走法：造原始 rollout → 跑真实 codex driver → 记录解析 → collect → markdown。
# 这一组盯的是反向：driver 若把「有价项用量为 0」误当成算出过价，整条链会把一条
# **一分钱都没算出来**的派工计成「有金额」。
CX2="$TMP/cx2"; mkdir -p "$CX2/wt" "$CX2/.codex/sessions/2026/09/14"
CX2TS=$(date -u -d "$W 10:05 +0800" '+%Y-%m-%dT%H:%M:%S.000Z')
{ printf '{"type":"session_meta","timestamp":"%s","payload":{"cwd":"%s"}}\n' "$CX2TS" "$CX2/wt"
  printf '{"type":"turn_context","timestamp":"%s","payload":{"cwd":"%s","model":"mA"}}\n' "$CX2TS" "$CX2/wt"
  printf '{"type":"token_usage_record","timestamp":"%s","payload":{"usage":{"input_tokens":1000000,"cached_input_tokens":1000000,"cache_write_input_tokens":0,"output_tokens":0,"reasoning_output_tokens":0,"total_tokens":1000000}}}\n' "$CX2TS"
} > "$CX2/.codex/sessions/2026/09/14/rollout-A.jsonl"
CX2KV=$( cd "$CX2/wt" && HOME="$CX2" CODEX_PRICES='{"mA":{"in":10}}' \
         bash "$REPO_DIR/scripts/drivers/token-usage/codex.sh" \
              "$(date -d "$W 10:00 +0800" +%s)" --kv )
chk "driver 判为一条都算不出"        \
    "$(printf '%s' "$CX2KV" | grep -o 'cost_state=[a-z]* cost_unknown_tokens=[0-9]*')" \
    "cost_state=none cost_unknown_tokens=1000000"
chk "driver 不写金额"                "$(printf '%s' "$CX2KV" | grep -c 'cost_usd=')" "0"

CX2BODY=$(printf '交叉 review 完了。\n\n<!-- agent-metrics agent=codex wt=10 start=%sT10:00:00+08:00 end=%sT10:10:00+08:00 wall_secs=600 %s -->' \
          "$W" "$W" "$CX2KV")
rm -rf "$CLAUDE_PROJECTS_DIR"
run "$CX2BODY"
chk "采到的金额是 0"                  "$(q cost)"                  "0"
chk "金额覆盖计数为 0（不能算作有金额）" "$(q cost_records)"        "0"
chk "覆盖三态记 none"                 "$(q state_none)"            "1"
chk "不是 partial"                    "$(q state_partial)"         "0"
chk "报告如实报缺金额"                \
    "$(grep -qF '条没有金额' "$TMP/r.md" && echo yes || echo no)" "yes"

echo "── 13. 不足一分的可信状态要能穿过整条链（第 8 轮打回）──"
# 链路：原始 transcript → **真实 claude driver** → footer → **把日志删掉** →
#      record 解析 → collect 沿用原值 → 最终 markdown。
# driver 若把桶提前舍成 0.00，信息就销毁在源头了 —— 报告层再怎么改也恢复不回来。
# ⚠️ 这一组刻意**不预填桶**：footer 里的数字全部由真实 driver 产生。
cdrv() {  # $1 输出目录名  $2 out token  $3 model —— 造 transcript 并跑真实 driver 拿 --kv
    local d="$TMP/drv/$1"; mkdir -p "$d"
    local enc; enc=$(printf '%s' "$d" | tr / -)
    mkdir -p "$TMP/drvproj/$enc"
    printf '{"type":"assistant","requestId":"r1","uuid":"u1","timestamp":"%sT02:05:00Z","message":{"model":"%s","usage":{"input_tokens":0,"output_tokens":%s,"cache_read_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0}}}}\n' \
        "$W" "${3:-claude-opus-5}" "$2" > "$TMP/drvproj/$enc/s.jsonl"
    ( cd "$d" && CLAUDE_PROJECTS_DIR="$TMP/drvproj" \
      bash "$REPO_DIR/scripts/drivers/token-usage/claude.sh" 0 --kv )
}
mk_marker_from_kv() {  # $1 kv 原文 → 一条 wt=10 的完整记账评论
    printf '干完了。\n\n<!-- agent-metrics agent=claude wt=10 start=%sT10:00:00+08:00 end=%sT10:10:00+08:00 wall_secs=600 %s -->' \
        "$W" "$W" "$1"
}

# ⑴ 不足一分的 unstable：100 output × 参照 $25/M = $0.0025
KV_TINY=$(cdrv tiny 100)
chk "driver 没把不足一分的桶舍成 0.00" \
    "$(printf '%s' "$KV_TINY" | grep -qF 'price_status=unstable:0.0025' && echo yes || echo no)" "yes"
rm -rf "$CLAUDE_PROJECTS_DIR"          # 删日志 → 走沿用 footer 那条路
run "$(mk_marker_from_kv "$KV_TINY")"
chk "确实是沿用原值那条路"            "$(q src_original)"          "1"
chk "算「有金额」"                    "$(q cost_records)"          "1"
chk "unstable 桶活着（非零）"         \
    "$(python3 -c "
import json; w=json.load(open('$TMP/d.json'))['weekly']['$W']
print('yes' if w.get('price_usd_unstable',0) > 0 else 'no')")" "yes"
chk "报告写明用了外部参照兜底"        \
    "$(grep -qF '反解不出、用外部参照兜底' "$TMP/r.md" && echo yes || echo no)" "yes"
chk "不许再说「没有算出金额」"        \
    "$(grep -qF '没有算出金额' "$TMP/r.md" && echo yes || echo no)" "no"
chk "小额按分显示（< \$0.01）"        \
    "$(grep -qF '< $0.01' "$TMP/r.md" && echo yes || echo no)" "yes"

# ⑵ 小额与大额混在一起：小的那桶不能被大的盖掉
KV_BIG=$(cdrv big 100000000)           # 1 亿 output × $25/M = $2,500
rm -rf "$CLAUDE_PROJECTS_DIR"
run "$(mk_marker_from_kv "$KV_TINY")" "$(printf '干完了。\n\n<!-- agent-metrics agent=claude wt=11 start=%sT12:00:00+08:00 end=%sT12:10:00+08:00 wall_secs=600 %s -->' "$W" "$W" "$KV_BIG")"
chk "两条都沿用原值"                  "$(q src_original)"          "2"
chk "合计含大额 + 那笔不足一分的（2500.0025 → 2500.0）" "$(q cost)"   "2500.0"
chk "两笔都落在同一个桶里、合计比大额还多一点点" \
    "$(python3 -c "
import json; w=json.load(open('$TMP/d.json'))['weekly']['$W']
print('yes' if w.get('price_usd_unstable',0) > 2500 else 'no')")" "yes"

# ⑶ 反向：真的零调用 —— 不许把真零包装成一个正的小额
rm -rf "$CLAUDE_PROJECTS_DIR"
KV_ZERO=$(cdrv zero 0)
chk "零用量时 driver 仍写 \$0.00（不编一个小额出来）" \
    "$(printf '%s' "$KV_ZERO" | grep -o 'cost_usd=[0-9.]*')" "cost_usd=0.00"
chk "零用量时没有任何可信度桶"        \
    "$(printf '%s' "$KV_ZERO" | grep -c 'price_status=')" "0"
rm -rf "$CLAUDE_PROJECTS_DIR"
run "$(mk_marker_from_kv "$KV_ZERO")"
chk "报告里不出现凭空的小额提示"      \
    "$(grep -qF '< $0.01' "$TMP/r.md" && echo yes || echo no)" "no"

echo
echo "结果：$pass passed, $fail failed"
[ "$fail" -eq 0 ]
