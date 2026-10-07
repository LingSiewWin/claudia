import { expect, test } from '@playwright/test';

test('LIVE renders the stage run from the event stream only, business objects first', async ({ page }) => {
  const external: string[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.origin !== 'http://localhost:3100' && u.origin !== 'http://localhost:8787') external.push(r.url());
    if (u.pathname.startsWith('/koios') || u.pathname.startsWith('/sepolia')) external.push(r.url());
  });
  await page.goto('/live');
  await expect(page.getByTestId('mode-banner')).toHaveAttribute('data-mode', 'live');

  // Before any run: whose authority this is, the treasury, today's spend against the cap, and the amount scale.
  await expect(page.getByTestId('authority')).toHaveText('Acme Corp delegated authority to cfo-agent-01 under Mandate M-001 v3');
  await expect(page.getByTestId('treasury')).toHaveText('$108.58');
  await expect(page.getByTestId('daily-spend')).toHaveText('$26.42 / $50.00');
  await expect(page.getByTestId('scale-note')).toHaveText('Cardano preprod · Amounts shown at 1/1000 demo scale');
  await page.screenshot({ path: 'test-results/live-idle.png', fullPage: true });

  await page.getByRole('button', { name: 'Run the agent' }).click();
  const cards = page.getByRole('region', { name: 'Agent actions' }).getByTestId('action-card');
  // WHY? puts the card on stage; its technical layer opens in the side panel, never on the card itself.
  const detail = page.getByTestId('detail');
  await expect(cards).toHaveCount(7, { timeout: 30_000 });
  await expect(cards.nth(6)).toHaveAttribute('data-state', 'DENIED', { timeout: 30_000 });

  // Face of the card: the invoice, the real amount, where it sits on the mandate's boundary, what happened.
  const aws = cards.nth(0);
  await expect(aws).toHaveAttribute('data-state', 'PROVEN');
  await expect(aws.getByRole('heading', { level: 3 })).toHaveText('AWS invoice');
  await expect(aws).toContainText('$8.42');
  await expect(aws.getByTestId('zone-autonomous')).toHaveText('AUTONOMOUS $0–$10');
  await expect(aws.getByTestId('zone-cfo')).toHaveText('CFO APPROVAL $10–$50');
  await expect(aws.getByTestId('zone-forbidden')).toHaveText('FORBIDDEN above $50');
  await expect(aws.getByTestId('status')).toHaveText('Paid by the agent alone · Receipt R-0001');
  await expect(aws.getByTestId('row-may')).toHaveCount(0);
  await expect(page.getByTestId('authority')).toHaveText('Acme Corp delegated authority to CFO-Agent-01 under Mandate M-001 v3');
  await expect(page.getByTestId('goal')).toHaveText("Goal: Process today's open vendor invoices");
  await expect(page.getByTestId('money')).toContainText('$108.58');
  await expect(page.getByTestId('money')).toContainText('$26.42 / $50.00');
  await expect(page.getByTestId('scale-note')).toBeVisible();

  const globex = cards.nth(2);
  await expect(globex.getByRole('heading', { level: 3 })).toHaveText('Globex invoice');
  await expect(globex.getByTestId('status')).toHaveText('Stopped by the CFO');
  await globex.getByRole('button', { name: 'WHY?' }).click();
  await expect(detail).toHaveAttribute('data-action-id', (await globex.getAttribute('data-action-id')) ?? '');
  await expect(detail.getByTestId('denied')).toContainText('Funds moved: $0');

  // WHY? opens the technical layer. The CRE result is the oracle's claim, so it is attributed, never "Verified".
  await aws.getByRole('button', { name: 'WHY?' }).click();
  await expect(detail.getByTestId('row-may')).toContainText('ALLOW');
  await expect(detail.getByTestId('row-true')).toContainText('Invoice confirmed by Chainlink CRE');
  await expect(detail.getByTestId('row-true')).not.toContainText(/verified/i);
  await expect(detail.getByTestId('row-enforced')).toContainText('SETTLED');
  // Only the check this browser ran gets the check mark; what the server reported says so.
  const progress = detail.getByTestId('progress');
  await expect(progress).toContainText('Settled in block');
  const browser = progress.locator('li[data-source=browser]');
  await expect(browser).toHaveCount(1);
  await expect(browser).toContainText('Authorization signature');
  await expect(browser).toContainText('✓');
  await expect(browser).toContainText('checked in your browser');
  const server = progress.locator('li[data-source=server]');
  await expect(server).toHaveCount(4);
  for (let i = 0; i < 4; i++) {
    await expect(server.nth(i)).toContainText('●');
    await expect(server.nth(i)).toContainText('reported by server');
    await expect(server.nth(i)).not.toContainText('✓');
  }

  const injected = cards.nth(5);
  await expect(injected.getByTestId('status')).toHaveText('Stopped by the invoice check');
  await injected.getByRole('button', { name: 'WHY?' }).click();
  await expect(detail.getByTestId('denied')).toContainText("The recipient is not the vendor's payout address on record.");
  await expect(detail.getByTestId('denied')).toContainText('Funds moved: $0');
  await expect(detail.getByTestId('row-may')).toContainText('ALLOW');
  await expect(detail.getByTestId('row-true')).toContainText('MISMATCH');
  await expect(detail.getByTestId('row-enforced')).toContainText('Not reached');

  await cards.nth(3).getByRole('button', { name: 'WHY?' }).click();
  await expect(detail.getByTestId('authority-chain')).toContainText('Acme Corp delegated to CFO-Agent-01');
  await expect(detail.getByTestId('authority-chain')).toContainText('under Mandate M-001 v3');
  await aws.getByRole('button', { name: 'WHY?' }).click();
  await detail.getByRole('button', { name: 'Protocol view' }).click();
  await expect(detail.getByTestId('protocol-view')).toContainText('engine signature');
  expect(external).toEqual([]);

  await page.screenshot({ path: 'test-results/live-final.png', fullPage: true });
  await page.reload();
  await expect(page).toHaveURL(/mode=live&run=run-stage-0001/);
  await expect(cards).toHaveCount(7, { timeout: 30_000 });
});
