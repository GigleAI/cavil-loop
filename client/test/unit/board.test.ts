// Column grouping, measured on the recorded `cavil project` data and on
// small synthetic boards for the cross-Project / cross-repo rules.

import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { buildBoard, COL_NO_ITERATION, COL_NO_MILESTONE, COL_UNBOARDED, NOTICE_NO_ITERATION_FIELD, writesEnabled } from '../../src/data/board';
import { mergeSnapshots } from '../../src/data/merge';
import { fetchProject, fetchRepo } from '../../src/data/fetchSources';
import { GitHubClient } from '../../src/data/github';
import { parseSource } from '../../src/shared/sources';
import type { BoardData, SourceConfig } from '../../src/shared/types';
import { FakeGitHub, loadCavilProjectPages, startFakeGitHub } from '../fake-github/server';
import { FAKE_TOKEN, FIXTURE_NOW, FIXTURE_TODAY, item, iter, member, project } from './helpers';

const counts = (b: ReturnType<typeof buildBoard>) => Object.fromEntries(b.columns.map((c) => [c.title, c.cards.length]));

/** Expected counts straight from the raw recorded JSON, independent of the client code. */
function rawCounts(fieldName: string, valueKey: 'title' | 'name') {
  const out: Record<string, number> = {};
  for (const p of loadCavilProjectPages()) {
    for (const n of p.items.nodes) {
      if (n.isArchived || !n.content || n.content.__typename === 'DraftIssue') continue;
      const v = n.fieldValues.nodes.find((x: any) => x.field?.name === fieldName);
      const k = v ? v[valueKey] : null;
      out[k ?? '(none)'] = (out[k ?? '(none)'] ?? 0) + 1;
    }
  }
  return out;
}

describe('recorded cavil project (GigleAI #11)', () => {
  let fake: FakeGitHub;
  let data: BoardData;
  beforeAll(async () => {
    fake = await startFakeGitHub();
    const client = new GitHubClient({ api: fake.api, web: fake.web }, FAKE_TOKEN);
    const snap = await fetchProject(client, parseSource('https://github.com/orgs/GigleAI/projects/11') as any, FIXTURE_NOW);
    data = mergeSnapshots([snap], null);
  });
  afterAll(() => fake.close());

  it('reads both pages: every item of the board is there', () => {
    const total = loadCavilProjectPages().reduce((n, p) => n + p.items.nodes.length, 0);
    expect(total).toBe(138);
    expect(data.items).toHaveLength(total);
    // the client asked for page 2 with page 1's cursor (it really paginated)
    const ops = fake.log.filter((l) => l.operation === 'CavilProjectItems');
    expect(ops.map((o) => o.variables?.after ?? null)).toEqual([null, loadCavilProjectPages()[0].items.pageInfo.endCursor]);
  });

  it('iteration columns: per-iteration counts equal the raw data; ended ones are flagged; 无迭代 last', () => {
    const b = buildBoard(data.items, data.projects, 'iteration', false, FIXTURE_TODAY);
    expect(b.mode).toBe('iteration');
    const raw = rawCounts('Iteration', 'title');
    const got = counts(b);
    for (const [title, n] of Object.entries(raw)) expect(got[title === '(none)' ? '无迭代' : title], title).toBe(n);
    expect(b.columns.reduce((n, c) => n + c.cards.length, 0)).toBe(138);
    expect(b.columns[b.columns.length - 1].key).toBe(COL_NO_ITERATION);
    // active / upcoming iterations show even when empty, ended ones only with cards
    const byTitle = Object.fromEntries(b.columns.map((c) => [c.title, c]));
    expect(byTitle['Iteration 25'].ended).toBe(false);
    expect(byTitle['Iteration 26']).toMatchObject({ ended: false, cards: [] });
    expect(byTitle['Iteration 24'].ended).toBe(true);
    expect(byTitle['Iteration 22']).toBeUndefined();
    // sorted by start date
    const starts = b.columns.filter((c) => c.subtitle).map((c) => c.subtitle!.slice(0, 10));
    expect([...starts].sort()).toEqual(starts);
  });

  it('status columns follow the field option order and match the raw counts', () => {
    const b = buildBoard(data.items, data.projects, 'status', false, FIXTURE_TODAY);
    const raw = rawCounts('Status', 'name');
    const got = counts(b);
    for (const [name, n] of Object.entries(raw)) expect(got[name === '(none)' ? '无状态' : name], name).toBe(n);
    expect(b.columns.map((c) => c.title).filter((t) => data.projects[0].statusOptions.includes(t))).toEqual(
      data.projects[0].statusOptions,
    );
  });

  it('milestone columns: the board has none, so everything sits in 无里程碑', () => {
    const b = buildBoard(data.items, data.projects, 'milestone', false, FIXTURE_TODAY);
    expect(b.columns.map((c) => [c.key, c.cards.length])).toEqual([[COL_NO_MILESTONE, 138]]);
  });

  it('cards carry state / kind / Project from the real shapes', () => {
    const kinds = new Set(data.items.map((i) => `${i.kind}:${i.state}`));
    expect(kinds).toEqual(new Set(['issue:open', 'issue:closed', 'pr:merged', 'pr:closed', 'pr:open'].filter((k) => [...kinds].includes(k))));
    expect([...kinds].some((k) => k === 'pr:merged')).toBe(true);
    expect(data.items.every((i) => i.projects[0].projectTitle === 'cavil project')).toBe(true);
  });
});

