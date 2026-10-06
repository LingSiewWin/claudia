import { describe, expect, it } from 'vitest';
import { actionTitle, formatUnits, money, parseUnits, plainReason } from '../lib/format';

describe('formatUnits / parseUnits', () => {
  it.each([
    ['8420000', '8.42'],
    ['18000000', '18.00'],
    ['500000', '0.50'],
    ['1', '0.000001'],
    ['135000000', '135.00'],
    ['0', '0.00'],
  ])('%s -> %s', (units, text) => {
    expect(formatUnits(units)).toBe(text);
    expect(parseUnits(text).toString()).toBe(units);
  });

  it.each(['-1', '1.0000001', 'abc', '', '1e6', '0x10'])('rejects %j', (bad) => {
    expect(() => parseUnits(bad)).toThrow();
  });
});

describe('money and actionTitle (business objects first)', () => {
  it('shows the real on-chain amount with a currency mark, grouped', () => {
    expect([money('8420000'), money('18000000'), money('8420000000'), money('135000000')]).toEqual(['$8.42', '$18.00', '$8,420.00', '$135.00']);
    expect([money('10000000', 6, true), money('0', 6, true), money('500000', 6, true)]).toEqual(['$10', '$0', '$0.50']);
  });

  it('names the business object, not the protocol', () => {
    expect(actionTitle({ type: 'pay_invoice', counterparty: { display: 'AWS (demo vendor)' } })).toBe('AWS invoice');
    expect(actionTitle({ type: 'pay_invoice', counterparty: { display: 'Globex (demo vendor)' } })).toBe('Globex invoice');
    expect(actionTitle({ type: 'purchase', counterparty: { display: 'NFT marketplace' } })).toBe('NFT marketplace purchase');
  });
});

describe('plainReason', () => {
  it('maps reason codes and vault invariants to plain words', () => {
    expect(plainReason('TREASURY_FLOOR_VIOLATION')).toMatch(/minimum balance/);
    expect(plainReason('R16')).toMatch(/recipient/);
    expect(plainReason('SOMETHING_NEW')).toBe('SOMETHING_NEW');
  });
});
