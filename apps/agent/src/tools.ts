import { canonicalHash, type Mandate, signProposal } from '@authority/core';
import {
  buildAction,
  type InvoiceFacts,
  invoiceView,
  NoArgsSchema,
  ProposalArgsError,
  ProposeArgsSchema,
  sourceVaultFor,
  type ToolHandler,
  ToolError,
  toolSchema,
  unitsToDecimal,
} from '@authority/llm';
import { AuthorityError, type AuthorityClient, type Claim, type RunWork, withRetry, type WorkItem } from './authority';

// The agent's whole tool surface. Four tools only read; propose_action is the only one with an effect, and that
// effect is a signed request to the Authority Engine. No tool can write to Stripe, the database, or any chain.

export interface InvoiceSource {
  listOpen(): Promise<InvoiceFacts[]>;
}

export type Resolution = 'denied' | 'authorized' | 'settled' | 'declined' | 'rejected' | 'pending';

export interface ProposalRecord {
  action_id: string;
  action_hash: string;
  invoice_number: string | null;
  recipient: string;
  outcome: string;
  reason: string | null;
  resolution: Resolution;
  receipt_id: string;
  sepolia_tx: string | null;
  tx_hash: string | null;
}

export interface ItemContext {
  authority: AuthorityClient;
  invoices: InvoiceSource;
  claim: Claim;
  work: RunWork;
  mandate: Mandate;
  item: WorkItem;
  actionId: string;
  agentSecretKey: Uint8Array;
  execute: boolean;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  pollMs: number;
  resolveTimeoutMs: number;
  log: (line: Record<string, unknown>) => void;
  /** Set once propose_action has been accepted for this item. */
  out: { proposal: ProposalRecord | null };
}

export const READ_TOOLS = ['list_open_invoices', 'read_mandate', 'read_decision_history', 'read_vendor_messages'] as const;
export const PROPOSE_TOOL = 'propose_action';

const noArgs = (name: string, input: unknown) => {
  if (!NoArgsSchema.safeParse(input ?? {}).success) throw new ToolError(`${name} takes no arguments`);
};
const usdm = (units: string, decimals: number) => unitsToDecimal(units, decimals);

export function agentTools(ctx: ItemContext): ToolHandler[] {
  const decimals = ctx.mandate.asset.decimals;
  const queueNumbers = new Set(ctx.work.queue.flatMap((w) => (w.kind === 'invoice' ? [w.invoice_number] : [])));
  return [
    {
      def: {
        name: 'list_open_invoices',
        description: "Open vendor invoices in today's queue, read from the vendor billing network. Read-only.",
        input_schema: toolSchema(NoArgsSchema),
      },
      effect: 'read',
      async handle(input) {
        noArgs('list_open_invoices', input);
        const open = await ctx.invoices.listOpen();
        return JSON.stringify(open.filter((i) => i.number !== null && queueNumbers.has(i.number)).map((i) => invoiceView(i, decimals)));
      },
    },
    {
      def: { name: 'read_mandate', description: 'The spending mandate you act under, with current vault balance and spend today. Read-only.', input_schema: toolSchema(NoArgsSchema) },
      effect: 'read',
      async handle(input) {
        noArgs('read_mandate', input);
        const v = await ctx.authority.mandate(ctx.mandate.id);
        const values = (kind: string) => v.mandate.constraints.flatMap((c) => (c.kind === kind && 'values' in c ? c.values : []));
        return JSON.stringify({
          mandate_id: v.mandate.id,
          version: v.mandate.version,
          principal: v.mandate.principal.name,
          delegate: v.mandate.delegate.id,
          asset: v.limits.symbol,
          allowed_purposes: values('purpose_in'),
          allowed_actions: values('action_in'),
          approved_counterparties: values('counterparty_in'),
          autonomous_limit: usdm(v.limits.autonomous_limit, decimals),
          hard_cap: usdm(v.limits.hard_cap, decimals),
          daily_cap: usdm(v.limits.daily_cap, decimals),
          treasury_minimum: usdm(v.limits.treasury_minimum, decimals),
          approver: v.mandate.approvers.map((a) => a.role),
          vault_balance: usdm(v.vault.balance, decimals),
          spent_today: usdm(v.vault.spent_today, decimals),
          valid_until: v.mandate.validity.expires_at,
        });
      },
    },
    {
      def: { name: 'read_decision_history', description: 'Recent Authority Engine decisions on your proposals under this mandate, newest first. Read-only.', input_schema: toolSchema(NoArgsSchema) },
      effect: 'read',
      async handle(input) {
        noArgs('read_decision_history', input);
        const rows = await ctx.authority.decisions(ctx.mandate.id);
        return JSON.stringify(rows.slice(0, 20).map((d) => ({ ...d, amount: usdm(d.amount, decimals) })));
      },
    },
    {
      def: { name: 'read_vendor_messages', description: 'The accounts-payable inbox: vendor emails and internal requests received today. Read-only.', input_schema: toolSchema(NoArgsSchema) },
      effect: 'read',
      async handle(input) {
        noArgs('read_vendor_messages', input);
        return JSON.stringify(ctx.work.messages);
      },
    },
    {
      def: {
        name: PROPOSE_TOOL,
        description:
          'Propose one payment for this work item to the Authority Engine. It is signed as your proposal and checked against the mandate, the vendor billing records, and the CFO where approval is needed. Returns the decision. At most one call per work item.',
        input_schema: toolSchema(ProposeArgsSchema),
      },
      effect: 'proposal',
      handle: (input) => propose(ctx, input),
    },
  ];
}

