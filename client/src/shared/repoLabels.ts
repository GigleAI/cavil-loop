// GitHub#569: flow label names that differ for one repository. The settings' "交给 agent" names
// (`handBack`) and the other flow labels of "等前置…" (`blockedLabels.flow`) are one shared setting;
// a rename done from the project settings window changes the name for that repository only, kept
// here as an override. Everything that uses those names asks `handBackFor` / `blockedLabelsFor` with
// the item's own repository — the one lookup — so a repository without an override behaves exactly
// as before.

import { flowPatterns, type BlockedLabels } from './blocked';
import type { HandBackLabels } from './types';

/** the six names of `handBack` */
export type HandBackSlot = keyof HandBackLabels;
export const HAND_BACK_SLOTS: readonly HandBackSlot[] = ['human', 'agent', 'autopilot', 'running', 'blocked', 'later'];

/** One repository's own names; a slot that is absent follows the shared setting. */
export interface RepoLabelOverride {
  hand?: Partial<HandBackLabels>;
  /** the other flow labels of "等前置…" for this repository (the whole list); absent = the shared one */
  flow?: string;
}

/** by repository, lower-cased `owner/name` */
export type RepoLabels = Record<string, RepoLabelOverride>;

export const REPO_LABELS_SETTING = 'repoLabels';

const repoKey = (repo: string) => repo.trim().toLowerCase();
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** What the settings hold, made usable: anything that is not a whole valid entry is left out. */
export function normalizeRepoLabels(raw: unknown): RepoLabels {
  const out: RepoLabels = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [repo, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!REPO_RE.test(repo) || !v || typeof v !== 'object') continue;
    const e: RepoLabelOverride = {};
    const hand = (v as { hand?: unknown }).hand;
    if (hand && typeof hand === 'object') {
      const h: Partial<HandBackLabels> = {};
      for (const s of HAND_BACK_SLOTS) {
        const x = (hand as Record<string, unknown>)[s];
        if (typeof x === 'string') h[s] = x.trim();
      }
      if (Object.keys(h).length) e.hand = h;
    }
    const flow = (v as { flow?: unknown }).flow;
    if (typeof flow === 'string' && flow.trim()) e.flow = flow.trim();
    if (e.hand || e.flow !== undefined) out[repoKey(repo)] = e;
  }
  return out;
}

interface Shared {
  handBack: HandBackLabels;
  repoLabels?: RepoLabels;
}

/** The "交给 agent" names for an item of `repo`: the repository's own where it has one, the shared ones elsewhere. */
export function handBackFor(s: Shared, repo: string | null | undefined): HandBackLabels {
  const o = repo ? s.repoLabels?.[repoKey(repo)]?.hand : undefined;
  return o ? { ...s.handBack, ...o } : s.handBack;
}

/** The labels of "等前置…" for an item of `repo` (its waiting label is `handBackFor(…).blocked`). */
export function blockedLabelsFor(s: Shared & { blockedLabels: BlockedLabels }, repo: string | null | undefined): BlockedLabels {
  const o = repo ? s.repoLabels?.[repoKey(repo)] : undefined;
  if (!o) return s.blockedLabels;
  return { blocked: handBackFor(s, repo).blocked, flow: o.flow ?? s.blockedLabels.flow };
}

/** One name for every repository of `repos`, or every distinct one (the shared name first). */
export function namesAcross(s: Shared, repos: Iterable<string>, slot: HandBackSlot): string[] {
  const out = [s.handBack[slot]];
  for (const r of repos) {
    const n = handBackFor(s, r)[slot];
    if (!out.some((x) => x.toLowerCase() === n.toLowerCase())) out.push(n);
  }
  return out;
}

/** The repositories with their own names, as Settings lists them: one row per name. */
export function overrideRows(s: Shared & { blockedLabels: BlockedLabels }): { repo: string; slot: HandBackSlot | 'flow'; name: string; shared: string }[] {
  const rows: { repo: string; slot: HandBackSlot | 'flow'; name: string; shared: string }[] = [];
  for (const repo of Object.keys(s.repoLabels ?? {}).sort()) {
    const o = s.repoLabels![repo];
    for (const slot of HAND_BACK_SLOTS) {
      const v = o.hand?.[slot];
      if (v !== undefined) rows.push({ repo, slot, name: v, shared: s.handBack[slot] });
    }
    if (o.flow !== undefined) rows.push({ repo, slot: 'flow', name: o.flow, shared: s.blockedLabels.flow });
  }
  return rows;
}

