import { expect, test } from '@playwright/test';

// Runs only with E2E_BASE_URL (deployed web) and E2E_API_BASE_URL (Railway API). Real chains, real evidence.
const API = process.env.E2E_API_BASE_URL ?? '';

test('@real REPLAY of the latest real stage run makes no external calls beyond stored events (H4)', async ({ page, baseURL }) => {
  const origin = new URL(baseURL ?? '').origin;
  const seen: string[] = [];
  await page.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (u.origin === origin) return route.continue();
    const allowed = u.origin === API && (u.pathname === '/v1/runs' || /^\/v1\/runs\/[^/]+\/log$/.test(u.pathname));
    seen.push(`${u.origin}${u.pathname}${allowed ? '' : ' BLOCKED'}`);
    return allowed ? route.continue() : route.abort();
  });
  await page.goto('/live?mode=replay');
  await expect(page.getByTestId('mode-banner')).toContainText('REPLAY — VERIFIED HISTORICAL RUN');
  await expect(page.getByTestId('mode-banner')).toContainText('No transactions are being submitted.');
  await expect(page.getByTestId('action-card').first()).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Skip to the end' }).click();
  await expect(page.locator('[data-testid=action-card][data-state=PROVEN]').first()).toBeVisible();
  await page.screenshot({ path: 'test-results/real-replay.png', fullPage: true });
  expect(seen.filter((s) => s.endsWith('BLOCKED'))).toEqual([]);
});

test('@real browser Verify passes on a real receipt and fails when our API tampers with it (H3)', async ({ page, request }) => {
  const { receipts } = (await (await request.get(`${API}/v1/receipts?mandate_id=M-001`)).json()) as { receipts: Array<{ receipt_id: string }> };
  const id = receipts[0]?.receipt_id;
  expect(id).toBeTruthy();
  await page.goto(`/receipt/${id}`);
  await page.getByRole('button', { name: 'Verify independently' }).click();
  await expect(page.getByTestId('verify-result')).toHaveAttribute('data-result', 'pass', { timeout: 30_000 });
  await expect(page.getByTestId('data-source')).toHaveText('Data source: Koios (relayed through Vercel)');
  await page.screenshot({ path: 'test-results/real-receipt-pass.png', fullPage: true });

  await page.route(`${API}/v1/receipts/${id}`, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.authorization.fields.recipient = 'addr_test1vrpu8s7rc0pu8s7rc0pu8s7rc0pu8s7rc0pu8s7rc0pu8sclmre6l';
    await route.fulfill({ response, json: body });
  });
  await page.reload();
  await page.getByRole('button', { name: 'Verify independently' }).click();
  await expect(page.getByTestId('verify-result')).toHaveAttribute('data-result', 'fail', { timeout: 30_000 });
  await expect(page.getByTestId('check-engine_signature')).toHaveAttribute('data-status', 'fail');
  await page.screenshot({ path: 'test-results/real-receipt-tampered.png', fullPage: true });
});

test('@real mandate page reads the real anchor and vault', async ({ page }) => {
  await page.goto('/mandate/M-001');
  await expect(page.getByTestId('anchor-status')).toContainText('Anchor version');
  await expect(page.getByTestId('treasury-meter')).toContainText('minimum $100.00');
  await page.screenshot({ path: 'test-results/real-mandate.png', fullPage: true });
});
