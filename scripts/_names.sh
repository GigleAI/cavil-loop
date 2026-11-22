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

# ── New vs pre-rename names: rules moved from the root AGENTS.md (GitHub#658); read before changing ──
# New vs pre-rename names (which config / state / unit / override path is used, setup on an old
# install, deployer switching both skill links) → `tests/cavil-names.test.sh`,
# `tests/skill-deploy.test.sh`, `tests/preview-rename-coexist.test.sh` (old and new previews on one
# machine), `tests/migrate-legacy.test.sh` (moving an old install: idle projects only, resumable, old
# timer on/off state kept), `tests/preview-legacy-adopt.test.sh` (old previews moved to the new units:
# resumable after a failure, old link kept until all are moved, registration prints no URL unless the
# preview came up). Any new path goes through `scripts/_names.sh`, never a hard-coded old or new name
#

CAVIL_NAME="cavil-loop"

# 配置项的新旧名字（GitHub#97）：<新名字的值> <旧名字的值> → 新名字有值用新的，否则用旧的。
# _lib.sh（外部需求机器人的各项配置）和 setup.sh（建等待标签）都调它，规则只写这一份。
cavil_pick_setting() {
    local __cps_v; cavil_pick_setting_to __cps_v "$1" "$2"; printf '%s' "$__cps_v"
}
# 同一条规则，结果写进调用方给的变量名，不经命令替换：project-config.sh 每次读要对 84 项各挑一次，
# 每项起一个子 shell 是它在 CI 上卡时限的主要开销之一（GitHub#662）
cavil_pick_setting_to() {   # <变量名> <新名字的值> <旧名字的值>
    if [ -n "$2" ]; then printf -v "$1" '%s' "$2"; else printf -v "$1" '%s' "$3"; fi
}
# 有早期名字的配置项：一行一对「新名字 早期名字」。_lib.sh 按这张表逐项挑值，
# project-config.sh（客户端的项目配置窗口）按同一张表算显示的值——只在这里写一份。
CAVIL_SETTING_EARLY_NAMES="LABEL_PENDING_REQUESTER_BOT LABEL_PENDING_RELAY
REQUESTER_BOT_ACCOUNT RELAY_BOT_ACCOUNT
REQUESTER_BOT_ALLOWED_ACTORS RELAY_ALLOWED_ACTORS
REQUESTER_BOT_ORIGIN_MARKER RELAY_ORIGIN_MARKER
REQUESTER_BOT_REPORT_FIRST RELAY_REPORT_FIRST"
# 这一项的早期名字（没有就输出空）
cavil_setting_early_name() {   # <新名字>
    local __cse_v; cavil_setting_early_name_to __cse_v "$1"; printf '%s' "$__cse_v"
}
# 同上，结果写进调用方给的变量名（没有早期名字就是空），不经命令替换（GitHub#662）
cavil_setting_early_name_to() {   # <变量名> <新名字>
    local __cse_n __cse_o
    printf -v "$1" '%s' ""
    while read -r __cse_n __cse_o; do
        [ "$__cse_n" = "$2" ] && { printf -v "$1" '%s' "$__cse_o"; return 0; }
    done <<EOF_EARLY
$CAVIL_SETTING_EARLY_NAMES
EOF_EARLY
    return 0
}
CAVIL_LEGACY_NAME="coding-agent-work-loop"

