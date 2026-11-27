#!/usr/bin/env bash
# kind: e2e
# claude 的 bypass 模式首次确认框（GitHub#744）。
#
# 跑法：bash tests/claude-bypass-launch.test.sh   （约 40 秒）
# 依赖：tmux、git、jq、python3。不碰网络、不碰本机真实的 claude 配置：假 claude / 假 gh，临时 HOME；
# 真 driver、真 _lib.sh、真 default_inject_prompt、真 agent-poll.sh；最后一组用真 tmux（本次运行自己的服务）。
#
# 现场：项目带 --dangerously-skip-permissions 起 claude，账号没接受过 bypass 模式 → 停在确认框上；
# 半小时后卡住检测送催促，先按 Esc（= 取消 = claude 退出），窗格没了还记「已发催促」；self-heal
# 重派又停在框上，会话活着的每一轮都把失败计数清零，永远「第 1/3 次」。这里断言：
#   1. 启动参数让 claude 进 bypass 模式时，启动命令最后附一份「已接受」的临时设置（600 文件，项目自己
#      最后一个 --settings 的内容合进去）；不进 bypass 时命令和改版前逐字节一致、不写文件；拿不准时不附、
#      日志写原因。新建、续接、续接前探测模型三处用同一份
#   2. 认框：真机截屏，bypass 框 / 目录信任框分得开；正常对话里引用整段警告不算
#   3. 往会话里送字：屏幕是启动确认框 → 一个键都不按、返回失败；窗格不在 → 返回失败、不按键；
#      正常输入框 → 照常送进去（对照）
#   4. self-heal 看到会话活着：只有会话记录里出现本次启动的标记才清零失败计数；旧记录、没有记录、
#      读不了、启动记录读不懂都不清零；没有启动记录（不支持的 agent、旧会话）照旧清零
#   5. 真 agent-poll.sh 一轮：会话活着但还没开工 → 计数不清零；记录里出现本次标记后再跑一轮 → 清零
set -uo pipefail
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"
# 本次运行独用一个 tmux 服务，跑完收掉（GitHub#647）。必须在建任何东西之前载入。
# shellcheck source=lib/tmux-sandbox.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/tmux-sandbox.sh"
tmux_sandbox_start

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
FIX="$TEST_DIR/fixtures/trust-dialog"
if ! command -v tmux > /dev/null 2>&1; then
    echo "⏭ 本机没有 tmux，整份跳过"; exit 0
fi
TMP="$(mktemp -d)" || exit 1
tmux_sandbox_own_dir "$TMP"
TMP="$(cd "$TMP" && pwd -P)"

pass=0; fail=0
chk() { if [ "$2" = "$3" ]; then echo "  ✅ $1"; pass=$((pass+1)); else echo "  ❌ $1 (期望 [$3]，实得 [$2])"; fail=$((fail+1)); fi; }
has() { case "$2" in *"$3"*) echo "  ✅ $1"; pass=$((pass+1)) ;; *) echo "  ❌ $1 (找不到 [$3]；实得 [${2:0:600}])"; fail=$((fail+1)) ;; esac; }
lacks() { case "$2" in *"$3"*) echo "  ❌ $1 (不该出现 [$3])"; fail=$((fail+1)) ;; *) echo "  ✅ $1"; pass=$((pass+1)) ;; esac; }

H="$TMP/home"; WT="$TMP/wt/issue-7"; ST="$TMP/state"
mkdir -p "$H" "$WT" "$ST/prompts" "$TMP/bin" "$TMP/project"
chmod 700 "$ST/prompts"
cat > "$TMP/config" <<CONF
REPO="example/bypass"
PROJECT_ROOT="$TMP/project"
WORKTREE_BASE="$TMP/wt"
STATE_DIR="$ST"
TMUX_PREFIX="bp"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
WORKER_AGENT="claude"
CONF
# 假 claude：探测模型时（-p）记下参数、吐一行 init；其余情况什么都不做
cat > "$TMP/bin/claude" <<'SH'
#!/usr/bin/env bash
printf 'arg=%s\n' "$@" > "${FAKE_LOG:-/dev/null}"
case " $* " in *" -p "*) echo '{"type":"system","subtype":"init","model":"claude-opus-5-5"}'; exec sleep 30 ;; esac
exit 0
SH
chmod +x "$TMP/bin/claude"

