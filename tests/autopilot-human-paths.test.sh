#!/usr/bin/env bash
# kind: e2e
# 托管合并：改动碰了「合并前必须人过目」的文件就交人 —— GitHub#337（AUTOPILOT_HUMAN_PATHS）；
# 钩子调用的清单外文件：验算命令与托管复审提示词的那一段 —— GitHub#560。
#
# 跑法：bash tests/autopilot-human-paths.test.sh
# 依赖：bash、jq、python3、git。不碰网络：有状态的假 GitHub（tests/lib/fake_github.py）+ 假 tmux，HOME 指向
# 临时目录。每一轮都**真的**起 agent-poll.sh 子进程；「合没合、翻了什么标签、说了什么」都从假 GitHub 的调用
# 记录和状态里读，不读源码。
#
# 单独一个文件、不放进 tests/autopilot.test.sh：那个文件的每份负对照都把整套场景重跑一遍，场景加在那里
# 每周发版的关卡要多跑一百多遍。本文件不带负对照（GitHub#234 起不新增）。
#
# 这块错了的方向都不报错：
#   · 没配清单的项目行为变了（多读、多写、文字变了）→ 升级后托管悄悄变样
#   · 读不全（缺页、缺自报数、坏响应）当成「没命中」→ 该人过目的改动被自动合并
#   · 写错的条目被忽略 → 清单少了一条，没人知道
#   · 根目录写法和任意深度写法分不清 → 拦多了或拦少了
#   · 判定命中之后不重读就交人 → 人刚改完状态又被写一遍
#   · 验算命令（human-paths-check.sh，GitHub#560）和合并检查判得不一样 → 复审照着验算发的配置建议改完仍拦不住
#   · 没配清单时托管复审提示词多出「钩子调用的文件」那段 → 没开这项的项目复审悄悄变样
set -uo pipefail
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"
# shellcheck source=lib/review-converge.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/review-converge.sh"

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
# shellcheck source=lib/compat.sh
source "$TEST_DIR/lib/compat.sh"

SANDBOX=$(mktemp -d)
trap '[ -n "${KEEP_SANDBOX:-}" ] && echo "SANDBOX=$SANDBOX" || rm -rf "$SANDBOX"' EXIT
mkdir -p "$SANDBOX/bin" "$SANDBOX/home"
export HOME="$SANDBOX/home"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
unset CODING_AGENT_RELEASE_ROOT LABEL_AUTOPILOT DISPATCH_AUTOPILOT DISPATCH_AUTOPILOT_ISSUE DISPATCH_AUTOPILOT_PR \
      DISPATCH_AUTOPILOT_WHERE DISPATCH_PROMPT_KIND AUTOPILOT_HUMAN_PATHS AUTOPILOT_HUMAN_PATHS_DEFAULT
unset GH_TOKEN WRITE_GH_TOKEN GITHUB_TOKEN
export FAKE_GH_REPO="example/ap"

bash "$TEST_DIR/lib/fake_gh_client.sh" install "$SANDBOX/bin/gh" python3 "$TEST_DIR/lib/fake_github.py"
cat > "$SANDBOX/bin/tmux" <<'SH'
#!/usr/bin/env bash
case "$1" in has-session) exit 1 ;; ls|list-sessions) exit 1 ;; esac
exit 0
SH
chmod +x "$SANDBOX/bin/tmux"

pass=0; fail=0
chk() {
    if [ "$2" = "$3" ]; then
        echo "  ✅ $1"; pass=$((pass+1))
    else
        echo "  ❌ $1 (期望 [$3]，实得 [$2])"; fail=$((fail+1))
        if [ -n "${KEEP_SANDBOX:-}" ] && [ -n "${W:-}" ]; then
            cp "$W/state/poll.log" "$SANDBOX/fail-$fail.poll.log" 2>/dev/null; cp "$W/gh/calls.log" "$SANDBOX/fail-$fail.calls.log" 2>/dev/null
        fi
    fi
}
section() { echo "$1"; }

# 改动前的脚本（没配清单时逐字节对拍用）
BASE_REV=$(git -C "$REPO_DIR" merge-base HEAD origin/main 2>/dev/null || git -C "$REPO_DIR" rev-parse HEAD~1)
mkdir -p "$SANDBOX/old"
git -C "$REPO_DIR" archive "$BASE_REV" scripts prompts | tar -x -C "$SANDBOX/old"
rm -rf "$SANDBOX/old/prompts"; cp -r "$REPO_DIR/prompts" "$SANDBOX/old/prompts"
# GitHub#599 的新占位：旧派工脚本照新脚本的办法换掉（tests/lib/compat.sh）
compat_step_dir_patch "$SANDBOX/old" || exit 1

H1=1111111111111111111111111111111111111111
H2=2222222222222222222222222222222222222222
R="repos/example/ap"
SCRIPTS="$REPO_DIR/scripts"
W="$SANDBOX/run"

