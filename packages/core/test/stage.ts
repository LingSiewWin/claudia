import { evaluate } from '../src/engine';
import type { ActionIR } from '../src/schemas';
import { ATTACKER_ADDR, GLOBEX_ADDR, M001, NFT_ADDR, NOW, action, propose, state, verified } from './fixtures';

export interface StageRow {
  case: number;
  label: string;
  outcome: string;
  reason: string | null;
  approvals: string[];
  balance: number;
  spent: number;
}

type Human = 'approve' | 'decline' | null;

export function runStage(): StageRow[] {
  let balance = 135;
  let spent = 0;
  const rows: StageRow[] = [];
  const step = (n: number, label: string, a: ActionIR, mismatch: boolean, human: Human) => {
    const input = { mandate: M001, proposal: propose(a), state: state(balance, spent), nowMs: NOW };
    let e = evaluate({ ...input, verification: null });
    if (e.outcome === 'NEEDS_VERIFICATION') {
      e = evaluate({ ...input, verification: mismatch ? verified(a, 'MISMATCH', 'RECIPIENT_MISMATCH') : verified(a) });
    }
    const amount = Number(a.amount.value) / 1_000_000;
    const settles = e.outcome === 'ALLOW' || (e.outcome === 'REQUIRE_APPROVAL' && human === 'approve');
    if (settles) {
      balance = Math.round((balance - amount) * 100) / 100;
      spent = Math.round((spent + amount) * 100) / 100;
    }
    const reason = e.outcome === 'REQUIRE_APPROVAL' && human === 'decline' ? 'PRINCIPAL_DECLINED' : e.reason;
    rows.push({ case: n, label, outcome: e.outcome, reason, approvals: e.approvals_required.map((x) => x.reason), balance, spent });
  };

  step(1, 'Pay AWS INV-3821 8.42', action({ id: 'A-3821', amount: 8.42, invoice: 'INV-3821' }), false, null);
  step(2, 'Pay AWS INV-3822 18.00', action({ id: 'A-3822', amount: 18, invoice: 'INV-3822' }), false, 'approve');
  step(3, 'Pay Globex INV-G-0042 5.00', action({ id: 'A-G0042', amount: 5, counterparty: 'globex', display: 'Globex (demo vendor)', recipient: GLOBEX_ADDR, invoice: 'INV-G-0042' }), false, 'decline');
  step(4, 'Pay AWS INV-3825 60.00', action({ id: 'A-3825', amount: 60, invoice: 'INV-3825' }), false, null);
  step(5, 'Buy NFT 2.00', action({ id: 'A-NFT', amount: 2, type: 'purchase', purpose: 'digital_collectibles', counterparty: 'nft-marketplace', display: 'NFT marketplace', recipient: NFT_ADDR, invoice: null }), false, null);
  step(6, 'Pay AWS INV-3823 4.00 to attacker', action({ id: 'A-3823', amount: 4, recipient: ATTACKER_ADDR, invoice: 'INV-3823' }), true, null);
  step(7, 'Pay AWS INV-3824 9.00', action({ id: 'A-3824', amount: 9, invoice: 'INV-3824' }), false, null);
  return rows;
}
