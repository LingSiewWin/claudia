import { type EscalationPrice, EscalationPriceSchema, formatUnits } from '@authority/core';
import { AuthorityError, type AuthorityClient, type CheckBody, type CheckReply, withRetry } from './authority';
import type { BondRef, PaymentPayload, PaymentRequired, PaymentRequirements } from './x402';

// The agent pays the escalation bond from its own wallet; it never holds vault keys. See x402.ts for the wire format.

/** Locks the bond on chain. The real one spends from the agent wallet; tests use `fakeBondPayer`. */
export interface BondPayer {
  pay(price: EscalationPrice, accepted: PaymentRequirements): Promise<BondRef>;
}

/** Connects lazily, so an agent that never escalates needs no wallet or Blockfrost project. */
export function cardanoBondPayer(env: Record<string, string | undefined>): BondPayer {
  let ready: Promise<{ chain: import('@authority/cardano').Chain; wallet: import('@authority/cardano').SigningWallet }> | null = null;
  const connectOnce = () =>
    (ready ??= (async () => {
      const cardano = await import('@authority/cardano');
      const chain = await cardano.connect(env.BLOCKFROST_PROJECT_ID_PREPROD);
      const wallet = await cardano.walletFromMnemonic(chain, env.AGENT_WALLET_MNEMONIC, 'AGENT_WALLET_MNEMONIC');
      return { chain, wallet };
    })());
  return {
    async pay(price) {
      const { chain, wallet } = await connectOnce();
      const { lockBond } = await import('@authority/cardano');
      const utxo = await lockBond(chain, wallet, price);
      return { tx_hash: utxo.tx_hash, output_index: utxo.output_index };
    },
  };
}

export function fakeBondPayer(o: { fail?: Error } = {}) {
  const calls: { price: EscalationPrice; accepted: PaymentRequirements }[] = [];
  const payer: BondPayer & { calls: typeof calls } = {
    calls,
    async pay(price, accepted) {
      if (o.fail) throw o.fail;
      calls.push({ price, accepted });
      return { tx_hash: `b0${calls.length.toString(16).padStart(2, '0')}`.padEnd(64, 'f'), output_index: 0 };
    },
  };
  return payer;
}

/** A 402 the agent will not pay. The model sees the message; the proposal was evaluated but no human is paged. */
export class BondRefused extends Error {
  override name = 'BondRefused';
  constructor(
    readonly reason: 'BOND_ABOVE_MAX' | 'BOND_ASSET_UNSUPPORTED' | 'BOND_PRICE_INVALID' | 'INTERRUPT_BUDGET_EXHAUSTED' | 'BOND_PAYMENT_FAILED' | 'BOND_NOT_ACCEPTED',
    message: string,
  ) {
    super(message);
  }
}

export const DAY_MS = 86_400_000;
/** How many times a paid bond is re-presented while the API waits to see the lock on chain, and the pause between. */
const BOND_ROUNDS = 6;
const BOND_WAIT_MS = 10_000;
export const dayIndex = (ms: number) => Math.floor(ms / DAY_MS);

/** Process-wide escalation state: bonds already paid (never pay twice) and mandates whose interrupt budget is gone today. */
export interface EscalationState {
  paid: Map<string, BondRef>;
  exhausted: Map<string, number>;
}
export const newEscalationState = (): EscalationState => ({ paid: new Map(), exhausted: new Map() });

export const budgetExhausted = (state: EscalationState, mandateId: string, nowMs: number) => state.exhausted.get(mandateId) === dayIndex(nowMs);

export interface RunSummary {
  escalations: number;
  bonds_paid: number;
  bonds_refunded: number;
  budget_denials: number;
}
export const newSummary = (): RunSummary => ({ escalations: 0, bonds_paid: 0, bonds_refunded: 0, budget_denials: 0 });

export interface BondContext {
  authority: AuthorityClient;
  payer: BondPayer;
  maxBondLovelace: bigint;
  state: EscalationState;
  summary: RunSummary;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log: (line: Record<string, unknown>) => void;
}

/** Validates the 402 against the seam and the agent's own limits; returns the price to lock. */
export function priceOf(required: PaymentRequired, maxBondLovelace: bigint): { price: EscalationPrice; accepted: PaymentRequirements } {
  const accepted = required.accepts[0]!;
  if (required.x402Version !== 2) throw new BondRefused('BOND_PRICE_INVALID', `unsupported x402Version ${required.x402Version}`);
  if (accepted.scheme !== 'cardano-escrow') throw new BondRefused('BOND_PRICE_INVALID', `unsupported payment scheme ${accepted.scheme}`);
  const parsed = EscalationPriceSchema.safeParse(accepted.extra);
  if (!parsed.success) throw new BondRefused('BOND_PRICE_INVALID', 'the 402 price is not a valid escalation price');
  const price = parsed.data;
  if (accepted.asset !== 'lovelace' || price.asset.symbol !== 'ADA' || price.asset.policy_id !== '') {
    throw new BondRefused('BOND_ASSET_UNSUPPORTED', `the agent pays bonds in ADA only, not ${accepted.asset}`);
  }
  if (accepted.amount !== price.amount) throw new BondRefused('BOND_PRICE_INVALID', 'the 402 amount and the escalation price disagree');
  if (BigInt(price.amount) > maxBondLovelace) {
    throw new BondRefused('BOND_ABOVE_MAX', `the escalation bond is ${formatUnits(price.amount, 6)} ADA, above this agent's limit of ${formatUnits(maxBondLovelace.toString(), 6)} ADA`);
  }
  return { price, accepted };
}

