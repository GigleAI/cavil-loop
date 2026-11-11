// GitHub#372: the new-issue dialog's iteration and milestone pickers. One rule with a table group's
// "+": untouched pickers give exactly the plan the dialog gave before they existed (compared over
// every kind of group, board mix, milestone read and day); a picked value is planned exactly like a
// group of that value. Expected values are written from the rules, not copied from the output.

import { describe, expect, it } from 'vitest';
import {
  canPickIteration,
  defaultIterationPick,
  defaultMilestonePick,
  iterationChoices,
  iterationKey,
  milestoneChoices,
  previewCreate,
  previewCreateWith,
  shownLines,
  type MilestoneRead,
  type Picks,
} from '../../src/data/groupPreset';
import type { GroupPreset } from '../../src/shared/actions';
import { iter, project } from './helpers';

const TODAY = '2026-11-10';
const past = iter('Sprint 22', '2026-10-26', 14); // ended 11-08
const cur = iter('Sprint 23', '2026-11-09', 14); // 11-09 … 11-22
const next = iter('Sprint 24', '2026-11-23', 14);
const T = project('pt', 'Tutor', [past, cur, next], ['Todo', 'In progress']);
// the same iterations on another board, under that board's own ids
const U = project('pu', 'Loop', [{ ...cur, id: 'u-cur' }, { ...next, id: 'u-next' }], ['Todo', 'In progress']);
const ONLY_NEXT = project('pn', 'Later', [{ ...next, id: 'n-next' }]);
const NO_IT = project('pc', 'Plain', null, ['Todo', 'In progress']);
const LOCKED = { ...project('pl', 'Locked', [{ ...cur, id: 'l-cur' }]), viewerCanUpdate: false };
const OVER = project('po', 'Over', [{ ...cur, id: 'o-cur' }, iter('Hotfix', '2026-11-10', 3)]);
const ok = (milestones: { number: number; title: string; state: 'open' | 'closed' }[]): MilestoneRead => ({ state: 'ok', milestones: milestones.map((m) => ({ ...m, dueOn: null })) });
const READ = ok([{ number: 1, title: 'v1', state: 'open' }, { number: 2, title: 'v0', state: 'closed' }]);
const untouched: Picks = { iteration: null, milestone: null };
const with_ = (p: Partial<Picks>): Picks => ({ ...untouched, ...p });
const ids = (p: ReturnType<typeof previewCreate>) => p.plan?.projects.map((e) => [e.projectKey, e.iterationId, e.status]);

describe('untouched pickers: the same plan as before the pickers existed', () => {
  const presets: GroupPreset[] = [
    { by: 'none' },
    { by: 'none', field: 'iteration' },
    { by: 'none', field: 'status' },
    { by: 'none', field: 'milestone' },
    { by: 'repo', repo: 'o/r' },
    { by: 'status', status: 'In progress' },
    { by: 'status', status: 'Blocked' },
    { by: 'iteration', title: 'Sprint 23', startDate: '2026-11-09' },
    { by: 'iteration', title: 'Sprint 24', startDate: '2026-11-23' },
    { by: 'iteration', title: 'Gone', startDate: '2020-01-01' },
    { by: 'milestone', title: 'v1' },
    { by: 'milestone', title: 'v0' },
    { by: 'milestone', title: 'missing' },
  ];
  const tickedSets = [[], [T], [T, U], [NO_IT, LOCKED], [T, OVER], [ONLY_NEXT, NO_IT]];
  const reads: MilestoneRead[] = [{ state: 'loading' }, { state: 'error', error: 'HTTP 502' }, READ, ok([])];
  const othersSets = [[], [U, NO_IT, LOCKED], [ONLY_NEXT]];
  it('every group × ticked boards × milestone read × unticked boards × day', () => {
    let n = 0;
    for (const preset of presets)
      for (const ticked of tickedSets)
        for (const read of reads)
          for (const others of othersSets)
            for (const today of [TODAY, null]) {
              const want = previewCreate(preset, ticked, 'o/r', read, others, today);
              const got = previewCreateWith(preset, untouched, ticked, 'o/r', read, others, today);
              expect(got, JSON.stringify({ preset, ticked: ticked.map((p) => p.key), read: read.state, others: others.map((p) => p.key), today })).toEqual(want);
              // picking the value the picker already shows changes nothing either
              const same = previewCreateWith(preset, { iteration: defaultIterationPick(preset), milestone: defaultMilestonePick(preset) }, ticked, 'o/r', read, others, today);
              expect(same).toEqual(want);
              n++;
            }
    expect(n).toBe(presets.length * tickedSets.length * reads.length * othersSets.length * 2);
  });
  it('what the pickers show untouched', () => {
    expect(defaultIterationPick({ by: 'none' })).toEqual({ kind: 'auto' });
    expect(defaultIterationPick({ by: 'status', status: 'x' })).toEqual({ kind: 'auto' });
    expect(defaultIterationPick({ by: 'milestone', title: 'v1' })).toEqual({ kind: 'auto' });
    expect(defaultIterationPick({ by: 'none', field: 'iteration' })).toEqual({ kind: 'none' });
    expect(defaultIterationPick({ by: 'iteration', title: 'S', startDate: '2026-01-01' })).toEqual({ kind: 'set', title: 'S', startDate: '2026-01-01' });
    expect(defaultMilestonePick({ by: 'none' })).toEqual({ kind: 'none' });
    expect(defaultMilestonePick({ by: 'none', field: 'milestone' })).toEqual({ kind: 'none' });
    expect(defaultMilestonePick({ by: 'iteration', title: 'S', startDate: '2026-01-01' })).toEqual({ kind: 'none' });
    expect(defaultMilestonePick({ by: 'milestone', title: 'v1' })).toEqual({ kind: 'set', title: 'v1' });
  });
});

