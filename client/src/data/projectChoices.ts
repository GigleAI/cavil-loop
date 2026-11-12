// GitHub#401: read what "从 GitHub 选" offers — the signed-in account's own Projects, the
// organisations it belongs to, and each organisation's open Projects. Each organisation is its own
// request: GitHub fails a whole request on any error, and one organisation that has not approved
// this app must not hide the others. A list is read whole or not at all (never "no Projects" for a
// list that failed half way); what failed carries its classified reason.

import type { ChoiceGroup, ProjectChoice, ProjectChoices } from '../shared/types';
import { classifyFailure } from '../shared/readFailure';
import { GitHubClient, GitHubError, failureInput } from './github';
import { CHOICES_ORG_QUERY, CHOICES_ORGS_QUERY, CHOICES_VIEWER_QUERY } from './queries';

/** at most this many pages per list (50 Projects / 100 organisations a page) */
export const MAX_CHOICE_PAGES = 20;

interface Page<T> {
  nodes: (T | null)[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}
type RawProject = { number: number; title: string; closed: boolean; url: string };

/** every page of one list; `truncated` = there were more than MAX_CHOICE_PAGES */
async function allPages<T>(read: (after: string | null) => Promise<Page<T> | null>): Promise<{ nodes: T[]; truncated: boolean }> {
  const nodes: T[] = [];
  let after: string | null = null;
  for (let i = 0; i < MAX_CHOICE_PAGES; i++) {
    const page = await read(after);
    if (!page) {
      const missing = new GitHubError('graphql', 'GitHub 没有返回这份列表');
      missing.meta.gqlTypes = ['NOT_FOUND'];
      throw missing;
    }
    nodes.push(...page.nodes.filter((n): n is T => n !== null));
    if (!page.pageInfo.hasNextPage) return { nodes, truncated: false };
    if (!page.pageInfo.endCursor) throw new GitHubError('graphql', 'GitHub 的分页缺少下一页的位置');
    after = page.pageInfo.endCursor;
  }
  return { nodes, truncated: true };
}

const openOnes = (xs: RawProject[]): ProjectChoice[] => xs.filter((p) => !p.closed).map((p) => ({ number: p.number, title: p.title, url: p.url }));

export async function readProjectChoices(client: GitHubClient): Promise<ProjectChoices> {
  let viewer = '';
  let own: { nodes: RawProject[]; truncated: boolean };
  try {
    own = await allPages<RawProject>(async (after) => {
      const d = await client.graphql<{ viewer: { login: string; projectsV2: Page<RawProject> } }>(CHOICES_VIEWER_QUERY, { after });
      viewer = d.viewer.login;
      return d.viewer.projectsV2;
    });
  } catch (e) {
    return { ok: false, failure: classifyFailure(failureInput(e), undefined, true), groups: [] };
  }
  const groups: ChoiceGroup[] = [{ owner: viewer, ownerType: 'user', ok: true, projects: openOnes(own.nodes), truncated: own.truncated }];
  let orgs: { nodes: { login: string }[]; truncated: boolean };
  try {
    orgs = await allPages<{ login: string }>(async (after) => (await client.graphql<{ viewer: { organizations: Page<{ login: string }> } }>(CHOICES_ORGS_QUERY, { after })).viewer.organizations);
  } catch (e) {
    return { ok: true, viewer, groups, orgsFailure: classifyFailure(failureInput(e)) };
  }
  const orgGroups = await Promise.all(
    orgs.nodes.map(async ({ login }): Promise<ChoiceGroup> => {
      try {
        const r = await allPages<RawProject>(async (after) => (await client.graphql<{ organization: { projectsV2: Page<RawProject> } | null }>(CHOICES_ORG_QUERY, { login, after })).organization?.projectsV2 ?? null);
        return { owner: login, ownerType: 'org', ok: true, projects: openOnes(r.nodes), truncated: r.truncated };
      } catch (e) {
        return { owner: login, ownerType: 'org', ok: false, projects: [], failure: classifyFailure(failureInput(e), login, true), truncated: false };
      }
    }),
  );
  return { ok: true, viewer, groups: [...groups, ...orgGroups], ...(orgs.truncated ? { orgsTruncated: true } : {}) };
}
