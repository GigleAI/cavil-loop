#!/usr/bin/env bash
# kind: guard
# 模板里每个配置项都决定过「客户端项目配置弹窗显不显示」（GitHub#388 的补充）。
#
# 跑法：bash tests/config-fields-coverage.test.sh
# 依赖：python3。只读三个文本文件，不跑任何程序。
#
# 为什么要有：LABEL_PENDING_LATER（GitHub#463）和 STUCK_WORKER_*（GitHub#339）进了模板，却没登记进
# scripts/config-fields.txt，弹窗里看不到它们开没开，大多数项目一直关着没人发现。登记表本身的测试
# （tests/project-config.test.sh）只核对已登记的项，漏登记的它看不见。
#
# 查的是：
#   1. cavil-loop.config.example 里的每个配置项，恰好在 scripts/config-fields.txt（显示）和
#      tests/config-fields-hidden.txt（不显示，写明原因）其中一处
#   2. 不显示清单：类别是规定的几种、原因不空、没有重复、每项都在模板里
#   2b. 显示登记表：只显示的项每行写了自己的原因（第 8 列），可改的项不写（GitHub#554）
#   2c. 显示登记表：每行有层级（第 9 列 main / more / advanced），一组要么全是 advanced、要么一项都没有且至少一项 main（GitHub#591）
#   3. 检查本身能报错：往模板副本加一项不登记、一项两边都登记、写错类别、再放一行已删掉的「待登记」类别，都要报出来
set -uo pipefail
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
TPL="$REPO_DIR/cavil-loop.config.example"
FIELDS="$REPO_DIR/scripts/config-fields.txt"
HIDDEN="$TEST_DIR/config-fields-hidden.txt"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

pass=0; fail=0
chk() {   # <名字> <实际> <期望>
    if [ "$2" = "$3" ]; then echo "  ✓ $1"; pass=$((pass+1))
    else echo "  ✗ $1"; echo "      期望: $3"; echo "      实际: $2"; fail=$((fail+1)); fi
}

guard() {   # <模板> <显示登记表> <不显示清单> → 打印问题，一行一个
    python3 - "$1" "$2" "$3" <<'PY'
import re, sys
tpl, fields, hidden = sys.argv[1:4]
KINDS = {"命令", "钩子", "令牌", "网址", "目录", "名字", "安装时生效"}
keys = []
for l in open(tpl, encoding="utf-8"):
    m = re.match(r"^([A-Z_][A-Z0-9_]*)=", l)
    if m and m.group(1) not in keys:
        keys.append(m.group(1))
def rows(path):
    for l in open(path, encoding="utf-8"):
        if l.strip() and not l.lstrip().startswith("#"):
            yield [x.strip() for x in l.rstrip("\n").split("|")]
shown = {r[0] for r in rows(fields)}
for r in rows(fields):
    mode = r[4] if len(r) > 4 else ""
    why = r[7] if len(r) > 7 else ""
    if mode == "show" and not why:
        print("只显示的项要写自己的原因（第 8 列）:", r[0])
    elif mode != "show" and why:
        print("可改的项不写只显示的原因:", r[0])
# 层级（第 9 列，GitHub#591）：每行都要有、只能是这三个词；一组要么全是 advanced、要么一项 advanced 都没有，且至少一项 main
TIERS = ("main", "more", "advanced")
groups = {}
for r in rows(fields):
    tier = r[8] if len(r) > 8 else ""
    if len(r) != 9 or tier not in TIERS:
        print("层级（第 9 列）缺了或不是 main / more / advanced:", r[0])
        continue
    groups.setdefault(r[1], []).append(tier)
for g, ts in groups.items():
    if "advanced" in ts and set(ts) != {"advanced"}:
        print("一组里 advanced 和别的层级混在一起:", g)
    elif "advanced" not in ts and "main" not in ts:
        print("常用分组里一项 main 都没有:", g)
hid = {}
for r in rows(hidden):
    k = r[0]
    if k in hid:
        print("不显示清单登记了两次:", k)
    hid[k] = r
    if len(r) != 3 or r[1] not in KINDS:
        print("不显示清单格式或类别不对:", k)
    elif not r[2]:
        print("不显示清单要写原因:", k)
for k in keys:
    if k in shown and k in hid:
        print("两处都登记了:", k)
    elif k not in shown and k not in hid:
        print("模板里有、两处都没登记:", k)
for k in hid:
    if k not in keys:
        print("不显示清单里有、模板里没有:", k)
PY
}

echo "【1】当前仓库：模板里每一项恰好登记在一处"
out=$(guard "$TPL" "$FIELDS" "$HIDDEN")
chk "没有问题" "$out" ""
n_tpl=$(grep -cE '^[A-Z_][A-Z0-9_]*=' "$TPL")
chk "确实读到了模板里的配置项（不是空读）" "$([ "$n_tpl" -gt 50 ] && echo yes)" yes

