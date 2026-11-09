// GitHub#214: a new issue from a table group's "+". What the dialog shows (and
// sends as the plan) for every kind of group, every "this Project has it /
// does not" mix and every state of the milestone list. Expected values are
// written from the rules (same name per Project; an iteration also the same
// start date; milestone: same title, an open one first; could not read ≠ none),
// not copied from the implementation's output.

import { describe, expect, it } from 'vitest';
import { defaultRepo, pickMilestone, previewCreate, shownLines, type MilestoneRead } from '../../src/data/groupPreset';
import { buildTable } from '../../src/data/table';
import { DEFAULT_TABLE } from '../../src/shared/viewSettings';
import type { GroupPreset } from '../../src/shared/actions';
import { FIXTURE_TODAY, item, iter, member, project } from './helpers';

const it25 = iter('Iteration 25', '2026-11-02');
const it25other = iter('Iteration 25', '2026-11-09'); // same name, another start date: another iteration
const A = project('pa', 'A', [it25], ['Todo', 'In progress', 'Done']);
const B = project('pb', 'B', [it25other], ['Todo', 'Done']);
const NO_IT = project('pc', 'C', null, ['Todo', 'In progress']);
const ok = (milestones: { number: number; title: string; state: 'open' | 'closed' }[]): MilestoneRead => ({
  state: 'ok',
  milestones: milestones.map((m) => ({ ...m, dueOn: null })),
});

describe('iteration and status: per Project, by that Project\'s own values', () => {
  const rows: [string, GroupPreset, typeof A[], { projectKey: string; iterationId: string | null; status: string | null }[], string[]][] = [
    ['iteration: both have it', { by: 'iteration', title: 'Iteration 25', startDate: '2026-11-02' }, [A, { ...A, key: 'pa2', title: 'A2' }],
      [{ projectKey: 'pa', iterationId: it25.id, status: null }, { projectKey: 'pa2', iterationId: it25.id, status: null }], ['yes', 'yes']],
    ['iteration: same name, other start date counts as missing', { by: 'iteration', title: 'Iteration 25', startDate: '2026-11-02' }, [A, B],
      [{ projectKey: 'pa', iterationId: it25.id, status: null }, { projectKey: 'pb', iterationId: null, status: null }], ['yes', 'no']],
    ['iteration: a Project without an iteration field', { by: 'iteration', title: 'Iteration 25', startDate: '2026-11-02' }, [NO_IT],
      [{ projectKey: 'pc', iterationId: null, status: null }], ['no']],
    ['status: one has it, one not', { by: 'status', status: 'In progress' }, [A, B],
      [{ projectKey: 'pa', iterationId: null, status: 'In progress' }, { projectKey: 'pb', iterationId: null, status: null }], ['yes', 'no']],
    ['status: neither has it', { by: 'status', status: 'Blocked' }, [A, NO_IT],
      [{ projectKey: 'pa', iterationId: null, status: null }, { projectKey: 'pc', iterationId: null, status: null }], ['no', 'no']],
    ['status: a Project this account cannot change', { by: 'status', status: 'Todo' }, [{ ...A, viewerCanUpdate: false }],
      [{ projectKey: 'pa', iterationId: null, status: null }], ['no']],
  ];
  for (const [name, preset, projects, plan, applies] of rows) {
    it(name, () => {
      const p = previewCreate(preset, projects, 'o/r', { state: 'loading' });
      // the milestone list does not matter here: never blocked on it
      expect(p.blocked).toBeNull();
      expect(p.plan).toEqual({ milestone: null, projects: plan });
      expect(p.lines.map((l) => [l.target, l.applies ? 'yes' : 'no'])).toEqual(projects.map((x, i) => [x.key, applies[i]]));
    });
  }

  it('no ticked Project: nothing to set, said so; still creatable', () => {
    const p = previewCreate({ by: 'status', status: 'Todo' }, [], 'o/r', { state: 'loading' });
    expect(p).toMatchObject({ plan: { milestone: null, projects: [] }, blocked: null });
    expect(p.lines).toEqual([expect.objectContaining({ target: 'group', applies: false })]);
  });
});

