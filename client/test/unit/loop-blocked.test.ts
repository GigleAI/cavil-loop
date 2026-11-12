// GigleAI/cavil-loop#429: the graph also draws the loop's own prerequisite registrations (the hidden
// `<!-- agent-blocked-by: … -->` comment the daemon waits by). Which comment counts runs the same cases
// as the daemon's own function (tests/fixtures/blocked-marks.json, tests/blocked-mark-parse.test.sh);
// the rest runs the real readers against the fake GitHub, in the shape of the case that started it
// (luosky/arkknights-tool: #56 waits for #55, #57 for #56, #58 for #57 — only in comments).

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { GitHubClient } from '../../src/data/github';
import { fetchRepo, fetchSource } from '../../src/data/fetchSources';
import { applyFreshItem, fetchItem } from '../../src/data/itemRefresh';
import { syncRound } from '../../src/data/sync';
import { pickLoopMark, loopKnown } from '../../src/data/loopBlocked';
import { buildGraph } from '../../src/data/graph';
import { parseSource } from '../../src/shared/sources';
import type { SourceConfig, SourceSnapshot } from '../../src/shared/types';
import { startFakeGitHub, type FakeGitHub } from '../fake-github/server';
import { FAKE_TOKEN } from './helpers';

const here = dirname(fileURLToPath(import.meta.url));
const FIX = JSON.parse(readFileSync(join(here, '../../../tests/fixtures/blocked-marks.json'), 'utf8'));

describe('which registration counts: the same cases and answers as the daemon', () => {
  it('has the shared cases (not an empty file agreeing with an empty file)', () => {
    expect(FIX.cases.length).toBeGreaterThanOrEqual(10);
    expect(FIX.cases.filter((c: any) => c.want.length > 0).length).toBeGreaterThanOrEqual(5);
  });
  for (const c of FIX.cases) {
    it(c.name, () => {
      const comments = c.comments.map((x: any) => ({ id: x.id, body: x.body, createdAt: x.created_at, authorAssociation: x.author_association }));
      const want = (c.clientWant ?? c.want).map((e: any) => ({ r: e.r, n: e.n }));
      const sort = (l: { r: string; n: number }[]) => [...l].sort((a, b) => (a.r < b.r ? -1 : a.r > b.r ? 1 : a.n - b.n));
      expect(sort(pickLoopMark(comments, c.since, FIX.self))).toEqual(sort(want));
    });
  }
});

// ---- the readers ----

const REPO = 'luosky/arkknights-tool';
const OTHER = 'luosky/arkknights-data';
const KEY = REPO.toLowerCase();
const K = (n: number, repo = KEY) => `${repo}#${n}`;
const NOW = Date.parse('2026-11-12T12:00:00Z');
const BLOCKED = 'pending/blocked';
const MARK = (ends: string) => `## 等前置\n\n<!-- agent-blocked-by: ${ends} resume=pending/agent -->`;

function issue(n: number, labels: string[], extra: Record<string, unknown> = {}) {
  return {
    number: n,
    node_id: `I_tool_${n}`,
    title: `issue ${n}`,
    state: 'open',
    html_url: `https://github.com/${REPO}/issues/${n}`,
    updated_at: '2026-11-12T05:35:00Z',
    labels: labels.map((name) => ({ name, color: 'ededed' })),
    assignees: [],
    milestone: null,
    user: { login: 'luosky' },
    parent_issue_url: null,
    sub_issues_summary: { total: 0, completed: 0, percent_completed: 0 },
    issue_dependencies_summary: { blocked_by: 0, total_blocked_by: 0, blocking: 0, total_blocking: 0 },
    ...extra,
  };
}
function pr(n: number, state: 'open' | 'closed', merged: boolean) {
  // a closed one last touched long ago: outside the repository source (open + the last 14 days)
  return { ...issue(n, []), node_id: `PR_tool_${n}`, state, ...(state === 'closed' ? { updated_at: '2026-01-01T00:00:00Z' } : {}), pull_request: { merged_at: merged ? '2026-11-11T00:00:00Z' : null }, draft: false };
}
let seq = 0;
function comment(fake: FakeGitHub, n: number, body: string, createdAt: string, authorAssociation = 'MEMBER', repo = KEY) {
  const key = `${repo}#${n}`;
  const list = fake.state.w.comments.get(key) ?? [];
  list.push({ id: `IC_${++seq}`, url: `https://github.com/${repo}/issues/${n}#c${seq}`, createdAt, bodyHTML: body, body, author: { login: 'luosky-bot-pusher' }, authorAssociation });
  fake.state.w.comments.set(key, list);
}
function unlabeled(fake: FakeGitHub, n: number, at: string, label = BLOCKED) {
  const key = `${KEY}#${n}`;
  const list = fake.state.w.labelEvents.get(key) ?? [];
  list.push({ id: list.length + 1, event: 'unlabeled', label: { name: label }, actor: { login: 'luosky-bot-pusher' }, created_at: at });
  fake.state.w.labelEvents.set(key, list);
}

