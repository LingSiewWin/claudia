import { expect, test } from '@playwright/test';

test('landing states the thesis, replays a real payment, and points agents and humans onward', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Agents are infinite. Human attention is not.');
  await expect(page.getByRole('link', { name: 'Watch it act' }).first()).toHaveAttribute('href', '/live?mode=replay');
  await expect(page.getByRole('link', { name: 'Read the protocol' }).first()).toHaveAttribute('href', '/protocol');
  await expect(page.getByRole('link', { name: 'Try it on Sokosumi' })).toHaveAttribute('href', 'https://preprod.sokosumi.com/');
  // The hero floor replays the recorded escalation-spam run: every crate move comes from the reducer, so the first
  // frivolous escalation ends in the sink with its bond captured and the human step marked declined.
  const banner = page.getByTestId('mode-banner');
  await expect(banner).toHaveAttribute('data-mode', 'replay');
  await expect(banner).toContainText('REPLAY —');
  await expect(banner).toContainText('No transactions are being submitted.');
  const floor = page.getByTestId('floor');
  await expect(floor.getByTestId('floor-crate').first()).toBeVisible();
  await expect(floor.getByTestId('floor-beam')).toHaveAttribute('data-state', 'scanning', { timeout: 15_000 });
  await expect(floor.getByTestId('floor-brief')).toHaveAttribute('data-state', 'open', { timeout: 20_000 });
  await expect(floor.locator('[data-testid=floor-crate][data-station=sink]').first()).toBeVisible({ timeout: 20_000 });
  await expect(floor.locator('[data-testid=floor-steps] li[data-step=human]')).toHaveAttribute('data-status', 'failed');
  await expect(floor.locator('[data-testid=floor-steps] li[data-step=bond]')).toContainText('bond captured');
  await expect(floor.getByTestId('metric-bonds')).toContainText('1 captured');
  await expect(page.getByTestId('budget-peek')).toContainText('1 of 3 interruptions left');
  await expect(page.getByRole('region', { name: 'How it works' }).getByRole('listitem')).toHaveCount(6);
  for (const o of ['ALLOW', 'ESCALATE', 'DENY']) await expect(page.getByRole('region', { name: 'Outcomes' })).toContainText(o);
  await expect(page.getByRole('link', { name: /29cd8f8ce51ee103/ })).toHaveAttribute('href', /preprod\.cardanoscan\.io\/transaction\/29cd8f8c/);
  await expect(page.locator('body')).not.toContainText(/login|sign in|pricing/i);
  await page.screenshot({ path: 'test-results/landing.png', fullPage: true });
});

test('protocol page renders the markdown source with a table of contents', async ({ page }) => {
  await page.goto('/protocol');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Claudia protocol');
  await expect(page.getByRole('link', { name: 'Escalation over HTTP 402' })).toHaveAttribute('href', '#escalation-over-http-402');
  await expect(page.locator('#escalation-over-http-402')).toBeVisible();
  await expect(page.locator('.doc pre')).not.toHaveCount(0);
  await page.screenshot({ path: 'test-results/protocol.png', fullPage: true });
});

test('agent-readable files are served', async ({ request }) => {
  const llms = await request.get('/llms.txt');
  expect(llms.ok()).toBe(true);
  expect(await llms.text()).toContain('# Claudia');
  const md = await request.get('/protocol.md');
  expect(md.headers()['content-type']).toContain('text/markdown');
  expect(await md.text()).toBe(await (await request.get('/llms-full.txt')).text());
  const card = await (await request.get('/.well-known/agent.json')).json();
  expect(card.network).toBe('cardano-preprod');
  expect(await (await request.get('/robots.txt')).text()).toContain('Allow: /');
});
