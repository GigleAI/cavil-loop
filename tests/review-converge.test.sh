#!/usr/bin/env bash
# kind: e2e
# 复审收敛与 REVIEW.md（GitHub#621）。
#
# 跑法：bash tests/review-converge.test.sh（约 1 分钟：36 次真实派工）
# 依赖：git（merge-tree --write-tree，2.38 起）、jq、python3。不碰网络：假 gh，HOME 指到临时目录。
#
#   【1】REVIEW.md 三态 × 全部入口：本地裸仓库当 origin、有状态的假 GitHub，真实派工脚本写出新 issue、
#        issue 回复、PR 回复、拆出的子 issue 四个 worker 入口和普通 / 托管复审的提示词，另有一个整份替换了
#        复审 / worker 模板的项目。主干有 → 复审含全文、worker 含自查句；主干确认没有 → 都不含；读不到
#        （远端引用不在 / 是目录）→ 都含「未能读取」；只在本地工作区有 → 不含。继承来的派工环境一律清掉
#   【2】收敛段送达：每份复审 prompt 都有、worker prompt 都没有；托管复审时托管规则段排在它后面
#   【3】修复范围脚本：真实 git 仓库里造跨轮历史，docs/operations.md 两张表每行一例；往返记录里的复审节
#        （GitHub#676：记录由真实的 round-log.sh post 写出）
#   【4】问题编号不带井号：六份成品里的编号规则、返工回应句、「只有真的 issue / PR 才写 #编号」，示例按自动链接规则对拍
#
# ── Problem numbers in review lists (GitHub#646); read before changing ──
# Reviews number problems 「问题 1」「问题 2」, never `#1`: GitHub turns `#1` into a link to issue 1, and the lists
# on #644 / PR #645 were full of links to old issues. The rule lives in `prompts/review-converge.md` (with the
# transition: a list written with `#N` earlier is read as problem N); the one rework sentence
# 「按复审结论里的问题编号逐条回应…」 is byte-identical in `issue-comment.template.md` and `pr-comment.template.md`
# (the two entries that handle rework; a split sub-issue goes through the issue-comment one); 「只有真的 issue /
# PR 才写 `#编号`」 is item 11 of the four hand-off sections plus the review-comment paragraph of
# `review.template.md` (`tests/plain-language-prompts.test.sh` diffs those copies). 【4】 checks the six prompts
# the real dispatch scripts write, and runs the sentence's own example through GitHub's autolink rule.
set -uo pipefail
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
# shellcheck source=lib/prompt-files.sh
source "$TEST_DIR/lib/prompt-files.sh"
TMP=$(mktemp -d)
trap '[ -n "${KEEP:-}" ] && echo "TMP=$TMP" || rm -rf "$TMP"' EXIT
export TZ=UTC GIT_CONFIG_GLOBAL="$TMP/gitconfig" GIT_CONFIG_NOSYSTEM=1
printf '[user]\n\tname = t\n\temail = t@example.invalid\n[init]\n\tdefaultBranch = main\n' > "$GIT_CONFIG_GLOBAL"

pass=0; fail=0
ok()  { echo "  ✅ $1"; pass=$((pass + 1)); }
bad() { echo "  ❌ $1"; [ -n "${2:-}" ] && printf '     %s\n' "$2"; fail=$((fail + 1)); }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "期望「$3」，实得「$2」"; fi; }

CONVERGE_HEAD='# 复审收敛规则：首轮一次报全，之后只复核修复'
MD_HEAD='# 本项目的审查标准（仓库根目录 REVIEW.md）'
MD_BODY='本项目的独特审查标准：数据口径错一律必须改'
WORKER_LINE='交出 PR 或方案之前，先读它'
UNREAD_REVIEW='本项目 REVIEW.md 未能读取（不代表没有）：本轮按全量复审'
UNREAD_WORKER='REVIEW.md 未能读取（daemon 拼这份说明时读不到主干上的它'

# ════════ 【1】【2】拼 prompt：全部经真实的派工脚本 ════════
# 继承来的派工环境（本测试可能正跑在一个复审 / 托管派工的会话里）一律清掉，每次派工只带这里写明的变量
CLEAN_ENV=(-u DISPATCH_PROMPT_KIND -u DISPATCH_AUTOPILOT -u DISPATCH_AUTOPILOT_ISSUE -u DISPATCH_AUTOPILOT_PR
           -u DISPATCH_AUTOPILOT_WHERE -u CODING_AGENT_RELEASE_ROOT -u CODING_AGENT_CONFIG -u DISPATCH_STUCK_RELEASE)
mkdir -p "$TMP/bin" "$TMP/home"
bash "$TEST_DIR/lib/fake_gh_client.sh" install "$TMP/bin/gh" python3 "$TEST_DIR/lib/fake_github.py"
cat > "$TMP/bin/tmux" <<'SH'
#!/usr/bin/env bash
case "$1" in has-session) exit 1 ;; ls|list-sessions) exit 0 ;; esac
exit 0
SH
printf '#!/usr/bin/env bash\nexit 0\n' > "$TMP/bin/claude"
chmod +x "$TMP/bin/tmux" "$TMP/bin/claude"

N_NEW=962001; N_CMT=962002; N_PR=962003; N_SUB=962004; N_PARENT=962050
items_json() {
    jq -n --arg n "$N_NEW" --arg c "$N_CMT" --arg p "$N_PR" --arg s "$N_SUB" --arg pa "$N_PARENT" '{
        ($n): {kind:"issue", state:"open", title:"新需求", body:"做一件事", user:{login:"maint"}},
        ($c): {kind:"issue", state:"open", title:"有新评论的需求", body:"x", user:{login:"maint"}},
        ($p): {kind:"pr", state:"open", merged:false, title:"自己的 PR", body:"x", user:{login:"loop-bot"},
               head:{sha:"1111111111111111111111111111111111111111", ref:("feature/issue-" + $p), repo:{full_name:"example/rc"}}, base:{ref:"main"}},
        ($s): {kind:"issue", state:"open", title:"子项", user:{login:"loop-bot"},
               body:("拆出来的一块\n\n<!-- agent-split-from: #" + $pa + " -->"),
               parent_issue_url:("https://api.github.com/repos/example/rc/issues/" + $pa)},
        ($pa): {kind:"issue", state:"open", title:"父 issue", body:"x", user:{login:"maint"}}
    }'
}

# make_project <名字> <REVIEW.md 怎么放：remote / none / dir> [replace]
make_project() {
    local d="$TMP/proj-$1"
    git init -q --bare -b main "$d/upstream.git"
    git clone -q "$d/upstream.git" "$d/seed" 2>/dev/null
    (
        cd "$d/seed" || exit 1
        echo x > f
        case "$2" in
            remote) printf '# REVIEW\n\n%s\n' "$MD_BODY" > REVIEW.md ;;
            dir) mkdir REVIEW.md; echo y > REVIEW.md/inner ;;
        esac
        if [ "${3:-}" = replace ]; then
            local P=.agents/skills/cavil-loop/prompts t
            mkdir -p "$P"
            printf '项目自己的复审模板，整份替换工具的。\n' > "$P/review.template.md"
            for t in new-issue issue-comment pr-comment; do printf '项目自己的 worker 模板，整份替换工具的。\n' > "$P/$t.template.md"; done
        fi
        git add -A && git commit -qm init && git push -q origin HEAD:main
    ) >/dev/null 2>&1
    git clone -q "$d/upstream.git" "$d/project" 2>/dev/null
    mkdir -p "$d/state" "$d/wt" "$d/gh"
    cat > "$d/config" <<CONF
