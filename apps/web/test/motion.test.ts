import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../', import.meta.url);
// The floor (components/floor) moves on reducer state changes and is covered by test/floor.test.ts; everything else is still.
const css = readFileSync(new URL('app/globals.css', root), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/@import[^\n]*floor\.css[^\n]*\n/, '');
const sources = ['app', 'components'].flatMap((dir) =>
  readdirSync(new URL(`${dir}/`, root), { recursive: true, encoding: 'utf8' })
    .filter((f) => /\.tsx?$/.test(f) && !/^floor(3d)?\//.test(f))
    .map((f) => ({ file: `${dir}/${f}`, text: readFileSync(new URL(`${dir}/${f}`, root), 'utf8') })),
);
/** Innermost CSS rules: selector and declarations (nested @media bodies match their inner rule). */
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: (m[1] ?? '').trim(), body: m[2] ?? '' }));

describe('one motion outside the floor', () => {
  it('animates only the rail marker', () => {
    const moving = rules.filter((r) => /\btransition\s*:/.test(r.body) && !/\btransition\s*:\s*none/.test(r.body));
    expect(moving.map((r) => r.selector)).toEqual(['.rail-marker']);
    expect(css).not.toMatch(/@keyframes|\banimation\s*:/);
  });

  it('turns the marker motion off for reduced motion', () => {
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*\.rail-marker\s*\{\s*transition:\s*none;?\s*\}/);
  });

  it('uses no animation or transition utilities in any page or component', () => {
    expect(sources.length).toBeGreaterThan(0);
    for (const { file, text } of sources) expect(text, file).not.toMatch(/\banimate-|\btransition\b|\btransition-|\bduration-|@keyframes/);
  });
});
