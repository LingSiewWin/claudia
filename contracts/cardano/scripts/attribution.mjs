// Reads `aiken check` JSON on stdin. A rejecting test named after an invariant
// (r12_..., m4_..., update_...) must be rejected by that invariant's check,
// so no adversarial test passes for an unrelated reason.
import { readFileSync } from 'node:fs';

const report = JSON.parse(readFileSync(0, 'utf8'));
const prefixFor = { deposit: 'deposit_', update: 'u_', revoke: 'u_' };
const problems = [];
for (const { tests } of report.modules) {
  for (const t of tests) {
    if (t.status !== 'pass') problems.push(`${t.title}: ${t.status}`);
    const trace = t.traces?.[0];
    if (!trace) continue;
    console.log(`${t.title.padEnd(52)} ${t.traces.at(-1).split('\n')[0]}`);
    if (t.on_failure === 'succeed_eventually') continue; // `fail` tests: structural rejection
    const id = t.title.split('_')[0];
    const want = prefixFor[id] ?? `${id} ?`;
    if (!trace.startsWith(want)) problems.push(`${t.title}: rejected by "${trace}", expected ${want}`);
  }
}
console.log(`${report.summary.passed}/${report.summary.total} passed`);
if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