describe('milestone: the repository\'s, by title; could not read is never "none"', () => {
  const preset: GroupPreset = { by: 'milestone', title: 'v1.2' };
  const cases: [string, MilestoneRead, { number: number; title: string } | null | 'blocked'][] = [
    ['one open with that title', ok([{ number: 3, title: 'v1.2', state: 'open' }]), { number: 3, title: 'v1.2' }],
    ['only a closed one', ok([{ number: 4, title: 'v1.2', state: 'closed' }]), { number: 4, title: 'v1.2' }],
    ['closed and open with that title: the open one', ok([{ number: 4, title: 'v1.2', state: 'closed' }, { number: 7, title: 'v1.2', state: 'open' }]), { number: 7, title: 'v1.2' }],
    ['none with that title: explicitly none', ok([{ number: 3, title: 'v1.3', state: 'open' }]), null],
    ['empty list read fine: explicitly none', ok([]), null],
    ['still reading: no plan, blocked', { state: 'loading' }, 'blocked'],
    ['read failed: no plan, blocked (not "none")', { state: 'error', error: 'HTTP 502' }, 'blocked'],
  ];
  for (const [name, read, want] of cases) {
    it(name, () => {
      const p = previewCreate(preset, [A], 'o/r', read);
      if (want === 'blocked') {
        expect(p.plan).toBeNull();
        expect(p.blocked).not.toBeNull();
        expect(p.lines[0]).toMatchObject({ target: 'milestone', applies: false });
        return;
      }
      expect(p.blocked).toBeNull();
      expect(p.plan).toEqual({ milestone: want, projects: [{ projectKey: 'pa', iterationId: null, status: null }] });
      expect(p.lines[0]).toMatchObject({ target: 'milestone', applies: want !== null });
    });
  }

  it('the same rule as changing the milestone in the detail', () => {
    expect(pickMilestone([{ title: 'x', state: 'closed', n: 1 }, { title: 'x', state: 'open', n: 2 }], 'x')?.n).toBe(2);
    expect(pickMilestone([{ title: 'x', state: 'closed', n: 1 }], 'x')?.n).toBe(1);
    expect(pickMilestone([{ title: 'y', state: 'open', n: 1 }], 'x')).toBeNull();
  });
});

describe('repository and "no value" groups', () => {
  it('repository group: nothing on the Projects, no milestone', () => {
    const p = previewCreate({ by: 'repo', repo: 'o/r' }, [A], 'o/r', { state: 'loading' });
    expect(p).toMatchObject({ blocked: null, plan: { milestone: null, projects: [{ projectKey: 'pa', iterationId: null, status: null }] } });
  });
  it('"no value" group: nothing set (a plain new issue, still joins the ticked Projects)', () => {
    const p = previewCreate({ by: 'none' }, [A], 'o/r', { state: 'error', error: 'x' });
    expect(p).toMatchObject({ blocked: null, plan: { milestone: null, projects: [{ projectKey: 'pa', iterationId: null, status: null }] } });
  });
});

describe('which repository the dialog starts on', () => {
  const repos = ['a/one', 'b/two', 'c/three'];
  it('repository group: that repository (any case)', () => {
    expect(defaultRepo({ by: 'repo', repo: 'B/Two' }, [], repos)).toBe('b/two');
  });
  it('else the one most of the group is in; a tie goes to the first in the list', () => {
    const items = [item('c/three', 1), item('c/three', 2), item('b/two', 3)];
    expect(defaultRepo({ by: 'none' }, items, repos)).toBe('c/three');
    expect(defaultRepo({ by: 'none' }, [item('c/three', 1), item('b/two', 3)], repos)).toBe('b/two');
    // the same item twice (two rows of one item) counts once
    expect(defaultRepo({ by: 'none' }, [item('c/three', 1), item('c/three', 1), item('b/two', 3), item('b/two', 4)], repos)).toBe('b/two');
  });
  it('nothing known: the first repository', () => {
    expect(defaultRepo({ by: 'status', status: 'x' }, [item('z/other', 1)], repos)).toBe('a/one');
  });
});

describe('the table hands each group its value', () => {
  const items = [
    item('o/r', 1, { milestone: { title: 'v1.2', dueOn: null } }, [member(A, it25, 'In progress')]),
    item('o/r', 2, {}, [member(A, null, null)]),
  ];
  const presets = (groupBy: 'iteration' | 'status' | 'milestone' | 'repo') =>
    Object.fromEntries(buildTable(items, [A], { ...DEFAULT_TABLE, groupBy }, FIXTURE_TODAY).groups.map((g) => [g.title, g.preset]));
  it('iteration / status / milestone / repository, and the "no value" groups', () => {
    expect(presets('iteration')).toEqual({ 'Iteration 25': { by: 'iteration', title: 'Iteration 25', startDate: '2026-11-02' }, 无迭代: { by: 'none', field: 'iteration' } });
    expect(presets('status')).toEqual({ 'In progress': { by: 'status', status: 'In progress' }, 无状态: { by: 'none', field: 'status' } });
    expect(presets('milestone')).toEqual({ 'v1.2': { by: 'milestone', title: 'v1.2' }, 无里程碑: { by: 'none', field: 'milestone' } });
    expect(presets('repo')).toEqual({ 'o/r': { by: 'repo', repo: 'o/r' } });
  });
  it('an iteration group\'s value finds that iteration on the Project again', () => {
    const g = buildTable(items, [A], { ...DEFAULT_TABLE, groupBy: 'iteration' }, FIXTURE_TODAY).groups.find((x) => x.title === 'Iteration 25')!;
    expect(previewCreate(g.preset, [A], 'o/r', { state: 'loading' }).plan!.projects).toEqual([{ projectKey: 'pa', iterationId: it25.id, status: null }]);
  });
});

