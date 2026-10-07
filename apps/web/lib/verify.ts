import {
  authorizationDigest,
  briefHash,
  bytesToHex,
  canonicalHash,
  encodeAuthorization,
  fieldsFromRecord,
  mandateHash,
  verifyAuthorizationRecord,
  verifyProposal,
} from '@authority/core';
import { MANDATE_TOKEN_HEX, bytesOf, containsBytes, field, intOf, type EthReceipt, type KoiosTx } from './chain';
import type { ReceiptBundle } from './contract';

export type CheckStatus = 'pass' | 'fail' | 'unavailable';
export interface VerifyCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

const ok = (id: string, label: string, pass: boolean, detail: string): VerifyCheck => ({
  id,
  label,
  status: pass ? 'pass' : 'fail',
  detail,
});

function safe(fn: () => boolean): boolean {
  try {
    return fn();
  } catch {
    return false;
  }
}

/** Checks that need nothing but the bundle and packages/core. */
export function offlineChecks(b: ReceiptBundle): VerifyCheck[] {
  const { receipt: r, authorization: a, mandate: m } = b;
  const f = a.fields;
  const ir = r.action.ir;
  const receiptHash = canonicalHash(r);
  const actionHash = canonicalHash(ir);
  const brief = b.brief ?? null;
  const briefChecks: VerifyCheck[] = brief
    ? [
        ok(
          'brief_hash',
          'Decision brief recomputes to the hash the approver signed off on',
          safe(() => briefHash(brief) === r.approval.brief_hash && brief.action_hash === r.action.hash && brief.mandate.id === r.mandate.id),
          r.approval.brief_hash ?? 'no brief_hash on receipt',
        ),
      ]
    : [];
  return [
    ...briefChecks,
    ok('receipt_hash', 'Receipt hash recomputed', receiptHash === b.receipt_hash, receiptHash),
    ok('action_hash', 'Action hash recomputed from the Action IR', actionHash === r.action.hash, actionHash),
    ok(
      'agent_signature',
      "Agent's proposal signature",
      safe(() => verifyProposal(r.action.hash, r.action.agent_signature, m.delegate.public_key.slice('ed25519:'.length))),
      m.delegate.public_key,
    ),
    ok(
      'mandate_hash',
      'Mandate document matches its hash',
      safe(() => mandateHash(m) === r.mandate.hash && m.id === r.mandate.id && m.version === r.mandate.version),
      r.mandate.hash,
    ),
    ok(
      'binding',
      'Authorization covers exactly this action',
      f.action_hash === r.action.hash &&
        f.amount === ir.amount.value &&
        f.recipient === ir.recipient.address &&
        f.mandate_ref === r.mandate.anchor &&
        f.mandate_hash === r.mandate.hash &&
        f.mandate_version === r.mandate.version &&
        f.nonce === r.authorization.nonce &&
        f.valid_until === r.authorization.valid_until &&
        f.requires_principal === r.approval.required &&
        f.verification_ref === (r.verification?.report_hash ?? null) &&
        a.digest_hex === r.authorization.digest &&
        a.signature_hex === r.authorization.signature,
      `amount ${f.amount}, nonce ${f.nonce}, recipient ${f.recipient}`,
    ),
    ok(
      'message_bytes',
      'Authorization bytes and digest rebuilt',
      safe(
        () =>
          bytesToHex(encodeAuthorization(fieldsFromRecord(a))) === a.message_hex &&
          bytesToHex(authorizationDigest(fieldsFromRecord(a))) === a.digest_hex,
      ),
      a.digest_hex,
    ),
  ];
}

/** Checks against the settlement transaction as Cardano preprod recorded it. */
export function cardanoChecks(b: ReceiptBundle, tx: KoiosTx | null): VerifyCheck[] {
  const a = b.authorization;
  const f = a.fields;
  if (tx === null) {
    return [ok('cardano_tx', 'Settlement transaction on Cardano preprod', false, `${b.receipt.settlement.tx_hash} not found`)];
  }
  const anchor = tx.reference_inputs.find((u) =>
    u.asset_list.some((x) => x.policy_id === b.receipt.mandate.anchor && x.asset_name === MANDATE_TOKEN_HEX),
  );
  const datum = anchor?.inline_datum?.value;
  const engineKey = bytesOf(field(datum, 3));
  const vault = tx.plutus_contracts.find((p) => p.script_hash === f.vault_hash && p.input.redeemer.purpose === 'spend');
  const paid = safe(() =>
    tx.outputs.some(
      (o) =>
        o.payment_addr.bech32 === f.recipient &&
        o.asset_list.some(
          (x) => x.policy_id === f.asset_policy && x.asset_name === f.asset_name && BigInt(x.quantity) >= BigInt(f.amount),
        ),
    ),
  );
  const meta = (tx.metadata?.['1694'] ?? null) as { auth?: string; action?: string } | null;
  return [
    ok('cardano_tx', 'Settlement transaction on Cardano preprod', true, `block ${tx.block_height ?? 'pending'}`),
    ok(
      'anchor',
      'Mandate anchor read by the vault matches the receipt',
      bytesOf(field(datum, 0)) === b.receipt.mandate.hash && intOf(field(datum, 1)) === b.receipt.mandate.version,
      anchor ? `anchor ${b.receipt.mandate.anchor}` : 'anchor reference input missing',
    ),
    ok(
      'engine_signature',
      'Engine signature checked against the key stored on-chain',
      engineKey !== null && verifyAuthorizationRecord(a, engineKey),
      engineKey ?? 'no engine key in anchor datum',
    ),
    ok(
      'vault_redeemer',
      'Vault spent with this exact signature',
      vault !== undefined && vault.valid_contract && containsBytes(vault.input.redeemer.datum.value, a.signature_hex),
      `vault ${f.vault_hash}`,
    ),
    ok('payment', 'Recipient received the authorized amount', paid, `${f.amount} to ${f.recipient}`),
    ok(
      'metadata',
      'Settlement metadata names this authorization',
      meta?.auth === a.digest_hex && meta?.action === b.receipt.action.hash,
      'label 1694',
    ),
  ];
}

