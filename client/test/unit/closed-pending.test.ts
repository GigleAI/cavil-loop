// GitHub#462: "等人处理" counts closed items carrying the pending label too. An autopilot item is
// closed when its pull request merges and keeps `pending/human` for a human to look at; a closed
// item that last changed weeks ago is not in a repository's "open + last 14 days" lists, so the
// repository source reads a third list — closed and carrying that label — whatever its age.
//
// The controller against the fake GitHub over real HTTP, the real back end (Rust) as a child
// process: real sync rounds (every one a full read: the change check is not what is tested here),
// real SQLite, labels changed on the fake between rounds. What is
// checked for every case: the count, the list a click on the number shows (through the real
// search filter), the reminders — and, beside every "nothing happened", that the round really read.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { Controller } from '../../src/app/controller';
import type { Alert, Desktop, DesktopEvent } from '../../src/app/desktop';
import { Cache } from '../support/cache';
import { FileStore } from '../support/credentials';
import { HarnessBackend } from '../support/harness';
import { startFakeGitHub, FakeGitHub, type LoggedRequest } from '../fake-github/server';
import { FAKE_TOKEN, FIXTURE_NOW, tempDir, trustedList } from './helpers';
import { fetchRepo, REPO_RECENT_DAYS } from '../../src/data/fetchSources';
import { flowTally } from '../../src/data/flowTally';
import { applyFilter, parseFilter } from '../../src/shared/filter';
import { parseSource } from '../../src/shared/sources';
import { GitHubClient } from '../../src/data/github';
import type { SourceConfig } from '../../src/shared/types';

const REPO = 'GigleAI/cavil-loop';
const RKEY = 'gigleai/cavil-loop';
const LABEL = 'pending/human';
const DAY = 86_400_000;
const key = (n: number) => `${RKEY}#${n}`;

let fake: FakeGitHub;
let dir: string;
let caches: Cache[] = [];
let controllers: Controller[] = [];
let backends: HarnessBackend[] = [];

interface Harness {
  c: Controller;
  alerts: Alert[];
  clock: { t: number };
  items(): string[];
}

/** `checking`: the change check on, as in the app (GitHub#261); off by default here — every round reads in full */
async function signedIn(checking = false): Promise<Harness> {
  const cache = new Cache(join(dir, 'cache.sqlite'));
  caches.push(cache);
  cache.setSetting('trustedCredentials', trustedList(FAKE_TOKEN));
  const credentials = new FileStore(join(dir, 'cred'));
  await credentials.set(FAKE_TOKEN);
  const clock = { t: FIXTURE_NOW };
  const alerts: Alert[] = [];
  const endpoints = { api: fake.api, web: fake.web };
  const backend = new HarnessBackend({ db: join(dir, 'cache.sqlite'), endpoints, credentials, now: () => clock.t, sleep: async () => {} });
  backends.push(backend);
  const desktop: Desktop = {
    notify: async (a) => {
      alerts.push(a);
      return { ok: true };
    },
    setBadge: async () => {},
    clearNotifications: async () => {},
    loginItem: async () => false,
    setLoginItem: async () => {},
    nextEvent: () => new Promise<DesktopEvent>(() => {}),
    updateStatus: async () => null,
    checkUpdate: async () => {},
    setAutoUpdate: async () => {},
    setUpdateChannel: async () => {},
    dismissUpdate: async () => {},
    dismissInstalledUpdate: async () => {},
    restartToUpdate: async () => {},
    closeWindow: async () => {},
    windowFrame: async () => ({ overlay: false, fullscreen: false }),
    startDrag: async () => {},
    toggleZoom: async () => {},
  };
  const c = await Controller.create({ backend, endpoints, now: () => clock.t, defaultClientId: '', desktop, readRetryDelaysMs: [], followUpSyncMs: 3_600_000, ...(checking ? {} : { fullReadEveryMs: 0 }) });
  controllers.push(c);
  c.addSource(REPO);
  await c.start();
  await c.desktopSettled();
  expect(c.getState().phase).toBe('ready');
  return { c, alerts, clock, items: () => alerts.filter((a) => a.kind === 'item').map((a) => (a as Extract<Alert, { kind: 'item' }>).key) };
}

async function tick(h: Harness) {
  h.clock.t += 60_000;
  await h.c.syncNow();
  await h.c.desktopSettled();
}

/** the fake repository's issue list (REST shape) */
const repoList = () => fake.state.repos.get(RKEY)!;
const labelsOf = (i: any): string[] => i.labels.map((l: any) => (typeof l === 'string' ? l : l.name));

