#!/usr/bin/env bash
# 新旧两套名字（GigleAI/cavil-loop#70）的守卫。
#
# 跑法：bash tests/cavil-names.test.sh   （约 20 秒：要真的跑两次 setup.sh 和三轮轮询）
# 依赖：git / jq / flock / tmux / timeout。不碰网络——gh / systemctl / claude 都是假的，
# HOME 指向 temp，不会动到本机真实安装。
#
# 为什么必须有这个文件：改名这件事错了**不会报错**，只会悄悄走错路径——
#   · 新装的东西混进旧名字 → 将来的迁移会把它当旧安装再搬一遍；
#   · 旧安装找不到自己的配置 / 状态 / 覆盖目录 → 轮询照跑，但用的是空状态，已读评论
#     记录丢光、项目自带的指令静默失效；
#   · 重跑 setup 给旧项目又装一套新任务、旧的还开着 → 两个轮询抢同一批 issue。
# 「挑新还是挑旧」这条规则有四份实现（_names.sh、release-entry.sh 内联、Python 复盘、
# setup.sh 的安装布局判断），这里用同一组夹具对拍。
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
BASE_COMMIT="d1946f2"   # 改名前的 main，用作「行为与改动前一致」的对照

TMP="$(mktemp -d)"
cleanup() {
    local s
    for s in $(tmux ls -F '#{session_name}' 2>/dev/null | grep -E '^namestest' || true); do
        tmux kill-session -t "=$s" 2>/dev/null || true
    done
    rm -rf "$TMP"
}
trap cleanup EXIT

pass=0; fail=0
chk() {
    if [ "$2" = "$3" ]; then echo "  ✅ $1"; pass=$((pass+1))
    else echo "  ❌ $1 (期望 [$3]，实得 [$2])"; fail=$((fail+1)); fi
}

# ─────────────────────────────────────────────────────────────────────────────
echo "【1】挑新还是挑旧：_names.sh 与 release-entry.sh 的内联版本逐个夹具对拍"
sed -n '/^cavil_pick() {/,/^}/p' "$REPO_DIR/scripts/release-entry.sh" > "$TMP/entry-pick.sh"
chk "release-entry.sh 里找得到内联的 cavil_pick" "$([ -s "$TMP/entry-pick.sh" ] && echo yes)" "yes"
pick_both() {   # <new> <old> → "names|entry"
    local a b
    a=$(bash -c 'HOME=/nonexistent; source "$1"; cavil_pick "$2" "$3"' _ "$REPO_DIR/scripts/_names.sh" "$1" "$2")
    b=$(bash -c 'source "$1"; cavil_pick "$2" "$3"' _ "$TMP/entry-pick.sh" "$1" "$2")
    printf '%s|%s' "$a" "$b"
}
P="$TMP/pick"; mkdir -p "$P"
chk "都不在 → 新的"      "$(pick_both "$P/n1" "$P/o1")" "$P/n1|$P/n1"
mkdir -p "$P/o2"
chk "只有旧的 → 旧的"    "$(pick_both "$P/n2" "$P/o2")" "$P/o2|$P/o2"
mkdir -p "$P/n3" "$P/o3"
chk "两个都在 → 新的"    "$(pick_both "$P/n3" "$P/o3")" "$P/n3|$P/n3"
ln -s "$P/missing" "$P/n4"; mkdir -p "$P/o4"
chk "新的是悬空软链 → 仍是新的（装过东西，别藏起来）" "$(pick_both "$P/n4" "$P/o4")" "$P/n4|$P/n4"
: > "$P/o5"
chk "旧的是普通文件 → 旧的" "$(pick_both "$P/n5" "$P/o5")" "$P/o5|$P/o5"

echo "【2】稳定入口按同一规则挑技能入口（旧机器 → 旧入口；新入口一出现就用新的）"
EH="$TMP/entry-home"
mkdir -p "$EH/.agents/skills" "$TMP/relA/scripts" "$TMP/relB/scripts"
printf '#!/usr/bin/env bash\necho A\n' > "$TMP/relA/scripts/poll-entry.sh"
printf '#!/usr/bin/env bash\necho B\n' > "$TMP/relB/scripts/poll-entry.sh"
mkdir -p "$EH/.agents/releases/cavil-loop/entrypoints"
cp "$REPO_DIR/scripts/release-entry.sh" "$EH/.agents/releases/cavil-loop/entrypoints/release-entry.sh"
ln -s release-entry.sh "$EH/.agents/releases/cavil-loop/entrypoints/poll-entry.sh"
run_entry() { env -u CAVIL_SKILL_LINK -u CAVIL_DEPLOY_ROOT -u CAVIL_DEPLOY_CONF HOME="$EH" \
                  bash "$EH/.agents/releases/cavil-loop/entrypoints/poll-entry.sh" 2>&1; }
