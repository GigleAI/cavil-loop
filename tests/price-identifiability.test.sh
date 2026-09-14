#!/usr/bin/env bash
# 单价反解的两道检验（scripts/weekly-report/price_solve.py）。
#
# 跑法：bash tests/price-identifiability.test.sh
# 依赖：bash / python3。造固定的假 transcript，**直接跑真实模块**，不碰网络、
# 不读本机真实会话（CLAUDE_PROJECTS_DIR 指到临时目录）。
#
# 为什么要有这个文件（GigleTutor-Web#934）：
# 原来 driver 硬编一张价目表，表过期了没人发现——实测那张表的 Opus 档是当前标价的 3 倍，
# 算出来的金额比 CLI 自记高 193%，而且这个错不报错、只让数字悄悄变大。改成运行时反解后，
# **「解出来了」和「解对了」是两件事**，两道检验缺一不可：
#   ① 数值稳定性闸门：这个系数被这批数据钉得住吗（噪声放大 + bootstrap 离散）
#   ② 外部参照交叉核对：解出来的数对不对
# ① **测不出系统性计数误差**——第 2 组就是那个反例：观测把 output 记少一半时解出的单价
# 偏 100%，却两条闸门全过、残差为零。所以准确性只能靠 ②。
#
# 本测试要区分开的实现差异（每条都有专门用例，缺一条就测不出来）：
#   稳定 vs 准确 / 两个稳定性判据缺一不可 / cache 两档能不能分开 /
#   四态各自的取值 / Q7 的 A 与 B 两个分支 / 偏差阈值的三个边界 / 样本不足与无流量
#
# 一律走 --no-cache：反解结果有按目录指纹的缓存，测试里同一秒换 fixture 会撞指纹。
#
# ⚠️ 造数注意：各列必须**独立变化**。若每列都与同一个序号成比例，设计矩阵秩为 1，
#    解出来的东西没有意义（写这个测试时先踩过一次）。
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
MOD="$REPO_DIR/scripts/weekly-report/price_solve.py"

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0
chk() { if [ "$2" = "$3" ]; then echo "  ✅ $1"; pass=$((pass+1)); else echo "  ❌ $1"; echo "       期望 $3"; echo "       实得 $2"; fail=$((fail+1)); fi; }

# 造一批会话。参数：<会话数> <观测 output 缩放> <input 真实单价> <5m占比0|半> [near_collinear]
# 真实单价固定为 input=$P_IN / output=$25 / cache_read=$0.5 / cache_write=$10。
# 各列用固定种子的伪随机独立生成，保证矩阵满秩。
mkset() {
    rm -rf "$TMP/projects"; mkdir -p "$TMP/projects"
    python3 - "$TMP/projects" "$1" "$2" "$3" "$4" "${5:-no}" <<'PY'
import json, os, random, sys
base, n, oscale, p_in, tier, collinear = sys.argv[1], int(sys.argv[2]), float(sys.argv[3]), \
    float(sys.argv[4]), sys.argv[5], sys.argv[6]
rnd = random.Random(20260914)
# 各列**独立**生成，且让四项对金额的贡献量级相当（否则贡献小的那项本来就不可识别，
# 测出来的「不可解」是 fixture 的问题不是被测逻辑的问题——写这个测试时先踩过一次）。
for k in range(n):
    i  = rnd.uniform(20, 100) * 1000          # 单价 5   → 约 $0.1–0.5
    o  = (i * 0.2 * (1 + rnd.gauss(0, 0.001)) if collinear == "yes"
          else rnd.uniform(4, 20) * 1000)     # 单价 25  → 约 $0.1–0.5
    cr = rnd.uniform(200, 1000) * 1000        # 单价 0.5 → 约 $0.1–0.5
    cw = rnd.uniform(10, 50) * 1000           # 单价 10  → 约 $0.1–0.5
    cost = (i * p_in + o * 25 + cr * 0.5 + cw * 10) / 1e6      # 真实单价算出的账
    obs_o = o * oscale                                          # 观测里的 output（可被人为记少）
    w5, w1 = (cw / 2, cw / 2) if tier == "half" else (0, cw)
    d = os.path.join(base, f"s{k}"); os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, f"s{k}.jsonl"), "w", encoding="utf-8") as f:
        f.write(json.dumps({"type": "assistant", "timestamp": "2026-09-01T00:00:00.000Z",
                            "requestId": f"r{k}", "message": {"model": "claude-opus-5", "usage": {
                                "input_tokens": 1, "output_tokens": 1,
                                "cache_creation": {"ephemeral_5m_input_tokens": int(w5),
                                                   "ephemeral_1h_input_tokens": int(w1)}}}}) + "\n")
        f.write(json.dumps({"type": "cost-state", "startTime": 0, "totalCostUSD": cost,
                            "modelUsage": {"claude-opus-5": {
                                "inputTokens": int(i), "outputTokens": int(obs_o),
                                "cacheReadInputTokens": int(cr),
                                "cacheCreationInputTokens": int(cw)}}}) + "\n")