/** closed issues of the recording that carry no flow label: the ones these tests make old and label */
function closedFree(): number[] {
  return repoList()
    .filter((i: any) => i.state === 'closed' && !i.pull_request && !labelsOf(i).some((l) => l.startsWith('pending/') || l.startsWith('doing/')))
    .map((i: any) => i.number as number);
}

/** make one issue of the fake repository closed, `ageDays` old, with (or without) `label` */
function setIssue(number: number, opts: { label?: string | null; ageDays: number; state?: 'open' | 'closed' }) {
  const i = repoList().find((x: any) => x.number === number);
  if (!i) throw new Error(`fixture has no #${number}`);
  const rest = i.labels.filter((l: any) => !String(typeof l === 'string' ? l : l.name).startsWith('pending/') && (typeof l === 'string' ? l : l.name) !== 'waiting');
  i.labels = opts.label ? [...rest, { name: opts.label, color: 'ededed' }] : rest;
  i.state = opts.state ?? 'closed';
  i.updated_at = new Date(FIXTURE_NOW - opts.ageDays * DAY).toISOString();
}

const isClosedList = (e: LoggedRequest, label = LABEL) =>
  e.method === 'GET' && e.path.startsWith(`/api/repos/${REPO}/issues?`) && e.path.includes('state=closed') && e.path.includes(`labels=${encodeURIComponent(label)}`);

/** the "等人处理" number, and the items its click shows (the real filter over the board's items) */
function human(c: Controller) {
  const data = c.getBoardData();
  const entry = flowTally(data.items, c.getState().handBack).find((e) => e.kind === 'human')!;
  const shown = applyFilter(data.items, parseFilter(entry.query!), { viewer: null, today: '', projects: [] }).map((i) => i.key).sort();
  return { count: entry.count, query: entry.query, shown, pending: c.getState().pendingCount };
}

beforeEach(async () => {
  fake = await startFakeGitHub();
  dir = tempDir();
});

afterEach(async () => {
  for (const c of controllers) c.stopTimer();
  await Promise.all(controllers.map((c) => c.prefetchSettled()));
  await Promise.all(backends.map((b) => b.close()));
  for (const c of caches) c.close();
  caches = [];
  controllers = [];
  backends = [];
  await fake.close();
});

it('the recording has closed issues to work with', () => {
  expect(closedFree().length).toBeGreaterThanOrEqual(4);
});

