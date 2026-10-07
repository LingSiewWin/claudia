import type { AgentModel } from '@authority/llm';
import { fakeBondPayer, newEscalationState } from '../src/bond';
import type { RuntimeDeps } from '../src/runtime';
import { AGENT_SK, LAB_AGENT_SK, NOW, type fakeAuthority } from './fake-authority';

export function deps(fake: ReturnType<typeof fakeAuthority>, model: AgentModel, over: Partial<RuntimeDeps> = {}) {
  const lines: Record<string, unknown>[] = [];
  const d: RuntimeDeps = {
    authority: fake.client,
    model,
    invoices: fake.invoices,
    agentKeys: new Map([
      ['M-001', AGENT_SK],
      ['M-LAB', LAB_AGENT_SK],
    ]),
    now: () => NOW,
    sleep: async () => undefined,
    pollMs: 1,
    resolveTimeoutMs: 0,
    maxTurns: 8,
    payer: fakeBondPayer(),
    maxBondLovelace: 10_000_000n,
    escalation: newEscalationState(),
    log: (l) => void lines.push(l),
    ...over,
  };
  return { deps: d, lines };
}
