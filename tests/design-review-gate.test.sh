#!/usr/bin/env bash
# 设计方案复审开关（GitHub#102）：REVIEW_DESIGN_PROPOSALS 决定「写完方案 / 修订方案翻哪个标签」。
#
# 跑法：bash tests/design-review-gate.test.sh
# 依赖：git、python3。不碰网络（假 gh、假 tmux），HOME 指到临时目录。
#
# 全部跑真实的派工脚本（dispatch-new-issue.sh / dispatch-issue-comment.sh），读它们写出的
# 那份给 worker 的提示词，不断言源码文本：
#   【1】开关关着（复审关卡开 / 不开两种）：提示词和改动前（merge-base 上的 scripts + prompts）
#        渲染出来的逐字节一致——没开这一项的项目什么都没变
#   【2】开关开着但没配复审标签：照样交人，也和改动前逐字节一致（不会翻进一个空标签）
#   【3】开关开着 + 复审关卡开：方案、修订方案的出口是复审标签，并带「打回是改方案」的说明；
#        澄清答复仍直接交人；PR 的交付出口不变
#   【4】项目自己在追加要求里写「方案交复审」（tutor 的做法）：开关开 / 关下，最后生效的
#        那句都是交复审——开关上线不打断这种项目
#   【5】负对照：沙盘副本逐个改坏，对应检查必须变红
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
TMP=$(mktemp -d)
trap '[ -n "${KEEP:-}" ] && echo "TMP=$TMP" || rm -rf "$TMP"' EXIT

pass=0; fail=0
ok()  { echo "  ✅ $1"; pass=$((pass + 1)); }
bad() { echo "  ❌ $1"; [ -n "${2:-}" ] && printf '     %s\n' "$2"; fail=$((fail + 1)); }

# ── 改动前的版本 ──
BASE_REV=$(git -C "$REPO_DIR" merge-base HEAD origin/main 2>/dev/null || git -C "$REPO_DIR" rev-parse HEAD~1)
mkdir -p "$TMP/old"
git -C "$REPO_DIR" archive "$BASE_REV" scripts prompts | tar -x -C "$TMP/old"
mkdir -p "$TMP/new"; cp -r "$REPO_DIR/scripts" "$REPO_DIR/prompts" "$TMP/new/"

# ── 假 gh / 假 tmux ──
mkdir -p "$TMP/bin" "$TMP/home"
cat > "$TMP/bin/gh" <<'SH'
#!/usr/bin/env bash
case "$*" in
    *"--jq .title"*|*title*) echo "测试标题" ;;
    *) echo "{}" ;;
esac
exit 0
SH
cat > "$TMP/bin/tmux" <<'SH'
#!/usr/bin/env bash
case "$1" in has-session) exit 1 ;; esac
exit 0
SH
chmod +x "$TMP/bin/gh" "$TMP/bin/tmux"

# ── 两个被派工的「项目」：一个没有追加要求，一个像 tutor 那样在追加要求里写了方案交复审 ──
make_project() { # $1 = 名字；$2 = tutor（带追加要求）/ plain
    local d="$TMP/proj-$1"
    git init -q --bare "$d/upstream.git"
    git clone -q "$d/upstream.git" "$d/seed" 2>/dev/null
    (
        cd "$d/seed" || exit 1
        git config user.email t@example.invalid; git config user.name t
        echo x > f
        if [ "$2" = tutor ]; then
            local P=.agents/skills/cavil-loop/prompts
            mkdir -p "$P"
            # 结构照 tutor 的追加要求：新方案、修订方案两处都写「翻 LABEL_REVIEW_OR_HUMAN」
            cat > "$P/new-issue.extra.md" <<'MD'
## 设计方案（本项目）

3. **翻 label**：
   `flip_label ${ISSUE} --add ${LABEL_REVIEW_OR_HUMAN} --remove ${LABEL_AGENT_DOING}`
   > **设计方案同样要过交叉 review**：翻 `${LABEL_REVIEW_OR_HUMAN}`。
MD
            cat > "$P/issue-comment.extra.md" <<'MD'
### § B. 方案迭代（本项目）

3. 翻 label：`flip_label ${ISSUE} --add ${LABEL_REVIEW_OR_HUMAN} --remove ${LABEL_AGENT_DOING}`
   > 修订版方案同样先过 codex review 再到人面前
MD
        fi
        git add -A && git commit -qm init && git push -q origin HEAD:main
    ) >/dev/null 2>&1
    echo "$d"
}
PLAIN=$(make_project plain plain)
TUTOR=$(make_project tutor tutor)

