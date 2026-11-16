#!/usr/bin/env bash
# kind: guard
# 桌面客户端替仓库建标签时用的颜色和说明（GitHub#559）必须和 setup.sh 建标签时的一样。
#
# 两份是同一张表的两个副本：setup.sh 第 5 步的 label_defs（daemon 接入仓库时建），
# client/src/shared/labelSetup.ts 的 LABEL_DEFAULTS（客户端「建标签」按钮建）。客户端只建四种：
# 派工 pending/agent、托管、等前置、等人处理 pending/human。改了一边忘了另一边，客户端建出来的
# 标签就和安装脚本建的长得不一样——这里逐项对：颜色、说明，一个字都不能差。
#
#   bash tests/label-defaults.test.sh
set -uo pipefail
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SETUP="$REPO_DIR/setup.sh"
CLIENT="$REPO_DIR/client/src/shared/labelSetup.ts"

pass=0; fail=0
chk() {
    if [ "$2" = "$3" ]; then echo "  ✅ $1"; pass=$((pass+1))
    else echo "  ❌ $1 (期望 [$3]，实得 [$2])"; fail=$((fail+1)); fi
}

# 每行「角色|颜色|说明」；读不到某个角色就是空行，下面的对比会把它报成失败
OUT=$(python3 - "$SETUP" "$CLIENT" <<'PY'
import re, sys
setup = open(sys.argv[1], encoding='utf-8').read()
client = open(sys.argv[2], encoding='utf-8').read()
# setup.sh：label_defs 里的 "名字|颜色|说明"，名字是字面量或 $变量
rows = re.findall(r'"([^"|]+)\|([0-9a-fA-F]{6})\|([^"]*)"', setup)
by_name = {n: (c.lower(), d) for n, c, d in rows}
want = {'agent': 'pending/agent', 'human': 'pending/human', 'autopilot': '$autopilot_label', 'blocked': '$blocked_label'}
# 客户端：LABEL_DEFAULTS 里的 role: { color: '…', description: zhKey('…') }
m = re.search(r'LABEL_DEFAULTS[^=]*=\s*\{(.*?)\n\};', client, re.S)
table = {}
if m:
    for role, color, desc in re.findall(r"(\w+):\s*\{\s*color:\s*'([0-9a-fA-F]{6})',\s*description:\s*zhKey\('([^']*)'\)\s*\}", m.group(1)):
        table[role] = (color.lower(), desc)
print('roles=' + ','.join(sorted(table)))
for role, name in sorted(want.items()):
    s = by_name.get(name)
    c = table.get(role)
    print(f"setup|{role}|{s[0] if s else ''}|{s[1] if s else ''}")
    print(f"client|{role}|{c[0] if c else ''}|{c[1] if c else ''}")
PY
)
echo "── 客户端表里正好是四个角色 ──"
chk "LABEL_DEFAULTS 的角色" "$(printf '%s\n' "$OUT" | sed -n 's/^roles=//p')" "agent,autopilot,blocked,human"

echo "── 每个角色：setup.sh 与客户端的颜色、说明逐字相同 ──"
for role in agent autopilot blocked human; do
    s=$(printf '%s\n' "$OUT" | grep "^setup|$role|" | cut -d'|' -f3-)
    c=$(printf '%s\n' "$OUT" | grep "^client|$role|" | cut -d'|' -f3-)
    chk "$role：setup.sh 里读到了" "$([ -n "${s%|}" ] && echo yes || echo no)" "yes"
    chk "$role：客户端与 setup.sh 一致" "$c" "$s"
done

echo
echo "通过 $pass，失败 $fail"
report_counts "$pass" "$fail"
[ "$fail" -eq 0 ]
