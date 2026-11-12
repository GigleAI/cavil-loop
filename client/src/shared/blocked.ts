// GitHub#434: "等前置…" — register what an item waits for, the way the cavil-loop daemon reads
// it, and put the item on the waiting label. The rules live here, pure (no GitHub, no Node):
// which items may enter, which registration counts in the current wait ("this round"), what a
// registration says, what the steps are, and — before every write — whether GitHub still holds
// what the person confirmed plus exactly what this operation already did.
//
// The daemon side is `blocked_decide` in scripts/_lib.sh. What a registration is and which one
// counts must agree with it: test/unit/blocked.test.ts runs the daemon's own jq program on the
// same comments and compares.

import { itemKey } from './sources';

/** GitHub#434: the labels of "等前置…" (Settings → 流程标签). */
export interface BlockedLabels {
  /** the waiting label — the same setting as the graph's (GitHub#429, `handBack.blocked`); '' = no "等前置…" button */
  blocked: string;
  /** the other flow labels, comma separated; `x/*` = every label starting with `x/`; case-insensitive */
  flow: string;
}

export const DEFAULT_BLOCKED_LABELS: BlockedLabels = { blocked: 'pending/blocked', flow: 'pending/*, doing/*, Done' };

/** the hidden mark the daemon reads (scripts/_lib.sh BLOCKED_MARK) */
export const BLOCKED_MARK = '<!-- agent-blocked-by:';
const RESOLVED_MARK = '<!-- agent-blocked-resolved';
/** the hidden id of one operation of this client, so its comment can be found again when the answer was lost */
const OP_MARK = 'cavil-blocked-op:';

