#!/usr/bin/env bash
# 查看轮询运行记录（GitHub#344）：最近 N 轮、没正常结束的轮次、入口失败、最近一份快照。
#
# 用法：
#   bash scripts/poll-history.sh [-n 轮数] [--json] [--no-log] [--config <配置文件> | --state-dir <状态目录>]
# 不给 --config / --state-dir 时：先看 $CODING_AGENT_CONFIG，再从当前目录往上找项目配置。
#
# **只读**：不改任何记录文件。被强杀的轮次不会被补成正式记录（维护者在 #344 选的 A），这里拿它
# 留下的进度文件对照进程列表，现场显示成「未正常结束」「还在跑」或「判断不了」。
# 进程列表不可信（读不到、读不懂、里面没有本进程自己）时一律「判断不了」，绝不写成「未正常结束」。
#
# 文字和 --json 用同一份整理结果（先拼成一个 JSON，再渲染），两边的轮数和结果不会对不上。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_names.sh
source "$SCRIPT_DIR/_names.sh"

N=20; JSON=0; SHOW_LOG=1; CFG=""; SD=""
while [ $# -gt 0 ]; do
    case "$1" in
        -n) N="${2:-}"; shift 2 ;;
        --json) JSON=1; shift ;;
        --no-log) SHOW_LOG=0; shift ;;
        --config) CFG="${2:-}"; shift 2 ;;
        --state-dir) SD="${2:-}"; shift 2 ;;
        -h|--help) sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "不认识的参数：$1（--help 看用法）" >&2; exit 2 ;;
    esac
done
case "$N" in ''|*[!0-9]*) echo "-n 后面要跟一个正整数" >&2; exit 2 ;; esac
[ "$N" -ge 1 ] || { echo "-n 后面要跟一个正整数" >&2; exit 2; }
command -v jq >/dev/null 2>&1 || { echo "需要 jq" >&2; exit 2; }

if [ -z "$SD" ]; then
    if [ -z "$CFG" ]; then
        if [ -n "${CODING_AGENT_CONFIG:-}" ] && [ -f "$CODING_AGENT_CONFIG" ]; then
            CFG="$CODING_AGENT_CONFIG"
        else
            d="$PWD"
            while [ "$d" != "/" ]; do
                c="$(cavil_project_config "$d")"
                if [ -f "$c" ]; then CFG="$c"; break; fi
                d="$(dirname "$d")"
            done
        fi
    fi
    if [ -z "$CFG" ] || [ ! -f "$CFG" ]; then
        echo "找不到项目配置：用 --config <配置文件> 或 --state-dir <状态目录> 指明" >&2
        exit 2
    fi
    # 只取 STATE_DIR 一个值；在子进程里读配置，配置里的其他东西不进本进程。
    SD=$(bash -c 'source "$1" >/dev/null 2>&1; printf "%s" "${STATE_DIR:-}"' _ "$CFG") || SD=""
    [ -n "$SD" ] || { echo "配置里读不到 STATE_DIR：$CFG" >&2; exit 2; }
fi
RL="$SD/runlog"
ENTRY_DIR="$CAVIL_STATE_HOME/runlog/entry"
NOW=$(date +%s)

# 一个目录里的记录文件 → 一个 JSON 数组（坏文件跳过，不让一份坏记录挡住整个查看）。
slurp() {   # <目录> <最多几份（按文件名取最后几份；0 = 全部）>
    local dir="$1" max="$2" names f out="["
    [ -d "$dir" ] || { printf '[]'; return 0; }
    names=$(ls -- "$dir" 2>/dev/null | grep -E '\.json$' | LC_ALL=C sort) || names=""
    if [ "$max" -gt 0 ]; then names=$(printf '%s\n' "$names" | tail -n "$max"); fi
    while IFS= read -r f; do
        [ -n "$f" ] || continue
        if one=$(jq -c --arg file "$f" '. + {file: $file}' "$dir/$f" 2>/dev/null) && [ -n "$one" ]; then
            out+="${out:+}$one,"
        fi
    done <<< "$names"
    printf '%s]' "${out%,}"
}

ROUNDS=$(slurp "$RL/rounds" "$N")
INFLIGHT=$(slurp "$RL/inflight" 0)
ALL_IDS=$(ls -- "$RL/rounds" 2>/dev/null | sed -n 's/^[0-9]*-\(.*\)\.json$/\1/p' | jq -R . | jq -c -s .) || ALL_IDS="[]"
[ -n "$ALL_IDS" ] || ALL_IDS="[]"
ENTRIES=$(slurp "$ENTRY_DIR" 0)

