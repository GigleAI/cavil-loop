#!/usr/bin/env bash
# kind: install
# 给客户端用的安装脚本接口（GitHub#313）：setup.sh 的无人值守开关、只读状态脚本、断开项目脚本、
# 换新 Mac 后台任务配置脚本。
#
# 全部在假 HOME + 假 systemctl / launchctl / plutil / uname 下跑**真实**脚本，断言生成的文件、
# 调度器状态和脚本输出——不读源码文本。macOS 一侧靠假 uname 报 Darwin、假 launchctl 记状态。
#
#   1. 不带 --yes 时 setup.sh 与合入基点逐字节一致（Linux / macOS，答 n / 答 y，输出 + 落盘文件 + 调度器状态）
#   2. --yes：不读标准输入，直接启用；结果与「答 y」一致
#   3. agent 依赖：安装与状态检查对同一场景结论一致（codex 有 claude 无 / 只有 claude）；复审 agent 缺失被报出
#   4. 状态脚本：在跑 / 已停 / 读不到（读失败、空输出都不报已停）、改名前的旧安装、配置读不出、上次轮询时间、安装形态
#   5. 断开：读不到不动；停不下来不删登记；正常断开保留项目配置和状态
#   6. 换新 Mac 后台任务配置：五个场景 + 校验不过 / 等不到锁 / 原来未加载
#   7. 文档里写给人照做的命令，按字面在干净环境跑通
#
#   bash tests/install-scripts.test.sh
set -uo pipefail
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/compat.sh
source "$REPO_DIR/tests/lib/compat.sh"
# shellcheck source=fixtures/install-fakes.sh
source "$REPO_DIR/tests/fixtures/install-fakes.sh"
SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT
export TZ=UTC

pass=0; fail=0
chk() {
    if [ "$2" = "$3" ]; then echo "  ✅ $1"; pass=$((pass+1))
    else echo "  ❌ $1"; echo "     期望：[$3]"; echo "     实得：[$2]"; fail=$((fail+1)); fi
}
chk_has() {   # <标题> <文本> <子串>
    case "$2" in *"$3"*) echo "  ✅ $1"; pass=$((pass+1)) ;;
        *) echo "  ❌ $1（没找到 [$3]）"; printf '%s\n' "$2" | head -40 | sed 's/^/     | /'; fail=$((fail+1)) ;; esac
}
chk_lacks() {
    case "$2" in *"$3"*) echo "  ❌ $1（不该出现 [$3]）"; printf '%s\n' "$2" | head -40 | sed 's/^/     | /'; fail=$((fail+1)) ;;
        *) echo "  ✅ $1"; pass=$((pass+1)) ;; esac
}

FK="$SANDBOX/fakes"; install_fakes "$FK"
H="$SANDBOX/h"; HOST="$SANDBOX/p/widget"
export FAKE_SD="$SANDBOX/sd" FAKE_LD="$SANDBOX/ld"
SYS_PATH="/usr/bin:/bin"

# skill 副本做成 git 仓库（Linux 安装会从它发布受管 release，需要 origin）
make_skill() {   # <目录> <worktree|提交>
    local d="$1" src="$2"
    rm -rf "$d" "$d.git"; mkdir -p "$d"; git init -q --bare "$d.git"
    if [ "$src" = worktree ]; then
        (cd "$REPO_DIR" && git ls-files -co --exclude-standard -z) \
            | (cd "$REPO_DIR" && xargs -0 -I{} cp --parents -P {} "$d/" 2>/dev/null)
    else
        git -C "$REPO_DIR" archive "$src" | tar -x -C "$d"
    fi
    git -C "$d" init -q -b main
    git -C "$d" add -A >/dev/null
    git -C "$d" -c user.email=t@example.invalid -c user.name=t commit -qm snapshot
    git -C "$d" remote add origin "$d.git"; git -C "$d" push -q -u origin main 2>/dev/null
}

fresh_world() {   # 清空 HOME、项目、假调度器状态
    rm -rf "$H" "$SANDBOX/p" "$FAKE_SD" "$FAKE_LD"; mkdir -p "$H" "$SANDBOX/p" "$FAKE_SD" "$FAKE_LD"
    git init -q -b main "$HOST"; git -C "$HOST" -c user.email=t@x -c user.name=t commit -q --allow-empty -m init
}

# 在假环境里跑一个命令。<os> <agent 目录列表，逗号分隔，可空> -- <命令...>
in_env() {
    local os="$1" agents="$2" p="$FK/bin" a; shift 3
    IFS=, read -ra _as <<< "$agents"
    for a in "${_as[@]}"; do [ -n "$a" ] && p="$p:$FK/agents-$a"; done
    env -u CAVIL_SKILL_LINK -u CAVIL_DEPLOY_ROOT -u CAVIL_DEPLOY_CONF -u CODING_AGENT_CONFIG \
        -u CODING_AGENT_RELEASE_ROOT -u WORKER_AGENT -u CAVIL_SCHEDULED_POLL \
        HOME="$H" PATH="$p:$SYS_PATH" FAKE_UNAME="$os" "$@"
}

