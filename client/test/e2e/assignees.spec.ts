// GigleAI/cavil-loop#711: changing assignees in the detail (header button, key A) and in the table's
// 负责人 column. In the real window (built with --test-bridge), the real back end behind the loopback
// bridge, the fake GitHub serving the board recorded from the real cavil project, signed in as user-6.
// Every change is checked as the request GitHub received (one login in or out, never the whole list)
// and as what the window shows after it; a refusal is checked in the notice area, next to the same
// write going through.

import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeGitHub } from '../fake-github/server';
import { launchApp, closeEngine, type AppEnv } from './bridge';
import { unfoldSettings } from './unfold';
import type { Item } from '../../src/shared/types';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const screens = join(root, 'test-results', 'screens');
mkdirSync(screens, { recursive: true });

const ME = 'user-6';
/** an open issue opened by user-1 in the recording; no assignee here */
const N = 135;
const KEY = `gigleai/cavil-loop#${N}`;
const PATH = `/api/repos/GigleAI/cavil-loop/issues/${N}/assignees`;

let env: AppEnv;
test.beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cavil-e2e-assignees-'));
  env = {
    fake: await startFakeGitHub({ viewer: ME }),
    userData: join(dir, 'userData'),
    cred: join(dir, 'cred'),
    opened: join(dir, 'opened.txt'),
    requests: join(dir, 'requests.txt'),
  };
  setAssignees([]);
  env.fake.state.w.assignable.set('gigleai/cavil-loop', [ME, 'user-1', 'alice']);
});
test.afterEach(async () => {
  await env.fake.close();
});
test.afterAll(async () => {
  await closeEngine();
});

/** #N's assignees on GitHub, in every copy the fake holds */
function setAssignees(logins: string[]) {
  let n = 0;
  for (const r of env.fake.state.repos.get('gigleai/cavil-loop') ?? []) if (r.number === N) (r.assignees = logins.map((login) => ({ login }))), n++;
  for (const p of env.fake.state.projects.get('org/gigleai/11')!) for (const node of p.items.nodes) if (node.content?.number === N) (node.content.assignees = { nodes: logins.map((login) => ({ login })) }), n++;
  if (!n) throw new Error(`the recording no longer holds #${N}`);
}
const onGitHub = () => {
  const node = env.fake.state.projects.get('org/gigleai/11')!.flatMap((p) => p.items.nodes).find((x) => x.content?.number === N);
  return (node!.content.assignees.nodes as { login: string }[]).map((a) => a.login).sort();
};
const assigneeWrites = () => env.fake.writes().filter((w) => w.path === PATH).map((w) => [w.method, w.body]);
/** anything that would replace the whole list */
const wholeList = () => env.fake.writes().filter((w) => w.method === 'PUT' || (w.method === 'PATCH' && (w.body as any)?.assignees !== undefined));
const items = (page: Page) => page.evaluate(async () => (await (window as any).cavil.get()).data.items as Item[]);
const shown = async (page: Page) => [...((await items(page)).find((i) => i.key === KEY)?.assignees ?? [])].sort();

async function shot(page: Page, name: string) {
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(screens, `${name}.png`) });
}

async function ready(page: Page) {
  await page.getByTestId('oauth-settings-toggle').click();
  await page.getByTestId('client-id').fill(env.fake.state.oauthClientId);
  await page.getByTestId('save-client-id').click();
  await page.getByTestId('start-login').click();
  await expect(page.getByTestId('user-code')).toBeVisible();
  env.fake.resolveGrant('approved');
  await expect(page.getByTestId('board')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('open-settings').click();
  await unfoldSettings(page);
  await page.getByTestId('source-input').fill('https://github.com/orgs/GigleAI/projects/11');
  await page.getByTestId('source-add').click();
  await page.getByTestId('back').click();
  await expect(page.getByTestId('table')).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => (await items(page)).some((i) => i.key === KEY)).toBe(true);
}

