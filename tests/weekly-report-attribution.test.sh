#!/usr/bin/env bash
# 调用认领 / 日志检验 / 合计取舍（scripts/weekly-report/attribute.py）。
#
# 跑法：bash tests/weekly-report-attribution.test.sh
# 依赖：bash / python3。全部用内存里的固定数据跑**真实函数**，不读本机日志。
#
# 为什么要有这个文件（GigleTutor-Web#934）：
# 驱动写 footer 时只拿得到自己的 start，看不见别的派工的窗口，跨派工的重叠只能在采集侧
# 消解。这里的三步必须**顺序固定、互不成环**：认领 → 逐派工取值 → 最后按重叠组取舍。
#
# 本测试要区分开的实现差异（每条都有专门用例，缺一条就测不出来）：
#   候选窗口有没有按 agent 过滤（派工身份不含 agent，不过滤就会把 Claude 的调用记到
#   codex 头上）/ 命中多个窗口时取 start 最晚还是最早 / 区间是不是半开 /
#   缺口用「窗口相交」推定还是用「被别人认领走的调用」这种逐条证据 /
#   四项 token 是不是都比 / 回退值与重算值能不能直接相加 / 历史 token 的截断下界
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
pass=0; fail=0
chk() { if [ "$2" = "$3" ]; then echo "  ✅ $1"; pass=$((pass+1)); else echo "  ❌ $1"; echo "       期望 $3"; echo "       实得 $2"; fail=$((fail+1)); fi; }
py() { PYTHONPATH="$REPO_DIR/scripts/weekly-report" python3 -c "$1" 2>&1; }

PRE='
import attribute as a
def W(key, agent, wt, s, e): return {"key":key,"agent":agent,"wt":wt,"start":s,"end":e}
def C(t, agent, wt, **tok):
    d={"in":0,"out":0,"cache_r":0,"cache_w":0}; d.update(tok)
    return {"t":t,"agent":agent,"wt":wt,"tok":d}
'

echo "── 1. 认领：agent 过滤 / start 最晚 / 半开区间 / 未归属 ──"
chk "跨 agent 不串台：Claude 的 t=12 归 Claude A，不归 codex B" \
  "$(py "$PRE
ws=[W('A','claude','wt1',0,20), W('B','codex','wt1',10,15)]
own,_,_ = a.claim([C(12,'claude','wt1',out=7)], ws)
print('A' if own['A']['n']==1 else 'B' if own['B']['n']==1 else 'lost')")" "A"
chk "不加 agent 过滤就会记到 codex 头上（反证）" \
  "$(py "$PRE
ws=[W('A','claude','wt1',0,20), W('B','codex','wt1',10,15)]
c=C(12,'claude','wt1',out=7)
cands=[w for w in ws if w['start']<=c['t']<w['end']]          # 故意不按 agent 过滤
print(max(cands,key=lambda w:w['start'])['key'])")" "B"
chk "同 agent 命中多个 → 取 start 最晚（t=12 归 B）" \
  "$(py "$PRE
ws=[W('A','claude','wt1',0,20), W('B','claude','wt1',10,15)]
own,_,_ = a.claim([C(12,'claude','wt1',out=7)], ws)
print('B' if own['B']['n']==1 else 'A')")" "B"
chk "只被 A 覆盖时归 A（t=17 不在 B 里）" \
  "$(py "$PRE
ws=[W('A','claude','wt1',0,20), W('B','claude','wt1',10,15)]
own,_,_ = a.claim([C(17,'claude','wt1',out=7)], ws)
print('A' if own['A']['n']==1 else 'B')")" "A"
chk "半开区间：恰好压在 end 上的调用不归该窗口" \
  "$(py "$PRE
ws=[W('A','claude','wt1',0,20), W('B','claude','wt1',20,30)]
own,_,un = a.claim([C(20,'claude','wt1',out=7)], ws)
print('B' if own['B']['n']==1 else 'A' if own['A']['n']==1 else 'lost')")" "B"
chk "落不进任何窗口 → 未归属，不摊给任何派工" \
  "$(py "$PRE
ws=[W('A','claude','wt1',0,10)]
own,_,un = a.claim([C(50,'claude','wt1',out=7)], ws)
print(f\"{own['A']['n']}/{list(un.values())[0]['n']}\")")" "0/1"

