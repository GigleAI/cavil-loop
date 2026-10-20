#!/usr/bin/env bash
# cavil-loop-preview-app@<port>.service（改名前叫 coding-agent-preview-app@<port>.service） 的 ExecStartPost 就绪门。
#
# 轮询后端端口直到能 accept。ExecStartPost 返回前 start job 不算完成，
# 于是 After=app 的 proxy 不会在 node 还没 bind 时就开始转发（那样首访必 502）。
#
# 参数：$1 = 公开端口（= systemd instance name）；$2 = 登记文件路径（新单元传，旧单元不传）
set -euo pipefail

PORT="${1:?need public port}"
# 读的必须是**调用本脚本的那个单元自己绑定的**登记文件，不能按「哪个文件在」去挑：
# 改名过渡期新旧两个目录可能各有一份同端口的登记，挑错就会拿另一个项目的命令起 server。
# 新单元（cavil-loop-preview-app@）把路径作为 $2 传进来；改名前的旧单元不传，
# 它的 EnvironmentFile 写死的是旧目录，所以缺省就是旧目录。只有手动调用、旧目录又
# 没有这份登记时，才退回新目录。
# shellcheck source=_names.sh
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/_names.sh"
CONF="${2:-$CAVIL_LEGACY_CONFIG_HOME/preview/${PORT}.conf}"
[ -n "${2:-}" ] || [ -f "$CONF" ] || CONF="$CAVIL_CONFIG_HOME/preview/${PORT}.conf"
# shellcheck disable=SC1090
source "$CONF"

BACKEND="${PREVIEW_BACKEND_PORT:?conf 缺 PREVIEW_BACKEND_PORT}"
DEADLINE=$(( $(date +%s) + ${PREVIEW_READY_TIMEOUT:-90} ))

# 用 bash 的 /dev/tcp 而不是 ss/curl：不依赖外部命令，且判的是「真能建连」
# 而非「端口出现在 listen 表里」——后者在 backlog 满 / 半初始化时会给假阳性。
while :; do
    if (exec 3<>"/dev/tcp/127.0.0.1/$BACKEND") 2>/dev/null; then
        exec 3<&- 2>/dev/null || true
        exit 0
    fi
    if [ "$(date +%s)" -ge "$DEADLINE" ]; then
        echo "preview :$PORT 后端 127.0.0.1:$BACKEND 在 ${PREVIEW_READY_TIMEOUT:-90}s 内没起来" >&2
        exit 1
    fi
    sleep 0.5
done
