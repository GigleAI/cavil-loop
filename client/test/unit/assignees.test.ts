// GitHub#711: changing an item's assignees from the detail and the table. The controller against the
// fake GitHub over real HTTP, with the real back end (Rust) as a child process — so the DELETE that
// carries its body goes through the same HTTP layer as in the app. For every write: the exact request
// GitHub receives and the board after it; for every refusal: why, and that GitHub was not changed,
// next to a case where the same write really goes out. The pure rules (rows of the picker, the edit
// record's field) at the end.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { Controller } from '../../src/app/controller';
import { createController } from '../support/controller';
import { Cache } from '../support/cache';
import { FileStore } from '../support/credentials';
import { HarnessBackend } from '../support/harness';
import { startFakeGitHub, FakeGitHub } from '../fake-github/server';
import { FAKE_TOKEN, FIXTURE_NOW, tempDir, trustedList } from './helpers';
import type { EditMark, Item } from '../../src/shared/types';
import { MAX_ASSIGNEES, assigneeRows, sameLogin } from '../../src/shared/assignees';
import { assigneeAnswer } from '../../src/data/actions';
import { fieldId, fieldValue, isEditRecord, overlayItem, startEdit, targetText, type EditRecord } from '../../src/data/edits';
import { noteEditOf } from '../../src/renderer/noteEdits';

const PROJECT_URL = 'https://github.com/orgs/GigleAI/projects/11';
const REPO = 'GigleAI/cavil-loop';
const K = (n: number) => `gigleai/cavil-loop#${n}`;
const N = 138;
const PATH = `/api/repos/${REPO}/issues/${N}/assignees`;

let fake: FakeGitHub;
let dir: string;
let caches: Cache[] = [];
let controllers: Controller[] = [];
let backends: HarnessBackend[] = [];

async function ready() {
  const cache = new Cache(join(dir, 'cache.sqlite'));
  caches.push(cache);
  cache.setSetting('trustedCredentials', trustedList(FAKE_TOKEN));
  const credentials = new FileStore(join(dir, 'cred'));
  await credentials.set(FAKE_TOKEN);
  const endpoints = { api: fake.api, web: fake.web };
  const harness = new HarnessBackend({ db: join(dir, 'cache.sqlite'), endpoints, credentials, now: () => FIXTURE_NOW, sleep: async () => {} });
  backends.push(harness);
  const c = await createController({ backend: harness, endpoints, now: () => FIXTURE_NOW, defaultClientId: '', observeMs: 60_000, observeFirstMs: 60_000 });
  controllers.push(c);
  c.addSource(PROJECT_URL);
  c.addSource(REPO);
  await c.start();
  await c.syncNow();
  expect(c.getState().phase).toBe('ready');
  return { c };
}

/** GitHub's assignees of #n, set in every copy the fake holds (as if changed on the web) */
function assignOnGitHub(n: number, logins: string[]) {
  for (const r of fake.state.repos.get('gigleai/cavil-loop')!) if (r.number === n) r.assignees = logins.map((login) => ({ login }));
  for (const p of fake.state.projects.get('org/gigleai/11')!) for (const node of p.items.nodes) if (node.content?.number === n) node.content.assignees = { nodes: logins.map((login) => ({ login })) };
}
const onGitHub = (n = N) => ((fake.state.repos.get('gigleai/cavil-loop')!.find((r: any) => r.number === n) as any)?.assignees ?? []).map((a: any) => a.login).sort();
const itemOf = (c: Controller, n = N): Item => {
  const it = c.getBoardData().items.find((i) => i.key === K(n));
  if (!it) throw new Error(`#${n} not on the board`);
  return it;
};
const assigneesOf = (c: Controller, n = N) => [...itemOf(c, n).assignees].sort();
const markOf = (c: Controller, n = N): EditMark | null => itemOf(c, n).edits?.find((m) => m.field === 'assignee') ?? null;
const assigneeWrites = () => fake.writes().filter((w) => w.path.startsWith(PATH)).map((w) => [w.method, w.path, w.body]);
/** anything that would replace the whole list (PATCH of the item with `assignees`, PUT) */
const wholeListWrites = () => fake.writes().filter((w) => (w.method === 'PATCH' && (w.body as any)?.assignees !== undefined) || w.method === 'PUT');

beforeEach(async () => {
  fake = await startFakeGitHub();
  dir = tempDir();
});
afterEach(async () => {
  for (const c of controllers) c.stopTimer();
  await Promise.all(backends.map((b) => b.close()));
  for (const c of caches) c.close();
  caches = [];
  controllers = [];
  backends = [];
  await fake.close();
});

