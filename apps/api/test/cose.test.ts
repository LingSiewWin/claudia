import { bytesToHex, hexToBytes, utf8ToBytes } from '@authority/core';
import { MeshWallet } from '@meshsdk/core';
import { describe, expect, it } from 'vitest';
import { paymentKeyHash, verifyCip8 } from '../src/cose';

// What the web console signs to decline approval AP-7 (RFC 8785 JSON, see declineMessage).
const message = '{"approval_id":"AP-7","decision":"decline"}';
const wallet = async (byte: string) => {
  const w = new MeshWallet({ networkId: 0, key: { type: 'cli', payment: `5820${byte.repeat(32)}` } });
  await w.init();
  const address = await w.getChangeAddress();
  const { deserializeAddress } = await import('@meshsdk/core');
  return { wallet: w, address, pkh: deserializeAddress(address).pubKeyHash };
};
const hex = (s: string) => bytesToHex(utf8ToBytes(s));

describe('CIP-8 verification against a real wallet implementation (Mesh signData)', () => {
  it('accepts the wallet signature and reports the signing key hash and address', async () => {
    const { wallet: w, address, pkh } = await wallet('07');
    const sig = await w.signData(hex(message), address);
    const signer = verifyCip8(sig.signature, sig.key, utf8ToBytes(message));
    expect(signer?.keyHash).toBe(pkh);
    expect(paymentKeyHash(signer!.address, 0)).toBe(pkh);
    expect(paymentKeyHash(signer!.address, 1)).toBeNull();
  });

  it('rejects another message, a flipped signature bit, a swapped key, and garbage', async () => {
    const { wallet: w, address } = await wallet('07');
    const sig = await w.signData(hex(message), address);
    expect(verifyCip8(sig.signature, sig.key, utf8ToBytes(message.replace('AP-7', 'AP-8')))).toBeNull();
    const bytes = hexToBytes(sig.signature);
    bytes[bytes.length - 1]! ^= 1;
    expect(verifyCip8(bytesToHex(bytes), sig.key, utf8ToBytes(message))).toBeNull();
    const other = await wallet('09');
    const otherSig = await other.wallet.signData(hex(message), other.address);
    expect(verifyCip8(sig.signature, otherSig.key, utf8ToBytes(message))).toBeNull();
    for (const junk of ['', '00', 'ff'.repeat(40), '9f'.repeat(10)]) expect(verifyCip8(junk, sig.key, utf8ToBytes(message))).toBeNull();
  });
});
