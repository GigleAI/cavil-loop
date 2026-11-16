// GitHub#569: renaming one of the daemon's flow labels from the project settings window — on GitHub,
// in the project's config and in the client, together. The work on GitHub and in the config is the
// daemon's own scripts/label-rename.sh (run by the back end, crates/core/src/daemon_rename.rs); the
// controller runs it, then saves the client's own names for that repository (shared/repoLabels.ts)
// and lets the daemon go on. This file has the shapes, the rename credential handed to another
// machine, and the one rule of which buttons a rename's notice offers.

import { t } from './i18n';

/** what the script says about one place: still the old name, already the new one, or not known */
export type Place = 'old' | 'new' | 'unknown';

export interface RenameCheck {
  id: string;
  ok: boolean | null;
  text: string;
}

/** The back end's answer for one run of label-rename.sh. */
export interface RenameAnswer {
  /** ok / awaiting_client / done / no_answer / partial / refused / busy / unknown — or `unconfirmed` (no RESULT line) */
  result: string;
  /** false: the back end refused before running anything */
  ran?: boolean;
  github?: Place;
  config?: Place;
  step?: string;
  paused?: boolean | null;
  watch?: boolean | null;
  labelId?: string;
  checks?: RenameCheck[];
  record?: unknown;
  message?: string;
  output?: string;
  outputSaid?: unknown;
  code?: number | null;
}

export type RenameCmd = 'check' | 'rename' | 'follow' | 'continue' | 'resend' | 'finish' | 'undo' | 'abandon' | 'watch-end' | 'status';

export interface RenameArgs {
  field?: string;
  from?: string;
  to?: string;
  rev?: string;
  labelId?: string;
  follow?: boolean;
  othersStopped?: boolean;
}

/** A pending record as project-config.sh `get` reports it (`label_rename.pending`). */
export interface PendingRecord {
  mode: 'rename' | 'follow';
  field: string;
  from: string;
  to: string;
  label_id: number | string;
  step: 'github' | 'config' | 'client';
  sent?: boolean;
  unanswered?: boolean;
  started?: number;
  host?: string;
}

export interface WatchRecord {
  field: string;
  label_id: number | string;
  name: string;
  since?: number;
}

/** `label_rename` of project-config.sh `get` */
export interface RenameState {
  state: 'ok' | 'unknown';
  pending?: PendingRecord | 'unreadable' | null;
  watch?: WatchRecord | 'unreadable' | null;
}

/** A label name the daemon can write on its config line and GitHub takes (scripts/_label_rename.sh label_rename_name_ok). */
export const NAME_RE = /^[A-Za-z0-9._:/@+-]{1,50}$/;

export function pendingOf(s: RenameState | undefined): PendingRecord | 'unreadable' | null {
  if (!s || s.state !== 'ok') return null;
  const p = s.pending;
  if (p === 'unreadable') return p;
  if (!p || typeof p !== 'object' || typeof p.field !== 'string' || typeof p.from !== 'string' || typeof p.to !== 'string') return p ? 'unreadable' : null;
  return p;
}

// ── the rename credential: what the other machine's client needs to follow ──

const CRED_HEAD = 'cavil-label-rename v1';

export interface Credential {
  repo: string;
  field: string;
  from: string;
  to: string;
  labelId: string;
}

export function credentialText(c: Credential): string {
  return `${CRED_HEAD} ${c.repo} ${c.field} ${c.from} ${c.to} ${c.labelId}`;
}

/** The pasted text as a credential, or null when it is not one (extra blanks around it are fine). */
export function parseCredential(text: string): Credential | null {
  const w = text.trim().split(/\s+/);
  if (w.length !== 7 || `${w[0]} ${w[1]}` !== CRED_HEAD) return null;
  const [, , repo, field, from, to, labelId] = w;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || !/^LABEL_[A-Z_]+$/.test(field) || !NAME_RE.test(from) || !NAME_RE.test(to) || !/^\d{1,20}$/.test(labelId) || from === to) return null;
  return { repo, field, from, to, labelId };
}

// ── one rename, as the controller holds it ──

export type RenameStatus =
  /** the controller is running something for it */
  | 'running'
  /** all three places have the new name; the daemon goes on */
  | 'done'
  /** refused before anything changed */
  | 'refused'
  /** GitHub did not answer the rename: renamed or not is not known */
  | 'no_answer'
  /** GitHub renamed, the config was not saved */
  | 'partial'
  /** GitHub and the config are renamed; the client's names could not be saved (or read back) */
  | 'client'
  /** the script could not tell (read failed, record unreadable, label in a third state) */
  | 'unknown'
  /** found waiting at start / on a refresh of the daemon list */
  | 'pending'
  /** given up by the person: the record removed, nothing else changed */
  | 'abandoned'
  /** undone: nothing was changed anywhere */
  | 'undone';

