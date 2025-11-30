import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/', 'test/', 'dist/', '**/*.d.ts', '**/*.config.*'],
    },
  },
  resolve: {
    alias: {
      '@authrim/shared': path.resolve(__dirname, '../shared/src'),
    },
  },
});