/** The flow patterns of the setting, lower-cased, without blanks. */
export function flowPatterns(text: string): string[] {
  return text
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function matches(label: string, pattern: string): boolean {
  const l = label.toLowerCase();
  return pattern.endsWith('*') ? l.startsWith(pattern.slice(0, -1)) : l === pattern;
}

/**
 * Where an item stands for "等前置…":
 *   human   — waits for a person (the "等人处理" label), nothing else of the flow
 *   waiting — already on the waiting label
 *   paused  — both (a registration stopped half way, or paused while it is written)
 *   none    — no flow label at all
 *   other   — another flow label is on it (`label`): the daemon would not act on the wait
 */
export type EntryState = { kind: 'human' | 'waiting' | 'paused' | 'none' } | { kind: 'other'; label: string };

export function entryState(labels: readonly string[], names: { human: string; agent: string; running: string }, bl: BlockedLabels): EntryState {
  const human = names.human.trim().toLowerCase();
  const blocked = bl.blocked.trim().toLowerCase();
  const pats = [...flowPatterns(bl.flow), ...[names.agent, names.running].map((x) => x.trim().toLowerCase()).filter(Boolean)];
  let hasHuman = false;
  let hasBlocked = false;
  for (const l of labels) {
    const low = l.toLowerCase();
    if (low === human) hasHuman = true;
    else if (low === blocked) hasBlocked = true;
    else if (pats.some((p) => matches(l, p))) return { kind: 'other', label: l };
  }
  return { kind: hasHuman && hasBlocked ? 'paused' : hasHuman ? 'human' : hasBlocked ? 'waiting' : 'none' };
}

/** The labels whose changes matter to the operation: the flow ones, the "等人处理" label, the waiting label (lower-cased, sorted). */
export function flowLabelsOf(labels: readonly string[], names: { human: string; agent: string; running: string }, bl: BlockedLabels): string[] {
  const keep = new Set([names.human, bl.blocked, names.agent, names.running].map((x) => x.trim().toLowerCase()).filter(Boolean));
  const pats = flowPatterns(bl.flow);
  return [...new Set(labels.filter((l) => keep.has(l.toLowerCase()) || pats.some((p) => matches(l, p))).map((l) => l.toLowerCase()))].sort();
}

// ---- a registration ("登记"), read the way the daemon reads it ----

/** A prerequisite: `repo` is `owner/repo` lower-cased. */
export interface Ref {
  repo: string;
  number: number;
}

export function refKey(r: Ref): string {
  return itemKey(r.repo, r.number);
}

/** How a prerequisite is written in a mark: `#12` in the item's own repository, `owner/repo#12` elsewhere. */
export function refText(r: Ref, selfRepo: string): string {
  return r.repo === selfRepo.toLowerCase() ? `#${r.number}` : `${r.repo}#${r.number}`;
}

/**
 * A comment as the registration rule reads it (GitHub#429 / #434: the dependency graph and "等前置…"
 * read registrations with this one rule; data/loopBlocked.ts and data/blocked.ts fill it from
 * GraphQL and REST).
 */
export interface MarkComment {
  /** the comment's database id (the daemon's tie-break within one second) */
  id: number;
  body: string;
  createdAt: string;
  /** GitHub's author_association: OWNER / MEMBER / COLLABORATOR / … */
  authorAssociation: string;
}

/** A prerequisite as the daemon writes it: `r` '' = the item's own repository, else owner/repo lower-cased. */
export interface MarkEnd {
  r: string;
  n: number;
}

export interface RestEvent {
  id: number;
  event: string;
  created_at: string;
  label?: { name?: string } | null;
}

/** The current wait of the waiting label: the last "labeled" (its id is the wait's identity) and the last "unlabeled" time. */
export interface Round {
  /** last event of the waiting label: '' = none ever */
  last: 'labeled' | 'unlabeled' | '';
  /** id of the last "labeled" of the waiting label; null = never put on */
  id: number | null;
  /** created_at of the last "unlabeled"; '' = never taken off */
  since: string;
}

export function roundOf(events: readonly RestEvent[], blocked: string): Round {
  let last: Round['last'] = '';
  let id: number | null = null;
  let since = '';
  for (const e of events) {
    if ((e.event !== 'labeled' && e.event !== 'unlabeled') || (e.label?.name ?? '') !== blocked) continue;
    last = e.event;
    if (e.event === 'labeled') id = e.id;
    else since = e.created_at;
  }
  return { last, id, since };
}

/** One registration of the current wait (oldest first). */
export interface Mark {
  id: number;
  createdAt: string;
  refs: Ref[];
  resume: string;
}

const REF_RE = /(?<![A-Za-z0-9_./-])([A-Za-z0-9][A-Za-z0-9-]*\/\.?[A-Za-z0-9_-][A-Za-z0-9_.-]*)?#([0-9]+)/g;
const TRUSTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

/**
 * The registrations that count, oldest first — the daemon's rule (scripts/_lib.sh `blocked_mark_pick`):
 * a comment holding the mark, written by a maintainer of the repository (OWNER / MEMBER / COLLABORATOR;
 * the daemon also accepts its own write account, which the client does not know — it has write access,
 * so in practice it is one of them), not one of the daemon's own "resolved" comments, and strictly after
 * the waiting label was last taken off (`since`, '' = never). The newest is what the daemon uses.
 */
export function countingMarks(comments: readonly MarkComment[], since: string): MarkComment[] {
  return comments
    .filter((c) => (c.body ?? '').includes(BLOCKED_MARK))
    .filter((c) => TRUSTED.has(c.authorAssociation ?? ''))
    .filter((c) => !c.body.includes(RESOLVED_MARK))
    .filter((c) => since === '' || (c.createdAt ?? '') > since)
    .sort((a, b) => ((a.createdAt ?? '') < (b.createdAt ?? '') ? -1 : (a.createdAt ?? '') > (b.createdAt ?? '') ? 1 : (a.id ?? 0) - (b.id ?? 0)));
}

/** What one registration says: the last mark of the comment, its prerequisites (daemon's `r`/`n`) and resume label. */
export function parseMark(body: string, self: string): { ends: MarkEnd[]; resume: string } {
  const marks = [...body.matchAll(/<!-- agent-blocked-by:([^>]*)-->/g)];
  const text = marks.length ? marks[marks.length - 1][1] : '';
  const seen = new Map<string, MarkEnd>();
  for (const x of text.matchAll(REF_RE)) {
    let r = (x[1] ?? '').toLowerCase();
    if (r === self.toLowerCase()) r = '';
    const n = Number(x[2]);
    seen.set(`${r}#${n}`, { r, n });
  }
  const ends = [...seen.values()].sort((a, b) => (a.r < b.r ? -1 : a.r > b.r ? 1 : a.n - b.n));
  return { ends, resume: /resume=([^ ]+)/.exec(text)?.[1] ?? '' };
}

/** The registrations of the current wait, oldest first (countingMarks), with their prerequisites as `Ref`s. */
export function roundMarks(comments: readonly MarkComment[], round: Round, selfRepo: string): Mark[] {
  const self = selfRepo.toLowerCase();
  return countingMarks(comments, round.since).map((c) => {
    const { ends, resume } = parseMark(c.body, self);
    return { id: c.id, createdAt: c.createdAt, refs: ends.map((e) => ({ repo: e.r || self, number: e.n })), resume };
  });
}

/** The comment a registration of this client is: a sentence for people, the daemon's mark, this operation's id. */
export function markComment(refs: readonly Ref[], selfRepo: string, resume: string, opId: string): string {
  const list = refs.map((r) => refText(r, selfRepo));
  return [
    `在等 ${list.join('、')} 完成，全部完成后 daemon 自动翻回 ${resume} 接着干（由 Cavil Loop 客户端登记）。`,
    '',
    `${BLOCKED_MARK} ${list.join(' ')} resume=${resume} -->`,
    `<!-- ${OP_MARK}${opId} -->`,
  ].join('\n');
}

/** Whether this comment is the one written by operation `opId`. */
export function isOpComment(body: string | null, opId: string): boolean {
  return (body ?? '').includes(`<!-- ${OP_MARK}${opId} -->`);
}

// ---- what GitHub holds now, and what the operation expects ----

/** One full read of the item for "等前置…" (data/blocked.ts reads it; every list to its last page). */
export interface BlockedRead {
  state: 'open' | 'closed' | 'merged';
  isPr: boolean;
  labels: string[];
  round: Round;
  marks: Mark[];
  /** the native "Blocked by" list */
  native: Ref[];
}

/** What the steps compare: the facts of a read that matter. */
export interface Facts {
  state: string;
  /** flowLabelsOf */
  flow: string[];
  round: { last: string; id: number | null | '*' ; since: string };
  /** ids of the registrations of the current wait */
  marks: number[];
  /** native "Blocked by", refKey, sorted */
  native: string[];
}

export function factsOf(read: BlockedRead, names: { human: string; agent: string; running: string }, bl: BlockedLabels): Facts {
  return {
    state: read.state,
    flow: flowLabelsOf(read.labels, names, bl),
    round: { ...read.round },
    marks: read.marks.map((m) => m.id),
    native: read.native.map(refKey).sort(),
  };
}

/** The fingerprint of a read: what the dialog showed. Two reads with the same one hold the same for this operation. */
export function fingerprint(f: Facts): string {
  return JSON.stringify([f.state, f.flow, f.round, f.marks, f.native]);
}

// ---- the plan ----

export type BlockedStepName = 'pause' | 'relation' | 'comment' | 'check' | 'addBlocked' | 'unpause' | 'repause';

export interface BlockedStepPlan {
  name: BlockedStepName;
  /** relation: the prerequisite's key */
  target?: string;
}

/** A prerequisite picked in the dialog. `id` is GitHub's numeric id of an issue (a native relation needs it). */
export interface Pick {
  repo: string;
  number: number;
  kind: 'issue' | 'pr';
  id: number;
  title: string;
}

export interface Plan {
  steps: BlockedStepPlan[];
  /** the prerequisites the registration comment lists ([] = no comment) */
  markRefs: Ref[];
}

/**
 * The steps, in order (approved plan of GitHub#434):
 *   pause      — add the "等人处理" label, only when a comment is written and it is not on
 *   relation   — one native "Blocked by" per issue picked (the item is an issue; GitHub takes issues only)
 *   comment    — the registration: the current one's prerequisites + the restored ones + the new ones that need it
 *   check      — read: the newest registration of the wait is ours, nothing else new
 *   addBlocked — the waiting label, when it is not on
 *   unpause    — take the "等人处理" label off, when it is on (or was added by `pause`)
 * `restore`: prerequisites of earlier registrations of this wait the newest one lost (ticked in the dialog).
 */
export function planBlocked(o: { itemIsPr: boolean; selfRepo: string; entry: EntryState; latest: readonly Ref[]; native: readonly Ref[]; picks: readonly Pick[]; restore: readonly Ref[] }): Plan {
  const native = new Set(o.native.map(refKey));
  const latest = o.latest;
  const viaComment = o.picks.filter((p) => o.itemIsPr || p.kind === 'pr').map((p) => ({ repo: p.repo.toLowerCase(), number: p.number }));
  const viaNative = o.itemIsPr ? [] : o.picks.filter((p) => p.kind === 'issue' && !native.has(itemKey(p.repo, p.number)));
  const needComment = viaComment.length > 0 || o.restore.length > 0;
  const markRefs = needComment ? dedupe([...latest, ...o.restore, ...viaComment]) : [];
  const hadHuman = o.entry.kind === 'human' || o.entry.kind === 'paused';
  const hadBlocked = o.entry.kind === 'waiting' || o.entry.kind === 'paused';
  const steps: BlockedStepPlan[] = [];
  if (needComment && !hadHuman) steps.push({ name: 'pause' });
  for (const p of viaNative) steps.push({ name: 'relation', target: itemKey(p.repo, p.number) });
  if (needComment) steps.push({ name: 'comment' }, { name: 'check' });
  if (!hadBlocked) steps.push({ name: 'addBlocked' });
  if (hadHuman || needComment) steps.push({ name: 'unpause' });
  return { steps, markRefs };
}

function dedupe(refs: readonly Ref[]): Ref[] {
  const m = new Map<string, Ref>();
  for (const r of refs) m.set(refKey(r), { repo: r.repo.toLowerCase(), number: r.number });
  return [...m.values()];
}

/**
 * Prerequisites of earlier registrations of this wait that the newest one does not have (and that are
 * not native relations either): what a registration overwritten by another one lost.
 */
export function lostRefs(read: BlockedRead): Ref[] {
  if (read.marks.length < 2) return [];
  const keep = new Set([...read.marks[read.marks.length - 1].refs.map(refKey), ...read.native.map(refKey)]);
  return dedupe(read.marks.slice(0, -1).flatMap((m) => m.refs)).filter((r) => !keep.has(refKey(r)));
}

// ---- the permit, before every write ----

/** What one step that is done changes in the facts (the waiting label going on starts a new wait: its id is not known in advance). */
export function applyDone(f: Facts, step: { name: BlockedStepName; target?: string }, ctx: { human: string; blocked: string; commentId?: number | null }): Facts {
  const h = ctx.human.toLowerCase();
  const b = ctx.blocked.toLowerCase();
  const withLabel = (x: string) => [...new Set([...f.flow, x])].sort();
  switch (step.name) {
    case 'pause':
    case 'repause':
      return { ...f, flow: withLabel(h) };
    case 'unpause':
      return { ...f, flow: f.flow.filter((x) => x !== h) };
    case 'addBlocked':
      return { ...f, flow: withLabel(b), round: f.round.last === 'labeled' && f.flow.includes(b) ? f.round : { ...f.round, last: 'labeled', id: '*' } };
    case 'relation':
      return { ...f, native: [...new Set([...f.native, step.target ?? ''])].sort() };
    case 'comment':
      return { ...f, marks: ctx.commentId != null ? [...f.marks, ctx.commentId] : f.marks };
    case 'check':
      return f;
  }
}

/**
 * The difference between what is expected and what was read, in words; null = none. A `*` wait id
 * (the operation put the waiting label on) matches any id other than the one the dialog saw.
 */
export function factsDiffer(expected: Facts, now: Facts, basisRoundId: number | null): string | null {
  if (now.state !== expected.state) return now.state === 'open' ? '这一条的状态变了' : '这一条已经关闭';
  const er = expected.round;
  const roundSame = er.id === '*' ? now.round.last === 'labeled' && now.round.id !== null && now.round.id !== basisRoundId && now.round.since === er.since : now.round.last === er.last && now.round.id === er.id && now.round.since === er.since;
  if (!roundSame) return '等前置标签这期间被摘掉或重新挂过（换了一轮等待）';
  if (JSON.stringify(now.flow) !== JSON.stringify(expected.flow)) {
    const added = now.flow.filter((x) => !expected.flow.includes(x));
    const gone = expected.flow.filter((x) => !now.flow.includes(x));
    return `流程标签变了（${[...added.map((x) => `多了「${x}」`), ...gone.map((x) => `少了「${x}」`)].join('、')}）`;
  }
  if (JSON.stringify(now.marks) !== JSON.stringify(expected.marks)) return '这期间有新的前置登记评论';
  if (JSON.stringify(now.native) !== JSON.stringify(expected.native)) return '这期间侧栏「Blocked by」变了';
  return null;
}

/**
 * GitHub#434 (plan v4, step 9): may the "等人处理" label be put back after a stop? Only when the one
 * thing that changed is other people's registrations (comments) or native relations — the item still
 * open, the same wait, no other flow label — and the label is missing. Anything else: no write.
 */
export function repauseAllowed(expected: Facts, now: Facts, basisRoundId: number | null, human: string): { ok: true } | { ok: false; why: string } {
  const h = human.toLowerCase();
  if (now.state !== 'open') return { ok: false, why: '这一条已经关闭' };
  const er = expected.round;
  const roundSame = er.id === '*' ? now.round.last === 'labeled' && now.round.id !== null && now.round.id !== basisRoundId && now.round.since === er.since : now.round.last === er.last && now.round.id === er.id && now.round.since === er.since;
  if (!roundSame) return { ok: false, why: '等前置标签这期间被摘掉或重新挂过' };
  const a = now.flow.filter((x) => x !== h);
  const b = expected.flow.filter((x) => x !== h);
  if (JSON.stringify(a) !== JSON.stringify(b)) return { ok: false, why: '这一条的流程标签变了，可能已被转去别的流程' };
  if (now.flow.includes(h)) return { ok: false, why: '「等人处理」标签仍在，不用补' };
  if (!expected.marks.every((x) => now.marks.includes(x)) || !expected.native.every((x) => now.native.includes(x))) return { ok: false, why: '登记或侧栏关系少了，不是单纯的交错登记' };
  if (now.marks.length === expected.marks.length && now.native.length === expected.native.length) return { ok: false, why: '没有看到别人的新登记' };
  return { ok: true };
}

/** The newest registration's prerequisites ([] = none in this wait). */
export function latestRefs(read: BlockedRead): Ref[] {
  return read.marks.length ? read.marks[read.marks.length - 1].refs : [];
}

/** GitHub#434: what the dialog says the confirm will do, one line per step. */
export function planLines(plan: Plan, selfRepo: string, names: { human: string; blocked: string }): string[] {
  const out: string[] = [];
  for (const s of plan.steps) {
    switch (s.name) {
      case 'pause':
        out.push(`加上「${names.human}」暂停等待（daemon 看到它就不按任何一份登记接着干）`);
        break;
      case 'relation':
        out.push(`在 GitHub 上把 ${s.target ? refText(parseKey(s.target), selfRepo) : ''} 设成本条的「Blocked by」（侧栏 Relationships 里看得到）`);
        break;
      case 'comment':
        out.push(`发一条登记评论，列出 ${plan.markRefs.map((r) => refText(r, selfRepo)).join('、')}（daemon 只认最新一条登记，已有的会一起写进去）`);
        break;
      case 'check':
        out.push('再读一遍：本轮最新登记就是这一条、期间没有别人的新登记');
        break;
      case 'addBlocked':
        out.push(`加上标签「${names.blocked}」`);
        break;
      case 'unpause':
        out.push(`去掉「${names.human}」，开始 / 恢复等前置`);
        break;
      default:
        break;
    }
  }
  return out;
}

function parseKey(key: string): Ref {
  const i = key.lastIndexOf('#');
  return { repo: key.slice(0, i), number: Number(key.slice(i + 1)) };
}