describe('assignees: only "add this one" / "remove this one" is sent', () => {
  it('add: POST with just that login; someone assigned on the web meanwhile stays', async () => {
    assignOnGitHub(N, []);
    const { c } = await ready();
    assignOnGitHub(N, ['web-user']); // not in the client's copy yet
    const r = await c.act({ kind: 'addAssignee', key: K(N), login: 'alice' });
    expect(r).toMatchObject({ ok: true, held: true });
    expect(assigneeWrites()).toEqual([['POST', PATH, { assignees: ['alice'] }]]);
    expect(wholeListWrites()).toEqual([]);
    expect(onGitHub()).toEqual(['alice', 'web-user']);
    // re-read at once: the board shows GitHub's list, the change is settled
    expect(assigneesOf(c)).toEqual(['alice', 'web-user']);
    expect(markOf(c)).toBeNull();
  });

  it('remove: DELETE carrying just that login (through the real back end); logins match whatever their case', async () => {
    assignOnGitHub(N, ['alice', 'bob']);
    const { c } = await ready();
    expect(assigneesOf(c)).toEqual(['alice', 'bob']);
    const r = await c.act({ kind: 'removeAssignee', key: K(N), login: 'ALICE' });
    expect(r.ok).toBe(true);
    expect(assigneeWrites()).toEqual([['DELETE', PATH, { assignees: ['ALICE'] }]]);
    expect(wholeListWrites()).toEqual([]);
    expect(onGitHub()).toEqual(['bob']);
    expect(assigneesOf(c)).toEqual(['bob']);
    expect(markOf(c)).toBeNull();
  });

  it('GitHub answers success but leaves the account out: "not saved", with the reason; the board keeps GitHub\'s list', async () => {
    assignOnGitHub(N, []);
    const { c } = await ready();
    fake.state.w.dropAssignees.add('outsider');
    const r = await c.act({ kind: 'addAssignee', key: K(N), login: 'outsider' });
    expect(r.ok).toBe(false);
    expect(r.held).toBe(true);
    // the write did go out — GitHub just did not take it
    expect(assigneeWrites()).toEqual([['POST', PATH, { assignees: ['outsider'] }]]);
    const m = markOf(c)!;
    expect(m.status).toBe('failed');
    expect(m.failure).toContain('没有把「outsider」设为负责人');
    expect(m.login).toBe('outsider');
    expect(assigneesOf(c)).toEqual([]);
    expect(c.getState().editsNeedingAction).toBe(1);
    // resend once GitHub takes it: settled
    fake.state.w.dropAssignees.clear();
    expect((await c.resendEdit(m.id)).ok).toBe(true);
    expect(assigneeWrites()).toHaveLength(2);
    expect(assigneesOf(c)).toEqual(['outsider']);
    expect(markOf(c)).toBeNull();
  });

  it('an answer without a readable list is no proof: "not confirmed" (never shown as saved) until a read shows it', async () => {
    assignOnGitHub(N, []);
    const { c } = await ready();
    fake.state.w.assigneeAnswerWithoutList = true;
    const r = await c.act({ kind: 'addAssignee', key: K(N), login: 'alice' });
    expect(r.ok).toBe(false);
    expect(assigneeWrites()).toHaveLength(1);
    expect(markOf(c)?.status).toBe('unconfirmed');
    expect(c.getState().editsNeedingAction).toBe(1);
    // the write had landed: the next sync round's read settles it
    await c.syncNow();
    expect(assigneesOf(c)).toEqual(['alice']);
    expect(markOf(c)).toBeNull();
  });

  it(`at ${MAX_ASSIGNEES} assignees a new one is refused before anything is sent; at ${MAX_ASSIGNEES - 1} it goes out`, async () => {
    const nine = Array.from({ length: MAX_ASSIGNEES - 1 }, (_, i) => `u${i}`);
    assignOnGitHub(N, nine);
    const { c } = await ready();
    expect((await c.act({ kind: 'addAssignee', key: K(N), login: 'tenth' })).ok).toBe(true);
    expect(assigneeWrites()).toEqual([['POST', PATH, { assignees: ['tenth'] }]]);
    expect(assigneesOf(c)).toHaveLength(MAX_ASSIGNEES);
    const before = fake.writes().length;
    const r = await c.act({ kind: 'addAssignee', key: K(N), login: 'eleventh' });
    expect(r.ok).toBe(false);
    expect(markOf(c)?.failure).toContain(`最多 ${MAX_ASSIGNEES} 个负责人`);
    expect(fake.writes().length).toBe(before);
    expect(onGitHub()).toHaveLength(MAX_ASSIGNEES);
    // taking one off is never blocked by the cap
    expect((await c.act({ kind: 'removeAssignee', key: K(N), login: 'u0' })).ok).toBe(true);
    expect(onGitHub()).not.toContain('u0');
  });
});

