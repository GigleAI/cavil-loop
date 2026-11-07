// GitHub#229: changes shown before GitHub confirms them, new issues that do not
// hold the dialog, the detail / label-list caches — the controller against the
// fake GitHub over real HTTP, with the real back end (Rust) as a child process and
// a real SQLite file. Every "nothing happened" assertion has a "this did happen"
// sibling (a write GitHub received, a record on disk, a read that went out).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { Controller, EDITS_KEY } from '../../src/app/controller';
import { Cache } from '../support/cache';
import { FileStore } from '../support/credentials';
import { HarnessBackend } from '../support/harness';
import type { Backend } from '../../src/backend/backend';
import { startFakeGitHub, FakeGitHub } from '../fake-github/server';
import { FAKE_TOKEN, FIXTURE_NOW, tempDir, trustedList } from './helpers';
import type { EditMark, Item } from '../../src/shared/types';

const PROJECT_URL = 'https://github.com/orgs/GigleAI/projects/11';
const PROJECT_KEY = 'project:org/gigleai/11';
const REPO = 'GigleAI/cavil-loop';
const K = (n: number) => `gigleai/cavil-loop#${n}`;
const N = 138;

let fake: FakeGitHub;
let dir: string;
let caches: Cache[] = [];
let controllers: Controller[] = [];
let backends: HarnessBackend[] = [];

async function ready(opts: { intercept?: (cmd: string, args: any, next: (cmd: string, args: any) => Promise<unknown>) => unknown; observeMs?: number; observeFirstMs?: number; keepFake?: boolean; repo?: boolean } = {}) {
  const cache = new Cache(join(dir, 'cache.sqlite'));
  caches.push(cache);
  cache.setSetting('trustedCredentials', trustedList(FAKE_TOKEN));
  const credentials = new FileStore(join(dir, 'cred'));
  await credentials.set(FAKE_TOKEN);
  const clock = { t: FIXTURE_NOW };
  const endpoints = { api: fake.api, web: fake.web };
  const harness = new HarnessBackend({ db: join(dir, 'cache.sqlite'), endpoints, credentials, now: () => clock.t, sleep: async () => {} });
  backends.push(harness);
  const backend: Backend = opts.intercept ? { call: async (cmd, args) => (opts.intercept!(cmd, args, (c2, a2) => harness.call(c2, a2)) as any) ?? harness.call(cmd, args) } : harness;
  const c = await Controller.create({ backend, endpoints, now: () => clock.t, defaultClientId: '', observeMs: opts.observeMs ?? 60_000, observeFirstMs: opts.observeFirstMs ?? 60_000 });
  controllers.push(c);
  if (!opts.keepFake) {
    fake.state.w.milestones.set('gigleai/cavil-loop', [
      { number: 3, title: 'v1', state: 'open', due_on: null },
      { number: 4, title: 'v2', state: 'open', due_on: null },
      { number: 5, title: 'v3', state: 'open', due_on: null },
      { number: 6, title: 'v5', state: 'open', due_on: null },
    ]);
  }
  if (!c.getState().sources.length) {
    c.addSource(PROJECT_URL);
    if (opts.repo !== false) c.addSource(REPO);
  }
  await c.start();
  await c.syncNow();
  expect(c.getState().phase).toBe('ready');
  return { c, cache };
}

