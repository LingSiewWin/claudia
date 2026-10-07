import Link from 'next/link';
import type { ReactNode } from 'react';
import { HeroReplay } from '../components/hero-replay';

// Two sections only: the product (headline, the two actions, a real replayed payment) and the protocol behind
// "Read the protocol". No feature grids, logos, testimonials, pricing, nav, or footer.
export default function Home() {
  return (
    <main className="mx-auto max-w-6xl px-5 py-12 sm:py-20">
      <section className="grid items-start gap-12 lg:grid-cols-[1fr_minmax(0,34rem)]">
        <div>
          <h1 className="text-5xl font-extrabold leading-[1.02] tracking-tight sm:text-7xl">
            Give AI agents authority, not credentials.
          </h1>
          <p className="mt-6 max-w-xl text-xl text-muted">
            Your AI employee pays vendor invoices from the company treasury. You decide what it may pay alone, what needs the
            CFO, and what nobody can pay. The vault enforces it.
          </p>
          <div className="mt-8 flex flex-wrap gap-4">
            <Link href="/live" className="btn-strong text-lg">
              Watch it act
            </Link>
            <a href="#protocol" className="btn text-lg">
              Read the protocol
            </a>
          </div>
        </div>
        <HeroReplay />
      </section>

      <section id="protocol" aria-label="Protocol" className="mt-24 max-w-3xl scroll-mt-12">
        <h2 className="text-2xl font-extrabold tracking-tight">Before any money moves</h2>
        <dl className="mt-6 divide-y divide-line border-y border-line">
          <Step title="The mandate allows it" label="MAY? · Authority Engine">
            Purpose, vendor, per-payment limit, daily cap, and treasury minimum, checked the same way every time. The
            agent&apos;s reasoning is shown, never trusted.
          </Step>
          <Step title="The invoice is real" label="TRUE? · Chainlink CRE">
            Independent nodes read the invoice at the billing source and record on Sepolia that it exists, is open, matches
            the amount, and pays the vendor&apos;s own address.
          </Step>
          <Step title="The vault enforces it" label="ENFORCED · Cardano vault">
            The vault releases only the exact signed amount to the exact recipient, once. Above the autonomous limit it also
            needs the CFO&apos;s key. Every receipt can be checked in your browser.{' '}
            <Link href="/mandate/M-001" className="underline">
              See a mandate
            </Link>
          </Step>
        </dl>
      </section>
    </main>
  );
}

function Step({ title, label, children }: { title: string; label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 py-4 sm:grid-cols-[14rem_1fr] sm:gap-6">
      <dt>
        <p className="text-lg font-bold">{title}</p>
        <p className="text-sm font-semibold tracking-wide text-muted">{label}</p>
      </dt>
      <dd className="text-[17px] leading-relaxed">{children}</dd>
    </div>
  );
}