# 跑一次 setup.sh。<skill> <os> <answer: n|y|--yes> [WORKER_AGENT] [agent 目录列表]
# 输出落在 $SANDBOX/setup.out，退出码在 $SANDBOX/setup.rc
run_setup() {
    local skill="$1" os="$2" ans="$3" agent="${4:-}" agents="${5:-claude}" rc=0
    local wa=(); [ -n "$agent" ] && wa=(WORKER_AGENT="$agent")
    if [ "$ans" = --yes ]; then
        in_env "$os" "$agents" -- env ${wa[@]+"${wa[@]}"} bash "$skill/setup.sh" --yes "$HOST" \
            < /dev/null > "$SANDBOX/setup.out" 2>&1 || rc=$?
    else
        printf '%s\n' "$ans" | in_env "$os" "$agents" -- env ${wa[@]+"${wa[@]}"} bash "$skill/setup.sh" "$HOST" \
            > "$SANDBOX/setup.out" 2>&1 || rc=$?
    fi
    echo "$rc" > "$SANDBOX/setup.rc"
}

# 把这一次安装的结果拍成一份可比对的文本：输出、退出码、落盘文件（内容或软链目标）、调度器状态
snapshot() {
    {
        echo "== rc $(cat "$SANDBOX/setup.rc")"
        echo "== out"; cat "$SANDBOX/setup.out"
        local f
        for f in $( { find "$H/.config" "$H/Library" "$H/.claude" "$H/.agents/skills" \( -type f -o -type l \) 2>/dev/null
                      find "$H/.local/state" -name state.json 2>/dev/null
                      echo "$HOST/cavil-loop.config"; echo "$HOST/.gitignore"
                      find "$FAKE_SD" "$FAKE_LD" -type f 2>/dev/null; } | sort -u); do
            echo "== file ${f#"$SANDBOX"}"
            if [ -L "$f" ]; then echo "-> $(readlink "$f")"; elif [ -f "$f" ]; then cat "$f"; else echo "(无)"; fi
        done
    } | sed -e "s|$SANDBOX|<SB>|g" -E -e 's/[0-9a-f]{40}/<SHA>/g'
}

SKILL="$SANDBOX/skill"            # 被测副本固定放在同一个路径，两次安装的输出不用替换路径
NEW_SRC="$SANDBOX/src-new"; make_skill "$NEW_SRC" worktree
BASE_REV=$(git -C "$REPO_DIR" merge-base HEAD origin/main 2>/dev/null || git -C "$REPO_DIR" rev-parse HEAD~1)
OLD_SRC="$SANDBOX/src-old"; make_skill "$OLD_SRC" "$BASE_REV"
use_skill() { rm -rf "$SKILL" "$SKILL.git"; cp -a "$1" "$SKILL"; cp -a "$1.git" "$SKILL.git"; git -C "$SKILL" remote set-url origin "$SKILL.git"; }

echo "── 1. 不带 --yes：setup.sh 与合入基点（${BASE_REV:0:10}）逐字节一致 ──"
if ! compat_skip "setup.sh 不带 --yes" "$OLD_SRC" "$NEW_SRC" setup.sh scripts launchd systemd; then
    for os in Linux Darwin; do
        for ans in n y; do
            fresh_world; use_skill "$OLD_SRC"; run_setup "$SKILL" "$os" "$ans"; old="$(snapshot)"
            fresh_world; use_skill "$NEW_SRC"; run_setup "$SKILL" "$os" "$ans"; new="$(snapshot)"
            chk "$os / 答 $ans：输出、退出码、落盘文件、调度器状态与改前一致" "$new" "$old"
            chk "$os / 答 $ans：安装本身成功" "$(cat "$SANDBOX/setup.rc")" 0
        done
    done
fi
use_skill "$NEW_SRC"

echo "── 2. --yes：不读标准输入，直接启用；结果与答 y 一致 ──"
for os in Linux Darwin; do
    fresh_world; run_setup "$SKILL" "$os" y; with_y="$(snapshot | grep -v '^现在 \(enable\|bootstrap\)')"
    fresh_world; run_setup "$SKILL" "$os" --yes; out="$(cat "$SANDBOX/setup.out")"
    chk "$os / --yes：退出码 0" "$(cat "$SANDBOX/setup.rc")" 0
    chk_lacks "$os / --yes：没有出现 y/N 提问" "$out" "[y/N]"
    with_yes="$(snapshot | grep -v '^现在 \(enable\|bootstrap\)')"
    chk "$os / --yes：除提问那一行外，输出和落盘结果与答 y 完全相同" "$with_yes" "$with_y"
