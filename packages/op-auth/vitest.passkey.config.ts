import { defineConfig } from 'vitest/config';

// Configuration specifically for passkey tests
// These tests require isolated module mocking to work correctly
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./test/setup.ts'],
    include: ['**/passkey.test.ts'],
    pool: 'forks',
    poolOptions: {
      forks: {
        isolate: true,
      },
    },
  },
});