fresh() {   # [额外配置行…]
    rm -rf "$W"; mkdir -p "$W/state" "$W/wt" "$W/gh"
    git init -q "$W/project" 2>/dev/null
    GD="$W/gh"; export FAKE_GH_DIR="$GD"; CALLS="$GD/calls.log"; STATE="$W/state/state.json"
    CONF="$W/cavil-loop.config"
    cat > "$CONF" <<CONF
REPO="example/ap"
PROJECT_ROOT="$W/project"
WORKTREE_BASE="$W/wt"
STATE_DIR="$W/state"
TMUX_PREFIX="aptest"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
# 等前置 / 暂缓 GitHub#551 起没写就开；这里比的是它们关着的状态，写成空值
LABEL_PENDING_BLOCKED=""
LABEL_PENDING_LATER=""
LABEL_AGENT_DOING="doing/agent"
LABEL_PENDING_REVIEW="pending/review"
LABEL_AUTOPILOT="autopilot"
POST_MERGE_RETROSPECTIVE=false
AUTO_CLEANUP_ON_MERGE=false
PENDING_HUMAN_CONFLICT_CHECK=false
POLL_BACKOFF_LADDER=""
PRICE_AUTO_FETCH=0
MAX_CONCURRENT_WORKERS=0
AUTOPILOT_UNKNOWN_MAX=3
PATH="$SANDBOX/bin:\$PATH"
GH_TOKEN="fake-token-for-test"
CONF
    local l; for l in "$@"; do printf '%s\n' "$l" >> "$CONF"; done
    EVN=0
    echo '{}' > "$GD/items.json"; echo '{}' > "$GD/labels.json"; echo '{}' > "$GD/events.json"
    echo '{}' > "$GD/comments.json"; echo '{"maint":"admin","helper":"read"}' > "$GD/perms.json"
    echo '{}' > "$GD/checks.json"; echo '{}' > "$GD/files.json"; echo loop-bot > "$GD/me"
}
jset() { local f="$GD/$1" e="$2"; shift 2; jq "$@" "$e" "$f" > "$f.tmp" && mv "$f.tmp" "$f"; }
ev() {   # <n> <labeled|unlabeled> <标签> <操作人>
    EVN=$((EVN + 1))
    jset events.json '.[$n] = ((.[$n] // []) + [{event:$e, label:{name:$l}, actor:{login:$a, type:"User"}, created_at:$c}])' \
        --arg n "$1" --arg e "$2" --arg l "$3" --arg a "$4" --arg c "$(printf '2026-01-01T00:%02d:00Z' "$EVN")"
}
# 一个准备好合并的托管 PR：issue 7（maint 打的托管标签）+ PR 8，复审记录和测试重跑记录齐全
happy() {
    jset items.json '.["7"] = {kind:"issue", state:"open", title:"t", body:"需求", user:{login:"maint"}, updated_at:"2026-01-01T00:00:00Z"}'
    jset labels.json '.["7"] = ["autopilot","pending/PR"]'
    ev 7 labeled autopilot maint
    jset items.json '.["8"] = {kind:"pr", state:"open", merged:false, draft:false, title:"t", body:"做了 X。\n\nRefs #7",
            user:{login:"loop-bot"}, updated_at:"2026-01-01T00:00:00Z", created_at:"2025-12-01T00:00:00Z",
            head:{sha:$h, ref:"feature/issue-7", repo:{full_name:"example/ap"}}, base:{ref:"main"},
            mergeable:true, mergeable_state:"clean"}' --arg h "$H1"
    jset labels.json '.["8"] = ["pending/merge","autopilot"]'
    ev 8 labeled autopilot loop-bot
    ev 8 labeled pending/merge loop-bot   # 真 GitHub 上每个标签都有打上它的那条记录；交人的写前核对要读它（GitHub#382）
    echo '{}' > "$STATE"
    jq --arg h "$H1" '.autopilot.prs["8"] = {reviewed_head:$h, reviewed_at:"2026-01-01T00:00:00Z", reviewed_base:"main"}' \
        "$STATE" > "$STATE.tmp" && mv "$STATE.tmp" "$STATE"
    jset comments.json '.["8"] = [{id:900, user:{login:"loop-bot"}, created_at:"2026-06-01T00:00:00Z",
            body:("## ✅ 复审通过\n\n<!-- autopilot-review-pass head=" + $h + " passed=12 failed=0 -->")}]' --arg h "$H1"
}
files() { jset files.json '.["8"] = $f' --argjson f "$1"; }   # <JSON 数组>
tick() { : > "$CALLS"; env CODING_AGENT_CONFIG="$CONF" bash "${1:-$SCRIPTS}/agent-poll.sh" >/dev/null 2>&1; }
n_calls() { grep -cE -- "$1" "$CALLS" 2>/dev/null || true; }
merged() { n_calls "^gh api -X PUT $R/pulls/8/merge "; }
labels_of() { jq -r --arg n "$1" '(.[$n] // []) | sort | join(",")' "$GD/labels.json"; }
has_label() { case ",$(labels_of 8)," in *",$1,"*) echo yes ;; *) echo no ;; esac; }
comments_with() { jq -r '(.["8"] // [])[].body' "$GD/comments.json" | grep -cF -- "$1" || true; }
writes() { n_calls "^gh api -X (POST|PUT|DELETE|PATCH) "; }
files_reads() { n_calls "^gh api --paginate --slurp $R/pulls/8/files"; }
unknown_n() { jq -r '.autopilot.prs["8"].unknown // 0' "$STATE" 2>/dev/null; }
hook() {   # <key> <第几次读之前> <在假 GitHub 目录里跑的命令>
    printf 'cd %q && { %s; } < /dev/null\n' "$GD" "$3" > "$GD/hook_$1_$2"
}
jhook() {  # <key> <k> <文件> <jq 表达式>：第 k 次读之前原地改假 GitHub 的一个状态文件
    hook "$1" "$2" "jq '$4' $3 > $3.tmp && mv $3.tmp $3"
}
ON='AUTOPILOT_HUMAN_PATHS="default"'

# ─────────────────────────────────────────────────────────────────────────
section "【1】没配清单（不写 / 写成空）：GitHub 调用、state.json、评论、标签和改动前一致"
# 五个场景各自从干净状态起跑若干轮；连读数不正常的情况也要一样（没配就是原来的代码）。
# 没有交人发生的场景（clean / emptypages / packagejson）连 GitHub 调用逐字节比；发生交人的两个场景
# （dotgithub、readfail 到上限）交人本身多了写前核对（GitHub#382：调用变多、说明末尾多一行隐藏标记），
# 比的是结果：state、标签、评论的可见文字
off_run() {   # <scripts 根> <配置行（可空）> <场景> → 输出一份可比的记录
    local root="$1" line="$2" sc="$3" i
    if [ -n "$line" ]; then fresh "$line"; else fresh; fi
    happy
    case "$sc" in
        clean) ;;
        dotgithub) files '[{"filename":"scripts/x.sh"},{"filename":".github/workflows/ci.yml"}]' ;;
        emptypages) files '[{"filename":"client/package.json"}]'; printf '[[]]' > "$GD/raw_pulls_8_files" ;;
        readfail) : > "$GD/F_pulls_8_files" ;;
        packagejson) files '[{"filename":"client/package.json"}]' ;;
    esac
    for i in 1 2 3; do
        tick "$root/scripts"
        case "$sc" in dotgithub|readfail) ;; *) echo "── 第 $i 轮调用"; cat "$CALLS" ;; esac
    done
    # daemon 翻标签时假 GitHub 把条目的更新时间记成「现在」，state 里引用它的地方按秒变：抹成同一个占位
    # 托管判定规则的版本（AUTOPILOT_JUDGE_REV，写进 .autopilot.takeover / .denied 的值开头）按规矩随规则改动而变（GitHub#619 起），
    # 不是这里要比的行为：两边都抹成同一个占位
    echo "── state"; jq -S 'del(.autopilot.handoff)' "$STATE" | sed -E 's/20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9:]{8}Z/<时间>/g; s/"r[0-9a-z]+\|/"<规则版本>|/g'
    echo "── 标签"; jq -S . "$GD/labels.json"
    echo "── 评论"; jq -S '[.[] | .[] | .body | sub("\\n<!-- cavil-loop:autopilot-handover [^>]*-->$"; "")]' "$GD/comments.json"
    echo "── 合并后交接记录（去掉时间）"; jq -S '(.autopilot.handoff // {}) | map_values(.body)' "$STATE"
}
if ! compat_skip "没配清单时的调用、state、评论、标签与改动前" "$SANDBOX/old" "$REPO_DIR" scripts; then
    for sc in clean dotgithub emptypages readfail packagejson; do
        old=$(off_run "$SANDBOX/old" "" "$sc")
        for line in "" 'AUTOPILOT_HUMAN_PATHS=""'; do
            new=$(off_run "$REPO_DIR" "$line" "$sc")
            chk "场景 $sc，${line:-不写这一行} → 和改动前一样" "$([ -n "$new" ] && [ "$old" = "$new" ] && echo same || echo differ)" same
            [ "$old" = "$new" ] || [ -z "${KEEP_SANDBOX:-}" ] || { printf '%s\n' "$old" > "$SANDBOX/off-$sc.old"; printf '%s\n' "$new" > "$SANDBOX/off-$sc.new"; }
        done
    done
fi
# 到达性：上面比的不是两份空记录——没配清单时这几个场景确实合并了 / 交人了
fresh; happy; files '[{"filename":"client/package.json"}]'; tick
chk "到达性 · 没配清单：改 package.json 的 PR 照常合并" "$(merged)" 1
fresh; happy; files '[{"filename":".github/workflows/ci.yml"}]'; tick
chk "到达性 · 没配清单：改 .github/ 的 PR 交人，文字是原来那句" "$(has_label pending/human)/$(comments_with '改动碰了 `.github/` 目录（Actions 和仓库自动化）')" "yes/1"
chk "到达性 · 没配清单：交人这一轮读了 4 次文件列表（触发 1 次 + 交人函数里写前重判 3 次，GitHub#382）" "$(files_reads)" 4

