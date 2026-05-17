#!/usr/bin/env bash
# 把 coding-agent-workflow daemon 接入一个 host project。
#
# 关键设计：本 skill **不复制脚本到 host project**。脚本永远住在 skill 目录
# （`~/.claude/skills/coding-agent-workflow/`，推荐做成指向 `~/github/coding-agent-work-loop/`
# 的 symlink）。host project 里只多两样东西：
#   1. coding-agent.config       —— 本项目专属配置（gitignored）
#   2. .gitignore 加一行排除上述 config
#
# 用法：
#   bash setup.sh <host-project-path> [instance-key]
# 例：
#   bash setup.sh ~/github/myproject
#   bash setup.sh ~/github/myproject acme       # 自定义 systemd instance key
set -euo pipefail

HOST="${1:-}"
KEY="${2:-}"

if [ -z "$HOST" ]; then
    cat <<EOF
用法：$0 <host-project-path> [instance-key]

  host-project-path: 目标 git 仓库工作树根
  instance-key:      systemd 实例名（default = basename of host），可让多项目共存

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

# instance key 必须是 systemd 安全的字符（字母数字 _ - .）
if ! [[ "$KEY" =~ ^[A-Za-z0-9_.-]+$ ]]; then
    echo "❌ instance key 只能含 [A-Za-z0-9_.-]：$KEY"
    exit 1
fi

echo "── coding-agent-workflow setup ──"
echo "  host project: $HOST"
echo "  skill dir:    $SKILL_DIR"
echo "  instance key: $KEY"
echo

# ── 依赖检查 ──
missing=()
for cmd in git gh tmux jq flock systemctl claude; do
    command -v "$cmd" >/dev/null 2>&1 || missing+=("$cmd")
done
if [ ${#missing[@]} -gt 0 ]; then
    echo "❌ 缺少依赖：${missing[*]}"
    exit 1
fi
echo "✓ 依赖齐全"

if ! gh auth status >/dev/null 2>&1; then
    echo "❌ gh 未登录。先 \`gh auth login\`"
    exit 1
fi
echo "✓ gh 已登录"
echo

# ── 1. 生成 host/coding-agent.config ──
echo "── 1. 生成 $HOST/coding-agent.config ──"
config="$HOST/coding-agent.config"
if [ -f "$config" ]; then
    echo "  ⚠️  已存在，跳过（手动检查是否需更新）"
else
    default_repo="$(cd "$HOST" && gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null || echo "owner/repo")"
    project_name="$(basename "$HOST")"
    cp "$SKILL_DIR/coding-agent.config.example" "$config"
    sed -i \
        -e "s|myorg/myrepo|$default_repo|" \
        -e "s|\$HOME/github/myproject|$HOST|" \
        -e "s|\$HOME/github/worktree/myproject|$HOME/github/worktree/$project_name|" \
        -e "s|\$HOME/.local/state/coding-agent-poll|$HOME/.local/state/coding-agent-poll/$project_name|" \
        -e "s|TMUX_PREFIX=\"myproject\"|TMUX_PREFIX=\"$project_name\"|" \
        "$config"
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
    printf '\n# coding-agent-workflow per-project config\ncoding-agent.config\n' >> "$gitignore"
    echo "  ✓ 加进 .gitignore"
fi

# ── 3. 创建 ~/.config/coding-agent-workflow/<key>.conf ──
echo
echo "── 3. 注册 systemd EnvironmentFile ──"
conf_dir="$HOME/.config/coding-agent-workflow"
mkdir -p "$conf_dir"
env_file="$conf_dir/$KEY.conf"

# systemd EnvironmentFile 是 KEY=VALUE 列表，不能引号包，不展开 shell。
# 需要 PATH，因为 systemd user service 默认 PATH 很瘦
claude_path="$(dirname "$(command -v claude)")"
cat > "$env_file" <<EOF
PROJECT_ROOT=$HOST
CODING_AGENT_CONFIG=$config
PATH=$claude_path:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
EOF
echo "  ✓ $env_file"

# ── 4. 安装 systemd unit 模板（用 symlink，方便后续 skill 更新自动生效）──
echo
echo "── 4. 安装 systemd unit 模板 ──"
sys_dir="$HOME/.config/systemd/user"
mkdir -p "$sys_dir"
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

# ── 5. GitHub labels（幂等）──
echo
echo "── 5. GitHub labels ──"
repo=$(grep -E "^REPO=" "$config" | head -1 | sed 's/.*=//' | tr -d '"' | tr -d "'")
for ld in "pending/agent|5539d3|等待 agent 处理" "pending/human|4bc81f|等待人类处理"; do
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

# ── 7. enable timer ──
echo
echo "── 7. 启动 timer ──"
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

echo
echo "✅ setup 完成。"
echo
echo "下一步："
echo "  1. \$EDITOR $config 检查配置（特别是 WORKTREE_SETUP_CMD 适配你的包管理器）"
echo "  2. 想自定义 worker prompt 风格：把 prompts/*.template.md 复制到 $HOST/.coding-agent/prompts/ 改"
echo "  3. 试跑：gh issue edit <N> --add-label pending/agent  → 60s 内 daemon 会接管"
echo "  4. 用户不在线也要跑：sudo loginctl enable-linger \$USER"
