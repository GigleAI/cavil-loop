#!/usr/bin/env bash
# 评论用量 footer：整段生成，worker 原样接在交人评论末尾（GitHub#88）
#
# 用法（模板里的 ${COMMENT_FOOTER_CMD} 已带好前三个参数）：
#   bash comment-footer.sh --agent <agent> --driver <用量驱动> --config <项目配置> \
#                          --start "<YYYY-MM-DD HH:MM:SS>" --wt <工作编号>
#
# 输出：分隔线、一行总览、折叠的「细节」、最后一行 `<!-- agent-metrics ... -->`。
# 为什么由脚本生成而不是让 worker 照说明拼：要算「其他 = 总 − 测试 − AI」、要处理项目命令
# 失败，交给 agent 每次手算必然各写各的（#25 实测过）。一份实现，测试直接跑它。
#
# 放在 token-usage/ 下是为了沿用这里的托管入口：部署器给本目录每个 *.sh 都装一个
# 长期入口（release-entry.sh），worker 调的路径在发版切换时不会被删掉。
set -uo pipefail

# 租约与用量驱动相同：经托管入口进来时已持有，直接从仓库跑时这里补拿一份
# shellcheck source=../../_names.sh
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../_names.sh"
DEPLOY_CONF="${CAVIL_DEPLOY_CONF:-$(cavil_deploy_conf)}"
[ ! -f "$DEPLOY_CONF" ] || { set -a; . "$DEPLOY_CONF"; set +a; }
DEPLOY_ROOT="${CAVIL_DEPLOY_ROOT:-$HOME/.agents/releases/cavil-loop}"
if [ -f "$DEPLOY_ROOT/.deploy.lock" ]; then exec {GLOBAL_FD}<>"$DEPLOY_ROOT/.deploy.lock"; flock -s "$GLOBAL_FD"; fi
SELF="$(readlink "/proc/$$/fd/255" 2>/dev/null || readlink -f "${BASH_SOURCE[0]}")"
SELF_DIR="$(dirname "$SELF")"
CODING_AGENT_RELEASE_ROOT="$(dirname "$(dirname "$(dirname "$SELF_DIR")")")"
if [ "$(basename "$(dirname "$CODING_AGENT_RELEASE_ROOT")")" = releases ] && [ -f "$CODING_AGENT_RELEASE_ROOT/.inuse" ]; then
    exec {LEASE_FD}<>"$CODING_AGENT_RELEASE_ROOT/.inuse"; flock -s "$LEASE_FD"
    export CODING_AGENT_RELEASE_LEASE_FD="$LEASE_FD"
fi
[ -z "${GLOBAL_FD:-}" ] || { flock -u "$GLOBAL_FD"; eval "exec ${GLOBAL_FD}>&-"; }
export CODING_AGENT_RELEASE_ROOT

exec python3 "$SELF_DIR/comment_footer.py" "$@"
