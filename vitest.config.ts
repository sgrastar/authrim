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
      // High-volume security matrices use their dedicated deterministic runner.
      'test/security-matrices/**',
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
    alias: [
      {
        find: '@authrim/ar-lib-core/services/control-plane/migration-stream-contract',
        replacement: path.resolve(
          __dirname,
          'packages/ar-lib-core/src/services/control-plane/migration-stream-contract.ts'
        ),
      },
      {
        find: '@authrim/ar-lib-core/control-plane',
        replacement: path.resolve(
          __dirname,
          'packages/ar-lib-core/src/services/control-plane/index.ts'
        ),
      },
      {
        find: '@authrim/ar-lib-core/services/lookup-directory/contract',
        replacement: path.resolve(
          __dirname,
          'packages/ar-lib-core/src/services/lookup-directory/contract.ts'
        ),
      },
      {
        find: '@authrim/ar-lib-core/services/lookup-directory/seed-sql',
        replacement: path.resolve(
          __dirname,
          'packages/ar-lib-core/src/services/lookup-directory/seed-sql.ts'
        ),
      },
      {
        find: '@authrim/ar-lib-core',
        replacement: path.resolve(__dirname, 'packages/ar-lib-core/src'),
      },
    ],
  },
});
