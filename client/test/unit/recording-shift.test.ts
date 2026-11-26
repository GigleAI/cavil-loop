// GitHub#572: the UI tests serve the recordings as of "now" (whole days moved), so a closed item
// recorded on 11-05 does not age out of the client's 14-day window with the calendar. The unit tests
// keep the recordings as recorded. These are the rules of that move, on the real recording files.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCavilProjectPages, loadCavilRepoIssues, loadRelationIssues, loadRelationPages, recordingShiftMs, shiftRecorded } from '../fake-github/server';
import { REPO_RECENT_DAYS } from '../../src/data/fetchSources';

const DAY = 86_400_000;
const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const raw = (f: string) => JSON.parse(readFileSync(join(fixtures, f), 'utf8'));
const ISSUES = raw('cavil-loop.issues.json');
const PAGES = raw('cavil-project-11.pages.json');
const recorded = Date.parse(ISSUES.recordedAt);

/** every [key, value] of a time-like string anywhere in `v`, in walk order */
function times(v: any, key: string | null = null, out: [string, string][] = []): [string, string][] {
  if (Array.isArray(v)) v.forEach((x) => times(x, null, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) times(x, k, out);
  else if (typeof v === 'string' && key && /^\d{4}-\d\d-\d\d/.test(v)) out.push([key, v]);
  return out;
}

describe('GitHub#572: recordings served as of a moment', () => {
  it('the offset is whole days and never puts the recording moment after `at`', () => {
    expect(recordingShiftMs(ISSUES.recordedAt, recorded)).toBe(0);
    expect(recordingShiftMs(ISSUES.recordedAt, recorded + DAY - 1)).toBe(0);
    expect(recordingShiftMs(ISSUES.recordedAt, recorded + DAY)).toBe(DAY);
    expect(recordingShiftMs(ISSUES.recordedAt, recorded + 56.5 * DAY)).toBe(56 * DAY);
    expect(recordingShiftMs(ISSUES.recordedAt, recorded - 1)).toBe(-DAY);
    for (const at of [recorded, recorded + 3.7 * DAY, recorded + 400.2 * DAY, recorded - 2.3 * DAY]) {
      const s = recordingShiftMs(ISSUES.recordedAt, at);
      expect(recorded + s).toBeLessThanOrEqual(at);
      expect(recorded + s).toBeGreaterThan(at - DAY);
    }
    expect(() => recordingShiftMs('not a time', recorded)).toThrow();
  });

  it('as recorded by default (what the unit tests read); as of a moment when asked', () => {
    expect(loadCavilRepoIssues()).toEqual(ISSUES.issues);
    expect(loadCavilProjectPages()).toEqual(PAGES.pages);
    expect(loadCavilRepoIssues(null)).toEqual(ISSUES.issues);
    expect(loadCavilRepoIssues(recorded + 0.5 * DAY)).toEqual(ISSUES.issues);
  });

  it('only item times move, all by the same whole days, written as recorded; board configuration stays', () => {
    const at = Date.UTC(2026, 11, 31, 12);
    const REL_ISSUES = raw('cavil-loop.relations.json');
    const REL_PAGES = raw('cavil-project-11.relations.json');
    for (const [file, before, after] of [
      [ISSUES, ISSUES.issues, loadCavilRepoIssues(at)],
      [PAGES, PAGES.pages, loadCavilProjectPages(at)],
      [REL_ISSUES, REL_ISSUES.issues, loadRelationIssues(at)],
      [REL_PAGES, REL_PAGES.pages, loadRelationPages(at)],
    ]) {
      // each recording by its own recording moment (the relation files were recorded on another day)
      const ms = recordingShiftMs(file.recordedAt, at);
      expect(ms % DAY).toBe(0);
      const b = times(before);
      const a = times(after);
      expect(a.map(([k]) => k)).toEqual(b.map(([k]) => k));
      let moved = 0;
      b.forEach(([k, v], i) => {
        if (k === 'startDate') return expect(a[i][1], k).toBe(v); // an iteration's start: board configuration
        expect(Date.parse(a[i][1]) - Date.parse(v), `${k} ${v}`).toBe(k.startsWith('updated') || k.startsWith('merged') || k.startsWith('created') || k.startsWith('closed') ? ms : 0);
        expect(a[i][1].length, `${k} keeps its format`).toBe(v.length);
        moved++;
      });
      expect(moved).toBeGreaterThan(0);
      // nothing else changed
      expect(shiftRecorded(after, -ms)).toEqual(before);
    }
  });

  it('the board and the repository recording of one moment move by the same offset (an item in both keeps which copy is newer)', () => {
    const at = Date.UTC(2027, 2, 3, 1);
    const updated = (issues: any[]) => new Map<number, number>(issues.map((i) => [i.number, Date.parse(i.updated_at)]));
    const repo = updated(loadCavilRepoIssues(at));
    const rawRepo = updated(ISSUES.issues);
    const board = loadCavilProjectPages(at).flatMap((pg) => pg.items.nodes);
    const rawBoard = PAGES.pages.flatMap((pg: any) => pg.items.nodes);
    let both = 0;
    board.forEach((n: any, i: number) => {
      const num = n.content?.number;
      if (!repo.has(num) || !n.content?.updatedAt) return;
      // the board copy and the repository copy stay exactly as far apart as recorded
      expect(Date.parse(n.content.updatedAt) - repo.get(num)!, `#${num}`).toBe(Date.parse(rawBoard[i].content.updatedAt) - rawRepo.get(num)!);
      both++;
    });
    expect(both).toBeGreaterThan(0);
  });

  // GitHub#718: the history read lists every item whatever its age; a regular full read still asks for
  // what changed in the last REPO_RECENT_DAYS days, and the shift keeps the recordings inside that window
  it('the real 14-day list: as of a later moment the closed #122 falls in it only when served as of that moment', () => {
    const at = Date.UTC(2026, 11, 31, 12);
    expect(REPO_RECENT_DAYS).toBe(14);
    const inWindow = (rec: any[]) => {
      const r = rec.find((i: any) => i.number === 122);
      expect(r.state).toBe('closed');
      return Date.parse(r.updated_at) >= at - REPO_RECENT_DAYS * 86_400_000;
    };
    expect(inWindow(loadCavilRepoIssues(at))).toBe(true);
    expect(inWindow(loadCavilRepoIssues(null))).toBe(false);
  });
});
