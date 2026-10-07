'use client';
import { motion, useReducedMotion } from 'framer-motion';
import { Marquee } from './ui/marquee';

type Outcome = { name: 'ALLOW' | 'ESCALATE' | 'DENY'; dot: string; text: string };

const OUTCOMES: Outcome[] = [
  {
    name: 'ALLOW',
    dot: 'bg-permit',
    text: "Inside the mandate and below the agent's autonomous limit. Verified, signed by the engine, settled by the vault. No human hears about it.",
  },
  {
    name: 'ESCALATE',
    dot: 'bg-cosign',
    text: "Allowed by the mandate but above the agent's own limit. Priced at 402, bonded, briefed, signed by a named human.",
  },
  {
    name: 'DENY',
    dot: 'bg-forbid',
    text: 'Outside the mandate, facts do not match, or the interrupt budget is spent. Nothing moves; the reason is logged.',
  },
];

/* Engine reason codes (packages/core ReasonCode). ALLOW carries no reason code, so its chips say what it means. */
const CHIPS: { outcome: Outcome['name']; label: string }[] = [
  { outcome: 'DENY', label: 'AMOUNT_ABOVE_HARD_CAP' },
  { outcome: 'ALLOW', label: 'inside the mandate' },
  { outcome: 'ESCALATE', label: 'ABOVE_AUTONOMOUS_LIMIT' },
  { outcome: 'DENY', label: 'INTERRUPT_BUDGET_EXHAUSTED' },
  { outcome: 'ALLOW', label: 'below the agent limit' },
  { outcome: 'DENY', label: 'MANDATE_REVOKED' },
  { outcome: 'DENY', label: 'RECIPIENT_MISMATCH' },
  { outcome: 'ALLOW', label: 'facts verified' },
  { outcome: 'DENY', label: 'MANDATE_EXPIRED' },
  { outcome: 'ESCALATE', label: 'ABOVE_AUTONOMOUS_LIMIT' },
  { outcome: 'DENY', label: 'PURPOSE_NOT_AUTHORIZED' },
  { outcome: 'ALLOW', label: 'settled by the vault' },
];

const DOT: Record<Outcome['name'], string> = { ALLOW: 'bg-permit', ESCALATE: 'bg-cosign', DENY: 'bg-forbid' };

function Chip({ outcome, label }: (typeof CHIPS)[number]) {
  return (
    <div className="w-52 shrink-0 rounded-lg border border-line bg-raised p-4 shadow-sm">
      <p className="flex items-center gap-2 font-mono text-[12px] font-bold tracking-wide">
        <span className={`inline-block size-2 rounded-full ${DOT[outcome]}`} />
        {outcome}
      </p>
      <p className="mt-2 break-words font-mono text-[11px] text-muted">{label}</p>
    </div>
  );
}

/** Tilted, endlessly scrolling wall of decisions behind the three outcomes. */
function Backdrop() {
  const lanes = [false, true, false, true];
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center overflow-hidden opacity-60 [perspective:300px]">
      <div
        className="flex flex-row items-center gap-4"
        style={{ transform: 'translateX(-100px) translateY(0px) translateZ(-100px) rotateX(20deg) rotateY(-10deg) rotateZ(20deg)' }}
      >
        {lanes.map((reverse, i) => (
          <Marquee key={i} vertical reverse={reverse} repeat={3} className="h-[60rem]">
            {CHIPS.map((c, j) => (
              <Chip key={j} {...c} />
            ))}
          </Marquee>
        ))}
      </div>
      <div className="absolute inset-x-0 top-0 h-1/3 bg-gradient-to-b from-mist" />
      <div className="absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-mist" />
      <div className="absolute inset-y-0 left-0 w-1/4 bg-gradient-to-r from-mist" />
      <div className="absolute inset-y-0 right-0 w-1/4 bg-gradient-to-l from-mist" />
    </div>
  );
}

export function Outcomes() {
  const reduce = useReducedMotion();
  return (
    <section aria-label="Outcomes" className="relative mt-28 overflow-hidden py-12">
      <Backdrop />
      <div className="relative">
        <p className="font-mono text-[13px] font-semibold uppercase tracking-[0.12em] text-muted">Three outcomes</p>
        <h2 className="mt-2 font-serif text-4xl leading-[1.05] tracking-tight">Every proposal ends in one word</h2>
        <ul className="mt-10 flex flex-col gap-6">
          {OUTCOMES.map((o, i) => {
            const fromRight = i % 2 === 1;
            return (
              <motion.li
                key={o.name}
                initial={reduce ? false : { opacity: 0, x: fromRight ? 80 : -80 }}
                whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true, amount: 0.5 }}
                transition={{ duration: 0.8, ease: 'easeOut' }}
                className={`w-full rounded-xl border border-line bg-mist/90 p-6 shadow-sm backdrop-blur-sm md:w-[min(36rem,62%)] ${fromRight ? 'md:ml-auto' : ''}`}
              >
                <h3 className="flex items-center gap-3 font-serif text-5xl leading-none tracking-tight">
                  <span aria-hidden className={`inline-block size-3 rounded-full ${o.dot}`} />
                  {o.name}
                </h3>
                <p className="mt-4 text-[17px] leading-relaxed">{o.text}</p>
              </motion.li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
