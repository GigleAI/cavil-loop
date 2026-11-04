#!/usr/bin/env bash
# setup.sh 建 GitHub 标签时的默认颜色（GitHub#130，前一次同类漂移是 #52）。
#
# 默认配色照抄本仓库 GigleAI/cavil-loop 的 labels 页。这里真跑安装入口（隔离 HOME、
# 假 gh / systemctl / claude），把所有可选标签都打开，记下它实际发出的每一条建标签请求，
# 断言恰好是下面这 13 个标签、名字和颜色逐个对上——不是只数个数，也不读源码文本。
#
#   bash tests/setup-label-colors.test.sh              默认回归
#   MUTATION=1 bash tests/setup-label-colors.test.sh   另跑负对照：两处改色各退回旧值，必须变红
set -uo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/mutation.sh
source "$REPO_DIR/tests/lib/mutation.sh"
SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT

pass=0; fail=0
chk() {
    if [ "$2" = "$3" ]; then echo "  ✅ $1"; pass=$((pass+1))
    else echo "  ❌ $1 (期望 [$3]，实得 [$2])"; fail=$((fail+1)); fi
}

# 期望的 13 个标签：名字|颜色（小写）。等外部需求机器人那个标签的名字由下面的配置指定。
EXPECTED='Done|586069
autopilot|ff401e
doing/agent|c2e0c6
pending/PR|eeeeee
pending/agent|d4c5f9
pending/agent/fable|8250df
pending/human|fbca04
pending/merge|5319e7
pending/review|1d76db
priority/p0|b60205
priority/p1|f9d0c4
priority/p2|bfd4f2
waiting/requester-bot|f9a8d4'

mkdir -p "$SANDBOX/fakebin"
cat > "$SANDBOX/fakebin/gh" <<'GH'
#!/usr/bin/env bash
# 建标签请求逐个参数记一行（参数之间用 \x1f 隔开），说明文字里有空格也拆得开
if [ "${1:-} ${2:-}" = "label create" ]; then
    (IFS=$'\x1f'; printf '%s\n' "$*") >> "${GH_LABEL_LOG:-/dev/null}"
    exit 0
fi
case "$*" in
    "auth status"*) exit 0 ;;
    "repo view"*) echo "acme/widget"; exit 0 ;;
    *"pr list"*--json*|*"issue list"*--json*) echo ""; exit 0 ;;
    *"repos/acme/widget/pulls"*) echo '[[]]'; exit 0 ;;
