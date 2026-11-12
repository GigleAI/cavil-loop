// GigleAI/cavil-loop#397: detail tabs — what the controller keeps and reads.
//   - an item a complete read of this run carries follows the sync rounds: no request of its own;
//   - an item no complete read carries (its source failed, was removed, or no longer lists it) is
//     checked by itself, one request: an open one with every round, an ended one every ten minutes —
//     and still after it ended (reopened, commented on); a failed check changes nothing and is due
//     again with the next round; a closed tab is not read any more;
//   - the tabs are kept on this machine, and go with the account.
// Real controller, the real Rust back end as a child process, the fake GitHub over HTTP, real SQLite.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { Controller } from '../../src/app/controller';
import { Cache } from '../support/cache';
import { FileStore } from '../support/credentials';
import { HarnessBackend } from '../support/harness';
import { startFakeGitHub, type FakeGitHub, type LoggedRequest } from '../fake-github/server';
import { findCopies } from '../fake-github/writes';
import { ENDED_CHECK_MS, tabStatus, tabUnread } from '../../src/shared/tabs';
import { FAKE_TOKEN, FIXTURE_NOW, tempDir, trustedList } from './helpers';

const REPO = 'GigleAI/cavil-loop';
const REPO_KEY = 'repo:gigleai/cavil-loop';
/** recorded issue #139 (open) */
const ISSUE = 139;
const K = (n: number) => `gigleai/cavil-loop#${n}`;
const LABELS = { human: 'pending/human', doing: 'doing/agent' };

let fake: FakeGitHub;
let dir: string;
let clock: { t: number };
let caches: Cache[] = [];
let controllers: Controller[] = [];
let backends: HarnessBackend[] = [];

