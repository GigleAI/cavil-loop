// "待处理" reminders (GigleAI/cavil-loop#139, rebuilt on the Tauri client in #169,
// narrowed in #251): notifications and the Dock badge. Since #251 only an open
// item is a to-do, what a source already has on its first read is history (no
// notification, no summary, never unread), and the badge is only the unread
// count. Three layers:
//   - the controller against the fake GitHub over real HTTP, with the real Rust
//     back end as a child process (real sync rounds, real pagination failures,
//     real SQLite), labels changed on the fake between rounds the way a
//     maintainer changes them on GitHub;
//   - what the shell tells the window (a sync beat, a clicked notification);
//   - the tracker alone for the orderings that are awkward to stage over HTTP.
// Recorded data (test/fixtures, re-recorded by record.mjs — never hand-edited):
// the expected numbers below are derived from it, not typed in. On top of the
// recording every test puts the label on one open item that both sources carry
// (SEEDED), so there is always an open pending item and a cross-source one,
// whatever the board looked like on recording day. The recording's own labelled
// items are closed / merged: the history #251 stops counting.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { Controller, PREFETCH_PER_ROUND } from '../../src/app/controller';
import type { Alert, Desktop, DesktopEvent } from '../../src/app/desktop';
import { Cache } from '../support/cache';
import { FileStore } from '../support/credentials';
import { HarnessBackend } from '../support/harness';
import { PendingTracker } from '../../src/data/pending';
import { startFakeGitHub, FakeGitHub, loadCavilProjectPages, loadCavilRepoIssues } from '../fake-github/server';
import { FAKE_TOKEN, FIXTURE_NOW, item, tempDir, trustedList } from './helpers';
import type { SourceSnapshot } from '../../src/shared/types';

const PROJECT_URL = 'https://github.com/orgs/GigleAI/projects/11';
const PROJECT_KEY = 'project:org/gigleai/11';
const REPO = 'GigleAI/cavil-loop';
const REPO_KEY = 'repo:gigleai/cavil-loop';
const LABEL = 'pending/human';

let fake: FakeGitHub;
let dir: string;
let caches: Cache[] = [];
let controllers: Controller[] = [];
let backends: HarnessBackend[] = [];

interface Harness {
  c: Controller;
  backend: HarnessBackend;
  alerts: Alert[];
  badges: number[];
  cleared: number[];
  opened: string[];
  clock: { t: number };
  loginItem: { on: boolean | null; sets: boolean[] };
  /** notifications about single items, as `repo#N` */
  items(): string[];
  /** notifications of any other kind (there must be none since GitHub#251) */
  others(): Alert[];
  badge(): number | undefined;
}

