#!/usr/bin/env python3
"""Answer records for question-only rounds (GitHub#614).

When a human only asks a question, the worker answers and pauses. When the item is handed back
without a new comment, the worker may continue the step it was on — but only when nothing changed
since the answer. This file holds the one definition of "what the answer saw" and "has it changed":

  snapshot   read the item (JSON on stdin, built by feedback-fingerprint.sh) → first line: the answer
             record line itself, which the worker saves and pastes verbatim; after it, what the worker
             judges from, from the same read (times, order, roles, the bound step in full, the latest answer)
  compare    the same read again + the record from the answer → resume / new-feedback / need-continue

The record has exactly one format, made here:
  <!-- agent-answer-only v=2 seen=<items> item=<fp> resume=<f<id>:<fp>|none> flow=<fp> -->
  seen   one entry per piece of human feedback (maintainers and the requester bot: conversation,
         inline, review) and per question's ticked state in the loop account's comments
  item   the item itself: description, open / closed, its labels other than the flow labels, for a
         PR its head commit and base branch, for an issue its open PRs (they decide where an answer
         leaves the issue)
  resume the loop-account comment the paused step came from (or none: there was none at all)
  flow   every loop-account comment except answer / wait records — a deleted, edited or new review
         verdict or daemon notice changes it
Outside accounts are never read into any of it (the caller drops them before this file sees them).
Anything that is not a complete v=2 record is "cannot confirm": the worker asks for 「继续」.
Which lines are records is decided in one place, record_lines(): a whole line outside code fences —
the same parser finds the record in a saved file and tells answer comments from ordinary ones, so a
proposal that explains the format in inline code is still an ordinary comment.

Every question's ticks (one entry per question, t<comment>q<n>) also carry when they last changed and who changed them, from the loop
comment's edit history (tick_change()); that is shown to the worker, never fingerprinted, and a
history that cannot pin it down says so — the worker then treats the ticks as changed this round.
Whether this dispatch still holds the item (`holding yes|no`) and the write gate (`write ok <label>`
or `write stop <reason>`, write_line()) are printed on their own, never part of the resume
fingerprint: every write of the round (the answer, the wait notice, the label) needs `write ok` from
the read just before it, and goes to the label that line names.

Input JSON: {"body": str, "holding": bool, "labels_to": {"human": str, "pr": str},
             "item": {"state": str, "labels": [str], "head": str?, "base": str?, "open_prs": [int]?},
             "items": [{"src": "conversation|inline|review", "id": int, "role": "maintainer|bot|loop",
                        "body": str, "created": str, "updated": str?, "state": str?}],
             "edits": {"<comment id>": [{"at": str, "deleted": bool, "body": str|null, "editor": str|null,
                                         "editor_role": "maintainer|bot|loop|outsider"|null}]}?}
  (edits: newest first, as GitHub returns them; the oldest version is the comment as first posted)
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
    r"^<!-- agent-answer-only v=2 seen=(?P<seen>\S+) item=(?P<item>[0-9a-f]{12}) "
    r"resume=(?P<resume>none|f\d+:[0-9a-f]{12}) flow=(?P<flow>[0-9a-f]{12}) -->$")
ROUND_MARK = re.compile(r"^<!-- codex-review-round:\d+ -->$")


def fp(*parts):
    h = hashlib.sha256()
    for p in parts:
        h.update(str(p).encode("utf-8"))
        h.update(b"\x00")
    return h.hexdigest()[:12]


def tick_groups(body):
    """Every question's options in one comment, one group per question in order: (heading, [option
    lines]). Only option lines under a **Q<n> heading, outside quotes and code fences, count. A
    question's options end at the next heading, the next question, or the first ordinary paragraph /
    quote line after an option (「不勾会怎样」), so a plain task list further down does not count.
    A question with no option lines is left out."""
    groups, cur, seen_opt, fence = [], None, False, False
    for raw in body.replace("\r\n", "\n").split("\n"):
        if FENCE.match(raw):
            fence = not fence
            cur = None
            continue
        if fence:
            continue
        if HEADING.match(raw):
            cur = None
            continue
        if QUESTION.match(raw):
            cur, seen_opt = (raw.strip(), []), False
            groups.append(cur)
            continue
        if cur is None or not raw.strip():
            continue
        if TICK.match(raw):
            cur[1].append(raw.strip())
            seen_opt = True
        elif raw.lstrip().startswith(">") or (seen_opt and not raw[:1].isspace() and not LIST.match(raw)):
            cur = None
    return [g for g in groups if g[1]]


def tick_lines(body):
    """All option lines of all questions, flat (does this comment carry question ticks at all)."""
    return [ln for _, opts in tick_groups(body) for ln in opts]


def tick_state(opts):
    """What a person changes by ticking: which boxes are checked, in order — never the wording
    (the loop account rewording an option is not a tick)."""
    return "".join("x" if TICK.match(ln).group(1) in "xX" else "-" for ln in opts)


def untick(body):
    """A loop comment with every box cleared: ticking is human feedback, not a flow change."""
    return re.sub(r"\[[xX]\]", "[ ]", body)


def record_lines(text):
    """Every record line in a comment or a saved file, in order: (kind, line). A record is a whole
    line outside code fences — v2 (complete current record), wait (the fixed wait record) or legacy
    (anything else that opens with the record mark and closes as a comment: read as "cannot confirm").
    A line that only mentions the mark (inline code, a sentence, a fence) is not a record."""
    out, fence = [], False
    for raw in text.replace("\r\n", "\n").split("\n"):
        if FENCE.match(raw):
            fence = not fence
            continue
        line = raw.strip()
        if fence or not line.startswith(ANSWER_MARK) or not line.endswith("-->"):
            continue
        if MARK_RE.match(line):
            out.append(("v2", line))
        elif line == WAIT_MARK:
            out.append(("wait", line))
        else:
            out.append(("legacy", line))
    return out


def is_answer(body):
    return bool(record_lines(body))


def role_of(body):
    """The flow role of a loop-account comment, by its markers (shown to the worker, not fingerprinted)."""
    kinds = [k for k, _ in record_lines(body)]
    if "wait" in kinds:
        return "等继续记录"
    if kinds:
        return "答复记录"
    lines = [ln.strip() for ln in body.replace("\r\n", "\n").split("\n")]
    if any(ROUND_MARK.match(ln) for ln in lines):
        return "复审结论"
    if "cavil-loop daemon @" in body or any(ln.startswith(("<!-- cavil-loop:", "<!-- agent-blocked-resolved"))
                                            for ln in lines):
        return "daemon 通知"
    return "worker 交付"


def title_of(body):
    for line in body.replace("\r\n", "\n").split("\n"):
        s = line.strip()
        if s.startswith("#"):
            return s
    return "(无标题)"


def item_fp(data):
    it = data["item"]
    prs = it.get("open_prs")
    return fp("item", data.get("body") or "", it.get("state") or "", "\n".join(sorted(it.get("labels") or [])),
              it.get("head") or "", it.get("base") or "",
              "-" if prs is None else ",".join(str(n) for n in sorted(prs)))


UNKNOWN_TIME = "~"   # sorts after every ISO time: a change that cannot be dated counts as the newest


def edited(it):
    return bool(it.get("updated")) and it.get("updated") != it.get("created")


ROLE_NAME = {"maintainer": "维护者", "bot": "外部需求机器人", "loop": "loop 账号", "outsider": "外部账号"}


def question_states(body):
    """Question number in the comment (1-based) → its tick state."""
    return {n: tick_state(opts) for n, (_, opts) in enumerate(tick_groups(body), 1)}


def tick_change(it, n, edits):
    """When question n of this comment last changed its ticks, and who changed it, from the
    comment's edit history: (sort time, text, editor role or None). Only that question's checked
    boxes are compared — another question, or a rewording, is not its change. Never edited, or no
    version changed this question → since it was posted. A deleted version, a history that does not
    end at the current ticks, or an edited comment with no history cannot be dated → UNKNOWN_TIME
    (treated as this round)."""
    created = it.get("created") or ""
    since = (created, "勾选自发表（%s）起没有变过" % created, None)
    if not edited(it):
        return since
    hist = (edits or {}).get(str(it["id"]))
    if not hist:
        return UNKNOWN_TIME, "勾选变化时间无法确认（评论改过、读不到修改历史），按本轮内的变化对待", None
    versions = sorted(hist, key=lambda v: v.get("at") or "")
    if any(v.get("deleted") or not isinstance(v.get("body"), str) for v in versions):
        return UNKNOWN_TIME, "勾选变化时间无法确认（修改历史里有被删掉的版本），按本轮内的变化对待", None
    states = [question_states(v["body"]).get(n) for v in versions]
    if states[-1] != question_states(it.get("body") or "").get(n):
        return UNKNOWN_TIME, "勾选变化时间无法确认（修改历史和现在的正文对不上），按本轮内的变化对待", None
    for i in range(len(states) - 1, 0, -1):
        if states[i] != states[i - 1]:
            v = versions[i]
            role = v.get("editor_role")
            who = "@%s（%s）" % (v["editor"], ROLE_NAME.get(role, "身份未知")) if v.get("editor") else "（账号未知）"
            return v["at"], "勾选最后变化 %s，由 %s改的" % (v["at"], who), role
    return since


def build(data):
    seen, content, flow, answers = [], [], [], []
    edits = data.get("edits") or {}
    for it in data.get("items", []):
        src, iid, role, body = it["src"], int(it["id"]), it["role"], it.get("body") or ""
        if role in ("maintainer", "bot"):
            key = "%s%d" % (SRC_KEY[src], iid)
            seen.append((key, fp(src, iid, it.get("state") or "", body)))
            content.append((key, it))
        elif role == "loop" and src == "conversation":
            if is_answer(body):
                answers.append(it)
                continue
            for n, (head, opts) in enumerate(tick_groups(body), 1):
                key = "t%dq%d" % (iid, n)
                seen.append((key, fp("ticks", iid, n, tick_state(opts))))
                at, note, _ = tick_change(it, n, edits)
                content.append((key, {"src": "ticks", "id": iid, "role": "loop", "q": n,
                                      "body": head + "\n" + "\n".join(opts), "created": at, "tick_note": note}))
            flow.append(("f%d" % iid, fp("flow", iid, untick(body)), it))
    flow_fp = fp("flow-set", ",".join("%s:%s" % (k, f) for k, f, _ in flow))
    return seen, content, flow, flow_fp, item_fp(data), answers


def record_line(seen, flow, flow_fp, item):
    s = ",".join("%s:%s" % kv for kv in seen) or "-"
    resume = ("%s:%s" % (flow[-1][0], flow[-1][1])) if flow else "none"
    return "<!-- agent-answer-only v=2 seen=%s item=%s resume=%s flow=%s -->" % (s, item, resume, flow_fp)


def when(it):
    t = "发表 %s" % (it.get("created") or "时间未知")
    if it.get("updated") and it.get("updated") != it.get("created"):
        t += " ｜ 最后修改 %s" % it["updated"]
    return t


def flow_head(key, it):
    return "%s ｜ %s ｜ %s ｜ %s" % (key, role_of(it.get("body") or ""), when(it), title_of(it.get("body") or ""))


def show(key, it):
    who = {"maintainer": "维护者", "bot": "外部需求机器人", "loop": "loop 账号"}.get(it["role"], it["role"])
    src = {"conversation": "对话", "inline": "行内评论", "review": "review", "ticks": "选择题勾选"}[it["src"]]
    head = "### %s ｜ %s ｜ %s ｜ 编号 %s" % (key, src, who, it["id"])
    if it["src"] == "ticks":
        head += " ｜ 第 %d 题" % it["q"]
    if it.get("state"):
        head += " ｜ %s" % it["state"]
    head += " ｜ " + (it["tick_note"] if it["src"] == "ticks" else when(it))
    return head + "\n" + (it.get("body") or "") + "\n"


def by_time(pairs):
    """Oldest first across conversation / inline / review (ISO times sort as text); ties keep read order."""
    return sorted(pairs, key=lambda kv: kv[1].get("created") or "")


def cmd_snapshot(data):
    seen, content, flow, flow_fp, item, answers = build(data)
    st = data["item"]
    out = [record_line(seen, flow, flow_fp, item), ""]
    out.append("## 本条目")
    desc = "状态 %s ｜ 标签 %s" % (st.get("state"), ", ".join(st.get("labels") or []) or "（无）")
    if st.get("head"):
        desc += " ｜ 最新提交 %s ｜ 目标分支 %s" % (st["head"], st.get("base"))
    if "open_prs" in st:
        desc += " ｜ 关联的打开 PR %s" % (", ".join("#%d" % n for n in st["open_prs"]) or "（无）")
    out.append(desc)
    out.append(holding_line(data))
    out.append(write_line(data))
    out += ["", "## 正文", data.get("body") or "", ""]
    out.append("## 人的反馈（维护者 / 外部需求机器人，按发表时间从早到晚；外部账号的内容不在这里）")
    out += [show(k, it) for k, it in by_time(content)] or ["（没有）"]
    out.append("## 流程记录（loop 账号的评论，答复记录除外；按时间从早到晚）")
    out += [flow_head("%s:%s" % (k, f), it) for k, f, it in flow] or ["（没有）"]
    out.append("")
    out.append("## 答复记录要绑定的那一步（最后一条流程记录，全文）")
    if flow:
        k, f, it = flow[-1]
        out += [flow_head("%s:%s" % (k, f), it), it.get("body") or ""]
    else:
        out.append("（没有流程记录：resume=none）")
    out.append("")
    out.append("## 最新一条答复 / 等继续记录")
    if answers:
        it = answers[-1]
        out.append("编号 %s ｜ %s ｜ %s" % (it["id"], role_of(it.get("body") or ""), when(it)))
        out += [ln for _, ln in record_lines(it.get("body") or "")][-1:]
    else:
        out.append("（没有）")
    sys.stdout.write("\n".join(out) + "\n")
    return 0


def holding_line(data):
    """Not fingerprinted: whether this dispatch still holds the item (the dispatch label is on it)."""
    return "holding " + ("yes" if data.get("holding") else "no")


def write_line(data):
    """The one gate for every write of a question-only round — the answer and the wait notice alike:
    `write ok <label>` (the item is open and this dispatch holds it; <label> is where it goes: an
    issue with an open PR → the PR-tracking label, anything else → the human label) or
    `write stop <reason>`. Judged from this read only; a read that fails prints no gate at all."""
    it = data["item"]
    if it.get("state") != "open":
        return "write stop closed"
    if not data.get("holding"):
        return "write stop not-holding"
    lab = data.get("labels_to") or {}
    to = lab.get("pr") if it.get("open_prs") else lab.get("human")
    if not isinstance(to, str) or not to:
        return "write stop no-label"
    return "write ok " + to


def tick_ids(data):
    """Loop conversation comments whose ticks need their edit history read: they carry question ticks
    and were edited. Answer records are left out, exactly as build() leaves them out."""
    for it in data.get("items", []):
        body = it.get("body") or ""
        if it["role"] == "loop" and it["src"] == "conversation" and not is_answer(body) \
                and tick_lines(body) and edited(it):
            print(int(it["id"]))
    return 0


def parse_seen(s):
    if s == "-":
        return {}
    d = {}
    for part in s.split(","):
        k, _, f = part.partition(":")
        if not re.fullmatch(r"[cir]\d+|t\d+q\d+", k) or not re.fullmatch(r"[0-9a-f]{12}", f) or k in d:
            raise ValueError(part)
        d[k] = f
    return d


def cmd_compare(data, mark):
    seen, content, flow, flow_fp, item, _ = build(data)
    m = MARK_RE.match(mark.strip())
    old = None
    if m:
        try:
            old = parse_seen(m.group("seen"))
        except ValueError:
            old = None
    lines = []

    def verdict(v, reason):
        lines.insert(0, write_line(data))
        lines.insert(0, holding_line(data))
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
    bodies = {k: it for k, _, it in flow}
    if resume == "none":
        resume_ok = not flow
    else:
        rk, _, rf = resume.partition(":")
        resume_ok = flow_now.get(rk) == rf
    lines += ["resume " + resume, "added " + (",".join(added) or "-"),
              "edited " + (",".join(edited) or "-"), "deleted " + (",".join(deleted) or "-")]
    if item != m.group("item"):
        verdict("need-continue", "item-changed")
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
        lines += [show(k, it) for k, it in by_time(content) if k in want]
    else:
        verdict("resume", "same")
        lines.append("")
        lines.append("## 要接着做的那一步（这一次读到的全文）")
        rk = resume.partition(":")[0]
        if rk in bodies:
            lines += [flow_head(resume, bodies[rk]), bodies[rk].get("body") or ""]
        else:
            lines.append("none （没有流程记录：照原规则从正文开始）")
    sys.stdout.write("\n".join(lines) + "\n")
    return 0


def main(argv):
    if len(argv) < 2 or argv[1] not in ("snapshot", "compare", "tick-ids") or (argv[1] == "compare" and len(argv) != 3):
        sys.stderr.write("usage: feedback_fingerprint.py snapshot | tick-ids | compare <record file>\n")
        return 2
    try:
        data = json.load(sys.stdin)
        if not isinstance(data, dict) or not isinstance(data.get("items"), list) \
                or not isinstance(data.get("item"), dict) or not isinstance(data["item"].get("state"), str):
            raise ValueError("shape")
        for it in data["items"]:
            if it.get("src") not in SRC_KEY or not isinstance(it.get("id"), int) \
                    or it.get("role") not in ("maintainer", "bot", "loop") or not isinstance(it.get("body"), str):
                raise ValueError("item")
        if not isinstance(data.get("edits", {}), dict) or not isinstance(data["item"].get("labels"), list) \
                or not isinstance(data["item"].get("open_prs", []), list):
            raise ValueError("shape")
    except (ValueError, KeyError):
        sys.stdout.write("unreadable bad-input\n")
        return 3
    if argv[1] == "snapshot":
        return cmd_snapshot(data)
    if argv[1] == "tick-ids":
        return tick_ids(data)
    try:
        with open(argv[2], encoding="utf-8") as f:
            mark = f.read()
    except OSError:
        sys.stdout.write("unreadable record-file\n")
        return 3
    # the last record line in the file, found by the same parser that recognises answer comments;
    # a wait record or a legacy one is not v2 and reads as "cannot confirm"
    marks = record_lines(mark)
    return cmd_compare(data, marks[-1][1] if marks else "")


if __name__ == "__main__":
    sys.exit(main(sys.argv))
