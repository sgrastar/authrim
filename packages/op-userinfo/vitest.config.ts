import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: [resolve(__dirname, '../../test/setup.ts')],
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    pool: 'forks',
    poolOptions: {
      forks: {
        isolate: true,
      },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/', 'dist/', '**/*.d.ts', '**/*.config.*'],
    },
  },
  resolve: {
    alias: {
      // Mock cloudflare:workers for Node.js test environment
      'cloudflare:workers': resolve(__dirname, '../../test/mocks/cloudflare-workers.ts'),
    },
  },
});
