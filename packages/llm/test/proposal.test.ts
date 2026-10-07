import { ActionIRSchema } from '@authority/core';
import { describe, expect, it } from 'vitest';
import { buildAction, decimalToUnits, ProposalArgsError, PROPOSE_TOOL_SCHEMA, unitsToDecimal } from '../src';

const AWS = 'addr_test1vzs6rgdp5xs6rgdp5xs6rgdp5xs6rgdp5xs6rgdp5xs6rggfw5wvl';
const ctx = {
  id: 'A-1a2b3c4d-1',
  mandate: { id: 'M-001', delegate: { type: 'agent' as const, id: 'cfo-agent-01', public_key: `ed25519:${'11'.repeat(32)}` }, asset: { symbol: 'USDM', decimals: 6 } },
  sourceVault: 'acme-treasury',
  nowIso: '2026-10-07T03:41:02.123Z',
};
const args = {
  type: 'pay_invoice',
  purpose: 'invoice_payment',
  counterparty_id: 'aws',
  counterparty_display: 'AWS (demo vendor)',
  amount: '8.42',
  recipient_address: AWS,
  invoice: { invoice_id: 'in_1SxAbc', invoice_number: 'INV-3821' },
  rationale: 'Invoice INV-3821 is open and matches an approved cloud expense.',
};

describe('buildAction', () => {
  it('builds strict Action IR with runtime identity, base units, and the asset from the mandate', () => {
    const a = buildAction(args, ctx);
    expect(ActionIRSchema.parse(a)).toEqual(a);
    expect(a).toEqual({
      schema: 'action-ir/v0.1',
      id: 'A-1a2b3c4d-1',
      mandate_id: 'M-001',
      actor: 'cfo-agent-01',
      type: 'pay_invoice',
      purpose: 'invoice_payment',
      counterparty: { id: 'aws', display: 'AWS (demo vendor)' },
      amount: { value: '8420000', asset: 'USDM' },
      recipient: { chain: 'cardano', address: AWS },
      source: { vault: 'acme-treasury' },
      reference: { invoice_id: 'in_1SxAbc', invoice_number: 'INV-3821' },
      rationale: 'Invoice INV-3821 is open and matches an approved cloud expense.',
      created_at: '2026-10-07T03:41:02.123Z',
    });
  });

  it('omits the reference for a purchase without an invoice', () => {
    const { invoice: _drop, ...rest } = args;
    expect(buildAction({ ...rest, type: 'purchase', purpose: 'digital_collectibles', amount: '2' }, ctx).reference).toBeUndefined();
  });

  it.each([
    ['amount as a number', { amount: 8.42 }],
    ['more than 6 decimals', { amount: '8.4200001' }],
    ['negative', { amount: '-1' }],
    ['exponent', { amount: '1e3' }],
    ['zero', { amount: '0' }],
    ['the model names the mandate', { mandate_id: 'M-LAB' }],
    ['the model raises a limit', { autonomous_limit: '999' }],
    ['the model sets the actor', { actor: 'cfo' }],
    ['the model sets the asset', { asset: 'ADA' }],
    ['unknown action type', { type: 'withdraw_all' }],
    ['bad bech32 recipient', { recipient_address: 'addr_test1qqqqqqqqqqqqqqqqqqqqqqqqqqqq' }],
    ['not an address', { recipient_address: 'not-an-address' }],
    ['pay_invoice without an invoice', { invoice: undefined }],
    ['invoice with extra fields', { invoice: { invoice_id: 'in_1', invoice_number: 'INV-1', paid: true } }],
    ['rationale too long', { rationale: 'x'.repeat(2001) }],
  ])('rejects %s', (_label, patch) => {
    expect(() => buildAction(JSON.parse(JSON.stringify({ ...args, ...patch })), ctx)).toThrow(ProposalArgsError);
  });
});

describe('amount conversion (no floating point)', () => {
  it.each([
    ['8.42', '8420000'],
    ['60', '60000000'],
    ['0.000001', '1'],
    ['18.00', '18000000'],
  ])('%s USDM = %s base units', (decimal, units) => {
    expect(decimalToUnits(decimal, 6)).toBe(units);
  });
  it('formats base units back to a decimal string', () => {
    expect([unitsToDecimal('8420000', 6), unitsToDecimal('60000000', 6), unitsToDecimal('500000', 6), unitsToDecimal('1', 6)]).toEqual(['8.42', '60', '0.5', '0.000001']);
  });
});

describe('propose_action tool schema', () => {
  it('is a closed JSON Schema object with the required fields', () => {
    expect(PROPOSE_TOOL_SCHEMA).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['type', 'purpose', 'counterparty_id', 'counterparty_display', 'amount', 'recipient_address', 'rationale'],
    });
    expect(PROPOSE_TOOL_SCHEMA).not.toHaveProperty('$schema');
    expect((PROPOSE_TOOL_SCHEMA.properties as any).type.enum).toEqual(['pay_invoice', 'purchase', 'transfer']);
  });
});