const itemOf = (c: Controller, n = N): Item => {
  const it = c.getBoardData().items.find((i) => i.key === K(n));
  if (!it) throw new Error(`#${n} not on the board`);
  return it;
};
const markOf = (c: Controller, field: EditMark['field'], n = N) => itemOf(c, n).edits?.find((m) => m.field === field) ?? null;
/** GitHub's milestone of #n, as the fake holds it */
const milestoneOnGitHub = (n = N) => (fake.state.repos.get('gigleai/cavil-loop')!.find((r: any) => r.number === n) as any)?.milestone?.title ?? null;
/** somebody else (or a request that arrives late) sets the milestone on GitHub, straight through the fake's API */
async function milestoneBy(number: number | null, n = N) {
  const r = await fetch(`${fake.api}/repos/${REPO}/issues/${n}`, { method: 'PATCH', headers: { authorization: `Bearer ${FAKE_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ milestone: number }) });
  expect(r.status).toBe(200);
}
const milestoneWrites = () => fake.writes().filter((w) => w.method === 'PATCH' && w.path.endsWith(`/issues/${N}`));
const storedEdits = () => {
  const cache = new Cache(join(dir, 'cache.sqlite'));
  caches.push(cache);
  return ((cache.loadSnapshots().get(EDITS_KEY) as any)?.edits ?? null) as any[] | null;
};
async function until(pred: () => boolean, what: string) {
  for (let i = 0; i < 1000; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timeout waiting for: ${what}`);
}

beforeEach(async () => {
  fake = await startFakeGitHub();
  dir = tempDir();
});
afterEach(async () => {
  for (const c of controllers) c.stopTimer();
  await Promise.all(backends.map((b) => b.close()));
  for (const c of caches) c.close();
  caches = [];
  controllers = [];
  backends = [];
  await fake.close();
});

describe('a change shows at once and does not hold anything else', () => {
  it('the new milestone is on the item (marked "saving") before GitHub answers; another item changes meanwhile; the answer + re-read end the mark', async () => {
    const { c } = await ready();
    const release = fake.hold(`/issues/${N}`);
    const p = c.act({ kind: 'setMilestone', key: K(N), title: 'v2' });
    await until(() => markOf(c, 'milestone')?.status === 'saving', 'saving mark');
    expect(itemOf(c).milestone?.title).toBe('v2');
    // another item is not held up behind it
    const other = await c.act({ kind: 'addLabel', key: K(137), label: 'bug', color: 'd73a4a' });
    expect(other.ok).toBe(true);
    expect(itemOf(c, 137).labels.map((l) => l.name)).toContain('bug');
    expect(milestoneWrites()).toHaveLength(1);
    release();
    expect((await p).ok).toBe(true);
    expect(milestoneOnGitHub()).toBe('v2');
    expect(markOf(c, 'milestone')).toBeNull();
    expect(itemOf(c).milestone?.title).toBe('v2');
    // nothing left on disk
    await c.settled();
    expect(storedEdits()).toBeNull();
  });
});

describe('GitHub refused: the change stays, marked, and can be sent again', () => {
  it('a refused label keeps showing as "not saved" with GitHub\'s reason (the item keeps GitHub\'s labels); resend reads GitHub first, then sends', async () => {
    const { c } = await ready();
    fake.state.w.failLabel = 'x-fail';
    const r = await c.act({ kind: 'addLabel', key: K(N), label: 'x-fail', color: '000000' });
    expect(r.ok).toBe(false);
    const m = markOf(c, 'label')!;
    expect(m.status).toBe('failed');
    expect(m.failure).toMatch(/GitHub/);
    expect(itemOf(c).labels.map((l) => l.name)).not.toContain('x-fail');
    expect(c.getState().editsNeedingAction).toBe(1);
    expect(storedEdits()).toHaveLength(1);
    const posts = () => fake.writes().filter((w) => w.method === 'POST' && w.path.endsWith(`/issues/${N}/labels`)).length;
    expect(posts()).toBe(1);
    fake.state.w.failLabel = null;
    const again = await c.resendEdit(m.id);
    expect(again.ok).toBe(true);
    expect(posts()).toBe(2);
    expect(markOf(c, 'label')).toBeNull();
    expect(itemOf(c).labels.map((l) => l.name)).toContain('x-fail');
    expect(c.getState().editsNeedingAction).toBe(0);
  });
});

describe('Q1 = A: a resend reads GitHub first; changed by somebody (or unreadable) → held until "overwrite anyway"', () => {
  it('no answer → "not confirmed"; someone sets v5; resend sends nothing and says so; force sends', async () => {
    const { c } = await ready();
    await milestoneBy(3); // v1
    await c.syncNow();
    fake.state.w.dropWrites = true;
    const r = await c.act({ kind: 'setMilestone', key: K(N), title: 'v2' });
    expect(r.ok).toBe(false);
    expect(markOf(c, 'milestone')!.status).toBe('unconfirmed');
    // the item shows GitHub's value; the mark shows the wanted one
    expect(itemOf(c).milestone?.title).toBe('v1');
    expect(markOf(c, 'milestone')!.targetText).toBe('v2');
    fake.state.w.dropWrites = false;
    await milestoneBy(6); // somebody: v5
    const before = milestoneWrites().length;
    const held = await c.resendEdit(markOf(c, 'milestone')!.id);
    expect(held.ok).toBe(false);
    expect(held.error).toMatch(/有人改过/);
    expect(milestoneWrites().length).toBe(before);
    const m = markOf(c, 'milestone')!;
    expect(m.hold?.kind).toBe('changed');
    expect(m.github && 'text' in m.github ? m.github.text : null).toBe('v5');
    expect(m.changedByOthers).toBe(true);
    const forced = await c.resendEdit(m.id, true);
    expect(forced.ok).toBe(true);
    expect(milestoneWrites().length).toBe(before + 1);
    expect(milestoneOnGitHub()).toBe('v2');
    expect(markOf(c, 'milestone')).toBeNull();
  });

  it('GitHub unreadable at the check → held ("send anyway"); nothing sent until then', async () => {
    let failRefresh = false;
    const { c } = await ready({
      intercept: (cmd, args) => (failRefresh && cmd === 'request' && String(args.body ?? '').includes('CavilItemRefresh') ? { error: 'network', message: 'offline for this one' } : undefined),
    });
    fake.state.w.dropWrites = true;
    await c.act({ kind: 'setMilestone', key: K(N), title: 'v2' });
    fake.state.w.dropWrites = false;
    failRefresh = true;
    const before = milestoneWrites().length;
    const r = await c.resendEdit(markOf(c, 'milestone')!.id);
    expect(r.ok).toBe(false);
    expect(markOf(c, 'milestone')!.hold?.kind).toBe('unreadable');
    expect(milestoneWrites().length).toBe(before);
    failRefresh = false;
    expect((await c.resendEdit(markOf(c, 'milestone')!.id, true)).ok).toBe(true);
    expect(milestoneWrites().length).toBe(before + 1);
  });
});

describe('which reads count (路径丙 / 乙 / 甲 against the fake GitHub)', () => {
  it('路径丙: a sync that read GitHub before the write was accepted lands afterwards with the old value — the new value stays, the next read ends it', async () => {
    const { c } = await ready();
    await milestoneBy(3);
    await c.syncNow();
    const releaseSync = fake.holdWhen((e) => (e.method === 'GET' && /\/issues\?/.test(e.path)) || e.operation === 'CavilProjectItems');
    const sync = c.syncNow();
    await until(() => fake.log.some((e) => e.operation === 'CavilProjectItems' && e.status === 0), 'the sync read went out');
    const releaseRefresh = fake.holdWhen((e) => e.operation === 'CavilItemRefresh');
    const p = c.act({ kind: 'setMilestone', key: K(N), title: 'v2' });
    await until(() => markOf(c, 'milestone')?.status === 'verifying', 'accepted');
    releaseSync();
    await sync;
    // the round landed (its read was taken before the write) — the item still shows v2
    expect(markOf(c, 'milestone')?.status).toBe('verifying');
    expect(itemOf(c).milestone?.title).toBe('v2');
    releaseRefresh();
    expect((await p).ok).toBe(true);
    expect(markOf(c, 'milestone')).toBeNull();
    expect(milestoneOnGitHub()).toBe('v2');
  });

  it('路径乙: both answers lost; a read of v3 confirms it; the earlier v2 lands within the watch → "not saved, maybe changed back"', async () => {
    const { c } = await ready({ observeMs: 5_000, observeFirstMs: 150 });
    await milestoneBy(3);
    await c.syncNow();
    fake.state.w.dropWrites = true;
    await c.act({ kind: 'setMilestone', key: K(N), title: 'v2' });
    await c.act({ kind: 'setMilestone', key: K(N), title: 'v3' });
    expect(markOf(c, 'milestone')!.status).toBe('unconfirmed');
    fake.state.w.dropWrites = false;
    await milestoneBy(5); // v3 lands on GitHub
    await c.syncNow();
    expect(markOf(c, 'milestone')!.status).toBe('observing');
    await milestoneBy(4); // the earlier v2 lands late
    await until(() => markOf(c, 'milestone')?.status === 'failed', 'the watch read v2');
    const m = markOf(c, 'milestone')!;
    expect(m.failure).toMatch(/可能被它改回去了/);
    expect(m.targetText).toBe('v3');
    expect(milestoneOnGitHub()).toBe('v2');
    expect(itemOf(c).milestone?.title).toBe('v2');
  });

  it('路径甲: v2 unanswered, v3 accepted → watched; nothing lands → the watch ends and the record goes', async () => {
    const { c } = await ready({ observeMs: 400, observeFirstMs: 100 });
    fake.state.w.dropWrites = true;
    await c.act({ kind: 'setMilestone', key: K(N), title: 'v2' });
    fake.state.w.dropWrites = false;
    expect((await c.act({ kind: 'setMilestone', key: K(N), title: 'v3' })).ok).toBe(true);
    expect(markOf(c, 'milestone')!.status).toBe('observing');
    await until(() => markOf(c, 'milestone') === null, 'the watch ended');
    expect(itemOf(c).milestone?.title).toBe('v3');
    await c.settled();
    expect(storedEdits()).toBeNull();
  });
});

describe('kept on this computer, for this account only', () => {
  it('a restart shows the change not confirmed (路径庚) and sends nothing by itself', async () => {
    const first = await ready();
    fake.state.w.dropWrites = true;
    await first.c.act({ kind: 'setMilestone', key: K(N), title: 'v2' });
    fake.state.w.dropWrites = false;
    expect(storedEdits()).toHaveLength(1);
    first.c.stopTimer();
    await first.c.settled();
    const before = fake.writes().length;
    const { c } = await ready({ keepFake: true });
    expect(c.getState().editsNeedingAction).toBe(1);
    expect(markOf(c, 'milestone')!.status).toBe('unconfirmed');
    expect(markOf(c, 'milestone')!.targetText).toBe('v2');
    // the restart read GitHub (a sync ran) and wrote nothing
    expect(fake.log.filter((e) => e.operation === 'CavilProjectItems').length).toBeGreaterThan(1);
    expect(fake.writes().length).toBe(before);
  });

  it('signing out drops them with the cache (memory and disk)', async () => {
    const { c } = await ready();
    fake.state.w.failLabel = 'x-fail';
    await c.act({ kind: 'addLabel', key: K(N), label: 'x-fail' });
    expect(storedEdits()).toHaveLength(1);
    expect(c.getState().editsNeedingAction).toBe(1);
    await c.logout();
    await c.settled();
    expect(c.getState().editsNeedingAction).toBe(0);
    expect(storedEdits()).toBeNull();
    // signing in again (same account): the board comes back from GitHub, the old change does not
    c.setClientId(fake.state.oauthClientId);
    const p = c.startLogin();
    await until(() => c.getState().login.status === 'waiting', 'waiting for approval');
    fake.resolveGrant('approved');
    await p;
    expect(c.getState().phase).toBe('ready');
    expect(itemOf(c).labels.length).toBeGreaterThan(0);
    expect(markOf(c, 'label')).toBeNull();
    expect(c.getState().editsNeedingAction).toBe(0);
  });

  /** the stored row's requests, by answer: which save point a write of it is */
  const answersIn = (args: any): string[] =>
    (args.snapshots ?? []).filter((s: any) => s.sourceKey === EDITS_KEY).flatMap((s: any) => s.edits.flatMap((r: any) => r.reqs.map((q: any) => q.answer)));

  it('not stored (the change itself) → not sent', async () => {
    let refuse = false;
    let refused = 0;
    const { c } = await ready({
      intercept: (cmd, args) => {
        // only the first save point: the record with its request not yet marked as sent
        if (refuse && cmd === 'replaceSnapshots' && answersIn(args).includes('queued')) {
          refused++;
          throw new Error('disk full');
        }
        return undefined;
      },
    });
    refuse = true;
    const before = milestoneWrites().length;
    const r = await c.act({ kind: 'setMilestone', key: K(N), title: 'v2' });
    expect(refused).toBe(1);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/没能存到本机/);
    expect(milestoneWrites().length).toBe(before);
    refuse = false;
    expect((await c.act({ kind: 'setMilestone', key: K(N), title: 'v2' })).ok).toBe(true);
    expect(milestoneWrites().length).toBe(before + 1);
  });

  it('stored, but the "sent" mark not stored → not sent', async () => {
    let refuse = false;
    let refused = 0;
    const { c } = await ready({
      intercept: (cmd, args) => {
        // only the second save point: the request marked as sent (the first one went through)
        if (refuse && cmd === 'replaceSnapshots' && answersIn(args).includes('waiting')) {
          refused++;
          throw new Error('disk full');
        }
        return undefined;
      },
    });
    refuse = true;
    const before = milestoneWrites().length;
    const r = await c.act({ kind: 'setMilestone', key: K(N), title: 'v2' });
    expect(refused).toBe(1);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/没能存到本机/);
    expect(milestoneWrites().length).toBe(before);
    expect(markOf(c, 'milestone')!.status).toBe('failed');
  });
});

