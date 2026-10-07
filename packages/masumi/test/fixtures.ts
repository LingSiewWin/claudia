import { PRICE_UNITS, TEST_USDM_UNIT, type Payment, type PaymentRequest, type SellerSource } from '../src/mps';

export const SOURCE: SellerSource = {
  agentIdentifier: `${'a'.repeat(56)}617574686f72697479`,
  supportedPaymentSourceIndex: 0,
  smartContractAddress: 'addr_test1wzexamplecontract',
  policyId: 'a'.repeat(56),
  sellerVkey: 'b'.repeat(56),
  sellerAddress: 'addr_test1qexampleseller',
};

// A quote shaped like the payment service's POST /payment response for `request`.
export function quoteFor(request: PaymentRequest, blockchainIdentifier = 'bid-1'): Payment {
  return {
    blockchainIdentifier,
    agentIdentifier: request.agentIdentifier,
    inputHash: request.inputHash,
    payByTime: String(Date.parse(request.payByTime)),
    submitResultTime: String(Date.parse(request.submitResultTime)),
    unlockTime: String(Date.parse(request.unlockTime)),
    externalDisputeUnlockTime: String(Date.parse(request.externalDisputeUnlockTime)),
    sellerReturnAddress: null,
    forceLayer: null,
    onChainState: null,
    resultHash: null,
    NextAction: { requestedAction: 'WaitingForExternalAction', errorType: null },
    CurrentTransaction: null,
    TransactionHistory: [],
    RequestedFunds: [{ amount: PRICE_UNITS, unit: TEST_USDM_UNIT }],
    PaymentSource: {
      network: 'Preprod',
      paymentSourceType: 'Web3CardanoV2',
      smartContractAddress: SOURCE.smartContractAddress,
      policyId: SOURCE.policyId,
    },
    SmartContractWallet: { walletVkey: SOURCE.sellerVkey, walletAddress: SOURCE.sellerAddress },
  };
}
