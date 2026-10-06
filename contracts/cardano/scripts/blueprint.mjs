// Checks the committed plutus.json: compiler version, validator hashes and
// sizes, and that it is the verbose-trace build (trace labels present).
// Rebuild with: aiken build --trace-filter user-defined --trace-level verbose
// Update BASELINE below whenever a validator changes.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { blake2b } from '../../../packages/core/node_modules/@noble/hashes/blake2.js';

// Fixed reference for off-chain parameter application: dummy seed, anchor policy,
// chain tag and vault seed applied in this order to a temp copy of the blueprint.
const APPLY = {
  anchorSeed: 'd8799f5820' + 'a5'.repeat(32) + '00ff',
  chainTag: '00',
  vaultSeed: 'd8799f5820' + 'b5'.repeat(32) + '01ff',
  anchorPolicy: 'c17f6b5eb72bc5c4484ad9a0f1bf8629046291e32630b1a10798af61',
  vaultPolicy: '645957bce8339c7ed6d833b95f67b63e0b299c75ac2f5448ca911334',
  vaultAddress: 'addr_test1wpj9j4auaqeeclkkmqemjhm8kclqk2vuwkkz74zge2g3xdqmfyjtj',
};

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
    // Plutus V3 script hash: blake2b-224 over 0x03 || compiledCode bytes.
    const calc = Buffer.from(blake2b(Buffer.concat([Buffer.from([3]), Buffer.from(v.compiledCode, 'hex')]), { dkLen: 28 })).toString('hex');
    if (calc !== v.hash) errs.push(`${v.title} hash field ${v.hash} != recomputed ${calc}`);
    const got = { bytes: v.compiledCode.length / 2, hash: v.hash, params: (v.parameters ?? []).map((p) => p.title).join(',') };
    for (const k of Object.keys(got)) if (got[k] !== want[k]) errs.push(`${v.title} ${k}: ${got[k]} != ${want[k]}`);
    if (!v.compiledCode.includes(Buffer.from(want.label).toString('hex'))) errs.push(`${v.title} lacks trace "${want.label}" (not a verbose build)`);
  }
}

if (errs.length) { console.error(errs.join('\n')); process.exit(1); }
const aiken = (...a) => execFileSync('aiken', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const T = mkdtempSync(join(tmpdir(), 'blueprint-apply-'));
try {
  const f = (n) => join(T, `${n}.json`);
  const bpPath = new URL('../plutus.json', import.meta.url).pathname;
  aiken('blueprint', 'apply', '-i', bpPath, '-o', f(1), '-m', 'mandate_anchor', '-v', 'mandate_anchor', APPLY.anchorSeed);
  const anchor = aiken('blueprint', 'policy', '-i', f(1), '-m', 'mandate_anchor', '-v', 'mandate_anchor');
  aiken('blueprint', 'apply', '-i', f(1), '-o', f(2), '-m', 'vault', '-v', 'vault', `581c${anchor}`);
  aiken('blueprint', 'apply', '-i', f(2), '-o', f(3), '-m', 'vault', '-v', 'vault', APPLY.chainTag);
  aiken('blueprint', 'apply', '-i', f(3), '-o', f(4), '-m', 'vault', '-v', 'vault', APPLY.vaultSeed);
  const done = JSON.parse(readFileSync(f(4), 'utf8'));
  for (const v of done.validators) {
    if ((v.parameters ?? []).length) errs.push(`${v.title} has parameters left`);
    const want = v.title.startsWith('vault.') ? APPLY.vaultPolicy : APPLY.anchorPolicy;
    if (v.hash !== want) errs.push(`applied ${v.title} ${v.hash} != ${want}`);
  }
  if (anchor !== APPLY.anchorPolicy) errs.push(`anchor policy ${anchor}`);
  const vp = aiken('blueprint', 'policy', '-i', f(4), '-m', 'vault', '-v', 'vault');
  if (vp !== APPLY.vaultPolicy) errs.push(`vault policy ${vp}`);
  const addr = aiken('address', '-i', f(4), '-m', 'vault', '-v', 'vault');
  if (addr !== APPLY.vaultAddress) errs.push(`vault address ${addr}`);
} finally {
  rmSync(T, { recursive: true, force: true });
}
if (errs.length) { console.error(errs.join('\n')); process.exit(1); }
console.log('blueprint ok');
