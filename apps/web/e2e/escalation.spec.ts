import { expect, test } from '@playwright/test';

test('public authority page: price of an interruption, budget left, availability', async ({ page }) => {
  await page.goto('/authority/CFO?mandate_id=M-001');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('CFO for Mandate M-001');
  await expect(page.getByTestId('authority-price')).toHaveText('5.00 ADA');
  await expect(page.getByTestId('authority-budget')).toHaveText('1 / 3');
  await expect(page.getByTestId('authority-availability')).toHaveText('Open');
  await expect(page.getByTestId('authority-page')).toContainText('Agents reach this person only by locking a bond. A reasonable request is refunded');
  await page.screenshot({ path: 'test-results/authority-open.png', fullPage: true });

  await page.goto('/authority/CFO?mandate_id=M-LAB');
  await expect(page.getByTestId('authority-page')).toHaveAttribute('data-availability', 'budget_exhausted');
  await expect(page.getByTestId('authority-budget')).toHaveText('0 / 3');
  await expect(page.getByTestId('authority-availability')).toHaveText('Budget spent');
  await page.screenshot({ path: 'test-results/authority-exhausted.png', fullPage: true });
});

test('mandate page shows the interrupt budget next to the limits', async ({ page }) => {
  await page.goto('/mandate/M-001');
  await expect(page.getByTestId('budget-meter')).toContainText('Interrupt budget');
  await expect(page.getByTestId('budget-meter')).toContainText('2 of 3 used today');
  await expect(page.getByTestId('budget-meter')).toContainText('1 left');
  await expect(page.getByRole('link', { name: 'What it costs an agent to reach the CFO' })).toHaveAttribute('href', '/authority/CFO?mandate_id=M-001');
});

test('REPLAY: metrics strip from the recorded events, bond chips and the brief on escalated cards', async ({ page }) => {
  await page.goto('/live?mode=replay&run=run-stage-0001');
  const cards = page.getByRole('region', { name: 'Agent actions' }).getByTestId('action-card');
  await expect(cards.first()).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Skip to the end' }).click();
  await expect(cards).toHaveCount(7);

  const metrics = page.getByTestId('metrics');
  await expect(metrics).toHaveAttribute('data-source', 'replay');
  await expect(page.getByTestId('metric-interruptions')).toHaveText('28.6');
  await expect(page.getByTestId('metric-evaluated')).toContainText('7');
  await expect(page.getByTestId('metric-evaluated')).toContainText('1 allow · 2 escalate · 4 deny');
  await expect(page.getByTestId('metric-bonds')).toContainText('2 locked · 2 required · 2 refunded · 0 captured');
  await expect(page.getByTestId('metric-budget')).toHaveText('0');
  await expect(metrics).toContainText('Median human decision');

  const approved = cards.nth(1);
  await expect(approved.getByTestId('status')).toHaveText('Paid with CFO approval · Receipt R-0002');
  await expect(approved.getByTestId('bond-chip').first()).toHaveAttribute('data-status', 'refunded');
  await expect(approved.getByTestId('bond-chip').first()).toContainText('Bond refunded');
  await expect(approved.getByTestId('bond-chip').first().getByRole('link')).toHaveAttribute('href', /^https:\/\/preprod\.cardanoscan\.io\/transaction\/(b1){31}01$/);
  await approved.getByTestId('brief-details').locator('summary').click();
  await expect(approved.getByTestId('brief')).toContainText('What the engine checked');
  await expect(approved.getByTestId('will-happen')).toContainText('Release 18 USDM from vault acme-treasury');
  await expect(approved.getByTestId('budget')).toHaveText('Interrupt budget 0 of 3 used today');

  const declined = cards.nth(2);
  await expect(declined.getByTestId('status')).toHaveText('Stopped by the CFO');
  await expect(declined.getByTestId('denied')).toContainText('Declined as a reasonable ask. Bond refunded to the agent.');
  await expect(declined.getByTestId('bond-chip').first()).toHaveAttribute('data-status', 'refunded');
  await expect(cards.nth(0).getByTestId('bond-chip')).toHaveCount(0);
  await declined.getByRole('button', { name: 'WHY?' }).click();
  await expect(declined.getByTestId('row-may')).toContainText('ESCALATE');
  await expect(page.getByRole('region', { name: 'Agent actions' })).not.toContainText(/requires approval/i);
  await page.screenshot({ path: 'test-results/replay-metrics.png', fullPage: true });
});

