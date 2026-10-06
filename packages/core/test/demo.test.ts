import { describe, expect, it } from 'vitest';
import { runStage } from './stage';

describe('spec 10 stage run', () => {
  const rows = runStage();
  const expected = [
    { case: 1, outcome: 'ALLOW', reason: null, approvals: [], balance: 126.58, spent: 8.42 },
    { case: 2, outcome: 'REQUIRE_APPROVAL', reason: null, approvals: ['ABOVE_AUTONOMOUS_LIMIT'], balance: 108.58, spent: 26.42 },
    { case: 3, outcome: 'REQUIRE_APPROVAL', reason: 'PRINCIPAL_DECLINED', approvals: ['COUNTERPARTY_NOT_APPROVED'], balance: 108.58, spent: 26.42 },
    { case: 4, outcome: 'DENY', reason: 'AMOUNT_ABOVE_HARD_CAP', approvals: ['ABOVE_AUTONOMOUS_LIMIT'], balance: 108.58, spent: 26.42 },
    { case: 5, outcome: 'DENY', reason: 'PURPOSE_NOT_AUTHORIZED', approvals: [], balance: 108.58, spent: 26.42 },
    { case: 6, outcome: 'DENY', reason: 'RECIPIENT_MISMATCH', approvals: [], balance: 108.58, spent: 26.42 },
    { case: 7, outcome: 'DENY', reason: 'TREASURY_FLOOR_VIOLATION', approvals: [], balance: 108.58, spent: 26.42 },
  ];

  it.each(expected)('case $case', (row) => {
    expect(rows[row.case - 1]).toMatchObject(row);
  });
});