describe('repository source', () => {
  it('reads every open item plus anything updated in the last 14 days, following pagination', async () => {
    const fake = await startFakeGitHub({ restPageSize: 7 });
    try {
      const client = new GitHubClient({ api: fake.api, web: fake.web }, FAKE_TOKEN);
      const src = parseSource('GigleAI/cavil-loop') as Extract<SourceConfig, { kind: 'repo' }>;
      const snap = await fetchRepo(client, src, FIXTURE_NOW);
      const raw = fake.state.repos.get('gigleai/cavil-loop')!;
      const cutoff = new Date(FIXTURE_NOW - 14 * 86_400_000).toISOString();
      const expected = raw.filter((r) => r.state === 'open' || r.updated_at >= cutoff).map((r) => r.number).sort();
      expect(snap.items.map((i) => i.number).sort()).toEqual(expected);
      // closed items updated recently are included (the reason for the window)
      expect(snap.items.some((i) => i.state !== 'open')).toBe(true);
      expect(fake.log.filter((l) => l.path.includes('page=2')).length).toBeGreaterThan(0);
      const merged = raw.find((r) => r.pull_request?.merged_at && r.updated_at >= cutoff);
      if (merged) expect(snap.items.find((i) => i.number === merged.number)?.state).toBe('merged');
    } finally {
      await fake.close();
    }
  });
});

describe('cross-Project and cross-repository rules', () => {
  const s1 = iter('Sprint 1', '2026-11-02');
  const s1b = iter('Sprint 1', '2026-11-09');
  const old = iter('Sprint 0', '2026-10-01');
  const A = project('A', 'Board A', [old, s1]);
  const B = project('B', 'Board B', [s1, s1b]);
  const C = project('C', 'Board C', [s1b]);

  it('one issue in two Projects with different iterations shows once per column, labelled with the Project', () => {
    const it1 = item('o/r', 1, {}, [member(A, s1), member(C, s1b)]);
    const b = buildBoard([it1], [A, C], 'iteration', false, '2026-11-05');
    const placed = b.columns.filter((c) => c.cards.length);
    expect(placed).toHaveLength(2);
    expect(placed.map((c) => c.cards[0].projectTitles)).toEqual([['Board A'], ['Board C']]);
  });

  it('same iteration in two Projects (same title AND start) merges into one column with one card', () => {
    const it1 = item('o/r', 1, {}, [member(A, s1), member(B, s1)]);
    const b = buildBoard([it1], [A, B], 'iteration', false, '2026-11-05');
    const placed = b.columns.filter((c) => c.cards.length);
    expect(placed).toHaveLength(1);
    expect(placed[0].cards).toHaveLength(1);
    expect(placed[0].cards[0].projectTitles.sort()).toEqual(['Board A', 'Board B']);
  });

  it('same title but different start date stays two columns, told apart by Project names', () => {
    const b = buildBoard([item('o/r', 1, {}, [member(A, s1)]), item('o/r', 2, {}, [member(C, s1b)])], [A, C], 'iteration', false, '2026-11-05');
    const sprint1 = b.columns.filter((c) => c.title === 'Sprint 1');
    expect(sprint1).toHaveLength(2);
    expect(sprint1.map((c) => c.subtitle)).toEqual(['2026-11-02 起 · Board A', '2026-11-09 起 · Board C']);
  });

  it('ended iterations are flagged; order is by start date; 无迭代 is the last column', () => {
    const b = buildBoard(
      [item('o/r', 1, {}, [member(A, old)]), item('o/r', 2, {}, [member(A, s1)]), item('o/r', 3, {}, [member(A, null)])],
      [A],
      'iteration',
      false,
      '2026-11-05',
    );
    expect(b.columns.map((c) => [c.title, c.ended])).toEqual([
      ['Sprint 0', true],
      ['Sprint 1', false],
      ['无迭代', false],
    ]);
  });

  it('items not in any selected Project go to 未加入看板 (before 无迭代)', () => {
    const b = buildBoard([item('o/r', 1), item('o/r', 2, {}, [member(A, null)])], [A], 'iteration', false, '2026-11-05');
    expect(b.columns.slice(-2).map((c) => [c.key, c.cards.length])).toEqual([
      [COL_UNBOARDED, 1],
      [COL_NO_ITERATION, 1],
    ]);
  });

  it('falls back to status with a notice when no selected Project has an iteration field', () => {
    const N = project('N', 'No iter', null, ['Todo', 'Done']);
    const b = buildBoard([item('o/r', 1, {}, [member(N, null, 'Done')])], [N], 'iteration', false, '2026-11-05');
    expect(b.mode).toBe('status');
    expect(b.notice).toBe(NOTICE_NO_ITERATION_FIELD);
    expect(counts(b)).toMatchObject({ Done: 1 });
    // with an iteration field present there is no fallback
    expect(buildBoard([], [A], 'iteration', false, '2026-11-05')).toMatchObject({ mode: 'iteration', notice: null });
  });

  it('status differs per Project → one card per status column', () => {
    const b = buildBoard([item('o/r', 1, {}, [member(A, null, 'Todo'), member(B, null, 'Done')])], [A, B], 'status', false, '2026-11-05');
    expect(counts(b)).toMatchObject({ Todo: 1, Done: 1 });
  });

  it('milestones: same title across repos merges, ordered by due date, 无里程碑 last', () => {
    const items = [
      item('o/a', 1, { milestone: { title: 'v2', dueOn: '2026-12-31T00:00:00Z' } }),
      item('o/b', 2, { milestone: { title: 'v1', dueOn: '2026-11-30T00:00:00Z' } }),
      item('o/a', 3, { milestone: { title: 'v1', dueOn: '2026-12-15T00:00:00Z' } }),
      item('o/b', 4, { milestone: { title: 'someday', dueOn: null } }),
      item('o/b', 5),
    ];
    const b = buildBoard(items, [], 'milestone', false, '2026-11-05');
    expect(b.columns.map((c) => [c.title, c.cards.map((x) => x.item.repo).sort()])).toEqual([
      ['v1', ['o/a', 'o/b']],
      ['v2', ['o/a']],
      ['someday', ['o/b']],
      ['无里程碑', ['o/b']],
    ]);
  });

  it('swimlanes list every repository once, sorted; each card knows its lane', () => {
    const b = buildBoard([item('z/z', 1), item('a/b', 2), item('a/b', 3)], [], 'milestone', true, '2026-11-05');
    expect(b.lanes).toEqual(['a/b', 'z/z']);
    expect(b.columns[0].cards.map((c) => c.lane)).toEqual(['a/b', 'a/b', 'z/z']);
    expect(buildBoard([item('z/z', 1)], [], 'milestone', false, '2026-11-05').lanes).toBeNull();
  });
});

