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
