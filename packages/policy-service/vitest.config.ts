import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    globals: false,
    environment: 'node',
    pool: 'forks',
    poolOptions: {
      forks: {
        isolate: true,
      },
    },
  },
  resolve: {
    alias: {
      // Mock cloudflare:workers for Node.js test environment
      'cloudflare:workers': resolve(__dirname, '../../test/mocks/cloudflare-workers.ts'),
    },
  },
});
