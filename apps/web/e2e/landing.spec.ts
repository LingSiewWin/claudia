import { expect, test } from '@playwright/test';

test('landing states the thesis, replays a real payment, and points agents and humans onward', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Agents are infinite. Human attention is not.');
  await expect(page.getByRole('link', { name: 'Watch it act' }).first()).toHaveAttribute('href', '/live?mode=replay');
  await expect(page.getByRole('link', { name: 'Read the protocol' }).first()).toHaveAttribute('href', '/protocol');
  await expect(page.getByRole('link', { name: 'Try it on Sokosumi' })).toHaveAttribute('href', 'https://preprod.sokosumi.com/');
  await expect(page.getByTestId('mode-banner')).toContainText('REPLAY — VERIFIED HISTORICAL RUN');
  await expect(page.getByTestId('action-card')).toHaveCount(1);
  await expect(page.getByTestId('action-card').getByRole('heading', { level: 3 })).toHaveText('AWS invoice');
  await expect(page.getByTestId('action-card')).toHaveAttribute('data-state', 'PROVEN', { timeout: 30_000 });
  await expect(page.getByTestId('budget-peek')).toContainText('1 of 3 interruptions left');
  await expect(page.getByRole('region', { name: 'How it works' }).getByRole('listitem')).toHaveCount(6);
  for (const o of ['ALLOW', 'ESCALATE', 'DENY']) await expect(page.getByRole('region', { name: 'Outcomes' })).toContainText(o);
  await expect(page.getByRole('link', { name: /29cd8f8ce51ee103/ })).toHaveAttribute('href', /preprod\.cardanoscan\.io\/transaction\/29cd8f8c/);
  await expect(page.locator('body')).not.toContainText(/login|sign in|pricing/i);
  await page.screenshot({ path: 'test-results/landing.png', fullPage: true });
});

test('protocol page renders the markdown source with a table of contents', async ({ page }) => {
  await page.goto('/protocol');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Authority Layer protocol');
  await expect(page.getByRole('link', { name: 'Escalation over HTTP 402' })).toHaveAttribute('href', '#escalation-over-http-402');
  await expect(page.locator('#escalation-over-http-402')).toBeVisible();
  await expect(page.locator('.doc pre')).not.toHaveCount(0);
  await page.screenshot({ path: 'test-results/protocol.png', fullPage: true });
});

test('agent-readable files are served', async ({ request }) => {
  const llms = await request.get('/llms.txt');
  expect(llms.ok()).toBe(true);
  expect(await llms.text()).toContain('# Authority Layer');
  const md = await request.get('/protocol.md');
  expect(md.headers()['content-type']).toContain('text/markdown');
  expect(await md.text()).toBe(await (await request.get('/llms-full.txt')).text());
  const card = await (await request.get('/.well-known/agent.json')).json();
  expect(card.network).toBe('cardano-preprod');
  expect(await (await request.get('/robots.txt')).text()).toContain('Allow: /');
});
