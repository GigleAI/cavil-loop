#!/usr/bin/env bash
# 把 cavil-loop daemon 接入一个 host project。
#
# 关键设计：本 skill **不复制脚本到 host project**。Linux 上 setup 会把当前 main
# 发布到不可变 release，并让稳定 skill 软链指向它；host project 里只多两样东西：
#   1. cavil-loop.config         —— 本项目专属配置（gitignored）
#   2. .gitignore 加一行排除上述 config
#
# OS 自动判断：
#   - Linux  → systemd user timer（symlink 模板，git pull 自动生效）
#   - Darwin → launchd LaunchAgent（每个 project 生成独立 plist）
#   - 其他   → exit 1，引导到 docs/operations.md 手动 cron fallback
#
# 用法：
#   bash setup.sh <host-project-path> [instance-key]
# 例：
#   bash setup.sh ~/github/myproject
#   bash setup.sh ~/github/myproject acme       # 自定义 instance key
#
# 新旧名字：新装的项目一律用 cavil-loop 命名（~/.config/cavil-loop/、cavil-loop-poll@
# 等）。对改名前装好的项目（~/.config/coding-agent-work-loop/<key>.conf 已存在）重跑
# 本脚本时，先把它迁到新名字（项目空闲时），再按新安装往下走；项目忙、迁不了时这次
# 继续沿用旧名字——绝不给同一个项目再装一套新的后台任务，两套轮询会抢同一批 issue。
set -euo pipefail

HOST="${1:-}"
KEY="${2:-}"

if [ -z "$HOST" ]; then
    cat <<EOF
用法：$0 <host-project-path> [instance-key]

  host-project-path: 目标 git 仓库工作树根
  instance-key:      调度器实例名（default = basename of host），可让多项目共存

例：
  $0 ~/github/myproject
  $0 ~/github/myproject acme
EOF
    exit 1
fi

if [ ! -e "$HOST/.git" ]; then
    echo "❌ $HOST 不是 git 仓库（找不到 .git）"
    exit 1
fi

# 解析物理路径（展开符号链接），避免 macOS TCC 限制 launchd 通过 symlink 访问外部卷
HOST="$(cd "$HOST" && pwd -P)"
SKILL_DIR="$(cd "$(dirname "$0")" && pwd -P)"
[ -z "$KEY" ] && KEY="$(basename "$HOST")"

# instance key 跨 systemd / launchd label 都要安全的字符（字母数字 _ - .）
if ! [[ "$KEY" =~ ^[A-Za-z0-9_.-]+$ ]]; then
    echo "❌ instance key 只能含 [A-Za-z0-9_.-]：$KEY"
    exit 1
fi

# ── 新装还是改名前的旧安装 ──
# shellcheck source=scripts/_names.sh
source "$SKILL_DIR/scripts/_names.sh"
set_layout() {
    LAYOUT="$1"
    if [ "$LAYOUT" = legacy ]; then
        conf_dir="$CAVIL_LEGACY_CONFIG_HOME"
        UNIT_PREFIX="$CAVIL_LEGACY_UNIT_PREFIX"
        SLICE_UNIT="$CAVIL_LEGACY_SLICE"
        SKILL_LINK="$CAVIL_LEGACY_SKILL_HOME"
        STATE_ROOT="$CAVIL_LEGACY_STATE_HOME"
        LAUNCHD_LABEL="dev.luosky.coding-agent-work-loop.$KEY"
        LAUNCHD_LOG_DIR="$HOME/Library/Logs/coding-agent-work-loop"
    else
        conf_dir="$CAVIL_CONFIG_HOME"
        UNIT_PREFIX="$CAVIL_UNIT_PREFIX"
        SLICE_UNIT="$CAVIL_SLICE"
        SKILL_LINK="$CAVIL_SKILL_HOME"
        STATE_ROOT="$CAVIL_STATE_HOME"
        LAUNCHD_LABEL="dev.luosky.cavil-loop.$KEY"
        LAUNCHD_LOG_DIR="$HOME/Library/Logs/cavil-loop"
    fi
}
if [ ! -e "$CAVIL_CONFIG_HOME/$KEY.conf" ] && [ -e "$CAVIL_LEGACY_CONFIG_HOME/$KEY.conf" ]; then
    set_layout legacy
