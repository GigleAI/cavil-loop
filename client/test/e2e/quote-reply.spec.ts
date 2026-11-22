// GigleAI/cavil-loop#653: quote reply. The real window (built with --test-bridge), the real back end behind the
// loopback bridge, the local fake GitHub. "引用回复" under an entry quotes its markdown source without what a reader
// never sees (HTML comments); words selected in one entry's text are quoted instead — by that button or by R from
// inside the discussion. Both go through the one way the reply box gets new text, so a preview still on its way
// for the old text never comes back over the box.

import { test, expect, type Frame, type Page } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeGitHub } from '../fake-github/server';
import { launchApp, closeEngine, type AppEnv } from './bridge';

const PROJECT_URL = 'https://github.com/orgs/GigleAI/projects/11';
const REPO = 'GigleAI/cavil-loop';
const N = 139;
const KEY = `gigleai/cavil-loop#${N}`;

// a comment the way the loop writes them: words, a hidden marker of its own, a usage fold with its hidden record
// (the marker is emptied; the record under the fold's closing tag goes with its line)
const LOOP_SOURCE = [
  '## 方案已更新',
  '',
  '第一段正文。',
  '',
  '<!-- agent-blocked-by: #12 resume=pending/agent -->',
  '',
  '- 一条',
  '- 两条',
  '',
  '---',
  '<details><summary>⏱️ 耗时：1m 0s</summary>',
  '',
  '- 开始 07:00',
  '',
  '</details>',
  '<!-- agent-metrics agent=claude wall_secs=60 -->',
].join('\n');
const LOOP_QUOTED = [
  '> ## 方案已更新',
  '>',
  '> 第一段正文。',
  '>',
  // the marker between two blocks is emptied, not deleted: nothing around it can join or change
  '> <!-- -->',
  '>',
  '> - 一条',
  '> - 两条',
  '>',
  '> ---',
  '> <details><summary>⏱️ 耗时：1m 0s</summary>',
  '>',
  '> - 开始 07:00',
  '>',
  '> </details>',
].join('\n');

let env: AppEnv;
test.beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cavil-e2e-'));
  env = { fake: await startFakeGitHub(), userData: join(dir, 'userData'), cred: join(dir, 'cred'), opened: join(dir, 'opened.txt'), requests: join(dir, 'requests.txt') };
});
test.afterEach(async () => {
  await env.fake.close();
});
test.afterAll(closeEngine);

