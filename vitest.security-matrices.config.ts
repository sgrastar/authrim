import path from 'node:path';
import { defineConfig } from 'vitest/config';

const repoRoot = __dirname;
const jsonReportPath = process.env.AUTHRIM_TEST_REPORT?.trim();

export default defineConfig({
  root: repoRoot,
  test: {
    globals: true,
    environment: 'node',
    setupFiles: [
      path.join(repoRoot, 'test/setup.ts'),
      path.join(repoRoot, 'test/security-matrices/setup.ts'),
    ],
    include: ['test/security-matrices/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    passWithNoTests: false,
    pool: 'forks',
    isolate: true,
    fileParallelism: false,
    allowOnly: false,
    reporters: jsonReportPath ? ['default', 'json'] : ['default'],
    outputFile: jsonReportPath ? { json: jsonReportPath } : undefined,
    coverage: {
      enabled: false,
    },
  },
  resolve: {
    alias: {
      '@authrim/ar-lib-core': path.join(repoRoot, 'packages/ar-lib-core/src'),
      '@authrim/ar-lib-logging/contract': path.join(
        repoRoot,
        'packages/ar-lib-logging/src/contract/index.ts'
      ),
      '@authrim/ar-lib-logging/chunks': path.join(
        repoRoot,
        'packages/ar-lib-logging/src/chunks/index.ts'
      ),
      '@authrim/ar-lib-logging/delivery': path.join(
        repoRoot,
        'packages/ar-lib-logging/src/delivery/index.ts'
      ),
      '@authrim/ar-lib-logging/keys': path.join(
        repoRoot,
        'packages/ar-lib-logging/src/keys/index.ts'
      ),
      '@authrim/ar-lib-logging/policies': path.join(
        repoRoot,
        'packages/ar-lib-logging/src/policies/index.ts'
      ),
      'cloudflare:workers': path.join(repoRoot, 'test/mocks/cloudflare-workers.ts'),
    },
  },
});
