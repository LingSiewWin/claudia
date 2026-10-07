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
  anchorPolicy: '01eb5cae63817c211d2f36f9f60487eea2907ca6a3844d610874cba6',
  vaultPolicy: 'c1cdae438126d8e791c5fa2a2709950381b48d7522f6e0813bd4d42d',
  vaultAddress: 'addr_test1wrqumtjrsynd3eu3chaz5fcfj5pcrdydw530dcyp802dgtgaep57y',
  // The sink has no parameters, so its hash is fixed; the escrow takes (sink hash, chain tag 0).
  sinkHash: '22c9a103ed3f2fa97c982d76d6e2af50c5d54ac306983b196c8fcdab',
  sinkAddress: 'addr_test1wq3vnggra5ljl2tunqkhd4hz4agvt422cvrfswcedj8um2cwsu3l3',
  escrowHash: '03fb014855114c2e0def436d15bb36c2ffadefa59da6afabad8a4137',
  escrowAddress: 'addr_test1wqplkq2g25g5ctsdaapk69dmxmp0lt005kw6dtat4k9yzdclx093f',
};

const BASELINE = {
  compiler: 'v1.1.24+bacbeb3',
  'mandate_anchor.mandate_anchor': {
    purposes: ['mint', 'spend', 'else'],
    bytes: 2393,
    hash: '4f69d00e2a5263d433a0be024de96e2591908a603b5e724bcbe6a185',
    params: 'seed',
    label: 'm1 ? False',
  },
  'vault.vault': {
    purposes: ['mint', 'spend', 'else'],
    bytes: 6025,
    hash: 'c06131cb3b055f7dfe747c5be8eb815b490a06cfda192ae2691f7cc8',
    params: 'anchor_ref,chain_tag,seed',
    label: 'r16 ? False',
  },
  'escalation_bond.escalation_bond': {
    purposes: ['spend', 'else'],
    bytes: 1533,
    hash: '880f313150f41accb11bb6e3f8d44a6dea32bd160627a42e0ab17bb9',
    params: 'sink_hash,chain_tag',
    label: 'b5 ? False',
  },
  'always_fail.always_fail': {
    purposes: ['else'],
    bytes: 17,
    hash: '22c9a103ed3f2fa97c982d76d6e2af50c5d54ac306983b196c8fcdab',
    params: '',
    label: '',
  },
};

const bp = JSON.parse(readFileSync(new URL('../plutus.json', import.meta.url), 'utf8'));
const errs = [];
if (bp.preamble.compiler.version !== BASELINE.compiler) errs.push(`compiler ${bp.preamble.compiler.version}`);
for (const [name, want] of Object.entries(BASELINE)) {
  if (name === 'compiler') continue;
  for (const purpose of want.purposes) {
    const v = bp.validators.find((x) => x.title === `${name}.${purpose}`);
    if (!v) { errs.push(`${name}.${purpose} missing`); continue; }
    // Plutus V3 script hash: blake2b-224 over 0x03 || compiledCode bytes.
    const calc = Buffer.from(blake2b(Buffer.concat([Buffer.from([3]), Buffer.from(v.compiledCode, 'hex')]), { dkLen: 28 })).toString('hex');
    if (calc !== v.hash) errs.push(`${v.title} hash field ${v.hash} != recomputed ${calc}`);
    const got = { bytes: v.compiledCode.length / 2, hash: v.hash, params: (v.parameters ?? []).map((p) => p.title).join(',') };
    for (const k of Object.keys(got)) if (got[k] !== want[k]) errs.push(`${v.title} ${k}: ${got[k]} != ${want[k]}`);
    if (want.label && !v.compiledCode.includes(Buffer.from(want.label).toString('hex'))) errs.push(`${v.title} lacks trace "${want.label}" (not a verbose build)`);
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
  const sink = aiken('blueprint', 'policy', '-i', f(4), '-m', 'always_fail', '-v', 'always_fail');
  if (sink !== APPLY.sinkHash) errs.push(`sink hash ${sink}`);
  if (aiken('address', '-i', f(4), '-m', 'always_fail', '-v', 'always_fail') !== APPLY.sinkAddress) errs.push('sink address');
  aiken('blueprint', 'apply', '-i', f(4), '-o', f(5), '-m', 'escalation_bond', '-v', 'escalation_bond', `581c${sink}`);
  aiken('blueprint', 'apply', '-i', f(5), '-o', f(6), '-m', 'escalation_bond', '-v', 'escalation_bond', APPLY.chainTag);
  if (aiken('blueprint', 'policy', '-i', f(6), '-m', 'escalation_bond', '-v', 'escalation_bond') !== APPLY.escrowHash) errs.push('escrow hash');
  if (aiken('address', '-i', f(6), '-m', 'escalation_bond', '-v', 'escalation_bond') !== APPLY.escrowAddress) errs.push('escrow address');
  const done = JSON.parse(readFileSync(f(6), 'utf8'));
  const applied = { vault: APPLY.vaultPolicy, mandate_anchor: APPLY.anchorPolicy, escalation_bond: APPLY.escrowHash, always_fail: APPLY.sinkHash };
  for (const v of done.validators) {
    if ((v.parameters ?? []).length) errs.push(`${v.title} has parameters left`);
    const want = applied[v.title.split('.')[0]];
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
