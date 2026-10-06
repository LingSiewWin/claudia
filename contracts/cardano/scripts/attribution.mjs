// Reads `aiken check` JSON on stdin. A rejecting test named after an invariant
// (r12_..., m4_..., update_...) must be rejected by that invariant's check,
// so no adversarial test passes for an unrelated reason. A test is rejecting
// when it is a `fail` test, or is named after an invariant and negates a call
// (`!mint(..)`); a rejecting test with no trace fails the check.
import { existsSync, readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const prefixFor = { deposit: 'deposit_', update: 'update_', revoke: 'revoke_' };
const invariantId = /^(?:[mrvw]\d+|deposit|update|revoke)$/;

// Tests of a module whose body negates something (comments stripped).
function negating(module) {
  const file = ['lib', 'validators']
    .map((dir) => new URL(`${dir}/${module}.ak`, root))
    .find((url) => existsSync(url));
  const src = readFileSync(file, 'utf8').replace(/\/\/.*$/gm, '');
  const names = new Set();
  for (const chunk of src.split(/^test /m).slice(1)) {
    if (/!(?!=)/.test(chunk.slice(0, chunk.search(/^}/m)))) names.add(chunk.match(/^\w+/)[0]);
  }
  return names;
}

const report = JSON.parse(readFileSync(0, 'utf8'));
const problems = [];
for (const { name, tests } of report.modules) {
  const negated = negating(name);
  for (const t of tests) {
    if (t.status !== 'pass') problems.push(`${t.title}: ${t.status}`);
    const id = t.title.split('_')[0];
    const failTest = t.on_failure === 'succeed_eventually';
    const trace = t.traces?.at(-1);
    if (!trace) {
      if (failTest || (invariantId.test(id) && negated.has(t.title))) {
        problems.push(`${t.title}: rejected without a trace`);
      }
      continue;
    }
    console.log(`${t.title.padEnd(52)} ${trace.split('\n')[0]}`);
    if (failTest && id !== 'r2') continue; // other `fail` tests: structural rejection
    const want = prefixFor[id] ?? `${id} ?`;
    if (!trace.startsWith(want)) problems.push(`${t.title}: rejected by "${trace}", expected ${want}`);
  }
}
console.log(`${report.summary.passed}/${report.summary.total} passed`);
if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
