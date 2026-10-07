import { canonicalJson, type Mandate, MandateError, parseMandate } from '@authority/core';
import * as z from 'zod';
import type { Engine } from './check';
import { HttpError, parseJson, type Reply } from './http';
import { currentMandate, insertMandate, type MandateRow, vaultSummary } from './mandates';
import { CardanoError } from './ports';
import { createRun, finishRun } from './runs';

// CFO mandate changes. The API only prepares unsigned anchor transactions; the anchor validator requires the
// principal's signature (U1, U2), so nothing here can change a mandate without the CFO wallet.

const Units = z.string().regex(/^(0|[1-9][0-9]{0,19})$/);
const UpdateBody = z.strictObject({
  limits: z.strictObject({ autonomous_limit: Units, hard_cap: Units, daily_cap: Units, treasury_minimum: Units }),
});
const SubmitBody = z.strictObject({
  tx_hash: z.string().regex(/^[0-9a-f]{64}$/),
  cfo_witness_cbor: z.string().regex(/^[0-9a-f]{2,8192}$/),
});

async function load(eng: Engine, id: string): Promise<MandateRow> {
  const row = await currentMandate(eng.db, id);
  if (!row) throw new HttpError(404, `unknown mandate ${id}`);
  return row;
}

/** Same mandate, new limits and version. Every constraint that defines a limit gets the new value. */
export function withLimits(m: Mandate, l: z.infer<typeof UpdateBody>['limits'], version: number): Mandate {
  const constraints = m.constraints.map((c) => {
    if (c.kind === 'amount_lte') return { ...c, value: c.on_violation === 'ESCALATE' ? l.autonomous_limit : l.hard_cap };
    if (c.kind === 'daily_spend_lte' && c.on_violation === 'DENY') return { ...c, value: l.daily_cap };
    if (c.kind === 'balance_after_gte' && c.on_violation === 'DENY') return { ...c, value: l.treasury_minimum };
    return c;
  });
  return parseMandate({ ...m, version, status: 'active', constraints });
}

async function prepare(eng: Engine, row: MandateRow, kind: 'revoke' | 'update', version: number, next: Mandate | null): Promise<Reply> {
  let tx;
  try {
    tx = next
      ? await eng.cardano.buildAnchorUpdate({ binding: row.binding, mandate: next })
      : await eng.cardano.buildAnchorRevoke({ binding: row.binding });
  } catch (error) {
    if (error instanceof CardanoError) throw new HttpError(409, `${error.invariant ?? error.code}: ${error.message}`);
    throw new HttpError(503, `cardano unavailable: ${(error as Error).message}`, { 'retry-after': '10' });
  }
  await eng.db.query(
    'insert into pending_txs (tx_hash, mandate_id, kind, version, new_doc, tx_cbor) values ($1, $2, $3, $4, $5, $6) on conflict (tx_hash) do nothing',
    [tx.txHash, row.mandate.id, kind, version, next ? canonicalJson(next) : null, tx.txCbor],
  );
  return { status: 200, body: { unsigned_tx_cbor: tx.txCbor, tx_hash: tx.txHash, version } };
}

export async function prepareRevoke(eng: Engine, id: string): Promise<Reply> {
  const row = await load(eng, id);
  const anchor = await eng.cardano.readAnchor(row.binding);
  if (anchor.status === 'revoked') throw new HttpError(409, `${id} is already revoked`);
  return prepare(eng, row, 'revoke', anchor.version + 1, null);
}

export async function prepareUpdate(eng: Engine, id: string, rawBody: string): Promise<Reply> {
  const body = UpdateBody.safeParse(parseJson(rawBody));
  if (!body.success) throw new HttpError(400, 'body must be { limits: { autonomous_limit, hard_cap, daily_cap, treasury_minimum } } in base units');
  const row = await load(eng, id);
  const anchor = await eng.cardano.readAnchor(row.binding);
  let next: Mandate;
  try {
    next = withLimits(row.mandate, body.data.limits, anchor.version + 1);
  } catch (error) {
    if (error instanceof MandateError) throw new HttpError(422, error.message);
    throw error;
  }
  return prepare(eng, row, 'update', next.version, next);
}

export async function submitMandateTx(eng: Engine, id: string, rawBody: string): Promise<Reply> {
  const body = SubmitBody.safeParse(parseJson(rawBody));
  if (!body.success) throw new HttpError(400, 'body must be { tx_hash, cfo_witness_cbor }');
  const row = await load(eng, id);
  const [p] = await eng.db.query<{ kind: 'revoke' | 'update'; version: number; new_doc: string | null; tx_cbor: string }>(
    'select kind, version, new_doc, tx_cbor from pending_txs where tx_hash = $1 and mandate_id = $2',
    [body.data.tx_hash, id],
  );
  if (!p) throw new HttpError(404, 'no prepared transaction with this hash');
  let txHash: string;
  try {
    txHash = await eng.cardano.submit({ txCbor: p.tx_cbor, witnessSets: [body.data.cfo_witness_cbor] });
  } catch (error) {
    if (error instanceof CardanoError) throw new HttpError(409, `${error.invariant ?? error.code}: ${error.message}`);
    throw error;
  }
  const confirmed = await eng.cardano.awaitConfirmation(txHash, eng.now() + 600_000);
  if (!confirmed) throw new HttpError(504, `submitted ${txHash} but it did not confirm in time`);
  if (p.new_doc) await insertMandate(eng.db, parseMandate(JSON.parse(p.new_doc)), row.binding, row.delegateName, row.kind);
  await eng.db.query('delete from pending_txs where tx_hash = $1', [body.data.tx_hash]);
  const verb = p.kind === 'revoke' ? 'revokes' : 'updates';
  const vault = vaultSummary(await eng.cardano.readVaultState(row.binding), eng.now());
  const runId = await createRun(eng.db, eng.log, { kind: row.kind, row, goal: `CFO ${verb} mandate ${id}`, status: 'active', vault });
  await eng.log.emit({
    run_id: runId,
    action_id: null,
    type: p.kind === 'revoke' ? 'MandateRevoked' : 'MandateUpdated',
    payload: { mandate_id: id, version: p.version, tx_hash: txHash },
  });
  await finishRun(eng.db, runId);
  return { status: 200, body: { tx_hash: txHash } };
}
