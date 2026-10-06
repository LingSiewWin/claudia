import { runStage } from '../test/stage';

const money = (n: bigint) => {
  const cents = n / 10_000n;
  const whole = (cents / 100n).toLocaleString('en-US');
  const frac = (cents % 100n).toString().padStart(2, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
};
console.log('Mandate M-001: autonomous 10 | hard cap 50 | daily cap 50 | floor 100 | start 135 USDM\n');
for (const r of runStage()) {
  const detail = r.reason ?? (r.approvals.length ? `needs ${r.approvals.join(', ')}` : '');
  console.log(
    `${String(r.case).padEnd(2)} ${r.label.padEnd(40)} ${r.outcome.padEnd(17)} ${detail.padEnd(28)} CRE ${(r.cre ?? '-').padEnd(8)} balance ${money(r.balance).padStart(8)} spent ${money(r.spent).padStart(7)}`,
  );
}