describe('de-duplication across sources', () => {
  it('an item from a Project and from its repository is one item, memberships and sources unioned', () => {
    const A = project('A', 'Board A', [iter('S', '2026-11-02')]);
    const fromProject = item('O/R', 7, { updatedAt: '2026-11-01T00:00:00Z', title: 'old', sources: ['project:A'] }, [member(A, null)]);
    const fromRepo = item('O/R', 7, { updatedAt: '2026-11-03T00:00:00Z', title: 'new', sources: ['repo:o/r'] });
    const other = item('O/R', 8, { sources: ['repo:o/r'] });
    const merged = mergeSnapshots(
      [
        { sourceKey: 'project:A', fetchedAt: 1, items: [fromProject], project: A },
        { sourceKey: 'repo:o/r', fetchedAt: 1, items: [fromRepo, other] },
      ],
      null,
    );
    expect(merged.items).toHaveLength(2);
    const seven = merged.items.find((i) => i.number === 7)!;
    expect(seven.title).toBe('new');
    expect(seven.projects.map((p) => p.projectKey)).toEqual(['A']);
    expect(seven.sources.sort()).toEqual(['project:A', 'repo:o/r']);
    const b = buildBoard(merged.items, merged.projects, 'milestone', false, '2026-11-05');
    expect(b.columns[0].cards).toHaveLength(2);
  });

  it('unticked sources are left out, Project memberships included', () => {
    const A = project('A', 'Board A', [iter('S', '2026-11-02')]);
    const it7 = item('o/r', 7, { sources: ['project:A'] }, [member(A, null)]);
    const merged = mergeSnapshots(
      [
        { sourceKey: 'project:A', fetchedAt: 1, items: [it7], project: A },
        { sourceKey: 'repo:o/r', fetchedAt: 1, items: [item('o/r', 7, { sources: ['repo:o/r'] })] },
      ],
      ['repo:o/r'],
    );
    expect(merged.projects).toEqual([]);
    expect(merged.items[0].projects).toEqual([]);
    const b = buildBoard(merged.items, merged.projects, 'iteration', false, '2026-11-05');
    expect(b.mode).toBe('status'); // no Project selected → no iteration field
  });
});

describe('writes are disabled offline', () => {
  it('offline → disabled; online → enabled', () => {
    expect(writesEnabled({ offline: true })).toBe(false);
    expect(writesEnabled({ offline: false })).toBe(true);
  });
});
