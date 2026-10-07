import Link from 'next/link';
import type { ReactNode } from 'react';
import { BudgetPeek } from '../components/budget-peek';
import { HeroFloor } from '../components/floor/hero-floor';
import { SiteFooter, SiteHeader } from '../components/site-nav';
import { cardanoscanTxUrl } from '../lib/config';

const SOKOSUMI = 'https://preprod.sokosumi.com/';

/* Real preprod transactions from the end-to-end run. Each row is a link anyone can open. */
const ONCHAIN: { what: string; hash: string; note: string }[] = [
  { what: 'Bond refunded', hash: '29cd8f8ce51ee103f3c3c57a912fa4573f7084d905f54e47843d53a930c1ecae', note: 'Approver signed the refund. Approver balance unchanged.' },
  { what: 'Bond captured', hash: 'cd77ade3de312471ac725ef8f0f31ba53ab00fd640e491946d4de974e6fcd88e', note: '5 ADA paid to the always-fail sink. Approver balance unchanged.' },
  { what: 'Vault minted', hash: 'ab5b303c1c416efaed2d99683d93ba05ef4f494f6b21994767357bf554f1e200', note: 'Mandate M-LAB vault, 10 tUSDM, enforcing mandate hash 43b25a12… v1.' },
  { what: 'Mandate anchored', hash: 'fe05f66e17676d1973e3c89de350b5397f43c985a1717cd9698414d9529575ab', note: 'Anchor token under policy 145572c0…19fb. The vault reads it on every release.' },
];

const ATTACKS = ['Above hard cap', 'Wrong asset', 'Approver bypass', 'Withdraw by anyone', 'Update by anyone', 'Revoke by approver', 'Second mandate mint', 'Second vault mint'];

export default function Home() {
  return (
    <main className="mx-auto max-w-6xl px-5 py-8">
      <SiteHeader />

      <section aria-label="Thesis" className="mt-14">
        <h1 className="font-serif text-[3.1rem] leading-[0.98] tracking-[-0.02em] sm:text-7xl lg:text-[5.6rem]">
          Agents are infinite. <em className="text-muted">Human attention is not.</em>
        </h1>
        <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,38rem)_1fr] lg:items-end">
          <p className="text-xl leading-snug sm:text-2xl">
            Interrupting a person costs a bond; only that person&apos;s signature moves funds. Authority Layer sits between an AI agent
            and the treasury: the agent proposes, a deterministic engine checks the mandate, the invoice is verified, and the vault
            releases exactly what a human signed. Nothing else.
          </p>
          <div className="flex flex-wrap gap-3 lg:justify-end">
            <Link href="/live?mode=replay" className="btn-strong text-lg">
              Watch it act
            </Link>
            <Link href="/protocol" className="btn text-lg">
              Read the protocol
            </Link>
            <a href={SOKOSUMI} className="btn text-lg" rel="noreferrer">
              Try it on Sokosumi
            </a>
            <a href="/llms.txt" className="btn-quiet self-center text-[15px]">
              For agents: /llms.txt
            </a>
          </div>
        </div>
        <div className="mt-10">
          <HeroFloor />
        </div>
        <p className="mt-3 font-mono text-[12px] text-muted">
          Above: an agent escalates three frivolous invoices in a row. Each costs it a 5 ADA bond, captured on decline; the fourth is denied at
          the gate because the day&apos;s interrupt budget is spent, and nobody is paged.
        </p>
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

      <SiteFooter />
    </main>
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