async function signedIn(
  opts: { sources?: string[]; seed?: Record<string, unknown>; clock?: { t: number }; delivery?: { refuse: string | null }; loginItem?: boolean | null } = {},
): Promise<Harness> {
  // a restart reads the files: every earlier app of this test has finished writing its settings
  await Promise.all(controllers.map((c) => c.settled()));
  const cache = new Cache(join(dir, 'cache.sqlite'));
  caches.push(cache);
  if (cache.getSetting('trustedCredentials', null) === null) cache.setSetting('trustedCredentials', trustedList(FAKE_TOKEN));
  for (const [k, v] of Object.entries(opts.seed ?? {})) cache.setSetting(k, v);
  const credentials = new FileStore(join(dir, 'cred'));
  await credentials.set(FAKE_TOKEN);
  const clock = opts.clock ?? { t: FIXTURE_NOW };
  const alerts: Alert[] = [];
  const badges: number[] = [];
  /** each take-back of the delivered notifications, as how many badges had been set by then */
  const cleared: number[] = [];
  const opened: string[] = [];
  const loginItem = { on: opts.loginItem === undefined ? false : opts.loginItem, sets: [] as boolean[] };
  const endpoints = { api: fake.api, web: fake.web };
  const backend = new HarnessBackend({ db: join(dir, 'cache.sqlite'), endpoints, credentials, now: () => clock.t, sleep: async () => {}, opened });
  backends.push(backend);
  // the shell's side, as the tests see it: what was shown, what the system answered
  const desktop: Desktop = {
    notify: async (a) => {
      alerts.push(a);
      const refuse = opts.delivery?.refuse;
      return refuse ? { ok: false, error: refuse } : { ok: true };
    },
    setBadge: async (n) => void badges.push(n),
    clearNotifications: async () => void cleared.push(badges.length),
    loginItem: async () => loginItem.on,
    setLoginItem: async (on) => {
      loginItem.sets.push(on);
      loginItem.on = on;
    },
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
  const c = await Controller.create({ backend, endpoints, now: () => clock.t, defaultClientId: '', desktop });
  controllers.push(c);
  for (const s of opts.sources ?? []) c.addSource(s);
  return {
    c,
    backend,
    alerts,
    badges,
    cleared,
    opened,
    clock,
    loginItem,
    items: () => alerts.filter((a) => a.kind === 'item').map((a) => (a as Extract<Alert, { kind: 'item' }>).key),
    others: () => alerts.filter((a) => a.kind !== 'item'),
    badge: () => badges[badges.length - 1],
  };
}

/** what a notification's answer does lands a moment after the call */
const settle = () => new Promise((r) => setTimeout(r, 20));


/** Next round, one minute later; then whatever it asked of the shell has been answered. */
async function tick(h: Harness) {
  h.clock.t += 60_000;
  await h.c.syncNow();
  await h.c.desktopSettled();
  await h.c.desktopSettled();
  expectBadgeIsUnread(h);
}

/**
 * The badge is the unread count and nothing else (GitHub#185, #251): never more than what is
 * pending now, and no other kind of notification ever goes out. Checked after every round of
 * every test here.
 */
function expectBadgeIsUnread(h: Harness) {
  const st = h.c.getState();
  expect(st.unreadCount).toBeLessThanOrEqual(st.pendingCount);
  if (h.badges.length) expect(h.badge()).toBe(st.unreadCount);
  expect(h.others()).toEqual([]);
}

/**
 * Put / take the label on GitHub (the fake): on the Project item and on the
 * repository's issue list alike, and bump `updatedAt` like GitHub does.
 */
function setLabel(number: number, on: boolean, clock: { t: number }) {
  const when = new Date(clock.t).toISOString();
  let found = false;
  for (const pg of fake.state.projects.get('org/gigleai/11')!) {
    for (const n of pg.items.nodes) {
      const c = n.content;
      if (!c || c.number !== number || c.repository?.nameWithOwner !== REPO) continue;
      found = true;
      const rest = c.labels.nodes.filter((l: { name: string }) => l.name !== LABEL);
      c.labels = { nodes: on ? [...rest, { name: LABEL, color: 'ededed' }] : rest };
      c.updatedAt = when;
    }
  }
  for (const i of fake.state.repos.get('gigleai/cavil-loop')!) {
    if (i.number !== number) continue;
    found = true;
    const rest = i.labels.filter((l: { name: string }) => l.name !== LABEL);
    i.labels = on ? [...rest, { name: LABEL, color: 'ededed' }] : rest;
    i.updated_at = when;
  }
  if (!found) throw new Error(`fixture has no #${number}`);
}

/** Reopen / close an issue only the Project carries (the repository list does not have it). */
function setOpen(number: number, open: boolean, clock: { t: number }) {
  let found = false;
  for (const pg of fake.state.projects.get('org/gigleai/11')!) {
    for (const n of pg.items.nodes) {
      const c = n.content;
      if (!c || c.number !== number || c.repository?.nameWithOwner !== REPO) continue;
      found = true;
      c.state = open ? 'OPEN' : 'CLOSED';
      c.updatedAt = new Date(clock.t).toISOString();
    }
  }
  if (!found) throw new Error(`fixture has no #${number}`);
}

const key = (n: number) => `gigleai/cavil-loop#${n}`;
/** the board's copy of an item carries the label (the round really read it) */
const labelledOnBoard = (h: Harness, n: number) => h.c.getBoardData().items.some((i) => i.key === key(n) && i.labels.some((l) => l.name === LABEL));

// ---- what the recording holds (read straight from the JSON, independent of the client code) ----
const rawPages = loadCavilProjectPages();
const rawRepo = loadCavilRepoIssues();
const rawProject = rawPages.flatMap((pg) => pg.items.nodes).filter((n: any) => !n.isArchived && n.content?.number != null && n.content.repository);
const projHas = (n: number) => rawProject.some((x: any) => x.content.number === n && x.content.repository.nameWithOwner === REPO);
const projPending = (x: any) => x.content.labels.nodes.some((l: any) => l.name === LABEL);
const repoOpen = (n: number) => rawRepo.some((i: any) => i.number === n && i.state === 'open');
const repoPending = (i: any) => i.labels.some((l: any) => (l.name ?? l) === LABEL);
/** open issues in both sources, pending in neither: SEEDED gets the label before every test, the others are "an open item gets the label" */
const openFree = rawRepo
  .filter((i: any) => i.state === 'open' && !i.pull_request && !repoPending(i) && projHas(i.number) && !rawProject.some((x: any) => x.content.number === i.number && projPending(x)))
  .map((i: any) => i.number as number);
const [SEEDED, OPEN_NEW, OPEN_NEW2] = openFree;
/** a closed issue / merged PR only the Project carries, without the label */
const pickProj = (pred: (c: any) => boolean) => rawProject.find((x: any) => pred(x.content) && !projPending(x) && !rawRepo.some((i: any) => i.number === x.content.number))!.content.number as number;
const CLOSED_ISSUE = pickProj((c) => c.__typename === 'Issue' && c.state === 'CLOSED');
const MERGED_PR = pickProj((c) => c.__typename === 'PullRequest' && c.merged);
/** labelled in the recording but closed / merged: history, never counted (GitHub#251) */
const HISTORY = rawProject.filter((x: any) => projPending(x) && x.content.state !== 'OPEN').length + rawRepo.filter((i: any) => repoPending(i) && i.state !== 'open').length;
/** pending (open + labelled) in the Project / the repository source after seeding */
const P = rawProject.filter((x: any) => projPending(x) && x.content.state === 'OPEN').length + 1;
const R = rawRepo.filter((i: any) => repoPending(i) && i.state === 'open').length + 1;
/**
 * A label some open item carries, other than the pending one (for "another label name"), and on
 * none of the items these tests label: renaming to it must really take those out of "pending".
 */
const OTHER = (() => {
  const ours = new Set([SEEDED, OPEN_NEW, OPEN_NEW2]);
  const onOurs = new Set(rawProject.filter((x: any) => ours.has(x.content.number)).flatMap((x: any) => x.content.labels.nodes.map((l: any) => l.name)));
  const counts = new Map<string, Set<number>>();
  for (const x of rawProject)
    if (x.content.state === 'OPEN')
      for (const l of x.content.labels.nodes) if (l.name !== LABEL && !onOurs.has(l.name)) counts.set(l.name, (counts.get(l.name) ?? new Set()).add(x.content.number));
  const [name, items] = [...counts].sort((a, b) => b[1].size - a[1].size)[0];
  return { name, open: items.size };
})();

beforeEach(async () => {
  fake = await startFakeGitHub();
  dir = tempDir();
  setLabel(SEEDED, true, { t: FIXTURE_NOW - 3_600_000 });
});

it('the recording still has what these tests need', () => {
  expect([SEEDED, OPEN_NEW, OPEN_NEW2].every((n) => Number.isInteger(n) && repoOpen(n))).toBe(true);
  expect(HISTORY).toBeGreaterThan(0); // closed / merged items carrying the label: what "count everything" would show
  expect([CLOSED_ISSUE, MERGED_PR].every(Number.isInteger)).toBe(true);
  expect(OTHER.open).toBeGreaterThan(0);
});
afterEach(async () => {
  for (const c of controllers) c.stopTimer();
  // a detail still being read ahead (GitHub#328) ends before its back end goes
  await Promise.all(controllers.map((c) => c.prefetchSettled()));
  await Promise.all(backends.map((b) => b.close()));
  for (const c of caches) c.close();
  caches = [];
  controllers = [];
  backends = [];
  await fake.close();
});

describe('pending reminders against the fake GitHub', () => {
  it('start: nothing is notified or summarised, the badge stays 0 (the window was never in front), closed / merged history is not counted', async () => {
    const h = await signedIn({ sources: [PROJECT_URL, REPO] });
    await h.c.start();
    await h.c.desktopSettled();
    // "did happen": both sources were read completely, and the board shows the labelled history
    expect(h.c.getState().sync.sources.every((s) => s.ok)).toBe(true);
    const history = h.c.getBoardData().items.filter((i) => i.state !== 'open' && i.labels.some((l) => l.name === LABEL));
    expect(history.length).toBe(HISTORY);
    expect(labelledOnBoard(h, SEEDED)).toBe(true);
    expect(h.alerts).toEqual([]);
    expect(h.badge()).toBe(0);
    expect(h.c.getState().pendingCount).toBe(P);
    // a quiet round changes nothing
    await tick(h);
    expect(h.alerts).toEqual([]);
    expect(h.badge()).toBe(0);
  });

  it('from nothing to pending: an open issue is notified exactly once; a closed issue and a merged PR are not', async () => {
    const h = await signedIn({ sources: [PROJECT_URL] });
    await h.c.start();
    await h.c.desktopSettled();
    setLabel(OPEN_NEW, true, h.clock); // open issue
    setLabel(CLOSED_ISSUE, true, h.clock); // closed issue
    setLabel(MERGED_PR, true, h.clock); // merged PR
    await tick(h);
    // "did happen": this round read all three with the label
    expect([OPEN_NEW, CLOSED_ISSUE, MERGED_PR].every((n) => labelledOnBoard(h, n))).toBe(true);
    expect(h.items()).toEqual([key(OPEN_NEW)]);
    const a = h.alerts[0] as Extract<Alert, { kind: 'item' }>;
    expect(a.title).toBe(`待处理：${REPO}#${OPEN_NEW}`);
    expect(a.url).toContain(`/issues/${OPEN_NEW}`);
    expect(h.badge()).toBe(1);
    expect(h.c.getState().pendingCount).toBe(P + 1);
    // still pending next round: no second notification
    await tick(h);
    await tick(h);
    expect(h.items()).toEqual([key(OPEN_NEW)]);
  });

  it('a labelled closed issue reopened is notified once; closed again before anyone looked, it is no longer unread', async () => {
    const h = await signedIn({ sources: [PROJECT_URL] });
    await h.c.start();
    await h.c.desktopSettled();
    setLabel(CLOSED_ISSUE, true, h.clock);
    await tick(h);
    expect(labelledOnBoard(h, CLOSED_ISSUE)).toBe(true);
    expect(h.items()).toEqual([]);
    setOpen(CLOSED_ISSUE, true, h.clock);
    await tick(h);
    expect(h.items()).toEqual([key(CLOSED_ISSUE)]);
    expect(h.badge()).toBe(1);
    setOpen(CLOSED_ISSUE, false, h.clock);
    await tick(h);
    expect(h.badge()).toBe(0);
    expect(h.c.getState().pendingCount).toBe(P);
    expect(h.items()).toEqual([key(CLOSED_ISSUE)]);
  });

  it('label removed and put back → notified again; the removal itself is silent', async () => {
    const h = await signedIn({ sources: [PROJECT_URL] });
    await h.c.start();
    await h.c.desktopSettled();
    setLabel(SEEDED, false, h.clock);
    await tick(h);
    expect(h.items()).toEqual([]);
    expect(h.c.getState().pendingCount).toBe(P - 1);
    setLabel(SEEDED, true, h.clock);
    await tick(h);
    expect(h.items()).toEqual([key(SEEDED)]);
    expect(h.badge()).toBe(1);
  });

  it('an item carried by two sources is notified once, counted once', async () => {
    const h = await signedIn({ sources: [PROJECT_URL, REPO] });
    await h.c.start();
    await h.c.desktopSettled();
    setLabel(OPEN_NEW, true, h.clock);
    await tick(h);
    // "did happen": both sources were read this round and both carry the item
    expect(h.c.getState().sync.sources.every((s) => s.ok)).toBe(true);
    const data = h.c.getBoardData().items.find((i) => i.key === key(OPEN_NEW))!;
    expect(data.sources.sort()).toEqual([PROJECT_KEY, REPO_KEY].sort());
    expect(h.items()).toEqual([key(OPEN_NEW)]);
    expect(h.badge()).toBe(1);
    expect(h.c.getState().pendingCount).toBe(P + 1);
  });

  it('a source that fails mid-pagination: neither new nor removed that round; the real change is notified after it recovers', async () => {
    const h = await signedIn({ sources: [PROJECT_URL] });
    await h.c.start();
    await h.c.desktopSettled();
    // page 2 fails; meanwhile one label went away and one came
    fake.state.failProjectPage.set('org/gigleai/11', 1);
    setLabel(SEEDED, false, h.clock);
    setLabel(OPEN_NEW, true, h.clock);
    await tick(h);
    expect(h.c.getState().sync.sources[0]).toMatchObject({ ok: false });
    expect(h.items()).toEqual([]);
    expect(h.c.getState().pendingCount).toBe(P);
    // still failing: still nothing
    await tick(h);
    expect(h.items()).toEqual([]);
    // recovers: the real change shows — the newly labelled one is new, the removed one just drops out
    // (GitHub#374: after two failures in a row the board waits 2 minutes for its next read — one more minute)
    fake.state.failProjectPage.delete('org/gigleai/11');
    h.clock.t += 60_000;
    await tick(h);
    expect(h.items()).toEqual([key(OPEN_NEW)]);
    expect(h.badge()).toBe(1);
    expect(h.c.getState().pendingCount).toBe(P);
  });

  it('offline rounds and back: the same items are not notified again', async () => {
    const h = await signedIn({ sources: [PROJECT_URL, REPO] });
    await h.c.start();
    await h.c.desktopSettled();
    setLabel(OPEN_NEW, true, h.clock);
    await tick(h);
    expect(h.items()).toEqual([key(OPEN_NEW)]);
    fake.state.offline = true;
    await tick(h);
    await tick(h);
    expect(h.c.getState().sync.offline).toBe(true);
    expect(h.badge()).toBe(1);
    fake.state.offline = false;
    await tick(h);
    expect(h.c.getState().sync.offline).toBe(false);
    expect(h.items()).toEqual([key(OPEN_NEW)]);
    expect(h.badge()).toBe(1);
  });

  it('start offline: nothing until the first complete read, which is only a baseline; later labels are notified', async () => {
    const first = await signedIn({ sources: [PROJECT_URL] });
    await first.c.start();
    await first.c.desktopSettled();
    await first.c.settled();
    await first.backend.close();
    fake.state.offline = true;
    const h = await signedIn({ clock: first.clock });
    await h.c.start();
    await h.c.desktopSettled();
    expect(h.c.getBoardData().items.length).toBeGreaterThan(0); // the cache shows
    expect(h.c.getState().pendingCount).toBe(0);
    fake.state.offline = false;
    await tick(h);
    expect(h.c.getState().pendingCount).toBe(P); // the baseline was taken
    expect(h.alerts).toEqual([]);
    expect(h.badge()).toBe(0);
    setLabel(OPEN_NEW, true, h.clock);
    await tick(h);
    expect(h.items()).toEqual([key(OPEN_NEW)]);
  });

  it('a newly added source: what it already has is silent — no notification, no summary, not unread', async () => {
    const h = await signedIn({ sources: [REPO] });
    await h.c.start();
    await h.c.desktopSettled();
    expect(h.c.getState().pendingCount).toBe(R);
    // an open labelled issue only the Project carries
    setLabel(CLOSED_ISSUE, true, h.clock);
    setOpen(CLOSED_ISSUE, true, h.clock);
    h.c.addSource(PROJECT_URL);
    await h.c.syncNow();
    await h.c.desktopSettled();
    expect(labelledOnBoard(h, CLOSED_ISSUE)).toBe(true);
    expect(h.c.getState().pendingCount).toBe(R + 1);
    expect(h.alerts).toEqual([]);
    expect(h.badge()).toBe(0);
    // and from then on it is a normal source
    setLabel(OPEN_NEW, true, h.clock);
    await tick(h);
    expect(h.items()).toEqual([key(OPEN_NEW)]);
  });

  it('a new label during the round that adds a source is still a notification when another source already had a baseline', async () => {
    const h = await signedIn({ sources: [REPO] });
    await h.c.start();
    await h.c.desktopSettled();
    setLabel(OPEN_NEW, true, h.clock); // in both sources
    h.c.addSource(PROJECT_URL);
    await h.c.syncNow();
    await h.c.desktopSettled();
    expect(h.items()).toEqual([key(OPEN_NEW)]);
    expect(h.badge()).toBe(1);
    expectBadgeIsUnread(h);
  });

  it('removing a source drops what only it carried, silently', async () => {
    const h = await signedIn({ sources: [PROJECT_URL, REPO] });
    setLabel(CLOSED_ISSUE, true, h.clock);
    setOpen(CLOSED_ISSUE, true, h.clock);
    await h.c.start();
    await h.c.desktopSettled();
    expect(h.c.getState().pendingCount).toBe(P + 1);
    h.c.removeSource(PROJECT_KEY);
    await h.c.desktopSettled();
    expect(h.c.getState().pendingCount).toBe(R);
    await tick(h);
    expect(h.alerts).toEqual([]);
    expect(h.badge()).toBe(0);
  });

  it('another label name: recounted silently; label match ignores case like GitHub; one setting with "hand back to agent"', async () => {
    const h = await signedIn({ sources: [PROJECT_URL] });
    await h.c.start();
    await h.c.desktopSettled();
    // the reminder label IS the "waiting for a human" label that hand-back removes
    h.c.setHandBack({ human: `  ${OTHER.name.toUpperCase()} ` });
    await h.c.desktopSettled();
    expect(h.c.getState().handBack.human).toBe(OTHER.name.toUpperCase());
    expect(h.c.getState().pendingCount).toBe(OTHER.open);
    // a settings change brings no new unread item and no notification
    expect(h.badge()).toBe(0);
    await tick(h);
    expect(h.alerts).toEqual([]);
    // changing only the other label does not touch the count
    const before = h.badges.length;
    h.c.setHandBack({ agent: 'ready/agent' });
    await h.c.desktopSettled();
    expect(h.badges.length).toBe(before);
    // empty = back to the default
    h.c.setHandBack({ human: '' });
    await h.c.desktopSettled();
    expect(h.c.getState().handBack.human).toBe(LABEL);
    expect(h.c.getState().pendingCount).toBe(P);
    expect(h.badge()).toBe(0);
  });

  it('a configured label name survives a restart and is the one used', async () => {
    const h = await signedIn({ sources: [PROJECT_URL], seed: { handBack: { human: OTHER.name, agent: 'pending/agent' } } });
    await h.c.start();
    await h.c.desktopSettled();
    expect(h.c.getState().handBack.human).toBe(OTHER.name);
    expect(h.c.getState().pendingCount).toBe(OTHER.open);
    expect(h.alerts).toEqual([]);
    expect(h.badge()).toBe(0);
  });

  it('sign out clears the badge and the count; signing in again takes a new baseline, silently', async () => {
    const h = await signedIn({ sources: [PROJECT_URL] });
    await h.c.start();
    await h.c.desktopSettled();
    setLabel(OPEN_NEW, true, h.clock);
    await tick(h);
    expect(h.badge()).toBe(1);
    await h.c.logout();
    await h.c.desktopSettled();
    expect(h.badge()).toBe(0);
    expect(h.c.getState().pendingCount).toBe(0);
    // labelled while signed out, then the same account signs in again through the browser
    setLabel(OPEN_NEW2, true, h.clock);
    fake.state.nextGrant = { token: FAKE_TOKEN };
    h.c.setClientId(fake.state.oauthClientId);
    const login = h.c.startLogin();
    for (let i = 0; i < 500 && h.c.getState().login.status !== 'waiting'; i++) await new Promise((r) => setTimeout(r, 10));
    fake.resolveGrant('approved');
    await login;
    await h.c.desktopSettled();
    // "did happen": signed in and read again, both labelled items pending through that read
    expect(h.c.getState().phase).toBe('ready');
    expect(h.c.getState().pendingCount).toBe(P + 2);
    // ...but that first read is history: nothing notified since, nothing unread
    expect(h.items()).toEqual([key(OPEN_NEW)]);
    expect(h.badge()).toBe(0);
  });
});

describe('the badge is only the unread count (GitHub#185, #251)', () => {
  it('switching to the window clears the badge and keeps the notifications (GitHub#369); what comes while it is in front is not unread; leaving it counts anew', async () => {
    const h = await signedIn({ sources: [PROJECT_URL] });
    await h.c.start();
    await h.c.desktopSettled();
    // never looked at, but what was there at start is history: not unread
    expect(h.badge()).toBe(0);
    setLabel(OPEN_NEW, true, h.clock);
    await tick(h);
    expect(h.badge()).toBe(1);
    expect(h.cleared).toEqual([]);
    // the user switches to the window: badge 0; the delivered notifications stay (GitHub#369), nothing else changes
    expect(h.c.getState().clearAllOnActivate).toBe(false);
    const badgesBefore = h.badges.length;
    h.c.onDesktopEvent({ kind: 'active' });
    await h.c.desktopSettled();
    // "did happen": the switch was taken — a new badge call went out, and it is 0
    expect(h.badges.length).toBeGreaterThan(badgesBefore);
    expect(h.badge()).toBe(0);
    expect(h.cleared).toEqual([]);
    expect(h.c.getState().unreadCount).toBe(0);
    expect(h.c.getState().pendingCount).toBe(P + 1);
    // a new label while the window is in front: notified as before, but already seen
    setLabel(OPEN_NEW2, true, h.clock);
    await tick(h);
    expect(h.items()).toEqual([key(OPEN_NEW), key(OPEN_NEW2)]);
    expect(h.badge()).toBe(0);
    // the user leaves the window: the next new item is unread again
    h.c.onDesktopEvent({ kind: 'inactive' });
    setLabel(CLOSED_ISSUE, true, h.clock);
    setOpen(CLOSED_ISSUE, true, h.clock);
    await tick(h);
    expect(h.items()).toEqual([key(OPEN_NEW), key(OPEN_NEW2), key(CLOSED_ISSUE)]);
    expect(h.badge()).toBe(1);
    // its label taken off before anyone looked: nothing to read any more
    setLabel(CLOSED_ISSUE, false, h.clock);
    await tick(h);
    expect(h.badge()).toBe(0);
    // put back while still not looked at: unread again (and notified again, as before)
    setLabel(CLOSED_ISSUE, true, h.clock);
    await tick(h);
    expect(h.badge()).toBe(1);
    // back to the window: read; the notifications still stay
    h.c.onDesktopEvent({ kind: 'active' });
    await h.c.desktopSettled();
    expect(h.badge()).toBe(0);
    expect(h.cleared).toEqual([]);
  });

  it('GitHub#369: ticked in Settings, switching to the window takes back every notification again (after the badge goes to 0); unticked, they stay again', async () => {
    const h = await signedIn({ sources: [PROJECT_URL] });
    await h.c.start();
    await h.c.desktopSettled();
    h.c.onDesktopEvent({ kind: 'inactive' });
    setLabel(OPEN_NEW, true, h.clock);
    await tick(h);
    expect(h.badge()).toBe(1);
    h.c.setClearAllOnActivate(true);
    h.c.setClearAllOnActivate('yes' as any); // not a boolean: ignored
    expect(h.c.getState().clearAllOnActivate).toBe(true);
    h.c.onDesktopEvent({ kind: 'active' });
    await h.c.desktopSettled();
    expect(h.badge()).toBe(0);
    expect(h.cleared).toHaveLength(1);
    // the take-back went out after the badge set to 0 by the same switch
    expect(h.badges[h.cleared[0] - 1]).toBe(0);
    // unticked: the next switch keeps them
    h.c.setClearAllOnActivate(false);
    h.c.onDesktopEvent({ kind: 'inactive' });
    setLabel(OPEN_NEW2, true, h.clock);
    await tick(h);
    expect(h.badge()).toBe(1);
    h.c.onDesktopEvent({ kind: 'active' });
    await h.c.desktopSettled();
    expect(h.badge()).toBe(0);
    expect(h.cleared).toHaveLength(1);
  });

  it('a settings change brings no unread item; renaming the label and back keeps what was unread', async () => {
    const h = await signedIn({ sources: [PROJECT_URL] });
    await h.c.start();
    await h.c.desktopSettled();
    setLabel(OPEN_NEW, true, h.clock);
    await tick(h);
    expect(h.badge()).toBe(1);
    h.c.setHandBack({ human: OTHER.name });
    await h.c.desktopSettled();
    // items with the other label are pending now, but nobody was told about them as new: not unread
    expect(h.c.getState().pendingCount).toBe(OTHER.open);
    expect(h.badge()).toBe(h.c.getState().unreadCount);
    expect(h.badge()).toBeLessThanOrEqual(1);
    h.c.setHandBack({ human: '' });
    await h.c.desktopSettled();
    expect(h.badge()).toBe(1);
  });

  it('sign-out forgets what was unread', async () => {
    const h = await signedIn({ sources: [PROJECT_URL] });
    await h.c.start();
    await h.c.desktopSettled();
    setLabel(OPEN_NEW, true, h.clock);
    await tick(h);
    expect(h.badge()).toBe(1);
    await h.c.logout();
    await h.c.desktopSettled();
    expect(h.badge()).toBe(0);
    expect(h.c.getState().unreadCount).toBe(0);
  });
});

describe('a notification the system refuses', () => {
  it('is shown in the app (not silently lost) and cleared once one goes out again; the badge is unaffected', async () => {
    const delivery = { refuse: 'Notifications are not allowed for this application' as string | null };
    const h = await signedIn({ sources: [PROJECT_URL], delivery });
    await h.c.start();
    await h.c.desktopSettled();
    setLabel(OPEN_NEW, true, h.clock);
    await tick(h);
    await settle();
    // "did happen": the notification was sent and refused
    expect(h.items()).toEqual([key(OPEN_NEW)]);
    expect(h.c.getState().notifyProblem).toBe('Notifications are not allowed for this application');
    expect(h.badge()).toBe(1);
    // the user allows notifications; the next one goes out and the warning goes away
    delivery.refuse = null;
    setLabel(OPEN_NEW2, true, h.clock);
    await tick(h);
    await settle();
    expect(h.items()).toEqual([key(OPEN_NEW), key(OPEN_NEW2)]);
    expect(h.c.getState().notifyProblem).toBeNull();
  });
});

describe('the tracker on its own', () => {
  const snap = (sourceKey: string, ...items: ReturnType<typeof item>[]): SourceSnapshot => ({ sourceKey, fetchedAt: 0, items });
  const pend = (n: number, extra = {}) => item('o/r', n, { labels: [{ name: LABEL, color: '' }], ...extra });

  it('only open items are pending: a closed issue and a merged / closed PR never are; a draft PR is; reopened counts as new', () => {
    const t = new PendingTracker(LABEL);
    t.observe([snap('a')], ['a']);
    const ch = t.observe(
      [snap('a', pend(1, { state: 'closed' }), pend(2, { state: 'merged', kind: 'pr' }), pend(3, { state: 'closed', kind: 'pr' }), pend(4, { kind: 'pr', isDraft: true }), pend(5))],
      ['a'],
    );
    expect(ch.appeared.map((i) => i.number).sort()).toEqual([4, 5]);
    expect(t.count()).toBe(2);
    expect(t.has('o/r#1')).toBe(false);
    expect(t.has('o/r#5')).toBe(true);
    // #1 reopened with its label: new; #5 closed: drops out, silently
    const next = t.observe([snap('a', pend(1), pend(2, { state: 'merged', kind: 'pr' }), pend(4, { kind: 'pr', isDraft: true }), pend(5, { state: 'closed' }))], ['a']);
    expect(next.appeared.map((i) => i.number)).toEqual([1]);
    expect(t.has('o/r#5')).toBe(false);
  });

  it('a first read is only a baseline: at start, and for a source added next to one that already had its baseline', () => {
    const t = new PendingTracker(LABEL);
    expect(t.observe([snap('a', pend(1))], ['a']).appeared).toEqual([]);
    expect(t.count()).toBe(1);
    // b is read for the first time while a newly carries #3: only #3 is new
    const ch = t.observe([snap('a', pend(1), pend(3)), snap('b', pend(2), pend(3))], ['a', 'b']);
    expect(ch.appeared.map((i) => i.number)).toEqual([3]);
    expect(t.count()).toBe(3);
  });

  it('two sources that both start carrying one item in the same round: one notification', () => {
    const t = new PendingTracker(LABEL);
    t.observe([snap('a'), snap('b')], ['a', 'b']);
    const ch = t.observe([snap('a', pend(1)), snap('b', pend(1))], ['a', 'b']);
    expect(ch.appeared).toHaveLength(1);
    expect(t.count()).toBe(1);
  });

  it('an item still carried by a source that failed is not "removed" when the other source drops it', () => {
    const t = new PendingTracker(LABEL);
    t.observe([snap('a', pend(1)), snap('b', pend(1))], ['a', 'b']);
    // b failed this round (not in fresh); a no longer has it
    t.observe([snap('a')], ['a', 'b']);
    expect(t.count()).toBe(1);
    // b reads fine and still has it: nothing new
    expect(t.observe([snap('a'), snap('b', pend(1))], ['a', 'b']).appeared).toEqual([]);
  });
});

describe('what the shell tells the window (GitHub#169)', () => {
  /** a desktop whose events the test sends, one at a time */
  function feed(h: Harness) {
    const queue: DesktopEvent[] = [];
    const waiters: ((e: DesktopEvent) => void)[] = [];
    return {
      push(e: DesktopEvent) {
        const w = waiters.shift();
        if (w) w(e);
        else queue.push(e);
      },
      next: () => (queue.length ? Promise.resolve(queue.shift()!) : new Promise<DesktopEvent>((r) => waiters.push(r))),
      h,
    };
  }

  it('a sync beat from the shell runs a round: a new label is notified without any timer in the window', async () => {
    const h = await signedIn({ sources: [PROJECT_URL] });
    await h.c.start();
    await h.c.desktopSettled();
    const f = feed(h);
    (h.c as any).deps.desktop.nextEvent = f.next;
    void h.c.runDesktopEvents();
    setLabel(OPEN_NEW, true, h.clock);
    h.clock.t += 60_000;
    const rounds = () => h.backend.sent.filter((m) => m.cmd === 'replaceSnapshots').length;
    const before = rounds();
    f.push({ kind: 'tick' });
    for (let i = 0; i < 300 && !h.items().length; i++) await new Promise((r) => setTimeout(r, 10));
    expect(rounds()).toBeGreaterThan(before);
    expect(h.items()).toEqual([key(OPEN_NEW)]);
    h.c.stopDesktopEvents();
  });

  it('a clicked item notification opens that item in the app; one no longer on the board opens on GitHub', async () => {
    const h = await signedIn({ sources: [PROJECT_URL] });
    await h.c.start();
    await h.c.desktopSettled();
    h.c.onDesktopEvent({ kind: 'open', key: key(SEEDED), url: `https://github.com/${REPO}/issues/${SEEDED}` });
    const f1 = h.c.getState().focus;
    expect(f1).toMatchObject({ key: key(SEEDED) });
    expect(h.opened).toEqual([]);
    // the same item clicked again is a new request
    h.c.onDesktopEvent({ kind: 'open', key: key(SEEDED), url: `https://github.com/${REPO}/issues/${SEEDED}` });
    expect(h.c.getState().focus!.seq).toBeGreaterThan(f1!.seq);
    // not on the board (e.g. its source was removed): the browser, through the back end's GitHub-only rule
    h.c.onDesktopEvent({ kind: 'open', key: 'someone/else#1', url: 'https://github.com/someone/else/issues/1' });
    for (let i = 0; i < 100 && !h.opened.length; i++) await new Promise((r) => setTimeout(r, 10));
    expect(h.opened).toEqual(['https://github.com/someone/else/issues/1']);
    expect(h.c.getState().focus!.key).toBe(key(SEEDED));
  });

  it('launch at login: read from the system, set through it, hidden where the platform cannot', async () => {
    const h = await signedIn({ sources: [PROJECT_URL] });
    await h.c.start();
    await h.c.desktopSettled();
    await settle();
    expect(h.c.getState().launchAtLogin).toBe(false);
    await h.c.setLaunchAtLogin(true);
    expect(h.loginItem.sets).toEqual([true]);
    expect(h.c.getState().launchAtLogin).toBe(true);
    const off = await signedIn({ loginItem: null });
    await off.c.start();
    await off.c.desktopSettled();
    await settle();
    expect(off.c.getState().launchAtLogin).toBeNull();
    await off.c.setLaunchAtLogin(true);
    expect(off.loginItem.sets).toEqual([]);
  });

  it('a notification call that itself fails is shown like a refusal', async () => {
    const h = await signedIn({ sources: [PROJECT_URL] });
    (h.c as any).deps.desktop.notify = async () => {
      throw new Error('shell went away');
    };
    await h.c.start();
    await h.c.desktopSettled();
    setLabel(OPEN_NEW, true, h.clock);
    await tick(h);
    await settle();
    expect(h.c.getState().notifyProblem).toBe('shell went away');
    expect(h.badge()).toBe(1);
  });
});

describe('calls to the shell that wait while things change (PR #173 review round 1)', () => {
  /** The first notification is held by "the system" until `release`; later ones answer at once. */
  function holdFirst(h: Harness) {
    const calls: Alert[] = [];
    let release: (d: { ok: boolean; error?: string }) => void = () => {};
    (h.c as any).deps.desktop.notify = (a: Alert) => {
      calls.push(a);
      if (calls.length === 1) return new Promise((r) => (release = r));
      return Promise.resolve({ ok: false, error: 'old account refusal' });
    };
    return { calls, release: (d: { ok: boolean; error?: string }) => release(d) };
  }

  it('signed out while a notification waits for the system: nothing more of that account goes out, its answer is ignored, the badge clears at once', async () => {
    const h = await signedIn({ sources: [PROJECT_URL] });
    await h.c.start();
    await h.c.desktopSettled();
    const held = holdFirst(h);
    setLabel(OPEN_NEW, true, h.clock);
    setLabel(OPEN_NEW2, true, h.clock);
    h.clock.t += 60_000;
    await h.c.syncNow();
    await settle();
    // "did happen": the round produced two notifications, the first is with the system
    expect(held.calls).toHaveLength(1);
    await h.c.logout();
    await h.c.desktopSettled();
    // the cleared badge does not wait for the system's answer
    expect(h.badge()).toBe(0);
    held.release({ ok: false, error: 'old account refusal' });
    await settle();
    await h.c.desktopSettled();
    expect(held.calls).toHaveLength(1);
    expect(h.c.getState().notifyProblem).toBeNull();
    expect(h.c.getState().phase).toBe('login');
  });

  it('a source removed while a notification waits: the queued notification for its item is not sent', async () => {
    const h = await signedIn({ sources: [PROJECT_URL] });
    await h.c.start();
    await h.c.desktopSettled();
    const held = holdFirst(h);
    setLabel(OPEN_NEW, true, h.clock);
    setLabel(OPEN_NEW2, true, h.clock);
    h.clock.t += 60_000;
    await h.c.syncNow();
    await settle();
    expect(held.calls).toHaveLength(1);
    h.c.removeSource(PROJECT_KEY);
    held.release({ ok: true });
    await settle();
    await h.c.desktopSettled();
    // only the one already with the system; the other one's source is gone
    expect(held.calls).toHaveLength(1);
    expect(h.badge()).toBe(0);
  });

  it('the label renamed while a notification waits: the queued one, no longer pending, is not sent', async () => {
    const h = await signedIn({ sources: [PROJECT_URL] });
    await h.c.start();
    await h.c.desktopSettled();
    const held = holdFirst(h);
    setLabel(OPEN_NEW, true, h.clock);
    setLabel(OPEN_NEW2, true, h.clock);
    h.clock.t += 60_000;
    await h.c.syncNow();
    await settle();
    expect(held.calls).toHaveLength(1);
    h.c.setHandBack({ human: 'some-other-label' });
    held.release({ ok: true });
    await settle();
    await h.c.desktopSettled();
    expect(held.calls).toHaveLength(1);
    expect(h.badge()).toBe(0);
  });
});

describe('one rule for every queued notification, across context changes (PR #173 review round 2)', () => {
  /** Hold the first notification with "the system"; the rest answer at once. */
  function holdFirst(h: Harness) {
    const calls: Alert[] = [];
    let release: () => void = () => {};
    (h.c as any).deps.desktop.notify = (a: Alert) => {
      calls.push(a);
      if (calls.length === 1) return new Promise((r) => (release = () => r({ ok: true })));
      return Promise.resolve({ ok: true });
    };
    return { calls, release: () => release() };
  }
  const keysOf = (calls: Alert[]) => calls.filter((a) => a.kind === 'item').map((a) => (a as { key: string }).key);
  async function release(h: Harness, held: { release: () => void }) {
    held.release();
    await settle();
    await h.c.desktopSettled();
  }

  it('a source removed and added back while an item notification is queued: the old one is not sent, the new addition sends nothing', async () => {
    const h = await signedIn({ sources: [PROJECT_URL] });
    await h.c.start();
    await h.c.desktopSettled();
    const held = holdFirst(h);
    setLabel(OPEN_NEW, true, h.clock);
    setLabel(OPEN_NEW2, true, h.clock);
    h.clock.t += 60_000;
    await h.c.syncNow();
    await settle();
    expect(held.calls).toHaveLength(1);
    h.c.removeSource(PROJECT_KEY);
    h.c.addSource(PROJECT_URL);
    await h.c.syncNow();
    await release(h, held);
    // the held one was already with the system; the second old one never goes out; the re-added source is only a baseline
    expect(held.calls).toHaveLength(1);
    // "did happen": the re-added source was read again, both items pending through it
    expect(h.c.getState().pendingCount).toBe(P + 2);
    // both were unread before and nobody has looked since: still unread (only switching to the window reads them)
    expect(h.badge()).toBe(2);
  });

  it('one of two sources carrying an item is removed while its notification is queued: still sent (one item, one notification across sources); an item only that source carried is not', async () => {
    const h = await signedIn({ sources: [PROJECT_URL, REPO] });
    await h.c.start();
    await h.c.desktopSettled();
    const held = holdFirst(h);
    setLabel(OPEN_NEW, true, h.clock); // both sources
    setLabel(CLOSED_ISSUE, true, h.clock); // the board only, reopened
    setOpen(CLOSED_ISSUE, true, h.clock);
    h.clock.t += 60_000;
    await h.c.syncNow();
    await settle();
    expect(held.calls).toHaveLength(1);
    const first = keysOf(held.calls)[0];
    h.c.removeSource(PROJECT_KEY);
    await release(h, held);
    // whichever went first is already out; of the queued one: the repository still carries OPEN_NEW, nothing carries CLOSED_ISSUE
    const expected = first === key(OPEN_NEW) ? [key(OPEN_NEW)] : [key(CLOSED_ISSUE), key(OPEN_NEW)];
    expect(keysOf(held.calls)).toEqual(expected);
  });

  it('the label renamed and renamed back while a notification is queued: a settings change is silent, the queued one is not sent', async () => {
    const h = await signedIn({ sources: [PROJECT_URL] });
    await h.c.start();
    await h.c.desktopSettled();
    const held = holdFirst(h);
    setLabel(OPEN_NEW, true, h.clock);
    setLabel(OPEN_NEW2, true, h.clock);
    h.clock.t += 60_000;
    await h.c.syncNow();
    await settle();
    expect(held.calls).toHaveLength(1);
    h.c.setHandBack({ human: 'some-other-label' });
    h.c.setHandBack({ human: LABEL });
    await release(h, held);
    expect(held.calls).toHaveLength(1);
    expect(h.badge()).toBe(2);
  });

  it('nothing changes while one waits: every queued notification goes out (the rule does not drop valid ones)', async () => {
    const h = await signedIn({ sources: [PROJECT_URL] });
    await h.c.start();
    await h.c.desktopSettled();
    const held = holdFirst(h);
    setLabel(OPEN_NEW, true, h.clock);
    setLabel(OPEN_NEW2, true, h.clock);
    h.clock.t += 60_000;
    await h.c.syncNow();
    await release(h, held);
    expect(keysOf(held.calls).sort()).toEqual([key(OPEN_NEW), key(OPEN_NEW2)].sort());
  });
});

// GitHub#328: the detail of an item just notified is read ahead, so a click on the notification
// shows it at once. Same layers as above: real sync rounds against the fake GitHub, the detail
// requests counted in the fake's own log.
describe('details read ahead of the click (GitHub#328)', () => {
  const detailReads = () => fake.log.filter((e) => e.operation === 'CavilItemDetail');
  const readNumbers = () => detailReads().map((e) => e.variables?.number as number);
  /** issues on the board without the label (the test opens the closed ones first): enough of them for "more than one round reads ahead" */
  const MANY = rawProject
    .filter((x: any) => x.content.__typename === 'Issue' && !projPending(x) && x.content.repository.nameWithOwner === REPO && x.content.number !== SEEDED)
    .map((x: any) => x.content.number as number)
    .filter((n, i, a) => a.indexOf(n) === i)
    .slice(0, PREFETCH_PER_ROUND + 2);
  const until = async (cond: () => boolean, what: string) => {
    for (let i = 0; i < 400; i++) {
      if (cond()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`timed out waiting for ${what}`);
  };
  /** A round one minute later; its notifications are out and every read ahead has ended. */
  async function round(h: Harness) {
    h.clock.t += 60_000;
    await h.c.syncNow();
    await h.c.prefetchSettled();
  }

  it('a newly pending item: its detail is in the cache without anyone opening it; what a first read finds is not read ahead', async () => {
    const h = await signedIn({ sources: [PROJECT_URL] });
    await h.c.start();
    await h.c.prefetchSettled();
    // the first read is history: no detail request, though the round did read the board (the seeded item is pending)
    expect(h.c.getState().pendingCount).toBeGreaterThan(0);
    expect(labelledOnBoard(h, SEEDED)).toBe(true);
    expect(detailReads()).toEqual([]);
    expect(h.c.cachedDetail(key(SEEDED))).toBeNull();

    setLabel(OPEN_NEW, true, h.clock);
    await round(h);
    expect(h.items()).toEqual([key(OPEN_NEW)]);
    expect(readNumbers()).toEqual([OPEN_NEW]);
    expect(detailReads()[0].status).toBe(200);
    const kept = h.c.cachedDetail(key(OPEN_NEW));
    expect(kept?.number).toBe(OPEN_NEW);
    expect(kept?.fetchedAt).toBe(h.clock.t);
    // a round with nothing new reads nothing ahead
    await round(h);
    expect(readNumbers()).toEqual([OPEN_NEW]);
  });

  it(`more new items than ${PREFETCH_PER_ROUND} in one round: only the first ${PREFETCH_PER_ROUND} notified are read, one request at a time`, async () => {
    expect(MANY).toHaveLength(PREFETCH_PER_ROUND + 2);
    for (const n of MANY) setOpen(n, true, { t: FIXTURE_NOW - 3_600_000 });
    const h = await signedIn({ sources: [PROJECT_URL] });
    await h.c.start();
    await h.c.prefetchSettled();
    for (const n of MANY) setLabel(n, true, h.clock);
    let most = 0;
    h.clock.t += 60_000;
    await h.c.syncNow();
    await h.c.desktopSettled();
    // watch the log while the queue drains: requests sent minus requests answered
    const watch = setInterval(() => (most = Math.max(most, detailReads().filter((e) => e.status === 0).length)), 1);
    await h.c.prefetchSettled();
    clearInterval(watch);
    expect(h.items()).toHaveLength(MANY.length);
    expect(readNumbers()).toHaveLength(PREFETCH_PER_ROUND);
    expect(readNumbers().map(key)).toEqual(h.items().slice(0, PREFETCH_PER_ROUND));
    expect(most).toBeLessThanOrEqual(1);
  });

  it('one request at a time: while the first answer is held, no second detail request is sent', async () => {
    const h = await signedIn({ sources: [PROJECT_URL] });
    await h.c.start();
    await h.c.prefetchSettled();
    setLabel(OPEN_NEW, true, h.clock);
    setLabel(OPEN_NEW2, true, h.clock);
    const release = fake.holdWhen((e) => e.operation === 'CavilItemDetail');
    h.clock.t += 60_000;
    await h.c.syncNow();
    await until(() => detailReads().length === 1, 'the first read ahead');
    await settle();
    await settle();
    expect(detailReads()).toHaveLength(1);
    release();
    await h.c.prefetchSettled();
    expect(readNumbers().sort()).toEqual([OPEN_NEW, OPEN_NEW2].sort());
  });

  it('the reads start only after the notifications and the badge were handed to the shell', async () => {
    const h = await signedIn({ sources: [PROJECT_URL] });
    await h.c.start();
    await h.c.prefetchSettled();
    const d = (h.c as any).deps.desktop as Desktop;
    const order: string[] = [];
    let releaseNote: () => void = () => {};
    d.notify = async (a) => {
      order.push(`notify, ${detailReads().length} detail reads so far`);
      h.alerts.push(a);
      await new Promise<void>((r) => (releaseNote = r));
      return { ok: true };
    };
    const badge = d.setBadge;
    d.setBadge = async (n) => {
      order.push(`badge ${n}, ${detailReads().length} detail reads so far`);
      await badge(n);
    };
    setLabel(OPEN_NEW, true, h.clock);
    h.clock.t += 60_000;
    await h.c.syncNow();
    await settle();
    // the system has not answered the notification yet: nothing is read ahead meanwhile
    expect(order).toEqual(['notify, 0 detail reads so far']);
    expect(detailReads()).toEqual([]);
    releaseNote();
    await h.c.prefetchSettled();
    expect(order).toEqual(['notify, 0 detail reads so far', 'badge 1, 0 detail reads so far']);
    expect(readNumbers()).toEqual([OPEN_NEW]);
  });

  it('a later round while an earlier read is on its way: its items still wait for their own notification and badge (PR #331 review round 1)', async () => {
    const h = await signedIn({ sources: [PROJECT_URL] });
    await h.c.start();
    await h.c.prefetchSettled();
    const releaseDetail = fake.holdWhen((e) => e.operation === 'CavilItemDetail' && e.variables?.number === OPEN_NEW);
    let releaseNote: () => void = () => {};
    try {
      // round one: its read ahead is on its way, held by GitHub
      setLabel(OPEN_NEW, true, h.clock);
      h.clock.t += 60_000;
      await h.c.syncNow();
      await h.c.desktopSettled();
      await until(() => detailReads().length === 1, 'the first read ahead');
      expect(readNumbers()).toEqual([OPEN_NEW]);
      // round two: its notification is with the system, unanswered; its badge waits behind it
      const d = (h.c as any).deps.desktop as Desktop;
      d.notify = async (a) => {
        h.alerts.push(a);
        await new Promise<void>((r) => (releaseNote = r));
        return { ok: true };
      };
      setLabel(OPEN_NEW2, true, h.clock);
      h.clock.t += 60_000;
      await h.c.syncNow();
      await settle();
      expect(h.items()).toEqual([key(OPEN_NEW), key(OPEN_NEW2)]);
      const badgesBefore = h.badges.length;
      // round one's read ends: round two's is not sent, its badge is still not out
      releaseDetail();
      await until(() => detailReads()[0].status === 200, 'the first answer');
      for (let i = 0; i < 10; i++) await settle();
      expect(h.c.cachedDetail(key(OPEN_NEW))?.number).toBe(OPEN_NEW);
      expect(readNumbers()).toEqual([OPEN_NEW]);
      expect(h.badges).toHaveLength(badgesBefore);
      // the system answers: the badge goes out, and only then round two's read — which did happen
      const setBadge = d.setBadge;
      const readsAtBadge: number[] = [];
      d.setBadge = async (n) => {
        readsAtBadge.push(detailReads().length);
        await setBadge(n);
      };
      releaseNote();
      await h.c.prefetchSettled();
      expect(readsAtBadge).toEqual([1]);
      expect(h.badges).toHaveLength(badgesBefore + 1);
      expect(readNumbers()).toEqual([OPEN_NEW, OPEN_NEW2]);
      expect(h.c.cachedDetail(key(OPEN_NEW2))?.number).toBe(OPEN_NEW2);
    } finally {
      releaseDetail();
      releaseNote();
      await h.c.prefetchSettled();
    }
  });

  it('signed out while a queued read waits for a notification the system never answers: the next account still reads ahead', async () => {
    const h = await signedIn({ sources: [PROJECT_URL] });
    await h.c.start();
    await h.c.prefetchSettled();
    const d = (h.c as any).deps.desktop as Desktop;
    const notify = d.notify;
    d.notify = () => new Promise(() => {});
    setLabel(OPEN_NEW, true, h.clock);
    h.clock.t += 60_000;
    await h.c.syncNow();
    await settle();
    expect(detailReads()).toEqual([]);
    await h.c.logout();
    d.notify = notify;
    fake.state.nextGrant = { token: FAKE_TOKEN };
    h.c.setClientId(fake.state.oauthClientId);
    const login = h.c.startLogin();
    for (let i = 0; i < 500 && h.c.getState().login.status !== 'waiting'; i++) await new Promise((r) => setTimeout(r, 10));
    fake.resolveGrant('approved');
    await login;
    await h.c.prefetchSettled();
    // the first read of the new sign-in is history: still nothing read ahead
    expect(detailReads()).toEqual([]);
    setLabel(OPEN_NEW2, true, h.clock);
    await round(h);
    expect(h.c.getState().phase).toBe('ready');
    expect(readNumbers()).toEqual([OPEN_NEW2]);
    expect(h.c.cachedDetail(key(OPEN_NEW2))?.number).toBe(OPEN_NEW2);
  });

  it('a read ahead that fails shows nothing and breaks nothing; opening the item reads as before', async () => {
    const h = await signedIn({ sources: [PROJECT_URL] });
    await h.c.start();
    await h.c.prefetchSettled();
    fake.state.w.failDetail.add(key(OPEN_NEW));
    setLabel(OPEN_NEW, true, h.clock);
    setLabel(OPEN_NEW2, true, h.clock);
    await round(h);
    // "did happen": the request went out and failed; the one after it was still read
    expect(detailReads().some((e) => e.variables?.number === OPEN_NEW && e.status === 502)).toBe(true);
    expect(h.c.cachedDetail(key(OPEN_NEW))).toBeNull();
    expect(h.c.cachedDetail(key(OPEN_NEW2))?.number).toBe(OPEN_NEW2);
    expect(h.items().sort()).toEqual([key(OPEN_NEW), key(OPEN_NEW2)].sort());
    const st = h.c.getState();
    expect(st.sync.problem).toBeNull();
    expect(st.notifyProblem).toBeNull();
    expect(st.sync.offline).toBe(false);
    // the next round is an ordinary one, and nothing is tried again
    const before = detailReads().length;
    await round(h);
    expect(detailReads()).toHaveLength(before);
    expect(h.c.getState().sync.problem).toBeNull();
    fake.state.w.failDetail.clear();
    const r = await h.c.loadDetail(key(OPEN_NEW));
    expect(r.ok).toBe(true);
    expect(h.c.cachedDetail(key(OPEN_NEW))?.number).toBe(OPEN_NEW);
  });

  it('offline when the read ahead goes out: no detail, no message; the notification was sent', async () => {
    const h = await signedIn({ sources: [PROJECT_URL] });
    await h.c.start();
    await h.c.prefetchSettled();
    const d = (h.c as any).deps.desktop as Desktop;
    const notify = d.notify;
    // the connection goes right after the round, before the read ahead
    d.notify = async (a) => {
      fake.state.offline = true;
      return notify(a);
    };
    setLabel(OPEN_NEW, true, h.clock);
    const problem = h.c.getState().sync.problem;
    await round(h);
    expect(h.items()).toEqual([key(OPEN_NEW)]);
    expect(h.c.cachedDetail(key(OPEN_NEW))).toBeNull();
    expect(h.c.getState().sync.problem).toBe(problem);
    expect(h.c.getState().notifyProblem).toBeNull();
    fake.state.offline = false;
    expect((await h.c.loadDetail(key(OPEN_NEW))).ok).toBe(true);
  });

  it('signed out while a read ahead is on its way: its answer is not kept, the queued one is never sent', async () => {
    const h = await signedIn({ sources: [PROJECT_URL] });
    await h.c.start();
    await h.c.prefetchSettled();
    setLabel(OPEN_NEW, true, h.clock);
    setLabel(OPEN_NEW2, true, h.clock);
    const release = fake.holdWhen((e) => e.operation === 'CavilItemDetail');
    h.clock.t += 60_000;
    await h.c.syncNow();
    await until(() => detailReads().length === 1, 'the first read ahead');
    const first = readNumbers()[0];
    await h.c.logout();
    release();
    await until(() => detailReads()[0].status === 200, 'the held answer');
    await h.c.prefetchSettled();
    await settle();
    expect(detailReads()).toHaveLength(1);
    expect(h.c.cachedDetail(key(first))).toBeNull();
    expect(h.c.cachedDetail(key(OPEN_NEW))).toBeNull();
    expect(h.c.cachedDetail(key(OPEN_NEW2))).toBeNull();
    expect(h.c.getState().phase).toBe('login');
  });

  it('the item opened and read while its read ahead is on its way: the later read stays in the cache', async () => {
    const h = await signedIn({ sources: [PROJECT_URL] });
    await h.c.start();
    await h.c.prefetchSettled();
    setLabel(OPEN_NEW, true, h.clock);
    let first: unknown = null;
    const release = fake.holdWhen((e) => e.operation === 'CavilItemDetail' && (first ??= e) === e);
    h.clock.t += 60_000;
    await h.c.syncNow();
    await until(() => detailReads().length === 1, 'the read ahead');
    const queuedAt = h.clock.t;
    h.clock.t += 5_000;
    const mine = await h.c.loadDetail(key(OPEN_NEW));
    expect(mine.ok).toBe(true);
    expect(h.c.cachedDetail(key(OPEN_NEW))?.fetchedAt).toBe(queuedAt + 5_000);
    // the read ahead answers last, with a later clock: by start order it is still the older read
    h.clock.t += 5_000;
    release();
    await h.c.prefetchSettled();
    expect(detailReads()).toHaveLength(2);
    expect(detailReads().every((e) => e.status === 200)).toBe(true);
    expect(h.c.cachedDetail(key(OPEN_NEW))?.fetchedAt).toBe(queuedAt + 5_000);
  });

  for (const change of ['label', 'source'] as const) {
    it(`no longer pending when its turn comes (${change === 'label' ? 'label renamed' : 'source removed'} meanwhile): not read`, async () => {
      const from = 0;
      const h = await signedIn({ sources: [PROJECT_URL] });
      await h.c.start();
      await h.c.prefetchSettled();
      setLabel(OPEN_NEW, true, h.clock);
      setLabel(OPEN_NEW2, true, h.clock);
      const release = fake.holdWhen((e) => e.operation === 'CavilItemDetail');
      h.clock.t += 60_000;
      await h.c.syncNow();
      // "did happen": two were queued, the first is on its way
      await until(() => detailReads().length === from + 1, 'the first read ahead');
      expect(h.items()).toHaveLength(2);
      if (change === 'label') h.c.setHandBack({ human: 'some-other-label' });
      else h.c.removeSource(PROJECT_KEY);
      release();
      await h.c.prefetchSettled();
      await settle();
      expect(detailReads()).toHaveLength(from + 1);
    });
  }

  it('without a shell nothing is notified, so nothing is read ahead', async () => {
    const h = await signedIn({ sources: [PROJECT_URL] });
    (h.c as any).deps.desktop = undefined;
    await h.c.start();
    setLabel(OPEN_NEW, true, h.clock);
    await round(h);
    expect(labelledOnBoard(h, OPEN_NEW)).toBe(true);
    expect(detailReads()).toEqual([]);
  });
});
