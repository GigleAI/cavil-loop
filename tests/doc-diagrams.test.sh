#!/usr/bin/env bash
# 文档里那两张会动的讲解图（GitHub#76）。
#
# 跑法：bash tests/doc-diagrams.test.sh
# 依赖：python3（标准库）。不需要浏览器。
#
# 管四件事：
#   1. docs/images/ 里的 SVG 就是生成脚本的产物——有人直接手改 SVG，中英 / 动静四份就会说法不一
#   2. 每张动图在所有关键帧把一圈切成小段、逐段判定（不靠定时采样）：任意时刻最多一段说明、说明只在红框停在它那一步时出现、
#      不含脚本 / 元素 id / 外链 / 主机名、所有动画同一周期从 0 秒开始（check.py）
#   3. 静态版和动图的说明逐字一致
#   4. 四份文档各自引用了对应语言的动图和静态版，且文件存在
# 再对 check.py 的每条承诺各造一个坏图做负对照：检查放过了哪一种坏图，这里就红。
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
GEN="$REPO_DIR/scripts/doc-diagrams/gen.py"
CHECK="$REPO_DIR/scripts/doc-diagrams/check.py"
IMG="$REPO_DIR/docs/images"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

PASS=0 FAIL=0
ok()   { PASS=$((PASS + 1)); echo "  ✓ $1"; }
bad()  { FAIL=$((FAIL + 1)); echo "  ✗ $1"; }

echo "== 1. 提交的 SVG = 生成脚本的产物"
python3 "$GEN" "$TMP/gen" || bad "生成脚本跑失败"
if diff -r "$TMP/gen" "$IMG" >"$TMP/drift" 2>&1; then
    ok "docs/images 与重新生成的结果逐字节一致"
else
    bad "docs/images 与生成结果不一致（改 gen.py 后没重新生成，或直接手改了 SVG）："
    head -20 "$TMP/drift"
fi
n=$(find "$TMP/gen" -name '*.svg' | wc -l)
[ "$n" -eq 8 ] && ok "生成 8 张图（2 张 × 中英 × 动/静）" || bad "生成了 $n 张图，应为 8"

echo "== 2/3. 动图行为 + 静态版一致"
if python3 "$CHECK" "$IMG" >"$TMP/check.out"; then
    ok "$(tail -1 "$TMP/check.out")"
else
    bad "检查不通过："; cat "$TMP/check.out"
fi

echo "== 4. 文档引用"
refs() {   # <doc> <image path as written in the doc> <file on disk>
    local doc="$REPO_DIR/$1"
    if grep -qF "($2)" "$doc" && [ -f "$3" ]; then ok "$1 → $2"; else bad "$1 没有引用 $2（或文件不存在）"; fi
}
for lang in en zh; do
    readme=README.md; arch=docs/architecture.md
    [ "$lang" = zh ] && readme=README.zh.md && arch=docs/architecture.zh.md
    for v in "" .static; do
        refs "$readme" "docs/images/issue-lifecycle.$lang$v.svg" "$IMG/issue-lifecycle.$lang$v.svg"
        refs "$arch" "images/prompt-assembly.$lang$v.svg" "$IMG/prompt-assembly.$lang$v.svg"
    done
done

echo "== 负对照：每种坏图都必须被检查拦下"
# <name> <python that mutates the text s>, applied to a copy of the zh lifecycle pair
# (27 s cycle: 9 steps × 3 s; the red box slides 0.5 s, captions fade 0.25 s).
# Helpers: anims(s, attr) lists the <animate> tags for attr in document order;
# retime(s, m, kts_secs, vals) rewrites one of them (keyTimes given in seconds).
neg() {
    local name="$1" code="$2" d="$TMP/neg-$RANDOM"
    mkdir -p "$d"
    cp "$IMG/issue-lifecycle.zh.svg" "$IMG/issue-lifecycle.zh.static.svg" "$d/"
    python3 - "$d" "$code" <<'PY' || { bad "$name：造坏图失败"; return; }
import sys, re, os
d, code = sys.argv[1], sys.argv[2]
CYCLE = 27.0
TAG = re.compile(r'<animate attributeName="(\w+)" values="([^"]*)" keyTimes="([^"]*)" keySplines="([^"]*)"')

def anims(s, attr):
    return [m for m in TAG.finditer(s) if m.group(1) == attr]

def secs(m):
    return [float(k) * CYCLE for k in m.group(3).split(';')]

def vals(m):
    return m.group(2).split(';')

def retime(s, m, kts, vs):
    tag = ('<animate attributeName="%s" values="%s" keyTimes="%s" keySplines="%s"'
           % (m.group(1), ';'.join(str(v) for v in vs), ';'.join('%.6f' % (k / CYCLE) for k in kts),
              ';'.join(['0.42 0 0.58 1'] * (len(kts) - 1))))
    return s[:m.start()] + tag + s[m.end():]

changed = False
for name in ('issue-lifecycle.zh.svg', 'issue-lifecycle.zh.static.svg'):
    p = os.path.join(d, name)
    s = open(p, encoding='utf-8').read()
    env = {'s': s, 're': re, 'static': name.endswith('.static.svg'),
           'anims': anims, 'secs': secs, 'vals': vals, 'retime': retime}
    exec(code, env)
    changed |= env['s'] != s
    open(p, 'w', encoding='utf-8').write(env['s'])
if not changed:   # a no-op mutation would "pass" this control for the wrong reason
    sys.exit('mutation changed nothing')
PY
    if python3 "$CHECK" "$d" >"$d.out" 2>&1; then
        bad "$name：检查没拦住"
    else
        ok "$name：被拦下（$(grep -m1 FAIL "$d.out" | cut -c1-100)）"
    fi
}
# 第 2 段说明到 6.6 秒才收完，红框 6.0 秒已停到第 3 步、第 3 段已淡入
neg "两段说明叠字" '
if not static:
    m = anims(s, "opacity")[1]
    k = secs(m); k[4] = 6.6
    s = retime(s, m, k, vals(m))'