# 在独立 shell 里载入真 _lib.sh（driver = claude），跑 <命令…>；extra flags 由 FLAGS 给
lib() {
    env -u ANTHROPIC_MODEL -u CLAUDE_CONFIG_DIR HOME="$H" PATH="$TMP/bin:$PATH" CODING_AGENT_CONFIG="$TMP/config" \
        CLAUDE_EXTRA_FLAGS="${FLAGS:-}" FAKE_LOG="$TMP/probe.log" "${EXTRA_ENV[@]}" \
        bash -c 'source "$1/scripts/_lib.sh" 2>/dev/null; shift; set +e; "$@"' _ "$REPO_DIR" "$@"
}
EXTRA_ENV=(DISPATCH_WORKER_MODEL= DISPATCH_WORKER_MODEL_SET=1)
PF="$ST/prompts/7-new.md"
SF="$PF.settings.json"
fresh() { printf '任务\n' > "$PF"; rm -f "$SF" "$ST/poll.log"; }
plog() { cat "$ST/poll.log" 2>/dev/null; }

echo "── 1. 启动参数与临时设置 ──"
FLAGS=""; fresh
cmd="$(lib agent_command_new "$WT" issue7 "$PF")"
chk "不带 bypass：命令和改版前一样（不附 --settings）" "$cmd" "claude -n issue7   \"\$(cat $PF)\""
chk "不带 bypass：不写临时设置文件" "$([ -e "$SF" ] && echo yes || echo no)" no

FLAGS="--dangerously-skip-permissions"; fresh
cmd="$(lib agent_command_new "$WT" issue7 "$PF")"
chk "带 bypass：--settings 接在项目参数后面" "$cmd" "claude -n issue7 --dangerously-skip-permissions --settings $SF  \"\$(cat $PF)\""
chk "带 bypass：临时设置只含「已接受」那一项" "$(jq -cS . "$SF" 2>/dev/null)" '{"skipDangerousModePermissionPrompt":true}'
chk "带 bypass：临时设置文件权限 600" "$(stat -c %a "$SF" 2>/dev/null)" 600
chk "带 bypass：账号的设置文件没出现" "$(ls -A "$H" | tr '\n' ' ')" ""

for f in "--permission-mode bypassPermissions" "--permission-mode=bypassPermissions"; do
    FLAGS="$f"; fresh
    has "$f：也附临时设置" "$(lib agent_command_new "$WT" issue7 "$PF")" "--settings $SF"
done
FLAGS="--permission-mode acceptEdits"; fresh
lacks "--permission-mode acceptEdits：不附" "$(lib agent_command_new "$WT" issue7 "$PF")" "--settings"

merged() { jq -cS . "$SF" 2>/dev/null; }
FLAGS="--dangerously-skip-permissions --settings '{\"model\":\"sonnet\",\"env\":{\"A\":\"1\"}}'"; fresh
lib agent_command_new "$WT" issue7 "$PF" > /dev/null
chk "项目内联 JSON 设置：合进临时设置" "$(merged)" '{"env":{"A":"1"},"model":"sonnet","skipDangerousModePermissionPrompt":true}'
echo '{"statusLine":{"type":"command","command":"echo x"}}' > "$TMP/abs.json"
FLAGS="--settings $TMP/abs.json --dangerously-skip-permissions"; fresh
lib agent_command_new "$WT" issue7 "$PF" > /dev/null
chk "项目设置文件（绝对路径）：合进临时设置" "$(merged)" '{"skipDangerousModePermissionPrompt":true,"statusLine":{"command":"echo x","type":"command"}}'
mkdir -p "$WT/conf"; echo '{"model":"rel"}' > "$WT/conf/s.json"
FLAGS="--dangerously-skip-permissions --settings=conf/s.json"; fresh
lib agent_command_new "$WT" issue7 "$PF" > /dev/null
chk "--settings=相对路径：按 worker 的工作目录解析" "$(merged)" '{"model":"rel","skipDangerousModePermissionPrompt":true}'
FLAGS="--dangerously-skip-permissions --settings $TMP/nonexistent.json --settings '{\"model\":\"last\"}'"; fresh
lib agent_command_new "$WT" issue7 "$PF" > /dev/null
chk "项目写了两个 --settings：只取最后一个（claude 也只读最后一个）" "$(merged)" '{"model":"last","skipDangerousModePermissionPrompt":true}'