// GitHub#270: the dialog shows only what will NOT happen as the group says — expected texts are
// written from that rule (every case where a value lands says nothing; every value of a ticked
// board / the repository that cannot land is said; unticked boards are never announced).
describe('GitHub#270: what the dialog shows of a preview', () => {
  const shown = (p: ReturnType<typeof previewCreate>) => shownLines(p).map((l) => l.target);
  const S = { by: 'status', status: 'In progress' } as const;
  const IT = { by: 'iteration', title: 'Iteration 25', startDate: '2026-11-02' } as const;
  it('every ticked board takes the value: nothing shown (the title already says it)', () => {
    expect(shown(previewCreate(S, [A], 'o/r', { state: 'loading' }))).toEqual([]);
    expect(shown(previewCreate(IT, [A, { ...A, key: 'pa2', title: 'A2' }], 'o/r', { state: 'loading' }))).toEqual([]);
  });
  it('a ticked board without the value, or one this account cannot change: that board only', () => {
    expect(shown(previewCreate(S, [A, B], 'o/r', { state: 'loading' }))).toEqual(['pb']);
    expect(shown(previewCreate(IT, [A, NO_IT], 'o/r', { state: 'loading' }))).toEqual(['pc']);
    expect(shown(previewCreate(S, [{ ...A, viewerCanUpdate: false }], 'o/r', { state: 'loading' }))).toEqual(['pa']);
  });
  it('no board ticked: said once (the value goes nowhere)', () => {
    expect(shown(previewCreate(S, [], 'o/r', { state: 'loading' }))).toEqual(['group']);
  });
  it('unticked boards are never shown, whatever their line says; the plan still watches them', () => {
    const p = previewCreate(S, [A], 'o/r', { state: 'loading' }, [B, { ...A, key: 'pw', title: 'W' }, { ...A, key: 'ro', title: 'RO', viewerCanUpdate: false }]);
    expect(p.lines.filter((l) => l.target !== 'pa').length).toBe(3);
    expect(shown(p)).toEqual([]);
    expect(p.plan?.watch?.map((w) => w.projectKey)).toEqual(['pw']);
  });
  it('milestone: there → nothing; missing / still reading / unreadable → that line', () => {
    expect(shown(previewCreate({ by: 'milestone', title: 'v1' }, [], 'o/r', ok([{ number: 1, title: 'v1', state: 'open' }])))).toEqual([]);
    expect(shown(previewCreate({ by: 'milestone', title: 'v1' }, [], 'o/r', ok([])))).toEqual(['milestone']);
    const reading = previewCreate({ by: 'milestone', title: 'v1' }, [], 'o/r', { state: 'loading' });
    expect(shown(reading)).toEqual(['milestone']);
    expect(reading.blocked).not.toBeNull();
    expect(shown(previewCreate({ by: 'milestone', title: 'v1' }, [], 'o/r', { state: 'error', error: 'HTTP 502' }))).toEqual(['milestone']);
  });
  it('repository and "no value" groups: nothing shown', () => {
    expect(shown(previewCreate({ by: 'repo', repo: 'o/r' }, [A], 'o/r', { state: 'loading' }))).toEqual([]);
    expect(shown(previewCreate({ by: 'none' }, [A], 'o/r', { state: 'loading' }))).toEqual([]);
  });
});

