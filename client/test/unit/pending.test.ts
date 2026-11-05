// "待处理" reminders (GigleAI/cavil-loop#139): notifications, Dock badge and the
// start-up summary. Two layers:
//   - the controller against the fake GitHub over real HTTP (real sync rounds,
//     real pagination failures, real SQLite), labels changed on the fake
//     between rounds the way a maintainer changes them on GitHub;
//   - the tracker alone for the orderings that are awkward to stage over HTTP.
// Recorded data: `cavil project` (#11) has 11 items with pending/human, 8 of
// them closed / merged; the repository source carries 3 of them (open ones).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { Controller } from '../../src/main/controller';
import { Cache } from '../../src/data/cache';
import { FileStore } from '../../src/platform/credentials';
import type { Alert } from '../../src/platform/alerts';
import { PendingTracker } from '../../src/data/pending';
import { startFakeGitHub, FakeGitHub } from '../fake-github/server';
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

interface Harness {
  c: Controller;
  alerts: Alert[];
  badges: number[];
  clock: { t: number };
  /** notifications about single items, as `repo#N` */
  items(): string[];
  summaries(): Alert[];
  badge(): number | undefined;
}

async function signedIn(opts: { sources?: string[]; seed?: Record<string, unknown>; clock?: { t: number }; credentials?: FileStore; delivery?: { refuse: string | null } } = {}): Promise<Harness> {
  const cache = new Cache(join(dir, 'cache.sqlite'));
  caches.push(cache);
  cache.setSetting('trustedCredentials', trustedList(FAKE_TOKEN));
  for (const [k, v] of Object.entries(opts.seed ?? {})) cache.setSetting(k, v);
  const credentials = opts.credentials ?? new FileStore(join(dir, 'cred'));
  await credentials.set(FAKE_TOKEN);
  const clock = opts.clock ?? { t: FIXTURE_NOW };
  const alerts: Alert[] = [];
  const badges: number[] = [];
  const c = new Controller({
    credentials,
    endpoints: { api: fake.api, web: fake.web },
    cache,
    now: () => clock.t,
    sleep: async () => {},
    openExternal: async () => {},
    defaultClientId: '',
    alerts: {
      notify: (a, done) => {
        alerts.push(a);
        const refuse = opts.delivery?.refuse;
        done?.(refuse ? { ok: false, error: refuse } : { ok: true });
      },
      setBadge: (n) => void badges.push(n),
    },
  });
  controllers.push(c);
  for (const s of opts.sources ?? []) c.addSource(s);
  return {
    c,
    alerts,
    badges,
    clock,
    items: () => alerts.filter((a) => a.kind === 'item').map((a) => (a as Extract<Alert, { kind: 'item' }>).key),
    summaries: () => alerts.filter((a) => a.kind === 'summary'),
    badge: () => badges[badges.length - 1],
  };
}

