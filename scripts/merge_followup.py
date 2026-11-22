#!/usr/bin/env python3
# ── After a PR is merged: what is still to be done, who does it (GitHub#656). Read before changing ──
#
# A PR body registers its follow-ups between `<!-- merge-followup:begin -->` / `<!-- merge-followup:end -->`
# (or `<!-- merge-followup:none -->` for "nothing after the merge"). After the merge the daemon posts on
# the issue the PR belongs to (its "target": the existing PR → work-number rule) one comment that lists
# every follow-up of that target that has not ended, hands the target to a human, and tells the external
# requester bot "需求已完成" only when the evidence says there is nothing left.
#
# This file holds the RULES only (no GitHub access, no state writes): the shell side in
# `scripts/_merge_followup.sh` reads GitHub, writes labels / comments through `gh_write`, and keeps the
# records in state.json (`merge_followup`). Every judgement the shell makes comes from one sub-command
# here, so the poller, the bot notice and the tests ask the same function:
#
#   parse <body> <marks> <section>   the one reading of a body → {s, items, raw}
#                                    s = list (valid list) | none (explicitly nothing) | silent (no marker) | bad
#   conclude  (stdin JSON)           the shared conclusion of one target + its fingerprint + the comment text
#   ended     (stdin JSON)           which records ended (a maintainer closed the target after that PR's merge)
#   notice    (stdin JSON)           the bot's result comment for one PR (table 2), from the same conclusion
#
# Reading rules (`parse`):
#   * a marker counts only on a line of its own, outside code fences and quotes (`body_section … alone`,
#     the same awk the autopilot summary uses — `_autopilot_summary.sh`)
#   * list  = exactly one begin, exactly one end after it, no none; between them only list items
#             (`- ` / `* ` / `1. `) and indented continuation lines, at least one item, every item has
#             non-empty `谁做：` `做什么：` `怎么触发：`
#   * none  = exactly one none, no begin / end;  silent = no marker at all;  bad = anything else
#   * bad keeps the original text: each begin up to its nearest end (else the next begin / the end of
#     the body), each unpaired end / none with 20 lines either side; at most 4000 characters
#
# Conclusion rules (`conclude`, table 1 of the design on GitHub#656):
#   * a record is open (still to be listed) unless it ended; a list / bad record is a follow-up; a record
#     whose body could not be read is "unconfirmed" and listed as such; an "ended: unknown" list is listed
#     with "无法确认之后维护者是否亲手关闭过"
#   * the comment lists every open follow-up record of the target, newest merge first, one section each
#   * the fingerprint is over everything the comment and the labels depend on; a new fingerprint is a
#     new version, versions only grow
#
# Bot notice rules (`notice`, table 2): row 0 (the basis does not hold) is decided by the shell (it
# compares two fresh fingerprints); here rows 1–5 in order, first match wins; "需求已完成" only in row 4.
"""Rules for the merge follow-up hand-over (GitHub#656). See the header comment."""
import hashlib
import json
import re
import sys

RAW_LIMIT = 4000
CONTEXT = 20
FIELDS = ("谁做", "做什么", "怎么触发")
ITEM_RE = re.compile(r"^(?:[-*]|\d+\.)\s+(.*)$")


def _field(item, name):
    others = "|".join(re.escape(f) for f in FIELDS if f != name)
    m = re.search(re.escape(name) + r"\s*[：:]\s*(.*?)\s*(?=[｜|]|(?:%s)\s*[：:]|$)" % others, item)
    return m.group(1).strip() if m else ""


def _items(section):
    """the list items of a section, or None when the section is not a clean list"""
    items, cur = [], None
    for line in section.split("\n"):
        if not line.strip():
            continue
        m = ITEM_RE.match(line)
        if m and not line[:1].isspace():
            if cur is not None:
                items.append(cur)
            cur = m.group(1).strip()
        elif line[:1].isspace() and cur is not None:
            cur += " " + line.strip()
        else:
            return None
    if cur is not None:
        items.append(cur)
    if not items:
        return None
    for it in items:
        if any(not _field(it, f) for f in FIELDS):
            return None
    return items


