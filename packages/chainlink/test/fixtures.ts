import { canonicalHash, type VerificationReport } from '@authority/core';
import { type Address, encodeAbiParameters, encodeEventTopics, type Hex, type PublicClient } from 'viem';
import { REGISTRY_ABI, RESULT_CODE, type StoredFields, toStoredFields } from '../src/codec';

export const FIXTURE: VerificationReport = {
  schema: 'verification/v0.1',
  action_hash: '11'.repeat(32),
  invoice_id: 'in_1QxDemoAws0001',
  invoice_hash: '22'.repeat(32),
  verified_amount: '8420000',
  verified_currency: 'usd',
  verified_recipient:
    'addr_test1qpe3z9srjllzq27zndk5nxlcrxs8u6tr3lvs00xk3pcauwend7e3wv3tk360w5k3uz2nkneydscpuwp9t2uwggpsfzgsgehreu',
  status: 'open',
  facts: { exists: true, customer_match: true, status_open: true, amount_match: true, currency_match: true, recipient_match: true },
  result: 'VERIFIED',
  reason: null,
  trigger_id: '6f1c2a9e-7b1d-4c52-9a35-2f4f5d0c9b11',
};

export const REGISTRY: Address = '0xbC0fE56c6F7b42F679A08E0549B14c9dbF69A31B';

// One InvoiceVerified log as the RPC returns it (lowercase emitter address).
export const invoiceVerifiedLog = (report: VerificationReport, emitter: Address = REGISTRY) => ({
  address: emitter.toLowerCase(),
  topics: encodeEventTopics({
    abi: REGISTRY_ABI,
    eventName: 'InvoiceVerified',
    args: { actionHash: `0x${report.action_hash}`, reportHash: `0x${canonicalHash(report)}` },
  }),
  data: encodeAbiParameters([{ type: 'uint8' }], [RESULT_CODE[report.result]]),
});

// Sepolia as seen by the reader after one registry write of `report`: the receipt carries the
// InvoiceVerified log and latestReport returns the stored fields. Records every call.
export function fakeChain(
  report: VerificationReport,
  opts: {
    logs?: ReturnType<typeof invoiceVerifiedLog>[];
    status?: 'success' | 'reverted';
    storedHash?: Hex;
    fields?: StoredFields;
  } = {},
) {
  const reads: unknown[] = [];
  const receipts: unknown[] = [];
  const client = {
    waitForTransactionReceipt: (args: unknown) => {
      receipts.push(args);
      return Promise.resolve({ status: opts.status ?? 'success', blockNumber: 7n, logs: opts.logs ?? [invoiceVerifiedLog(report)] });
    },
    readContract: (args: unknown) => {
      reads.push(args);
      return Promise.resolve([
        opts.storedHash ?? `0x${canonicalHash(report)}`,
        { fields: opts.fields ?? toStoredFields(report), blockTime: 1_800_000_000n },
      ]);
    },
  } as unknown as PublicClient;
  return { client, reads, receipts };
}
