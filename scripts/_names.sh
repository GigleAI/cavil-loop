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
# 评论配图 / 周报配图的公开落盘根目录
cavil_review_shots() { cavil_pick "$CAVIL_STATE_HOME/review-shots" "$CAVIL_LEGACY_STATE_HOME/review-shots"; }

# ── 预览（按需 preview）──
# 预览不能按「整台机器用哪套」来挑：旧项目注册的预览跑在旧单元上、登记在旧目录，
# 新单元装上之后它仍然活着。所以规则是**每个端口跟着它自己的登记走**：
#   · 登记可能在新目录，也可能在旧目录——查主人、列清单、注销都两个目录都看；
#   · 只有全新注册才按本机装了哪套单元挑（新的优先）；
#   · 单元启动时读的是**这个单元自己绑定的那份**登记：新单元把路径作为参数传给
#     preview-run / preview-wait，改名前的旧单元不传，就是旧目录。不按「哪个文件在」挑。
CAVIL_PREVIEW_DIRS=("$CAVIL_CONFIG_HOME/preview" "$CAVIL_LEGACY_CONFIG_HOME/preview")

# 全新注册用哪套单元：新单元装了就用新的，只装了旧的就用旧的。输出单元名前缀。
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
# 单元名前缀 → 那套单元的 EnvironmentFile 所在目录
cavil_preview_dir_of_prefix() {
    if [ "$1" = "$CAVIL_LEGACY_UNIT_PREFIX" ]; then
        printf '%s\n' "$CAVIL_LEGACY_CONFIG_HOME/preview"
    else
        printf '%s\n' "$CAVIL_CONFIG_HOME/preview"
    fi
}
# 登记目录 → 跑它的那套单元名前缀
cavil_preview_prefix_of_dir() {
    if [ "$1" = "$CAVIL_LEGACY_CONFIG_HOME/preview" ]; then
        printf '%s\n' "$CAVIL_LEGACY_UNIT_PREFIX"
    else
        printf '%s\n' "$CAVIL_UNIT_PREFIX"
    fi
}
# 端口锁放哪：新旧两套登记必须共用**同一把**锁，否则两个项目各拿各的锁、各写各的目录，
# 同一个端口就有了两个主人。这台机器上可能有旧登记（装过旧单元，或旧目录已存在）时
# 用旧目录的锁——改名前的代码用的也是这把；纯新装的机器上没有旧登记，用新目录的锁，
# 也不会凭空造出一个旧名字的目录。
cavil_preview_lock_dir() {
    local unit_dir="${1:-$HOME/.config/systemd/user}"
    if [ -e "$unit_dir/$CAVIL_LEGACY_UNIT_PREFIX-preview@.socket" ] || [ -d "$CAVIL_LEGACY_CONFIG_HOME/preview" ]; then
        printf '%s\n' "$CAVIL_LEGACY_CONFIG_HOME/preview"
    else
        printf '%s\n' "$CAVIL_CONFIG_HOME/preview"
    fi
}