REPO="example/rc"
PROJECT_ROOT="$d/project"
WORKTREE_BASE="$d/wt"
STATE_DIR="$d/state"
TMUX_PREFIX="rcv"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
LABEL_PENDING_BLOCKED=""
LABEL_PENDING_LATER=""
LABEL_PENDING_PR="pending/PR"
LABEL_AGENT_DOING="doing/agent"
LABEL_PENDING_REVIEW="pending/review"
LABEL_AUTOPILOT="autopilot"
LABEL_PENDING_MERGE="pending/merge"
POST_MERGE_RETROSPECTIVE=false
PRICE_AUTO_FETCH=0
AGENT_TRUST_PROMPT_WAIT_SECS=1
WORKER_SECRET_ENV=""
WORKER_AGENT_DEFAULT="claude"
PATH="$TMP/bin:\$PATH"
GH_TOKEN="fake-token-for-test"
CONF
    chmod 600 "$d/config"
    echo '{}' > "$d/gh/events.json"; echo '{}' > "$d/gh/perms.json"; echo loop-bot > "$d/gh/me"
    items_json > "$d/gh/items.json"
    jq -n --arg n "$N_NEW" --arg c "$N_CMT" --arg p "$N_PR" --arg s "$N_SUB" \
        '{($n): ["pending/agent"], ($c): ["pending/agent"], ($p): ["pending/agent"], ($s): ["pending/agent"]}' > "$d/gh/labels.base"
    echo "$d"
}

# dispatch_all <项目目录> <输出目录>：真实派工脚本写出 new-issue / issue-comment / pr-comment / sub-issue /
# review（issue 评论派工，DISPATCH_PROMPT_KIND=review）/ review-autopilot（再加托管标记）六份提示词
dispatch_all() {
    local d="$1" out="$2" name f
    mkdir -p "$out"
    for name in new-issue issue-comment pr-comment sub-issue review review-autopilot; do
        prompt_files_clear "$REPO_DIR" "$d/state"
        cp "$d/gh/labels.base" "$d/gh/labels.json"
        local extra=() cmd=()
        case "$name" in
            new-issue) cmd=(dispatch-new-issue.sh "$N_NEW") ;;
            sub-issue) cmd=(dispatch-new-issue.sh "$N_SUB") ;;
            issue-comment) cmd=(dispatch-issue-comment.sh "$N_CMT" 0) ;;
            pr-comment) cmd=(dispatch-pr-comment.sh "$N_PR" "feature/issue-$N_PR" 0) ;;
            review) cmd=(dispatch-issue-comment.sh "$N_CMT" 0); extra=(DISPATCH_PROMPT_KIND=review) ;;
            review-autopilot) cmd=(dispatch-issue-comment.sh "$N_CMT" 0)
                extra=(DISPATCH_PROMPT_KIND=review DISPATCH_AUTOPILOT=1 "DISPATCH_AUTOPILOT_ISSUE=$N_CMT") ;;
        esac
        (cd "$d/project" && env "${CLEAN_ENV[@]}" HOME="$TMP/home" FAKE_GH_DIR="$d/gh" FAKE_GH_REPO=example/rc CODING_AGENT_CONFIG="$d/config" "${extra[@]}" \
            timeout 120 bash "$REPO_DIR/scripts/${cmd[0]}" "${cmd[@]:1}") >/dev/null 2>&1
        case "$name" in
            new-issue) f=$(prompt_file_of "$REPO_DIR" "$d/state" new "$N_NEW") ;;
            sub-issue) f=$(prompt_file_of "$REPO_DIR" "$d/state" new "$N_SUB") ;;
            pr-comment) f=$(prompt_file_of "$REPO_DIR" "$d/state" pr "$N_PR") ;;
            *) f=$(prompt_file_of "$REPO_DIR" "$d/state" cmt "$N_CMT" 0) ;;
        esac
        : > "${out:?}/${name:?}.md"; [ -s "$f" ] && cp "$f" "${out:?}/${name:?}.md"
    done
}

has() { grep -qF -- "$2" "$1"; }
WORKERS=(new-issue issue-comment pr-comment sub-issue)

# 一份项目的全部成品对一种期望
expect_set() {   # <标签> <输出目录> present|absent|unreadable
    local tag="$1" out="$2" st="$3" w f probs=""
    for f in review review-autopilot "${WORKERS[@]}"; do [ -s "$out/$f.md" ] || probs+="$f 派工没写出提示词; "; done
    for f in review review-autopilot; do
        has "$out/$f.md" "$CONVERGE_HEAD" || probs+="$f 没有收敛段; "
        case "$st" in
            present) has "$out/$f.md" "$MD_BODY" || probs+="$f 没有 REVIEW.md 全文; " ;;
            absent) has "$out/$f.md" "$MD_HEAD" && probs+="$f 有 REVIEW.md 段; " ;;
            unreadable) has "$out/$f.md" "$UNREAD_REVIEW" || probs+="$f 没有「未能读取」; "
                        has "$out/$f.md" "$MD_BODY" && probs+="$f 带了全文; " ;;
        esac
    done
    for w in "${WORKERS[@]}"; do
        has "$out/$w.md" "$CONVERGE_HEAD" && probs+="$w 有收敛段; "
        has "$out/$w.md" "$MD_BODY" && probs+="$w 贴了 REVIEW.md 全文; "
        case "$st" in
            present) has "$out/$w.md" "$WORKER_LINE" || probs+="$w 没有自查句; " ;;
            absent) has "$out/$w.md" "$MD_HEAD" && probs+="$w 有 REVIEW.md 段; " ;;
            unreadable) has "$out/$w.md" "$UNREAD_WORKER" || probs+="$w 没有「未能读取」; " ;;
        esac
    done
    # 到达性：各入口确实走到了各自的路径
    has "$out/sub-issue.md" '只做本子项正文写明的那一块' || probs+="sub-issue 没走子项路径; "
    has "$out/review-autopilot.md" '# 托管规则（本条是托管条目）' || probs+="review-autopilot 没带托管规则; "
    has "$out/review.md" '# 托管规则（本条是托管条目）' && probs+="普通复审带了托管规则; "
    if [ -z "$probs" ]; then ok "$tag：真实派工的复审 ×2、worker ×4 都符合「$st」"; else bad "$tag" "$probs"; fi
}

