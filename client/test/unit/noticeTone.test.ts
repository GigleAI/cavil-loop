// GitHub#357: the one colour rule (shared/noticeTone.ts). Every notice states four facts and its
// resting colour; the order of the rules decides. Operation notices are covered row by row in
// ops.test.ts, the controller's writes of these facts in notice-tone-controller.test.ts.

import { describe, expect, it } from 'vitest';
import { createFacts, createTone, editsTone, noticeTone, resultTone, watchFailed, type NoticeFacts } from '../../src/shared/noticeTone';
import type { CreateJob, CreateWatch } from '../../src/shared/types';

describe('the rule, over every combination of the four facts', () => {
  const bools = [false, true];
  for (const rest of ['warn', 'info', 'error'] as const)
    for (const busy of bools)
      for (const done of bools)
        for (const failed of bools)
          for (const retrying of bools) {
            const f: NoticeFacts = { busy, done, failed, retrying, rest };
            const want = busy ? 'busy' : done ? 'ok' : failed ? 'error' : retrying ? 'warn' : rest;
            it(`busy=${busy} done=${done} failed=${failed} retrying=${retrying} rest=${rest} → ${want}`, () => expect(noticeTone(f)).toBe(want));
          }
  it('something running wins over the failure before it; a failure wins over a background retry', () => {
    expect(noticeTone({ busy: true, done: false, failed: true, retrying: true, rest: 'warn' })).toBe('busy');
    expect(noticeTone({ busy: false, done: false, failed: true, retrying: true, rest: 'warn' })).toBe('error');
    expect(noticeTone({ busy: false, done: false, failed: false, retrying: true, rest: 'info' })).toBe('warn');
  });
});

const job = (extra: Partial<CreateJob> = {}): CreateJob => ({ id: 1, repo: 'o/r', title: 't', status: 'partial', message: 'issue #9 已建好，但…', createdKey: 'o/r#9', number: 9, draft: { repo: 'o/r', title: 't', body: '', labels: [], projects: [] }, ...extra });
const watch = (state: CreateWatch['state'], extra: Partial<CreateWatch> = {}): CreateWatch => ({ projectKey: 'p', title: 'P', iterationId: null, status: 's', label: 'Todo', state, writes: 0, epoch: 0, ...extra });

describe('a new issue\'s notice', () => {
  const rows: [string, CreateJob, string][] = [
    ['being created', job({ status: 'running', message: null }), 'busy'],
    ['could not be created', job({ status: 'failed', message: '没有权限' }), 'error'],
    ['not on a board, nobody tried again', job({ boards: [{ projectKey: 'p', title: 'P', state: 'missing', reason: 'HTTP 502', iterationId: null, status: null } as any] }), 'warn'],
    ['"再试加入看板" running', job({ retrying: true }), 'busy'],
    ['"再试加入看板" running again: the failure before it does not show', job({ retrying: true, actionError: 'HTTP 502' }), 'busy'],
    ['the last "再试" / "改成…" failed', job({ actionError: 'HTTP 502' }), 'error'],
    ['a board holds another value, a person decides', job({ watch: [watch('human')] }), 'warn'],
    ['"改成…" running on a board', job({ watch: [watch('human', { busy: true })] }), 'busy'],
    ['the automatic write was refused', job({ watch: [watch('failed', { reason: 'HTTP 403' })] }), 'error'],
    ['written, could not be read back', job({ watch: [watch('unverified')] }), 'error'],
    ['could not be read whether the board took it in', job({ watch: [watch('unread')] }), 'error'],
    ['boards still being looked at / checked in the background', job({ watch: [watch('looking'), watch('written', { projectKey: 'q' })] }), 'warn'],
    ['several boards: one being worked on wins over one that failed', job({ watch: [watch('failed'), watch('human', { projectKey: 'q', busy: true })] }), 'busy'],
    ['several boards: one failed wins over one waiting for a person', job({ watch: [watch('human'), watch('unread', { projectKey: 'q' })] }), 'error'],
    ['no answer, looking for same-title issues', job({ status: 'unknown', looking: true }), 'busy'],
    ['no answer, the look failed', job({ status: 'unknown', lookError: 'HTTP 502' }), 'error'],
    ['no answer, the look is over', job({ status: 'unknown', candidates: [] }), 'warn'],
  ];
  for (const [name, j, tone] of rows) it(`${tone}: ${name}`, () => expect(createTone(j)).toBe(tone));
  it('never green (a finished one has no notice), never a background retry', () => {
    for (const [, j] of rows) {
      expect(createFacts(j).done).toBe(false);
      expect(createFacts(j).retrying).toBe(false);
    }
  });
  it('which board states are failures', () => {
    expect((['looking', 'written', 'human', 'failed', 'unverified', 'unread'] as const).filter((s) => watchFailed(watch(s)))).toEqual(['failed', 'unverified', 'unread']);
  });
});

describe('changes not saved, result bars', () => {
  it('changes not saved are red, blue while a resend runs', () => {
    expect(editsTone(false)).toBe('error');
    expect(editsTone(true)).toBe('busy');
  });
  it('a result bar: went through = green, with a re-read left = yellow, refused = red', () => {
    expect(resultTone('ok')).toBe('ok');
    expect(resultTone('warn')).toBe('warn');
    expect(resultTone('error')).toBe('error');
  });
});
