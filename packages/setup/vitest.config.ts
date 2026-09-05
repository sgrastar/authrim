import { defineConfig } from 'vitest/config';
import path from 'node:path';

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
  resolve: {
    alias: [
      {
        find: '@authrim/ar-lib-core/control-plane',
        replacement: path.resolve(
          import.meta.dirname,
          '../ar-lib-core/src/services/control-plane/index.ts'
        ),
      },
      {
        find: '@authrim/ar-lib-core/services/custom-claims/schema-catalog',
        replacement: path.resolve(
          import.meta.dirname,
          '../ar-lib-core/src/services/custom-claims/schema-catalog.ts'
        ),
      },
    ],
  },
});
