import type { Metadata } from 'next';
import { SiteFooter, SiteHeader } from '../../components/site-nav';
import { render } from '../../lib/markdown';
import { protocolMarkdown } from '../../lib/protocol';

export const dynamic = 'force-static';
export const metadata: Metadata = {
  title: 'Protocol',
  description: 'Outcomes, Action IR, mandate, the HTTP 402 escalation flow, bond rules, Decision Brief and endpoints.',
};

/** The protocol document, rendered from public/llms-full.txt at build time. Same text agents read. */
export default function ProtocolPage() {
  const { html, headings } = render(protocolMarkdown());
  const sections = headings.filter((h) => h.level === 2);
  return (
    <main className="mx-auto max-w-6xl px-5 py-8">
      <SiteHeader current="protocol" />
      <div className="mt-10 grid gap-10 lg:grid-cols-[15rem_minmax(0,1fr)]">
        <aside className="lg:sticky lg:top-8 lg:self-start">
          <p className="text-sm font-extrabold tracking-wide">CONTENTS</p>
          <ol className="mt-3 space-y-1.5 text-[15px]">
            {sections.map((h, i) => (
              <li key={h.id} className="grid grid-cols-[1.6rem_1fr] gap-1">
                <span className="font-mono text-[13px] text-muted">{String(i + 1).padStart(2, '0')}</span>
                <a href={`#${h.id}`} className="hover:underline">
                  {h.text}
                </a>
              </li>
            ))}
          </ol>
          <p className="mt-6 text-sm text-muted">
            Agents read the same document at{' '}
            <a className="font-mono text-[13px] underline" href="/llms-full.txt">
              /llms-full.txt
            </a>{' '}
            and{' '}
            <a className="font-mono text-[13px] underline" href="/protocol.md">
              /protocol.md
            </a>
            .
          </p>
        </aside>
        {/* The HTML is produced by lib/markdown.ts from a file in this repository; every string in it is escaped there. */}
        <article className="doc" dangerouslySetInnerHTML={{ __html: html }} />
      </div>
      <SiteFooter />
    </main>
  );
}