# ─────────────────────────────────────────────────────────────────────────
section "【2】配了默认清单：命中 → 交人并列出文件；没命中 → 照常合并"
for c in 'client/package.json|[{"filename":"scripts/x.sh"},{"filename":"client/package.json"}]|深层的 package.json' \
         '.claude/settings.json|[{"filename":".claude/settings.json"}]|根目录的 agent 配置' \
         '.github/workflows/ci.yml|[{"filename":".github/workflows/ci.yml"}]|.github/（清单里始终有）' \
         '.husky/pre-commit|[{"filename":"hooks.txt","previous_filename":".husky/pre-commit"}]|改名前的旧路径' \
         '.agents/skills/cavil-loop/prompts/review.extra.md|[{"filename":".agents/skills/cavil-loop/prompts/review.extra.md"}]|项目级提示词覆盖'; do
    IFS='|' read -r hit fj what <<< "$c"
    fresh "$ON"; happy; files "$fj"
    tick
    chk "$what → 不合并" "$(merged)" 0
    chk "$what → 交人：挂 pending/human、摘 pending/merge" "$(has_label pending/human)/$(has_label pending/merge)" "yes/no"
    chk "$what → 说明里列出命中的文件" "$(comments_with "改动碰了合并前需人过目的文件：\`$hit\`")" 1
    chk "$what → 交人时每次写入前都重判（触发 1 次 + 写前 3 次读文件列表）" "$(files_reads)" 4
done
fresh "$ON"; happy; files '[{"filename":"scripts/x.sh"},{"filename":"docs/a.md"},{"filename":"apackage.json"},{"filename":"Makefile.am"}]'
tick
chk "只改脚本、文档和名字相近的文件 → 照常合并" "$(merged)/$(has_label pending/human)" "1/no"
chk "到达性 · 这一轮读了文件列表（决定时 + 合并前各一次）" "$(files_reads)" 2

fresh "$ON"; happy
files "$(jq -nc '[range(0; 12) | {filename: ("pkg\(. + 100)/package.json")}]')"
tick
chk "命中 12 个 → 说明只列 10 个，写「等 12 个」" "$(comments_with '`pkg109/package.json` 等 12 个')/$(comments_with 'pkg110')" "1/0"

# ─────────────────────────────────────────────────────────────────────────
section "【3】条目写法：开头 / 只认根目录，不写 = 任何深度；末尾 / = 目录"
# 清单 | 改动的文件 | 期望（hit = 交人，ok = 合并）
while IFS='|' read -r spec f want; do
    [ -n "$spec" ] || continue
    fresh "AUTOPILOT_HUMAN_PATHS=\"$spec\""; happy; files "[{\"filename\":\"$f\"}]"
    tick
    got=$([ "$(merged)" = 1 ] && echo ok || { [ "$(has_label pending/human)" = yes ] && echo hit || echo other; })
    chk "清单 [$spec]，改 $f → $want" "$got" "$want"
done <<'EOF'
/setup.sh|setup.sh|hit
/setup.sh|tools/setup.sh|ok
setup.sh|setup.sh|hit
setup.sh|tools/setup.sh|hit
setup.sh|tools/setup.sh.bak|ok
/scripts/|scripts/x.sh|hit
/scripts/|scripts/a/b/x.sh|hit
/scripts/|client/scripts/x.sh|ok
/scripts/|scripts|ok
.husky/|.husky/pre-commit|hit
.husky/|a/b/.husky/pre-commit|hit
.husky/|a/x.husky/pre-commit|ok
/docs/*.md|docs/a.md|hit
/docs/*.md|docs/sub/a.md|ok
/docs/*.md|docs/amd|ok
default /scripts/|scripts/x.sh|hit
default /scripts/|client/package.json|hit
default,/scripts/|scripts/x.sh|hit
/scripts/|client/package.json|ok
/scripts/|.github/workflows/ci.yml|hit
/scripts/|sub/.github/x.yml|ok
EOF

# ─────────────────────────────────────────────────────────────────────────
section "【4】清单里有写法不认识的条目 → 交人并写明是哪一条，不悄悄忽略"
for bad in 'a/b.txt' '/../x' '**' '/a//b'; do
    fresh "AUTOPILOT_HUMAN_PATHS=\"default $bad\""; happy    # 改动本身没碰清单里的任何文件
    tick
    chk "条目 [$bad] → 不合并、交人" "$(merged)/$(has_label pending/human)" "0/yes"
    chk "条目 [$bad] → 说明点名这个条目" "$(comments_with "写法不认识：\`$bad（")" 1
    chk "条目 [$bad] → 不用读文件列表" "$(files_reads)" 0
done

# ─────────────────────────────────────────────────────────────────────────
section "【5】读全：自报的改动文件数和列表对得上才算读全；读不全绝不当成没命中"
fresh "$ON"; happy; files '[]'
tick
chk "真没有改动（自报 0、列表空）→ 照常合并" "$(merged)" 1

unread() {   # <说明> <日志里应出现的原因>：本轮不合并、不写、计一次读不到
    tick
    chk "$1 → 不合并、不写任何东西" "$(merged)/$(writes)" "0/0"
    chk "$1 → 计一次读不到" "$(unknown_n)" 1
    chk "$1 → 日志写明原因" "$(grep -cF -- "$2" "$W/state/poll.log")" 1
}
# 下面每个场景里真正被改的都是 package.json：读不全时一旦当成「没命中」就会合并
fresh "$ON"; happy; files '[{"filename":"client/package.json"}]'; jset items.json '.["8"].changed_files = 3'
printf '[[{"filename":"scripts/x.sh"}]]' > "$GD/raw_pulls_8_files"
unread "列表缺页（1 个，自报 3 个）" "列表有 1 个文件，PR 自报 3 个"
fresh "$ON"; happy; files '[{"filename":"client/package.json"}]'; printf '[[]]' > "$GD/raw_pulls_8_files"
unread "每页都是空、自报 1 个" "列表有 0 个文件，PR 自报 1 个"
fresh "$ON"; happy; files '[{"filename":"client/package.json"}]'; jset items.json '.["8"].changed_files = "__missing__"'
unread "PR 详情里缺改动文件数" "PR 详情里没有可用的改动文件数"
fresh "$ON"; happy; files '[{"filename":"client/package.json"}]'; jset items.json '.["8"].changed_files = "1"'
unread "改动文件数不是数字" "PR 详情里没有可用的改动文件数"
fresh "$ON"; happy; files '[{"filename":"client/package.json"}]'; printf '[[{"sha":"abc"}]]' > "$GD/raw_pulls_8_files"
unread "条目缺文件名" "文件列表的形状不对"
fresh "$ON"; happy; files '[{"filename":"client/package.json"}]'; printf '{"message":"Server Error"}' > "$GD/raw_pulls_8_files"
unread "响应不是按页的数组" "文件列表的形状不对"
fresh "$ON"; happy; files '[{"filename":"client/package.json"}]'; printf '<html>502</html>' > "$GD/raw_pulls_8_files"
unread "响应不是 JSON" "文件列表不是合法的 JSON"
fresh "$ON"; happy; files '[{"filename":"client/package.json"}]'; : > "$GD/F_pulls_8_files"
unread "请求失败" "请求失败或空输出"

tick; tick
chk "连续 3 轮读不全（上限）→ 交人，不合并" "$(merged)/$(has_label pending/human)/$(has_label pending/merge)" "0/yes/no"
chk "  → 说明写连续读不到和最后一次的原因" "$(comments_with '连续 3 轮读不到判断所需的信息')/$(comments_with '读不全 PR #8 的改动文件列表')" "1/1"

fresh "$ON"; happy; : > "$GD/F_pulls_8_files"
tick; tick
chk "读不全两轮后（未到上限）没写过东西" "$(unknown_n)/$(has_label pending/human)" "2/no"
rm -f "$GD/F_pulls_8_files"
tick
chk "之后读全了、没命中 → 照常合并" "$(merged)" 1

# ─────────────────────────────────────────────────────────────────────────
section "【6】判定命中之后、交人之前有变化 → 重判拦住，本轮什么都不写"
# 第 2 次读（= 交人前的重判）之前改掉 GitHub 上的状态
re() {   # <说明> <key> <文件> <jq 表达式>
    fresh "$ON"; happy; files '[{"filename":"client/package.json"}]'
    jhook "$2" 2 "$3" "$4"
    tick
    chk "$1 → 本轮不写、不合并" "$(writes)/$(merged)/$(comments_with '需人过目')" "0/0/0"
    chk "$1 → 到达性：第一次判定确实读了文件列表" "$([ "$(files_reads)" -ge 1 ] && echo yes || echo no)" yes
}
re "新推送把文件改回去了（同一提交号的列表变了）" pulls_8_files files.json '.["8"] = [{"filename":"scripts/x.sh"}]'
tick
chk "  → 下一轮按现状：没命中，合并" "$(merged)" 1
re "命中的文件换了一批" pulls_8_files files.json '.["8"] = [{"filename":"Makefile"}]'
tick
chk "  → 下一轮按现状交人，说明写的是新的文件" "$(comments_with '需人过目的文件：`Makefile`')/$(comments_with 'client/package.json')" "1/0"
re "PR 被关闭" pulls_8 items.json '.["8"].state = "closed"'
re "PR 推了新提交" pulls_8 items.json ".[\"8\"].head.sha = \"$H2\""
re "PR 改投了别的目标分支" pulls_8 items.json '.["8"].base.ref = "release"'
re "有人摘了 pending/merge" pulls_8 labels.json '.["8"] = ["autopilot"]'
re "issue 上摘了托管标签" pulls_8 labels.json '.["7"] = ["pending/PR"]'
fresh "$ON"; happy; files '[{"filename":"client/package.json"}]'
# 假 GitHub 先看失败开关、再跑 hook：第 1 次读的 hook 里打开开关，第 2 次读（重判）就失败
hook pulls_8_files 1 ': > F_pulls_8_files'
tick
chk "重判时文件列表请求失败 → 本轮不写" "$(writes)/$(has_label pending/human)" "0/no"
chk "  → 到达性：第一次读到了命中、第二次读（重判）确实发出并失败" \
    "$(files_reads)/$([ -e "$GD/F_pulls_8_files" ] && echo 开关已开 || echo 没开)/$(grep -cF '交人之前重判有变化（重判结果 unknown：读不全 PR #8 的改动文件列表（请求失败或空输出））' "$W/state/poll.log")" "2/开关已开/1"

fresh "$ON"; happy; files '[{"filename":"client/package.json"}]'
hook pulls_8 2 'jq '"'"'.["8"] += ["pending/human"]'"'"' labels.json > l.tmp && mv l.tmp labels.json
    jq '"'"'.["8"] += [{id: 90001, event: "labeled", label: {name: "pending/human"}, actor: {login: "maint", type: "User"}, created_at: "2026-01-02T00:00:00Z"}]'"'"' events.json > e.tmp && mv e.tmp events.json'
tick
chk "重判时人已在 PR 上挂了 pending/human → daemon 不发说明、不动标签" "$(writes)/$(comments_with '需人过目')" "0/0"
# 到达性：第一次判定读了文件列表（命中）；交人函数取基准时读到人挂的标签，停在重判之前；两个标签都原样留着
chk "  → 到达性：第一次命中、重判读到了人挂的标签并停下" \
    "$(files_reads)/$(n_calls "^gh api $R/pulls/8\$")/$(has_label pending/human)/$(has_label pending/merge)/$(grep -cF 'PR #8 交人前现状已变' "$W/state/poll.log")" "1/2/yes/yes/1"

section "【7】决定时没命中、合并请求前一刻新推了清单里的文件 → 不合并"
fresh "$ON"; happy
jhook pulls_8_files 2 files.json '.["8"] = [{"filename":"scripts/x.sh"},{"filename":"client/package.json"}]'
tick
chk "合并前重读拦住 → 不合并、本轮不写" "$(merged)/$(writes)" "0/0"
tick
chk "  → 下一轮交人，列出文件" "$(has_label pending/human)/$(comments_with '需人过目的文件：`client/package.json`')" "yes/1"

# ─────────────────────────────────────────────────────────────────────────
section "【8】文档里给维护者照抄的配置行：两份文档一致，每一行都是 daemon 认得的写法"
ex_of() { sed -n '/<!-- autopilot-human-paths:examples:begin -->/,/<!-- autopilot-human-paths:examples:end -->/p' "$1" | grep -E '^AUTOPILOT_HUMAN_PATHS='; }
EX_EN=$(ex_of "$REPO_DIR/docs/operations.md"); EX_ZH=$(ex_of "$REPO_DIR/docs/operations.zh.md")
chk "两份文档的示例行一致，且至少有 3 行" "$([ -n "$EX_EN" ] && [ "$EX_EN" = "$EX_ZH" ] && [ "$(printf '%s\n' "$EX_EN" | wc -l)" -ge 3 ] && echo yes || echo no)" yes
while IFS= read -r line; do
    [ -n "$line" ] || continue
    fresh "$line"; happy; files '[{"filename":"docs/a.md"}]'
    tick
    chk "示例 $line：只改文档的 PR 照常合并（清单写法都认得）" "$(merged)" 1
    fresh "$line"; happy; files '[{"filename":".claude/settings.json"}]'
    tick
    chk "示例 $line：改 agent 配置的 PR 交人" "$(merged)/$(has_label pending/human)" "0/yes"
done <<< "$EX_EN"
# 开启 → 生效 → 关掉（删掉这一行）→ 恢复，全程同一份配置、同一份 state 和假 GitHub，不重建环境
fresh "$ON"; happy; files '[{"filename":"client/package.json"}]'
tick
chk "生命周期 ① 开启后第一轮：改 package.json 的 PR #8 交人、没合并" "$(merged)/$(has_label pending/human)/$(has_label pending/merge)" "0/yes/no"
# 第二个候选：issue 9 + PR 10，同样只改 package.json（不动已有的 state 和夹具，只往里加）
jset items.json '.["9"] = {kind:"issue", state:"open", title:"t", body:"需求", user:{login:"maint"}, updated_at:"2026-01-01T00:00:00Z"}'
jset labels.json '.["9"] = ["autopilot","pending/PR"]'
ev 9 labeled autopilot maint
jset items.json '.["10"] = {kind:"pr", state:"open", merged:false, draft:false, title:"t", body:"做了 Y。\n\nRefs #9",
        user:{login:"loop-bot"}, updated_at:"2026-01-01T00:00:00Z", created_at:"2025-12-01T00:00:00Z",
        head:{sha:$h, ref:"feature/issue-9", repo:{full_name:"example/ap"}}, base:{ref:"main"},
        mergeable:true, mergeable_state:"clean"}' --arg h "$H2"
jset labels.json '.["10"] = ["pending/merge","autopilot"]'
ev 10 labeled autopilot loop-bot
ev 10 labeled pending/merge loop-bot
jq --arg h "$H2" '.autopilot.prs["10"] = {reviewed_head:$h, reviewed_at:"2026-01-01T00:00:00Z", reviewed_base:"main"}' \
    "$STATE" > "$STATE.tmp" && mv "$STATE.tmp" "$STATE"
jset comments.json '.["10"] = [{id:950, user:{login:"loop-bot"}, created_at:"2026-06-01T00:00:00Z",
        body:("## ✅ 复审通过\n\n<!-- autopilot-review-pass head=" + $h + " passed=12 failed=0 -->")}]' --arg h "$H2"
jset files.json '.["10"] = [{"filename":"client/package.json"}]'
merged10() { n_calls "^gh api -X PUT $R/pulls/10/merge "; }
tick
chk "生命周期 ② 仍开着：新候选 PR #10 也交人、没合并" "$(merged10)/$(labels_of 10)" "0/autopilot,pending/human"
# 维护者想让 #10 按旧规则走：照文档删掉配置行，再把 #10 送回合并队列
grep -v '^AUTOPILOT_HUMAN_PATHS=' "$CONF" > "$CONF.tmp" && mv "$CONF.tmp" "$CONF"
chk "生命周期 ③ 配置行已删" "$(grep -c '^AUTOPILOT_HUMAN_PATHS=' "$CONF")" 0
jset labels.json '.["10"] = ["pending/merge","autopilot"]'
jq --arg h "$H2" '.autopilot.prs["10"] = {reviewed_head:$h, reviewed_at:"2026-01-01T00:00:00Z", reviewed_base:"main"}' \
    "$STATE" > "$STATE.tmp" && mv "$STATE.tmp" "$STATE"
tick
chk "生命周期 ④ 删掉之后：PR #10 按旧规则合并" "$(merged10)" 1
chk "生命周期 ④ 已经交给人的 PR #8 仍在人手上：没合并、标签没动、没有新留言" \
    "$(merged)/$(labels_of 8)/$(comments_with 'cavil-loop daemon')" "0/autopilot,pending/human/1"
chk "模板里这一项是空值（不写和照抄模板行为一样）" "$(grep -cE '^AUTOPILOT_HUMAN_PATHS=""$' "$REPO_DIR/cavil-loop.config.example")" 1

# ─────────────────────────────────────────────────────────────────────────
section "【9】测试文件不算（GitHub#548）：只改测试文件照常合并；混着非测试文件只点名非测试文件"
# 每个场景的改动都落在默认清单的目录里（.agents/ .claude/）：测试文件一旦被当成普通文件就会交人
# 文件列表照 GitHub 的真实形状写：每条都带改动类型 status，改名带 previous_filename
T_ONLY='[{"filename":".agents/skills/x/scripts/a.test.mjs","status":"modified"},{"filename":".agents/skills/x/fixtures/x.test.json","status":"added"},
         {"filename":".claude/__tests__/b.ts","status":"modified"},{"filename":".agents/skills/x/scripts/old.spec.ts","status":"removed"},
         {"filename":".claude/commands/foo.test.md","status":"added"}]'
T_MIX='[{"filename":".agents/skills/x/scripts/a.test.mjs","status":"modified"},{"filename":".agents/skills/x/scripts/a.mjs","status":"modified"}]'
for line in "" 'AUTOPILOT_HUMAN_PATHS_EXEMPT_TESTS=""' 'AUTOPILOT_HUMAN_PATHS_EXEMPT_TESTS="on"'; do
    what="${line:-不写开关}"
    if [ -n "$line" ]; then fresh "$ON" "$line"; else fresh "$ON"; fi
    happy; files "$T_ONLY"; tick
    chk "$what · 只改测试文件（含 .json 测试数据、__tests__/、删掉的 .spec、Markdown 测试）→ 照常合并、不交人" \
        "$(merged)/$(has_label pending/human)/$(comments_with '需人过目')" "1/no/0"
    chk "$what · 到达性：这一轮确实读了文件列表（决定时 + 合并前各一次）" "$(files_reads)" 2
    if [ -n "$line" ]; then fresh "$ON" "$line"; else fresh "$ON"; fi
    happy; files "$T_MIX"; tick
    chk "$what · 测试文件 + 同目录非测试文件 → 交人、不合并" "$(merged)/$(has_label pending/human)/$(has_label pending/merge)" "0/yes/no"
    chk "$what · 说明只点名非测试文件" "$(comments_with '改动碰了合并前需人过目的文件：`.agents/skills/x/scripts/a.mjs`。')/$(comments_with 'a.test.mjs')" "1/0"
done

# 改名：新旧路径都是测试文件才不算
while IFS='|' read -r fj want named what; do
    [ -n "$fj" ] || continue
    fresh "$ON"; happy; files "$fj"; tick
    got=$([ "$(merged)" = 1 ] && echo ok || { [ "$(has_label pending/human)" = yes ] && echo hit || echo other; })
    chk "改名 · $what → $want" "$got" "$want"
    [ -z "$named" ] || chk "改名 · $what → 说明点名 $named" "$(comments_with "$named")" 1
done <<'EOF'
[{"filename":".agents/a.test.mjs","status":"renamed","previous_filename":".agents/b.test.mjs"}]|ok||测试 → 测试
[{"filename":".agents/a.test.mjs","status":"renamed","previous_filename":".agents/a.mjs"}]|hit|`.agents/a.mjs`|非测试 → 测试
[{"filename":"src/a.mjs","status":"renamed","previous_filename":".agents/a.test.mjs"}]|hit|`.agents/a.test.mjs`|清单里的测试 → 清单外的非测试
[{"filename":".agents/a.test.mjs","status":"copied","previous_filename":".agents/a.mjs"}]|hit|`.agents/a.mjs`|复制：非测试 → 测试
EOF

# 新路径是测试文件、改动记录却不完整：不能证明旧路径也是测试文件 → 读不全，本轮不合并、不写，计一次读不到
# （PR #549 复审第 1 轮：缺旧路径的改名曾被当成「只有新路径」放行）
while IFS='|' read -r fj what; do
    [ -n "$fj" ] || continue
    fresh "$ON"; happy; files "$fj"; tick
    chk "改动记录不完整 · $what → 不合并、不写任何东西" "$(merged)/$(writes)" "0/0"
    chk "改动记录不完整 · $what → 计一次读不到、日志写明原因" \
        "$(unknown_n)/$(grep -cF -- '测试文件的改动记录不完整（改动类型不认识，或改名缺旧路径）' "$W/state/poll.log")" "1/1"
done <<'EOF'
[{"filename":".agents/new.test.mjs","status":"renamed"}]|改名缺旧路径
[{"filename":".agents/new.test.mjs","status":"renamed","previous_filename":""}]|改名的旧路径是空的
[{"filename":".agents/new.test.mjs","status":"copied"}]|复制缺旧路径
[{"filename":".agents/new.test.mjs"}]|缺改动类型
[{"filename":".agents/new.test.mjs","status":"moved"}]|改动类型不认识
EOF
# 只卡测试文件那一条：非测试文件缺改动类型照旧按清单判（和以前一样交人），清单外的测试文件缺类型也拦下
fresh "$ON"; happy; files '[{"filename":".agents/a.mjs"}]'; tick
chk "非测试文件缺改动类型 → 照旧命中交人（不受这条检查影响）" "$(merged)/$(has_label pending/human)" "0/yes"
fresh "$ON" 'AUTOPILOT_HUMAN_PATHS_EXEMPT_TESTS="off"'; happy; files '[{"filename":".agents/new.test.mjs","status":"renamed"}]'; tick
chk "开关 off：缺旧路径的测试文件改名照以前的规则（命中新路径就交人），不算读不全" \
    "$(merged)/$(has_label pending/human)/$(unknown_n)" "0/yes/0"
fresh "$ON"; happy; files '[{"filename":".agents/a.test.mjs","status":"renamed","previous_filename":".agents/b.test.mjs"},{"filename":"src/x.test.mjs","status":"modified"}]'; tick
chk "到达性 · 记录完整的改名 + 清单外测试文件 → 照常合并" "$(merged)" 1

# 仓库根目录 .github/ 下的文件名字像测试也不算（维护者在 #548 选的 C）
for f in .github/workflows/ci.test.yml .github/__tests__/a.ts; do
    fresh "$ON"; happy; files "[{\"filename\":\"$f\"}]"; tick
    chk "$f → 交人、说明点名它" "$(merged)/$(has_label pending/human)/$(comments_with "需人过目的文件：\`$f\`")" "0/yes/1"
done

# 名字只是像、其实不是测试文件
for f in .agents/a.test .agents/test.mjs .agents/x.tests.mjs .agents/.test.mjs .agents/__tests__x/b.ts; do
    fresh "$ON"; happy; files "[{\"filename\":\"$f\"}]"; tick
    chk "$f 不算测试文件 → 交人" "$(merged)/$(has_label pending/human)" "0/yes"
done

section "【10】开关关掉（off，或写了认不出的词）：和改动前的脚本逐字节一样"
# 同一份清单 + 两个场景，调用、state、标签、评论全文和合并基准的脚本比。两边写同一行开关：
# 合并基准在 #549 之前时旧脚本不认它（写不写都一样），在那之后旧脚本照它关——只给新的一侧写，
# 合并基准一过 #549 这组就拿「开」去比「关」，任何改到 scripts/ 的分支都会红（GitHub#551 发现）
cmp_run() {   # <scripts 根> <开关配置行（可空）> <场景>
    local root="$1" line="$2" sc="$3" i
    if [ -n "$line" ]; then fresh "$ON" "$line"; else fresh "$ON"; fi
    happy
    case "$sc" in only) files "$T_ONLY" ;; mix) files "$T_MIX" ;; esac
    for i in 1 2 3; do tick "$root/scripts"; echo "── 第 $i 轮调用"; cat "$CALLS"; done
    echo "── state"; jq -S . "$STATE" | sed -E 's/20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9:]{8}Z/<时间>/g; s/"r[0-9a-z]+\|/"<规则版本>|/g'   # 规则版本同上
    echo "── 标签"; jq -S . "$GD/labels.json"
    echo "── 评论"; jq -S '[.[] | .[] | .body]' "$GD/comments.json"
}
if ! compat_skip "开关关掉时的调用、state、评论、标签与改动前" "$SANDBOX/old" "$REPO_DIR" scripts; then
    # 改动前的那份也写同一行：#548 之前的脚本不认这一项，等于不写；合并基线已带 #548 时
    # （之后的 PR 都是），不写就等于开着，比的就该是两版在同一行开关下的行为
    for sc in only mix; do
        for line in 'AUTOPILOT_HUMAN_PATHS_EXEMPT_TESTS="off"' 'AUTOPILOT_HUMAN_PATHS_EXEMPT_TESTS="of"'; do
            old=$(cmp_run "$SANDBOX/old" "$line" "$sc")
            new=$(cmp_run "$REPO_DIR" "$line" "$sc")
            chk "场景 $sc，$line → 和改动前一样" "$([ -n "$new" ] && [ "$old" = "$new" ] && echo same || echo differ)" same
            [ "$old" = "$new" ] || [ -z "${KEEP_SANDBOX:-}" ] || { printf '%s\n' "$old" > "$SANDBOX/ex-$sc.old"; printf '%s\n' "$new" > "$SANDBOX/ex-$sc.new"; }
        done
    done
fi
# 到达性：比的不是两份空记录——开关关掉时只改测试文件的 PR 交人，说明里列着测试文件
fresh "$ON" 'AUTOPILOT_HUMAN_PATHS_EXEMPT_TESTS="off"'; happy; files "$T_ONLY"; tick
chk "到达性 · 开关 off：只改测试文件也交人，说明列出测试文件" "$(merged)/$(has_label pending/human)/$(comments_with '.agents/skills/x/scripts/a.test.mjs')" "0/yes/1"
chk "模板里这一项是 on" "$(grep -cE '^AUTOPILOT_HUMAN_PATHS_EXEMPT_TESTS="on"$' "$REPO_DIR/cavil-loop.config.example")" 1

# ─────────────────────────────────────────────────────────────────────────
section "【11】钩子调用的清单外文件（GitHub#560）：验算命令和真实合并检查逐个对拍；文档命令照字面跑"
CHECK="$SCRIPTS/human-paths-check.sh"
# 只改一个文件的托管 PR 跑一轮真实轮询：merge = 合并了，human = 交人没合并，其他 = other
outcome() {   # <文件> [配置行…]
    local f="$1"; shift
    fresh "$@"; happy; files "[{\"filename\":\"$f\",\"status\":\"modified\"}]"; tick
    if [ "$(merged)" = 1 ]; then echo merge
    elif [ "$(has_label pending/human)" = yes ]; then echo human
    else echo other; fi
}
# 验算命令对同一个文件的结论：拦 → human，不拦 → merge
predict() {   # <清单值> <on|off> <文件>
    local out rc=0
    out=$(bash "$CHECK" --spec "$1" --exempt-tests "$2" "$3") || rc=$?
    case "$rc:$out" in
        0:拦$'\t'*) echo human ;;
        1:不拦$'\t'*) echo merge ;;
        *) echo "error($rc:$out)" ;;
    esac
}
# 同一个例子（原清单 default /setup.sh），清单 × 豁免 × 文件：方案里六种情况各至少一行，外加改名路线和根目录 .github/
while IFS='|' read -r spec ex f want what; do
    [ -n "$spec" ] || continue
    lines=("AUTOPILOT_HUMAN_PATHS=\"$spec\"")
    [ "$ex" = off ] && lines+=('AUTOPILOT_HUMAN_PATHS_EXEMPT_TESTS="off"')
    got=$(outcome "$f" "${lines[@]}")
    chk "真实轮询 · $what → $want" "$got" "$want"
    chk "验算命令与真实轮询一致 · $what" "$(predict "$spec" "$ex" "$f")" "$got"
done <<'CASES'
default /setup.sh|on|scripts/check-commit.sh|merge|没追加：钩子调用的脚本照旧被合并（缺口本身）
default /setup.sh /scripts/check-commit.sh|on|scripts/check-commit.sh|human|追加之后：只改脚本 → 交人
default /setup.sh /scripts/check-commit.sh|on|setup.sh|human|追加之后：原条目 /setup.sh 还在 → 交人
default /setup.sh /scripts/check-commit.sh|on|scripts/other.sh|merge|追加之后：无关脚本 → 照常合并
default /scripts/check-commit.sh|on|setup.sh|merge|替换整行（丢了 /setup.sh）→ setup.sh 不再交人
default /setup.sh /scripts/check-commit.sh|off|scripts/check-commit.sh|human|不是测试名 · 豁免关 → 交人
default /setup.sh|on|scripts/check.test.sh|merge|测试名 · 不追加 + 豁免开 → 合并
default /setup.sh|off|scripts/check.test.sh|merge|测试名 · 不追加 + 豁免关 → 仍合并（只关豁免不够）
default /setup.sh /scripts/check.test.sh|on|scripts/check.test.sh|merge|测试名 · 追加 + 豁免开 → 仍合并（只追加不够）
default /setup.sh /scripts/check.test.sh|off|scripts/check.test.sh|human|测试名 · 追加 + 豁免关 → 交人（两步都做）
default /setup.sh /scripts/check-test.sh|on|scripts/check-test.sh|human|测试名 · 改名为不像测试的名字并追加 → 交人
default /setup.sh|on|.githooks/pre-commit|human|钩子本身 → 交人
default /setup.sh|on|.github/workflows/ci.test.yml|human|根目录 .github/ 下名字像测试也拦
CASES
# 改名 / 复制：新旧路径作为一条记录一起判（PR #565 代码复审第 1 轮：拆成两个路径分别验算，和合并检查不一致）
outcome_rec() {   # <改动记录 JSON> [配置行…]
    local r="$1"; shift
    fresh "$@"; happy; files "[$r]"; tick
    if [ "$(merged)" = 1 ]; then echo merge
    elif [ "$(has_label pending/human)" = yes ]; then echo human
    else echo other; fi
}
predict_rename() {   # <清单值> <on|off> <旧路径> <新路径>
    local out rc=0
    out=$(bash "$CHECK" --spec "$1" --exempt-tests "$2" --renamed "$3" "$4") || rc=$?
    case "$rc:$out" in
        0:拦$'\t'"$3 -> $4") echo human ;;
        1:不拦$'\t'"$3 -> $4"$'\t'*) echo merge ;;
        *) echo "error($rc:$out)" ;;
    esac
}
while IFS='|' read -r spec ex st old new want what; do
    [ -n "$spec" ] || continue
    lines=("AUTOPILOT_HUMAN_PATHS=\"$spec\"")
    [ "$ex" = off ] && lines+=('AUTOPILOT_HUMAN_PATHS_EXEMPT_TESTS="off"')
    got=$(outcome_rec "{\"filename\":\"$new\",\"previous_filename\":\"$old\",\"status\":\"$st\"}" "${lines[@]}")
    chk "真实轮询 · $what → $want" "$got" "$want"
    chk "验算命令（--renamed）与真实轮询一致 · $what" "$(predict_rename "$spec" "$ex" "$old" "$new")" "$got"
done <<'CASES'
default|on|renamed|.githooks/a.test.sh|scripts/a.sh|human|改名 · 清单里的测试名 → 清单外的非测试名：拦（复审第 1 轮的例子）
default|on|renamed|.githooks/a.sh|.githooks/a.test.sh|human|改名 · 清单里的非测试名 → 测试名：拦
default|on|renamed|.githooks/a.test.sh|.githooks/b.test.sh|merge|改名 · 测试名 → 测试名，豁免开：不拦
default|off|renamed|.githooks/a.test.sh|.githooks/b.test.sh|human|改名 · 测试名 → 测试名，豁免关：拦
default|on|renamed|scripts/a.test.sh|scripts/a.sh|merge|改名 · 清单外的测试名 → 清单外的非测试名：不拦
default|on|renamed|scripts/a.sh|.githooks/a.sh|human|改名 · 清单外 → 清单里：拦
default|on|copied|.githooks/a.test.sh|scripts/a.sh|human|复制 · 清单里的测试名 → 清单外的非测试名：拦
CASES
# 拆成两个路径分别验算，在第一行那个例子上确实会得出和合并检查不同的结论——所以提示词和文档要求用 --renamed
out=$(bash "$CHECK" --spec default --exempt-tests on .githooks/a.test.sh scripts/a.sh); rc=$?
chk "到达性 · 同一对路径拆成两项验算：两项都不拦（和合并检查不同，这正是 --renamed 存在的原因）" "$rc|$(printf '%s\n' "$out" | cut -f1 | tr '\n' ',')" "1|不拦,不拦,"
# 退出码与输出格式
out=$(bash "$CHECK" --spec 'default /setup.sh' --exempt-tests on setup.sh scripts/check.test.sh scripts/x.sh); rc=$?
chk "验算命令：多个路径逐行给结论、原因分得清，有不拦时退出码 1" "$rc|$out" \
    "1|拦	setup.sh
不拦	scripts/check.test.sh	测试文件豁免（也不在清单里）
不拦	scripts/x.sh	不在清单里"
out=$(bash "$CHECK" --spec 'default /scripts/check.test.sh' --exempt-tests on scripts/check.test.sh); rc=$?
chk "验算命令：命中清单但被豁免 → 原因写明命中清单" "$rc|$out" "1|不拦	scripts/check.test.sh	测试文件豁免（命中清单）"
for args in "--spec|default a/b|--exempt-tests|on|x" "--spec|default|--exempt-tests|yes|x" "--spec|default|--exempt-tests|on" \
            "--exempt-tests|on|x" "--spec|default|--exempt-tests|on|/etc/passwd" "--spec|default|--exempt-tests|on|../x" \
            "--spec|default|--exempt-tests|on|--renamed|a" "--spec|default|--exempt-tests|on|--renamed|../a|b"; do
    IFS='|' read -r -a a <<< "$args"
    out=$(bash "$CHECK" "${a[@]}" 2>/dev/null); rc=$?
    chk "验算命令：用法错误 / 清单写法不认识 → 退出码 2、不给逐路径结论（${args//|/ }）" "$rc|$out" "2|"
done
chk "清单写法不认识：真实轮询交人（验算命令同样不放行）" "$(outcome docs/a.md 'AUTOPILOT_HUMAN_PATHS="default a/b"')" human

# 文档里的验算命令：两份一致；在只有 HOME 和 PATH 的环境里照字面跑（托管安装的技能目录指向本仓库）
cmd_of() { sed -n '/<!-- autopilot-human-paths:check:begin -->/,/<!-- autopilot-human-paths:check:end -->/p' "$1" | sed '1,2d;$d' | sed '$d'; }
CMD_EN=$(cmd_of "$REPO_DIR/docs/operations.md"); CMD_ZH=$(cmd_of "$REPO_DIR/docs/operations.zh.md")
chk "两份文档的验算命令一致、不是空的" "$([ -n "$CMD_EN" ] && [ "$CMD_EN" = "$CMD_ZH" ] && echo yes || echo no)" yes
DOC_HOME="$SANDBOX/doc-home"; mkdir -p "$DOC_HOME/.agents/skills"; ln -sfn "$REPO_DIR" "$DOC_HOME/.agents/skills/cavil-loop"
out=$(env -i HOME="$DOC_HOME" PATH="/usr/bin:/bin" LANG=C.UTF-8 bash -c "$CMD_EN" 2>&1); rc=$?
chk "文档命令照字面跑：三个路径都拦、退出码 0" "$rc|$out" "0|拦	scripts/check-commit.sh
拦	setup.sh
拦	.githooks/pre-commit"
spec_in_cmd=$(printf '%s\n' "$CMD_EN" | sed -n "s/.*--spec '\([^']*\)'.*/\1/p")
chk "文档命令验算的清单值就是示例块里新加的那一行" \
    "$(ex_of "$REPO_DIR/docs/operations.md" | grep -cxF "AUTOPILOT_HUMAN_PATHS=\"$spec_in_cmd\"")" 1

section "【12】托管复审提示词：配了清单才多一段「钩子调用的文件」；没配时和改动前逐字节一样"
compose() {   # <scripts 根> <模板名> [环境变量…]
    local root="$1" name="$2"; shift 2
    (cd "$W/project" && env "$@" CODING_AGENT_CONFIG="$CONF" bash -c 'source "$1/_lib.sh" >/dev/null 2>&1; f=$(compose_prompt_template "$2"); [ -n "$f" ] && cat "$f"' _ "$root" "$name" 2>/dev/null | strip_review_converge)   # GitHub#621 的两段不归这里的对拍管
}
AP=(DISPATCH_AUTOPILOT=1 DISPATCH_AUTOPILOT_ISSUE=7)
SEC='^# 托管复审加一步：钩子调用的文件'
for line in "" 'AUTOPILOT_HUMAN_PATHS=""'; do
    if [ -n "$line" ]; then fresh "$line"; else fresh; fi
    for name in review new-issue issue-comment pr-comment; do
        new=$(compose "$SCRIPTS" "$name" "${AP[@]}"); old=$(compose "$SANDBOX/old/scripts" "$name" "${AP[@]}")
        chk "没配清单（${line:-不写这一行}）· 托管 $name 提示词和改动前逐字节一样" \
            "$([ -n "$new" ] && [ "$new" = "$old" ] && echo same || echo differ)" same
    done
    chk "到达性 · 比的是带托管规则的复审提示词" "$(compose "$SCRIPTS" review "${AP[@]}" | grep -c '^# 托管规则')" 1
done
fresh 'AUTOPILOT_HUMAN_PATHS="default,/setup.sh"'
n=$(compose "$SCRIPTS" review "${AP[@]}")
chk "配了清单 · 托管复审提示词多出这一段、排在托管规则之后、没有没换掉的占位" \
    "$(printf '%s\n' "$n" | grep -c "$SEC")/$(printf '%s\n' "$n" | awk -v s="$SEC" '/^# 托管规则/{a=NR} $0~s{b=NR} END{print (b>a && a>0)?"yes":"no"}')/$(printf '%s\n' "$n" | grep -c '@@')" "1/yes/0"
chk "配了清单 · 原样值照抄进来（逗号分隔也原样）" "$(printf '%s\n' "$n" | grep -cxF 'default,/setup.sh')" 1
# shellcheck disable=SC2016
want_list=$(bash -c 'source "$1/_human_paths.sh"; jq -rn --arg spec "default,/setup.sh" --arg def "$AUTOPILOT_HUMAN_PATHS_DEFAULT" "$AUTOPILOT_PATHS_JQ"'"'"'rules($spec; $def) | map("`" + .raw + "`") | join(" ")'"'" _ "$SCRIPTS")
chk "配了清单 · 展开后的条目和合并检查用的规则展开结果一样" "$([ -n "$want_list" ] && printf '%s\n' "$n" | grep -cF -- "- 展开后 daemon 实际比对的条目：$want_list")" 1
# 列出的每一条，验算命令都判拦（同一份规则的另一个出口）
bad_entries=0; n_entries=0
for e in $(printf '%s' "$want_list" | tr -d '`'); do
    p="${e#/}"; case "$p" in */) p="${p}x" ;; esac
    n_entries=$((n_entries+1))
    [ "$(predict 'default,/setup.sh' on "$p")" = human ] || bad_entries=$((bad_entries+1))