PY
}

run()   { CLAUDE_PROJECTS_DIR="$TMP/projects" python3 "$MOD" --table --no-cache --policy "${1:-A}" 2>/dev/null; }
field() { python3 -c "import json,sys; print(json.load(sys.stdin)['models']['$1']['$2']['$3'])"; }
fnum()  { python3 -c "import json,sys; v=json.load(sys.stdin)['models']['$1']['$2']['$3']; print('none' if v is None else round(float(v),3))"; }
metric(){ python3 -c "import json,sys; print(round(json.load(sys.stdin)['models']['$1']['$2']['metrics']['$3'],4))"; }

echo "── 1. 正常可解：稳定 + 与参照一致 → corroborated ──"
mkset 30 1.0 5 full
OUT=$(run A)
chk "input  → corroborated"          "$(echo "$OUT" | field claude-opus-5 input status)"           "corroborated"
chk "output → corroborated"          "$(echo "$OUT" | field claude-opus-5 output status)"          "corroborated"
chk "cache_read → corroborated"      "$(echo "$OUT" | field claude-opus-5 cache_read status)"      "corroborated"
chk "cache_write_1h → corroborated"  "$(echo "$OUT" | field claude-opus-5 cache_write_1h status)"  "corroborated"
chk "取值用反解值（input ≈ 5）"       "$(echo "$OUT" | fnum claude-opus-5 input price)"             "5.0"
chk "本机 5m 无用量 → 该档不可解"     "$(echo "$OUT" | field claude-opus-5 cache_write_5m status)"  "unstable"

echo "── 2. 系统性计数误差：①全过，必须靠②判 disputed（核心反例）──"
mkset 30 0.5 5 full                  # 观测把 output 记少一半 → 解出 50（真实 25）
OUT=$(run A)
chk "output 解出约 50（真实 25）"     "$(echo "$OUT" | fnum claude-opus-5 output solved)"           "50.0"
chk "①噪声放大仍在阈值内（照样放行）" "$(echo "$OUT" | python3 -c "import json,sys; m=json.load(sys.stdin)['models']['claude-opus-5']['output']['metrics']; print('within' if m['amplify']<=5 and m['spread']<=0.05 else 'caught')")" "within"
chk "②交叉核对判 disputed"           "$(echo "$OUT" | field claude-opus-5 output status)"          "disputed"
chk "disputed 在 A 下取参照值 25"     "$(echo "$OUT" | fnum claude-opus-5 output price)"            "25.0"
chk "disputed 在 B 下取未知"          "$(run B | fnum claude-opus-5 output price)"                  "none"
chk "不静默选边：solved 与 reference 都留着" \
    "$(echo "$OUT" | python3 -c "import json,sys; v=json.load(sys.stdin)['models']['claude-opus-5']['output']; print('both' if v['solved'] and v['reference'] else 'lost')")" "both"
chk "其余项不受影响（cache_read 仍一致）" "$(echo "$OUT" | field claude-opus-5 cache_read status)"  "corroborated"

echo "── 3. 近共线：input 与 output 几乎成比例 → 两项都要拒 ──"
mkset 30 1.0 5 full yes
OUT=$(run A)
chk "近共线的 input 被判不可解"       "$(echo "$OUT" | field claude-opus-5 input status)"           "unstable"
chk "近共线的 output 被判不可解"      "$(echo "$OUT" | field claude-opus-5 output status)"          "unstable"
chk "噪声放大抓得住（> 阈值 5）"      "$(echo "$OUT" | python3 -c "import json,sys; m=json.load(sys.stdin)['models']['claude-opus-5']['input']['metrics']; print('caught' if m['amplify']>5 else 'missed')")" "caught"
chk "与它独立的 cache_read 不受牵连"  "$(echo "$OUT" | field claude-opus-5 cache_read status)"      "corroborated"

