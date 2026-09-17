#!/usr/bin/env bash
# Token usage driver: codex
#
# 用法: bash codex.sh <start_epoch> [--kv]
#
# 交叉 review 那一侧的用量。原来没有这个 driver，所以 review 评论既不带 token
# 也不带金额——上周 589 条 review 评论里只有 2 条有记账行，那一侧的开销在周报里
# 是个黑洞（见 GigleTutor-Web#931）。
#
# 数据来源：codex 的会话记录 ~/.codex/sessions/<Y>/<M>/<D>/rollout-*.jsonl
#   · `session_meta` 那条带 `payload.cwd`，用它认领属于当前 worktree 的会话
#   · `token_usage_record` 那条带 `payload.usage`，是**单次 API 调用**的用量
#     （同级还有 turn_token_usage / thread_token_usage，那两个是**累计值**，
#      不能求和，求和会重复计——这正是 claude 那一侧踩过的坑）
#
# ⚠️ `reasoning_output_tokens` 是 `output_tokens` 的**子项，不是另一份输出**，
#   两者相加就是把思考部分算两遍（GigleTutor-Web#932 交叉 review 第 4 轮）。
#   本机 223 个会话、3,119 条 `token_usage_record` 实测：
#     · `total_tokens == input_tokens + output_tokens`  3119 / 3119 条成立
#     · `reasoning_output_tokens > output_tokens`       0 条
#   相加会多计 82,139 / 1,061,192 ≈ 7.7% 的输出 token，配了单价还会照这个虚数计费。
#   同理 `cached_input_tokens` 是 `input_tokens` 的子项（实测 0 条超出），
#   所以下面用 `input − cached` 取未命中缓存的那部分，与 claude 那一侧口径对齐。
#
# 金额是按 API 标准文本标价换算的参考价值，不是订阅账单。未设置 CODEX_PRICES
# 时使用同目录 codex-prices.json 的内置表；显式设置时完整替换内置表，可设 {}
# 禁用估价。内置表有核对日期，超过 90 天的人读输出会提示复核。
#
#   单价**按模型分别配**（GigleTutor-Web#934 的 Q4=A）：同一次派工里混用不同模型时，
#   一个价钱套所有模型会算错。
#
#   ⚠️ 模型必须**逐条调用**地认，不能「整段取一个模型」（#934 交叉 review 第 1 轮）：
#     · `turn_context` 每轮开头写一条，`model` 是**那一轮之后**的调用所用的模型；
#       同一份 rollout 文件里换模型就会有多条，取 last 会把前面几轮也按最后那个算。
#     · 一次派工常横跨**多份** rollout 文件（会话被 resume / 分叉），把所有文件
#       `jq -s` 合成一个数组后取 last，等于用某一份文件的模型给全部文件定价。
#     实测：A 文件 100 万 input 走 $1/M、B 文件 100 万走 $10/M，正确是 $11，
#     旧写法按合并后 last 命中谁就出 $2 或 $20；只配其中一个模型的价时旧写法还会
#     整体落 none/unknown=200 万，而正确答案是 $10 + partial + 缺价 100 万。
#     所以下面**按文件逐行扫**，用「本行之前最近一条 turn_context」给每条用量盖模型章，
#     再按模型分段计价、最后合计。
#
#   模型名从会话记录的 `turn_context.model` 读（本机是 gpt-6-astra）。
#   配置走 `CODEX_PRICES`，JSON，单位美元 / 百万 token：
#
#     CODEX_PRICES='{"gpt-6-astra":{"in":10,"cached_in":1,"out":50,"cache_write":12.5}}'
#
#   三个键 `in` / `cached_in` / `out` 是常规项；`cache_write` 是**可选键**——这一侧
#   没有确认过缓存写入单价时，不配就把那部分 token 如实计进 `cost_unknown_tokens`、
#   该次派工落 `partial`，**不编一个默认价**。本机实测 cache_write 恒为 0，所以不配
#   也不会让派工无端变成 partial。
#
#   没在表里的模型**不套价**：它的 token 计进 cost_unknown_tokens，该次派工落
#   cost_state=partial（有别的模型算出了金额）或 none（一个都没算出来）。
#   旧的三个环境变量仍然认，作为「所有模型同一个价」的兼容写法：
#     CODEX_PRICE_IN_PER_M / CODEX_PRICE_CACHED_IN_PER_M / CODEX_PRICE_OUT_PER_M
#
# `--kv` 另输出 `models=`（实际产生非零用量的模型 ID，稳定排序）和
# `model_unknown=yes|no`。unknown 是归属状态，不塞进模型 ID 列表。
#
# 不在这里算「排除等待的工时」：同 claude driver，那个指标由周报采集器出报告时
# 从本机日志算（scripts/weekly-report/worktime.py）。
set -uo pipefail

