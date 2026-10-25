#!/usr/bin/env bash
# 等人审的 PR 与目标分支冲突的守卫 —— GitHub#86。
#
# 跑法：bash tests/pending-human-conflict.test.sh   （本机约 1.5 分钟：末尾的负对照会把
#       整套场景在 7 份改坏的脚本副本上各重跑一遍）
# 依赖：git（≥ 2.38，merge-tree --write-tree）、jq、tmux。不碰网络（假 gh + 本地 bare
# 仓库当 origin，PR 提交按 GitHub 的形状挂在 refs/pull/N/head）、HOME 指向 temp。
#
# 冲突是真冲突：主干和 PR 改同一个文件的真实提交。每一轮都**真的**起 agent-poll.sh
# 子进程，假 gh / git 包装器把每一次调用记下来，
# 所以「这一轮到底多问了 GitHub 几次」是数出来的，不是推出来的。
#
# 这块错了的方向都不报错，只会悄悄变成别的样子：
#   · 把「判不了」（拉不到、出错）当成「没冲突」→ 冲突永远发现不了；
#   · 不去重 → 每次目标分支一动，同一个 PR 就收一条评论、被送回 worker 一次；
#   · 每轮都问 → 调用量随轮数线性涨（bot 号被封过一次，这是最怕的那种）；
#   · 拿本机过期的目标分支去判 → 主干新进的冲突看不见；
#   · 两种评论共用标记 → 只提醒的 PR 在状态丢失后被静默升级成自动改代码。
# 末尾的负对照把这七种错误实现分别塞进脚本副本里，断言本测试能把它们全部拦下；
# 「对拍」一节拿同一批 PR 让 worker 交 PR 前那段冲突检查命令和 daemon 各判一遍，结论必须一致。
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"

SANDBOX=$(mktemp -d)
cleanup() {
    local s
    for s in $(tmux ls -F '#{session_name}' 2>/dev/null | grep -E '^cftest-' || true); do
        tmux kill-session -t "=$s" 2>/dev/null || true
    done
    [ -n "${KEEP_SANDBOX:-}" ] && { echo "SANDBOX=$SANDBOX"; return 0; }
    rm -rf "$SANDBOX"
}
trap cleanup EXIT

mkdir -p "$SANDBOX/bin" "$SANDBOX/home"
REAL_GIT=$(command -v git)
export HOME="$SANDBOX/home"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1

# ── 假 gh ──
# 路由按真实调用的形状写（agent-poll.sh / _lib.sh 里实际发出的那几种），--jq 用真 jq 执行。
# 每次调用往 $CALLS 追一行。F_* 文件存在 = 对应调用失败。
cat > "$SANDBOX/bin/gh" <<'GHEOF'
#!/usr/bin/env bash
D="$FAKE_GH_DIR"
echo "gh $*" >> "$D/calls.log"
jqexpr=""; method=GET; body=""; labels=(); path=""
args=("$@")
for ((i=0; i<${#args[@]}; i++)); do
    a="${args[$i]}"
    case "$a" in
        --jq) jqexpr="${args[$((i+1))]}"; i=$((i+1)) ;;
        -X|--method) method="${args[$((i+1))]}"; i=$((i+1)) ;;
        -f|-F)
            kv="${args[$((i+1))]}"; i=$((i+1))
            case "$kv" in body=*) body="${kv#body=}" ;; "labels[]="*) labels+=("${kv#labels[]=}") ;; esac ;;
        repos/*) path="$a" ;;
    esac
done
emit() {   # json → stdout（有 --jq 就过 jq）
    if [ -n "$jqexpr" ]; then printf '%s' "$1" | jq -r "$jqexpr"; else printf '%s\n' "$1"; fi
}
R="repos/example/cf"
case "$1 ${2:-}" in
    "pr view") emit "$(cat "$D/prview-$3.json")"; exit 0 ;;   # worker 那段冲突检查命令用它
esac
case "$1" in
    pr|issue) echo '[]'; exit 0 ;;
esac
case "$method $path" in
    "GET $R/issues") cat "$D/issues.json"; exit 0 ;;
    "GET $R/pulls")  cat "$D/pulls.json";  exit 0 ;;
    "GET $R/pulls/"*)
        n="${path##*/}"
        [ -f "$D/F_pull_$n" ] && { echo "HTTP 502" >&2; exit 1; }
        [ -f "$D/pr-$n.json" ] || { echo "HTTP 404" >&2; exit 1; }
        emit "$(cat "$D/pr-$n.json")"; exit 0 ;;
    "GET $R/issues/"*/comments)
        n="${path#$R/issues/}"; n="${n%/comments}"
        [ -f "$D/F_read_comments" ] && { echo "HTTP 502" >&2; exit 1; }
        f="$D/comments-$n.json"; [ -f "$f" ] || echo '[]' > "$f"
        emit "$(cat "$f")"; exit 0 ;;
    "POST $R/issues/"*/comments)
        n="${path#$R/issues/}"; n="${n%/comments}"
        [ -f "$D/F_comment" ] && { echo "HTTP 500 comment" >&2; exit 1; }
        f="$D/comments-$n.json"; [ -f "$f" ] || echo '[]' > "$f"
        jq --arg b "$body" '. + [{body: $b}]' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
        echo '{}'; exit 0 ;;
    "POST $R/issues/"*/labels)
        [ -f "$D/F_labels" ] && { echo "HTTP 500 labels" >&2; exit 1; }
        echo '[]'; exit 0 ;;
    "DELETE $R/issues/"*) exit 0 ;;
