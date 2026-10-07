import { type Page, expect, test } from '@playwright/test';

/** Recorded fixture payment approver. Revoke and update use a different admin key. */
const APPROVER_PKH = '8b218424ad74df25d35c2ea8e094a4c5c5aeb2cbb442419331569313';
const ADMIN_PKH = '44'.repeat(28);
const APPROVER_HEX = `00${APPROVER_PKH}${'cd'.repeat(28)}`;
const ADMIN_HEX = `00${ADMIN_PKH}${'ab'.repeat(28)}`;
const OTHER_HEX = `60${'42'.repeat(28)}`;
const WITNESS = 'a10081825820' + '11'.repeat(32) + '5840' + '22'.repeat(64);
const DATA_SIG = { signature: '845846a201276761646472657373' + '33'.repeat(16), key: 'a40101032720062158' + '44'.repeat(32) };
const DECLINE_PAYLOAD = Buffer.from('{"approval_id":"AP-A-0002","decision":"decline","reason":"legitimate"}', 'utf8').toString('hex');

/**
 * A CIP-30 wallet stub injected before page scripts run. `decline` makes signTx throw TxSignError UserDeclined (2).
 * signData records (addr, payload) and returns a fixed DataSignature.
 */
async function fakeWallet(page: Page, addressHex: string, decline = false) {
  await page.addInitScript(
    ({ addressHex, witness, dataSig, decline }) => {
      const calls: Array<{ tx: string; partial: boolean | undefined }> = [];
      const dataCalls: Array<{ addr: string; payload: string }> = [];
      Object.assign(window, {
        __signCalls: calls,
        __dataCalls: dataCalls,
        cardano: {
          lace: {
            name: 'Lace',
            icon: '',
            apiVersion: '1',
            enable: async () => ({
              getNetworkId: async () => 0,
              getUsedAddresses: async () => [addressHex],
              getChangeAddress: async () => addressHex,
              signTx: async (tx: string, partial?: boolean) => {
                calls.push({ tx, partial });
                if (decline) throw { code: 2, info: 'user declined' };
                return witness;
              },
              signData: async (addr: string, payload: string) => {
                dataCalls.push({ addr, payload });
                return dataSig;
              },
            }),
          },
        },
      });
    },
    { addressHex, witness: WITNESS, dataSig: DATA_SIG, decline },
  );
}

/** The recorded mandate has no admin key yet. This stubs the field the console reads for revoke and update. */
async function withAdminKey(page: Page, adminPkh: string) {
  await page.route(/\/v1\/mandates\/M-001$/, async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    const res = await route.fetch();
    const body = await res.json();
    body.mandate.principal.cardano_key_hash = adminPkh;
    await route.fulfill({ status: res.status(), json: body });
  });
}

test('CFO approves once: wallet partially signs the unsigned release tx and the witness goes back to the API', async ({ page }) => {
  await fakeWallet(page, APPROVER_HEX);
  await page.goto('/console');
  await expect(page.getByTestId('scale-note')).toHaveText('Cardano preprod · Amounts shown at 1/1000 demo scale');
  await page.getByRole('button', { name: 'Connect Lace' }).click();
  await expect(page.getByTestId('wallet-status')).toHaveAttribute('data-cfo', 'true');
  await expect(page.getByTestId('wallet-status')).toHaveAttribute('data-admin', 'false');
  await expect(page.getByTestId('wallet-status')).not.toHaveClass(/text-permit|text-forbid/);
  const approval = page.getByTestId('approval').first();
  await expect(approval.getByRole('heading', { level: 3 })).toHaveText('AWS invoice');
  await expect(approval).toContainText('$18.00');
  const approveReq = page.waitForRequest((r) => r.url().endsWith('/v1/approvals/AP-A-0002/approve') && r.method() === 'POST');
  const execReq = page.waitForRequest((r) => r.url().endsWith('/v1/executions') && r.method() === 'POST');
  await approval.getByRole('button', { name: 'Approve once' }).click();
  await approveReq;
  const body = (await execReq).postDataJSON() as { approval_id: string; cfo_witness_cbor: string; authorization_digest: string };
  expect(body.approval_id).toBe('AP-A-0002');
  expect(body.cfo_witness_cbor).toBe(WITNESS);
  expect(body.authorization_digest).toMatch(/^[0-9a-f]{64}$/);
  await expect(approval.getByTestId('approval-step')).toHaveAttribute('data-step', 'submitted');
  const calls = await page.evaluate(() => (window as unknown as { __signCalls: Array<{ tx: string; partial: boolean }> }).__signCalls);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.partial).toBe(true);
  await page.screenshot({ path: 'test-results/console-approved.png', fullPage: true });
});

