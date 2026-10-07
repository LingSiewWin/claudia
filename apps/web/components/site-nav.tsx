import Link from 'next/link';

/** One line, top and bottom of the public pages. Product links left, agent-readable links right. */
export function SiteHeader({ current }: { current?: 'protocol' }) {
  return (
    <header className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 border-b border-line pb-4 text-[15px]">
      <Link href="/" className="font-extrabold tracking-tight">
        Authority Layer
      </Link>
      <nav aria-label="Site" className="flex flex-wrap gap-x-5 gap-y-1 font-semibold">
        <Link href="/live?mode=replay">Replay</Link>
        <Link href="/console">Console</Link>
        <Link href="/mandate/M-001">Mandate</Link>
        <Link href="/authority/CFO">Authority</Link>
        <Link href="/protocol" aria-current={current === 'protocol' ? 'page' : undefined} className={current === 'protocol' ? 'underline underline-offset-4' : ''}>
          Protocol
        </Link>
      </nav>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="mt-24 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 border-t border-line pt-4 text-sm text-muted">
      <p>Authority Layer. Cardano preprod, Sepolia. No funds are held by the service.</p>
      <p className="flex flex-wrap gap-x-4 font-mono text-[13px]">
        <a href="/llms.txt">/llms.txt</a>
        <a href="/llms-full.txt">/llms-full.txt</a>
        <a href="/.well-known/agent.json">/.well-known/agent.json</a>
      </p>
    </footer>
  );
}
