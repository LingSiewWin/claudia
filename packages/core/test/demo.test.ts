import { describe, expect, it } from 'vitest';
import { runStage } from './stage';

describe('stage run', () => {
  const rows = runStage();
  const expected = [
    { case: 1, outcome: 'ALLOW', reason: null, cre: 'VERIFIED', approvals: [], balance: 126_580_000n, spent: 8_420_000n },
    { case: 2, outcome: 'REQUIRE_APPROVAL', reason: null, cre: 'VERIFIED', approvals: ['ABOVE_AUTONOMOUS_LIMIT'], balance: 108_580_000n, spent: 26_420_000n },
    { case: 3, outcome: 'REQUIRE_APPROVAL', reason: 'PRINCIPAL_DECLINED', cre: 'VERIFIED', approvals: ['COUNTERPARTY_NOT_APPROVED'], balance: 108_580_000n, spent: 26_420_000n },
    { case: 4, outcome: 'DENY', reason: 'AMOUNT_ABOVE_HARD_CAP', cre: null, approvals: ['ABOVE_AUTONOMOUS_LIMIT'], balance: 108_580_000n, spent: 26_420_000n },
    { case: 5, outcome: 'DENY', reason: 'PURPOSE_NOT_AUTHORIZED', cre: null, approvals: [], balance: 108_580_000n, spent: 26_420_000n },
    { case: 6, outcome: 'DENY', reason: 'RECIPIENT_MISMATCH', cre: 'MISMATCH', approvals: [], balance: 108_580_000n, spent: 26_420_000n },
    { case: 7, outcome: 'DENY', reason: 'TREASURY_FLOOR_VIOLATION', cre: null, approvals: [], balance: 108_580_000n, spent: 26_420_000n },
  ];

  it.each(expected)('case $case', (row) => {
    expect(rows[row.case - 1]).toMatchObject(row);
  });
});