describe('the item\'s queue (code review round 1)', () => {
  it('a newer change of the same field, made while the earlier one waits for the credential check, is not lost: both go out in order, GitHub ends on the newer', async () => {
    let gate: Promise<void> | null = null;
    let open!: () => void;
    let held = 0;
    const { c } = await ready({
      intercept: (cmd, args, next) => {
        if (cmd === 'ensureFresh' && gate) {
          held++;
          const g = gate;
          gate = null;
          return g.then(() => next(cmd, args));
        }
        return undefined;
      },
    });
    gate = new Promise<void>((r) => (open = r));
    const p2 = c.act({ kind: 'setMilestone', key: K(N), title: 'v2' });
    await until(() => held === 1, 'the v2 send waits on the credential check');
    const p3 = c.act({ kind: 'setMilestone', key: K(N), title: 'v3' });
    await until(() => markOf(c, 'milestone')?.targetText === 'v3', 'v3 recorded');
    await c.settled();
    open();
    const [r2, r3] = await Promise.all([p2, p3]);
    expect(r2.ok).toBe(true);
    expect(r3.ok).toBe(true);
    expect(milestoneWrites().map((w) => (w.body as any).milestone)).toEqual([4, 5]);
    expect(milestoneOnGitHub()).toBe('v3');
    expect(itemOf(c).milestone?.title).toBe('v3');
    expect(markOf(c, 'milestone')).toBeNull();
  });

  it('the re-read after an accepted change does not hold the item\'s next write', async () => {
    const { c } = await ready();
    const release = fake.holdWhen((e) => e.operation === 'CavilItemRefresh');
    const p1 = c.act({ kind: 'setMilestone', key: K(N), title: 'v2' });
    await until(() => fake.log.some((e) => e.operation === 'CavilItemRefresh'), 'the re-read went out (and is held)');
    const labelPosts = () => fake.writes().filter((w) => w.method === 'POST' && w.path.endsWith(`/issues/${N}/labels`)).length;
    const p2 = c.act({ kind: 'addLabel', key: K(N), label: 'bug', color: 'd73a4a' });
    await until(() => labelPosts() === 1, 'the label write reached GitHub while the re-read is still held');
    release();
    expect((await p1).ok).toBe(true);
    expect((await p2).ok).toBe(true);
    expect(milestoneOnGitHub()).toBe('v2');
    expect(itemOf(c).labels.map((l) => l.name)).toContain('bug');
  });
});