async function signIn(page: Page) {
  await page.getByTestId('oauth-settings-toggle').click();
  await page.getByTestId('client-id').fill(env.fake.state.oauthClientId);
  await page.getByTestId('save-client-id').click();
  await page.getByTestId('start-login').click();
  await expect(page.getByTestId('user-code')).toBeVisible();
  env.fake.resolveGrant('approved');
  await expect(page.getByTestId('board')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('open-settings').click();
  for (const s of [PROJECT_URL, REPO]) {
    await page.getByTestId('source-input').fill(s);
    await page.getByTestId('source-add').click();
  }
  await page.getByTestId('back').click();
  await page.keyboard.press('Control+Shift+2');
}

async function frameOf(page: Page): Promise<Frame> {
  return (await page.getByTestId('timeline-frame').elementHandle())!.contentFrame() as Promise<Frame>;
}

/** select `words` inside the text block of entry `id` (or from one entry's block into another's) */
async function select(frame: Frame, from: { id: string; words: string }, to?: { id: string; words: string }) {
  await frame.evaluate(
    ([a, z]) => {
      const at = (p: { id: string; words: string }) => {
        const md = document.querySelector(`details.entry[data-entry="${p.id}"] .md`)!;
        const walk = document.createTreeWalker(md, NodeFilter.SHOW_TEXT);
        for (let n = walk.nextNode(); n; n = walk.nextNode()) {
          const i = n.textContent!.indexOf(p.words);
          if (i >= 0) return { n, i };
        }
        throw new Error(`no "${p.words}" in ${p.id}`);
      };
      const s = at(a);
      const e = z ? at(z) : s;
      const r = document.createRange();
      r.setStart(s.n, s.i);
      r.setEnd(e.n, e.i + (z ?? a).words.length);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(r);
    },
    [from, to ?? null] as const,
  );
}

test('GitHub#653: 引用回复 quotes an entry without its hidden markers, or the words selected in it; R quotes a selection; a late preview never covers the box; offline it is off', async () => {
  env.fake.state.w.bodySources.set(KEY, '正文的话 <!-- hidden in the body -->');
  env.fake.state.w.comments.set(KEY, [
    { id: 'C-loop', url: `https://github.com/${REPO}/issues/${N}#c1`, createdAt: '2026-11-02T01:00:00Z', bodyHTML: '', body: LOOP_SOURCE, author: { login: 'user-3' } },
    { id: 'C-plain', url: `https://github.com/${REPO}/issues/${N}#c2`, createdAt: '2026-11-02T02:00:00Z', bodyHTML: '', body: '另一条评论：只想回应这一句。还有别的话。', author: { login: 'user-4' } },
    // PR #659 code review round 1, problem 4: words that look like markdown, shown as plain words
    { id: 'C-md', url: `https://github.com/${REPO}/issues/${N}#c4`, createdAt: '2026-11-02T00:30:00Z', bodyHTML: '', body: '看 \\[draft\\](notes.md) 和 \\*\\*ready\\*\\* 两处 @luosky #12', author: { login: 'user-4' } },
    // rendered only, no source read: nothing to quote whole, so no button
    { id: 'C-html', url: `https://github.com/${REPO}/issues/${N}#c3`, createdAt: '2026-11-02T03:00:00Z', bodyHTML: '<p>只有渲染结果</p>', author: { login: 'user-4' } },
  ]);
  const { page } = await launchApp(env);
  await signIn(page);
  const row = page.locator(`[data-testid="row"][data-key="${KEY}"] [data-testid="title-cell"]`).first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click();
  const detail = page.getByTestId('detail');
  await expect(page.getByTestId('timeline-frame')).toHaveAttribute('data-ready', 'yes', { timeout: 15_000 });
  await detail.getByTestId('unfold-toggle').click();
  const frameLoc = page.frameLocator('[data-testid="timeline-frame"]');
  await expect(frameLoc.locator('details.entry[open]')).toHaveCount(5);
  const frame = await frameOf(page);
  const reply = detail.getByTestId('reply-input');
  const quoteBtn = (id: string) => frameLoc.locator(`details.entry[data-entry="${id}"] button[data-quote]`);
  /** the keyboard into the discussion (a click on an entry's text: its summary would fold it) */
  const intoFrame = () => frameLoc.locator(`details.entry[data-entry="C-plain"] .md`).click();
  const caretAtEnd = () => reply.evaluate((el: HTMLTextAreaElement) => el.selectionStart === el.value.length && el.selectionEnd === el.value.length);

  // ---- 1. which entries have the button: those whose source was read and has something visible ----
  await expect(quoteBtn('C-loop')).toHaveText('引用回复');
  await expect(quoteBtn('C-plain')).toBeEnabled();
  await expect(quoteBtn('C-html')).toHaveCount(0);
  const bodyId = await frame.evaluate(() => document.querySelector('details.entry.body')!.getAttribute('data-entry')!);
  await expect(quoteBtn(bodyId)).toBeEnabled();

  // ---- 2. the button, nothing selected: the source, its hidden markers out, the visible usage fold kept ----
  await quoteBtn('C-loop').click();
  await expect(reply).toHaveValue(`${LOOP_QUOTED}\n\n`);
  await expect(reply).toBeFocused();
  expect(await caretAtEnd()).toBe(true);
  // typing goes on after it; a second quote goes after that, one blank line between
  await page.keyboard.type('同意。');
  await quoteBtn(bodyId).click();
  await expect(reply).toHaveValue(`${LOOP_QUOTED}\n\n同意。\n\n> 正文的话 <!-- -->\n\n`);
  await reply.fill('');

  // ---- 3. words selected in one entry: R from inside the discussion quotes just them ----
  await intoFrame();
  await select(frame, { id: 'C-plain', words: '只想回应这一句。' });
  await page.keyboard.press('r');
  await expect(reply).toHaveValue('> 只想回应这一句。\n\n');
  await expect(reply).toBeFocused();
  expect(await caretAtEnd()).toBe(true);
  await reply.fill('');

  // ---- 4. words selected, then that entry's own button (a real press): just them ----
  await select(frame, { id: 'C-loop', words: '第一段正文。' });
  await quoteBtn('C-loop').click();
  await expect(reply).toHaveValue('> 第一段正文。\n\n');
  await reply.fill('');
  // selected in another entry: the button quotes its own entry whole
  await select(frame, { id: 'C-plain', words: '还有别的话。' });
  await quoteBtn(bodyId).click();
  await expect(reply).toHaveValue('> 正文的话 <!-- -->\n\n');
  await reply.fill('');

  // ---- 5. a selection across two entries: R only goes to the box, nothing is quoted ----
  await intoFrame();
  await select(frame, { id: 'C-plain', words: '还有别的话。' }, { id: 'C-loop', words: '第一段正文。' });
  await page.keyboard.press('r');
  await expect(reply).toBeFocused();
  await page.waitForTimeout(300);
  await expect(reply).toHaveValue('');
  // and nothing selected: R only goes to the box, as before
  await intoFrame();
  await frame.evaluate(() => window.getSelection()!.removeAllRanges());
  await page.keyboard.press('r');
  await expect(reply).toBeFocused();
  await page.waitForTimeout(300);
  await expect(reply).toHaveValue('');

  // ---- 6. a preview shown: a quote goes back to editing ----
  await reply.fill('先写的话');
  await detail.getByTestId('reply-preview-toggle').click();
  await expect(detail.getByTestId('reply-preview')).toBeVisible({ timeout: 15_000 });
  await quoteBtn('C-plain').click();
  await expect(detail.getByTestId('reply-preview')).toHaveCount(0);
  await expect(reply).toHaveValue('先写的话\n\n> 另一条评论：只想回应这一句。还有别的话。\n\n');
  await reply.fill('');

  // ---- 7. a preview still on its way: held, a quote goes in, then the answer comes — it is not shown ----
  for (const how of ['button', 'r'] as const) {
    await reply.fill(`旧的话 ${how}`);
    const release = env.fake.hold('/api/markdown');
    const asked = env.fake.log.length;
    await detail.getByTestId('reply-preview-toggle').click();
    await expect.poll(() => env.fake.log.slice(asked).some((l) => l.path === '/api/markdown')).toBe(true);
    if (how === 'button') {
      await quoteBtn('C-plain').click();
    } else {
      await intoFrame();
      await select(frame, { id: 'C-plain', words: '只想回应这一句。' });
      await page.keyboard.press('r');
    }
    const want = how === 'button' ? `旧的话 ${how}\n\n> 另一条评论：只想回应这一句。还有别的话。\n\n` : `旧的话 ${how}\n\n> 只想回应这一句。\n\n`;
    await expect(reply).toHaveValue(want);
    release();
    // the answer has had time to land: it was dropped, the box keeps the keyboard and the quote
    await page.waitForTimeout(1000);
    await expect(detail.getByTestId('reply-preview')).toHaveCount(0);
    await expect(reply).toBeFocused();
    await expect(reply).toHaveValue(want);
    await reply.fill('');
  }

  // ---- 7b. selected words that look like markdown: quoted so that they show exactly as selected, by both ways in ----
  env.fake.state.w.markdownRender = true;
  const SHOWN = '[draft](notes.md) 和 **ready** 两处 @luosky #12';
  await expect(frameLoc.locator('details.entry[data-entry="C-md"] .md')).toContainText(SHOWN);
  const ESCAPED = '> \\[draft\\]\\(notes\\.md\\) 和 \\*\\*ready\\*\\* 两处 \\@luosky \\#12\n\n';
  for (const how of ['r', 'button'] as const) {
    await frameLoc.locator('details.entry[data-entry="C-md"] .md').click();
    await select(frame, { id: 'C-md', words: SHOWN });
    if (how === 'r') await page.keyboard.press('r');
    else await quoteBtn('C-md').click();
    await expect(reply).toHaveValue(ESCAPED);
    await detail.getByTestId('reply-preview-toggle').click();
    const preview = page.frameLocator('[data-testid="reply-preview"]');
    await expect(preview.locator('blockquote')).toHaveText(SHOWN, { timeout: 15_000 });
    await expect(preview.locator('a, strong, em, code')).toHaveCount(0);
    await detail.getByTestId('reply-preview-toggle').click();
    await reply.fill('');
  }
  env.fake.state.w.markdownRender = false;

  // ---- 8. offline: the button is off and says why; R with a selection does not touch the box ----
  env.fake.state.offline = true;
  await page.getByTestId('refresh').press('Enter');
  await expect(page.getByTestId('offline')).toBeVisible({ timeout: 15_000 });
  await expect(reply).toBeDisabled();
  await expect(quoteBtn('C-plain')).toBeDisabled({ timeout: 10_000 });
  await expect(quoteBtn('C-plain')).toHaveAttribute('title', '离线或有操作在途时不能回复');
  await intoFrame();
  await select(frame, { id: 'C-plain', words: '只想回应这一句。' });
  await page.keyboard.press('r');
  await page.waitForTimeout(300);
  await expect(reply).toHaveValue('');
});
