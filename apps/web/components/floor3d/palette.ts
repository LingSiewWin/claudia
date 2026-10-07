/** Scene colours. Each one is a CSS custom property on `.floor` (floor.css) so a theme change reaches the canvas; the hex is the fallback. */
export const TOKENS = {
  paper: ['--floor-paper', '#fbf6f1'],
  grid: ['--floor-grid', '#e3dcd3'],
  ink: ['--ink', '#185079'],
  tint1: ['--floor-tint-1', '#bbd6e1'],
  tint2: ['--floor-tint-2', '#95bfd1'],
  tint3: ['--floor-tint-3', '#6ba1bc'],
  tint4: ['--floor-tint-4', '#3885ab'],
  warm1: ['--floor-warm-1', '#e9e2d8'],
  warm2: ['--floor-warm-2', '#cfc4b6'],
  vault: ['--floor-vault', '#0f2f49'],
  glow: ['--floor-vault-glow', '#3885ab'],
  proposed: ['--crate-proposed', '#95bfd1'],
  escalated: ['--crate-escalated', '#6ba1bc'],
  bond: ['--crate-bond', '#3885ab'],
  settled: ['--crate-settled', '#2f8f5b'],
  denied: ['--crate-denied', '#b23a3a'],
  captured: ['--crate-captured', '#8a8378'],
  permit: ['--permit', '#2f8f5b'],
  cosign: ['--cosign', '#b7791f'],
  forbid: ['--forbid', '#b23a3a'],
} as const;

export type Palette = Record<keyof typeof TOKENS, string>;

export function fallbackPalette(): Palette {
  return Object.fromEntries(Object.entries(TOKENS).map(([k, [, hex]]) => [k, hex])) as Palette;
}

/** Read every token from the element's computed style; an empty or non-hex value keeps the fallback (three.js parses hex and rgb()). */
export function readPalette(el: Element): Palette {
  const style = getComputedStyle(el);
  const out = fallbackPalette();
  for (const [key, [prop]] of Object.entries(TOKENS) as Array<[keyof Palette, readonly [string, string]]>) {
    const v = style.getPropertyValue(prop).trim();
    if (/^#[0-9a-f]{3,8}$/i.test(v) || /^rgb/.test(v)) out[key] = v;
  }
  return out;
}
