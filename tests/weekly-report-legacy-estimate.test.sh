#!/usr/bin/env bash
# 9/14 口径切换前的历史记账：金额按记录里的 token × 现行 Opus 价重估，再抵掉重复计；
# 同时每周汇总四项 token，供趋势图出「token 用量」面板。
#
# 跑法：bash tests/weekly-report-legacy-estimate.test.sh
# 依赖：python3。自造假 `gh` 喂真实评论正文，**走完整链路**
# record.extract → collect.main → report.py / render.py，不预填任何汇总字段。
#
# 为什么要有这个文件：历史记账行的金额是旧驱动写死的——所有 Opus 一律按 Opus 4 的
# 价（输入 $15 / 输出 $75 / 缓存读 $1.5），而且同一次 API 调用的多条日志逐条累加
# （按 requestId 去重后的 1.68 倍，53 个会话中位数）。这些原值直接进趋势图，切换周
# 前后成本差出 3~5 倍，读起来像「突然省了一大笔钱」。原值又改不回去（本机日志多已清掉），
# 只能用记录里留下的 token 数按现行价目估一遍，并在报告里写明是估算。
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
COLLECT="$REPO_DIR/scripts/weekly-report/collect.py"
REPORT="$REPO_DIR/scripts/weekly-report/report.py"
RENDER="$REPO_DIR/scripts/weekly-report/render.py"

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0
chk() { if [ "$2" = "$3" ]; then echo "  ✅ $1"; pass=$((pass+1)); else echo "  ❌ $1 (期望 '$3'，实得 '$2')"; fail=$((fail+1)); fi; }

W=2025-01-06
SW=2025-01-06

marker() {   # hh cost_kv tokens_kv
    printf '干完了。\n\n<!-- agent-metrics agent=claude wt=10 start=%sT%s:00:00+08:00 end=%sT%s:10:00+08:00 wall_secs=600 %s %s-->' \
        "$W" "$1" "$W" "$1" "$3" "$2"
}
legacy() {   # hh tokenline
    printf '干完了。\n\n---\n⏱️ 开始 %s %s:00:00 · 完工 %s:10:00 · 耗时 10m 0s\n%s\n' "$W" "$1" "$1" "$2"
}
py_json() { python3 -c "import json,sys; print(json.dumps(sys.stdin.read()))"; }

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

