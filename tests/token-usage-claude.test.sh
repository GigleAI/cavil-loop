#!/usr/bin/env bash
# 本侧的用量驱动（scripts/drivers/token-usage/claude.sh）。
#
# 跑法：bash tests/token-usage-claude.test.sh
# 依赖：bash / jq / date。造一份固定的假 transcript，**直接跑真实 driver**，不碰网络、
# 不读本机真实会话（HOME 指到临时目录）。
#
# 为什么要有这个文件（GigleTutor-Web#935）：
# 极少数 usage 记录的**顶层**计数被写成 0，真值只落在 `usage.iterations[]` 里。driver
# 原来只读顶层，于是整次调用的 input / output / cache read 按 0 计。本机 161 份 transcript、
# 88,400 条带 usage 的记录实测：87,649 条带 `iterations[]`（长度恒为 1），其中 87,647 条
# 顶层与明细逐字段相等，只有 2 条（同一个 requestId = 1 次调用）是这种形态。
# 这类错只会让数字悄悄变小、不会报错，所以要钉住。
#
# ⚠️ 金额口径已在 GigleTutor-Web#934 改掉：单价不再硬编，改为运行时反解 + 外部参照
# 交叉核对（scripts/weekly-report/price_solve.py）。本测试的 HOME 指到临时目录、
# 本机没有可反解的记账，所以价目走「参照兜底」这条路（Opus 5 = $5/$25/$0.5/5m $6.25/1h $10），
# 结果是确定的。输出里还多了 cost_state / cost_unknown_tokens 两个字段。
#
# 取值规则（逐字段零回退）：5 个求和项各走一次「顶层 > 0 用顶层，否则用明细同名项的合计」。
# 顶层和明细**永远不相加**。顶层的 `cache_creation_input_tokens` 是两档 TTL 的合计、
# 不是求和项，加进来等于 cache write 计两遍，所以它既不参与也不回退。
#
# 本测试要区分开的实现差异（每条都有专门的用例，缺一条就测不出来）：
#   顶层优先 vs 明细优先 / 逐字段回退 vs 整条回退 / 明细多条求和 vs 只取第一条 /
#   两档 TTL 各自回退（样本 A 管 5m、样本 B 管 1h）/ 两档各按各的倍率计价 vs 合并后统一计价
# ⚠️ 机器字段（--kv）里**不足一分**的金额保留到百万分之一（`0.002573` 这种），
#   两位小数只给人读的那一行用。提前舍入等于把可信状态**销毁在源头**：下游沿用
#   footer 时再也恢复不了（#934 交叉 review 第 8 轮）。恰好是 0 的仍写 `0.00`。
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
DRIVER="$REPO_DIR/scripts/drivers/token-usage/claude.sh"

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0
chk() { if [ "$2" = "$3" ]; then echo "  ✅ $1"; pass=$((pass+1)); else echo "  ❌ $1"; echo "       期望 $3"; echo "       实得 $2"; fail=$((fail+1)); fi; }

START=$(( $(date +%s) - 3600 ))
ts() { date -u -d "@$(( START + $1 ))" '+%Y-%m-%dT%H:%M:%S.000Z'; }

# ── fixture 构件 ────────────────────────────────────────────────────────────
# 一条 iterations 元素：<in> <out> <cache_read> <cc_total> <cc_5m> <cc_1h>
it1() {
    printf '{"type":"message","input_tokens":%s,"output_tokens":%s,"cache_read_input_tokens":%s,"cache_creation_input_tokens":%s,"cache_creation":{"ephemeral_5m_input_tokens":%s,"ephemeral_1h_input_tokens":%s}}' \
        "$1" "$2" "$3" "$4" "$5" "$6"
}
# usage 对象：<in> <out> <cache_read> <cc_total> <cc_5m> <cc_1h> [iterations 数组 JSON]
u() {
    printf '{"input_tokens":%s,"output_tokens":%s,"cache_read_input_tokens":%s,"cache_creation_input_tokens":%s,"cache_creation":{"ephemeral_5m_input_tokens":%s,"ephemeral_1h_input_tokens":%s}' \
        "$1" "$2" "$3" "$4" "$5" "$6"
    [ -n "${7:-}" ] && printf ',"iterations":%s' "$7"
    printf '}'
}
# 一条 assistant 记录：<ts 偏移秒> <requestId|-> <model> <usage JSON>
rec() {
    printf '{"type":"assistant","timestamp":"%s"' "$(ts "$1")"
    [ "$2" != "-" ] && printf ',"requestId":"%s"' "$2"
    printf ',"message":{"model":"%s","usage":%s}}\n' "$3" "$4"
}