test('a wallet that is not the approver can neither approve nor decline', async ({ page }) => {
  await fakeWallet(page, OTHER_HEX);
  await page.goto('/console');
  await page.getByRole('button', { name: 'Connect Lace' }).click();
  await expect(page.getByTestId('wallet-status')).toHaveAttribute('data-cfo', 'false');
  await expect(page.getByTestId('wallet-status')).toHaveAttribute('data-admin', 'false');
  const approval = page.getByTestId('approval').first();
  await expect(approval.getByRole('button', { name: 'Approve once' })).toBeDisabled();
  await expect(approval.getByRole('button', { name: 'Decline (reasonable ask, refund bond)' })).toBeDisabled();
});

test('declining in the wallet submits nothing', async ({ page }) => {
  await fakeWallet(page, APPROVER_HEX, true);
  let executed = false;
  page.on('request', (r) => {
    if (r.url().endsWith('/v1/executions')) executed = true;
  });
  await page.goto('/console');
  await page.getByRole('button', { name: 'Connect Lace' }).click();
  await page.getByTestId('approval').first().getByRole('button', { name: 'Approve once' }).click();
  await expect(page.getByTestId('approval').first()).toContainText('You declined in the wallet. Nothing was signed.');
  expect(executed).toBe(false);
});

test('CFO declines with a CIP-8 signature from the approver key (signData)', async ({ page }) => {
  await fakeWallet(page, APPROVER_HEX);
  await page.goto('/console');
  await page.getByRole('button', { name: 'Connect Lace' }).click();
  const req = page.waitForRequest((r) => r.url().endsWith('/v1/approvals/AP-A-0002/decline') && r.method() === 'POST');
  await page.getByTestId('approval').first().getByRole('button', { name: 'Decline (reasonable ask, refund bond)' }).click();
  expect((await req).postDataJSON()).toEqual({ ...DATA_SIG, reason: 'legitimate' });
  await expect(page.getByTestId('approval').first().getByTestId('approval-step')).toHaveAttribute('data-step', 'declined');
  const dataCalls = await page.evaluate(() => (window as unknown as { __dataCalls: Array<{ addr: string; payload: string }> }).__dataCalls);
  expect(dataCalls).toEqual([{ addr: APPROVER_HEX, payload: DECLINE_PAYLOAD }]);
});

test('the inbox renders the Decision Brief; a frivolous decline captures the bond through the approver wallet', async ({ page }) => {
  await fakeWallet(page, APPROVER_HEX);
  await page.goto('/console');
  const approval = page.getByTestId('approval').first();
  // The brief, in reading order, before any wallet is connected.
  const brief = approval.getByTestId('brief');
  await expect(brief).toContainText('$18.00');
  await expect(brief).toContainText('18 USDM');
  await expect(brief).toContainText("the agent's claim");
  await expect(approval.getByTestId('will-happen')).toHaveText(/^Release 18 USDM from vault acme-treasury to addr_test1.* Nothing else is authorized by this signature\.$/);
  await expect(approval.getByTestId('budget')).toHaveText('Interrupt budget 0 of 3 used today');
  await expect(approval.getByTestId('bond-chip').first()).toHaveAttribute('data-status', 'locked');
  await expect(approval.getByTestId('bond-chip').first()).toContainText('5.00 ADA');
  await expect(approval.getByTestId('bond-chip').first().getByRole('link')).toHaveAttribute('href', /^https:\/\/preprod\.cardanoscan\.io\/transaction\/(b0){31}01$/);
  await expect(approval).not.toContainText(/requires approval/i);

  await page.getByRole('button', { name: 'Connect Lace' }).click();
  const declined = page.waitForRequest((r) => r.url().endsWith('/v1/approvals/AP-A-0002/decline') && r.method() === 'POST');
  const submitted = page.waitForRequest((r) => r.url().endsWith('/v1/approvals/AP-A-0002/bond-submit') && r.method() === 'POST');
  await approval.getByRole('button', { name: 'Decline (frivolous, capture bond)' }).click();
  expect((await declined).postDataJSON()).toEqual({ ...DATA_SIG, reason: 'frivolous' });
  expect((await submitted).postDataJSON()).toEqual({ tx_hash: 'd'.repeat(64), cfo_witness_cbor: WITNESS });
  await expect(approval.getByTestId('approval-step')).toHaveAttribute('data-step', 'declined');
  await expect(approval.getByTestId('approval-step')).toContainText('Declined as frivolous. Bond captured.');
  const dataCalls = await page.evaluate(() => (window as unknown as { __dataCalls: Array<{ payload: string }> }).__dataCalls);
  expect(dataCalls.map((c) => Buffer.from(c.payload, 'hex').toString('utf8'))).toEqual(['{"approval_id":"AP-A-0002","decision":"decline","reason":"frivolous"}']);
  const signCalls = await page.evaluate(() => (window as unknown as { __signCalls: Array<{ tx: string; partial: boolean | undefined }> }).__signCalls);
  expect(signCalls).toEqual([{ tx: '84a400bondfixture', partial: true }]);
  await page.screenshot({ path: 'test-results/console-brief.png', fullPage: true });
});