done
fresh_world; run_setup "$SKILL" Linux --yes
chk "Linux / --yes：定时器在跑" "$(cat "$FAKE_SD/cavil-loop-poll@widget.timer.active" 2>/dev/null)" active
chk "Linux / --yes：定时器开机自启" "$(cat "$FAKE_SD/cavil-loop-poll@widget.timer.enabled" 2>/dev/null)" enabled
fresh_world; run_setup "$SKILL" Darwin --yes
chk "macOS / --yes：后台任务已加载，加载的就是生成的那份文件" \
    "$(cat "$FAKE_LD/dev.luosky.cavil-loop.widget.path" 2>/dev/null)" "$H/Library/LaunchAgents/dev.luosky.cavil-loop.widget.plist"

# 状态脚本：输出 JSON
status() {   # <os> <agents> [参数...]
    local os="$1" agents="$2"; shift 2
    in_env "$os" "$agents" -- bash "$SKILL/scripts/install-status.sh" "$@"
}
proj() { jq -c --arg k "$2" '.projects[] | select(.key == $k)' <<< "$1"; }
setup_missing() { sed -n 's/^❌ 缺少依赖：//p' "$SANDBOX/setup.out" | tr ' ' '\n' | sort | paste -sd, -; }

echo "── 3. agent 依赖：安装与状态检查结论一致 ──"
# 场景 A：项目选 codex，本机有 codex、没有 claude
fresh_world; run_setup "$SKILL" Darwin --yes codex codex
chk "A 安装：选 codex、只装了 codex → 通过" "$(cat "$SANDBOX/setup.rc")" 0
chk_has "A 安装：报依赖齐全" "$(cat "$SANDBOX/setup.out")" "✓ 依赖齐全"
st="$(status Darwin codex --agent codex)"
chk "A 状态（预检 codex）：齐全" "$(jq -c '[.agent_check.state, .agent_check.missing]' <<< "$st")" '["ok",[]]'
p="$(proj "$st" widget)"
chk "A 状态（已接项目）：worker 是 codex 且齐全" "$(jq -c '[.agents[] | select(.role=="worker") | .agent, .state]' <<< "$p")" '["codex","ok"]'
chk "A 状态（已接项目）：项目依赖齐全，不报缺 claude" "$(jq -c '.deps' <<< "$p")" '{"state":"ok","missing":[]}'
chk "A 状态：按标签选模型的 agent 列出但不算必需" "$(jq -c '[.agents[] | select(.role=="fable") | .agent, .required]' <<< "$p")" '["claude",false]'
# 场景 B：项目选 codex，本机只有 claude
fresh_world; run_setup "$SKILL" Darwin --yes codex claude
chk "B 安装：选 codex、只装了 claude → 退出 1" "$(cat "$SANDBOX/setup.rc")" 1
chk "B 安装：报缺 codex（且只缺它）" "$(setup_missing)" codex
st="$(status Darwin claude --agent codex)"
chk "B 状态（预检 codex）：报缺 codex，与安装结论一致" \
    "$(jq -r '[.agent_check.state, (.agent_check.missing | sort | join(","))] | join(" ")' <<< "$st")" "missing $(setup_missing)"
# 复审 agent 开着、本机没装它
fresh_world; run_setup "$SKILL" Darwin --yes claude claude
printf 'LABEL_PENDING_REVIEW="pending/review"\nREVIEW_WORKER_AGENT="codex"\n' >> "$HOST/cavil-loop.config"
p="$(proj "$(status Darwin claude)" widget)"
chk "复审 agent 开着、本机没装 codex：项目报缺 codex" "$(jq -c '.deps' <<< "$p")" '{"state":"missing","missing":["codex"]}'
chk "复审 agent 那一行：缺 codex" "$(jq -c '[.agents[] | select(.role=="review") | .agent, .state, .missing]' <<< "$p")" '["codex","missing",["codex"]]'
sed -i 's/^LABEL_PENDING_REVIEW="pending\/review"$/LABEL_PENDING_REVIEW=""/' "$HOST/cavil-loop.config"
p="$(proj "$(status Darwin claude)" widget)"
chk "复审关着：不算复审 agent，项目齐全" "$(jq -c '[.deps.state, ([.agents[].role] | join(","))]' <<< "$p")" '["ok","worker,fable"]'

echo "── 4. 状态脚本 ──"
fresh_world; run_setup "$SKILL" Linux --yes
st="$(status Linux claude)"; p="$(proj "$st" widget)"
chk "Linux：在跑" "$(jq -r '.scheduler.state' <<< "$p")" running
chk "Linux：实例名、目录、仓库、配置文件" "$(jq -r '[.key, .layout, .host, .repo, .config] | join(" ")' <<< "$p")" \
    "widget new $HOST acme/widget $HOST/cavil-loop.config"
chk "Linux：受管安装，版本 = 当前 release" "$(jq -r '[.daemon.form, .daemon.version] | join(" ")' <<< "$st")" \
    "managed $(basename "$(readlink -f "$H/.agents/skills/cavil-loop")")"
