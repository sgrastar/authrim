import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 15_000,
    coverage: {
      reporter: ['text', 'json-summary', 'json', 'html'],
      exclude: ['node_modules', 'dist', '**/*.test.ts'],
    },
  },
});