# 每个用例一个独立 cwd —— driver 按 `pwd | tr / -` 找 transcript 目录，
# 同一目录下多份 jsonl 只会取 mtime 最新的那份，所以不能把用例堆在一起。
mk_case() {   # $1 = 用例名；jsonl 从 stdin 读
    local d="$TMP/wt/$1"; mkdir -p "$d"
    local enc; enc=$( cd "$d" && pwd | tr / - )
    mkdir -p "$TMP/.claude/projects/$enc"
    cat > "$TMP/.claude/projects/$enc/s.jsonl"
}
run() {   # $1 = 用例名；$2 = 模式（--kv 或空）；$3 = 起点（默认 $START）
    ( cd "$TMP/wt/$1" && HOME="$TMP" bash "$DRIVER" "${3:-$START}" ${2:-} )
}

# ── C1 正常记录：顶层与明细一致，不能把两份相加 ────────────────────────────
mk_case normal <<EOF
$(rec 10 req_normal claude-opus-5 "$(u 10 100 5000 200 0 200 "[$(it1 10 100 5000 200 0 200)]")")
EOF
chk "C1 顶层与明细一致时不重复累加" \
    "$(run normal --kv)" "in=10 out=100 cache_r=5000 cache_w=200 cost_usd=0.01 cost_state=full cost_unknown_tokens=0 price_source=solved price_status=unstable:0.01"
chk "C1 人读输出" \
    "$(run normal)" "10 input, 100 output, 5k cache read, 200 cache write (\$0.01)"

# ── C2 本 issue 的异常记录（真实数字）：顶层三项被清零，且同 requestId 写了两条 ──
#    改前：in/out/cache_r 全按 0 计，只有 cache write 还对（顶层 cache_creation 子对象没被清零）
ANOM=$(u 0 0 0 0 0 3005 "[$(it1 2 288 964830 3005 0 3005)]")
mk_case anomaly <<EOF
$(rec 10 req_zero claude-opus-5 "$ANOM")
$(rec 12 req_zero claude-opus-5 "$ANOM")
EOF
chk "C2 顶层被清零时按 iterations 计入（改前得 in=0 out=0 cache_r=0 cost_usd=0.09）" \
    "$(run anomaly --kv)" "in=2 out=288 cache_r=964830 cache_w=3005 cost_usd=0.52 cost_state=full cost_unknown_tokens=0 price_source=solved price_status=unstable:0.52"
chk "C2 同一 requestId 的两条仍然只计一次" \
    "$(run anomaly)" "2 input, 288 output, 964.8k cache read, 3k cache write (\$0.52)"

# ── C3 顶层非 0 且与明细不等 → 必须以顶层为准（区分「顶层优先」和「明细优先」）──
mk_case conflict <<EOF
$(rec 10 req_conflict claude-opus-5 "$(u 7 100 13 5 5 0 "[$(it1 70 555 130 50 50 0)]")")
EOF
chk "C3 顶层非 0 且与明细不等时以顶层为准（明细优先会得 out=555）" \
    "$(run conflict --kv)" "in=7 out=100 cache_r=13 cache_w=5 cost_usd=0.002573 cost_state=full cost_unknown_tokens=0 price_source=solved price_status=unstable:0.002573"

# ── C4 只有 output 顶层为 0 → 只回退这一项（区分「逐字段回退」和「整条回退」）──
mk_case partial <<EOF
$(rec 10 req_partial claude-opus-5 "$(u 7 0 13 9 4 5 "[$(it1 70 288 130 90 40 50)]")")
EOF
chk "C4 只回退为 0 的那一项（整条回退会得 in=70 cache_r=130 cache_w=90）" \
    "$(run partial --kv)" "in=7 out=288 cache_r=13 cache_w=9 cost_usd=0.01 cost_state=full cost_unknown_tokens=0 price_source=solved price_status=unstable:0.01"

# ── C5 iterations 两条 + 顶层全 0 → 明细要**求和**（不是只取第一条）──
TWO="[$(it1 1 10 100 7 3 4),$(it1 2 20 200 11 5 6)]"
mk_case multi_zero <<EOF
$(rec 10 req_multi0 claude-opus-5 "$(u 0 0 0 0 0 0 "$TWO")")
EOF
chk "C5 明细多条时求和（只取第一条会得 in=1 out=10 cache_r=100 cache_w=7）" \
    "$(run multi_zero --kv)" "in=3 out=30 cache_r=300 cache_w=18 cost_usd=0.001065 cost_state=full cost_unknown_tokens=0 price_source=solved price_status=unstable:0.001065"

# ── C6 iterations 两条 + 顶层非 0 → 明细完全不看 ──
mk_case multi_top <<EOF
$(rec 10 req_multiT claude-opus-5 "$(u 9 90 900 20 8 12 "$TWO")")
EOF
chk "C6 顶层非 0 时明细完全不参与" \
    "$(run multi_top --kv)" "in=9 out=90 cache_r=900 cache_w=20 cost_usd=0.002915 cost_state=full cost_unknown_tokens=0 price_source=solved price_status=unstable:0.002915"

