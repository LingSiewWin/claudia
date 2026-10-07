import Link from 'next/link';
import type { ReactNode } from 'react';
import { BudgetPeek } from '../components/budget-peek';
import { HeroReplay } from '../components/hero-replay';
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

      <section aria-label="Thesis" className="mt-12 grid items-start gap-12 lg:grid-cols-[1fr_minmax(0,34rem)]">
        <div>
          <h1 className="text-[2.6rem] font-extrabold leading-[1.02] tracking-tight sm:text-6xl">
            Agents are infinite. <span className="text-muted">Human attention is not.</span>
          </h1>
          <p className="mt-6 max-w-xl text-xl leading-snug">
            Interrupting a person costs a bond; only that person&apos;s signature moves funds.
          </p>
          <p className="mt-4 max-w-xl text-[17px] text-muted">
            Authority Layer sits between an AI agent and the treasury. The agent proposes, a deterministic engine checks the mandate,
            the invoice is verified, and the vault releases exactly what a human signed. Nothing else.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
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
        <HeroReplay />
      </section>

      <section aria-label="How it works" className="mt-24">
        <Eyebrow>How it works</Eyebrow>
        <h2 className="mt-1 text-2xl font-extrabold tracking-tight">Six steps between a proposal and a payment</h2>
        <ol className="mt-6 grid gap-x-10 gap-y-6 border-t border-line pt-6 sm:grid-cols-2 lg:grid-cols-3">
          <Step n={1} title="Propose" label="agent">
            The agent writes an Action IR: what, how much, to whom, why, under which mandate. It signs it with its delegate key.
            The rationale is shown to the human, never trusted.
          </Step>
          <Step n={2} title="Evaluate" label="authority engine">
            Purpose, vendor, per-payment limit, daily cap, treasury floor, interrupt budget. Same inputs, same answer, no model in
            the loop. One of ALLOW, ESCALATE, DENY.
          </Step>
          <Step n={3} title="Verify" label="Chainlink CRE">
            Independent nodes read the invoice at the billing source and record on Sepolia that it exists, is open, matches the
            amount, and pays the vendor&apos;s own address.
          </Step>
          <Step n={4} title="402 and bond" label="x402 on Cardano">
            An escalation answers HTTP 402 with a price. The agent locks a 5 ADA bond in escrow and retries. Until the bond is on
            chain, no human hears about it.
          </Step>
          <Step n={5} title="Brief and signature" label="the human">
            The approver reads a Decision Brief built from the evaluation, not from a chat transcript, and signs with a wallet on
            their own device. Approve or a reasonable decline refunds the bond; a frivolous ask is captured.
          </Step>
          <Step n={6} title="Vault and receipt" label="Cardano vault">
            The validator checks amount, recipient, nonce, expiry, mandate version and the approver&apos;s signature. Every decision
            lands in a hash-chained log with a receipt anyone can recompute.
          </Step>
        </ol>
      </section>

      <section aria-label="Outcomes" className="mt-24 grid gap-10 lg:grid-cols-[1fr_minmax(0,22rem)]">
        <div>
          <Eyebrow>Three outcomes</Eyebrow>
          <h2 className="mt-1 text-2xl font-extrabold tracking-tight">Every proposal gets exactly one</h2>
          <dl className="mt-6 grid gap-4 sm:grid-cols-3">
            <Outcome name="ALLOW" color="bg-permit">
              Inside the autonomous zone. The engine signs, the vault releases the exact amount to the exact recipient, once.
            </Outcome>
            <Outcome name="ESCALATE" color="bg-cosign">
              Allowed by the mandate but above the agent&apos;s own limit. Priced at 402, bonded, briefed, signed by a named human.
            </Outcome>
            <Outcome name="DENY" color="bg-forbid">
              Outside the mandate, facts do not match, or the interrupt budget is spent. Nothing moves; the reason is logged.
            </Outcome>
          </dl>
        </div>
        <div>
          <Eyebrow>Interrupt budget</Eyebrow>
          <h2 className="mt-1 text-2xl font-extrabold tracking-tight">Attention is budgeted like money</h2>
          <p className="mt-3 text-[15px] text-muted">
            Each mandate sets how many times per day its approver may be paged. Past that, escalations are denied and nobody is
            notified. Poor requests cost the agent bonds and budget, so it learns to plan.
          </p>
          <div className="mt-4">
            <BudgetPeek />
          </div>
        </div>
      </section>

      <section aria-label="Live on Cardano preprod" className="mt-24">
        <Eyebrow>Live on Cardano preprod</Eyebrow>
        <h2 className="mt-1 text-2xl font-extrabold tracking-tight">Real transactions, not a mockup</h2>
        <ul className="mt-6 divide-y divide-line border-y border-line">
          {ONCHAIN.map((row) => (
            <li key={row.hash} className="grid gap-1 py-3 sm:grid-cols-[11rem_1fr] sm:gap-6">
              <p className="font-bold">{row.what}</p>
              <div>
                <a href={cardanoscanTxUrl(row.hash)} className="font-mono text-[13px] underline underline-offset-4" rel="noreferrer">
                  {row.hash.slice(0, 16)}…{row.hash.slice(-8)}
                </a>
                <p className="text-[15px] text-muted">{row.note}</p>
              </div>
            </li>
          ))}
          <li className="grid gap-1 py-3 sm:grid-cols-[11rem_1fr] sm:gap-6">
            <p className="font-bold">Attack lab</p>
            <div>
              <p className="text-[15px]">
                Eight forged releases against the live M-LAB vault, each rejected by the Cardano node with no funds moved:
              </p>
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

      <section aria-label="Who it is for" className="mt-24 grid gap-10 lg:grid-cols-[1fr_minmax(0,22rem)]">
        <div>
          <Eyebrow>Who it is for</Eyebrow>
          <h2 className="mt-1 text-2xl font-extrabold tracking-tight">People who already sign for money</h2>
          <dl className="mt-6 divide-y divide-line border-y border-line">
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
        <div className="rounded-[14px] border border-line bg-raised p-5">
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
                Preprod Coworker <span className="font-semibold text-fg">Human Authority Endpoint</span>. 1 tUSDM per evaluation; on
                ESCALATE you get the exact bond price and endpoint.
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
    <li className="grid grid-cols-[2.25rem_1fr] gap-3">
      <span aria-hidden className="font-mono text-[13px] font-semibold leading-7 text-muted">
        {String(n).padStart(2, '0')}
      </span>
      <div>
        <p className="text-lg font-bold leading-7">
          {title} <span className="text-sm font-semibold text-muted">· {label}</span>
        </p>
        <p className="mt-1 text-[15px] leading-relaxed">{children}</p>
      </div>
    </li>
  );
}

function Outcome({ name, color, children }: { name: string; color: string; children: ReactNode }) {
  return (
    <div className="rounded-[10px] border border-line bg-raised p-4">
      <dt className="flex items-center gap-2 font-mono text-[13px] font-bold tracking-wide">
        <span aria-hidden className={`inline-block size-2.5 rounded-full ${color}`} />
        {name}
      </dt>
      <dd className="mt-2 text-[15px] leading-relaxed">{children}</dd>
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