echo "── 【1】【2】REVIEW.md 三态 × 全部入口（真实派工脚本）──"
P=$(make_project present remote); dispatch_all "$P" "$TMP/out-present"; expect_set "主干有 REVIEW.md" "$TMP/out-present" present
P=$(make_project absent none); dispatch_all "$P" "$TMP/out-absent"; expect_set "主干没有 REVIEW.md" "$TMP/out-absent" absent
# 只在本地工作区有：不捡本地文件
printf '# REVIEW\n\n%s\n' "$MD_BODY" > "$P/project/REVIEW.md"
dispatch_all "$P" "$TMP/out-local"; expect_set "只在本地工作区有" "$TMP/out-local" absent
# 远端引用不在：远端连不上（派工前的同步拉取失败），本地的远端分支引用也删了
P=$(make_project noref remote); git -C "$P/project" remote set-url origin "$TMP/nonexistent.git"
git -C "$P/project" update-ref -d refs/remotes/origin/main
dispatch_all "$P" "$TMP/out-noref"; expect_set "远端引用不在" "$TMP/out-noref" unreadable
P=$(make_project dir dir); dispatch_all "$P" "$TMP/out-dir"; expect_set "主干上 REVIEW.md 是目录" "$TMP/out-dir" unreadable
P=$(make_project replace remote replace); dispatch_all "$P" "$TMP/out-replace"
expect_set "整份替换了模板的项目" "$TMP/out-replace" present
has "$TMP/out-replace/review.md" '项目自己的复审模板' && ok "替换项目的复审 prompt 用的是项目模板" || bad "替换项目的复审 prompt 没用项目模板"
has "$TMP/out-replace/new-issue.md" '项目自己的 worker 模板' && ok "替换项目的 worker prompt 用的是项目模板" || bad "替换项目的 worker prompt 没用项目模板"

# 托管条目又开了外部内容保护：方案复审不跑范围命令（不留第二条读正文的路径），B 类每轮全量；不是托管条目的
# 复审照常带方案模式的命令。标记行一律不留在成品里
P=$(make_project guarded remote); echo 'AUTOPILOT_OUTSIDER_GUARD="on"' >> "$P/config"
dispatch_all "$P" "$TMP/out-guarded"
f="$TMP/out-guarded/review-autopilot.md"
if [ -s "$f" ] && has "$f" 'B 类每一轮都按全量轮审' && ! has "$f" ' plan <issue 编号>' && ! has "$f" 'fingerprint <评论 id>' \
   && ! has "$f" 'review-baseline: plan' && has "$f" "--repo 'example/rc' pr <被审 PR 的编号> --round <N> --baseline-mark" \
   && ! has "$f" 'A 类命令读评论只为找'; then
    ok "托管 + 外部内容保护：没有方案模式；A 类命令只带交进来的基线、不自己读评论；B 类每轮全量"
else bad "托管 + 外部内容保护：复审说明不对" "$(grep -n 'B 类' "$f" 2>/dev/null | head -5)"; fi
has "$f" '# 外部账号的内容' && ok "到达性：这份确实带着外部内容保护段" || bad "这份没带外部内容保护段（测的不是保护开着的情形）"
# 两种情形各指向自己的处置：读完了没有基线 → 全量；读取命令本身失败 → 照外部内容段重试一次、仍失败交人，不按全量审。
# 拿 A 类那一行逐句看，免得两句话落在别处时互相顶替
aline=$(grep -F -- '--baseline-mark' "$f" | head -1)
case "$aline" in
  *'成功读完'*'找不到这样的结论'*'本轮按全量轮审'*) ok "受保护读取成功但没有基线 → 全量轮" ;;
  *) bad "没写「读完了没有基线才全量」" "$aline" ;;
esac
case "$aline" in
  *'本身失败'*'不是「没有基线」'*'重试一次'*'仍然失败就交人'*'写明命令的报错'*'不按全量轮继续审'*) ok "受保护读取命令失败 → 重试一次、仍失败交人，不按全量继续" ;;
  *) bad "读取失败没有指向重试和交人" "$aline" ;;
esac
case "$aline" in *'受保护读取命令失败、找不到'*) bad "读取失败仍和没有基线并在一起" "$aline" ;; *) ok "读取失败不再和没有基线并成一句" ;; esac
grep -qF '命令失败（退出码不是 0' "$f" && grep -qF '重试一次；仍然失败就照上文交人' "$f" \
  && ok "外部内容段的失败规则也在同一份成品里，两处说法一致" || bad "成品里没有外部内容段的失败规则"
f="$TMP/out-guarded/review.md"
if has "$f" ' plan <issue 编号>' && ! has "$f" 'B 类每一轮都按全量轮审' && ! has "$f" '--baseline-mark' && has "$f" 'A 类命令读评论只为找'; then
    ok "同一项目的非托管复审：方案模式和自己找基线的代码命令照常"
else bad "同一项目的非托管复审不该换成受保护的写法"; fi
if grep -lE '<!-- (plain|guarded)-only:(begin|end) -->' "$TMP"/out-*/*.md >/dev/null 2>&1; then bad "成品里留下了标记行" "$(grep -lE 'only:(begin|end)' "$TMP"/out-*/*.md | head -3)"
else ok "成品里没有标记行"; fi

# 顺序：REVIEW.md 段 → 收敛段 → 托管规则段（托管段改收敛规则的第 ④ 步，得在后面）
f="$TMP/out-present/review-autopilot.md"
l_md=$(grep -nF -- "$MD_HEAD" "$f" | head -1 | cut -d: -f1)
l_cv=$(grep -nF -- "$CONVERGE_HEAD" "$f" | head -1 | cut -d: -f1)
l_ap=$(grep -nF -- '# 托管规则（本条是托管条目）' "$f" | head -1 | cut -d: -f1)
l_late=$(grep -nF -- '## 迟到的「必须改」（覆盖复审收敛规则判断顺序的第 ④ 步）' "$f" | head -1 | cut -d: -f1)
if [ -n "$l_md" ] && [ -n "$l_cv" ] && [ -n "$l_ap" ] && [ -n "$l_late" ] && [ "$l_md" -lt "$l_cv" ] && [ "$l_cv" -lt "$l_ap" ] && [ "$l_ap" -lt "$l_late" ]; then
    ok "托管复审：REVIEW.md 段 → 收敛段 → 托管规则（含迟到必须改照打回）"
else bad "托管复审里段落顺序不对" "REVIEW.md=$l_md 收敛=$l_cv 托管=$l_ap 迟到=$l_late"; fi
# 收敛段里的命令是渲染好的，指向随发布的修复范围脚本
if has "$f" "bash '$REPO_DIR/scripts/review-scope.sh' --repo 'example/rc' pr" && ! has "$f" '@@SCOPE_CMD@@'; then
    ok "收敛段里的修复范围命令已渲染"
else bad "收敛段里的修复范围命令没渲染对" "$(grep -m1 'review-scope' "$f")"; fi
has "$TMP/out-present/new-issue.md" 'git show origin/main:REVIEW.md' && ok "自查句里的读法已渲染成主干分支" || bad "自查句里没有 origin/main"
for s in '没输出、退出码不是 0、第一行不是上面两种' '全量轮里不存在「修复范围以外」' '**交人记录**：不打回' '只剩建议时判通过' \
         '上文清单里写明「判不通过」的条目一律是「必须改」' 'worker 这一轮交出的评论、方案和 PR 正文，总在本轮审查范围内' \
         'fingerprint <评论 id> --issue <issue 编号> --expect'; do
    has "$TMP/out-present/review.md" "$s" && ok "收敛段有「$s」" || bad "收敛段缺「$s」"
done