START_EPOCH="${1:?need start epoch}"
MODE="${2:-human}"
CWD="$(pwd)"

SESS_DIR="$HOME/.codex/sessions"
[ -d "$SESS_DIR" ] || exit 0

# 只看 start_epoch 之后动过的会话文件：codex 的 rollout 按天分目录，全量扫太慢。
# 留 1 天余量，避免跨零点的会话被漏掉。
FILES=$(find "$SESS_DIR" -name 'rollout-*.jsonl' -type f \
        -newermt "@$((START_EPOCH - 86400))" 2>/dev/null)
[ -z "$FILES" ] && exit 0

# 认领属于本 worktree 的会话：session_meta 的 cwd 要等于当前目录
MINE=""
while IFS= read -r f; do
    [ -n "$f" ] || continue
    c=$(head -50 "$f" 2>/dev/null | jq -rs --arg cwd "$CWD" '
        [.[] | .payload.cwd // empty] | map(select(. == $cwd)) | length' 2>/dev/null)
    [ "${c:-0}" -gt 0 ] && MINE="$MINE$f"$'\n'
done <<< "$FILES"
[ -z "$MINE" ] && exit 0

PI="${CODEX_PRICE_IN_PER_M:-}"
PC="${CODEX_PRICE_CACHED_IN_PER_M:-}"
PO="${CODEX_PRICE_OUT_PER_M:-}"
PRICE_SOURCE=configured
PRICE_DATE=""
if [ "${CODEX_PRICES+x}" ]; then
    PRICES="$CODEX_PRICES"
else
    PRICE_SOURCE=default
    PRICE_FILE="$(dirname "${BASH_SOURCE[0]}")/codex-prices.json"
    PRICES=$(jq -c '.models' "$PRICE_FILE") || exit 1
    PRICE_DATE=$(jq -r '.checked_at' "$PRICE_FILE") || exit 1
fi
if [ -n "$PI" ] && [ -n "$PC" ] && [ -n "$PO" ]; then
    [ "${CODEX_PRICES+x}" ] || PRICES='{}'
    PRICE_SOURCE=configured
fi
# 旧的三个变量 → 当成「所有模型同价」的兜底表，用 * 作通配键
if [ -n "$PI" ] && [ -n "$PC" ] && [ -n "$PO" ]; then
    PRICES=$(printf '%s' "$PRICES" | jq -c --argjson d "{\"in\":$PI,\"cached_in\":$PC,\"out\":$PO}" \
        '. + {"*": $d}' 2>/dev/null || printf '{"*":{"in":%s,"cached_in":%s,"out":%s}}' "$PI" "$PC" "$PO")
fi
PRICE_STALE=no
if [ "$PRICE_SOURCE" = default ]; then
    PRICE_STALE=$(jq -nr --arg checked "$PRICE_DATE" --arg today "$(date -u +%Y-%m-%d)" '
        (($today + "T00:00:00Z" | fromdateiso8601) -
         ($checked + "T00:00:00Z" | fromdateiso8601)) > (90 * 86400)
        | if . then "yes" else "no" end')
fi

# ── ① 逐文件扫描：给每条用量记录盖上「它所属那一轮的模型」 ──────────────────
# 必须一份文件一份文件地走：jq -s 把多份文件合成一个数组后，文件边界就没了，
# 也就无从知道某条记录属于哪份文件的哪一轮。
STAMPED=$(
    while IFS= read -r f; do
        [ -n "$f" ] || continue
        jq -c --argjson start "$START_EPOCH" '
            def isots: sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601;
            # 起手是 unknown，只有**读到在它之前的** turn_context 才给调用盖模型章。
            # ⚠️ 不许拿「文件里第一条 turn_context」去追认排在它之前的调用：文件头被
            #   截断时，早期调用可能属于切换前的模型 A，而首个可见上下文已经是切换后的
            #   B —— 「最近的证据」证明不了前一条调用也是 B（#934 交叉 review 第 2 轮）。
            #   认不出模型就如实落 cost_unknown_tokens，宁可报「算不出」也不猜。
            reduce .[] as $r ({m: "unknown", out: []};
                if $r.type == "turn_context" and (($r.payload.model // "") != "")
                then .m = $r.payload.model
                elif $r.type == "token_usage_record" and ($r.payload.usage != null)
                     and (($r.timestamp | isots) >= $start)
                then .out += [{model: .m, u: $r.payload.usage}]
                else . end)
            | .out[]' -s "$f" 2>/dev/null
    done <<< "$MINE"
)
[ -z "$STAMPED" ] && exit 0

# ── ② 按模型分段计价，再合计 ─────────────────────────────────────────────
printf '%s\n' "$STAMPED" | jq -sr --arg mode "$MODE" --argjson prices "$PRICES" \
    --arg price_source "$PRICE_SOURCE" --arg price_date "$PRICE_DATE" --arg price_stale "$PRICE_STALE" '
    def fmt:
        if . >= 1000000 then ((. / 100000 | floor) / 10 | tostring) + "m"
        elif . >= 1000 then ((. / 100 | floor) / 10 | tostring) + "k"
        else (. | floor | tostring) end;
    def usd2:
        (. * 100 + 0.5 | floor) as $c |
        ($c / 100 | floor) as $d |
        ($c - $d * 100) as $r |
        "\($d).\(if $r < 10 then "0\($r)" else "\($r)" end)";

    # ⚠️ 机器字段（--kv）**一概不舍入**，直接发原值（#934 交叉 review 第 9 轮）。
    #   两位小数是给人读的那一行用的。把同一个格式套到标记上，等于在**序列化边界**
    #   把信息销毁：下游再怎么改都恢复不了。我前两轮的错法是一路挪阈值——先两位、
    #   再六位——那只是把边界推远，没有去掉边界：参照里 claude-haiku-4-5 的 cache read
    #   是 $0.1/M，1 个 token = $0.0000001，六位小数照样写成 `unstable:0.000000`，
    #   删日志后沿用 footer 那条路径仍旧丢掉可信状态，报告反而说「没有算出金额」。
    #   jq 对极小值会输出 `1E-7` 这类写法，采集侧走的是 float()，能原样吃下（已实测）。
    # ⚠️ 恰好是 0 的仍旧是 0：桶那一侧本来就 `select(.value > 0)`，真零不会出现。

    # cached / reasoning 都是子项，不能另计（见文件头实测）
    map({model: .model,
         in:  ((.u.input_tokens // 0) - (.u.cached_input_tokens // 0)),
         cin: (.u.cached_input_tokens // 0),
         cw:  (.u.cache_write_input_tokens // 0),
         out: (.u.output_tokens // 0)})
    | (reduce .[] as $c ({in:0, cin:0, cw:0, out:0};
          .in += $c.in | .cin += $c.cin | .cw += $c.cw | .out += $c.out)) as $t
    # 分模型小计 → 各自套自己的价 → 加起来
    | (group_by(.model)
       | map({model: .[0].model,
              s: (reduce .[] as $c ({in:0, cin:0, cw:0, out:0};
                    .in += $c.in | .cin += $c.cin | .cw += $c.cw | .out += $c.out))})) as $bym
    # 逐项取价：**有这一项的单价就算钱，没有就把它的 token 记进缺价**。
    # ⚠️ 不能只在「整个模型都没配价」时才报缺价（#934 交叉 review 第 5 轮打回）：
    #   cache_write 这一侧没有公开单价、配置里也没有这个键，旧写法却在模型有价时
    #   既不给它计价、也不把它计入 cost_unknown_tokens，直接输出 full / 缺价 0 ——
    #   等于把「这部分钱没算」悄悄抹掉。本文件原来的注释还写着「另计会让每次派工都
    #   落 partial」当理由，那个前提是错的：本机 14,081 条真实用量记录里
    #   cache_write **非零的有 0 条**，所以这一改在真实数据上一条都不会变成 partial，
    #   只有它真的非零时才报——那时本来就该报。
    # `cache_write` 是 CODEX_PRICES 里的**可选键**：配了就按它算，不配就如实记缺价。
    #   不给未列价的模型或项编造单价。
    | (reduce $bym[] as $g ({usd:0, unk:0, known:0};
          ($prices[$g.model] // $prices["*"] // null) as $p
          | [{v: $g.s.in,  p: (if $p then $p.in          else null end)},
             {v: $g.s.cin, p: (if $p then $p.cached_in   else null end)},
             {v: $g.s.out, p: (if $p then $p.out         else null end)},
             {v: $g.s.cw,  p: (if $p then $p.cache_write else null end)}] as $items
          # ⚠️ 「算出过价」只能由**真的有用量、又真的取到价**的项来支撑（#934 第 6 轮）：
          #   `.known += 1` 不看 token 数的话，一个 token 为 0 的有价项就足以把
          #   「实际用量一条都没算出价」抬成 partial。实测：只配 `in` 的价、用量全在
          #   cache read（未缓存 input = 0）→ 应为 none / 缺价 100 万，旧写法给
          #   `cost_usd=0.00 / partial`，采集侧再据此把这条派工算作「有金额」。
          #   ⚠️ 判据是**用量非零**，不是**金额非零**：单价合法为 0、或金额不足半美分
          #   四舍五入成 0.00 的，都仍然是「算出来了」。
          | reduce $items[] as $i (.;
              if $i.p != null
              then .usd += ($i.v * $i.p / 1000000)
                   | (if $i.v > 0 then .known += 1 else . end)
              else .unk += $i.v end))) as $agg
    # 同 claude 侧：有算不出价的 token 才是 none / partial；一个待计价 token 都没有
    # 的 $0 是**已知的零**（#934 第 4 轮）
    | (if $agg.unk == 0 then "full"
       elif $agg.known > 0 then "partial"
       else "none" end) as $state
    | ([$bym[]
        | select(.model != "unknown" and ((.s.in + .s.cin + .s.cw + .s.out) > 0))
        | .model] | sort | unique | join(",")) as $models
    | (if ([$bym[]
             | select(.model == "unknown" and ((.s.in + .s.cin + .s.cw + .s.out) > 0))]
            | length) > 0
       then "yes" else "no" end) as $model_unknown
    | if $mode == "--kv"
      then "in=\($t.in) out=\($t.out) cache_r=\($t.cin) cache_w=\($t.cw)"
           + (if $state == "none" then "" else " cost_usd=\($agg.usd)" end)
           + " cost_state=\($state) cost_unknown_tokens=\($agg.unk)"
           # 这一侧取内置或部署者配置的 API 参考价，不是本机反解值
           + " price_source=\($price_source)"
           + (if $price_source == "default"
              then " price_checked=\($price_date) price_stale=\($price_stale)"
              else "" end)
           + " models=\($models) model_unknown=\($model_unknown)"
      else "\($t.in | fmt) input, \($t.out | fmt) output, \($t.cin | fmt) cache read, \($t.cw | fmt) cache write"
           + (if $state == "none" then "（该模型未配单价，金额未计）"
              elif $state == "partial" then " ($\($agg.usd | usd2)，部分用量未计价，金额偏低)"
              else " ($\($agg.usd | usd2))" end)
           + (if $price_source == "default" and $price_stale == "yes"
              then "（内置 API 参考价已超过 90 天，请复核）"
              else "" end)
      end
' 2>/dev/null
