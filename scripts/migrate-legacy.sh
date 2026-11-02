#!/usr/bin/env bash
# 把改名前的旧安装（coding-agent-work-loop / coding-agent-poll 命名）迁到 cavil-loop 命名
# （GigleAI/cavil-loop#71）。新旧名字的对照表在 _names.sh，这里只管「怎么搬」。
#
# 用法：
#   migrate-legacy.sh --all                        Linux：迁本机所有空闲的旧项目（poll-entry.sh 每轮调）
#   migrate-legacy.sh --key <key> [--launchd]      只迁一个项目（setup.sh 重跑时调；macOS 带 --launchd）
#
# 每迁完一个项目往 stdout 打一行 `MIGRATED<TAB><key><TAB><项目配置路径>`，别的输出都走 stderr
# 和 ~/.local/state/cavil-loop/migrate.log。
# 退出码（--key 模式）：0 迁完或无需迁移 / 3 项目忙，下次再来 / 1 出错或需要人看。
# --all 模式只要没崩就是 0：一个项目出问题不能挡住别的项目，更不能挡住本轮轮询。
#
# 一个项目搬哪些东西，按顺序（每一步都可以重复执行，中途断了下次从断的地方接着做）：
#   1. 记下旧后台任务原来开没开（进度文件），备份环境文件、项目配置、状态里的关键文件
#   2. 共享部分：新技能入口、Claude Code 技能链接、部署器配置
#   3. 新单元模板（Linux）
#   4. 状态目录整体搬到新位置，同时改写项目配置里写死的状态目录路径
#   5. 环境文件搬到新配置目录，旧文件改名留底
#   6. 按原来的开关状态先启用新后台任务、再停掉并移除旧的（Linux），或卸掉旧 LaunchAgent（macOS）
#
# 硬规则：
#   · 项目有 worker 在跑（或本项目的轮询 / 周报正在跑）时一步都不做——正在跑的进程记住的是
#     旧路径，中途搬目录它就找不到状态文件，还会被 _lib.sh 的 mkdir 在旧位置建出一个空目录；
#   · 不往项目仓库里写任何东西：项目根目录的本地配置文件不改名（只改写里面的状态目录那一行），
#     备份放在 ~/.config/cavil-loop/migration/ 而不是项目目录（项目目录里多一个文件，
#     worker 可能顺手把它提交进仓库）；
#   · 新旧两份都已存在而又不是本脚本自己留下的半成品时，停手等人——那说明有人手动装过新的，
#     两套后台任务可能同时在跑，自动合并只会把事情搞乱。
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_names.sh
source "$SCRIPT_DIR/_names.sh"
# shellcheck source=_preview_adopt.sh
source "$SCRIPT_DIR/_preview_adopt.sh"

MODE=""
ONE_KEY=""
SCHED="systemd"
while [ $# -gt 0 ]; do
    case "$1" in
        --all) MODE=all; shift ;;
        --key) MODE=key; ONE_KEY="${2:-}"; shift 2 || shift ;;
        --launchd) SCHED=launchd; shift ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
done
[ -n "$MODE" ] || { echo "usage: $0 --all | --key <key> [--launchd]" >&2; exit 2; }

SYS_DIR="${CAVIL_SYSTEMD_USER_DIR:-$HOME/.config/systemd/user}"
MIG_DIR="$CAVIL_CONFIG_HOME/migration"
MIG_LOG="$CAVIL_STATE_HOME/migrate.log"
LEGACY_LAUNCHD_PREFIX="dev.luosky.coding-agent-work-loop"

# 只往 stderr（journal）和 migrate.log 写；stdout 留给 MIGRATED 行。
mlog() {
    local line
    line="[$(date -Iseconds)] [migrate${KEY:+ $KEY}] $*"
    printf '%s\n' "$line" >&2
    mkdir -p "$CAVIL_STATE_HOME" 2>/dev/null && printf '%s\n' "$line" >> "$MIG_LOG" 2>/dev/null
    return 0
}

# 同一个「等待 / 卡住」原因一小时只记一次：tutor 这种一直有活的项目每轮都会走到这里，
# 不节流的话 journal 每 30 秒一行。
mlog_throttled() {
    local tag="$1"; shift
    local f="$CAVIL_STATE_HOME/.migrate-note-$tag" msg="$*" now last
    # 人在跑 setup.sh 时每次都要看到原因
    [ "$MODE" = all ] || { mlog "$msg"; return 0; }
    now=$(date +%s)
    if [ -f "$f" ] && [ "$(cat "$f" 2>/dev/null)" = "$msg" ]; then
        last=$(file_mtime "$f")
        [ $((now - last)) -ge 3600 ] || return 0
    fi
    mlog "$msg"
    mkdir -p "$CAVIL_STATE_HOME" 2>/dev/null && printf '%s' "$msg" > "$f" 2>/dev/null
    return 0
}
file_mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || echo 0; }
dev_of()     { stat -c %d "$1" 2>/dev/null || stat -f %d "$1" 2>/dev/null || echo "?"; }

