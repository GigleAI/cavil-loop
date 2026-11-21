// The view-bar numbers as the UI tests reach them (GitHub#634: a number is drawn either in the row or in the
// fold at its end — one button either way, `data-at` says where).

import type { Page } from '@playwright/test';

/** a number's button, wherever it is drawn */
export const tally = (page: Page, kind: string) => page.locator(`[data-testid="tally"][data-kind="${kind}"]`);

/** click a number wherever it is drawn: a folded one through the fold button at the end of the bar */
export async function press(page: Page, kind: string): Promise<void> {
  const b = tally(page, kind);
  if ((await b.getAttribute('data-at')) === 'fold' && !(await b.isVisible())) await page.getByTestId('tally-fold-toggle').click();
  await b.click();
}
