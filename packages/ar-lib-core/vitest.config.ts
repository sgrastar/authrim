import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['../../test/setup.ts'],
    // V8 coverage instrumentation makes the large SQLite restore fixtures several times slower on
    // two-core CI runners. Keep a bounded timeout while avoiding environment-speed-only failures.
    testTimeout: 30_000,
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    coverage: {
      provider: 'v8',
      all: true,
      reporter: ['text', 'json-summary', 'json', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: [
        'node_modules/',
        'test/',
        'dist/',
        'src/**/*.test.ts',
        'src/**/__tests__/**',
        '**/*.d.ts',
        '**/*.config.*',
        '**/mockData.ts',
      ],
    },
  },
  resolve: {
    alias: {
      'cloudflare:workers': path.resolve(__dirname, '../../test/mocks/cloudflare-workers.ts'),
    },
    conditions: ['node', 'import', 'module', 'default'],
  },
});