chk "gh 已登录" "$(jq -c '.gh' <<< "$st")" '{"installed":true,"logged_in":true}'
chk "gh 未登录 → logged_in=false" "$(FAKE_GH_AUTH=1 status Linux claude | jq -c '.gh')" '{"installed":true,"logged_in":false}'
for mode in fail empty; do
    chk "Linux：systemctl ${mode} → 读不到（不是已停）" "$(FAKE_SD_MODE=$mode status Linux claude | jq -r '.projects[0].scheduler.state')" unknown
done
echo inactive > "$FAKE_SD/cavil-loop-poll@widget.timer.active"
chk "Linux：定时器 inactive → 已停" "$(status Linux claude | jq -r '.projects[0].scheduler.state')" stopped
echo deactivating > "$FAKE_SD/cavil-loop-poll@widget.timer.active"
chk "Linux：不认识的状态词 → 读不到" "$(status Linux claude | jq -r '.projects[0].scheduler.state')" unknown
echo active > "$FAKE_SD/cavil-loop-poll@widget.timer.active"
# 上次轮询时间
sd="$(jq -r '.state_dir' <<< "$p")"; mkdir -p "$sd"
printf '{"next_due":0,"last_poll":1762689600,"last_active":0,"fail_streak":0,"fingerprint":""}' > "$sd/poll-pace.json"
chk "上次轮询时间取自节奏状态" "$(status Linux claude | jq -c '.projects[0].last_poll')" '{"epoch":1762689600,"iso":"2025-11-09T12:00:00Z","source":"poll-pace"}'
rm -f "$sd/poll-pace.json"; : > "$sd/poll.log"; touch -d @1762689660 "$sd/poll.log"
chk "没有节奏状态时取 poll.log 的修改时间" "$(status Linux claude | jq -c '.projects[0].last_poll | [.epoch, .source]')" '[1762689660,"poll-log"]'
# 改名前的旧安装 + 两边同名时新的赢 + 部署器配置不算项目
OLDHOST="$SANDBOX/p/oldproj"; git init -q -b main "$OLDHOST"
printf 'REPO="acme/old"\nSTATE_DIR="%s/oldstate"\nWORKER_AGENT="claude"\n' "$H" > "$OLDHOST/coding-agent.config"
mkdir -p "$H/.config/coding-agent-work-loop"
printf 'PROJECT_ROOT=%s\nCODING_AGENT_CONFIG=%s\nPATH=/usr/bin\n' "$OLDHOST" "$OLDHOST/coding-agent.config" > "$H/.config/coding-agent-work-loop/oldproj.conf"
cp "$H/.config/coding-agent-work-loop/oldproj.conf" "$H/.config/coding-agent-work-loop/widget.conf"
printf 'X=1\n' > "$H/.config/cavil-loop/deploy.conf"
echo active > "$FAKE_SD/coding-agent-poll@oldproj.timer.active"
st="$(status Linux claude)"
chk "改名前的旧安装被列出（旧名字的定时器、旧配置文件名）" \
    "$(jq -r '.projects[] | select(.key=="oldproj") | [.layout, .scheduler.unit, .scheduler.state, .repo, .config] | join(" ")' <<< "$st")" \
    "legacy coding-agent-poll@oldproj.timer running acme/old $OLDHOST/coding-agent.config"
chk "同一实例名新旧两边都有：只列一次，用新的" "$(jq -r '[.projects[] | select(.key=="widget") | .layout] | join(",")' <<< "$st")" new
chk "部署器自己的 deploy.conf 不算项目" "$(jq -r '[.projects[].key] | sort | join(",")' <<< "$st")" "oldproj,widget"
# 配置读不出
printf 'exit 1\n' > "$OLDHOST/coding-agent.config"
chk "配置读不出 → 配置状态 unreadable、依赖 unknown（不报齐全）" \
    "$(status Linux claude | jq -c '.projects[] | select(.key=="oldproj") | [.config_state, .deps.state, .agents]')" '["unreadable","unknown",null]'
rm -rf "$H/.config/coding-agent-work-loop"
# macOS：加载 / 未加载 / 读不到；普通代码目录形态
fresh_world; run_setup "$SKILL" Darwin --yes
mkdir -p "$H/.agents/skills"; ln -s "$SKILL" "$H/.agents/skills/cavil-loop"
st="$(status Darwin claude)"
chk "macOS：已加载 → 在跑" "$(jq -r '.projects[0].scheduler.state' <<< "$st")" running
chk "macOS：普通代码目录，版本 = 它的 HEAD" "$(jq -r '[.daemon.form, .daemon.version] | join(" ")' <<< "$st")" "checkout $(git -C "$SKILL" rev-parse HEAD)"
for mode in fail empty; do
    chk "macOS：launchctl ${mode} → 读不到（不是已停）" "$(FAKE_LD_PRINT=$mode status Darwin claude | jq -r '.projects[0].scheduler.state')" unknown