else
    set_layout new
fi

# 改名前装好的项目：先迁到新名字（scripts/migrate-legacy.sh，与 Linux 后台每轮做的是同一件事），
# 迁成了再按新安装往下走。项目有 worker 在跑时迁不了，这次就继续沿用旧名字——绝不在旧任务
# 旁边再装一套新的，两个轮询会抢同一批 issue。
migrate_before_setup() {   # <migrate-legacy.sh 所在的技能目录> [--launchd]
    local dir="$1"; shift
    echo "── 改名前的旧安装：迁到 cavil-loop 命名 ──"
    local rc=0
    bash "$dir/scripts/migrate-legacy.sh" --key "$KEY" "$@" >/dev/null || rc=$?
    case "$rc" in
        0) set_layout new
           echo "  ✓ 已迁移（明细：$CAVIL_STATE_HOME/migrate.log）" ;;
        3) echo "  ⏳ 项目正忙（原因见上一行），这次不迁、继续沿用旧名字；空闲后再跑一次 setup.sh"
           [ "$OS" = Linux ] && echo "     （Linux 上不用等你：后台轮询会在项目空闲的那一轮自动迁）" ;;
        *) if [ -f "$CAVIL_CONFIG_HOME/migration/$KEY.inprogress" ]; then
               # 已经搬了一部分：再按旧名字装一遍会把半新半旧的东西搅乱
               echo "  ❌ 迁移做到一半停住了（原因见上面几行和 $CAVIL_STATE_HOME/migrate.log），setup 到此为止；"
               echo "     排除原因后再跑一次 setup.sh，会从停下的地方接着做"
               exit 1
           fi
           echo "  ⚠️ 迁移没开始（原因见上面几行和 $CAVIL_STATE_HOME/migrate.log），这次继续沿用旧名字" ;;
    esac
    echo
}

# ── OS 判定 ──
OS="$(uname -s)"
case "$OS" in
    Linux)  SCHEDULER="systemd" ;;
    Darwin) SCHEDULER="launchd" ;;
    *)
        echo "❌ 不支持的 OS：$OS"
        echo "   本脚本只自动配 Linux (systemd) / macOS (launchd)。"
        echo "   想用 cron 等其他调度器手动接 daemon → 见"
        echo "   https://github.com/GigleAI/cavil-loop/blob/main/docs/operations.md#manual-cron-fallback"
        exit 1
        ;;
esac

# ── 检测最佳 bash（macOS 自带 bash 3.2 不支持 associative array，优先 homebrew bash）──
if [ "$OS" = "Darwin" ] && [ -x /opt/homebrew/bin/bash ]; then
    BASH_BIN="/opt/homebrew/bin/bash"
elif command -v bash >/dev/null 2>&1; then
    BASH_BIN="$(command -v bash)"
else
    BASH_BIN="/bin/bash"
fi

echo "── cavil-loop setup ──"
echo "  host project: $HOST"
echo "  skill dir:    $SKILL_DIR"
echo "  instance key: $KEY"
if [ "$LAYOUT" = legacy ]; then
    echo "  layout:       改名前的旧安装（$conf_dir/$KEY.conf 已存在）"
fi
echo "  scheduler:    $SCHEDULER ($OS)"
echo "  bash:         $BASH_BIN"
echo

# ── Worker agent 选择 ──
# 优先级：WORKER_AGENT env > 默认 claude
# （首次 setup 时项目还没本地配置文件，所以以 env 覆盖为唯一入口；
#  二次 setup 时该字段已写进 config，下面那段会 skip 重写。）
WORKER_AGENT_PICK="${WORKER_AGENT:-claude}"

# 加载 driver 以拿到 worker 二进制名
# shellcheck source=scripts/drivers/_common.sh
source "$SKILL_DIR/scripts/drivers/_common.sh"
PROJECT_ROOT="$HOST" source_driver "$WORKER_AGENT_PICK" || {
    echo "❌ 找不到 driver '$WORKER_AGENT_PICK'。内置：claude / opencode / codex / cursor。"
    exit 1
}
WORKER_BIN="$(agent_bin)"
echo "  worker agent: $WORKER_AGENT_PICK  (binary: $WORKER_BIN)"

