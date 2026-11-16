// GitHub#559: a repository without the labels a button needs (交给 agent / 托管 in the new-issue dialog,
// 等前置) — the client creates them, or, when it cannot, says which ones to create and where.
// One set of rules, used by the dialogs (what the box shows), the controller (what it sends, what a
// result means) and the notice area: pure, no Node, no GitHub.

import { t, tKey, zhKey } from './i18n';
import type { HandBackLabels } from './types';

/** The part a label plays in the flow; its default colour and description come from it, its name from Settings. */
export type LabelRole = 'agent' | 'autopilot' | 'blocked' | 'human';

/**
 * The colour and description the daemon's install script (setup.sh, step 5) gives each label — the
 * same table, so a label made here looks like one the install made. tests/label-defaults.test.sh
 * checks the two copies stay equal.
 */
export const LABEL_DEFAULTS: Record<LabelRole, { color: string; description: string }> = {
  agent: { color: 'd4c5f9', description: zhKey('等待 agent 处理') },
  autopilot: { color: 'ff401e', description: zhKey('托管：从方案到合并全交给 agent（复审与测试通过后自动合并）') },
  blocked: { color: '2dcdd0', description: zhKey('等本仓库别的 issue / PR 完成，完成后 daemon 自动接着干') },
  human: { color: 'fbca04', description: zhKey('等待人类处理') },
};

/** A label to create: its name (as set in Settings), and what goes with it. */
export interface LabelSpec {
  name: string;
  role: LabelRole;
  color: string;
  description: string;
}

/** The labels to create for these names: each name once (GitHub label names ignore case), in the order given. */
export function labelSpecs(wants: { name: string; role: LabelRole }[]): LabelSpec[] {
  const seen = new Set<string>();
  const out: LabelSpec[] = [];
  for (const w of wants) {
    const name = w.name.trim();
    const k = name.toLowerCase();
    if (!name || seen.has(k) || !Object.hasOwn(LABEL_DEFAULTS, w.role)) continue;
    seen.add(k);
    // the description in the window's language (the install script writes the Chinese one)
    out.push({ name, role: w.role, color: LABEL_DEFAULTS[w.role].color, description: tKey(LABEL_DEFAULTS[w.role].description) });
  }
  return out;
}

/** The part a flow label plays, by its name in Settings (any case); null = not one of the four. */
export function roleOf(name: string, hb: HandBackLabels): LabelRole | null {
  const k = name.trim().toLowerCase();
  if (!k) return null;
  if (k === hb.autopilot.trim().toLowerCase()) return 'autopilot';
  if (k === hb.agent.trim().toLowerCase()) return 'agent';
  if (k === hb.blocked.trim().toLowerCase()) return 'blocked';
  if (k === hb.human.trim().toLowerCase()) return 'human';
  return null;
}

/**
 * May the signed-in account create labels in the repository, as the repository says (GitHub's
 * `permissions`: push, maintain or admin)? 'unknown' = not read, or read without that field — the
 * create button is offered then (a refused create changes nothing), never the guide alone.
 */
export type LabelPermission = 'yes' | 'no' | 'unknown';

export function permissionOf(repoInfo: unknown): LabelPermission {
  const p = (repoInfo as { permissions?: Record<string, unknown> } | null)?.permissions;
  if (!p || typeof p !== 'object') return 'unknown';
  const flags = ['admin', 'maintain', 'push'].map((k) => p[k]);
  if (flags.some((v) => v === true)) return 'yes';
  // every one of them said, and none of them true: a plain "no"
  if (typeof p.admin === 'boolean' && typeof p.push === 'boolean' && (p.maintain === undefined || typeof p.maintain === 'boolean')) return 'no';
  return 'unknown';
}

/**
 * One press of "建标签", held by the controller for the repository it was pressed for — every request,
 * the read after it and the notice use `repo`, never what a dialog shows now.
 *   running — being sent
 *   done    — every label is in the repository (made now, or found there)
 *   refused — GitHub refused (for sure): nothing more was made than what `made` lists
 *   unknown — no answer for at least one: it may or may not be there
 *   missing — 「再查一次」 read the repository: these are still not there (press 建标签 again)
 */
export type LabelJobStatus = 'running' | 'done' | 'refused' | 'unknown' | 'missing';

export interface LabelJob {
  id: number;
  repo: string;
  labels: LabelSpec[];
  status: LabelJobStatus;
  /** why it did not finish (refused / unknown), as the client words it */
  error: string | null;
  /** refused while signed in through the GitHub App: the App may not be allowed to write here */
  app?: boolean;
  /** a 「再查一次」 is being read */
  checking?: boolean;
  startedAt: number;
  dismissed?: boolean;
}

