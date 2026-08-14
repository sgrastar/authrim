import { defineConfig } from 'vitest/config';
import path from 'node:path';

const jsonReportPath = process.env.AUTHRIM_TEST_REPORT?.trim();

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./test/setup.ts'],
    include: [
      'test/integration/sid-logout-data-flow.security.test.ts',
      'test/integration/token-lifecycle-flow.test.ts',
      'test/integration/unified-control-plane-runtime-smoke.test.ts',
      'test/integration/tenant-system/discovery-route.test.ts',
      'test/integration/tenant-system/discovery-grant.test.ts',
      'test/integration/tenant-system/discovery-resolution.test.ts',
      'test/integration/tenant-system/negative-cases.test.ts',
      'test/integration/tenant-system/cookie-session.test.ts',
      'test/integration/tenant-system/oidc-tenant-binding.test.ts',
      'test/integration/tenant-system/oidc-cross-tenant-challenge.test.ts',
      'test/integration/tenant-system/settings-matrix.test.ts',
      'test/integration/tenant-system/user-flows.test.ts',
      'test/integration/tenant-system/vanity-domains.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**'],
    pool: 'forks',
    isolate: true,
    fileParallelism: false,
    reporters: jsonReportPath ? ['default', 'json'] : ['default'],
    outputFile: jsonReportPath ? { json: jsonReportPath } : undefined,
  },
  resolve: {
    alias: {
      '@authrim/ar-lib-core': path.resolve(__dirname, 'packages/ar-lib-core/src'),
      'cloudflare:workers': path.resolve(__dirname, 'test/mocks/cloudflare-workers.ts'),
      $lib: path.resolve(__dirname, 'packages/ar-login-ui/src/lib'),
      '$env/dynamic/public': path.resolve(__dirname, 'test/mocks/svelte-public-env.ts'),
    },
  },
});
