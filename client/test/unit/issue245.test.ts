// GitHub#245: the hand-over chosen in the new-issue dialog. The rules are one module shared by the
// dialog and the data layer; these pin them with inputs that tell candidate implementations apart
// (unknown vs missing, case, order, duplicates, an empty autopilot label).

import { describe, expect, it } from 'vitest';
import { checkHandoff, droppedLabels, handoffLabelNames, handoffProblem, mergeLabels, normalizeHandoff } from '../../src/shared/handoff';
import { DEFAULT_HAND_BACK } from '../../src/shared/types';

const hb = DEFAULT_HAND_BACK;
const ok = (names: string[]) => ({ state: 'ok' as const, names });

describe('GitHub#245: hand-over rules', () => {
  it('saved values: only the three known ones; anything else hands over nothing', () => {
    for (const v of ['none', 'agent', 'autopilot'] as const) expect(normalizeHandoff(v)).toBe(v);
    for (const v of [undefined, null, '', 'Agent', 'auto', 1, true, ['agent'], { h: 'agent' }]) expect(normalizeHandoff(v)).toBe('none');
  });

  it('labels by the names in Settings: autopilot first; no autopilot label = cannot autopilot', () => {
    expect(handoffLabelNames('none', hb)).toEqual([]);
    expect(handoffLabelNames('agent', hb)).toEqual(['pending/agent']);
    expect(handoffLabelNames('autopilot', hb)).toEqual(['autopilot', 'pending/agent']);
    const custom = { human: 'wait', agent: ' go ', autopilot: ' ship ', running: 'doing/agent', blocked: 'pending/blocked', later: 'pending/later' };
    expect(handoffLabelNames('autopilot', custom)).toEqual(['ship', 'go']);
    expect(handoffLabelNames('autopilot', { ...hb, autopilot: '  ' })).toBeNull();
    expect(handoffLabelNames('agent', { ...hb, autopilot: '' })).toEqual(['pending/agent']);
  });

  it('a list that cannot be read is unknown — never reported as "the repository has none"', () => {
    const err = checkHandoff('agent', hb, { state: 'error', error: 'HTTP 502' });
    expect(err).toEqual({ state: 'error', error: 'HTTP 502' });
    expect(handoffProblem('o/r', err)).toContain('读不到');
    expect(handoffProblem('o/r', err)).not.toContain('没有标签');
    expect(checkHandoff('autopilot', hb, { state: 'loading' })).toEqual({ state: 'loading' });
    // "none" needs no labels: usable whatever the read says
    expect(checkHandoff('none', hb, { state: 'error', error: 'x' })).toEqual({ state: 'ok', labels: [] });
    expect(checkHandoff('none', hb, { state: 'loading' })).toEqual({ state: 'ok', labels: [] });
  });

  it('read and missing: names exactly the missing ones; present ones take the repository\'s spelling', () => {
    const miss = checkHandoff('autopilot', hb, ok(['Pending/Agent', 'bug']));
    expect(miss).toEqual({ state: 'missing', missing: ['autopilot'] });
    expect(handoffProblem('o/r', miss)).toBe('仓库 o/r 没有标签「autopilot」');
    expect(checkHandoff('autopilot', hb, ok([]))).toEqual({ state: 'missing', missing: ['autopilot', 'pending/agent'] });
    expect(checkHandoff('autopilot', hb, ok(['AutoPilot', 'pending/AGENT']))).toEqual({ state: 'ok', labels: ['AutoPilot', 'pending/AGENT'] });
    expect(checkHandoff('autopilot', { ...hb, autopilot: '' }, ok(['autopilot', 'pending/agent']))).toEqual({ state: 'unset' });
  });

  it('merged labels: hand-over first, then the picked ones, one of each whatever the case', () => {
    expect(mergeLabels(['autopilot', 'pending/agent'], ['bug', 'Pending/Agent', 'bug'])).toEqual(['autopilot', 'pending/agent', 'bug']);
    expect(mergeLabels([], ['bug'])).toEqual(['bug']);
    expect(mergeLabels([], [])).toEqual([]);
  });

  it('dropped labels: the ones sent that the answer does not carry', () => {
    expect(droppedLabels(['autopilot', 'pending/agent', 'bug'], ['Bug'])).toEqual(['autopilot', 'pending/agent']);
    expect(droppedLabels(['bug'], ['bug'])).toEqual([]);
    expect(droppedLabels([], [])).toEqual([]);
  });
});
