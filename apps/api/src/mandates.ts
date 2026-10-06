import {
  bytesToHex,
  type ChainBinding,
  canonicalJson,
  enforcementLimits,
  type Mandate,
  mandateHash,
  parseMandate,
  publicKeyFromSecret,
  type State,
  StateSchema,
} from '@authority/core';
import type { Db, Sql } from '@authority/db';
import * as z from 'zod';
import { HttpError } from './http';
import type { AnchorState, CardanoPort, VaultState } from './ports';

export interface MandateRow {
  mandate: Mandate;
  hash: string;
  binding: ChainBinding;
  delegateName: string;
  kind: 'stage' | 'lab';
}

const Hex = (bytes: number) => z.string().regex(new RegExp(`^[0-9a-f]{${bytes * 2}}$`));
export const ChainBindingSchema = z.strictObject({
  chainTag: z.union([z.literal(0), z.literal(1)]),
  vaultHash: Hex(28),
  mandateRef: Hex(28),
  assetPolicy: Hex(28),
  assetName: z.string().regex(/^(?:[0-9a-f]{2}){0,32}$/),
  assetSymbol: z.string().regex(/^[A-Z]{2,10}$/),
});

/** Public deployment record written when the anchor and vault are deployed (no secrets). */
export const DeploymentSchema = z.strictObject({
  network: z.literal('preprod'),
  mandates: z
    .array(
      z.strictObject({
        kind: z.enum(['stage', 'lab']),
        delegate_name: z.string().min(1).max(64),
        mandate: z.unknown(),
        binding: ChainBindingSchema,
      }),
    )
    .min(1),
});

interface Row {
  doc: string;
  hash: string;
  binding: string;
  delegate_name: string;
  kind: 'stage' | 'lab';
}

function toRow(r: Row): MandateRow {
  const mandate = parseMandate(JSON.parse(r.doc));
  // The hash is recomputed from the document, never read from the row, so an edited document cannot hide.
  return { mandate, hash: mandateHash(mandate), binding: ChainBindingSchema.parse(JSON.parse(r.binding)), delegateName: r.delegate_name, kind: r.kind };
}

export async function currentMandate(q: Sql, id: string): Promise<MandateRow | null> {
  const [row] = await q.query<Row>(
    'select doc, hash, binding, delegate_name, kind from mandates where id = $1 order by version desc limit 1',
    [id],
  );
  return row ? toRow(row) : null;
}

export async function mandateOfKind(q: Sql, kind: 'stage' | 'lab'): Promise<MandateRow | null> {
  const [row] = await q.query<Row>(
    'select doc, hash, binding, delegate_name, kind from mandates where kind = $1 order by version desc limit 1',
    [kind],
  );
  return row ? toRow(row) : null;
}

export async function insertMandate(q: Sql, m: Mandate, binding: ChainBinding, delegateName: string, kind: 'stage' | 'lab') {
  await q.query(
    `insert into mandates (id, version, doc, hash, binding, delegate_name, kind)
     values ($1, $2, $3, $4, $5, $6, $7) on conflict (id, version) do nothing`,
    [m.id, m.version, canonicalJson(m), mandateHash(m), canonicalJson(binding), delegateName, kind],
  );
}

export async function seedDeployment(db: Db, deployment: unknown): Promise<string[]> {
  const d = DeploymentSchema.parse(deployment);
  const seeded: string[] = [];
  for (const entry of d.mandates) {
    const m = parseMandate(entry.mandate);
    await insertMandate(db, m, entry.binding, entry.delegate_name, entry.kind);
    seeded.push(`${m.id}@${m.version} ${mandateHash(m)}`);
  }
  return seeded;
}

/** Refuses to start when an engine key does not match the key the mandate names. */
export function checkEngineKeys(rows: MandateRow[], engineKeys: Map<string, Uint8Array>): void {
  for (const row of rows) {
    const key = engineKeys.get(row.mandate.id);
    if (!key) throw new Error(`no engine key configured for ${row.mandate.id}`);
    const pk = bytesToHex(publicKeyFromSecret(key));
    if (`ed25519:${pk}` !== row.mandate.authority_engine.public_key) throw new Error(`engine key does not match ${row.mandate.id}`);
  }
}

export interface ChainView {
  state: State;
  vault: VaultState;
  anchor: AnchorState;
  /** When Cardano was read; anything the chain shows happened before this. */
  readAtMs: number;
}

/**
 * Reads execution state from Cardano and converts it to the engine's State. A failing or malformed read is a
 * dependency outage (503). A stored mandate document whose hash differs from the anchor at the same version
 * means our database disagrees with the chain: refuse to evaluate rather than trust it.
 */
export async function readChain(cardano: CardanoPort, row: MandateRow, nowMs: number): Promise<ChainView> {
  if (!Number.isSafeInteger(nowMs)) throw new TypeError('readChain: nowMs must be a safe integer');
  let vault: VaultState;
  let anchor: AnchorState;
  try {
    [vault, anchor] = await Promise.all([cardano.readVaultState(row.binding), cardano.readAnchor(row.binding)]);
  } catch (error) {
    throw new HttpError(503, `cardano state unavailable: ${(error as Error).message}`, { 'retry-after': '10' });
  }
  if (anchor.version === row.mandate.version && anchor.mandate_hash !== row.hash) {
    throw new HttpError(500, `stored mandate ${row.mandate.id}@${row.mandate.version} does not match the on-chain anchor`);
  }
  const parsed = StateSchema.safeParse({
    vault_balance: vault.balance.toString(),
    spent_today: vault.spent_today.toString(),
    day_index: vault.day_index,
    last_nonce: vault.last_nonce.toString(),
    anchor_version: anchor.version,
    anchor_status: anchor.status,
    observed_at_slot: vault.slot,
  });
  if (!parsed.success) throw new HttpError(503, 'cardano state is malformed', { 'retry-after': '10' });
  return { state: parsed.data, vault, anchor, readAtMs: nowMs };
}

/** Vault balance and what counts as spent today (0 once the UTC day rolled over, as in the engine and R12). */
export function vaultSummary(vault: VaultState, nowMs: number): { balance: string; spent_today: string } {
  const today = Math.floor(nowMs / 86_400_000);
  return { balance: vault.balance.toString(), spent_today: (vault.day_index < today ? 0n : vault.spent_today).toString() };
}

export interface Limits {
  symbol: string;
  decimals: number;
  autonomous_limit: string;
  hard_cap: string;
  daily_cap: string;
  treasury_minimum: string;
}

export function limitsOf(m: Mandate): Limits {
  const l = enforcementLimits(m);
  const s = (v: bigint | null) => (v ?? 0n).toString();
  return {
    symbol: m.asset.symbol,
    decimals: m.asset.decimals,
    autonomous_limit: s(l.autonomous),
    hard_cap: s(l.hardCap),
    daily_cap: s(l.dailyCap),
    treasury_minimum: s(l.treasuryMinimum),
  };
}

export async function mandateRowAt(q: Sql, id: string, version: number): Promise<MandateRow> {
  const [row] = await q.query<Row>('select doc, hash, binding, delegate_name, kind from mandates where id = $1 and version = $2', [id, version]);
  if (!row) throw new Error(`mandate ${id}@${version} is not stored`);
  return toRow(row);
}
