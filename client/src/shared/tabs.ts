// Detail tabs (GitHub#397): the board is the fixed "home" tab, every opened issue / PR is a tab of
// its own. The rules live here, pure — shared by the controller (which keeps the list, on this
// machine) and the window (which draws it): what a tab carries, which status its icon shows, when
// an item that no complete source read carries is checked by itself, and how the list changes.

import type { IssueStateReason, Item, ItemKind, ItemState, SourceStatus } from './types';

/** What a tab shows of its item without opening it. */
export interface TabSummary {
  key: string;
  repo: string;
  number: number;
  kind: ItemKind;
  title: string;
  url: string;
  state: ItemState;
  stateReason: IssueStateReason | null;
  isDraft: boolean | null;
  /** label names (the status only needs the names) */
  labels: string[];
  updatedAt: string;
}

export interface TabInfo {
  key: string;
  /** the newest copy known: the board's, or the item's own check when no complete read carries it */
  item: TabSummary;
  /** the item's `updatedAt` when the tab was last looked at; null = never yet (opened in the background) */
  seen: string | null;
  /** a source read completely in this run carries the item: its icon follows the sync rounds */
  listed: boolean;
}

export function summarize(it: Item): TabSummary {
  return {
    key: it.key,
    repo: it.repo,
    number: it.number,
    kind: it.kind,
    title: it.title,
    url: it.url,
    state: it.state,
    stateReason: it.stateReason ?? null,
    isDraft: it.isDraft ?? null,
    labels: it.labels.map((l) => l.name),
    updatedAt: it.updatedAt,
  };
}

/**
 * The one status of a tab, in this order: ended (merged / closed, by GitHub's own state) →
 * waiting for a human → an agent is working on it → open.
 */
export type TabStatus = 'merged' | 'closed' | 'done' | 'skipped' | 'waiting' | 'running' | 'draft' | 'open';

/** The two label names the status reads; '' = that status is never shown. */
export interface TabLabels {
  /** "waiting for a human" — the same setting the reminders use */
  human: string;
  /** "an agent is working on it" */
  doing: string;
}

/** GitHub label names are case-insensitive. */
function carries(labels: string[], name: string): boolean {
  const want = name.trim().toLowerCase();
  return want !== '' && labels.some((l) => l.toLowerCase() === want);
}

export function tabStatus(it: Pick<TabSummary, 'kind' | 'state' | 'stateReason' | 'isDraft' | 'labels'>, labels: TabLabels): TabStatus {
  if (it.kind === 'pr' && it.state === 'merged') return 'merged';
  if (it.kind === 'pr' && it.state === 'closed') return 'closed';
  if (it.state !== 'open') return it.stateReason === 'not_planned' || it.stateReason === 'duplicate' ? 'skipped' : 'done';
  if (carries(it.labels, labels.human)) return 'waiting';
  if (carries(it.labels, labels.doing)) return 'running';
  return it.kind === 'pr' && it.isDraft === true ? 'draft' : 'open';
}

export const TAB_STATUS_TEXT: Record<TabStatus, string> = {
  merged: '已合并',
  closed: '已关闭（没合并）',
  done: '已关闭（完成）',
  skipped: '已关闭（不做 / 重复）',
  waiting: '等待人处理',
  running: '正在运行',
  draft: '草稿',
  open: '打开',
};

/** The label an agent's work in progress carries, unless Settings says otherwise. */
export const DEFAULT_DOING_LABEL = 'doing/agent';

/** Whatever was saved: a string (trimmed; '' = never show "running"), anything else is the default. */
export function normalizeDoingLabel(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : DEFAULT_DOING_LABEL;
}

/** A tab that was not looked at since its item changed (the blue dot). Never on the tab in front. */
export function tabUnread(t: Pick<TabInfo, 'seen' | 'item'>, active: boolean): boolean {
  return !active && t.seen !== null && t.seen !== t.item.updatedAt;
}

/**
 * Does a source read completely in this run carry the item? Only then do the sync rounds keep it
 * fresh; a source that failed (and kept its cache), was removed, or no longer lists the item does not.
 */
