import { describe, expect, it } from 'vitest';
import {
  MpsError,
  PRICE_UNITS,
  QuoteError,
  SellerSourceSchema,
  TEST_USDM_UNIT,
  checkQuote,
  confirmedState,
  createMpsClient,
  masumiPaymentEvent,
  paymentRequest,
  resultRecorded,
  withdrawnBy,
  type Payment,
} from '../src/mps';
import { SOURCE, quoteFor } from './fixtures';

const NOW = Date.parse('2026-10-07T03:00:00.000Z');
const MIN = 60_000;
const request = paymentRequest(SOURCE, 'ab'.repeat(32), 'aabbccddeeff00112233', NOW);
const tx = (newOnChainState: string, status = 'Confirmed', txHash = 'cd'.repeat(32)) => ({ txHash, status, newOnChainState, confirmations: 1 });

describe('paymentRequest', () => {
  it('asks for 1 tUSDM on the Preprod V2 source', () => {
    expect(request).toMatchObject({
      network: 'Preprod',
      paymentSourceType: 'Web3CardanoV2',
      agentIdentifier: SOURCE.agentIdentifier,
      supportedPaymentSourceIndex: 0,
      RequestedFunds: [{ amount: '1000000', unit: TEST_USDM_UNIT }],
    });
  });

  it('deadlines satisfy the payment service rules', () => {
    const [pay, submit, unlock, dispute] = [request.payByTime, request.submitResultTime, request.unlockTime, request.externalDisputeUnlockTime].map(Date.parse) as [number, number, number, number];
    expect(pay).toBeLessThanOrEqual(submit - 5 * MIN);
    expect(submit).toBeGreaterThanOrEqual(NOW + 15 * MIN);
    expect(unlock).toBeGreaterThanOrEqual(submit + 15 * MIN);
    expect(dispute).toBeGreaterThanOrEqual(unlock + 15 * MIN);
  });
});

describe('checkQuote', () => {
  it('accepts terms that match the request', () => {
    expect(() => checkQuote(quoteFor(request), SOURCE, request)).not.toThrow();
  });

  it.each<[string, (q: Payment) => Payment]>([
    ['other unit', (q) => ({ ...q, RequestedFunds: [{ amount: PRICE_UNITS, unit: '' }] })],
    ['other amount', (q) => ({ ...q, RequestedFunds: [{ amount: '2000000', unit: TEST_USDM_UNIT }] })],
    ['two funds', (q) => ({ ...q, RequestedFunds: [...q.RequestedFunds, ...q.RequestedFunds] })],
    ['other seller', (q) => ({ ...q, SmartContractWallet: { walletVkey: 'c'.repeat(56), walletAddress: SOURCE.sellerAddress } })],
    ['no seller', (q) => ({ ...q, SmartContractWallet: null })],
    ['seller return override', (q) => ({ ...q, sellerReturnAddress: 'addr_test1qother' })],
    ['forced layer', (q) => ({ ...q, forceLayer: 'L1' })],
    ['moved deadline', (q) => ({ ...q, submitResultTime: String(Number(q.submitResultTime) + 1) })],
    ['other input hash', (q) => ({ ...q, inputHash: 'ef'.repeat(32) })],
    ['other agent', (q) => ({ ...q, agentIdentifier: `${SOURCE.policyId}ff` })],
    ['mainnet source', (q) => ({ ...q, PaymentSource: { ...q.PaymentSource, network: 'Mainnet' } })],
    ['node error', (q) => ({ ...q, NextAction: { requestedAction: 'WaitingForExternalAction', errorType: 'NetworkError' } })],
  ])('rejects %s', (_label, tamper) => {
    expect(() => checkQuote(tamper(quoteFor(request)), SOURCE, request)).toThrow(QuoteError);
  });

  it('tolerates a payment service build that omits forceLayer', () => {
    const { forceLayer: _omit, ...older } = quoteFor(request);
    expect(() => checkQuote(older, SOURCE, request)).not.toThrow();
  });
});

describe('masumiPaymentEvent', () => {
  it('forwards the signed fields unchanged in the shape Sokosumi Core validates', () => {
    const q = quoteFor(request);
    const e = masumiPaymentEvent(q, 'aabbccddeeff00112233', SOURCE);
    expect(e).toEqual({
      blockchainIdentifier: q.blockchainIdentifier,
      identifierFromPurchaser: 'aabbccddeeff00112233',
      agentIdentifier: q.agentIdentifier,
      sellerVkey: SOURCE.sellerVkey,
      inputHash: q.inputHash,
      payByTime: q.payByTime,
      submitResultTime: q.submitResultTime,
      unlockTime: q.unlockTime,
      externalDisputeUnlockTime: q.externalDisputeUnlockTime,
      Amounts: [{ amount: PRICE_UNITS, unit: TEST_USDM_UNIT }],
      paymentSourceType: 'Web3CardanoV2',
      supportedPaymentSourceIndex: 0,
      PaymentSource: { network: 'Preprod', policyId: SOURCE.policyId, smartContractAddress: SOURCE.smartContractAddress },
    });
    for (const t of [e.payByTime, e.submitResultTime, e.unlockTime, e.externalDisputeUnlockTime]) expect(t).toMatch(/^\d{1,19}$/);
    expect(e.agentIdentifier.slice(0, 56)).toBe(e.PaymentSource.policyId);
  });
});

