import { Marquee } from './ui/marquee';

type Row = { name: string; href: string; logo?: 'cardano' | 'chainlink'; text: string };

const ROWS: Row[] = [
  {
    name: 'Cardano',
    href: 'https://developers.cardano.org/x402/',
    logo: 'cardano',
    text: 'Aiken validators on preprod: mandate anchor, treasury vault, escalation bond escrow. Every release and bond is a real transaction.',
  },
  {
    name: 'Chainlink',
    href: 'https://docs.chain.link/cre',
    logo: 'chainlink',
    text: 'Two CRE workflows: invoice verification and FX basis against the BRL/USD Data Feed, reports written to Sepolia through the Keystone forwarder.',
  },
  {
    name: 'Masumi and Sokosumi',
    href: 'https://preprod.sokosumi.com/',
    text: 'Human Authority Endpoint registered on the Masumi preprod registry (MIP-003 worker, Masumi Payment Service) and running as a Sokosumi coworker (four paid Tasks completed).',
  },
  {
    name: 'x402',
    href: 'https://github.com/coinbase/x402',
    text: 'HTTP 402 transport headers PAYMENT-REQUIRED, PAYMENT-SIGNATURE, PAYMENT-RESPONSE with our cardano-escrow scheme.',
  },
];

type Tech = { name: string; href: string; logo?: 'cardano' | 'chainlink' };

const TECH: Tech[] = [
  { name: 'Cardano', href: 'https://developers.cardano.org/x402/', logo: 'cardano' },
  { name: 'Aiken', href: 'https://aiken-lang.org/' },
  { name: 'Chainlink', href: 'https://docs.chain.link/cre', logo: 'chainlink' },
  { name: 'Masumi', href: 'https://preprod.sokosumi.com/' },
  { name: 'Sokosumi', href: 'https://preprod.sokosumi.com/' },
  { name: 'x402', href: 'https://github.com/coinbase/x402' },
];

const FADE = 'linear-gradient(to right, transparent, black 10%, black 90%, transparent)';

/** Logos and wordmarks drifting above the four integration rows. Only Cardano and Chainlink have logo files; the rest are wordmarks. */
export function BuiltWith() {
  return (
    <section aria-label="Built with" className="mt-28">
      <p className="font-mono text-[13px] font-semibold uppercase tracking-[0.12em] text-muted">Built with</p>
      <Marquee
        repeat={3}
        className="mt-6 border-y border-line py-6 [&:hover>div]:[animation-play-state:paused]"
        style={{ '--gap': '4.5rem', '--duration': '32s', maskImage: FADE, WebkitMaskImage: FADE } as React.CSSProperties}
      >
        {TECH.map((t) => (
          <a key={t.name} href={t.href} target="_blank" rel="noreferrer" aria-label={t.name} className="flex shrink-0 items-center">
            {t.logo ? (
              <picture>
                <source srcSet={`/logos/${t.logo}.svg`} type="image/svg+xml" />
                <img src={`/logos/${t.logo}.png`} alt={t.name} className="logo-mark h-9 w-auto max-w-[12rem]" />
              </picture>
            ) : (
              <span className="text-3xl font-extrabold tracking-tight text-fg">{t.name}</span>
            )}
          </a>
        ))}
      </Marquee>
      <ul className="mt-6 divide-y divide-line border-b border-line">
        {ROWS.map((r) => (
          <li key={r.name} className="grid items-baseline gap-2 py-5 sm:grid-cols-[13rem_1fr] sm:gap-6">
            <a href={r.href} target="_blank" rel="noreferrer" className="flex items-baseline" aria-label={r.name}>
              {r.logo ? (
                <picture>
                  <source srcSet={`/logos/${r.logo}.svg`} type="image/svg+xml" />
                  <img src={`/logos/${r.logo}.png`} alt={r.name} className="logo-mark h-7 w-auto max-w-[11rem] self-center" />
                </picture>
              ) : (
                <span className="text-xl font-extrabold tracking-tight">{r.name}</span>
              )}
            </a>
            <p className="text-[15px] leading-relaxed">
              {r.text}{' '}
              <a href={r.href} target="_blank" rel="noreferrer" className="font-mono text-[13px] text-muted underline underline-offset-4">
                {r.href.replace(/^https:\/\//, '')}
              </a>
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
