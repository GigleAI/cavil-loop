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
# ⚠️ 金额：本 driver **不自带价目表**。codex 侧的单价属于部署环境，没有可信默认值，
#   硬编一个只会把「估算」伪装成「账单」。没配就只出 token、不出金额，周报会如实记
#   「缺金额」——并且明说「占比算不出来，**不是 0%**」。
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
#     CODEX_PRICES='{"gpt-6-astra":{"in":1.25,"cached_in":0.125,"out":10}}'
#
#   没在表里的模型**不套价**：它的 token 计进 cost_unknown_tokens，该次派工落
#   cost_state=partial（有别的模型算出了金额）或 none（一个都没算出来）。
#   旧的三个环境变量仍然认，作为「所有模型同一个价」的兼容写法：
#     CODEX_PRICE_IN_PER_M / CODEX_PRICE_CACHED_IN_PER_M / CODEX_PRICE_OUT_PER_M
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
PRICES="${CODEX_PRICES:-{\}}"
# 旧的三个变量 → 当成「所有模型同价」的兜底表，用 * 作通配键
if [ -n "$PI" ] && [ -n "$PC" ] && [ -n "$PO" ]; then
    PRICES=$(printf '%s' "$PRICES" | jq -c --argjson d "{\"in\":$PI,\"cached_in\":$PC,\"out\":$PO}" \
        '. + {"*": $d}' 2>/dev/null || printf '{"*":{"in":%s,"cached_in":%s,"out":%s}}' "$PI" "$PC" "$PO")
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
printf '%s\n' "$STAMPED" | jq -sr --arg mode "$MODE" --argjson prices "$PRICES" '
    def fmt:
        if . >= 1000000 then ((. / 100000 | floor) / 10 | tostring) + "m"
        elif . >= 1000 then ((. / 100 | floor) / 10 | tostring) + "k"
        else (. | floor | tostring) end;
    def usd2:
        (. * 100 + 0.5 | floor) as $c |
        ($c / 100 | floor) as $d |
        ($c - $d * 100) as $r |
        "\($d).\(if $r < 10 then "0\($r)" else "\($r)" end)";

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
    | (reduce $bym[] as $g ({usd:0, unk:0, known:0};
          ($prices[$g.model] // $prices["*"] // null) as $p
          | if $p
            then .usd += (($g.s.in * $p.in + $g.s.cin * $p.cached_in + $g.s.out * $p.out) / 1000000)
                 | .known += 1
            # ⚠️ cache_write 这一侧没有公开单价，配置里也没有这个键：模型有价时
            #    它就是**没计进金额**的那部分（下方 cost_unknown_tokens 只统计
            #    整个模型都没价的情形，这一项另计会让每次派工都落 partial）。
            else .unk += ($g.s.in + $g.s.cin + $g.s.cw + $g.s.out) end)) as $agg
    | (if $agg.unk == 0 and $agg.known > 0 then "full"
       elif $agg.known > 0 then "partial"
       else "none" end) as $state
    | if $mode == "--kv"
      then "in=\($t.in) out=\($t.out) cache_r=\($t.cin) cache_w=\($t.cw)"
           + (if $state == "none" then "" else " cost_usd=\($agg.usd | usd2)" end)
           + " cost_state=\($state) cost_unknown_tokens=\($agg.unk)"
           # 这一侧的单价是**人工配置**的，不是反解出来的，所以没有四态可言
           + " price_source=configured"
      else "\($t.in | fmt) input, \($t.out | fmt) output, \($t.cin | fmt) cache read, \($t.cw | fmt) cache write"
           + (if $state == "none" then "（该模型未配单价，金额未计）"
              elif $state == "partial" then " ($\($agg.usd | usd2)，部分模型未配单价，金额偏低)"
              else " ($\($agg.usd | usd2))" end)
      end
' 2>/dev/null
