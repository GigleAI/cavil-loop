#!/usr/bin/env bash
# Token usage driver: Claude
#
# 用法: bash claude.sh <start_epoch> [--kv]
#
# 读 claude 本地 transcript jsonl，统计 [start_epoch, 现在) 这段里的用量与金额。
# 默认输出跟 claude CLI 的 /usage 命令接近的一行人话：
#
#   2.4k input, 153.5k output, 42.8m cache read, 1.1m cache write ($32.24)
#
# 加 --kv 则输出机器可读的一行（给评论末尾的 agent-metrics 标记用）。
#
# ── 归属：先按调用归组，再落窗口（顺序不能颠倒）────────────────────────────
# 一次 API 调用会写**多条** assistant 条目（正文一条、思考一条、每次工具调用各一条），
# 它们携带**同一份** usage。逐条累加 = 同一次调用被重复计好几遍（实测 53 个会话：
# 逐条累加是按调用去重后的 1.68 倍）。
#
# ⚠️ 但**只按 requestId 去重还不够**：同一次调用的那几条消息**时间戳并不相同**
#   （实测 36,378 个调用组里 18,424 组、即 50.6% 组内时间戳不唯一，中位跨度 3 秒、
#    最长 373 秒）。原来的顺序是「先按时间过滤、再在窗口内去重」，跨窗口边界的调用
#    会被前后两个窗口**各算一次**。所以这里改成：
#      ① 按 requestId 归组（没有 requestId 的各自成组，无法归并）
#      ② 组内**最早**的 timestamp 作为这次调用的规范时刻
#      ③ 再按 [start, 现在) 过滤
#   一次调用只可能落进一个窗口。
#
# ⚠️ 读**该 worktree 的全部会话文件**，不是只读 mtime 最新的那一个：派工期间会话被
#   resume 成新文件、或事后重算时，只读最新文件会漏掉旧文件里的调用。
#
# ⚠️ 驱动**不做跨派工的重叠消解**——它只拿得到自己的 start，看不见别的派工的窗口。
#   同一 worktree 并发派工时，重叠区间的调用会被两条 footer 各算一次；周报那一侧
#   会按重叠组重新认领（见 scripts/weekly-report/collect.py）。
#
# ── 逐字段零回退（GigleTutor-Web#935）────────────────────────────────────
# 极少数 usage 记录的**顶层**计数被写成 0，真值只落在 `usage.iterations[]` 里。
# 5 个求和项各走一次「顶层 > 0 用顶层，否则用明细同名项的合计」，两者**永不相加**。
#
# ── 单价：运行时反解 + 两道检验（GigleTutor-Web#934）─────────────────────
# 不再硬编价目表——原来那张表过期了没人发现，实测 Opus 档是当前标价的 3 倍，算出来的
# 金额比 CLI 自记高 193%。现在每条调用**按它自己的模型和缓存档位**取价，价目由
# scripts/weekly-report/price_solve.py 从本机 CLI 记账反解，并给出四态：
#   corroborated 稳定且与外部参照一致 / uncorroborated 稳定但无参照（候选估算）/
#   disputed 稳定但与参照冲突（报红）/ unstable 不可解
# ⚠️ 「稳定」不等于「准确」：稳定性检验测不出系统性计数误差。详见该模块的文件头。
#
# 输出里因此多了三个字段：
#   cost_state           full / partial / none —— **价格**覆盖（模型有没有单价）
#   cost_unknown_tokens  没算进金额的 token 数
#   price_models         本次用到的模型 → 各项单价状态
#
# 漏算：worker 调本脚本的 Bash 调用本身 + 之后到 gh comment 完成那一小段，
# transcript 还没 flush 进去，会漏 < 1%（整任务比例）。可忽略。
#
# 不在这里算「排除等待的工时」：cost-state 快照是**派工结束之后**才落盘的，
# 本脚本跑在发评论之前拿不到。那个指标由周报采集器出报告时算（见 worktime.py）。
set -uo pipefail

START_EPOCH="${1:?need start epoch}"
MODE="${2:-human}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOLVER="$HERE/../../weekly-report/price_solve.py"