# KEY=VALUE 文件里取一个值（systemd EnvironmentFile 的写法：不展开、可带一层引号）
env_value() {
    local v
    v=$(grep -E "^[[:space:]]*$2=" "$1" 2>/dev/null | tail -1 | sed -e 's/^[^=]*=//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\\(.*\\)'\$/\\1/")
    printf '%s' "$v"
}

# 在子 shell 里 source 项目配置取几个值。配置里常写 "$HOME/..."，grep 取不准。
config_values() {   # <config> → 三行：STATE_DIR / TMUX_PREFIX / SESSION_NAME_PREFIX
    ( set +eu; . "$1" >/dev/null 2>&1
      printf '%s\n%s\n%s\n' "${STATE_DIR:-}" "${TMUX_PREFIX:-}" "${SESSION_NAME_PREFIX:-}" )
}

ere_escape() { printf '%s' "$1" | sed -e 's/[][\.*^$+?(){}|/]/\\&/g'; }
rep_escape() { printf '%s' "$1" | sed -e 's/[\&|]/\\&/g'; }

# 把文件里指向 <旧绝对路径> 的写法全部换成 <新绝对路径>，输出到 stdout。
# 认三种写法：绝对路径、$HOME/…、${HOME}/…；后面必须是路径结束（不是名字字符），
# 免得把 …/coding-agent-poll/tutor 换进 …/coding-agent-poll/tutor2 里。
rewrite_paths() {   # <file> <old> <new>
    local file="$1" old="$2" new="$3" args=() o n rel_old rel_new
    rel_old="${old#"$HOME"}"; rel_new="${new#"$HOME"}"
    local pairs=("$old|$new")
    if [ "$rel_old" != "$old" ] && [ "$rel_new" != "$new" ]; then
        pairs+=("\$HOME$rel_old|\$HOME$rel_new" "\${HOME}$rel_old|\${HOME}$rel_new")
    fi
    local p
    for p in "${pairs[@]}"; do
        o="$(ere_escape "${p%%|*}")"; n="$(rep_escape "${p#*|}")"
        args+=(-e "s|${o}([^A-Za-z0-9_.-])|${n}\\1|g" -e "s|${o}\$|${n}|")
    done
    sed -E "${args[@]}" "$file"
}

# 原子地写文件：先写同目录临时文件再 mv，权限照抄原文件（这些文件可能装着 token）。
install_text() {   # <content-file> <dest> [mode]
    local src="$1" dest="$2" mode="${3:-}" tmp
    tmp="$(mktemp "$(dirname "$dest")/.cavil-migrate.XXXXXX")" || return 1
    cat "$src" > "$tmp" || { rm -f "$tmp"; return 1; }
    if [ -n "$mode" ]; then chmod "$mode" "$tmp"
    elif [ -e "$dest" ]; then chmod "$(stat -c %a "$dest" 2>/dev/null || stat -f %Lp "$dest")" "$tmp"
    else chmod 600 "$tmp"; fi
    mv -f "$tmp" "$dest" || { rm -f "$tmp"; return 1; }
}

legacy_keys() {
    local f k
    for f in "$CAVIL_LEGACY_CONFIG_HOME"/*.conf; do
        [ -f "$f" ] || continue
        k="$(basename "$f" .conf)"
        [ "$k" = deploy ] && continue
        printf '%s\n' "$k"
    done
}

sc() { systemctl --user "$@"; }
unit_enabled() { case "$(sc is-enabled "$1" 2>/dev/null)" in enabled|enabled-runtime) echo yes ;; *) echo no ;; esac; }
unit_active()  { sc is-active --quiet "$1" 2>/dev/null && echo yes || echo no; }

# ── 共享部分：多个项目共用，第一个迁的项目做，后面的看到已经做过就跳过 ──
migrate_shared() {
    # 新技能入口：指向旧入口现在指的地方（受管 release 或开发模式 checkout），不改变跑哪份代码。
    if [ ! -e "$CAVIL_SKILL_HOME" ] && [ ! -L "$CAVIL_SKILL_HOME" ]; then
        local target=""
        if [ -L "$CAVIL_LEGACY_SKILL_HOME" ]; then target="$(readlink "$CAVIL_LEGACY_SKILL_HOME")"
        elif [ -d "$CAVIL_LEGACY_SKILL_HOME" ]; then target="$CAVIL_LEGACY_SKILL_HOME"; fi
        # 没有旧入口（macOS 上直接从 checkout 跑 setup.sh 的装法）就不建；Linux 下一步装单元
        # 模板时会因为找不到新入口而明确报错。
        if [ -n "$target" ]; then
            mkdir -p "$(dirname "$CAVIL_SKILL_HOME")" && ln -s "$target" "$CAVIL_SKILL_HOME" || {
                mlog "❌ 建立新技能入口 $CAVIL_SKILL_HOME 失败"; return 1; }
            mlog "技能入口：新建 $CAVIL_SKILL_HOME -> $target（与旧入口指向同一处）"
        fi
    fi
    # Claude Code 里的命令名：/coding-agent-work-loop → /cavil-loop。不留旧别名，否则技能列表里
    # 同一个技能出现两次。只动软链；真目录说明是人放的，不碰。
    local claude_skills="$HOME/.claude/skills"
    if [ -L "$claude_skills/$CAVIL_LEGACY_NAME" ]; then
        if [ ! -e "$claude_skills/$CAVIL_NAME" ] && [ ! -L "$claude_skills/$CAVIL_NAME" ]; then
            ln -s "$CAVIL_SKILL_HOME" "$claude_skills/$CAVIL_NAME" || { mlog "❌ 建立 Claude Code 技能链接失败"; return 1; }
        fi
        rm -f "$claude_skills/$CAVIL_LEGACY_NAME"
        mlog "Claude Code 技能：$claude_skills/$CAVIL_LEGACY_NAME 换成 $claude_skills/$CAVIL_NAME"
    fi
    # 部署器配置：搬到新目录，里面写死的旧技能入口路径一并换掉；旧文件改名留底。
    local old_dc="$CAVIL_LEGACY_CONFIG_HOME/deploy.conf" new_dc="$CAVIL_CONFIG_HOME/deploy.conf"
    if [ -f "$old_dc" ]; then
        if [ ! -e "$new_dc" ]; then
            mkdir -p "$CAVIL_CONFIG_HOME" && chmod 700 "$CAVIL_CONFIG_HOME"
            local t; t="$(mktemp)"
            rewrite_paths "$old_dc" "$CAVIL_LEGACY_SKILL_HOME" "$CAVIL_SKILL_HOME" > "$t" \
                && install_text "$t" "$new_dc" "$(stat -c %a "$old_dc" 2>/dev/null || stat -f %Lp "$old_dc")" \
                || { rm -f "$t"; mlog "❌ 写 $new_dc 失败"; return 1; }
            rm -f "$t"
        fi
        mv "$old_dc" "$old_dc.migrated-$TS" || { mlog "❌ 旧部署器配置改名留底失败"; return 1; }
        mlog "部署器配置：$old_dc → $new_dc（旧文件留作 deploy.conf.migrated-$TS）"
    fi
    return 0
}

# 所有项目都迁完之后：改名前注册的预览逐个搬到新单元（GigleAI/cavil-loop#75）。
# 旧单元文件里写死的是旧技能入口下的脚本路径，删入口之前不搬，旧预览就全部 502。
# 每个端口的步骤与中断后怎么接着做见 _preview_adopt.sh；这里只负责逐个调、把没搬完的记下来。
# 输出：还没搬完的端口数（0 = 旧登记目录已清空）。
migrate_previews() {
    local port rc left=0
    for port in $(preview_legacy_pending_ports); do
        rc=0
        PREVIEW_ADOPT_LOG=mlog preview_adopt_legacy_locked "$port" "$SYS_DIR" || rc=$?
        case "$rc" in
            0) rm -f "$CAVIL_STATE_HOME/.migrate-note-preview-$port" 2>/dev/null ;;
            3) left=$((left+1))
               mlog_throttled "preview-$port" "⛔ 预览端口 :$port 新旧两个登记目录各有一份、主人不同（$CAVIL_LEGACY_CONFIG_HOME/preview/$port.conf 与 $CAVIL_CONFIG_HOME/preview/$port.conf），不知道哪个是真的，两份都不动，等人处理（看现状：bash $SCRIPT_DIR/preview-resolve-conflict.sh $port）；旧技能入口因此暂时保留" ;;
            *) left=$((left+1))
               mlog_throttled "preview-$port" "预览端口 :$port 这次没搬完（原因见上一行），下一轮接着搬；旧技能入口暂时保留" ;;
        esac
    done
    printf '%s\n' "$left"
}

# 所有项目都迁完、旧预览也都搬完之后：旧技能入口不再需要，删掉前先把还经过它的单元链接改走
# 新入口（旧 coding-agent-* 单元文件在仓库里原样保留着，旧 slice 等还在用它们）。
# 还有旧预览没搬完（失败待重试、或冲突等人）就不删：那些端口的旧单元还要靠旧入口才起得来。
finalize_shared() {
    [ -z "$(legacy_keys)" ] || return 0
    if [ "$SCHED" = systemd ] && command -v systemctl >/dev/null 2>&1; then
        local left; left="$(migrate_previews)"
        [ "$left" = 0 ] || return 0
    fi
    [ -L "$CAVIL_LEGACY_SKILL_HOME" ] && [ -e "$CAVIL_SKILL_HOME" ] || return 0
    local u t changed=0
    for u in "$SYS_DIR"/*; do
        [ -L "$u" ] || continue
        t="$(readlink "$u")"
        case "$t" in
            "$CAVIL_LEGACY_SKILL_HOME"/*)
                ln -sfn "$CAVIL_SKILL_HOME${t#"$CAVIL_LEGACY_SKILL_HOME"}" "$u" || return 0
                changed=1 ;;
        esac
    done
    [ "$changed" -eq 0 ] || { [ "$SCHED" != systemd ] || sc daemon-reload >/dev/null 2>&1 || true; }
    rm -f "$CAVIL_LEGACY_SKILL_HOME"
    mlog "所有项目都已迁完、旧预览都已搬到新单元：删除旧技能入口 $CAVIL_LEGACY_SKILL_HOME（原先经过它的单元链接已改走新入口）"
}

link_unit() {   # <unit file name>：在单元目录建一个指向新技能入口的模板链接
    local f="$1" src="$CAVIL_SKILL_HOME/systemd/$1" dst="$SYS_DIR/$1"
    [ -f "$src" ] || { mlog "❌ 当前技能版本里没有 $f（版本太旧？）"; return 1; }
    if [ -L "$dst" ] && [ "$(readlink "$dst")" = "$src" ]; then return 0; fi
    if [ -e "$dst" ] && [ ! -L "$dst" ]; then mlog "⚠️ $dst 是手写的真文件，保留不动"; return 0; fi
    ln -sfn "$src" "$dst" || { mlog "❌ 链接 $f 失败"; return 1; }
    mlog "单元模板：$dst -> $src"
}

# 复制一个 drop-in 目录（实例的轮询间隔、本机的 slice 内存数字）到新单元名下。新的已经有了就不动。
copy_dropin() {   # <old unit name> <new unit name>
    local o="$SYS_DIR/$1.d" n="$SYS_DIR/$2.d"
    [ -d "$o" ] || return 0
    [ -e "$n" ] && return 0
    cp -pR "$o" "$n" || { mlog "❌ 复制 $o 失败"; return 1; }
    mlog "drop-in：$o 复制到 $n"
}

# ── 一个项目 ──
# 返回 0 = 迁完 / 无需迁；3 = 忙；1 = 出错或需要人看
migrate_key() {
    KEY="$1"
    local old_env="$CAVIL_LEGACY_CONFIG_HOME/$KEY.conf" new_env="$CAVIL_CONFIG_HOME/$KEY.conf"
    local progress="$MIG_DIR/$KEY.inprogress"

    if [ ! -f "$old_env" ]; then
        # 上次已经迁完、只差把进度文件收尾：补上，否则轮询入口会一直以为本项目还在迁
        [ ! -f "$progress" ] || mv "$progress" "$MIG_DIR/$KEY.done" 2>/dev/null || true
        return 0
    fi
    if [ -e "$new_env" ] && [ ! -f "$progress" ]; then
        mlog_throttled "conflict-$KEY" "⛔ 新旧两份环境文件都在（$new_env 与 $old_env），而且不是迁移留下的半成品：可能两套后台任务同时在跑，需要人工处理，自动迁移不动它"
        return 1
    fi

    # 项目配置：环境文件里写的那份（迁移不改它的路径，只改它里面的状态目录）
    local env_src="$old_env"
    [ -f "$new_env" ] && env_src="$new_env"
    local cfg; cfg="$(env_value "$env_src" CODING_AGENT_CONFIG)"
    if [ -z "$cfg" ] || [ ! -f "$cfg" ]; then
        mlog_throttled "nocfg-$KEY" "⚠️ 环境文件 $env_src 指向的项目配置 '${cfg}' 不存在，跳过"
        return 1
    fi
    local vals sd tprefix sprefix
    vals="$(config_values "$cfg")"
    sd="$(sed -n 1p <<< "$vals")"; tprefix="$(sed -n 2p <<< "$vals")"; sprefix="$(sed -n 3p <<< "$vals")"

    # 状态目录：只搬放在旧状态根目录下面一层的（setup.sh 装出来的都是这样）；放在别处的是人
    # 特意指定的，原地不动。
    local old_sd="" new_sd=""
    case "$sd" in
        "$CAVIL_LEGACY_STATE_HOME"/*)
            local rest="${sd#"$CAVIL_LEGACY_STATE_HOME"/}"
            case "$rest" in */*|"") ;; *) old_sd="$sd"; new_sd="$CAVIL_STATE_HOME/$rest" ;; esac ;;
    esac
    # 断点：状态目录已经搬走、配置还没改写。新位置那份才是真的。
    local live_sd="$sd"
    if [ -n "$old_sd" ] && [ ! -e "$old_sd" ] && [ -d "$new_sd" ]; then live_sd="$new_sd"; fi

    # ── 忙不忙 ──
    # 先拿本项目的轮询锁，**再**看有没有 worker。顺序不能反：派工只发生在轮询持锁期间，
    # 先列会话、后拿锁的话，中间那一轮轮询可以派出 worker、放掉锁，前面「没有 worker」
    # 的结论就过期了。拿到锁之后再看，这期间不可能冒出新 worker。
    # 锁一直攥到整个项目迁完（中途出错返回时随子 shell / 进程退出释放）。
    local busy="" lock_fd=""
    if [ -d "$live_sd" ]; then
        exec {lock_fd}>>"$live_sd/poll.lock"
        flock -n "$lock_fd" || busy="本项目的一轮轮询正在跑"
    fi
    if [ -z "$busy" ] && [ -n "$tprefix" ] && command -v tmux >/dev/null 2>&1; then
        local re="^$(ere_escape "$tprefix-$sprefix")[0-9]+\$" sessions
        sessions="$(tmux list-sessions -F '#{session_name}' 2>/dev/null | grep -E "$re" | tr '\n' ' ' || true)"
        [ -z "$sessions" ] || busy="还有 worker 在跑（${sessions% }）"
    fi
    # 周报不读状态目录（只读环境文件，新旧两份在迁移中途都在、内容一样），这里只是不在它
    # 跑的时候换它的定时任务。
    if [ -z "$busy" ] && [ "$SCHED" = systemd ] \
       && [ "$(unit_active "$CAVIL_LEGACY_UNIT_PREFIX-weekly-report@$KEY.service")" = yes ]; then
        busy="周报正在生成"
    fi
    if [ -n "$busy" ]; then
        mlog_throttled "wait-$KEY" "暂不迁移：$busy；空闲后再迁"
        [ -z "$lock_fd" ] || eval "exec ${lock_fd}>&-"
        return 3
    fi
    rm -f "$CAVIL_STATE_HOME/.migrate-note-wait-$KEY" 2>/dev/null

    # ── 停手等人的情况，在动任何东西**之前**查完 ──
    # 进度文件一建，本项目的轮询就会暂停到迁完为止（见 poll-entry.sh）；需要人处理的情况
    # 必须在那之前挡下来，旧安装照常轮询，不能变成一个暂停着、又迁不完的项目。
    local tcfg=""
    if [ -n "$old_sd" ]; then
        # 迁到一半时被别的进程在旧位置凭空建出来的空壳：里面没有 state.json（真的状态目录
        # 第一轮就会写它）。只在本项目确实在迁（有进度文件）时认它，日志并进新目录后删掉。
        if [ -f "$progress" ] && [ -d "$old_sd" ] && [ -d "$new_sd" ] && [ ! -e "$old_sd/state.json" ] \
           && [ -z "$(find "$old_sd" -mindepth 1 -maxdepth 1 ! -name poll.log ! -name poll.lock ! -name .tick 2>/dev/null)" ]; then
            [ ! -f "$old_sd/poll.log" ] || cat "$old_sd/poll.log" >> "$new_sd/poll.log" 2>/dev/null || true
            rm -rf -- "$old_sd" && mlog "清掉迁移中途在旧位置冒出的空状态目录 $old_sd（只有日志，已并进新目录）"
        fi
        if [ -e "$old_sd" ] && [ -e "$new_sd" ]; then
            mlog_throttled "bothsd-$KEY" "⛔ 新旧两个状态目录都在（$old_sd 与 $new_sd），不知道哪份是真的，停下等人处理"
            return 1
        fi
        tcfg="$(mktemp)"
        rewrite_paths "$cfg" "$old_sd" "$new_sd" > "$tcfg" || { rm -f "$tcfg"; mlog "❌ 改写项目配置失败"; return 1; }
        # 先验证改写后的配置确实指向新位置，再动目录：改不对就一步都别搬。
        local got; got="$(config_values "$tcfg" | sed -n 1p)"
        if [ "$got" != "$new_sd" ]; then
            rm -f "$tcfg"
            mlog_throttled "cfg-$KEY" "⛔ 项目配置 $cfg 里的 STATE_DIR 不是能自动改写的写法（改写后得到 '$got'），停下等人处理"
            return 1
        fi
        if [ -e "$old_sd" ]; then
            mkdir -p "$CAVIL_STATE_HOME"
            if [ "$(dev_of "$old_sd")" != "$(dev_of "$CAVIL_STATE_HOME")" ]; then
                rm -f "$tcfg"
                mlog_throttled "dev-$KEY" "⛔ $old_sd 和 $CAVIL_STATE_HOME 不在同一个磁盘分区，自动迁移不做跨盘拷贝，停下等人处理"
                return 1
            fi
        fi
    fi
    # 验证用的临时文件不留着（配置里可能有 token）；第 4 步按同样的规则重新生成一份
    [ -z "$tcfg" ] || rm -f "$tcfg"
    rm -f "$CAVIL_STATE_HOME/.migrate-note-wait-$KEY" 2>/dev/null

    # ── 1. 进度文件：记下旧后台任务原来的开关状态（重跑时以第一次记的为准）──
    # 它在 = 本项目正在迁：轮询入口看到写着本项目配置的 CFG= 行，就跳过主轮询。
    mkdir -p "$MIG_DIR" && chmod 700 "$CAVIL_CONFIG_HOME" "$MIG_DIR" || { mlog "❌ 建 $MIG_DIR 失败"; return 1; }
    local old_poll="$CAVIL_LEGACY_UNIT_PREFIX-poll@$KEY.timer" new_poll="$CAVIL_UNIT_PREFIX-poll@$KEY.timer"
    local old_week="$CAVIL_LEGACY_UNIT_PREFIX-weekly-report@$KEY.timer" new_week="$CAVIL_UNIT_PREFIX-weekly-report@$KEY.timer"
    local old_label="$LEGACY_LAUNCHD_PREFIX.$KEY"
    if [ ! -f "$progress" ]; then
        local p; p="$(mktemp "$MIG_DIR/.progress.XXXXXX")"
        {
            echo "TS=$(date +%Y%m%d-%H%M%S)"
            printf 'CFG=%s\n' "$cfg"
            if [ "$SCHED" = systemd ]; then
                echo "POLL_ENABLED=$(unit_enabled "$old_poll")"
                echo "POLL_ACTIVE=$(unit_active "$old_poll")"
                echo "WEEKLY_ENABLED=$(unit_enabled "$old_week")"
                echo "WEEKLY_ACTIVE=$(unit_active "$old_week")"
            else
                launchctl print "gui/$(id -u)/$old_label" >/dev/null 2>&1 && echo "LAUNCHD_LOADED=yes" || echo "LAUNCHD_LOADED=no"
            fi
        } > "$p" && mv "$p" "$progress" || { rm -f "$p"; mlog "❌ 写进度文件失败"; return 1; }
        mlog "开始迁移（旧环境文件 $old_env，项目配置 $cfg，状态目录 ${sd:-未设}）；原状态：$(grep -vE '^(TS|CFG)=' "$progress" | tr '\n' ' ')"
    fi
    TS="$(env_value "$progress" TS)"
    local bk="$MIG_DIR/$KEY-$TS"

    # 备份：只在第一次做。状态目录本身靠同盘原子改名搬，不整份复制（tutor 实测 6.7G）；
    # 复制的是丢了就会重复派工的那几样：已读评论记录、会话记录、节奏状态。
    if [ ! -d "$bk" ]; then
        local bt="$MIG_DIR/.$KEY-$TS.tmp"
        rm -rf "$bt"; mkdir -p "$bt" && chmod 700 "$bt" || { mlog "❌ 建备份目录失败"; return 1; }
        cp -p "$env_src" "$bt/$KEY.conf" && cp -p "$cfg" "$bt/$(basename "$cfg")" || { mlog "❌ 备份配置失败"; return 1; }
        if [ -d "$live_sd" ]; then
            mkdir -p "$bt/state"
            local f
            for f in state.json poll-pace.json agent-sessions; do
                [ -e "$live_sd/$f" ] || continue
                cp -pR "$live_sd/$f" "$bt/state/" || { mlog "❌ 备份 $live_sd/$f 失败"; return 1; }
            done
        fi
        mv "$bt" "$bk" || { mlog "❌ 备份目录落盘失败"; return 1; }
        mlog "备份：环境文件、项目配置、状态关键文件 → $bk"
    fi

    # ── 2. 共享部分 ──
    migrate_shared || return 1

    # ── 3. 新单元模板 ──
    if [ "$SCHED" = systemd ]; then
        mkdir -p "$SYS_DIR"
        local f
        for f in "$CAVIL_UNIT_PREFIX-poll@.service" "$CAVIL_UNIT_PREFIX-poll@.timer" "$CAVIL_SLICE" \
                 "$CAVIL_UNIT_PREFIX-preview@.socket" "$CAVIL_UNIT_PREFIX-preview@.service" \
                 "$CAVIL_UNIT_PREFIX-preview-app@.service"; do
            link_unit "$f" || return 1
        done
        if [ -e "$SYS_DIR/$CAVIL_LEGACY_UNIT_PREFIX-weekly-report@.timer" ]; then
            link_unit "$CAVIL_UNIT_PREFIX-weekly-report@.service" || return 1
            link_unit "$CAVIL_UNIT_PREFIX-weekly-report@.timer" || return 1
        fi
        # 本机的 slice 内存数字。旧 slice 留着不动：改名前起的 tmux server 还挂在它下面，
        # 之后新开的 worker 只要还进那个 server，归的仍是旧 slice。
        copy_dropin "$CAVIL_LEGACY_SLICE" "$CAVIL_SLICE" || return 1
    fi

    # ── 4. 状态目录 + 项目配置里的状态目录路径（同样的改写上面已经验证过）──
    if [ -n "$old_sd" ]; then
        tcfg="$(mktemp)"
        rewrite_paths "$cfg" "$old_sd" "$new_sd" > "$tcfg" || { rm -f "$tcfg"; mlog "❌ 改写项目配置失败"; return 1; }
        if [ -e "$old_sd" ]; then
            mv "$old_sd" "$new_sd" || { rm -f "$tcfg"; mlog "❌ 搬状态目录失败"; return 1; }
            mlog "状态目录：$old_sd → $new_sd（整目录改名，内容不变）"
        fi
        if ! cmp -s "$tcfg" "$cfg"; then
            install_text "$tcfg" "$cfg" || { rm -f "$tcfg"; mlog "❌ 写回项目配置 $cfg 失败（状态目录已在新位置，下次接着改）"; return 1; }
            mlog "项目配置：$cfg 里的状态目录改成 $new_sd（原文件备份在 $bk）"
        fi
        rm -f "$tcfg"
        # 本项目自己的日志里也留一笔，翻 poll.log 的人能看到这里发生过什么
        printf '[%s] [migrate] 本项目已从 %s 迁到 %s，详情见 %s\n' "$(date -Iseconds)" "$old_sd" "$new_sd" "$MIG_LOG" \
            >> "$new_sd/poll.log" 2>/dev/null || true
    fi

    # ── 5. 环境文件 ──
    if [ ! -f "$new_env" ]; then
        local tenv; tenv="$(mktemp)"
        if [ -n "$old_sd" ]; then rewrite_paths "$old_env" "$old_sd" "$new_sd" > "$tenv"; else cat "$old_env" > "$tenv"; fi \
            && install_text "$tenv" "$new_env" 600 || { rm -f "$tenv"; mlog "❌ 写新环境文件 $new_env 失败"; return 1; }
        rm -f "$tenv"
    fi

    # ── 6. 后台任务 ──
    if [ "$SCHED" = systemd ]; then
        copy_dropin "$old_poll" "$new_poll" || return 1
        copy_dropin "$old_week" "$new_week" || return 1
        sc daemon-reload >/dev/null 2>&1 || { mlog "❌ systemctl --user daemon-reload 失败"; return 1; }
        # 先把新任务开起来，**再**停旧的：反过来的话，新任务开不起来时这个项目一个定时任务
        # 都不剩，再也不会有下一轮来接着迁。两个都开着的这一小段不会重复轮询——进度文件还在，
        # 两边的轮询入口都只会接着迁移、跳过主轮询。
        local pairs=("$new_poll|POLL" "$new_week|WEEKLY") pr nu tag
        for pr in "${pairs[@]}"; do
            nu="${pr%%|*}"; tag="${pr#*|}"
            if [ "$(env_value "$progress" "${tag}_ENABLED")" = yes ] && [ "$(unit_enabled "$nu")" != yes ]; then
                sc enable "$nu" >/dev/null 2>&1 || { mlog "❌ 启用 $nu 失败（旧任务还开着，下一轮再试）"; return 1; }
                mlog "新后台任务：$nu 已启用"
                # enable 把实例链接解析进了某个 releases/<sha>/（GitHub#109）：改回稳定入口。
                # 没改成不挡迁移——每轮轮询入口还会再修，部署器也不会删还被链接指着的版本。
                CAVIL_SYSTEMD_USER_DIR="$SYS_DIR" bash "$SCRIPT_DIR/repair-unit-links.sh" 2>&1 | sed 's/^/[repair] /' >> "$MIG_LOG" \
                    || mlog "⚠️ 单元链接没能全部改回稳定入口，之后每轮轮询会再试"
            fi
            if [ "$(env_value "$progress" "${tag}_ACTIVE")" = yes ] && [ "$(unit_active "$nu")" != yes ]; then
                sc start "$nu" >/dev/null 2>&1 || { mlog "❌ 启动 $nu 失败（旧任务还开着，下一轮再试）"; return 1; }
                mlog "新后台任务：$nu 已启动"
            fi
        done
        # 只停 timer、不停 service：迁移常常就跑在旧 service 自己这一轮里，停 service 等于自杀。
        local u
        for u in "$old_poll" "$old_week"; do
            if [ "$(unit_enabled "$u")" = yes ] || [ "$(unit_active "$u")" = yes ]; then
                sc disable --now "$u" >/dev/null 2>&1 || { mlog "❌ 停用旧后台任务 $u 失败"; return 1; }
                mlog "旧后台任务：$u 已停用"
            fi
            # 实例自己的 drop-in 和单元目录里的实例链接收进备份（新名字下已有一份）
            for f in "$SYS_DIR/$u.d" "$SYS_DIR/$u"; do
                [ -e "$f" ] || [ -L "$f" ] || continue
                mv "$f" "$bk/" || { mlog "❌ 移走 $f 失败"; return 1; }
                mlog "旧后台任务：$f 移到备份目录"
            done
        done
        sc daemon-reload >/dev/null 2>&1 || { mlog "❌ systemctl --user daemon-reload 失败"; return 1; }
    else
        local plist="$HOME/Library/LaunchAgents/$old_label.plist"
        launchctl bootout "gui/$(id -u)/$old_label" >/dev/null 2>&1 || true
        if [ -e "$plist" ]; then
            mv "$plist" "$bk/" || { mlog "❌ 移走 $plist 失败"; return 1; }
            mlog "旧 LaunchAgent：$old_label 已卸下，plist 移到备份目录（新 LaunchAgent 由 setup.sh 生成）"
        fi
    fi

    # 旧环境文件最后才改名：它在，下次就还会回来把没做完的步骤补上。
    mv "$old_env" "$old_env.migrated-$TS" || { mlog "❌ 旧环境文件改名留底失败"; return 1; }
    mv "$progress" "$MIG_DIR/$KEY.done" 2>/dev/null || true
    mlog "✅ 迁移完成：环境文件 $new_env，状态目录 ${new_sd:-$sd}，旧环境文件留作 $KEY.conf.migrated-$TS，备份在 $bk"
    printf 'MIGRATED\t%s\t%s\n' "$KEY" "$cfg"
    [ -z "$lock_fd" ] || eval "exec ${lock_fd}>&-"
    finalize_shared
    return 0
}

