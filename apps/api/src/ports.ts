import type { VerificationOutcome } from '@authority/chainlink';
import type { BondOutcome, BondUtxo } from '@authority/cardano';
import type { ActionIR, AuthorizationFields, AuthorizationRecord, ChainBinding, EscalationPrice, Mandate } from '@authority/core';

export { CardanoError, type CardanoErrorCode } from '@authority/cardano';
export type { BondOutcome, BondUtxo } from '@authority/cardano';

// Everything the API needs from the outside world. Real implementations are wired in main.ts;
// tests use in-memory fakes. Cardano is authoritative for vault and anchor state.

export interface VaultState {
  balance: bigint;
  spent_today: bigint;
  day_index: number;
  last_nonce: bigint;
  /** tx hash of the current VAULT-token UTxO */
  tx_hash: string;
  slot: number;
}

export interface AnchorState {
  mandate_hash: string;
  version: number;
  status: 'active' | 'revoked';
  /** organization admin payment key hash from the anchor datum */
  principal_pkh: string;
  /** payment approver payment key hash from the anchor datum */
  approver_pkh: string;
  /** tx hash of the current MANDATE-token UTxO */
  tx_hash: string;
}

/** Settlement tx metadata, label 1694. log_head = evidence-log seq and hash when the release was built. */
export interface SettlementMetadata {
  auth: string;
  action: string;
  mandate: string;
  log_head: { seq: number; hash: string };
}

export interface UnsignedTx {
  txCbor: string;
  txHash: string;
}

export interface CardanoPort {
  readVaultState(binding: ChainBinding): Promise<VaultState>;
  readAnchor(binding: ChainBinding): Promise<AnchorState>;
  /** Unsigned release tx. cfoKeyHash, when set, becomes a required signer. */
  buildRelease(input: {
    binding: ChainBinding;
    authorization: AuthorizationRecord;
    metadata: SettlementMetadata;
    cfoKeyHash: string | null;
  }): Promise<UnsignedTx>;
  buildAnchorUpdate(input: { binding: ChainBinding; mandate: Mandate }): Promise<UnsignedTx>;
  buildAnchorRevoke(input: { binding: ChainBinding }): Promise<UnsignedTx>;
  /** Adds the fee-wallet witness, merges the given CIP-30 witness sets, submits. Returns the tx hash. */
  submit(input: { txCbor: string; witnessSets: string[] }): Promise<string>;
  /** Block height once confirmed, or null if still unconfirmed at untilMs (the tx can no longer land). */
  awaitConfirmation(txHash: string, untilMs: number): Promise<{ block_height: number } | null>;
  /**
   * Hash of a confirmed transaction that executed this authorization (an output to its recipient whose inline
   * datum is its digest, as R16 requires), whoever submitted it; null if there is none.
   */
  releaseOf(binding: ChainBinding, authorization: AuthorizationRecord): Promise<string | null>;
  /** Escrow address and sink for the 402 price. */
  bondAddresses(): { escrow: string; sink: string };
  /** The live bond UTxO for this escalation, verified against the price, or null. */
  readBond(price: Pick<EscalationPrice, 'approval_id' | 'action_hash' | 'amount' | 'approver_key_hash' | 'network'>): Promise<BondUtxo | null>;
  /** Unsigned Refund or Capture of a bond; the approver key hash is a required signer. */
  buildBondSpend(bond: BondUtxo, outcome: BondOutcome): Promise<UnsignedTx>;
  /** Submits a fully signed tx (hex CBOR) as is. The hash is computed locally, so a node rejection still names the tx. */
  submitSigned(txCbor: string): Promise<{ tx_hash: string; accepted: boolean; detail: string }>;
}

/** CRE verification (verifyInvoice behind it). The trigger id is chosen by the API, never by a caller. */
export type Verify = (action: ActionIR, triggerId: string) => Promise<VerificationOutcome>;

/** The vendor's invoice as Stripe holds it (read-only key). null = no such invoice. */
export type ReadInvoice = (invoiceId: string) => Promise<{ number: string | null } | null>;

/** Marks the Stripe invoice paid out of band with the Cardano tx hash. Safe to retry. */
export type Settle = (invoiceId: string, txHash: string) => Promise<void>;

/** Turns plain English into an untrusted Action IR candidate (LLM). Its output is evaluated unsigned. */
export type Interpret = (text: string, mandate: Mandate) => Promise<unknown>;

export type VaultAttack = 'recipient_swap' | 'amount_swap' | 'replay' | 'expired' | 'revoked' | 'daily_cap' | 'cfo_bypass';
export type LabEventType =
  | 'TransactionBuilt'
  | 'TransactionSubmitted'
  | 'TransactionConfirmed'
  | 'TransactionRejected'
  | 'MandateUpdated';

export interface LabContext {
  /** Runs the real Authority Check on M-LAB for an open lab invoice, signed with the lab agent key. */
  authorize(invoiceNumber: string): Promise<AuthorizationRecord>;
  /** Signs out-of-policy fields with the M-LAB engine key directly (stolen-key simulation). */
  forge(fields: AuthorizationFields): Promise<AuthorizationRecord>;
  record(type: LabEventType, actionId: string | null, payload: Record<string, unknown>): Promise<void>;
}

export interface LabKeys {
  engine: Uint8Array;
  agent: Uint8Array;
}

export interface LabInvoice {
  id: string;
  amount_usdm: string;
  payout_address: string;
}

export interface LabDeps {
  runner: LabRunner | null;
  keys: LabKeys;
  /** Open lab invoice by number, read with the Stripe read key. */
  invoice: (number: string) => Promise<LabInvoice | null>;
}

export interface LabRunner {
  /**
   * Performs one real attempt on preprod. Returns the vault invariant that stopped it and the attempted tx.
   * `outcome: 'not_primed'` means no attack transaction was submitted; callers must not record that as a result.
   */
  run(
    attack: VaultAttack,
    ctx: LabContext,
  ): Promise<{ code: string; tx_hash: string | null; funds_moved: string; outcome?: 'submitted' | 'not_primed' }>;
}
