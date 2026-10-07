import { verifyChain } from '@authority/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Api, startApi, usdm } from './harness';
import { runStage, type StageRow } from './stage';

let api: Api;
let run: string;
let rows: StageRow[];
beforeAll(async () => {
  api = await startApi();
  ({ run, rows } = await runStage(api));
});
afterAll(() => api.close());

describe('stage run through the API', () => {
  it('reproduces every outcome, single reason, and the balances', () => {
    const u = (s: string) => BigInt(usdm(s));
    expect(rows.map((r) => [r.n, r.outcome, r.reason, r.balance, r.spent])).toEqual([
      [1, 'ALLOW', null, u('126.58'), u('8.42')],
      [2, 'ESCALATE', null, u('108.58'), u('26.42')],
      [3, 'ESCALATE', 'PRINCIPAL_DECLINED', u('108.58'), u('26.42')],
      [4, 'DENY', 'AMOUNT_ABOVE_HARD_CAP', u('108.58'), u('26.42')],
      [5, 'DENY', 'PURPOSE_NOT_AUTHORIZED', u('108.58'), u('26.42')],
      [6, 'DENY', 'RECIPIENT_MISMATCH', u('108.58'), u('26.42')],
      [7, 'DENY', 'TREASURY_FLOOR_VIOLATION', u('108.58'), u('26.42')],
    ]);
  });

  it('never triggers CRE for cases the engine already denied (4, 5, 7)', async () => {
    const triggered = new Set(api.cre.calls.map((c) => c.action.id));
    expect(['A-0004', 'A-0005', 'A-0007'].filter((id) => triggered.has(id))).toEqual([]);
    const events = await api.log(run);
    for (const id of ['A-0004', 'A-0005', 'A-0007']) {
      expect(events.filter((e) => e.action_id === id && e.type === 'CREVerificationStarted')).toEqual([]);
    }
  });

  it('settles exactly two payments with receipts; the log verifies and every settlement anchors a head', async () => {
    const receipts = (await api.get('/v1/receipts?mandate_id=M-001')).json.receipts;
    expect(receipts.map((r: { action_id: string }) => r.action_id).sort()).toEqual(['A-0001', 'A-0002']);
    const heads = api.cardano.built.map((b) => b.metadata.log_head);
    expect(heads).toHaveLength(2);
    expect(await verifyChain(api.db, heads)).toMatchObject({ ok: true });
    expect((await api.log(run)).filter((e) => e.type === 'AuthorizationIssued')).toHaveLength(2);
  });
});
