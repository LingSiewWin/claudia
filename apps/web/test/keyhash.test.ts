import { describe, expect, it } from 'vitest';
import { keyHash } from '../lib/keyhash';

describe('keyHash', () => {
  it('is blake2b-224 of the public key (value from Python hashlib.blake2b(digest_size=28))', () => {
    expect(keyHash('ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c')).toBe('8b218424ad74df25d35c2ea8e094a4c5c5aeb2cbb442419331569313');
  });
  it('rejects malformed keys', () => {
    expect(() => keyHash('abcd')).toThrow();
  });
});
