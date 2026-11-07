// Changes shown before GitHub confirms them (GitHub#229). One record per field
// of one item: a label (present or not), the milestone, or one Project's status /
// iteration. Pure functions only — the controller stores the records, sends the
// requests and feeds every answer and every read in here; nothing else decides
// what a record shows or when it ends.
//
// The rules (approved design, issue #229 revision 7):
//   - a record keeps the value the user wants (target), the value before the
//     first click (base), and every request whose outcome is not settled;
//   - "the target is on GitHub" has one piece of evidence: the confirmation time C.
//     It is set by the target request's "accepted" answer (C = when it arrived),
//     or by a read sent after the target request went out that shows exactly the
//     target, when the target differs from base and from every other request's
//     value (C = when that read arrived). Changing the target clears C;
//   - with C set, only reads sent after C change anything: the target → checked
//     (watched while an older unanswered request with another value may still
//     land); an older unanswered request's value → "not saved, maybe changed
//     back"; anything else → somebody changed it after us: GitHub wins, the
//     record ends. Reads sent before C change nothing;
//   - reads that do not carry the field (not on that Project, the detail read)
//     never reach here; a failed read changes nothing.
//
import type { EditMark, Item, ProjectMeta } from '../shared/types';

// Times are the controller's stamps (milliseconds, strictly increasing), so
// "sent after" never ties.

export type EditValue = string | boolean | null;

/** What a record changes. `label` carries the colour the overlay shows it with. */
export type EditField =
  | { kind: 'label'; label: string; color: string }
  | { kind: 'milestone' }
  | { kind: 'status'; projectKey: string }
  | { kind: 'iteration'; projectKey: string };

export interface EditRequest {
  id: number;
  value: EditValue;
  /** stamp it went out; null while it waits behind another request of the same item */
  sentAt: number | null;
  answer: 'queued' | 'waiting' | 'accepted' | 'unknown';
}

export type EditFailure = { kind: 'rejected'; reason: string } | { kind: 'regressed'; value: EditValue };

/** A resend that was held back (Q1 = A): GitHub changed since the first click, or could not be read. */
export type EditHold = { kind: 'changed'; value: EditValue } | { kind: 'unreadable'; reason: string };

export interface EditRecord {
  /** fieldId(key, field) */
  id: string;
  key: string;
  repo: string;
  number: number;
  field: EditField;
  target: EditValue;
  base: EditValue;
  targetReq: number;
  reqs: EditRequest[];
  /** C: the earliest stamp the target is known to be on GitHub; null = no evidence yet */
  confirmedAt: number | null;
  /** a read sent after C showed the target */
  verified: boolean;
  /** watched until this stamp (older unanswered requests with another value) */
  observeUntil: number | null;
  failure: EditFailure | null;
  /** the latest value read from GitHub, for display only; `unreadable` = the latest read failed */
  github: { value: EditValue; at: number } | { unreadable: string; at: number } | null;
  hold: EditHold | null;
}

export type EditStatus = 'saving' | 'verifying' | 'observing' | 'unconfirmed' | 'failed';

/** How long an older unanswered request is watched for (from the latest one's send). */
export const OBSERVE_MS = 120_000;
/** The first re-read of a watched field, after it was checked. */
export const OBSERVE_FIRST_MS = 30_000;
/** At most this many records; a new change beyond it is refused. */
export const MAX_EDITS = 200;

export function fieldId(key: string, field: EditField): string {
  switch (field.kind) {
    case 'label':
      return `${key}|label|${field.label}`;
    case 'milestone':
      return `${key}|milestone`;
    default:
      return `${key}|${field.kind}|${field.projectKey}`;
  }
}

export function targetRequest(r: EditRecord): EditRequest | null {
  return r.reqs.find((q) => q.id === r.targetReq) ?? null;
}

export function editStatus(r: EditRecord): EditStatus {
  if (r.failure) return 'failed';
  if (r.confirmedAt === null) return targetRequest(r)?.answer === 'unknown' ? 'unconfirmed' : 'saving';
  return r.verified ? 'observing' : 'verifying';
}

/** The user wants `value` (a new record, or the next target of an existing one). */
export function startEdit(prev: EditRecord | null, init: Omit<EditRecord, 'target' | 'targetReq' | 'reqs' | 'confirmedAt' | 'verified' | 'observeUntil' | 'failure' | 'github' | 'hold'>, value: EditValue, reqId: number): EditRecord {
  const base = prev ? prev.base : init.base;
  // an older request already answered "accepted" has run: it cannot land later, it leaves the list
  const reqs = prev ? prev.reqs.filter((q) => q.answer !== 'accepted') : [];
  return {
    ...(prev ?? init),
    field: init.field,
    base,
    target: value,
    targetReq: reqId,
    reqs: [...reqs, { id: reqId, value, sentAt: null, answer: 'queued' }],
    confirmedAt: null,
    verified: false,
    observeUntil: null,
    failure: null,
    github: prev?.github ?? null,
    hold: null,
  };
}

