// GitHub#275: (1) a PR whose description names an issue (`Refs #N`, what an
// autopilot PR writes; GitHub does not list it as linked) goes under that issue
// too; (2) a PR shown under its issue follows the issue into the issue's
// column / group (the maintainer chose "follow the issue" over "stay in its
// own group"); (3) two or more folded groups next to each other are one run.
//
// The data is chosen so that the wrong implementations answer differently:
// a keyword inside code or a comment, a bare `#N`, "prefs #3"; a PR whose own
// value differs from its issue's; the issue on no selected Project, or
// filtered away; a PR from another repository in "all repositories"; an
// ended-iteration column that only held the PR; and, for the runs, an
// unfolded group in between, a group emptied by a filter, two repositories.

import { describe, expect, it } from 'vitest';
import { buildBoard, COL_NO_STATUS } from '../../src/data/board';
import { buildTable, foldRuns, type Group } from '../../src/data/table';
import { bodyIssueRefs, issuePrLinks } from '../../src/data/prNest';
import { relatedIssues } from '../../src/data/actions';
import { fetchProject, fetchRepo } from '../../src/data/fetchSources';
import { GitHubClient } from '../../src/data/github';
import { mergeSnapshots } from '../../src/data/merge';
import { parseSource } from '../../src/shared/sources';
import { DEFAULT_TABLE, DEFAULT_VIEW } from '../../src/shared/viewSettings';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TableView } from '../../src/renderer/TableView';
import type { Item, LinkedPr, TableSettings } from '../../src/shared/types';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeGitHub } from '../fake-github/server';
import { FAKE_TOKEN, FIXTURE_NOW, FIXTURE_TODAY, item, iter, member, project } from './helpers';

const here = dirname(fileURLToPath(import.meta.url));
const R = 'o/r';
const S1 = iter('S1', '2026-11-02', 14);
const S2 = iter('S2', '2026-11-16', 14);
const OLD = iter('S0', '2026-10-01', 14); // ended on 2026-11-03
const P = project('p', 'Board', [OLD, S1, S2]);
const TODAY = '2026-11-03';
const UPDATED: TableSettings['sort'] = { field: 'updated', dir: 'desc' };
const link = (pr: Item): LinkedPr => ({ key: pr.key, repo: pr.repo, number: pr.number, url: pr.url, state: pr.state });
const pr = (n: number, extra: Partial<Item>, it: typeof S1 | null = S1, repo = R) =>
  item(repo, n, { kind: 'pr', linkedPrs: [], updatedAt: '2026-11-02T00:00:00Z', ...extra }, it ? [member(P, it)] : []);
const issue = (n: number, extra: Partial<Item> = {}, it: typeof S1 | null = S1) => item(R, n, { updatedAt: '2026-11-01T00:00:00Z', ...extra }, it ? [member(P, it)] : []);
const num = (k: string | null) => (k ? Number(k.split('#')[1]) : null);

/** board column / table group -> [number, under] lists, side by side */
function views(items: Item[], groupBy: 'iteration' | 'status' = 'iteration', table: Partial<TableSettings> = {}) {
  const board = buildBoard(items, [P], groupBy, false, TODAY, UPDATED, true);
  const t = buildTable(items, [P], { ...DEFAULT_TABLE, groupBy, sort: UPDATED, hierarchy: false, ...table }, TODAY, true);
  const b = Object.fromEntries(board.columns.map((c) => [c.title, c.cards.map((x) => [x.item.number, num(x.under)])]));
  const g = Object.fromEntries(t.groups.map((x) => [x.title, x.rows.map((r) => [r.item.number, num(r.under)])]));
  return { board, table: t, b, g };
}

