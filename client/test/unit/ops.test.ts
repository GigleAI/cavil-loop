// GitHub#250: the one judgement of an operation record (shared/ops.ts) — tables A (lock,
// notice, buttons) and E (draft) of the approved plan, row by row. The controller and the
// views only call these functions; test/unit/ops-controller.test.ts runs them for real.

import { describe, expect, it } from 'vitest';
import {
  finishSteps,
  isOpRecord,
  opAfterRestart,
  opApplyRead,
  opAutoDismissable,
  opButtons,
  opDisposable,
  opDraftLeft,
  opLockOf,
  opLocked,
  opPhase,
  opProveFromRecords,
  opReusableDraft,
  opProveStep,
  readBoundary,
  opText,
  opTone,
  type OpRecord,
  type OpStep,
  type OpStepState,
} from '../../src/shared/ops';

const step = (name: OpStep['name'], state: OpStepState, extra: Partial<OpStep> = {}): OpStep => ({
  name,
  state,
  reason: state === 'refused' ? 'GitHub 不接受' : state === 'unknown' ? '连接中断' : null,
  sentAt: state === 'unsent' ? null : 10,
  answeredAt: state === 'ok' || state === 'refused' || state === 'unknown' ? 20 : null,
  ...extra,
});
function rec(kind: OpRecord['kind'], steps: OpStep[], extra: Partial<OpRecord> = {}): OpRecord {
  const draft = kind === 'closeIssue' ? { reason: 'completed' as const, comment: '做完了' } : kind === 'closePr' ? { comment: '不合了' } : kind === 'merge' ? { method: 'squash' as const, headOid: 'a'.repeat(40) } : {};
  return { id: 'op-1', key: 'o/r#5', repo: 'o/r', number: 5, kind, startedAt: 1, steps, draft, readAt: null, targetSeen: false, unlocked: false, draftDropped: false, dismissed: false, stuck: false, checkProblem: null, ...extra };
}
const close = (a: OpStepState, b: OpStepState, extra: Partial<OpRecord> = {}) => rec('closeIssue', [step('close', a), step('comment', b)], extra);
const auto = (a: OpStepState, b: OpStepState, c: OpStepState, extra: Partial<OpRecord> = {}) =>
  rec('autopilot', [step('addLabel', a, { label: 'autopilot' }), step('addLabel', b, { label: 'pending/agent' }), step('removeLabel', c, { label: 'pending/human' })], extra);

describe('table A: phase / lock', () => {
  const rows: [string, OpRecord, string, boolean][] = [
    ['just created, nothing marked sent yet', close('unsent', 'unsent', { running: true }), 'waiting', true],
    ['a step waits for its answer', close('pending', 'unsent'), 'waiting', true],
    ['first step refused, the rest never sent', close('refused', 'unsent'), 'settled', false],
    ['first step unknown', close('unknown', 'unsent'), 'unknown', true],
    ['first step ok, later step unknown (autopilot: agent label)', auto('ok', 'unknown', 'unsent', { readAt: 30 }), 'unknown', true],
    ['all ok, no re-read yet', close('ok', 'ok'), 'settling', true],
    ['all ok, re-read landed but showing it open', close('ok', 'ok', { readAt: 30 }), 'settling', true],
    ['all ok, re-read showed it closed', close('ok', 'ok', { readAt: 30, targetSeen: true }), 'settled', false],
    ['labels: all ok, any re-read landed (the agent label may already be gone)', auto('ok', 'ok', 'ok', { readAt: 30 }), 'settled', false],
    ['labels: ok, refused, unsent and read', auto('ok', 'refused', 'unsent', { readAt: 30 }), 'settled', false],
    ['unknown unlocked by hand', close('unknown', 'unsent', { unlocked: true }), 'unlocked', false],
  ];
  for (const [name, r, phase, locked] of rows) {
    it(name, () => {
      expect(opPhase(r)).toBe(phase);
      expect(opLocked(r)).toBe(locked);
    });
  }
  it('the lock of an item is any record of it that locks', () => {
    const a = close('refused', 'unsent', { id: 'a' });
    const b = auto('ok', 'unknown', 'unsent', { id: 'b', readAt: 30 });
    expect(opLockOf([a, b], 'o/r#5')?.id).toBe('b');
    expect(opLockOf([a], 'o/r#5')).toBeNull();
    expect(opLockOf([b], 'o/r#6')).toBeNull();
  });
});

