#!/usr/bin/env bash
# 把 coding-agent-work-loop daemon 接入一个 host project。
#
# 关键设计：本 skill **不复制脚本到 host project**。脚本永远住在 skill 目录
# （`~/.claude/skills/coding-agent-work-loop/`，推荐做成指向 `~/github/coding-agent-work-loop/`
# 的 symlink）。host project 里只多两样东西：
#   1. coding-agent.config       —— 本项目专属配置（gitignored）
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

if [ ! -d "$HOST/.git" ]; then
    echo "❌ $HOST 不是 git 仓库（找不到 .git）"
    exit 1
fi

HOST="$(cd "$HOST" && pwd)"
SKILL_DIR="$(cd "$(dirname "$0")" && pwd)"
[ -z "$KEY" ] && KEY="$(basename "$HOST")"

# instance key 跨 systemd / launchd label 都要安全的字符（字母数字 _ - .）
if ! [[ "$KEY" =~ ^[A-Za-z0-9_.-]+$ ]]; then
    echo "❌ instance key 只能含 [A-Za-z0-9_.-]：$KEY"
    exit 1
fi

# ── OS 判定 ──
OS="$(uname -s)"
case "$OS" in
    Linux)  SCHEDULER="systemd" ;;
    Darwin) SCHEDULER="launchd" ;;
    *)
        echo "❌ 不支持的 OS：$OS"
        echo "   本脚本只自动配 Linux (systemd) / macOS (launchd)。"
        echo "   想用 cron 等其他调度器手动接 daemon → 见"
        echo "   https://github.com/luosky/coding-agent-work-loop/blob/main/docs/operations.md#manual-cron-fallback"
        exit 1
        ;;
esac

echo "── coding-agent-work-loop setup ──"
echo "  host project: $HOST"
echo "  skill dir:    $SKILL_DIR"
echo "  instance key: $KEY"
echo "  scheduler:    $SCHEDULER ($OS)"
echo

# ── Worker agent 选择 ──
# 优先级：WORKER_AGENT env > 默认 claude
# （首次 setup 时项目还没 coding-agent.config，所以以 env 覆盖为唯一入口；
#  二次 setup 时该字段已写进 config，下面那段会 skip 重写。）
WORKER_AGENT_PICK="${WORKER_AGENT:-claude}"

# 加载 driver 以拿到 worker 二进制名
# shellcheck source=scripts/drivers/_common.sh
source "$SKILL_DIR/scripts/drivers/_common.sh"
PROJECT_ROOT="$HOST" source_driver "$WORKER_AGENT_PICK" || {
    echo "❌ 找不到 driver '$WORKER_AGENT_PICK'。内置：claude / opencode / codex。"
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
    systemd) command -v systemctl >/dev/null 2>&1 || missing+=("systemctl") ;;
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

# ── 可移植 sed in-place（绕开 GNU vs BSD `sed -i` 差异）──
subst_inplace() {
    # 用法：subst_inplace FILE EXPR [EXPR ...]
    local file=$1; shift
    local tmp; tmp=$(mktemp)
    local args=() e
    for e in "$@"; do args+=(-e "$e"); done
    sed "${args[@]}" "$file" > "$tmp" && mv "$tmp" "$file"
}

# ── 1. 生成 host/coding-agent.config ──
echo "── 1. 生成 $HOST/coding-agent.config ──"
config="$HOST/coding-agent.config"
if [ -f "$config" ]; then
    echo "  ⚠️  已存在，跳过（手动检查是否需更新）"
else
    default_repo="$(cd "$HOST" && gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null || echo "owner/repo")"
    project_name="$(basename "$HOST")"
    cp "$SKILL_DIR/coding-agent.config.example" "$config"
    subst_inplace "$config" \
        "s|myorg/myrepo|$default_repo|" \
        "s|\$HOME/github/myproject|$HOST|" \
        "s|\$HOME/github/worktree/myproject|$HOME/github/worktree/$project_name|" \
        "s|\$HOME/.local/state/coding-agent-poll|$HOME/.local/state/coding-agent-poll/$project_name|" \
        "s|TMUX_PREFIX=\"myproject\"|TMUX_PREFIX=\"$project_name\"|" \
        "s|^WORKER_AGENT=\"claude\"|WORKER_AGENT=\"$WORKER_AGENT_PICK\"|"
    echo "  ✓ $config"
fi

# ── 2. .gitignore ──
echo
echo "── 2. .gitignore 排除 coding-agent.config ──"
gitignore="$HOST/.gitignore"
if [ -f "$gitignore" ] && grep -qE "^\s*coding-agent\.config\s*$" "$gitignore"; then
    echo "  · 已在 .gitignore"
else
    [ -f "$gitignore" ] || touch "$gitignore"
    printf '\n# coding-agent-work-loop per-project config\ncoding-agent.config\n' >> "$gitignore"
    echo "  ✓ 加进 .gitignore"