/**
 * One authority check that pays the escalation bond when asked. The retry reuses the idempotency key, so the API
 * sees one proposal. A bond is paid at most once per approval: a 402 repeated after payment (the lock not yet
 * visible to the API) is retried with the same bond, never with a new one. A budget denial closes escalation for the day.
 */
export async function checkWithBond(ctx: BondContext, body: CheckBody, key: string): Promise<CheckReply> {
  const attempt = (payment?: PaymentPayload) => withRetry(() => ctx.authority.check(body, key, payment), { attempts: 5, sleep: ctx.sleep });
  let payment: PaymentPayload | undefined;
  let reply: CheckReply;
  for (let round = 0; ; round++) {
    try {
      reply = await attempt(payment);
      break;
    } catch (error) {
      if (!(error instanceof AuthorityError) || error.status !== 402 || !error.paymentRequired) throw error;
      const required = error.paymentRequired;
      const approvalId = (required.accepts[0]?.extra as { approval_id?: unknown } | undefined)?.approval_id;
      if (!ctx.state.paid.has(String(approvalId))) ctx.summary.escalations += 1;
      const { price, accepted } = priceOf(required, ctx.maxBondLovelace);
      if (budgetExhausted(ctx.state, body.mandate_id, ctx.now())) {
        throw new BondRefused('INTERRUPT_BUDGET_EXHAUSTED', `the interrupt budget for ${body.mandate_id} is exhausted today; the bond was not paid`);
      }
      let bond = ctx.state.paid.get(price.approval_id);
      if (bond) {
        if (round >= BOND_ROUNDS) throw new BondRefused('BOND_NOT_ACCEPTED', `bond ${bond.tx_hash} for ${price.approval_id} is locked but the API still asks for it`);
        ctx.log({ event: 'bond_reused', approval_id: price.approval_id, tx_hash: bond.tx_hash, round });
        await ctx.sleep(BOND_WAIT_MS);
      } else {
        try {
          bond = await ctx.payer.pay(price, accepted);
        } catch (payError) {
          throw new BondRefused('BOND_PAYMENT_FAILED', `the bond could not be locked: ${(payError as Error).message}`);
        }
        ctx.state.paid.set(price.approval_id, bond);
        ctx.summary.bonds_paid += 1;
        ctx.log({ event: 'bond_locked', approval_id: price.approval_id, amount: price.amount, asset: price.asset.symbol, tx_hash: bond.tx_hash, output_index: bond.output_index, escrow_address: price.escrow_address });
      }
      payment = { x402Version: 2, accepted, payload: { approval_id: price.approval_id, ...bond } };
    }
  }
  if (payment && reply.settlement) ctx.log({ event: 'bond_settled', approval_id: payment.payload.approval_id, success: reply.settlement.success, network: reply.settlement.network, tx_hash: reply.settlement.transaction });
  if (reply.evaluation.outcome === 'DENY' && reply.evaluation.reason === 'INTERRUPT_BUDGET_EXHAUSTED') {
    ctx.summary.budget_denials += 1;
    if (!budgetExhausted(ctx.state, body.mandate_id, ctx.now())) {
      ctx.state.exhausted.set(body.mandate_id, dayIndex(ctx.now()));
      ctx.log({ event: 'budget_exhausted', mandate_id: body.mandate_id, message: 'interrupt budget exhausted; no human paged' });
    }
  }
  return reply;
}

/** Deterministic cost line for the planner: what an escalation costs and how much human attention is left today. */
export function costLine(o: { autonomousLimit: string; asset: string; price: { amount: string; asset: string } | null; budget: { used: number; per_day: number } | null; exhausted: boolean }): string {
  const bond = o.price ? `${formatUnits(o.price.amount, 6)} ${o.price.asset}` : 'a bond';
  const remaining = o.exhausted ? 0 : o.budget ? Math.max(0, o.budget.per_day - o.budget.used) : null;
  const budget = o.budget ? `${remaining} of ${o.budget.per_day}` : 'unknown';
  const head = `Escalation cost: a proposal above the autonomous limit of ${o.autonomousLimit} ${o.asset} (or to a counterparty not yet approved) pages the approver and locks ${bond} from the agent wallet as a bond, refunded unless the request is frivolous. Interrupt budget today: ${budget} left.`;
  return remaining === 0 ? `${head} Any proposal that needs approval will be denied without paging anyone; propose only what is within the autonomous limit.` : head;
}
