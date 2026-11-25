import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['../../test/setup.ts'],
    include: ['src/**/__tests__/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json'],
      thresholds: { branches: 80 },
      exclude: ['node_modules/', 'dist/', '**/__tests__/**', '**/*.d.ts', '**/*.config.*'],
    },
  },
  resolve: {
    alias: {
      'cloudflare:workers': path.resolve(__dirname, '../../test/mocks/cloudflare-workers.ts'),
      // Contract tests run the OP's real verifiers (ar-lib-core) against the provider's output.
      '@op-verifiers': path.resolve(__dirname, '../ar-lib-core/src/vc'),
    },
  },
});
