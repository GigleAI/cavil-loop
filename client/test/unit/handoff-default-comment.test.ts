// GitHub#722: "交给 agent" / "托管" on an existing item with nothing in the reply box post 「继续」 first, then
// change the labels — a new operation only. One started from an earlier one (重试 / 重新托管…) never adds a
// comment of its own: it carries only what is left of that one's comment (sent, or posted as a reply from it,
// or possibly posted = nothing left). The controller against the fake GitHub over real HTTP, with the real
// back end (Rust) as a child process and a real SQLite file; what is asserted is what GitHub received.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { Controller } from '../../src/app/controller';
import { createController } from '../support/controller';
import { Cache } from '../support/cache';
import { FileStore } from '../support/credentials';
import { HarnessBackend } from '../support/harness';
import { startFakeGitHub, FakeGitHub } from '../fake-github/server';
import { FAKE_TOKEN, FIXTURE_NOW, tempDir, trustedList } from './helpers';
import { opActions, opReusableDraft, type OpRecord } from '../../src/shared/ops';
import { handOffCommentFor } from '../../src/shared/handoff';
import { setLang } from '../../src/shared/i18n';
import { waitUntil } from '../support/wait';

const PROJECT_URL = 'https://github.com/orgs/GigleAI/projects/11';
const REPO = 'GigleAI/cavil-loop';
const K = (n: number) => `gigleai/cavil-loop#${n}`;
const ISSUE = 138;
const KINDS = ['handBack', 'autopilot'] as const;
type Kind = (typeof KINDS)[number];

let fake: FakeGitHub;
let dir: string;
let caches: Cache[] = [];
let controllers: Controller[] = [];
let backends: HarnessBackend[] = [];

async function ready() {
  const cache = new Cache(join(dir, 'cache.sqlite'));
  caches.push(cache);
  cache.setSetting('trustedCredentials', trustedList(FAKE_TOKEN));
  const credentials = new FileStore(join(dir, 'cred'));
  await credentials.set(FAKE_TOKEN);
  const endpoints = { api: fake.api, web: fake.web };
  const harness = new HarnessBackend({ db: join(dir, 'cache.sqlite'), endpoints, credentials, now: () => FIXTURE_NOW, sleep: async () => {} });
  backends.push(harness);
  const c = await createController({ backend: harness as any, endpoints, now: () => FIXTURE_NOW, defaultClientId: '', observeMs: 60_000, observeFirstMs: 60_000, opStuckMs: 600_000, opCheckDelaysMs: [] });
  controllers.push(c);
  if (!c.getState().sources.length) {
    c.addSource(PROJECT_URL);
    c.addSource(REPO);
  }
  await c.start();
  await c.syncNow();
  expect(c.getState().phase).toBe('ready');
  return c;
}

const opOf = (c: Controller, id: string): OpRecord => {
  const r = c.getState().ops.find((x) => x.id === id);
  if (!r) throw new Error(`no op ${id}`);
  return r;
};
const idle = async (c: Controller) => {
  for (const j of [...((c as any).opJobs as Map<string, Promise<void>>).values()]) await j;
  await c.settled();
};
/** the hand-over's writes on #ISSUE in the order GitHub got them */
const handOverWrites = () =>
  fake
    .writes()
    .filter((w) => w.path.startsWith(`/api/repos/${REPO}/issues/${ISSUE}/`))
    .map((w) => (w.path.endsWith('/comments') ? `comment ${(w.body as any)?.body}` : w.method === 'POST' ? `add ${((w.body as any)?.labels ?? []).join(',')}` : `remove ${decodeURIComponent(w.path.split('/labels/')[1] ?? '')}`));
const commentWrites = () => handOverWrites().filter((x) => x.startsWith('comment '));
const labelWrites = () => handOverWrites().filter((x) => !x.startsWith('comment '));
const commentsOnGitHub = () => (fake.state.w.comments.get(`gigleai/cavil-loop#${ISSUE}`) ?? []).map((x) => x.body);
/** what a whole hand-over of `kind` writes after its comment */
const LABELS: Record<Kind, string[]> = { handBack: ['add pending/agent', 'remove pending/human'], autopilot: ['add autopilot', 'add pending/agent', 'remove pending/human'] };