let fake: FakeGitHub;
afterEach(async () => {
  await fake?.close();
});
async function start(issues: any[], others: any[] = []) {
  fake = await startFakeGitHub({ repos: new Map([[KEY, issues], ...(others.length ? [[OTHER.toLowerCase(), others] as [string, any[]]] : [])]) });
  return fake;
}
const client = () => new GitHubClient({ api: fake.api, web: fake.web }, FAKE_TOKEN);
const src = () => parseSource(REPO) as Extract<SourceConfig, { kind: 'repo' }>;
const read = (label = BLOCKED) => fetchRepo(client(), src(), NOW, undefined, label);
const ops = () => fake.log.map((e) => e.operation).filter(Boolean);

/** the arkknights-tool shape: #55 open (no label), #56–#58 wait in a chain, registered only in comments */
async function chain() {
  await start([issue(55, ['pending/PR']), issue(56, [BLOCKED]), issue(57, [BLOCKED]), issue(58, [BLOCKED])]);
  comment(fake, 56, MARK('#55'), '2026-11-12T05:34:59Z');
  comment(fake, 57, MARK('#56'), '2026-11-12T05:35:01Z');
  comment(fake, 58, MARK('#57'), '2026-11-12T05:35:04Z');
}

describe('the chain that started #429', () => {
  it('draws the three arrows and the badges, from comments alone (GitHub "Blocked by" empty)', async () => {
    await chain();
    const snap = await read();
    const g = buildGraph(snap.items, snap.items, BLOCKED);
    expect(g.edges).toEqual([
      { from: K(55), to: K(56), open: true },
      { from: K(56), to: K(57), open: true },
      { from: K(57), to: K(58), open: true },
    ]);
    expect(g.nodes.get(K(55))!.blockingAhead).toBe(3);
    for (const n of [56, 57, 58]) expect(g.nodes.get(K(n))!.blockedByOpen).toBe(1);
    expect(g.unknown).toBe(0);
    // #55 has no relation of its own, but it is drawn: shown, not "hidden, no relations"
    expect(g.entries).toBe(4);
    expect(g.noRelation).toBe(0);
    // the ends in the source were taken from the read itself: no request per prerequisite
    expect(ops().filter((o) => o === 'CavilLoopEnd')).toHaveLength(0);
    expect(ops().filter((o) => o === 'CavilLoopBlocked')).toHaveLength(1);
  });

  it('the same items with the setting off: GitHub relations only — no arrows, no extra request', async () => {
    await chain();
    const snap = await read('');
    expect(ops()).not.toContain('CavilLoopBlocked');
    expect(snap.items.every((i) => i.loopBlocked === undefined)).toBe(true);
    const g = buildGraph(snap.items, snap.items, '');
    expect(g.edges).toHaveLength(0);
  });

  it('read under one label, drawn under another: unknown (never "waits for nothing"), and the next sync reads again', async () => {
    await chain();
    const snap = await read();
    const g = buildGraph(snap.items, snap.items, 'waiting');
    expect(g.edges).toHaveLength(0);
    expect(g.unknown).toBe(0); // nothing carries "waiting": nothing to read under it
    const old = snap.items.map((i) => (i.loopBlocked ? { ...i, loopBlocked: { ...i.loopBlocked, label: 'old' } } : i));
    const other = buildGraph(old, old, BLOCKED);
    expect(other.edges).toHaveLength(0);
    expect(other.unknown).toBe(3);
    expect(loopKnown(snap.items, BLOCKED)).toBe(true);
    expect(loopKnown(snap.items, 'waiting')).toBe(false);
    // a cached snapshot from before #429 (no loopBlocked at all): the open waiting issues are unknown
    const pre = snap.items.map(({ loopBlocked: _l, ...rest }) => rest);
    expect(buildGraph(pre as any, pre as any, BLOCKED).unknown).toBe(3);
  });

  it('a sync round under a new label reads in full even when the change check says "unchanged"', async () => {
    await chain();
    const first = await syncRound(client(), [src()], new Map(), NOW, new Map(), 3_600_000, () => {}, BLOCKED);
    const prev = new Map<string, SourceSnapshot>(first.snapshots);
    // same label: the check may keep the snapshot
    fake.log.length = 0;
    const again = await syncRound(client(), [src()], prev, NOW + 1000, first.checks, 3_600_000, () => {}, BLOCKED);
    expect(again.unchanged).toEqual([src().key]);
    // another label: the kept snapshot was read under the old one — a full read, under the new one
    fake.log.length = 0;
    const relabelled = await syncRound(client(), [src()], prev, NOW + 2000, first.checks, 3_600_000, () => {}, 'waiting');
    expect(relabelled.unchanged).toEqual([]);
    expect(relabelled.replaced[0].items.find((i) => i.number === 56)!.loopBlocked).toEqual({ label: 'waiting', ends: [] });
  });
});