FLAGS="--dangerously-skip-permissions --settings $TMP/nonexistent.json"; fresh
cmd="$(lib agent_command_new "$WT" issue7 "$PF")"
lacks "项目设置文件读不了：不附（附了会让项目那份失效）" "$cmd" "--settings $SF"
has "  …日志写明读不了哪个文件" "$(plog)" "读不了项目启动参数里的设置文件 $TMP/nonexistent.json"
echo '[1,2]' > "$TMP/arr.json"
FLAGS="--dangerously-skip-permissions --settings $TMP/arr.json"; fresh
lacks "项目设置不是 JSON 对象：不附" "$(lib agent_command_new "$WT" issue7 "$PF")" "--settings $SF"
has "  …日志写明原因" "$(plog)" "不是 JSON 对象"
chk "  …也不留半截临时文件" "$(ls "$ST/prompts" | grep -c settings)" 0
FLAGS="--dangerously-skip-permissions --append-system-prompt \$HOME"; fresh
lacks "启动参数拆不确定：不附" "$(lib agent_command_new "$WT" issue7 "$PF")" "--settings $SF"
has "  …日志写明判断不了" "$(plog)" "判断不了是否进 bypass 模式"
chmod 500 "$ST/prompts"
FLAGS="--dangerously-skip-permissions"; rm -f "$SF" "$ST/poll.log"
if [ -w "$ST/prompts" ]; then
    echo "  ⏭ 以 root 跑，目录权限挡不住写入，跳过「写不出临时文件」"
else
    lacks "临时设置文件写不出：不附" "$(lib agent_command_new "$WT" issue7 "$PF")" "--settings"
    has "  …日志写明写不出" "$(plog)" "写不出 bypass 临时设置文件"
fi
chmod 700 "$ST/prompts"

FLAGS="--dangerously-skip-permissions --settings '{\"model\":\"m\"}'"; fresh
EXTRA_ENV=(DISPATCH_WORKER_MODEL= DISPATCH_WORKER_MODEL_SET=1 WORKER_SESSION_ID=abc-1)
cmd="$(lib agent_command_resume "$WT" issue7 "$PF")"
EXTRA_ENV=(DISPATCH_WORKER_MODEL= DISPATCH_WORKER_MODEL_SET=1)
has "续接：附同一份临时设置，在项目参数后面" "$cmd" "--settings '{\"model\":\"m\"}' --settings $SF --model claude-opus-5-5"
probe="$(cat "$TMP/probe.log" 2>/dev/null)"
has "续接前探测模型：也带这份临时设置" "$probe" "arg=$SF"
chk "  …而且是探测的最后一个 --settings" "$(grep -A1 -x 'arg=--settings' "$TMP/probe.log" | grep -v -- '^--$' | tail -1)" "arg=$SF"

echo "── 2. 认框：真机截屏 ──"
kind_of() { lib agent_launch_dialog_kind < "$1" || echo none; }
chk "bypass 确认框 → bypass" "$(kind_of "$FIX/claude-bypass-modal.txt")" bypass
chk "目录信任框 → trust" "$(kind_of "$FIX/claude-trust.txt")" trust
chk "正常界面 → 都不是" "$(kind_of "$FIX/claude-normal.txt")" none
{ head -n -6 "$FIX/claude-normal.txt"; sed -n '2,15p' "$FIX/claude-bypass-modal.txt" | sed 's/^/⏺ /'; tail -n 6 "$FIX/claude-normal.txt"; } > "$TMP/prose.txt"
has "  夹具：对话里确实引用了整段警告" "$(tr -s '[:space:]' ' ' < "$TMP/prose.txt")" "WARNING: Claude Code running in Bypass Permissions mode"
chk "对话里引用整段警告 → 都不是（底栏不是最后一行）" "$(kind_of "$TMP/prose.txt")" none
codex_kind="$(env HOME="$H" bash -c 'source "$1/scripts/drivers/_common.sh"; PROJECT_ROOT=/nonexistent source_driver codex >/dev/null 2>&1 || exit 9; agent_launch_dialog_kind < "$2" || echo none' _ "$REPO_DIR" "$FIX/claude-bypass-modal.txt")"
chk "codex 没声明这个框：claude 的 bypass 截屏不算" "$codex_kind" none

