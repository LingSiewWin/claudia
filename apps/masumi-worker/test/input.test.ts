import { describe, expect, it } from 'vitest';
import { INPUT_SCHEMA, InputError, parseAuthorityInput, parseTaskDescription } from '../src/input';

const action = { schema: 'action-ir/v0.1', id: 'A-1', amount: { value: '8420000', asset: 'USDM' } };
const signature = 'ab'.repeat(64);

describe('parseAuthorityInput', () => {
  it('structured: proposal object', () => {
    expect(parseAuthorityInput({ mandate_id: 'M-001', mode: 'structured', proposal: { action, agent_signature: signature } })).toEqual({
      mandate_id: 'M-001',
      proposal: { action, agent_signature: signature },
    });
  });

  it('structured: proposal as JSON text (MIP-003 textarea)', () => {
    expect(parseAuthorityInput({ mandate_id: 'M-001', proposal: JSON.stringify({ action, agent_signature: null }) })).toEqual({
      mandate_id: 'M-001',
      proposal: { action, agent_signature: null },
    });
  });

  it('text mode', () => {
    expect(parseAuthorityInput({ mandate_id: 'M-001', request_text: '  Pay AWS invoice INV-M-0001 ' })).toEqual({
      mandate_id: 'M-001',
      request_text: 'Pay AWS invoice INV-M-0001',
    });
  });

  it('leaves Action IR validation to the engine (amount as number passes through untouched)', () => {
    const hostile = { ...action, amount: { value: 8.42, asset: 'USDM' }, extra: true };
    const r = parseAuthorityInput({ mandate_id: 'M-001', proposal: { action: hostile, agent_signature: signature } });
    expect(r).toEqual({ mandate_id: 'M-001', proposal: { action: hostile, agent_signature: signature } });
  });

  it.each<[string, unknown]>([
    ['unknown top-level field', { mandate_id: 'M-001', request_text: 'x', admin: true }],
    ['both proposal and request_text', { mandate_id: 'M-001', request_text: 'x', proposal: { action, agent_signature: null } }],
    ['neither', { mandate_id: 'M-001' }],
    ['bad mandate id', { mandate_id: 'M 001; drop', request_text: 'x' }],
    ['proposal is not JSON', { mandate_id: 'M-001', proposal: '{not json' }],
    ['proposal with extra key', { mandate_id: 'M-001', proposal: { action, agent_signature: null, approved: true } }],
    ['signature is a number', { mandate_id: 'M-001', proposal: { action, agent_signature: 7 } }],
    ['action is an array', { mandate_id: 'M-001', proposal: { action: [action], agent_signature: null } }],
    ['mode text with proposal', { mandate_id: 'M-001', mode: 'text', proposal: { action, agent_signature: null } }],
    ['mode structured with text', { mandate_id: 'M-001', mode: 'structured', request_text: 'x' }],
    ['request_text too long', { mandate_id: 'M-001', request_text: 'x'.repeat(2001) }],
    ['larger than 16 KiB', { mandate_id: 'M-001', proposal: { action: { blob: 'x'.repeat(17_000) }, agent_signature: null } }],
    ['input is a string', 'Pay AWS'],
    ['input is null', null],
    ['input is an array', [{ mandate_id: 'M-001', request_text: 'x' }]],
  ])('rejects %s', (_label, raw) => {
    expect(() => parseAuthorityInput(raw)).toThrow(InputError);
  });
});

describe('parseTaskDescription', () => {
  it('JSON description uses the input schema', () => {
    expect(parseTaskDescription(JSON.stringify({ mandate_id: 'M-001', proposal: { action, agent_signature: signature } }))).toEqual({
      mandate_id: 'M-001',
      proposal: { action, agent_signature: signature },
    });
  });

  it('plain text is a request against M-001', () => {
    expect(parseTaskDescription('Pay AWS invoice INV-M-0001')).toEqual({ mandate_id: 'M-001', request_text: 'Pay AWS invoice INV-M-0001' });
  });

  it.each([null, '', '   ', '{"mandate_id": "M-001"', '{"mandate_id":"M-001"}'])('rejects %j', (d) => {
    expect(() => parseTaskDescription(d)).toThrow(InputError);
  });
});

describe('INPUT_SCHEMA', () => {
  it('follows MIP-003 Attachment 01', () => {
    const ids = INPUT_SCHEMA.input_data.map((f) => f.id);
    expect(ids).toEqual(['mandate_id', 'proposal', 'request_text']);
    for (const f of INPUT_SCHEMA.input_data) {
      expect(typeof f.name).toBe('string');
      expect(['text', 'textarea']).toContain(f.type);
    }
  });
});