describe('merging with GitHub relations, and what a registration may name', () => {
  it('a registration and a GitHub "Blocked by" naming the same pair: one arrow', async () => {
    await start([issue(55, []), issue(56, [BLOCKED], { issue_dependencies_summary: { blocked_by: 1, total_blocked_by: 1, blocking: 0, total_blocking: 0 } })]);
    fake.state.w.relations.set(`${KEY}#56`, {
      parent: null,
      subIssues: [],
      blockedBy: [{ number: 55, title: 'issue 55', url: `https://github.com/${REPO}/issues/55`, state: 'OPEN', stateReason: null, repository: { nameWithOwner: REPO } }],
      blocking: [],
    } as any);
    comment(fake, 56, MARK('#55'), '2026-11-12T05:34:59Z');
    const snap = await read();
    const it56 = snap.items.find((i) => i.number === 56)!;
    expect(it56.relations!.blockedBy.map((b) => b.key)).toEqual([K(55)]);
    expect(it56.loopBlocked!.ends.map((b) => b.key)).toEqual([K(55)]);
    const g = buildGraph(snap.items, snap.items, BLOCKED);
    expect(g.edges).toEqual([{ from: K(55), to: K(56), open: true }]);
  });

  it('a pull request, another repository, an end outside the sources, and one this account cannot see', async () => {
    await start([issue(56, [BLOCKED]), pr(60, 'closed', true), pr(61, 'open', false), pr(62, 'open', false)], [{ ...issue(45, []), node_id: 'I_data_45', html_url: `https://github.com/${OTHER}/issues/45` }]);
    fake.state.w.hiddenEnds.add(`${KEY}#99`);
    comment(fake, 56, MARK(`#60 #61 ${OTHER}#45 #99 #56`), '2026-11-12T05:34:59Z');
    // the repository source lists open items and those touched in the last 14 days: #60 (merged long ago) is outside it, #61 inside
    const snap = await read();
    const ends = snap.items.find((i) => i.number === 56)!.loopBlocked!.ends;
    expect(ends.map((e) => [e.key, e.state, e.kind ?? 'issue'])).toEqual([
      [K(60), 'merged', 'pr'],
      [K(61), 'open', 'pr'],
      [K(45, OTHER.toLowerCase()), 'open', 'issue'],
    ]);
    // #61 came from the read itself, #60 / #45 / #99 were asked for one by one; #56 naming itself is ignored
    expect(ops().filter((o) => o === 'CavilLoopEnd')).toHaveLength(3);
    const g = buildGraph(snap.items, snap.items, BLOCKED);
    expect(g.nodes.get(K(60))!.kind).toBe('pr');
    expect(g.nodes.get(K(60))!.item).toBeNull(); // not in the sources: dashed
    expect(g.nodes.get(K(61))!.item).not.toBeNull(); // in the source: a PR node drawn only because a registration names it
    expect(g.edges).toEqual([
      { from: K(45, OTHER.toLowerCase()), to: K(56), open: true },
      { from: K(60), to: K(56), open: false },
      { from: K(61), to: K(56), open: true },
    ]);
    expect(g.nodes.get(K(56))!.blockedByOpen).toBe(2);
    // a PR goes in only as the end a registration names: #56 and #61 are shown, nothing hidden
    expect(g.entries).toBe(2);
    // #62, a PR nobody names, is still never drawn
    expect(g.nodes.has(K(62))).toBe(false);
    expect(g.noRelation).toBe(1);
  });

  it('only the registration after the waiting label was last removed counts; an older one does not', async () => {
    await start([issue(55, []), issue(56, [BLOCKED]), issue(70, [])]);
    comment(fake, 56, MARK('#70'), '2026-11-10T00:00:00Z');
    unlabeled(fake, 56, '2026-11-11T00:00:00Z');
    unlabeled(fake, 56, '2026-11-11T00:00:00Z', 'other-label');
    let snap = await read();
    expect(snap.items.find((i) => i.number === 56)!.loopBlocked!.ends).toEqual([]);
    comment(fake, 56, MARK('#55'), '2026-11-12T00:00:00Z');
    snap = await read();
    expect(snap.items.find((i) => i.number === 56)!.loopBlocked!.ends.map((e) => e.key)).toEqual([K(55)]);
  });

  it('walks back older pages until it reaches the last removal of the label (and no further)', async () => {
    await start([issue(55, []), issue(56, [BLOCKED]), issue(70, [])]);
    fake.state.w.loopPage = 2;
    unlabeled(fake, 56, '2026-11-01T00:00:00Z');
    for (let i = 0; i < 3; i++) unlabeled(fake, 56, `2026-11-02T0${i}:00:00Z`, 'noise');
    comment(fake, 56, MARK('#70'), '2026-10-30T00:00:00Z'); // before the removal: does not count
    comment(fake, 56, MARK('#55'), '2026-11-03T00:00:00Z'); // the one that counts, on an older page
    for (let i = 0; i < 4; i++) comment(fake, 56, `chatter ${i}`, `2026-11-04T0${i}:00:00Z`);
    const snap = await read();
    expect(snap.items.find((i) => i.number === 56)!.loopBlocked!.ends.map((e) => e.key)).toEqual([K(55)]);
    const more = fake.log.filter((e) => e.operation === 'CavilLoopBlockedMore');
    expect(more.length).toBeGreaterThan(1); // it did walk back
    // it stopped once a page reached back to the removal: the oldest comment's page was never asked for
    expect(more.filter((e) => e.variables?.comments && e.variables?.commentsBefore === 'lc:0')).toHaveLength(0);
  });
});

