#!/usr/bin/env bash
# 新旧两套名字的唯一对照表（GigleAI/cavil-loop#70）。
#
# 新安装一律用 cavil-loop；改名前装好的机器（coding-agent-work-loop 时代的目录、
# 配置、后台任务）在迁移之前必须照常运行。所以凡是「去哪找这个文件」的地方，
# 规则只有一条：
#
#     新名字的东西在 → 用新的；否则旧名字的东西在 → 用旧的；都不在 → 按新的建。
#
# 新旧两份都在时永远新的赢。所有脚本都从这里取路径，别在别处再写一份判断——
# 唯一的例外是 release-entry.sh：它被复制到 releases/ 之外长期存放，不能 source
# 发布目录里的文件，只好内联同一条规则（tests/cavil-names.test.sh 对拍两边）。
#
# 只定义变量和函数，不做任何 I/O；可以被任何脚本在任何时刻 source。

CAVIL_NAME="cavil-loop"
CAVIL_LEGACY_NAME="coding-agent-work-loop"

CAVIL_CONFIG_HOME="$HOME/.config/cavil-loop"
CAVIL_LEGACY_CONFIG_HOME="$HOME/.config/coding-agent-work-loop"
CAVIL_SKILL_HOME="$HOME/.agents/skills/cavil-loop"
CAVIL_LEGACY_SKILL_HOME="$HOME/.agents/skills/coding-agent-work-loop"
CAVIL_STATE_HOME="$HOME/.local/state/cavil-loop"
CAVIL_LEGACY_STATE_HOME="$HOME/.local/state/coding-agent-poll"

# 项目根目录那份本地配置文件
CAVIL_PROJECT_CONFIG_NAME="cavil-loop.config"
CAVIL_LEGACY_PROJECT_CONFIG_NAME="coding-agent.config"

# 项目仓库里的指令覆盖目录（相对项目根），按优先级从高到低。
# 第三个是更早的 coding-agent-workflow 时代留下的，同样继续认。
CAVIL_PROJECT_SKILL_DIRS=(
    ".agents/skills/cavil-loop"
    ".agents/skills/coding-agent-work-loop"
    ".agents/skills/coding-agent-workflow"
)

# systemd 单元名前缀。slice 名里的 \x2d 是必须的转义：slice 单元名里 `-` 是层级分隔符。
CAVIL_UNIT_PREFIX="cavil-loop"
CAVIL_LEGACY_UNIT_PREFIX="coding-agent"
CAVIL_SLICE='app-cavil\x2dloop\x2dpoll.slice'
CAVIL_LEGACY_SLICE='app-coding\x2dagent\x2dpoll.slice'

# cavil_pick <新路径> <旧路径>：按上面那条规则挑一个。悬空的软链也算「在」——
# 它说明这里装过东西，换去另一个名字只会把问题藏起来。
cavil_pick() {
    if [ -e "$1" ] || [ -L "$1" ]; then
        printf '%s\n' "$1"
    elif [ -e "$2" ] || [ -L "$2" ]; then
        printf '%s\n' "$2"
    else
        printf '%s\n' "$1"
    fi
}

cavil_deploy_conf()  { cavil_pick "$CAVIL_CONFIG_HOME/deploy.conf" "$CAVIL_LEGACY_CONFIG_HOME/deploy.conf"; }
cavil_skill_link()   { cavil_pick "$CAVIL_SKILL_HOME" "$CAVIL_LEGACY_SKILL_HOME"; }
# 每个项目的后台环境文件 <key>.conf
cavil_project_env()  { cavil_pick "$CAVIL_CONFIG_HOME/$1.conf" "$CAVIL_LEGACY_CONFIG_HOME/$1.conf"; }
# 项目根目录的本地配置文件
cavil_project_config() { cavil_pick "$1/$CAVIL_PROJECT_CONFIG_NAME" "$1/$CAVIL_LEGACY_PROJECT_CONFIG_NAME"; }
# 某个端口的预览登记文件（预览单元启动时由 preview-run / preview-wait 读）
cavil_preview_conf() { cavil_pick "$CAVIL_CONFIG_HOME/preview/$1.conf" "$CAVIL_LEGACY_CONFIG_HOME/preview/$1.conf"; }
# 评论配图 / 周报配图的公开落盘根目录
cavil_review_shots() { cavil_pick "$CAVIL_STATE_HOME/review-shots" "$CAVIL_LEGACY_STATE_HOME/review-shots"; }

# 本机装的是哪一套预览单元：新单元装了就用新的，只装了旧的就用旧的。
# 输出单元名前缀；登记目录跟着走（旧单元的 EnvironmentFile 写死了旧目录）。
cavil_preview_unit_prefix() {
    local unit_dir="${1:-$HOME/.config/systemd/user}"
    if [ -e "$unit_dir/$CAVIL_UNIT_PREFIX-preview@.socket" ]; then
        printf '%s\n' "$CAVIL_UNIT_PREFIX"
    elif [ -e "$unit_dir/$CAVIL_LEGACY_UNIT_PREFIX-preview@.socket" ]; then
        printf '%s\n' "$CAVIL_LEGACY_UNIT_PREFIX"
    else
        printf '%s\n' "$CAVIL_UNIT_PREFIX"
    fi
}
cavil_preview_conf_dir() {
    if [ "$(cavil_preview_unit_prefix "${1:-}")" = "$CAVIL_LEGACY_UNIT_PREFIX" ]; then
        printf '%s\n' "$CAVIL_LEGACY_CONFIG_HOME/preview"
    else
        printf '%s\n' "$CAVIL_CONFIG_HOME/preview"
    fi
}
