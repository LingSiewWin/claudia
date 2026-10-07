import {
  type AuthorizationFields,
  type AuthorizationRecord,
  authorizationDigest,
  bytesToHex,
  canonicalHash,
  encodeAuthorization,
  hexOfLength,
  publicKeyFromSecret,
  signBytes,
  signProposal,
} from '@authority/core';
import * as z from 'zod';
import { checkInProcess, type Engine } from './check';
import { HttpError, parseJson, type Reply } from './http';
import { mandateOfKind, readChain, vaultSummary } from './mandates';
import type { LabDeps, LabKeys, VaultAttack } from './ports';
import { assertNoLiveRun, createRun, finishRun } from './runs';

// Attack Lab: real attempts against M-LAB only. This module reads only M_LAB_* settings, so no code path
// here can load the M-001 engine or agent key (isolation is also cryptographic: own anchor, vault, keys).

export const ATTACK_IDS = [
  'prompt_injection',
  'prompt_injection_direct',
  'recipient_swap',
  'amount_swap',
  'replay',
  'expired',
  'revoked',
  'daily_cap',
  'cfo_bypass',
] as const;
export type AttackId = (typeof ATTACK_IDS)[number];

export function labKeys(env: Record<string, string | undefined>): LabKeys {
  return {
    engine: hexOfLength(env.M_LAB_ENGINE_SECRET_KEY ?? '', 32, 'M_LAB_ENGINE_SECRET_KEY'),
    agent: hexOfLength(env.M_LAB_AGENT_SECRET_KEY ?? '', 32, 'M_LAB_AGENT_SECRET_KEY'),
  };
}

/** Stolen-engine-key simulation: signs whatever fields it is given with the M-LAB engine key. */
export function forgeAuthorization(fields: AuthorizationFields, engineSecretKey: Uint8Array): AuthorizationRecord {
  const digest = authorizationDigest(fields);
  return {
    schema: 'authorization/v0.1',
    message_hex: bytesToHex(encodeAuthorization(fields)),
    digest_hex: bytesToHex(digest),
    signature_hex: bytesToHex(signBytes(digest, engineSecretKey)),
    engine_public_key: bytesToHex(publicKeyFromSecret(engineSecretKey)),
    fields: {
      chain_tag: fields.chainTag,
      vault_hash: fields.vaultHash,
      mandate_ref: fields.mandateRef,
      mandate_hash: fields.mandateHash,
      mandate_version: fields.mandateVersion,
      action_hash: fields.actionHash,
      action_type: fields.actionType,
      asset_policy: fields.assetPolicy,
      asset_name: fields.assetName,
      amount: fields.amount.toString(),
      recipient: fields.recipient,
      nonce: fields.nonce.toString(),
      valid_until: Number(fields.validUntil),
      requires_principal: fields.requiresPrincipal,
      verification_ref: fields.verificationRef,
    },
  };
}

const AttackBody = z.strictObject({ attack: z.enum(ATTACK_IDS) });

export async function startAttack(eng: Engine, lab: LabDeps, rawBody: string): Promise<Reply> {
  const body = AttackBody.safeParse(parseJson(rawBody));
  if (!body.success) throw new HttpError(400, `attack must be one of ${ATTACK_IDS.join(', ')}`);
  const attack = body.data.attack;
  const row = await mandateOfKind(eng.db, 'lab');
  if (!row) throw new HttpError(503, 'the Attack Lab mandate is not deployed');
  const agentDriven = attack === 'prompt_injection' || attack === 'prompt_injection_direct';
  if (!agentDriven && !lab.runner) throw new HttpError(501, 'vault attacks need the lab runner, which is not configured');
  await assertNoLiveRun(eng.db, 'lab');
  const { vault } = await readChain(eng.cardano, row, eng.now());
  // Prompt injection goes through the real agent (it claims the run); vault attacks run here.
  const runId = await createRun(eng.db, eng.log, {
    kind: 'lab',
    row,
    goal: `Attack Lab: ${attack.replaceAll('_', ' ')}`,
    attack,
    status: agentDriven ? 'pending' : 'active',
    vault: vaultSummary(vault, eng.now()),
  });
  await eng.log.emit({ run_id: runId, action_id: null, type: 'AttackStarted', payload: { attack, mandate_id: row.mandate.id } });
  // The lab engine knows only the M-LAB key, whatever the shared engine holds.
  const labEng: Engine = { ...eng, engineKeys: new Map([[row.mandate.id, lab.keys.engine]]) };
  if (!agentDriven) void runVaultAttack(labEng, lab, runId, attack as VaultAttack);
  return { status: 200, body: { run_id: runId } };
}

async function runVaultAttack(eng: Engine, lab: LabDeps, runId: string, attack: VaultAttack): Promise<void> {
  const emit = (type: string, actionId: string | null, payload: unknown) => eng.log.emit({ run_id: runId, action_id: actionId, type, payload });
  let n = 0;
  try {
    const result = await lab.runner!.run(attack, {
      async authorize(invoiceNumber) {
        const row = await mandateOfKind(eng.db, 'lab');
        const inv = await lab.invoice(invoiceNumber);
        if (!row || !inv) throw new Error(`lab invoice ${invoiceNumber} is not open`);
        n += 1;
        const action = {
          schema: 'action-ir/v0.1' as const,
          id: `LAB-${attack}-${n}`,
          mandate_id: row.mandate.id,
          actor: row.mandate.delegate.id,
          type: 'pay_invoice' as const,
          purpose: 'invoice_payment',
          counterparty: { id: 'aws', display: 'AWS (demo vendor)' },
          amount: { value: inv.amount_usdm, asset: row.mandate.asset.symbol },
          recipient: { chain: 'cardano' as const, address: inv.payout_address },
          source: { vault: 'acme-lab' },
          reference: { invoice_id: inv.id, invoice_number: invoiceNumber },
          rationale: `Attack Lab ${attack}: a valid authorization to attack.`,
          created_at: new Date(eng.now()).toISOString(),
        };
        const proposal = { action, agent_signature: signProposal(canonicalHash(action), lab.keys.agent) };
        const reply = await checkInProcess(eng, 'agent', { mandate_id: row.mandate.id, proposal, execute: false, run_id: runId });
        const record = (reply.body as { authorization: AuthorizationRecord | null }).authorization;
        if (!record) throw new Error(`the engine did not authorize ${invoiceNumber}`);
        return record;
      },
      async forge(fields) {
        const record = forgeAuthorization(fields, lab.keys.engine);
        await emit('AuthorizationIssued', null, { authorization: record, compromised_engine: true });
        return record;
      },
      async record(type, actionId, payload) {
        await emit(type, actionId, payload);
      },
    });
    await emit('AttackResult', null, { attack, stopped_by: 'vault', code: result.code, funds_moved: result.funds_moved, tx_hash: result.tx_hash });
  } catch (error) {
    await emit('TransactionRejected', null, { tx_hash: null, invariant: 'LAB_ERROR', error: (error as Error).message, tx_body_cbor: null });
  } finally {
    await finishRun(eng.db, runId).catch(() => undefined);
  }
}