echo "【2】检查本身能报错"
cp "$TPL" "$TMP/tpl"; echo 'BRAND_NEW_KEY="x"' >> "$TMP/tpl"
chk "模板加一项、两处都不登记：报出来" "$(guard "$TMP/tpl" "$FIELDS" "$HIDDEN")" "模板里有、两处都没登记: BRAND_NEW_KEY"

cp "$HIDDEN" "$TMP/hidden"; echo 'WORKER_AGENT | 名字 | 测试' >> "$TMP/hidden"
chk "一项两处都登记：报出来" "$(guard "$TPL" "$FIELDS" "$TMP/hidden")" "两处都登记了: WORKER_AGENT"

cp "$HIDDEN" "$TMP/hidden2"; sed -i 's/^REPO | 名字 |/REPO | 其他 |/' "$TMP/hidden2"
chk "类别写错：报出来" "$(guard "$TPL" "$FIELDS" "$TMP/hidden2")" "不显示清单格式或类别不对: REPO"

cp "$HIDDEN" "$TMP/hidden3"; echo 'GONE_KEY | 名字 | 测试' >> "$TMP/hidden3"
chk "清单里有、模板里没有：报出来" "$(guard "$TPL" "$FIELDS" "$TMP/hidden3")" "不显示清单里有、模板里没有: GONE_KEY"

# 「待登记」类别已清零删除（GitHub#556）：再往不显示清单里放一行这个类别要报错，可以显示的项只能登记进显示登记表
chk "当前不显示清单里一行「待登记」都没有" "$(grep -c '| 待登记 |' "$HIDDEN")" 0
cp "$HIDDEN" "$TMP/hidden4"; sed -i 's/^POLL_INTERVAL_SECS | 安装时生效 |/POLL_INTERVAL_SECS | 待登记 |/' "$TMP/hidden4"
chk "到达性：上面那行替换确实改到了一行" "$(grep -c '^POLL_INTERVAL_SECS | 待登记 |' "$TMP/hidden4")" 1
chk "再加一行「待登记」：报出来" "$(guard "$TPL" "$FIELDS" "$TMP/hidden4")" "不显示清单格式或类别不对: POLL_INTERVAL_SECS"

cp "$FIELDS" "$TMP/fields"; sed -i 's/^\(LABEL_PENDING_MERGE |.*\) | 标签名要和仓库里建好的标签一致 | \(more\)$/\1 |  | \2/' "$TMP/fields"
chk "到达性：上面那行替换确实改到了一行" "$(grep -c '^LABEL_PENDING_MERGE |.*|  | more$' "$TMP/fields")" 1
chk "只显示的项没写原因：报出来" "$(guard "$TPL" "$TMP/fields" "$HIDDEN")" "只显示的项要写自己的原因（第 8 列）: LABEL_PENDING_MERGE"

echo "【3】层级（GitHub#591）"
chk "当前登记表三种层级都用到了" "$(grep -vE '^[[:space:]]*(#|$)' "$FIELDS" | awk -F'|' '{gsub(/[ \t]/, "", $9); print $9}' | sort -u | tr '\n' ' ')" "advanced main more "
cp "$FIELDS" "$TMP/t1"; sed -i 's/^\(WORKER_MODEL |.*\) | main$/\1 | sometimes/' "$TMP/t1"
chk "层级写成不认识的词：报出来" "$(guard "$TPL" "$TMP/t1" "$HIDDEN")" "层级（第 9 列）缺了或不是 main / more / advanced: WORKER_MODEL"
cp "$FIELDS" "$TMP/t2"; sed -i 's/^\(WORKER_MODEL |.*\) | main$/\1/' "$TMP/t2"
chk "少了层级这一列：报出来" "$(guard "$TPL" "$TMP/t2" "$HIDDEN")" "层级（第 9 列）缺了或不是 main / more / advanced: WORKER_MODEL"
cp "$FIELDS" "$TMP/t3"; sed -i 's/^\(LOG_LEVEL |.*\) | advanced$/\1 | main/' "$TMP/t3"
chk "高级分组里混进一项常用：报出来" "$(guard "$TPL" "$TMP/t3" "$HIDDEN")" "一组里 advanced 和别的层级混在一起: 其他"
cp "$FIELDS" "$TMP/t4"; sed -i 's/^\(POST_MERGE_RETROSPECTIVE |.*\) | main$/\1 | more/' "$TMP/t4"
chk "常用分组一项 main 都没有：报出来" "$(guard "$TPL" "$TMP/t4" "$HIDDEN")" "常用分组里一项 main 都没有: 合并后复盘"

echo "通过 $pass，失败 $fail"
report_counts "$pass" "$fail"
[ "$fail" -eq 0 ]
