// GitHub#258: the rules for a board not ticked that takes a new issue in by itself — what is
// written, what is left to a person, what is unknown — and the dialog's lines for those boards.
// Inputs tell candidate implementations apart: an answer cut short vs a complete one without the
// board, a value vs empty, a workflow list without any auto-add entry vs one with it off.

import { describe, expect, it } from 'vitest';
import { autoAddSurelyOff, judgeWatch, readCreatedBoards, watchProblem } from '../../src/data/autoJoin';
import { previewCreate } from '../../src/data/groupPreset';
import type { GitHubClient } from '../../src/data/github';
import type { CreateWatch } from '../../src/shared/types';
import { iter, project } from './helpers';

const it25 = iter('Iteration 25', '2026-11-02');
const A = project('pa', 'A', [it25], ['Todo', 'In progress', 'Done']);
const B = project('pb', 'B', null, ['Todo', 'Done']);
const client = (answer: unknown | Error): GitHubClient =>
  ({
    graphql: async () => {
      if (answer instanceof Error) throw answer;
      return answer;
    },
  }) as unknown as GitHubClient;
const statusValue = (p: typeof A, name: string) => ({ __typename: 'ProjectV2ItemFieldSingleSelectValue', optionId: `opt-${name}`, name, field: { id: p.statusFieldId, name: 'Status' } });
const itemOn = (p: typeof A, values: unknown[], totalCount = values.length) => ({ id: `PVTI_${p.key}`, isArchived: false, project: { id: p.projectId }, fieldValues: { totalCount, nodes: values } });
const answer = (nodes: unknown[], totalCount = nodes.length) => ({ node: { projectItems: { totalCount, nodes } } });

describe('GitHub#258: one judgement for a board that holds the new issue', () => {
  const status: Pick<CreateWatch, 'iterationId' | 'status'> = { iterationId: null, status: 'In progress' };
  const m = (s: string | null, iteration: typeof it25 | null = null) => ({ projectKey: 'pa', projectTitle: 'A', itemId: 'x', iteration, status: s });
  it('empty → write; the group value → done; anything else → a person', () => {
    expect(judgeWatch(status, m(null))).toBe('write');
    expect(judgeWatch(status, m('In progress'))).toBe('done');
    expect(judgeWatch(status, m('Todo'))).toBe('human');
  });
  it('an iteration group looks at the iteration only (the status does not count)', () => {
    const w = { iterationId: it25.id, status: null };
    expect(judgeWatch(w, m('Todo'))).toBe('write');
    expect(judgeWatch(w, m(null, it25))).toBe('done');
    expect(judgeWatch(w, m(null, iter('Iteration 26', '2026-11-09')))).toBe('human');
  });
});

describe('GitHub#258: reading where the new issue is — cut short is unknown, never "not there" or "empty"', () => {
  it('on the board with its values; a board missing from a complete answer is absent', async () => {
    const r = await readCreatedBoards(client(answer([itemOn(A, [statusValue(A, 'Todo')])])), 'I_1', [A, B]);
    expect(r.get('pa')).toMatchObject({ state: 'on', itemId: 'PVTI_pa', membership: { status: 'Todo' } });
    expect(r.get('pb')).toEqual({ state: 'absent' });
  });
  it('more Project items than listed: a board not in the list is unknown', async () => {
    const r = await readCreatedBoards(client(answer([itemOn(A, [])], 51)), 'I_1', [A, B]);
    expect(r.get('pa')).toMatchObject({ state: 'on' });
    expect(r.get('pb')).toEqual({ state: 'unknown' });
  });
  it('more field values than listed: unknown, never "the field is empty"', async () => {
    const r = await readCreatedBoards(client(answer([itemOn(A, [], 101)])), 'I_1', [A]);
    expect(r.get('pa')).toEqual({ state: 'unknown' });
  });
  it('archived there: as good as not there', async () => {
    const r = await readCreatedBoards(client(answer([{ ...itemOn(A, []), isArchived: true }])), 'I_1', [A]);
    expect(r.get('pa')).toEqual({ state: 'absent' });
  });
  it('no issue, no list, or a failed read: throws (the caller counts it as a failed look)', async () => {
    await expect(readCreatedBoards(client({ node: null }), 'I_1', [A])).rejects.toThrow();
    await expect(readCreatedBoards(client({ node: { projectItems: { nodes: [] } } }), 'I_1', [A])).rejects.toThrow();
    await expect(readCreatedBoards(client(new Error('HTTP 502')), 'I_1', [A])).rejects.toThrow('HTTP 502');
  });
});