describe('a repository source: closed items carrying the pending label, however old', () => {
  it('an old closed labelled issue is counted, listed by the click, a reminder; an old closed unlabelled one is not read at all', async () => {
    const [OLD, OLD_FREE] = closedFree();
    setIssue(OLD, { label: LABEL, ageDays: REPO_RECENT_DAYS * 3 });
    setIssue(OLD_FREE, { label: null, ageDays: REPO_RECENT_DAYS * 3 });
    const h = await signedIn();
    // "did happen": the round asked for the closed list of this label, and the read succeeded
    expect(fake.log.some((e) => isClosedList(e) && e.status === 200)).toBe(true);
    expect(h.c.getState().sync.sources.every((s) => s.ok)).toBe(true);
    const board = h.c.getBoardData().items;
    expect(board.find((i) => i.key === key(OLD))?.state).toBe('closed');
    expect(board.some((i) => i.key === key(OLD_FREE))).toBe(false);
    const n = human(h.c);
    // the click no longer narrows to open items: the number and its list are the same items
    expect(n.query).toBe(`label:"${LABEL}"`);
    expect(n.shown).toContain(key(OLD));
    expect(n.shown.length).toBe(n.count);
    expect(n.pending).toBe(n.count);
    // every item the reminders count is in the list the click shows
    expect(n.shown).toEqual(board.filter((i) => i.labels.some((l) => l.name.toLowerCase() === LABEL)).map((i) => i.key).sort());
    // the start's read is a baseline: nothing notified
    expect(h.alerts).toEqual([]);
  });

  it('an old closed issue given the label later is notified once; its label taken off, it drops out silently', async () => {
    const [OLD] = closedFree();
    setIssue(OLD, { label: null, ageDays: REPO_RECENT_DAYS * 3 });
    const h = await signedIn();
    const before = human(h.c);
    expect(before.shown).not.toContain(key(OLD));
    // labelled on GitHub today: GitHub moves its update time, so the recent list carries it too;
    // the closed list must carry it however old it stays — keep it old to test exactly that
    setIssue(OLD, { label: LABEL, ageDays: REPO_RECENT_DAYS * 3 });
    await tick(h);
    expect(h.items()).toEqual([key(OLD)]);
    const after = human(h.c);
    expect(after.count).toBe(before.count + 1);
    expect(after.shown).toContain(key(OLD));
    expect(after.pending).toBe(after.count);
    // still there next round: no second notification
    await tick(h);
    expect(h.items()).toEqual([key(OLD)]);
    setIssue(OLD, { label: null, ageDays: REPO_RECENT_DAYS * 3 });
    await tick(h);
    expect(human(h.c).count).toBe(before.count);
    expect(h.c.getState().pendingCount).toBe(before.pending);
    expect(h.items()).toEqual([key(OLD)]);
  });

  it('the closed list failing fails the source: the previous snapshot stays, nothing new, nothing gone; the change is notified after it recovers', async () => {
    const [OLD, LATER] = closedFree();
    setIssue(OLD, { label: LABEL, ageDays: REPO_RECENT_DAYS * 3 });
    const h = await signedIn();
    const before = human(h.c);
    expect(before.shown).toContain(key(OLD));
    fake.state.answerOverride = (e) => (isClosedList(e) ? { status: 502, body: { message: 'Server Error' } } : null);
    setIssue(LATER, { label: LABEL, ageDays: REPO_RECENT_DAYS * 3 });
    setIssue(OLD, { label: null, ageDays: REPO_RECENT_DAYS * 3 });
    const sent = fake.log.length;
    await tick(h);
    // "did happen": the closed list was asked for this round and refused
    expect(fake.log.slice(sent).some((e) => isClosedList(e) && e.status === 502)).toBe(true);
    expect(h.c.getState().sync.sources.find((s) => s.sourceKey === `repo:${RKEY}`)?.ok).toBe(false);
    expect(human(h.c)).toEqual(before);
    expect(h.alerts).toEqual([]);
    fake.state.answerOverride = null;
    await tick(h);
    expect(h.c.getState().sync.sources.every((s) => s.ok)).toBe(true);
    const after = human(h.c);
    expect(after.shown).toContain(key(LATER));
    expect(after.shown).not.toContain(key(OLD));
    expect(after.count).toBe(before.count);
    expect(h.items()).toEqual([key(LATER)]);
  });

  it('another pending label in Settings: read again at once for the new name — even when the change check says nothing changed — recounted silently', async () => {
    const [OLD, OLD_OTHER] = closedFree();
    setIssue(OLD, { label: LABEL, ageDays: REPO_RECENT_DAYS * 3 });
    setIssue(OLD_OTHER, { label: 'waiting', ageDays: REPO_RECENT_DAYS * 3 });
    const h = await signedIn(true);
    // with nothing changed on GitHub, a round keeps the snapshot: the check answers 304, no list is read
    const quiet = fake.log.length;
    await tick(h);
    expect(fake.log.slice(quiet).some((e) => e.method === 'HEAD' && e.status === 304)).toBe(true);
    expect(fake.log.slice(quiet).some((e) => e.method === 'GET' && e.path.startsWith(`/api/repos/${REPO}/issues?`))).toBe(false);
    expect(human(h.c).shown).toContain(key(OLD));
    expect(h.c.getBoardData().items.some((i) => i.key === key(OLD_OTHER))).toBe(false);
    const sent = fake.log.length;
    h.c.setHandBack({ human: 'waiting' });
    for (let i = 0; i < 200 && !fake.log.slice(sent).some((e) => isClosedList(e, 'waiting') && e.status === 200); i++) await new Promise((r) => setTimeout(r, 10));
    await h.c.desktopSettled();
    for (let i = 0; i < 200 && !h.c.getBoardData().items.some((x) => x.key === key(OLD_OTHER)); i++) await new Promise((r) => setTimeout(r, 10));
    // "did happen": the new name's closed list was read, and the old closed one under it is on the board
    expect(fake.log.slice(sent).some((e) => isClosedList(e, 'waiting') && e.status === 200)).toBe(true);
    const n = human(h.c);
    expect(n.query).toBe('label:"waiting"');
    expect(n.shown).toContain(key(OLD_OTHER));
    expect(n.shown).not.toContain(key(OLD));
    expect(n.pending).toBe(n.count);
    // a settings change is not new work arriving
    expect(h.alerts).toEqual([]);
  });
});

