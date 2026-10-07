import { encodeFxReportPayload } from '@authority/chainlink/fx-codec';
import { canonicalJson } from '@authority/core';
import {
  bytesToHex,
  decodeJson,
  encodeCallMsg,
  EVMClient,
  getNetwork,
  HTTPCapability,
  type HTTPPayload,
  handler,
  LAST_FINALIZED_BLOCK_NUMBER,
  prepareReportRequest,
  Runner,
  type Runtime,
  TxStatus,
} from '@chainlink/cre-sdk';
import { EVM_PB } from '@chainlink/cre-sdk/pb';
import { type Address, decodeFunctionResult, encodeFunctionData, parseAbi, zeroAddress } from 'viem';
import { buildFxReport, type FeedRound, FxBasisRequestSchema } from './src/basis';
import { type Config, configSchema } from './src/config';

// AggregatorV3Interface (docs.chain.link/data-feeds/api-reference).
const FEED_ABI = parseAbi([
  'function decimals() view returns (uint8)',
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
]);

// callContract is a DON-level capability: the nodes agree on the finalized-block result before it
// returns, so no node-mode aggregation is needed here.
const readFeed = (runtime: Runtime<Config>): FeedRound => {
  const { feedChainSelectorName, feedAddress } = runtime.config;
  const network = getNetwork({ chainFamily: 'evm', chainSelectorName: feedChainSelectorName, isTestnet: false });
  if (!network) throw new Error(`unknown chain ${feedChainSelectorName}`);
  const evm = new EVMClient(network.chainSelector.selector);
  const call = (functionName: 'decimals' | 'latestRoundData') =>
    bytesToHex(
      evm
        .callContract(runtime, {
          call: encodeCallMsg({ from: zeroAddress, to: feedAddress as Address, data: encodeFunctionData({ abi: FEED_ABI, functionName }) }),
          blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
        })
        .result().data,
    );
  const decimals = decodeFunctionResult({ abi: FEED_ABI, functionName: 'decimals', data: call('decimals') });
  const [roundId, answer, , updatedAt] = decodeFunctionResult({ abi: FEED_ABI, functionName: 'latestRoundData', data: call('latestRoundData') });
  if (roundId === 0n || updatedAt === 0n) throw new Error('feed round not yet answered');
  return { decimals, roundId, answer, updatedAt, feedAddress };
};

const onFxBasisRequest = (runtime: Runtime<Config>, payload: HTTPPayload): string => {
  const req = FxBasisRequestSchema.parse(decodeJson(payload.input));
  const round = readFeed(runtime);
  const now = req.now ?? Math.floor(runtime.now().getTime() / 1000);
  const { report, report_hash } = buildFxReport(round, req, now);
  runtime.log(`report_hash=${report_hash} report=${canonicalJson(report)}`);

  const config = runtime.config;
  if (config.mode === 'local-simulation') {
    return JSON.stringify({ mode: 'local-simulation', report_hash, result: report.result, basis_bps: report.basis_bps });
  }

  const network = getNetwork({ chainFamily: 'evm', chainSelectorName: config.chainSelectorName, isTestnet: true });
  if (!network) throw new Error(`unknown chain ${config.chainSelectorName}`);
  const { payload: encoded } = encodeFxReportPayload(report);
  const signed = runtime.report(prepareReportRequest(encoded)).result();
  const reply = new EVMClient(network.chainSelector.selector)
    .writeReport(runtime, { receiver: config.registryAddress, report: signed, gasConfig: { gasLimit: config.gasLimit } })
    .result();
  if (reply.txStatus !== TxStatus.SUCCESS) throw new Error(`writeReport: ${reply.errorMessage ?? reply.txStatus}`);
  if (reply.receiverContractExecutionStatus === EVM_PB.ReceiverContractExecutionStatus.REVERTED) throw new Error('writeReport: registry reverted');
  if (!reply.txHash || reply.txHash.every((b) => b === 0)) throw new Error('writeReport: no transaction hash');
  const txHash = bytesToHex(reply.txHash);
  runtime.log(`FxBasisAttested tx=${txHash} report_hash=${report_hash}`);
  return JSON.stringify({ report_hash, tx_hash: txHash, result: report.result, basis_bps: report.basis_bps });
};

const initWorkflow = () => [handler(new HTTPCapability().trigger({}), onFxBasisRequest)];

export async function main() {
  const runner = await Runner.newRunner<Config>({ configSchema });
  await runner.run(initWorkflow);
}
