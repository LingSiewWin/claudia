import { readFileSync } from 'node:fs';
import { applyParamsToScript, resolveScriptHash, serializePlutusScript } from '@meshsdk/core';

export const MANDATE_TOKEN = '4d414e44415445'; // "MANDATE"
export const VAULT_TOKEN = '5641554c54'; // "VAULT"

export interface OutRef {
  txHash: string;
  outputIndex: number;
}

/** An applied Plutus V3 script: double-CBOR hex, script hash (= policy id), preprod enterprise address. */
export interface Script {
  cbor: string;
  hash: string;
  address: string;
}

interface Blueprint {
  preamble: { plutusVersion: string };
  validators: { title: string; compiledCode: string }[];
}

const blueprint = JSON.parse(
  readFileSync(new URL('../../../contracts/cardano/plutus.json', import.meta.url), 'utf8'),
) as Blueprint;
if (blueprint.preamble.plutusVersion !== 'v3') throw new Error('plutus.json: expected a Plutus V3 blueprint');

export function compiledCode(title: string): string {
  const v = blueprint.validators.find((x) => x.title === title);
  if (!v) throw new Error(`plutus.json: validator ${title} not found`);
  return v.compiledCode;
}

export const outRefData = (r: OutRef) => ({ constructor: 0, fields: [{ bytes: r.txHash }, { int: r.outputIndex }] });

// The only parameter-application path: every hash, policy id and address in this package comes from here.
function applied(title: string, params: object[]): Script {
  const cbor = applyParamsToScript(compiledCode(title), params, 'JSON');
  const address = serializePlutusScript({ code: cbor, version: 'V3' }, undefined, 0).address as string;
  return { cbor, hash: resolveScriptHash(cbor, 'V3'), address };
}

/** mandate_anchor(seed): mint and spend share one script, so policy id == script hash == mandate_ref. */
export const anchorScript = (seed: OutRef): Script => applied('mandate_anchor.mandate_anchor.spend', [outRefData(seed)]);

/** vault(anchor_ref, chain_tag, seed): policy id of the VAULT thread token == vault_hash. */
export const vaultScript = (anchorRef: string, chainTag: 0 | 1, seed: OutRef): Script =>
  applied('vault.vault.spend', [{ bytes: anchorRef }, { int: chainTag }, outRefData(seed)]);
