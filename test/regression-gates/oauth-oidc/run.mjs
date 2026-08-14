import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '../../..');
const manifestPath = resolve(scriptDirectory, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const expectRed = process.argv.includes('--expect-red');
const listOnly = process.argv.includes('--list');
const reportPath = process.env.AUTHRIM_TEST_REPORT?.trim();

const ids = manifest.findings.map((finding) => finding.id);
if (
  !Number.isSafeInteger(manifest.confirmed_findings) ||
  manifest.confirmed_findings < 1 ||
  ids.length !== manifest.confirmed_findings ||
  new Set(ids).size !== manifest.confirmed_findings
) {
  throw new Error('OAuth/OIDC security manifest count must match its unique confirmed finding IDs');
}

if (listOnly) {
  for (const finding of manifest.findings) {
    process.stdout.write(
      `${finding.id}\t${finding.root_cause}\t${finding.primary_treatment}\t${finding.title}\n`
    );
  }
  process.exit(0);
}

const outcomes = [];

for (const finding of manifest.findings) {
  const pattern = `\\[security regression\\]\\[${finding.id}\\]`;
  const targets = finding.tests ?? [{ package_dir: finding.package_dir, file: finding.file }];
  if (
    targets.length === 0 ||
    targets.some(
      (target) =>
        typeof target.package_dir !== 'string' ||
        typeof target.file !== 'string' ||
        target.file.length === 0
    )
  ) {
    throw new Error(`${finding.id} must define at least one valid regression test target`);
  }

  const targetOutcomes = targets.map((target) => {
    const result = spawnSync(
      'pnpm',
      ['exec', 'vitest', 'run', target.file, '-t', pattern, '--reporter=dot'],
      {
        cwd: resolve(repositoryRoot, target.package_dir),
        encoding: 'utf8',
        env: {
          ...process.env,
          AUTHRIM_SECURITY_REGRESSION_SUITE: 'true',
          NO_COLOR: '1',
        },
      }
    );
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    return {
      secure: result.status === 0,
      reproduced:
        result.status === 1 &&
        output.includes(`[${finding.id}]`) &&
        output.includes('Failed Tests') &&
        output.includes('AssertionError'),
      output,
    };
  });
  const output = targetOutcomes.map((target) => target.output).join('\n');
  const secure = targetOutcomes.every((target) => target.secure);
  const reproduced = targetOutcomes.every((target) => target.reproduced);
  const state = secure ? 'SECURE' : reproduced ? 'REPRODUCED' : 'HARNESS_ERROR';

  outcomes.push({ ...finding, state, output });
  process.stdout.write(`${finding.id} ${state} — ${finding.title}\n`);

  if (state === 'HARNESS_ERROR' || (!expectRed && !secure)) {
    process.stdout.write(`${output.trim()}\n`);
  }
}

const secureCount = outcomes.filter((outcome) => outcome.state === 'SECURE').length;
const reproducedCount = outcomes.filter((outcome) => outcome.state === 'REPRODUCED').length;
const harnessErrorCount = outcomes.filter((outcome) => outcome.state === 'HARNESS_ERROR').length;
const reportSuccess = expectRed
  ? reproducedCount === manifest.confirmed_findings && harnessErrorCount === 0
  : secureCount === manifest.confirmed_findings && harnessErrorCount === 0;

if (reportPath) {
  const targets = manifest.findings.flatMap(
    (finding) => finding.tests ?? [{ package_dir: finding.package_dir, file: finding.file }]
  );
  const uniqueFiles = new Set(
    targets.map((target) => `${target.package_dir.replace(/\/$/u, '')}/${target.file}`)
  );
  const resolvedReportPath = resolve(repositoryRoot, reportPath);
  mkdirSync(dirname(resolvedReportPath), { recursive: true });
  writeFileSync(
    resolvedReportPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        suite: 'oauth-oidc-regressions',
        success: reportSuccess,
        files: uniqueFiles.size,
        cases: {
          total: manifest.confirmed_findings,
          passed: expectRed ? reproducedCount : secureCount,
          failed: expectRed ? secureCount + harnessErrorCount : reproducedCount + harnessErrorCount,
          skipped: 0,
        },
      },
      null,
      2
    )}\n`,
    'utf8'
  );
}

process.stdout.write(
  `\nOAuth/OIDC security suite: ${secureCount} secure, ${reproducedCount} reproduced, ${harnessErrorCount} harness errors.\n`
);

if (expectRed) {
  if (reproducedCount !== manifest.confirmed_findings || harnessErrorCount !== 0) {
    process.stderr.write(
      `Expected all ${manifest.confirmed_findings} pre-remediation findings to reproduce cleanly.\n`
    );
    process.exit(1);
  }
  process.stdout.write(
    `Pre-remediation baseline confirmed: all ${manifest.confirmed_findings} findings remain reproducible.\n`
  );
  process.exit(0);
}

if (secureCount !== manifest.confirmed_findings || harnessErrorCount !== 0) {
  process.stderr.write('Security regression gate failed.\n');
  process.exit(1);
}

process.stdout.write('Security regression gate passed.\n');