ENC=$(pwd | tr / -)
PROJ="${CLAUDE_PROJECTS_DIR:-$HOME/.claude/projects}/${ENC}"
# 该 worktree 的**全部**会话文件；一个都没有就什么也不输出（worker prompt 会落「未知」）
shopt -s nullglob
FILES=("$PROJ"/*.jsonl)
shopt -u nullglob
[ ${#FILES[@]} -eq 0 ] && exit 0

PRICES=$(python3 "$SOLVER" --table 2>/dev/null)
[ -z "$PRICES" ] && PRICES='{"models":{},"fast":{}}'

jq -sr --argjson start "$START_EPOCH" --arg mode "$MODE" --argjson prices "$PRICES" '
    # X.Xk / X.Xm 格式（< 1k 时显示整数）。⚠️ 是 floor 截断，不是四舍五入——
    # 采集侧按这个格式反推区间时要用截断下界（53.5k 的下界是 53500，不是 53450）。
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

    def isots: sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601;

    [.[] | select(.type == "assistant" and (.message.usage // empty))
         | {rid: (.requestId // ("__norid_" + (.uuid // "?"))),
            ts: (.timestamp | isots),
            model: ((.message.model // "unknown") | split("[")[0]),
            speed: (.message.usage.speed // "standard"),
            u: .message.usage}]
    # ① 按 requestId 归组 → ② 组内最早时刻作规范时刻 → ③ 再按窗口过滤
    | group_by(.rid)
    | map({t: (map(.ts) | min), model: .[0].model, speed: .[0].speed, u: .[0].u})
    | map(select(.t >= $start))
    # 每次调用的 5 个求和项（各自零回退）
    | map(. as $c | ($c.u.iterations // []) as $it
          | {model: $c.model, speed: $c.speed,
             tok: {input:          zf($c.u.input_tokens // 0;             $it; .input_tokens // 0),
                   output:         zf($c.u.output_tokens // 0;            $it; .output_tokens // 0),
                   cache_read:     zf($c.u.cache_read_input_tokens // 0;  $it; .cache_read_input_tokens // 0),
                   cache_write_5m: zf($c.u.cache_creation.ephemeral_5m_input_tokens // 0;
                                      $it; .cache_creation.ephemeral_5m_input_tokens // 0),
                   cache_write_1h: zf($c.u.cache_creation.ephemeral_1h_input_tokens // 0;
                                      $it; .cache_creation.ephemeral_1h_input_tokens // 0)}})
    # 逐条按自己的模型 / 档位取价。<synthetic> 不是真实调用，不参与计价也不计缺价。
    | map(. as $c
          | (if $c.speed == "fast" then ($prices.fast[$c.model] // null) else null end) as $fast
          | ($prices.models[$c.model] // null) as $tbl
          | ($c.model == "<synthetic>") as $syn
          | {tok: $c.tok, model: $c.model, syn: $syn,
             priced: ([$c.tok | to_entries[]
                       | . as $e
                       | (if $fast then ($fast[$e.key] // null)
                          elif $tbl then ($tbl[$e.key].price // null) else null end) as $pr
                       | if $syn or $pr == null then 0 else $e.value * $pr / 1000000 end] | add),
             unknown: ([$c.tok | to_entries[]
                       | . as $e
                       | (if $fast then ($fast[$e.key] // null)
                          elif $tbl then ($tbl[$e.key].price // null) else null end) as $pr
                       | if $syn or $pr != null then 0 else $e.value end] | add),
             known_any: ([$c.tok | to_entries[]
                       | . as $e
                       | (if $fast then ($fast[$e.key] // null)
                          elif $tbl then ($tbl[$e.key].price // null) else null end) as $pr
                       | if $syn or $pr == null then 0 else 1 end] | add)})
    | reduce .[] as $c (
        {in:0, out:0, cr:0, cw_5m:0, cw_1h:0, usd:0, unk:0, known:0, models:{}};
          .in     += $c.tok.input
        | .out    += $c.tok.output
        | .cr     += $c.tok.cache_read
        | .cw_5m  += $c.tok.cache_write_5m
        | .cw_1h  += $c.tok.cache_write_1h
        | .usd    += $c.priced
        | .unk    += $c.unknown
        | .known  += $c.known_any
        | .models[$c.model] = true
      )
    | (.cw_5m + .cw_1h) as $cw
    | (if .unk == 0 and .known > 0 then "full"
       elif .known > 0 then "partial"
       else "none" end) as $state
    | ([.models | keys[]
        | . as $m | {(($m)): (($prices.models[$m] // {})
                              | with_entries({key: .key, value: .value.status}))}] | add // {}) as $pstat
    | if $mode == "--kv"
      then "in=\(.in) out=\(.out) cache_r=\(.cr) cache_w=\($cw)"
           + (if $state == "none" then "" else " cost_usd=\(.usd | usd2)" end)
           + " cost_state=\($state) cost_unknown_tokens=\(.unk)"
      else "\(.in | fmt) input, \(.out | fmt) output, \(.cr | fmt) cache read, \($cw | fmt) cache write"
           + (if $state == "none" then "（单价未知，金额未计）"
              elif $state == "partial" then " ($\(.usd | usd2)，部分模型单价未知，金额偏低)"
              else " ($\(.usd | usd2))" end)
      end
' "${FILES[@]}" 2>/dev/null
