// App logic between the window and GitHub: login state, settings, sync
// rounds, cache. It runs in the window and never holds the GitHub credential:
// signing in, refreshing, signing out and every request that needs the
// credential go through the back end (src-tauri/crates/core, Rust), which
// signs requests for a session it names. No Electron / Tauri / Node imports —
// the unit tests drive it against the fake GitHub with the real Rust back end
// as a child process.

import { APP_KINDS, DEFAULT_HAND_BACK, type AppKind, type AppState, type BoardData, type CreateBoard, type CreateJob, type CreateWatch, type HandBackLabels, type Item, type ShortcutKeyResult, type ShortcutKeySpec, type ProjectChoices, type ProjectMeta, type SourceConfig, type SourceSnapshot, type SourceStatus, type SourceTimes, type TallyDef, type ViewSettings } from '../shared/types';
import { normalizeTallies, TALLIES_SETTING } from '../shared/tallies';
import { ISSUE_CLOSE_REASONS, type DetailResult, type ItemDetail, type RepoOptions, type WriteAction, type WriteResult } from '../shared/actions';
import { isValidView, normalizeView, type ViewPatch } from '../shared/viewSettings';
import { normalizeMergePrefs, rememberMergeMethod } from '../shared/mergePrefs';
import { readSaid, t, tKey, zhKey, DEFAULT_LANG_SETTING, LANG_SETTING, normalizeLangSetting, preferredLanguages, resolveLang, setLang, type Lang, type Said } from '../shared/i18n';
import { normalizeAutopilotConfirm, normalizeClearAllOnActivate, normalizeLaneFolds, normalizeNotifyScope, normalizeTableFolds, setFold, setLaneFold } from '../shared/uiPrefs';
import { normalizeRepoOrder, reorderRepos } from '../shared/repoOrder';
import { changeKey, repairKeys, type CustomKeys } from '../renderer/shortcuts';
import { normalizeHandoff, type Handoff } from '../shared/handoff';
import { importView, pickView } from '../shared/viewImport';
import { itemKey, parseSource, sourceLabel } from '../shared/sources';
import { listedNow, moveTab, newestCopy, normalizeTabs, summarize, tabCheckDue, type StoredTab, type TabInfo, type TabSummary } from '../shared/tabs';
import { countRepos, type BoardRepoCount } from '../data/newIssueBoards';
import { clientIdKindProblem } from '../shared/appKind';
import { DEFAULT_GITHUB_APP_CLIENT_ID, DEFAULT_OAUTH_CLIENT_ID, FOLLOW_UP_SYNC_MS, SYNC_INTERVAL_MS } from '../shared/config';
import { Endpoints, GitHubClient, READ_RETRY_DELAYS_MS, ReadGate, backoffStep } from '../data/github';
import { mergeSnapshots } from '../data/merge';
import { syncRound } from '../data/sync';
import { FULL_READ_EVERY_MS, type SourceCheck } from '../data/changeCheck';
import { writesEnabled } from '../data/board';
import { ActionRefused, CreateUnanswered, addLabel, closeStep, commentStep, createBoard, explainError, joinCreatedIssue, listRepoOptions, mergeStep, performAction, prepareSend, readItemRecords, readItemSnapshot, readSendEvidence, refusedForSure, relatedIssues, removeLabel, setCreatedField } from '../data/actions';
import { WATCH_LOOKS_MS, WATCH_VERIFY_MS, WATCH_VERIFY_TRIES, autoAddSurelyOff, judgeWatch, readCreatedBoards, watchActive, watchedValue, watchProblem, type BoardSighting } from '../data/autoJoin';
import {
  OP_AUTO_MS,
  OP_CHECK_DELAYS_MS,
  STUCK_MS,
  finishSteps,
  isOpKind,
  isOpRecord,
  needsRecords,
  opAfterRestart,
  opApplyRead,
  opCheckSteps,
  opDisposable,
  opLockOf,
  opNextAuto,
  opPermit,
  opPhase,
  opProveFromRecords,
  opProveFromSnapshot,
  opResendStep,
  opText,
  opWithoutStale,
  type OpKind,
  type OpRecord,
  type OpSnapshot,
  type OpStep,
} from '../shared/ops';
import { fetchRawDetail, toDetail } from '../data/detail';
import { isSameTextMark, sameTextUnclear, type SameTextMark, isSendRecord, sendAfterRestart, sendDisposable, sendHolds, sendProve, sendQuiet, sendSlot, type SendAction, type SendRecord } from '../shared/sends';
import { addBlockedBy, postComment, readBlocked, readCandidate, readComments, readOpenCandidates, searchCandidates, type Candidate } from '../data/blocked';
import {
  DEFAULT_BLOCKED_LABELS,
  applyDone,
  confirmBlock,
  entryState,
  factsDiffer,
  factsOf,
  fingerprint,
  isOpComment,
  layerRows,
  latestRefs,
  lostRefs,
  markComment,
  parseRefQuery,
  planBlocked,
  rankByNumber,
  refKey,
  repauseAllowed,
  settledOf,
  type BlockedLabels,
  type BlockedRead,
  type Facts,
  type NumberSettled,
  type Pick as BlockedPick,
  type Ref,
} from '../shared/blocked';
import type { BlockedStart, BlockedStartResult, BlockedView, BlockedRefInfo } from '../shared/ipc';
import { applyFreshItem, fetchItem, freshKey, freshViews, type FreshItem } from '../data/itemRefresh';
import { contentToItem } from '../data/fetchSources';
import {
  MAX_EDITS,
  OBSERVE_FIRST_MS,
  OBSERVE_MS,
  afterRestart,
  applyAnswer,
  applyRead,
  applyReadFailure,
  editStatus,
  fieldId,
  fieldValue,
  isEditRecord,
  latestStamp,
  markSent,
  overlayItem,
  startEdit,
  type EditField,
  type EditRecord,
  type EditValue,
} from '../data/edits';
import { GitHubError } from '../data/github';
import { fetchReleaseImage } from '../data/releaseImage';
import { readProjectChoices } from '../data/projectChoices';
import { parseReleaseImage, type ImageResult } from '../shared/images';
import { proxyFetch, type Backend, type BackendInit, type FreshOut, type FreshResult, type GrantInfo } from '../backend/backend';
import { PendingTracker, itemAlertText } from '../data/pending';
import type { Alert, Delivery, Desktop, DesktopEvent, UpdateStatus } from './desktop';
import type { WindowFrame } from '../shared/ipc';

/** sign-out reasons (keys: shown through tKey in the window's language) */
export const REASON_REVOKED = zhKey('GitHub 凭据已失效（可能被撤销或已过期），请重新登录');
export const REASON_REFRESH_ENDED = zhKey('登录已到期，GitHub 不再接受续期，请重新登录');
/** the back end refreshes this long before the access token expires (src-tauri/crates/core/src/engine.rs) */
/**
 * GitHub#270: the one way the offline flag is written. The flag and its reason travel together,
 * and "not offline" never keeps a reason — whichever way the round left offline (GitHub answered
 * with an error, the refresh failed for another reason, everything worked).
 */
export function offlineFields(offline: boolean, reason: string | null): { offline: boolean; offlineReason: string | null } {
  return { offline, offlineReason: offline ? reason || null : null };
}

export const REFRESH_MARGIN_MS = 5 * 60_000;
/** GitHub#374: a source waiting to be read again is read by a round that starts at most this much before its time */
export const RETRY_SLACK_MS = 10_000;

/** What a queued notification was decided on (see Controller.noticeContext). */
interface NoticeContext {
  label: number;
  sources: (readonly [string, number])[];
}

/** GitHub#324: what the sync beat and its alarm need of a clock */
export interface SyncTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const REAL_TIMERS: SyncTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

export interface ControllerDeps {
  backend: Backend;
  endpoints: Endpoints;
  now?: () => number;
  syncIntervalMs?: number;
  /**
   * GitHub#324: after a stretch of syncing that ran over a beat, a timed round starts no sooner
   * than this long after it ended. Default: the beat's own interval (what the shell says with its beat, else `syncIntervalMs`).
   */
  syncGapMs?: number;
  /** GitHub#324: the timers behind the window's beat and the alarm of a timed round (tests: a clock moved by hand) */
  timers?: SyncTimers;
  /** how long after the last successful change one more sync round runs (tests shorten / lengthen it) */
  followUpSyncMs?: number;
  /**
   * GitHub#261: each source is read in full at least this often; in between, a round whose change
   * check finds nothing changed keeps the previous snapshot. 0 = no change check (every round reads
   * every source in full). Default FULL_READ_EVERY_MS.
   */
  fullReadEveryMs?: number;
  /**
   * GitHub#374: the sync asks a read that failed for a temporary reason again after each of these
   * waits (default READ_RETRY_DELAYS_MS); [] = never. Tests shorten them.
   */
  readRetryDelaysMs?: number[];
  /** tests only: a round's read is in and its change-check records were dealt with (`dropped`: the round had been given up on) */
  afterRoundRead?: (dropped: boolean) => void;
  /** built-in OAuth Client ID (tests inject their own; production uses the constant) */
  defaultClientId?: string;
  /** built-in GitHub App Client ID ('' = none, which is production today) */
  defaultGithubAppClientId?: string;
  /** notifications, Dock badge, launch at login, sync beat (none: nothing is shown, the counting still runs) */
  desktop?: Desktop;
  /** GitHub#471: the system's preferred languages, for "跟随系统" (tests simulate a system; default: the window's) */
  languages?: () => readonly string[];
  /** GitHub#229: how long an older unanswered change is watched for, and the first re-read of it (tests shorten them) */
  observeMs?: number;
  observeFirstMs?: number;
  /** GitHub#250: how long a succeeded operation waits for its re-read before the manual unlock is offered (tests shorten it) */
  opStuckMs?: number;
  /** GitHub#359: the automatic checks of a step whose answer never came, after the one made at once (tests shorten them; [] = that one only) */
  opCheckDelaysMs?: readonly number[];
  /** GitHub#359: how long after its start an operation may still send its remaining steps by itself (tests shorten it) */
  opAutoMs?: number;
  /** GitHub#258: when the boards not ticked are looked at after a create (ms after it), and the check after a write (tests shorten them) */
  watchLooksMs?: number[];
  watchVerifyMs?: number;
}

/** GitHub#229: the row of the snapshot table that holds the changes not yet confirmed (not a source). */
export const EDITS_KEY = '__edits__';
/** GitHub#250: the row of the snapshot table that holds the close / merge / autopilot / hand-back operations (not a source). */
export const OPS_KEY = '__ops__';
/** GitHub#489: the row of the snapshot table that holds the replies / edits / ticked boxes (shared/sends.ts; not a source). */
export const SENDS_KEY = '__sends__';
/** GitHub#250: the operations started from the window: one action of one of the five kinds */
export type OpAction = Extract<WriteAction, { kind: OpKind }>;
/** GitHub#229: how many item details are kept for a fast re-open (this run only, never on disk). */
export const DETAIL_CACHE_SIZE = 50;
/** GitHub#395: release attachment images fetched at once, and how much of them is kept (characters of data: addresses, ~36 MB of files) */
export const IMAGE_FETCHES = 4;
export const IMAGE_CACHE_CHARS = 48 * 1024 * 1024;
/** GitHub#328: how many of one round's newly pending items have their detail read ahead (the rest is read when opened). */
export const PREFETCH_PER_ROUND = 10;

/**
 * GitHub#229: what the notice of a created issue says, from every board it is still not
 * finished on (code review rounds 2–3: one list kept across retries; a joined board never
 * hides a field that failed on it, a later retry of another board never drops it). null =
 * nothing left: the notice goes.
 */
export function createNotice(number: number, boards: CreateBoard[], labelsNote = '', watch: CreateWatch[] = []): string | null {
  const missing = boards.filter((b) => b.state === 'missing');
  const fields = boards.filter((b) => b.state === 'fieldsFailed');
  const parts: string[] = [];
  // GitHub#245: labels GitHub dropped come first — the issue may not be handed to the agent at all
  if (labelsNote) parts.push(labelsNote);
  if (missing.length) parts.push(`没能加入看板 ${missing.map((b) => `「${b.title}」（${b.reason}）`).join('、')}`);
  if (fields.length) parts.push(`已加入看板但字段没设上 ${fields.map((b) => `「${b.title}」（${b.reason}）`).join('、')}，请在详情里手动设置`);
  // GitHub#258: boards not ticked that took it in by themselves and were not (surely) set
  for (const w of watch) {
    const t = watchProblem(w);
    if (t) parts.push(t);
  }
  return parts.length ? `issue #${number} 已建好，但${parts.join('；')}` : null;
}

/**
 * After a retry of the missing boards: each board the retry worked on takes its new state
 * (joined and set → gone; joined, field refused → fieldsFailed; still refused → missing with
 * the new reason); every other board keeps what it had.
 */
export function mergeRetry(boards: CreateBoard[], results: Map<string, CreateBoard | null>): CreateBoard[] {
  return boards.flatMap((b) => (results.has(b.projectKey) ? (results.get(b.projectKey) ? [results.get(b.projectKey)!] : []) : [b]));
}

/** The four kinds of change shown before GitHub confirms them (GitHub#229). */
type FieldAction = Extract<WriteAction, { kind: 'addLabel' | 'removeLabel' | 'setMilestone' | 'setStatus' | 'setIteration' }>;
function isFieldAction(a: WriteAction): a is FieldAction {
  return a.kind === 'addLabel' || a.kind === 'removeLabel' || a.kind === 'setMilestone' || a.kind === 'setStatus' || a.kind === 'setIteration';
}

/** where each kind's Client ID override is saved ('oauthClientId' predates the choice and keeps its name) */
const CLIENT_ID_SETTING: Record<AppKind, string> = { oauth: 'oauthClientId', 'github-app': 'githubAppClientId' };

/**
 * A Project added and not yet imported: its saved web view is applied after
 * its first complete read. `touched` = settings the user changed meanwhile;
 * those keep the user's value (top-level keys, `table.<key>` for the table).
 */
interface PendingImport {
  sourceKey: string;
  view?: number;
  touched: string[];
}
const PENDING_IMPORTS = 'pendingImports';
/** its own key, not part of the view settings: importing a Project's web view must not touch it */
const MERGE_PREFS = 'mergePrefs';
/** GitHub#231: their own keys too, for the same reason */
const TABLE_FOLDS = 'tableFolds';
/** GitHub#297: folded board swimlanes, its own key for the same reason */
const LANE_FOLDS = 'laneFolds';
const AUTOPILOT_CONFIRM = 'autopilotConfirm';
/** GitHub#487: the shortcut keys changed on this machine, its own key (an imported view never touches it) */
const SHORTCUT_KEYS = 'shortcutKeys';
/** GitHub#434: the two settings of "等前置…" */
const BLOCKED_LABELS = 'blockedLabels';

/** the waiting label is the one setting of GitHub#429 (handBack.blocked); this setting keeps the other flow labels */
function normalizeBlockedLabels(raw: unknown, blocked: string): BlockedLabels {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<BlockedLabels>;
  return { blocked, flow: typeof r.flow === 'string' && r.flow.trim() ? r.flow.trim() : DEFAULT_BLOCKED_LABELS.flow };
}
const CLEAR_ALL_ON_ACTIVATE = 'clearAllOnActivate';
/** GitHub#373: which pending items remind ('all' / 'mine'), kept on this machine */
const NOTIFY_SCOPE = 'notifyScope';
const REPO_ORDER = 'repoOrder';
const NEW_ISSUE_HANDOFF = 'newIssueHandoff';
/** GitHub#397: the open detail tabs (order, what each last showed) */
const TABS = 'tabs';
/** how many re-read items no source carries are kept for opening in a tab */
const LOOSE_ITEMS = 20;

/**
 * The settings, as the window sees them: read once at start, every change
 * applied here at once and written through to the back end in call order.
 */
class Settings {
  private values: Map<string, unknown>;
  private writes: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly backend: Backend,
    init: Record<string, unknown>,
  ) {
    this.values = new Map(Object.entries(init));
  }
  getSetting<T>(k: string, fallback: T): T {
    return this.values.has(k) ? (this.values.get(k) as T) : fallback;
  }
  setSetting(k: string, v: unknown): void {
    this.values.set(k, v);
    this.enqueue(() => this.backend.call('setSetting', { key: k, value: v }));
  }
  /** the back end already wrote it (sign-in / sign-out): mirror only */
  mirror(k: string, v: unknown): void {
    this.values.set(k, v);
  }
  deleteSnapshot(key: string): void {
    this.enqueue(() => this.backend.call('deleteSnapshot', { key }));
  }
  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.writes.then(fn);
    this.writes = p.catch(() => undefined);
    return p;
  }
  /** resolves once every write queued so far has been answered */
  flushed(): Promise<void> {
    return this.writes.then(() => undefined);
  }
}

/** One sync round as `restartSync` sees it (GitHub#217). */
interface SyncRun {
  /** aborts when the round is dropped: no further request goes out */
  signal: AbortSignal;
  /** true only while the round reads GitHub, the one stretch a restart may cut */
  reading: boolean;
  drop(): void;
}

/** GitHub#448: how long the picker reuses a repository's complete list of open items */
const OPEN_CACHE_MS = 60_000;

export class Controller {
  private state: AppState;
  private snapshots = new Map<string, SourceSnapshot>();
  /**
   * GitHub#261: the change check's records, per source, valid for one sign-in session and one
   * addition of the source (`epoch`); each vouches only for the snapshot whose fetchedAt is its
   * `snapshotAt`. Memory only: a restart, sign-out or another account starts with full reads.
   */
  private checks = new Map<string, { epoch: number; check: SourceCheck }>();
  private checksSession: number | null = null;
  /**
   * GitHub#374: the sync's reads go through this gate — rate limited = no read until GitHub's
   * reset time, across rounds. Of one session: another account starts with it open.
   */
  private readGate: ReadGate;
  /** GitHub#374: per source (as the addition `epoch`), its failures in a row and when it is read again automatically */
  private failures = new Map<string, { count: number; since: number; nextAt: number | null; epoch: number }>();
  /** the session the gate and the failures belong to */
  private readsSession: number | null = null;
  /** GitHub#261: refresh by hand asked for a full read: the next round to start ignores the records */
  private fullReadNext = false;
  /** signed in, as the back end last said (it holds the credential, this side never does) */
  private signedIn = false;
  private listeners = new Set<(s: AppState) => void>();
  private syncing: Promise<void> | null = null;
  private resync = false;
  /** the round in flight (GitHub#217): a restart may drop it, but only while it is reading GitHub */
  private round: SyncRun | null = null;
  private loginRun = 0;
  /**
   * Cancels sent to the back end, in order. A new sign-in waits for them: commands to the back
   * end run side by side, so a cancel that arrived after the next `loginBegin` would end that
   * new attempt instead of the old one.
   */
  private loginCancels: Promise<unknown> = Promise.resolve();
  /** the back end's number for the sign-in attempt in progress (a cancel names it) */
  private pendingRun: number | null = null;
  private timer: unknown = null;
  // ---- GitHub#324: timed rounds keep a gap ----
  // Three things are remembered, and only `timedSync`, `syncNow` and `resetTimed` touch them:
  /** a beat came while syncing ran: that stretch outlasted the beat, so a gap follows it */
  private timedSwallowed = false;
  /** the earliest moment a timed round may start: when such a stretch went idle + the gap; null = at once */
  private timedDueAt: number | null = null;
  /** at most one: set for `timedDueAt`, in the session it was set in */
  private alarm: { handle: unknown; at: number; session: number } | null = null;
  /** the gap, as last told (a beat of the shell carries its interval) */
  private timedGapMs: number;
  private readonly timers: SyncTimers;
  /**
   * GitHub#324: per source, the latest round that read it in full or was told by GitHub's change
   * check that nothing changed. Never before the snapshot's own time; a failed round leaves it.
   * Not stored: after a restart it is the snapshot's time again (older, never newer, than the truth).
   */
  private checkedAt = new Map<string, number>();
  /** the one sync round queued after the last successful change (GigleAI/cavil-loop#177) */
  private followUp: ReturnType<typeof setTimeout> | null = null;
  /** bodies / comments with a box being ticked right now: one read-change-write each at a time (GitHub#193) */
  private tasksInFlight = new Set<string>();
  /** the back end's session: bumps on every login / logout, a round started in another session is dropped */
  private session = 0;
  /** the last sign-out applied here (a refresh ending the sign-in can be reported by several callers) */
  private signedOutAt = -1;
  /** per source key, bumps on every add / remove: a round only writes a source added before it started */
  private epochs = new Map<string, number>();
  private epochSeq = 0;
  private readonly cache: Settings;
  private readonly backend: Backend;
  private readonly now: () => number;

  private readonly defaultClientIds: Record<AppKind, string>;
  /** items carrying the pending label: notifications, badge and summary all come from here (GitHub#139) */
  private readonly pending: PendingTracker;
  private focusSeq = 0;

  // ---- GitHub#397: detail tabs ----
  /** the open tabs in order, with what each last showed (kept on this machine under TABS) */
  private tabList: StoredTab[] = [];
  /** items no complete read carries, as their own check last read them (this run only) */
  private tabOwn = new Map<string, Item>();
  /** when such an item's own check last answered (this run only; a failed check leaves it) */
  private tabChecked = new Map<string, number>();
  /** the next round's end checks every such item, also an ended one checked a moment ago (refresh by hand) */
  private tabsForce = false;
  private tabsChecking: Promise<void> | null = null;
  /** items this run re-read that no source carries, newest last (so that such an item can be opened in a tab) */
  private looseItems = new Map<string, Item>();
  private closeTabSeq = 0;
  private eventsRunning = false;

  // ---- GitHub#229 ----
  /** changes shown before GitHub confirmed them, one per field (see data/edits.ts); stored in the snapshot table under EDITS_KEY */
  private edits = new Map<string, EditRecord>();
  /** the EDITS_KEY row exists on disk (an empty set deletes it instead of writing it) */
  private editsStored = false;
  private editSeq = 0;
  /** the last stamp handed out: stamps only ever grow, so "sent after" never ties */
  private stampAt = 0;
  /** one chain per item: its changes go out one after the other, in the order they were made */
  private itemQueues = new Map<string, Promise<unknown>>();
  /** the watch re-reads of a record (cleared when it ends) */
  private editTimers = new Map<string, ReturnType<typeof setTimeout>[]>();
  /** GitHub#258: the waits of the watched boards of new issues */
  private watchTimers = new Set<ReturnType<typeof setTimeout>>();
  /** details read in this run, newest last (re-opening shows the last one while the new read is on its way) */
  private detailCache = new Map<string, { detail: ItemDetail; read: number }>();
  /** every detail read takes the next number when it starts: a read that lands after a later-started one of its item is not kept */
  private detailReads = 0;
  /** GitHub#395: release attachment images fetched with the sign-in, `session \n address` → data: address */
  private images = new Map<string, string>();
  private imageChars = 0;
  private imageFlights = new Map<string, Promise<ImageResult>>();
  private imageLimit: { session: number; until: number } | null = null;
  private imageRunning = 0;
  private imageWaiters: (() => void)[] = [];
  /**
   * GitHub#328: newly pending items whose detail is read ahead, so a clicked notification shows
   * it at once. Each with what its notification was decided on, the session it was queued in, and
   * `after`: the calls to the shell of its own round (its notification, that round's badge) —
   * its read never goes out before they were answered.
   */
  private prefetchQueue: { key: string; ctx: NoticeContext; session: number; after: Promise<unknown> }[] = [];
  private prefetching = false;
  /** bumps on sign-out / another account: the loop of the earlier account ends at its next step, a new one may start */
  private prefetchGen = 0;
  /** labels / milestones per repository, only reads that worked */
  private optionsCache = new Map<string, RepoOptions>();
  private createSeq = 0;
  /**
   * The newest read that landed, per source (a whole sync round) and per source + item (one
   * item's re-read): a read issued before it is older than what is shown and does not land.
   */
  private sourceReadAt = new Map<string, number>();
  private itemReadAt = new Map<string, number>();

  // ---- GitHub#250 ----
  /** close / merge / autopilot / hand-back operations (shared/ops.ts), stored under OPS_KEY */
  private ops = new Map<string, OpRecord>();
  /** GitHub#489: replies / edits / ticked boxes sent for the window (shared/sends.ts), stored under SENDS_KEY */
  private sends = new Map<string, SendRecord>();
  private sendsStored = false;
  private sendSeq = 0;
  /** GitHub#489: a send's job (its request, or a check) is running in this run of the app */
  private sendJobs = new Map<string, Promise<void>>();
  /** PR #510 review round 2: same-text marks of unknown replies / attached comments a person unlocked (shared/sends.ts) */
  private sameText: SameTextMark[] = [];
  /** the box's latest text is written to disk a moment after the typing stops */
  private sendDraftTimer: ReturnType<typeof setTimeout> | null = null;
  private opsStored = false;
  private opSeq = 0;
  /** an operation's requests and re-reads, while they run */
  private opJobs = new Map<string, Promise<void>>();
  /** GitHub#279: records being re-read after a round (one at a time per record) */
  private catchingUp = new Set<string>();
  /** items a "finish the remaining steps" is preparing for (it re-reads first): the send gate counts them */
  private opPreparing = new Set<string>();
  /** the wait of a succeeded operation for its re-read: offers the manual unlock when it runs out */
  private opTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** GitHub#359: the waits between the automatic checks (ended early, as "do not go on", when the session ends) */
  private opWaits = new Map<ReturnType<typeof setTimeout>, (go: boolean) => void>();

  /** Read what the back end has (settings, cached snapshots), then build the controller. */
  static async create(deps: ControllerDeps): Promise<Controller> {
    const init = await deps.backend.call<BackendInit>('init');
    return new Controller(deps, init);
  }

  constructor(
    private readonly deps: ControllerDeps,
    init: BackendInit,
  ) {
    this.backend = deps.backend;
    this.cache = new Settings(deps.backend, init.settings);
    this.defaultClientIds = {
      oauth: deps.defaultClientId ?? DEFAULT_OAUTH_CLIENT_ID,
      'github-app': deps.defaultGithubAppClientId ?? DEFAULT_GITHUB_APP_CLIENT_ID,
    };
    this.now = deps.now ?? Date.now;
    this.timers = deps.timers ?? REAL_TIMERS;
    this.timedGapMs = deps.syncGapMs ?? deps.syncIntervalMs ?? SYNC_INTERVAL_MS;
    this.readGate = new ReadGate(this.now);
    const appKind = this.loadAppKind();
    const handBack: HandBackLabels = { ...DEFAULT_HAND_BACK, ...this.cache.getSetting<Partial<HandBackLabels>>('handBack', {}) };
    // GitHub#404: saved before the running label existed (or not a string) → the default; an empty one stays empty
    if (typeof handBack.running !== 'string') handBack.running = DEFAULT_HAND_BACK.running;
    // GitHub#429: saved before the waiting label existed (or not a string) → the default; an empty one stays empty
    if (typeof handBack.blocked !== 'string') handBack.blocked = DEFAULT_HAND_BACK.blocked;
    // GitHub#513: a setting saved before the parked label existed
    if (typeof handBack.later !== 'string') handBack.later = DEFAULT_HAND_BACK.later;
    // One "waiting for a human" label for everything: reminders count it, "hand back to the agent" removes it.
    const notifyScope = normalizeNotifyScope(this.cache.getSetting<unknown>(NOTIFY_SCOPE, 'all'));
    // GitHub#471: the language is decided before anything is drawn; nothing set (or a value this
    // version does not know) is Chinese, as before. The back end starts in Chinese: it is told only
    // when the window shows something else.
    const uiLanguage = normalizeLangSetting(this.cache.getSetting<unknown>(LANG_SETTING, DEFAULT_LANG_SETTING));
    const lang = resolveLang(uiLanguage, this.systemLanguages());
    setLang(lang);
    if (lang !== 'zh') this.tellBackendLanguage(lang);
    this.pending = new PendingTracker(handBack.human.trim() || DEFAULT_HAND_BACK.human, { scope: notifyScope, viewer: this.cache.getSetting<string | null>('viewer', null) });
    this.state = {
      phase: 'loading',
      loginReason: null,
      login: { status: 'idle', userCode: null, verificationUri: null, message: null },
      appKind,
      ...this.clientIdFor(appKind),
      viewer: this.cache.getSetting<string | null>('viewer', null),
      signedInAppKind: null,
      githubWeb: deps.endpoints.web,
      sources: this.cache.getSetting<SourceConfig[]>('sources', []),
      view: normalizeView(this.cache.getSetting<unknown>('view', {})),
      sync: { syncing: false, ...offlineFields(false, null), lastOnlineAt: null, dataFrom: null, checkedFrom: null, times: [], progress: null, sources: [], problem: null },
      credentialsPersistent: init.persistent,
      handBack,
      ...this.loadTallies(),
      blockedLabels: normalizeBlockedLabels(this.cache.getSetting<unknown>(BLOCKED_LABELS, null), handBack.blocked),
      mergePrefs: normalizeMergePrefs(this.cache.getSetting<unknown>(MERGE_PREFS, null)),
      tableFolds: normalizeTableFolds(this.cache.getSetting<unknown>(TABLE_FOLDS, null)),
      laneFolds: normalizeLaneFolds(this.cache.getSetting<unknown>(LANE_FOLDS, null)),
      autopilotConfirm: normalizeAutopilotConfirm(this.cache.getSetting<unknown>(AUTOPILOT_CONFIRM, true)),
      // GitHub#487: what was saved, made usable; reading never writes it back (the next change writes the repaired keys)
      ...((r) => ({ shortcutKeys: r.keys as Record<string, ShortcutKeySpec>, shortcutDropped: r.dropped }))(repairKeys(this.cache.getSetting<unknown>(SHORTCUT_KEYS, null))),
      clearAllOnActivate: normalizeClearAllOnActivate(this.cache.getSetting<unknown>(CLEAR_ALL_ON_ACTIVATE, false)),
      notifyScope,
      uiLanguage,
      lang,
      repoOrder: normalizeRepoOrder(this.cache.getSetting<unknown>(REPO_ORDER, null)),
      newIssueHandoff: normalizeHandoff(this.cache.getSetting<unknown>(NEW_ISSUE_HANDOFF, 'none')),
      pendingCount: 0,
      unreadCount: 0,
      launchAtLogin: null,
      notifyProblem: null,
      focus: null,
      tabs: [],
      closeTabReq: 0,
      update: null,
      editsNeedingAction: 0,
      editsResending: [],
      creates: [],
      ops: [],
      sends: [],
    };
    for (const s of init.snapshots) {
      if (s.sourceKey === EDITS_KEY) this.loadEdits(s);
      else if (s.sourceKey === OPS_KEY) this.loadOps(s);
      else if (s.sourceKey === SENDS_KEY) this.loadSends(s);
      else this.snapshots.set(s.sourceKey, s);
    }
    this.tabList = normalizeTabs(this.cache.getSetting<unknown>(TABS, null));
    this.refreshDerived();
  }

  getState(): AppState {
    return this.state;
  }

  getBoardData(): BoardData {
    const configured = this.state.sources.map((s) => s.key);
    const snaps = [...this.snapshots.values()].filter((s) => configured.includes(s.sourceKey));
    const selected = this.state.view.selected?.filter((k) => configured.includes(k)) ?? null;
    const merged0 = mergeSnapshots(snaps, selected);
    // GitHub#397: an open tab's item, when the view does not hold it or holds an older copy than the tab knows
    const tabItems = this.tabItemsFresh(merged0.items);
    const merged = tabItems.length ? { ...merged0, tabItems } : merged0;
    if (!this.edits.size) return { ...merged, allProjects: this.allProjects(), boardRepos: this.boardRepos() };
    // GitHub#229: the changes on their way show on the item itself, the others beside it
    const byKey = new Map<string, EditRecord[]>();
    for (const r of this.edits.values()) byKey.set(r.key, [...(byKey.get(r.key) ?? []), r]);
    const all = this.allProjects();
    // GitHub#397: a tab's own copy shows the same changes on their way as the board's copy (one item, one answer)
    const overlay = (xs: Item[]) => xs.map((it) => (byKey.has(it.key) ? overlayItem(it, byKey.get(it.key)!, all) : it));
    const out: BoardData = { ...merged, items: overlay(merged.items), allProjects: all, boardRepos: this.boardRepos() };
    if (merged.tabItems) out.tabItems = overlay(merged.tabItems);
    return out;
  }