describe('which issues a PR description names (GitHub#275)', () => {
  const refs = (body: string, self = 99) => bodyIssueRefs(body, 'GigleAI/Cavil-Loop', self);

  it('every keyword form, this repository and another, in order, each once', () => {
    expect(refs('Refs #273')).toEqual(['gigleai/cavil-loop#273']);
    expect(refs('closes #1\nFixed #2 and RESOLVES #3; ref #4\nfixes   #5 resolved #6 close #7 refs #1')).toEqual(
      [1, 2, 3, 4, 5, 6, 7].map((n) => `gigleai/cavil-loop#${n}`),
    );
    expect(refs('Refs Other/Repo#12, closes x.y/z-w#3')).toEqual(['other/repo#12', 'x.y/z-w#3']);
  });

  it('no keyword, a word that only ends in one, code, comments and the PR itself: none', () => {
    expect(refs('see #5, follow-ups to #47')).toEqual([]);
    expect(refs('prefs #3 hotfixes #4 unrefs #5')).toEqual([]);
    expect(refs('`Refs #5` and\n```\nCloses #6\n```\n~~~md\nfixes #7\n~~~\n<!-- closes #8 -->')).toEqual([]);
    expect(refs('Refs #99', 99)).toEqual([]);
    expect(refs('Refs #5 #6')).toEqual(['gigleai/cavil-loop#5']);
    expect(bodyIssueRefs(null, R, 1)).toEqual([]);
  });

  it('an unclosed code fence hides the rest, as GitHub renders it', () => {
    expect(refs('Refs #1\n```\nRefs #2')).toEqual(['gigleai/cavil-loop#1']);
  });

  it('code as Markdown reads it, not as a pattern guesses it (PR #278 review round 1)', () => {
    const t = '`';
    // an indented code block
    expect(refs('    Refs #5')).toEqual([]);
    expect(refs('Intro\n\n    Refs #5\n\nRefs #6')).toEqual(['gigleai/cavil-loop#6']);
    // a four-backtick fence holding a three-backtick line: the inner line does not close it
    expect(refs([t.repeat(4) + 'md', t.repeat(3), 'Refs #5', t.repeat(4), 'Refs #6'].join('\n'))).toEqual(['gigleai/cavil-loop#6']);
    // a double-backtick span holding a backtick
    expect(refs(`${t}${t}a ${t} Refs #5${t}${t} Refs #6`)).toEqual(['gigleai/cavil-loop#6']);
    // an HTML comment over several lines, and one inside a sentence
    expect(refs('<!--\nRefs #5\n-->\nRefs #6 and <!-- closes #7 --> fixes #8')).toEqual(['gigleai/cavil-loop#6', 'gigleai/cavil-loop#8']);
    // a list item and a quote are prose: they count
    expect(refs('- Refs #5\n> closes #6')).toEqual(['gigleai/cavil-loop#5', 'gigleai/cavil-loop#6']);
    // the autopilot summary's folds are prose too
    expect(refs('<!-- autopilot-summary:begin -->\n<details><summary>背景</summary>\n\nRefs #5\n\n</details>')).toEqual(['gigleai/cavil-loop#5']);
  });
});

