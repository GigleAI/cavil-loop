import { mkdtempSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Item, Iteration, ProjectMembership, ProjectMeta } from '../../src/shared/types';

const here = dirname(fileURLToPath(import.meta.url));

export const FAKE_TOKEN = 'gho_faketoken000000000000000000000001';

/** "now" of the recorded fixture, so date windows (14 days, ended iterations) are stable */
export const FIXTURE_NOW = Date.parse(
  JSON.parse(readFileSync(join(here, '../fixtures/cavil-project-11.pages.json'), 'utf8')).recordedAt,
);
export const FIXTURE_TODAY = new Date(FIXTURE_NOW).toISOString().slice(0, 10);

/** issues / PRs on the recorded board (archived and draft items do not count), read straight from the JSON */
export const FIXTURE_ITEM_COUNT: number = JSON.parse(readFileSync(join(here, '../fixtures/cavil-project-11.pages.json'), 'utf8')).pages
  .flatMap((p: any) => p.items.nodes)
  .filter((n: any) => !n.isArchived && n.content && n.content.__typename !== 'DraftIssue').length;

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'cavil-client-test-'));
}

export function iter(title: string, startDate: string, duration = 7): Iteration {
  return { id: `${title}-${startDate}`, title, startDate, duration };
}

export function project(key: string, title: string, iterations: Iteration[] | null, statusOptions = ['Todo', 'Done']): ProjectMeta {
  return {
    key,
    title,
    url: `https://github.com/orgs/x/projects/${key}`,
    projectId: `PVT_${key}`,
    viewerCanUpdate: true,
    iterationFieldId: iterations !== null ? `PVTIF_${key}` : null,
    statusFieldId: `PVTSSF_${key}`,
    statusOptionIds: statusOptions.map((name) => ({ id: `opt-${name}`, name })),
    hasIterationField: iterations !== null,
    iterations: iterations ?? [],
    statusOptions,
    views: [],
  };
}

export function item(repo: string, number: number, extra: Partial<Item> = {}, memberships: ProjectMembership[] = []): Item {
  return {
    key: `${repo.toLowerCase()}#${number}`,
    nodeId: `I_${repo}#${number}`,
    repo,
    number,
    title: `t${number}`,
    url: `https://github.com/${repo}/issues/${number}`,
    kind: 'issue',
    state: 'open',
    stateReason: null,
    updatedAt: '2026-11-01T00:00:00Z',
    labels: [],
    assignees: [],
    milestone: null,
    author: null,
    parent: null,
    subIssues: null,
    linkedPrs: [],
    projects: memberships,
    sources: [],
    ...extra,
  };
}

export function member(p: ProjectMeta, iteration: Iteration | null, status: string | null = null): ProjectMembership {
  return { projectKey: p.key, projectTitle: p.title, itemId: `PVTI_${p.key}`, iteration, status };
}

/** Mark a credential as one this app signed in with (what a completed sign-in records), so a test may seed it directly. */
export function trustedList(...accessTokens: string[]): string[] {
  return accessTokens.map((t) => createHash('sha256').update(t).digest('hex'));
}