N_NEW=987711; N_CMT=987712
# render <scripts+prompts 根> <项目> <review 标签或空> <开关值或 unset> <输出目录>
# 写出 <输出目录>/new-issue.md 和 issue-comment.md
render() {
    local root="$1" proj="$2" review="$3" sw="$4" out="$5" w
    w="$out.work"; rm -rf "$w" "$out"; mkdir -p "$w/state" "$w/wt" "$out"
    git clone -q "$proj/upstream.git" "$w/project" 2>/dev/null
    {
        cat <<CONF
REPO="example/none"
PROJECT_ROOT="$w/project"
WORKTREE_BASE="$w/wt"
STATE_DIR="$w/state"
TMUX_PREFIX="drg"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
LABEL_AGENT_DOING="doing/agent"
LABEL_PENDING_REVIEW="$review"
WORKER_AGENT_DEFAULT="claude"
PATH="$TMP/bin:\$PATH"
GH_TOKEN="fake-token-for-test"
CONF
        [ "$sw" = unset ] || echo "REVIEW_DESIGN_PROPOSALS=\"$sw\""
    } > "$w/config"
    rm -f "/tmp/cavil-loop-issue-$N_NEW-prompt.md" "/tmp/cavil-loop-issue-$N_CMT-cmt-0.md"
    (cd "$w/project" && env -u CODING_AGENT_RELEASE_ROOT -u REVIEW_DESIGN_PROPOSALS HOME="$TMP/home" CODING_AGENT_CONFIG="$w/config" \
        bash "$root/scripts/dispatch-new-issue.sh" "$N_NEW") >/dev/null 2>&1
    (cd "$w/project" && env -u CODING_AGENT_RELEASE_ROOT -u REVIEW_DESIGN_PROPOSALS HOME="$TMP/home" CODING_AGENT_CONFIG="$w/config" \
        bash "$root/scripts/dispatch-issue-comment.sh" "$N_CMT" 0) >/dev/null 2>&1
    # 只把每次运行都会变的东西（时间戳、脚本所在目录）换成固定字样，其余逐字节保留
    local f kind
    for kind in new-issue:"/tmp/cavil-loop-issue-$N_NEW-prompt.md" issue-comment:"/tmp/cavil-loop-issue-$N_CMT-cmt-0.md"; do
        f="${kind#*:}"; kind="${kind%%:*}"
        if [ -s "$f" ]; then
            sed -e "s|$root|<ROOT>|g" -e "s|$w|<W>|g" -e 's/20[0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9]/<TS>/g' "$f" > "$out/$kind.md"
        fi
        rm -f "$f"
    done
}

# 「方案写完翻哪个标签」：通用模板（追加要求之前）里那一句
design_flip()   { sed -n '/^# 本项目的附加要求/q;p' "$1" | grep -m1 -oE "flip_label $2 --add [^ ]+ --remove doing/agent" | awk '{print $4}'; }
# 修订版方案：§ B 第 4 步
revise_flip()   { sed -n '/^### § B\. 方案迭代/,/^### § C/p' "$1" | grep -m1 -oE "flip_label $N_CMT --add [^ ]+ --remove doing/agent" | awk '{print $4}'; }
clarify_flip()  { sed -n '/^### § C\. 澄清答复/,/^## /p' "$1" | grep -m1 -oE "flip_label $N_CMT --add [^ ]+ --remove doing/agent" | awk '{print $4}'; }
pr_flip()       { grep -m1 -oE 'flip_label <P> --add [^ `]+' "$1" | awk '{print $4}'; }
# 项目追加要求（排在最后、冲突时以它为准）里方案交给谁
overlay_flip()  { sed -n '/^# 本项目的附加要求/,$p' "$1" | grep -m1 -oE "flip_label $2 --add [^ ]+ --remove doing/agent" | awk '{print $4}'; }

