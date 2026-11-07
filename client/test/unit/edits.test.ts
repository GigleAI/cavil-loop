// GitHub#229: changes shown before GitHub confirms them — the rules of one record
// (src/data/edits.ts), path by path as the approved design lists them (甲–庚),
// plus the overlay the views see. The controller side (stored, sent, read back,
// against the fake GitHub with the real back end) is in edits-controller.test.ts.

import { describe, expect, it } from 'vitest';
import {
  afterRestart,
  applyAnswer,
  applyRead,
  editStatus,
  fieldId,
  fieldValue,
  isEditRecord,
  markOf,
  markSent,
  overlayItem,
  startEdit,
  type EditField,
  type EditRecord,
  type EditValue,
} from '../../src/data/edits';
import type { Item, ProjectMeta } from '../../src/shared/types';
import { retryOutcome } from '../../src/app/controller';

const KEY = 'o/r#7';
const MS: EditField = { kind: 'milestone' };
const OBS = 1000;

function fresh(base: EditValue, field: EditField = MS): Omit<EditRecord, 'target' | 'targetReq' | 'reqs' | 'confirmedAt' | 'verified' | 'observeUntil' | 'failure' | 'github' | 'hold'> {
  return { id: fieldId(KEY, field), key: KEY, repo: 'o/r', number: 7, field, base };
}

/** one change: started, sent at `sentAt` */
function change(prev: EditRecord | null, value: EditValue, req: number, sentAt: number, base: EditValue = 'v1'): EditRecord {
  return markSent(startEdit(prev, fresh(base), value, req), req, sentAt);
}

const read = (r: EditRecord, issuedAt: number, receivedAt: number, value: EditValue, final = false) => applyRead(r, { issuedAt, receivedAt, value }, OBS, final);