test('payment approver cannot revoke or update the mandate', async ({ page }) => {
  await withAdminKey(page, ADMIN_PKH);
  await fakeWallet(page, APPROVER_HEX);
  await page.goto('/console');
  await page.getByRole('button', { name: 'Connect Lace' }).click();
  await expect(page.getByTestId('wallet-status')).toHaveAttribute('data-cfo', 'true');
  await expect(page.getByTestId('wallet-status')).toHaveAttribute('data-admin', 'false');
  const controls = page.getByRole('region', { name: 'Change the mandate' });
  await expect(controls.getByRole('button', { name: 'Revoke mandate' })).toBeDisabled();
  await expect(controls.getByRole('button', { name: 'Update mandate to v4' })).toBeDisabled();
  await expect(controls).toContainText('mandate admin');
});

test('mandate admin signs revoke and update and cannot approve payments', async ({ page }) => {
  await withAdminKey(page, ADMIN_PKH);
  await fakeWallet(page, ADMIN_HEX);
  await page.goto('/console');
  await page.getByRole('button', { name: 'Connect Lace' }).click();
  await expect(page.getByTestId('wallet-status')).toHaveAttribute('data-cfo', 'false');
  await expect(page.getByTestId('wallet-status')).toHaveAttribute('data-admin', 'true');
  const approval = page.getByTestId('approval').first();
  await expect(approval.getByRole('button', { name: 'Approve once' })).toBeDisabled();
  await expect(approval.getByRole('button', { name: 'Decline (reasonable ask, refund bond)' })).toBeDisabled();

  const controls = page.getByRole('region', { name: 'Change the mandate' });
  await controls.getByRole('button', { name: 'Revoke mandate' }).click();
  const confirm = controls.getByRole('button', { name: 'Confirm: revoke M-001 v3' });
  await expect(confirm).toHaveClass(/btn-danger/);
  await expect(confirm).toHaveCSS('background-color', 'rgb(179, 70, 58)');
  const revokeReq = page.waitForRequest((r) => r.url().endsWith('/v1/mandates/M-001/revoke') && r.method() === 'POST');
  const submitReq = page.waitForRequest((r) => r.url().endsWith('/v1/mandates/M-001/submit') && r.method() === 'POST');
  await confirm.click();
  await revokeReq;
  expect((await submitReq).postDataJSON()).toEqual({ tx_hash: 'f'.repeat(64), cfo_witness_cbor: WITNESS });
  await expect(controls).toContainText('Submitted anchor transaction');

  await controls.getByLabel('autonomous limit').fill('12');
  const updateReq = page.waitForRequest((r) => r.url().endsWith('/v1/mandates/M-001/update') && r.method() === 'POST');
  const submitUpdate = page.waitForRequest((r) => r.url().endsWith('/v1/mandates/M-001/submit') && r.method() === 'POST');
  await controls.getByRole('button', { name: 'Update mandate to v4' }).click();
  expect((await updateReq).postDataJSON()).toEqual({
    limits: {
      autonomous_limit: '12000000',
      hard_cap: '50000000',
      daily_cap: '50000000',
      treasury_minimum: '100000000',
    },
  });
  expect((await submitUpdate).postDataJSON()).toEqual({ tx_hash: 'f'.repeat(64), cfo_witness_cbor: WITNESS });
  const calls = await page.evaluate(() => (window as unknown as { __signCalls: Array<{ tx: string; partial: boolean }> }).__signCalls);
  expect(calls).toHaveLength(2);
  expect(calls.every((c) => c.partial === true)).toBe(true);
});