describe('the read itself', () => {
  const src = () => parseSource(REPO) as Extract<SourceConfig, { kind: 'repo' }>;
  const client = () => new GitHubClient({ api: fake.api, web: fake.web }, FAKE_TOKEN);

  it('no pending label: the closed list is not asked for, the old closed item is not there, and the snapshot says no label was read', async () => {
    const [OLD] = closedFree();
    setIssue(OLD, { label: LABEL, ageDays: REPO_RECENT_DAYS * 3 });
    const sent = fake.log.length;
    const snap = await fetchRepo(client(), src(), FIXTURE_NOW);
    expect(fake.log.slice(sent).some((e) => e.path.includes('labels='))).toBe(false);
    // "did happen": the two usual lists were read
    expect(fake.log.slice(sent).filter((e) => e.path.startsWith(`/api/repos/${REPO}/issues?`) && e.status === 200).length).toBeGreaterThanOrEqual(2);
    expect(snap.items.length).toBeGreaterThan(0);
    expect(snap.items.some((i) => i.key === key(OLD))).toBe(false);
    expect(snap.pendingLabel).toBe('');
  });

  it('with the label: the old closed item is read, with how the account stands to it (a to-do now), and the snapshot names the label', async () => {
    const [OLD] = closedFree();
    setIssue(OLD, { label: 'Pending/Human', ageDays: REPO_RECENT_DAYS * 3 });
    fake.state.w.subscriptions.set(key(OLD), 'SUBSCRIBED');
    const snap = await fetchRepo(client(), src(), FIXTURE_NOW, undefined, '', ` ${LABEL} `);
    const it_ = snap.items.find((i) => i.key === key(OLD));
    expect(it_?.state).toBe('closed');
    expect(it_?.viewerSubscribed).toBe(true);
    expect(it_?.viewerAt).toBe(FIXTURE_NOW);
    expect(snap.pendingLabel).toBe(LABEL);
  });

  it('a name with a comma (PR #481 review round 1): GitHub cannot be asked for it whole — every closed item is read, the one carrying the whole name is in, one carrying its parts is not', async () => {
    const [OLD, OTHER, FREE] = closedFree();
    setIssue(OLD, { label: 'a,b', ageDays: REPO_RECENT_DAYS * 3 });
    setIssue(OTHER, { label: null, ageDays: REPO_RECENT_DAYS * 3 });
    setIssue(FREE, { label: null, ageDays: REPO_RECENT_DAYS * 3 });
    // GitHub reads `labels=a,b` as "a and b": an item with both `a` and `b`, but not `a,b`
    const o = repoList().find((x: any) => x.number === OTHER);
    o.labels = [...o.labels, { name: 'a', color: '' }, { name: 'b', color: '' }];
    // more closed items than one page: the whole list is followed to its end
    fake.state.restPageSize = 2;
    const sent = fake.log.length;
    const snap = await fetchRepo(client(), src(), FIXTURE_NOW, undefined, '', 'a,b');
    const asked = fake.log.slice(sent).filter((e) => e.path.startsWith(`/api/repos/${REPO}/issues?`) && e.path.includes('state=closed'));
    // "did happen": the closed list was read, without a `labels` parameter, page after page
    expect(asked.length).toBeGreaterThan(1);
    expect(asked.every((e) => !e.path.includes('labels=') && e.status === 200)).toBe(true);
    expect(snap.items.find((i) => i.key === key(OLD))?.state).toBe('closed');
    expect(snap.items.some((i) => i.key === key(OTHER))).toBe(false);
    expect(snap.items.some((i) => i.key === key(FREE))).toBe(false);
    expect(snap.pendingLabel).toBe('a,b');
  });

  it('a name without a comma is asked for directly: GitHub returns only the items carrying it', async () => {
    const sent = fake.log.length;
    await fetchRepo(client(), src(), FIXTURE_NOW, undefined, '', LABEL);
    const asked = fake.log.slice(sent).filter((e) => e.path.includes('state=closed'));
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((e) => e.path.includes(`labels=${encodeURIComponent(LABEL)}`))).toBe(true);
  });

  it('the whole closed list failing mid-way (a name with a comma) fails the read: nothing half is returned', async () => {
    const [OLD] = closedFree();
    setIssue(OLD, { label: 'a,b', ageDays: REPO_RECENT_DAYS * 3 });
    fake.state.restPageSize = 2;
    fake.state.answerOverride = (e) => (e.path.includes('state=closed') && /[?&]page=2(&|$)/.test(e.path) ? { status: 502, body: { message: 'Server Error' } } : null);
    const sent = fake.log.length;
    await expect(fetchRepo(client(), src(), FIXTURE_NOW, undefined, '', 'a,b')).rejects.toThrow();
    // "did happen": the second page was asked for and refused
    expect(fake.log.slice(sent).some((e) => e.path.includes('state=closed') && e.status === 502)).toBe(true);
  });
});