/** Checks against the CRE report write on Sepolia. */
export function sepoliaChecks(b: ReceiptBundle, rc: EthReceipt | null, registry: string): VerifyCheck[] {
  const v = b.receipt.verification;
  if (v === null) return [];
  const needle = v.report_hash.toLowerCase();
  const logged =
    rc !== null &&
    rc.status === '0x1' &&
    rc.logs.some(
      (l) =>
        l.address.toLowerCase() === registry &&
        (l.topics.some((t) => t.toLowerCase() === `0x${needle}`) || l.data.toLowerCase().includes(needle)),
    );
  return [ok('cre_report', 'CRE report recorded on Sepolia by the registry', logged, `${v.sepolia_tx}`)];
}

export interface Fetchers {
  cardano: (txHash: string) => Promise<KoiosTx | null>;
  sepolia: (txHash: string) => Promise<EthReceipt | null>;
  registry: string;
}

const unavailable = (id: string, label: string, err: unknown): VerifyCheck => ({
  id,
  label,
  status: 'unavailable',
  detail: err instanceof Error ? err.message : String(err),
});

export async function verifyReceipt(b: ReceiptBundle, fx: Fetchers): Promise<VerifyCheck[]> {
  const [cardano, sepolia] = await Promise.all([
    fx.cardano(b.receipt.settlement.tx_hash).then(
      (tx) => {
        try {
          return cardanoChecks(b, tx);
        } catch (err) {
          return [unavailable('cardano_tx', 'Cardano preprod (Koios)', err)];
        }
      },
      (err) => [unavailable('cardano_tx', 'Cardano preprod (Koios)', err)],
    ),
    b.receipt.verification === null
      ? Promise.resolve([])
      : fx.sepolia(b.receipt.verification.sepolia_tx).then(
          (rc) => {
            try {
              return sepoliaChecks(b, rc, fx.registry);
            } catch (err) {
              return [unavailable('cre_report', 'Sepolia (public RPC)', err)];
            }
          },
          (err) => [unavailable('cre_report', 'Sepolia (public RPC)', err)],
        ),
  ]);
  return [...offlineChecks(b), ...cardano, ...sepolia];
}

export function overall(checks: VerifyCheck[]): CheckStatus {
  if (checks.some((c) => c.status === 'fail')) return 'fail';
  if (checks.some((c) => c.status === 'unavailable')) return 'unavailable';
  return 'pass';
}

/** Receipt page summary lines. A line passes only when every check in its group ran and passed. */
export const SUMMARY = [
  { key: 'tx', label: 'transaction found', ids: ['cardano_tx'] },
  { key: 'metadata', label: 'metadata matches', ids: ['metadata'] },
  {
    key: 'authorization',
    label: 'authorization hash matches',
    ids: ['binding', 'message_bytes', 'anchor', 'engine_signature', 'vault_redeemer', 'payment'],
  },
  { key: 'receipt', label: 'receipt hash matches', ids: ['receipt_hash', 'action_hash', 'agent_signature', 'mandate_hash'] },
  { key: 'cre', label: 'invoice check recorded on Sepolia', ids: ['cre_report'] },
] as const;

export function groupStatus(checks: VerifyCheck[], ids: readonly string[]): CheckStatus {
  const found = ids.map((id) => checks.find((c) => c.id === id));
  if (found.some((c) => c?.status === 'fail')) return 'fail';
  if (found.some((c) => c === undefined || c.status === 'unavailable')) return 'unavailable';
  return 'pass';
}

/** The one result line. "VERIFIED" only when every check ran in this browser and passed. */
export function verdict(checks: VerifyCheck[]): { result: CheckStatus; text: string } {
  const result = overall(checks);
  if (result === 'pass') return { result, text: 'VERIFIED' };
  if (result === 'fail') return { result, text: `FAILED: ${checks.find((c) => c.status === 'fail')?.label ?? ''}` };
  const source = checks.find((c) => c.status === 'unavailable')?.id === 'cre_report' ? 'Sepolia' : 'Cardano';
  return { result, text: `${source} data unavailable. Verification cannot be completed locally.` };
}
