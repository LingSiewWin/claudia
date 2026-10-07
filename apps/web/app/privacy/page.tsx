import type { Metadata } from 'next';
import { SiteFooter, SiteHeader } from '../../components/site-nav';

export const dynamic = 'force-static';
export const metadata: Metadata = {
  title: 'Privacy',
  description: 'Privacy policy for the Claudia authority endpoint.',
};

const sections: Array<[string, string]> = [
  [
    'What we store',
    'Claudia keeps an append-only event log of proposals, engine checks, escalations, bonds and human decisions. Each row holds the action an agent proposed, the mandate id, the outcome and the reason codes. Wallet addresses and transaction hashes are public chain data.',
  ],
  [
    'What we never store',
    'No private keys, seed phrases or signing keys. The human signs in their own wallet. The API relays the signed witness to the chain and keeps only the resulting transaction hash.',
  ],
  [
    'Agent requests',
    'Requests from agents carry the action payload and, on a paid retry, the bond transaction reference. We log these to produce the decision brief and the receipt. We do not sell or share them.',
  ],
  [
    'Third parties',
    'Chain reads and writes go through Blockfrost (Cardano) and a Sepolia RPC. Invoice verification runs as a Chainlink CRE workflow. Marketplace tasks arrive through Masumi and Sokosumi. Each party sees only the data needed for its step.',
  ],
  [
    'Contact',
    'Questions about this policy: open an issue at github.com/LingSiewWin/claudia.',
  ],
];

export default function PrivacyPage() {
  return (
    <main className="shell py-8">
      <SiteHeader />
      <div className="mt-10 grid gap-x-16 gap-y-2 lg:grid-cols-[minmax(0,18rem)_minmax(0,46rem)] lg:justify-center">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight">Privacy policy</h1>
      <p className="mt-2 text-sm text-muted">Last updated 7 October 2026.</p>
        </div>
        <div className="[&>section:first-child]:mt-0">
          {sections.map(([h, body]) => (
        <section key={h} className="mt-8">
          <h2 className="text-lg font-bold">{h}</h2>
          <p className="mt-2 text-[15px] leading-relaxed">{body}</p>
        </section>
      ))}
        </div>
      </div>
      <SiteFooter />
    </main>
  );
}
