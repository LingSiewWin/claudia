'use client';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect } from 'react';
import { type SiteMode, modeFrom } from '../lib/mode';

const KEY = 'claudia.mode';
const MODES: { mode: SiteMode; label: string; href: string }[] = [
  { mode: 'human', label: 'Human', href: '/' },
  { mode: 'agent', label: 'Agent', href: '/?mode=agent' },
];

/**
 * Human | Agent. The URL is the source of truth (`?mode=agent` on `/`); localStorage mirrors the last choice so a
 * return visit to `/` reopens the same reader. Off `/`, both tabs link back to the landing page.
 */
export function ModeSwitch() {
  const pathname = usePathname();
  const params = useSearchParams();
  const router = useRouter();
  const onHome = pathname === '/';
  const mode = onHome ? modeFrom(params.get('mode') ?? undefined) : null;

  useEffect(() => {
    if (!onHome) return;
    try {
      if (params.has('mode') || mode === 'agent') localStorage.setItem(KEY, mode ?? 'human');
      else if (localStorage.getItem(KEY) === 'agent') router.replace('/?mode=agent');
    } catch {
      // storage unavailable: the URL alone decides
    }
  }, [onHome, mode, params, router]);

  return (
    <div role="tablist" aria-label="Reader" data-testid="mode-switch" className="inline-flex rounded-full border border-line p-0.5 text-[13px] font-bold">
      {MODES.map((m) => {
        const active = mode === m.mode;
        return (
          <Link
            key={m.mode}
            role="tab"
            aria-selected={active}
            tabIndex={active || mode === null ? 0 : -1}
            href={m.href}
            onClick={() => {
              try {
                localStorage.setItem(KEY, m.mode);
              } catch {
                // ignore
              }
            }}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
              e.preventDefault();
              const next = (e.currentTarget.parentElement?.querySelector(`a[role=tab]:not([href="${m.href}"])`) as HTMLElement | null) ?? null;
              next?.focus();
            }}
            className={`rounded-full px-3 py-1 ${active ? 'bg-heading text-surface' : 'text-muted'}`}
          >
            {m.label}
          </Link>
        );
      })}
    </div>
  );
}