test('REPLAY: escalation spam ends with a denial that paged nobody', async ({ page }) => {
  await page.goto('/live?mode=replay&run=run-lab-escalation_spam');
  const cards = page.getByRole('region', { name: 'Agent actions' }).getByTestId('action-card');
  await expect(cards.first()).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Skip to the end' }).click();
  await expect(cards).toHaveCount(4);
  for (let i = 0; i < 3; i++) {
    await expect(cards.nth(i).getByTestId('bond-chip').first()).toHaveAttribute('data-status', 'captured');
    await expect(cards.nth(i).getByTestId('denied')).toContainText('Declined as frivolous. Bond captured.');
  }
  const fourth = cards.nth(3);
  await expect(fourth).toHaveAttribute('data-state', 'DENIED');
  await expect(fourth.getByTestId('denied')).toContainText("The agent has used today's interrupt budget.");
  await expect(fourth.getByTestId('nobody-paged')).toHaveText('Nobody was paged.');
  await expect(fourth.getByTestId('bond-chip')).toHaveCount(0);
  await expect(page.getByTestId('metric-interruptions')).toHaveText('75');
  await expect(page.getByTestId('metric-budget')).toHaveText('1');
  await expect(page.getByTestId('metric-bonds')).toContainText('3 locked · 3 required · 0 refunded · 3 captured');
  await page.screenshot({ path: 'test-results/replay-spam.png', fullPage: true });
});

test('REPLAY: no bond stops at the 402 and the human is never reached', async ({ page }) => {
  await page.goto('/live?mode=replay&run=run-lab-no_bond');
  const cards = page.getByRole('region', { name: 'Agent actions' }).getByTestId('action-card');
  await expect(cards.first()).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Skip to the end' }).click();
  const card = cards.first();
  await expect(card).toHaveAttribute('data-state', 'ESCALATED');
  await expect(card.getByTestId('status')).toHaveText('Escalated. The agent must lock a bond before the CFO is paged');
  await expect(card.getByTestId('bond-chip')).toHaveAttribute('data-status', 'required');
  await expect(card.getByTestId('bond-chip')).toContainText('Bond required');
  await expect(card.getByTestId('bond-chip')).toContainText('5.00 ADA');
  await expect(page.getByTestId('metric-interruptions')).toHaveText('0');
  await expect(page.getByTestId('metric-bonds')).toContainText('0 locked · 1 required');
});

test('receipt shows brief_hash and the bond outcome, and Verify recomputes the brief hash', async ({ page }) => {
  await page.goto('/receipt/R-0002');
  await expect(page.getByTestId('brief-hash')).toHaveText(/^[0-9a-f]{64}$/);
  await expect(page.getByTestId('receipt-bond')).toHaveAttribute('data-status', 'refunded');
  await expect(page.getByTestId('receipt-bond')).toHaveText('Bond refunded, 5.00 ADA');
  await page.getByRole('button', { name: 'Verify independently' }).click();
  await expect(page.getByTestId('verify-result')).toHaveAttribute('data-result', 'pass');
  await expect(page.getByTestId('check-brief_hash')).toHaveAttribute('data-status', 'pass');
  await expect(page.getByTestId('receipt')).toContainText('recomputed');
  await page.screenshot({ path: 'test-results/receipt-brief.png', fullPage: true });

  await page.goto('/receipt/R-0001');
  await expect(page.getByTestId('brief-hash')).toHaveCount(0);
  await expect(page.getByTestId('receipt-bond')).toHaveCount(0);
});
