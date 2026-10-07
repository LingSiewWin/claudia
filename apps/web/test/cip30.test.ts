import { describe, expect, it } from 'vitest';
import { paymentKeyHash, walletErrorText } from '../lib/cip30';

// Payment key hash of the recorded fixture approver (a fixed TEST key), as CIP-30 hex address bytes.
const APPROVER_PKH = '8b218424ad74df25d35c2ea8e094a4c5c5aeb2cbb442419331569313';
const APPROVER_HEX = `00${APPROVER_PKH}${'cd'.repeat(28)}`;

describe('paymentKeyHash', () => {
  it('reads the payment key hash from a CIP-30 hex address', () => {
    expect(paymentKeyHash(APPROVER_HEX)).toBe(APPROVER_PKH);
  });
  it('returns null for script payment credentials, short or non-hex input', () => {
    expect(paymentKeyHash(`10${'11'.repeat(56)}`)).toBeNull();
    expect(paymentKeyHash('00abcd')).toBeNull();
    expect(paymentKeyHash('zz')).toBeNull();
  });
});

describe('walletErrorText', () => {
  it('names the CIP-30 error codes in plain words', () => {
    expect(walletErrorText({ code: 2, info: 'user declined' })).toMatch(/declined/);
    expect(walletErrorText({ code: -3, info: 'x' })).toMatch(/refused/);
    expect(walletErrorText({ code: -4, info: 'x' })).toMatch(/account changed/);
    expect(walletErrorText(new Error('boom'))).toBe('boom');
  });

  it('reads signData error codes, which differ from signTx (3 is the user declining, 2 is not a key address)', () => {
    expect(walletErrorText({ code: 3, info: 'x' }, 'signData')).toMatch(/declined/);
    expect(walletErrorText({ code: 2, info: 'x' }, 'signData')).toMatch(/cannot sign messages/);
    expect(walletErrorText({ code: 3, info: 'x' }, 'signTx')).not.toMatch(/declined/);
  });
});
