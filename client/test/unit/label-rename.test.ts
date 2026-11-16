// GitHub#569: renaming a flow label from the project settings window. Three things here:
//   1. the pure rules — the rename credential, which buttons a notice offers, what the client's own
//      names become (one slot, the flow list), the other daemons the dialog lists;
//   2. the one lookup every user of the label names goes through (handBackFor / blockedLabelsFor), with
//      and without a repository's own names: the view-bar numbers, reminders, the graph, the loop reads;
//   3. the controller: label-rename.sh's answers (a stand-in) in, the client's names saved on the real
//      back end and read back before `finish`, a save that fails keeping the rename pending.
// The back end's reading of the script's output is crates/core/src/daemon_rename.rs (cargo test); the
// whole flow against the real script is test/e2e/label-rename.spec.ts.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { Controller } from '../../src/app/controller';
import { Cache } from '../support/cache';
import { FileStore } from '../support/credentials';
import { HarnessBackend } from '../support/harness';
import type { Backend } from '../../src/backend/backend';
import { startFakeGitHub, type FakeGitHub } from '../fake-github/server';
import { FIXTURE_NOW, item, tempDir } from './helpers';
import {
  credentialText,
  otherPollers,
  parseCredential,
  renameActions,
  renameLockOf,
  renameMissing,
  undoableOf,
  type RenameAnswer,
  type RenameJob,
} from '../../src/shared/labelRename';
import { applyClientRename, blockedLabelsFor, dropOverride, handBackFor, normalizeRepoLabels, overrideRows, renamedFlow } from '../../src/shared/repoLabels';
import { DEFAULT_HAND_BACK } from '../../src/shared/types';
import { DEFAULT_BLOCKED_LABELS } from '../../src/shared/blocked';
import { viewBarTallies } from '../../src/data/flowTally';
import { PendingTracker } from '../../src/data/pending';
import { buildGraph } from '../../src/data/graph';
import { loopKnown } from '../../src/data/loopBlocked';
import type { SourceSnapshot } from '../../src/shared/types';

const shared = { handBack: DEFAULT_HAND_BACK, blockedLabels: DEFAULT_BLOCKED_LABELS };
const label = (name: string) => ({ name, color: 'ededed' });

describe('the rename credential', () => {
  it('reads back what it wrote, and nothing that is not one', () => {
    const c = { repo: 'acme/widget', field: 'LABEL_PENDING_HUMAN', from: 'pending/human', to: 'wait/human', labelId: '42' };
    expect(credentialText(c)).toBe('cavil-label-rename v1 acme/widget LABEL_PENDING_HUMAN pending/human wait/human 42');
    expect(parseCredential(`  ${credentialText(c)}\n`)).toEqual(c);
    for (const bad of [
      '',
      'cavil-label-rename v2 acme/widget LABEL_PENDING_HUMAN pending/human wait/human 42',
      'cavil-label-rename v1 acme/widget LABEL_PENDING_HUMAN pending/human wait/human',
      'cavil-label-rename v1 acme LABEL_PENDING_HUMAN pending/human wait/human 42',
      'cavil-label-rename v1 acme/widget LABEL_PENDING_HUMAN pending/human wait,human 42',
      'cavil-label-rename v1 acme/widget LABEL_PENDING_HUMAN pending/human pending/human 42',
      'cavil-label-rename v1 acme/widget LABEL_PENDING_HUMAN pending/human wait/human 4x',
    ])
      expect(parseCredential(bad), bad).toBeNull();
  });
});

const job = (patch: Partial<RenameJob>): RenameJob => ({
  id: 1,
  key: 'widget',
  repo: 'acme/widget',
  mode: 'rename',
  field: 'LABEL_PENDING_HUMAN',
  from: 'pending/human',
  to: 'wait/human',
  labelId: '42',
  status: 'running',
  github: 'old',
  config: 'old',
  client: 'old',
  polling: 'paused',
  startedAt: 0,
  ...patch,
});