describe('a picked iteration', () => {
  const nextPick = with_({ iteration: { kind: 'set', title: 'Sprint 24', startDate: '2026-11-23' } });
  it('the plain "新建": that iteration on every ticked board that has it (by each board\'s own id), not the current one', () => {
    const p = previewCreateWith({ by: 'none' }, nextPick, [T, U, NO_IT], 'o/r', READ, [], TODAY);
    expect(ids(p)).toEqual([['pt', next.id, null], ['pu', 'u-next', null], ['pc', null, null]]);
    expect(p.plan?.milestone).toBeNull();
    expect(p.blocked).toBeNull();
    // the board without an iteration field is said, as for an iteration group
    expect(shownLines(p).map((l) => l.target)).toEqual(['pc']);
  });
  it('"不设迭代": no iteration anywhere, even where a current one exists', () => {
    const p = previewCreateWith({ by: 'none' }, with_({ iteration: { kind: 'none' } }), [T, U], 'o/r', READ, [], TODAY);
    expect(ids(p)).toEqual([['pt', null, null], ['pu', null, null]]);
  });
  it('"当前迭代" picked in an iteration group: the current one per board, the group\'s iteration dropped', () => {
    const p = previewCreateWith({ by: 'iteration', title: 'Sprint 24', startDate: '2026-11-23' }, with_({ iteration: { kind: 'auto' } }), [T, U], 'o/r', READ, [ONLY_NEXT], TODAY);
    expect(ids(p)).toEqual([['pt', cur.id, null], ['pu', 'u-cur', null]]);
    // the unticked board is no longer watched for the group's iteration
    expect(p.plan?.watch).toBeUndefined();
  });
  it('another iteration in an iteration group: set on the ticked boards only; unticked boards are not watched for it', () => {
    const group: GroupPreset = { by: 'iteration', title: 'Sprint 23', startDate: '2026-11-09' };
    // the group's own value watches the unticked board (GitHub#258) …
    expect(previewCreateWith(group, untouched, [T], 'o/r', READ, [U], TODAY).plan?.watch).toEqual([{ projectKey: 'pu', iterationId: 'u-cur', status: null, label: 'Sprint 23' }]);
    // … a different one picked by hand does not
    const p = previewCreateWith(group, nextPick, [T], 'o/r', READ, [U], TODAY);
    expect(ids(p)).toEqual([['pt', next.id, null]]);
    expect(p.plan?.watch).toBeUndefined();
  });
  it('a status group keeps its status next to the picked iteration (and its watch)', () => {
    const p = previewCreateWith({ by: 'status', status: 'In progress' }, nextPick, [T, NO_IT], 'o/r', READ, [U], TODAY);
    expect(ids(p)).toEqual([['pt', next.id, 'In progress'], ['pc', null, 'In progress']]);
    expect(p.plan?.watch).toEqual([{ projectKey: 'pu', iterationId: null, status: 'In progress', label: 'In progress' }]);
  });
  it('a milestone group keeps its milestone next to the picked iteration', () => {
    const p = previewCreateWith({ by: 'milestone', title: 'v1' }, nextPick, [T], 'o/r', READ, [], TODAY);
    expect(p.plan).toEqual({ milestone: { number: 1, title: 'v1' }, projects: [{ projectKey: 'pt', iterationId: next.id, status: null }] });
  });
});

