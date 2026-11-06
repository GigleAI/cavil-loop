// "Has this start's first complete sync round been taken?" — the condition the background tests
// (test/tauri/background.spec.ts, test/mac/background.spec.ts) wait on before they put a label on
// GitHub (GitHub#186). Fixed record sequences in the shape the shell writes them
// (src-tauri/src/desktop.rs: one JSON object per line), so every ordering is staged exactly,
// including the moment between the summary notification and the badge that follows it, which the
// real app goes through too fast to hold. The real app runs the same function in those suites.

import { describe, expect, it } from 'vitest';
import { firstRoundBadge, inFrontAtFirstRound } from '../tauri/first-round';

const start = (hidden = false) => ({ op: 'start', hidden });
const badge = (count: number) => ({ op: 'badge', count });
const tick = { op: 'tick', visible: false };
const summary = (n: number) => ({ op: 'notify', id: '{"summary":0}', alert: { kind: 'summary', title: `${n} 条待处理`, body: '点开查看看板' }, result: { ok: true } });
const itemNote = (key: string) => ({ op: 'notify', id: key, alert: { kind: 'item', key, title: '待处理', body: '' }, result: { ok: true } });

describe('first complete round of this start', () => {
  it('only the start-up badge: not complete (the app clears the badge before any sync)', () => {
    // the start of the arm64 CI record of run 42186053781: the old wait took this as "first round"
    expect(firstRoundBadge([start(true), badge(0)])).toBeNull();
    expect(firstRoundBadge([start(true), badge(0), badge(0)])).toBeNull();
  });

  it('summary out, its badge not yet: not complete', () => {
    expect(firstRoundBadge([start(true), badge(0), badge(0), summary(1)])).toBeNull();
  });

  it('summary and the badge after it: complete, that badge is the base', () => {
    expect(firstRoundBadge([start(true), badge(0), badge(0), summary(1), badge(1)])).toBe(1);
    // later rounds do not move the base: it is the badge right after the summary
    expect(firstRoundBadge([start(true), badge(0), summary(1), badge(1), tick, badge(2)])).toBe(1);
  });

  it('a badge before the summary is not the base', () => {
    expect(firstRoundBadge([start(), badge(3), summary(1)])).toBeNull();
  });

  it('an item notification is not the summary', () => {
    // the x64 CI record of the same run: no summary (nothing was pending at start), so without the
    // item put on the label before the start there is no proof of the first round at all
    expect(firstRoundBadge([start(true), badge(0), badge(0), badge(0), tick, itemNote('gigleai/cavil-loop#137'), badge(1)])).toBeNull();
  });

  it("an earlier start's summary does not count for this start", () => {
    const first = [start(), badge(0), summary(1), badge(1), tick, badge(1)];
    const second = [start(true), badge(0)];
    expect(firstRoundBadge(first, 0)).toBe(1);
    expect(firstRoundBadge([...first, ...second], first.length)).toBeNull();
    expect(firstRoundBadge([...first, ...second, summary(1)], first.length)).toBeNull();
    expect(firstRoundBadge([...first, ...second, summary(1), badge(1)], first.length)).toBe(1);
  });

  // GitHub#185: the badge is the unread count, so the base depends on whether the window was in front
  it('in front at the first round: the last active / inactive before this start\'s summary decides', () => {
    expect(inFrontAtFirstRound([start(true), badge(0), summary(1), badge(1)])).toBe(false);
    expect(inFrontAtFirstRound([start(), { op: 'active' }, badge(0), summary(1), badge(0)])).toBe(true);
    expect(inFrontAtFirstRound([start(), { op: 'active' }, { op: 'inactive' }, summary(1), badge(1)])).toBe(false);
    // after the summary does not count; no summary yet = unknown
    expect(inFrontAtFirstRound([start(true), summary(1), { op: 'active' }, badge(0)])).toBe(false);
    expect(inFrontAtFirstRound([start(), { op: 'active' }, badge(0)])).toBeNull();
    // an earlier start's state does not carry over
    const first = [start(), { op: 'active' }, summary(1), badge(0)];
    expect(inFrontAtFirstRound([...first, start(true), summary(1), badge(1)], first.length)).toBe(false);
  });
});