run_check() { # $1 = 被测的 scripts+prompts 根；打印 PASS/FAIL <检查名> :: 细节
    local R="$1" O="$TMP/out" o n
    mkdir -p "$O"
    # 改动前的版本（同一套项目和配置）作对照
    for v in off-noreview:"" off-review:"pending/review" on-noreview:"" ; do
        n="${v%%:*}"; [ -d "$O/old-$n" ] || render "$TMP/old" "$PLAIN" "${v#*:}" "$( [ "${n%%-*}" = on ] && echo true || echo false )" "$O/old-$n"
    done

    # 【1】【2】和改动前逐字节一致
    render "$R" "$PLAIN" "" unset "$O/a"; render "$R" "$PLAIN" "pending/review" unset "$O/b"
    render "$R" "$PLAIN" "" true "$O/c";  render "$R" "$PLAIN" "pending/review" false "$O/d"
    for pair in "a:off-noreview:没配复审、没写开关" "b:off-review:开了复审关卡、没写开关" \
                "d:off-review:开了复审关卡、开关写 false" "c:on-noreview:开关开着但没配复审标签"; do
        IFS=: read -r cur ref what <<<"$pair"
        for k in new-issue issue-comment; do
            if [ ! -s "$O/$cur/$k.md" ] || [ ! -s "$O/old-$ref/$k.md" ]; then echo "FAIL same_${cur}_$k :: 没写出提示词"; continue; fi
            if cmp -s "$O/$cur/$k.md" "$O/old-$ref/$k.md"; then echo "PASS same_${cur}_$k :: $what：$k 提示词和改动前逐字节一致"
            else echo "FAIL same_${cur}_$k :: $what：$k 提示词和改动前不同：$(diff "$O/old-$ref/$k.md" "$O/$cur/$k.md" | head -4 | tr '\n' ' ')"; fi
        done
    done
    for cur in a b c d e; do
        for k in new-issue issue-comment; do
            [ -s "$O/$cur/$k.md" ] || continue
            if grep -q 'DESIGN_REVIEW' "$O/$cur/$k.md"; then echo "FAIL unrendered_$k :: $k 里有没换掉的占位"; fi
        done
    done

    # 【3】开关开 + 复审关卡开
    render "$R" "$PLAIN" "pending/review" true "$O/e"
    o="$(design_flip "$O/e/new-issue.md" "$N_NEW")"
    [ "$o" = pending/review ] && echo "PASS on_new :: 新方案翻复审标签" || echo "FAIL on_new :: 新方案翻的是 [$o]"
    o="$(revise_flip "$O/e/issue-comment.md")"
    [ "$o" = pending/review ] && echo "PASS on_revise :: 修订版方案翻复审标签" || echo "FAIL on_revise :: 修订版方案翻的是 [$o]"
    for k in new-issue issue-comment; do
        if grep -q '打回，那时是改方案，不是去实现' "$O/e/$k.md"; then echo "PASS on_note_$k :: $k 写明打回是改方案"
        else echo "FAIL on_note_$k :: $k 没写「打回是改方案」"; fi
    done
    o="$(clarify_flip "$O/e/issue-comment.md")"
    [ "$o" = pending/human ] && echo "PASS on_clarify :: 澄清答复仍直接交人" || echo "FAIL on_clarify :: 澄清答复翻的是 [$o]"
    o="$(pr_flip "$O/e/issue-comment.md")"
    [ "$o" = pending/review ] && echo "PASS on_pr :: 开 PR 后仍交复审" || echo "FAIL on_pr :: 开 PR 后翻的是 [$o]"
    # 开关关着（复审关卡开）时，方案仍交人——确认【1】的对拍不是两边都没有这一句
    o="$(design_flip "$O/b/new-issue.md" "$N_NEW")"
    [ "$o" = pending/human ] && echo "PASS off_new :: 开关关着：新方案直接交人" || echo "FAIL off_new :: 开关关着：新方案翻的是 [$o]"
    o="$(revise_flip "$O/b/issue-comment.md")"
    [ "$o" = pending/human ] && echo "PASS off_revise :: 开关关着：修订版方案直接交人" || echo "FAIL off_revise :: 开关关着：修订版方案翻的是 [$o]"

    # 【4】tutor 的做法：追加要求里写方案交复审
    for sw in false true; do
        render "$R" "$TUTOR" "pending/review" "$sw" "$O/t-$sw"
        o="$(overlay_flip "$O/t-$sw/new-issue.md" "$N_NEW")"
        [ "$o" = pending/review ] && echo "PASS tutor_new_$sw :: 追加要求写了方案交复审、开关=$sw：新方案最后生效的是交复审" \
            || echo "FAIL tutor_new_$sw :: 追加要求写了方案交复审、开关=$sw：新方案最后生效的是 [$o]"
        o="$(overlay_flip "$O/t-$sw/issue-comment.md" "$N_CMT")"
        [ "$o" = pending/review ] && echo "PASS tutor_revise_$sw :: 追加要求写了方案交复审、开关=$sw：修订版最后生效的是交复审" \
            || echo "FAIL tutor_revise_$sw :: 追加要求写了方案交复审、开关=$sw：修订版最后生效的是 [$o]"
    done
    # 追加要求在开关关着时，和改动前拼出来的也逐字节一致
    [ -d "$O/old-tutor" ] || render "$TMP/old" "$TUTOR" "pending/review" false "$O/old-tutor"
    for k in new-issue issue-comment; do
        if [ -s "$O/t-false/$k.md" ] && cmp -s "$O/t-false/$k.md" "$O/old-tutor/$k.md"; then
            echo "PASS tutor_same_$k :: 追加要求写了方案交复审、开关关着：$k 提示词和改动前逐字节一致"
        else echo "FAIL tutor_same_$k :: 追加要求写了方案交复审、开关关着：$k 提示词和改动前不同"; fi
    done
}

