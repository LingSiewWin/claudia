import Link from 'next/link';
import { SiteFooter, SiteHeader } from '../components/site-nav';

export default function NotFound() {
  return (
    <main className="mx-auto max-w-3xl px-5 py-8">
      <SiteHeader />
      <h1 className="mt-10 text-3xl font-extrabold tracking-tight">Not found</h1>
      <p className="mt-2 text-[15px] leading-relaxed text-muted">There is no page at this address. Receipts and mandates live under their own ids.</p>
      <p className="mt-6 flex flex-wrap gap-x-5 text-[15px] font-semibold">
        <Link href="/">Home</Link>
        <Link href="/live?mode=replay">Replay</Link>
        <Link href="/protocol">Protocol</Link>
        <Link href="/llms.txt">llms.txt</Link>
      </p>
      <SiteFooter />
    </main>
  );
}
