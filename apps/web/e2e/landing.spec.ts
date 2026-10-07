import { expect, test } from '@playwright/test';

test('landing explains, replays a real payment, and has nothing else', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Give AI agents authority, not credentials.');
  await expect(page.getByRole('link', { name: 'Watch it act' })).toHaveAttribute('href', '/live');
  await expect(page.getByRole('link', { name: 'Read the protocol' })).toHaveAttribute('href', '#protocol');
  await expect(page.getByTestId('mode-banner')).toContainText('REPLAY — VERIFIED HISTORICAL RUN');
  await expect(page.getByTestId('action-card')).toHaveCount(1);
  await expect(page.getByTestId('action-card').getByRole('heading', { level: 3 })).toHaveText('AWS invoice');
  await expect(page.getByTestId('action-card')).toHaveAttribute('data-state', 'PROVEN', { timeout: 30_000 });
  await expect(page.locator('main > section')).toHaveCount(2);
  await expect(page.locator('nav, footer')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(/login|sign in|settings|pricing/i);
  await page.screenshot({ path: 'test-results/landing.png', fullPage: true });
});