# ════════ 【4】问题编号不带井号（GitHub#646）════════
# 复审问题编号写「问题 N」；worker 两个返工入口同一句回应规则；全部入口的交人评论写法都有「只有真的 issue / PR
# 才写 #编号」，各处逐字一致；示例按 GitHub 自动链接的规则只认出真的 issue 号，换回旧写法会多认出一个
echo "── 【4】问题编号不带井号（真实派工脚本拼出的六份）──"
O="$TMP/out-present"
NUM_RULE='**只有真的 issue / PR 才写 `#编号`**'
num_texts() { grep -o -- '\*\*只有真的 issue / PR 才写 `#编号`\*\*。.*' "$1"; }
REWORK_HEAD='按复审结论里的问题编号逐条回应'
rework_texts() { grep -o -- '按复审结论里的问题编号逐条回应：[^。]*。' "$1"; }
probs=""; ref_num=""
for f in review review-autopilot "${WORKERS[@]}"; do
    t=$(num_texts "$O/$f.md" | sort -u); n=$(num_texts "$O/$f.md" | wc -l)
    if [ -z "$t" ]; then probs+="$f 没有「只有真的 issue / PR 才写」; "; continue; fi
    [ "$(wc -l <<<"$t")" -eq 1 ] || probs+="$f 这一句有不同写法; "
    if [ -z "$ref_num" ]; then ref_num="$t"; elif [ "$t" != "$ref_num" ]; then probs+="$f 这一句和 review 不一致; "; fi
    case "$f" in
        # 这里的测试项目没有复审增量，复审只剩通用模板那一处；带本项目增量的那份由 plain-language-prompts 对拍
        review*) grep -qF -- "review 评论同样遵守：$NUM_RULE" "$O/$f.md" || probs+="$f 通用模板 review 评论那一段没有这一句; " ;;
        *) grep -qF -- "11. $NUM_RULE" "$O/$f.md" || probs+="$f 不在交人评论那段的第 11 条; " ;;
    esac
    for old in '编号 `#1`、`#2`' '（`#1`、`#2`…）' '安全规则 #2' '逻辑判断同 #1'; do
        has "$O/$f.md" "$old" && probs+="$f 还有旧写法「$old」; "
    done
done
[ -z "$probs" ] && ok "六份成品都有「只有真的 issue / PR 才写 #编号」且逐字一致，旧的井号编号要求一处不剩" || bad "井号编号规则" "$probs"
probs=""
for f in review review-autopilot; do
    has "$O/$f.md" '编号写「问题 1」「问题 2」……，不带井号' || probs+="$f 没有「问题 N」编号规则; "
    has "$O/$f.md" '跨轮引用写「第 2 轮问题 3」' || probs+="$f 没有跨轮写法; "
    has "$O/$f.md" '上一轮清单用的是旧写法 `#N` 时，它就是问题 N：照同一个号核对' || probs+="$f 没有旧编号过渡; "
done
[ -z "$probs" ] && ok "两份复审：编号规则是「问题 N」、跨轮「第 N 轮问题 M」、旧写法 #N 当问题 N 核对" || bad "复审编号规则" "$probs"
# 处理返工的是 issue 回复、PR 回复两个入口（拆出的子 issue 走 issue 回复的模板，同一句也在）
a=$(rework_texts "$O/issue-comment.md"); b=$(rework_texts "$O/pr-comment.md"); c=$(rework_texts "$O/sub-issue.md")
if [ -n "$a" ] && [ "$a" = "$b" ] && [ "$a" = "$c" ] && [ "$(wc -l <<<"$a")" -eq 1 ] && grep -qF '第 N 轮问题 M' <<<"$a" && grep -qF '旧写法 `#N` 时，它就是问题 N' <<<"$a"; then
    ok "issue 回复、PR 回复（含子 issue）返工入口是同一句回应规则（问题 N、第 N 轮问题 M、旧写法当问题 N）"
else bad "返工入口的回应规则不同或缺了" "issue=[$a] pr=[$b] sub=[$c]"; fi
for f in new-issue review review-autopilot; do has "$O/$f.md" "$REWORK_HEAD" && bad "$f 不处理返工，不该有返工回应规则"; done
# 示例按 GitHub 的自动链接规则算：代码段以外、前面不是字母数字的「井号 + 数字」
autolinks() { python3 -c '
import re, sys
t = re.sub(r"`[^`]*`", "", sys.stdin.read())
print(" ".join(re.findall(r"(?<![0-9A-Za-z_/#&])#([0-9]+)(?![0-9A-Za-z_])", t)))'; }
ex=$(grep -o -- '例：「[^」]*」' <<<"$ref_num" | sed 's/^例：「//; s/」$//')
check "示例取得到" "$([ -n "$ex" ] && echo yes)" yes
check "示例（新写法）只认出真的 issue 号" "$(autolinks <<<"$ex")" "610"
check "同一句换回旧写法（问题 2 → #2）会多认出一个链接" "$(sed 's/问题 \([0-9]\)/#\1/' <<<"$ex" | autolinks)" "2 610"
check "跨轮写法「第 1 轮问题 3」不会被认成链接" "$(printf '| 第 1 轮问题 3 | 已改 |\n' | autolinks)" ""
check "旧跨轮写法「第 1 轮 #3」会被认成链接（测得出两种写法的差别）" "$(printf '| 第 1 轮 #3 | 已改 |\n' | autolinks)" "3"

# ════════ 【3】修复范围脚本 ════════
echo "── 【3】修复范围脚本 ──"
G="$TMP/gh-data"; mkdir -p "$G" "$TMP/bin3"
REAL_GIT=$(command -v git)
# 假 gh：gh api [--paginate] <路径> [--jq 表达式]；数据是 $G 下的文件，fail-<键> 存在 = 这个请求失败
cat > "$TMP/bin3/gh" <<'SH'
#!/usr/bin/env bash
[ "$1" = api ] || exit 9
shift
path="" jqx=""
while [ $# -gt 0 ]; do
    case "$1" in --paginate) shift ;; --jq) jqx="$2"; shift 2 ;; *) path="$1"; shift ;; esac
done
key=$(printf '%s' "$path" | tr '/' '_')
printf '%s\n' "$path" >> "$GH_DATA/calls"
[ ! -e "$GH_DATA/fail-$key" ] || { echo "HTTP 500" >&2; exit 1; }
f="$GH_DATA/$key.json"
[ -f "$f" ] || { echo "gh: Not Found (HTTP 404)" >&2; exit 1; }
if [ -n "$jqx" ]; then jq -r "$jqx" < "$f"; else cat "$f"; fi
SH
# git 包一层：GIT_FAIL=<子命令> 时那个子命令失败（退出码 128），其余照常
cat > "$TMP/bin3/git" <<SH
#!/usr/bin/env bash
for a in "\$@"; do
    if [ -n "\${GIT_FAIL:-}" ] && [ "\$a" = "\$GIT_FAIL" ]; then echo "fatal: injected" >&2; exit 128; fi
    case "\$a" in -*) ;; *) break ;; esac
done
exec "$REAL_GIT" "\$@"
SH
chmod +x "$TMP/bin3/gh" "$TMP/bin3/git"
SCOPE="$REPO_DIR/scripts/review-scope.sh"
echo '{"login":"loop-bot"}' > "$G/user.json"