# 全机一把锁：两个项目的轮询同时走到这里、或者人在跑 setup.sh 时，只让一个在搬。
mkdir -p "$CAVIL_CONFIG_HOME" 2>/dev/null || exit 1
exec {GLOBAL_FD}>>"$CAVIL_CONFIG_HOME/.migrate.lock"
if ! flock -n "$GLOBAL_FD"; then
    [ "$MODE" = all ] && exit 0
    flock -w 60 "$GLOBAL_FD" || { echo "另一个迁移正在进行" >&2; exit 3; }
fi

KEY=""
TS=""
if [ "$MODE" = key ]; then
    migrate_key "$ONE_KEY"
    exit $?
fi

if [ "$SCHED" = systemd ] && ! command -v systemctl >/dev/null 2>&1; then exit 0; fi
for k in $(legacy_keys); do
    # 没装旧轮询单元的（比如 cron 驱动的）不归这里管
    [ -e "$SYS_DIR/$CAVIL_LEGACY_UNIT_PREFIX-poll@.timer" ] || [ -e "$SYS_DIR/$CAVIL_LEGACY_UNIT_PREFIX-poll@$k.timer" ] || continue
    ( migrate_key "$k" ) || true
done
# 旧项目都迁完了、但旧预览还没搬完 / 旧入口还没删（上一轮失败、冲突等人，或在改名前一版的
# 迁移里就已经删了入口）的机器：每轮都在这里接着做。migrate_key 迁完时自己也会调一次。
KEY=""
finalize_shared
exit 0