# ── 依赖检查 ──
# 通用依赖；调度器二进制按 OS 走下面的分支。macOS 上 flock 默认不自带，需要 `brew install flock`
common_cmds=(git gh tmux jq flock "$WORKER_BIN")
missing=()
for cmd in "${common_cmds[@]}"; do
    command -v "$cmd" >/dev/null 2>&1 || missing+=("$cmd")
done
case "$SCHEDULER" in
    systemd)
        command -v systemctl >/dev/null 2>&1 || missing+=("systemctl")
        command -v timeout >/dev/null 2>&1 || missing+=("timeout")
        ;;
    launchd) command -v launchctl >/dev/null 2>&1 || missing+=("launchctl") ;;
esac

if [ ${#missing[@]} -gt 0 ]; then
    echo "❌ 缺少依赖：${missing[*]}"
    if [ "$SCHEDULER" = "launchd" ]; then
        for m in "${missing[@]}"; do
            [ "$m" = "flock" ] && echo "   提示：macOS 上 flock 不是自带，可 \`brew install flock\`"
        done
    fi
    exit 1
fi
echo "✓ 依赖齐全"

if ! gh auth status >/dev/null 2>&1; then
    echo "❌ gh 未登录。先 \`gh auth login\`"
    exit 1
fi
echo "✓ gh 已登录"
echo

# ── Linux 受管 release bootstrap ──
# 重跑 setup 是旧式 checkout 软链迁移到受管布局的显式动作；部署器不会在日常 poll
# 中猜测并接管 releases/ 外的路径。macOS 暂时保留开发/手动更新模式，因为其系统
# 工具没有 GNU mv -T 与 stat -c；plist 变更仍由 setup 明确重装。
if [ "$OS" = Linux ]; then
    echo "── 0. 发布受管 skill release ──"
    SOURCE_SKILL_DIR="$SKILL_DIR"
    CAVIL_DEPLOY_SOURCE_DIR="$SOURCE_SKILL_DIR" CAVIL_SKILL_LINK="$SKILL_LINK" \
        bash "$SOURCE_SKILL_DIR/scripts/skill-deploy.sh" --bootstrap --force
    SKILL_DIR="$SKILL_LINK"
    # 迁移用刚发布的那一版来跑；迁成了新技能入口会指向同一个 release
    [ "$LAYOUT" = legacy ] && migrate_before_setup "$SKILL_DIR"
    SKILL_DIR="$SKILL_LINK"
    runtime_skill="$(readlink -f "$SKILL_DIR" 2>/dev/null || true)"
    case "$runtime_skill" in
        "$HOME/.agents/releases/cavil-loop/releases/"*) ;;
        *) echo "❌ bootstrap 未建立受管 release：${runtime_skill:-稳定入口不存在}"; exit 1 ;;
    esac
    echo "  ✓ runtime skill: $runtime_skill"
    echo
fi

if [ "$OS" = Darwin ] && [ "$LAYOUT" = legacy ]; then
    migrate_before_setup "$SKILL_DIR" --launchd
fi

# ── 可移植 sed in-place（绕开 GNU vs BSD `sed -i` 差异）──
subst_inplace() {
    # 用法：subst_inplace FILE EXPR [EXPR ...]
    local file=$1; shift
    local tmp; tmp=$(mktemp)
    local args=() e
    for e in "$@"; do args+=(-e "$e"); done
    sed "${args[@]}" "$file" > "$tmp" && mv "$tmp" "$file"
}

# ── 读 host config 里某个字段的值 ──
# 在 subshell 里 source，比 grep 稳：config 里写成 "$HOME/..." 的值能正常展开，
# 也不会把注释里的同名字样当成赋值。调用方只读，污染不到当前 shell。
config_value() {
    ( set -a; . "$config" >/dev/null 2>&1 || true; eval "printf '%s' \"\${$1:-}\"" )
}