echo "── 3. 往会话里送字 ──"
# 假 tmux：capture-pane 输出 $SCREEN（文件不在 = 抓不到，退出 1）；按键 / 粘贴记进 keys.log；
# 按下 Enter 后把画面换成 $AFTER_ENTER（对照组用来模拟「提交了、开始忙」）
mkdir -p "$TMP/injbin"
cat > "$TMP/injbin/tmux" <<'SH'
#!/usr/bin/env bash
case "$1" in
    capture-pane) [ -f "$SCREEN" ] || exit 1; cat "$SCREEN"; exit 0 ;;
    send-keys|paste-buffer|load-buffer)
        [ -f "$SCREEN" ] || { echo "can't find pane: %74" >&2; exit 1; }
        echo "$*" >> "$KEYS"
        if [ "$1" = send-keys ] && [ "${*: -1}" = Enter ] && [ -n "${AFTER_ENTER:-}" ]; then cp "$AFTER_ENTER" "$SCREEN"; fi
        exit 0 ;;
esac
exit 0
SH
chmod +x "$TMP/injbin/tmux"
printf '⏺ 正在处理\n✻ Thinking… (3s · ↓ 1k tokens)\n────\n❯ \n────\n' > "$TMP/busy.txt"
inject() {   # <屏幕文件或 none> [Enter 之后的屏幕] → 输出 rc；按键记录在 $TMP/keys.log
    local screen="$TMP/screen.now"; rm -f "$screen" "$TMP/keys.log"
    [ "$1" = none ] || cp "$1" "$screen"
    printf '催促\n' > "$TMP/nudge.md"
    env HOME="$H" PATH="$TMP/injbin:$PATH" CODING_AGENT_CONFIG="$TMP/config" SCREEN="$screen" KEYS="$TMP/keys.log" \
        AFTER_ENTER="${2:-}" INJECT_STATE_WAIT_SECS=0 \
        bash -c 'source "$1/scripts/_lib.sh" 2>/dev/null; set +e; inject_prompt_logged %74 "$2"; echo "rc=$?"' _ "$REPO_DIR" "$TMP/nudge.md" 2>/dev/null
}
keys() { cat "$TMP/keys.log" 2>/dev/null; }
rm -f "$ST/poll.log"
chk "停在 bypass 确认框：返回失败" "$(inject "$FIX/claude-bypass-modal.txt")" "rc=1"
chk "  …一个键都没按（Esc / 回车都会让 claude 退出）" "$(keys)" ""
has "  …poll.log 写明停在启动确认框上" "$(plog)" "停在启动确认框（bypass）上"
chk "停在目录信任框：返回失败" "$(inject "$FIX/claude-trust.txt")" "rc=1"
chk "  …一个键都没按" "$(keys)" ""
rm -f "$ST/poll.log"
chk "窗格不在：返回失败" "$(inject none)" "rc=1"
chk "  …一个键都没按" "$(keys)" ""
has "  …poll.log 写明抓不到画面" "$(plog)" "抓不到画面"
chk "对照：正常输入框 → 送进去了" "$(inject "$FIX/claude-normal.txt" "$TMP/busy.txt")" "rc=0"
has "  …确实粘贴并按了回车" "$(keys)" "send-keys -t %74 Enter"

echo "── 4. self-heal：会话活着时只凭本次启动的标记清零 ──"
ID=11111111-2222-4333-8444-555555555555; TAG=99999999-8888-4777-8666-555555555555
REC_DIR="$H/.claude/projects/$(printf %s "$WT" | tr -c 'A-Za-z0-9' '-')"; REC="$REC_DIR/$ID.jsonl"
mkdir -p "$REC_DIR" "$ST/selfheal"
msg() { jq -cn --arg t "$1" '{type:"user",message:{role:"user",content:$t}}'; }
setup_heal() {   # 计数 2 + 一份本次启动记录
    echo 2 > "$ST/selfheal/7"
    jq -n --arg cwd "$WT" --arg id "$ID" --arg tag "$TAG" '{agent:"claude",cwd:$cwd,id:$id,tag:$tag}' > "$ST/selfheal/7.launch"
}
count() { cat "$ST/selfheal/7" 2>/dev/null || echo 清零; }
alive() { lib selfheal_alive 7 >/dev/null 2>&1; }
setup_heal; rm -f "$REC"; alive
chk "会话记录还不存在 → 不清零" "$(count)" 2
setup_heal; { msg "上一次的任务 <!-- coding-agent-launch: 00000000-0000-4000-8000-000000000000 -->"; } > "$REC"; alive
chk "只有旧记录（续接卡在框上的样子）→ 不清零" "$(count)" 2
chk "  …启动记录留着，下一轮再查" "$([ -e "$ST/selfheal/7.launch" ] && echo yes || echo no)" yes
setup_heal; { msg "回声：$TAG" | jq -c '.type = "assistant"'; } > "$REC"; alive
chk "标记只出现在 agent 的回复里 → 不清零" "$(count)" 2
setup_heal; { msg "旧"; msg "任务 <!-- coding-agent-launch: $TAG -->"; printf '{"type":"user","mess'; } > "$REC"; alive
chk "记录里有本次标记（最后一行写到一半）→ 清零" "$(count)" 清零
chk "  …启动记录删掉了" "$([ -e "$ST/selfheal/7.launch" ] && echo yes || echo no)" no
setup_heal; jq -cn --arg t "任务 $TAG" '{type:"user",message:{content:[{type:"text",text:$t}]}}' > "$REC"; alive
chk "content 是分段数组 → 同样认得出" "$(count)" 清零
setup_heal; msg "任务 $TAG" > "$REC"; chmod 000 "$REC"
if [ -r "$REC" ]; then echo "  ⏭ 以 root 跑，读权限挡不住，跳过「记录读不了」"
else alive; chk "会话记录读不了 → 不清零" "$(count)" 2; fi
chmod 644 "$REC"
setup_heal; echo '不是 JSON' > "$ST/selfheal/7.launch"; alive
chk "启动记录读不懂 → 不清零" "$(count)" 2
setup_heal; jq '.agent = "codex"' "$ST/selfheal/7.launch" > "$TMP/x" && mv "$TMP/x" "$ST/selfheal/7.launch"; alive
chk "启动记录里的 agent 不支持这项检查 → 照旧清零" "$(count)" 清零
echo 2 > "$ST/selfheal/7"; rm -f "$ST/selfheal/7.launch"; alive
chk "没有启动记录（旧会话 / 已核实过）→ 照旧清零" "$(count)" 清零