describe('a picked milestone', () => {
  const v1 = with_({ milestone: { kind: 'set', title: 'v1' } });
  it('the plain "新建": that milestone, plus the current iteration as before', () => {
    const p = previewCreateWith({ by: 'none' }, v1, [T], 'o/r', READ, [], TODAY);
    expect(p.plan).toEqual({ milestone: { number: 1, title: 'v1' }, projects: [{ projectKey: 'pt', iterationId: cur.id, status: null }] });
  });
  it('the list still being read or unreadable: no plan, creating waits — "could not read" is never "none"', () => {
    for (const read of [{ state: 'loading' }, { state: 'error', error: 'HTTP 502' }] as MilestoneRead[]) {
      const p = previewCreateWith({ by: 'none' }, v1, [T], 'o/r', read, [], TODAY);
      expect(p.plan).toBeNull();
      expect(p.blocked).not.toBeNull();
    }
  });
  it('"不设里程碑" in a milestone group: no milestone, and an unreadable list no longer holds creating back', () => {
    const p = previewCreateWith({ by: 'milestone', title: 'v1' }, with_({ milestone: { kind: 'none' } }), [T], 'o/r', { state: 'error', error: 'HTTP 502' }, [], TODAY);
    expect(p.blocked).toBeNull();
    expect(p.plan).toEqual({ milestone: null, projects: [{ projectKey: 'pt', iterationId: cur.id, status: null }] });
  });
  it('both picked on a status group: all three land', () => {
    const p = previewCreateWith({ by: 'status', status: 'Todo' }, { milestone: { kind: 'set', title: 'v1' }, iteration: { kind: 'set', title: 'Sprint 24', startDate: '2026-11-23' } }, [T], 'o/r', READ, [], TODAY);
    expect(p.plan).toEqual({ milestone: { number: 1, title: 'v1' }, projects: [{ projectKey: 'pt', iterationId: next.id, status: 'Todo' }] });
  });
});

describe('what the pickers offer', () => {
  it('iterations: current and upcoming of the ticked boards that can take one, once per title + start date', () => {
    const got = iterationChoices([T, U, ONLY_NEXT, NO_IT, LOCKED], TODAY);
    expect(got.map((i) => [i.title, i.startDate])).toEqual([['Sprint 23', '2026-11-09'], ['Sprint 24', '2026-11-23']]);
    expect(got.map((i) => i.id)).toEqual([iterationKey(cur), iterationKey(next)]);
    // the ended one and a board this account cannot change are not offered
    expect(iterationChoices([LOCKED], TODAY)).toEqual([]);
    expect(iterationChoices([project('px', 'X', [past])], TODAY)).toEqual([]);
  });
  it('the iteration picker shows only when a ticked board can take an iteration', () => {
    expect(canPickIteration([])).toBe(false);
    expect(canPickIteration([NO_IT, LOCKED])).toBe(false);
    expect(canPickIteration([NO_IT, T])).toBe(true);
  });
  it('milestones: the open ones, once per title; nothing while reading or unreadable', () => {
    expect(milestoneChoices(ok([{ number: 1, title: 'v1', state: 'open' }, { number: 2, title: 'v0', state: 'closed' }, { number: 3, title: 'v1', state: 'open' }, { number: 4, title: 'v2', state: 'open' }]))).toEqual(['v1', 'v2']);
    expect(milestoneChoices({ state: 'loading' })).toEqual([]);
    expect(milestoneChoices({ state: 'error', error: 'x' })).toEqual([]);
  });
});
