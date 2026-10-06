import {
  bytesToHex,
  canonicalHash,
  canonicalJson,
  concatBytes,
  hexToBytes,
  mandateHash,
  publicKeyFromSecret,
  sha256Hex,
  utf8ToBytes,
  verifyAuthorizationRecord,
  verifyProposal,
} from '@authority/core';
import { describe, expect, it } from 'vitest';
import { CREATED_AT_FORMAT } from '../lib/contract';
import { keyHash } from '../lib/keyhash';
import { formatUnits } from '../lib/format';
import { recorded, stage } from './load';

describe('recorded fixtures', () => {
  it('form one hash chain across every run (spec 07 event hash)', () => {
    const all = Object.values(recorded.logs)
      .flat()
      .sort((a, b) => a.seq - b.seq);
    let prev = '00'.repeat(32);
    for (const e of all) {
      const { hash, prev_hash, ...body } = e;
      expect(prev_hash).toBe(prev);
      expect(sha256Hex(concatBytes(hexToBytes(prev), utf8ToBytes(canonicalJson(body))))).toBe(hash);
      prev = hash;
    }
    expect(all.map((e) => e.seq)).toEqual(all.map((_, i) => i + 1));
  });

  it('replay the scaled stage run with one reason per denial', () => {
    const denials = stage().flatMap((e) =>
      e.type === 'ActionDenied' ? [`${e.action_id}:${e.payload.reason}`] : e.type === 'CFODeclined' ? [`${e.action_id}:PRINCIPAL_DECLINED`] : [],
    );
    expect(denials).toEqual([
      'A-0003:PRINCIPAL_DECLINED',
      'A-0004:AMOUNT_ABOVE_HARD_CAP',
      'A-0005:PURPOSE_NOT_AUTHORIZED',
      'A-0006:RECIPIENT_MISMATCH',
      'A-0007:TREASURY_FLOOR_VIOLATION',
    ]);
    const vault = recorded.mandates['M-001']!.vault;
    expect([formatUnits(vault.balance), formatUnits(vault.spent_today)]).toEqual(['108.58', '26.42']);
  });

  it('contain no secret-looking material', () => {
    const words = [['mnemo', 'nic'], ['-----BEGIN'], ['xp', 'rv'], ['secret', '_key'], ['ed25519', '_sk']].map((w) => w.join(''));
    expect(JSON.stringify(recorded)).not.toMatch(new RegExp(words.join('|'), 'i'));
  });

  it('pin the created_at format the event hash depends on', () => {
    for (const e of Object.values(recorded.logs).flat()) expect(e.created_at).toMatch(CREATED_AT_FORMAT);
  });

  it('carry valid receipt hashes, mandate hashes, and signatures', () => {
    const events = Object.values(recorded.logs).flat();
    const engineKeys = new Set(events.flatMap((e) => (e.type === 'RunStarted' ? [e.payload.engine_public_key] : [])));
    for (const [id, b] of Object.entries(recorded.bundles)) {
      expect(canonicalHash(b.receipt), id).toBe(b.receipt_hash);
      expect(mandateHash(b.mandate), id).toBe(b.receipt.mandate.hash);
      expect(verifyProposal(b.receipt.action.hash, b.receipt.action.agent_signature, b.mandate.delegate.public_key.replace('ed25519:', ''))).toBe(true);
      expect(canonicalHash(b.receipt.action.ir)).toBe(b.receipt.action.hash);
      expect(verifyAuthorizationRecord(b.authorization, b.receipt.authorization.engine_public_key)).toBe(true);
      expect(engineKeys.has(b.receipt.authorization.engine_public_key)).toBe(true);
      expect(events.some((e) => e.hash === b.receipt.evidence.first_event_hash)).toBe(true);
      expect(events.some((e) => e.hash === b.receipt.evidence.last_event_hash)).toBe(true);
    }
    for (const [id, v] of Object.entries(recorded.mandates)) expect(mandateHash(v.mandate), id).toBe(v.mandate_hash);
    for (const e of events) {
      if (e.type === 'ActionProposed') expect(verifyProposal(e.payload.action_hash, e.payload.agent_signature ?? '', e.payload.action.actor === 'cfo-agent-01' ? agentKeyOf(e.run_id) : '')).toBe(true);
      if (e.type === 'ActionProposed') expect(canonicalHash(e.payload.action)).toBe(e.payload.action_hash);
      if (e.type === 'CREVerificationCompleted') expect(canonicalHash(e.payload.report)).toBe(e.payload.report_hash);
      if (e.type === 'AuthorizationIssued') {
        const start = (recorded.logs[e.run_id] ?? []).find((x) => x.type === 'RunStarted');
        expect(verifyAuthorizationRecord(e.payload.authorization, start?.type === 'RunStarted' ? start.payload.engine_public_key : '')).toBe(true);
      }
    }
  });

  it('use only the fixed TEST keys', () => {
    const test = new Set([1, 2, 3, 4, 5, 6].map((n) => bytesToHex(publicKeyFromSecret(new Uint8Array(32).fill(n)))));
    const events = Object.values(recorded.logs).flat();
    const keys = [
      ...events.flatMap((e) => (e.type === 'RunStarted' ? [e.payload.agent_public_key, e.payload.engine_public_key] : [])),
      ...Object.values(recorded.mandates).flatMap((v) => [v.mandate.delegate.public_key, v.mandate.authority_engine.public_key]),
      ...Object.values(recorded.bundles).map((b) => b.receipt.authorization.engine_public_key),
    ].map((k) => k.replace('ed25519:', ''));
    expect(keys.length).toBeGreaterThan(10);
    for (const k of keys) expect(test.has(k), k).toBe(true);
  });

  it('name the TEST-derived key hash as the approver everywhere', () => {
    const cfo = keyHash(bytesToHex(publicKeyFromSecret(new Uint8Array(32).fill(7))));
    for (const v of Object.values(recorded.mandates)) expect(v.mandate.approvers.map((a) => a.cardano_key_hash)).toEqual([cfo]);
    for (const b of Object.values(recorded.bundles)) {
      expect(b.mandate.approvers.map((a) => a.cardano_key_hash)).toEqual([cfo]);
      if (b.receipt.approval.required) expect(b.receipt.approval.cfo_key_hash).toBe(cfo);
    }
    for (const e of Object.values(recorded.logs).flat()) if (e.type === 'CFOApproved') expect(e.payload.cfo_key_hash).toBe(cfo);
  });

  it('include a revoked mandate', () => {
    expect(recorded.mandates['M-REVOKED']?.anchor.status).toBe('revoked');
  });
});

function agentKeyOf(runId: string): string {
  const start = (recorded.logs[runId] ?? []).find((x) => x.type === 'RunStarted');
  return start?.type === 'RunStarted' ? start.payload.agent_public_key : '';
}
