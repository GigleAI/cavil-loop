#!/usr/bin/env python3
"""机器人侧的参考实现（GitHub#133）：照 docs/requester-bot*.md「交接协议」独立写的一份，
不 import 叫醒脚本用的 scripts/requester_bot_handoff.py——两边对拍才有意义。

直接读假 GitHub 的 state.json（不经 gh，避免在观察钩子里递归），对一个条目给出机器人此刻的判定：

  python3 -I requester-bot-ref-consumer.py <state.json> <编号> [--minutes N] [--rule v4|v2|v3]

输出一行：
  not-waiting                    没挂等待标签（机器人不拉它）
  handed-back                    挂着 pending/human（机器人不碰）
  bot-origin                     正文带来源标记（走机器人自己的老规则，不归这里管）
  preparing                      还没有对应的交接评论，且离挂标签不到 30 分钟
  ready <评论编号> <对象>          转给这个对象
  error <原因>                   不转达，留言交维护者

--minutes = 假设机器人在挂标签之后过了多少分钟才扫到（默认 0）。
--rule 只给负对照用：v3 = 找不到对应评论就判出错（第 3 版的规则）；v2 = 不看编号，取挂标签账号
「时间早于挂标签」的最后一条评论（第 2 版的规则）。
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
if ORIGIN_MARK in (it.get("body") or ""):
    print("bot-origin"); sys.exit(0)

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

line_re = re.compile(r"^\s*<!-- requester-bot-forward-to: (.+?) ; wake-event: ([0-9]+) ; sha256: ([0-9a-f]{64}) -->\s*$")


def marker_lines(body):
    return [ln.rstrip("\r") for ln in body.split("\n") if KEY in ln]


def restored(body, target):
    # 1. CRLF → LF  2. 标记行还原成未填编号的标准形式  3. 去掉末尾空白
    out = []
    for ln in body.replace("\r\n", "\n").split("\n"):
        out.append(f"<!-- {KEY}: {target} -->" if KEY in ln else ln)
    return "\n".join(out).rstrip()


def target_ok(t):
    t = t.strip()
    return bool(t) and len(t) <= 100 and not any(ch in t for ch in "<>;") and all(ord(ch) >= 32 and ord(ch) != 127 for ch in t)


if rule == "v2":
    # 第 2 版：挂标签账号「早于挂标签时间」的最后一条评论（不看编号）。时间都是同一秒 → 一条也选不到
    t_ev = ev.get("created_at", "2026-10-01T00:00:00Z")
    cands = [c for c in comments if c[1] == A and "2026-10-01T00:00:00Z" < t_ev]
    if not cands:
        print("error 选不到评论"); sys.exit(0)
    cid, _, body = max(cands)
    m = [ln for ln in marker_lines(body)]
    print(f"ready {cid} ?" if m else "error 没有标记"); sys.exit(0)

hits = []
for cid, who, body in comments:
    if who != A:
        continue
    ml = marker_lines(body)
    if len(ml) != 1:
        continue
    m = line_re.match(ml[0])
    if m and m.group(2) == str(E):
        hits.append((cid, body, m))
if not hits:
    if rule == "v3" or minutes >= GRACE_MIN:
        print("error 挂标签之后没有对应的交接评论"); sys.exit(0)
    print("preparing"); sys.exit(0)
if len(hits) > 1:
    print("error 对应的交接评论不止一条"); sys.exit(0)
cid, body, m = hits[0]
target = m.group(1).strip()
if not target_ok(target):
    print("error 转交对象不合格"); sys.exit(0)
if hashlib.sha256(restored(body, target).encode("utf-8")).hexdigest() != m.group(3):
    print("error 正文指纹对不上（评论被改过）"); sys.exit(0)
print(f"ready {cid} {target}")