done
chk "macOS：后台任务用的 bash 够新 → ok" "$(jq -c '.bash | [.major >= 4, .ok]' <<< "$st")" '[true,true]'
# 只有系统自带的旧 bash（3.x）：用和 setup.sh 同一个挑选函数，报出来
mkdir -p "$FK/agents-oldbash"
printf '#!/bin/bash\nif [ "$#" = 2 ] && [ "$1" = -c ] && [ "$2" = '"'"'echo "${BASH_VERSINFO[0]}"'"'"' ]; then echo 3; exit 0; fi\nexec /bin/bash "$@"\n' > "$FK/agents-oldbash/bash"
chmod +x "$FK/agents-oldbash/bash"
chk "macOS：只有 3.x 的 bash → ok=false，给出路径" "$(status Darwin claude,oldbash | jq -c '.bash')" "{\"path\":\"$FK/agents-oldbash/bash\",\"major\":3,\"ok\":false}"
rm -f "$FAKE_LD"/dev.luosky.cavil-loop.widget.*
chk "macOS：未加载 → 已停" "$(status Darwin claude | jq -r '.projects[0].scheduler.state')" stopped
# 缺 jq：只输出通用工具的预检（不靠 jq 拼），退出 3
NOJQ="$SANDBOX/nojq"; rm -rf "$NOJQ"; mkdir -p "$NOJQ"
for d in "$FK/bin" "$FK/agents-claude" /usr/bin /bin; do
    for f in "$d"/*; do n="${f##*/}"; [ "$n" = jq ] || [ "$n" = tmux ] || [ -e "$NOJQ/$n" ] || ln -s "$f" "$NOJQ/$n"; done
done
rc=0; out="$(env -i HOME="$H" PATH="$NOJQ" FAKE_UNAME=Darwin FAKE_LD="$FAKE_LD" bash "$SKILL/scripts/install-status.sh" 2>/dev/null)" || rc=$?
chk "缺 jq：退出 3" "$rc" 3
chk "缺 jq：预检 JSON 列出缺的通用工具（jq、tmux），不给项目" "$(jq -c . <<< "$out")" '{"version":1,"precheck":true,"os":"Darwin","base_deps":{"missing":["tmux","jq"]}}'
fresh_world
chk "什么都没装：daemon 形态 missing、项目列表为空" "$(status Linux claude | jq -c '[.daemon.form, .projects]')" '["missing",[]]'

echo "── 5. 断开项目 ──"
disconnect() { local os="$1"; shift; in_env "$os" claude -- bash "$SKILL/scripts/disconnect-project.sh" "$@"; }
envf="$H/.config/cavil-loop/widget.conf"
# Linux
fresh_world; run_setup "$SKILL" Linux --yes
rc=0; out="$(FAKE_SD_MODE=fail disconnect Linux widget)" || rc=$?
chk "Linux 读不到：退出 2、RESULT=unknown" "$rc $(tail -1 <<< "$out")" "2 RESULT=unknown"
chk "Linux 读不到：环境文件还在、定时器还在跑" "$([ -f "$envf" ] && echo y) $(cat "$FAKE_SD/cavil-loop-poll@widget.timer.active")" "y active"
chk "Linux 读不到：没发过 disable" "$(grep -c '^--user disable' "$FAKE_SD/calls")" 0
rc=0; out="$(FAKE_SD_STUCK=1 disconnect Linux widget)" || rc=$?
chk "Linux 停不下来：退出 3、登记保留" "$rc $(tail -1 <<< "$out") $([ -f "$envf" ] && echo kept)" "3 RESULT=failed kept"
rc=0; out="$(disconnect Linux widget)" || rc=$?
chk "Linux 正常断开：退出 0、RESULT=disconnected" "$rc $(tail -1 <<< "$out")" "0 RESULT=disconnected"
chk "Linux 正常断开：定时器已停、不再自启" "$(cat "$FAKE_SD/cavil-loop-poll@widget.timer.active") $(cat "$FAKE_SD/cavil-loop-poll@widget.timer.enabled")" "inactive disabled"
chk "Linux 正常断开：环境文件已删，项目配置和状态目录保留" \
    "$([ -e "$envf" ] && echo env) $([ -f "$HOST/cavil-loop.config" ] && echo config) $([ -f "$H/.local/state/cavil-loop/widget/state.json" ] && echo state)" " config state"
chk "Linux 断开后：状态脚本不再列出它" "$(status Linux claude | jq -c '.projects')" '[]'
rc=0; disconnect Linux widget >/dev/null || rc=$?
chk "再断一次：没有这个实例，退出 1" "$rc" 1
# macOS
plist="$H/Library/LaunchAgents/dev.luosky.cavil-loop.widget.plist"
fresh_world; run_setup "$SKILL" Darwin --yes
rc=0; out="$(FAKE_LD_PRINT=fail disconnect Darwin widget)" || rc=$?
chk "macOS 读不到：退出 2、plist 和环境文件都在、任务仍加载" \
    "$rc $([ -f "$plist" ] && echo plist) $([ -f "$envf" ] && echo env) $([ -f "$FAKE_LD/dev.luosky.cavil-loop.widget.path" ] && echo loaded)" "2 plist env loaded"
