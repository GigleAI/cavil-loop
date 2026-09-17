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
# ⚠️ 单价已改成**按模型配置**（GigleTutor-Web#934 的 Q4=A，走 CODEX_PRICES）；旧的三个
# 环境变量仍作为「所有模型同价」的兼容写法。输出多了 cost_state / cost_unknown_tokens。
#
# 本测试的日志刻意让 **reasoning 非零**且 `total = input + output`，覆盖 driver 的
# 三条输出路径：人读输出 / `--kv` / 配置单价后的金额。
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
DRIVER="$REPO_DIR/scripts/drivers/token-usage/codex.sh"
# 旧 fixture 专门验证无价路径；显式空表仍应保留该行为。
export CODEX_PRICES='{}'

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
# ⚠️ turn_context 写在**所有用量记录之前**，和真实 rollout 的事件顺序一致
#   （本机实测在第 8 行、早于任何 token_usage_record）。之前这份 fixture 把它放在
#   文件末尾，逼得 driver 要用「文件里第一条 turn_context」去追认排在它之前的调用——
#   那是没有依据的归属规则（#934 交叉 review 第 2 轮）。
{
    printf '{"type":"session_meta","timestamp":"%s","payload":{"cwd":"%s"}}\n' "$(ts -200)" "$MINE"
    printf '{"type":"turn_context","timestamp":"%s","payload":{"cwd":"%s","model":"gpt-test"}}\n' "$(ts -199)" "$MINE"
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

run_raw() { ( cd "$MINE" && HOME="$TMP" env "$@" bash "$DRIVER" "$START" ${MODE:-} ); }
# 既有断言聚焦 token / 金额；新增字段由下面的专门断言覆盖。
run() { run_raw "$@" | sed -E 's/ models=[^ ]* model_unknown=(yes|no)//'; }

# 期望：in = (1000000-400000) + (2000000-1000000) = 1600000
#       cache_r = 400000 + 1000000 = 1400000 ; cache_w = 50000
#       out = 300000 + 700000 = 1000000（**不含** reasoning 420000）
MODE=--kv  out_kv=$(run CODEX_PRICE_IN_PER_M= CODEX_PRICE_CACHED_IN_PER_M= CODEX_PRICE_OUT_PER_M=)
chk "--kv：output 只算一次，reasoning 不再加一遍" \
    "$out_kv" "in=1600000 out=1000000 cache_r=1400000 cache_w=50000 cost_state=none cost_unknown_tokens=4050000 price_source=configured"

MODE=""    out_hm=$(run CODEX_PRICE_IN_PER_M= CODEX_PRICE_CACHED_IN_PER_M= CODEX_PRICE_OUT_PER_M=)
chk "人读输出：未配单价时只出 token、如实说明没算金额" \
    "$out_hm" "1.6m input, 1m output, 1.4m cache read, 50k cache write（该模型未配单价，金额未计）"

# 配单价：(1600000*10 + 1400000*1 + 1000000*100) / 1e6 = 117.40
#        旧实现 out=1420000 → 159.40
MODE=--kv  out_kvp=$(run CODEX_PRICE_IN_PER_M=10 CODEX_PRICE_CACHED_IN_PER_M=1 CODEX_PRICE_OUT_PER_M=100)
# ⚠️ 这份 fixture 有 50,000 cache write，而 CODEX_PRICES 里没有 cache_write 这一项 ——
#   它没被计进金额，就必须如实落 partial + 缺价 50000。原来写的是 full / 0，
#   等于把「这部分钱没算」悄悄抹掉（#934 交叉 review 第 5 轮打回）。
chk "--kv + 单价：output 只算一次；未计价的 cache write 如实报缺价（原来写成 full/0）" \
    "$out_kvp" "in=1600000 out=1000000 cache_r=1400000 cache_w=50000 cost_usd=117.4 cost_state=partial cost_unknown_tokens=50000 price_source=configured"

MODE=""    out_hmp=$(run CODEX_PRICE_IN_PER_M=10 CODEX_PRICE_CACHED_IN_PER_M=1 CODEX_PRICE_OUT_PER_M=100)
chk "人读输出 + 单价：同上，且写明金额偏低" \
    "$out_hmp" "1.6m input, 1m output, 1.4m cache read, 50k cache write (\$117.40，部分用量未计价，金额偏低)"

# ── 认领与窗口边界 ──
MODE=--kv  out_other=$( ( cd "$OTHER" && HOME="$TMP" bash "$DRIVER" "$START" --kv ) )
chk "只认领 cwd 等于当前目录的会话（别的 worktree 各算各的）" \
    "$out_other" "in=5000000 out=5000000 cache_r=0 cache_w=0 cost_state=none cost_unknown_tokens=10000000 price_source=configured models= model_unknown=yes"

MODE=--kv  out_late=$( ( cd "$MINE" && HOME="$TMP" bash "$DRIVER" "$(( START + 15 ))" --kv ) )
chk "窗口起点之后的记录才计入（第一条被排除）" \
    "$out_late" "in=1000000 out=700000 cache_r=1000000 cache_w=0 cost_state=none cost_unknown_tokens=2700000 price_source=configured models=gpt-test model_unknown=no"

MODE=--kv  out_none=$( ( cd "$TMP" && HOME="$TMP" bash "$DRIVER" "$START" --kv ) )
chk "没有任何会话认领当前目录 → 不输出（周报落「未知」兜底）" "$out_none" ""

# ── 按模型分别配单价（GigleTutor-Web#934 Q4=A）────────────────────────────
# 同一次派工里混用不同模型时，一个价钱套所有模型会算错。模型名从 turn_context.model 读。
MODE=--kv m_hit=$(run CODEX_PRICES='{"gpt-test":{"in":10,"cached_in":1,"out":100}}')
MODE=--kv m_old=$(run CODEX_PRICE_IN_PER_M=10 CODEX_PRICE_CACHED_IN_PER_M=1 CODEX_PRICE_OUT_PER_M=100)
chk "按模型配价与「所有模型同价」的兼容写法结果一致" "$m_hit" "$m_old"
MODE=--kv m_miss=$(run CODEX_PRICES='{"some-other-model":{"in":10,"cached_in":1,"out":100}}')
chk "只配了别的模型 → 不套价，如实落 none 并报出缺价 token" \
    "$(printf '%s' "$m_miss" | grep -o 'cost_state=[a-z]* cost_unknown_tokens=[0-9]*')" \
    "cost_state=none cost_unknown_tokens=4050000"
chk "没配任何单价 → 同样是 none（原有行为不变）" \
    "$(MODE=--kv run CODEX_PRICES='{}' | grep -o 'cost_state=[a-z]*')" "cost_state=none"

# ── 逐调用按模型计价（GitHub#934 交叉 review 第 1 轮）──────────────────────
# 旧写法把所有文件 jq -s 合成一个数组、取**最后一条** turn_context.model 给全部调用
# 定价。两种真实情形都会错：一次派工横跨多份 rollout 文件（会话 resume / 分叉）、
# 以及同一份文件里中途换模型。下面用独立的日志目录重造这两种情形。
MIX="$TMP/mix"; mkdir -p "$MIX/wt" "$MIX/.codex/sessions/2026/09/14"
mrec() {  # $1 相对秒  $2 input token
    printf '{"type":"token_usage_record","timestamp":"%s","payload":{"usage":{"input_tokens":%s,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":0,"reasoning_output_tokens":0,"total_tokens":%s}}}\n' \
        "$(ts "$1")" "$2" "$2"
}
mctx() {  # $1 相对秒  $2 模型名（真实 rollout 里排在该轮调用之前）
    printf '{"type":"turn_context","timestamp":"%s","payload":{"cwd":"%s","model":"%s"}}\n' \
        "$(ts "$1")" "$MIX/wt" "$2"
}
mmeta() { printf '{"type":"session_meta","timestamp":"%s","payload":{"cwd":"%s"}}\n' "$(ts -200)" "$MIX/wt"; }
{ mmeta; mctx -190 mA; mrec 10 1000000; } > "$MIX/.codex/sessions/2026/09/14/rollout-A.jsonl"
{ mmeta; mctx -190 mB; mrec 20 1000000; } > "$MIX/.codex/sessions/2026/09/14/rollout-B.jsonl"
mrun() { ( cd "$MIX/wt" && HOME="$MIX" env "$@" bash "$DRIVER" "$START" --kv ); }
BOTH='{"mA":{"in":1,"cached_in":0,"out":0},"mB":{"in":10,"cached_in":0,"out":0}}'

# mA 100 万 × $1/M + mB 100 万 × $10/M = $11.00（旧写法按合并后 last 命中谁，出 $2 或 $20）
chk "跨文件混用模型：各按各的价（旧写法会整体套同一个价）" \
    "$(mrun CODEX_PRICES="$BOTH" | grep -o 'cost_usd=[0-9.]*')" "cost_usd=11"
chk "跨文件混用模型：模型集合去重并稳定排序" \
    "$(mrun CODEX_PRICES="$BOTH" | grep -o 'models=[^ ]* model_unknown=[a-z]*')" \
    "models=mA,mB model_unknown=no"
chk "旧统一价只兜底缺少精确条目的模型，不能覆盖 mA 的精确价" \
    "$(mrun CODEX_PRICES='{"mA":{"in":1,"cached_in":0,"out":0}}' \
       CODEX_PRICE_IN_PER_M=100 CODEX_PRICE_CACHED_IN_PER_M=0 CODEX_PRICE_OUT_PER_M=0 \
       | grep -o 'cost_usd=[0-9.]*')" "cost_usd=101"

# 只配 mB：应当只算 mB 那 100 万，mA 那 100 万落缺价 → partial
chk "跨文件混用、只配其中一个模型的价 → 金额只含有价的那部分" \
    "$(mrun CODEX_PRICES='{"mB":{"in":10,"cached_in":0,"out":0}}' \
       | grep -o 'cost_usd=[0-9.]* cost_state=[a-z]* cost_unknown_tokens=[0-9]*')" \
    "cost_usd=10 cost_state=partial cost_unknown_tokens=1000000"

# 同一份文件里中途换模型：前半段 mA、后半段 mB
rm -f "$MIX/.codex/sessions/2026/09/14/rollout-A.jsonl" "$MIX/.codex/sessions/2026/09/14/rollout-B.jsonl"
{ mmeta; mctx -190 mA; mrec 30 1000000; mctx 35 mB; mrec 40 1000000; } \
    > "$MIX/.codex/sessions/2026/09/14/rollout-C.jsonl"
chk "单文件内换模型：按各条调用当时的 turn_context 分段计价" \
    "$(mrun CODEX_PRICES="$BOTH" | grep -o 'cost_usd=[0-9.]*')" "cost_usd=11"

# 单价来源要如实标出来：这一侧是**人工配置**的，不是像 claude 那侧反解出来的
chk "输出标明单价来源为人工配置（报告据此区分两侧口径）" \
    "$(mrun CODEX_PRICES="$BOTH" | grep -o 'price_source=[a-z]*')" "price_source=configured"

# 内置表：未设置 CODEX_PRICES 才启用；显式配置应整表覆盖，不能偷偷补旧默认价。
{ mmeta; mctx -190 gpt-6-astra; mrec 10 1000000; mctx 15 gpt-5.6-terra; mrec 20 1000000; } \
    > "$MIX/.codex/sessions/2026/09/14/rollout-C.jsonl"
# 固定价目“今天”的时钟，否则 90 天后测试会因真实日期流逝而失败。
mkdir -p "$TMP/fixed-date"
cat > "$TMP/fixed-date/date" <<'EOF'
#!/usr/bin/env bash
if [ "$#" = 2 ] && [ "$1" = -u ] && [ "$2" = +%Y-%m-%d ]; then
    printf '%s\n' 2026-09-16
else
    exec /usr/bin/date "$@"
fi
EOF
chmod +x "$TMP/fixed-date/date"
default_kv=$(cd "$MIX/wt" && HOME="$MIX" PATH="$TMP/fixed-date:$PATH" \
    env -u CODEX_PRICES bash "$DRIVER" "$START" --kv)
chk "未配置时两种模型分别按内置价计：10 + 2" \
    "$(printf '%s' "$default_kv" | grep -o 'cost_usd=[0-9.]* cost_state=[a-z]* cost_unknown_tokens=[0-9]*')" \
    "cost_usd=12 cost_state=full cost_unknown_tokens=0"
chk "内置价带来源日期和过期状态供后续报告披露" \
    "$(printf '%s' "$default_kv" | grep -o 'price_source=[a-z]* price_checked=[0-9-]* price_stale=[a-z]*')" \
    "price_source=default price_checked=2026-09-16 price_stale=no"
mkdir -p "$TMP/old-driver"
cp "$DRIVER" "$TMP/old-driver/codex.sh"
jq '.checked_at = "2025-01-01"' "$REPO_DIR/scripts/drivers/token-usage/codex-prices.json" \
    > "$TMP/old-driver/codex-prices.json"
old_kv=$(cd "$MIX/wt" && HOME="$MIX" env -u CODEX_PRICES bash "$TMP/old-driver/codex.sh" "$START" --kv)
chk "超过 90 天的内置价进入机器过期标记" \
    "$(printf '%s' "$old_kv" | grep -o 'price_stale=[a-z]*')" "price_stale=yes"
chk "人读用量也明确提示复核，过期不悄悄继续" \
    "$(cd "$MIX/wt" && HOME="$MIX" env -u CODEX_PRICES \
       bash "$TMP/old-driver/codex.sh" "$START" | grep -qF '超过 90 天，请复核' && echo yes || echo no)" "yes"
chk "显式配置整表覆盖默认：未配置的另一模型进入缺价" \
    "$(mrun CODEX_PRICES='{"gpt-6-astra":{"in":3,"cached_in":0,"out":0}}' \
       | grep -o 'cost_usd=[0-9.]* cost_state=[a-z]* cost_unknown_tokens=[0-9]*')" \
    "cost_usd=3 cost_state=partial cost_unknown_tokens=1000000"
chk "显式空表关闭内置估价" \
    "$(mrun CODEX_PRICES='{}' | grep -o 'cost_state=[a-z]* cost_unknown_tokens=[0-9]*')" \
    "cost_state=none cost_unknown_tokens=2000000"
chk "旧通配单价显式设置时也覆盖内置模型价" \
    "$(cd "$MIX/wt" && HOME="$MIX" env -u CODEX_PRICES \
       CODEX_PRICE_IN_PER_M=7 CODEX_PRICE_CACHED_IN_PER_M=0 CODEX_PRICE_OUT_PER_M=0 \
       bash "$DRIVER" "$START" --kv | grep -o 'cost_usd=[0-9.]*')" "cost_usd=14"
rm -f "$MIX/.codex/sessions/2026/09/14/rollout-C.jsonl"

# ── 缺先行上下文的调用：如实算不出，不许拿后面的模型追认（第 2 轮打回）──
# 文件头被截断时，早期调用可能属于切换前的模型 A，而首个可见 turn_context 已是切换后
# 的 B。拿 B 去追认 = 把「不知道」伪装成「知道」，而且是悄悄让金额变大的那种错。
rm -f "$MIX/.codex/sessions/2026/09/14/rollout-C.jsonl"
{ mmeta; mrec 10 1000000; mctx 20 mB; mrec 30 1000000; } \
    > "$MIX/.codex/sessions/2026/09/14/rollout-D.jsonl"
chk "首个 turn_context 之前的调用落缺价，不按后面的模型计价" \
    "$(mrun CODEX_PRICES='{"mB":{"in":10,"cached_in":0,"out":0}}' \
       | grep -o 'cost_usd=[0-9.]* cost_state=[a-z]* cost_unknown_tokens=[0-9]*')" \
    "cost_usd=10 cost_state=partial cost_unknown_tokens=1000000"
chk "已知模型与未知归属并存时分别保留" \
    "$(mrun CODEX_PRICES='{"mB":{"in":10,"cached_in":0,"out":0}}' \
       | grep -o 'models=[^ ]* model_unknown=[a-z]*')" \
    "models=mB model_unknown=yes"
chk "token 计数不受影响（算不出价 ≠ 不算用量）" \
    "$(mrun CODEX_PRICES='{"mB":{"in":10,"cached_in":0,"out":0}}' | grep -o '^in=[0-9]*')" \
    "in=2000000"

# ── 未计价的项必须如实报缺价（GitHub#934 交叉 review 第 5 轮）────────────────
# 覆盖三态的语义是「有没有算不出价的 token」。模型配了价、但**某一项没有单价**时，
# 那一项的 token 同样是「没计进金额」的部分 —— 旧写法只在「整个模型都没价」时才报，
# 于是有 cache write 的派工输出 full / 缺价 0，把「这部分钱没算」悄悄抹掉。
CWD_DIR="$TMP/cw"; mkdir -p "$CWD_DIR/wt" "$CWD_DIR/.codex/sessions/2026/09/14"
cwrec() {  # $1 相对秒  $2 input  $3 cache_write  $4 output
    printf '{"type":"token_usage_record","timestamp":"%s","payload":{"usage":{"input_tokens":%s,"cached_input_tokens":0,"cache_write_input_tokens":%s,"output_tokens":%s,"reasoning_output_tokens":0,"total_tokens":%s}}}\n' \
        "$(ts "$1")" "$2" "$3" "$4" "$(( $2 + $4 ))"
}
cwfix() {  # $1 input  $2 cache_write  $3 output
    { printf '{"type":"session_meta","timestamp":"%s","payload":{"cwd":"%s"}}\n' "$(ts -200)" "$CWD_DIR/wt"
      printf '{"type":"turn_context","timestamp":"%s","payload":{"cwd":"%s","model":"mA"}}\n' "$(ts -190)" "$CWD_DIR/wt"
      cwrec 10 "$1" "$2" "$3"; } > "$CWD_DIR/.codex/sessions/2026/09/14/rollout-A.jsonl"
}
cwrun() { ( cd "$CWD_DIR/wt" && HOME="$CWD_DIR" env "$@" bash "$DRIVER" "$START" --kv ); }
P3='{"mA":{"in":10,"cached_in":1,"out":100}}'

# ⑴ 已配模型 + 非零且未计价的 cache write → 金额只含已计价的部分，如实报缺价
cwfix 1000000 50000 0
chk "已配模型但 cache write 没有单价 → partial + 缺价 5 万（原来是 full / 0）" \
    "$(cwrun CODEX_PRICES="$P3" | grep -o 'cost_usd=[0-9.]* cost_state=[a-z]* cost_unknown_tokens=[0-9]*')" \
    "cost_usd=10 cost_state=partial cost_unknown_tokens=50000"
chk "人读输出也要写明金额偏低，不能只在机器字段里说" \
    "$( ( cd "$CWD_DIR/wt" && HOME="$CWD_DIR" env CODEX_PRICES="$P3" bash "$DRIVER" "$START" ) )" \
    "1m input, 0 output, 0 cache read, 50k cache write (\$10.00，部分用量未计价，金额偏低)"

# ⑵ cache write = 0 → 没有待计价的 token，仍然是 full（别把这条一起改坏）
cwfix 1000000 0 0
chk "cache write 为 0 时仍是 full / 缺价 0" \
    "$(cwrun CODEX_PRICES="$P3" | grep -o 'cost_state=[a-z]* cost_unknown_tokens=[0-9]*')" \
    "cost_state=full cost_unknown_tokens=0"

# ⑶ 配上可选的 cache_write 单价 → 它就被计进金额，回到 full
cwfix 1000000 50000 0
chk "配了可选的 cache_write 单价 → 计进金额并回到 full（10.00 + 50000×2/1e6 = 10.10）" \
    "$(cwrun CODEX_PRICES='{"mA":{"in":10,"cached_in":1,"out":100,"cache_write":2}}' \
       | grep -o 'cost_usd=[0-9.]* cost_state=[a-z]* cost_unknown_tokens=[0-9]*')" \
    "cost_usd=10.1 cost_state=full cost_unknown_tokens=0"

# ⑷ 全部待计价 token 都没价（模型不在表里）→ 仍然是 none，四项全进缺价
cwfix 1000000 50000 200000
chk "模型完全没配价 → none，四项全进缺价（1000000+50000+200000）" \
    "$(cwrun CODEX_PRICES='{"other":{"in":1,"cached_in":1,"out":1}}' \
       | grep -o 'cost_state=[a-z]* cost_unknown_tokens=[0-9]*')" \
    "cost_state=none cost_unknown_tokens=1250000"

# ── 「算出过价」要由真有用量的项支撑（GitHub#934 交叉 review 第 6 轮）──────────
# 上一轮改成逐项取价后留了个口子：`.known += 1` 不看 token 数，于是一个 **token 为 0
# 的有价项**就能把「实际用量一条都没算出价」抬成 partial，采集侧再据此把这条派工
# 算成「有金额」。判据必须是**用量非零 且 取到价**。
cwfix2() {  # $1 input  $2 cached  $3 cache_write  $4 output
    { printf '{"type":"session_meta","timestamp":"%s","payload":{"cwd":"%s"}}\n' "$(ts -200)" "$CWD_DIR/wt"
      printf '{"type":"turn_context","timestamp":"%s","payload":{"cwd":"%s","model":"mA"}}\n' "$(ts -190)" "$CWD_DIR/wt"
      printf '{"type":"token_usage_record","timestamp":"%s","payload":{"usage":{"input_tokens":%s,"cached_input_tokens":%s,"cache_write_input_tokens":%s,"output_tokens":%s,"reasoning_output_tokens":0,"total_tokens":%s}}}\n' \
        "$(ts 10)" "$1" "$2" "$3" "$4" "$(( $1 + $4 ))"; } > "$CWD_DIR/.codex/sessions/2026/09/14/rollout-A.jsonl"
}

# ⑴ 有价的那项用量为 0，真正的用量（cache read）没配价 → 一条都算不出
cwfix2 1000000 1000000 0 0
chk "有价项用量为 0、实际用量全缺价 → none（旧写法给 \$0.00 / partial）" \
    "$(cwrun CODEX_PRICES='{"mA":{"in":10}}' | grep -o 'cost_state=[a-z]* cost_unknown_tokens=[0-9]*')" \
    "cost_state=none cost_unknown_tokens=1000000"
chk "none 时不输出金额（别拿 \$0.00 冒充算出来了）" \
    "$(cwrun CODEX_PRICES='{"mA":{"in":10}}' | grep -c 'cost_usd=')" "0"

# ⑵ 确实算出了一部分 → 仍然是 partial（别把上面那条改过头）
cwfix2 1000000 400000 0 0
chk "未缓存 input 有价有量、cache read 没价 → partial + 缺价 40 万" \
    "$(cwrun CODEX_PRICES='{"mA":{"in":10}}' | grep -o 'cost_usd=[0-9.]* cost_state=[a-z]* cost_unknown_tokens=[0-9]*')" \
    "cost_usd=6 cost_state=partial cost_unknown_tokens=400000"

# ⑶ 四项用量全为 0 → 没有待计价的 token，是**已知的零**（第 4 轮那条不能被改坏）
cwfix2 0 0 0 0
chk "用量全为 0 → full / 缺价 0（已知的零）" \
    "$(cwrun CODEX_PRICES='{"mA":{"in":10}}' | grep -o 'cost_usd=[0-9.]* cost_state=[a-z]* cost_unknown_tokens=[0-9]*')" \
    "cost_usd=0 cost_state=full cost_unknown_tokens=0"

# ⑷ 有用量、单价合法地配成 0 → 算出来了，就是 0；判据是**用量非零**不是**金额非零**
cwfix2 1000000 0 0 0
chk "单价配成 0 且有用量 → full（按金额非零判会误伤这条）" \
    "$(cwrun CODEX_PRICES='{"mA":{"in":0,"cached_in":0,"out":0,"cache_write":0}}' \
       | grep -o 'cost_usd=[0-9.]* cost_state=[a-z]* cost_unknown_tokens=[0-9]*')" \
    "cost_usd=0 cost_state=full cost_unknown_tokens=0"

echo
echo "通过 $pass / 失败 $fail"
[ "$fail" -eq 0 ]
