"""Project lessons file: parse it, and judge a model's rewrite of it.

The retrospective model rewrites the whole lessons file after every merged PR,
and whatever lands in its "hard rules" section becomes something every later
self-review and cross review must check line by line. So the model is trusted
with prose only; identity, meaning, counts and evidence are checked here.

File shape (one file, the section an entry sits in *is* its state):

    <preamble — locked>
    <!-- next-id: 13 -->

    ## 硬规则
    ### L7
    - 规则：<one checkable sentence>          locked
    - 适用：<when it applies>                 locked (optional; presence locked too)
    - 为什么：<why>                           free
    - 这样做是对的：<a good example>           free
    - Seen 3×: #1054 · #1092 <url> · #1112 <url>

    ## 待确认
    ## 观察中

Rules, all relative to the previous version on the base branch (a human edit
is simply the next baseline):

* `L<n>` ids are permanent. They never disappear, never get reused, and new
  ones are allocated from `next-id` upwards, so "is this the same rule after a
  promotion?" is answered by the id alone.
* 规则 / 适用 never change, in any section. A new meaning is a new entry
  starting from one sighting, so it can never inherit someone else's evidence.
* Seen is a set of PR numbers, append-only. The only number a run may add is
  the PR being reviewed (once per rule, but to as many rules as it hit), and
  every added sighting must link to a comment/review collected for that PR.
* Promotion is mechanical: crossing 3 sightings moves an entry out of 观察中 —
  into 硬规则 (`auto`) or 待确认 (`confirm`). Nothing else moves; in
  `confirm` mode only a human can put anything into 硬规则.
"""
import os
import re
from dataclasses import dataclass, field

SECTIONS = ('硬规则', '待确认', '观察中')
WATCH = '观察中'
THRESHOLD = 3
MAX_CHARS = 24000
FIELDS = {'规则': 'rule', '适用': 'applies', '为什么': 'why', '这样做是对的': 'example'}

NEXT_ID = re.compile(r'^<!-- next-id: (\d+) -->$')
SECTION = re.compile(r'^## (\S+)$')
ENTRY = re.compile(r'^### L(\d+)$')
FIELD = re.compile(r'^- (规则|适用|为什么|这样做是对的)：(.+)$')
SEEN = re.compile(r'^- Seen (\d+)×:(.*)$')
SIGHTING = re.compile(r'^#(\d+)(?: (https://\S+))?$')

# Every check can be switched off by name (RETRO_LESSONS_DISABLE=a,b) so the
# test wrapper can prove each test case really depends on the check it names.
CHECKS = ('count', 'dup_pr', 'dup_id', 'preamble', 'next_id', 'keep_ids', 'locked',
          'seen_prefix', 'seen_pr', 'seen_url', 'new_entry', 'section', 'length')


def _on(name):
    return name not in os.environ.get('RETRO_LESSONS_DISABLE', '').split(',')


class LessonsError(ValueError):
    pass


@dataclass
class Entry:
    id: int
    section: str
    rule: str = None
    applies: str = None
    why: str = None
    example: str = None
    seen: list = field(default_factory=list)  # [(pr, url-or-None)]

    @property
    def seen_prs(self):
        return [pr for pr, _ in self.seen]


@dataclass
class Lessons:
    preamble: str
    next_id: int
    entries: list

    def by_id(self):
        return {e.id: e for e in self.entries}


def empty_lessons(preamble):
    body = [preamble.rstrip('\n'), '', '<!-- next-id: 1 -->', '']
    for name in SECTIONS:
        body += [f'## {name}', '']
    return '\n'.join(body).rstrip('\n') + '\n'


def parse(text):
    lines = text.split('\n')
    marker = next((i for i, line in enumerate(lines) if NEXT_ID.match(line)), None)
    if marker is None:
        raise LessonsError('missing <!-- next-id: N --> marker (old-format lessons file?)')
    preamble = '\n'.join(lines[:marker]).strip('\n')
    next_id = int(NEXT_ID.match(lines[marker])[1])
    entries, section, current, seen_sections = [], None, None, []
    for n, line in enumerate(lines[marker + 1:], marker + 2):
        if not line.strip():
            continue
        if m := SECTION.match(line):
            if m[1] not in SECTIONS:
                raise LessonsError(f'line {n}: unknown section {m[1]!r}')
            section, current = m[1], None
            seen_sections.append(section)
            continue
        if m := ENTRY.match(line):
            if section is None:
                raise LessonsError(f'line {n}: entry outside a section')
            current = Entry(int(m[1]), section)
            entries.append(current)
            continue
        if current is None:
            raise LessonsError(f'line {n}: unexpected text outside an entry: {line[:60]!r}')
        if m := FIELD.match(line):
            attr = FIELDS[m[1]]
            if getattr(current, attr) is not None:
                raise LessonsError(f'L{current.id}: field {m[1]} given twice')
            setattr(current, attr, m[2].strip())
            continue
        if m := SEEN.match(line):
            if current.seen:
                raise LessonsError(f'L{current.id}: Seen given twice')
            items = [s.strip() for s in m[2].split(' · ') if s.strip()]
            for item in items:
                s = SIGHTING.match(item)
                if not s:
                    raise LessonsError(f'L{current.id}: bad sighting {item!r}')
                current.seen.append((int(s[1]), s[2]))
            if _on('count') and int(m[1]) != len(current.seen):
                raise LessonsError(f'[count] L{current.id}: says Seen {m[1]}× but lists {len(current.seen)}')
            continue
        raise LessonsError(f'line {n}: unexpected line in L{current.id}: {line[:60]!r}')
    if tuple(seen_sections) != SECTIONS:
        raise LessonsError(f'sections must be exactly {" / ".join(SECTIONS)} in that order')
    ids = [e.id for e in entries]
    if _on('dup_id') and len(ids) != len(set(ids)):
        raise LessonsError('[dup_id] duplicate entry id')
    for e in entries:
        if e.rule is None:
            raise LessonsError(f'L{e.id}: missing 规则')
        if _on('dup_pr') and len(e.seen_prs) != len(set(e.seen_prs)):
            raise LessonsError(f'[dup_pr] L{e.id}: the same PR is counted twice')
        if e.id >= next_id:
            raise LessonsError(f'L{e.id}: id not below next-id {next_id}')
    return Lessons(preamble, next_id, entries)