# 第 3 段在 5.8 秒就开始淡入，红框还在从第 2 步滑过去的路上
neg "说明在红框到达前出现" '
if not static:
    m = anims(s, "opacity")[2]
    k = secs(m); k[1], k[2] = 5.8, 6.05
    s = retime(s, m, k, vals(m))'
# 第 2、3 步的停靠位置对调：红框先停第 3 步再停第 2 步
neg "红框走错顺序" '
if not static:
    m = anims(s, "x")[0]
    v = vals(m); v[2], v[3], v[4], v[5] = v[4], v[5], v[2], v[3]
    s = retime(s, m, secs(m), v)'
neg "某段说明从不出现" '
if not static:
    m = anims(s, "opacity")[1]
    s = retime(s, m, secs(m), ["0"] * len(vals(m)))'
neg "周期不一致" '
if not static:
    s = s.replace("dur=\"27s\"", "dur=\"26s\"", 1)'
neg "从非 0 秒开始" '
if not static:
    s = s.replace("begin=\"0s\"", "begin=\"1s\"", 1)'
# 缓动曲线的控制点超出 0..1 会回弹：透明度或位置冲出两端的值
neg "回弹的缓动曲线" '
if not static:
    s = s.replace("keySplines=\"0.42 0 0.58 1", "keySplines=\"0.42 -0.5 0.58 1.5", 1)'
neg "不按关键帧计时（paced）" '
if not static:
    s = s.replace("calcMode=\"spline\"", "calcMode=\"paced\"", 1)'
neg "带元素 id" '
if not static:
    s = s.replace("<g class=\"card s1\"", "<g id=\"c1\" class=\"card s1\"", 1)'
neg "带脚本" '
if not static:
    s = s.replace("</svg>", "<script>1</script></svg>")'
neg "外链资源" '
if not static:
    s = s.replace("</svg>", "<rect fill=\"url(x)\"/></svg>")'
neg "出现主机名" '
if not static:
    s = s.replace("守护进程不会碰它", "build01.example.internal 不会碰它")'
# 比旧版采样间隔（0.05 秒）还短的错误：PR #77 第 2 轮复审实测采样版会全部放过
# 第 2 段说明在 1.01–1.02 秒额外闪现，此时第 1 段还在、红框还在第 1 步；原本的显示保留
neg "0.01 秒的短暂叠字" '
if not static:
    m = anims(s, "opacity")[1]
    k, v = secs(m), vals(m)
    s = retime(s, m, [0, 1.0, 1.01, 1.02] + k[1:], ["0", "0", "1", "0"] + v[1:])'
# 红框在 1.01–1.02 秒短暂跳到第 2 张卡片，第 1 段说明仍在显示
neg "0.01 秒的红框错位" '
if not static:
    m = anims(s, "x")[0]
    k, v = secs(m), vals(m)
    s = retime(s, m, [0, 1.0, 1.01, 1.02] + k[1:], [v[0], v[0], v[2], v[0]] + v[1:])'
neg "静态版说明和动图对不上" '
if static:
    s = s.replace("守护进程不会碰它", "守护进程不会管它")'
neg "静态版带动画" '
if static:
    s = s.replace("<g class=\"cap\"", "<g class=\"cap\"><animate attributeName=\"opacity\" dur=\"1s\" values=\"0\"/></g><g class=\"x\"", 1)'

echo
echo "通过 $PASS，失败 $FAIL"
[ "$FAIL" -eq 0 ]
