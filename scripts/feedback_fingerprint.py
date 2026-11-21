#!/usr/bin/env python3
"""Answer records for question-only rounds (GitHub#614).

When a human only asks a question, the worker answers and pauses. When the item is handed back
without a new comment, the worker may continue the step it was on — but only when nothing changed
since the answer. This file holds the one definition of "what the answer saw" and "has it changed":

  snapshot   read the item (JSON on stdin, built by feedback-fingerprint.sh) → the answer record line
             the worker pastes verbatim, plus what it should judge from (the same read)
  compare    the same read again + the record from the answer → resume / new-feedback / need-continue

The record has exactly one format, made here:
  <!-- agent-answer-only v=2 seen=<items> body=<fp> resume=<f<id>:<fp>|none> flow=<fp> -->
  seen   one entry per piece of human feedback (maintainers and the requester bot: conversation,
         inline, review) and per question's ticked state in the loop account's comments
  body   the item's description
  resume the loop-account comment the paused step came from (or none: there was none at all)
  flow   every loop-account comment except answer / wait records — a deleted, edited or new review
         verdict or daemon notice changes it
Outside accounts are never read into any of it (the caller drops them before this file sees them).
Anything that is not a complete v=2 record is "cannot confirm": the worker asks for 「继续」.

Input JSON: {"body": str, "items": [{"src": "conversation|inline|review", "id": int,
             "role": "maintainer|bot|loop", "body": str, "state": str?}]}  (oldest first)
"""
import hashlib
import json
import re
import sys

ANSWER_MARK = "<!-- agent-answer-only"
WAIT_MARK = "<!-- agent-answer-only need=continue -->"
SRC_KEY = {"conversation": "c", "inline": "i", "review": "r"}
# a question heading: **Q<number> followed by a half-/full-width colon, a full stop, 、 or a space
QUESTION = re.compile(r"^\s*\*\*Q\d+(?:[:：.、 ]|\*\*)")
TICK = re.compile(r"^\s*[-*+]\s+\[([ xX])\]")
FENCE = re.compile(r"^\s*(```|~~~)")
HEADING = re.compile(r"^\s{0,3}#{1,6}\s")
LIST = re.compile(r"^\s*([-*+]|\d+[.)])\s")
MARK_RE = re.compile(
    r"^<!-- agent-answer-only v=2 seen=(?P<seen>\S+) body=(?P<body>[0-9a-f]{12}) "
    r"resume=(?P<resume>none|f\d+:[0-9a-f]{12}) flow=(?P<flow>[0-9a-f]{12}) -->$")


def fp(*parts):
    h = hashlib.sha256()
    for p in parts:
        h.update(str(p).encode("utf-8"))
        h.update(b"\x00")
    return h.hexdigest()[:12]


def tick_lines(body):
    """The ticked state of every question's options in one comment: only option lines under a
    **Q<n> heading, outside quotes and code fences. A question's options end at the next heading,
    the next question, or the first ordinary paragraph / quote line after an option (「不勾会怎样」),
    so a plain task list further down does not count. Returns a list."""
    out, in_q, seen_opt, fence = [], False, False, False
    for raw in body.replace("\r\n", "\n").split("\n"):
        if FENCE.match(raw):
            fence = not fence
            in_q = False
            continue
        if fence:
            continue
        if HEADING.match(raw):
            in_q = False
            continue
        if QUESTION.match(raw):
            in_q, seen_opt = True, False
            continue
        if not in_q or not raw.strip():
            continue
        if TICK.match(raw):
            out.append(raw.strip())
            seen_opt = True
        elif raw.lstrip().startswith(">") or (seen_opt and not raw[:1].isspace() and not LIST.match(raw)):
            in_q = False
    return out


def untick(body):
    """A loop comment with every box cleared: ticking is human feedback, not a flow change."""
    return re.sub(r"\[[xX]\]", "[ ]", body)


def is_answer(body):
    return ANSWER_MARK in body


def title_of(body):
    for line in body.replace("\r\n", "\n").split("\n"):
        s = line.strip()
        if s.startswith("#"):
            return s
    return "(无标题)"


def build(data):
    seen, content, flow = [], [], []
    for it in data.get("items", []):
        src, iid, role, body = it["src"], int(it["id"]), it["role"], it.get("body") or ""
        if role in ("maintainer", "bot"):
            key = "%s%d" % (SRC_KEY[src], iid)
            seen.append((key, fp(src, iid, it.get("state") or "", body)))
            content.append((key, it))
        elif role == "loop" and src == "conversation":
            if is_answer(body):
                continue
            ticks = tick_lines(body)
            if ticks:
                key = "t%d" % iid
                seen.append((key, fp("ticks", iid, "\n".join(ticks))))
                content.append((key, {"src": "ticks", "id": iid, "role": "loop", "body": "\n".join(ticks)}))
            flow.append(("f%d" % iid, fp("flow", iid, untick(body)), title_of(body)))
    flow_fp = fp("flow-set", ",".join("%s:%s" % (k, f) for k, f, _ in flow))
    body_fp = fp("body", data.get("body") or "")
    return seen, content, flow, flow_fp, body_fp


