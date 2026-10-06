import { concatBytes, hexOfLength, utf8ToBytes } from './bytes';
import { sha256Hex } from './hash';

export const DECISION_OUTCOMES = ['ALLOW', 'REQUIRE_APPROVAL', 'DENY'] as const;
export type DecisionOutcome = (typeof DECISION_OUTCOMES)[number];

const ZERO32 = new Uint8Array(32);

function hashPart(hex: string | null, label: string): Uint8Array {
  if (hex === null) return ZERO32;
  if (hex !== hex.toLowerCase()) throw new TypeError(`${label}: expected lowercase hex`);
  return hexOfLength(hex, 32, label);
}

// decision_hash = sha256(action_hash[32] || mandate_hash[32] || verification_ref[32] || ASCII bytes of outcome), lowercase hex.
// A missing part is 32 zero bytes. Fixed-width binary preimage. No implementation may hash a JSON form as an alternative encoding.
export function decisionPreimage(
  actionHash: string | null,
  mandateHash: string | null,
  verificationRef: string | null,
  outcome: DecisionOutcome,
): Uint8Array {
  if (!DECISION_OUTCOMES.includes(outcome)) throw new TypeError(`outcome: expected one of ${DECISION_OUTCOMES.join(', ')}`);
  return concatBytes(
    hashPart(actionHash, 'actionHash'),
    hashPart(mandateHash, 'mandateHash'),
    hashPart(verificationRef, 'verificationRef'),
    utf8ToBytes(outcome),
  );
}

export function decisionHash(
  actionHash: string | null,
  mandateHash: string | null,
  verificationRef: string | null,
  outcome: DecisionOutcome,
): string {
  return sha256Hex(decisionPreimage(actionHash, mandateHash, verificationRef, outcome));
}
