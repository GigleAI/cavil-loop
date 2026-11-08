// GitHub#260: the PR's state at the bottom of the detail panel is four icons. The words are the
// ones the panel always printed; the colour is new and must never call a state "ok" that GitHub
// did not report as fine — an unknown or still-computing value is "pending", never green.

import { describe, expect, it } from 'vitest';
import { prStatusIcons } from '../../src/renderer/prStatus';
import { DEFAULT_VIEW, isValidView, normalizeView } from '../../src/shared/viewSettings';

const base = { mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE', checks: 'SUCCESS', reviewDecision: 'APPROVED' };
const tones = (pr: typeof base | Record<string, string | null>) => prStatusIcons(pr as typeof base).map((x) => `${x.key}=${x.tone}`).join(' ');

describe('PR state icons (GitHub#260)', () => {
  it('keeps the words the panel always said, in the same order', () => {
    expect(prStatusIcons(base).map((x) => x.text)).toEqual(['合并：可以合并', '冲突：没有冲突', '检查：全部通过', '评审：已批准']);
    expect(prStatusIcons({ ...base, checks: null, reviewDecision: null }).map((x) => x.text).slice(2)).toEqual(['检查：没有检查', '评审：无要求']);
    expect(prStatusIcons({ ...base, checks: 'PENDING' })[2].text).toBe('检查：进行中');
  });

  it('green only for what GitHub reports as fine', () => {
    expect(tones(base)).toBe('merge=ok conflict=ok checks=ok review=ok');
    expect(tones({ mergeStateStatus: 'DIRTY', mergeable: 'CONFLICTING', checks: 'FAILURE', reviewDecision: 'CHANGES_REQUESTED' })).toBe(
      'merge=bad conflict=bad checks=bad review=bad',
    );
    expect(tones({ mergeStateStatus: 'BLOCKED', mergeable: 'MERGEABLE', checks: 'ERROR', reviewDecision: 'REVIEW_REQUIRED' })).toBe(
      'merge=warn conflict=ok checks=bad review=warn',
    );
    for (const s of ['UNSTABLE', 'BEHIND', 'DRAFT']) expect(prStatusIcons({ ...base, mergeStateStatus: s })[0].tone).toBe('warn');
    expect(prStatusIcons({ ...base, mergeStateStatus: 'HAS_HOOKS' })[0].tone).toBe('ok');
  });

  it('still computing, waiting or a value never seen before is "pending", never ok', () => {
    expect(tones({ mergeStateStatus: 'UNKNOWN', mergeable: 'UNKNOWN', checks: 'PENDING', reviewDecision: 'APPROVED' })).toBe(
      'merge=pending conflict=pending checks=pending review=ok',
    );
    expect(prStatusIcons({ ...base, checks: 'EXPECTED' })[2].tone).toBe('pending');
    const odd = prStatusIcons({ mergeStateStatus: 'NEW_STATE', mergeable: 'MAYBE', checks: 'QUEUED', reviewDecision: 'SOMETHING' });
    expect(odd.map((x) => x.tone)).toEqual(['pending', 'pending', 'pending', 'pending']);
    // the raw value is shown, as before
    expect(odd.map((x) => x.text)).toEqual(['合并：NEW_STATE', '冲突：MAYBE', '检查：QUEUED', '评审：SOMETHING']);
    // a value that happens to be an Object.prototype name is not a table hit
    expect(prStatusIcons({ ...base, mergeStateStatus: 'toString' })[0]).toMatchObject({ tone: 'pending', text: '合并：toString' });
  });

  it('no checks / no review required is its own grey, not ok', () => {
    expect(tones({ ...base, checks: null, reviewDecision: null })).toBe('merge=ok conflict=ok checks=none review=none');
  });
});

describe('folded detail fields are remembered (GitHub#260)', () => {
  it('shown by default; older saved settings get the default; only a boolean is kept', () => {
    expect(DEFAULT_VIEW.detailFields).toBe(true);
    const old = { mode: 'status', swimlanes: true, selected: null, detailWidth: 720 };
    expect(normalizeView(old)).toMatchObject({ detailWidth: 720, detailFields: true });
    expect(normalizeView({ ...old, detailFields: false }).detailFields).toBe(false);
    for (const v of ['false', 0, null]) expect(normalizeView({ ...old, detailFields: v }).detailFields).toBe(true);
    expect(isValidView({ ...DEFAULT_VIEW, detailFields: false })).toBe(true);
    expect(isValidView({ ...DEFAULT_VIEW, detailFields: 'no' })).toBe(false);
  });
});