# ── C7 样本 A：5m 顶层被清零、1h 顶层非 0 → 验证 **5m** 那档的回退 ──
#    顶层 cache_creation_input_tokens 故意写成假合计 99999999，它必须从不参与求和。
#    漏写 5m 回退 → cache_w=800000 / $204.00；两档合并按 1h → $216.00、按 5m → $202.50；
#    两档取反 → $207.00；1h 被明细顶掉（→5,000,000）→ $337.50。
A_IT="[$(it1 400000 900000 4000000 2100000 100000 2000000),$(it1 600000 1100000 6000000 3300000 300000 3000000)]"
mk_case ttl_5m <<EOF
$(rec 10 req_ttl5m claude-opus-5 "$(u 1000000 2000000 10000000 99999999 0 800000 "$A_IT")")
EOF
chk "C7 样本 A：5m 走回退、1h 保留顶层，两档各按各的倍率计价" \
    "$(run ttl_5m --kv)" "in=1000000 out=2000000 cache_r=10000000 cache_w=1200000 cost_usd=70.50 cost_state=full cost_unknown_tokens=0 price_source=solved price_status=unstable:70.50"
chk "C7 样本 A 人读输出" \
    "$(run ttl_5m)" "1m input, 2m output, 10m cache read, 1.2m cache write (\$70.50)"

# ── C8 样本 B：1h 顶层被清零、5m 顶层非 0 → 验证 **1h** 那档的回退（与 A 互为镜像）──
#    A 里 1h 顶层非 0、永远走「保留顶层」分支，所以只给 5m 加回退的实现也能过 A；
#    B 把这个缺口堵上：漏写 1h 回退 → cache_w=400000 / $187.50。
#    5m 被明细顶掉（→150,000）→ $206.81；两档取反 → $207.00。
B_IT="[$(it1 400000 900000 4000000 360000 60000 300000),$(it1 600000 1100000 6000000 590000 90000 500000)]"
mk_case ttl_1h <<EOF
$(rec 10 req_ttl1h claude-opus-5 "$(u 1000000 2000000 10000000 99999999 400000 0 "$B_IT")")
EOF
chk "C8 样本 B：1h 走回退、5m 保留顶层（漏写 1h 回退会得 cache_w=400000 / 187.50）" \
    "$(run ttl_1h --kv)" "in=1000000 out=2000000 cache_r=10000000 cache_w=1200000 cost_usd=70.50 cost_state=full cost_unknown_tokens=0 price_source=solved price_status=unstable:70.50"
chk "C8 样本 B 人读输出" \
    "$(run ttl_1h)" "1m input, 2m output, 10m cache read, 1.2m cache write (\$70.50)"

# ── C9 没有 iterations 的老记录：顶层就是真值，行为不能变 ──
mk_case legacy <<EOF
$(rec 10 req_legacy claude-opus-5 "$(u 2 3 254705 1919 0 1919)")
EOF
chk "C9 无 iterations 的老记录取值不变" \
    "$(run legacy --kv)" "in=2 out=3 cache_r=254705 cache_w=1919 cost_usd=0.15 cost_state=full cost_unknown_tokens=0 price_source=solved price_status=unstable:0.15"

# ── C10 本地合成条目 / 没有 usage 的条目：仍然计 0，不能被回退逻辑捞出数字 ──
mk_case synthetic <<EOF
$(rec 10 - "<synthetic>" "$(u 0 0 0 0 0 0)")
{"type":"assistant","timestamp":"$(ts 11)","message":{"model":"claude-opus-5"}}
{"type":"user","timestamp":"$(ts 12)","message":{"role":"user"}}
EOF
chk "C10 合成条目与无 usage 条目仍然计 0，且是**已知的零**（full，不是算不出）" \
    "$(run synthetic --kv)" "in=0 out=0 cache_r=0 cache_w=0 cost_usd=0.00 cost_state=full cost_unknown_tokens=0 price_source=solved"

# ── C11 窗口起点：起点之前的记录不计入 ──
mk_case window <<EOF
$(rec -100 req_old claude-opus-5 "$(u 9999999 9999999 9999999 9999999 9999999 0 "[$(it1 9999999 9999999 9999999 9999999 9999999 0)]")")
$(rec 10 req_new claude-opus-5 "$(u 5 50 500 60 0 60 "[$(it1 5 50 500 60 0 60)]")")
EOF
chk "C11 窗口起点之前的记录被排除" \
    "$(run window --kv)" "in=5 out=50 cache_r=500 cache_w=60 cost_usd=0.002125 cost_state=full cost_unknown_tokens=0 price_source=solved price_status=unstable:0.002125"

