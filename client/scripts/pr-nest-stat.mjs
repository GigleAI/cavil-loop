#!/usr/bin/env node
// How many PRs of a real board are shown under an issue (GitHub#275), with any
// checkout's client code, on one saved copy of the board — so a before / after
// comparison runs both versions on the same input.
//
//   node scripts/pr-nest-stat.mjs --fetch <pages.json> [--owner GigleAI --number 11]
//       read the board's pages with `gh api graphql` and this checkout's query; save them
//   node scripts/pr-nest-stat.mjs <pages.json> [--src <another checkout>/client/src] [--today YYYY-MM-DD]
//       count, with this checkout's code or with the one under --src, on the saved pages
//
// Counting: the real fetchProject → mergeSnapshots → buildTable / buildBoard, PRs under
// their issue on, sorted by update time (newest first), sub-issues not indented; a PR row
// or card counts as "nested" when it is shown under an issue. Read-only: nothing is written
// to GitHub. The board changes over time, so a later --fetch gives other numbers.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};

/** Bundle a tiny entry against `src` (this checkout's own node_modules), import it. */
async function load(src, code) {
  const out = join(mkdtempSync(join(tmpdir(), 'pr-nest-stat-')), 'entry.mjs');
  await build({
    stdin: { contents: code, resolveDir: src, loader: 'ts' },
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: out,
    nodePaths: [join(here, '..', 'node_modules')],
    logLevel: 'silent',
  });
  return import(pathToFileURL(out).href);
}

if (args[0] === '--fetch') {
  const file = args[1];
  const owner = opt('--owner', 'GigleAI');
  const number = opt('--number', '11');
  const { PROJECT_ITEMS_QUERY } = await load(resolve(here, '../src'), "export { PROJECT_ITEMS_QUERY } from './data/queries';");
  const pages = [];
  let after = null;
  for (;;) {
    const a = ['api', 'graphql', '-f', `query=${PROJECT_ITEMS_QUERY}`, '-f', `owner=${owner}`, '-F', `number=${number}`, '-F', 'isOrg=true'];
    if (after) a.push('-f', `after=${after}`);
    const r = JSON.parse(execFileSync('gh', a, { maxBuffer: 1 << 28 }).toString());
    if (r.errors) throw new Error(JSON.stringify(r.errors));
    const p = r.data.organization.projectV2;
    pages.push(p);
    if (!p.items.pageInfo.hasNextPage) break;
    after = p.items.pageInfo.endCursor;
  }
  writeFileSync(file, JSON.stringify({ fetchedAt: new Date().toISOString(), owner, number: Number(number), pages }));
  console.log(`saved ${pages.length} page(s), ${pages.reduce((n, p) => n + p.items.nodes.length, 0)} items, to ${file}`);
  process.exit(0);
}

const file = args[0];
if (!file) {
  console.error('usage: pr-nest-stat.mjs --fetch <pages.json> | <pages.json> [--src <dir>] [--today YYYY-MM-DD]');
  process.exit(2);
}
const saved = JSON.parse(readFileSync(file, 'utf8'));
const src = resolve(opt('--src', join(here, '../src')));
const today = opt('--today', saved.fetchedAt.slice(0, 10));
const m = await load(
  src,
  `export { fetchProject } from './data/fetchSources';
   export { mergeSnapshots } from './data/merge';
   export { buildTable } from './data/table';
   export { buildBoard } from './data/board';
   export { parseSource } from './shared/sources';
   export { DEFAULT_TABLE } from './shared/viewSettings';`,
);
const pages = saved.pages;
const client = {
  graphql: async (_q, v) => {
    const i = v.after ? pages.findIndex((p) => p.items.pageInfo.endCursor === v.after) + 1 : 0;
    return { organization: { projectV2: pages[i] } };
  },
};
const snap = await m.fetchProject(client, m.parseSource(`https://github.com/orgs/${saved.owner}/projects/${saved.number}`), Date.parse(saved.fetchedAt));
const data = m.mergeSnapshots([snap], null);
const sort = { field: 'updated', dir: 'desc' };
const res = { src, input: file, fetchedAt: saved.fetchedAt, today, items: data.items.length, prs: data.items.filter((i) => i.kind === 'pr').length };
for (const groupBy of ['iteration', 'status']) {
  const t = m.buildTable(data.items, data.projects, { ...m.DEFAULT_TABLE, groupBy, sort, hierarchy: false }, today, true);
  const rows = t.groups.flatMap((g) => g.rows).filter((r) => r.item.kind === 'pr');
  const b = m.buildBoard(data.items, data.projects, groupBy, false, today, sort, true);
  const cards = b.columns.flatMap((c) => c.cards).filter((c) => c.item.kind === 'pr');
  res[groupBy] = {
    tableRows: rows.length,
    tableNested: rows.filter((r) => r.under).length,
    boardCards: cards.length,
    boardNested: cards.filter((c) => c.under).length,
    loose: [...new Set(rows.filter((r) => !r.under).map((r) => r.item.number))].sort((a, b) => a - b),
  };
}
console.log(JSON.stringify(res, null, 2));
