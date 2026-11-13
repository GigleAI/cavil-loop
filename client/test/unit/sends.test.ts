// GitHub#489: the rules of a send record (shared/sends.ts) — what each state says and offers, where its text
// goes, what proves it, what a restart makes of it, and what is kept on disk.

import { describe, expect, it } from 'vitest';
import {
  commentProves,
  isSendRecord,
  sendAfterRestart,
  sendButtons,
  sendClosable,
  sendDisposable,
  sendHolds,
  sendKeepsText,
  sendProve,
  sendShown,
  sendSlot,
  sendTakeable,
  sendTone,
  type SendAction,
  type SendRecord,
} from '../../src/shared/sends';
import { opProveFromRecords, type OpRecord } from '../../src/shared/ops';

const K = 'gigleai/cavil-loop#138';
function rec(action: SendAction, patch: Partial<SendRecord> = {}): SendRecord {
  return { id: 'send-1', key: K, repo: 'GigleAI/cavil-loop', number: 138, action, startedAt: 1, state: 'sending', sentAt: null, answeredAt: null, reason: null, warning: null, proof: null, returned: false, unlocked: false, dismissed: false, ...patch };
}
const reply: SendAction = { kind: 'comment', key: K, body: '原文' };
const edit: SendAction = { kind: 'editEntry', key: K, entryId: 'IC_1', body: '新', seenSource: '旧' };
const title: SendAction = { kind: 'editTitle', key: K, title: '新标题', seenTitle: '旧标题' };
const tick: SendAction = { kind: 'toggleTask', key: K, entryId: 'IC_1', index: 0, checked: true, seenSource: '- [ ] a' };

describe('the states', () => {
  it('each state: tone, buttons, ×, whether it holds its entry, keeps its text, may go back into an edit box', () => {
    const rows: [string, SendRecord, { tone: string; buttons: string[]; close: boolean; holds: boolean; keeps: boolean; take: boolean }][] = [
      ['sending', rec(reply), { tone: 'busy', buttons: [], close: false, holds: true, keeps: false, take: false }],
      ['ok', rec(reply, { state: 'ok' }), { tone: 'ok', buttons: [], close: true, holds: false, keeps: false, take: false }],
      ['ok with a warning', rec(reply, { state: 'ok', warning: '重读失败' }), { tone: 'warn', buttons: [], close: true, holds: false, keeps: false, take: false }],
      ['refused', rec(reply, { state: 'refused' }), { tone: 'error', buttons: ['resend'], close: true, holds: false, keeps: true, take: true }],
      // PR #510 review round 1: back in the box, the record still keeps the text (the box is not on disk)
      ['refused, text back in the box', rec(reply, { state: 'refused', returned: true }), { tone: 'error', buttons: [], close: true, holds: false, keeps: true, take: false }],
      ['refused, text left the box unsent', rec(reply, { state: 'refused', returned: true, dropped: true }), { tone: 'error', buttons: [], close: true, holds: false, keeps: false, take: false }],
      ['unknown', rec(reply, { state: 'unknown' }), { tone: 'warn', buttons: ['recheck', 'unlock'], close: false, holds: true, keeps: true, take: false }],
      ['unknown, checking', rec(reply, { state: 'unknown', checking: true }), { tone: 'busy', buttons: [], close: false, holds: true, keeps: true, take: false }],
      ['unknown, unlocked', rec(reply, { state: 'unknown', unlocked: true }), { tone: 'warn', buttons: ['recheck'], close: true, holds: false, keeps: true, take: false }],
      ['refused tick (no text)', rec(tick, { state: 'refused' }), { tone: 'error', buttons: ['resend'], close: true, holds: false, keeps: false, take: false }],
    ];
    for (const [name, r, want] of rows)
      expect({ name, tone: sendTone(r), buttons: sendButtons(r), close: sendClosable(r), holds: sendHolds(r), keeps: sendKeepsText(r), take: sendTakeable(r) }).toEqual({ name, ...want });
  });

  it('slots: a reply holds the same text on the same item; an edit / a tick its entry; a title its item', () => {
    expect(sendSlot(reply)).toBe(`comment:${K}\n原文`);
    expect(sendSlot({ ...reply, body: '别的' })).not.toBe(sendSlot(reply));
    expect(sendSlot(edit)).toBe('entry:IC_1');
    expect(sendSlot(tick)).toBe('entry:IC_1');
    expect(sendSlot(title)).toBe(`title:${K}`);
  });

  it('a tick and a title say nothing on their way or when they simply went through; everything else is shown', () => {
    for (const a of [tick, title]) {
      expect(sendShown(rec(a))).toBe(false);
      expect(sendShown(rec(a, { state: 'ok' }))).toBe(false);
      expect(sendShown(rec(a, { state: 'ok', reason: '重读时 GitHub 上已是改后的标题' }))).toBe(true);
      expect(sendShown(rec(a, { state: 'refused' }))).toBe(true);
      expect(sendShown(rec(a, { state: 'unknown' }))).toBe(true);
    }
    for (const a of [reply, edit]) expect(sendShown(rec(a))).toBe(true);
    expect(sendShown(rec(reply, { dismissed: true }))).toBe(false);
  });

  it('forgotten once put away — except a refused text that has not left its box unsent (or was never taken back)', () => {
    expect(sendDisposable(rec(reply, { state: 'ok', dismissed: true }))).toBe(true);
    expect(sendDisposable(rec(reply, { state: 'unknown', unlocked: true, dismissed: true }))).toBe(true);
    expect(sendDisposable(rec(reply, { state: 'refused', returned: true, dismissed: true }))).toBe(false);
    expect(sendDisposable(rec(reply, { state: 'refused', returned: true, dropped: true, dismissed: true }))).toBe(true);
    expect(sendDisposable(rec(tick, { state: 'refused', dismissed: true }))).toBe(true);
    expect(sendDisposable(rec(reply, { state: 'refused', dismissed: true }))).toBe(false);
    expect(sendDisposable(rec(reply, { state: 'unknown', dismissed: true }))).toBe(false);
  });
});

