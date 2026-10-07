import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { relayTrigger } from '../src/relay';
import { type Api, RELAY_KEY, startApi } from './harness';

let api: Api;
beforeEach(async () => {
  api = await startApi();
});
afterEach(() => api.close());
const relay = { authorization: `Bearer ${RELAY_KEY}` };
const payload = (id: string) => ({
  trigger_id: id,
  action_hash: 'dd'.repeat(32),
  invoice_id: 'in_3821',
  customer_id: 'cus_acme',
  requested_amount: '8420000',
  requested_currency: 'usd',
  requested_recipient: 'addr_test1x',
});

describe('CRE relay (operator machine runs the CLI; the API reads the chain itself)', () => {
  it('hands out the API-chosen payload once and returns the CLI output to the waiting trigger', async () => {
    const id = '6f1c2a9e-7b1d-4c52-9a35-2f4f5d0c9b11';
    const pending = relayTrigger(api.db, { pollMs: 10 })(payload(id));
    let job;
    for (let i = 0; i < 50 && !job; i++) {
      const res = await api.post('/v1/cre/jobs/claim', {}, relay);
      if (res.status === 200) job = res.json;
      else await new Promise((r) => setTimeout(r, 10));
    }
    expect(job).toEqual({ trigger_id: id, payload: payload(id) });
    expect((await api.post('/v1/cre/jobs/claim', {}, relay)).status).toBe(204);
    const output = `[USER LOG] InvoiceVerified tx=0x${'ab'.repeat(32)} report_hash=x`;
    expect((await api.post(`/v1/cre/jobs/${id}/result`, { output }, relay)).status).toBe(200);
    expect(await pending).toBe(output);
    expect((await api.post(`/v1/cre/jobs/${id}/result`, { output: 'again' }, relay)).status).toBe(409);
  });

  it('only the relay key can claim; a relay that never answers makes the trigger fail (VERIFICATION_UNAVAILABLE upstream)', async () => {
    expect((await api.post('/v1/cre/jobs/claim', {})).status).toBe(401);
    await expect(relayTrigger(api.db, { timeoutMs: 50, pollMs: 10 })(payload('7f1c2a9e-7b1d-4c52-9a35-2f4f5d0c9b11'))).rejects.toThrow(
      'the CRE relay did not answer in time',
    );
  });
});
