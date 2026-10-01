// Run the model assertions under node: `node run-tests.mjs`
import { runModelTests } from './js/model.test.js';

const { passed, failed, results } = runModelTests();
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n      ${r.error}`}`);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