describe('what proves an unknown send', () => {
  const comments = [
    { id: 'old', author: 'me', body: '原文' },
    { id: 'new-other', author: 'someone', body: '原文' },
  ];
  it('a reply: only a comment of this account with exactly the text that was not there before', () => {
    const r = rec(reply, { state: 'unknown', proof: { kind: 'comment', before: ['old'] } });
    expect(sendProve(r, { login: 'me', comments }).record.state).toBe('unknown');
    expect(sendProve(r, { login: 'me', comments: [...comments, { id: 'n', author: 'me', body: '原文 ' }] }).record.state).toBe('unknown');
    expect(sendProve(r, { login: 'me', comments: [...comments, { id: 'n', author: 'me', body: '原文' }] }).record.state).toBe('ok');
    // no list from before: never proven automatically
    const blind = rec(reply, { state: 'unknown', proof: { kind: 'comment', before: null } });
    expect(sendProve(blind, { login: 'me', comments: [{ id: 'n', author: 'me', body: '原文' }] })).toMatchObject({ record: { state: 'unknown' }, missing: expect.stringContaining('只能人工核对') });
    expect(sendProve(r, { login: null, comments }).missing).toContain('不知道当前账号');
  });

  it('the same rule an operation\'s comment step uses (one function)', () => {
    const before = ['old'];
    const list = [{ id: 'old', author: 'me', body: '附' }, { id: 'n', author: 'me', body: '附' }];
    expect(commentProves(list, before, 'me', '附')).toBe(true);
    const op = { id: 'op-1', key: K, repo: 'GigleAI/cavil-loop', number: 138, kind: 'closeIssue', startedAt: 1, draft: { comment: '附' }, readAt: null, targetSeen: false, unlocked: false, draftDropped: false, dismissed: false, stuck: false, checkProblem: null, before: { comments: before, events: [] }, steps: [{ name: 'close', state: 'ok', reason: null, sentAt: 1, answeredAt: 2 }, { name: 'comment', state: 'unknown', reason: null, sentAt: 3, answeredAt: null }] } as unknown as OpRecord;
    for (const [l, want] of [[list, 'ok'], [list.slice(0, 1), 'unknown']] as const) {
      expect(opProveFromRecords(op, { comments: [...l], labelEvents: [] }, 'me').record.steps[1].state).toBe(want);
      expect(sendProve(rec({ ...reply, body: '附' }, { state: 'unknown', proof: { kind: 'comment', before } }), { login: 'me', comments: [...l] }).record.state).toBe(want);
    }
  });

  it('PR #510 review round 1: one comment proves one send — not one another send of the same text owns, and nothing while another one is still open', () => {
    const before = ['old'];
    const r = rec(reply, { id: 'send-2', state: 'unknown', proof: { kind: 'comment', before } });
    const theirs = rec(reply, { id: 'send-1', state: 'ok', commentId: 'n1' });
    const list = [{ id: 'old', author: 'me', body: '原文' }, { id: 'n1', author: 'me', body: '原文' }];
    // the only new same-text comment is the other send's: not this one's
    expect(sendProve(r, { login: 'me', comments: list }, [theirs, r]).record.state).toBe('unknown');
    // its own lands too: proven by that one, which it now owns
    const out = sendProve(r, { login: 'me', comments: [...list, { id: 'n2', author: 'me', body: '原文' }] }, [theirs, r]);
    expect(out.record).toMatchObject({ state: 'ok', commentId: 'n2' });
    // another same-text send of this item is still open: the comment found could be either one's
    const open = rec(reply, { id: 'send-3', state: 'unknown' });
    expect(sendProve(r, { login: 'me', comments: [...list, { id: 'n2', author: 'me', body: '原文' }] }, [theirs, open, r])).toMatchObject({ record: { state: 'unknown' }, missing: expect.stringContaining('分不清') });
    // other text or another item does not count
    const other = rec({ ...reply, body: '别的' }, { id: 'send-4', state: 'unknown' });
    expect(sendProve(r, { login: 'me', comments: [...list, { id: 'n2', author: 'me', body: '原文' }] }, [theirs, other, r]).record.state).toBe('ok');
  });

  it('an edit / a tick / a title: GitHub now holds exactly what was wanted', () => {
    const e = rec(edit, { state: 'unknown', proof: { kind: 'source', want: '新' } });
    expect(sendProve(e, { login: 'me', source: '旧' }).record.state).toBe('unknown');
    expect(sendProve(e, { login: 'me', source: '新' }).record.state).toBe('ok');
    expect(sendProve(e, { login: 'me' }).missing).toContain('没读到');
    const t = rec(title, { state: 'unknown', proof: { kind: 'title', want: '新标题' } });
    expect(sendProve(t, { login: 'me', title: '新标题' }).record.state).toBe('ok');
    expect(sendProve(t, { login: 'me', title: '旧标题' }).record.state).toBe('unknown');
  });
});

