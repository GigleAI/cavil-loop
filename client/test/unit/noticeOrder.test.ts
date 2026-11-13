// GitHub#488: the order of the window's notice area — newest on top, by when the window first saw each
// notice; notices already there at the start ordered by when they began. Expected values follow the rule
// on the issue ("新的在上"), not the implementation's output.
import { describe, expect, it } from 'vitest';
import { noticeOrder } from '../../src/renderer/noticeOrder';

describe('notice area order', () => {
  it('at the start: the one that began last is on top', () => {
    const seen = new Map<string, number>();
    const next = { n: 0 };
    expect(noticeOrder([{ id: 'op:b', order: 20 }, { id: 'op:a', order: 10 }, { id: 'edits', order: 30 }], seen, next)).toEqual(['edits', 'op:b', 'op:a']);
  });
  it('a notice that shows up later goes on top, whatever its own start time says', () => {
    const seen = new Map<string, number>();
    const next = { n: 0 };
    noticeOrder([{ id: 'op:a', order: 10 }, { id: 'edits', order: 99 }], seen, next);
    // an operation started before the unsaved change was noticed, but it appears now: it is the newest notice
    expect(noticeOrder([{ id: 'op:a', order: 10 }, { id: 'edits', order: 99 }, { id: 'op:c', order: 5 }], seen, next)).toEqual(['op:c', 'edits', 'op:a']);
  });
  it('a notice that keeps showing keeps its place; one that goes and comes back is new again', () => {
    const seen = new Map<string, number>();
    const next = { n: 0 };
    noticeOrder([{ id: 'edits', order: 1 }, { id: 'op:a', order: 2 }], seen, next);
    expect(noticeOrder([{ id: 'op:a', order: 2 }], seen, next)).toEqual(['op:a']);
    expect(noticeOrder([{ id: 'op:a', order: 2 }, { id: 'edits', order: 1 }], seen, next)).toEqual(['edits', 'op:a']);
  });
  it('the same list twice gives the same order (a re-render changes nothing)', () => {
    const seen = new Map<string, number>();
    const next = { n: 0 };
    const ids = [{ id: 'x', order: 3 }, { id: 'y', order: 1 }, { id: 'z', order: 2 }];
    const first = noticeOrder(ids, seen, next);
    expect(noticeOrder(ids, seen, next)).toEqual(first);
    expect(first).toEqual(['x', 'z', 'y']);
  });
});
