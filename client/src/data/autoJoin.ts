// GitHub#258: a new issue from a table group's "+" that a board NOT ticked in the dialog
// takes in by itself (the board's "auto-add" workflow on GitHub's side, a little after the
// issue exists). The client never adds the issue to such a board; once GitHub has, it sets
// the group's value there — only while that field is still empty. Rules:
//
//   - empty → set it (at most one automatic write per board);
//   - already the group's value → done;
//   - any other value → never overwritten automatically: GitHub records who first created a
//     field value and when it was last updated, not who changed it last, so a board rule's
//     default and a person's change look the same. The notice shows the value and offers a
//     button; only a click (a person who saw the value) overwrites it;
//   - a read that fails, or an answer that does not list everything (more Projects / field
//     values than one page), is "unknown" — never "not on the board" and never "empty".
//
// One judgement (`judgeWatch`) for the first sighting, the check after a write and the
// button; one read (`readCreatedBoards`) for all of them.

import type { CreateWatch, ProjectMembership, ProjectMeta } from '../shared/types';
import { GitHubError, type GitHubClient } from './github';
import { t } from '../shared/i18n';
import { readMembership, type GqlFieldValue } from './fetchSources';
import { CREATED_ITEM_BOARDS_QUERY, PROJECT_WORKFLOWS_QUERY } from './queries';

/**
 * When the boards are looked at, in ms after the issue was created (the last look ends the
 * search), and how long after each write it is checked (`verifyMs`, at most `verifyTries`
 * reads). A check runs even after the last look: the longest watch is ~180 s + 3 × 15 s.
 */
export const WATCH_LOOKS_MS = [5_000, 15_000, 30_000, 60_000, 120_000, 180_000];
export const WATCH_VERIFY_MS = 15_000;
export const WATCH_VERIFY_TRIES = 3;

/** What one board says about the new issue right now. */
export type BoardSighting =
  | { state: 'absent' }
  | { state: 'on'; itemId: string; membership: ProjectMembership }
  /** the answer does not tell (not every Project item / field value was listed) */
  | { state: 'unknown' };

export type WatchVerdict = 'write' | 'done' | 'human';

/** The value a watch entry is about, as it stands on the board (null = empty). */
export function watchedValue(w: Pick<CreateWatch, 'iterationId'>, m: ProjectMembership): { id: string | null; text: string | null } {
  if (w.iterationId !== null) return { id: m.iteration?.id ?? null, text: m.iteration ? m.iteration.title : null };
  return { id: m.status, text: m.status };
}

/** The one rule: empty → write; the group's value → done; anything else → a person decides. */
export function judgeWatch(w: Pick<CreateWatch, 'iterationId' | 'status'>, m: ProjectMembership): WatchVerdict {
  const cur = watchedValue(w, m).id;
  const want = w.iterationId ?? w.status;
  if (cur === want) return 'done';
  if (cur === null) return 'write';
  return 'human';
}

interface GqlWatchItem {
  id: string;
  isArchived: boolean;
  project: { id: string } | null;
  fieldValues: { totalCount?: number; nodes: GqlFieldValue[] } | null;
}

/**
 * Where the new issue (`nodeId`) is, on each of `boards`. Throws when GitHub could not be read
 * or did not answer with the issue. A board missing from a complete answer is `absent`; from an
 * incomplete one, `unknown`. An archived item counts as not there (the board does not show it).
 */
export async function readCreatedBoards(client: GitHubClient, nodeId: string, boards: ProjectMeta[]): Promise<Map<string, BoardSighting>> {
  const data = await client.graphql<{ node: { projectItems?: { totalCount?: number; nodes?: GqlWatchItem[] } } | null }>(CREATED_ITEM_BOARDS_QUERY, { id: nodeId });
  const conn = data.node?.projectItems;
  if (!conn || !Array.isArray(conn.nodes) || typeof conn.totalCount !== 'number') throw new GitHubError('graphql', t('GitHub 的回应里没有这条 issue 所在的看板'));
  const complete = conn.totalCount <= conn.nodes.length;
  const out = new Map<string, BoardSighting>();
  for (const p of boards) {
    const pi = conn.nodes.find((n) => n?.project?.id === p.projectId);
    if (!pi) {
      out.set(p.key, complete ? { state: 'absent' } : { state: 'unknown' });
      continue;
    }
    if (pi.isArchived) {
      out.set(p.key, { state: 'absent' });
      continue;
    }
    const fv = pi.fieldValues;
    if (!fv || !Array.isArray(fv.nodes) || typeof fv.totalCount !== 'number' || fv.totalCount > fv.nodes.length) {
      out.set(p.key, { state: 'unknown' });
      continue;
    }
    out.set(p.key, { state: 'on', itemId: pi.id, membership: readMembership(p, pi.id, fv.nodes) });
  }
  return out;
}

/**
 * Is this board's auto-add surely off? `true` only when GitHub listed every workflow, at least
 * one of them is an auto-add one, and none of those is enabled. Anything else (not readable, a
 * list cut short, no workflow by that name) is unknown → the board is still watched.
 */
export async function autoAddSurelyOff(client: GitHubClient, p: ProjectMeta): Promise<boolean> {
  try {
    const d = await client.graphql<{ node: { workflows?: { totalCount?: number; nodes?: { name?: unknown; enabled?: unknown }[] } } | null }>(PROJECT_WORKFLOWS_QUERY, { id: p.projectId });
    const wf = d.node?.workflows;
    if (!wf || !Array.isArray(wf.nodes) || typeof wf.totalCount !== 'number' || wf.totalCount > wf.nodes.length) return false;
    const auto = wf.nodes.filter((n) => typeof n?.name === 'string' && /^auto-add/i.test(n.name));
    if (!auto.length || auto.some((n) => typeof n.enabled !== 'boolean')) return false;
    return auto.every((n) => n.enabled === false);
  } catch {
    return false;
  }
}

/** The notice's words for one board that is not (or not surely) finished; null = nothing to say. */
export function watchProblem(w: CreateWatch): string | null {
  const iter = w.iterationId !== null;
  const p = { board: w.title, label: w.label };
  switch (w.state) {
    case 'human': {
      const seen = w.seen ?? t('空');
      return iter
        ? t('看板「{board}」自动收进了这条，迭代是「{seen}」，没有自动改成「{label}」', { ...p, seen })
        : t('看板「{board}」自动收进了这条，状态是「{seen}」，没有自动改成「{label}」', { ...p, seen });
    }
    case 'failed': {
      const why = w.reason ?? t('未知原因');
      return iter
        ? t('看板「{board}」自动收进了这条，没能把迭代设成「{label}」（{why}）', { ...p, why })
        : t('看板「{board}」自动收进了这条，没能把状态设成「{label}」（{why}）', { ...p, why });
    }
    case 'unverified': {
      const why = w.reason ?? t('读不到');
      return iter
        ? t('看板「{board}」上已把迭代设成「{label}」，没能确认最后是否保持（{why}）', { ...p, why })
        : t('看板「{board}」上已把状态设成「{label}」，没能确认最后是否保持（{why}）', { ...p, why });
    }
    case 'unread': {
      const why = w.reason ?? t('读不到');
      return iter
        ? t('读不到这条在不在看板「{board}」上（{why}），没能确认是否需要补设迭代', { board: w.title, why })
        : t('读不到这条在不在看板「{board}」上（{why}），没能确认是否需要补设状态', { board: w.title, why });
    }
    default:
      return null;
  }
}

/** Still being looked at or checked: the job is not finished yet. */
export function watchActive(w: CreateWatch): boolean {
  return w.state === 'looking' || w.state === 'written';
}