rc=0; out="$(FAKE_LD_BOOTOUT=stuck disconnect Darwin widget)" || rc=$?
chk "macOS 卸不掉：退出 3、登记保留" "$rc $([ -f "$plist" ] && echo plist) $([ -f "$envf" ] && echo env)" "3 plist env"
rc=0; out="$(disconnect Darwin widget)" || rc=$?
chk "macOS 正常断开：退出 0、已卸载、plist 和环境文件已删、项目配置保留" \
    "$rc $([ -f "$FAKE_LD/dev.luosky.cavil-loop.widget.path" ] && echo loaded) $([ -e "$plist" ] && echo plist) $([ -e "$envf" ] && echo env) $([ -f "$HOST/cavil-loop.config" ] && echo config)" "0    config"
fresh_world; run_setup "$SKILL" Darwin n
rc=0; out="$(disconnect Darwin widget)" || rc=$?
chk "macOS 未加载的项目：不发 bootout，直接撤登记" "$rc $(grep -c '^bootout' "$FAKE_LD/calls") $([ -e "$plist" ] && echo plist)" "0 0 "

echo "── 6. 换新 Mac 后台任务配置 ──"
refresh() { in_env Darwin claude -- bash "$SKILL/scripts/launchd-refresh.sh" "$@"; }
template="$SKILL/launchd/dev.luosky.cavil-loop.plist.template"
tpl_orig="$SANDBOX/template.orig"; cp "$template" "$tpl_orig"
change_template() { cp "$tpl_orig" "$template"; sed -i 's|<key>RunAtLoad</key>|<key>Nice</key>\n    <integer>5</integer>\n\n    <key>RunAtLoad</key>|' "$template"; }
restore_template() { cp "$tpl_orig" "$template"; }
backups() { find "$H/.local/state/cavil-loop/widget/launchd-backup" -type f 2>/dev/null | sort; }
ld_calls() { grep -cE '^(bootout|bootstrap)' "$FAKE_LD/calls" 2>/dev/null || true; }
setup_mac() {   # 装好、已加载；清掉安装时的调用记录
    restore_template; fresh_world; run_setup "$SKILL" Darwin --yes; : > "$FAKE_LD/calls"
    cp "$plist" "$SANDBOX/plist.orig"
}
# 场景 1：模板变了、在跑 → 换新
setup_mac; change_template
rc=0; out="$(refresh widget)" || rc=$?
chk "① 模板变了且在跑：退出 0、RESULT=replaced" "$rc $(tail -1 <<< "$out")" "0 RESULT=replaced"
chk_has "① 新文件已换上" "$(cat "$plist")" "<key>Nice</key>"
chk "① 任务重新加载，加载的是新内容" "$(cmp -s "$FAKE_LD/dev.luosky.cavil-loop.widget.content" "$plist" && echo same) $(cat "$FAKE_LD/dev.luosky.cavil-loop.widget.path")" "same $plist"
b="$(backups)"
chk "① 原文件备份在状态目录、内容是换新前的" "$(printf '%s\n' "$b" | grep -c .) $(cmp -s "$b" "$SANDBOX/plist.orig" && echo same)" "1 same"
# 换新的结果就是现在安装会生成的那份（同一个生成函数）
cp "$plist" "$SANDBOX/plist.refreshed"; rm -f "$plist" "$FAKE_LD"/dev.luosky.cavil-loop.widget.*
run_setup "$SKILL" Darwin n
chk "① 换新后的文件 = 现在重新安装生成的文件" "$(cmp -s "$plist" "$SANDBOX/plist.refreshed" && echo same)" same
# 场景 2：模板没变 → 不动
setup_mac
rc=0; out="$(refresh widget)" || rc=$?
chk "② 模板没变：退出 0、RESULT=unchanged" "$rc $(tail -1 <<< "$out")" "0 RESULT=unchanged"
chk "② 文件、任务都没动、没有备份" "$(cmp -s "$plist" "$SANDBOX/plist.orig" && echo same) $(ld_calls) [$(backups)]" "same 0 []"
# 场景 3：状态读不到 → 不动
setup_mac; change_template
for mode in fail empty; do
    rc=0; out="$(FAKE_LD_PRINT=$mode refresh widget)" || rc=$?
    chk "③ 状态读不到（$mode）：退出 2、RESULT=unknown" "$rc $(tail -1 <<< "$out")" "2 RESULT=unknown"
    chk "③ 状态读不到（$mode）：文件、任务都没动、没有备份" "$(cmp -s "$plist" "$SANDBOX/plist.orig" && echo same) $(ld_calls) [$(backups)]" "same 0 []"
