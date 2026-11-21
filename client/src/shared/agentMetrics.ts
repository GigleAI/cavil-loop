// GitHub#503: the total time of one loop round, read from the usage record the
// loop appends to its comments (scripts/drivers/token-usage/comment_footer.py).
//
// Only the machine record counts, and only in the place the footer puts it: the
// last non-empty line of the markdown source, `<!-- agent-metrics … wall_secs=N … -->`
// — the same shape the weekly report accepts (scripts/weekly-report/record.py,
// RE_MARK). The visible text is never scanned for "耗时": a sentence describing
// some other duration would be read as one (the weekly report once read
// "某测试耗时 5054ms" as 5054 minutes). GitHub's rendered HTML drops comments,
// so the record can only come from the source.

import { outsideWords } from './i18n';

const RECORD = /^<!--\s*agent-metrics\s+(.*?)-->$/;

/**
 * The record's `wall_secs`, or undefined when the source has no record on its last
 * non-empty line, the field is missing or given twice, or its value is not a whole
 * number of seconds.
 */
export function wallSecsOf(source: unknown): number | undefined {
  if (typeof source !== 'string') return undefined;
  const lines = source.split(/\r\n|\r|\n/);
  let last = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim()) {
      last = lines[i].trim();
      break;
    }
  }
  const m = RECORD.exec(last);
  if (!m) return undefined;
  const values = m[1]
    .split(/\s+/)
    .filter((t) => t.startsWith('wall_secs='))
    .map((t) => t.slice('wall_secs='.length));
  if (values.length !== 1 || !/^\d+$/.test(values[0])) return undefined;
  const n = Number(values[0]);
  return Number.isSafeInteger(n) ? n : undefined;
}

/** The footer's own way of writing a duration (comment_footer.py fmt_dur): `1h 3m 15s`, `42m 7s`, `9s`. */
export function formatDuration(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h) return `${h}h ${m}m ${r}s`;
  if (m) return `${m}m ${r}s`;
  return `${r}s`;
}

// Where the footer starts in GitHub's HTML: its summary fold (GitHub#90 on) or, in the
// GitHub#88 layout comments still carry, a paragraph starting with the same words.
// The footer's first word is the daemon's own (it writes in one language), never the window's.
const FOOTER_WORD = outsideWords('耗时：');
const FOOTER_START = new RegExp(`<details\\b[^>]*>\\s*<summary\\b[^>]*>\\s*⏱️\\s*${FOOTER_WORD}|<p\\b[^>]*>\\s*⏱️\\s*${FOOTER_WORD}`, 'g');

/**
 * GitHub's HTML of a comment without its usage footer (for the one-line preview): cut at
 * the last place the footer can start, with the rule above it. Only called for an entry
 * whose source carries the record; HTML with no such start comes back as it is.
 */
export function withoutFooter(html: string): string {
  let at = -1;
  for (const m of html.matchAll(FOOTER_START)) at = m.index;
  if (at < 0) return html;
  return html.slice(0, at).replace(/\s*<hr\b[^>]*>\s*$/i, '');
}

// GitHub#651: a loop "round log" comment (scripts/round_log.py) holds one section per delivery /
// review, each ending with its own usage record, so the comment's last line is a section-end
// marker and `wallSecsOf` finds nothing. The sections are cut by the same marker rules as
// round_log.py's `parse_record` (pairs, positions, a second current version, an unclosed last
// section → unreadable: the caller shows the entry as before); a section id given twice counts
// once, the first copy kept — what round_log.units keeps within one comment. Each section's time
// is read with `wallSecsOf` on its own body; its title is the fold line round_log.py writes in
// front of it (that line is generated only there; the client reads it, never re-derives it).
// tests: client/test/unit/agent-metrics.test.ts runs the real round_log.py on the same records.