describe('one record: what each answer and each read does', () => {
  it('saving → accepted (C = the answer) → a read sent after C shows the target → done', () => {
    let r = change(null, 'v3', 1, 10);
    expect(editStatus(r)).toBe('saving');
    r = applyAnswer(r, 1, 'accepted', 20);
    expect(r.confirmedAt).toBe(20);
    expect(editStatus(r)).toBe('verifying');
    expect(read(r, 21, 22, 'v3')).toBeNull();
  });

  it('rejected: not saved, with GitHub\'s reason; reads only update "GitHub now"', () => {
    let r = applyAnswer(change(null, 'v3', 1, 10), 1, 'rejected', 20, '422');
    expect(editStatus(r)).toBe('failed');
    expect(r.failure).toEqual({ kind: 'rejected', reason: '422' });
    expect(r.reqs).toEqual([]);
    r = read(r, 30, 31, 'v1')!;
    expect(r).not.toBeNull();
    expect(r.github).toEqual({ value: 'v1', at: 31 });
    expect(editStatus(r)).toBe('failed');
  });

  it('路径甲: v2 no answer → v3 accepted → read v3 (watched: v2 may land) → v2 lands → read v2 after C: not saved, maybe changed back', () => {
    let r = change(null, 'v2', 1, 10);
    r = applyAnswer(r, 1, 'unknown', 11);
    expect(editStatus(r)).toBe('unconfirmed');
    r = change(r, 'v3', 2, 12);
    r = applyAnswer(r, 2, 'accepted', 13);
    r = read(r, 14, 15, 'v3')!;
    expect(editStatus(r)).toBe('observing');
    expect(r.observeUntil).toBe(10 + OBS);
    r = read(r, 16, 17, 'v2')!;
    expect(editStatus(r)).toBe('failed');
    expect(r.failure).toEqual({ kind: 'regressed', value: 'v2' });
    expect(r.target).toBe('v3');
  });

  it('路径乙 (review round 3): both answers lost — a read sent after v3 went out that shows v3 is the confirmation; the watch then uses it', () => {
    let r = applyAnswer(change(null, 'v2', 1, 10), 1, 'unknown', 11);
    r = applyAnswer(change(r, 'v3', 2, 12), 2, 'unknown', 13);
    expect(editStatus(r)).toBe('unconfirmed');
    expect(r.confirmedAt).toBeNull();
    // a read sent before v3 went out says nothing
    expect(read(r, 11, 20, 'v3')).toEqual({ ...r, github: { value: 'v3', at: 20 } });
    r = read(r, 14, 21, 'v3')!;
    expect(r.confirmedAt).toBe(21);
    expect(editStatus(r)).toBe('observing');
    // a read sent before C (even one that lands later) is no evidence
    expect(editStatus(read(r, 15, 30, 'v2')!)).toBe('observing');
    // a read sent after C showing v2: the earlier change landed late
    r = read(r, 22, 31, 'v2')!;
    expect(editStatus(r)).toBe('failed');
    expect(r.failure).toEqual({ kind: 'regressed', value: 'v2' });
  });

  it('路径丙 (review round 2): a read sent before the write was accepted lands later with the old value — the new value stays', () => {
    let r = change(null, 'v3', 1, 10);
    r = applyAnswer(r, 1, 'accepted', 20);
    // the sync went out at 15 (after the request, before the answer), landed at 25 with v1
    const after = read(r, 15, 25, 'v1')!;
    expect(after).not.toBeNull();
    expect(editStatus(after)).toBe('verifying');
    expect(read(after, 26, 27, 'v3')).toBeNull();
  });

  it('路径丁: accepted, then somebody else changes it: a read sent after C with another value ends the record (GitHub wins)', () => {
    const r = applyAnswer(change(null, 'v3', 1, 10), 1, 'accepted', 20);
    expect(read(r, 21, 22, 'v5')).toBeNull();
  });

  it('路径戊: back to the value from before (v1 → v2 → v1, both unanswered) — reading v1 is no confirmation', () => {
    let r = applyAnswer(change(null, 'v2', 1, 10), 1, 'unknown', 11);
    r = applyAnswer(change(r, 'v1', 2, 12), 2, 'unknown', 13);
    const after = read(r, 14, 15, 'v1')!;
    expect(after.confirmedAt).toBeNull();
    expect(editStatus(after)).toBe('unconfirmed');
  });

  it('路径己: an accepted older change leaves the list when the target changes; its value read later is no confirmation of the new one', () => {
    let r = applyAnswer(change(null, 'v2', 1, 10), 1, 'accepted', 11);
    expect(r.confirmedAt).toBe(11);
    r = change(r, 'v3', 2, 12);
    expect(r.reqs.map((q) => q.id)).toEqual([2]);
    expect(r.confirmedAt).toBeNull();
    r = applyAnswer(r, 2, 'unknown', 13);
    const after = read(r, 14, 15, 'v2')!;
    expect(editStatus(after)).toBe('unconfirmed');
  });

  it('路径庚: restart — a waiting request has no answer any more, C and the watch are kept, nothing is queued to send again', () => {
    let r = applyAnswer(change(null, 'v2', 1, 10), 1, 'unknown', 11);
    r = applyAnswer(change(r, 'v3', 2, 12), 2, 'accepted', 13);
    r = read(r, 14, 15, 'v3')!;
    const waiting = change(null, 'v9', 5, 50);
    expect(editStatus(afterRestart(waiting))).toBe('unconfirmed');
    const queued = startEdit(null, fresh('v1'), 'v9', 6);
    expect(editStatus(afterRestart(queued))).toBe('failed');
    const kept = afterRestart(r);
    expect(kept.confirmedAt).toBe(r.confirmedAt);
    expect(kept.observeUntil).toBe(r.observeUntil);
    expect(editStatus(kept)).toBe('observing');
  });

  it('the watch ends: a read at / after its end that shows the target ends the record; the last re-read ends it whatever the stamps', () => {
    let r = applyAnswer(change(null, 'v2', 1, 10), 1, 'unknown', 11);
    r = applyAnswer(change(r, 'v3', 2, 12), 2, 'accepted', 13);
    r = read(r, 14, 15, 'v3')!;
    expect(editStatus(read(r, 16, 17, 'v3')!)).toBe('observing');
    expect(read(r, 16, 10 + OBS, 'v3')).toBeNull();
    expect(read(r, 16, 17, 'v3', true)).toBeNull();
  });

  it('an answer to a request the record no longer holds changes nothing', () => {
    const r = change(null, 'v3', 1, 10);
    expect(applyAnswer(r, 99, 'accepted', 20)).toBe(r);
  });

  it('a stored record is checked before use: a broken one is dropped, never guessed', () => {
    const r = change(null, 'v3', 1, 10);
    expect(isEditRecord(JSON.parse(JSON.stringify(r)))).toBe(true);
    expect(isEditRecord({ ...r, id: 'other' })).toBe(false);
    expect(isEditRecord({ ...r, reqs: [{ id: 'x' }] })).toBe(false);
    expect(isEditRecord(null)).toBe(false);
  });
});