describe('the picker\'s candidates: read apart from labels / milestones', () => {
  it('lists the accounts GitHub says may be assigned, kept for the run; `fresh` reads again', async () => {
    const { c } = await ready();
    fake.state.w.assignable.set('gigleai/cavil-loop', ['alice', 'Bob', 'bob']);
    const reads = () => fake.log.filter((q) => q.path.startsWith(`/api/repos/${REPO}/assignees`)).length;
    expect(await c.repoAssignees(REPO)).toEqual({ logins: ['alice', 'Bob'], error: null });
    expect(reads()).toBe(1);
    await c.repoAssignees(REPO);
    expect(reads()).toBe(1);
    fake.state.w.assignable.set('gigleai/cavil-loop', ['carol']);
    expect((await c.repoAssignees(REPO, true)).logins).toEqual(['carol']);
    expect(reads()).toBe(2);
  });

  it('a failed read says why and is not kept — and the label / milestone lists still load', async () => {
    const { c } = await ready();
    fake.state.w.failAssignees.add('gigleai/cavil-loop');
    const failed = await c.repoAssignees(REPO);
    expect(failed.logins).toEqual([]);
    expect(failed.error).toContain('可指派的账号失败');
    const opts = await c.repoOptions(REPO, true);
    expect(opts.error).toBeNull();
    expect(opts.labels.length).toBeGreaterThan(0);
    fake.state.w.failAssignees.clear();
    fake.state.w.assignable.set('gigleai/cavil-loop', ['alice']);
    expect(await c.repoAssignees(REPO)).toEqual({ logins: ['alice'], error: null });
  });
});

describe('pure rules', () => {
  it('picker rows: the assigned first (ticked, also when not a candidate), then candidates; the signed-in account marked; the cap blocks only adding', () => {
    const rows = assigneeRows(['Alice', 'gone'], ['bob', 'alice', 'me'], 'ME');
    expect(rows.map((r) => [r.name, r.checked, r.note ?? '', r.blocked ?? ''])).toEqual([
      ['Alice', true, '', ''],
      ['gone', true, '', ''],
      ['bob', false, '', ''],
      ['me', false, '（自己）', ''],
    ]);
    const full = assigneeRows(Array.from({ length: MAX_ASSIGNEES }, (_, i) => `u${i}`), ['x'], null);
    expect(full.filter((r) => r.checked).every((r) => !r.blocked)).toBe(true);
    expect(full.find((r) => r.name === 'x')?.blocked).toContain(String(MAX_ASSIGNEES));
    expect(assigneeRows(Array.from({ length: MAX_ASSIGNEES - 1 }, (_, i) => `u${i}`), ['x'], null).find((r) => r.name === 'x')?.blocked).toBeUndefined();
  });

  it('GitHub\'s answer: the login present after an add / gone after a remove; no readable list is unknown', () => {
    expect(assigneeAnswer({ assignees: [{ login: 'Alice' }] }, 'alice', true)).toBe('done');
    expect(assigneeAnswer({ assignees: [] }, 'alice', true)).toBe('refused');
    expect(assigneeAnswer({ assignees: [] }, 'alice', false)).toBe('done');
    expect(assigneeAnswer({ assignees: [{ login: 'alice' }] }, 'alice', false)).toBe('refused');
    for (const bad of [null, {}, { assignees: null }, { assignees: [{}] }, { assignees: [{ login: 1 }] }]) expect(assigneeAnswer(bad, 'alice', true)).toBe('unknown');
  });

  it('the edit record: one id per account whatever its case; the value and the overlay match logins without case', () => {
    expect(sameLogin('Alice', 'alice')).toBe(true);
    const a = fieldId(K(N), { kind: 'assignee', login: 'Alice' });
    expect(a).toBe(fieldId(K(N), { kind: 'assignee', login: 'alice' }));
    expect(a).not.toBe(fieldId(K(N), { kind: 'label', label: 'alice', color: '' }));
    // the window's note watches the same id the record has
    expect(noteEditOf({ kind: 'addAssignee', key: K(N), login: 'ALICE' })?.id).toBe(a);
    const item = { key: K(N), repo: REPO, number: N, assignees: ['ALICE'], labels: [], projects: [], milestone: null } as unknown as Item;
    expect(fieldValue(item, { kind: 'assignee', login: 'alice' })).toBe(true);
    expect(fieldValue(item, { kind: 'assignee', login: 'bob' })).toBe(false);
    const init = (login: string, base: boolean) => ({ id: fieldId(item.key, { kind: 'assignee', login }), key: item.key, repo: REPO, number: N, field: { kind: 'assignee' as const, login }, base });
    const add: EditRecord = startEdit(null, init('bob', false), true, 1);
    const remove: EditRecord = startEdit(null, init('alice', true), false, 2);
    expect(overlayItem(item, [add], []).assignees).toEqual(['ALICE', 'bob']);
    expect(overlayItem(item, [remove], []).assignees).toEqual([]);
    expect(overlayItem(item, [add], []).edits?.[0]).toMatchObject({ field: 'assignee', login: 'bob', status: 'saving' });
    expect(targetText(add, [])).toBe('把「bob」设为负责人');
    expect(targetText(remove, [])).toBe('去掉负责人「alice」');
    // read back from disk: kept when well-formed, dropped (never guessed) without a login
    expect(isEditRecord(add)).toBe(true);
    expect(isEditRecord({ ...add, field: { kind: 'assignee' } })).toBe(false);
  });
});