ln -s "$TMP/relA" "$EH/.agents/skills/coding-agent-work-loop"
chk "只有旧入口 → 跑旧入口指向的版本" "$(run_entry)" "A"
ln -s "$TMP/relB" "$EH/.agents/skills/cavil-loop"
chk "新旧入口都在 → 跑新入口指向的版本" "$(run_entry)" "B"
mkdir -p "$EH/.config/coding-agent-work-loop"
printf 'CAVIL_SKILL_LINK="%s"\n' "$EH/.agents/skills/coding-agent-work-loop" > "$EH/.config/coding-agent-work-loop/deploy.conf"
chk "只有旧的部署配置 → 照样读它" "$(run_entry)" "A"

echo "【3】项目覆盖目录的顺序：Python 复盘与 _names.sh 是同一张表"
bash_dirs=$(bash -c 'source "$1"; printf "%s\n" "${CAVIL_PROJECT_SKILL_DIRS[@]}"' _ "$REPO_DIR/scripts/_names.sh")
py_dirs=$(cd "$REPO_DIR/scripts" && python3 -I -c '
import importlib.util, sys
sys.path.insert(0, ".")
spec = importlib.util.spec_from_file_location("pmr", "post-merge-retrospective.py")
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print("\n".join(m.PROJECT_SKILL_DIRS))')
chk "两份目录表逐行一致" "$py_dirs" "$bash_dirs"
lessons_for() {   # <checkout> → 复盘会写的 lessons 路径
    (cd "$REPO_DIR/scripts" && python3 -I -c '
import importlib.util, sys
from pathlib import Path
sys.path.insert(0, ".")
spec = importlib.util.spec_from_file_location("pmr", "post-merge-retrospective.py")
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(m.project_lessons_path(Path(sys.argv[1])))' "$1")
}
L="$TMP/lessons"; mkdir -p "$L/a" "$L/b/.agents/skills/coding-agent-work-loop/prompts" "$L/c/.agents/skills/coding-agent-work-loop/prompts" "$L/c/.agents/skills/cavil-loop/prompts"
: > "$L/b/.agents/skills/coding-agent-work-loop/prompts/lessons.md"
: > "$L/c/.agents/skills/coding-agent-work-loop/prompts/lessons.md"
: > "$L/c/.agents/skills/cavil-loop/prompts/lessons.md"
chk "新项目（什么都没有）→ 写进新目录" "$(lessons_for "$L/a")" ".agents/skills/cavil-loop/prompts/lessons.md"
chk "旧项目 → 写回它原来那份"          "$(lessons_for "$L/b")" ".agents/skills/coding-agent-work-loop/prompts/lessons.md"
chk "两份都有 → 写派工会读的那份（新的）" "$(lessons_for "$L/c")" ".agents/skills/cavil-loop/prompts/lessons.md"

echo "【4】派工读项目文件：新名优先、旧名照认（配置文件 / 指令覆盖 / 自定义 driver）"
PJ="$TMP/lookup"; mkdir -p "$PJ/project/sub" "$PJ/state" "$PJ/skill/prompts"
write_conf() { cat > "$1" <<CONF
REPO="acme/widget"
PROJECT_ROOT="$PJ/project"
WORKTREE_BASE="$PJ/wt"
STATE_DIR="$PJ/state"
TMUX_PREFIX="namestest"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
MARK="$2"
CONF
}
in_lib() {   # 在 project/sub 里 source _lib.sh 后执行 $1
    (cd "$PJ/project/sub" && env -u CODING_AGENT_CONFIG -u CODING_AGENT_RELEASE_ROOT HOME="$PJ/home" bash -c '
        exec 8>&2; source "$1/scripts/_lib.sh"; exec 2>&8 8>&-; SKILL_DIR="$2"; eval "$3"' _ \
        "$REPO_DIR" "$PJ/skill" "$1" 2>&1)
}
write_conf "$PJ/project/coding-agent.config" old
chk "只有旧配置文件 → 向上找到它" "$(in_lib 'echo $MARK')" "old"
write_conf "$PJ/project/cavil-loop.config" new
chk "两个都在 → 新的"             "$(in_lib 'echo $MARK')" "new"

printf 'BASE\n' > "$PJ/skill/prompts/new-issue.template.md"
OLD_P="$PJ/project/.agents/skills/coding-agent-work-loop/prompts"
NEW_P="$PJ/project/.agents/skills/cavil-loop/prompts"
mkdir -p "$OLD_P"
printf 'OLD-EXTRA\n' > "$OLD_P/new-issue.extra.md"
chk "只有旧覆盖目录 → 增量照样接上" "$(in_lib 'grep -c OLD-EXTRA "$(compose_prompt_template new-issue)"')" "1"
mkdir -p "$NEW_P"
printf 'NEW-EXTRA\n' > "$NEW_P/new-issue.extra.md"
chk "两个都有 → 用新目录的"         "$(in_lib 'f=$(compose_prompt_template new-issue); echo "$(grep -c NEW-EXTRA "$f")$(grep -c OLD-EXTRA "$f")"')" "10"

drv() { mkdir -p "$PJ/project/$1/drivers"; cat > "$PJ/project/$1/drivers/mini.sh" <<D
agent_bin() { echo $2; }
agent_has_history() { return 1; }
agent_is_busy() { return 1; }
agent_command_new() { :; }
agent_command_resume() { :; }
D
}
drv .agents/skills/coding-agent-work-loop old-driver
chk "只有旧目录的自定义 driver → 找得到" "$(in_lib 'source_driver mini && agent_bin')" "old-driver"
drv .agents/skills/cavil-loop new-driver
chk "两个都有 → 用新目录的"            "$(in_lib 'source_driver mini && agent_bin')" "new-driver"

echo "【4b】预览的全新注册：本机装了哪套单元就用哪套，登记目录跟着单元走"
echo "     （已有的旧预览跟着自己的登记走，见 tests/preview-rename-coexist.test.sh）"
preview_pick() { HOME="$1" bash -c 'source "$1"; p=$(cavil_preview_unit_prefix); echo "$p|$(cavil_preview_dir_of_prefix "$p")"' _ "$REPO_DIR/scripts/_names.sh"; }
PV="$TMP/pv"; mkdir -p "$PV/.config/systemd/user"
chk "什么都没装 → 新的" "$(preview_pick "$PV")" "cavil-loop|$PV/.config/cavil-loop/preview"
: > "$PV/.config/systemd/user/coding-agent-preview@.socket"
chk "只装了旧单元 → 旧单元 + 旧登记目录" "$(preview_pick "$PV")" "coding-agent|$PV/.config/coding-agent-work-loop/preview"
: > "$PV/.config/systemd/user/cavil-loop-preview@.socket"
chk "新旧都装了 → 新的" "$(preview_pick "$PV")" "cavil-loop|$PV/.config/cavil-loop/preview"

# ─────────────────────────────────────────────────────────────────────────────
# 后面三组都要一份「可以发布的 skill 仓库」：把当前工作区（含未提交改动）做成一个 commit。
SRC_REMOTE="$TMP/skill-remote.git"
SRC="$TMP/skill-src"
git init -q --bare "$SRC_REMOTE"
git init -q -b main "$SRC"
(cd "$REPO_DIR" && git ls-files -co --exclude-standard -z) \
    | (cd "$REPO_DIR" && xargs -0 -I{} cp --parents -P {} "$SRC/" 2>/dev/null)
git -C "$SRC" add -A >/dev/null
git -C "$SRC" -c user.email=t@example.invalid -c user.name=t commit -qm snapshot
git -C "$SRC" remote add origin "$SRC_REMOTE"
git -C "$SRC" push -q -u origin main 2>/dev/null

FAKEBIN="$TMP/fakebin"; mkdir -p "$FAKEBIN"
cat > "$FAKEBIN/gh" <<'GH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${GH_LOG:-/dev/null}"
case "$*" in
    "auth status"*) exit 0 ;;
    "repo view"*) echo "acme/widget"; exit 0 ;;
    "label create"*) exit 0 ;;
    *"pr list"*--json*) echo ""; exit 0 ;;
    *"issue list"*--json*) echo ""; exit 0 ;;
    *"repos/acme/widget/issues"*state=open*|*"repos/acme/widget/issues?"*|*"repos/acme/widget/issues "*)
        cat "${SNAP_ISSUES:-/dev/null}"; exit 0 ;;
    *"repos/acme/widget/pulls"*) echo '[[]]'; exit 0 ;;