# ── 1. 生成 host/cavil-loop.config ──
# 项目里已经有改名前的 coding-agent.config 就继续用它，不另建一份：项目的忽略规则写的
# 是旧文件名，改名后新文件不被忽略，可能被 worker 顺手提交进仓库。
config="$(cavil_project_config "$HOST")"
config_name="$(basename "$config")"
echo "── 1. 生成 $config ──"
# 这个文件可以装 GitHub token（GH_TOKEN / WRITE_GH_TOKEN），所以必须 0600。
# 以前完全不管权限：`cp` / `cat >` 出来的权限随 umask 走，而常见的 umask 0002
# 给出的是 0664 —— 同机任何用户一个 cat 就把 PAT 抄走了。
harden_perms() {
    chmod 600 "$1" 2>/dev/null || echo "  ⚠️  chmod 600 $1 失败，请手动收紧权限"
}
if [ -f "$config" ]; then
    echo "  ⚠️  已存在，内容跳过（手动检查是否需更新）"
    # 内容不覆盖，但权限照样收紧：老安装建出来的就是全局可读的。
    harden_perms "$config"
    echo "  ✓ 权限已确保为 600（这个文件可能装着 token）"
else
    default_repo="$(cd "$HOST" && gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null || echo "owner/repo")"
    project_name="$(basename "$HOST")"
    cp "$SKILL_DIR/cavil-loop.config.example" "$config"
    subst_inplace "$config" \
        "s|myorg/myrepo|$default_repo|" \
        "s|\$HOME/github/myproject|$HOST|" \
        "s|\$HOME/github/worktree/myproject|$HOME/github/worktree/$project_name|" \
        "s|\$HOME/.local/state/cavil-loop\"|$STATE_ROOT/$project_name\"|" \
        "s|TMUX_PREFIX=\"myproject\"|TMUX_PREFIX=\"$project_name\"|" \
        "s|^WORKER_AGENT=\"claude\"|WORKER_AGENT=\"$WORKER_AGENT_PICK\"|"
    harden_perms "$config"
    echo "  ✓ $config（权限 600）"
fi

# ── 1b. worker agent 目录信任 ──
# 新项目第一次派工最容易栽的地方：claude 这类 agent 对没见过的目录会弹
# folder-trust 确认框，而 `--dangerously-skip-permissions` **不绕过它**。
# 弹窗不让 session 秒退，于是 dispatch 的秒退探测放行、issue 照常翻成
# doing/agent，worker 却挂在弹窗上一动不动——日志里一切正常，不 attach 进去
# 根本看不出来。driver 实现了 agent_trust_paths 的，这里先把信任记录写好。
echo
echo "── 1b. worker agent 目录信任 ──"
trust_paths=("$HOST")
trust_wt="$(config_value WORKTREE_BASE)"
[ -n "$trust_wt" ] && trust_paths+=("$trust_wt")
# 三个 agent 都可能真的起会话：常规派工、fable 标签、交叉 review。
# 现在没开的以后开也不用回来重跑 setup，所以一律先信任。
trust_seen=""
for trust_agent in "$WORKER_AGENT_PICK" "$(config_value FABLE_WORKER_AGENT)" \
                   "$(config_value REVIEW_WORKER_AGENT)"; do
    [ -n "$trust_agent" ] || continue
    case " $trust_seen " in *" $trust_agent "*) continue ;; esac
    trust_seen="$trust_seen $trust_agent"
    trust_rc=0
    (
        PROJECT_ROOT="$HOST" source_driver "$trust_agent" >/dev/null 2>&1 || exit 2
        declare -f agent_trust_paths >/dev/null || exit 3
        agent_trust_paths "${trust_paths[@]}"
    ) || trust_rc=$?
    case "$trust_rc" in
        0) echo "  ✓ $trust_agent 已信任：${trust_paths[*]}" ;;
        3) echo "  · $trust_agent 没有目录信任的概念，跳过" ;;
        2) echo "  ⚠️  找不到 driver '$trust_agent'，跳过" ;;
        *) echo "  ⚠️  $trust_agent 写信任记录失败——首次派工可能卡在 trust 弹窗" ;;
    esac
done

