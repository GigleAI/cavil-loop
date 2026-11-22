// Detail tabs (GitHub#397): the board is the fixed "home" tab, every opened issue / PR is a tab of
// its own. The rules live here, pure — shared by the controller (which keeps the list, on this
// machine) and the window (which draws it): what a tab carries, which status its icon shows, when
// an item that no complete source read carries is checked by itself, and how the list changes.

// ── The client's detail tabs: rules moved from the root AGENTS.md (GitHub#658); read before changing ──
// The client's detail tabs (GitHub#397: `client/src/shared/tabs.ts` — the one place that decides a
// tab's status icon, when an item no complete read carries is checked by itself, and how the list
// changes — the `tab*` block in `client/src/app/controller.ts`, `App.tsx` / `TabBar.tsx`, the macOS
// menu's ⌘W in `client/src-tauri/src/main.rs` + `desktop::close_key`; GitHub#442: the floating panel
// as the default way to open an item — `openItem` in `App.tsx`, the `float` mode of `DetailPanel.tsx`,
// `outsideClick.ts`, `panelWidth.ts`, the right-click menu `OpenMenu.tsx`, ⌘1…⌘9 = `tabAt` in
// `tabs.ts`, the layouts on ⌘⇧1/2/3 in `shortcuts.ts`) → `cd client && npx vitest run
// test/unit/tabs.test.ts test/unit/tabs-controller.test.ts test/unit/shortcuts.test.ts
// test/unit/outsideClick.test.ts && npm run test:e2e -- tabs` (the controller file ~45 s: real back
// end, fake GitHub, a clock moved by hand). The board is the fixed home tab and stays mounted behind a
// detail tab; only the tab in front has its detail mounted, and what it holds unsent is kept per tab
// in `App.tsx` — never put a draft back into the detail's own state alone. A plain click opens the
// floating panel over the board (it belongs to the home tab: drawn only while home is in front, its
// unsent text kept in `App.tsx` too); ⌘ / Ctrl + click a tab in front, the middle button a tab behind;
// an item that already has a tab goes to that tab — one item never has two reply boxes. The tab bar is
// drawn only while a tab is open. A digit shortcut is matched by the physical key (`code`), never by
// what Shift / ⌥ / the layout turn it into; macOS keeps ⌘⇧3 for its screenshot, hence the macOS-only
// ⌥⌘1/2/3. The discussion frame forwards the key position (`code`) exactly as it got it — a digit's,
// another key's, or none (`''`) — and `frameKey` judges it with the window's own `matches`; never drop
// a position that is not a digit and fall back to the character (code review round 2: a non-digit key
// typing "1" then picked a tab from the discussion only). The frame sends `key` raw, named keys
// included (Ctrl + number pad 1 reports `End` on `Numpad1` — round 3), and its pre-filter is only a
// candidate check with the same digit rule; the one decision is the window's. `tabs.spec.ts` sends one
// matrix of event shapes and real presses to both places and compares the tab that ends up in front.
// ⌘R in a detail tab is that detail's refresh button (`refreshHere`), on the home tab still "sync
// now". An item a source read completely in this run carries follows the sync rounds with no request
// of its own; any other is read by itself for as long as its tab is open — open: every round, ended:
// every 10 minutes — and **never "it ended, so stop reading"** (plan review round 1: a closed item is
// reopened and commented on). A check that fails leaves the tab as it was and is due again with the
// next round: "could not read" is neither "closed" nor "unchanged". The menu code is built on every
// system so that Linux compiles it, but only a Mac runs it: after changing it, press ⌘W on a Mac by
// hand (a detail tab in front closes; on the home tab the window hides)
//

