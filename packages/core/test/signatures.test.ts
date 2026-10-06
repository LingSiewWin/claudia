import { describe, expect, it } from 'vitest';
import { bytesToHex, hexToBytes } from '../src/bytes';
import { publicKeyFromSecret, signBytes, verifyBytes } from '../src/ed25519';
import { signProposal, verifyProposal } from '../src/proposal';

const agentSk = new Uint8Array(32).fill(2);
const agentPk = bytesToHex(publicKeyFromSecret(agentSk));
const otherPk = bytesToHex(publicKeyFromSecret(new Uint8Array(32).fill(3)));
const actionHash = 'ab'.repeat(32);

describe('proposal signatures', () => {
  it('verifies a proposal signed by the agent', () => {
    expect(verifyProposal(actionHash, signProposal(actionHash, agentSk), agentPk)).toBe(true);
  });

  it('rejects another key, another hash, and malformed input', () => {
    const sig = signProposal(actionHash, agentSk);
    expect(verifyProposal(actionHash, sig, otherPk)).toBe(false);
    expect(verifyProposal('cd'.repeat(32), sig, agentPk)).toBe(false);
    expect(verifyProposal(actionHash, 'zz', agentPk)).toBe(false);
    expect(verifyProposal(actionHash, sig, 'abc')).toBe(false);
  });

  it('domain separation: a proposal signature never verifies over the raw hash bytes', () => {
    const sig = hexToBytes(signProposal(actionHash, agentSk));
    expect(verifyBytes(sig, hexToBytes(actionHash), hexToBytes(agentPk))).toBe(false);
  });

  it('a signature over raw hash bytes never verifies as a proposal', () => {
    const raw = bytesToHex(signBytes(hexToBytes(actionHash), agentSk));
    expect(verifyProposal(actionHash, raw, agentPk)).toBe(false);
  });
});
