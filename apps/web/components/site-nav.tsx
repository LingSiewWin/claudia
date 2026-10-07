import Link from 'next/link';
import { Suspense } from 'react';
import { ModeSwitch } from './mode-switch';

/** One line, top and bottom of the public pages. Product links left, agent-readable links right. */
export function SiteHeader({ current }: { current?: 'protocol' }) {
  return (
    <header className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 border-b border-line pb-4 text-[15px]">
      <span className="flex items-center gap-4">
        <Link href="/" className="font-extrabold tracking-tight">
          Claudia
        </Link>
        <Suspense fallback={null}>
          <ModeSwitch />
        </Suspense>
      </span>
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
      <p>Claudia, the human authority layer for AI agents. Cardano preprod, Sepolia. No funds are held by the service.</p>
      <p className="flex flex-wrap gap-x-4 font-semibold">
        <a href="https://github.com/LingSiewWin/claudia" rel="noreferrer">
          GitHub
        </a>
        <a href="https://preprod.sokosumi.com/" rel="noreferrer">
          Sokosumi
        </a>
        <a href="https://x.com/siewwwin" rel="noreferrer">
          X
        </a>
        <a href="https://www.linkedin.com/in/ling-siew-win" rel="noreferrer">
          LinkedIn
        </a>
        <a href="mailto:siewwwin@gmail.com">Email</a>
        <Link href="/terms">Terms</Link>
        <Link href="/privacy">Privacy</Link>
      </p>
    </footer>
  );
}