def record_line(seen, flow, flow_fp, body_fp):
    s = ",".join("%s:%s" % kv for kv in seen) or "-"
    resume = ("%s:%s" % (flow[-1][0], flow[-1][1])) if flow else "none"
    return "<!-- agent-answer-only v=2 seen=%s body=%s resume=%s flow=%s -->" % (s, body_fp, resume, flow_fp)


def show(key, it):
    who = {"maintainer": "维护者", "bot": "外部需求机器人", "loop": "loop 账号"}.get(it["role"], it["role"])
    src = {"conversation": "对话", "inline": "行内评论", "review": "review", "ticks": "选择题勾选"}[it["src"]]
    head = "### %s ｜ %s ｜ %s ｜ 编号 %s" % (key, src, who, it["id"])
    if it.get("state"):
        head += " ｜ %s" % it["state"]
    return head + "\n" + (it.get("body") or "") + "\n"


def cmd_snapshot(data):
    seen, content, flow, flow_fp, body_fp = build(data)
    out = ["record " + record_line(seen, flow, flow_fp, body_fp), ""]
    out.append("## 正文")
    out.append(data.get("body") or "")
    out.append("")
    out.append("## 人的反馈（维护者 / 外部需求机器人；外部账号的内容不在这里）")
    out += [show(k, it) for k, it in content] or ["（没有）"]
    out.append("## 流程记录（loop 账号的评论，答复记录除外；只列标题）")
    out += ["%s %s" % (k, t) for k, _, t in flow] or ["（没有）"]
    sys.stdout.write("\n".join(out) + "\n")
    return 0


def parse_seen(s):
    if s == "-":
        return {}
    d = {}
    for part in s.split(","):
        k, _, f = part.partition(":")
        if not re.fullmatch(r"[cirt]\d+", k) or not re.fullmatch(r"[0-9a-f]{12}", f) or k in d:
            raise ValueError(part)
        d[k] = f
    return d


def cmd_compare(data, mark):
    seen, content, flow, flow_fp, body_fp = build(data)
    m = MARK_RE.match(mark.strip())
    old = None
    if m:
        try:
            old = parse_seen(m.group("seen"))
        except ValueError:
            old = None
    lines = []

    def verdict(v, reason):
        lines.insert(0, "reason " + reason)
        lines.insert(0, "verdict " + v)

    if m is None or old is None:
        verdict("need-continue", "old-or-broken-record")
        sys.stdout.write("\n".join(lines) + "\n")
        return 0
    now = dict(seen)
    added = [k for k in now if k not in old]
    edited = [k for k in now if k in old and now[k] != old[k]]
    deleted = [k for k in old if k not in now]
    resume = m.group("resume")
    flow_now = {k: f for k, f, _ in flow}
    titles = {k: t for k, _, t in flow}
    if resume == "none":
        resume_ok = not flow
    else:
        rk, _, rf = resume.partition(":")
        resume_ok = flow_now.get(rk) == rf
    lines += ["resume " + resume, "added " + (",".join(added) or "-"),
              "edited " + (",".join(edited) or "-"), "deleted " + (",".join(deleted) or "-")]
    if body_fp != m.group("body"):
        verdict("need-continue", "body-changed")
    elif deleted:
        verdict("need-continue", "feedback-deleted")
    elif not resume_ok:
        verdict("need-continue", "resume-record-gone-or-changed")
    elif flow_fp != m.group("flow"):
        verdict("need-continue", "flow-changed")
    elif added or edited:
        verdict("new-feedback", "changed")
        lines.append("")
        lines.append("## 变化的条目（这一次读到的内容）")
        want = set(added) | set(edited)
        lines += [show(k, it) for k, it in content if k in want]
    else:
        verdict("resume", "same")
        lines.append("")
        lines.append("## 要接着做的那一步")
        lines.append("%s %s" % (resume, titles.get(resume.partition(":")[0], "（没有流程记录：照原规则从正文开始）")))
    sys.stdout.write("\n".join(lines) + "\n")
    return 0


def main(argv):
    if len(argv) < 2 or argv[1] not in ("snapshot", "compare") or (argv[1] == "compare" and len(argv) != 3):
        sys.stderr.write("usage: feedback_fingerprint.py snapshot | compare <record file>\n")
        return 2
    try:
        data = json.load(sys.stdin)
        if not isinstance(data, dict) or not isinstance(data.get("items"), list):
            raise ValueError("shape")
    except (ValueError, KeyError):
        sys.stdout.write("unreadable bad-input\n")
        return 3
    if argv[1] == "snapshot":
        return cmd_snapshot(data)
    try:
        with open(argv[2], encoding="utf-8") as f:
            mark = f.read()
    except OSError:
        sys.stdout.write("unreadable record-file\n")
        return 3
    # the record is one line; only a line that is exactly a v=2 record counts
    marks = [ln for ln in mark.splitlines() if ln.startswith(ANSWER_MARK)]
    return cmd_compare(data, marks[-1] if marks else "")


if __name__ == "__main__":
    sys.exit(main(sys.argv))