echo "  · 起会话后记下本次启动：会话 id + 提示词里最后一个标记"
FLAGS=""; fresh
EXTRA_ENV=(DISPATCH_WORKER_MODEL= DISPATCH_WORKER_MODEL_SET=1 WORKER_SESSION_ID=$ID AGENT_LAUNCH_KIND=new)
lib eval "agent_launch_command '$WT' issue7 '$PF' >/dev/null; selfheal_launch_record 7 '$WT' '$PF'"
EXTRA_ENV=(DISPATCH_WORKER_MODEL= DISPATCH_WORKER_MODEL_SET=1)
ptag="$(grep -o 'coding-agent-launch: [0-9a-f-]*' "$PF" | tail -1 | awk '{print $2}')"
has "  拼命令时给提示词附了标记" "$ptag" "-"
chk "  启动记录 = 这次的 id 和这个标记" "$(jq -c '[.agent, .id, .tag]' "$ST/selfheal/7.launch" 2>/dev/null)" "[\"claude\",\"$ID\",\"$ptag\"]"

echo "── 5. 真 agent-poll.sh：会话活着、还没开工 → 不清零；开工后 → 清零 ──"
POLLS="$TMP/poll"; mkdir -p "$POLLS/gh" "$POLLS/bin" "$POLLS/state/selfheal" "$POLLS/wt/issue-7"
git init -q --bare -b main "$TMP/up.git"
git clone -q "$TMP/up.git" "$POLLS/project" 2>/dev/null
(cd "$POLLS/project" && git -c user.email=t@example.invalid -c user.name=t commit -q --allow-empty -m init && git push -q origin HEAD:main) >/dev/null 2>&1
bash "$TEST_DIR/lib/fake_gh_client.sh" install "$POLLS/bin/gh" python3 "$TEST_DIR/lib/fake_github.py"
printf '#!/usr/bin/env bash\nexit 0\n' > "$POLLS/bin/systemctl"; chmod +x "$POLLS/bin/systemctl"
GD="$POLLS/gh"
echo '{}' > "$GD/events.json"; echo '{}' > "$GD/perms.json"; echo loop-bot > "$GD/me"; echo '{}' > "$GD/comments.json"
jq -n '{"7": {kind:"issue", state:"open", title:"需求", body:"做事", user:{login:"maint"}, updated_at:"2026-01-01T00:00:00Z"}}' > "$GD/items.json"
jq -n '{"7": ["doing/agent"]}' > "$GD/labels.json"
cat > "$POLLS/config" <<CONF
REPO="example/bp"
PROJECT_ROOT="$POLLS/project"
WORKTREE_BASE="$POLLS/wt"
STATE_DIR="$POLLS/state"
TMUX_PREFIX="bp"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
LABEL_PENDING_PR="pending/PR"
LABEL_PENDING_REVIEW="pending/review"
LABEL_AGENT_DOING="doing/agent"
LABEL_DONE="Done"
LABEL_PENDING_BLOCKED=""
LABEL_AUTOPILOT=""
WORKER_AGENT="claude"
POST_MERGE_RETROSPECTIVE=false
PENDING_HUMAN_CONFLICT_CHECK=false
POLL_BACKOFF_LADDER=""
PRICE_AUTO_FETCH=0
GH_TOKEN="fake-token-for-test"
PATH="$POLLS/bin:$TMP/bin:\$PATH"
CONF
chmod 600 "$POLLS/config"
echo '{"cleaned_prs":[],"cleaned_issues":[]}' > "$POLLS/state/state.json"
PWT="$POLLS/wt/issue-7"
PREC_DIR="$H/.claude/projects/$(printf %s "$PWT" | tr -c 'A-Za-z0-9' '-')"; mkdir -p "$PREC_DIR"
msg "上一次的任务" > "$PREC_DIR/$ID.jsonl"
jq -n --arg cwd "$PWT" --arg id "$ID" --arg tag "$TAG" '{agent:"claude",cwd:$cwd,id:$id,tag:$tag}' > "$POLLS/state/selfheal/7.launch"
echo 2 > "$POLLS/state/selfheal/7"
tmux new-session -d -s bp-issue7 -c "$PWT" "sleep 300"
poll_round() {
    (cd "$POLLS/project" && tmux_sandbox_env_i HOME="$H" LANG=C.UTF-8 CODING_AGENT_CONFIG="$POLLS/config" \
        FAKE_GH_LISTS=1 FAKE_GH_REPO=example/bp FAKE_GH_DIR="$GD" \
        timeout 180 bash "$REPO_DIR/scripts/agent-poll.sh") > /dev/null 2>&1
}
poll_round
chk "到达性 · 会话确实活着" "$(tmux has-session -t =bp-issue7 2>/dev/null && echo yes || echo no)" yes
chk "到达性 · 标签没被翻（self-heal 认它活着）" "$(jq -r '."7" | join(",")' "$GD/labels.json")" "doing/agent"
chk "第 1 轮：还没开工 → 计数不清零" "$(cat "$POLLS/state/selfheal/7" 2>/dev/null || echo 清零)" 2
msg "任务 <!-- coding-agent-launch: $TAG -->" >> "$PREC_DIR/$ID.jsonl"
poll_round
chk "第 2 轮：记录里出现本次标记 → 清零" "$(cat "$POLLS/state/selfheal/7" 2>/dev/null || echo 清零)" 清零
chk "  …启动记录删掉了" "$([ -e "$POLLS/state/selfheal/7.launch" ] && echo yes || echo no)" no
tmux kill-session -t =bp-issue7 2>/dev/null