describe('table A: notice and buttons', () => {
  it('unknown: re-check, the web page, the manual unlock — never a one-click re-send', () => {
    for (const r of [close('unknown', 'unsent'), auto('ok', 'unknown', 'unsent', { readAt: 30 }), rec('merge', [step('merge', 'unknown')])]) {
      const b = opButtons(r);
      expect(b).toEqual(expect.arrayContaining(['recheck', 'openWeb', 'unlock']));
      expect(b).not.toContain('retry');
      expect(b).not.toContain('finish');
      expect(b).not.toContain('dismiss');
    }
  });
  it('settling: nothing until it is stuck, then the web page and the unlock', () => {
    expect(opButtons(close('ok', 'ok'))).toEqual([]);
    expect(opButtons(close('ok', 'ok', { stuck: true }))).toEqual(['openWeb', 'unlock']);
  });
  it('while a step is on its way the kept comment is not offered (it may still go out with it)', () => {
    expect(opButtons(close('pending', 'unsent'))).toEqual([]);
    expect(opButtons(close('ok', 'pending'))).toEqual([]);
    expect(opButtons(close('unsent', 'unsent', { running: true }))).toEqual([]);
  });
  it('first step refused: retry, and the kept comment can be copied / put into the reply box', () => {
    expect(opButtons(close('refused', 'unsent'))).toEqual(['retry', 'copy', 'toReply', 'dropDraft', 'dismiss']);
  });
  it('comment refused: no retry of the close; copy and reply box; comment unknown: copy only', () => {
    expect(opButtons(close('ok', 'refused', { readAt: 30, targetSeen: true }))).toEqual(['copy', 'toReply', 'dropDraft', 'dismiss']);
    const unknownComment = opButtons(close('ok', 'unknown', { readAt: 30, targetSeen: true }));
    expect(unknownComment).toContain('copy');
    expect(unknownComment).not.toContain('toReply');
  });
  it('autopilot partly done: finish only once settled', () => {
    expect(opButtons(auto('ok', 'refused', 'unsent', { readAt: 30 }))).toEqual(['finish', 'dismiss']);
    expect(opButtons(auto('ok', 'refused', 'unsent'))).toEqual([]);
  });
  it('every step is named in the notice', () => {
    expect(opText(close('pending', 'unsent'))).toBe('正在关闭 issue #5…');
    expect(opText(close('unsent', 'unsent', { running: true }))).toBe('正在关闭 issue #5…');
    expect(opText(close('refused', 'unsent'))).toBe('没有关闭 issue #5：GitHub 不接受');
    expect(opText(close('unknown', 'unsent'))).toBe('不确定 issue #5 有没有关上（连接中断）');
    expect(opText(close('ok', 'ok', { readAt: 30, targetSeen: true }))).toBe('issue #5 已关闭（已完成），评论已发出');
    expect(opText(close('ok', 'ok'))).toBe('issue #5 已关闭（已完成），评论已发出（正在等 GitHub 的最新状态）');
    expect(opText(close('ok', 'refused', { readAt: 30, targetSeen: true }))).toBe('issue #5 已关闭（已完成），但附的评论没有发出去：GitHub 不接受');
    expect(opText(close('ok', 'unknown', { readAt: 30, targetSeen: true }))).toBe('issue #5 已关闭（已完成），附的评论不确定有没有发出');
    expect(opText(close('ok', 'unsent', { readAt: 30, targetSeen: true }))).toBe('issue #5 已关闭（已完成），附的评论没有发出（关闭的应答丢了，没敢接着发）');
    expect(opText(auto('ok', 'unknown', 'unsent', { readAt: 30 }))).toBe('托管没有全部完成：已加上「autopilot」；「pending/agent」不确定有没有加上；还没摘「pending/human」');
    expect(opText(auto('ok', 'ok', 'ok', { readAt: 30 }))).toBe('已托管：已加上「autopilot」、已加上「pending/agent」、已摘掉「pending/human」');
    expect(opText(close('unknown', 'unsent', { unlocked: true }))).toMatch(/^已由人核对后解除锁定：/);
    expect(opText(rec('merge', [step('merge', 'ok')], { readAt: 30, targetSeen: true }))).toBe('PR #5 已合并');
  });
  it('tone: refused first step is an error; anything not plainly done is a warning', () => {
    expect(opTone(close('pending', 'unsent'))).toBe('busy');
    expect(opTone(close('refused', 'unsent'))).toBe('error');
    expect(opTone(close('unknown', 'unsent'))).toBe('warn');
    expect(opTone(close('ok', 'refused', { readAt: 30, targetSeen: true }))).toBe('warn');
    expect(opTone(close('ok', 'ok', { readAt: 30, targetSeen: true }))).toBe('ok');
  });
});

