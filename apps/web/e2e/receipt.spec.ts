import { expect, test } from '@playwright/test';

const API = 'http://localhost:8787';

test('Verify passes on untouched evidence', async ({ page }) => {
  await page.goto('/receipt/R-0001');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('AWS invoice');
  await expect(page.getByTestId('data-source')).toContainText('Data source: Koios');
  await page.getByRole('button', { name: 'Verify independently' }).click();
  await expect(page.getByTestId('verify-result')).toHaveAttribute('data-result', 'pass');
  await expect(page.getByTestId('verify-result')).toHaveText('VERIFIED');
  for (const key of ['tx', 'metadata', 'authorization', 'receipt', 'cre']) {
    await expect(page.getByTestId(`summary-${key}`)).toHaveAttribute('data-status', 'pass');
  }
  await page.screenshot({ path: 'test-results/receipt-pass.png', fullPage: true });
});

test('Verify detects receipt fields tampered by our own API', async ({ page }) => {
  await page.route(`${API}/v1/receipts/R-0001`, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.receipt.action.ir.amount.value = '84200000';
    await route.fulfill({ response, json: body });
  });
  await page.goto('/receipt/R-0001');
  await page.getByRole('button', { name: 'Verify independently' }).click();
  await expect(page.getByTestId('verify-result')).toHaveAttribute('data-result', 'fail');
  await expect(page.getByTestId('verify-result')).toContainText('FAILED');
  await expect(page.getByTestId('summary-receipt')).toHaveAttribute('data-status', 'fail');
  await expect(page.getByTestId('check-action_hash')).toHaveAttribute('data-status', 'fail');
  await expect(page.getByTestId('check-binding')).toHaveAttribute('data-status', 'fail');
  await page.screenshot({ path: 'test-results/receipt-tampered.png', fullPage: true });
});

test('Koios relay down: "Cardano data unavailable", never "Verified"', async ({ page }) => {
  await page.route(`${API}/koios/**`, (route) => route.abort());
  await page.goto('/receipt/R-0001');
  await page.getByRole('button', { name: 'Verify independently' }).click();
  const result = page.getByTestId('verify-result');
  await expect(result).toHaveAttribute('data-result', 'unavailable');
  await expect(result).toHaveText('Cardano data unavailable. Verification cannot be completed locally.');
  await expect(page.getByRole('link', { name: 'Check the transaction on Cexplorer ↗' })).toHaveAttribute('href', /^https:\/\/preprod\.cexplorer\.io\/tx\/[0-9a-f]{64}$/);
  await expect(page.getByTestId('summary-tx')).toHaveAttribute('data-status', 'unavailable');
  await expect(page.getByTestId('receipt')).not.toContainText(/verified/i);
  await page.screenshot({ path: 'test-results/receipt-unavailable.png', fullPage: true });
});
