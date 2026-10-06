import { canonicalHash } from '@authority/core';
import { stringToHex } from 'viem';
import { describe, expect, it } from 'vitest';
import { reportFromStored, type StoredFields, toStoredFields } from '../src/codec';
import { readReportAtTx, type StoredReport, verifyStoredReport } from '../src/reader';
import { FIXTURE, fakeChain, REGISTRY } from './fixtures';

const expected = { actionHash: FIXTURE.action_hash, triggerId: FIXTURE.trigger_id };
const stored = (fields: StoredFields = toStoredFields(FIXTURE)): StoredReport => ({
  reportHash: `0x${canonicalHash(FIXTURE)}`,
  fields,
  blockTime: 1_800_000_000n,
});
// An attacker who can write the registry can also recompute a consistent hash.
const forged = (fields: StoredFields): StoredReport => ({ ...stored(fields), reportHash: `0x${canonicalHash(reportFromStored(fields))}` });

describe('verifyStoredReport: trust only Sepolia reports whose hash matches', () => {
  it('accepts the untampered report and converts block time to ms', () => {
    const v = verifyStoredReport(stored(), expected);
    expect(v.report).toEqual(FIXTURE);
    expect(v.report_hash).toBe(canonicalHash(FIXTURE));
    expect(v.block_time_ms).toBe(1_800_000_000_000);
  });

  it.each([
    ['recipient', { verifiedRecipient: stringToHex('addr_test1attacker') }],
    ['amount', { verifiedAmount: '84200000' }],
    ['currency', { verifiedCurrency: 'eur' }],
    ['status', { status: 'paid' }],
    ['invoice id', { invoiceId: 'in_1QxOther0002' }],
    ['one fact bit', { facts: 0b011111, result: 2, reason: 6 }],
    ['trigger id', { triggerId: 'replayed' }],
  ])('rejects a stored report with a tampered %s', (_l, patch) => {
    expect(() => verifyStoredReport(stored({ ...toStoredFields(FIXTURE), ...patch }), expected)).toThrow('report hash mismatch');
  });

  it('rejects a consistent forgery for another trigger (replayed or front-run report)', () => {
    expect(() => verifyStoredReport(forged({ ...toStoredFields(FIXTURE), triggerId: 'other-trigger' }), expected)).toThrow(
      'report is for another trigger',
    );
  });

  it('rejects a report for another action', () => {
    expect(() => verifyStoredReport(forged({ ...toStoredFields(FIXTURE), actionHash: `0x${'99'.repeat(32)}` }), expected)).toThrow(
      'report is for another action',
    );
  });

  it('rejects VERIFIED with a failed fact even when the hash matches', () => {
    expect(() => verifyStoredReport(forged({ ...toStoredFields(FIXTURE), facts: 0b011111 }), expected)).toThrow(
      'result inconsistent with facts',
    );
  });

  it('rejects stored fields that break the report schema', () => {
    expect(() => verifyStoredReport(forged({ ...toStoredFields(FIXTURE), verifiedAmount: '1.5' }), expected)).toThrow(
      'stored report fails schema',
    );
  });
});

describe('readReportAtTx: reads only the configured registry', () => {
  const tx = `0x${'ab'.repeat(32)}` as const;

  it('reads latestReport from the registry at the block of the write', async () => {
    const { client, reads } = fakeChain(FIXTURE);
    const s = await readReportAtTx(client, REGISTRY, FIXTURE.action_hash, tx);
    expect(verifyStoredReport(s, expected).report).toEqual(FIXTURE);
    expect(reads).toEqual([
      { address: REGISTRY, abi: expect.anything(), functionName: 'latestReport', args: [`0x${FIXTURE.action_hash}`], blockNumber: 7n },
    ]);
  });

  it('ignores an InvoiceVerified event emitted by another contract', async () => {
    const { client, reads } = fakeChain(FIXTURE, { emitter: '0x000000000000000000000000000000000000dEaD' });
    await expect(readReportAtTx(client, REGISTRY, FIXTURE.action_hash, tx)).rejects.toThrow('has 0 InvoiceVerified events');
    expect(reads).toEqual([]);
  });

  it('rejects a reverted write', async () => {
    const { client } = fakeChain(FIXTURE, { status: 'reverted' });
    await expect(readReportAtTx(client, REGISTRY, FIXTURE.action_hash, tx)).rejects.toThrow('reverted');
  });

  it('rejects when the latest stored report is not the one this tx emitted', async () => {
    const { client } = fakeChain(FIXTURE, { storedHash: `0x${'33'.repeat(32)}` });
    await expect(readReportAtTx(client, REGISTRY, FIXTURE.action_hash, tx)).rejects.toThrow('latest report differs from the emitted one');
  });
});
