#!/usr/bin/env python3
"""Recognise "the agent hit its subscription usage limit" from a worker pane (GitHub#341).

    usage_limit.py detect --agent claude|codex --screen FILE
                          [--record FILE] [--since EPOCH] [--now EPOCH] [--fallback SECS]

Prints one JSON object:

    verdict       "limit"  the screen shows the limit notice as its last block AND the
                           session record gives no sign that the model or a tool printed it
                  "no"     not a limit (or the reset time already passed)
                  "unsure" the screen looks like a limit but the evidence is incomplete
                           (no record, unreadable / half-written record) -- callers do nothing
    reason        one short sentence (Chinese, goes to poll.log)
    reset_epoch   when the limit lifts (only with "limit")
    reset_source  "screen" (read from the notice) or "fallback" (could not be read / out of range)
    reset_text    the time as written on the screen
    fingerprint   hash of the notice block; the caller compares it across two poll rounds
    record_size   size of the session record in bytes (same purpose)

The screen rules are structural, the same way the folder-trust dialog is recognised: the notice
must be the last block of output, and only the lines the CLI itself draws under it may follow.
A conversation that merely quotes the sentence does not match.  The rules were written from real
pane captures (tests/fixtures/usage-limit/); wording that is not in those samples is "no".
"""
import argparse
import hashlib
import json
import os
import re
import sys
import time
from datetime import datetime, timedelta

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover - python < 3.9
    ZoneInfo = None

MAX_AHEAD = 8 * 86400          # a reset further away than this is not believed
PHRASE = re.compile(r"hit your (?:[a-z0-9-]+ )?limit", re.I)
SAFE_TIME_TEXT = re.compile(r"^[A-Za-z0-9 ,:/()_+.-]{1,60}$")