esac
echo '[]'
GH
cat > "$SANDBOX/fakebin/systemctl" <<'SC'
#!/usr/bin/env bash
case "$*" in *is-active*) exit 3 ;; *is-enabled*) echo disabled; exit 1 ;; esac
exit 0
SC
printf '#!/usr/bin/env bash\nexit 0\n' > "$SANDBOX/fakebin/claude"
chmod +x "$SANDBOX/fakebin"/*

make_skill_src() {   # <目录>：把当前工作区（含未提交改动）做成一个可发布的 skill 仓库
    local d="$1"
    rm -rf "$d" "$d.git"; git init -q --bare "$d.git"; git init -q -b main "$d"
    (cd "$REPO_DIR" && git ls-files -co --exclude-standard -z) \
        | (cd "$REPO_DIR" && xargs -0 -I{} cp --parents -P {} "$d/" 2>/dev/null)
    git -C "$d" add -A >/dev/null
    git -C "$d" -c user.email=t@example.invalid -c user.name=t commit -qm snapshot
    git -C "$d" remote add origin "$d.git"; git -C "$d" push -q -u origin main 2>/dev/null
}

run_setup() {   # <skill 目录> → stdout：每个建标签请求一行「名字|颜色」，按名字排序；安装失败输出 SETUP-FAILED
    local src="$1" H="$SANDBOX/h" HOST="$SANDBOX/projects/widget"
    rm -rf "$H" "$SANDBOX/projects"; mkdir -p "$H" "$SANDBOX/projects"
    git init -q -b main "$HOST"; git -C "$HOST" -c user.email=t@x -c user.name=t commit -q --allow-empty -m init
    # 和真实安装一样以配置模板打底，再打开全部可选标签（后写的赋值生效）
    { cat "$REPO_DIR/cavil-loop.config.example"
      printf 'REPO="acme/widget"\nPROJECT_ROOT="%s"\nSTATE_DIR="%s/state"\nWORKTREE_BASE="%s/wt"\nTMUX_PREFIX="widget"\n' "$HOST" "$H" "$H"
      printf 'LABEL_PENDING_REVIEW="pending/review"\n'
      printf 'LABEL_PENDING_REQUESTER_BOT="waiting/requester-bot"\n'
      printf 'LABEL_AUTOPILOT="autopilot"\nLABEL_PENDING_MERGE="pending/merge"\n'
    } > "$HOST/cavil-loop.config"
    printf 'n\n' | env -u CAVIL_SKILL_LINK -u CAVIL_DEPLOY_ROOT -u CAVIL_DEPLOY_CONF -u CODING_AGENT_CONFIG \
        -u CODING_AGENT_RELEASE_ROOT -u WORKER_AGENT HOME="$H" PATH="$SANDBOX/fakebin:$PATH" \
        GH_LABEL_LOG="$H/labels.log" bash "$src/setup.sh" "$HOST" > "$H/setup.out" 2>&1 \
        || { echo "SETUP-FAILED"; return; }
    # 每行：label␟create␟<名字>␟--color␟<颜色>␟--description␟<说明>␟--repo␟<仓库>
    python3 - "$H/labels.log" <<'PY'
import os, sys
rows = []
for line in open(sys.argv[1], encoding="utf-8") if os.path.exists(sys.argv[1]) else []:
    a = line.rstrip("\n").split("\x1f")
    name = a[2] if len(a) > 2 else ""
    color = a[a.index("--color") + 1].lower() if "--color" in a else ""
    rows.append((name, color))
print("\n".join(f"{n}|{c}" for n, c in sorted(rows)))
PY
}

suite() {   # <skill 目录>
    local got; got=$(run_setup "$1")
    chk "安装入口跑通" "$(printf '%s' "$got" | grep -c SETUP-FAILED)" 0
    chk "建标签请求一共 13 条" "$(printf '%s\n' "$got" | grep -c '|')" 13
    chk "13 个标签的名字和颜色逐个对上" "$got" "$EXPECTED"
    local name color
    while IFS='|' read -r name color; do
        chk "· $name 的颜色" "$(printf '%s\n' "$got" | awk -F'|' -v n="$name" '$1==n{print $2}')" "$color"
    done <<< "$EXPECTED"
}

echo "── 1. 当前工作区：全部可选标签打开时的默认配色 ──"
make_skill_src "$SANDBOX/src"
suite "$SANDBOX/src"

echo "── 2. 负对照：两处改色各自退回旧值，必须变红 ──"
neg_case() {   # <标题> <旧行> <新行>
    local title="$1" from="$2" to="$3" d="$SANDBOX/src-mut"
    mutation_gate || { echo "  ⏭ 负对照「$title」（MUTATION=1 才跑）"; return; }
    rm -rf "$d" "$d.git"; cp -r "$SANDBOX/src" "$d"
    if ! python3 - "$d/setup.sh" "$from" "$to" <<'PY'
import sys
p, a, b = sys.argv[1:4]; s = open(p, encoding="utf-8").read()
if s.count(a) != 1: sys.exit(1)
open(p, "w", encoding="utf-8").write(s.replace(a, b))
PY
    then echo "  ❌ 负对照「$title」准备失败：setup.sh 里找不到原文"; fail=$((fail+1)); return; fi
    git -C "$d" -c user.email=t@example.invalid -c user.name=t commit -qam mutate
    local p0=$pass f0=$fail out
    out=$(suite "$d"); local nf; nf=$(printf '%s\n' "$out" | grep -c '❌')
    if [ "$nf" -gt 0 ]; then echo "  ✅ 负对照「$title」变红（$nf 条断言失败）"; pass=$((p0+1)); fail=$f0
    else echo "  ❌ 负对照「$title」没变红"; pass=$p0; fail=$((f0+1)); fi
}
neg_case "autopilot 退回 0e8a16" '$autopilot_label|ff401e|' '$autopilot_label|0e8a16|'
neg_case "pending/PR 退回 bbbbbb" '"pending/PR|eeeeee|' '"pending/PR|bbbbbb|'

echo
mutation_summary "$0"
echo "通过 $pass，失败 $fail"
[ "$fail" -eq 0 ]
