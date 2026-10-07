import { bytesToHex, concatBytes, hexOfLength, uintBE, utf8ToBytes } from './bytes';
import { signBytes, verifyBytes } from './ed25519';

export const EVIDENCE_ANCHOR_DOMAIN = 'EVIDENCE_ANCHOR_V1';

export function evidenceAnchorMessage(runId: string, seq: number, hashHex: string): Uint8Array {
  if (!Number.isInteger(seq) || seq < 1) throw new RangeError('seq: must be an integer >= 1');
  if (typeof runId !== 'string' || runId.length === 0) throw new TypeError('runId: must be a non-empty string');
  return concatBytes(
    utf8ToBytes(EVIDENCE_ANCHOR_DOMAIN),
    utf8ToBytes(runId),
    uintBE(BigInt(seq), 8),
    hexOfLength(hashHex, 32, 'hash'),
  );
}

export function signEvidenceAnchor(runId: string, seq: number, hashHex: string, engineSecretKey: Uint8Array): string {
  return bytesToHex(signBytes(evidenceAnchorMessage(runId, seq, hashHex), engineSecretKey));
}

export function verifyEvidenceAnchor(
  runId: string,
  seq: number,
  hashHex: string,
  signatureHex: string,
  enginePublicKeyHex: string,
): boolean {
  try {
    return verifyBytes(
      hexOfLength(signatureHex, 64, 'signature'),
      evidenceAnchorMessage(runId, seq, hashHex),
      hexOfLength(enginePublicKeyHex, 32, 'enginePublicKey'),
    );
  } catch {
    return false;
  }
}