done
chk "展开列出的每一条（共 15 条），验算命令都判拦" "$n_entries/$bad_entries" "15/0"
chk "配了清单 · 完整建议行是「原值 + 追加」" "$(printf '%s\n' "$n" | grep -cF 'AUTOPILOT_HUMAN_PATHS="default,/setup.sh <路径>"')" 1
chk "配了清单 · 提示词要求改名 / 复制的文件用 --renamed 一起交进去" "$(printf '%s\n' "$n" | grep -c '改名 / 复制的文件\*\*必须\*\*用 `--renamed')" 1
chk "配了清单 · 验算命令写的是本次能跑的路径" "$(printf '%s\n' "$n" | grep -cF "bash '$SCRIPTS/human-paths-check.sh' --spec")" 1
chk "豁免没写 → 写明开着、验算传 on" "$(printf '%s\n' "$n" | grep -c '^- 测试文件豁免：开着.*--exempt-tests on')" 1
fresh 'AUTOPILOT_HUMAN_PATHS="default"' 'AUTOPILOT_HUMAN_PATHS_EXEMPT_TESTS="off"'
chk "豁免 off → 写明关着、验算传 off" "$(compose "$SCRIPTS" review "${AP[@]}" | grep -c '^- 测试文件豁免：关着.*--exempt-tests off')" 1
for v in "default /a'b" 'default /$HOME' 'default /a\b' 'default /a`b' 'default /a"b'; do
    q=$(printf '%q' "$v")
    fresh "AUTOPILOT_HUMAN_PATHS=$q"
    n=$(compose "$SCRIPTS" review "${AP[@]}")
    chk "原值含照抄易错的字符（$v）→ 原样列出，不给完整配置行，只写末尾追加" \
        "$(printf '%s\n' "$n" | grep -c "$SEC")/$(printf '%s\n' "$n" | grep -cxF -- "$v")/$(printf '%s\n' "$n" | grep -cF '<路径>"`')/$(printf '%s\n' "$n" | grep -c '现有的值末尾追加')" "1/1/0/1"
done
fresh "$ON"
for name in new-issue issue-comment pr-comment; do
    w=$(compose "$SCRIPTS" "$name" "${AP[@]}")
    chk "配了清单 · worker 的 $name 提示词有托管规则、没有这一段" "$(printf '%s\n' "$w" | grep -c '^# 托管规则')/$(printf '%s\n' "$w" | grep -c "$SEC")" "1/0"
done
r=$(compose "$SCRIPTS" review)
chk "配了清单 · 不是托管条目的复审：提示词拼出来了、没有这一段" "$([ -n "$r" ] && echo yes || echo no)/$(printf '%s\n' "$r" | grep -c "$SEC")" "yes/0"

echo
compat_summary
echo "通过 $pass / 失败 $fail"
report_counts "$pass" "$fail"
[ "$fail" -eq 0 ]