esac
echo '[]'
GH
# 跟真 systemctl 一样：没装过的单元 is-active / is-enabled 都答「不是」（迁移靠它们判断原状态）
cat > "$FAKEBIN/systemctl" <<'SC'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${SYSTEMCTL_LOG:-/dev/null}"
case "$*" in
    *is-active*) exit 3 ;;
    *is-enabled*) echo disabled; exit 1 ;;
esac
exit 0
SC
printf '#!/usr/bin/env bash\nexit 0\n' > "$FAKEBIN/claude"
chmod +x "$FAKEBIN"/*

new_host() {   # <dir>：一个空的 git 仓库当 host project
    git init -q -b main "$1"
    git -C "$1" -c user.email=t@example.invalid -c user.name=t commit -q --allow-empty -m init
}
run_setup() {   # <home> <host>
    printf 'n\n' | env -u CAVIL_SKILL_LINK -u CAVIL_DEPLOY_ROOT -u CAVIL_DEPLOY_CONF -u CODING_AGENT_CONFIG \
        -u CODING_AGENT_RELEASE_ROOT -u WORKER_AGENT HOME="$1" PATH="${EXTRA_BIN:+$EXTRA_BIN:}$FAKEBIN:$PATH" SYSTEMCTL_LOG="$1/systemctl.log" \
        bash "${3:-$SRC}/setup.sh" "$2" >"$1/setup.out" 2>&1
}

echo "【5】在临时 HOME 里新装一次：路径、后台任务名、技能名都是新的"
H1="$TMP/h1"; HOST1="$TMP/projects/widget"; mkdir -p "$H1" "$TMP/projects"; new_host "$HOST1"
run_setup "$H1" "$HOST1"; rc=$?
chk "setup.sh 退出码" "$rc" "0"
[ "$rc" = 0 ] || tail -20 "$H1/setup.out"
SYS="$H1/.config/systemd/user"
chk "技能入口在新名字下且指向受管 release" \
    "$(case "$(readlink -f "$H1/.agents/skills/cavil-loop")" in "$H1/.agents/releases/cavil-loop/releases/"*) echo ok ;; esac)" "ok"
chk "后台环境文件在 ~/.config/cavil-loop/" "$([ -f "$H1/.config/cavil-loop/widget.conf" ] && echo yes)" "yes"
chk "环境文件指向项目里的 cavil-loop.config" \
    "$(grep -c "^CODING_AGENT_CONFIG=$HOST1/cavil-loop.config$" "$H1/.config/cavil-loop/widget.conf")" "1"
chk "项目根目录生成的是 cavil-loop.config" "$([ -f "$HOST1/cavil-loop.config" ] && echo yes)" "yes"
chk "状态目录在 ~/.local/state/cavil-loop/<项目>/" \
    "$(grep -c "^STATE_DIR=\"$H1/.local/state/cavil-loop/widget\"$" "$HOST1/cavil-loop.config")" "1"
chk "初始状态写进了新状态目录" "$([ -f "$H1/.local/state/cavil-loop/widget/state.json" ] && echo yes)" "yes"
chk "本地配置被项目的忽略规则盖住" \
    "$(git -C "$HOST1" check-ignore -q cavil-loop.config && echo ignored)" "ignored"
for u in cavil-loop-poll@.service cavil-loop-poll@.timer 'app-cavil\x2dloop\x2dpoll.slice' \
         cavil-loop-preview@.socket cavil-loop-preview@.service cavil-loop-preview-app@.service; do
    chk "装了 $u（指向新技能入口，目标存在）" \
        "$([ "$(readlink "$SYS/$u")" = "$H1/.agents/skills/cavil-loop/systemd/$u" ] && [ -f "$SYS/$u" ] && echo ok)" "ok"
done
chk "轮询间隔 drop-in 用新任务名" "$([ -f "$SYS/cavil-loop-poll@widget.timer.d/interval.conf" ] && echo yes)" "yes"
chk "启动提示用的是新任务名" "$(grep -c 'enable --now cavil-loop-poll@widget.timer' "$H1/setup.out")" "1"
leftovers() {   # <home> <host>：列出新装后仍带旧名字的东西（空 = 干净）
    local home="$1" host="$2" sys="$1/.config/systemd/user" u
    { find "$home" "$host" -path "$home/.agents/releases" -prune -o -name '*coding-agent*' -print
      grep -rlE 'coding-agent-work-loop|coding-agent-poll|coding-agent\.config' \
          "$home/.config/cavil-loop" "$sys"/*.d 2>/dev/null
      for u in "$sys"/*; do [ -f "$u" ] && grep -v '^[[:space:]]*#' "$u" | grep -qE 'coding-agent|coding\\x2dagent' && echo "$u"; done
      grep -sE '^(STATE_DIR|PROJECT_ROOT|WORKTREE_BASE)=' "$host"/*.config | grep coding-agent
      grep -s 'coding-agent' "$host/.gitignore"
    } 2>/dev/null | sort -u
}
leftover=$(leftovers "$H1" "$HOST1")
chk "新装后没有任何旧名字残留（文件名 / 环境文件 / 单元正文 / 关键配置行）" "$leftover" ""

# 负对照：改名前的 setup.sh 新装一次，同一个检测必须报出残留——否则上面那条「干净」
# 证明不了任何事。
OLD_CODE="$TMP/code-old"; mkdir -p "$OLD_CODE"
if git -C "$REPO_DIR" archive "$BASE_COMMIT" | tar -x -C "$OLD_CODE" 2>/dev/null; then
    OLD_SRC="$TMP/skill-src-old"; OLD_REMOTE="$TMP/skill-remote-old.git"
    git init -q --bare "$OLD_REMOTE"; cp -r "$OLD_CODE" "$OLD_SRC"
    git -C "$OLD_SRC" init -q -b main
    git -C "$OLD_SRC" add -A >/dev/null
    git -C "$OLD_SRC" -c user.email=t@example.invalid -c user.name=t commit -qm base
    git -C "$OLD_SRC" remote add origin "$OLD_REMOTE"; git -C "$OLD_SRC" push -q -u origin main 2>/dev/null
    H0="$TMP/h0"; HOST0="$TMP/projects0/widget"; mkdir -p "$H0" "$TMP/projects0"; new_host "$HOST0"
    run_setup "$H0" "$HOST0" "$OLD_SRC"
    chk "负对照：改名前的 setup.sh 新装会被检测出旧名字" "$([ -n "$(leftovers "$H0" "$HOST0")" ] && echo caught)" "caught"
else
    echo "  ⚠️ 取不到改名前的提交 $BASE_COMMIT（浅克隆？），跳过负对照"
fi

legacy_fixture() {   # <home> <host>：改名前 setup.sh 留下的那两样——环境文件和项目里的旧名配置
    mkdir -p "$1/.config/coding-agent-work-loop" "$(dirname "$2")"; new_host "$2"
    printf 'PROJECT_ROOT=%s\nCODING_AGENT_CONFIG=%s/coding-agent.config\nPATH=/usr/bin:/bin\n' "$2" "$2" \
        > "$1/.config/coding-agent-work-loop/widget.conf"
    sed -e "s|^REPO=.*|REPO=\"acme/widget\"|" -e "s|^PROJECT_ROOT=.*|PROJECT_ROOT=\"$2\"|" \
        -e "s|^STATE_DIR=.*|STATE_DIR=\"$1/.local/state/coding-agent-poll/widget\"|" \
        -e "s|^TMUX_PREFIX=.*|TMUX_PREFIX=\"widgetns\"|" \
        "$REPO_DIR/cavil-loop.config.example" > "$2/coding-agent.config"
    printf 'coding-agent.config\n' > "$2/.gitignore"
}

echo "【6】对改名前装好的项目重跑 setup（项目空闲）：先迁到新名字，再按新安装走"
H2="$TMP/h2"; HOST2="$TMP/projects2/widget"; legacy_fixture "$H2" "$HOST2"
# 已经跑了一阵子的旧安装：有已读评论记录、worker 记录、会话登记。假 GitHub 上现在没有打开的条目，
# 所以 setup 要是又做一遍初始化，这些就会被冲成空表。
OLDSD2="$H2/.local/state/coding-agent-poll/widget"
mkdir -p "$OLDSD2/agent-sessions"
printf '%s\n' '{"seen_comments":{"12":5000},"seen_issue_comments":{"7":99},"seen_review_comments":{},"seen_reviews":{},"worker_models":{"7":"fable"},"split_rollups":{"3":2}}' > "$OLDSD2/state.json"
printf 'uuid-7\n' > "$OLDSD2/agent-sessions/7.claude.worker"
cp -p "$OLDSD2/state.json" "$TMP/h2-state.orig"
run_setup "$H2" "$HOST2"; rc=$?
chk "setup.sh 退出码" "$rc" "0"
[ "$rc" = 0 ] || tail -20 "$H2/setup.out"
SYS2="$H2/.config/systemd/user"
chk "setup 说迁了" "$(grep -c '已迁移' "$H2/setup.out")" "1"
chk "环境文件搬到 ~/.config/cavil-loop/，旧的改名留底" \
    "$([ -f "$H2/.config/cavil-loop/widget.conf" ] && ls "$H2/.config/coding-agent-work-loop" | grep -c '^widget\.conf\.migrated-')" "1"
chk "项目里仍是旧名配置文件，没多出 cavil-loop.config" \
    "$([ -e "$HOST2/cavil-loop.config" ] && echo yes || echo no)/$([ -f "$HOST2/coding-agent.config" ] && echo yes)" "no/yes"
chk "项目配置的状态目录改到新位置" \
    "$(grep -c "^STATE_DIR=\"$H2/.local/state/cavil-loop/widget\"$" "$HOST2/coding-agent.config")" "1"
chk "已有状态原样搬到新状态目录、没被重新初始化（逐字节一致）" \
    "$(cmp -s "$H2/.local/state/cavil-loop/widget/state.json" "$TMP/h2-state.orig" && echo same)" "same"
chk "会话登记还在" "$(cat "$H2/.local/state/cavil-loop/widget/agent-sessions/7.claude.worker" 2>/dev/null)" "uuid-7"
chk "setup 说明保留了已有状态" "$(grep -c '已存在，保留原样' "$H2/setup.out")" "1"
run_setup "$H2" "$HOST2"; rc=$?
chk "迁完后再跑一次 setup：退出 0，状态仍逐字节一致" \
    "$rc|$(cmp -s "$H2/.local/state/cavil-loop/widget/state.json" "$TMP/h2-state.orig" && echo same)" "0|same"
chk "旧状态目录不在了" "$([ -e "$H2/.local/state/coding-agent-poll/widget" ] && echo yes || echo no)" "no"
for u in cavil-loop-poll@.service cavil-loop-poll@.timer 'app-cavil\x2dloop\x2dpoll.slice'; do
    chk "装了 $u（指向新技能入口，目标存在）" \
        "$([ "$(readlink "$SYS2/$u")" = "$H2/.agents/skills/cavil-loop/systemd/$u" ] && [ -f "$SYS2/$u" ] && echo ok)" "ok"
done
chk "没有装旧轮询单元" "$(ls "$SYS2" 2>/dev/null | grep -c '^coding-agent-')" "0"
chk "drop-in 写在新任务名下" "$([ -f "$SYS2/cavil-loop-poll@widget.timer.d/interval.conf" ] && echo yes)" "yes"
chk "新技能入口指向受管 release" \
    "$(case "$(readlink -f "$H2/.agents/skills/cavil-loop")" in "$H2/.agents/releases/cavil-loop/releases/"*) echo ok ;; esac)" "ok"
chk "旧技能入口删了（本机已没有旧项目）" \
    "$([ -e "$H2/.agents/skills/coding-agent-work-loop" ] || [ -L "$H2/.agents/skills/coding-agent-work-loop" ] && echo yes || echo no)" "no"
chk "忽略规则没被重复追加" "$(grep -c 'config' "$HOST2/.gitignore")" "1"
chk "启动提示用的是新任务名" "$(grep -c 'enable --now cavil-loop-poll@widget.timer' "$H2/setup.out")" "1"

echo "【6b】同样的旧安装，但项目有 worker 在跑：这次不迁，沿用旧名字，不另装一套新任务"
H3="$TMP/h3"; HOST3="$TMP/projects3/widget"; legacy_fixture "$H3" "$HOST3"
BUSYBIN="$TMP/busybin"; mkdir -p "$BUSYBIN"
printf '#!/usr/bin/env bash\ncase "$1" in list-sessions|ls) echo widgetns-issue5 ;; esac\n' > "$BUSYBIN/tmux"; chmod +x "$BUSYBIN/tmux"
EXTRA_BIN="$BUSYBIN" run_setup "$H3" "$HOST3"; rc=$?
chk "setup.sh 退出码" "$rc" "0"
[ "$rc" = 0 ] || tail -20 "$H3/setup.out"
SYS3="$H3/.config/systemd/user"
chk "setup 说这次不迁" "$(grep -c '这次不迁' "$H3/setup.out")" "1"
chk "没有新建 ~/.config/cavil-loop/widget.conf"  "$([ -e "$H3/.config/cavil-loop/widget.conf" ] && echo yes || echo no)" "no"
chk "旧环境文件原地未动" "$([ -f "$H3/.config/coding-agent-work-loop/widget.conf" ] && echo yes)" "yes"
chk "项目里没有多出 cavil-loop.config"           "$([ -e "$HOST3/cavil-loop.config" ] && echo yes || echo no)" "no"
chk "没装 cavil-loop-poll@ 单元"                "$(ls "$SYS3" 2>/dev/null | grep -c '^cavil-loop-')" "0"
chk "旧轮询单元装好，指向旧技能入口" \
    "$([ "$(readlink "$SYS3/coding-agent-poll@.service")" = "$H3/.agents/skills/coding-agent-work-loop/systemd/coding-agent-poll@.service" ] && [ -f "$SYS3/coding-agent-poll@.service" ] && echo ok)" "ok"
chk "drop-in 写在旧任务名下" "$([ -f "$SYS3/coding-agent-poll@widget.timer.d/interval.conf" ] && echo yes)" "yes"
chk "旧技能入口指向受管 release" \
    "$(case "$(readlink -f "$H3/.agents/skills/coding-agent-work-loop")" in "$H3/.agents/releases/cavil-loop/releases/"*) echo ok ;; esac)" "ok"
chk "没有建新技能入口" "$([ -e "$H3/.agents/skills/cavil-loop" ] || [ -L "$H3/.agents/skills/cavil-loop" ] && echo yes || echo no)" "no"
chk "状态仍写在旧状态目录" "$([ -f "$H3/.local/state/coding-agent-poll/widget/state.json" ] && echo yes)" "yes"
chk "启动提示用的是旧任务名" "$(grep -c 'enable --now coding-agent-poll@widget.timer' "$H3/setup.out")" "1"

echo "【7】旧布局的假安装跑一轮轮询：新代码与改名前的代码结果一致"
NEW_CODE="$SRC"
if [ ! -f "$OLD_CODE/scripts/agent-poll.sh" ]; then
    echo "  ⚠️ 取不到改名前的提交 $BASE_COMMIT（浅克隆？），跳过本组"
else
    legacy_round() {   # <code> <workdir> → 在 workdir 下留下 gh.log / files.txt / state.json
        local code="$1" w="$2" home="$2/home" host="$2/project"
        mkdir -p "$home/.config/coding-agent-work-loop" "$home/.local/state/coding-agent-poll/legacy" \
                 "$host/.agents/skills/coding-agent-work-loop/prompts"
        new_host "$host"
        printf 'LEGACY-EXTRA\n' > "$host/.agents/skills/coding-agent-work-loop/prompts/new-issue.extra.md"
        cat > "$host/coding-agent.config" <<CONF
REPO="acme/widget"
PROJECT_ROOT="$host"
WORKTREE_BASE="$w/wt"
STATE_DIR="$home/.local/state/coding-agent-poll/legacy"
TMUX_PREFIX="namestest"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
LABEL_AGENT_DOING="doing/agent"
POST_MERGE_RETROSPECTIVE=false
CONF
        printf 'PROJECT_ROOT=%s\nCODING_AGENT_CONFIG=%s/coding-agent.config\n' "$host" "$host" \
            > "$home/.config/coding-agent-work-loop/legacy.conf"
        printf '%s\n' '[[{"number":7,"updated_at":"2026-01-01T00:00:00Z","title":"waiting","labels":[{"name":"pending/human"}]}]]' \
            > "$w/issues.json"
        ( set -a; . "$home/.config/coding-agent-work-loop/legacy.conf"; set +a
          env -u CAVIL_SKILL_LINK -u CAVIL_DEPLOY_ROOT -u CODING_AGENT_RELEASE_ROOT HOME="$home" \
              PATH="$FAKEBIN:$PATH" GH_LOG="$w/gh.log" SNAP_ISSUES="$w/issues.json" \
              CODING_AGENT_CONFIG="$CODING_AGENT_CONFIG" PROJECT_ROOT="$PROJECT_ROOT" \
              timeout 60 bash "$code/scripts/agent-poll.sh" >/dev/null 2>&1 )
        echo $? > "$w/rc"
        # 每个 tick 目录名带 pid / 时间，只比稳定的那部分
        (cd "$home" && find . -type f -o -type d | grep -vE 'tick|\.lock$|/sessions' | sort) > "$w/files.txt"
        jq -S . "$home/.local/state/coding-agent-poll/legacy/state.json" > "$w/state.json" 2>/dev/null || echo none > "$w/state.json"
        sort "$w/gh.log" 2>/dev/null > "$w/gh.sorted" || : > "$w/gh.sorted"
        # 同一个工作区，派工时会拼出的指令里有没有项目自带的那段
        ( cd "$host" && env -u CODING_AGENT_RELEASE_ROOT HOME="$home" \
              CODING_AGENT_CONFIG="$host/coding-agent.config" bash -c '
              exec 8>&2; source "$1/scripts/_lib.sh"; exec 2>&8 8>&-; SKILL_DIR="$1"
              grep -c LEGACY-EXTRA "$(compose_prompt_template new-issue)"' _ "$code" ) > "$w/extra.txt" 2>/dev/null
    }
    mkdir -p "$TMP/round-old" "$TMP/round-new"
    legacy_round "$OLD_CODE" "$TMP/round-old"
    legacy_round "$NEW_CODE" "$TMP/round-new"
    chk "改名前的代码这一轮正常结束（对照本身有效）" "$(cat "$TMP/round-old/rc")" "0"
    chk "新代码这一轮正常结束"                       "$(cat "$TMP/round-new/rc")" "0"
    chk "对照确实打了 GitHub（不是空跑）" "$([ -s "$TMP/round-old/gh.sorted" ] && echo yes)" "yes"
    chk "打 GitHub 的调用一模一样" "$(diff "$TMP/round-old/gh.sorted" "$TMP/round-new/gh.sorted" >/dev/null && echo same || diff "$TMP/round-old/gh.sorted" "$TMP/round-new/gh.sorted" | head -5)" "same"
    # 改名之后才加的字段（如 #86 的 pr_conflict）旧代码不会写：只比旧代码认识的字段，
    # 多出来的字段必须是空的初始值 {}——有内容就说明这一轮新代码多做了事，照样算不一致。
    chk "已读记录（state.json）一模一样" "$(jq -rS --slurpfile o "$TMP/round-old/state.json" \
        '. as $n | ($o[0] | keys) as $k
         | if (with_entries(select(.key as $x | $k | index($x))) == $o[0])
              and ([with_entries(select(.key as $x | $k | index($x) | not))[]] | all(. == {}))
           then "same" else "differ" end' "$TMP/round-new/state.json" 2>/dev/null || echo differ)" "same"
    chk "在 HOME 下落盘的文件一模一样（没多建新名字目录）" \
        "$(diff "$TMP/round-old/files.txt" "$TMP/round-new/files.txt" >/dev/null && echo same || diff "$TMP/round-old/files.txt" "$TMP/round-new/files.txt" | head -5)" "same"
    chk "状态仍写在旧状态目录" "$(grep -c '^./.local/state/coding-agent-poll/legacy/state.json$' "$TMP/round-new/files.txt")" "1"
    chk "项目旧覆盖目录里的指令照样拼进派工指令（旧代码）" "$(cat "$TMP/round-old/extra.txt")" "1"
    chk "项目旧覆盖目录里的指令照样拼进派工指令（新代码）" "$(cat "$TMP/round-new/extra.txt")" "1"
fi

echo
echo "通过 $pass，失败 $fail"
[ "$fail" = 0 ]
