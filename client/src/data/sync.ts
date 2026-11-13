import type { SourceConfig, SourceSnapshot, SourceStatus } from '../shared/types';
import { GitHubClient, GitHubError, RateLimitError, failureInput } from './github';
import { classifyFailure } from '../shared/readFailure';
import { fetchSource } from './fetchSources';
import { boardCounts, checkSource, FULL_READ_EVERY_MS, type CheckResult, type SourceCheck } from './changeCheck';
import { VIEWER_QUERY } from './queries';
import { relationsKnown } from './relations';
import { loopKnown } from './loopBlocked';

export interface SyncRound {
  /** snapshot per source key: fresh where the read completed, previous otherwise */
  snapshots: Map<string, SourceSnapshot>;
  /** sources whose snapshot was replaced this round (to be written to the cache) */
  replaced: SourceSnapshot[];
  status: SourceStatus[];
  /** GitHub could not be reached at all this round */
  offline: boolean;
  /** GitHub#270: why (the error as raised); null when not offline */
  offlineReason: string | null;
  /** the credential was rejected (401): the caller must log out */
  authFailed: boolean;
  viewer: string | null;
  /**
   * GitHub#261: the change-check records to keep for the sources whose result this round
   * produced (key = source key). Only to be kept once that result has landed: a record vouches
   * for exactly the snapshot whose fetchedAt is its `snapshotAt`.
   */
  checks: Map<string, SourceCheck>;
  /** sources the check confirmed unchanged: their previous snapshot stays as it is (not in `replaced`) */
  unchanged: string[];
  /** GitHub#374: no request of this round went out (the read gate was closed from the start) */
  held: boolean;
}

/** GitHub#462: does this snapshot carry the closed items with this pending label? (a board reads every item) */
export function pendingKnown(src: SourceConfig, snap: SourceSnapshot, label: string): boolean {
  return src.kind !== 'repo' || (snap.pendingLabel ?? '') === label.trim();
}

/**
 * One sync round. Each source is read completely or not at all: a source
 * whose read failed anywhere (any page) keeps its previous snapshot as-is,
 * so a failure never looks like "items disappeared".
 *
 * GitHub#261: before reading a source, the change check asks GitHub whether it
 * changed since the snapshot in `previous` (changeCheck.ts). Confirmed unchanged =
 * that snapshot stays, untouched, and the status says it was confirmed this round;
 * anything else = the full read, as before.
 */