UP="$TMP/scope-up.git"; git init -q --bare "$UP"
SEED="$TMP/scope-seed"; git clone -q "$UP" "$SEED" 2>/dev/null
WT="$TMP/scope-wt"
g() { git -C "$SEED" "$@"; }
commit_file() { printf '%s\n' "$2" > "$SEED/$1"; g add -A; g commit -qm "$3"; }
lines() { local i; for i in $(seq 1 "$1"); do echo "line $i"; done; }
lines 10 > "$SEED/a.txt"; lines 10 > "$SEED/b.txt"; g add -A; g commit -qm base; g push -q origin HEAD:main

# PR 的提交推到 refs/pull/<N>/head；PR 接口返回最新提交与目标分支
set_pr() {   # <N> <提交> [目标分支]
    g push -q -f origin "$2:refs/pull/$1/head"
    jq -n --arg h "$(g rev-parse "$2")" --arg b "${3:-main}" '{head: {sha: $h}, base: {ref: $b}}' > "$G/repos_o_r_pulls_$1.json"
}
# 结论评论：<N> <提交 / 原样标记行>；第二个参数是 40 位提交号就写成代码基线标记
review_comments() {   # <N> <标记行>...
    local n="$1"; shift
    local arr='[]' m i=1
    for m in "$@"; do
        arr=$(jq -c --arg b "<!-- codex-review-round:$i -->"$'\n'"$m"$'\n'"## ❌ 复审未通过" --argjson id "$((1000 + i))" \
            '. + [{id: $id, user: {login: "loop-bot"}, body: $b}]' <<<"$arr")
        i=$((i + 1))
    done
    # 别的账号发的、带着另一个基线的评论：不算
    arr=$(jq -c '. + [{id: 9, user: {login: "someone"}, body: "<!-- codex-review-round:9 -->\n<!-- review-baseline: code head=0000000000000000000000000000000000000000 base=main -->"}]' <<<"$arr")
    printf '%s\n' "$arr" > "$G/repos_o_r_issues_${n}_comments.json"
}
code_mark() { printf '<!-- review-baseline: code head=%s base=%s -->' "$(g rev-parse "$1")" "${2:-main}"; }
run_scope() {   # <参数>...：在 worktree 里跑，打印第一行，差异存进 $TMP/scope-out
    rm -rf "$WT"; git clone -q "$UP" "$WT" 2>/dev/null
    (cd "$WT" && PATH="$TMP/bin3:$PATH" GH_DATA="$G" bash "$SCOPE" --repo o/r "$@") > "$TMP/scope-out" 2>/dev/null
    echo "rc=$? $(head -1 "$TMP/scope-out")"
}

# PR 1：在 a.txt 上改了第 2 行（上轮审过的提交 P1），之后的情形各自从这里长
g checkout -qb pr1 main
sed -i 's/^line 2$/line 2 pr/' "$SEED/a.txt"; g commit -qam "pr: a2"; P1=$(g rev-parse HEAD)

# 行 1：首轮
set_pr 1 "$P1"; review_comments 1 "$(code_mark "$P1")"
check "代码 1：最近人工动作后的第 1 轮 → full first-round" "$(run_scope pr 1 --round 1)" "rc=0 full first-round"
# 行 2：读评论失败
touch "$G/fail-repos_o_r_issues_1_comments"
check "代码 2：读评论失败 → full read-failed" "$(run_scope pr 1 --round 2)" "rc=0 full read-failed"
rm -f "$G/fail-repos_o_r_issues_1_comments"
touch "$G/fail-repos_o_r_pulls_1"
check "代码 2：读 PR 失败 → full read-failed" "$(run_scope pr 1 --round 2)" "rc=0 full read-failed"
rm -f "$G/fail-repos_o_r_pulls_1"
# 行 3：最新一条结论没有基线标记 / 标记格式不符（更早那条有标记也不认）
review_comments 1 "$(code_mark "$P1")" "（没有基线标记）"
check "代码 3：最新结论没有基线标记 → full no-baseline" "$(run_scope pr 1 --round 2)" "rc=0 full no-baseline"
review_comments 1 "<!-- review-baseline: code head=$(g rev-parse --short "$P1") base=main -->"
check "代码 3：标记格式不符 → full no-baseline" "$(run_scope pr 1 --round 2)" "rc=0 full no-baseline"
printf '[{"id":9,"user":{"login":"someone"},"body":"<!-- codex-review-round:1 -->\\n%s"}]\n' "$(code_mark "$P1")" > "$G/repos_o_r_issues_1_comments.json"
check "代码 3：只有别的账号的结论 → full no-baseline" "$(run_scope pr 1 --round 2)" "rc=0 full no-baseline"
# 行 4：改投分支
review_comments 1 "$(code_mark "$P1" release)"
check "代码 4：目标分支与标记不同 → full base-changed" "$(run_scope pr 1 --round 2)" "rc=0 full base-changed"
# 行 5：上轮审过的提交取不到 / 拉取失败
review_comments 1 "<!-- review-baseline: code head=1234567890123456789012345678901234567890 base=main -->"
check "代码 5：上轮审过的提交取不到 → full baseline-missing" "$(run_scope pr 1 --round 2)" "rc=0 full baseline-missing"
review_comments 1 "$(code_mark "$P1")"
check "代码 5：拉取失败 → full baseline-missing" "$(GIT_FAIL=fetch run_scope pr 1 --round 2)" "rc=0 full baseline-missing"
# 行 6：强推（上轮的提交不在本轮历史里）
g checkout -q -b pr1-rewritten main; sed -i 's/^line 2$/line 2 rewritten/' "$SEED/a.txt"; g commit -qam rewritten
set_pr 1 pr1-rewritten
check "代码 6：变基 / 强推 → full history-rewritten" "$(run_scope pr 1 --round 2)" "rc=0 full history-rewritten"
# 行 7：分叉点算不出（目标分支和 PR 没有共同祖先）
g checkout -q --orphan unrelated; g rm -rqf . ; echo z > "$SEED/z.txt"; g add -A; g commit -qm unrelated; g push -q origin HEAD:unrelated
set_pr 1 "$P1" unrelated; review_comments 1 "$(code_mark "$P1" unrelated)"
check "代码 7：分叉点算不出 → full read-failed" "$(run_scope pr 1 --round 2)" "rc=0 full read-failed"
# 行 9、10：合成出别的错、比较失败
set_pr 1 "$P1"; review_comments 1 "$(code_mark "$P1")"
check "代码 9：合成出错 → full read-failed" "$(GIT_FAIL=merge-tree run_scope pr 1 --round 2)" "rc=0 full read-failed"
check "代码 10：比较失败 → full read-failed" "$(GIT_FAIL=diff run_scope pr 1 --round 2)" "rc=0 full read-failed"
# 行 11：没有新提交
check "代码 11：没有新提交 → scope 0" "$(run_scope pr 1 --round 2)" "rc=0 scope 0"
[ "$(wc -l < "$TMP/scope-out")" = 1 ] && ok "代码 11：scope 0 后面没有差异" || bad "代码 11：scope 0 后面还有内容"
# 行 11：只同步了主干——主干改了 PR 也改的同一个文件（另一处）
g checkout -q main; sed -i 's/^line 9$/line 9 main/' "$SEED/a.txt"; g commit -qam "main: a9"; g push -q origin HEAD:main
g checkout -q pr1; g merge -q --no-edit main >/dev/null; set_pr 1 pr1
check "代码 11：只合入主干（同一文件另一处）→ scope 0" "$(run_scope pr 1 --round 2)" "rc=0 scope 0"
# 行 12：同步主干之后在同一文件实改一行 → 只列这一行
sed -i 's/^line 5$/line 5 fix/' "$SEED/a.txt"; g commit -qam "fix: a5"; set_pr 1 pr1
check "代码 12：同步主干后实改一行 → scope 1" "$(run_scope pr 1 --round 2)" "rc=0 scope 1"
if grep -q '^+line 5 fix$' "$TMP/scope-out" && grep -q '^-line 5$' "$TMP/scope-out" \
   && ! grep -q 'line 9 main' "$TMP/scope-out" && [ "$(grep -c '^[-+][^-+]' "$TMP/scope-out")" = 2 ]; then
    ok "代码 12：差异只有修复的那一行，主干带进来的不在里面"
