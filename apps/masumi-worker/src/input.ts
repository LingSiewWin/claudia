import * as z from 'zod';

export const MAX_INPUT_BYTES = 16_384;
export const DEFAULT_MANDATE_ID = 'M-001';

export type AuthorityRequest =
  | { mandate_id: string; proposal: { action: Record<string, unknown>; agent_signature: string | null } }
  | { mandate_id: string; request_text: string };

export class InputError extends Error {}

const MandateId = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/);
// Envelope only. The Action IR itself is validated by the Authority Engine (INVALID_PROPOSAL).
const Proposal = z.strictObject({
  action: z.record(z.string(), z.unknown()),
  agent_signature: z.string().max(256).nullable(),
});
const Input = z.strictObject({
  mandate_id: MandateId,
  mode: z.enum(['structured', 'text']).optional(),
  proposal: z.union([Proposal, z.string().min(1)]).optional(),
  request_text: z.string().trim().min(1).max(2000).optional(),
});

// MIP-003 input_data (or a JSON Task description) -> Authority Check API request.
export function parseAuthorityInput(raw: unknown): AuthorityRequest {
  if (Buffer.byteLength(JSON.stringify(raw ?? null), 'utf8') > MAX_INPUT_BYTES) throw new InputError('input is larger than 16 KiB');
  const parsed = Input.safeParse(raw);
  if (!parsed.success) {
    throw new InputError(`invalid input: ${parsed.error.issues.map((i) => i.path.join('.') || '(root)').join(', ')}`);
  }
  const { mandate_id, mode, proposal, request_text } = parsed.data;
  if (proposal !== undefined && request_text !== undefined) throw new InputError('provide proposal or request_text, not both');
  if (proposal !== undefined) {
    if (mode === 'text') throw new InputError('mode "text" needs request_text');
    let value: unknown = proposal;
    if (typeof proposal === 'string') {
      try {
        value = JSON.parse(proposal);
      } catch {
        throw new InputError('proposal is not valid JSON');
      }
    }
    const p = Proposal.safeParse(value);
    if (!p.success) throw new InputError('proposal must be {"action": {...}, "agent_signature": "<hex>" | null}');
    return { mandate_id, proposal: p.data };
  }
  if (request_text === undefined) throw new InputError('provide proposal or request_text');
  if (mode === 'structured') throw new InputError('mode "structured" needs proposal');
  return { mandate_id, request_text };
}

// Sokosumi Task description: JSON in the same shape as input_data, or plain English against M-001.
export function parseTaskDescription(description: string | null): AuthorityRequest {
  const text = (description ?? '').trim();
  if (!text) throw new InputError('Task description is empty');
  if (!text.startsWith('{')) return parseAuthorityInput({ mandate_id: DEFAULT_MANDATE_ID, request_text: text });
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new InputError('Task description starts with "{" but is not valid JSON');
  }
  return parseAuthorityInput(raw);
}

// MIP-003 /input_schema (field format: MIP-003 Attachment 01).
export const INPUT_SCHEMA = {
  input_data: [
    {
      id: 'mandate_id',
      type: 'text',
      name: 'Mandate ID',
      data: { default: DEFAULT_MANDATE_ID, description: 'The mandate the action is checked against.' },
      validations: [
        { validation: 'min', value: '1' },
        { validation: 'max', value: '64' },
      ],
    },
    {
      id: 'proposal',
      type: 'textarea',
      name: 'Signed proposal (JSON)',
      data: {
        description:
          'JSON {"action": <Action IR>, "agent_signature": "<hex>"}. Only proposals signed by the mandate delegate can receive an authorization. Ready examples: GET /demo.',
      },
      validations: [
        { validation: 'optional', value: 'true' },
        { validation: 'max', value: '16000' },
      ],
    },
    {
      id: 'request_text',
      type: 'textarea',
      name: 'Request in plain English',
      data: {
        description:
          'Converted by an LLM into an untrusted interpreted action, shown verbatim in the result, and evaluated unsigned (no authorization).',
      },
      validations: [
        { validation: 'optional', value: 'true' },
        { validation: 'max', value: '2000' },
      ],
    },
  ],
};