/** #ISSUE waits for a person and has no autopilot label yet (the fixture has one): every label step really goes out */
function waitingForHuman() {
  for (const p of fake.state.projects.get('org/gigleai/11')!)
    for (const node of p.items.nodes)
      if (node.content?.number === ISSUE) {
        Object.assign(node.content, { state: 'OPEN', stateReason: null });
        node.content.labels.nodes = node.content.labels.nodes.filter((l: any) => l.name !== 'autopilot');
        if (!node.content.labels.nodes.some((l: any) => l.name === 'pending/human')) node.content.labels.nodes.push({ name: 'pending/human', color: 'ededed' });
      }
  for (const r of fake.state.repos.get('gigleai/cavil-loop')!)
    if (r.number === ISSUE) {
      Object.assign(r, { state: 'open', state_reason: null });
      r.labels = r.labels.filter((l: any) => l.name !== 'autopilot');
      if (!r.labels.some((l: any) => l.name === 'pending/human')) r.labels.push({ name: 'pending/human', color: 'ededed' });
    }
}

/** a hand-over whose comment GitHub refused for sure: nothing else went out; its 「继续」 is kept */
async function refusedFirst(c: Controller, kind: Kind): Promise<string> {
  fake.state.w.failComment = true;
  const s = c.startOp({ kind, key: K(ISSUE) });
  expect(s.ok).toBe(true);
  await idle(c);
  fake.state.w.failComment = false;
  // the comment did reach GitHub — 「继续」, the default — and nothing after it
  expect(handOverWrites()).toEqual(['comment 继续']);
  expect(opReusableDraft(opOf(c, s.id!))).toEqual({ comment: '继续' });
  return s.id!;
}

beforeEach(async () => {
  fake = await startFakeGitHub();
  dir = tempDir();
  waitingForHuman();
});
afterEach(async () => {
  setLang('zh');
  for (const c of controllers) c.stopTimer();
  await Promise.all(backends.map((b) => b.close()));
  for (const c of caches) c.close();
  caches = [];
  controllers = [];
  backends = [];
  await fake.close();
});

describe('the rule (shared by the controller and the detail panel)', () => {
  it('text given = that text; none = 「继续」 for a new operation, nothing for one started from an earlier one', () => {
    expect(handOffCommentFor('先看这句', false)).toBe('先看这句');
    expect(handOffCommentFor('先看这句', true)).toBe('先看这句');
    expect(handOffCommentFor('', false)).toBe('继续');
    expect(handOffCommentFor('  \n ', false)).toBe('继续');
    expect(handOffCommentFor('', true)).toBe('');
    setLang('en');
    expect(handOffCommentFor('', false)).toBe('Continue');
  });
});

describe('a new hand-over with nothing in the reply box', () => {
  for (const kind of KINDS) {
    it(`${kind}: 「继续」 goes out first, then the labels; GitHub holds the comment`, async () => {
      const c = await ready();
      const s = c.startOp({ kind, key: K(ISSUE) });
      expect(s.ok).toBe(true);
      await idle(c);
      expect(handOverWrites()).toEqual(['comment 继续', ...LABELS[kind]]);
      expect(commentsOnGitHub()).toEqual(['继续']);
      const r = opOf(c, s.id!);
      expect(r.steps.map((x) => x.state)).toEqual(r.steps.map(() => 'ok'));
      expect(r.steps[0].name).toBe('comment');
    });

    it(`${kind}: only blanks count as nothing — 「继续」 too`, async () => {
      const c = await ready();
      await idle(c);
      c.startOp({ kind, key: K(ISSUE), comment: '  \n ' });
      await idle(c);
      expect(handOverWrites()).toEqual(['comment 继续', ...LABELS[kind]]);
    });

    it(`${kind}: text in the reply box is sent instead, never 「继续」`, async () => {
      const c = await ready();
      c.startOp({ kind, key: K(ISSUE), comment: '补充：只改客户端' });
      await idle(c);
      expect(handOverWrites()).toEqual(['comment 补充：只改客户端', ...LABELS[kind]]);
      expect(commentsOnGitHub()).toEqual(['补充：只改客户端']);
    });

    it(`${kind}: the comment refused — no label request at all`, async () => {
      const c = await ready();
      const id = await refusedFirst(c, kind);
      expect(labelWrites()).toEqual([]);
      expect(opOf(c, id).steps.map((x) => x.state).slice(1)).toEqual(LABELS[kind].map(() => 'unsent'));
    });

    it(`${kind}: through act (the remote / table entry) the same`, async () => {
      const c = await ready();
      expect((await c.act({ kind, key: K(ISSUE) })).ok).toBe(true);
      await idle(c);
      expect(handOverWrites()).toEqual(['comment 继续', ...LABELS[kind]]);
    });
  }

  it('in English: "Continue"', async () => {
    const c = await ready();
    c.setUiLanguage('en');
    c.startOp({ kind: 'handBack', key: K(ISSUE) });
    await idle(c);
    expect(handOverWrites()).toEqual(['comment Continue', ...LABELS.handBack]);
  });
});