/** The answer to each label's create request: made, refused for sure (with GitHub's words), or no answer. */
export type LabelAttempt =
  | { name: string; outcome: 'made' }
  /** GitHub answered 422 with `already_exists`: one of that name is in the repository (made by someone else meanwhile) */
  | { name: string; outcome: 'exists' }
  | { name: string; outcome: 'refused'; error: string }
  | { name: string; outcome: 'noAnswer'; error: string };

/** GitHub#559: the validation code GitHub gives a label create whose name is already taken */
export const LABEL_EXISTS_CODE = 'already_exists';

/**
 * What one press came to, from each request's answer and the repository's labels read afterwards
 * (null = that read failed). A label is there when it was made, GitHub said it already exists, or the
 * read lists it (any case). Every one there → done; else any without an answer → unknown (it may
 * still land); else → refused (GitHub said no to a label that is not there).
 */
export function labelJobOutcome(attempts: LabelAttempt[], after: string[] | null): { status: 'done' | 'refused' | 'unknown'; error: string | null } {
  const have = new Set((after ?? []).map((n) => n.toLowerCase()));
  const there = (a: LabelAttempt) => a.outcome === 'made' || a.outcome === 'exists' || have.has(a.name.toLowerCase());
  if (attempts.every(there)) return { status: 'done', error: null };
  const left = attempts.filter((a) => !there(a));
  const lost = left.find((a) => a.outcome === 'noAnswer');
  if (lost && lost.outcome === 'noAnswer') return { status: 'unknown', error: lost.error };
  const refused = left.find((a) => a.outcome === 'refused');
  return { status: 'refused', error: refused && refused.outcome === 'refused' ? refused.error : null };
}

/** The job a dialog showing `repo` goes by: the newest for that repository (any case), or null. */
export function jobFor(jobs: readonly LabelJob[], repo: string): LabelJob | null {
  const k = repo.toLowerCase();
  let best: LabelJob | null = null;
  for (const j of jobs) if (j.repo.toLowerCase() === k && (!best || j.id > best.id)) best = j;
  return best;
}

/**
 * What a dialog's box shows for the labels `missing` in the repository it shows now:
 *   create — the button (the account may, or it is not known)
 *   running — a press for this repository is being sent
 *   unknown — the last press got no answer: 「再查一次」 only
 *   guide  — what to create by hand, and where (the account may not, or GitHub refused)
 */
export type LabelBoxState =
  | { kind: 'create' }
  | { kind: 'running' }
  /** the last press got no answer: only 「再查一次」 (reads), never a new press before it found them still missing */
  | { kind: 'unknown'; jobId: number; checking: boolean; error: string | null }
  | { kind: 'guide'; why: 'noPermission' | 'refused'; error: string | null; app: boolean };

export function labelBoxState(permission: LabelPermission, job: LabelJob | null): LabelBoxState {
  if (job?.status === 'running') return { kind: 'running' };
  if (job?.status === 'unknown') return { kind: 'unknown', jobId: job.id, checking: job.checking === true, error: job.error };
  if (job?.status === 'refused') return { kind: 'guide', why: 'refused', error: job.error, app: job.app === true };
  if (permission === 'no') return { kind: 'guide', why: 'noPermission', error: null, app: false };
  return { kind: 'create' };
}

/** The labels page of a repository on the GitHub web site `web` (e.g. https://github.com). */
export function labelsPageUrl(web: string, repo: string): string {
  return `${web.replace(/\/+$/, '')}/${repo}/labels`;
}

/** The list the guide's 「复制标签清单」 copies: one label a line, name, colour and description. */
export function labelListText(specs: LabelSpec[]): string {
  return specs.map((s) => `${s.name}\t#${s.color}\t${s.description}`).join('\n');
}

/** The labels as the notice names them: 「a」「b」. */
export function labelNames(specs: { name: string }[]): string {
  return specs.map((s) => t('「{name}」', { name: s.name })).join('');
}

/**
 * May a new press for `repo` go out now? Not while one is being sent, and not while the last one got no
 * answer and 「再查一次」 has not yet found the labels still missing (it may land: a second press would race it).
 */
export function pressBlocked(jobs: readonly LabelJob[], repo: string): 'running' | 'unknown' | null {
  const j = jobFor(jobs, repo);
  if (j?.status === 'running') return 'running';
  if (j?.status === 'unknown') return 'unknown';
  return null;
}
