#!/usr/bin/env bash
# 本机解卡：把卡住检测「停住」的一条放开（GitHub#339）。
#
# 用法：
#   bash scripts/stuck-release.sh <项目名> <issue / PR 编号>
#
# <项目名> 是 setup.sh 接入时的实例名（~/.config/cavil-loop/<项目名>.conf），也可以直接给项目
# 配置文件的路径。
#
# 什么时候用：daemon 对一条停手之后，正常的恢复办法是人在 GitHub 上重新打派工标签（见停住说明
# 评论）。停住说明一直发不出去、或 daemon 一直记不下恢复起点时，那条路走不通，才用这条命令。
#
# 它做的事（只改本机记录，不写 GitHub）：
#   1. 拿这个项目的轮询锁（最多等 2 分钟），拿着锁期间这个项目的轮询暂停
#   2. 找这一条的停住记录
#   3. 现读条目的整份身份：打开 / 合并、目标分支、最新提交、来源仓库、标签、最新一条流程
#      标签事件，以及关联条目的打开状态和标签——和派工前最后一次核对读的是同一组内容
#   4. 打印记录和读到的内容，要求输入 yes（最多等 5 分钟）
#   5. 再读一遍，和第 3 步整串相同才删掉停住记录
# 删掉之后这一条回到普通流程：条目上现有的派工标签会照常派工。所以先在页面上把流程标签整理成
# 想要的样子，再运行。
#
# 退出码：0 = 已解除；1 = 用法错误 / 没有这个项目 / 没有停住记录；2 = 等锁超时；
#        3 = 确认之后再读，读不全或和确认前不一样；4 = 读不到 GitHub 或本机状态文件；5 = 没有输入 yes。
# 非 0 退出时什么都没改。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

case "${1:-}" in
    -h|--help) sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
esac
KEY="${1:-}"; NUM="${2:-}"
if [ -z "$KEY" ] || ! [[ "$NUM" =~ ^[0-9]+$ ]]; then
    echo "用法：$0 <项目名> <issue / PR 编号>"
    exit 1
fi

# shellcheck source=_names.sh
source "$SCRIPT_DIR/_names.sh"
if [ -f "$KEY" ]; then
    export CODING_AGENT_CONFIG="$KEY"