describe('started from an earlier hand-over: never a second 「继续」', () => {
  for (const kind of KINDS) {
    it(`${kind}: the earlier 「继续」 went out and a label was refused — finishing sends the labels only`, async () => {
      const c = await ready();
      fake.state.w.failLabel = 'pending/agent';
      const s = c.startOp({ kind, key: K(ISSUE) });
      await idle(c);
      fake.state.w.failLabel = null;
      expect(commentsOnGitHub()).toEqual(['继续']);
      const r = opOf(c, s.id!);
      expect(opReusableDraft(r)).toBeNull();
      expect(opActions(r).retry).toBe('finish');
      expect((await c.opFinish(s.id!)).ok).toBe(true);
      await idle(c);
      expect(commentWrites()).toEqual(['comment 继续']);
      expect(labelsOn()).toEqual(expect.arrayContaining(['pending/agent']));
      expect(labelsOn()).not.toContain('pending/human');
      // and the window's own "start again from it" (重新托管… / its retry) carries nothing either
      const again = c.startOp({ kind, key: K(ISSUE) }, { from: s.id! });
      if (again.ok) await idle(c);
      expect(commentWrites()).toEqual(['comment 继续']);
    });

    it(`${kind}: the earlier 「继续」 was refused for sure — 「重试」 sends it again, once, then the labels`, async () => {
      const c = await ready();
      const id = await refusedFirst(c, kind);
      expect(opActions(opOf(c, id)).retry).toBe('redo');
      const again = c.opRedo(id);
      expect(again.ok).toBe(true);
      await idle(c);
      expect(handOverWrites()).toEqual(['comment 继续', 'comment 继续', ...LABELS[kind]]);
      expect(commentsOnGitHub()).toEqual(['继续']);
    });

    it(`${kind}: the earlier 「继续」 was posted from the reply box afterwards — 「重试」 sends the labels only`, async () => {
      const c = await ready();
      const id = await refusedFirst(c, kind);
      expect((await c.act({ kind: 'comment', key: K(ISSUE), body: '继续', draftOf: id })).ok).toBe(true);
      expect(commentsOnGitHub()).toEqual(['继续']);
      expect(opReusableDraft(opOf(c, id))).toBeNull();
      const again = c.opRedo(id);
      expect(again.ok).toBe(true);
      await idle(c);
      expect(handOverWrites()).toEqual(['comment 继续', 'comment 继续', ...LABELS[kind]]);
      expect(commentsOnGitHub()).toEqual(['继续']);
    });

    it(`${kind}: that reply is still on its way — starting again is refused; once it went out, starting again sends no comment`, async () => {
      const c = await ready();
      const id = await refusedFirst(c, kind);
      const hold = fake.holdWhen((e) => e.method === 'POST' && e.path.endsWith(`/issues/${ISSUE}/comments`));
      const reply = c.act({ kind: 'comment', key: K(ISSUE), body: '继续', draftOf: id });
      await waitUntil(() => opOf(c, id).replyState === 'sending', 'the reply on its way');
      expect(opReusableDraft(opOf(c, id))).toBeNull();
      // the window's "重新托管…" / retry of that record, and a new click with an empty box alike
      const fromIt = c.startOp({ kind, key: K(ISSUE) }, { from: id });
      const fresh = c.startOp({ kind, key: K(ISSUE) });
      expect(fromIt.ok).toBe(false);
      expect(fresh.ok).toBe(false);
      hold();
      expect((await reply).ok).toBe(true);
      await idle(c);
      // the refused first one and the reply: never a third
      expect(commentsOnGitHub()).toEqual(['继续']);
      expect(commentWrites()).toEqual(['comment 继续', 'comment 继续']);
      expect(labelWrites()).toEqual([]);
      // once it went out, starting again from it changes the labels and posts no comment
      const again = c.startOp({ kind, key: K(ISSUE) }, { from: id });
      expect(again.ok).toBe(true);
      await idle(c);
      expect(commentWrites()).toEqual(['comment 继续', 'comment 继续']);
      expect(labelWrites()).toEqual(LABELS[kind]);
    });

    it(`${kind}: that reply's answer never came — starting again from it sends no comment`, async () => {
      const c = await ready();
      const id = await refusedFirst(c, kind);
      const lost = fake.dropAnswerWhen((e) => e.method === 'POST' && e.path.endsWith(`/issues/${ISSUE}/comments`));
      expect((await c.act({ kind: 'comment', key: K(ISSUE), body: '继续', draftOf: id })).ok).toBe(false);
      expect(lost.caught()).toBe(1);
      lost.stop();
      expect(opOf(c, id).replyState).toBe('unknown');
      expect(opReusableDraft(opOf(c, id))).toBeNull();
      // the item stays locked while that reply is not sure: nothing goes out
      const locked = c.startOp({ kind, key: K(ISSUE) }, { from: id });
      expect(locked.ok).toBe(false);
      expect(locked.error).toContain('上一次操作还没结清');
      // checked by a person and unlocked: starting again from it changes the labels and posts no comment
      c.opUnlock(id);
      const again = c.startOp({ kind, key: K(ISSUE) }, { from: id });
      expect(again.ok).toBe(true);
      await idle(c);
      expect(commentWrites()).toEqual(['comment 继续', 'comment 继续']);
      expect(labelWrites()).toEqual(LABELS[kind]);
    });

    it(`${kind}: the earlier record is gone — no comment of its own, the labels go out`, async () => {
      const c = await ready();
      const s = c.startOp({ kind, key: K(ISSUE) }, { from: 'op-not-here' });
      expect(s.ok).toBe(true);
      await idle(c);
      expect(handOverWrites()).toEqual(LABELS[kind]);
    });
  }
});

