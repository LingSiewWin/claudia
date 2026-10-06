import * as z from 'zod';

export const TEST_USDM_UNIT = '16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d';
export const PRICE_UNITS = '1000000'; // 1 tUSDM (6 decimals) per check
const MINUTE = 60_000;

export const SellerSourceSchema = z
  .object({
    agentIdentifier: z.string().regex(/^[0-9a-f]{57,250}$/),
    supportedPaymentSourceIndex: z.number().int().min(0).max(24),
    smartContractAddress: z.string().startsWith('addr_test1'),
    policyId: z.string().regex(/^[0-9a-f]{56}$/),
    sellerVkey: z.string().regex(/^[0-9a-f]{56}$/),
    sellerAddress: z.string().startsWith('addr_test1'),
  })
  .refine((s) => s.agentIdentifier.startsWith(s.policyId), 'agentIdentifier must start with the payment source policyId');
export type SellerSource = z.infer<typeof SellerSourceSchema>;

const TxSchema = z.object({
  txHash: z.string().nullable(),
  status: z.string(),
  newOnChainState: z.string().nullable().optional(),
  confirmations: z.number().nullable().optional(),
});

export const PaymentSchema = z.object({
  blockchainIdentifier: z.string().min(1),
  agentIdentifier: z.string(),
  inputHash: z.string(),
  payByTime: z.string().nullable(),
  submitResultTime: z.string(),
  unlockTime: z.string(),
  externalDisputeUnlockTime: z.string(),
  sellerReturnAddress: z.string().nullable(),
  forceLayer: z.string().nullable().optional(),
  onChainState: z.string().nullable(),
  resultHash: z.string().nullable(),
  NextAction: z.object({
    requestedAction: z.string(),
    errorType: z.string().nullable(),
    resultHash: z.string().nullable().optional(),
  }),
  CurrentTransaction: TxSchema.nullable(),
  TransactionHistory: z.array(TxSchema).nullable().optional(),
  RequestedFunds: z.array(z.object({ amount: z.string(), unit: z.string() })),
  PaymentSource: z.object({
    network: z.string(),
    paymentSourceType: z.string(),
    smartContractAddress: z.string(),
    policyId: z.string().nullable(),
  }),
  SmartContractWallet: z.object({ walletVkey: z.string(), walletAddress: z.string() }).nullable(),
});
export type Payment = z.infer<typeof PaymentSchema>;

export interface PaymentRequest {
  network: 'Preprod';
  paymentSourceType: 'Web3CardanoV2';
  agentIdentifier: string;
  supportedPaymentSourceIndex: number;
  inputHash: string;
  identifierFromPurchaser: string;
  RequestedFunds: { amount: string; unit: string }[];
  payByTime: string;
  submitResultTime: string;
  unlockTime: string;
  externalDisputeUnlockTime: string;
}

// Deadlines satisfy the payment service rules: payBy <= submit - 5 min, submit >= now + 15 min,
// unlock >= submit + 15 min, externalDisputeUnlock >= unlock + 15 min.
export function paymentRequest(source: SellerSource, inputHash: string, identifierFromPurchaser: string, nowMs: number): PaymentRequest {
  const at = (minutes: number): string => new Date(nowMs + minutes * MINUTE).toISOString();
  return {
    network: 'Preprod',
    paymentSourceType: 'Web3CardanoV2',
    agentIdentifier: source.agentIdentifier,
    supportedPaymentSourceIndex: source.supportedPaymentSourceIndex,
    inputHash,
    identifierFromPurchaser,
    RequestedFunds: [{ amount: PRICE_UNITS, unit: TEST_USDM_UNIT }],
    payByTime: at(10),
    submitResultTime: at(25),
    unlockTime: at(45),
    externalDisputeUnlockTime: at(65),
  };
}

export class QuoteError extends Error {}