describe('which buttons a rename notice offers', () => {
  it('no answer: only "check again" (read only) and "send again" — never undo, never ×', () => {
    expect(renameActions(job({ status: 'no_answer', github: 'unknown', undoable: true }))).toEqual({ retry: 'recheck', resend: true, out: null, close: false });
  });
  it('GitHub renamed, the config not: retry; undo only when GitHub is surely unchanged', () => {
    expect(renameActions(job({ status: 'partial', github: 'new' }))).toEqual({ retry: 'continue', resend: false, out: null, close: false });
    expect(renameActions(job({ status: 'partial', github: 'old', undoable: true })).out).toBe('undo');
    expect(renameActions(job({ status: 'partial', github: 'old', undoable: false })).out).toBeNull();
  });
  it('unknown: "check again" and "fixed by hand"; the client part not saved: retry and "fixed by hand"', () => {
    expect(renameActions(job({ status: 'unknown', github: 'unknown' }))).toEqual({ retry: 'recheck', resend: false, out: 'abandon', close: false });
    expect(renameActions(job({ status: 'client', github: 'new', config: 'new' }))).toEqual({ retry: 'continue', resend: false, out: 'abandon', close: false });
  });
  it('refused before anything changed: nothing to undo, × at once; done / undone: ×; running: nothing', () => {
    expect(renameActions(job({ status: 'refused', polling: 'running' }))).toEqual({ retry: null, resend: false, out: null, close: true });
    expect(renameActions(job({ status: 'done', polling: 'running' })).close).toBe(true);
    expect(renameActions(job({ status: 'undone', polling: 'running' })).close).toBe(true);
    expect(renameActions(job({ status: 'running' }))).toEqual({ retry: null, resend: false, out: null, close: false });
  });
  it('undo only for a record whose request surely never went out (or a follow whose config is still old)', () => {
    expect(undoableOf({ mode: 'rename', step: 'github', sent: false, unanswered: false }, 'old')).toBe(true);
    expect(undoableOf({ mode: 'rename', step: 'github', sent: true, unanswered: false }, 'old')).toBe(false);
    expect(undoableOf({ mode: 'rename', step: 'github', sent: false, unanswered: true }, 'old')).toBe(false);
    expect(undoableOf({ mode: 'rename', step: 'config' }, 'old')).toBe(false);
    expect(undoableOf({ mode: 'follow', step: 'config' }, 'old')).toBe(true);
    expect(undoableOf({ mode: 'follow', step: 'client' }, 'new')).toBe(false);
    expect(undoableOf(null, 'old')).toBe(false);
  });
  it('a rename not settled holds the label buttons of its repository only', () => {
    const jobs = [job({ status: 'no_answer' }), job({ id: 2, repo: 'acme/other', status: 'done', polling: 'running' })];
    expect(renameLockOf(jobs, 'ACME/widget')?.id).toBe(1);
    expect(renameLockOf(jobs, 'acme/other')).toBeNull();
    expect(renameLockOf(jobs, 'acme/third')).toBeNull();
  });
});

describe("the client's own names after a rename", () => {
  it('the slot whose name is the old one changes for that repository only', () => {
    const r = applyClientRename(shared, 'Acme/Widget', 'LABEL_PENDING_HUMAN', 'pending/human', 'wait/human');
    expect(r.slotOutcome).toBe('renamed');
    expect(r.repoLabels).toEqual({ 'acme/widget': { hand: { human: 'wait/human' }, flow: 'pending/*, doing/*, Done, wait/human' } });
    const after = { ...shared, repoLabels: r.repoLabels };
    expect(handBackFor(after, 'acme/widget').human).toBe('wait/human');
    expect(handBackFor(after, 'acme/other')).toBe(DEFAULT_HAND_BACK);
    expect(blockedLabelsFor(after, 'acme/other')).toBe(DEFAULT_BLOCKED_LABELS);
    // done again (a retry after the save went through): the same
    expect(applyClientRename(after, 'acme/widget', 'LABEL_PENDING_HUMAN', 'pending/human', 'wait/human').repoLabels).toEqual(r.repoLabels);
  });
  it('a slot that already has another name is left as it is, and said', () => {
    const s = { ...shared, repoLabels: { 'acme/widget': { hand: { human: 'needs/me' } } } };
    const r = applyClientRename(s, 'acme/widget', 'LABEL_PENDING_HUMAN', 'pending/human', 'wait/human');
    expect(r.slotOutcome).toBe('kept');
    expect(r.slotWas).toBe('needs/me');
    expect(r.repoLabels['acme/widget'].hand).toEqual({ human: 'needs/me' });
  });
  it('a setting without a client name only touches the flow list', () => {
    const r = applyClientRename(shared, 'acme/widget', 'LABEL_DONE', 'Done', 'Finished');
    expect(r.slot).toBeNull();
    expect(r.slotOutcome).toBe('none');
    expect(r.repoLabels).toEqual({ 'acme/widget': { flow: 'pending/*, doing/*, Finished' } });
  });
  it('the flow list: an exact name is replaced; a wildcard that covered the old name and not the new one gets the new one; otherwise as it was', () => {
    expect(renamedFlow('pending/*, doing/*, Done', 'done', 'Shipped')).toBe('pending/*, doing/*, Shipped');
    expect(renamedFlow('pending/*, doing/*, Done', 'pending/merge', 'merge/ready')).toBe('pending/*, doing/*, Done, merge/ready');
    expect(renamedFlow('pending/*, doing/*, Done', 'pending/merge', 'pending/go')).toBeNull();
    expect(renamedFlow('pending/*, doing/*, Done', 'autopilot', 'auto')).toBeNull();
  });
  it('a name equal to the shared one is not kept as an override; "back to shared" drops one name', () => {
    const s = { ...shared, repoLabels: { 'acme/widget': { hand: { human: 'wait/human', agent: 'go/agent' } } } };
    const back = applyClientRename(s, 'acme/widget', 'LABEL_PENDING_HUMAN', 'wait/human', 'pending/human');
    expect(back.repoLabels['acme/widget'].hand).toEqual({ agent: 'go/agent' });
    expect(overrideRows(s).map((r) => `${r.repo} ${r.slot} ${r.name}`)).toEqual(['acme/widget human wait/human', 'acme/widget agent go/agent']);
    const one = dropOverride(s.repoLabels, 'Acme/Widget', 'human');
    expect(one).toEqual({ 'acme/widget': { hand: { agent: 'go/agent' } } });
    expect(dropOverride(one, 'acme/widget', 'agent')).toEqual({});
  });
  it('what the settings hold is made usable: anything not a whole valid entry is left out', () => {
    expect(normalizeRepoLabels(null)).toEqual({});
    expect(normalizeRepoLabels([1])).toEqual({});
    expect(normalizeRepoLabels({ 'Acme/Widget': { hand: { human: ' x ', bogus: 'y', agent: 3 }, flow: '' }, 'not a repo': { hand: { human: 'z' } } })).toEqual({ 'acme/widget': { hand: { human: 'x' } } });
  });
});