def _raw(lines, marks):
    """the original text around every counted marker, numbered, at most RAW_LIMIT characters"""
    n = len(lines)
    begins = [x for k, x in marks if k == "B"]
    used_ends, spans = set(), []
    for b in begins:
        end = next((x for k, x in marks if k == "E" and x > b and x not in used_ends), None)
        nb = next((x for x in begins if x > b), None)
        if end is not None and (nb is None or end < nb):
            used_ends.add(end)
            spans.append((b, end))
        elif nb is not None:
            spans.append((b, nb - 1))
        else:
            spans.append((b, n))
    for k, x in marks:
        if (k == "E" and x not in used_ends) or k == "N":
            spans.append((max(1, x - CONTEXT), min(n, x + CONTEXT)))
    spans.sort()
    merged = []
    for a, b in spans:
        if merged and a <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], b))
        else:
            merged.append((a, b))
    parts = []
    for i, (a, b) in enumerate(merged, 1):
        parts.append("（第 %d 段，正文第 %d–%d 行）\n%s" % (i, a, b, "\n".join(lines[a - 1:b])))
    text = "\n\n".join(parts)
    if len(text) > RAW_LIMIT:
        text = text[:RAW_LIMIT] + "\n…（已截断）"
    return text


def parse(body, marks_text, section):
    marks = []
    for line in marks_text.split("\n"):
        if line.strip():
            k, x = line.split()
            marks.append((k, int(x)))
    nb = sum(1 for k, _ in marks if k == "B")
    ne = sum(1 for k, _ in marks if k == "E")
    nn = sum(1 for k, _ in marks if k == "N")
    if not marks:
        return {"s": "silent", "items": [], "raw": ""}
    if nn == 1 and nb == 0 and ne == 0:
        return {"s": "none", "items": [], "raw": ""}
    lines = body.split("\n")
    if body.endswith("\n"):
        lines = lines[:-1]
    if nb == 1 and ne == 1 and nn == 0:
        b = next(x for k, x in marks if k == "B")
        e = next(x for k, x in marks if k == "E")
        if e > b:
            items = _items(section)
            if items is not None:
                return {"s": "list", "items": items, "raw": ""}
    return {"s": "bad", "items": [], "raw": _raw(lines, marks)}


# ── conclusion ─────────────────────────────────────────────────────────────────