echo "── 4. 样本不足 / 本机无流量 ──"
mkset 3 1.0 5 full
OUT=$(run A)
chk "样本 < 8 → 不可解"              "$(echo "$OUT" | field claude-opus-5 input status)"           "unstable"
chk "理由写明样本不足"                "$(echo "$OUT" | field claude-opus-5 input note)"             "样本不足（3 < 8）"
chk "本机无流量的模型 → 不可解"       "$(echo "$OUT" | field claude-haiku-4-5 output status)"       "unstable"
chk "A 下无流量模型用参照兜底"        "$(echo "$OUT" | fnum claude-haiku-4-5 output price)"         "5.0"
chk "B 下无流量模型取未知"            "$(run B | fnum claude-haiku-4-5 output price)"               "none"

echo "── 5. cache 两档都有用量 → 合计里分不开，两档都不可解 ──"
mkset 30 1.0 5 half
OUT=$(run A)
chk "5m 档不可解"                    "$(echo "$OUT" | field claude-opus-5 cache_write_5m status)"  "unstable"
chk "1h 档也不可解"                  "$(echo "$OUT" | field claude-opus-5 cache_write_1h status)"  "unstable"
chk "理由写明分不开"                  "$(echo "$OUT" | field claude-opus-5 cache_write_1h note)"    "两档都有用量，合计里分不开"
chk "与 cache 档位无关的 output 照常"  "$(echo "$OUT" | field claude-opus-5 output status)"          "corroborated"

echo "── 6. 偏差阈值的三个边界 ──"
chk "偏差恰好等于阈值 → corroborated（等号算一致）" "$(python3 -c "
import sys; sys.path.insert(0, '$REPO_DIR/scripts/weekly-report')
import price_solve as ps
g = {it: dict(price=0.0, amplify=1.0, spread=0.0, stable=True, share=0.25, n=30) for it in ps.ITEMS}
g['input']['price'] = 5 * (1 + ps.MAX_DIVERGE)          # 相对偏差恰好 = MAX_DIVERGE
print(ps.classify('claude-opus-5', g, {'w5': 0, 'w1': 1}, 'A')['input']['status'])")" "corroborated"
chk "偏差略超阈值 → disputed" "$(python3 -c "
import sys; sys.path.insert(0, '$REPO_DIR/scripts/weekly-report')
import price_solve as ps
g = {it: dict(price=0.0, amplify=1.0, spread=0.0, stable=True, share=0.25, n=30) for it in ps.ITEMS}
g['input']['price'] = 5 * (1 + ps.MAX_DIVERGE * 1.001)
print(ps.classify('claude-opus-5', g, {'w5': 0, 'w1': 1}, 'A')['input']['status'])")" "disputed"
mkset 30 1.0 6.0 full                # 偏差 20% > 阈值
OUT=$(run A)
chk "偏差 20% > 阈值 → disputed"      "$(echo "$OUT" | field claude-opus-5 input status)"           "disputed"
chk "disputed 记录了偏差数值"         "$(echo "$OUT" | python3 -c "import json,sys; print(round(json.load(sys.stdin)['models']['claude-opus-5']['input']['divergence'],2))")" "0.2"
chk "参照缺失 → uncorroborated（不是 disputed）" \
    "$(PRICE_MIN_SESSIONS=8 CLAUDE_PROJECTS_DIR="$TMP/projects" python3 -c "
import json, sys, os
sys.path.insert(0, '$REPO_DIR/scripts/weekly-report')
import price_solve as ps
ps.REFERENCE['claude-opus-5'] = dict(ps.REFERENCE['claude-opus-5']); ps.REFERENCE['claude-opus-5']['input'] = 0
print(ps.build('A')['models']['claude-opus-5']['input']['status'])")" "uncorroborated"

