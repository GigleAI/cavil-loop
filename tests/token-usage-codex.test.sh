#!/usr/bin/env bash
# 交叉 review 那一侧的用量驱动（scripts/drivers/token-usage/codex.sh）。
#
# 跑法：bash tests/token-usage-codex.test.sh
# 依赖：bash / jq / date。造一份固定的假会话日志，**直接跑真实 driver**，不碰网络、
# 不读本机真实 codex 会话（HOME 指到临时目录）。
#
# 为什么要有这个文件（GigleTutor-Web#932 交叉 review 第 4 轮）：
# codex 的单次用量记录里 `reasoning_output_tokens` 是 `output_tokens` 的**子项**，
# 不是另一份输出。本机 223 个会话、3119 条记录实测 `total == input + output` 全部成立、
# 没有一条 `reasoning > output`。原来把两者相加 = 思考部分算两遍，多计 7.7% 的输出
# token；配了单价还会照这个虚数计费。这类错只会让数字悄悄变大，不会报错，所以要钉住。
#
# 本测试的日志刻意让 **reasoning 非零**且 `total = input + output`，覆盖 driver 的
# 三条输出路径：人读输出 / `--kv` / 配置单价后的金额。
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
DRIVER="$REPO_DIR/scripts/drivers/token-usage/codex.sh"

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0
chk() { if [ "$2" = "$3" ]; then echo "  ✅ $1"; pass=$((pass+1)); else echo "  ❌ $1"; echo "       期望 $3"; echo "       实得 $2"; fail=$((fail+1)); fi; }

START=$(( $(date +%s) - 3600 ))
ts() { date -u -d "@$(( START + $1 ))" '+%Y-%m-%dT%H:%M:%S.000Z'; }

MINE="$TMP/worktree/issue-1"      # driver 用 $(pwd) 认领会话
OTHER="$TMP/worktree/issue-2"
mkdir -p "$MINE" "$OTHER" "$TMP/.codex/sessions/2026/09/14"

# 单条用量记录：input / cached / cache_write / output / reasoning，total = input + output
rec() {
    printf '{"type":"token_usage_record","timestamp":"%s","payload":{"usage":{"input_tokens":%s,"cached_input_tokens":%s,"cache_write_input_tokens":%s,"output_tokens":%s,"reasoning_output_tokens":%s,"total_tokens":%s}}}\n' \
        "$(ts "$1")" "$2" "$3" "$4" "$5" "$6" "$(( $2 + $5 ))"
}

# ── 会话 A：属于本 worktree，两条窗口内记录 + 一条窗口前的记录（必须被排除） ──
{
    printf '{"type":"session_meta","timestamp":"%s","payload":{"cwd":"%s"}}\n' "$(ts -200)" "$MINE"
    rec -100 9999999 0 0 9999999 9999999      # 窗口之前：不能计入
    rec   10 1000000 400000 50000 300000 120000
    rec   20 2000000 1000000 0   700000 300000
} > "$TMP/.codex/sessions/2026/09/14/rollout-A.jsonl"

# ── 会话 B：别的 worktree，整份都不能计入 ──
{
    printf '{"type":"session_meta","timestamp":"%s","payload":{"cwd":"%s"}}\n' "$(ts -200)" "$OTHER"
    rec 15 5000000 0 0 5000000 2000000
} > "$TMP/.codex/sessions/2026/09/14/rollout-B.jsonl"

# ── 累计口径的字段必须被忽略（求和它们就是重复计） ──
printf '{"type":"turn_token_usage","timestamp":"%s","payload":{"usage":{"input_tokens":8888888,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":8888888,"reasoning_output_tokens":0,"total_tokens":17777776}}}\n' \
    "$(ts 25)" >> "$TMP/.codex/sessions/2026/09/14/rollout-A.jsonl"

run() { ( cd "$MINE" && HOME="$TMP" env "$@" bash "$DRIVER" "$START" ${MODE:-} ); }

# 期望：in = (1000000-400000) + (2000000-1000000) = 1600000
#       cache_r = 400000 + 1000000 = 1400000 ; cache_w = 50000
#       out = 300000 + 700000 = 1000000（**不含** reasoning 420000）
MODE=--kv  out_kv=$(run CODEX_PRICE_IN_PER_M= CODEX_PRICE_CACHED_IN_PER_M= CODEX_PRICE_OUT_PER_M=)
chk "--kv：output 只算一次，reasoning 不再加一遍" \
    "$out_kv" "in=1600000 out=1000000 cache_r=1400000 cache_w=50000"

MODE=""    out_hm=$(run CODEX_PRICE_IN_PER_M= CODEX_PRICE_CACHED_IN_PER_M= CODEX_PRICE_OUT_PER_M=)
chk "人读输出：未配单价时只出 token、如实说明没算金额" \
    "$out_hm" "1.6m input, 1m output, 1.4m cache read, 50k cache write（未配单价，金额未计）"

# 配单价：(1600000*10 + 1400000*1 + 1000000*100) / 1e6 = 117.40
#        旧实现 out=1420000 → 159.40
MODE=--kv  out_kvp=$(run CODEX_PRICE_IN_PER_M=10 CODEX_PRICE_CACHED_IN_PER_M=1 CODEX_PRICE_OUT_PER_M=100)
chk "--kv + 单价：金额按真实 output 算（不是把 reasoning 也计费）" \
    "$out_kvp" "in=1600000 out=1000000 cache_r=1400000 cache_w=50000 cost_usd=117.40"

MODE=""    out_hmp=$(run CODEX_PRICE_IN_PER_M=10 CODEX_PRICE_CACHED_IN_PER_M=1 CODEX_PRICE_OUT_PER_M=100)
chk "人读输出 + 单价：同上" \
    "$out_hmp" "1.6m input, 1m output, 1.4m cache read, 50k cache write (\$117.40)"

# ── 认领与窗口边界 ──
MODE=--kv  out_other=$( ( cd "$OTHER" && HOME="$TMP" bash "$DRIVER" "$START" --kv ) )
chk "只认领 cwd 等于当前目录的会话（别的 worktree 各算各的）" \
    "$out_other" "in=5000000 out=5000000 cache_r=0 cache_w=0"

MODE=--kv  out_late=$( ( cd "$MINE" && HOME="$TMP" bash "$DRIVER" "$(( START + 15 ))" --kv ) )
chk "窗口起点之后的记录才计入（第一条被排除）" \
    "$out_late" "in=1000000 out=700000 cache_r=1000000 cache_w=0"

MODE=--kv  out_none=$( ( cd "$TMP" && HOME="$TMP" bash "$DRIVER" "$START" --kv ) )
chk "没有任何会话认领当前目录 → 不输出（周报落「未知」兜底）" "$out_none" ""

echo
echo "通过 $pass / 失败 $fail"
[ "$fail" -eq 0 ]