describe('GitHub#258: auto-add "surely off" only on a complete list that has auto-add entries, all off', () => {
  const wf = (nodes: { name: string; enabled: boolean }[], totalCount = nodes.length) => client({ node: { workflows: { totalCount, nodes } } });
  it('every auto-add entry off → off', async () => {
    expect(await autoAddSurelyOff(wf([{ name: 'Auto-add to project', enabled: false }, { name: 'Auto-add sub-issues to project', enabled: false }, { name: 'Item closed', enabled: true }]), A)).toBe(true);
  });
  it('one on → watched', async () => {
    expect(await autoAddSurelyOff(wf([{ name: 'Auto-add to project', enabled: false }, { name: 'Auto-add sub-issues to project', enabled: true }]), A)).toBe(false);
  });
  it('no auto-add entry by that name, a list cut short, or not readable → unknown (watched)', async () => {
    expect(await autoAddSurelyOff(wf([{ name: 'Item closed', enabled: false }]), A)).toBe(false);
    expect(await autoAddSurelyOff(wf([{ name: 'Auto-add to project', enabled: false }], 60), A)).toBe(false);
    expect(await autoAddSurelyOff(client(new Error('FORBIDDEN')), A)).toBe(false);
    expect(await autoAddSurelyOff(client({ node: null }), A)).toBe(false);
  });
});

describe('GitHub#258: the dialog — boards not ticked get a line and a watch entry', () => {
  it('status group: a board not ticked that has the status is watched; ticked boards are not watched again', () => {
    const p = previewCreate({ by: 'status', status: 'In progress' }, [], 'o/r', { state: 'loading' }, [A, B]);
    expect(p.plan?.watch).toEqual([{ projectKey: 'pa', iterationId: null, status: 'In progress', label: 'In progress' }]);
    expect(p.lines.filter((l) => l.target === 'pa')).toEqual([expect.objectContaining({ applies: true, text: expect.stringContaining('还空着，会补设 状态 = In progress') })]);
    // B has no such status: said, not watched
    expect(p.lines.filter((l) => l.target === 'pb')).toEqual([expect.objectContaining({ applies: false })]);
    const ticked = previewCreate({ by: 'status', status: 'In progress' }, [A], 'o/r', { state: 'loading' }, [A, B]);
    expect(ticked.plan?.watch).toBeUndefined();
    expect(ticked.plan?.projects).toEqual([{ projectKey: 'pa', iterationId: null, status: 'In progress' }]);
  });
  it('iteration group: by the same title and start date; a board this account cannot change is not watched', () => {
    const p = previewCreate({ by: 'iteration', title: 'Iteration 25', startDate: '2026-11-02' }, [], 'o/r', { state: 'loading' }, [A, B, { ...A, key: 'ro', title: 'RO', viewerCanUpdate: false }]);
    expect(p.plan?.watch).toEqual([{ projectKey: 'pa', iterationId: it25.id, status: null, label: 'Iteration 25' }]);
    expect(p.lines.find((l) => l.target === 'ro')).toMatchObject({ applies: false, text: expect.stringContaining('不能修改') });
    const other = previewCreate({ by: 'iteration', title: 'Iteration 25', startDate: '2026-11-09' }, [], 'o/r', { state: 'loading' }, [A]);
    expect(other.plan?.watch).toBeUndefined();
  });
  it('milestone / repository / no-value groups and the plain "new" button: nothing watched', () => {
    expect(previewCreate({ by: 'milestone', title: 'v1' }, [], 'o/r', { state: 'ok', milestones: [] }, [A]).plan?.watch).toBeUndefined();
    expect(previewCreate({ by: 'repo', repo: 'o/r' }, [], 'o/r', { state: 'loading' }, [A]).plan?.watch).toBeUndefined();
    expect(previewCreate({ by: 'none' }, [], 'o/r', { state: 'loading' }, [A]).plan?.watch).toBeUndefined();
  });
});

describe('GitHub#258: the notice words', () => {
  const w = (state: CreateWatch['state'], extra: Partial<CreateWatch> = {}): CreateWatch => ({ projectKey: 'pa', title: 'A', iterationId: null, status: 'In progress', label: 'In progress', state, writes: 0, epoch: 0, ...extra });
  it('a person decides / refused / not confirmed / not readable each say so; still running says nothing', () => {
    expect(watchProblem(w('human', { seen: 'Todo' }))).toBe('看板「A」自动收进了这条，状态是「Todo」，没有自动改成「In progress」');
    expect(watchProblem(w('failed', { reason: '没有权限' }))).toContain('没能把状态设成「In progress」（没有权限）');
    expect(watchProblem(w('unverified', { reason: 'HTTP 502' }))).toContain('没能确认最后是否保持');
    expect(watchProblem(w('unread', { reason: 'HTTP 502' }))).toContain('读不到这条在不在看板「A」上');
    expect(watchProblem(w('looking'))).toBeNull();
    expect(watchProblem(w('written'))).toBeNull();
  });
});
