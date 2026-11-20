#!/usr/bin/env bash
# kind: unit
# 进行中条目清单里的「涉及的目录」（GitHub#598：scripts/concurrent_work_dirs.py）。
#
# 跑法：bash tests/concurrent-work-dirs.test.sh   （约 1 秒）
# 依赖：python3。
#
# 真实派工里的整行比对在 tests/concurrent-work.test.sh；这里用大量随机的原始字节目录名，直接跑真实脚本，
# 守住 PR #604 复审四轮各找到的一种「目录身份丢失」：
#   【1】一一对应：每个显示名都能用一个**独立写的**解码器还原成原始字节（截短的那种按完整的 sha256 核对；
#        8 位哈希在复审第 5 轮被实测撞上，那一对目录名也在这里）
#   【2】不看上下文：同一个目录单独列出、和别的目录一起列出，显示名完全一样
#   【3】不同目录显示名两两不同；计数等于不同上一级目录的个数；根目录下的文件记为「仓库根目录」
set -uo pipefail
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$(dirname "$TEST_DIR")/scripts/concurrent_work_dirs.py"

out=$(python3 - "$SCRIPT" <<'PY'
import hashlib, random, subprocess, sys

script = sys.argv[1]
ok = fail = 0
def check(name, cond, detail=""):
    global ok, fail
    if cond:
        ok += 1; print("  ✅ " + name)
    else:
        fail += 1; print("  ❌ " + name + (("\n     " + detail) if detail else ""))

def run(paths, show=64):
    r = subprocess.run([sys.executable, script, str(show)], input=b"\0".join(paths) + b"\0",
                       capture_output=True, check=True)
    count, _, shown = r.stdout.decode("utf-8").rstrip("\n").partition("\x1f")
    return int(count), (shown.split("、") if shown else [])

# 独立的解码器：只按文档写的转义规则，不调用被测代码
def decode(text):
    out = bytearray(); i = 0
    while i < len(text):
        c = text[i]
        if c == "\\":
            n = text[i + 1]
            if n == "\\":
                out += b"\\"; i += 2
            elif n == "x":
                out.append(int(text[i + 2:i + 4], 16)); i += 4
            elif n == "u" and text[i + 2] == "{":
                j = text.index("}", i)
                out += chr(int(text[i + 3:j], 16)).encode("utf-8"); i = j + 1
            else:
                raise ValueError("unknown escape at %d" % i)
        else:
            out += c.encode("utf-8"); i += 1
    return bytes(out)

rng = random.Random(598)
alphabet = [b"a", b"b", b"/", b"\\", b"x", b"8", b"5", b"`", b" ", b"\t", b"\n", b"\x85", b"\xc2\x85",
            b"\xfe", b"\xff", b"\xc3", b"\xa9", b"e\xcc\x81", "中".encode(), b"\xe2\x80\x8b", b"\x7f", b"u{"]
dirs = set()
while len(dirs) < 400:
    name = b"".join(rng.choice(alphabet) for _ in range(rng.randint(1, 12)))
    name = name.replace(b"\0", b"").strip(b"/")
    if not name or b"//" in name:
        continue
    dirs.add(name + b"/")
dirs.add(b"L" * 200 + b"/")
dirs = sorted(dirs)

alone = {}
bad_decode = bad_hash = 0
for d in dirs:
    n, shown = run([d + b"f"])
    alone[d] = shown[0]
    s = shown[0]
    if not (s.startswith("`") and s.endswith("`")):
        bad_decode += 1; continue
    body = s[1:-1]
    if "…#" in body:
        head, _, h = body.rpartition("…#")
        if h != hashlib.sha256(d).hexdigest() or len(head) != 80:
            bad_hash += 1
    elif decode(body) != d:
        bad_decode += 1
check("【1】%d 个随机目录名，每个显示名都能还原成原始字节" % len(dirs), bad_decode == 0, "还原失败 %d 个" % bad_decode)
check("【1】截短的显示名 = 前 80 字 + 原始字节完整的 sha256（64 位十六进制）", bad_hash == 0, "不符 %d 个" % bad_hash)
check("【1】确有截短的用例（200 字的目录名）", any("…#" in v for v in alone.values()))

n, shown = run([d + b"f" for d in dirs] + [b"top.txt"], show=len(dirs) + 1)
together = dict(zip(sorted(set(dirs) | {b""}), shown))
check("【3】计数 = 不同上一级目录的个数（含根目录）", n == len(dirs) + 1, "期望 %d 实得 %d" % (len(dirs) + 1, n))
check("【3】根目录下的文件记为「仓库根目录」", shown[:1] == ["仓库根目录"], repr(shown[:1]))
diff = [d for d in dirs if together.get(d) != alone[d]]
check("【2】每个目录和别的目录一起列出时，显示名和单独列出时一样", not diff, "不同：%r" % diff[:3])
check("【3】%d 个不同目录的显示名两两不同" % len(dirs), len(set(alone.values())) == len(dirs))

# 复审第 4 轮的两个实例
check("【2】只差大小写的 SRC/ 在同一条里，src/ 仍显示为 src/", run([b"src/f", b"SRC/f"])[1] == ["`SRC/`", "`src/`"])
check("【3】非 UTF-8 字节 85 和控制字符 U+0085 显示不同",
      run([b"a\x85/f"])[1] != run([b"a\xc2\x85/f"])[1], repr((run([b"a\x85/f"])[1], run([b"a\xc2\x85/f"])[1])))
# 复审第 5 轮实测的一对：截短后前 80 字相同、sha256 前 8 位也相同的两个真实目录名
pair = [b"x" * 80 + b"9838/", b"x" * 80 + b"12815/"]
check("【3】复审第 5 轮的一对目录：sha256 前 8 位确实相同（夹具分得出旧做法）",
      hashlib.sha256(pair[0]).hexdigest()[:8] == hashlib.sha256(pair[1]).hexdigest()[:8])
apart = [run([d + b"f"])[1][0] for d in pair]
check("【3】这一对分属两个条目时显示名不同", apart[0] != apart[1], repr(apart))
check("【3】这一对在同一条里时也列成两个不同的名字", len(set(run([d + b"f" for d in pair])[1])) == 2)
n, shown = run([b"d%d/f" % i for i in range(12)], show=8)
check("展示上限：12 个目录只列前 8 个，计数仍是 12", (n, len(shown)) == (12, 8), repr((n, len(shown))))
print("COUNTS %d %d" % (ok, fail))
PY
)
rc=$?
printf '%s\n' "$out" | grep -v '^COUNTS '
read -r _ pass fail < <(printf '%s\n' "$out" | grep '^COUNTS ' || echo "COUNTS 0 1")
[ "$rc" -eq 0 ] || { echo "  ❌ 测试脚本本身出错（退出码 $rc）"; fail=$((fail + 1)); }
echo "通过 $pass，失败 $fail"
report_counts "$pass" "$fail"
[ "$fail" -eq 0 ]
