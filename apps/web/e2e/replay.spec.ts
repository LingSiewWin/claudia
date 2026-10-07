import { type Page, expect, test } from '@playwright/test';

const API = 'http://localhost:8787';
const BANNER = {
  verified: 'REPLAY — VERIFIED HISTORICAL RUN',
  through: (n: number) => `REPLAY — VERIFIED THROUGH EVENT ${n} · LATER EVENTS NOT ANCHORED`,
  unanchored: 'REPLAY — RECORDED RUN · INTEGRITY CHECKED, NOT ANCHORED',
  failed: 'REPLAY — EVIDENCE LOG FAILED VERIFICATION',
};

interface StoredLog {
  run: { kind: string; started_at: string };
  events: Array<{ type: string; payload: { action?: { amount: { value: string } } } }>;
  anchor: unknown;
}

/** Serve the real stored log with one change, as a tampering or misbehaving server would. */
async function serveLog(page: Page, edit: (log: StoredLog) => void) {
  await page.route(/\/v1\/runs\/[^/]+\/log$/, async (route) => {
    const response = await route.fetch();
    const log = (await response.json()) as StoredLog;
    edit(log);
    await route.fulfill({ response, json: log });
  });
}

test('REPLAY loads only the stored log and the on-chain anchor, and still plays when the anchor is unreachable', async ({ page }) => {
  const seen: string[] = [];
  await page.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (u.origin === 'http://localhost:3100') return route.continue();
    const allowed = u.origin === API && (u.pathname === '/v1/runs' || /^\/v1\/runs\/[^/]+\/log$/.test(u.pathname));
    seen.push(`${route.request().method()} ${u.origin}${u.pathname}${allowed ? '' : ' BLOCKED'}`);
    return allowed ? route.continue() : route.abort();
  });
  await page.goto('/live?mode=replay');
  const banner = page.getByTestId('mode-banner');
  await expect(banner).toHaveAttribute('data-mode', 'replay');
  await expect(banner).toContainText(BANNER.unanchored);
  await expect(banner).not.toContainText('VERIFIED');
  await expect(banner).toContainText('Recorded execution 2026-10-07 03:00:00 UTC.');
  await expect(banner).toContainText('No transactions are being submitted.');
  await expect(page.getByTestId('action-card').first()).toBeVisible();
  await page.getByRole('button', { name: 'Skip to the end' }).click();
  await expect(page.getByTestId('action-card')).toHaveCount(7);
  await expect(page.locator('[data-testid=action-card][data-state=PROVEN]')).toHaveCount(2);
  await expect(page.locator('[data-testid=action-card][data-state=DENIED]')).toHaveCount(5);
  await page.screenshot({ path: 'test-results/replay-final.png', fullPage: true });
  // The closing anchor first, then the latest settlement: both chain reads are blocked here.
  expect(seen).toEqual([
    `GET ${API}/v1/runs`,
    `GET ${API}/v1/runs/run-stage-0001/log`,
    `POST ${API}/koios/tx_info BLOCKED`,
    `POST ${API}/koios/tx_info BLOCKED`,
  ]);
});