describe('read whole or not at all', () => {
  it('a registration read that fails fails the source read (nothing half-read is stored)', async () => {
    await chain();
    fake.state.w.failLoop.add(`${KEY}#57`);
    await expect(read()).rejects.toThrow();
  });
  it('an older page that fails fails the read too', async () => {
    await chain();
    fake.state.w.loopPage = 1;
    comment(fake, 56, 'chatter', '2026-11-12T06:00:00Z');
    fake.state.w.failLoopPages = true;
    await expect(read()).rejects.toThrow();
  });
  it('a prerequisite read that fails for another reason than "not there" fails the read', async () => {
    await start([issue(56, [BLOCKED])]);
    comment(fake, 56, MARK('#77'), '2026-11-12T05:34:59Z');
    fake.state.answerOverride = (e) => (e.operation === 'CavilLoopEnd' ? { status: 502, body: { message: 'Server Error' } } : null);
    await expect(read()).rejects.toThrow();
  });
  it('the sync round keeps the previous snapshot when the registration read fails', async () => {
    await chain();
    const first = await syncRound(client(), [src()], new Map(), NOW, new Map(), 0, () => {}, BLOCKED);
    fake.state.w.failLoop.add(`${KEY}#56`);
    const second = await syncRound(client(), [src()], first.snapshots, NOW + 1, new Map(), 0, () => {}, BLOCKED);
    expect(second.status[0].ok).toBe(false);
    expect(second.snapshots.get(src().key)).toBe(first.snapshots.get(src().key));
  });
});

describe('the one-item re-read goes through the same reader', () => {
  it('a re-read item carries its registration into the cached snapshot', async () => {
    await chain();
    const snap = await read();
    comment(fake, 56, MARK('#57'), '2026-11-12T07:00:00Z');
    const fresh = await fetchItem(client(), REPO, 56, NOW + 1, BLOCKED);
    expect(fresh.loopBlocked!.ends.map((e) => e.key)).toEqual([K(57)]);
    const [changed] = applyFreshItem([snap], fresh);
    expect(changed.items.find((i) => i.number === 56)!.loopBlocked).toEqual(fresh.loopBlocked);
    // the setting off: no registration read, and none put on the item
    const off = await fetchItem(client(), REPO, 56, NOW + 2, '');
    expect(off.loopBlocked).toBeUndefined();
  });
  it('fetchSource passes the setting on to both kinds of source', async () => {
    await chain();
    const snap = await fetchSource(client(), src(), NOW, BLOCKED);
    expect(snap.items.find((i) => i.number === 58)!.loopBlocked!.ends.map((e) => e.key)).toEqual([K(57)]);
  });
});