fi

# ── 3. 创建 ~/.config/coding-agent-work-loop/<key>.conf ──
# systemd 用它作 EnvironmentFile；launchd 由生成的 plist 通过 `source` 加载。
echo
echo "── 3. 注册 daemon 环境文件 ──"
conf_dir="$HOME/.config/coding-agent-work-loop"
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
if [ -f "$env_file" ]; then
    echo "  ⚠️  已存在，跳过（手动检查 PATH 是否需要更新）"
else
    cat > "$env_file" <<EOF
PROJECT_ROOT=$HOST
CODING_AGENT_CONFIG=$config
PATH=$daemon_path:/usr/local/bin:/usr/bin:/bin
EOF
    echo "  ✓ $env_file"
fi

# ── 4. 安装调度器 unit（按 OS 分支）──
echo
echo "── 4. 安装 $SCHEDULER unit ──"

install_systemd() {
    # 用 symlink，方便后续 skill 升级（git pull）自动生效，不需要重跑 setup.sh
    local sys_dir="$HOME/.config/systemd/user"
    mkdir -p "$sys_dir"
    local f src dst
    for f in coding-agent-poll@.service coding-agent-poll@.timer; do
        src="$SKILL_DIR/systemd/$f"
        dst="$sys_dir/$f"
        if [ -L "$dst" ] && [ "$(readlink "$dst")" = "$src" ]; then
            echo "  · $f 已 symlink"
        elif [ -e "$dst" ]; then
            echo "  ⚠️  $f 已存在（非 symlink），跳过——手动检查"
        else
            ln -s "$src" "$dst"
            echo "  ✓ symlink $dst -> $src"
        fi
    done
}

install_launchd() {
    # launchd 没有 systemd template 模式，每 instance 必须一份独立 plist。
    # 因此 plist 是「生成」而非 symlink：skill 升级想换 plist 模板要重跑 setup.sh。
    local plist_dir="$HOME/Library/LaunchAgents"
    local log_dir="$HOME/Library/Logs/coding-agent-work-loop"
    local label="dev.luosky.coding-agent-work-loop.$KEY"
    local plist="$plist_dir/$label.plist"
    local template="$SKILL_DIR/launchd/dev.luosky.coding-agent-work-loop.plist.template"

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
            -e "s|{{KEY}}|$KEY|g" \
            -e "s|{{HOME}}|$HOME|g" \
            -e "s|{{SKILL_DIR}}|$SKILL_DIR|g" \
            -e "s|{{ENV_FILE}}|$env_file|g" \
            -e "s|{{LOG_DIR}}|$log_dir|g" \
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
for ld in "pending/agent|5539d3|等待 agent 处理" "doing/agent|0e8a16|agent 正在处理" "pending/human|4bc81f|等待人类处理" "pending/PR|bfd4f2|工作已转 PR 跟踪" "Done|586069|已结案"; do
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
CODING_AGENT_CONFIG="$config" bash "$SKILL_DIR/scripts/seed-state.sh"

# ── 7. 启动 daemon（按 OS 分支）──
echo
echo "── 7. 启动 daemon ──"

enable_systemd() {
    read -rp "现在 enable & start coding-agent-poll@$KEY.timer？[y/N] " yn
    case "$yn" in
        y|Y|yes)
            systemctl --user daemon-reload
            systemctl --user enable --now "coding-agent-poll@$KEY.timer"
            echo "  ✓ enabled & running"
            echo
            echo "    状态：systemctl --user status coding-agent-poll@$KEY.timer"
            echo "    日志：tail -f \$(grep ^STATE_DIR $config | sed 's/.*=//' | tr -d '\"')/poll.log"
            ;;
        *)
            echo "  跳过；以后：systemctl --user enable --now coding-agent-poll@$KEY.timer"
            ;;
    esac
}

enable_launchd() {
    local label="dev.luosky.coding-agent-work-loop.$KEY"
    local plist="$HOME/Library/LaunchAgents/$label.plist"
    local log_dir="$HOME/Library/Logs/coding-agent-work-loop"
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
echo "  2. 想自定义 worker prompt 风格：把 prompts/*.template.md 复制到 $HOST/.coding-agent/prompts/ 改"
echo "  3. 试跑：gh issue edit <N> --add-label pending/agent  → 60s 内 daemon 会接管"
if [ "$SCHEDULER" = "systemd" ]; then
    echo "  4. 用户不在线也要跑：sudo loginctl enable-linger \$USER"
else
    echo "  4. 想登出 / 关屏也跑：launchd LaunchAgent 默认登录后常驻；如要开机即跑（无需登录）"
    echo "     需 /Library/LaunchDaemons（root，本脚本不覆盖）"
fi
