// GitHub#559: labels a button needs that the repository lacks — created by the client, or what to create
// by hand. These pin the shared rules with inputs that tell candidate implementations apart: "cannot
// read" vs "no", "already there" vs "refused", no answer vs refusal, one repository vs another.

import { describe, expect, it } from 'vitest';
import { checkHandoff, missingHandoffLabels } from '../../src/shared/handoff';
import { LABEL_DEFAULTS, jobFor, labelBoxState, labelJobOutcome, labelListText, labelSpecs, labelsPageUrl, permissionOf, roleOf, type LabelJob } from '../../src/shared/labelSetup';
import { DEFAULT_HAND_BACK } from '../../src/shared/types';

const hb = DEFAULT_HAND_BACK;
const job = (id: number, repo: string, status: LabelJob['status'], extra: Partial<LabelJob> = {}): LabelJob => ({ id, repo, labels: labelSpecs([{ name: 'pending/agent', role: 'agent' }]), status, error: null, startedAt: id, ...extra });

describe('GitHub#559: which labels, with what', () => {
  it('each name once (any case), in the order given, with the colour and description of its part', () => {
    const s = labelSpecs([
      { name: 'autopilot', role: 'autopilot' },
      { name: ' pending/agent ', role: 'agent' },
      { name: 'Pending/Agent', role: 'agent' },
      { name: '', role: 'human' },
      { name: 'x', role: 'nope' as never },
    ]);
    expect(s.map((x) => [x.name, x.role, x.color])).toEqual([
      ['autopilot', 'autopilot', 'ff401e'],
      ['pending/agent', 'agent', 'd4c5f9'],
    ]);
    expect(s[1].description).toBe('等待 agent 处理');
  });

  it('a renamed label keeps the colour of its part, and its own name', () => {
    const named = { ...hb, agent: 'todo/bot', autopilot: 'Auto' };
    expect(roleOf('TODO/bot', named)).toBe('agent');
    expect(roleOf('auto', named)).toBe('autopilot');
    expect(roleOf('pending/agent', named)).toBe(null);
    expect(labelSpecs([{ name: 'todo/bot', role: 'agent' }])[0]).toMatchObject({ name: 'todo/bot', color: LABEL_DEFAULTS.agent.color });
  });

  it('only labels the repository was read without: "could not read" and "still reading" offer nothing', () => {
    const read = { state: 'ok' as const, names: ['bug', 'PENDING/AGENT'] };
    const checks = [checkHandoff('agent', hb, read), checkHandoff('autopilot', hb, read)];
    expect(missingHandoffLabels(checks, hb)).toEqual([{ name: 'autopilot', role: 'autopilot' }]);
    const none = { state: 'ok' as const, names: [] };
    expect(missingHandoffLabels([checkHandoff('agent', hb, none), checkHandoff('autopilot', hb, none)], hb)).toEqual([
      { name: 'pending/agent', role: 'agent' },
      { name: 'autopilot', role: 'autopilot' },
    ]);
    for (const r of [{ state: 'error' as const, error: 'x' }, { state: 'loading' as const }]) expect(missingHandoffLabels([checkHandoff('agent', hb, r), checkHandoff('autopilot', hb, r)], hb)).toEqual([]);
  });
});

describe('GitHub#559: may the account create labels', () => {
  it('push, maintain or admin = yes; all said and none true = no; anything else = unknown', () => {
    expect(permissionOf({ permissions: { admin: false, maintain: false, push: true, pull: true } })).toBe('yes');
    expect(permissionOf({ permissions: { admin: true, push: false } })).toBe('yes');
    expect(permissionOf({ permissions: { admin: false, maintain: true, push: false } })).toBe('yes');
    expect(permissionOf({ permissions: { admin: false, maintain: false, push: false, triage: true, pull: true } })).toBe('no');
    expect(permissionOf({ permissions: { admin: false, push: false } })).toBe('no');
    for (const v of [null, undefined, {}, { permissions: null }, { permissions: {} }, { permissions: { push: false } }, { permissions: { admin: 'no', push: false } }, 'x']) expect(permissionOf(v)).toBe('unknown');
  });
});

describe('GitHub#559: what one press came to', () => {
  it('made, or found by the read afterwards (any case) = there', () => {
    expect(labelJobOutcome([{ name: 'a', outcome: 'made' }], null)).toEqual({ status: 'done', error: null });
    // 422 "already there": the read finds it
    expect(labelJobOutcome([{ name: 'A', outcome: 'refused', error: '422' }], ['a'])).toEqual({ status: 'done', error: null });
    // no answer, and the read finds it: it landed
    expect(labelJobOutcome([{ name: 'a', outcome: 'noAnswer', error: 'net' }], ['a'])).toEqual({ status: 'done', error: null });
  });
  it('not there: no answer for any = unknown (it may still land), else refused', () => {
    expect(labelJobOutcome([{ name: 'a', outcome: 'refused', error: '403' }, { name: 'b', outcome: 'noAnswer', error: 'net' }], [])).toEqual({ status: 'unknown', error: 'net' });
    expect(labelJobOutcome([{ name: 'a', outcome: 'made' }, { name: 'b', outcome: 'refused', error: '403' }], ['x'])).toEqual({ status: 'refused', error: '403' });
    // the read afterwards failed: a refusal is not taken for "there"
    expect(labelJobOutcome([{ name: 'a', outcome: 'refused', error: '422' }], null)).toEqual({ status: 'refused', error: '422' });
    expect(labelJobOutcome([{ name: 'a', outcome: 'noAnswer', error: 'net' }], null)).toEqual({ status: 'unknown', error: 'net' });
  });
});

describe('GitHub#559: what a dialog shows, for the repository it shows', () => {
  it('the newest press of that repository only (any case)', () => {
    const jobs = [job(1, 'o/A', 'refused'), job(2, 'o/b', 'running'), job(3, 'O/a', 'done')];
    expect(jobFor(jobs, 'o/a')?.id).toBe(3);
    expect(jobFor(jobs, 'o/b')?.id).toBe(2);
    expect(jobFor(jobs, 'o/c')).toBe(null);
  });
  it('running > refused > no permission > the button', () => {
    expect(labelBoxState('no', job(1, 'o/a', 'running'))).toEqual({ kind: 'running' });
    expect(labelBoxState('yes', job(1, 'o/a', 'refused', { error: 'nope', app: true }))).toEqual({ kind: 'guide', why: 'refused', error: 'nope', app: true });
    expect(labelBoxState('no', null)).toEqual({ kind: 'guide', why: 'noPermission', error: null, app: false });
    expect(labelBoxState('no', job(1, 'o/a', 'done'))).toEqual({ kind: 'guide', why: 'noPermission', error: null, app: false });
    // not known: the button (a refused create changes nothing)
    expect(labelBoxState('unknown', null)).toEqual({ kind: 'create' });
    expect(labelBoxState('yes', job(1, 'o/a', 'unknown'))).toEqual({ kind: 'create' });
  });
  it('the labels page and the list to copy', () => {
    expect(labelsPageUrl('https://github.com/', 'o/r')).toBe('https://github.com/o/r/labels');
    expect(labelListText(labelSpecs([{ name: 'pending/agent', role: 'agent' }, { name: 'autopilot', role: 'autopilot' }]))).toBe(`pending/agent\t#d4c5f9\t${LABEL_DEFAULTS.agent.description}\nautopilot\t#ff401e\t${LABEL_DEFAULTS.autopilot.description}`);
  });
});
