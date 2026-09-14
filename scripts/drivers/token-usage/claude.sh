#!/usr/bin/env bash
# Token usage driver: Claude
#
# 用法: bash claude.sh <start_epoch> [--kv]
#
# 读 claude 本地 transcript jsonl，累加 timestamp >= start_epoch 之后的 assistant
# message usage。默认输出跟 claude CLI 的 /usage 命令接近的一行人话：
#
#   2.4k input, 153.5k output, 42.8m cache read, 1.1m cache write ($32.24)
#
# 加 --kv 则输出机器可读的一行（给评论末尾的 agent-metrics 标记用）：
#
#   in=2400 out=153500 cache_r=42800000 cache_w=1100000 cost_usd=32.24
#
# ⚠️ 按 requestId 去重（2026-09 修，见 GigleTutor-Web#931）
#   一次 API 调用会写下**多条** assistant 条目（正文一条、思考一条、每次工具调用各一条），
#   它们携带**同一份** usage。逐条累加 = 同一次调用的 token 被重复计好几遍。
#   实测 53 个会话：逐条累加是按 requestId 去重后的 1.68 倍（中位数，范围 1.39–2.46）；
#   去重后与 CLI 自己记的 modelUsage 基本吻合（中位数 1.00，范围 0.95–1.02）。
#   没有 requestId 的条目无法归组，各自单独计入。
#
# ⚠️ 顶层计数为 0 时回退到 usage.iterations[]（2026-09 修，见 GigleTutor-Web#935）
#   极少数记录的**顶层**计数被写成 0，真值只落在 `usage.iterations[]` 明细里；只读顶层
#   就把整次调用的 input / output / cache read 算成 0。本机 161 份 transcript、88,400 条
#   带 usage 的记录实测：87,649 条带 `iterations[]`（长度恒为 1），其中 87,647 条顶层与
#   明细**逐字段相等**；只有 2 条（同一个 requestId = 1 次调用，0.0018%）是这种形态，
#   漏掉 in 2 / out 288 / cache read 964,830（cache write 没丢——被清零的只有那四个顶层
#   整数计数，`cache_creation` 子对象仍是真值）。
#   规则：**5 个求和项各走一次「顶层 > 0 用顶层，否则用明细同名项的合计」**，
#   顶层和明细**永远不相加**，所以不存在重复累加。明细多条时求和（当前长度恒为 1，
#   求和是为了长度变了也对）。
#   为什么不用「有明细就一律信明细」：万一以后 `iterations[]` 变成只记某一步、而顶层才是
#   全量，那条规则会让**所有**记录一起少算；逐字段回退在已扫描样本里只改动那 2 条。
#   两档 TTL 的回退目前**没有观测证据**（顶层 ephemeral_5m / 1h 与明细零差异），属防御性扩展。
#
# 各字段：
#   input       = sum(input_tokens) — 非 cache 的 fresh input
#   output      = sum(output_tokens) — 模型生成的
#   cache read  = sum(cache_read_input_tokens) — cache 命中（便宜 0.1× input）
#   cache write = sum(cache_creation.ephemeral_5m) + sum(cache_creation.ephemeral_1h)
#                 — 新写入 cache，按 TTL 分档计价（5m 1.25×、1h 2×），所以必须分开累加。
#                 顶层的 `cache_creation_input_tokens` 是这两档的**合计**，不是求和项——
#                 加进来等于 cache write 计两遍。实测 87,649 条带明细的记录里
#                 `cache_creation_input_tokens == ephemeral_5m + ephemeral_1h` 成立 87,647 条，
#                 另外 2 条就是下面那种顶层被清零的形态。
#   $X.XX       = 估算 USD（按 model 从 anthropic pricing 推算）
#
# ⚠️ 金额只是**按标价的估算**，计价偏差尚未核实（GigleTutor-Web#931 另行追踪）：
#   本脚本取窗口内**第一条**消息的 model 定一个单价，套用到该窗口全部用量；
#   实测去重之后按本表算出的金额仍明显高于 CLI 自记的 totalCostUSD。
#   周报里这个数标注为「按调用去重后的标价估算，计价偏差尚未核实」，不是实际账单。
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
#
# 不在这里算「排除等待的工时」：cost-state 快照是**派工结束之后**才落盘的
# （实测 13/13 个派工窗口内部一条都没有），本脚本跑在发评论之前，拿不到。
# 那个指标由周报采集器在出报告时从本地日志算（见 scripts/weekly-report/collect.py）。
set -uo pipefail

START_EPOCH="${1:?need start epoch}"
MODE="${2:-human}"

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

jq -sr --argjson start "$START_EPOCH" --argjson pi "$PRICE_IN" --arg mode "$MODE" '
    # X.Xk / X.Xm 格式（< 1k 时显示整数）
    def fmt:
        if . >= 1000000 then ((. / 100000 | floor) / 10 | tostring) + "m"
        elif . >= 1000 then ((. / 100 | floor) / 10 | tostring) + "k"
        else (. | floor | tostring) end;

    # 逐字段零回退：顶层 > 0 用顶层，否则用 iterations[] 里同名项的合计。两者永不相加。
    def zf($top; $items; f):
        if $top > 0 then $top else ($items | map(f) | add // 0) end;

    # USD 强制 2 位小数
    def usd2:
        (. * 100 + 0.5 | floor) as $c |
        ($c / 100 | floor) as $d |
        ($c - $d * 100) as $r |
        "\($d).\(if $r < 10 then "0\($r)" else "\($r)" end)";

    [.[] | select(.type == "assistant"
              and (.message.usage // empty)
              and (.timestamp | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601) >= $start)]
    # 同一次 API 调用（requestId）只取一条；没有 requestId 的无法归组，各自保留
    | ( (map(select(.requestId != null)) | group_by(.requestId) | map(.[0]))
        + map(select(.requestId == null)) )
    | map(.message.usage)
    | reduce .[] as $u (
        {in:0, out:0, cr:0, cw_5m:0, cw_1h:0};
        ($u.iterations // []) as $it
        | .in += zf($u.input_tokens // 0; $it; .input_tokens // 0)
        | .out += zf($u.output_tokens // 0; $it; .output_tokens // 0)
        | .cr += zf($u.cache_read_input_tokens // 0; $it; .cache_read_input_tokens // 0)
        | .cw_5m += zf($u.cache_creation.ephemeral_5m_input_tokens // 0;
                       $it; .cache_creation.ephemeral_5m_input_tokens // 0)
        | .cw_1h += zf($u.cache_creation.ephemeral_1h_input_tokens // 0;
                       $it; .cache_creation.ephemeral_1h_input_tokens // 0)
      )
    | (.cw_5m + .cw_1h) as $cw
    | ((.in + .cr * 0.1 + .cw_5m * 1.25 + .cw_1h * 2 + .out * 5) * $pi / 1000000) as $usd
    | if $mode == "--kv"
      then "in=\(.in) out=\(.out) cache_r=\(.cr) cache_w=\($cw) cost_usd=\($usd | usd2)"
      else "\(.in | fmt) input, \(.out | fmt) output, \(.cr | fmt) cache read, \($cw | fmt) cache write ($\($usd | usd2))"
      end
' "$TRANSCRIPT" 2>/dev/null