test('GitHub#711: the table\'s 负责人 cell and the detail\'s header both add / remove one assignee at a time', async () => {
  const app = await launchApp(env);
  const page = app.page;
  await ready(page);
  await page.evaluate(() => (window as any).cavil.setView({ table: { columns: ['title', 'assignees', 'labels', 'updated'] } }));
  const cell = page.locator(`[data-testid="row"][data-key="${KEY}"] [data-testid="cell"][data-col="assignees"]`).first();
  await expect(cell).toBeVisible({ timeout: 15_000 });

  // ---- table: the cell opens the picker; the signed-in account comes first, marked ----
  await cell.click();
  const cellPicker = page.getByTestId('cell-assignee-picker');
  await expect(cellPicker).toBeVisible();
  const names = cellPicker.locator('[data-testid="picker-item"]');
  await expect(names).toHaveCount(3);
  await expect(names.first()).toHaveAttribute('data-name', ME);
  await expect(names.first()).toContainText('（自己）');
  await shot(page, 'assignees-01-table-picker');
  await cellPicker.locator('[data-testid="picker-item"][data-name="alice"]').click();
  await expect.poll(assigneeWrites).toEqual([['POST', { assignees: ['alice'] }]]);
  await expect.poll(() => shown(page)).toEqual(['alice']);
  expect(onGitHub()).toEqual(['alice']);
  await expect(cellPicker.locator('[data-testid="picker-item"][data-name="alice"]')).toHaveAttribute('data-checked', 'yes');
  await page.keyboard.press('Escape');
  await expect(cellPicker).toHaveCount(0);
  await expect(cell.locator('[data-testid="cell-assignee"][data-login="alice"]')).toBeVisible();

  // ---- detail: A opens the picker in the header; Enter on the first row (me) adds me ----
  await page.locator(`[data-testid="row"][data-key="${KEY}"] [data-testid="row-title"]`).first().click();
  const detail = page.getByTestId('detail');
  await expect(detail).toBeVisible();
  await expect(detail.getByTestId('assignee-edit')).toContainText('改负责人');
  await page.keyboard.press('a');
  const picker = detail.getByTestId('assignee-picker');
  await expect(picker).toBeVisible();
  // what was assigned when it opened is listed first (ticked), then me
  await expect(picker.locator('[data-testid="picker-item"]').first()).toHaveAttribute('data-name', 'alice');
  await expect(picker.locator('[data-testid="picker-item"]').nth(1)).toHaveAttribute('data-name', ME);
  await picker.locator(`[data-testid="picker-item"][data-name="${ME}"]`).click();
  await expect.poll(() => assigneeWrites().length).toBe(2);
  expect(assigneeWrites()[1]).toEqual(['POST', { assignees: [ME] }]);
  await expect.poll(() => shown(page)).toEqual(['alice', ME].sort());
  await expect(detail.locator(`[data-testid="detail-assignee"][data-login="${ME}"]`)).toBeVisible();
  await shot(page, 'assignees-02-detail-picker');
  // untick alice: a DELETE carrying just her
  await picker.locator('[data-testid="picker-item"][data-name="alice"]').click();
  await expect.poll(() => assigneeWrites().length).toBe(3);
  expect(assigneeWrites()[2]).toEqual(['DELETE', { assignees: ['alice'] }]);
  await expect.poll(() => shown(page)).toEqual([ME]);
  expect(onGitHub()).toEqual([ME]);
  await page.keyboard.press('Escape');
  await expect(picker).toHaveCount(0);
  // and me off again: the header offers 「+ 指派」
  await detail.getByTestId('assignee-edit').click();
  await picker.locator(`[data-testid="picker-item"][data-name="${ME}"]`).click();
  await expect.poll(() => shown(page)).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(detail.getByTestId('assignee-edit')).toContainText('+ 指派');
  await shot(page, 'assignees-03-detail-empty');
  expect(wholeList()).toEqual([]);

  // ---- GitHub answers success but leaves the account out: the notice area says it was not saved ----
  env.fake.state.w.dropAssignees.add('alice');
  await detail.getByTestId('assignee-edit').click();
  await picker.locator('[data-testid="picker-item"][data-name="alice"]').click();
  const issue = page.locator('[data-testid="notice-area"] [data-testid="edit-issue"][data-field="assignee"]');
  await expect(issue).toBeVisible({ timeout: 15_000 });
  await expect(issue).toHaveAttribute('data-edit', 'failed');
  await expect(issue.getByTestId('edit-target')).toHaveText('把「alice」设为负责人');
  await expect(issue.getByTestId('edit-failure')).toContainText('没有把「alice」设为负责人');
  await expect.poll(() => shown(page)).toEqual([]);
  expect(onGitHub()).toEqual([]);
  await page.keyboard.press('Escape');
  await shot(page, 'assignees-04-refused');
  await app.close();
});