esac
# 其余（gh_last_id 之类）：空列表
emit '[]'
exit 0
GHEOF

# ── git 包装器：只为数 ls-remote / fetch 次数，其余原样交给真 git ──
cat > "$SANDBOX/bin/git" <<GITEOF
#!/usr/bin/env bash
for a in "\$@"; do case "\$a" in ls-remote|fetch) echo "git \$*" >> "\$FAKE_GH_DIR/calls.log"; break ;; esac; done
exec "$REAL_GIT" "\$@"
GITEOF
chmod +x "$SANDBOX/bin/gh" "$SANDBOX/bin/git"

pass=0; fail=0; QUIET=0
chk() {
    if [ "$2" = "$3" ]; then
        [ "$QUIET" = 1 ] || echo "  ✅ $1"; pass=$((pass+1))
    else
        [ "$QUIET" = 1 ] || echo "  ❌ $1 (期望 [$3]，实得 [$2])"; fail=$((fail+1))
    fi
}

iso_ago() { date -u -d "@$(( $(date +%s) - $1 ))" +%Y-%m-%dT%H:%M:%SZ; }
DAY=86400

# ─────────────────────────────────────────────────────────────────────────
# 一整套场景。$1 = 被测的 scripts 目录（正式版或负对照改坏的副本）。
# 返回前 $fail 里是失败条数。
# ─────────────────────────────────────────────────────────────────────────
run_scenarios() {
    local SCRIPTS="$1" W="$SANDBOX/run"
    rm -rf "$W"; mkdir -p "$W/state" "$W/wt" "$W/gh"
    export FAKE_GH_DIR="$W/gh"
    local CONF="$W/cavil-loop.config"
    cat > "$CONF" <<CONF
REPO="example/cf"
PROJECT_ROOT="$W/project"
WORKTREE_BASE="$W/wt"
STATE_DIR="$W/state"
TMUX_PREFIX="cftest"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
LABEL_AGENT_DOING="doing/agent"
LABEL_PENDING_REVIEW="pending/review"
POST_MERGE_RETROSPECTIVE=false
AUTO_CLEANUP_ON_MERGE=false
POLL_BACKOFF_LADDER=""
PRICE_AUTO_FETCH=0
PENDING_HUMAN_CONFLICT_MAX_TRIES=3
PATH="$SANDBOX/bin:\$PATH"
CONF
    local STATE="$W/state/state.json" CALLS="$W/gh/calls.log" GD="$W/gh" SEED="$W/seed"

    # ── 真 git：bare origin（GitHub 的形状：PR 提交挂在 refs/pull/N/head）+ 主 checkout ──
    g() { "$REAL_GIT" -C "$SEED" -c user.email=t@x -c user.name=t "$@"; }
    "$REAL_GIT" init -q --bare "$W/origin.git"
    "$REAL_GIT" init -q -b main "$SEED"
    local n
    for n in $(seq 10 29); do echo base > "$SEED/p$n.txt"; done
    g add . && g commit -qm base && g push -q "$W/origin.git" main 2>/dev/null
    local T0; T0=$(g rev-parse HEAD)
    "$REAL_GIT" clone -q "$W/origin.git" "$W/project" 2>/dev/null
    # 每个 PR：从 T0 改自己那个文件。主干之后也改同一个文件 = 真冲突；不改 = 干净。
    mkpr() {   # num [content] [parent] → 打印提交号，并推到 refs/pull/N/head（push=0 时不推）
        g checkout -q --detach "${3:-$T0}"
        echo "${2:-pr}" > "$SEED/p$1.txt"; g commit -qam "pr $1"
        [ "${PUSH:-1}" = 1 ] && g push -q -f "$W/origin.git" "HEAD:refs/pull/$1/head" 2>/dev/null
        g rev-parse HEAD
    }
    main_touch() {   # 主干改这些 PR 的文件 → 与它们冲突
        g checkout -q main; local x
        for x in "$@"; do echo "main" > "$SEED/p$x.txt"; done
        g commit -qam "main touches $*"; g push -q "$W/origin.git" main 2>/dev/null
    }

    tick() { : > "$CALLS"; env CODING_AGENT_CONFIG="$CONF" bash "$SCRIPTS/agent-poll.sh" >/dev/null 2>&1; }
    n_calls() { grep -cE -- "$1" "$CALLS" 2>/dev/null || true; }
    judged() { n_calls "^git .*fetch.* refs/pull/$1/head\$"; }        # 这一轮判了它几次
    got_pull() { n_calls "^gh api repos/example/cf/pulls/$1\$"; }
    posted() { n_calls "^gh api -X POST repos/example/cf/issues/$1/comments "; }
    flipped() { n_calls "^gh api -X POST repos/example/cf/issues/$1/labels -f labels\\[\\]=$2\$"; }
    marker_count() { jq -r '.[].body' "$GD/comments-$1.json" 2>/dev/null | grep -c "pending-human-conflict head=$2 mode=$3" || true; }
    st() { jq -r --arg p "$1" ".pr_conflict[\$p].$2 // \"\"" "$STATE"; }

    snap() {   # num head base labels_csv [fork]
        local repo="example/cf"; [ "${5:-}" = fork ] && repo="someone/cf"
        jq -cn --argjson n "$1" --arg h "$2" --arg b "$3" --arg l "$4" --arg r "$repo" \
            '{number:$n, head:{sha:$h, ref:("feature/issue-"+($n|tostring)), repo:{full_name:$r}}, base:{ref:$b},
              labels:($l | split(",") | map(select(. != "")) | map({name:.})), updated_at:"2026-01-01T00:00:00Z", title:"t", body:""}'
    }
    prj() {   # num head updated_iso labels_csv [base] [state] [fork] —— 冲突时 daemon 现读的那份 PR
        # 字段照真实 GET /pulls/N 的形状给全（state / merged / base.ref / head.repo）：
        # 缺字段的夹具会让「缺字段当成有效」的实现蒙混过关
        local repo="example/cf"; [ "${7:-}" = fork ] && repo="someone/cf"
        local st="${6:-open}" merged=false
        [ "$st" = merged ] && { st=closed; merged=true; }
        jq -cn --argjson n "$1" --arg h "$2" --arg u "$3" --arg l "$4" --arg b "${5:-main}" \
               --arg st "$st" --argjson m "$merged" --arg r "$repo" \
            '{number:$n, state:$st, merged:$m,
              head:{sha:$h, ref:("feature/issue-"+($n|tostring)), repo:{full_name:$r}}, base:{ref:$b},
              updated_at:$u, labels:($l | split(",") | map({name:.}))}' > "$GD/pr-$1.json"
    }
    set_pulls() { printf '%s\n' "$@" | jq -cs '[.]' > "$GD/pulls.json"; }

    echo '[[]]' > "$GD/issues.json"
    local PH="pending/human"

    [ "$QUIET" = 1 ] || echo "【0】没有等人审的 PR → 一次都不多问"
    echo '[[]]' > "$GD/pulls.json"
    tick
    chk "不取目标分支提交" "$(n_calls '^git .*ls-remote')" 0
    chk "不拉任何 PR" "$(n_calls '^git .*fetch.*refs/pull/')" 0

    [ "$QUIET" = 1 ] || echo "【1】第一次看到：各类 PR 各走各的路"
    local H10 H11 H12 H13 H14 H15 H16
    H10=$(mkpr 10); H11=$(mkpr 11); H12=$(mkpr 12); H13=$(mkpr 13); H14=$(mkpr 14); H15=$(mkpr 15)
    H16=$(PUSH=0 mkpr 16)          # 远端还拉不到它 → 判不了
    main_touch 10 11 12 13 14 16
    set_pulls \
        "$(snap 10 "$H10" main "$PH")" \
        "$(snap 11 "$H11" main "$PH")" \
        "$(snap 12 "$H12" main "doing/agent")" \
        "$(snap 13 "$H13" main "pending/review,$PH")" \
        "$(snap 14 "$H14" main "$PH" fork)" \
        "$(snap 15 "$H15" main "$PH")" \
        "$(snap 16 "$H16" main "$PH")"
    prj 10 "$H10" "$(iso_ago $DAY)" "$PH"
    prj 11 "$H11" "$(iso_ago $((5 * DAY)))" "$PH"
    prj 14 "$H14" "$(iso_ago 600)" "$PH" main open fork
    prj 15 "$H15" "$(iso_ago 600)" "$PH"
    prj 16 "$H16" "$(iso_ago 600)" "$PH"
    tick
    chk "目标分支提交只取一次" "$(n_calls '^git .*ls-remote')" 1
    chk "#10（1 天前更新）发「交回 worker」评论" "$(marker_count 10 "$H10" worker)" 1
    chk "#10 翻成 pending/agent" "$(flipped 10 pending/agent)" 1
    chk "#11（5 天没动）只发提醒" "$(marker_count 11 "$H11" remind)" 1
    chk "#11 标签不动" "$(n_calls '^gh api -X POST repos/example/cf/issues/11/labels')" 0
    chk "#12（worker 正在干）不判" "$(judged 12)" 0
    chk "#13（复审轮次用尽、等人拍板）不判" "$(judged 13)" 0
    chk "#14（外部仓库）只提醒" "$(marker_count 14 "$H14" remind)" 1
    chk "#14 标签不动" "$(n_calls '^gh api -X POST repos/example/cf/issues/14/labels')" 0
    chk "#15 干净 → 不发评论" "$(posted 15)" 0
    chk "#15 干净 → 连 PR 都不现读（不占接口额度）" "$(got_pull 15)" 0
    chk "#15 记为干净" "$(st 15 done)" clean
    chk "#16 拉不到 → 不发评论" "$(posted 16)" 0
    chk "#16 不当成干净" "$(st 16 done)" ""

    [ "$QUIET" = 1 ] || echo "【2】什么都没变的下一轮：只重判还没结论的那一个"
    tick
    chk "只拉 #16" "$(n_calls '^git .*fetch.*refs/pull/')" 1
    chk "#16 被重判" "$(judged 16)" 1
    chk "没有任何新评论" "$(n_calls '^gh api -X POST .*/comments ')" 0

    [ "$QUIET" = 1 ] || echo "【3】#16 拉得到了、是冲突 → 这一轮处理"
    g checkout -q --detach "$H16"; g push -q "$W/origin.git" "HEAD:refs/pull/16/head" 2>/dev/null
    tick
    chk "#16 交回 worker" "$(flipped 16 pending/agent)" 1
    chk "#16 评论一条" "$(marker_count 16 "$H16" worker)" 1

    [ "$QUIET" = 1 ] || echo "【4】全都有结论之后：目标分支没动 → 一个 PR 都不拉、不问"
    tick
    chk "拉取 0 次" "$(n_calls '^git .*fetch.*refs/pull/')" 0
    chk "GitHub 调用里没有单个 PR" "$(n_calls '^gh api repos/example/cf/pulls/[0-9]')" 0
    tick
    chk "再一轮仍是 0 次" "$(n_calls '^git .*fetch.*refs/pull/')" 0

    [ "$QUIET" = 1 ] || echo "【5】目标分支进了跟 #15 冲突的新提交：按**远端最新**提交判，只重判没处理过的"
    main_touch 15
    tick
    chk "#15 被重判" "$(judged 15)" 1
    chk "已处理过的 #10 #11 #16 不重判" "$(( $(judged 10) + $(judged 11) + $(judged 16) ))" 0
    chk "#15 现在冲突 → 交回 worker" "$(flipped 15 pending/agent)" 1

    [ "$QUIET" = 1 ] || echo "【6】worker 推了新提交又交回来、仍冲突 → 再处理一次（只一次）"
    local H10b; H10b=$(mkpr 10 pr2 "$H10")
    set_pulls \
        "$(snap 10 "$H10b" main "$PH")" "$(snap 11 "$H11" main "$PH")" \
        "$(snap 14 "$H14" main "$PH" fork)" "$(snap 15 "$H15" main "$PH")" "$(snap 16 "$H16" main "$PH")"
    prj 10 "$H10b" "$(iso_ago 60)" "$PH"
    tick
    chk "#10 新提交上发一条" "$(marker_count 10 "$H10b" worker)" 1
    chk "#10 再次交回 worker" "$(flipped 10 pending/agent)" 1
    tick
    chk "下一轮不重复" "$(marker_count 10 "$H10b" worker)" 1
    chk "关掉的 #12 #13 记录被清掉" "$(jq -r '.pr_conflict | has("12") or has("13")' "$STATE")" false

    [ "$QUIET" = 1 ] || echo "【7】故障：取不到目标分支提交 → 本轮什么都不写"
    local H17; H17=$(mkpr 17); main_touch 17
    set_pulls "$(snap 17 "$H17" main "$PH")"
    prj 17 "$H17" "$(iso_ago 60)" "$PH"
    "$REAL_GIT" -C "$W/project" remote set-url origin "$W/nowhere.git"
    tick
    chk "不拉 PR" "$(judged 17)" 0
    chk "不发评论" "$(posted 17)" 0
    chk "不记状态" "$(st 17 key)" ""
    "$REAL_GIT" -C "$W/project" remote set-url origin "$W/origin.git"

    [ "$QUIET" = 1 ] || echo "【8】故障：评论发不出去 → 不翻标签；恢复后评论只发一次"
    touch "$GD/F_comment"; tick; rm -f "$GD/F_comment"
    chk "评论失败时不翻标签" "$(flipped 17 pending/agent)" 0
    tick
    chk "恢复后评论一条" "$(marker_count 17 "$H17" worker)" 1
    chk "恢复后翻标签" "$(flipped 17 pending/agent)" 1

    [ "$QUIET" = 1 ] || echo "【9】故障：评论发了但翻标签失败 → 下轮只补翻标签"
    local H18; H18=$(mkpr 18); main_touch 18
    set_pulls "$(snap 18 "$H18" main "$PH")"
    prj 18 "$H18" "$(iso_ago 60)" "$PH"
    touch "$GD/F_labels"; tick; rm -f "$GD/F_labels"
    chk "第一轮评论已发" "$(marker_count 18 "$H18" worker)" 1
    tick
    chk "补翻标签" "$(flipped 18 pending/agent)" 1
    chk "评论没重发" "$(marker_count 18 "$H18" worker)" 1

    [ "$QUIET" = 1 ] || echo "【10】另一台机器已处理过 / 本机状态丢了 → 不重复、不升级"
    local H19 H20; H19=$(mkpr 19); H20=$(mkpr 20); main_touch 19 20
    set_pulls "$(snap 19 "$H19" main "$PH")" "$(snap 20 "$H20" main "$PH")"
    prj 19 "$H19" "$(iso_ago 60)" "$PH"
    prj 20 "$H20" "$(iso_ago 60)" "$PH"
    # #19：别的机器交回过 worker，worker 没解开又交人了（提交没变）
    jq -cn --arg m "<!-- cavil-loop:pending-human-conflict head=$H19 mode=worker -->" '[{body:$m}]' > "$GD/comments-19.json"
    # #20：以前只提醒过；提醒那条评论把「最近更新」刷新成了刚才
    jq -cn --arg m "<!-- cavil-loop:pending-human-conflict head=$H20 mode=remind -->" '[{body:$m}]' > "$GD/comments-20.json"
    tick
    chk "#19 不再塞回 worker" "$(flipped 19 pending/agent)" 0
    chk "#19 不再发评论" "$(posted 19)" 0
    chk "#20 提醒过的不升级成自动解" "$(flipped 20 pending/agent)" 0
    chk "#20 不再发评论" "$(posted 20)" 0

    [ "$QUIET" = 1 ] || echo "【11】故障：现读 PR 失败 / 人刚改了标签 / 一直拉不到"
    local H21 H22 H23; H21=$(mkpr 21); H22=$(mkpr 22); H23=$(PUSH=0 mkpr 23); main_touch 21 22 23
    set_pulls "$(snap 21 "$H21" main "$PH")" "$(snap 22 "$H22" main "$PH")" "$(snap 23 "$H23" main "$PH")"
    prj 21 "$H21" "$(iso_ago 60)" "$PH"; touch "$GD/F_pull_21"
    prj 22 "$H22" "$(iso_ago 60)" "pending/agent"     # 快照之后人改了标签
    prj 23 "$H23" "$(iso_ago 60)" "$PH"
    tick
    chk "#21 现读失败 → 不写" "$(posted 21)" 0
    chk "#22 现读标签已不是等人 → 不写" "$(posted 22)" 0
    chk "#22 不翻标签" "$(n_calls '^gh api -X POST repos/example/cf/issues/22/labels')" 0
    tick; tick
    chk "#23 判满 3 次后放弃这一版" "$(st 23 done)" gaveup
    tick
    chk "#23 放弃后不再拉" "$(judged 23)" 0
    chk "#21 同样到上限后不再拉" "$(judged 21)" 0
    rm -f "$GD/F_pull_21"

    [ "$QUIET" = 1 ] || echo "【12】配置：自动解冲突天数设 0 → 最近更新的也只提醒；整段关掉 → 一次都不问"
    local H24; H24=$(mkpr 24); main_touch 24
    set_pulls "$(snap 24 "$H24" main "$PH")"
    prj 24 "$H24" "$(iso_ago 60)" "$PH"
    echo 'PENDING_HUMAN_CONFLICT_AUTOFIX_DAYS=0' >> "$CONF"
    tick
    chk "天数 0：只提醒" "$(marker_count 24 "$H24" remind)" 1
    chk "天数 0：不翻标签" "$(flipped 24 pending/agent)" 0
    local H25; H25=$(mkpr 25); main_touch 25
    set_pulls "$(snap 25 "$H25" main "$PH")"
    prj 25 "$H25" "$(iso_ago 60)" "$PH"
    echo 'PENDING_HUMAN_CONFLICT_CHECK=false' >> "$CONF"
    tick
    chk "关掉：不取目标分支提交" "$(n_calls '^git .*ls-remote')" 0
    chk "关掉：不拉 PR" "$(judged 25)" 0

    [ "$QUIET" = 1 ] || echo "【14】判定之后、写之前 PR 变了：改投别的分支 / 已关闭合并 / 现读缺状态字段 → 不写，下轮按现状判"
    sed -i '/^PENDING_HUMAN_CONFLICT_CHECK=false$/d; /^PENDING_HUMAN_CONFLICT_AUTOFIX_DAYS=0$/d' "$CONF"
    g push -q "$W/origin.git" "$T0:refs/heads/release" 2>/dev/null     # release = 没被主干改过的 T0
    local H27 H28 H29; H27=$(mkpr 27); H28=$(mkpr 28); H29=$(mkpr 29); main_touch 27 28 29
    set_pulls "$(snap 27 "$H27" main "$PH")" "$(snap 28 "$H28" main "$PH")" "$(snap 29 "$H29" main "$PH")"
    prj 27 "$H27" "$(iso_ago 60)" "$PH" release              # 快照之后改投 release
    prj 28 "$H28" "$(iso_ago 60)" "$PH" main merged          # 快照之后已合并关闭，标签还留着
    prj 29 "$H29" "$(iso_ago 60)" "$PH"; jq 'del(.state, .merged)' "$GD/pr-29.json" > "$GD/x" && mv "$GD/x" "$GD/pr-29.json"
    tick
    chk "#27 改投后不按旧 main 发评论" "$(posted 27)" 0
    chk "#27 不交回 worker" "$(flipped 27 pending/agent)" 0
    chk "#27 不记为已处理" "$(st 27 acted_head)" ""
    chk "#28 已合并的不发评论" "$(posted 28)" 0
    chk "#28 不交回 worker" "$(flipped 28 pending/agent)" 0
    chk "#29 现读缺状态字段 → 不写" "$(( $(posted 29) + $(flipped 29 pending/agent) ))" 0
    # 下一轮快照也看到了新目标分支：按 release 重判 → 干净，全程不写
    set_pulls "$(snap 27 "$H27" release "$PH")"
    tick
    chk "#27 按新目标 release 重判" "$(judged 27)" 1
    chk "#27 与 release 干净" "$(st 27 done)" clean
    chk "#27 全程没评论" "$(posted 27)" 0

    [ "$QUIET" = 1 ] || echo "【13】主 checkout 不受影响：工作区、分支、引用都没动"
    chk "工作区干净" "$("$REAL_GIT" -C "$W/project" status --porcelain | wc -l)" 0
    chk "没写任何 PR 引用" "$("$REAL_GIT" -C "$W/project" for-each-ref | grep -c pull || true)" 0
    chk "origin/main 没被挪动" "$("$REAL_GIT" -C "$W/project" rev-parse origin/main)" "$T0"
}