# ── 2. .gitignore ──
echo
echo "── 2. .gitignore 排除 $config_name ──"
gitignore="$HOST/.gitignore"
if [ -f "$gitignore" ] && grep -qE "^\s*/?${config_name//./\\.}\s*$" "$gitignore"; then
    echo "  · 已在 .gitignore"
else
    [ -f "$gitignore" ] || touch "$gitignore"
    printf '\n# cavil-loop per-project config\n%s\n' "$config_name" >> "$gitignore"
    echo "  ✓ 加进 .gitignore"
fi

# ── 3. 创建 ~/.config/cavil-loop/<key>.conf（旧安装是 ~/.config/coding-agent-work-loop/）──
# systemd 用它作 EnvironmentFile；launchd 由生成的 plist 通过 `source` 加载。
echo
echo "── 3. 注册 daemon 环境文件 ──"
mkdir -p "$conf_dir"
env_file="$conf_dir/$KEY.conf"

# 文件是 KEY=VALUE 列表，无引号无 shell 展开。
#   - systemd: 直接当 EnvironmentFile=...
#   - launchd: 生成的 plist 通过 `set -a; . FILE; set +a` 内联加载（无 EnvironmentFile 等价物）
# 都需要 PATH——systemd user service / launchd LaunchAgent 默认 PATH 都很瘦，
# 把 worker CLI 所在目录拼进去；macOS Homebrew（Apple Silicon）默认在 /opt/homebrew/bin。
worker_path="$(dirname "$(command -v "$WORKER_BIN")")"
daemon_path="$worker_path:$HOME/.local/bin"
if [ "$OS" = "Darwin" ] && [ -d /opt/homebrew/bin ]; then
    daemon_path="/opt/homebrew/bin:$daemon_path"
fi
# 同样可能装着 GH_TOKEN（systemd / launchd 部署的惯常放法），一视同仁 0600。
if [ -f "$env_file" ]; then
    echo "  ⚠️  已存在，内容跳过（手动检查 PATH 是否需要更新）"
    harden_perms "$env_file"
    echo "  ✓ 权限已确保为 600"
else
    ( umask 077; cat > "$env_file" <<EOF
PROJECT_ROOT=$HOST
CODING_AGENT_CONFIG=$config
PATH=$daemon_path:/usr/local/bin:/usr/bin:/bin
EOF
    )
    harden_perms "$env_file"
    echo "  ✓ $env_file（权限 600）"
fi

# ── 4. 安装调度器 unit（按 OS 分支）──
echo
echo "── 4. 安装 $SCHEDULER unit ──"

# 从 project config 里取一个标量配置（没有 / 取不到就用默认值）。
# 用 grep 而不是 source：setup.sh 不该把别人的整份配置拉进自己的进程。
config_get() {
    local key="$1" def="$2" v
    v=$(grep -E "^[[:space:]]*$key=" "$config" 2>/dev/null | tail -1 | sed -e 's/^[^=]*=//' -e 's/[^0-9]//g')
    case "$v" in ''|*[!0-9]*) printf '%s' "$def" ;; *) printf '%s' "$v" ;; esac
}
POLL_SECS=$(config_get POLL_INTERVAL_SECS 60)

