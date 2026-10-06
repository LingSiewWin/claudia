import { canonicalJson, sha256Hex } from '@authority/core';

// identifierFromPurchaser: 14-26 hex chars of whole bytes. The payment service (validateHexString) and Sokosumi Core
// both reject odd lengths.
const PURCHASER_ID = /^(?:[0-9a-fA-F]{2}){7,13}$/;

export function isPurchaserId(id: string): boolean {
  return typeof id === 'string' && PURCHASER_ID.test(id);
}

function purchaserId(id: string): string {
  if (!isPurchaserId(id)) throw new TypeError('identifierFromPurchaser must be 14-26 hex characters');
  return id;
}

// A lone surrogate has no UTF-8 encoding, so its hash could never match the buyer's. Same test as String#isWellFormed.
function resultText(result: string): string {
  if (typeof result !== 'string') throw new TypeError('result must be a string');
  if (/\p{Surrogate}/u.test(result)) throw new TypeError('result must be well-formed UTF-16 (no lone surrogates)');
  return result;
}

// MIP-004 input hash: sha256("<identifierFromPurchaser>;<RFC 8785 JSON of input_data>"), lowercase hex.
export function mip004InputHash(inputData: unknown, identifierFromPurchaser: string): string {
  return sha256Hex(`${purchaserId(identifierFromPurchaser)};${canonicalJson(inputData)}`);
}

// Masumi compatibility mode: v0.1 submits the JSON-escaped output hash because it matches the currently deployed
// Masumi verifier implementations (Sokosumi, pip-masumi). The raw-output hash described by the MIP-004 text is kept
// for audit comparison. The two agree only for outputs without quotes, backslashes or control characters.
export function mip004ResultHashEscaped(result: string, identifierFromPurchaser: string): string {
  return sha256Hex(`${purchaserId(identifierFromPurchaser)};${JSON.stringify(resultText(result)).slice(1, -1)}`);
}

export function mip004ResultHashRaw(result: string, identifierFromPurchaser: string): string {
  return sha256Hex(`${purchaserId(identifierFromPurchaser)};${resultText(result)}`);
}

export type MasumiResultHashV0 = { raw_output_hash: string; escaped_json_hash: string };

export function masumiResultHashV0(result: string, identifierFromPurchaser: string): MasumiResultHashV0 {
  return {
    raw_output_hash: mip004ResultHashRaw(result, identifierFromPurchaser),
    escaped_json_hash: mip004ResultHashEscaped(result, identifierFromPurchaser),
  };
}
