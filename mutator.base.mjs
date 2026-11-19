// @ts-check
/**
 * Shared mutator (@mizchi/mutator) configuration for workspace packages.
 *
 * Each package opts in with a tiny `mutator.config.mjs`:
 *
 *   import { createMutatorConfig } from '../../mutator.base.mjs';
 *   export default createMutatorConfig({ ...overrides });
 *
 * and two scripts: `test:mutation` (whole package) and `test:mutation:diff`
 * (`--since origin/develop --include-test-changes`: the mutants in the diff plus the code
 * covered by added or changed tests). From the repository root, `pnpm test:mutation:diff`
 * runs the diff mode in every opted-in package and `pnpm test:mutation:summary` merges the
 * per-package reports into one HTML page at `reports/mutation/index.html`.
 *
 * mutator instruments the sources in memory (no sandbox, no in-place rewrite) and caches
 * results per function in `.mutator/` (git-ignored), so a rerun only executes what changed.
 * Editing a package.json or the lockfile invalidates that cache. Requires Node.js 24+.
 *
 * @see https://github.com/mizchi/mutator
 */
import { defineConfig } from '@mizchi/mutator';

/**
 * Paths no package mutates: tests, fixtures and type declarations. `src/index.ts` is included on
 * purpose: in the API packages it wires middleware and routes, not only re-exports.
 */
const DEFAULT_EXCLUDE = [
  'src/**/__tests__/**',
  'src/**/__fixtures__/**',
  'src/**/__mocks__/**',
  'src/**/*.test.ts',
  'src/**/*.spec.ts',
  'src/**/*.d.ts',
];

/**
 * @param {import('@mizchi/mutator').MutatorConfig} overrides
 *   Package-specific options. `exclude` is added to the defaults, everything else replaces them.
 * @returns {import('@mizchi/mutator').MutatorConfig}
 */
export function createMutatorConfig(overrides = {}) {
  const { exclude = [], ...rest } = overrides;
  return defineConfig({
    exclude: [...DEFAULT_EXCLUDE, ...exclude],
    reporters: ['text', 'json', 'html'],
    thresholds: { high: 80, low: 60, break: null },
    ...rest,
  });
}
