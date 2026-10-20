#!/usr/bin/env bash
# 改名过渡期新旧预览并存（GigleAI/cavil-loop#70，PR #72 第 1 轮复审）的行为守卫。
#
# 跑法：bash tests/preview-rename-coexist.test.sh
# 隔离 HOME + 假 systemctl（记下每次调用），跑**真实的** preview-serve / preview-unserve /
# preview-run / preview-wait。不碰真实 systemd / tailscale。
#
# 为什么要有这个文件：旧项目注册的预览登记在旧目录、跑在旧单元上。同一台机器后来接入了
# 一个新项目，新单元也装上了——这时旧预览**仍然活着**。按「整台机器装了哪套」来挑目录，
# 旧预览就从列表、注销、认主里一起消失，而且都不报错：
#   · 列表说「没有已注册的 preview」；
#   · 注销说「没有登记，不动」并返回成功，旧单元和旧登记都留着；
#   · 另一个项目拿走同一个端口，新旧目录各有一个主人；
#   · 两份同端口登记时，旧单元启动读到新登记里别的项目的命令。
# 每条断言都拿上一版实现（205d252）跑一遍负对照，必须变红。
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
BUGGY_COMMIT="205d252"   # 第 1 轮复审打回的那版

SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT

pass=0; fail=0
chk() {
    if [ "$2" = "$3" ]; then echo "  ✅ $1"; pass=$((pass+1))
    else echo "  ❌ $1 (期望 [$3]，实得 [$2])"; fail=$((fail+1)); fi
}

# scenario <代码目录> <工作目录>：跑完整个跨轮场景，每一步的结果写成一行「名字=值」。
scenario() {
    local code="$1" w="$2"
    local home="$w/home" bin="$w/bin" calls="$w/calls"
    local units="$home/.config/systemd/user"
    local old_dir="$home/.config/coding-agent-work-loop/preview" new_dir="$home/.config/cavil-loop/preview"
    mkdir -p "$units" "$bin" "$w/wt/issue-40" "$w/wt/issue-41" "$w/wt/issue-50" "$w/project"
    cat > "$bin/systemctl" <<SH
#!/usr/bin/env bash
case "\$*" in *is-active*) echo inactive; exit 3;; esac
echo "\$*" >> "$calls"
SH
    chmod +x "$bin/systemctl"
    local p
    for p in widget other; do
        cat > "$w/$p.config" <<CONF