describe('GitHub#256: only a fully successful notice puts itself away', () => {
  const done = { readAt: 30, targetSeen: true };
  const closeNoComment = (extra: Partial<OpRecord> = {}) => rec('closeIssue', [step('close', 'ok')], { draft: { reason: 'completed' }, ...done, ...extra });
  const merged = (extra: Partial<OpRecord> = {}) => rec('merge', [step('merge', 'ok')], { ...done, ...extra });
  const handBack = (extra: Partial<OpRecord> = {}) => rec('handBack', [step('addLabel', 'ok', { label: 'pending/agent' }), step('removeLabel', 'ok', { label: 'pending/human' })], { readAt: 30, ...extra });
  const yes: [string, OpRecord][] = [
    ['close an issue with its comment, read back closed', close('ok', 'ok', done)],
    ['close an issue without a comment, read back closed', closeNoComment()],
    ['close a PR, read back closed', rec('closePr', [step('close', 'ok'), step('comment', 'ok')], done)],
    ['merge, read back merged', merged()],
    ['autopilot, every label step done and read', auto('ok', 'ok', 'ok', { readAt: 30 })],
    ['hand back to the agent, every label step done and read', handBack()],
  ];
  for (const [name, r] of yes) it(`yes: ${name}`, () => {
    expect(opTone(r)).toBe('ok');
    expect(opAutoDismissable(r)).toBe(true);
  });
  const no: [string, OpRecord][] = [
    ['still on its way', close('pending', 'unsent')],
    ['created, first request not marked sent', close('unsent', 'unsent', { running: true })],
    ['answer never came', close('unknown', 'unsent')],
    ['waiting for the re-read', close('ok', 'ok')],
    ['re-read still shows it open', close('ok', 'ok', { readAt: 30 })],
    ['stuck waiting for the re-read', close('ok', 'ok', { stuck: true })],
    ['unlocked by hand after the person checked GitHub (all steps ok)', close('ok', 'ok', { stuck: true, unlocked: true })],
    ['unlocked by hand after an unknown step', close('unknown', 'unsent', { unlocked: true })],
    ['main step refused', close('refused', 'unsent')],
    ['comment refused, kept draft', close('ok', 'refused', done)],
    ['label step refused', auto('ok', 'refused', 'unsent', { readAt: 30 })],
    ['merged, but the linked issues could not be re-read', merged({ readProblem: '没读到这个 PR 关联的 issue（连接中断），下一轮同步会更新' })],
    ['evidence read failed', merged({ checkProblem: '连接中断' })],
    ['a comment draft left (comment step dropped from the record)', rec('closeIssue', [step('close', 'ok')], { draft: { reason: 'completed', comment: '留着' }, ...done })],
    ['a reply from the kept comment on its way', closeNoComment({ replyState: 'sending' })],
    ['a reply from the kept comment unknown', closeNoComment({ replyState: 'unknown' })],
    ['already put away', closeNoComment({ dismissed: true })],
  ];
  for (const [name, r] of no) it(`no: ${name}`, () => expect(opAutoDismissable(r)).toBe(false));
  it('a notice with only × and a re-read problem stays', () => {
    const r = merged({ readProblem: '没读到这个 PR 关联的 issue' });
    expect(opButtons(r)).toEqual(['dismiss']);
    expect(opAutoDismissable(r)).toBe(false);
  });
  // PR #282 code review round 1: a read that settles the record ends "stuck"; one that does not keeps it
  it('a counting read that settles a stuck record clears stuck; a read that leaves it settling keeps it', () => {
    const stuckClose = close('ok', 'ok', { stuck: true });
    const open = opApplyRead(stuckClose, { issuedAt: 40, state: 'open', labels: [] });
    expect(opPhase(open)).toBe('settling');
    expect(open.stuck).toBe(true);
    const shut = opApplyRead(stuckClose, { issuedAt: 40, state: 'closed', labels: [] });
    expect(opPhase(shut)).toBe('settled');
    expect(shut.stuck).toBe(false);
    expect(opAutoDismissable(shut)).toBe(true);
    // too old to count: nothing changes
    expect(opApplyRead(stuckClose, { issuedAt: 1, state: 'closed', labels: [] })).toBe(stuckClose);
  });
  // GitHub#279: every step worked but the re-read did not — a warning, not a success (it used to read "ok")
  const reread: [string, OpRecord][] = [
    ['merged, linked issues not re-read', merged({ readProblem: '没读到这个 PR 关联的 issue' })],
    ['autopilot, the item not re-read', auto('ok', 'ok', 'ok', { readAt: 30, readProblem: '修改已生效，但重读这一条失败（连接中断），下一轮同步会更新' })],
    ['close, the item not re-read (still waiting for a re-read)', close('ok', 'ok', { readProblem: '修改已生效，但重读这一条失败（连接中断），下一轮同步会更新' })],
  ];
  for (const [name, r] of reread)
    it(`GitHub#279 warn: ${name}; the same record without the problem is not a warning`, () => {
      expect(opTone(r)).toBe('warn');
      expect(opTone({ ...r, readProblem: null })).not.toBe('warn');
    });
});

