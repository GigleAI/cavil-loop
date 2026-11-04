#!/usr/bin/env python3
"""机器人侧的参考实现（GitHub#133）：照 docs/requester-bot*.md「交接协议」独立写的一份，
不 import 叫醒脚本用的 scripts/requester_bot_handoff.py——两边对拍才有意义。

直接读假 GitHub 的 state.json（不经 gh，避免在观察钩子里递归），对一个条目给出机器人此刻的判定：

  python3 -I requester-bot-ref-consumer.py <state.json> <编号> [--minutes N] [--rule v4|v2|v3]

输出一行：
  not-waiting                    没挂等待标签（机器人不拉它）
  handed-back                    挂着 pending/human（机器人不碰）
  bot-origin                     正文带来源标记（走机器人自己的老规则，不归这里管）
  preparing                      还没有对应的叫醒记录，且离挂标签不到 30 分钟
  ready <评论编号> <对象>          转给这个对象
  error <原因>                   不转达，留言交维护者

--minutes = 假设机器人在挂标签之后过了多少分钟才扫到（默认 0）。
--rule 只给负对照用：bodymark = 只看当前条目正文里有没有来源标记来分流（代码复审第 2 轮指出的旧规则）；v3 = 找不到对应的叫醒记录就判出错（方案第 3 版的规则）；v2 = 不看编号，取挂标签
账号「时间早于挂标签」的最后一条评论（方案第 2 版的规则）。
"""
import hashlib
import json
import re
import sys

WAIT = "waiting/bot"
HUMAN = "pending/human"
ORIGIN_MARK = "<!-- bot-origin -->"
KEY = "requester-bot-forward-to"
GRACE_MIN = 30

args = sys.argv[1:]
path, num = args[0], args[1]
minutes, rule = 0, "v4"
if "--minutes" in args:
    minutes = int(args[args.index("--minutes") + 1])
if "--rule" in args:
    rule = args[args.index("--rule") + 1]

st = json.load(open(path, encoding="utf-8"))
it = st["items"][num]
labels = it.get("labels", [])
if WAIT not in labels:
    print("not-waiting"); sys.exit(0)
if HUMAN in labels:
    print("handed-back"); sys.exit(0)
BOT = "req-bot"
BRANCH_PREFIX = "feature/issue-"
LINK_KW = r"(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?|refs?)"
LINK = LINK_KW + r"[ \t\n\r\f\v]+#([0-9]+)"       # 整段：空白可以跨行
LINK_LINE = LINK_KW + r"[ \t\r\f\v]+#([0-9]+)"     # 逐行：同一行内


def is_bot_request(x):
    return (x.get("user") or "").lower() == BOT and ORIGIN_MARK in (x.get("body") or "")


def origin(x):
    """文档「是不是机器人提的需求」：bot / other / unknown（认不准，不转达）"""
    if not x.get("is_pr"):
        return "bot" if is_bot_request(x) else "other"
    m = re.match(re.escape(BRANCH_PREFIX) + r"([0-9]+)", x.get("head_ref") or "")
    if m:
        n = m.group(1)
    else:
        body = x.get("body") or ""
        # 逐行找第一处（关键词和 #编号在同一行），和整段找第一处（可以跨行）：两种结果一致才认
        by_line = next((mm.group(1) for ln in body.split("\n")
                        for mm in [re.search(LINK_LINE, ln, re.I)] if mm), "")
        mw = re.search(LINK, body, re.I)
        by_whole = mw.group(1) if mw else ""
        if by_line != by_whole:
            return "unknown"
        n = by_line
    if not n or n == str(x["number"]):
        return "other"
    linked = st["items"].get(n)
    if linked is None or linked.get("is_pr"):
        return "unknown"
    return "bot" if is_bot_request(linked) else "other"


o = "bot" if rule == "bodymark" and ORIGIN_MARK in (it.get("body") or "") else \
    ("other" if rule == "bodymark" else origin(it))
if o == "bot":
    print("bot-origin"); sys.exit(0)
if o == "unknown":
    print("error 认不准这条是不是机器人提的需求"); sys.exit(0)

evs = [(e["id"] if e.get("id") is not None else k + 1, e) for k, e in enumerate(it.get("events", []))]
lab = [(i, e) for i, e in evs if e["event"] == "labeled" and e.get("label") == WAIT]
if not lab:
    print("error 找不到挂等待标签的事件"); sys.exit(0)
E, ev = max(lab, key=lambda x: x[0])
A = (ev.get("actor") or "").lower()

comments = []
for k, c in enumerate(it.get("comments", [])):
    if isinstance(c, str):
        c = {"user": "someone", "body": c}
    comments.append((c.get("id", k + 1), (c.get("user") or "").lower(), c.get("body") or ""))

wake_re = re.compile(r"^\s*<!-- requester-bot-wake: event=([0-9]+) comment=([0-9]+) sha256=([0-9a-f]{64}) -->\s*$")
fwd_re = re.compile(r"^\s*<!-- requester-bot-forward-to: (.*?) -->\s*$")


def lines(body):
    return [ln.rstrip("\r") for ln in body.split("\n")]


def fp(body):
    # 规范化：CRLF → LF，去掉末尾空白；对结果按 UTF-8 算 SHA-256
    return hashlib.sha256(body.replace("\r\n", "\n").rstrip().encode("utf-8")).hexdigest()


def target_ok(t):
    t = t.strip()
    return bool(t) and len(t) <= 100 and not any(ch in t for ch in "<>;") and all(ord(ch) >= 32 and ord(ch) != 127 for ch in t)


if rule == "v2":
    # 第 2 版：挂标签账号「早于挂标签时间」的最后一条评论（不看编号）。时间都是同一秒 → 一条也选不到
    t_ev = ev.get("created_at", "2026-10-01T00:00:00Z")
    cands = [c for c in comments if c[1] == A and "2026-10-01T00:00:00Z" < t_ev]
    if not cands:
        print("error 选不到评论"); sys.exit(0)
    print(f"ready {max(cands)[0]} ?"); sys.exit(0)

receipts = []
for cid, who, body in comments:
    if who != A:
        continue
    wl = [ln for ln in lines(body) if "requester-bot-wake" in ln]
    if len(wl) != 1:
        continue
    m = wake_re.match(wl[0])
    if m and m.group(1) == str(E):
        receipts.append(m)
if not receipts:
    if rule == "v3" or minutes >= GRACE_MIN:
        print("error 挂标签之后没有对应的叫醒记录"); sys.exit(0)
    print("preparing"); sys.exit(0)
if len(receipts) > 1:
    print("error 对应的叫醒记录不止一条"); sys.exit(0)
m = receipts[0]
cid, want_fp = int(m.group(2)), m.group(3)
c = next((x for x in comments if x[0] == cid), None)
if c is None or c[1] != A:
    print("error 叫醒记录指向的交接评论不在了，或不是同一个账号发的"); sys.exit(0)
if fp(c[2]) != want_fp:
    print("error 正文指纹对不上（评论被改过）"); sys.exit(0)
fl = [ln for ln in lines(c[2]) if "requester-bot-forward-to" in ln]
fm = fwd_re.match(fl[0]) if len(fl) == 1 else None
if not fm or not target_ok(fm.group(1)):
    print("error 交接评论的转交标记不合格"); sys.exit(0)
print(f"ready {cid} {fm.group(1).strip()}")
