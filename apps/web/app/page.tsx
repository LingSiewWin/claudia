import Image from 'next/image';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { AgentSurface } from '../components/agent-surface';
import { BudgetPeek } from '../components/budget-peek';
import { HeroFloor } from '../components/floor/hero-floor';
import { SiteFooter, SiteHeader } from '../components/site-nav';
import { ContainerScroll } from '../components/ui/container-scroll-animation';
import { cardanoscanTxUrl, sepoliaTxUrl } from '../lib/config';
import { modeFrom } from '../lib/mode';

const SOKOSUMI = 'https://preprod.sokosumi.com/';

/* Real preprod transactions from the end-to-end run. Each row is a link anyone can open. */
const ONCHAIN: { what: string; hash: string; note: string }[] = [
  { what: 'Bond refunded', hash: '29cd8f8ce51ee103f3c3c57a912fa4573f7084d905f54e47843d53a930c1ecae', note: 'Approver signed the refund. Approver balance unchanged.' },
  { what: 'Bond captured', hash: 'cd77ade3de312471ac725ef8f0f31ba53ab00fd640e491946d4de974e6fcd88e', note: '5 ADA paid to the always-fail sink. Approver balance unchanged.' },
  { what: 'Vault minted', hash: 'ab5b303c1c416efaed2d99683d93ba05ef4f494f6b21994767357bf554f1e200', note: 'Mandate M-LAB vault, 10 tUSDM, enforcing mandate hash 43b25a12… v1.' },
  { what: 'Mandate anchored', hash: 'fe05f66e17676d1973e3c89de350b5397f43c985a1717cd9698414d9529575ab', note: 'Anchor token under policy 145572c0…19fb. The vault reads it on every release.' },
];

/* Chainlink CRE reports on Sepolia: the invoice verification and the FX basis attestation. */
const CRE_INVOICE_TX = '0x68bdc690cf4338f3009f59487ceeaba4ff8a57f237b044be06a5a21abdcdfd98';
const CRE_FX_TX = '0x2549899d0f1884b944320919279ce0ce98539aeaa761b9a210bde332071b78a8';

const ATTACKS = ['Above hard cap', 'Wrong asset', 'Approver bypass', 'Withdraw by anyone', 'Update by anyone', 'Revoke by approver', 'Second mandate mint', 'Second vault mint'];

/** `/` has two readers. `?mode=agent` renders the machine-readable files verbatim; everything else is the human page. */
export default async function Home({ searchParams }: { searchParams: Promise<{ mode?: string | string[] }> }) {
  const mode = modeFrom((await searchParams).mode);
  return (
    <main data-reader={mode} className="shell py-8">
      <SiteHeader />
      {mode === 'agent' ? <AgentSurface /> : <HumanHome />}
      <SiteFooter />
    </main>
  );
}