echo "═══ 正式版 ═══"
run_scenarios "$REPO_DIR/scripts"

# ─────────────────────────────────────────────────────────────────────────
# 对拍：同一条「有没有冲突」的规则有两份实现 —— worker 交出 PR 前跑的那段命令
# （prompts/*.template.md 里「冲突检查 开始/结束」之间，GitHub#82）和 daemon 这里的
# pr_conflict_verdict。拿上面场景跑完后的同一个 origin（有冲突的、干净的、拉不到的
# PR 都有），两边逐个 PR 判一遍，结论必须一致。
# ─────────────────────────────────────────────────────────────────────────
echo "【对拍】worker 的冲突检查命令 vs daemon 的判定，同一批 PR 结论一致"
W="$SANDBOX/run"
"$REAL_GIT" -C "$W/seed" checkout -q --detach "$("$REAL_GIT" -C "$W/seed" rev-parse main)"
echo new > "$W/seed/p26.txt"; "$REAL_GIT" -C "$W/seed" add p26.txt
"$REAL_GIT" -C "$W/seed" -c user.email=t@x -c user.name=t commit -qm "pr 26 (clean)"
"$REAL_GIT" -C "$W/seed" push -q "$W/origin.git" "HEAD:refs/pull/26/head" 2>/dev/null
TIP=$("$REAL_GIT" --git-dir="$W/origin.git" rev-parse main)
"$REAL_GIT" clone -q "$W/origin.git" "$W/worker-wt" 2>/dev/null
sed -n '/^# --- 冲突检查 开始 ---$/,/^# --- 冲突检查 结束 ---$/p' "$REPO_DIR/prompts/pr-comment.template.md" \
    | sed 's|\${REPO}|example/cf|g' > "$SANDBOX/snippet.sh"
