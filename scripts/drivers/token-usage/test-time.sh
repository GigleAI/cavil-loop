#!/usr/bin/env bash
# 评论 footer 的项目测试耗时命令（COMMENT_FOOTER_EXTRA_CMD）的内置实现（GitHub#244）。
#
# 本机配置里写（入口还没部署时照样给出「测试未知」，不让 footer 报错）：
#   COMMENT_FOOTER_EXTRA_CMD='f="$HOME/.agents/releases/cavil-loop/entrypoints/drivers/token-usage/test-time.sh"; if [ -e "$f" ]; then bash "$f"; else printf "test_secs=unknown\n- 测试统计命令尚未部署\n"; fi'
#
# 统计口径与输出见 test_time.py 文件头。整套测试那一栏只认本仓库 tests/run.sh 记的流水。
#
# 放在 token-usage/ 下是为了沿用这里的托管入口：部署器给本目录每个 *.sh 都装一个长期入口，
# 跑的永远是已合并、已部署的版本，worktree 里正在改的那份不会被执行。
set -uo pipefail

# 租约与 comment-footer.sh 相同：经托管入口进来时已持有，直接从仓库跑时这里补拿一份
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

exec python3 "$SELF_DIR/test_time.py" "$@"
