#!/usr/bin/env bash
# 目标周按模型拆分 + PDF 页序（GitHub#61）。
#
# 跑法：bash tests/weekly-report-by-model.test.sh
# 依赖：python3。自造假 `gh` + 假 claude 日志，**走完整链路** record.extract → collect.main →
# report.py，按模型的数字与手算逐项比对，再看最终 markdown 的版式。
#
# 为什么要有这个文件：
#   · 按模型拆分是「再分一层桶」，算错不会报错，只会让某个模型凭空多 / 少一截。夹具要能把
#     几种归属规则分开：重算过的单模型派工、重算过的**多模型**派工（时长整次进「多模型派工」，
#     token 与金额按调用拆）、没写模型的沿用原值记录（整条进「未记录模型 / 多模型」）、
#     codex 侧单模型记录、以及一组进不了去重合计的重叠派工（不进任何一行）。
#   · 自检要能真的拦住：负对照删掉一行 / 改掉一格，report.py 必须非零退出。
#   · 版式：五个类别各起一页、10 周表紧跟图、本周行加粗、末行环比。
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
# 本机没有可反解的记账 → 价目走参照兜底：Opus 5 输出 $25/M、缓存读取 $0.5/M；Sonnet 5 输出 $10/M
export XDG_CACHE_HOME="$TMP/cache"
unset CODEX_PRICES CODEX_PRICE_IN_PER_M CODEX_PRICE_CACHED_IN_PER_M CODEX_PRICE_OUT_PER_M

# 一条派工的机器记录。$1 agent $2 wt $3 起 HH:MM $4 止 HH:MM $5 out token $6 其余字段原文
marker() {
    local s e
    s=$(date -d "$W $3" +%s); e=$(date -d "$W $4" +%s)
    printf '干完了。\n\n<!-- agent-metrics agent=%s wt=%s start=%sT%s:00+08:00 end=%sT%s:00+08:00 wall_secs=%s in=0 out=%s cache_r=0 cache_w=0 %s -->' \
        "$1" "$2" "$W" "$3" "$W" "$4" "$((e - s))" "$5" "$6"
}
# 往某 worktree 的 claude 日志里写一次调用。$1 wt $2 时刻 HH:MM $3 模型 $4 out $5 cache_read $6 reqid
call() {
    local enc; enc=$(printf '%s' "$WTBASE/$PREFIX-$1" | tr / -)
    mkdir -p "$CLAUDE_PROJECTS_DIR/$enc"
    printf '{"type":"assistant","timestamp":"%sT%s:00Z","requestId":"%s","message":{"model":"%s","usage":{"input_tokens":0,"output_tokens":%s,"cache_read_input_tokens":%s,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0}}}}\n' \
        "$W" "$(date -u -d "$W $2 +0800" +%H:%M)" "$6" "$3" "$4" "$5" >> "$CLAUDE_PROJECTS_DIR/$enc/s.jsonl"
}