echo "── 6. 真 cleanup-issue.sh：临时设置文件和启动记录一并删掉 ──"
mkdir -p "$POLLS/state/prompts"; chmod 700 "$POLLS/state/prompts"
for f in 7-new.md 7-new.md.settings.json 7-cmt-5.md.argv.md.settings.json 70-new.md.settings.json; do echo '{}' > "$POLLS/state/prompts/$f"; done
echo '{}' > "$POLLS/state/selfheal/7.launch"; echo '{}' > "$POLLS/state/selfheal/70.launch"
(cd "$POLLS/project" && tmux_sandbox_env_i HOME="$H" LANG=C.UTF-8 CODING_AGENT_CONFIG="$POLLS/config" \
    FAKE_GH_LISTS=1 FAKE_GH_REPO=example/bp FAKE_GH_DIR="$GD" \
    timeout 60 bash "$REPO_DIR/scripts/cleanup-issue.sh" 7) > /dev/null 2>&1
chk "条目 7 的临时设置文件删掉了" "$(ls "$POLLS/state/prompts" | grep '^7-' | tr '\n' ' ')" ""
chk "  …别的条目（70）的留着" "$(ls "$POLLS/state/prompts" | grep '^70-' | tr '\n' ' ')" "70-new.md.settings.json "
chk "条目 7 的启动记录删掉了" "$([ -e "$POLLS/state/selfheal/7.launch" ] && echo yes || echo no)" no
chk "  …别的条目（70）的留着" "$([ -e "$POLLS/state/selfheal/70.launch" ] && echo yes || echo no)" yes

echo
report_counts "$pass" "$fail"
[ "$fail" = 0 ] && echo "全部通过（$pass 项）" || { echo "失败 $fail 项（通过 $pass 项）"; exit 1; }