describe('a restart', () => {
  it('on its way and sent: unknown; never sent: refused (its text goes back); answered records unchanged', () => {
    expect(sendAfterRestart(rec(reply, { sentAt: 5 }))).toMatchObject({ state: 'unknown' });
    expect(sendAfterRestart(rec(reply))).toMatchObject({ state: 'refused', reason: expect.stringContaining('没有发出') });
    expect(sendTakeable(sendAfterRestart(rec(reply)))).toBe(true);
    // PR #510 review round 1: back in a box that is gone with the last run → offered to the box again; let go → not
    expect(sendTakeable(sendAfterRestart(rec(reply, { state: 'refused', returned: true })))).toBe(true);
    expect(sendTakeable(sendAfterRestart(rec(reply, { state: 'refused', returned: true, dropped: true })))).toBe(false);
    const done = rec(reply, { state: 'ok', checking: true });
    expect(sendAfterRestart(done)).toMatchObject({ state: 'ok', checking: false });
  });

  it('only records of the right shape are taken from disk', () => {
    expect(isSendRecord(rec(reply, { state: 'unknown', proof: { kind: 'comment', before: ['a'] } }))).toBe(true);
    for (const a of [edit, title, tick]) expect(isSendRecord(rec(a))).toBe(true);
    expect(isSendRecord({ ...rec(reply), state: 'maybe' })).toBe(false);
    expect(isSendRecord({ ...rec(reply), action: { kind: 'comment', key: K, body: 'x', draftOf: 'op-1' } })).toBe(false);
    expect(isSendRecord({ ...rec(reply), action: { kind: 'merge', key: K } })).toBe(false);
    expect(isSendRecord({ ...rec(reply), proof: { kind: 'comment', before: [1] } })).toBe(false);
    expect(isSendRecord({ ...rec(reply), returned: undefined })).toBe(false);
    expect(isSendRecord(rec(reply, { dropped: true, commentId: 'IC_1' }))).toBe(true);
    expect(isSendRecord({ ...rec(reply), dropped: 'yes' })).toBe(false);
    expect(isSendRecord({ ...rec(reply), commentId: 5 })).toBe(false);
  });
});