else bad "代码 12：差异不对" "$(cat "$TMP/scope-out")"; fi
# 目标是纯 issue、结论评论发在 issue 上：--on
cp "$G/repos_o_r_issues_1_comments.json" "$G/repos_o_r_issues_77_comments.json"; echo '[]' > "$G/repos_o_r_issues_1_comments.json"
check "代码：结论评论在 issue 上（--on）→ 照样找到基线" "$(run_scope pr 1 --round 2 --on 77)" "rc=0 scope 1"
# 行 8：PR 与主干改同一行，PR 本轮手工解决冲突
g checkout -q -b pr2 main; sed -i 's/^line 3$/line 3 pr/' "$SEED/b.txt"; g commit -qam "pr2: b3"; P2=$(g rev-parse HEAD)
set_pr 2 "$P2"; review_comments 2 "$(code_mark "$P2")"
g checkout -q main; sed -i 's/^line 3$/line 3 main/' "$SEED/b.txt"; g commit -qam "main: b3"; g push -q origin HEAD:main
g checkout -q pr2; g merge -q --no-edit main >/dev/null 2>&1
sed -i -e '/^<<<<<<<\|^=======\|^>>>>>>>/d' -e '/^line 3 main$/d' "$SEED/b.txt"; g commit -qam "resolve" >/dev/null 2>&1
set_pr 2 pr2
check "代码 8：PR 手工解决了与主干的冲突 → full merge-conflict" "$(run_scope pr 2 --round 3)" "rc=0 full merge-conflict"

# 基线由复审从受保护读取的输出里交进来（--baseline-mark）：命令一条评论都不读——评论接口设成必失败也照样算出范围
g checkout -q pr1
touch "$G/fail-repos_o_r_issues_1_comments"; rm -f "$G/calls"; set_pr 1 pr1
check "交进来的基线 → 照样 scope 1" "$(run_scope pr 1 --round 2 --baseline-mark "$(code_mark "$P1")")" "rc=0 scope 1"
if [ -s "$G/calls" ] && ! grep -q '/comments' "$G/calls"; then ok "交进来的基线时没有任何评论请求（只读了 PR）"
else bad "交进来的基线时仍请求了评论（或一条请求都没记下）" "$(cat "$G/calls" 2>/dev/null)"; fi
check "交进来的基线格式不对 → full no-baseline" "$(run_scope pr 1 --round 2 --baseline-mark '## ❌ 复审未通过')" "rc=0 full no-baseline"
check "交进来的基线为空（受保护读取里没找到）→ full no-baseline" "$(run_scope pr 1 --round 2 --baseline-mark '')" "rc=0 full no-baseline"
check "交进来的基线 + 第 1 轮 → full first-round" "$(run_scope pr 1 --round 1 --baseline-mark "$(code_mark "$P1")")" "rc=0 full first-round"
rm -f "$G/fail-repos_o_r_issues_1_comments"
out=$(cd "$WT" && PATH="$TMP/bin3:$PATH" GH_DATA="$G" bash "$SCOPE" --repo o/r plan 9 --round 2 --comment 1 --baseline-mark x 2>/dev/null); rc=$?
check "方案模式不接受 --baseline-mark → 用法错误" "rc=$rc out=$out" "rc=2 out="

# 用法错误：退出码 2，不输出结论
out=$(cd "$WT" && PATH="$TMP/bin3:$PATH" GH_DATA="$G" bash "$SCOPE" --repo o/r pr 1 2>/dev/null); rc=$?
check "用法错误（没给轮次）→ 退出码 2、没有输出" "rc=$rc out=$out" "rc=2 out="

# 基线只认结论评论的第一、二行：之后一条普通评论里引用了旧的轮次标记和基线标记，不算新的结论
review_comments 1 "$(code_mark "$P1")"
jq -c --arg b "说明一下上一轮的标记：
<!-- codex-review-round:1 -->
<!-- review-baseline: code head=1234567890123456789012345678901234567890 base=main -->" \
    '. + [{id: 4000, user: {login: "loop-bot"}, body: $b}]' "$G/repos_o_r_issues_1_comments.json" > "$G/q.json" && mv "$G/q.json" "$G/repos_o_r_issues_1_comments.json"
set_pr 1 "$P1"
check "代码 3：后来的普通评论引用了旧标记 → 仍按真正的结论算（scope 0）" "$(run_scope pr 1 --round 2)" "rc=0 scope 0"

echo "── 【3】方案 ──"
B501=$'## 方案 v1\n\n第一段\n第二段'
B502=$'## 方案 v2\n\n第一段\n第二段改了'
cmt() {   # <id> <正文> [作者] [所在 issue]
    jq -n --argjson id "$1" --arg b "$2" --arg u "${3:-loop-bot}" --arg i "${4:-9}" \
        '{id: $id, user: {login: $u}, body: $b, issue_url: ("https://api.github.com/repos/o/r/issues/" + $i)}' > "$G/repos_o_r_issues_comments_$1.json"
}
# 输出里「本轮方案全文」那一段（不含末尾补的换行）
shown_text() { awk '/^===== 本轮方案全文/ { f = 1; next } /^===== 全文结束 =====$/ { f = 0 } f' "$TMP/scope-out" | sed -e '$ s/$//' | python3 -c 'import sys; d=sys.stdin.read(); sys.stdout.write(d[:-1] if d.endswith("\n") else d)'; }
cmt 501 "$B501"; cmt 502 "$B502"
# 指纹用系统的 sha256sum 独立算（不经被测代码）：GitHub 返回的正文原样，不加换行
FP501=$(printf '%s' "$B501" | sha256sum | cut -d' ' -f1); FP502=$(printf '%s' "$B502" | sha256sum | cut -d' ' -f1)
scope_cmd() { (cd "$WT" && PATH="${SCOPE_PATH:-$TMP/bin3:$PATH}" GH_DATA="$G" bash "$SCOPE" --repo o/r "$@"); }
plan_mark() { printf '<!-- review-baseline: plan comment=%s sha256=%s -->' "$1" "$2"; }
review_comments 9 "$(plan_mark 501 "$FP501")"
check "方案 1：第 1 轮 → full first-round" "$(run_scope plan 9 --round 1 --comment 502)" "rc=0 full first-round"
check "方案：第 1 轮也给出本轮评论的 current 指纹" "$(sed -n 2p "$TMP/scope-out")" "current sha256=$FP502"
review_comments 9 "（没有基线标记）"
check "方案 1：找不到上轮标记 → full no-baseline" "$(run_scope plan 9 --round 2 --comment 502)" "rc=0 full no-baseline"
touch "$G/fail-repos_o_r_issues_9_comments"
check "方案 1：读评论失败 → full read-failed" "$(run_scope plan 9 --round 2 --comment 502)" "rc=0 full read-failed"
rm -f "$G/fail-repos_o_r_issues_9_comments"
review_comments 9 "$(plan_mark 599 "$FP501")"
check "方案 2：上一版评论已删除 → full deleted" "$(run_scope plan 9 --round 2 --comment 502)" "rc=0 full deleted"
review_comments 9 "$(plan_mark 501 "$(printf '%064d' 0)")"
check "方案 3：上一版被原地编辑过（指纹不同）→ full edited" "$(run_scope plan 9 --round 2 --comment 502)" "rc=0 full edited"
review_comments 9 "$(plan_mark 501 "$FP501")"
check "方案 4：上一版就是本轮这条 → full same-comment" "$(run_scope plan 9 --round 2 --comment 501)" "rc=0 full same-comment"
check "方案 5：另一条新评论、指纹一致 → scope 1" "$(run_scope plan 9 --round 2 --comment 502)" "rc=0 scope 1"
check "方案 5：第二行是本轮评论的 current 指纹" "$(sed -n 2p "$TMP/scope-out")" "current sha256=$FP502"
if grep -q '^+第二段改了$' "$TMP/scope-out" && grep -q '^-第二段$' "$TMP/scope-out" && ! grep -q '^[-+]第一段$' "$TMP/scope-out"; then
    ok "方案 5：差异只有改动的段落"