test('REPLAY of a finished run with a closing anchor is a verified historical run, dated by its own evidence', async ({ page }) => {
  // The run summary is a server claim; the date must come from the hashed RunStarted event.
  await serveLog(page, (log) => {
    log.run.started_at = '2020-01-01T00:00:00.000Z';
  });
  await page.goto('/live?mode=replay&run=run-stage-0001');
  const banner = page.getByTestId('mode-banner');
  await expect(banner).toContainText(BANNER.verified);
  await expect(banner).toContainText('All evidence is from a real execution.');
  await expect(banner).toContainText('Recorded execution 2026-10-07 03:00:00 UTC.');
  await expect(banner).not.toContainText('2020-01-01');
  await page.getByRole('button', { name: 'Skip to the end' }).click();
  await expect(page.getByTestId('action-card')).toHaveCount(7);
  await expect(page.locator('[data-testid=action-card][data-state=PROVEN]')).toHaveCount(2);
  await expect(page.getByTestId('not-anchored')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/replay-verified.png', fullPage: true });
});

test('REPLAY without the closing anchor is verified only through the head its settlement committed', async ({ page }) => {
  await serveLog(page, (log) => {
    log.anchor = null;
  });
  await page.goto('/live?mode=replay&run=run-stage-0001');
  const banner = page.getByTestId('mode-banner');
  await expect(banner).toContainText(BANNER.through(30));
  await expect(banner).not.toContainText(BANNER.verified);
  await page.getByRole('button', { name: 'Skip to the end' }).click();
  const cards = page.getByTestId('action-card');
  await expect(cards).toHaveCount(7);
  await expect(cards.nth(0).getByTestId('not-anchored')).toHaveCount(0);
  await expect(cards.nth(0)).not.toHaveAttribute('data-unanchored');
  for (let i = 1; i < 7; i++) {
    await expect(cards.nth(i)).toHaveAttribute('data-unanchored', 'true');
    await expect(cards.nth(i).getByTestId('not-anchored')).toHaveText('not anchored');
  }
  await page.screenshot({ path: 'test-results/replay-verified-through.png', fullPage: true });
});

test('REPLAY never gives the full banner to a log a server cut short after a settlement', async ({ page }) => {
  // Cut after the first receipt, closing anchor still named: its committed head is not in the log.
  await serveLog(page, (log) => {
    log.events = log.events.slice(0, 13);
  });
  await page.goto('/live?mode=replay&run=run-stage-0001');
  const banner = page.getByTestId('mode-banner');
  await expect(banner).toContainText(BANNER.failed);
  await page.waitForTimeout(1_000);
  await expect(page.getByTestId('action-card')).toHaveCount(0);

  // Same cut with the closing anchor dropped: only the settlement's pre-submit head is anchored.
  await page.unrouteAll();
  await serveLog(page, (log) => {
    log.events = log.events.slice(0, 13);
    log.anchor = null;
  });
  await page.goto('/live?mode=replay&run=run-stage-0001');
  await expect(banner).toContainText(BANNER.through(9));
  await expect(banner).not.toContainText(BANNER.verified);
});

test('REPLAY plays nothing when one stored event was edited', async ({ page }) => {
  await serveLog(page, (log) => {
    const proposal = log.events.find((e) => e.type === 'ActionProposed');
    if (proposal?.payload.action) proposal.payload.action.amount.value = '84200000';
  });
  await page.goto('/live?mode=replay&run=run-stage-0001');
  const banner = page.getByTestId('mode-banner');
  await expect(banner).toContainText(BANNER.failed);
  await expect(banner).not.toContainText('All evidence is from a real execution.');
  await page.waitForTimeout(2_000);
  await expect(page.getByTestId('action-card')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Skip to the end' })).toHaveCount(0);
  await page.screenshot({ path: 'test-results/replay-failed.png', fullPage: true });
});

test('REPLAY plays nothing when the server answers with another run', async ({ page }) => {
  // An authentic, anchored log, but not the run the page asked for.
  await page.route(/\/v1\/runs\/run-lab-recipient_swap\/log$/, async (route) => {
    const response = await route.fetch({ url: `${API}/v1/runs/run-stage-0001/log` });
    await route.fulfill({ response });
  });
  await page.goto('/live?mode=replay&run=run-lab-recipient_swap');
  await expect(page.getByTestId('mode-banner')).toContainText(BANNER.failed);
  await page.waitForTimeout(1_000);
  await expect(page.getByTestId('action-card')).toHaveCount(0);
});

test('REPLAY takes the chain-start rule from the run identity, never from the server', async ({ page }) => {
  // The stage run starts the evidence chain. A server that relabels it and drops its first events must not pass.
  await serveLog(page, (log) => {
    log.run.kind = 'lab';
    log.events = log.events.slice(4);
  });
  await page.goto('/live?mode=replay&run=run-stage-0001');
  await expect(page.getByTestId('mode-banner')).toContainText(BANNER.failed);
  await page.waitForTimeout(1_000);
  await expect(page.getByTestId('action-card')).toHaveCount(0);

  // An Attack Lab run starts mid-chain: it plays without the genesis rule, anchored by its closing transaction.
  await page.unrouteAll();
  await page.goto('/live?mode=replay&run=run-lab-recipient_swap');
  await expect(page.getByTestId('mode-banner')).toContainText(BANNER.verified);
  await expect(page.getByTestId('action-card').first()).toBeVisible();
});

test('LIVE and REPLAY are never visually identical', async ({ page }) => {
  await page.goto('/live');
  const surface = () => page.locator('div[data-mode]').first().evaluate((el) => getComputedStyle(el).backgroundColor);
  const live = await surface();
  await page.getByRole('radio', { name: 'REPLAY' }).click();
  await expect(page.getByTestId('mode-banner')).toHaveAttribute('data-mode', 'replay');
  expect(await surface()).not.toBe(live);
});