/** A machine stopped for the rename (it has to follow afterwards). */
export interface StoppedMachine {
  /** 'local': another project of this computer; 'remote': a paired machine */
  where: 'local' | 'remote';
  name: string;
  key: string;
  /** remote only */
  id?: string;
}

export interface RenameJob {
  id: number;
  /** the daemon's project key on this computer */
  key: string;
  repo: string;
  mode: 'rename' | 'follow';
  field: string;
  from: string;
  to: string;
  labelId: string;
  status: RenameStatus;
  /** what is running now ('rename', 'continue', 'resend', 'save', 'finish', …) */
  doing?: string;
  github: Place;
  config: Place;
  /** the client's own names for the repository */
  client: Place | 'none';
  /** the daemon's polling of this project: paused while a record exists */
  polling: 'paused' | 'running' | 'unknown';
  /** the daemon still checks the label every round after an unanswered request */
  watch?: boolean;
  /** the script's / back end's words */
  message?: string;
  messageSaid?: unknown;
  /** the client's slot kept its other name (said in the notice) */
  slotKept?: { slot: string; name: string };
  stopped?: StoppedMachine[];
  /** a `refused` whose GitHub is surely unchanged, from a pending record that could be undone */
  undoable?: boolean;
  startedAt: number;
  dismissed?: boolean;
  /** the status before the step running now (a step the back end refused puts it back) */
  prevStatus?: RenameStatus;
  /** the last step the person asked for did not go out, and why (said under the notice) */
  problem?: string;
}

/** settled for good: nothing holds the daemon or the item buttons any more */
export function renameSettled(j: Pick<RenameJob, 'status' | 'polling'>): boolean {
  return j.status === 'done' || j.status === 'abandoned' || j.status === 'undone' || (j.status === 'refused' && j.polling !== 'paused');
}

/** GitHub#569: the rename that keeps the flow-label buttons of an item of `repo` off now (null: none) */
export function renameLockOf(jobs: readonly RenameJob[] | undefined, repo: string): RenameJob | null {
  const r = repo.toLowerCase();
  return (jobs ?? []).find((j) => j.repo.toLowerCase() === r && !renameSettled(j)) ?? null;
}

export function renameLockText(j: RenameJob): string {
  return t('{repo} 的流程标签正在改名（{from} → {to}），改完之前这里不改流程标签', { repo: j.repo, from: j.from, to: j.to });
}

/** Can GitHub be left as it is and the record dropped (`undo`)? Only when the request surely never went out. */
export function undoableOf(rec: unknown, config: Place | undefined): boolean {
  if (!rec || typeof rec !== 'object') return false;
  const r = rec as Partial<PendingRecord>;
  if (r.mode === 'follow') return config !== 'new';
  return r.step === 'github' && r.sent !== true && r.unanswered !== true;
}

/** A project whose daemon checks the renamed label every round (after a request that got no answer). */
export interface RenameWatch {
  key: string;
  repo: string;
  field: string;
  name: string;
  labelId: string;
  /** what 「结束核对」 answered when it did not end it */
  problem?: string;
  working?: boolean;
}

export type RenameRetry = 'continue' | 'resend' | 'recheck' | null;
export type RenameOut = 'undo' | 'abandon' | null;

export interface RenameActions {
  /** 「重试」 = continue (partial / client / pending) or 「再查一次（只读）」 = continue (no_answer / unknown) */
  retry: RenameRetry;
  /** 「重发改名」: only after no answer */
  resend: boolean;
  /** the one way out */
  out: RenameOut;
  /** × */
  close: boolean;
}

/**
 * GitHub#569: which buttons a rename's notice offers — at most a retry, one way out and ×, following how
 * sure the outcome is. No answer never offers 「退回」 (the request may still land); × only once settled.
 */
export function renameActions(j: RenameJob): RenameActions {
  const none: RenameActions = { retry: null, resend: false, out: null, close: false };
  switch (j.status) {
    case 'running':
      return none;
    case 'done':
    case 'abandoned':
    case 'undone':
      return { ...none, close: true };
    case 'refused':
      // refused before anything changed: nothing to undo; × only when no record holds the daemon
      return { ...none, close: j.polling !== 'paused', out: j.polling === 'paused' ? 'abandon' : null, retry: j.polling === 'paused' ? 'recheck' : null };
    case 'no_answer':
      return { retry: 'recheck', resend: true, out: null, close: false };
    case 'partial':
      return { retry: 'continue', resend: false, out: j.github === 'old' && j.undoable ? 'undo' : null, close: false };
    case 'client':
    case 'pending':
      return { retry: 'continue', resend: false, out: j.github === 'old' && j.undoable ? 'undo' : 'abandon', close: false };
    case 'unknown':
      return { retry: 'recheck', resend: false, out: 'abandon', close: false };
  }
}

