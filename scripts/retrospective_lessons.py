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
DIR_HEADING = f'## {DIRS}'

# Every check can be switched off by name (RETRO_LESSONS_DISABLE=a,b) so the
# test wrapper can prove each test case really depends on the check it names.
CHECKS = ('count', 'dup_pr', 'dup_id', 'preamble', 'next_id', 'keep_ids', 'locked',
          'seen_prefix', 'seen_pr', 'seen_url', 'new_entry', 'dup_rule', 'section', 'length',
          'dir_section', 'dir_required', 'dir_valid', 'dir_frozen',
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

    @property
    def seen_prs(self):
        return [pr for pr, _, _ in self.seen]


@dataclass
class Lessons:
    preamble: str
    next_id: int
    entries: list
    has_dirs: bool = False   # the file carries the optional 目录经验 section

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
            if m[1] not in SECTIONS + (DIRS,):
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
                current.seen.append((int(s[1]), s[2], dirs))
            if _on('count') and int(m[1]) != len(current.seen):
                raise LessonsError(f'[count] L{current.id}: says Seen {m[1]}× but lists {len(current.seen)}')
            continue
        raise LessonsError(f'line {n}: unexpected line in L{current.id}: {line[:60]!r}')
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
    return Lessons(preamble, next_id, entries, seen_sections[-1:] == [DIRS])


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
    the 这样做是对的 / Seen lines go; then PROMPT_NOTE says where the rest lives.
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


def validate(old_text, new_text, *, pr, evidence_urls, mode, repo_root=None, directories=None):
    """Return a list of human-readable violations; empty means the rewrite is acceptable.

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
        crossed = len(before.seen) < THRESHOLD <= len(after.seen)
        if DIRS in (before.section, after.section):
            # Never promoted, never moved in or out: a hard rule must not leave the
            # prompt by being re-filed as a directory lesson.
            if _on('dir_section') and before.section != after.section:
                errors.append(f'[dir_section] L{i}: may not move {before.section} → {after.section}')
        elif _on('section'):
            if before.section == after.section:
                if after.section == WATCH and crossed:
                    errors.append(f'[section] L{i}: reached {THRESHOLD} sightings, must move to {target}')
            elif not (before.section == WATCH and after.section == target and crossed):
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
