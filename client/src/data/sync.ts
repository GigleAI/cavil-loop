import type { SourceConfig, SourceSnapshot, SourceStatus } from '../shared/types';
import { GitHubClient, GitHubError } from './github';
import { fetchSource } from './fetchSources';
import { VIEWER_QUERY } from './queries';

export interface SyncRound {
  /** snapshot per source key: fresh where the read completed, previous otherwise */
  snapshots: Map<string, SourceSnapshot>;
  /** sources whose snapshot was replaced this round (to be written to the cache) */
  replaced: SourceSnapshot[];
  status: SourceStatus[];
  /** GitHub could not be reached at all this round */
  offline: boolean;
  /** the credential was rejected (401): the caller must log out */
  authFailed: boolean;
  viewer: string | null;
}

/**
 * One sync round. Each source is read completely or not at all: a source
 * whose read failed anywhere (any page) keeps its previous snapshot as-is,
 * so a failure never looks like "items disappeared".
 */
export async function syncRound(
  client: GitHubClient,
  sources: SourceConfig[],
  previous: Map<string, SourceSnapshot>,
  now: number,
): Promise<SyncRound> {
  const keep = () => new Map([...previous].filter(([k]) => sources.some((s) => s.key === k)));
  const unchangedStatus = (error: string): SourceStatus[] =>
    sources.map((s) => ({ sourceKey: s.key, ok: false, error, dataFrom: previous.get(s.key)?.fetchedAt ?? null }));

  let viewer: string | null = null;
  try {
    viewer = (await client.graphql<{ viewer: { login: string } }>(VIEWER_QUERY, {})).viewer.login;
  } catch (e) {
    const err = e as GitHubError;
    const authFailed = err instanceof GitHubError && err.kind === 'auth';
    const offline = !(err instanceof GitHubError) || err.kind === 'network';
    return { snapshots: keep(), replaced: [], status: unchangedStatus(err.message), offline, authFailed, viewer: null };
  }

  const snapshots = keep();
  const replaced: SourceSnapshot[] = [];
  const status: SourceStatus[] = [];
  let authFailed = false;
  const results = await Promise.allSettled(sources.map((s) => fetchSource(client, s, now)));
  results.forEach((r, i) => {
    const src = sources[i];
    if (r.status === 'fulfilled') {
      snapshots.set(src.key, r.value);
      replaced.push(r.value);
      status.push({ sourceKey: src.key, ok: true, error: null, dataFrom: r.value.fetchedAt });
    } else {
      const err = r.reason as Error;
      if (err instanceof GitHubError && err.kind === 'auth') authFailed = true;
      status.push({ sourceKey: src.key, ok: false, error: err.message, dataFrom: previous.get(src.key)?.fetchedAt ?? null });
    }
  });
  return { snapshots, replaced, status, offline: false, authFailed, viewer };
}