echo "── 2. 日志检验：缺口要有证据，不能靠窗口相交推定 ──"
chk "窗口相交但交集无调用 + 丢了非重叠区的文件 → shortfall（X=0）" \
  "$(py "$PRE
ws=[W('A','claude','wt1',0,20), W('B','claude','wt1',10,15)]
# 原有 t=2 与 t=17 两次调用，t=2 所在文件被删；重叠区 [10,15) 里一条都没有
own,frn,_ = a.claim([C(17,'claude','wt1',out=100)], ws)
print(a.log_check({'in':0,'out':200,'cache_r':0,'cache_w':0}, own['A']['tok'], frn['A']['tok'], True, 1))")" "shortfall_detected"
chk "确有重叠认领 + 另有丢失 → 重叠被 X 解释，剩余缺口仍降级" \
  "$(py "$PRE
ws=[W('A','claude','wt1',0,20), W('B','claude','wt1',10,15)]
own,frn,_ = a.claim([C(12,'claude','wt1',out=100)], ws)   # 被 B 拿走，计进 A 的 X
print(a.log_check({'in':0,'out':300,'cache_r':0,'cache_w':0}, own['A']['tok'], frn['A']['tok'], True, 1))")" "shortfall_detected"
chk "重叠全部被 X 解释、没有剩余缺口 → 未检出缺失" \
  "$(py "$PRE
ws=[W('A','claude','wt1',0,20), W('B','claude','wt1',10,15)]
own,frn,_ = a.claim([C(12,'claude','wt1',out=100)], ws)
print(a.log_check({'in':0,'out':100,'cache_r':0,'cache_w':0}, own['A']['tok'], frn['A']['tok'], True, 1))")" "no_shortfall_detected"
chk "只丢 in（其余都够）也要检出 —— 四项都比" \
  "$(py "$PRE
print(a.log_check({'in':50,'out':0,'cache_r':0,'cache_w':0},
                  {'in':0,'out':999,'cache_r':999,'cache_w':999},
                  {'in':0,'out':0,'cache_r':0,'cache_w':0}, True, 1))")" "shortfall_detected"
chk "只丢 cache_w 也要检出" \
  "$(py "$PRE
print(a.log_check({'in':0,'out':0,'cache_r':0,'cache_w':50},
                  {'in':9,'out':9,'cache_r':9,'cache_w':0},
                  {'in':0,'out':0,'cache_r':0,'cache_w':0}, True, 1))")" "shortfall_detected"
chk "被删的高价调用被新增调用补齐 token → 只能说未检出缺失" \
  "$(py "$PRE
print(a.log_check({'in':10,'out':10,'cache_r':10,'cache_w':10},
                  {'in':10,'out':10,'cache_r':10,'cache_w':10},
                  {'in':0,'out':0,'cache_r':0,'cache_w':0}, True, 1))")" "no_shortfall_detected"
chk "日志目录不存在 → unknown" \
  "$(py "$PRE
print(a.log_check({'in':1,'out':1,'cache_r':1,'cache_w':1},
                  {'in':0,'out':0,'cache_r':0,'cache_w':0},
                  {'in':0,'out':0,'cache_r':0,'cache_w':0}, False, 0))")" "unknown"
chk "有文件但一条都解析不出、而记录非零 → unknown" \
  "$(py "$PRE
print(a.log_check({'in':1,'out':1,'cache_r':1,'cache_w':1},
                  {'in':0,'out':0,'cache_r':0,'cache_w':0},
                  {'in':0,'out':0,'cache_r':0,'cache_w':0}, True, 0))")" "unknown"
chk "记录全零且重算也为零 → true_zero（不是 unknown）" \
  "$(py "$PRE
print(a.log_check({'in':0,'out':0,'cache_r':0,'cache_w':0},
                  {'in':0,'out':0,'cache_r':0,'cache_w':0},
                  {'in':0,'out':0,'cache_r':0,'cache_w':0}, True, 1))")" "true_zero"