export function markSent(r: EditRecord, reqId: number, at: number): EditRecord {
  if (!r.reqs.some((q) => q.id === reqId)) return r;
  return { ...r, reqs: r.reqs.map((q) => (q.id === reqId ? { ...q, sentAt: at, answer: 'waiting' } : q)) };
}

/**
 * GitHub answered one request. `rejected` = GitHub (or the app before sending)
 * refused: it did not change anything. `unknown` = no clear answer (network,
 * timeout, 5xx, unreadable answer): it may still land. An answer to a request
 * the record no longer holds (abandoned, ended) changes nothing.
 */
export function applyAnswer(r: EditRecord, reqId: number, outcome: 'accepted' | 'rejected' | 'unknown', at: number, reason = ''): EditRecord {
  const q = r.reqs.find((x) => x.id === reqId);
  if (!q) return r;
  const isTarget = reqId === r.targetReq;
  if (outcome === 'rejected') {
    const reqs = r.reqs.filter((x) => x.id !== reqId);
    return isTarget ? { ...r, reqs, failure: { kind: 'rejected', reason } } : { ...r, reqs };
  }
  if (outcome === 'unknown') return { ...r, reqs: r.reqs.map((x) => (x.id === reqId ? { ...x, answer: 'unknown' } : x)) };
  if (!isTarget) return { ...r, reqs: r.reqs.filter((x) => x.id !== reqId) };
  return {
    ...r,
    reqs: r.reqs.map((x) => (x.id === reqId ? { ...x, answer: 'accepted' } : x)),
    confirmedAt: r.confirmedAt ?? at,
  };
}

export interface FieldRead {
  /** stamp the read went out (a lower bound is fine: it only ever makes a read count less) */
  issuedAt: number;
  /** stamp its result landed in the board data */
  receivedAt: number;
  value: EditValue;
}

/** The result of a read: the record as it is now, or null when it ended (GitHub's value shows). */
export function applyRead(r: EditRecord, read: FieldRead, observeMs = OBSERVE_MS, final = false): EditRecord | null {
  const rec: EditRecord = { ...r, github: { value: read.value, at: read.receivedAt } };
  if (rec.failure?.kind === 'rejected') return rec;
  const t = targetRequest(rec);
  if (rec.confirmedAt === null) {
    // a positive read may stand for the lost answer — only when GitHub could not have held this value anyway
    const distinct = rec.target !== rec.base && rec.reqs.every((q) => q.id === rec.targetReq || q.value !== rec.target);
    if (read.value === rec.target && t && t.sentAt !== null && read.issuedAt > t.sentAt && distinct) {
      return checked({ ...rec, confirmedAt: read.receivedAt }, read, observeMs, final);
    }
    return rec;
  }
  // a read sent before C may have been served before the write: it is no evidence either way
  if (read.issuedAt <= rec.confirmedAt) return rec;
  if (read.value === rec.target) return checked(rec, read, observeMs, final);
  if (rec.reqs.some((q) => q.answer === 'unknown' && q.value !== rec.target && q.value === read.value)) {
    return { ...rec, failure: { kind: 'regressed', value: read.value } };
  }
  // somebody changed it after us: GitHub wins
  return null;
}

/**
 * The target was read back after C: done, unless an older unanswered request with
 * another value may still land — then it is watched until `observeUntil`. `final`:
 * this read was sent when the watch had run out (the controller's last re-read).
 */
function checked(r: EditRecord, read: FieldRead, observeMs: number, final: boolean): EditRecord | null {
  const older = r.reqs.filter((q) => q.answer === 'unknown' && q.value !== r.target);
  if (!older.length) return null;
  const until = r.observeUntil ?? Math.max(...older.map((q) => q.sentAt ?? 0)) + observeMs;
  if (final || read.receivedAt >= until) return null;
  return { ...r, verified: true, observeUntil: until, failure: r.failure?.kind === 'regressed' ? null : r.failure };
}

/** A read of this field failed: nothing changes but what the "GitHub now" line says. */
export function applyReadFailure(r: EditRecord, reason: string, at: number): EditRecord {
  return { ...r, github: { unreadable: reason, at } };
}

/** After a restart: every request still waiting has no answer any more, and none is sent again. */
export function afterRestart(r: EditRecord): EditRecord {
  return {
    ...r,
    reqs: r.reqs.flatMap((q): EditRequest[] => (q.answer === 'queued' ? [] : q.answer === 'waiting' ? [{ ...q, answer: 'unknown' }] : [q])),
    // a target that never went out is not on GitHub: say so
    failure: r.failure ?? (r.reqs.find((q) => q.id === r.targetReq)?.answer === 'queued' ? { kind: 'rejected', reason: 'App 在发出之前关闭了，这次修改没有发出' } : null),
  };
}

/** Stamps of every time in the records (a new stamp must be later than all of them). */
export function latestStamp(rs: EditRecord[]): number {
  let m = 0;
  for (const r of rs) {
    m = Math.max(m, r.confirmedAt ?? 0, r.github?.at ?? 0, ...r.reqs.map((q) => q.sentAt ?? 0));
  }
  return m;
}

