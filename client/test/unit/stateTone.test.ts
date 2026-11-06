// GitHub#172 review: issue / PR state colours follow GitHub. One rule
// (src/shared/stateTone.ts) decides the colour role for the detail badge, the
// board card and the table row; the close reason it needs comes from all three
// sync paths (Project read, repository read, one-item re-read after a change).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseStateReason, stateTone } from '../../src/shared/stateTone';
import { fetchProject, fetchRepo, contentToItem } from '../../src/data/fetchSources';
import { fetchItem } from '../../src/data/itemRefresh';
import { GitHubClient } from '../../src/data/github';
import { parseSource } from '../../src/shared/sources';
import type { IssueStateReason, ItemKind, ItemState } from '../../src/shared/types';
import { FakeGitHub, startFakeGitHub } from '../fake-github/server';
import { findCopies } from '../fake-github/writes';
import { FAKE_TOKEN, FIXTURE_NOW } from './helpers';

describe('stateTone: GitHub colour roles', () => {
  // Written from how GitHub colours each case, one row per combination — not
  // derived from the implementation:
  //   issue open green · issue closed completed (or no reason recorded) purple ·
  //   issue closed not planned / duplicate grey · PR open green · PR draft grey ·
  //   PR closed red (draft mark or not) · PR merged purple
  const rows: [ItemKind, ItemState, IssueStateReason | null, boolean | null, string][] = [
    ['issue', 'open', null, null, 'open'],
    ['issue', 'open', 'reopened', null, 'open'],
    ['issue', 'closed', 'completed', null, 'done'],
    ['issue', 'closed', null, null, 'done'],
    ['issue', 'closed', 'not_planned', null, 'neutral'],
    ['issue', 'closed', 'duplicate', null, 'neutral'],
    ['pr', 'open', null, null, 'open'],
    ['pr', 'open', null, false, 'open'],
    ['pr', 'open', null, true, 'neutral'],
    ['pr', 'closed', null, null, 'closed'],
    ['pr', 'closed', null, true, 'closed'],
    ['pr', 'merged', null, null, 'done'],
    ['pr', 'merged', null, true, 'done'],
  ];
  for (const [kind, state, reason, draft, want] of rows)
    it(`${kind} ${state} reason=${reason} draft=${draft} → ${want}`, () => {
      expect(stateTone(kind, state, reason, draft)).toBe(want);
    });

  it('a cache written before the close reason existed (field missing) reads as GitHub shows such issues: done', () => {
    expect(stateTone('issue', 'closed', undefined, null)).toBe('done');
  });

  it('close reason as GraphQL and REST spell it; anything else is "none"', () => {
    expect(['COMPLETED', 'NOT_PLANNED', 'DUPLICATE', 'REOPENED'].map(parseStateReason)).toEqual(['completed', 'not_planned', 'duplicate', 'reopened']);
    expect(['completed', 'not_planned', 'duplicate', 'reopened'].map(parseStateReason)).toEqual(['completed', 'not_planned', 'duplicate', 'reopened']);
    expect([null, undefined, '', 'SOMETHING_NEW', 3].map(parseStateReason)).toEqual([null, null, null, null, null]);
  });
});

describe('the close reason reaches the item on every sync path', () => {
  let fake: FakeGitHub;
  let client: GitHubClient;
  const R = 'GigleAI/cavil-loop';
  const store = () => ({ projects: fake.state.projects, repos: fake.state.repos, w: fake.state.w });
  beforeAll(async () => {
    fake = await startFakeGitHub();
    client = new GitHubClient({ api: fake.api, web: fake.web }, FAKE_TOKEN);
  });
  afterAll(() => fake.close());

  it('Project read (GraphQL): each recorded closed issue carries the reason set on GitHub; PRs carry none', async () => {
    // closed issues on the recorded board, given three different reasons and one left without
    const set: Record<number, string | null> = { 128: 'NOT_PLANNED', 102: 'COMPLETED', 106: 'DUPLICATE', 108: null };
    for (const [n, r] of Object.entries(set)) for (const g of findCopies(store(), R, Number(n))!.gql) g.stateReason = r;
    const snap = await fetchProject(client, parseSource('https://github.com/orgs/GigleAI/projects/11') as any, FIXTURE_NOW);
    const got = (n: number) => snap.items.find((i) => i.number === n)!;
    expect(got(128).stateReason).toBe('not_planned');
    expect(got(102).stateReason).toBe('completed');
    expect(got(106).stateReason).toBe('duplicate');
    expect(got(108).stateReason).toBeNull();
    // something did come through: the board has PRs too, and none of them gets a reason
    const prs = snap.items.filter((i) => i.kind === 'pr');
    expect(prs.length).toBeGreaterThan(0);
    expect(prs.every((p) => p.stateReason === null)).toBe(true);
  });

  it('repository read (REST): state_reason is read; PRs carry none', async () => {
    const issues = fake.state.repos.get('gigleai/cavil-loop')!;
    const closed = issues.filter((r) => !r.pull_request && r.state === 'closed');
    expect(closed.length).toBeGreaterThanOrEqual(2);
    const [a, b] = closed;
    a.state_reason = 'not_planned';
    b.state_reason = 'completed';
    // inside the 14-day window, so the repository read includes them
    a.updated_at = b.updated_at = new Date(FIXTURE_NOW - 86_400_000).toISOString();
    const snap = await fetchRepo(client, parseSource(R) as any, FIXTURE_NOW);
    expect(snap.items.find((i) => i.number === a.number)!.stateReason).toBe('not_planned');
    expect(snap.items.find((i) => i.number === b.number)!.stateReason).toBe('completed');
    const prs = snap.items.filter((i) => i.kind === 'pr');
    expect(prs.length).toBeGreaterThan(0);
    expect(prs.every((p) => p.stateReason === null)).toBe(true);
  });

  it('one-item re-read after a change (GraphQL): the reason is read', async () => {
    for (const g of findCopies(store(), R, 138)!.gql) g.stateReason = 'NOT_PLANNED';
    const fresh = await fetchItem(client, R, 138);
    expect(contentToItem(fresh.content, [], [])!.stateReason).toBe('not_planned');
  });
});