beforeEach(async () => {
  fake = await startFakeGitHub();
  dir = tempDir();
  clock = { t: FIXTURE_NOW };
  setIssue({ state: 'open', labels: [] });
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

async function ready(first = true) {
  if (first) {
    const cache = new Cache(join(dir, 'cache.sqlite'));
    caches.push(cache);
    cache.setSetting('trustedCredentials', trustedList(FAKE_TOKEN));
    cache.close();
    caches = [];
    await new FileStore(join(dir, 'cred')).set(FAKE_TOKEN);
  }
  const endpoints = { api: fake.api, web: fake.web };
  const backend = new HarnessBackend({ db: join(dir, 'cache.sqlite'), endpoints, credentials: new FileStore(join(dir, 'cred')), now: () => clock.t, sleep: async () => {} });
  backends.push(backend);
  // no change check: every round reads the list in full, so "a round ran" is one first page
  const c = await Controller.create({ backend, endpoints, now: () => clock.t, defaultClientId: '', followUpSyncMs: 600_000, fullReadEveryMs: 0 });
  controllers.push(c);
  if (first) c.addSource(REPO);
  await c.start();
  expect(c.getState().phase).toBe('ready');
  return c;
}

const issue = () => fake.state.repos.get('gigleai/cavil-loop')!.find((r) => r.number === ISSUE)!;
/** change the issue on GitHub (the fake: every copy it holds), bumping its update time like GitHub does */
function setIssue(p: { state?: 'open' | 'closed'; labels?: string[]; title?: string; touch?: boolean }) {
  const c = findCopies(fake.state, REPO, ISSUE)!;
  clock.t += 1000;
  const when = new Date(clock.t).toISOString();
  for (const r of c.rest) {
    if (p.state) {
      r.state = p.state;
      r.state_reason = p.state === 'closed' ? 'completed' : null;
    }
    if (p.labels) r.labels = p.labels.map((name) => ({ name, color: 'ededed' }));
    if (p.title) r.title = p.title;
    r.updated_at = when;
  }
  for (const g of c.gql) {
    if (p.state) {
      g.state = p.state === 'open' ? 'OPEN' : 'CLOSED';
      g.stateReason = p.state === 'closed' ? 'COMPLETED' : null;
    }
    if (p.labels) g.labels = { nodes: p.labels.map((name) => ({ name, color: 'ededed' })) };
    if (p.title) g.title = p.title;
    g.updatedAt = when;
  }
}

const isItemRead = (l: LoggedRequest) => l.operation === 'CavilItemRefresh' && l.variables?.number === ISSUE;
/** the issue's own checks that reached the fake */
const itemReads = () => fake.log.filter(isItemRead).length;
const tab = (c: Controller) => c.getState().tabs.find((t) => t.key === K(ISSUE)) ?? null;
const status = (c: Controller) => tabStatus(tab(c)!.item, LABELS);
/** one round, and the tabs' own checks it started */
async function round(c: Controller) {
  await c.syncNow();
  await c.checkTabsSettled();
}
/** the repository's list cannot be read: the round keeps its cached copy, which is no news of the issue */
const breakSource = () => fake.state.failRepoPage.set('gigleai/cavil-loop', 1);
const mendSource = () => fake.state.failRepoPage.clear();

describe('a tab follows the sync rounds while a complete read carries its item', () => {
  it('opening needs a known item; the same item opens once; the icon follows the labels with no request of its own', async () => {
    const c = await ready();
    expect(c.openTab('gigleai/cavil-loop#999999')).toBe(false);
    expect(c.getState().tabs).toEqual([]);
    expect(c.openTab(K(ISSUE))).toBe(true);
    expect(c.openTab(K(ISSUE))).toBe(true);
    expect(c.getState().tabs.map((t) => t.key)).toEqual([K(ISSUE)]);
    expect(tab(c)).toMatchObject({ listed: true, seen: null });
    expect(status(c)).toBe('open');

    setIssue({ labels: ['doing/agent'] });
    await round(c);
    expect(status(c)).toBe('running');
    setIssue({ labels: ['pending/human'] });
    await round(c);
    expect(status(c)).toBe('waiting');
    // closed a moment ago: the repository's list still carries it (recently updated)
    setIssue({ state: 'closed' });
    await round(c);
    expect(tab(c)!.listed).toBe(true);
    expect(status(c)).toBe('done');
    // the rounds brought all of that
    expect(itemReads()).toBe(0);
  });

  it('seen: the dot is for a tab not in front whose item changed since it was looked at', async () => {
    const c = await ready();
    c.openTab(K(ISSUE));
    c.seenTab(K(ISSUE), tab(c)!.item.updatedAt);
    expect(tabUnread(tab(c)!, false)).toBe(false);
    setIssue({ title: 'changed while the tab was behind' });
    await round(c);
    expect(tab(c)!.item.title).toBe('changed while the tab was behind');
    expect(tabUnread(tab(c)!, false)).toBe(true);
    c.seenTab(K(ISSUE), tab(c)!.item.updatedAt);
    expect(tabUnread(tab(c)!, false)).toBe(false);
  });
});

describe('an item no complete read carries is checked by itself', () => {
  it('open: with every round; the tab shows what the check read, not the cached copy', async () => {
    const c = await ready();
    c.openTab(K(ISSUE));
    breakSource();
    setIssue({ labels: ['doing/agent'] });
    await round(c);
    expect(tab(c)!.listed).toBe(false);
    expect(itemReads()).toBe(1);
    expect(status(c)).toBe('running');
    // the board's copy is still the cached one: only the tab knows
    expect(c.getBoardData().items.find((i) => i.key === K(ISSUE))!.labels).toEqual([]);
    setIssue({ labels: ['pending/human'] });
    await round(c);
    expect(itemReads()).toBe(2);
    expect(status(c)).toBe('waiting');
  });

  it('the newer copy the check read is the one the detail and every change use; the board keeps its cached copy', async () => {
    const c = await ready();
    c.openTab(K(ISSUE));
    breakSource();
    setIssue({ state: 'closed', labels: ['doing/agent'] });
    await round(c);
    expect(status(c)).toBe('done');
    const board = c.getBoardData().items.find((i) => i.key === K(ISSUE))!;
    expect(board.state).toBe('open');
    const fresh = c.getBoardData().tabItems!.find((i) => i.key === K(ISSUE))!;
    expect(fresh).toMatchObject({ state: 'closed', labels: [{ name: 'doing/agent' }] });
    // memberships are the cached copy's (a check reads no board)
    expect(fresh.sources).toEqual(board.sources);
    // a change made from the detail goes by that copy: the label is there, removing it is sent
    const n = fake.log.length;
    const r = await c.act({ kind: 'removeLabel', key: K(ISSUE), label: 'doing/agent' } as any);
    expect(r.ok).toBe(true);
    expect(fake.log.slice(n).some((l) => l.method === 'DELETE' && l.path.includes(`/issues/${ISSUE}/labels/doing%2Fagent`))).toBe(true);
  });

  it('ended: every ten minutes, not before — and still after it ended: reopened, commented on', async () => {
    const c = await ready();
    c.openTab(K(ISSUE));
    c.seenTab(K(ISSUE), tab(c)!.item.updatedAt);
    breakSource();
    setIssue({ state: 'closed' });
    await round(c);
    expect(itemReads()).toBe(1);
    expect(status(c)).toBe('done');
    c.seenTab(K(ISSUE), tab(c)!.item.updatedAt);

    // a comment after it closed: GitHub moves its update time
    setIssue({ touch: true });
    await round(c);
    await round(c);
    // not due yet: no request, nothing new on the tab
    expect(itemReads()).toBe(1);
    expect(tabUnread(tab(c)!, false)).toBe(false);
    clock.t += ENDED_CHECK_MS;
    await round(c);
    // due: read, and the tab says something is new
    expect(itemReads()).toBe(2);
    expect(status(c)).toBe('done');
    expect(tabUnread(tab(c)!, false)).toBe(true);

    // reopened on GitHub; the source still cannot be read, so only the check can tell
    setIssue({ state: 'open', labels: ['doing/agent'] });
    await round(c);
    expect(itemReads()).toBe(2);
    expect(status(c)).toBe('done');
    clock.t += ENDED_CHECK_MS;
    await round(c);
    expect(itemReads()).toBe(3);
    expect(status(c)).toBe('running');
    // open again: back to every round
    setIssue({ labels: ['pending/human'] });
    await round(c);
    expect(itemReads()).toBe(4);
    expect(status(c)).toBe('waiting');
  });

  it('a check that fails changes nothing and is due again with the next round', async () => {
    const c = await ready();
    c.openTab(K(ISSUE));
    breakSource();
    setIssue({ state: 'closed' });
    await round(c);
    expect(status(c)).toBe('done');
    const shown = tab(c)!.item;

    setIssue({ state: 'open', title: 'reopened' });
    clock.t += ENDED_CHECK_MS;
    fake.state.answerOverride = (e) => (isItemRead(e) ? { status: 502, body: { message: 'Server Error' } } : null);
    await round(c);
    // asked, no answer: never "closed", never "nothing changed" — what it showed stays
    expect(itemReads()).toBe(2);
    expect(tab(c)!.item).toEqual(shown);
    // the next round — no ten minutes to wait: the check never answered
    fake.state.answerOverride = null;
    await round(c);
    expect(itemReads()).toBe(3);
    expect(tab(c)!.item.title).toBe('reopened');
    expect(status(c)).toBe('open');
  });

  it('asked for: the tab coming to the front and a refresh by hand check an ended item now', async () => {
    const c = await ready();
    c.openTab(K(ISSUE));
    breakSource();
    setIssue({ state: 'closed' });
    await round(c);
    expect(itemReads()).toBe(1);
    setIssue({ title: 'edited after closing' });
    await c.checkTabs(K(ISSUE));
    expect(itemReads()).toBe(2);
    expect(tab(c)!.item.title).toBe('edited after closing');
    setIssue({ title: 'edited again' });
    await c.restartSync();
    await c.checkTabsSettled();
    expect(itemReads()).toBe(3);
    expect(tab(c)!.item.title).toBe('edited again');
    // a listed item is never checked by itself, asked or not
    mendSource();
    await c.restartSync();
    await c.checkTabsSettled();
    expect(tab(c)!.listed).toBe(true);
    const n = itemReads();
    await c.checkTabs(K(ISSUE));
    expect(itemReads()).toBe(n);
  });

  it('the source reads again: the tab follows the rounds again; a closed tab is not read any more', async () => {
    const c = await ready();
    c.openTab(K(ISSUE));
    breakSource();
    setIssue({ labels: ['doing/agent'] });
    await round(c);
    expect(itemReads()).toBe(1);
    mendSource();
    setIssue({ labels: ['pending/human'] });
    // by hand: a source that failed is read again at once (a timed round may hold it back for a while, GitHub#374)
    await c.restartSync();
    await c.checkTabsSettled();
    expect(tab(c)!.listed).toBe(true);
    expect(status(c)).toBe('waiting');
    expect(itemReads()).toBe(1);

    breakSource();
    await round(c);
    expect(itemReads()).toBe(2);
    c.closeTab(K(ISSUE));
    expect(c.getState().tabs).toEqual([]);
    await round(c);
    await round(c);
    expect(itemReads()).toBe(2);
  });

  it('a source that was removed: the tab stays and still has its item; it is checked at once, then with every round', async () => {
    const c = await ready();
    c.openTab(K(ISSUE));
    c.removeSource(REPO_KEY);
    // at once, before any read: the tab kept the removed source's copy as its own
    expect(c.getBoardData().items).toEqual([]);
    expect(tab(c)).toMatchObject({ listed: false });
    expect(c.getBoardData().tabItems?.map((i) => i.key)).toEqual([K(ISSUE)]);
    expect(c.getBoardData().tabItems![0]).toMatchObject({ sources: [], projects: [] });
    await c.checkTabsSettled();
    expect(itemReads()).toBe(1);
    // reading the detail works, and so does a change (the item is still an item)
    expect((await c.loadDetail(K(ISSUE))).ok).toBe(true);
    setIssue({ state: 'closed' });
    await round(c);
    expect(itemReads()).toBe(2);
    expect(status(c)).toBe('done');
  });
});

describe('a change made from a tab shows on the tab\'s own copy too (code review round 3)', () => {
  // The board's copy and the tab's copy are one item: the change on its way (its new value and its
  // "saving" / "not saved" mark) is on both, whichever way the item came to need a copy of its own.
  const isLabelPost = (l: LoggedRequest) => l.method === 'POST' && l.path.endsWith(`/issues/${ISSUE}/labels`);
  const labelPosts = () => fake.log.filter(isLabelPost).length;
  const tabCopy = (c: Controller) => c.getBoardData().tabItems?.find((i) => i.key === K(ISSUE)) ?? null;
  /** what the detail shows: the tab's copy first, else the board's (the same lookup as the detail's) */
  const shown = (c: Controller) => tabCopy(c) ?? c.getBoardData().items.find((i) => i.key === K(ISSUE)) ?? null;
  const labelMark = (it: { edits?: { field: string; status: string }[] } | null) => it?.edits?.find((m) => m.field === 'label')?.status ?? null;
  async function until(pred: () => boolean, what: string) {
    for (let i = 0; i < 1000; i++) {
      if (pred()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`timeout waiting for: ${what}`);
  }

  const ways: [string, (c: Controller) => Promise<void>][] = [
    ['its source unticked in the view', async (c) => c.setView({ selected: [] })],
    ['its source failed and its own check read a newer copy', async (c) => {
      breakSource();
      setIssue({ title: 'read by the tab itself' });
      await round(c);
      expect(tabCopy(c)?.title).toBe('read by the tab itself');
    }],
    ['its source removed', async (c) => c.removeSource(REPO_KEY)],
  ];
  for (const [way, apart] of ways) {
    it(`${way}: the new label and "saving" while GitHub has not answered, then GitHub's answer; a refused one stays marked`, async () => {
      const c = await ready();
      c.openTab(K(ISSUE));
      await apart(c);
      // the tab holds a copy of its own (else this case would test the board's copy)
      expect(tabCopy(c)).not.toBeNull();
      const release = fake.holdWhen(isLabelPost);
      const p = c.act({ kind: 'addLabel', key: K(ISSUE), label: 'bug', color: 'd73a4a' } as any);
      try {
        await until(() => labelPosts() === 1, 'the label write reached GitHub');
        expect(tabCopy(c)!.labels.map((l) => l.name)).toContain('bug');
        expect(labelMark(tabCopy(c))).toBe('saving');
      } finally {
        release();
      }
      expect((await p).ok).toBe(true);
      expect(shown(c)!.labels.map((l) => l.name)).toContain('bug');
      expect(labelMark(shown(c))).toBeNull();
      // refused by GitHub: the tab keeps GitHub's labels and shows the change as not saved
      fake.state.w.failLabel = 'x-fail';
      const r = await c.act({ kind: 'addLabel', key: K(ISSUE), label: 'x-fail', color: '000000' } as any);
      expect(r.ok).toBe(false);
      expect(labelPosts()).toBe(2);
      expect(shown(c)!.labels.map((l) => l.name)).not.toContain('x-fail');
      expect(labelMark(shown(c))).toBe('failed');
    });
  }
});

describe('what can be opened', () => {
  it('an item of a source unticked in the view: its tab opens, and its detail gets the whole item', async () => {
    const c = await ready();
    c.setView({ selected: [] });
    expect(c.getBoardData().items).toEqual([]);
    expect(c.openTab(K(ISSUE))).toBe(true);
    expect(tab(c)).toMatchObject({ listed: true });
    expect(c.getBoardData().tabItems?.map((i) => i.key)).toEqual([K(ISSUE)]);
    expect((await c.loadDetail(K(ISSUE))).ok).toBe(true);
    // ticked again: the view holds it, nothing is handed over twice
    c.setView({ selected: null });
    expect(c.getBoardData().tabItems).toBeUndefined();
    expect(c.getBoardData().items.some((i) => i.key === K(ISSUE))).toBe(true);
  });

  it('an item changed here that no source carries: read by itself after the change, so its tab can open again', async () => {
    const c = await ready();
    c.openTab(K(ISSUE));
    c.removeSource(REPO_KEY);
    await c.checkTabsSettled();
    // a comment sent from its tab: the item is read again by itself (no source would bring it)
    const r = await c.act({ kind: 'comment', key: K(ISSUE), body: 'still here' });
    expect(r).toMatchObject({ ok: true, error: null });
    c.closeTab(K(ISSUE));
    expect(c.getState().tabs).toEqual([]);
    expect(c.getBoardData().items).toEqual([]);
    expect(c.getBoardData().tabItems).toBeUndefined();
    // no source, no tab: what that read brought is still enough to open it again
    expect(c.openTab(K(ISSUE))).toBe(true);
    expect(tab(c)).toMatchObject({ listed: false });
    expect(c.getBoardData().tabItems?.map((i) => i.key)).toEqual([K(ISSUE)]);
    // an item nobody ever read is still not openable
    expect(c.openTab('gigleai/cavil-loop#999999')).toBe(false);
  });
});

describe('kept on this machine, and gone with the account', () => {
  it('order and what each tab showed survive a restart; signing out drops them', async () => {
    const c = await ready();
    const other = c.getBoardData().items.find((i) => i.key !== K(ISSUE))!;
    c.openTab(K(ISSUE));
    c.openTab(other.key);
    c.moveTab(other.key, 0);
    expect(c.getState().tabs.map((t) => t.key)).toEqual([other.key, K(ISSUE)]);
    c.seenTab(K(ISSUE), tab(c)!.item.updatedAt);
    const shown = c.getState().tabs.map((t) => ({ key: t.key, item: t.item, seen: t.seen }));
    await c.settled();
    c.stopTimer();
    await backends[0].close();
    backends = [];

    const again = await ready(false);
    expect(again.getState().tabs.map((t) => ({ key: t.key, item: t.item, seen: t.seen }))).toEqual(shown);

    await again.logout();
    expect(again.getState().tabs).toEqual([]);
    await again.settled();
    await backends[0].close();
    backends = [];
    const cache = new Cache(join(dir, 'cache.sqlite'));
    caches.push(cache);
    expect(cache.getSetting('tabs', null)).toEqual([]);
  });

  it('the running label is the one Settings holds (GitHub#404): changed or emptied there, the tab follows', async () => {
    const c = await ready();
    c.openTab(K(ISSUE));
    setIssue({ labels: ['wip'] });
    await round(c);
    const labels = () => ({ human: c.getState().handBack.human, doing: c.getState().handBack.running });
    expect(tabStatus(tab(c)!.item, labels())).toBe('open');
    c.setHandBack({ running: ' wip ' });
    expect(tabStatus(tab(c)!.item, labels())).toBe('running');
    c.setHandBack({ running: '' });
    expect(tabStatus(tab(c)!.item, labels())).toBe('open');
  });

  it('the shell\'s close key: the window hears every press', async () => {
    const c = await ready();
    const before = c.getState().closeTabReq;
    c.onDesktopEvent({ kind: 'closeTab' });
    c.onDesktopEvent({ kind: 'closeTab' });
    expect(c.getState().closeTabReq).toBe(before + 2);
  });
});
