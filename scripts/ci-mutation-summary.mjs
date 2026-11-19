#!/usr/bin/env node
// Merge the per-package mutator reports (packages/*/.mutator/report/mutation.json) into one
// mutation-testing-elements report at reports/mutation/{index.html,mutation.json}, and print a
// Markdown table of the scores (also appended to $GITHUB_STEP_SUMMARY when set).
//
// Usage: node scripts/ci-mutation-summary.mjs [--out <dir>]
//
// The merged report is a package-wide snapshot: every mutant that has a verdict in a package's
// last report counts, whether it was run this time or reused from the cache. Mutants without a
// verdict (Pending: outside `--since`, or beyond the time budget) and invalid ones (CompileError,
// RuntimeError, Ignored) are left out of the score, which follows the mutation-testing-elements
// definition: (Killed + Timeout) / (Killed + Timeout + Survived + NoCoverage).
//
// Per-mutant `coveredBy` lists are not merged (see prefixFiles): they are most of a large package's
// report and pushed the merged JSON past V8's string limit. `killedBy` stays, and the test files are
// narrowed to the tests it names, so the viewer's test list shows the tests that detected a mutant
// (not every test, which it would otherwise label as covering nothing). Mutant and test ids are
// prefixed with the package path so they stay unique across packages.
// A report that cannot be read or parsed is listed in the summary and left out of the merge.
//
// The HTML page loads the mutation-testing-elements web component from a copy placed next to it
// (taken from node_modules, so the page works offline). If the package is not installed it falls
// back to the unpkg copy mutator itself uses.

import {
  readFileSync,
  writeFileSync,
  copyFileSync,
  mkdirSync,
  existsSync,
  appendFileSync,
  statSync,
  globSync,
} from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MTE_VERSION = '3.9.0';
const MTE_FILE = 'mutation-test-elements.js';
/** The merged page always uses the shared thresholds; per-package rows use their own. */
const HTML_THRESHOLDS = { high: 80, low: 60 };
const DETECTED = new Set(['Killed', 'Timeout']);
const UNDETECTED = new Set(['Survived', 'NoCoverage']);

function parseArgs(argv) {
  let out = join(ROOT, 'reports', 'mutation');
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out = resolve(argv[++i]);
  }
  return { out };
}

/** Test ids are "<test file>#<full name>", relative to the package: prefix them like the paths. */
function prefixTestId(id, prefix) {
  return `${prefix}/${id}`;
}

function prefixFiles(files, prefix) {
  return Object.fromEntries(
    Object.entries(files ?? {}).map(([path, file]) => [
      `${prefix}/${path}`,
      {
        ...file,
        mutants: file.mutants.map((mutant) => {
          const { coveredBy, ...rest } = mutant;
          void coveredBy;
          return {
            ...rest,
            id: `${prefix}/${rest.id}`,
            ...(rest.killedBy
              ? { killedBy: rest.killedBy.map((id) => prefixTestId(id, prefix)) }
              : {}),
          };
        }),
      },
    ])
  );
}

/** Keeps only the tests some mutant's `killedBy` names; drops test files left empty. */
function killingTestFiles(testFiles, files) {
  const killing = new Set();
  for (const file of Object.values(files)) {
    for (const mutant of file.mutants) for (const id of mutant.killedBy ?? []) killing.add(id);
  }
  return Object.fromEntries(
    Object.entries(testFiles)
      .map(([path, testFile]) => [
        path,
        { ...testFile, tests: (testFile.tests ?? []).filter((test) => killing.has(test.id)) },
      ])
      .filter(([, testFile]) => testFile.tests.length > 0)
  );
}

function prefixTestFiles(testFiles, prefix) {
  return Object.fromEntries(
    Object.entries(testFiles ?? {}).map(([path, testFile]) => [
      `${prefix}/${path}`,
      {
        ...testFile,
        tests: (testFile.tests ?? []).map((test) => ({
          ...test,
          id: prefixTestId(test.id, prefix),
        })),
      },
    ])
  );
}

function countStatuses(files) {
  const counts = {};
  for (const file of Object.values(files)) {
    for (const mutant of file.mutants) counts[mutant.status] = (counts[mutant.status] ?? 0) + 1;
  }
  return counts;
}

function scoreOf(counts) {
  let detected = 0;
  let undetected = 0;
  for (const [status, n] of Object.entries(counts)) {
    if (DETECTED.has(status)) detected += n;
    else if (UNDETECTED.has(status)) undetected += n;
  }
  const total = detected + undetected;
  return { detected, undetected, score: total === 0 ? null : (detected / total) * 100 };
}

function label(score, thresholds) {
  if (score === null) return '-';
  if (score >= thresholds.high) return 'high';
  if (score >= thresholds.low) return 'low';
  return 'danger';
}

function formatScore(score) {
  return score === null ? 'n/a' : `${score.toFixed(1)}%`;
}

/** Copies the web component next to the page and returns the script tag for it. */
function elementsScriptTag(outDir) {
  try {
    const require = createRequire(import.meta.url);
    const bundle = require.resolve(`mutation-testing-elements/dist/${MTE_FILE}`);
    copyFileSync(bundle, join(outDir, MTE_FILE));
    return `<script src="./${MTE_FILE}"></script>`;
  } catch {
    return `<script src="https://www.unpkg.com/mutation-testing-elements@${MTE_VERSION}/dist/${MTE_FILE}"></script>`;
  }
}