// Signed seller terms must match what we asked for before anyone is charged.
export function checkQuote(p: Payment, source: SellerSource, request: PaymentRequest): void {
  const bad: string[] = [];
  if (p.agentIdentifier !== source.agentIdentifier) bad.push('agentIdentifier');
  if (p.inputHash !== request.inputHash) bad.push('inputHash');
  const [fund] = p.RequestedFunds;
  if (p.RequestedFunds.length !== 1 || fund?.unit !== TEST_USDM_UNIT || fund.amount !== PRICE_UNITS) bad.push('RequestedFunds');
  const ps = p.PaymentSource;
  if (
    ps.network !== 'Preprod' ||
    ps.paymentSourceType !== 'Web3CardanoV2' ||
    ps.smartContractAddress !== source.smartContractAddress ||
    ps.policyId !== source.policyId
  ) bad.push('PaymentSource');
  if (p.SmartContractWallet?.walletVkey !== source.sellerVkey || p.SmartContractWallet.walletAddress !== source.sellerAddress) bad.push('seller wallet');
  if (p.sellerReturnAddress !== null || (p.forceLayer ?? null) !== null) bad.push('signed overrides');
  for (const k of ['payByTime', 'submitResultTime', 'unlockTime', 'externalDisputeUnlockTime'] as const) {
    if (p[k] !== String(Date.parse(request[k]))) bad.push(k);
  }
  if (p.NextAction.errorType !== null) bad.push('NextAction.errorType');
  if (bad.length > 0) throw new QuoteError(`signed terms differ from the request: ${bad.join(', ')}`);
}

// Body of `masumiPayment` on the Sokosumi Task event: the signed terms, unchanged.
export function masumiPaymentEvent(p: Payment, identifierFromPurchaser: string, source: SellerSource) {
  if (p.payByTime === null) throw new QuoteError('signed terms have no payByTime');
  return {
    blockchainIdentifier: p.blockchainIdentifier,
    identifierFromPurchaser,
    agentIdentifier: p.agentIdentifier,
    sellerVkey: source.sellerVkey,
    inputHash: p.inputHash,
    payByTime: p.payByTime,
    submitResultTime: p.submitResultTime,
    unlockTime: p.unlockTime,
    externalDisputeUnlockTime: p.externalDisputeUnlockTime,
    Amounts: p.RequestedFunds.map(({ amount, unit }) => ({ amount, unit })),
    paymentSourceType: 'Web3CardanoV2' as const,
    supportedPaymentSourceIndex: source.supportedPaymentSourceIndex,
    PaymentSource: { network: 'Preprod' as const, policyId: source.policyId, smartContractAddress: source.smartContractAddress },
  };
}

const transactions = (p: Payment) => [p.CurrentTransaction, ...(p.TransactionHistory ?? [])].filter((t) => t !== null);

// A state counts only when the payment is in it and a confirmed transaction moved it there.
export function confirmedState(p: Payment, state: string): boolean {
  return p.onChainState === state && transactions(p).some((t) => t.status === 'Confirmed' && t.newOnChainState === state);
}

export function withdrawnBy(p: Payment, txHash: string): boolean {
  return (
    p.onChainState === 'Withdrawn' &&
    transactions(p).some((t) => t.status === 'Confirmed' && t.newOnChainState === 'Withdrawn' && t.txHash === txHash)
  );
}

export function resultRecorded(p: Payment, resultHash: string): boolean {
  return p.resultHash === resultHash || p.NextAction.resultHash === resultHash;
}

export class MpsError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export interface MpsClient {
  createPayment(body: PaymentRequest): Promise<Payment>;
  resolvePayment(blockchainIdentifier: string): Promise<Payment>;
  submitResult(blockchainIdentifier: string, resultHash: string): Promise<Payment>;
}

export function createMpsClient(opts: { baseUrl: string; token: string; fetchImpl?: typeof fetch }): MpsClient {
  const base = opts.baseUrl.replace(/\/+$/, '');
  const send = opts.fetchImpl ?? fetch;
  const post = async (path: string, body: unknown): Promise<Payment> => {
    const res = await send(`${base}${path}`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      headers: { token: opts.token, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as { status?: unknown; data?: unknown } | null;
    if (!res.ok || json?.status !== 'success') throw new MpsError(`payment service ${path} HTTP ${res.status}`, res.status);
    return PaymentSchema.parse(json.data);
  };
  return {
    createPayment: (body) => post('/payment', body),
    resolvePayment: (blockchainIdentifier) =>
      post('/payment/resolve-blockchain-identifier', { network: 'Preprod', blockchainIdentifier, includeHistory: 'true' }),
    submitResult: (blockchainIdentifier, resultHash) =>
      post('/payment/submit-result', { network: 'Preprod', blockchainIdentifier, submitResultHash: resultHash }),
  };
}
