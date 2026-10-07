import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../', import.meta.url);
// The floor (components/floor) moves on reducer state changes and is covered by test/floor.test.ts. The /live stage
// (components/live.css) lets a card recede when another takes the stage. The home page adds scroll-driven sections
// (SCROLL_MOTION below); everything else is still.
const css = readFileSync(new URL('app/globals.css', root), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/@import[^\n]*floor\.css[^\n]*\n/, '');
/** Home-page sections whose motion is the point: scroll-pinned and scroll-in sections, and the decision wall. */
const SCROLL_MOTION = ['components/ui/container-scroll-animation.tsx', 'components/audience-scroll.tsx', 'components/outcomes.tsx', 'components/ui/marquee.tsx'];
const sources = ['app', 'components'].flatMap((dir) =>
  readdirSync(new URL(`${dir}/`, root), { recursive: true, encoding: 'utf8' })
    .filter((f) => /\.tsx?$/.test(f) && !/^floor(3d)?\//.test(f))
    .map((f) => ({ file: `${dir}/${f}`, text: readFileSync(new URL(`${dir}/${f}`, root), 'utf8') })),
);
/** Innermost CSS rules: selector and declarations (nested @media bodies match their inner rule). */
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: (m[1] ?? '').trim(), body: m[2] ?? '' }));
const live = readFileSync(new URL('components/live.css', root), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const liveRules = [...live.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: (m[1] ?? '').trim(), body: m[2] ?? '' }));

describe('one motion outside the floor', () => {
  it('animates only the rail marker', () => {
    const moving = rules.filter((r) => /\btransition\s*:/.test(r.body) && !/\btransition\s*:\s*none/.test(r.body));
    expect(moving.map((r) => r.selector)).toEqual(['.rail-marker']);
    // The only keyframes are the decision wall's two lanes; nothing else in the stylesheet animates.
    expect([...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1])).toEqual(['marquee', 'marquee-vertical']);
    expect(css.replace(/@keyframes[^{]+\{[\s\S]*?\}\s*\}/g, '')).not.toMatch(/\banimation\s*:/);
  });

  it('turns the marker motion off for reduced motion', () => {
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*\.rail-marker\s*\{\s*transition:\s*none;?\s*\}/);
  });

  it('lets only the stage card recede, in opacity and transform, and holds still under reduced motion', () => {
    const moving = liveRules.filter((r) => /\btransition\s*:/.test(r.body) && !/\btransition\s*:\s*none/.test(r.body));
    expect(moving.map((r) => r.selector)).toEqual(['.stage-slot > .stage-card']);
    for (const r of moving) for (const prop of r.body.match(/transition\s*:([^;]*)/)?.[1]?.split(',') ?? []) expect(prop.trim()).toMatch(/^(opacity|transform|box-shadow)\b/);
    expect(live).not.toMatch(/@keyframes|\banimation\s*:/);
    expect(live).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*\.stage-slot > \.stage-card\s*\{\s*transition:\s*none;/);
  });

  it('uses no animation or transition utilities in any page or component', () => {
    expect(sources.length).toBeGreaterThan(0);
    for (const { file, text } of sources.filter((x) => !SCROLL_MOTION.includes(x.file))) expect(text, file).not.toMatch(/\banimate-|\btransition\b|\btransition-|\bduration-|@keyframes/);
  });
});
