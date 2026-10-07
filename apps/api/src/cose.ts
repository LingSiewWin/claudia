import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes, verifyBytes } from '@authority/core';
import { blake2b } from '@noble/hashes/blake2.js';

// Minimal CIP-8 (COSE_Sign1, RFC 9052) verification for CIP-30 signData results. The Sig_structure is rebuilt
// from the protected header bytes exactly as received, so wallet-specific CBOR encodings do not matter.

interface Item {
  major: number;
  arg: bigint;
  bytes?: Uint8Array;
  items?: Item[];
  end: number;
}

function read(b: Uint8Array, at: number, depth: number): Item {
  if (depth > 6) throw new Error('cbor: too deep');
  const ib = b[at];
  if (ib === undefined) throw new Error('cbor: truncated');
  const major = ib >> 5;
  const ai = ib & 0x1f;
  let p = at + 1;
  let arg: bigint;
  if (ai < 24) arg = BigInt(ai);
  else if (ai <= 27) {
    const n = 1 << (ai - 24);
    if (p + n > b.length) throw new Error('cbor: truncated');
    arg = 0n;
    for (let i = 0; i < n; i++) arg = (arg << 8n) | BigInt(b[p + i]!);
    p += n;
  } else throw new Error('cbor: indefinite or reserved length');
  if (major === 2 || major === 3) {
    const end = p + Number(arg);
    if (arg > 65_536n || end > b.length) throw new Error('cbor: bad length');
    return { major, arg, bytes: b.subarray(p, end), end };
  }
  if (major === 4 || major === 5) {
    const count = Number(arg) * (major === 5 ? 2 : 1);
    if (arg > 16n) throw new Error('cbor: too many items');
    const items: Item[] = [];
    for (let i = 0; i < count; i++) {
      const it = read(b, p, depth + 1);
      items.push(it);
      p = it.end;
    }
    return { major, arg, items, end: p };
  }
  if (major === 6) {
    const inner = read(b, p, depth + 1);
    return { major, arg, items: [inner], end: inner.end };
  }
  return { major, arg, end: p };
}

function decode(b: Uint8Array): Item {
  const it = read(b, 0, 0);
  if (it.end !== b.length) throw new Error('cbor: trailing bytes');
  return it;
}

const isInt = (it: Item, n: number) => (n >= 0 ? it.major === 0 && it.arg === BigInt(n) : it.major === 1 && it.arg === BigInt(-1 - n));
const isText = (it: Item, s: string) => it.major === 3 && bytesToHex(it.bytes!) === bytesToHex(utf8ToBytes(s));

function get(map: Item, key: (k: Item) => boolean): Item | undefined {
  if (map.major !== 5) throw new Error('cbor: expected a map');
  const items = map.items!;
  for (let i = 0; i < items.length; i += 2) if (key(items[i]!)) return items[i + 1];
  return undefined;
}

function bstrHeader(length: number): Uint8Array {
  if (length < 24) return Uint8Array.of(0x40 + length);
  if (length < 256) return Uint8Array.of(0x58, length);
  return Uint8Array.of(0x59, length >> 8, length & 0xff);
}

export interface Cip8Signer {
  /** blake2b-224 of the COSE_Key Ed25519 public key */
  keyHash: string;
  /** raw bytes of the protected "address" header */
  address: Uint8Array;
}

/**
 * Returns the signer when: the COSE_Sign1 payload equals `message` byte for byte (not hashed), the algorithm is
 * EdDSA, the COSE_Key is an Ed25519 OKP key, and its signature over Sig_structure verifies. Otherwise null.
 */
export function verifyCip8(signatureHex: string, keyHex: string, message: Uint8Array): Cip8Signer | null {
  try {
    let s = decode(hexToBytes(signatureHex));
    if (s.major === 6 && s.arg === 18n) s = s.items![0]!;
    if (s.major !== 4 || s.items?.length !== 4) return null;
    const [prot, , payload, sig] = s.items as [Item, Item, Item, Item];
    if (prot.major !== 2 || payload.major !== 2 || sig.major !== 2 || sig.bytes!.length !== 64) return null;
    if (bytesToHex(payload.bytes!) !== bytesToHex(message)) return null;
    const headers = decode(prot.bytes!);
    const alg = get(headers, (k) => isInt(k, 1));
    const address = get(headers, (k) => isText(k, 'address'));
    if (!alg || !isInt(alg, -8) || address?.major !== 2) return null;
    const key = decode(hexToBytes(keyHex));
    const kty = get(key, (k) => isInt(k, 1));
    const crv = get(key, (k) => isInt(k, -1));
    const x = get(key, (k) => isInt(k, -2));
    if (!kty || !isInt(kty, 1) || !crv || !isInt(crv, 6) || x?.major !== 2 || x.bytes!.length !== 32) return null;
    const sigStructure = concatBytes(
      Uint8Array.of(0x84, 0x6a),
      utf8ToBytes('Signature1'),
      bstrHeader(prot.bytes!.length),
      prot.bytes!,
      Uint8Array.of(0x40),
      bstrHeader(payload.bytes!.length),
      payload.bytes!,
    );
    if (!verifyBytes(sig.bytes!, sigStructure, x.bytes!)) return null;
    return { keyHash: bytesToHex(blake2b(x.bytes!, { dkLen: 28 })), address: address.bytes! };
  } catch {
    return null;
  }
}

/** Payment key hash of a Shelley base or enterprise address with a key payment credential, on the given network. */
export function paymentKeyHash(address: Uint8Array, network: 0 | 1): string | null {
  const header = address[0];
  if (header === undefined || address.length < 29 || (header & 0x0f) !== network) return null;
  return [0x0, 0x2, 0x6].includes(header >> 4) ? bytesToHex(address.subarray(1, 29)) : null;
}