describe('a read that comes back after a newer one does not put the older value back (code review round 5)', () => {
  const diskLabels = (sourceKey: string) => {
    const cache = new Cache(join(dir, 'cache.sqlite'));
    caches.push(cache);
    return (cache.loadSnapshots().get(sourceKey)?.items.find((i) => i.key === K(N))?.labels ?? []).map((l) => l.name);
  };
  const labelsOnGitHub = () => ((fake.state.repos.get('gigleai/cavil-loop')!.find((r: any) => r.number === N) as any)?.labels ?? []).map((l: any) => l.name);

  it('the first re-read (no "bug" yet) is held; the second (with "bug") lands; the first comes back last — board and disk keep "bug"', async () => {
    const { c } = await ready();
    let seen = 0;
    const release = fake.holdWhen((e) => e.operation === 'CavilItemRefresh' && ++seen === 1);
    const p1 = c.act({ kind: 'setMilestone', key: K(N), title: 'v2' });
    await until(() => seen >= 1, 'the first re-read went out (and is held)');
    const p2 = c.act({ kind: 'addLabel', key: K(N), label: 'bug', color: 'd73a4a' });
    expect((await p2).ok).toBe(true);
    // this did happen: the second re-read ran and the board shows its answer
    expect(fake.log.filter((e) => e.operation === 'CavilItemRefresh').length).toBeGreaterThanOrEqual(2);
    expect(itemOf(c).labels.map((l) => l.name)).toContain('bug');
    release();
    expect(await p1).toMatchObject({ ok: true, warning: null });
    await c.settled();
    expect(labelsOnGitHub()).toContain('bug');
    expect(itemOf(c).labels.map((l) => l.name)).toContain('bug');
    expect(diskLabels(PROJECT_KEY)).toContain('bug');
    expect(diskLabels(`repo:${REPO.toLowerCase()}`)).toContain('bug');
    expect(milestoneOnGitHub()).toBe('v2');
    expect(itemOf(c).milestone?.title).toBe('v2');
  });

  it('a re-read sent before a sync round comes back after the round landed: the round\'s newer copy stays', async () => {
    const { c } = await ready();
    let seen = 0;
    const release = fake.holdWhen((e) => e.operation === 'CavilItemRefresh' && ++seen === 1);
    const p1 = c.act({ kind: 'setMilestone', key: K(N), title: 'v2' });
    await until(() => seen >= 1, 'the re-read went out (and is held, without "bug")');
    // somebody adds "bug" on GitHub; a whole round reads it and lands
    const r = await fetch(`${fake.api}/repos/${REPO}/issues/${N}/labels`, { method: 'POST', headers: { authorization: `Bearer ${FAKE_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ labels: ['bug'] }) });
    expect(r.status).toBe(200);
    await c.syncNow();
    expect(itemOf(c).labels.map((l) => l.name)).toContain('bug');
    expect(diskLabels(PROJECT_KEY)).toContain('bug');
    release();
    expect((await p1).ok).toBe(true);
    await c.settled();
    expect(itemOf(c).labels.map((l) => l.name)).toContain('bug');
    expect(diskLabels(PROJECT_KEY)).toContain('bug');
    expect(diskLabels(`repo:${REPO.toLowerCase()}`)).toContain('bug');
  });

  it('a round that comes back while a re-read is still on its way to the disk is built on that re-read (the disk keeps it)', async () => {
    let gate: (() => void) | null = null;
    let gated = 0;
    const { c } = await ready({
      intercept: (cmd, args, next) => {
        // the re-read's write of the Project row (#N with "bug") waits until the round's answer is in
        const row = (args?.snapshots ?? []).find((x: any) => x.sourceKey === PROJECT_KEY);
        const mine = row?.items.find((i: any) => i.key === K(N));
        if (cmd === 'replaceSnapshots' && !gated && mine?.labels.some((l: any) => l.name === 'bug')) {
          gated++;
          return new Promise<void>((r) => (gate = r)).then(() => next(cmd, args));
        }
        return undefined;
      },
    });
    const page = (e: { operation?: string; variables?: Record<string, unknown> }, after: string | null) => e.operation === 'CavilProjectItems' && (e.variables?.after ?? null) === after;
    let armed = false;
    let next = false;
    let asked = 0;
    const releaseOld = fake.holdWhen((e) => page(e, 'cursor-1') && !armed && ++asked > 0);
    // (the round the landings ask for afterwards stays held: what is checked is what the old round left)
    fake.holdWhen((e) => page(e, null) && armed && (next = true));
    void c.syncNow();
    await until(() => asked > 0, 'the round asked for the page with #138 (held, without "bug")');
    const p1 = c.act({ kind: 'addLabel', key: K(N), label: 'bug', color: 'd73a4a' });
    await until(() => gate !== null, 'the re-read is on its way to the disk (held)');
    armed = true;
    releaseOld();
    // the round's answer is in and the round reaches its landing while the re-read still writes
    await new Promise((r) => setTimeout(r, 200));
    gate!();
    expect((await p1).ok).toBe(true);
    await until(() => next, 'the old round landed and the next one is held');
    await c.settled();
    expect(diskLabels(PROJECT_KEY)).toContain('bug');
    expect(itemOf(c).labels.map((l) => l.name)).toContain('bug');
  });

  it('a sync round that read GitHub before a re-read lands after it: the re-read\'s copy stays (board and disk)', async () => {
    const { c } = await ready();
    const reads = () => fake.log.filter((e) => e.operation === 'CavilProjectItems' && e.variables?.after === 'cursor-1').length;
    const before = reads();
    // the round's Project page carrying #138 (the second) is held, its answer frozen without
    // "bug"; once it is let go, the first page of the next round (the one the re-read asks
    // for) is held, so what is checked in between is what the old round left
    const page = (e: { operation?: string; variables?: Record<string, unknown> }, after: string | null) => e.operation === 'CavilProjectItems' && (e.variables?.after ?? null) === after;
    let armed = false;
    let landedOld = false;
    const releaseOld = fake.holdWhen((e) => page(e, 'cursor-1') && !armed);
    const releaseNext = fake.holdWhen((e) => page(e, null) && armed && (landedOld = true));
    const round = c.syncNow();
    await until(() => reads() > before, 'the round asked for the page with #138 (held)');
    expect((await c.act({ kind: 'addLabel', key: K(N), label: 'bug', color: 'd73a4a' })).ok).toBe(true);
    expect(itemOf(c).labels.map((l) => l.name)).toContain('bug');
    expect(diskLabels(PROJECT_KEY)).toContain('bug');
    armed = true;
    releaseOld();
    await until(() => landedOld, 'the old round landed and the next round read the Project (held)');
    await c.settled();
    expect(labelsOnGitHub()).toContain('bug');
    expect(itemOf(c).labels.map((l) => l.name)).toContain('bug');
    expect(diskLabels(PROJECT_KEY)).toContain('bug');
    releaseNext();
    await round;
    await c.settled();
    // the next round (issued after the re-read) still lands as usual
    expect(itemOf(c).labels.map((l) => l.name)).toContain('bug');
    expect(diskLabels(PROJECT_KEY)).toContain('bug');
  });
});

describe('GitHub#245: the hand-over picked in the dialog is remembered only once the issue exists', () => {
  const setRepoLabels = (names: string[]) => fake.state.w.repoLabels.set('gigleai/cavil-loop', names.map((name) => ({ name, color: 'ededed' })));
  const start = (c: Controller, title: string, handoff: 'none' | 'agent' | 'autopilot', handoffPicked: boolean) =>
    c.startCreate({ kind: 'createIssue', repo: REPO, title, body: '', labels: [], projects: [], handoff, handoffPicked });

  it('picked by hand and created: remembered; not picked (the remembered one or a fallback): unchanged; refused or failed: unchanged, the draft keeps it', async () => {
    const { c } = await ready();
    setRepoLabels(['autopilot', 'pending/agent']);
    expect(c.getState().newIssueHandoff).toBe('none');
    // picked and created
    await start(c, 'a', 'autopilot', true);
    await until(() => c.getState().creates.length === 0 && c.getState().focus !== null, 'created');
    expect(c.getState().newIssueHandoff).toBe('autopilot');
    // the dialog fell back to a plain issue (not picked here): created, nothing remembered
    await start(c, 'b', 'none', false);
    await until(() => c.getState().creates.length === 0 && fake.state.repos.get('gigleai/cavil-loop')!.some((r: any) => r.title === 'b'), 'created b');
    expect(c.getState().newIssueHandoff).toBe('autopilot');
    // picked by hand, but the create surely failed (the label list cannot be read): not remembered; the draft keeps the choice
    fake.state.w.failLabels.add('gigleai/cavil-loop');
    await start(c, 'c', 'agent', true);
    await until(() => c.getState().creates[0]?.status === 'failed', 'failed');
    expect(c.getState().newIssueHandoff).toBe('autopilot');
    expect(c.getState().creates[0].draft).toMatchObject({ title: 'c', handoff: 'agent', handoffPicked: true });
    expect(c.getState().creates[0].message).toContain('读不到');
  });
});

describe('GitHub#245 (PR #249 review round 1): dropped labels and a refused board are both said; a board retry keeps the label part', () => {
  it('labels dropped and the board refused: the notice names both; after the board joins on retry, the label part stays', async () => {
    const { c } = await ready();
    fake.state.w.repoLabels.set('gigleai/cavil-loop', ['autopilot', 'pending/agent'].map((name) => ({ name, color: 'ededed' })));
    fake.state.w.dropIssueLabels.add('gigleai/cavil-loop');
    fake.state.w.readOnlyProjects.add('org/gigleai/11');
    await c.startCreate({ kind: 'createIssue', repo: REPO, title: 'both', body: '', labels: [], projects: [PROJECT_KEY], handoff: 'autopilot', handoffPicked: true });
    await until(() => c.getState().creates[0]?.status === 'partial', 'partial');
    // the create request did carry both labels
    expect((fake.writes().find((w) => w.method === 'POST' && w.path === '/api/repos/GigleAI/cavil-loop/issues')?.body as any)?.labels).toEqual(['autopilot', 'pending/agent']);
    const job = c.getState().creates[0];
    expect(job.message).toContain('「autopilot」、「pending/agent」');
    expect(job.message).toContain('还没有交给 agent');
    expect(job.message).toContain('没能加入看板 「cavil project」');
    // the board joins on retry: the board part goes, the label part stays (nothing about the labels was fixed)
    fake.state.w.readOnlyProjects.delete('org/gigleai/11');
    expect((await c.retryCreateProjects(job.id)).ok).toBe(true);
    const after = c.getState().creates.find((j) => j.id === job.id);
    expect(after?.message).toContain('还没有交给 agent');
    expect(after?.message).not.toContain('没能加入看板');
    expect(fake.writes().filter((w) => w.operation === 'CavilAddProjectItem').length).toBe(2);
  });
});

describe('a new issue does not hold the dialog: four outcomes', () => {
  const issuesOnGitHub = () => fake.state.repos.get('gigleai/cavil-loop')!.length;
  const create = (c: Controller, title: string, projects: string[] = []) => c.startCreate({ kind: 'createIssue', repo: REPO, title, body: 'b', labels: [], projects });

  it('created: no notice left, the new issue opens', async () => {
    const { c } = await ready();
    const before = issuesOnGitHub();
    expect((await create(c, 'one')).ok).toBe(true);
    await until(() => c.getState().creates.length === 0 && c.getState().focus !== null, 'created');
    expect(issuesOnGitHub()).toBe(before + 1);
    expect(c.getState().focus?.key).toMatch(/^gigleai\/cavil-loop#\d+$/);
  });

  it('created but a board refused it: only "open #N" / "add to the board again" — the retry adds that issue, never a new one', async () => {
    const { c } = await ready();
    fake.state.w.readOnlyProjects.add('org/gigleai/11');
    const before = issuesOnGitHub();
    await create(c, 'two', [PROJECT_KEY]);
    await until(() => c.getState().creates[0]?.status === 'partial', 'partial');
    const job = c.getState().creates[0];
    expect(job.boards?.map((b) => [b.projectKey, b.state])).toEqual([[PROJECT_KEY, 'missing']]);
    expect(issuesOnGitHub()).toBe(before + 1);
    fake.state.w.readOnlyProjects.delete('org/gigleai/11');
    expect((await c.retryCreateProjects(job.id)).ok).toBe(true);
    expect(c.getState().creates).toEqual([]);
    expect(issuesOnGitHub()).toBe(before + 1);
    expect(fake.writes().filter((w) => w.operation === 'CavilAddProjectItem').length).toBe(2);
  });

  it('only Project sources: the created issue is on no source, the retry still joins it (by the node id from the create answer)', async () => {
    const { c } = await ready({ repo: false });
    expect(c.getState().sources.map((s) => s.kind)).toEqual(['project']);
    fake.state.w.readOnlyProjects.add('org/gigleai/11');
    const before = issuesOnGitHub();
    await create(c, 'project only', [PROJECT_KEY]);
    await until(() => c.getState().creates[0]?.status === 'partial', 'partial');
    const job = c.getState().creates[0];
    expect(c.getBoardData().items.some((i) => i.key === job.createdKey)).toBe(false);
    fake.state.w.readOnlyProjects.delete('org/gigleai/11');
    const r = await c.retryCreateProjects(job.id);
    expect(r).toMatchObject({ ok: true });
    expect(c.getState().creates).toEqual([]);
    expect(issuesOnGitHub()).toBe(before + 1);
    expect(fake.writes().filter((w) => w.operation === 'CavilAddProjectItem').length).toBe(2);
    expect(c.getBoardData().items.some((i) => i.key === job.createdKey)).toBe(true);
  });

  it('code review round 2: the retry joins the board but its status is refused — the notice stays and says so (nothing new created)', async () => {
    const { c } = await ready({ repo: false });
    fake.state.w.readOnlyProjects.add('org/gigleai/11');
    const before = issuesOnGitHub();
    await c.startCreate({
      kind: 'createIssue',
      repo: REPO,
      title: 'field fails on retry',
      body: '',
      labels: [],
      projects: [PROJECT_KEY],
      plan: { milestone: null, projects: [{ projectKey: PROJECT_KEY, iterationId: null, status: 'In progress' }] },
    });
    await until(() => c.getState().creates[0]?.status === 'partial', 'partial');
    const job = c.getState().creates[0];
    expect(job.boards).toMatchObject([{ projectKey: PROJECT_KEY, state: 'missing', iterationId: null, status: 'In progress' }]);
    fake.state.w.readOnlyProjects.delete('org/gigleai/11');
    // the join's answer is held; meanwhile the board turns read-only, so the status write that follows is refused
    const release = fake.holdWhen((e) => e.operation === 'CavilAddProjectItem');
    const p = c.retryCreateProjects(job.id);
    await until(() => fake.log.filter((e) => e.operation === 'CavilAddProjectItem').length === 2, 'the retry\'s join went out');
    fake.state.w.readOnlyProjects.add('org/gigleai/11');
    release();
    const r = await p;
    expect(r.ok).toBe(true);
    expect(r.warning).toMatch(/字段没设上/);
    // the status write really went out and was refused
    expect(fake.log.filter((e) => e.operation === 'CavilSetStatus' && e.status === 200).length).toBe(1);
    const left = c.getState().creates.find((j) => j.id === job.id)!;
    expect(left).toBeDefined();
    expect(left.status).toBe('partial');
    expect(left.boards?.map((b) => [b.projectKey, b.state])).toEqual([[PROJECT_KEY, 'fieldsFailed']]);
    expect(left.message).toMatch(/字段没设上/);
    expect(issuesOnGitHub()).toBe(before + 1);
  });

  it('created with a field refused: the notice says so, keeps saying so after a retry, and offers no retry for it', async () => {
    const { c } = await ready({ repo: false });
    const release = fake.holdWhen((e) => e.operation === 'CavilAddProjectItem');
    await c.startCreate({
      kind: 'createIssue',
      repo: REPO,
      title: 'field refused at creation',
      body: '',
      labels: [],
      projects: [PROJECT_KEY],
      plan: { milestone: null, projects: [{ projectKey: PROJECT_KEY, iterationId: null, status: 'In progress' }] },
    });
    await until(() => fake.log.some((e) => e.operation === 'CavilAddProjectItem'), 'the join went out');
    fake.state.w.readOnlyProjects.add('org/gigleai/11');
    release();
    await until(() => c.getState().creates[0]?.status === 'partial', 'partial');
    const job = c.getState().creates[0];
    expect(fake.log.filter((e) => e.operation === 'CavilSetStatus').length).toBe(1);
    expect(job.boards?.map((b) => [b.projectKey, b.state])).toEqual([[PROJECT_KEY, 'fieldsFailed']]);
    expect(job.message).toMatch(/字段没设上 「cavil project」/);
    // a retry has nothing to add (the issue is on the board): the notice is unchanged, nothing is sent
    const writes = fake.writes().length;
    await c.retryCreateProjects(job.id);
    expect(fake.writes().length).toBe(writes);
    expect(c.getState().creates.find((j) => j.id === job.id)?.message).toBe(job.message);
  });

  it('code review round 3: two boards — A joins but its status is refused, B still refused; a second retry joins B — A\'s unfinished field is still said', async () => {
    // a second Project (B) on the fake GitHub: the recorded one under another number and node id
    const pagesB = JSON.parse(JSON.stringify(fake.state.projects.get('org/gigleai/11')));
    for (const pg of pagesB) {
      pg.id = 'PVT_fixture_second';
      pg.title = 'second board';
      pg.url = 'https://github.com/orgs/GigleAI/projects/12';
    }
    fake.state.projects.set('org/gigleai/12', pagesB);
    const { c } = await ready({ repo: false });
    c.addSource('https://github.com/orgs/GigleAI/projects/12');
    await c.syncNow();
    const B = 'project:org/gigleai/12';
    expect(c.getState().sources.map((x) => x.key)).toEqual([PROJECT_KEY, B]);
    fake.state.w.readOnlyProjects.add('org/gigleai/11');
    fake.state.w.readOnlyProjects.add('org/gigleai/12');
    const before = issuesOnGitHub();
    await c.startCreate({
      kind: 'createIssue',
      repo: REPO,
      title: 'two boards',
      body: '',
      labels: [],
      projects: [PROJECT_KEY, B],
      plan: { milestone: null, projects: [{ projectKey: PROJECT_KEY, iterationId: null, status: 'In progress' }, { projectKey: B, iterationId: null, status: null }] },
    });
    await until(() => c.getState().creates[0]?.status === 'partial', 'partial');
    const job = c.getState().creates[0];
    // first retry: A joins (its answer held while A turns read-only again, so its status is refused); B still refused
    fake.state.w.readOnlyProjects.delete('org/gigleai/11');
    const release = fake.holdWhen((e) => e.operation === 'CavilAddProjectItem' && e.variables?.projectId === 'PVT_fixture_435fd6e043de');
    const joinsA = () => fake.log.filter((e) => e.operation === 'CavilAddProjectItem' && e.variables?.projectId === 'PVT_fixture_435fd6e043de').length;
    const first = c.retryCreateProjects(job.id);
    await until(() => joinsA() === 2, 'A\'s join went out');
    fake.state.w.readOnlyProjects.add('org/gigleai/11');
    release();
    const r1 = await first;
    expect(r1.ok).toBe(false);
    let now = c.getState().creates.find((j) => j.id === job.id)!;
    expect(now.boards?.map((b) => [b.projectKey, b.state])).toEqual([[PROJECT_KEY, 'fieldsFailed'], [B, 'missing']]);
    expect(now.message).toMatch(/没能加入看板 「second board」/);
    expect(now.message).toMatch(/字段没设上 「cavil project」/);
    // second retry: only B is let in; A is not touched
    fake.state.w.readOnlyProjects.delete('org/gigleai/12');
    const statusWrites = () => fake.log.filter((e) => e.operation === 'CavilSetStatus').length;
    const s0 = statusWrites();
    const r2 = await c.retryCreateProjects(job.id);
    expect(r2.ok).toBe(true);
    // B tried at creation, on the first retry (refused) and now (joined)
    expect(fake.log.filter((e) => e.operation === 'CavilAddProjectItem' && e.variables?.projectId === 'PVT_fixture_second').length).toBe(3);
    expect(c.getBoardData().items.some((i) => i.key === now.createdKey && i.projects.some((m) => m.projectKey === B))).toBe(true);
    expect(statusWrites()).toBe(s0);
    now = c.getState().creates.find((j) => j.id === job.id)!;
    expect(now).toBeDefined();
    expect(now.boards?.map((b) => [b.projectKey, b.state])).toEqual([[PROJECT_KEY, 'fieldsFailed']]);
    expect(now.message).toMatch(/字段没设上 「cavil project」/);
    expect(now.message).not.toMatch(/second board/);
    // nothing left to retry on A: the notice stays until the person closes it
    expect(c.getState().creates.find((j) => j.id === job.id)!.boards!.some((b) => b.state === 'missing')).toBe(false);
    c.dismissCreate(job.id);
    expect(c.getState().creates).toEqual([]);
    expect(issuesOnGitHub()).toBe(before + 1);
  });

  it('no answer: "not sure" — no create button, nothing claimed, nothing sent again; the issue appearing later changes none of that', async () => {
    const { c } = await ready();
    fake.state.w.dropWrites = true;
    const before = issuesOnGitHub();
    await create(c, 'three');
    await until(() => c.getState().creates[0]?.status === 'unknown' && c.getState().creates[0]?.candidates !== undefined, 'unknown + candidates read');
    expect(c.getState().creates[0].candidates).toEqual([]);
    expect(c.getState().creates[0].draft.title).toBe('three');
    fake.state.w.dropWrites = false;
    expect(issuesOnGitHub()).toBe(before);
    await c.syncNow();
    expect(c.getState().creates[0].status).toBe('unknown');
    expect(fake.writes().filter((w) => w.method === 'POST' && w.path.endsWith('/issues'))).toHaveLength(0);
  });

  it('refused for sure (403): the draft comes back; refused before sending (offline) keeps the dialog', async () => {
    const { c } = await ready();
    fake.state.w.readOnlyRepos.add('gigleai/cavil-loop');
    await create(c, 'four');
    await until(() => c.getState().creates[0]?.status === 'failed', 'failed');
    expect(c.getState().creates[0].draft).toMatchObject({ title: 'four', body: 'b', repo: REPO });
    fake.state.offline = true;
    await c.syncNow();
    const r = await create(c, 'five');
    expect(r.ok).toBe(false);
    expect(c.getState().creates.map((j) => j.title)).toEqual(['four']);
  });
});

describe('detail and label lists: kept for this run', () => {
  it('a detail read is shown again on re-opening; signing out forgets it', async () => {
    const { c } = await ready();
    expect(await c.cachedDetail(K(N))).toBeNull();
    const r = await c.loadDetail(K(N));
    expect(r.ok).toBe(true);
    expect(c.cachedDetail(K(N))?.number).toBe(N);
    await c.logout();
    expect(c.cachedDetail(K(N))).toBeNull();
  });

  it('a failed list is not kept (the next call reads again); a good one is (no request); "fresh" reads again', async () => {
    const { c } = await ready();
    const lists = () => fake.log.filter((e) => e.path.includes('/milestones')).length;
    fake.state.w.failMilestones.add('gigleai/cavil-loop');
    expect((await c.repoOptions(REPO)).error).toMatch(/读取/);
    fake.state.w.failMilestones.delete('gigleai/cavil-loop');
    const ok = await c.repoOptions(REPO);
    expect(ok.error).toBeNull();
    expect(ok.milestones.map((m) => m.title)).toContain('v2');
    const n = lists();
    expect((await c.repoOptions(REPO)).error).toBeNull();
    expect(lists()).toBe(n);
    expect((await c.repoOptions(REPO, true)).error).toBeNull();
    expect(lists()).toBe(n + 1);
  });

  it('a lost connection on the list is tried once more before it is reported', async () => {
    let drops = 1;
    const { c } = await ready({
      intercept: (cmd, args) => (cmd === 'request' && String(args.url).includes('/milestones') && drops-- > 0 ? { error: 'network', message: 'reset' } : undefined),
    });
    const r = await c.repoOptions(REPO);
    expect(r.error).toBeNull();
    expect(drops).toBe(-1);
  });
});

describe('every decision on GitHub\'s value reads landed reads only (PR #240 plan revision 1)', () => {
  const refreshes = () => fake.log.filter((e) => e.operation === 'CavilItemRefresh').length;
  /** a not-confirmed milestone change v1 → v2 (its write got no answer), ready to be sent again */
  async function unconfirmedV2(c: Controller) {
    await milestoneBy(3); // v1
    await c.syncNow();
    fake.state.w.dropWrites = true;
    await c.act({ kind: 'setMilestone', key: K(N), title: 'v2' });
    fake.state.w.dropWrites = false;
    const m = markOf(c, 'milestone')!;
    expect(m.status).toBe('unconfirmed');
    return m.id;
  }
  /** fail the next write of board rows (not the changes' own row) — `gate` holds it first when given */
  function failingDisk() {
    const st = { armed: false, failed: 0, gate: null as Promise<void> | null };
    const intercept = async (cmd: string, args: any, next: (cmd: string, args: any) => Promise<unknown>) => {
      if (cmd === 'replaceSnapshots' && st.armed && (args?.snapshots ?? []).some((x: any) => x.sourceKey !== EDITS_KEY)) {
        st.armed = false;
        if (st.gate) await st.gate;
        st.failed++;
        throw new Error('disk full');
      }
      return next(cmd, args);
    };
    return { st, intercept };
  }

  it('1. the check\'s answer (v1) comes back after a round landed v5: held as changed by somebody — nothing sent, GitHub keeps v5', async () => {
    const { c } = await ready();
    const id = await unconfirmedV2(c);
    let seen = 0;
    const release = fake.holdWhen((e) => e.operation === 'CavilItemRefresh' && ++seen === 1);
    const p = c.resendEdit(id);
    await until(() => seen >= 1, 'the check read went out (held, frozen at v1)');
    await milestoneBy(6); // somebody: v5
    await c.syncNow();
    expect(markOf(c, 'milestone')!.github && 'text' in markOf(c, 'milestone')!.github! ? (markOf(c, 'milestone')!.github as any).text : null).toBe('v5');
    const before = milestoneWrites().length;
    release();
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/有人改过/);
    expect(milestoneWrites().length).toBe(before);
    expect(milestoneOnGitHub()).toBe('v5');
    expect(markOf(c, 'milestone')!.hold?.kind).toBe('changed');
  });

  it('2. the check\'s answer comes back after a round that still read v1: sent as usual (not every overtaken check is held)', async () => {
    const { c } = await ready();
    const id = await unconfirmedV2(c);
    let seen = 0;
    const release = fake.holdWhen((e) => e.operation === 'CavilItemRefresh' && ++seen === 1);
    const p = c.resendEdit(id);
    await until(() => seen >= 1, 'the check read went out (held)');
    await c.syncNow();
    const before = milestoneWrites().length;
    release();
    expect((await p).ok).toBe(true);
    expect(milestoneWrites().length).toBe(before + 1);
    expect(milestoneOnGitHub()).toBe('v2');
  });

  it('3. the check read GitHub (v5) but its rows did not reach the disk: no evidence — held as unreadable, nothing sent, the board keeps v1', async () => {
    const disk = failingDisk();
    const { c } = await ready({ intercept: disk.intercept });
    const id = await unconfirmedV2(c);
    await milestoneBy(6); // GitHub: v5; the cache: v1
    disk.st.armed = true;
    const before = milestoneWrites().length;
    const reads = refreshes();
    const r = await c.resendEdit(id);
    expect(refreshes()).toBe(reads + 1);
    expect(disk.st.failed).toBe(1);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/读不到/);
    expect(markOf(c, 'milestone')!.hold?.kind).toBe('unreadable');
    expect(milestoneWrites().length).toBe(before);
    expect(milestoneOnGitHub()).toBe('v5');
    // the disk works again: the next check reads v5 and holds it as changed by somebody
    const again = await c.resendEdit(id);
    expect(again.error).toMatch(/有人改过/);
    expect(milestoneWrites().length).toBe(before);
  });

  it('4. a newer read\'s rows did not reach the disk; an older answer comes back later: the older one lands on the board, the check still has no evidence', async () => {
    const disk = failingDisk();
    const { c } = await ready({ intercept: disk.intercept });
    const id = await unconfirmedV2(c);
    let seen = 0;
    const release = fake.holdWhen((e) => e.operation === 'CavilItemRefresh' && ++seen === 1);
    // the older read: the re-read after a label change, held (frozen with "bug" and v1)
    const p1 = c.act({ kind: 'addLabel', key: K(N), label: 'bug', color: 'd73a4a' });
    await until(() => seen >= 1, 'the older re-read went out (held)');
    await milestoneBy(6);
    disk.st.armed = true;
    const before = milestoneWrites().length;
    const r = await c.resendEdit(id);
    expect(disk.st.failed).toBe(1);
    expect(r.error).toMatch(/读不到/);
    release();
    expect((await p1).ok).toBe(true);
    await c.settled();
    // the older answer is newer than what the board had: it landed
    expect(itemOf(c).labels.map((l) => l.name)).toContain('bug');
    // and it never counted for the check
    expect(markOf(c, 'milestone')!.hold?.kind).toBe('unreadable');
    expect(milestoneWrites().length).toBe(before);
    expect(milestoneOnGitHub()).toBe('v5');
  });

  it('5 + 9. the check read fails after a round issued later landed v5: decided on v5; the late failure does not say "unreadable"', async () => {
    let gate: (() => void) | null = null;
    let failNext = false;
    const { c } = await ready({
      intercept: (cmd, args, next) => {
        if (failNext && cmd === 'request' && String(args.body ?? '').includes('CavilItemRefresh')) {
          failNext = false;
          return new Promise((r) => (gate = () => r({ error: 'network', message: 'offline for this one' })));
        }
        return undefined;
      },
    });
    const id = await unconfirmedV2(c);
    failNext = true;
    const p = c.resendEdit(id);
    await until(() => gate !== null, 'the check read is on its way (it will fail)');
    await milestoneBy(6);
    await c.syncNow();
    const before = milestoneWrites().length;
    gate!();
    const r = await p;
    expect(r.error).toMatch(/有人改过/);
    expect(milestoneWrites().length).toBe(before);
    const m = markOf(c, 'milestone')!;
    expect(m.hold?.kind).toBe('changed');
    expect(m.github && 'unreadable' in m.github).toBe(false);
  });

  it('6a. the only source is removed while the check\'s rows are being written: nothing counts — held as unreadable', async () => {
    const disk = { gate: null as (() => void) | null, armed: false };
    const { c } = await ready({
      repo: false,
      intercept: (cmd, args, next) => {
        if (disk.armed && cmd === 'replaceSnapshots' && (args?.snapshots ?? []).some((x: any) => x.sourceKey === PROJECT_KEY)) {
          disk.armed = false;
          return new Promise<void>((r) => (disk.gate = r)).then(() => next(cmd, args));
        }
        return undefined;
      },
    });
    const id = await unconfirmedV2(c);
    await milestoneBy(4); // v2 itself is on GitHub now — the raw answer would say "nothing to send"… or "base": either way it must not count
    disk.armed = true;
    const before = milestoneWrites().length;
    const p = c.resendEdit(id);
    await until(() => disk.gate !== null, 'the check\'s rows are on their way to the disk');
    c.removeSource(PROJECT_KEY);
    disk.gate!();
    const r = await p;
    expect(r.ok).toBe(false);
    expect(milestoneWrites().length).toBe(before);
    // the item is on no board now; the record says why it was not sent
    await c.settled();
    expect(storedEdits()?.[0]?.hold?.kind).toBe('unreadable');
  });

  it('6b. signed out while the check\'s rows are being written: nothing is sent', async () => {
    const disk = { gate: null as (() => void) | null, armed: false };
    const { c } = await ready({
      intercept: (cmd, args, next) => {
        if (disk.armed && cmd === 'replaceSnapshots' && (args?.snapshots ?? []).some((x: any) => x.sourceKey !== EDITS_KEY)) {
          disk.armed = false;
          return new Promise<void>((r) => (disk.gate = r)).then(() => next(cmd, args));
        }
        return undefined;
      },
    });
    const id = await unconfirmedV2(c);
    disk.armed = true;
    const before = milestoneWrites().length;
    const p = c.resendEdit(id);
    await until(() => disk.gate !== null, 'the check\'s rows are on their way to the disk');
    const out = c.logout();
    disk.gate!();
    const r = await p;
    await out;
    expect(r.ok).toBe(false);
    expect(milestoneWrites().length).toBe(before);
  });

  it('7. the last re-read of a watch: its rows fail to reach the disk once — it is read again and the watch still ends', async () => {
    const disk = failingDisk();
    const { c } = await ready({ intercept: disk.intercept, observeMs: 400, observeFirstMs: 100 });
    fake.state.w.dropWrites = true;
    await c.act({ kind: 'setMilestone', key: K(N), title: 'v2' });
    fake.state.w.dropWrites = false;
    expect((await c.act({ kind: 'setMilestone', key: K(N), title: 'v3' })).ok).toBe(true);
    expect(markOf(c, 'milestone')!.status).toBe('observing');
    const reads = refreshes();
    // the first watch re-read goes through; the next write of board rows (the last re-read's) fails
    await until(() => refreshes() > reads, 'the first watch re-read');
    await c.settled();
    disk.st.armed = true;
    await until(() => disk.st.failed === 1, 'the last re-read\'s rows failed to reach the disk');
    await until(() => markOf(c, 'milestone') === null, 'the watch ended after the retry');
    expect(itemOf(c).milestone?.title).toBe('v3');
  });

  it('8. two boards: the check lands on board A but is overtaken on board B (a round read only B, someone changed B\'s status) — B\'s change is held', async () => {
    const pagesB = JSON.parse(JSON.stringify(fake.state.projects.get('org/gigleai/11')));
    for (const pg of pagesB) {
      pg.id = 'PVT_fixture_second';
      pg.title = 'second board';
      pg.url = 'https://github.com/orgs/GigleAI/projects/12';
    }
    fake.state.projects.set('org/gigleai/12', pagesB);
    const { c } = await ready({ repo: false });
    c.addSource('https://github.com/orgs/GigleAI/projects/12');
    await c.syncNow();
    const B = 'project:org/gigleai/12';
    const statusField = pagesB[0].fields.nodes.find((f: any) => f.__typename === 'ProjectV2SingleSelectField' && f.name === 'Status');
    const options: string[] = statusField.options.map((o: any) => o.name);
    const statusOn = (key: string) => itemOf(c).projects.find((p) => p.projectKey === key)?.status ?? null;
    const before0 = statusOn(B);
    const [target, other] = options.filter((o) => o !== before0);
    /** somebody sets B's status on GitHub (straight in the fake's store) */
    const statusByOnB = (name: string) => {
      const node = pagesB.flatMap((p: any) => p.items.nodes).find((x: any) => x.content?.number === N);
      const o = statusField.options.find((x: any) => x.name === name);
      node.fieldValues.nodes = [...node.fieldValues.nodes.filter((x: any) => x.field?.id !== statusField.id), { __typename: 'ProjectV2ItemFieldSingleSelectValue', optionId: o.id, name: o.name, field: { id: statusField.id, name: statusField.name } }];
    };
    fake.state.w.dropWrites = true;
    await c.act({ kind: 'setStatus', key: K(N), projectKey: B, status: target });
    fake.state.w.dropWrites = false;
    const m = markOf(c, 'status')!;
    expect(m.status).toBe('unconfirmed');
    let seen = 0;
    const release = fake.holdWhen((e) => e.operation === 'CavilItemRefresh' && ++seen === 1);
    const p = c.resendEdit(m.id);
    await until(() => seen >= 1, 'the check read went out (held, B still at the old status)');
    statusByOnB(other);
    // a round that reads only B (A's page fails)
    fake.state.failProjectPage.set('org/gigleai/11', 0);
    await c.syncNow();
    fake.state.failProjectPage.delete('org/gigleai/11');
    expect(statusOn(B)).toBe(other);
    const writes = fake.writes().length;
    release();
    const r = await p;
    expect(r.error).toMatch(/有人改过/);
    expect(fake.writes().length).toBe(writes);
  });

  it('11. a sync round whose rows did not reach the disk does not move the board\'s read time: the check read (v5) issued before it still lands and decides', async () => {
    const disk = failingDisk();
    const { c } = await ready({ intercept: disk.intercept });
    const id = await unconfirmedV2(c);
    await milestoneBy(6); // GitHub: v5; the board: v1
    let seen = 0;
    const release = fake.holdWhen((e) => e.operation === 'CavilItemRefresh' && ++seen === 1);
    const p = c.resendEdit(id);
    await until(() => seen >= 1, 'the check read went out (held, frozen at v5)');
    disk.st.armed = true;
    await c.syncNow();
    expect(disk.st.failed).toBe(1);
    expect(itemOf(c).milestone?.title).toBe('v1');
    const before = milestoneWrites().length;
    release();
    const r = await p;
    expect(r.error).toMatch(/有人改过/);
    expect(milestoneWrites().length).toBe(before);
    expect(milestoneOnGitHub()).toBe('v5');
  });

  it('10. an item on no source: the check still reads GitHub (its own answer) and holds a change by somebody', async () => {
    const { c } = await ready();
    const id = await unconfirmedV2(c);
    c.removeSource(PROJECT_KEY);
    c.removeSource(`repo:${REPO.toLowerCase()}`);
    await milestoneBy(6);
    const before = milestoneWrites().length;
    const reads = refreshes();
    const r = await c.resendEdit(id);
    expect(refreshes()).toBe(reads + 1);
    expect(r.error).toMatch(/有人改过/);
    expect(milestoneWrites().length).toBe(before);
  });
});