describe('a PR that only names its issue goes under it (GitHub#275)', () => {
  it('Refs #N: under the issue on the board and in the table alike', () => {
    const i10 = issue(10);
    const p11 = pr(11, { refIssues: [i10.key], updatedAt: '2026-11-05T00:00:00Z' });
    const i20 = issue(20, { updatedAt: '2026-11-03T00:00:00Z' });
    const { b, g } = views([i20, p11, i10]);
    expect(b.S1).toEqual([
      [10, null],
      [11, 10],
      [20, null],
    ]);
    expect(g.S1).toEqual(b.S1);
  });

  it('a repository-only issue (GitHub links unknown) still takes the PRs that name it', () => {
    const i10 = issue(10, { linkedPrs: null });
    const p11 = pr(11, { refIssues: [i10.key] });
    expect(views([p11, i10]).b.S1).toEqual([
      [10, null],
      [11, 10],
    ]);
  });

  it('linked by GitHub and named too: once, under the first issue', () => {
    const p11 = pr(11, { refIssues: ['o/r#10', 'o/r#12'] });
    const i10 = issue(10, { linkedPrs: [link(p11)], updatedAt: '2026-11-04T00:00:00Z' });
    const i12 = issue(12, { updatedAt: '2026-11-03T00:00:00Z' });
    const { b, g } = views([i12, p11, i10]);
    expect(b.S1).toEqual([
      [10, null],
      [11, 10],
      [12, null],
    ]);
    expect(g.S1).toEqual(b.S1);
  });

  it('the "linked PRs" column: GitHub links first, then the PRs that name it, with where each comes from', () => {
    const a = pr(11, {});
    const c = pr(12, { refIssues: ['o/r#10'] });
    const i10 = issue(10, { linkedPrs: [link(a)] });
    expect(issuePrLinks(i10, [a, c, i10])!.map((l) => [l.number, l.via])).toEqual([
      [11, 'github'],
      [12, 'body'],
    ]);
    // a PR both lists is shown once, as GitHub's
    expect(issuePrLinks({ ...i10, linkedPrs: [link(c)] }, [c])!.map((l) => [l.number, l.via])).toEqual([[12, 'github']]);
    // repository source: unknown stays unknown unless a PR names it
    expect(issuePrLinks({ ...i10, linkedPrs: null }, [a])).toBeNull();
    expect(issuePrLinks({ ...i10, linkedPrs: null }, [c])!.map((l) => l.number)).toEqual([12]);
  });

  it('which issues a merge closes is still GitHub\'s answer only: a PR that only names an issue does not close it', async () => {
    const p11 = pr(11, { refIssues: ['o/r#10'] });
    const named = issue(10);
    const closed = issue(12, { linkedPrs: [link(p11)] });
    const client = { graphql: async () => ({ repository: { pullRequest: { closingIssuesReferences: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } }) } as unknown as GitHubClient;
    const r = await relatedIssues(client, p11, [named, closed]);
    expect(r.items).toEqual([['o/r', 12]]);
  });
});

describe('a PR follows its issue into the issue\'s column / group (GitHub#275, maintainer\'s choice)', () => {
  it('different iteration: shown only under the issue; the ended column that only held the PR is gone', () => {
    const i10 = issue(10);
    const p11 = pr(11, { refIssues: [i10.key] }, OLD);
    const p12 = pr(12, { refIssues: [i10.key] }, S2);
    const { b, g, board } = views([i10, p11, p12]);
    expect(b.S1).toEqual([
      [10, null],
      [11, 10],
      [12, 10],
    ]);
    expect(g).toEqual({ S1: b.S1 });
    expect(board.columns.map((c) => c.title)).toEqual(['S1', 'S2']); // S2 has not ended: it stays, empty
    expect(b.S2).toEqual([]);
  });

  it('a moved card is dragged as the PR itself: its own Projects, no Project label', () => {
    const i10 = issue(10);
    const p11 = pr(11, { refIssues: [i10.key] }, S2);
    const card = views([i10, p11]).board.columns.find((c) => c.title === 'S1')!.cards.find((c) => c.item.number === 11)!;
    expect([card.projectKeys, card.projectTitles, card.under]).toEqual([['p'], [], 'o/r#10']);
  });

  it('by status too, and the PR\'s own value is still what its row shows', () => {
    const i10 = item(R, 10, {}, [member(P, S1, 'Todo')]);
    const p11 = item(R, 11, { kind: 'pr', linkedPrs: [], refIssues: [i10.key] }, [member(P, S1, 'Done')]);
    const { b, g, table } = views([i10, p11], 'status');
    expect(b.Todo).toEqual([
      [10, null],
      [11, 10],
    ]);
    expect(b.Done).toEqual([]);
    expect(g).toEqual({ Todo: b.Todo });
    expect(table.groups[0].rows[1].item.projects[0].status).toBe('Done');
  });

  it('the issue on none of the selected Projects does not pull the PR into "no status"', () => {
    const i10 = issue(10, {}, null);
    const p11 = pr(11, { refIssues: [i10.key] });
    const { b, g, board } = views([i10, p11]);
    expect(b.S1).toEqual([[11, null]]);
    expect(g.S1).toEqual([[11, null]]);
    expect(board.columns.find((c) => c.title === '未加入看板')!.cards.map((c) => c.item.number)).toEqual([10]);
  });

  it('the issue filtered away: the PR stays by its own value', () => {
    const p11 = pr(11, { refIssues: ['o/r#10'] }, S2);
    expect(views([p11]).b.S2).toEqual([[11, null]]);
  });

  it('a PR that is on no board follows an issue that is: out of "not on the board"', () => {
    const i10 = issue(10);
    const p11 = pr(11, { refIssues: [i10.key] }, null);
    const { b, board } = views([i10, p11]);
    expect(b.S1).toEqual([
      [10, null],
      [11, 10],
    ]);
    expect(board.columns.some((c) => c.title === '未加入看板')).toBe(false);
    const card = board.columns[0].cards[1];
    expect(card.projectKeys).toEqual([]); // dragging asks to add it to a Project, as for any card off the board
  });

  it('switched off: every item by its own value, nothing nested', () => {
    const i10 = issue(10);
    const p11 = pr(11, { refIssues: [i10.key] }, S2);
    const board = buildBoard([i10, p11], [P], 'iteration', false, TODAY, UPDATED, false);
    expect(board.columns.map((c) => [c.title, c.cards.map((x) => [x.item.number, x.under])])).toEqual([
      ['S1', [[10, null]]],
      ['S2', [[11, null]]],
    ]);
  });

  it('milestones: the PR follows the issue\'s milestone; a milestone column left empty goes', () => {
    const i10 = item(R, 10, { milestone: { title: 'M1', dueOn: null } });
    const p11 = item(R, 11, { kind: 'pr', linkedPrs: [], refIssues: [i10.key], milestone: { title: 'M2', dueOn: null } });
    const board = buildBoard([i10, p11], [P], 'milestone', false, TODAY, UPDATED, true);
    expect(board.columns.map((c) => [c.title, c.cards.map((x) => [x.item.number, num(x.under)])])).toEqual([['M1', [[10, null], [11, 10]]]]);
    const t = buildTable([i10, p11], [P], { ...DEFAULT_TABLE, groupBy: 'milestone', sort: UPDATED, hierarchy: false }, TODAY, true);
    expect(t.groups.map((g) => [g.title, g.rows.map((r) => [r.item.number, num(r.under)])])).toEqual([['M1', [[10, null], [11, 10]]]]);
  });

  it('"all repositories": a PR from another repository goes to its issue\'s repository section, under the issue', () => {
    const i10 = issue(10);
    const other = pr(7, { refIssues: [i10.key] }, S1, 'o/other');
    const t = buildTable([other, i10], [P], { ...DEFAULT_TABLE, groupBy: 'iteration', sort: UPDATED, hierarchy: false, sliceByRepo: true, slice: null }, TODAY, true);
    expect(t.repos!.map((r) => [r.title, r.groups.map((g) => g.rows.map((x) => x.item.key))])).toEqual([['o/r', [['o/r#10', 'o/other#7']]]]);
  });

  it('table with sub-issues: the PR follows its issue even when the issue is a sub-issue of another group\'s parent', () => {
    const parent = issue(1, {}, S2);
    const child = issue(10, { parent: 'o/r#1' });
    const p11 = pr(11, { refIssues: [child.key] }, S2);
    const t = buildTable([parent, child, p11], [P], { ...DEFAULT_TABLE, groupBy: 'iteration', sort: UPDATED, hierarchy: true }, TODAY, true);
    expect(t.groups.map((g) => [g.title, g.rows.map((r) => [r.item.number, r.depth, num(r.under)])])).toEqual([
      ['S1', [[10, 0, null], [11, 1, 10]]],
      ['S2', [[1, 0, null]]],
    ]);
  });

  it('an issue in two columns (two Projects disagree) takes its PR into both', () => {
    const Q = project('q', 'Other', [OLD, S1, S2]);
    const i10 = item(R, 10, {}, [member(P, S1), member(Q, S2)]);
    const p11 = item(R, 11, { kind: 'pr', linkedPrs: [], refIssues: [i10.key] }, [member(P, OLD)]);
    const board = buildBoard([i10, p11], [P, Q], 'iteration', false, TODAY, UPDATED, true);
    expect(board.columns.map((c) => [c.title, c.cards.map((x) => [x.item.number, num(x.under)])])).toEqual([
      ['S1', [[10, null], [11, 10]]],
      ['S2', [[10, null], [11, 10]]],
    ]);
  });

  it('no PR is lost or doubled: every item of the board shows up exactly as often as its column(s) say', () => {
    const i10 = issue(10, { linkedPrs: [] }, null);
    const items = [issue(1), pr(2, { refIssues: ['o/r#1'] }, S2), pr(3, { refIssues: ['o/r#10'] }), i10, pr(4, {}, OLD), item(R, 5, { kind: 'pr' })];
    const board = buildBoard(items, [P], 'status', false, TODAY, UPDATED, true);
    const seen = board.columns.flatMap((c) => c.cards.map((x) => x.item.number)).sort();
    expect(seen).toEqual([1, 10, 2, 3, 4, 5].sort());
    // #3 names an issue that is on no board: it stays; #2 follows #1
    expect(board.columns.find((c) => c.key === COL_NO_STATUS)!.cards.map((x) => [x.item.number, num(x.under)]).sort()).toEqual([
      [1, null],
      [2, 1],
      [3, null],
      [4, null],
    ]);
  });
});

/**
 * Answer like GitHub: a pull request carries `body` only when the query selects it on
 * PullRequest (the fake GitHub replays recorded pages whatever the query asks for).
 */
function selectsOn(query: string, type: string, field: string): boolean {
  for (const m of query.matchAll(new RegExp(`\\.\\.\\.\\s*on\\s+${type}\\s*\\{`, 'g'))) {
    let depth = 0;
    let top = '';
    for (let i = m.index! + m[0].length - 1; i < query.length; i++) {
      const ch = query[i];
      if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) break;
      else if (depth === 1) top += ch;
      else if (depth === 2 && ch !== '{') top += ' ';
    }
    if (new RegExp(`(^|\\s)${field}(\\s|$)`).test(top)) return true;
  }
  return false;
}
function askedFieldsOnly(client: GitHubClient): GitHubClient {
  const real = client.graphql.bind(client);
  (client as any).graphql = async (query: string, vars: unknown) => {
    const data = await real(query, vars as any);
    if (!selectsOn(query, 'PullRequest', 'body')) {
      const strip = (x: any): void => {
        if (Array.isArray(x)) x.forEach(strip);
        else if (x && typeof x === 'object') {
          if (x.__typename === 'PullRequest') delete x.body;
          Object.values(x).forEach(strip);
        }
      };
      strip(data);
    }
    return data;
  };
  return client;
}