# 一轮的开头（处理时长按轮算：从这条指令到这一轮最后一条记录）。$1 wt $2 时刻 HH:MM $3 promptId
prompt() {
    local enc; enc=$(printf '%s' "$WTBASE/$PREFIX-$1" | tr / -)
    mkdir -p "$CLAUDE_PROJECTS_DIR/$enc"
    printf '{"type":"user","timestamp":"%sT%s:00Z","promptId":"%s","message":{"role":"user","content":"go"}}\n' \
        "$W" "$(date -u -d "$W $2 +0800" +%H:%M)" "$3" >> "$CLAUDE_PROJECTS_DIR/$enc/s.jsonl"
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
        --worktree-base "$WTBASE" --session-prefix "$PREFIX" --switch-week 2024-12-02 \
        >/dev/null 2>"$TMP/err.log" \
        || { echo "collect.py 跑挂了："; cat "$TMP/err.log"; exit 1; }
    python3 "$REPORT" --data "$TMP/d.json" --out "$TMP/r.md" --asset-url-base https://x.invalid/a --rev y \
        >/dev/null 2>"$TMP/rerr.log" \
        || { echo "report.py 跑挂了："; cat "$TMP/rerr.log"; exit 1; }
}
# 按模型的某一行：$1 kind $2 model $3 side $4 字段
row() { python3 -c "
import json; rows=json.load(open('$TMP/d.json'))['by_model']
r=[r for r in rows if (r['kind'],r['model'],r['side'])==('$1','$2','$3')]
v=r[0]['$4'] if r else 'missing'
print(v if isinstance(v,str) else (int(v) if float(v)==int(v) else round(float(v),4)))"; }
tot() { python3 -c "
import json; rows=json.load(open('$TMP/d.json'))['by_model']
v=sum(r['$1'] for r in rows); print(int(v) if float(v)==int(v) else round(float(v),4))"; }
wk() { python3 -c "
import json; v=json.load(open('$TMP/d.json'))['weekly']['$W'].get('$1',0)
print(int(v) if float(v)==int(v) else round(float(v),4))"; }
has() { grep -qF -- "$1" "$TMP/r.md" && echo yes || echo no; }

rm -rf "$CLAUDE_PROJECTS_DIR"
# D1 wt=11 重算、单模型：Opus 5 输出 100 万（$25）+ 缓存读取 100 万（$0.5）；一轮 10:01→10:05 = 240 秒
prompt 11 "10:01" p11
call 11 "10:05" claude-opus-5 1000000 1000000 r11
# D2 wt=12 重算、两个模型：Opus 5 输出 40 万（$10）+ Sonnet 5 输出 100 万（$10）；一轮 10:01→10:06 = 300 秒
prompt 12 "10:01" p12
call 12 "10:03" claude-opus-5 400000 0 r12a
call 12 "10:06" claude-sonnet-5 1000000 0 r12b
# D3 wt=14 没写模型、本机没日志 → 沿用原值 $7，整条进「未记录模型 / 多模型」
# D4 codex 侧、只写了一个模型、原值 $3
# D6 codex 侧写了模型、但另有调用认不出模型（model_unknown=yes）→ 不归那个模型，进「未记录模型 / 多模型」
# D7 wt=17 沿用原值、记录里写了两个模型 → token 拆不开，同样整条进「未记录模型 / 多模型」
# D5 wt=13 一组重叠派工：A 沿用原值、B 重算 → 整组不可去重合计，不进任何一行
call 13 "10:12" claude-opus-5 1000000 0 r13
run "$(marker claude 11 10:00 10:10 1000000 'cost_usd=999.00 cost_state=full models=claude-opus-5 model_unknown=no')" \
    "$(marker claude 12 10:00 10:10 1400000 'cost_usd=999.00 cost_state=full models=claude-opus-5,claude-sonnet-5 model_unknown=no')" \
    "$(marker claude 14 10:00 10:10 500000 'cost_usd=7.00 cost_state=full')" \
    "$(marker codex 15 10:00 10:10 100000 'cost_usd=3.00 cost_state=full models=gpt-6-sol model_unknown=no')" \
    "$(marker codex 16 10:00 10:10 50000 'cost_usd=2.00 cost_state=full models=gpt-6-sol model_unknown=yes')" \
    "$(marker claude 17 10:00 10:10 200000 'cost_usd=4.00 cost_state=full models=claude-opus-5,claude-sonnet-5 model_unknown=no')" \
    "$(marker claude 13 10:00 10:20 2000000 'cost_usd=100.00 cost_state=full')" \
    "$(marker claude 13 10:10 10:15 1000000 'cost_usd=50.00 cost_state=full')"

echo "── 1. 各行与手算一致 ──"
chk "D1 + D2 的 Opus 部分：金额 25 + 0.5 + 10"      "$(row model claude-opus-5 claude cost)"        "35.5"
chk "Opus 输出 = 100 万 + 40 万"                    "$(row model claude-opus-5 claude tok_out)"     "1400000"
chk "Opus 缓存读取 = 100 万"                        "$(row model claude-opus-5 claude tok_cache_r)" "1000000"
chk "Opus 只有 D1 整次归它（D2 是多模型）"          "$(row model claude-opus-5 claude records)/$(row model claude-opus-5 claude wall)" "1/600"
chk "Opus 的处理时长 = D1 那一轮 240 秒"             "$(row model claude-opus-5 claude work)/$(row model claude-opus-5 claude work_records)" "240/1"
chk "Sonnet 只拿 D2 里它那份 token / 金额"          "$(row model claude-sonnet-5 claude tok_out)/$(row model claude-sonnet-5 claude cost)" "1000000/10"
chk "Sonnet 没有派工整次归它 → 不分时长"            "$(row model claude-sonnet-5 claude records)/$(row model claude-sonnet-5 claude wall)" "0/0"
chk "D2 的时长整次进「多模型派工」"                 "$(row multi '(multi-model dispatch)' claude records)/$(row multi '(multi-model dispatch)' claude wall)" "1/600"
chk "D2 的处理时长 300 秒也整次进「多模型派工」"     "$(row multi '(multi-model dispatch)' claude work)/$(row multi '(multi-model dispatch)' claude work_records)" "300/1"
chk "Sonnet 不分处理时长"                           "$(row model claude-sonnet-5 claude work)" "0"
chk "「多模型派工」行没有 token / 金额"             "$(row multi '(multi-model dispatch)' claude tok_out)/$(row multi '(multi-model dispatch)' claude cost)" "0/0"
chk "D3 没写模型 + D7 沿用原值又写了两个模型 → 都整条进「未记录模型 / 多模型」" \
    "$(row unrecorded '(unrecorded / multi)' claude records)/$(row unrecorded '(unrecorded / multi)' claude cost)/$(row unrecorded '(unrecorded / multi)' claude tok_out)" "2/11/700000"
chk "D7 没被猜成 Opus 或 Sonnet（两者金额只有重算那份）" "$(row model claude-opus-5 claude cost)/$(row model claude-sonnet-5 claude cost)" "35.5/10"
chk "D6 带 model_unknown=yes → 不归 gpt-6-sol，进 codex 侧的未记录行" \
    "$(row unrecorded '(unrecorded / multi)' codex records)/$(row unrecorded '(unrecorded / multi)' codex cost)/$(row model gpt-6-sol codex records)" "1/2/1"
chk "D4 codex 侧按记录里的唯一模型归属"              "$(row model gpt-6-sol codex records)/$(row model gpt-6-sol codex cost)/$(row model gpt-6-sol codex tok_out)" "1/3/100000"
chk "重叠组不进任何一行（没有 wt 13 的 \$150）"      "$(tot cost)" "61.5"

echo "── 2. 合计等于原总数 ──"
chk "金额：各行之和 = 本周总数"                     "$(tot cost)" "$(wk cost)"
chk "输出：各行之和 = 本周总数"                     "$(tot tok_out)" "$(wk tok_out)"
chk "缓存读取：各行之和 = 本周总数"                 "$(tot tok_cache_r)" "$(wk tok_cache_r)"
chk "派工次数：各行之和 = 总数 − 单列的 2 条"       "$(tot records)" "$(( $(wk records) - $(wk records_not_summable) ))"
chk "单列的 2 条确实在总数里"                       "$(wk records)/$(wk records_not_summable)" "8/2"
chk "总耗时：各行之和 = 总数 − 单列的 25 分钟"      "$(tot wall)" "$(( $(wk wall) - $(wk wall_not_summable) ))"
chk "单列的时长 = 20 + 5 分钟"                      "$(wk wall_not_summable)" "1500"
chk "处理时长：各行之和 = 总数 − 单列的那份"        "$(tot work)" "$(python3 -c "print(int($(wk work) - $(wk work_not_summable)))")"
chk "算得出处理时长的条数：各行之和 = 总数 − 单列"  "$(tot work_records)" "$(( $(wk work_records) - $(wk work_records_not_summable) ))"

echo "── 3. 报告里的两张按模型表 ──"
chk "时长表：Opus 一行"                  "$(has '| `claude-opus-5` | 主 worker | 1 | 10m | 4m |')" "yes"
chk "时长表：多模型派工一行"             "$(has '| 多模型派工 | 主 worker | 1 | 10m | 5m |')" "yes"
chk "时长表：未记录模型（主 worker）一行" "$(has '| 未记录模型 / 多模型 | 主 worker | 2 | 20m | — |')" "yes"
chk "时长表：未记录模型（交叉 review）一行" "$(has '| 未记录模型 / 多模型 | 交叉 review | 1 | 10m | — |')" "yes"
chk "时长表：codex 侧一行"               "$(has '| `gpt-6-sol` | 交叉 review | 1 | 10m | — |')" "yes"
chk "时长表：Sonnet 没有整次派工，不出现" "$(has '| `claude-sonnet-5` | 主 worker |')" "no"
chk "时长表：合计 6 次 60 分钟，处理时长 9 分钟（6 次里 2 次算得出）" \
    "$(has '| **合计** | | **6** | **1h00m** | **9m（2/6 次算得出）** |')" "yes"
chk "token 表：Opus 占 35.5 / 61.5 = 58%" "$(has '| `claude-opus-5` | 1.4M | 1.0M | 0 | 0 | $36 | 58% |')" "yes"
chk "token 表：Sonnet 占 16%"             "$(has '| `claude-sonnet-5` | 1.0M | 0 | 0 | 0 | $10 | 16% |')" "yes"
chk "token 表：未记录模型两侧合成一行 13/61.5 = 21%" "$(has '| 未记录模型 / 多模型 | 750.0k | 0 | 0 | 0 | $13 | 21% |')" "yes"
chk "token 表：codex 模型 5%"             "$(has '| `gpt-6-sol` | 100.0k | 0 | 0 | 0 | $3 | 5% |')" "yes"
chk "token 表：多模型派工不出现"          "$(grep -c '^| 多模型派工 |' "$TMP/r.md")" "1"
chk "注明重叠组不在表里"                  "$(has '不在上面两张表里')" "yes"

echo "── 4. 负对照：按模型拆分对不上总数，报告必须报错 ──"
python3 - "$TMP/d.json" "$TMP/drop.json" "$TMP/bump.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
drop = dict(d, by_model=[r for r in d["by_model"] if r["kind"] != "unrecorded"])   # 只记总数、不记它的拆分
json.dump(drop, open(sys.argv[2], "w"))
bump = json.loads(json.dumps(d))
bump["by_model"][0]["tok_cache_w"] += 1                                         # 某一格多了 1 个 token
json.dump(bump, open(sys.argv[3], "w"))
PY
for f in drop bump; do
    python3 "$REPORT" --data "$TMP/$f.json" --out "$TMP/$f.md" --asset-url-base x --rev y >/dev/null 2>"$TMP/$f.err"
    rc=$?
    chk "$f：report.py 非零退出"                  "$([ $rc -ne 0 ] && echo yes || echo no)" "yes"
    chk "$f：报错写明是自检对不上"                "$(grep -c 'GitHub#61 自检' "$TMP/$f.err")" "1"
done
chk "drop：点名差在哪几项"   "$(grep -c '^  records:\|^  cost:\|^  tok_out:' "$TMP/drop.err")" "3"
chk "bump：只点名缓存写入"   "$(grep -c '^  ' "$TMP/bump.err")/$(grep -c 'tok_cache_w' "$TMP/bump.err")" "1/1"
# 旧 data.json（按模型上线之前采的）没有这个字段：照常出报告，说明没有这部分
python3 -c "
import json; d=json.load(open('$TMP/d.json')); d.pop('by_model'); json.dump(d, open('$TMP/old.json','w'))"
python3 "$REPORT" --data "$TMP/old.json" --out "$TMP/old.md" --asset-url-base x --rev y >/dev/null 2>&1
chk "旧数据没有 by_model → 不报错、写明没有这部分" "$?/$(grep -c '没有这部分' "$TMP/old.md")" "0/1"

echo "── 5. PDF 页序：五个类别各起一页，表紧跟图 ──"
SEQ=$(python3 - "$TMP/r.md" <<'PY'
import sys
L = open(sys.argv[1]).read().split("\n")
PAGE = '<div style="break-before: page"></div>'
out = []
for i, l in enumerate(L):
    if l.startswith("### ") or l.startswith("## 📋"):
        # 向上找最近的非空行：必须是分页标记，才算「新起一页」
        j = i - 1
        while j >= 0 and not L[j].strip():
            j -= 1
        if L[j].strip() == PAGE:
            out.append(l.lstrip("# ").split("（")[0])
print(",".join(out))
PY
)
chk "各页顺序：交付 → 投入 → 成本 → token → 按模型拆分 → 本周明细" "$SEQ" "交付,投入,成本,token,按模型拆分,📋 本周明细"
chk "结论位：上周数据标题在第一个分页标记之前" \
    "$(awk '/^## 📊 上周数据/{h=NR} /break-before: page/{if(!p)p=NR} END{print (h && h<p) ? "yes" : "no"}' "$TMP/r.md")" "yes"
# 每张 10 周表都紧跟在图下面：图片行之后第一个非空行就是 10 周表的表头
AFTER=$(python3 - "$TMP/r.md" <<'PY'
import sys
L = open(sys.argv[1]).read().split("\n")
res = []
for i, l in enumerate(L):
    if l.startswith("!["):
        j = i + 1
        while j < len(L) and not L[j].strip():
            j += 1
        # 成本页按 issue 的顺序在图和表之间夹一句折算价值的算法，跳过它再看
        if L[j].startswith("**折算价值怎么算**"):
            j += 1
            while j < len(L) and not L[j].strip():
                j += 1
        res.append(l.split("/")[-1].split("-")[0] + ":" + ("table" if L[j].startswith("| 周 |") else L[j][:20]))
print(",".join(res))
PY
)
chk "四张图下面紧跟 10 周表（成本页中间只夹算法那一句）" "$AFTER" "delivery:table,effort:table,cost:table,token:table"
chk "成本页写明折算价值的算法"           "$(has '各类 token 用量 × 该模型公开的每百万 token 单价（美元），再相加')" "yes"
chk "交付页开头一句写周末未关闭存量"     "$(has '本周末仍未关闭的 issue 有')" "yes"
chk "本周那一行加粗（四张表各一行）"     "$(grep -c '^| \*\*1/6–1/12\*\* |' "$TMP/r.md")" "4"
chk "每张 10 周表末行是环比（4 张）"     "$(grep -c '^| 环比 |' "$TMP/r.md")" "4"
chk "旧的「本周 / 前一周 / 变化」小表没了" "$(has '| 指标 | 上周 | 前一周 | 变化 |')" "no"
chk "旧的 11 列逐周大表没了"             "$(has '| 净增代码行 | 讨论条数 |')" "no"

echo
echo "通过 $pass / 失败 $fail"
[ "$fail" -eq 0 ]