else bad "方案 5：差异不对" "$(cat "$TMP/scope-out")"; fi
# 复审审的就是命令印出来的全文，指纹出自同一次读取：先「给人看」版本 A，评论被改成 B 后才跑命令——命令印的是 B、
# 指纹也是 B，不会出现「审的是 A、基线写成 B」
check "方案：印出的全文就是本轮评论正文" "$(shown_text)" "$B502"
check "方案：印出的全文的指纹 = current 行" "$(shown_text | sha256sum | cut -d' ' -f1)" "$FP502"
B502b=$'## 方案 v2\n\n第一段\n第二段又改了'; FP502b=$(printf '%s' "$B502b" | sha256sum | cut -d' ' -f1)
cmt 502 "$B502b"
run_scope plan 9 --round 2 --comment 502 >/dev/null
check "方案：评论改过之后再跑，印出的是新版本" "$(shown_text)" "$B502b"
check "方案：新版本的 current 指纹跟着变" "$(sed -n 2p "$TMP/scope-out")" "current sha256=$FP502b"
cmt 502 "$B502"
# 方案评论不在本条 issue 下（同一个仓库里别的条目的评论）
cmt 504 "$B502" loop-bot 10
check "方案：本轮那条评论不在本条 issue 下 → full not-this-issue" "$(run_scope plan 9 --round 2 --comment 504)" "rc=0 full not-this-issue"
check "方案：not-this-issue 时不印全文和指纹" "$(wc -l < "$TMP/scope-out" | tr -d ' ')" "1"
cmt 501 "$B501" loop-bot 10
check "方案：上一版不在本条 issue 下 → full not-this-issue" "$(run_scope plan 9 --round 2 --comment 502)" "rc=0 full not-this-issue"
cmt 501 "$B501"

# 不是派工账号发的评论：不读进来，正文不出现在输出里
SECRET='外部账号写的正文-不该出现'
cmt 503 "$SECRET" outsider
check "方案：本轮那条不是派工账号发的 → full not-own" "$(run_scope plan 9 --round 2 --comment 503)" "rc=0 full not-own"
grep -qF -- "$SECRET" "$TMP/scope-out" && bad "not-own 时输出里有那条评论的正文" || ok "not-own 时输出里没有那条评论的正文"
cmt 501 "$SECRET" outsider
check "方案：上一版不是派工账号发的 → full not-own" "$(run_scope plan 9 --round 2 --comment 502)" "rc=0 full not-own"
grep -qF -- "$SECRET" "$TMP/scope-out" && bad "上一版 not-own 时输出里有它的正文" || ok "上一版 not-own 时输出里没有它的正文"
cmt 501 "$B501"

# 写基线的指纹只能是审过的那个版本
out=$(scope_cmd fingerprint 502 --issue 9 --expect "$FP502" 2>/dev/null); rc=$?
check "fingerprint --expect 一致 → 打印指纹" "rc=$rc $out" "rc=0 $FP502"
cmt 502 $'## 方案 v2\n\n审阅途中被原地改了'
out=$(scope_cmd fingerprint 502 --issue 9 --expect "$FP502" 2>/dev/null); rc=$?
check "审阅之后被原地编辑 → fingerprint 退出码 3、不给指纹" "rc=$rc out=$out" "rc=3 out="
cmt 502 "$B502"
out=$(scope_cmd fingerprint 502 --issue 9 2>/dev/null); rc=$?
check "fingerprint 不带 --expect → 用法错误（退出码 2）" "rc=$rc out=$out" "rc=2 out="
out=$(scope_cmd fingerprint 502 --expect "$FP502" 2>/dev/null); rc=$?
check "fingerprint 不带 --issue → 用法错误（退出码 2）" "rc=$rc out=$out" "rc=2 out="
out=$(scope_cmd fingerprint 502 --issue 10 --expect "$FP502" 2>/dev/null); rc=$?
check "fingerprint 评论不在这个 issue 下 → 退出码 1、不给指纹" "rc=$rc out=$out" "rc=1 out="
out=$(scope_cmd fingerprint 503 --issue 9 --expect "$FP502" 2>/dev/null); rc=$?
check "fingerprint 别的账号的评论 → 退出码 1、不给指纹" "rc=$rc out=$out" "rc=1 out="

# sha256 工具：只有 macOS 那种 shasum、两个都没有
mkdir -p "$TMP/path-shasum" "$TMP/path-none"
for dir in /usr/local/bin /usr/bin /bin; do
    [ -d "$dir" ] || continue
    for exe in "$dir"/*; do
        n="${exe##*/}"
        [ "$n" = sha256sum ] && continue
        [ -e "$TMP/path-shasum/$n" ] || ln -s "$exe" "$TMP/path-shasum/$n"
        [ "$n" = shasum ] && continue
        [ -e "$TMP/path-none/$n" ] || ln -s "$exe" "$TMP/path-none/$n"
    done
done
if [ -e "$TMP/path-shasum/shasum" ]; then
    export SCOPE_PATH="$TMP/bin3:$TMP/path-shasum"
    out=$(scope_cmd fingerprint 502 --issue 9 --expect "$FP502" 2>/dev/null); rc=$?
    check "只有 shasum：fingerprint 照样一致" "rc=$rc $out" "rc=0 $FP502"
    rm -rf "$WT"; git clone -q "$UP" "$WT" 2>/dev/null
    out=$(scope_cmd plan 9 --round 2 --comment 502 2>/dev/null | head -2 | tr '\n' '|'); 
    check "只有 shasum：方案复核照样 scope 1" "$out" "scope 1|current sha256=$FP502|"
