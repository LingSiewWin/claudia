import type { MandateView } from './contract';
import { money } from './format';
import { units } from './run';

/** Throws on a malformed amount, so a bad API response shows as an error instead of breaking the page. */
export function readMandate(m: MandateView) {
  const { limits, vault } = m;
  for (const v of [limits.autonomous_limit, limits.hard_cap, limits.daily_cap, limits.treasury_minimum]) units(v);
  if (!Number.isInteger(limits.decimals) || limits.decimals < 0) throw new Error('Bad decimals');
  return {
    ...m,
    balance: units(vault.balance),
    floor: units(limits.treasury_minimum),
    spent: units(vault.spent_today),
    dayCap: units(limits.daily_cap),
  };
}

/** Floor always. Spendable headroom only while the anchor can still spend. */
export function treasuryNote(revoked: boolean, floor: bigint, balance: bigint, decimals: number): string {
  const minimum = `minimum ${money(floor, decimals)}`;
  if (revoked) return minimum;
  return `${minimum} · spendable ${money(balance > floor ? balance - floor : 0n, decimals)}`;
}