install_systemd() {
    # unit 指稳定 skill 入口；部署器每轮从 main 发布并原子切换 release。
    local sys_dir="$HOME/.config/systemd/user"
    mkdir -p "$sys_dir"
    local f src dst
    # slice 名里的 \x2d 是必须的转义（`-` 在 slice 单元名里是层级分隔符），别"顺手改成"
    # app-cavil-loop-poll.slice——那是另一个单元，配上去等于没配。
    # ${UNIT_PREFIX}-preview*@ 三件套是按需 preview 的 socket 激活链路（socket → proxy →
    # app）。跟 poll 无依赖关系，装着不用不产生任何开销——没跑过 preview-serve.sh 就
    # 没有任何 instance 存在。项目没配 PREVIEW_EXEC 时 preview-serve.sh 自己会拒绝。
    # 旧安装（LAYOUT=legacy）装的是仓库里原样保留的 coding-agent-* 旧单元。
    for f in "${UNIT_PREFIX}-poll@.service" "${UNIT_PREFIX}-poll@.timer" "$SLICE_UNIT" \
             "${UNIT_PREFIX}-preview@.socket" "${UNIT_PREFIX}-preview@.service" \
             "${UNIT_PREFIX}-preview-app@.service"; do
        src="$SKILL_DIR/systemd/$f"
        dst="$sys_dir/$f"
        if [ -L "$dst" ]; then
            if [ "$(readlink "$dst")" = "$src" ]; then
                echo "  · $f 已 symlink"
            else
                ln -sfn "$src" "$dst"
                echo "  ✓ 更新 symlink $dst -> $src"
            fi
        elif [ -e "$dst" ]; then
            echo "  ⚠️  $f 已存在（非 symlink），跳过——手动检查"
        else
            ln -s "$src" "$dst"
            echo "  ✓ symlink $dst -> $src"
        fi
    done

    # ── 本实例的轮询间隔 drop-in（让 POLL_INTERVAL_SECS 真的生效）──
    # 这个配置项长期是死的：它的注释写着「systemd timer 用这个值」，而 timer 根本不
    # 展开 EnvironmentFile，也没有任何代码读它。想改间隔只能手写 systemd 文件。
    #
    # ⚠️ systemd 里 OnBootSec / OnActiveSec / OnStartupSec / OnUnitActiveSec /
    # OnUnitInactiveSec 是**同一张 list**：drop-in 里任意一个做空赋值会把整张表清空。
    # 只写 `OnUnitActiveSec=` 加新值的话，模板里的 OnBootSec / OnActiveSec 到这个实例
    # 就没了 —— 后果是 user manager 重启后 timer 显示 active 但永远不触发（模板注释里
    # 记的 2026-07-26 停摆 3 小时就是这个）。所以三项必须一起补回来。
    #
    # OnBootSec / OnActiveSec 固定 30s（跟模板一致，它们只负责「开机后把链条种下」），
    # 只有循环间隔 OnUnitActiveSec 跟着 POLL_INTERVAL_SECS 走。
    local drop_dir="$sys_dir/${UNIT_PREFIX}-poll@$KEY.timer.d"
    local drop="$drop_dir/interval.conf"
    local mark="generated by cavil-loop setup.sh"
    # 改名前的 setup.sh 写的标记是 coding-agent-work-loop，同样算「自动生成、可以覆盖」
    if [ -e "$drop" ] && ! grep -qE "generated by (cavil-loop|coding-agent-work-loop) setup\.sh" "$drop" 2>/dev/null; then
        echo "  ⚠️  $drop 是手写的，不覆盖"
        echo "     想让 POLL_INTERVAL_SECS=$POLL_SECS 生效：删掉它再重跑 setup.sh"
    else
        mkdir -p "$drop_dir"
        cat > "$drop" <<DROP
# $mark —— 手改会被下次 setup.sh 覆盖，要固定值请改 $config_name 的 POLL_INTERVAL_SECS
# 本实例轮询间隔：${POLL_SECS}s
#
# 三项必须一起写：systemd 把 OnBootSec / OnActiveSec / OnUnitActiveSec 当同一张 list，
# 下面那个空赋值会把模板里的全部清掉，不补回来 timer 就再也不会触发。
[Timer]
OnUnitActiveSec=
OnBootSec=30s
OnActiveSec=30s
OnUnitActiveSec=${POLL_SECS}s
AccuracySec=5s
DROP
        echo "  ✓ $drop（间隔 ${POLL_SECS}s）"
        systemctl --user daemon-reload 2>/dev/null || true
    fi
}