/** The settled words for a status (the notice adds the names and the repository). */
export function renameStatusWord(s: RenameStatus): string {
  switch (s) {
    case 'running':
      return t('进行中');
    case 'done':
      return t('已改名');
    case 'refused':
      return t('没有改名');
    case 'no_answer':
      return t('GitHub 没有回音，不知道改没改');
    case 'partial':
      return t('GitHub 已改名，配置还没改');
    case 'client':
      return t('GitHub 和配置已改名，客户端的标签名还没存好');
    case 'unknown':
      return t('读不到现在的状态');
    case 'pending':
      return t('有一次改名还没做完');
    case 'abandoned':
      return t('已放下改名记录');
    case 'undone':
      return t('已退回，什么都没改');
  }
}

/** The place words of the status table. */
export function placeWord(p: Place | 'none' | 'paused' | 'running'): string {
  switch (p) {
    case 'old':
      return t('还是旧名字');
    case 'new':
      return t('已是新名字');
    case 'none':
      return t('客户端没有这个标签名');
    case 'paused':
      return t('暂停中');
    case 'running':
      return t('在跑');
    default:
      return t('不知道');
  }
}

// ── the rename dialog: other daemons that poll the same repository ──

export interface Poller {
  where: 'local' | 'remote';
  /** the project key ('' when the machine could not be read at all) */
  key: string;
  /** the machine's name (remote), or '' for this computer */
  name: string;
  id?: string;
  state: 'running' | 'stopped' | 'unknown';
  /** the machine could not be read: its projects are not known, so it counts as not stopped */
  unreadable?: boolean;
}

interface StatusLike {
  projects: { key: string; repo: string | null; scheduler: { state: 'running' | 'stopped' | 'unknown' } | null }[];
}

const sameRepo = (a: string | null, b: string) => (a ?? '').toLowerCase() === b.toLowerCase();

/**
 * GitHub#569: every other daemon this client knows of that polls `repo` — the other projects of this computer,
 * and each paired machine's projects of that repository. A machine whose state cannot be read is listed
 * as not stopped (it may well poll the repository).
 */
export function otherPollers(local: StatusLike | null, thisKey: string, repo: string, remotes: { id: string; name: string; status: StatusLike | null }[]): Poller[] {
  const out: Poller[] = [];
  for (const p of local?.projects ?? []) if (p.key !== thisKey && sameRepo(p.repo, repo)) out.push({ where: 'local', key: p.key, name: '', state: p.scheduler?.state ?? 'unknown' });
  for (const m of remotes) {
    if (!m.status) {
      out.push({ where: 'remote', key: '', name: m.name, id: m.id, state: 'unknown', unreadable: true });
      continue;
    }
    for (const p of m.status.projects) if (sameRepo(p.repo, repo)) out.push({ where: 'remote', key: p.key, name: m.name, id: m.id, state: p.scheduler?.state ?? 'unknown' });
  }
  return out;
}

/**
 * What still keeps 「改名（三处一起改）」 off, one line each (empty: it may be pressed).
 * `remotes`: the paired machines' list — still being read and could not be read both keep the button off;
 * only a list that was read (empty or not) lets it through (PR #571 review round 2: a failed read had been an empty list).
 */
export function renameMissing(o: { checks: RenameCheck[] | null; checking: boolean; pollers: Poller[]; ticked: boolean; remotes: 'loading' | 'failed' | 'read' }): string[] {
  const out: string[] = [];
  if (o.remotes === 'loading') out.push(t('还在读取配对过的远程机器'));
  else if (o.remotes === 'failed') out.push(t('读不到配对过的远程机器列表（算作没停）'));
  if (o.checking || o.checks === null) out.push(t('检查还没做完'));
  else {
    const bad = o.checks.filter((c) => c.ok !== true && c.id !== 'others_stopped').length;
    if (bad) out.push(t('有 {n} 项检查没过', { n: bad }));
  }
  const running = o.pollers.filter((p) => p.state !== 'stopped').length;
  if (running) out.push(t('还有 {n} 个别处的轮询没停（或读不到）', { n: running }));
  if (!o.ticked) out.push(t('还没勾选「已确认」'));
  return out;
}