def fingerprint(obj):
    return hashlib.sha256(json.dumps(obj, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:16]


def _section(rec):
    """one PR's section of the checklist comment"""
    pr = rec["pr"]
    head = "**PR #%s**（合并于 %s）" % (pr, rec.get("merged_at") or "?")
    notes = []
    if rec.get("ended") == "unknown":
        notes.append("无法确认之后维护者是否亲手关闭过本条目，清单照列")
    if rec.get("cleanup_skipped"):
        notes.append("合并扫描没有为这个 PR 清理本机工作区和会话，本机还剩什么请维护者自行确认")
    if rec.get("fb_note"):
        notes.append(rec["fb_note"])
    if rec.get("body") == "pending":
        text = "正文读不到，有没有待办无法确认。完整正文见 PR #%s，请核对。" % pr
    elif rec["s"] == "list":
        text = "\n".join("%d. %s" % (i, it) for i, it in enumerate(rec["items"], 1))
    else:
        text = ("⚠️ 待办的写法不对，下面照搬正文里相关的原文，请人核实：\n\n```text\n%s\n```\n\n"
                "完整正文见 PR #%s，请核对是否还有未列出的待办。") % (rec.get("raw", "").replace("```", "ˋˋˋ"), pr)
    out = head + "\n\n" + text
    if notes:
        out += "\n\n" + "\n".join("> " + x for x in notes)
    return out


def conclude(d):
    """d = {target, kind: issue|pr, state: open|closed, superseded: bool, newest: <pr>,
             autopilot: {...} | null, labels: {human, done, agent}, records: [ ... ]}
    → {fp, cell, followups: bool, unconfirmed: bool, needs_comment: bool, reminder: bool, comment, covers}"""
    recs = sorted(d["records"], key=lambda r: (r.get("merged_at") or "", int(r["pr"])), reverse=True)
    open_recs = [r for r in recs if r.get("ended") != "yes"]
    fu = [r for r in open_recs if r.get("body") == "pending" or r["s"] in ("list", "bad")]
    unconfirmed = any(r.get("body") == "pending" or r["s"] == "bad" or r.get("ended") == "unknown" for r in fu)
    newest = next((r for r in recs if str(r["pr"]) == str(d["newest"])), recs[0] if recs else None)
    ap = d.get("autopilot")
    st = d["state"]
    L = d["labels"]
    tgt = d["target"]
    kind = d["kind"]
    if fu:
        cell = "followups"
    elif newest is not None and newest["s"] == "none":
        cell = "none"
    else:
        cell = "silent"
    # comment: an open target always gets one; a closed one only with follow-ups or an autopilot description
    needs_comment = st == "open" or bool(fu) or bool(ap)
    # reminder: a closed target keeps / gets pending/human when follow-ups are left, and a closed issue after an
    # autopilot merge (the PR itself, when it is the target, only with follow-ups — its other labels stay as before)
    # (only when the PR's own close keyword closed it — `ap.closes`; a target someone closed by hand just gets Done, as before)
    reminder = st == "closed" and (bool(fu) or (bool(ap) and kind == "issue" and bool(ap.get("closes"))))
    lines = []
    where = "本 issue " if kind == "issue" else "本 PR "
    if ap:
        lines.append("## ✅ 托管：已自动合并 PR #%s：%s" % (ap["pr"], ap.get("title", "")))
    elif fu:
        lines.append("## 已合并 PR #%s，还有 %d 个 PR 的待办没确认做完" % (d["newest"], len(fu)))
    elif cell == "none":
        lines.append("## 已合并 PR #%s，PR 写明合并后没有待办" % d["newest"])
    else:
        lines.append("## 已合并 PR #%s，PR 没写合并后有没有待办" % d["newest"])
    lines.append("")
    if fu:
        if st == "closed":
            todo = ("要人做的：%s已关闭，但下面的待办还没确认做完，挂着 `%s` 提醒。按清单逐项处理；全部做完后摘掉 `%s`。"
                    % (where, L["human"], L["human"]))
        else:
            todo = ("要人做的：按下面的清单逐项处理（谁做 / 做什么 / 怎么触发）；全部做完后关闭%s"
                    "（daemon 只在维护者亲手关闭之后才认为这些待办已结束）。" % where.rstrip())
    elif st == "closed" and kind == "pr":
        todo = "本条不需要人做任何事；要撤回就在 GitHub 上 revert 这个 PR。"
    elif st == "closed" and not reminder:
        todo = "要人做的：%s已关闭（`%s`），不需要再做什么；要返工就重开%s、摘掉 `%s`、打 `%s`。" % (
            where, L["done"], where.rstrip(), L["done"], L["agent"])
    elif st == "closed":
        todo = ("要人做的：%s已随合并关闭，挂着 `%s` 提醒人看。看过满意就摘掉 `%s`（`%s` 留着）；要返工就重开%s、摘掉 `%s` 和 `%s`、打 `%s`。"
                % (where, L["human"], L["human"], L["done"], where.rstrip(), L["done"], L["human"], L["agent"]))
    elif ap:
        todo = "要人做的：看过之后满意就关闭%s（关成「已完成」会自动打 `%s`）；要返工就打 `%s`。" % (where.rstrip(), L["done"], L["agent"])
    elif cell == "none":
        todo = "PR 写明合并后没有待办。是否关闭%s由人决定；要返工就打 `%s`。" % (where, L["agent"])
    else:
        todo = ("PR 没写合并后有没有待办。是否关闭%s由人决定；要 agent 整理还剩什么，就打 `%s`。"
                % (where, L["agent"]))
    if d.get("superseded"):
        todo += "（%s已挂着新一轮的流程标签，daemon 这次不动它的标签。）" % where
    lines.append(todo)
    if fu:
        lines.append("")
        lines.append("### 合并后还要做的事")
        for r in fu:
            lines.append("")
            lines.append(_section(r))
    if ap:
        lines.append("")
        lines.append(ap.get("desc", ""))
    covers = sorted({int(r["pr"]) for r in recs})
    conc = {"target": str(tgt), "kind": kind, "state": st, "cell": cell, "superseded": bool(d.get("superseded")),
            "reminder": reminder, "covers": covers,
            "fu": [{k: r.get(k) for k in ("pr", "s", "items", "raw", "body", "ended", "merged_at", "cleanup_skipped", "fb_note")}
                   for r in fu],
            "newest": str(d["newest"]), "ap": ap or None}
    fp = fingerprint(conc)
    comment = "\n".join(lines).rstrip() + "\n"
    return {"fp": fp, "cell": cell, "followups": bool(fu), "unconfirmed": unconfirmed, "needs_comment": needs_comment,
            "reminder": reminder, "covers": covers, "comment": comment, "fu": conc["fu"]}


# ── "ended": a maintainer closed the target after the PR's merge ──────────────

def ended(d):
    """d = {events: [...] | null, merged: {<pr>: merged_at}, writers: {<login>: true|false|null}, bots: [login],
            closers: {<event node_id>: "none" | "PullRequest" | "Commit" | ... | null}}
    events = REST issue events (paged and joined). A close counts when it is strictly later than the merge
    (same second = unknown), was not done by a PR or a commit, by an account that is not the loop's or the
    bot's, with write access. "Not done by a PR or a commit" comes from the close event's GraphQL `closer`
    (`closers`, read by the shell for exactly these events) — the REST `commit_id` is empty when a PR merge
    closes an issue, so it cannot tell a merge close from a hand close; a closer that could not be read is
    unknown, never "by hand". → {<pr>: yes|no|unknown}"""
    out = {}
    evs = d.get("events")
    bots = {x.lower() for x in d.get("bots", []) if x}
    for pr, at in d["merged"].items():
        if evs is None or not at:
            out[pr] = "unknown"
            continue
        verdict = "no"
        for e in evs:
            if e.get("event") != "closed":
                continue
            t = e.get("created_at") or ""
            if not t:
                verdict = "unknown"
                continue
            if t[:19] < at[:19]:
                continue
            if t[:19] == at[:19]:
                if verdict == "no":
                    verdict = "unknown"
                continue
            if e.get("commit_id"):
                continue
            who = ((e.get("actor") or {}).get("login") or "").lower()
            if not who or who in bots:
                continue
            closer = (d.get("closers") or {}).get(e.get("node_id") or "")
            if closer is None:
                if verdict == "no":
                    verdict = "unknown"
                continue
            if closer != "none":
                continue
            w = d.get("writers", {}).get(who)
            if w is None:
                if verdict == "no":
                    verdict = "unknown"
                continue
            if w:
                verdict = "yes"
                break
        out[pr] = verdict
    return out


# ── the bot's result comment (table 2) ────────────────────────────────────────

def notice(d):
    """d = {pr, title, base, sha, conc: <conclude output>, own_s, own_ended, guard: bool,
            target_state, maintainer_closed: bool, correction: bool}
    → {row, done: bool, body}"""
    pr = d["pr"]
    c = d["conc"]
    own = d["own_s"]
    head = "PR #%s（%s）已合并进 `%s`，合并提交 `%s`。" % (pr, d.get("title", ""), d.get("base", "?"), (d.get("sha") or "?")[:12])
    if c["followups"]:
        row, title, text = 1, "## 已合并 PR #%s，需求还有待办" % pr, \
            head + "需求还有合并后的待办，由维护者处理。清单（与 issue 上的同一份）：\n\n" + "\n\n".join(_section(r) for r in c["fu"])
    elif d.get("guard"):
        row, title, text = 2, "## 已合并 PR #%s" % pr, head + "是否还有后续由维护者确认。"
    elif own == "silent":
        row, title, text = 3, "## 已合并 PR #%s" % pr, head + "PR 没写合并后有没有待办，是否还有后续由维护者确认。"
    elif (own == "none" or d.get("own_ended") == "yes") and d.get("target_state") == "closed" and d.get("maintainer_closed"):
        row, title, text = 4, "## 需求已完成：PR #%s 已合并" % pr, head + "合并后没有待办，维护者已关闭需求。这条需求到此完成。"
    else:
        row, title, text = 5, "## 已合并 PR #%s" % pr, head + "是否还有后续由维护者确认。"
    if d.get("correction"):
        title = "## 更正：上一条『需求已完成』不准确\n\n#" + title
    return {"row": row, "done": row == 4, "body": title + "\n\n" + text + "\n"}


def main(argv):
    cmd = argv[1] if len(argv) > 1 else ""
    if cmd == "parse":
        with open(argv[2], encoding="utf-8", errors="replace") as f:
            body = f.read()
        with open(argv[3], encoding="utf-8") as f:
            marks = f.read()
        with open(argv[4], encoding="utf-8", errors="replace") as f:
            section = f.read()
        print(json.dumps(parse(body, marks, section), ensure_ascii=False))
        return 0
    if cmd in ("conclude", "ended", "notice"):
        d = json.load(sys.stdin)
        print(json.dumps({"conclude": conclude, "ended": ended, "notice": notice}[cmd](d), ensure_ascii=False))
        return 0
    sys.stderr.write("usage: merge_followup.py parse|conclude|ended|notice\n")
    return 64


if __name__ == "__main__":
    sys.exit(main(sys.argv))
