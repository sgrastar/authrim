import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
  resolve: {
    alias: {
      // Mock cloudflare:workers for Node.js test environment
      'cloudflare:workers': resolve(__dirname, '../../test/mocks/cloudflare-workers.ts'),
    },
  },
});
