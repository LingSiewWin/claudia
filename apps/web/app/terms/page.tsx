import type { Metadata } from 'next';
import { SiteFooter, SiteHeader } from '../../components/site-nav';

export const dynamic = 'force-static';
export const metadata: Metadata = {
  title: 'Terms',
  description: 'Terms of service for the Claudia authority endpoint.',
};

const sections: Array<[string, string]> = [
  [
    'What the service does',
    'Claudia evaluates an action an agent proposes against a mandate a human has signed and returns ALLOW, ESCALATE or DENY with a decision brief. On ESCALATE the agent may post a bond to reach the named human. Only that human signature moves funds. Claudia never holds a human key.',
  ],
  [
    'Testnet only',
    'The public service runs on Cardano preprod and Ethereum Sepolia. Test tokens have no monetary value. Do not send mainnet assets to any address shown on this site.',
  ],
  [
    'Bonds',
    'An escalation bond is locked in a non-custodial escrow. It is refunded to the agent when the human answers or when the lock expires. It is captured to an always-fail sink when the human marks the request frivolous. The approver is never paid from a bond.',
  ],
  [
    'No warranty',
    'The service is provided as is, without warranty of any kind. Decisions are deterministic engine outcomes, not financial, legal or tax advice. You remain responsible for the mandates you sign and the agents you run.',
  ],
  [
    'Changes',
    'These terms may change as the protocol evolves. The protocol document at /llms-full.txt is the reference for current behaviour.',
  ],
];

export default function TermsPage() {
  return (
    <main className="mx-auto max-w-3xl px-5 py-8">
      <SiteHeader />
      <h1 className="mt-10 text-3xl font-extrabold tracking-tight">Terms of service</h1>
      <p className="mt-2 text-sm text-muted">Last updated 7 October 2026.</p>
      {sections.map(([h, body]) => (
        <section key={h} className="mt-8">
          <h2 className="text-lg font-bold">{h}</h2>
          <p className="mt-2 text-[15px] leading-relaxed">{body}</p>
        </section>
      ))}
      <SiteFooter />
    </main>
  );
}