  /**
   * GitHub#231: every configured Project with its items counted per repository, from its own
   * snapshot — not the filtered view — so a new issue's default board does not depend on what the
   * top filter shows. No snapshot yet = never read completely = unknown (null).
   */
  private boardRepos(): BoardRepoCount[] {
    const out: BoardRepoCount[] = [];
    for (const s of this.state.sources) {
      if (s.kind !== 'project') continue;
      const snap = this.snapshots.get(s.key);
      out.push({ key: s.key, title: snap?.project?.title ?? sourceLabel(s), repos: snap?.project ? countRepos(snap.items) : null });
    }
    return out;
  }

  /** Every configured Project, in the order the sources were added (GitHub#205: what a new issue may join). */
  private allProjects() {
    return this.state.sources.map((s) => this.snapshots.get(s.key)?.project).filter((p): p is NonNullable<typeof p> => Boolean(p));
  }

  onChange(cb: (s: AppState) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Every setting written so far has reached the back end (tests read the file afterwards). */
  settled(): Promise<void> {
    return this.cache.flushed();
  }

  private set(patch: Partial<AppState>) {
    this.state = { ...this.state, ...patch };
    this.refreshDerived();
    for (const l of this.listeners) l(this.state);
  }

  /**
   * GitHub#324: the two times of every source and the two board-wide ones come from here alone
   * (the header, the offline bar and the hover all read this one result): the oldest full read and
   * the oldest check among the sources that have data. A source never read has neither.
   */
  private refreshDerived() {
    const cur = this.state.sync;
    const times: SourceTimes[] = this.state.sources.map((s) => {
      const readAt = this.snapshots.get(s.key)?.fetchedAt ?? null;
      return { sourceKey: s.key, readAt, checkedAt: readAt === null ? null : Math.max(readAt, this.checkedAt.get(s.key) ?? readAt) };
    });
    const oldest = (xs: (number | null)[]) => {
      const have = xs.filter((t): t is number => t !== null);
      return have.length ? Math.min(...have) : null;
    };
    const dataFrom = oldest(times.map((t) => t.readAt));
    const checkedFrom = oldest(times.map((t) => t.checkedAt));
    const sameTimes = times.length === cur.times.length && times.every((t, i) => t.sourceKey === cur.times[i].sourceKey && t.readAt === cur.times[i].readAt && t.checkedAt === cur.times[i].checkedAt);
    // the progress of a round ends with the round, whichever way it ended
    const progress = cur.syncing ? cur.progress : null;
    if (dataFrom !== cur.dataFrom || checkedFrom !== cur.checkedFrom || !sameTimes || progress !== cur.progress) {
      this.state = { ...this.state, sync: { ...cur, dataFrom, checkedFrom, times: sameTimes ? cur.times : times, progress } };
    }
    this.refreshTabs();
  }

  async start(): Promise<void> {
    void this.readLoginItem();
    void this.readUpdate();
    const r = await this.backend.call<{ phase: 'login' | 'ready'; reason?: string | null; reasonSaid?: unknown; session?: number; wiped: boolean }>('start');
    if (r.wiped) this.dropMirror();
    if (r.phase === 'login') {
      this.set({ phase: 'login', loginReason: r.reason ?? null, loginReasonSaid: readSaid(r.reasonSaid) });
      return;
    }
    this.session = r.session!;
    this.resetTimed();
    this.signedIn = true;
    this.set({ phase: 'ready' });
    await this.syncNow();
  }

  startTimer(): void {
    if (this.timer !== null) this.timers.clearInterval(this.timer);
    this.cancelFollowUp();
    this.timer = this.timers.setInterval(() => this.timedSync(), this.deps.syncIntervalMs ?? SYNC_INTERVAL_MS);
  }

  stopTimer(): void {
    if (this.timer !== null) this.timers.clearInterval(this.timer);
    this.timer = null;
    this.resetTimed();
    this.cancelFollowUp();
    // GitHub#258: and the watches of new issues (they only end here or with the session)
    for (const t of this.watchTimers) clearTimeout(t);
    this.watchTimers.clear();
    this.endOpWaits();
  }

  /**
   * One more sync round a few seconds after the last successful change: GitHub's
   * own automations (closed / merged → Done, …) happen on GitHub's side after
   * the immediate re-read. Several changes in a row push it back: one round, after
   * the last. Dropped when the session it was queued in is over.
   */
  private scheduleFollowUp(session: number): void {
    this.cancelFollowUp();
    this.followUp = setTimeout(() => {
      this.followUp = null;
      if (session === this.session && this.signedIn) void this.syncNow();
    }, this.deps.followUpSyncMs ?? FOLLOW_UP_SYNC_MS);
  }

  private cancelFollowUp(): void {
    if (this.followUp) clearTimeout(this.followUp);
    this.followUp = null;
  }

  // ---- login -------------------------------------------------------------

  async startLogin(): Promise<void> {
    const clientId = this.state.clientId.trim();
    const run = ++this.loginRun;
    const problem = !clientId
      ? this.state.appKind === 'github-app'
        ? t('用 GitHub App 登录要先填它的 Client ID（这一版还没有内置的 GitHub App），或改回默认的 OAuth 应用')
        : t('还没有配置 OAuth 应用的 Client ID，请先在下方填写')
      : // never sign in through a different kind of app than the page describes
        clientIdKindProblem(this.state.appKind, clientId);
    if (problem) {
      // a new attempt ends any older one, even when this one cannot start
      this.sendCancel();
      this.set({ login: { status: 'error', userCode: null, verificationUri: null, message: problem } });
      return;
    }
    this.set({ login: { status: 'requesting', userCode: null, verificationUri: null, message: null } });
    const fail = (status: string, message: string, said?: unknown) =>
      this.set({
        login: { status: status === 'denied' ? 'denied' : status === 'expired' ? 'expired' : 'error', userCode: null, verificationUri: null, message, said: readSaid(said) },
      });
    try {
      await this.loginCancels;
      if (run !== this.loginRun) return;
      const begun = await this.backend.call<{ status: string; run?: number; userCode?: string; verificationUri?: string; message?: string; said?: unknown }>('loginBegin', { clientId });
      if (run !== this.loginRun || begun.status === 'stale') return;
      if (begun.status !== 'waiting') return fail(begun.status, begun.message ?? '', begun.said);
      this.pendingRun = begun.run ?? null;
      this.set({ login: { status: 'waiting', userCode: begun.userCode!, verificationUri: begun.verificationUri!, message: null } });
      // The back end polls GitHub, asks who this is, and stores + trusts the
      // credential as one step of its credential queue: a cancel / sign-out /
      // newer login meanwhile makes this login stale there, whatever happens here.
      const done = await this.backend.call<{ status: string; session?: number; viewer?: string | null; wiped?: boolean; message?: string; said?: unknown; loginReason?: string | null; loginReasonSaid?: unknown }>(
        'loginFinish',
        { run: begun.run },
      );
      if (done.status === 'stale') {
        if (done.loginReason) this.set({ loginReason: done.loginReason, loginReasonSaid: readSaid(done.loginReasonSaid) });
        return;
      }
      if (done.status !== 'ok') {
        if (run === this.loginRun) fail(done.status, done.message ?? '', done.said);
        return;
      }
      if (run !== this.loginRun) {
        // cancelled here after the back end had already committed: the back end signs that
        // login out when the cancel (which names this attempt) reaches it — see sendCancel
        return;
      }
      this.pendingRun = null;
      this.session = done.session!;
      this.resetTimed();
      this.signedIn = true;
      if (done.wiped) this.dropMirror();
      this.cache.mirror('viewer', done.viewer ?? null);
      this.state = { ...this.state, viewer: done.viewer ?? null };
      this.set({
        phase: 'ready',
        loginReason: null,
        loginReasonSaid: null,
        login: { status: 'idle', userCode: null, verificationUri: null, message: null },
      });
      await this.syncNow();
    } catch (e) {
      if (run === this.loginRun) fail('error', (e as Error).message);
    }
  }

  private sendCancel(): void {
    const run = this.pendingRun;
    this.pendingRun = null;
    const sent = this.backend
      .call<{ signedOut?: { session: number; message?: string | null; said?: unknown } }>('loginCancel', run !== null ? { run } : {})
      .then(async (r) => {
        // the attempt had already committed: the back end signed it out
        if (r?.signedOut) await this.applySignedOut(r.signedOut.session, r.signedOut.message ?? null, readSaid(r.signedOut.said));
      })
      .catch(() => {});
    this.loginCancels = this.loginCancels.then(() => sent);
  }

  cancelLogin(): void {
    this.loginRun++;
    this.sendCancel();
    this.set({ login: { status: 'idle', userCode: null, verificationUri: null, message: null } });
  }

  async openVerification(): Promise<void> {
    if (this.state.login.verificationUri) await this.backend.call('openVerification');
  }

  async logout(reason: string | null = null): Promise<void> {
    this.loginRun++;
    this.signedIn = false;
    // The back end first makes it durable that the stored credential may never
    // sign us in again, and drops the cache, in one transaction; only then does
    // the page switch. The keychain delete runs after that (see logoutResult).
    // `message`: the sign-out could not be made fully durable — never shown as a clean sign-out
    // the reason is the client's own words: in the window's language, for the back end to word around
    const shown = reason === null ? null : tKey(reason);
    const { session, message, said } = await this.backend.call<{ session: number; message?: string | null; said?: unknown }>('logout', { reason: shown });
    await this.applySignedOut(session, message ?? shown, message ? readSaid(said) : null);
  }

  /** The back end signed out (asked to here, or because a refresh ended the sign-in): switch the page, then report a failed delete. */
  private async applySignedOut(session: number, reason: string | null, reasonSaid: Said | null = null): Promise<void> {
    if (session <= this.signedOutAt) return;
    this.signedOutAt = session;
    this.session = session;
    this.signedIn = false;
    this.resetTimed();
    this.cancelFollowUp();
    this.dropMirror();
    this.cache.mirror('viewer', null);
    // GitHub#397: the tabs belong to the account that opened them
    this.dropTabs();
    this.set({
      phase: 'login',
      loginReason: reason,
      loginReasonSaid: reasonSaid,
      viewer: null,
      signedInAppKind: null,
      sync: { ...this.state.sync, problem: null },
      login: { status: 'idle', userCode: null, verificationUri: null, message: null },
    });
    const r = await this.backend.call<{ message: string | null; said?: unknown; current: boolean }>('logoutResult', { session });
    // only while nothing newer happened (a new login commits after this delete, in the same queue)
    if (r.message && r.current && session === this.session) this.set({ loginReason: r.message, loginReasonSaid: readSaid(r.said) });
  }

  /** The back end refreshes when due (single flight); this side shows what came of it. */
  private async fresh(force = false, gen?: number): Promise<FreshResult> {
    return (await this.freshOut(force, gen)).result;
  }

  /** `fresh`, with why GitHub could not be used when the answer is 'unreachable' (GitHub#270) */
  private async freshOut(force = false, gen?: number): Promise<{ result: FreshResult; reason: string | null }> {
    let r: FreshOut;
    try {
      r = await this.backend.call<FreshOut>('ensureFresh', { session: this.session, force, clientId: this.state.clientId, ...(gen !== undefined ? { gen } : {}) });
    } catch (e) {
      this.setProblem(`登录续期出错（${(e as Error).message}），会在下一轮自动重试`);
      return { result: 'failed', reason: null };
    }
    if (r.signedOut) await this.applySignedOut(r.signedOut.session, r.signedOut.reason, readSaid(r.signedOut.reasonSaid));
    if (r.problem !== undefined && this.signedIn) this.setProblem(r.problem);
    return { result: r.result, reason: typeof r.reason === 'string' ? r.reason : null };
  }

  /** A refreshed grant that could not be stored: the back end tries again. */
  private async saveUnsaved(): Promise<void> {
    const r = await this.backend.call<{ problem?: string | null }>('saveUnsaved');
    if (r.problem !== undefined) this.setProblem(r.problem);
  }

  private setProblem(problem: string | null): void {
    if (this.state.sync.problem !== problem) this.set({ sync: { ...this.state.sync, problem } });
  }

  /** The back end dropped every snapshot (sign-out / another account): forget them here too, and what was pending with them. */
  private dropMirror(): void {
    this.snapshots.clear();
    this.checks.clear();
    this.checkedAt.clear();
    // GitHub#229: the changes, cached details and candidates belonged to that account too (the back end dropped the stored changes in the same step)
    for (const t of this.editTimers.values()) t.forEach(clearTimeout);
    this.editTimers.clear();
    this.edits.clear();
    this.editsStored = false;
    this.itemQueues.clear();
    this.detailCache.clear();
    this.images.clear();
    this.imageChars = 0;
    this.imageLimit = null;
    this.prefetchQueue = [];
    this.prefetchGen++;
    this.prefetching = false;
    this.optionsCache.clear();
    this.sourceReadAt.clear();
    this.itemReadAt.clear();
    for (const t of this.opTimers.values()) clearTimeout(t);
    this.opTimers.clear();
    this.endOpWaits();
    this.ops.clear();
    this.opsStored = false;
    this.opPreparing.clear();
    // GitHub#258: the watches of that account's new issues end with it
    for (const t of this.watchTimers) clearTimeout(t);
    this.watchTimers.clear();
    this.resending.clear();
    this.resendQueue.clear();
    // GitHub#489: and its replies / edits (their row went with the cache)
    this.sends.clear();
    this.sameText = [];
    if (this.sendDraftTimer) clearTimeout(this.sendDraftTimer);
    this.sendDraftTimer = null;
    this.sendsStored = false;
    this.state = { ...this.state, editsNeedingAction: 0, editsResending: [], creates: [], ops: [], sends: [] };
    this.pending.reset();
    this.unread.clear();
    this.state = { ...this.state, pendingCount: 0, unreadCount: 0, sync: { ...this.state.sync, sources: [], dataFrom: null } };
    // what was queued for the shell belonged to that account: none of it goes out any more, and the
    // cleared badge does not wait behind a notification the system is still answering
    this.desktopEra++;
    this.desktopCalls = Promise.resolve();
    this.badge();
  }

  // ---- pending: notifications, Dock badge, start-up summary (GitHub#139) ----

  /**
   * Calls to the shell go one at a time, in order. A window the user closed is
   * hidden, and its web engine may hold back a second request sent while the
   * first is in flight until the page wakes again — a badge then lagged a whole
   * sync beat behind its notification (found by test/tauri/background.spec.ts).
   */
  private desktopCalls: Promise<unknown> = Promise.resolve();
  /**
   * Bumps on sign-out / another account (dropMirror). A call queued in an earlier era is
   * dropped before it reaches the shell, and the answer to one already handed over is ignored.
   */
  private desktopEra = 0;
  /** items not yet seen (GitHub#185): the Dock badge */
  private unread = new Set<string>();
  /** the window is in front (the shell says so); while it is, new items are seen as they come */
  private active = false;
  /** bumps when the "waiting for a human" label is renamed: a recount is silent, nothing queued before it goes out */
  private labelVersion = 0;

  /** Queue one call to the shell; `run` decides right before it goes out (null = dropped). */
  private toDesktop<T>(run: (d: Desktop) => Promise<T> | null): Promise<{ answer: T; current: () => boolean } | null> | null {
    const d = this.deps.desktop;
    if (!d) return null;
    const era = this.desktopEra;
    const current = () => era === this.desktopEra;
    const p = this.desktopCalls.then(async () => {
      if (!current()) return null;
      const call = run(d);
      return call ? { answer: await call, current } : null;
    });
    this.desktopCalls = p.catch(() => undefined);
    return p;
  }

  /** Every call to the shell queued so far has been answered (the tests wait on this). */
  desktopSettled(): Promise<void> {
    return this.desktopCalls.then(() => undefined);
  }

  /** The count and the unread part of it, from the tracker's one de-duplicated set at the same moment. */
  private pendingNow(): Pick<AppState, 'pendingCount' | 'unreadCount'> {
    return { pendingCount: this.pending.count(), unreadCount: this.unreadNow() };
  }

  /**
   * The unread items (GitHub#185, the Dock badge): what became pending while the window was not
   * in front, until the user switches to it. Only items still pending count — one whose label
   * went away or that was closed meanwhile needs nobody. Nothing is forgotten here: only switching
   * to the window reads them (a label renamed and renamed back has not been seen). What a first
   * read finds is history and never unread (GitHub#251).
   */
  private unreadNow(): number {
    let n = 0;
    for (const k of this.unread) if (this.pending.has(k)) n++;
    return n;
  }

  /**
   * The user switched to the window: everything is read — the badge goes. The delivered
   * notifications stay in Notification Center (GitHub#369: a click takes back only the one clicked,
   * in the shell), unless the user ticked "切到 App 时收起全部系统通知" in Settings.
   */
  private markRead(): void {
    this.unread.clear();
    this.set({ unreadCount: 0 });
    this.badge();
    if (this.state.clearAllOnActivate) this.toDesktop((d) => d.clearNotifications())?.catch(() => {});
  }

  private badge(): void {
    // the count as it is when the call goes out; a badge that cannot be set must not break a sync round
    this.toDesktop((d) => d.setBadge(this.unreadNow()))?.catch(() => {});
  }

  /**
   * What a notification was decided on: the label and the sources (each as the
   * addition it was) that it came from. Checked again right before it goes out — the one rule for
   * every queued notification (PR #173 review rounds 1–2: sign-out, a source removed, removed and
   * added back, the label renamed and renamed back all happened while one waited).
   */
  private noticeContext(sources: string[]): NoticeContext {
    return { label: this.labelVersion, sources: sources.map((k) => [k, this.epochs.get(k) ?? 0] as const) };
  }

  /** The recorded sources still configured as the same addition. */
  private liveSources(ctx: NoticeContext): string[] {
    return ctx.sources
      .filter(([k, e]) => this.state.sources.some((s) => s.key === k) && (this.epochs.get(k) ?? 0) === e)
      .map(([k]) => k);
  }

  /** (the session is checked once, by the queue: a call from an earlier era never runs) */
  private sameContext(ctx: NoticeContext): boolean {
    return ctx.label === this.labelVersion;
  }

  /**
   * An item notification still holds when the item is pending now through at least one of the
   * sources it came from, still the same addition (another source carrying it does not revive it,
   * one of its own still carrying it keeps it — one item is one notification across sources).
   */
  private itemStillHolds(ctx: NoticeContext, key: string): boolean {
    if (!this.sameContext(ctx)) return false;
    const carriers = this.pending.carriers(key);
    return this.liveSources(ctx).some((k) => carriers.includes(k));
  }

  private notify(make: () => Alert | null): void {
    const era = this.desktopEra;
    this.toDesktop((d) => {
      const a = make();
      return a ? d.notify(a) : null;
    })?.then(
      (r) => {
        if (r && r.current()) this.reportNotification(r.answer);
      },
      (e) => {
        if (era === this.desktopEra) this.reportNotification({ ok: false, error: (e as Error).message ?? String(e) });
      },
    );
  }

  /**
   * Feed the snapshots read completely this round; notify what became pending. A source's first
   * read is only its baseline: no notification, no summary, nothing unread (GitHub#251).
   */
  private observePending(fresh: SourceSnapshot[], viewer: string | null): void {
    // GitHub#373: whose reminders — the login as this round read it (a change is recomputed silently)
    this.pending.setAudience({ scope: this.state.notifyScope, viewer });
    const change = this.pending.observe(fresh, this.state.sources.map((s) => s.key));
    // unread (the badge): what arrived while the user was not looking at the window
    if (!this.active) for (const it of change.appeared) this.unread.add(it.key);
    for (const it of change.appeared) {
      const ctx = this.noticeContext(this.pending.carriers(it.key));
      const alert: Alert = { kind: 'item', key: it.key, url: it.url, ...itemAlertText(it) };
      this.notify(() => (this.itemStillHolds(ctx, it.key) ? alert : null));
    }
    this.badge();
    this.prefetchAppeared(change.appeared);
    this.state = { ...this.state, ...this.pendingNow() };
  }

  /**
   * GitHub#328: read the details of the items just notified ahead of the click, at most
   * PREFETCH_PER_ROUND a round. An item's read goes out only once the notifications and the badge
   * of its own round have been handed to the shell and answered (a hidden window may hold back a
   * request sent next to another one — see desktopCalls): every queued item carries that wait
   * itself, so a loop still busy with an earlier round cannot send it early (PR #331 review
   * round 1). Without a shell nothing is notified, so nothing is read ahead.
   */
  private prefetchAppeared(appeared: Item[]): void {
    if (!this.deps.desktop || !appeared.length) return;
    const session = this.session;
    // everything this round queued for the shell so far: observePending calls this last
    const after = this.desktopCalls;
    for (const it of appeared.slice(0, PREFETCH_PER_ROUND)) {
      if (this.prefetchQueue.some((q) => q.key === it.key)) continue;
      this.prefetchQueue.push({ key: it.key, ctx: this.noticeContext(this.pending.carriers(it.key)), session, after });
    }
    void this.runPrefetch();
  }

  /**
   * The one loop that sends the reads, one at a time, in the order queued. Each waits for its
   * round's calls to the shell, and is then decided right before it goes out by the rule its
   * notification goes out by (still pending through a source it came from, same account). A
   * failed read is nobody's problem: nothing is shown or retried, the panel reads when the item
   * is opened.
   */
  private async runPrefetch(): Promise<void> {
    if (this.prefetching) return;
    this.prefetching = true;
    const gen = this.prefetchGen;
    for (;;) {
      const q = this.prefetchQueue.shift();
      if (!q) break;
      await q.after;
      // signed out meanwhile: the queue and the flag belong to whoever came after
      if (gen !== this.prefetchGen) return;
      if (q.session !== this.session || !this.itemStillHolds(q.ctx, q.key)) continue;
      await this.readDetail(q.key).catch(() => undefined);
      if (gen !== this.prefetchGen) return;
    }
    this.prefetching = false;
  }

  /** Every detail read ahead so far has ended (the tests wait on this). */
  async prefetchSettled(): Promise<void> {
    await this.desktopSettled();
    while (this.prefetching || this.prefetchQueue.length) await new Promise((r) => setTimeout(r, 5));
  }

  /**
   * What the system did with a notification: a refusal is shown on the board
   * and in Settings instead of failing silently; the next one that goes out clears it.
   */
  private reportNotification(result: Delivery): void {
    const problem = result.ok ? null : result.error;
    if (problem !== this.state.notifyProblem) this.set({ notifyProblem: problem });
  }

  private async readLoginItem(): Promise<void> {
    let v: boolean | null = null;
    try {
      v = (await this.deps.desktop?.loginItem()) ?? null;
    } catch {
      v = null;
    }
    if (v !== this.state.launchAtLogin) this.set({ launchAtLogin: v });
  }

  async setLaunchAtLogin(on: boolean): Promise<void> {
    if (!this.deps.desktop || this.state.launchAtLogin === null) return;
    try {
      await this.deps.desktop.setLoginItem(Boolean(on));
    } catch {
      /* read back below shows what the system actually has */
    }
    await this.readLoginItem();
  }

  // ---- the app updating itself (GitHub#184): the shell decides and reports; this only shows and asks ----

  /** bumps on every status the shell sends: a read that started before one is older than it */
  private updateSeq = 0;

  private async readUpdate(): Promise<void> {
    const d = this.deps.desktop;
    if (!d) return;
    const seq = this.updateSeq;
    let v: UpdateStatus | null = null;
    try {
      v = (await d.updateStatus()) ?? null;
    } catch {
      v = null;
    }
    if (seq === this.updateSeq) this.set({ update: v });
  }

  private onUpdate(status: UpdateStatus): void {
    this.updateSeq++;
    this.set({ update: status });
  }

  async checkUpdate(): Promise<void> {
    await this.deps.desktop?.checkUpdate().catch(() => {});
  }

  async setAutoUpdate(on: boolean): Promise<void> {
    await this.deps.desktop?.setAutoUpdate(Boolean(on)).catch(() => {});
  }

  async setUpdateChannel(channel: 'stable' | 'dev'): Promise<void> {
    await this.deps.desktop?.setUpdateChannel(channel === 'dev' ? 'dev' : 'stable').catch(() => {});
  }

  async dismissUpdate(version: string): Promise<void> {
    await this.deps.desktop?.dismissUpdate(String(version)).catch(() => {});
  }

  async dismissInstalledUpdate(version: string): Promise<void> {
    await this.deps.desktop?.dismissInstalledUpdate(String(version)).catch(() => {});
  }

  async restartToUpdate(): Promise<void> {
    await this.deps.desktop?.restartToUpdate().catch(() => {});
  }

  /**
   * Events from the shell, one at a time: a sync beat (the shell keeps time,
   * so a hidden window keeps syncing) or a clicked notification.
   */
  async runDesktopEvents(): Promise<void> {
    const d = this.deps.desktop;
    if (!d || this.eventsRunning) return;
    this.eventsRunning = true;
    while (this.eventsRunning) {
      let ev: DesktopEvent;
      try {
        ev = await d.nextEvent();
      } catch {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      if (!this.eventsRunning) break;
      this.onDesktopEvent(ev);
    }
  }

  stopDesktopEvents(): void {
    this.eventsRunning = false;
  }

  /** One event from the shell (also what the tests feed). */
  onDesktopEvent(ev: DesktopEvent): void {
    if (ev.kind === 'active' || ev.kind === 'inactive') {
      this.active = ev.kind === 'active';
      if (this.active) this.markRead();
      return;
    }
    if (ev.kind === 'tick') {
      this.timedSync(ev.everyMs);
      return;
    }
    if (ev.kind === 'update') {
      this.onUpdate(ev.status);
      return;
    }
    if (ev.kind === 'closeTab') {
      // GitHub#397: the shell's "close" key (macOS: the menu's ⌘W) — the window closes the tab in front, or asks for the window to close
      this.set({ closeTabReq: ++this.closeTabSeq });
      return;
    }
    // a click: the item's detail in the app; an item no longer on the board opens on GitHub instead
    if (this.state.phase === 'ready' && this.findItem(ev.key)) {
      this.set({ focus: { key: ev.key, seq: ++this.focusSeq } });
    } else if (ev.url) {
      void this.backend.call('openExternal', { url: ev.url }).catch(() => {});
    }
  }

  /** Write snapshots read in `session`; false when that session is over (nothing lands, here or on disk). */
  private async writeSnapshots(session: number, snaps: SourceSnapshot[]): Promise<boolean> {
    if (!snaps.length) return session === this.session;
    const r = await this.cache.enqueue(() => this.backend.call<{ written: boolean }>('replaceSnapshots', { session, snapshots: snaps }));
    return r.written && session === this.session;
  }

  /**
   * GitHub#229: land snapshots one after the other. `build` runs in the write queue, against
   * memory as every earlier landing left it, so a later landing never builds on a copy an
   * earlier one has since replaced. It returns the rows to write and `commit`, which records
   * which reads these rows hold. Only after the disk took the rows, in this session, does
   * memory take them (the ones `keep` still accepts then) and `commit` run, in the same step:
   * a read whose rows did not reach the disk leaves no trace — no row, no read time — so it
   * is never taken for evidence (PR #240 plan review round 2).
   * `ended`: the session is over; `failed`: the write threw or was refused (nothing landed).
   */
  private landSnapshots(
    session: number,
    build: () => { rows: SourceSnapshot[]; commit: (keep: (sourceKey: string) => boolean) => void },
    keep: (sourceKey: string) => boolean,
  ): Promise<{ kind: 'landed'; rows: SourceSnapshot[] } | { kind: 'ended' } | { kind: 'failed'; reason: string; error?: unknown }> {
    return this.cache.enqueue(async () => {
      if (session !== this.session) return { kind: 'ended' as const };
      const plan = build();
      if (plan.rows.length) {
        let r: { written: boolean };
        try {
          r = await this.backend.call<{ written: boolean }>('replaceSnapshots', { session, snapshots: plan.rows });
        } catch (e) {
          return { kind: 'failed' as const, reason: `没能存到本机：${(e as Error).message}`, error: e };
        }
        if (session !== this.session) return { kind: 'ended' as const };
        if (!r.written) return { kind: 'failed' as const, reason: '没能存到本机' };
      }
      const rows = plan.rows.filter((snap) => keep(snap.sourceKey));
      for (const snap of rows) this.snapshots.set(snap.sourceKey, snap);
      plan.commit(keep);
      return { kind: 'landed' as const, rows };
    });
  }

  /** the newest read of this item that landed in this source (recorded only once its rows were on disk) */
  private readAt(sourceKey: string, key: string): number {
    return Math.max(this.sourceReadAt.get(sourceKey) ?? 0, this.itemReadAt.get(`${sourceKey}\n${key}`) ?? 0);
  }

  /**
   * GitHub#229 (PR #240 plan revision 1): what GitHub holds in this field, from reads issued
   * at `since` or later that landed — the one place every decision taken on GitHub's value
   * reads it (the checks of a change, the end of a watch, the check before a resend).
   * Only the board data counts, never a read's own answer: an answer that came back after a
   * newer one, or whose rows never reached the disk, is no evidence. Among the sources that
   * qualify the newest read wins. A Project field is only read in that Project's source;
   * an item a qualifying Project source no longer has is `absent` there.
   * `own`: the read's own copy, passed only when no source carries the item at all (then
   * nothing newer can have landed) — labels and milestone only, a Project field never.
   * null: no evidence that new.
   */
  private evidence(key: string, field: EditField, since: number, own: Item | null = null): { value: EditValue } | 'absent' | null {
    let best: { value: EditValue; at: number } | null = null;
    let absent = false;
    for (const snap of this.snapshots.values()) {
      const at = this.readAt(snap.sourceKey, key);
      if (at < since) continue;
      if ((field.kind === 'status' || field.kind === 'iteration') && snap.project?.key !== field.projectKey) continue;
      const item = snap.items.find((i) => i.key === key);
      const value = item ? fieldValue(item, field) : undefined;
      if (value === undefined) {
        if (field.kind === 'status' || field.kind === 'iteration') absent = true;
        continue;
      }
      if (!best || at > best.at) best = { value, at };
    }
    if (best) return { value: best.value };
    if (own && field.kind !== 'status' && field.kind !== 'iteration') {
      const value = fieldValue(own, field);
      if (value !== undefined) return { value };
    }
    return absent ? 'absent' : null;
  }

  private bumpEpoch(key: string): void {
    this.epochs.set(key, ++this.epochSeq);
  }

  /**
   * Which kind of GitHub application the next sign-in uses. It never touches
   * the current sign-in: a token is refreshed with the app it came from.
   */
  setAppKind(kind: string): void {
    if (!APP_KINDS.includes(kind as AppKind)) return;
    const k = kind as AppKind;
    this.cache.setSetting('appKind', k);
    this.set({ appKind: k, ...this.clientIdFor(k) });
  }

  /** Saves the Client ID override of the kind currently chosen; '' = back to the built-in one. */
  setClientId(id: string): void {
    const v = id.trim();
    this.cache.setSetting(CLIENT_ID_SETTING[this.state.appKind], v);
    this.set(this.clientIdFor(this.state.appKind));
  }

  private clientIdFor(kind: AppKind): { clientId: string; clientIdIsDefault: boolean } {
    const override = this.cache.getSetting<string>(CLIENT_ID_SETTING[kind], '');
    return { clientId: override || this.defaultClientIds[kind], clientIdIsDefault: !override };
  }

  /**
   * The saved choice; OAuth app when none was saved. A preview build had only
   * one Client ID box: a GitHub App's ID saved there (they start with "Iv",
   * an OAuth app's with "Ov" or a hex string) means that user had chosen a
   * GitHub App, so it moves to the GitHub App's box and that kind is kept.
   */
  private loadAppKind(): AppKind {
    const saved = this.cache.getSetting<string | null>('appKind', null);
    if (APP_KINDS.includes(saved as AppKind)) return saved as AppKind;
    const old = this.cache.getSetting<string>(CLIENT_ID_SETTING.oauth, '');
    const kind: AppKind = /^Iv/.test(old) ? 'github-app' : 'oauth';
    if (kind === 'github-app') {
      this.cache.setSetting(CLIENT_ID_SETTING['github-app'], old);
      this.cache.setSetting(CLIENT_ID_SETTING.oauth, '');
    }
    this.cache.setSetting('appKind', kind);
    return kind;
  }

  // ---- sources & view ------------------------------------------------------

  addSource(input: string): { ok: boolean; error?: string } {
    const src = parseSource(input);
    if (!src) return { ok: false, error: '认不出这个地址：Project 请贴网址（https://github.com/orgs/<组织>/projects/<编号>），仓库写「组织/仓库名」' };
    if (this.state.sources.some((s) => s.key === src.key)) return { ok: false, error: '这个来源已经加过了' };
    const sources = [...this.state.sources, src];
    this.bumpEpoch(src.key);
    this.cache.setSetting('sources', sources);
    const view = this.state.view.selected ? { ...this.state.view, selected: [...this.state.view.selected, src.key] } : this.state.view;
    this.cache.setSetting('view', view);
    // a Project brings its saved web view along (again when it is removed and added back)
    if (src.kind === 'project') {
      const pending = this.pendingImports().filter((p) => p.sourceKey !== src.key);
      this.cache.setSetting(PENDING_IMPORTS, [...pending, { sourceKey: src.key, ...(src.view !== undefined ? { view: src.view } : {}), touched: [] }]);
    }
    this.set({ sources, view });
    void this.syncNow();
    return { ok: true };
  }

  removeSource(key: string): void {
    const sources = this.state.sources.filter((s) => s.key !== key);
    // GitHub#397: an open tab's item this source carried stays known — as the tab's own copy, off any board
    for (const t of this.tabList) {
      const it = this.snapshots.get(key)?.items.find((i) => i.key === t.key);
      if (it && !this.tabOwn.has(t.key)) this.tabOwn.set(t.key, { ...it, projects: [], sources: [] });
    }
    this.bumpEpoch(key);
    // GitHub#258: its watches and their buttons end with it (adding it again does not bring them back)
    for (const j of this.state.creates) if (j.watch?.some((w) => w.projectKey === key)) this.patchWatch(j.id, key, () => null);
    this.cache.setSetting('sources', sources);
    this.cache.deleteSnapshot(key);
    this.snapshots.delete(key);
    this.checks.delete(key);
    this.checkedAt.delete(key);
    // GitHub#229: the read times of that addition go with it
    this.sourceReadAt.delete(key);
    for (const k of [...this.itemReadAt.keys()]) if (k.startsWith(`${key}\n`)) this.itemReadAt.delete(k);
    // its own items stop counting, silently
    this.pending.prune(sources.map((s) => s.key));
    this.badge();
    this.state = { ...this.state, ...this.pendingNow() };
    const view = this.state.view.selected ? { ...this.state.view, selected: this.state.view.selected.filter((k) => k !== key) } : this.state.view;
    this.cache.setSetting('view', view);
    this.cache.setSetting(PENDING_IMPORTS, this.pendingImports().filter((p) => p.sourceKey !== key));
    this.set({ sources, view, sync: { ...this.state.sync, sources: this.state.sync.sources.filter((s) => s.sourceKey !== key) } });
    // GitHub#397: and those items are checked by themselves from now on — the first time right away
    if (this.tabList.length && this.signedIn) void this.checkTabs();
  }

  /** A change made by the user. Invalid values are ignored as a whole. */
  setView(patch: ViewPatch): void {
    const merged = {
      ...this.state.view,
      ...patch,
      table: { ...this.state.view.table, ...(patch.table ?? {}) },
      showClosed: { ...this.state.view.showClosed, ...(patch.showClosed ?? {}) },
    };
    if (!isValidView(merged)) return;
    const view: ViewSettings = merged;
    const touched = Object.keys(patch).flatMap((k) => (k === 'table' ? Object.keys(patch.table ?? {}).map((t) => `table.${t}`) : [k]));
    const pending = this.pendingImports();
    if (pending.length && touched.length) {
      this.cache.setSetting(
        PENDING_IMPORTS,
        pending.map((p) => ({ ...p, touched: [...new Set([...p.touched, ...touched])] })),
      );
    }
    this.cache.setSetting('view', view);
    this.set({ view });
  }

  private pendingImports(): PendingImport[] {
    const raw = this.cache.getSetting<unknown>(PENDING_IMPORTS, []);
    return Array.isArray(raw) ? raw.filter((p): p is PendingImport => typeof p?.sourceKey === 'string' && Array.isArray(p.touched)) : [];
  }

  /** Apply the saved web view of Projects read completely for the first time since they were added. */
  private applyImports(accepted: SourceSnapshot[]): void {
    let pending = this.pendingImports();
    if (!pending.length) return;
    let view = this.state.view;
    for (const snap of accepted) {
      const p = pending.find((x) => x.sourceKey === snap.sourceKey);
      if (!p || !snap.project) continue;
      pending = pending.filter((x) => x !== p);
      const { view: saved, note } = pickView(snap.project, p.view);
      if (!saved) {
        view = { ...view, imported: { sourceKey: snap.sourceKey, viewNumber: 0, viewName: '', notes: [note!] } };
        continue;
      }
      const patch = importView(saved, snap.project, view, note);
      const next: ViewSettings = { ...view, table: { ...view.table } };
      for (const k of ['layout', 'query', 'mode', 'swimlanes'] as const) {
        if (!p.touched.includes(k)) (next as any)[k] = patch[k];
      }
      for (const k of Object.keys(patch.table) as (keyof ViewSettings['table'])[]) {
        if (!p.touched.includes('table') && !p.touched.includes(`table.${k}`)) (next.table as any)[k] = patch.table[k];
      }
      next.imported = patch.imported;
      view = normalizeView(next);
    }
    this.cache.setSetting(PENDING_IMPORTS, pending);
    if (view !== this.state.view) {
      this.cache.setSetting('view', view);
      this.state = { ...this.state, view };
    }
  }

  // ---- sync ----------------------------------------------------------------

  /** Run one round; a call during a round queues exactly one more round. */
  syncNow(): Promise<void> {
    if (this.syncing) {
      this.resync = true;
      return this.syncing;
    }
    // GitHub#324: this round is the sync a waiting timed round was for — no alarm outlives its start
    this.cancelAlarm();
    this.syncing = (async () => {
      try {
        do {
          this.resync = false;
          try {
            await this.runOne();
          } catch (e) {
            // a round must never reject: the 60 s timer and the window would see an unhandled rejection
            this.set({ sync: { ...this.state.sync, syncing: false, problem: `同步出错：${(e as Error).message}` } });
          }
          // GitHub#397: with every round — however it ended, also one that had no source left to read (they
          // all wait after failing) — the open tabs no complete read carries are checked one by one. Not while
          // GitHub cannot be reached, nor while it says "rate limited": then nothing more is asked of it.
          if (this.signedIn && this.state.phase === 'ready' && !this.state.sync.offline && !this.state.sync.sources.some((st) => st.rateLimited)) void this.checkTabs();
        } while (this.resync && this.signedIn);
      } finally {
        this.syncing = null;
        // GitHub#324: the one place the earliest timed round is written — syncing went idle,
        // however it ended. (A round dropped by a refresh by hand ends outside this loop.)
        // Only a stretch that ran over a beat is followed by the gap: one that fits between two
        // beats keeps the beat's own pace, with no alarm to depend on (a hidden window's timers
        // are slowed down, the shell's beat is not — GitHub#169, and the 2 minutes of GitHub#139).
        this.timedDueAt = this.timedSwallowed ? this.now() + this.timedGapMs : null;
        this.timedSwallowed = false;
        // no round runs any more: a dropped round set "syncing" and the next one may have ended early
        if (this.state.sync.syncing) this.set({ sync: { ...this.state.sync, syncing: false } });
      }
    })();
    return this.syncing;
  }

  /**
   * GitHub#324: a timed round is due — the window's timer, the shell's beat and the alarm all end
   * here, and nowhere else decides it. Operations and the refresh by hand call `syncNow` /
   * `restartSync` as before and are never held back.
   *   syncing            no round is queued behind it; only "a beat came meanwhile" is noted, which
   *                      makes the gap follow this stretch (the beat never stops, so the next one
   *                      arrives within its interval after syncing goes idle — it sets the alarm)
   *   idle, too early    the one alarm is set for the earliest moment (kept if it is already that)
   *   idle, due          a round starts (`syncNow` clears the alarm)
   *   not signed in      no round; the alarm goes
   * `everyMs`: the beat's own interval, when its keeper says it — the gap from then on.
   */
  private timedSync(everyMs?: unknown): void {
    if (typeof everyMs === 'number' && Number.isFinite(everyMs) && everyMs >= 0) this.timedGapMs = everyMs;
    if (!this.signedIn) return this.cancelAlarm();
    if (this.syncing) {
      this.timedSwallowed = true;
      return;
    }
    const wait = this.timedWait();
    if (wait <= 0) {
      void this.syncNow();
      return;
    }
    const at = this.timedDueAt!;
    const session = this.session;
    if (this.alarm && this.alarm.at === at && this.alarm.session === session) return;
    this.cancelAlarm();
    const handle = this.timers.setTimeout(() => {
      // replaced or cancelled meanwhile: not this one's turn any more
      if (this.alarm?.handle !== handle) return;
      this.alarm = null;
      // set in a session that is over: it starts nothing in the next one
      if (session !== this.session) return;
      this.timedSync();
    }, wait);
    this.alarm = { handle, at, session };
  }

  /** ms until a timed round may start (<= 0: now). A clock that went back never makes it wait longer than the gap. */
  private timedWait(): number {
    if (this.timedDueAt === null) return 0;
    const wait = this.timedDueAt - this.now();
    return wait > this.timedGapMs ? 0 : wait;
  }

  private cancelAlarm(): void {
    if (!this.alarm) return;
    this.timers.clearTimeout(this.alarm.handle);
    this.alarm = null;
  }

  /** The beat stopped, or the session changed: no alarm, and the next timed round is not held back. */
  private resetTimed(): void {
    this.cancelAlarm();
    this.timedDueAt = null;
    this.timedSwallowed = false;
  }

  /**
   * Refresh asked for by hand — the button or its key (GitHub#217): start over now.
   * A round that is reading GitHub is dropped: nothing it read lands anywhere, it
   * sends no further request (one already sent runs out, its answer is thrown away),
   * and a new round starts at once. A round renewing the sign-in or saving what it
   * read is not cut there (a half-done renewal can lose the sign-in, a half-done save
   * would race the new round's): it finishes, then the new round starts right after.
   * The timer and every other automatic caller keep queueing (`syncNow`): automatic
   * rounds never cut each other short. GitHub#261: the round started by hand reads every
   * source in full (the change check's "nothing changed" is not taken for it).
   */
  restartSync(): Promise<void> {
    // GitHub#261: by hand = read every source in full now, whatever the change check would say
    this.fullReadNext = true;
    // GitHub#374: and now — not after a rate limit's reset time (if GitHub still says no, the new gate closes again).
    // A new gate, not the old one opened: a dropped round's late answer can only reach the gate it was sent through.
    this.readGate = new ReadGate(this.now);
    // GitHub#397: and every open tab no source lists, also an ended one checked a moment ago
    this.tabsForce = true;
    if (this.round?.reading) this.round.drop();
    return this.syncNow();
  }

  /** One round, given up on (without waiting for it) when it is dropped. */
  private runOne(): Promise<void> {
    const abort = new AbortController();
    let dropped!: () => void;
    const gone = new Promise<void>((r) => (dropped = r));
    const run: SyncRun = {
      signal: abort.signal,
      reading: false,
      drop: () => {
        abort.abort();
        this.resync = true;
        dropped();
      },
    };
    this.round = run;
    // the dropped round goes on alone until its next check; whatever it ends in is nobody's business
    const done = this.runRound(run).catch((e) => {
      if (!abort.signal.aborted) throw e;
    });
    return Promise.race([done, gone]).finally(() => {
      if (this.round === run) this.round = null;
    });
  }

  private async runRound(run: SyncRun, retried = false): Promise<void> {
    if (!this.signedIn) return;
    const { result: fresh, reason: freshReason } = await this.freshOut();
    if (fresh === 'ended' || !this.signedIn) return;
    await this.saveUnsaved();
    const info = await this.backend.call<GrantInfo>('grantInfo');
    if (!info.signedIn || info.session !== this.session) return;
    // GitHub#401: the failure explanations speak of the app this sign-in used
    const kind = info.githubApp ? 'github-app' : 'oauth';
    if (this.state.signedInAppKind !== kind) this.set({ signedInAppKind: kind });
    if (fresh !== 'ok' && info.expired) {
      // expired and no new token (GitHub unreachable, or the refresh failed for a reason
      // that does not prove the credential dead): keep everything, the cache stays
      this.set({ sync: { ...this.state.sync, syncing: false, ...offlineFields(fresh === 'unreachable', freshReason) } });
      return;
    }
    const session = this.session;
    // GitHub#374: the gate and the failures in a row are of one session
    if (this.readsSession !== session) {
      this.readGate = new ReadGate(this.now);
      this.failures.clear();
      this.readsSession = session;
    }
    const configured = this.state.sources;
    const epochAtStart = new Map(configured.map((src) => [src.key, this.epochs.get(src.key) ?? 0]));
    this.set({ sync: { ...this.state.sync, syncing: true } });
    // the one stretch a restart may cut: reading GitHub (GitHub#217)
    run.reading = true;
    // GitHub#229: every read of this round went out after this stamp (a lower bound is what the check of a change needs)
    const issuedAt = this.stamp();
    // GitHub#261: only records of this session and of the very addition of each source
    if (this.checksSession !== session) {
      this.checks.clear();
      this.checksSession = session;
    }
    // the very record objects this round starts from: at its end it may only drop those (PR #272 review round 2)
    const held = new Map(this.checks);
    const recorded = new Map<string, SourceCheck>();
    // refresh by hand: no record is offered, so every source is read in full (and new tags are taken)
    const byHand = this.fullReadNext;
    this.fullReadNext = false;
    // GitHub#374: a source that keeps failing waits its turn (1, 2, 4, 8, 10 min); by hand, nobody waits.
    // The ones left out keep their status (failure and next try) as it is.
    const startedAt = this.now();
    const sources = byHand ? configured : configured.filter((src) => !this.waiting(src.key, epochAtStart.get(src.key) ?? 0, startedAt));
    if (!byHand) for (const [key, c] of this.checks) if (c.epoch === epochAtStart.get(key)) recorded.set(key, c.check);
    // GitHub#324: how far the round is, for the hover of the header (a dropped round reports nothing more)
    const total = sources.length;
    let done = 0;
    const progress = () => {
      if (this.round !== run || run.signal.aborted || !this.state.sync.syncing) return;
      this.set({ sync: { ...this.state.sync, progress: { startedAt, done, total } } });
    };
    progress();
    const gate = this.readGate;
    const reads = { gate, retryDelaysMs: this.deps.readRetryDelaysMs ?? READ_RETRY_DELAYS_MS };
    const round = await syncRound(
      this.client(session, run.signal, reads),
      sources,
      this.snapshots,
      startedAt,
      recorded,
      this.deps.fullReadEveryMs ?? FULL_READ_EVERY_MS,
      () => {
        done++;
        progress();
      },
      this.state.handBack.blocked,
      // GitHub#462: a repository's closed items carrying the pending label are read too
      this.state.handBack.human,
    );
    run.reading = false;
    // Every source this round did not confirm unchanged needed a full read (it changed, the check could
    // not tell, 10 minutes were up, or the refresh was by hand). Its old record goes now, before anything
    // can fail: until a new one lands with the read, the next round reads it in full again — a read that
    // never landed (dropped round, failed or refused save, another account) is retried, never skipped
    // (PR #272 review round 1). Only a record that is still the one this round started from: a round
    // dropped by a refresh by hand finishes in the background, possibly after the newer round saved its
    // own record — that one is not this round's to drop (review round 2).
    this.dropChecks(sources.filter((src) => !round.unchanged.includes(src.key)), held);
    this.deps.afterRoundRead?.(run.signal.aborted);
    // dropped meanwhile: a newer round owns the state now, nothing of this one may land
    if (run.signal.aborted) return;
    const over = () => {
      // logged out / another account logged in meanwhile: nothing of this round may land
      this.set({ sync: { ...this.state.sync, syncing: false } });
    };
    if (session !== this.session) return over();
    // GitHub says who this token belongs to; data of anybody else goes first.
    if (round.viewer) {
      const a = await this.backend.call<{ wiped?: boolean; stale?: boolean; problem?: string }>('adoptViewer', { session, login: round.viewer });
      if (a.problem) this.setProblem(a.problem);
      if (a.stale || session !== this.session) return over();
      if (a.wiped) this.dropMirror();
    }
    // Only sources still configured *as the same addition* the round started with.
    // A source removed (or removed and re-added) meanwhile is skipped everywhere:
    // database, memory and status all take this one filtered result.
    const current = (key: string) =>
      this.state.sources.some((s) => s.key === key) && (this.epochs.get(key) ?? 0) === epochAtStart.get(key);
    // GitHub#229: an item re-read after this round started keeps that newer copy
    const landing = await this.landSnapshots(session, () => this.roundRows(round.replaced.filter((snap) => current(snap.sourceKey)), issuedAt), current);
    if (landing.kind === 'failed' && landing.error !== undefined) throw landing.error;
    // a source removed while the write was on its way: not shown either
    if (landing.kind !== 'landed') return over();
    const accepted = landing.rows;
    this.keepChecks(session, round.checks, sources, epochAtStart);
    this.feedSnapshots(accepted, issuedAt);
    for (const key of new Set([...this.ops.values()].map((r) => r.key))) if (accepted.some((snap) => snap.items.some((i) => i.key === key))) this.feedOps(key, issuedAt);
    this.applyImports(accepted);
    // Only what was read completely this round (and still belongs here) is compared.
    this.observePending(accepted, round.viewer ?? this.state.viewer);
    // GitHub#266: the back end wrote it when it adopted the viewer, under the session check;
    // a write from here could land after a sign-out and put the old name back
    if (round.viewer) this.cache.mirror('viewer', round.viewer);
    const status = round.status
      .filter((st) => current(st.sourceKey))
      .map((st) => (st.ok ? st : { ...st, dataFrom: this.snapshots.get(st.sourceKey)?.fetchedAt ?? null }))
      // GitHub#374: a round that could not use GitHub at all, or whose credential was refused, says
      // nothing about any source: no count moves
      .map((st) => (round.offline || round.authFailed ? st : this.noteResult(st, startedAt, epochAtStart.get(st.sourceKey) ?? 0, gate)));
    // GitHub#374: a round that reached GitHub and heard no limit anywhere ends a run of limits
    if (!round.offline && !round.held && !round.status.some((st) => st.rateLimited)) gate.roundClean();
    const untouched = this.state.sync.sources.filter((st) => !status.some((x) => x.sourceKey === st.sourceKey) && this.state.sources.some((x) => x.key === st.sourceKey));
    // GitHub#324: read in full or confirmed unchanged this round — and only then: a source that
    // failed keeps the time it had
    for (const st of status) if (st.ok && st.dataFrom !== null) this.checkedAt.set(st.sourceKey, Math.max(st.dataFrom, this.checkedAt.get(st.sourceKey) ?? 0));
    this.set({
      viewer: round.viewer ?? this.state.viewer,
      sync: {
        ...this.state.sync,
        syncing: false,
        ...offlineFields(round.offline, round.offlineReason),
        // GitHub#374: a round the closed gate kept at home did not reach GitHub either
        lastOnlineAt: round.offline || round.held ? this.state.sync.lastOnlineAt : this.now(),
        sources: [...status, ...untouched],
      },
    });
    // GitHub#279: the round reached GitHub (read, or confirmed unchanged): re-read what an earlier re-read missed
    if (!round.offline && !round.authFailed && status.some((st) => st.ok)) {
      await this.catchUpReads(session);
      // GitHub#359: and check again what an operation's answer that never came left open
      this.catchUpChecks(session);
      // GitHub#489: and what a reply's / an edit's
      this.catchUpSends(session);
    }
    if (round.authFailed) {
      // A GitHub App token can be refreshed once before the credential is declared dead —
      // the token this round used, not one that changed meanwhile.
      if (!retried && session === this.session && info.canRefresh) {
        const { result: r, reason } = await this.freshOut(true, info.gen);
        if (r === 'ok') return this.runRound(run, true);
        if (r === 'unreachable') this.set({ sync: { ...this.state.sync, ...offlineFields(true, reason) } });
        if (r !== 'changed') return; // 'failed': kept signed in with the problem shown; 'ended': already signed out
      }
      if (session === this.session && this.signedIn) await this.logout(REASON_REVOKED);
    }
  }

  /**
   * GitHub#261: after a round landed, keep each source's new change-check record only if the
   * snapshot in memory is the one it vouches for (same fetchedAt), the source is still the same
   * addition and the session is the round's. Every other source of the round loses its record:
   * its next round is a full read.
   */
  private keepChecks(session: number, fresh: Map<string, SourceCheck>, sources: SourceConfig[], epochAtStart: Map<string, number>): void {
    for (const src of sources) {
      const c = fresh.get(src.key);
      const epoch = epochAtStart.get(src.key) ?? 0;
      const holds =
        c &&
        session === this.session &&
        this.checksSession === session &&
        (this.epochs.get(src.key) ?? 0) === epoch &&
        this.state.sources.some((s) => s.key === src.key) &&
        this.snapshots.get(src.key)?.fetchedAt === c.snapshotAt;
      if (holds) this.checks.set(src.key, { epoch, check: c });
      else this.checks.delete(src.key);
    }
  }

  /**
   * GitHub#261: forget the records of `sources` — each only while it is still the record object the
   * round started from (`held`). A record written since (a newer round's, another session's after a
   * clear) is someone else's; one cleared meanwhile stays cleared.
   */
  private dropChecks(sources: SourceConfig[], held: Map<string, { epoch: number; check: SourceCheck }>): void {
    for (const src of sources) {
      const c = this.checks.get(src.key);
      if (c && c === held.get(src.key)) this.checks.delete(src.key);
    }
  }

  /** A GitHub client whose requests the back end signs for `session`; `reads`: the sync's own (GitHub#374). */
  private client(session: number, signal?: AbortSignal, reads?: ConstructorParameters<typeof GitHubClient>[4]): GitHubClient {
    return new GitHubClient(this.deps.endpoints, null, proxyFetch(this.backend, session), signal, reads);
  }

  /**
   * GitHub#374: is this source (as the addition `epoch`) still waiting for its next automatic read?
   * A little early counts as due: the beat that should read it starts just before the time set.
   */
  private waiting(key: string, epoch: number, now: number): boolean {
    const f = this.failures.get(key);
    return !!f && f.epoch === epoch && f.nextAt !== null && now < f.nextAt - RETRY_SLACK_MS;
  }

  /**
   * GitHub#374: one source's result of a round into its failures in a row — the one place they
   * change. Read = forgotten. Failed = one more, the next automatic read 1, 2, 4, 8, 10 min after
   * this round started. Rate limited = not counted (it says nothing about the source); the next
   * read is when the gate opens.
   */
  private noteResult(st: SourceStatus, at: number, epoch: number, gate: ReadGate): SourceStatus {
    if (st.ok) {
      this.failures.delete(st.sourceKey);
      return st;
    }
    const prev = this.failures.get(st.sourceKey);
    const old = prev && prev.epoch === epoch ? prev : null;
    if (st.rateLimited) {
      const until = gate.until;
      const f = { count: old?.count ?? 0, since: old?.since ?? at, nextAt: null, epoch };
      this.failures.set(st.sourceKey, f);
      return { ...st, retry: { count: f.count, since: f.since, nextAt: until, limitedUntil: until } };
    }
    const count = (old?.count ?? 0) + 1;
    const f = { count, since: old?.since ?? at, nextAt: at + backoffStep(count), epoch };
    this.failures.set(st.sourceKey, f);
    return { ...st, retry: { count, since: f.since, nextAt: f.nextAt, limitedUntil: null } };
  }

  // ---- view & change one item ---------------------------------------------

  /** Labels "hand back to the agent" swaps; empty names fall back to the defaults. */
  /** The user picked a merge method for a PR in `repo` (GitHub#175). An unknown method is ignored. */
  setMergeMethod(repo: string, method: unknown): void {
    const next = rememberMergeMethod(this.state.mergePrefs, repo, method);
    if (next === this.state.mergePrefs) return;
    this.cache.setSetting(MERGE_PREFS, next);
    this.set({ mergePrefs: next });
  }

  /** GitHub#231: a table group folded or unfolded. Unknown input is ignored. */
  setTableFold(groupBy: unknown, key: unknown, folded: unknown): void {
    const next = setFold(this.state.tableFolds, groupBy, key, folded);
    if (next === this.state.tableFolds) return;
    this.cache.setSetting(TABLE_FOLDS, next);
    this.set({ tableFolds: next });
  }

  /** GitHub#297: a board swimlane (repository) folded or unfolded. Unknown input is ignored. */
  setLaneFold(lane: unknown, folded: unknown): void {
    const next = setLaneFold(this.state.laneFolds, lane, folded);
    if (next === this.state.laneFolds) return;
    this.cache.setSetting(LANE_FOLDS, next);
    this.set({ laneFolds: next });
  }

  /** GitHub#369: switching to the window takes back every delivered notification (true) or none (false, the default). Anything but a boolean is ignored. */
  setClearAllOnActivate(on: unknown): void {
    if (typeof on !== 'boolean' || on === this.state.clearAllOnActivate) return;
    this.cache.setSetting(CLEAR_ALL_ON_ACTIVATE, on);
    this.set({ clearAllOnActivate: on });
  }

  /**
   * GitHub#373: which pending items remind — every one ('all') or only the ones that concern the
   * signed-in account ('mine'). Recounted silently, like another label name: a settings change is
   * not new work arriving, so nothing is notified and nothing becomes unread; a notification
   * queued before it does not go out. Anything but the two words is ignored.
   */
  setNotifyScope(scope: unknown): void {
    if ((scope !== 'all' && scope !== 'mine') || scope === this.state.notifyScope) return;
    this.cache.setSetting(NOTIFY_SCOPE, scope);
    this.labelVersion++;
    this.pending.setAudience({ scope, viewer: this.state.viewer });
    // what was unread and no longer reminds is not counted; what reminds only now was never unread
    for (const k of [...this.unread]) if (!this.pending.has(k)) this.unread.delete(k);
    this.badge();
    this.state = { ...this.state, ...this.pendingNow() };
    this.set({ notifyScope: scope });
  }

  /** the system's preferred languages ("跟随系统"); unreadable = none, which is Chinese */
  private systemLanguages(): readonly string[] {
    try {
      return (this.deps.languages ?? preferredLanguages)();
    } catch {
      return [];
    }
  }

  /** the back end's words (menu, its messages) follow the window's; a refusal changes nothing on this side */
  private tellBackendLanguage(lang: Lang): void {
    void this.cache.enqueue(() => this.backend.call('setLanguage', { lang })).catch(() => undefined);
  }

  /**
   * GitHub#471: the interface language — 'zh' (default), 'en', or 'auto' (the system's). Takes
   * effect at once: the whole window re-renders from the new state, the back end is told, and the
   * choice is kept on this machine. Anything but the three words is ignored.
   */
  setUiLanguage(setting: unknown): void {
    if (setting !== 'zh' && setting !== 'en' && setting !== 'auto') return;
    const lang = resolveLang(setting, this.systemLanguages());
    if (setting !== this.state.uiLanguage) this.cache.setSetting(LANG_SETTING, setting);
    const changed = lang !== this.state.lang;
    setLang(lang);
    if (changed) this.tellBackendLanguage(lang);
    if (setting !== this.state.uiLanguage || changed) this.set({ uiLanguage: setting, lang });
  }

  /**
   * GitHub#487: change one shortcut's key, or put it back to its defaults (`spec` null). The whole table in effect
   * is checked (`changeKey`); refused = nothing written, nothing changed, the reason handed back.
   */
  setShortcutKey(id: unknown, spec: unknown): ShortcutKeyResult {
    const r = changeKey(this.state.shortcutKeys as CustomKeys, id, spec);
    if (!r.ok) return { ok: false, why: r.why };
    this.cache.setSetting(SHORTCUT_KEYS, r.keys);
    this.set({ shortcutKeys: r.keys as Record<string, ShortcutKeySpec>, shortcutDropped: this.state.shortcutDropped.filter((d) => d.id !== id) });
    return { ok: true };
  }

  /** GitHub#487: every shortcut back to its default keys (the defaults have no conflict, so this always works) */
  resetShortcutKeys(): void {
    this.cache.setSetting(SHORTCUT_KEYS, {});
    this.set({ shortcutKeys: {}, shortcutDropped: [] });
  }

  /** GitHub#231: "托管" asks first (true) or not ("不再提示", false). Anything but a boolean is ignored. */
  setAutopilotConfirm(on: unknown): void {
    if (typeof on !== 'boolean' || on === this.state.autopilotConfirm) return;
    this.cache.setSetting(AUTOPILOT_CONFIRM, on);
    this.set({ autopilotConfirm: on });
  }

  /**
   * GitHub#304: a repository dragged. `shown` = the list on screen before the drag (the search may hide
   * others), `next` = the same repositories in the new order; merged into the order saved now, so the
   * hidden ones keep their places. Anything else (not two lists of the same repositories) is ignored.
   */
  reorderRepos(shown: unknown, next: unknown): void {
    if (!Array.isArray(shown) || !Array.isArray(next)) return;
    const out = reorderRepos(this.state.repoOrder, shown, next);
    if (!out) return;
    this.cache.setSetting(REPO_ORDER, out);
    this.set({ repoOrder: out });
  }

  /** GitHub#304: "按名称排序" — back to alphabetical. */
  resetRepoOrder(): void {
    if (this.state.repoOrder.length === 0) return;
    this.cache.setSetting(REPO_ORDER, []);
    this.set({ repoOrder: [] });
  }

  /** GitHub#245: who the next new issue is handed to by default (the dialog calls this after a create it was chosen for). Unknown values are ignored. */
  setNewIssueHandoff(h: unknown): void {
    if (typeof h !== 'string' || normalizeHandoff(h) !== h || h === this.state.newIssueHandoff) return;
    this.cache.setSetting(NEW_ISSUE_HANDOFF, h);
    this.set({ newIssueHandoff: h as Handoff });
  }

  // ---- GitHub#397: detail tabs ---------------------------------------------

  /** Every copy the configured sources hold of one item, as one: the newest, with every source that carries it. */
  private cachedCopy(key: string): Item | null {
    let best: Item | null = null;
    const sources: string[] = [];
    for (const src of this.state.sources) {
      const it = this.snapshots.get(src.key)?.items.find((i) => i.key === key);
      if (!it) continue;
      for (const k of it.sources) if (!sources.includes(k)) sources.push(k);
      if (!best || it.updatedAt > best.updatedAt) best = it;
    }
    return best ? { ...best, sources } : null;
  }

  /**
   * What the tabs show, from what is held now. An item a complete read of this run carries follows
   * the board; any other shows the newest copy known (its own check, a cached source, what the tab
   * showed last). The one place `state.tabs` is written.
   */
  private refreshTabs(): void {
    if (!this.tabList.length && !this.state.tabs.length) return;
    let stored = false;
    const tabs: TabInfo[] = this.tabList.map((t) => {
      const cached = this.cachedCopy(t.key);
      const listed = listedNow(cached, this.state.sync.sources);
      let item: TabSummary;
      if (listed) {
        this.tabOwn.delete(t.key);
        this.tabChecked.delete(t.key);
        item = summarize(cached!);
      } else {
        const own = this.tabOwn.get(t.key);
        item = newestCopy([own ? summarize(own) : null, cached ? summarize(cached) : null, t.item])!;
      }
      if (JSON.stringify(item) !== JSON.stringify(t.item)) {
        t.item = item;
        stored = true;
      }
      return { key: t.key, item: t.item, seen: t.seen, listed, checkedAt: listed ? null : (this.tabChecked.get(t.key) ?? null) };
    });
    if (stored) this.storeTabs();
    if (JSON.stringify(tabs) !== JSON.stringify(this.state.tabs)) this.state = { ...this.state, tabs };
  }

  private storeTabs(): void {
    this.cache.setSetting(
      TABS,
      this.tabList.map((t) => ({ key: t.key, item: t.item, seen: t.seen })),
    );
  }

  private dropTabs(): void {
    this.looseItems.clear();
    if (!this.tabList.length) return;
    this.tabList = [];
    this.tabOwn.clear();
    this.tabChecked.clear();
    this.looseItems.clear();
    this.storeTabs();
  }

  /**
   * The open tabs' items whole (the detail needs more than the summary), wherever the view's copy is
   * missing or older than what the tab knows: an item no complete read carries, whose own check read a
   * newer copy than the source that failed kept (plan review: the detail's badge showed the cached
   * "open" while its tab said "closed"). The detail, its buttons and every change made from it take
   * this copy first — one item, one answer. Memberships stay the cached copy's (a check reads no board).
   */
  private tabItemsFresh(shown: Item[]): Item[] {
    if (!this.tabList.length) return [];
    const out: Item[] = [];
    let all: Item[] | null = null;
    for (const t of this.tabList) {
      all ??= this.cachedItems();
      const cached = all.find((i) => i.key === t.key) ?? null;
      const inView = shown.find((i) => i.key === t.key) ?? null;
      if (listedNow(cached, this.state.sync.sources)) {
        if (!inView && cached) out.push(cached);
        continue;
      }
      const own = this.tabOwn.get(t.key) ?? null;
      const pick = newestCopy([own, cached]);
      if (!pick) continue;
      const it = pick === own && cached ? { ...own!, projects: cached.projects, sources: cached.sources } : pick;
      if (inView && it === cached) continue;
      out.push(it);
    }
    return out;
  }

  /** Open `key` in a tab (false: no such item is known). An item already open keeps its tab. */
  openTab(key: unknown): boolean {
    if (typeof key !== 'string' || this.state.phase !== 'ready') return false;
    if (this.tabList.some((t) => t.key === key)) return true;
    // what the view shows, else any configured source's copy (its source may be unticked), else an item
    // this run read by itself and no source carries (a new issue no source lists yet)
    const loose = this.looseItems.get(key);
    const item = this.findItem(key) ?? this.cachedItems().find((i) => i.key === key) ?? loose ?? null;
    if (!item) return false;
    if (item === loose) this.tabOwn.set(key, loose);
    this.tabList = [...this.tabList, { key, item: summarize(item), seen: null }];
    this.storeTabs();
    this.set({});
    return true;
  }

  closeTab(key: unknown): void {
    if (!this.tabList.some((t) => t.key === key)) return;
    this.tabList = this.tabList.filter((t) => t.key !== key);
    this.tabOwn.delete(key as string);
    this.tabChecked.delete(key as string);
    this.storeTabs();
    this.set({});
  }

  /** A tab dragged to position `to`. */
  moveTab(key: unknown, to: unknown): void {
    const next = moveTab(this.tabList, key, to);
    if (next === this.tabList) return;
    this.tabList = next;
    this.storeTabs();
    this.set({});
  }

  /** The tab is in front and shows the item as of `updatedAt`: nothing newer than that is news. */
  seenTab(key: unknown, updatedAt: unknown): void {
    const t = this.tabList.find((x) => x.key === key);
    if (!t || typeof updatedAt !== 'string' || t.seen === updatedAt) return;
    t.seen = updatedAt;
    this.storeTabs();
    this.set({});
  }

  /**
   * Check the open tabs' items no complete read carries, one request each. An open one with every
   * round; an ended one every ENDED_CHECK_MS — never "ended, so never again" (it is reopened, it is
   * commented on). A check that fails changes nothing and is due again with the next round.
   * `only`: just that tab, now (it came to the front, or its refresh button).
   */
  checkTabs(only?: string): Promise<void> {
    const force = this.tabsForce || only !== undefined;
    if (only === undefined) this.tabsForce = false;
    const run = async () => {
      const session = this.session;
      for (const t of [...this.tabList]) {
        if (only !== undefined && t.key !== only) continue;
        if (!this.tabList.some((x) => x.key === t.key)) continue;
        if (listedNow(this.cachedCopy(t.key), this.state.sync.sources)) continue;
        if (!tabCheckDue(t.item.state, this.tabChecked.get(t.key) ?? null, this.now(), force)) continue;
        const c = await this.clientForCall(false);
        if ('error' in c || c.session !== session) return;
        try {
          const fresh = await fetchItem(c.client, t.item.repo, t.item.number, this.now());
          if (session !== this.session) return;
          const item = contentToItem(fresh.content, [], []);
          // closed meanwhile: nothing of it is kept
          if (!item || !this.tabList.some((x) => x.key === t.key)) continue;
          this.tabOwn.set(t.key, item);
          this.markChecked(t.key);
          this.set({});
        } catch (e) {
          // could not read: what the tab shows stays, and it is due again with the next round
          this.noteAuthFailure(e);
        }
      }
    };
    const p = (this.tabsChecking ?? Promise.resolve()).then(run, run);
    this.tabsChecking = p;
    void p.finally(() => {
      if (this.tabsChecking === p) this.tabsChecking = null;
    });
    return p;
  }

  /**
   * An own check of `key` answered: when (for "is it due again"), and — strictly later than the last
   * answer — the news the open detail reads as "a fresh read landed" (two answers within one clock tick
   * must still be two).
   */
  private markChecked(key: string): void {
    const prev = this.tabChecked.get(key) ?? 0;
    this.tabChecked.set(key, Math.max(this.now(), prev + 1));
  }

  /** Every check of the tabs started so far has ended (tests wait for it). */
  async checkTabsSettled(): Promise<void> {
    while (this.tabsChecking) await this.tabsChecking;
  }

  /** The shell's "close" key found no tab in front: close the window the way its close button does. */
  async closeWindow(): Promise<void> {
    await this.deps.desktop?.closeWindow().catch(() => undefined);
  }

  /**
   * GitHub#467: how the window's top row sits. Anything unreadable (no shell, a failed or malformed
   * answer) is the system's own title bar: the page then leaves no room and moves nothing itself,
   * which is never worse than before this row existed.
   */
  async windowFrame(): Promise<WindowFrame> {
    const f = await this.deps.desktop?.windowFrame().catch(() => null);
    return { overlay: f?.overlay === true, fullscreen: f?.overlay === true && f.fullscreen === true };
  }

  async startDrag(): Promise<void> {
    await this.deps.desktop?.startDrag().catch(() => undefined);
  }

  async toggleZoom(): Promise<void> {
    await this.deps.desktop?.toggleZoom().catch(() => undefined);
  }

  /** GitHub#434: the other flow labels (empty = the default). The waiting label is `handBack.blocked` (setHandBack). */
  setBlockedLabels(patch: Partial<BlockedLabels>): void {
    const flow = typeof patch.flow === 'string' ? patch.flow.trim() || DEFAULT_BLOCKED_LABELS.flow : this.state.blockedLabels.flow;
    this.cache.setSetting(BLOCKED_LABELS, { flow });
    this.set({ blockedLabels: { blocked: this.state.handBack.blocked, flow } });
  }

  /** GitHub#468: the view-bar numbers as saved; a value that is not a whole valid table shows the default and says so */
  private loadTallies(): { tallies: TallyDef[] | null; talliesBroken: boolean } {
    const { tallies, broken } = normalizeTallies(this.cache.getSetting<unknown>(TALLIES_SETTING, null));
    return { tallies, talliesBroken: broken };
  }

  /**
   * GitHub#468: save the view-bar numbers. `null` = back to the default table. A table that does not read
   * back as valid (from a window of another version, say) is refused whole: nothing is saved.
   */
  setTallies(next: TallyDef[] | null): void {
    const { tallies, broken } = normalizeTallies(next);
    if (broken) return;
    this.cache.setSetting(TALLIES_SETTING, tallies);
    this.set({ tallies, talliesBroken: false });
  }

  setHandBack(patch: Partial<HandBackLabels>): void {
    const next: HandBackLabels = {
      human: (patch.human ?? this.state.handBack.human).trim() || DEFAULT_HAND_BACK.human,
      agent: (patch.agent ?? this.state.handBack.agent).trim() || DEFAULT_HAND_BACK.agent,
      // empty is a choice here: no autopilot button (a project without autopilot)
      autopilot: typeof patch.autopilot === 'string' ? patch.autopilot.trim() : this.state.handBack.autopilot,
      // GitHub#404: empty is a choice too — the view bar leaves out "运行中"
      running: typeof patch.running === 'string' ? patch.running.trim() : this.state.handBack.running,
      // GitHub#429: empty is a choice — the graph then draws GitHub's own relations only
      blocked: typeof patch.blocked === 'string' ? patch.blocked.trim() : this.state.handBack.blocked,
      // GitHub#513: empty is a choice — label pickers then pin no parked label
      later: typeof patch.later === 'string' ? patch.later.trim() : this.state.handBack.later,
    };
    this.cache.setSetting('handBack', next);
    // The same label is what reminders count: another name is recounted silently
    // (a settings change is not new work arriving).
    if (next.human !== this.state.handBack.human) {
      this.labelVersion++;
      this.pending.relabel(next.human, this.snapshots);
      this.badge();
      this.state = { ...this.state, ...this.pendingNow() };
    }
    // GitHub#462: a repository's closed items carrying the new pending label are not held yet — read them now
    const reread = next.blocked !== this.state.handBack.blocked || next.human !== this.state.handBack.human;
    // GitHub#434: "等前置…" uses the same waiting label
    this.set({ handBack: next, blockedLabels: { ...this.state.blockedLabels, blocked: next.blocked } });
    // GitHub#429: the registrations held were read under the old label — the graph shows them as
    // unknown until a read under the new one, which starts now
    if (reread && this.signedIn && this.state.phase === 'ready') void this.syncNow();
  }

  /** A client for one call, or why there is none (signed out / offline / credential ended). */
  private async clientForCall(write: boolean): Promise<{ client: GitHubClient; session: number } | { error: string }> {
    if (!this.signedIn || this.state.phase !== 'ready') return { error: '还没有登录' };
    if (write && !writesEnabled(this.state.sync)) return { error: '离线时不能修改：GitHub 上什么都没改' };
    const fresh = await this.fresh();
    if (fresh === 'ended' || !this.signedIn) return { error: '登录已结束，请重新登录' };
    return { client: this.client(this.session), session: this.session };
  }

  /** Every item the cache holds for the configured sources, whatever the view shows. */
  private cachedItems() {
    const configured = this.state.sources.map((s) => s.key);
    return mergeSnapshots([...this.snapshots.values()].filter((s) => configured.includes(s.sourceKey)), null).items;
  }

  private findItem(key: string) {
    const data = this.getBoardData();
    // GitHub#397: an open tab's item is still an item when the view (or every source) no longer lists it
    return data.tabItems?.find((i) => i.key === key) ?? data.items.find((i) => i.key === key) ?? null;
  }

  /** The whole detail of one item, read from GitHub now (not cached). */
  loadDetail(key: string): Promise<DetailResult> {
    return this.readDetail(key);
  }

  /**
   * The one detail read: the panel's (loadDetail) and the read ahead of a notification's click
   * (GitHub#328) both go through here, so what may enter the cache is decided once — only a read
   * of this session, and never over one of the same item that started later.
   */
  private async readDetail(key: string): Promise<DetailResult> {
    const item = this.findItem(key);
    if (!item) return { ok: false, error: '看板上找不到这一条，请刷新后再试' };
    const c = await this.clientForCall(false);
    if ('error' in c) return { ok: false, error: c.error };
    const read = ++this.detailReads;
    try {
      const raw = await fetchRawDetail(c.client, item.repo, item.number);
      if (c.session !== this.session) return { ok: false, error: '账号已切换' };
      const detail = toDetail(item.repo, raw, this.now());
      if ((this.detailCache.get(key)?.read ?? 0) < read) {
        this.detailCache.delete(key);
        this.detailCache.set(key, { detail, read });
        while (this.detailCache.size > DETAIL_CACHE_SIZE) this.detailCache.delete(this.detailCache.keys().next().value!);
      }
      return { ok: true, detail };
    } catch (e) {
      this.noteAuthFailure(e);
      const msg = e instanceof GitHubError && e.kind === 'network' ? `连不上 GitHub，读不到详情（${e.message}）` : `读取详情失败：${(e as Error).message}`;
      return { ok: false, error: msg };
    }
  }

  // ---- release attachment images of the discussion (GitHub#395) ----

  /**
   * One release attachment image, fetched with the sign-in. Kept in memory only, for this account
   * only (the key carries the session; sign-out and another account drop them all). While GitHub's
   * rate limit holds, nothing is asked: the answer is "limited until …" at once. At most
   * IMAGE_FETCHES run at a time; two calls for one address share one fetch.
   */
  loadImage(src: string): Promise<ImageResult> {
    if (!parseReleaseImage(src, this.deps.endpoints.web)) return Promise.resolve({ ok: false, kind: 'denied' });
    const key = `${this.session}\n${src}`;
    const kept = this.images.get(key);
    if (kept !== undefined) {
      this.images.delete(key);
      this.images.set(key, kept);
      return Promise.resolve({ ok: true, dataUrl: kept });
    }
    const held = this.imageHeld();
    if (held) return Promise.resolve(held);
    let flight = this.imageFlights.get(key);
    if (!flight) {
      flight = this.fetchImage(src, key).finally(() => this.imageFlights.delete(key));
      this.imageFlights.set(key, flight);
    }
    return flight;
  }

  /** the rate limit an image fetch of this session heard still holds */
  private imageHeld(): ImageResult | null {
    const l = this.imageLimit;
    return l && l.session === this.session && this.now() < l.until ? { ok: false, kind: 'limited', until: l.until } : null;
  }

  private async fetchImage(src: string, key: string): Promise<ImageResult> {
    if (this.imageRunning >= IMAGE_FETCHES) await new Promise<void>((go) => this.imageWaiters.push(go));
    this.imageRunning++;
    try {
      // a limit heard while this one waited its turn
      const held = this.imageHeld();
      if (held) return held;
      const c = await this.clientForCall(false);
      if ('error' in c) return { ok: false, kind: 'auth' };
      const r = await fetchReleaseImage(c.client, this.backend, c.session, this.deps.endpoints, src, this.now);
      // the account changed on the way: this answer belongs to nobody
      if (c.session !== this.session) return { ok: false, kind: 'auth' };
      if (r.ok) {
        this.images.set(key, r.dataUrl);
        this.imageChars += r.dataUrl.length;
        while (this.imageChars > IMAGE_CACHE_CHARS && this.images.size > 1) {
          const [oldest, data] = this.images.entries().next().value!;
          this.images.delete(oldest);
          this.imageChars -= data.length;
        }
      } else if (r.kind === 'limited') {
        this.imageLimit = { session: c.session, until: r.until };
      } else if (r.kind === 'denied') {
        // only a refusal is told which kind of sign-in it met: a GitHub App's permissions are its own
        const info = await this.backend.call<GrantInfo>('grantInfo').catch(() => null);
        if (info?.signedIn && info.session === c.session && info.githubApp) return { ok: false, kind: 'denied', app: true };
      }
      return r;
    } finally {
      this.imageRunning--;
      this.imageWaiters.shift()?.();
    }
  }

  /** GitHub#229: the detail read last in this run (shown at once on re-opening, while it is read again); null = none. */
  cachedDetail(key: string): ItemDetail | null {
    return this.detailCache.get(key)?.detail ?? null;
  }

  /**
   * Labels and milestones of one repository (the candidates the window offers).
   * GitHub#229: a read that worked is kept for this run and answers the next call
   * at once; `fresh` reads again (the detail's refresh button). A lost connection
   * is tried once more before the failure is reported; a failure is never kept.
   */
  async repoOptions(repo: string, fresh = false): Promise<RepoOptions> {
    const kept = this.optionsCache.get(repo);
    if (kept && !fresh) return kept;
    const c = await this.clientForCall(false);
    if ('error' in c) return { labels: [], milestones: [], error: c.error };
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await listRepoOptions(c.client, repo);
        if (c.session === this.session) this.optionsCache.set(repo, r);
        return r;
      } catch (e) {
        if (attempt === 0 && e instanceof GitHubError && e.kind === 'network') continue;
        this.noteAuthFailure(e);
        return { labels: [], milestones: [], error: `读取 ${repo} 的标签 / 里程碑失败：${(e as Error).message}` };
      }
    }
  }

