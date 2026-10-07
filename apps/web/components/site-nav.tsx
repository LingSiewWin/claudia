import Link from 'next/link';
import { Suspense, type ReactNode } from 'react';
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
      <nav aria-label="Site" className="flex flex-wrap gap-x-5 font-semibold [&>a]:py-2.5">
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

function FooterGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <p className="font-mono text-[13px] font-semibold uppercase tracking-[0.12em]">{title}</p>
      <div className="mt-3 flex flex-col text-base font-semibold text-fg [&>a]:py-1.5">{children}</div>
    </div>
  );
}

export function SiteFooter() {
  return (
    <footer className="mt-24 grid grid-cols-2 gap-x-6 gap-y-10 border-t border-line pb-8 pt-10 text-sm text-muted lg:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))]">
      <div className="col-span-2 lg:col-span-1">
        <p className="font-serif text-3xl leading-none text-heading">Claudia</p>
        <p className="mt-3 max-w-sm text-base leading-snug text-fg">The human authority layer for AI agents.</p>
        <p className="mt-2 max-w-sm">Cardano preprod, Sepolia. No funds are held by the service.</p>
      </div>
      <FooterGroup title="Build">
        <a href="https://github.com/LingSiewWin/claudia" rel="noreferrer">
          GitHub
        </a>
        <a href="https://preprod.sokosumi.com/" rel="noreferrer">
          Sokosumi
        </a>
      </FooterGroup>
      <FooterGroup title="Reach us">
        <a href="https://x.com/siewwwin" rel="noreferrer">
          X
        </a>
        <a href="https://www.linkedin.com/in/ling-siew-win" rel="noreferrer">
          LinkedIn
        </a>
        <a href="mailto:siewwwin@gmail.com">Email</a>
      </FooterGroup>
      <FooterGroup title="Legal">
        <Link href="/terms">Terms</Link>
        <Link href="/privacy">Privacy</Link>
      </FooterGroup>
    </footer>
  );
}