/** Shape check for records read back from disk: anything malformed is dropped, never guessed. */
export function isEditRecord(v: unknown): v is EditRecord {
  const r = v as EditRecord;
  if (!r || typeof r !== 'object') return false;
  if (typeof r.id !== 'string' || typeof r.key !== 'string' || typeof r.repo !== 'string' || typeof r.number !== 'number') return false;
  if (!r.field || !['label', 'milestone', 'status', 'iteration'].includes(r.field.kind)) return false;
  if (!Array.isArray(r.reqs) || !r.reqs.every((q) => q && typeof q.id === 'number' && ['queued', 'waiting', 'accepted', 'unknown'].includes(q.answer))) return false;
  if (typeof r.targetReq !== 'number') return false;
  return fieldId(r.key, r.field) === r.id;
}

// ---- reading a field out of an item, and showing a record on it ----------

/**
 * The field's value as this copy of the item carries it; undefined = this copy
 * says nothing about it (a Project field of a Project the copy is not from).
 */
export function fieldValue(item: Item, field: EditField): EditValue | undefined {
  switch (field.kind) {
    case 'label':
      return item.labels.some((l) => l.name === field.label);
    case 'milestone':
      return item.milestone?.title ?? null;
    default: {
      const m = item.projects.find((x) => x.projectKey === field.projectKey);
      if (!m) return undefined;
      return field.kind === 'status' ? m.status : (m.iteration?.id ?? null);
    }
  }
}

function valueText(field: EditField, v: EditValue, projects: ProjectMeta[]): string {
  switch (field.kind) {
    case 'label':
      return v ? `有「${field.label}」` : `没有「${field.label}」`;
    case 'milestone':
      return typeof v === 'string' ? v : '（无里程碑）';
    case 'status':
      return typeof v === 'string' ? v : '（无状态）';
    case 'iteration': {
      if (typeof v !== 'string') return '（无迭代）';
      const p = projects.find((x) => x.key === field.projectKey);
      return p?.iterations.find((i) => i.id === v)?.title ?? v;
    }
  }
}

export function targetText(r: EditRecord, projects: ProjectMeta[]): string {
  if (r.field.kind === 'label') return r.target ? `加上「${r.field.label}」` : `去掉「${r.field.label}」`;
  return valueText(r.field, r.target, projects);
}

export function markOf(r: EditRecord, projects: ProjectMeta[]): EditMark {
  const status = editStatus(r);
  const g = r.github;
  return {
    id: r.id,
    field: r.field.kind,
    ...(r.field.kind === 'label' ? { label: r.field.label, color: r.field.color } : {}),
    ...(r.field.kind === 'status' || r.field.kind === 'iteration' ? { projectKey: r.field.projectKey } : {}),
    status,
    targetText: targetText(r, projects),
    github: !g ? null : 'unreadable' in g ? { unreadable: g.unreadable, at: g.at } : { text: valueText(r.field, g.value, projects), at: g.at },
    changedByOthers: Boolean(g && !('unreadable' in g) && g.value !== r.base && g.value !== r.target),
    failure: !r.failure
      ? null
      : r.failure.kind === 'rejected'
        ? r.failure.reason
        : `读到的值（${valueText(r.field, r.failure.value, projects)}）和你之前一次没确认的修改相同，可能被它改回去了`,
    hold: !r.hold
      ? null
      : r.hold.kind === 'changed'
        ? { kind: 'changed', text: `你改之后有人改成了「${valueText(r.field, r.hold.value, projects)}」，没有重新发送；确认要用你的值覆盖就点「仍然覆盖」` }
        : { kind: 'unreadable', text: `读不到 GitHub 现在的值（${r.hold.reason}），没法确认有没有人改过` },
  };
}

/**
 * The item as the views show it: values of changes on their way (saving /
 * verifying / observing) applied, every record attached as a mark. Unconfirmed
 * and failed records leave GitHub's value in place: the view shows theirs beside it.
 */
export function overlayItem(item: Item, records: EditRecord[], projects: ProjectMeta[]): Item {
  if (!records.length) return item;
  let out: Item = { ...item, edits: records.map((r) => markOf(r, projects)) };
  for (const r of records) {
    const st = editStatus(r);
    if (st === 'failed' || st === 'unconfirmed') continue;
    const f = r.field;
    if (f.kind === 'label') {
      const has = out.labels.some((l) => l.name === f.label);
      if (r.target && !has) out = { ...out, labels: [...out.labels, { name: f.label, color: f.color }] };
      if (!r.target && has) out = { ...out, labels: out.labels.filter((l) => l.name !== f.label) };
    } else if (f.kind === 'milestone') {
      out = { ...out, milestone: typeof r.target === 'string' ? { title: r.target, dueOn: out.milestone?.title === r.target ? out.milestone.dueOn : null } : null };
    } else {
      const meta = projects.find((p) => p.key === f.projectKey);
      out = {
        ...out,
        projects: out.projects.map((m) => {
          if (m.projectKey !== f.projectKey) return m;
          if (f.kind === 'status') return { ...m, status: typeof r.target === 'string' ? r.target : null };
          const it = typeof r.target === 'string' ? (meta?.iterations.find((i) => i.id === r.target) ?? null) : null;
          return { ...m, iteration: it };
        }),
      };
    }
  }
  return out;
}
