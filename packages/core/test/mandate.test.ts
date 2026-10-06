import { describe, expect, it } from 'vitest';
import { canonicalHash } from '../src/hash';
import { MandateError, anchorProjection, mandateHash, parseMandate } from '../src/mandate';
import { ADMIN_PKH, CFO_PKH, ENGINE_PK, M001, M001_INPUT, usdm } from './fixtures';

const withConstraints = (constraints: unknown[]) => ({ ...M001_INPUT, constraints });

describe('parseMandate', () => {
  it('accepts M-001', () => {
    expect(M001.id).toBe('M-001');
  });

  it('rejects hard cap below autonomous limit', () => {
    const cs = M001_INPUT.constraints.map((c) => (c.id === 'hard_cap' ? { ...c, value: usdm(5) } : c));
    expect(() => parseMandate(withConstraints(cs))).toThrow(/hard cap must be >= autonomous limit/);
  });

  it('rejects a REQUIRE_APPROVAL constraint whose approver is not listed', () => {
    const cs = M001_INPUT.constraints.map((c) => (c.id === 'autonomous' ? { ...c, approver: 'CEO' } : c));
    expect(() => parseMandate(withConstraints(cs))).toThrow(MandateError);
  });

  it('rejects more than one approver: the anchor holds a single approver key', () => {
    const ceo = { role: 'CEO', cardano_key_hash: '66'.repeat(28) };
    expect(() => parseMandate({ ...M001_INPUT, approvers: [...M001_INPUT.approvers, ceo] })).toThrow(/exactly one approver/);
    const split = M001_INPUT.constraints.map((c) => (c.id === 'counterparty' ? { ...c, approver: 'CEO' } : c));
    expect(() => parseMandate({ ...withConstraints(split), approvers: [...M001_INPUT.approvers, ceo] })).toThrow(/exactly one approver/);
  });

  it('rejects an approver key equal to the principal admin key', () => {
    const principal = { ...M001_INPUT.principal, cardano_key_hash: CFO_PKH };
    expect(() => parseMandate({ ...M001_INPUT, principal })).toThrow(/approver key must differ from the principal admin key/);
  });

  it('rejects duplicate constraint ids', () => {
    const cs = [...M001_INPUT.constraints, { id: 'purpose', kind: 'purpose_in', values: ['x'], on_violation: 'DENY' }];
    expect(() => parseMandate(withConstraints(cs))).toThrow(/unique/);
  });

  it('requires all four enforcement limits', () => {
    const cs = M001_INPUT.constraints.filter((c) => c.id !== 'daily_cap');
    expect(() => parseMandate(withConstraints(cs))).toThrow(/daily_spend_lte/);
  });

  it('rejects validity that ends before it starts', () => {
    const bad = { ...M001_INPUT, validity: { starts_at: '2026-11-06T00:00:00Z', expires_at: '2026-10-06T00:00:00Z' } };
    expect(() => parseMandate(bad)).toThrow(/starts_at/);
  });
});

describe('anchorProjection', () => {
  it('projects the enforcement-critical fields', () => {
    expect(anchorProjection(M001)).toEqual({
      mandate_hash: canonicalHash(M001),
      version: 3,
      status: 'active',
      engine_vkey: ENGINE_PK,
      principal_pkh: ADMIN_PKH,
      approver_pkh: CFO_PKH,
      asset_symbol: 'USDM',
      autonomous_limit: 10_000_000n,
      hard_cap: 50_000_000n,
      daily_cap: 50_000_000n,
      treasury_minimum: 100_000_000n,
      valid_until_ms: Date.parse('2026-11-06T00:00:00Z'),
    });
  });

  it('refuses to project a mandate with several approvers', () => {
    const approvers = [...M001.approvers, { role: 'CEO', cardano_key_hash: '66'.repeat(28) }];
    expect(() => anchorProjection({ ...M001, approvers })).toThrow(/exactly one approver/);
  });

  it('mandateHash is order-independent', () => {
    const reordered = parseMandate(Object.fromEntries(Object.entries(M001_INPUT).reverse()));
    expect(mandateHash(reordered)).toBe(mandateHash(M001));
  });
});
