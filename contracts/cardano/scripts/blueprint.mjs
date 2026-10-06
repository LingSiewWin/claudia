// Checks the committed plutus.json: compiler version, validator hashes and
// sizes, and that it is the verbose-trace build (trace labels present).
// Rebuild with: aiken build --trace-filter user-defined --trace-level verbose
// Update BASELINE below whenever a validator changes.
import { readFileSync } from 'node:fs';

const BASELINE = {
  compiler: 'v1.1.24+bacbeb3',
  'mandate_anchor.mandate_anchor': {
    bytes: 2305,
    hash: '098ba05e80adc48ea5d6734b63eea0e1dea10e1027f73150716ab295',
    params: 'seed',
    label: 'm1 ? False',
  },
  'vault.vault': {
    bytes: 5487,
    hash: '0d0424d785d6cafe8805b9f70403a7441fe363fa62d166c01842b183',
    params: 'anchor_ref,chain_tag,seed',
    label: 'r16 ? False',
  },
};

const bp = JSON.parse(readFileSync(new URL('../plutus.json', import.meta.url), 'utf8'));
const errs = [];
if (bp.preamble.compiler.version !== BASELINE.compiler) errs.push(`compiler ${bp.preamble.compiler.version}`);
for (const [name, want] of Object.entries(BASELINE)) {
  if (name === 'compiler') continue;
  for (const purpose of ['mint', 'spend', 'else']) {
    const v = bp.validators.find((x) => x.title === `${name}.${purpose}`);
    if (!v) { errs.push(`${name}.${purpose} missing`); continue; }
    const got = { bytes: v.compiledCode.length / 2, hash: v.hash, params: (v.parameters ?? []).map((p) => p.title).join(',') };
    for (const k of Object.keys(got)) if (got[k] !== want[k]) errs.push(`${v.title} ${k}: ${got[k]} != ${want[k]}`);
    if (!v.compiledCode.includes(Buffer.from(want.label).toString('hex'))) errs.push(`${v.title} lacks trace "${want.label}" (not a verbose build)`);
  }
}
if (errs.length) { console.error(errs.join('\n')); process.exit(1); }
console.log('blueprint ok');
