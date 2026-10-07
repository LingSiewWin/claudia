import { describe, expect, it } from 'vitest';
import { AUTHORIZATION_DOMAIN } from '../src/authorization';
import { bytesToHex, hexToBytes } from '../src/bytes';
import { publicKeyFromSecret, verifyBytes } from '../src/ed25519';
import {
  EVIDENCE_ANCHOR_DOMAIN,
  evidenceAnchorMessage,
  signEvidenceAnchor,
  verifyEvidenceAnchor,
} from '../src/evidence-anchor';
import { PROPOSAL_DOMAIN, signProposal, verifyProposal } from '../src/proposal';

const engineSk = new Uint8Array(32).fill(1);
const enginePk = bytesToHex(publicKeyFromSecret(engineSk));
const otherPk = bytesToHex(publicKeyFromSecret(new Uint8Array(32).fill(3)));
const runId = 'run-stage-0001';
const seq = 60;
const hash = 'ab'.repeat(32);

describe('evidence-anchor signatures', () => {
  it('verifies a head signed by the engine key', () => {
    const sig = signEvidenceAnchor(runId, seq, hash, engineSk);
    expect(verifyEvidenceAnchor(runId, seq, hash, sig, enginePk)).toBe(true);
  });

  it('rejects another key, another head, and malformed input', () => {
    const sig = signEvidenceAnchor(runId, seq, hash, engineSk);
    expect(verifyEvidenceAnchor(runId, seq, hash, sig, otherPk)).toBe(false);
    expect(verifyEvidenceAnchor(runId, seq + 1, hash, sig, enginePk)).toBe(false);
    expect(verifyEvidenceAnchor('run-other', seq, hash, sig, enginePk)).toBe(false);
    expect(verifyEvidenceAnchor(runId, seq, 'cd'.repeat(32), sig, enginePk)).toBe(false);
    expect(verifyEvidenceAnchor(runId, seq, hash, 'zz', enginePk)).toBe(false);
  });

  it('domain-separates from authorization and proposal messages', () => {
    expect(EVIDENCE_ANCHOR_DOMAIN).toBe('EVIDENCE_ANCHOR_V1');
    expect(EVIDENCE_ANCHOR_DOMAIN).not.toBe(AUTHORIZATION_DOMAIN);
    expect(EVIDENCE_ANCHOR_DOMAIN).not.toBe(PROPOSAL_DOMAIN);
    const message = evidenceAnchorMessage(runId, seq, hash);
    const sig = hexToBytes(signEvidenceAnchor(runId, seq, hash, engineSk));
    expect(verifyBytes(sig, hexToBytes(hash), hexToBytes(enginePk))).toBe(false);
    const proposalSig = signProposal(hash, engineSk);
    expect(verifyEvidenceAnchor(runId, seq, hash, proposalSig, enginePk)).toBe(false);
    expect(verifyProposal(hash, bytesToHex(sig), enginePk)).toBe(false);
    expect(new TextDecoder().decode(message).startsWith(EVIDENCE_ANCHOR_DOMAIN)).toBe(true);
  });
});
