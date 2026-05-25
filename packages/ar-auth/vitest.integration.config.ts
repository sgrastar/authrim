import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

/**
 * Integration Test Configuration
 *
 * These tests require a running Authrim server on localhost:8787
 *
 * Usage:
 *   1. Start the dev server: pnpm --filter ar-router dev
 *   2. Run integration tests: pnpm --filter ar-auth test:integration
 *
 * Note: Integration tests are skipped by default in regular test runs.
 * They are covered by OpenID Foundation Conformance Suite tests.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Integration tests only
    include: ['src/__tests__/*-flow.test.ts', 'src/__tests__/integration/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // Longer timeout for integration tests
    testTimeout: 30000,
    hookTimeout: 30000,
    pool: 'forks',
    isolate: true,
    fileParallelism: false,
  },
  resolve: {
    alias: {
      'cloudflare:workers': resolve(__dirname, '../../test/mocks/cloudflare-workers.ts'),
    },
  },
});