report() { while IFS= read -r l; do
    case "$l" in
        PASS\ *) n="${l#PASS }"; ok "${n#* :: }" ;;
        FAIL\ *) n="${l#FAIL }"; bad "${n%% ::*}" "${n#* :: }" ;;
    esac
done; }

echo "【1–4】本版"
run_check "$TMP/new" > "$TMP/main.out"
report < "$TMP/main.out"

# 【5】负对照：改坏一处，对应检查必须变红
echo "【5】负对照（改坏一处，对应检查必须变红）"
neg() { # $1 = 说明；$2 = 文件（相对根）；$3 = 原文；$4 = 改成；$5 = 期望变红的检查名
    local sb="$TMP/neg-$5"
    rm -rf "$sb"; mkdir -p "$sb"; cp -r "$REPO_DIR/scripts" "$REPO_DIR/prompts" "$sb/"
    python3 - "$sb/$2" "$3" "$4" <<'PY' || { bad "$1：改坏失败（原文没找到）"; return; }
import sys
p, old, new = sys.argv[1:4]
s = open(p).read()
if old not in s:
    sys.exit(1)
open(p, "w").write(s.replace(old, new, 1))
PY
    run_check "$sb" > "$sb/check.out" 2>/dev/null
    if grep -q "^FAIL $5 " "$sb/check.out"; then ok "$1 → $5 变红"
    else bad "$1 → $5 没变红（这条检查拦不住这种改坏）"; fi
}
neg "新方案出口仍写死交人" prompts/new-issue.template.md \
    'flip_label ${ISSUE} --add ${LABEL_DESIGN_REVIEW_OR_HUMAN}' 'flip_label ${ISSUE} --add ${LABEL_PENDING_HUMAN}' on_new
neg "修订版方案出口仍写死交人" prompts/issue-comment.template.md \
    '4. 翻 label：`flip_label ${ISSUE} --add ${LABEL_DESIGN_REVIEW_OR_HUMAN}' '4. 翻 label：`flip_label ${ISSUE} --add ${LABEL_PENDING_HUMAN}' on_revise
neg "澄清答复也被改成交复审" prompts/issue-comment.template.md \
    '2. 翻 label：`flip_label ${ISSUE} --add ${LABEL_PENDING_HUMAN}' '2. 翻 label：`flip_label ${ISSUE} --add ${LABEL_DESIGN_REVIEW_OR_HUMAN}' on_clarify
neg "新 issue 派工脚本漏了新占位" scripts/dispatch-new-issue.sh \
    '        -e "s|\${LABEL_DESIGN_REVIEW_OR_HUMAN}|$LABEL_DESIGN_REVIEW_OR_HUMAN|g" \'$'\n' '' unrendered_new-issue
neg "issue 评论派工脚本漏了新占位" scripts/dispatch-issue-comment.sh \
    '        -e "s|\${LABEL_DESIGN_REVIEW_OR_HUMAN}|$LABEL_DESIGN_REVIEW_OR_HUMAN|g" \'$'\n' '' unrendered_issue-comment
neg "开关开着、没配复审标签也翻复审（渲染成空标签）" scripts/_lib.sh \
    '        if [ -n "$LABEL_PENDING_REVIEW" ]; then' '        if true; then' same_c_new-issue
neg "开关关着也写出复审说明" scripts/_lib.sh \
    'DESIGN_REVIEW_NOTE=""' 'DESIGN_REVIEW_NOTE="（多出来的话）"' same_b_new-issue
neg "开关默认值改成开" scripts/_lib.sh \
    'REVIEW_DESIGN_PROPOSALS="${REVIEW_DESIGN_PROPOSALS:-false}"' 'REVIEW_DESIGN_PROPOSALS="${REVIEW_DESIGN_PROPOSALS:-true}"' same_b_new-issue
neg "开关关着时连追加要求里的交复审也变成交人" scripts/_lib.sh \
    'DESIGN_REVIEW_NOTE=""' 'DESIGN_REVIEW_NOTE=""; LABEL_REVIEW_OR_HUMAN="$LABEL_DESIGN_REVIEW_OR_HUMAN"' tutor_new_false
neg "开关不认 true" scripts/_lib.sh '    true|1|yes|on)' '    1|yes|on)' on_new

echo "通过 $pass，失败 $fail"
[ "$fail" -eq 0 ]
