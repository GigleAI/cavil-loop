// GitHub#214: a new issue from a table group's "+". What the dialog shows (and
// sends as the plan) for every kind of group, every "this Project has it /
// does not" mix and every state of the milestone list. Expected values are
// written from the rules (same name per Project; an iteration also the same
// start date; milestone: same title, an open one first; could not read ≠ none),
// not copied from the implementation's output.

import { describe, expect, it } from 'vitest';
import { defaultRepo, pickMilestone, previewCreate, type MilestoneRead } from '../../src/data/groupPreset';
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
    expect(presets('iteration')).toEqual({ 'Iteration 25': { by: 'iteration', title: 'Iteration 25', startDate: '2026-11-02' }, 无迭代: { by: 'none' } });
    expect(presets('status')).toEqual({ 'In progress': { by: 'status', status: 'In progress' }, 无状态: { by: 'none' } });
    expect(presets('milestone')).toEqual({ 'v1.2': { by: 'milestone', title: 'v1.2' }, 无里程碑: { by: 'none' } });
    expect(presets('repo')).toEqual({ 'o/r': { by: 'repo', repo: 'o/r' } });
  });
  it('an iteration group\'s value finds that iteration on the Project again', () => {
    const g = buildTable(items, [A], { ...DEFAULT_TABLE, groupBy: 'iteration' }, FIXTURE_TODAY).groups.find((x) => x.title === 'Iteration 25')!;
    expect(previewCreate(g.preset, [A], 'o/r', { state: 'loading' }).plan!.projects).toEqual([{ projectKey: 'pa', iterationId: it25.id, status: null }]);
  });
});