describe('the description is read from both kinds of source (GitHub#275)', () => {
  it('the answer-like-GitHub helper itself: it tells a selected field from one that is not', () => {
    expect(selectsOn('... on Issue { body } ... on PullRequest { id number body }', 'PullRequest', 'body')).toBe(true);
    expect(selectsOn('... on Issue { body } ... on PullRequest { id number labels(first: 5) { nodes { body } } }', 'PullRequest', 'body')).toBe(false);
  });

  const pagesFile = join(here, '../fixtures/cavil-project-11.pages.json');
  const issuesFile = join(here, '../fixtures/cavil-loop.issues.json');

  it('Project pages: a recorded PR with `Refs #N` in its description goes under that recorded issue', async () => {
    const pages = JSON.parse(readFileSync(pagesFile, 'utf8')).pages;
    const nodes = pages.flatMap((p: any) => p.items.nodes);
    const linked = new Set(nodes.flatMap((n: any) => (n.content?.closedByPullRequestsReferences?.nodes ?? []).map((x: any) => x.number)));
    const statusOf = (n: any) => n.fieldValues.nodes.find((v: any) => v.field?.name === 'Status')?.name;
    const loose = nodes.find((n: any) => n.content?.__typename === 'PullRequest' && !linked.has(n.content.number));
    const host = nodes.find((n: any) => n.content?.__typename === 'Issue' && statusOf(n) && statusOf(n) !== statusOf(loose));
    loose.content.body = `## 改了什么\n\nRefs #${host.content.number}\n`;
    const fake = await startFakeGitHub({ projects: new Map([['org/gigleai/11', pages]]) });
    try {
      const client = askedFieldsOnly(new GitHubClient({ api: fake.api, web: fake.web }, FAKE_TOKEN));
      const snap = await fetchProject(client, parseSource('https://github.com/orgs/GigleAI/projects/11') as any, FIXTURE_NOW);
      const data = mergeSnapshots([snap], null);
      const prKey = `gigleai/cavil-loop#${loose.content.number}`;
      const hostKey = `gigleai/cavil-loop#${host.content.number}`;
      expect(data.items.find((i) => i.key === prKey)!.refIssues).toEqual([hostKey]);
      const board = buildBoard(data.items, data.projects, 'status', false, FIXTURE_TODAY, UPDATED, true);
      const at = board.columns.flatMap((c) => c.cards.filter((x) => x.item.key === prKey).map((x) => [c.title, x.under]));
      expect(at).toEqual([[statusOf(host), hostKey]]);
      // every other recorded PR still parses to nothing: the recording has no descriptions
      expect(data.items.filter((i) => i.kind === 'pr' && i.key !== prKey).every((i) => i.refIssues?.length === 0)).toBe(true);
    } finally {
      await fake.close();
    }
  });

  it('repository list: the same, from the REST body', async () => {
    const issues = JSON.parse(readFileSync(issuesFile, 'utf8')).issues;
    const p = issues.find((x: any) => x.pull_request);
    const i = issues.find((x: any) => !x.pull_request);
    p.body = `Refs #${i.number}\n\nRefs GigleAI/other#3`;
    const fake = await startFakeGitHub({ repos: new Map([['gigleai/cavil-loop', issues]]) });
    try {
      const client = new GitHubClient({ api: fake.api, web: fake.web }, FAKE_TOKEN);
      const snap = await fetchRepo(client, parseSource('https://github.com/GigleAI/cavil-loop') as any, FIXTURE_NOW);
      const got = snap.items.find((x) => x.number === p.number)!;
      expect(got.refIssues).toEqual([`gigleai/cavil-loop#${i.number}`, 'gigleai/other#3']);
      expect(snap.items.find((x) => x.number === i.number)!.refIssues).toBeUndefined();
    } finally {
      await fake.close();
    }
  });
});