else
    bad "本机没有 shasum，「只有 shasum」那一组测不了"
fi
export SCOPE_PATH="$TMP/bin3:$TMP/path-none"
out=$(scope_cmd plan 9 --round 2 --comment 502 2>/dev/null | head -1); 
check "两种 sha256 工具都没有：方案 → full read-failed（不是 edited）" "$out" "full read-failed"
out=$(scope_cmd fingerprint 502 --issue 9 --expect "$FP502" 2>/dev/null); rc=$?
check "两种 sha256 工具都没有：fingerprint 退出码 1、不给指纹" "rc=$rc out=$out" "rc=1 out="
unset SCOPE_PATH

# ════════ 【3】往返记录里的复审结论（GitHub#676）════════
# 记录用真实的写入命令（round-log.sh post，有状态的假 GitHub）写出来，再把那条 issue 的评论原样交给范围命令的假 gh
echo "── 【3】往返记录里的复审结论 ──"
RLD="$TMP/rl-gh"; mkdir -p "$RLD" "$TMP/rl-state" "$TMP/rl-wt" "$TMP/rl-proj"
RLCONF="$TMP/rl.config"
cat > "$RLCONF" <<CONF
REPO="o/r"
PROJECT_ROOT="$TMP/rl-proj"
WORKTREE_BASE="$TMP/rl-wt"
STATE_DIR="$TMP/rl-state"
TMUX_PREFIX="rctest"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
LABEL_AGENT_DOING="doing/agent"
LABEL_PENDING_REVIEW="pending/review"
GH_TOKEN="fake-token-for-test"
ENABLE_ROUND_LOG=true
CONF
echo loop-bot > "$RLD/me"
echo '{"77": {"kind": "issue", "state": "open", "title": "t", "body": "需求", "user": {"login": "maint"}}}' > "$RLD/items.json"
echo '{"77": ["doing/agent"]}' > "$RLD/labels.json"
echo '{"77": [{"id": 100, "body": "人的补充", "user": {"login": "maint"}, "created_at": "2026-01-01T00:00:00Z"}]}' > "$RLD/comments.json"
RLW() { env "${CLEAN_ENV[@]}" HOME="$TMP/home" PATH="$TMP/bin:$PATH" FAKE_GH_DIR="$RLD" FAKE_GH_REPO=o/r \
        bash "$REPO_DIR/scripts/round-log.sh" --config "$RLCONF" "$@"; }
rlf() { printf '%s\n' "$2" > "$TMP/rl-$1"; echo "$TMP/rl-$1"; }
RLRES=$(RLW post 77 --role worker --to pending/review --body "$(rlf b1 '✅ 第 1 版交付')" --full "$(rlf f1 '交付说明 1')" | grep '^RESULT=')
RL_OF=$(RLW show 77 | grep -o -- '--of [^`]*' | head -1 | cut -d' ' -f2)
RLRES="$RLRES $(RLW post 77 --role review --of "$RL_OF" --to pending/agent \
        --body "$(rlf r1 "<!-- codex-review-round:1 -->"$'\n'"$(code_mark "$P1")"$'\n'"## ❌ 复审未通过")" | grep '^RESULT=')"
RLRES="$RLRES $(RLW post 77 --role worker --to pending/review --body "$(rlf b2 '✅ 第 2 版交付')" --full "$(rlf f2 '交付说明 2')" | grep '^RESULT=')"
check "真实写入命令写出三节" "$RLRES" "RESULT=written RESULT=written RESULT=written"
check "三节都在同一条往返记录里" "$(jq '[.["77"][] | select(.body | startswith("<!-- cavil-round-log:v1 -->"))] | length' "$RLD/comments.json")" "1"
RLC="$TMP/rl-77-comments.json"   # 写出来的评论原样存一份，各情形从它改出交给假 gh 的那份
jq '.["77"]' "$RLD/comments.json" > "$RLC"; cp "$RLC" "$G/repos_o_r_issues_77_comments.json"
REC_ID=$(jq '[.[] | select(.body | startswith("<!-- cavil-round-log:v1 -->"))][0].id' "$RLC")
set_pr 1 pr1
check "记录里的复审节 → 找到基线，复核轮 scope 1" "$(run_scope pr 1 --round 2 --on 77)" "rc=0 scope 1"
grep -q '^+line 5 fix$' "$TMP/scope-out" && ok "记录里的基线：差异就是这次修复" || bad "记录里的基线：差异不对" "$(cat "$TMP/scope-out")"
# 单独的结论评论比记录里的那一节新 → 用评论的基线（审到 pr1 最新 → scope 0）；比它旧 → 用节里的
jq --arg b "<!-- codex-review-round:2 -->"$'\n'"$(code_mark pr1)" '. + [{id: 999999, user: {login: "loop-bot"}, body: $b}]' "$RLC" > "$G/q.json"
cp "$G/q.json" "$G/repos_o_r_issues_77_comments.json"
check "单独评论更新 → 用评论的基线（scope 0）" "$(run_scope pr 1 --round 3 --on 77)" "rc=0 scope 0"
jq --arg b "<!-- codex-review-round:1 -->"$'\n'"$(code_mark pr1)" '[{id: 50, user: {login: "loop-bot"}, body: $b}] + .' "$RLC" > "$G/q.json"
cp "$G/q.json" "$G/repos_o_r_issues_77_comments.json"
check "记录里的那一节更新 → 用节里的基线（scope 1）" "$(run_scope pr 1 --round 2 --on 77)" "rc=0 scope 1"
# 别的账号写的同款记录不算
jq '[.[] | .user.login = "someone"]' "$RLC" > "$G/repos_o_r_issues_77_comments.json"
check "别的账号写的往返记录 → 不算结论（full no-baseline）" "$(run_scope pr 1 --round 2 --on 77)" "rc=0 full no-baseline"
# 派工账号的记录标记坏了（少了一节的结束标记）→ 读取失败，不猜
jq --argjson id "$REC_ID" '[.[] | if .id == $id then .body |= sub("<!-- cavil-round-log:sec-end -->"; "") else . end]' "$RLC" > "$G/repos_o_r_issues_77_comments.json"
check "记录读不懂 → full read-failed" "$(run_scope pr 1 --round 2 --on 77)" "rc=0 full read-failed"
cp "$RLC" "$G/repos_o_r_issues_77_comments.json"
# 方案模式：本轮那条方案评论是往返记录 → full round-log，不印全文、不给指纹
jq --argjson id "$REC_ID" '.[] | select(.id == $id) | {id: 505, user: {login: "loop-bot"}, body, issue_url: "https://api.github.com/repos/o/r/issues/9"}' "$RLC" > "$G/repos_o_r_issues_comments_505.json"
review_comments 9 "$(plan_mark 501 "$FP501")"
check "方案评论是往返记录 → full round-log" "$(run_scope plan 9 --round 2 --comment 505)" "rc=0 full round-log"
check "full round-log 时不印全文和指纹" "$(wc -l < "$TMP/scope-out" | tr -d ' ')" "1"
check "普通方案评论照旧 scope 1（同一份夹具）" "$(run_scope plan 9 --round 2 --comment 502)" "rc=0 scope 1"

echo "通过 $pass，失败 $fail"
report_counts "$pass" "$fail"
[ "$fail" -eq 0 ]
