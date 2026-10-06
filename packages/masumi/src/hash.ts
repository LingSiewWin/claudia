import { canonicalJson, concatBytes, hexOfLength, sha256Hex, utf8ToBytes } from '@authority/core';

// identifierFromPurchaser limits enforced by the payment service and Sokosumi Core: 14-26 hex chars, whole bytes.
const PURCHASER_ID = /^(?:[0-9a-fA-F]{2}){7,13}$/;

export function isPurchaserId(id: string): boolean {
  return PURCHASER_ID.test(id);
}

function purchaserId(id: string): string {
  if (!isPurchaserId(id)) throw new TypeError('identifierFromPurchaser must be 14-26 hex characters (whole bytes)');
  return id;
}

// MIP-004 input hash: sha256("<identifierFromPurchaser>;<RFC 8785 JSON of input_data>"), lowercase hex.
export function mip004InputHash(inputData: unknown, identifierFromPurchaser: string): string {
  return sha256Hex(`${purchaserId(identifierFromPurchaser)};${canonicalJson(inputData)}`);
}

// MIP-004 result hash as Masumi's implementations compute it (Sokosumi hashResult, pip-masumi
// create_masumi_output_hash): the output is JSON-string-escaped before hashing. The MIP-004 text
// hashes the raw output; both agree only for outputs without quotes, backslashes or control chars.
export function mip004ResultHash(result: string, identifierFromPurchaser: string): string {
  return sha256Hex(`${purchaserId(identifierFromPurchaser)};${JSON.stringify(result).slice(1, -1)}`);
}

export type DecisionOutcome = 'ALLOW' | 'REQUIRE_APPROVAL' | 'DENY';
const ZERO32 = new Uint8Array(32);

// decision_hash = sha256(action_hash || mandate_hash || verification_ref || utf8(outcome)).
// Hashes are raw 32-byte values; a missing action hash or verification ref is 32 zero bytes (as in the authorization message).
export function decisionHash(
  actionHash: string | null,
  mandateHash: string,
  verificationRef: string | null,
  outcome: DecisionOutcome,
): string {
  return sha256Hex(
    concatBytes(
      actionHash === null ? ZERO32 : hexOfLength(actionHash, 32, 'actionHash'),
      hexOfLength(mandateHash, 32, 'mandateHash'),
      verificationRef === null ? ZERO32 : hexOfLength(verificationRef, 32, 'verificationRef'),
      utf8ToBytes(outcome),
    ),
  );
}