async function propose(ctx: ItemContext, input: unknown): Promise<string> {
  if (ctx.out.proposal) throw new ToolError(`this work item already has a proposal (${ctx.out.proposal.action_id}); reply with your summary`);
  let action;
  try {
    action = buildAction(input, { id: ctx.actionId, mandate: ctx.mandate, sourceVault: sourceVaultFor(ctx.mandate.id), nowIso: new Date(ctx.now()).toISOString() });
  } catch (error) {
    if (error instanceof ProposalArgsError) throw new ToolError(error.message);
    throw error;
  }
  if (ctx.item.kind === 'invoice' && action.reference?.invoice_number !== ctx.item.invoice_number) {
    throw new ToolError(`this work item is invoice ${ctx.item.invoice_number}; a proposal for it must reference that invoice`);
  }
  const actionHash = canonicalHash(action);
  const proposal = { action, agent_signature: signProposal(actionHash, ctx.agentSecretKey) };
  let reply;
  try {
    reply = await withRetry(
      () => ctx.authority.check({ mandate_id: ctx.mandate.id, proposal, execute: ctx.execute, run_id: ctx.claim.run_id }, `agent:${ctx.claim.run_id}:${action.id}`),
      { attempts: 5, sleep: ctx.sleep },
    );
  } catch (error) {
    // A refused request (bad body, run not active) is reported to the model; auth and outages end the run.
    if (error instanceof AuthorityError && [400, 404, 409, 422].includes(error.status)) throw new ToolError(error.message);
    throw error;
  }
  const { outcome, reason } = reply.evaluation;
  ctx.log({ event: 'proposal', run_id: ctx.claim.run_id, action_id: action.id, action_hash: actionHash, invoice: action.reference?.invoice_number ?? null, recipient: action.recipient.address, outcome, reason, receipt_id: reply.receipt_id });
  const resolved = await resolve(ctx, action.id, outcome);
  const record: ProposalRecord = {
    action_id: action.id,
    action_hash: actionHash,
    invoice_number: action.reference?.invoice_number ?? null,
    recipient: action.recipient.address,
    outcome,
    reason: resolved.reason ?? reason,
    resolution: resolved.resolution,
    receipt_id: reply.receipt_id,
    sepolia_tx: reply.verification?.sepolia_tx ?? null,
    tx_hash: resolved.tx_hash,
  };
  ctx.out.proposal = record;
  ctx.log({ event: 'resolved', run_id: ctx.claim.run_id, action_id: action.id, resolution: record.resolution, reason: record.reason, tx_hash: record.tx_hash });
  return JSON.stringify({ action_id: record.action_id, outcome, reason: record.reason, result: record.resolution, receipt_id: record.receipt_id, tx_hash: record.tx_hash });
}

/** Follows the run log until the decision is final: settled, declined, denied, rejected, or still pending at the timeout. */
async function resolve(ctx: ItemContext, actionId: string, outcome: string): Promise<{ resolution: Resolution; reason: string | null; tx_hash: string | null }> {
  if (outcome === 'DENY') return { resolution: 'denied', reason: null, tx_hash: null };
  if (outcome === 'ALLOW' && !ctx.execute) return { resolution: 'authorized', reason: null, tx_hash: null };
  const deadline = ctx.now() + ctx.resolveTimeoutMs;
  for (;;) {
    const mine = (await withRetry(() => ctx.authority.events(ctx.claim.run_id), { attempts: 5, sleep: ctx.sleep })).filter((e) => e.action_id === actionId);
    const has = (type: string) => mine.find((e) => e.type === type);
    const txHash = (has('TransactionConfirmed')?.payload?.tx_hash as string | undefined) ?? null;
    if (has('ReceiptProven')) return { resolution: 'settled', reason: null, tx_hash: txHash };
    const rejected = has('TransactionRejected');
    if (rejected) return { resolution: 'rejected', reason: String(rejected.payload?.invariant ?? 'REJECTED'), tx_hash: null };
    if (has('CFODeclined')) return { resolution: 'declined', reason: 'PRINCIPAL_DECLINED', tx_hash: null };
    const denied = has('ActionDenied');
    if (denied) return { resolution: 'denied', reason: String(denied.payload?.reason ?? 'DENY'), tx_hash: null };
    if (ctx.now() >= deadline) return { resolution: 'pending', reason: null, tx_hash: null };
    await ctx.sleep(ctx.pollMs);
  }
}
