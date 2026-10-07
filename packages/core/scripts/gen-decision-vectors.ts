import { writeFileSync } from 'node:fs';
import { bytesToHex } from '../src/bytes';
import { type DecisionOutcome, decisionHash, decisionPreimage } from '../src/decision';

export interface DecisionVectorInputs {
  action_hash: string | null;
  mandate_hash: string | null;
  verification_ref: string | null;
  outcome: DecisionOutcome;
}

const A = 'dd'.repeat(32);
const M = 'cc'.repeat(32);
const V = 'ee'.repeat(32);

export function decisionVectorCases(): Array<{ name: string; inputs: DecisionVectorInputs }> {
  return [
    { name: 'ALLOW, all parts set', inputs: { action_hash: A, mandate_hash: M, verification_ref: V, outcome: 'ALLOW' } },
    { name: 'ESCALATE, all parts set', inputs: { action_hash: A, mandate_hash: M, verification_ref: V, outcome: 'ESCALATE' } },
    { name: 'DENY, no action hash', inputs: { action_hash: null, mandate_hash: M, verification_ref: V, outcome: 'DENY' } },
    { name: 'DENY, no verification ref', inputs: { action_hash: A, mandate_hash: M, verification_ref: null, outcome: 'DENY' } },
    { name: 'DENY, no action hash or verification ref', inputs: { action_hash: null, mandate_hash: M, verification_ref: null, outcome: 'DENY' } },
    { name: 'DENY, all parts missing', inputs: { action_hash: null, mandate_hash: null, verification_ref: null, outcome: 'DENY' } },
  ];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const vectors = decisionVectorCases().map(({ name, inputs }) => {
    const args = [inputs.action_hash, inputs.mandate_hash, inputs.verification_ref, inputs.outcome] as const;
    return { name, inputs, preimage_hex: bytesToHex(decisionPreimage(...args)), decision_hash: decisionHash(...args) };
  });
  writeFileSync(new URL('../test/vectors/decision.json', import.meta.url), `${JSON.stringify(vectors, null, 2)}\n`);
  console.log(`wrote ${vectors.length} vectors`);
}