test('PR #716 review round 1: two assignees — taking the first off keeps the rows; the same row again adds that one back, the other stays', async () => {
  setAssignees(['alice', 'user-1']);
  const app = await launchApp(env);
  const page = app.page;
  await ready(page);
  await page.locator(`[data-testid="row"][data-key="${KEY}"] [data-testid="row-title"]`).first().click();
  const detail = page.getByTestId('detail');
  await detail.getByTestId('assignee-edit').click();
  const picker = detail.getByTestId('assignee-picker');
  const rowNames = () => picker.locator('[data-testid="picker-item"]').evaluateAll((els) => els.map((e) => `${e.getAttribute('data-name')}:${e.getAttribute('data-checked')}`));
  await expect.poll(rowNames).toEqual(['alice:yes', 'user-1:yes', `${ME}:no`]);
  // the first row, clicked where it is (not found by name): alice off
  const first = picker.locator('[data-testid="picker-item"]').first();
  await first.click();
  await expect.poll(assigneeWrites).toEqual([['DELETE', { assignees: ['alice'] }]]);
  await expect.poll(() => shown(page)).toEqual(['user-1']);
  await expect.poll(rowNames).toEqual(['alice:no', 'user-1:yes', `${ME}:no`]);
  // the same position again: alice back, user-1 untouched
  await first.click();
  await expect.poll(() => assigneeWrites().length).toBe(2);
  expect(assigneeWrites()[1]).toEqual(['POST', { assignees: ['alice'] }]);
  await expect.poll(() => shown(page)).toEqual(['alice', 'user-1']);
  await expect.poll(rowNames).toEqual(['alice:yes', 'user-1:yes', `${ME}:no`]);
  // and by the keyboard on the row under the cursor (Enter twice): the same one person each time
  await first.hover();
  await page.keyboard.press('Enter');
  await expect.poll(() => assigneeWrites().length).toBe(3);
  await expect.poll(rowNames).toEqual(['alice:no', 'user-1:yes', `${ME}:no`]);
  await page.keyboard.press('Enter');
  await expect.poll(() => assigneeWrites().length).toBe(4);
  expect(assigneeWrites().slice(2)).toEqual([['DELETE', { assignees: ['alice'] }], ['POST', { assignees: ['alice'] }]]);
  expect(onGitHub()).toEqual(['alice', 'user-1']);
  expect(wholeList()).toEqual([]);
  await app.close();
});

test('GitHub#711: the candidates cannot be read — the picker says why and still lets the current assignee be taken off', async () => {
  setAssignees(['user-1']);
  env.fake.state.w.failAssignees.add('gigleai/cavil-loop');
  const app = await launchApp(env);
  const page = app.page;
  await ready(page);
  await page.locator(`[data-testid="row"][data-key="${KEY}"] [data-testid="row-title"]`).first().click();
  const detail = page.getByTestId('detail');
  await detail.getByTestId('assignee-edit').click();
  const picker = detail.getByTestId('assignee-picker');
  await expect(picker.getByTestId('assignee-candidates')).toHaveAttribute('data-state', 'failed', { timeout: 15_000 });
  await expect(picker.getByTestId('assignee-candidates')).toContainText('可指派的账号失败');
  await expect(picker.locator('[data-testid="picker-item"]')).toHaveCount(1);
  // the label picker is not taken down with it
  await expect(detail.getByTestId('label-add')).toBeEnabled();
  await picker.locator('[data-testid="picker-item"][data-name="user-1"]').click();
  await expect.poll(assigneeWrites).toEqual([['DELETE', { assignees: ['user-1'] }]]);
  await expect.poll(() => shown(page)).toEqual([]);
  await app.close();
});