REPO="acme/$p"
PROJECT_ROOT="$w/project"
WORKTREE_BASE="$w/wt"
STATE_DIR="$w/state-$p"
TMUX_PREFIX="$p"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
PREVIEW_EXEC="echo $p-app"
PREVIEW_PORT_BASE=4000
CONF
        mkdir -p "$w/state-$p"
    done
    run() {   # run <项目> <脚本> [参数…]
        local proj="$1" script="$2"; shift 2
        env -u CODING_AGENT_RELEASE_ROOT HOME="$home" PATH="$bin:$PATH" \
            CODING_AGENT_CONFIG="$w/$proj.config" bash "$code/scripts/$script" "$@" 2>&1
    }

    # ① 改名前的机器：只装了旧预览单元，widget 注册 #40（:4040）
    : > "$units/coding-agent-preview@.socket"
    run widget preview-serve.sh 40 >/dev/null
    echo "registered_old=$([ -f "$old_dir/4040.conf" ] && echo yes || echo no)"
    # ② 同一台机器又接入了新项目：新预览单元也装上了
    : > "$units/cavil-loop-preview@.socket"
    : > "$calls"
    # ③ 旧项目查自己的预览
    echo "list_sees_old=$(run widget preview-serve.sh --list | grep -c 'issue #40 ')"
    # ④ 另一个项目来抢同一个端口
    run other preview-serve.sh 40 >/dev/null; echo "steal_rc=$?"
    echo "owners_4040=$(cat "$old_dir/4040.conf" "$new_dir/4040.conf" 2>/dev/null | grep -c '^PREVIEW_PROJECT=')"
    # ⑤ 旧项目重新注册（比如 --restart）：留在旧单元上，不被切到新目录
    : > "$calls"
    run widget preview-serve.sh 40 --restart >/dev/null
    echo "reregister_stays_old=$([ -f "$old_dir/4040.conf" ] && [ ! -f "$new_dir/4040.conf" ] && echo yes || echo no)"
    echo "reregister_old_units=$(grep -c 'start coding-agent-preview@4040.socket' "$calls")"
    # ⑥ 全新注册走新单元
    : > "$calls"
    run widget preview-serve.sh 41 >/dev/null
    echo "fresh_new=$([ -f "$new_dir/4041.conf" ] && grep -c 'start cavil-loop-preview@4041.socket' "$calls" || echo 0)"
    # ⑦ 注销旧预览：停的是旧单元，旧登记删掉
    : > "$calls"
    run widget preview-unserve.sh --issue 40 >/dev/null; echo "unserve_rc=$?"
    echo "unserve_old_stops=$(grep -c '^--user stop coding-agent-preview' "$calls")"
    echo "unserve_old_gone=$([ -f "$old_dir/4040.conf" ] && echo no || echo yes)"
    # ⑧ 两份同端口登记（上一版留下的现场）：每个单元读自己绑定的那份
    printf 'PREVIEW_PROJECT="widget"\nPREVIEW_ISSUE="50"\nPREVIEW_PORT="4050"\nPREVIEW_BACKEND_PORT="1"\nPREVIEW_WORKTREE="%s"\nPREVIEW_EXEC="echo OLD-APP"\nPREVIEW_READY_TIMEOUT=0\n' "$w/wt/issue-50" > "$old_dir/4050.conf"
    printf 'PREVIEW_PROJECT="other"\nPREVIEW_ISSUE="50"\nPREVIEW_PORT="4050"\nPREVIEW_BACKEND_PORT="2"\nPREVIEW_WORKTREE="%s"\nPREVIEW_EXEC="echo NEW-APP"\nPREVIEW_READY_TIMEOUT=0\n' "$w/wt/issue-50" > "$new_dir/4050.conf"
    # 旧单元的调用形状：只传端口（见 systemd/coding-agent-preview-app@.service）
    echo "old_unit_run=$(HOME="$home" bash "$code/scripts/preview-run.sh" 4050 2>&1 | tail -1)"
    echo "old_unit_wait=$(HOME="$home" bash "$code/scripts/preview-wait.sh" 4050 2>&1 | grep -o '127.0.0.1:[0-9]*' | head -1)"
    # 新单元的调用形状：照 systemd/cavil-loop-preview-app@.service 原样展开
    local exec_line wait_line
    exec_line="$(sed -n 's/^ExecStart=\/usr\/bin\/env bash %h\/.agents\/skills\/cavil-loop\/scripts\/preview-run.sh //p' "$REPO_DIR/systemd/cavil-loop-preview-app@.service")"
    wait_line="$(sed -n 's/^ExecStartPost=\/usr\/bin\/env bash %h\/.agents\/skills\/cavil-loop\/scripts\/preview-wait.sh //p' "$REPO_DIR/systemd/cavil-loop-preview-app@.service")"
    exec_line="${exec_line//%i/4050}"; exec_line="${exec_line//%h/$home}"
    wait_line="${wait_line//%i/4050}"; wait_line="${wait_line//%h/$home}"
    # shellcheck disable=SC2086
    echo "new_unit_run=$(HOME="$home" bash "$code/scripts/preview-run.sh" $exec_line 2>&1 | tail -1)"
    # shellcheck disable=SC2086
    echo "new_unit_wait=$(HOME="$home" bash "$code/scripts/preview-wait.sh" $wait_line 2>&1 | grep -o '127.0.0.1:[0-9]*' | head -1)"
    # ⑨ 新旧共用同一把端口锁
    echo "lock_dir=$(HOME="$home" bash -c 'source "$1/scripts/_names.sh" 2>/dev/null; declare -f cavil_preview_lock_dir >/dev/null && cavil_preview_lock_dir || echo none' _ "$code" | sed "s|$home|~|")"
}