/** Drop one name of a repository ("改回共用"); the entry goes when nothing is left. */
export function dropOverride(all: RepoLabels, repo: string, slot: HandBackSlot | 'flow'): RepoLabels {
  const k = repoKey(repo);
  const o = all[k];
  if (!o) return all;
  const next: RepoLabelOverride = { ...o, ...(o.hand ? { hand: { ...o.hand } } : {}) };
  if (slot === 'flow') delete next.flow;
  else if (next.hand) {
    delete next.hand[slot];
    if (!Object.keys(next.hand).length) delete next.hand;
  }
  const out = { ...all };
  if (next.hand || next.flow !== undefined) out[k] = next;
  else delete out[k];
  return out;
}

// ── what a rename changes in the client ──

/** The daemon's setting → the client's name for it (null: the client has no name of its own for it). */
export const FIELD_SLOT: Readonly<Record<string, HandBackSlot | null>> = {
  LABEL_PENDING_HUMAN: 'human',
  LABEL_PENDING_AGENT: 'agent',
  LABEL_AUTOPILOT: 'autopilot',
  LABEL_AGENT_DOING: 'running',
  LABEL_PENDING_BLOCKED: 'blocked',
  LABEL_PENDING_LATER: 'later',
  LABEL_PENDING_AGENT_FABLE: null,
  LABEL_PENDING_PR: null,
  LABEL_DONE: null,
  LABEL_PENDING_REVIEW: null,
  LABEL_PENDING_MERGE: null,
  LABEL_PENDING_REQUESTER_BOT: null,
};

function covers(pattern: string, name: string): boolean {
  const l = name.toLowerCase();
  return pattern.endsWith('*') ? l.startsWith(pattern.slice(0, -1)) : l === pattern;
}

/**
 * The flow list after renaming `from` to `to`: an element that is exactly `from` (any case) becomes `to`;
 * when no element is, but a wildcard (`pending/*`) covered `from` and none covers `to`, `to` is added at the
 * end. Otherwise the list is as it was. Returns null when nothing changes.
 */
export function renamedFlow(flow: string, from: string, to: string): string | null {
  const parts = flow
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  const pats = flowPatterns(flow);
  const i = parts.findIndex((p) => p.toLowerCase() === from.toLowerCase());
  if (i >= 0) {
    const next = [...parts];
    next[i] = to;
    return next.join(', ');
  }
  if (pats.some((p) => covers(p, from)) && !pats.some((p) => covers(p, to))) return [...parts, to].join(', ');
  return null;
}

export interface ClientRename {
  /** the overrides after the rename (only the renamed repository changed) */
  repoLabels: RepoLabels;
  /** the client's own name for this setting and what happened to it */
  slot: HandBackSlot | null;
  /** 'renamed': the repository's name for it is now `to`; 'kept': its name was not `from`, left as it is; 'none': no such name */
  slotOutcome: 'renamed' | 'kept' | 'none';
  /** the name the slot had for that repository when it was kept */
  slotWas?: string;
  flowChanged: boolean;
}

/**
 * GitHub#569: the client's side of a rename of `field` from `from` to `to`, for `repo` only. The slot is
 * changed only when its name for that repository is `from` (any case); the flow list follows
 * `renamedFlow`. An override equal to the shared value is not kept.
 */
export function applyClientRename(s: Shared & { blockedLabels: BlockedLabels }, repo: string, field: string, from: string, to: string): ClientRename {
  const k = repoKey(repo);
  const all = { ...(s.repoLabels ?? {}) };
  const cur: RepoLabelOverride = { ...(all[k] ?? {}), ...(all[k]?.hand ? { hand: { ...all[k]!.hand } } : {}) };
  const slot = FIELD_SLOT[field] ?? null;
  let slotOutcome: ClientRename['slotOutcome'] = 'none';
  let slotWas: string | undefined;
  if (slot) {
    const now = handBackFor(s, repo)[slot];
    // already the new name (a retry after the save went through): nothing to change
    if (now === to) slotOutcome = 'renamed';
    else if (now.trim().toLowerCase() === from.toLowerCase()) {
      slotOutcome = 'renamed';
      const hand = { ...(cur.hand ?? {}) };
      if (s.handBack[slot] === to) delete hand[slot];
      else hand[slot] = to;
      if (Object.keys(hand).length) cur.hand = hand;
      else delete cur.hand;
    } else {
      slotOutcome = 'kept';
      slotWas = now;
    }
  }
  const flowNow = blockedLabelsFor(s, repo).flow;
  const flow = renamedFlow(flowNow, from, to);
  if (flow !== null) {
    if (flow === s.blockedLabels.flow) delete cur.flow;
    else cur.flow = flow;
  }
  if (cur.hand || cur.flow !== undefined) all[k] = cur;
  else delete all[k];
  return { repoLabels: all, slot, slotOutcome, ...(slotWas !== undefined ? { slotWas } : {}), flowChanged: flow !== null };
}