echo "── 3. 历史 token 是 floor 截断，按截断下界比 ──"
chk "53.5k 的下界是 53500" "$(py "$PRE
print(a.floor_lower_bound('53.5','k'))")" "53500"
chk "4.8m 的下界是 4800000" "$(py "$PRE
print(a.floor_lower_bound('4.8','m'))")" "4800000"
chk "重算到 53500 → 未检出缺失（按 53450 那种四舍五入假设会放过真实缺失）" \
  "$(py "$PRE
r=a.parse_token_line('token 84 input, 53.5k output, 4.8m cache read, 166.7k cache write')
t={'in':84,'out':53500,'cache_r':4800000,'cache_w':166700}
z={k:0 for k in a.ITEMS}
print(a.log_check(r,t,z,True,1))")" "no_shortfall_detected"
chk "重算到 53499（比截断下界少 1）→ 检出缺失" \
  "$(py "$PRE
r=a.parse_token_line('token 84 input, 53.5k output, 4.8m cache read, 166.7k cache write')
t={'in':84,'out':53499,'cache_r':4800000,'cache_w':166700}
z={k:0 for k in a.ITEMS}
print(a.log_check(r,t,z,True,1))")" "shortfall_detected"

echo "── 4. 合计取舍：回退值与重算值不能直接相加 ──"
chk "孤立派工回退也进合计" \
  "$(py "$PRE
ws=[W('A','claude','wt1',0,10)]
ok,_=a.summable(ws,{'A':'original'}); print(ok['A'])")" "True"
chk "重叠组内一条回退、一条重算 → 整组不进合计（这是 \$2 被算成 \$3 的那个反例）" \
  "$(py "$PRE
ws=[W('A','claude','wt1',0,20), W('B','claude','wt1',10,15)]
ok,_=a.summable(ws,{'A':'original','B':'recomputed'}); print(f\"{ok['A']}/{ok['B']}\")")" "False/False"
chk "重叠组内全部重算 → 整组进合计" \
  "$(py "$PRE
ws=[W('A','claude','wt1',0,20), W('B','claude','wt1',10,15)]
ok,_=a.summable(ws,{'A':'recomputed','B':'recomputed'}); print(f\"{ok['A']}/{ok['B']}\")")" "True/True"
chk "重叠组内全部回退 → 也不进合计（footer 之间本来就互相重复）" \
  "$(py "$PRE
ws=[W('A','claude','wt1',0,20), W('B','claude','wt1',10,15)]
ok,_=a.summable(ws,{'A':'original','B':'original'}); print(f\"{ok['A']}/{ok['B']}\")")" "False/False"
chk "不相交的两条各自成组，互不牵连" \
  "$(py "$PRE
ws=[W('A','claude','wt1',0,10), W('B','claude','wt1',20,30)]
ok,g=a.summable(ws,{'A':'original','B':'recomputed'})
print(f\"{ok['A']}/{ok['B']}/{g['A']!=g['B']}\")")" "True/True/True"
chk "不同 agent 的窗口即使时间相交也不同组" \
  "$(py "$PRE
ws=[W('A','claude','wt1',0,20), W('B','codex','wt1',10,15)]
ok,g=a.summable(ws,{'A':'original','B':'recomputed'})
print(f\"{g['A']!=g['B']}/{ok['A']}/{ok['B']}\")")" "True/True/True"
chk "三条链式相交 → 同一组，含回退则整组不进" \
  "$(py "$PRE
ws=[W('A','claude','wt1',0,10), W('B','claude','wt1',5,15), W('C','claude','wt1',12,20)]
ok,g=a.summable(ws,{'A':'recomputed','B':'recomputed','C':'original'})
print(f\"{len(set(g.values()))}/{ok['A']}\")")" "1/False"