echo "── 7. 可信度必须能跟着金额走（不能只活在求解器里）──"
# price_calls 是「求解器 → 周报」的唯一接口。它只返回金额的话，报告就再也分不出
# 这笔钱用的是已核对的价、还是用参照兜底的存疑价（#934 交叉 review 第 1 轮）。
py_trust() { PYTHONPATH="$REPO_DIR/scripts/weekly-report" python3 -c "$1" 2>&1; }
TBL='{"models":{"m1":{"input":{"price":10,"status":"corroborated"},
                      "output":{"price":20,"status":"disputed"},
                      "cache_read":{"price":1,"status":"uncorroborated"},
                      "cache_write_5m":{"price":5,"status":"unstable"},
                      "cache_write_1h":{"price":None,"status":"unstable"}}},
       "fast":{"m2":{"input":7}}}'
CALL='{"model":"m1","speed":"standard","priced":{"input":1000000,"output":1000000,
        "cache_read":1000000,"cache_write_5m":1000000,"cache_write_1h":1000000}}'
chk "金额按可信度分桶，桶的合计 == 总金额" \
  "$(py_trust "
import attribute as a
usd, unk, st, bs = a.price_calls([$CALL], $TBL)
print(f'{round(usd,2)}/{round(sum(bs.values()),2)}/{unk}/{st}')")" "36.0/36.0/1000000/partial"
chk "四态逐个进对桶（存疑 \$20 / 已核对 \$10 / 未核对 \$1 / 兜底 \$5）" \
  "$(py_trust "
import attribute as a
_,_,_,bs = a.price_calls([$CALL], $TBL)
print('/'.join(f'{k}={round(v,2)}' for k,v in sorted(bs.items())))")" \
  "corroborated=10.0/disputed=20.0/uncorroborated=1.0/unstable=5.0"
chk "加速档单独标出来（那是直接取参照价，没反解过）" \
  "$(py_trust "
import attribute as a
c = dict($CALL); c['model']='m2'; c['speed']='fast'
c['priced']={'input':1000000}
_,_,_,bs = a.price_calls([c], $TBL)
print(bs)")" "{'reference_only': 7.0}"
# 采集侧那份实现（price_calls）本来就跳过 token 为 0 的项，所以没踩到 driver 那个坑 ——
# 但规则必须被钉住，三份实现（price_calls + 两个 driver）不能再各走各的（#934 第 6 轮）。
chk "有价项用量为 0、实际用量全缺价 → none（不是 partial）" \
  "$(py_trust "
import attribute as a
c = {'model':'m1','speed':'standard','priced':{'input':0,'output':0,'cache_read':0,
     'cache_write_5m':1000000,'cache_write_1h':0}}
tbl = {'models':{'m1':{'input':{'price':10,'status':'corroborated'},
                      'output':{'price':20,'status':'corroborated'},
                      'cache_read':{'price':1,'status':'corroborated'},
                      'cache_write_5m':{'price':None,'status':'unstable'},
                      'cache_write_1h':{'price':None,'status':'unstable'}}},'fast':{}}
usd, unk, st, bs = a.price_calls([c], tbl)
print(f'{round(usd,2)}/{unk}/{st}/{bs}')")" \
  "0.0/1000000/none/{}"
chk "确实算出了一部分 → partial" \
  "$(py_trust "
import attribute as a
c = {'model':'m1','speed':'standard','priced':{'input':1000000,'output':0,'cache_read':0,
     'cache_write_5m':1000000,'cache_write_1h':0}}
tbl = {'models':{'m1':{'input':{'price':10,'status':'corroborated'},
                      'cache_write_5m':{'price':None,'status':'unstable'}}},'fast':{}}
usd, unk, st, _ = a.price_calls([c], tbl)
print(f'{round(usd,2)}/{unk}/{st}')")" \
  "10.0/1000000/partial"
chk "有用量、单价合法为 0 → full（按金额非零判会误伤这条）" \
  "$(py_trust "
import attribute as a
c = {'model':'m1','speed':'standard','priced':{'input':1000000}}
tbl = {'models':{'m1':{'input':{'price':0,'status':'corroborated'}}},'fast':{}}
usd, unk, st, _ = a.price_calls([c], tbl)
print(f'{round(usd,2)}/{unk}/{st}')")" \
  "0.0/0/full"
chk "合成条目不进任何桶（它不是真实调用）" \
  "$(py_trust "
import attribute as a
c = dict($CALL); c['model']='<synthetic>'
print(a.price_calls([c], $TBL)[3])")" "{}"

echo
echo "结果：$pass passed, $fail failed"
[ "$fail" -eq 0 ]
