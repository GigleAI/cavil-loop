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
# ⚠️ 金额：本 driver **不自带价目表**。codex 侧的单价属于部署环境，没有可信默认值，
#   硬编一个只会把「估算」伪装成「账单」。要出金额就在项目配置里设这三个（单位：
#   美元 / 百万 token），没设就只出 token、不出金额，周报会如实记「缺金额」：
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

# shellcheck disable=SC2086
jq -sr --argjson start "$START_EPOCH" --arg mode "$MODE" \
       --arg pi "$PI" --arg pc "$PC" --arg po "$PO" '
    def fmt:
        if . >= 1000000 then ((. / 100000 | floor) / 10 | tostring) + "m"
        elif . >= 1000 then ((. / 100 | floor) / 10 | tostring) + "k"
        else (. | floor | tostring) end;
    def usd2:
        (. * 100 + 0.5 | floor) as $c |
        ($c / 100 | floor) as $d |
        ($c - $d * 100) as $r |
        "\($d).\(if $r < 10 then "0\($r)" else "\($r)" end)";

    [.[] | select(.type == "token_usage_record"
              and (.payload.usage // empty)
              and ((.timestamp | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601) >= $start))
         | .payload.usage]
    | reduce .[] as $u (
        {in:0, cin:0, cw:0, out:0};
        .in  += (($u.input_tokens // 0) - ($u.cached_input_tokens // 0))
        | .cin += ($u.cached_input_tokens // 0)
        | .cw  += ($u.cache_write_input_tokens // 0)
        | .out += (($u.output_tokens // 0) + ($u.reasoning_output_tokens // 0))
      )
    | . as $t
    | (if ($pi != "" and $pc != "" and $po != "")
       then (($t.in * ($pi | tonumber) + $t.cin * ($pc | tonumber)
              + $t.out * ($po | tonumber)) / 1000000)
       else null end) as $usd
    | if $mode == "--kv"
      then "in=\($t.in) out=\($t.out) cache_r=\($t.cin) cache_w=\($t.cw)"
           + (if $usd == null then "" else " cost_usd=\($usd | usd2)" end)
      else "\($t.in | fmt) input, \($t.out | fmt) output, \($t.cin | fmt) cache read, \($t.cw | fmt) cache write"
           + (if $usd == null then "（未配单价，金额未计）" else " ($\($usd | usd2))" end)
      end
' $(echo "$MINE") 2>/dev/null