CAVIL_CONFIG_HOME="$HOME/.config/cavil-loop"
CAVIL_LEGACY_CONFIG_HOME="$HOME/.config/coding-agent-work-loop"
CAVIL_SKILL_HOME="$HOME/.agents/skills/cavil-loop"
CAVIL_LEGACY_SKILL_HOME="$HOME/.agents/skills/coding-agent-work-loop"
CAVIL_STATE_HOME="$HOME/.local/state/cavil-loop"
CAVIL_LEGACY_STATE_HOME="$HOME/.local/state/coding-agent-poll"
# 合并后复盘的全机锁：本机所有项目共用一把，同一时刻只跑一个复盘（GitHub#165）。
# 固定放在新名字的状态根目录下，不随部署方式变：按版本部署时 skill 目录不是 git 仓库，
# 而且每个版本各是一个目录，放在那里不同版本就互不相斥了。也不按 cavil_pick 挑新旧——
# 本机有的项目已迁、有的还没迁时，挑出来的会不是同一个文件。
CAVIL_RETROSPECTIVE_LOCK="$CAVIL_STATE_HOME/retrospective.lock"
# agent 撞用量上限后的「暂停派工」记录：整机共用，一个 (agent, 账号目录) 一个文件（GitHub#341）。
# 同上，固定放在新名字的状态根目录下：同一账号的几个项目必须读到同一个文件。
CAVIL_USAGE_LIMIT_DIR="$CAVIL_STATE_HOME/usage-limit"
# 重测试排队（GitHub#343）：本账号下所有项目共用一把排队锁和一份运行记录目录，放法同上面
# 那把复盘锁（固定在新名字的状态根目录，不随部署版本、不按新旧名挑）。不和复盘锁共用一个文件：
# 复盘是「有人在跑就跳过」，这里是「排队等」。
CAVIL_HEAVY_TEST_LOCK="$CAVIL_STATE_HOME/heavy-test.lock"
CAVIL_HEAVY_TEST_RUNS="$CAVIL_STATE_HOME/heavy-test/runs"
# 远程入口（GitHub#387）：整机一个，管这台机器上所有项目，所以和上面两样一样固定放在新名字的
# 状态根目录下。里面是已配对设备和它们的钥匙（目录 700、文件 600）。后台任务名也只有一套：
# 这个功能是改名之后才有的，没有旧名字的安装要兼容。
CAVIL_REMOTE_ACCESS_HOME="$CAVIL_STATE_HOME/remote-access"
CAVIL_REMOTE_ACCESS_UNIT="cavil-loop-remote.service"
CAVIL_REMOTE_ACCESS_LABEL="dev.luosky.cavil-loop.remote"
CAVIL_REMOTE_ACCESS_PORT=47387

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
# 公网资产目录的对外服务（GitHub#613）：服务配置、旧图清单的两份、服务自己写的状态文件、切换锁。
# 状态目录是新功能，只有新名字；配置跟着服务配置文件走（旧安装的服务配置在旧目录，清单也在那里）。
cavil_public_assets_conf() { cavil_pick "$CAVIL_CONFIG_HOME/public-assets.conf" "$CAVIL_LEGACY_CONFIG_HOME/public-assets.conf"; }
CAVIL_PUBLIC_ASSETS_STATE="$CAVIL_STATE_HOME/public-assets"
cavil_public_assets_lists() { printf '%s:%s\n' "$(dirname "$(cavil_public_assets_conf)")/public-assets-legacy.json" "$CAVIL_PUBLIC_ASSETS_STATE/legacy.json"; }
cavil_public_assets_status() { printf '%s\n' "$CAVIL_PUBLIC_ASSETS_STATE/status.json"; }
cavil_public_assets_project_dirs() { printf '%s:%s\n' "$CAVIL_CONFIG_HOME" "$CAVIL_LEGACY_CONFIG_HOME"; }

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

# 改名迁移还有没有剩下的活（GigleAI/cavil-loop#75）：轮询入口据此决定这一轮要不要调迁移脚本。
# 只看「旧项目的环境文件」不够——旧项目全部迁完之后，还可能剩下：
#   · 旧登记目录里的预览（没搬完、搬失败待重试、冲突等人，或更早一版迁移已经删了旧入口）；
#   · 旧技能入口（删它的那一步被中断）。
# 三样都没有就返回 1，迁完的机器每轮不多花任何开销。
cavil_legacy_leftovers() {
    compgen -G "$CAVIL_LEGACY_CONFIG_HOME/*.conf" >/dev/null && return 0
    compgen -G "$CAVIL_LEGACY_CONFIG_HOME/preview/*.conf" >/dev/null && return 0
    [ -L "$CAVIL_LEGACY_SKILL_HOME" ] && [ -e "$CAVIL_SKILL_HOME" ] && return 0
    return 1
}