function HumanHome() {
  return (
    <>
      <section aria-label="Thesis" className="mt-16">
        <h1 className="font-serif text-[clamp(2.6rem,7.5vw,7rem)] leading-[0.98] tracking-[-0.02em]">
          Give your agents an allowance, <em className="text-muted">not your keys.</em>
        </h1>
        <p className="mt-8 max-w-3xl text-xl leading-snug sm:text-2xl 2xl:max-w-4xl 2xl:text-3xl">
          Each agent gets its own wallet and a daily allowance. Above the limit it pays a bond to ask you, and only your signature moves
          the money.
        </p>
        <div className="mt-8 flex flex-wrap items-center gap-3">
          <Link href="/live?mode=replay" className="btn-strong">
            Watch it act
          </Link>
          <Link href="/protocol" className="btn">
            Read the protocol
          </Link>
        </div>
        <p className="mt-4 text-[15px]">
          <a href={SOKOSUMI} className="font-semibold underline underline-offset-4" rel="noreferrer">
            Try it on Sokosumi
          </a>
          <span className="text-muted"> · 1 tUSDM per evaluation</span>
        </p>
        <div className="mt-12">
          <Eyebrow>A recorded run on the authority floor</Eyebrow>
          <div className="mt-4">
            <HeroFloor />
          </div>
        </div>
        <p className="mt-4 max-w-3xl text-[15px] text-muted">
          An agent escalates three frivolous invoices and loses a 5 ADA bond each time. The fourth is denied at the gate, and nobody is
          paged.
        </p>
        <dl aria-label="Allowance, ask, sign" className="mt-12 grid gap-6 border-t border-line pt-6 sm:grid-cols-3">
          <Pillar name="Allowance">Daily cap, per-action limit, approved counterparties.</Pillar>
          <Pillar name="Ask">HTTP 402 plus a bond: refunded when the ask is reasonable, captured when it is not.</Pillar>
          <Pillar name="Sign">Only your wallet signature moves money out of the vault.</Pillar>
        </dl>
      </section>

      <section aria-label="Agents on Sokosumi" className="mt-8">
        <ContainerScroll
          titleComponent={
            <>
              <Eyebrow>Agents work as coworkers</Eyebrow>
              <h2 className="mt-3 font-serif text-[clamp(2rem,5vw,4.5rem)] leading-[1.02] tracking-tight">
                Hire an agent. <em className="text-muted">Keep the signature.</em>
              </h2>
            </>
          }
        >
          <Image
            src="/sokosumi-coworkers.jpg"
            alt="The Sokosumi preprod workspace: a row of AI coworkers, a chat button and a summary of tasks completed in the last 24 hours."
            width={1590}
            height={860}
            className="mx-auto h-full w-full rounded-2xl object-cover object-center"
            draggable={false}
          />
        </ContainerScroll>
        <p className="mx-auto max-w-2xl text-center text-lg text-muted">
          On Sokosumi, agents take tasks like coworkers. Claudia is the authority they ask before money moves.{' '}
          <a href={SOKOSUMI} className="font-semibold text-fg underline underline-offset-4" rel="noreferrer">
            Open Sokosumi preprod
          </a>
        </p>
      </section>

      <section aria-label="Facts come from Chainlink CRE" className="mt-16 grid gap-6 border-y border-line py-6 lg:grid-cols-[minmax(0,18rem)_1fr]">
        <h2 className="font-serif text-3xl leading-[1.05] tracking-tight">Facts come from Chainlink CRE</h2>
        <ol className="space-y-3 text-[15px] leading-relaxed">
          <Fact n={1} href={sepoliaTxUrl(CRE_INVOICE_TX)} link="Invoice report on Sepolia">
            Invoice verification: a CRE workflow fetches the vendor invoice, nodes agree on six facts, and the signed report lands on Sepolia.
          </Fact>
          <Fact n={2} href={sepoliaTxUrl(CRE_FX_TX)} link="FX basis report on Sepolia">
            FX basis: a second workflow reads the Chainlink BRL/USD feed on Ethereum mainnet and attests whether a quote is on market.
          </Fact>
          <Fact n={3}>
            The report hash is inside the bytes the human signs, so the Cardano vault only releases funds for an action whose facts were
            verified.
          </Fact>
        </ol>
      </section>

      <section aria-label="How it works" className="mt-28 grid gap-8 lg:grid-cols-[minmax(0,18rem)_1fr]">
        <div>
          <Eyebrow>How it works</Eyebrow>
          <h2 className="mt-2 font-serif text-4xl leading-[1.05] tracking-tight">Six steps between a proposal and a payment</h2>
          <p className="mt-4 text-[15px] text-muted">The same stations as on the floor above, read left to right.</p>
        </div>
        <ol className="divide-y divide-line border-y border-line">
          <Step n={1} title="Propose" label="agent">
            The agent writes an Action IR: what, how much, to whom, why, under which mandate. It signs it with its delegate key. The
            rationale is shown to the human, never trusted.
          </Step>
          <Step n={2} title="Evaluate" label="authority engine">
            Purpose, vendor, per-payment limit, daily cap, treasury floor, interrupt budget. Same inputs, same answer, no model in the
            loop. One of ALLOW, ESCALATE, DENY.
          </Step>
          <Step n={3} title="Verify" label="Chainlink CRE">
            Independent nodes read the invoice at the billing source and record on Sepolia that it exists, is open, matches the amount,
            and pays the vendor&apos;s own address.
          </Step>
          <Step n={4} title="402 and bond" label="x402 on Cardano">
            An escalation answers HTTP 402 with a price. The agent locks a 5 ADA bond in escrow and retries. Until the bond is on chain,
            no human hears about it.
          </Step>
          <Step n={5} title="Brief and signature" label="the human">
            The approver reads a Decision Brief built from the evaluation, not from a chat transcript, and signs with a wallet on their
            own device. Approve or a reasonable decline refunds the bond; a frivolous ask is captured.
          </Step>
          <Step n={6} title="Vault and receipt" label="Cardano vault">
            The validator checks amount, recipient, nonce, expiry, mandate version and the approver&apos;s signature. Every decision lands
            in a hash-chained log with a receipt anyone can recompute.
          </Step>
        </ol>
      </section>

      <section aria-label="Outcomes" className="mt-28">
        <Eyebrow>Three outcomes</Eyebrow>
        <h2 className="mt-2 font-serif text-4xl leading-[1.05] tracking-tight">Every proposal ends in one word</h2>
        <dl className="mt-8 grid gap-8 border-t border-line pt-8 md:grid-cols-3">
          <Outcome name="ALLOW" color="bg-permit">
            Inside the mandate and below the agent&apos;s autonomous limit. Verified, signed by the engine, settled by the vault. No human
            hears about it.
          </Outcome>
          <Outcome name="ESCALATE" color="bg-cosign">
            Allowed by the mandate but above the agent&apos;s own limit. Priced at 402, bonded, briefed, signed by a named human.
          </Outcome>
          <Outcome name="DENY" color="bg-forbid">
            Outside the mandate, facts do not match, or the interrupt budget is spent. Nothing moves; the reason is logged.
          </Outcome>
        </dl>
      </section>

      <section aria-label="Interrupt budget" className="mt-28 grid gap-8 lg:grid-cols-[minmax(0,18rem)_1fr]">
        <div>
          <Eyebrow>Interrupt budget</Eyebrow>
          <h2 className="mt-2 font-serif text-4xl leading-[1.05] tracking-tight">Attention is budgeted like money</h2>
        </div>
        <div className="max-w-2xl">
          <p className="text-lg leading-snug">
            Each mandate sets how many times per day its approver may be paged. Past that, escalations are denied and nobody is
            notified. Poor requests cost the agent bonds and budget, so it learns to plan.
          </p>
          <div className="mt-5">
            <BudgetPeek />
          </div>
        </div>
      </section>

      <section aria-label="Live on Cardano preprod" className="mt-28">
        <Eyebrow>Live on Cardano preprod</Eyebrow>
        <h2 className="mt-2 font-serif text-4xl leading-[1.05] tracking-tight">Real transactions, not a mockup</h2>
        <ul className="mt-8 divide-y divide-line border-y border-line">
          {ONCHAIN.map((row) => (
            <li key={row.hash} className="grid gap-1 py-4 sm:grid-cols-[11rem_1fr] sm:gap-6">
              <p className="font-bold">{row.what}</p>
              <div>
                <a href={cardanoscanTxUrl(row.hash)} className="font-mono text-[13px] underline underline-offset-4" rel="noreferrer">
                  {row.hash.slice(0, 16)}…{row.hash.slice(-8)}
                </a>
                <p className="text-[15px] text-muted">{row.note}</p>
              </div>
            </li>
          ))}
          <li className="grid gap-1 py-4 sm:grid-cols-[11rem_1fr] sm:gap-6">
            <p className="font-bold">Attack lab</p>
            <div>
              <p className="text-[15px]">Eight forged releases against the live M-LAB vault, each rejected by the Cardano node with no funds moved:</p>
              <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[13px] text-muted">
                {ATTACKS.map((a) => (
                  <span key={a}>{a}</span>
                ))}
              </p>
              <p className="mt-1 text-sm text-muted">
                <Link href="/live?mode=replay" className="underline">
                  Replay the recorded attacks
                </Link>
              </p>
            </div>
          </li>
        </ul>
        <p className="mt-3 text-sm text-muted">
          Escrow <code className="font-mono text-[13px]">addr_test1wqplkq2g…lx093f</code>, sink{' '}
          <code className="font-mono text-[13px]">addr_test1wq3vnggr…wsu3l3</code>. The approver never receives bond money.
        </p>
      </section>

      <section aria-label="Who it is for" className="mt-28 grid gap-10 lg:grid-cols-[1fr_minmax(0,22rem)]">
        <div>
          <Eyebrow>Who it is for</Eyebrow>
          <h2 className="mt-2 font-serif text-4xl leading-[1.05] tracking-tight">People who already sign for money</h2>
          <dl className="mt-8 divide-y divide-line border-y border-line">
            <Audience title="Multisig signers">
              Let an agent prepare and pay the routine, and reach you only with a bonded, briefed, exact-action request.
            </Audience>
            <Audience title="Treasury operators">
              Write the mandate once: vendors, limits, daily cap, floor, interrupt budget. The vault enforces it on chain.
            </Audience>
            <Audience title="Finance teams running agents">
              Give the agent authority, not credentials. Every payment has a receipt that binds action, facts, brief and signature.
            </Audience>
          </dl>
        </div>
        <div className="border-l-2 border-fg pl-5">
          <p className="text-sm font-extrabold tracking-wide">START HERE</p>
          <ul className="mt-3 space-y-3 text-[15px]">
            <li>
              <Link href="/live?mode=replay" className="font-bold underline underline-offset-4">
                Watch it act
              </Link>
              <p className="text-muted">A recorded run, hash-checked in your browser, replayed at stage speed.</p>
            </li>
            <li>
              <a href={SOKOSUMI} className="font-bold underline underline-offset-4" rel="noreferrer">
                Try the authority endpoint on Sokosumi
              </a>
              <p className="text-muted">
                Preprod Coworker <span className="font-semibold text-fg">Human Authority Endpoint</span>. 1 tUSDM per evaluation; on ESCALATE
                you get the exact bond price and endpoint.
              </p>
            </li>
            <li>
              <Link href="/protocol" className="font-bold underline underline-offset-4">
                Read the protocol
              </Link>
              <p className="text-muted">Outcomes, Action IR, mandate, the 402 flow, bond rules, Decision Brief, endpoints.</p>
            </li>
            <li>
              <a href="/llms.txt" className="font-bold underline underline-offset-4">
                For agents
              </a>
              <p className="text-muted">
                <span className="font-mono text-[13px]">/llms.txt</span>, <span className="font-mono text-[13px]">/llms-full.txt</span>,{' '}
                <span className="font-mono text-[13px]">/.well-known/agent.json</span>.
              </p>
            </li>
          </ul>
        </div>
      </section>

      <section aria-label="Built with" className="mt-28">
        <Eyebrow>Built with</Eyebrow>
        <h2 className="mt-2 font-serif text-4xl leading-[1.05] tracking-tight">Built with</h2>
        <ul className="mt-8 divide-y divide-line border-y border-line">
          <BuiltWith name="Cardano" logo="cardano" href="https://developers.cardano.org/x402/">
            Aiken validators on preprod: mandate anchor, treasury vault, escalation bond escrow. Every release and bond is a real
            transaction.
          </BuiltWith>
          <BuiltWith name="Chainlink" logo="chainlink" href="https://docs.chain.link/cre">
            Two CRE workflows: invoice verification and FX basis against the BRL/USD Data Feed, reports written to Sepolia through the
            Keystone forwarder.
          </BuiltWith>
          <BuiltWith name="Masumi and Sokosumi" href="https://preprod.sokosumi.com/">
            Human Authority Endpoint registered on the Masumi preprod registry (MIP-003 worker, Masumi Payment Service) and listed as a
            Sokosumi coworker.
          </BuiltWith>
          <BuiltWith name="x402" href="https://github.com/coinbase/x402">
            HTTP 402 transport headers PAYMENT-REQUIRED, PAYMENT-SIGNATURE, PAYMENT-RESPONSE with our cardano-escrow scheme.
          </BuiltWith>
        </ul>
      </section>
    </>
  );
}

