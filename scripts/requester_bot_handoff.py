#!/usr/bin/env python3
"""非机器人条目的交接：转交标记核对、正文指纹、叫醒记录（GitHub#133）。

叫醒脚本（notify-requester-bot.sh）调用；规则与 docs/requester-bot*.md「交接协议」一节逐条对应，
机器人那边按同一份文档独立实现。tests/ 里的参考消费者也是照文档另写的一份，两边对拍。

worker 写在交接评论 C 正文里（用量记录之前）的一行：
    <!-- requester-bot-forward-to: <对象> -->
叫醒脚本**不编辑 C**（GitHub 的评论编辑接口没有「内容没变才写」的条件写入，整段写回会覆盖别人
同时做的修改）。它挂上等待标签后，另发一条叫醒记录评论，里面一行：
    <!-- requester-bot-wake: event=<挂标签事件编号> comment=<C 的编号> sha256=<C 的正文指纹> -->

正文指纹 = 对「规范化正文」算 SHA-256（UTF-8）；规范化 = \\r\\n 换成 \\n，再去掉整段末尾的空白。
C 的任何一个字被改过，指纹就对不上。

用法（正文都从文件读，输出到 stdout）：
    check       <正文文件>                    → 恰好一行合格的转交标记：输出对象，退出 0
    normalize   <正文文件>                    → 输出规范化正文
    fingerprint <正文文件>                    → 输出指纹
    receipt     <事件编号> <评论编号> <指纹> <对象> → 输出叫醒记录评论的正文
    verify      <正文文件> <事件编号> <评论编号> <指纹> → 正文里恰好一行叫醒记录且三项都对上：退出 0
退出码：0 成功；3 没有转交标记；4 标记不止一行；5 标记不合格（对象为空 / 太长 / 含非法字符 / 格式不对）；
        7 叫醒记录对不上（verify 专用）；2 用法错误
"""
import hashlib
import re
import sys

KEY = "requester-bot-forward-to"
WAKE = "requester-bot-wake"
MAX_TARGET = 100
PLAIN = re.compile(r"^\s*<!-- " + KEY + r": (?P<t>[^\n]*?) -->\s*$")
WAKE_LINE = re.compile(r"^\s*<!-- " + WAKE + r": event=([0-9]+) comment=([0-9]+) sha256=([0-9a-f]{64}) -->\s*$")


def out(text):
    # 按字节写：不受运行环境的语言设置影响（C locale 下 sys.stdout 可能不是 UTF-8）
    sys.stdout.buffer.write(text.encode("utf-8"))
    sys.stdout.flush()


def die(code, msg):
    out(msg + "\n")
    sys.exit(code)


def lines_of(body):
    # 只按 \n 分行（splitlines 还会在 \x0b、  等处断行，和文档、机器人那边的分法不一致）
    return [ln.rstrip("\r") for ln in body.split("\n")]


def valid_target(t):
    t = t.strip()
    if not t or len(t) > MAX_TARGET:
        return None
    if any(c in t for c in "<>;") or any(ord(c) < 32 or ord(c) == 127 for c in t):
        return None
    return t


def target_of(body):
    hits = [ln for ln in lines_of(body) if KEY in ln]
    if not hits:
        die(3, "没有转交标记")
    if len(hits) > 1:
        die(4, f"转交标记有 {len(hits)} 行，只能有一行")
    m = PLAIN.match(hits[0])
    if not m:
        die(5, "转交标记格式不对")
    t = valid_target(m.group("t"))
    if t is None:
        die(5, "转交对象不合格（为空、超过 100 个字符，或含 < > ; 或控制字符）")
    return t


def normalized(body):
    return body.replace("\r\n", "\n").rstrip()


def fingerprint(body):
    return hashlib.sha256(normalized(body).encode("utf-8")).hexdigest()


def read(path):
    with open(path, encoding="utf-8", newline="") as f:
        return f.read()


def main(argv):
    if not argv:
        die(2, "用法见文件开头")
    cmd = argv[0]
    if cmd == "check" and len(argv) == 2:
        out(target_of(read(argv[1])) + "\n")
        return 0
    if cmd == "normalize" and len(argv) == 2:
        out(normalized(read(argv[1])))
        return 0
    if cmd == "fingerprint" and len(argv) == 2:
        out(fingerprint(read(argv[1])) + "\n")
        return 0
    if cmd == "receipt" and len(argv) == 5:
        ev, cid, fp, t = argv[1:5]
        if not (ev.isdigit() and cid.isdigit() and re.fullmatch(r"[0-9a-f]{64}", fp)) or valid_target(t) is None:
            die(2, "叫醒记录参数不合格")
        out(f"已叫醒外部需求机器人：请把[这条交接评论](#issuecomment-{cid})转给「{t.strip()}」。\n\n"
            f"<!-- {WAKE}: event={ev} comment={cid} sha256={fp} -->\n")
        return 0
    if cmd == "verify" and len(argv) == 5:
        body, ev, cid, fp = read(argv[1]), argv[2], argv[3], argv[4]
        hits = [ln for ln in lines_of(body) if WAKE in ln]
        m = WAKE_LINE.match(hits[0]) if len(hits) == 1 else None
        if not m or m.groups() != (ev, cid, fp):
            die(7, f"叫醒记录对不上（期望 event={ev} comment={cid}）")
        return 0
    die(2, f"用法不对：{' '.join(argv)}")


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
