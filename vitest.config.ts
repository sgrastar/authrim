import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./test/setup.ts'],
    include: [
      // Unit tests in packages
      'packages/**/src/**/__tests__/**/*.test.ts',
      // Integration tests
      'test/integration/**/*.test.ts',
    ],
    exclude: [
      'node_modules/',
      'dist/',
      '**/node_modules/**',
      // E2E tests are run separately with Playwright
      'test-e2e/**',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'test/',
        'test-e2e/',
        'dist/',
        '**/*.d.ts',
        '**/*.config.*',
        '**/mockData.ts',
      ],
    },
  },
  resolve: {
    alias: {
      '@authrim/shared': path.resolve(__dirname, 'packages/shared/src'),
    },
  },
});