describe('every user of the label names asks for the item\'s repository', () => {
  const s = { ...shared, repoLabels: { 'acme/widget': { hand: { human: 'wait/human', running: 'busy/agent', blocked: 'wait/blocked' } } } };
  const items = [
    item('acme/widget', 1, { labels: [label('wait/human')] }),
    item('acme/widget', 2, { labels: [label('pending/human')] }),
    item('acme/other', 3, { labels: [label('pending/human')] }),
    item('acme/widget', 4, { labels: [label('busy/agent')] }),
    item('acme/other', 5, { labels: [label('doing/agent')] }),
  ];
  it('the view-bar numbers: each item under its own repository\'s name; the click lists both names', () => {
    const by = viewBarTallies(items, null, s.handBack, undefined, (r) => handBackFor(s, r));
    const human = by.find((e) => e.flow === 'human')!;
    expect(human.count).toBe(2); // #1 (wait/human in widget) and #3 (pending/human in other) — not #2
    expect(human.query).toBe('label:"pending/human","wait/human"');
    expect(by.find((e) => e.flow === 'running')!.count).toBe(2);
    // without overrides: exactly as before
    const plain = viewBarTallies(items, null, s.handBack);
    expect(plain.find((e) => e.flow === 'human')!.count).toBe(2); // #2, #3
    expect(plain.find((e) => e.flow === 'human')!.query).toBe('label:"pending/human"');
    expect(viewBarTallies(items, null, s.handBack, undefined, (r) => handBackFor(shared, r))).toEqual(plain);
  });
  it('reminders count each item under its repository\'s name', () => {
    const snap = { sourceKey: 's', items, fetchedAt: 1 } as unknown as SourceSnapshot;
    const p = new PendingTracker((repo: string) => handBackFor(s, repo).human);
    p.observe([snap], ['s']);
    expect(p.pending().map((i) => i.number).sort()).toEqual([1, 3]);
    p.relabel('pending/human', new Map([['s', snap]]));
    expect(p.pending().map((i) => i.number).sort()).toEqual([2, 3]);
  });
  it('the graph and the loop reads use the repository\'s waiting label', () => {
    const rel = { parent: null, subIssues: [], blockedBy: [], blocking: [] };
    const w = item('acme/widget', 7, { labels: [label('wait/blocked')], relations: rel, loopBlocked: { label: 'wait/blocked', ends: [] } });
    const o = item('acme/other', 8, { labels: [label('pending/blocked')], relations: rel, loopBlocked: { label: 'pending/blocked', ends: [] } });
    const by = (r: string) => handBackFor(s, r).blocked;
    expect(loopKnown([w, o], by)).toBe(true);
    // under the shared label alone (as before), #7's registration read under its own name does not count
    expect(loopKnown([w, o], 'pending/blocked')).toBe(false);
    // a registration read under the shared name for a repository that has its own is not known
    expect(loopKnown([{ ...w, loopBlocked: { label: 'pending/blocked', ends: [] } }], by)).toBe(false);
    expect(buildGraph([w, o], [w, o], by).unknown).toBe(0);
    expect(buildGraph([{ ...w, loopBlocked: undefined }], [{ ...w, loopBlocked: undefined }], by).unknown).toBe(1);
  });
});