  /**
   * GitHub#401: the Projects "从 GitHub 选" offers — the account's own and each organisation's, read
   * now (never cached: an organisation approved a minute ago must show at the next look).
   */
  async projectChoices(): Promise<ProjectChoices> {
    const c = await this.clientForCall(false);
    if ('error' in c) return { ok: false, failure: { kind: 'other', raw: c.error }, groups: [] };
    // PR #414 review rounds 1–2: GitHub said wait. Every way into this list — its own button, a
    // failure's button, closing and opening it, a read already running — is held in one place:
    //  - the list's reads go through their own read gate: the moment any request (the account's
    //    Projects, the organisations, any organisation, any page) hears a rate limit, every later
    //    request of the list fails here without being sent, while the rest of that read is still
    //    under way;
    //  - a read asked for while one runs gets that same read (never a second one, never an older
    //    answer landing after a newer one);
    //  - asked for while the gate is closed, the last answer is given again, without a request.
    if (!this.choices || this.choices.session !== c.session) this.choices = { session: c.session, gate: new ReadGate(this.now), running: null, last: null };
    const ch = this.choices;
    if (ch.running) return ch.running;
    if (ch.last && ch.gate.until !== null && this.now() < ch.gate.until) return ch.last;
    const client = this.client(c.session, undefined, { gate: ch.gate, retryDelaysMs: [] });
    const run = readProjectChoices(client).then((r) => {
      if (this.choices === ch) ch.last = r;
      return r;
    });
    ch.running = run;
    let r: ProjectChoices;
    try {
      r = await run;
    } finally {
      if (ch.running === run) ch.running = null;
    }
    if (!r.ok && r.failure?.kind === 'auth') this.noteAuthFailure(new GitHubError('auth', r.failure.raw, 401));
    return r;
  }
  /** GitHub#401: the "从 GitHub 选" list of one sign-in session — its read gate, the read under way, the last answer */
  private choices: { session: number; gate: ReadGate; running: Promise<ProjectChoices> | null; last: ProjectChoices | null } | null = null;