agree=0; disagree=""; seen_kinds=""
for n in 10 11 15 17 23 26; do
    # PR 现在的提交：远端有 refs/pull/N/head 就用它；#23 从没推上去，用 daemon 看到的那个
    head=$("$REAL_GIT" --git-dir="$W/origin.git" rev-parse -q --verify "refs/pull/$n/head" 2>/dev/null) \
        || head=$(jq -r .head.sha "$W/gh/pr-$n.json")
    jq -cn --arg h "$head" '{baseRefName:"main", headRefOid:$h}' > "$W/gh/prview-$n.json"
    w=$(cd "$W/worker-wt" && PATH="$SANDBOX/bin:$PATH" FAKE_GH_DIR="$W/gh" P=$n bash "$SANDBOX/snippet.sh" 2>/dev/null \
        | sed -n 's/^CONFLICT_CHECK=\([a-z]*\).*/\1/p')
    case "$w" in error) w=unknown ;; esac
    d=$(cd "$REPO_DIR" && FAKE_GH_DIR="$W/gh" CODING_AGENT_CONFIG="$W/cavil-loop.config" bash -c '
        exec 8>&2; source scripts/_lib.sh; exec 2>&8 8>&-; set +e
        pr_conflict_verdict "$1" main "$2" "$3"' _ "$n" "$TIP" "$head" 2>/dev/null)
    seen_kinds+=" $d"
    if [ -n "$w" ] && [ "$w" = "$d" ]; then agree=$((agree+1)); else disagree+=" #$n(worker=$w daemon=$d)"; fi
done
chk "6 个 PR 两边结论一致" "$agree${disagree}" 6
chk "这批里干净 / 冲突 / 判不了三种都有（否则对拍说明不了什么）" \
    "$(for k in clean conflict unknown; do case "$seen_kinds" in *" $k"*) printf '%s ' "$k" ;; esac; done)" "clean conflict unknown "

real_pass=$pass real_fail=$fail

# ─────────────────────────────────────────────────────────────────────────
# 负对照：每种错误实现塞进一份脚本副本，整套场景重跑，至少要红一条。
# 改坏的方式用 python 精确替换源码片段；片段对不上（源码改了）→ 本条负对照算失败，
# 免得替换悄悄没生效、负对照「通过」得毫无意义。
# ─────────────────────────────────────────────────────────────────────────
echo "═══ 负对照（每种错误实现都必须被拦下）═══"
neg_fail=0
negative() {   # name python-old python-new
    local name="$1" dir="$SANDBOX/neg-scripts"
    rm -rf "$dir"; cp -r "$REPO_DIR/scripts" "$dir"
    if ! python3 - "$dir/_lib.sh" "$2" "$3" <<'PY'
import sys
p, old, new = sys.argv[1:4]
s = open(p).read()
if old not in s: sys.exit(1)
open(p, 'w').write(s.replace(old, new, 1))
PY
    then echo "  ❌ $name：源码里找不到要改的片段（负对照失效）"; neg_fail=$((neg_fail+1)); return; fi
    pass=0; fail=0; QUIET=1
    run_scenarios "$dir"
    QUIET=0
    if [ "$fail" -gt 0 ]; then echo "  ✅ $name → 红 $fail 条"
    else echo "  ❌ $name → 一条都没红（测试分辨不出这种错误实现）"; neg_fail=$((neg_fail+1)); fi
}
negative "「判不了」当成「没冲突」" \
    '        echo unknown; return 0
    fi
    # 快照之后' \
    '        echo clean; return 0
    fi
    # 快照之后'
negative "不去重（处理过的提交照样重判）" \
    '        [ "$st_acted" = "$head" ] && continue' \
    '        :'
negative "每轮都判（不看目标分支提交有没有变）" \
    '        [ "$st_key" = "$key" ] && [ -n "$st_done" ] && continue' \
    '        :'
negative "拿本机过期的目标分支判（不用远端最新提交）" \
    'merge-tree --write-tree --name-only "$head" "$tip"' \
    'merge-tree --write-tree --name-only "$head" "origin/$base"'
negative "写之前不核对 PR 是否还开着" \
    '            .state == "open" and (.merged // false) == false
            and' \
    '            true
            and'
negative "写之前不核对目标分支有没有改" \
    '.head.sha == $h and .base.ref == $b' \
    '.head.sha == $h'
negative "两种评论共用一个标记" \
    '        marker_remind="<!-- cavil-loop:pending-human-conflict head=$head mode=remind -->"' \
    '        marker_remind="<!-- cavil-loop:pending-human-conflict head=$head mode=worker -->"'

echo
echo "正式版：$real_pass 通过 / $real_fail 失败；负对照失效 $neg_fail 条"
[ "$real_fail" -eq 0 ] && [ "$neg_fail" -eq 0 ]
