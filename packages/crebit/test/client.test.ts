import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BASE_URLS, CONTRACT_PHASE, canonicalJson, CrebitClient, CrebitError, crebitFromEnv, missingCrebitEnv, replayTransport, signInbound, verifyWebhook } from '../src';

const client = (transport = replayTransport()) => ({ transport, c: new CrebitClient({ env: 'sandbox', keyId: 'cbk_sbx_test', keySecret: 'cbs_test', transport, newIdempotencyKey: () => 'fixed-key' }) });

describe('CrebitClient requests (replayed reference examples, not live)', () => {
  it('sends the three auth headers and Idempotency-Key on writes only', async () => {
    const { transport, c } = client();
    const quote = await c.createQuote({
      customer_reference_id: 'partner-cust-ref-2026-0042',
      customer_name: 'Acme Imports Pvt Ltd',
      contract_type: 'forward',
      direction: 'USD_TO_BRL',
      notional_currency: 'USD',
      notional_amount: '50000.00',
      provider_rate: '5.42',
      market_rate: '5.4180',
      market_rate_timestamp: '2026-05-24T16:00:00Z',
      strike_mode: 'cip_fair',
      window_start: '2026-08-04T00:00:00Z',
      window_end: '2026-08-11T00:00:00Z',
      chain: 'solana',
      settlement_currency: 'USDC',
      payout_wallet_address: 'So11111111111111111111111111111111111111112',
      oracle: 'redstone',
    });
    expect(quote).toMatchObject({ id: '22222222-2222-4222-8222-222222222222', locked_rate: '5.42', premium_amount: '1565.00', amount_due: '6565.00', expires_at: '2026-05-24T16:16:30Z' });
    const post = transport.calls[0]!;
    expect(post.url).toBe(`${BASE_URLS.sandbox}/api/v1/fx/quotes`);
    expect(post.headers).toMatchObject({ 'X-Crebit-Key-Id': 'cbk_sbx_test', 'X-Crebit-Key-Secret': 'cbs_test', 'X-Crebit-Environment': 'sandbox', 'Idempotency-Key': 'fixed-key', 'Content-Type': 'application/json' });
    expect(JSON.parse(post.body!)).toMatchObject({ notional_amount: '50000.00', chain: 'solana' });

    const read = await c.getQuote(quote.id);
    expect(read?.id).toBe(quote.id);
    const get = transport.calls[1]!;
    expect(get.method).toBe('GET');
    expect(get.body).toBeNull();
    expect('Idempotency-Key' in get.headers).toBe(false);
  });

  it('money stays a string; contract and status map to the reference shapes', async () => {
    const { c } = client();
    const contract = await c.createContract({ quote_id: '22222222-2222-4222-8222-222222222222', partner_transaction_reference: 'platform-tx-9901' }, 'idem-1');
    expect(contract.funding_wallet_address).toBe('0xCrebitFundingWalletForThisContract');
    expect(typeof contract.total_amount).toBe('string');
    const status = await c.contractStatus(contract.id);
    expect(status.status).toBe('active');
    expect(CONTRACT_PHASE[status.status]).toBe('live');
    expect(CONTRACT_PHASE.failed).toBe('recoverable');
    const chains = await c.supportedChains();
    expect(chains.chains.filter((x) => x.enabled).map((x) => x.chain)).toEqual(['solana', 'tron']);
    expect((await c.createCustomerReference('partner-cust-ref-2026-0042')).id).toBe('66666666-6666-4666-8666-666666666666');
    expect((await c.me()).environment).toBe('sandbox');
    expect((await c.webhookEvents({ direction: 'outgoing' })).items).toEqual([]);
  });

  it('parses the error envelope into CrebitError and treats a 404 quote as null', async () => {
    const t = replayTransport([{ route: 'POST /fx/contracts', status: 409, body: { code: 'quote_already_used', message: 'used', details: {} } }]);
    const { c } = client(t);
    await expect(c.createContract({ quote_id: 'x' })).rejects.toMatchObject({ status: 409, code: 'quote_already_used' });
    await expect(c.createContract({ quote_id: 'x' })).rejects.toBeInstanceOf(CrebitError);
    expect(await c.getQuote('missing')).toBeNull();
  });

  it('rejects a request body the API would reject (unknown field, non-decimal money)', async () => {
    const { c } = client();
    await expect(c.createQuote({ foo: 1 } as never)).rejects.toThrow();
  });
});

describe('env', () => {
  it('names exactly the missing variables and builds nothing without them', () => {
    expect(missingCrebitEnv({})).toEqual(['CREBIT_ENV', 'CREBIT_KEY_ID', 'CREBIT_KEY_SECRET']);
    expect(crebitFromEnv({ CREBIT_ENV: 'sandbox', CREBIT_KEY_ID: 'a' })).toBeNull();
    expect(crebitFromEnv({ CREBIT_ENV: 'sandbox', CREBIT_KEY_ID: 'a', CREBIT_KEY_SECRET: 'b' })?.baseUrl).toBe(BASE_URLS.sandbox);
    expect(crebitFromEnv({ CREBIT_ENV: 'production', CREBIT_KEY_ID: 'a', CREBIT_KEY_SECRET: 'b' })?.baseUrl).toBe(BASE_URLS.production);
    expect(() => crebitFromEnv({ CREBIT_ENV: 'staging', CREBIT_KEY_ID: 'a', CREBIT_KEY_SECRET: 'b' })).toThrow(/sandbox or production/);
  });
});

describe('webhook signatures', () => {
  const secret = 'whsec_test';
  const raw = '{"event_type":"payout_success","amount":"12.50"}';
  const sign = (ts: number, body = raw) => `t=${ts},v1=${createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`;

  it('accepts a good signature over the raw bytes, rejects a bad one and a skewed timestamp', () => {
    const now = 1_760_000_000;
    expect(verifyWebhook(raw, sign(now - 10), secret, now)).toBe(true);
    expect(verifyWebhook(Buffer.from(raw), sign(now - 10), secret, now)).toBe(true);
    expect(verifyWebhook(raw.replace('12.50', '99.50'), sign(now - 10), secret, now)).toBe(false);
    expect(verifyWebhook(raw, sign(now - 10), 'other', now)).toBe(false);
    expect(verifyWebhook(raw, sign(now - 301), secret, now)).toBe(false);
    expect(verifyWebhook(raw, sign(now + 301), secret, now)).toBe(false);
    expect(verifyWebhook(raw, sign(now - 300), secret, now)).toBe(true);
    expect(verifyWebhook(raw, undefined, secret, now)).toBe(false);
    expect(verifyWebhook(raw, 'garbage', secret, now)).toBe(false);
  });

  it('signs inbound bodies over canonical JSON (sorted keys, no nulls, no whitespace)', () => {
    const body = { fx_contract_id: 'c1', event_type: 'funds_in_route', transaction_hash: null, nested: { b: 1, a: [2, null] } };
    expect(canonicalJson(body)).toBe('{"event_type":"funds_in_route","fx_contract_id":"c1","nested":{"a":[2,null],"b":1}}');
    const h = signInbound(body, secret, 1_760_000_000);
    expect(h['X-Crebit-Timestamp']).toBe('1760000000');
    expect(h['X-Crebit-Signature']).toBe(`t=1760000000,v1=${createHmac('sha256', secret).update(`1760000000.${canonicalJson(body)}`).digest('hex')}`);
  });
});