expect() {   # expect <结果文件> <键>
    sed -n "s/^$2=//p" "$1" | head -1
}

echo "【新代码】旧预览在先、新单元在后"
mkdir -p "$SANDBOX/new"
scenario "$REPO_DIR" "$SANDBOX/new" > "$SANDBOX/new.out"
R="$SANDBOX/new.out"
chk "① 旧机器上注册进旧目录"                         "$(expect "$R" registered_old)" "yes"
chk "③ 装了新单元后，旧项目的列表仍看得到旧预览"     "$(expect "$R" list_sees_old)" "1"
chk "④ 另一个项目抢同一端口被拒"                     "$(expect "$R" steal_rc)" "2"
chk "④ 端口仍只有一个主人"                           "$(expect "$R" owners_4040)" "1"
chk "⑤ 旧预览重注册留在旧目录"                       "$(expect "$R" reregister_stays_old)" "yes"
chk "⑤ 重注册启动的是旧单元"                         "$(expect "$R" reregister_old_units)" "1"
chk "⑥ 全新注册走新目录 + 新单元"                     "$(expect "$R" fresh_new)" "1"
chk "⑦ 注销旧预览成功"                               "$(expect "$R" unserve_rc)" "0"
chk "⑦ 停的是旧单元三件套"                           "$(expect "$R" unserve_old_stops)" "3"
chk "⑦ 旧登记删掉了"                                 "$(expect "$R" unserve_old_gone)" "yes"
chk "⑧ 旧单元启动读旧登记（自己项目的命令）"         "$(expect "$R" old_unit_run)" "OLD-APP"
chk "⑧ 旧单元就绪检查读旧登记"                       "$(expect "$R" old_unit_wait)" "127.0.0.1:1"
chk "⑧ 新单元启动读新登记"                           "$(expect "$R" new_unit_run)" "NEW-APP"
chk "⑧ 新单元就绪检查读新登记"                       "$(expect "$R" new_unit_wait)" "127.0.0.1:2"
chk "⑨ 有旧单元的机器上，新旧共用旧目录那把锁"       "$(expect "$R" lock_dir)" "~/.config/coding-agent-work-loop/preview"

echo "【新代码】纯新装机器：锁在新目录，不造旧名字目录"
NH="$SANDBOX/fresh"; mkdir -p "$NH/.config/systemd/user"; : > "$NH/.config/systemd/user/cavil-loop-preview@.socket"
chk "锁在新目录" "$(HOME="$NH" bash -c 'source "$1/scripts/_names.sh"; cavil_preview_lock_dir' _ "$REPO_DIR" | sed "s|$NH|~|")" "~/.config/cavil-loop/preview"
chk "没有旧名字目录" "$([ -e "$NH/.config/coding-agent-work-loop" ] && echo yes || echo no)" "no"

echo "【负对照】上一版实现（$BUGGY_COMMIT）跑同一场景，复审指出的几条必须变红"
OLD="$SANDBOX/code-buggy"; mkdir -p "$OLD"
if git -C "$REPO_DIR" archive "$BUGGY_COMMIT" 2>/dev/null | tar -x -C "$OLD" 2>/dev/null; then
    mkdir -p "$SANDBOX/buggy"
    scenario "$OLD" "$SANDBOX/buggy" > "$SANDBOX/buggy.out"
    B="$SANDBOX/buggy.out"
    for key_want in "list_sees_old=1" "steal_rc=2" "owners_4040=1" "reregister_stays_old=yes" \
                    "unserve_old_stops=3" "unserve_old_gone=yes" "old_unit_run=OLD-APP" "old_unit_wait=127.0.0.1:1"; do
        key="${key_want%%=*}"; want="${key_want#*=}"
        chk "上一版在 $key 上变红（实得 $(expect "$B" "$key")）" \
            "$([ "$(expect "$B" "$key")" != "$want" ] && echo red || echo green)" "red"
    done
else
    echo "  ⚠️ 取不到 $BUGGY_COMMIT（浅克隆？），跳过负对照"
fi

echo
echo "通过 $pass，失败 $fail"
[ "$fail" = 0 ]
