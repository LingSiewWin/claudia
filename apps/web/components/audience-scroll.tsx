'use client';
import { motion, useMotionValueEvent, useReducedMotion, useScroll, useTransform, type MotionValue } from 'framer-motion';
import Image from 'next/image';
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';

export type AudienceItem = { title: string; text: string; art: string; artSize: [number, number] };

/** Fraction of one panel's scroll share spent rolling in and out. */
const ROLL = 0.07;

/**
 * Three audiences, one at a time. On wide screens the section pins and scroll drives a text roll: the title and copy
 * slide up out of a mask while the next audience rolls in from below. On phones, tablets and reduced-motion the same
 * content is a plain list, so nothing is hidden behind scrolling.
 */
export function AudienceScroll({ items, header, aside }: { items: AudienceItem[]; header: ReactNode; aside: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  const reduce = useReducedMotion();
  const [wide, setWide] = useState(false);
  const [active, setActive] = useState(0);
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start start', 'end end'] });

  useEffect(() => {
    const m = window.matchMedia('(min-width: 1024px)');
    const sync = () => setWide(m.matches);
    sync();
    m.addEventListener('change', sync);
    return () => m.removeEventListener('change', sync);
  }, []);

  useMotionValueEvent(scrollYProgress, 'change', (v) => setActive(Math.min(items.length - 1, Math.floor(v * items.length))));

  const pinned = wide && !reduce;

  return (
    <section ref={ref} aria-label="Who it is for" className="mt-28" style={pinned ? { height: `${items.length * 100}vh` } : undefined}>
      <div className={pinned ? 'sticky top-0 flex h-screen items-center' : ''}>
        <div className="grid w-full gap-10 lg:grid-cols-[1fr_minmax(0,22rem)]">
          <div>
            <Fragment key="header">{header}</Fragment>
            {pinned ? (
              <>
                <div className="relative mt-8 h-[22rem] border-y border-line">
                  {items.map((item, i) => (
                    <Panel key={item.title} item={item} index={i} count={items.length} progress={scrollYProgress} />
                  ))}
                </div>
                <ol aria-hidden className="mt-4 flex gap-6 font-mono text-[13px] uppercase tracking-[0.12em]">
                  {items.map((item, i) => (
                    <li key={item.title} className={i === active ? 'font-semibold text-fg' : 'text-muted'}>
                      {String(i + 1).padStart(2, '0')}
                    </li>
                  ))}
                </ol>
              </>
            ) : (
              <ul className="mt-8 divide-y divide-line border-y border-line">
                {items.map((item) => (
                  <li key={item.title} className="grid grid-cols-[6.5rem_1fr] items-center gap-4 py-5 sm:grid-cols-[14rem_1fr] sm:gap-8">
                    <Art item={item} />
                    <div>
                      <h3 className="text-lg font-bold">{item.title}</h3>
                      <p className="mt-1 text-[15px] leading-relaxed">{item.text}</p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <Fragment key="aside">{aside}</Fragment>
        </div>
      </div>
    </section>
  );
}

function Art({ item }: { item: AudienceItem }) {
  return (
    <Image
      src={item.art}
      alt=""
      width={item.artSize[0]}
      height={item.artSize[1]}
      className="h-28 w-full object-contain object-left sm:h-56"
    />
  );
}

/** A value that is `hold` while this panel is on stage, `away` before it rolls in and after it rolls out. */
function useStage<T extends number | string>(progress: MotionValue<number>, index: number, count: number, away: [T, T], hold: T) {
  const start = index / count;
  const end = (index + 1) / count;
  const ins: number[] = [];
  const outs: T[] = [];
  if (index > 0) {
    ins.push(start - ROLL, start);
    outs.push(away[0], hold);
  } else {
    ins.push(0);
    outs.push(hold);
  }
  if (index < count - 1) {
    ins.push(end - ROLL, end);
    outs.push(hold, away[1]);
  } else {
    ins.push(1);
    outs.push(hold);
  }
  return useTransform(progress, ins, outs);
}

function Panel({ item, index, count, progress }: { item: AudienceItem; index: number; count: number; progress: MotionValue<number> }) {
  const opacity = useStage(progress, index, count, [0, 0], 1);
  const titleY = useStage(progress, index, count, ['110%', '-110%'], '0%');
  const textY = useStage(progress, index, count, [28, -28], 0);
  return (
    <motion.div style={{ opacity }} className="absolute inset-0 grid grid-cols-[14rem_1fr] items-center gap-8">
      <Art item={item} />
      <div>
        <div className="overflow-hidden pb-1">
          <motion.h3 style={{ y: titleY }} className="font-serif text-5xl leading-[1.05] tracking-tight">
            {item.title}
          </motion.h3>
        </div>
        <motion.p style={{ y: textY }} className="mt-3 max-w-xl text-lg leading-relaxed">
          {item.text}
        </motion.p>
      </div>
    </motion.div>
  );
}