MONTHS = {m: i + 1 for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"])}


# ── screen: claude ──────────────────────────────────────────────────────────
#   ⎿  You've hit your session limit · resets 1:30pm (Asia/Singapore)
#      Continuing automatically at 1:30pm · esc to cancel        (not in every version)
#      /usage-credits to finish what you’re working on.
#
# ● Usage limit reached · continuing automatically at 1:30pm · esc or type to cancel
#
# ✻ Cogitated for 19m 1s
#
#   6 tasks (2 done, 1 in progress, 3 open)                       (task list, optional)
#   ◼ …
# ──────────────────────────────── (input box; anything below it is the CLI's own chrome)
CLAUDE_HEAD = re.compile(r"^\s*⎿\s+You've hit your (?:[a-z0-9-]+ )?limit · resets (.+?)\s*$")
CLAUDE_CONT = re.compile(
    r"^\s{3,}(?:Continuing (?:shortly|automatically at .+?) · esc to cancel"
    r"|/[a-z-]+ to [^●]+)\s*$")
CLAUDE_AFTER = [
    re.compile(r"^● Usage limit reached · continuing (?:automatically at .+|shortly.*)$"),
    re.compile(r"^[✻✽✶✢*·] \S+ for \d+[hms].*$"),
    re.compile(r"^\s+\d+ tasks? \(.*\)\s*$"),
    re.compile(r"^\s+[◼◻✔☐☒✓] .*$"),
    re.compile(r"^\s+… \+\d+ .*$"),
]
RULE_LINE = re.compile(r"^\s*[─━]{10,}")


def claude_screen(lines):
    idx = None
    for i, ln in enumerate(lines):
        if CLAUDE_HEAD.match(ln):
            idx = i
    if idx is None:
        return None
    block = [lines[idx].strip()]
    j = idx + 1
    while j < len(lines) and CLAUDE_CONT.match(lines[j]):
        block.append(lines[j].strip())
        j += 1
    seen_rule = False
    for ln in lines[j:]:
        if RULE_LINE.match(ln):
            seen_rule = True
            break
        if not ln.strip():
            continue
        if not any(p.match(ln) for p in CLAUDE_AFTER):
            return None
    if not seen_rule:           # no input box under it: not a settled claude screen
        return None
    return {"block": block, "reset_text": CLAUDE_HEAD.match(lines[idx]).group(1).strip()}


# ── screen: codex ───────────────────────────────────────────────────────────
# ■ You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to
# purchase more credits or try again at Aug 20th, 2026 11:35 AM.
#
#   Approaching rate limits                                       (model-switch dialog, optional)
#   Switch to gpt-5.6-luna for lower credit usage?
# › 1. Switch to gpt-5.6-luna                 Fast and affordable agentic coding
#                                             model.
#   2. Keep current model
#   Press enter to confirm or esc to go back
#
# › Ask Codex to do anything                                      (composer, optional)
#   gpt-5.6-sol xhigh · ~/github/worktree/…                       (status line, optional)
CODEX_HEAD = re.compile(r"^■ You've hit your usage limit\.")
CODEX_DIALOG = [
    re.compile(r"^\s*Approaching rate limits\s*$"),
    re.compile(r"^\s*Switch to \S+ for lower credit usage\?\s*$"),
    re.compile(r"^[› ] ?\d+\. \S.*$"),
    re.compile(r"^\s{20,}\S.*$"),
    re.compile(r"^\s*Press enter to confirm or esc to go back\s*$"),
]
CODEX_COMPOSER = re.compile(r"^› .*$")
CODEX_STATUS = re.compile(r"^\s{2}\S.* · .*$")
CODEX_TRY_AT = re.compile(r"try again at (.+?)\.\s*$")


def codex_screen(lines):
    idx = None
    for i, ln in enumerate(lines):
        if CODEX_HEAD.match(ln):
            idx = i
    if idx is None:
        return None
    block = []
    j = idx
    while j < len(lines) and lines[j].strip():
        block.append(lines[j].strip())
        j += 1
    rest = [ln for ln in lines[j:] if ln.strip()]
    k = 0
    while k < len(rest) and any(p.match(rest[k]) for p in CODEX_DIALOG):
        k += 1
    tail = rest[k:]
    if tail and CODEX_COMPOSER.match(tail[0]):
        tail = tail[1:]
    if tail and CODEX_STATUS.match(tail[0]):
        tail = tail[1:]
    if tail:
        return None
    text = " ".join(block)
    m = CODEX_TRY_AT.search(text)
    return {"block": block, "reset_text": m.group(1).strip() if m else ""}


# ── reset time ──────────────────────────────────────────────────────────────
TIME_RE = r"(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?"
DATE_RE = r"([A-Za-z]{3})[a-z]*\.? (\d{1,2})(?:st|nd|rd|th)?"


def _tz(name):
    if not name or ZoneInfo is None:
        return None
    try:
        return ZoneInfo(name)
    except Exception:
        return None


def _hour(h, ap):
    h = int(h) % 12
    return h + 12 if ap.lower() == "p" else h


def parse_reset(text, ref_epoch):
    """Reset epoch for the time written on screen, or None.

    `ref_epoch` is the moment the notice appeared.  A time without a date means the first such
    time after that moment -- not after "now": a stale screen read after the reset must come out
    in the past, never as tomorrow.
    """
    text = (text or "").strip()
    if not text:
        return None
    tz = None
    m = re.search(r"\(([A-Za-z_]+/[A-Za-z_+\-/]+|UTC)\)\s*$", text)
    if m:
        tz = _tz(m.group(1))
        if tz is None:
            return None
        text = text[:m.start()].strip()
    ref = datetime.fromtimestamp(ref_epoch, tz) if tz else datetime.fromtimestamp(ref_epoch).astimezone()

    # "Aug 20th, 2026 11:35 AM" / "Nov 13, 2pm" / "Nov 13 at 2pm"
    m = re.match(r"^%s,?(?: (\d{4}))?,?(?: at)? %s$" % (DATE_RE, TIME_RE), text, re.I)
    if m:
        mon = MONTHS.get(m.group(1).lower())
        if not mon:
            return None
        hour, minute = _hour(m.group(4), m.group(6)), int(m.group(5) or 0)
        years = [int(m.group(3))] if m.group(3) else [ref.year, ref.year + 1]
        for y in years:
            try:
                dt = ref.replace(year=y, month=mon, day=int(m.group(2)), hour=hour, minute=minute,
                                 second=0, microsecond=0)
            except ValueError:
                return None
            if m.group(3) or dt.timestamp() > ref_epoch - 86400:
                return int(dt.timestamp())
        return None

    # "1:30pm" / "2pm"
    m = re.match(r"^%s$" % TIME_RE, text, re.I)
    if m:
        hour, minute = _hour(m.group(1), m.group(3)), int(m.group(2) or 0)
        if minute > 59:
            return None
        dt = ref.replace(hour=hour, minute=minute, second=0, microsecond=0)
        if dt.timestamp() <= ref_epoch:
            dt = dt + timedelta(days=1)
        return int(dt.timestamp())
    return None


# ── session record: was the sentence produced by the model or a tool? ───────
def _strings(node):
    if isinstance(node, str):
        yield node
    elif isinstance(node, dict):
        for v in node.values():
            yield from _strings(v)
    elif isinstance(node, list):
        for v in node:
            yield from _strings(v)


def _ts(val):
    if not isinstance(val, str):
        return None
    try:
        return datetime.fromisoformat(val.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def record_check(agent, path, since):
    """("ok"|"quoted"|"unreadable", detail).  "ok" = read whole, sentence not produced in it."""
    try:
        with open(path, "rb") as fh:
            raw = fh.read()
    except OSError as e:
        return "unreadable", "会话记录读不到（%s）" % e.__class__.__name__
    if not raw.strip():
        return "unreadable", "会话记录是空的"
    if not raw.endswith(b"\n"):
        return "unreadable", "会话记录最后一行还没写完"
    for n, line in enumerate(raw.split(b"\n"), 1):
        if not line.strip():
            continue
        try:
            obj = json.loads(line)
        except ValueError:
            return "unreadable", "会话记录第 %d 行不是完整的 JSON" % n
        if not isinstance(obj, dict):
            return "unreadable", "会话记录第 %d 行不是对象" % n
        ts = _ts(obj.get("timestamp"))
        # no timestamp = cannot place it before the dispatch, so it is checked too
        if since and ts is not None and ts < since:
            continue
        if agent == "claude":
            if obj.get("type") not in ("assistant", "user"):
                continue
            msg = obj.get("message") if isinstance(obj.get("message"), dict) else {}
            # the CLI's own error record (not model output): this is the real thing, not a quote
            if obj.get("isApiErrorMessage") or msg.get("model") == "<synthetic>":
                continue
            payload = [msg.get("content"), obj.get("toolUseResult")]
        else:
            if obj.get("type") not in ("response_item", "event_msg"):
                continue
            pl = obj.get("payload") if isinstance(obj.get("payload"), dict) else {}
            if pl.get("type") in ("error", "stream_error", "token_count", "turn_context", "session_meta"):
                continue
            payload = pl
        for s in _strings(payload):
            if PHRASE.search(s):
                return "quoted", "会话记录第 %d 行（模型回复、工具输出或派工说明）里有这句提示" % n
    return "ok", ""


def detect(args):
    try:
        with open(args.screen, encoding="utf-8", errors="replace") as fh:
            lines = [ln.rstrip() for ln in fh.read().split("\n")]
    except OSError as e:
        return {"verdict": "unsure", "reason": "屏幕读不到（%s）" % e.__class__.__name__}
    hit = claude_screen(lines) if args.agent == "claude" else codex_screen(lines)
    if hit is None:
        return {"verdict": "no", "reason": "屏幕最后一块不是用量上限提示"}
    # the time text ends up in a GitHub comment and in poll.log: anything that is not a plain
    # date / time / zone is not shown and not parsed (fixed wait instead)
    if not SAFE_TIME_TEXT.match(hit["reset_text"]):
        hit["reset_text"] = ""
    out = {
        "fingerprint": hashlib.sha256(
            (args.agent + "\n" + "\n".join(hit["block"])).encode("utf-8")).hexdigest()[:24],
        "reset_text": hit["reset_text"],
    }
    if not args.record:
        out.update(verdict="unsure", reason="没有这条会话的记录可核对（会话没登记）")
        return out
    state, detail = record_check(args.agent, args.record, args.since)
    if state == "unreadable":
        out.update(verdict="unsure", reason=detail)
        return out
    if state == "quoted":
        out.update(verdict="no", reason=detail)
        return out
    st = os.stat(args.record)
    out["record_size"] = st.st_size
    now = args.now if args.now else int(time.time())
    # the notice appeared when the record was last written (nothing is written after it)
    ref = min(int(st.st_mtime), now)
    reset = parse_reset(hit["reset_text"], ref)
    if reset is not None and reset <= now:
        out.update(verdict="no", reason="屏幕上的解除时间（%s）已经过了" % hit["reset_text"])
        return out
    if reset is None or reset - now > MAX_AHEAD:
        out.update(reset_epoch=now + args.fallback, reset_source="fallback")
    else:
        out.update(reset_epoch=reset, reset_source="screen")
    out.update(verdict="limit", reason="")
    return out


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("detect")
    d.add_argument("--agent", required=True, choices=["claude", "codex"])
    d.add_argument("--screen", required=True)
    d.add_argument("--record", default="")
    d.add_argument("--since", type=float, default=0)
    d.add_argument("--now", type=int, default=0)
    d.add_argument("--fallback", type=int, default=3600)
    args = ap.parse_args()
    json.dump(detect(args), sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