install_launchd() {
    # launchd 没有 systemd template 模式，每 instance 必须一份独立 plist。
    # 因此 plist 是「生成」而非 symlink：skill 升级想换 plist 模板要重跑 setup.sh。
    local plist_dir="$HOME/Library/LaunchAgents"
    local log_dir="$LAUNCHD_LOG_DIR"
    local label="$LAUNCHD_LABEL"
    local plist="$plist_dir/$label.plist"
    local template="$SKILL_DIR/launchd/dev.luosky.cavil-loop.plist.template"

    mkdir -p "$plist_dir" "$log_dir"

    if [ ! -f "$template" ]; then
        echo "❌ launchd 模板不见了：$template"
        exit 1
    fi

    if [ -e "$plist" ]; then
        echo "  ⚠️  $plist 已存在，跳过——想重写请先 \`launchctl bootout gui/\$UID/$label\` 再 rm 它"
    else
        # 写到 tempfile 再 mv，避免半成品 plist 留在 LaunchAgents/
        local tmp; tmp=$(mktemp)
        sed \
            -e "s|{{LABEL}}|$label|g" \
            -e "s|{{KEY}}|$KEY|g" \
            -e "s|{{HOME}}|$HOME|g" \
            -e "s|{{SKILL_DIR}}|$SKILL_DIR|g" \
            -e "s|{{ENV_FILE}}|$env_file|g" \
            -e "s|{{LOG_DIR}}|$log_dir|g" \
            -e "s|{{BASH_BIN}}|$BASH_BIN|g" \
            -e "s|{{POLL_INTERVAL}}|$POLL_SECS|g" \
            "$template" > "$tmp"
        mv "$tmp" "$plist"
        # plutil 校验
        if command -v plutil >/dev/null 2>&1; then
            plutil -lint "$plist" >/dev/null || { echo "❌ 生成的 plist 不合法"; exit 1; }
        fi
        echo "  ✓ 生成 $plist"
    fi
}

case "$SCHEDULER" in
    systemd) install_systemd ;;
    launchd) install_launchd ;;
esac

# ── 5. GitHub labels（幂等）──
echo
echo "── 5. GitHub labels ──"
repo=$(grep -E "^REPO=" "$config" | head -1 | sed 's/.*=//' | tr -d '"' | tr -d "'")
# 默认配色照抄本仓库 GigleAI/cavil-loop 的 labels 页（#52）——新部署的项目看起来跟这里一样。
# 只管新建：已存在的 label 不改颜色和说明，别处有意调过的配色不会被覆盖。
label_defs=(
    "pending/agent|d4c5f9|等待 agent 处理"
    "pending/agent/fable|8250df|等待 agent 使用 Claude Fable 模型处理（版本见 FABLE_MODEL，默认别名 fable，跟最新版）"
    "doing/agent|c2e0c6|agent 正在处理"
    "pending/human|fbca04|等待人类处理"
    "pending/PR|bbbbbb|工作已转 PR 跟踪"
    "Done|586069|已结案"
    "priority/p0|b60205|插队：并发满时最先派工"
    "priority/p1|f9d0c4|优先：排在没打优先级的前面"
    "priority/p2|bfd4f2|常规（= 不打标签的默认档）"
)
# 交叉 review 关卡默认关闭；配置里设了 LABEL_PENDING_REVIEW 才建它，没开就不多塞一个 label。
review_label="$(config_value LABEL_PENDING_REVIEW)"
[ -n "$review_label" ] && label_defs+=("$review_label|1d76db|等待独立 Codex 复审")
# 外部需求机器人（GitHub#95 / #97）默认关闭；配了等待标签才建它。新名字优先，早期的
# LABEL_PENDING_RELAY 也认（_names.sh 的 cavil_pick_setting，与 _lib.sh 同一个函数）。
requester_bot_label="$(cavil_pick_setting "$(config_value LABEL_PENDING_REQUESTER_BOT)" "$(config_value LABEL_PENDING_RELAY)")"
[ -n "$requester_bot_label" ] && label_defs+=("$requester_bot_label|f9a8d4|等外部需求机器人带回提需求方的答复")
for ld in "${label_defs[@]}"; do
    IFS='|' read -r name color desc <<< "$ld"
    if gh label create "$name" --color "$color" --description "$desc" --repo "$repo" 2>/dev/null; then
        echo "  ✓ 建 label: $name"
    else
        echo "  · label $name 已存在"
    fi
done

