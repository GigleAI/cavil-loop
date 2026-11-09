// "A PR goes right under the issue it is linked to" (GitHub#155): one rule for
// the board's columns and the table's groups. The data is chosen so that the
// wrong implementations give a different answer: PR and issue in different
// columns, a PR linked to two issues, an issue filtered away, "updated" sort
// (the later of the two decides) against any other sort (the issue decides),
// and a repository-only issue that does not know its links.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildBoard } from '../../src/data/board';
import { buildTable } from '../../src/data/table';
import { nestPrs } from '../../src/data/prNest';
import { fetchProject } from '../../src/data/fetchSources';
import { GitHubClient } from '../../src/data/github';
import { mergeSnapshots } from '../../src/data/merge';
import { parseSource } from '../../src/shared/sources';
import { DEFAULT_TABLE, DEFAULT_VIEW, normalizeView } from '../../src/shared/viewSettings';
import type { Item, LinkedPr, TableSettings } from '../../src/shared/types';
import { startFakeGitHub } from '../fake-github/server';
import { FAKE_TOKEN, FIXTURE_NOW, FIXTURE_TODAY, item, iter, member, project } from './helpers';

const R = 'o/r';
const sprint = iter('S1', '2026-11-02', 14);
const later = iter('S2', '2026-11-16', 14);
const P = project('p', 'Board', [sprint, later]);
const link = (pr: Item): LinkedPr => ({ key: pr.key, repo: pr.repo, number: pr.number, url: pr.url, state: pr.state });
const pr = (n: number, updatedAt: string, it = sprint) => item(R, n, { kind: 'pr', updatedAt, linkedPrs: [] }, [member(P, it)]);
const issue = (n: number, updatedAt: string, prs: Item[], it = sprint) => item(R, n, { updatedAt, linkedPrs: prs.map(link) }, [member(P, it)]);

const UPDATED: TableSettings['sort'] = { field: 'updated', dir: 'desc' };
const NUMBER: TableSettings['sort'] = { field: 'number', dir: 'desc' };

/** [number, under-number|null] per card of the "S1" column / rows of the "S1" group, board and table side by side */
function both(items: Item[], sort: TableSettings['sort'], on = true) {
  const board = buildBoard(items, [P], 'iteration', false, '2026-11-03', sort, on);
  const col = board.columns.find((c) => c.title === 'S1')!;
  const num = (key: string | null) => (key ? Number(key.split('#')[1]) : null);
  const b = col.cards.map((c) => [c.item.number, num(c.under)]);
  const table = buildTable(items, [P], { ...DEFAULT_TABLE, groupBy: 'iteration', sort, hierarchy: false }, '2026-11-03', on);
  const g = table.groups.find((x) => x.title === 'S1')!;
  const t = g.rows.map((r) => [r.item.number, num(r.under)]);
  return { b, t, board, table };
}

