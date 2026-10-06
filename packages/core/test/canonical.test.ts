import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../src/canonical';

describe('canonicalJson (RFC 8785)', () => {
  it('matches the RFC 8785 primitive example', () => {
    const input = JSON.parse(
      '{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],' +
        '"string":"\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/",' +
        '"literals":[null,true,false]}',
    );
    expect(canonicalJson(input)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],' +
        '"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    );
  });

  it('sorts keys by UTF-16 code units', () => {
    // RFC 8785 section 3.2.3 key set. Compare the string: Object.keys would hoist the integer-like key "1".
    const input = { '\u20ac': 1, '\r': 2, '\ufb33': 3, '1': 4, '\ud83d\ude00': 5, '\u0080': 6, '\u00f6': 7 };
    expect(canonicalJson(input)).toBe(
      '{"\\r":2,"1":4,"\u0080":6,"\u00f6":7,"\u20ac":1,"\ud83d\ude00":5,"\ufb33":3}',
    );
  });

  it('sorts nested objects and keeps array order', () => {
    expect(canonicalJson({ b: [3, { z: 1, a: 2 }], a: 'x' })).toBe('{"a":"x","b":[3,{"a":2,"z":1}]}');
  });

  it('drops undefined properties like JSON.stringify', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('rejects values JSON cannot represent', () => {
    expect(() => canonicalJson(Number.NaN)).toThrow();
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow();
    expect(() => canonicalJson(10n)).toThrow();
    expect(() => canonicalJson(() => 1)).toThrow();
  });

  it('normalizes negative zero', () => {
    expect(canonicalJson(-0)).toBe('0');
  });
});
