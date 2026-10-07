import { randomUUID } from 'node:crypto';
import type { ActionIR, Mandate } from '@authority/core';
import * as z from 'zod';
import { type InvoiceFacts, invoiceView } from './invoice';
import { converse, type ToolHandler, ToolError } from './loop';
import type { AgentModel } from './model';
import { buildAction, ProposalArgsError, ProposeArgsSchema, sourceVaultFor, toolSchema } from './proposal';

// Plain-English request -> UNTRUSTED interpreted Action IR. The output is returned to the caller verbatim and
// evaluated unsigned, so it can never yield an authorization; a wrong interpretation is visible, not dangerous.

export type FindInvoice = (invoiceNumber: string) => Promise<InvoiceFacts | null>;

const FindArgs = z.strictObject({ invoice_number: z.string().min(1).max(64).describe('Invoice number, for example INV-3821') });

const SYSTEM = [
  'You convert one plain-English payment request into one structured action for an authority check.',
  'Look up any invoice the request names with find_invoice and take amount, vendor, and payout address from it.',
  'Then call submit_action exactly once. Do not invent invoice ids or addresses. If the request is not a payment, still',
  'submit the closest action with the purpose it states. Amounts are USDM decimal strings.',
].join(' ');

export function createInterpreter(o: { model: AgentModel; findInvoice: FindInvoice; now?: () => number; maxTurns?: number }) {
  const now = o.now ?? Date.now;
  return async (text: string, mandate: Mandate): Promise<unknown> => {
    const out: { action: ActionIR | null } = { action: null };
    const id = `I-${randomUUID().slice(0, 8)}`;
    const tools: ToolHandler[] = [
      {
        def: { name: 'find_invoice', description: 'Read one open invoice by its number. Read-only.', input_schema: toolSchema(FindArgs) },
        effect: 'read',
        async handle(input) {
          const args = FindArgs.safeParse(input);
          if (!args.success) throw new ToolError('find_invoice needs { invoice_number }');
          const inv = await o.findInvoice(args.data.invoice_number);
          return JSON.stringify(inv ? invoiceView(inv, mandate.asset.decimals) : { found: false, invoice_number: args.data.invoice_number });
        },
      },
      {
        def: { name: 'submit_action', description: 'Submit the interpreted action (evaluated unsigned).', input_schema: toolSchema(ProposeArgsSchema) },
        effect: 'proposal',
        async handle(input) {
          if (out.action) throw new ToolError('an action was already submitted');
          try {
            out.action = buildAction(input, { id, mandate, sourceVault: sourceVaultFor(mandate.id), nowIso: new Date(now()).toISOString() });
          } catch (error) {
            if (error instanceof ProposalArgsError) throw new ToolError(error.message);
            throw error;
          }
          return 'submitted';
        },
      },
    ];
    const conv = await converse({ model: o.model, system: SYSTEM, prompt: `Request: ${text}`, tools, maxTurns: o.maxTurns ?? 4 });
    return out.action ?? { interpreted: false, reason: conv.finalText.slice(0, 500) || 'the model did not produce an action' };
  };
}