  /** GitHub renders the reply preview (same renderer as the web page). */
  async previewMarkdown(repo: string, text: string): Promise<{ ok: boolean; html?: string; error?: string }> {
    const c = await this.clientForCall(false);
    if ('error' in c) return { ok: false, error: c.error };
    try {
      return { ok: true, html: await c.client.restText('/markdown', { text, mode: 'gfm', context: repo }) };
    } catch (e) {
      return { ok: false, error: `预览失败：${(e as Error).message}` };
    }
  }

  /**
   * Make one change on GitHub. Refused before sending when offline, signed
   * out, or the app can already tell it cannot work. On success the touched
   * item is read again from GitHub at once and the cache takes that copy.
   */
  async act(action: WriteAction): Promise<WriteResult> {
    if (isFieldAction(action)) return this.actEdit(action);
    // GitHub#250: the five operations go through the one send gate; this waits for them (the window does not)
    if (isOpKind(action.kind)) return this.actOp(action as OpAction);
    if (action.kind === 'comment' && action.draftOf) return this.actReplyFromDraft(action as Extract<WriteAction, { kind: 'comment' }> & { draftOf: string });
    if (action.kind !== 'toggleTask' && action.kind !== 'editEntry' && action.kind !== 'editTitle') return this.actNow(action);
    // two clicks on one comment would be two read-change-writes racing each other: the second waits its turn as a refusal
    // (GitHub#299: a title the same way, by its item)
    const slot = sendSlot(action)!;
    if (this.tasksInFlight.has(slot) || this.sendHolding(slot)) return { ok: false, error: '这一条上一次修改还没完成，等它完成再试', warning: null };
    this.tasksInFlight.add(slot);
    try {
      return await this.actNow(action);
    } finally {
      this.tasksInFlight.delete(slot);
    }
  }

  private async actNow(action: WriteAction, onOutcome?: (o: { boards?: CreateBoard[]; createdNodeId?: string; labelsNote?: string }) => void, onError?: (e: unknown) => void): Promise<WriteResult> {
    const c = await this.clientForCall(true);
    if ('error' in c) return { ok: false, error: c.error, warning: null };
    const data = this.getBoardData();
    // (GitHub#397: an open tab's item the view does not hold is still an item)
    const item = 'key' in action ? (data.tabItems?.find((i) => i.key === action.key) ?? data.items.find((i) => i.key === action.key) ?? null) : null;
    // GitHub#205: a new issue joins exactly the Projects ticked in the dialog; one the app does not know is refused before sending
    const known = this.allProjects();
    const wanted = action.kind === 'createIssue' ? (Array.isArray(action.projects) ? action.projects : null) : [];
    if (wanted === null) return { ok: false, error: '不知道要加入哪些看板，没有新建', warning: null };
    const createInProjects = wanted.map((k) => known.find((p) => p.key === k));
    if (createInProjects.some((p) => !p)) return { ok: false, error: '勾选的看板不在当前来源里（可能刚被删掉），没有新建；请重新打开对话框', warning: null };
    let outcome;
    try {
      outcome = await performAction(c.client, action, { item, projects: data.projects, handBack: this.state.handBack, createInProjects: createInProjects as ProjectMeta[], cached: this.cachedItems() });
    } catch (e) {
      if (!(e instanceof ActionRefused)) this.noteAuthFailure(e);
      onError?.(e);
      return { ok: false, error: e instanceof CreateUnanswered ? `不确定有没有建好：${e.reason}` : explainError(e, action.kind), warning: null };
    }
    onOutcome?.(outcome);
    let warning = outcome.warning;
    if (c.session === this.session) {
      for (const [repo, number] of outcome.touched) {
        const { problem } = await this.refreshOne(c.client, c.session, repo, number);
        if (problem) warning = [warning, problem].filter(Boolean).join('；');
      }
      // GitHub changed something (also when a follow-up step warned): one more round soon
      if (c.session === this.session) this.scheduleFollowUp(c.session);
    }
    return { ok: true, error: null, warning, ...(outcome.createdKey ? { createdKey: outcome.createdKey } : {}) };
  }

  /**
   * Read one item again and put it into every cached source that carries it.
   * Same guards as a sync round: nothing lands after a sign-out / account
   * switch, nor into a source removed (or re-added) meanwhile. A round already
   * in flight may have read the item before the change: one more round is queued.
   */
  /**
   * Read one item again and land it in every source that carries it. GitHub#229: the answer
   * itself is never handed out (PR #240 plan revision 1) — whoever decides on GitHub's value
   * reads it from the board data through `evidence`, with this read's `issuedAt`:
   *   done   — the read landed, or in a source was overtaken by a newer read that had landed;
   *            either way the board data holds a read issued at `issuedAt` or later
   *   failed — GitHub could not be read, or the rows did not reach the disk (`problem` says which)
   *   ended  — the session is over
   * `own`: the item's own copy, only when no source carries it (see `evidence`).
   */
  private async refreshOne(
    client: GitHubClient,
    session: number,
    repo: string,
    number: number,
    opts: { final?: boolean; quiet?: boolean } = {},
  ): Promise<{ kind: 'done' | 'failed' | 'ended'; problem: string | null; issuedAt: number; own: Item | null }> {
    const sources = this.state.sources;
    const epochAtStart = new Map(sources.map((src) => [src.key, this.epochs.get(src.key) ?? 0]));
    const issuedAt = this.stamp();
    const key = itemKey(repo, number);
    const failed = (reason: string) => {
      if (session === this.session) this.feedReadFailure(key, reason, issuedAt);
      // GitHub#279: a quiet re-read (the catch-up at the end of a round) never asks for another round
      if (!opts.quiet) void this.syncNow();
      return { kind: 'failed' as const, problem: `修改已生效，但重读这一条失败（${reason}），下一轮同步会更新`, issuedAt, own: null };
    };
    let fresh;
    try {
      fresh = await fetchItem(client, repo, number, this.now(), this.state.handBack.blocked);
    } catch (e) {
      return failed((e as Error).message);
    }
    if (session !== this.session) return { kind: 'ended', problem: null, issuedAt, own: null };
    const current = (k: string) => this.state.sources.some((s) => s.key === k) && (this.epochs.get(k) ?? 0) === epochAtStart.get(k);
    const freshK = freshKey(fresh);
    let own: Item | null = null;
    // only into sources where nothing newer of this item landed meanwhile (a read that comes back
    // after a later one would put the older value back); its read time is recorded only once the
    // rows are on disk
    const landing = await this.landSnapshots(
      session,
      () => {
        if (!freshK) return { rows: [], commit: () => {} };
        const views = freshViews(
          [...this.snapshots.values()].filter((s) => current(s.sourceKey)),
          fresh,
        );
        if (views.every((v) => !v.item)) own = contentToItem(fresh.content, [], []);
        const fresher = views.filter((v) => this.readAt(v.snap.sourceKey, freshK) < issuedAt);
        return {
          rows: applyFreshItem(
            fresher.map((v) => v.snap),
            fresh,
          ),
          commit: (keep) => {
            for (const v of fresher) if (keep(v.snap.sourceKey)) this.itemReadAt.set(`${v.snap.sourceKey}\n${freshK}`, issuedAt);
          },
        };
      },
      current,
    );
    if (landing.kind === 'ended') return { kind: 'ended', problem: null, issuedAt, own: null };
    if (landing.kind === 'failed') return failed(landing.reason);
    // GitHub#397: no source carries it. A tab that shows it takes this read; with no tab yet it is
    // kept for a while, so that it can be opened (a new issue no source lists yet).
    if (own) {
      const it = own as Item;
      this.looseItems.delete(it.key);
      this.looseItems.set(it.key, it);
      while (this.looseItems.size > LOOSE_ITEMS) this.looseItems.delete(this.looseItems.keys().next().value!);
      if (this.tabList.some((t) => t.key === it.key)) {
        this.tabOwn.set(it.key, it);
        this.markChecked(it.key);
        this.set({});
      }
    }
    if (landing.rows.length) this.set({});
    // the checks of the changes read what the board data holds now (this read, or a newer one)
    this.feedEvidence(freshK ?? key, issuedAt, own, opts.final);
    this.feedOps(freshK ?? key, issuedAt, own);
    if (this.syncing && !opts.quiet) void this.syncNow();
    return { kind: 'done', problem: null, issuedAt, own };
  }

  /** A 401 on a call outside the sync round: let the next round do the refresh / sign-out logic. */
  private noteAuthFailure(e: unknown): void {
    if (e instanceof GitHubError && e.kind === 'auth') void this.syncNow();
  }

  // ---- GitHub#229: changes shown before GitHub confirms them ----------------

  /** A stamp later than every one handed out before (also across a restart: see loadEdits). */
  private stamp(): number {
    this.stampAt = Math.max(this.now(), this.stampAt + 1);
    return this.stampAt;
  }

  /** The stored records, as the last run left them: every request still waiting has no answer now, and nothing is sent again. */
  private loadEdits(row: SourceSnapshot): void {
    const raw = (row as unknown as { edits?: unknown }).edits;
    const list = Array.isArray(raw) ? raw.filter(isEditRecord) : [];
    for (const r of list) this.edits.set(r.id, afterRestart(r));
    this.editsStored = true;
    this.stampAt = Math.max(this.stampAt, latestStamp(list));
    this.editSeq = Math.max(0, ...list.flatMap((r) => r.reqs.map((q) => q.id)));
    this.state = { ...this.state, editsNeedingAction: this.needingAction() };
    // a watch that was running goes on: the first sync round reads every source anyway, the end is re-read when due
    for (const r of this.edits.values()) this.scheduleWatch(r);
  }

  private needingAction(): number {
    let n = 0;
    for (const r of this.edits.values()) {
      const st = editStatus(r);
      if (st === 'failed' || st === 'unconfirmed') n++;
    }
    return n;
  }

  /** Records changed in memory: views see them now (the caller stores them). */
  private editsChanged(): void {
    this.set({ editsNeedingAction: this.needingAction() });
  }

  /**
   * Store every record (one row of the snapshot table, written in this session
   * only: the back end refuses it after a sign-out, and drops it with the cache).
   * false = not stored: the change it was for must not go out.
   */
  private async storeEdits(): Promise<boolean> {
    const session = this.session;
    const list = [...this.edits.values()];
    try {
      if (!list.length) {
        if (this.editsStored) {
          this.editsStored = false;
          this.cache.deleteSnapshot(EDITS_KEY);
        }
        return session === this.session;
      }
      const row = { sourceKey: EDITS_KEY, fetchedAt: this.now(), items: [], edits: list } as unknown as SourceSnapshot;
      const ok = await this.writeSnapshots(session, [row]);
      if (ok) this.editsStored = true;
      return ok;
    } catch {
      return false;
    }
  }

  private setEdit(id: string, next: EditRecord | null): void {
    const before = this.edits.get(id);
    if (next) this.edits.set(id, next);
    else this.edits.delete(id);
    if (!next) {
      this.editTimers.get(id)?.forEach(clearTimeout);
      this.editTimers.delete(id);
    } else if (next.observeUntil !== null && next.observeUntil !== before?.observeUntil) {
      this.scheduleWatch(next);
    }
  }

  /** A change was made by the user: shown at once, stored, then sent behind the item's earlier changes. */
  private async actEdit(action: FieldAction): Promise<WriteResult> {
    if (!this.signedIn || this.state.phase !== 'ready') return { ok: false, error: '还没有登录', warning: null };
    if (!writesEnabled(this.state.sync)) return { ok: false, error: '离线时不能修改：GitHub 上什么都没改', warning: null };
    const item = this.findItem(action.key);
    if (!item) return { ok: false, error: '看板上找不到这一条（可能刚被同步掉了），请刷新后再试', warning: null };
    const field = this.fieldOf(action, item);
    const id = fieldId(item.key, field);
    const prev = this.edits.get(id) ?? null;
    if (!prev && this.edits.size >= MAX_EDITS) return { ok: false, error: `还有 ${MAX_EDITS} 处修改没确认，请先处理掉一些（重新发送或放弃）再改`, warning: null };
    const value = this.valueOf(action);
    const shown = fieldValue(item, field);
    const reqId = ++this.editSeq;
    this.setEdit(id, startEdit(prev, { id, key: item.key, repo: item.repo, number: item.number, field, base: shown ?? null }, value, reqId));
    this.editsChanged();
    // GitHub#488: from here on the record holds the outcome (the notice area says a failure, the field a success)
    return { ...(await this.sendEdit(id, reqId, action)), held: true };
  }

  private fieldOf(action: FieldAction, item: Item): EditField {
    switch (action.kind) {
      case 'addLabel':
      case 'removeLabel': {
        const color = (action.kind === 'addLabel' ? action.color : undefined) ?? item.labels.find((l) => l.name === action.label)?.color ?? this.optionsCache.get(item.repo)?.labels.find((l) => l.name === action.label)?.color ?? '';
        return { kind: 'label', label: action.label, color };
      }
      case 'setMilestone':
        return { kind: 'milestone' };
      case 'setStatus':
        return { kind: 'status', projectKey: action.projectKey };
      case 'setIteration':
        return { kind: 'iteration', projectKey: action.projectKey };
    }
  }

  private valueOf(action: FieldAction): EditValue {
    switch (action.kind) {
      case 'addLabel':
        return true;
      case 'removeLabel':
        return false;
      case 'setMilestone':
        return action.title;
      case 'setStatus':
        return action.status;
      case 'setIteration':
        return action.iterationId;
    }
  }

  /** The request that writes a record's target (for a resend). */
  private actionOf(r: EditRecord): FieldAction {
    const f = r.field;
    switch (f.kind) {
      case 'label':
        return r.target ? { kind: 'addLabel', key: r.key, label: f.label, color: f.color } : { kind: 'removeLabel', key: r.key, label: f.label };
      case 'milestone':
        return { kind: 'setMilestone', key: r.key, title: typeof r.target === 'string' ? r.target : null };
      case 'status':
        return { kind: 'setStatus', key: r.key, projectKey: f.projectKey, status: typeof r.target === 'string' ? r.target : null };
      case 'iteration':
        return { kind: 'setIteration', key: r.key, projectKey: f.projectKey, iterationId: typeof r.target === 'string' ? r.target : null };
    }
  }