# 进程列表：一次读全表。里面必须有本进程自己且格式读得懂，才算可信。
PROCS="{}"; PS_OK=false
if ps_out=$(LC_ALL=C ps -A -o pid=,lstart= 2>/dev/null); then
    table=$(printf '%s\n' "$ps_out" | awk '
        NF == 6 && $1 ~ /^[0-9]+$/ && $3 ~ /^[A-Za-z][A-Za-z][A-Za-z]$/ && $4 ~ /^[0-9][0-9]?$/ \
            && $5 ~ /^[0-9][0-9]:[0-9][0-9]:[0-9][0-9]$/ && $6 ~ /^[0-9][0-9][0-9][0-9]$/ {
            gsub(":", "", $5); printf "%s %s%s%02d.%s\n", $1, $6, $3, $4, $5 }') || table=""
    if printf '%s\n' "$table" | grep -q "^$$ "; then
        PROCS=$(printf '%s\n' "$table" | jq -R 'split(" ") | {(.[0]): .[1]}' | jq -c -s 'add // {}') || PROCS="{}"
        [ -n "$PROCS" ] && PS_OK=true || PROCS="{}"
    fi
fi

SNAP="null"; SNAP_FILE=""
if [ -d "$RL/snapshots" ]; then
    SNAP_FILE=$(ls -t -- "$RL/snapshots" 2>/dev/null | grep -E '\.json$' | head -n 1) || SNAP_FILE=""
    if [ -n "$SNAP_FILE" ]; then
        SNAP=$(jq -c --arg file "$SNAP_FILE" 'del(.rounds) + {file: $file}' "$RL/snapshots/$SNAP_FILE" 2>/dev/null) || SNAP="null"
        [ -n "$SNAP" ] || SNAP="null"
    fi
fi
SNAP_NAMES=$(ls -- "$RL/snapshots" 2>/dev/null | jq -R . | jq -c -s .) || SNAP_NAMES="[]"
[ -n "$SNAP_NAMES" ] || SNAP_NAMES="[]"

CFG_TOK=""
[ -z "$CFG" ] || CFG_TOK="$CFG"

MODEL=$(jq -n -c \
    --argjson rounds "$ROUNDS" --argjson inflight "$INFLIGHT" --argjson ids "$ALL_IDS" \
    --argjson entries "$ENTRIES" --argjson procs "$PROCS" --argjson ps_ok "$PS_OK" \
    --argjson snap "$SNAP" --argjson snap_names "$SNAP_NAMES" --argjson now "$NOW" \
    --arg cfg "$CFG_TOK" --arg state_dir "$SD" '
    def state($id):
        if ($ids | index($id)) != null then "finished"
        elif ($ps_ok | not) then "unknown"
        else ($id | capture("^(?<pid>[0-9]+)-(?<ls>.*)$")? // null) as $p
            | if $p == null then "unknown"
              elif ($procs[$p.pid] // null) == $p.ls then "running"
              else "vanished" end
        end;
    {
      state_dir: $state_dir,
      now: $now,
      process_list_trusted: $ps_ok,
      rounds: ($rounds | map(
          . + {snapshot_state:
                 (if (.snapshot.state // "none") == "written"
                  then (.snapshot.name as $sn | if ($snap_names | index($sn)) != null then "written" else "expired" end)
                  else (.snapshot.state // "none") end)})),
      inflight: ($inflight | map({id, start, step, steps, age: ($now - (.start // $now)), state: state(.id)})),
      # 入口记录按配置路径认项目；没给配置（--state-dir）时全列出来。
      entries: ($entries | map(select($cfg == "" or .config == $cfg or .config == "none" or .config == "invalid"))),
      last_snapshot: $snap,
      newest_record_age:
          ([($rounds[]?.end), ($inflight[]?.start)] | map(select(type == "number")) | max as $m
           | if $m == null then null else ($now - $m) end)
    }')

if [ "$JSON" = 1 ]; then
    printf '%s\n' "$MODEL"
    exit 0
fi

echo "轮询运行记录：$RL"
echo
ROUND_COUNT=$(printf '%s' "$MODEL" | jq '.rounds | length')
if [ "$ROUND_COUNT" = 0 ]; then
    echo "（没有正式记录）"
else
    echo "最近 $ROUND_COUNT 轮（GitHub 调用只算轮询进程自己发出的，不含派工子脚本）："
    printf '%s' "$MODEL" | jq -r '
        def tm: strflocaltime("%m-%d %H:%M:%S");
        def calls: if .gh_calls == null then "未知" else "\(.gh_calls)/\(.gh_failed)" + (if .gh_capped == 1 then "+" else "" end) end;
        def snap: if .snapshot_state == "written" then "有快照"
                  elif .snapshot_state == "expired" then "快照已过期"
                  elif .snapshot_state == "dedup" then "同类快照已有"
                  elif .snapshot_state == "failed" then "快照没写成"
                  else "" end;
        (["开始", "耗时", "结果", "最后一步", "候选/派工/失败", "调用/失败", "轻量检查", "备注"] | @tsv),
        (.rounds[] | [(.start | tm), "\(.secs)s", .outcome, .step,
                      "\(.candidates // 0)/\(.dispatched // 0)/\(.dispatch_failed // 0)", calls,
                      (if (.probe // "") == "" then "-" else .probe end),
                      ([snap, (if .holder then "占锁 \(.holder)，已跑 \(.holder_age)s" else "" end)] | map(select(. != "")) | join("；"))]
                     | @tsv)' | column -t -s "$(printf '\t')" 2>/dev/null || true
fi

INFL=$(printf '%s' "$MODEL" | jq -r '.inflight[] | select(.state != "finished")
    | "  \(.id)  停在「\(.step)」，\(.age)s 前开始  →  " +
      (if .state == "running" then "还在跑"
       elif .state == "vanished" then "未正常结束（进程已不在；没有正式记录）"
       else "判断不了（进程列表读不到或读不懂）" end)')
if [ -n "$INFL" ]; then
    echo
    echo "没有正式记录的轮次（来自进度文件）："
    printf '%s\n' "$INFL"
fi

ENT=$(printf '%s' "$MODEL" | jq -r '.entries[]
    | "  \(.id)  \(.t | strflocaltime("%m-%d %H:%M:%S"))  " +
      (if .ev == "early-exit" then "加载配置前退出，退出码 \(.rc)" else "入口启动了，主轮询没起来（或正要起来）" end)')
if [ -n "$ENT" ]; then
    echo
    echo "入口记录（主轮询没走到「配置加载完」的那几次）："
    printf '%s\n' "$ENT"
fi

AGE=$(printf '%s' "$MODEL" | jq -r '.newest_record_age // "none"')
if [ "$AGE" = none ] || [ "$AGE" -gt 1800 ]; then
    echo
    if [ "$AGE" = none ]; then echo "这里一条记录都没有。"; else echo "最近 $((AGE / 60)) 分钟没有任何记录。"; fi
    echo "入口脚本自己都没被执行时，这里什么也记不下，去看调度器的日志："
    echo "  journalctl --user -u 'cavil-loop-poll@*' --since '-1h' --no-pager        （Linux）"
    echo "  launchctl print gui/\$UID/dev.luosky.cavil-loop.<项目 key>                （macOS）"
    echo "记录开关关着（配置里 ENABLE_POLL_RUN_LOG=false）时这里也是空的。"
fi

if [ "$(printf '%s' "$MODEL" | jq -r '.last_snapshot != null')" = true ]; then
    echo
    echo "最近一份快照：$RL/snapshots/$SNAP_FILE"
    printf '%s' "$MODEL" | jq -r '.last_snapshot
        | "  时间 \(.t | strflocaltime("%Y-%m-%d %H:%M:%S"))  原因 \(.reason)  位置 \(.where)  退出码 \(.rc)  轻量检查 \(if .probe == "" then "-" else .probe end)",
          "  步骤（名字, 秒）：\(.steps | map("\(.[0]) \(.[1])") | join(" → "))",
          "  配置：\(.config | to_entries | map("\(.key)=\(.value)") | join(" "))",
          "  节奏状态：\(if .pace == null then "读不到" else (.pace | to_entries | map("\(.key)=\(.value)") | join(" ")) end)",
          "  版本 \(.release)  bash \(.bash)"'
    if [ "$SHOW_LOG" = 1 ]; then
        FROM=$(printf '%s' "$MODEL" | jq -r '.last_snapshot.poll_log.from // 0')
        TO=$(printf '%s' "$MODEL" | jq -r '.last_snapshot.poll_log.to // 0')
        LOGF="$SD/poll.log"
        echo "  那一轮在 poll.log 里的内容（字节 ${FROM}–${TO}）："
        if [ -f "$LOGF" ] && [ "$TO" -gt "$FROM" ] && [ "$(wc -c < "$LOGF")" -ge "$TO" ]; then
            tail -c "+$((FROM + 1))" "$LOGF" | head -c "$((TO - FROM))" | head -n 200 | sed 's/^/    /'
        elif [ "$TO" -le "$FROM" ]; then
            echo "    （那一轮没往 poll.log 写东西）"
        else
            echo "    （读不到：poll.log 不在，或已经被截短）"
        fi
    fi
fi
