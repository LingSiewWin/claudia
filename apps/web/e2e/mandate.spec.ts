import { expect, test } from '@playwright/test';

test('mandate page draws the boundary from the mandate against the live vault', async ({ page }) => {
  await page.goto('/mandate/M-001');
  for (const [zone, name, bounds] of [
    ['autonomous', 'AUTONOMOUS', '$0–$10'],
    ['cfo', 'CFO APPROVAL', '$10–$50'],
    ['forbidden', 'FORBIDDEN', 'above $50'],
  ] as const) {
    await expect(page.getByTestId(`zone-${zone}`)).toContainText(name);
    await expect(page.getByTestId(`zone-${zone}`)).toContainText(bounds);
  }
  await expect(page.getByTestId('daily-meter')).toContainText('Daily spend');
  await expect(page.getByTestId('daily-meter')).toContainText('$26.42 / $50.00');
  await expect(page.getByTestId('treasury-meter')).toContainText('$108.58');
  await expect(page.getByTestId('treasury-meter')).toContainText('minimum $100.00 · spendable $8.58');
  await expect(page.getByTestId('scale-note')).toHaveText('Cardano preprod · Amounts shown at 1/1000 demo scale');
  await expect(page.getByTestId('anchor-status')).toContainText('Anchor version 3, active');
  await expect(page.getByTestId('anchor-status')).not.toHaveClass(/text-permit|text-forbid/);
  await page.screenshot({ path: 'test-results/mandate.png', fullPage: true });
});

test('revoked mandate collapses the rail so nobody can spend', async ({ page }) => {
  await page.goto('/mandate/M-REVOKED');
  await expect(page.getByTestId('mandate')).toContainText('Revoked. Nobody can spend under this mandate.');
  await expect(page.getByTestId('zone-autonomous')).toHaveCount(0);
  await expect(page.getByTestId('zone-cfo')).toHaveCount(0);
  await expect(page.getByTestId('zone-forbidden')).toHaveCount(0);
  await expect(page.getByTestId('anchor-status')).toContainText('Anchor version 2, revoked');
  await expect(page.getByTestId('anchor-status')).not.toHaveClass(/text-permit|text-forbid/);
});