  /** Behind the item's earlier changes. */
  private enqueueItem<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.itemQueues.get(key) ?? Promise.resolve();
    const p = prev.then(fn, fn);
    const tail = p.catch(() => undefined);
    this.itemQueues.set(key, tail);
    void tail.then(() => {
      if (this.itemQueues.get(key) === tail) this.itemQueues.delete(key);
    });
    return p;
  }

  /**
   * Store the record, then send its request behind the item's earlier ones. The
   * record is stored as "sent" before the request goes out (a crash in between
   * then reads as "no answer", never as "never sent"); not stored = not sent.
   */
  private async sendEdit(id: string, reqId: number, action: FieldAction): Promise<WriteResult> {
    const session = this.session;
    if (!(await this.storeEdits())) {
      const r = this.edits.get(id);
      if (r && session === this.session) {
        this.setEdit(id, applyAnswer(r, reqId, 'rejected', this.stamp(), '没能存到本机，这次修改没发出'));
        this.editsChanged();
      }
      return { ok: false, error: '没能存到本机，这次修改没发出', warning: null };
    }
    // Only the write and its answer hold the item's queue (GitHub#229 review round 1): the re-read
    // after an accepted change runs once the next change of the item may go out.
    const slot = await this.enqueueItem(action.key, () => this.sendInQueue(id, reqId, action, session));
    return slot.after ? slot.after() : slot.result;
  }

  /**
   * One request of the item's queue. Every await may let the record change (a newer change of the
   * same field, abandon, sign-out): after each one the record is read again and the request must
   * still be in it — the copy from before the await is never written back.
   */
  private async sendInQueue(id: string, reqId: number, action: FieldAction, session: number): Promise<{ result: WriteResult; after?: () => Promise<WriteResult> }> {
    const notSent = { result: { ok: false, error: '这次修改在发出前被放弃或被后一次修改取代，没有发出', warning: null } };
    const holds = () => session === this.session && Boolean(this.edits.get(id)?.reqs.some((q) => q.id === reqId));
    if (!holds()) return notSent;
    const c = await this.clientForCall(true);
    if (!holds()) return notSent;
    if ('error' in c) return { result: await this.answerEdit(id, reqId, session, 'rejected', c.error) };
    this.setEdit(id, markSent(this.edits.get(id)!, reqId, this.stamp()));
    if (!(await this.storeEdits())) return { result: await this.answerEdit(id, reqId, session, 'rejected', '没能存到本机，这次修改没发出') };
    if (!holds()) return notSent;
    const data = this.getBoardData();
    const item = data.tabItems?.find((i) => i.key === action.key) ?? data.items.find((i) => i.key === action.key) ?? null;
    let outcome;
    try {
      outcome = await performAction(c.client, action, { item, projects: data.projects, handBack: this.state.handBack, createInProjects: [], cached: this.cachedItems() });
    } catch (e) {
      if (!(e instanceof ActionRefused)) this.noteAuthFailure(e);
      const error = explainError(e, action.kind);
      if (refusedForSure(e)) return { result: await this.answerEdit(id, reqId, session, 'rejected', error) };
      // not explainError's words: they say "nothing was changed", which is exactly what is not known here
      return { result: await this.answerEdit(id, reqId, session, 'unknown', `没收到 GitHub 的明确答复（${(e as Error)?.message ?? String(e)}），不确定改没改上`) };
    }
    await this.answerEdit(id, reqId, session, 'accepted', '');
    const touched = outcome.touched;
    const first = outcome.warning;
    return {
      result: { ok: true, error: null, warning: first },
      after: async () => {
        let warning = first;
        if (session === this.session) {
          for (const [repo, number] of touched) {
            const { problem } = await this.refreshOne(c.client, session, repo, number);
            if (problem) warning = [warning, problem].filter(Boolean).join('；');
          }
          if (session === this.session) this.scheduleFollowUp(session);
        }
        return { ok: true, error: null, warning };
      },
    };
  }

  private async answerEdit(id: string, reqId: number, session: number, outcome: 'accepted' | 'rejected' | 'unknown', reason: string): Promise<WriteResult> {
    if (session === this.session) {
      const r = this.edits.get(id);
      if (r) {
        this.setEdit(id, applyAnswer(r, reqId, outcome, this.stamp(), reason));
        this.editsChanged();
        await this.storeEdits();
      }
    }
    return outcome === 'accepted' ? { ok: true, error: null, warning: null } : { ok: false, error: reason, warning: null };
  }

  /** A sync round's snapshots landed: each record whose item is in one of them reads its field from the board data. */
  private feedSnapshots(snaps: SourceSnapshot[], issuedAt: number): void {
    if (!this.edits.size || !snaps.length) return;
    const keys = new Set([...this.edits.values()].map((r) => r.key));
    for (const key of keys) {
      if (snaps.some((snap) => snap.items.some((i) => i.key === key))) this.feedEvidence(key, issuedAt);
    }
  }

  /**
   * A round's rows as they may land: a source a newer round already landed is left out; an
   * item re-read after this round started keeps the copy memory has (or stays absent when that
   * re-read took it out of the source). The read times move only in `commit`, after the write.
   */
  private roundRows(rows: SourceSnapshot[], issuedAt: number): { rows: SourceSnapshot[]; commit: (keep: (sourceKey: string) => boolean) => void } {
    const out: SourceSnapshot[] = [];
    for (const snap of rows) {
      if ((this.sourceReadAt.get(snap.sourceKey) ?? 0) > issuedAt) continue;
      const prefix = `${snap.sourceKey}\n`;
      const kept = [...this.itemReadAt].filter(([k, at]) => k.startsWith(prefix) && at > issuedAt).map(([k]) => k.slice(prefix.length));
      let items = snap.items;
      if (kept.length) {
        const shown = this.snapshots.get(snap.sourceKey)?.items ?? [];
        const keptSet = new Set(kept);
        items = snap.items.flatMap((i) => {
          if (!keptSet.has(i.key)) return [i];
          const s = shown.find((x) => x.key === i.key);
          return s ? [s] : [];
        });
        for (const k of kept) {
          const s = shown.find((x) => x.key === k);
          if (s && !items.some((x) => x.key === k)) items.push(s);
        }
      }
      out.push(items === snap.items ? snap : { ...snap, items });
    }
    const commit = (keep: (sourceKey: string) => boolean) => {
      for (const snap of out) {
        if (!keep(snap.sourceKey)) continue;
        // what this round read is now the floor of the source; older per-item stamps are covered by it
        const prefix = `${snap.sourceKey}\n`;
        this.sourceReadAt.set(snap.sourceKey, issuedAt);
        for (const [k, at] of [...this.itemReadAt]) if (k.startsWith(prefix) && at <= issuedAt) this.itemReadAt.delete(k);
      }
    };
    return { rows: out, commit };
  }

  /**
   * Every record of this item reads its field through `evidence` (reads issued at `since` or
   * later that landed); `since` is the read's issue time, a lower bound for whatever newer read
   * may have given the value — it only ever makes a read count less.
   */
  private feedEvidence(key: string, since: number, own: Item | null = null, final = false): void {
    let changed = false;
    for (const r of [...this.edits.values()]) {
      if (r.key !== key) continue;
      const ev = this.evidence(key, r.field, since, own);
      if (!ev || ev === 'absent') continue;
      const receivedAt = this.stamp();
      this.setEdit(r.id, applyRead(r, { issuedAt: since, receivedAt, value: ev.value }, this.deps.observeMs ?? OBSERVE_MS, final));
      changed = true;
    }
    if (changed) {
      this.editsChanged();
      void this.storeEdits();
    }
  }

  /** A read of this item issued at `issuedAt` failed: "GitHub unreadable" only where nothing issued later has landed. */
  private feedReadFailure(key: string, reason: string, issuedAt: number): void {
    let changed = false;
    for (const r of [...this.edits.values()]) {
      if (r.key !== key) continue;
      if (this.evidence(key, r.field, issuedAt) !== null) continue;
      this.setEdit(r.id, applyReadFailure(r, reason, this.stamp()));
      changed = true;
    }
    if (changed) this.editsChanged();
  }

  /** A watched record is re-read soon after it was checked, and once more when the watch runs out. */
  private scheduleWatch(r: EditRecord): void {
    if (r.observeUntil === null) return;
    this.editTimers.get(r.id)?.forEach(clearTimeout);
    const now = this.now();
    const first = this.deps.observeFirstMs ?? OBSERVE_FIRST_MS;
    const id = r.id;
    const end = Math.max(0, r.observeUntil - now);
    const timers = [setTimeout(() => void this.rereadForEdit(id, false), Math.min(first, end)), setTimeout(() => void this.rereadForEdit(id, true), end + 10)];
    this.editTimers.set(id, timers);
  }

  private async rereadForEdit(id: string, final: boolean): Promise<void> {
    const r = this.edits.get(id);
    if (!r || r.observeUntil === null) return;
    const c = await this.clientForCall(false);
    if ('error' in c) return;
    // the same re-read as after a change: it lands in the board data, then reads the field
    const read = await this.refreshOne(c.client, c.session, r.repo, r.number, { final });
    // the watch must not end on a failed read (GitHub unreadable, or not stored): try the end again a little later
    if (read.kind === 'failed' && final && c.session === this.session && this.edits.get(id)) {
      this.editTimers.set(id, [setTimeout(() => void this.rereadForEdit(id, true), this.deps.observeFirstMs ?? OBSERVE_FIRST_MS)]);
    }
  }

  /**
   * Send a change again (one not saved or not confirmed). Q1 = A: GitHub is read
   * first; only when it still holds the value from before the first click (or
   * already the wanted one) does it go out. Changed by somebody, or unreadable:
   * held back until `force` (the user's "overwrite anyway" / "send anyway").
   */
  async resendEdit(id: string, force = false): Promise<WriteResult> {
    // GitHub#357: its notice reads as running from before the first wait to the end of the request
    const session = this.session;
    this.markResending([id], true);
    try {
      return await this.resendEditNow(id, force);
    } finally {
      if (session === this.session && !this.resendQueue.has(id)) this.markResending([id], false);
    }
  }

  /** GitHub#357: the changes a "重新发送" a person asked for is working on (`resendQueue`: the ones of a "全部重新发送" still running). */
  private resending = new Set<string>();
  private resendQueue = new Set<string>();
  private markResending(ids: string[], on: boolean): void {
    for (const id of ids) on ? this.resending.add(id) : this.resending.delete(id);
    this.set({ editsResending: [...this.resending] });
  }

  private async resendEditNow(id: string, force: boolean): Promise<WriteResult> {
    const r = this.edits.get(id);
    if (!r) return { ok: false, error: '这处修改已经不在了', warning: null };
    const st = editStatus(r);
    if (st !== 'failed' && st !== 'unconfirmed') return { ok: false, error: '这处修改还在保存或核对中，不用重新发送', warning: null };
    if (!writesEnabled(this.state.sync)) return { ok: false, error: '离线时不能修改：GitHub 上什么都没改', warning: null };
    if (!force) {
      const c = await this.clientForCall(false);
      if ('error' in c) return { ok: false, error: c.error, warning: null };
      // the same re-read as after a change (it lands in the board data and feeds the checks);
      // the comparison reads GitHub's value from the board data, from reads issued at this
      // check or later that landed — never this read's own answer (PR #240 plan revision 1)
      const read = await this.refreshOne(c.client, c.session, r.repo, r.number);
      if (c.session !== this.session) return { ok: false, error: '账号已切换', warning: null };
      const cur = this.edits.get(id);
      // the read itself showed the change is on GitHub: nothing to send
      if (!cur) return { ok: true, error: null, warning: null };
      const ev = read.kind === 'done' || read.kind === 'failed' ? this.evidence(cur.key, cur.field, read.issuedAt, read.own) : null;
      if (ev === null) {
        const why = read.problem?.replace(/^修改已生效，但重读这一条失败（(.*)），下一轮同步会更新$/, '$1') ?? '读取失败';
        this.setEdit(id, { ...cur, hold: { kind: 'unreadable', reason: why } });
        this.editsChanged();
        void this.storeEdits();
        return { ok: false, error: '读不到 GitHub 现在的值，没有重新发送；确认要发就点「仍然发送」', warning: null };
      }
      if (ev === 'absent') {
        this.setEdit(id, { ...cur, hold: { kind: 'unreadable', reason: '这一条已不在那个看板上' } });
        this.editsChanged();
        return { ok: false, error: '这一条已不在那个看板上，没有重新发送', warning: null };
      }
      if (ev.value !== cur.base && ev.value !== cur.target) {
        this.setEdit(id, { ...cur, hold: { kind: 'changed', value: ev.value } });
        this.editsChanged();
        void this.storeEdits();
        return { ok: false, error: '你改之后有人改过这一项，没有重新发送；确认要覆盖就点「仍然覆盖」', warning: null };
      }
    }
    const cur = this.edits.get(id);
    if (!cur) return { ok: true, error: null, warning: null };
    const reqId = ++this.editSeq;
    this.setEdit(id, startEdit(cur, cur, cur.target, reqId));
    this.editsChanged();
    return this.sendEdit(id, reqId, this.actionOf(cur));
  }

  /** Give a change up: GitHub's value shows again. A request still on its way may land later; the next read shows what GitHub holds. */
  async abandonEdit(id: string): Promise<void> {
    if (!this.edits.has(id)) return;
    this.setEdit(id, null);
    this.editsChanged();
    await this.storeEdits();
  }

  /** Every change that needs the user, one after the other (each with its own check). */
  async resendAllEdits(): Promise<WriteResult> {
    const ids = [...this.edits.values()].filter((r) => ['failed', 'unconfirmed'].includes(editStatus(r))).map((r) => r.id);
    const held: string[] = [];
    // GitHub#357: the whole batch reads as running until its last one is through
    const session = this.session;
    for (const id of ids) this.resendQueue.add(id);
    this.markResending(ids, true);
    try {
      for (const id of ids) {
        const r = await this.resendEdit(id);
        if (!r.ok && r.error) held.push(r.error);
      }
    } finally {
      for (const id of ids) this.resendQueue.delete(id);
      if (session === this.session) this.markResending(ids, false);
    }
    return held.length ? { ok: false, error: `${held.length} 处没有重新发送：${held[0]}`, warning: null } : { ok: true, error: null, warning: null };
  }

  async abandonAllEdits(): Promise<void> {
    for (const r of [...this.edits.values()]) if (['failed', 'unconfirmed'].includes(editStatus(r))) this.setEdit(r.id, null);
    this.editsChanged();
    await this.storeEdits();
  }

  // ---- GitHub#229: a new issue does not hold the dialog --------------------

  /**
   * Create an issue in the background: refused at once (the dialog stays) when it
   * cannot go out at all; otherwise the dialog closes and the outcome shows above
   * the board. Only an outcome that is known to have created nothing gives the
   * draft back with a create button; no answer = "not sure", never "try again".
   */
  async startCreate(action: Extract<WriteAction, { kind: 'createIssue' }>): Promise<{ ok: boolean; error: string | null; job?: number }> {
    if (!this.signedIn || this.state.phase !== 'ready') return { ok: false, error: '还没有登录' };
    if (!writesEnabled(this.state.sync)) return { ok: false, error: '离线时不能修改：GitHub 上什么都没改' };
    if (!action.title.trim()) return { ok: false, error: '标题不能为空' };
    const id = ++this.createSeq;
    const draft = { repo: action.repo, title: action.title, body: action.body, labels: action.labels, projects: Array.isArray(action.projects) ? action.projects : [], handoff: action.handoff, handoffPicked: action.handoffPicked === true, ...(action.picks ? { picks: action.picks } : {}) };
    this.setCreate({ id, repo: action.repo, title: action.title, status: 'running', message: null, draft });
    void this.runCreate(id, action);
    return { ok: true, error: null, job: id };
  }

  private setCreate(job: CreateJob | null, drop?: number): void {
    const others = this.state.creates.filter((j) => j.id !== (job?.id ?? drop));
    this.set({ creates: job ? [...others, job].sort((a, b) => a.id - b.id) : others });
  }

  private async runCreate(id: number, action: Extract<WriteAction, { kind: 'createIssue' }>): Promise<void> {
    const session = this.session;
    // GitHub#258 (code review round 2): which addition of each source the watches belong to, taken
    // before anything is sent — a source removed / added again while the create is on its way is another one
    const epochs = new Map((action.plan?.watch ?? []).map((w) => [w.projectKey, this.epochs.get(w.projectKey) ?? 0]));
    const job = () => this.state.creates.find((j) => j.id === id);
    const sentAt = new Date(this.now() - 60_000).toISOString();
    let r: WriteResult;
    let unanswered: string | null = null;
    let boards: CreateBoard[] = [];
    let nodeId = '';
    let labelsNote = '';
    try {
      r = await this.actNow(
        action,
        (o) => {
          boards = o.boards ?? [];
          nodeId = o.createdNodeId ?? '';
          labelsNote = o.labelsNote ?? '';
        },
        (e) => (unanswered = e instanceof CreateUnanswered ? e.reason : null),
      );
    } catch (e) {
      r = { ok: false, error: (e as Error).message, warning: null };
    }
    if (session !== this.session || !job()) return;
    const cur = job()!;
    if (r.ok && r.createdKey) {
      // GitHub#245: a hand-over picked by hand in the dialog is remembered once the issue exists — never a fallback, never a failed create
      if (action.handoffPicked === true && action.handoff) this.setNewIssueHandoff(action.handoff);
      const number = Number(r.createdKey.split('#')[1]);
      // GitHub#258: boards left unticked that may take it in by themselves
      const watch = nodeId ? this.watchEntries(action, epochs) : [];
      const done: CreateJob = { ...cur, createdKey: r.createdKey, number, boards, createdNodeId: nodeId, ...(labelsNote ? { labelsNote } : {}), ...(watch.length ? { watch } : {}) };
      // the boards' state words it when there is any; another warning (the re-read failed) is said as it came
      this.settleCreate(done, r.warning);
      this.set({ focus: { key: r.createdKey, seq: ++this.focusSeq } });
      if (watch.length) void this.runWatch(id, session, nodeId).catch(() => {});
      return;
    }
    if (unanswered === null) {
      this.setCreate({ ...cur, status: 'failed', message: r.error });
      return;
    }
    // GitHub#357: the look below is this notice's own request — it reads as running until it ends, and a look that failed is said
    this.setCreate({ ...cur, status: 'unknown', message: `请求发出后没收到 GitHub 的明确答复（${unanswered}），不确定有没有建好`, looking: true });
    const lookOver = (lookError: string | null) => {
      const now = job();
      if (now && now.status === 'unknown' && session === this.session) this.setCreate({ ...now, looking: false, lookError });
    };
    // same-title issues this account opened in this repository lately: links to look at, nothing is claimed or changed
    const c = await this.clientForCall(false);
    // not signed in / offline: no look was made (not a failed one)
    if ('error' in c || c.session !== session) return lookOver(null);
    try {
      const [owner, name] = action.repo.split('/');
      const list = await c.client.restList<{ number: number; html_url: string; title: string; created_at: string; user?: { login?: string }; pull_request?: unknown }>(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues?state=all&sort=created&direction=desc&since=${encodeURIComponent(sentAt)}&per_page=50`,
      );
      const since = Date.parse(sentAt) - 9 * 60_000;
      const candidates = list
        .filter((x) => !x.pull_request && x.title === action.title && (!this.state.viewer || x.user?.login === this.state.viewer) && Date.parse(x.created_at) >= since)
        .map((x) => ({ number: x.number, url: x.html_url, createdAt: x.created_at }));
      const now = job();
      if (now && now.status === 'unknown' && session === this.session) this.setCreate({ ...now, candidates, looking: false, lookError: null });
      else lookOver(null);
    } catch (e) {
      // no list: the notice still says "not sure", with the web link
      lookOver((e as Error)?.message ?? String(e));
    }
  }

  dismissCreate(id: number): void {
    // GitHub#258: boards still being watched keep being watched (without a notice); what was shown is gone
    const job = this.state.creates.find((j) => j.id === id);
    const active = (job?.watch ?? []).filter(watchActive);
    if (job && active.length && job.createdKey) this.setCreate({ ...job, status: 'watching', message: null, boards: [], labelsNote: undefined, watch: active });
    else this.setCreate(null, id);
  }

  /**
   * A created job's notice from all it still holds: something to say → `partial`; only boards
   * still watched → `watching` (no notice); nothing → gone. `extra`: a warning said only when
   * nothing else is (the re-read right after creating failed).
   */
  private settleCreate(job: CreateJob, extra: string | null = null): void {
    const watch = job.watch ?? [];
    const message = createNotice(job.number ?? 0, job.boards ?? [], job.labelsNote, watch) ?? extra;
    if (message) this.setCreate({ ...job, status: 'partial', message });
    else if (watch.some(watchActive)) this.setCreate({ ...job, status: 'watching', message: null });
    else this.setCreate(null, job.id);
  }

  // ---- GitHub#258: boards not ticked that take a new issue in by themselves --------
  //
  // data/autoJoin.ts holds the rules (what is written, what is left to a person, what is
  // unknown). This part schedules the looks and the checks, and feeds their results into
  // the job: one entry per board, patched in place on the job as it is at that moment.

  /** The plan's watched boards that are still sources, not ticked, and known to the app. */
  private watchEntries(action: Extract<WriteAction, { kind: 'createIssue' }>, epochs: Map<string, number>): CreateWatch[] {
    const ticked = new Set(Array.isArray(action.projects) ? action.projects : []);
    const known = this.allProjects();
    const out: CreateWatch[] = [];
    for (const w of action.plan?.watch ?? []) {
      const p = known.find((x) => x.key === w.projectKey);
      if (!p || ticked.has(w.projectKey) || out.some((x) => x.projectKey === w.projectKey)) continue;
      if ((w.iterationId === null) === (w.status === null)) continue;
      // removed (or removed and added again) while the create was on its way: not watched
      if (!epochs.has(w.projectKey) || (this.epochs.get(w.projectKey) ?? 0) !== epochs.get(w.projectKey)) continue;
      out.push({ projectKey: w.projectKey, title: p.title, iterationId: w.iterationId, status: w.status, label: String(w.label ?? w.status ?? ''), state: 'looking', writes: 0, epoch: epochs.get(w.projectKey) ?? -1 });
    }
    return out;
  }

  /** One entry of a job, changed by `f` (null = dropped), then the job settled again. */
  private patchWatch(id: number, key: string, f: (w: CreateWatch) => CreateWatch | null): void {
    const job = this.state.creates.find((j) => j.id === id);
    if (!job?.watch?.some((w) => w.projectKey === key)) return;
    const watch = job.watch.flatMap((w) => {
      if (w.projectKey !== key) return [w];
      const n = f(w);
      return n ? [n] : [];
    });
    this.settleCreate({ ...job, watch });
  }

  private watchSleep(ms: number): Promise<void> {
    return new Promise((r) => {
      const t = setTimeout(() => {
        this.watchTimers.delete(t);
        r();
      }, Math.max(0, ms));
      this.watchTimers.add(t);
    });
  }

  /**
   * The job's entry for `key`, while the session and that board's source are still the very
   * ones the entry was made for (`w.epoch`, recorded at creation — never re-read at a later
   * call: a source removed and added again is another addition, its old watch and button are over).
   */
  private watchEntry(id: number, key: string, session: number): CreateWatch | null {
    if (session !== this.session) return null;
    const job = this.state.creates.find((j) => j.id === id);
    const w = job?.watch?.find((x) => x.projectKey === key) ?? null;
    if (!w) return null;
    if (!this.state.sources.some((s) => s.key === key) || (this.epochs.get(key) ?? 0) !== w.epoch) {
      // the source was removed (or removed and added again): this watch is over
      this.patchWatch(id, key, () => null);
      return null;
    }
    return w;
  }

  private async runWatch(id: number, session: number, nodeId: string): Promise<void> {
    let why = '留意中断';
    try {
      why = await this.runLooks(id, session, nodeId);
    } finally {
      // every way out of the looks settles what is still being looked for: nothing stays
      // "looking" without a timer (code review round 1) — unknown is said, never dropped
      if (session === this.session)
        for (const w of this.state.creates.find((j) => j.id === id)?.watch ?? [])
          if (w.state === 'looking') this.patchWatch(id, w.projectKey, (x) => ({ ...x, state: 'unread', reason: why }));
    }
  }

  /** The scheduled looks. Returns why the last one could not tell (for whatever is left looking). */
  private async runLooks(id: number, session: number, nodeId: string): Promise<string> {
    const looks = this.deps.watchLooksMs ?? WATCH_LOOKS_MS;
    const start = this.state.creates.find((j) => j.id === id)?.watch ?? [];
    // a board whose auto-add is surely off never takes it in: not watched (no client now: all watched)
    const c0 = await this.clientForCall(false);
    if (!('error' in c0) && c0.session === session)
      for (const w of start) {
        const p = this.allProjects().find((x) => x.key === w.projectKey);
        if (p && (await autoAddSurelyOff(c0.client, p))) this.patchWatch(id, w.projectKey, () => null);
      }
    let why = '读不到';
    let at = 0;
    for (let i = 0; i < looks.length; i++) {
      await this.watchSleep(looks[i] - at);
      at = looks[i];
      const last = i === looks.length - 1;
      if (session !== this.session) return why;
      const keys = (this.state.creates.find((j) => j.id === id)?.watch ?? []).filter((w) => w.state === 'looking').map((w) => w.projectKey);
      const live = keys.filter((k) => this.watchEntry(id, k, session));
      if (!live.length) continue;
      const seen = await this.readWatched(id, session, nodeId, live);
      if (seen === 'ended') return why;
      for (const k of live) {
        const w = this.watchEntry(id, k, session);
        if (!w || w.state !== 'looking') continue;
        const s = typeof seen === 'string' ? null : seen.get(k);
        if (!s || s.state === 'unknown') {
          // the latest look decides: an earlier "not there" says nothing about now
          why = typeof seen === 'string' ? seen : 'GitHub 的回应没有列全这条所在的看板';
          if (last) this.patchWatch(id, k, (x) => ({ ...x, state: 'unread', reason: why }));
          continue;
        }
        if (s.state === 'absent') {
          if (last) this.patchWatch(id, k, () => null);
          continue;
        }
        await this.actOnSighting(id, k, session, s, true);
      }
    }
    return why;
  }

  /** One read for the watched boards `keys`: the sightings, or why it failed ('ended': the session is over). */
  private async readWatched(id: number, session: number, nodeId: string, keys: string[]): Promise<Map<string, BoardSighting> | string | 'ended'> {
    const c = await this.clientForCall(false);
    if (session !== this.session) return 'ended';
    if ('error' in c) return c.error;
    if (c.session !== session) return 'ended';
    const metas = this.allProjects().filter((p) => keys.includes(p.key));
    try {
      return await readCreatedBoards(c.client, nodeId, metas);
    } catch (e) {
      this.noteAuthFailure(e);
      return (e as Error)?.message ?? String(e);
    }
  }

  /** A board holds the issue: write (empty, only automatically once), finish, or leave it to a person. */
  private async actOnSighting(id: number, key: string, session: number, s: Extract<BoardSighting, { state: 'on' }>, auto: boolean): Promise<void> {
    const w = this.watchEntry(id, key, session);
    if (!w) return;
    const verdict = judgeWatch(w, s.membership);
    if (verdict === 'done') return this.patchWatch(id, key, () => null);
    if (verdict === 'human' || (auto && w.writes >= 1)) return this.patchWatch(id, key, (x) => ({ ...x, state: 'human', seen: watchedValue(x, s.membership).text, busy: false }));
    await this.writeWatched(id, key, session, s.itemId, auto);
  }

  /**
   * Write the group's value on that board. Returns why it was not written (null = written, now
   * being checked). Automatic: a refusal is said in the notice. By the button: the board stays as
   * the person saw it (button still there), the reason goes back to the click.
   */
  private async writeWatched(id: number, key: string, session: number, itemId: string, auto: boolean): Promise<string | null> {
    const c = await this.clientForCall(true);
    const w = this.watchEntry(id, key, session);
    if (!w) return '这个看板已不在来源里，没有修改';
    const p = this.allProjects().find((x) => x.key === key);
    const refused = (reason: string) => {
      this.patchWatch(id, key, (x) => (auto ? { ...x, state: 'failed', reason, busy: false } : { ...x, busy: false }));
      return reason;
    };
    if ('error' in c) return refused(c.error);
    if (c.session !== session || !p) return refused('账号已切换');
    if (auto) this.patchWatch(id, key, (x) => ({ ...x, writes: x.writes + 1 }));
    try {
      await setCreatedField(c.client, p, itemId, w.iterationId, w.status);
    } catch (e) {
      if (!(e instanceof ActionRefused)) this.noteAuthFailure(e);
      return refused(explainError(e, w.iterationId !== null ? 'setIteration' : 'setStatus'));
    }
    if (!this.watchEntry(id, key, session)) return null;
    this.patchWatch(id, key, (x) => ({ ...x, state: 'written', busy: false }));
    void this.verifyWatched(id, key, session).catch(() => {});
    return null;
  }

  /** After a write: read it back (a few tries); only seeing the value there counts as done. */
  private async verifyWatched(id: number, key: string, session: number): Promise<void> {
    try {
      await this.verifyLoop(id, key, session);
    } finally {
      const w = session === this.session ? this.state.creates.find((j) => j.id === id)?.watch?.find((x) => x.projectKey === key) : undefined;
      if (w?.state === 'written') this.patchWatch(id, key, (x) => ({ ...x, state: 'unverified', reason: x.reason ?? '核对中断' }));
    }
  }

  private async verifyLoop(id: number, key: string, session: number): Promise<void> {
    const job = this.state.creates.find((j) => j.id === id);
    const nodeId = job?.createdNodeId ?? '';
    const ms = this.deps.watchVerifyMs ?? WATCH_VERIFY_MS;
    let reason = '';
    for (let i = 0; i < WATCH_VERIFY_TRIES; i++) {
      await this.watchSleep(ms);
      const w = this.watchEntry(id, key, session);
      if (!w || w.state !== 'written') return;
      const seen = await this.readWatched(id, session, nodeId, [key]);
      if (seen === 'ended') return;
      const s = typeof seen === 'string' ? null : seen.get(key);
      if (!s || s.state === 'unknown') {
        reason = typeof seen === 'string' ? seen : 'GitHub 的回应没有列全这条所在的看板';
        continue;
      }
      // taken off the board meanwhile: nothing left to do there
      if (s.state === 'absent') return this.patchWatch(id, key, () => null);
      const verdict = judgeWatch(w, s.membership);
      if (verdict === 'done') {
        this.patchWatch(id, key, () => null);
        // the board shows it in that group now
        const c = await this.clientForCall(false);
        const cur = this.state.creates.find((j) => j.id === id) ?? job;
        if (!('error' in c) && c.session === session && cur?.createdKey) {
          const [repo, n] = [cur.repo, Number(cur.createdKey.split('#')[1])];
          await this.refreshOne(c.client, session, repo, n);
        }
        return;
      }
      // changed (or emptied) after the write: never written again automatically
      return this.patchWatch(id, key, (x) => ({ ...x, state: 'human', seen: watchedValue(x, s.membership).text }));
    }
    this.patchWatch(id, key, (x) => ({ ...x, state: 'unverified', reason }));
  }

  /**
   * GitHub#258: the notice's "change it to …" for a board that holds another value. Read again
   * first: written only while the board still holds exactly the value the notice showed (what the
   * person decided on); otherwise the notice shows the new value and nothing is written.
   */
  async applyCreateWatch(id: number, key: string): Promise<WriteResult> {
    const job = this.state.creates.find((j) => j.id === id);
    const w = job?.watch?.find((x) => x.projectKey === key);
    if (!job || !w || w.state !== 'human' || !job.createdNodeId) return { ok: false, error: '没有要改的看板', warning: null };
    if (w.busy) return { ok: false, error: '上一次修改还没完成', warning: null };
    // taken before the first wait (code review round 2): a second click meanwhile is refused above.
    // GitHub#357: the failure of this board's click before goes at the same moment (only this board's)
    this.patchWatch(id, key, (x) => ({ ...x, busy: true, clickError: null }));
    const start = this.session;
    try {
      const out = await this.applyCreateWatchNow(id, key, job);
      // why it did not do it stays on the notice (the account changed: that notice is gone)
      if (!out.ok && start === this.session) this.patchWatch(id, key, (x) => ({ ...x, clickError: out.error }));
      return out;
    } finally {
      // no way out leaves the board marked as being worked on
      if (start === this.session) this.patchWatch(id, key, (x) => (x.busy ? { ...x, busy: false } : x));
    }
  }

  private async applyCreateWatchNow(id: number, key: string, job: CreateJob): Promise<WriteResult> {
    const unbusy = (error: string): WriteResult => {
      this.patchWatch(id, key, (x) => ({ ...x, busy: false }));
      return { ok: false, error, warning: null };
    };
    const c = await this.clientForCall(true);
    if ('error' in c) return unbusy(c.error);
    const session = c.session;
    const seen = await this.readWatched(id, session, job.createdNodeId ?? '', [key]);
    if (seen === 'ended') return { ok: false, error: '账号已切换', warning: null };
    const s = typeof seen === 'string' ? null : seen.get(key);
    if (!s || s.state === 'unknown') return unbusy(`读不到这条在看板上的当前值（${typeof seen === 'string' ? seen : '回应不完整'}），没有修改`);
    if (s.state === 'absent') {
      this.patchWatch(id, key, () => null);
      return { ok: false, error: '这条已经不在这个看板上，没有修改', warning: null };
    }
    const cur = this.watchEntry(id, key, session);
    if (!cur) return { ok: false, error: '这个看板已不在来源里，没有修改', warning: null };
    if (judgeWatch(cur, s.membership) === 'done') {
      this.patchWatch(id, key, () => null);
      return { ok: true, error: null, warning: null };
    }
    const now = watchedValue(cur, s.membership).text;
    if (now !== (cur.seen ?? null)) {
      this.patchWatch(id, key, (x) => ({ ...x, seen: now, busy: false }));
      return { ok: false, error: `看板上现在是「${now ?? '空'}」，和提示里的不一样，没有修改；看过后再决定`, warning: null };
    }
    const error = await this.writeWatched(id, key, session, s.itemId, false);
    return error === null ? { ok: true, error: null, warning: null } : { ok: false, error, warning: null };
  }

  /**
   * A created issue that missed some Projects: add exactly those to it (never a new issue).
   * Addressed by the node id GitHub returned when it was created — the issue need not be on
   * any source (with only Project sources it is not, since joining that board is what failed).
   */
  async retryCreateProjects(id: number): Promise<WriteResult> {
    const cur = this.state.creates.find((j) => j.id === id);
    if (!cur || cur.status !== 'partial' || !cur.createdKey) return { ok: false, error: '没有要补的看板', warning: null };
    const created = cur.createdKey;
    if (cur.retrying) return { ok: false, error: '上一次再试还没完成', warning: null };
    // GitHub#357: running from before the first wait, the failure of the attempt before gone
    const session = this.session;
    this.patchCreate(id, { retrying: true, retryError: null });
    try {
      return await this.retryCreateProjectsNow(id, { ...cur, createdKey: created });
    } finally {
      // a way out that wrote no result (the notice was closed meanwhile, the account changed: nothing is left to mark)
      if (session === this.session && this.state.creates.find((j) => j.id === id)?.retrying) this.patchCreate(id, { retrying: false });
    }
  }

  /** GitHub#357: fields of a job's notice changed in place; a job that is gone (closed, another account) stays gone. */
  private patchCreate(id: number, patch: Partial<CreateJob>): void {
    const job = this.state.creates.find((j) => j.id === id);
    if (job) this.setCreate({ ...job, ...patch });
  }

  private async retryCreateProjectsNow(id: number, cur: CreateJob & { createdKey: string }): Promise<WriteResult> {
    const fail = (error: string): WriteResult => {
      this.patchCreate(id, { retrying: false, retryError: error });
      return { ok: false, error, warning: null };
    };
    const c = await this.clientForCall(true);
    if ('error' in c) return fail(c.error);
    const results = new Map<string, CreateBoard | null>();
    for (const b of cur.boards ?? []) {
      if (b.state !== 'missing') continue;
      const p = this.allProjects().find((x) => x.key === b.projectKey);
      try {
        if (!p) throw new ActionRefused('这个看板已不在来源里');
        const fieldError = await joinCreatedIssue(c.client, p, cur.createdNodeId ?? '', b.iterationId, b.status);
        results.set(b.projectKey, fieldError === null ? null : { ...b, state: 'fieldsFailed', reason: explainError(fieldError, 'addToProject'), retryFailed: true });
      } catch (e) {
        if (!(e instanceof ActionRefused)) this.noteAuthFailure(e);
        results.set(b.projectKey, { ...b, reason: explainError(e, 'addToProject'), retryFailed: true });
      }
    }
    if (c.session !== this.session) return { ok: false, error: '账号已切换', warning: null };
    const number = Number(cur.createdKey.split('#')[1]);
    const after = [...results.values()];
    if (after.some((x) => x === null || x.state === 'fieldsFailed')) {
      // the boards it joined carry it now: read it once so it shows there
      await this.refreshOne(c.client, c.session, cur.repo, number);
      this.scheduleFollowUp(c.session);
    }
    // merged into the job as it is now (it may have changed meanwhile): only the boards this retry worked on change
    const now = this.state.creates.find((j) => j.id === id);
    const stillMissing = after.filter((x): x is CreateBoard => x !== null && x.state === 'missing');
    const fieldsNow = after.filter((x): x is CreateBoard => x !== null && x.state === 'fieldsFailed');
    const error = stillMissing.length ? stillMissing.map((x) => `「${x.title}」（${x.reason}）`).join('、') : null;
    const warning = fieldsNow.length ? `已加入看板，但字段没设上 ${fieldsNow.map((x) => `「${x.title}」（${x.reason}）`).join('、')}` : null;
    if (now) {
      const boards = mergeRetry(now.boards ?? [], results);
      // the notice goes only when nothing is left on any board, and no dropped label is left unsaid (GitHub#245);
      // boards still watched keep the job (GitHub#258)
      // GitHub#357: what this retry left unfinished is marked on those boards (above); the boards it did not work on keep theirs
      this.settleCreate({ ...now, number: now.number ?? number, boards, retrying: false, retryError: null });
    }
    return stillMissing.length ? { ok: false, error, warning } : { ok: true, error: null, warning };
  }


  // ---- GitHub#250: close / merge / autopilot / hand-back do not hold a dialog ------
  //
  // Each one is a record (shared/ops.ts) stored before its first request goes out and
  // updated after every answer. shared/ops.ts alone decides what a record means — whether
  // it locks its item, its notice, its buttons, its draft; this part only runs requests,
  // re-reads and evidence reads, and feeds their results in. `startOp` is the one send
  // gate: the panel, the board and `act` all go through it.

  /** The window's entry: refused at once (nothing sent) or started in the background. */
  startOp(action: OpAction, opts: { from?: string } = {}): { ok: boolean; error: string | null; id?: string } {
    const refuse = (error: string) => ({ ok: false, error });
    if (!this.signedIn || this.state.phase !== 'ready') return refuse('还没有登录');
    if (!writesEnabled(this.state.sync)) return refuse('离线时不能修改：GitHub 上什么都没改');
    if (!action || !isOpKind(action.kind)) return refuse('未知的操作');
    const item = this.findItem(action.key);
    if (!item) return refuse('看板上找不到这一条（可能刚被同步掉了），请刷新后再试');
    const blocked = this.opBlocked(item.key);
    if (blocked) return refuse(blocked);
    // PR #510 review round 1: the same text sent from the reply box is still without a result (the two could not be told apart)
    const opComment = (action as { comment?: unknown }).comment;
    if (typeof opComment === 'string' && opComment.trim() && this.sendCommentPending(item.key, opComment)) return refuse('同样的一段评论刚从回复框发过，还没有结果（或还不确定有没有发出），等它有了结果再操作');
    const step = (name: OpStep['name'], label?: string, role?: OpStep['role']): OpStep => ({ name, ...(label !== undefined ? { label } : {}), state: 'unsent', reason: null, sentAt: null, answeredAt: null, ...(role ? { role } : {}) });
    let steps: OpStep[];
    let draft: OpRecord['draft'] = {};
    switch (action.kind) {
      case 'closeIssue': {
        if (item.kind !== 'issue') return refuse('这一条不是 issue');
        if (!ISSUE_CLOSE_REASONS.includes(action.reason)) return refuse('未知的关闭原因');
        const comment = typeof action.comment === 'string' ? action.comment : '';
        draft = { reason: action.reason, ...(comment.trim() ? { comment } : {}) };
        steps = comment.trim() ? [step('close'), step('comment')] : [step('close')];
        break;
      }
      case 'closePr': {
        if (item.kind !== 'pr') return refuse('这一条不是 PR');
        const comment = typeof action.comment === 'string' ? action.comment : '';
        draft = comment.trim() ? { comment } : {};
        steps = comment.trim() ? [step('close'), step('comment')] : [step('close')];
        break;
      }
      case 'merge': {
        if (item.kind !== 'pr') return refuse('这一条不是 PR');
        if (!/^[0-9a-f]{40}$/.test(action.headOid)) return refuse('不知道你看到的是哪个提交，请刷新详情后再合并');
        if (!['merge', 'squash', 'rebase'].includes(action.method)) return refuse('未知的合并方式');
        draft = { method: action.method, headOid: action.headOid };
        steps = [step('merge')];
        break;
      }
      case 'autopilot':
      case 'handBack': {
        const { human, agent, autopilot } = this.state.handBack;
        if (!human.trim() || !agent.trim()) return refuse('设置里「交给 agent」的两个标签名不能为空');
        if (action.kind === 'autopilot' && !autopilot.trim()) return refuse('设置里没有填托管标签，没有修改');
        // GitHub#451: the comment first — the steps stop at the first that is not done, so a comment that did
        // not go out (or whose answer never came) leaves every label alone: never handed over without it
        const comment = typeof action.comment === 'string' ? action.comment : '';
        if (comment.trim()) draft = { comment };
        // the autopilot label first (the daemon must see it when it picks the item up); add before remove
        steps = [
          ...(comment.trim() ? [step('comment')] : []),
          ...(action.kind === 'autopilot' ? [step('addLabel', autopilot, 'autopilot')] : []),
          step('addLabel', agent, 'agent'),
          step('removeLabel', human, 'human'),
        ];
        break;
      }
    }
    // GitHub#451: the reply box carried an earlier operation's kept comment — it moves into this one (that
    // record no longer offers it), never while a reply made from it may still be on its way or unproven
    const draftOf = (action.kind === 'autopilot' || action.kind === 'handBack') && draft.comment !== undefined && typeof action.draftOf === 'string' ? this.ops.get(action.draftOf) : undefined;
    if (draftOf && draftOf.key === item.key) {
      if (draftOf.replyState) return refuse('这条附带评论已经用来发过回复（结果还没确定），没有发送');
      if (opPhase(draftOf) === 'waiting' || opPhase(draftOf) === 'unknown') return refuse(`上一次操作还没结清，附带评论先不发：${opText(draftOf)}`);
    }
    const id = `op-${++this.opSeq}`;
    const rec: OpRecord = {
      id,
      key: item.key,
      repo: item.repo,
      number: item.number,
      kind: action.kind,
      startedAt: this.stamp(),
      steps,
      draft,
      readAt: null,
      targetSeen: false,
      unlocked: false,
      draftDropped: false,
      dismissed: false,
      stuck: false,
      checkProblem: null,
      running: true,
    };
    // a draft taken from an earlier record (its "重新关闭 / 合并 / 托管") now lives here
    const from = opts.from ? this.ops.get(opts.from) : undefined;
    if (from) this.setOp({ ...from, draftDropped: true, dismissed: true });
    if (draftOf && draftOf.key === item.key && draftOf.id !== from?.id && this.ops.has(draftOf.id)) this.setOp({ ...this.ops.get(draftOf.id)!, commentUsed: true });
    this.setOp(rec);
    this.pruneOps();
    this.opsChanged();
    this.launchOp(id, item);
    return { ok: true, error: null, id };
  }

  // ---- GitHub#434: "等前置…" ------------------------------------------------------------
  //
  // The rules are shared/blocked.ts; this part reads, sends and records. A record of kind 'blocked'
  // locks its item like every operation. Before every write the item is read again in full and must
  // hold what the person confirmed plus exactly what the steps done so far changed (factsDiffer);
  // otherwise the record stops there and says why. It is never continued by itself.

  private blockedNames(): { human: string; agent: string; running: string } {
    const { human, agent, running } = this.state.handBack;
    return { human, agent, running };
  }

  private async blockedRefInfo(client: GitHubClient, r: Ref): Promise<BlockedRefInfo> {
    const known = this.cachedItems().find((i) => i.key === refKey(r));
    try {
      const c = await readCandidate(client, r.repo, r.number);
      return { repo: c.repo, number: c.number, kind: c.kind, title: c.title, state: c.state, url: c.url };
    } catch {
      return { repo: r.repo, number: r.number, kind: known ? known.kind : null, title: known?.title ?? '', state: 'unknown', url: known?.url ?? '' };
    }
  }

  /** GitHub#434: the dialog's read. */
  async blockedRead(key: string): Promise<BlockedView> {
    if (!this.signedIn || this.state.phase !== 'ready') return { ok: false, error: '还没有登录' };
    const item = this.findItem(key);
    if (!item) return { ok: false, error: '看板上找不到这一条（可能刚被同步掉了），请刷新后再试' };
    const bl = this.state.blockedLabels;
    if (!bl.blocked) return { ok: false, error: '设置里没有填等前置的标签' };
    const c = await this.clientForCall(false);
    if ('error' in c) return { ok: false, error: c.error };
    let read: BlockedRead;
    try {
      read = await readBlocked(c.client, item.repo, item.number, bl.blocked);
    } catch (e) {
      return { ok: false, error: `没能完整读到这一条现在的状态，不能登记（${(e as Error)?.message ?? String(e)}）` };
    }
    return this.blockedViewOf(c.client, item, read);
  }

  private async blockedViewOf(client: GitHubClient, item: Item, read: BlockedRead): Promise<BlockedView> {
    const bl = this.state.blockedLabels;
    const names = this.blockedNames();
    const facts = factsOf(read, names, bl);
    const latest = read.marks.length ? read.marks[read.marks.length - 1].refs : [];
    const seen = new Map<string, Ref>();
    for (const r of [...read.native, ...latest]) seen.set(refKey(r), r);
    const current = await Promise.all([...seen.values()].map((r) => this.blockedRefInfo(client, r)));
    const lost = (await Promise.all(lostRefs(read).map((r) => this.blockedRefInfo(client, r)))).filter((x) => x.state === 'open' || x.state === 'unknown');
    const entry = entryState(read.labels, names, bl);
    let refuse: string | null = null;
    if (read.state !== 'open') refuse = '这一条已经关闭';
    else if (entry.kind === 'other') refuse = `挂着「${entry.label}」：这一条还在别的流程里，daemon 这时不会处理等前置。等它回到「${names.human}」后再登记`;
    else {
      const opts = await this.repoOptions(item.repo);
      if (opts.error) refuse = `读不到这个仓库的标签（${opts.error}），不能确认「${bl.blocked}」「${names.human}」两个标签都在`;
      else {
        const have = new Set(opts.labels.map((l) => l.name.toLowerCase()));
        const missing = [bl.blocked, names.human].filter((n) => !have.has(n.toLowerCase()));
        if (missing.length) refuse = `这个仓库没有标签 ${missing.map((m) => `「${m}」`).join('、')}（客户端不会替仓库新建标签）`;
      }
    }
    return { ok: true, key: item.key, repo: item.repo, number: item.number, isPr: read.isPr, entry, current, lost, latest: latestRefs(read), native: read.native, fingerprint: fingerprint(facts), refuse };
  }

  /**
   * GitHub#434 / #448: the picker's search (the item's own repository; `owner/repo#N` or an address
   * another one). A number reads the item itself and every open item of the repository (to its last
   * page), ranked by `rankByNumber`; an address reads that one item; text goes to GitHub's search.
   * `error` with `ok: true`: part of the answer could not be read — `items` holds what could, never
   * passed off as the whole.
   */
  async blockedSearch(key: string, text: string): Promise<{ ok: true; items: (BlockedRefInfo & BlockedPick)[]; error?: string; settled?: NumberSettled } | { ok: false; error: string }> {
    const item = this.findItem(key);
    if (!item) return { ok: false, error: '看板上找不到这一条' };
    const c = await this.clientForCall(false);
    if ('error' in c) return { ok: false, error: c.error };
    const q = text.trim();
    const parsed = parseRefQuery(q, this.deps.endpoints.web);
    const self = { repo: item.repo.toLowerCase(), number: item.number };
    const fail = (e: unknown) => `搜索失败：${(e as Error)?.message ?? String(e)}`;
    const one = async (repo: string, n: number): Promise<Candidate | null> => {
      try {
        return await readCandidate(c.client, repo, n);
      } catch (e) {
        if (e instanceof GitHubError && e.status === 404) return null;
        throw e;
      }
    };
    if (parsed.kind === 'number') {
      const repo = parsed.repo ?? self.repo;
      const exactNo = /^0/.test(parsed.digits) ? null : Number(parsed.digits);
      const [exact, list] = await Promise.allSettled([exactNo === null ? Promise.resolve(null) : one(repo, exactNo), this.openCandidates(c.client, repo)]);
      // freshest first: the exact read settles its number over the list (read now or kept a minute) — a
      // 404 or a closed answer hides that number's row in the list too (PR #452 review round 2)
      const layers = [
        { rows: exact.status === 'fulfilled' && exact.value ? [exact.value] : [], settled: { decided: exactNo !== null && exact.status === 'fulfilled' ? [refKey({ repo, number: exactNo })] : [], whole: null } },
        { rows: list.status === 'fulfilled' ? list.value : [], settled: { decided: [], whole: list.status === 'fulfilled' ? repo : null } },
      ];
      const items = rankByNumber(layerRows(layers), repo, parsed.digits, self).map((x) => ({ ...x }));
      // what was read, so the window puts its board copies of it under GitHub's answer
      const settled: NumberSettled = settledOf(layers);
      const errs: string[] = [];
      if (exact.status === 'rejected') errs.push(fail(exact.reason));
      if (list.status === 'rejected') errs.push(`搜索失败：开着的条目没读全（${(list.reason as Error)?.message ?? String(list.reason)}）`);
      return errs.length ? { ok: true, items, error: errs.join('；'), settled } : { ok: true, items, settled };
    }
    try {
      let found: Candidate[];
      if (parsed.kind === 'url') found = [await one(parsed.repo, parsed.number)].filter((x): x is Candidate => x !== null);
      else if (q.length < 2) return { ok: true, items: [] };
      else found = await searchCandidates(c.client, item.repo, q);
      const items = found.filter((x) => x.state === 'open' && !(x.repo === self.repo && x.number === self.number));
      return { ok: true, items: items.map((x) => ({ ...x })) };
    } catch (e) {
      return { ok: false, error: fail(e) };
    }
  }

  /** GitHub#448: a repository's open items read whole, kept a minute per sign-in session (a failed read is not kept). */
  private openCache = new Map<string, { at: number; items: Candidate[] }>();
  private async openCandidates(client: GitHubClient, repo: string): Promise<Candidate[]> {
    const k = `${this.session}\n${repo.toLowerCase()}`;
    const hit = this.openCache.get(k);
    const now = this.now();
    if (hit && now - hit.at >= 0 && now - hit.at < OPEN_CACHE_MS) return hit.items;
    const session = this.session;
    const items = await readOpenCandidates(client, repo);
    for (const [key, v] of this.openCache) if (!key.startsWith(`${this.session}\n`) || now - v.at >= OPEN_CACHE_MS) this.openCache.delete(key);
    if (session === this.session) this.openCache.set(k, { at: now, items });
    return items;
  }

  /** GitHub#434: confirm in the dialog. Refused (nothing written) when GitHub no longer holds what was shown. */
  async blockedStart(req: BlockedStart): Promise<BlockedStartResult> {
    const refuse = (error: string): BlockedStartResult => ({ ok: false, error });
    if (!this.signedIn || this.state.phase !== 'ready') return refuse('还没有登录');
    if (!writesEnabled(this.state.sync)) return refuse('离线时不能修改：GitHub 上什么都没改');
    const item = this.findItem(String(req?.key ?? ''));
    if (!item) return refuse('看板上找不到这一条（可能刚被同步掉了），请刷新后再试');
    const blockedOp = this.opBlocked(item.key);
    if (blockedOp) return refuse(blockedOp);
    const bl = this.state.blockedLabels;
    const names = this.blockedNames();
    if (!bl.blocked || !names.human.trim()) return refuse('设置里等前置的标签或「等人处理」的标签是空的，没有修改');
    const picks = Array.isArray(req.picks) ? req.picks : [];
    const restore = Array.isArray(req.restore) ? req.restore : [];
    const c = await this.clientForCall(true);
    if ('error' in c) return refuse(c.error);
    // step ② of the plan: read again, the same as shown or nothing is written
    let read: BlockedRead;
    try {
      read = await readBlocked(c.client, item.repo, item.number, bl.blocked);
    } catch (e) {
      return refuse(`没能完整读到这一条现在的状态，什么都没写（${(e as Error)?.message ?? String(e)}）`);
    }
    const view = await this.blockedViewOf(c.client, item, read);
    if (!view.ok) return refuse(view.error);
    if (view.fingerprint !== req.fingerprint) return { ok: false, error: '点「登记前置」后重新读到：这期间这一条有了变化。什么都没写，下面已按最新内容刷新，核对后再点一次', view };
    if (view.refuse) return { ok: false, error: view.refuse, view };
    // every prerequisite picked is read again: open, the kind and id it was picked with
    const fresh: BlockedPick[] = [];
    for (const p of picks) {
      let cand: Candidate;
      try {
        cand = await readCandidate(c.client, p.repo, p.number);
      } catch (e) {
        return refuse(`读不到前置 ${p.repo}#${p.number}（${(e as Error)?.message ?? String(e)}），什么都没写`);
      }
      if (cand.state !== 'open') return { ok: false, error: `前置 ${p.repo}#${p.number} 已经关闭或合并，什么都没写`, view };
      if (cand.repo === item.repo.toLowerCase() && cand.number === item.number) return refuse('不能把这一条自己设成前置');
      fresh.push({ repo: cand.repo, number: cand.number, kind: cand.kind, id: cand.id, title: cand.title });
    }
    const plan = planBlocked({ itemIsPr: read.isPr, selfRepo: item.repo, entry: view.entry, latest: latestRefs(read), native: read.native, picks: fresh, restore });
    // the dialog asks the same rule (confirmBlock): a registration stopped half way may be finished with nothing new picked
    const why = confirmBlock({ picks: fresh.length, restore: restore.length, current: view.current.length, plan });
    if (why) return { ok: false, error: `${why}，GitHub 上什么都没改`, view };
    const step = (name: OpStep['name'], b: OpStep['blocked'], extra: Partial<OpStep> = {}): OpStep => ({ name, state: 'unsent', reason: null, sentAt: null, answeredAt: null, blocked: b, ...extra });
    const steps: OpStep[] = plan.steps.map((s) => {
      switch (s.name) {
        case 'pause':
          return step('addLabel', 'pause', { label: names.human, role: 'human' });
        case 'unpause':
          return step('removeLabel', 'unpause', { label: names.human, role: 'human' });
        case 'addBlocked':
          return step('addLabel', 'addBlocked', { label: bl.blocked });
        case 'relation':
          return step('relation', 'relation', { target: s.target });
        case 'comment':
          return step('comment', 'comment');
        default:
          return step('check', 'check');
      }
    });
    const id = `op-${++this.opSeq}`;
    const rec: OpRecord = {
      id,
      key: item.key,
      repo: item.repo,
      number: item.number,
      kind: 'blocked',
      startedAt: this.stamp(),
      steps,
      draft: {},
      readAt: null,
      targetSeen: false,
      unlocked: false,
      draftDropped: false,
      dismissed: false,
      stuck: false,
      checkProblem: null,
      running: true,
      blocked: {
        opId: `${id}-${this.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        basis: factsOf(read, names, bl),
        labels: { blocked: bl.blocked, human: names.human },
        picks: fresh.filter((p) => plan.steps.some((s) => s.target === itemKey(p.repo, p.number))),
        markRefs: plan.markRefs,
        resume: names.agent,
        commentId: null,
        stop: null,
      },
    };
    this.setOp(rec);
    this.pruneOps();
    this.opsChanged();
    const session = this.session;
    const job = this.runBlocked(id, item, c)
      .catch(() => undefined)
      .then(() => {
        const r = this.ops.get(id);
        if (!r || session !== this.session) return;
        if (r.running) this.setOp({ ...r, running: false });
        this.opsChanged();
        void this.storeOps();
      });
    this.opJobs.set(id, job);
    void job.then(() => {
      if (this.opJobs.get(id) === job) this.opJobs.delete(id);
    });
    return { ok: true, id };
  }

  /** What GitHub must hold now: what was confirmed plus the changes of the steps done. */
  private blockedExpected(r: OpRecord): Facts {
    const b = r.blocked!;
    let f = b.basis;
    for (const s of r.steps) if (s.state === 'ok' && s.blocked) f = applyDone(f, { name: s.blocked, target: s.target }, { human: b.labels.human, blocked: b.labels.blocked, commentId: b.commentId, mark: { refs: b.markRefs, resume: b.resume ?? this.state.handBack.agent } });
    return f;
  }

  private blockedPatch(id: string, patch: (r: OpRecord) => OpRecord): OpRecord | null {
    const r = this.ops.get(id);
    if (!r) return null;
    const next = patch(r);
    this.setOp(next);
    this.opsChanged();
    return next;
  }

  /** The steps of a "等前置…" record, one after the other, each behind a full read and the permit. */
  private async runBlocked(id: string, item: Item, c: { client: GitHubClient; session: number }): Promise<void> {
    const session = this.session;
    if (!(await this.storeOps())) {
      this.blockedPatch(id, (r) => ({ ...r, steps: r.steps.map((s, j) => (j === 0 ? { ...s, reason: '没能存到本机，没有发送' } : s)) }));
      return;
    }
    const names = this.blockedNames();
    const bl = this.state.blockedLabels;
    let lastRead: BlockedRead | null = null;
    for (let i = 0; ; i++) {
      const r = this.ops.get(id);
      if (!r || session !== this.session || c.session !== this.session || i >= r.steps.length) break;
      const s = r.steps[i];
      if (s.state !== 'unsent') continue;
      const b = r.blocked!;
      // the read right before this step, and the permit
      let read: BlockedRead;
      try {
        read = await readBlocked(c.client, r.repo, r.number, b.labels.blocked);
      } catch (e) {
        await this.blockedStop(id, c, `没能完整读到这一条现在的状态（${(e as Error)?.message ?? String(e)}）`, null);
        break;
      }
      lastRead = read;
      if (session !== this.session) return;
      const now = factsOf(read, names, bl);
      const diff = factsDiffer(this.blockedExpected(r), now, b.basis.round.id as number | null);
      if (diff) {
        await this.blockedStop(id, c, diff, read);
        break;
      }
      if (s.blocked === 'check') {
        // the registration just posted is the newest of this wait, and nothing else new (the permit above)
        const last = read.marks[read.marks.length - 1];
        if (!last || last.id !== b.commentId) {
          await this.blockedStop(id, c, '本轮最新的登记不是刚发的这一条', read);
          break;
        }
        this.blockedPatch(id, (x) => ({ ...x, steps: x.steps.map((y, j) => (j === i ? { ...y, state: 'ok' as const, reason: '本轮最新登记就是这一条', answeredAt: this.stamp() } : y)) }));
        await this.storeOps();
        continue;
      }
      let pick: BlockedPick | undefined;
      if (s.blocked === 'relation') {
        pick = b.picks.find((p) => itemKey(p.repo, p.number) === s.target);
        let cand: Candidate | null = null;
        try {
          cand = pick ? await readCandidate(c.client, pick.repo, pick.number) : null;
        } catch {
          cand = null;
        }
        if (!pick || !cand || cand.state !== 'open') {
          await this.blockedStop(id, c, `前置 ${s.target ?? ''} ${cand ? '已经关闭或合并' : '读不到'}`, read);
          break;
        }
      }
      this.blockedPatch(id, (x) => ({ ...x, steps: x.steps.map((y, j) => (j === i ? { ...y, state: 'pending' as const, reason: null, sentAt: this.stamp() } : y)) }));
      if (!(await this.storeOps())) {
        this.blockedPatch(id, (x) => ({ ...x, steps: x.steps.map((y, j) => (j === i ? { ...y, state: 'unsent' as const, reason: '没能存到本机，没有发送', sentAt: null } : y)) }));
        break;
      }
      let state: 'ok' | 'refused' | 'unknown';
      let reason: string | null = null;
      let commentId: number | null = null;
      try {
        if (s.name === 'addLabel') await addLabel(c.client, r.repo, r.number, s.label ?? '');
        else if (s.name === 'removeLabel') await removeLabel(c.client, r.repo, r.number, s.label ?? '');
        else if (s.name === 'relation') await addBlockedBy(c.client, r.repo, r.number, pick!.id);
        else if (s.name === 'comment') commentId = await postComment(c.client, r.repo, r.number, markComment(b.markRefs, r.repo, b.resume ?? names.agent, b.opId));
        state = 'ok';
      } catch (e) {
        if (s.name === 'removeLabel' && e instanceof GitHubError && e.status === 404) {
          state = 'ok';
          reason = '这个标签本来就不在';
        } else if (refusedForSure(e)) {
          state = 'refused';
          reason = explainError(e, s.name === 'comment' ? 'comment' : 'addLabel');
        } else {
          state = 'unknown';
          reason = (e as Error)?.message ?? String(e);
        }
        if (!(e instanceof ActionRefused)) this.noteAuthFailure(e);
      }
      if (session !== this.session) return;
      if (state === 'ok' && s.name === 'comment' && commentId === null) {
        // GitHub said yes without the comment's id: find it by this operation's hidden id
        commentId = await this.blockedFindComment(c.client, r.repo, r.number, b.opId);
      }
      if (state === 'unknown') {
        // one read for evidence (never a second send)
        const proven = await this.blockedEvidence(c.client, r, s, b.opId);
        if (proven) {
          state = 'ok';
          reason = proven.reason;
          if (proven.commentId !== undefined) commentId = proven.commentId;
        }
      }
      this.blockedPatch(id, (x) => ({
        ...x,
        ...(commentId !== null ? { blocked: { ...x.blocked!, commentId } } : {}),
        steps: x.steps.map((y, j) => (j === i ? { ...y, state, reason, answeredAt: this.stamp() } : y)),
      }));
      await this.storeOps();
      if (state !== 'ok') {
        const after = this.ops.get(id);
        if (after) this.blockedPatch(id, (x) => ({ ...x, blocked: { ...x.blocked!, stop: { text: state === 'refused' ? 'GitHub 拒绝了这一步' : '这一步的结果不明', paused: this.blockedPaused(x, lastRead) } } }));
        break;
      }
      if (s.name === 'comment' && commentId === null) {
        await this.blockedStop(id, c, '登记评论发出后找不到它', null);
        break;
      }
    }
    if (session !== this.session) return;
    await this.storeOps();
    await this.opReread(id, item, c);
  }

  /** whether the last full read showed the item paused (open, "等人处理" on) — only when a registration is involved */
  private blockedPaused(r: OpRecord, read: BlockedRead | null): 'yes' | 'unconfirmed' | 'none' {
    const commentStep = r.steps.find((s) => s.blocked === 'comment');
    const wrote = r.steps.some((s) => s.state === 'ok' || s.state === 'unknown');
    if (!commentStep || !wrote) return 'none';
    if (!read) return 'unconfirmed';
    const h = r.blocked!.labels.human.toLowerCase();
    return read.state === 'open' && read.labels.some((l) => l.toLowerCase() === h) ? 'yes' : 'unconfirmed';
  }

  /**
   * Stop before a step: record why, and (plan v4, step 9) put the "等人处理" label back only when the one
   * change seen is other people's registrations / relations — behind `repauseAllowed` on the read just made.
   */
  private async blockedStop(id: string, c: { client: GitHubClient; session: number }, text: string, read: BlockedRead | null): Promise<void> {
    const r = this.ops.get(id);
    if (!r) return;
    const b = r.blocked!;
    let paused = this.blockedPaused(r, read);
    let why = text;
    const wroteMark = r.steps.some((s) => s.blocked === 'comment' && (s.state === 'ok' || s.state === 'unknown'));
    if (read && wroteMark && paused === 'unconfirmed') {
      const now = factsOf(read, this.blockedNames(), this.state.blockedLabels);
      const may = repauseAllowed(this.blockedExpected(r), now, b.basis.round.id as number | null, b.labels.human);
      if (may.ok) {
        const repause: OpStep = { name: 'addLabel', label: b.labels.human, role: 'human', blocked: 'repause', state: 'pending', reason: null, sentAt: this.stamp(), answeredAt: null };
        this.blockedPatch(id, (x) => ({ ...x, steps: [...x.steps, repause] }));
        await this.storeOps();
        let state: 'ok' | 'refused' | 'unknown' = 'ok';
        let reason: string | null = '交错登记后补挂';
        try {
          await addLabel(c.client, r.repo, r.number, b.labels.human);
        } catch (e) {
          state = refusedForSure(e) ? 'refused' : 'unknown';
          reason = (e as Error)?.message ?? String(e);
        }
        const n = this.ops.get(id);
        if (n) {
          const steps = n.steps.map((s, j) => (j === n.steps.length - 1 ? { ...s, state, reason, answeredAt: this.stamp() } : s));
          this.setOp({ ...n, steps });
        }
        paused = 'unconfirmed';
        if (state === 'ok') {
          try {
            const back = await readBlocked(c.client, r.repo, r.number, b.labels.blocked);
            const h = b.labels.human.toLowerCase();
            if (back.state === 'open' && back.labels.some((l) => l.toLowerCase() === h)) paused = 'yes';
          } catch {
            // not read back: not confirmed
          }
        }
        why = `${text}（另一份登记和本次交错：${state === 'ok' ? `已补挂「${b.labels.human}」` : `补挂「${b.labels.human}」没有成功：${reason}`}）`;
      } else why = `${text}（没有补挂「${b.labels.human}」：${may.why}）`;
    }
    this.blockedPatch(id, (x) => ({ ...x, blocked: { ...x.blocked!, stop: { text: why, paused } } }));
    await this.storeOps();
  }

  private async blockedFindComment(client: GitHubClient, repo: string, number: number, opId: string): Promise<number | null> {
    try {
      const list = await readComments(client, repo, number);
      return list.find((x) => isOpComment(x.body, opId))?.id ?? null;
    } catch {
      return null;
    }
  }

  /** one read after a lost answer: did the step happen? (labels, the native list, the comment by its hidden id) */
  private async blockedEvidence(client: GitHubClient, r: OpRecord, s: OpStep, opId: string): Promise<{ reason: string; commentId?: number } | null> {
    try {
      if (s.name === 'comment') {
        const cid = await this.blockedFindComment(client, r.repo, r.number, opId);
        return cid !== null ? { reason: '重读时找到了这条登记评论', commentId: cid } : null;
      }
      const read = await readBlocked(client, r.repo, r.number, r.blocked!.labels.blocked);
      const has = (l: string) => read.labels.some((x) => x.toLowerCase() === l.toLowerCase());
      if (s.name === 'addLabel' && has(s.label ?? '')) return { reason: '重读时这个标签已在' };
      if (s.name === 'removeLabel' && !has(s.label ?? '')) return { reason: '重读时这个标签已不在' };
      if (s.name === 'relation' && read.native.some((x) => refKey(x) === s.target)) return { reason: '重读时这条「Blocked by」已在' };
    } catch {
      // not read: stays unknown
    }
    return null;
  }

  /** Why nothing conflicting may be sent for this item now; null = it may. */
  private opBlocked(key: string): string | null {
    const lock = opLockOf([...this.ops.values()], key);
    if (lock) return `上一次操作还没结清，没有发送：${opText(lock)}`;
    // GitHub#359: a record that is going on by itself right now (reading before its next step) is not finished
    // or started over from elsewhere in between
    if ([...this.ops.values()].some((r) => r.key === key && this.opJobs.has(r.id) && opNextAuto(r) >= 0)) return '上一次操作还在自动处理剩下的步骤，没有发送';
    if (this.opPreparing.has(key)) return '正在准备补做上一次操作剩下的步骤，没有发送';
    return null;
  }

  private launchOp(id: string, item: Item, client?: { client: GitHubClient; session: number }): void {
    const session = this.session;
    const job = this.runOp(id, item, client)
      .catch(() => undefined)
      .then(() => {
        // whatever happened, it no longer runs: the record says what came of it
        const r = this.ops.get(id);
        if (!r || !r.running || session !== this.session) return;
        this.setOp({ ...r, running: false });
        this.opsChanged();
        void this.storeOps();
      });
    this.opJobs.set(id, job);
    void job.then(() => {
      if (this.opJobs.get(id) === job) this.opJobs.delete(id);
    });
  }

  /** The requests of a record, one after the other; then the re-reads, then (if an answer never came) the evidence. */
  private async runOp(id: string, item: Item, given?: { client: GitHubClient; session: number }): Promise<void> {
    const session = this.session;
    const fail = (reason: string) => {
      const r = this.ops.get(id);
      if (!r || session !== this.session) return;
      // nothing went out: the first step that was going to carries why
      const i = r.steps.findIndex((s) => s.state === 'unsent');
      if (i < 0) return;
      this.setOp({ ...r, steps: r.steps.map((s, j) => (j === i ? { ...s, reason } : s)) });
      this.opsChanged();
      void this.storeOps();
    };
    // stored before anything goes out: not stored = not sent
    if (!(await this.storeOps())) return fail('没能存到本机，没有发送');
    const c = given ?? (await this.clientForCall(true));
    if ('error' in c) return fail(c.error);
    if (c.session !== session || session !== this.session) return;
    // what the item already has (code review round 1): evidence for a step whose answer never comes must be newer
    const first = this.ops.get(id);
    if (first && first.before === undefined && first.steps.some(needsRecords)) {
      let before: OpRecord['before'] = null;
      try {
        // GitHub#359: the labels too — the label records made later must add up to the labels read then
        const rec = await readItemSnapshot(c.client, item.repo, item.number, null);
        before = { comments: rec.comments.map((x) => x.id), events: rec.labelEvents.map((x) => x.id), labels: rec.labels, state: rec.state };
      } catch {
        // sent anyway; a step of it whose answer never comes can then only be checked by a person
      }
      if (session !== this.session) return;
      const now = this.ops.get(id);
      if (!now) return;
      this.setOp({ ...now, before });
    }
    const sent = await this.sendSteps(id, item, c, {});
    if (!sent || session !== this.session) return;
    // GitHub#357: an answer that never came is looked into right away (the re-read, then the evidence):
    // the notice reads as checking from here, not as a problem nobody is working on. GitHub#359: to the
    // end of the app's own checks (the one made at once and the few after it) — settleOp ends it.
    const lost = this.ops.get(id);
    if (lost && opPhase(lost) === 'unknown') {
      this.setOp({ ...lost, checking: true, checkProblem: null });
      this.opsChanged();
    }
    try {
      await this.opReread(id, item, c);
      await this.settleOp(id, item, c, { first: true });
    } finally {
      const left = session === this.session ? this.ops.get(id) : undefined;
      if (left?.checking) {
        this.setOp({ ...left, checking: false });
        this.opsChanged();
      }
    }
  }

  /**
   * GitHub#359: resolved when a record's own run has nothing more to do right away — its requests, re-reads
   * and the check made at once are through and only the later checks (seconds apart) are left. `act` waits
   * for this, not for those.
   */
  private opFirst = new Map<string, () => void>();

  /**
   * The requests of a record, one after the other, stopping at the first that is not done. GitHub#359:
   * `gated` — these sends were not asked for by a click at this moment (the steps left after an unknown
   * one was proven; a step a person sends again, `resend`): each goes out only after opPermit allowed it
   * on a read made right before it. Returns whether a request went out.
   */
  private async sendSteps(id: string, item: Item, c: { client: GitHubClient; session: number }, opts: { gated?: boolean; resend?: number; decided?: OpSnapshot | null }): Promise<boolean> {
    const session = this.session;
    let sent = false;
    let decided = opts.decided;
    const start = this.ops.get(id);
    if (start && !start.running) {
      this.setOp({ ...start, running: true });
      this.opsChanged();
    }
    for (let i = 0; ; i++) {
      let r = this.ops.get(id);
      if (!r || session !== this.session || i >= r.steps.length) break;
      const again = opts.resend === i && r.steps[i].state === 'unknown';
      if (r.steps[i].state !== 'unsent' && !again) continue;
      if (i > 0 && r.steps[i - 1].state !== 'ok') break;
      // GitHub#451: the first label after a hand-over's comment is judged on a fresh read like a send nobody
      // clicked — the item may have been closed, or its labels changed, while the comment was on its way
      // (code review round 2: every label after it, not only the first — a maintainer may stop it while any of them is on its way)
      const follow = !opts.gated && !again && i > 0 && r.steps.slice(0, i).some((x) => x.name === 'comment') && (r.kind === 'autopilot' || r.kind === 'handBack');
      const rightAfter = follow && r.steps[i - 1].name === 'comment';
      if (opts.gated || follow) {
        const mode = again ? ('resend' as const) : follow ? ('follow' as const) : ('auto' as const);
        // judged twice: on the read the decision was made on (when there is one), and on one made right now
        const snaps: (OpSnapshot | null)[] = decided !== undefined ? [decided] : [];
        decided = undefined;
        snaps.push(await this.readOpSnapshot(c.client, r));
        if (session !== this.session) return sent;
        const now = this.ops.get(id);
        if (!now) return sent;
        r = now;
        const verdicts = snaps.map((snap) => opPermit(now, i, snap, { mode, now: this.stamp(), autoMs: this.deps.opAutoMs ?? OP_AUTO_MS }));
        const no = verdicts.find((v) => !v.ok);
        if (no && !no.ok) {
          const last = verdicts[verdicts.length - 1];
          if (!last.ok && last.why === 'satisfied' && verdicts.every((v) => v.ok || v.why === 'satisfied')) {
            // the wanted state is already there: done without a send
            this.setOp({ ...now, steps: now.steps.map((x, j) => (j === i ? { ...x, state: 'ok' as const, reason: last.text, answeredAt: this.stamp() } : x)) });
            this.opsChanged();
            await this.storeOps();
            continue;
          }
          // could not be read: nothing is sent now, the next check / round judges again. Anything else ends "by
          // itself" for the steps left; a step a person wanted sent again just stays "not sure" (its verdict says why)
          const halt =
            follow
              ? {
                  halt: {
                    text:
                      no.why === 'unread'
                        ? rightAfter
                          ? '评论发出后没能完整读到这一条现在的状态，没敢接着改标签'
                          : '改标签途中没能完整读到这一条现在的状态，没敢接着改'
                        : rightAfter
                          ? `评论发出期间${no.text.replace(/^这期间/, '')}`
                          : no.text,
                    redo: no.redo === true,
                  },
                  auto: false,
                }
              : no.why === 'unread'
                ? again
                  ? { checkProblem: no.text }
                  : {}
                : again
                  ? {}
                  : { halt: { text: no.text, redo: no.redo === true }, auto: false };
          this.setOp(opCheckSteps({ ...now, ...halt }, snaps[snaps.length - 1]));
          this.opsChanged();
          await this.storeOps();
          break;
        }
      }
      this.setOp(
        (r = {
          ...r,
          ...(again ? { halt: null, auto: true, autoSince: this.stamp() } : {}),
          steps: r.steps.map((s, j) => (j === i ? { ...(({ check: _c, ...rest }) => rest)(s), state: 'pending' as const, reason: null, sentAt: this.stamp(), ...(again ? { resent: (s.resent ?? 0) + 1 } : {}) } : s)),
        }),
      );
      this.opsChanged();
      if (!(await this.storeOps())) {
        const now = this.ops.get(id);
        if (now && session === this.session) {
          // not stored = not sent: a step sent again goes back to "not sure" (its first request stands)
          this.setOp({ ...now, steps: now.steps.map((s, j) => (j === i ? (again ? { ...s, state: 'unknown' as const, reason: '没能存到本机，没有重发' } : { ...s, state: 'unsent' as const, reason: '没能存到本机，没有发送', sentAt: null }) : s)) });
          this.opsChanged();
        }
        break;
      }
      sent = true;
      let state: 'ok' | 'refused' | 'unknown';
      let reason: string | null = null;
      try {
        await this.sendStep(c.client, item, r, i);
        state = 'ok';
      } catch (e) {
        if (r.steps[i].name === 'removeLabel' && e instanceof GitHubError && e.status === 404) {
          // the label is not on it (any more): that is the state wanted
          state = 'ok';
          reason = '这个标签本来就不在';
        } else if (refusedForSure(e)) {
          state = 'refused';
          reason = explainError(e, this.stepKind(r, i));
        } else {
          state = 'unknown';
          reason = unknownReason(e);
        }
        if (!(e instanceof ActionRefused)) this.noteAuthFailure(e);
      }
      if (session !== this.session) return sent;
      const now = this.ops.get(id);
      if (!now) return sent;
      // GitHub#359: the sending stops at a label step whose answer never came — once that step is proven
      // (by a check, or by any read) what is left may go out by itself, in this run of the app
      const goOn = state === 'unknown' && (now.kind === 'autopilot' || now.kind === 'handBack') && !now.auto ? { auto: true, autoSince: now.autoSince ?? now.startedAt } : {};
      this.setOp({ ...now, ...goOn, steps: now.steps.map((s, j) => (j === i ? { ...s, state, reason, answeredAt: this.stamp() } : s)) });
      this.opsChanged();
      await this.storeOps();
      if (state !== 'ok') break;
    }
    // every request has its result: from here the steps lock by themselves (unknown / waiting for the re-read)
    const done = this.ops.get(id);
    if (done?.running && session === this.session) {
      this.setOp({ ...done, running: false });
      this.opsChanged();
    }
    return sent;
  }

  /** GitHub#359: the item as one snapshot (state, labels, label records back to what the record saw before it started); null = not read. */
  private async readOpSnapshot(client: GitHubClient, r: OpRecord): Promise<OpSnapshot | null> {
    try {
      const snap = await readItemSnapshot(client, r.repo, r.number, r.before?.events ?? null);
      return { complete: snap.complete, labelsComplete: snap.labelsComplete, state: snap.state, labels: snap.labels, events: snap.labelEvents };
    } catch {
      return null;
    }
  }

  /**
   * GitHub#359: what a record does by itself after its requests: while a step's answer never came it is
   * checked (at once when `first`, then after each of the waits — reads only); once nothing is unknown the
   * steps not sent yet go out (sendSteps, gated), and if one of those is not answered either the checks
   * start again. Ends when nothing is left to do by itself: a person takes over from the notice.
   */
  private async settleOp(
    id: string,
    item: Item,
    c: { client: GitHubClient; session: number },
    opts: {
      /** check at once (the record's own run, a sync round's check) before any wait */
      first: boolean;
      /** the waits before the later checks; default: the app's own burst */
      waits?: readonly number[];
      /** the snapshot of a check the caller made just now */
      checked?: OpSnapshot | null;
      /** a sync round's check: a background loop — the notice does not read as checking for it (GitHub#357) */
      background?: boolean;
    },
  ): Promise<void> {
    const { first, checked } = opts;
    const waits = opts.waits ?? this.deps.opCheckDelaysMs ?? OP_CHECK_DELAYS_MS;
    const show = !opts.background;
    const session = c.session;
    const mine = () => session === this.session && this.ops.get(id) !== undefined;
    for (let pass = 0; pass < 8; pass++) {
      // the snapshot of the check that proved the step in this pass (never an older one: it would judge a state long gone)
      let decided: OpSnapshot | null | undefined = pass === 0 ? checked : undefined;
      const r = this.ops.get(id);
      if (!r || !mine()) return;
      if (opPhase(r) === 'unknown') {
        const delays = [...(first || pass > 0 ? [0] : []), ...waits];
        if (!delays.length) return;
        if (show && !r.checking) {
          this.setOp({ ...r, checking: true, checkProblem: null });
          this.opsChanged();
        }
        try {
          for (const ms of delays) {
            if (ms > 0) this.opFirst.get(id)?.();
            if (ms > 0 && !(await this.opWait(ms))) return;
            const cur = this.ops.get(id);
            if (!cur || !mine()) return;
            if (opPhase(cur) !== 'unknown') break;
            const cc = ms > 0 ? await this.clientForCall(false) : c;
            if ('error' in cc) {
              this.patchOp(id, { checkProblem: cc.error });
              continue;
            }
            if (cc.session !== session) return;
            decided = await this.recheckWith(id, cc, true, false);
            if (!mine()) return;
          }
        } finally {
          const end = this.ops.get(id);
          if (end?.checking && session === this.session) {
            this.setOp({ ...end, checking: false });
            this.opsChanged();
            void this.storeOps();
          }
        }
      }
      const now = this.ops.get(id);
      if (!now || !mine() || opNextAuto(now) < 0) return;
      const cw = await this.clientForCall(true);
      if ('error' in cw || cw.session !== session) return;
      // the first of the two judgements: the read of the check that proved the step, or (proven by another read) one made now
      if (decided === undefined) decided = await this.readOpSnapshot(cw.client, now);
      if (!mine()) return;
      const sent = await this.sendSteps(id, item, cw, { gated: true, decided });
      if (!sent || !mine()) return;
      await this.opReread(id, item, cw);
    }
  }

  /** a wait between two automatic checks; false = the session ended meanwhile (do not go on) */
  private opWait(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.opWaits.delete(t);
        resolve(true);
      }, ms);
      this.opWaits.set(t, resolve);
    });
  }

  private endOpWaits(): void {
    for (const [t, resolve] of this.opWaits) {
      clearTimeout(t);
      resolve(false);
    }
    this.opWaits.clear();
  }

  /**
   * GitHub#359: after a sync round that reached GitHub, every record with a step still unknown is checked
   * once more (reads only), and a record whose unknown step a read proved meanwhile goes on with the steps
   * it has left — both only when nothing of that record runs already.
   */
  private catchUpChecks(session: number): void {
    for (const r of [...this.ops.values()]) {
      if (session !== this.session || !this.signedIn) return;
      if (r.running || r.checking || this.opJobs.has(r.id) || this.opPreparing.has(r.key)) continue;
      // GitHub#434: a "等前置…" record is never checked or continued in the background (each write needs its whole permit; a person reopens the dialog)
      if (r.kind === 'blocked') continue;
      const unknown = opPhase(r) === 'unknown';
      if (!unknown && opNextAuto(r) < 0) continue;
      const item = this.findItem(r.key);
      if (!item) continue;
      this.launchJob(r.id, this.settleOp(r.id, item, { client: this.client(session), session }, { first: unknown, waits: [], background: true }));
    }
  }

  /** A job of a record that is not its first run: kept in opJobs so nothing else of it starts meanwhile. */
  private launchJob(id: string, run: Promise<void>): void {
    const job = run.catch(() => undefined).then(() => {
      const r = this.ops.get(id);
      if (r?.running) {
        this.setOp({ ...r, running: false });
        this.opsChanged();
      }
      void this.storeOps();
    });
    this.opJobs.set(id, job);
    void job.then(() => {
      if (this.opJobs.get(id) === job) this.opJobs.delete(id);
    });
  }

  /**
   * Check a record with a step whose answer never came now (reads only), as every sync round does
   * (GitHub#359: the window no longer has a button for it); a step this proves lets the record go on.
   */
  async opRecheck(id: string): Promise<WriteResult> {
    const r = this.ops.get(id);
    if (!r || opPhase(r) !== 'unknown') return { ok: false, error: '这次操作没有需要查证的步骤', warning: null };
    if (r.checking || this.opJobs.has(id)) return { ok: false, error: '正在查证，稍等', warning: null };
    const c = await this.clientForCall(false);
    if ('error' in c) {
      this.patchOp(id, { checkProblem: c.error });
      return { ok: false, error: c.error, warning: null };
    }
    const item = this.findItem(r.key);
    const run = this.recheckWith(id, c).then((snap) => (item ? this.settleOp(id, item, c, { first: false, waits: [], checked: snap }) : undefined));
    this.launchJob(id, run);
    await this.opJobs.get(id);
    const after = this.ops.get(id);
    return after && opPhase(after) === 'unknown' ? { ok: false, error: after.checkProblem ?? '还是查不到这一步的结果', warning: null } : { ok: true, error: null, warning: null };
  }

  /**
   * GitHub#359, "仍要重发…": a person, told what it can cause, sends a label step again whose answer never
   * came and that a full read did not find. Checked once more first (a step proven by that check is not
   * sent: the record just goes on); the send itself is judged again on a read made right before it.
   */
  async opResend(id: string): Promise<WriteResult> {
    const refuse = (error: string): WriteResult => ({ ok: false, error, warning: null });
    const r = this.ops.get(id);
    if (!r) return refuse('这次操作已经不在了');
    const i = opResendStep(r);
    if (i < 0 || this.opJobs.has(id)) return refuse('这一步现在不能重发');
    if (!writesEnabled(this.state.sync)) return refuse('离线时不能修改：GitHub 上什么都没改');
    if (this.opPreparing.has(r.key)) return refuse('这一条正在准备别的操作，没有发送');
    const item = this.findItem(r.key);
    if (!item) return refuse('看板上找不到这一条，请刷新后再试');
    this.opPreparing.add(r.key);
    try {
      const c = await this.clientForCall(true);
      if ('error' in c) return refuse(c.error);
      const decided = await this.recheckWith(id, c);
      if (c.session !== this.session) return refuse('账号已切换');
      const now = this.ops.get(id);
      if (!now) return refuse('这次操作已经不在了');
      if (now.steps[i].state !== 'unknown') {
        // the check found it done after all: nothing is sent again; the person is here, so what is left goes on
        this.setOp({ ...now, auto: now.kind === 'autopilot' || now.kind === 'handBack', autoSince: this.stamp(), halt: null });
        this.opsChanged();
        this.launchJob(id, this.settleOp(id, item, c, { first: false, waits: [], checked: decided }));
        return { ok: true, error: null, warning: '核对时发现上一次请求已经生效，没有重发' };
      }
      if (opResendStep(now) !== i) return refuse(`没有重发：${opText(now)}`);
      const permit = opPermit(now, i, decided ?? null, { mode: 'resend', now: this.stamp() });
      if (!permit.ok) return refuse(`没有重发：${permit.text}`);
      this.launchJob(
        id,
        (async () => {
          const sent = await this.sendSteps(id, item, c, { gated: true, resend: i, decided: decided ?? null });
          if (!sent || c.session !== this.session) return;
          await this.opReread(id, item, c);
          await this.settleOp(id, item, c, { first: true });
        })(),
      );
      return { ok: true, error: null, warning: null };
    } finally {
      this.opPreparing.delete(r.key);
    }
  }

  private stepKind(r: OpRecord, i: number): WriteAction['kind'] {
    const n = r.steps[i].name;
    if (n === 'merge') return 'merge';
    if (n === 'close') return r.kind === 'closePr' ? 'closePr' : 'closeIssue';
    if (n === 'comment') return 'comment';
    return n === 'addLabel' ? 'addLabel' : 'removeLabel';
  }

  private async sendStep(client: GitHubClient, item: Item, r: OpRecord, i: number): Promise<void> {
    const s = r.steps[i];
    switch (s.name) {
      case 'close':
        return closeStep(client, item, r.draft.reason);
      case 'comment':
        return commentStep(client, item, r.draft.comment ?? '');
      case 'merge':
        return mergeStep(client, item, r.draft.method ?? 'merge', r.draft.headOid ?? '');
      case 'addLabel':
        return addLabel(client, item.repo, item.number, s.label ?? '');
      case 'removeLabel':
        return removeLabel(client, item.repo, item.number, s.label ?? '');
    }
  }

  /**
   * The item, and what a merge / close of a PR also changed, read again; their landing feeds the records.
   * GitHub#279: `quiet` (the catch-up after a sync round) asks for no sync round at all — not when a
   * read fails, not when one lands while a round runs, not a follow-up one.
   */
  private async opReread(id: string, item: Item, c: { client: GitHubClient; session: number }, quiet = false): Promise<void> {
    const r = this.ops.get(id);
    if (!r) return;
    const touched: [string, number][] = [[r.repo, r.number]];
    const problems: string[] = [];
    const closedPr = (r.kind === 'merge' || r.kind === 'closePr') && r.steps[0].state !== 'refused' && r.steps[0].state !== 'unsent';
    if (closedPr) {
      try {
        const rel = await relatedIssues(c.client, item, this.cachedItems());
        touched.push(...rel.items);
        if (rel.problem) problems.push(rel.problem);
      } catch (e) {
        // the follow-up round reads them
        problems.push(`没读到这个 PR 关联的 issue（${(e as Error)?.message ?? String(e)}），下一轮同步会更新`);
      }
    }
    for (const [repo, number] of touched) {
      if (c.session !== this.session) return;
      const read = await this.refreshOne(c.client, c.session, repo, number, { quiet });
      if (read.problem) problems.push(read.problem);
    }
    if (c.session !== this.session) return;
    if (!quiet) this.scheduleFollowUp(c.session);
    const now = this.ops.get(id);
    if (now && (problems.length || now.readProblem)) this.patchOp(id, { readProblem: problems.length ? problems.join('；') : null });
  }

  /**
   * GitHub#279: after a sync round that reached GitHub, every record whose re-read did not work in full
   * ("修改已生效，但重读这一条失败…，下一轮同步会更新") is re-read once more with the same re-read, quietly
   * (no further round is asked for, so an unreachable item never loops). Only a re-read that works clears
   * the problem; one that fails puts its own reason there. A round that found nothing changed does not
   * prove the item was read, so it is never taken for that. Skipped: a record put away, one whose own
   * requests / re-reads still run, one already being caught up.
   */
  private async catchUpReads(session: number): Promise<void> {
    const due = [...this.ops.values()].filter((r) => r.readProblem && !r.dismissed && !r.running && !this.opJobs.has(r.id) && !this.catchingUp.has(r.id) && opPhase(r) !== 'waiting');
    for (const r of due) {
      if (session !== this.session || !this.signedIn) return;
      this.catchingUp.add(r.id);
      try {
        // the merged / closed PR itself is what its linked issues are asked for (the cache may no longer carry it)
        const item = this.cachedItems().find((i) => i.key === r.key) ?? ({ key: r.key, repo: r.repo, number: r.number, kind: 'pr' } as Item);
        await this.opReread(r.id, item, { client: this.client(session), session }, true);
      } catch {
        // a re-read never throws on GitHub's account; anything else: the next round tries again
      } finally {
        this.catchingUp.delete(r.id);
      }
    }
  }

  /**
   * A read of this item landed (issued at `since`): every record of it reads the item from
   * the board data — the newest read issued at `since` or later that landed (the same rule
   * as the field changes' evidence). `own`: the read's own copy, when no source carries the item.
   */
  private feedOps(key: string, since: number, own: Item | null = null): void {
    let changed = false;
    for (const r of [...this.ops.values()]) {
      if (r.key !== key) continue;
      const seen = this.itemEvidence(key, since, own);
      if (!seen) continue;
      const next = opApplyRead(r, { issuedAt: since, ...seen });
      if (next !== r) {
        this.setOp(next);
        changed = true;
      }
    }
    if (changed) {
      this.opsChanged();
      void this.storeOps();
      this.goOnAfterRead(key);
    }
  }

  /** GitHub#359: a read proved an unknown step outside the record's own job: the steps it has left go on (gated). */
  private goOnAfterRead(key: string): void {
    for (const r of [...this.ops.values()]) {
      if (r.key !== key || opNextAuto(r) < 0 || this.opJobs.has(r.id) || this.opPreparing.has(r.key)) continue;
      const item = this.findItem(r.key);
      if (!item || !this.signedIn) continue;
      this.launchJob(r.id, this.settleOp(r.id, item, { client: this.client(this.session), session: this.session }, { first: false, waits: [], background: true }));
    }
  }

  /** The item's state and labels from landed reads issued at `since` or later (the newest wins); null = none that new. */
  private itemEvidence(key: string, since: number, own: Item | null): { state: 'open' | 'closed' | 'merged'; labels: string[] } | null {
    let best: { item: Item; at: number } | null = null;
    for (const snap of this.snapshots.values()) {
      if (!this.state.sources.some((s) => s.key === snap.sourceKey)) continue;
      const at = this.readAt(snap.sourceKey, key);
      if (at < since) continue; // only reads issued at `since` or later that landed
      const it = snap.items.find((i) => i.key === key);
      if (it && (!best || at > best.at)) best = { item: it, at };
    }
    const it = best?.item ?? own;
    return it ? { state: it.state, labels: it.labels.map((l) => l.name) } : null;
  }

  /**
   * One check of a record with a step whose answer never came (reads only): the item again (an unknown
   * close / merge read back closed / merged, a label read back on / off), then one snapshot — the comments
   * and label records as positive evidence, and (GitHub#359) for every label step still unknown what this
   * read found: not read / read in full and not there / touched by somebody. Never "it did not happen".
   * GitHub#357: the one place an evidence read runs — with `show` the notice reads as checking from here to
   * its end (unless a burst of checks already says so and ends it itself); the check of a sync round is a
   * background loop and does not (`show: false`).
   */
  private async recheckWith(id: string, c: { client: GitHubClient; session: number }, quiet = false, show = true): Promise<OpSnapshot | null | undefined> {
    const start = this.ops.get(id);
    if (!start) return undefined;
    const own = show && !start.checking;
    if (own) {
      this.setOp({ ...start, checking: true, checkProblem: null });
      this.opsChanged();
    }
    try {
      return await this.recheckRead(id, c, quiet);
    } finally {
      // every way out (the account changed: its records are gone with it)
      const left = c.session === this.session ? this.ops.get(id) : undefined;
      if (own && left?.checking) {
        this.setOp({ ...left, checking: false });
        this.opsChanged();
      }
    }
  }

  private async recheckRead(id: string, c: { client: GitHubClient; session: number }, quiet: boolean): Promise<OpSnapshot | null | undefined> {
    const start = this.ops.get(id);
    if (!start) return undefined;
    /** the snapshot this check read (null = it could not be read); undefined = this check needed none */
    let seen: OpSnapshot | null | undefined;
    const problems: string[] = [];
    const read = await this.refreshOne(c.client, c.session, start.repo, start.number, { quiet });
    if (read.kind === 'failed' && read.problem) problems.push(`重读这一条失败（${read.problem}）`);
    if (c.session !== this.session) return undefined;
    const login = this.state.viewer;
    const mid = this.ops.get(id);
    if (!mid) return undefined;
    if (mid.replyState === 'unknown' || mid.steps.some((s) => s.state === 'unknown' && needsRecords(s))) {
      let snap: Awaited<ReturnType<typeof readItemSnapshot>> | null = null;
      try {
        snap = await readItemSnapshot(c.client, mid.repo, mid.number, mid.before?.events ?? null);
      } catch (e) {
        problems.push(`读评论和标签记录失败（${(e as Error)?.message ?? String(e)}）`);
      }
      if (c.session !== this.session) return undefined;
      const view: OpSnapshot | null = snap ? { complete: snap.complete, labelsComplete: snap.labelsComplete, state: snap.state, labels: snap.labels, events: snap.labelEvents } : null;
      let now = this.ops.get(id);
      if (now) {
        if (snap) {
          if (!login) problems.push('不知道当前账号是谁，查不了评论和标签记录');
          else {
            // PR #510 review rounds 1–3: the same rule as a reply's proof — a comment another send owns proves nothing,
            // and a text another request may still land with (on its way / not sure / unlocked with a mark) is not proven
            const owned = new Set([...this.sends.values()].map((x) => x.commentId).filter((x): x is string => !!x));
            const blind = new Set<string>();
            for (const body of [now.draft.comment, now.reply?.body]) {
              if (!body) continue;
              const unclear = sameTextUnclear(now.key, body, now.id, [...this.sends.values()], [...this.ops.values()], this.liveMarks());
              if (unclear) {
                blind.add(body);
                problems.push(unclear);
              }
            }
            const out = opProveFromRecords(now, { ...snap, comments: snap.comments.filter((x) => !owned.has(x.id) && !blind.has(x.body)) }, login);
            now = out.record;
            problems.push(...out.missing.filter((m) => !m.includes('评论列表里没有') || !blind.size));
          }
          now = opProveFromSnapshot(now, view);
        }
        now = opCheckSteps(now, view);
        if (snap && !problems.length && now.steps.some((s) => s.state === 'unknown' && s.check === 'unread')) problems.push('没能完整读到这一条的标签记录');
        this.setOp(now);
        seen = view;
      }
    }
    if (c.session !== this.session) return undefined;
    const end = this.ops.get(id);
    if (!end) return undefined;
    this.setOp({ ...end, checks: (end.checks ?? 0) + 1, checkProblem: problems.length ? problems.join('；') : null });
    this.opsChanged();
    await this.storeOps();
    return seen;
  }

  /** "补做剩下的步骤": the item is read first; only the label steps still missing on GitHub go out, as a new record. */
  async opFinish(id: string): Promise<{ ok: boolean; error: string | null; id?: string }> {
    const r = this.ops.get(id);
    if (!r) return { ok: false, error: '这次操作已经不在了' };
    if (r.finishing) return { ok: false, error: '正在补做，稍等' };
    if (!finishSteps(r).length) return { ok: false, error: '没有需要补做的步骤' };
    // GitHub#357: running from before the first wait, the failure of the attempt before gone; every
    // way out below either says why this one did nothing (red) or hands over to the new record
    const session = this.session;
    const fail = (error: string) => {
      if (session === this.session) this.patchOp(id, { finishing: false, finishProblem: error });
      return { ok: false, error };
    };
    this.setOp({ ...r, finishing: true, finishProblem: null });
    this.opsChanged();
    if (!writesEnabled(this.state.sync)) return fail('离线时不能修改：GitHub 上什么都没改');
    const blocked = this.opBlocked(r.key);
    if (blocked) return fail(blocked);
    this.opPreparing.add(r.key);
    try {
      const c = await this.clientForCall(true);
      if (session !== this.session) return { ok: false, error: '账号已切换' };
      if ('error' in c) return fail(c.error);
      const read = await this.refreshOne(c.client, c.session, r.repo, r.number);
      if (c.session !== this.session) return { ok: false, error: '账号已切换' };
      const seen = read.kind === 'done' ? this.itemEvidence(r.key, read.issuedAt, read.own) : null;
      if (!seen) return fail(`重读这一条失败，什么都没发${read.problem ? `（${read.problem}）` : ''}`);
      const now = this.ops.get(id);
      if (!now) return { ok: false, error: '这次操作已经不在了' };
      const steps = finishSteps(now, seen.labels);
      const item = this.findItem(r.key);
      if (!item) return fail('看板上找不到这一条，请刷新后再试');
      this.opPreparing.delete(r.key);
      const lock = this.opBlocked(r.key);
      if (lock) return fail(lock);
      if (!steps.length) {
        this.setOp({ ...now, dismissed: true, finishing: false });
        this.pruneOps();
        this.opsChanged();
        void this.storeOps();
        return { ok: true, error: null };
      }
      const nid = `op-${++this.opSeq}`;
      const rec: OpRecord = {
        id: nid,
        key: r.key,
        repo: r.repo,
        number: r.number,
        kind: r.kind,
        startedAt: this.stamp(),
        steps,
        draft: {},
        readAt: null,
        targetSeen: false,
        unlocked: false,
        draftDropped: false,
        dismissed: false,
        stuck: false,
        checkProblem: null,
        finishOf: id,
        running: true,
      };
      this.setOp({ ...now, dismissed: true, finishing: false });
      this.setOp(rec);
      this.pruneOps();
      this.opsChanged();
      this.launchOp(nid, item, c);
      return { ok: true, error: null, id: nid };
    } finally {
      this.opPreparing.delete(r.key);
      const left = session === this.session ? this.ops.get(id) : undefined;
      if (left?.finishing) this.patchOp(id, { finishing: false });
    }
  }

  /** "已核对，解除锁定": local only, nothing is sent. */
  opUnlock(id: string): void {
    const r = this.ops.get(id);
    if (!r || r.unlocked) return;
    const p = opPhase(r);
    if (p !== 'unknown' && !(p === 'settling' && r.stuck)) return;
    // PR #510 review round 2: an attached comment / a reply from it whose answer never came may still land: no reply of
    // the same text here may take that comment as its own evidence for a while
    const pending = [
      ...(r.steps.some((s) => s.name === 'comment' && s.state === 'unknown') && r.draft.comment ? [r.draft.comment] : []),
      ...(r.replyState === 'unknown' && r.reply?.body ? [r.reply.body] : []),
    ];
    for (const body of pending) this.addSameTextMark(r.key, body);
    this.patchOp(id, { unlocked: true, dismissed: false });
    if (pending.length) void this.storeSends();
  }

  /** Put a notice away (a record still locking cannot be), or show it again. */
  opDismiss(id: string, dismissed = true): void {
    const r = this.ops.get(id);
    if (!r) return;
    if (dismissed && ['waiting', 'unknown', 'settling'].includes(opPhase(r))) return;
    this.patchOp(id, { dismissed });
  }

  /** "丢掉草稿": the only way besides the step being done. */
  opDropDraft(id: string): void {
    const r = this.ops.get(id);
    if (!r || opPhase(r) === 'waiting') return;
    this.patchOp(id, { draftDropped: true });
  }

  private patchOp(id: string, patch: Partial<OpRecord>): void {
    const r = this.ops.get(id);
    if (!r) return;
    this.setOp({ ...r, ...patch });
    this.pruneOps();
    this.opsChanged();
    void this.storeOps();
  }

  /**
   * A reply carrying an operation's kept comment (code review round 1): the outcome lands on that
   * record here, not in whichever panel sent it — sent = the draft is done; refused for sure (or
   * never sent) = offered again; no clear answer = "not sure", the comment is no longer offered
   * for the reply box. One such reply at a time per record.
   */
  private async actReplyFromDraft(action: Extract<WriteAction, { kind: 'comment' }> & { draftOf: string }): Promise<WriteResult> {
    const id = action.draftOf;
    const rec = this.ops.get(id);
    const { draftOf: _drop, ...plain } = action;
    if (!rec) return this.actNow(plain);
    const refuse = (error: string): WriteResult => ({ ok: false, error, warning: null });
    if (rec.replyState) return refuse('这条附带评论已经用来发过回复（结果还没确定），没有再发');
    // PR #510 review round 1: the same text sent from the reply box is still without a result
    if (this.sendCommentPending(rec.key, action.body)) return refuse('同样的一段评论刚发过，还没有结果（或还不确定有没有发出），等它有了结果再发');
    if (opPhase(rec) === 'waiting' || opPhase(rec) === 'unknown') return refuse(`这次操作还没结清，附带评论先不发：${opText(rec)}`);
    if (!this.signedIn || this.state.phase !== 'ready') return refuse('还没有登录');
    if (!writesEnabled(this.state.sync)) return refuse('离线时不能修改：GitHub 上什么都没改');
    const item = this.findItem(plain.key);
    if (!item || item.key !== rec.key) return refuse('看板上找不到这一条，回复没有发送');
    if (!plain.body.trim()) return refuse('评论是空的，没有发送');
    // code review round 3: everything below belongs to the session it started in. One client, bound
    // to that session (the back end refuses a request signed for a session that ended), is used for
    // every read and the write; after every wait the session and the record are checked again, and a
    // save that did not go through stops it. A sign-out / another account in between = nothing sent.
    const session = this.session;
    const mine = () => session === this.session && this.ops.get(id) !== undefined;
    const ended = () => refuse('账号已切换或这次操作已不在，回复没有发送');
    this.setOp({ ...rec, replyState: 'sending', reply: { body: plain.body, before: null } });
    this.opsChanged();
    const undo = (error: string): WriteResult => {
      const now = this.ops.get(id);
      if (now && session === this.session) {
        this.setOp({ ...now, replyState: null, reply: null });
        this.opsChanged();
        void this.storeOps();
      }
      return refuse(error);
    };
    // 1. "sending" on disk before anything goes out
    if (!(await this.storeOps())) return mine() ? undo('没能存到本机，回复没有发送') : ended();
    if (!mine()) return ended();
    // 2. the credential of this session (refreshed if due) — never of a later one
    const c = await this.clientForCall(true);
    if ('error' in c) return mine() ? undo(c.error) : ended();
    if (c.session !== session || !mine()) return ended();
    // 3. the comments already there (a comment proves this reply only when it is not one of them)
    let before: string[] | null = null;
    try {
      before = (await readItemRecords(c.client, rec.repo, rec.number)).comments.map((x) => x.id);
    } catch {
      // sent anyway; if its answer never comes it can only be checked by a person
    }
    if (!mine()) return ended();
    // 4. that list on disk too (not stored = not sent: the record must say what proves it)
    this.setOp({ ...this.ops.get(id)!, reply: { body: plain.body, before } });
    if (!(await this.storeOps())) return mine() ? undo('没能存到本机，回复没有发送') : ended();
    if (!mine()) return ended();
    // 5. the write, with the same client
    let outcome: 'ok' | 'refused' | 'unknown';
    let error: string | null = null;
    try {
      await commentStep(c.client, item, plain.body);
      outcome = 'ok';
    } catch (e) {
      outcome = refusedForSure(e) ? 'refused' : 'unknown';
      error = outcome === 'refused' ? explainError(e, 'comment') : `不确定有没有发出：${unknownReason(e)}`;
      if (!(e instanceof ActionRefused)) this.noteAuthFailure(e);
    }
    if (!mine()) return outcome === 'ok' ? { ok: true, error: null, warning: '账号已切换，这条回复的结果没有记下' } : refuse(error ?? '账号已切换');
    if (outcome === 'ok') this.patchOp(id, { replyState: null, reply: null, commentUsed: true });
    else if (outcome === 'refused') this.patchOp(id, { replyState: null, reply: null });
    else this.patchOp(id, { replyState: 'unknown' });
    if (outcome !== 'ok') return refuse(error ?? '没有发出');
    // the item read again with the same client, like any change
    const read = await this.refreshOne(c.client, c.session, item.repo, item.number);
    if (c.session === this.session) this.scheduleFollowUp(c.session);
    return { ok: true, error: null, warning: read.problem };
  }

  /** `act` for the five operations: started like the window does, then waited for (requests and re-reads). */
  private async actOp(action: OpAction): Promise<WriteResult> {
    const s = this.startOp(action);
    if (!s.ok || !s.id) return { ok: false, error: s.error, warning: null };
    // the requests, the re-reads and the check made at once — not the later checks of a step whose answer never came
    const id = s.id;
    await Promise.race([this.opJobs.get(id), new Promise<void>((resolve) => this.opFirst.set(id, resolve))]);
    this.opFirst.delete(id);
    const r = this.ops.get(s.id);
    if (!r) return { ok: false, error: '这次操作已经不在了', warning: null };
    const m = r.steps[0];
    if (m.state !== 'ok') return { ok: false, error: opText(r), warning: null };
    return { ok: true, error: null, warning: r.steps.every((x) => x.state === 'ok') && !r.readProblem ? null : opText(r) };
  }

  private setOp(rec: OpRecord): void {
    // GitHub#296: the one way into this.ops — a check problem / "stuck" that no longer stands goes here
    const r = opWithoutStale(rec);
    this.ops.set(r.id, r);
    // a succeeded record waiting for its re-read: the manual unlock is offered when the wait runs out
    const settling = opPhase(r) === 'settling' && !r.stuck;
    const t = this.opTimers.get(r.id);
    if (!settling) {
      if (t) clearTimeout(t);
      this.opTimers.delete(r.id);
    } else if (!t) {
      const session = this.session;
      this.opTimers.set(
        r.id,
        setTimeout(() => {
          this.opTimers.delete(r.id);
          const now = this.ops.get(r.id);
          if (!now || session !== this.session || opPhase(now) !== 'settling') return;
          this.setOp({ ...now, stuck: true });
          this.opsChanged();
          void this.storeOps();
        }, this.deps.opStuckMs ?? STUCK_MS),
      );
    }
  }

  /** Records settled, put away and with no draft left are forgotten. */
  private pruneOps(): void {
    for (const r of [...this.ops.values()]) {
      if (!opDisposable(r)) continue;
      this.ops.delete(r.id);
      const t = this.opTimers.get(r.id);
      if (t) clearTimeout(t);
      this.opTimers.delete(r.id);
    }
  }

  private opsChanged(): void {
    this.set({ ops: [...this.ops.values()] });
  }

  /** One row of the snapshot table, this session only (the back end drops it with the cache on sign-out). false = not stored. */
  private async storeOps(): Promise<boolean> {
    const session = this.session;
    const list = [...this.ops.values()];
    try {
      if (!list.length) {
        if (this.opsStored) {
          this.opsStored = false;
          this.cache.deleteSnapshot(OPS_KEY);
        }
        return session === this.session;
      }
      const row = { sourceKey: OPS_KEY, fetchedAt: this.now(), items: [], ops: list } as unknown as SourceSnapshot;
      const ok = await this.writeSnapshots(session, [row]);
      if (ok) this.opsStored = true;
      return ok;
    } catch {
      return false;
    }
  }

  /** The stored records as the last run left them: a request still waiting has no answer now, and nothing is sent again. */
  private loadOps(row: SourceSnapshot): void {
    const raw = (row as unknown as { ops?: unknown }).ops;
    const list = Array.isArray(raw) ? raw.filter(isOpRecord).map(opAfterRestart) : [];
    for (const r of list) {
      this.setOp({ ...r, stuck: false });
      this.stampAt = Math.max(this.stampAt, r.startedAt, ...r.steps.map((s) => Math.max(s.sentAt ?? 0, s.answeredAt ?? 0)), r.readAt ?? 0);
      const n = Number(/^op-(\d+)$/.exec(r.id)?.[1] ?? 0);
      if (n > this.opSeq) this.opSeq = n;
    }
    this.opsStored = true;
    this.state = { ...this.state, ops: [...this.ops.values()] };
  }

  // ---- GitHub#489: replies, edited bodies / comments / titles, ticked boxes ------------------------------

  /** a send (or an earlier write through `act`) still keeps this entry / title from another change */
  private sendHolding(slot: string): boolean {
    return [...this.sends.values()].some((r) => sendHolds(r) && sendSlot(r.action) === slot);
  }

  /**
   * A reply / an edit / a ticked box, sent for the window: it returns at once with the record's id (the
   * panel empties its box, closes its editor, and is free to go); the request, the answer, the re-read and
   * the checks are the controller's. Refused at once, nothing kept, when it cannot go out at all.
   */
  startSend(action: SendAction): { ok: boolean; error: string | null; id?: string } {
    const refuse = (error: string) => ({ ok: false, error });
    if (!action || typeof action !== 'object' || !['comment', 'editEntry', 'editTitle', 'toggleTask'].includes(action.kind)) return refuse('不认识的修改');
    if ((action as { draftOf?: unknown }).draftOf !== undefined) return refuse('带操作草稿的回复不走这里');
    if (!this.signedIn || this.state.phase !== 'ready') return refuse('还没有登录');
    if (!writesEnabled(this.state.sync)) return refuse('离线时不能修改：GitHub 上什么都没改');
    const item = this.findItem(action.key);
    if (!item) return refuse('看板上找不到这一条（可能刚被同步掉了），请刷新后再试');
    if (action.kind === 'comment' && !action.body.trim()) return refuse('评论是空的，没有发送');
    const slot = sendSlot(action);
    if (this.tasksInFlight.has(slot) || this.sendHolding(slot))
      return refuse(action.kind === 'comment' ? '同样的一段评论刚发过，还没有结果（或还不确定有没有发出），等它有了结果再发' : '这一条上一次修改还没完成（或还不确定有没有生效），等它有了结果再改');
    // PR #510 review round 1: the same text as an operation's reply / attached comment that is on its way or not sure
    if (action.kind === 'comment' && this.opCommentPending(item.key, action.body)) return refuse('同样的一段评论正由关闭 / 交给 agent 等操作发出，还没有结果，等它有了结果再发');
    const id = `send-${++this.sendSeq}`;
    const rec: SendRecord = {
      id,
      key: item.key,
      repo: item.repo,
      number: item.number,
      action,
      startedAt: this.stamp(),
      state: 'sending',
      sentAt: null,
      answeredAt: null,
      reason: null,
      warning: null,
      proof: null,
      returned: false,
      unlocked: false,
      dismissed: false,
    };
    // a newer send carrying an older refusal's text (the same entry / title, or a reply that holds the old one)
    // takes it over: the old record puts itself away with its text
    for (const r of [...this.sends.values()]) {
      if (r.key !== rec.key || r.state !== 'refused' || r.dropped || r.action.kind !== action.kind) continue;
      // a reply: the reply box goes out whole, so a refusal whose text went back into it (and may have been changed
      // there since, PR #510 review round 2) is carried by any reply of the item; one still waiting in its notice only
      // when its text is in the new one
      const carries =
        r.action.kind === 'comment' && action.kind === 'comment' ? (r.returned ? true : action.body.includes(r.action.body)) : sendSlot(r.action) === slot;
      if (carries) this.sends.set(r.id, { ...r, dismissed: true, dropped: true });
    }
    this.sends.set(id, rec);
    this.pruneSends();
    this.sendsChanged();
    void this.launchSend(id, this.runSend(id));
    return { ok: true, error: null, id };
  }

  /** A send's job: kept in sendJobs until it is through (stored included), so nothing else of it starts meanwhile. */
  private launchSend(id: string, run: Promise<void>): Promise<void> {
    const job: Promise<void> = run
      .catch(() => undefined)
      .then(() => this.storeSends())
      .then(() => {
        if (this.sendJobs.get(id) === job) this.sendJobs.delete(id);
      });
    this.sendJobs.set(id, job);
    return job;
  }

  private patchSend(id: string, patch: Partial<SendRecord>): SendRecord | null {
    const r = this.sends.get(id);
    if (!r) return null;
    const next = { ...r, ...patch };
    this.sends.set(id, next);
    this.pruneSends();
    this.sendsChanged();
    return next;
  }

  /** The send itself: on disk first, every check that can refuse it, the request, its answer, the re-read. */
  private async runSend(id: string): Promise<void> {
    const start = this.sends.get(id);
    if (!start) return;
    const session = this.session;
    const mine = () => session === this.session && this.sends.get(id) !== undefined;
    const notSent = (reason: string) => {
      if (mine()) this.patchSend(id, { state: 'refused', reason, answeredAt: this.stamp() });
    };
    // 1. "sending" on disk before anything goes out (a restart then finds it, and knows it was not sent)
    if (!(await this.storeSends())) return notSent('没能存到本机，没有发出');
    if (!mine()) return;
    const c = await this.clientForCall(true);
    if ('error' in c) return notSent(c.error);
    if (c.session !== session || !mine()) return;
    const item = this.findItem(start.key);
    if (!item) return notSent('看板上找不到这一条（可能刚被同步掉了），没有发出');
    // 2. every check before the write (each read that fails: nothing was sent)
    let prepared: Awaited<ReturnType<typeof prepareSend>>;
    try {
      prepared = await prepareSend(c.client, start.action, item, { proofs: true });
    } catch (e) {
      if (!(e instanceof ActionRefused)) this.noteAuthFailure(e);
      return notSent(explainError(e, start.action.kind));
    }
    if (!mine()) return;
    if (!prepared.write) {
      this.patchSend(id, { state: 'ok', reason: 'GitHub 上已经是这样，没有再发', answeredAt: this.stamp(), proof: prepared.proof, dismissed: sendQuiet(start.action) });
      return;
    }
    // 3. what proves it, and the moment it goes out, on disk too (not stored = not sent)
    this.patchSend(id, { proof: prepared.proof, sentAt: this.stamp() });
    if (!(await this.storeSends())) {
      if (mine()) this.patchSend(id, { sentAt: null });
      return notSent('没能存到本机，没有发出');
    }
    if (!mine()) return;
    // 4. the write
    let warning: string | null = null;
    let commentId: string | null = null;
    try {
      const w = await prepared.write();
      warning = w.warning;
      commentId = w.commentId ?? null;
    } catch (e) {
      if (!(e instanceof ActionRefused)) this.noteAuthFailure(e);
      if (!mine()) return;
      if (refusedForSure(e)) this.patchSend(id, { state: 'refused', reason: explainError(e, start.action.kind), answeredAt: this.stamp() });
      else {
        this.patchSend(id, { state: 'unknown', reason: unknownReason(e), answeredAt: this.stamp() });
        await this.storeSends();
        // checked once at once; then with every sync round
        await this.checkSend(id, c);
      }
      return;
    }
    if (!mine()) return;
    // a quiet one (a ticked box, a title) that simply went through has nothing left to say: forgotten at once
    this.patchSend(id, { state: 'ok', answeredAt: this.stamp(), warning, dismissed: !warning && sendQuiet(start.action), ...(start.action.kind === 'comment' ? { commentId } : {}) });
    await this.storeSends();
    // the item read again, like any change
    const read = await this.refreshOne(c.client, c.session, item.repo, item.number);
    if (c.session === this.session) this.scheduleFollowUp(c.session);
    if (read.problem && mine()) this.patchSend(id, { warning: [warning, read.problem].filter(Boolean).join('；') });
  }

  /** Read what proves an unknown send (reads only, nothing is sent). */
  private async checkSend(id: string, c: { client: GitHubClient; session: number }): Promise<void> {
    const r = this.sends.get(id);
    // PR #510 review round 2: a person unlocked it after checking GitHub — the app no longer checks it
    if (!r || r.state !== 'unknown' || r.unlocked) return;
    this.patchSend(id, { checking: true, checkProblem: null });
    let problem: string | null = null;
    let found = false;
    try {
      const ev = await readSendEvidence(c.client, r.action, r.repo, r.number);
      if (c.session !== this.session) return;
      const now = this.sends.get(id);
      if (!now || now.state !== 'unknown') return;
      const out = sendProve(now, { login: this.state.viewer, ...ev }, [...this.sends.values()], this.liveMarks(), [...this.ops.values()]);
      problem = out.missing;
      found = out.record.state === 'ok';
      this.sends.set(id, out.record);
    } catch (e) {
      if (!(e instanceof ActionRefused)) this.noteAuthFailure(e);
      problem = `读不到 GitHub 上现在的内容（${(e as Error)?.message ?? String(e)}）`;
    }
    if (c.session !== this.session) return;
    const end = this.sends.get(id);
    if (!end) return;
    this.patchSend(id, { checking: false, checks: (end.checks ?? 0) + 1, checkProblem: found ? null : problem });
    await this.storeSends();
    if (found) {
      await this.refreshOne(c.client, c.session, end.repo, end.number);
      if (c.session === this.session) this.scheduleFollowUp(c.session);
    }
  }

  /** 「再查一次」: check an unknown send now (reads only). */
  async sendRecheck(id: string): Promise<WriteResult> {
    const r = this.sends.get(id);
    if (!r) return { ok: false, error: '这条记录已经不在了', warning: null };
    if (r.state !== 'unknown') return { ok: true, error: null, warning: null };
    if (r.unlocked) return { ok: false, error: '已由人核对后解除锁定，不再自动核对', warning: null };
    if (this.sendJobs.has(id) || r.checking) return { ok: false, error: '正在查证，稍等', warning: null };
    const c = await this.clientForCall(false);
    if ('error' in c) return { ok: false, error: c.error, warning: null };
    await this.launchSend(id, this.checkSend(id, c));
    const end = this.sends.get(id);
    return end?.state === 'ok' ? { ok: true, error: null, warning: null } : { ok: false, error: end?.checkProblem ?? '还没查到（原来那次请求仍可能稍后生效）', warning: null };
  }

  /** 「再发一次」: a send refused for sure whose text no panel took back goes out again (all its checks again). */
  async sendResend(id: string): Promise<WriteResult> {
    const r = this.sends.get(id);
    if (!r) return { ok: false, error: '这条记录已经不在了', warning: null };
    if (r.state !== 'refused' || r.returned || r.dropped) return { ok: false, error: '这一条不能再发（原文已放回编辑框，或结果还不确定）', warning: null };
    if (this.sendJobs.has(id)) return { ok: false, error: '正在发送，稍等', warning: null };
    const slot = sendSlot(r.action);
    if (this.tasksInFlight.has(slot) || [...this.sends.values()].some((x) => x.id !== id && sendHolds(x) && sendSlot(x.action) === slot) || (r.action.kind === 'comment' && this.opCommentPending(r.key, r.action.body)))
      return { ok: false, error: '这一条上一次修改还没完成（或还不确定有没有生效），等它有了结果再试', warning: null };
    if (!writesEnabled(this.state.sync)) return { ok: false, error: '离线时不能修改：GitHub 上什么都没改', warning: null };
    this.patchSend(id, { state: 'sending', reason: null, sentAt: null, answeredAt: null, warning: null, proof: null, dismissed: false, checks: 0, checkProblem: null });
    await this.launchSend(id, this.runSend(id));
    const end = this.sends.get(id);
    return end?.state === 'ok' ? { ok: true, error: null, warning: end.warning } : { ok: false, error: end?.reason ?? '没有发出', warning: null };
  }

  /** The panel that shows the item put a refused send's text back into its edit box. */
  sendReturned(id: string): void {
    const r = this.sends.get(id);
    if (!r || r.state !== 'refused' || r.returned) return;
    this.patchSend(id, { returned: true });
    void this.storeSends();
  }

  /**
   * PR #510 review round 1: the text a panel took back left its box without being sent from there (the box
   * was emptied, the editor cancelled): the record no longer keeps it, and a restart does not bring it back.
   */
  sendDropped(id: string): void {
    const r = this.sends.get(id);
    if (!r || r.state !== 'refused' || r.dropped) return;
    this.patchSend(id, { dropped: true });
    void this.storeSends();
  }

  /** an operation of this item is sending exactly this text as a reply or its attached comment, or does not know whether it went out */
  private opCommentPending(key: string, body: string): boolean {
    return [...this.ops.values()].some(
      (o) =>
        o.key === key &&
        // unlocked by a person after checking GitHub: no longer holds the text (its same-text mark guards the evidence)
        !o.unlocked &&
        (((o.replyState === 'sending' || o.replyState === 'unknown') && o.reply?.body === body) ||
          (o.draft.comment === body && o.steps.some((s) => s.name === 'comment' && (s.state === 'pending' || s.state === 'unknown' || (s.state === 'unsent' && o.running))))),
    );
  }

  /** a reply of the controller with this text on this item is on its way or not sure */
  private sendCommentPending(key: string, body: string): boolean {
    return this.sendHolding(sendSlot({ kind: 'comment', key, body }));
  }

  /** "已核对，解除锁定" on an unknown send: local only; the text stays in the notice until it is put away. */
  sendUnlock(id: string): void {
    const r = this.sends.get(id);
    if (!r || r.state !== 'unknown') return;
    // PR #510 review round 2: its request may still land: no other reply of the same text here may take that comment as its own
    if (r.action.kind === 'comment') this.addSameTextMark(r.key, r.action.body);
    this.patchSend(id, { unlocked: true });
    void this.storeSends();
  }

  /** the same-text marks still in force */
  /** every same-text mark of this account: they never expire (shared/sends.ts, review round 4) */
  private liveMarks(): SameTextMark[] {
    return this.sameText;
  }

  private addSameTextMark(key: string, body: string): void {
    if (this.sameText.some((m) => m.key === key && m.body === body)) return;
    this.sameText = [...this.sameText, { key, body, at: this.now() }];
  }

  /**
   * PR #510 review round 2: a taken-back text as its edit box holds it now (the person changed it there): kept on
   * disk with the record, so a restart gives back the latest text. Written a moment after the typing stops.
   */
  sendDraft(id: string, text: string): void {
    const r = this.sends.get(id);
    if (!r || r.state !== 'refused' || r.dropped || typeof text !== 'string' || r.draft === text) return;
    this.sends.set(id, { ...r, draft: text });
    this.sendsChanged();
    if (this.sendDraftTimer) clearTimeout(this.sendDraftTimer);
    this.sendDraftTimer = setTimeout(() => {
      this.sendDraftTimer = null;
      void this.storeSends();
    }, 300);
  }

  /** ×: only when the notice may be put away (never on its way, never unknown and still locked) */
  sendDismiss(id: string): void {
    const r = this.sends.get(id);
    if (!r || r.state === 'sending' || (r.state === 'unknown' && !r.unlocked)) return;
    // a refused text no panel took back yet: putting it away is not losing it — it goes back to the box when the item is opened
    this.patchSend(id, { dismissed: true });
    void this.storeSends();
  }

  /** every sync round that reached GitHub: the unknown sends are checked again (reads only) */
  private catchUpSends(session: number): void {
    for (const r of [...this.sends.values()]) {
      if (session !== this.session || !this.signedIn) return;
      if (r.state !== 'unknown' || r.unlocked || r.checking || this.sendJobs.has(r.id)) continue;
      void this.launchSend(r.id, this.checkSend(r.id, { client: this.client(session), session }));
    }
  }

  /** Records put away with nothing left to hold are forgotten. */
  private pruneSends(): void {
    for (const r of [...this.sends.values()]) if (sendDisposable(r)) this.sends.delete(r.id);
  }

  private sendsChanged(): void {
    this.set({ sends: [...this.sends.values()] });
  }

  /** One row of the snapshot table, this session only. false = not stored. */
  private async storeSends(): Promise<boolean> {
    const session = this.session;
    // what is running in this run of the app is not kept
    const list = [...this.sends.values()].map(({ checking: _c, ...r }) => r);
    const marks = this.liveMarks();
    try {
      if (!list.length && !marks.length) {
        if (this.sendsStored) {
          this.sendsStored = false;
          this.cache.deleteSnapshot(SENDS_KEY);
        }
        return session === this.session;
      }
      const row = { sourceKey: SENDS_KEY, fetchedAt: this.now(), items: [], sends: list, marks } as unknown as SourceSnapshot;
      const ok = await this.writeSnapshots(session, [row]);
      if (ok) this.sendsStored = true;
      return ok;
    } catch {
      return false;
    }
  }

  /** The stored records as the last run left them: one on its way then has no answer now, and nothing is sent again. */
  private loadSends(row: SourceSnapshot): void {
    const raw = (row as unknown as { sends?: unknown }).sends;
    const list = Array.isArray(raw) ? raw.filter(isSendRecord).map(sendAfterRestart) : [];
    for (const r of list) {
      this.sends.set(r.id, r);
      this.stampAt = Math.max(this.stampAt, r.startedAt, r.sentAt ?? 0, r.answeredAt ?? 0);
      const n = Number(/^send-(\d+)$/.exec(r.id)?.[1] ?? 0);
      if (n > this.sendSeq) this.sendSeq = n;
    }
    const marks = (row as unknown as { marks?: unknown }).marks;
    this.sameText = Array.isArray(marks) ? marks.filter(isSameTextMark).map((m) => ({ key: m.key, body: m.body, at: typeof m.at === 'number' ? m.at : 0 })) : [];
    this.sendsStored = true;
    this.state = { ...this.state, sends: [...this.sends.values()] };
  }
}

/** Why an answer never came (GitHub#250): the request may have been carried out. */
function unknownReason(e: unknown): string {
  if (e instanceof GitHubError) {
    if (e.kind === 'network') return `连接中断，没有收到 GitHub 的应答（${e.message}）`;
    if (e.status) return `GitHub 返回 HTTP ${e.status}，不确定有没有生效`;
  }
  return `没有收到明确的应答（${(e as Error)?.message ?? String(e)}）`;
}