describe('folded groups next to each other are one line (GitHub#275)', () => {
  const g = (key: string): Group => ({ key, title: key, subtitle: null, current: false, empty: false, preset: { by: 'none' }, rows: [] });
  const shape = (groups: Group[], folded: string[]) =>
    foldRuns(groups, new Set(folded)).map((r) => (r.kind === 'group' ? `${folded.includes(r.group.key) ? '▸' : '▾'}${r.group.key}` : `[${r.groups.map((x) => x.key).join(' ')}]`));

  it('the cases of the agreed design', () => {
    const abcde = ['A', 'B', 'C', 'D', 'E'].map(g);
    expect(shape(abcde, ['A', 'B', 'C', 'E'])).toEqual(['[A B C]', '▾D', '▸E']);
    expect(shape(abcde, ['A', 'C', 'E'])).toEqual(['▸A', '▾B', '▸C', '▾D', '▸E']);
    expect(shape(abcde, [])).toEqual(['▾A', '▾B', '▾C', '▾D', '▾E']);
    expect(shape(abcde, ['A', 'B', 'C', 'D', 'E'])).toEqual(['[A B C D E]']);
    // a group emptied by a filter is not in the list: its neighbours join
    expect(shape([g('A'), g('C')], ['A', 'C'])).toEqual(['[A C]']);
  });

  it('on a built table: one repository\'s groups at a time, so a run never crosses repositories; a filter-emptied group does not break one', () => {
    const items = [
      issue(1, {}, OLD),
      issue(2, {}, S1),
      item('o/s', 3, {}, [member(P, S2)]),
    ];
    const t = buildTable(items, [P], { ...DEFAULT_TABLE, groupBy: 'iteration', sort: UPDATED, sliceByRepo: true, slice: null }, TODAY, true);
    const folded = new Set(t.groups.map((x) => x.key));
    expect(t.repos!.map((r) => foldRuns(r.groups, folded).map((x) => x.kind))).toEqual([['folded'], ['group']]);
  });
});