function Pillar({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div>
      <dt className="font-mono text-[12px] font-bold uppercase tracking-[0.12em]">{name}</dt>
      <dd className="mt-1 text-[15px] leading-snug text-muted">{children}</dd>
    </div>
  );
}

function Fact({ n, href, link, children }: { n: number; href?: string; link?: string; children: ReactNode }) {
  return (
    <li className="grid grid-cols-[2rem_1fr] gap-3">
      <span aria-hidden className="font-serif text-2xl leading-none text-muted">
        {n}
      </span>
      <p>
        {children}
        {href ? (
          <>
            {' '}
            <a href={href} className="font-mono text-[13px] underline underline-offset-4" target="_blank" rel="noreferrer">
              {link}
            </a>
          </>
        ) : null}
      </p>
    </li>
  );
}

/** A logo from public/logos (SVG, PNG fallback) or a text wordmark, baseline-aligned with one factual line. */
function BuiltWith({ name, logo, href, children }: { name: string; logo?: 'cardano' | 'chainlink'; href: string; children: ReactNode }) {
  return (
    <li className="grid items-baseline gap-2 py-5 sm:grid-cols-[13rem_1fr] sm:gap-6">
      <a href={href} target="_blank" rel="noreferrer" className="flex items-baseline" aria-label={name}>
        {logo ? (
          <picture>
            <source srcSet={`/logos/${logo}.svg`} type="image/svg+xml" />
            <img src={`/logos/${logo}.png`} alt={name} className="logo-mark h-7 w-auto max-w-[11rem] self-center" />
          </picture>
        ) : (
          <span className="text-xl font-extrabold tracking-tight">{name}</span>
        )}
      </a>
      <p className="text-[15px] leading-relaxed">
        {children}{' '}
        <a href={href} target="_blank" rel="noreferrer" className="font-mono text-[13px] text-muted underline underline-offset-4">
          {href.replace(/^https:\/\//, '')}
        </a>
      </p>
    </li>
  );
}

function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="font-mono text-[13px] font-semibold uppercase tracking-[0.12em] text-muted">{children}</p>;
}

function Step({ n, title, label, children }: { n: number; title: string; label: string; children: ReactNode }) {
  return (
    <li className="grid grid-cols-[3.5rem_1fr] gap-4 py-5 sm:grid-cols-[4.5rem_14rem_1fr]">
      <span aria-hidden className="font-serif text-4xl leading-none text-muted">
        {String(n).padStart(2, '0')}
      </span>
      <p className="text-lg font-bold leading-tight">
        {title}
        <span className="block font-mono text-[12px] font-semibold uppercase tracking-wider text-muted">{label}</span>
      </p>
      <p className="col-span-2 text-[15px] leading-relaxed sm:col-span-1">{children}</p>
    </li>
  );
}

function Outcome({ name, color, children }: { name: string; color: string; children: ReactNode }) {
  return (
    <div>
      <dt className="flex items-center gap-2 font-mono text-[13px] font-bold tracking-wide">
        <span aria-hidden className={`inline-block size-2.5 rounded-full ${color}`} />
        {name}
      </dt>
      <dd className="mt-3 text-[15px] leading-relaxed">{children}</dd>
    </div>
  );
}

function Audience({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 py-4 sm:grid-cols-[13rem_1fr] sm:gap-6">
      <dt className="text-lg font-bold">{title}</dt>
      <dd className="text-[15px] leading-relaxed">{children}</dd>
    </div>
  );
}
