#!/usr/bin/env bash
# Token usage driver: Claude
#
# 用法: bash claude.sh <start_epoch>
#
# 读 claude 本地 transcript jsonl 累加 timestamp >= start_epoch 之后的所有
# assistant message usage（input/output/cache_creation/cache_read），输出
# "in <N>k · cache <N>k · out <N>k" 一行。
#
# Transcript 路径约定：~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
#   encoded-cwd = pwd 里 / 全换 -（claude CLI 约定）
#   同 cwd 多 session 时取 mtime 最新（daemon 当前架构 1 worktree=1 session，不撞）
#
# 漏算：worker 调本脚本的 Bash 调用本身 + 之后到 gh comment 完成那段，
# transcript 还没 flush 进去，会漏 < 1%（整任务比例）。可忽略。
set -uo pipefail

START_EPOCH="${1:?need start epoch}"

ENC=$(pwd | tr / -)
TRANSCRIPT=$(ls -t ~/.claude/projects/${ENC}/*.jsonl 2>/dev/null | head -1)
[ -z "$TRANSCRIPT" ] && exit 0

jq -sr --argjson start "$START_EPOCH" '
    def k:
        if . >= 1000000 then ((. / 1000000) * 10 | floor / 10 | tostring) + "M"
        elif . >= 1000 then (. / 1000 | floor | tostring) + "k"
        else tostring end;
    [.[] | select(.type == "assistant" and (.message.usage // empty))
         | select((.timestamp | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601) >= $start)
         | .message.usage]
    | reduce .[] as $u (
        {in:0, out:0, cache_r:0};
        .in += (($u.input_tokens // 0) + ($u.cache_creation_input_tokens // 0) + ($u.cache_read_input_tokens // 0))
        | .out += ($u.output_tokens // 0)
        | .cache_r += ($u.cache_read_input_tokens // 0)
      )
    | "in \(.in | k) (cache hit \(if .in > 0 then (.cache_r * 100 / .in | floor) else 0 end)%) · out \(.out | k)"
' "$TRANSCRIPT" 2>/dev/null