export function listedNow(item: Pick<Item, 'sources'> | null, sources: SourceStatus[]): boolean {
  if (!item) return false;
  return sources.some((st) => st.ok && st.dataFrom !== null && item.sources.includes(st.sourceKey));
}

/** An ended item changes rarely: it is checked this often (an open one with every sync round). */
export const ENDED_CHECK_MS = 10 * 60_000;

/**
 * Is an item no complete read carries due for its own check? `checkedAt` = when its last check
 * answered (null = never in this run; a failed check does not count, so it is tried again with the
 * next round). `force`: somebody asked (the tab came to the front, refresh, sync now).
 * Never "ended, so never again": a closed item is reopened and commented on (plan review round 1).
 */
export function tabCheckDue(state: ItemState, checkedAt: number | null, now: number, force = false): boolean {
  if (force || checkedAt === null || state === 'open') return true;
  return now - checkedAt >= ENDED_CHECK_MS;
}

/** The newest of the copies known of an item no complete read carries (ISO times compare as text). */
export function newestCopy<T extends { updatedAt: string }>(copies: (T | null | undefined)[]): T | null {
  let best: T | null = null;
  for (const c of copies) if (c && (best === null || c.updatedAt > best.updatedAt)) best = c;
  return best;
}

// ---- the list ---------------------------------------------------------------------------

/** What is kept on this machine: the tabs in order, each with what it last showed. */
export type StoredTab = Pick<TabInfo, 'key' | 'item' | 'seen'>;

const KINDS: ItemKind[] = ['issue', 'pr'];
const STATES: ItemState[] = ['open', 'closed', 'merged'];

function validSummary(v: unknown): v is TabSummary {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s.key === 'string' &&
    s.key !== '' &&
    typeof s.repo === 'string' &&
    typeof s.number === 'number' &&
    Number.isInteger(s.number) &&
    KINDS.includes(s.kind as ItemKind) &&
    typeof s.title === 'string' &&
    typeof s.url === 'string' &&
    STATES.includes(s.state as ItemState) &&
    (s.stateReason === null || typeof s.stateReason === 'string') &&
    (s.isDraft === null || typeof s.isDraft === 'boolean') &&
    Array.isArray(s.labels) &&
    s.labels.every((l) => typeof l === 'string') &&
    typeof s.updatedAt === 'string'
  );
}

/** Whatever was saved: the valid tabs, one per item, in order; anything else is dropped. */
export function normalizeTabs(raw: unknown): StoredTab[] {
  if (!Array.isArray(raw)) return [];
  const out: StoredTab[] = [];
  for (const v of raw) {
    if (typeof v !== 'object' || v === null) continue;
    const t = v as Record<string, unknown>;
    if (!validSummary(t.item) || t.key !== t.item.key || out.some((x) => x.key === t.key)) continue;
    out.push({ key: t.item.key, item: t.item, seen: typeof t.seen === 'string' ? t.seen : null });
  }
  return out;
}

/** Move `key` so that it ends up at position `to` of the list; unknown input changes nothing. */
export function moveTab<T extends { key: string }>(list: T[], key: unknown, to: unknown): T[] {
  const from = list.findIndex((t) => t.key === key);
  if (from < 0 || typeof to !== 'number' || !Number.isInteger(to)) return list;
  const at = Math.max(0, Math.min(list.length - 1, to));
  if (at === from) return list;
  const next = list.filter((_, i) => i !== from);
  next.splice(at, 0, list[from]);
  return next;
}

/** The tab in front: the home tab (the board) or an item's key. */
export const HOME = 'home';

/** Which tab comes to the front when `closing` goes: its right neighbour, else its left one, else home. */
export function afterClose(keys: string[], closing: string, active: string): string {
  if (active !== closing) return active;
  const i = keys.indexOf(closing);
  if (i < 0) return active;
  return keys[i + 1] ?? keys[i - 1] ?? HOME;
}

/** The next (`by` = 1) or previous (-1) tab, home included, going round. */
export function stepTab(keys: string[], active: string, by: 1 | -1): string {
  const all = [HOME, ...keys];
  const i = Math.max(0, all.indexOf(active));
  return all[(i + by + all.length) % all.length];
}