done
# 场景 4：加载新文件失败 → 恢复原文件、按原状态重新加载
setup_mac; change_template
rc=0; out="$(FAKE_LD_REJECT='<key>Nice</key>' refresh widget)" || rc=$?
chk "④ 加载新文件失败：退出 3、RESULT=failed" "$rc $(tail -1 <<< "$out")" "3 RESULT=failed"
chk "④ 原文件恢复、任务加载的是原内容" \
    "$(cmp -s "$plist" "$SANDBOX/plist.orig" && echo file) $(cmp -s "$FAKE_LD/dev.luosky.cavil-loop.widget.content" "$SANDBOX/plist.orig" && echo loaded)" "file loaded"
chk "④ 备份保留" "$(backups | grep -c .)" 1
# 场景 5：加载新文件失败且恢复也失败 → 报两次原文和备份位置
setup_mac; change_template
rc=0; out="$(FAKE_LD_BOOTSTRAP=fail refresh widget)" || rc=$?
chk "⑤ 恢复也失败：退出 4、RESULT=needs_human" "$rc $(tail -1 <<< "$out")" "4 RESULT=needs_human"
b="$(backups)"
chk_has "⑤ 输出第一次的原文" "$out" "第一次（加载新文件）的原文"
chk_has "⑤ 输出第二次的原文" "$out" "第二次（恢复原文件）的原文"
chk_has "⑤ 输出里有 launchctl 的报错原文" "$out" "Bootstrap failed: 5: Input/output error"
chk_has "⑤ 输出备份位置" "$out" "原文件备份：$b"
chk "⑤ 备份仍在、内容是原文件" "$(cmp -s "$b" "$SANDBOX/plist.orig" && echo same)" same
# 场景 6 / 7：卸载成功后读不到状态（GitHub#314 复审第 2 轮）。launchctl 外面套一层：卸载之后的 print 失败
cp "$FK/bin/launchctl" "$FK/launchctl.real"
cat > "$FK/bin/launchctl" <<'WRAP'
#!/usr/bin/env bash
if [ "${1:-}" = print ] && [ -f "$FAKE_LD/after-bootout" ]; then
    n="$(cat "$FAKE_LD/print-fails" 2>/dev/null || echo 0)"
    if [ "${FLAKY_PRINT_FAILS:-always}" = always ] || [ "$n" -lt "$FLAKY_PRINT_FAILS" ]; then
        echo $((n + 1)) > "$FAKE_LD/print-fails"
        echo "launchctl: connection unavailable" >&2; exit 1
    fi
fi
[ "${1:-}" = bootout ] && touch "$FAKE_LD/after-bootout"
exec "$(dirname "$0")/../launchctl.real" "$@"
WRAP
chmod +x "$FK/bin/launchctl"
# ⑥ 之后一直读不到、重新加载也失败 → 不能报「已恢复」，只能 needs_human
setup_mac; change_template; rm -f "$FAKE_LD/after-bootout" "$FAKE_LD/print-fails"   # 安装时的卸载不算
rc=0; out="$(FAKE_LD_BOOTSTRAP=fail refresh widget)" || rc=$?
chk "⑥ 卸载后读不到、重新加载失败：退出 4、RESULT=needs_human（不是 failed）" "$rc $(tail -1 <<< "$out")" "4 RESULT=needs_human"
chk_has "⑥ 输出读不到的原文" "$out" "connection unavailable"
chk "⑥ 原文件未动、没有备份" "$(cmp -s "$plist" "$SANDBOX/plist.orig" && echo same) [$(backups)]" "same []"
chk "⑥ 任务确实没在跑（直接问假调度器）" "$([ -f "$FAKE_LD/dev.luosky.cavil-loop.widget.path" ] && echo loaded || echo gone)" gone
# ⑦ 只读不到一次、重新加载成功并读回确认 → failed（已确认恢复），任务加载的是原文件
setup_mac; change_template; rm -f "$FAKE_LD/after-bootout" "$FAKE_LD/print-fails"
rc=0; out="$(FLAKY_PRINT_FAILS=1 refresh widget)" || rc=$?
chk "⑦ 卸载后读不到一次、重新加载并读回确认：退出 3、RESULT=failed" "$rc $(tail -1 <<< "$out")" "3 RESULT=failed"
chk "⑦ 原文件未动、任务加载的是原内容" \
    "$(cmp -s "$plist" "$SANDBOX/plist.orig" && echo file) $(cmp -s "$FAKE_LD/dev.luosky.cavil-loop.widget.content" "$SANDBOX/plist.orig" && echo loaded)" "file loaded"
