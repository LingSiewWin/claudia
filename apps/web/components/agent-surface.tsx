import { CopyButton } from './copy-button';

const FILES: [string, string][] = [
  ['/llms.txt', 'summary'],
  ['/llms-full.txt', 'full protocol'],
  ['/.well-known/agent.json', 'agent card'],
  ['/openapi.json', 'MIP-003 job API'],
];
const CURL = 'curl -s https://claudiahq.vercel.app/llms.txt';
const FACTS = [
  'Human authority layer for AI agents: the agent proposes, a mandate decides, a human signs.',
  'Every action ends in one word: ALLOW, ESCALATE or DENY.',
  'ESCALATE answers HTTP 402: the agent locks a 5 ADA bond before a human is interrupted.',
  'Masumi MIP-003 service on Sokosumi preprod: 1 tUSDM per evaluation.',
  'Endpoints: GET /v1/authority/{role}, GET /v1/metrics, POST /v1/authority/check.',
];

/** The landing page for an agent: four file links, one curl line, five facts. A link opens the raw file. */
export function AgentSurface() {
  return (
    <section aria-label="Agent reader" data-testid="agent-surface" className="mt-12 max-w-3xl">
      <ul aria-label="Files" className="grid gap-3 font-mono text-[15px] sm:grid-cols-2">
        {FILES.map(([path, what]) => (
          <li key={path} className="flex items-baseline justify-between gap-4 border-b border-line pb-3">
            <a href={path} className="font-bold text-heading underline underline-offset-4">
              {path}
            </a>
            <span className="text-[13px] text-muted">{what}</span>
          </li>
        ))}
      </ul>
      <p className="mt-8 flex flex-wrap items-center gap-x-3 gap-y-2 font-mono text-[14px]">
        <code className="rounded-[8px] border border-line bg-raised px-3 py-2">{CURL}</code>
        <CopyButton text={CURL} label="curl example" />
      </p>
      <ol aria-label="Facts" className="mt-8 space-y-3 text-[17px] leading-snug">
        {FACTS.map((f) => (
          <li key={f} className="grid grid-cols-[1.25rem_1fr] gap-2">
            <span aria-hidden className="text-muted">
              –
            </span>
            {f}
          </li>
        ))}
      </ol>
    </section>
  );
}
