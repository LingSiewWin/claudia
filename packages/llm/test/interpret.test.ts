import { ActionIRSchema, type Mandate } from '@authority/core';
import { describe, expect, it } from 'vitest';
import { createInterpreter, type InvoiceFacts } from '../src';
import { lastResults, say, scriptedModel, useTool } from '../src/scripted';

const AWS = 'addr_test1vzs6rgdp5xs6rgdp5xs6rgdp5xs6rgdp5xs6rgdp5xs6rggfw5wvl';
const mandate = { id: 'M-001', delegate: { type: 'agent', id: 'cfo-agent-01', public_key: `ed25519:${'11'.repeat(32)}` }, asset: { symbol: 'USDM', decimals: 6 } } as Mandate;
const invoice: InvoiceFacts = {
  id: 'in_M0001',
  number: 'INV-M-0001',
  status: 'open',
  vendor_id: 'aws',
  vendor_name: 'AWS (demo vendor)',
  amount_usdm: '8420000',
  currency: 'usd',
  due_date: null,
  memo: 'Cloud compute, October',
  payout_chain: 'cardano-preprod',
  payout_address: AWS,
};
const find = async (n: string) => (n === invoice.number ? invoice : null);

describe('createInterpreter', () => {
  it('turns plain English into an unsigned Action IR built from the invoice it looked up', async () => {
    const model = scriptedModel((input, call) => {
      if (call === 0) return useTool('find_invoice', { invoice_number: 'INV-M-0001' });
      if (call === 2) return say('Submitted.');
      const facts = JSON.parse(lastResults(input)[0]!.content);
      expect(facts).toMatchObject({ amount_due_usdm: '8.42', payout_address: AWS });
      return useTool('submit_action', {
        type: 'pay_invoice',
        purpose: 'invoice_payment',
        counterparty_id: facts.vendor_id,
        counterparty_display: facts.vendor_name,
        amount: facts.amount_due_usdm,
        recipient_address: facts.payout_address,
        invoice: { invoice_id: facts.invoice_id, invoice_number: facts.invoice_number },
        rationale: 'Requested: pay AWS invoice INV-M-0001.',
      });
    });
    const out = await createInterpreter({ model, findInvoice: find, now: () => Date.parse('2026-10-07T03:00:00.000Z') })('Pay AWS invoice INV-M-0001', mandate);
    const action = ActionIRSchema.parse(out);
    expect(action).toMatchObject({ mandate_id: 'M-001', actor: 'cfo-agent-01', amount: { value: '8420000', asset: 'USDM' }, created_at: '2026-10-07T03:00:00.000Z' });
    expect(action.id).toMatch(/^I-[0-9a-f]{8}$/);
    expect(model.inputs[0]!.messages[0]).toEqual({ role: 'user', content: [{ type: 'text', text: 'Request: Pay AWS invoice INV-M-0001' }] });
  });

  it('returns a visible non-action when the model submits nothing (the engine then denies INVALID_PROPOSAL)', async () => {
    const model = scriptedModel(() => say('I cannot tell what to pay.'));
    expect(await createInterpreter({ model, findInvoice: find })('do something', mandate)).toEqual({ interpreted: false, reason: 'I cannot tell what to pay.' });
  });

  it('accepts exactly one submission', async () => {
    const args = { type: 'purchase', purpose: 'digital_collectibles', counterparty_id: 'nft-marketplace', counterparty_display: 'NFT marketplace', amount: '2', recipient_address: AWS, rationale: 'r' };
    const model = scriptedModel((input, call) => {
      if (call < 2) return useTool('submit_action', args);
      expect(lastResults(input)[0]).toMatchObject({ is_error: true, content: 'an action was already submitted' });
      return say('ok');
    });
    expect(ActionIRSchema.safeParse(await createInterpreter({ model, findInvoice: find })('buy an nft', mandate)).success).toBe(true);
  });
});