describe('the rename dialog', () => {
  const st = (projects: { key: string; repo: string | null; state: 'running' | 'stopped' | 'unknown' }[]) => ({ projects: projects.map((p) => ({ key: p.key, repo: p.repo, scheduler: { state: p.state } })) });
  it('lists every other daemon of the same repository; a machine that cannot be read counts as not stopped', () => {
    const local = st([
      { key: 'widget', repo: 'acme/widget', state: 'running' },
      { key: 'widget2', repo: 'Acme/Widget', state: 'running' },
      { key: 'other', repo: 'acme/other', state: 'running' },
    ]);
    const list = otherPollers(local, 'widget', 'acme/widget', [
      { id: 'm1:1', name: 'm1', status: st([{ key: 'w', repo: 'acme/widget', state: 'stopped' }]) },
      { id: 'm2:1', name: 'm2', status: null },
    ]);
    expect(list.map((p) => `${p.where} ${p.name} ${p.key} ${p.state}${p.unreadable ? ' unreadable' : ''}`)).toEqual(['local  widget2 running', 'remote m1 w stopped', 'remote m2  unknown unreadable']);
    expect(renameMissing({ checks: [{ id: 'name', ok: true, text: '' }], checking: false, pollers: list, ticked: true, remotes: 'read' })).toEqual(['还有 2 个别处的轮询没停（或读不到）']);
  });
  it('the button waits for every check, every poller stopped and the tick', () => {
    const ok = [
      { id: 'name', ok: true as const, text: '' },
      { id: 'others_stopped', ok: false as const, text: '' },
    ];
    expect(renameMissing({ checks: ok, checking: false, pollers: [], ticked: true, remotes: 'read' })).toEqual([]);
    expect(renameMissing({ checks: ok, checking: false, pollers: [], ticked: false, remotes: 'read' })).toEqual(['还没勾选「已确认」']);
    expect(renameMissing({ checks: [{ id: 'labels', ok: null, text: '' }], checking: false, pollers: [], ticked: true, remotes: 'read' })).toEqual(['有 1 项检查没过']);
    expect(renameMissing({ checks: null, checking: true, pollers: [], ticked: true, remotes: 'read' })).toEqual(['检查还没做完']);
    // PR #571 review round 2: the paired machines' list still being read, or not readable, keeps the button off
    expect(renameMissing({ checks: ok, checking: false, pollers: [], ticked: true, remotes: 'loading' })).toEqual(['还在读取配对过的远程机器']);
    expect(renameMissing({ checks: ok, checking: false, pollers: [], ticked: true, remotes: 'failed' })).toEqual(['读不到配对过的远程机器列表（算作没停）']);
  });
});

// ── the controller, with a stand-in for label-rename.sh and the real back end for the settings ──

let fake: FakeGitHub;
let dir: string;
const open: { c: Controller; backend: HarnessBackend; cache: Cache }[] = [];

const ANSWER = (result: string, more: Partial<RenameAnswer> = {}): RenameAnswer => ({ result, ran: true, github: 'new', config: 'new', paused: true, watch: false, labelId: '42', checks: [], record: null, output: '', ...more });

async function make(script: (cmd: string, args: Record<string, unknown>) => RenameAnswer, opts: { failSave?: () => boolean } = {}) {
  const db = join(dir, 'cache.sqlite');
  const cache = new Cache(db);
  const endpoints = { api: fake.api, web: fake.web };
  const backend = new HarnessBackend({ db, endpoints, credentials: new FileStore(join(dir, 'cred')), now: () => FIXTURE_NOW, opened: [] });
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];
  const wrapped: Backend = {
    call: async (cmd, args) => {
      const a = (args ?? {}) as Record<string, unknown>;
      if (cmd === 'daemonLabelRename') {
        calls.push({ cmd: String(a.cmd), args: a });
        return script(String(a.cmd), a) as never;
      }
      if (cmd === 'setSetting' && a.key === 'repoLabels' && opts.failSave?.()) throw new Error('disk full');
      return backend.call(cmd, args);
    },
  };
  const c = await Controller.create({ backend: wrapped, endpoints, now: () => FIXTURE_NOW, defaultClientId: '' });
  open.push({ c, backend, cache });
  return { c, calls, backend };
}

