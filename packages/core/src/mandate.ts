import { canonicalHash } from './hash';
import { type Constraint, type Mandate, MandateSchema } from './schemas';

export class MandateError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid mandate: ${problems.join('; ')}`);
  }
}

export interface EnforcementLimits {
  autonomous: bigint | null;
  hardCap: bigint | null;
  dailyCap: bigint | null;
  treasuryMinimum: bigint | null;
}

export interface AnchorProjection {
  mandate_hash: string;
  version: number;
  status: 'active' | 'revoked';
  engine_vkey: string;
  principal_pkh: string;
  approver_pkh: string;
  asset_symbol: string;
  autonomous_limit: bigint;
  hard_cap: bigint;
  daily_cap: bigint;
  treasury_minimum: bigint;
  valid_until_ms: number;
}

type ValueConstraint = Extract<Constraint, { value: string }>;

function values(m: Mandate, kind: ValueConstraint['kind'], outcome: Constraint['on_violation']): bigint[] {
  return m.constraints
    .filter((c): c is ValueConstraint => c.kind === kind && c.on_violation === outcome)
    .map((c) => BigInt(c.value));
}

const min = (xs: bigint[]) => (xs.length ? xs.reduce((a, b) => (b < a ? b : a)) : null);
const max = (xs: bigint[]) => (xs.length ? xs.reduce((a, b) => (b > a ? b : a)) : null);

export function enforcementLimits(m: Mandate): EnforcementLimits {
  return {
    autonomous: min(values(m, 'amount_lte', 'REQUIRE_APPROVAL')),
    hardCap: min(values(m, 'amount_lte', 'DENY')),
    dailyCap: min(values(m, 'daily_spend_lte', 'DENY')),
    treasuryMinimum: max(values(m, 'balance_after_gte', 'DENY')),
  };
}

export function mandateRuleProblems(m: Mandate): string[] {
  const problems: string[] = [];
  const ids = m.constraints.map((c) => c.id);
  if (new Set(ids).size !== ids.length) problems.push('constraint ids must be unique');
  // The on-chain anchor holds one admin key (principal) and one payment approver key, so every approval must
  // come from that one approver, and the approver must not also hold the admin key.
  if (m.approvers.length !== 1) problems.push('needs exactly one approver (the on-chain payment approver)');
  if (m.approvers.some((a) => a.cardano_key_hash === m.principal.cardano_key_hash)) {
    problems.push('approver key must differ from the principal admin key');
  }
  const roles = new Set(m.approvers.map((a) => a.role));
  for (const c of m.constraints) {
    if (c.on_violation === 'REQUIRE_APPROVAL' && (c.approver === undefined || !roles.has(c.approver))) {
      problems.push(`${c.id}: REQUIRE_APPROVAL needs an approver listed in approvers`);
    }
    if (c.on_violation === 'DENY' && c.approver !== undefined) problems.push(`${c.id}: DENY constraints take no approver`);
  }
  const l = enforcementLimits(m);
  if (l.autonomous === null) problems.push('needs an amount_lte constraint with REQUIRE_APPROVAL (autonomous limit)');
  if (l.hardCap === null) problems.push('needs an amount_lte constraint with DENY (hard cap)');
  if (l.dailyCap === null) problems.push('needs a daily_spend_lte constraint with DENY');
  if (l.treasuryMinimum === null) problems.push('needs a balance_after_gte constraint with DENY');
  if (l.autonomous !== null && l.autonomous <= 0n) problems.push('autonomous limit must be > 0');
  if (l.autonomous !== null && l.hardCap !== null && l.hardCap < l.autonomous) problems.push('hard cap must be >= autonomous limit');
  if (l.autonomous !== null && l.dailyCap !== null && l.dailyCap < l.autonomous) problems.push('daily cap must be >= autonomous limit');
  if (Date.parse(m.validity.starts_at) >= Date.parse(m.validity.expires_at)) {
    problems.push('validity.starts_at must be before expires_at');
  }
  return problems;
}

export function parseMandate(input: unknown): Mandate {
  const parsed = MandateSchema.safeParse(input);
  if (!parsed.success) throw new MandateError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  const problems = mandateRuleProblems(parsed.data);
  if (problems.length > 0) throw new MandateError(problems);
  return parsed.data;
}

export function mandateHash(m: Mandate): string {
  return canonicalHash(m);
}

export function anchorProjection(m: Mandate): AnchorProjection {
  const l = enforcementLimits(m);
  const approver = m.approvers.length === 1 ? m.approvers[0] : undefined;
  if (
    !approver ||
    approver.cardano_key_hash === m.principal.cardano_key_hash ||
    l.autonomous === null ||
    l.hardCap === null ||
    l.dailyCap === null ||
    l.treasuryMinimum === null
  ) {
    throw new MandateError(mandateRuleProblems(m));
  }
  return {
    mandate_hash: mandateHash(m),
    version: m.version,
    status: m.status,
    engine_vkey: m.authority_engine.public_key.slice('ed25519:'.length),
    principal_pkh: m.principal.cardano_key_hash,
    approver_pkh: approver.cardano_key_hash,
    asset_symbol: m.asset.symbol,
    autonomous_limit: l.autonomous,
    hard_cap: l.hardCap,
    daily_cap: l.dailyCap,
    treasury_minimum: l.treasuryMinimum,
    valid_until_ms: Date.parse(m.validity.expires_at),
  };
}
