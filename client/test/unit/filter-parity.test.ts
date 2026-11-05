// The search box against GitHub's own Project filter, on the same data.
// cavil-project-11.filters.json holds what GitHub's server-side filter
// (ProjectV2.items(query:)) returned for each query, recorded in the same run
// as the board pages the fake GitHub serves here. The client reads those pages
// through its real sync code and must return exactly the same items.
//
// Two recorded queries are expected to differ, each asserted on its own:
//   - Chinese text: GitHub splits words on spaces and punctuation, so a word
//     in the middle of a Chinese run is not found; the client finds it.
//   - author: GitHub's Project filter does not support it (it returned 0
//     items for `author:x` AND for `-author:x`); the client does, checked
//     against the raw recorded author field instead.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyFilter, parseFilter } from '../../src/shared/filter';
import { fetchProject } from '../../src/data/fetchSources';
import { GitHubClient } from '../../src/data/github';
import { mergeSnapshots } from '../../src/data/merge';
import { parseSource } from '../../src/shared/sources';
import type { BoardData } from '../../src/shared/types';
import { FakeGitHub, loadCavilProjectPages, startFakeGitHub } from '../fake-github/server';
import { FAKE_TOKEN, FIXTURE_NOW, FIXTURE_TODAY } from './helpers';

const here = dirname(fileURLToPath(import.meta.url));
const recorded: { recordedAt: string; viewer: string; results: { query: string; server: string[] }[] } = JSON.parse(
  readFileSync(join(here, '../fixtures/cavil-project-11.filters.json'), 'utf8'),
);

const CHINESE = '客户端';
const isAuthor = (q: string) => /(^|\s)-?author:/.test(q);

describe('search box = GitHub server-side filter, item by item (recorded cavil project)', () => {
  let fake: FakeGitHub;
  let data: BoardData;
  const run = (q: string) => {
    const parsed = parseFilter(q);
    const keys = applyFilter(data.items, parsed, { viewer: recorded.viewer, today: FIXTURE_TODAY, projects: data.projects })
      .map((i) => i.key)
      .sort();
    return { parsed, keys };
  };

  beforeAll(async () => {
    fake = await startFakeGitHub();
    const client = new GitHubClient({ api: fake.api, web: fake.web }, FAKE_TOKEN);
    const snap = await fetchProject(client, parseSource('https://github.com/orgs/GigleAI/projects/11') as any, FIXTURE_NOW);
    data = mergeSnapshots([snap], null);
  });
  afterAll(() => fake.close());

  it('the recording and the board pages are the same moment', () => {
    expect(recorded.recordedAt).toBe(new Date(FIXTURE_NOW).toISOString());
    expect(recorded.results.length).toBeGreaterThan(40);
  });

  for (const { query, server } of recorded.results) {
    if (query === CHINESE || isAuthor(query)) continue;
    it(`same items as GitHub: ${query}`, () => {
      const { parsed, keys } = run(query);
      expect(parsed.unsupported, 'every recorded query is supported syntax').toEqual([]);
      expect(keys).toEqual(server);
    });
  }

  it('the recorded queries are not all trivially empty or full (they tell implementations apart)', () => {
    const sizes = recorded.results.filter((r) => r.query !== CHINESE && !isAuthor(r.query)).map((r) => r.server.length);
    const total = data.items.length;
    expect(sizes.filter((n) => n > 0 && n < total).length).toBeGreaterThan(25);
  });

  it(`Chinese text in the middle of a run: the client finds everything GitHub found, and more (${CHINESE})`, () => {
    const server = recorded.results.find((r) => r.query === CHINESE)!.server;
    const { keys } = run(CHINESE);
    for (const k of server) expect(keys).toContain(k);
    expect(keys.length).toBeGreaterThan(server.length);
    // every extra one really has the word in its title
    for (const it of data.items.filter((i) => keys.includes(i.key))) expect(it.title).toContain(CHINESE);
  });

  it('author: GitHub returns nothing for author:x and -author:x alike (unsupported there); the client matches the raw author field', () => {
    const authorQueries = recorded.results.filter((r) => isAuthor(r.query));
    expect(authorQueries.length).toBeGreaterThan(0);
    for (const r of authorQueries) expect(r.server, r.query).toEqual([]);
    // expected straight from the raw recorded JSON, independent of the client code
    const rawAuthor = new Map<string, string | null>();
    for (const p of loadCavilProjectPages()) {
      for (const n of p.items.nodes) {
        if (n.isArchived || !n.content || n.content.__typename === 'DraftIssue') continue;
        rawAuthor.set(`${n.content.repository.nameWithOwner.toLowerCase()}#${n.content.number}`, n.content.author?.login ?? null);
      }
    }
    const login = recorded.results.find((r) => /^author:[^@]/.test(r.query))!.query.slice('author:'.length);
    const want = [...rawAuthor].filter(([, a]) => a === login).map(([k]) => k).sort();
    expect(want.length).toBeGreaterThan(0);
    expect(want.length).toBeLessThan(rawAuthor.size);
    expect(run(`author:${login}`).keys).toEqual(want);
    expect(run(`-author:${login}`).keys).toEqual([...rawAuthor.keys()].filter((k) => !want.includes(k)).sort());
    expect(run('author:@me').keys).toEqual(recorded.viewer === login ? want : run(`author:${recorded.viewer}`).keys);
  });
});