def is_ready(text):
    try:
        parse(text)
        return True
    except LessonsError:
        return False


def evidence_urls(evidence):
    """Every URL a sighting may cite: the PR, linked issues, and all their discussion."""
    urls = {evidence['pr']['html_url']}
    for issue in evidence.get('issues', []):
        urls.add(issue['html_url'])
        urls.update(c['html_url'] for c in issue.get('conversation', []))
    for key in ('conversation', 'reviews', 'inline_comments'):
        urls.update(c['html_url'] for c in evidence.get(key, []) if c.get('html_url'))
    return urls


def validate(old_text, new_text, *, pr, evidence_urls, mode):
    """Return a list of human-readable violations; empty means the rewrite is acceptable."""
    if mode not in ('auto', 'confirm'):
        raise ValueError(f'unknown promotion mode {mode!r}')
    target = '硬规则' if mode == 'auto' else '待确认'
    old = parse(old_text)  # the baseline must already be valid; callers pre-check
    try:
        new = parse(new_text)
    except LessonsError as error:
        return [str(error) if str(error).startswith('[') else f'[parse] {error}']
    errors = []
    if _on('length') and len(new_text) > MAX_CHARS:
        errors.append(f'[length] file has {len(new_text)} chars, limit {MAX_CHARS}')
    if _on('preamble') and new.preamble != old.preamble:
        errors.append('[preamble] preamble changed')
    old_ids, new_ids = old.by_id(), new.by_id()
    added = sorted(set(new_ids) - set(old_ids))
    if _on('next_id') and (new.next_id != old.next_id + len(added)
                           or added != list(range(old.next_id, new.next_id))):
        errors.append(f'[next_id] new ids {added} must be allocated from next-id {old.next_id} upwards')
    if _on('keep_ids'):
        errors += [f'[keep_ids] L{i} disappeared' for i in sorted(set(old_ids) - set(new_ids))]
    for i, before in old_ids.items():
        after = new_ids.get(i)
        if after is None:
            continue
        if _on('locked') and (after.rule, after.applies) != (before.rule, before.applies):
            errors.append(f'[locked] L{i}: 规则/适用 are locked; write a new entry for a new meaning')
        if _on('seen_prefix') and after.seen[:len(before.seen)] != before.seen:
            errors.append(f'[seen_prefix] L{i}: existing Seen entries must be kept unchanged')
        appended = after.seen[len(before.seen):]
        errors += _check_sightings(f'L{i}', appended, pr, evidence_urls)
        crossed = len(before.seen) < THRESHOLD <= len(after.seen)
        if _on('section'):
            if before.section == after.section:
                if after.section == WATCH and crossed:
                    errors.append(f'[section] L{i}: reached {THRESHOLD} sightings, must move to {target}')
            elif not (before.section == WATCH and after.section == target and crossed):
                errors.append(f'[section] L{i}: may not move {before.section} → {after.section}')
    for i in added:
        entry = new_ids[i]
        if _on('new_entry') and [p for p, _ in entry.seen] != [pr]:
            errors.append(f'[new_entry] L{i}: a new entry starts with exactly one sighting, this PR #{pr}')
        errors += _check_sightings(f'L{i}', entry.seen, pr, evidence_urls)
        if _on('section') and entry.section != WATCH:
            errors.append(f'[section] L{i}: a new entry starts in {WATCH}')
    return errors


def _check_sightings(label, items, pr, urls):
    errors = []
    for number, url in items:
        if _on('seen_pr') and number != pr:
            errors.append(f'[seen_pr] {label}: may only add this PR #{pr}, not #{number}')
        if _on('seen_url') and url not in urls:
            errors.append(f'[seen_url] {label}: sighting #{number} must link to a comment collected for this PR')
    return errors
