import type { ComponentPropsWithoutRef, ReactNode } from 'react';

type MarqueeProps = Omit<ComponentPropsWithoutRef<'div'>, 'children'> & {
  children: ReactNode;
  reverse?: boolean;
  vertical?: boolean;
  /** Copies of the content; the loop is seamless once they overflow the box. */
  repeat?: number;
};

/** Decorative scrolling strip. Not focusable and not announced, so it only suits backgrounds. */
export function Marquee({ className = '', reverse = false, vertical = false, repeat = 4, children, ...props }: MarqueeProps) {
  const lane = [
    'flex shrink-0 justify-around [gap:var(--gap)] motion-reduce:[animation-play-state:paused]',
    vertical ? 'flex-col animate-marquee-vertical' : 'flex-row animate-marquee',
    reverse ? '[animation-direction:reverse]' : '',
  ].join(' ');
  return (
    <div
      {...props}
      data-slot="marquee"
      className={`flex overflow-hidden p-2 [--duration:40s] [--gap:1rem] [gap:var(--gap)] ${vertical ? 'flex-col' : 'flex-row'} ${className}`}
    >
      {Array.from({ length: repeat }, (_, i) => (
        <div key={i} className={lane}>
          {children}
        </div>
      ))}
    </div>
  );
}