# ── 6. seed state ──
echo
echo "── 6. seed state.json ──"
# 只在真的还没有状态时初始化。初始化是按「GitHub 上现在打开的条目」重写整份 state.json：
# 重跑 setup（包括刚把旧安装迁过来的那一次）时再跑一遍，已读评论记录、worker 记录等会被
# 整份冲掉，还可能把还没处理的新评论标成已读。
seed_state_dir="$(config_value STATE_DIR)"
if [ -n "$seed_state_dir" ] && [ -s "$seed_state_dir/state.json" ]; then
    echo "  · $seed_state_dir/state.json 已存在，保留原样（已读评论记录不重置）"
else
    CODING_AGENT_CONFIG="$config" bash "$SKILL_DIR/scripts/seed-state.sh"
fi

# ── 7. 启动 daemon（按 OS 分支）──
echo
echo "── 7. 启动 daemon ──"

enable_systemd() {
    local timer="${UNIT_PREFIX}-poll@$KEY.timer"
    read -rp "现在 enable & start ${timer}？[y/N] " yn
    case "$yn" in
        y|Y|yes)
            systemctl --user daemon-reload
            systemctl --user enable --now "$timer"
            # enable 会把模板链接解析到底，实例链接直指某个 releases/<sha>/（GitHub#109）：
            # 那一版一被清理，定时任务就消失。立刻改回稳定入口（同一个修复动作，见脚本头注释）。
            bash "$SKILL_DIR/scripts/repair-unit-links.sh" \
                || echo "  ⚠️  单元链接没能全部改回稳定入口；本项目每一轮轮询会再试，也可手动重跑：bash $SKILL_DIR/scripts/repair-unit-links.sh"
            echo "  ✓ enabled & running"
            echo
            echo "    状态：systemctl --user status $timer"
            echo "    日志：tail -f \$(grep ^STATE_DIR $config | sed 's/.*=//' | tr -d '\"')/poll.log"
            ;;
        *)
            echo "  跳过；以后：systemctl --user enable --now $timer"
            echo "        然后：bash $SKILL_DIR/scripts/repair-unit-links.sh（把 enable 建的链接改回稳定入口；"
            echo "        不跑也行，本项目第一轮轮询会自动改；或者直接重跑 setup.sh）"
            ;;
    esac
}

enable_launchd() {
    local label="$LAUNCHD_LABEL"
    local plist="$HOME/Library/LaunchAgents/$label.plist"
    local log_dir="$LAUNCHD_LOG_DIR"
    read -rp "现在 bootstrap & start ${label}？[y/N] " yn
    case "$yn" in
        y|Y|yes)
            # 已加载的话先 bootout 再 bootstrap，达到幂等 reload
            launchctl bootout "gui/$UID/$label" 2>/dev/null || true
            launchctl bootstrap "gui/$UID" "$plist"
            launchctl kickstart -k "gui/$UID/$label" >/dev/null 2>&1 || true
            echo "  ✓ bootstrapped & kicked"
            echo
            echo "    状态：launchctl print gui/\$UID/$label"
            echo "    日志（daemon）：tail -f $log_dir/$KEY.out.log"
            echo "    日志（poll 内部）：tail -f \$(grep ^STATE_DIR $config | sed 's/.*=//' | tr -d '\"')/poll.log"
            ;;
        *)
            echo "  跳过；以后：launchctl bootstrap gui/\$UID $plist"
            ;;
    esac
}

case "$SCHEDULER" in
    systemd) enable_systemd ;;
    launchd) enable_launchd ;;
esac

echo
echo "✅ setup 完成。"
echo
echo "下一步："
echo "  1. \$EDITOR $config 检查配置（特别是 WORKTREE_SETUP_CMD 适配你的包管理器）"
echo "  2. 想自定义 worker prompt 风格：把 prompts/*.template.md 复制到 $HOST/.agents/skills/cavil-loop/prompts/ 改"
echo "  3. 试跑：gh issue edit <N> --add-label pending/agent  → 60s 内 daemon 会接管"
if [ "$SCHEDULER" = "systemd" ]; then
    echo "  4. 用户不在线也要跑：sudo loginctl enable-linger \$USER"
else
    echo "  4. 想登出 / 关屏也跑：launchd LaunchAgent 默认登录后常驻；如要开机即跑（无需登录）"
    echo "     需 /Library/LaunchDaemons（root，本脚本不覆盖）"
fi