# ── C12 当前目录没有对应 transcript → 不输出（周报落「未知」兜底）──
mkdir -p "$TMP/wt/no_transcript"
chk "C12 没有 transcript 时不输出" \
    "$(run no_transcript --kv)" ""

# ── C13 同一次调用的多条消息跨窗口边界：只能算一次 ──────────────────────────
# 这是「先归组、再落窗口」与「先过滤、再去重」的分水岭：同一 requestId 的两条消息
# 分别落在窗口起点两侧时，旧顺序会让它在两个窗口里各算一次。规范时刻取组内**最早**，
# 所以这次调用整体落在**前**一个窗口，起点之后的窗口里一条都不该有。
mk_case straddle <<EOF
$(rec -5 req_straddle claude-opus-5 "$(u 100 200 300 400 0 400 "[$(it1 100 200 300 400 0 400)]")")
$(rec 5 req_straddle claude-opus-5 "$(u 100 200 300 400 0 400 "[$(it1 100 200 300 400 0 400)]")")
EOF
chk "C13 跨边界的同一调用不落进后一个窗口（旧顺序会把它算进来）；空窗口是已知的零" \
    "$(run straddle --kv "$START")" \
    "in=0 out=0 cache_r=0 cache_w=0 cost_usd=0.00 cost_state=full cost_unknown_tokens=0 price_source=solved"
chk "C13 把窗口起点挪到该调用之前，它只被计一次（不是两次）" \
    "$(run straddle --kv "$(( START - 10 ))")" \
    "in=100 out=200 cache_r=300 cache_w=400 cost_usd=0.01 cost_state=full cost_unknown_tokens=0 price_source=solved price_status=unstable:0.01"

# ── C14 该 worktree 的多个会话文件都要读到 ─────────────────────────────────
# 驱动原来只读 mtime 最新的那一个文件（ls -t | head -1），会话被 resume 成新文件时漏算。
mk_case multifile <<EOF
$(rec 10 req_mf_a claude-opus-5 "$(u 11 22 33 44 0 44 "[$(it1 11 22 33 44 0 44)]")")
EOF
cat > "$TMP/.claude/projects/$(printf '%s' "$TMP/wt/multifile" | tr / -)/older.jsonl" <<EOF
$(rec 11 req_mf_b claude-opus-5 "$(u 100 200 300 400 0 400 "[$(it1 100 200 300 400 0 400)]")")
EOF
chk "C14 两个会话文件的用量都计入（只读最新文件会得 in=11）" \
    "$(run multifile --kv)" \
    "in=111 out=222 cache_r=333 cache_w=444 cost_usd=0.01 cost_state=full cost_unknown_tokens=0 price_source=solved price_status=unstable:0.01"

# ── C15 混合模型：逐条按自己的模型计价，不是整段套一个单价 ──────────────────
# 本机无记账 → 价目走参照兜底：Opus 5 = 5/25/0.5/1h 10；Haiku 4.5 = 1/5/0.1/1h 2。
# 整段套第一条模型（Opus）会得 (1e6*5 + 1e6*25)*2/1e6 = $60；逐条计价应是 $30 + $6 = $36。
mk_case mixed <<EOF
$(rec 10 req_mix_a claude-opus-5 "$(u 1000000 1000000 0 0 0 0 "[$(it1 1000000 1000000 0 0 0 0)]")")
$(rec 11 req_mix_b claude-haiku-4-5 "$(u 1000000 1000000 0 0 0 0 "[$(it1 1000000 1000000 0 0 0 0)]")")
EOF
chk "C15 混合模型分段计价（整段套 Opus 会得 60.00）" \
    "$(run mixed --kv)" \
    "in=2000000 out=2000000 cache_r=0 cache_w=0 cost_usd=36.00 cost_state=full cost_unknown_tokens=0 price_source=solved price_status=unstable:36.00"

# ── C16 认不出的模型：不套价、计入缺价，金额如实偏低 ────────────────────────
mk_case unknownmodel <<EOF
$(rec 10 req_unk_a claude-opus-5 "$(u 1000000 0 0 0 0 0 "[$(it1 1000000 0 0 0 0 0)]")")
$(rec 11 req_unk_b some-future-model "$(u 1000000 0 0 0 0 0 "[$(it1 1000000 0 0 0 0 0)]")")
EOF
chk "C16 未知模型不套价，落 partial 并如实报出缺价 token" \
    "$(run unknownmodel --kv)" \
    "in=2000000 out=0 cache_r=0 cache_w=0 cost_usd=5.00 cost_state=partial cost_unknown_tokens=1000000 price_source=solved price_status=unstable:5.00"
chk "C16 人读输出写明金额偏低" \
    "$(run unknownmodel)" \
    "2m input, 0 output, 0 cache read, 0 cache write (\$5.00，部分用量未计价，金额偏低)"

echo
echo "通过 $pass / 失败 $fail"
[ "$fail" -eq 0 ]