run() {
    local n=0 rows=()
    for body in "$@"; do
        n=$((n+1))
        rows+=("{\"id\":$n,\"issue_url\":\"https://api.github.com/repos/acme/widget/issues/10\",\"user\":{\"login\":\"acme-bot\"},\"created_at\":\"${W}T0${n}:00:00Z\",\"body\":$(printf '%s' "$body" | py_json)}")
    done
    printf '[%s]' "$(IFS=,; echo "${rows[*]}")" > "$TMP/comments.json"
    python3 "$COLLECT" --repo acme/widget --out "$TMP/d.json" --weeks 2 --week-of "$W" \
        --switch-week "$SW" >/dev/null 2>"$TMP/err.log" \
        || { echo "collect.py 跑挂了："; cat "$TMP/err.log"; exit 1; }
    python3 "$REPORT" --data "$TMP/d.json" --out "$TMP/r.md" \
        --asset-url-base x --rev y >/dev/null 2>&1 \
        || { echo "report.py 跑挂了"; exit 1; }
    python3 "$RENDER" --data "$TMP/d.json" --out-dir "$TMP/html" \
        --asset-url-base x --rev y >/dev/null 2>"$TMP/err.log" \
        || { echo "render.py 跑挂了："; cat "$TMP/err.log"; exit 1; }
}
q()   { python3 -c "
import json; w=json.load(open('$TMP/d.json'))['weekly']['$W']
print($1)"; }
has() { grep -qF "$1" "$TMP/r.md" && echo yes || echo no; }

# Opus 现行参照价（输入 5 / 输出 25 / 缓存读 0.5 / 缓存写 1h 10，每百万 token），
# 每项 1m token → 40.5 美元；再除以 1.68 → 24.107…
echo "— 历史记账行：按 token × 现行 Opus 价 ÷ 1.68 重估，不用旧驱动写死的金额 —"
run "$(legacy 10 'token 1m input, 1m output, 1m cache read, 1m cache write ($999.00)')"
chk "金额是重估值 24.11（不是原值 999）"   "$(q "round(w['cost'],2)")"        "24.11"
chk "记作「估算」来源"                     "$(q "int(w['src_estimated'])")"   "1"
chk "不再记作「沿用原值」"                 "$(q "int(w['src_original'])")"    "0"
chk "仍算「有金额」"                       "$(q "int(w['cost_records'])")"    "1"
chk "可信度桶记在「估算」下"               "$(q "round(w['price_usd_estimated'],2)")" "24.11"
chk "token 也按 1.68 抵掉重复计：输出"     "$(q "int(w['tok_out'])")"         "595238"
chk "缓存读取"                             "$(q "int(w['tok_cache_r'])")"     "595238"
chk "报告口径说明写明是估算"               "$(has '按记录里的 token 数重估')" "yes"
# token 用量：单独一张图（token.html）、两块面板，每块各一条纵轴（GigleTutor-Web#1023）。
#   · 双轴 → 两条轴刻度差几十倍，读图的人拿高度一比，把「读取是写入的几十倍」读成「读取反而很少」；
#   · 四项堆进一根柱 → 缓存读取占 95% 以上，另外三项只剩柱底一条线（维护者：「完全被缓存读取占据了」）。
# 所以「输入 + 缓存写入 + 输出」堆一块、「缓存读取」单独一块。样本四项**互不相等**
# （1 / 2 / 3 / 155M），双轴、四项堆叠、漏项、顺序或合计算错，都会在下面某一条上露出来。
tok2() {   # $1 每周 tok_cache_r；$2 要检查的项
    python3 - "$TMP/d.json" "$TMP/u.json" "$1" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
for w in d["weekly"].values():
    w.update(tok_in=1e6, tok_cache_w=2e6, tok_out=3e6, tok_cache_r=float(sys.argv[3]))
json.dump(d, open(sys.argv[2], "w"))
PY
    python3 "$RENDER" --data "$TMP/u.json" --out-dir "$TMP/u" --asset-url-base x --rev y >/dev/null 2>&1 \
        || { echo "render 跑挂了"; return; }
    python3 - "$TMP/u" "$2" "$1" <<'PY'
import os, re, sys
d, what, cr = sys.argv[1], sys.argv[2], float(sys.argv[3]) / 1e6
if not os.path.exists(f"{d}/token.html"):
    print("no token.html"); sys.exit()
h = open(f"{d}/token.html").read()
starts = [m.start() for m in re.finditer(r'<text x="\d+" y="\d+" class="ttl">', h)] + [h.index("</svg>")]
P = []
for i in range(len(starts) - 1):
    seg = h[starts[i]:starts[i + 1]]
    by = {}
    # 柱块：不带圆角的 rect（堆叠段）或带 rx 的单柱；图例方块宽高都是 11，排除
    for x, y, w, hh, col in re.findall(r'<rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)" fill="([^"]+)"', seg):
        if w == "11" and hh == "11":
            continue
        by.setdefault(col, []).append((float(y), float(hh)))
    P.append({"ttl": re.search(r'class="ttl">([^<]*)<', seg).group(1),
              "sub": re.search(r'class="sub">([^<]*)<', seg).group(1),
              "by": by, "seg": seg,
              "left": re.findall(r'class="ax" text-anchor="end">([^<]*)<', seg),
              "right": re.findall(r'class="ax" text-anchor="start">([^<]*)<', seg),
              "tops": re.findall(r'class="val" text-anchor="middle" fill="[^"]+">([^<]*)<', seg)})
IN, CW, OUT, CR = "#2a78d6", "#c99332", "#eb6834", "#4a3aa7"
num = lambda t: float(t[:-1]) * (1000 if t[-1] == "B" else 1)
ok_total = lambda p, tot: bool(p["tops"]) and all(abs(num(t) - tot) <= 0.06 * tot for t in p["tops"]) and num(p["left"][-1]) >= tot
if what == "split":        # 两块：A 只有三项（无缓存读取），B 只有缓存读取；每项每周一块
    n = len(P[0]["by"].get(IN, [])) if P else 0
    print(len(P) == 2 and n > 0
          and set(P[0]["by"]) == {IN, CW, OUT} and all(len(P[0]["by"][c]) == n for c in (IN, CW, OUT))
          and set(P[1]["by"]) == {CR} and len(P[1]["by"][CR]) == n)
elif what == "ratio":      # A 的三段高度 1:2:3，从下往上依次是 输入 / 缓存写入 / 输出
    hs = [P[0]["by"][c][0][1] for c in (IN, CW, OUT)]
    ys = [P[0]["by"][c][0][0] for c in (IN, CW, OUT)]
    print(all(abs(hs[k] / hs[0] - v) < 0.05 * v for k, v in enumerate([1, 2, 3])) and ys == sorted(ys, reverse=True))
elif what == "single":     # 两块都只有一条纵轴：没有右轴刻度、没有折线
    print(all(not p["right"] and "<polyline" not in p["seg"] and "右轴" not in p["ttl"] + p["sub"] for p in P))
elif what == "total":      # A 柱顶 = 三项合计 6M；B 柱顶 = 缓存读取；轴上界都容得下
    print(ok_total(P[0], 6.0) and ok_total(P[1], cr))
elif what == "units":      # 每块图上用到的后缀都在本块副标题里有解释，且没有写死单位
    good = True
    for p in P:
        used = {v[-1] for v in p["left"] + p["tops"] if v[-1] in "MB"}
        expl = {u for u, word in (("M", "M＝百万"), ("B", "B＝十亿")) if word in p["sub"]}
        good &= bool(used) and used <= expl and not re.search(r"单位 ?[MB]|百万 token", p["ttl"] + p["sub"])
    print(good)
PY
}
chk "token 单独成图：两块面板，三项一块、缓存读取一块" "$(tok2 155000000 split)"  "True"
chk "三项堆叠高度 1:2:3，顺序 输入 → 缓存写入 → 输出"    "$(tok2 155000000 ratio)"  "True"
chk "两块都只有一条纵轴：无右轴刻度、无折线"            "$(tok2 155000000 single)" "True"
chk "柱顶：三项合计 6M、缓存读取 155M，轴上界容得下"    "$(tok2 155000000 total)"  "True"
# 单位说明必须跟图上实际出的后缀一致（PR #54 交叉 review 第 1 轮）：fmt_m 不足 1000M 出 M、
# 够了出 B，同一根轴上可以并存。阈值以下、跨阈值各一个样本。
chk "缓存读取 155M（全是 M）：单位说明与图一致"         "$(tok2 155000000 units)"  "True"
chk "缓存读取 2.0B（M / B 并存）：单位说明与图一致"     "$(tok2 2000000000 units)" "True"
chk "缓存读取 2.0B：柱顶数字与轴上界"                   "$(tok2 2000000000 total)" "True"
chk "投入面不再含 token 面板（已单独成图）" "$(grep -c 'token 用量' "$TMP/html/effort.html" | tr -d ' ')" "0"
chk "真实链路也出了 token 图"             "$(grep -c 'class="ttl">缓存读取' "$TMP/html/token.html" 2>/dev/null | tr -d ' ' | sed 's/^[1-9][0-9]*$/yes/')" "yes"

echo
echo "— 历史记账行没写金额：保持「没有金额」，不凭 token 补一个出来 —"
run "$(legacy 10 'token 1m input, 1m output')"
chk "没有金额"                             "$(q "int(w['cost_records'])")"    "0"
chk "不算估算"                             "$(q "int(w['src_estimated'])")"   "0"
chk "token 照样计入趋势（抵重后）"         "$(q "int(w['tok_out'])")"         "595238"

echo
echo "— 切换后的机器记录：金额、token 都原样，不做重估 —"
run "$(marker 10 'cost_usd=10.00 ' 'in=100 out=2000000 cache_r=300 cache_w=400')"
chk "金额原样 10"                          "$(q "round(w['cost'],2)")"        "10.0"
chk "不算估算"                             "$(q "int(w['src_estimated'])")"   "0"
chk "token 原样：输出"                     "$(q "int(w['tok_out'])")"         "2000000"
chk "token 原样：输入"                     "$(q "int(w['tok_in'])")"          "100"
chk "报告不提重估"                         "$(has '按记录里的 token 数重估')" "no"

echo
echo "通过 $pass / 失败 $fail"
[ "$fail" -eq 0 ]