// GitHub#276: a new issue gets, on every ticked board whose iteration is still empty, the iteration
// today falls in (start day included, start + duration excluded — the table's "当前" rule). Expected
// values are written from that rule: a set value says nothing, a board without one says nothing,
// two current at once is never guessed and is said; iteration / "no iteration" groups keep theirs;
// the unticked boards are never touched.
describe('GitHub#276: the current iteration on the ticked boards', () => {
  const TODAY = '2026-11-10';
  const cur = iter('Sprint 23', '2026-11-09', 14); // 11-09 … 11-22
  const past = iter('Sprint 22', '2026-10-26', 14); // ended 11-08
  const next = iter('Sprint 24', '2026-11-23', 14);
  const T = project('pt', 'Tutor', [past, cur, next], ['Todo', 'In progress']);
  const OVER = project('po', 'Over', [cur, iter('Hotfix', '2026-11-10', 3)]);
  const NONE_NOW = project('pn', 'Later', [next]);
  const plan = (preset: GroupPreset, projects: typeof T[], today: string | null = TODAY, read: MilestoneRead = { state: 'loading' }, others: typeof T[] = []) =>
    previewCreate(preset, projects, 'o/r', read, others, today);
  const ids = (p: ReturnType<typeof previewCreate>) => p.plan?.projects.map((e) => [e.projectKey, e.iterationId, e.status]);
  const shown = (p: ReturnType<typeof previewCreate>) => shownLines(p).map((l) => l.target);

  it('the plain "新建" (whole table): the one current iteration, nothing shown', () => {
    const p = plan({ by: 'none' }, [T]);
    expect(ids(p)).toEqual([['pt', cur.id, null]]);
    expect(shown(p)).toEqual([]);
  });
  it('the day boundaries: the start day counts, the day after the last day does not', () => {
    expect(ids(plan({ by: 'none' }, [T], '2026-11-09'))).toEqual([['pt', cur.id, null]]);
    expect(ids(plan({ by: 'none' }, [T], '2026-11-22'))).toEqual([['pt', cur.id, null]]);
    expect(ids(plan({ by: 'none' }, [T], '2026-11-23'))).toEqual([['pt', next.id, null]]);
    expect(ids(plan({ by: 'none' }, [project('px', 'X', [past])], '2026-11-09'))).toEqual([['px', null, null]]);
  });
  it('no iteration field, no current iteration, or a board this account cannot change: left empty, nothing shown', () => {
    const p = plan({ by: 'none' }, [NO_IT, NONE_NOW, { ...T, viewerCanUpdate: false }]);
    expect(ids(p)).toEqual([['pc', null, null], ['pn', null, null], ['pt', null, null]]);
    expect(shown(p)).toEqual([]);
  });
  it('two current at once: not guessed, that board said once', () => {
    const p = plan({ by: 'none' }, [T, OVER]);
    expect(ids(p)).toEqual([['pt', cur.id, null], ['po', null, null]]);
    expect(shown(p)).toEqual(['po:iteration']);
    expect(shownLines(p)[0].text).toContain('Over');
  });
  it('status / milestone / repository / "no status" / "no milestone" groups: their value plus the current iteration', () => {
    expect(ids(plan({ by: 'status', status: 'In progress' }, [T]))).toEqual([['pt', cur.id, 'In progress']]);
    const m = plan({ by: 'milestone', title: 'v1' }, [T], TODAY, ok([{ number: 1, title: 'v1', state: 'open' }]));
    expect(m.plan).toEqual({ milestone: { number: 1, title: 'v1' }, projects: [{ projectKey: 'pt', iterationId: cur.id, status: null }] });
    expect(ids(plan({ by: 'repo', repo: 'o/r' }, [T]))).toEqual([['pt', cur.id, null]]);
    expect(ids(plan({ by: 'none', field: 'status' }, [T]))).toEqual([['pt', cur.id, null]]);
    expect(ids(plan({ by: 'none', field: 'milestone' }, [T]))).toEqual([['pt', cur.id, null]]);
  });
  it('a status group on a board without that status: still the current iteration (only the status line shown)', () => {
    const p = plan({ by: 'status', status: 'Done' }, [T]);
    expect(ids(p)).toEqual([['pt', cur.id, null]]);
    expect(shown(p)).toEqual(['pt']);
  });
  it('an iteration group keeps its own; a "no iteration" group stays empty', () => {
    expect(ids(plan({ by: 'iteration', title: 'Sprint 24', startDate: '2026-11-23' }, [T]))).toEqual([['pt', next.id, null]]);
    // the group's iteration is not on this board: only joins (as before), never the current one instead
    expect(ids(plan({ by: 'iteration', title: 'Iteration 25', startDate: '2026-11-02' }, [T]))).toEqual([['pt', null, null]]);
    expect(ids(plan({ by: 'none', field: 'iteration' }, [T]))).toEqual([['pt', null, null]]);
  });
  it('a milestone list still being read: no plan at all, as before (nothing filled into nothing)', () => {
    expect(plan({ by: 'milestone', title: 'v1' }, [T]).plan).toBeNull();
  });
  it('the unticked boards: the watch is exactly what it was without this rule', () => {
    for (const preset of [{ by: 'status', status: 'In progress' }, { by: 'iteration', title: 'Sprint 23', startDate: '2026-11-09' }, { by: 'none' }] as GroupPreset[]) {
      const others = [T, OVER, NONE_NOW, NO_IT];
      const withRule = plan(preset, [A], TODAY, { state: 'loading' }, others);
      const without = plan(preset, [A], null, { state: 'loading' }, others);
      expect(withRule.plan?.watch).toEqual(without.plan?.watch);
      expect(withRule.lines.filter((l) => others.some((o) => l.target.startsWith(o.key)))).toEqual(without.lines.filter((l) => others.some((o) => l.target.startsWith(o.key))));
    }
    // the plain "新建" still watches nothing
    expect(plan({ by: 'none' }, [], TODAY, { state: 'loading' }, [T]).plan?.watch).toBeUndefined();
  });
});