describe('payment state checks', () => {
  const base = quoteFor(request);
  it('FundsLocked needs a confirmed transaction into that state', () => {
    expect(confirmedState({ ...base, onChainState: 'FundsLocked', CurrentTransaction: tx('FundsLocked') }, 'FundsLocked')).toBe(true);
    expect(confirmedState({ ...base, onChainState: 'FundsLocked', CurrentTransaction: tx('FundsLocked', 'Pending') }, 'FundsLocked')).toBe(false);
    expect(confirmedState({ ...base, onChainState: 'FundsLocked', CurrentTransaction: null, TransactionHistory: [tx('FundsLocked')] }, 'FundsLocked')).toBe(true);
    expect(confirmedState({ ...base, onChainState: 'FundsLocked', CurrentTransaction: tx('Withdrawn') }, 'FundsLocked')).toBe(false);
    expect(confirmedState({ ...base, onChainState: null, CurrentTransaction: null }, 'FundsLocked')).toBe(false);
  });

  it('withdrawnBy matches only the given collection tx', () => {
    const p = { ...base, onChainState: 'Withdrawn', CurrentTransaction: tx('Withdrawn', 'Confirmed', 'aa'.repeat(32)) };
    expect(withdrawnBy(p, 'aa'.repeat(32))).toBe(true);
    expect(withdrawnBy(p, 'bb'.repeat(32))).toBe(false);
    expect(withdrawnBy({ ...p, onChainState: 'RefundWithdrawn' }, 'aa'.repeat(32))).toBe(false);
  });

  it('resultRecorded reads either result field', () => {
    expect(resultRecorded({ ...base, resultHash: 'ab' }, 'ab')).toBe(true);
    expect(resultRecorded({ ...base, NextAction: { requestedAction: 'SubmitResultRequested', errorType: null, resultHash: 'ab' } }, 'ab')).toBe(true);
    expect(resultRecorded(base, 'ab')).toBe(false);
  });
});

describe('SellerSourceSchema', () => {
  it('accepts the fixture and rejects an agent outside the policy', () => {
    expect(SellerSourceSchema.parse(SOURCE)).toEqual(SOURCE);
    expect(() => SellerSourceSchema.parse({ ...SOURCE, agentIdentifier: `${'c'.repeat(56)}aa` })).toThrow();
  });
});

describe('createMpsClient', () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const reply = (status: number, body: unknown) =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

  it('posts with the token header and parses the success envelope', async () => {
    calls.length = 0;
    const mps = createMpsClient({ baseUrl: 'http://127.0.0.1:3012/api/v1/', token: 'tok', fetchImpl: reply(200, { status: 'success', data: quoteFor(request) }) });
    const p = await mps.resolvePayment('bid-1');
    expect(p.blockchainIdentifier).toBe('bid-1');
    expect(calls[0]?.url).toBe('http://127.0.0.1:3012/api/v1/payment/resolve-blockchain-identifier');
    expect(new Headers(calls[0]?.init.headers).get('token')).toBe('tok');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ network: 'Preprod', blockchainIdentifier: 'bid-1', includeHistory: 'true' });
  });

  it('submitResult sends network, identifier and hash', async () => {
    calls.length = 0;
    const mps = createMpsClient({ baseUrl: 'http://x/api/v1', token: 't', fetchImpl: reply(200, { status: 'success', data: quoteFor(request) }) });
    await mps.submitResult('bid-1', 'ab'.repeat(32));
    expect(calls[0]?.url).toBe('http://x/api/v1/payment/submit-result');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ network: 'Preprod', blockchainIdentifier: 'bid-1', submitResultHash: 'ab'.repeat(32) });
  });

  it('throws MpsError with the HTTP status on failure', async () => {
    const mps = createMpsClient({ baseUrl: 'http://x/api/v1', token: 't', fetchImpl: reply(400, { status: 'error', error: { message: 'bad' } }) });
    await expect(mps.createPayment(request)).rejects.toMatchObject({ name: 'Error', status: 400 });
    await expect(mps.createPayment(request)).rejects.toBeInstanceOf(MpsError);
  });
});
