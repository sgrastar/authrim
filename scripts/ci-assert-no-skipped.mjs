#!/usr/bin/env node

/**
 * Fail when a Vitest JSON report contains a skipped or todo test.
 *
 * The PostgreSQL-backed AWS runtime tests skip themselves when their database variables are not
 * set, and a skipped test reports success. The CI job that exists to run them therefore checks
 * the report: a test that silently stops running (a renamed variable, a changed TLS requirement)
 * must fail the job instead of passing it.
 *
 *   node scripts/ci-assert-no-skipped.mjs <vitest-json-report> [allowed-title-substring ...]
 *
 * A test whose full name contains one of the allowed substrings may be skipped (for example a
 * variant that only applies to another storage backend).
 */

import { readFileSync } from 'node:fs';

const [reportPath, ...allowed] = process.argv.slice(2);
if (!reportPath) {
  console.error('usage: ci-assert-no-skipped.mjs <vitest-json-report> [allowed-substring ...]');
  process.exit(2);
}

const report = JSON.parse(readFileSync(reportPath, 'utf8'));
const skipped = [];
let total = 0;
for (const file of report.testResults ?? []) {
  for (const test of file.assertionResults ?? []) {
    total += 1;
    if (['pending', 'skipped', 'todo'].includes(test.status)) {
      const name = `${file.name} > ${test.fullName ?? test.title}`;
      if (!allowed.some((fragment) => name.includes(fragment))) skipped.push(name);
    }
  }
}

if (total === 0) {
  console.error('The report contains no tests: the selection found nothing to run.');
  process.exit(1);
}
if (skipped.length > 0) {
  console.error(`${skipped.length} of ${total} tests were skipped:`);
  for (const name of skipped) console.error(`  - ${name}`);
  process.exit(1);
}
console.log(`All ${total} selected tests ran (none skipped).`);
