// "待处理" reminders (GigleAI/cavil-loop#139): notifications, Dock badge and the
// start-up summary. Two layers:
//   - the controller against the fake GitHub over real HTTP (real sync rounds,
//     real pagination failures, real SQLite), labels changed on the fake
//     between rounds the way a maintainer changes them on GitHub;
//   - the tracker alone for the orderings that are awkward to stage over HTTP.
// Recorded data (test/fixtures, re-recorded by record.mjs — never hand-edited):
// the expected numbers below are derived from it, not typed in. On top of the
// recording every test puts the label on one open item that both sources carry
// (SEEDED), so there is always an open pending item and a cross-source one,
// whatever the board looked like on recording day.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { Controller } from '../../src/main/controller';
import { Cache } from '../../src/data/cache';
import { FileStore } from '../../src/platform/credentials';
import type { Alert } from '../../src/platform/alerts';
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

// ---- what the recording holds (read straight from the JSON, independent of the client code) ----
const rawPages = loadCavilProjectPages();
const rawRepo = loadCavilRepoIssues();
const rawProject = rawPages.flatMap((pg) => pg.items.nodes).filter((n: any) => !n.isArchived && n.content?.number != null && n.content.repository);
const projHas = (n: number) => rawProject.some((x: any) => x.content.number === n && x.content.repository.nameWithOwner === REPO);
const projPending = (x: any) => x.content.labels.nodes.some((l: any) => l.name === LABEL);
const repoOpen = (n: number) => rawRepo.some((i: any) => i.number === n && i.state === 'open');
const repoPending = (i: any) => i.labels.some((l: any) => (l.name ?? l) === LABEL);
/** open, in both sources, not pending in either: gets the label before every test */
const SEEDED = rawRepo.find((i: any) => i.state === 'open' && !i.pull_request && !repoPending(i) && projHas(i.number) && !rawProject.some((x: any) => x.content.number === i.number && projPending(x)))!.number as number;
/** another such item, used for "an open item gets the label" */
const OPEN_NEW = rawRepo.find((i: any) => i.number !== SEEDED && i.state === 'open' && !i.pull_request && !repoPending(i) && projHas(i.number) && !rawProject.some((x: any) => x.content.number === i.number && projPending(x)))!.number as number;
/** a closed issue / merged PR only the Project carries, without the label */
const pickProj = (pred: (c: any) => boolean) => rawProject.find((x: any) => pred(x.content) && !projPending(x) && !rawRepo.some((i: any) => i.number === x.content.number))!.content.number as number;
const CLOSED_ISSUE = pickProj((c) => c.__typename === 'Issue' && c.state === 'CLOSED');
const MERGED_PR = pickProj((c) => c.__typename === 'PullRequest' && c.merged);
/** pending in the Project after seeding, and how many of those are closed / merged */
const P = rawProject.filter(projPending).length + 1;
const P_CLOSED = rawProject.filter((x: any) => projPending(x) && x.content.state !== 'OPEN').length;
/** pending in the repository source after seeding (it reads open items + the last 14 days) */
const R = rawRepo.filter(repoPending).length + 1;
/** items the Project brings that the repository source does not already count */
const P_ONLY = P - rawProject.filter((x: any) => projPending(x) && rawRepo.some((i: any) => i.number === x.content.number && repoPending(i))).length - 1;

beforeEach(async () => {
  fake = await startFakeGitHub();
  dir = tempDir();
  setLabel(SEEDED, true, { t: FIXTURE_NOW - 3_600_000 });
});