describe('table E: the draft goes only when its own step is done, or by hand', () => {
  const rows: [string, OpRecord, object | null][] = [
    ['close refused, comment never sent', close('refused', 'unsent'), { reason: 'completed', comment: '做完了' }],
    ['close unknown', close('unknown', 'unsent'), { reason: 'completed', comment: '做完了' }],
    ['close proven, comment never sent (settled)', close('ok', 'unsent', { readAt: 30, targetSeen: true }), { comment: '做完了' }],
    ['close ok, comment refused', close('ok', 'refused', { readAt: 30, targetSeen: true }), { comment: '做完了' }],
    ['close ok, comment unknown', close('ok', 'unknown'), { comment: '做完了' }],
    ['both done', close('ok', 'ok', { readAt: 30, targetSeen: true }), null],
    ['unlocked by hand: unlocking does not drop it', close('unknown', 'unsent', { unlocked: true }), { reason: 'completed', comment: '做完了' }],
    ['dropped by hand', close('refused', 'unsent', { draftDropped: true }), null],
    ['merge refused', rec('merge', [step('merge', 'refused')]), { method: 'squash', headOid: 'a'.repeat(40) }],
    ['merge done', rec('merge', [step('merge', 'ok')]), null],
  ];
  for (const [name, r, left] of rows) it(name, () => expect(opDraftLeft(r)).toEqual(left));
  it('a record is forgotten only when settled, put away and with nothing kept', () => {
    expect(opDisposable(close('refused', 'unsent', { dismissed: true }))).toBe(false);
    expect(opDisposable(close('refused', 'unsent', { dismissed: true, draftDropped: true }))).toBe(true);
    expect(opDisposable(close('ok', 'ok', { dismissed: true }))).toBe(false); // still settling
    expect(opDisposable(close('ok', 'ok', { dismissed: true, readAt: 30, targetSeen: true }))).toBe(true);
  });
});

