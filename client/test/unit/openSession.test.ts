// The one rule behind every late answer in the detail panel.
import { describe, expect, it } from 'vitest';
import { createOpenSession } from '../../src/renderer/openSession';

describe('detail panel: does a late answer still belong to this opening?', () => {
  it('an opening that ended rejects every answer it started, of every kind', () => {
    const first = createOpenSession();
    const checks = (['detail', 'options', 'preview', 'write'] as const).map((k) => first.begin(k));
    expect(checks.map((c) => c())).toEqual([true, true, true, true]);
    first.end();
    expect(checks.map((c) => c())).toEqual([false, false, false, false]);
    // going away and coming back to the same item is a new opening: the old answers stay rejected
    const again = createOpenSession();
    expect(again.begin('write')()).toBe(true);
    expect(checks.map((c) => c())).toEqual([false, false, false, false]);
  });

  it('within one opening a newer call of the same kind wins; other kinds are unaffected', () => {
    const s = createOpenSession();
    const read1 = s.begin('detail');
    const preview = s.begin('preview');
    const read2 = s.begin('detail');
    expect([read1(), read2(), preview()]).toEqual([false, true, true]);
    s.supersede('preview'); // the text changed after asking for a preview
    expect(preview()).toBe(false);
    expect(read2()).toBe(true);
  });
});