it('the recording still has what these tests need', () => {
  expect(repoOpen(SEEDED) && repoOpen(OPEN_NEW)).toBe(true);
  expect(P_CLOSED).toBeGreaterThan(0); // closed / merged pending items: the case "only open ones" would miss
  expect([CLOSED_ISSUE, MERGED_PR].every(Number.isInteger)).toBe(true);
  expect(P).toBeGreaterThan(R);
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
    expect(h.summaries()[0]).toMatchObject({ title: `${P} 条待处理` });
    expect(h.summaries()[0].body).toContain(`其中 ${P_CLOSED} 条已关闭 / 已合并`);
    expect(h.badge()).toBe(P);
    expect(h.c.getState().pendingCount).toBe(P);
    // a quiet round changes nothing
    await tick(h);
    expect(h.alerts).toHaveLength(1);
    expect(h.badge()).toBe(P);
  });

  it('from nothing to pending: notified exactly once — open issue, closed issue and merged PR alike', async () => {
    const h = await signedIn({ sources: [PROJECT_URL] });
    await h.c.start();
    expect(h.alerts).toHaveLength(1); // the start-up summary
    setLabel(OPEN_NEW, true, h.clock); // open issue
    setLabel(CLOSED_ISSUE, true, h.clock); // closed issue
    setLabel(MERGED_PR, true, h.clock); // merged PR
    await tick(h);
    expect(h.items().sort()).toEqual([key(OPEN_NEW), key(CLOSED_ISSUE), key(MERGED_PR)].sort());
    const byKey = new Map(h.alerts.filter((a) => a.kind === 'item').map((a) => [(a as { key: string }).key, a]));
    expect(byKey.get(key(CLOSED_ISSUE))!.title).toContain('已关闭');
    expect(byKey.get(key(MERGED_PR))!.title).toContain('已合并');
    expect((byKey.get(key(MERGED_PR)) as { url: string }).url).toContain(`/pull/${MERGED_PR}`);
    expect(h.badge()).toBe(P + 3);
    // still pending next round: no second notification
    await tick(h);
    await tick(h);
    expect(h.items()).toHaveLength(3);
    expect(h.summaries()).toHaveLength(1);
  });

  it('label removed and put back → notified again; the removal itself is silent', async () => {
    const h = await signedIn({ sources: [PROJECT_URL] });
    await h.c.start();
    setLabel(SEEDED, false, h.clock);
    await tick(h);
    expect(h.items()).toEqual([]);
    expect(h.badge()).toBe(P - 1);
    setLabel(SEEDED, true, h.clock);
    await tick(h);
    expect(h.items()).toEqual([key(SEEDED)]);
    expect(h.badge()).toBe(P);
  });

  it('an item carried by two sources is notified once, counted once', async () => {
    const h = await signedIn({ sources: [PROJECT_URL, REPO] });
    await h.c.start();
    // a merged PR known to the repo list too (recently updated), and an open issue in both
    addToRepoList(MERGED_PR, 'closed', true, h.clock);
    setLabel(MERGED_PR, true, h.clock);
    setLabel(OPEN_NEW, true, h.clock);
    await tick(h);
    // "did happen": both sources were read this round and both carry the items
    const st = h.c.getState().sync.sources;
    expect(st.every((s) => s.ok)).toBe(true);
    const data = h.c.getBoardData().items.find((i) => i.key === key(MERGED_PR))!;
    expect(data.sources.sort()).toEqual([PROJECT_KEY, REPO_KEY].sort());
    expect(h.items().sort()).toEqual([key(OPEN_NEW), key(MERGED_PR)].sort());
    expect(h.badge()).toBe(P + 2);
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
    setLabel(CLOSED_ISSUE, true, h.clock);
    await tick(h);
    expect(h.c.getState().sync.sources[0]).toMatchObject({ ok: false });
    expect(h.items()).toEqual([]);
    expect(h.badge()).toBe(P);
    // still failing: still nothing
    await tick(h);
    expect(h.items()).toEqual([]);
    // recovers: the real change shows — the newly labelled one is new, the removed one just drops out
    fake.state.failProjectPage.delete('org/gigleai/11');
    await tick(h);
    expect(h.items()).toEqual([key(CLOSED_ISSUE)]);
    expect(h.badge()).toBe(P);
    expect(h.summaries()).toHaveLength(1);
  });

  it('offline rounds and back: the same items are not notified again', async () => {
    const h = await signedIn({ sources: [PROJECT_URL, REPO] });
    await h.c.start();
    fake.state.offline = true;
    await tick(h);
    await tick(h);
    expect(h.c.getState().sync.offline).toBe(true);
    expect(h.badge()).toBe(P);
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
    expect(h.badge()).toBe(P);
  });

  it('a newly added source: what it brings is summarised once, not notified one by one', async () => {
    const h = await signedIn({ sources: [REPO] });
    await h.c.start();
    expect(h.summaries()).toHaveLength(1);
    expect(h.summaries()[0].title).toBe(`${R} 条待处理`);
    expect(h.badge()).toBe(R);
    h.c.addSource(PROJECT_URL);
    await h.c.syncNow();
    expect(h.items()).toEqual([]);
    expect(h.summaries()).toHaveLength(2);
    expect(h.summaries()[1]).toMatchObject({ title: `${P} 条待处理` });
    expect(h.summaries()[1].body).toContain(`新加的来源带来 ${P_ONLY} 条`);
    expect(h.badge()).toBe(P);
    // and from then on it is a normal source
    setLabel(CLOSED_ISSUE, true, h.clock);
    await tick(h);
    expect(h.items()).toEqual([key(CLOSED_ISSUE)]);
  });

  it('a new label during the round that adds a source is still a notification when another source already had a baseline', async () => {
    const h = await signedIn({ sources: [REPO] });
    await h.c.start();
    setLabel(OPEN_NEW, true, h.clock); // in both sources
    h.c.addSource(PROJECT_URL);
    await h.c.syncNow();
    expect(h.items()).toEqual([key(OPEN_NEW)]);
    expect(h.summaries()[1].body).toContain(`新加的来源带来 ${P_ONLY} 条`);
    expect(h.badge()).toBe(P + 1);
  });

  it('removing a source drops what only it carried, silently', async () => {
    const h = await signedIn({ sources: [PROJECT_URL, REPO] });
    await h.c.start();
    h.c.removeSource(PROJECT_KEY);
    expect(h.badge()).toBe(R);
    expect(h.c.getState().pendingCount).toBe(R);
    await tick(h);
    expect(h.items()).toEqual([]);
    expect(h.summaries()).toHaveLength(1);
  });

  it('another label name: recounted silently; label match ignores case like GitHub; one setting with "hand back to agent"', async () => {
    const h = await signedIn({ sources: [PROJECT_URL] });
    await h.c.start();
    // the reminder label IS the "waiting for a human" label that hand-back removes
    h.c.setHandBack({ human: '  DONE ' });
    expect(h.c.getState().handBack.human).toBe('DONE');
    expect(h.badge()).toBeGreaterThan(50);
    expect(h.badge()).toBe(h.c.getState().pendingCount);
    expect(h.alerts).toHaveLength(1);
    await tick(h);
    expect(h.alerts).toHaveLength(1);
    // changing only the other label does not touch the count
    const before = h.badges.length;
    h.c.setHandBack({ agent: 'ready/agent' });
    expect(h.badges.length).toBe(before);
    // empty = back to the default
    h.c.setHandBack({ human: '' });
    expect(h.c.getState().handBack.human).toBe(LABEL);
    expect(h.badge()).toBe(P);
  });

  it('a configured label name survives a restart and is the one used', async () => {
    const h = await signedIn({ sources: [PROJECT_URL], seed: { handBack: { human: 'Done', agent: 'pending/agent' } } });
    await h.c.start();
    expect(h.c.getState().handBack.human).toBe('Done');
    expect(h.summaries()[0].title).not.toBe(`${P} 条待处理`);
    expect(h.badge()).toBe(h.c.getState().pendingCount);
    expect(h.badge()).toBeGreaterThan(50);
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
    expect(h.badge()).toBe(P);
    // the user allows notifications; the next one goes out and the warning goes away
    delivery.refuse = null;
    setLabel(CLOSED_ISSUE, true, h.clock);
    await tick(h);
    expect(h.items()).toEqual([key(CLOSED_ISSUE)]);
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