mv -f "$FK/launchctl.real" "$FK/bin/launchctl"
# 其余：校验不过、等不到锁、原来未加载
setup_mac; change_template
rc=0; out="$(FAKE_PLUTIL_FAIL=1 refresh widget)" || rc=$?
chk "校验不过：退出 2、RESULT=lint_failed、什么都没动" "$rc $(tail -1 <<< "$out") $(cmp -s "$plist" "$SANDBOX/plist.orig" && echo same) $(ld_calls)" "2 RESULT=lint_failed same 0"
chk "校验不过：LaunchAgents 里没留下临时文件" "$(find "$H/Library/LaunchAgents" -name '.*' -type f | wc -l)" 0
lockf="$H/.local/state/cavil-loop/widget/poll.lock"; mkdir -p "$(dirname "$lockf")"
flock "$lockf" sleep 5 & holder=$!; sleep 0.3
rc=0; out="$(CAVIL_REFRESH_LOCK_WAIT=1 refresh widget)" || rc=$?
kill "$holder" 2>/dev/null; wait "$holder" 2>/dev/null
chk "这一轮轮询没跑完、等不到锁：退出 2、RESULT=lock_timeout、什么都没动" \
    "$rc $(tail -1 <<< "$out") $(cmp -s "$plist" "$SANDBOX/plist.orig" && echo same) $(ld_calls) [$(backups)]" "2 RESULT=lock_timeout same 0 []"
restore_template; fresh_world; run_setup "$SKILL" Darwin n; : > "$FAKE_LD/calls"; change_template
rc=0; out="$(refresh widget)" || rc=$?
chk "原来未加载：换新、保持未加载" "$rc $(tail -1 <<< "$out") $(ld_calls) $([ -f "$FAKE_LD/dev.luosky.cavil-loop.widget.path" ] && echo loaded)" "0 RESULT=replaced 0 "
chk_has "原来未加载：文件已换新" "$(cat "$plist")" "<key>Nice</key>"
rc=0; out="$(in_env Linux claude -- bash "$SKILL/scripts/launchd-refresh.sh" widget)" || rc=$?
chk "Linux 上：不适用，退出 1" "$rc $(tail -1 <<< "$out")" "1 RESULT=not_macos"
restore_template

echo "── 7. 文档里的命令按字面跑通 ──"
doc_block() {   # <文档> <标记名> → 标记之间那个 bash 代码块
    awk -v b="<!-- $2:begin -->" -v e="<!-- $2:end -->" '$0==b{f=1;next} $0==e{f=0} f' "$REPO_DIR/docs/$1" \
        | awk '/^```bash$/{f=1;next} /^```$/{f=0} f'
}
run_doc() {   # <os> <脚本文件>：空环境，只给 HOME 和 PATH（外加假调度器要的状态目录）
    env -i HOME="$H" PATH="$FK/bin:$FK/agents-claude:$SYS_PATH" FAKE_UNAME="$1" FAKE_SD="$FAKE_SD" FAKE_LD="$FAKE_LD" \
        bash -euo pipefail "$2" 2>&1
}
for mark in install-scripts-ops install-scripts-mac-ops; do
    doc_block operations.md "$mark" > "$SANDBOX/$mark.sh"
    chk "$mark：中英两份文档里的命令一字不差" "$(doc_block operations.zh.md "$mark")" "$(cat "$SANDBOX/$mark.sh")"
    chk "$mark：命令块非空" "$(grep -c . "$SANDBOX/$mark.sh" | awk '{print ($1>1)}')" 1
done
fresh_world; mkdir -p "$H/.agents/skills" "$H/github"; ln -s "$SKILL" "$H/.agents/skills/cavil-loop"
rc=0; out="$(run_doc Linux "$SANDBOX/install-scripts-ops.sh")" || rc=$?
chk "接上 → 状态 → 预检 → 断开：空环境下跑完、退出 0" "$rc" 0
chk_has "状态里列出了接上的项目，在跑" "$out" "myproject acme/widget running deps=ok"
chk_has "预检 codex：本机没装 codex，报缺" "$out" '{"agent":"codex","state":"missing","missing":["codex"]}'
chk "最后一行：断开成功" "$(tail -1 <<< "$out")" RESULT=disconnected
chk "跑完后项目已断开、定时器已停" "$([ -e "$H/.config/cavil-loop/myproject.conf" ] && echo still) $(cat "$FAKE_SD/cavil-loop-poll@myproject.timer.active")" " inactive"
fresh_world; mkdir -p "$H/.agents/skills" "$H/github"; ln -s "$SKILL" "$H/.agents/skills/cavil-loop"
git init -q "$H/github/myproject"
HOST="$H/github/myproject" run_setup "$SKILL" Darwin --yes
change_template
rc=0; out="$(run_doc Darwin "$SANDBOX/install-scripts-mac-ops.sh")" || rc=$?
restore_template
chk "macOS 换新：空环境下跑完、退出 0、RESULT=replaced" "$rc $(tail -1 <<< "$out")" "0 RESULT=replaced"
chk_has "macOS 换新：文件已换新" "$(cat "$H/Library/LaunchAgents/dev.luosky.cavil-loop.myproject.plist")" "<key>Nice</key>"

echo
compat_summary
echo "通过 $pass，失败 $fail"
report_counts "$pass" "$fail"
[ "$fail" -eq 0 ]