export async function syncRound(
  client: GitHubClient,
  sources: SourceConfig[],
  previous: Map<string, SourceSnapshot>,
  now: number,
  /** GitHub#261: the change-check records kept from earlier rounds (empty: every source is read in full) */
  recorded: Map<string, SourceCheck> = new Map(),
  /** GitHub#261: a source is read in full at least this often; 0 = no change check at all (every round reads every source in full, as before) */
  fullReadEveryMs: number = FULL_READ_EVERY_MS,
  /** GitHub#324: one source is over — read, confirmed unchanged or failed (the round's progress) */
  onSourceDone: () => void = () => {},
  /** GitHub#429: the "waiting for a prerequisite" label setting; '' = the loop's registrations are not read */
  loopLabel: string = '',
  /** GitHub#462: the pending ("等人处理") label setting; '' = a repository's closed items carrying it are not read */
  pendingLabel: string = '',
): Promise<SyncRound> {
  const keep = () => new Map([...previous].filter(([k]) => sources.some((s) => s.key === k)));
  // GitHub#401: the source's organisation, for a failure GitHub's words do not name one in
  const orgOf = (s: SourceConfig) => (s.kind === 'project' ? (s.ownerType === 'org' ? s.owner : undefined) : s.owner);
  const unchangedStatus = (e: unknown): SourceStatus[] =>
    sources.map((s) => ({ sourceKey: s.key, ok: false, error: (e as Error).message, dataFrom: previous.get(s.key)?.fetchedAt ?? null, failure: classifyFailure(failureInput(e), orgOf(s), s.kind === 'project') }));

  let viewer: string | null = null;
  try {
    viewer = (await client.graphql<{ viewer: { login: string } }>(VIEWER_QUERY, {})).viewer.login;
  } catch (e) {
    const err = e as GitHubError;
    const authFailed = err instanceof GitHubError && err.kind === 'auth';
    const offline = !(err instanceof GitHubError) || err.kind === 'network';
    const limited = err instanceof RateLimitError;
    return {
      snapshots: keep(),
      replaced: [],
      status: unchangedStatus(err).map((st) => ({ ...st, rateLimited: limited })),
      offline,
      offlineReason: offline ? err.message || null : null,
      authFailed,
      viewer: null,
      checks: new Map(),
      unchanged: [],
      held: limited && !err.sent,
    };
  }

  const snapshots = keep();
  const replaced: SourceSnapshot[] = [];
  const status: SourceStatus[] = [];
  let authFailed = false;
  const checks = new Map<string, SourceCheck>();
  const unchanged: string[] = [];
  // GitHub#261: one count query for every board, then each source checks before it reads
  const checking = fullReadEveryMs > 0;
  // GitHub#374: a rate limit here closed the read gate — every source below then fails at its first read, sending nothing
  const counts = checking
    ? await boardCounts(client, sources).catch((e) => {
        if (e instanceof RateLimitError) return new Map<string, number>();
        throw e;
      })
    : new Map<string, number>();
  type Outcome = { kind: 'read'; snap: SourceSnapshot } | { kind: 'unchanged' };
  const readOne = async (src: SourceConfig): Promise<Outcome> => {
    const prev = previous.get(src.key);
    const old = recorded.get(src.key);
    // a record vouches only for the very snapshot it was taken for — and never for one whose
    // relations are unknown (GitHub#349: cached before they were read): "nothing changed" must
    // not keep that snapshot, only a full read can fill them in
    // GitHub#429: nor for one whose loop registrations were read under another label setting (or not at all)
    // GitHub#462: nor for a repository snapshot whose closed pending items were read for another label (or not at all)
    const usable =
      prev && old && old.snapshotAt === prev.fetchedAt && relationsKnown(prev.items) && loopKnown(prev.items, loopLabel) && pendingKnown(src, prev, pendingLabel) ? old : null;
    let checked: CheckResult | null = null;
    if (checking) {
      try {
        checked = await checkSource(client, src, usable, counts);
      } catch (e) {
        // GitHub#374: rate limited — no full read now (it would be refused, or spend what is left)
        if (e instanceof RateLimitError) throw e;
        checked = null; // could not tell: read in full, keep no record
      }
    }
    if (checked?.unchanged && usable && now - usable.fullAt < fullReadEveryMs) {
      // the previous snapshot stays exactly as it is: not re-stamped, not written again, and
      // never fed as a new read (a read's time is evidence for edits in flight — GitHub#229)
      checks.set(src.key, { ...checked.record, snapshotAt: usable.snapshotAt, fullAt: usable.fullAt });
      return { kind: 'unchanged' };
    }
    const snap = await fetchSource(client, src, now, loopLabel, pendingLabel);
    // the tags were taken before this read began: a change in between is seen again next round
    if (checked) checks.set(src.key, { ...checked.record, snapshotAt: snap.fetchedAt, fullAt: now });
    return { kind: 'read', snap };
  };
  const results = await Promise.allSettled(sources.map((src) => readOne(src).finally(onSourceDone)));
  results.forEach((r, i) => {
    const src = sources[i];
    if (r.status === 'fulfilled' && r.value.kind === 'unchanged') {
      // confirmed current as of this round: `dataFrom` says so (the open detail follows it)
      unchanged.push(src.key);
      status.push({ sourceKey: src.key, ok: true, error: null, dataFrom: now });
    } else if (r.status === 'fulfilled' && r.value.kind === 'read') {
      const snap = r.value.snap;
      snapshots.set(src.key, snap);
      replaced.push(snap);
      status.push({ sourceKey: src.key, ok: true, error: null, dataFrom: snap.fetchedAt });
    } else if (r.status === 'rejected') {
      checks.delete(src.key);
      const err = r.reason as Error;
      if (err instanceof GitHubError && err.kind === 'auth') authFailed = true;
      status.push({
        sourceKey: src.key,
        ok: false,
        error: err.message,
        dataFrom: previous.get(src.key)?.fetchedAt ?? null,
        rateLimited: err instanceof RateLimitError,
        failure: classifyFailure(failureInput(err), orgOf(src), src.kind === 'project'),
      });
    }
  });
  return { snapshots, replaced, status, offline: false, offlineReason: null, authFailed, viewer, checks, unchanged, held: false };
}