const RL_HEAD = '<!-- cavil-round-log:v1 -->';
const RL_TOP = /^<!-- cavil-round-log:top sec=([0-9a-f]{6,32}) -->$/;
const RL_TOP_END = '<!-- cavil-round-log:top-end -->';
const RL_SEC = /^<!-- cavil-round-log:sec id=([0-9a-f]{6,32}) role=(worker|review) at=([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z) after=([0-9]+) of=([0-9a-f]{6,32}|-) -->$/;
const RL_SEC_END = '<!-- cavil-round-log:sec-end -->';
const RL_ANY = /^\s*<!-- cavil-round-log:/;
const RL_TITLE = /^<details><summary>(⏱️ .*)<\/summary>$/;

export interface RoundLogSection {
  sec: string;
  role: 'worker' | 'review';
  at: string;
  after: number;
  idx: number;
  /** the usage record's seconds; absent when the section has no valid record */
  wallSecs?: number;
  /** the fold title round_log.py wrote in front of the section (unescaped); absent for older sections */
  title?: string;
}

export interface RoundLog {
  sections: RoundLogSection[];
  workers: number;
  reviews: number;
  /** sections without a usage record (their time is not in `total`) */
  missing: number;
  /** sum of the known times; absent when no section has one */
  total?: number;
  /** the last section's title without its time part ("✅ …"), when that section has a title */
  latest?: string;
}

/** Does the source open with the round-log header (readable or not)? Such a comment never shows a single footer's time. */
export function isRoundLog(source: unknown): boolean {
  return typeof source === 'string' && source.replace(/\r\n/g, '\n').split('\n')[0].trim() === RL_HEAD;
}

const unesc = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** The sections of a round log, in round_log.py's order; undefined when the source is not one or cannot be read. */
export function roundLogSections(source: unknown): RoundLogSection[] | undefined {
  if (typeof source !== 'string') return undefined;
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  if (!lines.length || lines[0].trim() !== RL_HEAD) return undefined;
  const secs: (RoundLogSection & { body: string })[] = [];
  let mode: 'top' | 'sec' | null = null;
  let hasTop = false;
  let cur: (RoundLogSection & { body: string }) | null = null;
  let buf: string[] = [];
  let prev: string[] = [];
  for (const ln of lines.slice(1)) {
    const s = ln.replace(/\s+$/, '');
    if (mode === null) {
      prev = [...prev, s].slice(-3);
      if (RL_TOP.test(s)) {
        if (hasTop) return undefined;
        mode = 'top';
        buf = [];
        continue;
      }
      const m = RL_SEC.exec(s);
      if (m) {
        mode = 'sec';
        buf = [];
        const t = prev.length === 3 && prev[1] === '' ? RL_TITLE.exec(prev[0]) : null;
        cur = { sec: m[1], role: m[2] as 'worker' | 'review', at: m[3], after: Number(m[4]), idx: secs.length, body: '', ...(t ? { title: unesc(t[1]) } : {}) };
        continue;
      }
      if (RL_ANY.test(s)) return undefined;
      continue;
    }
    if (mode === 'top' && s === RL_TOP_END) {
      hasTop = true;
      mode = null;
      continue;
    }
    if (mode === 'sec' && s === RL_SEC_END && cur) {
      cur.body = buf.join('\n');
      secs.push(cur);
      cur = null;
      mode = null;
      continue;
    }
    if (RL_ANY.test(s)) return undefined;
    buf.push(ln);
  }
  if (mode !== null) return undefined;
  const seen = new Set<string>();
  const kept = secs.filter((x) => (seen.has(x.sec) ? false : (seen.add(x.sec), true)));
  kept.sort((a, b) => a.after - b.after || (a.at < b.at ? -1 : a.at > b.at ? 1 : 0) || a.idx - b.idx);
  return kept.map(({ body, ...x }) => {
    const w = wallSecsOf(body);
    return w === undefined ? x : { ...x, wallSecs: w };
  });
}

// the role word is the daemon's own (round_log.py writes in one language), never the window's
const TITLE_PARTS = new RegExp(`^⏱️ [^·]+ · (?:worker|${outsideWords('复审')}) · (.*)$`);

/** The fold title without its "⏱️ <time> · <role> · " part. */
export function titleSentence(title: string): string {
  const m = TITLE_PARTS.exec(title);
  return m ? m[1] : title;
}

/** What the folded line of a round-log comment shows; undefined when the source is not a readable round log. */
export function roundLogOf(source: unknown): RoundLog | undefined {
  const sections = roundLogSections(source);
  if (!sections) return undefined;
  const known = sections.filter((s) => s.wallSecs !== undefined);
  const last = sections[sections.length - 1];
  return {
    sections,
    workers: sections.filter((s) => s.role === 'worker').length,
    reviews: sections.filter((s) => s.role === 'review').length,
    missing: sections.length - known.length,
    ...(known.length ? { total: known.reduce((n, s) => n + s.wallSecs!, 0) } : {}),
    ...(last?.title !== undefined ? { latest: titleSentence(last.title) } : {}),
  };
}