describe('「继续」 just sent from the reply box and still without a result', () => {
  for (const kind of KINDS) {
    it(`${kind}: refused, nothing sent; once that reply is through, the hand-over goes out with its own 「继续」`, async () => {
      const c = await ready();
      const hold = fake.holdWhen((e) => e.method === 'POST' && e.path.endsWith(`/issues/${ISSUE}/comments`));
      const reply = c.startSend({ kind: 'comment', key: K(ISSUE), body: '继续' });
      expect(reply.ok).toBe(true);
      await waitUntil(() => c.getState().sends.some((x) => x.id === reply.id && x.state === 'sending'), 'the reply on its way');
      const s = c.startOp({ kind, key: K(ISSUE) });
      expect(s.ok).toBe(false);
      expect(s.error).toContain('同样的一段评论刚从回复框发过');
      hold();
      await waitUntil(() => c.getState().sends.every((x) => x.id !== reply.id || x.state !== 'sending'), 'the reply answered');
      await idle(c);
      expect(handOverWrites()).toEqual(['comment 继续']);
      const after = c.startOp({ kind, key: K(ISSUE) });
      expect(after.ok).toBe(true);
      await idle(c);
      expect(handOverWrites()).toEqual(['comment 继续', 'comment 继续', ...LABELS[kind]]);
    });
  }
});

function labelsOn(): string[] {
  return (fake.state.repos.get('gigleai/cavil-loop')!.find((r: any) => r.number === ISSUE)?.labels ?? []).map((l: any) => l.name);
}
