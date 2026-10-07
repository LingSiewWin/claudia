import { expect, test } from '@playwright/test';

test('landing states the thesis, replays a real payment, and points agents and humans onward', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Give your agents an allowance, not your keys.');
  await expect(page.getByRole('region', { name: 'Thesis' })).toContainText('only your signature moves the money');
  for (const p of ['Allowance', 'Ask', 'Sign']) await expect(page.getByRole('region', { name: 'Thesis' })).toContainText(p);
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
  await expect(floor.getByTestId('floor-crate').first()).toBeVisible({ timeout: 15_000 });
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
  const facts = page.getByRole('region', { name: 'Facts come from Chainlink CRE' });
  await expect(facts.getByRole('listitem')).toHaveCount(3);
  await expect(facts.getByRole('link', { name: 'Invoice report on Sepolia' })).toHaveAttribute('href', 'https://sepolia.etherscan.io/tx/0x68bdc690cf4338f3009f59487ceeaba4ff8a57f237b044be06a5a21abdcdfd98');
  await expect(facts.getByRole('link', { name: 'FX basis report on Sepolia' })).toHaveAttribute('href', 'https://sepolia.etherscan.io/tx/0x2549899d0f1884b944320919279ce0ce98539aeaa761b9a210bde332071b78a8');
  await expect(page.locator('body')).not.toContainText(/login|sign in|pricing/i);
  await page.screenshot({ path: 'test-results/landing.png', fullPage: true });
});

test('the header switch opens the agent reader: four file links, a curl line, five facts, nothing inlined; the footer keeps GitHub and Sokosumi', async ({ page }) => {
  await page.goto('/');
  const tabs = page.getByRole('tablist', { name: 'Reader' });
  await expect(tabs.getByRole('tab', { name: 'Human' })).toHaveAttribute('aria-selected', 'true');
  await tabs.getByRole('tab', { name: 'Agent' }).click();
  await expect(page).toHaveURL(/\?mode=agent$/);
  await expect(tabs.getByRole('tab', { name: 'Agent' })).toHaveAttribute('aria-selected', 'true');
  const surface = page.getByTestId('agent-surface');
  for (const p of ['/llms.txt', '/llms-full.txt', '/.well-known/agent.json', '/openapi.json']) await expect(surface.getByRole('link', { name: p })).toHaveAttribute('href', p);
  await expect(surface).toContainText('curl -s https://claudiahq.vercel.app/llms.txt');
  await expect(surface.getByRole('button', { name: 'Copy curl example' })).toBeVisible();
  await expect(surface.getByRole('list', { name: 'Facts' }).getByRole('listitem')).toHaveCount(5);
  for (const t of ['ALLOW, ESCALATE or DENY', 'HTTP 402', '5 ADA bond', '1 tUSDM', 'POST /v1/authority/check']) await expect(surface).toContainText(t);
  // The files are not dumped inline: a link opens the raw file.
  await expect(surface.locator('pre')).toHaveCount(0);
  await expect(surface).not.toContainText('# Claudia');
  await expect(page.getByTestId('floor')).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Built with' })).toHaveCount(0);
  await page.screenshot({ path: 'test-results/landing-agent.png', fullPage: true });
  await expect(page.locator('footer').getByRole('link', { name: 'GitHub' })).toHaveAttribute('href', 'https://github.com/LingSiewWin/claudia');
  await expect(page.locator('footer').getByRole('link', { name: 'Sokosumi' })).toHaveAttribute('href', 'https://preprod.sokosumi.com/');
  await expect(page.locator('footer')).not.toContainText('/llms.txt');
  // Persisted: a plain visit to / reopens the agent reader until Human is chosen.
  await page.goto('/');
  await expect(page).toHaveURL(/\?mode=agent$/);
  await tabs.getByRole('tab', { name: 'Human' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('floor')).toBeVisible();
});

test('/ answers agents with llms.txt as text/plain and browsers with HTML', async ({ request }) => {
  const llms = await (await request.get('/llms.txt')).text();
  for (const headers of [{ accept: 'text/plain' }, { accept: 'text/markdown, */*;q=0.1' }, { 'user-agent': 'GPTBot/1.0', accept: 'text/html,*/*' }, { 'user-agent': 'ClaudeBot/1.0' }]) {
    const res = await request.get('/', { headers });
    expect(res.headers()['content-type'], JSON.stringify(headers)).toContain('text/plain');
    expect(await res.text(), JSON.stringify(headers)).toBe(llms);
  }
  const html = await request.get('/', { headers: { accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'user-agent': 'Mozilla/5.0 Chrome/130' } });
  expect(html.headers()['content-type']).toContain('text/html');
  expect(await html.text()).toContain('Give your agents an allowance');
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