describe('PRs under their issue (GitHub#155)', () => {
  // #10 issue (old) ← #11 PR (newest of all); #20 issue (middle); #30 PR, not linked
  const p11 = pr(11, '2026-11-05T00:00:00Z');
  const i10 = issue(10, '2026-11-01T00:00:00Z', [p11]);
  const i20 = issue(20, '2026-11-03T00:00:00Z', []);
  const p30 = pr(30, '2026-11-04T00:00:00Z');
  const items = [i10, p11, i20, p30];

  it('"updated" sort: the pair moves as one, placed by the later of the two (the PR here); board and table agree', () => {
    const { b, t } = both(items, UPDATED);
    expect(b).toEqual([
      [10, null],
      [11, 10],
      [30, null],
      [20, null],
    ]);
    expect(t).toEqual(b);
  });

  it('any other sort: the pair sits where the issue sits, the PR right after it', () => {
    const { b, t } = both(items, NUMBER);
    expect(b).toEqual([
      [30, null],
      [20, null],
      [10, null],
      [11, 10],
    ]);
    expect(t).toEqual(b);
  });

  it('switched off: the old order, nothing nested', () => {
    const { b, t } = both(items, UPDATED, false);
    expect(b).toEqual([
      [11, null],
      [30, null],
      [20, null],
      [10, null],
    ]);
    expect(t).toEqual(b);
  });

  it('PR and issue in different columns: the PR follows the issue into its column, and is gone from its own (GitHub#275)', () => {
    const p41 = pr(41, '2026-11-05T00:00:00Z', later);
    const i40 = issue(40, '2026-11-01T00:00:00Z', [p41]);
    const { b, t, board, table } = both([i40, p41, i20], UPDATED);
    expect(b).toEqual([
      [40, null],
      [41, 40],
      [20, null],
    ]);
    expect(t).toEqual(b);
    expect(board.columns.find((c) => c.title === 'S2')!.cards).toEqual([]);
    expect(table.groups.map((g) => g.title)).toEqual(['S1']);
  });

  it('a PR linked to two issues of the column goes under the first of them only, once', () => {
    const p51 = pr(51, '2026-11-02T00:00:00Z');
    const i50 = issue(50, '2026-11-04T00:00:00Z', [p51]);
    const i52 = issue(52, '2026-11-03T00:00:00Z', [p51]);
    const { b, t } = both([i52, p51, i50], UPDATED);
    expect(b).toEqual([
      [50, null],
      [51, 50],
      [52, null],
    ]);
    expect(t).toEqual(b);
  });

  it('several PRs under one issue: newest first', () => {
    // the number order (62, 61) is not the update order (61 is newer)
    const a = pr(61, '2026-11-04T00:00:00Z');
    const c = pr(62, '2026-11-02T00:00:00Z');
    const i60 = issue(60, '2026-11-01T00:00:00Z', [a, c]);
    const { b, t } = both([a, i60, c], NUMBER);
    expect(b).toEqual([
      [60, null],
      [61, 60],
      [62, 60],
    ]);
    expect(t).toEqual(b);
  });

  it('the issue filtered away: the PR stays where it is', () => {
    const { b } = both([p11, i20, p30], UPDATED);
    expect(b).toEqual([
      [11, null],
      [30, null],
      [20, null],
    ]);
  });

  it('a repository-only issue does not know its links (null): nothing goes under it', () => {
    const repoOnly = { ...i10, linkedPrs: null };
    const { b } = both([repoOnly, p11, i20], UPDATED);
    expect(b).toEqual([
      [11, null],
      [20, null],
      [10, null],
    ]);
  });

  it('swimlanes: a PR from another repository follows its issue into the issue\'s lane', () => {
    const other = item('o/other', 7, { kind: 'pr', updatedAt: '2026-11-05T00:00:00Z' }, [member(P, sprint)]);
    const host = issue(70, '2026-11-01T00:00:00Z', [other]);
    const board = buildBoard([host, other], [P], 'iteration', true, '2026-11-03', UPDATED, true);
    const col = board.columns.find((c) => c.title === 'S1')!;
    expect(col.cards.map((c) => [c.item.key, c.lane, c.under])).toEqual([
      ['o/r#70', 'o/r', null],
      ['o/other#7', 'o/r', 'o/r#70'],
    ]);
    expect(board.lanes).toEqual(['o/r']);
  });

  it('table with sub-issues indented: the PR goes right under its issue, before the sub-issues, one level deeper', () => {
    const p81 = pr(81, '2026-11-05T00:00:00Z');
    const parent = issue(80, '2026-11-01T00:00:00Z', [p81]);
    const child = item(R, 82, { updatedAt: '2026-11-04T00:00:00Z', parent: 'o/r#80' }, [member(P, sprint)]);
    const t = buildTable([child, p81, parent, i20], [P], { ...DEFAULT_TABLE, groupBy: 'iteration', sort: UPDATED, hierarchy: true }, '2026-11-03', true);
    expect(t.groups[0].rows.map((r) => [r.item.number, r.depth, r.under])).toEqual([
      [80, 0, null],
      [81, 1, 'o/r#80'],
      [82, 1, null],
      [20, 0, null],
    ]);
  });

  it('the shared function itself: entries come back each exactly once', () => {
    const list = [p30, p11, i20, i10];
    const out = nestPrs(list, (x) => x, UPDATED);
    expect(out.map((n) => n.entry.key).sort()).toEqual(list.map((x) => x.key).sort());
  });

  it('on the recorded cavil project: every PR sits right under an issue it is linked to, or that issue is not in its column', async () => {
    const fake = await startFakeGitHub();
    try {
      const client = new GitHubClient({ api: fake.api, web: fake.web }, FAKE_TOKEN);
      const snap = await fetchProject(client, parseSource('https://github.com/orgs/GigleAI/projects/11') as any, FIXTURE_NOW);
      const data = mergeSnapshots([snap], null);
      const board = buildBoard(data.items, data.projects, 'status', false, FIXTURE_TODAY, UPDATED, true);
      let nested = 0;
      for (const col of board.columns) {
        const keys = col.cards.map((c) => c.item.key);
        col.cards.forEach((c, i) => {
          const hosts = col.cards.filter((h) => h.item.kind === 'issue' && h.item.linkedPrs?.some((l) => l.key === c.item.key));
          if (c.item.kind !== 'pr' || hosts.length === 0) {
            expect(c.under, `${col.title} ${c.item.key}`).toBeNull();
            return;
          }
          nested++;
          expect(hosts.map((h) => h.item.key)).toContain(c.under);
          // right under it: only other PRs of the same issue in between
          const at = keys.indexOf(c.under!);
          expect(col.cards.slice(at + 1, i).every((x) => x.under === c.under), `${col.title} ${c.item.key}`).toBe(true);
        });
      }
      expect(nested).toBeGreaterThan(0);
    } finally {
      await fake.close();
    }
  });
});

describe('view settings for GitHub#155', () => {
  it('older saved settings get the new ones by default; invalid widths are replaced', () => {
    const old = { mode: 'status', swimlanes: true, selected: null };
    expect(normalizeView(old)).toMatchObject({ mode: 'status', prsUnderIssues: true, detailWidth: DEFAULT_VIEW.detailWidth });
    expect(normalizeView({ ...old, prsUnderIssues: false, detailWidth: 720 })).toMatchObject({ prsUnderIssues: false, detailWidth: 720 });
    for (const w of [100, 10_000, Number.NaN, '600']) expect(normalizeView({ ...old, detailWidth: w }).detailWidth).toBe(DEFAULT_VIEW.detailWidth);
  });
});
