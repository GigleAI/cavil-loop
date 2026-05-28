#!/usr/bin/env bash
# Token usage driver: Claude
#
# 用法: bash claude.sh <start_epoch>
#
# 读 claude 本地 transcript jsonl 累加 timestamp >= start_epoch 之后的所有
# assistant message usage 字段，输出格式跟 claude CLI 的 /usage 命令接近：
#
#   2.4k input, 153.5k output, 42.8m cache read, 1.1m cache write ($32.24)
#
# 各字段：
#   input       = sum(input_tokens) — 非 cache 的 fresh input
#   output      = sum(output_tokens) — 模型生成的
#   cache read  = sum(cache_read_input_tokens) — cache 命中（便宜 0.1× input）
#   cache write = sum(cache_creation_input_tokens) — 新写入 cache（5m 1.25×、1h 2×）
#   $X.XX       = 估算 USD（按 model 从 anthropic pricing 推算）
#
# Pricing 数据点（per million input tokens, USD），按 model family 区分：
#   Opus  4.x : input $15, output $75, cache_w_5m $18.75, cache_w_1h $30, cache_r $1.5
#   Sonnet 4.x: input $3,  output $15, cache_w_5m $3.75,  cache_w_1h $6,  cache_r $0.30
#   Haiku  4.x: input $1,  output $5,  cache_w_5m $1.25,  cache_w_1h $2,  cache_r $0.10
# 单价比例固定（output=5×, cache_w_5m=1.25×, cache_w_1h=2×, cache_r=0.1×），只用
# 传 input 单价进 jq。未知 model fallback 到 Opus 价（最贵、估算偏高安全）。
# Pricing 来源：https://www.anthropic.com/pricing；定期对账更新。
#
# Transcript 路径约定：~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
#   encoded-cwd = pwd 里 / 全换 -（claude CLI 约定）
#   同 cwd 多 session 时取 mtime 最新
#
# 漏算：worker 调本脚本的 Bash 调用本身 + 之后到 gh comment 完成那段，
# transcript 还没 flush 进去，会漏 < 1%（整任务比例）。可忽略。
set -uo pipefail

START_EPOCH="${1:?need start epoch}"

ENC=$(pwd | tr / -)
TRANSCRIPT=$(ls -t ~/.claude/projects/${ENC}/*.jsonl 2>/dev/null | head -1)
[ -z "$TRANSCRIPT" ] && exit 0

# 拿 model 选 pricing —— 取 [start_epoch, now] 区间的第一个 assistant message
MODEL=$(jq -sr --argjson start "$START_EPOCH" '
    [.[] | select(.type == "assistant"
              and (.message.model // empty)
              and (.timestamp | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601) >= $start)
         | .message.model][0] // "unknown"
' "$TRANSCRIPT" 2>/dev/null)

case "$MODEL" in
    *opus*)   PRICE_IN=15 ;;
    *sonnet*) PRICE_IN=3 ;;
    *haiku*)  PRICE_IN=1 ;;
    *)        PRICE_IN=15 ;;   # fallback Opus（最贵；估算偏高安全）
esac

jq -sr --argjson start "$START_EPOCH" --argjson pi "$PRICE_IN" '
    # X.Xk / X.Xm 格式（< 1k 时显示整数）
    def fmt:
        if . >= 1000000 then ((. / 100000 | floor) / 10 | tostring) + "m"
        elif . >= 1000 then ((. / 100 | floor) / 10 | tostring) + "k"
        else (. | floor | tostring) end;

    # USD 强制 2 位小数
    def usd2:
        (. * 100 + 0.5 | floor) as $c |
        ($c / 100 | floor) as $d |
        ($c - $d * 100) as $r |
        "\($d).\(if $r < 10 then "0\($r)" else "\($r)" end)";

    [.[] | select(.type == "assistant"
              and (.message.usage // empty)
              and (.timestamp | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601) >= $start)
         | .message.usage]
    | reduce .[] as $u (
        {in:0, out:0, cr:0, cw_5m:0, cw_1h:0};
        .in += ($u.input_tokens // 0)
        | .out += ($u.output_tokens // 0)
        | .cr += ($u.cache_read_input_tokens // 0)
        | .cw_5m += ($u.cache_creation.ephemeral_5m_input_tokens // 0)
        | .cw_1h += ($u.cache_creation.ephemeral_1h_input_tokens // 0)
      )
    | (.cw_5m + .cw_1h) as $cw
    | ((.in + .cr * 0.1 + .cw_5m * 1.25 + .cw_1h * 2 + .out * 5) * $pi / 1000000) as $usd
    | "\(.in | fmt) input, \(.out | fmt) output, \(.cr | fmt) cache read, \($cw | fmt) cache write ($\($usd | usd2))"
' "$TRANSCRIPT" 2>/dev/null