else
    if ! [[ "$KEY" =~ ^[A-Za-z0-9_.-]+$ ]]; then
        echo "项目名只能含 [A-Za-z0-9_.-]：$KEY"
        exit 1
    fi
    env_file="$(cavil_project_env "$KEY")"
    if [ ! -f "$env_file" ]; then
        echo "没有接入项目 $KEY（找不到 $env_file）"
        exit 1
    fi
    # 后台任务的环境文件（KEY=VALUE，可带一层引号）：照它的内容设环境，和轮询跑起来时一样
    while IFS= read -r line || [ -n "$line" ]; do
        [[ "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue
        name="${BASH_REMATCH[1]}"; value="${BASH_REMATCH[2]}"
        case "$value" in
            \"*\") value="${value#\"}"; value="${value%\"}" ;;
            \'*\') value="${value#\'}"; value="${value%\'}" ;;
        esac
        export "$name=$value"
    done < "$env_file"
fi

# shellcheck source=_lib.sh
source "$SCRIPT_DIR/_lib.sh"
# 注意：source _lib.sh 之后本进程的 stderr 是 /dev/null，下面给人看的话都走 stdout。

STATE_FILE="$STATE_DIR/state.json"
LOCK_FILE="$STATE_DIR/poll.lock"
LOCK_WAIT="${STUCK_RELEASE_LOCK_WAIT:-120}"
CONFIRM_WAIT="${STUCK_RELEASE_CONFIRM_WAIT:-300}"
case "$LOCK_WAIT" in ''|*[!0-9]*) LOCK_WAIT=120 ;; esac
case "$CONFIRM_WAIT" in ''|*[!0-9]*) CONFIRM_WAIT=300 ;; esac

if [ ! -f "$STATE_FILE" ]; then
    echo "没有停住记录：#$NUM（这个项目还没有状态文件 $STATE_FILE）"
    exit 1
fi

# 1. 轮询锁
exec 8>"$LOCK_FILE"
if ! flock -w "$LOCK_WAIT" 8; then
    echo "等了 $LOCK_WAIT 秒没拿到轮询锁（轮询正在跑），什么都没改。稍后再运行。"
    exit 2
fi

# 2. 停住记录（按目标编号找；给的是关联条目的编号也认）
# 读不出本机状态 ≠ 没有记录
if ! n=$(jq -er --arg n "$NUM" 'if type == "object" and ((.stuck_workers // {}) | type) == "object"
        then ([(.stuck_workers // {}) | to_entries[]
               | select(.value.frozen != null and ((.value.num == $n) or ((.value.frozen.items // []) | index($n) != null)))
               | .key] | first // "")
        else error("bad state") end' "$STATE_FILE" 2>/dev/null); then
    echo "读不出本机的状态文件 $STATE_FILE，不能解除。什么都没改。"
    exit 4
fi
if [ -z "$n" ]; then
    echo "没有停住记录：#$NUM"
    exit 1
fi
F=()
if e=$(stuck_entry "$n"); then
    mapfile -t F < <(stuck_fields "$e" '[.kind, .num, (.frozen.base // 0)]') || F=()
fi
if [ "${#F[@]}" != 3 ]; then
    echo "读不出本机的停住记录（$STATE_FILE），不能解除。什么都没改。"
    exit 4
fi
kind="${F[0]}"; num="${F[1]}"; base="${F[2]}"
case "$base" in ''|*[!0-9]*) base=0 ;; esac
if [ -z "$kind" ] || [ -z "$num" ]; then
    echo "停住记录不成形（缺条目类型或编号），什么都没改：$e"
    exit 1
fi

# 3. 现读整份身份
if ! doc1=$(stuck_release_doc "$kind" "$num" "$base"); then
    echo "读不到 GitHub，不能解除；网络恢复后再运行。什么都没改。"
    exit 4
fi

# 4. 给人看，等确认
echo "停住记录（$kind #$num，工作编号 $n）："
printf '%s' "$e" | jq '{kind, num, frozen: (.frozen | {why, at, items, posted, comment, base})}'
echo
echo "现在读到的 $kind #$num："
printf '%s' "$doc1" | jq '{target: .target, bound: .bound, last_flow_label_event: .last}'
echo
echo "解除后，这一条回到普通流程：条目上现有的派工标签会照常派工；"
echo "遗留的 $LABEL_AGENT_DOING、${LABEL_PENDING_REVIEW:-$LABEL_PENDING_AGENT} 等流程标签请先在页面上摘掉再运行。"
printf '确认解除请输入 yes：'
ans=""
read -r -t "$CONFIRM_WAIT" ans || ans=""
if [ "$ans" != yes ]; then
    echo
    echo "没有输入 yes，什么都没改。"
    exit 5
fi

# 5. 再读一遍，整串相同才删
if ! doc2=$(stuck_release_doc "$kind" "$num" "$base"); then
    echo "确认之后再读 GitHub 没读全，不解除。什么都没改，要解除请重新运行。"
    exit 3
fi
if [ "$doc1" != "$doc2" ]; then
    echo "确认期间条目变了，不解除。什么都没改，要解除请重新运行。变化："
    diff <(printf '%s' "$doc1" | jq -S .) <(printf '%s' "$doc2" | jq -S .) || true
    exit 3
fi
if ! stuck_entry_del "$n"; then
    echo "停住记录没删掉（写不了 $STATE_FILE），什么都没改。"
    exit 3
fi
rm -f "$(stuck_release_file "$n")"
log "卡住检测：$kind #$num 的停住记录已由本机命令 stuck-release.sh 解除"
echo "已解除：$kind #$num。下一轮轮询起照普通流程处理。"
exit 0
