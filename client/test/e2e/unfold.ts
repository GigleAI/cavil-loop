// GitHub#591: Settings keeps its 高级 cards in a folded block at the bottom, a few less used options under each
// card's own 「高级」, and the project settings dialog folds its less used settings too. Tests about something else
// that work on those settings unfold them first, through these helpers — the way a person would, by clicking the
// fold lines. What the folds themselves do is test/e2e/settings-layout.spec.ts.

import { expect, type Page } from '@playwright/test';

async function unfold(page: Page, box: string, toggle: string): Promise<void> {
  const b = page.getByTestId(box);
  if ((await b.count()) === 0) return;
  if ((await b.first().getAttribute('data-open')) === 'false') await b.first().getByTestId(toggle).first().click();
  await expect(b.first()).toHaveAttribute('data-open', 'true');
}

/** Settings is open: unfold the 「高级设置」 block and the reminder / account cards' 「高级」. */
export async function unfoldSettings(page: Page): Promise<void> {
  await expect(page.getByTestId('settings')).toBeVisible();
  await unfold(page, 'settings-advanced', 'settings-advanced-toggle');
  await unfold(page, 'pending-card-more', 'pending-card-more-toggle');
  await unfold(page, 'account-card-more', 'account-card-more-toggle');
}

/** The local daemon card has read its status: unfold its dependency checks. */
export async function unfoldDaemonChecks(page: Page): Promise<void> {
  await unfold(page, 'daemon-card-more', 'daemon-card-more-toggle');
}

/** The project settings dialog shows its form: unfold every group's 「高级」 and the 「高级设置」 block. */
export async function unfoldConfig(page: Page): Promise<void> {
  const more = page.locator('[data-testid=config-group-more]');
  for (let i = 0; i < (await more.count()); i++) {
    const m = more.nth(i);
    if ((await m.getAttribute('data-open')) === 'false') await m.getByTestId('config-more-toggle').click();
  }
  await unfold(page, 'config-adv', 'config-adv-toggle');
}