describe('what the views see', () => {
  const project: ProjectMeta = {
    key: 'project:p',
    title: 'P',
    iterations: [{ id: 'it2', title: 'Iteration 2', startDate: '2026-11-02', duration: 7 }],
  } as unknown as ProjectMeta;
  const item: Item = {
    key: KEY,
    repo: 'o/r',
    number: 7,
    labels: [{ name: 'a', color: '111111' }],
    milestone: { title: 'v1', dueOn: null },
    projects: [{ projectKey: 'project:p', projectTitle: 'P', itemId: 'pi', iteration: null, status: 'Todo' }],
  } as unknown as Item;

  it('fieldValue reads each kind; a Project the copy is not from says nothing', () => {
    expect(fieldValue(item, { kind: 'label', label: 'a', color: '' })).toBe(true);
    expect(fieldValue(item, { kind: 'label', label: 'b', color: '' })).toBe(false);
    expect(fieldValue(item, MS)).toBe('v1');
    expect(fieldValue(item, { kind: 'status', projectKey: 'project:p' })).toBe('Todo');
    expect(fieldValue(item, { kind: 'iteration', projectKey: 'project:p' })).toBeNull();
    expect(fieldValue(item, { kind: 'status', projectKey: 'project:other' })).toBeUndefined();
  });

  it('on its way: the item shows the new values; not saved / not confirmed: GitHub\'s value stays, the mark says both', () => {
    const lab: EditField = { kind: 'label', label: 'b', color: '222222' };
    const it2: EditField = { kind: 'iteration', projectKey: 'project:p' };
    const addB = markSent(startEdit(null, { ...fresh(false, lab) }, true, 1), 1, 10);
    const iter = markSent(startEdit(null, { ...fresh(null, it2) }, 'it2', 2), 2, 10);
    const ms = applyAnswer(markSent(startEdit(null, fresh('v1'), 'v9', 3), 3, 10), 3, 'rejected', 11, '没有这个里程碑');
    const shown = overlayItem(item, [addB, iter, ms], [project]);
    expect(shown.labels.map((l) => l.name)).toEqual(['a', 'b']);
    expect(shown.projects[0].iteration?.title).toBe('Iteration 2');
    expect(shown.milestone?.title).toBe('v1');
    const m = shown.edits!.find((x) => x.field === 'milestone')!;
    expect(m.status).toBe('failed');
    expect(m.targetText).toBe('v9');
    expect(m.failure).toBe('没有这个里程碑');
    const withRead = markOf(read({ ...ms, failure: ms.failure }, 20, 21, 'v5')!, [project]);
    expect(withRead.github).toEqual({ text: 'v5', at: 21 });
    expect(withRead.changedByOthers).toBe(true);
  });
});

describe('the notice of a created issue after a retry of its boards (code review round 2)', () => {
  it('all joined and set → gone; a board missing, a field not set, or both → said, each in its words', () => {
    expect(retryOutcome(7, 0, null, [])).toBeNull();
    expect(retryOutcome(7, 1, '没权限', [])).toBe('issue #7 已建好，但还有 1 个看板没加进去（没权限）');
    expect(retryOutcome(7, 0, null, ['「A」（拒绝）'])).toBe('issue #7 已建好，但已加入看板但字段没设上 「A」（拒绝），请在详情里手动设置');
    const both = retryOutcome(7, 1, '没权限', ['「A」（拒绝）'])!;
    expect(both).toContain('还有 1 个看板没加进去');
    expect(both).toContain('字段没设上 「A」');
  });
});