/** Next round, one minute later. */
async function tick(h: Harness) {
  h.clock.t += 60_000;
  await h.c.syncNow();
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

/** A closed issue / merged PR the recorded data has only in the Project (closed months ago). */
function addToRepoList(number: number, state: 'closed', pr: boolean, clock: { t: number }) {
  const list = fake.state.repos.get('gigleai/cavil-loop')!;
  if (list.some((i) => i.number === number)) return;
  list.push({
    number,
    title: `t${number}`,
    state,
    html_url: `https://github.com/${REPO}/${pr ? 'pull' : 'issues'}/${number}`,
    updated_at: new Date(clock.t).toISOString(),
    labels: [],
    assignees: [],
    milestone: null,
    ...(pr ? { pull_request: { merged_at: new Date(clock.t).toISOString() } } : {}),
  });
}

const key = (n: number) => `gigleai/cavil-loop#${n}`;

beforeEach(async () => {
  fake = await startFakeGitHub();
  dir = tempDir();
});
afterEach(async () => {
  for (const c of controllers) c.stopTimer();
  for (const c of caches) c.close();
  caches = [];
  controllers = [];
  await fake.close();
});

describe('pending reminders against the fake GitHub', () => {
  it('start: what is already pending becomes one summary (closed / merged counted), never one notification each; badge = summary = count', async () => {
    const h = await signedIn({ sources: [PROJECT_URL, REPO] });
    await h.c.start();
    expect(h.items()).toEqual([]);
    expect(h.summaries()).toHaveLength(1);
    expect(h.summaries()[0]).toMatchObject({ title: '11 条待处理' });
    expect(h.summaries()[0].body).toContain('其中 8 条已关闭 / 已合并');
    expect(h.badge()).toBe(11);
    expect(h.c.getState().pendingCount).toBe(11);
    // a quiet round changes nothing
    await tick(h);
    expect(h.alerts).toHaveLength(1);
    expect(h.badge()).toBe(11);
  });

  it('from nothing to pending: notified exactly once — open issue, closed issue and merged PR alike', async () => {
    const h = await signedIn({ sources: [PROJECT_URL] });
    await h.c.start();
    expect(h.alerts).toHaveLength(1); // the start-up summary
    setLabel(136, true, h.clock); // open issue
    setLabel(22, true, h.clock); // closed issue
    setLabel(23, true, h.clock); // merged PR
    await tick(h);
    expect(h.items().sort()).toEqual([key(136), key(22), key(23)].sort());
    const byKey = new Map(h.alerts.filter((a) => a.kind === 'item').map((a) => [(a as { key: string }).key, a]));
    expect(byKey.get(key(22))!.title).toContain('已关闭');
    expect(byKey.get(key(23))!.title).toContain('已合并');
    expect((byKey.get(key(23)) as { url: string }).url).toContain('/pull/23');
    expect(h.badge()).toBe(14);
    // still pending next round: no second notification
    await tick(h);
    await tick(h);
    expect(h.items()).toHaveLength(3);
    expect(h.summaries()).toHaveLength(1);
  });

  it('label removed and put back → notified again; the removal itself is silent', async () => {
    const h = await signedIn({ sources: [PROJECT_URL] });
    await h.c.start();
    setLabel(137, false, h.clock);
    await tick(h);
    expect(h.items()).toEqual([]);
    expect(h.badge()).toBe(10);
    setLabel(137, true, h.clock);
    await tick(h);
    expect(h.items()).toEqual([key(137)]);
    expect(h.badge()).toBe(11);
  });

  it('an item carried by two sources is notified once, counted once', async () => {
    const h = await signedIn({ sources: [PROJECT_URL, REPO] });
    await h.c.start();
    // a merged PR known to the repo list too (recently updated), and an open issue in both
    addToRepoList(23, 'closed', true, h.clock);
    setLabel(23, true, h.clock);
    setLabel(136, true, h.clock);
    await tick(h);
    // "did happen": both sources were read this round and both carry the items
    const st = h.c.getState().sync.sources;
    expect(st.every((s) => s.ok)).toBe(true);
    const data = h.c.getBoardData().items.find((i) => i.key === key(23))!;
    expect(data.sources.sort()).toEqual([PROJECT_KEY, REPO_KEY].sort());
    expect(h.items().sort()).toEqual([key(136), key(23)].sort());
    expect(h.badge()).toBe(13);
  });

  it('a source that fails mid-pagination: neither new nor removed that round; the real change is notified after it recovers', async () => {
    const h = await signedIn({ sources: [PROJECT_URL] });
    await h.c.start();
    const pages = fake.state.projects.get('org/gigleai/11')!;
    const onPage2 = pages[1].items.nodes.find((n: any) => n.content?.labels?.nodes.some((l: any) => l.name === LABEL));
    const onPage1 = pages[0].items.nodes.find((n: any) => n.content?.labels?.nodes.some((l: any) => l.name === LABEL));
    expect(onPage1 && onPage2).toBeTruthy();
    // page 2 fails; meanwhile one label went away (page 1) and one came (page 1)
    fake.state.failProjectPage.set('org/gigleai/11', 1);
    setLabel(onPage1.content.number, false, h.clock);
    setLabel(22, true, h.clock);
    await tick(h);
    expect(h.c.getState().sync.sources[0]).toMatchObject({ ok: false });
    expect(h.items()).toEqual([]);
    expect(h.badge()).toBe(11);
    // still failing: still nothing
    await tick(h);
    expect(h.items()).toEqual([]);
    // recovers: the real change shows — #22 is new, the removed one just drops out
    fake.state.failProjectPage.delete('org/gigleai/11');
    await tick(h);
    expect(h.items()).toEqual([key(22)]);
    expect(h.badge()).toBe(11);
    expect(h.summaries()).toHaveLength(1);
  });

  it('offline rounds and back: the same items are not notified again', async () => {
    const h = await signedIn({ sources: [PROJECT_URL, REPO] });
    await h.c.start();
    fake.state.offline = true;
    await tick(h);
    await tick(h);
    expect(h.c.getState().sync.offline).toBe(true);
    expect(h.badge()).toBe(11);
    fake.state.offline = false;
    await tick(h);
    expect(h.c.getState().sync.offline).toBe(false);
    expect(h.items()).toEqual([]);
    expect(h.summaries()).toHaveLength(1);
  });

  it('start offline: no summary, no badge until the first complete read; then exactly one summary', async () => {
    const first = await signedIn({ sources: [PROJECT_URL] });
    await first.c.start();
    first.c.stopTimer();
    fake.state.offline = true;
    const h = await signedIn({ clock: first.clock, credentials: new FileStore(join(dir, 'cred')) });
    await h.c.start();
    expect(h.c.getBoardData().items.length).toBeGreaterThan(0); // the cache shows
    expect(h.alerts).toEqual([]);
    fake.state.offline = false;
    await tick(h);
    expect(h.items()).toEqual([]);
    expect(h.summaries()).toHaveLength(1);
    expect(h.badge()).toBe(11);
  });

  it('a newly added source: what it brings is summarised once, not notified one by one', async () => {
    const h = await signedIn({ sources: [REPO] });
    await h.c.start();
    expect(h.summaries()).toHaveLength(1);
    expect(h.summaries()[0].title).toBe('3 条待处理');
    expect(h.badge()).toBe(3);
    h.c.addSource(PROJECT_URL);
    await h.c.syncNow();
    expect(h.items()).toEqual([]);
    expect(h.summaries()).toHaveLength(2);
    expect(h.summaries()[1]).toMatchObject({ title: '11 条待处理' });
    expect(h.summaries()[1].body).toContain('新加的来源带来 8 条');
    expect(h.badge()).toBe(11);
    // and from then on it is a normal source
    setLabel(22, true, h.clock);
    await tick(h);
    expect(h.items()).toEqual([key(22)]);
  });

  it('a new label during the round that adds a source is still a notification when another source already had a baseline', async () => {
    const h = await signedIn({ sources: [REPO] });
    await h.c.start();
    setLabel(136, true, h.clock); // in both sources
    h.c.addSource(PROJECT_URL);
    await h.c.syncNow();
    expect(h.items()).toEqual([key(136)]);
    expect(h.summaries()[1].body).toContain('新加的来源带来 8 条');
    expect(h.badge()).toBe(12);
  });

  it('removing a source drops what only it carried, silently', async () => {
    const h = await signedIn({ sources: [PROJECT_URL, REPO] });
    await h.c.start();
    h.c.removeSource(PROJECT_KEY);
    expect(h.badge()).toBe(3);
    expect(h.c.getState().pendingCount).toBe(3);
    await tick(h);
    expect(h.items()).toEqual([]);
    expect(h.summaries()).toHaveLength(1);
  });

  it('another label name: recounted silently; label match ignores case like GitHub', async () => {
    const h = await signedIn({ sources: [PROJECT_URL] });
    await h.c.start();
    h.c.setPendingLabel('  DONE ');
    expect(h.c.getState().pendingLabel).toBe('DONE');
    expect(h.badge()).toBeGreaterThan(50);
    expect(h.badge()).toBe(h.c.getState().pendingCount);
    expect(h.alerts).toHaveLength(1);
    await tick(h);
    expect(h.alerts).toHaveLength(1);
    // empty = back to the default, and it survives a restart
    h.c.setPendingLabel('');
    expect(h.c.getState().pendingLabel).toBe(LABEL);
    expect(h.badge()).toBe(11);
  });

  it('a configured label name survives a restart and is the one used', async () => {
    const h = await signedIn({ sources: [PROJECT_URL], seed: { pendingLabel: 'Done' } });
    await h.c.start();
    expect(h.c.getState().pendingLabel).toBe('Done');
    expect(h.summaries()[0].title).not.toBe('11 条待处理');
  });

  it('sign out clears the badge and the count', async () => {
    const h = await signedIn({ sources: [PROJECT_URL] });
    await h.c.start();
    await h.c.logout();
    expect(h.badge()).toBe(0);
    expect(h.c.getState().pendingCount).toBe(0);
  });
});

describe('a notification the system refuses', () => {
  it('is shown in the app (not silently lost) and cleared once one goes out again; the badge is unaffected', async () => {
    const delivery = { refuse: 'Notifications are not allowed for this application' as string | null };
    const h = await signedIn({ sources: [PROJECT_URL], delivery });
    await h.c.start();
    // "did happen": the summary was sent and refused
    expect(h.summaries()).toHaveLength(1);
    expect(h.c.getState().notifyProblem).toBe('Notifications are not allowed for this application');
    expect(h.badge()).toBe(11);
    // the user allows notifications; the next one goes out and the warning goes away
    delivery.refuse = null;
    setLabel(22, true, h.clock);
    await tick(h);
    expect(h.items()).toEqual([key(22)]);
    expect(h.c.getState().notifyProblem).toBeNull();
  });
});

describe('the tracker on its own', () => {
  const snap = (sourceKey: string, ...items: ReturnType<typeof item>[]): SourceSnapshot => ({ sourceKey, fetchedAt: 0, items });
  const pend = (n: number, extra = {}) => item('o/r', n, { labels: [{ name: LABEL, color: '' }], ...extra });

  it('a closed item counts the same as an open one', () => {
    const t = new PendingTracker(LABEL);
    t.observe([snap('a')], ['a']);
    const ch = t.observe([snap('a', pend(1, { state: 'closed' }), pend(2, { state: 'merged', kind: 'pr' }))], ['a']);
    expect(ch.appeared.map((i) => i.number).sort()).toEqual([1, 2]);
    expect(t.count()).toBe(2);
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

  it('no summary when the first read brings nothing', () => {
    const t = new PendingTracker(LABEL);
    expect(t.observe([snap('a')], ['a']).summary).toBeNull();
    expect(t.observe([snap('b', pend(1))], ['a', 'b']).summary).toMatchObject({ total: 1, fromNewSources: 1, atStart: false });
  });
});
