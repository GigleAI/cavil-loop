#!/usr/bin/env python3
"""非机器人条目的交接评论：转交标记的核对、还原、填编号（GitHub#133）。

叫醒脚本（notify-requester-bot.sh）调用；规则与 docs/requester-bot*.md「交接协议」一节逐条对应，
机器人那边按同一份文档独立实现。tests/ 里的参考消费者也是照文档另写的一份，两边对拍。

worker 写在交接评论正文里（用量记录之前）的一行：
    <!-- requester-bot-forward-to: <对象> -->
脚本挂上等待标签后，只把这一行换成：
    <!-- requester-bot-forward-to: <对象> ; wake-event: <事件编号> ; sha256: <64 位十六进制> -->

正文指纹 = 对「还原后正文」算 SHA-256（UTF-8）。还原：
    1. \\r\\n 换成 \\n
    2. 那一行换成未填编号的标准形式 `<!-- requester-bot-forward-to: <对象> -->`（对象去掉首尾空白）
    3. 去掉整段末尾的空白
其余每个字节都参与计算（含用量记录），所以除这一行外改了任何一个字，指纹都对不上；
重复填写（重试改填新编号）不改变还原后正文。

用法（正文都从文件读，输出到 stdout）：
    check     <正文文件>          → 未填编号且合格：输出对象，退出 0
    normalize <正文文件>          → 输出还原后正文（标记必须恰好一行、合格，填没填编号都行）
    stamp     <正文文件> <事件编号> → 输出填好编号的完整正文（只换那一行，其余字节原样）
    verify    <正文文件> <事件编号> → 已填的是这个编号、指纹对得上：退出 0
退出码：0 成功；3 没有标记；4 标记不止一行；5 标记不合格（对象为空 / 太长 / 含非法字符 / 格式不对）；
        6 已经填过编号（check 专用）；7 编号或指纹对不上（verify 专用）；2 用法错误
"""
import hashlib
import re
import sys

KEY = "requester-bot-forward-to"
MAX_TARGET = 100
PLAIN = re.compile(r"^\s*<!-- " + KEY + r": (?P<t>[^\n]*?) -->\s*$")
STAMPED = re.compile(r"^\s*<!-- " + KEY + r": (?P<t>[^\n;]*?) ; wake-event: (?P<e>[0-9]+) ; sha256: (?P<h>[0-9a-f]{64}) -->\s*$")


def out(text):
    # 按字节写：不受运行环境的语言设置影响（C locale 下 sys.stdout 可能不是 UTF-8）
    sys.stdout.buffer.write(text.encode("utf-8"))
    sys.stdout.flush()


def die(code, msg):
    out(msg + "\n")
    sys.exit(code)


def valid_target(t):
    t = t.strip()
    if not t or len(t) > MAX_TARGET:
        return None
    if any(c in t for c in "<>;") or any(ord(c) < 32 or ord(c) == 127 for c in t):
        return None
    return t


def parse(body):
    """→ (行列表（保留各自的行尾）, 标记所在行号, 对象, 已填的事件编号或 None, 已填的指纹或 None)"""
    # 只按 \n 分行（splitlines 还会在 \x0b、\u2028 等处断行，和文档、机器人那边的分法不一致）
    lines = re.findall(r"[^\n]*\n|[^\n]+\Z", body)
    hits = [i for i, ln in enumerate(lines) if KEY in ln]
    if not hits:
        die(3, "没有转交标记")
    if len(hits) > 1:
        die(4, f"转交标记有 {len(hits)} 行，只能有一行")
    i = hits[0]
    raw = lines[i].rstrip("\r\n")
    m = STAMPED.match(raw)
    if m:
        t = valid_target(m.group("t"))
        if t is None:
            die(5, "转交对象不合格")
        return lines, i, t, m.group("e"), m.group("h")
    m = PLAIN.match(raw)
    if not m:
        die(5, "转交标记格式不对")
    t = valid_target(m.group("t"))
    if t is None:
        die(5, "转交对象不合格（为空、超过 100 个字符，或含 < > ; 或控制字符）")
    return lines, i, t, None, None


def plain_line(t):
    return f"<!-- {KEY}: {t} -->"


def normalized(body):
    lines, i, t, _, _ = parse(body)
    out = list(lines)
    end = lines[i][len(lines[i].rstrip("\r\n")):]
    out[i] = plain_line(t) + end
    return "".join(out).replace("\r\n", "\n").rstrip()


def fingerprint(body):
    return hashlib.sha256(normalized(body).encode("utf-8")).hexdigest()


def main(argv):
    if len(argv) < 2:
        die(2, "用法见文件开头")
    cmd, path = argv[0], argv[1]
    with open(path, encoding="utf-8", newline="") as f:
        body = f.read()
    if cmd == "check":
        _, _, t, e, _ = parse(body)
        if e is not None:
            die(6, "这条评论已经用于过一次叫醒（标记里已填编号）")
        out(t + "\n")
        return 0
    if cmd == "normalize":
        out(normalized(body))
        return 0
    if cmd in ("stamp", "verify"):
        if len(argv) < 3 or not argv[2].isdigit():
            die(2, "缺事件编号")
        ev = argv[2]
        lines, i, t, e, h = parse(body)
        if cmd == "verify":
            if e != ev or h != fingerprint(body):
                die(7, f"标记里的编号 / 指纹对不上（编号 {e or '未填'}，期望 {ev}）")
            return 0
        end = lines[i][len(lines[i].rstrip("\r\n")):]
        lines[i] = f"<!-- {KEY}: {t} ; wake-event: {ev} ; sha256: {fingerprint(body)} -->" + end
        out("".join(lines))
        return 0
    die(2, f"不认识的子命令 {cmd}")


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