import type { IssueStateReason, Item, ItemKind, ItemState, SourceStatus } from './types';
import type { OpRecord } from './ops';
import { zhKey } from './i18n';

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
  /**
   * When the item's own check last answered (epoch ms; null = never in this run, or `listed`). For an
   * item no complete read carries this is what a sync round is for a listed one: news that a fresh read
   * landed — even with the item's `updatedAt` unchanged (a PR's checks finish without moving it).
   */
  checkedAt: number | null;
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
 * waiting for a human → waiting for a prerequisite (GitHub#443) → an agent is working on it → open.
 */
export type TabStatus = 'merged' | 'closed' | 'done' | 'skipped' | 'waiting' | 'blocked' | 'running' | 'draft' | 'open';

/** The two label names the status reads; '' = that status is never shown. */
export interface TabLabels {
  /** "waiting for a human" — the same setting the reminders use */
  human: string;
  /** "an agent is working on it" — the "running" label of Settings (GitHub#404), the one the top bar counts */
  doing: string;
  /**
   * "waiting for a prerequisite" (GitHub#443) — the waiting label of Settings (`handBack.blocked`, default
   * `pending/blocked`), the same one the dependency graph and the "等前置…" button use. Only the label
   * counts, never GitHub's own "Blocked by": the icon shows where the loop's flow is.
   */
  blocked: string;
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
  // the daemon swaps the running label for the waiting one: both on is only the moment of that swap
  if (carries(it.labels, labels.blocked)) return 'blocked';
  if (carries(it.labels, labels.doing)) return 'running';
  return it.kind === 'pr' && it.isDraft === true ? 'draft' : 'open';
}

export const TAB_STATUS_TEXT: Record<TabStatus, string> = {
  merged: zhKey('已合并'),
  closed: zhKey('已关闭（没合并）'),
  done: zhKey('已关闭（完成）'),
  skipped: zhKey('已关闭（不做 / 重复）'),
  waiting: zhKey('等待人处理'),
  blocked: zhKey('等前置完成'),
  running: zhKey('正在运行'),
  draft: zhKey('草稿'),
  open: zhKey('打开'),
};

/** A tab that was not looked at since its item changed (the blue dot). Never on the tab in front. */
export function tabUnread(t: Pick<TabInfo, 'seen' | 'item'>, active: boolean): boolean {
  return !active && t.seen !== null && t.seen !== t.item.updatedAt;
}

/**
 * The newest complete read, this session, of a source that carries `item`;
 * null = none of its sources has been read completely (or the item is not on
 * the board). A source keeps its old snapshot when a read fails, so only a
 * status that says ok counts: another source succeeding, or this one failing
 * and keeping its cache, never looks like fresh data of this item.
 */
export function freshMark(item: Pick<Item, 'sources'> | null, sources: SourceStatus[]): number | null {
  if (!item) return null;
  let mark: number | null = null;
  for (const st of sources)
    if (st.ok && st.dataFrom !== null && item.sources.includes(st.sourceKey) && (mark === null || st.dataFrom > mark)) mark = st.dataFrom;
  return mark;
}

/**
 * Do the sync rounds keep the item fresh — does a source read completely in this run carry it? A
 * source that failed (and kept its cache), was removed, or no longer lists the item does not.
 * The same question as `freshMark`, so the same answer.
 */
export function listedNow(item: Pick<Item, 'sources'> | null, sources: SourceStatus[]): boolean {
  return freshMark(item, sources) !== null;
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

// ---- GitHub#447: a close made in a detail puts that detail away ----------------------------

/**
 * What a close (issue or PR) started in a detail means for the place it was started in — a tab, or
 * one opening of the floating panel — now:
 * - `close`: GitHub took the close (its answer, or the app's own check proved it later): put it away;
 * - `hold`: it went through, but the place holds text not sent yet: it stays (and says why) — typed
 *   text is never dropped without asking;
 * - `wait`: no answer yet, or the answer was lost and may still be proven: ask again on the next change;
 * - `drop`: nothing to do, ever — not a close, refused / not sent, unlocked by hand, the record is
 *   gone, or the place is not there any more (the tab was closed, the panel shows another opening).
 */
export type AutoCloseVerdict = 'close' | 'hold' | 'wait' | 'drop';

/** The one rule, for tabs and the floating panel alike. `place`: is the place still there, does it hold unsent text. */
// ── The tab / floating panel put away after an action started from it: rules moved from the root AGENTS.md (GitHub#658); read before changing ──
// The tab / floating panel put away after an action started from it (GitHub#447: a close, once GitHub
// took it — `autoCloseVerdict`; GitHub#633: 交给 agent / 托管, as soon as the client accepted it, no
// waiting for GitHub, the maintainer's choice in #633 — `handOffCloseVerdict`; both in
// `client/src/shared/tabs.ts`, one registration path in `App.tsx`: `closeStarted` / `settleCloses`,
// keyed by the opening it came from) → `cd client && npx vitest run test/unit/tabs.test.ts &&
// CAVIL_E2E_ENGINE=chromium npm run test:e2e -- tabs --grep 'GitHub#447|GitHub#633'`. Only the opening
// an action came from is put away (a tab: the same life, in front or behind; the panel: the same
// opening); while it holds text not sent it stays with one line saying why (`HeldLine`, worded per
// action). A hand-over's reply text moves into the operation: which reply is "the one that went with
// it" is decided by the reply box's draft number (`nextReplyDraft`, one sequence for the window, kept
// in `TabDraft.replyVer`), never by comparing words — the box emptied and the same words typed again
// is a new draft (`replyLeftAfterHandOff`). The detail reports an accepted hand-over even when it is
// no longer mounted (another tab came forward before the client answered) and reports nothing else:
// the window drops exactly that draft from the place's kept draft (`dropSentReply`); inside a detail —
// the opening that sent it, or one mounted again from the kept draft and told through `droppedReplies`
// — the draft leaves through one function, `dropSentReplyHere`, which also takes everything hanging
// off the box (the preview and a preview request still on its way, the pasted-image line, the Esc
// note, the kept-comment link) — never clear the words in one place and the derived state in another
// (round 3: a remounted detail emptied the box and left the sent words' preview with no button to put
// it away); then judges "text not sent" on that kept draft as it is now with the same `place` as a
// close — never on the detail's own view, which may be an unmounted one: a draft revived in a tab sent
// the same comment twice (PR #638 code review round 1), and new words typed after coming back to the
// tab were closed away with it (round 2). A refusal before anything was sent leaves the detail and its
// text as they were
//
export function autoCloseVerdict(r: Pick<OpRecord, 'kind' | 'steps' | 'running' | 'unlocked'> | null | undefined, place: { present: boolean; dirty: boolean }): AutoCloseVerdict {
  if (!r || (r.kind !== 'closeIssue' && r.kind !== 'closePr') || !place.present) return 'drop';
  const s = r.steps[0];
  if (!s || s.name !== 'close') return 'drop';
  if (s.state === 'ok') return place.dirty ? 'hold' : 'close';
  if (r.unlocked) return 'drop';
  // created, its request not marked sent yet: on its way (as the notice says it)
  if (s.state === 'pending' || s.state === 'unknown' || (s.state === 'unsent' && r.running)) return 'wait';
  return 'drop';
}

/** GitHub#633: what put a place away (or kept it, with the line saying why) — a close, or a hand-over to the agent */
export type AutoCloseKind = 'close' | 'handBack' | 'autopilot';

/**
 * GitHub#633: "交给 agent" / "托管" started from a tab or the floating panel put it away as soon as the
 * client accepted the operation (the maintainer's choice in #633: no waiting for GitHub — its result,
 * success or failure, is said in the window's notice area, where a failure is retried). Only the
 * opening it was started from (`present`); kept, with the line saying why, while it holds text not
 * sent (`dirty` — judged by the panel at acceptance, without the reply text that went with the operation).
 */
export function handOffCloseVerdict(place: { present: boolean; dirty: boolean }): Exclude<AutoCloseVerdict, 'wait'> {
  if (!place.present) return 'drop';
  return place.dirty ? 'hold' : 'close';
}

/**
 * GitHub#633: the reply text still unsent once a hand-over was accepted. `sent` is the number of the reply
 * box's draft that went with the operation (null: none did — no reply text, or a kept comment of another
 * operation went instead); `now` is the box's draft number and text at this moment. Told apart by the
 * number, never by the words: the box emptied and the same words typed again is a new draft and stays.
 */
export function replyLeftAfterHandOff(sent: number | null, now: { n: number; text: string }): string {
  return sent !== null && now.n === sent ? '' : now.text;
}

/** The next (`by` = 1) or previous (-1) tab, home included, going round. */
export function stepTab(keys: string[], active: string, by: 1 | -1): string {
  const all = [HOME, ...keys];
  const i = Math.max(0, all.indexOf(active));
  return all[(i + by + all.length) % all.length];
}

/**
 * ⌘1 … ⌘9 (GitHub#442), as in a browser: `n` counts from the left, the home tab being 1; 9 is always
 * the last tab. null = no such tab (the key does nothing then).
 */
export function tabAt(keys: string[], n: number): string | null {
  if (!Number.isInteger(n) || n < 1 || n > 9) return null;
  const all = [HOME, ...keys];
  if (n === 9) return all[all.length - 1];
  return all[n - 1] ?? null;
}