describe('reads never turn "unknown" into "did not happen"', () => {
  it('a read issued before the last answer does not count', () => {
    const r = close('ok', 'ok');
    expect(opApplyRead(r, { issuedAt: 20, state: 'closed', labels: [] })).toBe(r);
    expect(opApplyRead(r, { issuedAt: 21, state: 'closed', labels: [] })).toMatchObject({ readAt: 21, targetSeen: true });
  });
  it('an unknown close read back open stays unknown; read back closed is proven', () => {
    const r = close('unknown', 'unsent');
    const open = opApplyRead(r, { issuedAt: 30, state: 'open', labels: [] });
    expect(open.steps.map((s) => s.state)).toEqual(['unknown', 'unsent']);
    expect(opPhase(open)).toBe('unknown');
    const closed = opApplyRead(open, { issuedAt: 40, state: 'closed', labels: [] });
    expect(closed.steps.map((s) => s.state)).toEqual(['ok', 'unsent']);
    expect(opPhase(closed)).toBe('settled');
  });
  it('an unknown "agent" label is never proven or denied by the labels on the item (the daemon takes it away)', () => {
    const r = auto('ok', 'unknown', 'unsent');
    for (const labels of [[], ['pending/agent'], ['doing/agent']]) {
      const x = opApplyRead(r, { issuedAt: 30, state: 'open', labels });
      expect(x.steps[1].state).toBe('unknown');
      expect(opPhase(x)).toBe('unknown');
    }
  });
  it('an unknown label removal is proven by the label being gone, never denied by it being there', () => {
    const r = rec('handBack', [step('addLabel', 'ok', { label: 'pending/agent' }), step('removeLabel', 'unknown', { label: 'pending/human' })]);
    expect(opApplyRead(r, { issuedAt: 30, state: 'open', labels: ['pending/human'] }).steps[1].state).toBe('unknown');
    expect(opApplyRead(r, { issuedAt: 30, state: 'open', labels: [] }).steps[1].state).toBe('ok');
  });
  it('evidence proves only an unknown step', () => {
    const r = auto('ok', 'unknown', 'unsent');
    expect(opProveStep(r, 1, 'x').steps[1].state).toBe('ok');
    expect(opProveStep(r, 2, 'x')).toBe(r);
  });
});

describe('finish: only refused / never-sent label steps, never one that worked or whose answer never came', () => {
  it('agent refused: add it and take the human label off; what is already right is skipped', () => {
    const r = auto('ok', 'refused', 'unsent', { readAt: 30 });
    expect(finishSteps(r).map((s) => [s.name, s.label])).toEqual([
      ['addLabel', 'pending/agent'],
      ['removeLabel', 'pending/human'],
    ]);
    expect(finishSteps(r, ['pending/agent', 'pending/human']).map((s) => s.label)).toEqual(['pending/human']);
    expect(finishSteps(r, ['autopilot'])).toHaveLength(1);
  });
  it('agent proven after an unknown (the daemon took it): only the human label', () => {
    const r = auto('ok', 'ok', 'unsent', { readAt: 30 });
    expect(finishSteps(r, ['pending/human', 'doing/agent']).map((s) => s.label)).toEqual(['pending/human']);
  });
  it('nothing while locked, nothing for close / merge', () => {
    expect(finishSteps(auto('ok', 'unknown', 'unsent', { readAt: 30 }))).toEqual([]);
    expect(finishSteps(close('ok', 'refused', { readAt: 30, targetSeen: true }))).toEqual([]);
  });
});

describe('restart and stored shape', () => {
  it('a request waiting when the app stopped is unknown afterwards; running is not kept', () => {
    const r = opAfterRestart(close('pending', 'unsent', { running: true }));
    expect(r.steps.map((s) => s.state)).toEqual(['unknown', 'unsent']);
    expect(r.running).toBe(false);
    expect(opPhase(r)).toBe('unknown');
  });
  it('a stored row must be a whole record', () => {
    expect(isOpRecord(close('ok', 'ok'))).toBe(true);
    expect(isOpRecord({ ...close('ok', 'ok'), kind: 'comment' })).toBe(false);
    expect(isOpRecord({ ...close('ok', 'ok'), steps: [] })).toBe(false);
    expect(isOpRecord({ ...close('ok', 'ok'), steps: [{ name: 'close', state: 'maybe' }] })).toBe(false);
  });
});

