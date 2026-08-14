#!/usr/bin/env node

import { promises as fs } from 'node:fs';
import path from 'node:path';

const MARKER = '<!-- authrim-ci-coverage-summary -->';
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.svelte']);
const EXCLUDED_PACKAGES = new Set(['@authrim/ar-admin-ui', '@authrim/ar-login-ui']);
const IGNORED_DIRS = new Set([
  '.svelte-kit',
  '.turbo',
  '.wrangler',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'playwright-report',
]);

function isIgnoredPath(filePath) {
  return filePath.split(path.sep).some((segment) => IGNORED_DIRS.has(segment));
}

function isSourceLikeFile(filePath) {
  const ext = path.extname(filePath);
  return SOURCE_EXTENSIONS.has(ext) && !filePath.endsWith('.d.ts');
}

function isTestFile(filePath) {
  return (
    filePath.includes(`${path.sep}__tests__${path.sep}`) ||
    /\.test\.[cm]?[jt]sx?$/.test(filePath) ||
    /\.spec\.[cm]?[jt]sx?$/.test(filePath)
  );
}

function countNonBlankLines(content) {
  return content.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
}

function countMatches(content, regex) {
  return Array.from(content.matchAll(regex)).length;
}

function formatPct(value) {
  return typeof value === 'number' ? `${value.toFixed(2)}%` : '-';
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function walk(dir) {
  if (!(await pathExists(dir))) return [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (isIgnoredPath(entryPath)) continue;

    if (entry.isDirectory()) {
      files.push(...(await walk(entryPath)));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }

  return files;
}

async function readCoverageSummary(packageDir) {
  const summaryPath = path.join(packageDir, 'coverage', 'coverage-summary.json');
  if (await pathExists(summaryPath)) {
    const summary = JSON.parse(await fs.readFile(summaryPath, 'utf8'));
    return summary.total ?? null;
  }

  const finalPath = path.join(packageDir, 'coverage', 'coverage-final.json');
  if (!(await pathExists(finalPath))) return null;

  const coverageFinal = JSON.parse(await fs.readFile(finalPath, 'utf8'));
  return summarizeCoverageFinal(coverageFinal);
}

function createMetric(total, covered) {
  return {
    total,
    covered,
    skipped: 0,
    pct: total > 0 ? (covered / total) * 100 : 100,
  };
}

function summarizeCoverageFinal(coverageFinal) {
  const aggregate = {
    lines: { total: 0, covered: 0 },
    statements: { total: 0, covered: 0 },
    functions: { total: 0, covered: 0 },
    branches: { total: 0, covered: 0 },
  };

  for (const fileCoverage of Object.values(coverageFinal)) {
    const coveredLines = new Set();
    const allLines = new Set();

    for (const [statementId, location] of Object.entries(fileCoverage.statementMap ?? {})) {
      const line = location.start?.line;
      if (typeof line !== 'number') continue;
      allLines.add(line);
      if ((fileCoverage.s?.[statementId] ?? 0) > 0) {
        coveredLines.add(line);
      }
    }

    aggregate.lines.total += allLines.size;
    aggregate.lines.covered += coveredLines.size;

    const statementCounts = Object.values(fileCoverage.s ?? {});
    aggregate.statements.total += statementCounts.length;
    aggregate.statements.covered += statementCounts.filter((count) => count > 0).length;

    const functionCounts = Object.values(fileCoverage.f ?? {});
    aggregate.functions.total += functionCounts.length;
    aggregate.functions.covered += functionCounts.filter((count) => count > 0).length;

    for (const branchCounts of Object.values(fileCoverage.b ?? {})) {
      aggregate.branches.total += branchCounts.length;
      aggregate.branches.covered += branchCounts.filter((count) => count > 0).length;
    }
  }

  return {
    lines: createMetric(aggregate.lines.total, aggregate.lines.covered),
    statements: createMetric(aggregate.statements.total, aggregate.statements.covered),
    functions: createMetric(aggregate.functions.total, aggregate.functions.covered),
    branches: createMetric(aggregate.branches.total, aggregate.branches.covered),
  };
}

async function collectPackageStats(repoRoot) {
  const packagesRoot = path.join(repoRoot, 'packages');
  const entries = await fs.readdir(packagesRoot, { withFileTypes: true });
  const packageDirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(packagesRoot, entry.name))
    .sort();

  const packages = [];
  const totals = {
    codeLines: 0,
    codeFiles: 0,
    testLines: 0,
    testFiles: 0,
    testCases: 0,
    describeBlocks: 0,
  };

  for (const packageDir of packageDirs) {
    const manifestPath = path.join(packageDir, 'package.json');
    if (!(await pathExists(manifestPath))) continue;

    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    const packageName = manifest.name ?? path.basename(packageDir);
    if (EXCLUDED_PACKAGES.has(packageName)) continue;

    const sourceRoot = path.join(packageDir, 'src');
    const allFiles = (await walk((await pathExists(sourceRoot)) ? sourceRoot : packageDir)).filter(
      isSourceLikeFile
    );
    const testFiles = allFiles.filter(isTestFile);
    const codeFiles = allFiles.filter((file) => !isTestFile(file));

    let codeLines = 0;
    for (const file of codeFiles) {
      codeLines += countNonBlankLines(await fs.readFile(file, 'utf8'));
    }

    let testLines = 0;
    let testCases = 0;
    let describeBlocks = 0;
    for (const file of testFiles) {
      const content = await fs.readFile(file, 'utf8');
      testLines += countNonBlankLines(content);
      testCases += countMatches(content, /\b(?:it|test)\s*(?:\.\w+)?\s*\(/g);
      describeBlocks += countMatches(content, /\bdescribe\s*(?:\.\w+)?\s*\(/g);
    }

    const coverage = await readCoverageSummary(packageDir);
    const status = coverage ? 'covered' : testCases > 0 ? 'coverage missing' : 'no tests';

    totals.codeLines += codeLines;
    totals.codeFiles += codeFiles.length;
    totals.testLines += testLines;
    totals.testFiles += testFiles.length;
    totals.testCases += testCases;
    totals.describeBlocks += describeBlocks;

    packages.push({
      name: packageName,
      status,
      testCases,
      coverage,
    });
  }

  return { packages, totals };
}

function normalizeReportPath(filePath) {
  return filePath.split(path.sep).join('/');
}

function summarizeVitestReport(report, pathFragment) {
  const results = Array.isArray(report.testResults)
    ? report.testResults.filter((result) => {
        if (!pathFragment) return true;
        return normalizeReportPath(String(result.name ?? '')).includes(pathFragment);
      })
    : [];
  const assertions = results.flatMap((result) =>
    Array.isArray(result.assertionResults) ? result.assertionResults : []
  );
  const passed = assertions.filter((assertion) => assertion.status === 'passed').length;
  const failed = assertions.filter((assertion) => assertion.status === 'failed').length;
  const skipped = assertions.filter((assertion) =>
    ['pending', 'skipped', 'todo', 'disabled'].includes(assertion.status)
  ).length;
  const fileFailures = results.filter((result) => result.status === 'failed').length;

  return {
    reported: true,
    success: results.length > 0 && failed === 0 && fileFailures === 0,
    files: results.length,
    total: assertions.length,
    passed,
    failed,
    skipped,
  };
}

function summarizeAuthrimReport(report) {
  const cases = report?.cases ?? {};
  const values = [report?.files, cases.total, cases.passed, cases.failed, cases.skipped];
  if (!values.every(Number.isSafeInteger)) {
    throw new Error('OAuth/OIDC regression report contains invalid counts');
  }
  return {
    reported: true,
    success: report.success === true,
    files: report.files,
    total: cases.total,
    passed: cases.passed,
    failed: cases.failed,
    skipped: cases.skipped,
  };
}

async function readJsonReport(envName) {
  const reportPath = process.env[envName]?.trim();
  if (!reportPath) return null;
  if (!(await pathExists(reportPath))) {
    throw new Error(`${envName} does not exist: ${reportPath}`);
  }
  return JSON.parse(await fs.readFile(reportPath, 'utf8'));
}

function unreportedSuite() {
  return {
    reported: false,
    success: false,
    files: null,
    total: null,
    passed: null,
    failed: null,
    skipped: null,
  };
}

async function collectRepositorySuiteStats() {
  const integrationReport = await readJsonReport('AUTHRIM_INTEGRATION_REPORT');
  const oauthReport = await readJsonReport('AUTHRIM_OAUTH_OIDC_REPORT');
  const matricesReport = await readJsonReport('AUTHRIM_SECURITY_MATRICES_REPORT');
  const integration = integrationReport
    ? summarizeVitestReport(integrationReport)
    : unreportedSuite();
  const oauth = oauthReport ? summarizeAuthrimReport(oauthReport) : unreportedSuite();

  const definitions = [
    {
      name: 'Canonical integration',
      purpose: 'Cross-package protocol, tenant, and runtime flows',
      evidence: '308-row constrained 3-wise tenant matrix + lifecycle flows',
      result: integration,
    },
    {
      name: 'OAuth/OIDC regressions',
      purpose: 'Confirmed security finding regressions',
      evidence: oauth.reported
        ? `${oauth.total} manifest-defined regression checks`
        : 'manifest-driven',
      result: oauth,
    },
    {
      name: 'Authorization matrix',
      purpose: 'SSO, session, consent, PAR, JAR, PKCE, redirects, JARM',
      evidence: '100% legal pairs + selected 3-wise (meta-tested)',
      pathFragment: '/test/security-matrices/authorize-matrix/',
    },
    {
      name: 'Token matrix',
      purpose: 'Client auth, code state, PKCE, DPoP, issuance failures',
      evidence: '100% legal pairs + selected 3-wise (meta-tested)',
      pathFragment: '/test/security-matrices/token-matrix/',
    },
    {
      name: 'Runtime-topology matrix',
      purpose: 'Host, tenant, registry, issuer, cache, service bindings',
      evidence: '5 matrices; 6 required 3-wise groups + legal pairs',
      pathFragment: '/test/security-matrices/runtime-topology-matrix/',
    },
    {
      name: 'State-transition matrix',
      purpose: 'Refresh, Device, CIBA, Queue transitions and side effects',
      evidence: '8 matrices; legal pairs + selected 3-wise',
      pathFragment: '/test/security-matrices/state-transition-matrix/',
    },
  ];

  return definitions.map((definition) => ({
    ...definition,
    result:
      definition.result ??
      (matricesReport
        ? summarizeVitestReport(matricesReport, definition.pathFragment)
        : unreportedSuite()),
  }));
}

function buildComment({ packages, totals, repositorySuites }) {
  const sha = process.env.GITHUB_SHA ? process.env.GITHUB_SHA.slice(0, 7) : 'local';
  const generatedAt = new Date().toISOString();

  const overviewRows = [
    ['Real code lines', totals.codeLines],
    ['Real code files', totals.codeFiles],
    ['Test code lines', totals.testLines],
    ['Test code files', totals.testFiles],
    ['Test case definitions', totals.testCases],
    ['Describe blocks', totals.describeBlocks],
    ['Real code + test total', totals.codeLines + totals.testLines],
  ];

  const packageRows = packages.map((pkg) => {
    const coverage = pkg.coverage;
    return [
      pkg.name,
      pkg.status,
      pkg.testCases,
      formatPct(coverage?.lines?.pct),
      formatPct(coverage?.branches?.pct),
      formatPct(coverage?.functions?.pct),
      formatPct(coverage?.statements?.pct),
    ];
  });
  const repositorySuiteRows = repositorySuites.map(({ name, result }) => [
    name,
    result.reported ? (result.success ? 'passed' : 'failed') : 'not reported',
    result.total ?? '-',
  ]);
  const repositorySuiteDetails = repositorySuites.map(({ name, purpose, evidence }) =>
    [`- **${name}** — ${purpose}`, `  - Combination coverage: ${evidence}`].join('\n')
  );

  return `${MARKER}
## Coverage Summary

Generated after **Lint, Type Check, and Test** completed for \`${sha}\`.
Admin UI and Login UI are intentionally excluded while UI coverage is being refined.

### Overview

| Metric | Value |
| --- | ---: |
${overviewRows.map(([label, value]) => `| ${label} | ${value} |`).join('\n')}

### Packages

| Package | status | Test cases | lines | branches | funcs | stmts |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
${packageRows.map((row) => `| ${row.join(' | ')} |`).join('\n')}

### Repository Test Suites

| Suite | status | Cases |
| --- | --- | ---: |
${repositorySuiteRows.map((row) => `| ${row.join(' | ')} |`).join('\n')}

#### Scope and combination coverage

${repositorySuiteDetails.join('\n')}

_Updated at ${generatedAt}._
`;
}

async function githubRequest(method, apiPath, body) {
  const token = process.env.GITHUB_TOKEN;
  const response = await fetch(`https://api.github.com${apiPath}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API ${method} ${apiPath} failed: ${response.status} ${text}`);
  }

  if (response.status === 204) return null;
  return response.json();
}

async function upsertPullRequestComment(body) {
  const repo = process.env.GITHUB_REPOSITORY;
  const prNumber = process.env.PR_NUMBER;
  const token = process.env.GITHUB_TOKEN;

  if (!repo || !prNumber || !token) {
    console.log(body);
    console.log(
      'Skipping GitHub comment because PR_NUMBER, GITHUB_REPOSITORY, or GITHUB_TOKEN is missing.'
    );
    return;
  }

  const comments = await githubRequest(
    'GET',
    `/repos/${repo}/issues/${prNumber}/comments?per_page=100`
  );
  const existing = comments.find((comment) => comment.body?.includes(MARKER));

  if (existing) {
    await githubRequest('PATCH', `/repos/${repo}/issues/comments/${existing.id}`, { body });
  } else {
    await githubRequest('POST', `/repos/${repo}/issues/${prNumber}/comments`, { body });
  }
}

async function main() {
  const stats = await collectPackageStats(process.cwd());
  const repositorySuites = await collectRepositorySuiteStats();
  const body = buildComment({ ...stats, repositorySuites });

  try {
    await upsertPullRequestComment(body);
  } catch (error) {
    console.warn(error instanceof Error ? error.message : String(error));
    console.warn('Coverage summary comment could not be published; continuing without failing CI.');
  }
}

await main();
