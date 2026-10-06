import { encodeReportPayload } from '@authority/chainlink/codec';
import { canonicalJson } from '@authority/core';
import {
  bytesToHex,
  consensusIdenticalAggregation,
  decodeJson,
  EVMClient,
  getNetwork,
  HTTPCapability,
  HTTPClient,
  type HTTPPayload,
  type HTTPSendRequester,
  handler,
  json,
  prepareReportRequest,
  Runner,
  type Runtime,
  TxStatus,
} from '@chainlink/cre-sdk';
import * as z from 'zod';
import { buildReport, type InvoiceTuple, normalizeInvoice, TriggerRequestSchema } from './src/verify';

const STRIPE_SECRET_ID = 'STRIPE_INVOICE_READ';
const RECEIVER_REVERTED = 1; // EVM_PB.ReceiverContractExecutionStatus.REVERTED

const configSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('local-simulation') }),
  z.strictObject({
    mode: z.literal('sepolia'),
    chainSelectorName: z.literal('ethereum-testnet-sepolia'),
    registryAddress: z
      .string()
      .regex(/^0x[0-9a-fA-F]{40}$/)
      .refine((a) => !/^0x0{40}$/.test(a), 'zero address'),
    gasLimit: z.string().regex(/^[1-9][0-9]{0,8}$/),
  }),
]);
type Config = z.infer<typeof configSchema>;

// Node mode: every node fetches and normalizes independently; consensus compares the
// canonical JSON string byte for byte (identical aggregation; null is not a CRE value type).
const fetchInvoiceTuple = (sender: HTTPSendRequester, apiKey: string, invoiceId: string): string => {
  const response = sender
    .sendRequest({
      url: `https://api.stripe.com/v1/invoices/${invoiceId}`,
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    .result();
  return canonicalJson(normalizeInvoice(response.statusCode, response.statusCode === 200 ? json(response) : null));
};

const onVerifyRequest = (runtime: Runtime<Config>, payload: HTTPPayload): string => {
  const req = TriggerRequestSchema.parse(decodeJson(payload.input));
  const apiKey = runtime.getSecret({ id: STRIPE_SECRET_ID }).result().value;
  const tupleJson = new HTTPClient()
    .sendRequest(runtime, fetchInvoiceTuple, consensusIdenticalAggregation<string>())(apiKey, req.invoice_id)
    .result();
  const { report, report_hash } = buildReport(JSON.parse(tupleJson) as InvoiceTuple, req);
  runtime.log(`report_hash=${report_hash} report=${canonicalJson(report)}`);

  const config = runtime.config;
  if (config.mode === 'local-simulation') {
    return JSON.stringify({ mode: 'local-simulation', report_hash, result: report.result, reason: report.reason });
  }

  const network = getNetwork({ chainFamily: 'evm', chainSelectorName: config.chainSelectorName, isTestnet: true });
  if (!network) throw new Error(`unknown chain ${config.chainSelectorName}`);
  const { payload: encoded } = encodeReportPayload(report);
  const signed = runtime.report(prepareReportRequest(encoded)).result();
  const reply = new EVMClient(network.chainSelector.selector)
    .writeReport(runtime, { receiver: config.registryAddress, report: signed, gasConfig: { gasLimit: config.gasLimit } })
    .result();
  if (reply.txStatus !== TxStatus.SUCCESS) throw new Error(`writeReport: ${reply.errorMessage ?? reply.txStatus}`);
  if (reply.receiverContractExecutionStatus === RECEIVER_REVERTED) throw new Error('writeReport: registry reverted');
  if (!reply.txHash || reply.txHash.every((b) => b === 0)) throw new Error('writeReport: no transaction hash');
  const txHash = bytesToHex(reply.txHash);
  runtime.log(`InvoiceVerified tx=${txHash} report_hash=${report_hash}`);
  return JSON.stringify({ report_hash, tx_hash: txHash, result: report.result, reason: report.reason });
};

const initWorkflow = () => [handler(new HTTPCapability().trigger({}), onVerifyRequest)];

export async function main() {
  const runner = await Runner.newRunner<Config>({ configSchema });
  await runner.run(initWorkflow);
}
