// Run the assertions under node: `node run-tests.mjs`.
// The model suite runs anywhere; the server suite needs node:sqlite (Node >= 22.5) and is skipped
// without it — `docker run --rm -v "$PWD":/app -w /app node:24-alpine node run-tests.mjs` runs both.

import { runModelTests } from './js/model.test.js';

const report = ({ passed, failed, results }, title) => {
  console.log(`\n--- ${title}`);
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n      ${r.error}`}`);
  return { passed, failed };
};

let total = { passed: 0, failed: 0 };
const add = (r) => { total = { passed: total.passed + r.passed, failed: total.failed + r.failed }; };

add(report(runModelTests(), 'model'));

let haveSqlite = true;
try { await import('node:sqlite'); } catch { haveSqlite = false; }
if (haveSqlite) {
  const { runServerTests } = await import('./server/server.test.mjs');
  add(report(await runServerTests(), 'server'));
} else {
  console.log('\n--- server\nSKIPPED  this Node has no node:sqlite (needs >= 22.5)');
}

console.log(`\n${total.passed} passed, ${total.failed} failed`);
process.exit(total.failed ? 1 : 0);