describe('what a row says after its title under a repository heading (GitHub#275, PR #278 review round 1)', () => {
  it('rendered: "#N" for its own repository, the full name for a PR that followed its issue in from another', () => {
    const host = item('o/host', 10, { milestone: { title: 'M', dueOn: null } });
    const sameNo = item('o/host', 7, { milestone: { title: 'M', dueOn: null } });
    const guest = item('o/other', 7, { kind: 'pr', linkedPrs: [], refIssues: [host.key], milestone: { title: 'M', dueOn: null } });
    const view = { ...DEFAULT_VIEW, prsUnderIssues: true, table: { ...DEFAULT_TABLE, groupBy: 'milestone' as const, sliceByRepo: true, slice: null, hierarchy: false, columns: ['title' as const] } };
    const html = renderToStaticMarkup(createElement(TableView, { items: [host, guest, sameNo], projects: [P], view, today: TODAY, now: Date.parse('2026-11-03T00:00:00Z'), onOpen: () => {} }));
    const rows = [...html.matchAll(/data-testid="row" data-key="([^"]+)"[\s\S]*?data-testid="row-ref">([^<]*)</g)].map((m) => [m[1], m[2]]);
    expect(rows.sort()).toEqual([
      ['o/host#10', '#10'],
      ['o/host#7', '#7'],
      ['o/other#7', 'o/other #7'],
    ]);
    // all three really are under the o/host heading (the guest followed its issue there)
    expect([...html.matchAll(/data-testid="repo-group" data-key="([^"]+)"/g)].map((m) => m[1])).toEqual(['repo:o/host']);
  });
});