function htmlPage(report, scriptTag) {
  // `<` cannot start a tag or a comment once escaped, whatever the mutated source contains.
  const data = JSON.stringify(report).replaceAll('<', '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authrim mutation report</title>
${scriptTag}
</head>
<body>
<mutation-test-report-app title-postfix="Authrim">
  Your browser doesn't support custom elements. Please use a modern browser.
</mutation-test-report-app>
<script>
  const app = document.querySelector('mutation-test-report-app');
  app.report = ${data};
  function updateTheme() { document.body.style.backgroundColor = app.themeBackgroundColor; }
  app.addEventListener('theme-changed', updateTheme);
  updateTheme();
</script>
</body>
</html>
`;
}

export function mergeReports(reportPaths) {
  const merged = {
    schemaVersion: '2',
    thresholds: HTML_THRESHOLDS,
    projectRoot: ROOT,
    files: {},
    testFiles: {},
  };
  const rows = [];
  const broken = [];
  for (const reportPath of reportPaths) {
    const pkgDir = resolve(reportPath, '..', '..', '..');
    const prefix = pkgDir.slice(ROOT.length + 1).replaceAll('\\', '/');
    let report;
    try {
      report = JSON.parse(readFileSync(reportPath, 'utf8'));
      if (!report || typeof report.files !== 'object') throw new Error('no `files` object');
    } catch (error) {
      broken.push({
        package: prefix,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    Object.assign(merged.files, prefixFiles(report.files, prefix));
    Object.assign(merged.testFiles, prefixTestFiles(report.testFiles, prefix));
    const counts = countStatuses(report.files ?? {});
    rows.push({
      package: prefix,
      counts,
      thresholds: { ...HTML_THRESHOLDS, ...(report.thresholds ?? {}) },
      reportedAt: statSync(reportPath).mtime,
      ...scoreOf(counts),
    });
  }
  merged.testFiles = killingTestFiles(merged.testFiles, merged.files);
  if (Object.keys(merged.testFiles).length === 0) delete merged.testFiles;
  const totalCounts = countStatuses(merged.files);
  const total = {
    package: 'all',
    counts: totalCounts,
    thresholds: HTML_THRESHOLDS,
    reportedAt: null,
    ...scoreOf(totalCounts),
  };
  return { merged, rows, total, broken };
}

export function markdownTable(rows, total) {
  const header =
    '| package | score | killed | timeout | survived | no coverage | pending | invalid | report |\n' +
    '|---|---:|---:|---:|---:|---:|---:|---:|---|';
  const invalid = (c) => (c.CompileError ?? 0) + (c.RuntimeError ?? 0) + (c.Ignored ?? 0);
  const line = (r) =>
    `| ${r.package} | ${formatScore(r.score)} [${label(r.score, r.thresholds)}] | ` +
    `${r.counts.Killed ?? 0} | ${r.counts.Timeout ?? 0} | ${r.counts.Survived ?? 0} | ` +
    `${r.counts.NoCoverage ?? 0} | ${r.counts.Pending ?? 0} | ${invalid(r.counts)} | ` +
    `${r.reportedAt ? r.reportedAt.toISOString().replace(/\.\d+Z$/, 'Z') : ''} |`;
  return [header, ...rows.map(line), line(total)].join('\n');
}

/** Packages that opted in (have a mutator config) but produced no report in this checkout. */
function packagesWithoutReport(reportPaths) {
  const reported = new Set(reportPaths.map((p) => basename(resolve(p, '..', '..', '..'))));
  return globSync('packages/*/mutator.config.{mjs,js,ts,json}', { cwd: ROOT })
    .map((p) => basename(dirname(p)))
    .filter((name) => !reported.has(name))
    .sort();
}

function main() {
  const { out } = parseArgs(process.argv.slice(2));
  const reportPaths = globSync('packages/*/.mutator/report/mutation.json', { cwd: ROOT })
    .map((p) => join(ROOT, p))
    .sort();
  const { merged, rows, total, broken } = mergeReports(reportPaths);
  const missing = packagesWithoutReport(reportPaths);
  let summary = '## Mutation testing (mutator)\n\n';
  if (rows.length > 0) {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'mutation.json'), JSON.stringify(merged));
    writeFileSync(join(out, 'index.html'), htmlPage(merged, elementsScriptTag(out)));
    summary +=
      `${markdownTable(rows, total)}\n\n` +
      `Package-wide snapshot of each package's last report (${rows.length} package(s)). ` +
      `Score = (killed + timeout) / (killed + timeout + survived + no coverage). ` +
      `Pending mutants were not run (outside \`--since\` or beyond the time budget); ` +
      `invalid = compile error + runtime error + ignored. Neither counts.\n`;
  } else {
    summary += 'No readable mutator report under packages/*/.mutator/report/. Nothing to merge.\n';
  }
  if (broken.length) {
    summary += `\nUnreadable reports (left out): ${broken
      .map((b) => `${b.package} (${b.reason})`)
      .join('; ')}.\n`;
  }
  if (missing.length) {
    summary += `\nOpted-in packages without a report in this checkout: ${missing.join(', ')}.\n`;
  }
  console.log(summary);
  if (rows.length > 0) console.log(`Merged ${rows.length} report(s) into ${out}/index.html`);
  if (process.env.GITHUB_STEP_SUMMARY && existsSync(dirname(process.env.GITHUB_STEP_SUMMARY))) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
