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
* A new entry may not copy an existing one's 规则 + 适用 under a fresh id —
  that would restart the count at one and dodge the promotion the existing
  entry is owed. Only verbatim copies (any whitespace ignored) are caught; telling
  paraphrases apart is beyond a program and is left to review.
* Promotion is mechanical: crossing 3 sightings moves an entry out of 观察中 —
  into 硬规则 (`auto`) or 待确认 (`confirm`). Nothing else moves; in
  `confirm` mode only a human can put anything into 硬规则.
* A promotion has a length limit (GitHub#600, `RETROSPECTIVE_RULE_MAX_CHARS`,
  default 300, 0 = none): 规则 + 适用 + 为什么 together, in characters, without
  the `- 规则：` prefixes. An entry over it stays in 观察中 and its id goes into one
  line under next-id, `<!-- held-over-limit: L12 L34 -->`; once it fits (a human
  shortened it, or raised the limit) the next run promotes it. Who may promote is
  decided by `promotion_plan` alone — `place` puts the entries there and
  `validate` checks the result against the same plan. The line is the program's:
  the model never sees it, and a model output carrying it is rejected. Entries
  already in 硬规则 / 待确认 are never measured.

Optional fourth section `## 目录经验` (GitHub#152): pitfalls that only bite in one
part of the code. Whether a run may write it is decided outside this module
(`RETROSPECTIVE_DIRECTORY_LESSONS` plus the PR's merge time, GitHub#168): when it may,
the runner appends an empty heading to the baseline before the model sees it; when
it may not, the section must come back byte for byte (`directories=False`). A model
may never add the heading itself. Entries look the same, but every sighting names the directories it
happened in — `#1471 <url> [server/credits/ · server/usage/]` — so the project can
rank lessons per directory and write them into each directory's own instructions.
That section never promotes, entries never move in or out of it, every new
sighting must name directories that exist in the merged tree, and old sightings
(directories included) stay byte for byte. Prompt composition leaves it out.
"""
import os
import re
from dataclasses import dataclass, field
from pathlib import Path

SECTIONS = ('硬规则', '待确认', '观察中')
WATCH = '观察中'
DIRS = '目录经验'
THRESHOLD = 3
MAX_CHARS = 24000       # the whole file but 目录经验 (prompts get a trimmed part of it)
MAX_DIR_CHARS = 24000   # the 目录经验 section on its own
FIELDS = {'规则': 'rule', '适用': 'applies', '为什么': 'why', '这样做是对的': 'example'}

NEXT_ID = re.compile(r'^<!-- next-id: (\d+) -->$')
SECTION = re.compile(r'^## (\S+)$')
ENTRY = re.compile(r'^### L(\d+)$')
FIELD = re.compile(r'^- (规则|适用|为什么|这样做是对的)：(.+)$')
SEEN = re.compile(r'^- Seen (\d+)×:(.*)$')
SIGHTING = re.compile(r'^#(\d+)(?: (https://\S+))?(?: \[([^\[\]]*)\])?$')
HELD_PREFIX = '<!-- held-over-limit:'
# Zero ids is allowed: a human deleting the last id from the line leaves `<!-- held-over-limit: -->`.
HELD = re.compile(r'^<!-- held-over-limit:((?: L\d+)*) -->$')
HELD_FIX = ('expected one line `<!-- held-over-limit: L12 L34 -->` right under next-id '
            '(ids may be deleted, down to none), or delete the whole line')
RULE_MAX_CHARS_DEFAULT = 300   # same default as RETROSPECTIVE_RULE_MAX_CHARS in the runner's shell entry
RULE_MAX_CHARS_LIMIT = 100000
DIR_HEADING = f'## {DIRS}'

# Every check can be switched off by name (RETRO_LESSONS_DISABLE=a,b) so the
# test wrapper can prove each test case really depends on the check it names.
CHECKS = ('count', 'dup_pr', 'dup_id', 'preamble', 'next_id', 'keep_ids', 'locked',
          'seen_prefix', 'seen_pr', 'seen_url', 'new_entry', 'dup_rule', 'section', 'length',
          'dir_section', 'dir_required', 'dir_valid', 'dir_frozen', 'held',
          # Checked by post-merge-retrospective.py around the project command:
          'cmd_files', 'cmd_head')


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
    seen: list = field(default_factory=list)  # [(pr, url-or-None, dirs-tuple-or-None)]
    at: int = -1     # 0-based line of its `### L<n>` heading in the parsed text
    end: int = -1    # one past its last non-blank line

    @property
    def seen_prs(self):
        return [pr for pr, _, _ in self.seen]


@dataclass
class Lessons:
    preamble: str
    next_id: int
    entries: list
    has_dirs: bool = False   # the file carries the optional 目录经验 section
    held: tuple = ()         # ids on the held-over-limit line, in file order
    # Positions in the parsed text (0-based lines), so `place` edits exactly what was parsed:
    marker_at: int = -1      # the next-id line
    held_at: int = -1        # the held-over-limit line, -1 when there is none
    sections_at: dict = field(default_factory=dict)  # name -> (heading line, last non-blank line)

    def by_id(self):
        return {e.id: e for e in self.entries}


def empty_lessons(preamble):
    body = [preamble.rstrip('\n'), '', '<!-- next-id: 1 -->', '']
    for name in SECTIONS:
        body += [f'## {name}', '']
    return '\n'.join(body).rstrip('\n') + '\n'


MAX_DIGITS = 9   # ids, PR numbers, counts: anything longer is a broken file, never a Python error


def _int(digits, n, what):
    if len(digits) > MAX_DIGITS:
        raise LessonsError(f'line {n}: {what} has more than {MAX_DIGITS} digits')
    return int(digits)


def held_like(line):
    """A line meant as the held-over-limit line, well-formed or not: an HTML comment naming it."""
    return line.startswith(HELD_PREFIX) or (line.lstrip().startswith('<!--') and 'held-over-limit' in line)


def parse(text):
    """Parse a lessons file; anything malformed is a LessonsError (never another exception),
    so the runner can tell a broken baseline from a failed run."""
    lines = text.split('\n')
    marker = next((i for i, line in enumerate(lines) if NEXT_ID.match(line)), None)
    if marker is None:
        raise LessonsError('missing <!-- next-id: N --> marker (old-format lessons file?)')
    for n, line in enumerate(lines[:marker], 1):
        if held_like(line):
            # Caught here, before the model call: strip_held would otherwise hide it and the
            # preamble check would reject the model's output instead (one attempt wasted).
            raise LessonsError(f'line {n}: held-over-limit line above next-id: {line[:80]!r}; {HELD_FIX}')
    preamble = '\n'.join(lines[:marker]).strip('\n')
    next_id = _int(NEXT_ID.match(lines[marker])[1], marker + 1, 'next-id')
    entries, section, current, seen_sections, held, held_line = [], None, None, [], (), None
    sections_at = {}
    for n, line in enumerate(lines[marker + 1:], marker + 2):
        if not line.strip():
            continue
        if held_like(line):
            m = HELD.match(line)
            if section is not None or held_line is not None or not m:
                where = ('given twice' if held_line is not None else
                         'inside a section' if section is not None else 'malformed')
                raise LessonsError(f'line {n}: held-over-limit line {where}: {line[:80]!r}; {HELD_FIX}')
            held_line = n
            held = tuple(_int(x[1:], n, 'held-over-limit line: an id') for x in m[1].split())
            if len(held) != len(set(held)):
                raise LessonsError(f'line {n}: held-over-limit line lists an id twice; {HELD_FIX}')
            continue
        if m := SECTION.match(line):
            if m[1] not in SECTIONS + (DIRS,):
                raise LessonsError(f'line {n}: unknown section {m[1]!r}')
            section, current = m[1], None
            seen_sections.append(section)
            sections_at[section] = n - 1
            continue
        if m := ENTRY.match(line):
            if section is None:
                raise LessonsError(f'line {n}: entry outside a section')
            current = Entry(_int(m[1], n, 'entry id'), section, at=n - 1)
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
            items = [s.strip() for s in _split_sightings(m[2]) if s.strip()]
            for item in items:
                s = SIGHTING.match(item)
                if not s:
                    raise LessonsError(f'L{current.id}: bad sighting {item!r}')
                dirs = None
                if s[3] is not None:
                    if current.section != DIRS:
                        raise LessonsError(f'L{current.id}: directories only belong in {DIRS}')
                    dirs = tuple(d.strip() for d in s[3].split(' · '))
                    if not all(dirs):
                        raise LessonsError(f'L{current.id}: empty directory in {item!r}')
                current.seen.append((_int(s[1], n, 'a sighting'), s[2], dirs))
            if _on('count') and _int(m[1], n, 'Seen count') != len(current.seen):
                raise LessonsError(f'[count] L{current.id}: says Seen {m[1]}× but lists {len(current.seen)}')
            continue
        raise LessonsError(f'line {n}: unexpected line in L{current.id}: {line[:60]!r}')
    for e in entries:
        e.end = _block_end(lines, e.at)
    sections_at = {name: (k, _block_end(lines, k) - 1) for name, k in sections_at.items()}
    if tuple(seen_sections) not in (SECTIONS, SECTIONS + (DIRS,)):
        raise LessonsError(f'sections must be exactly {" / ".join(SECTIONS)} in that order'
                           f' (optionally followed by {DIRS})')
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
    return Lessons(preamble, next_id, entries, seen_sections[-1:] == [DIRS], held,
                   marker_at=marker, held_at=-1 if held_line is None else held_line - 1,
                   sections_at=sections_at)


def _block_end(lines, at):
    """One past the last non-blank line from heading `at` up to the next heading of its level
    or above (an entry stops at `### ` or `## `, a section only at `## `). Only called on
    positions after next-id, where every non-blank line was parsed as heading or entry text."""
    stops = (lambda l: SECTION.match(l) or ENTRY.match(l)) if ENTRY.match(lines[at]) else SECTION.match
    end, k = at + 1, at + 1
    while k < len(lines) and not stops(lines[k]):
        if lines[k].strip():
            end = k + 1
        k += 1
    return end


def _split_sightings(text):
    """Split a Seen list on ` · `, but not inside the `[...]` directory list."""
    items, depth, start, i = [], 0, 0, 0
    while i < len(text):
        c = text[i]
        if c == '[':
            depth += 1
        elif c == ']':
            depth = max(depth - 1, 0)
        elif depth == 0 and text.startswith(' · ', i):
            items.append(text[start:i])
            i += 3
            start = i
            continue
        i += 1
    items.append(text[start:])
    return items


def split_directory_section(text):
    """(rest, section): the 目录经验 section cut out of the file, heading included.

    Same cut as `lessons_for_prompt` in scripts/_lib.sh: from the heading line to the
    next `## ` heading or the end of the file."""
    lines = text.split('\n')
    kept, cut, inside = [], [], False
    for line in lines:
        if line == DIR_HEADING:
            inside = True
        elif inside and line.startswith('## '):
            inside = False
        (cut if inside else kept).append(line)
    return '\n'.join(kept), '\n'.join(cut)


def with_directory_section(text):
    """The baseline with an empty 目录经验 section appended when it has none."""
    if DIR_HEADING in text.split('\n'):
        return text
    return text.rstrip('\n') + '\n\n' + DIR_HEADING + '\n'


def detach_directory_section(text):
    """(rest, reattach): `rest` is what the model may see; `reattach(new_rest)` puts the
    original section back unchanged, so `reattach(rest) == text` byte for byte."""
    rest, cut = split_directory_section(text)
    if DIR_HEADING not in text.split('\n'):
        return text, lambda new: new
    gap = rest[len(rest.rstrip('\n')):] + '\n'
    return rest, lambda new: new.rstrip('\n') + gap + cut


def outside_directory_text(text):
    """The whole file except 目录经验 — what the MAX_CHARS limit is measured on.

    Deliberately the full text, not the trimmed `prompt_text`: the retrospective model
    reads and rewrites all of it, so trimming what prompts get must not loosen this."""
    if DIR_HEADING not in text.split('\n'):
        return text
    rest = split_directory_section(text)[0].rstrip('\n')
    return rest + '\n' if rest else ''


# Appended after a trimmed counted-format file; same text as LESSONS_PROMPT_NOTE in _lib.sh.
PROMPT_NOTE = ('> 派工说明里只带上面这些：硬规则和待确认经验的编号、规则、适用、为什么。'
               '「观察中」的经验，以及每条的「这样做是对的」举例和 Seen 出现记录，'
               '只在本项目仓库的经验文件 `lessons.md` 里（项目 prompts 目录下），需要时自己去读。')
PROMPT_ENTRY = re.compile(r'^### L[0-9]+$')
PROMPT_DROP = re.compile(r'^- (这样做是对的：|Seen [0-9]+×:)')


def prompt_text(text):
    """What prompt composition injects for this file (GitHub#152, #208).

    Always drops 目录经验. A counted-format file (it has a `next-id` line) is also
    trimmed to what an agent must act on: the 观察中 section goes, and inside entries
    the 这样做是对的 / Seen lines go, and so does the held-over-limit line (GitHub#600);
    then PROMPT_NOTE says where the rest lives.
    Must equal `lessons_for_prompt` in scripts/_lib.sh byte for byte (a file needing
    neither is passed through untouched; otherwise trailing blank lines go)."""
    lines = text.split('\n')
    counted = any(NEXT_ID.match(line) for line in lines)
    if not counted and DIR_HEADING not in lines:
        return text
    out, blank, skip, in_entry = [], 0, False, False
    for line in lines:
        if line.startswith('## '):
            section, in_entry = line[3:], False
            skip = section == DIRS or (counted and section == WATCH)
        if skip:
            continue
        if counted and line.startswith(HELD_PREFIX):
            continue
        if PROMPT_ENTRY.match(line):
            in_entry = True
        if counted and in_entry and PROMPT_DROP.match(line):
            continue
        if line == '':
            blank += 1
            continue
        out.extend([''] * blank)
        blank = 0
        out.append(line)
    if counted:
        out += ['', PROMPT_NOTE]
    return '\n'.join(out) + '\n' if out else ''


def directory_problem(directory, root):
    """None when `directory` is a well-formed directory inside the checkout at `root`."""
    if not directory.endswith('/') or directory == '/':
        return 'must be a relative directory ending in /'
    if directory.startswith(('/', '~')) or '\\' in directory:
        return 'must be relative to the repository root'
    parts = directory[:-1].split('/')
    if any(p in ('', '.', '..') for p in parts):
        return 'may not contain empty, . or .. segments'
    if '.git' in parts:
        return 'may not point into .git'
    if root is None:
        return 'cannot be checked without the merged checkout'
    base = Path(root).resolve()
    target = (base / directory).resolve()
    if base not in target.parents or not target.is_dir():
        return 'is not a directory in the merged tree'
    return None


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


def validate(old_text, new_text, *, pr, evidence_urls, mode, repo_root=None, directories=None,
             max_chars=RULE_MAX_CHARS_DEFAULT):
    """Return a list of human-readable violations; empty means the rewrite is acceptable.

    `new_text` is what will be written — after `place` — so entries a promotion
    concerns must already sit where `promotion_plan` says, and the held-over-limit
    line must list exactly the ids it holds back.

    `repo_root` is the merged checkout new 目录经验 directories must exist in.
    `directories=False`: this run may not write 目录经验 — the section (heading
    included) must be byte-identical to the baseline's. Every other check applies
    either way; True / None add nothing."""
    if mode not in ('auto', 'confirm'):
        raise ValueError(f'unknown promotion mode {mode!r}')
    target = '硬规则' if mode == 'auto' else '待确认'
    old = parse(old_text)  # the baseline must already be valid; callers pre-check
    try:
        new = parse(new_text)
    except LessonsError as error:
        return [str(error) if str(error).startswith('[') else f'[parse] {error}']
    errors = []
    prompt_part, dir_part = outside_directory_text(new_text), split_directory_section(new_text)[1]
    if _on('length') and len(prompt_part) > MAX_CHARS:
        errors.append(f'[length] file has {len(prompt_part)} chars outside {DIRS}, limit {MAX_CHARS}')
    if _on('length') and len(dir_part) > MAX_DIR_CHARS:
        errors.append(f'[length] {DIRS} has {len(dir_part)} chars, limit {MAX_DIR_CHARS}')
    if _on('dir_section') and new.has_dirs and not old.has_dirs:
        errors.append(f'[dir_section] {DIRS} may only be started by a human edit')
    if (_on('dir_frozen') and directories is False
            and split_directory_section(new_text)[1] != split_directory_section(old_text)[1]):
        errors.append(f'[dir_frozen] {DIRS} must stay unchanged in this run')
    if _on('preamble') and new.preamble != old.preamble:
        errors.append('[preamble] preamble changed')
    old_ids, new_ids = old.by_id(), new.by_id()
    plan, _ = promotion_plan(old, new, max_chars)
    want_held = sorted(i for i, d in plan.items() if d == 'hold')
    if _on('held') and sorted(new.held) != want_held:
        errors.append(f'[held] held-over-limit line lists {sorted(new.held)}, must list {want_held}')
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
        errors += _check_directories(f'L{i}', after.section, appended, repo_root)
        if DIRS in (before.section, after.section):
            # Never promoted, never moved in or out: a hard rule must not leave the
            # prompt by being re-filed as a directory lesson.
            if _on('dir_section') and before.section != after.section:
                errors.append(f'[dir_section] L{i}: may not move {before.section} → {after.section}')
        elif _on('section'):
            decision = plan.get(i)
            if decision == 'promote' and after.section != target:
                errors.append(f'[section] L{i}: reached {THRESHOLD} sightings, must move to {target}')
            elif decision == 'hold' and after.section != WATCH:
                errors.append(f'[section] L{i}: {rule_chars(after)} chars over the limit {max_chars},'
                              f' must stay in {WATCH}')
            elif decision is None and before.section != after.section:
                errors.append(f'[section] L{i}: may not move {before.section} → {after.section}')
    claimed = {_meaning(e): e.id for e in old.entries}
    for i in added:
        entry = new_ids[i]
        if _on('dup_rule'):
            twin = claimed.get(_meaning(entry))
            if twin is not None:
                errors.append(f'[dup_rule] L{i}: same 规则/适用 as L{twin}; add this PR to L{twin} instead')
        claimed.setdefault(_meaning(entry), i)
        if _on('new_entry') and entry.seen_prs != [pr]:
            errors.append(f'[new_entry] L{i}: a new entry starts with exactly one sighting, this PR #{pr}')
        errors += _check_sightings(f'L{i}', entry.seen, pr, evidence_urls)
        errors += _check_directories(f'L{i}', entry.section, entry.seen, repo_root)
        if _on('section') and entry.section not in (WATCH, DIRS):
            errors.append(f'[section] L{i}: a new entry starts in {WATCH} (or {DIRS})')
    return errors


def _meaning(entry):
    return tuple(''.join(v.split()) if v else None for v in (entry.rule, entry.applies))


def _check_sightings(label, items, pr, urls):
    errors = []
    for number, url, _ in items:
        if _on('seen_pr') and number != pr:
            errors.append(f'[seen_pr] {label}: may only add this PR #{pr}, not #{number}')
        if _on('seen_url') and url not in urls:
            errors.append(f'[seen_url] {label}: sighting #{number} must link to a comment collected for this PR')
    return errors


def _check_directories(label, section, items, root):
    """New sightings in 目录经验 must name directories that exist in the merged tree."""
    if section != DIRS:
        return []
    errors = []
    for number, _, dirs in items:
        if not dirs:
            if _on('dir_required'):
                errors.append(f'[dir_required] {label}: sighting #{number} must name its directories [a/ · b/]')
            continue
        if _on('dir_valid'):
            for directory in dirs:
                problem = directory_problem(directory, root)
                if problem:
                    errors.append(f'[dir_valid] {label}: #{number} directory {directory!r} {problem}')
    return errors


# ── Promotion and its length limit (GitHub#600) ──────────────────────────────

def rule_chars(entry):
    """规则 + 适用 + 为什么, in characters (a CJK character is one), prefixes excluded."""
    return sum(len(v or '') for v in (entry.rule, entry.applies, entry.why))


def fits(entry, max_chars):
    return max_chars == 0 or rule_chars(entry) <= max_chars


def promotion_plan(old, new, max_chars):
    """({id: 'promote' | 'hold'}, {id: why dropped}) — the one place deciding promotions.

    An entry is up for promotion when it sat in 观察中 in the previous version, has at
    least THRESHOLD sightings now, and either just crossed THRESHOLD or is on the previous
    version's held-over-limit line. Up for promotion and within the limit → 'promote';
    over it → 'hold'. Held ids that do not qualify (gone, not in 观察中, fewer than
    THRESHOLD sightings — a human typing an id there cannot promote it) are dropped
    from the line, with the reason. An entry a human left in 观察中 with 3+ sightings
    and no held mark is not touched."""
    old_ids, new_ids = old.by_id(), new.by_id()
    plan, dropped = {}, {}
    for i, before in old_ids.items():
        after = new_ids.get(i)
        if after is None or before.section != WATCH:
            continue
        crossed = len(before.seen) < THRESHOLD <= len(after.seen)
        waiting = i in old.held and len(after.seen) >= THRESHOLD
        if crossed or waiting:
            plan[i] = 'promote' if fits(after, max_chars) else 'hold'
    for i in old.held:
        if i in plan:
            continue
        before, after = old_ids.get(i), new_ids.get(i)
        dropped[i] = ('no such entry' if before is None or after is None else
                      f'not in {WATCH}' if before.section != WATCH else
                      f'fewer than {THRESHOLD} sightings')
    return plan, dropped


def _move(text, entry_id, section):
    """`text` with entry `entry_id` moved to the end of `section`. Positions come from `parse`
    of this very text — never from searching for a heading (a `### L1` or `## 硬规则` quoted in
    the preamble is not the entry or the section)."""
    lines = text.split('\n')
    e = parse(text).by_id()[entry_id]
    block = lines[e.at:e.end]
    del lines[e.at:e.end]
    if 0 < e.at < len(lines) and not lines[e.at - 1].strip() and not lines[e.at].strip():
        del lines[e.at - 1]
    elif e.at == len(lines) and e.at > 0 and not lines[e.at - 1].strip():
        del lines[e.at - 1]
    text = '\n'.join(lines)
    last = parse(text).sections_at[section][1]
    lines[last + 1:last + 1] = [''] + block
    return '\n'.join(lines)


def place(old_text, new_text, *, mode, max_chars):
    """(text, summary): `new_text` with every entry up for promotion put where
    `promotion_plan` says and the held-over-limit line rewritten to the ids held back.

    Nothing else is touched, so a rewrite that already has everything in place (and
    holds nothing back) comes back byte for byte. A text that does not parse comes back
    unchanged for `validate` to reject. summary: {'held': [(id, chars)], 'still': [...],
    'late': [(id, chars)], 'dropped': [(id, reason)], 'target': section, 'max': max_chars}."""
    target = '硬规则' if mode == 'auto' else '待确认'
    summary = {'held': [], 'still': [], 'late': [], 'dropped': [], 'target': target, 'max': max_chars}
    try:
        old, new = parse(old_text), parse(new_text)
    except LessonsError:
        return new_text, summary
    plan, dropped = promotion_plan(old, new, max_chars)
    new_ids = new.by_id()
    text = new_text
    for i, decision in sorted(plan.items()):
        want = target if decision == 'promote' else WATCH
        if new_ids[i].section != want:
            text = _move(text, i, want)
        chars = (i, rule_chars(new_ids[i]))
        if decision == 'hold':
            summary['still' if i in old.held else 'held'].append(chars)
        elif i in old.held:
            summary['late'].append(chars)
    summary['dropped'] = sorted(dropped.items())
    held = sorted(i for i, d in plan.items() if d == 'hold')
    text = strip_held(text)
    if held:
        lines = text.split('\n')
        lines.insert(parse(text).marker_at + 1, HELD_PREFIX + ''.join(f' L{i}' for i in held) + ' -->')
        text = '\n'.join(lines)
    return (new_text if text == new_text else text), summary


def strip_held(text):
    """The lessons without the held-over-limit line — what the model is shown. Removes the
    one line `parse` found there (callers pass a text that parses); a text that does not
    parse is returned as it is."""
    try:
        at = parse(text).held_at
    except LessonsError:
        return text
    if at < 0:
        return text
    lines = text.split('\n')
    del lines[at]
    return '\n'.join(lines)


def has_held_line(text):
    """Whether a model output carries anything meant as the held-over-limit line."""
    return any(held_like(line) for line in text.split('\n'))


def summary_markdown(summary):
    """The fixed paragraph the runner appends to the report; '' when nothing concerns the limit."""
    if not any(summary[k] for k in ('held', 'still', 'late', 'dropped')):
        return ''
    target, limit = summary['target'], summary['max']
    limit_text = f'{limit} 字' if limit else '不限'
    out = ['## 程序附注：升档字数上限', '',
           f'本段由复盘程序追加，不是模型写的。经验升进「{target}」时，「规则」「适用」「为什么」三栏'
           f'合计不得超过上限（项目配置 `RETROSPECTIVE_RULE_MAX_CHARS`，当前 {limit_text}，按字符数，'
           '一个汉字算 1）；以本节为准，报告正文里关于这几条是否转正的说法若与本节不同，按本节。', '']
    for key, title in (('held', '本次挡下'), ('still', '继续等待')):
        for i, chars in summary[key]:
            out.append(f'- {title}：L{i}，{chars} 字，上限 {limit}，留在「观察中」')
    for i, chars in summary['late']:
        out.append(f'- 本次补升：L{i}，{chars} 字，已进「{target}」')
    reasons = {'no such entry': '找不到这一条', f'not in {WATCH}': '不在「观察中」',
               f'fewer than {THRESHOLD} sightings': f'出现不足 {THRESHOLD} 次'}
    for i, why in summary['dropped']:
        out.append(f'- 已从等待名单去掉的无效编号：L{i}（{reasons.get(why, why)}）')
    if summary['held'] or summary['still']:
        out += ['', '处理办法：人手把这条的「规则」「适用」「为什么」压到上限以内（改经验文件），'
                '或调高上限 / 改成 0（不限），下一次复盘会自动补升；想让它一直留在「观察中」，'
                '就从经验文件 next-id 下面那行 `<!-- held-over-limit: … -->` 里删掉它的编号'
                '（删到一个编号都不剩时，留下 `<!-- held-over-limit: -->` 或删掉整行都可以）。']
    return '\n'.join(out) + '\n'


def summary_log(summary):
    """One log line for the same facts; '' when nothing concerns the limit."""
    parts = []
    for key, word in (('held', 'held back'), ('still', 'still held'), ('late', 'promoted late')):
        if summary[key]:
            parts.append(word + ' ' + ' '.join(f'L{i}({c})' for i, c in summary[key]))
    if summary['dropped']:
        parts.append('dropped from the held line ' + ' '.join(f'L{i}({w})' for i, w in summary['dropped']))
    return f'rule length limit {summary["max"]}: ' + '; '.join(parts) if parts else ''
