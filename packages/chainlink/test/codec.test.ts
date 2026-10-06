import { canonicalHash, type VerificationReport } from '@authority/core';
import { decodeAbiParameters, keccak256 } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  encodeReportPayload,
  FIELDS_COMPONENTS,
  reportFromStored,
  resultFromFacts,
  type StoredFields,
  toStoredFields,
} from '../src/codec';
import { FIXTURE } from './fixtures';

const NOT_FOUND: VerificationReport = {
  ...FIXTURE,
  invoice_hash: '33'.repeat(32),
  verified_amount: null,
  verified_currency: null,
  verified_recipient: null,
  status: null,
  facts: { exists: false, customer_match: false, status_open: false, amount_match: false, currency_match: false, recipient_match: false },
  result: 'MISMATCH',
  reason: 'INVOICE_NOT_FOUND',
};

const decode = (payload: `0x${string}`) =>
  decodeAbiParameters([{ type: 'bytes32' }, { type: 'tuple', components: FIELDS_COMPONENTS }], payload);

describe('codec', () => {
  it('pins report hash and payload bytes shared with the Solidity tests', () => {
    const { reportHash, payload } = encodeReportPayload(FIXTURE);
    expect(reportHash).toBe('88f9d335471c38761b4d7dc922ad546c9f697699081ca66a9cfeaf878eed0e4d');
    expect(keccak256(payload)).toBe('0x4c88696423293eb6ceab77dab06eaa7e4d8a242c0da924ce9b6be7e881f0a876');
  });

  it.each([['VERIFIED', FIXTURE], ['MISMATCH with nulls', NOT_FOUND]] as const)('round-trips %s losslessly', (_l, report) => {
    const { reportHash, payload } = encodeReportPayload(report);
    const [hash, fields] = decode(payload);
    expect(hash).toBe(`0x${reportHash}`);
    const back = reportFromStored(fields as StoredFields);
    expect(back).toEqual(report);
    expect(canonicalHash(back)).toBe(reportHash);
  });

  it('encodes facts as a bitmask in spec order and reasons as 1-based codes', () => {
    const s = toStoredFields({ ...FIXTURE, facts: { ...FIXTURE.facts, recipient_match: false }, result: 'MISMATCH', reason: 'RECIPIENT_MISMATCH' });
    expect(s.facts).toBe(0b011111);
    expect(s.result).toBe(2);
    expect(s.reason).toBe(6);
  });

  it('derives the single reason from the first failing fact', () => {
    expect(resultFromFacts(FIXTURE.facts)).toEqual({ result: 'VERIFIED', reason: null });
    expect(resultFromFacts({ ...FIXTURE.facts, status_open: false, recipient_match: false })).toEqual({
      result: 'MISMATCH',
      reason: 'INVOICE_NOT_OPEN',
    });
  });

  it.each([
    ['result 0', { result: 0 }],
    ['result 3', { result: 3 }],
    ['reason 7', { reason: 7 }],
    ['facts 64', { facts: 64 }],
  ])('rejects unknown stored code: %s', (_l, patch) => {
    expect(() => reportFromStored({ ...toStoredFields(FIXTURE), ...patch })).toThrow(RangeError);
  });
});