describe('code review round 1: evidence newer than the request; restart boundary', () => {
  const recs = (comments: [string, string, string][], events: [string, 'labeled' | 'unlabeled', string, string][]) => ({
    comments: comments.map(([id, author, body]) => ({ id, author, body })),
    labelEvents: events.map(([id, event, actor, label]) => ({ id, event, actor, label })),
  });
  it('an old comment / event that was there before the request proves nothing; a new one does', () => {
    const r = close('ok', 'unknown', { before: { comments: ['c1'], events: [] } });
    expect(opProveFromRecords(r, recs([['c1', 'me', '做完了']], []), 'me').record.steps[1].state).toBe('unknown');
    expect(opProveFromRecords(r, recs([['c1', 'me', '做完了'], ['c2', 'other', '做完了'], ['c3', 'me', '别的']], []), 'me').record.steps[1].state).toBe('unknown');
    expect(opProveFromRecords(r, recs([['c1', 'me', '做完了'], ['c2', 'me', '做完了']], []), 'me').record.steps[1].state).toBe('ok');
    const a = auto('ok', 'unknown', 'unsent', { before: { comments: [], events: ['e1'] } });
    expect(opProveFromRecords(a, recs([], [['e1', 'labeled', 'me', 'pending/agent']]), 'me').record.steps[1].state).toBe('unknown');
    expect(opProveFromRecords(a, recs([], [['e1', 'labeled', 'me', 'pending/agent'], ['e2', 'unlabeled', 'me', 'pending/agent']]), 'me').record.steps[1].state).toBe('unknown');
    expect(opProveFromRecords(a, recs([], [['e2', 'labeled', 'bot', 'pending/agent']]), 'me').record.steps[1].state).toBe('unknown');
    expect(opProveFromRecords(a, recs([], [['e1', 'labeled', 'me', 'pending/agent'], ['e2', 'labeled', 'me', 'pending/agent']]), 'me').record.steps[1].state).toBe('ok');
  });
  it('no list of what was there before (the read failed, or an old record): never proven, and said so', () => {
    for (const before of [null, undefined]) {
      const out = opProveFromRecords(close('ok', 'unknown', { before }), recs([['c9', 'me', '做完了']], []), 'me');
      expect(out.record.steps[1].state).toBe('unknown');
      expect(out.missing[0]).toContain('发送前没读到');
    }
  });
  it('a step whose answer never came (restart): reads count once issued after its sending, never before', () => {
    const r = opAfterRestart(close('pending', 'unsent', { running: true }));
    expect(r.steps[0].answeredAt).toBeNull();
    expect(readBoundary(r)).toBe(10);
    expect(opApplyRead(r, { issuedAt: 10, state: 'closed', labels: [] })).toBe(r);
    const x = opApplyRead(r, { issuedAt: 11, state: 'closed', labels: [] });
    expect(x.steps.map((s) => s.state)).toEqual(['ok', 'unsent']);
    expect(x.steps[0].answeredAt).toBeNull();
    expect(opPhase(x)).toBe('settled');
    expect(opDraftLeft(x)).toEqual({ comment: '做完了' });
  });
});

describe('code review round 2: a reply made from the kept comment', () => {
  const base = () => close('refused', 'unsent');
  it('on its way: waiting; no answer: unknown — locked either way, no retry, no reply box, copy only', () => {
    expect(opPhase({ ...base(), replyState: 'sending' })).toBe('waiting');
    const u = { ...base(), replyState: 'unknown' as const, reply: { body: '做完了', before: [] } };
    expect(opPhase(u)).toBe('unknown');
    expect(opLocked(u)).toBe(true);
    expect(opButtons(u)).toEqual(['recheck', 'openWeb', 'unlock', 'copy', 'dropDraft']);
  });
  it('the dialog of a retry never gets that comment back; unlocked by hand neither', () => {
    const u = { ...base(), replyState: 'unknown' as const };
    expect(opDraftLeft(u)).toEqual({ reason: 'completed', comment: '做完了' });
    expect(opReusableDraft(u)).toEqual({ reason: 'completed' });
    expect(opReusableDraft({ ...u, unlocked: true })).toEqual({ reason: 'completed' });
    expect(opReusableDraft(base())).toEqual({ reason: 'completed', comment: '做完了' });
  });
  it('proven only by a comment that was not there before the reply; that ends the draft comment', () => {
    const u = { ...base(), replyState: 'unknown' as const, reply: { body: '做完了', before: ['c1'] } };
    const recs = (ids: [string, string][]) => ({ comments: ids.map(([id, author]) => ({ id, author, body: '做完了' })), labelEvents: [] });
    expect(opProveFromRecords(u, recs([['c1', 'me']]), 'me').record.replyState).toBe('unknown');
    const ok = opProveFromRecords(u, recs([['c1', 'me'], ['c2', 'me']]), 'me').record;
    expect(ok.replyState).toBeNull();
    expect(opDraftLeft(ok)).toEqual({ reason: 'completed' });
    expect(opProveFromRecords({ ...u, reply: { body: '做完了', before: null } }, recs([['c2', 'me']]), 'me').record.replyState).toBe('unknown');
  });
});
