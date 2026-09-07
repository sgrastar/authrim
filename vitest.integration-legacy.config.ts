import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./test/setup.ts'],
    include: ['test/integration/**/*.test.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      // Requires a separately started multi-worker server.
      'test/integration/hybrid-flow-integration.test.ts',
    ],
    pool: 'forks',
    isolate: true,
    fileParallelism: false,
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