const until = async (f: () => boolean) => {
  for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(f()).toBe(true);
};

const REQ = { key: 'widget', repo: 'acme/widget', mode: 'rename' as const, field: 'LABEL_PENDING_HUMAN', from: 'pending/human', to: 'wait/human', rev: 'a1'.repeat(32), othersStopped: true };

beforeEach(async () => {
  fake = await startFakeGitHub();
  dir = tempDir();
});
afterEach(async () => {
  for (const o of open) o.c.stopTimer();
  await Promise.all(open.map((o) => o.backend.close()));
  for (const o of open) o.cache.close();
  open.length = 0;
  await fake.close();
});

describe('the controller runs a rename', () => {
  it('GitHub and the config renamed → the client\'s names saved for that repository and read back → finish → done', async () => {
    const { c, calls, backend } = await make((cmd) => (cmd === 'rename' ? ANSWER('awaiting_client', { github: 'new', config: 'new' }) : ANSWER('done', { paused: false })));
    expect(c.startLabelRename(REQ)).toMatchObject({ ok: true });
    await until(() => c.getState().renameJobs[0]?.status === 'done');
    expect(calls.map((x) => x.cmd)).toEqual(['rename', 'finish']);
    expect(calls[0].args).toMatchObject({ field: 'LABEL_PENDING_HUMAN', from: 'pending/human', to: 'wait/human', othersStopped: true });
    const s = c.getState();
    expect(s.renameJobs[0]).toMatchObject({ github: 'new', config: 'new', client: 'new', polling: 'running', labelId: '42' });
    expect(handBackFor(s, 'acme/widget').human).toBe('wait/human');
    expect(handBackFor(s, 'acme/other').human).toBe('pending/human');
    expect(s.handBack.human).toBe('pending/human');
    // on the back end, before finish was sent
    const init = (await backend.call('init')) as { settings: Record<string, unknown> };
    expect(normalizeRepoLabels(init.settings.repoLabels)).toEqual(s.repoLabels);
  });

  it('the client\'s names cannot be saved: no finish, the rename stays pending; 「重试」 = continue, save again, finish', async () => {
    let fail = true;
    const { c, calls } = await make((cmd) => (cmd === 'finish' ? ANSWER('done', { paused: false }) : ANSWER('awaiting_client')), { failSave: () => fail });
    c.startLabelRename(REQ);
    await until(() => c.getState().renameJobs[0]?.status === 'client');
    expect(calls.map((x) => x.cmd)).toEqual(['rename']);
    const j = c.getState().renameJobs[0];
    expect(j).toMatchObject({ client: 'old', polling: 'paused' });
    expect(renameLockOf(c.getState().renameJobs, 'acme/widget')).not.toBeNull();
    // a label button of that repository is refused meanwhile (nothing sent)
    expect(c.startLabelRename(REQ)).toMatchObject({ ok: false });
    fail = false;
    expect(await c.labelRenameStep(j.id, 'continue')).toEqual({ ok: true, error: null });
    expect(c.getState().renameJobs[0].status).toBe('done');
    expect(calls.map((x) => x.cmd)).toEqual(['rename', 'continue', 'finish']);
  });

  it('no answer: only check again / send again; undo is refused', async () => {
    const { c, calls } = await make((cmd) => (cmd === 'rename' ? ANSWER('no_answer', { github: 'unknown', config: 'old', record: { mode: 'rename', step: 'github', sent: true, unanswered: true } }) : ANSWER('no_answer', { github: 'unknown', config: 'old' })));
    c.startLabelRename(REQ);
    await until(() => c.getState().renameJobs[0]?.status === 'no_answer');
    const id = c.getState().renameJobs[0].id;
    expect(await c.labelRenameStep(id, 'undo')).toMatchObject({ ok: false });
    await c.labelRenameStep(id, 'resend');
    expect(calls.map((x) => x.cmd)).toEqual(['rename', 'resend']);
  });

  it('refused by the checks: nothing changed, × at once, nothing holds the repository', async () => {
    const { c } = await make(() => ANSWER('refused', { github: 'old', config: 'old', paused: false, output: '检查没过，什么都没改' }));
    c.startLabelRename(REQ);
    await until(() => c.getState().renameJobs[0]?.status === 'refused');
    const j = c.getState().renameJobs[0];
    expect(renameActions(j).close).toBe(true);
    expect(renameLockOf(c.getState().renameJobs, 'acme/widget')).toBeNull();
    expect(c.getState().repoLabels).toEqual({});
  });
});
