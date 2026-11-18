// @ts-check
/**
 * Shared StrykerJS (mutation testing) configuration for workspace packages.
 *
 * Each package opts in with a tiny `stryker.config.mjs`:
 *
 *   import { createStrykerConfig } from '../../stryker.base.mjs';
 *   export default createStrykerConfig({ ...overrides });
 *
 * Run from the package directory with `pnpm test:mutation` (or for every opted-in
 * package from the repo root with `pnpm test:mutation`). Mutation testing is a manual,
 * pre-PR check: it is deliberately not part of `pnpm test` or CI because a full run takes
 * minutes. Narrow a run with `pnpm test:mutation --mutate src/path/to/file.ts` (pnpm 9 forwards
 * the flags as-is; do not add `--`).
 *
 * Sources are mutated IN PLACE (see `inPlace` below): do not edit the package while a run
 * is active. If a run is killed hard (not Ctrl+C), restore the files from the backup the run
 * announced (`.stryker-tmp/backup-*`), not with `git checkout`, which would also discard your
 * own uncommitted edits.
 *
 * Reports: `reports/mutation/index.html` (browse) and `reports/mutation/mutation.json`
 * (machine-readable). Both directories are git-ignored.
 *
 * @see https://stryker-mutator.io/docs/stryker-js/configuration/
 */

/**
 * @param {Partial<import('@stryker-mutator/api/core').PartialStrykerOptions>} overrides
 * @returns {import('@stryker-mutator/api/core').PartialStrykerOptions}
 */
export function createStrykerConfig(overrides = {}) {
  /** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
  const base = {
    testRunner: 'vitest',
    vitest: {
      configFile: 'vitest.config.ts',
    },
    // Production sources only: tests, fixtures, type declarations and the Worker entry are excluded.
    mutate: [
      'src/**/*.ts',
      '!src/**/*.test.ts',
      '!src/**/__tests__/**',
      '!src/**/__fixtures__/**',
      '!src/**/*.d.ts',
      '!src/index.ts',
    ],
    // Discard mutants that do not compile instead of running tests against them.
    checkers: ['typescript'],
    tsconfigFile: 'tsconfig.json',
    reporters: ['html', 'json', 'clear-text', 'progress'],
    htmlReporter: { fileName: 'reports/mutation/index.html' },
    jsonReporter: { fileName: 'reports/mutation/mutation.json' },
    clearTextReporter: { allowColor: true, logTests: false, reportTests: false },
    // Run only the tests that cover each mutant (recorded during the dry run).
    coverageAnalysis: 'perTest',
    // Skip "static" mutants (code executed at module load, e.g. constants and regexes): they
    // force a full test-suite run per mutant and were estimated at >60% of total run time
    // while being a few percent of the mutants. Re-enable per package when needed.
    ignoreStatic: true,
    // Re-runs only test mutants whose source or tests changed since the last run.
    incremental: true,
    incrementalFile: 'reports/mutation/incremental.json',
    thresholds: { high: 80, low: 60, break: null },
    // Mutate the package in place instead of copying it into a sandbox: tests in this monorepo
    // read sibling resources (../../migrations, ../../test/mocks) that a per-package sandbox
    // would not contain. Stryker restores the original sources when the run ends or is aborted.
    inPlace: true,
    tempDirName: '.stryker-tmp',
    cleanTempDir: true,
    timeoutMS: 15000,
    timeoutFactor: 2,
    dryRunTimeoutMinutes: 10,
  };

  return {
    ...base,
    ...overrides,
    vitest: { ...base.vitest, ...(overrides.vitest ?? {}) },
    thresholds: { ...base.thresholds, ...(overrides.thresholds ?? {}) },
  };
}
