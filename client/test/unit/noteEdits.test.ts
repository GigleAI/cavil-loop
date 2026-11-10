// GitHub#323: when the board's red bar counts its change as over — seen waiting first, then gone
// from an item that is on the board. Nothing else (a missing item, a resend in flight, a change
// never seen waiting) ends it.

import { describe, expect, it } from 'vitest';
import { noteEditOf, stepNoteEdits, type NoteEdit } from '../../src/renderer/noteEdits';
import type { EditMark } from '../../src/shared/types';
import { item } from './helpers';

const REPO = 'GigleAI/cavil-loop';
const key = (n: number) => `gigleai/cavil-loop#${n}`;
const mark = (id: string, status: EditMark['status']): EditMark => ({ id, field: 'label', label: 'Done', status, targetText: '加上「Done」', github: null, changedByOthers: false, failure: null } as EditMark);
const watchOf = (n: number): NoteEdit => noteEditOf({ kind: 'addLabel', key: key(n), label: 'Done' })!;

describe('stepNoteEdits', () => {
  it('seen waiting, then gone from a present item = over', () => {
    const w = watchOf(138);
    let s = stepNoteEdits([w], [item(REPO, 138, { edits: [mark(w.id, 'unconfirmed')] })]);
    expect(s).toMatchObject({ over: false, watch: [{ seen: true }] });
    s = stepNoteEdits(s.watch, [item(REPO, 138, { edits: [] })]);
    expect(s.over).toBe(true);
  });
  it('a "not saved" change counts as waiting too', () => {
    const w = watchOf(138);
    const s = stepNoteEdits([w], [item(REPO, 138, { edits: [mark(w.id, 'failed')] })]);
    expect(s.watch[0].seen).toBe(true);
    expect(stepNoteEdits(s.watch, [item(REPO, 138)]).over).toBe(true);
  });
  it('never seen waiting: gone is not over (the change may have finished before the bar looked)', () => {
    const w = watchOf(138);
    const s = stepNoteEdits([w], [item(REPO, 138, { edits: [] })]);
    expect(s.over).toBe(false);
    expect(s.watch[0].seen).toBe(false);
  });
  it('the item missing from the board (re-read, filtered out) is "can not tell": not over, and it is not over when the item comes back still waiting', () => {
    const w = watchOf(138);
    let s = stepNoteEdits([w], [item(REPO, 138, { edits: [mark(w.id, 'unconfirmed')] })]);
    s = stepNoteEdits(s.watch, []);
    expect(s.over).toBe(false);
    expect(s.watch[0].seen).toBe(true);
    s = stepNoteEdits(s.watch, [item(REPO, 137)]);
    expect(s.over).toBe(false);
    s = stepNoteEdits(s.watch, [item(REPO, 138, { edits: [mark(w.id, 'unconfirmed')] })]);
    expect(s.over).toBe(false);
    expect(stepNoteEdits(s.watch, [item(REPO, 138)]).over).toBe(true);
  });
  it('a resend in flight (saving / verifying / observing) is not over', () => {
    const w = watchOf(138);
    const s = stepNoteEdits([w], [item(REPO, 138, { edits: [mark(w.id, 'unconfirmed')] })]);
    for (const st of ['saving', 'verifying', 'observing'] as const) expect(stepNoteEdits(s.watch, [item(REPO, 138, { edits: [mark(w.id, st)] })]).over).toBe(false);
  });
  it('another change of the same item still waiting does not hold this one; only its own id counts', () => {
    const w = watchOf(138);
    const other = noteEditOf({ kind: 'setMilestone', key: key(138), title: 'v2' })!;
    expect(other.id).not.toBe(w.id);
    const s = stepNoteEdits([w], [item(REPO, 138, { edits: [mark(w.id, 'unconfirmed'), mark(other.id, 'unconfirmed')] })]);
    expect(stepNoteEdits(s.watch, [item(REPO, 138, { edits: [mark(other.id, 'unconfirmed')] })]).over).toBe(true);
  });
  it('several changes: over only when every one is over', () => {
    const a = watchOf(138);
    const b = watchOf(137);
    let s = stepNoteEdits([a, b], [item(REPO, 138, { edits: [mark(a.id, 'unconfirmed')] }), item(REPO, 137, { edits: [mark(b.id, 'failed')] })]);
    expect(s.watch.map((x) => x.seen)).toEqual([true, true]);
    s = stepNoteEdits(s.watch, [item(REPO, 138), item(REPO, 137, { edits: [mark(b.id, 'failed')] })]);
    expect(s.over).toBe(false);
    expect(stepNoteEdits(s.watch, [item(REPO, 138), item(REPO, 137)]).over).toBe(true);
  });
  it('an empty watch is never over; the same watch comes back when nothing changed (no re-render loop)', () => {
    expect(stepNoteEdits([], [item(REPO, 138)]).over).toBe(false);
    const w = { ...watchOf(138), seen: true };
    const list = [w];
    const s = stepNoteEdits(list, [item(REPO, 138, { edits: [mark(w.id, 'unconfirmed')] })]);
    expect(s.watch).toBe(list);
  });
  it('the label colour is not part of the id', () => {
    expect(noteEditOf({ kind: 'addLabel', key: key(1), label: 'x', color: 'ff0000' })!.id).toBe(noteEditOf({ kind: 'removeLabel', key: key(1), label: 'x' })!.id);
  });
});
