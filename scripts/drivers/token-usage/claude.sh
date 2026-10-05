#!/usr/bin/env bash
# Token usage driver: Claude
#
# 用法: bash claude.sh <start_epoch> [--kv]
#
# 读 claude 本地 transcript jsonl，统计 [start_epoch, 现在) 这段里的用量与金额。
# 默认输出跟 claude CLI 的 /usage 命令接近的一行人话：
#
#   2.4k input, 153.5k output, 42.8m cache read, 1.1m cache write ($32.24)（模型：claude-opus-5）
#
# 加 --kv 则输出机器可读的一行（给评论末尾的 agent-metrics 标记用）。
#
# ⚠️ 模型名要**两边都出**（GitHub#29）：评论 footer 的 `token …` 行是「整行原样用脚本
#   输出」的，所以模型只写进 --kv 的隐藏标记时，GitHub 评论上（尤其手机端）根本看不到
#   本轮用的是哪个模型。人读行末尾因此固定附一段模型说明，口径与 models /
#   model_unknown 同源：`（模型：a、b）` / `（模型：a；另有模型无法确认）` / `（模型未知）`。
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
#   price_source         solved（本机反解）—— codex 那一侧写 configured（人工配置）
#   price_status         金额按单价可信度拆开，如 corroborated:41.20,disputed:2.16
#   models               本窗口实际产生非零用量的模型 ID，去重、排序、逗号分隔
#   model_unknown        yes / no —— 是否另有非零用量无法归属到模型
#
# ⚠️ price_status 必须真的发出去。它原来算了却没进输出，结果「用参照兜底的存疑金额」
#   和「已与参照核对过的金额」在周报里长得一模一样，设计承诺的报红形同虚设
#   （#934 交叉 review 第 1 轮打回）。
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

    # ⚠️ 机器字段（--kv）**一概不舍入**，直接发原值（#934 交叉 review 第 9 轮）。
    #   两位小数是给人读的那一行用的。把同一个格式套到标记上，等于在**序列化边界**
    #   把信息销毁：下游再怎么改都恢复不了。我前两轮的错法是一路挪阈值——先两位、
    #   再六位——那只是把边界推远，没有去掉边界：参照里 claude-haiku-4-5 的 cache read
    #   是 $0.1/M，1 个 token = $0.0000001，六位小数照样写成 `unstable:0.000000`，
    #   删日志后沿用 footer 那条路径仍旧丢掉可信状态，报告反而说「没有算出金额」。
    #   jq 对极小值会输出 `1E-7` 这类写法，采集侧走的是 float()，能原样吃下（已实测）。
    # ⚠️ 恰好是 0 的仍旧是 0：桶那一侧本来就 `select(.value > 0)`，真零不会出现。

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
          # 每一项：取到的价 + 这个价的可信度（corroborated / uncorroborated /
          # disputed / unstable / reference_only）。可信度要跟着金额一路带到周报，
          # 否则用参照兜底的存疑金额和已核对的金额在报告上长得一样。
          | ([$c.tok | to_entries[]
              | . as $e
              | (if $syn then null
                 elif $fast then {p: ($fast[$e.key] // null), st: "reference_only"}
                 elif $tbl then {p: ($tbl[$e.key].price // null),
                                 st: ($tbl[$e.key].status // "unstable")}
                 else null end) as $pr
              | {v: $e.value,
                 p: (if $pr then $pr.p else null end),
                 st: (if $pr then $pr.st else null end)}]) as $items
          | {tok: $c.tok, model: $c.model, syn: $syn,
             priced: ([$items[] | if .p == null then 0 else .v * .p / 1000000 end] | add),
             unknown: ([$items[] | if ($syn or .p != null) then 0 else .v end] | add),
             # 同 codex 侧（#934 第 6 轮）：token 为 0 的有价项不能充当「算出过价」的证据。
             # 当前参照表里每个模型的五项要么全有价、要么全没有，所以这一条在
             # policy=A 下暂时触发不到；但 policy=B 允许逐项无价，规则必须一致。
             known_any: ([$items[] | if ($syn or .p == null or .v <= 0) then 0 else 1 end] | add),
             bystat: (reduce $items[] as $i ({};
                        if $i.p == null then .
                        else .[$i.st] = ((.[$i.st] // 0) + $i.v * $i.p / 1000000) end))})
    | reduce .[] as $c (
        {in:0, out:0, cr:0, cw_5m:0, cw_1h:0, usd:0, unk:0, known:0, models:{}, bystat:{}};
          .in     += $c.tok.input
        | .out    += $c.tok.output
        | .cr     += $c.tok.cache_read
        | .cw_5m  += $c.tok.cache_write_5m
        | .cw_1h  += $c.tok.cache_write_1h
        | .usd    += $c.priced
        | .unk    += $c.unknown
        | .known  += $c.known_any
        | .models[$c.model] = ((.models[$c.model] // 0)
            + $c.tok.input + $c.tok.output + $c.tok.cache_read
            + $c.tok.cache_write_5m + $c.tok.cache_write_1h)
        | .bystat = (reduce ($c.bystat | to_entries[]) as $e (.bystat;
                       .[$e.key] = ((.[$e.key] // 0) + $e.value)))
      )
    | (.cw_5m + .cw_1h) as $cw
    # 判据是**有没有算不出价的 token**，不是「有没有算出过价」：窗口里没有真实调用
    # （或只有 <synthetic>）时金额就是**已知的零**，不是「算不出」（#934 第 4 轮）。
    | (if .unk == 0 then "full"
       elif .known > 0 then "partial"
       else "none" end) as $state
    # 金额按单价可信度拆开，形如 corroborated:41.20,disputed:2.16（无空格，进标记不破格式）。
    # 发原值而不是 usd2：舍成 0.00 的桶，可信状态就在源头没了。
    | ([.bystat | to_entries[] | select(.value > 0)
        | "\(.key):\(.value)"] | join(",")) as $pstat
    | (.bystat.disputed // 0) as $dsp
    # 模型集合只描述真正产生用量的调用；<synthetic> 和全零记录都不能冒充证据。
    # unknown 是归属状态而非模型 ID，单独输出，避免污染 models 列表。
    | ([.models | to_entries[]
        | select(.key != "unknown" and .key != "<synthetic>" and .value > 0)
        | .key] | sort) as $modelarr
    | ($modelarr | join(",")) as $models
    | (if ((.models.unknown // 0) > 0) then "yes" else "no" end) as $model_unknown
    | if $mode == "--kv"
      then "in=\(.in) out=\(.out) cache_r=\(.cr) cache_w=\($cw)"
           + (if $state == "none" then "" else " cost_usd=\(.usd)" end)
           + " cost_state=\($state) cost_unknown_tokens=\(.unk)"
           # 单价出处：这一侧是本机反解的（codex 那侧是人工配置，写 configured）
           + " price_source=solved"
           + (if $pstat == "" then "" else " price_status=\($pstat)" end)
           + " models=\($models) model_unknown=\($model_unknown)"
      else "\(.in | fmt) input, \(.out | fmt) output, \(.cr | fmt) cache read, \($cw | fmt) cache write"
           + (if $state == "none" then "（单价未知，金额未计）"
              elif $state == "partial" then " ($\(.usd | usd2)，部分用量未计价，金额偏低)"
              else " ($\(.usd | usd2))" end)
           + (if $dsp > 0 then "；其中 $\($dsp | usd2) 所用单价与外部参照冲突（存疑）" else "" end)
           # 模型名必须出现在**人读**这一行（GitHub#29）：footer 的 `token …` 行是
           # 「整行原样用脚本输出」，模型只写进 --kv 的隐藏标记，等于评论里永远看不到。
           # 口径与机器字段同源（$modelarr / $model_unknown），不另起一套判断。
           + (if ($modelarr | length) == 0 then "（模型未知）"
              else "（模型：\($modelarr | join("、"))"
                   + (if $model_unknown == "yes" then "；另有模型无法确认" else "" end)
                   + "）" end)
      end
' "${FILES[@]}" 2>/dev/null