echo "── 5. 加载器与驱动同口径：逐字段零回退（GitHub#935 / #934 交叉 review 第 1 轮）──"
# 同一份 transcript 同时喂给**真实 driver**（claude.sh）和**真实加载器**
# （attribute.load_claude_calls），断言五个求和项完全一致。
#
# 为什么用「两边对拍」而不是逐个断言数值：这个 bug 的本质是**两套代码各读各的**——
# driver 有 zf 零回退、加载器只读顶层。任何一边以后再改读法，对拍立刻红；而逐条写死
# 期望值只能覆盖当时想到的那几种记录。
#
# 五项各有一个「顶层写成 0、真值在 iterations[] 里」的镜像样本；cache 的 5m / 1h
# 必须分开验（它俩单价不同，混成一项就测不出档位错配）。
XT=$(mktemp -d); trap 'rm -rf "$XT"' EXIT
XWT="$XT/wt/issue-7"; mkdir -p "$XWT"
XENC=$(printf '%s' "$XWT" | tr / -)
mkdir -p "$XT/projects/$XENC"
NOW=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
# $1 reqid  $2..$6 顶层 in/out/cache_r/5m/1h  $7..$11 iterations 里同名项
xrec() {
    printf '{"type":"assistant","requestId":"%s","uuid":"%s","timestamp":"%s","message":{"model":"claude-opus-5","usage":{"input_tokens":%s,"output_tokens":%s,"cache_read_input_tokens":%s,"cache_creation":{"ephemeral_5m_input_tokens":%s,"ephemeral_1h_input_tokens":%s},"iterations":[{"input_tokens":%s,"output_tokens":%s,"cache_read_input_tokens":%s,"cache_creation":{"ephemeral_5m_input_tokens":%s,"ephemeral_1h_input_tokens":%s}}]}}}\n' \
        "$1" "$1" "$NOW" "$2" "$3" "$4" "$5" "$6" "$7" "$8" "$9" "${10}" "${11}"
}
{
    xrec zf_in   0 0 0 0 0    1111 0 0 0 0          # 只有 input 被清零
    xrec zf_out  0 0 0 0 0    0 2222 0 0 0          # 只有 output 被清零
    xrec zf_cr   0 0 0 0 0    0 0 3333 0 0          # 只有 cache_read 被清零
    xrec zf_5m   0 0 0 0 0    0 0 0 4444 0          # 只有 cache_write 5m 被清零
    xrec zf_1h   0 0 0 0 0    0 0 0 0 5555          # 只有 cache_write 1h 被清零
    xrec top_win 10 20 30 40 50   999 999 999 999 999   # 顶层非 0 → 明细完全不看
} > "$XT/projects/$XENC/s.jsonl"

DRV=$(cd "$XWT" && CLAUDE_PROJECTS_DIR="$XT/projects" \
      bash "$REPO_DIR/scripts/drivers/token-usage/claude.sh" 0 --kv \
      | grep -o 'in=[0-9]* out=[0-9]* cache_r=[0-9]* cache_w=[0-9]*')
LOADER=$(CLAUDE_PROJECTS_DIR="$XT/projects" py "
import attribute as a
calls,_ = a.load_claude_calls('$XWT')
t={'in':0,'out':0,'cache_r':0,'cache_w':0}
for c in calls:
    for k in t: t[k]+=c['tok'][k]
print('in=%(in)d out=%(out)d cache_r=%(cache_r)d cache_w=%(cache_w)d' % t)")
# 期望：in 1111+10 / out 2222+20 / cache_r 3333+30 / cache_w 4444+5555+40+50
chk "加载器读出的五项 == 驱动读出的五项（改前加载器全读成 0）" "$LOADER" "$DRV"
chk "两边一致的那个值本身也对（不是「一起错成 0」）" \
    "$DRV" "in=1121 out=2242 cache_r=3363 cache_w=10089"
chk "顶层非 0 的那条：明细不参与（否则会变成 999 那一串）" \
    "$(CLAUDE_PROJECTS_DIR="$XT/projects" py "
import attribute as a
calls,_ = a.load_claude_calls('$XWT')
c=[x for x in calls if x['tok']['in']==10][0]
print(c['tok'])")" \
    "{'in': 10, 'out': 20, 'cache_r': 30, 'cache_w': 90}"
chk "计价用的 5m / 1h 分开保留（单价不同，不能合成一项）" \
    "$(CLAUDE_PROJECTS_DIR="$XT/projects" py "
import attribute as a
calls,_ = a.load_claude_calls('$XWT')
p5=sum(c['priced']['cache_write_5m'] for c in calls)
p1=sum(c['priced']['cache_write_1h'] for c in calls)
print(f'{p5}/{p1}')")" "4484/5605"

echo
echo "结果：$pass passed, $fail failed"
[ "$fail" -eq 0 ]
